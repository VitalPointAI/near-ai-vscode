// Roster audit mirror (D-26): team-roster is an accepted audit type, accepted roster events are mirrored once with member
// attribution and no secrets, and a restart or a trimmed audit log never duplicates an entry.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SecretLeakError } from '../domain/team/secrets';
import type { Role, TeamEvent } from '../domain/team/types';
import { newEventId, newMemberId, newTeamId, signEvent } from '../team/identity';
import { ROSTER_AUDIT_TYPES, fileMirrorMark, mirrorRosterEvents, rosterAuditId, toRosterAuditEvent } from '../team/auditMirror';
import type { AuditSink, MirrorMark } from '../team/auditMirror';
import { AuditStore } from '../services/auditStore';
import type { AuditEvent } from '../domain/approval';
import { createOwner, testGenesis } from './helpers/teamHarness';
import type { TestOwner } from './helpers/teamHarness';

interface Rig { workspace: string; storage: string; teamId: string; owner: TestOwner; genesis: ReturnType<typeof testGenesis> }

async function rig(): Promise<Rig> {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-teamaudit-ws-'));
  const storage = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-teamaudit-store-'));
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  return { workspace, storage, teamId, owner, genesis: testGenesis({ teamId, owner, name: 'Audit mirror test' }) };
}

async function dispose(r: Rig): Promise<void> {
  await fs.rm(r.workspace, { recursive: true, force: true });
  await fs.rm(r.storage, { recursive: true, force: true });
}

const auditFile = (r: Rig): string => path.join(r.workspace, '.planning', '.near-ai', 'audit.json');
const ownerRole = (r: Rig) => (memberId: string): Role | undefined => (memberId === r.owner.memberId ? 'owner' : undefined);

function skillsEvent(r: Rig, lamport: number, prev: string): TeamEvent<'member.skills'> {
  return signEvent(r.owner.identity, {
    v: 1, id: newEventId(), teamId: r.teamId, type: 'member.skills', lamport, at: '2026-01-01T00:00:02.000Z', author: r.owner.memberId,
    device: r.owner.identity.fingerprint, prev, body: { memberId: r.owner.memberId, skills: ['typescript'] }
  });
}

function availabilityEvent(r: Rig, lamport: number, prev: string): TeamEvent<'member.availability'> {
  return signEvent(r.owner.identity, {
    v: 1, id: newEventId(), teamId: r.teamId, type: 'member.availability', lamport, at: '2026-01-01T00:00:03.000Z', author: r.owner.memberId,
    device: r.owner.identity.fingerprint, prev, body: { availability: 'focus' }
  });
}

function policyEvent(r: Rig, lamport: number, prev: string): TeamEvent<'policy.changed'> {
  return signEvent(r.owner.identity, {
    v: 1, id: newEventId(), teamId: r.teamId, type: 'policy.changed', lamport, at: '2026-01-01T00:00:04.000Z', author: r.owner.memberId,
    device: r.owner.identity.fingerprint, prev, body: { changes: { teeOnly: true } }
  });
}

function snapshotEvent(r: Rig, lamport: number, prev: string): TeamEvent<'snapshot.written'> {
  return signEvent(r.owner.identity, {
    v: 1, id: newEventId(), teamId: r.teamId, type: 'snapshot.written', lamport, at: '2026-01-01T00:00:05.000Z', author: r.owner.memberId,
    device: r.owner.identity.fingerprint, prev, body: { coversThrough: prev, lamport: lamport - 1, stateHash: '0'.repeat(64), path: `snapshots/${String(lamport - 1).padStart(12, '0')}.json` }
  });
}

