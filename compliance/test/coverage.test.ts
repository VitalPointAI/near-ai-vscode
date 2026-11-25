// The coverage measure and its ratchet (44.1-07, D-19, D-21): counts per level and component from sources only, a per-component baseline that
// fails on any rise and on an unrecorded fall, including the Not applicable cells awaiting sign-off, so a map change cannot pass as progress
// before your organization signs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApplicabilityIndex, mapControls, type ApplicabilityReviews, type ApplicabilityRules, type MapLevel } from '../src/applicability.ts';
import { baselinesFrom, checkBaseline, checkCoverage, countCoverage, summaryTable, workList, type CoverageSources } from '../src/coverage.ts';
import { run as runCoverage } from '../src/commands/coverage.ts';
import type { ComponentInput, EvidenceRule } from '../src/model.ts';
import type { ResponsibilityTable } from '../src/responsibility.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TABLE: ResponsibilityTable = { families: { ac: { responsibility: 'shared', reason: 'r' }, sc: { responsibility: 'shared', reason: 'r' }, at: { responsibility: 'your-organization', reason: 'r' } }, exceptions: [] };
const LEVELS: MapLevel[] = [
  { id: 'unclassified', title: 'Level A', kind: 'level', claim: true, profile: 'profiles/a.json', components: ['hub', 'hsm', 'keycloak'], controls: ['ac-02', 'ac-02.01', 'ac-18', 'at-02', 'sc-13'] },
  { id: 'level-b', title: 'Level B', kind: 'level', claim: true, profile: 'profiles/b.json', components: ['hub', 'relay'], controls: ['ac-02', 'sc-13'] },
  { id: 'overlay', title: 'Overlay', kind: 'overlay', claim: true, profile: 'profiles/o.json', components: ['hub'], controls: ['3.1.1'] },
  { id: 'appliance', title: 'Appliance', kind: 'level', claim: false, profile: 'profiles/c.json', components: ['appliance'], controls: ['ac-03'] }
];
const rules = (keycloakAccounts = true): ApplicabilityRules => ({
  kind: 'rules',
  facets: { accounts: { words: 'keeps accounts for people or services' }, cryptography: { words: 'uses or manages cryptographic keys' }, wireless: { words: 'runs a wireless network' } },
  components: {
    hub: { role: 'Hub.', facets: { accounts: { class: 'implements', basis: 'hub.' } } },
    keycloak: { role: 'Keycloak.', facets: keycloakAccounts ? { accounts: { class: 'implements', basis: 'keycloak.' } } : {} },
    relay: { role: 'Relay.', facets: { accounts: { class: 'supports', basis: 'relay.' } } },
    hsm: { role: 'HSM.', facets: { cryptography: { class: 'implements', basis: 'hsm.' } } },
    appliance: { role: 'Appliance.', facets: {} }
  },
  controls: { 'ac-02': { facets: ['accounts'] }, 'ac-18': { facets: ['wireless'] }, 'sc-13': { facets: ['cryptography'] } },
  overrides: []
});
const COMPONENTS: ComponentInput[] = [
  { id: 'hub', implemented: [] }, { id: 'keycloak', implemented: [] }, { id: 'relay', implemented: [] }, { id: 'appliance', implemented: [] },
  // A statement on a pair the rules exclude: the component has a part whatever the rules say (D-08).
  { id: 'hsm', implemented: [{ control: 'ac-02', responsibility: 'shared', statements: [{ id: 'ac-02_smt.hsm', description: 'The HSM operator login.' }] }] }
];
const RULES: EvidenceRule[] = [{ id: 'hsm.ac-02.login', component: 'hsm', control: 'ac-02', statement: 'ac-02_smt.hsm', kind: 'test', test: { file: 'src/test/hsm.test.ts', path: [], name: 'login' } }];

/** Sources with stage 1 (the first level) signed for every component at its current hash. */
function sources(source = rules(), signedWith?: ApplicabilityRules): CoverageSources {
  const controls = mapControls(LEVELS, TABLE);
  const signer = buildApplicabilityIndex(signedWith ?? source, { kind: 'reviews', stages: [] }, controls);
  const reviews: ApplicabilityReviews = { kind: 'reviews', stages: [{ id: 'stage-1', levels: ['unclassified'], reviewer: { role: 'Owner', name: 'Reviewer' }, reviewedAt: '2026-11-25',
    components: Object.fromEntries(['hub', 'hsm', 'keycloak', 'relay', 'appliance'].map((component) => [component, signer.sectionHash(component)])) }] };
  return { levels: LEVELS, components: COMPONENTS, rules: RULES, responsibilityTable: TABLE, applicability: buildApplicabilityIndex(source, reviews, controls) };
}

