// The cybersecurity harness tracer: one target resolved to a scope, one engagement with an accepted
// disclaimer, one real built-in HTTP probe against a loopback server this test starts itself, one
// finding with a WSTG id and a CVSS 3.1 vector, one hash-chained ledger entry, and one PTES report on
// disk. Everything is offline: the server binds 127.0.0.1 on an OS-chosen port, and DNS resolution
// is injected so no lookup leaves the machine.

import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { cyberProbes } from '../agent/cyberProbes';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import {
  cvss31Vector,
  DisclaimerAcceptance,
  Engagement,
  EngagementRun,
  Finding,
  isoTimestamp,
  PROFILE_CONTENT,
  profileChecks,
  resolveTarget,
  ScopeError,
  urlInScope
} from '../domain/cyber';
import { appendEntry, verifyChain } from '../domain/cyberLedger';
import { buildPtesReport, writeReport } from '../services/cyberReport';
import { cvss3Score } from '../security/osv';

/** A target that answers with the headers a hardened server would send, except the one under test. */
function startTarget(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      response.end('<html><body>sample target</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const acceptance: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd',
  osUser: 'test-user',
  machine: 'test-machine',
  extensionVersion: '0.4.10',
  textVersion: 'v1',
  region: 'us',
  acceptedAt: isoTimestamp(new Date('2026-10-31T12:00:00Z'))
};

test('a URL target runs through scope, probe, finding, ledger and PTES report offline', async () => {
  const { server, url } = await startTarget();
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-tracer-'));
  const shell = new ShellSession(root);
  try {
    // A lookup that fails loudly proves URL targets never need DNS here (the host is a literal).
    const scope = await resolveTarget({ kind: 'url', value: url }, { lookup: async () => { throw new Error('unexpected DNS lookup'); } });
    assert.deepEqual(scope.ports, [Number(new URL(url).port)]);
    assert.ok(scope.hosts.includes('127.0.0.1'));
    assert.ok(urlInScope(scope, url));

    const engagement: Engagement = {
      id: 'eng-00000000-0000-4000-8000-000000000001',
      workspace: root,
      target: { kind: 'url', value: url },
      resolvedScope: scope,
      region: acceptance.region,
      authorizationStatement: 'The acceptor owns the target.',
      allowedModes: ['passive'],
      exclusions: [],
      sandbox: { tier: 'tempFolder' },
      acceptedDisclaimer: acceptance,
      createdAt: acceptance.acceptedAt,
      frozen: false
    };

    const [httpProbe] = cyberProbes({ inScope: (candidate, resolved) => urlInScope(resolved ?? scope, candidate), scope });
    assert.equal(httpProbe.untrusted, true);
    const input = httpProbe.parse({ url, checks: ['missing-hsts'] });
    const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-tracer'), shell, readFiles: new Set() };
    const output = await httpProbe.run(input, context);
    assert.match(output, /200/);
    assert.match(output, /Strict-Transport-Security header is missing/);
    assert.match(output, /<untrusted-content/);

    const findings: Finding[] = [{
      id: 'missing-hsts-1',
      checkId: 'missing-hsts',
      title: 'Strict-Transport-Security header is missing',
      severity: 'medium',
      verdict: 'could_not_determine',
      cvssVector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }),
      cvssScore: cvss3Score(cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' })),
      cwes: [],
      wstg: ['WSTG-CONF-02'],
      evidenceExcerpt: '200 OK\ncontent-type: text/html',
      evidenceHash: 'a'.repeat(64),
      reproductionCommand: `curl -sS -D - -o /dev/null '${url}'`,
      remediation: 'Send Strict-Transport-Security.',
      target: url
    }];

    const entries = [appendEntry([], { index: 0, timestamp: acceptance.acceptedAt, tool: 'CyberHttpProbe', arguments: JSON.stringify({ url }), result: output, modelReasoning: 'probe the target', evidenceHash: findings[0].evidenceHash })];
    assert.equal(verifyChain(entries), true);

    const run: EngagementRun = { id: 'run-1', engagementId: engagement.id, startedAt: isoTimestamp(new Date('2026-10-31T12:01:00Z')), finishedAt: isoTimestamp(new Date('2026-10-31T12:02:00Z')), depth: 'quick', model: 'z-ai/glm-5.3', ledgerPath: 'ledger.jsonl', outcome: 'completed' };
    const markdown = buildPtesReport(engagement, run, findings, entries);
    for (const heading of ['Executive Summary', 'Scope and Rules of Engagement', 'Methodology', 'Findings by Severity', 'Exploitation Narrative', 'Remediation Summary', 'Evidence Appendix', 'Acceptance / Authorization']) {
      assert.ok(markdown.includes(`## ${heading}`), `report is missing the ${heading} section`);
    }
    assert.match(markdown, /WSTG-CONF-02/);
    assert.match(markdown, /CVSS:3\.1\/AV:N\/AC:H/);
    assert.match(markdown, /Chain verified: 1 entry/);
    assert.match(markdown, /Example Organisation Ltd/);

    const written = await writeReport(path.join(root, 'cyber', 'engagements', engagement.id), 'report', markdown);
    assert.equal(await readFile(written, 'utf8'), markdown);
  } finally {
    shell.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('modifying any persisted ledger field makes verifyChain false', () => {
  const fields = { index: 0, timestamp: '2026-10-31T12:00:00Z', tool: 'CyberHttpProbe', arguments: '{}', result: 'HTTP 200', modelReasoning: 'probe', evidenceHash: '' };
  const entries = [
    appendEntry([], fields),
    appendEntry([appendEntry([], fields)], { ...fields, index: 1, result: 'HTTP 404' })
  ];
  assert.equal(verifyChain(entries), true);
  for (const field of ['timestamp', 'tool', 'arguments', 'result', 'modelReasoning', 'evidenceHash'] as const) {
    const tampered = entries.map((entry) => ({ ...entry }));
    tampered[1][field] = `${tampered[1][field]}x`;
    assert.equal(verifyChain(tampered), false, `changing ${field} should break the chain`);
  }
  const reindexed = entries.map((entry) => ({ ...entry }));
  reindexed[1].index = 7;
  assert.equal(verifyChain(reindexed), false);

  // Re-hashing the tampered entry does not help: the next link no longer matches its predecessor.
  const rebuilt = entries.map((entry) => ({ ...entry }));
  rebuilt[0] = { ...appendEntry([], { ...fields, result: 'HTTP 500' }) };
  assert.equal(verifyChain(rebuilt), false);
});

test('cvss31Vector emits the FIRST metric order and cvss3Score returns the specification value', () => {
  assert.equal(
    cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'H', I: 'H', A: 'N' }),
    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N'
  );
  // C:H/I:H/A:N on its own is 9.1; all three impact metrics high is the 9.8 case.
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N'), 9.1);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N'), 4.2);
  assert.equal(cvss3Score('not-a-vector'), undefined);
});

