#!/usr/bin/env node
// tokenbuild — Build More. Use Less.
import fs from 'node:fs';
import path from 'node:path';

const [cmd = 'help', ...rest] = process.argv.slice(2);
if (cmd === 'run') { // raw argv: the command's own flags must not be parsed as ours
  const { run } = await import('../src/shrink.mjs');
  const { rootOf } = await import('../src/guard.mjs');
  const { licensed, explain } = await import('../src/license.mjs');
  const argv = rest[0] === '--' ? rest.slice(1) : rest;
  const l = licensed();
  process.exit(await run(argv, rootOf(process.cwd()), l.ok ? {} : { passthrough: explain(l) }));
}
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true); }
  else args.push(a);
}
const root = path.resolve(flags.root || process.cwd());

// Plugin hooks (CLAUDE_PLUGIN_ROOT is set only for them) step aside where `tokenbuild init` hooks already run.
if ((cmd === 'hook' || cmd === 'guard') && process.env.CLAUDE_PLUGIN_ROOT) {
  const { projectHooks, rootOf } = await import('../src/guard.mjs');
  if (projectHooks(rootOf(process.cwd()))) process.exit(0);
}
const out = (s) => process.stdout.write(s + '\n');

const HELP = `tokenbuild — Build More. Use Less.

  audit [--days 30] [--project name] [--json]   Free: price the token waste in your Claude Code logs
  login [key]                                   Connect this computer to your plan (key from app.tokenbuild.ai/billing)
  logout                                        Remove the saved key from this computer
  doctor                                        Check your plan and what's on in this repo, and what to do next
  init [--route balanced|lean|off] [--no-format] Add hooks, MCP tools, model routing and rules to this repo
  run <command>                                 Run a noisy command; print errors + summary, save the full log
  index                                         Build/refresh the local repo index
  map [--budget 2500]                           Print the compact repo map
  find <name>                                   Locate a symbol or file (path:line)
  pack "<task>" [--budget 4000]                 Context pack for a task
  stats                                         Tokens kept out of context in this repo
  boost [on|off] [--model name]                 Local Boost: a local model (Ollama) reads big files for Claude
  ask "<question>" <file>                       Ask the local model about a file (Local Boost)
  sync                                          Send daily counts (no code) to your dashboard
  guard [--reset]                               (hook) Claude Code PreToolUse guard
  format [--track]                              (hook) Format edited files with your configured formatter
  handoff                                       Save a handoff note so a fresh session picks up where you are
  hook post|prompt|stop|start|precompact        (hook) Loop Breaker, Repo Memory, Fresh Start
  mcp                                           (server) MCP stdio server`;

// Paid tools need an active trial or plan (cached check; offline-safe). The audit is free.
// init and login check online; hooks, run and mcp degrade to doing nothing instead of failing.
const GATED = new Set(['index', 'map', 'find', 'pack', 'boost', 'ask', 'handoff']);
if (GATED.has(cmd)) {
  const { licensed, explain } = await import('../src/license.mjs');
  const l = licensed();
  if (!l.ok) { process.stdout.write(explain(l) + '\n'); process.exit(1); }
}

const readLedger = () => { try { return fs.readFileSync(path.join(root, '.tokenbuild', 'ledger.jsonl'), 'utf8').trim().split('\n'); } catch { return []; } };

