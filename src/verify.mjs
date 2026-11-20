// Verify loop: after each edit, find the tests that can see the change (reverse import graph from the
// Repo Index, plus same-name tests) and run only those, in the background. Claude gets one line back:
// pass, or the failing assertion with a log path. At Stop, a pending failure keeps Claude working.
// Only known local test runners are used (node --test, vitest, jest, pytest, go test) or `verify` in config.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tbDir, readJSON, writeJSON, mkdirp, appendLedger } from './util.mjs';
import { firstError } from './stuck.mjs';

export const TEST = /(?:[._](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:py|go))$|(?:^|\/)test_[^/]+\.py$/;
const MAX_TESTS = 8, DEBOUNCE = 900;
const st = (root, n) => path.join(tbDir(root), 'state', n);
const config = (root) => readJSON(path.join(tbDir(root), 'config.json'), {});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stem = (p) => path.basename(p).replace(/\.[^.]+$/, '').replace(/[._](test|spec)$|_test$|^test_/, '');

// Nearest folder (up to root) holding a test-runner config; returns { dir, cmd } or null.
export function runnerFor(root, rel) {
  const cfg = config(root);
  if (cfg.verify === false) return null;
  for (let d = path.dirname(path.join(root, rel)); ; d = path.dirname(d)) {
    if (typeof cfg.verify === 'string' && d === root) return { dir: root, cmd: cfg.verify };
    const pkg = readJSON(path.join(d, 'package.json'), null);
    if (pkg) {
      const s = pkg.scripts?.test || '', deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (/\bvitest\b/.test(s) || deps.vitest) return { dir: d, cmd: 'npx vitest run {files}' };
      if (/\bjest\b/.test(s) || deps.jest) return { dir: d, cmd: 'npx jest {files}' };
      if (/\bnode\b[^&|;]*--test\b/.test(s)) return { dir: d, cmd: 'node --test {files}' };
    }
    if (['pytest.ini', 'conftest.py'].some((f) => fs.existsSync(path.join(d, f))) || /pytest/.test(safeRead(path.join(d, 'pyproject.toml')))) return { dir: d, cmd: 'python -m pytest -q {files}' };
    if (fs.existsSync(path.join(d, 'go.mod'))) return { dir: d, cmd: 'go test {dirs}' };
    if (d === root || path.dirname(d) === d) return null;
  }
}
const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// Tests that can be affected by a change to `rel`: itself if it is a test, importers up to 4 hops, same-name tests.
export function impacted(idx, rel) {
  if (TEST.test(rel)) return [rel];
  const files = idx?.files || {};
  const rev = {};
  for (const [f, v] of Object.entries(files)) for (const d of v.deps || []) (rev[d] ||= []).push(f);
  const out = new Set(), seen = new Set([rel]);
  let frontier = [rel];
  for (let hop = 0; hop < 4 && frontier.length && out.size < MAX_TESTS; hop++) {
    const next = [];
    for (const f of frontier) for (const g of rev[f] || []) if (!seen.has(g)) { seen.add(g); TEST.test(g) ? out.add(g) : next.push(g); }
    frontier = next;
  }
  const s = stem(rel);
  if (rel.endsWith('.go')) for (const f of Object.keys(files)) if (f.endsWith('_test.go') && path.dirname(f) === path.dirname(rel)) out.add(f);
  for (const f of Object.keys(files)) if (out.size < MAX_TESTS && TEST.test(f) && stem(f) === s) out.add(f);
  return [...out].slice(0, MAX_TESTS);
}

// PostToolUse (edit): queue the impacted tests and make sure one background worker is running.
export function schedule(root, sid, rel, { spawnWorker = true } = {}) {
  const idx = readJSON(path.join(tbDir(root), 'index.json'), null);
  const tests = impacted(idx, rel).filter((t) => fs.existsSync(path.join(root, t)) && runnerFor(root, t));
  if (!tests.length) return [];
  const p = readJSON(st(root, 'verify-pending.json'), { tests: [] });
  writeJSON(st(root, 'verify-pending.json'), { tests: [...new Set([...p.tests, ...tests])], at: Date.now(), sid });
  const lock = readJSON(st(root, 'verify.lock'), null);
  if (spawnWorker && !(lock && alive(lock.pid) && Date.now() - lock.at < 15 * 60e3)) {
    const bin = new URL('../bin/tokenbuild.mjs', import.meta.url).pathname;
    const c = spawn(process.execPath, [bin, 'verify-run', root], { detached: true, stdio: 'ignore', env: { ...process.env, CI: '1' } });
    c.unref();
    writeJSON(st(root, 'verify.lock'), { pid: c.pid, at: Date.now() });
  }
  return tests;
}

