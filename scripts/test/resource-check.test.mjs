// The compliance fit check (scripts/resource-check.mjs): every third-party resource needs a reviewed register entry before it is used.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { IMAGE_FILES, MODEL_FILES, check, discover, entryProblems, inventory, knownIds, main } from '../resource-check.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-check-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const entry = (id, kind, where, extra = {}) => ({
  id, kind, where, component: 'extension', scope: 'build', purpose: 'p', role: 'r', architectureArea: 'build-and-test', licence: 'MIT', controls: ['sa-15'], evidence: 'none', crypto: 'none',
  cveResponse: 'npm audit', airGap: 'ok', fit: 'pass', reviewer: 'r', reviewedAt: '2026-11-23', supplier: 'Microsoft Corporation', supplierJurisdiction: 'US', ...extra
});

const REPO = {
  'package.json': { devDependencies: { typescript: '5.9.3' } },
  'relay/Dockerfile': `FROM docker.io/library/node:26-slim@${DIGEST} AS build\nFROM build\n`,
  '.github/workflows/ci.yml': `jobs:\n  lint:\n    permissions:\n      statuses: read\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n      - uses: ./local-action\n`,
};
const CLEAN = [
  entry('npm:typescript', 'npm', ['package.json']),
  entry('image:docker.io/library/node', 'image', ['relay/Dockerfile'], { component: 'relay', fit: 'pass-with-conditions', conditions: ['Mirror it.'] }),
  entry('action:actions/checkout', 'action', ['.github/workflows/ci.yml'], { component: 'release-pipeline' }),
];
const run = (files, resources) => {
  const root = fixture(files);
  return check({ resources }, discover(root), { controls: new Set(['sa-15']), components: new Set(['extension', 'relay', 'release-pipeline', 'cert-manager', 'offline-bundle', 'openbao']), areas: new Set(['build-and-test', 'workbench']) });
};
const CHART_LOCK = 'deploy/charts/charts.lock.json';
const TOOL_PINS = 'compliance/ci/tool-pins.json';
const IMAGE_LOCK = 'deploy/bundle/images.lock.json';

test('a clean fixture passes: stage references, local actions and non-uses keys are not resources', () => {
  assert.deepEqual(run(REPO, CLEAN), []);
});

test('a resource with no register entry fails, naming where it is used', () => {
  const problems = run({ ...REPO, 'package.json': { dependencies: { leftpad: '1.0.0' }, devDependencies: { typescript: '5.9.3' } } }, CLEAN);
  assert.deepEqual(problems, ['npm:leftpad (used in package.json) has no entry in compliance/resources.json. Check its compliance fit and add an entry before using it.']);
});

test('a register entry nothing uses any more is stale and fails', () => {
  assert.match(run(REPO, [...CLEAN, entry('npm:gone', 'npm', ['package.json'])]).join('\n'), /npm:gone: nothing in the repository uses it any more/);
});

test('an entry whose fit is fail fails, and the check names the reason', () => {
  const problems = run(REPO, [entry('npm:typescript', 'npm', ['package.json'], { fit: 'fail', conditions: ['Unlicensed.'] }), ...CLEAN.slice(1)]);
  assert.match(problems.join('\n'), /npm:typescript: is marked fail.*Reason: Unlicensed\./);
});

test('pass-with-conditions needs conditions, and a runtime resource that needs the internet or unvalidated crypto cannot be a plain pass', () => {
  const [, image, action] = CLEAN;
  assert.match(run(REPO, [CLEAN[0], { ...image, conditions: [] }, action]).join('\n'), /pass-with-conditions but lists no conditions/);
  const runtime = { ...image, scope: 'runtime', fit: 'pass', conditions: undefined, airGap: 'needs-mirror:registry', crypto: 'unvalidated' };
  const problems = run(REPO, [CLEAN[0], runtime, action]).join('\n');
  assert.match(problems, /not ok air-gapped/);
  assert.match(problems, /unvalidated cryptography/);
});

test('missing or invalid fields, unknown controls and components, and an out-of-date where list fail', () => {
  const bad = { ...CLEAN[0], where: ['relay/package.json'], licence: '', controls: ['zz-99'], component: 'nowhere', reviewedAt: '23/11/2026', crypto: 'strong' };
  const problems = run(REPO, [bad, ...CLEAN.slice(1)]).join('\n');
  for (const expected of [/needs licence/, /control "zz-99" is not in the catalogues/, /component "nowhere"/, /reviewedAt must be a date/, /crypto must be/, /where lists relay\/package.json but it is used in package.json/]) {
    assert.match(problems, expected);
  }
});

