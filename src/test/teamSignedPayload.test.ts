// Signed payload tests (TMR-05, D-08, D-10, D-20, D-21): one signer and verifier for any canonical payload, checked against a key status lookup.
// Keys and canaries are generated at run time; no key material or token literal is written here.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { MAX_DEPTH, canonicalize, fingerprintOf, signingInput, verifyEventSignature } from '../domain/team/canonical';
import { applyEntry, reduce } from '../domain/team/materialize';
import { NO_KNOWN_KEYS, combineKeyStatus, teamKeyStatus } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import {
  MAX_PAYLOAD_BYTES, PAYLOAD_DOMAIN, PAYLOAD_FAILURES, PAYLOAD_PURPOSES, PayloadError, implicitAccountId, payloadSigningInput, signPayload, verifyPayload
} from '../domain/team/signedPayload';
import type { PayloadFailureReason, PayloadPurpose, PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import type { TeamState } from '../domain/team/types';
import { loadOrCreateDeviceIdentity, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { entryOf, makeActor, makeDevice, mulberry32, rotationBody, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { MemorySecrets, testGenesis } from './helpers/teamHarness';

interface TeamWorld { identity: DeviceIdentity; memberId: string; state: TeamState }

// The person's identity is created the way the extension creates it (first need, under the lock), then becomes the owner's device in a team.
async function teamWorld(): Promise<TeamWorld> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-payload-'));
  try {
    const secrets = new MemorySecrets();
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const teamId = newTeamId();
    const memberId = newMemberId();
    const genesis = testGenesis({ teamId, owner: { identity, memberId, secrets }, name: 'Payload test team' });
    const state = reduce(genesis.events.map((event) => entryOf(event)), genesis.anchor);
    return { identity, memberId, state };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// An agent-style signer: a plain Ed25519 key held in a closure, not a DeviceIdentity.
function agentSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

function statusOf(signer: { fingerprint: string; publicKey: string }, state: 'active' | 'rotated' | 'revoked', since?: string): KeyStatusLookup {
  return (key) => (key.fingerprint === signer.fingerprint ? { state, ...(since === undefined ? {} : { since }) } : { state: 'unknown' });
}

const ACTIVE = (signer: PayloadSigner): KeyStatusLookup => statusOf(signer, 'active');
const at = (iso: string) => (): Date => new Date(iso);

// Fixed key-shaped bytes for the Phase 31 samples (fictional; never a real key).
const bytes64url = (length: number, fill: number): string => Buffer.alloc(length, fill).toString('base64url');

const SAMPLES: Record<PayloadPurpose, unknown> = {
  'policy-bundle': { version: 1, expiresAt: '2027-01-01T00:00:00Z', issuer: 'dev-sample', rules: [] },
  grant: { capability: 'read', until: '2026-12-01T00:00:00Z', budgetNanoUsd: 5_000_000_000 },
  'approval-answer': { requestDigest: 'a'.repeat(64), answer: 'allow' },
  'key-record': { seq: 1, prev: '', kind: 'created', at: '2026-01-01T00:00:00.000Z' },
  'label-map': { labelMapVersion: 1, vocabulary: 1, entries: { 'src/': { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] } } },
  'label-declassify': { chatId: 'conv-sample-1', from: [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [], handling: [] }], to: [{ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] }], reason: 'reviewed', at: '2026-11-17T00:00:00.000Z' },
  'staff-ledger': { v: 1, seq: 0, prev: '0'.repeat(64), at: '2026-11-18T00:00:00.000Z', run: 'run-1', product: 'intelligence-estimate', section: 'j2', event: { type: 'propose', hash: 'b'.repeat(64) }, actor: { kind: 'agent', member: 'j2-chief' } },
  'staff-ledger-head': { v: 1, count: 1, head: 'c'.repeat(64) },
  'staff-decision': { v: 1, seq: 0, prev: '0'.repeat(64), at: '2026-11-18T00:00:00.000Z', subject: { kind: 'pir', id: 'PIR-1' }, decision: 'approved', wording: 'd'.repeat(64), reasons: [], person: { kind: 'person', name: 'A. Demo', role: 'Commander', deviceFingerprint: 'f'.repeat(16) } },
  'staff-replica': { v: 2, stream: '1'.repeat(32), writer: 'a'.repeat(64), seq: 0, prev: '0'.repeat(64), epoch: 0, body: { hash: 'b'.repeat(64), size: 128 } },
  // Phase 31 (D-49): the lead's invite file, the joining device's request, a cell grant and the store's high-water mark.
  'staff-invite': { v: 1, genesisHash: 'a'.repeat(64), project: '1'.repeat(32), name: 'Operation Example', lead: { member: 'mbr-lead', writer: 'b'.repeat(64), publicKey: bytes64url(32, 1), x25519: bytes64url(32, 2) }, invite: 'inv-1', secret: bytes64url(32, 3), expiresAt: '2026-11-26T12:00:00.000Z' },
  'staff-join-request': { v: 1, invite: 'inv-1', genesisHash: 'a'.repeat(64), name: 'Bo Chen', publicKey: bytes64url(32, 4), x25519: bytes64url(32, 5), x25519Sig: bytes64url(64, 6), mac: 'c'.repeat(64) },
  'staff-cell-grant': { v: 1, cell: '2'.repeat(32), epoch: 1, labelSealed: bytes64url(48, 8), wraps: [{ writer: 'd'.repeat(64), wrap: bytes64url(92, 7) }, { writer: 'e'.repeat(64), wrap: bytes64url(92, 9) }] },
  'staff-replica-mark': { v: 1, rosterHead: 'f'.repeat(64), heads: [{ stream: '3'.repeat(32), writer: 'a'.repeat(64), seq: 12, hash: 'b'.repeat(64) }] }
};

function failure(verdict: ReturnType<typeof verifyPayload>): PayloadFailureReason | 'ok' {
  return verdict.ok ? 'ok' : verdict.reason;
}

function refused(verdict: ReturnType<typeof verifyPayload>): { reason: PayloadFailureReason; message: string } {
  assert.equal(verdict.ok, false, 'expected a refusal');
  if (verdict.ok) throw new Error('unreachable');
  return { reason: verdict.reason, message: verdict.message };
}

function throwsPlain(action: () => unknown, pattern?: RegExp): PayloadError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PayloadError, `expected a PayloadError, got ${String(error)}`);
    assert.ok(!error.message.includes('\u2014'), 'no em-dash in a message');
    if (pattern !== undefined) assert.match(error.message, pattern);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected signPayload to refuse' });
}

