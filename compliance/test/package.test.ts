import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest } from '../src/manifest.ts';
import { buildPackage as buildPackageFromSource, stageAssessorItsg33Profile, type PackageOptions } from '../src/package.ts';
import { validateOscal } from '../src/validate.ts';
import { options, run } from '../src/commands/package.ts';

const fixture = fileURLToPath(new URL('./fixtures/package/bundle', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const buildPackage = (options: PackageOptions) => buildPackageFromSource({ ...options, sourceRoot });
const output = () => mkdtempSync(path.join(tmpdir(), 'near-ai-package-'));
const itsgProfile = 'profiles/itsg33-profile3.json';
const itsgCatalogue = 'catalogs/itsg-33/annex-3a.json';

test('buildPackage writes a release folder with a README and checksums', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  assert.match(result.directory, /compliance-package-v0\.4\.99$/);
  assert.match(readFileSync(path.join(result.directory, 'README.md'), 'utf8'), /not an authorization/i);
  assert.match(readFileSync(path.join(result.directory, 'SHA256SUMS'), 'utf8'), /oscal\/ssp\/protected-b\.json/);
});

test('package checksums name every package file except themselves', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const sums = readFileSync(path.join(result.directory, 'SHA256SUMS'), 'utf8');
  assert.ok(!sums.includes('SHA256SUMS'));
  assert.ok(sums.split('\n').filter(Boolean).every((line) => /^[a-f0-9]{64}  \S/.test(line)));
});

test('package output includes a draft SSP for the fixture level', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  assert.ok(readFileSync(path.join(result.directory, 'oscal/ssp/protected-b.json'), 'utf8').length > 0);
});

test('package checksum detects a changed byte', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const file = path.join(result.directory, 'README.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}changed\n`);
  assert.throws(() => result.verify(), /SHA256SUMS/);
});

test('package checksum detects an unlisted file', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  writeFileSync(path.join(result.directory, 'unexpected.json'), '{}');
  assert.throws(() => result.verify(), /SHA256SUMS/);
});

test('package writes validated assessment and POA&M documents', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  for (const [file, model] of [['assessment-plan.json', 'assessment-plan'], ['assessment-results.json', 'assessment-results'], ['poam.json', 'plan-of-action-and-milestones']] as const) {
    const doc = JSON.parse(readFileSync(path.join(result.directory, 'oscal', file), 'utf8'));
    assert.equal(validateOscal(doc, model, { ours: true }).ok, true, file);
  }
});

test('assessment results retain redacted evidence as OSCAL observations', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const results = JSON.parse(readFileSync(path.join(result.directory, 'oscal/assessment-results.json'), 'utf8'))['assessment-results'].results;
  assert.equal(results[0].observations.length, 1);
  const [observation] = results[0].observations;
  assert.equal(observation.collected, '2026-11-20T00:00:00.000Z');
  assert.equal(results[0].start, observation.collected);
  assert.equal(observation['relevant-evidence'][0].href, 'https://github.com/owner/repo/actions/runs/1');
  assert.ok(observation.props.some(({ name, value }: { name: string; value: string }) => name === 'evidence-outcome' && value === 'pass'));
  assert.ok(observation.props.some(({ name, value }: { name: string; value: string }) => name === 'count-checks' && value === '3'));
});

test('package refuses unredacted observation fields even with a valid manifest', () => {
  const bundle = output();
  cpSync(fixture, bundle, { recursive: true });
  const file = path.join(bundle, 'observations.json');
  const source = JSON.parse(readFileSync(file, 'utf8'));
  source.observations[0].notes = 'Internal organization note.';
  writeFileSync(file, JSON.stringify(source));
  writeManifest(bundle, { createdAt: source.generatedAt, commit: source.commit });
  const out = output();
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle, out }), /release evidence observation is not redacted/);
  assert.equal(existsSync(path.join(out, 'compliance-package-v0.4.99')), false);
});

