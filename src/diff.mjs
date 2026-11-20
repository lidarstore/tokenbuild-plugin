// Line diff (Myers O(ND)), zero deps. Gives up past `maxD` edits: then a diff is no cheaper than a re-read.
export function diffLines(a, b, maxD = 300) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length, off = N + M;
  if (N + M === 0) return [];
  const V = new Int32Array(2 * off + 2), trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(maxD, N + M) && found < 0; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = []; let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const v = trace[d], k = x - y;
    const pk = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + pk], py = px - pk;
    while (x > px && y > py) { ops.push(['=', A[x - 1]]); x--; y--; }
    if (x > px) { ops.push(['-', A[x - 1]]); x--; } else { ops.push(['+', B[y - 1]]); y--; }
  }
  while (x > 0 && y > 0) { ops.push(['=', A[x - 1]]); x--; y--; }
  ops.reverse();
  // Re-base onto full files: hunks carry new-file line numbers.
  const hunks = []; let nb = s + 1, cur = null;
  for (const [op, line] of ops) {
    if (op === '=') { cur = null; nb++; continue; }
    if (!cur) { cur = { at: nb, del: [], add: [] }; hunks.push(cur); }
    if (op === '-') cur.del.push(line); else { cur.add.push(line); nb++; }
  }
  return hunks;
}

// Compact text for Claude: only changed lines, numbered as in the current file.
export function formatHunks(hunks, maxLines = 120) {
  const out = []; let n = 0;
  for (const h of hunks) {
    const span = h.add.length ? `${h.at}-${h.at + h.add.length - 1}` : `${h.at} (deleted)`;
    out.push(`@@ line ${span}`);
    for (const l of h.del) { out.push('- ' + l); n++; }
    h.add.forEach((l, i) => { out.push(`+ ${h.at + i}: ${l}`); n++; });
    if (n > maxLines) return null;
  }
  return out.join('\n');
}
