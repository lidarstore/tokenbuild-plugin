// Repo Index, map, find and context packs. Regex symbol extraction: fast, zero deps, zero tokens.
import fs from 'node:fs';
import path from 'node:path';
import { walk, tokens, hash, readJSON, writeJSON, tbDir } from './util.mjs';

const LANG = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', py: 'py', go: 'go', rb: 'rb', java: 'java', kt: 'java', cs: 'java', rs: 'rs', php: 'php', swift: 'swift' };
const MAX_BYTES = 400_000;

const RULES = {
  js: [
    [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*(\([^)]*\))?/, 'fn'],
    [/^\s*(?:async\s+)?function\*?\s+(\w+)\s*(\([^)]*\))?/, 'fn'],
    [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, 'class'],
    [/^\s*class\s+(\w+)/, 'class'],
    [/^\s*export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(\([^)]*\)|\w+)\s*=>/, 'fn'],
    [/^\s*export\s+(?:const|let|var)\s+(\w+)/, 'const'],
    [/^\s*export\s+(?:interface|type|enum)\s+(\w+)/, 'type'],
    [/^\s{2,4}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*(\([^)]*\))\s*\{/, 'method'],
  ],
  py: [[/^(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))?/, 'fn'], [/^class\s+(\w+)/, 'class'], [/^\s{4}(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))?/, 'method']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*(\([^)]*\))?/, 'fn'], [/^type\s+(\w+)\s+(struct|interface)/, 'type']],
  rb: [[/^\s*def\s+(?:self\.)?(\w+[?!]?)/, 'fn'], [/^\s*(?:class|module)\s+(\w+)/, 'class']],
  java: [[/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/, 'class'], [/^\s+(?:public|private|protected)\s+[\w<>\[\],\s]+\s+(\w+)\s*(\([^)]*\))/, 'method']],
  rs: [[/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(\([^)]*\))?/, 'fn'], [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, 'type']],
  php: [[/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*(\([^)]*\))?/, 'fn'], [/^\s*class\s+(\w+)/, 'class']],
  swift: [[/^\s*(?:public\s+|private\s+)?func\s+(\w+)\s*(\([^)]*\))?/, 'fn'], [/^\s*(?:public\s+)?(?:class|struct|enum|protocol)\s+(\w+)/, 'type']],
};
const IMPORT = {
  js: /(?:import\s[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g,
  py: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
  go: /"([^"]+)"/g,
};
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor']);

export function parseFile(text, lang) {
  const symbols = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [re, kind] of RULES[lang] || []) {
      const m = lines[i].match(re);
      if (m && !KEYWORDS.has(m[1])) { symbols.push({ n: m[1], k: kind, l: i + 1, s: m[2] ? m[2].replace(/\s+/g, ' ').slice(0, 80) : '' }); break; }
    }
  }
  const imports = [];
  const re = IMPORT[lang];
  if (re) for (const m of text.matchAll(re)) imports.push(m[1] || m[2]);
  return { symbols, imports: [...new Set(imports)].slice(0, 50) };
}

