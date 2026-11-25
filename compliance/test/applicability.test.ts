// The applicability tracer (44.1-05, D-01, D-06 to D-13): one (component, control) pair, (hsm, ac-02), goes from a rule through the engine to the real
// hosted Protected A row. It reads "Not applicable to this component" with its reason only while a stage review lists the component with its current
// section hash; unsigned or changed, it reads Not met. A row no component has a part in reads your organization's responsibility, never Not applicable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApplicabilityIndex, buildLock, classify, componentSection, loadApplicability, mapControls, mapProblems, renderPage, type ApplicabilityReviews, type ApplicabilityRules, type ComponentFacets, type MapSources } from '../src/applicability.ts';
import { loadMapSources, run as runApplicability } from '../src/commands/applicability.ts';
import { loadComponents } from '../src/components.ts';
import { buildDashboard, type DashboardBuildInput, type DashboardComponentRow } from '../src/dashboard.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { selectedIds } from '../src/profiles.ts';
import { loadResponsibilityTable, type ResponsibilityTable } from '../src/responsibility.ts';
import { computeStatus } from '../src/status.ts';
import { loadJson, validateOurs } from '../src/validate.ts';
import type { StatusInput } from '../src/model.ts';
import { lintText } from '../src/wordLint.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const NOW = new Date('2026-11-25T00:00:00Z');

type LevelConfig = { id: string; title: string; kind?: 'level' | 'overlay'; profile: string; claim?: boolean; components: string[] };
const LEVELS = (loadJson(path.join(ROOT, 'levels.json')) as { levels: LevelConfig[] }).levels;
const level = (id: string) => {
  const config = LEVELS.find((entry) => entry.id === id);
  assert.ok(config, `level ${id} exists`);
  return { id: config.id, title: config.title, kind: config.kind, profile: config.profile, claim: config.claim, components: config.components, controls: selectedIds(path.join(ROOT, config.profile)) };
};
const COMPONENTS = loadComponents(path.join(ROOT, 'components')).components;
const RULES = loadEvidenceRules(path.join(ROOT, 'evidence-rules'));
const RESPONSIBILITY = loadResponsibilityTable(path.join(ROOT, 'responsibility', 'families.json'));

/** The tracer rules: accounts carried by keycloak, hub and rke2; ac-02 needs accounts; hsm carries nothing; ac-18 needs a facet nobody carries. */
const rules = (extra: Partial<ApplicabilityRules> = {}): ApplicabilityRules => ({
  kind: 'rules',
  facets: {
    accounts: { words: 'keeps accounts for people or services' },
    wireless: { words: 'runs a wireless network' },
    ...extra.facets
  },
  components: {
    keycloak: { role: 'Identity provider for the hosted site.', facets: { accounts: { class: 'implements', basis: 'components/keycloak.json: the site identity provider holds the user accounts.' } } },
    hub: { role: 'The team hub.', facets: { accounts: { class: 'implements', basis: 'components/hub.json: the hub keeps member accounts.' } } },
    rke2: { role: 'The Kubernetes distribution.', facets: { accounts: { class: 'implements', basis: 'components/rke2.json: service accounts.' } } },
    hsm: { role: 'The site HSM that holds the OpenBao seal key.', facets: {} },
    ...extra.components
  },
  controls: { 'ac-02': { facets: ['accounts'] }, 'ac-18': { facets: ['wireless'] }, ...extra.controls },
  overrides: extra.overrides ?? []
});

const HOSTED = level('hosted-protected-a');
/** The tracer rules with an entry for every hosted component, so the ac-18 rule (a facet nobody carries) covers each of them. */
const everyHosted = () => rules({ components: Object.fromEntries(HOSTED.components.filter((component) => !['keycloak', 'hub', 'rke2'].includes(component)).map((component) => [component, { role: component, facets: {} }])) });
const signedFor = (source: ApplicabilityRules, components: readonly string[], change: (component: string, hash: string) => string = (_c, hash) => hash): ApplicabilityReviews => ({
  kind: 'reviews',
  stages: [{ id: 'stage-1', levels: ['unclassified', 'protected-a', 'hosted-protected-a'], reviewer: { role: 'Owner', name: 'Reviewer' }, reviewedAt: '2026-11-25', components: Object.fromEntries(components.map((component) => [component, change(component, componentSection(source, component).sha256)])) }]
});

