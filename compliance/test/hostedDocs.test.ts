// Generated blocks in the hosted SA&A documents (48.1-01, D-02, D-09, D-10): every block in compliance/src/hosted/blocks/ matches its committed
// document, a changed source makes `hosted-docs --check` fail until `--write`, the documents collector fails a hosted document whose block
// is stale, and the exchange register is checked against the deploy code that signs and verifies exchanged files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentsCollector, REQUIRED_DOCUMENTS } from '../src/collectors/documents.ts';
import { run as runHostedDocs } from '../src/commands/hosted-docs.ts';
import { checkAll, fileSource, findBlocks, loadBlocks, replaceBlock } from '../src/hosted/generate.ts';
import { EXCHANGES_FILE, checkExchanges, renderTable, signingCallSites } from '../src/hosted/blocks/exchanges.ts';
import { validateOurs } from '../src/validate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTERCONNECTIONS = 'docs/security/hosted-interconnections.md';
const COMMIT = 'c'.repeat(40);
const exchanges = () => JSON.parse(readFileSync(path.join(ROOT, EXCHANGES_FILE), 'utf8'));

/** A temporary root holding copies of the exchange source and the hosted documents, with the code the checks read linked in. */
function copyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hosted-docs-'));
  mkdirSync(path.join(root, 'compliance', 'hosted'), { recursive: true });
  cpSync(path.join(ROOT, 'compliance', 'hosted'), path.join(root, 'compliance', 'hosted'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  cpSync(path.join(ROOT, 'docs', 'security'), path.join(root, 'docs', 'security'), { recursive: true });
  for (const linked of ['deploy', '.github', 'compliance/src', 'compliance/site-export']) symlinkSync(path.join(ROOT, linked), path.join(root, linked));
  return root;
}

async function quietly(args: string[]): Promise<{ code: number; text: string }> {
  let text = '';
  const code = await runHostedDocs(args, { stdout: (chunk) => { text += chunk; }, stderr: (chunk) => { text += chunk; } });
  return { code, text };
}

test('every generated block matches its committed document', async () => {
  const blocks = await loadBlocks();
  assert.ok(blocks.some((block) => block.id === 'exchanges'), 'the exchanges block is found by directory listing');
  for (const block of blocks) {
    const text = readFileSync(path.join(ROOT, block.document), 'utf8');
    const found = findBlocks(text).get(block.id);
    assert.ok(found !== undefined, `${block.document} holds the markers of block ${block.id}`);
    assert.equal(found, await block.render(fileSource(ROOT)), `${block.document}: block ${block.id} is current`);
  }
  const result = await checkAll(ROOT, blocks);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.stale, []);
});

test('a changed exchange makes --check fail until --write regenerates the document', async () => {
  const root = copyRoot();
  assert.equal((await quietly(['--check', '--root', root])).code, 0);
  const source = path.join(root, EXCHANGES_FILE);
  const data = JSON.parse(readFileSync(source, 'utf8'));
  data.exchanges.find((exchange: { id: string }) => exchange.id === 'offline-bundle').frequency = 'Every hour';
  writeFileSync(source, `${JSON.stringify(data, null, 2)}\n`);
  const stale = await quietly(['--check', '--root', root]);
  assert.equal(stale.code, 1);
  assert.match(stale.text, /hosted-interconnections\.md: block exchanges is out of date/);
  assert.equal((await quietly(['--write', '--root', root])).code, 0);
  assert.equal((await quietly(['--check', '--root', root])).code, 0);
  assert.match(readFileSync(path.join(root, INTERCONNECTIONS), 'utf8'), /Every hour/);
});

test('the exchange register document passes its documents observation on the real repository', async () => {
  const observations = await documentsCollector.collect({ repoRoot: ROOT }, { now: new Date(), commit: COMMIT, readFile: (file) => readFile(file, 'utf8') });
  const observation = observations.find((entry) => entry.subject === INTERCONNECTIONS);
  assert.equal(observation?.passed, true, JSON.stringify(observation));
  assert.equal(observation?.counts?.['stale-blocks'], 0);
  const security = observations.find((entry) => entry.subject === 'security.md');
  assert.equal(security?.counts?.['stale-blocks'] ?? 0, 0, 'a document without generated blocks reports no stale block');
});