test('tracer: the person\'s identity signs a policy-bundle sample and the verifier checks it against the team roster', async () => {
  const world = await teamWorld();
  const sample = { version: 1, expiresAt: '2027-01-01T00:00:00Z', issuer: world.identity.fingerprint, rules: [] as string[] };
  const envelope = signPayload(world.identity, 'policy-bundle', sample, { memberId: world.memberId });
  assert.equal(envelope.v, 1);
  assert.equal(envelope.purpose, 'policy-bundle');
  assert.equal(envelope.signer.fingerprint, world.identity.fingerprint);
  assert.equal(envelope.signer.publicKey, world.identity.publicKey);
  const verdict = verifyPayload<typeof sample>(envelope, { purpose: 'policy-bundle', status: teamKeyStatus(world.state) });
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.deepEqual(verdict.payload, sample);
  assert.equal(verdict.signer.memberId, world.memberId);
  assert.equal(verdict.keyState, 'active');
  const unknown = verifyPayload(envelope, { purpose: 'policy-bundle', status: NO_KNOWN_KEYS });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown-key');
});

test('every purpose round-trips, signed by the device identity and by a plain agent-style key (D-10, D-20)', async () => {
  const world = await teamWorld();
  const agent = agentSigner();
  for (const purpose of PAYLOAD_PURPOSES) {
    const byDevice = signPayload(world.identity, purpose, SAMPLES[purpose]);
    const deviceVerdict = verifyPayload(byDevice, { purpose, status: teamKeyStatus(world.state) });
    assert.equal(failure(deviceVerdict), 'ok', purpose);
    if (deviceVerdict.ok) assert.deepEqual(deviceVerdict.payload, SAMPLES[purpose]);
    const byAgent = signPayload(agent, purpose, SAMPLES[purpose]);
    const agentVerdict = verifyPayload(byAgent, { purpose, status: ACTIVE(agent) });
    assert.equal(failure(agentVerdict), 'ok', purpose);
    if (agentVerdict.ok) assert.deepEqual(agentVerdict.payload, SAMPLES[purpose]);
  }
  assert.deepEqual([...PAYLOAD_PURPOSES], ['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision', 'staff-replica', 'staff-invite', 'staff-join-request', 'staff-cell-grant', 'staff-replica-mark']);
});

