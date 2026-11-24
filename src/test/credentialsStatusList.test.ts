// Bitstring Status List (Phase 71 plan 05; D-14, VCRD-04): build, sign, verify and read a list; random never-reused indexes; revocation never clears;
// newer lists and citing by hash; cross-checked both ways with @digitalbazaar/vc-bitstring-status-list (test-only, owner-approved 2026-11-24).
// Fictional site and keys only (Example Organization); keys are generated at run time.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { EDDSA_JCS_2022 } from '../domain/credentials/dataIntegrity';
import type { CredentialSigner } from '../domain/credentials/dataIntegrity';
import { encodePublicKeyMultibase } from '../domain/credentials/multibase';
import type { MultikeyPublicKey } from '../domain/credentials/multibase';
import { CREDENTIAL_CONTEXTS } from '../domain/credentials/context';
import { issueCredential } from '../domain/credentials/profile';
import type { StatusEntry } from '../domain/credentials/profile';
import {
  MAX_STATUS_LIST_ENTRIES, STATUS_LIST_ALLOCATION_LIMIT, STATUS_LIST_ENTRIES, STATUS_LIST_TTL_MS, acceptStapled, buildStatusList, checkCredentialStatus,
  clearSuspension, decodeBits, encodeBits, listHash, newerThan, nextIndex, setBit, signStatusList, statusAt, verifyStatusList
} from '../domain/credentials/statusList';
import type { StatusListState } from '../domain/credentials/statusList';
import { mulberry32 } from './helpers/teamEvents';

interface Key { did: string; publicKey: MultikeyPublicKey; signer: CredentialSigner }

function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const multibase = encodePublicKeyMultibase('Ed25519', raw);
  const did = `did:key:${multibase}`;
  return { did, publicKey: { type: 'Ed25519', key: raw }, signer: { verificationMethod: `${did}#${multibase}`, suite: EDDSA_JCS_2022, sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) } };
}

const LIST_ID = 'https://hq.example.org/v1/trust/status/revocation-1';
const AT = Date.UTC(2026, 10, 25);

function bitsWith(indexes: readonly number[], size = STATUS_LIST_ENTRIES): Uint8Array {
  const bits = new Uint8Array(size / 8);
  for (const index of indexes) bits[index >> 3] = (bits[index >> 3] as number) | (0x80 >> (index & 7));
  return bits;
}

async function signedList(key: Key, options: { indexes?: number[]; purpose?: 'revocation' | 'suspension'; version?: number; validFrom?: string; validUntil?: string } = {}): Promise<Record<string, unknown>> {
  return signStatusList(key.signer, buildStatusList({
    id: LIST_ID, issuer: key.did, purpose: options.purpose ?? 'revocation', version: options.version ?? 1, ttl: STATUS_LIST_TTL_MS,
    validFrom: options.validFrom ?? '2026-11-24T00:00:00Z', validUntil: options.validUntil ?? '2026-12-01T00:00:00Z', bits: bitsWith(options.indexes ?? [])
  }), EDDSA_JCS_2022);
}

function verified(value: unknown, key: Key, at = AT): StatusListState {
  const result = verifyStatusList(value, key.publicKey, at);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) throw new Error('unreachable');
  return result.list;
}

function entry(index: number, purpose: 'revocation' | 'suspension' = 'revocation'): StatusEntry {
  return { statusPurpose: purpose, statusListIndex: index, statusListCredential: LIST_ID };
}

test('a 131,072-entry list with bits 7 and 99,000 set round-trips through gzip and multibase, signed and verified; statusAt reads each bit per purpose', async () => {
  const key = newKey();
  const credential = await signedList(key, { indexes: [7, 99_000] });
  const list = verified(credential, key);
  assert.equal(list.size, 131_072);
  assert.equal(statusAt(list, 7, 'revocation'), true);
  assert.equal(statusAt(list, 99_000, 'revocation'), true);
  for (const clear of [0, 6, 8, 98_999, 99_001, 131_071]) assert.equal(statusAt(list, clear, 'revocation'), false, String(clear));
  assert.equal(statusAt(list, 7, 'suspension'), undefined, 'a revocation list says nothing about suspension');
  assert.equal(statusAt(list, 131_072, 'revocation'), undefined);
  const encoded = (credential.credentialSubject as { encodedList: string }).encodedList;
  assert.match(encoded, /^u[A-Za-z0-9_-]+$/);
  assert.ok(encoded.length < 200, 'two bits set compress to a few dozen bytes');
  assert.equal(credential.credentialStatus, undefined, 'a status list has no status of its own');
  assert.deepEqual(decodeBits(encodeBits(bitsWith([1, 2, 3]))), { bits: bitsWith([1, 2, 3]) });
});

