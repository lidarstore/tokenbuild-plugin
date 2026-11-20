// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited). Tools answer from the local index: zero model tokens to compute.
import readline from 'node:readline';
import { loadIndex, buildIndex, repoMap, find, pack } from './repo.mjs';
import { packBoost } from './memory.mjs';
import { impacted, runnerFor, runTests, lastResult } from './verify.mjs';
import { load as loadTask, render, claim, fact as taskFact, question as taskQuestion } from './task.mjs';
import { build as buildBrief } from './brief.mjs';
import { anchorEdit, codemod } from './anchor.mjs';
import { lookup as docsLookup } from './docs.mjs';
import { save as memoSave, find as memoFind } from './memo.mjs';
import { profile, readTranscript, render as renderProfile, lastTranscript } from './profile.mjs';
import { schedule as verifySchedule } from './verify.mjs';
import { appendLedger, VERSION } from './util.mjs';
import { config, detect, digest } from './local.mjs';
import { licensed, explain, refreshIfDue } from './license.mjs';

const TOOLS = [
  { name: 'tb_map', description: 'Compact map of this repo: most-imported files and their top symbols. Call once at the start instead of exploring with Glob/LS.',
    inputSchema: { type: 'object', properties: { budget: { type: 'number', description: 'Max tokens (default 2500)' } } } },
  { name: 'tb_find', description: 'Find a symbol or file by name. Returns path:line so you can Read just that range.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'tb_pack', description: 'Files and symbols a task most likely needs, with line numbers, under a token budget. Use before starting a task.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, budget: { type: 'number' } }, required: ['task'] } },
  { name: 'tb_brief', description: 'Short brief for a task (~150 tokens): likely files with line numbers, files usually opened with them, the tests to check, and past failures fixed there. Cheaper than exploring; use when starting work or when a subagent gets a task.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'tb_verify', description: 'Run only the tests that can be affected by a change to `file` (from the import graph) and get one line back: pass, or the failing assertion and a log path. Without `file`, returns the latest background result. Use instead of running the whole test suite.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Repo-relative path of the changed file' } } } },
  { name: 'tb_task', description: 'Live task state kept by TokenBuild: goal, plan, files changed, checks, verified facts, open questions. Lets a new session or subagent resume at once, and lets parallel agents split the plan: claim an item before working on it; mark it done after.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'claim', 'done', 'fact', 'question'], description: 'get (default) | claim a plan item | done (mark completed) | fact (record a verified fact) | question (record an open question)' },
      item: { type: 'string', description: 'Plan item number (1-based) or text, for claim/done' },
      text: { type: 'string', description: 'Fact or question text' },
      agent: { type: 'string', description: 'Your agent name, for claim' } } } },
  { name: 'tb_edit', description: 'Replace lines start..end of a file you have read this session with `text`, without writing the old lines back out (saves the output tokens of old_string). Safe: applies only if those lines are unchanged since you read them, and refuses edits that break syntax. Use for multi-line changes; then keep using tb_edit for that file.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, start: { type: 'number', description: 'First line to replace (1-based, as shown by Read)' }, end: { type: 'number', description: 'Last line to replace (inclusive). end = start - 1 inserts before start' }, text: { type: 'string', description: 'New lines (empty deletes)' } }, required: ['file', 'start', 'end', 'text'] } },
  { name: 'tb_apply', description: 'Codemod: one find/replace across many files, applied locally, with a compact summary. Use instead of repeating the same Edit in file after file (renames, API migrations, import rewrites).',
    inputSchema: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, regex: { type: 'boolean', description: 'Treat find as a JS regex ($1 in replace)' }, files: { type: 'array', items: { type: 'string' }, description: 'Paths, folders or globs to limit scope' }, dry: { type: 'boolean', description: 'Preview only' } }, required: ['find', 'replace'] } },
  { name: 'tb_docs', description: 'How a library function/class works at the version installed in this project: declaration + doc comments from node_modules .d.ts (JS/TS: "package#symbol"), Python signature + docstring ("pkg.module.name"), or go doc. ~300 tokens; use instead of web searches or guessing an API.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, lang: { type: 'string', enum: ['js', 'py', 'go'] } }, required: ['symbol'] } },
  { name: 'tb_memo', description: 'Saved answers about this repo ("where is auth handled?"), returned only while the files they rest on are unchanged. get: look up before exploring. save: after you worked out where/how something works, save the answer with the files it rests on, so no session has to explore it again.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'save'] }, question: { type: 'string' }, answer: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
  { name: 'tb_profile', description: 'What fills your context window right now, by source, and how much is dead weight. Use when the conversation feels heavy, before deciding to continue or start fresh.',
    inputSchema: { type: 'object', properties: {} } },
];
// Listed only when Local Boost is on and a local model is available, so it costs nothing otherwise.
const DIGEST = { name: 'tb_digest', description: 'Ask a local model (on this machine, zero Claude tokens) a question about a large file or a .tokenbuild/logs log. Returns a short answer with line numbers. Use before reading a big file or log in full.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' } }, required: ['path', 'question'] } };

