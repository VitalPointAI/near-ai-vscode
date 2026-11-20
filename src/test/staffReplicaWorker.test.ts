// The memory-capped decode worker (D-05 as refined by D-43): bytes from outside the machine are inspected in one reused worker thread with
// resourceLimits and a time limit per job, with the same answer the in-process inspection gives, and a worker that runs out of memory or time costs
// a restart, never the extension host. Probe bytes are built here with a small varuint writer; no large fixture is committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyUpdate, createFoldDoc, createLocalDoc, encodeFullState, inspectState, inspectUpdate, localDelete, localInsert, snapshotOf
} from '../domain/replica/doc';
import type { InspectError, UpdateInspection } from '../domain/replica/doc';
import { DECODE_LIMITS, DecodeHost } from '../staff/replica/decodeHost';
import type { DecodeVerdict } from '../staff/replica/decodeHost';
import { embedUpdate } from './helpers/replicaYjs';

// ---- Probe builders ------------------------------------------------------------------------------------------------------------------------------

function writeVaruint(out: Uint8Array, at: number, value: number): number {
  let rest = value;
  let next = at;
  while (rest > 127) {
    out[next] = 128 | (rest % 128);
    next += 1;
    rest = Math.floor(rest / 128);
  }
  out[next] = rest;
  return next + 1;
}

// One client group of `count` GC structs of length 1, then an empty delete set: 2 bytes per struct.
function gcProbe(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 2 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, count);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, 0);
  for (let index = 0; index < count; index += 1) {
    out[at] = 0;
    out[at + 1] = 1;
    at += 2;
  }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

// The counts a worker verdict carries, from the in-process inspection of the same bytes.
function expected(found: UpdateInspection | { error: InspectError }): DecodeVerdict {
  if ('error' in found) return { ok: false, error: found.error };
  return { ok: true, structs: found.structs.length, deletes: found.deletes.length, clients: found.clients.length };
}

// An honest typed-text update, and one that deletes part of it, from one writer.
function typedUpdates(): { typed: Uint8Array; deleted: Uint8Array; doc: ReturnType<typeof createLocalDoc> } {
  const doc = createLocalDoc(4242);
  const typed = localInsert(doc, 0, 'Situation: the bridge at grid 1234 is open.');
  const deleted = localDelete(doc, 11, 4);
  return { typed, deleted, doc };
}

async function withHost<T>(host: DecodeHost, run: (host: DecodeHost) => Promise<T>): Promise<T> {
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

// ---- Task 1: the real worker gives the in-process answer --------------------------------------------------------------------------------------

test('the limits are the ones D-43 sets', () => {
  assert.deepEqual({ ...DECODE_LIMITS }, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4, timeoutMs: 5000 });
  assert.ok(Object.isFrozen(DECODE_LIMITS));
});

test('an honest update, a delete, a state and a snapshot inspected in the worker equal the in-process inspection', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const { typed, deleted } = typedUpdates();
    const typedVerdict = await host.inspect('update', typed);
    assert.deepEqual(typedVerdict, expected(inspectUpdate(typed)));
    assert.equal(typedVerdict.ok, true);
    assert.ok(typedVerdict.ok && typedVerdict.structs >= 1);

    const deletedVerdict = await host.inspect('update', deleted);
    assert.deepEqual(deletedVerdict, expected(inspectUpdate(deleted)));
    assert.ok(deletedVerdict.ok && deletedVerdict.deletes >= 1);

    const fold = createFoldDoc();
    assert.equal(applyUpdate(fold, typed), true);
    assert.equal(applyUpdate(fold, deleted), true);
    const state = encodeFullState(fold);
    assert.deepEqual(await host.inspect('state', state), expected(inspectState(state)));

    const snapshot = snapshotOf(fold);
    const snapshotVerdict = await host.inspect('snapshot', snapshot);
    assert.deepEqual(snapshotVerdict, { ok: true, structs: 0, deletes: 1, clients: 1 });
  });
});

test('the worker refuses what the in-process checks refuse, with the same reason', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const embed = embedUpdate(77);
    assert.deepEqual(await host.inspect('update', embed), expected(inspectUpdate(embed)));
    assert.deepEqual(await host.inspect('update', embed), { ok: false, error: 'forbidden-content' });
    assert.deepEqual(await host.inspect('update', Uint8Array.of(1, 2, 3)), { ok: false, error: 'malformed' });
    assert.deepEqual(await host.inspect('snapshot', Uint8Array.of(0, 0, 9)), { ok: false, error: 'malformed' });
    assert.deepEqual(await host.inspect('snapshot', new Uint8Array(0)), { ok: false, error: 'malformed' });
    // A kind the worker does not know is damage, not a crash.
    assert.deepEqual(await host.inspect('blob' as never, Uint8Array.of(0, 0)), { ok: false, error: 'malformed' });
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('two jobs in a row, and jobs asked at once, reuse one worker and are answered in order', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const { typed, deleted } = typedUpdates();
    assert.equal((await host.inspect('update', typed)).ok, true);
    assert.equal((await host.inspect('update', deleted)).ok, true);
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);

    const answers = await Promise.all([host.inspect('update', typed), host.inspect('update', Uint8Array.of(9)), host.inspect('update', deleted)]);
    assert.deepEqual(answers, [expected(inspectUpdate(typed)), { ok: false, error: 'malformed' }, expected(inspectUpdate(deleted))]);
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('a 4 MB 2,000,000-GC-struct probe and a 120,000-struct probe are refused too-large in the worker, which stays usable', async () => {
  await withHost(new DecodeHost(), async (host) => {
    const huge = gcProbe(2_000_000);
    assert.ok(huge.length > 4_000_000);
    assert.deepEqual(await host.inspect('update', huge), { ok: false, error: 'too-large' });
    assert.deepEqual(await host.inspect('state', huge), { ok: false, error: 'too-large' });
    const many = gcProbe(120_000);
    assert.ok(many.length < 256 * 1024, 'under the byte limit, so the struct count is what refuses it');
    assert.deepEqual(await host.inspect('update', many), { ok: false, error: 'too-large' });
    assert.deepEqual(await host.inspect('state', many), { ok: false, error: 'too-large' });

    const { typed } = typedUpdates();
    assert.deepEqual(await host.inspect('update', typed), expected(inspectUpdate(typed)));
    assert.equal(host.restarts, 0);
    assert.equal(host.starts, 1);
  });
});

test('close() ends the worker and a later inspect starts a new one', async () => {
  const host = new DecodeHost();
  const { typed } = typedUpdates();
  assert.equal(host.starts, 0, 'the worker starts lazily, on the first job');
  assert.equal((await host.inspect('update', typed)).ok, true);
  await host.close();
  assert.equal(host.starts, 1);
  await host.close();
  assert.equal((await host.inspect('update', typed)).ok, true);
  assert.equal(host.starts, 2);
  assert.equal(host.restarts, 0, 'closing is not a failure');
  // close() waits for a job already asked rather than cutting it off.
  const inFlight = host.inspect('update', typed);
  await host.close();
  assert.equal((await inFlight).ok, true);
  assert.equal(host.restarts, 0);
});