test('a hand edit inside a generated block fails the document observation with a stale-blocks count of 1', async () => {
  const original = readFileSync(path.join(ROOT, INTERCONNECTIONS), 'utf8');
  const edited = replaceBlock(original, 'exchanges', `${findBlocks(original).get('exchanges')}\n| An extra row |`);
  const readFileStub = async (file: string) => (file === path.join(ROOT, INTERCONNECTIONS) ? edited : readFile(file, 'utf8'));
  const observations = await documentsCollector.collect({ repoRoot: ROOT }, { now: new Date(), commit: COMMIT, readFile: readFileStub });
  const observation = observations.find((entry) => entry.subject === INTERCONNECTIONS);
  assert.equal(observation?.passed, false);
  assert.equal(observation?.counts?.['stale-blocks'], 1);
});

test('every hosted SA&A document of D-08 is a required document with its fixed headings', () => {
  const expected: Record<string, string[]> = {
    'docs/security/hosted-interconnections.md': ['Exchanges and interconnections', 'Exchange diagram', 'Agreements'],
    'docs/security/hosted-external-services.md': ['External services', 'Adding a service'],
    'docs/security/hosted-architecture.md': ['Network and boundary', 'Ports, protocols and services', 'Workload rights'],
    'docs/security/hosted-system-description.md': ['System', 'Information types', 'Authorization boundary', 'What the site inherits', 'Users and roles', 'Diagrams'],
    'docs/security/hosted-audit.md': ['Alerts', 'Audit review', 'Archive and integrity', 'Retention'],
    'docs/security/hosted-key-management.md': ['Key inventory', 'Lifecycle', 'Hardware security module', 'Signing keys', 'Compromise and revocation', 'Known limits'],
    'docs/security/hosted-crypto-inventory.md': ['Components', 'Open conditions'],
    'docs/security/hosted-suppliers.md': ['Suppliers', 'Assessment and notification'],
    'docs/security/hosted-roles-and-duties.md': ['Roles', 'Separation of duties', 'Training'],
    'docs/security/hosted-privacy.md': ['Personal information inventory', 'Retention and disposal', 'Testing and training data', 'Privacy impact assessment inputs'],
    'docs/security/hosted-incident-playbooks.md': ['Signing key compromise', 'HQ root or intermediate compromise', 'HSM loss or tamper', 'Unseal failure', 'Person key or passkey compromise', 'Spill to an observer', 'Credential issuer or status-list key compromise', 'Stale status list at an edge'],
    'docs/security/hosted-continuous-monitoring.md': ['What is monitored', 'Cadence', 'Disconnected sites', 'Reviews and triggers'],
    'docs/security/hosted-observers.md': ['Releasability tokens', 'Authority', 'Agreements and clearances', 'Rules of behaviour']
  };
  for (const [file, headings] of Object.entries(expected)) {
    const document = REQUIRED_DOCUMENTS.find((entry) => entry.path === file);
    assert.ok(document, `${file} is required`);
    assert.equal(document.reviewRequired, true, `${file} needs a review date`);
    assert.deepEqual(document.headings, headings, `${file} headings`);
  }
});

test('the hosted generator and its command import only Node built-ins and their own folder, and the docs job runs the check', () => {
  const hosted = path.join(ROOT, 'compliance', 'src', 'hosted');
  const files = [path.join(ROOT, 'compliance', 'src', 'commands', 'hosted-docs.ts'),
    ...readdirSync(hosted, { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).map((file) => path.join(hosted, file))];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(`${hosted}${path.sep}`), `${path.relative(ROOT, file)} imports ${specifier}`);
    }
  }
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const docsJob = /\n {2}docs:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n)/.exec(ci)?.[1] ?? '';
  assert.match(docsJob, /working-directory: \.\n\s+run: node compliance\/src\/cli\.ts hosted-docs --check/);
});

test('the exchange register validates against its schema and says the agreement is to be completed', () => {
  const data = exchanges();
  assert.deepEqual(validateOurs(data, 'exchanges'), { ok: true, errors: [] });
  const text = readFileSync(path.join(ROOT, INTERCONNECTIONS), 'utf8');
  const table = findBlocks(text).get('exchanges') ?? '';
  for (const exchange of data.exchanges) {
    if (exchange.agreement === 'To be completed by your organization') assert.match(table, new RegExp(`\`${exchange.id}\`[^\\n]*To be completed by your organization`), exchange.id);
  }
});

