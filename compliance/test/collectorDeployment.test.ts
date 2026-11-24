// Deployment collector (48-02, D-11, D-13, D-15, D-16, VER-05, VER-06, VER-07): a site's signed export becomes counts-only observations dated at
// the export's signed time, and only when a key in the site trust list signed it for the site-evidence purpose. Every way an export can be wrong
// yields no observation. Keys are generated when the tests run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingInput, verifyEnvelope } from '../src/signed.ts';
import { CHECKS, KEYCLOAK_MIN_FIXED, SITE_EXPORT_PURPOSE, deploymentCollector } from '../src/collectors/deployment.ts';
import { buildUnsignedExport, readKeycloakRealm, signExport } from '../src/siteExport.ts';
import { redactObservation } from '../src/redact.ts';
import { windowForCollector } from '../src/rules.ts';
import { runBundle } from '../src/bundle.ts';
import type { Observation } from '../src/model.ts';
import { DEPLOYMENT_FIXTURES, compliantFacts, fileContext, freshKey, signersText, tempDir, type TestKey } from './fixtures/collectors/deployment/helpers.ts';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const COMMIT = 'c'.repeat(40);
const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_TRUST_LIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'attestations', 'site-signers.json');
const realmFixture = (): any => JSON.parse(readFileSync(path.join(DEPLOYMENT_FIXTURES, 'site', 'keycloak-realm.json'), 'utf8'));
const hourAgo = (): string => new Date(NOW.getTime() - HOUR_MS).toISOString();

/** The compliant facts with the Keycloak counts taken from the realm fixture. */
function factsFromRealm(): any {
  const facts = compliantFacts();
  return { ...facts, keycloak: { ...facts.keycloak, ...readKeycloakRealm(realmFixture()) } };
}

/** Signs any payload, bypassing the exporter's own checks, so the collector's refusals can be tested. */
function signRaw(key: TestKey, purpose: string, payload: unknown, signedAt: string): Record<string, unknown> {
  const unsigned = { v: 1, purpose, signer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, signedAt, payload };
  return { ...unsigned, sig: edSign(null, signingInput(purpose, unsigned), createPrivateKey(key.privateKeyPem)).toString('base64url') };
}

/** Writes an export and a trust list naming `trusted`, and runs the collector over them. */
async function collect(envelope: unknown, trusted: readonly TestKey[], raw?: string): Promise<Observation[]> {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'export.json'), raw ?? JSON.stringify(envelope));
  writeFileSync(path.join(dir, 'site-signers.json'), signersText(...trusted));
  return deploymentCollector.collect({ file: path.join(dir, 'export.json'), signersFile: path.join(dir, 'site-signers.json') }, fileContext(NOW, COMMIT));
}

const exportOf = (key: TestKey, facts: unknown, at = hourAgo()) => signExport(buildUnsignedExport('fixture-site', at, facts as any, key.publicKey), key.privateKeyPem);

test('the realm reader counts enabled password and OTP executions in the flows the realm binds only', () => {
  const realm = realmFixture();
  assert.equal(readKeycloakRealm(realm).passwordAuthenticators, 0);
  assert.equal(readKeycloakRealm(realm).otpAuthenticators, 0);
  realm.flowExecutions['sterling-browser'].push({ id: 'e99', requirement: 'ALTERNATIVE', displayName: 'Username Password Form', providerId: 'auth-username-password-form', level: 1, index: 1 });
  assert.equal(readKeycloakRealm(realm).passwordAuthenticators, 1);
  assert.equal(readKeycloakRealm(realm).otpAuthenticators, 0);
});

test('a built export signed with an Ed25519 key verifies for the site-evidence purpose and that key only', () => {
  const key = freshKey();
  const generatedAt = hourAgo();
  const envelope = exportOf(key, factsFromRealm(), generatedAt);
  const verdict = verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys: [key], now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.signedAt, generatedAt);
  assert.equal(verifyEnvelope(envelope, { purpose: 'compliance-risk-acceptance', keys: [key], now: NOW }).ok, false);
  assert.equal(verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys: [freshKey()], now: NOW }).ok, false);
});

