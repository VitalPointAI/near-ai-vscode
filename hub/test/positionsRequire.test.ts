import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES, POSITIONS_FEATURE, UPDATE_SENTENCE, VERIFIED_CLEARANCE_FEATURE } from '@ext/domain/replica/features';
import { GENESIS_PREV, buildEntryAsync, entryHash } from '@ext/domain/replica/entry';
import type { Actor, SealedEntry } from '@ext/domain/replica/entry';
import { buildSessionAnswer } from '@ext/domain/replica/hubFile';
import { ROSTER_REFUSALS, foldRoster, positionSettingsAt, projectModeAt, projectRequiresCredentials } from '@ext/domain/replica/roster';
import type { RosterState } from '@ext/domain/replica/roster';
import { sessionCertifyData } from '@ext/domain/replica/sessionKeys';
import type { AsyncPayloadSigner, PayloadSigner } from '@ext/domain/team/signedPayload';
import { APPEND_REFUSALS } from '../src/append/checks';
import { RosterCache, sealedOf } from '../src/append/rosterCache';
import { hubReplicaFeatures } from '../src/features';
import { SESSION_REFUSALS } from '../src/http/session';
import type { StoredEntry } from '../src/store/hubStore';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// Phase 33.1, plan 03 (D-05, D-09, D-11, D-39; POST-01): your organization's server folds positions@1 and the signed way of working (project.mode)
// exactly as members' computers do, refuses a session from a build that does not fold a feature the project requires, and refuses every 33.1 roster
// kind written by a session key. The lead's entries are signed through an asynchronous signer, the person key's path. Fictional people and keys only.

const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const POLICY = hashOf('policy/example-organization');
const POSITION = 'watch-officer-night';
const POSTING = 'pst-watch-night-1';
const LABEL = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };
const createData = { position: POSITION, title: 'Watch Officer, night', section: 'j3', decides: [], clearance: LABEL, keyGroups: [], acting: false, dualHat: false };
const modeData = (mode: string, settings: Record<string, unknown> = {}): Record<string, unknown> => ({ mode, settings, policy: POLICY, reason: 'Fictional exercise way of working' });

/** An asynchronous signer over a device's key, standing in for your organization's key store. */
function asyncOf(signer: PayloadSigner): AsyncPayloadSigner {
  return { fingerprint: signer.fingerprint, publicKey: signer.publicKey, sign: async (bytes: Buffer): Promise<string> => { await new Promise((resolve) => setImmediate(resolve)); return signer.sign(bytes); } };
}

/** A roster entry of the device, built with buildEntryAsync after its last base-stream entry, citing the world's head. */
async function asyncRoster(world: HubWorld, device: WorldDevice, kind: string, data: Record<string, unknown>, options: { actor?: Actor; advance?: boolean } = {}): Promise<Written> {
  const own = world.entries.filter((entry) => entry.header.stream === world.project && entry.header.writer === device.writer);
  const last = own[own.length - 1];
  const rosterPrev = world.head;
  const built = await buildEntryAsync({
    signer: asyncOf(device.signer), key: world.keyOf(world.project, 1), stream: world.project, seq: own.length, prev: last === undefined ? GENESIS_PREV : entryHash(last.header), epoch: 1,
    body: { deps: [], roster: rosterPrev, lamport: 1000 + world.entries.length, at: '2026-11-19T11:30:00.000Z', actor: options.actor ?? { kind: 'person' }, kind, data: { ...data, rosterPrev } }
  });
  assert.ok('entry' in built);
  world.entries.push(built.entry);
  if (options.advance !== false) world.head = built.hash;
  return { entry: built.entry, hash: built.hash, stream: world.project, writer: device.writer, seq: own.length, blobs: built.blobs };
}

interface Setup { world: HubWorld; pat: WorldDevice; cell: string }

async function enrolled(hub: Hub, required: readonly string[][] = []): Promise<Setup> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  world.admitMember(pat, { slot: 7 });
  const { cell } = world.labelCell('internal', [world.lead, pat]);
  for (const features of required) world.rosterEntry(world.lead, 'roster.require', { features });
  await hub.enrolProject(world, { direct: true });
  return { world, pat, cell };
}

async function append(world: HubWorld, by: OpenedSession, entries: readonly Written[]): Promise<{ accepted: string[]; refused: Array<{ hash?: string; reason: string; message: string }> }> {
  const answer = await by.connection.post(`/v1/projects/${world.project}/append`, { entries: entries.map((item) => item.entry) }, by.token);
  assert.equal(answer.status, 200, answer.text);
  const body = answer.json<{ accepted?: string[]; refused?: Array<{ hash?: string; reason: string; message: string }> }>();
  return { accepted: body.accepted ?? [], refused: body.refused ?? [] };
}

const reasonOf = (answer: { refused: Array<{ hash?: string; reason: string }> }, written: Written): string | undefined => answer.refused.find((item) => item.hash === written.hash)?.reason;