test('every deploy module that signs or verifies a file is named by an implemented exchange; a module named by none is reported', () => {
  const sites = signingCallSites(ROOT);
  for (const expected of ['deploy/bundle/build.mjs', 'deploy/bundle/check.mjs', 'deploy/bundle/import.mjs', 'deploy/bundle/signed-file.mjs', 'deploy/keycloak/users.mjs', 'deploy/openbao/pki-files.mjs']) {
    assert.ok(sites.includes(expected), `${expected} is found as a signing call site`);
  }
  assert.ok(!sites.some((file) => file.startsWith('deploy/test/')), 'tests are not call sites');
  assert.ok(!sites.includes('deploy/bundle/lib/cosign.mjs'), 'a module that only defines the functions is not a call site');
  assert.deepEqual(checkExchanges(ROOT, exchanges()), { problems: [], warnings: [] });

  const probe = mkdtempSync(path.join(tmpdir(), 'hosted-docs-probe-'));
  mkdirSync(path.join(probe, 'deploy', 'tools'), { recursive: true });
  writeFileSync(path.join(probe, 'deploy', 'tools', 'export-thing.mjs'), "import { signFile } from '../bundle/signed-file.mjs';\nsignFile(process.argv[2], process.argv[3]);\n");
  assert.deepEqual(signingCallSites(probe), ['deploy/tools/export-thing.mjs']);
  const result = checkExchanges(probe, { exchanges: [] });
  assert.ok(result.problems.some((problem) => problem.includes('deploy/tools/export-thing.mjs')), result.problems.join('\n'));
});

test('a planned exchange accepts its module, and warns without failing once the module exists', () => {
  const probe = mkdtempSync(path.join(tmpdir(), 'hosted-docs-planned-'));
  mkdirSync(path.join(probe, 'deploy', 'tools'), { recursive: true });
  const planned = { exchanges: [{ ...exchanges().exchanges.find((exchange: { status: string }) => exchange.status === 'planned'), implementedBy: ['deploy/tools/export-thing.mjs'], siteSettings: [] }] };
  assert.deepEqual(checkExchanges(probe, planned), { problems: [], warnings: [] }, 'not built yet: nothing to say');
  writeFileSync(path.join(probe, 'deploy', 'tools', 'export-thing.mjs'), "import { signFile } from '../bundle/signed-file.mjs';\nsignFile('a', 'b');\n");
  const result = checkExchanges(probe, planned);
  assert.deepEqual(result.problems, [], 'another phase landing its module is never blocked');
  assert.ok(result.warnings.some((warning) => warning.includes('mark it implemented')), result.warnings.join('\n'));
});

test('implemented exchanges name files that exist, planned ones name their plan, and every site setting exists in the site example', () => {
  const data = exchanges();
  const broken = structuredClone(data);
  broken.exchanges[0].implementedBy = ['deploy/bundle/no-such-file.mjs'];
  broken.exchanges[1].siteSettings = ['site.example.yaml#noSuchSetting'];
  const plannedIndex = broken.exchanges.findIndex((exchange: { status: string }) => exchange.status === 'planned');
  delete broken.exchanges[plannedIndex].plannedIn;
  const result = checkExchanges(ROOT, broken);
  assert.ok(result.problems.some((problem) => problem.includes('deploy/bundle/no-such-file.mjs')), result.problems.join('\n'));
  assert.ok(result.problems.some((problem) => problem.includes('noSuchSetting')), result.problems.join('\n'));
  assert.ok(result.problems.some((problem) => problem.includes('plannedIn')), result.problems.join('\n'));
});

// 48.4 D-08: whose law governs the operator of each exchange's far end, and where that end is.
const fixtureExchange = <T extends Record<string, unknown>>(extra: T) => ({
  id: 'probe', title: 'Probe', kind: 'network', from: 'A', to: 'B', direction: 'one-way', data: 'Data.', format: 'JSON.', protection: 'TLS.',
  frequency: 'Daily.', status: 'planned', plannedIn: 'Phase 99', siteSettings: [], controls: ['ca-3'], agreement: 'To be completed by your organization', ...extra
});
const columnsOf = (table: string, id: string): string[] => {
  const header = table.split('\n')[0].split(' | ').map((cell) => cell.replace(/^\| |\|$/g, '').trim());
  const row = table.split('\n').find((line) => line.includes(`(\`${id}\`)`)) ?? '';
  const cells = row.split(' | ').map((cell) => cell.replace(/^\| | \|$/g, '').trim());
  return [header.indexOf('Operator under'), header.indexOf('Far end')].map((at) => (at >= 0 ? cells[at] : ''));
};