test('the collector turns a trusted export into a counts-only observation dated at the signed time', async () => {
  const key = freshKey();
  const generatedAt = hourAgo();
  const observations = await collect(exportOf(key, factsFromRealm(), generatedAt), [key]);
  const observation = observations.find((row) => row.subject === 'keycloak/no-password-authenticator');
  assert.deepEqual(observation, { collector: 'deployment', subject: 'keycloak/no-password-authenticator', passed: true, collectedAt: generatedAt, commit: COMMIT, counts: { 'password-authenticators': 0 } });
  for (const row of observations) assert.deepEqual(redactObservation(row), row);
  assert.equal(deploymentCollector.window, 'settings');
  assert.equal(windowForCollector('deployment'), 'settings');
});

const SUBJECTS = [
  'keycloak/no-password-authenticator', 'keycloak/no-otp-authenticator', 'keycloak/no-load-test-client', 'keycloak/cve-2026-6856-fixed', 'keycloak/events-shipped',
  'keycloak/fips-strict', 'openbao/audit-device', 'openbao/hsm-seal', 'kubernetes/audit-session-workspace', 'kubernetes/fips-nodes', 'registry/signature-enforced',
  'registry/audit', 'images/signed', 'images/sbom', 'images/provenance', 'workbench/fips-provider'
];

/** Each row breaks only the condition of its subject. */
const BREAKS: readonly (readonly [string, string, (facts: any) => void])[] = [
  ['keycloak/no-password-authenticator', 'one enabled password authenticator', (f) => { f.keycloak.passwordAuthenticators = 1; }],
  ['keycloak/no-otp-authenticator', 'one enabled OTP authenticator', (f) => { f.keycloak.otpAuthenticators = 1; }],
  ['keycloak/no-load-test-client', 'one loadtest- client', (f) => { f.keycloak.loadTestClients = 1; }],
  ['keycloak/cve-2026-6856-fixed', 'an upstream version below the fix', (f) => { f.keycloak.version = '26.7.9'; }],
  ['keycloak/cve-2026-6856-fixed', 'the Red Hat build at a fixed upstream number', (f) => { f.keycloak.distribution = 'redhat'; f.keycloak.version = '26.8.2'; }],
  ['keycloak/cve-2026-6856-fixed', 'a build of unknown origin', (f) => { f.keycloak.distribution = 'other'; }],
  ['keycloak/events-shipped', 'no event shipped in the last day', (f) => { f.keycloak.eventsLastDay = 0; }],
  ['keycloak/events-shipped', 'admin events off', (f) => { f.keycloak.adminEventsEnabled = false; }],
  ['keycloak/events-shipped', 'user events off', (f) => { f.keycloak.userEventsEnabled = false; }],
  ['keycloak/fips-strict', 'FIPS non-strict', (f) => { f.keycloak.fipsMode = 'non-strict'; }],
  ['openbao/audit-device', 'no audit device', (f) => { f.openbao.auditDevices = 0; }],
  ['openbao/audit-device', 'no audit event in the last day', (f) => { f.openbao.auditEventsLastDay = 0; }],
  ['openbao/hsm-seal', 'a Shamir seal', (f) => { f.openbao.sealType = 'shamir'; }],
  ['kubernetes/audit-session-workspace', 'workspaces not audited', (f) => { f.kubernetes.workspacesAudited = false; }],
  ['kubernetes/audit-session-workspace', 'no audit event in the last day', (f) => { f.kubernetes.auditEventsLastDay = 0; }],
  ['kubernetes/fips-nodes', 'one node without FIPS', (f) => { f.kubernetes.fipsNodes = 2; }],
  ['kubernetes/fips-nodes', 'no node at all', (f) => { f.kubernetes.nodes = 0; f.kubernetes.fipsNodes = 0; }],
  ['registry/signature-enforced', 'one unsigned image result', (f) => { f.registry.unsignedImageResults = 1; }],
  ['registry/signature-enforced', 'no enforcing image policy', (f) => { f.registry.enforcingImagePolicies = 0; }],
  ['registry/audit', 'no registry audit event in the last day', (f) => { f.registry.auditEventsLastDay = 0; }],
  ['images/signed', 'one image without a verified signature', (f) => { f.images.signatureVerified = 1; }],
  ['images/sbom', 'one image without a verified SBOM', (f) => { f.images.sbomVerified = 1; }],
  ['images/provenance', 'one image without verified provenance', (f) => { f.images.provenanceVerified = 1; }],
  ['workbench/fips-provider', 'one sampled session without FIPS', (f) => { f.workbench.fipsSessions = 1; }],
  ['workbench/fips-provider', 'no sampled session', (f) => { f.workbench.sampledSessions = 0; f.workbench.fipsSessions = 0; }]
];