test('D-49: each Phase 31 purpose signs and verifies its own sample, and the same envelope offered for any other purpose is refused wrong-purpose', () => {
  const agent = agentSigner();
  const phase31: PayloadPurpose[] = ['staff-invite', 'staff-join-request', 'staff-cell-grant', 'staff-replica-mark'];
  for (const purpose of phase31) {
    const envelope = signPayload(agent, purpose, SAMPLES[purpose]);
    assert.equal(envelope.purpose, purpose);
    const verdict = verifyPayload(envelope, { purpose, status: ACTIVE(agent) });
    assert.equal(failure(verdict), 'ok', purpose);
    if (verdict.ok) assert.deepEqual(verdict.payload, SAMPLES[purpose]);
    for (const other of PAYLOAD_PURPOSES) {
      if (other === purpose) continue;
      assert.equal(failure(verifyPayload(envelope, { purpose: other, status: ACTIVE(agent) })), 'wrong-purpose', `${purpose} offered as ${other}`);
    }
    // The purpose is inside the signed bytes: an envelope whose purpose field is edited to another Phase 31 purpose no longer verifies.
    const swapped = { ...envelope, purpose: phase31[(phase31.indexOf(purpose) + 1) % phase31.length] };
    assert.equal(failure(verifyPayload(swapped, { purpose: swapped.purpose, status: ACTIVE(agent) })), 'bad-signature', purpose);
  }
  // A signature made for an older purpose is not accepted as one of the new ones.
  const ledgerHead = signPayload(agent, 'staff-ledger-head', SAMPLES['staff-ledger-head']);
  assert.equal(failure(verifyPayload(ledgerHead, { purpose: 'staff-replica-mark', status: ACTIVE(agent) })), 'wrong-purpose');
  const replica = signPayload(agent, 'staff-replica', SAMPLES['staff-replica']);
  assert.equal(failure(verifyPayload(replica, { purpose: 'staff-cell-grant', status: ACTIVE(agent) })), 'wrong-purpose');
});

test('an envelope with a member id and one without both verify, and the one without has no memberId key at all', () => {
  const agent = agentSigner();
  const plain = signPayload(agent, 'grant', SAMPLES.grant);
  assert.equal('memberId' in plain.signer, false);
  assert.deepEqual(Object.keys(plain.signer).sort(), ['fingerprint', 'publicKey']);
  assert.equal(failure(verifyPayload(plain, { purpose: 'grant', status: ACTIVE(agent) })), 'ok');
  const named = signPayload(agent, 'grant', SAMPLES.grant, { memberId: 'mbr-0123456789abcdef' });
  assert.equal(named.signer.memberId, 'mbr-0123456789abcdef');
  const verdict = verifyPayload(named, { purpose: 'grant', status: ACTIVE(agent) });
  assert.equal(failure(verdict), 'ok');
  if (verdict.ok) assert.equal(verdict.signer.memberId, 'mbr-0123456789abcdef');
  // The member id is inside the signed bytes: adding or changing it breaks the signature.
  const swapped = { ...named, signer: { ...named.signer, memberId: 'mbr-ffffffffffffffff' } };
  assert.equal(failure(verifyPayload(swapped, { purpose: 'grant', status: ACTIVE(agent) })), 'bad-signature');
  const added = { ...plain, signer: { ...plain.signer, memberId: 'mbr-ffffffffffffffff' } };
  assert.equal(failure(verifyPayload(added, { purpose: 'grant', status: ACTIVE(agent) })), 'bad-signature');
});

test('the signed time is the injected clock in ISO form and is returned by the verifier', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant, { now: at('2026-05-06T07:08:09.123Z') });
  assert.equal(envelope.signedAt, '2026-05-06T07:08:09.123Z');
  const verdict = verifyPayload(envelope, { purpose: 'grant', status: ACTIVE(agent) });
  assert.equal(verdict.ok && verdict.signedAt, '2026-05-06T07:08:09.123Z');
});

test('a purpose is part of the signature: another expected purpose is refused, and an edited purpose field breaks the signature', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant);
  assert.equal(failure(verifyPayload(envelope, { purpose: 'policy-bundle', status: ACTIVE(agent) })), 'wrong-purpose');
  const edited = { ...envelope, purpose: 'policy-bundle' };
  assert.equal(failure(verifyPayload(edited, { purpose: 'policy-bundle', status: ACTIVE(agent) })), 'bad-signature');
  assert.equal(failure(verifyPayload(edited, { purpose: 'grant', status: ACTIVE(agent) })), 'wrong-purpose');
  const unknown = { ...envelope, purpose: 'something-else' };
  assert.equal(failure(verifyPayload(unknown, { purpose: 'grant', status: ACTIVE(agent) })), 'unknown-purpose');
  // The same payload signed for two purposes gives two different signatures.
  const other = signPayload(agent, 'policy-bundle', SAMPLES.grant, { now: at(envelope.signedAt) });
  assert.notEqual(other.sig, envelope.sig);
});

