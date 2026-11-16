// Policy bundle v1 tests (OFFL-02, OFFL-03, CLAS-02, CLAS-05, D-11 to D-15, D-39, D-47): the payload, the shipped default, the routing table, the verifier's
// fail-closed states and the clock rule. Keys are generated at run time; no key material or token literal is written here.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import { fingerprintOf } from '../domain/team/canonical';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadPurpose, PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import { bundleHash, defaultBundlePayload, verifyBundleEnvelope } from '../domain/gate/bundle';
import type { PolicyBundle } from '../domain/gate/bundle';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_ROUTING } from '../domain/gate/routing';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function makeSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

const activeFor = (signer: PayloadSigner): KeyStatusLookup => (key) => (key.fingerprint === signer.fingerprint ? { state: 'active' } : { state: 'unknown' });

function defaultFor(signer: PayloadSigner, now = NOW): PolicyBundle {
  return defaultBundlePayload({ issuer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, now });
}

// Always the one signer, never a second one: signPayload with the purpose policy-bundle and the same time as issuedAt.
function signBundle(signer: PayloadSigner, payload: unknown, now = NOW, purpose: PayloadPurpose = 'policy-bundle'): SignedPayload {
  return signPayload(signer, purpose, payload, { now: () => new Date(now) });
}

test('tracer: the default bundle is signed with the one signer and verifies back to a valid state with its hash', () => {
  const signer = makeSigner();
  const payload = defaultFor(signer);
  const envelope = signBundle(signer, payload);
  assert.equal(envelope.purpose, 'policy-bundle');
  const state = verifyBundleEnvelope(envelope, { status: activeFor(signer), now: NOW });
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  assert.equal(state.hash, bundleHash(payload));
  assert.match(state.hash, /^[0-9a-f]{64}$/);
  assert.equal(state.signer.fingerprint, signer.fingerprint);
  assert.equal(state.expiresAt, payload.expiresAt);
  assert.deepEqual(Object.keys(state.bundle.scales).sort(), Object.keys(SCALE_PRESETS).sort());
  assert.deepEqual(state.bundle.clearances, [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }]);
  assert.deepEqual(state.bundle.mappings, []);
  assert.equal(DEFAULT_ROUTING.levels['org/Public'], 'any-cloud');
  assert.equal(state.bundle.routing.levels['org/Public'], 'any-cloud');
});
