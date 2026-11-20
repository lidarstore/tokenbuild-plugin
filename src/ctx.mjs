// Context ledger: models what is already in Claude's context window this session, by file region and
// content. A re-read of an unchanged region is answered with "already in your context"; a re-read of a
// region that changed underneath Claude (user, formatter, git) is answered with only the changed lines.
// Claude's own edits refresh the snapshot, so they never count as changes. Reset at compaction/new session.
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, readJSON, writeJSON, mkdirp, hash, tokens, appendLedger } from './util.mjs';
import { diffLines, formatHunks } from './diff.mjs';

export const DEFAULT_LIMIT = 2000;          // Claude Code's Read default line count
const MAX_SNAP = 400_000;
const sidOf = (input) => String(input.session_id || 'none').replace(/[^\w-]/g, '');
export const statePath = (root, sid) => path.join(tbDir(root), 'state', `ctx-${sid}.json`);
export const snapPath = (root, sid, rel) => path.join(tbDir(root), 'state', 'snap', sid, hash(rel));
export const load = (root, sid) => readJSON(statePath(root, sid), { turn: 0, files: {}, blocked: {} });
const covered = (ranges, a, b) => ranges.some(([x, y]) => x <= a && y >= b);
export const sigOf = (st) => `${st.mtimeMs}:${st.size}`;

export function snap(root, sid, rel, text) {
  if (text.length > MAX_SNAP) return false;
  const p = snapPath(root, sid, rel); mkdirp(path.dirname(p)); fs.writeFileSync(p, text); return true;
}
const regionTok = (lines, a, b) => tokens(lines.slice(a - 1, b).join('\n'));

// PreToolUse Read. Returns null (allow) or { reason, tok, ev } (answer instead of the read).
export function onRead(input, root, f, rel, { dry = false } = {}) {
  const ti = input.tool_input || {}, sid = sidOf(input);
  const a = Math.max(1, Number(ti.offset) || 1), b = a + (Number(ti.limit) || DEFAULT_LIMIT) - 1;
  let stat; try { stat = fs.statSync(f); } catch { return null; }
  const s = load(root, sid), save = () => writeJSON(statePath(root, sid), s);
  const sig = sigOf(stat), e = s.files[rel], key = `${rel}|${a}|${b}`;
  // Second identical request right after we answered it: Claude really wants the text. Allow, and take back the saving.
  if (s.blocked[key]) { appendLedger(root, { ev: 'undo', of: 'dedup', tok: s.blocked[key] }); delete s.blocked[key]; if (e) { e.sig = sig; e.ranges.push([a, b, s.turn]); } save(); return null; }
  const record = (text) => { const ok = snap(root, sid, rel, text); s.files[rel] = { sig, turn: s.turn, ranges: [[a, b, s.turn]], ok }; save(); };
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
  if (!e || !e.ok) { record(text); return null; }
  if (e.anchored) { delete e.anchored; e.sig = sig; e.ranges.push([a, b, s.turn]); save(); return null; }
  const lines = text.split('\n'), end = Math.min(b, lines.length), full = regionTok(lines, a, end);
  const when = e.ranges.filter(([x, y]) => x <= a && y >= end).map((r) => r[2]).pop() ?? e.turn;
  const answer = (reason) => { const tok = Math.max(0, full - tokens(reason)); if (tok < 50 || dry) { save(); return null; } s.blocked[key] = tok; save(); return { reason, tok, ev: 'dedup' }; };
  if (e.sig === sig) {
    if (covered(e.ranges, a, end)) return answer(`TokenBuild context ledger: ${rel} lines ${a}-${end} are unchanged since you read them${when ? ` at turn ${when}` : ''}, so they are already in your context. Retry the same Read only if they were compacted away.`);
    e.ranges.push([a, b, s.turn]); save(); return null;
  }
  // Changed underneath Claude: send only what changed, if that is clearly smaller than the region.
  let old; try { old = fs.readFileSync(snapPath(root, sid, rel), 'utf8'); } catch { record(text); return null; }
  const hunks = diffLines(old.split('\n'), lines);
  const was = covered(e.ranges, a, end);
  e.sig = sig; e.ok = snap(root, sid, rel, text);
  if (!hunks || !was) { e.ranges = [...(was ? e.ranges : []), [a, b, s.turn]]; save(); return null; }
  const inRegion = hunks.filter((h) => h.at <= end && h.at + Math.max(h.add.length, 1) - 1 >= a);
  if (!inRegion.length) return answer(`TokenBuild context ledger: ${rel} changed elsewhere, but lines ${a}-${end} are unchanged since you read them${when ? ` at turn ${when}` : ''}. They are already in your context.`);
  const d = formatHunks(inRegion);
  if (!d || tokens(d) * 2 > full) { save(); return null; }
  return answer(`TokenBuild context ledger: ${rel} changed since you read it${when ? ` at turn ${when}` : ''} (not by your edits). Only the changes, with current line numbers:\n${d}\nThe rest of lines ${a}-${end} is as you read it. Retry the same Read for the full text.`);
}

// PostToolUse Edit/Write: Claude knows its own change, so the snapshot follows it.
export function onEdit(input, root, f, rel) {
  const sid = sidOf(input), s = load(root, sid), e = s.files[rel];
  if (!e) return;
  try { const text = fs.readFileSync(f, 'utf8'); e.sig = sigOf(fs.statSync(f)); e.ok = snap(root, sid, rel, text); } catch { delete s.files[rel]; }
  writeJSON(statePath(root, sid), s);
}

export function turn(input, root) { const sid = sidOf(input), s = load(root, sid); s.turn++; writeJSON(statePath(root, sid), s); return s.turn; }

export function reset(input, root) {
  const sid = sidOf(input);
  try { fs.rmSync(statePath(root, sid)); } catch {}
  try { fs.rmSync(path.join(tbDir(root), 'state', 'snap', sid), { recursive: true }); } catch {}
}
