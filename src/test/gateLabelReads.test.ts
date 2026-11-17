// Clearance checks on every path an agent reads (CLAS-03, D-28, D-53): the file tools, Glob and Grep, the words of a shell command, a command whose effects
// nobody can read, a policy that failed closed, and cyber steps. The label file here is written unsigned, so the runs read it the way a run with no gate
// host does: trusting no key, so every label in it only raises (fail closed). Nothing leaves this computer; every project is under the temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { gateStep, gateToolCall } from '../agent/gateAdapter';
import { FAILED_CLOSED_LABEL_TEXT } from '../agent/gateLabels';
import type { AgentEvent, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, globTool, grepTool, readTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { failedClosed } from '../domain/gate/bundle';
import type { GateRuntime } from '../domain/gate/decide';
import type { Label } from '../domain/gate/labels';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { LABEL_MAP_FILE } from '../gate/labelMapStore';
import { newTestRun, testGateRuntime } from './helpers/gatedRuns';

const SECRET = 'THE PROTECTED B PLAN';

function label(scale: string, level: string): Label {
  return { scale, level, compartments: [], releasability: [], handling: [] };
}

/** A project with secret/plan.md labelled Protected B, internal.md labelled org Internal, and plain files beside them, in an unsigned label file. */
function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-label-reads-')));
  mkdirSync(path.join(root, 'secret'));
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  writeFileSync(path.join(root, 'secret', 'plan.md'), `${SECRET}\n`);
  writeFileSync(path.join(root, 'internal.md'), 'PLAN for the team\n');
  writeFileSync(path.join(root, 'notes.md'), 'PLAN notes, public\n');
  const payload = { labelMapVersion: 1, vocabulary: 1, entries: { 'secret/plan.md': label('ca-protected', 'Protected B'), 'internal.md': label('org', 'Internal') } };
  writeFileSync(path.join(root, ...LABEL_MAP_FILE.split('/')), JSON.stringify({ v: 1, purpose: 'label-map', signer: { fingerprint: 'x', publicKey: 'A'.repeat(43) }, signedAt: '2026-11-17T00:00:00.000Z', payload, sig: 'x' }));
  return root;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function scripted(calls: ToolCall[]) {
  let turn = 0;
  const usage = { inputTokens: 1, outputTokens: 1 };
  return {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const next = calls[turn];
      turn += 1;
      if (!next) { yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage } as CompletionEvent; return; }
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [next] }, finishReason: 'tool_calls', usage } as CompletionEvent;
    }
  };
}

async function run(root: string, calls: ToolCall[], gate: GateRuntime = testGateRuntime(), tools: AgentTool<any>[] = [readTool, globTool, grepTool, bashTool], approve = false): Promise<{ outputs: string[]; cards: ApprovalRequest[]; transcript: string }> {
  const events: AgentEvent[] = [];
  const cards: ApprovalRequest[] = [];
  const shell = new ShellSession(root);
  const agent = newTestRun({
    client: scripted(calls) as never, model: 'm', tools, gate,
    context: { root, checkpoints: new RunCheckpoints('label-reads'), shell, readFiles: new Set() },
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async (card) => { cards.push(card); return { decision: approve ? 'allow' : 'deny' }; }, emit: (event) => events.push(event)
  });
  const result = await agent.run([{ role: 'user', content: 'go' }], new AbortController().signal).finally(() => shell.dispose());
  const outputs = events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);
  return { outputs, cards, transcript: JSON.stringify(result.messages) };
}

const PB_REFUSAL = /^Not allowed: This file is labelled ca-protected\/Protected B, and your policy gives you no clearance on that scale\./;

