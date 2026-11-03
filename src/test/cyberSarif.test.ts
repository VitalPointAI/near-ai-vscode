// The export surface (CYBER-12, D-16): SARIF 2.1.0 that an IDE can consume, a JSON document and a
// PTES Markdown report that always carry the authorization block and the missing-tools note, a
// deterministic byte-for-byte output, the four-category run diff, and a refusal to export an
// unredacted credential.

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { DisclaimerAcceptance, Engagement, EngagementRun, Finding } from '../domain/cyber';
import { appendEntry } from '../domain/cyberLedger';
import { buildPtesReport, diffFindings } from '../services/cyberReport';
import { ExportError, exportRun, findingsDocument, SARIF_SCHEMA, SARIF_VERSION, toSarif, type SarifPayload } from '../services/cyberSarifExport';

const ACCEPTANCE: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10',
  textVersion: 'v1', region: 'us', acceptedAt: '2026-10-31T12:00:00Z'
};

const ENGAGEMENT: Engagement = {
  id: 'eng-00000000-0000-4000-8000-000000000001',
  workspace: '/workspace/example', target: { kind: 'url', value: 'https://example.test/' },
  resolvedScope: { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] },
  region: 'us', authorizationStatement: 'The acceptor owns the target.', allowedModes: ['passive', 'intrusive'],
  exclusions: [], sandbox: { tier: 'tempFolder', reason: 'no container runtime' },
  acceptedDisclaimer: ACCEPTANCE, createdAt: ACCEPTANCE.acceptedAt, frozen: true
};

const RUN: EngagementRun = {
  id: 'run-0001-abcdef', engagementId: ENGAGEMENT.id, startedAt: '2026-11-02T12:00:00Z', finishedAt: '2026-11-02T12:05:00Z',
  depth: 'standard', model: 'z-ai/glm-5.3', ledgerPath: 'ledger.jsonl', outcome: 'completed'
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'sql-injection@https://example.test/login', checkId: 'sql-injection', title: 'An injected login predicate returns access',
    severity: 'critical', verdict: 'verified_access', cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N', cvssScore: 9.8,
    cwes: ['CWE-89'], wstg: ['WSTG-INJ-05'], evidenceExcerpt: '{"result":"ok"}', evidenceHash: 'a'.repeat(64),
    reproductionCommand: 'sandbox$ node poc.js', remediation: 'Parameterize the query.', target: 'https://example.test/login',
    ...overrides
  };
}

const payload = (findings: Finding[]): SarifPayload => ({ toolVersion: '0.4.10', engagement: ENGAGEMENT, findings, ledgerVerified: true, missingTools: 'Checks that could not run: nmap (not installed), nuclei (not installed).' });

const LEDGER = [appendEntry([], { index: 0, timestamp: '2026-11-02T12:00:00Z', tool: 'CyberHttpProbe', arguments: '{}', result: 'HTTP 200', modelReasoning: 'probe', evidenceHash: '' })];

test('SARIF 2.1.0 carries the version, schema, driver, rules, and a location on every result', () => {
  const sarif = toSarif(payload([
    finding(),
    finding({ id: 'missing-hsts@https://example.test/', checkId: 'missing-hsts', title: 'HSTS is missing', severity: 'medium', verdict: 'could_not_determine', wstg: ['WSTG-CONF-02'], reason: 'no exploit was attempted', cwes: [], evidenceHash: 'b'.repeat(64), target: 'https://example.test/' })
  ]));
  assert.equal(sarif.version, SARIF_VERSION);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.$schema, SARIF_SCHEMA);
  const runs = sarif.runs as Array<Record<string, any>>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].tool.driver.name, 'Near AI Cybersecurity');
  assert.equal(runs[0].tool.driver.version, '0.4.10');
  assert.ok(Array.isArray(runs[0].tool.driver.rules) && runs[0].tool.driver.rules.length >= 2);
  const results = runs[0].results as Array<Record<string, any>>;
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.ok(Array.isArray(result.locations) && result.locations.length >= 1, 'every result carries a location (Pitfall 6)');
    assert.equal(typeof result.message.text, 'string');
    assert.ok(result.message.text.length > 0);
  }
});

test('the level follows the verdict, and a not_vulnerable result stays visible as pass', () => {
  const sarif = toSarif(payload([
    finding(),
    finding({ id: 'failed@https://example.test/x', checkId: 'sql-injection', verdict: 'exploit_failed', reason: 'the payload returned 401', wstg: ['WSTG-INJ-05'] }),
    finding({ id: 'patched@https://example.test/y', checkId: 'missing-hsts', verdict: 'not_vulnerable', wstg: ['WSTG-CONF-02'] })
  ]));
  const results = (sarif.runs as Array<Record<string, any>>)[0].results as Array<Record<string, any>>;
  assert.deepEqual(results.map((result) => result.level), ['error', 'note', 'pass']);
  assert.equal(results.length, 3, 'a pass is present in results, not omitted');
});

test('the authorization block is embedded on every result and on the run', () => {
  const sarif = toSarif(payload([finding()]));
  const run = (sarif.runs as Array<Record<string, any>>)[0];
  const results = run.results as Array<Record<string, any>>;
  assert.equal(results[0].properties.authorization.engagementId, ENGAGEMENT.id);
  assert.equal(results[0].properties.authorization.acceptor, 'Example Organisation Ltd');
  assert.equal(results[0].properties.authorization.region, 'us');
  assert.equal(run.properties.authorization.engagementId, ENGAGEMENT.id);
  assert.match(run.properties.missingTools, /nmap \(not installed\)/);
  assert.equal(run.properties.ledgerVerified, true);
});

