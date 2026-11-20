// Anchor Edits (tb_edit): replace lines start..end with new text, without Claude writing the old text
// back out. Safe because the Context Ledger holds exactly what Claude saw of those lines this session:
// the edit only applies if they are unchanged since. Saves the output tokens of every old_string.
// Codemod Mode (tb_apply): one find/replace across many files, applied locally, with a compact diff.
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, readJSON, writeJSON, tokens, appendLedger } from './util.mjs';
import { isJunk } from './util.mjs';
import * as ctx from './ctx.mjs';
import * as task from './task.mjs';

// The session whose Context Ledger has seen `rel` most recently (the MCP server has no session id).
function sessionFor(root, rel) {
  const dir = path.join(tbDir(root), 'state');
  let best = null;
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((x) => /^ctx-.+\.json$/.test(x))) {
    const p = path.join(dir, f), m = fs.statSync(p).mtimeMs;
    if ((!best || m > best.m) && readJSON(p, { files: {} }).files?.[rel]) best = { sid: f.slice(4, -5), m };
  }
  return best?.sid || null;
}

const after = (root, sid, rel) => {
  try { task.edited(root, rel); } catch {}
  try { const fp = path.join(tbDir(root), 'state', `fmt-${sid}.json`), s = readJSON(fp, { files: [] }); const abs = path.join(root, rel); if (!s.files.includes(abs)) { s.files.push(abs); writeJSON(fp, s); } } catch {}
};

export async function anchorEdit(root, { file, start, end, text }, { schedule } = {}) {
  const rel = path.relative(root, path.resolve(root, String(file || '')));
  const a = Number(start), b = Number(end ?? start);
  if (!rel || rel.startsWith('..')) return { error: 'file must be inside this project.' };
  if (!(a >= 1 && b >= a - 1)) return { error: 'start/end must be 1-based line numbers, end >= start (end = start - 1 inserts before start).' };
  const sid = sessionFor(root, rel);
  const s = sid && ctx.load(root, sid), e = s?.files?.[rel];
  if (!e?.ok) return { error: `Read ${rel} (at least lines ${a}-${Math.max(a, b)}) first: tb_edit only edits lines you have seen this session.` };
  if (b >= a && !e.ranges.some(([x, y]) => x <= a && y >= b)) return { error: `You haven't read lines ${a}-${b} of ${rel} this session. Read them first.` };
  const abs = path.join(root, rel);
  let cur; try { cur = fs.readFileSync(abs, 'utf8'); } catch { return { error: `${rel} not found.` }; }
  let seen; try { seen = fs.readFileSync(ctx.snapPath(root, sid, rel), 'utf8'); } catch { return { error: `Read ${rel} again first.` }; }
  const L = cur.split('\n'), S = seen.split('\n');
  if (b > L.length) return { error: `${rel} has ${L.length} lines.` };
  if (L.slice(a - 1, b).join('\n') !== S.slice(a - 1, b).join('\n')) {
    const show = L.slice(a - 1, Math.min(b, a + 29)).map((l, i) => `${a + i}: ${l}`).join('\n');
    return { error: `Lines ${a}-${b} of ${rel} changed since you read them. Current lines:\n${show}` };
  }
  const oldText = L.slice(a - 1, b).join('\n');
  const neu = String(text ?? '') === '' ? [] : String(text).replace(/\n$/, '').split('\n');
  L.splice(a - 1, b - a + 1, ...neu);
  const next = L.join('\n');
  // Same safety net as Edit Preflight.
  const { check } = await import('./preflight.mjs');
  const err = check(abs, next);
  if (err && !check(abs, cur)) return { error: `Not applied: ${rel} would have a syntax error${err.line ? ` at line ${err.line}` : ''}: ${err.msg}` };
  fs.writeFileSync(abs, next);
  ctx.snap(root, sid, rel, next);
  e.sig = ctx.sigOf(fs.statSync(abs)); e.anchored = true;
  writeJSON(ctx.statePath(root, sid), s);
  const saved = tokens(oldText);
  appendLedger(root, { ev: 'anchor', tok: saved });
  after(root, sid, rel);
  try { schedule?.(root, sid, rel); } catch {}
  const shift = neu.length - (b - a + 1);
  return { ok: true, text: `Edited ${rel}: lines ${a}-${b} → ${a}-${a + neu.length - 1}${shift ? ` (lines below moved ${shift > 0 ? '+' : ''}${shift})` : ''}. Keep using tb_edit for ${rel} this session; the built-in Edit would need a fresh Read.` };
}

