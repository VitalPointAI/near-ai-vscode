// A fully deterministic two-event Phase 60 log: fixed team and member ids, a fixed Ed25519 seed (public in this file, test only, never used
// for anything else), fixed event ids and times. Ed25519 signatures are deterministic, so the same bytes and the same state hash come out on
// every run. The pinned hash in the tests was taken from the code as it stood before Phase 61 changed the member shape.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { canonicalize, eventPath } from '../../domain/team/canonical';
import { defaultTeamPolicy } from '../../domain/team/policy';
import type { CommittedEvent, GenesisAnchor } from '../../domain/team/types';
import { deviceKeySecretName, loadDeviceIdentity, signEvent } from '../../team/identity';
import { MemorySecrets } from './teamHarness';

export const PHASE60_TEAM_ID = 'team-0123456789abcdef0123456789abcdef';
const OWNER_ID = 'mbr-0123456789abcdef';
const CREATED_ID = 'evt-00000000000000000000000001';
const JOINED_ID = 'evt-00000000000000000000000002';
const EMAIL_HASH = 'ab'.repeat(32);
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export async function phase60Fixture(): Promise<{ entries: CommittedEvent[]; anchor: GenesisAnchor }> {
  const secrets = new MemorySecrets();
  await secrets.store(deviceKeySecretName(PHASE60_TEAM_ID), Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, 'hex'), Buffer.alloc(32, 7)]).toString('base64'));
  const identity = await loadDeviceIdentity(secrets, PHASE60_TEAM_ID);
  if (identity === undefined) throw new Error('The fixed fixture key did not load.');
  const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const created = signEvent(identity, {
    v: 1, id: CREATED_ID, teamId: PHASE60_TEAM_ID, type: 'team.created', lamport: 1, at: '2026-01-01T00:00:00.000Z', author: OWNER_ID, device: device.fingerprint, prev: '',
    body: { name: 'Pinned team', ownerId: OWNER_ID, ownerName: 'Owner Test', ownerEmailHashes: [EMAIL_HASH], ownerDevice: device, policy: defaultTeamPolicy() }
  });
  const joined = signEvent(identity, {
    v: 1, id: JOINED_ID, teamId: PHASE60_TEAM_ID, type: 'member.joined', lamport: 2, at: '2026-01-01T00:00:01.000Z', author: OWNER_ID, device: device.fingerprint, prev: CREATED_ID,
    body: { memberId: OWNER_ID, name: 'Owner Test', emailHashes: [EMAIL_HASH], role: 'owner', device }
  });
  const entries = [created, joined].map((event): CommittedEvent => {
    const text = canonicalize(event);
    return { commit: 'c'.repeat(40), commitTime: 1, path: eventPath(event), blob: 'b'.repeat(40), size: Buffer.byteLength(text, 'utf8'), text, kind: 'event' };
  });
  return { entries, anchor: { teamId: PHASE60_TEAM_ID, eventId: CREATED_ID, ownerDevice: device } };
}
