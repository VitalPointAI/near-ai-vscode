import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { writeManifest, verifyManifest } from '../src/manifest.ts';
import { runBundle } from '../src/bundle.ts';

const commit = 'a'.repeat(40);
const folder = () => mkdtempSync(path.join(realpathSync(tmpdir()), 'near-ai-bundle-'));

// The bundle layer is deliberately tested through the public manifest contract: a
// reader must reject additions, edits, removals and symlinks rather than trusting
// a folder merely because a manifest is present.
test('bundle manifest functions are available', async () => {
  const manifest = await import('../src/manifest.ts');
  assert.equal(typeof manifest.writeManifest, 'function');
  assert.equal(typeof manifest.verifyManifest, 'function');
});

test('manifest lists relative sorted SHA-256 entries and verifies', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'b.txt'), 'second'); writeFileSync(path.join(dir, 'a.txt'), 'first');
  const manifest = writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  assert.deepEqual(manifest.files.map((entry) => entry.path), ['a.txt', 'b.txt']);
  assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && !entry.path.includes('..')));
  assert.deepEqual(verifyManifest(dir), { ok: true, errors: [] });
});

test('manifest names a changed file', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'evidence.json'), '{}'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  writeFileSync(path.join(dir, 'evidence.json'), '{ }');
  assert.match(verifyManifest(dir).errors.join('\n'), /evidence\.json: changed/);
});

test('manifest rejects added and missing files', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'a'), 'a'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  writeFileSync(path.join(dir, 'new'), 'n'); assert.match(verifyManifest(dir).errors.join('\n'), /new: unexpected/);
  unlinkSync(path.join(dir, 'new')); unlinkSync(path.join(dir, 'a')); assert.match(verifyManifest(dir).errors.join('\n'), /a: missing/);
});

test('manifest rejects symlinks rather than following them', () => {
  const dir = folder(); writeFileSync(path.join(dir, 'a'), 'a'); writeManifest(dir, { createdAt: '2026-11-21T00:00:00.000Z', commit });
  unlinkSync(path.join(dir, 'a')); symlinkSync('/etc/hosts', path.join(dir, 'a'));
  assert.match(verifyManifest(dir).errors.join('\n'), /symlink.*a|a.*symlink/);
});

test('runBundle writes the evidence layout even when no collector was selected', async () => {
  const dir = folder(); const result = await runBundle({ repository: 'owner/repo', commit, kind: 'main', repoRoot: process.cwd(), collectors: {} }, dir, { now: new Date('2026-11-21T00:00:00.000Z') });
  assert.equal(result.collectors.length, 12);
  for (const file of ['observations.json', 'test-rows.json', 'collectors.json', 'dashboard/dashboard.json', 'manifest.json']) assert.ok(readFileSync(path.join(dir, file), 'utf8').length > 0, file);
  assert.equal(verifyManifest(dir).ok, true);
});

test('runBundle refuses to replace existing files or write through an output symlink', async () => {
  const dir = folder();
  const target = folder();
  const inputs = { repository: 'owner/repo', commit, kind: 'main' as const, repoRoot: process.cwd(), collectors: {} };
  const retained = path.join(dir, 'keep.txt');
  writeFileSync(retained, 'keep');
  await assert.rejects(runBundle(inputs, dir), /must be empty/);
  assert.equal(readFileSync(retained, 'utf8'), 'keep');
  const link = path.join(dir, 'link');
  symlinkSync(target, link);
  await assert.rejects(runBundle(inputs, path.join(link, 'new')), /symbolic link/);
  assert.equal(existsSync(path.join(target, 'new')), false);
});

test('runBundle refuses to publish a dashboard with unsupported compliance claims', async () => {
  const dir = folder();
  await assert.rejects(runBundle({
    repository: 'owner/repo', commit, kind: 'main', repoRoot: process.cwd(), collectors: {},
    dashboard: { levels: [{ id: 'fixture', title: 'ITAR certified', controls: [], components: [] }] },
  }, dir), /dashboard copy lint failed/);
  assert.equal(verifyManifest(dir).ok, false);
});

