/**
 * dsh-fleet — host entry (formerly dsh-harness-workbench). Punica Studio.
 *
 * JSON API on the DSH web server:
 *
 *   [instance management — v1]
 *   GET  /dsh-fleet/api/state
 *   POST /dsh-fleet/api/scan | add-remote | remove-remote
 *        | stop-local | start-local | set-start-command
 *
 *   [cross-device conversation reading — v0.2]
 *   GET  /dsh-fleet/api/local-sessions | local-session-content
 *   POST /dsh-fleet/api/set-serve-token
 *   GET  /dsh-fleet/api/remote-sessions | remote-session-content   (proxy)
 *   GET  /dsh-fleet/api/sessions | session-content                (token-gated serve)
 *
 * Read endpoints that expose conversation content only answer same-origin
 * loopback requests, or — on the "serving" side of the protocol — require the
 * shared token configured under `serveToken` (empty means remote reads are
 * disabled). Conversation logs are sensitive: keep `serveToken` secret and
 * prefer https/Tailscale links between machines.
 *
 * Session logs live at <DSH_HOME>/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
 * (plaintext `.jsonl` also supported). Each file is a JSONL stream: a `session`
 * header row plus event rows (`user/message`, `assistant/message`, `tool/call`,
 * `tool/result`, `session/title`, …). Delta-chunk rows (`*-chunks`,
 * `assistant/chunk`) are intentionally skipped — `assistant/message` rows carry
 * complete text blocks, so transcripts never need delta reassembly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'dsh-fleet';

const VERSION = '0.4.0';
const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ------------------------------------------------------------------ */
/* configuration file                                                  */
/* ------------------------------------------------------------------ */

function homeDir() {
    const value = process.env.DSH_HOME;
    return value && value.trim() !== '' ? value : join(homedir(), '.dsh');
}

function configFile() {
    return join(homeDir(), 'dsh-fleet.json');
}

function defaultConfig() {
    return {
        range: { start: 3080, end: 3129 },
        remotes: [],            // { id, name, origin, token? }
        startCommands: {},      // port -> shell command template
        cwd: undefined,
        serveToken: '',         // shared token that lets OTHER machines read this machine's sessions ('' = off)
    };
}

let config = null;

/** One-time migration: earlier names kept settings in `dsh-orchard.json` / `dsh-harness-workbench.json`. */
function migrateLegacyConfig() {
    const current = configFile();
    if (existsSync(current)) return;
    for (const previous of ['dsh-orchard.json', 'dsh-harness-workbench.json']) {
        const legacy = join(homeDir(), previous);
        if (!existsSync(legacy)) continue;
        try {
            const raw = readFileSync(legacy, 'utf8');
            const tmp = `${current}.tmp`;
            writeFileSync(tmp, raw, 'utf8');
            renameSync(tmp, current);
            return;
        }
        catch (error) {
            console.error(`[dsh-fleet] config migration from ${previous} failed: ${String(error)}`);
        }
    }
}

function loadConfig() {
    if (config !== null) return config;
    migrateLegacyConfig();
    try {
        const parsed = JSON.parse(readFileSync(configFile(), 'utf8'));
        config = {
            ...defaultConfig(),
            ...(parsed ?? {}),
            range: { ...defaultConfig().range, ...(parsed?.range ?? {}) },
            remotes: Array.isArray(parsed?.remotes) ? parsed.remotes : [],
            startCommands: parsed?.startCommands && typeof parsed.startCommands === 'object' ? parsed.startCommands : {},
        };
    }
    catch {
        config = defaultConfig();
    }
    return config;
}

function saveConfig() {
    const file = configFile();
    try {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
        renameSync(tmp, file);
    }
    catch (error) {
        console.error(`[dsh-fleet] failed to write ${file}: ${String(error)}`);
    }
}

let chain = Promise.resolve();
function enqueue(task) {
    chain = chain.then(task, task);
    return chain;
}

