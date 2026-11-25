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
import net from 'node:net';
import { attachLiveSignature, buildLiveFeed, liveSigningInput, makeTrustDocument } from '../../compliance/src/siteEvidence.ts';
import type { EvidenceRow, EvidenceSnapshot } from '../extension/src/common/compliance-evidence.ts';
import { fixtureBundle, fixtureKey } from './helpers/sigstore-fixture';

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

/** A release evidence folder: the judgement inside bundle/ (with any `extraRows`), a small SBOM and any `extra` files, and the manifest over all of them. */
function releaseFolder(extra: Record<string, string> = {}, extraRows: unknown[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-release-evidence-'));
  const judgement = {
    format: engine.JUDGEMENT_FORMAT, generatedAt: BUILT_AT, commit: COMMIT, head: COMMIT,
    levels: [{ id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'profiles/unclassified.json', claim: true, components: ['workbench'], overlays: [] }],
    rows: [row('cm-08', 'CM-8', 'System component inventory', 'head'), row('au-06', 'AU-6', 'Audit record review, analysis, and reporting', 'audit'), ...extraRows],
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

const signer = fixtureKey();
const otherSigner = fixtureKey();
const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();
const SITE_KEY = pem(signer.publicKey);
const OTHER_KEY = pem(otherSigner.publicKey);

/** A cosign key-mode Sigstore bundle over `content` (test/helpers/sigstore-fixture.ts, held equal to the pinned cosign by deploy/test/sigstore-parity.test.mjs). */
const sigstoreBundle = (content: Buffer, key = signer) => fixtureBundle(content, key);

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

// ---- 48.2-08 (D-01, D-04, D-13, D-14, D-22, D-24, D-25, D-26): the live site layer ----

/** Timers the test drives: nothing runs unless advance() is called, and dispose() must leave none behind. */
class FakeTimers {
  private readonly tasks = new Map<number, { at: number; every?: number; fn: () => unknown }>();
  private next = 0;
  private readonly clock: { now: number };
  constructor(clock: { now: number }) { this.clock = clock; }
  setInterval = (fn: () => unknown, ms: number): number => { this.tasks.set(++this.next, { at: this.clock.now + ms, every: ms, fn }); return this.next; };
  setTimeout = (fn: () => unknown, ms: number): number => { this.tasks.set(++this.next, { at: this.clock.now + ms, fn }); return this.next; };
  clearInterval = (id: unknown): void => { this.tasks.delete(id as number); };
  clearTimeout = (id: unknown): void => { this.tasks.delete(id as number); };
  get pending(): number { return this.tasks.size; }
  /** Moves the clock forward, running every task that falls due, in time order, and waiting for each. */
  async advance(ms: number): Promise<void> {
    const end = this.clock.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.clock.now = task.at;
      if (task.every) task.at += task.every; else this.tasks.delete(id);
      await task.fn();
    }
    this.clock.now = end;
  }
}

const MINUTE = 60_000;
const collectorKey = generateKeyPairSync('ed25519');
const strangerKey = generateKeyPairSync('ed25519');
const rawKey = (key: KeyObject) => (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');

/** A row whose one statement is proven by observation rules, each with a release result (the supplier's reference site or the release scan). */
function observationRow(control: string, label: string, rules: { id: string; collector: string; subject: string; window: string; collectedAt: string }[]) {
  const statement = `${control}_smt`;
  const ruleObjects = rules.map(({ id, collector, subject }) => ({ id, component: 'workbench', control, statement, kind: 'observation', observation: { collector, subject } }));
  const results = Object.fromEntries(rules.map(({ id, window, collectedAt }) => [id, { rule: id, passed: true, reason: 'met', collectedAt, window }]));
  return engine.judgementRow(
    { level: 'unclassified', control, claim: true, responsibility: 'product', components: [{ control, component: 'workbench', level: 'unclassified', responsibility: 'product', statements: [{ id: statement, description: `The site supports ${label}.` }], rulesByStatement: { [statement]: ruleObjects }, results }] },
    { label, family: control.split('-')[0], title: label });
}
const SITE_ROW = () => observationRow('au-05', 'AU-5', [
  { id: 'site.au-05.openbao', collector: 'site-live', subject: 'openbao-sealed', window: 'live', collectedAt: BUILT_AT },
  { id: 'site.au-05.nodes', collector: 'site-live', subject: 'nodes', window: 'live', collectedAt: BUILT_AT },
]);
const SCAN_ROW = (collectedAt: string) => observationRow('ra-05', 'RA-5', [{ id: 'release.ra-05.scan', collector: 'image-scan', subject: 'sterling-image', window: 'vulnerability', collectedAt }]);

/** The trust document your site key signs, valid around `now`, naming the collector's key version 1. */
function trustDocument(now: number, freshness?: unknown) {
  return makeTrustDocument({
    site: 'site-a', issuedAt: new Date(now - HOUR).toISOString(), notBefore: new Date(now - 24 * HOUR).toISOString(), notAfter: new Date(now + 300 * 24 * HOUR).toISOString(), now: new Date(now),
    collectorKeys: [{ version: 1, publicKey: rawKey(collectorKey.publicKey) }], operatorKeys: [], ...(freshness ? { freshness } : {}),
  });
}
/** A live feed signed with `key` at key version 1. */
function liveFeed(generatedAt: number, groups: Record<string, unknown>, key = collectorKey) {
  const payload = buildLiveFeed({ site: 'site-a', generatedAt: new Date(generatedAt).toISOString(), keyVersion: 1, groups: groups as never });
  const { unsigned, bytes } = liveSigningInput(payload, rawKey(key.publicKey));
  return attachLiveSignature(unsigned, sign(null, bytes, key.privateKey));
}
const openbao = (collectedAt: number) => ({ collectedAt: new Date(collectedAt).toISOString(), sealed: false, type: 'pkcs11' });
const nodes = (collectedAt: number) => ({ collectedAt: new Date(collectedAt).toISOString(), count: 3 });

/** Writes (or, with null, removes) the site files of the projected evidence mount. */
function writeSite(dir: string, files: { trust?: unknown | null; live?: unknown | null }) {
  const put = (name: string, content: string | null) => { if (content === null) rmSync(path.join(dir, name), { force: true }); else writeFileSync(path.join(dir, name), content); };
  if (files.trust !== undefined) {
    const document = files.trust === null ? null : `${JSON.stringify(files.trust, null, 2)}\n`;
    put('trust.json', document);
    put('trust.json.sigstore.json', document === null ? null : JSON.stringify(sigstoreBundle(Buffer.from(document))));
  }
  if (files.live !== undefined) put('live.json', files.live === null ? null : JSON.stringify(files.live));
}

/** A site session: a verified release (your organization's site key), its mount, fake timers, started. */
function siteSession(options: { start?: number; extraRows?: unknown[]; projectionDir?: string } = {}) {
  const clock = { now: options.start ?? at(1) };
  const releaseDir = releaseFolder({}, options.extraRows ?? [SITE_ROW()]);
  const trustDir = trustFolder({ organization: SITE_KEY, signature: sigstoreBundle(manifestOf(releaseDir)) });
  const timers = new FakeTimers(clock);
  const reader = createEvidenceService({ settings: { releaseDir, trustDir, organizationPublicKey: SITE_KEY }, appRoot: workbenchRoot, now: () => clock.now, timers,
    projectionDir: options.projectionDir ?? path.join(tmpdir(), `sterling-no-projection-${process.pid}`) });
  reader.start();
  return { clock, releaseDir, trustDir, timers, reader };
}
const cell = (snapshot: EvidenceSnapshot, control: string): EvidenceRow => {
  const release = snapshot.release;
  assert.ok(release.verification === 'verified' || release.verification === 'not-verified', `release layer ${release.verification}`);
  return release.rows.find((item) => item.control === control)!;
};
const evidenceOf = (item: EvidenceRow) => item.components.flatMap(({ evidence }) => evidence);

test('live: a site file landing in the mount reaches a waiting view within one 30-second check, verified, layered and re-judged', async () => {
  const { clock, trustDir, timers, reader } = siteSession();
  const first = await reader.getEvidence();
  assert.equal(first.site.verification, 'none');
  const waiting = reader.waitForEvidence(first.revision);
  const collected = clock.now - 5 * MINUTE;
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now - MINUTE, { openbao: openbao(collected), nodes: nodes(collected) }) });
  await timers.advance(30_000);
  const next = await waiting;
  assert.equal(next.revision, first.revision + 1);
  assert.equal(next.site.verification, 'verified');
  const row = cell(next, 'au-05');
  assert.ok(row.sources.includes('site'));
  assert.deepEqual(evidenceOf(row).map(({ rule, source, collectedAt, freshness }) => [rule, source, collectedAt, freshness]), [
    ['site.au-05.openbao', 'site', new Date(collected).toISOString(), 'current'], ['site.au-05.nodes', 'site', new Date(collected).toISOString(), 'current'],
  ]);
  assert.equal(row.asOf, new Date(collected).toISOString());
  assert.equal(row.freshness, 'current');
  assert.equal(row.verification, 'verified');
  reader.dispose();
  assert.equal(timers.pending, 0, 'no timer left running');
});

