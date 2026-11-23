import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkpointHash, checkpointHeads, orderTipOf, signCheckpoint, type SignedCheckpoint } from '../domain/replica/checkpoint';
import { buildFromCompaction, docText, textHashOf } from '../domain/replica/doc';
import { openBlob } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import { createWitness, witnessCheckpoint } from '../domain/replica/hubWitness';
import { staticRosterView } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import { compactionCheckpoint, prepareCompaction } from '../staff/replica/compactor';
import { hubMemoryOf, hubWitnessKey, type HubMemory } from '../staff/replica/hubSync';
import { productOutput } from '../staff/replica/productFeed';
import { createWorld, fixedSigner } from './helpers/replicaWorld';

const project = 'a'.repeat(32);
const hub = fixedSigner('compaction-hub');
const otherHub = fixedSigner('different-compaction-hub');
const oldRoster = 'b'.repeat(64);
const rosterHead = 'c'.repeat(64);
const members = [hub, otherHub].map(({ writer, publicKey }, index) => ({
  member: `mbr-hub-${index}`, name: 'Example hub', roles: ['member'], devices: [{ writer, publicKey }]
}));

function roster(currentSigners = [hub.writer, otherHub.writer]) {
  return staticRosterView({ rosters: [
    { hash: oldRoster, members, checkpointSigners: [hub.writer, otherHub.writer] },
    { hash: rosterHead, members, checkpointSigners: currentSigners }
  ] });
}

function checkpoint({ by = hub, projectId = project, tip = 'd'.repeat(64), version = 2 }: {
  by?: typeof hub; projectId?: string; tip?: string; version?: 1 | 2;
} = {}): SignedCheckpoint {
  return signCheckpoint(by.signer, {
    type: 'checkpoint', v: version, project: projectId, signer: by.writer, rosterHead: oldRoster,
    streams: [{
      stream: project, count: 1, orderTip: tip,
      heads: [{
        writer: by.writer, seq: 0, hash: 'e'.repeat(64),
        ...(version === 2 ? { roster: oldRoster, lamport: 1 } : {})
      }]
    }]
  });
}

const initial = () => createWitness(hub.writer, project);

function storage() {
  const rows = new Map<string, string>();
  return {
    rows,
    memory: hubMemoryOf({
      async get(key) { return rows.get(key); },
      async store(key, value) { rows.set(key, value); }
    })
  };
}

const select = (memory: HubMemory, current = roster()) => compactionCheckpoint({ project, hub: hub.writer, rosterHead, roster: current, memory });

test('compaction preparation selects the exact signed checkpoint accepted by the persisted witness', async () => {
  const { memory } = storage();
  const signed = checkpoint();
  const verdict = witnessCheckpoint(initial(), signed, roster());
  assert.equal(verdict.trusted, true);
  await memory.save(verdict.state);
  const result = await select(memory);
  assert.deepEqual(result, { signed, hash: checkpointHash(signed) });
});

test('a raw network checkpoint, even with a valid signature, cannot substitute for the witness', async () => {
  const { rows, memory } = storage();
  const signed = checkpoint();
  assert.ok(witnessCheckpoint(initial(), signed, roster()).trusted);
  assert.equal(await select(memory), undefined);
  rows.set(hubWitnessKey(hub.writer, project), JSON.stringify(signed));
  assert.equal(await select(memory), undefined);
});

test('a witnessed fork cannot authorize compaction even though both signatures are valid', async () => {
  const { memory } = storage();
  const first = witnessCheckpoint(initial(), checkpoint(), roster());
  const fork = witnessCheckpoint(first.state, checkpoint({ tip: 'f'.repeat(64) }), roster());
  assert.equal(fork.state.distrusted, true);
  assert.ok(fork.state.proof);
  await memory.save(fork.state);
  assert.equal(await select(memory), undefined);
});

test('another project or hub cannot authorize compaction through the selected witness', async () => {
  const { memory } = storage();
  for (const signed of [checkpoint({ projectId: '1'.repeat(32) }), checkpoint({ by: otherHub })]) {
    assert.equal(witnessCheckpoint(initial(), signed, roster()).trusted, false);
    const mislabeled = { ...initial(), newest: signed };
    assert.equal(await select({ ...memory, async load() { return mislabeled; } }), undefined);
  }
  const signed = checkpoint({ by: otherHub });
  const accepted = witnessCheckpoint(createWitness(otherHub.writer, project), signed, roster());
  assert.equal(accepted.trusted, true);
  await memory.save(accepted.state);
  assert.equal(await select(memory), undefined);
});

test('the stored signature and current signer authority are checked again', async () => {
  const { memory } = storage();
  const signed = checkpoint();
  await memory.save(witnessCheckpoint(initial(), signed, roster()).state);
  assert.equal(await select(memory, roster([otherHub.writer])), undefined);
  await memory.save({ ...initial(), newest: { ...signed, sig: Buffer.alloc(64).toString('base64url') } });
  assert.equal(await select(memory), undefined);
});

test('an older checkpoint format cannot supply compaction coverage', async () => {
  const { memory } = storage();
  const accepted = witnessCheckpoint(initial(), checkpoint({ version: 1 }), roster());
  assert.equal(accepted.trusted, true);
  await memory.save(accepted.state);
  assert.equal(await select(memory), undefined);
});

