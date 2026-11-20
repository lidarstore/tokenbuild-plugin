// Fresh-start handoff: when a session gets long, write a short, exact state note from the session
// transcript (plain code, zero tokens), so a new session starts at ~2K tokens instead of re-sending
// or compacting 100K+. The note is injected automatically when the next session starts.
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, tokens, num, mkdirp } from './util.mjs';
import { firstError } from './stuck.mjs';
import * as task from './task.mjs';

export const HANDOFF_AT = 120_000;   // context size (tokens) at which we suggest a fresh start
const MAX_CHARS = 6000;              // ~1.5K tokens
const FRESH_MS = 6 * 36e5;           // inject a handoff into a new session for up to 6 hours

export const handoffPath = (root) => path.join(tbDir(root), 'handoff.md');

const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
const isPrompt = (t) => t && !/^\s*<(?:command-|local-command|system-reminder|bash-)/.test(t) && !t.startsWith('Caveat:');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Context size of the latest model call, from the tail of the transcript (cheap: reads ~256 KB).
export function contextSize(transcript) {
  let fd; try { fd = fs.openSync(transcript, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try { const u = JSON.parse(lines[i]).message?.usage; if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); } catch {}
    }
  } finally { fs.closeSync(fd); }
  return 0;
}

// Build the note from transcript lines. Returns markdown.
export function build(lines, { sessionId = '', root = '' } = {}) {
  const prompts = [], edits = new Map(), checks = new Map(), uses = new Map();
  let todos = null, lastText = '', ctx = 0;
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d.message; if (!m) continue;
    if (d.type === 'user') {
      if (typeof m.content === 'string' || m.content?.some?.((b) => b.type === 'text')) { const t = text(m.content).trim(); if (isPrompt(t)) prompts.push(t); }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_result') continue;
        const u = uses.get(b.tool_use_id); if (!u || u.name !== 'Bash') continue;
        const out = text(b.content) || (typeof b.content === 'string' ? b.content : '');
        const err = b.is_error ? (firstError(out) || out.split('\n').find((l) => l.trim()) || 'failed') : firstError(out);
        checks.set(u.cmd, err ? `failing: ${clip(err.trim(), 160)}` : 'passing');
      }
    } else if (d.type === 'assistant') {
      if (m.usage) ctx = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text.trim()) lastText = b.text.trim();
        if (b.type !== 'tool_use') continue;
        const i = b.input || {};
        if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(b.name) && (i.file_path || i.notebook_path)) {
          const f = root ? path.relative(root, i.file_path || i.notebook_path) || i.file_path : (i.file_path || i.notebook_path);
          edits.set(f, (edits.get(f) || 0) + 1);
        }
        if (b.name === 'TodoWrite' && Array.isArray(i.todos)) todos = i.todos;
        if (b.name === 'Bash' && i.command) uses.set(b.id, { name: 'Bash', cmd: clip(i.command.replace(/\s+/g, ' ').replace(/^\.tokenbuild\/run /, ''), 90) });
        else uses.set(b.id, { name: b.name });
      }
    }
  }
  const L = [`# Handoff from a previous session${sessionId ? ` (${sessionId.slice(0, 8)})` : ''}`,
    `Written by TokenBuild on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. The previous context was ~${num(ctx)} tokens; this note replaces it.`, ''];
  if (prompts.length) {
    L.push('## Goal', clip(prompts[0], 700), '');
    const recent = prompts.slice(1).slice(-3).filter((p) => p !== prompts[0]);
    if (recent.length) L.push('## Latest requests', ...recent.map((p) => '- ' + clip(p.replace(/\s+/g, ' '), 300)), '');
  }
  if (todos?.length) L.push('## Plan', ...todos.slice(0, 15).map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${clip(String(t.content || t.activeForm || ''), 160)}`), '');
  if (edits.size) L.push('## Files changed', ...[...edits].slice(-20).map(([f, n]) => `- ${f}${n > 1 ? ` (${n} edits)` : ''}`), '');
  const relevant = [...checks].slice(-6);
  if (relevant.length) L.push('## Last results', ...relevant.map(([c, r]) => `- \`${c}\`: ${r}`), '');
  if (lastText) L.push('## Where it left off', clip(lastText, 900), '');
  L.push('## Next', 'Continue from the plan and the latest request above. Files are already changed on disk: read only the line ranges you need, and re-run the failing checks first.');
  let md = L.join('\n');
  if (md.length > MAX_CHARS) md = md.slice(0, MAX_CHARS - 1) + '…';
  return { md, ctx, tokens: tokens(md) };
}

export function write(root, transcript, sessionId) {
  let lines; try { lines = fs.readFileSync(transcript, 'utf8').split('\n'); } catch { return null; }
  const r = build(lines, { sessionId, root });
  // Task state adds what the transcript can't show plainly: verified facts, open questions, claims.
  const t = task.load(root), extra = [];
  if (Date.now() - t.at < 12 * 36e5) {
    if (t.facts.length) extra.push('## Verified facts', ...t.facts.map((f) => '- ' + f), '');
    if (t.questions.length) extra.push('## Open questions', ...t.questions.map((q) => '- ' + q), '');
    const claimed = t.plan.filter((x) => x.claim && x.status !== 'completed');
    if (claimed.length) extra.push('## Claimed by other agents', ...claimed.map((x) => `- ${x.text} (${x.claim})`), '');
  }
  if (extra.length) { r.md = r.md.replace('## Next', extra.join('\n') + '## Next') + '\nCall tb_task for the live task state.'; r.tokens = tokens(r.md); }
  mkdirp(tbDir(root));
  fs.writeFileSync(handoffPath(root), r.md + '\n');
  return r;
}

// For SessionStart: return the note if it's fresh and unused, and mark it used.
export function take(root, source) {
  const p = handoffPath(root);
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (source === 'resume' || source === 'compact') return null;
  if (Date.now() - st.mtimeMs > FRESH_MS) return null;
  const md = fs.readFileSync(p, 'utf8');
  fs.renameSync(p, p.replace(/\.md$/, `.used-${Date.now()}.md`));
  try { for (const f of fs.readdirSync(tbDir(root)).filter((f) => /^handoff\.used-\d+\.md$/.test(f)).sort().slice(0, -5)) fs.rmSync(path.join(tbDir(root), f)); } catch {}
  return md;
}

// Find this project's newest Claude Code transcript (for `tokenbuild handoff` run by hand).
export function latestTranscript(root) {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'), 'projects');
  const slug = root.replace(/[^A-Za-z0-9]/g, '-');
  let best = null;
  for (const dir of [path.join(base, slug)]) {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch {}
    for (const n of names) { const p = path.join(dir, n); const t = fs.statSync(p).mtimeMs; if (!best || t > best.t) best = { p, t, id: n.replace(/\.jsonl$/, '') }; }
  }
  return best;
}
