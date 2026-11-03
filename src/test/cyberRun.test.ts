// The run engine end to end (CYBER-04, CYBER-05, CYBER-11): a scripted text-only model drives the
// four roles, every step is a ledger entry, a denied or out-of-scope step never reaches its tool, the
// acceptance gate is production code, an incompatible model still yields an honest record, and replay
// reproduces findings with no tool invocation and no network.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AskRoleResult } from '../agent/cyberProtocolDriver';
import type { Step, StepRole } from '../domain/cyberProtocol';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import type { DisclaimerAcceptance, Engagement, Finding } from '../domain/cyber';
import { scopeFingerprint, type AcceptanceSnapshot } from '../domain/cyberLegal';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import type { AgentTool } from '../agent/tools';
import { CyberEvidenceStore, CyberLedgerStore } from '../services/cyberLedgerStore';
import { checkAcceptance, replayRun, scopeIncludes, startCyberRun, type CyberRunEvent, type RunTool } from '../services/cyberRun';

const ACCEPTANCE: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10',
  textVersion: 'v1', region: 'us', acceptedAt: '2026-10-31T12:00:00Z'
};

/** Replies for a completed run: operator echoes the plan, critic judges it, reporter writes it. */
function fourRoles(planned: Step, extra: Partial<Record<StepRole, string[]>> = {}): Partial<Record<StepRole, string[]>> {
  return {
    planner: [JSON.stringify(planned)],
    operator: [JSON.stringify(planned)],
    critic: [JSON.stringify({ ...planned, role: 'critic' as StepRole, action: 'verify' as const })],
    reporter: [JSON.stringify({ ...planned, role: 'reporter' as StepRole, action: 'report' as const })],
    ...extra
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 's1', role: 'operator', action: 'probe', target: 'https://example.test/', tool: 'CyberHttpProbe',
    args: ['https://example.test/'], sandbox: 'none', expectedResult: 'a 200 response',
    safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] }, ...overrides
  };
}

const SCOPE = { hosts: ['example.test'], ports: [443], paths: [], exclusions: [] };

function engagement(overrides: Partial<Engagement> = {}, acceptance: Partial<DisclaimerAcceptance> = {}): Engagement {
  return {
    id: 'eng-00000000-0000-4000-8000-000000000001',
    workspace: '/workspace/example', target: { kind: 'url', value: 'https://example.test/' },
    resolvedScope: SCOPE, region: 'us', authorizationStatement: 'The acceptor owns the target.',
    allowedModes: ['passive'], exclusions: [], sandbox: { tier: 'tempFolder' },
    acceptedDisclaimer: { ...ACCEPTANCE, ...acceptance }, createdAt: ACCEPTANCE.acceptedAt, frozen: false, ...overrides
  };
}

const snapshotFor = (overrides: Partial<AcceptanceSnapshot> = {}): AcceptanceSnapshot => ({
  region: 'us', scope: scopeFingerprint(SCOPE), extensionVersion: '0.4.10', textVersion: 'v1', ...overrides
});

/** A text-only model: each role gets a canned reply string. It has no tool-call channel at all. */
class ScriptedModel {
  public calls: StepRole[] = [];
  public constructor(private readonly replies: Partial<Record<StepRole, string[]>>) {}
  public async askRole(role: StepRole, _messages: Array<{ role: string; content: string }>): Promise<AskRoleResult> {
    this.calls.push(role);
    const queue = this.replies[role];
    // An exhausted planner says it is done, which is the protocol's own stop signal (the engine keeps
    // asking for steps until the profile's checks are covered).
    const reply = queue?.length ? queue.shift()! : JSON.stringify({ id: `done-${this.calls.length}`, role, action: 'report', target: 'https://example.test/', tool: 'done', args: [], sandbox: 'none', expectedResult: 'done', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] } });
    try {
      const parsed = JSON.parse(reply) as Step;
      return { kind: 'steps', role, steps: [parsed], repairs: 0 };
    } catch {
      return { kind: 'incompatible', role, reason: 'no-json: the reply held no JSON object', attempts: 4 };
    }
  }
}

function countingTool(name: string, output: string): { tool: AgentTool<any>; calls: string[] } {
  const calls: string[] = [];
  const tool: AgentTool<{ args?: string[]; target?: string }> = {
    name, description: name, parameters: { type: 'object', properties: {} }, capability: 'read',
    parse: (raw) => ({ args: raw.args as string[] | undefined, target: raw.target as string | undefined }),
    title: () => name,
    async run() { calls.push(name); return output; }
  };
  return { tool, calls };
}

