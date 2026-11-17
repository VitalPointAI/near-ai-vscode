// A call the caller refuses itself is always on record as refused (PR #70 third review): the loop's `forbidden` hook and the cyber panel's scope check hand
// their answer to the gate, so the stored record never reads "allowed" or "asked" for a call that did not run, whatever the gate would have said alone.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { TOOL_FORBIDDEN_RULE, gateStep, gateToolCall } from '../agent/gateAdapter';
import { AgentRun } from '../agent/loop';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { GATE_RULE_IDS } from '../domain/gate/decide';
import type { GateRuntime } from '../domain/gate/decide';
import type { DecisionRecord } from '../domain/gate/record';
import { fromActionCapability } from '../domain/gate/vocabulary';
import type { ActionPolicy } from '../domain/policy';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { testGateRuntime } from './helpers/gatedRuns';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const KEYS = '.near-ai/state/keys/local.key';

/** The outcome word a stored record carries: `asked` and `approved` are their own, a floor refusal is its own, everything else is told by the OCSF action. */
function outcomeOf(record: DecisionRecord): string {
  if (record.unmapped.nearAi.outcome !== undefined) return record.unmapped.nearAi.outcome;
  if (record.disposition_id === 8) return 'approved';
  if (record.action_id === 1) return 'allowed';
  return record.disposition_id === 2 ? 'refused-by-floor' : 'denied';
}

const REFUSED = ['denied', 'refused-by-floor'];

function modelFor(calls: ToolCall[]) {
  let seen = 0;
  return {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const turn = seen === 0 ? calls : undefined;
      seen += 1;
      yield { type: 'done', message: { role: 'assistant', content: turn ? null : 'done', ...(turn ? { tool_calls: turn } : {}) }, finishReason: turn ? 'tool_calls' : 'stop', usage };
    }
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-refusal-'));
  await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
  return root;
}

interface Ran { outputs: string[]; approvals: number }

/** Runs one scripted call through the real loop under the given runtime and tools, answering any card with allow, and says what happened. */
async function runCall(runtime: ReturnType<typeof testGateRuntime>, calls: ToolCall[], options: { tools?: AgentTool<any>[]; mode?: ActionPolicy['mode'] } = {}): Promise<Ran> {
  const root = await project();
  const shell = new ShellSession(root);
  const events: AgentEvent[] = [];
  let approvals = 0;
  const run = new AgentRun({
    client: modelFor(calls), model: 'z-ai/glm-5.3', tools: options.tools ?? CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('refusal'), shell, readFiles: new Set() },
    policy: { mode: options.mode ?? 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gate: runtime,
    requestApproval: async () => { approvals += 1; return { decision: 'allow' }; },
    emit: (event) => events.push(event)
  });
  try {
    await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
  } finally {
    shell.dispose();
  }
  const outputs = events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);
  return { outputs, approvals };
}

function runtimeFor(options: { presence: 'person' | 'none' }): ReturnType<typeof testGateRuntime> {
  return testGateRuntime(options.presence === 'none' ? { presence: 'none', context: 'unattended' } : {});
}

// Every reason the loop produces today: each tool that has a `forbidden` hook, named by a call that reaches the key folder.
const FORBIDDEN_CALLS: Array<[string, string, Record<string, unknown>]> = [
  ['Read of the key folder', 'Read', { file_path: KEYS }],
  ['Write into the key folder', 'Write', { file_path: KEYS, content: 'x' }],
  ['Edit in the key folder', 'Edit', { file_path: KEYS, old_string: 'a', new_string: 'b' }],
  ['Glob of the key folder', 'Glob', { pattern: '**/*', path: '.near-ai/state/keys' }],
  ['Grep with a path in the key folder', 'Grep', { pattern: 'x', path: '.near-ai/state/keys' }],
  ['a shell command that names the key folder', 'Bash', { command: `cat ${KEYS}` }]
];

test('every call the loop forbids is recorded as refused with a reason, never allowed or asked, with a person here or not, and no card is shown', async () => {
  for (const [label, name, args] of FORBIDDEN_CALLS) {
    {
      for (const presence of ['person', 'none'] as const) {
        const runtime = runtimeFor({ presence });
        const ran = await runCall(runtime, [call('f1', name, args)], { mode: 'fully-autonomous' });
        const where = `${label} (${presence})`;
        assert.match(ran.outputs[0] ?? '', /^Not allowed: /, where);
        assert.equal(ran.approvals, 0, `${where}: no card`);
        assert.equal(runtime.records.length, 1, `${where}: exactly one record`);
        const record = runtime.records[0] as DecisionRecord;
        assert.ok(REFUSED.includes(outcomeOf(record)), `${where}: recorded as ${outcomeOf(record)}`);
        assert.ok((record.status_detail ?? '').length > 0, `${where}: the record carries a reason`);
        const rule = record.authorizations[0]?.policy.name ?? '';
        assert.ok(GATE_RULE_IDS.includes(rule), `${where}: ${rule} is a rule the gate can record`);
      }
    }
  }
});

