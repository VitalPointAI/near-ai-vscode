// The append-only hash-chained ledger and the content-addressed evidence store (CYBER-11, D-27,
// D-28): tamper-evidence, sequence enforcement, replay without network or tools, a hash path guard,
// absence stored as evidence, and bounded pruning that never touches the ledger.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { Finding } from '../domain/cyber';
import { CyberEvidenceStore, CyberLedgerStore, EvidenceError, FINDING_MARKER, LedgerError, PRUNE_KEEP_RUNS } from '../services/cyberLedgerStore';

const RUN = 'run-0001-abcdef';

const finding: Finding = {
  id: 'missing-hsts-1',
  checkId: 'missing-hsts',
  title: 'Strict-Transport-Security header is missing',
  severity: 'medium',
  verdict: 'could_not_determine',
  cvssVector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N',
  cwes: [],
  wstg: ['WSTG-CONF-02'],
  evidenceExcerpt: '200 OK',
  evidenceHash: 'a'.repeat(64),
  reproductionCommand: "curl -sS -I 'https://example.test/'",
  remediation: 'Send Strict-Transport-Security.'
};

function stepFields(index: number, overrides: { tool?: string; result?: string } = {}) {
  return { index, timestamp: `2026-11-02T12:0${index}:00Z`, tool: overrides.tool ?? 'CyberHttpProbe', arguments: '{"url":"https://example.test/"}', result: overrides.result ?? `HTTP 200 (step ${index})`, modelReasoning: `reasoning ${index}`, evidenceHash: index === 0 ? 'b'.repeat(64) : '' };
}

async function store(): Promise<{ ledger: CyberLedgerStore; evidence: CyberEvidenceStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-ledger-'));
  return { ledger: new CyberLedgerStore(directory), evidence: new CyberEvidenceStore(directory), directory };
}

test('the ledger appends one JSONL line per entry and verifies', async () => {
  const { ledger } = await store();
  await ledger.append(RUN, stepFields(0));
  await ledger.append(RUN, stepFields(1));
  await ledger.append(RUN, { ...stepFields(2), result: `${FINDING_MARKER}${JSON.stringify(finding)}` });

  assert.equal(await ledger.verify(RUN), true);
  const text = await readFile(ledger.runPath(RUN), 'utf8');
  assert.equal(text.trimEnd().split('\n').length, 3, 'append-only: exactly one line per entry');
  assert.equal((await ledger.entries(RUN)).length, 3);
});

test('editing any character of a stored line makes verification fail', async () => {
  const { ledger } = await store();
  for (const index of [0, 1, 2]) await ledger.append(RUN, stepFields(index));
  const file = ledger.runPath(RUN);
  const original = await readFile(file, 'utf8');
  const lines = original.trimEnd().split('\n');
  lines[1] = lines[1].replace('HTTP 200 (step 1)', 'HTTP 500 (step 1)');
  await writeFile(file, `${lines.join('\n')}\n`);

  assert.equal(await ledger.verify(RUN), false);
  assert.match((await ledger.breakAt(RUN)) ?? '', /entry 1 was modified after it was written/);
});

test('an out-of-sequence index is refused and the file is untouched', async () => {
  const { ledger } = await store();
  for (const index of [0, 1, 2]) await ledger.append(RUN, stepFields(index));
  const before = await readFile(ledger.runPath(RUN), 'utf8');
  await assert.rejects(ledger.append(RUN, stepFields(7)), /cannot follow a chain of 3 entries/);
  assert.equal(await readFile(ledger.runPath(RUN), 'utf8'), before);
});

test('evidence round-trips its bytes and its hash is the SHA-256 of exactly those bytes', async () => {
  const { evidence } = await store();
  const blob = Buffer.from('{"tool":"nuclei","output":"nuclei -jsonl bytes ✓"}\n', 'utf8');
  const hash = await evidence.put(RUN, blob);
  assert.equal(hash, createHash('sha256').update(blob).digest('hex'));
  assert.deepEqual(await evidence.get(RUN, hash), blob);
});