test('unmet and stale evidence become findings against published statements in each level', () => {
  const { directory } = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const read = (file: string) => JSON.parse(readFileSync(path.join(directory, 'oscal', file), 'utf8'));
  for (const { level, suffix, control, state, reason } of [
    { level: 'protected-b', suffix: '', control: 'ac-02', state: 'stale', reason: 'The available evidence is past its freshness window.' },
    { level: 'protected-a', suffix: '-protected-a', control: 'ac-01', state: 'not-met', reason: 'The current evidence result is missing.' }
  ]) {
    const planFile = `assessment-plan${suffix}.json`;
    const plan = read(planFile)['assessment-plan'];
    const results = read(`assessment-results${suffix}.json`)['assessment-results'];
    assert.equal(plan['import-ssp'].href, `ssp/${level}.json`);
    assert.equal(results['import-ap'].href, planFile);
    assert.equal(results.results[0].findings.length, 1);
    const [finding] = results.results[0].findings;
    assert.deepEqual(plan['reviewed-controls']['control-selections'][0]['include-controls'].map((entry: { 'control-id': string }) => entry['control-id']),
      level === 'protected-b' ? ['ac-01', 'ac-02'] : ['ac-01']);
    assert.equal(finding.target.type, 'statement-id');
    assert.equal(finding.target['target-id'], `${control}_smt`);
    assert.equal(finding.props[0].value, state);
    assert.equal(finding.description, reason);
    assert.match(plan.tasks[0].description, /ci-checks.*head evidence window/);
    if (suffix) assert.equal(results.results[0].observations, undefined);
  }
});

test('a partial control retains an unsatisfied finding linked to its exact bundled evidence row', () => {
  const bundle = output();
  cpSync(fixture, bundle, { recursive: true });
  const dashboardFile = path.join(bundle, 'dashboard', 'dashboard.json');
  const dashboard = JSON.parse(readFileSync(dashboardFile, 'utf8'));
  const rowIndex = dashboard.rows.findIndex(({ level, control }: { level: string; control: string }) =>
    level === 'protected-a' && control === 'ac-01');
  assert.ok(rowIndex > 0, 'the row index includes preceding entries from other levels');
  const row = dashboard.rows[rowIndex];
  row.state = 'partly-met';
  row.reason = 'limitation';
  row.reasonText = 'Deployment verification remains open.';
  writeFileSync(dashboardFile, JSON.stringify(dashboard));
  writeManifest(bundle, { createdAt: dashboard.generatedAt, commit: dashboard.commit });

  const { directory, verify } = buildPackage({ release: 'v0.4.99', bundle, out: output() });
  const resultsFile = path.join(directory, 'oscal', 'assessment-results-protected-a.json');
  const results = JSON.parse(readFileSync(resultsFile, 'utf8'))['assessment-results'];
  const [finding] = results.results[0].findings;
  assert.equal(finding.target.status.state, 'not-satisfied');
  assert.equal(finding.props[0].value, 'partly-met');
  assert.equal(finding.description, row.reasonText);
  const [href, pointer] = finding.links[0].href.split('#');
  const evidence = JSON.parse(readFileSync(path.resolve(path.dirname(resultsFile), href), 'utf8'));
  assert.equal(pointer, `/rows/${rowIndex}`);
  assert.deepEqual(evidence.rows[rowIndex], row);
  verify();
});

test('package CSVs carry dashboard responsibilities and the full ITSG-33 crosswalk', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const matrix = readFileSync(path.join(result.directory, 'readable/responsibility-matrix.csv'), 'utf8');
  assert.ok(matrix.includes(`"ac-01","extension","The product checks access.","'=Confirm the ""access"" policy."`));
  const crosswalk = readFileSync(path.join(result.directory, 'readable/itsg33-crosswalk.csv'), 'utf8').trimEnd().split('\r\n');
  const source = JSON.parse(readFileSync(path.join(sourceRoot, 'mappings/itsg33-to-itsp10033.json'), 'utf8'));
  assert.equal(crosswalk.length, source.mappings.length + 1);
  assert.ok(crosswalk.includes('"ac-01","ac-01","same-id"'));
  assert.ok(crosswalk.includes('"","at-06","added"'));
  assert.ok(crosswalk.includes('"sc-100","","withdrawn"'));
});

test('package marks the crosswalk as our work', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  assert.match(readFileSync(path.join(result.directory, 'readable/itsg33-crosswalk.csv'), 'utf8'), /ours, not the Cyber Centre's/);
});

