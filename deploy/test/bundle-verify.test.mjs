// The refusal rules of the offline bundle (D-48) and of every signed file (D-49), proven offline with a throwaway cosign key: nothing is
// loaded unless the manifest signature, the archive digest and every item digest verify. The store listing is injected (no hauler, no
// registry) and the import's copy step is a spy that must never run on a refused bundle. Needs the pinned cosign ($COSIGN or PATH); fails,
// never skips, without it. Run: env COSIGN=compliance/out/tools/cosign node scripts/run-tests.mjs deploy/test/bundle-verify.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { checkBundle } from '../bundle/check.mjs';
import { importBundle } from '../bundle/import.mjs';
import { cosignBinary } from '../bundle/lib/cosign.mjs';
import { UNPUBLISHED_DIGEST } from '../bundle/lib/locks.mjs';
import { ARCHIVE, FORMAT, MANIFEST, sha256File, writeManifest } from '../bundle/lib/manifest.mjs';
import { signFile, verifySignedFile } from '../bundle/signed-file.mjs';

process.env.COSIGN_PASSWORD = 'bundle-verify-test';
const KEYS = mkdtempSync(path.join(tmpdir(), 'bundle-keys-'));
const key = (prefix) => ({ private: path.join(KEYS, `${prefix}.key`), public: path.join(KEYS, `${prefix}.pub`) });
const ORG = key('organization');
const OTHER = key('other');

before(() => {
  for (const prefix of ['organization', 'other']) {
    const run = spawnSync(cosignBinary(), ['generate-key-pair', '--output-key-prefix', prefix], { cwd: KEYS, encoding: 'utf8' });
    assert.ok(!run.error, `cosign was not found (${cosignBinary()}); set COSIGN to the pinned cosign (sh compliance/ci/install-tool.sh cosign compliance/out/tools).`);
    assert.equal(run.status, 0, run.stderr);
  }
});

const digestOf = (text) => `sha256:${Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const IMAGE = { kind: 'image', name: 'jetstack/cert-manager-controller', digest: digestOf('image') };
const CHART = { kind: 'chart', name: 'cert-manager-v1.21.3.tgz', digest: digestOf('chart') };

/** A bundle folder with a stand-in archive and a signed manifest; returns { dir, items }. */
async function bundle({ items = [IMAGE, CHART], signWith = ORG, manifest = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bundle-'));
  writeFileSync(path.join(dir, ARCHIVE), 'stand-in for the hauler store archive');
  writeManifest(path.join(dir, MANIFEST), { version: '0.0.1', created: '2026-11-24T00:00:00.000Z', archive: { file: ARCHIVE, sha256: await sha256File(path.join(dir, ARCHIVE)) }, items, omitted: [], ...manifest });
  signFile(path.join(dir, MANIFEST), signWith.private);
  return { dir, items };
}

/** The store listing as the store reports it: charts and tools are files there. */
const asStored = (items) => items.map((item) => ({ kind: item.kind === 'image' ? 'image' : 'file', name: item.name, digest: item.digest }));

/** Runs the import with a spy copy step; returns { result, loads }. */
async function importWithSpy(dir, { listed, publicKey = ORG.public } = {}) {
  let loads = 0;
  const result = await importBundle({ dir, publicKey, registry: 'registry.site.example', out: path.join(dir, 'out'), listStore: async () => listed, load: async () => { loads += 1; } });
  return { result, loads };
}

test('a correctly signed bundle passes and the copy step runs exactly once', async () => {
  const { dir, items } = await bundle({ items: [CHART] });
  const checked = await checkBundle({ dir, publicKey: ORG.public, listStore: async () => asStored(items) });
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(loads, 1);
});

test('a manifest changed after signing is refused and nothing is copied', async () => {
  const { dir, items } = await bundle();
  const file = path.join(dir, MANIFEST);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"0.0.1"', '"0.0.2"'));
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /the manifest signature does not verify/);
  assert.equal(loads, 0);
});

test('a manifest signed with a different key is refused', async () => {
  const { dir, items } = await bundle({ signWith: OTHER });
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /the manifest signature does not verify/);
  assert.equal(loads, 0);
});

test('an archive whose SHA-256 differs from the signed manifest is refused', async () => {
  const { dir, items } = await bundle();
  writeFileSync(path.join(dir, ARCHIVE), 'a different archive');
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /the archive store\.tar\.zst has digest sha256:[0-9a-f]{64}, not sha256:/);
  assert.equal(loads, 0);
});

test('a store item that is missing, extra or has another digest is refused', async () => {
  const { dir, items } = await bundle();
  const stored = asStored(items);
  const cases = [
    [stored.slice(1), /image jetstack\/cert-manager-controller is in the manifest but not in the store/],
    [[...stored, { kind: 'file', name: 'extra.bin', digest: digestOf('extra') }], /file extra\.bin is in the store but not in the manifest/],
    [[{ ...stored[0], digest: digestOf('swapped') }, stored[1]], /image jetstack\/cert-manager-controller has digest sha256:[0-9a-f]{64} in the store, not/]
  ];
  for (const [listed, pattern] of cases) {
    const { result, loads } = await importWithSpy(dir, { listed });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), pattern);
    assert.equal(loads, 0);
  }
});

test('an item carrying the reserved unpublished digest is refused even when signed', async () => {
  const unpublished = { kind: 'image', name: 'sterling/sterling-workbench', digest: UNPUBLISHED_DIGEST };
  const { dir, items } = await bundle({ items: [IMAGE, unpublished] });
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /sterling\/sterling-workbench carries the reserved unpublished digest/);
  assert.equal(loads, 0);
});

test('a manifest of another format is refused', async () => {
  const { dir, items } = await bundle({ manifest: { format: 'sterling-bundle/0' } });
  const { result, loads } = await importWithSpy(dir, { listed: asStored(items) });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], new RegExp(`format is "sterling-bundle/0", not ${FORMAT.replace('/', '\\/')}`));
  assert.equal(loads, 0);
});

test('a signed file changed after signing is refused by verifySignedFile (revocation lists, user exports, intermediates)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signed-file-'));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'revocations.json');
  writeFileSync(file, JSON.stringify({ revoked: ['credential-1'] }));
  signFile(file, ORG.private);
  assert.deepEqual(verifySignedFile(file, ORG.public), { ok: true, reason: '' });
  assert.equal(verifySignedFile(file, OTHER.public).ok, false);
  writeFileSync(file, JSON.stringify({ revoked: [] }));
  const changed = verifySignedFile(file, ORG.public);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /revocations\.json: the signature does not verify/);
  const unsigned = path.join(dir, 'intermediate.pem');
  writeFileSync(unsigned, 'not signed');
  assert.match(verifySignedFile(unsigned, ORG.public).reason, /has no signature/);
});