test('48.4 D-08 exchange jurisdiction: the table shows whose law the far end\'s operator is under and where that end is, in plain words', () => {
  const table = renderTable({ exchanges: [
    fixtureExchange({ id: 'probe-us', operatorJurisdiction: 'US', location: 'unknown' }),
    fixtureExchange({ id: 'probe-org', operatorJurisdiction: 'org', location: 'site' }),
    fixtureExchange({ id: 'probe-ca', operatorJurisdiction: 'unknown', location: 'CA' })
  ] } as never);
  assert.match(table.split('\n')[0], /\| Operator under \| Far end \|/);
  assert.deepEqual(columnsOf(table, 'probe-us'), ['US', 'unknown']);
  assert.deepEqual(columnsOf(table, 'probe-org'), ['your organization', 'at the site']);
  assert.deepEqual(columnsOf(table, 'probe-ca'), ['unknown', 'CA']);
  // The real register's document carries both columns for every exchange.
  const document = findBlocks(readFileSync(path.join(ROOT, INTERCONNECTIONS), 'utf8')).get('exchanges') ?? '';
  for (const exchange of exchanges().exchanges) assert.deepEqual(columnsOf(document, exchange.id).every((value) => value.length > 0), true, exchange.id);
});

test('48.4 D-08 refused: an exchange without its operator jurisdiction or location, or with a country name, fails the check naming the exchange', () => {
  const probe = mkdtempSync(path.join(tmpdir(), 'hosted-docs-jurisdiction-'));
  const ok = fixtureExchange({ operatorJurisdiction: 'US', location: 'unknown' });
  assert.deepEqual(checkExchanges(probe, { exchanges: [ok] } as never), { problems: [], warnings: [] });
  const { operatorJurisdiction, location, ...bare } = ok;
  assert.ok(operatorJurisdiction && location);
  assert.deepEqual(checkExchanges(probe, { exchanges: [bare] } as never).problems, [
    'exchange probe: operatorJurisdiction must be an ISO 3166-1 alpha-2 code in capitals, org (your organization operates it) or unknown',
    'exchange probe: location must be an ISO 3166-1 alpha-2 code in capitals, site (inside the site) or unknown'
  ]);
  assert.deepEqual(checkExchanges(probe, { exchanges: [{ ...ok, operatorJurisdiction: 'Canada' }] } as never).problems,
    ['exchange probe: operatorJurisdiction must be an ISO 3166-1 alpha-2 code in capitals, org (your organization operates it) or unknown']);
  assert.deepEqual(checkExchanges(probe, { exchanges: [{ ...ok, location: 'org' }] } as never).problems,
    ['exchange probe: location must be an ISO 3166-1 alpha-2 code in capitals, site (inside the site) or unknown']);
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'compliance', 'schemas', 'exchanges.schema.json'), 'utf8'));
  for (const field of ['operatorJurisdiction', 'location']) assert.ok(schema.definitions.exchange.required.includes(field), `the schema requires ${field}`);
});

test('the exchange diagram names every exchange id exactly once', () => {
  const text = readFileSync(path.join(ROOT, INTERCONNECTIONS), 'utf8');
  const diagram = findBlocks(text).get('exchange-diagram') ?? '';
  assert.match(diagram, /^```mermaid\nflowchart LR\n/);
  for (const exchange of exchanges().exchanges) {
    assert.equal(diagram.split(`|"${exchange.id}"|`).length - 1, 1, exchange.id);
  }
});

test('a malformed marker or a missing blocks folder ends hosted-docs with exit 1 and one plain line, not a stack trace', async () => {
  const root = copyRoot();
  const file = path.join(root, INTERCONNECTIONS);
  writeFileSync(file, readFileSync(file, 'utf8').replace('<!-- generated:exchanges end -->\n', ''));
  for (const mode of ['--write', '--check']) {
    let text = '';
    const code = await runHostedDocs([mode, '--root', root], { stdout: (chunk) => { text += chunk; }, stderr: (chunk) => { text += chunk; } });
    assert.equal(code, 1, mode);
    assert.match(text, /generated block exchange-diagram begins inside block exchanges|generated block exchanges has no end marker/, mode);
    assert.doesNotMatch(text, /\n\s+at /, `${mode}: no stack trace`);
  }
  const empty = mkdtempSync(path.join(tmpdir(), 'hosted-blocks-'));
  const cases: Array<[string, RegExp]> = [
    [path.join(empty, 'missing'), /^hosted-docs: the hosted blocks folder .* does not exist\n$/],
    [empty, /^hosted-docs: the hosted blocks folder .* has no block modules/]
  ];
  for (const [blocksDir, expected] of cases) {
    let text = '';
    const code = await runHostedDocs(['--check'], { stdout: (chunk) => { text += chunk; }, stderr: (chunk) => { text += chunk; }, blocksDir });
    assert.equal(code, 1, blocksDir);
    assert.match(text, expected);
  }
});
