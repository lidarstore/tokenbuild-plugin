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
  verify [file]                                 Run only the tests a change to <file> can affect (or show the last result)
  task [--reset]                                Show the task state TokenBuild keeps for handoffs and subagents
  meter [--json]                                Real metered tokens and cost (from Claude Code's own usage records)
  profile                                       What fills Claude's context right now, and how much is dead weight
  proof                                         Each feature's effect, measured against control-group sessions
  permissions [--apply]                         Commands you approve every time -> allow rules
  diet [--apply]                                MCP servers whose tool definitions cost tokens every turn but go unused
  claudemd [--apply]                            Move folder-specific CLAUDE.md sections to that folder (loaded on demand)
  docs <symbol>                                 Installed-version docs for a library symbol (JS "pkg#name", Python, Go)
  boost [on|off] [--model name]                 Local Boost: a local model (Ollama) reads big files for Claude
  ask "<question>" <file>                       Ask the local model about a file (Local Boost)
  sync                                          Send daily counts (no code) to your dashboard
  guard [--reset]                               (hook) Claude Code PreToolUse guard
  format [--track]                              (hook) Format edited files with your configured formatter
  handoff                                       Save a handoff note so a fresh session picks up where you are
  hook post|prompt|stop|start|precompact        (hook) Context Ledger, Verify Loop, Task Brief, Next-Read,
                                                Fingerprints, Task State, Loop Breaker, Repo Memory, Fresh Start
  mcp                                           (server) MCP stdio server`;

// Paid tools need an active trial or plan (cached check; offline-safe). The audit is free.
// init and login check online; hooks, run and mcp degrade to doing nothing instead of failing.
const GATED = new Set(['index', 'map', 'find', 'pack', 'boost', 'ask', 'handoff', 'verify', 'task', 'meter', 'profile', 'proof', 'permissions', 'diet', 'claudemd', 'docs']);
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
    const total = t.tok_blocked + t.tok_shrunk + t.tok_local + t.tok_handoff + t.tok_dedup + t.tok_anchor;
    out([`~${num(total)} tokens kept out of Claude's context in this repo`,
      `  Waste Guard     ${num(t.blocks)} reads blocked, ~${num(t.tok_blocked)} tokens`,
      `  Context Ledger  ${num(t.dedups)} re-reads answered from context or as a diff, ~${num(t.tok_dedup)} tokens`,
      `  Output Shrinker ${num(t.shrinks)} logs condensed, ~${num(t.tok_shrunk)} tokens`,
      `  Local Boost     ${num(t.local_calls)} files read locally, ~${num(t.tok_local)} tokens`,
      `  Fresh Start     ${num(t.handoffs)} fresh sessions from a handoff, ~${num(t.tok_handoff)} tokens`,
      `  Loop Breaker    ${num(t.loops)} loops caught`,
      `  Repo Memory     ${num(t.recalls)} recalls`,
      `  Auto-format     ${num(t.formats)} files formatted`,
      `  Verify Loop     ${num(t.verifies)} targeted test runs, ${num(t.verify_fails)} failures caught`,
      `  Task Brief      ${num(t.briefs)} briefs`,
      `  Next-Read       ${num(t.predicts)} predictions, ${num(t.predict_hits)} opened`,
      `  Fingerprints    ${num(t.fp_hits)} known fixes found`,
      `  Anchor Edits    ${num(t.anchors)} edits, ~${num(t.tok_anchor)} output tokens not written`,
      `  Edit Preflight  ${num(t.preflights)} broken edits stopped before they landed`,
      `  Codemods        ${num(t.codemods)} runs, ${num(t.codemod_files)} files`,
      `  Memo            ${num(t.memo_hits)} saved answers reused, ${num(t.memo_saves)} saved`,
      `  Cache Keeper    ${num(t.cache_breaks)} cache rebuilds seen, ${num(t.ck_blocks)} offered a fresh start; Context GC ${num(t.gcs)}`,
      `  Real Meter      ${num(t.m_in + t.m_cache_read + t.m_cache_write + t.m_out)} tokens metered (tokenbuild meter)`,
      `  Repo tools      ${num(t.tool_calls)} calls (tb_map, tb_find, tb_pack, tb_brief)`].join('\n'));
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
  case 'verify-run': { // internal: background worker started by the post hook
    const { work } = await import('../src/verify.mjs');
    if (args[0] && fs.existsSync(path.join(args[0], '.tokenbuild'))) await work(args[0]);
    break;
  }
  case 'verify': {
    const V = await import('../src/verify.mjs');
    if (!args[0]) { const r = V.lastResult(root); out(r ? (r.ok ? `Pass: ${r.tests.join(', ')}` : `Fail: ${r.tests.join(', ')}: ${r.fail}\nLog: ${r.log}`) : 'No test run yet. Usage: tokenbuild verify <file>'); break; }
    const { loadIndex } = await import('../src/repo.mjs');
    const rel = path.relative(root, path.resolve(args[0]));
    const tests = V.impacted(loadIndex(root), rel).filter((t) => V.runnerFor(root, t));
    if (!tests.length) { out(`No tests found that can see ${rel}, or no supported test runner.`); break; }
    const r = await V.runTests(root, tests);
    out(r.ok ? `Pass: ${tests.join(', ')} (${(r.ms / 1000).toFixed(1)}s)` : `Fail: ${r.fail}\nLog: ${r.log}`);
    if (!r.ok) process.exitCode = 1;
    break;
  }
  case 'meter': {
    const { num } = await import('../src/util.mjs');
    const { tally } = await import('../src/ledger.mjs');
    const t = tally(readLedger());
    const tot = t.m_in + t.m_cache_read + t.m_cache_write + t.m_out;
    if (flags.json) { out(JSON.stringify({ input: t.m_in, cache_read: t.m_cache_read, cache_write: t.m_cache_write, output: t.m_out, usd: t.m_usd_micro / 1e6, cache_breaks: t.cache_breaks, narration: t.text_tok ? t.narr_tok / t.text_tok : 0 })); break; }
    if (!tot) { out('Nothing metered yet: the Real Meter reads usage from Claude Code sessions in this project as they happen.'); break; }
    out([`Real Meter (from Claude Code's own usage records, this repo):`,
      `  ${num(tot)} tokens processed, ≈$${(t.m_usd_micro / 1e6).toFixed(2)} at API list prices`,
      `  input ${num(t.m_in)} · cache reads ${num(t.m_cache_read)} · cache writes ${num(t.m_cache_write)} · output ${num(t.m_out)}`,
      `  cache rebuilds: ${num(t.cache_breaks)} (~${num(t.tok_cache_break)} tokens re-written)`,
      `  recap share of Claude's writing: ${t.text_tok ? Math.round((t.narr_tok / t.text_tok) * 100) : 0}%`].join('\n'));
    break;
  }
  case 'profile': {
    const P = await import('../src/profile.mjs');
    const t = P.lastTranscript(root);
    out(t ? P.render(P.profile(P.readTranscript(t), root)) : 'No session transcript seen yet. Run this while a Claude Code session is open in this project.');
    break;
  }
  case 'proof': {
    const { num } = await import('../src/util.mjs');
    const { proof } = await import('../src/meter.mjs');
    const rows = proof(root);
    const names = { ledger: 'Context Ledger', verify: 'Verify Loop', brief: 'Task Brief', predict: 'Next-Read', preflight: 'Edit Preflight' };
    out(['Measured against control-group tasks (same features, this one off), median tokens per task:', ...rows.map((r) => r.cut === undefined
      ? `  ${names[r.feature].padEnd(15)} collecting: ${r.nOff}/15 control tasks, ${r.nOn}/30 regular`
      : `  ${names[r.feature].padEnd(15)} ${r.cut >= 0 ? '−' : '+'}${Math.abs(Math.round(r.cut * 100))}% tokens (${num(r.tokOn)} vs ${num(r.tokOff)}), replies ${r.turnsOn} vs ${r.turnsOff} (n=${r.nOn}/${r.nOff})`),
    'Control groups: ~10% of sessions run with one feature off. Set "holdout": 0 in .tokenbuild/config.json to opt out.'].join('\n'));
    break;
  }
  case 'permissions': {
    const T = await import('../src/tune.mjs');
    const sug = T.permissionSuggestions(root);
    if (!sug.length) { out('No suggestions yet: TokenBuild suggests a rule after you approve the same safe command 5+ times.'); break; }
    if (flags.apply) { const f = T.applyPermissions(root, sug); out(`Added ${sug.length} allow rule${sug.length > 1 ? 's' : ''} to ${path.relative(root, f)}: ${sug.map((x) => x.rule).join(', ')}`); break; }
    out(['Commands you ran and approved every time (none ever denied):', ...sug.map((x) => `  ${x.rule.padEnd(32)} ${x.n}×`), 'Run `tokenbuild permissions --apply` to add them to .claude/settings.local.json.'].join('\n'));
    break;
  }
  case 'diet': {
    const { num } = await import('../src/util.mjs');
    const T = await import('../src/tune.mjs');
    const d = await T.diet(root);
    if (!d.rows.length) { out('No MCP servers configured for this project.'); break; }
    const total = d.rows.reduce((a, r) => a + (r.tok || 0), 0);
    out([`MCP tool definitions are sent with every request (~${num(total)} tokens measured). Calls over ${d.sessions} sessions:`,
      ...d.rows.map((r) => `  ${r.name.padEnd(22)} ${r.tok == null ? '   n/a' : num(r.tok).padStart(6)} tok  ${String(r.tools ?? '?').padStart(3)} tools  ${String(r.calls).padStart(4)} calls  (${r.scope})`),
      d.unused.length ? `Unused: ${d.unused.map((r) => r.name).join(', ')}. ${flags.apply ? '' : 'Run `tokenbuild diet --apply` to disable the project ones for this project.'}` : d.sessions < 5 ? 'Need 5+ sessions of usage before suggesting removals.' : 'Every server is used.'].join('\n'));
    if (flags.apply && d.unused.length) { const proj = d.unused.filter((r) => r.scope === 'project').map((r) => r.name); if (proj.length) out(`Disabled for this project: ${proj.join(', ')} (in .claude/settings.local.json).`); const other = d.unused.filter((r) => r.scope !== 'project'); if (other.length) out(`User-level servers: remove with ${other.map((r) => `\`claude mcp remove ${r.name}\``).join(', ')} if you don't need them here.`); if (proj.length) T.applyDiet(root, proj); }
    break;
  }
  case 'claudemd': {
    const { num } = await import('../src/util.mjs');
    const T = await import('../src/tune.mjs');
    const c = T.compile(root);
    if (c.error) { out(c.error); break; }
    if (!c.moves.length && !c.dupes.length) { out(`CLAUDE.md is ~${num(c.total)} tokens, sent with every turn. Nothing to move: no section is about a single folder only.`); break; }
    if (flags.apply && c.moves.length) { const f = T.applyCompile(root, c); out(`Moved ${c.moves.length} section${c.moves.length > 1 ? 's' : ''} (~${num(c.saved)} tokens per turn) to ${f.join(', ')}. Claude Code loads those when it works in that folder. Backup in .tokenbuild/backup/.`); break; }
    out([`CLAUDE.md is ~${num(c.total)} tokens, sent with every turn.`, ...c.moves.map((m) => `  move "${m.head.replace(/^#+\s*/, '')}" (~${num(m.tok)} tok) → ${m.dir}/CLAUDE.md`), ...c.dupes.slice(0, 5).map((d) => `  duplicate line: ${d.slice(0, 70)}`), c.moves.length ? `Run \`tokenbuild claudemd --apply\` to move them (saves ~${num(c.saved)} tokens per turn outside those folders).` : ''].filter(Boolean).join('\n'));
    break;
  }
  case 'docs': {
    const { lookup } = await import('../src/docs.mjs');
    out(lookup(root, args.join(' '), flags.lang));
    break;
  }
  case 'task': {
    const T = await import('../src/task.mjs');
    if (flags.reset) { fs.rmSync(path.join(root, '.tokenbuild', 'task.json'), { force: true }); out('Task state cleared.'); break; }
    out(flags.json ? JSON.stringify(T.load(root)) : T.render(T.load(root)));
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
