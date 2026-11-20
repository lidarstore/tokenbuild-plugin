// Real Meter: reads the exact token usage Claude Code records on every reply in the session transcript
// (input, cache reads, cache writes, output) and turns it into real tokens and dollars per task.
// Built on it: Narration Meter (how much of Claude's writing is recap), Cache Keeper (cache breaks,
// learned cache lifetime), Task Budget Forecast, control groups (proof), Permission Learner counts,
// Tool Diet call counts and Exploration Memo auto-capture. Reads the transcript incrementally from
// a saved offset, so each hook only parses what's new. Everything stays on this machine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tbDir, readJSON, writeJSON, tokens, appendLedger, mkdirp } from './util.mjs';
import { cost } from './prices.mjs';
import { keywords } from './memory.mjs';

const sidOf = (input) => String(input.session_id || 'none').replace(/[^\w-]/g, '');
const statePath = (root, sid) => path.join(tbDir(root), 'state', `meter-${sid}.json`);
const globalPath = (root) => path.join(tbDir(root), 'meter.json');
const tasksPath = (root) => path.join(tbDir(root), 'tasks.jsonl');
export const FEATURES = ['ledger', 'verify', 'brief', 'predict', 'preflight'];
const NARR = /^(?:I(?:'ve| have| will|'ll| am|'m| just| now)\b|Now,? |Let me |Next,? I|Great|Perfect|Excellent|Done[.!]|Okay|OK[,.]|Alright|Summary|To summarize|In summary|Here(?:'s| is) (?:what|a summary)|All set|The (?:fix|change|update)s? (?:is|are|has|have)\b|This (?:change|update|fix)\b|You(?:'re| are) all set)/i;

// ---- control groups ---------------------------------------------------------------------------------
// A small share of sessions (config `holdout`, default 10%, 0 turns it off) runs with ONE feature off,
// so its effect can be measured against real metered usage. Pure function of the session id.
export function arm(sid, cfg = {}) {
  const pct = cfg.holdout ?? 10;
  if (!pct || !sid || sid === 'none') return null;
  const h = crypto.createHash('sha1').update(String(sid)).digest();
  return h.readUInt16BE(0) % 100 < pct ? FEATURES[h.readUInt16BE(2) % FEATURES.length] : null;
}
export const held = (input, cfg, feature) => arm(sidOf(input), cfg) === feature;

// ---- transcript reading -------------------------------------------------------------------------------
export function readNew(file, off) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return { entries: [], off }; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < off) off = 0;                       // transcript rewritten
    if (size - off > 64 * 2 ** 20) off = size - 64 * 2 ** 20;
    const buf = Buffer.alloc(size - off); fs.readSync(fd, buf, 0, buf.length, off);
    const text = buf.toString('utf8'), last = text.lastIndexOf('\n');
    if (last < 0) return { entries: [], off };
    const entries = [];
    for (const l of text.slice(0, last).split('\n')) { if (!l) continue; try { entries.push(JSON.parse(l)); } catch {} }
    return { entries, off: off + Buffer.byteLength(text.slice(0, last + 1)) };
  } finally { fs.closeSync(fd); }
}
const blocks = (m) => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);
const isPromptEntry = (d) => d.type === 'user' && !d.isMeta && !d.isCompactSummary && blocks(d.message).some((b) => b.type === 'text') && !blocks(d.message).some((b) => b.type === 'tool_result');
export const narration = (text) => text.split(/\n+|(?<=[.!?])\s+/).filter((s) => NARR.test(s.trim())).reduce((a, s) => a + tokens(s), 0);

const fresh = () => ({ off: 0, ids: [], lastAt: 0, lastCtx: 0, model: '', task: null, tools: {}, gcAt: 0 });
const newTask = (prompt, at, a) => ({ w: keywords(prompt).slice(0, 12), q: String(prompt).slice(0, 300), at, tok: 0, cost: 0, turns: 0, reads: [], reqs: 0, text: '', arm: a, warned: 0 });

function closeTask(root, t) {
  if (!t || !t.turns) return;
  mkdirp(tbDir(root));
  fs.appendFileSync(tasksPath(root), JSON.stringify({ w: t.w, tok: t.tok, cost: +t.cost.toFixed(5), turns: t.turns, arm: t.arm || null, at: t.at }) + '\n');
}

