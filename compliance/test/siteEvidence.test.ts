// 48.2-06 (D-13, D-14, D-17, D-18, D-20, D-21, D-23): site evidence counts only through a trust document your site key signs; each site file
// verifies with a key the document names for that file's purpose, within its dates; the live feed's Transit key version is signed and must
// be listed; every fact group and operator file keeps its own evidence time; nothing from the future is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHECKS, SITE_EXPORT_PURPOSE } from '../src/collectors/deployment.ts';
import { WATCHED_ALERTS } from '../src/collectors/siteLive.ts';
import { run } from '../src/commands/site-evidence.ts';
import { JUDGEMENT_FORMAT, judgementRow, rejudge, type Judgement } from '../src/judgement.ts';
import { fingerprintOf, PAYLOAD_VERSION, signingInput, MAX_PAYLOAD_BYTES } from '../src/signed.ts';
import { FUTURE_TOLERANCE_MS } from '../src/status.ts';
import {
  attachLiveSignature, buildLiveFeed, collectorKeyVersion, liveSigningInput, makeTrustDocument, SITE_AGREEMENTS_PURPOSE, SITE_EVIDENCE_FORMAT,
  SITE_LIVE_PURPOSE, SITE_RESCAN_PURPOSE, TRUST_FORMAT, verifySiteEvidence, type SiteEvidenceFiles
} from '../src/siteEvidence.ts';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => iso(NOW.getTime() - minutes * 60_000);
const SITE = 'site-a';
const EXCHANGES = (JSON.parse(readFileSync(path.join(process.cwd(), 'compliance/hosted/exchanges.json'), 'utf8')) as { exchanges: { id: string }[] }).exchanges.map(({ id }) => id);

