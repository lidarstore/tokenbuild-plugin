// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited). Tools answer from the local index: zero model tokens to compute.
import readline from 'node:readline';
import { loadIndex, buildIndex, repoMap, find, pack } from './repo.mjs';
import { packBoost } from './memory.mjs';
import { impacted, runnerFor, runTests, lastResult } from './verify.mjs';
import { load as loadTask, render, claim, fact as taskFact, question as taskQuestion } from './task.mjs';
import { build as buildBrief } from './brief.mjs';
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