test('package writes assessor-readable gaps', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  assert.match(readFileSync(path.join(result.directory, 'readable/gaps.md'), 'utf8'), /Your organization decides/);
  const poam = JSON.parse(readFileSync(path.join(result.directory, 'oscal/poam.json'), 'utf8'))['plan-of-action-and-milestones'];
  const item = poam['poam-items'].find((entry: { title: string }) => entry.title.startsWith('G2:'));
  const risk = poam.risks.find((entry: { uuid: string }) => entry.uuid === item['related-risks'][0]['risk-uuid']);
  const [phase, date] = risk.remediations[0].tasks;
  assert.equal(phase.type, 'milestone');
  assert.equal(phase.props[0].value, '32.1');
  assert.equal(date.timing['on-date'].date, '2027-05-31T00:00:00Z');
});

test('package retains the redacted evidence bundle', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  assert.equal(readFileSync(path.join(result.directory, 'evidence/bundle/observations.json'), 'utf8'), readFileSync(path.join(fixture, 'observations.json'), 'utf8'));
});

test('package includes the named supporting documents byte for byte', () => {
  const result = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const repo = path.resolve(sourceRoot, '..');
  const security = readdirSync(path.join(repo, 'docs/security')).filter((name) => name.endsWith('.md'));
  for (const relative of ['SECURITY.md', 'docs/development-workflow.md', ...security.map((name) => `docs/security/${name}`)]) {
    assert.deepEqual(readFileSync(path.join(result.directory, 'supporting', relative)), readFileSync(path.join(repo, relative)), relative);
  }
  result.verify();
});

test('package rejects an unsafe release tag', () => {
  assert.throws(() => buildPackage({ release: '../unsafe', bundle: fixture, out: output() }), /invalid release tag/);
});

test('package command keeps every repeated SBOM argument', () => {
  assert.deepEqual(options(['--sbom', 'relay.json', '--sbom', 'hub.json'], '--sbom'), ['relay.json', 'hub.json']);
});

test('package refuses a symbolic link presented as an SBOM', () => {
  const sbom = path.join(output(), 'relay.json');
  symlinkSync(path.join(fixture, 'observations.json'), sbom);
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle: fixture, out: output(), sboms: [sbom] }), /SBOM must be a regular file/);
});

test('assessor package carries component definitions and resolves its local SSP and profile references', () => {
  const { directory, verify } = buildPackage({ release: 'v0.4.99', bundle: fixture, out: output() });
  const sspFile = path.join(directory, 'oscal/ssp/protected-b.json');
  const ssp = JSON.parse(readFileSync(sspFile, 'utf8'));
  const profileFile = path.resolve(path.dirname(sspFile), ssp['system-security-plan']['import-profile'].href);
  assert.equal(profileFile, path.join(directory, 'oscal/profiles/itsp-10-033-01-medium.json'));
  const { profile } = JSON.parse(readFileSync(profileFile, 'utf8'));
  const componentFile = path.join(directory, 'oscal/component-definitions/extension.json');
  const component = JSON.parse(readFileSync(componentFile, 'utf8'));
  assert.equal(validateOscal(component, 'component-definition', { ours: true }).ok, true);
  const reference = component['component-definition'].components[0]['control-implementations'][0].source;
  const catalog = path.resolve(path.dirname(profileFile), profile.imports[0].href);
  assert.equal(path.resolve(path.dirname(componentFile), reference), catalog);
  assert.equal(validateOscal(JSON.parse(readFileSync(catalog, 'utf8')), 'catalog').ok, true);
  verify();
});