test('AuditStore now keeps team-roster entries, which were dropped before', async () => {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-teamaudit-type-'));
  try {
    const store = new AuditStore(workspace);
    await store.append({ version: 1, id: 'roster-one', timestamp: '2026-01-01T00:00:00.000Z', type: 'team-roster', projectId: 'p1' });
    assert.equal((await new AuditStore(workspace).list({ type: 'team-roster' })).length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('the genesis events mirror as two team-roster entries with member attribution and exact metadata', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const appended = await mirrorRosterEvents(store, fileMirrorMark(r.storage), r.genesis.events, ownerRole(r));
    assert.equal(appended, 2);
    const [created, joined] = r.genesis.events;
    const entries = await store.list({ type: 'team-roster' });
    assert.deepEqual(entries.map((entry) => entry.id), [rosterAuditId(created.id), rosterAuditId(joined.id)]);
    assert.deepEqual(entries.map((entry) => entry.timestamp), [created.at, joined.at]);
    for (const entry of entries) {
      assert.equal(entry.version, 1);
      assert.equal(entry.projectId, r.teamId);
      assert.equal(entry.outcome, 'accepted');
      assert.equal(entry.type, 'team-roster');
    }
    assert.deepEqual(entries[0].metadata, { eventType: 'team.created', eventId: created.id, lamport: 1, memberId: r.owner.memberId, role: 'owner', subjectId: r.owner.memberId });
    assert.deepEqual(entries[1].metadata, { eventType: 'member.joined', eventId: joined.id, lamport: 2, memberId: r.owner.memberId, role: 'owner', subjectId: r.owner.memberId });
  } finally {
    await dispose(r);
  }
});

test('mirroring again, after a simulated restart, and with a lost mark appends nothing more', async () => {
  const r = await rig();
  try {
    const first = new AuditStore(r.workspace);
    assert.equal(await mirrorRosterEvents(first, fileMirrorMark(r.storage), r.genesis.events, ownerRole(r)), 2);
    assert.equal(await mirrorRosterEvents(first, fileMirrorMark(r.storage), r.genesis.events, ownerRole(r)), 0);
    const restartedStore = new AuditStore(r.workspace);
    assert.equal(await mirrorRosterEvents(restartedStore, fileMirrorMark(r.storage), r.genesis.events, ownerRole(r)), 0);
    assert.equal((await restartedStore.list({ type: 'team-roster' })).length, 2);
    await fs.rm(path.join(r.storage, 'audit-mark.json'));
    assert.equal(await mirrorRosterEvents(new AuditStore(r.workspace), fileMirrorMark(r.storage), r.genesis.events, ownerRole(r)), 0, 'id dedupe holds even without the mark');
    assert.equal((await new AuditStore(r.workspace).list({ type: 'team-roster' })).length, 2);
  } finally {
    await dispose(r);
  }
});

test('the role passed for each event is the one recorded, so a history replayed in one batch is not stamped with final roles (WR-05)', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const skills = skillsEvent(r, 3, r.genesis.events[1].id);
    const atTheTime = new Map<string, Role>([[r.genesis.events[0].id, 'owner'], [r.genesis.events[1].id, 'owner'], [skills.id, 'lead']]);
    await mirrorRosterEvents(store, fileMirrorMark(r.storage), [...r.genesis.events, skills], (_memberId, event) => atTheTime.get(event.id));
    const entries = await store.list({ type: 'team-roster' });
    assert.deepEqual(entries.map((entry) => entry.metadata?.role), ['owner', 'owner', 'lead']);
  } finally {
    await dispose(r);
  }
});

test('only events above the stored mark are mirrored, and the mark follows the highest lamport', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const mark = fileMirrorMark(r.storage);
    await mirrorRosterEvents(store, mark, r.genesis.events, ownerRole(r));
    assert.equal(await mark.read(), 2);
    const skills = skillsEvent(r, 3, r.genesis.events[1].id);
    assert.equal(await mirrorRosterEvents(store, mark, [...r.genesis.events, skills], ownerRole(r)), 1);
    assert.equal(await mark.read(), 3);
    const entries = await store.list({ type: 'team-roster' });
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[2].metadata, { eventType: 'member.skills', eventId: skills.id, lamport: 3, memberId: r.owner.memberId, role: 'owner', subjectId: r.owner.memberId });
  } finally {
    await dispose(r);
  }
});

test('policy.changed and snapshot.written events are not mirrored', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const mark = fileMirrorMark(r.storage);
    const policy = policyEvent(r, 3, r.genesis.events[1].id);
    const snapshot = snapshotEvent(r, 4, policy.id);
    assert.equal(await mirrorRosterEvents(store, mark, [...r.genesis.events, policy, snapshot], ownerRole(r)), 2);
    assert.deepEqual((await store.list({ type: 'team-roster' })).map((entry) => entry.metadata?.eventType), ['team.created', 'member.joined']);
    assert.equal(await mirrorRosterEvents(store, mark, [policy, snapshot], ownerRole(r)), 0);
    assert.deepEqual(ROSTER_AUDIT_TYPES, ['team.created', 'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'member.key-sealed']);
  } finally {
    await dispose(r);
  }
});

