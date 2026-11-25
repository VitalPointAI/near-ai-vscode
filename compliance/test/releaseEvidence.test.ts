// 48.2-05 (D-02, D-03, D-13, D-15, D-16): the release evidence folder, its writer and its command. The vulnerability scan becomes an
// image-scan observation dated by its database's build date, so it ages by the calendar; the folder passes the session's own manifest check;
// a release with no compliance package (and no bundle) still gets a folder with its SBOM and scan. Fixtures are small hand-written files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBundle } from '../src/bundle.ts';
import { main } from '../src/cli.ts';
import { imageScanObservation } from '../src/collectors/imageScan.ts';
import { checkEvidenceManifest, EVIDENCE_FORMAT, rejudge, type Judgement, type MeasuredEvidenceFile } from '../src/judgement.ts';
import { writeReleaseEvidence } from '../src/releaseEvidence.ts';

const commit = 'a'.repeat(40);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const DB_BUILT = '2026-11-20T06:22:21Z';
const SCANNED = '2026-11-21T09:00:00Z';
const folder = (prefix: string) => mkdtempSync(path.join(realpathSync(tmpdir()), `near-ai-${prefix}-`));
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A CycloneDX SBOM as syft writes it for an image: the image's digest is the metadata component's version. */
const sbomText = (subject = IMAGE) => `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', metadata: { component: { 'bom-ref': 'abc', type: 'container', name: 'sterling-release:v0.5.0', version: subject } },
  components: [{ type: 'library', name: 'left-pad', version: '1.3.0' }] })}\n`;
/** Grype 0.122 JSON: two critical (one fixable), one high and three low; the scanned image and the database it used. */
function scanText({ manifestDigest = IMAGE, built = DB_BUILT, timestamp = SCANNED } = {}): string {
  const match = (severity: string, fixed: boolean, id: string) => ({ vulnerability: { id, severity, fix: { versions: fixed ? ['9.9.9'] : [], state: fixed ? 'fixed' : 'not-fixed' } }, artifact: { name: 'left-pad', version: '1.3.0', locations: [{ path: '/app/node_modules/left-pad' }] } });
  return `${JSON.stringify({
    matches: [match('Critical', true, 'CVE-2026-0001'), match('Critical', false, 'CVE-2026-0002'), match('High', false, 'CVE-2026-0003'), match('Low', false, 'CVE-2026-0004'), match('Low', true, 'CVE-2026-0005'), match('Low', false, 'CVE-2026-0006')],
    source: { type: 'image', target: { userInput: 'sterling-image-sbom.cdx.json', imageID: 'abc', manifestDigest } },
    distro: { name: 'redhat', version: '9.7' },
    descriptor: { name: 'grype', version: '0.122.1', timestamp, db: { status: { schemaVersion: 'v6.1.10', from: `https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.10.tar.zst?checksum=sha256%3A${'e'.repeat(64)}`, built, valid: true } } },
  })}\n`;
}
/** `grype db status -o json`. */
const dbStatusText = (built: string | undefined = DB_BUILT) => `${JSON.stringify({ schemaVersion: 'v6.1.10', from: `https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.10.tar.zst?checksum=sha256%3A${'e'.repeat(64)}`, ...(built ? { built } : {}), path: '/root/.cache/grype/db/6/vulnerability.db', valid: true })}\n`;

/** A real evidence bundle (runBundle) with one control whose one statement is proven by the image scan of the release image. */
async function bundle(): Promise<string> {
  const dir = path.join(folder('release-bundle'), 'bundle');
  await runBundle({
    repository: 'owner/repo', commit, kind: 'release', repoRoot: process.cwd(), collectors: {},
    dashboard: {
      levels: [{ id: 'unclassified', title: 'Unclassified', controls: ['ra-05'], components: ['release-pipeline'], claim: true }],
      components: [{ id: 'release-pipeline', implemented: [{ control: 'ra-05', responsibility: 'product', statements: [{ id: 'ra-05_smt', description: 'Every release image is scanned for known vulnerabilities.' }] }] }],
      rules: [{ id: 'release.ra-05.image-scan', component: 'release-pipeline', control: 'ra-05', statement: 'ra-05_smt', kind: 'observation', observation: { collector: 'image-scan', subject: 'sterling-image' } }],
    },
  }, dir, { now: new Date('2026-11-21T10:00:00.000Z') });
  return dir;
}

