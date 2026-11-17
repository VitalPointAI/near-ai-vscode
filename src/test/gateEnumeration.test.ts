// The gate in front of every chat tool call and every sub-agent's (GATE-04, GATE-07, OFFL-02, D-08, D-09, D-10, D-43): a real run's call is decided and
// recorded on disk before it runs, a broken bundle fails closed, a card is only a transport (its answer goes back into the gate, which records it and
// re-checks), sub-agents pass the same gate as a person's run, and with a valid bundle nothing decides differently. Plan 13 adds the remaining execution
// paths to this file: the cyber panel's step engine, benchmark runs, and the scans that find every place a tool runs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { effectsOfCall, gateToolCall, recordApprovalReply, recordLateApproval, manifestArguments } from '../agent/gateAdapter';
import { AgentRun } from '../agent/loop';
import type { AgentEvent, ApprovalReply, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { builtInTools } from '../agent/toolCatalog';
import { CORE_TOOLS } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { BUNDLE_FAILURES, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { GATE_RULE_IDS } from '../domain/gate/decide';
import { EFFECTS_NOT_DECLARED_TEXT, describeManifest } from '../domain/gate/words';
import type { GateRuntime } from '../domain/gate/decide';
import type { ToolManifest } from '../domain/gate/manifest';
import type { DecisionRecord } from '../domain/gate/record';
import type { ActionPolicy } from '../domain/policy';
import { GateHost } from '../gate/host';
import type { RuntimeRequest } from '../gate/host';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { mcpAgentTools } from '../mcp/tools';
import type { McpConnection, McpServerConfig } from '../mcp/client';
import { MemorySecrets } from './helpers/teamHarness';
import { testManifest } from './helpers/gateFixtures';
import { CyberEvidenceStore, CyberLedgerStore } from '../services/cyberLedgerStore';
import { startCyberRun } from '../services/cyberRun';
import type { RunTool } from '../services/cyberRun';
import type { AskRoleResult } from '../agent/cyberProtocolDriver';
import type { Step, StepRole } from '../domain/cyberProtocol';
import type { DisclaimerAcceptance, Engagement } from '../domain/cyber';
import { scopeFingerprint } from '../domain/cyberLegal';
import type { ToolContext } from '../agent/tools';
import { planRoleSuite, runRoleSuite } from '../benchmark/roleSuite';
import { runAgentInFolder, runComparison, runGateFor } from '../benchmark/runner';
import type { BenchmarkClient } from '../benchmark/runner';
import { planComparison } from '../benchmark/results';
import type { ResultRow } from '../benchmark/results';
import { loadBenchmarkTasks } from '../benchmark/tasks';
import { testGateRuntime } from './helpers/gatedRuns';
import { configuredFiles, countByFile, findToolRunSites, programFor } from './helpers/toolRunScan';
import type { RunSite } from './helpers/toolRunScan';

// The name of the floor option PR 2 had, built so that a search of src for it finds only product code that brings it back.
const OLD_FLOOR_OPTION = ['floor', 'Mode'].join('');

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };

type Turn = { text?: string; calls?: ToolCall[] };

function scriptedModel(turns: Turn[]) {
  let seen = 0;
  return {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const turn = turns[seen] ?? { text: 'done' };
      seen += 1;
      if (turn.text) yield { type: 'text', text: turn.text };
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage };
    }
  };
}

interface Started { host: GateHost; storage: string; secrets: MemorySecrets; problems: string[] }

async function startedHost(shared?: { storage: string; secrets: MemorySecrets }): Promise<Started> {
  const storage = shared?.storage ?? await mkdtemp(path.join(tmpdir(), 'near-ai-gate-storage-'));
  const secrets = shared?.secrets ?? new MemorySecrets();
  const problems: string[] = [];
  const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', onProblem: (message) => problems.push(message) });
  await host.start();
  return { host, storage, secrets, problems };
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-project-'));
  await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'b.ts'), 'export const other = 2;\n');
  await writeFile(path.join(root, 'c.ts'), 'export const third = 3;\n');
  return root;
}

async function logOf(started: Started, root: string): Promise<DecisionRecord[]> {
  await started.host.flush();
  const file = path.join(started.storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

const callIdOf = (record: DecisionRecord): string => record.api.request.uid;
const ruleOf = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';

/** The gate's own word for a record's outcome: the asked outcome lives in unmapped.nearAi.outcome, every other one is told by the OCSF ids. */
function outcomeOf(record: DecisionRecord): string {
  if (record.unmapped.nearAi.outcome !== undefined) return record.unmapped.nearAi.outcome;
  if (record.disposition_id === 8) return 'approved';
  if (record.action_id === 1) return 'allowed';
  return record.disposition_id === 2 ? 'refused-by-floor' : 'denied';
}

interface RunSetup {
  root: string;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  run: AgentRun;
  shell: ShellSession;
  policy: ActionPolicy;
}

function runWith(root: string, turns: Turn[], options: { gate?: GateRuntime; mode?: ActionPolicy['mode']; tools?: AgentTool<any>[]; answer?: (request: ApprovalRequest) => ApprovalReply | Promise<ApprovalReply> }): RunSetup {
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const shell = new ShellSession(root);
  const policy: ActionPolicy = { mode: options.mode ?? 'approve-risky', emergencyStop: false };
  const run = new AgentRun({
    client: scriptedModel(turns), model: 'z-ai/glm-5.3', tools: options.tools ?? CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('gate'), shell, readFiles: new Set() },
    policy, rules: DEFAULT_RULES,
    ...(options.gate ? { gate: options.gate } : {}),
    requestApproval: async (request) => { approvals.push(request); return options.answer ? options.answer(request) : { decision: 'allow' }; },
    emit: (event) => events.push(event)
  });
  return { root, events, approvals, run, shell, policy };
}

const go = (setup: RunSetup): ReturnType<AgentRun['run']> => setup.run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
const toolOutputs = (setup: RunSetup): string[] => setup.events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);

// ---- Task 1: the tracer ----

test('tracer: activation starts the gate, and a chat run\'s Write is decided in shadow, asked and recorded on disk before it runs', async () => {
  const started = await startedHost();
  const root = await project();
  const target = path.join(root, 'out.md');
  let seenWhenAsked: DecisionRecord[] = [];
  let existedWhenAsked: boolean | undefined;
  const setup = runWith(root, [{ calls: [call('w1', 'Write', { file_path: 'out.md', content: 'hello' })] }, { text: 'Written.' }], {
    gate: await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'conv-1', agentId: 'main-1', agentLabel: 'agent' }, presence: 'person', context: 'interactive' }),
    answer: async () => {
      // The card is being shown: the record of the question must already be on disk, and the file must not exist yet.
      seenWhenAsked = await logOf(started, root);
      existedWhenAsked = existsSync(target);
      return { decision: 'allow' };
    }
  });
  try {
    const result = await go(setup);
    assert.equal(result.outcome, 'completed');
    assert.equal(await readFile(target, 'utf8'), 'hello');
  } finally {
    setup.shell.dispose();
  }
  const asked = seenWhenAsked.find((record) => callIdOf(record) === 'w1');
  assert.ok(asked, 'the asked record was in the file while the card was open');
  assert.equal(outcomeOf(asked), 'asked');
  assert.equal(ruleOf(asked), 'settings.mode.edits');
  assert.equal(existedWhenAsked, false, 'the file did not exist when the question was recorded');
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record)]), [['w1', 'asked'], ['w1', 'approved']], 'asked then approved, same call id');
  assert.deepEqual(records.map((record) => record.metadata.sequence), [1, 2]);
  assert.equal(records[0]?.api.operation, 'workspaceWrite');
  assert.equal(records[0]?.resources[0]?.name, 'out.md');
  assert.equal(records[0]?.ai_agent?.uid, 'main-1');
  assert.ok(records.every((record) => record.unmapped.nearAi.bundleHash.length === 64), 'every record names the valid bundle');
});