test('a list signed by any key but the one the policy names (an officer\'s person key, the subject\'s own key) is refused status-list-signer', async () => {
  const statusKey = newKey();
  const officer = newKey();
  const subject = newKey();
  for (const signer of [officer, subject]) {
    const result = verifyStatusList(await signedList(signer, { indexes: [7] }), statusKey.publicKey, AT);
    assert.equal(result.ok ? 'ok' : result.reason, 'status-list-signer');
  }
  // A proof that names the policy key but was made by another key does not verify.
  const forged = await signedList(officer, { indexes: [7] });
  const proof = forged.proof as Record<string, unknown>;
  const relabelled = { ...forged, issuer: statusKey.did, proof: { ...proof, verificationMethod: statusKey.signer.verificationMethod } };
  const result = verifyStatusList(relabelled, statusKey.publicKey, AT);
  assert.equal(result.ok ? 'ok' : result.reason, 'status-list-invalid');
});

test('changing one character of the encoded list, or its purpose, breaks the signature', async () => {
  const key = newKey();
  const credential = await signedList(key, { indexes: [7] });
  const subject = credential.credentialSubject as Record<string, string>;
  const last = subject.encodedList.slice(-1);
  const changed = { ...credential, credentialSubject: { ...subject, encodedList: `${subject.encodedList.slice(0, -1)}${last === 'A' ? 'B' : 'A'}` } };
  assert.equal(verifyStatusList(changed, key.publicKey, AT).ok, false);
  const repurposed = { ...credential, credentialSubject: { ...subject, statusPurpose: 'suspension' } };
  assert.equal(verifyStatusList(repurposed, key.publicKey, AT).ok, false);
});

test('a list shorter than 131,072 entries is refused, and buildStatusList will not make one', async () => {
  const key = newKey();
  assert.throws(() => buildStatusList({ id: LIST_ID, issuer: key.did, purpose: 'revocation', version: 1, validFrom: '2026-11-24T00:00:00Z', validUntil: '2026-12-01T00:00:00Z', size: 65_536 }), RangeError);
  const short = {
    '@context': [...CREDENTIAL_CONTEXTS], id: LIST_ID, type: ['VerifiableCredential', 'BitstringStatusListCredential'], issuer: key.did,
    validFrom: '2026-11-24T00:00:00Z', validUntil: '2026-12-01T00:00:00Z',
    credentialSubject: { id: `${LIST_ID}#list`, type: 'BitstringStatusList', statusPurpose: 'revocation', version: 1, encodedList: `u${gzipSync(new Uint8Array(65_536 / 8)).toString('base64url')}` }
  };
  const signed = await issueCredential(key.signer, short, EDDSA_JCS_2022, { scales: {} });
  const result = verifyStatusList(signed, key.publicKey, AT);
  assert.equal(result.ok ? 'ok' : result.reason, 'status-list-too-short');
});

test('a small GZIP that expands past the largest list is refused before it is held in memory', () => {
  const bomb = `u${gzipSync(new Uint8Array(MAX_STATUS_LIST_ENTRIES / 8 + 1)).toString('base64url')}`;
  assert.deepEqual(decodeBits(bomb), { reason: 'status-list-invalid' });
  assert.deepEqual(decodeBits('zNotBase64url'), { reason: 'status-list-invalid' });
  assert.deepEqual(decodeBits(`u${Buffer.from('not gzip').toString('base64url')}`), { reason: 'status-list-invalid' });
});

