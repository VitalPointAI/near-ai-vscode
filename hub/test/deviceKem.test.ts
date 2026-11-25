import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { kemPublicFromSeeds } from '@ext/domain/replica/cellWrapV2';
import type { KemPublicKeys } from '@ext/domain/replica/cellWrapV2';
import { DEVICE_KEM_REFUSALS, kemKeysAt, signKemBinding } from '@ext/domain/replica/deviceKem';
import { APPEND_REFUSALS } from '../src/append/checks';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// 33.2-02 (D-03): your organization's server checks a device's post-quantum key binding (device.kem) when it is appended, with the same
// deviceKemProblem the client fold uses: a binding signed by the device itself is taken, a forged one and one written by another member's device
// are refused. All names and keys are fictional.

const keysFor = (label: string): KemPublicKeys =>
  kemPublicFromSeeds({ p256: createHash('sha256').update(`hub kem p256 ${label}`).digest(), mlkem768: createHash('sha512').update(`hub kem mlkem ${label}`).digest() });

interface Setup { world: HubWorld; pat: WorldDevice; quinn: WorldDevice }

async function enrolled(hub: Hub): Promise<Setup> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  const quinn = world.device('QUINN-LAPTOP', 'mbr-quinn');
  world.admitMember(pat, { slot: 7 });
  world.admitMember(quinn, { slot: 8 });
  await hub.enrolProject(world, { direct: true });
  return { world, pat, quinn };
}

const publish = (s: Setup, by: WorldDevice, device: WorldDevice, keys: KemPublicKeys, signer: WorldDevice = device): Written =>
  s.world.write(by, { kind: 'device.kem', data: { device: device.writer, ...signKemBinding(keys, device.writer, (bytes) => signer.signer.sign(bytes)) } });

async function append(world: HubWorld, by: OpenedSession, entries: readonly Written[]): Promise<{ accepted: string[]; refused: Array<{ hash?: string; reason: string; message: string }> }> {
  const answer = await by.connection.post(`/v1/projects/${world.project}/append`, { entries: entries.map((item) => item.entry) }, by.token);
  const body = answer.json<{ accepted?: string[]; refused?: Array<{ hash?: string; reason: string; message: string }> }>();
  return { accepted: body.accepted ?? [], refused: body.refused ?? [] };
}

test('Pat\'s own device.kem is appended and the hub\'s roster then gives Pat\'s post-quantum keys', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const keys = keysFor('pat');
    const entry = publish(s, s.pat, s.pat, keys);
    const answer = await append(s.world, await hub.openSession(s.pat, s.world.project), [entry]);
    assert.deepEqual(answer.refused, []);
    assert.deepEqual(answer.accepted, [entry.hash]);
    assert.deepEqual(kemKeysAt((await hub.cache.get(s.world.project)).state, s.pat.writer), keys);
  }));

test('a device.kem whose binding another device signed is refused kem-binding-invalid with the fold\'s sentence', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const entry = publish(s, s.pat, s.pat, keysFor('pat'), s.quinn);
    const answer = await append(s.world, await hub.openSession(s.pat, s.world.project), [entry]);
    assert.deepEqual(answer.accepted, []);
    assert.deepEqual(answer.refused.map((item) => [item.hash, item.reason, item.message]), [[entry.hash, 'kem-binding-invalid', DEVICE_KEM_REFUSALS['kem-binding-invalid']]]);
    assert.equal(APPEND_REFUSALS['kem-binding-invalid'], DEVICE_KEM_REFUSALS['kem-binding-invalid']);
  }));

test('Quinn\'s device cannot publish Pat\'s keys, even with Pat\'s valid binding (kem-wrong-writer)', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const entry = publish(s, s.quinn, s.pat, keysFor('pat'));
    const answer = await append(s.world, await hub.openSession(s.quinn, s.world.project), [entry]);
    assert.deepEqual(answer.accepted, []);
    assert.equal(answer.refused.find((item) => item.hash === entry.hash)?.reason, 'kem-wrong-writer');
  }));
