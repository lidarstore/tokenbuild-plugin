// Waste Audit: reads local Claude Code session logs, prices avoidable waste. Zero tokens, zero network.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tokens, isJunk, usd, num } from './util.mjs';
import { rates, cost } from './prices.mjs';
import { shrink, isNoisy } from './shrink.mjs';

const OVERSIZED = 6000; // a Read returning more than this many tokens is "oversized"
const KEEP = 2000;      // ...of which this much is assumed useful
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH = new Set(['Grep', 'Glob', 'LS']);

export function logDirs() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = path.join(base, 'projects');
  try { return fs.readdirSync(root).map((d) => path.join(root, d)); } catch { return []; }
}

const resultText = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? 'x'.repeat(6000) : '')).join('') : '';

// "claude-opus-5-5-20261001" -> "opus-5-5"
export const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/^<synthetic>$/, '');

export function auditSession(lines) {
  const usageById = new Map(); // dedupe streamed duplicates by message id
  const turns = [];            // assistant message ids in order
  const uses = new Map();      // tool_use id -> {name, input, turn}
  const events = [];           // {kind, tok, turn, file}
  const lastRead = new Map();  // file -> key of last read
  let compactions = 0, model = '';
  const segmentEnds = [];      // turn indexes where context resets

  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'system' && /compact/.test(d.subtype || '') || d.isCompactSummary) {
      compactions++; segmentEnds.push(turns.length); lastRead.clear(); continue;
    }
    const m = d.message;
    if (!m || typeof m !== 'object') continue;
    if (d.type === 'assistant') {
      const id = m.id || d.uuid;
      if (!usageById.has(id)) turns.push(id);
      if (m.usage) usageById.set(id, { usage: m.usage, model: m.model });
      if (m.model) model = m.model;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_use') continue;
        uses.set(b.id, { name: b.name, input: b.input || {}, turn: turns.length - 1 });
        if (WRITES.has(b.name) && b.input?.file_path) lastRead.delete(b.input.file_path);
      }
    } else if (d.type === 'user') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_result') continue;
        const u = uses.get(b.tool_use_id); if (!u) continue;
        const tok = tokens(resultText(b.content));
        const f = u.input.file_path || u.input.path || '';
        if (u.name === 'Read') {
          const key = `${u.input.offset || 0}:${u.input.limit || 0}`;
          if (f && isJunk(f)) events.push({ kind: 'junk', tok, turn: u.turn, file: f });
          else if (f && lastRead.get(f) === key) events.push({ kind: 'reread', tok, turn: u.turn, file: f });
          else if (tok > OVERSIZED && !u.input.limit) events.push({ kind: 'oversized', tok: tok - KEEP, turn: u.turn, file: f });
          if (f) lastRead.set(f, key);
        } else if (u.name === 'Bash' && tok > 600 && isNoisy(u.input.command)) {
          // Measured, not estimated: run the real shrinker on the logged output.
          const saved = tok - tokens(shrink(resultText(b.content)).text) - 40;
          if (saved > 0) events.push({ kind: 'logs', tok: saved, turn: u.turn, file: '$ ' + String(u.input.command).slice(0, 48) });
        } else if (SEARCH.has(u.name)) {
          events.push({ kind: 'search', tok, turn: u.turn });
          if (tok > OVERSIZED) events.push({ kind: 'oversized', tok: tok - KEEP, turn: u.turn, file: u.input.pattern || '' });
        }
      }
    }
  }

  // Tokens added to context are re-sent (cached) on every later turn until a compaction.
  const r = rates(model);
  const carry = (turn) => { const end = segmentEnds.find((e) => e > turn) ?? turns.length; return Math.max(0, end - turn - 1); };
  const waste = { junk: 0, reread: 0, oversized: 0, logs: 0 }, wasteUsd = { junk: 0, reread: 0, oversized: 0, logs: 0 };
  let searchTok = 0; const files = new Map();
  for (const e of events) {
    if (e.kind === 'search') { searchTok += e.tok; continue; }
    const c = e.tok * (r.cacheWrite + carry(e.turn) * r.cacheRead) / 1e6;
    waste[e.kind] += e.tok; wasteUsd[e.kind] += c;
    if (e.file) files.set(e.file, (files.get(e.file) || 0) + c);
  }
  let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0, spend = 0; const byModel = new Map();
  for (const { usage, model: mm } of usageById.values()) {
    inTok += usage.input_tokens || 0; outTok += usage.output_tokens || 0;
    cacheRead += usage.cache_read_input_tokens || 0; cacheWrite += usage.cache_creation_input_tokens || 0;
    const c = cost(usage, mm || model); spend += c;
    const name = shortModel(mm || model); if (name) byModel.set(name, (byModel.get(name) || 0) + c);
  }
  return { turns: turns.length, compactions, model, inTok, outTok, cacheRead, cacheWrite, spend, waste, wasteUsd, searchTok, files, byModel };
}