function runGroup(dir, cmd, tests, timeout) {
  const rels = tests.map((t) => path.relative(dir, t));
  const q = (s) => JSON.stringify(s);
  const line = cmd.replace('{files}', rels.map(q).join(' ')).replace('{dirs}', [...new Set(rels.map((r) => './' + path.dirname(r)))].map(q).join(' '));
  return new Promise((resolve) => {
    let out = '';
    const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
    delete env.NODE_TEST_CONTEXT;                     // a parent `node --test` must not swallow the child's result
    const c = spawn(line, { cwd: dir, shell: true, env });
    const t = setTimeout(() => { out += '\n[tokenbuild] timed out'; c.kill('SIGKILL'); }, timeout);
    const add = (b) => { if (out.length < 2e6) out += b; };
    c.stdout.on('data', add); c.stderr.on('data', add);
    c.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, line }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out: String(e), line }); });
  });
}

const LOC = /([\w./-]+(?:[._](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:py|go)|test_\w+\.py)):(\d+)/;
export function failureLine(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const head = lines.find((l) => /^not ok \d+|^FAIL\b|^[✗×✕●]|^FAILED\b|^--- FAIL/.test(l));
  const pick = (re) => lines.find((l) => re.test(l) && l !== head);
  const detail = pick(/\S\s*!==?\s*\S/) || pick(/^E\s+assert|AssertionError:? \S|^Expected:|^Received:|expected .+(to|but|got)/i);
  const first = [head, detail].filter(Boolean).join(' — ') || firstError(out) || 'tests failed';
  const loc = out.match(LOC);
  const msg = first.replace(/\s+/g, ' ').slice(0, 240);
  return loc && !msg.includes(loc[0]) ? `${msg} (${loc[1]}:${loc[2]})` : msg;
}

// Run the given tests (repo-relative), grouped by runner. Returns { ok, tests, fail, log, ms, at }.
export async function runTests(root, tests, timeout = 120_000) {
  const t0 = Date.now(), groups = new Map();
  for (const t of tests) { const r = runnerFor(root, t); if (r) { const k = r.dir + '\0' + r.cmd; (groups.get(k) || groups.set(k, { ...r, tests: [] }).get(k)).tests.push(path.join(root, t)); } }
  let ok = true, fail = null, log = '';
  for (const g of groups.values()) {
    const r = await runGroup(g.dir, g.cmd, g.tests, timeout);
    log += `$ ${r.line}\n${r.out}\n`;
    if (!r.ok && ok) { ok = false; fail = failureLine(r.out); }
  }
  mkdirp(path.join(tbDir(root), 'logs'));
  const logPath = path.join('.tokenbuild', 'logs', `verify-${Date.now()}.log`);
  fs.writeFileSync(path.join(root, logPath), log);
  return { ok, tests, fail, log: logPath, ms: Date.now() - t0, at: Date.now() };
}

// The background worker (`tokenbuild verify-run <root>`): debounce, run, record, repeat while there is work.
export async function work(root) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  writeJSON(st(root, 'verify.lock'), { pid: process.pid, at: Date.now() });
  const timeout = Number(config(root).verifyTimeout) || 120_000;
  try {
    for (let idle = 0; idle < 3;) {
      await sleep(DEBOUNCE);
      const p = readJSON(st(root, 'verify-pending.json'), { tests: [] });
      if (!p.tests.length) { idle++; continue; }
      if (Date.now() - p.at < DEBOUNCE) continue;          // still editing: wait for the burst to end
      writeJSON(st(root, 'verify-pending.json'), { tests: [] });
      const res = { ...(await runTests(root, p.tests, timeout)), sid: p.sid, reported: false };
      writeJSON(st(root, 'verify-result.json'), res);
      appendLedger(root, { ev: 'verify', ok: res.ok, n: p.tests.length, ms: res.ms });
      idle = 0;
    }
  } finally { try { fs.rmSync(st(root, 'verify.lock')); } catch {} }
}

export const busy = (root) => {
  const lock = readJSON(st(root, 'verify.lock'), null);
  return (lock && alive(lock.pid)) || readJSON(st(root, 'verify-pending.json'), { tests: [] }).tests.length > 0;
};

// One line for Claude about the latest unreported run, then mark it reported.
export function report(root) {
  const r = readJSON(st(root, 'verify-result.json'), null);
  if (!r || r.reported) return null;
  r.reported = true; writeJSON(st(root, 'verify-result.json'), r);
  const names = r.tests.map((t) => path.basename(t)).slice(0, 4).join(', ') + (r.tests.length > 4 ? ', …' : '');
  return r.ok
    ? { ok: true, text: `TokenBuild verify: the ${r.tests.length} test file${r.tests.length > 1 ? 's' : ''} your edit can affect pass (${names}, ${(r.ms / 1000).toFixed(1)}s). No need to run the full suite for this change.` }
    : { ok: false, text: `TokenBuild verify: ${names} fails after your last edit: ${r.fail}\nFull log: ${r.log} (read only the lines you need). TokenBuild re-runs these tests after each edit.` };
}

export function lastResult(root) { return readJSON(st(root, 'verify-result.json'), null); }

// Stop: give a running check a moment to finish so a failure can't slip past the end of the turn.
export function waitIdle(root, ms) {
  const end = Date.now() + ms, cell = new Int32Array(new SharedArrayBuffer(4));
  while (busy(root) && Date.now() < end) Atomics.wait(cell, 0, 0, 200);
}
