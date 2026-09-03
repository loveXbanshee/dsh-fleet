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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'dsh-fleet';

const VERSION = '0.13.10';
const GATEWAY_DEFAULT_PORT = 33180;
const UPDATE_REPO = 'loveXbanshee/dsh-fleet';
const UPDATE_BRANCH = 'main';
// Authoritative-first, CDN fallbacks. Override entirely via DSL_FLEET_UPDATE_URL
// (semicolon list of base URLs treated like raw text roots ending with '/').
const CUSTOM_UPDATE_ROOTS = (process.env.DSL_FLEET_UPDATE_URL || '').split(';').filter(Boolean);
const UPDATE_SOURCES = CUSTOM_UPDATE_ROOTS.length > 0
    ? CUSTOM_UPDATE_ROOTS.map((root) => ({ name: 'custom', kind: 'raw', root: root.replace(/\/+$/, '') + '/' }))
    : [
        { name: 'api', kind: 'api', root: `https://api.github.com/repos/${UPDATE_REPO}/contents/` },
        { name: 'raw', kind: 'raw', root: `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/` },
        { name: 'jsdelivr', kind: 'raw', root: `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_BRANCH}/` },
    ];
const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const THIS_LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
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
        gateway: { enabled: false, host: '0.0.0.0', port: GATEWAY_DEFAULT_PORT },
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
            gateway: { ...defaultConfig().gateway, ...((parsed?.gateway && typeof parsed.gateway === 'object') ? parsed.gateway : {}) },
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

/**
 * Minimal GET that can opt out of TLS verification (per-remote self-signed
 * https endpoints). Returns { status, headers, text } or throws.
 */
