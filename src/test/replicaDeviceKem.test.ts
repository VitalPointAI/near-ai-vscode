// A device's post-quantum key binding in the roster fold (33.2-02 Task 2; 33.2-CONTEXT D-03, D-12): device.kem is placed only when the binding is
// signed by the named device's own Ed25519 key, the device is admitted at the cited roster, and the entry was written by that device or a lead
// device; kemKeysAt gives the latest keys, the same in every fold order; a descriptor's kem is checked when the device is added. Fictional people.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { kemPublicFromSeeds } from '../domain/replica/cellWrapV2';
import type { KemPublicKeys } from '../domain/replica/cellWrapV2';
import { DEVICE_KEM_BINDING_DOMAIN, DEVICE_KEM_REFUSALS, kemBindingBytes, kemKeysAt, signKemBinding } from '../domain/replica/deviceKem';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import type { RosterState } from '../domain/replica/roster';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import type { Written } from './helpers/replicaWorld';

const PAT = 'mbr-pat';
const QUINN = 'mbr-quinn';
const CERT_PIN = 'c'.repeat(64);
const keysFor = (label: string): KemPublicKeys =>
  kemPublicFromSeeds({ p256: createHash('sha256').update(`kem p256 ${label}`).digest(), mlkem768: createHash('sha512').update(`kem mlkem ${label}`).digest() });
const binding = (device: RosterDevice, keys: KemPublicKeys, signer: RosterDevice = device) => signKemBinding(keys, device.writer, (bytes) => signer.signer.sign(bytes));

interface Scene {
  world: RosterWorld;
  pat: RosterDevice;
  quinn: RosterDevice;
  hub: RosterDevice;
  beforeQuinn: string;
  head: string;
}

