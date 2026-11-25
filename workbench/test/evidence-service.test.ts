// Phase 48.2, plan 01 (D-01, D-11, D-18): the backend evidence service reads a release evidence folder, checks every file against its
// sterling-evidence/1 manifest, and re-judges the judgement with the one status engine (engine/compliance.cjs) against the current time.
// With no trust key configured the release is Not verified; one changed byte makes it Did not verify and nothing from it is shown.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createEvidenceService, readEvidenceSettings } from '../extension/src/node/sterling-evidence-service.ts';

// Bundled to workbench/dist/test/; scripts/build.mjs builds engine/compliance.cjs first.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineFile = path.join(workbenchRoot, 'engine', 'compliance.cjs');
const engine = createRequire(engineFile)(engineFile) as {
  JUDGEMENT_FORMAT: string;
  EVIDENCE_FORMAT: string;
  judgementRow(input: unknown, presentation: unknown): unknown;
};

const COMMIT = 'a'.repeat(40);
const BUILT_AT = '2026-11-25T10:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => Date.parse(BUILT_AT) + hours * HOUR;

/** One row with one component whose single statement has one rule and its result. */
function row(control: string, label: string, title: string, window: 'head' | 'audit') {
  const statement = `${control}_smt`;
  const rule = { id: `release.${control}.check`, component: 'workbench', control, statement, kind: 'test', test: { file: `workbench/test/${control}.test.ts`, path: [], name: control } };
  const result = { rule: rule.id, passed: true, reason: 'met', collectedAt: BUILT_AT, commit: COMMIT, window };
  return engine.judgementRow(
    { level: 'unclassified', control, claim: true, responsibility: 'product', components: [{ control, component: 'workbench', level: 'unclassified', responsibility: 'product', statements: [{ id: statement, description: `The workbench supports ${label}.` }], rulesByStatement: { [statement]: [rule] }, results: { [rule.id]: result } }] },
    { label, family: control.split('-')[0], title });
}