test('counts per level and component match a hand count for each class, and a statement on an excluded pair counts as applicable with a statement', () => {
  const report = countCoverage(sources());
  const zero = { applicableWithStatement: 0, applicableWithoutStatement: 0, notApplicableSigned: 0, notApplicableAwaitingSignOff: 0, yourOrganization: 0 };
  assert.deepEqual(report.byLevel.unclassified.hub, { ...zero, applicableWithoutStatement: 2, notApplicableSigned: 2, yourOrganization: 1 });
  assert.deepEqual(report.byLevel.unclassified.hsm, { ...zero, applicableWithStatement: 1, applicableWithoutStatement: 1, notApplicableSigned: 2, yourOrganization: 1 });
  assert.deepEqual(report.byLevel.unclassified.keycloak, { ...zero, applicableWithoutStatement: 2, notApplicableSigned: 2, yourOrganization: 1 });
  assert.deepEqual(report.byLevel['level-b'].hub, { ...zero, applicableWithoutStatement: 1, notApplicableAwaitingSignOff: 1 });
  assert.deepEqual(report.byLevel['level-b'].relay, { ...zero, applicableWithoutStatement: 1, notApplicableAwaitingSignOff: 1 });
  assert.equal(report.byLevel.overlay, undefined, 'overlays and claim-false levels are outside the map');
  assert.deepEqual(report.totals.hub, { ...zero, applicableWithoutStatement: 3, notApplicableSigned: 2, notApplicableAwaitingSignOff: 1, yourOrganization: 1 });
  assert.deepEqual(report.totals.appliance, zero, 'every component definition has a total, zero when no map level assesses it');
  assert.deepEqual(report.outside.map(({ component, control }) => [component, control]), [['hsm', 'ac-02']]);
  assert.deepEqual(report.unacceptable, []);
});

test('the ratchet fails one above and one below an unlowered baseline, and passes after the baseline is written', () => {
  const report = countCoverage(sources());
  const baselines = baselinesFrom(report);
  assert.deepEqual(checkBaseline(report, baselines), []);
  const above = new Map(baselines); above.set('hub', { ...baselines.get('hub')!, applicableWithoutStatement: 2 });
  assert.match(checkBaseline(report, above).join('\n'), /hub: applicable cells without a statement rose from 2 to 3/);
  const below = new Map(baselines); below.set('hub', { ...baselines.get('hub')!, applicableWithoutStatement: 4 });
  assert.match(checkBaseline(report, below).join('\n'), /hub: applicable cells without a statement fell from 4 to 3; lower the baseline with coverage --write/);
  const missing = new Map(baselines); missing.delete('relay');
  assert.match(checkBaseline(report, missing).join('\n'), /relay: no baseline/);
  const extra = new Map(baselines); extra.set('ghost', { component: 'ghost', applicableWithoutStatement: 0, notApplicableAwaitingSignOff: 0 });
  assert.match(checkBaseline(report, extra).join('\n'), /ghost: a baseline for a component that does not exist/);
});

test('a map change that moves pairs out of the applicable count fails as Not applicable awaiting sign-off until a review lists the new hashes', () => {
  const before = countCoverage(sources());
  const baselines = baselinesFrom(before);
  // keycloak loses its accounts facet; the stage 1 review still lists the old hashes.
  const changed = countCoverage(sources(rules(false), rules(true)));
  assert.ok(changed.totals.keycloak.applicableWithoutStatement < before.totals.keycloak.applicableWithoutStatement, 'the applicable count fell');
  const problems = checkBaseline(changed, baselines).join('\n');
  // The whole section is unsigned now, so all four of keycloak's excluded cells wait for sign-off, not only the two that moved.
  assert.match(problems, /keycloak: Not applicable cells awaiting sign-off rose from 0 to 4/);
  // Signed again at the new hashes and written: it passes.
  const signed = countCoverage(sources(rules(false)));
  assert.deepEqual(checkBaseline(signed, baselinesFrom(signed)), []);
  assert.equal(signed.totals.keycloak.notApplicableAwaitingSignOff, 0);
});

test('the check also fails on a statement with no acceptable rule and on applicability drift, saying which', () => {
  const unacceptable = countCoverage({ ...sources(), rules: [{ ...RULES[0], test: { file: 'compliance/test/hsm.test.ts', path: [], name: 'login' } }] });
  const problems = checkCoverage(unacceptable, baselinesFrom(unacceptable), ['compliance/applicability/map.lock.json:3: expected "x", found "y"']);
  assert.match(problems.join('\n'), /hsm ac-02 ac-02_smt\.hsm: not in a reported test job/);
  assert.match(problems.join('\n'), /applicability: compliance\/applicability\/map\.lock\.json:3/);
  const report = countCoverage(sources());
  assert.deepEqual(checkCoverage(report, baselinesFrom(report), []), []);
});

