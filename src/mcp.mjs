// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited). Tools answer from the local index: zero model tokens to compute.
import readline from 'node:readline';
import { loadIndex, buildIndex, repoMap, find, pack } from './repo.mjs';
import { packBoost } from './memory.mjs';
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
    const text = params.name === 'tb_map' ? repoMap(state.idx, a.budget)
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