test('check phase: a read asked for between two checks does not push the next check back; the file is read at the next 30-second tick', async () => {
  // Found by the browser check (48.2-16): the page's first read lands between ticks, and the tick after it was skipped as "not due".
  const { clock, trustDir, timers, reader } = siteSession();
  await timers.advance(5_000);
  assert.equal((await reader.getEvidence()).site.verification, 'none');
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now - MINUTE, { openbao: openbao(clock.now), nodes: nodes(clock.now) }) });
  await timers.advance(25_000);
  assert.equal((await reader.getEvidence()).site.verification, 'verified', 'read at the tick 25 seconds after the file landed');
  reader.dispose();
});

test('timeout: with no change, waitForEvidence resolves after 55 seconds with the same revision', async () => {
  const { timers, reader } = siteSession();
  const first = await reader.getEvidence();
  const waiting = reader.waitForEvidence(first.revision);
  await timers.advance(54_000);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting at 54 seconds');
  await timers.advance(1_000);
  assert.equal((await waiting).revision, first.revision);
  assert.equal((await reader.waitForEvidence(first.revision - 1)).revision, first.revision, 'an older revision resolves at once');
  reader.dispose();
  assert.equal(timers.pending, 0);
});

test('ages: with no file change, a live group goes current, ageing and out of date at the 60-second re-judges, each a new revision', async () => {
  const { clock, trustDir, timers, reader } = siteSession();
  const collected = clock.now;
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(collected), nodes: nodes(collected) }) });
  await timers.advance(30_000);
  const current = await reader.getEvidence();
  assert.equal(cell(current, 'au-05').freshness, 'current');
  await timers.advance(31 * MINUTE);
  const ageing = await reader.getEvidence();
  assert.equal(cell(ageing, 'au-05').freshness, 'ageing');
  assert.ok(ageing.revision > current.revision);
  await timers.advance(90 * MINUTE);
  const old = await reader.getEvidence();
  assert.equal(cell(old, 'au-05').freshness, 'out-of-date');
  assert.equal(cell(old, 'au-05').state, 'stale');
  assert.ok(old.revision > ageing.revision);
  reader.dispose();
});

