// A live defensive run against the real seeded fixture: the probes, the permission path, the ledger,
// the evidence store, the critic and replay all exercised together. The panel tests inject their
// dependencies, which is how a single-step engine and an unchained-findings bug both reached review;
// this file runs the genuine assembly against a server the test starts itself.
//
// Offline: the fixture binds 127.0.0.1 on an OS-chosen port, and the model is a script.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { Finding } from '../domain/cyber';
import { profileChecks } from '../domain/cyber';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';
import { RunGrants } from '../agent/permissions';
import type { Step } from '../domain/cyberProtocol';
import { cyberAssembly, panelTools, startCyberRunInPanel, type CompletionClient } from '../services/cyberAssembly';
import { startTarget } from './cyberStartTarget';

/** One planner step naming a built-in tool. */
function stepOn(id: string, tool: string, target: string, action: Step['action'] = 'probe'): Step {
  return {
    id, role: 'planner', action, target, tool, args: [], sandbox: 'none',
    expectedResult: `${tool} output`,
    safetyFlags: { maxDurationMs: 25_000, rateLimit: 0, denyList: [] }
  };
}

/** A model that hands out the scripted steps in order and then says it is done. */
function scriptedClient(plan: () => Step[], prompts: string[]): CompletionClient {
  let steps: Step[] | undefined;
  let index = 0;
  return {
    completeOnce: async (_model, messages, options) => {
      // Like the real client: an aborted signal rejects the call.
      if (options?.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      prompts.push(messages.map((message) => message.content).join('\n'));
      if (!steps) steps = plan();
      // Only the planner consumes the script; the other three roles echo the current step, because
      // each role is its own model call (D-20) and a shared counter would desync them.
      // Match the opening sentence, not any mention: every prompt now lists all four role values,
      // so a bare /planner/ would match the operator and critic prompts too.
      const isPlanner = /^You are the planner/.test(system.trim());
      if (!isPlanner) return { text: JSON.stringify(steps[Math.max(0, index - 1)]) };
      const next = index < steps.length ? steps[index] : stepOn(`done-${index}`, 'done', 'done', 'report');
      index += 1;
      return { text: JSON.stringify(next) };
    }
  };
}

async function harness(plan: (target: { httpUrl: string; tlsUrl: string; fixtureDir: string }) => Step[]) {
  const target = await startTarget('vulnerable');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-live-'));
  const port = Number(new URL(target.httpUrl).port);
  const tlsPort = Number(new URL(target.tlsUrl).port);
  const scope = { hosts: ['127.0.0.1'], ports: [port, tlsPort], paths: [target.fixtureDir], exclusions: [] };
  const engagement: Parameters<typeof startCyberRunInPanel>[1]['engagement'] = {
    id: 'eng-00000000-0000-4000-8000-0000000000ff', workspace: root,
    target: { kind: 'url', value: target.httpUrl }, resolvedScope: scope, region: 'us',
    authorizationStatement: 'The acceptor owns the fixture.', allowedModes: ['passive'], exclusions: [],
    sandbox: { tier: 'tempFolder' },
    acceptedDisclaimer: { acceptor: 'Live Scan Check', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10', textVersion: '2026-11-02', region: 'us', acceptedAt: '2026-11-02T12:00:00Z' },
    createdAt: '2026-11-02T12:00:00Z', frozen: true
  };
  const shell = new ShellSession(root);
  const collected: Finding[] = [];
  const prompts: string[] = [];
  const fixture = { httpUrl: target.httpUrl, tlsUrl: target.tlsUrl, fixtureDir: target.fixtureDir };
  const grants = new RunGrants();
  const toolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('live'), shell, readFiles: new Set<string>() };
  const tools = panelTools({ engagement, scope, grants, stopped: () => false, sandboxTier: 'tempFolder', collect: (finding) => collected.push(finding) });
  const assembly = cyberAssembly(
    { globalStorageUri: { fsPath: root }, extension: { packageJSON: { version: '0.4.10' } } },
    { workspaceRoot: root, client: scriptedClient(() => plan(fixture), prompts), model: 'test-model', toolContext, tools: () => tools }
  );
  return {
    target, prompts, assembly, engagement, collected,
    async run(depth: 'quick' | 'standard' | 'deep' = 'quick') {
      const result = await startCyberRunInPanel(
        { ...assembly, grants, tools, externalFindings: collected, currentAcceptance: assembly.currentAcceptance, stopped: () => false },
        { engagement, mode: 'defensive', depth, signal: new AbortController().signal, onEvent: () => undefined }
      );
      return { result, replay: await assembly.ledger.replay(result.runId) };
    },
    async dispose() { shell.dispose(); await target.close(); }
  };
}

test('a live defensive run finds the seeded issues, chains them, and replays them', async () => {
  const box = await harness((t) => [
    stepOn('s1', 'CyberFingerprintProbe', t.httpUrl, 'recon'),
    stepOn('s2', 'CyberHttpProbe', t.httpUrl),
    stepOn('s3', 'CyberTlsProbe', t.tlsUrl)
  ]);
  try {
    const { result, replay } = await box.run('quick');
    assert.equal(result.outcome, 'completed');
    assert.equal(result.ledgerOk, true, 'the chain verifies after the run');

    const checks = new Set(result.findings.map((finding) => finding.checkId));
    for (const expected of ['missing-hsts', 'missing-x-content-type-options', 'server-version-disclosure', 'tls-certificate-expired']) {
      assert.ok(checks.has(expected), `the live run found ${expected}; got: ${[...checks].join(', ') || '(none)'}`);
    }
    for (const finding of result.findings) {
      assert.equal(finding.evidenceHash.length, 64, `${finding.checkId} carries evidence`);
      assert.ok(finding.wstg.length > 0, `${finding.checkId} carries a WSTG id`);
      assert.ok(finding.reproductionCommand.length > 0, `${finding.checkId} is reproducible`);
    }

    // Every finding is chained and comes back on replay, which is what an export reads.
    assert.equal(replay.chainOk, true);
    assert.equal(replay.findings.length, result.findings.length, 'each finding is a ledger entry that parses back');
    assert.deepEqual(
      replay.findings.map((finding) => finding.checkId).sort(),
      result.findings.map((finding) => finding.checkId).sort()
    );
  } finally {
    await box.dispose();
  }
});

test('the run keeps planning until the profile checks are covered, not one step and done', async () => {
  const quick = profileChecks('quick');
  assert.ok(quick.length >= 3, 'the quick profile asks for more than one check');
  const box = await harness((t) => [
    stepOn('s1', 'CyberFingerprintProbe', t.httpUrl, 'recon'),
    stepOn('s2', 'CyberHttpProbe', t.httpUrl),
    stepOn('s3', 'CyberTlsProbe', t.tlsUrl)
  ]);
  try {
    const { result } = await box.run('quick');
    assert.ok(result.steps >= 3, `the run executed every planned step, got ${result.steps}`);
    // The planner is told what is outstanding, so it plans toward coverage rather than one guess.
    assert.ok(box.prompts.some((prompt) => /still needs:/.test(prompt)), 'the planner prompt names the remaining checks');
  } finally {
    await box.dispose();
  }
});

test('a finding whose excerpt spans lines survives the ledger and replays intact', async () => {
  const box = await harness((t) => [stepOn('s1', 'CyberSecretsProbe', t.fixtureDir, 'recon')]);
  try {
    const { result, replay } = await box.run('quick');
    const secrets = result.findings.filter((finding) => finding.checkId === 'committed-secret');
    assert.ok(secrets.length >= 1, 'the fixture has committed credentials to find');
    const replayed = replay.findings.filter((finding) => finding.checkId === 'committed-secret');
    assert.equal(replayed.length, secrets.length, 'every secret finding parses back out of the chain');
    // A multi-line evidence excerpt is the shape that used to corrupt the stored JSON.
    assert.ok(secrets.some((finding) => finding.evidenceExcerpt.includes('\n')), 'at least one excerpt spans lines');
  } finally {
    await box.dispose();
  }
});

test('a check that already ran is never asked for again, and findings reach the panel live', async () => {
  // Two bugs the panel showed at once: the planner was told "recon still needed" after recon had run
  // (it compared tool names against check ids), and the probe's findings were added to the run
  // silently, so the timeline showed steps while the Findings table stayed empty.
  const box = await harness((t) => [
    stepOn('s1', 'CyberFingerprintProbe', t.httpUrl, 'recon'),
    stepOn('s2', 'CyberHttpProbe', t.httpUrl),
    stepOn('s3', 'CyberTlsProbe', t.tlsUrl)
  ]);
  const events: Array<{ type: string; checkId?: string }> = [];
  try {
    const result = await startCyberRunInPanel(
      { ...box.assembly, grants: new RunGrants(), tools: box.assembly.tools(box.engagement), externalFindings: box.collected, currentAcceptance: box.assembly.currentAcceptance, stopped: () => false },
      { engagement: box.engagement, mode: 'defensive', depth: 'quick', signal: new AbortController().signal, onEvent: (event) => events.push(event.type === 'finding' ? { type: 'finding', checkId: event.finding.checkId } : { type: event.type }) }
    );
    assert.equal(result.outcome, 'completed');
    assert.ok(result.findings.length >= 4, `the run found the seeded issues, got ${result.findings.length}`);

    // Every finding was announced as it happened, not only counted in the result.
    const announced = events.filter((event) => event.type === 'finding');
    assert.equal(announced.length, result.findings.length, 'each finding raised a live event');
    assert.ok(announced.some((event) => event.checkId === 'missing-hsts'), 'the header finding was announced');

    // The planner was told which checks remained, and never that a finished check was outstanding.
    const prompts = box.prompts.filter((prompt) => /still needs:|has run/.test(prompt));
    assert.ok(prompts.length >= 1, 'the planner was asked for a next step at least once');
    // Assert on the 'still needs' clause, not the whole prompt: the closing instruction mentions
    // recon legitimately ('do not repeat a check that already ran').
    // After recon ran, no mid-run prompt may list it as outstanding. The planner is asked for a
    // second step only once a check is covered, so every 'still needs' prompt here is post-recon.
    // The FIRST prompt legitimately lists every check; only later prompts must drop the ones done.
    const stillNeedsRecon = prompts.filter((prompt) => /still needs:[^.]*\brecon\b/.test(prompt));
    assert.equal(stillNeedsRecon.length, 1, 'recon was outstanding only on the opening prompt');
    // And the follow-up prompts did name the checks that genuinely remained.
    assert.ok(prompts.some((prompt) => /still needs:[^.]*\b(http-headers|tls)\b/.test(prompt)), 'the outstanding checks were named');
  } finally {
    await box.dispose();
  }
});

test('a run stopped before its last step still chains the findings it found', async () => {
  // The stopped, budget and rate-limit exits used to return before the persistence loop, so a
  // stopped run's findings were absent from the ledger and invisible to replay.
  const box = await harness((t) => [stepOn('s1', 'CyberHttpProbe', t.httpUrl),
    stepOn('s2', 'CyberTlsProbe', t.tlsUrl),
    stepOn('s3', 'CyberFingerprintProbe', t.httpUrl, 'recon')]);
  let stopped = false;
  try {
    const result = await startCyberRunInPanel(
      { ...box.assembly, grants: new RunGrants(), tools: box.assembly.tools(box.engagement), externalFindings: box.collected, currentAcceptance: box.assembly.currentAcceptance, stopped: () => stopped },
      {
        engagement: box.engagement, mode: 'defensive', depth: 'quick', signal: new AbortController().signal,
        // Stop after the first step, so later steps never run.
        onEvent: (event) => { if (event.type === 'step-finished') stopped = true; }
      }
    );
    const replay = await box.assembly.ledger.replay(result.runId);
    assert.equal(result.outcome, 'stopped');
    assert.ok(result.findings.length >= 1, 'the stopped run kept what it found');
    assert.equal(replay.findings.length, result.findings.length, 'and every one of them is in the chain');
    assert.equal(replay.chainOk, true);
  } finally {
    await box.dispose();
  }
});

test('the Stop button (an aborted signal) mid-run still chains the findings it found', async () => {
  // Stop aborts the run's signal, so the next model call rejects with AbortError before the
  // in-loop stop check. That rejection used to escape the run, and every finding was lost.
  const box = await harness((t) => [stepOn('s1', 'CyberHttpProbe', t.httpUrl),
    stepOn('s2', 'CyberTlsProbe', t.tlsUrl),
    stepOn('s3', 'CyberFingerprintProbe', t.httpUrl, 'recon')]);
  const controller = new AbortController();
  const announced: string[] = [];
  try {
    const result = await startCyberRunInPanel(
      { ...box.assembly, grants: new RunGrants(), tools: box.assembly.tools(box.engagement), externalFindings: box.collected, currentAcceptance: box.assembly.currentAcceptance, stopped: () => false },
      {
        engagement: box.engagement, mode: 'defensive', depth: 'quick', signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'finding') announced.push(event.finding.checkId);
          if (event.type === 'step-finished') controller.abort();
        }
      }
    );
    assert.equal(result.outcome, 'stopped');
    assert.ok(announced.length >= 1, 'the first step announced findings before the stop');
    assert.equal(result.findings.length, announced.length, 'every announced finding is kept');
    const replay = await box.assembly.ledger.replay(result.runId);
    assert.equal(replay.findings.length, result.findings.length, 'and every one of them is in the chain');
    assert.equal(replay.chainOk, true);
  } finally {
    await box.dispose();
  }
});
