// A thread continued on two computers keeps every message of both (SYNC-05, owner decision D-07), whatever order the entries arrive in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../domain/state/records';
import * as threadModule from '../domain/state/threadEntries';
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

/** A small seeded generator (xorshift32), so a failing run can be replayed from its seed. */
function rng(seed: number): { int(n: number): number; chance(p: number): boolean } {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  return { int: (n) => Math.floor(next() * n), chance: (p) => next() < p };
}

/** A random thread: a tree of 4 to 28 entries, each following a random earlier entry, with many entries sharing one second (so ties matter). */
function randomThread(seed: number): ThreadEntry[] {
  const random = rng(seed);
  const entries: ThreadEntry[] = [];
  const writers = ['machine-aaaa', 'machine-bbbb', 'machine-cccc'];
  for (let index = 0, count = 4 + random.int(25); index < count; index++) {
    const parent: ThreadEntry | undefined = index === 0 ? undefined : entries[random.chance(0.6) ? entries.length - 1 : random.int(entries.length)];
    const role: ThreadRole = (['user', 'assistant', 'tool-call', 'tool-result', 'notice'] as const)[random.int(5)];
    const body = { text: `entry ${index} of seed ${seed}` };
    const id = entryId(parent ? parent.id : null, role, body);
    entries.push({ id, thread: THREAD, parent: parent ? parent.id : null, at: new Date(T0 + random.int(12) * 1000).toISOString(), writer: writers[random.int(3)], role, body });
  }
  return entries;
}

function shuffled<T>(items: readonly T[], random: ReturnType<typeof rng>): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = random.int(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const seen = (lines: ReturnType<typeof threadLines>): string[] => [...lines.main, ...lines.branches.flatMap((branch) => branch.entries)].map((entry) => entry.id);

test('delivering one machine\'s entries in any order and in partial batches never drops an entry, and the end state equals delivering them all at once (500 seeded threads)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const random = rng(seed + 5000);
    const full = randomThread(seed);
    const allAtOnce = unionEntries(full, []);
    const wanted = canonicalJson(threadLines(allAtOnce));
    // The receiving machine already holds some of the thread; the rest arrives in shuffled batches, some of them repeated.
    let held = unionEntries(full.filter(() => random.chance(0.3)), []);
    const pending = shuffled(full, random);
    while (pending.length > 0) {
      const batch = pending.splice(0, 1 + random.int(5));
      held = unionEntries(held, random.chance(0.3) ? [...batch, ...batch] : batch);
      const ids = held.map((entry) => entry.id);
      for (const entry of batch) assert.ok(ids.includes(entry.id), `delivered entry present, seed ${seed}`);
      const shown = seen(threadLines(held));
      assert.equal(shown.length, held.length, `every held entry is shown exactly once, seed ${seed}`);
      assert.equal(new Set(shown).size, held.length, `no entry is shown twice, seed ${seed}`);
    }
    assert.equal(canonicalJson(held), canonicalJson(allAtOnce), `union equals all-at-once, seed ${seed}`);
    assert.equal(canonicalJson(threadLines(held)), wanted, `lines equal all-at-once, seed ${seed}`);
    assert.equal(threadTip(held), threadTip(allAtOnce));
  }
});

test('thread union is commutative, associative and idempotent (500 seeded threads split between three machines)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const random = rng(seed + 8000);
    const full = randomThread(seed);
    const [a, b, c] = [full.filter(() => random.chance(0.5)), full.filter(() => random.chance(0.5)), full.filter(() => random.chance(0.5))];
    const text = (entries: ThreadEntry[]): string => canonicalJson(entries);
    assert.equal(text(unionEntries(a, b)), text(unionEntries(b, a)), `commutative, seed ${seed}`);
    assert.equal(text(unionEntries(unionEntries(a, b), c)), text(unionEntries(a, unionEntries(b, c))), `associative, seed ${seed}`);
    assert.equal(text(unionEntries(a, a)), text(unionEntries(a, [])), `idempotent, seed ${seed}`);
    // Every line shown from the merged copies is a line of the whole thread's arrangement or sits in a branch of it: nothing is invented or lost.
    const merged = unionEntries(unionEntries(a, b), c);
    assert.deepEqual([...seen(threadLines(merged))].sort(), merged.map((entry) => entry.id).sort(), `seed ${seed}`);
  }
});

