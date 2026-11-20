// Output Shrinker: runs a noisy command (tests, builds, installs, linters), saves the full log
// locally and prints only what Claude needs: errors with context, warnings, and the summary.
// Plain code, zero tokens to compute. The full log stays on disk for a targeted Read if needed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tbDir, appendLedger, tokens, num, mkdirp } from './util.mjs';

export const BUDGET = 1500;   // max tokens we print for a long log
const VERBATIM = 600;         // logs at or under this many tokens are printed as-is (minus ANSI noise)
const KEEP_LOGS = 20;
const MAX_BYTES = 32 << 20;   // keep at most 32 MB in memory; the middle is dropped beyond that

// Commands whose output is usually long and mostly noise. Matched against the first command
// of a line (after env assignments, `cd x &&`, and package-runner prefixes).
const NOISY = new RegExp('^(?:' + [
  '(?:npm|pnpm|yarn|bun)\\s+(?:(?:run\\s+)?(?:test|build|lint|typecheck|check|ci)\\b|install|i|ci|add|update)\\b',
  '(?:npx|pnpm\\s+exec|pnpm\\s+dlx|yarn\\s+dlx|bunx)\\s+(?:jest|vitest|mocha|tsc|eslint|playwright|cypress|next\\s+build|vite\\s+build|webpack|turbo|nx)\\b',
  '(?:jest|vitest|mocha|tsc|eslint|playwright|turbo|nx)\\b',
  'node\\s+--test\\b',
  '(?:python3?\\s+-m\\s+)?(?:pytest|unittest|tox|nox|mypy|pip\\s+install|pip3\\s+install|uv\\s+(?:sync|pip\\s+install)|poetry\\s+install)\\b',
  'go\\s+(?:test|build|vet|mod\\s+download|generate)\\b', 'cargo\\s+(?:test|build|check|clippy)\\b',
  '(?:mvn|\\./mvnw|gradle|\\./gradlew)\\b', 'make\\b', 'cmake\\s+--build\\b', 'ctest\\b',
  '(?:bundle\\s+(?:exec\\s+)?)?(?:rspec|rake|bundle\\s+install)\\b', 'swift\\s+(?:build|test)\\b', 'xcodebuild\\b',
  'dotnet\\s+(?:build|test|restore)\\b', 'docker\\s+(?:build|compose\\s+build)\\b', 'composer\\s+install\\b', '(?:php\\s+)?(?:vendor/bin/)?phpunit\\b',
].join('|') + ')');