test('a changed bundle file fails closed: a Write is refused with the bundle\'s own sentence while a Read still runs, and both are recorded', async () => {
  const first = await startedHost();
  const file = path.join(gateDir(first.storage), POLICY_BUNDLE_FILE);
  const text = await readFile(file, 'utf8');
  assert.ok(text.includes('interactive'));
  await writeFile(file, text.replace('interactive', 'interactivf'), 'utf8');
  const second = await startedHost({ storage: first.storage, secrets: first.secrets });
  const state = await second.host.state();
  assert.equal(state.state, 'failed-closed');
  const sentence = state.state === 'failed-closed' ? state.sentence : '';
  const root = await project();
  const setup = runWith(root, [
    { calls: [call('w1', 'Write', { file_path: 'out.md', content: 'nope' }), call('r1', 'Read', { file_path: 'a.ts' })] },
    { text: 'ok' }
  ], { gate: await second.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'conv-2', agentId: 'main-2' }, presence: 'person', context: 'interactive' }), mode: 'fully-autonomous' });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  const [write, read] = toolOutputs(setup);
  assert.equal(write, `Not allowed: ${sentence}`);
  assert.match(read ?? '', /export const value = 1/);
  assert.equal(existsSync(path.join(root, 'out.md')), false);
  assert.equal(setup.approvals.length, 0, 'a refusal shows no card');
  const records = (await logOf(second, root)).filter((record) => ['w1', 'r1'].includes(callIdOf(record)));
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record), ruleOf(record)]), [['w1', 'denied', 'bundle.failed-closed'], ['r1', 'allowed', 'settings.read-plan']]);
});

test('with a valid bundle the gate changes no decision: Edit asks in approve-risky, the same call runs unasked in mostly-autonomous, a Read never asks', async () => {
  const started = await startedHost();
  const root = await project();
  const runtime = (): Promise<GateRuntime> => started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive' });
  const edit = (id: string): ToolCall => call(id, 'Edit', { file_path: 'a.ts', old_string: 'value = 1', new_string: 'value = 2' });
  const asking = runWith(root, [{ calls: [call('r1', 'Read', { file_path: 'a.ts' }), edit('e1')] }, { text: 'done' }], { gate: await runtime() });
  try {
    await go(asking);
  } finally {
    asking.shell.dispose();
  }
  assert.deepEqual(asking.approvals.map((request) => request.callId), ['e1'], 'only the edit asked');
  assert.match(await readFile(path.join(root, 'a.ts'), 'utf8'), /value = 2/);
  const quiet = runWith(root, [{ calls: [call('r2', 'Read', { file_path: 'a.ts' })] }, { calls: [edit('e2')] }, { text: 'done' }], { gate: await runtime(), mode: 'mostly-autonomous' });
  try {
    await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
    await go(quiet);
  } finally {
    quiet.shell.dispose();
  }
  assert.equal(quiet.approvals.length, 0);
  assert.match(await readFile(path.join(root, 'a.ts'), 'utf8'), /value = 2/, 'the edit ran without a question');
});

// ---- the loop passes the model's raw arguments, and an absolute path inside the project is read as its project path ----

test('a Write named by an absolute path inside the project is judged as that project path: the floor asks in fully-autonomous, and the record names the floor rule and the project path', async () => {
  const started = await startedHost();
  const root = await project();
  const hooks = path.join(root, '.git', 'hooks');
  const setup = runWith(root, [{ calls: [call('w1', 'Write', { file_path: path.join(hooks, 'pre-commit'), content: '#!/bin/sh\n' })] }, { text: 'ok' }], {
    gate: await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive' }),
    mode: 'fully-autonomous'
  });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  // The floor asked, with no shortcut on the card; the person's allow ran that one call, and both decisions are on record against it.
  assert.equal(setup.approvals.length, 1);
  assert.equal(setup.approvals[0]?.grant, undefined);
  assert.equal(setup.approvals[0]?.allowRule, undefined);
  const records = await logOf(started, root);
  const first = records.find((record) => callIdOf(record) === 'w1');
  assert.ok(first);
  assert.equal(first.authorizations[0]?.policy.name, 'floor.protected-write');
  assert.equal(first.unmapped.nearAi.shadowFloor, undefined, 'nothing is only reported any more');
  assert.equal(first.resources[0]?.name, '.git/hooks/pre-commit');
});

test('manifestArguments writes an absolute path inside the folder as a project path, leaves one outside as it is, and applies the tool\'s own defaults first', () => {
  const root = path.join(tmpdir(), 'near-ai-gate-args');
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const glob = CORE_TOOLS.find((tool) => tool.name === 'Glob') as AgentTool<any>;
  assert.deepEqual(manifestArguments(read, { file_path: path.join(root, 'src', 'a.ts') }, root), { file_path: 'src/a.ts' });
  assert.deepEqual(manifestArguments(read, { file_path: path.join(root, '..', 'elsewhere', 'a.ts') }, root), { file_path: path.join(root, '..', 'elsewhere', 'a.ts') });
  assert.deepEqual(manifestArguments(read, { file_path: 'src/a.ts' }, root), { file_path: 'src/a.ts' });
  assert.deepEqual(manifestArguments(glob, { pattern: '*.ts' }, root), { pattern: '*.ts', path: '**' });
});

// ---- effects the gate cannot read ----

test('a call whose effects cannot be filled asks with manifest.effects-unknown when a person is here and is refused when nobody is, with no stand-in', async () => {
  const root = await project();
  const outside = path.join(tmpdir(), 'near-ai-gate-outside', 'x.txt');
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const input = {
    tool: read, raw: { file_path: outside }, root, callId: 'r1', policy: { mode: 'approve-risky', emergencyStop: false } as ActionPolicy,
    rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  };
  assert.deepEqual(effectsOfCall(read, { file_path: outside }, root), []);
  const asked = await gateToolCall(testGateRuntime(), input);
  assert.equal(asked.decision.outcome, 'ask');
  assert.equal(asked.decision.rule, 'manifest.effects-unknown');
  assert.equal(asked.decision.offerAlwaysAllow, false);
  assert.equal(asked.decision.allowGrant, false);
  const nobody = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), input);
  assert.equal(nobody.decision.outcome, 'deny');
  assert.equal(nobody.decision.rule, 'manifest.effects-unknown');
});

test('a tool whose manifest lists no effect is effects-unknown at the gate, as its words say: asked with a person here, refused with nobody, never the widest shorthand', async () => {
  const root = await project();
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  // The parsers refuse an empty effect list, so a hand-made manifest stands in for a damaged stored one.
  const manifest = { manifestVersion: 1, tool: 'Undeclared', effects: [], hosts: [], credentials: [], contexts: ['interactive', 'unattended'], untrusted: false, runsOn: 'this-machine' } as unknown as ToolManifest;
  const undeclared: AgentTool<any> = { ...read, name: 'Undeclared', manifest };
  const input = { tool: undeclared, raw: { file_path: 'a.ts' }, root, callId: 'u1', policy: { mode: 'fully-autonomous', emergencyStop: false } as ActionPolicy, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined };
  assert.deepEqual(effectsOfCall(undeclared, input.raw, root), [], 'no stand-in is invented for it');
  const asked = await gateToolCall(testGateRuntime(), input);
  assert.equal(asked.decision.outcome, 'ask');
  assert.equal(asked.decision.rule, 'manifest.effects-unknown');
  const nobody = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), input);
  assert.equal(nobody.decision.outcome, 'deny');
  assert.equal(nobody.decision.rule, 'manifest.effects-unknown');
  assert.ok(describeManifest(manifest).includes(EFFECTS_NOT_DECLARED_TEXT), 'the Tools page says the same thing');
});

