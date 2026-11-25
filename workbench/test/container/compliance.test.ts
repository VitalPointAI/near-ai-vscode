// The Compliance view's one focused browser check (48.2-16): each case starts the image with its own evidence mounts and runs that case of
// test/e2e/compliance.spec.ts in a real browser. The fixture folders are made here: a release evidence folder (sterling-evidence/1) whose
// judgement comes from the one status engine, signed as cosign key mode signs (test/helpers/sigstore-fixture.ts, held equal to the pinned cosign
// by deploy/test/sigstore-parity.test.mjs) with throwaway keys, the site trust document and a live feed (Ed25519, as the collector signs it), and the README's published projection.
// Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts. Screenshots: COMPLIANCE_SHOTS.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { attachLiveSignature, buildLiveFeed, liveSigningInput, makeTrustDocument } from '../../../compliance/src/siteEvidence.ts';
import { freePort, removeOwn, repoRoot, runContainer, runPlaywright, testImage, waitHealthy, workbenchRoot } from '../helpers/docker';
import { fixtureKey, signFixture, type FixtureKey } from '../helpers/sigstore-fixture';

const engineFile = path.join(workbenchRoot, 'engine', 'compliance.cjs');
const engine = createRequire(engineFile)(engineFile) as { JUDGEMENT_FORMAT: string; EVIDENCE_FORMAT: string; judgementRow(input: unknown, presentation: unknown): unknown };

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const VERSION = '0.5.0';
const COMMIT = 'a'.repeat(40);
const now = Date.now();
const BUILT_AT = new Date(now - HOUR).toISOString();
const ROOT = mkdtempSync(path.join(tmpdir(), 'sterling-compliance-browser-'));

/** Makes a folder and everything in it readable by the container's user (10001): mkdtemp writes private folders. */
function readable(dir: string): string {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) readable(path.join(dir, entry.name));
    else chmodSync(path.join(dir, entry.name), 0o644);
  }
  return dir;
}
const folder = (name: string): string => { const dir = path.join(ROOT, name); mkdirSync(dir, { recursive: true }); return dir; };

// ---- The release evidence folder ----

type Rule = { id: string; kind: 'test' | 'observation'; collector?: string; subject?: string; window: string; passed?: boolean };
/** One judged row from the engine: one component, one statement, its rules and their results as the release recorded them. */
function row(level: string, control: string, label: string, title: string, rules: Rule[]) {
  const statement = `${control}_smt`;
  const ruleObjects = rules.map((rule) => ({ id: rule.id, component: 'workbench', control, statement, kind: rule.kind,
    ...(rule.kind === 'test' ? { test: { file: `workbench/test/${control}.test.ts`, path: [], name: control } } : { observation: { collector: rule.collector, subject: rule.subject } }) }));
  const results = Object.fromEntries(rules.map((rule) => [rule.id, { rule: rule.id, passed: rule.passed ?? true, reason: rule.passed === false ? (rule.kind === 'test' ? 'test-failed' : 'observation-failed') : 'met', collectedAt: BUILT_AT,
    ...(rule.kind === 'test' ? { commit: COMMIT } : {}), window: rule.window }]));
  return engine.judgementRow(
    { level, control, claim: true, responsibility: 'product', components: [{ control, component: 'workbench', level, responsibility: 'product',
      statements: [{ id: statement, description: `The workbench supports ${label}.` }], rulesByStatement: { [statement]: ruleObjects }, results }] },
    { label, family: control.split('-')[0], title });
}
const testRule = (control: string, window = 'head', passed = true): Rule => ({ id: `release.${control}.check`, kind: 'test', window, passed });

