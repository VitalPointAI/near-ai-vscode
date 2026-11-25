import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDashboardSources, run as runBundleCommand } from '../src/commands/bundle.ts';
import { loadComponents } from '../src/components.ts';
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

/**
 * Builds the dashboard through the bundle command over the checkout's real sources, as CI does. With `levels`, the sources are a linked copy of
 * compliance/ whose levels.json holds only those levels.
 */
async function realDashboard(levels?: readonly unknown[]): Promise<any> {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-levels-'));
  let repoRoot = ROOT;
  if (levels) {
    repoRoot = path.join(dir, 'repo');
    const source = path.join(ROOT, 'compliance');
    mkdirSync(path.join(repoRoot, 'compliance'), { recursive: true });
    for (const entry of readdirSync(source)) if (!['levels.json', 'node_modules', 'out'].includes(entry)) symlinkSync(path.join(source, entry), path.join(repoRoot, 'compliance', entry));
    writeFileSync(path.join(repoRoot, 'compliance', 'levels.json'), JSON.stringify({ levels }));
  }
  const inputs = path.join(dir, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'pr', repoRoot, collectors: {} }));
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

// Phases 46 and 47 components (D-17), in the order their rows appear on the hosted pages.
const PLATFORM = ['rke2', 'image-registry', 'ingress', 'cert-manager', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'openbao', 'hsm', 'site-storage', 'site-logging', 'offline-bundle'];
const HOSTED_COMPONENTS = [...PLATFORM, 'workbench', 'release-pipeline', 'hub'];
const HOSTED_LEVELS = ['hosted-protected-a', 'hosted-protected-b', 'hosted-itsp-10-171'];

test('each hosted level and the hosted overlay list exactly the hosted components, in order', () => {
  for (const id of HOSTED_LEVELS) assert.deepEqual(level(id)?.components, HOSTED_COMPONENTS, id);
  const overlay = level('hosted-itsp-10-171');
  assert.equal(overlay.kind, 'overlay');
  assert.equal(overlay.profile, 'profiles/itsp-10-171-overlay.json');
  assert.deepEqual(overlay.attachedTo, ['hosted-protected-a', 'hosted-protected-b']);
});

/**
 * The reasons a silent component may read (44.1, D-11, D-13): No statement yet or your organization's, unless the committed applicability map says
 * the component has no part, in which case it reads Not applicable to this component only while the map is signed for that level, and Not met with
 * component-not-applicable-unreviewed otherwise. The map is loaded as the bundle loads it, so the expectation follows the committed rules and reviews.
 */
const MAP = loadDashboardSources(path.join(ROOT, 'compliance')).applicability;
function silentReasons(levelId: string, control: string, component: string): string[] {
  const record = MAP?.for(levelId, control, component);
  if (record?.class !== 'not-applicable') return ['no-statement', 'your-organization'];
  return ['your-organization', record.reviewed ? 'component-not-applicable' : 'component-not-applicable-unreviewed'];
}

test('every hosted platform row of hosted Protected B ac-02 reads No statement yet, or the applicability map\'s reason where it gives the component no part', async () => {
  const row = (await dashboard()).rows.find((item: any) => item.level === 'hosted-protected-b' && item.control === 'ac-02');
  for (const id of PLATFORM) {
    const record = MAP?.for('hosted-protected-b', 'ac-02', id);
    const expected = record?.class === 'not-applicable' ? (record.reviewed ? 'component-not-applicable' : 'component-not-applicable-unreviewed') : 'no-statement';
    assert.equal(row.components.find((item: any) => item.component === id)?.reason, expected, id);
  }
});

test('no hosted component without statements reads Met on any hosted row', async () => {
  // A platform statement (48-08) reads Met only from a collected result, and this bundle collects none; a control with no statement says so.
  const stated = new Set(loadComponents(path.join(ROOT, 'compliance', 'components')).components
    .flatMap((component) => component.implemented.filter((item) => item.statements.length > 0).map((item) => `${component.id}/${item.control}`)));
  const rows = (await dashboard()).rows.filter((item: any) => HOSTED_LEVELS.includes(item.level));
  assert.ok(rows.length > 0);
  for (const row of rows) for (const component of row.components) if ([...PLATFORM, 'workbench'].includes(component.component)) {
    assert.notEqual(component.state, 'met', `${row.level}/${row.control}/${component.component}`);
    if (stated.has(`${component.component}/${row.control}`)) continue;
    assert.ok(silentReasons(row.level, row.control, component.component).includes(component.reason), `${row.level}/${row.control}/${component.component}: ${component.reason}`);
  }
});

test('the existing Protected B rows and counts are the same as in a bundle without the hosted entries', async () => {
  const withHosted = await dashboard();
  const without = await realDashboard(readLevels().filter((item) => !HOSTED_LEVELS.includes(item.id)));
  // Each build stamps its own collection time on evidence results; everything else must match.
  const pick = (built: any) => JSON.parse(JSON.stringify({ counts: built.levels.find((item: any) => item.id === 'protected-b').counts, rows: built.rows.filter((item: any) => item.level === 'protected-b') }),
    (key, value) => key === 'collectedAt' ? undefined : value);
  assert.deepEqual(pick(withHosted), pick(without));
});
