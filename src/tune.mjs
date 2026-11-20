// Setup tuners: each looks at how you actually work and proposes a change you apply with --apply.
//   Permission Learner  commands you approve every time -> allow rules (fewer stalls, fewer turns)
//   Tool Diet           MCP servers whose tool definitions ride along on every request but are never used
//   CLAUDE.md Compiler  sections only relevant to one folder -> that folder's CLAUDE.md (loaded on demand)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tbDir, readJSON, writeJSON, tokens, mkdirp } from './util.mjs';
import { globalStats } from './meter.mjs';

const home = () => process.env.HOME || os.homedir();
const settingsFiles = (root) => [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'), path.join(home(), '.claude', 'settings.json')];
function mergeLocal(root, fn) {
  const p = path.join(root, '.claude', 'settings.local.json');
  const s = readJSON(p, {});
  fn(s); mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return p;
}

// ---- Permission Learner -------------------------------------------------------------------------------
const RISKY = /^(rm|sudo|su|curl|wget|chmod|chown|dd|mkfs|ssh|scp|rsync|kill|pkill|killall|shutdown|reboot|eval|exec|sh|bash|zsh|source|mv|cp|git push|git reset|git clean|git checkout|git rebase|npm publish|yarn publish|pnpm publish|docker rm|docker rmi|kubectl delete|terraform apply|terraform destroy)\b/;
export function allowed(root) {
  const rules = settingsFiles(root).flatMap((f) => readJSON(f, {}).permissions?.allow || []);
  return rules.map((r) => (r.match(/^Bash\((.*)\)$/) || [])[1]).filter(Boolean).map((r) => r.replace(/:\*$|\s\*$|\*$/, '').trim());
}
export function permissionSuggestions(root, min = 5) {
  const g = globalStats(root), have = allowed(root);
  return Object.entries(g.perms || {})
    .filter(([k, v]) => v.n >= min && !v.denied && !RISKY.test(k) && !have.some((h) => k === h || k.startsWith(h + ' ')))
    .sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([k, v]) => ({ rule: `Bash(${k}:*)`, n: v.n }));
}
export function applyPermissions(root, list) {
  return mergeLocal(root, (s) => { s.permissions ||= {}; s.permissions.allow = [...new Set([...(s.permissions.allow || []), ...list.map((x) => x.rule)])]; });
}

// ---- Tool Diet ------------------------------------------------------------------------------------------
export function mcpServers(root) {
  const out = {};
  for (const [n, c] of Object.entries(readJSON(path.join(root, '.mcp.json'), {}).mcpServers || {})) out[n] = { ...c, scope: 'project' };
  const cj = readJSON(path.join(home(), '.claude.json'), {});
  for (const [n, c] of Object.entries(cj.mcpServers || {})) out[n] ||= { ...c, scope: 'user' };
  for (const [n, c] of Object.entries(cj.projects?.[root]?.mcpServers || {})) out[n] ||= { ...c, scope: 'local' };
  return out;
}

// Ask a stdio server for its tool list, as Claude Code does at startup; measure the definitions' size.
export function measure(cfg, timeout = 6000) {
  return new Promise((resolve) => {
    if (!cfg.command || (cfg.type && cfg.type !== 'stdio')) return resolve(null);
    let buf = '', done = false;
    const c = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { c.kill(); } catch {} resolve(v); };
    const t = setTimeout(() => end(null), timeout);
    c.on('error', () => end(null));
    c.stdin.on('error', () => {});
    c.stdout.on('data', (d) => {
      buf += d;
      for (const l of buf.split('\n')) { let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.id === 1) { c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'); }
        if (j.id === 2) end({ tools: (j.result?.tools || []).length, tok: tokens(JSON.stringify(j.result?.tools || [])) }); }
    });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tokenbuild-diet', version: '1' } } }) + '\n');
  });
}

export async function diet(root, { measureDefs = true } = {}) {
  const servers = mcpServers(root), used = globalStats(root).mcp || {};
  const sessions = fs.existsSync(path.join(tbDir(root), 'state')) ? fs.readdirSync(path.join(tbDir(root), 'state')).filter((f) => f.startsWith('meter-')).length : 0;
  const rows = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const m = measureDefs ? await measure(cfg) : null;
    rows.push({ name, scope: cfg.scope, calls: used[name]?.calls || 0, tools: m?.tools ?? null, tok: m?.tok ?? null });
  }
  return { rows, sessions, unused: sessions >= 5 ? rows.filter((r) => !r.calls) : [] };
}
export function applyDiet(root, names) {
  return mergeLocal(root, (s) => { s.disabledMcpjsonServers = [...new Set([...(s.disabledMcpjsonServers || []), ...names])]; });
}

// ---- CLAUDE.md Compiler --------------------------------------------------------------------------------
export function sections(md) {
  const out = []; let cur = { head: '', body: [] };
  for (const l of md.split('\n')) { if (/^##\s/.test(l)) { out.push(cur); cur = { head: l, body: [] }; } else cur.body.push(l); }
  out.push(cur);
  return out.filter((s) => s.head || s.body.join('').trim()).map((s) => ({ ...s, text: [s.head, ...s.body].filter((x, i) => i || x).join('\n') }));
}
export function compile(root) {
  const p = path.join(root, 'CLAUDE.md');
  let md; try { md = fs.readFileSync(p, 'utf8'); } catch { return { error: 'No CLAUDE.md in this project.' }; }
  const secs = sections(md), moves = [], dupes = [];
  const seen = new Map();
  for (const s of secs) {
    if (!s.head) continue;
    const dirs = new Set((s.text.match(/`([\w.-]+\/[\w./-]*)`/g) || []).map((m) => m.slice(1, -1).split('/')[0]).filter((d) => fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory()));
    const t = tokens(s.text);
    if (dirs.size === 1 && t >= 40 && !/^##\s*(rules|commands|layout|overview|mantra|brand)/i.test(s.head)) moves.push({ head: s.head, dir: [...dirs][0], tok: t });
    for (const l of s.body.map((x) => x.trim()).filter((x) => x.length > 30)) { if (seen.has(l)) dupes.push(l); else seen.set(l, s.head); }
  }
  return { total: tokens(md), moves, dupes: [...new Set(dupes)], saved: moves.reduce((a, m) => a + m.tok, 0) };
}
export function applyCompile(root, plan) {
  const p = path.join(root, 'CLAUDE.md'), md = fs.readFileSync(p, 'utf8');
  mkdirp(path.join(tbDir(root), 'backup'));
  fs.writeFileSync(path.join(tbDir(root), 'backup', `CLAUDE.md.${Date.now()}`), md);
  const secs = sections(md), keep = [];
  for (const s of secs) {
    const mv = plan.moves.find((m) => m.head === s.head);
    if (!mv) { keep.push(s.text); continue; }
    const np = path.join(root, mv.dir, 'CLAUDE.md');
    const prev = fs.existsSync(np) ? fs.readFileSync(np, 'utf8').trimEnd() + '\n\n' : `# ${mv.dir}\n\n`;
    fs.writeFileSync(np, prev + s.text.trim() + '\n');
  }
  fs.writeFileSync(p, keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  return plan.moves.map((m) => `${m.dir}/CLAUDE.md`);
}