test('removed: deleting live.json drops its evidence at the next check; the cell falls back to the reference site, a new revision', async () => {
  const { clock, trustDir, timers, reader } = siteSession();
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(clock.now), nodes: nodes(clock.now) }) });
  await timers.advance(30_000);
  const live = await reader.getEvidence();
  assert.ok(cell(live, 'au-05').sources.includes('site'));
  writeSite(trustDir, { live: null });
  await timers.advance(30_000);
  const removed = await reader.getEvidence();
  assert.deepEqual(evidenceOf(cell(removed, 'au-05')).map(({ source }) => source), ['reference-site', 'reference-site']);
  assert.deepEqual(cell(removed, 'au-05').sources, ['reference-site']);
  assert.ok(removed.revision > live.revision);
  reader.dispose();
});

test('unverifiable: a feed signed by an unnamed key drops its evidence and shows the reason; a changed trust byte fails the whole site layer', async () => {
  const { clock, trustDir, timers, reader } = siteSession();
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(clock.now), nodes: nodes(clock.now) }, strangerKey) });
  await timers.advance(30_000);
  const stranger = await reader.getEvidence();
  assert.deepEqual(stranger.site.files.find(({ file }) => file === 'live'), { file: 'live', verification: 'did-not-verify', reason: 'unknown-signer' });
  assert.ok(!cell(stranger, 'au-05').sources.includes('site'));
  writeSite(trustDir, { live: liveFeed(clock.now, { openbao: openbao(clock.now), nodes: nodes(clock.now) }) });
  const document = readFileSync(path.join(trustDir, 'trust.json'), 'utf8');
  writeFileSync(path.join(trustDir, 'trust.json'), document.replace('"site-a"', '"site-b"'));
  await timers.advance(30_000);
  const tampered = await reader.getEvidence();
  assert.equal(tampered.site.verification, 'did-not-verify');
  assert.equal(tampered.site.reason, 'trust-signature');
  assert.ok(!cell(tampered, 'au-05').sources.includes('site'));
  reader.dispose();
});

