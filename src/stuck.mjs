// Stuck detector: spots the patterns of an agent going in circles and tells Claude, once per loop,
// what it has already tried. Pure functions over a per-session state object; the hook saves it.
import crypto from 'node:crypto';

const h = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const ERR = /(?:\berror\b|\bERR!|\bfail(?:ed|ure|s)?\b|\bFAIL\b|\bpanic\b|\bexception\b|Traceback|\bassert(?:ion)?\w*\b|\bexpected\b|\bcannot\b|\bnot found\b|[✗✖×✘]|^\s*●|^not ok\b)/i;
const PASSING = /\b0 (?:failed|failures?|errors?)\b|\bno errors?\b|^\s*ok\b/i;
export const SAME_FAILURE = 3;   // identical failure this many times = stuck
export const REVERTS = 2;        // undoing your own edit this many times on one file = oscillating

export const fresh = () => ({ fails: {}, edits: [], reverts: {}, warned: {}, since: {} });

// "npm test -- --foo" and "npm test" are the same check; numbers, hashes and paths don't make a new error.
const normCmd = (c) => String(c).replace(/^\.tokenbuild\/run\s+|^"[^"]*tokenbuild[^"]*"\s+run\s+--\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
export const normErr = (l) => l.replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, '#').replace(/\d+(\.\d+)?/g, 'N').replace(/(["'`]).*?\1/g, '"…"').trim().slice(0, 160);

export function firstError(text) {
  const lines = String(text).split('\n');
  const exit = lines.find((l) => /^\[tokenbuild\] exit [1-9]|^\[exit [1-9]/.test(l));
  for (const l of lines) if (ERR.test(l) && !PASSING.test(l) && !/^\[tokenbuild\]/.test(l)) return l.trim();
  return exit ? exit.trim() : null;
}

const editKey = (i) => [i.file_path, h(i.old_string ?? ''), h(i.new_string ?? i.content ?? '')];

// A Bash call's normalized command and first error line (null when it passed).
// Failed commands arrive as PostToolUseFailure with an `error` string; successes as PostToolUse.
export function bashOutcome(input) {
  const { tool_input: ti = {}, tool_response: tr = {} } = input;
  const failed = input.hook_event_name === 'PostToolUseFailure' || typeof input.error === 'string';
  const text = failed ? String(input.error || '') : typeof tr === 'string' ? tr : [tr.stdout, tr.stderr].filter(Boolean).join('\n');
  const err = firstError(text) || (failed ? (text.split('\n').find((l) => l.trim() && !/^exit code \d+$/i.test(l.trim())) || 'non-zero exit').trim() : null);
  return { cmd: normCmd(ti.command || ''), err };
}

// Feed one tool call (PostToolUse input). Returns a message for Claude when a loop is detected, else null.
export function observe(state, input) {
  const { tool_name: tool, tool_input: ti = {}, tool_response: tr = {} } = input;
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
    const list = tool === 'MultiEdit' ? (ti.edits || []).map((e) => ({ ...e, file_path: ti.file_path })) : [ti];
    for (const e of list) {
      const [f, o, n] = editKey(e);
      if (state.edits.some((p) => p[0] === f && p[1] === n && p[2] === o)) state.reverts[f] = (state.reverts[f] || 0) + 1;
      state.edits.push([f, o, n]);
      if (state.edits.length > 200) state.edits.shift();
      const k = 'revert|' + f;
      if (state.reverts[f] >= REVERTS && !state.warned[k]) {
        state.warned[k] = 1;
        return `TokenBuild loop check: you have reverted your own change in ${f} ${state.reverts[f]} times, so the approach is oscillating. Stop editing for a moment: state what each version was trying to fix and why it failed, pick one root cause, then make one deliberate change.`;
      }
    }
    return null;
  }
  if (tool !== 'Bash') return null;
  const { cmd, err } = bashOutcome(input);
  if (!err || !cmd) { for (const k of Object.keys(state.fails)) if (k.startsWith(cmd + '|')) { delete state.fails[k]; delete state.warned[k]; } return null; } // it passed: loop over
  const sig = cmd + '|' + h(normErr(err));
  state.fails[sig] = (state.fails[sig] || 0) + 1;
  if (state.fails[sig] === 1) state.since[sig] = state.edits.length;
  if (state.fails[sig] < SAME_FAILURE || state.warned[sig]) return null;
  state.warned[sig] = 1;
  const tried = [...new Set(state.edits.slice(state.since[sig] || 0).map((e) => e[0]))];
  return [
    `TokenBuild loop check: \`${cmd}\` has failed ${state.fails[sig]} times with the same error:`,
    `  ${err.slice(0, 200)}`,
    tried.length ? `Files you changed between those attempts: ${tried.slice(0, 6).join(', ')}${tried.length > 6 ? ', …' : ''}. Those changes did not affect this error.` : 'Nothing was changed between those attempts.',
    'Before trying again: re-read the error, say in one sentence what is actually causing it, and change approach. If you are unsure, ask the user. A fresh session also helps: run `tokenbuild handoff`, then the user can /clear.',
  ].join('\n');
}