/** Every base-stream entry the server stored, as a second replica pulls them. */
function pulled(hub: Hub, world: HubWorld): SealedEntry[] {
  const entries: SealedEntry[] = [];
  for (const stream of hub.store.heads(world.project)) {
    if (stream.stream !== world.project) continue;
    for (const head of stream.heads) {
      const page = hub.store.entriesFrom(world.project, world.project, head.writer, 0, { limit: 1000, maxBytes: 8 * 1024 * 1024 });
      for (const row of page.entries) entries.push(sealedOf(row as StoredEntry));
    }
  }
  return entries;
}

const foldOf = (world: HubWorld, device: WorldDevice, entries: readonly SealedEntry[]): RosterState =>
  foldRoster({ entries, anchor: world.anchor(), keys: world.ringFor(device), blobs: () => undefined, grants: world.grants, now: new Date(NOW_MS) });

const headOf = (state: RosterState): number => state.positions.length - 1;
const refusedIn = (state: RosterState, written: Written): string | undefined => state.refused.find((item) => item.hash === written.hash)?.reason;

test('tracer: the lead\'s positions@1 and project.mode fold to the same mode and settings on the server, its reloaded roster and a member\'s replica', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const requires = await asyncRoster(s.world, s.world.lead, 'roster.require', { features: [POSITIONS_FEATURE] });
    const mode = await asyncRoster(s.world, s.world.lead, 'project.mode', modeData('military', { overdueDays: 3, mayDecline: false }));
    const lead = await hub.openSession(s.world.lead, s.world.project);
    const answer = await append(s.world, lead, [requires, mode]);
    assert.deepEqual(answer.refused, []);
    assert.deepEqual(answer.accepted, [requires.hash, mode.hash]);
    const live = (await hub.cache.get(s.world.project)).state;
    const reloaded = (await new RosterCache(hub.store, hub.identity).get(s.world.project)).state;
    const replica = foldOf(s.world, s.pat, pulled(hub, s.world));
    for (const state of [live, reloaded, replica]) {
      assert.equal(state.positions[headOf(state)], mode.hash);
      assert.equal(projectModeAt(state, headOf(state)), 'military');
      assert.deepEqual(positionSettingsAt(state, headOf(state)), { overdueDays: 3, mayDecline: false });
      assert.equal(projectModeAt(state, headOf(state) - 1), 'corporate', 'before the mode, Corporate (portfolio D12)');
      assert.deepEqual(state.refused, []);
    }
    for (const feature of [POSITIONS_FEATURE, VERIFIED_CLEARANCE_FEATURE]) assert.ok(hubReplicaFeatures().includes(feature), feature);
  }));

test('a session from a build that does not fold positions@1 is refused needs-update with the update sentence once the project requires it; this build\'s opens', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub, [[POSITIONS_FEATURE, 'require@1']]);
    const older = KNOWN_REPLICA_FEATURES.filter((id) => id !== POSITIONS_FEATURE);
    const opened = async (features: readonly string[]): Promise<{ status: number; body: Record<string, unknown> }> => {
      const connection = await hub.connect();
      const challenge = await connection.post('/v1/session', { project: s.world.project });
      const body = challenge.json<{ hub: string; challenge: string }>();
      const answer = buildSessionAnswer(s.pat.signer, { hub: body.hub, project: s.world.project, challenge: body.challenge, keying: connection.keying(), features, now: new Date(hub.now()) });
      const response = await connection.post('/v1/session', { answer });
      return { status: response.status, body: response.json<Record<string, unknown>>() };
    };
    const refused = await opened(older);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: 'session-refused', reason: 'needs-update', message: SESSION_REFUSALS['needs-update'] });
    assert.equal(SESSION_REFUSALS['needs-update'], UPDATE_SENTENCE);
    assert.equal((await opened(KNOWN_REPLICA_FEATURES)).status, 200);
  }));

test('project.mode and position.create before positions@1 is required are refused positions-not-required by the server and by the fold', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const lead = await hub.openSession(s.world.lead, s.world.project);
    const mode = await asyncRoster(s.world, s.world.lead, 'project.mode', modeData('military'), { advance: false });
    const create = await asyncRoster(s.world, s.world.lead, 'position.create', createData, { advance: false });
    const answer = await append(s.world, lead, [mode]);
    assert.equal(reasonOf(answer, mode), 'positions-not-required');
    assert.equal(answer.refused[0]?.message, ROSTER_REFUSALS['positions-not-required']);
    assert.equal(APPEND_REFUSALS['positions-not-required'], ROSTER_REFUSALS['positions-not-required']);
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, mode), 'positions-not-required');
    assert.equal(refusedIn(fold, create), 'positions-not-required');
  }));