test('no built-in tool declares an empty effect list, and a call missing the fields its manifest reads is unknown, never a stand-in', () => {
  const root = path.join(tmpdir(), 'near-ai-gate-catalog');
  const tools = builtInTools();
  assert.ok(tools.length >= 40);
  for (const tool of tools) {
    assert.ok(tool.manifest.effects.some((entry) => !('from' in entry)), `${tool.name} declares at least one effect of its own`);
    const readsInput = JSON.stringify(tool.manifest.effects).includes('"from":"input"');
    const filled = effectsOfCall(tool, {}, root);
    if (readsInput && tool.manifestInput === undefined) assert.deepEqual(filled, [], `${tool.name}: a call with none of its fields has unknown effects`);
    else if (!readsInput) assert.ok(filled.length > 0, `${tool.name} names no input, so its effects are always known`);
  }
});

test('every rule id a settings answer is given is a rule id the gate can record', async () => {
  const root = await project();
  const grants = new RunGrants();
  const base = { rules: DEFAULT_RULES, grants, buildAuto: async () => undefined, root };
  const shell = CORE_TOOLS.find((tool) => tool.name === 'Bash') as AgentTool<any>;
  const write = CORE_TOOLS.find((tool) => tool.name === 'Write') as AgentTool<any>;
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const runtime = testGateRuntime();
  const rules: string[] = [];
  for (const mode of ['approve-risky', 'mostly-autonomous', 'fully-autonomous'] as const) {
    const policy: ActionPolicy = { mode, emergencyStop: false };
    for (const [tool, raw, command] of [[read, { file_path: 'a.ts' }, undefined], [write, { file_path: 'x.md', content: 'x' }, undefined], [shell, { command: 'git status' }, 'git status'], [shell, { command: 'rm -rf /' }, 'rm -rf /'], [shell, { command: 'make build' }, 'make build']] as const) {
      const gated = await gateToolCall(runtime, { ...base, tool, raw, callId: `${mode}-${rules.length}`, policy, ...(command === undefined ? {} : { command }) });
      rules.push(gated.decision.rule);
    }
  }
  for (const rule of rules) assert.ok(GATE_RULE_IDS.includes(rule), rule);
  assert.ok(rules.includes('settings.deny-list') && rules.includes('settings.allow-rule') && rules.includes('settings.mode.fully-autonomous') && rules.includes('settings.mode.edits'));
});

// ---- Task 2: cards are a transport ----

test('a card answered allow gives asked then approved for the same call id; answered deny gives asked then denied and the call does not run', async () => {
  const started = await startedHost();
  const root = await project();
  const runtime = (): Promise<GateRuntime> => started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive' });
  const allowed = runWith(root, [{ calls: [call('a1', 'Write', { file_path: 'yes.md', content: 'y' })] }, { text: 'ok' }], { gate: await runtime(), answer: () => ({ decision: 'allow' }) });
  const denied = runWith(root, [{ calls: [call('d1', 'Write', { file_path: 'no.md', content: 'n' })] }, { text: 'ok' }], { gate: await runtime(), answer: () => ({ decision: 'deny' }) });
  try {
    await go(allowed);
    await go(denied);
  } finally {
    allowed.shell.dispose();
    denied.shell.dispose();
  }
  assert.equal(existsSync(path.join(root, 'yes.md')), true);
  assert.equal(existsSync(path.join(root, 'no.md')), false);
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record)]), [['a1', 'asked'], ['a1', 'approved'], ['d1', 'asked'], ['d1', 'denied']]);
  assert.deepEqual(records.map((record) => record.metadata.sequence), [1, 2, 3, 4], 'sequence follows decision order');
});

test('if the emergency stop is switched on between the card and the answer, an allow is re-checked, recorded denied, and the call does not run', async () => {
  const started = await startedHost();
  const root = await project();
  let setup: RunSetup | undefined;
  setup = runWith(root, [{ calls: [call('w1', 'Write', { file_path: 'late.md', content: 'x' })] }, { text: 'ok' }], {
    gate: await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive' }),
    answer: () => { (setup as RunSetup).policy.emergencyStop = true; return { decision: 'allow' }; }
  });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  assert.equal(existsSync(path.join(root, 'late.md')), false);
  assert.match(toolOutputs(setup)[0] ?? '', /^Not allowed: Emergency stop is on\./);
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [outcomeOf(record), ruleOf(record)]), [['asked', 'settings.mode.edits'], ['denied', 'settings.emergency-stop']]);
});

test('if the bundle fails between the card and the answer, an allow is re-checked and refused with the bundle\'s sentence', async () => {
  const root = await project();
  const fresh = await startedHost();
  const live = await fresh.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive' });
  const valid = live.bundleState();
  let state: BundleState = valid;
  const gate: GateRuntime = { ...live, bundleState: () => state };
  const setup = runWith(root, [{ calls: [call('w1', 'Write', { file_path: 'late.md', content: 'x' })] }, { text: 'ok' }], {
    gate, answer: () => { state = failedClosed('bad-signature'); return { decision: 'allow' }; }
  });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  assert.equal(existsSync(path.join(root, 'late.md')), false);
  assert.match(toolOutputs(setup)[0] ?? '', /^Not allowed: Your policy file was changed outside NEAR AI/);
  const records = await logOf(fresh, root);
  assert.deepEqual(records.map((record) => [outcomeOf(record), ruleOf(record)]), [['asked', 'settings.mode.edits'], ['denied', 'bundle.failed-closed']]);
});

test('a card answer never decides or grants on its own: it goes through recordApprovalReply, and a pending answer is recorded when it arrives late', async () => {
  const root = await project();
  const runtime = testGateRuntime();
  const write = CORE_TOOLS.find((tool) => tool.name === 'Write') as AgentTool<any>;
  const gated = await gateToolCall(runtime, { tool: write, raw: { file_path: 'p.md', content: 'x' }, root, callId: 'p1', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined });
  assert.equal(gated.decision.outcome, 'ask');
  const pending = await recordApprovalReply(runtime, gated, { decision: 'pending' });
  assert.equal(pending.proceed, false);
  assert.deepEqual(runtime.records.map((record) => outcomeOf(record)), ['asked'], 'a pending answer records nothing yet');
  recordLateApproval(runtime, 'p1', { decision: 'allow' });
  assert.deepEqual(runtime.records.map((record) => outcomeOf(record)), ['asked', 'approved']);
  recordLateApproval(runtime, 'p1', { decision: 'allow' });
  assert.equal(runtime.records.length, 2, 'a late answer is recorded once');
  const allowed = await gateToolCall(runtime, { tool: write, raw: { file_path: 'q.md', content: 'x' }, root, callId: 'q1', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined });
  assert.deepEqual(await recordApprovalReply(runtime, allowed, { decision: 'allow-run' }), { proceed: true });
});

test('a call with unparseable arguments reaches no decision and no execution, and a run with no tool calls writes no tool decision record', async () => {
  const root = await project();
  const runtime = testGateRuntime();
  const setup = runWith(root, [{ calls: [{ id: 'bad', type: 'function', function: { name: 'Write', arguments: '{not json' } }] }, { text: 'sorry' }], { gate: runtime });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  assert.match(toolOutputs(setup)[0] ?? '', /^Arguments are not valid JSON/);
  assert.equal(runtime.records.length, 0);
  const none = testGateRuntime();
  const quiet = runWith(root, [{ text: 'Nothing to do.' }], { gate: none });
  try {
    const result = await go(quiet);
    assert.equal(result.outcome, 'completed');
  } finally {
    quiet.shell.dispose();
  }
  assert.equal(none.records.length, 0);
});