test('domain separation both ways: a payload signature is not a team event signature, and an event signature is not a payload signature (D-08, T-69-24)', async () => {
  const owner: TestActor = await makeActor(newTeamId());
  const event = signed(owner, { teamId: newTeamId(), type: 'member.availability', body: { availability: 'available' }, lamport: 3, prev: 'evt-x' });
  const envelope = signPayload(owner.identity, 'approval-answer', SAMPLES['approval-answer']);
  const unsigned = { v: envelope.v, purpose: envelope.purpose, signer: envelope.signer, signedAt: envelope.signedAt, payload: envelope.payload };
  assert.equal(payloadSigningInput(unsigned)[0], 'n'.charCodeAt(0));
  assert.equal(signingInput(event)[0], '{'.charCodeAt(0));
  assert.ok(payloadSigningInput(unsigned).toString('utf8').startsWith(`${PAYLOAD_DOMAIN}\napproval-answer\n`));
  // A payload signature placed on an event does not verify, and neither does an event signature placed in a payload envelope.
  assert.equal(verifyEventSignature(event, owner.identity.publicKey), true);
  assert.equal(verifyEventSignature({ ...event, sig: envelope.sig }, owner.identity.publicKey), false);
  const fromEvent: SignedPayload = { ...envelope, sig: event.sig };
  assert.equal(failure(verifyPayload(fromEvent, { purpose: 'approval-answer', status: ACTIVE(owner.identity) })), 'bad-signature');
  // Even for a payload that is shaped like an event, the signing input starts with the domain, never a brace.
  const lookalike = signPayload(owner.identity, 'key-record', event);
  assert.equal(verifyEventSignature(event, owner.identity.publicKey), true);
  assert.equal(failure(verifyPayload({ ...lookalike, purpose: 'grant' }, { purpose: 'grant', status: ACTIVE(owner.identity) })), 'bad-signature');
});

test('any single changed field breaks the envelope: payload, signedAt, fingerprint, public key, signature, member id', () => {
  const agent = agentSigner();
  const other = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant, { memberId: 'mbr-0123456789abcdef' });
  const status = combineKeyStatus(ACTIVE(agent), ACTIVE(other));
  const expectation = { purpose: 'grant' as const, status };
  assert.equal(failure(verifyPayload(envelope, expectation)), 'ok');
  assert.equal(failure(verifyPayload({ ...envelope, payload: { ...(SAMPLES.grant as object), budgetNanoUsd: 5_000_000_001 } }, expectation)), 'bad-signature');
  assert.equal(failure(verifyPayload({ ...envelope, signedAt: '2026-01-02T00:00:00.000Z' }, expectation)), 'bad-signature');
  assert.equal(failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, fingerprint: other.fingerprint } }, expectation)), 'key-mismatch');
  assert.equal(failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, publicKey: other.publicKey } }, expectation)), 'key-mismatch');
  // A consistent substitution of the whole key (fingerprint and public key of another signer) fails on the signature.
  assert.equal(failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, fingerprint: other.fingerprint, publicKey: other.publicKey } }, expectation)), 'bad-signature');
  const flipped = `${envelope.sig.startsWith('A') ? 'B' : 'A'}${envelope.sig.slice(1)}`;
  assert.equal(failure(verifyPayload({ ...envelope, sig: flipped }, expectation)), 'bad-signature');
  assert.equal(failure(verifyPayload({ ...envelope, sig: envelope.sig.slice(1) }, expectation)), 'bad-signature');
  assert.equal(failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, memberId: 'mbr-ffffffffffffffff' } }, expectation)), 'bad-signature');
});

test('a signing time that is not canonical ISO text, or a public key that is not 32 bytes of base64url, is malformed', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant);
  const expectation = { purpose: 'grant' as const, status: ACTIVE(agent) };
  for (const signedAt of ['yesterday', '2026-01-01', '2026-01-01T00:00:00Z', '']) {
    assert.equal(failure(verifyPayload({ ...envelope, signedAt }, expectation)), 'malformed', signedAt);
  }
  for (const publicKey of ['', 'short', `${envelope.signer.publicKey}=`, `${envelope.signer.publicKey}A`]) {
    assert.equal(failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, publicKey } }, expectation)), 'malformed', publicKey);
  }
});

test('another format version is refused with a message that asks to update the extension (T-69-26)', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant);
  for (const v of [2, 0, 99]) {
    const result = refused(verifyPayload({ ...envelope, v }, { purpose: 'grant', status: ACTIVE(agent) }));
    assert.equal(result.reason, 'unsupported-version');
    assert.match(result.message, /update the extension/i);
  }
  assert.equal(failure(verifyPayload({ ...envelope, v: '1' }, { purpose: 'grant', status: ACTIVE(agent) })), 'malformed');
  assert.equal(failure(verifyPayload({ ...envelope, extra: true }, { purpose: 'grant', status: ACTIVE(agent) })), 'malformed');
  const { sig: _sig, ...withoutSig } = envelope;
  assert.equal(failure(verifyPayload(withoutSig, { purpose: 'grant', status: ACTIVE(agent) })), 'malformed');
});

