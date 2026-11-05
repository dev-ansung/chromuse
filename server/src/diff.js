// Line-level diff (longest common subsequence). Documents are small, so the O(n·m) table is fine; very large inputs fall back to
// "everything changed" rather than blocking.

const MAX_CELLS = 4_000_000;

const toLines = (s) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/**
 * @returns {{ added: number, removed: number, lines: { op: "+" | "-" | " ", text: string }[] }}
 */
export function diffLines(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return { added: b.length, removed: a.length, lines: [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))] };
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push({ op: "+", text: b[j++] });
      added++;
    } else {
      lines.push({ op: "-", text: a[i++] });
      removed++;
    }
  }
  return { added, removed, lines };
}

/** Keeps changed lines plus `context` unchanged lines around them, with "…" markers where lines were skipped. */
export function compactDiff(lines, context = 2) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = false;
  lines.forEach((l, i) => {
    if (keep[i]) {
      out.push(l);
      skipped = false;
    } else if (!skipped) {
      out.push({ op: " ", text: "…" });
      skipped = true;
    }
  });
  return out;
}