/** A release evidence folder: the judgement inside bundle/, a small SBOM and any `extra` files, and the manifest over all of them. */
function releaseFolder(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-release-evidence-'));
  const judgement = {
    format: engine.JUDGEMENT_FORMAT, generatedAt: BUILT_AT, commit: COMMIT, head: COMMIT,
    levels: [{ id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'profiles/unclassified.json', claim: true, components: ['workbench'], overlays: [] }],
    rows: [row('cm-08', 'CM-8', 'System component inventory', 'head'), row('au-06', 'AU-6', 'Audit record review, analysis, and reporting', 'audit')],
  };
  const files: Record<string, string> = {
    'bundle/dashboard/judgement.json': `${JSON.stringify(judgement, null, 2)}\n`,
    'sbom/sterling-image.cdx.json': '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}\n',
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const manifest = {
    format: engine.EVIDENCE_FORMAT, release: '0.5.0', commit: COMMIT, builtAt: BUILT_AT, subject: `sha256:${'c'.repeat(64)}`, bundle: 'included', package: 'none',
    files: Object.entries(files).map(([name, content]) => ({ path: name, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** The service over a release folder with no trust folder mounted (no key configured). */
function service(releaseDir: string, clock: { now: number }) {
  const trustDir = path.join(tmpdir(), `sterling-no-trust-${process.pid}`);
  return createEvidenceService({ settings: { releaseDir, trustDir }, appRoot: workbenchRoot, now: () => clock.now });
}

test('service: a release folder with no trust key configured is Not verified, its rows re-judged with the injected clock', async () => {
  const clock = { now: at(1) };
  const evidence = await service(releaseFolder(), clock).getEvidence();
  const release = evidence.release;
  assert.equal(release.verification, 'not-verified');
  assert.ok(release.verification === 'not-verified');
  assert.equal(release.reason, 'no-trust-key');
  assert.equal(release.version, '0.5.0');
  assert.equal(release.asOf, BUILT_AT);
  assert.equal(evidence.judgedAt, new Date(clock.now).toISOString());
  assert.deepEqual(release.rows.map((item) => [item.control, item.state, item.source, item.asOf, item.freshness]), [
    ['cm-08', 'met', 'release', BUILT_AT, 'current'],
    ['au-06', 'met', 'release', BUILT_AT, 'current'],
  ]);
  assert.deepEqual(release.levels, [{ id: 'unclassified', title: 'Unclassified', claim: true }]);
});

test('now: 25 hours after the audit result, that row reads Stale on the next call; the head-window row stays as it was', async () => {
  const clock = { now: at(1) };
  const reader = service(releaseFolder(), clock);
  const before = await reader.getEvidence();
  clock.now = at(25);
  const after = await reader.getEvidence();
  assert.ok(before.release.verification === 'not-verified' && after.release.verification === 'not-verified');
  const byControl = (rows: typeof after.release.rows) => Object.fromEntries(rows.map((item) => [item.control, item]));
  assert.equal(byControl(before.release.rows)['au-06']!.state, 'met');
  assert.equal(byControl(after.release.rows)['au-06']!.state, 'stale');
  assert.equal(byControl(after.release.rows)['au-06']!.freshness, 'out-of-date');
  assert.deepEqual(byControl(after.release.rows)['cm-08'], byControl(before.release.rows)['cm-08']);
});

test('changed byte: one changed byte gives Did not verify, naming the file, and no rows', async () => {
  const dir = releaseFolder();
  const file = path.join(dir, 'sbom/sterling-image.cdx.json');
  const bytes = readFileSync(file);
  bytes[2] = bytes[2]! ^ 1;
  writeFileSync(file, bytes);
  const evidence = await service(dir, { now: at(1) }).getEvidence();
  assert.deepEqual(evidence.release, { verification: 'did-not-verify', reason: 'hash', file: 'sbom/sterling-image.cdx.json' });
});

test('absent: no release evidence folder gives none', async () => {
  const evidence = await service(path.join(tmpdir(), `sterling-no-evidence-${process.pid}-${Date.now()}`), { now: at(1) }).getEvidence();
  assert.deepEqual(evidence.release, { verification: 'none' });
});

test('plain data: getEvidence() survives JSON unchanged, as it crosses JSON-RPC', async () => {
  for (const dir of [releaseFolder(), path.join(tmpdir(), `sterling-no-evidence-${process.pid}-${Date.now()}`)]) {
    const evidence = await service(dir, { now: at(30) }).getEvidence();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(evidence)), evidence);
  }
});

// ---- 48.2-04 (D-06, D-14, D-17, D-18, D-19): anchors from configuration only, the three outcomes, the clock case, re-verification ----

const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherSigner = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();
const SITE_KEY = pem(signer.publicKey);
const OTHER_KEY = pem(otherSigner.publicKey);

/** A cosign key-mode Sigstore bundle over `content`, the shape cosign 3.1.4 sign-blob writes (deploy/test/sigstore-parity.test.mjs). */
function sigstoreBundle(content: Buffer, key = signer) {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { publicKey: { hint: createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') } },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest: createHash('sha256').update(content).digest('base64') }, signature: sign('sha256', content, key.privateKey).toString('base64') },
  };
}

/** A trust folder as configuration mounts it: the anchors and, for release 0.5.0, the signature over `manifest`. */
function trustFolder(files: { organization?: string; supplier?: string; signature?: unknown }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-evidence-trust-'));
  if (files.organization !== undefined) writeFileSync(path.join(dir, 'organization.pub'), files.organization);
  if (files.supplier !== undefined) writeFileSync(path.join(dir, 'supplier.pub'), files.supplier);
  if (files.signature !== undefined) writeFileSync(path.join(dir, 'release-0.5.0.sigstore.json'), JSON.stringify(files.signature));
  return dir;
}

const manifestOf = (dir: string) => readFileSync(path.join(dir, 'manifest.json'));

function trusted(releaseDir: string, trustDir: string, clock: { now: number }, organizationPublicKey?: string) {
  return createEvidenceService({ settings: { releaseDir, trustDir, ...(organizationPublicKey ? { organizationPublicKey } : {}) }, appRoot: workbenchRoot, now: () => clock.now });
}

test('supplier anchor: a manifest signed by the mounted supplier release key is Verified, anchor supplier', async () => {
  const dir = releaseFolder();
  const evidence = await trusted(dir, trustFolder({ supplier: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }).getEvidence();
  assert.ok(evidence.release.verification === 'verified');
  assert.equal(evidence.release.anchor, 'supplier');
  assert.ok(evidence.release.rows.every((item) => item.verification === 'verified'));
});

test('verified: organization.pub equal to the site key in STERLING_ORGANIZATION_PUBLIC_KEY and the matching signature give Verified', async () => {
  const dir = releaseFolder();
  const evidence = await trusted(dir, trustFolder({ organization: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }, SITE_KEY).getEvidence();
  assert.ok(evidence.release.verification === 'verified');
  assert.equal(evidence.release.anchor, 'organization');
  assert.deepEqual(evidence.release.rows.map((item) => [item.control, item.state, item.verification]), [['cm-08', 'met', 'verified'], ['au-06', 'met', 'verified']]);
});

test('anchor mismatch: organization.pub that is not the site key is Did not verify, even when the signature verifies with it', async () => {
  const dir = releaseFolder();
  const evidence = await trusted(dir, trustFolder({ organization: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }, OTHER_KEY).getEvidence();
  assert.deepEqual(evidence.release, { verification: 'did-not-verify', reason: 'anchor-mismatch', file: 'organization.pub' });
});

test('anchor unconfirmed: organization.pub with no site key in the environment is Not verified; a malformed site key stops the start check', async () => {
  const dir = releaseFolder();
  const evidence = await trusted(dir, trustFolder({ organization: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }).getEvidence();
  assert.ok(evidence.release.verification === 'not-verified');
  assert.equal(evidence.release.reason, 'anchor-unconfirmed');
  assert.ok(evidence.release.rows.length > 0 && evidence.release.rows.every((item) => item.verification === 'not-verified'));
  const ed25519 = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  for (const bad of ['not a key', ed25519, `${SITE_KEY}${OTHER_KEY}`]) {
    assert.throws(() => readEvidenceSettings({ STERLING_ORGANIZATION_PUBLIC_KEY: bad }), /^Error: STERLING_ORGANIZATION_PUBLIC_KEY must be/);
  }
  assert.deepEqual(readEvidenceSettings({ STERLING_ORGANIZATION_PUBLIC_KEY: SITE_KEY, STERLING_EVIDENCE_DIR: '/run/evidence' }),
    { releaseDir: '/opt/sterling/evidence', trustDir: '/run/evidence', organizationPublicKey: SITE_KEY });
  assert.deepEqual(readEvidenceSettings({}), { releaseDir: '/opt/sterling/evidence', trustDir: '/etc/sterling/evidence' });
});

test('not verified: no key file is no-trust-key; a key but no signature for this release is no-signature; content shown, never verified', async () => {
  const dir = releaseFolder();
  for (const [trustDir, reason] of [[trustFolder({}), 'no-trust-key'], [trustFolder({ supplier: SITE_KEY }), 'no-signature']] as const) {
    const evidence = await trusted(dir, trustDir, { now: at(1) }).getEvidence();
    assert.ok(evidence.release.verification === 'not-verified');
    assert.equal(evidence.release.reason, reason);
    assert.equal(evidence.release.rows.length, 2);
    assert.ok(evidence.release.rows.every((item) => item.verification === 'not-verified'));
  }
});

{
  const signed = (dir: string) => trustFolder({ supplier: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) });
  const rewrite = (dir: string, change: (manifest: any) => void) => {
    const manifest = JSON.parse(manifestOf(dir).toString('utf8')); change(manifest);
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const cases: [string, (dir: string) => string, string, string][] = [
    ['missing file', (dir) => { rmSync(path.join(dir, 'sbom/sterling-image.cdx.json')); return signed(dir); }, 'missing', 'sbom/sterling-image.cdx.json'],
    ['extra file', (dir) => { writeFileSync(path.join(dir, 'sbom/extra.json'), '{}'); return signed(dir); }, 'extra', 'sbom/extra.json'],
    ['symlink', (dir) => { symlinkSync('/etc/hostname', path.join(dir, 'sbom/link.json')); return signed(dir); }, 'symlink', 'sbom/link.json'],
    ['size mismatch', (dir) => { rewrite(dir, (manifest) => { manifest.files[1].size += 1; }); return signed(dir); }, 'size', 'sbom/sterling-image.cdx.json'],
    ['hash mismatch', (dir) => { writeFileSync(path.join(dir, 'sbom/sterling-image.cdx.json'), '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[1]}'); return signed(dir); }, 'hash', 'sbom/sterling-image.cdx.json'],
    ['bad signature', (dir) => { const bundle = sigstoreBundle(manifestOf(dir)); const bytes = Buffer.from(bundle.messageSignature.signature, 'base64'); bytes[bytes.length - 2]! ^= 1; bundle.messageSignature.signature = bytes.toString('base64'); return trustFolder({ supplier: SITE_KEY, signature: bundle }); }, 'signature', 'release-0.5.0.sigstore.json'],
    ['a signature for another manifest', () => trustFolder({ supplier: SITE_KEY, signature: sigstoreBundle(Buffer.from('another manifest')) }), 'other-manifest', 'release-0.5.0.sigstore.json'],
    ['unknown manifest format', (dir) => { rewrite(dir, (manifest) => { manifest.format = 'sterling-evidence/2'; }); return signed(dir); }, 'format', 'manifest.json'],
  ];
  // One case per cause: each gives its own reason and no rows.
  for (const [what, prepare, reason, file] of cases) {
    test(`did not verify: ${what} gives ${reason} and no rows`, async () => {
      const dir = releaseFolder();
      const trustDir = prepare(dir);
      const evidence = await trusted(dir, trustDir, { now: at(1) }).getEvidence();
      assert.deepEqual(evidence.release, { verification: 'did-not-verify', reason, file }, what);
    });
  }
}

test('clock case: a release build time ahead of the clock keeps the verification, shows the rows, freshness Unknown and nothing Met', async () => {
  const dir = releaseFolder();
  const evidence = await trusted(dir, trustFolder({ supplier: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(-1) }).getEvidence();
  assert.ok(evidence.release.verification === 'verified');
  assert.equal(evidence.release.clock, 'clock-behind-build');
  assert.equal(evidence.release.rows.length, 2);
  assert.ok(evidence.release.rows.every((item) => item.freshness === 'unknown' && item.state !== 'met'));
});

test('no anchor from the evidence: keys inside the release evidence folder are never used', async () => {
  const dir = releaseFolder({ 'supplier.pub': SITE_KEY, 'organization.pub': SITE_KEY });
  const evidence = await trusted(dir, trustFolder({ signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }, SITE_KEY).getEvidence();
  assert.ok(evidence.release.verification === 'not-verified');
  assert.equal(evidence.release.reason, 'no-trust-key');
});

test('offline: the service makes no network call', async (context) => {
  const calls: unknown[] = [];
  context.mock.method(globalThis, 'fetch', async (...args: unknown[]) => { calls.push(args); throw new Error('the evidence service must not fetch'); });
  const dir = releaseFolder();
  await trusted(dir, trustFolder({ organization: SITE_KEY, signature: sigstoreBundle(manifestOf(dir)) }), { now: at(1) }, SITE_KEY).getEvidence();
  await trusted(dir, trustFolder({}), { now: at(1) }).getEvidence();
  assert.deepEqual(calls, []);
});

test('re-verify: a delivered signature verifies within one 30-second check, a replaced site key does not verify, the image folder is read once', async () => {
  const dir = releaseFolder();
  const trustDir = trustFolder({ organization: SITE_KEY });
  const clock = { now: at(1) };
  const reader = trusted(dir, trustDir, clock, SITE_KEY);
  const first = await reader.getEvidence();
  assert.ok(first.release.verification === 'not-verified' && first.release.reason === 'no-signature');
  assert.equal(first.release.checkedAt, new Date(at(1)).toISOString(), 'as of: the time it was last verified');
  writeFileSync(path.join(trustDir, 'release-0.5.0.sigstore.json'), JSON.stringify(sigstoreBundle(manifestOf(dir))));
  clock.now += 10_000;
  assert.equal((await reader.getEvidence()).release.verification, 'not-verified', 'not before the next check');
  clock.now += 20_000;
  const second = await reader.getEvidence();
  assert.ok(second.release.verification === 'verified');
  assert.equal(second.release.checkedAt, new Date(clock.now).toISOString());
  // The image is read-only: a byte changed in the release folder after start is not read again.
  writeFileSync(path.join(dir, 'sbom/sterling-image.cdx.json'), 'changed');
  clock.now += 30_000;
  const unchanged = await reader.getEvidence();
  assert.ok(unchanged.release.verification === 'verified');
  assert.equal(unchanged.release.checkedAt, second.release.checkedAt, 'unchanged trust files keep the time they were verified');
  writeFileSync(path.join(trustDir, 'organization.pub'), OTHER_KEY);
  clock.now += 30_000;
  assert.deepEqual((await reader.getEvidence()).release, { verification: 'did-not-verify', reason: 'anchor-mismatch', file: 'organization.pub' });
});
