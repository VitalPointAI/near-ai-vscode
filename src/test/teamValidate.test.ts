// Schema tests for the team event envelope, the ten Phase 60 bodies and the policy (D-07, D-08, D-09 step 1, D-30, D-31).
// Reasons are asserted verbatim: they are the fixed strings the materialiser and the UI show.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { MAX_EVENT_BYTES, canonicalize, eventPath } from '../domain/team/canonical';
import { applyPolicyChanges, defaultTeamPolicy, isGitRefName, validatePolicy, validatePolicyChanges } from '../domain/team/policy';
import { parseEventFile, validateBody, validateDeviceRef, validateEnvelope, validateName } from '../domain/team/validate';
import { IMPLEMENTED_EVENT_TYPES, TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, TeamEvent } from '../domain/team/types';
import { newMemberId, newTeamId } from '../team/identity';
import { createOwner, testEvent, testGenesis } from './helpers/teamHarness';
import type { TestOwner } from './helpers/teamHarness';

const INVALID = TEAM_REJECTION_REASONS.invalidBody;

interface Context { teamId: string; owner: TestOwner; event: TeamEvent<'member.availability'> }

async function context(): Promise<Context> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const event = testEvent(owner.identity, { lamport: 7, prev: '', author: owner.memberId, teamId });
  return { teamId, owner, event };
}

function entryFor(event: unknown, overrides: Partial<CommittedEvent> = {}): CommittedEvent {
  const text = canonicalize(event);
  const record = event as { lamport: number; id: string };
  return {
    commit: 'c'.repeat(40), commitTime: 1, path: eventPath(record), blob: 'b'.repeat(40), size: Buffer.byteLength(text, 'utf8'), text, kind: 'event', ...overrides
  };
}

function withField(event: TeamEvent, field: string, value: unknown): Record<string, unknown> {
  return { ...event, [field]: value };
}

function without(event: TeamEvent, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...event };
  delete copy[field];
  return copy;
}

function rejection(entry: CommittedEvent): { eventId: string; reason: string } {
  const result = parseEventFile(entry);
  assert.equal(result.ok, false, 'expected a rejection');
  if (result.ok) throw new Error('unreachable');
  return result.rejection;
}

test('a signed member.availability event stored under its own path parses ok', async () => {
  const { event } = await context();
  const result = parseEventFile(entryFor(event));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.id, event.id);
  assert.equal(result.event.type, 'member.availability');
});

test('file level gates: size, JSON, canonical bytes', async () => {
  const { event } = await context();
  const path = eventPath(event);
  const big = rejection({ ...entryFor(event), size: MAX_EVENT_BYTES + 1 });
  assert.deepEqual(big, { eventId: path, reason: 'event is larger than 16 KB' });
  assert.equal(parseEventFile({ ...entryFor(event), size: MAX_EVENT_BYTES }).ok, true, 'exactly 16 KB is not too large');
  assert.deepEqual(rejection({ ...entryFor(event), text: '', size: MAX_EVENT_BYTES + 1 }), { eventId: path, reason: 'event is larger than 16 KB' }, 'a skipped oversized blob is still rejected');
  assert.deepEqual(rejection({ ...entryFor(event), text: 'not json at all' }), { eventId: path, reason: 'malformed event' });
  assert.deepEqual(rejection({ ...entryFor(event), text: '' }), { eventId: path, reason: 'malformed event' });

  const canonical = canonicalize(event);
  const pretty = JSON.stringify(event, null, 2);
  assert.equal(rejection({ ...entryFor(event), text: pretty }).reason, 'event file is not canonical');
  assert.equal(rejection({ ...entryFor(event), text: `${canonical}\n` }).reason, 'event file is not canonical');
  const duplicated = canonical.replace('"v":1}', '"v":1,"v":1}');
  assert.notEqual(duplicated, canonical);
  assert.equal(rejection({ ...entryFor(event), text: duplicated }).reason, 'event file is not canonical');
  const float = canonical.replace('"lamport":7', '"lamport":7.5');
  assert.equal(rejection({ ...entryFor(event), text: float }).reason, 'event file is not canonical');
  const trailingZero = canonical.replace('"lamport":7', '"lamport":7.0');
  assert.equal(rejection({ ...entryFor(event), text: trailingZero }).reason, 'event file is not canonical');
  const exponent = canonical.replace('"lamport":7', '"lamport":7e0');
  assert.equal(rejection({ ...entryFor(event), text: exponent }).reason, 'event file is not canonical');
  const result = rejection({ ...entryFor(event), text: duplicated });
  assert.equal(result.eventId, event.id, 'a parsed id is used as the rejection id');
});

