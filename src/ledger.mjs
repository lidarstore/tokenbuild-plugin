// Turns ledger events (.tokenbuild/ledger.jsonl) into counters. Counts only: what `sync` sends.
const EMPTY = () => ({ blocks: 0, tok_blocked: 0, tool_calls: 0, shrinks: 0, tok_shrunk: 0, formats: 0, local_calls: 0, tok_local: 0, loops: 0, handoffs: 0, tok_handoff: 0, recalls: 0, dedups: 0, tok_dedup: 0, verifies: 0, verify_fails: 0, briefs: 0, predicts: 0, predict_hits: 0, fp_hits: 0 });

function add(c, e) {
  const tok = Math.max(0, Math.floor(e.tok || 0));
  if (e.ev === 'block') { c.blocks++; c.tok_blocked += tok; }
  else if (e.ev === 'tool') c.tool_calls++;
  else if (e.ev === 'shrink') { c.shrinks++; c.tok_shrunk += tok; }
  else if (e.ev === 'format') c.formats += e.n || 1;
  else if (e.ev === 'local') { c.local_calls++; c.tok_local += tok; }
  else if (e.ev === 'loop') c.loops++;
  else if (e.ev === 'recall') c.recalls++;
  else if (e.ev === 'dedup') { c.dedups++; c.tok_dedup += tok; }
  else if (e.ev === 'verify') { c.verifies++; if (!e.ok) c.verify_fails++; }
  else if (e.ev === 'brief') c.briefs++;
  else if (e.ev === 'predict') c.predicts++;
  else if (e.ev === 'predict_hit') c.predict_hits++;
  else if (e.ev === 'fp_hit') c.fp_hits++;
  // Claude asked again for what we held back: it was not a saving after all.
  else if (e.ev === 'undo') { if (e.of === 'dedup') { c.dedups = Math.max(0, c.dedups - 1); c.tok_dedup = Math.max(0, c.tok_dedup - tok); } else if (e.of === 'block') { c.blocks = Math.max(0, c.blocks - 1); c.tok_blocked = Math.max(0, c.tok_blocked - tok); } }
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
