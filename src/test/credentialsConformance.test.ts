// Credentials conformance (Phase 71 research item a, VCRD-02, VCRD-03, D-05): our eddsa-jcs-2022 on node:crypto and the team canonical JSON give the
// W3C example proof byte for byte, refuse every tampered part, refuse numbers the profile cannot sign, and never share a signing input with a signed
// payload or a team event. Test keys are generated at run time, except the W3C example key, which stays in the fixture.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, signingInput } from '../domain/team/canonical';
import { PAYLOAD_DOMAIN, PAYLOAD_PURPOSES, payloadSigningInput } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import type { UnsignedTeamEvent } from '../domain/team/types';
import {
  DATA_INTEGRITY_FAILURES, DATA_INTEGRITY_INPUT_BYTES, DataIntegrityError, createProof, dataIntegritySigningInput, documentHash, proofConfigHash, verifyProof
} from '../domain/credentials/dataIntegrity';
import type { CredentialSigner, DataIntegrityProof } from '../domain/credentials/dataIntegrity';
import {
  MULTIKEY_HEADERS, MultibaseError, base58btcDecode, base58btcEncode, decodePublicKeyMultibase, encodePublicKeyMultibase, multibaseDecode, multibaseEncode
} from '../domain/credentials/multibase';
import { mulberry32 } from './helpers/teamEvents';

const VECTORS_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'credentials', 'w3c-eddsa-jcs-2022');
interface W3cVectors {
  keyPair: { publicKeyMultibase: string; secretKeyMultibase: string };
  unsecuredCredential: Record<string, unknown>;
  canonicalCredential: string;
  credentialHashHex: string;
  proofOptions: Record<string, unknown>;
  canonicalProofOptions: string;
  proofOptionsHashHex: string;
  combinedHashHex: string;
  signatureHex: string;
  proofValue: string;
  signedCredential: Record<string, unknown> & { proof: DataIntegrityProof };
}
const vectors = JSON.parse(readFileSync(path.join(VECTORS_DIR, 'vectors.json'), 'utf8')) as W3cVectors;

// PKCS#8 DER prefix of an Ed25519 private key followed by the 32-byte seed; multicodec ed25519-priv (0x1300) is the varint 0x80 0x26.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PRIV_HEADER = Buffer.from([0x80, 0x26]);

function w3cPrivateKey(): KeyObject {
  const decoded = Buffer.from(multibaseDecode(vectors.keyPair.secretKeyMultibase));
  assert.deepEqual(decoded.subarray(0, 2), ED25519_PRIV_HEADER, 'the W3C secret key is a multicodec ed25519-priv key');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, decoded.subarray(2)]), format: 'der', type: 'pkcs8' });
}

function signerFor(privateKey: KeyObject, verificationMethod: string): CredentialSigner {
  return { verificationMethod, suite: 'eddsa-jcs-2022', sign: async (bytes) => new Uint8Array(edSign(null, bytes, privateKey)) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface TestKey { privateKey: KeyObject; publicKey: Uint8Array; didKey: string; verificationMethod: string }

function newTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const multibase = encodePublicKeyMultibase('Ed25519', raw);
  return { privateKey, publicKey: raw, didKey: `did:key:${multibase}`, verificationMethod: `did:key:${multibase}#${multibase}` };
}

// A fictional clearance credential (Example Organization, D-06 claim shape) as later plans will issue it.
function clearanceCredential(issuer: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/sterling/credentials/v1'],
    type: ['VerifiableCredential', 'ClearanceCredential'],
    issuer,
    validFrom: '2026-11-24T00:00:00Z',
    validUntil: '2027-11-24T00:00:00Z',
    credentialSubject: { id: 'did:webvh:QmExampleScidOnlyForTests:example.org:people:alex', scale: 'ca-gc-classified', atLeast: 'Secret' }
  };
}

test('W3C eddsa-jcs-2022 vectors: the canonical forms and both hashes of Appendix B.3 come out of canonical.ts unchanged', () => {
  assert.equal(canonicalize(vectors.unsecuredCredential), vectors.canonicalCredential);
  assert.equal(canonicalize(vectors.proofOptions), vectors.canonicalProofOptions);
  assert.equal(documentHash(vectors.unsecuredCredential).toString('hex'), vectors.credentialHashHex);
  assert.equal(proofConfigHash(vectors.proofOptions).toString('hex'), vectors.proofOptionsHashHex);
  const input = dataIntegritySigningInput(vectors.unsecuredCredential, vectors.proofOptions);
  assert.equal(input.toString('hex'), vectors.combinedHashHex);
  assert.equal(input.length, DATA_INTEGRITY_INPUT_BYTES);
});

