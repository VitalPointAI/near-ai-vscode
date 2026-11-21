import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPackage } from '../src/package.ts';

const fixture = path.resolve('compliance/test/fixtures/package/bundle');
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