export function audit({ days = 30, project = '' } = {}) {
  const since = Date.now() - days * 864e5;
  const total = { sessions: 0, turns: 0, compactions: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, spend: 0, searchTok: 0,
    waste: { junk: 0, reread: 0, oversized: 0, logs: 0 }, wasteUsd: { junk: 0, reread: 0, oversized: 0, logs: 0 }, files: new Map(), byModel: new Map() };
  for (const dir of logDirs()) {
    if (project && !dir.toLowerCase().includes(project.toLowerCase())) continue;
    let names; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).mtimeMs < since) continue; } catch { continue; }
      const s = auditSession(fs.readFileSync(p, 'utf8').split('\n'));
      if (!s.turns) continue;
      total.sessions++;
      for (const k of ['turns', 'compactions', 'inTok', 'outTok', 'cacheRead', 'cacheWrite', 'spend', 'searchTok']) total[k] += s[k];
      for (const k in s.waste) { total.waste[k] += s.waste[k]; total.wasteUsd[k] += s.wasteUsd[k]; }
      for (const [f, c] of s.files) total.files.set(f, (total.files.get(f) || 0) + c);
      for (const [m, c] of s.byModel) total.byModel.set(m, (total.byModel.get(m) || 0) + c);
    }
  }
  return total;
}

export function report(t, days) {
  if (!t.sessions) return `No Claude Code sessions found in the last ${days} days.\nLooked in ${path.join(process.env.CLAUDE_CONFIG_DIR || '~/.claude', 'projects')}.`;
  const w = Object.values(t.wasteUsd).reduce((a, b) => a + b, 0);
  const input = t.inTok + t.cacheRead + t.cacheWrite;
  const hit = input ? (t.cacheRead / input) * 100 : 0;
  const top = [...t.files].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const L = [
    `TokenBuild Waste Audit — last ${days} days`,
    `${t.sessions} sessions, ${num(t.turns)} turns, ${num(input + t.outTok)} tokens, ~${usd(t.spend)} at API list price`,
    `Cache hit rate ${hit.toFixed(0)}%  ·  compactions ${t.compactions}  ·  search results ${num(t.searchTok)} tokens`,
    '',
    `Avoidable waste: ~${usd(w)} (${t.spend ? ((w / t.spend) * 100).toFixed(1) : 0}% of spend)`,
    `  junk files read     ${num(t.waste.junk).padStart(7)} tok  ${usd(t.wasteUsd.junk)}`,
    `  unchanged re-reads  ${num(t.waste.reread).padStart(7)} tok  ${usd(t.wasteUsd.reread)}`,
    `  oversized results   ${num(t.waste.oversized).padStart(7)} tok  ${usd(t.wasteUsd.oversized)}`,
    `  noisy command logs  ${num(t.waste.logs).padStart(7)} tok  ${usd(t.wasteUsd.logs)}`,
  ];
  const models = [...t.byModel].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (models.length) L.push('', `Spend by model: ${models.map(([m, c]) => `${m} ${((c / t.spend) * 100).toFixed(0)}%`).join(' · ')}`);
  if (top.length) L.push('', 'Costliest files:', ...top.map(([f, c]) => `  ${usd(c).padStart(7)}  ${f}`));
  L.push('', 'Cost counts each wasted token on every later turn it stayed in context.',
    'Fix most of it automatically: npx tokenbuild init');
  return L.join('\n');
}