test('SYNC-05 ordering edge: entries with equal times order by writer, then by id, so the main line is the same whatever the delivery order', () => {
  const root = chain(undefined, 'machine-aaaa', T0, [['user', { text: 'root' }]])[0];
  const same = new Date(T0 + 5000).toISOString();
  const make = (writer: string, text: string): ThreadEntry => ({ id: entryId(root.id, 'assistant', { text }), thread: THREAD, parent: root.id, at: same, writer, role: 'assistant', body: { text } });
  const low = make('machine-aaaa', 'low writer');
  const high = make('machine-zzzz', 'high writer');
  for (const order of [[root, low, high], [high, low, root], [low, root, high]]) {
    const lines = threadLines(order);
    assert.deepEqual(lines.main.map((entry) => entry.id), [root.id, high.id], 'the greater writer is the newest leaf at an equal time');
    assert.deepEqual(lines.branches, [{ forkAt: root.id, entries: [low] }]);
  }
  // Same writer and time: the greater id wins, and the branches order by their first entry.
  const twinA = make('machine-aaaa', 'twin one');
  const twinB = make('machine-aaaa', 'twin two');
  const [loserId, winnerId] = [twinA.id, twinB.id].sort();
  for (const order of [[root, twinA, twinB], [twinB, root, twinA]]) {
    const lines = threadLines(order);
    assert.equal(lines.main[lines.main.length - 1].id, winnerId);
    assert.equal(lines.branches[0].entries[0].id, loserId);
  }
  // Two branches off one fork point are ordered by their first entry, not by arrival.
  const third = make('machine-bbbb', 'third');
  const lines = threadLines([third, high, low, root]);
  assert.deepEqual(lines.branches.map((branch) => branch.entries[0].writer), ['machine-aaaa', 'machine-bbbb']);
});

test('an entry whose parent has not arrived is still shown, as its own branch, and joins the thread when the parent arrives', () => {
  const entries = chain(undefined, 'machine-aaaa', T0, [['user', { text: 'one' }], ['assistant', { text: 'two' }], ['user', { text: 'three' }], ['assistant', { text: 'four' }]]);
  const partial = [entries[0], entries[2], entries[3]];
  const early = threadLines(partial);
  assert.deepEqual(early.main.map((entry) => entry.id), [entries[0].id]);
  assert.deepEqual(early.branches, [{ forkAt: entries[1].id, entries: [entries[2], entries[3]] }]);
  assert.equal(seen(early).length, 3);
  const whole = threadLines([...partial, entries[1]]);
  assert.deepEqual(whole.main.map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.deepEqual(whole.branches, []);
  assert.equal(threadTip([]), undefined);
  assert.deepEqual(threadLines([]), { main: [], branches: [] });
  // Corrupt data (entries that name each other as parent) is shown too, and cannot hang the arrangement.
  const looped: ThreadEntry[] = [{ ...entries[0], id: 'loopa', parent: 'loopb' }, { ...entries[1], id: 'loopb', parent: 'loopa' }, entries[0]];
  assert.equal(seen(threadLines(looped)).length, 3);
});

test('a thread has no tombstone and no function that removes an entry (threads are archived, never deleted)', () => {
  const names = Object.keys(threadModule);
  assert.deepEqual(names.filter((name) => /remove|delete|drop|prune|purge|clear|tombstone/i.test(name)), []);
  const merged = unionEntries(chain(undefined, 'machine-aaaa', T0, [['user', { text: 'a' }]]), chain(undefined, 'machine-bbbb', T0, [['user', { text: 'b' }]]));
  assert.equal(merged.length, 2, 'two separate first entries are two entries');
  assert.equal(threadLines(merged).branches.length, 1);
  assert.equal(threadLines(merged).branches[0].forkAt, null);
});
