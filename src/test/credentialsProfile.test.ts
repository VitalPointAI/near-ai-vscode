// The narrow VC 2.0 credential format (Phase 71 plan 03; D-05, D-09, VCRD-02, O8): one way to issue, read, verify and hash a credential.
// Fictional people and keys only (Example Organization). Test keys are generated at run time, except the W3C example key, which stays in the fixture.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { OUR_CONTEXT_DOCUMENT, OUR_CONTEXT_URL, OUR_TERMS, VC_V2_CONTEXT } from '../domain/credentials/context';
import { EDDSA_JCS_2022, dataIntegritySigningInput } from '../domain/credentials/dataIntegrity';
import type { CredentialSigner, CredentialSuite } from '../domain/credentials/dataIntegrity';
import { createEcdsaProof, verifyEcdsaProof } from '../domain/credentials/ecdsaJcs2019';
import { decodePublicKeyMultibase, encodePublicKeyMultibase, multibaseDecode, multibaseEncode } from '../domain/credentials/multibase';
import type { MultikeyPublicKey } from '../domain/credentials/multibase';
import {
  CREDENTIAL_PROFILE_REFUSALS, CredentialProfileError, credentialHash, issueCredential, readCredential, verifyCredential
} from '../domain/credentials/profile';
import { CREDENTIAL_TYPES } from '../domain/credentials/types';

interface TestIssuer { did: string; verificationMethod: string; publicKey: MultikeyPublicKey; privateKey: KeyObject; suite: CredentialSuite; signer: CredentialSigner }

function rawEd25519(publicKey: KeyObject): Uint8Array {
  return new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
}

function compressedP256(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  return new Uint8Array(Buffer.concat([Buffer.from([(y[y.length - 1] & 1) === 0 ? 0x02 : 0x03]), x]));
}

// The issuer DID is a did:key here only because DID resolution is 71-04's; the format does not decide who may issue (71-06 does).
function ed25519Issuer(): TestIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = rawEd25519(publicKey);
  const multibase = encodePublicKeyMultibase('Ed25519', key);
  const did = `did:key:${multibase}`;
  const verificationMethod = `${did}#${multibase}`;
  return {
    did, verificationMethod, privateKey, suite: EDDSA_JCS_2022, publicKey: { type: 'Ed25519', key },
    signer: { verificationMethod, suite: EDDSA_JCS_2022, sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) }
  };
}

function p256Issuer(): TestIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = compressedP256(publicKey);
  const multibase = encodePublicKeyMultibase('P-256', key);
  const did = `did:key:${multibase}`;
  const verificationMethod = `${did}#${multibase}`;
  return {
    did, verificationMethod, privateKey, suite: 'ecdsa-jcs-2019', publicKey: { type: 'P-256', key },
    signer: { verificationMethod, suite: 'ecdsa-jcs-2019', sign: async (bytes) => new Uint8Array(cryptoSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' })) }
  };
}

const ALEX = 'did:webvh:QmExampleScidOnlyForTests:example.org:people:alex';
const LIST = 'https://hq.example.org/status/1';
const SCALES = SCALE_PRESETS;
const IN_WINDOW = Date.UTC(2026, 11, 1);

function unsignedClearance(issuer: string): Record<string, unknown> {
  return {
    '@context': [VC_V2_CONTEXT, OUR_CONTEXT_URL],
    type: ['VerifiableCredential', 'ClearanceCredential'],
    issuer,
    validFrom: '2026-11-24T00:00:00Z',
    validUntil: '2027-11-24T00:00:00Z',
    credentialSubject: { id: ALEX, scale: 'ca-classified', atLeast: 'Secret' },
    credentialStatus: [
      { id: `${LIST}-r#4711`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '4711', statusListCredential: `${LIST}-r` },
      { id: `${LIST}-s#93`, type: 'BitstringStatusListEntry', statusPurpose: 'suspension', statusListIndex: '93', statusListCredential: `${LIST}-s` }
    ]
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function issued(issuer: TestIssuer, unsigned = unsignedClearance(issuer.did)): Promise<Record<string, unknown>> {
  return issueCredential(issuer.signer, unsigned, issuer.suite, { scales: SCALES, created: '2026-11-24T12:00:00Z' });
}

function reasonOf(value: unknown, issuer: TestIssuer, at?: number): string {
  const result = verifyCredential(value, { publicKey: issuer.publicKey, scales: SCALES, ...(at === undefined ? {} : { at }) });
  return result.ok ? 'ok' : result.reason;
}

test('a credential issued with issueCredential verifies, and the result names its type, claims, status entries, suite and verification method', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const result = verifyCredential(credential, { publicKey: issuer.publicKey, scales: SCALES, at: IN_WINDOW });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.type, 'ClearanceCredential');
  assert.deepEqual({ ...result.claims }, { id: ALEX, scale: 'ca-classified', atLeast: 'Secret' });
  assert.deepEqual(result.status.map((entry) => [entry.statusPurpose, entry.statusListIndex]), [['revocation', 4711], ['suspension', 93]]);
  assert.equal(result.suite, 'eddsa-jcs-2022');
  assert.equal(result.verificationMethod, issuer.verificationMethod);
  assert.equal(result.issuer, issuer.did);
});

test('changing a claim, validFrom, validUntil, a status entry or the proof value afterwards fails with bad-signature', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const changes: Array<[string, (value: Record<string, any>) => void]> = [
    ['claim', (value) => { value.credentialSubject.atLeast = 'Top Secret'; }],
    ['subject', (value) => { value.credentialSubject.id = 'did:webvh:QmExampleScidOnlyForTests:example.org:people:sam'; }],
    ['validFrom', (value) => { value.validFrom = '2026-11-23T00:00:00Z'; }],
    ['validUntil', (value) => { value.validUntil = '2036-11-24T00:00:00Z'; }],
    ['status index', (value) => { value.credentialStatus[0].statusListIndex = '4712'; }],
    ['status list', (value) => { value.credentialStatus[1].statusListCredential = 'https://hq.example.org/status/2'; }],
    ['proof value', (value) => { value.proof.proofValue = `${value.proof.proofValue.slice(0, -2)}${value.proof.proofValue.endsWith('1') ? '22' : '11'}`; }]
  ];
  for (const [name, change] of changes) {
    const copy = clone(credential);
    change(copy);
    assert.equal(reasonOf(copy, issuer), 'bad-signature', name);
  }
});