test('a __proto__ key is rejected by exact keys and never reaches a trusted object', async () => {
  const { event } = await context();
  const text = canonicalize(event).replace('{"at"', '{"__proto__":{"admin":true},"at"');
  const parsed: unknown = JSON.parse(text);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), true);
  const result = rejection({ ...entryFor(event), text, size: text.length });
  assert.equal(result.reason.startsWith(`${INVALID}: `), true);
  assert.equal(({} as Record<string, unknown>).admin, undefined, 'the global prototype is untouched');
});

test('unknown versions and types always get the update-the-app reason, even with other errors', async () => {
  const { event } = await context();
  const unsupported = 'unsupported event type for this version';
  assert.equal(rejection(entryFor({ ...event, v: 2 })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, type: 'item.created' })).reason, unsupported, 'known to the union but not implemented yet');
  assert.equal(rejection(entryFor({ ...event, type: 'made.up' })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, type: 7 })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, v: 2, id: 'nonsense', lamport: 0, extra: true })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, type: 'made.up', sig: 'x', author: 'y' })).reason, unsupported);
  assert.equal(validateEnvelope({ ...event, v: '1' }), unsupported);
  assert.equal(validateEnvelope({}), unsupported);
});

test('each envelope field error names the field', async () => {
  const { event } = await context();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['id', withField(event, 'id', 'evt-short')],
    ['id', withField(event, 'id', 'evt-IIIIIIIIIIIIIIIIIIIIIIIIII')],
    ['teamId', withField(event, 'teamId', 'team-1234')],
    ['author', withField(event, 'author', 'mbr-XYZ')],
    ['author', withField(event, 'author', 7)],
    ['device', withField(event, 'device', 'dev-1234')],
    ['prev', withField(event, 'prev', 'evt-nope')],
    ['prev', withField(event, 'prev', null)],
    ['at', withField(event, 'at', '2026-01-01 00:00:00')],
    ['at', withField(event, 'at', '2026-01-01T00:00:00+01:00')],
    ['at', withField(event, 'at', 20260101)],
    ['lamport', withField(event, 'lamport', 0)],
    ['lamport', withField(event, 'lamport', 1_000_000_000_000)],
    ['lamport', withField(event, 'lamport', 1.5)],
    ['lamport', withField(event, 'lamport', '7')],
    ['lamport', withField(event, 'lamport', -3)],
    ['sig', withField(event, 'sig', `${event.sig.slice(0, 85)}=`)],
    ['sig', withField(event, 'sig', event.sig.slice(1))],
    ['sig', withField(event, 'sig', 'A'.repeat(85) + 'B')],
    ['body', withField(event, 'body', [])],
    ['body', withField(event, 'body', 'text')],
    ['body', withField(event, 'body', null)],
    ['extra', withField(event, 'extra', 1)],
    ['sig', without(event, 'sig')],
    ['body', without(event, 'body')],
    ['at', without(event, 'at')]
  ];
  for (const [field, value] of cases) {
    assert.equal(validateEnvelope(value), `${INVALID}: ${field}`, `${field} case`);
  }
  assert.equal(validateEnvelope([]), `${INVALID}: event`);
  assert.equal(validateEnvelope('text'), `${INVALID}: event`);
  assert.equal(validateEnvelope(event), undefined);
  assert.equal(validateEnvelope({ ...event, prev: event.id }), undefined, 'a prev that is an event id is accepted');
  assert.equal(validateEnvelope({ ...event, at: '2026-01-01T00:00:00Z' }), undefined, 'seconds without a fraction are accepted');
  assert.equal(validateEnvelope({ ...event, lamport: 999_999_999_999 }), undefined);
});

test('extra key names in reasons are cut down to a safe alphabet', async () => {
  const { event } = await context();
  const reason = validateEnvelope({ ...event, ['a b\nc'.repeat(30)]: 1 });
  assert.ok(reason !== undefined);
  assert.equal(reason.startsWith(`${INVALID}: `), true);
  assert.equal(/[\n ]/.test(reason.slice(INVALID.length + 2)), false);
  assert.ok(reason.length < 200);
});

test('a path that disagrees with the lamport or id is rejected after the body checks', async () => {
  const { event, teamId, owner } = await context();
  const other = testEvent(owner.identity, { lamport: 8, prev: '', author: owner.memberId, teamId });
  assert.deepEqual(rejection(entryFor(event, { path: eventPath(other) })), { eventId: event.id, reason: 'file name does not match the event' });
  assert.equal(rejection(entryFor(event, { path: eventPath({ lamport: 8, id: event.id }) })).reason, 'file name does not match the event');
  assert.equal(rejection(entryFor(event, { path: `events/${event.id}.json` })).reason, 'file name does not match the event');
  assert.equal(rejection(entryFor(event, { path: '' })).reason, 'file name does not match the event');
});