test('W3C eddsa-jcs-2022 vectors: createProof with the example key gives the example signature and proofValue byte for byte', async () => {
  const { proofValue: _value, ...options } = vectors.signedCredential.proof;
  const proof = await createProof(vectors.unsecuredCredential, { proofPurpose: 'assertionMethod', created: options.created }, signerFor(w3cPrivateKey(), options.verificationMethod));
  assert.equal(proof.proofValue, vectors.proofValue);
  assert.equal(Buffer.from(multibaseDecode(proof.proofValue)).toString('hex'), vectors.signatureHex);
  assert.deepEqual({ ...proof }, { ...vectors.signedCredential.proof });
});

test('W3C eddsa-jcs-2022 vectors: verifyProof accepts the signed example with the example public key', () => {
  const decoded = decodePublicKeyMultibase(vectors.keyPair.publicKeyMultibase);
  assert.equal(decoded.type, 'Ed25519');
  const verdict = verifyProof(vectors.signedCredential, decoded.key);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
  if (verdict.ok) assert.deepEqual(verdict.document, vectors.unsecuredCredential);
});

test('verifyProof refuses the W3C example with one changed character in the document, in the proof options or in proofValue', () => {
  const { key } = decodePublicKeyMultibase(vectors.keyPair.publicKeyMultibase);
  const inDocument = clone(vectors.signedCredential);
  (inDocument.credentialSubject as Record<string, string>).alumniOf = 'The School of ExampleS';
  const inOptions = clone(vectors.signedCredential);
  inOptions.proof.created = '2023-02-24T23:36:39Z';
  const inProofValue = clone(vectors.signedCredential);
  const last = inProofValue.proof.proofValue.at(-1) === 'X' ? 'Y' : 'X';
  inProofValue.proof.proofValue = `${inProofValue.proof.proofValue.slice(0, -1)}${last}`;
  const inPurpose = clone(vectors.signedCredential);
  inPurpose.proof.proofPurpose = 'authentication';
  for (const [name, tampered] of [['document', inDocument], ['proof options', inOptions], ['proofValue', inProofValue]] as const) {
    const verdict = verifyProof(tampered, key);
    assert.equal(verdict.ok, false, `a change in the ${name} must be refused`);
    if (!verdict.ok) assert.equal(verdict.reason, 'bad-signature', name);
  }
  const purposeVerdict = verifyProof(inPurpose, key);
  assert.equal(purposeVerdict.ok, false, 'a proof made for another purpose is refused before the signature is checked');
  if (!purposeVerdict.ok) assert.equal(purposeVerdict.reason, 'wrong-purpose');
  const otherKey = newTestKey();
  const wrongKey = verifyProof(vectors.signedCredential, otherKey.publicKey);
  assert.equal(wrongKey.ok, false, 'another key does not verify the example');
});

test('verifyProof refuses a proof whose @context differs from the document, a proof set, another suite and a missing proof, each with a named reason', () => {
  const { key } = decodePublicKeyMultibase(vectors.keyPair.publicKeyMultibase);
  const extraContext = clone(vectors.signedCredential);
  (extraContext['@context'] as string[]).push('https://example.org/unsigned-extra-context');
  const proofSet = clone(vectors.signedCredential) as Record<string, unknown>;
  proofSet.proof = [vectors.signedCredential.proof];
  const otherSuite = clone(vectors.signedCredential);
  (otherSuite.proof as { cryptosuite: string }).cryptosuite = 'eddsa-rdfc-2022';
  const { proof: _proof, ...noProof } = clone(vectors.signedCredential);
  const badCreated = clone(vectors.signedCredential);
  badCreated.proof.created = '24 February 2023';
  const cases: Array<[string, unknown, string]> = [
    ['extra context', extraContext, 'context-mismatch'],
    ['proof set', proofSet, 'bad-proof'],
    ['other suite', otherSuite, 'unsupported-suite'],
    ['no proof', noProof, 'bad-proof'],
    ['created not a date-time', badCreated, 'bad-created'],
    ['not an object', [vectors.signedCredential], 'bad-proof']
  ];
  for (const [name, document, reason] of cases) {
    const verdict = verifyProof(document, key);
    assert.equal(verdict.ok, false, name);
    if (!verdict.ok) {
      assert.equal(verdict.reason, reason, name);
      assert.equal(verdict.message, DATA_INTEGRITY_FAILURES[verdict.reason]);
    }
  }
  const shortKey = verifyProof(vectors.signedCredential, key.subarray(0, 31));
  assert.equal(shortKey.ok, false);
  if (!shortKey.ok) assert.equal(shortKey.reason, 'bad-key');
});

