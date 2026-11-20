// Task brief: built locally (zero model tokens) when a prompt arrives, so Claude starts on the right
// files instead of exploring: likely files with key line numbers (index + Repo Memory), what usually
// comes next, the check to run, past failures fixed in these files, and, for a vague request,
// the one question worth asking before spending tokens on exploration.
import path from 'node:path';
import { tbDir, readJSON } from './util.mjs';
import { rank, taskWords } from './repo.mjs';
import { packBoost, recall, keywords } from './memory.mjs';
import { impacted, runnerFor } from './verify.mjs';
import { successors } from './predict.mjs';
import { near } from './fingerprint.mjs';

const MAX_CHARS = 1400;

export function build(root, text) {
  const words = keywords(text);
  const idx = readJSON(path.join(tbDir(root), 'index.json'), null);
  const mem = recall(root, words, { limit: 4 }).filter((h) => h.score >= 1);
  const ranked = idx ? rank(idx, text, packBoost(root, text)).slice(0, 5) : [];
  const named = /[\w-]+\.[a-z]{1,5}\b|`[^`]+`|\b[a-z]+[A-Z]\w+\b/.test(text);
  const vague = taskWords(text).length < 3 && !named && !mem.length && (!ranked.length || ranked[0][2] < 3);
  if (!ranked.length && !mem.length) {
    return vague && words.length ? `TokenBuild brief: this request doesn't name a file, feature or symbol I can match. If the target is unclear, ask the user one short question before exploring.` : null;
  }
  const L = ['TokenBuild brief (built locally from your repo index and memory):'];
  const fileLine = ([f, v]) => {
    const syms = (v?.symbols || []).filter((s) => s.k !== 'method').slice(0, 3).map((s) => `${s.n}:${s.l}`).join(', ');
    const m = mem.find((h) => h.path === f);
    return `${f}${syms ? ` (${syms})` : ''}${m ? ` · changed in ${m.edits} similar past task${m.edits > 1 ? 's' : ''}` : ''}`;
  };
  const files = [...ranked.map(([f, v]) => [f, v])];
  for (const h of mem) if (!files.some(([f]) => f === h.path)) files.push([h.path, idx?.files?.[h.path]]);
  L.push('Likely files: ' + files.slice(0, 5).map(fileLine).join('; '));
  const top = files.slice(0, 3).map(([f]) => f);
  const nxt = top.flatMap((f) => successors(root, f, new Set(top), 1).map(([g]) => g));
  if (nxt.length) L.push('Usually opened with them: ' + [...new Set(nxt)].join(', '));
  const tests = [...new Set(top.flatMap((f) => impacted(idx, f)))].slice(0, 4);
  const r = tests.length && runnerFor(root, tests[0]);
  if (r) L.push(`Check: ${tests.join(', ')} (${r.cmd.split(' {')[0]}). TokenBuild runs these after each edit and reports one line, so you don't need the full suite.`);
  const past = near(root, top);
  if (past.length) L.push('Past failures fixed in these files: ' + past.map((p) => `"${p.e}" → ${Object.keys(p.fix).slice(0, 2).join(', ')}`).join('; '));
  if (vague) L.push('The request is broad: if the target is unclear, ask the user one short question before exploring.');
  L.push('Read only the line ranges you need.');
  let out = L.join('\n');
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - 1) + '…';
  return out;
}