test('signPayload refuses a fraction, an undefined value, deep nesting, a large payload, an unknown purpose and a secret, each in plain words', () => {
  const agent = agentSigner();
  const fraction = throwsPlain(() => signPayload(agent, 'grant', { spend: 0.5 }), /whole numbers/);
  assert.match(fraction.message, /nano-USD or basis points/);
  throwsPlain(() => signPayload(agent, 'grant', { value: undefined }), /undefined/);
  let deep: unknown = 'leaf';
  for (let level = 0; level < MAX_DEPTH + 4; level += 1) deep = { next: deep };
  throwsPlain(() => signPayload(agent, 'grant', deep), /nested deeper than/);
  throwsPlain(() => signPayload(agent, 'grant', { text: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) }), /over the \d+ byte limit/);
  throwsPlain(() => signPayload(agent, 'grant', { text: 'x'.repeat(100) }, { maxBytes: 64 }), /over the 64 byte limit/);
  throwsPlain(() => signPayload(agent, 'not-a-purpose' as PayloadPurpose, {}), /not a known purpose/);
  throwsPlain(() => signPayload(agent, 'grant', { when: new Date() }), /plain objects/);
  // A canary built at run time: the message names where it was found and never repeats it.
  const canary = `sk-${randomBytes(16).toString('hex')}`;
  const leak = throwsPlain(() => signPayload(agent, 'grant', { note: canary }), /secret-like value at \$\.note/);
  assert.equal(leak.message.includes(canary), false);
  // The same payload without the canary signs, so the refusal was about the canary.
  assert.equal(signPayload(agent, 'grant', { note: 'plain text' }).payload.note, 'plain text');
  // A signer whose key does not match its fingerprint is refused before anything is signed.
  throwsPlain(() => signPayload({ ...agent, fingerprint: fingerprintOf(randomBytes(32)) }, 'grant', {}), /does not match its fingerprint/);
  // A signer that returns a signature of another key is refused.
  const liar: PayloadSigner = { ...agent, sign: () => agentSigner().sign(Buffer.from('x')) };
  throwsPlain(() => signPayload(liar, 'grant', {}), /signature does not match/);
});

test('the public key and signature fields of an envelope are not mistaken for secrets when a signed payload is signed again as a payload', () => {
  const agent = agentSigner();
  const inner = signPayload(agent, 'key-record', SAMPLES['key-record']);
  const outer = signPayload(agent, 'grant', { record: inner });
  assert.equal(failure(verifyPayload(outer, { purpose: 'grant', status: ACTIVE(agent) })), 'ok');
});

test('verifyPayload refuses an oversized envelope with too-large, using the default or the caller\'s limit', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', { text: 'x'.repeat(2000) });
  assert.equal(failure(verifyPayload(envelope, { purpose: 'grant', status: ACTIVE(agent), maxBytes: 1000 })), 'too-large');
  assert.equal(failure(verifyPayload(envelope, { purpose: 'grant', status: ACTIVE(agent), maxBytes: 100_000 })), 'ok');
  const big = { ...envelope, payload: { text: 'x'.repeat(MAX_PAYLOAD_BYTES + 10) } };
  assert.equal(failure(verifyPayload(big, { purpose: 'grant', status: ACTIVE(agent) })), 'too-large');
});

test('verifyPayload reads the input once, so the payload it returns is the payload that was signed', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', { amount: 1 });
  let reads = 0;
  const trick = { ...envelope } as Record<string, unknown>;
  Object.defineProperty(trick, 'payload', { enumerable: true, get: () => { reads += 1; return reads === 1 ? { amount: 1 } : { amount: 1_000_000 }; } });
  const verdict = verifyPayload<{ amount: number }>(trick, { purpose: 'grant', status: ACTIVE(agent) });
  assert.equal(verdict.ok && verdict.payload.amount, 1);
});