test('changing the issuer is refused as issuer-mismatch, and a proof made with another DID\'s key is refused the same way', async () => {
  const issuer = ed25519Issuer();
  const other = ed25519Issuer();
  const credential = await issued(issuer);
  assert.equal(reasonOf({ ...clone(credential), issuer: other.did }, other), 'issuer-mismatch');
  await assert.rejects(issueCredential(other.signer, unsignedClearance(issuer.did), EDDSA_JCS_2022, { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'issuer-mismatch');
});

test('a third context, a missing context and the contexts in another order are each refused before any signature check', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const third = clone(credential);
  (third['@context'] as string[]).push('https://www.w3.org/ns/credentials/examples/v2');
  const { '@context': _context, ...missing } = clone(credential);
  const reordered = { ...clone(credential), '@context': [OUR_CONTEXT_URL, VC_V2_CONTEXT] };
  const ourOnly = { ...clone(credential), '@context': [VC_V2_CONTEXT] };
  assert.equal(reasonOf(third, issuer), 'wrong-context');
  assert.equal(reasonOf(missing, issuer), 'missing-member');
  assert.equal(reasonOf(reordered, issuer), 'wrong-context');
  assert.equal(reasonOf(ourOnly, issuer), 'wrong-context');
});

test('the type must be VerifiableCredential then exactly one known type: a string, two types, an unknown type and the reserved type are refused', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  for (const type of ['ClearanceCredential', ['VerifiableCredential'], ['VerifiableCredential', 'ClearanceCredential', 'MembershipCredential'], ['ClearanceCredential', 'VerifiableCredential'], ['VerifiableCredential', 'AlumniCredential'], ['VerifiableCredential', 'DelegationCredential'], ['VerifiableCredential', 7]]) {
    assert.equal(reasonOf({ ...clone(credential), type }, issuer), 'wrong-type', JSON.stringify(type));
  }
});