async function harness(options: {
  replies: Partial<Record<StepRole, string[]>>;
  tools?: RunTool[];
  engagement?: Engagement;
  current?: AcceptanceSnapshot;
  grants?: RunGrants;
  policy?: { mode: 'approve-risky' | 'fully-autonomous' | 'auto'; emergencyStop: boolean };
  approve?: boolean;
  stopped?: () => boolean;
  signal?: AbortSignal;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-run-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-runroot-'));
  const shell = new ShellSession(root);
  const context: ToolContext = { root, signal: options.signal ?? new AbortController().signal, checkpoints: new RunCheckpoints('cyber-run'), shell, readFiles: new Set() };
  const ledger = new CyberLedgerStore(directory);
  const evidence = new CyberEvidenceStore(directory);
  const events: CyberRunEvent[] = [];
  const driver = new ScriptedModel(options.replies);
  const result = await startCyberRun({
    engagement: options.engagement ?? engagement(),
    currentAcceptance: options.current ?? snapshotFor(),
    driver: driver as never,
    tools: options.tools ?? [],
    ledger,
    evidence,
    grants: options.grants ?? new RunGrants(),
    policy: options.policy ?? { mode: 'fully-autonomous', emergencyStop: false },
    rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: options.approve === false ? 'deny' : 'allow' }),
    signal: options.signal ?? new AbortController().signal,
    ...(options.stopped ? { stopped: options.stopped } : {}),
    toolContext: context,
    now: () => new Date('2026-11-02T12:00:00Z'),
    onEvent: (event) => events.push(event)
  });
  return { result, events, ledger, evidence, driver, directory, dispose: () => shell.dispose() };
}

const HSTS_OUTPUT = 'MEDIUM: Strict-Transport-Security header is missing\nReproduce: `curl -sS -I https://example.test/`';

/** The finding a probe's onFindings collector would hand the run, shaped like cyberProbes' output. */
const HSTS_FINDING: Finding = {
  id: 'missing-hsts-abc123', checkId: 'missing-hsts', title: 'Strict-Transport-Security header is missing',
  severity: 'medium', verdict: 'could_not_determine', cvssVector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N', cwes: [],
  wstg: ['WSTG-CONF-02'], evidenceExcerpt: HSTS_OUTPUT, evidenceHash: '', reproductionCommand: "curl -sS -I 'https://example.test/'",
  remediation: 'Send Strict-Transport-Security.'
};

/** A RunTool for a probe, wired the way the panel wires one: findings come from the collector. */
function probeRunTool(tool: AgentTool<any>, findings: Finding[] = [HSTS_FINDING]): RunTool {
  return { tool, capability: 'read', target: (candidate) => candidate.target, input: (candidate) => ({ target: candidate.target }), findings: () => findings };
}

test('a full run records a verified ledger, findings, and a replayable transcript', async () => {
  const probe = countingTool('CyberHttpProbe', HSTS_OUTPUT);
  const box = await harness({
    replies: fourRoles(step()),
    tools: [probeRunTool(probe.tool)]
  });
  try {
    assert.equal(box.result.outcome, 'completed');
    assert.equal(box.result.ledgerOk, true);
    assert.equal(box.result.findings.length, 1);
    assert.equal(box.result.findings[0].checkId, 'missing-hsts');
    assert.match(box.result.findings[0].reproductionCommand, /curl -sS -I/);
    assert.ok(box.result.findings[0].evidenceHash.length === 64);
    assert.deepEqual(probe.calls, ['CyberHttpProbe']);
    // All four roles are separate model calls, and the planner is asked again for each check the
    // profile still needs — so it appears more than once in a run that covers several checks.
    assert.deepEqual([...new Set(box.driver.calls)], ['planner', 'operator', 'critic', 'reporter'], 'all four roles are separate model calls');
    assert.ok(box.driver.calls.filter((role) => role === 'planner').length >= 1);

    const replay = await replayRun(box.result.runId, box.ledger);
    assert.equal(replay.chainOk, true);
    assert.deepEqual(replay.findings.map((found) => found.checkId), ['missing-hsts']);
    assert.equal(probe.calls.length, 1, 'replay executes nothing');
  } finally {
    box.dispose();
  }
});

test('a model that cannot follow the protocol yields an incompatible run with an honest record', async () => {
  const box = await harness({ replies: { planner: ['I think you should scan the target.', 'Still prose.', 'More prose.'] } });
  try {
    assert.equal(box.result.outcome, 'incompatible');
    assert.match(box.result.reason ?? '', /planner could not follow the JSON protocol/);
    assert.equal(box.result.findings.length, 0);
    assert.equal(await box.ledger.verify(box.result.runId), true, 'the partial chain still verifies');
    assert.ok(box.events.some((event) => event.type === 'incompatible'));
  } finally {
    box.dispose();
  }
});