test('the evidence store refuses a hash that could name a path', async () => {
  const { evidence } = await store();
  for (const bad of ['../../etc/passwd', `${'a'.repeat(32)}/${'b'.repeat(31)}`, 'not-a-hash', `${'A'.repeat(64)}`]) {
    await assert.rejects(evidence.get(RUN, bad), (error: Error) => error instanceof EvidenceError, `${bad} is rejected`);
  }
});

test('a swapped blob is caught when it is read back', async () => {
  const { evidence, directory } = await store();
  const hash = await evidence.put(RUN, 'the tool printed this');
  await writeFile(path.join(directory, 'runs', RUN, 'evidence', hash), 'something else entirely');
  await assert.rejects(evidence.get(RUN, hash), /no longer matches its hash/);
});

test('absence is stored as a named, hash-chained record rather than skipped', async () => {
  const { evidence } = await store();
  const record = { kind: 'absent' as const, tool: 'nuclei', installCommand: 'go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest', reason: 'nuclei is not installed, so its checks did not run' };
  const hash = await evidence.putAbsent(RUN, record);
  const bytes = await evidence.get(RUN, hash);
  const parsed = JSON.parse(bytes.toString('utf8')) as typeof record;
  assert.equal(parsed.tool, 'nuclei');
  assert.match(parsed.installCommand, /go install/);
  assert.match(parsed.reason, /did not run/);
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'));
});

test('pruning keeps the newest runs and names the ones it pruned, leaving the ledger alone', async () => {
  const { ledger, evidence } = await store();
  const runs = ['run-0001-a', 'run-0002-b', 'run-0003-c', 'run-0004-d', 'run-0005-e'];
  for (const runId of runs) {
    await evidence.put(runId, `evidence for ${runId}`);
    await ledger.append(runId, stepFields(0));
  }
  const pruned = await evidence.prune(runs);
  assert.deepEqual(pruned, ['run-0001-a', 'run-0002-b']);
  assert.equal(PRUNE_KEEP_RUNS, 3);
  for (const kept of runs.slice(2)) assert.ok((await readdir(path.join(path.dirname(ledger.runPath(kept)), 'evidence'))).length > 0, `${kept} keeps its evidence`);
  // The ledger is append-only and never pruned, so every run still verifies afterwards.
  for (const runId of runs) assert.equal(await ledger.verify(runId), true);
});

test('replay renders every step in order and reproduces the recorded findings', async () => {
  const { ledger } = await store();
  await ledger.append(RUN, stepFields(0));
  await ledger.append(RUN, { ...stepFields(1), tool: 'CyberTlsProbe' });
  await ledger.append(RUN, { ...stepFields(2), result: `${FINDING_MARKER}${JSON.stringify(finding)}` });

  const replay = await ledger.replay(RUN);
  assert.equal(replay.chainOk, true);
  assert.deepEqual(replay.steps.map((step) => step.index), [0, 1, 2]);
  assert.deepEqual(replay.steps.map((step) => step.tool), ['CyberHttpProbe', 'CyberTlsProbe', 'CyberHttpProbe']);
  assert.equal(replay.steps[0].evidenceHash, 'b'.repeat(64));
  assert.deepEqual(replay.findings, [finding]);
});

test('a replayed tampered run says the chain is broken instead of presenting it as sound', async () => {
  const { ledger } = await store();
  for (const index of [0, 1]) await ledger.append(RUN, stepFields(index));
  const file = ledger.runPath(RUN);
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  lines[0] = lines[0].replace('reasoning 0', 'reasoning 0 (edited)');
  await writeFile(file, `${lines.join('\n')}\n`);
  const replay = await ledger.replay(RUN);
  assert.equal(replay.chainOk, false);
  assert.ok(replay.chainBreak);
});

test('a malformed run id is refused before it can name a path', async () => {
  const { ledger } = await store();
  assert.throws(() => ledger.runPath('../../etc'), (error: Error) => error instanceof LedgerError);
  await assert.rejects(ledger.entries('not-a-run'), (error: Error) => error instanceof LedgerError);
});