test('kept time: a feed rewritten with one group refreshed keeps the other group\'s original collectedAt', async () => {
  const { clock, trustDir, timers, reader } = siteSession();
  const first = clock.now - 5 * MINUTE;
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(first), nodes: nodes(first) }) });
  await timers.advance(10 * MINUTE);
  const refreshed = clock.now;
  writeSite(trustDir, { live: liveFeed(refreshed, { openbao: openbao(refreshed), nodes: nodes(first) }) });
  await timers.advance(30_000);
  const kept = await reader.getEvidence();
  assert.deepEqual(evidenceOf(cell(kept, 'au-05')).map(({ rule, collectedAt }) => [rule, collectedAt]), [
    ['site.au-05.openbao', new Date(refreshed).toISOString()], ['site.au-05.nodes', new Date(first).toISOString()],
  ]);
  reader.dispose();
});

test('policy: a verified trust document\'s 3-day vulnerability ageing makes a 4-day-old scan ageing; without it the release defaults apply', async () => {
  const start = at(1);
  const scan = SCAN_ROW(new Date(start - 4 * 24 * HOUR).toISOString());
  const session = siteSession({ start, extraRows: [SITE_ROW(), scan] });
  const before = await session.reader.getEvidence();
  assert.equal(cell(before, 'ra-05').freshness, 'current');
  assert.deepEqual(before.site.policy, { source: 'release-defaults', reason: 'no-site-policy', clamped: [] });
  writeSite(session.trustDir, { trust: trustDocument(session.clock.now, { vulnerability: { ageingAfterHours: 72, outOfDateAfterHours: 240 } }) });
  await session.timers.advance(30_000);
  const tightened = await session.reader.getEvidence();
  assert.equal(cell(tightened, 'ra-05').freshness, 'ageing');
  assert.deepEqual(tightened.site.policy, { source: 'site', clamped: [] });
  session.reader.dispose();
});

test('clock: a clock earlier than the release build shows every cell with freshness unknown and nothing Met; a future-dated group is dropped', async () => {
  const early = siteSession({ start: at(-2) });
  const snapshot = await early.reader.getEvidence();
  assert.ok(snapshot.release.verification === 'verified');
  assert.equal(snapshot.release.clock, 'clock-behind-build');
  assert.equal(snapshot.release.rows.length, 3);
  assert.ok(snapshot.release.rows.every((item) => item.state !== 'met' && (item.freshness === 'unknown' || item.freshness === 'none')));
  early.reader.dispose();
  const { clock, trustDir, timers, reader } = siteSession();
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(clock.now + 10 * MINUTE), nodes: nodes(clock.now) }) });
  await timers.advance(30_000);
  const future = await reader.getEvidence();
  assert.deepEqual(future.site.files.find(({ file }) => file === 'live'), { file: 'live', verification: 'did-not-verify', reason: 'future-dated' });
  assert.ok(!cell(future, 'au-05').sources.includes('site'));
  reader.dispose();
});