test('tracer: a ClearanceCredential signed by our CredentialSigner verifies with our verifier, and a raised level breaks it', async () => {
  const issuer = newTestKey();
  const credential = clearanceCredential(issuer.didKey);
  const proof = await createProof(credential, { proofPurpose: 'assertionMethod', created: '2026-11-24T12:00:00Z' }, signerFor(issuer.privateKey, issuer.verificationMethod));
  assert.equal(proof.type, 'DataIntegrityProof');
  assert.equal(proof.cryptosuite, 'eddsa-jcs-2022');
  assert.deepEqual(proof['@context'], credential['@context'], 'step 2 of Create Proof copies the document @context into the proof');
  const secured: Record<string, unknown> = { ...credential, proof };
  const verdict = verifyProof(secured, issuer.publicKey);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
  const lowered = clone(secured);
  (lowered.credentialSubject as Record<string, string>).atLeast = 'Top Secret';
  assert.equal(verifyProof(lowered, issuer.publicKey).ok, false, 'raising the claimed level breaks the proof');
});

test('createProof refuses a float, -0, NaN and 2^53 before anything is signed, with the reason not-canonical', async () => {
  const issuer = newTestKey();
  let signed = 0;
  const signer: CredentialSigner = { ...signerFor(issuer.privateKey, issuer.verificationMethod), sign: async (bytes) => { signed += 1; return new Uint8Array(edSign(null, bytes, issuer.privateKey)); } };
  for (const bad of [1.5, -0, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY]) {
    const credential = clearanceCredential(issuer.didKey);
    (credential.credentialSubject as Record<string, unknown>).level = bad;
    await assert.rejects(createProof(credential, { proofPurpose: 'assertionMethod' }, signer), (error: unknown) => {
      assert.ok(error instanceof DataIntegrityError, String(error));
      assert.equal(error.reason, 'not-canonical');
      assert.match(error.message, /\$\.credentialSubject\.level: (numbers must be safe integers|negative zero is not allowed)/);
      return true;
    });
  }
  const unsafeInOptions = clearanceCredential(issuer.didKey);
  await assert.rejects(createProof(unsafeInOptions, { proofPurpose: 'assertionMethod', created: 'yesterday' }, signer), (error: unknown) => error instanceof DataIntegrityError && error.reason === 'bad-created');
  await assert.rejects(createProof({ ...unsafeInOptions, proof: {} }, { proofPurpose: 'assertionMethod' }, signer), (error: unknown) => error instanceof DataIntegrityError && error.reason === 'already-signed');
  await assert.rejects(createProof(unsafeInOptions, { proofPurpose: 'assertionMethod' }, { ...signer, suite: 'ecdsa-jcs-2019' as 'eddsa-jcs-2022' }), (error: unknown) => error instanceof DataIntegrityError && error.reason === 'unsupported-suite');
  assert.equal(signed, 0, 'no refused credential reached the signer');
  const shortSignature: CredentialSigner = { ...signer, sign: async () => new Uint8Array(63) };
  await assert.rejects(createProof(unsafeInOptions, { proofPurpose: 'assertionMethod' }, shortSignature), (error: unknown) => error instanceof DataIntegrityError && error.reason === 'bad-signature');
});

test('domain separation: a Data Integrity input is always 64 raw bytes, and every signed-payload and team-event input is longer and starts with n or {', () => {
  const random = mulberry32(71_01);
  const key = newTestKey();
  const publicKey = Buffer.from(key.publicKey).toString('base64url');
  const fingerprint = `dev-${createHash('sha256').update(key.publicKey).digest('hex').slice(0, 32)}`;
  // The shortest team event and signed payload the formats allow: every required field present, every text empty, every number 0.
  const shortestEvent: UnsignedTeamEvent = { v: 1, id: '', teamId: '', type: 'team.created', lamport: 0, at: '', author: '', device: '', prev: '', body: {} as never };
  const shortestPayload: Omit<SignedPayload, 'sig'> = { v: 1, purpose: 'grant', signer: { fingerprint: '', publicKey: '' }, signedAt: '', payload: null };
  const eventFloor = signingInput(shortestEvent).length;
  const payloadFloor = Math.min(...PAYLOAD_PURPOSES.map((purpose) => payloadSigningInput({ ...shortestPayload, purpose }).length));
  assert.ok(eventFloor > DATA_INTEGRITY_INPUT_BYTES, `the shortest team-event input is ${eventFloor} bytes`);
  assert.ok(payloadFloor > DATA_INTEGRITY_INPUT_BYTES, `the shortest signed-payload input is ${payloadFloor} bytes`);
  for (let index = 0; index < 200; index += 1) {
    const word = randomBytes(1 + Math.floor(random() * 24)).toString('base64url');
    const document = { '@context': ['https://www.w3.org/ns/credentials/v2'], id: `urn:example:${word}`, n: Math.floor(random() * 1_000_000) };
    const options = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: key.verificationMethod, proofPurpose: 'assertionMethod', '@context': document['@context'] };
    const di = dataIntegritySigningInput(document, options);
    assert.equal(di.length, DATA_INTEGRITY_INPUT_BYTES);
    const purpose = PAYLOAD_PURPOSES[Math.floor(random() * PAYLOAD_PURPOSES.length)];
    const payload = payloadSigningInput({ v: 1, purpose, signer: { fingerprint, publicKey }, signedAt: '2026-11-24T00:00:00.000Z', payload: { word } });
    const event = signingInput({ ...shortestEvent, id: word, teamId: word, author: word, device: fingerprint, at: '2026-11-24T00:00:00.000Z' });
    assert.ok(payload.length > di.length && payload.subarray(0, PAYLOAD_DOMAIN.length).toString('utf8') === PAYLOAD_DOMAIN);
    assert.ok(event.length > di.length && event[0] === 0x7b);
    assert.notDeepEqual(di, payload.subarray(0, di.length));
    assert.notDeepEqual(di, event.subarray(0, di.length));
  }
});