switch (cmd) {
  case 'audit': {
    const { audit, report } = await import('../src/audit.mjs');
    const days = Number(flags.days || 30);
    const t = audit({ days, project: flags.project || '' });
    if (flags.json) { t.files = Object.fromEntries([...t.files].sort((a, b) => b[1] - a[1]).slice(0, 20)); out(JSON.stringify(t)); }
    else out(report(t, days));
    break;
  }
  case 'login': {
    const L = await import('../src/license.mjs');
    if (args[0]) L.saveKey(args[0]);
    if (!L.readKey()) { out(`Create a CLI key at ${L.BILLING}, then run: tokenbuild login <key>`); process.exitCode = 1; break; }
    const r = await L.check();
    if (r.ok && r.active) out(`✓ Connected: ${r.plan === 'team' ? 'Team' : r.plan === 'comp' ? 'Complimentary' : 'Solo'} plan (${r.status}). Now run in a project: tokenbuild init`);
    else if (r.error === 'offline') { out('Saved. Couldn\'t reach app.tokenbuild.ai to confirm your plan; run tokenbuild login again when online.'); process.exitCode = 1; }
    else { out(L.explain(L.licensed())); process.exitCode = 1; }
    break;
  }
  case 'doctor': case 'status': {
    const { rootOf } = await import('../src/guard.mjs');
    out(await (await import('../src/doctor.mjs')).doctor(rootOf(root), { plugin: !!flags.plugin }));
    break;
  }
  case 'logout': {
    (await import('../src/license.mjs')).forget();
    out('Removed the saved key and plan from this computer.');
    break;
  }
  case 'init': {
    const L = await import('../src/license.mjs');
    if (!L.readKey()) { out(L.explain({ reason: 'no-license' })); process.exitCode = 1; break; }
    const c = await L.check();
    const l = L.licensed();
    if (!l.ok) { out(c.error === 'offline' ? 'Couldn\'t reach app.tokenbuild.ai to confirm your plan. Check your connection and try again.' : L.explain(l)); process.exitCode = 1; break; }
    const { init } = await import('../src/init.mjs');
    const { buildIndex } = await import('../src/repo.mjs');
    const route = flags.route || 'balanced';
    if (!(route in (await import('../src/init.mjs')).ROUTES)) { out('--route must be balanced, lean or off'); process.exitCode = 1; break; }
    for (const d of init(root, undefined, { route, format: !flags['no-format'] })) out('✓ ' + d);
    const { total } = buildIndex(root);
    out(`✓ Indexed ${total} source files\nRestart Claude Code in this folder to load the tools.`);
    break;
  }
  case 'index': {
    const { buildIndex } = await import('../src/repo.mjs');
    const t0 = Date.now(); const { total, parsed } = buildIndex(root);
    out(`Indexed ${total} files (${parsed} changed) in ${Date.now() - t0} ms`);
    break;
  }
  case 'map': case 'find': case 'pack': {
    const r = await import('../src/repo.mjs');
    const idx = r.buildIndex(root).idx;
    out(cmd === 'map' ? r.repoMap(idx, Number(flags.budget) || 2500)
      : cmd === 'find' ? r.find(idx, args.join(' '))
      : r.pack(idx, args.join(' '), Number(flags.budget) || 4000, (await import('../src/memory.mjs')).packBoost(root, args.join(' '))));
    break;
  }
  case 'stats': {
    const { num } = await import('../src/util.mjs');
    const { tally } = await import('../src/ledger.mjs');
    const t = tally(readLedger());
    const total = t.tok_blocked + t.tok_shrunk + t.tok_local + t.tok_handoff;
    out([`~${num(total)} tokens kept out of Claude's context in this repo`,
      `  Waste Guard     ${num(t.blocks)} reads blocked, ~${num(t.tok_blocked)} tokens`,
      `  Output Shrinker ${num(t.shrinks)} logs condensed, ~${num(t.tok_shrunk)} tokens`,
      `  Local Boost     ${num(t.local_calls)} files read locally, ~${num(t.tok_local)} tokens`,
      `  Fresh Start     ${num(t.handoffs)} fresh sessions from a handoff, ~${num(t.tok_handoff)} tokens`,
      `  Loop Breaker    ${num(t.loops)} loops caught`,
      `  Repo Memory     ${num(t.recalls)} recalls`,
      `  Auto-format     ${num(t.formats)} files formatted`,
      `  Repo tools      ${num(t.tool_calls)} calls (tb_map, tb_find, tb_pack)`].join('\n'));
    break;
  }
  case 'sync': { // daily counts; on Team, also repo-memory file paths + counts. Never code, file contents or prompts
    const key = flags.key || (await import('../src/license.mjs')).readKey();
    if (!key) { out('Run tokenbuild login <key> first (key from app.tokenbuild.ai/billing).'); process.exitCode = 1; break; }
    const { byDay } = await import('../src/ledger.mjs');
    const body = { days: byDay(readLedger()) };
    const r = await fetch((process.env.TOKENBUILD_API || 'https://app.tokenbuild.ai') + '/v1/usage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    if (!r.ok) { out(`Sync failed: ${(await r.json().catch(() => ({}))).error || r.status}`); process.exitCode = 1; break; }
    if (body.days.length) fs.renameSync(path.join(root, '.tokenbuild', 'ledger.jsonl'), path.join(root, '.tokenbuild', `ledger.${Date.now()}.synced`));
    out(`Synced ${body.days.length} day(s).`);
    const L = await import('../src/license.mjs');
    if (['team', 'comp'].includes(L.licensed().plan)) {
      const t = await (await import('../src/memory.mjs')).syncTeam(root, { api: process.env.TOKENBUILD_API || 'https://app.tokenbuild.ai', key, home: L.home() });
      out(t.members ? `Team memory: shared with ${t.members - 1} teammate(s) on this repo.` : `Team memory: skipped (${t.error}).`);
    }
    break;
  }
  case 'format': {
    const { track, flush } = await import('../src/format.mjs');
    const { rootOf } = await import('../src/guard.mjs');
    let raw = ''; for await (const c of process.stdin) raw += c;
    let input = {}; try { input = JSON.parse(raw); } catch {}
    const r = rootOf(input.cwd || process.cwd());
    if (!(await import('../src/license.mjs')).licensed().ok) break;
    try { if (flags.track) track(input, r); else flush(input, r); } catch {} // never break Claude's turn
    break;
  }
  case 'boost': {
    const L = await import('../src/local.mjs');
    if (args[0] === 'on' || args[0] === 'off') L.setConfig(root, { boost: args[0] === 'on', ...(flags.model ? { model: flags.model } : {}) });
    const c = L.config(root); const d = await L.detect(root, 1500);
    out(`Local Boost: ${c.boost ? 'on' : 'off'}`);
    if (!d.ok) out(`  ${d.error}. Install Ollama (https://ollama.com), then: ollama pull ${L.SUGGEST}`);
    else if (!d.model) out(`  Ollama is running but has no model${c.model ? ` named ${c.model}` : ''}. Try: ollama pull ${L.SUGGEST}`);
    else out(`  Model: ${d.model}${d.models.length > 1 ? ` (installed: ${d.models.join(', ')})` : ''}`);
    if (c.boost && d.model) out('  Claude gets the tb_digest tool after you restart Claude Code.');
    else if (!c.boost) out('  Turn on: tokenbuild boost on');
    break;
  }
  case 'ask': {
    const { digest } = await import('../src/local.mjs');
    if (args.length < 2) { out('Usage: tokenbuild ask "<question>" <file>'); process.exitCode = 1; break; }
    out(await digest(root, args.at(-1), args.slice(0, -1).join(' ')));
    break;
  }
  case 'hook': {
    const { runHook } = await import('../src/hooks.mjs');
    if (!['post', 'prompt', 'stop', 'start', 'precompact'].includes(args[0])) break;
    let raw = ''; for await (const c of process.stdin) raw += c;
    let cwd = process.cwd(); try { cwd = JSON.parse(raw).cwd || cwd; } catch {}
    const { rootOf } = await import('../src/guard.mjs');
    process.exitCode = await runHook(args[0], rootOf(cwd), raw);
    break;
  }
  case 'handoff': {
    const H = await import('../src/handoff.mjs');
    const t = H.latestTranscript(root);
    if (!t) { out('No Claude Code conversation found for this folder.'); process.exitCode = 1; break; }
    const r = H.write(root, t.p, t.id);
    if (!r) { out('Could not read the conversation.'); process.exitCode = 1; break; }
    out(`Handoff saved to .tokenbuild/handoff.md (~${r.tokens} tokens, from a ~${r.ctx} token conversation). Your next new Claude Code session here starts from it.`);
    break;
  }
  case 'guard': {
    const { runGuard } = await import('../src/guard.mjs');
    process.exitCode = await runGuard(flags.reset ? 'reset' : 'pre');
    break;
  }
  case 'mcp': {
    const { runMcp } = await import('../src/mcp.mjs');
    runMcp(root);
    break;
  }
  case '--version': case 'version': out((await import('../src/util.mjs')).VERSION); break;
  default: out(HELP);
}