test('verifyPayload never throws on 2000 seeded random inputs and always answers with a closed reason', () => {
  const agent = agentSigner();
  const valid = signPayload(agent, 'grant', SAMPLES.grant, { memberId: 'mbr-0123456789abcdef' });
  const random = mulberry32(69_10);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const hostile = (): unknown => new Proxy({}, {
    get: () => { throw new Error('getter'); }, ownKeys: () => { throw new Error('keys'); }, getPrototypeOf: () => { throw new Error('proto'); },
    has: () => { throw new Error('has'); }, getOwnPropertyDescriptor: () => { throw new Error('descriptor'); }
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const atoms: Array<() => unknown> = [
    () => null, () => undefined, () => true, () => 0, () => -0, () => 1.5, () => Number.NaN, () => Number.POSITIVE_INFINITY, () => 2 ** 60,
    () => 10n, () => Symbol('s'), () => (): void => undefined, () => '', () => 'x'.repeat(1 + Math.floor(random() * 200_000)), () => '\uD800',
    () => [], () => [1, [2, [3]]], () => ({}), () => new Date(), () => Buffer.from('abc'), () => new Map(), () => circular, hostile,
    () => ({ v: 1 }), () => ({ v: 1, purpose: 'grant', signer: null, signedAt: 1, payload: 1, sig: 1 }), () => Object.create(null) as unknown
  ];
  const mutate = (): unknown => {
    const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    const signer = copy.signer as Record<string, unknown>;
    const field = pick(['v', 'purpose', 'signedAt', 'payload', 'sig', 'signer', 'fingerprint', 'publicKey', 'memberId', 'extra']);
    const value = pick(atoms)();
    if (field === 'fingerprint' || field === 'publicKey' || field === 'memberId') signer[field] = value;
    else if (field === 'extra') copy.extra = value;
    else copy[field] = value;
    return copy;
  };
  let accepted = 0;
  for (let index = 0; index < 2000; index += 1) {
    const input = index % 2 === 0 ? pick(atoms)() : mutate();
    const verdict = verifyPayload(input, { purpose: 'grant', status: ACTIVE(agent) });
    if (verdict.ok) { accepted += 1; continue; }
    assert.ok(Object.prototype.hasOwnProperty.call(PAYLOAD_FAILURES, verdict.reason), verdict.reason);
    assert.equal(verdict.message, PAYLOAD_FAILURES[verdict.reason]);
  }
  // A mutation that replaces a field with the same value it had still verifies, but random garbage must almost never.
  assert.ok(accepted < 20, `${accepted} garbage inputs were accepted`);
  assert.equal(failure(verifyPayload(hostile(), { purpose: 'grant', status: ACTIVE(agent) })), 'malformed');
  // A status source that throws, a missing status source and a missing expectation are refused, not thrown.
  const throwing: KeyStatusLookup = () => { throw new Error('source down'); };
  assert.equal(failure(verifyPayload(valid, { purpose: 'grant', status: throwing })), 'unknown-key');
  assert.equal(failure(verifyPayload(valid, { purpose: 'grant' } as never)), 'unknown-key');
  assert.equal(failure(verifyPayload(valid, undefined as never)), 'malformed');
});

test('every reason in the closed list is produced by some input, and the list has exactly those reasons (a new reason needs a message and a test)', () => {
  const agent = agentSigner();
  const other = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant, { now: at('2026-04-01T00:00:00.000Z') });
  const ok = { purpose: 'grant' as const, status: ACTIVE(agent) };
  const produced = new Set<string>([
    failure(verifyPayload(null, ok)),
    failure(verifyPayload({ ...envelope, v: 2 }, ok)),
    failure(verifyPayload({ ...envelope, purpose: 'nope' }, ok)),
    failure(verifyPayload(envelope, { ...ok, purpose: 'policy-bundle' })),
    failure(verifyPayload(envelope, { ...ok, maxBytes: 10 })),
    failure(verifyPayload({ ...envelope, signer: { ...envelope.signer, fingerprint: other.fingerprint } }, ok)),
    failure(verifyPayload({ ...envelope, signedAt: '2026-04-02T00:00:00.000Z' }, ok)),
    failure(verifyPayload(envelope, { ...ok, status: NO_KNOWN_KEYS })),
    failure(verifyPayload(envelope, { ...ok, status: statusOf(agent, 'revoked') })),
    failure(verifyPayload(envelope, { ...ok, status: statusOf(agent, 'rotated', '2026-03-01T00:00:00.000Z') }))
  ]);
  assert.deepEqual([...produced].sort(), Object.keys(PAYLOAD_FAILURES).sort());
});

interface RotatedWorld { old: TestActor; next: TestActor; state: TeamState; rotatedAt: string }

// The owner rotates to a fresh key at a known time, through the real event (plan 09), then the roster is the status source.
async function rotatedWorld(): Promise<RotatedWorld & { teamId: string }> {
  const teamId = newTeamId();
  const old = await makeActor(teamId);
  const genesis = testGenesis({ teamId, owner: { identity: old.identity, memberId: old.memberId, secrets: old.secrets }, name: 'Rotation test team' });
  const state = reduce(genesis.events.map((event) => entryOf(event)), genesis.anchor);
  const next = await makeDevice(old);
  const rotatedAt = '2026-03-01T00:00:00.000Z';
  const event = signed(old, { teamId, type: 'device.rotated', body: rotationBody(old.memberId, old, next), lamport: state.head.lamport + 1, prev: state.head.eventId, at: rotatedAt });
  assert.equal(applyEntry(state, entryOf(event)).accepted, true);
  return { old, next, state, teamId, rotatedAt };
}

test('rotation at time T: a payload claimed before T verifies, one at exactly T or after is key-rotated, and the new key is active (D-21)', async () => {
  const w = await rotatedWorld();
  const status = teamKeyStatus(w.state);
  const rotatedMillis = Date.parse(w.rotatedAt);
  const sign = (millis: number) => signPayload(w.old.identity, 'grant', SAMPLES.grant, { now: () => new Date(millis) });
  const before = verifyPayload(sign(rotatedMillis - 1), { purpose: 'grant', status });
  assert.equal(before.ok, true);
  if (before.ok) assert.equal(before.keyState, 'rotated');
  const exactly = refused(verifyPayload(sign(rotatedMillis), { purpose: 'grant', status }));
  assert.equal(exactly.reason, 'key-rotated');
  assert.equal(failure(verifyPayload(sign(rotatedMillis + 1), { purpose: 'grant', status })), 'key-rotated');
  assert.match(exactly.message, /revoking/i);
  const fresh = verifyPayload(signPayload(w.next.identity, 'grant', SAMPLES.grant, { now: () => new Date(rotatedMillis + 1) }), { purpose: 'grant', status });
  assert.equal(fresh.ok && fresh.keyState, 'active');
});

test('a rotated key whose rotation time cannot be read is refused, never trusted', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'grant', SAMPLES.grant);
  assert.equal(failure(verifyPayload(envelope, { purpose: 'grant', status: statusOf(agent, 'rotated') })), 'key-rotated');
  assert.equal(failure(verifyPayload(envelope, { purpose: 'grant', status: statusOf(agent, 'rotated', 'not a time') })), 'key-rotated');
});