test('depth profiles differ in content, and each check set is a strict subset of the next', () => {
  const quick = profileChecks('quick');
  const standard = profileChecks('standard');
  const deep = profileChecks('deep');
  const strictSubset = (small: string[], large: string[]) => small.every((check) => large.includes(check)) && large.length > small.length;
  assert.ok(strictSubset(quick, standard), 'quick should be a strict subset of standard');
  assert.ok(strictSubset(standard, deep), 'standard should be a strict subset of deep');

  assert.equal(PROFILE_CONTENT.quick.portSweep, false);
  assert.equal(PROFILE_CONTENT.standard.portSweep, false);
  assert.equal(PROFILE_CONTENT.deep.portSweep, true);
  assert.equal(PROFILE_CONTENT.quick.cveSweep, false);
  assert.equal(PROFILE_CONTENT.standard.cveSweep, false);
  assert.equal(PROFILE_CONTENT.deep.cveSweep, true);
  assert.equal(PROFILE_CONTENT.quick.exploitsAttempted, 0);
  assert.equal(PROFILE_CONTENT.standard.exploitsAttempted, 1);
  assert.equal(PROFILE_CONTENT.deep.exploitsAttempted, 3);

  // An unresolvable profile fails with a reason rather than shrinking to a default.
  assert.throws(() => profileChecks('turbo' as never), /Unknown depth profile/);
});
