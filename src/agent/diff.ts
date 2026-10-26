// Line-based unified diff for approval previews. Uses a longest-common-subsequence table, so it
// is bounded: very large inputs fall back to a whole-file replacement view.

const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { kind: ' ' | '-' | '+'; line: string; oldNo: number; newNo: number };

export function unifiedDiff(oldText: string, newText: string, label: string): string {
  if (oldText === newText) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = a.length * b.length > MAX_CELLS ? replaceAll(a, b) : lcsOps(a, b);
  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].kind === ' ') index += 1;
    if (index >= ops.length) break;
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    let lastChange = index;
    while (end < ops.length && end - lastChange <= CONTEXT * 2) {
      if (ops[end].kind !== ' ') lastChange = end;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + CONTEXT + 1);
    const slice = ops.slice(start, end);
    const oldStart = slice.find((op) => op.kind !== '+')?.oldNo ?? (slice[0].oldNo);
    const newStart = slice.find((op) => op.kind !== '-')?.newNo ?? (slice[0].newNo);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    hunks.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`, ...slice.map((op) => `${op.kind}${op.line}`));
    index = end;
  }
  return [`--- a/${label}`, `+++ b/${label}`, ...hunks].join('\n');
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: ' ', line: a[i], oldNo: i + 1, newNo: j + 1 }); i += 1; j += 1; }
    else if (i < a.length && (j === b.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) { ops.push({ kind: '-', line: a[i], oldNo: i + 1, newNo: j + 1 }); i += 1; }
    else { ops.push({ kind: '+', line: b[j], oldNo: i + 1, newNo: j + 1 }); j += 1; }
  }
  return ops;
}

function replaceAll(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line, index) => ({ kind: '-' as const, line, oldNo: index + 1, newNo: 1 })),
    ...b.map((line, index) => ({ kind: '+' as const, line, oldNo: a.length + 1, newNo: index + 1 }))
  ];
}
