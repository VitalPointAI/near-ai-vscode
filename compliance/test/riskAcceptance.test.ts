// Tracer (44-04 Task 1, D-20, ACCR-08): a risk acceptance signed in the extension's signed-payload format by a key in the signer list travels through
// verification to "Risk accepted until {date}" on a Not met row and a gap in state risk-accepted, and stops counting once it expires.
// Keys are derived at run time from fixed text with node:crypto; no key material is written to the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PAYLOAD_DOMAIN, canonicalize, fingerprintOf } from '../src/signed.ts';
import { MAX_ACCEPTANCE_DAYS, RISK_ACCEPTANCE_PURPOSE, judgeRiskAcceptance, loadRiskAcceptances, loadSigners, type Signer } from '../src/riskAcceptance.ts';
import { gapStates, loadGaps, loadPoam } from '../src/gaps.ts';
import { computeStatus } from '../src/status.ts';
import { validateOurs } from '../src/validate.ts';
import type { StatusInput, VerifiedRiskAcceptance } from '../src/model.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUED = new Date('2026-11-21T12:00:00.000Z');
const EXPIRES = new Date(ISSUED.getTime() + 90 * DAY_MS);

// The PKCS#8 DER prefix of an Ed25519 private key; the 32 seed bytes follow it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface TestKey { readonly privateKey: KeyObject; readonly publicKey: string; readonly fingerprint: string }

function keyFrom(text: string): TestKey {
  const seed = createHash('sha256').update(text).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKey: Buffer.from(raw).toString('base64url'), fingerprint: fingerprintOf(Buffer.from(raw)) };
}

const LISTED = keyFrom('compliance-risk-acceptance-test-listed');
const UNLISTED = keyFrom('compliance-risk-acceptance-test-unlisted');
const SIGNER: Signer = { name: 'Example Person', role: 'Release owner', publicKey: LISTED.publicKey, fingerprint: LISTED.fingerprint };

/** Signs like the extension's signPayload: the domain, a newline, the purpose, a newline, then the canonical JSON of the envelope without sig. */
function signEnvelope(key: TestKey, purpose: string, payload: unknown, signedAt: Date): Record<string, unknown> {
  const unsigned = { v: 1, purpose, signer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, signedAt: signedAt.toISOString(), payload };
  const input = Buffer.concat([Buffer.from(`${PAYLOAD_DOMAIN}\n${purpose}\n`, 'utf8'), Buffer.from(canonicalize(unsigned), 'utf8')]);
  return { ...unsigned, sig: edSign(null, input, key.privateKey).toString('base64url') };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: 'ra-g13-attestation-checks',
    gap: 'G13',
    controls: ['sc-08', 'sr-11'],
    reason: 'The provider verifier is used for full checks until the product checks TCB status itself.',
    namedPerson: { name: 'Example Person', role: 'Release owner' },
    issuedAt: ISSUED.toISOString(),
    expiresAt: EXPIRES.toISOString(),
    ...overrides
  };
}

const goodEnvelope = (): Record<string, unknown> => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload(), ISSUED);
const NOW = new Date(ISSUED.getTime() + DAY_MS);

function writeAttestations(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'compliance-attestations-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), `${JSON.stringify(content, null, 2)}\n`);
  return dir;
}

function failingSc08Row(acceptance?: VerifiedRiskAcceptance): StatusInput {
  const rule = { id: 'extension.sc-08.tls', component: 'extension', control: 'sc-08', statement: 'sc-08_smt', kind: 'test' as const, test: { file: 'src/test/x.test.ts', path: [], name: 'x' } };
  return {
    control: 'sc-08', component: 'extension', level: 'protected-b', responsibility: 'product',
    statements: [{ id: 'sc-08_smt', description: 'Synthetic statement.' }],
    rulesByStatement: { 'sc-08_smt': [rule] },
    results: { [rule.id]: { rule: rule.id, passed: false, reason: 'test-failed', collectedAt: NOW.toISOString(), commit: 'c'.repeat(40), window: 'head' } },
    head: 'c'.repeat(40),
    now: NOW,
    ...(acceptance ? { riskAcceptance: acceptance } : {})
  };
}