/** A release evidence folder: the judgement over two levels, a small SBOM, and the manifest over both. */
function releaseFolder(name: string): string {
  const dir = folder(name);
  const judgement = {
    format: engine.JUDGEMENT_FORMAT, generatedAt: BUILT_AT, commit: COMMIT, head: COMMIT,
    levels: [
      { id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'profiles/unclassified.json', claim: true, components: ['workbench'], overlays: [] },
      { id: 'protected-b', title: 'Protected B', kind: 'level', profile: 'profiles/protected-b.json', claim: true, components: ['workbench'], overlays: [] },
    ],
    rows: [
      row('unclassified', 'ac-02', 'AC-2', 'Account management', [testRule('ac-02')]),
      row('unclassified', 'cm-08', 'CM-8', 'System component inventory', [testRule('cm-08')]),
      row('unclassified', 'au-06', 'AU-6', 'Audit record review, analysis, and reporting', [testRule('au-06', 'audit')]),
      // Proven by your site's live facts; the release carries the supplier's reference site results until your site's arrive.
      row('unclassified', 'au-05', 'AU-5', 'Response to audit logging process failures', [
        { id: 'site.au-05.openbao', kind: 'observation', collector: 'site-live', subject: 'openbao-sealed', window: 'live' },
        { id: 'site.au-05.nodes', kind: 'observation', collector: 'site-live', subject: 'nodes', window: 'live' },
      ]),
      row('unclassified', 'si-02', 'SI-2', 'Flaw remediation', [testRule('si-02', 'head', false)]),
      row('protected-b', 'ia-02', 'IA-2', 'Identification and authentication', [testRule('ia-02')]),
      row('protected-b', 'sc-08', 'SC-8', 'Transmission confidentiality and integrity', [testRule('sc-08')]),
    ],
  };
  const files: Record<string, string> = {
    'bundle/dashboard/judgement.json': `${JSON.stringify(judgement, null, 2)}\n`,
    'sbom/sterling-image.cdx.json': '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}\n',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  const manifest = {
    format: engine.EVIDENCE_FORMAT, release: VERSION, commit: COMMIT, builtAt: BUILT_AT, subject: `sha256:${'c'.repeat(64)}`, bundle: 'included', package: 'none',
    files: Object.entries(files).map(([file, content]) => ({ path: file, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// ---- Keys and signatures: throwaway ECDSA P-256 key pairs (cosign's key type) for the supplier, your site and a stranger; Ed25519 for the collector ----

const keys = new Map<string, FixtureKey>();
const keyOf = (prefix: string): FixtureKey => {
  const key = keys.get(prefix);
  assert.ok(key, `no fixture key ${prefix}`);
  return key;
};
const publicKey = (prefix: string): string => keyOf(prefix).publicKeyPem;
/** Signs `file` with the prefix's key; the Sigstore bundle goes to `bundleFile`. */
const signWith = (prefix: string, file: string, bundleFile: string): void => { signFixture(file, keyOf(prefix), bundleFile); };
const collector = generateKeyPairSync('ed25519');
const rawKey = (key: KeyObject): string => (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');

/** The site files your site's collector and install identity write: the trust document signed by `siteKey`, and a live feed. */
function siteFiles(dir: string, siteKey: string): void {
  const trust = makeTrustDocument({
    site: 'site-a', issuedAt: new Date(now - HOUR).toISOString(), notBefore: new Date(now - 24 * HOUR).toISOString(), notAfter: new Date(now + 300 * 24 * HOUR).toISOString(),
    now: new Date(now), collectorKeys: [{ version: 1, publicKey: rawKey(collector.publicKey) }], operatorKeys: [],
  });
  writeFileSync(path.join(dir, 'trust.json'), `${JSON.stringify(trust, null, 2)}\n`);
  signWith(siteKey, path.join(dir, 'trust.json'), path.join(dir, 'trust.json.sigstore.json'));
  const collectedAt = new Date(now - 5 * MINUTE).toISOString();
  const payload = buildLiveFeed({ site: 'site-a', generatedAt: new Date(now - MINUTE).toISOString(), keyVersion: 1,
    groups: { openbao: { collectedAt, sealed: false, type: 'pkcs11' }, nodes: { collectedAt, count: 3 } } as never });
  const { unsigned, bytes } = liveSigningInput(payload, rawKey(collector.publicKey));
  writeFileSync(path.join(dir, 'live.json'), JSON.stringify(attachLiveSignature(unsigned, sign(null, bytes, collector.privateKey))));
}

let image = '';
const shots = process.env.COMPLIANCE_SHOTS?.trim();

before(async () => {
  image = await testImage();
  for (const prefix of ['supplier', 'site', 'stranger']) keys.set(prefix, fixtureKey());
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await removeOwn();
});

const EVIDENCE = '/opt/sterling/evidence';
const TRUST = '/etc/sterling/evidence';
const bind = (source: string, target: string): string[] => ['--mount', `type=bind,source=${source},target=${target},readonly`];

/** Starts the image for one case with its mounts and environment, then runs that case of the spec. */
async function runCase(name: string, testName: string, mounts: string[], env: string[] = [], specEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const port = await freePort();
  for (let index = 1; index < mounts.length; index += 2) readable(/source=([^,]+),/.exec(mounts[index]!)![1]!);
  const started = await runContainer(name, ['-d', '-p', `127.0.0.1:${port}:3000`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept',
    ...env, ...mounts, image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(name, url);
  const result = await runPlaywright('compliance.spec.ts', { WORKBENCH_URL: url, ...(shots ? { COMPLIANCE_SHOTS: shots } : {}), ...specEnv }, ['--grep', `${testName}$`]);
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.match(result.stdout, /\b1 passed\b/, `the "${testName}" case ran`);
}

test('Restricted, release only: a verified release folder and no site evidence, answered in Restricted Mode', async () => {
  const release = releaseFolder('release-only');
  const trust = folder('release-only-trust');
  writeFileSync(path.join(trust, 'supplier.pub'), publicKey('supplier'));
  signWith('supplier', path.join(release, 'manifest.json'), path.join(trust, `release-${VERSION}.sigstore.json`));
  await runCase('compliance-release-only', 'Restricted, release only', [...bind(release, EVIDENCE), ...bind(trust, TRUST)]);
});

test('Site layered: your site\'s files land in the mounted folder while the page is open and appear within 40 seconds, without a reload', async () => {
  const release = releaseFolder('site');
  const trust = folder('site-trust');
  signWith('site', path.join(release, 'manifest.json'), path.join(trust, `release-${VERSION}.sigstore.json`));
  // The files the install identity and the collector write, staged beside the mount and moved in by the spec while the page is open.
  const staged = folder('site-staged');
  writeFileSync(path.join(staged, 'organization.pub'), publicKey('site'));
  siteFiles(staged, 'site');
  readable(staged);
  await runCase('compliance-site', 'Site layered', [...bind(release, EVIDENCE), ...bind(trust, TRUST)], ['-e', `STERLING_ORGANIZATION_PUBLIC_KEY=${publicKey('site')}`],
    { COMPLIANCE_SITE_STAGED: staged, COMPLIANCE_SITE_MOUNT: trust });
});

test('Tampered: one byte changed in the release folder after signing shows only Did not verify and no cells', async () => {
  const release = releaseFolder('tampered');
  const trust = folder('tampered-trust');
  writeFileSync(path.join(trust, 'supplier.pub'), publicKey('supplier'));
  signWith('supplier', path.join(release, 'manifest.json'), path.join(trust, `release-${VERSION}.sigstore.json`));
  const sbom = path.join(release, 'sbom', 'sterling-image.cdx.json');
  const bytes = readFileSync(sbom);
  bytes[2] = bytes[2]! ^ 1;
  writeFileSync(sbom, bytes);
  await runCase('compliance-tampered', 'Tampered', [...bind(release, EVIDENCE), ...bind(trust, TRUST)]);
});

test('Anchor mismatch: an organization.pub that is not STERLING_ORGANIZATION_PUBLIC_KEY shows only Did not verify, for the release and the site', async () => {
  const release = releaseFolder('mismatch');
  const trust = folder('mismatch-trust');
  // Everything in the folder agrees with the stranger's key, which is not the site key admission checks every image against.
  writeFileSync(path.join(trust, 'organization.pub'), publicKey('stranger'));
  signWith('stranger', path.join(release, 'manifest.json'), path.join(trust, `release-${VERSION}.sigstore.json`));
  siteFiles(trust, 'stranger');
  await runCase('compliance-mismatch', 'Anchor mismatch', [...bind(release, EVIDENCE), ...bind(trust, TRUST)], ['-e', `STERLING_ORGANIZATION_PUBLIC_KEY=${publicKey('site')}`]);
});

test('Projection: the README\'s projection mount alone is its own source, Not verified, with no Met count', async () => {
  const projection = folder('projection');
  const dashboard = readFileSync(path.join(repoRoot, 'compliance', 'test', 'fixtures', 'dashboard', 'dashboard.json'), 'utf8');
  writeFileSync(path.join(projection, 'dashboard.json'), dashboard);
  writeFileSync(path.join(projection, 'refresh.json'), JSON.stringify({ source: 'local bundle', commit: JSON.parse(dashboard).commit, fetchedAt: new Date(now - HOUR).toISOString(), manifest: 'verified', attestation: 'none' }));
  await runCase('compliance-projection', 'Projection', bind(projection, '/app/lib/frontend/compliance'));
});