function resolveImport(from, spec, files) {
  if (!spec.startsWith('.')) {
    const dotted = spec.replaceAll('.', '/');
    return [`${dotted}.py`, `${dotted}/__init__.py`].find((c) => files[c]);
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.(m|c)?js$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.jsx`, `${base}/index.ts`, `${base}/index.js`].find((c) => files[c]);
}

export function buildIndex(root) {
  const p = path.join(tbDir(root), 'index.json');
  const old = readJSON(p, { files: {} });
  const files = {};
  let parsed = 0;
  for (const rel of walk(root)) {
    const lang = LANG[rel.split('.').pop()];
    if (!lang) continue;
    let st; try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    const prev = old.files[rel];
    if (prev && prev.m === st.mtimeMs && prev.z === st.size) { files[rel] = prev; continue; }
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    files[rel] = { m: st.mtimeMs, z: st.size, h: hash(text), lang, t: tokens(text), ...parseFile(text, lang) };
    parsed++;
  }
  const inDeg = {};
  for (const [f, v] of Object.entries(files)) {
    v.deps = v.imports.map((s) => resolveImport(f, s, files)).filter(Boolean);
    for (const d of v.deps) inDeg[d] = (inDeg[d] || 0) + 1;
  }
  for (const [f, v] of Object.entries(files)) v.rank = (inDeg[f] || 0) + v.symbols.length / 20;
  const idx = { v: 1, root, built: Date.now(), files };
  writeJSON(p, idx);
  return { idx, parsed, total: Object.keys(files).length };
}

export function loadIndex(root) {
  const idx = readJSON(path.join(tbDir(root), 'index.json'), null);
  return idx || buildIndex(root).idx;
}

const sym = (s) => `${s.n}${s.s || ''}`;

// Compact repo map: directories, then files by importance with their top symbols, cut to budget.
export function repoMap(idx, budget = 2500) {
  const entries = Object.entries(idx.files).sort((a, b) => b[1].rank - a[1].rank);
  const out = [`# Repo map (${entries.length} files; most-imported first)`];
  let used = tokens(out[0]);
  for (const [f, v] of entries) {
    const top = v.symbols.filter((s) => s.k !== 'method').slice(0, 6).map(sym).join(', ');
    const line = `${f}${top ? ': ' + top : ''}`;
    const t = tokens(line) + 1;
    if (used + t > budget) { out.push(`… ${entries.length - out.length + 1} more files (use tb_find)`); break; }
    out.push(line); used += t;
  }
  return out.join('\n');
}

const splitCamel = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const STOP = new Set(['the', 'and', 'for', 'with', 'add', 'fix', 'make', 'that', 'this', 'from', 'into', 'when', 'should', 'new', 'use', 'all', 'can', 'get', 'set']);
const words = (s) => (splitCamel(s).match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w));

function score(f, v, terms) {
  const hay = splitCamel(f + ' ' + v.symbols.map((s) => s.n).join(' '));
  let sc = 0;
  for (const t of terms) { if (hay.includes(t)) sc += f.toLowerCase().includes(t) ? 3 : 1; }
  return sc ? sc + Math.min(v.rank, 5) / 5 : 0;
}

// Symbol/file search: exact locations, so Claude reads lines instead of whole files.
export function find(idx, query, limit = 15) {
  const q = query.toLowerCase();
  const hits = [];
  for (const [f, v] of Object.entries(idx.files)) {
    for (const s of v.symbols) if (s.n.toLowerCase().includes(q)) hits.push({ f, ...s, exact: s.n.toLowerCase() === q });
    if (f.toLowerCase().includes(q)) hits.push({ f, n: '(file)', k: 'file', l: 1, s: '', exact: false });
  }
  hits.sort((a, b) => b.exact - a.exact || a.f.length - b.f.length);
  return hits.slice(0, limit).map((h) => `${h.f}:${h.l} ${h.k} ${h.n}${h.s || ''}`).join('\n') || 'No matches.';
}

// Context pack: the files a task most likely needs, as signatures + line numbers, under budget.
export function rank(idx, task, boost = null) {
  const terms = [...new Set(words(task))].filter((w) => w.length > 2);
  return Object.entries(idx.files).map(([f, v]) => [f, v, score(f, v, terms) + (boost?.get(f) || 0)]).filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2]);
}
export const taskWords = (task) => [...new Set(words(task))].filter((w) => w.length > 2);

export function pack(idx, task, budget = 4000, boost = null) {
  const ranked = rank(idx, task, boost);
  const chosen = new Map(ranked.slice(0, 8).map(([f, v]) => [f, v]));
  for (const [f, v] of ranked.slice(0, 4)) for (const d of v.deps || []) if (!chosen.has(d) && chosen.size < 12) chosen.set(d, idx.files[d]);
  const out = [`# Context pack: ${task.slice(0, 80)}`, 'Files likely involved (path:line symbol). Read only the line ranges you need.'];
  let used = tokens(out.join('\n'));
  for (const [f, v] of chosen) {
    const head = `\n## ${f} (~${v.t} tok)${boost?.has(f) ? ' · changed in similar past tasks' : ''}`;
    const body = v.symbols.slice(0, 25).map((s) => `${s.l}: ${s.k} ${sym(s)}`).join('\n');
    const t = tokens(head + body);
    if (used + t > budget) { out.push(`\n… more candidates omitted to stay under ${budget} tokens`); break; }
    out.push(head, body); used += t;
  }
  if (chosen.size === 0) out.push('\nNo matching files. Try tb_find with a symbol name.');
  else { const whole = [...chosen.values()].reduce((a, v) => a + (v?.t || 0), 0); out.push(`\n(TokenBuild: this pack is ~${used} tokens; reading these ${chosen.size} files whole would be ~${whole}.)`); }
  return out.join('\n');
}