/* ------------------------------------------------------------------ */
/* small HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined) return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}

function isLoopback(request) {
    const address = request.socket?.remoteAddress;
    if (!address) return true;
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function guardPost(request, response) {
    if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return false;
    }
    if (!sameOrigin(request) || !isLoopback(request)) {
        sendJson(response, 403, { error: 'untrusted origin: this action only runs from the local Harness web UI' });
        return false;
    }
    return true;
}

/** GETs are read-only; content endpoints still insist on loopback + same-origin. */
function guardGetLocal(request, response) {
    if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return false;
    }
    if (!isLoopback(request)) {
        sendJson(response, 403, { error: 'session content is only served to loopback clients' });
        return false;
    }
    return true;
}

function queryParam(request, name) {
    try {
        return new URL(request.url ?? '/', 'http://localhost').searchParams.get(name) ?? '';
    }
    catch {
        return '';
    }
}

function constantTimeEquals(left, right) {
    const a = createHash('sha256').update(String(left)).digest();
    const b = createHash('sha256').update(String(right)).digest();
    return timingSafeEqual(a, b);
}

async function readJsonBody(request, maxBytes = 16384) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new Error('request body too large');
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ------------------------------------------------------------------ */
/* probing (v1)                                                        */
/* ------------------------------------------------------------------ */

async function probe(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'user-agent': `dsh-fleet/${VERSION}` },
        });
        const text = await response.text();
        const revMatch = /"rev":"([0-9a-f]{12,})"/.exec(text);
        return {
            online: true, status: response.status, ms: Date.now() - started,
            dsh: text.includes('__DSH_BOOT__') || /DeepSeek Harness/.test(text),
            rev: revMatch ? revMatch[1] : undefined, error: undefined,
        };
    }
    catch {
        return { online: false, status: null, ms: Date.now() - started, dsh: false, rev: undefined, error: 'unreachable' };
    }
    finally {
        clearTimeout(timer);
    }
}

const originOf = (port) => `http://127.0.0.1:${port}/`;