test('in a batch of concurrent lookups each call gets its own decision before its own run', async () => {
  const root = await project();
  const order: string[] = [];
  const base = testGateRuntime();
  const gate: GateRuntime = { ...base, sink: { record: (record) => { order.push(`decision:${record.resources[0]?.name}`); base.sink.record(record); } } };
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const spy: AgentTool<any> = { ...read, run: async (input, context) => { order.push(`run:${String((input as { path: string }).path)}`); return read.run(input, context); } };
  const setup = runWith(root, [{ calls: ['a.ts', 'b.ts', 'c.ts'].map((file, index) => call(`r${index}`, 'Read', { file_path: file })) }, { text: 'ok' }], { gate, tools: [spy, ...CORE_TOOLS.filter((tool) => tool.name !== 'Read')] });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  for (const file of ['a.ts', 'b.ts', 'c.ts']) {
    const decided = order.indexOf(`decision:${file}`);
    const ran = order.indexOf(`run:${file}`);
    assert.ok(decided >= 0 && ran >= 0 && decided < ran, `${file}: decision ${decided} before run ${ran} in ${order.join(', ')}`);
  }
  assert.equal(base.records.length, 3, 'three decisions, one per call');
  assert.deepEqual(base.records.map((record) => callIdOf(record)).sort(), ['r0', 'r1', 'r2']);
});

// ---- sub-agents ----

class RecordingHost extends GateHost {
  public readonly requests: RuntimeRequest[] = [];
  public override runtimeFor(request: RuntimeRequest): Promise<GateRuntime> {
    this.requests.push(request);
    return super.runtimeFor(request);
  }
}

test('a sub-agent spawn is decided like any call, and the child\'s own calls are decided too, as a sub-agent with the person present in an interactive run', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-storage-'));
  const host = new RecordingHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test' });
  await host.start();
  const root = await project();
  let leadTurn = 0;
  let helperTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const helper = String(messages[0]?.content ?? '').startsWith('You help');
      if (helper) {
        helperTurn += 1;
        if (helperTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('h1', 'Read', { file_path: 'a.ts' }), call('h2', 'Write', { file_path: 'helper.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'Helper report.' }, finishReason: 'stop', usage };
        return;
      }
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'read a.ts and write notes', description: 'notes' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.gateHost = host;
  try {
    await conversation.send({
      text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
      projectAgents: [{ name: 'helper', description: 'helper', tools: ['Read', 'Write'], body: 'You help.', file: path.join(root, 'team.md') }]
    });
  } finally {
    conversation.dispose();
  }
  assert.equal(existsSync(path.join(root, 'helper.md')), true);
  assert.deepEqual(host.requests.map((request) => [request.actor.kind, request.presence, request.context, OLD_FLOOR_OPTION in request]), [
    ['agent', 'person', 'interactive', false], ['sub-agent', 'person', 'interactive', false]
  ]);
  const records = await logOf({ host, storage, secrets: new MemorySecrets(), problems: [] }, root);
  const byCall = (id: string): DecisionRecord | undefined => records.find((record) => callIdOf(record) === id);
  assert.equal(byCall('a1')?.api.operation, 'spawn', 'the lead\'s Agent call is a spawn decision');
  assert.equal(byCall('h1')?.api.operation, 'read');
  assert.equal(byCall('h2')?.api.operation, 'workspaceWrite');
  assert.equal(byCall('h1')?.ai_agent?.name, 'helper');
  assert.equal(byCall('a1')?.ai_agent?.name, 'agent');
  const sequences = records.map((record) => record.metadata.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), 'one log, in decision order, across the lead and its helper');
});

test('a card for a floor decision carries no run-wide grant and no "always allow", and with nobody present the same call is refused with no card (floor enforced)', async () => {
  const root = await project();
  const enforced = (presence: 'person' | 'none'): GateRuntime => testGateRuntime({ presence });
  const hook = call('f1', 'Write', { file_path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' });
  const asked = runWith(root, [{ calls: [hook] }, { text: 'ok' }], { gate: enforced('person'), mode: 'fully-autonomous', answer: () => ({ decision: 'allow-always' }) });
  const refused = runWith(root, [{ calls: [hook] }, { text: 'ok' }], { gate: enforced('none'), mode: 'fully-autonomous' });
  try {
    await go(asked);
    await go(refused);
  } finally {
    asked.shell.dispose();
    refused.shell.dispose();
  }
  assert.equal(asked.approvals.length, 1);
  const card = asked.approvals[0] as ApprovalRequest;
  assert.equal(card.grant, undefined, 'no run-wide grant on a floor card');
  assert.equal(card.allowRule, undefined);
  assert.match(card.reason ?? '', /always needs a person|protected|approve/i);
  assert.equal(refused.approvals.length, 0, 'nobody to answer: no card');
  assert.match(toolOutputs(refused)[0] ?? '', /^Not allowed: Nobody is here to approve this/);
});

// ---- Task 1 (plan 13): the cyber panel's step engine ----

const CYBER_SCOPE = { hosts: ['example.test'], ports: [443], paths: [], exclusions: [] };
const CYBER_ACCEPTANCE: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10', textVersion: 'v1', region: 'us', acceptedAt: '2026-10-31T12:00:00Z'
};

function cyberStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 's1', role: 'operator', action: 'probe', target: 'https://example.test/', tool: 'CyberHttpProbe', args: ['https://example.test/'], sandbox: 'none',
    expectedResult: 'a 200 response', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] }, ...overrides
  };
}

function cyberEngagement(modes: Engagement['allowedModes'] = ['passive']): Engagement {
  return {
    id: 'eng-00000000-0000-4000-8000-000000000001', workspace: '/workspace/example', target: { kind: 'url', value: 'https://example.test/' }, resolvedScope: CYBER_SCOPE,
    region: 'us', authorizationStatement: 'The acceptor owns the target.', allowedModes: modes, exclusions: [], sandbox: { tier: 'tempFolder' },
    acceptedDisclaimer: CYBER_ACCEPTANCE, createdAt: CYBER_ACCEPTANCE.acceptedAt, frozen: false
  };
}

/** A model that plans one step, echoes it as the operator, then says it is done. */
function onePlannedStep(planned: Step) {
  const queues: Partial<Record<StepRole, string[]>> = { planner: [JSON.stringify(planned)], operator: [JSON.stringify(planned)] };
  return {
    async askRole(role: StepRole): Promise<AskRoleResult> {
      const reply = queues[role]?.shift() ?? JSON.stringify({ ...planned, id: `done-${role}`, role, action: 'report', tool: 'done', args: [] });
      return { kind: 'steps', role, steps: [JSON.parse(reply) as Step], repairs: 0 };
    }
  };
}

interface CyberOutcome { order: string[]; runtime: ReturnType<typeof testGateRuntime>; approvals: number; result: Awaited<ReturnType<typeof startCyberRun>> }