test('rejection ids use the event id when it matches the pattern and the path otherwise', async () => {
  const { event } = await context();
  const badAuthor = rejection(entryFor({ ...event, author: 'nobody' }));
  assert.equal(badAuthor.eventId, event.id);
  const badId = rejection(entryFor({ ...event, id: 'evt-bad' }, { path: eventPath(event) }));
  assert.equal(badId.eventId, eventPath(event));
  assert.equal(badId.reason, `${INVALID}: id`);
  assert.notEqual(newMemberId(), '');
});

// ---- Bodies and policy ----

const OWNER_ID = 'mbr-0123456789abcdef';
const OTHER_ID = 'mbr-fedcba9876543210';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const EVENT_A = 'evt-01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// One sealed entry with the right byte lengths: a 32 byte ephemeral key, a 12 byte nonce, a 16 byte tag and 40 bytes of ciphertext.
function sealedEntry(device: { fingerprint: string; publicKey: string }): Record<string, unknown> {
  return {
    device: device.fingerprint, ephemeral: { publicKey: device.publicKey }, nonce: Buffer.alloc(12, 7).toString('base64url'),
    tag: Buffer.alloc(16, 8).toString('base64url'), ciphertext: Buffer.alloc(40, 9).toString('base64url')
  };
}

function bodiesFor(device: { fingerprint: string; publicKey: string }): Record<string, Record<string, unknown>> {
  return {
    'team.created': { name: 'Core team', ownerId: OWNER_ID, ownerName: 'Ada', ownerEmailHashes: [HASH_A], ownerDevice: device, policy: defaultTeamPolicy(), near: { organizationId: 'org_1', workspaceId: 'ws:2' } },
    'member.invited': { memberId: OTHER_ID, name: 'Grace', emailHashes: [HASH_A], role: 'developer', allocationNanoUsd: 5_000_000_000, ttlSeconds: 604_800, invite: { publicKey: device.publicKey } },
    'member.joined': { memberId: OTHER_ID, name: 'Grace', emailHashes: [HASH_A, HASH_B], role: 'developer', device },
    'member.role-changed': { memberId: OTHER_ID, role: 'lead' },
    'member.removed': { memberId: OTHER_ID },
    'device.added': { memberId: OTHER_ID, device },
    'device.revoked': { memberId: OTHER_ID, fingerprint: device.fingerprint },
    'member.availability': { availability: 'focus', workingHours: { tz: 'Europe/London', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:30' } },
    'member.skills': { memberId: OTHER_ID, skills: ['typescript', 'c++', 'node.js'] },
    'policy.changed': { changes: { peerMetricsVisible: true, safetyFactorBp: 13000 } },
    'member.key-sealed': { memberId: OTHER_ID, keyId: 'key_0123456789abcdef', scheme: 'x25519-hkdf-sha256-aes-256-gcm-v1', sealed: [sealedEntry(device)] },
    'snapshot.written': { coversThrough: EVENT_A, lamport: 500, stateHash: HASH_A, path: 'snapshots/000000000500.json' }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('valid bodies for every implemented type pass, with and without optional fields', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const bodies = bodiesFor(device);
  assert.equal(Object.keys(bodies).length, IMPLEMENTED_EVENT_TYPES.length);
  for (const type of IMPLEMENTED_EVENT_TYPES) {
    assert.equal(validateBody(type, bodies[type]), undefined, type);
  }
  const created = clone(bodies['team.created'] as Record<string, unknown>);
  delete created.near;
  assert.equal(validateBody('team.created', created), undefined, 'near is optional');
  assert.equal(validateBody('member.availability', { availability: 'away' }), undefined, 'workingHours is optional');
  assert.equal(validateBody('member.skills', { memberId: OTHER_ID, skills: [] }), undefined);
  assert.equal(validateBody('member.joined', { ...bodies['member.joined'], emailHashes: [] }), undefined);
  assert.equal(validateBody('item.created', {}), 'unsupported event type for this version');
  assert.equal(validateBody('member.removed', []), `${INVALID}: body`);
  assert.equal(validateBody('member.removed', null), `${INVALID}: body`);
});

test('every body rejects extra keys, missing keys and wrong types by field name', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const bodies = bodiesFor(device);
  for (const type of IMPLEMENTED_EVENT_TYPES) {
    const valid = bodies[type] as Record<string, unknown>;
    const extra = { ...valid, surprise: 1 };
    assert.equal(validateBody(type, extra), `${INVALID}: body.surprise`, `${type} extra key`);
    for (const key of Object.keys(valid)) {
      const missing = clone(valid);
      delete missing[key];
      const optional = (type === 'team.created' && key === 'near') || (type === 'member.availability' && key === 'workingHours');
      if (!optional) assert.equal(validateBody(type, missing), `${INVALID}: body.${key}`, `${type} missing ${key}`);
      // A number can be a valid value for a numeric field, so those get a string instead.
      const wrong = { ...clone(valid), [key]: ['lamport', 'allocationNanoUsd', 'ttlSeconds'].includes(key) ? 'x' : 12345 };
      assert.equal(validateBody(type, wrong), `${INVALID}: body.${key}`, `${type} wrong type ${key}`);
      const nulled = { ...clone(valid), [key]: null };
      assert.equal(validateBody(type, nulled), `${INVALID}: body.${key}`, `${type} null ${key}`);
    }
  }
});

test('members carry email hashes only, and device fingerprints must match their key', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const joined = bodiesFor(device)['member.joined'] as Record<string, unknown>;
  assert.equal(validateBody('member.joined', { ...joined, emails: ['a@b.test'] }), `${INVALID}: body.emails`);
  const plainOwner = bodiesFor(device)['team.created'] as Record<string, unknown>;
  assert.equal(validateBody('team.created', { ...plainOwner, ownerEmails: ['a@b.test'] }), `${INVALID}: body.ownerEmails`);
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: ['ada@example.test'] }), `${INVALID}: body.emailHashes`);
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: [HASH_A.toUpperCase()] }), `${INVALID}: body.emailHashes`);
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: [HASH_A, HASH_A] }), `${INVALID}: body.emailHashes`);
  const nine = Array.from({ length: 9 }, (_unused, index) => String(index).repeat(64));
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: nine }), `${INVALID}: body.emailHashes`);
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: nine.slice(0, 8) }), undefined);
  assert.equal(validateBody('member.joined', { ...joined, emailHashes: HASH_A }), `${INVALID}: body.emailHashes`);

  const stranger = await createOwner(newTeamId());
  const mismatched = { fingerprint: stranger.identity.fingerprint, publicKey: device.publicKey };
  assert.equal(validateBody('member.joined', { ...joined, device: mismatched }), `${INVALID}: body.device.fingerprint`);
  assert.equal(validateBody('device.added', { memberId: OTHER_ID, device: mismatched }), `${INVALID}: body.device.fingerprint`);
  assert.equal(validateBody('team.created', { ...plainOwner, ownerDevice: mismatched }), `${INVALID}: body.ownerDevice.fingerprint`);
  assert.equal(validateBody('member.joined', { ...joined, device: { ...device, publicKey: `${device.publicKey.slice(0, 42)}=` } }), `${INVALID}: body.device.publicKey`);
  assert.equal(validateBody('member.joined', { ...joined, device: { ...device, extra: 1 } }), `${INVALID}: body.device.extra`);
  assert.equal(validateBody('member.joined', { ...joined, device: { fingerprint: device.fingerprint } }), `${INVALID}: body.device.publicKey`);
  assert.equal(validateDeviceRef(device, 'x'), undefined);
  assert.equal(validateDeviceRef('device', 'x'), `${INVALID}: x`);
  assert.equal(validateBody('device.revoked', { memberId: OTHER_ID, fingerprint: 'dev-1' }), `${INVALID}: body.fingerprint`);
});