test('scheduled dashboards carry only same-commit CI tests and preserve their provenance', async () => {
  const dir = folder();
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const initial = path.join(dir, 'ci');
  const report = path.join(dir, 'report.ndjson');
  const inputsFile = path.join(dir, 'scheduled.json');
  const runUrl = 'https://github.com/owner/repo/actions/runs/123';
  const collectedAt = new Date('2026-11-21T01:00:00.000Z');
  const rules = JSON.parse(readFileSync(path.join(repoRoot, 'compliance/evidence-rules/extension.json'), 'utf8'));
  const target = rules.rules.find(({ id }: { id: string }) => id === 'extension.ac-03.gate-decision').test;
  writeFileSync(report, JSON.stringify({ ...target, status: 'passed', skip: null, ms: 1 }));
  const inputs = { repository: 'owner/repo', commit, repoRoot };
  await runBundle({
    ...inputs,
    kind: 'main',
    runUrl,
    collectors: { tests: { reports: [{ package: 'root', file: report }] } }
  }, initial, { now: collectedAt });

  for (const [scheduledCommit, expected] of [[commit, 'met'], ['b'.repeat(40), 'test-not-run']]) {
    const output = path.join(dir, scheduledCommit);
    writeFileSync(inputsFile, JSON.stringify({ ...inputs, commit: scheduledCommit, kind: 'scheduled', collectors: {} }));
    assert.equal(await main(['bundle', '--inputs', inputsFile, '--out', output, '--previous', initial]), 0);
    const dashboard = JSON.parse(readFileSync(path.join(output, 'dashboard/dashboard.json'), 'utf8'));
    const row = dashboard.rows.find(({ level, control }: { level: string; control: string }) => level === 'unclassified' && control === 'ac-03');
    const evidence = row.components[0].evidence[0];
    assert.equal(evidence.reason, expected);
    if (expected === 'met') {
      assert.equal(evidence.commit, commit);
      assert.equal(evidence.collectedAt, collectedAt.toISOString());
      assert.equal(evidence.runUrl, runUrl);
    }
  }
});

test('CI-shaped bundle CLI inputs load the shipped profiles, components and evidence rules', async () => {
  const dir = folder();
  const input = path.join(dir, 'inputs.json');
  const out = path.join(dir, 'bundle');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  writeFileSync(input, JSON.stringify({ repository: 'owner/repo', commit, kind: 'main', repoRoot, collectors: {} }));
  assert.equal(await main(['bundle', '--inputs', input, '--out', out]), 0);
  const dashboard = JSON.parse(readFileSync(path.join(out, 'dashboard', 'dashboard.json'), 'utf8'));
  const level = dashboard.levels.find(({ id }: { id: string }) => id === 'protected-b');
  assert.ok(level.counts.notMetTotal > 0);
  assert.ok(level.overlays.includes('itsp-10-171'));
  assert.equal(level.notes.profileDifferences.length, 11);
  const row = dashboard.rows.find(({ level, control }: { level: string; control: string }) => level === 'protected-b' && control === 'ac-03');
  const extension = row.components.find(({ component }: { component: string }) => component === 'extension');
  assert.ok(extension.statement);
  assert.ok(extension.evidence.length > 0);
  assert.notEqual(extension.state, 'met');
  assert.match(row.textFile, /^text\/itsp-10-033\/ac\.json$/);
  const official = JSON.parse(readFileSync(path.join(out, 'dashboard', row.textFile), 'utf8'));
  assert.match(official.attribution.url, /cyber\.gc\.ca/);
  assert.ok(official.controls.find(({ id }: { id: string }) => id === 'ac-03').parts.some(({ lang }: { lang: string }) => lang === 'fr'));
  const classifiedText = dashboard.textIndex.filter(({ catalog }: { catalog: string }) => catalog === 'itsg-33');
  assert.ok(classifiedText.length > 0);
  for (const { file } of classifiedText) {
    const reference = JSON.parse(readFileSync(path.join(out, 'dashboard', file), 'utf8'));
    assert.match(reference.attribution.url, /annex-3a-security-control-catalogue-itsg-33/);
    assert.ok(reference.controls.every(({ parts }: { parts: unknown[] }) => parts.length === 0));
  }
  const cgpRows = dashboard.rows.filter(({ level }: { level: string }) => level === 'overlay-cgp');
  assert.ok(cgpRows.some(({ textFile }: { textFile?: string }) => textFile === 'text/defence-production-act/cgp.json'));
  assert.ok(cgpRows.some(({ textFile }: { textFile?: string }) => textFile === 'text/controlled-goods-regulations/cgp.json'));
  const gap = dashboard.gaps.find(({ id }: { id: string }) => id === 'G2');
  assert.equal(gap.state, 'planned');
  assert.ok(gap.milestones.length > 0);
  assert.ok(dashboard.rows.some(({ gap }: { gap?: string }) => gap === 'G2'));
  assert.equal(verifyManifest(out).ok, true);
});
