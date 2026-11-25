// 48.2-04 (D-19): the workbench's Node verifier for cosign key-mode Sigstore bundles (compliance/src/sigstoreBundle.ts) accepts exactly what
// the pinned cosign 3.1.4 accepts and refuses a changed byte, another key, a changed signature, a changed message digest and any key type
// but ECDSA P-256. The bundles are made by the pinned cosign with the S1 flags (deploy/bundle/lib/cosign.mjs: key pair, empty signing
// config). Needs the pinned cosign ($COSIGN or PATH); fails, never skips, without it.
// Run: env COSIGN=compliance/out/tools/cosign node scripts/run-tests.mjs deploy/test/sigstore-parity.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { cosignBinary, signBlob, verifyBlob } from '../bundle/lib/cosign.mjs';
import { publicKeyFingerprint, verifySigstoreBundle } from '../../compliance/src/sigstoreBundle.ts';

process.env.COSIGN_PASSWORD = 'sigstore-parity-test';
const DIR = mkdtempSync(path.join(tmpdir(), 'sigstore-parity-'));
const file = (name) => path.join(DIR, name);
const MANIFEST = file('manifest.json');
const BUNDLE = file('manifest.json.sigstore.json');

before(() => {
  for (const prefix of ['release', 'other']) {
    const run = spawnSync(cosignBinary(), ['generate-key-pair', '--output-key-prefix', prefix], { cwd: DIR, encoding: 'utf8' });
    assert.ok(!run.error, `cosign was not found (${cosignBinary()}); set COSIGN to the pinned cosign (sh compliance/ci/install-tool.sh cosign compliance/out/tools).`);
    assert.equal(run.status, 0, run.stderr);
  }
  writeFileSync(MANIFEST, `${JSON.stringify({ format: 'sterling-evidence/1', release: '0.5.0', files: [] }, null, 2)}\n`);
  signBlob(MANIFEST, file('release.key'));
  writeFileSync(file('ed25519.pub'), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
});

const pem = (name) => readFileSync(file(name), 'utf8');
const node = (content, bundle, key) => verifySigstoreBundle(content, bundle, pem(key));
/** cosign verify-blob over a content and bundle written to fresh files. */
function cosign(content, bundle, key) {
  const dir = mkdtempSync(path.join(DIR, 'case-'));
  writeFileSync(path.join(dir, 'content'), content);
  writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  return verifyBlob(path.join(dir, 'content'), path.join(dir, 'bundle.json'), file(key));
}

test('accept: a manifest signed by the pinned cosign verifies with cosign and with verifySigstoreBundle', () => {
  const content = readFileSync(MANIFEST);
  const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  assert.equal(cosign(content, bundle, 'release.pub').ok, true);
  assert.deepEqual(node(content, bundle, 'release.pub'), { ok: true });
  // The public key hint cosign writes is the base64 SHA-256 of the key's DER SubjectPublicKeyInfo: publicKeyFingerprint in hex.
  assert.equal(Buffer.from(bundle.verificationMaterial.publicKey.hint, 'base64').toString('hex'), publicKeyFingerprint(pem('release.pub')));
});

test('refuse: a changed byte, another key, a changed signature and a changed digest are refused by both; an Ed25519 key by the verifier', () => {
  const content = readFileSync(MANIFEST);
  const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  const changedByte = Buffer.from(content); changedByte[3] ^= 1;
  const signature = Buffer.from(bundle.messageSignature.signature, 'base64'); signature[signature.length - 2] ^= 1;
  const changedSignature = structuredClone(bundle); changedSignature.messageSignature.signature = signature.toString('base64');
  const digest = Buffer.from(bundle.messageSignature.messageDigest.digest, 'base64'); digest[0] ^= 1;
  const changedDigest = structuredClone(bundle); changedDigest.messageSignature.messageDigest.digest = digest.toString('base64');
  const cases = [
    ['a changed byte', changedByte, bundle, 'release.pub', 'digest'],
    ['another key', content, bundle, 'other.pub', 'signature'],
    ['a changed signature', content, changedSignature, 'release.pub', 'signature'],
    ['a changed message digest', content, changedDigest, 'release.pub', 'digest'],
  ];
  for (const [what, data, signed, key, reason] of cases) {
    assert.equal(cosign(data, signed, key).ok, false, `cosign refuses ${what}`);
    assert.deepEqual(node(data, signed, key), { ok: false, reason }, `the verifier refuses ${what}`);
  }
  assert.deepEqual(node(content, bundle, 'ed25519.pub'), { ok: false, reason: 'key-type' });
  assert.deepEqual(verifySigstoreBundle(content, { ...bundle, verificationMaterial: { certificate: { rawBytes: 'AA==' } } }, pem('release.pub')), { ok: false, reason: 'not-key-mode' });
  assert.deepEqual(verifySigstoreBundle(content, 'not a bundle', pem('release.pub')), { ok: false, reason: 'bundle-format' });
});