test('a revoked key is refused for everything whatever signedAt says, and so is every key of a removed member (D-21)', async () => {
  const w = await rotatedWorld();
  const second = await makeDevice(w.old);
  const bind = signed(w.next, { teamId: w.teamId, type: 'device.added', body: { memberId: w.old.memberId, device: { fingerprint: second.identity.fingerprint, publicKey: second.identity.publicKey } }, lamport: w.state.head.lamport + 1, prev: w.state.head.eventId });
  assert.equal(applyEntry(w.state, entryOf(bind)).accepted, true);
  const revoke = signed(w.next, { teamId: w.teamId, type: 'device.revoked', body: { memberId: w.old.memberId, fingerprint: second.identity.fingerprint }, lamport: w.state.head.lamport + 1, prev: w.state.head.eventId });
  assert.equal(applyEntry(w.state, entryOf(revoke)).accepted, true);
  const status = teamKeyStatus(w.state);
  for (const time of ['2000-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
    const envelope = signPayload(second.identity, 'grant', SAMPLES.grant, { now: at(time) });
    const result = refused(verifyPayload(envelope, { purpose: 'grant', status }));
    assert.equal(result.reason, 'key-revoked', time);
    assert.equal(result.message, PAYLOAD_FAILURES['key-revoked']);
  }
  // A removed member's key is revoked in the roster; the same key is active when only the person's own history is consulted.
  const developer = await makeActor(w.teamId);
  w.state.members.set(developer.memberId, {
    id: developer.memberId, name: 'Developer', emailHashes: [], role: 'developer', skills: [], availability: 'available', wipLimit: 1,
    joinedAt: '2026-01-01T00:00:00.000Z', joinedEvent: 'evt-0', removedAt: '2026-02-01T00:00:00.000Z', removedEvent: 'evt-1',
    devices: [{ fingerprint: developer.identity.fingerprint, publicKey: developer.identity.publicKey, addedBy: developer.memberId, addedEvent: 'evt-0' }]
  });
  w.state.deviceIndex.set(developer.identity.fingerprint, developer.memberId);
  const removed = signPayload(developer.identity, 'grant', SAMPLES.grant, { now: at('2026-01-15T00:00:00.000Z') });
  assert.equal(failure(verifyPayload(removed, { purpose: 'grant', status })), 'key-revoked');
  assert.equal(failure(verifyPayload(removed, { purpose: 'grant', status: ACTIVE(developer.identity) })), 'ok');
});

test('the messages are plain: no em-dash, the rotated text points to revoking and never says rotating stops a copied key', () => {
  for (const [reason, message] of Object.entries(PAYLOAD_FAILURES)) {
    assert.ok(!message.includes('\u2014'), reason);
    assert.ok(!message.includes('\u2013'), reason);
    assert.ok(message.length > 20 && message.endsWith('.'), reason);
  }
  const rotated = PAYLOAD_FAILURES['key-rotated'];
  assert.match(rotated, /revoking/i);
  assert.doesNotMatch(rotated, /(rotating|rotation|replacing)[^.]*\bstops?\b/i);
  assert.match(rotated, /Only revoking the old key stops/);
});

function base58Decode(text: string): Buffer {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    assert.ok(digit >= 0, `not a base58 character: ${char}`);
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, 'hex');
}

test('the NEAR implicit account id is the lowercase hex of the raw key, for a generated key and for the documentation vector (A10)', () => {
  const agent = agentSigner();
  const id = implicitAccountId(agent.publicKey);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, Buffer.from(agent.publicKey, 'base64url').toString('hex'));
  const documented = base58Decode('BGCCDDHfysuuVnaNVtEhhqeT4k9Muyem3Kpgq2U1m9HX');
  assert.equal(documented.length, 32);
  assert.equal(implicitAccountId(documented.toString('base64url')), '98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de');
  assert.throws(() => implicitAccountId('short'), PayloadError);
});