test('member.invited and member.key-sealed are mirrored as metadata only, with no hash, key or sealed field in either entry', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const mark = fileMirrorMark(r.storage);
    const target = newMemberId();
    const emailHashValue = createHash('sha256').update(`${r.teamId}:dana@example.invalid`).digest('hex');
    const invitePublicKey = randomBytes(32).toString('base64url');
    const keyId = `key_${randomBytes(8).toString('hex')}`;
    const sealed = {
      device: `dev-${randomBytes(16).toString('hex')}`, ephemeral: { publicKey: randomBytes(32).toString('base64url') }, nonce: randomBytes(12).toString('base64url'),
      tag: randomBytes(16).toString('base64url'), ciphertext: randomBytes(40).toString('base64url')
    };
    const invited = signEvent(r.owner.identity, {
      v: 1, id: newEventId(), teamId: r.teamId, type: 'member.invited', lamport: 3, at: '2026-01-01T00:00:06.000Z', author: r.owner.memberId,
      device: r.owner.identity.fingerprint, prev: r.genesis.events[1].id,
      body: { memberId: target, name: 'Dana', emailHashes: [emailHashValue], role: 'developer', allocationNanoUsd: 5_000_000_000, ttlSeconds: 604_800, invite: { publicKey: invitePublicKey } }
    });
    const keySealed = signEvent(r.owner.identity, {
      v: 1, id: newEventId(), teamId: r.teamId, type: 'member.key-sealed', lamport: 4, at: '2026-01-01T00:00:07.000Z', author: r.owner.memberId,
      device: r.owner.identity.fingerprint, prev: invited.id,
      body: { memberId: target, keyId, scheme: 'x25519-hkdf-sha256-aes-256-gcm-v1', sealed: [sealed] }
    });
    assert.equal(await mirrorRosterEvents(store, mark, [...r.genesis.events, invited, keySealed], ownerRole(r)), 4);
    const entries = (await store.list({ type: 'team-roster' })).filter((entry) => entry.metadata?.lamport === 3 || entry.metadata?.lamport === 4);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].metadata, { eventType: 'member.invited', eventId: invited.id, lamport: 3, memberId: r.owner.memberId, role: 'owner', subjectId: target });
    assert.deepEqual(entries[1].metadata, { eventType: 'member.key-sealed', eventId: keySealed.id, lamport: 4, memberId: r.owner.memberId, role: 'owner', subjectId: target });
    const text = JSON.stringify(entries);
    for (const forbidden of [emailHashValue, invitePublicKey, keyId, sealed.device, sealed.ephemeral.publicKey, sealed.nonce, sealed.tag, sealed.ciphertext]) {
      assert.equal(text.includes(forbidden), false, 'a hash, key or sealed field reached the audit entry');
    }
  } finally {
    await dispose(r);
  }
});

test('an event with no member in its body has no subject id and an unknown author role is left out', async () => {
  const r = await rig();
  try {
    const availability = availabilityEvent(r, 3, r.genesis.events[1].id);
    const entry = toRosterAuditEvent(availability, undefined);
    assert.deepEqual(entry.metadata, { eventType: 'member.availability', eventId: availability.id, lamport: 3, memberId: r.owner.memberId });
    assert.equal(entry.id, rosterAuditId(availability.id));
  } finally {
    await dispose(r);
  }
});

test('no metadata key trips the audit store key filter, so every field survives redaction', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const skills = skillsEvent(r, 3, r.genesis.events[1].id);
    const events = [...r.genesis.events, skills, availabilityEvent(r, 4, skills.id)];
    await mirrorRosterEvents(store, fileMirrorMark(r.storage), events, ownerRole(r));
    const stored = await store.list({ type: 'team-roster' });
    assert.equal(stored.length, 4);
    for (const [index, event] of events.entries()) {
      const built = toRosterAuditEvent(event, 'owner');
      assert.deepEqual(Object.keys(built.metadata ?? {}).filter((key) => /(secret|token|key|password|prompt|command|context|output|path)/i.test(key)), []);
      assert.deepEqual(stored[index].metadata, built.metadata);
    }
    const text = JSON.stringify(stored);
    assert.doesNotMatch(text, /Owner Test|owner@example|publicKey|dev-[0-9a-f]{32}/, 'no names, emails, keys or fingerprints');
  } finally {
    await dispose(r);
  }
});