test('names are 1 to 80 characters after trimming with no control characters or line separators', () => {
  assert.equal(validateName('Ada', 'n'), undefined);
  assert.equal(validateName('  Ada  ', 'n'), undefined);
  assert.equal(validateName('a'.repeat(80), 'n'), undefined);
  assert.equal(validateName('日本語 😀', 'n'), undefined);
  for (const bad of ['', '   ', 'a'.repeat(81), 'two\nlines', 'tab\there', 'bell\u0007', 'nul\u0000', 'del\u007F', `sep${LINE_SEPARATOR}`, `para${PARAGRAPH_SEPARATOR}`, 5, null, undefined, ['Ada']]) {
    assert.equal(validateName(bad, 'body.name'), `${INVALID}: body.name`, String(bad));
  }
});

test('working hours: weekday list, clock times and time zone are strict', () => {
  const valid = { tz: 'America/Argentina/Buenos_Aires', days: [0, 6], start: '00:00', end: '23:59' };
  assert.equal(validateBody('member.availability', { availability: 'available', workingHours: valid }), undefined);
  const cases: Array<[string, Record<string, unknown>]> = [
    ['days', { ...valid, days: [] }],
    ['days', { ...valid, days: [7] }],
    ['days', { ...valid, days: [-1] }],
    ['days', { ...valid, days: [1, 1] }],
    ['days', { ...valid, days: [3, 2] }],
    ['days', { ...valid, days: [0, 1, 2, 3, 4, 5, 6, 6] }],
    ['days', { ...valid, days: [1.5] }],
    ['days', { ...valid, days: '12345' }],
    ['start', { ...valid, start: '24:00' }],
    ['start', { ...valid, start: '9:00' }],
    ['end', { ...valid, end: '12:60' }],
    ['end', { ...valid, end: 1700 }],
    ['tz', { ...valid, tz: 'Europe London' }],
    ['tz', { ...valid, tz: '' }],
    ['tz', { ...valid, tz: 'a'.repeat(65) }]
  ];
  for (const [field, hours] of cases) {
    assert.equal(validateBody('member.availability', { availability: 'available', workingHours: hours }), `${INVALID}: body.workingHours.${field}`, JSON.stringify(hours));
  }
  assert.equal(validateBody('member.availability', { availability: 'available', workingHours: { ...valid, extra: 1 } }), `${INVALID}: body.workingHours.extra`);
  assert.equal(validateBody('member.availability', { availability: 'available', workingHours: { tz: 'UTC' } }), `${INVALID}: body.workingHours.days`);
  assert.equal(validateBody('member.availability', { availability: 'busy' }), `${INVALID}: body.availability`);
});

