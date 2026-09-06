/**
 * release.mjs — create a git tag + GitHub Release for dsh-fleet (Punica Studio).
 *
 * Usage:
 *   node scripts/release.mjs v0.14.0 [--notes-file release-notes.md]
 *
 * Requires GH_TOKEN env (classic PAT with repo scope). Reads it from
 * ../.gh-token.md if the env var is absent (never committed).
 * Works over plain HTTPS (no git protocol needed).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'loveXbanshee/dsh-fleet';
const API = `https://api.github.com/repos/${REPO}`;

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  for (const p of [join(ROOT, '.gh-token.md'), join(process.env.USERPROFILE || '', '.dsh', 'gh-token.md')]) {
    if (!existsSync(p)) continue;
    const found = readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('ghp_'));
    if (found) return found;
  }
  throw new Error('GH_TOKEN env missing and no .gh-token.md found');
}

async function gh(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof json === 'string' ? text : JSON.stringify(json).slice(0, 400)}`);
  return json;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const tag = args.find((a) => !a.startsWith('-'));
  let notesFile = null;
  const ni = args.indexOf('--notes-file');
  if (ni !== -1 && args[ni + 1]) notesFile = args[ni + 1];
  if (!tag || !/^v?\d+\.\d+\.\d+/.test(tag)) {
    console.error('usage: node scripts/release.mjs v0.14.0 [--notes-file release-notes.md]');
    process.exit(2);
  }
  const tagName = tag.startsWith('v') ? tag : `v${tag}`;
  return { tagName, notesFile };
}

(async () => {
  const { tagName, notesFile } = parseArgs();

  // Sanity: package.json on disk carries the same version we tag.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const diskVersion = `v${pkg.version}`;
  if (diskVersion !== tagName) {
    console.error(`version mismatch: tag=${tagName} package.json=${diskVersion}. Bump package.json + lib VERSION first.`);
    process.exit(1);
  }

  const head = await gh(`${API}/git/ref/heads/main`);
  const sha = head.object.sha;
  console.log(`main HEAD = ${sha}`);

  let tagExists = true;
  try { await gh(`${API}/git/ref/tags/${encodeURIComponent(tagName)}`); }
  catch { tagExists = false; }
  if (!tagExists) {
    await gh(`${API}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tagName}`, sha } });
    console.log(`tag ${tagName} created @ ${sha}`);
  }
  else {
    console.log(`tag ${tagName} already exists — reusing`);
  }

  let notes = '';
  if (notesFile) {
    const p = join(ROOT, notesFile); // resolve against repo root, not cwd
    if (!existsSync(p)) throw new Error(`notes file not found: ${p}`);
    notes = readFileSync(p, 'utf8');
  }

  let release = null;
  try {
    release = await gh(`${API}/releases`, { method: 'POST', body: {
      tag_name: tagName,
      name: tagName,
      body: notes || 'dsh-fleet · Punica Studio',
      draft: false,
      prerelease: false,
    } });
    console.log(`release created: ${release.html_url}`);
  }
  catch (error) {
    console.error(`release create failed (maybe exists): ${String(error.message)}`);
    process.exitCode = 1;
  }
})();