test('the envelope the signer returns is canonical JSON safe and its key order does not matter to the verifier', () => {
  const agent = agentSigner();
  const envelope = signPayload(agent, 'policy-bundle', SAMPLES['policy-bundle']);
  assert.equal(canonicalize(envelope).startsWith('{"payload":'), true);
  const reordered = JSON.parse(JSON.stringify({ sig: envelope.sig, payload: envelope.payload, signedAt: envelope.signedAt, signer: envelope.signer, purpose: envelope.purpose, v: 1 })) as unknown;
  assert.equal(failure(verifyPayload(reordered, { purpose: 'policy-bundle', status: ACTIVE(agent) })), 'ok');
  const roundTripped = JSON.parse(JSON.stringify(envelope)) as unknown;
  assert.equal(failure(verifyPayload(roundTripped, { purpose: 'policy-bundle', status: ACTIVE(agent) })), 'ok');
});


test('a key record made of keys and hashes in the shapes the history writes is never refused as secret-like (the write guard exempts public keys by shape)', () => {
  // A fixed seed, so the 3000 shapes are the same on every run and a change to the detector shows up the same way every time.
  const random = mulberry32(69_15);
  const bytes = (length: number): Buffer => Buffer.from(Array.from({ length }, () => Math.floor(random() * 256)));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signer: PayloadSigner = {
    fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (input) => edSign(null, input, privateKey).toString('base64url')
  };
  for (let i = 0; i < 3000; i += 1) {
    const record = {
      seq: i + 1, prev: bytes(32).toString('hex'), kind: 'rotated', at: '2026-03-01T10:00:00.000Z',
      key: { fingerprint: `dev-${bytes(16).toString('hex')}`, publicKey: bytes(32).toString('base64url') },
      next: { fingerprint: `dev-${bytes(16).toString('hex')}`, publicKey: bytes(32).toString('base64url') }
    };
    assert.doesNotThrow(() => signPayload(signer, 'key-record', record, { now: () => new Date('2026-03-01T10:00:00.000Z') }), `record ${i} is signed`);
  }
});

test('generated random fields of the Phase 31 purposes are not mistaken for tokens, and nothing else is let through', () => {
  const agent = agentSigner();
  // Random base64url that happens to contain a token shape: the chance match that made grants, admissions and rekeys fail at random.
  const lookalike = `${randomBytes(9).toString('base64url')}-rt_${randomBytes(12).toString('base64url')}`;
  const pkcs8 = `MC4CAQAwBQYDK2VwBCIEI${randomBytes(24).toString('base64url')}`;
  const cases: Array<[PayloadPurpose, (value: string) => unknown, string]> = [
    ['staff-cell-grant', (value) => ({ cell: 'c', labelSealed: value, wraps: [] }), '$.labelSealed'],
    ['staff-cell-grant', (value) => ({ cell: 'c', labelSealed: '', wraps: [{ writer: 'w', wrap: 'x' }, { writer: 'v', wrap: value }] }), '$.wraps[1].wrap'],
    ['staff-invite', (value) => ({ invite: 'i', secret: value }), '$.secret'],
    ['staff-invite', (value) => ({ invite: 'i', lead: { member: 'm', x25519: value } }), '$.lead.x25519'],
    ['staff-join-request', (value) => ({ invite: 'i', x25519: value }), '$.x25519'],
    ['staff-join-request', (value) => ({ invite: 'i', x25519Sig: value }), '$.x25519Sig'],
    ['staff-join-request', (value) => ({ invite: 'i', mac: value }), '$.mac']
  ];
  for (const [purpose, build, where] of cases) {
    // At its own path the random value signs.
    assert.equal(failure(verifyPayload(signPayload(agent, purpose, build(lookalike)), { purpose, status: ACTIVE(agent) })), 'ok', `${purpose} ${where}`);
    // Private key material at the same path is still refused.
    throwsPlain(() => signPayload(agent, purpose, build(pkcs8)), new RegExp(`secret-like value at ${where.replace(/[$.[\]]/g, '\\$&')}`));
    // Text that is not pure base64url at the same path gets the full check.
    throwsPlain(() => signPayload(agent, purpose, build(`bearer ${lookalike}`)), /secret-like value/);
    // The same random value under another purpose, or in another field of the same purpose, is still refused.
    throwsPlain(() => signPayload(agent, 'grant', build(lookalike)), /secret-like value/);
  }
  throwsPlain(() => signPayload(agent, 'staff-cell-grant', { cell: 'c', labelSealed: '', wraps: [], note: lookalike }), /secret-like value at \$\.note/);
  throwsPlain(() => signPayload(agent, 'staff-invite', { invite: 'i', name: lookalike }), /secret-like value at \$\.name/);
  throwsPlain(() => signPayload(agent, 'staff-join-request', { invite: 'i', wraps: [{ wrap: lookalike }] }), /secret-like value/);
});
