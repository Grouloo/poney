// Minimal unified diff (LCS based) for showing file changes in the UI.

export function unifiedDiff(before, after, name, context = 3) {
  if (before === after) return '';
  const a = before ? before.split('\n') : [];
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return `--- ${name}\n+++ ${name}\n(file too large to diff: ${a.length} -> ${b.length} lines)`;

  // Trim common prefix/suffix to keep the LCS table small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);

  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', a[k]]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', A[i]]); i++; }
    else { ops.push(['+', B[j]]); j++; }
  }
  for (let k = a.length - suf; k < a.length; k++) ops.push([' ', a[k]]);

  // Group into hunks.
  const out = [`--- ${name}`, `+++ ${name}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    let start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') { end++; continue; }
      let run = 0;
      while (end + run < ops.length && ops[end + run][0] === ' ') run++;
      if (end + run >= ops.length || run > context * 2) { end = Math.min(ops.length, end + context); break; }
      end += run;
    }
    let oldLine = 1;
    let newLine = 1;
    for (let t = 0; t < start; t++) { if (ops[t][0] !== '+') oldLine++; if (ops[t][0] !== '-') newLine++; }
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((o) => o[0] !== '+').length;
    const newCount = hunk.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const [op, line] of hunk) out.push(op + line);
    k = end;
  }
  return out.join('\n');
}