/** A published projection as compliance:refresh writes it: dashboard.json, refresh.json and any control text. */
function projectionFolder(text: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-projection-'));
  const dashboard = JSON.parse(readFileSync(path.join(workbenchRoot, '..', 'compliance/test/fixtures/dashboard/dashboard.json'), 'utf8'));
  dashboard.textIndex = Object.keys(text).map((file) => ({ catalog: 'itsg-33', family: 'ac', file }));
  writeFileSync(path.join(dir, 'dashboard.json'), JSON.stringify(dashboard));
  writeFileSync(path.join(dir, 'refresh.json'), JSON.stringify({ source: 'local bundle', commit: dashboard.commit, fetchedAt: '2026-11-24T00:00:00.000Z', manifest: 'verified', attestation: 'none' }));
  for (const [file, content] of Object.entries(text)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), content); }
  return dir;
}

test('projection: the README\'s mounted projection is its own source, Not verified, never Met; the release layer stays the default', async () => {
  const { reader } = siteSession({ projectionDir: projectionFolder() });
  const snapshot = await reader.getEvidence();
  assert.ok(snapshot.projection);
  assert.ok(snapshot.projection.verification === 'not-verified');
  assert.equal(snapshot.projection.reason, 'host-checked-not-signed');
  assert.equal(snapshot.projection.source, 'local bundle');
  assert.equal(snapshot.projection.commit, 'a'.repeat(40));
  assert.ok(snapshot.projection.rows.length > 0);
  assert.ok(snapshot.projection.rows.every((item) => item.displayState === 'not-verified' && item.verification === 'not-verified' && item.source === 'projection'));
  assert.equal(snapshot.release.verification, 'verified');
  reader.dispose();
});

test('projection only: with no release evidence the projection is shown alone, still Not verified', async () => {
  const clock = { now: at(1) };
  const reader = createEvidenceService({ settings: { releaseDir: path.join(tmpdir(), `sterling-no-release-${process.pid}`), trustDir: path.join(tmpdir(), `sterling-no-trust-${process.pid}`) },
    appRoot: workbenchRoot, now: () => clock.now, projectionDir: projectionFolder() });
  const snapshot = await reader.getEvidence();
  assert.equal(snapshot.release.verification, 'none');
  assert.equal(snapshot.projection?.verification, 'not-verified');
  reader.dispose();
});

test('applicability: with no applicability in the judgement (44.1-05 not on main), every component reads as today', async () => {
  const { reader } = siteSession();
  const snapshot = await reader.getEvidence();
  for (const item of snapshot.release.verification === 'verified' ? snapshot.release.rows : []) {
    for (const component of item.components) assert.equal(Object.hasOwn(component, 'applicability'), false, `${item.control}/${component.component}`);
  }
  reader.dispose();
});

test('offline: no fetch and no socket during start, a source check or a re-judge', async (context) => {
  const calls: string[] = [];
  context.mock.method(globalThis, 'fetch', async () => { calls.push('fetch'); throw new Error('the evidence service must not fetch'); });
  context.mock.method(net, 'connect', () => { calls.push('net.connect'); throw new Error('the evidence service must not open a socket'); });
  context.mock.method(net, 'createConnection', () => { calls.push('net.createConnection'); throw new Error('the evidence service must not open a socket'); });
  const { clock, trustDir, timers, reader } = siteSession({ projectionDir: projectionFolder() });
  await reader.getEvidence();
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(clock.now) }) });
  await timers.advance(2 * MINUTE);
  await reader.getEvidence();
  reader.dispose();
  assert.deepEqual(calls, []);
});

