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
import * as meter from './meter.mjs';
import * as memo from './memo.mjs';
import { core as editCore } from './anchor.mjs';
import { profile, readTranscript } from './profile.mjs';
import { permissionSuggestions } from './tune.mjs';
import { rates } from './prices.mjs';

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
    if (cfg.predict === false || meter.held(input, cfg, 'predict')) return;
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
      if (!meter.held(input, cfg, 'verify')) try { verify.schedule(root, sid(input), rel); } catch {}
      // Codemod Mode: the same small change in 3+ files is one tb_apply call.
      const pairs = tool === 'MultiEdit' ? (input.tool_input?.edits || []) : tool === 'Edit' ? [input.tool_input || {}] : [];
      st.cores ||= {};
      for (const ed of pairs) {
        const c = typeof ed.old_string === 'string' && typeof ed.new_string === 'string' ? editCore(ed.old_string, ed.new_string) : null;
        if (!c) continue;
        const k = JSON.stringify(c), e = (st.cores[k] ||= { files: [], told: 0 });
        if (!e.files.includes(rel)) e.files.push(rel);
        if (e.files.length >= 3 && !e.told) { e.told = 1; notes.push(`TokenBuild: you've made the same change in ${e.files.length} files (${JSON.stringify(c[0])} → ${JSON.stringify(c[1])}). tb_apply can make it everywhere in one call: {"find": ${JSON.stringify(c[0])}, "replace": ${JSON.stringify(c[1])}} (add "files" to limit scope, "dry": true to preview).`); appendLedger(root, { ev: 'codemod_hint' }); }
      }
      const ck = Object.keys(st.cores); if (ck.length > 60) for (const x of ck.slice(0, ck.length - 60)) delete st.cores[x];
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
  // Real Meter first: it knows when Claude last replied and how big the context is.
  const ms = meter.scan(root, input, cfg).s;
  // Cache Keeper: after a long break the prompt cache has expired; resending a huge context re-writes all of it.
  const gap = ms.lastAt ? (Date.now() - ms.lastAt) / 60000 : 0, ttl = meter.globalStats(root).ttl || 5;
  if (cfg.cacheKeeper !== false && gap > ttl && ms.lastCtx >= (Number(cfg.cacheKeeperMin) || 80000) && ms.ckFor !== ms.lastAt && input.transcript_path && cfg.handoff !== false) {
    ms.ckFor = ms.lastAt; meter.saveState(root, input, ms);
    const r = handoff.write(root, input.transcript_path, input.session_id);
    if (r && r.tokens < ms.lastCtx * 0.25) {
      writeJSON(metaPath(root), { from: ms.lastCtx, to: r.tokens });
      appendLedger(root, { ev: 'ck_block' });
      const usd = (ms.lastCtx * rates(ms.model).cacheWrite) / 1e6;
      return { json: { decision: 'block', reason: `TokenBuild Cache Keeper: you were away ${Math.round(gap)} min, so Claude's prompt cache for this ~${num(ms.lastCtx)}-token conversation has expired. Sending now re-writes all of it (≈$${usd.toFixed(2)} at API prices). A handoff note is saved: type /clear, then send your message again to continue from it (~${num(r.tokens)} tokens). Or just send it again to continue here.` } };
    }
  }
  const v = verify.report(root);
  if (v) out.push(v.text);
  const text = input.prompt || '';
  if (cfg.brief !== false && cfg.memory !== false && !meter.held(input, cfg, 'brief')) {
    const b = brief.build(root, text);
    if (b) { out.push(b); appendLedger(root, { ev: 'brief' }); }
    const hits = memo.find(root, text);
    if (hits.length) { out.push('TokenBuild memo (saved answers; the files they rest on are unchanged):\n' + hits.map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n')); appendLedger(root, { ev: 'memo_hit', n: hits.length }); }
    const f = meter.forecast(root, text);
    if (f) out.push(`TokenBuild forecast: similar tasks here took ~${num(f.tok)} tokens over ${f.turns} replies (median of ${f.n}).`);
  }
  // Narration Meter: when recaps are a big share of what Claude writes, ask for less (output tokens cost the most).
  const g = meter.globalStats(root);
  if (cfg.narration !== false && g.text > 3000 && g.narr / g.text > 0.2) out.push(`TokenBuild: ~${Math.round((g.narr / g.text) * 100)}% of your recent replies here were recap. Keep replies short: don't restate tool results or what you just did; the user sees them.`);
  return out.length ? { out: out.join('\n\n') } : {};
}

export function stop(input, root) {
  try { fmt.flush(input, root); } catch {}
  const cfg = config(root);
  // Verify loop: a check still running gets a moment; a failure keeps Claude working (never twice in a row).
  if (cfg.verify !== false && verify.busy(root)) verify.waitIdle(root, Number(cfg.verifyWait) || 30_000);
  const ms = meter.scan(root, input, cfg).s;
  const v = verify.report(root);
  if (v && !v.ok && !input.stop_hook_active) return { json: { decision: 'block', reason: v.text } };
  if (input.transcript_path) for (const q of task.questionsFrom(input.transcript_path)) task.question(root, q);
  const msgs = [];
  const t = ms.task;
  if (t) {
    // Exploration Memo: a question that took several searches and reads is worth remembering.
    if (!t.memo && t.reqs >= 4 && t.text && memo.isQuestion(t.q) && cfg.memo !== false) { memo.save(root, t.q, t.text, t.reads); t.memo = 1; appendLedger(root, { ev: 'memo_save' }); }
    // Task Budget Forecast: past twice what similar tasks took usually means going in circles.
    const f = !t.warned && t.tok > 100000 ? meter.forecast(root, t.q) : null;
    if (f && t.tok > 2 * f.tok) { t.warned = 1; appendLedger(root, { ev: 'budget_warn' }); msgs.push(`TokenBuild: this task has used ~${num(t.tok)} tokens, over twice what similar tasks took (~${num(f.tok)}). If Claude is going in circles, interrupt and redirect it.`); }
    meter.saveState(root, input, ms);
  }
  const at = Number(cfg.handoffAt) || handoff.HANDOFF_AT;
  if (cfg.handoff === false || !input.transcript_path) return msgs.length ? { json: { systemMessage: msgs.join('\n') } } : {};
  const size = handoff.contextSize(input.transcript_path);
  const st = readJSON(statePath(root, input), {});
  // Context GC: a big context that is mostly dead weight restarts clean, before it gets huge.
  let gc = null;
  if (cfg.gc !== false && size >= 60000 && size < at && size - (st.gcSize || 0) >= 20000) {
    st.gcSize = size; writeJSON(statePath(root, input), st);
    const p = profile(readTranscript(input.transcript_path), root);
    if (p.deadShare >= 0.5) gc = p;
  }
  if (!gc && (size < at || (st.handoffAt && size < st.handoffAt * 1.5))) return msgs.length ? { json: { systemMessage: msgs.join('\n') } } : {};
  const r = handoff.write(root, input.transcript_path, input.session_id);
  if (!r) return msgs.length ? { json: { systemMessage: msgs.join('\n') } } : {};
  st.handoffAt = size; writeJSON(statePath(root, input), st); writeJSON(metaPath(root), { from: size, to: r.tokens });
  appendLedger(root, { ev: 'handoff', from: size, to: r.tokens, ...(gc ? { gc: 1 } : {}) });
  msgs.push(gc
    ? `TokenBuild Context GC: ~${Math.round(gc.deadShare * 100)}% of this ~${num(size)}-token conversation is dead weight (old output and files no later step used), re-sent with every reply. A clean note with the live files, facts and plan is saved. Type /clear to continue from it (~${num(r.tokens)} tokens).`
    : `TokenBuild: this conversation is ~${num(size)} tokens, and every reply re-sends all of it. A handoff note is saved. Type /clear to continue in a fresh session that starts from the note (~${num(r.tokens)} tokens).`);
  return { json: { systemMessage: msgs.join('\n') } };
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
  const json = {};
  // Permission Learner: once a week at most, tell the user which commands they approve every time.
  const pp = path.join(tbDir(root), 'state', 'perm-shown.json');
  if (Date.now() - readJSON(pp, { at: 0 }).at > 7 * 864e5) {
    const sug = permissionSuggestions(root);
    if (sug.length) { writeJSON(pp, { at: Date.now() }); json.systemMessage = `TokenBuild: you approve ${sug.slice(0, 3).map((x) => `\`${x.rule.slice(5, -3)}\` (${x.n}×)`).join(', ')} every time. Run \`tokenbuild permissions --apply\` to stop being asked for ${sug.length > 1 ? 'these' : 'it'}.`; }
  }
  const md = handoff.take(root, input.source);
  if (md) {
    const m = readJSON(metaPath(root), {});
    appendLedger(root, { ev: 'resume', from: m.from || 0, to: m.to || 0 });
    if (!json.systemMessage) return { out: md };
    json.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: md };
  }
  return json.systemMessage ? { json } : {};
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