test('base58btc round-trips random bytes including leading zeros, matches known vectors and refuses characters outside the alphabet', () => {
  assert.equal(base58btcEncode(new Uint8Array(0)), '');
  assert.equal(base58btcEncode(Buffer.from('Hello World!', 'utf8')), '2NEpo7TZRRrLZSi2U');
  assert.equal(base58btcEncode(Buffer.from('00000000287fb4cd', 'hex')), '1111233QC4');
  assert.deepEqual(Buffer.from(base58btcDecode('1111233QC4')).toString('hex'), '00000000287fb4cd');
  const random = mulberry32(58);
  for (let index = 0; index < 500; index += 1) {
    const zeros = Math.floor(random() * 4);
    const bytes = Buffer.concat([Buffer.alloc(zeros), randomBytes(Math.floor(random() * 70))]);
    const text = base58btcEncode(bytes);
    assert.match(text, /^[1-9A-HJ-NP-Za-km-z]*$/);
    assert.ok(text.startsWith('1'.repeat(zeros)));
    assert.deepEqual(Buffer.from(base58btcDecode(text)), bytes);
    assert.equal(multibaseEncode(bytes), `z${text}`);
  }
  for (const bad of ['0abc', 'Oabc', 'Iabc', 'labc', 'ab c']) assert.throws(() => base58btcDecode(bad), MultibaseError, bad);
  assert.throws(() => multibaseDecode('uAAAA'), MultibaseError, 'only the base58btc multibase prefix z is read');
});

test('Multikey: 0xed01 and 0x1200 headers round-trip a 32-byte Ed25519 key and a 33-byte compressed P-256 key, and the W3C example key decodes', () => {
  assert.deepEqual([...MULTIKEY_HEADERS.Ed25519], [0xed, 0x01]);
  assert.deepEqual([...MULTIKEY_HEADERS['P-256']], [0x80, 0x24], 'multicodec 0x1200 written as an unsigned varint');
  const ed = newTestKey();
  const edText = encodePublicKeyMultibase('Ed25519', ed.publicKey);
  assert.match(edText, /^z6Mk/);
  assert.deepEqual(decodePublicKeyMultibase(edText), { type: 'Ed25519', key: ed.publicKey });
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  const compressed = new Uint8Array(Buffer.concat([Buffer.from([(y[y.length - 1] & 1) === 0 ? 0x02 : 0x03]), x]));
  const p256Text = encodePublicKeyMultibase('P-256', compressed);
  assert.match(p256Text, /^zDn/);
  assert.deepEqual(decodePublicKeyMultibase(p256Text), { type: 'P-256', key: compressed });
  const w3c = decodePublicKeyMultibase(vectors.keyPair.publicKeyMultibase);
  const derived = new Uint8Array(createPublicKey(w3cPrivateKey()).export({ format: 'der', type: 'spki' }).subarray(12));
  assert.deepEqual(w3c.key, derived, 'the example public key is the one the example secret key gives');
  assert.throws(() => encodePublicKeyMultibase('Ed25519', new Uint8Array(31)), MultibaseError);
  assert.throws(() => encodePublicKeyMultibase('P-256', new Uint8Array(65)), MultibaseError, 'uncompressed P-256 keys are refused');
  assert.throws(() => decodePublicKeyMultibase(multibaseEncode(new Uint8Array([0x12, 0x00, ...new Uint8Array(33)]))), MultibaseError, 'an unknown header is refused');
});