// Your organization's site key (cosign ECDSA P-256) and the Ed25519 signers it vouches for.
const siteKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const otherSiteKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SITE_PEM = siteKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ed = () => generateKeyPairSync('ed25519');
const raw = (key: KeyObject) => (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');
const collector = { 1: ed(), 2: ed(), 3: ed() } as const;
const operator = ed();
const stranger = ed();

/** A cosign key-mode Sigstore bundle over `bytes` (the shape the parity test holds equal to cosign 3.1.4). */
function cosignBundle(bytes: Buffer, key = siteKey) {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { publicKey: { hint: createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') } },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest: createHash('sha256').update(bytes).digest('base64') }, signature: sign('sha256', bytes, key.privateKey).toString('base64') },
  };
}

function trustDocument(options: { versions?: (1 | 2 | 3)[]; operatorPurposes?: string[]; operatorNotAfter?: string; freshness?: unknown; now?: Date } = {}) {
  const now = options.now ?? NOW;
  return makeTrustDocument({
    site: SITE, issuedAt: iso(now.getTime() - 3_600_000), notBefore: iso(now.getTime() - 86_400_000), notAfter: iso(now.getTime() + 300 * 86_400_000), now,
    collectorKeys: (options.versions ?? [1]).map((version) => ({ version, publicKey: raw(collector[version].publicKey) })),
    operatorKeys: [{ publicKey: raw(operator.publicKey), purposes: options.operatorPurposes ?? [SITE_EXPORT_PURPOSE, SITE_RESCAN_PURPOSE, SITE_AGREEMENTS_PURPOSE], notAfter: options.operatorNotAfter ?? iso(now.getTime() + 200 * 86_400_000) }],
    ...(options.freshness ? { freshness: options.freshness } : {}),
  });
}
/** The trust ConfigMap's two files: the document and the site key's signature over its bytes. */
function trustFiles(document: unknown, key = siteKey) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return { document: bytes, bundle: cosignBundle(bytes, key) };
}

/** An envelope signed for `purpose` with `key` over `payload`, signed at `signedAt`. */
function envelope(purpose: string, payload: Record<string, unknown>, key: { publicKey: KeyObject; privateKey: KeyObject }, signedAt = ago(1)) {
  const publicKey = raw(key.publicKey);
  const unsigned = { v: PAYLOAD_VERSION, purpose, signer: { fingerprint: fingerprintOf(Buffer.from(publicKey, 'base64url')), publicKey }, signedAt, payload };
  return { ...unsigned, sig: sign(null, signingInput(purpose, unsigned), key.privateKey).toString('base64url') };
}

const OPENBAO = { collectedAt: ago(5), sealed: false, type: 'pkcs11' };
function liveFeed(groups: Record<string, unknown> = { openbao: OPENBAO }, keyVersion = 1, signWith: 1 | 2 | 3 = keyVersion as 1 | 2 | 3, generatedAt = ago(1)) {
  return envelope(SITE_LIVE_PURPOSE, { format: SITE_EVIDENCE_FORMAT, site: SITE, generatedAt, keyVersion, groups }, collector[signWith], generatedAt);
}

const verify = (files: SiteEvidenceFiles, organizationKey: string | undefined = SITE_PEM, now = NOW) => verifySiteEvidence({ files, organizationKey, now, exchangeIds: EXCHANGES });
const source = (result: ReturnType<typeof verify>, file: string) => result.sources.find((item) => item.file === file) as Record<string, unknown> | undefined;

test('chain: a live fact group signed with a listed key version the site-key-signed trust document names becomes a site observation', () => {
  const result = verify({ trust: trustFiles(trustDocument()), live: liveFeed() });
  assert.equal(trustDocument().format, TRUST_FORMAT);
  assert.deepEqual(source(result, 'trust'), { file: 'trust', verification: 'verified', signedAt: ago(60) });
  assert.deepEqual(source(result, 'live'), { file: 'live', verification: 'verified', signedAt: ago(1), keyVersion: 1 });
  assert.deepEqual(result.observations, [{ collector: 'site-live', subject: 'openbao-sealed', passed: true, collectedAt: OPENBAO.collectedAt, counts: { sealed: 0, 'not-pkcs11': 0 } }]);
});

test('rotation: each listed version verifies with its own key; a feed claiming version 2 signed with 1 does not verify; version 3 is not listed', () => {
  const trust = trustFiles(trustDocument({ versions: [1, 2] }));
  for (const version of [1, 2] as const) assert.equal(source(verify({ trust, live: liveFeed(undefined, version) }), 'live')?.verification, 'verified', `version ${version}`);
  assert.deepEqual(source(verify({ trust, live: liveFeed(undefined, 2, 1) }), 'live'), { file: 'live', verification: 'did-not-verify', reason: 'unknown-signer' });
  const unlisted = verify({ trust, live: liveFeed(undefined, 3) });
  assert.deepEqual(source(unlisted, 'live'), { file: 'live', verification: 'not-verified', reason: 'key-version-not-listed', keyVersion: 3 });
  assert.deepEqual(unlisted.observations, []);
  assert.equal(collectorKeyVersion(trustDocument({ versions: [1, 2] })), 2);
  assert.equal(collectorKeyVersion(trustDocument({ versions: [3, 1] })), 3);
});

test('no chain: no trust document, another site key, a signer not named, one named for another purpose or outside its dates: no observations', () => {
  const none = verify({ live: liveFeed() });
  assert.deepEqual([source(none, 'trust'), source(none, 'live')], [{ file: 'trust', verification: 'not-verified', reason: 'no-trust-document' }, { file: 'live', verification: 'not-verified', reason: 'no-trust-document' }]);
  const noKey = verify({ trust: trustFiles(trustDocument()), live: liveFeed() }, '');
  assert.deepEqual(source(noKey, 'trust'), { file: 'trust', verification: 'not-verified', reason: 'no-site-key' });
  const forged = verify({ trust: trustFiles(trustDocument(), otherSiteKey), live: liveFeed() });
  assert.deepEqual(source(forged, 'trust'), { file: 'trust', verification: 'did-not-verify', reason: 'trust-signature' });
  assert.deepEqual(source(forged, 'live'), { file: 'live', verification: 'not-verified', reason: 'trust-did-not-verify' });
  const unnamed = verify({ trust: trustFiles(trustDocument()), export: exportEnvelope(stranger) });
  assert.deepEqual(source(unnamed, 'export'), { file: 'export', verification: 'did-not-verify', reason: 'unknown-signer' });
  const otherPurpose = verify({ trust: trustFiles(trustDocument({ operatorPurposes: [SITE_RESCAN_PURPOSE] })), export: exportEnvelope(operator) });
  assert.deepEqual(source(otherPurpose, 'export'), { file: 'export', verification: 'did-not-verify', reason: 'wrong-purpose' });
  const expired = verify({ trust: trustFiles(trustDocument({ operatorNotAfter: ago(10) })), export: exportEnvelope(operator) });
  assert.deepEqual(source(expired, 'export'), { file: 'export', verification: 'not-verified', reason: 'signer-expired' });
  for (const result of [none, noKey, forged, unnamed, otherPurpose, expired]) assert.deepEqual(result.observations, []);
});

test('no pass field: a group carrying passed, or any key outside the allow-list, is refused whole', () => {
  const trust = trustFiles(trustDocument());
  for (const group of [{ ...OPENBAO, passed: true }, { ...OPENBAO, hostname: 'bao-0' }]) {
    const result = verify({ trust, live: liveFeed({ openbao: group }) });
    assert.deepEqual(source(result, 'live'), { file: 'live', verification: 'did-not-verify', reason: 'format' });
    assert.deepEqual(result.observations, []);
  }
  assert.deepEqual(source(verify({ trust, live: liveFeed({ openbao: OPENBAO, unknownGroup: { collectedAt: ago(1) } }) }), 'live')?.reason, 'format');
  assert.throws(() => buildLiveFeed({ site: SITE, generatedAt: ago(1), keyVersion: 1, groups: { openbao: { ...OPENBAO, passed: true } } }), /allow-list/);
});

// ---- Task 2: every live group, the operator's three files, times and size ----

const PROMETHEUS = { collectedAt: ago(4), ruleGroups: 2, unhealthyRuleGroups: 0, staleRules: 0, firingAlerts: ['Watchdog'] };
const ADMISSION = { collectedAt: ago(6), enforcingImagePolicies: 3, refusedImageResults: 0 };
const NODES = { collectedAt: ago(3), count: 3 };
const RELEASE = { collectedAt: ago(2), appDefinitionImage: `sha256:${'a'.repeat(64)}`, recordImage: `sha256:${'a'.repeat(64)}` };

test('live groups: prometheus, admission, nodes and release each give their observations dated at their own group time', () => {
  const old = { ...NODES, collectedAt: ago(90) };
  const result = verify({ trust: trustFiles(trustDocument()), live: liveFeed({ prometheus: PROMETHEUS, admission: ADMISSION, openbao: OPENBAO, nodes: old, release: RELEASE }) });
  assert.deepEqual(result.observations.map(({ subject, passed, collectedAt }) => [subject, passed, collectedAt]), [
    ['prometheus-rules-healthy', true, PROMETHEUS.collectedAt],
    ['audit-alerts-quiet', true, PROMETHEUS.collectedAt],
    ['image-admission-enforced', true, ADMISSION.collectedAt],
    ['openbao-sealed', true, OPENBAO.collectedAt],
    ['nodes', true, old.collectedAt],
    ['release-record', true, RELEASE.collectedAt],
  ]);
  assert.ok(result.observations.every(({ collector: name }) => name === 'site-live'));
  const firing = verify({ trust: trustFiles(trustDocument()), live: liveFeed({ prometheus: { ...PROMETHEUS, firingAlerts: ['OpenBaoSealed', 'Watchdog'] }, admission: { ...ADMISSION, refusedImageResults: 1 }, release: { ...RELEASE, recordImage: `sha256:${'b'.repeat(64)}` } }) });
  assert.deepEqual(firing.observations.map(({ subject, passed }) => [subject, passed]), [['prometheus-rules-healthy', true], ['audit-alerts-quiet', false], ['image-admission-enforced', false], ['release-record', false]]);
  // The watched alerts are the audit and OpenBao alerts of the site's alert rules as code.
  const values = JSON.parse(readFileSync(path.join(process.cwd(), 'deploy/values/prometheus-alerts.yaml'), 'utf8'));
  const groups = values.serverFiles['alerting_rules.yml'].groups as { name: string; rules: { alert: string }[] }[];
  assert.deepEqual([...WATCHED_ALERTS].sort(), groups.filter(({ name }) => name === 'openbao' || name === 'audit-shipping').flatMap(({ rules }) => rules.map(({ alert }) => alert)).sort());
});

const FACTS = {
  keycloak: { distribution: 'upstream', version: '26.8.1', fipsMode: 'strict', passwordAuthenticators: 0, otpAuthenticators: 0, loadTestClients: 0, userEventsEnabled: true, adminEventsEnabled: true, eventsLastDay: 12 },
  openbao: { version: '2.7.3', sealType: 'pkcs11', auditDevices: 1, auditEventsLastDay: 40 },
  kubernetes: { auditPolicySha256: 'c'.repeat(64), sessionsAudited: true, workspacesAudited: true, auditEventsLastDay: 900, nodes: 3, fipsNodes: 3 },
  registry: { kind: 'zot', enforcingImagePolicies: 2, unsignedImageResults: 0, auditEventsLastDay: 5 },
  images: { locked: 9, signatureVerified: 9, sbomVerified: 9, provenanceVerified: 9 },
  workbench: { sampledSessions: 2, fipsSessions: 2 },
};
function exportEnvelope(key = operator, signedAt = ago(60 * 24)) {
  return envelope(SITE_EXPORT_PURPOSE, { schema: 1, site: SITE, generatedAt: signedAt, facts: FACTS }, key, signedAt);
}

test('export: the operator-signed export (schema 1) gives the deployment collector\'s own observations dated at its signed time (H-7)', () => {
  const signedAt = ago(60 * 24);
  const result = verify({ trust: trustFiles(trustDocument()), export: exportEnvelope(operator, signedAt) });
  assert.deepEqual(source(result, 'export'), { file: 'export', verification: 'verified', signedAt });
  assert.deepEqual(result.observations.map(({ collector: name, subject, collectedAt }) => [name, subject, collectedAt]), CHECKS.map(({ subject }) => ['deployment', subject, signedAt]));
  assert.ok(result.observations.every(({ passed }) => passed));
});

const RESCAN = { format: 'sterling-site-rescan/1', site: SITE, subject: 'sterling-image', rescannedAt: ago(30), database: { built: '2026-11-24T06:00:00.000Z', schema: 'v6.1.10', checksum: 'e'.repeat(64), signatureVerified: true }, counts: { critical: 1, high: 2, medium: 0, low: 4, negligible: 0, unknown: 0 } };

test('rescan: the site rescan gives an image-scan observation dated at the database build date; an unverified database does not pass', () => {
  const result = verify({ trust: trustFiles(trustDocument()), rescan: envelope(SITE_RESCAN_PURPOSE, RESCAN, operator) });
  assert.deepEqual(result.observations, [{ collector: 'image-scan', subject: 'sterling-image', passed: true, collectedAt: '2026-11-24T06:00:00.000Z', hash: 'e'.repeat(64), counts: { ...RESCAN.counts, total: 7, 'db-schema': 6 } }]);
  const unverified = verify({ trust: trustFiles(trustDocument()), rescan: envelope(SITE_RESCAN_PURPOSE, { ...RESCAN, database: { ...RESCAN.database, signatureVerified: false } }, operator) });
  assert.equal(unverified.observations[0]!.passed, false);
  assert.equal(source(verify({ trust: trustFiles(trustDocument()), rescan: envelope(SITE_RESCAN_PURPOSE, { ...RESCAN, extra: 1 }, operator) }), 'rescan')?.reason, 'format');
});

test('agreements: one site-agreements observation per exchange dated at its review date; an exchange not in the register is refused', () => {
  const agreements = { format: 'sterling-site-agreements/1', site: SITE, agreements: [{ exchange: EXCHANGES[0]!, reference: 'ISA-2026-014', reviewedAt: '2026-03-01' }, { exchange: EXCHANGES[1]!, reference: 'MOU 7', reviewedAt: '2025-12-15' }] };
  const result = verify({ trust: trustFiles(trustDocument()), agreements: envelope(SITE_AGREEMENTS_PURPOSE, agreements, operator) });
  assert.deepEqual(result.observations, [
    { collector: 'site-agreements', subject: EXCHANGES[0]!, passed: true, collectedAt: '2026-03-01T00:00:00.000Z' },
    { collector: 'site-agreements', subject: EXCHANGES[1]!, passed: true, collectedAt: '2025-12-15T00:00:00.000Z' },
  ]);
  const unknown = verify({ trust: trustFiles(trustDocument()), agreements: envelope(SITE_AGREEMENTS_PURPOSE, { ...agreements, agreements: [{ exchange: 'no-such-exchange', reference: 'X', reviewedAt: '2026-03-01' }] }, operator) });
  assert.deepEqual([source(unknown, 'agreements')?.reason, unknown.observations], ['format', []]);
});

test('future: a site file signed, or a fact group collected, more than five minutes ahead does not verify and gives no observations', () => {
  const trust = trustFiles(trustDocument());
  const ahead = iso(NOW.getTime() + FUTURE_TOLERANCE_MS + 60_000);
  const group = verify({ trust, live: liveFeed({ openbao: { ...OPENBAO, collectedAt: ahead }, nodes: NODES }) });
  assert.deepEqual([source(group, 'live'), group.observations], [{ file: 'live', verification: 'did-not-verify', reason: 'future-dated' }, []]);
  const signed = verify({ trust, rescan: envelope(SITE_RESCAN_PURPOSE, RESCAN, operator, ahead) });
  assert.deepEqual([source(signed, 'rescan'), signed.observations], [{ file: 'rescan', verification: 'did-not-verify', reason: 'future-dated' }, []]);
  const review = verify({ trust, agreements: envelope(SITE_AGREEMENTS_PURPOSE, { format: 'sterling-site-agreements/1', site: SITE, agreements: [{ exchange: EXCHANGES[0]!, reference: 'A', reviewedAt: '2027-01-01' }] }, operator) });
  assert.equal(source(review, 'agreements')?.reason, 'future-dated');
});

test('size: a site file over MAX_PAYLOAD_BYTES is refused before it is parsed', () => {
  const feed = liveFeed();
  const big = { ...feed, payload: { ...feed.payload, padding: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } };
  const result = verify({ trust: trustFiles(trustDocument()), live: big });
  assert.deepEqual(source(result, 'live'), { file: 'live', verification: 'did-not-verify', reason: 'too-large' });
  const hugeTrust = verify({ trust: { document: Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 32), bundle: {} } });
  assert.deepEqual(source(hugeTrust, 'trust'), { file: 'trust', verification: 'did-not-verify', reason: 'too-large' });
});