test('a float is refused as not-canonical: on issue before the signer is called, and on verify before the signature is checked', async () => {
  const issuer = ed25519Issuer();
  let signed = 0;
  const counting: CredentialSigner = { ...issuer.signer, sign: async (bytes) => { signed += 1; return issuer.signer.sign(bytes); } };
  const unsigned = unsignedClearance(issuer.did);
  (unsigned.credentialStatus as Array<Record<string, unknown>>)[0].statusListIndex = 4711.5;
  await assert.rejects(issueCredential(counting, unsigned, EDDSA_JCS_2022, { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'not-canonical');
  assert.equal(signed, 0);
  const credential = await issued(issuer);
  const withFloat = clone(credential) as Record<string, any>;
  withFloat.credentialSubject.weight = 0.5;
  assert.equal(reasonOf(withFloat, issuer), 'not-canonical');
});

test('validFrom and validUntil are required, UTC, and validFrom comes first', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const { validUntil: _until, ...noUntil } = clone(credential);
  assert.equal(reasonOf(noUntil, issuer), 'missing-member');
  assert.equal(reasonOf({ ...clone(credential), validUntil: '2026-11-24T00:00:00Z' }, issuer), 'bad-dates');
  assert.equal(reasonOf({ ...clone(credential), validFrom: '2026-11-24T00:00:00+00:00' }, issuer), 'bad-dates');
  const unsigned = unsignedClearance(issuer.did);
  delete unsigned.validUntil;
  await assert.rejects(issueCredential(issuer.signer, unsigned, EDDSA_JCS_2022, { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'missing-member');
});

test('credentialStatus needs exactly one revocation and one suspension entry, and a status list credential has none', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const { credentialStatus: entries, ...noStatus } = clone(credential) as Record<string, any>;
  assert.equal(reasonOf(noStatus, issuer), 'bad-status');
  assert.equal(reasonOf({ ...noStatus, credentialStatus: [entries[0]] }, issuer), 'bad-status');
  assert.equal(reasonOf({ ...noStatus, credentialStatus: [entries[0], entries[0]] }, issuer), 'bad-status');
  assert.equal(reasonOf({ ...noStatus, credentialStatus: [entries[0], { ...entries[1], statusListIndex: '093' }] }, issuer), 'bad-status');
  assert.equal(reasonOf({ ...noStatus, credentialStatus: [entries[0], { ...entries[1], type: 'StatusList2021Entry' }] }, issuer), 'bad-status');
  assert.equal(reasonOf({ ...noStatus, credentialStatus: entries[0] }, issuer), 'bad-status');
  const list = statusListUnsigned(issuer.did);
  const listed = await issueCredential(issuer.signer, list, EDDSA_JCS_2022, { scales: SCALES });
  assert.equal(reasonOf(listed, issuer), 'ok');
  assert.equal(reasonOf({ ...clone(listed), credentialStatus: entries }, issuer), 'bad-status');
  const { id: _id, ...noId } = clone(listed);
  assert.equal(reasonOf(noId, issuer), 'missing-member', 'a status list must have an id');
});

function statusListUnsigned(issuer: string): Record<string, unknown> {
  return {
    '@context': [VC_V2_CONTEXT, OUR_CONTEXT_URL],
    id: `${LIST}-r`,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer,
    validFrom: '2026-11-24T00:00:00Z',
    validUntil: '2026-12-01T00:00:00Z',
    credentialSubject: { id: `${LIST}-r#list`, type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA', ttl: 900000, version: 1 }
  };
}

test('claims are read exactly through the type: an extra or missing claim is bad-claims; another member or a second proof is refused', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const extra = clone(credential) as Record<string, any>;
  extra.credentialSubject.compartments = ['ALPHA'];
  assert.equal(reasonOf(extra, issuer), 'bad-claims');
  const unknownScale = clone(credential) as Record<string, any>;
  unknownScale.credentialSubject.scale = 'ca-gc-classified';
  assert.equal(reasonOf(unknownScale, issuer), 'bad-claims');
  assert.equal(reasonOf({ ...clone(credential), evidence: [] }, issuer), 'unknown-member');
  assert.equal(reasonOf({ ...clone(credential), issuer: { id: issuer.did } }, issuer), 'bad-issuer');
  assert.equal(reasonOf({ ...clone(credential), proof: [clone(credential).proof] }, issuer), 'bad-proof');
  await assert.rejects(issueCredential(issuer.signer, clone(credential), EDDSA_JCS_2022, { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'already-signed');
});

test('verifyCredential uses only the key the caller passes: another key of the same kind is bad-signature, another kind is suite-key-mismatch', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  assert.equal(reasonOf(credential, ed25519Issuer()), 'bad-signature');
  assert.equal(reasonOf(credential, p256Issuer()), 'suite-key-mismatch');
  assert.equal(verifyCredential(credential, { publicKey: undefined as unknown as MultikeyPublicKey, scales: SCALES }).ok, false);
});

test('with a time, a credential is refused before validFrom (not-yet-valid) and from validUntil on (expired)', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  assert.equal(reasonOf(credential, issuer, Date.UTC(2026, 10, 23)), 'not-yet-valid');
  assert.equal(reasonOf(credential, issuer, Date.UTC(2026, 10, 24)), 'ok', 'valid from validFrom itself');
  assert.equal(reasonOf(credential, issuer, Date.UTC(2027, 10, 24)), 'expired', 'not valid at validUntil');
  assert.equal(reasonOf(credential, issuer, Number.NaN), 'not-yet-valid');
});

test('credentialHash is the SHA-256 of the canonical bytes of the whole credential, proof included, the same in any key order', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const hash = credentialHash(credential);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(clone(credential)).reverse());
  assert.equal(credentialHash(reordered), hash);
  const { proof: _proof, ...unsigned } = clone(credential);
  assert.notEqual(credentialHash(unsigned), hash, 'the proof is part of what is cited');
  assert.throws(() => credentialHash({ value: 1.5 }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'not-canonical');
});

test('readCredential gives the issuer and verification method without a key, so the caller can resolve the key first', async () => {
  const issuer = ed25519Issuer();
  const credential = await issued(issuer);
  const read = readCredential(credential, SCALES, { signed: true });
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.value.proof, { suite: 'eddsa-jcs-2022', verificationMethod: issuer.verificationMethod });
  assert.equal(readCredential(unsignedClearance(issuer.did), SCALES, { signed: true }).ok, false, 'a signed read needs a proof');
  assert.equal(readCredential('{}', SCALES, { signed: false }).ok, false);
});