test('each of the sixteen checks passes on the compliant export and fails when only its own condition breaks', async () => {
  assert.deepEqual(CHECKS.map((check) => check.subject), SUBJECTS);
  const key = freshKey();
  const passing = await collect(exportOf(key, compliantFacts()), [key]);
  assert.deepEqual(passing.map((row) => [row.subject, row.passed]), SUBJECTS.map((subject) => [subject, true]));
  for (const [subject, label, breakIt] of BREAKS) {
    const facts = compliantFacts();
    breakIt(facts);
    const rows = await collect(exportOf(key, facts), [key]);
    assert.deepEqual(rows.filter((row) => !row.passed).map((row) => row.subject), [subject], label);
  }
  const kubernetes = passing.find((row) => row.subject === 'kubernetes/audit-session-workspace');
  assert.equal(kubernetes?.hash, compliantFacts().kubernetes.auditPolicySha256);
  const later = compliantFacts();
  later.keycloak.version = '26.10.0';
  assert.equal((await collect(exportOf(key, later), [key])).find((row) => row.subject === 'keycloak/cve-2026-6856-fixed')?.passed, true, 'versions compare by number');
  assert.equal(KEYCLOAK_MIN_FIXED, '26.8.0');
});

test('every way an export can be wrong rejects with a reason code and returns no observation', async () => {
  const key = freshKey();
  const stranger = freshKey();
  const good = () => ({ schema: 1, site: 'fixture-site', generatedAt: hourAgo(), facts: compliantFacts() });
  const withFacts = (change: (facts: any) => void) => { const payload = good(); change(payload.facts); return payload; };
  const tampered = exportOf(key, compliantFacts()) as any;
  tampered.payload.facts.keycloak.passwordAuthenticators = 0;
  tampered.payload.facts.keycloak.otpAuthenticators = 1;
  const future = new Date(NOW.getTime() + HOUR_MS).toISOString();
  const cases: readonly (readonly [string, () => Promise<Observation[]>])[] = [
    ['export-missing', () => deploymentCollector.collect({ file: path.join(tempDir(), 'absent.json'), signersFile: PUBLIC_TRUST_LIST }, fileContext(NOW, COMMIT))],
    ['export-unreadable', () => collect(undefined, [key], '{ not json')],
    ['export-too-large', () => collect({ ...exportOf(key, compliantFacts()), payload: { ...good(), padding: 'x'.repeat(300 * 1024) } }, [key])],
    ['export-signed-in-future', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, { ...good(), generatedAt: future }, future), [key])],
    ['export-wrong-purpose', () => collect(signRaw(key, 'compliance-risk-acceptance', good(), hourAgo()), [key])],
    ['export-unknown-key', () => collect(exportOf(stranger, compliantFacts()), [key])],
    ['export-bad-signature', () => collect(tampered, [key])],
    ['export-unknown-fact', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, withFacts((f) => { f.keycloak.realmName = 'x'; }), hourAgo()), [key])],
    ['export-unknown-fact', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, withFacts((f) => { f.keycloak.passed = true; }), hourAgo()), [key])],
    ['export-missing-fact', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, withFacts((f) => { delete f.images.sbomVerified; }), hourAgo()), [key])],
    ['export-wrong-fact-type', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, withFacts((f) => { f.openbao.sealType = 'hsm'; }), hourAgo()), [key])],
    ['export-wrong-fact-type', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, withFacts((f) => { f.kubernetes.nodes = '3'; }), hourAgo()), [key])],
    ['export-time-mismatch', () => collect(signRaw(key, SITE_EXPORT_PURPOSE, good(), new Date(NOW.getTime() - 2 * HOUR_MS).toISOString()), [key])],
    ['signers-missing', () => deploymentCollector.collect({ file: path.join(tempDir(), 'absent.json'), signersFile: path.join(tempDir(), 'absent-signers.json') }, fileContext(NOW, COMMIT))]
  ];
  for (const [code, run] of cases) {
    await assert.rejects(run(), (error: any) => { assert.equal(error.code, code); return true; }, code);
  }
});