test('an aborted run stops with a partial chain that still verifies', async () => {
  const controller = new AbortController();
  const probe = countingTool('CyberHttpProbe', HSTS_OUTPUT);
  const box = await harness({
    replies: fourRoles(step()),
    tools: [probeRunTool(probe.tool)],
    signal: controller.signal
  });
  try {
    assert.equal(box.result.outcome, 'completed');
  } finally {
    box.dispose();
  }

  const stoppedBox = await harness({
    replies: fourRoles(step()),
    tools: [probeRunTool(countingTool('CyberHttpProbe', HSTS_OUTPUT).tool)],
    stopped: () => true
  });
  try {
    assert.equal(stoppedBox.result.outcome, 'stopped');
    assert.equal(await stoppedBox.ledger.verify(stoppedBox.result.runId), true);
  } finally {
    stoppedBox.dispose();
  }
});

test('an out-of-scope step is refused, audited in the ledger, and never reaches its tool', async () => {
  const probe = countingTool('CyberHttpProbe', HSTS_OUTPUT);
  const box = await harness({
    replies: fourRoles(step({ target: 'https://evil.test/', args: ['https://evil.test/'] })),
    tools: [probeRunTool(probe.tool)]
  });
  try {
    assert.equal(probe.calls.length, 0, 'the probe never ran');
    const entries = await box.ledger.entries(box.result.runId);
    const refusal = entries.find((entry) => entry.result.includes('outside the resolved scope'));
    assert.ok(refusal, 'the refusal is a ledger entry');
    assert.match(refusal.result, /evil\.test/);
    assert.equal(await box.ledger.verify(box.result.runId), true);
  } finally {
    box.dispose();
  }
});

test('a shell step denied by the permission path never reaches its tool and the deny reason is recorded', async () => {
  const exploit = countingTool('CyberExploitTool', 'root:x:0:0');
  const box = await harness({
    replies: fourRoles(step({ tool: 'CyberExploitTool', action: 'exploit', args: ['rm', '-rf', '/'], sandbox: 'tempFolder' })),
    tools: [{ tool: exploit.tool, capability: 'shell', target: (candidate) => candidate.target }],
    policy: { mode: 'approve-risky', emergencyStop: false },
    grants: new RunGrants()
  });
  try {
    assert.equal(exploit.calls.length, 0, 'a denied shell step never executes');
    const entries = await box.ledger.entries(box.result.runId);
    const denial = entries.find((entry) => entry.result.startsWith('refused:'));
    assert.ok(denial, 'the denial is recorded');
    assert.match(denial.result, /deny list|outside|declined|grant/i);
  } finally {
    box.dispose();
  }
});

test('the acceptance gate is production code: an empty acceptor and a stale version both refuse before any model call', async () => {
  const noName = await harness({ replies: {}, engagement: engagement({}, { acceptor: '   ' }) });
  try {
    assert.equal(noName.result.outcome, 'refused');
    assert.match(noName.result.reason ?? '', /^no-acceptance:/);
    assert.equal(noName.driver.calls.length, 0, 'the driver was never asked');
    assert.equal((await noName.ledger.entries(noName.result.runId)).length, 0, 'nothing was appended');
  } finally {
    noName.dispose();
  }

  const stale = await harness({ replies: {}, current: snapshotFor({ extensionVersion: '9.9.9' }) });
  try {
    assert.equal(stale.result.outcome, 'refused');
    assert.match(stale.result.reason ?? '', /^reacceptance-required:/);
    assert.equal(stale.driver.calls.length, 0);
  } finally {
    stale.dispose();
  }

  assert.equal(checkAcceptance(undefined, engagement(), snapshotFor()).ok, false);
  assert.equal(checkAcceptance(ACCEPTANCE, engagement(), snapshotFor()).ok, true);
});

test('an approval the user declines is recorded and the tool never runs', async () => {
  const probe = countingTool('CyberExploitTool', 'root:x:0:0');
  const box = await harness({
    replies: fourRoles(step({ tool: 'CyberExploitTool', action: 'exploit', sandbox: 'tempFolder' })),
    tools: [{ tool: probe.tool, capability: 'shell', target: (candidate) => candidate.target }],
    policy: { mode: 'approve-risky', emergencyStop: false },
    approve: false
  });
  try {
    assert.equal(probe.calls.length, 0);
    const entries = await box.ledger.entries(box.result.runId);
    assert.ok(entries.some((entry) => /declined/.test(entry.result)));
  } finally {
    box.dispose();
  }
});

test('scope includes a URL only at its host and port, and a workspace path by prefix', () => {
  assert.equal(scopeIncludes(SCOPE, 'https://example.test/'), true);
  assert.equal(scopeIncludes(SCOPE, 'https://evil.test/'), false);
  assert.equal(scopeIncludes(SCOPE, 'https://example.test:8443/'), false, 'a port outside the scope is out of scope');
  const workspace = { hosts: [], ports: [], paths: ['/work/project'], exclusions: [] };
  assert.equal(scopeIncludes(workspace, '/work/project/src/index.ts'), true);
  assert.equal(scopeIncludes(workspace, '/work/other'), false);
  assert.equal(scopeIncludes(SCOPE, ''), false);
});
