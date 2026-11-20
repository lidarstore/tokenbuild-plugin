// One entry point per Claude Code hook event, so each event costs one short process (<50 ms).
//   post        PostToolUse + PostToolUseFailure: track edits for formatting, learn repo memory, loop checks
//   prompt      UserPromptSubmit: remember the task, recall files past similar tasks changed
//   stop        Stop: format edited files; if the conversation is huge, write a handoff and tell the user
//   start       SessionStart: reset per-session state; inject a fresh handoff note
//   precompact  PreCompact: reset read tracking and save a handoff (never blocks compaction)
import path from 'node:path';
import { tbDir, readJSON, writeJSON, appendLedger, num, isJunk } from './util.mjs';
import { licensed } from './license.mjs';
import { reset as resetGuard } from './guard.mjs';
import * as fmt from './format.mjs';
import * as stuck from './stuck.mjs';
import * as memory from './memory.mjs';
import * as handoff from './handoff.mjs';

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const sid = (input) => String(input.session_id || 'none').replace(/[^\w-]/g, '');
const statePath = (root, input) => path.join(tbDir(root), 'state', `s-${sid(input)}.json`);
const metaPath = (root) => path.join(tbDir(root), 'state', 'handoff-meta.json');
const config = (root) => readJSON(path.join(tbDir(root), 'config.json'), {});

// Each handler returns { out?: string (stdout), json?: object, code?: number }.
export function post(input, root) {
  const p = statePath(root, input);
  const st = readJSON(p, { stuck: stuck.fresh(), task: [], edited: [], hinted: {} });
  const notes = [];
  if (EDITS.has(input.tool_name) && !input.error) {
    try { fmt.track(input, root); } catch {}
    const abs = input.tool_input?.file_path || input.tool_input?.notebook_path;
    const rel = abs && path.relative(root, path.isAbsolute(abs) ? abs : path.join(root, abs));
    if (rel && !rel.startsWith('..') && !isJunk(rel)) {
      const first = !st.edited.includes(rel);
      memory.learnEdit(root, rel, first ? st.task : [], first ? st.edited : []);
      if (first) st.edited.push(rel);
      if (first && !st.hinted[rel] && config(root).memory !== false) {
        st.hinted[rel] = 1;
        const ps = memory.partners(root, rel).filter((x) => !st.edited.includes(x.path));
        if (ps.length) { notes.push(`TokenBuild memory: ${rel} is usually changed together with ${ps.map((x) => `${x.path} (${x.times}×)`).join(', ')}. Check whether this task needs those too.`); appendLedger(root, { ev: 'recall' }); }
      }
    }
  }
  const loop = stuck.observe(st.stuck, input);
  if (loop) { notes.push(loop); appendLedger(root, { ev: 'loop' }); }
  writeJSON(p, st);
  if (!notes.length) return {};
  return { json: { hookSpecificOutput: { hookEventName: input.hook_event_name || 'PostToolUse', additionalContext: notes.join('\n\n') } } };
}

export function prompt(input, root) {
  const p = statePath(root, input);
  const st = readJSON(p, { stuck: stuck.fresh(), task: [], edited: [], hinted: {} });
  st.task = memory.keywords(input.prompt || '');
  st.edited = [];                       // a new request is a new task for co-edit learning
  writeJSON(p, st);
  if (config(root).memory === false || st.task.length < 2) return {};
  const hits = memory.recall(root, st.task, { limit: 4 }).filter((h) => h.score >= 1);
  if (!hits.length) return {};
  appendLedger(root, { ev: 'recall' });
  return { out: `TokenBuild memory: past tasks like this changed ${hits.map((h) => `${h.path} (${h.edits} edit${h.edits > 1 ? 's' : ''})`).join(', ')}. Start there if relevant, before searching.` };
}

export function stop(input, root) {
  try { fmt.flush(input, root); } catch {}
  const at = Number(config(root).handoffAt) || handoff.HANDOFF_AT;
  if (config(root).handoff === false || !input.transcript_path) return {};
  const size = handoff.contextSize(input.transcript_path);
  const p = statePath(root, input);
  const st = readJSON(p, {});
  if (size < at || (st.handoffAt && size < st.handoffAt * 1.5)) return {};
  const r = handoff.write(root, input.transcript_path, input.session_id);
  if (!r) return {};
  st.handoffAt = size; writeJSON(p, st); writeJSON(metaPath(root), { from: size, to: r.tokens });
  appendLedger(root, { ev: 'handoff', from: size, to: r.tokens });
  return { json: { systemMessage: `TokenBuild: this conversation is ~${num(size)} tokens, and every reply re-sends all of it. A handoff note is saved. Type /clear to continue in a fresh session that starts from the note (~${num(r.tokens)} tokens).` } };
}

export function start(input, root) {
  resetGuard(input, root);
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
