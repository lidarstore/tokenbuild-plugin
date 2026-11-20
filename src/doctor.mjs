// `tokenbuild doctor`: one short checklist of what's on in this project and the one next step.
// Run by the user (or the plugin's /tokenbuild:setup), so it may check the plan online.
import { TEST, runnerFor } from './verify.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { tbDir, readJSON, num } from './util.mjs';
import * as L from './license.mjs';
import { projectHooks } from './guard.mjs';
import { tally } from './ledger.mjs';

const PLAN = { solo: 'Solo', team: 'Team', comp: 'Complimentary' };

function keySource() {
  const ok = (v) => v && v.trim() && !v.includes('${');
  if (ok(process.env.TOKENBUILD_KEY)) return 'TOKENBUILD_KEY';
  if (ok(process.env.CLAUDE_PLUGIN_OPTION_CLI_KEY)) return 'plugin settings';
  return fs.existsSync(path.join(L.home(), 'key')) ? 'this computer' : '';
}

export async function doctor(root, { plugin = false } = {}) {
  const lines = [], todo = [];
  const src = keySource();
  const r = src ? await L.check(undefined, { timeout: 5000 }) : { error: 'no-key' };
  if (r.ok && r.active) lines.push(`✓ Plan: ${PLAN[r.plan] || 'Solo'} (${r.status}), key from ${src}`);
  else if (r.error === 'offline') { const l = L.licensed(); lines.push(l.ok ? '✓ Plan: active (offline; last check is still valid)' : '✗ Plan: couldn\'t reach app.tokenbuild.ai'); if (!l.ok) todo.push('Check your connection, then run this again.'); }
  else {
    lines.push(src ? `✗ Plan: not active for the key from ${src}` : '✗ Plan: no CLI key on this computer');
    todo.push(`Start a trial or plan at ${L.BILLING} and create a CLI key there.`,
      plugin ? 'Then add the key with /plugin configure tokenbuild@tokenbuild (kept in secure storage), or in a terminal: npx tokenbuild login <key>'
        : 'Then, in a terminal (not in this chat): npx tokenbuild login <key>');
  }

  const proj = projectHooks(root);
  lines.push(plugin && proj ? '✓ Tools: on (this repo uses `tokenbuild init` hooks; the plugin steps aside here)'
    : plugin ? '✓ Tools: on through the TokenBuild plugin' : proj ? '✓ Tools: on through `tokenbuild init`' : '✗ Tools: not set up in this repo');
  if (!plugin && !proj) todo.push('Install the plugin in Claude Code, or run: npx tokenbuild init');

  const idx = readJSON(path.join(tbDir(root), 'index.json'), null);
  lines.push(idx ? `✓ Repo index: ${num(Object.keys(idx.files || {}).length)} files` : '· Repo index: builds itself in the background when a Claude Code session starts');
  const tests = idx ? Object.keys(idx.files || {}).filter((f) => TEST.test(f)) : [];
  const run = tests.map((t) => runnerFor(root, t)).find(Boolean);
  const vcfg = readJSON(path.join(tbDir(root), 'config.json'), {}).verify;
  lines.push(vcfg === false ? '· Verify Loop: off ("verify": false in .tokenbuild/config.json)'
    : run ? `✓ Verify Loop: runs affected tests with \`${run.cmd.replace(/ \{(files|dirs)\}/, '')}\` after edits (${num(tests.length)} test file${tests.length === 1 ? "" : "s"})`
    : '· Verify Loop: no supported test runner found (node --test, Vitest, Jest, pytest, go test), or set "verify" to your command with {files}');
  const mem = readJSON(path.join(tbDir(root), 'memory.json'), null);
  const learned = Object.keys(mem?.files || {}).length;
  lines.push(learned ? `✓ Repo Memory: learned from ${num(learned)} edited file${learned === 1 ? "" : "s"}` : '· Repo Memory: learns as Claude edits files');
  const cfg = readJSON(path.join(tbDir(root), 'config.json'), {});
  lines.push(cfg.boost ? `✓ Local Boost: on${cfg.model ? ` (${cfg.model})` : ''}` : '· Local Boost: off (optional, free local model)');

  let ledger = [];
  try { ledger = fs.readFileSync(path.join(tbDir(root), 'ledger.jsonl'), 'utf8').trim().split('\n'); } catch {}
  const t = tally(ledger);
  const saved = t.tok_blocked + t.tok_shrunk + t.tok_local + t.tok_handoff;
  if (saved) lines.push(`✓ Saved so far here: ~${num(saved)} tokens`);

  return [...lines, '', todo.length ? `Next: ${todo.join('\n      ')}` : 'All set. Work as usual; TokenBuild runs in the background.'].join('\n');
}