// ---- Task 3: make-trust, sign and the site's freshness policy ----

const folder = () => mkdtempSync(path.join(realpathSync(tmpdir()), 'near-ai-site-evidence-'));
function quiet(): { lines: string[]; io: { stderr: (text: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { stderr: (text: string) => { lines.push(text); } } };
}
const pemFile = (dir: string, name: string, key: KeyObject) => { const file = path.join(dir, name); writeFileSync(file, key.export({ type: 'spki', format: 'pem' })); return file; };

test('make-trust: a strict document listing each collector version; duplicates, unknown purposes, long validity and loosening are refused', async () => {
  const dir = folder();
  const v1 = pemFile(dir, 'collector-v1.pub', collector[1].publicKey);
  const v2 = pemFile(dir, 'collector-v2.pub', collector[2].publicKey);
  const op = pemFile(dir, 'operator.pub', operator.publicKey);
  const notAfter = iso(Date.now() + 300 * 86_400_000).slice(0, 10);
  const args = (extra: string[] = [], out = path.join(folder(), 'trust.json')) => ['make-trust', '--site', SITE, '--collector-key', `1:${v1}`, '--collector-key', `2:${v2}`,
    '--operator-key', `${op}:${SITE_EXPORT_PURPOSE},${SITE_RESCAN_PURPOSE}:${notAfter}`, '--not-after', notAfter, '--freshness', '{"vulnerability":{"ageingAfterHours":72,"outOfDateAfterHours":240}}', '--out', out, ...extra];
  const out = path.join(folder(), 'trust.json');
  const ok = quiet();
  assert.equal(await run(args([], out), ok.io), 0, ok.lines.join(''));
  const document = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(document.format, TRUST_FORMAT);
  assert.deepEqual(document.signers.find(({ role }: { role: string }) => role === 'collector').versions.map(({ version, publicKey }: { version: number; publicKey: string }) => [version, publicKey]), [[1, raw(collector[1].publicKey)], [2, raw(collector[2].publicKey)]]);
  assert.deepEqual(document.freshness, { vulnerability: { ageingAfterHours: 72, outOfDateAfterHours: 240 } });
  const refusals: [string, string[]][] = [
    ['a duplicate version', ['--collector-key', `1:${v2}`]],
    ['a duplicate key', ['--collector-key', `3:${v1}`]],
    ['an unknown purpose', ['--operator-key', `${op}:site-everything:${notAfter}`]],
    ['validity over 400 days', ['--not-after', iso(Date.now() + 401 * 86_400_000).slice(0, 10)]],
  ];
  for (const [what, extra] of refusals) {
    const run2 = quiet();
    const base = args(extra.includes('--not-after') ? [] : extra);
    const finalArgs = extra.includes('--not-after') ? base.map((value, index) => base[index - 1] === '--not-after' ? extra[1]! : value) : base;
    assert.equal(await run(finalArgs, run2.io), 1, what);
    assert.equal(run2.lines.join('').trim().split('\n').length, 1, `${what}: one line`);
  }
  const loose = quiet();
  assert.equal(await run(args().map((value) => value.startsWith('{"vulnerability"') ? '{"audit":{"outOfDateAfterHours":48}}' : value), loose.io), 1, 'a looser freshness value');
  assert.match(loose.lines.join(''), /only tighten/);
});

test('sign: a rescan signed with a key file equals the one made by an external signer; a wrong signature is refused before writing', async () => {
  const dir = folder();
  const payload = path.join(dir, 'rescan.json');
  const { site: _site, ...body } = RESCAN;
  writeFileSync(payload, JSON.stringify(body));
  const keyFile = path.join(dir, 'operator.key'); writeFileSync(keyFile, operator.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pub = pemFile(dir, 'operator.pub', operator.publicKey);
  const signedFile = path.join(dir, 'signed.json');
  assert.equal(await run(['sign', '--kind', 'rescan', '--in', payload, '--site', SITE, '--key', keyFile, '--out', signedFile], quiet().io), 0);
  const signed = JSON.parse(readFileSync(signedFile, 'utf8'));
  assert.equal(signed.purpose, SITE_RESCAN_PURPOSE);
  const at = new Date(Date.parse(signed.signedAt) + 60_000);
  assert.equal(source(verify({ trust: trustFiles(trustDocument({ now: at })), rescan: signed }, SITE_PEM, at), 'rescan')?.verification, 'verified');
  // The external signer: emit the exact bytes, sign them elsewhere, attach.
  const unsignedFile = path.join(dir, 'unsigned.json'); const input = path.join(dir, 'signing-input.bin');
  assert.equal(await run(['sign', '--kind', 'rescan', '--in', payload, '--site', SITE, '--public-key', pub, '--emit-signing-input', input, '--out', unsignedFile], quiet().io), 0);
  const signature = path.join(dir, 'signature.bin'); writeFileSync(signature, sign(null, readFileSync(input), operator.privateKey));
  const attached = path.join(dir, 'attached.json');
  assert.equal(await run(['sign', '--unsigned', unsignedFile, '--attach-signature', signature, '--out', attached], quiet().io), 0);
  const external = JSON.parse(readFileSync(attached, 'utf8'));
  assert.deepEqual({ ...external, sig: undefined, signedAt: undefined }, { ...signed, sig: undefined, signedAt: undefined });
  const externalAt = new Date(Date.parse(external.signedAt) + 60_000);
  assert.equal(source(verify({ trust: trustFiles(trustDocument({ now: externalAt })), rescan: external }, SITE_PEM, externalAt), 'rescan')?.verification, 'verified');
  const wrong = path.join(dir, 'wrong.bin'); writeFileSync(wrong, sign(null, readFileSync(input), stranger.privateKey));
  const refusedOut = path.join(dir, 'refused.json');
  const refused = quiet();
  assert.equal(await run(['sign', '--unsigned', unsignedFile, '--attach-signature', wrong, '--out', refusedOut], refused.io), 1);
  assert.throws(() => readFileSync(refusedOut), 'nothing written');
  // Agreements sign the same way.
  const agreements = path.join(dir, 'agreements.json');
  writeFileSync(agreements, JSON.stringify({ format: 'sterling-site-agreements/1', agreements: [{ exchange: EXCHANGES[0], reference: 'ISA-1', reviewedAt: '2026-03-01' }] }));
  assert.equal(await run(['sign', '--kind', 'agreements', '--in', agreements, '--site', SITE, '--key', keyFile, '--out', path.join(dir, 'agreements.signed.json')], quiet().io), 0);
});

test('policy: a verified trust document\'s freshness reaches rejudge as the site policy; an unverified one gives none and a note', () => {
  const freshness = { vulnerability: { ageingAfterHours: 72, outOfDateAfterHours: 240 } };
  const verified = verify({ trust: trustFiles(trustDocument({ freshness })), rescan: envelope(SITE_RESCAN_PURPOSE, RESCAN, operator) });
  assert.deepEqual(verified.policy, freshness);
  assert.deepEqual(verified.notes, []);
  const unverified = verify({ trust: trustFiles(trustDocument({ freshness }), otherSiteKey) });
  assert.equal(unverified.policy, undefined);
  assert.equal(unverified.notes.length, 1);
  // The site's rescan (built 2026-11-24) is 4 days old on 2026-11-28: Current by the release defaults, Ageing under the site's tighter policy.
  const rule = { id: 'release.ra-05.image-scan', component: 'release-pipeline', control: 'ra-05', statement: 'ra-05_smt', kind: 'observation' as const, observation: { collector: 'image-scan', subject: 'sterling-image' } };
  const judgement: Judgement = {
    format: JUDGEMENT_FORMAT, generatedAt: '2026-11-21T10:00:00.000Z', commit: 'a'.repeat(40), head: 'a'.repeat(40),
    levels: [{ id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'p', claim: true, components: ['release-pipeline'], overlays: [] }],
    rows: [judgementRow({ level: 'unclassified', control: 'ra-05', claim: true, responsibility: 'product', components: [{ control: 'ra-05', component: 'release-pipeline', level: 'unclassified', responsibility: 'product', statements: [{ id: 'ra-05_smt', description: 'x' }], rulesByStatement: { 'ra-05_smt': [rule] }, results: {} }] }, { label: 'RA-5', family: 'ra', title: 'Vulnerability monitoring and scanning' })],
  };
  const later = new Date('2026-11-28T12:00:00.000Z');
  const freshnessOf = (policy: unknown) => rejudge(judgement, { now: later, observations: verified.observations, policy }).rows[0]!.components[0]!.evidence[0]!.freshness;
  assert.equal(freshnessOf(undefined), 'current');
  assert.equal(freshnessOf(verified.policy), 'ageing');
});
