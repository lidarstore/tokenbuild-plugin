// Task state: a small record TokenBuild keeps up to date as Claude works, so any new session or
// subagent can resume at once and parallel agents can split the plan without overlap.
//   goal, latest requests, plan (from TodoWrite, with claims), files changed, checks, verified facts, open questions.
// Stays on this machine (.tokenbuild/task.json). Updated from hooks; read and claimed through tb_task.
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, readJSON, writeJSON, tokens } from './util.mjs';

const STALE = 12 * 36e5, CLAIM_TTL = 2 * 36e5;
const file = (root) => path.join(tbDir(root), 'task.json');
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const blank = () => ({ v: 1, goal: '', req: [], plan: [], files: {}, checks: {}, facts: [], questions: [], at: 0 });
export const load = (root) => readJSON(file(root), blank());
const save = (root, t) => { t.at = Date.now(); writeJSON(file(root), t); return t; };
const pushCap = (arr, x, n) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); arr.push(x); while (arr.length > n) arr.shift(); };

export function prompt(root, text) {
  const t = load(root), p = clip(text, 500);
  if (!p || /^\s*\//.test(text)) return t;
  if (!t.goal || Date.now() - t.at > STALE) return save(root, { ...blank(), goal: p });
  pushCap(t.req, p, 3); return save(root, t);
}

export function todos(root, list) {
  const t = load(root), old = new Map(t.plan.map((x) => [x.text, x]));
  t.plan = list.slice(0, 30).map((x) => { const text = clip(x.content || x.activeForm || '', 160); const o = old.get(text); return { text, status: x.status || 'pending', ...(o?.claim ? { claim: o.claim, claimAt: o.claimAt } : {}) }; });
  return save(root, t);
}

export function edited(root, rel) { const t = load(root); t.files[rel] = (t.files[rel] || 0) + 1; return save(root, t); }
export function check(root, cmd, err) { const t = load(root); t.checks[clip(cmd, 90)] = err ? `failing: ${clip(err, 140)}` : 'passing'; const k = Object.keys(t.checks); if (k.length > 8) delete t.checks[k[0]]; return save(root, t); }
export function fact(root, text) { const t = load(root); pushCap(t.facts, clip(text, 200), 10); return save(root, t); }
export function question(root, text) { const t = load(root); pushCap(t.questions, clip(text, 200), 5); return save(root, t); }

// Questions Claude asked the user at the end of its last reply (from the transcript tail; cheap).
export function questionsFrom(transcript) {
  let fd; try { fd = fs.openSync(transcript, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, 128 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let d; try { d = JSON.parse(lines[i]); } catch { continue; }
      if (d.type !== 'assistant') continue;
      const txt = (d.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (!txt.trim()) continue;
      return txt.split(/\n|(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s.length > 12 && s.endsWith('?')).slice(-3);
    }
  } finally { fs.closeSync(fd); }
  return [];
}

// Claim a plan item for an agent (by number, 1-based, or text). Claims expire so a crashed agent can't hold work.
export function claim(root, item, agent, status) {
  const t = load(root), now = Date.now();
  const i = Number.isInteger(+item) && +item > 0 ? +item - 1 : t.plan.findIndex((x) => x.text.toLowerCase().includes(String(item).toLowerCase()));
  const x = t.plan[i];
  if (!x) return { error: `No plan item "${item}".` };
  if (status) { x.status = status; if (status === 'completed') delete x.claim; }
  else {
    if (x.claim && x.claim !== agent && now - (x.claimAt || 0) < CLAIM_TTL) return { error: `Item ${i + 1} is already claimed by ${x.claim}. Pick another.` };
    x.claim = agent; x.claimAt = now; x.status = 'in_progress';
  }
  save(root, t); return { ok: true, n: i + 1 };
}

export function render(t, { max = 5000 } = {}) {
  if (!t.goal && !t.plan.length && !t.facts.length && !Object.keys(t.files).length && !t.questions.length) return 'No task state yet.';
  const L = ['# Task state (kept by TokenBuild)'];
  if (t.goal) L.push('## Goal', t.goal);
  if (t.req.length) L.push('## Latest requests', ...t.req.map((r) => '- ' + r));
  if (t.plan.length) L.push('## Plan', ...t.plan.map((x, i) => `${i + 1}. [${x.status === 'completed' ? 'x' : x.status === 'in_progress' ? '~' : ' '}] ${x.text}${x.claim && x.status !== 'completed' ? ` (claimed by ${x.claim})` : ''}`));
  const files = Object.entries(t.files);
  if (files.length) L.push('## Files changed', files.slice(-15).map(([f, n]) => `${f}${n > 1 ? ` ×${n}` : ''}`).join(', '));
  const checks = Object.entries(t.checks);
  if (checks.length) L.push('## Checks', ...checks.map(([c, r]) => `- \`${c}\`: ${r}`));
  if (t.facts.length) L.push('## Verified facts', ...t.facts.map((f) => '- ' + f));
  if (t.questions.length) L.push('## Open questions', ...t.questions.map((q) => '- ' + q));
  let md = L.join('\n');
  if (md.length > max) md = md.slice(0, max - 1) + '…';
  return md;
}

export const size = (root) => tokens(render(load(root)));