// The lead admits Pat (slot 2), then Quinn (slot 3), then the hub (slot 4).
function scene(options: { patKem?: unknown } = {}): Scene {
  const world = createRosterWorld();
  const pat = world.device('PAT-LAPTOP', PAT);
  const quinn = world.device('QUINN-LAPTOP', QUINN);
  const hub = world.device('HUB-1', 'hub-main');
  const { entry: genesis } = world.genesis();
  const invite = (id: string, prev: string): Written => world.rosterEntry(world.lead, 'member.invite', {
    invite: id, name: 'Fictional Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, prev);
  const admit = (member: string, id: string, device: unknown, prev: string): Written => world.rosterEntry(world.lead, 'member.admit', {
    member, invite: id, name: 'Fictional Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device, agentSeats: []
  }, prev);
  const invitePat = invite('inv-pat', genesis.hash);
  const patDescriptor = options.patKem === undefined ? pat.descriptor(2) : { ...pat.descriptor(2), kem: options.patKem };
  const admitPat = admit(PAT, 'inv-pat', patDescriptor, invitePat.hash);
  const inviteQuinn = invite('inv-quinn', admitPat.hash);
  const admitQuinn = admit(QUINN, 'inv-quinn', quinn.descriptor(3), inviteQuinn.hash);
  const hubAdmit = world.rosterEntry(world.lead, 'hub.admit', { hub: 'hub-main', device: hub.descriptor(4), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE }, admitQuinn.hash);
  return { world, pat, quinn, hub, beforeQuinn: inviteQuinn.hash, head: hubAdmit.hash };
}

const publish = (s: Scene, by: RosterDevice, data: Record<string, unknown>, options: { roster?: string; at?: string } = {}): Written =>
  s.world.write(by, { kind: 'device.kem', data, roster: options.roster ?? s.head, ...(options.at === undefined ? {} : { at: options.at }) });
const kemData = (device: RosterDevice, keys: KemPublicKeys, signer?: RosterDevice): Record<string, unknown> => ({ device: device.writer, ...binding(device, keys, signer) });
const refusedReason = (state: RosterState, hash: string): string | undefined => state.refused.find((item) => item.hash === hash)?.reason;

test('the binding bytes are the domain line, the P-256 key, the ML-KEM key and the writer id in hex: 1,342 bytes', () => {
  const keys = keysFor('pat');
  const writer = 'a'.repeat(64);
  const bytes = kemBindingBytes(keys, writer);
  assert.equal(DEVICE_KEM_BINDING_DOMAIN, 'near-ai-vscode/device-kem/v2\n');
  assert.equal(bytes.length, 1342);
  assert.equal(bytes.subarray(0, 29).toString('utf8'), DEVICE_KEM_BINDING_DOMAIN);
  assert.equal(bytes.subarray(29, 94).toString('base64url'), keys.p256);
  assert.equal(bytes.subarray(94, 1278).toString('base64url'), keys.mlkem768);
  assert.equal(bytes.subarray(1278).toString('utf8'), writer);
});

test('Pat\'s laptop publishes its own device.kem: it is placed, takes no roster position, and kemKeysAt gives Pat\'s keys', () => {
  const s = scene();
  const keys = keysFor('pat');
  const entry = publish(s, s.pat, kemData(s.pat, keys));
  const state = s.world.foldRoster();
  assert.deepEqual(kemKeysAt(state, s.pat.writer), keys);
  assert.equal(state.positionOf.has(entry.hash), false);
  assert.equal(kemKeysAt(state, s.quinn.writer), undefined, 'Quinn has published nothing');
});

test('a binding signed by another device\'s key is refused kem-binding-invalid', () => {
  const s = scene();
  const entry = publish(s, s.pat, kemData(s.pat, keysFor('pat'), s.quinn));
  const state = s.world.foldRoster();
  assert.equal(refusedReason(state, entry.hash), 'kem-binding-invalid');
  assert.equal(kemKeysAt(state, s.pat.writer), undefined);
  assert.ok(DEVICE_KEM_REFUSALS['kem-binding-invalid'].length > 0);
});

test('keys for a device not admitted at the cited roster, or revoked there, are refused kem-device-not-admitted', () => {
  const s = scene();
  const early = publish(s, s.world.lead, kemData(s.quinn, keysFor('quinn')), { roster: s.beforeQuinn });
  const revoke = s.world.rosterEntry(s.world.lead, 'device.revoke', { member: PAT, writer: s.pat.writer }, s.head);
  const afterRevoke = publish(s, s.world.lead, kemData(s.pat, keysFor('pat')), { roster: revoke.hash });
  const state = s.world.foldRoster();
  assert.equal(refusedReason(state, early.hash), 'kem-device-not-admitted');
  assert.equal(refusedReason(state, afterRevoke.hash), 'kem-device-not-admitted');
  assert.equal(kemKeysAt(state, s.quinn.writer), undefined);
});

test('a member device that is neither the device nor a lead device cannot publish another device\'s keys (kem-wrong-writer)', () => {
  const s = scene();
  const entry = publish(s, s.quinn, kemData(s.pat, keysFor('pat')));
  const state = s.world.foldRoster();
  assert.equal(refusedReason(state, entry.hash), 'kem-wrong-writer');
  assert.equal(kemKeysAt(state, s.pat.writer), undefined);
});

test('a lead device writes the hub\'s device.kem carrying the hub\'s own binding signature', () => {
  const s = scene();
  const keys = keysFor('hub');
  publish(s, s.world.lead, kemData(s.hub, keys));
  assert.deepEqual(kemKeysAt(s.world.foldRoster(), s.hub.writer), keys);
});

test('a later valid device.kem replaces the earlier keys, and every fold order gives the same kemKeysAt', () => {
  const s = scene();
  const first = keysFor('pat-1');
  const second = keysFor('pat-2');
  publish(s, s.pat, kemData(s.pat, first), { at: '2026-11-19T11:00:00.000Z' });
  publish(s, s.pat, kemData(s.pat, second), { at: '2026-11-19T12:00:00.000Z' });
  assert.deepEqual(kemKeysAt(s.world.foldRoster(), s.pat.writer), second);
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 6; round += 1) {
    const shuffled = [...s.world.entries].sort(() => random() - 0.5);
    assert.deepEqual(kemKeysAt(s.world.foldRoster({ entries: shuffled }), s.pat.writer), second, `order ${round}`);
  }
});

test('a descriptor kem bound by the device gives kemKeysAt at admission; one signed by another key makes the admission bad-binding', () => {
  const pat = createRosterWorld().device('PAT-LAPTOP', PAT);
  const keys = keysFor('pat-descriptor');
  const good = scene({ patKem: binding(pat, keys) });
  assert.deepEqual(kemKeysAt(good.world.foldRoster(), good.pat.writer), keys);
  const forged = scene({ patKem: binding(pat, keys, createRosterWorld().device('QUINN-LAPTOP', QUINN)) });
  const state = forged.world.foldRoster();
  assert.ok(state.refused.some((item) => item.kind === 'member.admit' && item.reason === 'bad-binding'));
  assert.equal(kemKeysAt(state, forged.pat.writer), undefined);
});

test('a device.kem with a binding over keys that are not on the curve is refused even with a valid signature', () => {
  const s = scene();
  const bad = { p256: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), mlkem768: keysFor('pat').mlkem768 };
  const entry = publish(s, s.pat, { device: s.pat.writer, ...bad, sig: s.pat.signer.sign(kemBindingBytes(bad, s.pat.writer)) });
  assert.equal(refusedReason(s.world.foldRoster(), entry.hash), 'kem-binding-invalid');
});