async function cyberScript(planned: Step, options: { capability?: 'read' | 'shell'; grant?: boolean; mode?: 'approve-risky' | 'auto' | 'fully-autonomous'; approve?: boolean; modes?: Engagement['allowedModes']; presence?: 'person' | 'none'; noGate?: boolean } = {}): Promise<CyberOutcome> {
  const order: string[] = [];
  const capability = options.capability ?? 'read';
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-gate-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-gate-root-'));
  const base = testGateRuntime({ presence: options.presence ?? 'person' });
  const runtime: ReturnType<typeof testGateRuntime> = { ...base, sink: { record: (record: DecisionRecord) => { order.push(`decision:${record.api.request.uid.split('/')[1] ?? record.api.request.uid}:${outcomeOf(record)}`); base.records.push(record); } } };
  const tool: AgentTool<any> = {
    name: planned.tool, description: planned.tool, parameters: { type: 'object', properties: {} }, capability, manifest: testManifest(planned.tool, capability),
    parse: (raw) => raw, title: () => planned.tool, async run() { order.push(`run:${planned.tool}`); return 'ok'; }
  };
  const grants = new RunGrants();
  const engagement = cyberEngagement(options.modes);
  if (options.grant) grants.grantIntrusive(engagement.id, () => true);
  const shell = new ShellSession(root);
  let approvals = 0;
  try {
    const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-gate'), shell, readFiles: new Set() };
    const tools: RunTool[] = [{ tool, capability, target: (step) => step.target }];
    const result = await startCyberRun({
      engagement, currentAcceptance: { region: 'us', scope: scopeFingerprint(CYBER_SCOPE), extensionVersion: '0.4.10', textVersion: 'v1' },
      driver: onePlannedStep(planned) as never, tools, ledger: new CyberLedgerStore(directory), evidence: new CyberEvidenceStore(directory), grants,
      policy: { mode: options.mode ?? 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, ...(options.noGate ? {} : { gate: runtime }),
      requestApproval: async () => { approvals += 1; order.push('card'); return { decision: options.approve === false ? 'deny' : 'allow' }; },
      signal: new AbortController().signal, toolContext: context, now: () => new Date('2026-11-02T12:00:00Z')
    });
    return { order, runtime, approvals, result };
  } finally {
    shell.dispose();
  }
}

test('a cyber panel step is decided by the gate and recorded before its tool runs, with the outcome the permission path gave', async () => {
  const inScope = await cyberScript(cyberStep());
  assert.deepEqual(inScope.order.filter((entry) => entry.startsWith('decision:') || entry.startsWith('run:')), ['decision:s1:allowed', 'run:CyberHttpProbe'], 'one record, ahead of the probe');
  assert.equal(inScope.runtime.records[0]?.api.operation, 'read');
  assert.equal(ruleOf(inScope.runtime.records[0] as DecisionRecord), 'settings.read-plan');
  const outOfScope = await cyberScript(cyberStep({ target: 'https://evil.test/', args: ['https://evil.test/'] }));
  assert.deepEqual(outOfScope.order, ['decision:s1:denied'], 'one record for the refusal and the tool never ran');
  assert.equal(outOfScope.runtime.records.length, 1);
  assert.equal(outOfScope.runtime.records[0]?.resources[0]?.name, 'evil.test');
});

test('a cyber shell step: the engagement grant allows it with one record, no grant asks first and records the answer, and a declined card never runs it', async () => {
  const exploit = cyberStep({ tool: 'CyberExploitTool', action: 'exploit', sandbox: 'tempFolder' });
  const granted = await cyberScript(exploit, { capability: 'shell', grant: true, modes: ['passive', 'intrusive'] });
  assert.deepEqual(granted.order.filter((entry) => entry !== 'card'), ['decision:s1:allowed', 'run:CyberExploitTool']);
  assert.equal(granted.approvals, 0);
  assert.equal(ruleOf(granted.runtime.records[0] as DecisionRecord), 'settings.engagement-grant');
  const asked = await cyberScript(exploit, { capability: 'shell' });
  assert.deepEqual(asked.order, ['decision:s1:asked', 'card', 'decision:s1:approved', 'run:CyberExploitTool']);
  const declined = await cyberScript(exploit, { capability: 'shell', approve: false });
  assert.deepEqual(declined.order, ['decision:s1:asked', 'card', 'decision:s1:denied']);
  const nobody = await cyberScript(exploit, { capability: 'shell', grant: true, modes: ['passive', 'intrusive'], presence: 'none' });
  assert.equal(nobody.order.includes('run:CyberExploitTool'), true, 'a granted step keeps today\'s decision even when the run is one nobody watches');
});

// ---- Task 2 (plan 13): benchmark, comparison and role suite runs ----

const benchmarkClient = (turns: Turn[]): BenchmarkClient => {
  let seen = 0;
  return {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const turn = turns[seen] ?? { text: 'done' };
      seen += 1;
      if (turn.text) yield { type: 'text', text: turn.text };
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage };
    }
  };
};

test('a run nobody watches is decided with presence none and context unattended, unless the caller can ask a person; a given gate is used as it is', () => {
  const nobody = runGateFor({}) as ReturnType<typeof testGateRuntime>;
  assert.equal(nobody.presence, 'none');
  assert.equal(nobody.context, 'unattended');
  assert.equal(OLD_FLOOR_OPTION in nobody, false, 'no runtime carries a floor mode: the floor is always enforced');
  const asked = runGateFor({ requestApproval: async () => ({ decision: 'allow' }) });
  assert.equal(asked.presence, 'person');
  assert.equal(asked.context, 'interactive');
  const own = testGateRuntime({ presence: 'none', context: 'routine' });
  assert.equal(runGateFor({ gate: own }), own);
});

test('runAgentInFolder with an explicit test runtime for a run nobody watches changes no decision: a Write runs under fully autonomous, and an action that would ask is declined', async () => {
  const root = await project();
  const gate = testGateRuntime({ presence: 'none', context: 'unattended' });
  const result = await runAgentInFolder(
    benchmarkClient([{ calls: [call('w1', 'Write', { file_path: 'made.md', content: 'x' }), call('b1', 'Bash', { command: 'git push origin main' })] }, { text: 'done' }]),
    'm', root, 'go', { maxTurns: 4, rules: DEFAULT_RULES, policy: { mode: 'approve-risky', emergencyStop: false }, gate }
  );
  assert.equal(result.outcome, 'completed');
  assert.equal(existsSync(path.join(root, 'made.md')), false, 'with nobody to ask, an edit that needs approval is declined, as before the gate');
  const granted = await runAgentInFolder(benchmarkClient([{ calls: [call('w2', 'Write', { file_path: 'made.md', content: 'x' })] }, { text: 'done' }]), 'm', root, 'go', { maxTurns: 4, rules: DEFAULT_RULES, gate });
  assert.equal(granted.outcome, 'completed');
  assert.equal(existsSync(path.join(root, 'made.md')), true);
});

test('with a host runtime passed in, a benchmark run\'s decisions land in the host\'s log, before the call runs', async () => {
  const started = await startedHost();
  const root = await project();
  const logged = await mkdtemp(path.join(tmpdir(), 'near-ai-bench-root-'));
  const gate = await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'bench-1', agentLabel: 'benchmark' }, presence: 'none', context: 'unattended' });
  await runAgentInFolder(benchmarkClient([{ calls: [call('r1', 'Read', { file_path: 'a.ts' }), call('w1', 'Write', { file_path: 'made.md', content: 'x' })] }, { text: 'done' }]), 'm', logged, 'go', { maxTurns: 4, rules: DEFAULT_RULES, gate });
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record), ruleOf(record)]), [['r1', 'allowed', 'settings.read-plan'], ['w1', 'allowed', 'settings.mode.edits']]);
  assert.equal(records[0]?.ai_agent?.name, 'benchmark');
});

test('a comparison passes each task run its own gate, and the decisions reach the project\'s log; the role suite does the same', async () => {
  const started = await startedHost();
  const root = await project();
  const tasks = (await loadBenchmarkTasks()).filter((task) => task.id === 'implement');
  const made: string[] = [];
  const rows: ResultRow[] = [];
  await runComparison({
    runId: 'run-gate', plan: planComparison(['m1'], tasks, 1, 'rerun', new Map()), tasks, runsPerTask: 1, clientFor: () => benchmarkClient([{ calls: [call('c1', 'Read', { file_path: 'slug.js' })] }, { text: 'Done.' }]),
    rules: DEFAULT_RULES, emergencyStopped: () => false, signal: new AbortController().signal, onRow: (row) => { rows.push(row); },
    gateFor: async (run) => { made.push(`${run.model}/${run.task}`); return await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'compare-1' }, presence: 'none', context: 'unattended' }); }
  });
  assert.deepEqual(made, ['m1/implement']);
  assert.equal(rows.length, 1);
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record)]), [['c1', 'allowed']]);
});

test('the role suite gives each role run its own gate, so the studio\'s decisions reach the project\'s log with nobody present', async () => {
  const started = await startedHost();
  const root = await project();
  const asked: string[] = [];
  const plan = planRoleSuite([{ name: 'reviewer', role: 'reviewer' }], ['m1']);
  const outcomes = await runRoleSuite(plan, {
    clientFor: () => benchmarkClient([{ calls: [call('t1', 'Glob', { pattern: '*' })] }, { text: 'Done.' }]),
    rules: DEFAULT_RULES, signal: new AbortController().signal,
    gateFor: async (run) => { asked.push(`${run.member}/${run.model}`); return await started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'roles-1' }, presence: 'none', context: 'unattended' }); }
  });
  assert.equal(outcomes.length, 1);
  assert.deepEqual(asked, ['reviewer/m1']);
  const records = await logOf(started, root);
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record), record.api.operation]), [['t1', 'allowed', 'read']]);
});

