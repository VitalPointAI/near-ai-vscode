// Phase 33 plan 23 (D-60, D-61, D-62; T-33-N7, T-33-N9, T-33-N10). A hosted session makes its own short-lived Ed25519 key in memory, and the
// person's long-term key in your organization's OpenBao Transit (KeyService.sign, 46-07, against the fake OpenBao) certifies it with a
// session.certify entry that the engine's own fold places, so the engine counts the session key's writes as the person's. With a stale sign-in
// nothing is certified and the refusal says what to do. stop() drops the session key and every secret held with it. The person signer's
// refusals are values. Nothing in the output holds a key, a signature or a token. Fictional exercise data only.
import assert from 'node:assert/strict';
import { KeyObject, createPublicKey, verify as edVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { KEY_SERVICE_TEXT } from '../../extension/src/common/key-service.ts';
import type { SessionIdentityStatus } from '../../extension/src/common/session-identity.ts';
import { readHostingConfig, type HostedConfig } from '../../extension/src/node/hosting-config.ts';
import { createKeyService, type KeySessionSource } from '../../extension/src/node/key-service.ts';
import { createOpenBaoClient } from '../../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../../extension/src/node/session-identity.ts';
import { PERSON_SIGNER_TEXT, personSigner } from '../../extension/src/node/staff/person-signer.ts';
import { SESSION_KEY_TEXT, SESSION_NOT_AFTER_MS, startSessionKeys, type CertifyTarget } from '../../extension/src/node/staff/session-keys.ts';
import { loadStaffEngine, type StaffEngine } from '../../extension/src/node/staff/staff-engine.ts';
import type * as StaffEntry from '../../tools/staff-engine-entry.ts';
import { GENESIS_PREV, buildEntryAsync } from '../../../src/domain/replica/entry.ts';
import { joinSecretHash, newJoinSecret } from '../../../src/domain/replica/invite.ts';
import { rosterView } from '../../../src/domain/replica/roster.ts';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_AT, createRosterWorld, type RosterDevice, type RosterWorld } from '../../../src/test/helpers/replicaRosterWorld.ts';
import { captureOutput, startFakeOpenBao, type FakeCall, type FakeOpenBao } from '../helpers/fake-openbao.ts';

// The workbench lint checks that the bundle's entry gives every name the backend's StaffEngine interface types.
type EntryMatches = typeof StaffEntry extends StaffEngine ? true : never;
const entryMatches: EntryMatches = true;

const workbenchRoot = fileURLToPath(new URL('../../..', import.meta.url));
const engine = loadStaffEngine<typeof StaffEntry>(workbenchRoot);

const ENTITY = '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const SESSION_TOKEN = 's.ORDINARYSESSIONTOKEN0123456789ab';
const STEPUP_TOKEN = 's.STEPUPTOKEN0123456789abcdefghij';
const FORWARDED = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJrYy1wYXQifQ.forwarded-signature';
const ACR = 'urn:sterling:acr:phishing-resistant';
const PAT = 'mbr-pat';
// ROSTER_AT, so a 12-hour notAfter sits inside the fold's own lifetime check of the entry's signed time.
const NOW = Date.parse(ROSTER_AT);
const output = captureOutput();
const fakes: FakeOpenBao[] = [];
const secretsSeen: string[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  const text = output.text();
  for (const value of [SESSION_TOKEN, STEPUP_TOKEN, FORWARDED, ENTITY, ...secretsSeen]) assert.ok(!text.includes(value), 'no key, signature, token or entity id reached the output');
});

interface Shared { world: RosterWorld; pat: RosterDevice; head: string }