test('an entry without a role or an architecture area fails closed, and an area outside the fixed set fails', () => {
  const { role, architectureArea, ...bare } = CLEAN[0];
  assert.ok(role && architectureArea);
  const problems = run(REPO, [bare, ...CLEAN.slice(1)]).join('\n');
  assert.match(problems, /npm:typescript: needs a role/);
  assert.match(problems, /npm:typescript: needs an architectureArea/);
  assert.match(run(REPO, [{ ...CLEAN[0], role: ' ' }, ...CLEAN.slice(1)]).join('\n'), /npm:typescript: needs a role/);
  assert.match(run(REPO, [{ ...CLEAN[0], role: 'p' }, ...CLEAN.slice(1)]).join('\n'), /role repeats purpose/);
  assert.match(run(REPO, [{ ...CLEAN[0], architectureArea: 'somewhere' }, ...CLEAN.slice(1)]).join('\n'), /architectureArea "somewhere" is not one of build-and-test, workbench/);
  assert.match(run(REPO, [{ ...CLEAN[0], roleNeedsReview: false }, ...CLEAN.slice(1)]).join('\n'), /roleNeedsReview is true when present/);
  assert.deepEqual(run(REPO, [{ ...CLEAN[0], roleNeedsReview: true }, ...CLEAN.slice(1)]), []);
});

test('48.4 D-08 supplier fields: supplier is text and supplierJurisdiction an ISO 3166-1 alpha-2 code or unknown, never a name or lower case', () => {
  const withSupplier = (extra) => [{ ...CLEAN[0], ...extra }, ...CLEAN.slice(1)];
  assert.deepEqual(run(REPO, withSupplier({ supplier: 'Eclipse Foundation AISBL', supplierJurisdiction: 'BE' })), []);
  assert.deepEqual(run(REPO, withSupplier({ supplier: 'unknown', supplierJurisdiction: 'unknown' })), []);
  for (const bad of ['Belgium', 'be', '', ['BE'], 'BEL']) {
    assert.deepEqual(run(REPO, withSupplier({ supplier: 'Eclipse Foundation AISBL', supplierJurisdiction: bad })),
      ['compliance/resources.json npm:typescript: supplierJurisdiction must be an ISO 3166-1 alpha-2 code in capitals (CA, US, BE) or unknown.'], JSON.stringify(bad));
  }
  for (const bad of ['', '  ', ['Microsoft'], 42]) {
    assert.deepEqual(run(REPO, withSupplier({ supplier: bad, supplierJurisdiction: 'US' })),
      ['compliance/resources.json npm:typescript: supplier must name the organization that publishes it, or say unknown.'], JSON.stringify(bad));
  }
});

test('48.4 D-08 supplier fields are required: an entry missing either is refused, naming the entry and the field', () => {
  const { supplier, supplierJurisdiction, ...bare } = CLEAN[0];
  assert.ok(supplier && supplierJurisdiction);
  assert.deepEqual(run(REPO, [bare, ...CLEAN.slice(1)]), [
    'compliance/resources.json npm:typescript: supplier must name the organization that publishes it, or say unknown.',
    'compliance/resources.json npm:typescript: supplierJurisdiction must be an ISO 3166-1 alpha-2 code in capitals (CA, US, BE) or unknown.'
  ]);
  assert.deepEqual(run(REPO, [{ ...bare, supplier }, ...CLEAN.slice(1)]),
    ['compliance/resources.json npm:typescript: supplierJurisdiction must be an ISO 3166-1 alpha-2 code in capitals (CA, US, BE) or unknown.']);
  const schema = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'compliance', 'schemas', 'resources.schema.json'), 'utf8'));
  for (const field of ['supplier', 'supplierJurisdiction']) assert.ok(schema.definitions.resource.required.includes(field), `the schema requires ${field}`);
});

test('48.4 D-08 inventory: the --json inventory carries supplier and supplierJurisdiction per entry, unknown as written', () => {
  const root = fixture(REPO);
  const resources = [
    { ...CLEAN[0], supplier: 'Microsoft Corporation', supplierJurisdiction: 'US' },
    { ...CLEAN[1], supplier: 'unknown', supplierJurisdiction: 'unknown' },
    (({ supplier, supplierJurisdiction, ...rest }) => rest)(CLEAN[2])
  ];
  const rows = Object.fromEntries(inventory({ resources }, discover(root)).map((row) => [row.id, row]));
  assert.equal(rows['npm:typescript'].supplier, 'Microsoft Corporation');
  assert.equal(rows['npm:typescript'].supplierJurisdiction, 'US');
  assert.equal(rows['image:docker.io/library/node'].supplier, 'unknown');
  assert.equal(rows['image:docker.io/library/node'].supplierJurisdiction, 'unknown');
  assert.equal(rows['action:actions/checkout'].supplierJurisdiction, null, 'an entry without the field shows null, never a country');
});

