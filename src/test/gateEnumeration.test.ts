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
import { effectsOfCall, gateToolCall, recordApprovalReply, recordLateApproval, defaultGateRuntime, manifestArguments } from '../agent/gateAdapter';
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

// ---- Task 2: cards are a transport ----

test('a card answered allow gives asked then approved for the same call id; answered deny gives asked then denied and the call does not run', async () => {
  const started = await startedHost();
  const root = await project();
  const runtime = (): GateRuntime => started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive', floorMode: 'shadow' });
  const allowed = runWith(root, [{ calls: [call('a1', 'Write', { file_path: 'yes.md', content: 'y' })] }, { text: 'ok' }], { gate: runtime(), answer: () => ({ decision: 'allow' }) });
  const denied = runWith(root, [{ calls: [call('d1', 'Write', { file_path: 'no.md', content: 'n' })] }, { text: 'ok' }], { gate: runtime(), answer: () => ({ decision: 'deny' }) });
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
    gate: started.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive', floorMode: 'shadow' }),
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
  const live = fresh.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'c', agentId: 'm' }, presence: 'person', context: 'interactive', floorMode: 'shadow' });
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
  const runtime = defaultGateRuntime();
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
  const runtime = defaultGateRuntime();
  const setup = runWith(root, [{ calls: [{ id: 'bad', type: 'function', function: { name: 'Write', arguments: '{not json' } }] }, { text: 'sorry' }], { gate: runtime });
  try {
    await go(setup);
  } finally {
    setup.shell.dispose();
  }
  assert.match(toolOutputs(setup)[0] ?? '', /^Arguments are not valid JSON/);
  assert.equal(runtime.records.length, 0);
  const none = defaultGateRuntime();
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
  const base = defaultGateRuntime();
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
  public override runtimeFor(request: RuntimeRequest): GateRuntime {
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
  assert.deepEqual(host.requests.map((request) => [request.actor.kind, request.presence, request.context, request.floorMode]), [
    ['agent', 'person', 'interactive', 'shadow'], ['sub-agent', 'person', 'interactive', 'shadow']
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
  const enforced = (presence: 'person' | 'none'): GateRuntime => ({ ...defaultGateRuntime({ presence }), floorMode: 'enforce' });
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