const build = (applicability?: ReturnType<typeof buildApplicabilityIndex>, levels = [HOSTED], extra: Partial<DashboardBuildInput> = {}) => buildDashboard({
  commit: HEAD, head: HEAD, generatedAt: NOW.toISOString(), now: NOW, levels, components: COMPONENTS, rules: RULES, testRows: [], observations: [],
  responsibilityTable: RESPONSIBILITY, ...(applicability ? { applicability } : {}), ...extra
});
const rowOf = (dashboard: ReturnType<typeof buildDashboard>, levelId: string, control: string) => {
  const row = dashboard.rows.find((entry) => entry.level === levelId && entry.control === control);
  assert.ok(row, `${levelId} ${control} row`);
  return row;
};
const cellOf = (dashboard: ReturnType<typeof buildDashboard>, levelId: string, control: string, component: string) => {
  const cells: readonly DashboardComponentRow[] = rowOf(dashboard, levelId, control).components;
  const cell = cells.find((entry) => entry.component === component);
  assert.ok(cell, `${levelId} ${control} ${component} cell`);
  return cell;
};

test('with a signed stage 1 review, hsm reads Not applicable to this component on the real hosted Protected A ac-02 row, which keeps all fifteen components', () => {
  const source = rules();
  const dashboard = build(buildApplicabilityIndex(source, signedFor(source, HOSTED.components)));
  const row = rowOf(dashboard, 'hosted-protected-a', 'ac-02');
  assert.equal(HOSTED.components.length, 15);
  assert.deepEqual(row.components.map((cell) => cell.component), HOSTED.components);
  const hsm = cellOf(dashboard, 'hosted-protected-a', 'ac-02', 'hsm');
  assert.equal(hsm.state, 'not-applicable');
  assert.equal(hsm.reason, 'component-not-applicable');
  assert.equal(hsm.applicability, 'not-applicable');
  assert.equal(hsm.responsibility, 'not-applicable');
  assert.match(hsm.reasonText, /^Not applicable to this component: /);
  for (const word of ['accounts', 'keycloak', 'hub', 'rke2']) assert.ok(hsm.reasonText.includes(word), `the reason names ${word}: ${hsm.reasonText}`);
  const keycloak = cellOf(dashboard, 'hosted-protected-a', 'ac-02', 'keycloak');
  assert.equal(keycloak.applicability, 'implements');
  assert.equal(keycloak.reason, 'no-statement');
  assert.notEqual(row.state, 'not-applicable');
});

test('with no review, or a review whose hsm hash is one character off, the hsm cell reads Not met and never Not applicable', () => {
  const source = rules();
  for (const reviews of [{ kind: 'reviews', stages: [] } as ApplicabilityReviews, signedFor(source, HOSTED.components, (component, hash) => component === 'hsm' ? `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}` : hash)]) {
    const hsm = cellOf(build(buildApplicabilityIndex(source, reviews)), 'hosted-protected-a', 'ac-02', 'hsm');
    assert.equal(hsm.state, 'not-met');
    assert.equal(hsm.reason, 'component-not-applicable-unreviewed');
    assert.equal(hsm.applicability, 'not-applicable');
    assert.notEqual(hsm.responsibility, 'not-applicable');
  }
  // A review for another level does not sign this one.
  const otherLevel: ApplicabilityReviews = { kind: 'reviews', stages: [{ ...signedFor(source, HOSTED.components).stages[0], levels: ['protected-b'] }] };
  assert.equal(cellOf(build(buildApplicabilityIndex(source, otherLevel)), 'hosted-protected-a', 'ac-02', 'hsm').reason, 'component-not-applicable-unreviewed');
});

test('a row no hosted component has a part in reads your organization\'s responsibility with no-component-applies, never Not applicable', () => {
  const source = everyHosted();
  const dashboard = build(buildApplicabilityIndex(source, signedFor(source, HOSTED.components)));
  const row = rowOf(dashboard, 'hosted-protected-a', 'ac-18');
  assert.equal(row.state, 'your-organizations-responsibility');
  assert.equal(row.reason, 'no-component-applies');
  assert.equal(row.components.length, 15);
  for (const cell of row.components) assert.equal(cell.reason, 'component-not-applicable', `${cell.component} has its own reason`);
  // Unsigned, the same row stays a gap.
  assert.equal(rowOf(build(buildApplicabilityIndex(source, { kind: 'reviews', stages: [] })), 'hosted-protected-a', 'ac-18').state, 'not-met');
});