test('a credential\'s status fails closed: no list, a list that does not verify, a list past validUntil, or another list gives status-unavailable', async () => {
  const key = newKey();
  const credential = await signedList(key, { indexes: [7] });
  const revoked = checkCredentialStatus(entry(7), credential, { issuerKey: key.publicKey, at: AT });
  assert.equal(revoked.ok && revoked.set, true);
  if (revoked.ok) assert.equal(revoked.listHash, listHash(credential));
  const clear = checkCredentialStatus(entry(8), credential, { issuerKey: key.publicKey, at: AT });
  assert.equal(clear.ok && clear.set, false);
  const cases: Array<[string, StatusEntry, unknown, number, MultikeyPublicKey]> = [
    ['no list', entry(7), undefined, AT, key.publicKey],
    ['another key', entry(7), credential, AT, newKey().publicKey],
    ['past validUntil', entry(7), credential, Date.UTC(2026, 11, 1), key.publicKey],
    ['before validFrom', entry(7), credential, Date.UTC(2026, 10, 23), key.publicKey],
    ['another list', { ...entry(7), statusListCredential: 'https://hq.example.org/v1/trust/status/revocation-2' }, credential, AT, key.publicKey],
    ['another purpose', entry(7, 'suspension'), credential, AT, key.publicKey],
    ['index outside the list', entry(131_072), credential, AT, key.publicKey]
  ];
  for (const [name, statusEntry, list, at, issuerKey] of cases) {
    const result = checkCredentialStatus(statusEntry, list, { issuerKey, at });
    assert.equal(result.ok ? 'ok' : result.reason, 'status-unavailable', name);
  }
});

// ---- Cross-check with the reference implementation (a variable specifier keeps this CommonJS build loading the ES module) ----
async function esm(name: string): Promise<any> {
  return import(name);
}

test('cross-check: our list decodes with @digitalbazaar/vc-bitstring-status-list, and its checkStatus reads a credential\'s bits from our list', async () => {
  const reference = await esm('@digitalbazaar/vc-bitstring-status-list');
  const key = newKey();
  const credential = await signedList(key, { indexes: [7, 99_000] });
  const theirs = await reference.decodeList({ encodedList: (credential.credentialSubject as { encodedList: string }).encodedList });
  assert.equal(theirs.length, 131_072);
  assert.equal(theirs.getStatus(7), true);
  assert.equal(theirs.getStatus(99_000), true);
  assert.equal(theirs.getStatus(8), false);
  const holderCredential = {
    '@context': [...CREDENTIAL_CONTEXTS], type: ['VerifiableCredential', 'ClearanceCredential'], issuer: 'did:webvh:QmExample:example.org:people:sam',
    credentialStatus: [{ id: `${LIST_ID}#99000`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '99000', statusListCredential: LIST_ID }]
  };
  // Only our list is served; the proof itself is cross-checked in credentialsConformance (71-01), so the reference only reads the list here.
  const documentLoader = async (url: string) => {
    if (url !== LIST_ID) throw new Error(`no document for ${url}; tests never use the network`);
    return { contextUrl: null, documentUrl: url, document: credential };
  };
  const result = await reference.checkStatus({ credential: holderCredential, documentLoader, verifyBitstringStatusListCredential: false, verifyMatchingIssuers: false });
  assert.equal(result.verified, true, String(result.error ?? ''));
  assert.equal(result.results[0].status, true);
});

test('cross-check: a list the reference builds reads the same with ours, signed in our format and verified', async () => {
  const reference = await esm('@digitalbazaar/vc-bitstring-status-list');
  const list = await reference.createList({ length: 131_072 });
  list.setStatus(42, true);
  list.setStatus(131_071, true);
  const theirs = await reference.createCredential({ id: LIST_ID, list, statusPurpose: 'suspension' });
  const decoded = decodeBits(theirs.credentialSubject.encodedList);
  assert.ok('bits' in decoded);
  const key = newKey();
  const signed = await signStatusList(key.signer, {
    ...buildStatusList({ id: LIST_ID, issuer: key.did, purpose: 'suspension', version: 1, validFrom: '2026-11-24T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' }),
    credentialSubject: { ...theirs.credentialSubject, version: 1 }
  }, EDDSA_JCS_2022);
  const ours = verified(signed, key);
  assert.equal(statusAt(ours, 42, 'suspension'), true);
  assert.equal(statusAt(ours, 131_071, 'suspension'), true);
  assert.equal(statusAt(ours, 41, 'suspension'), false);
});

// ---- Task 2: indexes, bits, newer lists and citing by hash ----

