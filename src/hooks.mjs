// One entry point per Claude Code hook event, so each event costs one short process (<50 ms).
//   post        PostToolUse + PostToolUseFailure: formatting, repo memory, loop checks, verify loop,
//               next-read prediction, failure fingerprints, task state
//   prompt      UserPromptSubmit: task brief (likely files, check, past failures); task state; turn count
//   stop        Stop: format; wait for a running verify (a failure keeps Claude working); open questions; handoff
//   start       SessionStart: reset per-session state; inject a fresh handoff note
//   precompact  PreCompact: reset read tracking and save a handoff (never blocks compaction)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tbDir, readJSON, writeJSON, appendLedger, num, isJunk } from './util.mjs';
import { licensed } from './license.mjs';
import { reset as resetGuard } from './guard.mjs';
import * as fmt from './format.mjs';
import * as stuck from './stuck.mjs';
import * as memory from './memory.mjs';
import * as handoff from './handoff.mjs';
import * as ctx from './ctx.mjs';
import * as verify from './verify.mjs';
import * as predict from './predict.mjs';
import * as task from './task.mjs';
import * as brief from './brief.mjs';
import { fingerprint, learn as fpLearn, lookup as fpLookup } from './fingerprint.mjs';

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const sid = (input) => String(input.session_id || 'none').replace(/[^\w-]/g, '');
const statePath = (root, input) => path.join(tbDir(root), 'state', `s-${sid(input)}.json`);
const metaPath = (root) => path.join(tbDir(root), 'state', 'handoff-meta.json');
const config = (root) => readJSON(path.join(tbDir(root), 'config.json'), {});

const fresh = () => ({ stuck: stuck.fresh(), task: [], edited: [], hinted: {}, n: 0, editLog: [], fpOpen: {}, fpSeen: {} });
const CHECK = /\b(test|tests|spec|lint|eslint|tsc|typecheck|build|check|pytest|vitest|jest|mocha|cargo|go (test|vet|build)|make)\b/;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const relOf = (root, abs) => { if (!abs) return null; const r = path.relative(root, path.isAbsolute(abs) ? abs : path.join(root, abs)); return r && !r.startsWith('..') && !isJunk(r) ? r : null; };
const lazyIdx = (root) => { let v; return () => (v === undefined ? (v = readJSON(path.join(tbDir(root), 'index.json'), null)) : v); };

// A check failed: open a fingerprint, and point at the known fix once per session.
function failed(root, st, notes, key, err) {
  const fp = fingerprint(err);
  if (!st.fpOpen[key]) st.fpOpen[key] = { fp, n: st.n, err: clip(err, 160) };
  if (st.fpSeen[fp]) return;
  st.fpSeen[fp] = 1;
  const k = fpLookup(root, fp);
  if (!k) return;
  notes.push(`TokenBuild fingerprint: this error has been fixed before${k.team ? ' by your team' : ''} by changing ${k.files.map(([f, c]) => `${f}${c > 1 ? ` (${c}×)` : ''}`).join(', ')}. Look there first.`);
  appendLedger(root, { ev: 'fp_hit' });
}
// The same check passed: whatever was edited since it failed is the fix.
function passed(root, st, key) {
  const o = st.fpOpen[key]; if (!o) return;
  delete st.fpOpen[key];
  const files = [...new Set(st.editLog.filter(([, n]) => n > o.n).map(([f]) => f))];
  if (!files.length) return;
  fpLearn(root, o.fp, files, o.err);
  task.fact(root, `Fixed "${clip(o.err, 90)}" by changing ${files.slice(0, 4).join(', ')}`);
}

// Each handler returns { out?: string (stdout), json?: object, code?: number }.
export function post(input, root) {
  const p = statePath(root, input);
  const st = { ...fresh(), ...readJSON(p, {}) };
  const notes = [], cfg = config(root), idx = lazyIdx(root);
  const tool = input.tool_name, ok = !input.error && input.hook_event_name !== 'PostToolUseFailure';
  const touch = (rel) => {
    if (cfg.predict === false) return;
    if (predict.touch(root, st, rel).hit) appendLedger(root, { ev: 'predict_hit' });
    const n = predict.prefetch(root, st, rel, idx());
    if (n) { notes.push(n); appendLedger(root, { ev: 'predict' }); }
  };
  if (tool === 'Read' && ok) { const rel = relOf(root, input.tool_input?.file_path); if (rel) touch(rel); }
  if (tool === 'TodoWrite' && Array.isArray(input.tool_input?.todos)) task.todos(root, input.tool_input.todos);
  if (EDITS.has(tool) && ok) {
    try { fmt.track(input, root); } catch {}
    const abs = input.tool_input?.file_path || input.tool_input?.notebook_path;
    const rel = relOf(root, abs);
    if (rel) {
      ctx.onEdit(input, root, path.isAbsolute(abs) ? abs : path.join(root, abs), rel);
      const first = !st.edited.includes(rel);
      memory.learnEdit(root, rel, first ? st.task : [], first ? st.edited : []);
      if (first) st.edited.push(rel);
      st.editLog.push([rel, ++st.n]); if (st.editLog.length > 200) st.editLog.shift();
      task.edited(root, rel);
      if (first && !st.hinted[rel] && cfg.memory !== false) {
        st.hinted[rel] = 1;
        const ps = memory.partners(root, rel).filter((x) => !st.edited.includes(x.path));
        if (ps.length) { notes.push(`TokenBuild memory: ${rel} is usually changed together with ${ps.map((x) => `${x.path} (${x.times}×)`).join(', ')}. Check whether this task needs those too.`); appendLedger(root, { ev: 'recall' }); }
      }
      try { verify.schedule(root, sid(input), rel); } catch {}
      touch(rel);
    }
  }
  if (tool === 'Bash') {
    const { cmd, err } = stuck.bashOutcome(input);
    if (cmd && (err || CHECK.test(cmd))) {
      if (CHECK.test(cmd)) task.check(root, cmd, err);
      if (err) failed(root, st, notes, cmd, err); else passed(root, st, cmd);
    }
  }
  const v = verify.report(root);
  if (v) {
    notes.push(v.text);
    const r = verify.lastResult(root);
    if (v.ok) { passed(root, st, 'verify'); task.fact(root, `Tests pass after the latest edits: ${r.tests.slice(0, 4).join(', ')}`); }
    else failed(root, st, notes, 'verify', r.fail || 'tests failed');
  }
  const loop = stuck.observe(st.stuck, input);
  if (loop) { notes.push(loop); appendLedger(root, { ev: 'loop' }); }
  writeJSON(p, st);
  if (!notes.length) return {};
  return { json: { hookSpecificOutput: { hookEventName: input.hook_event_name || 'PostToolUse', additionalContext: notes.join('\n\n') } } };
}

