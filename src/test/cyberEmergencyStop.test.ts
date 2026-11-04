// CYBER-10's ordering, proven: the stop control beats the grant, the deny list beats the grant, the
// grant covers an in-scope step of its own engagement and DENIES an out-of-scope one (never asks),
// and a stop or a limit refuses a step without ever touching the sandbox.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { cyberExploitTools, payloadArgv, stepGate, type CyberExploitDeps } from '../agent/cyberExploitTools';
import { decidePermission, DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import { checkBudget, RateLimiter } from '../domain/cyberLimits';
import type { Sandbox } from '../services/cyberSandbox';

const ENGAGEMENT = 'eng-00000000-0000-4000-8000-000000000001';
const APPROVE = { mode: 'approve-risky', emergencyStop: false } as const;
const IN_SCOPE = ['https://example.test/', 'https://example.test/login'];
const inScope = (target: string) => IN_SCOPE.includes(target);

function granted(): { grants: RunGrants } {
  const grants = new RunGrants();
  grants.intrusiveEngagement = { engagementId: ENGAGEMENT, inScope };
  return { grants };
}

test('a shell-capability call with no grant still asks, exactly as before', () => {
  assert.equal(decidePermission('shell', 'curl https://example.test/', APPROVE, DEFAULT_RULES, new RunGrants()).decision, 'ask');
  // An intrusive step with no grant asks too: the step context alone never allows anything.
  assert.equal(decidePermission('shell', 'sqlmap -u https://example.test/login', APPROVE, DEFAULT_RULES, new RunGrants(), undefined, { engagementId: ENGAGEMENT, target: IN_SCOPE[1] }).decision, 'ask');
});

test('under the grant an in-scope step is allowed and the reason names the engagement', () => {
  const { grants } = granted();
  const decided = decidePermission('shell', 'sqlmap -u https://example.test/login', APPROVE, DEFAULT_RULES, grants, undefined, { engagementId: ENGAGEMENT, target: IN_SCOPE[1] });
  assert.equal(decided.decision, 'allow');
  assert.match(decided.decision === 'allow' ? decided.reason ?? '' : '', new RegExp(ENGAGEMENT));
  assert.match(decided.decision === 'allow' ? decided.reason ?? '' : '', /intrusive grant/);
});

test('under the grant an out-of-scope target is DENIED, not asked', () => {
  const { grants } = granted();
  const decided = decidePermission('shell', 'sqlmap -u https://evil.test/', APPROVE, DEFAULT_RULES, grants, undefined, { engagementId: ENGAGEMENT, target: 'https://evil.test/' });
  assert.equal(decided.decision, 'deny');
  assert.match(decided.decision === 'deny' ? decided.reason : '', /outside the resolved scope of engagement/);
});

test('a step for another engagement falls through to the ordinary order', () => {
  const { grants } = granted();
  assert.equal(decidePermission('shell', 'curl https://example.test/', APPROVE, DEFAULT_RULES, grants, undefined, { engagementId: 'eng-other', target: IN_SCOPE[0] }).decision, 'ask');
});

test('the emergency stop beats the grant', () => {
  const { grants } = granted();
  const decided = decidePermission('shell', 'sqlmap -u https://example.test/login', { mode: 'approve-risky', emergencyStop: true }, DEFAULT_RULES, grants, undefined, { engagementId: ENGAGEMENT, target: IN_SCOPE[1] });
  assert.equal(decided.decision, 'deny');
  assert.match(decided.decision === 'deny' ? decided.reason : '', /Emergency stop/);
});

test('the deny list beats the grant', () => {
  const { grants } = granted();
  const decided = decidePermission('shell', 'mkfs.ext4 /dev/sda', APPROVE, DEFAULT_RULES, grants, undefined, { engagementId: ENGAGEMENT, target: IN_SCOPE[1] });
  assert.equal(decided.decision, 'deny');
  assert.match(decided.decision === 'deny' ? decided.reason : '', /deny list/);
});

interface FakeSandbox { sandbox: Sandbox; execs: string[][]; stops: number }

function fakeSandbox(options: { onExec?: (signal?: AbortSignal) => void } = {}): FakeSandbox {
  const state: FakeSandbox = { execs: [], stops: 0, sandbox: undefined as unknown as Sandbox };
  state.sandbox = {
    tier: 'tempFolder',
    id: '/tmp/cyber-fake',
    async exec(argv, signal) {
      state.execs.push(argv);
      options.onExec?.(signal);
      if (signal?.aborted) throw new Error('The stop control stopped the sandbox command.');
      return { argv, exitCode: 0, stdout: 'uid=1000(fixture)', stderr: '' };
    },
    async stop() { state.stops += 1; }
  };
  return state;
}

async function toolHarness(overrides: Partial<CyberExploitDeps> = {}, execOptions: { onExec?: (signal?: AbortSignal) => void } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-stop-'));
  const shell = new ShellSession(root);
  const fake = fakeSandbox(execOptions);
  const deps: CyberExploitDeps = {
    engagementId: ENGAGEMENT,
    inScope,
    sandboxTier: 'tempFolder',
    openSandbox: async () => fake.sandbox,
    ...overrides
  };
  const [exploit, postExploit] = cyberExploitTools(deps);
  const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-stop'), shell, readFiles: new Set() };
  return { fake, exploit, postExploit, context, dispose: () => shell.dispose() };
}

test('a step started after the stop control refuses without ever reaching the sandbox', async () => {
  const box = await toolHarness({ stopped: () => true });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.match(output, /Refused: The stop control is engaged/);
    assert.equal(box.fake.execs.length, 0, 'the sandbox was never asked to run anything');
    assert.equal(box.fake.stops, 0, 'nothing was started, so nothing needed stopping');
    assert.match(stepGate({ engagementId: ENGAGEMENT, inScope, sandboxTier: 'tempFolder', stopped: () => true }, { engagementId: ENGAGEMENT, target: IN_SCOPE[0] }).refused ? 'refused' : '', /refused/);
  } finally {
    box.dispose();
  }
});

