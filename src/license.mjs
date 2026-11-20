// Subscription check. The free Waste Audit needs nothing. Every other tool needs an active trial
// or plan, confirmed online with the user's CLI key and cached locally, so hooks stay offline and fast:
//   online:  `login`, `init`, `sync`, and the MCP server at the start of each Claude Code session
//   offline: hooks and `run` only read the cache (a few microseconds)
// The cache is trusted for GRACE after the last successful check, so a flight or an outage
// doesn't switch the tools off; a cancelled plan stops them at the next online check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GRACE = 14 * 864e5;
const REFRESH = 12 * 36e5;
const API = () => process.env.TOKENBUILD_API || 'https://app.tokenbuild.ai';
export const BILLING = 'https://app.tokenbuild.ai/billing';

export const home = () => process.env.TOKENBUILD_HOME || path.join(os.homedir(), '.tokenbuild');
const keyFile = () => path.join(home(), 'key');
const cacheFile = () => path.join(home(), 'license.json');

export function readKey() {
  // Env first: TOKENBUILD_KEY (CI, or the plugin's MCP server), then the plugin's saved option (hooks).
  // An unset plugin option can arrive as the literal "${user_config.cli_key}", so ignore anything with "${".
  for (const v of [process.env.TOKENBUILD_KEY, process.env.CLAUDE_PLUGIN_OPTION_CLI_KEY]) if (v && v.trim() && !v.includes('${')) return v.trim();
  try { return fs.readFileSync(keyFile(), 'utf8').trim(); } catch { return ''; }
}
export function saveKey(key) {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(), key.trim() + '\n', { mode: 0o600 });
}
export function forget() { for (const f of [keyFile(), cacheFile()]) try { fs.rmSync(f); } catch {} }

const readCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return null; } };

// Offline: is the cached licence active and recent enough? { ok, reason }
export function licensed(now = Date.now()) {
  const c = readCache();
  if (!c) return { ok: false, reason: 'no-license' };
  if (!c.active) return { ok: false, reason: 'inactive', status: c.status };
  if (now - c.checkedAt > GRACE) return { ok: false, reason: 'stale' };
  return { ok: true, plan: c.plan };
}

// Online: ask the API and update the cache. { ok, active, status, plan, error }
export async function check(key = readKey(), { timeout = 8000 } = {}) {
  if (!key) return { ok: false, error: 'no-key' };
  let r;
  try { r = await fetch(API() + '/v1/license', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) }); }
  catch { return { ok: false, error: 'offline' }; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { writeCache({ active: false, status: 'invalid-key' }); return { ok: false, error: 'bad-key', message: j.error }; }
  if (!r.ok) return { ok: false, error: 'server', message: j.error };
  writeCache({ active: !!j.active, status: j.status, plan: j.plan });
  return { ok: true, active: !!j.active, status: j.status, plan: j.plan };
}
function writeCache(c) {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cacheFile(), JSON.stringify({ ...c, checkedAt: Date.now() }) + '\n', { mode: 0o600 });
}

// Refresh in the background when the cache is older than REFRESH (MCP server start).
export function refreshIfDue(now = Date.now()) {
  const c = readCache();
  if (!readKey() || (c && now - c.checkedAt < REFRESH)) return Promise.resolve(null);
  return check(undefined, { timeout: 5000 }).catch(() => null);
}

// One short line explaining what to do. Kept short: it may land in Claude's context.
export function explain(l = licensed()) {
  if (l.reason === 'no-license') return readKey() ? `TokenBuild: couldn't confirm your plan yet. Run: tokenbuild login` : `TokenBuild tools need an active trial or plan. Start one at ${BILLING}, then run: tokenbuild login <key>`;
  if (l.reason === 'stale') return 'TokenBuild: your plan hasn\'t been confirmed for 14 days. Connect to the internet and run: tokenbuild login';
  if (l.status === 'invalid-key') return `TokenBuild: this CLI key is no longer valid. Create a new one at ${BILLING}, then run: tokenbuild login <key>`;
  return `TokenBuild: no active trial or plan (${l.status || 'none'}). Renew at ${BILLING}`;
}