test('the work list gives a component\'s applicable pairs without a statement, Unclassified first, each with its levels', () => {
  assert.deepEqual(workList(sources(), 'hub'), [{ control: 'ac-02', levels: ['unclassified', 'level-b'] }, { control: 'ac-02.01', levels: ['unclassified'] }]);
  assert.deepEqual(workList(sources(), 'hsm'), [{ control: 'sc-13', levels: ['unclassified'] }], 'a pair with a statement never appears');
});

test('the bundle summary counts states per component with the change from the previous bundle, or says there is none', () => {
  const dashboard = { rows: [
    { level: 'a', control: 'ac-02', components: [{ component: 'hub', state: 'not-met' }, { component: 'hsm', state: 'not-applicable' }] },
    { level: 'a', control: 'sc-13', components: [{ component: 'hub', state: 'met' }, { component: 'hsm', state: 'not-met' }] }
  ] };
  const previous = { rows: [{ level: 'a', control: 'ac-02', components: [{ component: 'hub', state: 'not-met' }, { component: 'hsm', state: 'not-met' }] }] };
  const table = summaryTable(dashboard, previous);
  assert.match(table, /\| Component \| Met \| Partly met \| Not met \| Stale \| Not applicable \| Your organization's responsibility \|/);
  assert.match(table, /\| hsm \| 0 \| 0 \| 1 \(0\) \| 0 \| 1 \(\+1\) \| 0 \|/);
  assert.match(table, /\| hub \| 1 \(\+1\) \| 0 \| 1 \(0\) \| 0 \| 0 \| 0 \|/);
  assert.match(summaryTable(dashboard), /No previous bundle/);
});

test('coverage --write then --check passes on the real sources, and a raised baseline or a drifted lock fails it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-root-'));
  mkdirSync(path.join(root, 'compliance'));
  for (const entry of readdirSync(path.join(ROOT, 'compliance'))) if (!['applicability', 'coverage', 'node_modules', 'out'].includes(entry)) symlinkSync(path.join(ROOT, 'compliance', entry), path.join(root, 'compliance', entry));
  cpSync(path.join(ROOT, 'compliance', 'applicability'), path.join(root, 'compliance', 'applicability'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'security'), { recursive: true });
  cpSync(path.join(ROOT, 'docs', 'security', 'component-applicability.md'), path.join(root, 'docs', 'security', 'component-applicability.md'));
  // The generated supply-chain statements' drift check reads the inventory's pins across the repository and the offline bundle's tool list.
  for (const entry of readdirSync(ROOT)) if (!['compliance', 'docs', 'node_modules', '.git'].includes(entry)) symlinkSync(path.join(ROOT, entry), path.join(root, entry));
  const io = () => { const lines: string[] = []; return { lines, stdout: (text: string) => { lines.push(text); }, stderr: (text: string) => { lines.push(text); } }; };
  const write = io();
  assert.equal(await runCoverage(['--write', '--root', root], write), 0, write.lines.join(''));
  const files = readdirSync(path.join(root, 'compliance', 'coverage'));
  assert.equal(files.length, readdirSync(path.join(ROOT, 'compliance', 'components')).filter((file) => file.endsWith('.json')).length);
  const check = io();
  assert.equal(await runCoverage(['--check', '--root', root], check), 0, check.lines.join(''));
  const hubFile = path.join(root, 'compliance', 'coverage', 'hub.json');
  const hub = JSON.parse(readFileSync(hubFile, 'utf8'));
  writeFileSync(hubFile, `${JSON.stringify({ ...hub, applicableWithoutStatement: hub.applicableWithoutStatement - 1 }, null, 2)}\n`);
  const raised = io();
  assert.equal(await runCoverage(['--check', '--root', root], raised), 1);
  assert.match(raised.lines.join(''), /hub: applicable cells without a statement rose/);
  writeFileSync(hubFile, `${JSON.stringify(hub, null, 2)}\n`);
  const lock = path.join(root, 'compliance', 'applicability', 'map.lock.json');
  writeFileSync(lock, readFileSync(lock, 'utf8').replace('"kind": "lock"', '"kind": "lock" '));
  const drift = io();
  assert.equal(await runCoverage(['--check', '--root', root], drift), 1);
  assert.match(drift.lines.join(''), /applicability: compliance\/applicability\/map\.lock\.json/);
  assert.equal(await runCoverage(['--nonsense', '--root', root], io()), 2);
});
