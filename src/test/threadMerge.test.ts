// A thread continued on two computers keeps every message of both (SYNC-05, owner decision D-07), whatever order the entries arrive in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../domain/state/records';
import { capToolResult, entryId, threadLines, threadTip, TOOL_RESULT_CAP_BYTES, unionEntries, type ThreadEntry, type ThreadRole } from '../domain/state/threadEntries';

const THREAD = 'conv-test-thread';

/** Builds a chain of entries after `parent`, one second apart from `start`, written by `writer`. */
function chain(parent: ThreadEntry | undefined, writer: string, start: number, bodies: Array<[ThreadRole, unknown]>): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  let previous: string | null = parent ? parent.id : null;
  bodies.forEach(([role, body], index) => {
    const entry: ThreadEntry = { id: entryId(previous, role, body), thread: THREAD, parent: previous, at: new Date(start + index * 1000).toISOString(), writer, role, body };
    out.push(entry);
    previous = entry.id;
  });
  return out;
}

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);

test('two machines continuing one thread from the same tip keep all 9 entries, with the newer continuation as the main line', () => {
  const shared = chain(undefined, 'machine-shared', T0, [['user', { text: 'start' }], ['assistant', { text: 'hello' }], ['user', { text: 'more' }], ['assistant', { text: 'sure' }]]);
  const tip = shared[shared.length - 1];
  const a = chain(tip, 'machine-aaaa', T0 + 60_000, [['user', { text: 'A asks' }], ['assistant', { text: 'A answer' }], ['notice', { text: 'A note' }]]);
  const b = chain(tip, 'machine-bbbb', T0 + 120_000, [['user', { text: 'B asks' }], ['assistant', { text: 'B answer' }]]);
  const merged = unionEntries([...shared, ...a], [...shared, ...b]);
  assert.equal(merged.length, 9);
  assert.equal(new Set(merged.map((entry) => entry.id)).size, 9);

  const lines = threadLines(merged);
  // B's leaf is the newest, so B's continuation is the main line and A's three entries are the one branch, forked at the shared tip.
  assert.deepEqual(lines.main.map((entry) => entry.id), [...shared, ...b].map((entry) => entry.id));
  assert.equal(lines.branches.length, 1);
  assert.equal(lines.branches[0].forkAt, tip.id);
  assert.deepEqual(lines.branches[0].entries.map((entry) => entry.id), a.map((entry) => entry.id));
  assert.equal(threadTip(merged), b[b.length - 1].id);
  // The same result from either side, and from the entries in another order.
  assert.equal(canonicalJson(threadLines(unionEntries([...shared, ...b], [...shared, ...a]))), canonicalJson(lines));
  assert.equal(canonicalJson(threadLines([...merged].reverse())), canonicalJson(lines));
});

test('an entry id depends on the parent, the role and the body, and not on the time or the writer', () => {
  const parent = entryId(null, 'user', { text: 'hi' });
  assert.match(parent, /^[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(entryId(parent, 'assistant', { text: 'hello', n: 1 }), entryId(parent, 'assistant', { n: 1, text: 'hello' }));
  assert.notEqual(entryId(parent, 'assistant', { text: 'hello' }), entryId(parent, 'assistant', { text: 'hello!' }));
  assert.notEqual(entryId(parent, 'assistant', { text: 'hello' }), entryId(parent, 'notice', { text: 'hello' }));
  assert.notEqual(entryId(parent, 'assistant', { text: 'hello' }), entryId(null, 'assistant', { text: 'hello' }));
  // The same message written at two times by two machines is one entry.
  const first = chain(undefined, 'machine-aaaa', T0, [['user', { text: 'same' }]]);
  const second = chain(undefined, 'machine-bbbb', T0 + 5000, [['user', { text: 'same' }]]);
  assert.equal(first[0].id, second[0].id);
  const merged = unionEntries(first, second);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].writer, 'machine-aaaa', 'the earliest copy is kept whichever side is first');
  assert.equal(unionEntries(second, first)[0].writer, 'machine-aaaa');
});

test('D-12: a tool result over 2 MiB is shortened on a character boundary and records its original size; anything smaller is stored whole', () => {
  assert.equal(TOOL_RESULT_CAP_BYTES, 2_097_152);
  const big = capToolResult('a'.repeat(3 * 1024 * 1024));
  assert.equal(Buffer.byteLength(big.text, 'utf8'), 2_097_152);
  assert.equal(big.shortenedBytes, 3_145_728);
  const justUnder = 'b'.repeat(TOOL_RESULT_CAP_BYTES - 1);
  assert.deepEqual(capToolResult(justUnder), { text: justUnder });
  const exact = 'c'.repeat(TOOL_RESULT_CAP_BYTES);
  assert.equal(capToolResult(exact).shortenedBytes, undefined);
  // A three-byte character straddling the limit is dropped whole, never cut in half.
  const euros = capToolResult('€'.repeat(900_000));
  assert.ok(Buffer.byteLength(euros.text, 'utf8') <= TOOL_RESULT_CAP_BYTES);
  assert.ok(!euros.text.includes('�'));
  assert.equal(euros.text.length, 699_050);
  assert.equal(euros.shortenedBytes, 2_700_000);
});