// The lead admits Pat with Pat's person key (the Transit key) as Pat's device at slot 2: the hosted person joined as a device of the member (D-48).
function shared(): Shared {
  const world = createRosterWorld();
  const pat = world.device('PAT-PERSON-KEY', PAT);
  const { entry: genesis } = world.genesis();
  const invite = world.rosterEntry(world.lead, 'member.invite', {
    invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, genesis.hash);
  const admit = world.rosterEntry(world.lead, 'member.admit', {
    member: PAT, invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: pat.descriptor(2), agentSeats: []
  }, invite.hash);
  return { world, pat, head: admit.hash };
}

// The project as session-keys.ts sees it: appendOwn signs with the signer it is given and adds the entry to the world, like ReplicaProject.appendOwn.
function target(s: Shared): CertifyTarget & { appended: number } {
  const result = {
    projectId: s.world.project,
    appended: 0,
    async appendOwn(kind: string, data: unknown, options: { signer: Parameters<typeof buildEntryAsync>[0]['signer'] }) {
      const built = await buildEntryAsync({
        signer: options.signer, key: s.world.epochKeyOf(s.world.project, 1), stream: s.world.project, seq: 0, prev: GENESIS_PREV, epoch: 1,
        body: { deps: [], roster: s.head, lamport: 1, at: ROSTER_AT, actor: { kind: 'person' }, kind, data }
      });
      if ('refused' in built) return { refused: 'signer-refused', message: built.refused };
      s.world.entries.push(built.entry);
      result.appended += 1;
      return { ok: true as const, hash: built.hash, built };
    }
  };
  return result;
}

interface Hosted {
  fake: FakeOpenBao;
  session: { current: ActiveSession | undefined };
  identity: KeySessionSource;
  keyService: ReturnType<typeof createKeyService>;
}

// The real KeyService over the fake OpenBao, whose Transit key person-<entity> is Pat's person key.
async function hosted(person: RosterDevice, overrides: Partial<ActiveSession> = {}, local = false): Promise<Hosted> {
  const fake = await startFakeOpenBao({
    'POST /v1/auth/jwt/login': () => ({ json: { auth: { client_token: STEPUP_TOKEN, lease_duration: 300 } } }),
    'POST /v1/auth/token/revoke-self': () => ({ status: 204 }),
    [`POST /v1/transit/sign/person-${ENTITY}`]: (call: FakeCall) => {
      const input = Buffer.from((call.body as { input: string }).input, 'base64');
      const signature = Buffer.from(person.signer.sign(input), 'base64url').toString('base64');
      secretsSeen.push(signature);
      return { json: { data: { signature: `vault:v1:${signature}`, key_version: 1 } } };
    },
  });
  fakes.push(fake);
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: fake.url, THEIACLOUD_SESSION_USER: 'pat@example.test', STERLING_STEPUP_ACR: ACR }) as HostedConfig;
  const session = {
    current: {
      token: SESSION_TOKEN, entityId: ENTITY, forwardedToken: FORWARDED, acr: ACR, authTime: NOW / 1000 - 10,
      client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), config, ...overrides,
    } as ActiveSession | undefined,
  };
  const identity: KeySessionSource = {
    session: () => session.current,
    status: (): SessionIdentityStatus => (local ? { mode: 'local' } : { mode: 'hosted', state: session.current ? 'active' : 'stopping' }),
  };
  return { fake, session, identity, keyService: createKeyService(identity, { now: () => NOW }) };
}

const clock = { now: () => NOW };

function started(h: Hosted, person: RosterDevice) {
  const result = startSessionKeys(h.keyService, h.identity, clock, { personPublicKey: person.publicKey, engine });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.value;
}

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

