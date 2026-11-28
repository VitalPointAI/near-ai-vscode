// The generated supply-chain statements (44.1-09, D-14, D-15, D-17, D-18): one statement per (component, supply-chain control) written only where
// the component inventory has that component's resources and evidence backs them, never over a hand-written statement or a reserved pair, and
// a drift check that fails when the component files differ from what the generator gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadComponents } from '../src/components.ts';
import { NS, type ComponentInput } from '../src/model.ts';
import type { Inventory, InventoryEntry } from '../src/inventory.ts';
import { hasStringLiteral, isAcceptableRule, statementsWithoutAcceptableRule } from '../src/rules.ts';
import { lintText } from '../src/wordLint.ts';
import { EVIDENCE, STATEMENT_SUFFIX, generate, type ComponentFile, type SupplyChainEvidence, type SupplyChainSources } from '../src/supplyChainStatements.ts';
import { run as runSupplyChain } from '../src/commands/supply-chain-statements.ts';
import { run as runCoverage } from '../src/commands/coverage.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE_LOCK = 'deploy/bundle/images.lock.json';
const CHART_LOCK = 'deploy/charts/charts.lock.json';

const entry = (component: string, kind: string, name: string, pin: string, where: string, scope = 'runtime'): InventoryEntry => ({
  id: `${kind}:${name}`, kind, name, pins: [{ pin, where: [where] }], where: [where], component, architectureArea: 'site-platform', scope, purpose: 'p', role: 'r',
  roleNeedsReview: false, licence: 'Apache-2.0', controls: [], crypto: 'none', cveResponse: 'c', airGap: 'ok', fit: 'pass', conditions: [], reviewer: 'r', reviewedAt: '2026-11-24'
});