/** The inputs a release job has: the SBOM, the scan and the database status as files. */
function inputs(overrides: { sbom?: string; scan?: string; dbStatus?: string } = {}) {
  const dir = folder('release-inputs');
  const write = (name: string, text: string) => { writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
  return { sbom: write('sterling-image-sbom.cdx.json', overrides.sbom ?? sbomText()), scan: write('sterling-image-scan.json', overrides.scan ?? scanText()), dbStatus: write('db-status.json', overrides.dbStatus ?? dbStatusText()), dir };
}

/** Every file under a folder, measured as the session measures it. */
function measure(dir: string, prefix = ''): MeasuredEvidenceFile[] {
  return readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(dir, relative));
    if (stat.isDirectory()) return measure(dir, relative);
    const bytes = readFileSync(path.join(dir, relative));
    return [{ path: relative, size: bytes.length, sha256: sha256(bytes) }];
  });
}
const checkFolder = (dir: string) => checkEvidenceManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')), measure(dir).filter((file) => file.path !== 'manifest.json'));

test('observation: the scan becomes an image-scan observation dated by its database build date, with counts and hashes only', () => {
  const observation = imageScanObservation(scanText(), dbStatusText(), { subject: 'sterling-image', sbom: sbomText() });
  assert.deepEqual(observation, {
    collector: 'image-scan', subject: 'sterling-image', passed: true, collectedAt: '2026-11-20T06:22:21.000Z', hash: 'e'.repeat(64),
    counts: { critical: 2, high: 1, medium: 0, low: 3, negligible: 0, unknown: 0, total: 6, 'critical-fixable': 1, 'high-fixable': 0, 'medium-fixable': 0, 'low-fixable': 1, 'db-schema': 6 },
  });
  const text = JSON.stringify(observation);
  for (const leak of ['left-pad', 'CVE-', '/app/', 'node_modules', 'grype.anchore.io']) assert.equal(text.includes(leak), false, leak);
});

test('writer: the bundle dashboard, the SBOM and the scan in one folder, the observation layered as release evidence, the manifest last', async () => {
  const bundleDir = await bundle();
  const given = inputs();
  const out = path.join(folder('release-evidence'), 'evidence');
  const manifest = writeReleaseEvidence({ bundleDir, out, release: '0.5.0', builtAt: '2026-11-21T10:30:00Z', subject: IMAGE, sbom: given.sbom, scan: given.scan, dbStatus: given.dbStatus });
  assert.equal(manifest.format, EVIDENCE_FORMAT);
  assert.deepEqual([manifest.bundle, manifest.package, manifest.commit, manifest.subject], ['included', 'none', commit, IMAGE]);
  assert.deepEqual(manifest.files.map(({ path: file }) => file).filter((file) => !file.startsWith('bundle/dashboard/text/')), [
    'bundle/dashboard/dashboard.json', 'bundle/dashboard/judgement.json', 'sbom/sterling-image-sbom.cdx.json', 'scan/db-status.json', 'scan/grype.json',
  ]);
  assert.deepEqual(checkFolder(out).ok, true);
  for (const file of measure(out)) assert.equal((statSync(path.join(out, file.path)).mode & 0o777).toString(8), '644', file.path);
  assert.equal((statSync(out).mode & 0o777).toString(8), '755');
  const judgement = JSON.parse(readFileSync(path.join(out, 'bundle/dashboard/judgement.json'), 'utf8')) as Judgement;
  const component = judgement.rows[0]!.components[0]!;
  assert.deepEqual(component.results['release.ra-05.image-scan'], { rule: 'release.ra-05.image-scan', passed: true, reason: 'met', collectedAt: '2026-11-20T06:22:21.000Z', window: 'vulnerability' });
  assert.throws(() => writeReleaseEvidence({ bundleDir, out, release: '0.5.0', builtAt: '2026-11-21T10:30:00Z', subject: IMAGE, sbom: given.sbom, scan: given.scan, dbStatus: given.dbStatus }), /output folder .* not empty/);
});

test('ages: the scan in the release judgement is current on 26 November, ageing on 28 November and out of date on 21 December', async () => {
  const given = inputs();
  const out = path.join(folder('release-evidence'), 'evidence');
  writeReleaseEvidence({ bundleDir: await bundle(), out, release: '0.5.0', builtAt: '2026-11-21T10:30:00Z', subject: IMAGE, sbom: given.sbom, scan: given.scan, dbStatus: given.dbStatus });
  const judgement = JSON.parse(readFileSync(path.join(out, 'bundle/dashboard/judgement.json'), 'utf8')) as Judgement;
  const at = (day: string) => {
    const row = rejudge(judgement, { now: new Date(`${day}T12:00:00Z`) }).rows[0]!;
    return [row.components[0]!.evidence[0]!.freshness, row.components[0]!.evidence[0]!.source, row.state];
  };
  assert.deepEqual(at('2026-11-26'), ['current', 'release', 'met']);
  assert.deepEqual(at('2026-11-28'), ['ageing', 'release', 'met']);
  assert.deepEqual(at('2026-12-21'), ['out-of-date', 'release', 'stale']);
});

