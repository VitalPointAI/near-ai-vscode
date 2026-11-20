// Clearance checks on every path an agent reads (CLAS-03, D-28, D-53): the file tools, Glob and Grep, the words of a shell command, a command whose effects
// nobody can read, a policy that failed closed, and cyber steps. The label file here is written unsigned, so the runs read it the way a run with no gate
// host does: trusting no key, so every label in it only raises (fail closed). Nothing leaves this computer; every project is under the temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { gateStep, gateToolCall } from '../agent/gateAdapter';
import { FAILED_CLOSED_LABEL_TEXT, labelReadFilter, labelVerdictFor } from '../agent/gateLabels';
import type { AgentEvent, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { INTERACTIVE_AND_UNATTENDED, bashTool, declareManifest, fromArgument, globTool, grepTool, readTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { failedClosed } from '../domain/gate/bundle';
import type { GateRuntime } from '../domain/gate/decide';
import type { Label } from '../domain/gate/labels';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { LABEL_MAP_FILE, LABEL_MAP_UNREADABLE_TEXT } from '../gate/labelMapStore';
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

async function run(root: string, calls: ToolCall[], gate: GateRuntime = testGateRuntime(), tools: AgentTool<any>[] = [readTool, globTool, grepTool, bashTool], approve = false, readOnlyRoots?: string[]): Promise<{ outputs: string[]; cards: ApprovalRequest[]; transcript: string }> {
  const events: AgentEvent[] = [];
  const cards: ApprovalRequest[] = [];
  const shell = new ShellSession(root);
  const agent = newTestRun({
    client: scripted(calls) as never, model: 'm', tools, gate,
    context: { root, checkpoints: new RunCheckpoints('label-reads'), shell, readFiles: new Set(), ...(readOnlyRoots === undefined ? {} : { readOnlyRoots }) },
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async (card) => { cards.push(card); return { decision: approve ? 'allow' : 'deny' }; }, emit: (event) => events.push(event)
  });
  const result = await agent.run([{ role: 'user', content: 'go' }], new AbortController().signal).finally(() => shell.dispose());
  const outputs = events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);
  return { outputs, cards, transcript: JSON.stringify(result.messages) };
}

const PB_REFUSAL = /^Not allowed: This file is labelled Canada, Protected: Protected B, and your policy gives you no clearance on that scale\./;

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

// ---- D-63: the Open-GSD runtime is the extension's own files, judged at the default label ----

/** A project labelled Protected B as a whole (above the default clearance), and a stand-in Open-GSD runtime folder outside it with a link into the project. */
function labelledProjectAndRuntime(): { root: string; runtime: string } {
  const root = project();
  const payload = { labelMapVersion: 1, vocabulary: 1, project: label('ca-protected', 'Protected B'), entries: {} };
  writeFileSync(path.join(root, ...LABEL_MAP_FILE.split('/')), JSON.stringify({ v: 1, purpose: 'label-map', signer: { fingerprint: 'x', publicKey: 'A'.repeat(43) }, signedAt: '2026-11-17T00:00:00.000Z', payload, sig: 'x' }));
  const runtime = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-gsd-runtime-')));
  writeFileSync(path.join(runtime, 'workflow.md'), 'RUNTIME workflow steps\n');
  symlinkSync(path.join(root, 'secret', 'plan.md'), path.join(runtime, 'plan-link.md'));
  return { root, runtime };
}

test('D-63: a read of the Open-GSD runtime is judged at the default label, while the project\'s own files keep the project\'s label', async () => {
  const { root, runtime } = labelledProjectAndRuntime();
  const ran = await run(root, [call('r1', 'Read', { file_path: path.join(runtime, 'workflow.md') })], testGateRuntime(), undefined, false, [runtime]);
  assert.match(ran.outputs[0] ?? '', /RUNTIME workflow steps/);
  const own = await run(root, [call('r2', 'Read', { file_path: 'notes.md' })], testGateRuntime(), undefined, false, [runtime]);
  assert.match(own.outputs[0] ?? '', PB_REFUSAL);
  const search = await run(root, [call('g1', 'Grep', { pattern: 'RUNTIME', path: runtime, output_mode: 'content' })], testGateRuntime(), undefined, false, [runtime]);
  assert.match(search.outputs[0] ?? '', /RUNTIME workflow steps/);
});

test('D-63: a link from the runtime folder into the project does not launder the project file\'s label', async () => {
  const { root, runtime } = labelledProjectAndRuntime();
  const ran = await run(root, [call('r1', 'Read', { file_path: path.join(runtime, 'plan-link.md') })], testGateRuntime(), undefined, false, [runtime]);
  assert.match(ran.outputs[0] ?? '', PB_REFUSAL);
  assert.ok(!ran.transcript.includes(SECRET));
  // A search's results are filtered the same way: a result in the runtime is judged at the default label unless its real place is in the project.
  const canRead = await labelReadFilter(testGateRuntime(), root);
  assert.equal(canRead(path.relative(root, path.join(runtime, 'workflow.md'))), true);
  assert.equal(canRead(path.relative(root, path.join(runtime, 'plan-link.md'))), false);
  assert.equal(canRead('notes.md'), false, 'the project is labelled above the clearance');
});

// ---- D-67: while a label file holds reads, the hold is per path: Open-GSD runtime reads go on, project reads stay held ----

/** A project whose label file cannot be read (a merge conflict), and a runtime folder with its own file and a link into the project. */
function heldProjectAndRuntime(): { root: string; runtime: string } {
  const { root, runtime } = labelledProjectAndRuntime();
  writeFileSync(path.join(root, ...LABEL_MAP_FILE.split('/')), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> other\n');
  return { root, runtime };
}

test('D-67: while the label file holds reads, a read of the Open-GSD runtime goes on and a project read stays held', async () => {
  const { root, runtime } = heldProjectAndRuntime();
  const ran = await run(root, [call('r1', 'Read', { file_path: path.join(runtime, 'workflow.md') })], testGateRuntime(), undefined, false, [runtime]);
  assert.match(ran.outputs[0] ?? '', /RUNTIME workflow steps/);
  const own = await run(root, [call('r2', 'Read', { file_path: 'notes.md' })], testGateRuntime(), undefined, false, [runtime]);
  assert.equal(own.outputs[0], `Not allowed: ${LABEL_MAP_UNREADABLE_TEXT}`);
});

test('D-67: while the label file holds reads, a link from the runtime folder into the project stays held', async () => {
  const { root, runtime } = heldProjectAndRuntime();
  const ran = await run(root, [call('r1', 'Read', { file_path: path.join(runtime, 'plan-link.md') })], testGateRuntime(), undefined, false, [runtime]);
  assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_UNREADABLE_TEXT}`);
  assert.ok(!ran.transcript.includes(SECRET));
});

test('D-67: a call that reads both the runtime and the project has its project part held, and a search shows the runtime results only', async () => {
  const { root, runtime } = heldProjectAndRuntime();
  const both = await labelVerdictFor(testGateRuntime(), { root, reads: ['notes.md'], defaultReads: true });
  assert.equal(both?.reason, LABEL_MAP_UNREADABLE_TEXT, 'the project part is held');
  assert.equal(await labelVerdictFor(testGateRuntime(), { root, reads: [], defaultReads: true }), undefined, 'the runtime part alone goes on');
  const command = await labelVerdictFor(testGateRuntime(), { root, reads: [], command: `cat ${path.join(runtime, 'workflow.md')} notes.md`, mayReadAnything: true });
  assert.equal(command?.reason, LABEL_MAP_UNREADABLE_TEXT, 'a command may read the project, so it stays held');
  const canRead = await labelReadFilter(testGateRuntime(), root);
  assert.equal(canRead(path.relative(root, path.join(runtime, 'workflow.md'))), true, 'a runtime result is shown');
  assert.equal(canRead(path.relative(root, path.join(runtime, 'plan-link.md'))), false, 'a runtime link into the project is hidden');
  assert.equal(canRead('notes.md'), false, 'a project result is hidden');
});

// ---- PR #85 review: shell globs, and every path field of a mixed call ----

test('a shell glob is checked against every labelled entry it could match: cat secret/*.md is refused when secret/plan.md is above the clearance', async () => {
  const root = project();
  for (const command of ['cat secret/*.md', 'cat secret/plan.m?', 'cat secret/{plan,other}.md', 'cat */plan.md', 'grep -r PLAN **/*.md', 'cat ./secret/*']) {
    const ran = await run(root, [call('b1', 'Bash', { command })]);
    assert.match(ran.outputs[0] ?? '', PB_REFUSAL, command);
    assert.ok(!ran.transcript.includes(SECRET), command);
  }
  // A glob that cannot reach the labelled file is not refused for it.
  const other = await run(root, [call('b2', 'Bash', { command: 'cat secret/*.txt notes.md' })], testGateRuntime(), undefined, true);
  assert.match(other.outputs[0] ?? '', /PLAN notes, public/);
  // A glob under a variable cannot be bounded, so the strictest label in the project decides.
  const unbounded = await labelVerdictFor(testGateRuntime(), { root, reads: [], command: 'cat "$DIR"/*.md', mayReadAnything: true });
  assert.equal(unbounded?.rule, 'label.dominance');
});

test('every path field of a call is checked, also when another field reads the Open-GSD runtime: a mixed read of a labelled project file is refused', async () => {
  const { runtime } = labelledProjectAndRuntime();
  const root = project();
  const twoFiles: AgentTool<{ a: string; b: string }> = {
    ...readTool,
    name: 'ReadTwo',
    parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
    // Field b is read and also written (an edit-in-place tool), so it is not a read-only field: the per-path check must still cover it.
    manifest: declareManifest({ tool: 'ReadTwo', effects: [{ verb: 'read', paths: [fromArgument('a'), fromArgument('b')] }, { verb: 'workspaceWrite', paths: [fromArgument('b')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
    manifestInput: undefined,
    parse: (raw: Record<string, unknown>) => ({ a: String(raw['a']), b: String(raw['b']) }),
    title: () => 'Read two',
    forbidden: undefined,
    sensitive: undefined,
    run: async () => 'ran'
  } as never;
  const gated = await gateToolCall(testGateRuntime(), {
    tool: twoFiles as never, raw: { a: path.join(runtime, 'workflow.md'), b: 'secret/plan.md' }, root, callId: 'm1', readOnlyRoots: [runtime],
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.equal(gated.decision.outcome, 'deny');
  assert.equal(gated.decision.rule, 'label.dominance');
  const runtimeOnly = await gateToolCall(testGateRuntime(), {
    tool: twoFiles as never, raw: { a: path.join(runtime, 'workflow.md'), b: 'notes.md' }, root, callId: 'm2', readOnlyRoots: [runtime],
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.notEqual(runtimeOnly.decision.rule, 'label.dominance', 'the runtime file and an unlabelled project file are not refused for a label');
});