test('nextIndex with a seeded source never returns an index already allocated, across 10,000 allocations, and stops at half the list', () => {
  const random = mulberry32(71_05);
  const allocated = new Set<number>();
  for (let count = 0; count < 10_000; count += 1) {
    const index = nextIndex(allocated, random);
    assert.ok(index !== undefined && index >= 0 && index < STATUS_LIST_ENTRIES);
    assert.ok(!allocated.has(index), `index ${String(index)} reused`);
    allocated.add(index);
  }
  assert.equal(allocated.size, 10_000);
  const full = new Set<number>(Array.from({ length: STATUS_LIST_ALLOCATION_LIMIT }, (_, index) => index));
  assert.equal(nextIndex(full, random), undefined, 'start a new list pair at half');
});

test('nextIndex still finds a free index when the source keeps repeating itself', () => {
  const allocated = new Set<number>([0, 1, 2]);
  assert.equal(nextIndex(allocated, () => 0), 3);
});

test('setBit sets a revocation and raises the version; nothing clears a revocation; clearSuspension clears only a suspension', async () => {
  const key = newKey();
  const revocations = verified(await signedList(key, { indexes: [7] }), key);
  const raised = setBit(revocations, 500, 'revocation');
  assert.equal(raised.version, revocations.version + 1);
  assert.equal(statusAt(raised, 500, 'revocation'), true);
  assert.equal(statusAt(revocations, 500, 'revocation'), false, 'the held list is unchanged');
  assert.throws(() => clearSuspension(raised, 7), RangeError);
  assert.throws(() => setBit(raised, 7, 'suspension'), RangeError);
  const suspensions = verified(await signedList(key, { purpose: 'suspension', indexes: [9] }), key);
  const lifted = clearSuspension(suspensions, 9);
  assert.equal(statusAt(lifted, 9, 'suspension'), false);
  assert.equal(lifted.version, suspensions.version + 1);
});

test('listHash is stable for the same list in another key order and changes with the list', async () => {
  const key = newKey();
  const credential = await signedList(key, { indexes: [7] });
  const reordered = Object.fromEntries(Object.entries(credential).reverse());
  assert.equal(listHash(reordered), listHash(credential));
  assert.match(listHash(credential), /^[0-9a-f]{64}$/);
  assert.notEqual(listHash(await signedList(key, { indexes: [7, 8], version: 2 })), listHash(credential));
});

test('newerThan is true only for the same issuer and list with a higher version and a later validFrom', async () => {
  const key = newKey();
  const held = verified(await signedList(key, { version: 3, validFrom: '2026-11-24T00:00:00Z' }), key);
  const newer = verified(await signedList(key, { version: 4, validFrom: '2026-11-24T06:00:00Z' }), key);
  const sameTime = verified(await signedList(key, { version: 4, validFrom: '2026-11-24T00:00:00Z' }), key);
  const older = verified(await signedList(key, { version: 2, validFrom: '2026-11-24T06:00:00Z' }), key);
  const other = newKey();
  const otherIssuer = verified(await signedList(other, { version: 9, validFrom: '2026-11-24T06:00:00Z' }), other);
  assert.equal(newerThan(newer, held), true);
  assert.equal(newerThan(held, newer), false);
  assert.equal(newerThan(sameTime, held), false);
  assert.equal(newerThan(older, held), false);
  assert.equal(newerThan(otherIssuer, held), false);
});

test('a stapled list is accepted only when it verifies, is newer than the one held, and clears no revocation', async () => {
  const key = newKey();
  const held = verified(await signedList(key, { indexes: [7], version: 1 }), key);
  const options = { issuerKey: key.publicKey, at: AT };
  const newer = acceptStapled(held, await signedList(key, { indexes: [7, 8], version: 2, validFrom: '2026-11-24T06:00:00Z' }), options);
  assert.equal(newer.ok, true);
  assert.equal(acceptStapled(undefined, await signedList(key, { indexes: [7] }), options).ok, true, 'the first list is taken when it verifies');
  const replay = acceptStapled(held, await signedList(key, { indexes: [7], version: 1 }), options);
  assert.equal(replay.ok ? 'ok' : replay.reason, 'not-newer');
  const unrevoked = acceptStapled(held, await signedList(key, { indexes: [8], version: 2, validFrom: '2026-11-24T06:00:00Z' }), options);
  assert.equal(unrevoked.ok ? 'ok' : unrevoked.reason, 'revocation-cleared');
  const forged = acceptStapled(held, await signedList(newKey(), { indexes: [], version: 9, validFrom: '2026-11-24T06:00:00Z' }), options);
  assert.equal(forged.ok ? 'ok' : forged.reason, 'status-list-signer');
});