export async function handle(msg, root, state) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tokenbuild', version: VERSION } });
  if (method === 'tools/list') return ok({ tools: state.boost ? [...TOOLS, DIGEST] : TOOLS });
  if (method === 'tools/call') {
    if (!state.idx || Date.now() - state.at > 30_000) { state.idx = state.idx ? buildIndex(root).idx : loadIndex(root); state.at = Date.now(); }
    const a = params.arguments || {};
    const l = licensed();
    if (!l.ok) return ok({ content: [{ type: 'text', text: explain(l) }], isError: true });
    if (params.name === 'tb_digest') return ok({ content: [{ type: 'text', text: await digest(root, String(a.path || ''), String(a.question || '')) }] });
    const say = (text) => ok({ content: [{ type: 'text', text }] });
    if (params.name === 'tb_edit') { const r = await anchorEdit(root, a, { schedule: (r_, s_, f_) => verifySchedule(r_, s_, f_) }); return say(r.error ? `Not applied: ${r.error}` : r.text); }
    if (params.name === 'tb_apply') { const r = codemod(root, a, { schedule: (r_, s_, f_) => verifySchedule(r_, s_, f_) }); return say(r.error || r.text); }
    if (params.name === 'tb_docs') { const t = docsLookup(root, a.symbol, a.lang); appendLedger(root, { ev: 'docs' }); return say(t); }
    if (params.name === 'tb_memo') {
      if (a.action === 'save') { const r = memoSave(root, a.question, a.answer, a.files || []); appendLedger(root, { ev: 'memo_save' }); return say(r.error || `Saved (rests on ${r.files} file${r.files === 1 ? '' : 's'}; returned only while they're unchanged).`); }
      const hits = memoFind(root, a.question || '');
      if (hits.length) appendLedger(root, { ev: 'memo_hit', n: hits.length });
      return say(hits.length ? hits.map((h) => `Q: ${h.q}\nA: ${h.a}\n(files: ${h.files.join(', ') || 'none'}; unchanged)`).join('\n\n') : 'No saved answer. Explore, then save what you find with action "save".');
    }
    if (params.name === 'tb_profile') { const t = lastTranscript(root); return say(t ? renderProfile(profile(readTranscript(t), root)) : 'No session transcript seen yet.'); }
    if (params.name === 'tb_verify') {
      const f = String(a.file || '');
      let text;
      if (!f) { const r = lastResult(root); text = r ? (r.ok ? `Pass: ${r.tests.join(', ')} (${(r.ms / 1000).toFixed(1)}s).` : `Fail: ${r.tests.join(', ')}: ${r.fail}. Log: ${r.log}`) : 'No test run yet. Pass `file` to run the tests a change can affect.'; }
      else {
        const tests = impacted(state.idx, f.replace(/^\.\//, '')).filter((t) => runnerFor(root, t));
        if (!tests.length) text = `No tests found that import ${f} (or no supported test runner). Nothing to run.`;
        else { const r = await runTests(root, tests); appendLedger(root, { ev: 'verify', ok: r.ok, n: tests.length, ms: r.ms }); text = r.ok ? `Pass: ${tests.join(', ')} (${(r.ms / 1000).toFixed(1)}s).` : `Fail: ${r.fail}. Log: ${r.log} (read only the lines you need).`; }
      }
      return ok({ content: [{ type: 'text', text }] });
    }
    if (params.name === 'tb_task') {
      const act = a.action || 'get';
      let text;
      if (act === 'claim' || act === 'done') { const r = claim(root, String(a.item || ''), String(a.agent || 'agent').slice(0, 40), act === 'done' ? 'completed' : null); text = r.error || `${act === 'done' ? 'Marked done' : 'Claimed'}: item ${r.n}.\n\n` + render(loadTask(root)); }
      else if (act === 'fact' && a.text) { taskFact(root, String(a.text)); text = 'Recorded.'; }
      else if (act === 'question' && a.text) { taskQuestion(root, String(a.text)); text = 'Recorded.'; }
      else text = render(loadTask(root));
      return ok({ content: [{ type: 'text', text }] });
    }
    const text = params.name === 'tb_map' ? repoMap(state.idx, a.budget)
      : params.name === 'tb_brief' ? (buildBrief(root, String(a.task || '')) || 'Nothing in the index or memory matches this task. Try tb_find with a symbol name, or ask the user where to look.')
      : params.name === 'tb_find' ? find(state.idx, String(a.query || ''))
      : params.name === 'tb_pack' ? pack(state.idx, String(a.task || ''), a.budget, packBoost(root, String(a.task || '')))
      : null;
    if (text === null) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
    appendLedger(root, { ev: 'tool', tool: params.name, out: Math.ceil(text.length / 4) });
    return ok({ content: [{ type: 'text', text }] });
  }
  if (method === 'ping') return ok({});
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

export function runMcp(root) {
  const state = { idx: null, at: 0, boost: false };
  refreshIfDue(); // confirm the plan once per session start, in the background
  const ready = config(root).boost ? detect(root).then((d) => { state.boost = d.ok && !!d.model; }) : Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    await ready;
    const res = await handle(msg, root, state);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