// Scan what's new in the transcript. Returns the session state plus what this scan saw.
export function scan(root, input, cfg = {}) {
  const sid = sidOf(input), p = statePath(root, sid);
  const s = { ...fresh(), ...readJSON(p, {}) };
  if (!input.transcript_path) return { s, saw: null };
  try { writeJSON(path.join(tbDir(root), 'state', 'last-transcript.json'), { path: input.transcript_path, sid, at: Date.now() }); } catch {}
  const { entries, off } = readNew(input.transcript_path, s.off);
  s.off = off;
  const g = readJSON(globalPath(root), { narr: 0, text: 0, ttl: 5, breaks: 0, perms: {}, mcp: {} });
  const saw = { in: 0, cr: 0, cw: 0, out: 0, cost: 0, narr: 0, text: 0, breaks: [], replies: 0 };
  const ids = new Set(s.ids), useIds = {};
  for (const d of entries) {
    const at = Date.parse(d.timestamp || '') || 0;
    if (isPromptEntry(d)) {
      closeTask(root, s.task);
      s.task = newTask(blocks(d.message).filter((b) => b.type === 'text').map((b) => b.text).join(' '), at, arm(sid, cfg));
      continue;
    }
    if (d.type === 'user') {
      for (const b of blocks(d.message)) if (b.type === 'tool_result') {
        const u = useIds[b.tool_use_id];
        if (u?.name === 'Bash' && b.is_error && /doesn't want to proceed|was rejected|denied/i.test(JSON.stringify(b.content || ''))) { const k = permKey(u.input?.command); if (k) (g.perms[k] ||= { n: 0, denied: 0 }).denied++; }
      }
      continue;
    }
    if (d.type !== 'assistant') continue;
    const m = d.message || {};
    for (const b of blocks(m)) {
      if (b.type === 'text') { const n = tokens(b.text || ''); saw.text += n; saw.narr += narration(b.text || ''); if (s.task) s.task.text = String(b.text).slice(-800); }
      if (b.type === 'tool_use') {
        useIds[b.id] = b;
        const name = String(b.name || '');
        if (name.startsWith('mcp__')) { const srv = name.split('__')[1]; (g.mcp[srv] ||= { calls: 0, at: 0 }).calls++; g.mcp[srv].at = at; }
        if (name === 'Bash') { const k = permKey(b.input?.command); if (k) (g.perms[k] ||= { n: 0, denied: 0 }).n++; }
        if (s.task && /^(Read|Grep|Glob)$/.test(name)) { s.task.reqs++; const f = b.input?.file_path; if (f && s.task.reads.length < 12 && !s.task.reads.includes(f)) s.task.reads.push(f); }
      }
    }
    const id = m.id || d.requestId, u = m.usage;
    if (!u || !id || ids.has(id)) continue;
    ids.add(id);
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const c = cost(u, m.model);
    saw.in += u.input_tokens || 0; saw.cr += u.cache_read_input_tokens || 0; saw.cw += u.cache_creation_input_tokens || 0; saw.out += u.output_tokens || 0; saw.cost += c; saw.replies++;
    // Cache Keeper: a big cache write right after a cached reply means the cache was rebuilt.
    const gap = s.lastAt && at ? (at - s.lastAt) / 60000 : 0;
    if (s.lastCtx > 20000 && (u.cache_creation_input_tokens || 0) > s.lastCtx * 0.5) saw.breaks.push({ tok: u.cache_creation_input_tokens, idle: Math.round(gap), model: m.model });
    else if (gap > g.ttl && (u.cache_read_input_tokens || 0) > s.lastCtx * 0.5) g.ttl = Math.min(60, Math.floor(gap));   // cache outlived the gap: learn
    if (s.task) { s.task.tok += ctx + (u.output_tokens || 0); s.task.cost += c; s.task.turns++; }
    s.lastAt = at || s.lastAt; s.lastCtx = ctx; s.model = m.model || s.model;
  }
  s.ids = [...ids].slice(-300);
  g.narr = g.narr * 0.97 + saw.narr; g.text = g.text * 0.97 + saw.text; g.breaks += saw.breaks.length;
  writeJSON(globalPath(root), g); writeJSON(p, s);
  if (saw.replies) appendLedger(root, { ev: 'meter', in: saw.in, cr: saw.cr, cw: saw.cw, out: saw.out, usd: +saw.cost.toFixed(6), narr: saw.narr, text: saw.text });
  for (const b of saw.breaks) appendLedger(root, { ev: 'cache_break', tok: b.tok, idle: b.idle });
  return { s, saw, g };
}
export const saveState = (root, input, s) => writeJSON(statePath(root, sidOf(input)), s);
export const loadState = (root, input) => ({ ...fresh(), ...readJSON(statePath(root, sidOf(input)), {}) });
export const globalStats = (root) => readJSON(globalPath(root), { narr: 0, text: 0, ttl: 5, breaks: 0, perms: {}, mcp: {} });

// ---- Permission Learner key: the command's leading words, as an allow-rule prefix --------------------
export function permKey(cmd) {
  const c = String(cmd || '').trim().replace(/^(?:\w+=\S+\s+)+/, '');
  if (!c || /[|;&`$<>]/.test(c.split(/\s+/).slice(0, 3).join(' '))) return null;
  const w = c.split(/\s+/);
  const two = w[1] && !w[1].startsWith('-') && /^[\w:.@/-]+$/.test(w[1]) && /^(npm|pnpm|yarn|bun|npx|git|go|cargo|python3?|pip|make|docker|uv|poetry|node|deno|dotnet|mvn|gradle|bundle|rails|php|composer|kubectl|terraform)$/.test(w[0]);
  return two ? `${w[0]} ${w[1]}` : w[0];
}

// ---- Task Budget Forecast -----------------------------------------------------------------------------
export function history(root, n = 600) {
  try { return fs.readFileSync(tasksPath(root), 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
export function forecast(root, prompt) {
  const w = new Set(keywords(prompt));
  if (w.size < 2) return null;
  const sim = history(root).filter((t) => t.turns && !t.arm).map((t) => { const x = t.w.filter((k) => w.has(k)).length; return [x / (w.size + t.w.length - x), t]; }).filter(([j]) => j >= 0.25);
  if (sim.length < 3) return null;
  return { tok: median(sim.map(([, t]) => t.tok)), cost: median(sim.map(([, t]) => t.cost)), turns: median(sim.map(([, t]) => t.turns)), n: sim.length };
}

// ---- Proof: control vs treated tasks, per feature -------------------------------------------------------
export function proof(root) {
  const h = history(root, 5000).filter((t) => t.turns);
  const on = h.filter((t) => !t.arm);
  return FEATURES.map((f) => {
    const off = h.filter((t) => t.arm === f);
    const r = { feature: f, nOff: off.length, nOn: on.length };
    if (off.length < 15 || on.length < 30) return r;
    const a = median(off.map((t) => t.tok)), b = median(on.map((t) => t.tok));
    return { ...r, tokOff: a, tokOn: b, turnsOff: median(off.map((t) => t.turns)), turnsOn: median(on.map((t) => t.turns)), cut: a ? (a - b) / a : 0 };
  });
}
