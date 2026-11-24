// did:key for devices and agents, and the minimal DID document (Phase 71 plan 04 Task 1; D-13, DLGT-01, PROJECT decision 8).
// The fixed keys are the published did:key test vectors (Ed25519 and P-256, did:key method 0.9) and the DIF suite's first test key; nothing here is secret.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { encodePublicKeyMultibase } from '../domain/credentials/multibase';
import { DID_DOCUMENT_FAILURES, readDidDocument, verificationMethodsOf } from '../domain/did/didDocument';
import { didKeyFromDevice, didKeyFromPublicKey, didKeyMethodId, isDidKey, resolveDidKey } from '../domain/did/didKey';

// The did:key specification's Ed25519 example and the W3C ECDSA example key (P-256).
const ED25519_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const P256_DID = 'did:key:zDnaepBuvsQ8cpsWrVKw8fbpGpvPeNSjVPTWoq6cRqaYzBKVP';

function deviceKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
}

test('didKeyFromDevice turns a Phase 69 device key into did:key:z6Mk... with no key change, and resolveDidKey gives the same 32 bytes back', () => {
  const key = deviceKey();
  const did = didKeyFromDevice(key);
  assert.match(did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
  const resolved = resolveDidKey(did);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.publicKey.type, 'Ed25519');
  assert.equal(Buffer.from(resolved.publicKey.key).toString('base64url'), key);
  assert.equal(didKeyFromPublicKey('Ed25519', resolved.publicKey.key), did);
});

test('a fixed Ed25519 did:key resolves to a one-method document used for authentication and assertion, and the key re-encodes to the same DID', () => {
  const resolved = resolveDidKey(ED25519_DID);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const methodId = `${ED25519_DID}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`;
  assert.equal(didKeyMethodId(ED25519_DID), methodId);
  assert.equal(resolved.method.id, methodId);
  assert.deepEqual([...resolved.document.authentication], [methodId]);
  assert.deepEqual(verificationMethodsOf(resolved.document).map((method) => method.id), [methodId]);
  assert.equal(encodePublicKeyMultibase('Ed25519', resolved.publicKey.key), 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
  assert.ok(Object.isFrozen(resolved.document) && Object.isFrozen(resolved.method));
});

test('a P-256 did:key (zDn..., multicodec 0x1200) resolves to a P-256 Multikey method; any other multicodec is refused', () => {
  const resolved = resolveDidKey(P256_DID);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.publicKey.type, 'P-256');
    assert.equal(resolved.publicKey.key.length, 33);
  }
  // X25519 (0xec) and secp256k1 (0xe7) did:keys are real keys of other kinds.
  for (const other of ['did:key:z6LSeu9HkTHSfLLeUs2nnzUSNedgDUevfNQgQjQC23ZCit6F', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme']) {
    const refused = resolveDidKey(other);
    assert.equal(refused.ok, false, other);
    if (!refused.ok) assert.equal(refused.reason, 'bad-key');
  }
});

test('isDidKey separates a did:key from a did:webvh, a malformed string and a did:key URL whose fragment names another key', () => {
  assert.equal(isDidKey(ED25519_DID), true);
  assert.equal(isDidKey(`${ED25519_DID}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`), true);
  assert.equal(isDidKey('did:webvh:QmExampleScidOnlyForTests:example.org:people:alex'), false);
  for (const bad of ['did:key:', 'did:key:6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', 'did:key:z6Mk0OIl', 'did:key:z6Mkha/../x', 42, undefined]) assert.equal(isDidKey(bad), false, String(bad));
  const mismatch = resolveDidKey(`${ED25519_DID}#${P256_DID.slice('did:key:'.length)}`);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, 'fragment-mismatch');
});

test('didKeyFromDevice refuses anything but a strict 32-byte base64url key', () => {
  assert.throws(() => didKeyFromDevice(Buffer.alloc(31).toString('base64url')));
  assert.throws(() => didKeyFromDevice(`${deviceKey()}=`));
  assert.throws(() => didKeyFromDevice(Buffer.alloc(32).toString('base64')));
});

function minimalDocument(did: string, multibase: string): Record<string, unknown> {
  const methodId = `${did}#key-1`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    controller: did,
    verificationMethod: [{ id: methodId, type: 'Multikey', controller: did, publicKeyMultibase: multibase }],
    authentication: [methodId],
    assertionMethod: [methodId],
    service: [{ id: `${did}#hub`, type: 'LinkedDomains', serviceEndpoint: 'https://hq.example.org/' }]
  };
}

const ALEX = 'did:webvh:QmExampleScidOnlyForTestsQmExampleScidOnlyForT:example.org:people:alex';
const KEY = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

test('readDidDocument reads the minimal shape and refuses any other member, the spike\'s agentGuardrails included', () => {
  const read = readDidDocument(minimalDocument(ALEX, KEY), ALEX);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(verificationMethodsOf(read.document, 'assertionMethod')[0]?.publicKey.type, 'Ed25519');
  for (const member of ['agentGuardrails', 'keyAgreement', 'capabilityInvocation', 'capabilityDelegation', 'alsoKnownAs', 'clearance']) {
    const refused = readDidDocument({ ...minimalDocument(ALEX, KEY), [member]: [] }, ALEX);
    assert.equal(refused.ok, false, member);
    if (!refused.ok) {
      assert.equal(refused.reason, 'unknown-member', member);
      assert.equal(refused.message, DID_DOCUMENT_FAILURES['unknown-member']);
    }
  }
});

test('readDidDocument refuses another DID\'s document, a method with extra members or another key kind, and a relationship to a missing method', () => {
  assert.equal(readDidDocument(minimalDocument(ALEX, KEY), 'did:webvh:QmOther:example.org').ok, false);
  const extraMember = minimalDocument(ALEX, KEY);
  (extraMember.verificationMethod as Array<Record<string, unknown>>)[0]!.purpose = 'authentication';
  const otherKind = minimalDocument(ALEX, 'z6LSeu9HkTHSfLLeUs2nnzUSNedgDUevfNQgQjQC23ZCit6F');
  const dangling = { ...minimalDocument(ALEX, KEY), assertionMethod: [`${ALEX}#key-2`] };
  const embedded = { ...minimalDocument(ALEX, KEY), assertionMethod: [(minimalDocument(ALEX, KEY).verificationMethod as unknown[])[0]] };
  const foreignMethod = minimalDocument(ALEX, KEY);
  (foreignMethod.verificationMethod as Array<Record<string, unknown>>)[0]!.id = 'did:webvh:QmOther:example.org#key-1';
  const cases: Array<[string, unknown, string]> = [
    ['extra method member', extraMember, 'bad-method'],
    ['X25519 key', otherKind, 'bad-method'],
    ['dangling relationship', dangling, 'bad-relationship'],
    ['embedded method', embedded, 'bad-relationship'],
    ['method of another DID', foreignMethod, 'bad-method'],
    ['context not DID first', { ...minimalDocument(ALEX, KEY), '@context': ['https://w3id.org/security/multikey/v1'] }, 'bad-context'],
    ['controller not a DID', { ...minimalDocument(ALEX, KEY), controller: 'Example Organization' }, 'bad-controller'],
    ['service with extra member', { ...minimalDocument(ALEX, KEY), service: [{ id: `${ALEX}#hub`, type: 'LinkedDomains', serviceEndpoint: 'https://hq.example.org/', priority: 1 }] }, 'bad-service'],
    ['not an object', [minimalDocument(ALEX, KEY)], 'not-an-object']
  ];
  for (const [name, value, reason] of cases) {
    const result = readDidDocument(value, ALEX);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.reason, reason, name);
  }
});
