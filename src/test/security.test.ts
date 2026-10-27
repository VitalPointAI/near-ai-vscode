import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { securityTool } from '../agent/securityTool';
import { purlFor, readLockfiles } from '../security/lockfiles';
import { compareVersions, cvss3Score, queryOsv } from '../security/osv';
import { checkRuntimes, declaredRuntimes } from '../security/runtimes';
import { CI_WORKFLOW, SBOM_FILE, scanProject, scanSummary } from '../security/scan';

// Dependency SBOMs and vulnerability checks. OSV.dev and endoflife.date are faked here; the live
// services were checked by hand and by `npm run sbom`.

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sbom-'));
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}

const LOCKFILES: Record<string, string> = {
  'web/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'web' }, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/@babel/core': { version: '7.24.0', dev: true }, 'node_modules/a/node_modules/lodash': { version: '4.17.21' }, 'node_modules/local': { link: true, resolved: '../local' } } }, null, 2),
  'yarn1/yarn.lock': '# yarn lockfile v1\n\n"left-pad@^1.3.0", left-pad@~1.3:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n\n"@types/node@^20":\n  version "20.11.5"\n',
  'berry/yarn.lock': '__metadata:\n  version: 8\n\n"chalk@npm:^5.0.0":\n  version: 5.3.0\n  resolution: "chalk@npm:5.3.0"\n\n"berry@workspace:.":\n  version: 0.0.0-use.local\n',
  'pn/pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies: {}\n\npackages:\n\n  express@4.18.2:\n    resolution: {integrity: sha512-x}\n\n  '@scope/pkg@1.0.0(react@18.2.0)':\n    resolution: {integrity: sha512-y}\n\nsnapshots: {}\n",
  'py/poetry.lock': '[[package]]\nname = "Django"\nversion = "4.2.1"\ncategory = "main"\n\n[[package]]\nname = "pytest"\nversion = "8.0.0"\ncategory = "dev"\n',
  'uvp/uv.lock': 'version = 1\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n',
  'pipenv/Pipfile.lock': JSON.stringify({ default: { flask: { version: '==2.2.0' } }, develop: { black: { version: '==24.1.0' } } }),
  'req/requirements.txt': 'Jinja2==3.1.2\nurllib3[socks]==1.26.5 ; python_version >= "3"\nrequests>=2\n# comment\n-r other.txt\n',
  'gomod/go.mod': 'module example.com/app\n\ngo 1.21\n\nrequire (\n\tgolang.org/x/net v0.17.0\n\tgithub.com/gin-gonic/gin v1.9.0 // indirect\n)\n\nrequire github.com/pkg/errors v0.9.1\n',
  'rust/Cargo.lock': 'version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.190"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  'php/composer.lock': JSON.stringify({ packages: [{ name: 'guzzlehttp/guzzle', version: 'v7.4.0' }], 'packages-dev': [{ name: 'phpunit/phpunit', version: '10.0.0' }] }),
  'ruby/Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    nokogiri (1.15.0-x86_64-linux)\n      racc (~> 1.4)\n    rails (7.0.4)\n\nPLATFORMS\n  x86_64-linux\n',
  'net/packages.lock.json': JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.1' }, MyLib: { type: 'Project' } } } }),
  'jvm/gradle.lockfile': 'com.google.guava:guava:31.1-jre=compileClasspath,runtimeClasspath\norg.junit:junit-bom:5.9.0=testCompileClasspath\nempty=\n',
  'mvn/pom.xml': '<project><properties><jackson.version>2.13.0</jackson.version></properties><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency><dependency><groupId>x</groupId><artifactId>y</artifactId><version>${missing}</version></dependency></dependencies></project>',
  'web/node_modules/ignored/package-lock.json': JSON.stringify({ packages: { 'node_modules/evil': { version: '1.0.0' } } })
};