async function pooled(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

let pidMapCache = { at: 0, ports: new Map() };
async function winPidByPort() {
    const now = Date.now();
    if (now - pidMapCache.at < 3000) return pidMapCache.ports;
    const ports = new Map();
    try {
        const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
        for (const line of stdout.split(/\r?\n/)) {
            const match = /^\s*TCP\s+\[?[0-9a-f.:]+\]?:(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)\s*$/i.exec(line.trim());
            if (match) ports.set(Number(match[1]), Number(match[2]));
        }
    }
    catch { /* netstat unavailable */ }
    pidMapCache = { at: now, ports };
    return ports;
}

async function localInstanceRows() {
    const cfg = loadConfig();
    const ports = [];
    for (let port = cfg.range.start; port <= cfg.range.end; port += 1) ports.push(port);
    const rows = await pooled(ports, 8, async (port) => {
        const result = await probe(originOf(port), 900);
        return { port, alive: result.online, dsh: result.dsh, status: result.status, ms: result.ms, rev: result.rev, self: false, pid: undefined, startCommand: cfg.startCommands[String(port)] ?? '' };
    });
    let pidByPort = new Map();
    if (isWin) pidByPort = await winPidByPort();
    let selfPort;
    for (const row of rows) {
        const pid = pidByPort.get(row.port);
        row.pid = pid;
        if (pid !== undefined && pid === process.pid) { row.self = true; selfPort = row.port; }
    }
    return { rows, selfPort };
}

async function remoteInstanceRows() {
    const cfg = loadConfig();
    return pooled(cfg.remotes, 4, async (remote) => {
        const result = await probe(`${remote.origin}/`, 2500);
        return { id: remote.id, name: remote.name, origin: remote.origin, hasToken: !!(remote.token && remote.token !== ''), online: result.online, dsh: result.dsh, ms: result.ms, rev: result.rev, error: result.error };
    });
}

function normalizeOrigin(input) {
    const value = String(input ?? '').trim();
    if (!/^https?:\/\//i.test(value)) throw new Error('origin must start with http:// or https://');
    const url = new URL(value);
    if (!url.hostname) throw new Error('origin needs a host');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) origins are supported');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* session-log reading (this machine)                                  */
/* ------------------------------------------------------------------ */

function sessionsRoot() {
    return join(homeDir(), 'sessions');
}

/** Enumerate session artifact files: <root>/<workspace>/session-<uuid>/session.jsonl[.zstd] */
function enumerateSessionFiles() {
    const root = sessionsRoot();
    if (!existsSync(root)) return [];
    const found = [];
    for (const workspaceEntry of readdirSync(root, { withFileTypes: true })) {
        if (!workspaceEntry.isDirectory()) continue;
        const workspaceDir = join(root, workspaceEntry.name);
        let entries;
        try { entries = readdirSync(workspaceDir, { withFileTypes: true }); }
        catch { continue; }
        for (const sessionEntry of entries) {
            if (!sessionEntry.isDirectory()) continue;
            const dir = join(workspaceDir, sessionEntry.name);
            const zstd = join(dir, 'session.jsonl.zstd');
            const plain = join(dir, 'session.jsonl');
            const ext = existsSync(zstd) ? '.zstd' : existsSync(plain) ? '' : null;
            if (ext === null) continue;
            found.push({ id: sessionEntry.name, dir, file: ext === '.zstd' ? zstd : plain, ext });
        }
    }
    return found;
}

/** Split a buffer on zstd frame magic offsets. */
function frameStarts(buffer) {
    const starts = [];
    for (let i = 0; i + 4 <= buffer.length; i += 1) {
        if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
    }
    return starts;
}

function decompressLogFile(buffer, ext) {
    if (ext !== '.zstd') return buffer.toString('utf8');
    const starts = frameStarts(buffer);
    if (starts.length === 0) {
        try { return zstdDecompressSync(buffer).toString('utf8'); }
        catch { return ''; }
    }
    const chunks = [];
    for (let index = 0; index < starts.length; index += 1) {
        const from = starts[index];
        const to = index + 1 < starts.length ? starts[index + 1] : buffer.length;
        try { chunks.push(zstdDecompressSync(buffer.subarray(from, to))); }
        catch { /* a torn/last frame can fail if the file is mid-write */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

function parseLog(text) {
    const rows = [];
    let header;
    for (const line of text.split(/\r?\n/)) {
        if (line === '') continue;
        let record;
        try { record = JSON.parse(line); }
        catch { continue; }
        if (record && record.type === 'session') {
            if (header === undefined) header = record;
            continue;
        }
        if (record && typeof record === 'object') rows.push(record);
    }
    return { header, rows };
}

function readSessionFile(session) {
    const text = decompressLogFile(readFileSync(session.file), session.ext);
    return parseLog(text);
}

function headerSummary(header, session) {
    const createdAt = header?.createdAt;
    const stat = statSync(session.file);
    return {
        id: session.id,
        createdAt: typeof createdAt === 'number' || typeof createdAt === 'string' ? Number(createdAt) : null,
        cwd: header?.cwd ?? undefined,
        agentPreset: header?.agentPreset ?? undefined,
        fileModifiedMs: stat.mtimeMs,
        bytes: stat.size,
    };
}

function contentBlocksText(content, wanted) {
    if (!Array.isArray(content)) return '';
    return content
        .filter((block) => block && block.type === wanted && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

/** Rebuild a lean transcript from decoded rows. Returns plain owned JSON only. */
function buildTranscript(rows) {
    const items = [];
    const toolNames = new Map();       // callId -> name
    const toolResults = new Map();     // callId -> preview
    let title;
    let userMessages = 0;
    let assistantMessages = 0;

    for (const row of rows) {
        const type = row.type;
        const time = row.time !== undefined ? Number(row.time) : null;
        const seq = row.seq !== undefined ? Number(row.seq) : null;
        const data = row.data ?? {};

        if (type === 'session/title' && data?.title) title = data.title;

        else if (type === 'user/message') {
            const text = contentBlocksText(data?.content, 'text');
            if (text !== '') {
                userMessages += 1;
                items.push({ kind: 'user', seq, time, text: text.slice(0, 40000) });
            }
        }
        else if (type === 'assistant/message') {
            const message = data?.message ?? {};
            const content = message?.content;
            const text = contentBlocksText(content, 'text');
            const reasoning = contentBlocksText(content, 'reasoning');
            assistantMessages += 1;
            items.push({
                kind: 'assistant',
                seq, time,
                text: text.slice(0, 200000),
                reasoning: reasoning.slice(0, 12000),
                model: message?.model ?? undefined,
            });
        }
        else if (type === 'tool/call') {
            const callId = data?.callId;
            const nameText = String(data?.name ?? '').slice(0, 120);
            if (callId) toolNames.set(callId, nameText);
            const args = typeof data?.arguments === 'string' ? data.arguments : '';
            items.push({ kind: 'tool', seq, time, callId, name: nameText, args: args.slice(0, 4000) });
        }
        else if (type === 'tool/result') {
            const message = data?.message ?? {};
            const content = message?.content;
            let preview = '';
            if (Array.isArray(content)) {
                preview = content.map((block) => {
                    if (!block) return '';
                    if (typeof block.text === 'string') return block.text;
                    if (Array.isArray(block.content)) return block.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
                    return '';
                }).join('\n');
            }
            const callId = message?.source?.callId ?? data?.callId;
            if (callId) toolResults.set(callId, preview);
            items.push({ kind: 'tool-result', seq, time, callId, name: callId ? (toolNames.get(callId) ?? '') : '', preview: preview.slice(0, 16000) });
        }
    }

    // cap extremely long transcripts (defensive): keep first 400 + last 1200
    let truncated = false;
    let kept = items;
    if (items.length > 1600) {
        truncated = true;
        kept = [...items.slice(0, 400), ...items.slice(-1200)];
    }
    return {
        title: title ?? null,
        messageCounts: { user: userMessages, assistant: assistantMessages },
        truncated,
        items: kept,
    };
}

function findSession(id) {
    if (!SESSION_ID_RE.test(id)) return undefined;
    return enumerateSessionFiles().find((entry) => entry.id === id);
}

/* ------------------------------------------------------------------ */
/* actions (v1)                                                        */
/* ------------------------------------------------------------------ */

async function stopLocal(port) {
    const number = Number(port);
    if (!Number.isInteger(number)) throw new Error('invalid port');
    if (!isWin) throw new Error('stop currently supports Windows (PID lookup via netstat)');
    const pidByPort = await winPidByPort();
    const pid = pidByPort.get(number);
    if (pid === undefined) throw new Error(`no listener found on port ${number}`);
    if (pid === process.pid) throw new Error('refusing to stop the current Harness instance');
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
    return { port: number, pid };
}

async function startLocal(port, configOverrides) {
    const number = Number(port);
    if (!Number.isInteger(number)) throw new Error('invalid port');
    const cfg = loadConfig();
    const template = (configOverrides?.startCommand ?? cfg.startCommands[String(number)] ?? '').trim();
    if (template === '') throw new Error(`no start command configured for port ${number} — set one first`);
    const child = spawn(template.replaceAll('${port}', String(number)), { cwd: cfg.cwd, detached: true, stdio: 'ignore', shell: true });
    child.unref();
    return { port: number, pid: child.pid ?? undefined };
}

function addRemote(name, origin, token) {
    const cfg = loadConfig();
    const cleanOrigin = normalizeOrigin(origin);
    const cleanName = String(name ?? '').trim().slice(0, 60);
    const displayName = cleanName === '' ? cleanOrigin : cleanName;
    if (cfg.remotes.some((entry) => entry.origin.toLowerCase() === cleanOrigin.toLowerCase())) throw new Error('this origin is already registered');
    if (cfg.remotes.length >= 100) throw new Error('too many remotes (max 100)');
    const id = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    cfg.remotes.push({ id, name: displayName, origin: cleanOrigin, token: token && token !== '' ? String(token).slice(0, 200) : undefined });
    saveConfig();
    return id;
}

function removeRemote(id) {
    const cfg = loadConfig();
    const before = cfg.remotes.length;
    cfg.remotes = cfg.remotes.filter((entry) => entry.id !== id);
    if (cfg.remotes.length === before) throw new Error('remote not found');
    saveConfig();
}

function setStartCommand(port, command) {
    const cfg = loadConfig();
    cfg.startCommands[String(port)] = String(command ?? '').trim();
    saveConfig();
}

function setServeToken(token) {
    const cfg = loadConfig();
    cfg.serveToken = token && token !== '' ? String(token).slice(0, 200) : '';
    saveConfig();
}

/* ------------------------------------------------------------------ */
/* remote proxying (v0.2)                                              */
/* ------------------------------------------------------------------ */

function findRemote(id) {
    return loadConfig().remotes.find((entry) => entry.id === id);
}

/** Ask a remote instance (same plugin) for its session index. */
async function remoteFetch(remote, path, params) {
    const url = new URL(`${remote.origin}/dsh-fleet/api/${path}`);
    if (!remote.token) throw new Error('no session token configured for this remote — add one to read its conversations');
    url.searchParams.set('token', remote.token);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== '') url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url.href, { signal: controller.signal, headers: { 'user-agent': `dsh-fleet/${VERSION}` } });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload) throw new Error(payload?.error ?? `remote HTTP ${response.status}`);
        return payload;
    }
    finally {
        clearTimeout(timer);
    }
}

/* ------------------------------------------------------------------ */
/* serving side (v0.2): token-gated read endpoints                     */
/* ------------------------------------------------------------------ */

function tokenAuthorized(request) {
    const cfg = loadConfig();
    if (!cfg.serveToken || cfg.serveToken === '') return { ok: false, code: 403, error: 'session serving is disabled on this machine (no serveToken configured)' };
    const provided = queryParam(request, 'token');
    if (!provided) return { ok: false, code: 403, error: 'missing session token' };
    return constantTimeEquals(provided, cfg.serveToken)
        ? { ok: true }
        : { ok: false, code: 403, error: 'invalid session token' };
}

async function statePayload() {
    const cfg = loadConfig();
    const { rows, selfPort } = await localInstanceRows();
    const remote = await remoteInstanceRows();
    return {
        ok: true, version: VERSION, selfPid: process.pid, selfPort,
        range: { ...cfg.range },
        local: rows, remote,
        serveSessions: !!(cfg.serveToken && cfg.serveToken !== ''),
        configFile: configFile(),
        platform: process.platform,
    };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
    if (!existsSync(homeDir())) mkdirSync(homeDir(), { recursive: true });
    loadConfig();
    // Wait for the web server service exactly like other web plugins do: on a
    // fresh boot `webServer` may not be provided yet when this row activates,
    // so a synchronous `ctx.get` at apply time would silently leave the plugin
    // inert. ctx.inject re-runs the mount as soon as the service appears.
    ctx.inject(['webServer'], (hostCtx) => {
        const dispose = registerAll(hostCtx.webServer);
        hostCtx.effect(() => dispose);
    });
}

/** Register every API route against one webServer; returns the combined disposer. */
function registerAll(webServer) {
    const disposers = [];

    /* ---- v1 routes ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/state',
        handler: async (request, response) => {
            if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
            try { sendJson(response, 200, await statePayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/scan',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try { sendJson(response, 200, await statePayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/add-remote',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                const id = addRemote(body?.name, body?.origin, body?.token);
                sendJson(response, 200, { ok: true, id, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remove-remote',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                removeRemote(body?.id);
                sendJson(response, 200, { ok: true, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/stop-local',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                const result = await stopLocal(body?.port);
                sendJson(response, 200, { ok: true, ...result, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/start-local',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                const result = await startLocal(body?.port, body);
                sendJson(response, 200, { ok: true, ...result, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/set-start-command',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                setStartCommand(body?.port, body?.command);
                sendJson(response, 200, { ok: true, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    /* ---- this-machine session reading (loopback only) ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/local-sessions',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const includeTitles = queryParam(request, 'includeTitles') === '1';
                const sessions = enumerateSessionFiles();
                const index = sessions.map((session) => {
                    const parsed = readSessionFile(session);
                    return { ...headerSummary(parsed.header, session), title: includeTitles ? (parsed.rows.reduce((last, row) => (row?.type === 'session/title' && row?.data?.title ? row.data.title : last), null)) : undefined };
                });
                index.sort((a, b) => (b.fileModifiedMs ?? 0) - (a.fileModifiedMs ?? 0));
                sendJson(response, 200, { ok: true, count: index.length, sessions: index });
            }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/local-session-content',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const id = queryParam(request, 'id');
                const session = findSession(id);
                if (!session) { sendJson(response, 404, { error: 'session not found' }); return; }
                const parsed = readSessionFile(session);
                const summary = headerSummary(parsed.header, session);
                const transcript = buildTranscript(parsed.rows);
                sendJson(response, 200, { ok: true, summary, ...transcript });
            }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/set-serve-token',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                setServeToken(body?.token);
                sendJson(response, 200, { ok: true, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    /* ---- token-gated serving for OTHER machines ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/sessions',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try {
                const includeTitles = queryParam(request, 'includeTitles') === '1';
                const sessions = enumerateSessionFiles();
                const index = sessions.map((session) => {
                    const parsed = readSessionFile(session);
                    return { ...headerSummary(parsed.header, session), title: includeTitles ? (parsed.rows.reduce((last, row) => (row?.type === 'session/title' && row?.data?.title ? row.data.title : last), null)) : undefined };
                });
                index.sort((a, b) => (b.fileModifiedMs ?? 0) - (a.fileModifiedMs ?? 0));
                sendJson(response, 200, { ok: true, count: index.length, sessions: index });
            }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/session-content',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try {
                const id = queryParam(request, 'id');
                const session = findSession(id);
                if (!session) { sendJson(response, 404, { error: 'session not found' }); return; }
                const parsed = readSessionFile(session);
                const summary = headerSummary(parsed.header, session);
                const transcript = buildTranscript(parsed.rows);
                sendJson(response, 200, { ok: true, summary, ...transcript });
            }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    /* ---- proxying to registered remotes (loopback + same-origin) ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remote-sessions',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const remote = findRemote(queryParam(request, 'remote'));
                if (!remote) { sendJson(response, 404, { error: 'remote not found' }); return; }
                const includeTitles = queryParam(request, 'includeTitles');
                const payload = await remoteFetch(remote, 'sessions', { includeTitles });
                sendJson(response, 200, payload);
            }
            catch (error) { sendJson(response, 502, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remote-session-content',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const remote = findRemote(queryParam(request, 'remote'));
                if (!remote) { sendJson(response, 404, { error: 'remote not found' }); return; }
                const id = queryParam(request, 'session');
                const payload = await remoteFetch(remote, 'session-content', { id });
                sendJson(response, 200, payload);
            }
            catch (error) { sendJson(response, 502, { error: String(error) }); }
        },
    }));

    return () => {
        for (const dispose of disposers) dispose();
    };
}
