// D-27 evidence kind 2: a detected host tool runs with its machine-readable flag, its own stdout
// bytes are stored verbatim and hash-chained, the provenance rides the ledger entry, and a missing
// tool produces a named absent-with-reason record instead of a silent skip. The runner is a
// hand-written double, so no tool needs to be installed for this suite.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CyberEvidenceStore } from '../services/cyberLedgerStore';
import { hostToolArgv, HOST_TOOL_INVOCATION, runHostTool, type HostToolRunner, type HostToolRunnerOutput } from '../services/cyberHostTools';

const RUN = 'run-0001-hosttools';

function runnerReturning(output: Partial<HostToolRunnerOutput> & { stdout: Buffer }): { runner: HostToolRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(argv) {
        calls.push(argv);
        return { stdout: output.stdout, stderr: output.stderr ?? '', exitCode: output.exitCode ?? 0, durationMs: output.durationMs ?? 12 };
      }
    }
  };
}

async function evidence(): Promise<CyberEvidenceStore> {
  return new CyberEvidenceStore(await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-host-')));
}

const present = async () => ({ available: true, version: '3.2.1' });
const absent = async () => ({ available: false });

test('a captured run stores exactly the bytes the tool printed, with full provenance', async () => {
  const store = await evidence();
  const bytes = Buffer.from('{"template-id":"cve-2021-44228","matched-at":"https://example.test/"}\n', 'utf8');
  const { runner, calls } = runnerReturning({ stdout: bytes });
  const result = await runHostTool({ runId: RUN, tool: 'nuclei', target: 'https://example.test/' }, { detect: present, runner, evidence: store });

  assert.equal(result.status, 'captured');
  assert.equal(result.evidenceHash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await store.get(RUN, result.evidenceHash), bytes, 'the stored blob is byte-identical');
  assert.deepEqual(calls, [['nuclei', '-u', 'https://example.test/', '-jsonl', '-silent']]);
  assert.equal(result.provenance.tool, 'nuclei');
  assert.deepEqual(result.provenance.argv, ['nuclei', '-u', 'https://example.test/', '-jsonl', '-silent']);
  assert.equal(result.provenance.version, '3.2.1');
  assert.equal(result.provenance.exitCode, 0);
  assert.ok(result.provenance.durationMs >= 0);
  assert.equal(result.provenance.format, 'jsonl');
  assert.equal(result.provenance.jsonFlagVerified, true);
});

test('an absent tool records the absence with its install command and never invokes the runner', async () => {
  const store = await evidence();
  const { runner, calls } = runnerReturning({ stdout: Buffer.from('should never run') });
  const result = await runHostTool({ runId: RUN, tool: 'nuclei', target: 'https://example.test/' }, { detect: absent, runner, evidence: store });

  assert.equal(result.status, 'absent');
  assert.equal(calls.length, 0, 'the runner was never invoked');
  assert.equal(result.provenance.exitCode, null);
  assert.deepEqual(result.provenance.argv, []);
  assert.match(result.stdoutText, /nuclei is not installed/);
  const record = JSON.parse((await store.get(RUN, result.evidenceHash)).toString('utf8')) as { tool: string; installCommand: string; reason: string };
  assert.equal(record.tool, 'nuclei');
  assert.match(record.installCommand, /go install/);
  assert.match(record.reason, /did not run/);
});

test('a non-zero exit still stores its stdout verbatim and reports failed with the exit code', async () => {
  const store = await evidence();
  const bytes = Buffer.from('{"errors":[{"message":"target unreachable"}]}\n', 'utf8');
  const { runner } = runnerReturning({ stdout: bytes, exitCode: 2, stderr: 'boom' });
  const result = await runHostTool({ runId: RUN, tool: 'semgrep', target: '.' }, { detect: present, runner, evidence: store });

  assert.equal(result.status, 'failed');
  assert.equal(result.provenance.exitCode, 2);
  assert.deepEqual(await store.get(RUN, result.evidenceHash), bytes);
  assert.match(result.stdoutText, /target unreachable/);
});

test('the invocation table asks each tool for machine-readable output, and marks the assumed flags', () => {
  assert.deepEqual(hostToolArgv('nmap', '127.0.0.1').argv, ['nmap', '-oX', '-', '127.0.0.1']);
  assert.equal(hostToolArgv('nmap', '127.0.0.1').invocation.format, 'xml');
  assert.deepEqual(hostToolArgv('semgrep', '.').argv, ['semgrep', '--sarif', '--config', 'auto', '.']);
  assert.deepEqual(hostToolArgv('trivy', 'image:latest').argv, ['trivy', '--format', 'json', 'image:latest']);
  assert.deepEqual(hostToolArgv('nuclei', 'https://example.test/').argv, ['nuclei', '-u', 'https://example.test/', '-jsonl', '-silent']);
  for (const name of ['nikto', 'sqlmap', 'whatweb']) assert.equal(HOST_TOOL_INVOCATION[name].verified, false, `${name}'s flag is still an assumption`);
  assert.throws(() => hostToolArgv('neat-tool', 'x'), /not a host tool/);
  assert.throws(() => hostToolArgv('nuclei', '  '), /needs a target/);
});

test('a tool outside the catalogue is refused before anything runs', async () => {
  const store = await evidence();
  const { runner, calls } = runnerReturning({ stdout: Buffer.from('x') });
  await assert.rejects(runHostTool({ runId: RUN, tool: 'curl', target: 'https://example.test/' }, { detect: present, runner, evidence: store }), /not a host tool/);
  assert.equal(calls.length, 0);
});

test('a large output is trimmed for the model while the stored blob stays complete', async () => {
  const store = await evidence();
  const huge = Buffer.from('x'.repeat(20_000), 'utf8');
  const { runner } = runnerReturning({ stdout: huge });
  const result = await runHostTool({ runId: RUN, tool: 'nuclei', target: 'https://example.test/' }, { detect: present, runner, evidence: store });
  assert.ok(result.stdoutText.length < huge.length);
  assert.match(result.stdoutText, /the stored blob is complete/);
  assert.equal((await store.get(RUN, result.evidenceHash)).length, huge.length);
  assert.equal(result.evidenceHash, createHash('sha256').update(huge).digest('hex'));
});