test('a call the loop forbids that no gate rule would refuse (its effects are unknown while the floor is enforced) is recorded denied with the loop\'s own rule and reason, not asked', async () => {
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const reason = 'Planted: this tool refuses this call itself.';
  // A manifest that lists no effect (a damaged stored one, hand-made because the parsers refuse it) cannot be filled, so the gate alone would ask (or refuse
  // with nobody there) with manifest.effects-unknown. (This used a path outside the project; since the owner decision after PR #74 the gate refuses that
  // itself as call.outside-workspace, so it no longer shows a call no gate rule would refuse.)
  const undeclared = { manifestVersion: 1, tool: 'Planted', effects: [], hosts: [], credentials: [], contexts: ['interactive', 'unattended'], untrusted: false, runsOn: 'this-machine' } as unknown as AgentTool<any>['manifest'];
  const planted: AgentTool<any> = { ...read, name: 'Planted', manifest: undeclared, forbidden: async () => reason };
  for (const presence of ['person', 'none'] as const) {
    const runtime = runtimeFor({ presence });
    const ran = await runCall(runtime, [call('p1', 'Planted', { file_path: 'notes.md' })], { tools: [planted] });
    assert.equal(ran.outputs[0], `Not allowed: ${reason}`);
    assert.equal(ran.approvals, 0);
    assert.equal(runtime.records.length, 1);
    const record = runtime.records[0] as DecisionRecord;
    assert.equal(outcomeOf(record), 'denied', presence);
    // With a person here the gate alone would have asked, so the loop's own rule and reason are what is on record. With nobody there the gate refuses first with
    // its own rule, which stands.
    assert.equal(record.authorizations[0]?.policy.name, presence === 'person' ? TOOL_FORBIDDEN_RULE : 'manifest.effects-unknown', presence);
    if (presence === 'person') assert.equal(record.status_detail, reason);
    else assert.ok((record.status_detail ?? '').length > 0);
  }
});

test('a refusal handed to gateToolCall is denied whatever the settings would have said, and today\'s permission logic is not asked', async () => {
  const root = await project();
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const refusal = { rule: TOOL_FORBIDDEN_RULE, reason: 'Refused by the caller.' };
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    {
      const runtime: GateRuntime & { records: DecisionRecord[] } = testGateRuntime();
      let asked = 0;
      const gated = await gateToolCall(runtime, {
        tool: read, raw: { file_path: 'a.ts' }, root, callId: 'r1', policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
        buildAuto: async () => { asked += 1; return undefined; }
      }, { refusal });
      assert.equal(gated.decision.outcome, 'deny', mode);
      assert.equal(gated.decision.rule, TOOL_FORBIDDEN_RULE);
      assert.equal(gated.decision.reason, refusal.reason);
      assert.equal(asked, 0, 'the permission logic was not run for a call that will not run');
      assert.equal(runtime.records.length, 1);
      assert.equal(outcomeOf(runtime.records[0] as DecisionRecord), 'denied');
    }
  }
});

test('a refusal is still beaten by a layer that outranks the caller: the emergency stop and a failed bundle keep their own rule, and the record is a refusal either way', async () => {
  const root = await project();
  const read = CORE_TOOLS.find((tool) => tool.name === 'Read') as AgentTool<any>;
  const refusal = { rule: TOOL_FORBIDDEN_RULE, reason: 'Refused by the caller.' };
  const stopped = testGateRuntime();
  const first = await gateToolCall(stopped, { tool: read, raw: { file_path: 'a.ts' }, root, callId: 'e1', policy: { mode: 'auto', emergencyStop: true }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined }, { refusal });
  assert.equal(first.decision.rule, 'settings.emergency-stop');
  assert.equal(outcomeOf(stopped.records[0] as DecisionRecord), 'denied');
  const broken = { ...testGateRuntime(), bundleState: () => { throw new Error('the state could not be read'); } };
  const second = await gateToolCall(broken, { tool: read, raw: { file_path: 'a.ts' }, root, callId: 'e2', policy: { mode: 'auto', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined }, { refusal });
  assert.equal(second.decision.outcome, 'deny', 'a gate that cannot be asked leaves the refusal standing');
  assert.equal(second.decision.rule, TOOL_FORBIDDEN_RULE);
});

test('a refusal handed to gateStep is denied and recorded denied even when the settings answer allows it', async () => {
  const runtime = testGateRuntime();
  const effects = fromActionCapability('network', { hosts: ['evil.test'] }).capabilities;
  const gated = await gateStep(runtime, {
    tool: 'CyberHttpProbe', callId: 'run/s1', effects, policy: { mode: 'fully-autonomous', emergencyStop: false } as ActionPolicy,
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  }, { refusal: { rule: 'settings.engagement-grant', reason: 'outside the resolved scope' } });
  assert.equal(gated.decision.outcome, 'deny');
  assert.equal(gated.decision.rule, 'settings.engagement-grant');
  assert.equal(outcomeOf(runtime.records[0] as DecisionRecord), 'denied');
  assert.equal(runtime.records[0]?.status_detail, 'outside the resolved scope');
});
