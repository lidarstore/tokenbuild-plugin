// Turns ledger events (.tokenbuild/ledger.jsonl) into counters. Counts only: what `sync` sends.
const EMPTY = () => ({ blocks: 0, tok_blocked: 0, tool_calls: 0, shrinks: 0, tok_shrunk: 0, formats: 0, local_calls: 0, tok_local: 0, loops: 0, handoffs: 0, tok_handoff: 0, recalls: 0, dedups: 0, tok_dedup: 0, verifies: 0, verify_fails: 0, briefs: 0, predicts: 0, predict_hits: 0, fp_hits: 0, m_in: 0, m_cache_read: 0, m_cache_write: 0, m_out: 0, m_usd_micro: 0, narr_tok: 0, text_tok: 0, cache_breaks: 0, tok_cache_break: 0, preflights: 0, anchors: 0, tok_anchor: 0, codemods: 0, codemod_files: 0, docs: 0, memo_hits: 0, memo_saves: 0, gcs: 0, budget_warns: 0, ck_blocks: 0 });

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
  else if (e.ev === 'meter') { c.m_in += e.in || 0; c.m_cache_read += e.cr || 0; c.m_cache_write += e.cw || 0; c.m_out += e.out || 0; c.m_usd_micro += Math.round((e.usd || 0) * 1e6); c.narr_tok += e.narr || 0; c.text_tok += e.text || 0; }
  else if (e.ev === 'cache_break') { c.cache_breaks++; c.tok_cache_break += tok; }
  else if (e.ev === 'preflight') c.preflights++;
  else if (e.ev === 'anchor') { c.anchors++; c.tok_anchor += tok; }
  else if (e.ev === 'codemod') { c.codemods++; c.codemod_files += e.files || 0; }
  else if (e.ev === 'docs') c.docs++;
  else if (e.ev === 'memo_hit') c.memo_hits += e.n || 1;
  else if (e.ev === 'memo_save') c.memo_saves++;
  else if (e.ev === 'budget_warn') c.budget_warns++;
  else if (e.ev === 'ck_block') c.ck_blocks++;
  else if (e.ev === 'handoff' && e.gc) c.gcs++;
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