test('lockfiles from every supported ecosystem become exact components with purls and lines', async () => {
  const root = await project(LOCKFILES);
  const report = await readLockfiles(root);
  const purls = report.components.map((component) => component.purl);
  for (const expected of [
    'pkg:npm/lodash@4.17.20', 'pkg:npm/lodash@4.17.21', 'pkg:npm/%40babel/core@7.24.0', 'pkg:npm/left-pad@1.3.0', 'pkg:npm/%40types/node@20.11.5', 'pkg:npm/chalk@5.3.0', 'pkg:npm/express@4.18.2', 'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:pypi/django@4.2.1', 'pkg:pypi/pytest@8.0.0', 'pkg:pypi/requests@2.31.0', 'pkg:pypi/flask@2.2.0', 'pkg:pypi/black@24.1.0', 'pkg:pypi/jinja2@3.1.2', 'pkg:pypi/urllib3@1.26.5',
    'pkg:golang/golang.org/x/net@v0.17.0', 'pkg:golang/github.com/gin-gonic/gin@v1.9.0', 'pkg:golang/github.com/pkg/errors@v0.9.1', 'pkg:cargo/serde@1.0.190',
    'pkg:composer/guzzlehttp/guzzle@7.4.0', 'pkg:composer/phpunit/phpunit@10.0.0', 'pkg:gem/nokogiri@1.15.0', 'pkg:gem/rails@7.0.4', 'pkg:nuget/Newtonsoft.Json@13.0.1',
    'pkg:maven/com.google.guava/guava@31.1-jre', 'pkg:maven/org.junit/junit-bom@5.9.0', 'pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.13.0'
  ]) assert.ok(purls.includes(expected), `${expected} missing from ${purls.join(', ')}`);
  for (const absent of ['local', 'berry', 'app', 'evil', 'racc', 'MyLib', 'y']) assert.ok(!report.components.some((component) => component.name === absent), `${absent} should not be listed`);
  assert.ok(!purls.some((purl) => purl.includes('pypi/requests@2') && !purl.endsWith('2.31.0')), 'the unpinned requests>=2 is not guessed');
  assert.match(report.notes.join('\n'), /req\/requirements\.txt has 1 requirement\(s\) without an exact version/);
  const babel = report.components.find((component) => component.name === '@babel/core')!;
  assert.deepEqual([babel.development, babel.source], [true, 'web/package-lock.json']);
  assert.equal(report.components.find((component) => component.name === 'pytest')!.development, true);
  assert.equal(report.components.find((component) => component.purl === 'pkg:npm/lodash@4.17.20')!.line, 1 + JSON.stringify(JSON.parse(LOCKFILES['web/package-lock.json']), null, 2).split('\n').findIndex((line) => line.includes('"node_modules/lodash"')));
  assert.ok(!report.files.some((file) => file.includes('node_modules')), 'installed packages\' own lockfiles are skipped');
  assert.equal(purlFor('npm', '@a/b', '1.0.0-rc.1+x'), 'pkg:npm/%40a/b@1.0.0-rc.1%2Bx');
});

function fakeOsv(vulns: Record<string, unknown>, byPurl: Record<string, Array<{ id: string }>>, calls: string[] = []) {
  return (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/querybatch')) {
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { purl: string }; page_token?: string }> };
      return new Response(JSON.stringify({ results: body.queries.map((query) => {
        const all = byPurl[query.package.purl] ?? [];
        if (all.length > 1 && !query.page_token) return { vulns: all.slice(0, 1), next_page_token: 'page-2' };
        return all.length ? { vulns: query.page_token ? all.slice(1) : all } : {};
      }) }));
    }
    const id = decodeURIComponent(url.split('/').pop()!);
    return vulns[id] ? new Response(JSON.stringify(vulns[id])) : new Response('{}', { status: 404 });
  }) as typeof fetch;
}

const LODASH_VULNS = {
  'GHSA-aaaa': { id: 'GHSA-aaaa', summary: 'Prototype pollution in lodash', aliases: ['CVE-2021-23337'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }], database_specific: { cwe_ids: ['CWE-94'] }, affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }, { type: 'SEMVER', events: [{ introduced: '3.0.0' }, { fixed: '3.10.2' }] }] }] },
  'GHSA-bbbb': { id: 'GHSA-bbbb', summary: 'ReDoS', database_specific: { severity: 'MODERATE' }, affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }] },
  'GHSA-gone': { id: 'GHSA-gone', summary: 'Withdrawn', withdrawn: '2024-01-01T00:00:00Z', affected: [] }
};