test('refuse: no build date, a build date after the scan, or a scan of another image is refused with one line and nothing is written', async () => {
  const bundleDir = await bundle();
  const cases: [string, Parameters<typeof inputs>[0], RegExp][] = [
    ['no build date', { dbStatus: dbStatusText('') }, /database status has no build date/],
    ['built after the scan', { dbStatus: dbStatusText('2026-11-22T00:00:00Z'), scan: scanText({ built: '2026-11-22T00:00:00Z' }) }, /database was built after the scan/],
    ['another image', { scan: scanText({ manifestDigest: `sha256:${'f'.repeat(64)}` }) }, /scan is not of the image the SBOM describes/],
    ['another database', { scan: scanText({ built: '2026-11-19T00:00:00Z' }) }, /scan used another database than the database status names/],
  ];
  for (const [what, override, message] of cases) {
    const given = inputs(override);
    const out = path.join(folder('release-evidence'), 'evidence');
    assert.throws(() => writeReleaseEvidence({ bundleDir, out, release: '0.5.0', builtAt: '2026-11-21T10:30:00Z', subject: IMAGE, sbom: given.sbom, scan: given.scan, dbStatus: given.dbStatus }), (error: Error) => message.test(error.message) && !error.message.includes('\n'), what);
    assert.equal(lstatSync(out, { throwIfNoEntry: false }) === undefined || readdirSync(out).length === 0, true, `${what}: nothing written`);
  }
});

// ---- Task 2: the command ----

/** The package and checksum a release's package job makes, and the documents it publishes. */
function releaseFiles() {
  const dir = folder('release-files');
  const packageFile = path.join(dir, 'near-ai-saa-0.5.0.tar.gz');
  writeFileSync(packageFile, 'stand-in for the compliance package tarball');
  writeFileSync(`${packageFile}.sha256`, `${sha256(readFileSync(packageFile))}  near-ai-saa-0.5.0.tar.gz\n`);
  writeFileSync(path.join(dir, 'road-to-production.md'), '# Road to production\n');
  writeFileSync(path.join(dir, 'gaps.json'), readFileSync(path.join(process.cwd(), 'compliance/gaps.json')));
  return { packageFile, checksum: `${packageFile}.sha256`, road: path.join(dir, 'road-to-production.md'), gaps: path.join(dir, 'gaps.json') };
}

async function command(args: string[]): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await main(['release-evidence', ...args]), stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

const base = (given: ReturnType<typeof inputs>, out: string) => ['--out', out, '--release', '0.5.0', '--built-at', '2026-11-21T10:30:00Z', '--subject', IMAGE, '--sbom', given.sbom, '--scan', given.scan, '--db-status', given.dbStatus];

test('content: the command writes the bundle, SBOM, scan, package, documents and a manifest listing all of them', async () => {
  const given = inputs(); const files = releaseFiles();
  const out = path.join(folder('release-evidence'), 'evidence');
  const run = await command([...base(given, out), '--bundle', await bundle(), '--package', files.packageFile, '--package-sha256', files.checksum, '--road-to-production', files.road, '--gaps', files.gaps]);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.bundle, manifest.package], ['included', 'included']);
  for (const file of ['bundle/dashboard/dashboard.json', 'bundle/dashboard/judgement.json', 'sbom/sterling-image-sbom.cdx.json', 'scan/grype.json', 'scan/db-status.json',
    'package/near-ai-saa-0.5.0.tar.gz', 'package/near-ai-saa-0.5.0.tar.gz.sha256', 'documents/road-to-production.md', 'documents/gaps.json']) {
    assert.ok(manifest.files.some(({ path: listed }: { path: string }) => listed === file), file);
  }
  assert.equal(checkFolder(out).ok, true);
});