test('skills: at most 32 unique lowercase tags of at most 40 characters', () => {
  const skills = (list: unknown): string | undefined => validateBody('member.skills', { memberId: OTHER_ID, skills: list });
  assert.equal(skills(['a']), undefined);
  assert.equal(skills(Array.from({ length: 32 }, (_unused, index) => `skill${index}`)), undefined);
  assert.equal(skills(['a'.repeat(40)]), undefined);
  for (const bad of [Array.from({ length: 33 }, (_unused, index) => `skill${index}`), ['dup', 'dup'], ['Upper'], ['a'.repeat(41)], [''], ['-lead'], ['has space'], [1], 'typescript']) {
    assert.equal(skills(bad), `${INVALID}: body.skills`, JSON.stringify(bad));
  }
});

test('team.created near link and ids are validated', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const created = bodiesFor(device)['team.created'] as Record<string, unknown>;
  assert.equal(validateBody('team.created', { ...created, near: { organizationId: 'org', workspaceId: 'bad space' } }), `${INVALID}: body.near.workspaceId`);
  assert.equal(validateBody('team.created', { ...created, near: { organizationId: 'org' } }), `${INVALID}: body.near.workspaceId`);
  assert.equal(validateBody('team.created', { ...created, near: { organizationId: 'org', workspaceId: 'w', extra: 1 } }), `${INVALID}: body.near.extra`);
  assert.equal(validateBody('team.created', { ...created, ownerId: 'owner' }), `${INVALID}: body.ownerId`);
  assert.equal(validateBody('team.created', { ...created, name: '' }), `${INVALID}: body.name`);
  assert.equal(validateBody('team.created', { ...created, policy: { ...defaultTeamPolicy(), safetyFactorBp: 1.25 } }), `${INVALID}: body.policy.safetyFactorBp`);
  assert.equal(validateBody('member.role-changed', { memberId: OTHER_ID, role: 'admin' }), `${INVALID}: body.role`);
  assert.equal(validateBody('member.joined', { memberId: OTHER_ID, name: 'x', emailHashes: [], role: 'root', device }), `${INVALID}: body.role`);
});

test('snapshot.written pins the path to the lamport and the hash to 64 lowercase hex', () => {
  const valid = { coversThrough: EVENT_A, lamport: 500, stateHash: HASH_A, path: 'snapshots/000000000500.json' };
  assert.equal(validateBody('snapshot.written', valid), undefined);
  assert.equal(validateBody('snapshot.written', { ...valid, path: 'snapshots/000000000501.json' }), `${INVALID}: body.path`);
  assert.equal(validateBody('snapshot.written', { ...valid, path: 'snapshots/500.json' }), `${INVALID}: body.path`);
  assert.equal(validateBody('snapshot.written', { ...valid, stateHash: 'A'.repeat(64) }), `${INVALID}: body.stateHash`);
  assert.equal(validateBody('snapshot.written', { ...valid, stateHash: 'a'.repeat(63) }), `${INVALID}: body.stateHash`);
  assert.equal(validateBody('snapshot.written', { ...valid, lamport: 0 }), `${INVALID}: body.lamport`);
  assert.equal(validateBody('snapshot.written', { ...valid, lamport: 1_000_000_000_000 }), `${INVALID}: body.lamport`);
  assert.equal(validateBody('snapshot.written', { ...valid, lamport: 1.5 }), `${INVALID}: body.lamport`);
  assert.equal(validateBody('snapshot.written', { ...valid, coversThrough: 'evt-1' }), `${INVALID}: body.coversThrough`);
  assert.equal(validateBody('snapshot.written', { ...valid, lamport: 1, path: 'snapshots/000000000001.json' }), undefined);
});

test('real genesis events from the harness parse through parseEventFile', async () => {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = testGenesis({ teamId, owner, name: 'Genesis team' });
  for (const event of genesis.events) {
    const result = parseEventFile(entryFor(event));
    assert.equal(result.ok, true, event.type);
  }
  const tampered = clone(genesis.events[1]) as unknown as { body: Record<string, unknown> };
  tampered.body.emails = ['owner@example.invalid'];
  assert.equal(rejection(entryFor(tampered)).reason, `${INVALID}: body.emails`);
});