test('a component with an implemented requirement is assessed from its statements whatever the rules say', () => {
  const protectedA = level('protected-a');
  const base = rowOf(build(undefined, [protectedA]), 'protected-a', 'ac-03');
  const excluding = rules({ controls: { 'ac-03': { facets: ['wireless'] } }, components: { extension: { role: 'The extension.', facets: {} } } });
  const index = buildApplicabilityIndex(excluding, signedFor(excluding, protectedA.components));
  const extension = (row: typeof base) => row.components.find((cell) => cell.component === 'extension');
  assert.deepEqual(extension(rowOf(build(index, [protectedA]), 'protected-a', 'ac-03')), extension(base));
});

test('a pair with no rule gives the same component cell as a dashboard built without applicability sources', () => {
  const source = rules();
  const index = buildApplicabilityIndex(source, signedFor(source, HOSTED.components));
  const withMap = build(index);
  const without = build();
  // ac-03 has no rule; keycloak has a rule set but no rule for ac-05; theia-cloud has no component entry at all.
  for (const [control, component] of [['ac-03', 'hsm'], ['ac-05', 'keycloak'], ['ac-02', 'theia-cloud'], ['at-02', 'hsm']] as const) {
    assert.deepEqual(cellOf(withMap, 'hosted-protected-a', control, component), cellOf(without, 'hosted-protected-a', control, component), `${control} ${component}`);
  }
  // An enhancement without its own rule inherits its base control.
  assert.equal(cellOf(withMap, 'hosted-protected-a', 'ac-02.01', 'hsm').reason, 'component-not-applicable');
});

test('computeStatus: a reviewed applicability record is Not applicable, an unreviewed one Not met, and your organization and inherited win first', () => {
  const input = (overrides: Partial<StatusInput>): StatusInput => ({ control: 'ac-02', component: 'hsm', level: 'hosted-protected-a', responsibility: 'shared', statements: [], rulesByStatement: {}, results: {}, head: HEAD, now: NOW, ...overrides });
  const reason = 'this control needs a component that keeps accounts for people or services (accounts).';
  assert.deepEqual(computeStatus(input({ applicability: { class: 'not-applicable', reason, reviewed: true } })), { state: 'not-applicable', reason: 'component-not-applicable', detail: { reason } });
  const unreviewed = computeStatus(input({ applicability: { class: 'not-applicable', reason, reviewed: false } }));
  assert.equal(unreviewed.state, 'not-met');
  assert.equal(unreviewed.reason, 'component-not-applicable-unreviewed');
  assert.deepEqual(computeStatus(input({ responsibility: 'your-organization', applicability: { class: 'not-applicable', reason, reviewed: true } })), { state: 'your-organizations-responsibility', reason: 'your-organization' });
  assert.deepEqual(computeStatus(input({ responsibility: 'inherited', applicability: { class: 'not-applicable', reason, reviewed: true } })), { state: 'your-organizations-responsibility', reason: 'inherited' });
  assert.deepEqual(computeStatus(input({ applicability: { class: 'implements', reason: '', reviewed: true } })), { state: 'not-met', reason: 'no-statement' });
});

test('classify and the section hash: supports beats nothing, implements beats supports, an override wins, and the hash ignores statements but sees a rule change', () => {
  const source = rules({ components: { openbao: { role: 'Secrets.', facets: { accounts: { class: 'supports', basis: 'components/openbao.json: auth roles.' } } } } });
  assert.equal(classify(source, 'openbao', 'ac-02')?.class, 'supports');
  assert.equal(classify(source, 'hub', 'ac-02')?.class, 'implements');
  assert.equal(classify(source, 'hsm', 'ac-02')?.class, 'not-applicable');
  assert.equal(classify(source, 'hsm', 'ac-03'), undefined, 'no rule for the control');
  assert.equal(classify(source, 'theia-cloud', 'ac-02'), undefined, 'no rule for the component');
  const overridden = rules({ overrides: [{ component: 'hsm', control: 'ac-02', class: 'supports', reason: 'The HSM operator login is an account.', reviewer: 'Owner', reviewedAt: '2026-11-25' }] });
  assert.equal(classify(overridden, 'hsm', 'ac-02')?.class, 'supports');
  const hash = componentSection(source, 'hsm').sha256;
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(componentSection(structuredClone(source), 'hsm').sha256, hash, 'stable');
  assert.notEqual(componentSection(rules({ controls: { 'ac-17': { facets: ['accounts'] } } }), 'hsm').sha256, hash, 'a new rule changes the section');
  assert.notEqual(componentSection(overridden, 'hsm').sha256, componentSection(rules(), 'hsm').sha256, 'an override changes the section');
});