test('no observation carries the realm name, the Keycloak version, a client id or an email from the site', async () => {
  const key = freshKey();
  const rows = JSON.stringify(await collect(exportOf(key, factsFromRealm()), [key]));
  const clients = JSON.parse(readFileSync(path.join(DEPLOYMENT_FIXTURES, 'site', 'keycloak-clients.json'), 'utf8')) as { clientId: string }[];
  for (const pattern of [/fixture-sterling-site/, /26\.8\.2/, /operator@fixture-site\.example/, /@fixture/, ...clients.map((client) => new RegExp(client.clientId))]) {
    assert.doesNotMatch(rows, pattern);
  }
});

test('a customer bundle from its own export and trust list shows its row Met; the public trust list refuses that export', async () => {
  const key = freshKey();
  const dir = tempDir();
  writeFileSync(path.join(dir, 'export.json'), JSON.stringify(exportOf(key, compliantFacts())));
  writeFileSync(path.join(dir, 'site-signers.json'), signersText(key));
  const dashboard = {
    levels: [{ id: 'fixture', title: 'Fixture level', kind: 'level' as const, profile: 'profiles/fixture.json', claim: true, controls: ['tr-01'], components: ['site'] }],
    components: [{ id: 'site', implemented: [{ control: 'tr-01', responsibility: 'product' as const, statements: [{ id: 'tr-01_smt', description: 'Sign-in takes no password.' }] }] }],
    rules: [{ id: 'site.tr-01.no-password', component: 'site', control: 'tr-01', statement: 'tr-01_smt', kind: 'observation' as const, observation: { collector: 'deployment', subject: 'keycloak/no-password-authenticator' } }],
    controls: { 'tr-01': { label: 'TR-01', title: 'Fixture control' } }
  };
  const run = (signersFile: string | undefined) => runBundle({
    repository: 'owner/repo', commit: COMMIT, kind: 'pr', repoRoot: dir, dashboard,
    collectors: signersFile ? { deployment: { file: path.join(dir, 'export.json'), signersFile } } : {}
  }, path.join(tempDir(), 'bundle'), { now: NOW });
  const own = await run(path.join(dir, 'site-signers.json'));
  assert.equal(own.dashboard.rows[0].state, 'met');
  assert.deepEqual(own.collectors.find((row) => row.id === 'deployment'), { id: 'deployment', ran: true, ok: true, lastCollectedAt: hourAgo() });
  const published = await run(PUBLIC_TRUST_LIST);
  assert.deepEqual(published.collectors.find((row) => row.id === 'deployment'), { id: 'deployment', ran: true, ok: false, error: 'export-unknown-key' });
  assert.equal(published.dashboard.rows[0].state, 'not-met');
  assert.equal(published.dashboard.rows[0].components[0].reason, 'missing-result');
  const silent = await run(undefined);
  assert.equal(silent.dashboard.rows[0].components[0].reason, 'missing-result', 'a deployment collector that did not run cannot look green');
});