test('validatePolicy accepts the default policy and rejects each kind of bad field', () => {
  assert.equal(validatePolicy(defaultTeamPolicy()), undefined);
  assert.equal(validatePolicy(defaultTeamPolicy({ integrationBranch: 'release/0.6' })), undefined);
  const policy = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...defaultTeamPolicy(), ...patch });
  const roles = { owner: [], lead: [], developer: [], reviewer: [], observer: [] };
  const weights = { roleFit: 3000, fileAffinity: 2500, continuity: 1500, capacity: 1500, budgetHeadroom: 1000, criticalPath: 500 };
  const bad: Array<[string, Record<string, unknown>]> = [
    ['safetyFactorBp', policy({ safetyFactorBp: 1.25 })],
    ['safetyFactorBp', policy({ safetyFactorBp: -1 })],
    ['overrunFactorBp', policy({ overrunFactorBp: 100_001 })],
    ['reconcileToleranceBp', policy({ reconcileToleranceBp: '500' })],
    ['dispatchMode', policy({ dispatchMode: 'manual' })],
    ['reviewPolicy', policy({ reviewPolicy: 'none' })],
    ['integrationMode', policy({ integrationMode: 'rebase' })],
    ['budgetPeriod', policy({ budgetPeriod: 'weekly' })],
    ['unspentPolicy', policy({ unspentPolicy: 'keep' })],
    ['offerTimeoutMinutes', policy({ offerTimeoutMinutes: 0 })],
    ['leaseTtlMinutes', policy({ leaseTtlMinutes: 10_081 })],
    ['heartbeatMinutes', policy({ heartbeatMinutes: 1.5 })],
    ['enforceWip', policy({ enforceWip: 'yes' })],
    ['teeOnly', policy({ teeOnly: 0 })],
    ['integrationBranch', policy({ integrationBranch: 'feature/../main' })],
    ['integrationBranch', policy({ integrationBranch: '-bad' })],
    ['integrationBranch', policy({ integrationBranch: 'has space' })],
    ['sharedPaths', policy({ sharedPaths: ['../outside'] })],
    ['sharedPaths', policy({ sharedPaths: ['a/../b'] })],
    ['sharedPaths', policy({ sharedPaths: ['/etc/passwd'] })],
    ['sharedPaths', policy({ sharedPaths: [''] })],
    ['sharedPaths', policy({ sharedPaths: ['a'.repeat(201)] })],
    ['sharedPaths', policy({ sharedPaths: Array.from({ length: 65 }, (_unused, index) => `f${index}`) })],
    ['resources', policy({ resources: [5] })],
    ['verifyCommands', policy({ verifyCommands: ['x'.repeat(201)] })],
    ['verifyCommands', policy({ verifyCommands: ['npm test\nrm -rf /'] })],
    ['verifyCommands', policy({ verifyCommands: Array.from({ length: 17 }, () => 'npm test') })],
    ['allowedModels', policy({ allowedModels: { owner: [], lead: [], developer: [], reviewer: [] } })],
    ['allowedModels', policy({ allowedModels: { ...roles, admin: [] } })],
    ['allowedModels', policy({ allowedModels: { ...roles, owner: ['m'.repeat(161)] } })],
    ['allowedModels', policy({ allowedModels: { ...roles, owner: Array.from({ length: 33 }, (_unused, index) => `m${index}`) } })],
    ['dispatchWeightsBp', policy({ dispatchWeightsBp: { ...weights, roleFit: 5000 } })],
    ['dispatchWeightsBp', policy({ dispatchWeightsBp: { roleFit: 10_000, fileAffinity: 0, continuity: 0, capacity: 0, budgetHeadroom: 0 } })],
    ['dispatchWeightsBp', policy({ dispatchWeightsBp: { roleFit: 10_001, fileAffinity: -1, continuity: 0, capacity: 0, budgetHeadroom: 0, criticalPath: 0 } })]
  ];
  for (const [field, value] of bad) {
    assert.equal(validatePolicy(value), `${INVALID}: policy.${field}`, `${field} ${JSON.stringify(value[field]).slice(0, 60)}`);
  }
  const valid = defaultTeamPolicy() as unknown as Record<string, unknown>;
  const missing = { ...valid };
  delete missing.teeOnly;
  assert.equal(validatePolicy(missing), `${INVALID}: policy.teeOnly`);
  assert.equal(validatePolicy({ ...valid, notAKey: 1 }), `${INVALID}: policy.notAKey`);
  assert.equal(validatePolicy({ ...valid, ['sp ace']: 1 }), `${INVALID}: policy.sp?ace`);
  assert.equal(validatePolicy([]), `${INVALID}: policy`);
  assert.equal(validatePolicy(null, 'body.policy'), `${INVALID}: body.policy`);
  assert.equal(validatePolicy(policy({ dispatchWeightsBp: { roleFit: 10_000, fileAffinity: 0, continuity: 0, capacity: 0, budgetHeadroom: 0, criticalPath: 0 } })), undefined, 'all weight on one factor still sums to 10000');
  assert.equal(validatePolicy(policy({ sharedPaths: ['src/**/*.ts', 'docs/a.md'], verifyCommands: [] })), undefined);
});