test('OSV results give severity from CVSS or the advisory, the next fixed version, and skip withdrawn advisories', async () => {
  const component = { ecosystem: 'npm' as const, name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20', source: 'package-lock.json' };
  const safe = { ...component, version: '4.17.21', purl: 'pkg:npm/lodash@4.17.21' };
  const findings = await queryOsv([component, safe], { fetch: fakeOsv(LODASH_VULNS, { [component.purl]: [{ id: 'GHSA-bbbb' }, { id: 'GHSA-aaaa' }, { id: 'GHSA-gone' }] }) });
  assert.equal(findings.length, 1);
  const [high, medium] = findings[0].vulnerabilities;
  assert.deepEqual([high.id, high.severity, high.score, high.fixed, high.aliases, high.cwes], ['GHSA-aaaa', 'high', 7.2, ['4.17.21'], ['CVE-2021-23337'], ['CWE-94']]);
  assert.deepEqual([medium.id, medium.severity, medium.score], ['GHSA-bbbb', 'medium', undefined]);
  assert.equal(findings[0].vulnerabilities.length, 2, 'the withdrawn advisory is left out, and the paged result was followed');
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H'), 9.9);
  assert.equal(cvss3Score('CVSS:4.0/AV:N'), undefined);
  assert.deepEqual(['1.2.10', '1.2.9', '1.2.9-beta', 'v1.3'].sort(compareVersions), ['1.2.9-beta', '1.2.9', '1.2.10', 'v1.3']);
});

function fakeEol(products: Record<string, unknown[]>) {
  return (async (url: string) => {
    const product = url.split('/').pop()!;
    return products[product] ? new Response(JSON.stringify({ result: { releases: products[product] } })) : new Response('{}', { status: 404 });
  }) as typeof fetch;
}
const NODE_RELEASES = [{ name: '24', isEol: false, latest: { name: '24.21.0' } }, { name: '22', isEol: false, latest: { name: '22.20.0' } }, { name: '18', isEol: true, eolFrom: '2025-04-30', latest: { name: '18.20.8' } }];

test('runtimes: declared and installed versions are checked for end of life and missing patches', async () => {
  const root = await project({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }), '.nvmrc': 'v22.15.0\n', 'pyproject.toml': '[project]\nrequires-python = ">=3.12"\n' });
  const declared = await declaredRuntimes(root);
  assert.deepEqual(declared.map((entry) => [entry.runtime, entry.version, entry.source]), [['node', '18', 'package.json engines.node'], ['node', '22.15.0', '.nvmrc'], ['python', '3.12', 'pyproject.toml requires-python']]);
  const findings = await checkRuntimes([...declared.filter((entry) => entry.runtime === 'node'), { runtime: 'node', version: '18.19.0', source: 'node on this machine', kind: 'installed' }, { runtime: 'node', version: '24.21.0', source: 'node on this machine', kind: 'installed' }, { runtime: 'node', version: '22.15.0', source: 'node on this machine', kind: 'installed' }], { fetch: fakeEol({ nodejs: NODE_RELEASES }) });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.runtime.version, finding.runtime.kind]), [['medium', '18', 'declared'], ['high', '18.19.0', 'installed'], ['low', '22.15.0', 'installed']]);
  assert.match(findings[0].summary, /package\.json engines\.node allows Node\.js 18, which reached end of life on 2025-04-30/);
  assert.match(findings[2].summary, /behind the latest 22\.x patch, 22\.20\.0/);
});

