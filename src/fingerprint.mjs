// Failure fingerprints: a failing check's first error line, normalized (numbers, hashes, quoted values and
// machine-specific paths removed) and hashed. When the same check later passes, the files edited in
// between are recorded as that fingerprint's fix. A later match points Claude straight at those files.
// Shareable part (Team sync): fingerprint hash -> { path: count }. The error text never leaves the machine.
import path from 'node:path';
import crypto from 'node:crypto';
import { tbDir, readJSON, writeJSON } from './util.mjs';
import { normErr } from './stuck.mjs';

const MAX = 2000;
const file = (root) => path.join(tbDir(root), 'fingerprints.json');
export const load = (root) => readJSON(file(root), { v: 1, fp: {} });
const teamFp = (root) => readJSON(path.join(tbDir(root), 'team-memory.json'), {}).fp || {};

const unpath = (s) => String(s).replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:'"()]+)+[\\/]([^\s\\/:'"()]+)/g, '$1');
export const fingerprint = (err) => crypto.createHash('sha1').update(normErr(unpath(err))).digest('hex').slice(0, 16);

// The same check passed after failing: the files edited since the failure fixed it.
export function learn(root, fp, files, err) {
  if (!files.length) return;
  const m = load(root);
  const e = (m.fp[fp] ||= { n: 0, fix: {}, e: '' });
  e.n++; e.at = Date.now(); e.e = String(err).slice(0, 160);          // local only
  for (const f of files.slice(0, 8)) e.fix[f] = (e.fix[f] || 0) + 1;
  const all = Object.entries(m.fp);
  if (all.length > MAX) for (const [k] of all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - MAX)) delete m.fp[k];
  writeJSON(file(root), m);
}

// Known fix for a fingerprint: local first, then the team's. Returns { files, n, team } or null.
export function lookup(root, fp) {
  const mine = load(root).fp[fp], team = teamFp(root)[fp];
  const fix = {};
  for (const src of [mine?.fix, team]) for (const [p, c] of Object.entries(src || {})) fix[p] = (fix[p] || 0) + c;
  const files = Object.entries(fix).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!files.length) return null;
  return { files, n: (mine?.n || 0) + Object.values(team || {}).reduce((a, b) => Math.max(a, b), 0), team: !!team && !mine };
}

export const shareable = (root) => Object.fromEntries(Object.entries(load(root).fp).map(([k, v]) => [k, v.fix]));

// Fingerprints whose fixes touched any of `files` (for the task brief). Local entries only: they carry text.
export function near(root, files) {
  const set = new Set(files);
  return Object.values(load(root).fp).filter((v) => Object.keys(v.fix).some((f) => set.has(f))).sort((a, b) => b.at - a.at).slice(0, 2);
}