function compactionWorld(count: number) {
  const world = createWorld({ members: [{ member: 'mbr-hub', devices: ['test-hub'] }, { member: 'mbr-writer', devices: ['test-writer'] }] });
  const hub = world.signerOf('test-hub');
  const roster = staticRosterView({
    rosters: world.rosterSpec.rosters.map((row) => ({ ...row, checkpointSigners: [hub.writer] }))
  });
  const context = world.ctx({ roster });
  const product = 'shared-product';
  const editor = world.editor('test-writer', product, 7);
  editor.register();
  const update = (count: number) => {
    for (let offset = 0; offset < count; offset += 1) editor.insert(0, 'x');
  };
  update(count);
  const { memory } = storage();
  const input = {
    project: world.stream, hub: hub.writer, rosterHead: world.rosterHash, context, memory,
    entries: world.entries, stream: world.stream, product, writer: world.writerOf('test-writer'), epoch: 0
  };
  const witness = async (modify?: (signed: SignedCheckpoint['payload']) => SignedCheckpoint['payload']) => {
    const entries = world.entries.map(entry => {
      const result = verifyEntry(entry, context);
      assert.ok(result.status === 'verified');
      return result.entry;
    });
    const heads = checkpointHeads(entries, roster).get(world.stream)!;
    const local = foldEntries(world.entries, context);
    const payload: SignedCheckpoint['payload'] = {
      type: 'checkpoint', v: 2, project: world.stream, signer: hub.writer, rosterHead: world.rosterHash,
      streams: [{ stream: world.stream, count: entries.length, orderTip: orderTipOf(local.order), heads }]
    };
    const signed = signCheckpoint(hub.signer, modify ? modify(payload) : payload);
    const accepted = witnessCheckpoint(createWitness(hub.writer, world.stream), signed, roster);
    assert.equal(accepted.trusted, true);
    await memory.save(accepted.state);
    return checkpointHash(signed);
  };
  return { world, context, input, update, witness };
}

test('a complete witnessed prefix produces sealed replay-equivalent state accepted by the existing reducer', async () => {
  const fixture = compactionWorld(50);
  const checkpoint = await fixture.witness();
  const prepared = await prepareCompaction(fixture.input);
  assert.ok(prepared);
  assert.equal(prepared.checkpoint, checkpoint);
  assert.equal(prepared.payload.covers.length, 1);
  const { world, context, input } = fixture;
  const plain = openBlob(world.keyFor(input.stream, input.epoch), input.stream, input.epoch, prepared.blob);
  assert.ok(plain);
  const doc = buildFromCompaction(plain, []);
  assert.ok(doc);
  assert.equal(docText(doc), 'x'.repeat(50));
  assert.equal(prepared.payload.textHash, textHashOf(docText(doc)));

  world.blobs.set(prepared.blob.hash, prepared.blob);
  const write = world.write('test-writer', { kind: 'doc.compact', data: prepared.payload });
  const folded = productOutput(foldEntries(world.entries, context), input.stream, input.product);
  assert.deepEqual(folded?.compactions, [{ entry: write.hash, verified: true }]);
});

test('preparation requires 50 accepted updates initially and 50 more after this writer’s accepted compaction', async () => {
  const fixture = compactionWorld(49);
  await fixture.witness();
  assert.equal(await prepareCompaction(fixture.input), undefined);
  fixture.update(1);
  await fixture.witness();
  const prepared = await prepareCompaction(fixture.input);
  assert.ok(prepared);
  fixture.world.blobs.set(prepared.blob.hash, prepared.blob);
  fixture.world.write('test-writer', { kind: 'doc.compact', data: prepared.payload });
  fixture.update(49);
  await fixture.witness();
  assert.equal(await prepareCompaction(fixture.input), undefined);
  fixture.update(1);
  await fixture.witness();
  assert.ok(await prepareCompaction(fixture.input));
});

test('a witnessed signature cannot excuse incorrect coverage or missing local state', async () => {
  const fixture = compactionWorld(50);
  const input = fixture.input;
  await fixture.witness((payload) => ({
    ...payload, streams: payload.streams.map((stream) => ({ ...stream, orderTip: '9'.repeat(64) }))
  }));
  assert.equal(await prepareCompaction(input), undefined);
  await fixture.witness((payload) => ({
    ...payload, streams: payload.streams.map((stream) => ({
      ...stream, heads: stream.heads.map((head) => ({ ...head, lamport: 9999 }))
    }))
  }));
  assert.equal(await prepareCompaction(input), undefined);
  await fixture.witness();
  assert.equal(await prepareCompaction({ ...input, entries: input.entries.slice(1) }), undefined);
  assert.equal(await prepareCompaction({ ...input, epoch: 10, context: {
    ...input.context, keys: (stream, epoch) => epoch === 0 ? input.context.keys(stream, epoch) : undefined
  } }), undefined);
  fixture.update(1);
  assert.equal(await prepareCompaction(input), undefined, 'new input must be covered by a fresh checkpoint');
});