test('the check fails when the architecture area list is missing', () => {
  const root = fixture({ ...REPO, 'compliance/resources.json': { resources: CLEAN } });
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = (text) => { errors.push(text); return true; };
  try { assert.equal(main([], root), 1); } finally { process.stderr.write = write; }
  assert.match(errors.join(''), /compliance\/architecture-areas\.json is missing or lists no areas/);
});

test('an action not pinned to a full commit SHA, or an image without a digest, fails', () => {
  const files = { ...REPO, '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n', 'relay/Dockerfile': 'FROM docker.io/library/node:26-slim\n' };
  const problems = run(files, CLEAN).join('\n');
  assert.match(problems, /the action actions\/checkout@v7 is not pinned to a full 40-character commit SHA/);
  assert.match(problems, /the image docker.io\/library\/node:26-slim is not pinned by a sha256 digest/);
});

test('a chart in the chart lock is discovered and needs a register entry', () => {
  const files = { ...REPO, [CHART_LOCK]: { charts: [{ name: 'cert-manager', version: 'v1.21.3', component: 'cert-manager' }] } };
  assert.deepEqual(run(files, CLEAN), [`chart:cert-manager (used in ${CHART_LOCK}) has no entry in compliance/resources.json. Check its compliance fit and add an entry before using it.`]);
  assert.deepEqual(run(files, [...CLEAN, entry('chart:cert-manager', 'chart', [CHART_LOCK], { component: 'cert-manager', scope: 'runtime' })]), []);
});

test('every pinned tool is discovered as a tool resource', () => {
  const files = { ...REPO, [TOOL_PINS]: { cosign: { version: '3.1.4' }, helm: { version: '4.3.2' } } };
  assert.match(run(files, CLEAN).join('\n'), /tool:cosign \(used in compliance\/ci\/tool-pins\.json\) has no entry/);
  const tools = ['tool:cosign', 'tool:helm'].map((id) => entry(id, 'tool', [TOOL_PINS], { component: 'offline-bundle' }));
  assert.deepEqual(run(files, [...CLEAN, ...tools]), []);
});

test('lock images are discovered, an unpinned one fails, and built or release images are not third-party resources', () => {
  const lock = {
    images: [{ ref: `quay.io/openbao/openbao-ubi:2.7.3@${DIGEST}` }, { ref: 'docker.io/example/loose:1.0' }],
    built: [{ name: 'sterling/openbao', image: 'deploy/images/openbao/image.json' }],
    release: [{ name: 'sterling/sterling-workbench' }],
  };
  const images = [entry('image:quay.io/openbao/openbao-ubi', 'image', [IMAGE_LOCK], { component: 'openbao' }), entry('image:docker.io/example/loose', 'image', [IMAGE_LOCK])];
  const problems = run({ ...REPO, [IMAGE_LOCK]: lock }, [...CLEAN, ...images]);
  assert.deepEqual(problems, [`${IMAGE_LOCK}: the image docker.io/example/loose:1.0 is not pinned by a sha256 digest; pin it (name:tag@sha256:...).`]);
  assert.match(run({ ...REPO, [IMAGE_LOCK]: '{ not json' }, CLEAN).join('\n'), /deploy\/bundle\/images\.lock\.json: is not valid JSON/);
});

test('a Containerfile base under deploy/images is discovered; its stage names and ${} references are skipped', () => {
  const file = 'deploy/images/openbao-softhsm/Containerfile';
  const files = { ...REPO, [file]: `FROM registry.access.redhat.com/ubi9/ubi:9.9@${DIGEST} AS softhsm-build\nARG OPENBAO_IMAGE\nFROM \${OPENBAO_IMAGE}\nCOPY --from=softhsm-build /usr/lib64 /usr/lib64\nFROM softhsm-build\n` };
  assert.deepEqual(run(files, CLEAN), [`image:registry.access.redhat.com/ubi9/ubi (used in ${file}) has no entry in compliance/resources.json. Check its compliance fit and add an entry before using it.`]);
  assert.deepEqual(run(files, [...CLEAN, entry('image:registry.access.redhat.com/ubi9/ubi', 'image', [file], { component: 'openbao' })]), []);
});

