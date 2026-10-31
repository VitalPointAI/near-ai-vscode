// Schema tests for the team event envelope, the ten Phase 60 bodies and the policy (D-07, D-08, D-09 step 1, D-30, D-31).
// Reasons are asserted verbatim: they are the fixed strings the materialiser and the UI show.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_EVENT_BYTES, canonicalize, eventPath } from '../domain/team/canonical';
import { parseEventFile, validateEnvelope } from '../domain/team/validate';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, TeamEvent } from '../domain/team/types';
import { newMemberId, newTeamId } from '../team/identity';
import { createOwner, testEvent } from './helpers/teamHarness';
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
  assert.equal(rejection(entryFor({ ...event, type: 'item.created' })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, type: 'made.up' })).reason, unsupported);
  assert.equal(rejection(entryFor({ ...event, type: 'member.invited' })).reason, unsupported, 'known to the union but not implemented in Phase 60');
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