function rawGet(urlString, { timeoutMs = 8000, insecure = false } = {}) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(urlString); }
        catch (error) { reject(error); return; }
        const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = transport(url, {
            method: 'GET',
            rejectUnauthorized: !insecure,
            headers: {
                'user-agent': `dsh-fleet/${VERSION}`,
                accept: '*/*',
                connection: 'close',
            },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                text: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        request.on('timeout', () => {
            const error = new Error(`request timed out after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            request.destroy(error);
        });
        request.on('error', reject);
        request.setTimeout(timeoutMs);
        request.end();
    });
}

async function probe(url, timeoutMs, insecure) {
    const started = Date.now();
    try {
        const response = await rawGet(url, { timeoutMs, insecure: insecure === true });
        const text = response.text || '';
        const revMatch = /"rev":"([0-9a-f]{12,})"/.exec(text);
        const gateway = text.includes('dsh-fleet-gateway');
        return {
            online: true, status: response.status, ms: Date.now() - started,
            dsh: gateway || text.includes('__DSH_BOOT__') || /DeepSeek Harness/.test(text),
            gateway,
            rev: revMatch ? revMatch[1] : undefined, error: undefined,
        };
    }
    catch (error) {
        let reason = 'unreachable';
        if (error && error.name === 'AbortError') reason = 'timeout';
        else if (error && error.code) reason = String(error.code);
        else if (error && error.cause && error.cause.code) reason = String(error.cause.code);
        else if (error && error.message) reason = String(error.message);
        return { online: false, status: null, ms: Date.now() - started, dsh: false, gateway: false, rev: undefined, error: reason };
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
        const result = await probe(`${remote.origin}/`, 4000, remote.insecure === true);
        return { id: remote.id, name: remote.name, origin: remote.origin, hasToken: !!(remote.token && remote.token !== ''), insecure: remote.insecure === true, online: result.online, dsh: result.dsh, gateway: result.gateway, ms: result.ms, rev: result.rev, error: result.error };
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

function addRemote(name, origin, token, insecure) {
    const cfg = loadConfig();
    const cleanOrigin = normalizeOrigin(origin);
    const cleanName = String(name ?? '').trim().slice(0, 60);
    const displayName = cleanName === '' ? cleanOrigin : cleanName;
    if (cfg.remotes.some((entry) => entry.origin.toLowerCase() === cleanOrigin.toLowerCase())) throw new Error('this origin is already registered');
    if (cfg.remotes.length >= 100) throw new Error('too many remotes (max 100)');
    const id = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    cfg.remotes.push({ id, name: displayName, origin: cleanOrigin, token: token && token !== '' ? String(token).slice(0, 200) : undefined, insecure: insecure === true });
    saveConfig();
    return id;
}

function setRemoteInsecure(id, insecure) {
    const cfg = loadConfig();
    const remote = cfg.remotes.find((entry) => entry.id === id);
    if (!remote) throw new Error('remote not found');
    remote.insecure = insecure === true;
    saveConfig();
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
    const response = await rawGet(url.href, { timeoutMs: 15000, insecure: remote.insecure === true });
    let payload;
    try { payload = JSON.parse(response.text); }
    catch { payload = null; }
    if (response.status < 200 || response.status >= 300 || !payload) throw new Error(payload?.error ?? `remote HTTP ${response.status}`);
    return payload;
}

/* ------------------------------------------------------------------ */
/* serving side (v0.2): token-gated read endpoints                     */
/* ------------------------------------------------------------------ */

function tokenOk(provided) {
    const cfg = loadConfig();
    if (!cfg.serveToken || cfg.serveToken === '') return { ok: false, code: 403, error: 'session serving is disabled on this machine (no serveToken configured)' };
    if (!provided) return { ok: false, code: 403, error: 'missing session token' };
    return constantTimeEquals(provided, cfg.serveToken)
        ? { ok: true }
        : { ok: false, code: 403, error: 'invalid session token' };
}

function tokenAuthorized(request) {
    return tokenOk(queryParam(request, 'token'));
}

function deriveSessionTitle(parsed) {
    return (parsed.rows || []).reduce((last, row) => (row?.type === 'session/title' && row?.data?.title ? row.data.title : last), null);
}

/* ------------------------------------------------------------------ */
/* live activity: authoritative busy via agent/status events            */
/* ------------------------------------------------------------------ */

const agentStatus = new Map();       // agent object -> status string
let liveCounts = { running: 0, lastBusyAt: 0, lastIdleAt: 0, updatedAt: 0 };

// Registry-based reconciliation: if this plugin's host half (re)starts while an
// agent is already mid-turn (e.g. deep-diving across a self-update relaunch),
// the agent/status stream has no fresh event until the agent transitions, which
// would make /live report idle for the whole remainder of the dive. We therefore
// snapshot the live agent registry on every payload so busy is always current.
let reconcileAgentsRef = null; // set in apply(ctx); reads ctx.agents.list()

function recomputeLive() {
    let running = 0;
    for (const status of agentStatus.values()) {
        if (status === 'running') running += 1;
    }
    const busy = running > 0;
    const now = Date.now();
    if (busy) liveCounts.lastBusyAt = now;
    else if (liveCounts.lastBusyAt > 0) liveCounts.lastIdleAt = now;
    liveCounts.running = running;
    liveCounts.updatedAt = now;
    return busy;
}

function reconcileAgents() {
    if (typeof reconcileAgentsRef !== 'function') return;
    try {
        const runningNow = reconcileAgentsRef();
        if (runningNow === null || runningNow === undefined) return; // registry not available yet
        const prevBusy = liveCounts.running > 0;
        if (runningNow !== prevBusy) {
            liveCounts.running = runningNow;
            liveCounts.updatedAt = Date.now();
            if (runningNow > 0) liveCounts.lastBusyAt = Date.now();
            else if (liveCounts.lastBusyAt > 0) liveCounts.lastIdleAt = Date.now();
        }
        else if (runningNow > 0) {
            liveCounts.updatedAt = Date.now();
        }
    }
    catch { /* registry query is best-effort */ }
}

function handleAgentStatus(payload) {
    const agent = payload?.agent;
    if (agent === undefined) return;
    agentStatus.set(agent, payload?.status === 'running' ? 'running' : 'idle');
    recomputeLive();
}

function handleAgentDisposed(payload) {
    const agent = payload?.agent;
    if (agent !== undefined) agentStatus.delete(agent);
    recomputeLive();
}

function livePayload() {
    reconcileAgents();
    return {
        ok: true,
        busy: liveCounts.running > 0,
        runningAgents: liveCounts.running,
        lastBusyAt: liveCounts.lastBusyAt,
        lastIdleAt: liveCounts.lastIdleAt,
        updatedAt: liveCounts.updatedAt,
    };
}

/** Cheap freshness: enumerate session files and stat mtimes only (no decode). */
function freshnessPayload() {
    let newestLocal = 0;
    const sessions = enumerateSessionFiles().map((session) => {
        let mtime = 0;
        try { mtime = statSync(session.file).mtimeMs; } catch { /* gone */ }
        if (mtime > newestLocal) newestLocal = mtime;
        return { id: session.id, fileModifiedMs: mtime };
    });
    return { ok: true, newestLocal, sessions };
}

function sessionsIndexPayload(includeTitles) {
    const sessions = enumerateSessionFiles();
    const index = sessions.map((session) => {
        const parsed = readSessionFile(session);
        return { ...headerSummary(parsed.header, session), title: includeTitles ? deriveSessionTitle(parsed) : undefined };
    });
    index.sort((a, b) => (b.fileModifiedMs ?? 0) - (a.fileModifiedMs ?? 0));
    return { ok: true, count: index.length, sessions: index };
}

function sessionContentPayload(id) {
    const session = findSession(id);
    if (!session) return { ok: false, code: 404, error: 'session not found' };
    const parsed = readSessionFile(session);
    return { ok: true, summary: headerSummary(parsed.header, session), ...buildTranscript(parsed.rows) };
}

/* ------------------------------------------------------------------ */
/* Fleet Gateway: a self-hosted read-only LAN listener                 */
/* ------------------------------------------------------------------ */

const gatewayState = { server: null, listening: false, error: null, restartTimer: null };

function stopGateway() {
    const server = gatewayState.server;
    gatewayState.server = null;
    gatewayState.listening = false;
    if (gatewayState.restartTimer) {
        clearTimeout(gatewayState.restartTimer);
        gatewayState.restartTimer = null;
    }
    if (server) {
        try { server.close(); } catch { /* already closed */ }
    }
}

function gatewayStatus() {
    const cfg = loadConfig();
    const g = cfg.gateway ?? defaultConfig().gateway;
    const enabled = Boolean(g?.enabled && cfg.serveToken);
    return {
        enabled,
        configured: Boolean(g?.enabled),
        host: g?.host ?? '0.0.0.0',
        port: Number(g?.port) || GATEWAY_DEFAULT_PORT,
        listening: enabled && gatewayState.listening,
        error: gatewayState.error,
    };
}

function handleGatewayRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
        sendJson(response, 200, { ok: true, service: 'dsh-fleet-gateway', version: VERSION, pid: process.pid, time: Date.now() });
        return;
    }
    if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
    }
    const auth = tokenOk(url.searchParams.get('token') ?? '');
    if (!auth.ok) {
        sendJson(response, auth.code, { error: auth.error });
        return;
    }
    if (path === '/dsh-fleet/api/sessions') {
        sendJson(response, 200, sessionsIndexPayload(url.searchParams.get('includeTitles') === '1'));
        return;
    }
    if (path === '/dsh-fleet/api/session-content') {
        const payload = sessionContentPayload(url.searchParams.get('id') ?? '');
        sendJson(response, payload.ok ? 200 : 404, payload);
        return;
    }
    sendJson(response, 404, { error: 'not found' });
}

function startGateway() {
    stopGateway();
    const cfg = loadConfig();
    const g = cfg.gateway ?? {};
    if (!g?.enabled) {
        gatewayState.error = null;
        return;
    }
    if (!cfg.serveToken) {
        gatewayState.error = 'serveToken is not set — set one before enabling the gateway';
        return;
    }
    const host = typeof g.host === 'string' && g.host.trim() !== '' ? g.host.trim() : '0.0.0.0';
    const port = Number(g.port) || GATEWAY_DEFAULT_PORT;
    const server = createServer(handleGatewayRequest);
    server.on('error', (error) => {
        const code = error?.code;
        gatewayState.listening = false;
        gatewayState.error = code ? `${code}: ${String(error?.message ?? error)}` : String(error?.message ?? error);
        if (code === 'EADDRINUSE' && gatewayState.server === server) {
            gatewayState.restartTimer = setTimeout(() => {
                gatewayState.restartTimer = null;
                if (gatewayState.server === server) startGateway();
            }, 1500);
        }
    });
    server.on('listening', () => {
        if (gatewayState.server === server) {
            gatewayState.listening = true;
            gatewayState.error = null;
        }
    });
    gatewayState.server = server;
    try {
        server.listen(port, host);
    }
    catch (error) {
        gatewayState.server = null;
        gatewayState.error = String(error?.message ?? error);
    }
}

function setGatewaySettings(enabled, port, host) {
    const cfg = loadConfig();
    const g = cfg.gateway ?? {};
    cfg.gateway = {
        enabled: enabled === undefined ? Boolean(g?.enabled) : Boolean(enabled),
        port: port !== undefined && port !== '' && port !== null ? Number(port) : Number(g?.port) || GATEWAY_DEFAULT_PORT,
        host: host !== undefined && host !== '' && host !== null ? String(host).trim() : (g?.host ?? '0.0.0.0'),
    };
    const chosenPort = Number(cfg.gateway.port);
    if (!Number.isInteger(chosenPort) || chosenPort <= 0 || chosenPort > 65535) throw new Error('invalid gateway port');
    saveConfig();
    startGateway();
}

/* ------------------------------------------------------------------ */
/* self-update (test-stage): check GitHub, pull via pnpm, restart       */
/* ------------------------------------------------------------------ */

function parseNumericVersion(value) {
    const parts = String(value ?? '').replace(/^v/i, '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
}
function versionAtLeast(installed, remote) {
    const a = parseNumericVersion(installed);
    const b = parseNumericVersion(remote);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] > b[index]) return true;
        if (a[index] < b[index]) return false;
    }
    return true; // equal counts as satisfied
}

/** Relative package files to fetch when self-updating over REST. */
const UPDATE_FILE_PATHS = ['package.json', 'README.md', 'LICENSE', '.gitignore', 'cordis.patch.yml', 'client/client.js', 'lib/index.js'];

function sourceManifestUrl(source) {
    return source.kind === 'api'
        ? `${source.root}package.json?ref=${UPDATE_BRANCH}`
        : `${source.root}package.json`;
}

function sourceFileUrl(source, relPath) {
    if (source.kind === 'api') {
        const encoded = relPath.split('/').map((part) => encodeURIComponent(part)).join('/');
        return `${source.root}${encoded}?ref=${UPDATE_BRANCH}`;
    }
    return `${source.root}${relPath}`;
}

async function httpText(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': `dsh-fleet/${VERSION}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}

function decodeSourcePayload(source, text) {
    if (source.kind !== 'api') return text;
    const json = JSON.parse(text);
    if (!json || typeof json.content !== 'string') throw new Error('api response has no content');
    return Buffer.from(json.content, 'base64').toString('utf8');
}

async function firstWorkingSource() {
    let lastError;
    for (const source of UPDATE_SOURCES) {
        try {
            const manifest = JSON.parse(decodeSourcePayload(source, await httpText(sourceManifestUrl(source))));
            const remoteVersion = typeof manifest?.version === 'string' ? manifest.version : undefined;
            if (!remoteVersion) throw new Error('no version in manifest');
            return { source, version: remoteVersion };
        }
        catch (error) {
            lastError = error;
        }
    }
    const err = new Error(`cannot reach any update source (api.github.com / raw / jsDelivr): ${String(lastError?.message ?? lastError ?? 'network')}`);
    err.code = 'UPDATE_NETWORK';
    throw err;
}

let updateCheckCache = { at: 0, payload: null };

async function checkForUpdates(force) {
    const now = Date.now();
    if (!force && updateCheckCache.payload && now - updateCheckCache.at < 60000) return updateCheckCache.payload;
    let result;
    try {
        const found = await firstWorkingSource();
        result = {
            ok: true,
            current: VERSION,
            latest: found.version,
            source: found.source.name,
            updateAvailable: !versionAtLeast(VERSION, found.version),
            releaseUrl: `https://github.com/${UPDATE_REPO}`,
        };
    }
    catch (error) {
        result = { ok: false, current: VERSION, latest: undefined, updateAvailable: false, error: String(error?.message ?? error) };
    }
    updateCheckCache = { at: now, payload: result };
    return result;
}

/**
 * REST-based self-update: fetch every runtime file from GitHub and overwrite
 * the installed package in place. No pnpm/git needed, so it works even when
 * the git protocol to github.com is blocked but HTTPS is reachable.
 */
async function selfUpdateViaRest() {
    const found = await firstWorkingSource();
    const latest = found.version;
    if (versionAtLeast(VERSION, latest)) return { updated: false, current: VERSION, latest };
    const profileDir = guessProfileDir();
    const pkgDir = join(profileDir, 'node_modules', 'dsh-fleet');
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error(`installed package not found at ${pkgDir} (expected inside ${profileDir})`);
    let realDir = pkgDir;
    try { realDir = realpathSync(pkgDir); } catch { /* keep as-is */ }
    for (const rel of UPDATE_FILE_PATHS) {
        let payload;
        try {
            payload = decodeSourcePayload(found.source, await httpText(sourceFileUrl(found.source, rel)));
        }
        catch (error) {
            if (rel === 'package.json') throw error;
            continue; // optional file (e.g. LICENSE) missing upstream — skip
        }
        const target = join(realDir, rel.split('/').join(process.platform === 'win32' ? '\\' : '/'));
        const targetDir = dirname(target);
        mkdirSync(targetDir, { recursive: true });
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, payload.replace(/\r\n/g, '\n'), 'utf8');
        renameSync(tmp, target);
    }
    const applied = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8'));
    if (!versionAtLeast(String(applied?.version ?? ''), latest)) throw new Error('update applied but version check failed — files may be stale');
    return { updated: true, current: VERSION, latest, profileDir };
}

/** Guess the profile directory this plugin is installed under. */
function guessProfileDir() {
    const candidates = [];
    const libParent = dirname(THIS_LIB_DIR);          // .../dsh-fleet
    const nodeModules = dirname(libParent);           // .../node_modules
    candidates.push(dirname(nodeModules));            // profile dir (hoisted layout)
    candidates.push(join(homeDir(), 'profiles', 'web'));
    for (const candidate of candidates) {
        try {
            const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
            if (manifest?.dsh?.profile) return candidate;
        }
        catch { /* try next */ }
    }
    return join(homeDir(), 'profiles', 'web');
}

/** Resolve a runnable pnpm (path + shell flag). */
async function findPnpm() {
    const tries = [];
    if (isWin) {
        const npm = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'pnpm.cmd') : '';
        tries.push({ bin: npm, shell: true }, { bin: 'pnpm', shell: true });
    }
    else {
        tries.push({ bin: 'pnpm', shell: false });
    }
    for (const candidate of tries) {
        if (candidate.bin && !candidate.bin.startsWith('pnpm') && !existsSync(candidate.bin)) continue;
        try {
            await execFileAsync(candidate.bin, ['--version'], { shell: candidate.shell, timeout: 15000, windowsHide: true });
            return candidate;
        }
        catch { /* next */ }
    }
    throw new Error('pnpm is not available on PATH — install pnpm (corepack enable pnpm) then retry');
}

async function pullLatestFromGitHub() {
    const profileDir = guessProfileDir();
    const pnpm = await findPnpm();
    const spec = `github:${UPDATE_REPO}#${UPDATE_BRANCH}`;
    await execFileAsync(pnpm.bin, ['add', spec], {
        cwd: profileDir,
        shell: pnpm.shell,
        timeout: 300000,
        windowsHide: true,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
    });
    return { profileDir, spec };
}

function relaunchScriptContent(webPort) {
    const nodeExe = process.execPath;
    const binJs = process.argv[1] ?? join(dirname(dirname(THIS_LIB_DIR)), 'bin.js');
    const args = JSON.stringify(process.argv.length > 2 ? process.argv.slice(2) : ['web']);
    const cwd = process.cwd();
    const pid = process.pid;
    const log = join(homeDir(), `dsh-fleet-restart-${pid}.log`);
    const probeUrl = `http://127.0.0.1:${Number(webPort) || 3080}/`;
    return [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync, appendFileSync } from 'node:fs';",
        `const log = ${JSON.stringify(log)};`,
        `const parentPid = ${pid};`,
        `const nodeExe = ${JSON.stringify(nodeExe)};`,
        `const binJs = ${JSON.stringify(binJs)};`,
        `const args = ${args};`,
        `const cwd = ${JSON.stringify(cwd)};`,
        `const probeUrl = ${JSON.stringify(probeUrl)};`,
        "const L = (m) => { try { appendFileSync(log, new Date().toISOString() + '  ' + m + '\\n'); } catch {} };",
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "async function down() { for (let i = 0; i < 30; i++) { try { const r = await fetch(probeUrl); if (r.ok) { await sleep(500); continue; } return; } catch { return; } } }",
        "async function up() { for (let i = 0; i < 90; i++) { await sleep(1000); try { const r = await fetch(probeUrl); if (r.ok) return true; } catch {} } return false; }",
        "L('relauncher starting');",
        "await sleep(3000);",
        "try { process.kill(parentPid, 'SIGTERM'); } catch {}",
        "await sleep(1500);",
        "try { process.kill(parentPid, 'SIGKILL'); } catch {}",
        "await down();",
        "L('port down; starting new instance');",
        "const child = spawn(nodeExe, [binJs, ...args], { cwd, detached: true, stdio: 'ignore' });",
        "child.unref();",
        "const ok = await up();",
        "L(ok ? 'new instance up' : 'new instance did not come up');",
        "process.exit(0);",
    ].join('\n');
}

/** Schedule a self-restart of THIS dsh web process (kills us, respawns). */
async function restartProcess(webPort) {
    const scriptPath = join(homeDir(), `dsh-fleet-restart-${process.pid}.mjs`);
    writeFileSync(scriptPath, relaunchScriptContent(webPort), 'utf8');
    const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return { scheduled: true, pid: process.pid };
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
        gateway: gatewayStatus(),
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
    ctx.effect(() => () => stopGateway());
    // Authoritative busy state: any live agent in `running` means the harness is
    // working (thinking/deep-diving included) — never mistake silence for done.
    const offStatus = ctx.on('agent/status', handleAgentStatus);
    const offDisposed = ctx.on('agent/disposed', handleAgentDisposed);
    // Registry snapshot for /live: survives a host-side (re)start mid-dive.
    reconcileAgentsRef = () => {
        const svc = ctx.get('agents');
        if (!svc || typeof svc.list !== 'function') return null;
        let running = 0;
        for (const agent of svc.list()) {
            if (agent && agent.status === 'running') running += 1;
        }
        return running;
    };
    ctx.effect(() => () => {
        try { offStatus(); } catch { /* ignore */ }
        try { offDisposed(); } catch { /* ignore */ }
        agentStatus.clear();
        reconcileAgentsRef = null;
    });
    // Wait for the web server service exactly like other web plugins do: on a
    // fresh boot `webServer` may not be provided yet when this row activates,
    // so a synchronous `ctx.get` at apply time would silently leave the plugin
    // inert. ctx.inject re-runs the mount as soon as the service appears.
    ctx.inject(['webServer'], (hostCtx) => {
        const dispose = registerAll(hostCtx.webServer);
        hostCtx.effect(() => dispose);
    });
    // The gateway is independent of the app web server (self-hosted listener),
    // so it can start right away.
    startGateway();
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
                const id = addRemote(body?.name, body?.origin, body?.token, body?.insecure);
                sendJson(response, 200, { ok: true, id, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/set-remote-insecure',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                setRemoteInsecure(body?.id, body?.insecure === true);
                sendJson(response, 200, { ok: true, state: await statePayload() });
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
                sendJson(response, 200, sessionsIndexPayload(queryParam(request, 'includeTitles') === '1'));
            }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/local-session-content',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const payload = sessionContentPayload(queryParam(request, 'id'));
                sendJson(response, payload.ok ? 200 : 404, payload);
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
                startGateway(); // token cleared ⇒ gateway stops; token set ⇒ (re)check
                sendJson(response, 200, { ok: true, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/set-gateway',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                setGatewaySettings(body?.enabled, body?.port, body?.host);
                sendJson(response, 200, { ok: true, state: await statePayload() });
            }
            catch (error) { sendJson(response, 400, { error: String(error) }); }
        },
    }));

    /* ---- test-stage self-update (all guarded) ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/update-check',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                sendJson(response, 200, await checkForUpdates(queryParam(request, 'force') === '1'));
            }
            catch (error) { sendJson(response, 500, { error: String(error?.message ?? error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/self-update',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const check = await checkForUpdates(true);
                if (!check.updateAvailable) { sendJson(response, 200, { ok: true, updated: false, current: check.current, latest: check.latest }); return; }
                const pulled = await selfUpdateViaRest();
                sendJson(response, 200, { ok: true, updated: true, current: VERSION, latest: check.latest, profileDir: pulled.profileDir });
            }
            catch (error) { sendJson(response, 500, { error: String(error?.message ?? error), hint: 'REST update failed — ensure this device can reach api.github.com/raw/jsDelivr, or set DSL_FLEET_UPDATE_URL to a mirror' }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/restart',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const result = await restartProcess(request.socket?.localPort ?? 3080);
                sendJson(response, 200, { ok: true, ...result });
            }
            catch (error) { sendJson(response, 400, { error: String(error?.message ?? error) }); }
        },
    }));

    /* ---- token-gated restart so a trusted fleet member can reboot THIS
       dsh web (used by the "重启" button on remote device cards). ---- */
    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/restart-remote',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try {
                const result = await restartProcess(request.socket?.localPort ?? 3080);
                sendJson(response, 200, { ok: true, ...result });
            }
            catch (error) { sendJson(response, 400, { error: String(error?.message ?? error) }); }
        },
    }));

    /* ---- token-gated serving for OTHER machines ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/sessions',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try {
                sendJson(response, 200, sessionsIndexPayload(queryParam(request, 'includeTitles') === '1'));
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
                const payload = sessionContentPayload(queryParam(request, 'id'));
                sendJson(response, payload.ok ? 200 : 404, payload);
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

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remote-restart',
        handler: async (request, response) => {
            if (!guardPost(request, response)) return;
            try {
                const body = await readJsonBody(request);
                const remote = findRemote(body?.remote ?? body?.id);
                if (!remote) { sendJson(response, 404, { error: 'remote not found' }); return; }
                if (!remote.token) { sendJson(response, 400, { error: 'no session token configured for this remote' }); return; }
                const payload = await remoteFetch(remote, 'restart-remote', {});
                sendJson(response, 200, { ok: true, remote: remote.id, scheduled: payload?.scheduled === true });
            }
            catch (error) { sendJson(response, 502, { error: String(error?.message ?? error) }); }
        },
    }));

    /* ---- cheap freshness (for always-on running/completed indicators) ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/local-fresh',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try { sendJson(response, 200, freshnessPayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/fresh',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try { sendJson(response, 200, freshnessPayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remote-fresh',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const remote = findRemote(queryParam(request, 'remote'));
                if (!remote) { sendJson(response, 404, { error: 'remote not found' }); return; }
                const payload = await remoteFetch(remote, 'fresh', {});
                sendJson(response, 200, payload);
            }
            catch (error) { sendJson(response, 502, { error: String(error) }); }
        },
    }));

    /* ---- authoritative live state (agent/status based) ---- */

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/local-live',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try { sendJson(response, 200, livePayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/live',
        handler: async (request, response) => {
            const auth = tokenAuthorized(request);
            if (!auth.ok) { sendJson(response, auth.code, { error: auth.error }); return; }
            try { sendJson(response, 200, livePayload()); }
            catch (error) { sendJson(response, 500, { error: String(error) }); }
        },
    }));

    disposers.push(webServer.register({
        kind: 'exact', path: '/dsh-fleet/api/remote-live',
        handler: async (request, response) => {
            if (!guardGetLocal(request, response)) return;
            try {
                const remote = findRemote(queryParam(request, 'remote'));
                if (!remote) { sendJson(response, 404, { error: 'remote not found' }); return; }
                const payload = await remoteFetch(remote, 'live', {});
                sendJson(response, 200, payload);
            }
            catch (error) { sendJson(response, 502, { error: String(error) }); }
        },
    }));

    return () => {
        for (const dispose of disposers) dispose();
    };
}