// ---- Review of PR 2: a run with no gate host is failed closed, never decided against a policy nobody read ----

const NO_HOST = BUNDLE_FAILURES.unavailable;
const writeAndRead = (): Turn[] => [{ calls: [call('w1', 'Write', { file_path: 'out.md', content: 'nope' }), call('r1', 'Read', { file_path: 'a.ts' })] }, { text: 'ok' }];

test('bundle.unavailable is a rule id the gate can record, and a plain sentence with no em-dash names what is still allowed', () => {
  assert.ok(GATE_RULE_IDS.includes('bundle.unavailable'));
  assert.match(NO_HOST, /only reading and planning/);
  assert.ok(!NO_HOST.includes('\u2014'));
});

test('a run built with no gate host: a Write is refused even under fully autonomous, a Read still runs, and no card is shown', async () => {
  const root = await project();
  const setup = runWith(root, writeAndRead(), { mode: 'fully-autonomous' });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  const [write, read] = toolOutputs(setup);
  assert.equal(write, `Not allowed: ${NO_HOST}`);
  assert.match(read ?? '', /export const value = 1/);
  assert.equal(existsSync(path.join(root, 'out.md')), false);
  assert.equal(setup.approvals.length, 0);
});

test('runGateFor with no gate (comparison, role suite and any folderless fallback) is failed closed with the rule bundle.unavailable: Write and Bash refused, Read and a plan allowed', async () => {
  const root = await project();
  const gate = runGateFor({});
  assert.equal(gate.bundleState().state, 'failed-closed');
  assert.equal(runGateFor({ requestApproval: async () => ({ decision: 'allow' }) }).bundleState().state, 'failed-closed', 'a person who can answer does not make an unread policy valid');
  const decide = async (name: string, raw: Record<string, unknown>) => (await gateToolCall(gate, {
    tool: CORE_TOOLS.find((tool) => tool.name === name) as AgentTool<any>, raw, root, callId: name, policy: { mode: 'fully-autonomous', emergencyStop: false },
    rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  })).decision;
  for (const [name, raw] of [['Write', { file_path: 'out.md', content: 'x' }], ['Bash', { command: 'git status' }]] as const) {
    const refused = await decide(name, raw);
    assert.equal(refused.outcome, 'deny', name);
    assert.equal(refused.rule, 'bundle.unavailable', name);
    assert.equal(refused.reason, NO_HOST, name);
  }
  assert.equal((await decide('Read', { file_path: 'a.ts' })).outcome, 'allow');
});

test('a benchmark run, a comparison task and a role run with no gate are refused a Write; a gateFor that answers nothing (no host) falls back to the same refusal', async () => {
  const root = await project();
  const written = await runAgentInFolder(benchmarkClient(writeAndRead()), 'm', root, 'go', { maxTurns: 4, rules: DEFAULT_RULES });
  assert.equal(written.outcome, 'completed');
  assert.equal(existsSync(path.join(root, 'out.md')), false, 'no gate: nothing is written');
  const tasks = (await loadBenchmarkTasks()).filter((task) => task.id === 'implement');
  const seen: string[] = [];
  const toolResults: string[] = [];
  const watching = (turns: Turn[]): BenchmarkClient => ({
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      for (const message of messages) if (message.role === 'tool' && typeof message.content === 'string') toolResults.push(message.content);
      const turn = turns[Math.min(seen.length, turns.length - 1)] ?? { text: 'done' };
      seen.push('turn');
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage };
    }
  });
  await runComparison({
    runId: 'run-nohost', plan: planComparison(['m1'], tasks, 1, 'rerun', new Map()), tasks, runsPerTask: 1,
    clientFor: () => watching([{ calls: [call('c1', 'Write', { file_path: 'slug.js', content: 'x' })] }, { text: 'Done.' }]),
    rules: DEFAULT_RULES, emergencyStopped: () => false, signal: new AbortController().signal, onRow: () => undefined, gateFor: () => undefined
  });
  assert.ok(toolResults.some((text) => text === `Not allowed: ${NO_HOST}`), `the comparison task's Write was refused: ${toolResults.join(' | ')}`);
  seen.length = 0;
  toolResults.length = 0;
  const outcomes = await runRoleSuite(planRoleSuite([{ name: 'reviewer', role: 'reviewer' }], ['m1']), {
    clientFor: () => watching([{ calls: [call('t1', 'Write', { file_path: 'x.md', content: 'x' })] }, { text: 'Done.' }]),
    rules: DEFAULT_RULES, signal: new AbortController().signal
  });
  assert.equal(outcomes.length, 1);
  assert.ok(toolResults.some((text) => text === `Not allowed: ${NO_HOST}`), `the role run's Write was refused: ${toolResults.join(' | ')}`);
});

test('a chat conversation with no gate host refuses a Write', async () => {
  const root = await project();
  const results: string[] = [];
  let turn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      for (const message of messages) if (message.role === 'tool' && typeof message.content === 'string') results.push(message.content);
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('w1', 'Write', { file_path: 'chat.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  } finally {
    conversation.dispose();
  }
  assert.equal(existsSync(path.join(root, 'chat.md')), false);
  assert.ok(results.includes(`Not allowed: ${NO_HOST}`), results.join(' | '));
});

test('a cyber run with no gate refuses an exploit step even with the engagement grant, and never runs its tool; a read step still runs', async () => {
  const exploit = cyberStep({ tool: 'CyberExploitTool', action: 'exploit', sandbox: 'tempFolder' });
  const refused = await cyberScript(exploit, { capability: 'shell', grant: true, modes: ['passive', 'intrusive'], noGate: true });
  assert.equal(refused.order.includes('run:CyberExploitTool'), false, 'no gate: the exploit tool never ran');
  assert.equal(refused.approvals, 0);
  const read = await cyberScript(cyberStep(), { noGate: true });
  assert.deepEqual(read.order.filter((entry) => entry.startsWith('run:')), ['run:CyberHttpProbe'], 'reading still runs');
});

// ---- Task 3 (plan 13): a test finds every execution path ----
//
// There is no registry of the places a tool runs, so the test reads the production sources and compares what it finds with a list written here. A new place
// fails the test until someone adds it, which is the moment to check it passes the gate (GATE-04, Pitfall 1, T-70-38). Each scan has a planted check, so the
// scan itself is known to find what it should.

const REPO = path.resolve(__dirname, '..', '..');

function productionSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (full !== path.join(REPO, 'src', 'test')) walk(full); continue; }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(path.relative(REPO, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(REPO, 'src'));
  return found.sort();
}

/** The text with whole-line comments removed, so a word in a comment is never a call. */
function code(text: string): string {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
}

/** How many places a tool object's run is called: `tool.run(`, `selected!.tool.run(`, `webFetchTool.run(`. */
export function toolRunSites(text: string): number {
  return [...code(text).matchAll(/\b(?:tool|\w+Tool)[?!]?\.run\(/g)].length;
}

/** Every `new AgentRun(` and whether its arguments name a gate. */
export function agentRunConstructions(text: string): Array<{ line: number; passesGate: boolean }> {
  const source = code(text);
  const out: Array<{ line: number; passesGate: boolean }> = [];
  for (const match of source.matchAll(/new AgentRun\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      const char = source[end];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += 1;
    }
    out.push({ line: source.slice(0, match.index).split('\n').length, passesGate: /\bgate\b/.test(source.slice(start, end)) });
  }
  return out;
}

/** The files that import a way to start a process. */
export function processImporters(files: Record<string, string>): string[] {
  const form = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"](?:(?:node:)?child_process|execa)['"]/;
  return Object.entries(files).filter(([, text]) => form.test(code(text))).map(([file]) => file).sort();
}