export function isNoisy(command) {
  const c = String(command || '').trim();
  if (!c || /(^|[\s;&|])\.?tokenbuild\/run\b|\btokenbuild\s+run\b/.test(c)) return false; // already wrapped
  if (/\|\s*(?:head|tail|grep|rg|less|wc|jq)\b|>\s*\S|--watch\b|\s-w\b/.test(c)) return false; // already shaped, or interactive
  const first = c.split(/\s*(?:&&|;)\s*/).find((p) => !/^cd\s/.test(p)) || '';
  return NOISY.test(first.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ''));
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const ERR = /(?:\berror\b|\berrors?:|\bERR!|\bfail(?:ed|ure|s)?\b|\bFAIL\b|\bpanic(?:ked)?\b|\bexception\b|Traceback|\bassert(?:ion)?(?:Error)?\b|\bexpected\b|\breceived\b|\bfatal\b|\bundefined reference\b|\bcannot\b|\bcan't\b|\bunable to\b|\bnot found\b|\bdenied\b|\bsegmentation fault\b|\bunhandled\b|[✗✖×✘]|^\s*●|^\s*E\s{2,}|^not ok\b|-->\s+\S+:\d+)/i;
const WARN = /(?:\bwarn(?:ing)?s?\b|\bdeprecat)/i;
const NOISE = /^(?:\s*$|.*(?:\d{1,3}%\s*[|█▏▎▍▌▋▊▉#=\-]|[█▓▒░⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Downloading|Downloaded|Resolving|Fetching|Progress:|Using cached|Requirement already satisfied|Collecting\s|Already up[- ]to[- ]date)|\s*Compiling \S+ v\d|go: downloading|npm (?:notice|WARN deprecated)|> Task :|\s*(?:✓|✔|√|PASS\b|ok\s{2,}|test \S+ \.\.\. ok)|\s*\d+ passing\b|\S+\s+[.sFExX]+\s+\[\s*\d+%\]$)/i;
const SUMMARY = /\b(?:tests?|passed|failed|errors?|warnings?|suites?|total|duration|took|finished|built|done|summary)\b/i;

// Pure: condense a log. Returns { text, total, shown } (line counts).
export function shrink(raw, { exit = 0, budget = BUDGET } = {}) {
  const clean = String(raw).replace(ANSI, '').split('\n').map((l) => { const i = l.lastIndexOf('\r', l.length - 2); return (i >= 0 ? l.slice(i + 1) : l).replace(/\s+$/, ''); });
  while (clean.length && !clean.at(-1)) clean.pop();
  const total = clean.length;
  const plain = clean.join('\n');
  if (tokens(plain) <= VERBATIM) return { text: plain, total, shown: total };

  const keep = new Uint8Array(total); // 0 hide, 1 context, 2 important
  const mark = (i, v = 1) => { if (i >= 0 && i < total && keep[i] < v) keep[i] = v; };
  let errors = 0, warns = 0;
  for (let i = 0; i < total; i++) {
    const l = clean[i];
    if (ERR.test(l) && !NOISE.test(l)) {
      if (!/\b\d+\s+(?:failed|failures?|errors?)\b/i.test(l)) errors++; // "1 failed, 9 passed" is a summary
      mark(i, 2);
      for (let j = i - 1; j >= i - 2; j--) if (j >= 0 && clean[j] && !NOISE.test(clean[j])) mark(j);
      // Follow the block that explains the error (indented lines, code frames, stack frames,
      // diffs), across single blank lines, until the next unindented line.
      for (let j = i + 1, n = 0; j < total && n < 16; j++, n++) {
        const l = clean[j];
        if (!l) { if (!clean[j + 1] || !/^\s/.test(clean[j + 1])) break; continue; }
        if (!/^\s/.test(l) && n >= 2) break;
        if (/^\s+at\s/.test(clean[j - 1] || '') && !/^\s+at\s/.test(l)) break; // stack trace ended
        mark(j);
      }
    } else if (WARN.test(l) && !NOISE.test(l) && warns < 10) { warns++; mark(i, 2); }
  }
  for (let i = 0; i < Math.min(3, total); i++) if (!NOISE.test(clean[i])) mark(i);
  // The tail is where runners print their summary: keep summary-looking lines near the end,
  // and the last few lines whatever they are.
  for (let i = total - 1, n = 0; i >= 0 && n < 4; i--) if (clean[i] && !NOISE.test(clean[i])) { mark(i); n++; }
  for (let i = total - 1, n = 0; i >= 0 && n < 3; i--) if (clean[i]) { mark(i); n++; } // never show nothing
  for (let i = Math.max(0, total - 40); i < total; i++) if (SUMMARY.test(clean[i]) && !NOISE.test(clean[i]) && /\d/.test(clean[i])) mark(i);

  // Collapse runs of identical lines, render gaps, and stop at the budget.
  const out = []; let used = 0, gap = 0, shown = 0, cut = false;
  for (let i = 0; i < total; i++) {
    if (!keep[i]) { if (clean[i]) gap++; continue; } // hidden blank lines aren't worth a marker
    let rep = 1; while (i + rep < total && keep[i + rep] && clean[i + rep] === clean[i]) rep++;
    const line = (gap ? `  … ${num(gap)} line${gap > 1 ? 's' : ''} hidden\n` : '') + clean[i].slice(0, 400) + (rep > 1 ? `  (×${rep})` : '');
    if (used + tokens(line) > budget && i < total - 12) { // over budget: jump to the summary tail
      cut = true; gap += (total - 12) - i; i = total - 13; continue;
    }
    out.push(line); used += tokens(line); shown += rep; gap = 0; i += rep - 1;
  }
  if (gap) out.push(`  … ${num(gap)} line${gap > 1 ? 's' : ''} hidden`);
  if (cut) out.push('  … more matches cut to stay under budget: grep the full log for them');
  return { text: out.join('\n'), total, shown, errors };
}

const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

// Run a command, save the full log, print the condensed view. Returns the exit code.
export async function run(argv, root, { write = (s) => process.stdout.write(s), passthrough = '' } = {}) {
  const cmd = argv.length === 1 ? argv[0] : argv.map(shq).join(' ');
  if (!cmd) { write('Usage: tokenbuild run <command>\n'); return 2; }
  if (passthrough) { // no active plan: run the command exactly as if TokenBuild weren't there
    const c = spawn(cmd, { cwd: process.cwd(), shell: process.env.SHELL || true, stdio: 'inherit' });
    const code = await new Promise((ok) => { c.on('error', () => ok(127)); c.on('close', (x, sig) => ok(x ?? (sig ? 128 : 1))); });
    process.stderr.write(`[${passthrough}]\n`);
    return code;
  }
  // One pipe for both streams (via the shell) so errors stay next to the lines that caused them.
  const child = spawn(`{ ${cmd}\n} 2>&1`, { cwd: process.cwd(), shell: process.env.SHELL || true, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  const chunks = []; let bytes = 0, dropped = 0;
  const take = (c) => { chunks.push(c); bytes += c.length; while (bytes > MAX_BYTES && chunks.length > 2) { const x = chunks.splice(1, 1)[0]; bytes -= x.length; dropped += x.length; } };
  child.stdout.on('data', take); child.stderr.on('data', take);
  const stop = (sig) => () => { child.kill(sig); };
  const handlers = { SIGINT: stop('SIGINT'), SIGTERM: stop('SIGTERM') };
  for (const [s, h] of Object.entries(handlers)) process.on(s, h);
  const exit = await new Promise((ok) => { child.on('error', () => ok(127)); child.on('close', (code, sig) => ok(code ?? (sig ? 128 : 1))); });
  for (const [s, h] of Object.entries(handlers)) process.off(s, h);

  let raw = Buffer.concat(chunks).toString('utf8');
  if (dropped) raw = raw.replace(/\n/, `\n[… ${num(dropped)} bytes dropped from the middle …]\n`);
  const r = shrink(raw, { exit });
  const full = tokens(raw.replace(ANSI, ''));
  if (r.shown === r.total) { write(r.text + (r.text ? '\n' : '')); if (exit) write(`[exit ${exit}]\n`); return exit; }

  const dir = path.join(tbDir(root), 'logs');
  mkdirp(dir);
  const name = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${cmd.replace(/[^\w]+/g, '-').slice(0, 40).replace(/^-|-$/g, '')}.log`;
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, raw);
  try { const old = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort(); for (const f of old.slice(0, -KEEP_LOGS)) fs.rmSync(path.join(dir, f)); } catch {}
  const rel = path.relative(process.cwd(), logPath);
  const head = `[tokenbuild] exit ${exit} · ${num(r.total)} lines → ${num(r.shown)} shown${r.errors ? ` · ${num(r.errors)} error line${r.errors > 1 ? 's' : ''}` : ''} · full log: ${rel}`;
  write(`${head}\n${r.text}\n`);
  appendLedger(root, { ev: 'shrink', tok: Math.max(0, full - tokens(head + r.text)), full });
  return exit;
}
