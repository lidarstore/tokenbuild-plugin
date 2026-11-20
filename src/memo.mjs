// Exploration Memo: answers Claude worked out about this repo ("where is auth handled?"), saved with the
// content hashes of the files they rest on. A later match is returned only while every one of those files
// is unchanged, so a memo is never stale. Saved explicitly (tb_memo) or automatically when a question
// took several searches and reads. Local only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tbDir, readJSON, writeJSON } from './util.mjs';
import { keywords } from './memory.mjs';

const MAX = 400;
const file = (root) => path.join(tbDir(root), 'memo.json');
const load = (root) => readJSON(file(root), { v: 1, m: [] });
const fhash = (root, rel) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex').slice(0, 12); } catch { return null; } };
const relOf = (root, f) => path.relative(root, path.isAbsolute(f) ? f : path.join(root, f));

export function save(root, question, answer, files = []) {
  const w = keywords(question);
  if (!w.length || !String(answer || '').trim()) return { error: 'question and answer are required.' };
  const fs_ = {};
  for (const f of files.slice(0, 12)) { const r = relOf(root, f); if (r.startsWith('..')) continue; const h = fhash(root, r); if (h) fs_[r] = h; }
  const m = load(root);
  m.m = m.m.filter((x) => keywords(x.q).join(' ') !== w.join(' '));
  m.m.push({ q: String(question).slice(0, 300), a: String(answer).trim().slice(0, 1500), f: fs_, at: Date.now(), hits: 0 });
  if (m.m.length > MAX) m.m = m.m.sort((a, b) => b.hits - a.hits || b.at - a.at).slice(0, MAX);
  writeJSON(file(root), m);
  return { ok: true, files: Object.keys(fs_).length };
}

// Fresh matches for a question: [{ q, a, files, age }]; stale ones are dropped.
export function find(root, question, { limit = 2, min = 0.5 } = {}) {
  const w = new Set(keywords(question));
  if (!w.size) return [];
  const m = load(root);
  let dirty = false;
  const out = [];
  for (const x of m.m) {
    const k = keywords(x.q), shared = k.filter((t) => w.has(t)).length;
    if (shared < 2 && shared / Math.max(1, Math.min(w.size, k.length)) < min) continue;
    const score = shared / Math.max(w.size, k.length);
    if (score < min * 0.6) continue;
    const stale = Object.entries(x.f).some(([r, h]) => fhash(root, r) !== h);
    if (stale) { x.stale = 1; dirty = true; continue; }
    out.push({ ...x, score });
  }
  if (dirty) { m.m = m.m.filter((x) => !x.stale); }
  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, limit);
  for (const t of top) { const x = m.m.find((y) => y.q === t.q); if (x) x.hits++; }
  if (dirty || top.length) writeJSON(file(root), m);
  return top.map((x) => ({ q: x.q, a: x.a, files: Object.keys(x.f), age: Date.now() - x.at }));
}

export const isQuestion = (p) => /\?\s*$/.test(String(p).trim()) || /^\s*(where|how|what|why|which|who|explain|find|show me|does|is there|can you (find|explain|tell))\b/i.test(String(p));