/** The only places a tool's own run is called: the loop's executeCall, the cyber step engine, and the sub-agent wrapper that runs inside executeCall. */
const TOOL_RUN_SITES: Readonly<Record<string, number>> = { 'src/agent/loop.ts': 1, 'src/services/cyberRun.ts': 1, 'src/services/agentSession.ts': 2 };
/** Every production `new AgentRun(`: the main run and each sub-agent in the session, and the benchmark runner. */
const AGENT_RUN_SITES: Readonly<Record<string, number>> = { 'src/services/agentSession.ts': 2, 'src/benchmark/runner.ts': 1 };
/**
 * Every production file (all of src, apart from src/test) that may import a way to start a process, each with the reason it is not an agent tool execution.
 * The ones under src/agent are the loop's own tools, behind the gate. The rest are the extension's own helpers: the floor's own wording excludes them, and
 * none of them runs because a model asked. A new importer is added here with its reason or routed through the gate, never left unlisted.
 */
const PROCESS_IMPORTERS: Readonly<Record<string, string>> = {
  'src/agent/shell.ts': 'the shell session behind the Bash tool; the loop gates every command before it reaches it',
  'src/agent/tools.ts': 'the Bash tool\'s own command runner and the ripgrep inside the already-gated Grep tool',
  'src/agent/unattended.ts': 'the unattended-run safety checks (git blob reads of a script before it runs); part of the gate\'s own decision',
  'src/agent/worktree.ts': 'the worktree helper of the sandboxed run; started by the session, not by a model call',
  'src/benchmark/execution.ts': 'runs a benchmark task\'s hidden acceptance tests under node after the model has finished; started by the benchmark harness, not by a model call',
  'src/benchmark/roleTasks.ts': 'not an import: the text of a fixture file written into a benchmark task\'s sandbox',
  'src/gsd/researchProfile.ts': 'one fixed `git status` read of the working tree for a plan check; the extension\'s own helper',
  'src/gsd/runtime.ts': 'installs and checks the Open-GSD runtime in the extension\'s own storage (npx with a fixed argument list); not a model call',
  'src/security/runtimes.ts': 'fixed `--version` probes for the dependency check; the extension\'s own helper',
  'src/services/agentSession.ts': 'one fixed `git rev-parse HEAD` for the session\'s snapshot; the extension\'s own helper',
  'src/services/codePushCheck.ts': 'the person\'s own git push after their click; the extension\'s own helper',
  'src/services/cyberSandbox.ts': 'the cyber harness\'s container runtime wrapper; its steps are tool runs decided at the gated cyberRun.ts site',
  'src/services/cyberTools.ts': 'fixed `--version` detection of host security tools; the extension\'s own helper',
  'src/services/onlineHome.ts': 'the GitHub CLI calls of the person\'s own "online home" click; the extension\'s own helper',
  'src/services/stateGit.ts': 'the one place project sync starts git; the extension\'s own helper',
  'src/team/runGit.ts': 'the one place the team core starts git; the extension\'s own helper'
};

test('a tool\'s run is called only at the listed sites, and a planted extra site is reported', () => {
  const found: Record<string, number> = {};
  for (const file of productionSources()) {
    const count = toolRunSites(readFileSync(path.join(REPO, file), 'utf8'));
    if (count > 0) found[file] = count;
  }
  assert.deepEqual(found, TOOL_RUN_SITES);
  assert.equal(toolRunSites('const out = await tool.run(input, context);\nreturn selected!.tool.run(parsed, ctx) + webFetchTool.run(a);'), 3, 'the scan finds a planted site');
  assert.equal(toolRunSites('// tool.run(input)\n * tool.run(input)\nconst shellRun = shell.run(command);'), 0, 'a comment and a shell session are not tool runs');
});

// The same question asked of the type checker (PR #70 third review): the text scan above only finds `tool.run(` and `xTool.run(`, so an alias, an array
// element, a destructured name or a bracket access would be missed. This one finds every read of an AgentTool's `run` by the type of what it is read from.
// One Program over all of src is built once and kept for the whole file; the planted program (a few small files that import the real AgentTool) is another.

let productionProgram: { files: string[]; sites: RunSite[] } | undefined;

function productionRunSites(): { files: string[]; sites: RunSite[] } {
  if (productionProgram === undefined) {
    const tests = path.join(REPO, 'src', 'test') + path.sep;
    const files = configuredFiles(REPO).filter((file) => !file.startsWith(tests));
    productionProgram = { files, sites: findToolRunSites(programFor(REPO, files), REPO, files) };
  }
  return productionProgram;
}

/** Planted sources, one file each, with the number of sites of each kind the checker must find in it. `AgentTool` is the real one. */
const PLANTED: ReadonlyArray<{ name: string; source: string; expected: Partial<Record<RunSite['kind'], number>> }> = [
  { name: 'a direct call', source: 'export async function f(tool: AgentTool<any>) { return tool.run({}, ctx); }', expected: { read: 1 } },
  { name: 'an alias', source: 'export async function f(tool: AgentTool<any>) { const t = tool; const u = t; return u.run({}, ctx); }', expected: { read: 1 } },
  { name: 'an array element and a loop variable', source: 'export async function f(tools: AgentTool<any>[]) { await tools[0].run({}, ctx); for (const each of tools) await each.run({}, ctx); }', expected: { read: 2 } },
  { name: 'a value found in a map', source: 'export async function f(byName: Map<string, AgentTool<any>>) { return byName.get("x")!.run({}, ctx) + (await [...byName.values()].map((entry) => entry.run({}, ctx))); }', expected: { read: 2 } },
  { name: 'a destructured name', source: 'export async function f(tool: AgentTool<any>) { const { run } = tool; return run({}, ctx); }', expected: { destructure: 1 } },
  { name: 'a destructured parameter', source: 'export const f = async ({ run }: AgentTool<any>) => run({}, ctx);', expected: { destructure: 1 } },
  { name: 'a bracket access with the name written out', source: 'export async function f(tool: AgentTool<any>) { return tool["run"]({}, ctx); }', expected: { read: 1 } },
  { name: 'a bracket access through a constant', source: 'const key = "run" as const; export async function f(tool: AgentTool<any>) { return tool[key]({}, ctx); }', expected: { read: 1 } },
  { name: 'a bracket access whose key is any text', source: 'export function f(tool: AgentTool<any>, member: string) { return (tool as any as { [key: string]: unknown })[member] ?? tool[member as never]; }', expected: { 'dynamic-key': 1 } },
  { name: 'a bracket access whose key could be run', source: 'export function f(tool: AgentTool<any>, member: keyof AgentTool<any>) { return tool[member]; }', expected: { read: 1 } },
  { name: 'a function taken off the tool', source: 'export function f(tool: AgentTool<any>) { return [tool.run.bind(tool), tool.run.call(tool, {}, ctx), tool.run]; }', expected: { read: 3 } },
  { name: 'an optional call', source: 'export async function f(tool?: AgentTool<any>) { return tool?.run({}, ctx); }', expected: { read: 1 } },
  { name: 'a type that extends AgentTool and a generic', source: 'interface Named extends AgentTool<any> { extra: string }\nexport async function f<T extends AgentTool<any>>(a: Named, b: T) { return [await a.run({}, ctx), await b.run({}, ctx)]; }', expected: { read: 2 } },
  { name: 'a value typed any', source: 'export async function f(value: any) { return value.run({}, ctx); }', expected: { untyped: 1 } },
  { name: 'a value cast to any', source: 'export async function f(tool: AgentTool<any>) { return (tool as any).run({}, ctx); }', expected: { read: 0, untyped: 1 } },
  { name: 'things that are not a tool run', source: 'declare const shell: { run(command: string): Promise<string> };\nexport async function f(tool: AgentTool<any>) { const own = { run() { return 1; } }; const wrapped: AgentTool<any> = { ...tool, run: async () => "x" }; return [await shell.run("ls"), own.run(), wrapped.name]; }', expected: {} }
];