test('project.mode by a member who is not the lead, by an agent, or looser than its mode is refused with the same named reason by the server and the fold', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub, [[POSITIONS_FEATURE]]);
    const byMember = s.world.rosterEntry(s.pat, 'project.mode', modeData('military'), { advance: false });
    const byAgent = await asyncRoster(s.world, s.world.lead, 'project.mode', modeData('military'), { actor: { kind: 'agent', member: s.world.lead.member, run: 'run-1' }, advance: false });
    const looser = await asyncRoster(s.world, s.world.lead, 'project.mode', modeData('military', { mayDecline: true }), { advance: false });
    const pat = await hub.openSession(s.pat, s.world.project);
    assert.equal(reasonOf(await append(s.world, pat, [byMember]), byMember), 'mode-not-allowed');
    // The server stores nothing it refuses, so each of the lead's tries is sent to a server where it is the lead's next entry.
    const lead = await hub.openSession(s.world.lead, s.world.project);
    assert.equal(reasonOf(await append(s.world, lead, [byAgent]), byAgent), 'person-only');
    await withHub({}, async (other) => {
      const t = await enrolled(other, [[POSITIONS_FEATURE]]);
      const alone = await asyncRoster(t.world, t.world.lead, 'project.mode', modeData('military', { mayDecline: true }), { advance: false });
      const answer = await append(t.world, await other.openSession(t.world.lead, t.world.project), [alone]);
      assert.equal(reasonOf(answer, alone), 'settings-looser-than-mode');
    });
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, byMember), 'mode-not-allowed');
    assert.equal(refusedIn(fold, byAgent), 'person-only');
    assert.equal(refusedIn(fold, looser), 'settings-looser-than-mode');
    assert.equal(projectModeAt(fold, headOf(fold)), 'corporate');
  }));

test('verified-clearance@1: projectRequiresCredentials turns true at the lead\'s requirement on the server and on a member\'s replica', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub, [[POSITIONS_FEATURE]]);
    assert.equal(projectRequiresCredentials((await hub.cache.get(s.world.project)).state), false);
    const requires = await asyncRoster(s.world, s.world.lead, 'roster.require', { features: [VERIFIED_CLEARANCE_FEATURE] });
    const lead = await hub.openSession(s.world.lead, s.world.project);
    assert.deepEqual((await append(s.world, lead, [requires])).accepted, [requires.hash]);
    assert.equal(projectRequiresCredentials((await hub.cache.get(s.world.project)).state), true);
    assert.equal(projectRequiresCredentials(foldOf(s.world, s.pat, pulled(hub, s.world))), true);
  }));

test('a session key writing a 33.1 roster kind is refused person-key-required by the server, while its doc.update in the same batch is taken', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub, [[POSITIONS_FEATURE]]);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const data = sessionCertifyData({ project: s.world.project, member: s.pat.member, device: s.pat.writer, sessionKey: session.publicKey, slot: 7, notAfter: new Date(NOW_MS + 11 * 3_600_000).toISOString() }, (bytes) => session.signer.sign(bytes));
    const certificate = s.world.write(s.pat, { kind: 'session.certify', data, at: new Date(NOW_MS - 1_800_000).toISOString() });
    const pat = await hub.openSession(s.pat, s.world.project);
    assert.deepEqual((await append(s.world, pat, [certificate])).refused, []);
    const connection = await hub.connect();
    const challenge = (await connection.post('/v1/session', { project: s.world.project })).json<{ hub: string; challenge: string }>();
    const answer = buildSessionAnswer(session.signer, { hub: challenge.hub, project: s.world.project, challenge: challenge.challenge, keying: connection.keying(), features: KNOWN_REPLICA_FEATURES, certificateEntry: certificate.entry, now: new Date(hub.now()) });
    const openedBody = (await connection.post('/v1/session', { answer })).json<{ token: string; project: string; expiresAt: string }>();
    const opened: OpenedSession = { connection, token: openedBody.token, project: openedBody.project, expiresAt: openedBody.expiresAt };
    const order = { posting: POSTING, position: POSITION, person: { member: s.pat.member }, evidence: [hashOf('credential/clearance')], kind: 'substantive', start: '2026-11-19T00:00:00.000Z', policy: POLICY, stages: [], status: [{ list: 'urn:example:status:1', hash: hashOf('status/1'), validFrom: '2026-11-18T00:00:00.000Z' }] };
    const tries: Array<[string, Record<string, unknown>]> = [
      ['position.create', createData],
      ['posting.order', order],
      ['posting.report', { posting: POSTING }],
      ['authority.delegate', { grant: 'grt-j1', member: s.pat.member, scope: { section: 'j1' }, kinds: ['substantive'], expiresAt: '2026-12-19T00:00:00.000Z', depth: 0 }],
      ['cell.rekey.staged', { cell: 'c'.repeat(32), epoch: 2, reason: 'scheduled', stage: 'prepared', posting: POSTING, replaces: 1 }],
      ['project.mode', modeData('military')]
    ];
    // Each try takes the session key's first place in the base stream, alone in its append, so no refusal is a gap for the next one.
    for (const [kind, body] of tries) {
      const written = s.world.write(session, { kind, data: { ...body, rosterPrev: s.world.head }, seq: 0, prev: GENESIS_PREV });
      const result = await append(s.world, opened, [written]);
      assert.equal(reasonOf(result, written), 'person-key-required', kind);
      assert.deepEqual(result.accepted, [], kind);
    }
    const typed = s.world.write(session, { kind: 'doc.update', stream: s.cell, data: { product: 'intel-estimate', update: Buffer.from('Fictional watch log').toString('base64url') } });
    assert.deepEqual((await append(s.world, opened, [typed])).accepted, [typed.hash], 'the same session key types');
  }));
