// Next-read prediction: learns, from your own sessions, which files tend to be opened after which
// (within the next 3 files touched). After Claude touches a file, the likely next files' outlines
// (symbols + line numbers from the Repo Index) are offered up front, like a CPU prefetch.
// Hits are counted only when Claude then actually opens a predicted file.
import path from 'node:path';
import { tbDir, readJSON, writeJSON } from './util.mjs';

const WINDOW = 3, MIN = 3, ROW = 12, ROWS = 3000;
const file = (root) => path.join(tbDir(root), 'next.json');

// Update transitions with this touch. `s` is the per-session hook state (mutated).
export function touch(root, s, rel) {
  s.seq ||= []; s.predicted ||= []; s.predFrom ||= {};
  let hit = false;
  const i = s.predicted.indexOf(rel);
  if (i >= 0) { s.predicted.splice(i, 1); hit = true; }
  if (s.seq[s.seq.length - 1] === rel) return { hit };
  const m = readJSON(file(root), { v: 1, t: {} });
  for (const p of new Set(s.seq.slice(-WINDOW))) {
    if (p === rel) continue;
    const row = (m.t[p] ||= {}); row[rel] = (row[rel] || 0) + 1;
    const es = Object.entries(row); if (es.length > ROW) m.t[p] = Object.fromEntries(es.sort((a, b) => b[1] - a[1]).slice(0, ROW));
  }
  const rows = Object.keys(m.t); if (rows.length > ROWS) for (const k of rows.slice(0, rows.length - ROWS)) delete m.t[k];
  writeJSON(file(root), m);
  s.seq.push(rel); if (s.seq.length > 50) s.seq.shift();
  return { hit };
}

export function successors(root, rel, exclude = new Set(), limit = 2) {
  const row = readJSON(file(root), { t: {} }).t[rel] || {};
  return Object.entries(row).filter(([f, n]) => n >= MIN && !exclude.has(f)).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// Note for Claude after touching `rel`, at most once per file per session.
export function prefetch(root, s, rel, idx) {
  if (s.predFrom[rel]) return null;
  s.predFrom[rel] = 1;
  const next = successors(root, rel, new Set(s.seq));
  if (!next.length) return null;
  const outline = (f) => (idx?.files?.[f]?.symbols || []).filter((x) => x.k !== 'method').slice(0, 5).map((x) => `${x.n}:${x.l}`).join(', ');
  s.predicted.push(...next.map(([f]) => f));
  return `TokenBuild next-read: after ${rel} you usually open ${next.map(([f, n]) => `${f} (${n}×${outline(f) ? `; ${outline(f)}` : ''})`).join(' and ')}. Read just the lines you need if this task needs them.`;
}