const writeFolder = (files: Record<string, unknown>) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'applicability-'));
  for (const [name, doc] of Object.entries(files)) writeFileSync(path.join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  return dir;
};
const LEVEL_IDS = LEVELS.map((entry) => entry.id);

test('the loader accepts a valid rules and reviews pair and refuses unknown keys, bad facet classes, overrides without a reviewer and unknown levels', () => {
  const source = rules();
  const good = { 'rules.json': source, 'reviews.json': signedFor(source, ['hsm']) };
  const index = loadApplicability(writeFolder(good), LEVEL_IDS);
  assert.ok(index);
  assert.equal(index.for('hosted-protected-a', 'ac-02', 'hsm')?.reviewed, true);
  assert.equal(loadApplicability(path.join(tmpdir(), 'no-such-applicability-folder'), LEVEL_IDS), undefined, 'a missing folder leaves the dashboard as today');
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown key', { ...good, 'rules.json': { ...source, extra: true } }, /rules\.json/],
    ['a facet class other than implements or supports', { ...good, 'rules.json': { ...source, components: { ...source.components, hsm: { role: 'x', facets: { accounts: { class: 'not-applicable', basis: 'x' } } } } } }, /rules\.json/],
    ['an override without a reviewer', { ...good, 'rules.json': { ...source, overrides: [{ component: 'hsm', control: 'ac-02', class: 'supports', reason: 'x', reviewedAt: '2026-11-25' }] } }, /rules\.json/],
    ['a review stage naming a level that does not exist', { ...good, 'reviews.json': { kind: 'reviews', stages: [{ ...signedFor(source, ['hsm']).stages[0], levels: ['protected-z'] }] } }, /protected-z/],
    ['a control rule naming an undefined facet', { ...good, 'rules.json': { ...source, controls: { 'ac-02': { facets: ['nobody-defined-this'] } } } }, /nobody-defined-this/],
    ['a status key', { ...good, 'rules.json': { ...source, status: 'met' } }, /rules\.json/]
  ];
  for (const [name, files, message] of bad) assert.throws(() => loadApplicability(writeFolder(files), LEVEL_IDS), message, name);
});

test('a dashboard built with applicability passes the dashboard schema, with the new reasons and the applicability field', () => {
  const source = everyHosted();
  const signed = JSON.parse(JSON.stringify(build(buildApplicabilityIndex(source, signedFor(source, HOSTED.components)))));
  assert.deepEqual(validateOurs(signed, 'dashboard'), { ok: true, errors: [] });
  const unsigned = JSON.parse(JSON.stringify(build(buildApplicabilityIndex(source, { kind: 'reviews', stages: [] }))));
  assert.deepEqual(validateOurs(unsigned, 'dashboard'), { ok: true, errors: [] });
  const reasons = new Set([...signed.rows, ...unsigned.rows].flatMap((row: any) => [row.reason, ...row.components.map((cell: any) => cell.reason)]));
  for (const reason of ['component-not-applicable', 'component-not-applicable-unreviewed', 'no-component-applies']) assert.ok(reasons.has(reason), reason);
  const tampered = structuredClone(signed);
  tampered.rows[0].components[0].applicability = 'excluded';
  assert.equal(validateOurs(tampered, 'dashboard').ok, false);
});

// ---- 44.1-06: the generated map (lock, readable page, completeness and drift) ------------------------------------------------------------------

