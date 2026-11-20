// Local Boost: optional helper model running on the developer's own machine through Ollama.
// Claude asks it to read big files or logs and gets a short answer back, so the big text never
// enters Claude's context. Off unless turned on; local hosts only, so code never leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, readJSON, writeJSON, tokens, appendLedger, num } from './util.mjs';

const PREFER = [/qwen[\d.]*-?coder/i, /gpt-oss/i, /qwen3/i, /deepseek-coder/i, /codestral|devstral/i, /gemma/i, /llama3/i, /mistral/i, /phi/i];
export const SUGGEST = 'qwen2.5-coder:7b'; // ~5 GB, runs on most 16 GB laptops
const MAX_IN = 24_000; // tokens we hand the local model in one call

export function host() {
  const h = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const url = new URL(/^https?:\/\//.test(h) ? h : `http://${h}`);
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(url.hostname)) throw new Error(`OLLAMA_HOST is ${url.hostname}; Local Boost only talks to this machine so your code never leaves it.`);
  return url.origin;
}

const cfgPath = (root) => path.join(tbDir(root), 'config.json');
export const config = (root) => readJSON(cfgPath(root), {});
export function setConfig(root, patch) { const c = { ...config(root), ...patch }; writeJSON(cfgPath(root), c); return c; }

// { ok, models, model, error }
export async function detect(root, timeout = 400) {
  try {
    const r = await fetch(host() + '/api/tags', { signal: AbortSignal.timeout(timeout) });
    const models = ((await r.json()).models || []).map((m) => m.name);
    const want = process.env.TOKENBUILD_LOCAL_MODEL || config(root).model;
    const model = want ? models.find((m) => m === want || m.startsWith(want + ':')) || null
      : PREFER.map((re) => models.find((m) => re.test(m))).find(Boolean) || models[0] || null;
    return { ok: true, models, model };
  } catch (e) {
    return { ok: false, models: [], model: null, error: /OLLAMA_HOST/.test(e.message) ? e.message : 'Ollama is not running' };
  }
}

export async function ask(model, system, prompt, { maxOut = 400, timeout = 120_000 } = {}) {
  const r = await fetch(host() + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      options: { temperature: 0.1, num_predict: maxOut, num_ctx: Math.min(32_768, 2048 + Math.ceil(tokens(system + prompt) * 1.2)) } }),
  });
  if (!r.ok) throw new Error(`Local model error ${r.status}`);
  return String((await r.json()).message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const SYSTEM = 'You answer questions about one file or log for a coding agent. Be exact and brief: at most 12 lines. Quote identifiers, error messages and line numbers exactly as they appear. If the text does not contain the answer, say "Not in this file." Never invent content.';

// Read a file locally and answer a question about it. Returns the text for Claude.
export async function digest(root, file, question) {
  const abs = path.resolve(root, file);
  if (!abs.startsWith(root + path.sep) && abs !== root) return 'tb_digest only reads files inside this project.';
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { return `Can't read ${file}.`; }
  const d = await detect(root);
  if (!d.ok || !d.model) return `Local Boost unavailable (${d.error || 'no model installed'}). Read the file with offset/limit instead.`;
  const lines = text.split('\n');
  let body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n'), note = '';
  if (tokens(body) > MAX_IN) { // keep the head and the tail, where logs and files usually matter most
    const keep = Math.floor((MAX_IN * 4) / 2);
    body = body.slice(0, keep) + '\n[… middle omitted …]\n' + body.slice(-keep);
    note = ' (middle of file omitted)';
  }
  const t0 = Date.now();
  let a; try { a = await ask(d.model, SYSTEM, `File: ${path.relative(root, abs)}\nQuestion: ${question}\n\n${body}`); }
  catch (e) { return `Local model failed (${e.message}). Read the file with offset/limit instead.`; }
  const read = tokens(text);
  appendLedger(root, { ev: 'local', tok: Math.max(0, read - tokens(a)) });
  return `${a}\n[Local Boost · ${d.model} read ${num(read)} tokens on this machine in ${((Date.now() - t0) / 1000).toFixed(1)}s${note}. Verify exact lines with Read offset/limit before editing.]`;
}
