// Auto-format: Claude never spends turns on formatting. Uses only the formatter the project already
// has configured (never downloads one). Two hooks:
//   PostToolUse (Edit|Write|MultiEdit) → `format --track`: remember the file (no formatting, ~1 ms of work)
//   Stop                                → `format`: format every tracked file once, at the end of the turn
// Formatting at the end of the turn, not after each edit, avoids "file modified since read" re-reads
// in the middle of a run of edits. Silent: prints nothing, so it costs zero tokens.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tbDir, readJSON, writeJSON, appendLedger } from './util.mjs';

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const onPath = (bin, root) => {
  for (const d of [path.join(root, 'node_modules', '.bin'), path.join(root, '.venv', 'bin'), path.join(root, 'venv', 'bin'), ...(process.env.PATH || '').split(path.delimiter)]) {
    const p = path.join(d, bin); if (d && exists(p)) return p;
  }
  return null;
};
const local = (root, bin) => { const p = path.join(root, 'node_modules', '.bin', bin); return exists(p) ? p : null; };
const any = (root, names) => names.some((n) => exists(path.join(root, n)));

const WEB = /\.(?:[cm]?[jt]sx?|json|jsonc|css|scss|less|html|vue|svelte|md|mdx|ya?ml|graphql)$/i;

// Which configured formatter handles this file? Returns [bin, ...args] or null.
export function formatterFor(file, root) {
  const ext = path.extname(file).toLowerCase();
  if (WEB.test(file)) {
    const biome = local(root, 'biome');
    if (biome && any(root, ['biome.json', 'biome.jsonc'])) return [biome, 'format', '--write', file];
    const prettier = local(root, 'prettier');
    const pkg = read(path.join(root, 'package.json'));
    if (prettier && (any(root, ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', '.prettierrc.toml']) || /"prettier"\s*:\s*[{"]/.test(pkg)))
      return [prettier, '--write', '--log-level', 'silent', file];
    return null;
  }
  if (ext === '.py') {
    const py = read(path.join(root, 'pyproject.toml'));
    const ruff = onPath('ruff', root);
    if (ruff && (/\[tool\.ruff/.test(py) || any(root, ['ruff.toml', '.ruff.toml']))) return [ruff, 'format', '--quiet', file];
    const black = onPath('black', root);
    if (black && /\[tool\.black\]/.test(py)) return [black, '--quiet', file];
    return null;
  }
  if (ext === '.go') { const g = onPath('gofmt', root); return g && exists(path.join(root, 'go.mod')) ? [g, '-w', file] : null; }
  if (ext === '.rs') {
    const r = onPath('rustfmt', root); const cargo = read(path.join(root, 'Cargo.toml'));
    if (!r || !cargo) return null;
    const ed = any(root, ['rustfmt.toml', '.rustfmt.toml']) ? [] : ['--edition', (cargo.match(/edition\s*=\s*"(\d{4})"/) || [, '2021'])[1]];
    return [r, ...ed, file];
  }
  if (ext === '.swift') { const s = onPath('swift-format', root); return s && exists(path.join(root, '.swift-format')) ? [s, '--in-place', file] : null; }
  return null;
}

const statePath = (root, sid) => path.join(tbDir(root), 'state', `fmt-${String(sid || 'none').replace(/[^\w-]/g, '')}.json`);

export function track(input, root) {
  const f = input.tool_input?.file_path;
  if (!f) return;
  const abs = path.isAbsolute(f) ? f : path.join(root, f);
  if (!abs.startsWith(root + path.sep)) return; // only this project's files
  const p = statePath(root, input.session_id);
  const s = readJSON(p, { files: [] });
  if (!s.files.includes(abs)) { s.files.push(abs); writeJSON(p, s); }
}

// Format tracked files. Returns how many files the formatter actually changed.
export function flush(input, root) {
  const p = statePath(root, input.session_id);
  const { files = [] } = readJSON(p, {});
  try { fs.rmSync(p); } catch {}
  if (readJSON(path.join(tbDir(root), 'config.json'), {}).format === false) return 0;
  let changed = 0;
  for (const f of files) {
    const cmd = exists(f) && formatterFor(f, root);
    if (!cmd) continue;
    const before = read(f);
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, timeout: 15_000, stdio: 'ignore' });
    if (r.status === 0 && read(f) !== before) changed++;
  }
  if (changed) appendLedger(root, { ev: 'format', n: changed });
  return changed;
}
