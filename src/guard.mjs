// Waste Guard: Claude Code PreToolUse hook. Blocks known waste before it enters context.
// Contract: JSON on stdin; exit 2 + stderr message = block (Claude sees the message). Must stay <50 ms.
import fs from 'node:fs';
import path from 'node:path';
import { isJunk, readJSON, writeJSON, tbDir, appendLedger, num } from './util.mjs';
import { isNoisy } from './shrink.mjs';
import { licensed } from './license.mjs';
import * as ctx from './ctx.mjs';

export const MAX_READ_BYTES = 60_000; // ~15K tokens

// True when this repo's Claude Code settings already run TokenBuild hooks from `tokenbuild init`.
// The plugin's hooks then step aside, so nothing runs (or counts) twice.
export function projectHooks(root) {
  for (const f of ['settings.json', 'settings.local.json']) {
    try { if (/tokenbuild[^"\n]*\b(guard|hook)\b/.test(fs.readFileSync(path.join(root, '.claude', f), 'utf8'))) return true; } catch {}
  }
  return false;
}

export function rootOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.tokenbuild')) || fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

// Returns null to allow, or { reason, tok } to block.
export function decide(input, root) {
  const { tool_name: tool, tool_input: ti = {}, session_id: sid = 'none' } = input;
  const statePath = path.join(tbDir(root), 'state', `${String(sid).replace(/[^\w-]/g, '')}.json`);
  const state = readJSON(statePath, { reads: {}, blocked: {} });
  const save = () => writeJSON(statePath, state);
  const abs = (p) => (p && !path.isAbsolute(p) ? path.join(root, p) : p);
  const rel = (p) => path.relative(root, p || '') || p;

  if (tool === 'Read' && ti.file_path) {
    const f = abs(ti.file_path);
    const key = `${f}|${ti.offset || 0}|${ti.limit || 0}`;
    let st; try { st = fs.statSync(f); } catch { return null; }
    const tok = Math.ceil(st.size / 4);
    const once = (k, reason) => { // second identical attempt is allowed: Claude may truly need it; the saving is taken back
      if (state.blocked[k]) { delete state.blocked[k]; save(); appendLedger(root, { ev: 'undo', of: 'block', tok }); return null; }
      state.blocked[k] = 1; save(); return { reason, tok };
    };
    if (isJunk(rel(f))) return once(key, `TokenBuild: ${rel(f)} is generated/vendored (~${num(tok)} tokens). Read the source file or package.json instead. Retry only if you truly need it.`);
    if (st.size > MAX_READ_BYTES && !ti.limit) return once(key, `TokenBuild: ${rel(f)} is ~${num(tok)} tokens. Use tb_find to get line numbers, then Read with offset/limit. Retry to read it all anyway.`);
    return ctx.onRead(input, root, f, rel(f));
  }
  if (tool === 'Bash' && isNoisy(ti.command)) {
    // Once per command per session: point Claude at the shrinker. Claude re-runs it wrapped, through
    // the normal permission flow. Retrying the raw command unchanged is allowed.
    // Plugin installs put `tokenbuild` on the Bash tool's PATH; project installs have the .tokenbuild/run wrapper.
    const wrapper = path.join(tbDir(root), 'run');
    const plugin = !!process.env.CLAUDE_PLUGIN_ROOT;
    if (!plugin && !fs.existsSync(wrapper)) return null;
    const k = 'bash|' + ti.command;
    if (state.blocked[k]) return null;
    state.blocked[k] = 1; save();
    const cwd = input.cwd ? path.resolve(input.cwd) : root;
    const w = plugin ? 'tokenbuild run' : cwd === root ? '.tokenbuild/run' : JSON.stringify(wrapper);
    return { ev: 'hint', tok: 0, reason: `TokenBuild: this command prints a long log. Run it as:\n${w} ${ti.command}\nSame command and exit code; prints errors and the summary, saves the full log. Retry it unchanged only if you need the raw output.` };
  }
  if ((tool === 'Grep' || tool === 'Glob') && [ti.path, ti.pattern, ti.glob].some((p) => p && /node_modules|(^|\/)(dist|build|\.git)(\/|$)/.test(p))) {
    return { reason: 'TokenBuild: searching vendored/generated folders wastes tokens. Narrow the path to source folders, or use tb_find.', tok: 0 };
  }
  return null;
}

export function reset(input, root) {
  const sid = String(input.session_id || 'none').replace(/[^\w-]/g, '');
  try { fs.rmSync(path.join(tbDir(root), 'state', `${sid}.json`)); } catch {}
  ctx.reset(input, root);
}

export async function runGuard(mode = 'pre') {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input; try { input = JSON.parse(raw); } catch { return 0; } // never break Claude on bad input
  const root = rootOf(input.cwd || process.cwd());
  if (mode === 'reset') { reset(input, root); return 0; }
  if (!licensed().ok) return 0; // no active plan: stay out of the way
  const d = decide(input, root);
  if (!d) return 0;
  appendLedger(root, { ev: d.ev || 'block', tool: input.tool_name, tok: d.tok, sid: input.session_id });
  process.stderr.write(d.reason + '\n');
  return 2;
}
