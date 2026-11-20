// Repo memory: learns from your own sessions which files real tasks touch, so the next similar
// task starts in the right place instead of exploring.
//   files[path] = { e: edits, k: { word: weight } }   task words that led to edits (stays on this machine)
//   co[a][b]    = times a and b were edited in the same task                       (paths only: shareable)
// Team plans share only the co-edit graph and edit counts (file paths and counts, never prompt words).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tbDir, readJSON, writeJSON } from './util.mjs';

const MAX_FILES = 3000, MAX_WORDS = 40, MAX_CO = 25;
const STOP = new Set('the a an and or but to of in on for with from by at as is are was were be been it this that these those i we you me my our your please can could would should will just also then than now so do does did not no yes make add fix update change use using into about when what how why where which there here all any some more most new old get set let need want like run test tests file files code function'.split(' '));
export const keywords = (text) => [...new Set((String(text).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 24);

const file = (root) => path.join(tbDir(root), 'memory.json');
const teamFile = (root) => path.join(tbDir(root), 'team-memory.json');
export const load = (root) => readJSON(file(root), { v: 1, files: {}, co: {} });
export const loadTeam = (root) => readJSON(teamFile(root), { files: {}, co: {} });
export const saveTeam = (root, m) => writeJSON(teamFile(root), m);

function trim(m) {
  const fs_ = Object.entries(m.files);
  if (fs_.length > MAX_FILES) for (const [p] of fs_.sort((a, b) => a[1].e - b[1].e).slice(0, fs_.length - MAX_FILES)) { delete m.files[p]; delete m.co[p]; }
  for (const v of Object.values(m.files)) {
    const ks = Object.entries(v.k);
    if (ks.length > MAX_WORDS) v.k = Object.fromEntries(ks.sort((a, b) => b[1] - a[1]).slice(0, MAX_WORDS));
  }
  for (const [a, row] of Object.entries(m.co)) {
    const es = Object.entries(row);
    if (es.length > MAX_CO) m.co[a] = Object.fromEntries(es.sort((x, y) => y[1] - x[1]).slice(0, MAX_CO));
  }
  return m;
}

// Record that `rel` was edited while working on a task with these words, alongside `others`.
export function learnEdit(root, rel, words, others = []) {
  const m = load(root);
  const f = (m.files[rel] ||= { e: 0, k: {} });
  f.e++;
  for (const w of words) f.k[w] = (f.k[w] || 0) + 1;
  for (const o of others) {
    if (o === rel) continue;
    (m.co[rel] ||= {})[o] = (m.co[rel][o] || 0) + 1;
    (m.co[o] ||= {})[rel] = (m.co[o][rel] || 0) + 1;
  }
  writeJSON(file(root), trim(m));
}

// Files that past tasks with similar words ended up changing. [{ path, score, edits }]
export function recall(root, words, { limit = 5, exists = (p) => fs.existsSync(path.join(root, p)) } = {}) {
  const m = load(root);
  const df = {}; for (const v of Object.values(m.files)) for (const w of Object.keys(v.k)) df[w] = (df[w] || 0) + 1;
  const n = Object.keys(m.files).length || 1;
  const out = [];
  for (const [p, v] of Object.entries(m.files)) {
    let s = 0, hits = 0;
    for (const w of words) if (v.k[w]) { hits++; s += (v.k[w] / (v.k[w] + 1)) * Math.log(1 + n / df[w]); }
    if (hits >= 2 || (hits === 1 && words.length === 1)) out.push({ path: p, score: s, edits: v.e });
  }
  return out.sort((a, b) => b.score - a.score).filter((x) => exists(x.path)).slice(0, limit);
}

// Files usually changed together with `rel`, from your own history and (if synced) your team's.
export function partners(root, rel, { min = 3, limit = 3 } = {}) {
  const mine = load(root), team = loadTeam(root);
  const total = (mine.files[rel]?.e || 0) + (team.files[rel] || 0);
  const merged = {};
  for (const src of [mine.co[rel] || {}, team.co[rel] || {}]) for (const [b, c] of Object.entries(src)) merged[b] = (merged[b] || 0) + c;
  return Object.entries(merged).filter(([b, c]) => c >= min && c >= total * 0.4 && fs.existsSync(path.join(root, b)))
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, c]) => ({ path: p, times: c }));
}

// Boost for context packs: path -> extra score.
export function packBoost(root, task) {
  const words = keywords(task);
  return new Map(recall(root, words, { limit: 8 }).map((r) => [r.path, 5 + r.score]));
}

// What a Team sync shares: edit counts and co-edit pairs (paths and counts only).
export function shareable(root) {
  const m = load(root);
  return { files: Object.fromEntries(Object.entries(m.files).map(([p, v]) => [p, v.e])), co: m.co };
}

// This machine's id within a team (random, stored with the licence).
export function memberId(home) {
  const p = path.join(home, 'member');
  try { const v = fs.readFileSync(p, 'utf8').trim(); if (/^[a-f0-9]{24}$/.test(v)) return v; } catch {}
  const v = crypto.randomBytes(12).toString('hex');
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(p, v); return v;
}

// Team sync: push our shareable snapshot, save the rest of the team's. Returns { members } or { error }.
export async function syncTeam(root, { api, key, home }) {
  const project = projectId(root);
  if (!project) return { error: 'no git remote' };
  if (readJSON(path.join(tbDir(root), 'config.json'), {}).teamMemory === false) return { error: 'off' };
  const r = await fetch(api + '/v1/memory', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ project, member: memberId(home), ...shareable(root) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j.error || String(r.status) };
  saveTeam(root, { files: j.files || {}, co: j.co || {} });
  return { members: j.members };
}

// Stable, non-reversible id for this repo so teammates on the same repo share memory.
export function projectId(root) {
  let url = '';
  try { url = (fs.readFileSync(path.join(root, '.git', 'config'), 'utf8').match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/) || [])[1] || ''; } catch {}
  if (!url) return null;
  const norm = url.replace(/^(?:https?:\/\/|ssh:\/\/|git@)/, '').replace(/^[^@]+@/, '').replace(':', '/').replace(/\.git$/, '').toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 24);
}