test('control text: only a listed, indexed text file from a source that did not fail; any other path or a traversal is refused', async () => {
  const text = '{"controls":[{"id":"ac-02","parts":[{"lang":"en","prose":"Manage accounts."}]}]}';
  const dashboard = JSON.stringify({ schemaVersion: 1, textIndex: [{ catalog: 'itsg-33', family: 'ac', file: 'text/itsg-33/ac.json' }] });
  const clock = { now: at(1) };
  const releaseDir = releaseFolder({ 'bundle/dashboard/dashboard.json': dashboard, 'bundle/dashboard/text/itsg-33/ac.json': text, 'bundle/dashboard/text/itsg-33/au.json': text });
  const trustDir = trustFolder({ supplier: SITE_KEY, signature: sigstoreBundle(manifestOf(releaseDir)) });
  const reader = createEvidenceService({ settings: { releaseDir, trustDir }, appRoot: workbenchRoot, now: () => clock.now, projectionDir: path.join(tmpdir(), `sterling-no-projection-${process.pid}`) });
  assert.deepEqual(await reader.getControlText('text/itsg-33/ac.json'), { kind: 'ready', source: 'release', text: JSON.parse(text) });
  for (const file of ['text/itsg-33/au.json', 'text/itsg-33/../../manifest.json', '../manifest.json', 'bundle/dashboard/text/itsg-33/ac.json', 'text/ITSG/ac.json']) {
    assert.deepEqual(await reader.getControlText(file), { kind: 'refused' }, file);
  }
  reader.dispose();
  const failed = releaseFolder({ 'bundle/dashboard/dashboard.json': dashboard, 'bundle/dashboard/text/itsg-33/ac.json': text });
  writeFileSync(path.join(failed, 'bundle/dashboard/text/itsg-33/ac.json'), text.replace('Manage', 'Mange'));
  const failedReader = createEvidenceService({ settings: { releaseDir: failed, trustDir }, appRoot: workbenchRoot, now: () => clock.now, projectionDir: projectionFolder({ 'text/itsg-33/ac.json': text }) });
  assert.deepEqual(await failedReader.getControlText('text/itsg-33/ac.json'), { kind: 'refused' }, 'a release that did not verify gives no text, even with a projection');
  failedReader.dispose();
  const projectionOnly = createEvidenceService({ settings: { releaseDir: path.join(tmpdir(), `sterling-no-release-${process.pid}`), trustDir }, appRoot: workbenchRoot, now: () => clock.now,
    projectionDir: projectionFolder({ 'text/itsg-33/ac.json': text }) });
  assert.deepEqual(await projectionOnly.getControlText('text/itsg-33/ac.json'), { kind: 'ready', source: 'projection', text: JSON.parse(text) });
  projectionOnly.dispose();
});

test('view facts (48.2-10): the setting, the release scan\'s database age, and your site\'s item counts and last collection', async () => {
  const single = await service(releaseFolder(), { now: at(1) }).getEvidence();
  assert.equal(single.setting, 'single-computer');
  const scanBuilt = new Date(at(-72)).toISOString();
  const withScan = releaseFolder({ 'scan/db-status.json': JSON.stringify({ schemaVersion: 'v6.1.10', built: scanBuilt, valid: true }) });
  const scanned = await service(withScan, { now: at(1) }).getEvidence();
  assert.ok(scanned.release.verification === 'not-verified');
  assert.deepEqual(scanned.release.scan, { builtAt: scanBuilt, freshness: 'current' });
  const { clock, trustDir, timers, reader } = siteSession();
  const before = await reader.getEvidence();
  assert.equal(before.setting, 'site');
  const collected = clock.now - 5 * MINUTE;
  writeSite(trustDir, { trust: trustDocument(clock.now), live: liveFeed(clock.now, { openbao: openbao(collected), nodes: nodes(collected) }) });
  await timers.advance(30_000);
  const site = (await reader.getEvidence()).site;
  assert.deepEqual([site.items, site.lastCollected, site.outOfDate, site.liveOutOfDateHours, site.site], [{ current: 2, ageing: 0, outOfDate: 0 }, new Date(collected).toISOString(), false, 2, 'site-a']);
  reader.dispose();
});