test('an abort mid-exec still stops the sandbox exactly once', async () => {
  const controller = new AbortController();
  const box = await toolHarness({}, { onExec: () => controller.abort() });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    await assert.rejects(box.exploit.run(input, { ...box.context, signal: controller.signal }), /stop control stopped the sandbox command/);
    assert.equal(box.fake.execs.length, 1);
    assert.equal(box.fake.stops, 1, 'cleanup ran in the finally path');
  } finally {
    box.dispose();
  }
});

test('an intrusive step without the grant reports approval-required and never executes', async () => {
  const box = await toolHarness({ granted: () => false });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.match(output, /Refused: Intrusive steps need the engagement-wide grant/);
    assert.equal(box.fake.execs.length, 0);
  } finally {
    box.dispose();
  }
});

test('a rate-limited step refuses with the rate reason and no exec', async () => {
  const limiter = new RateLimiter(1);
  limiter.acquire();
  const box = await toolHarness({ rateLimiter: limiter, granted: () => true });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.match(output, /Refused: rate limit: 1 ops\/min reached/);
    assert.equal(box.fake.execs.length, 0);
  } finally {
    box.dispose();
  }
});

test('a budget-exceeded step refuses with the reason and names what was not reached', async () => {
  const budget = () => checkBudget({ startedAt: 0, budgetMs: 1_000, planned: { hosts: ['10.0.0.1', '10.0.0.2'], checks: ['tls', 'dns'], completed: { hosts: ['10.0.0.1'], checks: ['tls'] } } }, 5_000);
  const box = await toolHarness({ budget, granted: () => true });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.match(output, /Refused: wall-clock budget reached/);
    assert.match(output, /Not reached: 10\.0\.0\.2; checks dns/);
    assert.equal(box.fake.execs.length, 0);
  } finally {
    box.dispose();
  }
});

test('a disabled sandbox tier refuses the step with its reason', async () => {
  const box = await toolHarness({ sandboxTier: 'disabled', granted: () => true });
  try {
    const input = box.exploit.parse({ payload: 'curl https://example.test/', target: IN_SCOPE[0], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.match(output, /Refused: Offensive mode is disabled/);
    assert.equal(box.fake.execs.length, 0);
  } finally {
    box.dispose();
  }
});

test('a successful step runs one argv, records evidence, and cleans up', async () => {
  const evidence: string[] = [];
  const box = await toolHarness({ granted: () => true, onEvidence: (entry) => evidence.push(entry.output) });
  try {
    const input = box.exploit.parse({ payload: 'curl -sS https://example.test/login', target: IN_SCOPE[1], engagementId: ENGAGEMENT });
    const output = await box.exploit.run(input, box.context);
    assert.deepEqual(box.fake.execs, [['curl', '-sS', 'https://example.test/login']]);
    assert.equal(box.fake.stops, 1);
    assert.match(output, /uid=1000/);
    assert.match(output, /Exit status: 0/);
    assert.match(output, /tempFolder/);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0], /curl -sS/);
  } finally {
    box.dispose();
  }
});

test('a post-exploitation write is refused before any sandbox opens, and an accepted one is recorded', async () => {
  const commands: string[] = [];
  const box = await toolHarness({ granted: () => true, onCommand: (command) => commands.push(command) });
  try {
    const refused = await box.postExploit.run(box.postExploit.parse({ command: 'rm -rf /tmp/x', target: IN_SCOPE[0], engagementId: ENGAGEMENT }), box.context);
    assert.match(refused, /Refused: post-exploitation rule/);
    assert.equal(box.fake.execs.length, 0);
    assert.deepEqual(commands, []);

    const accepted = await box.postExploit.run(box.postExploit.parse({ command: 'whoami', target: IN_SCOPE[0], engagementId: ENGAGEMENT }), box.context);
    assert.match(accepted, /read-only command "whoami" recorded/);
    assert.deepEqual(commands, ['whoami']);
    assert.deepEqual(box.fake.execs, [['whoami']]);
  } finally {
    box.dispose();
  }
});

test('a payload is split into argv, never handed to a shell', () => {
  assert.deepEqual(payloadArgv('  curl   -sS https://example.test/  '), ['curl', '-sS', 'https://example.test/']);
  assert.throws(() => payloadArgv('   '), /payload is empty/i);
});