const FAMILIES: ResponsibilityTable = {
  families: { ac: { responsibility: 'shared', reason: 'r' }, at: { responsibility: 'your-organization', reason: 'r' }, sc: { responsibility: 'shared', reason: 'r' } },
  exceptions: []
};
const mapSources = (overrides: Partial<MapSources> = {}): MapSources => ({
  levels: [
    { id: 'level-a', title: 'Level A', kind: 'level', claim: true, profile: 'profiles/a.json', components: ['hub', 'hsm', 'keycloak'], controls: ['ac-02', 'ac-02.01', 'ac-18', 'at-02', 'sc-13'] },
    { id: 'level-b', title: 'Level B', kind: 'level', claim: true, profile: 'profiles/b.json', components: ['hub', 'relay'], controls: ['ac-02', 'sc-13'] },
    { id: 'overlay', title: 'Overlay', kind: 'overlay', claim: true, profile: 'profiles/o.json', components: ['hub'], controls: ['3.1.1'] },
    { id: 'appliance', title: 'Appliance', kind: 'level', claim: false, profile: 'profiles/c.json', components: ['appliance'], controls: ['ac-03'] }
  ],
  responsibilityTable: FAMILIES,
  components: [{ id: 'hub', implemented: [] }, { id: 'hsm', implemented: [] }],
  rules: rules({
    facets: { cryptography: { words: 'uses or manages cryptographic keys' } },
    components: {
      relay: { role: 'The relay.', facets: { accounts: { class: 'supports', basis: 'relay basis.' } } },
      hsm: { role: 'The HSM.', facets: { cryptography: { class: 'implements', basis: 'components/hsm.json: holds the seal key.' } } }
    },
    controls: { 'sc-13': { facets: ['cryptography'] } }
  }),
  ...overrides
});

test('buildLock: one sorted line per facet and in-scope control of each component, a section hash that ignores statements and moves with one facet', () => {
  const sources = mapSources();
  const lock = buildLock(sources);
  assert.equal(lock.kind, 'lock');
  assert.deepEqual(Object.keys(lock.components), ['hsm', 'hub', 'keycloak', 'relay'], 'overlay and claim-false components are not in the map');
  assert.deepEqual(lock.components.hsm.lines, [
    'facet cryptography implements: components/hsm.json: holds the seal key.',
    'ac-02 not-applicable: this control needs a component that keeps accounts for people or services (facet accounts); hub, keycloak, relay and rke2 carry that here, and this component does not.',
    'ac-02.01 not-applicable: this control needs a component that keeps accounts for people or services (facet accounts); hub, keycloak, relay and rke2 carry that here, and this component does not.',
    'ac-18 not-applicable: this control needs a component that runs a wireless network (facet wireless); no component carries that here, and this component does not.',
    'sc-13 implements'
  ], 'your-organization families (at-02) are left out');
  assert.deepEqual(lock.components.relay.lines, ['facet accounts supports: relay basis.', 'ac-02 supports', 'sc-13 not-applicable: this control needs a component that uses or manages cryptographic keys (facet cryptography); hsm carries that here, and this component does not.']);
  for (const [component, entry] of Object.entries(lock.components)) assert.match(entry.sha256, /^[0-9a-f]{64}$/, component);
  const withStatement = buildLock(mapSources({ components: [{ id: 'hsm', implemented: [{ control: 'ac-02', responsibility: 'shared', statements: [{ id: 'ac-02_smt', description: 'x' }] }] }] }));
  assert.deepEqual(withStatement, lock, 'a statement never changes the lock');
  const changed = mapSources();
  const moved = buildLock({ ...changed, rules: { ...changed.rules, components: { ...changed.rules.components, relay: { role: 'The relay.', facets: { accounts: { class: 'implements', basis: 'relay basis.' } } } } } });
  for (const component of Object.keys(lock.components)) {
    if (component === 'relay') assert.notEqual(moved.components[component].sha256, lock.components[component].sha256);
    else assert.equal(moved.components[component].sha256, lock.components[component].sha256, component);
  }
  assert.equal(lock.components.hsm.sha256, buildApplicabilityIndex(sources.rules, { kind: 'reviews', stages: [] }, mapControls(sources.levels, FAMILIES)).sectionHash('hsm'), 'the lock hash is the hash the dashboard checks');
});