test('rosterAuditId is stable, short and different per event', () => {
  const id = newEventId();
  assert.equal(rosterAuditId(id), rosterAuditId(id));
  assert.match(rosterAuditId(id), /^audit-team-[0-9a-f]{16}$/);
  assert.ok(rosterAuditId(id).length <= 80);
  assert.notEqual(rosterAuditId(id), rosterAuditId(newEventId()));
});

test('a secret-like value in an audit entry makes the mirror throw and leaves the audit file and mark unchanged', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const mark = fileMirrorMark(r.storage);
    await mirrorRosterEvents(store, mark, r.genesis.events, ownerRole(r));
    const before = await fs.readFile(auditFile(r), 'utf8');
    const canary = `sk-${randomBytes(12).toString('hex')}`;
    const skills = skillsEvent(r, 3, r.genesis.events[1].id);
    await assert.rejects(
      () => mirrorRosterEvents(store, mark, [skills, availabilityEvent(r, 4, skills.id)], () => canary as Role),
      (error: unknown) => error instanceof SecretLeakError && !error.message.includes(canary)
    );
    assert.equal(await fs.readFile(auditFile(r), 'utf8'), before);
    assert.equal(await mark.read(), 2);
  } finally {
    await dispose(r);
  }
});

test('the mark keeps the mirror idempotent after the audit store trims old entries', async () => {
  const r = await rig();
  try {
    const store = new AuditStore(r.workspace);
    const mark = fileMirrorMark(r.storage);
    await mirrorRosterEvents(store, mark, r.genesis.events, ownerRole(r));
    for (let index = 0; index < 510; index += 1) {
      await store.append({ version: 1, id: `filler-${index}`, timestamp: '2026-01-02T00:00:00.000Z', type: 'route', projectId: 'other' });
    }
    assert.equal((await store.list({ type: 'team-roster' })).length, 0, 'the cap trimmed the roster rows');
    assert.equal(await mirrorRosterEvents(store, mark, r.genesis.events, ownerRole(r)), 0);
    assert.equal((await store.list({ type: 'team-roster' })).length, 0);
  } finally {
    await dispose(r);
  }
});

test('the mirror works against any sink and appends in lamport order even when given events out of order', async () => {
  const r = await rig();
  try {
    const rows: AuditEvent[] = [];
    const sink: AuditSink = {
      list: async (filter) => rows.filter((row) => filter.type === undefined || row.type === filter.type),
      append: async (event) => { rows.push(event); }
    };
    let stored = 0;
    const memoryMark: MirrorMark = { read: async () => stored, write: async (value) => { stored = value; } };
    const skills = skillsEvent(r, 3, r.genesis.events[1].id);
    assert.equal(await mirrorRosterEvents(sink, memoryMark, [skills, r.genesis.events[1], r.genesis.events[0]], ownerRole(r)), 3);
    assert.deepEqual(rows.map((row) => row.metadata?.lamport), [1, 2, 3]);
    assert.equal(stored, 3);
  } finally {
    await dispose(r);
  }
});

test('fileMirrorMark reads zero when absent, round-trips, refuses a bad value and fails loudly on a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-teamaudit-mark-'));
  try {
    const mark = fileMirrorMark(dir);
    assert.equal(await mark.read(), 0);
    await mark.write(7);
    assert.equal(await mark.read(), 7);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'audit-mark.json'), 'utf8')), { version: 1, lamport: 7 });
    assert.deepEqual(await fs.readdir(dir), ['audit-mark.json']);
    await assert.rejects(() => mark.write(-1), RangeError);
    await assert.rejects(() => mark.write(1.5), RangeError);
    await fs.writeFile(path.join(dir, 'audit-mark.json'), '{oops', 'utf8');
    await assert.rejects(() => mark.read(), /cannot be read/);
    await fs.writeFile(path.join(dir, 'audit-mark.json'), JSON.stringify({ version: 2, lamport: 1 }), 'utf8');
    await assert.rejects(() => mark.read(), /not in a form/);
    await fs.writeFile(path.join(dir, 'audit-mark.json'), 'null', 'utf8');
    await assert.rejects(() => mark.read(), /not in a form/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
