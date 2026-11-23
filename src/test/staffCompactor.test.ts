import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkpointHash, signCheckpoint, type SignedCheckpoint } from '../domain/replica/checkpoint';
import { createWitness, witnessCheckpoint } from '../domain/replica/hubWitness';
import { staticRosterView } from '../domain/replica/rosterView';
import { compactionCheckpoint } from '../staff/replica/compactor';
import { hubMemoryOf, hubWitnessKey, type HubMemory } from '../staff/replica/hubSync';
import { fixedSigner } from './helpers/replicaWorld';

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
