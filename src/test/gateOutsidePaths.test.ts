// File-tool paths outside the project and every trusted folder (owner decision after PR #74): the tools refuse such a path themselves, so a card for it
// could only end in that refusal. The gate refuses it up front instead, in every mode, with a person and with nobody, with the tool's own "outside the
// workspace" message and a record under `call.outside-workspace`. A credential store is still the floor's refusal, the emergency stop still comes first,
// a read in a trusted folder still runs, and a write into a trusted folder (which is for reading only) is refused the same way. Every folder here is under
// the test run's temporary folder.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { editTool, globTool, readTool, writeTool } from '../agent/tools';
import type { AgentTool, ToolContext } from '../agent/tools';
import { GATE_RULE_IDS } from '../domain/gate/decide';
import type { DecisionRecord } from '../domain/gate/record';
import { validateDecisionRecord } from '../domain/gate/record';
import type { ApprovalRequest } from '../agent/loop';
import { fakeHome } from './helpers/gateFixtures';
import { newTestRun, testGateRuntime } from './helpers/gatedRuns';

const MODES = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const;
const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-outside-')));
const ROOT = path.join(base, 'project');
const OUTSIDE = path.join(base, 'elsewhere');
const TRUSTED = path.join(base, 'trusted-runtime');
mkdirSync(ROOT);
mkdirSync(OUTSIDE);
mkdirSync(TRUSTED);
writeFileSync(path.join(OUTSIDE, 'notes.md'), 'outside-marker');
writeFileSync(path.join(TRUSTED, 'guide.md'), 'guide-marker');
writeFileSync(path.join(ROOT, 'a.md'), 'a');
const ruleOf = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';

async function decideFor(tool: AgentTool<any>, raw: Record<string, unknown>, mode: (typeof MODES)[number], presence: 'person' | 'none', emergencyStop = false) {
  const runtime = testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {});
  const gated = await gateToolCall(runtime, {
    tool, raw, root: ROOT, callId: `${tool.name}-${mode}-${presence}`, policy: { mode, emergencyStop }, rules: DEFAULT_RULES, grants: new RunGrants(),
    readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  return { gated, runtime };
}

test('a file-tool path outside the project and every trusted folder is refused up front, in every mode, with a person and with nobody', async () => {
  assert.ok(GATE_RULE_IDS.includes('call.outside-workspace'));
  for (const mode of MODES) {
    for (const presence of ['person', 'none'] as const) {
      for (const [tool, raw] of [
        [readTool, { file_path: path.join(OUTSIDE, 'notes.md') }], [readTool, { file_path: '../elsewhere/notes.md' }], [writeTool, { file_path: path.join(OUTSIDE, 'new.md'), content: 'x' }],
        [editTool, { file_path: path.join(OUTSIDE, 'notes.md'), old_string: 'a', new_string: 'b' }], [globTool, { pattern: '*.md', path: OUTSIDE }],
        // A trusted folder is for reading: a write there is outside what the tool may write.
        [writeTool, { file_path: path.join(TRUSTED, 'planted.md'), content: 'x' }]
      ] as const) {
        const { gated, runtime } = await decideFor(tool, raw, mode, presence);
        const where = `${tool.name} ${JSON.stringify(raw)} (${mode}, ${presence})`;
        assert.equal(gated.decision.outcome, 'deny', where);
        assert.equal(gated.decision.rule, 'call.outside-workspace', where);
        assert.match(gated.decision.reason ?? '', /is outside the workspace\. Tools can only use files under /, where);
        assert.equal(gated.settings, undefined, `${where}: the settings layer is not asked`);
        assert.equal(runtime.records.length, 1, where);
        assert.equal(ruleOf(runtime.records[0]!), 'call.outside-workspace', where);
        assert.equal(runtime.records[0]!.action_id, 2, `${where}: denied`);
        assert.equal(validateDecisionRecord(runtime.records[0]!).ok, true, where);
      }
    }
  }
});

test('what still decides first or otherwise: a credential store is the floor\'s, the emergency stop wins, a trusted read and a project path run', async () => {
  const home = fakeHome();
  const store = await gateToolCall({ ...testGateRuntime(), locations: { home } }, {
    tool: readTool, raw: { file_path: path.join(home, '.ssh', 'id_ed25519') }, root: ROOT, callId: 'store', policy: { mode: 'fully-autonomous', emergencyStop: false },
    rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.equal(store.decision.rule, 'floor.credential-store');
  const stopped = await decideFor(readTool, { file_path: path.join(OUTSIDE, 'notes.md') }, 'fully-autonomous', 'person', true);
  assert.equal(stopped.gated.decision.rule, 'settings.emergency-stop');
  for (const presence of ['person', 'none'] as const) {
    assert.equal((await decideFor(readTool, { file_path: path.join(TRUSTED, 'guide.md') }, 'fully-autonomous', presence)).gated.decision.outcome, 'allow', `trusted read (${presence})`);
    assert.equal((await decideFor(readTool, { file_path: path.join(ROOT, 'a.md') }, 'fully-autonomous', presence)).gated.decision.outcome, 'allow', `project read (${presence})`);
  }
  // A path the tool refuses for another reason (none given) is not this rule: it stays unknown and asks.
  assert.equal((await decideFor(readTool, { file_path: '' }, 'fully-autonomous', 'person')).gated.decision.rule === 'call.outside-workspace', false);
});

test('through a real run, with a person: no card is shown, nothing outside is read or written, and the agent is told the tool\'s own reason', async () => {
  for (const presence of ['person', 'none'] as const) {
    const cards: ApprovalRequest[] = [];
    const gate = testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {});
    const shell = new ShellSession(ROOT, undefined, { HOME: fakeHome() });
    try {
      const context: ToolContext = { root: ROOT, signal: new AbortController().signal, checkpoints: new RunCheckpoints('outside'), shell, readFiles: new Set(), readOnlyRoots: [TRUSTED] };
      const calls = [
        { id: 'o1', type: 'function' as const, function: { name: 'Read', arguments: JSON.stringify({ file_path: path.join(OUTSIDE, 'notes.md') }) } },
        { id: 'o2', type: 'function' as const, function: { name: 'Write', arguments: JSON.stringify({ file_path: path.join(OUTSIDE, 'new.md'), content: 'x' }) } }
      ];
      let turn = 0;
      const client = {
        async *streamCompletion() {
          const next = calls[turn];
          turn += 1;
          yield next ? { type: 'done', message: { role: 'assistant', content: null, tool_calls: [next] }, finishReason: 'tool_calls', usage: { verificationStatus: 'unknown', latencyMs: 1 } }
            : { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } };
        }
      };
      const run = newTestRun({
        client: client as never, model: 'm', tools: [readTool, writeTool], context, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gate,
        requestApproval: async (card) => { cards.push(card); return { decision: 'allow' }; }, emit: () => undefined
      });
      const result = await run.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], new AbortController().signal);
      const outputs = result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
      assert.equal(cards.length, 0, `${presence}: no card`);
      for (const output of outputs) assert.match(output, /^Not allowed: .*is outside the workspace/, `${presence}: ${output}`);
      assert.doesNotMatch(outputs.join('\n'), /outside-marker/);
      assert.equal(existsSync(path.join(OUTSIDE, 'new.md')), false);
      assert.deepEqual(gate.records.map(ruleOf), ['call.outside-workspace', 'call.outside-workspace']);
    } finally {
      shell.dispose();
    }
  }
});
