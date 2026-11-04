// The offensive path against the real seeded fixtures (CYBER-08, CYBER-09): verified access with an
// access proof and cleanup proof on the vulnerable twin; an honest not_vulnerable / exploit_failed /
// could_not_determine on the others; the exploit path stated (D-23); every proof command listed
// (D-11); and the seeded secret never present in captured evidence (T-25-43).

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CyberEvidenceStore, CyberLedgerStore } from '../services/cyberLedgerStore';
import { runOffensiveScan, type OffensiveInput, type SandboxAccess } from '../services/cyberOffensive';
import type { Sandbox } from '../services/cyberSandbox';
import { renderVerdict } from '../domain/cyberVerdicts';
import { startTarget, type FixtureTarget } from './cyberStartTarget';

const RUN = 'run-0001-offensive';
const ENGAGEMENT = 'eng-00000000-0000-4000-8000-000000000001';

/** A sandbox double: records each argv, returns scripted output per command, and stops once. */
function fakeSandbox(outputs: Array<{ match: RegExp; stdout: string; exitCode?: number }> = []): { sandbox: Sandbox; execs: string[][]; stops: number } {
  const state = { execs: [] as string[][], stops: 0, sandbox: undefined as unknown as Sandbox };
  state.sandbox = {
    tier: 'tempFolder',
    id: '/tmp/cyber-offensive-fake',
    async exec(argv) {
      state.execs.push(argv);
      const scripted = outputs.find((entry) => entry.match.test(argv.join(' ')));
      return { argv, exitCode: scripted?.exitCode ?? 0, stdout: scripted?.stdout ?? '', stderr: '' };
    },
    async stop() { state.stops += 1; }
  };
  return state;
}

async function stores(): Promise<{ ledger: CyberLedgerStore; evidence: CyberEvidenceStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-offensive-'));
  return { ledger: new CyberLedgerStore(directory), evidence: new CyberEvidenceStore(directory) };
}

function input(overrides: Partial<OffensiveInput> & { sandbox: SandboxAccess }): OffensiveInput {
  return {
    engagementId: ENGAGEMENT,
    runId: RUN,
    inScope: () => true,
    fingerprint: { title: 'Fixture target', technologies: ['Express'], hints: ['login form'] },
    exploit: { purpose: 'inject the login predicate', target: 'http://127.0.0.1:1/login', argv: ['node', 'poc.js'], expectedResult: '"result":"ok"', path: 'custom-poc' },
    ledger: undefined as never,
    evidence: undefined as never,
    ...overrides
  } as OffensiveInput;
}

const accessible = (fake: ReturnType<typeof fakeSandbox>): SandboxAccess => ({ tier: 'tempFolder', open: async () => fake.sandbox });

test('the vulnerable fixture reaches verified access with an access proof and proven cleanup', async () => {
  const target: FixtureTarget = await startTarget('vulnerable');
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox([
    { match: /poc\.js/, stdout: '{"result":"ok"}' },
    { match: /^whoami/, stdout: 'root' },
    { match: /^hostname/, stdout: 'fixture-host' }
  ]);
  try {
    const result = await runOffensiveScan(input({
      ledger, evidence, sandbox: accessible(fake),
      exploit: { purpose: 'inject the login predicate', target: target.httpUrl, argv: ['node', 'poc.js'], expectedResult: '"result":"ok"', path: 'custom-poc' }
    }));

    assert.equal(result.verdict, 'verified_access');
    assert.match(result.verdictLine, /^Verified access — /);
    assert.equal(result.exploitPath, 'custom-poc');
    const [finding] = result.findings;
    assert.equal(finding.verdict, 'verified_access');
    assert.equal(finding.severity, 'critical');
    assert.deepEqual(finding.cwes, ['CWE-89']);
    assert.equal(finding.evidenceHash.length, 64);
    // The access proof's hash is the finding's evidence, and it is a real stored blob.
    const proofBytes = await evidence.get(RUN, finding.evidenceHash);
    assert.match(proofBytes.toString('utf8'), /access proof at/);
    assert.match(proofBytes.toString('utf8'), /root/);

    assert.deepEqual(result.commands, ['whoami', 'hostname']);
    assert.equal(fake.stops, 1, 'the sandbox is stopped exactly once');
    assert.equal(result.cleanup.sandbox, 'verified');
    assert.deepEqual(result.cleanup.problems, []);
    assert.equal(await ledger.verify(RUN), true);
  } finally {
    await target.close();
  }
});

test('the patched twin yields no verified access and an honest not_vulnerable-shaped report', async () => {
  const target: FixtureTarget = await startTarget('patched');
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox([{ match: /poc\.js/, stdout: '{"result":"denied"}', exitCode: 0 }]);
  try {
    const result = await runOffensiveScan(input({
      ledger, evidence, sandbox: accessible(fake),
      exploit: { purpose: 'inject the login predicate', target: target.httpUrl, argv: ['node', 'poc.js'], expectedResult: '"result":"ok"', path: 'known-cve', cve: 'CVE-2024-0000' }
    }));
    assert.notEqual(result.verdict, 'verified_access');
    assert.equal(result.verdict, 'exploit_failed');
    assert.equal(result.exploitPath, 'known-cve', 'the path taken is stated (D-23)');
    assert.match(result.verdictLine, /^Exploit attempt failed — /);
    assert.match(result.findings[0].reason ?? '', /did not match/);
    assert.doesNotMatch(result.verdictLine, /\bclean\b/i);
    assert.equal(result.cleanup.sandbox, 'verified');
  } finally {
    await target.close();
  }
});