test('Grep over a folder never returns a line from a file above the clearances and says how many lines it hid; Glob leaves the path out the same way', async () => {
  const root = project();
  const grep = await run(root, [call('g1', 'Grep', { pattern: 'PLAN', output_mode: 'content' })]);
  assert.ok(!grep.transcript.includes(SECRET), 'no line of the labelled file');
  assert.match(grep.outputs[0] ?? '', /PLAN notes, public/);
  assert.match(grep.outputs[0] ?? '', /1 line hidden because its file is labelled above your clearance\./);
  const glob = await run(root, [call('l1', 'Glob', { pattern: '**/*.md' })]);
  assert.ok(!(glob.outputs[0] ?? '').includes('plan.md'), 'the path is left out');
  assert.match(glob.outputs[0] ?? '', /notes\.md/);
  assert.match(glob.outputs[0] ?? '', /1 file hidden because its file is labelled above your clearance\./);
  // A search aimed at the file by path is refused by the verdict before it runs.
  const aimed = await run(root, [call('g2', 'Grep', { pattern: 'PLAN', path: 'secret/plan.md', output_mode: 'content' })]);
  assert.match(aimed.outputs[0] ?? '', PB_REFUSAL);
  assert.ok(!aimed.transcript.includes(SECRET));
});

test('a shell command that names the file (a known read, or one whose effects nobody can read) is refused with label.dominance, and a person sees no card', async () => {
  const root = project();
  for (const command of ['cat secret/plan.md', 'python3 -c "$X" secret/plan.md', 'cd secret && cat plan.md']) {
    const ran = await run(root, [call('b1', 'Bash', { command })]);
    assert.match(ran.outputs[0] ?? '', PB_REFUSAL, command);
    assert.equal(ran.cards.length, 0, `${command}: no card`);
    assert.ok(!ran.transcript.includes(SECRET), command);
  }
});

test('a known limit: a command that reads the file through a variable is not seen, and runs', async () => {
  const root = project();
  const ran = await run(root, [call('b1', 'Bash', { command: 'X=secret; cat "$X/plan.md"' })], testGateRuntime(), undefined, true);
  // This is the documented gap (LABELS_NOT_ACCREDITATION_TEXT: a shell command cannot be fully seen). If this assertion ever fails, the gap closed: update
  // SECURITY.md and this test together.
  assert.ok(ran.transcript.includes(SECRET), 'the variable read is not seen');
});

test('with the policy failed closed there are no clearances: a file above the shipped default is refused with the reset sentence, an unlabelled file is still read', async () => {
  const root = project();
  const broken: GateRuntime = { ...testGateRuntime(), bundleState: () => failedClosed('bad-signature') };
  const internal = await run(root, [call('r1', 'Read', { file_path: 'internal.md' })], broken);
  assert.equal(internal.outputs[0], `Not allowed: ${FAILED_CLOSED_LABEL_TEXT}`);
  const plain = await run(root, [call('r2', 'Read', { file_path: 'notes.md' })], broken);
  assert.match(plain.outputs[0] ?? '', /PLAN notes, public/);
  // With a valid policy the default clearance (org Restricted) covers org Internal.
  const valid = await run(root, [call('r3', 'Read', { file_path: 'internal.md' })]);
  assert.match(valid.outputs[0] ?? '', /PLAN for the team/);
});

test('a cyber step whose path is labelled above the clearances is refused the same way', async () => {
  const root = project();
  const gated = await gateStep(testGateRuntime(), {
    tool: 'file-probe', callId: 'step-1', effects: [{ verb: 'read', paths: ['secret/plan.md'] }], root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  });
  assert.equal(gated.decision.outcome, 'deny');
  assert.equal(gated.decision.rule, 'label.dominance');
  const shell = await gateStep(testGateRuntime(), {
    tool: 'shell-step', callId: 'step-2', effects: [{ verb: 'shell', cwd: 'workspace' } as never], command: 'strings secret/plan.md', root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  });
  assert.equal(shell.decision.rule, 'label.dominance');
});

test('a command nobody can read that names a labelled file is refused, not asked about, with a person here (D-53)', async () => {
  const root = project();
  // Nested deeper than the classifier reads, so its effects are unknown; its words still name the file.
  const DEEP = `${'if '.repeat(10)}cat secret/plan.md`;
  const gated = await gateToolCall(testGateRuntime(), {
    tool: bashTool, raw: { command: DEEP }, root, callId: 'u1', command: DEEP, shell: { cwd: root },
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.equal(gated.effects.length, 0, 'its effects are unknown');
  assert.equal(gated.decision.outcome, 'deny');
  assert.equal(gated.decision.rule, 'label.dominance');
});
