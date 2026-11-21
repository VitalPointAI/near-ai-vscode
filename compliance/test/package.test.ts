import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage as buildPackageFromSource, type PackageOptions } from '../src/package.ts';
import { validateOscal } from '../src/validate.ts';

const fixture = fileURLToPath(new URL('./fixtures/package/bundle', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const buildPackage = (options: PackageOptions) => buildPackageFromSource({ ...options, sourceRoot });
const output = () => mkdtempSync(path.join(tmpdir(), 'near-ai-package-'));

test('buildPackage writes a release folder with a README and checksums', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  assert.match(result.directory, /compliance-package-v0\.4\.99$/);
  assert.match(readFileSync(path.join(result.directory, 'README.md'), 'utf8'), /not an authorization/i);
  assert.match(readFileSync(path.join(result.directory, 'SHA256SUMS'), 'utf8'), /oscal\/ssp\/protected-b\.json/);
});

test('package checksums name every package file except themselves', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  const sums = readFileSync(path.join(result.directory, 'SHA256SUMS'), 'utf8');
  assert.ok(!sums.includes('SHA256SUMS'));
  assert.ok(sums.split('\n').filter(Boolean).every((line) => /^[a-f0-9]{64}  \S/.test(line)));
});

test('package output includes a draft SSP for the fixture level', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  assert.ok(readFileSync(path.join(result.directory, 'oscal/ssp/protected-b.json'), 'utf8').length > 0);
});

test('package checksum detects a changed byte', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  const file = path.join(result.directory, 'README.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}changed\n`);
  assert.throws(() => result.verify(), /SHA256SUMS/);
});

test('package writes validated assessment and POA&M documents', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  for (const [file, model] of [['assessment-plan.json', 'assessment-plan'], ['assessment-results.json', 'assessment-results'], ['poam.json', 'plan-of-action-and-milestones']] as const) {
    const doc = JSON.parse(readFileSync(path.join(result.directory, 'oscal', file), 'utf8'));
    assert.equal(validateOscal(doc, model, { ours: true }).ok, true, file);
  }
});

test('package copies readable gap, matrix, and crosswalk artifacts', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  for (const file of ['readable/gaps.md', 'readable/responsibility-matrix.csv', 'readable/itsg33-crosswalk.csv']) assert.ok(readFileSync(path.join(result.directory, file), 'utf8').length > 0, file);
});

test('package marks the crosswalk as our work', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  assert.match(readFileSync(path.join(result.directory, 'readable/itsg33-crosswalk.csv'), 'utf8'), /ours, not the Cyber Centre's/);
});

test('package writes assessor-readable gaps', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  assert.match(readFileSync(path.join(result.directory, 'readable/gaps.md'), 'utf8'), /Your organization decides/);
});

test('package retains the redacted evidence bundle', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), levels: [{ id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] }] });
  assert.equal(readFileSync(path.join(result.directory, 'evidence/bundle/observations.json'), 'utf8'), readFileSync(path.join(fixture, 'observations.json'), 'utf8'));
});

test('package rejects an unsafe release tag', () => {
  assert.throws(() => buildPackage({ release: '../unsafe', bundle: fixture, out: output() }), /invalid release tag/);
});