test('tracer: a fresh sign-in certifies a new session key through KeyService, and the engine counts the session key as Pat at slot 2', async () => {
  assert.equal(entryMatches, true);
  const s = shared();
  const h = await hosted(s.pat);
  const keys = started(h, s.pat);
  const project = target(s);

  const certified = await keys.certificate(project, { member: PAT, slot: 2 });
  assert.equal(certified.kind, 'ok', JSON.stringify(certified));
  if (certified.kind !== 'ok') return;
  assert.equal(certified.value.notAfter, new Date(NOW + SESSION_NOT_AFTER_MS).toISOString());
  assert.equal(project.appended, 1);
  // Signed by the person key through the step-up role, with that short-lived token revoked: no other prompt right after sign-in.
  assert.deepEqual(h.fake.calls.map((call) => `${call.method} ${call.path}`), ['POST /v1/auth/jwt/login', `POST /v1/transit/sign/person-${ENTITY}`, 'POST /v1/auth/token/revoke-self']);

  const sessionWriter = engine.writerIdOf(keys.sessionSigner.publicKey);
  const state = s.world.foldRoster();
  assert.deepEqual(state.refused, []);
  assert.equal(state.sessions.get(sessionWriter)?.hash, certified.value.hash);
  assert.equal(state.positions.includes(certified.value.hash), false, 'the certificate takes no roster position');
  assert.deepEqual(engine.certifiedWriter(rosterView(state), sessionWriter, s.head), { member: PAT, device: s.pat.writer, slot: 2 });
});

test('the session key is the engine\'s signer shape, lasts 12 hours, and its private key is reachable only through sign', async () => {
  assert.equal(SESSION_NOT_AFTER_MS, engine.SESSION_DEFAULT_LIFETIME_MS);
  const s = shared();
  const keys = started(await hosted(s.pat), s.pat);
  const { sessionSigner } = keys;
  assert.equal(sessionSigner.publicKey.length, 43);
  assert.match(sessionSigner.fingerprint, /^dev-[0-9a-f]{32}$/);
  assert.equal(keys.notAfter, new Date(NOW + 12 * 60 * 60 * 1000).toISOString());
  const message = Buffer.from('an ordinary edit');
  const signature = sessionSigner.sign(message);
  secretsSeen.push(signature);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(sessionSigner.publicKey, 'base64url')]), format: 'der', type: 'spki' });
  assert.equal(edVerify(null, message, publicKey, Buffer.from(signature, 'base64url')), true);

  // Walk everything the caller can reach: no KeyObject, and no method that exports or returns key material.
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    assert.equal(value instanceof KeyObject, false, 'no KeyObject is reachable');
    for (const key of Reflect.ownKeys(value)) walk((value as Record<PropertyKey, unknown>)[key]);
  };
  walk(keys);
  assert.deepEqual(Object.keys(sessionSigner).sort(), ['fingerprint', 'publicKey', 'sign']);
  assert.deepEqual(Object.keys(keys).sort(), ['certificate', 'hold', 'notAfter', 'personSigner', 'sessionSigner', 'stop']);
});

test('a stale sign-in certifies nothing: the refusal asks for the passkey or security key, and OpenBao is not called', async () => {
  const s = shared();
  const h = await hosted(s.pat, { authTime: NOW / 1000 - 3600 });
  const keys = started(h, s.pat);
  const project = target(s);
  assert.deepEqual(await keys.certificate(project, { member: PAT, slot: 2 }), {
    kind: 'refused', reason: SESSION_KEY_TEXT.stepUp, fix: KEY_SERVICE_TEXT.confirm,
  });
  assert.equal(SESSION_KEY_TEXT.stepUp, 'Confirm with your passkey or security key to work on shared projects.');
  assert.equal(project.appended, 0, 'no certificate');
  assert.equal(h.fake.calls.length, 0);
  assert.equal(s.world.foldRoster().sessions.size, 0);
});

test('no session keys in local mode or before the sign-in is active, and none for a person key that is not one', async () => {
  const s = shared();
  const local = await hosted(s.pat, {}, true);
  assert.deepEqual(startSessionKeys(local.keyService, local.identity, clock, { personPublicKey: s.pat.publicKey, engine }), { kind: 'refused', reason: KEY_SERVICE_TEXT.local });
  const waiting = await hosted(s.pat);
  waiting.session.current = undefined;
  assert.deepEqual(startSessionKeys(waiting.keyService, waiting.identity, clock, { personPublicKey: s.pat.publicKey, engine }), { kind: 'refused', reason: KEY_SERVICE_TEXT.notReady });
  const active = await hosted(s.pat);
  assert.deepEqual(startSessionKeys(active.keyService, active.identity, clock, { personPublicKey: 'not-a-key', engine }), { kind: 'refused', reason: SESSION_KEY_TEXT.noPersonKey });
});

