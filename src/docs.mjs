// Local Docs Oracle (tb_docs): how does this library function work, at the version actually installed?
// JS/TS: declarations + doc comments from the package's .d.ts files (or @types). Python: signature and
// docstring via inspect (imports the module, as running the code would). Go: `go doc`. ~200-600 tokens,
// no web fetches, no guessing at an API that changed between versions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJSON } from './util.mjs';

const CAP = 2600;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dtsFiles(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > 400) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dtsFiles(p, out, depth + 1); else if (/\.d\.[cm]?ts$/.test(e.name)) out.push(p);
  }
  return out;
}

// The declaration at line i: doc comment above + the statement (balanced braces, <= 30 lines).
function snippet(lines, i) {
  let s = i;
  if (/^\s*\*\/\s*$/.test(lines[i - 1] || '') || /\*\/\s*$/.test(lines[i - 1] || '')) { s = i - 1; while (s > 0 && !/\/\*\*/.test(lines[s])) s--; }
  let depth = 0, e = i;
  for (; e < Math.min(lines.length, i + 30); e++) {
    for (const ch of lines[e]) { if (ch === '{' || ch === '(') depth++; else if (ch === '}' || ch === ')') depth--; }
    if (depth <= 0 && /[;}]\s*$|\)\s*:\s*[^;{]+;?\s*$/.test(lines[e])) break;
  }
  return lines.slice(Math.max(s, i - 25), e + 1).join('\n');
}

function js(root, name, pkg) {
  const nm = path.join(root, 'node_modules');
  const pj = readJSON(path.join(root, 'package.json'), {});
  const deps = pkg ? [pkg] : Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies });
  const decl = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum|namespace|abstract class)\\s+${esc(name)}\\b|^\\s*(?:readonly\\s+|static\\s+)?${esc(name)}\\??\\s*[(<:]`);
  const hits = [];
  for (const d of deps) {
    for (const base of [path.join(nm, d), path.join(nm, '@types', d.replace(/^@([^/]+)\//, '$1__'))]) {
      if (!fs.existsSync(base)) continue;
      const ver = readJSON(path.join(base, 'package.json'), {}).version || '?';
      for (const f of dtsFiles(base)) {
        let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!t.includes(name)) continue;
        const lines = t.split('\n');
        for (let i = 0; i < lines.length && hits.length < 3; i++) if (decl.test(lines[i])) { hits.push(`// ${path.basename(base) === d.split('/').pop() ? d : '@types/' + d}@${ver}  ${path.relative(nm, f)}:${i + 1}\n${snippet(lines, i)}`); i += 2; }
        if (hits.length >= 3) return hits;
      }
    }
    if (hits.length) return hits;
  }
  return hits;
}

function py(root, q) {
  const code = `import importlib,inspect,sys
q=sys.argv[1];parts=q.split('.');obj=None
for i in range(len(parts),0,-1):
  try:
    obj=importlib.import_module('.'.join(parts[:i]));rest=parts[i:];break
  except Exception: pass
if obj is None: print('NOTFOUND');sys.exit(0)
try:
  for p in rest: obj=getattr(obj,p)
except AttributeError: print('NOTFOUND');sys.exit(0)
ver=''
try:
  import importlib.metadata as md;ver=md.version(parts[0])
except Exception: pass
src=''
try: src=inspect.getsourcefile(obj)+':'+str(inspect.getsourcelines(obj)[1])
except Exception: pass
sig=''
try: sig=str(inspect.signature(obj))
except Exception: pass
print('# '+q+(' '+ver if ver else '')+('  '+src if src else ''));print(q.split('.')[-1]+sig);print((inspect.getdoc(obj) or '')[:1800])`;
  const r = spawnSync(fs.existsSync(path.join(root, '.venv/bin/python')) ? path.join(root, '.venv/bin/python') : 'python3', ['-c', code, q], { cwd: root, encoding: 'utf8', timeout: 8000 });
  const out = String(r.stdout || '').trim();
  return out && out !== 'NOTFOUND' ? [out] : [];
}

function go(root, q) {
  const r = spawnSync('go', ['doc', q], { cwd: root, encoding: 'utf8', timeout: 8000 });
  return r.status === 0 && r.stdout.trim() ? [r.stdout.trim()] : [];
}

// query: "name", "pkg#name" (JS), "pkg.module.name" (Python), "pkg.Name" (Go).
export function lookup(root, query, lang) {
  const q = String(query || '').trim();
  if (!q) return 'Pass a symbol, e.g. "zod#object", "requests.get" or "net/http.Get".';
  const L = lang || (fs.existsSync(path.join(root, 'go.mod')) ? 'go' : fs.existsSync(path.join(root, 'package.json')) ? 'js' : 'py');
  let hits = [];
  if (L === 'js') { const [pkg, name] = q.includes('#') ? q.split('#') : [null, q.split('.').pop()]; hits = js(root, name, pkg); }
  else if (L === 'go') hits = go(root, q);
  else hits = py(root, q);
  if (!hits.length && L === 'js' && !q.includes('#')) hits = py(root, q).length ? py(root, q) : [];
  if (!hits.length) return `No installed declaration found for "${q}". Check the package name (JS: "package#symbol"), or that dependencies are installed.`;
  let out = hits.join('\n\n');
  if (out.length > CAP) out = out.slice(0, CAP - 1) + '…';
  return out;
}
