// Edit Preflight: before an Edit/MultiEdit/Write lands, apply it in memory and syntax-check the result.
// A broken edit is bounced back at once with the exact error, instead of edit -> run -> read error -> fix
// (3-4 full turns). Fast path is in-process (JSON, JS, TS via Node's type stripping); a suspected JS
// error is confirmed with `node --check` so valid code is never blocked. Python uses `ast.parse`.
// Only edits that BREAK a file that parsed before are stopped, and a second identical attempt goes through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import module from 'node:module';
import { spawnSync } from 'node:child_process';

const JS = /\.(?:m|c)?js$/, TS = /\.(?:m|c)?ts$/, MAX = 400_000;

// Make ES module syntax checkable as a script without changing line numbers.
function scriptify(code) {
  const nl = (s) => s.replace(/[^\n]/g, '');
  return code
    .replace(/^#!.*/, '')
    .replace(/\bimport\.meta\b/g, '({})   ')
    .replace(/^[ \t]*import\s+(?:[\w*{}\s,$]+?\s+from\s*)?['"][^'"\n]+['"][ \t]*(?:with\s*\{[^}]*\})?;?/gm, nl)
    .replace(/^[ \t]*export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*(?:from\s*['"][^'"\n]+['"])?;?/gm, nl)
    .replace(/^([ \t]*)export\s+default\s+/gm, '$1void ')
    .replace(/^([ \t]*)export\s+(?=(?:async\s+)?function|class|const|let|var|enum)/gm, '$1');
}

function quiet(fn) { const w = process.emitWarning; process.emitWarning = () => {}; try { return fn(); } finally { process.emitWarning = w; } }

function jsError(code, file) {
  try { new vm.Script(`'use strict';(async function(){${scriptify(code)}\n})`, { filename: file }); return null; }
  catch (e) {
    if (!(e instanceof SyntaxError) && e?.name !== 'SyntaxError') return null;
    const line = Number((String(e.stack).match(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`)) || [])[1]) || 0;
    return { line, msg: e.message };
  }
}

// null = fine (or not checkable); otherwise { line, msg }.
export function check(file, code) {
  if (code.length > MAX) return null;
  if (file.endsWith('.json')) {
    if (/tsconfig|jsconfig|\.vscode|devcontainer/.test(file)) return null;   // JSON with comments
    try { JSON.parse(code); return null; } catch (e) { const pos = Number((e.message.match(/position (\d+)/) || [])[1]); return { line: Number.isFinite(pos) ? code.slice(0, pos).split('\n').length : 0, msg: e.message.replace(/ in JSON at position \d+.*/, '') }; }
  }
  if (TS.test(file) && typeof module.stripTypeScriptTypes === 'function') {
    let js; try { js = quiet(() => module.stripTypeScriptTypes(code)); } catch (e) { return /enum|namespace|parameter propert|not supported/i.test(e.message) ? null : { line: Number((e.message.match(/\[(\d+):\d+\]/) || [])[1]) || 0, msg: e.message.split('\n')[0].replace(/^\s*x\s*/, '') }; }
    return jsError(js, 'x.js');
  }
  if (JS.test(file)) {
    if (/<\/[A-Za-z]|\/>/.test(code) && /<[A-Za-z]/.test(code)) return null;     // JSX in .js: not ours to judge
    const err = jsError(code, 'x.js');
    if (!err) return null;
    // Confirm with Node itself: never block valid code.
    const tmp = path.join(os.tmpdir(), `tb-preflight-${process.pid}${path.extname(file)}`);
    try { fs.writeFileSync(tmp, code); const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 4000 }); if (r.status === 0) return null; const m = String(r.stderr).match(/:(\d+)\n/); return { line: m ? Number(m[1]) : err.line, msg: (String(r.stderr).match(/SyntaxError: .*/) || [err.msg])[0].replace(/^SyntaxError: /, '') }; }
    catch { return err; } finally { try { fs.rmSync(tmp); } catch {} }
  }
  if (file.endsWith('.py')) {
    const r = spawnSync('python3', ['-c', 'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(e.lineno or 0);print(e.msg);sys.exit(1)'], { input: code, encoding: 'utf8', timeout: 4000 });
    if (r.status === 1 && r.stdout) { const [l, m] = r.stdout.trim().split('\n'); return { line: Number(l) || 0, msg: m }; }
    return null;
  }
  return null;
}

// The file as it would be after this tool call, or null if we can't tell (Claude Code reports those errors itself).
export function apply(tool, ti, old) {
  if (tool === 'Write') return String(ti.content ?? '');
  const one = (text, e) => {
    if (typeof e.old_string !== 'string' || !text.includes(e.old_string)) return null;
    return e.replace_all ? text.split(e.old_string).join(e.new_string ?? '') : text.replace(e.old_string, () => e.new_string ?? '');
  };
  if (tool === 'Edit') return old == null ? null : one(old, ti);
  if (tool === 'MultiEdit') { let t = old; for (const e of ti.edits || []) { if (t == null) return null; t = one(t, e); } return t; }
  return null;
}

// PreToolUse. Returns null or { reason, tok: 0, ev: 'preflight' }.
export function preflight(input, root, state, save) {
  const tool = input.tool_name, ti = input.tool_input || {};
  const f = ti.file_path && (path.isAbsolute(ti.file_path) ? ti.file_path : path.join(root, ti.file_path));
  if (!f || !(JS.test(f) || TS.test(f) || f.endsWith('.json') || f.endsWith('.py'))) return null;
  let old = null; try { old = fs.readFileSync(f, 'utf8'); } catch {}
  const next = apply(tool, ti, old);
  if (next == null) return null;
  const err = check(f, next);
  if (!err || (old != null && check(f, old))) return null;            // fine, or it was already broken
  const key = 'pre|' + f + '|' + next.length + '|' + next.slice(-200);
  if (state.blocked[key]) { delete state.blocked[key]; save(); return null; }   // intentional: let it through
  state.blocked[key] = 1; save();
  const rel = path.relative(root, f), lines = next.split('\n'), L = err.line;
  const ctx = L ? lines.slice(Math.max(0, L - 3), L + 1).map((l, i) => `${Math.max(1, L - 2) + i}: ${l}`).join('\n') : '';
  return { ev: 'preflight', tok: 0, reason: `TokenBuild preflight: this ${tool} would leave ${rel} with a syntax error${L ? ` at line ${L}` : ''}: ${err.msg}${ctx ? `\n${ctx}` : ''}\nThe edit was not applied. Fix it and resend; if the broken state is intentional (a multi-step change), send the same edit again.` };
}
