import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run as runBundleCommand } from '../src/commands/bundle.ts';
import { validateOurs } from '../src/validate.ts';
const levelsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'levels.json');
const ROOT = path.resolve(path.dirname(levelsFile), '..');
const readLevels = () => JSON.parse(readFileSync(levelsFile, 'utf8')).levels as any[];
const level = (id: string) => readLevels().find((item) => item.id === id);
test('levels document validates and names the planned profiles', () => { const levels = JSON.parse(readFileSync(levelsFile, 'utf8')); assert.equal(validateOurs(levels, 'levels').ok, true); assert.equal(levels.levels.find((level: any) => level.id === 'protected-b').profile, 'profiles/itsp-10-033-01-medium.json'); });
test('the resource register validates against its schema, which requires conditions on a pass-with-conditions entry', () => {
  const register = JSON.parse(readFileSync(path.join(path.dirname(levelsFile), 'resources.json'), 'utf8'));
  assert.deepEqual(validateOurs(register, 'resources').errors, []);
  const entry = register.resources.find((resource: any) => resource.fit === 'pass-with-conditions');
  assert.equal(validateOurs({ resources: [{ ...entry, conditions: undefined }] }, 'resources').ok, false);
});
test('classified is explicitly appliance-only and makes no claim', () => { const levels = JSON.parse(readFileSync(levelsFile, 'utf8')); assert.equal(levels.levels.find((level: any) => level.id === 'classified').claim, false); });

// Phase 48 (D-17, D-18): hosted components sit in levels of their own, and every listed component has a definition file named by its id.
test('every component a level lists has a definition file named by its id', () => {
  for (const id of new Set(readLevels().flatMap((item) => item.components))) {
    assert.ok(existsSync(path.join(ROOT, 'compliance', 'components', `${id}.json`)), id);
  }
});

test('the hosted levels reuse the Protected A and Protected B profiles and make the same claim', () => {
  for (const [id, profile] of [['hosted-protected-a', 'profiles/protected-a.json'], ['hosted-protected-b', level('protected-b').profile]]) {
    const hosted = level(id);
    assert.ok(hosted, id);
    assert.equal(hosted.profile, profile, id);
    assert.equal(hosted.kind, 'level', id);
    assert.equal(hosted.claim, true, id);
  }
});

test('the existing levels and overlays list exactly the components they listed before', () => {
  const product = ['extension', 'model-endpoints', 'relay', 'hub', 'release-pipeline'];
  for (const id of ['unclassified', 'protected-a', 'protected-b', 'itsp-10-171', 'cpcsc-level-1', 'overlay-cgp', 'overlay-itar']) assert.deepEqual(level(id).components, product, id);
  assert.deepEqual(level('classified').components, ['appliance']);
});

/** Builds the dashboard through the bundle command over the checkout's real sources, as CI does. */
async function realDashboard(): Promise<any> {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-levels-'));
  const inputs = path.join(dir, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'pr', repoRoot: ROOT, collectors: {} }));
  const out = path.join(dir, 'out');
  assert.equal(await runBundleCommand(['--inputs', inputs, '--out', out]), 0);
  return JSON.parse(readFileSync(path.join(out, 'dashboard', 'dashboard.json'), 'utf8'));
}
let cached: Promise<any> | undefined;
const dashboard = () => (cached ??= realDashboard());

test('a hosted Protected B row carries the catalogue title and an honest workbench row, in levels.json order', async () => {
  const built = await dashboard();
  const row = built.rows.find((item: any) => item.level === 'hosted-protected-b' && item.control === 'ac-02');
  const product = built.rows.find((item: any) => item.level === 'protected-b' && item.control === 'ac-02');
  assert.ok(row, 'hosted-protected-b has an ac-02 row');
  assert.notEqual(row.title, 'ac-02');
  assert.equal(row.title, product.title);
  assert.equal(row.textFile, product.textFile);
  assert.equal(row.components.find((item: any) => item.component === 'workbench')?.reason, 'no-statement');
  assert.deepEqual(row.components.map((item: any) => item.component), level('hosted-protected-b').components);
});