test('no package: --no-package gives package none; --no-package --no-bundle gives both none and still the SBOM and scan; wrong forms exit 2', async () => {
  const given = inputs();
  const withBundle = path.join(folder('release-evidence'), 'evidence');
  assert.equal((await command([...base(given, withBundle), '--bundle', await bundle(), '--no-package'])).code, 0);
  assert.deepEqual(['bundle', 'package'].map((key) => JSON.parse(readFileSync(path.join(withBundle, 'manifest.json'), 'utf8'))[key]), ['included', 'none']);
  const bare = path.join(folder('release-evidence'), 'evidence');
  const run = await command([...base(given, bare), '--commit', commit, '--no-package', '--no-bundle']);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(path.join(bare, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.bundle, manifest.package, manifest.commit], ['none', 'none', commit]);
  assert.deepEqual(manifest.files.map(({ path: file }: { path: string }) => file), ['sbom/sterling-image-sbom.cdx.json', 'scan/db-status.json', 'scan/grype.json']);
  assert.equal(checkFolder(bare).ok, true);
  const unused = () => path.join(folder('release-evidence'), 'evidence');
  assert.equal((await command([...base(given, unused()), '--commit', commit, '--no-bundle'])).code, 2, '--no-bundle needs --no-package');
  for (const missing of ['--sbom', '--scan', '--db-status']) {
    const args = [...base(given, unused()), '--commit', commit, '--no-package', '--no-bundle'];
    args.splice(args.indexOf(missing), 2);
    assert.equal((await command(args)).code, 2, missing);
  }
  assert.equal((await command([...base(given, unused()), '--no-package'])).code, 2, 'neither --bundle nor --no-bundle');
});

test('checks: each bad input exits 1 with one plain line and leaves the output folder empty', async () => {
  const bundleDir = await bundle();
  const files = releaseFiles();
  const changedBundle = await bundle();
  writeFileSync(path.join(changedBundle, 'observations.json'), '{}');
  const badChecksum = path.join(folder('release-files'), 'bad.sha256'); writeFileSync(badChecksum, `${'0'.repeat(64)}  near-ai-saa-0.5.0.tar.gz\n`);
  const badGaps = path.join(folder('release-files'), 'gaps.json'); writeFileSync(badGaps, '{"gaps":[{"id":"G1"}]}');
  const big = path.join(folder('release-files'), 'big.md'); writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1));
  const linkDir = folder('release-files'); const linked = path.join(linkDir, 'road.md'); symlinkSync(files.road, linked);
  const notSbom = inputs({ sbom: '{"spdxVersion":"SPDX-2.3"}\n' });
  const cases: [string, (given: ReturnType<typeof inputs>, out: string) => string[]][] = [
    ['a bundle that does not verify', (given, out) => [...base(given, out), '--bundle', changedBundle, '--no-package']],
    ['a package that differs from its checksum', (given, out) => [...base(given, out), '--bundle', bundleDir, '--package', files.packageFile, '--package-sha256', badChecksum]],
    ['an SBOM that is not CycloneDX', (_given, out) => [...base(notSbom, out), '--bundle', bundleDir, '--no-package']],
    ['a gap register that fails its schema', (given, out) => [...base(given, out), '--bundle', bundleDir, '--no-package', '--gaps', badGaps]],
    ['a file over 64 MiB', (given, out) => [...base(given, out), '--bundle', bundleDir, '--no-package', '--road-to-production', big]],
    ['a symlinked input', (given, out) => [...base(given, out), '--bundle', bundleDir, '--no-package', '--road-to-production', linked]],
    ['a release that is not three numbers', (given, out) => base(given, out).map((value) => value === '0.5.0' ? 'v0.5' : value).concat('--bundle', bundleDir, '--no-package')],
    ['a build time that is not ISO', (given, out) => base(given, out).map((value) => value === '2026-11-21T10:30:00Z' ? '21 Nov 2026' : value).concat('--bundle', bundleDir, '--no-package')],
    ['a build time in the future', (given, out) => base(given, out).map((value) => value === '2026-11-21T10:30:00Z' ? '2099-01-01T00:00:00Z' : value).concat('--bundle', bundleDir, '--no-package')],
    ['a subject of another form', (given, out) => base(given, out).map((value) => value === IMAGE ? 'sterling-release:0.5.0' : value).concat('--bundle', bundleDir, '--no-package')],
  ];
  for (const [what, args] of cases) {
    const out = path.join(folder('release-evidence'), 'evidence');
    mkdirSync(out);
    const run = await command(args(inputs(), out));
    assert.equal(run.code, 1, `${what}: ${run.stderr}`);
    assert.equal(run.stderr.trim().split('\n').length, 1, `${what}: one line`);
    assert.deepEqual(readdirSync(out), [], `${what}: nothing written`);
  }
});
