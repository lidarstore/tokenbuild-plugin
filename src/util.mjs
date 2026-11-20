import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ~4 chars per token for code and English; good enough for budgets.
export const tokens = (s) => Math.ceil((s ? String(s).length : 0) / 4);

export const JUNK = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|vendor|target|__pycache__|\.venv|venv)\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
  /\.min\.(js|css)$/, /\.map$/, /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov|so|dylib|dll|exe|bin)$/i,
];
export const isJunk = (p) => JUNK.some((re) => re.test(p.replaceAll('\\', '/')));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.tokenbuild']);

function gitignore(root) {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((g) => new RegExp('(^|/)' + g.replace(/^\//, '').replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '(/|$)'));
  } catch { return []; }
}

export function* walk(root, maxFiles = 20000) {
  const ignore = gitignore(root);
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignore.some((re) => re.test(r))) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r); }
      else if (e.isFile() && !isJunk(r)) { if (++n > maxFiles) return; yield r; }
    }
  }
}

export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// mkdir -p; the first time it creates a .tokenbuild folder it drops a .gitignore of "*" in it,
// so plugin users (who never run init) don't commit TokenBuild's local state.
export function mkdirp(d) {
  if (!fs.mkdirSync(d, { recursive: true })) return;
  const i = d.lastIndexOf(`${path.sep}.tokenbuild`);
  if (i < 0) return;
  const g = path.join(d.slice(0, i), '.tokenbuild', '.gitignore');
  try { fs.writeFileSync(g, '*\n', { flag: 'wx' }); } catch {}
}

export function writeJSON(p, v) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v));
}

export const tbDir = (root) => path.join(root, '.tokenbuild');

export function appendLedger(root, event) {
  const p = path.join(tbDir(root), 'ledger.jsonl');
  mkdirp(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify({ t: Date.now(), ...event }) + '\n');
}

export const usd = (n) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
export const num = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