// ---- Task 3: the session lifecycle and the person signer's refusals ------------------------------------------------------------------------------

test('at stopping, stop() drops the session key and every secret held with it; a later sign or certificate signs nothing', async () => {
  const s = shared();
  const h = await hosted(s.pat);
  const keys = started(h, s.pat);
  let dropped = 0;
  keys.hold({ drop: () => { dropped += 1; } });
  // The identity reaches stopping (46-02), and the backend stops the session's keys.
  h.session.current = undefined;
  assert.deepEqual(h.identity.status(), { mode: 'hosted', state: 'stopping' });
  keys.stop();
  assert.equal(dropped, 1);
  assert.throws(() => keys.sessionSigner.sign(Buffer.from('typing after the end')), { message: SESSION_KEY_TEXT.ended });
  const project = target(s);
  assert.deepEqual(await keys.certificate(project, { member: PAT, slot: 2 }), { kind: 'refused', reason: SESSION_KEY_TEXT.ended });
  assert.equal(project.appended, 0);
  keys.stop();
  assert.equal(dropped, 1, 'stop is idempotent');
  // A secret held after stop is dropped at once.
  keys.hold({ drop: () => { dropped += 1; } });
  assert.equal(dropped, 2);
});

test('the person signer: a stale step-up is a refusal value with the fix, a fresh one a signature that verifies against the Transit key', async () => {
  const s = shared();
  const stale = await hosted(s.pat, { acr: 'urn:sterling:acr:password' });
  const message = Buffer.from('version.decide: a decision of the lead');
  assert.deepEqual(await personSigner(stale.keyService, s.pat.publicKey).sign(message), { refused: KEY_SERVICE_TEXT.stepUpNeeded, fix: 'Confirm with your passkey or security key' });
  assert.equal(stale.fake.calls.length, 0);

  const fresh = await hosted(s.pat);
  const signer = personSigner(fresh.keyService, s.pat.publicKey);
  assert.equal(signer.fingerprint, s.pat.signer.fingerprint, 'the engine\'s fingerprint of the person key');
  const signature = await signer.sign(message);
  assert.equal(typeof signature, 'string');
  const transitKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.pat.publicKey, 'base64url')]), format: 'der', type: 'spki' });
  assert.equal(edVerify(null, message, transitKey, Buffer.from(signature as string, 'base64url')), true);
});

test('the person signer never throws: another key\'s signature, a key store that does not answer and a throwing KeyService are refusals', async () => {
  const s = shared();
  const other = s.world.device('SOMEONE-ELSE', 'mbr-other');
  const h = await hosted(other);
  assert.deepEqual(await personSigner(h.keyService, s.pat.publicKey).sign(Buffer.from('roster change')), { refused: PERSON_SIGNER_TEXT.mismatch });
  await h.fake.close();
  assert.deepEqual(await personSigner(h.keyService, s.pat.publicKey).sign(Buffer.from('roster change')), { refused: KEY_SERVICE_TEXT.unreachable });
  const throwing = { sign: async () => { throw new Error(`boom ${SESSION_TOKEN}`); } };
  assert.deepEqual(await personSigner(throwing, s.pat.publicKey).sign(Buffer.from('roster change')), { refused: KEY_SERVICE_TEXT.unreachable });
});

test('a refusal other than the step-up passes through to the certificate with its own sentence', async () => {
  const s = shared();
  const h = await hosted(s.pat, {}, false);
  const keys = started(h, s.pat);
  // Signing is not set up on this site (no STERLING_STEPUP_ACR).
  h.session.current = { ...(h.session.current as ActiveSession), config: { ...(h.session.current as ActiveSession).config, stepUpAcr: undefined } };
  assert.deepEqual(await keys.certificate(target(s), { member: PAT, slot: 2 }), { kind: 'refused', reason: KEY_SERVICE_TEXT.notSetUp });
});