test('validatePolicyChanges needs at least one valid known key; applyPolicyChanges returns a new object', () => {
  assert.equal(validatePolicyChanges({}), `${INVALID}: changes`);
  assert.equal(validatePolicyChanges([]), `${INVALID}: changes`);
  assert.equal(validatePolicyChanges(null), `${INVALID}: changes`);
  assert.equal(validatePolicyChanges({ peerMetricsVisible: true }), undefined);
  assert.equal(validatePolicyChanges({ notAKey: 1 }), `${INVALID}: changes.notAKey`);
  assert.equal(validatePolicyChanges(JSON.parse('{"__proto__":{"x":1}}')), `${INVALID}: changes.__proto__`);
  assert.equal(validatePolicyChanges({ constructor: 1 }), `${INVALID}: changes.constructor`);
  assert.equal(validatePolicyChanges({ safetyFactorBp: 1.25 }), `${INVALID}: changes.safetyFactorBp`);
  assert.equal(validatePolicyChanges({ peerMetricsVisible: true, dispatchMode: 'nope' }), `${INVALID}: changes.dispatchMode`);
  assert.equal(validatePolicyChanges({ sharedPaths: ['a'] }, 'body.changes'), undefined);
  assert.equal(validatePolicyChanges({}, 'body.changes'), `${INVALID}: body.changes`);

  const before = defaultTeamPolicy();
  const snapshot = JSON.stringify(before);
  const changes = { peerMetricsVisible: true, sharedPaths: ['only.txt'], dispatchWeightsBp: { roleFit: 10_000, fileAffinity: 0, continuity: 0, capacity: 0, budgetHeadroom: 0, criticalPath: 0 } };
  const after = applyPolicyChanges(before, changes);
  assert.equal(JSON.stringify(before), snapshot, 'the input policy is unchanged');
  assert.notEqual(after, before);
  assert.equal(after.peerMetricsVisible, true);
  assert.deepEqual(after.sharedPaths, ['only.txt']);
  assert.notEqual(after.sharedPaths, changes.sharedPaths, 'arrays are copied');
  assert.notEqual(after.dispatchWeightsBp, changes.dispatchWeightsBp);
  assert.notEqual(after.allowedModels, before.allowedModels);
  assert.notEqual(after.verifyCommands, before.verifyCommands);
  assert.equal(after.leaseTtlMinutes, before.leaseTtlMinutes);
  assert.equal(validatePolicy(after), undefined);
  after.verifyCommands.push('extra');
  assert.equal(before.verifyCommands.includes('extra'), false);
  assert.deepEqual(applyPolicyChanges(before, {}), before);
});