type Requirement = { control: string; statement: string };
/** A one-line component file as the repository writes them, with hand-written requirements when given; the same arguments give the same bytes. */
function componentFile(id: string, title: string, requirements: readonly Requirement[] = []): ComponentFile {
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${Buffer.from(id).toString('hex').slice(0, 8).padStart(8, '0')}${String(++seq).padStart(4, '0')}`;
  const implemented = requirements.map(({ control, statement }) => ({
    uuid: uuid(), 'control-id': control, description: 'Hand-written.', props: [{ name: 'responsibility', ns: NS, value: 'shared' }],
    statements: [{ uuid: uuid(), 'statement-id': statement, description: 'What the hand-written statement says.' }]
  }));
  const component = {
    uuid: uuid(), type: 'software', title, description: `${title}.`, props: [{ name: 'component-id', ns: NS, value: id }],
    ...(implemented.length ? { 'control-implementations': [{ uuid: uuid(), source: 'catalogs/itsp-10-033/catalog.json', description: 'Hand-written.', 'implemented-requirements': implemented }] } : {})
  };
  const doc = { 'component-definition': { uuid: uuid(), metadata: { title, 'last-modified': '2026-11-24T00:00:00Z', version: '0.1.0', 'oscal-version': '1.2.1' }, components: [component] } };
  return { file: `compliance/components/${id}.json`, text: `${JSON.stringify(doc)}\n` };
}

const INVENTORY: Inventory = {
  areas: [],
  entries: [
    entry('cert-manager', 'image', 'quay.io/jetstack/cert-manager-controller', 'v1.21.3@sha256:9b26', IMAGE_LOCK),
    entry('cert-manager', 'chart', 'cert-manager', 'v1.21.3 (sha256:aa11)', CHART_LOCK),
    entry('image-registry', 'image', 'ghcr.io/project-zot/zot', 'v2.1.23@sha256:b68f', IMAGE_LOCK),
    entry('openbao', 'chart', 'openbao', '0.30.0 (sha256:bb22)', CHART_LOCK),
    entry('relay', 'npm', 'jose', '6.1.0', 'relay/package.json'),
    entry('hsm', 'tool', 'softhsm2', '2.7.0', 'compliance/ci/tool-pins.json', 'test')
  ]
};
const FILES = (): ComponentFile[] => [
  componentFile('cert-manager', 'Site certificate issuing'),
  componentFile('hub', 'Hub'),
  componentFile('image-registry', 'Site image registry'),
  componentFile('openbao', 'OpenBao'),
  componentFile('relay', 'Relay', [{ control: 'cm-08', statement: 'cm-08_smt.relay' }]),
  componentFile('hsm', 'HSM'),
  componentFile('keycloak', 'Keycloak')
];
const sources = (overrides: Partial<SupplyChainSources> = {}): SupplyChainSources => ({
  inventory: INVENTORY, bundleTools: ['rke2', 'helm', 'cosign', 'hauler'], componentFiles: FILES(), applicable: () => true, ...overrides
});

/** The components a generated set of files holds, as the dashboard loads them. */
function loaded(files: readonly ComponentFile[]): ComponentInput[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'supply-chain-components-'));
  for (const file of files) writeFileSync(path.join(dir, path.basename(file.file)), file.text);
  const { components, errors } = loadComponents(dir);
  assert.deepEqual(errors, []);
  return components;
}
const generatedControls = (components: readonly ComponentInput[], id: string): string[] =>
  (components.find((component) => component.id === id)?.implemented ?? []).filter((requirement) => requirement.statements.some((statement) => statement.id.endsWith(STATEMENT_SUFFIX))).map((requirement) => requirement.control).sort();

test('a component with an image lock entry gets a cm-08 statement naming its own pinned items; one without an inventory entry gets none', () => {
  const output = generate(sources());
  const components = loaded(output.files);
  assert.ok(generatedControls(components, 'cert-manager').includes('cm-08'));
  const cm08 = components.find((component) => component.id === 'cert-manager')!.implemented.find((requirement) => requirement.control === 'cm-08')!.statements[0];
  assert.equal(cm08.id, `cm-08${STATEMENT_SUFFIX}`);
  assert.match(cm08.description, /quay\.io\/jetstack\/cert-manager-controller v1\.21\.3@sha256:9b26/);
  assert.match(cm08.description, /cert-manager v1\.21\.3 \(sha256:aa11\)/);
  assert.doesNotMatch(cm08.description, /zot|openbao/, 'only the component\'s own items are named');
  assert.match(cm08.yourOrganizationDoes ?? '', /^Your organization /);
  assert.deepEqual(generatedControls(components, 'hub'), []);
  assert.ok(output.skipped.some((pair) => pair.component === 'hub' && pair.control === 'cm-08' && /no entry in the component inventory/.test(pair.reason)));
  assert.equal(output.files.find((file) => file.file.endsWith('/hub.json'))!.text, FILES().find((file) => file.file.endsWith('/hub.json'))!.text, 'a component with nothing generated keeps its bytes');
  // A test-only resource is not a system component: the HSM's SoftHSM2 pin backs no statement.
  assert.deepEqual(generatedControls(components, 'hsm'), []);
  // Every generated statement has an acceptable rule, and its words pass the lint.
  assert.deepEqual(statementsWithoutAcceptableRule(components, output.rules, [{ components: components.map((component) => component.id) }]).filter((entry) => entry.statement.endsWith(STATEMENT_SUFFIX)), []);
  assert.ok(output.generated.length > 0);
  assert.ok(output.rules.every((rule) => rule.id === `${rule.component}.${rule.control}.inventory` && rule.statement === `${rule.control}${STATEMENT_SUFFIX}`));
  for (const component of components) for (const requirement of component.implemented) for (const statement of requirement.statements) {
    assert.deepEqual(lintText(`${statement.description} ${statement.yourOrganizationDoes ?? ''}`), []);
  }
});

test('a hand-written statement is left alone, a reserved pair gets no statement, and a pair the map excludes gets none', () => {
  const before = FILES();
  const output = generate(sources({ applicable: (component, control) => !(component === 'openbao' && control === 'sr-11') }));
  const components = loaded(output.files);
  const relay = components.find((component) => component.id === 'relay')!;
  assert.deepEqual(relay.implemented.filter((requirement) => requirement.control === 'cm-08').map((requirement) => requirement.statements.map((statement) => statement.id)), [['cm-08_smt.relay']]);
  assert.equal(relay.implemented.find((requirement) => requirement.control === 'cm-08')!.statements[0].description, 'What the hand-written statement says.');
  assert.ok(output.skipped.some((pair) => pair.component === 'relay' && pair.control === 'cm-08' && /hand-written/.test(pair.reason)));
  // 48-08 keeps si-07 and cm-08 on the image registry (44.1-HANDOFFS.md); the import refusal still backs its sr-11.
  assert.deepEqual(generatedControls(components, 'image-registry'), ['sr-03', 'sr-11']);
  assert.ok(output.skipped.some((pair) => pair.component === 'image-registry' && pair.control === 'si-07' && /reserved for 48-08/.test(pair.reason)));
  assert.ok(!generatedControls(components, 'openbao').includes('sr-11'));
  assert.ok(output.skipped.some((pair) => pair.component === 'openbao' && pair.control === 'sr-11' && /not applicable/.test(pair.reason)));
  // The hand-written file's other bytes are kept: removing the generated part gives back the original.
  const relayBefore = JSON.parse(before.find((file) => file.file.endsWith('/relay.json'))!.text);
  const relayAfter = JSON.parse(output.files.find((file) => file.file.endsWith('/relay.json'))!.text);
  relayAfter['component-definition'].components[0]['control-implementations'] = relayAfter['component-definition'].components[0]['control-implementations'].slice(0, 1);
  assert.deepEqual(relayAfter, relayBefore);
});

test('without a per-component evidence subject only the controls the shared import tests prove are written, never ra-05', () => {
  const imports = EVIDENCE.filter((evidence) => evidence.scope === 'bundle');
  assert.deepEqual(imports.map((evidence) => evidence.control).sort(), ['si-07', 'sr-11']);
  const scan: SupplyChainEvidence = {
    control: 'ra-05', scope: { component: 'cert-manager' }, rule: { kind: 'observation', observation: { collector: 'sbom', subject: 'cert-manager-image' } },
    summary: 'its images are scanned', description: (title, items) => `The images of ${title} are scanned: ${items}.`, remarks: 'Your organization reviews the findings.'
  };
  const output = generate(sources({ evidence: [...imports, scan] }));
  const components = loaded(output.files);
  // openbao has a chart the offline bundle carries and no evidence subject of its own.
  assert.deepEqual(generatedControls(components, 'openbao'), ['si-07', 'sr-11']);
  assert.ok(output.skipped.some((pair) => pair.component === 'openbao' && pair.control === 'ra-05' && /no evidence/.test(pair.reason)));
  assert.deepEqual(generatedControls(components, 'cert-manager'), ['ra-05', 'si-07', 'sr-11']);
  // relay's npm package never goes through the bundle import, so the import tests back nothing for it.
  assert.deepEqual(generatedControls(components, 'relay'), []);
  const si07 = components.find((component) => component.id === 'openbao')!.implemented.find((requirement) => requirement.control === 'si-07')!.statements[0];
  assert.match(si07.description, /chart openbao 0\.30\.0 \(sha256:bb22\)/);
  assert.doesNotMatch(si07.description, /SBOM|scan/i, 'the import statement claims no SBOM or scan');
});

test('the generator is deterministic, and changing one inventory pin changes only that component\'s file', () => {
  const first = generate(sources());
  const again = generate(sources({ componentFiles: first.files }));
  assert.deepEqual(again.files, first.files, 'running it on its own output changes nothing');
  assert.equal(again.rulesText, first.rulesText);
  const repinned: Inventory = { ...INVENTORY, entries: INVENTORY.entries.map((item) => item.name === 'openbao' ? { ...item, pins: [{ pin: '0.31.0 (sha256:cc33)', where: [CHART_LOCK] }] } : item) };
  const changed = generate(sources({ inventory: repinned, componentFiles: first.files }));
  const differs = changed.files.filter((file, index) => file.text !== first.files[index].text).map((file) => file.file);
  assert.deepEqual(differs, ['compliance/components/openbao.json']);
  assert.match(changed.files.find((file) => file.file.endsWith('/openbao.json'))!.text, /0\.31\.0 \(sha256:cc33\)/);
});

test('the real evidence names tests that exist literally in reported test files', () => {
  for (const evidence of EVIDENCE) {
    assert.ok(isAcceptableRule({ id: 'x', component: 'x', control: evidence.control, statement: 'x', ...evidence.rule }), `${evidence.control}: an acceptable rule`);
    const target = evidence.rule.test;
    if (!target) continue;
    const source = readFileSync(path.join(ROOT, target.file), 'utf8');
    assert.ok(hasStringLiteral(source, target.name), `${target.file}: "${target.name}"`);
  }
});

test('supply-chain-statements --check and coverage --check fail when a generated statement in a component file differs from the generator', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'supply-chain-root-'));
  for (const name of readdirSync(ROOT)) if (!['compliance', '.git', 'node_modules'].includes(name)) symlinkSync(path.join(ROOT, name), path.join(root, name));
  mkdirSync(path.join(root, 'compliance'));
  const copied = ['components', 'evidence-rules', 'coverage', 'applicability'];
  for (const name of readdirSync(path.join(ROOT, 'compliance'))) {
    if (['node_modules', 'out'].includes(name)) continue;
    if (copied.includes(name)) cpSync(path.join(ROOT, 'compliance', name), path.join(root, 'compliance', name), { recursive: true });
    else symlinkSync(path.join(ROOT, 'compliance', name), path.join(root, 'compliance', name));
  }
  const io = () => { const lines: string[] = []; return { lines, stdout: (text: string) => { lines.push(text); }, stderr: (text: string) => { lines.push(text); } }; };
  const write = io();
  assert.equal(await runSupplyChain(['--write', '--root', root], write), 0, write.lines.join(''));
  assert.equal(await runCoverage(['--write', '--root', root], io()), 0);
  const ok = io();
  assert.equal(await runSupplyChain(['--check', '--root', root], ok), 0, ok.lines.join(''));
  const covered = io();
  assert.equal(await runCoverage(['--check', '--root', root], covered), 0, covered.lines.join(''));
  // Edit one generated statement by hand.
  const file = path.join(root, 'compliance', 'components', 'keycloak.json');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /_smt\.inventory/);
  writeFileSync(file, text.replace(/("statement-id":"si-07_smt\.inventory","description":")/, '$1Edited by hand. '));
  const drift = io();
  assert.equal(await runSupplyChain(['--check', '--root', root], drift), 1);
  assert.match(drift.lines.join(''), /compliance\/components\/keycloak\.json/);
  const coverage = io();
  assert.equal(await runCoverage(['--check', '--root', root], coverage), 1);
  assert.match(coverage.lines.join(''), /supply-chain: compliance\/components\/keycloak\.json/);
  assert.equal(await runSupplyChain(['--nonsense', '--root', root], io()), 2);
});