test('workbench: the package manifest and the Dockerfile beside it are both read; stage names are not images', () => {
  const files = {
    'workbench/package.json': { dependencies: { '@theia/core': '1.77.0' }, devDependencies: { '@theia/cli': '1.77.0' } },
    'workbench/Dockerfile': `FROM a/b:1@${DIGEST} AS node\nFROM c/d:2@${DIGEST} AS build\nFROM build AS runtime\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\n`,
  };
  const { resources, problems } = discover(fixture(files));
  assert.deepEqual(problems, []);
  assert.deepEqual(resources.get('npm:@theia/core'), { id: 'npm:@theia/core', kind: 'npm', where: ['workbench/package.json'], runtime: true });
  assert.deepEqual(resources.get('npm:@theia/cli'), { id: 'npm:@theia/cli', kind: 'npm', where: ['workbench/package.json'] });
  assert.deepEqual(resources.get('image:a/b')?.where, ['workbench/Dockerfile']);
  assert.deepEqual(resources.get('image:c/d')?.where, ['workbench/Dockerfile']);
  for (const stage of ['node', 'build', 'runtime']) assert.equal(resources.has(`image:${stage}`), false, `${stage} is a stage, not an image`);
});

// discover() skips a `FROM ${...}` line, so a base image given through a build argument would escape the pin check and the register.
const argFromFiles = (root, files) => files.filter((file) => /Dockerfile$/.test(file) && existsSync(path.join(root, file)))
  .filter((file) => /^\s*FROM\s+(?:--\S+\s+)*\$\{/im.test(readFileSync(path.join(root, file), 'utf8')));

test('workbench: no Dockerfile the fit check reads names its base image through a build argument', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.ok(IMAGE_FILES.includes('workbench/Dockerfile'));
  assert.deepEqual(argFromFiles(repo, IMAGE_FILES), []);
  const root = fixture({ 'workbench/Dockerfile': `ARG BASE\nFROM --platform=linux/amd64 \${BASE} AS build\n`, 'hub/Dockerfile': `FROM a/b:1@${DIGEST}\n` });
  assert.deepEqual(argFromFiles(root, IMAGE_FILES), ['workbench/Dockerfile']);
});

// Phase 74.1-01 (D-10): every shipped model passport is a `model` resource with a reviewed licence and fit entry.
const PASSPORTS = 'src/domain/gate/shippedPassports.ts';
const modelEntry = (id) => entry(id, 'model', [PASSPORTS], { component: 'model-endpoints', scope: 'runtime', fit: 'pass-with-conditions', conditions: ['Research only.'] });

test('a shipped passport id line is discovered as a model resource', () => {
  assert.deepEqual([...MODEL_FILES], [PASSPORTS]);
  const text = "export const SHIPPED = [\n  row({\n    id: 'openai/gpt-oss',\n    match: ['openai/gpt-oss-120b'],\n    licence: { inherited: [], id: 'Apache-2.0', obligations: [] }\n  })\n];\n";
  const { resources, problems } = discover(fixture({ [PASSPORTS]: text }));
  assert.deepEqual(problems, []);
  assert.deepEqual(resources.get('model:openai/gpt-oss'), { id: 'model:openai/gpt-oss', kind: 'model', where: [PASSPORTS] });
  assert.equal([...resources.keys()].filter((id) => id.startsWith('model:')).length, 1, 'only row id lines are models');
});

test('a shipped passport with no register entry fails, and a model entry nothing discovers is stale', () => {
  const files = { ...REPO, [PASSPORTS]: "  row({\n    id: 'openai/gpt-oss',\n  }),\n" };
  const known = { controls: new Set(['sa-15']), components: new Set(['extension', 'relay', 'release-pipeline', 'model-endpoints']), areas: new Set(['build-and-test', 'workbench']) };
  const missing = check({ resources: CLEAN }, discover(fixture(files)), known);
  assert.deepEqual(missing, [`model:openai/gpt-oss (used in ${PASSPORTS}) has no entry in compliance/resources.json. Check its compliance fit and add an entry before using it.`]);
  assert.deepEqual(check({ resources: [...CLEAN, modelEntry('model:openai/gpt-oss')] }, discover(fixture(files)), known), []);
  const stale = check({ resources: [...CLEAN, modelEntry('model:openai/gpt-oss'), modelEntry('model:example/gone')] }, discover(fixture(files)), known);
  assert.match(stale.join('\n'), /model:example\/gone: nothing in the repository uses it any more/);
});

test('a model entry needs the model: prefix', () => {
  assert.deepEqual(entryProblems(modelEntry('model:openai/gpt-oss')), []);
  assert.match(entryProblems(modelEntry('npm:openai/gpt-oss')).join('\n'), /the id of a model resource starts with "model:"/);
});

test('the repository itself passes the check, against the real catalogues and components', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.ok(knownIds(root).controls.has('sr-03'), 'the control catalogues are loaded');
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = (text) => { errors.push(text); return true; };
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try { assert.equal(main([], root), 0, errors.join('')); } finally { process.stderr.write = write; process.stdout.write = stdout; }
});
