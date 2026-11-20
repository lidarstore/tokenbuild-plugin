// Context Profiler: what fills Claude's context window right now (since the last compaction), by source,
// and how much of it is dead weight: old command output nothing later used, files no later step touched.
// Context GC (Stop hook) uses it to offer a clean restart when most of a big context is dead.
import fs from 'node:fs';
import path from 'node:path';
import { tokens, tbDir, readJSON } from './util.mjs';

const RECENT = 6;                // replies: anything this recent is live
const cat = (name) => name === 'Read' ? 'files read' : name === 'Bash' ? 'command output' : /^(Grep|Glob|LS)$/.test(name) ? 'search results'
  : name.startsWith('mcp__') ? 'MCP tool results' : name === 'Task' ? 'subagent results' : /^(WebFetch|WebSearch)$/.test(name) ? 'web results' : 'other tool results';
const str = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? ' '.repeat(6000) : '')).join('\n') : JSON.stringify(c || ''));
const blocks = (m) => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);

export function readTranscript(file, max = 24 * 2 ** 20) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, max), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const out = [];
    for (const l of buf.toString('utf8').split('\n')) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } finally { fs.closeSync(fd); }
}

export function profile(entries, root = '') {
  // Only what's in context now: everything after the last compaction.
  let start = 0;
  entries.forEach((d, i) => { if (d.type === 'summary' || d.isCompactSummary || (d.type === 'system' && /compact/i.test(d.subtype || ''))) start = i; });
  const live = entries.slice(start);
  const uses = {}, items = [], refs = [];   // refs[i] = text of Claude's calls/text at reply i
  let reply = 0, firstCtx = 0, lastCtx = 0, before = 0;
  const seen = new Set();
  for (const d of live) {
    const m = d.message;
    if (d.type === 'assistant') {
      const id = m?.id || d.requestId;
      if (!seen.has(id)) { seen.add(id); reply++; const u = m?.usage; if (u) { lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); if (!firstCtx) firstCtx = lastCtx - before; } }
      for (const b of blocks(m)) {
        if (b.type === 'text') { const t = tokens(b.text || ''); items.push({ c: "Claude's replies", t, at: reply, live: true }); before += t; (refs[reply] ||= []).push(b.text || ''); }
        if (b.type === 'tool_use') { uses[b.id] = b; const j = JSON.stringify(b.input || {}); const t = tokens(j); items.push({ c: "Claude's edits and calls", t, at: reply, live: true }); before += t; (refs[reply] ||= []).push(j); }
      }
    } else if (d.type === 'user') {
      for (const b of blocks(m)) {
        if (b.type === 'tool_result') {
          const u = uses[b.tool_use_id] || {}, name = String(u.name || 'tool'), t = tokens(str(b.content));
          const label = name === 'Read' ? path.relative(root || '/', u.input?.file_path || '') : name === 'Bash' ? String(u.input?.command || '').slice(0, 60) : name;
          items.push({ c: cat(name), t, at: reply, label, file: name === 'Read' ? u.input?.file_path : null }); before += t;
        } else if (b.type === 'text' && !d.isMeta) { const t = tokens(b.text || ''); items.push({ c: 'your prompts', t, at: reply, live: true }); before += t; }
      }
    }
  }
  // Dead weight: tool output older than RECENT replies that nothing since refers to.
  const laterText = (from) => refs.slice(from + 1).flat().join('\n');
  for (const it of items) {
    if (it.live || reply - it.at < RECENT) { it.live = true; continue; }
    if (it.file) { const base = path.basename(it.file); it.live = laterText(it.at).includes(base); }
    else it.live = false;
  }
  const by = {};
  for (const it of items) { const b = (by[it.c] ||= { t: 0, dead: 0 }); b.t += it.t; if (!it.live) b.dead += it.t; }
  const fixed = Math.max(0, firstCtx);
  const total = lastCtx || fixed + items.reduce((a, x) => a + x.t, 0);
  const dead = items.filter((x) => !x.live).reduce((a, x) => a + x.t, 0);
  const top = items.filter((x) => !x.live && x.t > 300).sort((a, b) => b.t - a.t).slice(0, 5);
  return { total, fixed, by, dead, deadShare: total ? dead / total : 0, top, replies: reply };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
export function render(p) {
  if (!p.total) return 'No context to profile yet.';
  const rows = [['system prompt, tools & CLAUDE.md', p.fixed, 0], ...Object.entries(p.by).map(([c, v]) => [c, v.t, v.dead])].filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
  const L = [`Context now: ~${k(p.total)} tokens, re-sent with every reply. Dead weight: ~${k(p.dead)} (${Math.round(p.deadShare * 100)}%).`];
  for (const [c, t, d] of rows) L.push(`  ${c.padEnd(34)} ${k(t).padStart(6)}  ${Math.round((t / p.total) * 100)}%${d ? `  (${k(d)} dead)` : ''}`);
  if (p.top.length) { L.push('Biggest dead items:'); for (const x of p.top) L.push(`  ${k(x.t).padStart(6)}  ${x.c}: ${x.label || ''}`); }
  return L.join('\n');
}

export function lastTranscript(root) { return readJSON(path.join(tbDir(root), 'state', 'last-transcript.json'), null)?.path || null; }
