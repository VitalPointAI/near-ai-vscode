// The gate in front of every chat tool call and every sub-agent's (GATE-04, GATE-07, OFFL-02, D-08, D-09, D-10, D-43): a real run's call is decided and
// recorded on disk before it runs, a broken bundle fails closed, a card is only a transport (its answer goes back into the gate, which records it and
// re-checks), sub-agents pass the same gate as a person's run, and with a valid bundle nothing decides differently. Plan 13 adds the remaining execution
// paths to this file.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { effectsOfCall, gateToolCall, defaultGateRuntime, manifestArguments } from '../agent/gateAdapter';
import { AgentRun } from '../agent/loop';
import type { AgentEvent, ApprovalReply, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { builtInTools } from '../agent/toolCatalog';
import { CORE_TOOLS } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { GATE_RULE_IDS } from '../domain/gate/decide';
import type { GateRuntime } from '../domain/gate/decide';
import type { DecisionRecord } from '../domain/gate/record';
import type { ActionPolicy } from '../domain/policy';
import { GateHost } from '../gate/host';
import type { RuntimeRequest } from '../gate/host';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { MemorySecrets } from './helpers/teamHarness';

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
    gate: started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'conv-1', agentId: 'main-1', agentLabel: 'agent' }, presence: 'person', context: 'interactive', floorMode: 'shadow' }),
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
  assert.deepEqual(records.map((record) => [callIdOf(record), outcomeOf(record)]), [['w1', 'asked']]);
  assert.deepEqual(records.map((record) => record.metadata.sequence), [1]);
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
  ], { gate: second.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'conv-2', agentId: 'main-2' }, presence: 'person', context: 'interactive', floorMode: 'shadow' }), mode: 'fully-autonomous' });
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
  const runtime = (): GateRuntime => started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive', floorMode: 'shadow' });
  const edit = (id: string): ToolCall => call(id, 'Edit', { file_path: 'a.ts', old_string: 'value = 1', new_string: 'value = 2' });
  const asking = runWith(root, [{ calls: [call('r1', 'Read', { file_path: 'a.ts' }), edit('e1')] }, { text: 'done' }], { gate: runtime() });
  try {
    await go(asking);
  } finally {
    asking.shell.dispose();
  }
  assert.deepEqual(asking.approvals.map((request) => request.callId), ['e1'], 'only the edit asked');
  assert.match(await readFile(path.join(root, 'a.ts'), 'utf8'), /value = 2/);
  const quiet = runWith(root, [{ calls: [call('r2', 'Read', { file_path: 'a.ts' })] }, { calls: [edit('e2')] }, { text: 'done' }], { gate: runtime(), mode: 'mostly-autonomous' });
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

test('a Write named by an absolute path inside the project is judged as that project path: the floor would ask, shadow keeps today\'s decision and records the floor rule beside it', async () => {
  const started = await startedHost();
  const root = await project();
  const hooks = path.join(root, '.git', 'hooks');
  const setup = runWith(root, [{ calls: [call('w1', 'Write', { file_path: path.join(hooks, 'pre-commit'), content: '#!/bin/sh\n' })] }, { text: 'ok' }], {
    gate: started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive', floorMode: 'shadow' }),
    mode: 'fully-autonomous'
  });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  // Today's loop asks for a protected write only through the tool's own sensitive hook; the gate records what the floor would have said.
  const records = await logOf(started, root);
  const first = records.find((record) => callIdOf(record) === 'w1');
  assert.ok(first);
  assert.equal(first.unmapped.nearAi.shadowFloor, 'floor.protected-write');
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

test('a call whose effects cannot be filled keeps today\'s decision while the floor only reports, and asks or refuses with manifest.effects-unknown once it is enforced', async () => {
  const root = await project();
  const outside = path.join(tmpdir(), 'near-ai-gate-outside', 'x.txt');
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const input = (gate: GateRuntime) => ({
    tool: read, raw: { file_path: outside }, root, callId: 'r1', policy: { mode: 'approve-risky', emergencyStop: false } as ActionPolicy,
    rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined, ...(gate ? {} : {})
  });
  const shadow = defaultGateRuntime();
  assert.ok(effectsOfCall(shadow, read, { file_path: outside }, root).length > 0, 'the stand-in is never an empty list');
  const kept = await gateToolCall(shadow, input(shadow));
  assert.equal(kept.decision.outcome, 'allow');
  assert.equal(kept.decision.rule, 'settings.read-plan');
  const enforced: GateRuntime = { ...defaultGateRuntime(), floorMode: 'enforce' };
  assert.deepEqual(effectsOfCall(enforced, read, { file_path: outside }, root), []);
  const asked = await gateToolCall(enforced, input(enforced));
  assert.equal(asked.decision.outcome, 'ask');
  assert.equal(asked.decision.rule, 'manifest.effects-unknown');
  assert.equal(asked.decision.offerAlwaysAllow, false);
  assert.equal(asked.decision.allowGrant, false);
  const nobody = await gateToolCall({ ...enforced, presence: 'none' }, input(enforced));
  assert.equal(nobody.decision.outcome, 'deny');
  assert.equal(nobody.decision.rule, 'manifest.effects-unknown');
});

test('no built-in tool declares an empty effect list: every manifest has a template, and an unreadable call still gets a non-empty stand-in while the floor reports', () => {
  const shadow = defaultGateRuntime();
  const root = path.join(tmpdir(), 'near-ai-gate-catalog');
  const tools = builtInTools();
  assert.ok(tools.length >= 40);
  for (const tool of tools) {
    assert.ok(tool.manifest.effects.some((entry) => !('from' in entry)), `${tool.name} declares at least one effect of its own`);
    assert.ok(effectsOfCall(shadow, tool, {}, root).length > 0, `${tool.name} never reaches decide() with an empty list`);
  }
});

test('every rule id a settings answer is given is a rule id the gate can record', async () => {
  const root = await project();
  const grants = new RunGrants();
  const base = { rules: DEFAULT_RULES, grants, buildAuto: async () => undefined, root };
  const shell = CORE_TOOLS.find((tool) => tool.name === 'Bash') as AgentTool<any>;
  const write = CORE_TOOLS.find((tool) => tool.name === 'Write') as AgentTool<any>;
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const runtime = defaultGateRuntime();
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

