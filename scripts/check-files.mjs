/**
 * check-files.mjs — repo hygiene check (no dependencies).
 *
 * 1. Detects a UTF-8 BOM (EF BB BF) at the start of any scanned file — the
 *    failure mode that once broke `dsh web` boot (JSON.parse rejects BOM).
 * 2. Validates every `.json` file parses.
 *
 * Default scan: the package tree (lib, client, scripts, *.json, *.yml,
 * README/LICENCE/.gitignore). You can also point it at arbitrary paths:
 *
 *   node scripts/check-files.mjs            # scan this package
 *   node scripts/check-files.mjs <path...>  # scan the given files/dirs instead
 *
 *   node scripts/check-files.mjs "%USERPROFILE%\.dsh\profiles\web\package.json"
 *   node scripts/check-files.mjs "%USERPROFILE%\.dsh\profiles\web"
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IGNORED_DIRS = new Set(['.git', 'node_modules']);
const EXTS_JSON = new Set(['.json']);
const ALWAYS = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', '.gitignore'];

const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

function collect(target, into) {
    const stat = statSync(target);
    if (stat.isFile()) {
        into.push(target);
        return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(target)) {
        if (IGNORED_DIRS.has(entry)) continue;
        collect(join(target, entry), into);
    }
}

function scanTargets() {
    const files = [];
    if (explicit.length > 0) {
        for (const target of explicit) {
            const resolved = resolve(process.cwd(), target);
            if (!statSafe(resolved)) {
                console.error(`check-files: path not found: ${target}`);
                process.exitCode = 2;
                continue;
            }
            collect(resolved, files);
        }
        return files;
    }
    collect(join(ROOT, 'lib'), files);
    collect(join(ROOT, 'client'), files);
    if (statSafe(join(ROOT, 'scripts'))) collect(join(ROOT, 'scripts'), files);
    for (const name of ALWAYS) {
        const file = join(ROOT, name);
        if (statSafe(file)) files.push(file);
    }
    return files;
}

function statSafe(file) {
    try { statSync(file); return true; }
    catch { return false; }
}

const problems = [];
const files = scanTargets().sort();
for (const file of files) {
    if (basename(file) === 'check-files.mjs') continue; // self
    let head;
    try {
        const bytes = readFileSync(file);
        head = bytes.subarray(0, 3);
        const hasBom = bytes.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
        if (hasBom) problems.push(`BOM  (UTF-8 BOM present): ${file}`);
        if (EXTS_JSON.has(extname(file))) {
            try { JSON.parse(bytes.toString('utf8')); }
            catch (error) { problems.push(`JSON invalid: ${file} — ${String(error.message || error)}`); }
        }
    }
    catch (error) {
        problems.push(`unreadable: ${file} — ${String(error.message || error)}`);
    }
}

if (problems.length > 0) {
    console.error(`check-files: ${problems.length} problem(s) found:`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
}
console.log(`check-files: ok — ${files.length} file(s) scanned, no BOM, all JSON valid`);