test('every refusal has one plain sentence that quotes no value, and the context defines every type and claim name', () => {
  for (const [reason, sentence] of Object.entries(CREDENTIAL_PROFILE_REFUSALS)) {
    assert.match(sentence, /^[A-Z@a-z].*\.$/, reason);
    assert.doesNotMatch(sentence, /did:|z6Mk|https?:/, reason);
  }
  const terms = (OUR_CONTEXT_DOCUMENT['@context'] as Record<string, unknown>);
  assert.equal(terms['@protected'], true);
  for (const type of CREDENTIAL_TYPES) if (type !== 'BitstringStatusListCredential') assert.ok(OUR_TERMS.includes(type), type);
  assert.ok(Object.isFrozen(OUR_CONTEXT_DOCUMENT));
});

// ---- The second suite, ecdsa-jcs-2019 on P-256 (O8, gap G350) ----

const ECDSA_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'credentials', 'w3c-ecdsa-jcs-2019');
const SPKI_P256_PREFIX = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
interface EcdsaVectors {
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
  signedCredential: Record<string, unknown> & { proof: Record<string, unknown> };
}
const ecdsa = JSON.parse(readFileSync(path.join(ECDSA_DIR, 'vectors.json'), 'utf8')) as EcdsaVectors;

function w3cP256PrivateKey(): KeyObject {
  const secret = Buffer.from(multibaseDecode(ecdsa.keyPair.secretKeyMultibase));
  // multicodec p256-priv (0x1306) as a varint is 0x86 0x26, then the 32-byte scalar.
  assert.deepEqual(secret.subarray(0, 2), Buffer.from([0x86, 0x26]));
  const { key } = decodePublicKeyMultibase(ecdsa.keyPair.publicKeyMultibase);
  const jwk = createPublicKey({ key: Buffer.concat([SPKI_P256_PREFIX, key]), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  return createPrivateKey({ key: { ...jwk, d: secret.subarray(2).toString('base64url') }, format: 'jwk' });
}

test('ecdsa-jcs-2019: a credential issued with a P-256 key verifies, names its suite, and a changed byte fails', async () => {
  const issuer = p256Issuer();
  const credential = await issued(issuer);
  const result = verifyCredential(credential, { publicKey: issuer.publicKey, scales: SCALES, at: IN_WINDOW });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (result.ok) assert.equal(result.suite, 'ecdsa-jcs-2019');
  assert.equal((credential.proof as Record<string, unknown>).cryptosuite, 'ecdsa-jcs-2019');
  const changed = clone(credential) as Record<string, any>;
  changed.credentialSubject.atLeast = 'Top Secret';
  assert.equal(reasonOf(changed, issuer), 'bad-signature');
});

test('ecdsa-jcs-2019: the W3C P-256 examples (Appendix A.5) give the same canonical forms and hashes, and the example signature verifies', () => {
  assert.equal(canonicalize(ecdsa.unsecuredCredential), ecdsa.canonicalCredential);
  assert.equal(canonicalize(ecdsa.proofOptions), ecdsa.canonicalProofOptions);
  const input = dataIntegritySigningInput(ecdsa.unsecuredCredential, ecdsa.proofOptions);
  assert.equal(input.toString('hex'), ecdsa.combinedHashHex);
  assert.equal(input.subarray(0, 32).toString('hex'), ecdsa.proofOptionsHashHex);
  assert.equal(input.subarray(32).toString('hex'), ecdsa.credentialHashHex);
  assert.equal(Buffer.from(multibaseDecode(ecdsa.proofValue)).toString('hex'), ecdsa.signatureHex);
  const { key } = decodePublicKeyMultibase(ecdsa.keyPair.publicKeyMultibase);
  const verdict = verifyEcdsaProof(ecdsa.signedCredential, key);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
  const flipped = clone(ecdsa.signedCredential);
  const signature = Buffer.from(ecdsa.signatureHex, 'hex');
  signature[10] = (signature[10] as number) ^ 0x01;
  flipped.proof.proofValue = multibaseEncode(new Uint8Array(signature));
  const refused = verifyEcdsaProof(flipped, key);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'bad-signature');
  const derived = createPublicKey(w3cP256PrivateKey()).export({ format: 'jwk' });
  const published = createPublicKey({ key: Buffer.concat([SPKI_P256_PREFIX, key]), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  assert.deepEqual([derived.x, derived.y], [published.x, published.y], 'the example secret key gives the example public key');
});

test('ecdsa-jcs-2019: our signer with the W3C example key makes a proof the verifier accepts (node:crypto signs with a random nonce)', async () => {
  const privateKey = w3cP256PrivateKey();
  const { key } = decodePublicKeyMultibase(ecdsa.keyPair.publicKeyMultibase);
  const signer: CredentialSigner = {
    verificationMethod: ecdsa.proofOptions.verificationMethod as string, suite: 'ecdsa-jcs-2019',
    sign: async (bytes) => new Uint8Array(cryptoSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }))
  };
  const proof = await createEcdsaProof(clone(ecdsa.unsecuredCredential), { proofPurpose: 'assertionMethod', created: ecdsa.proofOptions.created as string }, signer);
  const verdict = verifyEcdsaProof({ ...clone(ecdsa.unsecuredCredential), proof }, key);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
});

test('ecdsa-jcs-2019: a DER-encoded signature by the right key is refused, on verify and from a signer', async () => {
  const issuer = p256Issuer();
  const credential = await issued(issuer);
  const { proof, ...unsecured } = clone(credential) as Record<string, any>;
  const { proofValue: _value, ...proofConfig } = proof;
  const der = cryptoSign('sha256', dataIntegritySigningInput(unsecured, proofConfig), { key: issuer.privateKey, dsaEncoding: 'der' });
  assert.notEqual(der.length, 64);
  const withDer = { ...unsecured, proof: { ...proof, proofValue: multibaseEncode(new Uint8Array(der)) } };
  assert.equal(reasonOf(withDer, issuer), 'bad-signature');
  const derSigner: CredentialSigner = { ...issuer.signer, sign: async (bytes) => new Uint8Array(cryptoSign('sha256', bytes, { key: issuer.privateKey, dsaEncoding: 'der' })) };
  await assert.rejects(issueCredential(derSigner, unsignedClearance(issuer.did), 'ecdsa-jcs-2019', { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'bad-signature');
});

test('the suite and the key kind must agree: an ecdsa-jcs-2019 proof with an Ed25519 key and an eddsa-jcs-2022 proof with a P-256 key are refused', async () => {
  const p256 = p256Issuer();
  const ed = ed25519Issuer();
  const ecdsaCredential = await issued(p256);
  assert.equal(reasonOf(ecdsaCredential, ed), 'suite-key-mismatch');
  assert.equal(reasonOf(await issued(ed), p256), 'suite-key-mismatch');
  const direct = verifyEcdsaProof(ecdsaCredential, ed.publicKey.key);
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.equal(direct.reason, 'bad-key');
  const relabelled = clone(ecdsaCredential) as Record<string, any>;
  relabelled.proof.cryptosuite = 'eddsa-jcs-2022';
  assert.equal(reasonOf(relabelled, p256), 'suite-key-mismatch');
  await assert.rejects(issueCredential(p256.signer, unsignedClearance(p256.did), EDDSA_JCS_2022, { scales: SCALES }), (error: unknown) => error instanceof CredentialProfileError && error.reason === 'unsupported-suite');
});