test('a network finding cites its URL and a file finding cites its file', () => {
  const sarif = toSarif(payload([
    finding(),
    finding({ id: 'iac@main.tf:16', checkId: 'iac-public-ingress', target: 'main.tf:16', wstg: ['WSTG-CONF-07'], verdict: 'could_not_determine', reason: 'a static check', reproductionCommand: "sed -n '16p' 'main.tf'" })
  ]));
  const results = (sarif.runs as Array<Record<string, any>>)[0].results as Array<Record<string, any>>;
  const network = results.find((result) => result.partialFingerprints.findingId === finding().id)!;
  assert.match(network.locations[0].physicalLocation.artifactLocation.uri, /^https:\/\//);
  const file = results.find((result) => result.partialFingerprints.findingId === 'iac@main.tf:16')!;
  assert.equal(file.locations[0].physicalLocation.artifactLocation.uri, 'main.tf:16');
  assert.equal(file.locations[0].physicalLocation.region.startLine, 16);
});

test('exporting the same payload twice yields byte-identical output', async () => {
  const first = JSON.stringify(toSarif(payload([finding()])));
  const second = JSON.stringify(toSarif(payload([finding()])));
  assert.equal(first, second);

  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-export-'));
  const options = { directory, payload: payload([finding()]), run: RUN, ledger: LEDGER };
  const one = await exportRun(options);
  const firstBytes = await readFile(one.report, 'utf8');
  const firstSarif = await readFile(one.sarif, 'utf8');
  await exportRun(options);
  assert.equal(await readFile(one.report, 'utf8'), firstBytes);
  assert.equal(await readFile(one.sarif, 'utf8'), firstSarif);
});

test('an unredacted credential refuses the export with a typed error', () => {
  const leaky = finding({ evidenceExcerpt: 'API_KEY=sk-liveabcdefghijklmnopqrstuvwxyz012345' });
  assert.throws(() => toSarif(payload([leaky])), (error: Error) => error instanceof ExportError && /unredacted credential/.test(error.message));
  // The redaction sentinel is accepted.
  assert.doesNotThrow(() => toSarif(payload([finding({ evidenceExcerpt: 'api_key: [REDACTED]' })])));
});

test('exportRun writes all three files with the acceptance block and the missing-tools note', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-export3-'));
  const bundle = await exportRun({ directory, payload: payload([finding()]), run: RUN, ledger: LEDGER });
  const markdown = await readFile(bundle.report, 'utf8');
  const json = JSON.parse(await readFile(bundle.json, 'utf8')) as Record<string, any>;
  const sarif = JSON.parse(await readFile(bundle.sarif, 'utf8')) as Record<string, any>;

  for (const field of ['Example Organisation Ltd', 'eng-00000000-0000-4000-8000-000000000001', 'us']) assert.ok(markdown.includes(field), `the report header carries ${field}`);
  assert.match(markdown, /Acceptance \/ Authorization/);
  assert.equal(json.authorization.engagementId, ENGAGEMENT.id);
  assert.equal(json.ledgerVerified, true);
  assert.match(json.missingTools, /nuclei \(not installed\)/);
  assert.equal(json.findings.length, 1);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(path.basename(bundle.report), 'report.md');
  assert.equal(path.basename(bundle.json), 'findings.json');
  assert.equal(path.basename(bundle.sarif), 'findings.sarif');
});

test('the run diff lists added, resolved, unchanged and unplaceable ids without dropping any', async () => {
  const previous = [finding(), finding({ id: 'missing-hsts@https://example.test/', checkId: 'missing-hsts', target: 'https://example.test/' })];
  const current = [finding(), finding({ id: 'new@https://example.test/new', checkId: 'open-port', target: 'https://example.test/new' })];
  const diff = diffFindings(previous, current);
  assert.deepEqual(diff.added, ['open-port@https://example.test/new']);
  assert.deepEqual(diff.resolved, ['missing-hsts@https://example.test/']);
  assert.deepEqual(diff.unchanged, ['sql-injection@https://example.test/login']);

  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-diff-'));
  const bundle = await exportRun({ directory, payload: payload(current), run: RUN, ledger: LEDGER, previousFindings: previous });
  const markdown = await readFile(bundle.report, 'utf8');
  assert.match(markdown, /## Run Diff/);
  assert.match(markdown, /Resolved since the previous run\*\* \(1\)/);
  assert.match(markdown, /Added since the previous run\*\* \(1\)/);

  const unplaceable = diffFindings([finding({ target: undefined, id: 'x' })], []);
  assert.deepEqual(unplaceable.unknown, ['sql-injection@']);
});

test('the populated report renders each verdict and never calls a failure clean', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-report-'));
  const findings = [finding(), finding({ id: 'f@https://example.test/x', checkId: 'sql-injection', verdict: 'exploit_failed', reason: 'the payload returned 401', target: 'https://example.test/x' })];
  const markdown = buildPtesReport(ENGAGEMENT, RUN, findings, LEDGER);
  const bundle = await exportRun({ directory, payload: payload(findings), run: RUN, ledger: LEDGER });
  assert.equal(markdown, await readFile(bundle.report, 'utf8'), 'exportRun uses the same builder');
  assert.match(markdown, /Verified access — /);
  assert.match(markdown, /Exploit attempt failed — the payload returned 401/);
  // The verdict lines never claim a failure is clean (the Executive Summary's "not a clean bill of
  // health" is the honest negation, so the check is on the rendered verdict lines themselves).
  const verdictLines = markdown.split('\n').filter((line) => /Exploit attempt failed|Unable to determine/.test(line));
  assert.ok(verdictLines.length > 0);
  for (const line of verdictLines) assert.doesNotMatch(line, /\bclean\b/i);
  assert.match(findingsDocument(payload(findings)).acceptance as string, /Example Organisation Ltd/);
});