// WR-09: one branch-name validator that follows git. Names git accepts and the old ASCII-only pattern refused, and names the old pattern
// accepted that git refuses, are both checked against `git check-ref-format --branch` itself.
test('isGitRefName agrees with git check-ref-format --branch (WR-09)', () => {
  const gitAccepts = (name: string): boolean => {
    try {
      execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const names = [
    'main', 'release/0.6', 'feature/c++', 'user@work/fix', 'topic#12', 'a,b', 'caf\u00E9/menu', '\u65E5\u672C\u8A9E', `long/${'x'.repeat(200)}`,
    'a//b', 'release.lock', 'dir.lock/x', '.hidden', 'a/.hidden', 'trailing/', '/leading', 'ends.', 'a..b', 'a@{b', '-dash', 'has space',
    'tilde~1', 'caret^', 'colon:x', 'question?', 'star*', 'bracket[0]', 'back\\slash', 'tab\tname', 'ctrl\u0001name', '', 'del\u007Fname'
  ];
  for (const name of names) assert.equal(isGitRefName(name), gitAccepts(name), `isGitRefName(${JSON.stringify(name)})`);
  // `check-ref-format --branch @` expands to the current branch, so it is checked on its own: git branch refuses the name '@'.
  assert.equal(isGitRefName('@'), false);
  // Beyond git: invisible format characters could make a name read as something else, and a name past 255 characters is not a branch to sign.
  assert.equal(isGitRefName('main\u202Egnp'), false);
  assert.equal(isGitRefName('zero\u200Bwidth'), false);
  assert.equal(isGitRefName('x'.repeat(256)), false);
  for (const name of ['feature/c++', 'user@work/fix', 'caf\u00E9/menu']) {
    assert.equal(validatePolicy(defaultTeamPolicy({ integrationBranch: name })), undefined, name);
  }
  for (const name of ['a//b', 'release.lock', 'trailing/']) {
    assert.equal(validatePolicy(defaultTeamPolicy({ integrationBranch: name })), `${INVALID}: policy.integrationBranch`, name);
  }
});

test('member.key-sealed accepts one to eight sealed entries and rejects every other shape by field path', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const valid = bodiesFor(device)['member.key-sealed'] as Record<string, unknown>;
  const entry = sealedEntry(device);
  const other = { ...entry, device: `dev-${'1'.repeat(32)}` };
  const withSealed = (sealed: unknown): Record<string, unknown> => ({ ...clone(valid), sealed });
  assert.equal(validateBody('member.key-sealed', valid), undefined);
  const eight = Array.from({ length: 8 }, (_unused, index) => ({ ...entry, device: `dev-${String(index).repeat(32)}` }));
  assert.equal(validateBody('member.key-sealed', withSealed(eight)), undefined, 'eight entries');
  assert.equal(validateBody('member.key-sealed', withSealed([])), `${INVALID}: body.sealed`, 'no entries');
  assert.equal(validateBody('member.key-sealed', withSealed([...eight, other])), `${INVALID}: body.sealed`, 'nine entries');
  assert.equal(validateBody('member.key-sealed', withSealed([entry, entry])), `${INVALID}: body.sealed`, 'the same device twice');
  assert.equal(validateBody('member.key-sealed', withSealed({})), `${INVALID}: body.sealed`, 'not a list');
  assert.equal(validateBody('member.key-sealed', { ...clone(valid), scheme: 'x25519-hkdf-sha256-aes-256-gcm-v2' }), `${INVALID}: body.scheme`);
  assert.equal(validateBody('member.key-sealed', { ...clone(valid), keyId: 'has space' }), `${INVALID}: body.keyId`);
  assert.equal(validateBody('member.key-sealed', { ...clone(valid), keyId: '' }), `${INVALID}: body.keyId`);

  for (const key of ['device', 'ephemeral', 'nonce', 'tag', 'ciphertext']) {
    const missing = { ...entry };
    delete missing[key];
    assert.equal(validateBody('member.key-sealed', withSealed([missing])), `${INVALID}: body.sealed[0].${key}`, `missing ${key}`);
  }
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, surprise: 1 }])), `${INVALID}: body.sealed[0].surprise`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, device: 'dev-short' }])), `${INVALID}: body.sealed[0].device`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ephemeral: { publicKey: 'short' } }])), `${INVALID}: body.sealed[0].ephemeral.publicKey`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ephemeral: { publicKey: device.publicKey, extra: 1 } }])), `${INVALID}: body.sealed[0].ephemeral.extra`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, nonce: Buffer.alloc(11).toString('base64url') }])), `${INVALID}: body.sealed[0].nonce`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, tag: Buffer.alloc(15).toString('base64url') }])), `${INVALID}: body.sealed[0].tag`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, nonce: `${Buffer.alloc(12).toString('base64url')}=` }])), `${INVALID}: body.sealed[0].nonce`, 'padding is not strict base64url');
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ciphertext: Buffer.alloc(16, 1).toString('base64url') }])), undefined, '16 bytes is the smallest ciphertext');
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ciphertext: Buffer.alloc(15, 1).toString('base64url') }])), `${INVALID}: body.sealed[0].ciphertext`);
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ciphertext: Buffer.alloc(525, 1).toString('base64url') }])), undefined, '525 bytes is the largest ciphertext');
  assert.equal(validateBody('member.key-sealed', withSealed([{ ...entry, ciphertext: Buffer.alloc(526, 1).toString('base64url') }])), `${INVALID}: body.sealed[0].ciphertext`);
});

test('device.added may carry a seal key, and only as a one-key object holding 32 bytes', async () => {
  const { owner } = await context();
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const added = { memberId: OTHER_ID, device };
  assert.equal(validateBody('device.added', added), undefined, 'a device.added without a seal key is still valid');
  assert.equal(validateBody('device.added', { ...added, sealKey: { publicKey: device.publicKey } }), undefined);
  assert.equal(validateBody('device.added', { ...added, sealKey: { publicKey: 'short' } }), `${INVALID}: body.sealKey.publicKey`);
  assert.equal(validateBody('device.added', { ...added, sealKey: { publicKey: device.publicKey, extra: 1 } }), `${INVALID}: body.sealKey.extra`);
  assert.equal(validateBody('device.added', { ...added, sealKey: 'x' }), `${INVALID}: body.sealKey`);
});