export function prompt(input, root) {
  const p = statePath(root, input);
  const st = { ...fresh(), ...readJSON(p, {}) };
  st.task = memory.keywords(input.prompt || '');
  st.edited = [];                       // a new request is a new task for co-edit learning
  writeJSON(p, st);
  ctx.turn(input, root);
  task.prompt(root, input.prompt || '');
  const cfg = config(root), out = [];
  const v = verify.report(root);
  if (v) out.push(v.text);
  if (cfg.brief !== false && cfg.memory !== false) {
    const b = brief.build(root, input.prompt || '');
    if (b) { out.push(b); appendLedger(root, { ev: 'brief' }); }
  }
  return out.length ? { out: out.join('\n\n') } : {};
}

export function stop(input, root) {
  try { fmt.flush(input, root); } catch {}
  const cfg = config(root);
  // Verify loop: a check still running gets a moment; a failure keeps Claude working (never twice in a row).
  if (cfg.verify !== false && verify.busy(root)) verify.waitIdle(root, Number(cfg.verifyWait) || 30_000);
  const v = verify.report(root);
  if (v && !v.ok && !input.stop_hook_active) return { json: { decision: 'block', reason: v.text } };
  if (input.transcript_path) for (const q of task.questionsFrom(input.transcript_path)) task.question(root, q);
  const at = Number(cfg.handoffAt) || handoff.HANDOFF_AT;
  if (cfg.handoff === false || !input.transcript_path) return {};
  const size = handoff.contextSize(input.transcript_path);
  const st = readJSON(statePath(root, input), {});
  if (size < at || (st.handoffAt && size < st.handoffAt * 1.5)) return {};
  const r = handoff.write(root, input.transcript_path, input.session_id);
  if (!r) return {};
  st.handoffAt = size; writeJSON(statePath(root, input), st); writeJSON(metaPath(root), { from: size, to: r.tokens });
  appendLedger(root, { ev: 'handoff', from: size, to: r.tokens });
  return { json: { systemMessage: `TokenBuild: this conversation is ~${num(size)} tokens, and every reply re-sends all of it. A handoff note is saved. Type /clear to continue in a fresh session that starts from the note (~${num(r.tokens)} tokens).` } };
}

export function start(input, root) {
  resetGuard(input, root);
  // The brief, the verify loop and next-read use the Repo Index: keep it fresh in the background.
  try {
    const st_ = fs.statSync(path.join(tbDir(root), 'index.json'));
    if (Date.now() - st_.mtimeMs > 6 * 36e5) throw 0;
  } catch {
    if (fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, '.tokenbuild'))) {
      const bin = new URL('../bin/tokenbuild.mjs', import.meta.url).pathname;
      spawn(process.execPath, [bin, 'index', '--root', root], { detached: true, stdio: 'ignore' }).unref();
    }
  }
  const md = handoff.take(root, input.source);
  if (!md) return {};
  const m = readJSON(metaPath(root), {});
  appendLedger(root, { ev: 'resume', from: m.from || 0, to: m.to || 0 });
  return { out: md };
}

export function precompact(input, root) {
  resetGuard(input, root);
  if (input.transcript_path && config(root).handoff !== false) {
    const r = handoff.write(root, input.transcript_path, input.session_id);
    if (r) { writeJSON(metaPath(root), { from: r.ctx, to: r.tokens }); appendLedger(root, { ev: 'handoff', from: r.ctx, to: r.tokens, compact: 1 }); }
  }
  return {};                            // exit 0: a PreCompact hook must never block compaction
}

const HANDLERS = { post, prompt, stop, start, precompact };

export async function runHook(name, root, raw) {
  let input = {}; try { input = JSON.parse(raw); } catch { return 0; }
  if (!licensed().ok) return 0;           // no plan: step aside silently
  try {
    const r = HANDLERS[name](input, root);
    if (r.json) process.stdout.write(JSON.stringify(r.json));
    else if (r.out) process.stdout.write(r.out + '\n');
  } catch {}                              // never break Claude's turn
  return 0;
}
