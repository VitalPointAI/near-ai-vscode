// Signed-event factory for the team materialiser tests: actors with real Ed25519 keys generated at runtime, a signed event builder,
// committed-entry wrappers, genesis batches and a seeded PRNG. No key material is ever written to disk.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { canonicalize, eventPath } from '../../domain/team/canonical';
import { DEFAULT_WIP_LIMIT } from '../../domain/team/policy';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, Role, TeamEvent, TeamEventBodyMap, TeamState } from '../../domain/team/types';
import { createDeviceIdentity, newEventId, signEvent } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { MemorySecrets, createOwner, testGenesis } from './teamHarness';

export interface TestActor { memberId: string; identity: DeviceIdentity; secrets: MemorySecrets }

export const FIXTURE_EVENT_ID = `evt-${'0'.repeat(26)}`;
export const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

export async function makeActor(teamId: string): Promise<TestActor> {
  const owner = await createOwner(teamId);
  return { memberId: owner.memberId, identity: owner.identity, secrets: owner.secrets };
}

// A second device for an existing member: same member id, a fresh key held in its own secret store.
export async function makeDevice(actor: TestActor): Promise<TestActor> {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, actor.identity.teamId);
  return { memberId: actor.memberId, identity, secrets };
}

export interface SignedFields<T extends ImplementedEventType> {
  teamId: string;
  type: T;
  body: ImplementedEventBodies[T];
  lamport: number;
  prev: string;
  at?: string;
  id?: string;
}

export function signed<T extends ImplementedEventType>(actor: TestActor, fields: SignedFields<T>): TeamEvent<T> {
  return signEvent(actor.identity, {
    v: 1, id: fields.id ?? newEventId(), teamId: fields.teamId, type: fields.type, lamport: fields.lamport, at: fields.at ?? FIXTURE_TIME,
    author: actor.memberId, device: actor.identity.fingerprint, prev: fields.prev, body: fields.body as TeamEventBodyMap[T]
  });
}

export function entryOf(event: TeamEvent, options: { commit?: string; text?: string; path?: string } = {}): CommittedEvent {
  const text = options.text ?? canonicalize(event);
  return {
    commit: options.commit ?? 'c'.repeat(40), commitTime: 1, path: options.path ?? eventPath(event), blob: 'b'.repeat(40),
    size: Buffer.byteLength(text, 'utf8'), text, kind: 'event'
  };
}

// The two-event batch Enable Team Mode writes, as committed entries, plus the anchor a client pins from team.json.
export function genesisEntries(owner: TestActor, teamId: string, name = 'Materialiser test team'): { entries: CommittedEvent[]; anchor: GenesisAnchor } {
  const genesis = testGenesis({ teamId, owner, name });
  return { entries: genesis.events.map((event) => entryOf(event)), anchor: genesis.anchor };
}

// Test-only stand-in for Phase 61 joins. Phase 60 logs cannot contain a non-owner member (member.joined is owner-at-genesis only, D-07),
// so the read-side permission matrix is exercised by placing members straight into the state before their events are applied.
export function addFixtureMember(state: TeamState, actor: TestActor, role: Role, name = 'Fixture member'): void {
  state.members.set(actor.memberId, {
    id: actor.memberId, name, emailHashes: [], role,
    devices: [{ fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey, addedBy: actor.memberId, addedEvent: FIXTURE_EVENT_ID }],
    skills: [], availability: 'available', wipLimit: DEFAULT_WIP_LIMIT, joinedAt: FIXTURE_TIME, joinedEvent: FIXTURE_EVENT_ID
  });
  state.deviceIndex.set(actor.identity.fingerprint, actor.memberId);
}

// Small seeded PRNG (mulberry32) so a failing property run can be reproduced from its seed alone.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