test('a listed signer accepting G13 for 90 days verifies; sc-08 stays not met with reason risk-accepted; G13 is risk-accepted until that date', () => {
  const dir = writeAttestations({ 'signers.json': { signers: [SIGNER] }, 'ra-g13.json': goodEnvelope() });
  const { verified, refused } = loadRiskAcceptances(dir, NOW);
  assert.deepEqual(refused, []);
  assert.equal(verified.length, 1);
  const [acceptance] = verified;
  assert.equal(acceptance.gap, 'G13');
  assert.equal(acceptance.expiresAt, EXPIRES.toISOString());
  assert.deepEqual(acceptance.namedPerson, { name: 'Example Person', role: 'Release owner' });

  const outcome = computeStatus(failingSc08Row(acceptance));
  assert.deepEqual(outcome, { state: 'not-met', reason: 'risk-accepted', detail: { date: EXPIRES.toISOString() } });
  assert.notEqual(outcome.state, 'met');

  const gaps = loadGaps(path.join(PACKAGE_ROOT, 'gaps.json'));
  const poam = loadPoam(path.join(PACKAGE_ROOT, 'poam'));
  const rows = [{ level: 'protected-b', control: 'sc-08', state: outcome.state }, { level: 'protected-b', control: 'sr-11', state: 'not-met' as const }];
  const g13 = gapStates({ gaps, poam, rows, acceptances: verified, now: NOW }).find((gap) => gap.id === 'G13');
  assert.equal(g13?.state, 'risk-accepted');
  assert.equal(g13?.acceptedUntil, EXPIRES.toISOString());
});

test('the same acceptance judged one day after it expires is refused as expired, and G13 is planned again', () => {
  const later = new Date(EXPIRES.getTime() + DAY_MS);
  const dir = writeAttestations({ 'signers.json': { signers: [SIGNER] }, 'ra-g13.json': goodEnvelope() });
  const { verified, refused } = loadRiskAcceptances(dir, later);
  assert.deepEqual(verified, []);
  assert.deepEqual(refused.map((item) => [item.file, item.reason]), [['ra-g13.json', 'expired']]);
  const gaps = loadGaps(path.join(PACKAGE_ROOT, 'gaps.json'));
  const poam = loadPoam(path.join(PACKAGE_ROOT, 'poam'));
  const g13 = gapStates({ gaps, poam, rows: [{ level: 'protected-b', control: 'sc-08', state: 'not-met' }], acceptances: verified, now: later }).find((gap) => gap.id === 'G13');
  assert.equal(g13?.state, 'planned');
  assert.equal(g13?.acceptedUntil, undefined);
});

test('an acceptance passed straight to computeStatus or gapStates after its expiry changes nothing', () => {
  const later = new Date(EXPIRES.getTime() + DAY_MS);
  const judged = judgeRiskAcceptance(goodEnvelope(), [SIGNER], NOW);
  assert.ok(judged.ok);
  const row = { ...failingSc08Row(judged.acceptance), now: later };
  assert.deepEqual(computeStatus(row), { state: 'not-met', reason: 'test-failed' });
  const gaps = loadGaps(path.join(PACKAGE_ROOT, 'gaps.json'));
  const poam = loadPoam(path.join(PACKAGE_ROOT, 'poam'));
  assert.equal(gapStates({ gaps, poam, rows: [], acceptances: [judged.acceptance], now: later }).find((gap) => gap.id === 'G13')?.state, 'planned');
});

test('an acceptance never raises a met row, and applies only to its own controls and levels', () => {
  const judged = judgeRiskAcceptance(signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ levels: ['protected-a'] }), ISSUED), [SIGNER], NOW);
  assert.ok(judged.ok);
  assert.deepEqual(computeStatus(failingSc08Row(judged.acceptance)), { state: 'not-met', reason: 'test-failed' }, 'another level');
  const other = judgeRiskAcceptance(signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ controls: ['sr-11'] }), ISSUED), [SIGNER], NOW);
  assert.ok(other.ok);
  assert.deepEqual(computeStatus(failingSc08Row(other.acceptance)), { state: 'not-met', reason: 'test-failed' }, 'another control');
});

