// Turns ledger events (.tokenbuild/ledger.jsonl) into counters. Counts only: what `sync` sends.
const EMPTY = () => ({ blocks: 0, tok_blocked: 0, tool_calls: 0, shrinks: 0, tok_shrunk: 0, formats: 0, local_calls: 0, tok_local: 0, loops: 0, handoffs: 0, tok_handoff: 0, recalls: 0 });

function add(c, e) {
  const tok = Math.max(0, Math.floor(e.tok || 0));
  if (e.ev === 'block') { c.blocks++; c.tok_blocked += tok; }
  else if (e.ev === 'tool') c.tool_calls++;
  else if (e.ev === 'shrink') { c.shrinks++; c.tok_shrunk += tok; }
  else if (e.ev === 'format') c.formats += e.n || 1;
  else if (e.ev === 'local') { c.local_calls++; c.tok_local += tok; }
  else if (e.ev === 'loop') c.loops++;
  else if (e.ev === 'recall') c.recalls++;
  // Counted only when a fresh session actually started from the note: context it no longer re-sends, once.
  else if (e.ev === 'resume') { c.handoffs++; c.tok_handoff += Math.max(0, Math.floor((e.from || 0) - (e.to || 0))); }
}
const parse = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export function tally(lines) { const c = EMPTY(); for (const e of parse(lines)) add(c, e); return c; }

export function byDay(lines) {
  const days = {};
  for (const e of parse(lines)) add((days[new Date(e.t || Date.now()).toISOString().slice(0, 10)] ||= EMPTY()), e);
  return Object.entries(days).map(([day, v]) => ({ day, ...v }));
}