// ---- Codemod Mode ------------------------------------------------------------------------------------
const globRe = (g) => new RegExp('^' + g.split('**').map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
function files(root, scope) {
  const idx = readJSON(path.join(tbDir(root), 'index.json'), null);
  let list = idx ? Object.keys(idx.files) : [];
  if (!list.length) {
    const walk = (d, out = []) => { for (const n of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = d ? `${d}/${n.name}` : n.name; if (n.name.startsWith('.') || isJunk(r)) continue; if (n.isDirectory()) { if (out.length < 5000) walk(r, out); } else out.push(r); } return out; };
    list = walk('');
  }
  if (scope?.length) { const res = scope.map((g) => (/[*]/.test(g) ? globRe(g) : null)); list = list.filter((f) => scope.some((g, i) => (res[i] ? res[i].test(f) : f === g || f.startsWith(g.replace(/\/$/, '') + '/')))); }
  return list.filter((f) => !isJunk(f)).slice(0, 5000);
}

export function codemod(root, { find, replace = '', regex = false, files: scope, dry = false }, { schedule } = {}) {
  if (!find) return { error: 'find is required.' };
  let re; try { re = regex ? new RegExp(find, 'g') : new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (e) { return { error: `Bad regex: ${e.message}` }; }
  const changed = [], previews = [];
  let total = 0;
  for (const rel of files(root, Array.isArray(scope) ? scope : scope ? [scope] : null)) {
    const abs = path.join(root, rel);
    let t; try { if (fs.statSync(abs).size > 1e6) continue; t = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    re.lastIndex = 0;
    if (!re.test(t)) continue;
    re.lastIndex = 0;
    let n = 0;
    const next = t.replace(re, (...m) => { n++; if (previews.length < 3) { const line = t.slice(0, m[m.length - 2]).split('\n').length; previews.push(`${rel}:${line}  - ${m[0].slice(0, 80)}  + ${(regex ? m[0].replace(new RegExp(find), replace) : replace).slice(0, 80)}`); } return regex ? m[0].replace(new RegExp(find), replace) : replace; });
    if (next === t) continue;
    total += n; changed.push([rel, n]);
    if (!dry) { fs.writeFileSync(abs, next); after(root, 'mcp', rel); try { if (changed.length <= 8) schedule?.(root, 'mcp', rel); } catch {} }
  }
  if (!changed.length) return { ok: true, text: `No matches for ${regex ? '/' + find + '/' : JSON.stringify(find)}.` };
  if (!dry) appendLedger(root, { ev: 'codemod', files: changed.length, n: total });
  const list = changed.slice(0, 12).map(([f, n]) => `${f} (${n})`).join(', ') + (changed.length > 12 ? `, +${changed.length - 12} more` : '');
  return { ok: true, text: `${dry ? 'Would change' : 'Changed'} ${total} occurrence${total > 1 ? 's' : ''} in ${changed.length} file${changed.length > 1 ? 's' : ''}: ${list}\n${previews.join('\n')}${dry ? '' : '\nFiles you had read now differ: a re-read returns only the changed lines.'}` };
}

// Post hook: the same small change made in 3+ files is a codemod waiting to happen.
export function core(oldS, newS) {
  let p = 0; while (p < oldS.length && p < newS.length && oldS[p] === newS[p]) p++;
  let q = 0; while (q < oldS.length - p && q < newS.length - p && oldS[oldS.length - 1 - q] === newS[newS.length - 1 - q]) q++;
  while (p > 0 && /\w/.test(oldS[p - 1])) p--;                           // widen to whole identifiers
  while (q > 0 && /\w/.test(oldS[oldS.length - q])) q--;
  const rem = oldS.slice(p, oldS.length - q), add = newS.slice(p, newS.length - q);
  return rem.trim() && rem.length <= 80 && add.length <= 120 && !rem.includes('\n') ? [rem, add] : null;
}