test('the generator refuses a shared-family control no rule covers, naming the control and its profile, and a component with no rule entry', () => {
  const sources = mapSources();
  const uncovered = { ...sources, levels: [{ ...sources.levels[0], controls: [...sources.levels[0].controls, 'sc-28'] }] };
  assert.throws(() => buildLock(uncovered), /sc-28, selected by profiles\/a\.json/);
  const missing = { ...sources, levels: [{ ...sources.levels[0], components: [...sources.levels[0].components, 'ingress'] }] };
  assert.throws(() => buildLock(missing), /component ingress has no entry/);
  assert.deepEqual(mapProblems(sources), []);
});

test('the page lists each component\'s classes with reasons, the rows no component has a part in, and the statements outside the map', () => {
  const sources = mapSources({ components: [{ id: 'hsm', implemented: [{ control: 'ac-02', responsibility: 'shared', statements: [{ id: 'ac-02_smt.hsm', description: 'x' }] }] }] });
  const page = renderPage(buildLock(sources), sources);
  assert.match(page, /^# Component applicability map/);
  assert.match(page, /### hsm[\s\S]*\*\*Implements\*\* \(1\): sc-13[\s\S]*\*\*Not applicable to this component\*\* \(3\):\n\n- ac-02, ac-02\.01: this control needs a component that keeps accounts/);
  assert.match(page, /### relay[\s\S]*\*\*Supports\*\* \(1\): ac-02/);
  assert.match(page, /### Level A \(`level-a`\)\n\n1 control: ac-18\./);
  assert.match(page, /### Level B \(`level-b`\)\n\n1 control: sc-13\./);
  assert.match(page, /## Statements outside the map[\s\S]*- hsm, ac-02: ac-02_smt\.hsm/);
  assert.deepEqual(lintText(page), [], 'the page passes the word lint');
  assert.doesNotMatch(page, /Overlay|Appliance/);
});

test('applicability --check exits 1 on a stale lock or page and prints the first differing line, and 0 once written', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'applicability-root-'));
  const real = path.join(ROOT);
  mkdirSync(path.join(root, 'compliance'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'security'), { recursive: true });
  for (const entry of ['levels.json', 'profiles', 'components', 'responsibility', 'catalogs']) symlinkSync(path.join(real, entry), path.join(root, 'compliance', entry));
  // Rules that cover every in-scope control of the real levels: every base control needs `accounts`, every listed component has an entry.
  const sources = loadMapSources(path.resolve(ROOT, '..'));
  const controls = mapControls(sources.levels, sources.responsibilityTable);
  const components = [...new Set(sources.levels.filter((entry) => entry.claim !== false && entry.kind !== 'overlay').flatMap((entry) => entry.components))];
  const full: ApplicabilityRules = { kind: 'rules', facets: { accounts: { words: 'keeps accounts for people or services' } },
    components: Object.fromEntries(components.map((component): [string, ComponentFacets] => [component, { role: component, facets: component === 'hub' ? { accounts: { class: 'implements', basis: 'hub basis.' } } : {} }])),
    controls: Object.fromEntries([...new Set(controls.map((control) => control.replace(/\.\d+$/, '')))].map((control) => [control, { facets: ['accounts'] }])), overrides: [] };
  mkdirSync(path.join(root, 'compliance', 'applicability'));
  writeFileSync(path.join(root, 'compliance', 'applicability', 'rules.json'), `${JSON.stringify(full, null, 2)}\n`);
  writeFileSync(path.join(root, 'compliance', 'applicability', 'reviews.json'), '{ "kind": "reviews", "stages": [] }\n');
  const io = () => { const lines: string[] = []; return { lines, stdout: (text: string) => { lines.push(text); }, stderr: (text: string) => { lines.push(text); } }; };
  const missing = io();
  assert.equal(await runApplicability(['--check', '--root', root], missing), 1);
  assert.match(missing.lines.join(''), /map\.lock\.json: missing/);
  assert.equal(await runApplicability(['--write', '--root', root], io()), 0);
  const current = io();
  assert.equal(await runApplicability(['--check', '--root', root], current), 0, current.lines.join(''));
  const lockFile = path.join(root, 'compliance', 'applicability', 'map.lock.json');
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace('facet accounts implements: hub basis.', 'facet accounts implements: edited by hand.'));
  const stale = io();
  assert.equal(await runApplicability(['--check', '--root', root], stale), 1);
  assert.match(stale.lines.join(''), /map\.lock\.json:\d+: expected .*hub basis/);
  assert.equal(await runApplicability(['--root', root], io()), 2, 'a mode is required');
});