test('a scan writes a CycloneDX SBOM with components, runtimes, and vulnerabilities, and leaves it alone when nothing changed', async () => {
  const root = await project({ 'package-lock.json': LOCKFILES['web/package-lock.json'], 'package.json': JSON.stringify({ engines: { node: '>=22' } }) });
  const fetchFn = (async (url: string, init?: RequestInit) => (url.includes('endoflife.date') ? fakeEol({ nodejs: NODE_RELEASES }) : fakeOsv(LODASH_VULNS, { 'pkg:npm/lodash@4.17.20': [{ id: 'GHSA-aaaa' }] }))(url, init)) as typeof fetch;
  const options = { fetch: fetchFn, run: async () => 'v24.21.0', now: () => new Date('2026-10-27T12:00:00Z'), tool: { name: 'NEAR AI for VS Code', version: '0.4.0' } };
  const report = await scanProject(root, options);
  assert.equal(report.sbomWritten, true);
  const bom = JSON.parse(await readFile(path.join(root, SBOM_FILE), 'utf8'));
  assert.deepEqual([bom.bomFormat, bom.specVersion, bom.version], ['CycloneDX', '1.6', 1]);
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.deepEqual(bom.metadata.properties.find((property: { name: string }) => property.name === 'near-ai:scan:status').value, 'vulnerabilities-found');
  const refs = new Set(bom.components.map((component: { 'bom-ref': string }) => component['bom-ref']));
  assert.ok(bom.components.some((component: { type: string; name: string; version: string }) => component.type === 'platform' && component.name === 'node' && component.version === '24.21.0'));
  assert.equal(bom.vulnerabilities.length, 1);
  const [vuln] = bom.vulnerabilities;
  assert.deepEqual([vuln.id, vuln.ratings[0].severity, vuln.ratings[0].score, vuln.cwes, vuln.recommendation], ['GHSA-aaaa', 'high', 7.2, [94], 'Upgrade lodash to 4.17.21 or later.']);
  assert.ok(bom.vulnerabilities.every((entry: { affects: Array<{ ref: string }> }) => entry.affects.every((affect) => refs.has(affect.ref))), 'every vulnerability points at a listed component');
  assert.match(scanSummary(report), /\[high 7\.2\] lodash 4\.17\.20 \(package-lock\.json\): GHSA-aaaa \/ CVE-2021-23337 Prototype pollution in lodash Fixed in 4\.17\.21\./);
  const written = (await stat(path.join(root, SBOM_FILE))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await scanProject(root, { ...options, now: () => new Date('2026-10-28T12:00:00Z'), write: 'if-changed' });
  assert.equal(again.sbomWritten, false, 'an automatic scan with the same results does not rewrite the file');
  assert.equal((await stat(path.join(root, SBOM_FILE))).mtimeMs, written);
});

test('when OSV.dev cannot be reached the SBOM is still written and the result says incomplete, not clean', async () => {
  const root = await project({ 'package-lock.json': LOCKFILES['web/package-lock.json'] });
  const report = await scanProject(root, { fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND api.osv.dev'); }) as typeof fetch, run: async () => '' });
  assert.match(report.errors.join(), /Could not check dependencies on OSV\.dev: getaddrinfo ENOTFOUND/);
  const bom = JSON.parse(await readFile(path.join(root, SBOM_FILE), 'utf8'));
  assert.equal(bom.metadata.properties.find((property: { name: string }) => property.name === 'near-ai:scan:status').value, 'incomplete');
  assert.match(scanSummary(report), /the check was incomplete/);
});

test('the agent\'s SecurityScan tool asks for consent first, and offers a pinned CI workflow', async () => {
  let scans = 0;
  const tool = securityTool({ consented: () => false, scan: async () => { scans += 1; return undefined; } });
  assert.match(await tool.run(tool.parse({}), {} as never), /not enabled for this project.*say plainly that dependencies were not checked/s);
  assert.equal(scans, 0, 'nothing is sent without consent');
  const workflow = await tool.run(tool.parse({ workflow: true }), {} as never);
  assert.match(workflow, /osv-scanner-reusable\.yml@b1d267aea5211fa648d9d442fa64b90dbdcbdd36 # v2\.7\.0/);
  assert.match(CI_WORKFLOW, /schedule:\n {4}- cron: "30 6 \* \* 1"/);
  assert.match(CI_WORKFLOW, /pull_request:/);
});