test('classified assessor package uses the staged ITSG-33 statements and leaves the public reference intact', () => {
  const bundle = output();
  cpSync(fixture, bundle, { recursive: true });
  const dashboardFile = path.join(bundle, 'dashboard/dashboard.json');
  const dashboard = JSON.parse(readFileSync(dashboardFile, 'utf8'));
  dashboard.levels.push({ ...dashboard.levels[1], id: 'classified', title: 'Classified', profile: itsgProfile });
  dashboard.rows.push({ ...dashboard.rows[2], level: 'classified' });
  writeFileSync(dashboardFile, JSON.stringify(dashboard));
  writeManifest(bundle, { createdAt: dashboard.generatedAt, commit: dashboard.commit });
  const referenceFile = path.join(sourceRoot, itsgCatalogue);
  const original = readFileSync(referenceFile);
  const stage = output();
  stageAssessorItsg33Profile(stage, sourceRoot);
  const { directory, verify } = buildPackage({ release: 'v0.4.99', bundle, out: output() });
  const packaged = readFileSync(path.join(directory, 'oscal', itsgCatalogue));
  assert.deepEqual(packaged, readFileSync(path.join(stage, itsgCatalogue)));
  assert.deepEqual(readFileSync(referenceFile), original);
  const reference = JSON.parse(original.toString('utf8')).catalog;
  const assessor = JSON.parse(packaged.toString('utf8')).catalog;
  assert.deepEqual(reference.controls.map(({ id }: { id: string }) => id), assessor.controls.map(({ id }: { id: string }) => id));
  assert.equal(reference.controls.find(({ id }: { id: string }) => id === 'sc-13').title, 'CRYPTOGRAPHIC PROTECTION');
  assert.equal(assessor.controls.find(({ id }: { id: string }) => id === 'sc-13').title, 'USE OF CRYPTOGRAPHY');
  assert.ok(assessor.metadata.links.some(({ rel, href }: { rel: string; href: string }) => rel === 'source' && href.startsWith('https://')));
  const results = JSON.parse(readFileSync(path.join(directory, 'oscal/assessment-results-classified.json'), 'utf8'));
  const [finding] = results['assessment-results'].results[0].findings;
  assert.equal(finding.target['target-id'], 'ac-01_smt');
  verify();
});

test('package CLI includes validated resolved catalogues and records them in SHA256SUMS', async () => {
  const resolved = output();
  const sample = path.join(sourceRoot, 'catalogs/cgp/catalog.json');
  for (const profile of readdirSync(path.join(sourceRoot, 'profiles')).filter((name) => name.endsWith('.json'))) cpSync(sample, path.join(resolved, profile));
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle: fixture, resolved, out: output() }), /resolved ITSG-33 catalogue must match/);
  const stage = output();
  const stagedProfile = stageAssessorItsg33Profile(stage, sourceRoot);
  const { profile } = JSON.parse(readFileSync(stagedProfile, 'utf8'));
  const selected = new Set(profile.imports[0]['include-controls'][0]['with-ids']);
  const document = JSON.parse(readFileSync(path.join(stage, itsgCatalogue), 'utf8'));
  document.catalog.controls = document.catalog.controls.filter(({ id }: { id: string }) => selected.has(id));
  for (const { parts } of document.catalog.controls) for (const part of parts) part.prose = part.prose.replace(/^[\t ]+/gm, '');
  const resolvedItsg = path.join(resolved, path.basename(itsgProfile));
  const validItsg = JSON.stringify(document);
  document.catalog.controls[0].parts[0].prose += ' Changed requirement.';
  writeFileSync(resolvedItsg, JSON.stringify(document));
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle: fixture, resolved, out: output() }), /resolved ITSG-33 catalogue must match/);
  writeFileSync(resolvedItsg, validItsg);
  const out = output();
  assert.equal(await run(['--release', 'v0.4.99', '--bundle', fixture, '--resolved', resolved, '--out', out]), 0);
  const directory = path.join(out, 'compliance-package-v0.4.99');
  const relative = 'oscal/profiles/resolved/itsp-10-033-01-medium.json';
  assert.deepEqual(readFileSync(path.join(directory, relative)), readFileSync(sample));
  assert.match(readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8'), /oscal\/profiles\/resolved\/itsp-10-033-01-medium\.json/);
});

test('package refuses incomplete resolved output and tampered bundle evidence', () => {
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle: fixture, resolved: output(), out: output() }), /missing resolved catalogue/);
  const bundle = output();
  cpSync(fixture, bundle, { recursive: true });
  writeFileSync(path.join(bundle, 'observations.json'), '{}');
  const out = output();
  assert.throws(() => buildPackage({ release: 'v0.4.99', bundle, out }), /invalid evidence bundle.*observations\.json/);
  assert.equal(existsSync(path.join(out, 'compliance-package-v0.4.99')), false);
});
