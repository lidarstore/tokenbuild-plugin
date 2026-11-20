// Wires TokenBuild into a repo's Claude Code setup. Idempotent; touches only its own entries.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, tbDir } from './util.mjs';

// Kept tiny on purpose: CLAUDE.md is sent with every request (and to every subagent).
const BLOCK = (scout) => `<!-- tokenbuild -->
## Token rules (TokenBuild)
- Start a task with tb_pack (or tb_map); use tb_find before Grep/Glob.
- Read line ranges (offset/limit) of large files. Don't re-read unchanged files.
- Run tests, builds, installs and linters as \`.tokenbuild/run <command>\`: errors + summary, full log saved.${scout ? '\n- Delegate searches and log reading to the tb-scout agent; it runs on a cheaper model.' : ''}
<!-- /tokenbuild -->`;

// Model routing presets: which model Claude Code's subagents use when they don't name one.
// The main session keeps whatever model the developer picked.
export const ROUTES = {
  balanced: { subagents: 'sonnet', scout: 'haiku', about: 'subagents on Sonnet, tb-scout on Haiku' },
  lean: { subagents: 'haiku', scout: 'haiku', about: 'all subagents on Haiku (cheapest; weaker on hard subtasks)' },
  off: null,
};

const SCOUT = (model) => `---
name: tb-scout
description: Fast, low-cost explorer. Use for finding where things are, reading logs or large files, and answering "where/what/which" questions about the codebase. Returns paths with line numbers and short facts, not code dumps.
tools: Read, Grep, Glob, mcp__tokenbuild__tb_find, mcp__tokenbuild__tb_map, mcp__tokenbuild__tb_pack, mcp__tokenbuild__tb_digest
model: ${model}
---
You are a read-only scout for the main agent. Find the answer with the fewest reads: tb_find or tb_pack first, then Read only the line ranges you need.
Reply in at most 15 lines: file:line references and the facts asked for. Quote code only when it is the answer, and then only the exact lines.
`;

export function cliCommand(self = process.argv[1]) {
  if (!self) return 'tokenbuild';
  if (/[\\/]_npx[\\/]/.test(self)) return 'npx -y tokenbuild'; // npx installs aren't on PATH
  if (/[\\/]lib[\\/]node_modules[\\/]tokenbuild[\\/]/.test(self)) return 'tokenbuild'; // global install
  return `node ${JSON.stringify(path.resolve(self))}`;
}

const ours = (h) => /tokenbuild/.test(h.command || '') && /\b(guard|format|hook)\b/.test(h.command || '');

export function init(root, cmd = cliCommand(), { route = 'balanced', format = true } = {}) {
  const done = [];
  const plan = ROUTES[route] === undefined ? ROUTES.balanced : ROUTES[route];

  // 1. Hooks (and model routing) in .claude/settings.json
  const sp = path.join(root, '.claude', 'settings.json');
  const s = readJSON(sp, {});
  s.hooks ||= {};
  const strip = (event) => { s.hooks[event] = (s.hooks[event] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length); };
  const add = (event, matcher, command) => { s.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }); };
  for (const e of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PreCompact', 'SessionStart', 'Stop']) strip(e);
  add('PreToolUse', 'Read|Grep|Glob|Bash', `${cmd} guard`);
  add('PostToolUse', 'Edit|Write|MultiEdit|Bash', `${cmd} hook post`);
  add('PostToolUseFailure', 'Bash', `${cmd} hook post`);
  add('UserPromptSubmit', '', `${cmd} hook prompt`);
  add('Stop', '', `${cmd} hook stop`);
  add('SessionStart', '', `${cmd} hook start`);
  add('PreCompact', '', `${cmd} hook precompact`);
  // `format: false` in config turns formatting off; the post/stop hooks stay for loops, memory and handoff.
  const cfgPath = path.join(root, '.tokenbuild', 'config.json'), cfg = readJSON(cfgPath, {});
  if (!format) { cfg.format = false; writeJSON(cfgPath, cfg); } else if (cfg.format === false) { delete cfg.format; writeJSON(cfgPath, cfg); }
  for (const e of Object.keys(s.hooks)) if (!s.hooks[e].length) delete s.hooks[e];
  if (plan) {
    s.env ||= {};
    if (!s.env.CLAUDE_CODE_SUBAGENT_MODEL || s.env.TOKENBUILD_ROUTE) { s.env.CLAUDE_CODE_SUBAGENT_MODEL = plan.subagents; s.env.TOKENBUILD_ROUTE = route; }
  } else if (s.env?.TOKENBUILD_ROUTE) { delete s.env.CLAUDE_CODE_SUBAGENT_MODEL; delete s.env.TOKENBUILD_ROUTE; if (!Object.keys(s.env).length) delete s.env; }
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  done.push(`.claude/settings.json: Waste Guard, Loop Breaker, Fresh Start, Repo Memory${format ? ', auto-format' : ''} hooks`);
  if (plan) done.push(s.env.TOKENBUILD_ROUTE ? `Model routing (${route}): ${plan.about}` : `Model routing: kept your CLAUDE_CODE_SUBAGENT_MODEL=${s.env.CLAUDE_CODE_SUBAGENT_MODEL}`);

  // 2. tb-scout agent on a cheap model
  const ap = path.join(root, '.claude', 'agents', 'tb-scout.md');
  if (plan) { fs.mkdirSync(path.dirname(ap), { recursive: true }); fs.writeFileSync(ap, SCOUT(plan.scout)); done.push(`.claude/agents/tb-scout.md: explorer on ${plan.scout}`); }
  else try { fs.rmSync(ap); } catch {}

  // 3. MCP server in .mcp.json
  const mp = path.join(root, '.mcp.json');
  const m = readJSON(mp, {});
  m.mcpServers ||= {};
  const [command, ...pre] = cmd.startsWith('node ') ? ['node', JSON.parse(cmd.slice(5))] : cmd.split(' ');
  m.mcpServers.tokenbuild = { command, args: [...pre, 'mcp'] };
  fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  done.push('.mcp.json: tb_map, tb_find, tb_pack tools');

  // 4. .tokenbuild/run: the Output Shrinker, callable as a short path
  const wp = path.join(tbDir(root), 'run');
  fs.mkdirSync(path.dirname(wp), { recursive: true });
  fs.writeFileSync(wp, `#!/bin/sh\n# TokenBuild Output Shrinker: same command and exit code, condensed output, full log saved.\nexec ${cmd} run -- "$@"\n`, { mode: 0o755 });
  fs.chmodSync(wp, 0o755);
  done.push('.tokenbuild/run: Output Shrinker');

  // 5. CLAUDE.md rules block
  const cp = path.join(root, 'CLAUDE.md');
  let c = ''; try { c = fs.readFileSync(cp, 'utf8'); } catch {}
  const block = BLOCK(!!plan);
  c = c.includes('<!-- tokenbuild -->') ? c.replace(/<!-- tokenbuild -->[\s\S]*?<!-- \/tokenbuild -->/, block) : (c ? c.trimEnd() + '\n\n' : '') + block + '\n';
  fs.writeFileSync(cp, c);
  done.push(`CLAUDE.md: ${block.split('\n').length - 3}-line token rules block`);

  // 6. Keep local state out of git
  const gp = path.join(root, '.gitignore');
  let g = ''; try { g = fs.readFileSync(gp, 'utf8'); } catch {}
  if (!/^\.tokenbuild\/?$/m.test(g)) { fs.writeFileSync(gp, (g ? g.trimEnd() + '\n' : '') + '.tokenbuild/\n'); done.push('.gitignore: .tokenbuild/'); }
  return done;
}