const refusalCases: readonly [string, () => unknown, string, Date?][] = [
  ['a signer not in the list', () => signEnvelope(UNLISTED, RISK_ACCEPTANCE_PURPOSE, payload(), ISSUED), 'unknown-key'],
  ['an edited payload', () => { const envelope = goodEnvelope(); return { ...envelope, payload: { ...(envelope.payload as object), reason: 'Edited after signing.' } }; }, 'bad-signature'],
  ['a named person who is not the signer', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ namedPerson: { name: 'Someone Else', role: 'Release owner' } }), ISSUED), 'named-person-mismatch'],
  ['a role that is not the signer entry', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ namedPerson: { name: 'Example Person', role: 'Owner' } }), ISSUED), 'named-person-mismatch'],
  [`${MAX_ACCEPTANCE_DAYS + 1} days`, () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ expiresAt: new Date(ISSUED.getTime() + (MAX_ACCEPTANCE_DAYS + 1) * DAY_MS).toISOString() }), ISSUED), 'too-long'],
  ['an expiry before the issue time', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ expiresAt: new Date(ISSUED.getTime() - DAY_MS).toISOString() }), ISSUED), 'expires-before-issued'],
  ['a signing time in the future beyond the clock skew', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload(), ISSUED), 'signed-in-future', new Date(ISSUED.getTime() - 10 * 60 * 1000)],
  ['an issue time that is not the signing time', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ issuedAt: new Date(ISSUED.getTime() - DAY_MS).toISOString() }), ISSUED), 'issued-at-mismatch'],
  ['another purpose', () => signEnvelope(LISTED, 'policy-authorization', payload(), ISSUED), 'wrong-purpose'],
  ['an unknown key in the payload', () => signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ note: 'extra' }), ISSUED), 'invalid-payload'],
  ['an unknown key in the envelope', () => ({ ...goodEnvelope(), extra: true }), 'malformed'],
  ['a fingerprint that does not match the key', () => { const envelope = goodEnvelope(); return { ...envelope, signer: { fingerprint: UNLISTED.fingerprint, publicKey: LISTED.publicKey } }; }, 'key-mismatch']
];

for (const [name, make, reason, at] of refusalCases) {
  test(`refused: ${name} (${reason})`, () => {
    const judged = judgeRiskAcceptance(make(), [SIGNER], at ?? NOW);
    assert.equal(judged.ok, false);
    if (!judged.ok) {
      assert.equal(judged.reason, reason);
      assert.ok(judged.message.length > 0 && !judged.message.includes('—'), 'a plain message without an em-dash');
    }
  });
}

test('the loader lists every refusal by file and skips the signer list; a broken file is refused, not thrown', () => {
  const dir = writeAttestations({
    'signers.json': { signers: [SIGNER] },
    'a-good.json': goodEnvelope(),
    'b-unlisted.json': signEnvelope(UNLISTED, RISK_ACCEPTANCE_PURPOSE, payload({ id: 'ra-other' }), ISSUED),
    'c-duplicate.json': goodEnvelope()
  });
  writeFileSync(path.join(dir, 'd-broken.json'), '{not json');
  const { verified, refused } = loadRiskAcceptances(dir, NOW);
  assert.deepEqual(verified.map((item) => item.id), ['ra-g13-attestation-checks']);
  assert.deepEqual(refused.map((item) => [item.file, item.reason]), [['b-unlisted.json', 'unknown-key'], ['c-duplicate.json', 'duplicate-id'], ['d-broken.json', 'unreadable']]);
});

test('a signer list whose fingerprint does not match its key, or that names a key twice, is an error', () => {
  const badFingerprint = writeAttestations({ 'signers.json': { signers: [{ ...SIGNER, fingerprint: UNLISTED.fingerprint }] } });
  assert.throws(() => loadSigners(path.join(badFingerprint, 'signers.json')), /fingerprint/);
  const twice = writeAttestations({ 'signers.json': { signers: [SIGNER, { ...SIGNER, name: 'Other Name' }] } });
  assert.throws(() => loadSigners(path.join(twice, 'signers.json')), /twice/);
  const unknownField = writeAttestations({ 'signers.json': { signers: [{ ...SIGNER, extra: 1 }] } });
  assert.throws(() => loadSigners(path.join(unknownField, 'signers.json')), /signers/);
});

test('the shipped signer list is empty and validates, so nothing is accepted until the owner names a signer', () => {
  const file = path.join(PACKAGE_ROOT, 'attestations', 'signers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc, { signers: [] });
  assert.deepEqual(validateOurs(doc, 'signers'), { ok: true, errors: [] });
  assert.deepEqual(loadSigners(file), []);
  const { verified, refused } = loadRiskAcceptances(path.join(PACKAGE_ROOT, 'attestations'), NOW);
  assert.deepEqual(verified, []);
  assert.deepEqual(refused, []);
});

test('the risk acceptance schema accepts a signed acceptance and refuses one without a named person', () => {
  assert.deepEqual(validateOurs(goodEnvelope(), 'risk-acceptance'), { ok: true, errors: [] });
  const threeDigitGap = signEnvelope(LISTED, RISK_ACCEPTANCE_PURPOSE, payload({ gap: 'G100' }), ISSUED);
  assert.deepEqual(validateOurs(threeDigitGap, 'risk-acceptance'), { ok: true, errors: [] });
  const { namedPerson: _drop, ...withoutPerson } = payload();
  assert.equal(validateOurs({ ...goodEnvelope(), payload: withoutPerson }, 'risk-acceptance').ok, false);
});