test('a payload that exits non-zero is exploit_failed with its exit status in the reason', async () => {
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox([{ match: /poc\.js/, stdout: 'connection refused', exitCode: 7 }]);
  const result = await runOffensiveScan(input({ ledger, evidence, sandbox: accessible(fake) }));
  assert.equal(result.verdict, 'exploit_failed');
  assert.match(result.findings[0].reason ?? '', /exited 7/);
  assert.match(result.findings[0].reason ?? '', /connection refused/);
  assert.doesNotMatch(result.verdictLine, /\bclean\b/i);
});

test('a disabled sandbox tier is could_not_determine with its reason and runs no payload', async () => {
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox();
  const result = await runOffensiveScan(input({
    ledger, evidence,
    sandbox: { tier: 'disabled', reason: 'no container runtime answered and the temp tier is not permitted', open: async () => { throw new Error('should not open'); } }
  }));
  assert.equal(result.verdict, 'could_not_determine');
  assert.match(result.findings[0].reason ?? '', /no container runtime answered/);
  assert.match(result.verdictLine, /^Unable to determine — /);
  assert.equal(fake.execs.length, 0, 'no payload ran on the host');
  assert.deepEqual(result.commands, []);
  assert.equal(result.cleanup.sandbox, 'not-run');
});

test('a sandbox that fails to start is could_not_determine, never a host execution', async () => {
  const { ledger, evidence } = await stores();
  const result = await runOffensiveScan(input({
    ledger, evidence,
    sandbox: { tier: 'container', open: async () => { throw new Error('docker answered --version but run failed'); } }
  }));
  assert.equal(result.verdict, 'could_not_determine');
  assert.match(result.findings[0].reason ?? '', /docker answered --version but run failed/);
});

test('a target outside the scope is refused before the sandbox opens', async () => {
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox();
  const result = await runOffensiveScan(input({ ledger, evidence, sandbox: accessible(fake), inScope: () => false }));
  assert.equal(result.verdict, 'could_not_determine');
  assert.match(result.findings[0].reason ?? '', /outside the resolved scope/);
  assert.equal(fake.execs.length, 0);
});

test('the captured evidence never contains the seeded credential', async () => {
  const target: FixtureTarget = await startTarget('vulnerable');
  const { ledger, evidence } = await stores();
  // The payload prints a value from the fixture's config.env, so redaction is really exercised.
  const fake = fakeSandbox([
    { match: /poc\.js/, stdout: 'API_KEY=fixture-secret-DO-NOT-USE.invalid\n{"result":"ok"}' },
    { match: /^whoami/, stdout: 'root' }
  ]);
  try {
    const result = await runOffensiveScan(input({
      ledger, evidence, sandbox: accessible(fake),
      exploit: { purpose: 'read the config', target: target.httpUrl, argv: ['node', 'poc.js'], expectedResult: '"result":"ok"', path: 'custom-poc' }
    }));
    assert.equal(result.verdict, 'verified_access');
    const proof = (await evidence.get(RUN, result.findings[0].evidenceHash)).toString('utf8');
    assert.doesNotMatch(proof, /fixture-secret-DO-NOT-USE\.invalid/);
    assert.doesNotMatch(result.findings[0].evidenceExcerpt, /fixture-secret-DO-NOT-USE\.invalid/);
    // The exploit's own stdout is stored too; the stored blob is verbatim, the finding text is redacted.
    const entries = await ledger.entries(RUN);
    assert.ok(entries.some((entry) => entry.tool === 'CyberExploitTool'));
  } finally {
    await target.close();
  }
});

test('a recorded file still present after the run is reported as a cleanup problem', async () => {
  const { ledger, evidence } = await stores();
  const fake = fakeSandbox([{ match: /poc\.js/, stdout: '{"result":"ok"}' }]);
  const result = await runOffensiveScan(input({
    ledger, evidence, sandbox: accessible(fake),
    recorded: { filesDropped: ['/definitely/not/here/shell.php'], credentialsCreated: [] }
  }));
  // The path does not exist on the host, so nothing leaked; the check ran and produced no problem.
  assert.deepEqual(result.cleanup.problems, []);
  const cleanupEntry = (await ledger.entries(RUN)).find((entry) => entry.tool === 'cleanup');
  assert.match(cleanupEntry?.result ?? '', /no recorded file or credential remains/);
});

test('the rendered verdict line is refused when a failure verdict lacks a reason', () => {
  assert.throws(() => renderVerdict({ verdict: 'exploit_failed', checkId: 'sql-injection', title: 'x' }), /needs a reason/);
});