let plantedProgram: { dir: string; sites: RunSite[] } | undefined;

async function plantedRunSites(): Promise<{ dir: string; sites: RunSite[] }> {
  if (plantedProgram === undefined) {
    const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-planted-'));
    const files: string[] = [];
    for (const [index, planted] of PLANTED.entries()) {
      const file = path.join(dir, `planted${index}.ts`);
      const header = `import type { AgentTool } from ${JSON.stringify(path.join(REPO, 'src', 'agent', 'tools'))};\ndeclare const ctx: any;\n`;
      await writeFile(file, `${header}${planted.source}\n`);
      files.push(file);
    }
    plantedProgram = { dir, sites: findToolRunSites(programFor(REPO, files), dir, files) };
  }
  return plantedProgram;
}

test('every production read of an AgentTool\'s run is at a listed site, found with the type checker, and none is untyped or reached by an unknown key', () => {
  const { files, sites } = productionRunSites();
  assert.ok(files.length > 200 && files.every((file) => !file.includes(`${path.sep}test${path.sep}`)), 'the scan covers all of src and leaves src/test out');
  assert.deepEqual(sites.filter((site) => site.kind !== 'read').map((site) => `${site.file}:${site.line} ${site.kind} ${site.text}`), [], 'no destructured, untyped or dynamic reach of a tool\'s run');
  assert.deepEqual(countByFile(sites), TOOL_RUN_SITES, sites.map((site) => `${site.file}:${site.line}`).join(' '));
});

test('the type-checked scan finds an alias, an array element, a destructured name, a bracket access and the rest, and not a run that is only defined or is a shell\'s', async () => {
  const { dir, sites } = await plantedRunSites();
  try {
    for (const [index, planted] of PLANTED.entries()) {
      const mine = sites.filter((site) => site.file === `planted${index}.ts`);
      const counted: Partial<Record<RunSite['kind'], number>> = {};
      for (const site of mine) counted[site.kind] = (counted[site.kind] ?? 0) + 1;
      const wanted = Object.fromEntries(Object.entries(planted.expected).filter(([, count]) => count > 0));
      assert.deepEqual(counted, wanted, `${planted.name}: ${mine.map((site) => `${site.kind} ${site.text}`).join(' | ')}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    plantedProgram = undefined;
  }
});

test('every production `new AgentRun(` passes a gate, and a planted construction without one is reported', () => {
  const found: Record<string, number> = {};
  const missing: string[] = [];
  for (const file of productionSources()) {
    const sites = agentRunConstructions(readFileSync(path.join(REPO, file), 'utf8'));
    if (sites.length > 0) found[file] = sites.length;
    for (const site of sites) if (!site.passesGate) missing.push(`${file}:${site.line}`);
  }
  assert.deepEqual(found, AGENT_RUN_SITES);
  assert.deepEqual(missing, [], 'every construction names a gate');
  assert.deepEqual(agentRunConstructions('const run = new AgentRun({ client, model, tools });'), [{ line: 1, passesGate: false }], 'the scan finds a planted construction without one');
  assert.deepEqual(agentRunConstructions('const run = new AgentRun({ client, ...(gate ? { gate } : {}) });'), [{ line: 1, passesGate: true }]);
});

test('no production file under src imports child_process or execa except the listed ones, each with a reason, and planted imports are reported', () => {
  const files: Record<string, string> = {};
  for (const file of productionSources()) files[file] = readFileSync(path.join(REPO, file), 'utf8');
  assert.ok(Object.keys(files).length > 200, 'the scan read all of src');
  assert.ok(Object.keys(files).some((file) => file.startsWith('src/services/')) && Object.keys(files).some((file) => file.startsWith('src/team/')), 'the scan reaches services and team, not only agent and mcp');
  assert.ok(!Object.keys(files).some((file) => file.startsWith('src/test/')), 'src/test is the one folder left out');
  const importers = processImporters(files);
  for (const file of importers) assert.ok(file in PROCESS_IMPORTERS, `${file} starts processes and is not on the list`);
  for (const [file, reason] of Object.entries(PROCESS_IMPORTERS)) {
    assert.ok(existsSync(path.join(REPO, file)), `${file} exists`);
    assert.ok(importers.includes(file), `${file} is on the list but no longer starts a process, so remove it`);
    assert.ok(reason.length > 20 && !reason.includes('\u2014'), `${file} has a plain reason`);
  }
  assert.deepEqual(processImporters({ 'src/agent/new.ts': "import { spawn } from 'node:child_process';", 'src/mcp/new.ts': "const cp = require('child_process');", 'src/agent/quiet.ts': "import { x } from './shell';", 'src/agent/exe.ts': "import execa from 'execa';" }), ['src/agent/exe.ts', 'src/agent/new.ts', 'src/mcp/new.ts']);
  // The planted case outside agent and mcp: a service that starts a process is reported, and an unlisted one fails the check above.
  const planted = { 'src/services/newHelper.ts': "import { execFile } from 'node:child_process';\nexecFile('rm', ['-rf', root]);", 'src/services/fine.ts': "import { join } from 'node:path';" };
  assert.deepEqual(processImporters(planted), ['src/services/newHelper.ts']);
  assert.ok(!('src/services/newHelper.ts' in PROCESS_IMPORTERS), 'a planted service is not on the list, so the scan above would fail on it');
});

// One scripted run per effect kind: the tool is spied so the test sees what had been recorded the moment it started.
interface EffectCase { name: string; tool: AgentTool<any>; args: Record<string, unknown>; operation: string }

function mcpCase(): EffectCase {
  const config: McpServerConfig = { id: 'catalog', name: 'Catalog', transport: 'http', approval: 'trusted' };
  const connection = { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' }, readOnly: true, destructive: false }], call: async () => 'ok' } as unknown as McpConnection;
  const tool = mcpAgentTools(config, connection, 'catalog.example')[0] as AgentTool<any>;
  return { name: tool.name, tool, args: {}, operation: 'mcp' };
}

function effectCases(): EffectCase[] {
  const all = builtInTools();
  const named = (name: string): AgentTool<any> => all.find((tool) => tool.name === name) as AgentTool<any>;
  return [
    { name: 'Read', tool: named('Read'), args: { file_path: 'a.ts' }, operation: 'read' },
    { name: 'Write', tool: named('Write'), args: { file_path: 'new.md', content: 'x' }, operation: 'workspaceWrite' },
    { name: 'Bash', tool: named('Bash'), args: { command: 'git status' }, operation: 'shell' },
    { name: 'WebFetch', tool: named('WebFetch'), args: { url: 'https://example.com/page' }, operation: 'network' },
    mcpCase(),
    { name: 'Agent', tool: named('Agent'), args: { prompt: 'look around', subagent_type: 'helper', description: 'look' }, operation: 'spawn' }
  ];
}

for (const effect of effectCases()) {
  test(`${effect.name} (${effect.operation}): a scripted run records a decision before the tool's run starts`, async () => {
    const root = await project();
    const order: string[] = [];
    const base = testGateRuntime();
    const gate: GateRuntime = { ...base, sink: { record: (record: DecisionRecord) => { order.push(`decision:${record.api.request.uid}:${record.api.operation}`); base.sink.record(record); } } };
    const spy: AgentTool<any> = { ...effect.tool, run: async () => { order.push(`run:${effect.tool.name}`); return 'ok'; } };
    const setup = runWith(root, [{ calls: [call('e1', effect.tool.name, effect.args)] }, { text: 'done' }], { gate, mode: 'fully-autonomous', tools: [...CORE_TOOLS.filter((tool) => tool.name !== effect.tool.name), spy] });
    try {
      const result = await go(setup);
      assert.equal(result.outcome, 'completed');
    } finally {
      setup.shell.dispose();
    }
    assert.deepEqual(order, [`decision:e1:${effect.operation}`, `run:${effect.tool.name}`], 'one decision, and it came first');
  });
}
