// The project's signed label map (CLAS-01, CLAS-02, CLAS-07, D-25, D-26, D-27, D-42, D-53, D-59): Set Label signs a label into
// .planning/.near-ai/labels.json, an agent cannot read what the person's clearance does not cover, a map nobody here signed only raises and is never signed
// again silently, an unreadable or rolled-back map holds reads, labels follow renames, and two writers take turns. Real files in temporary folders, an
// in-memory secret store and the recording vscode stub; no test reads the real home folder or makes a network call.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, readTool } from '../agent/tools';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { PolicyBundle } from '../domain/gate/bundle';
import { LABELS_NOT_ACCREDITATION_TEXT, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import type { Clearance, Label } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { writeLastValid } from '../gate/clockMarker';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import { LABEL_MAP_FILE } from '../gate/labelMapStore';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { identityDir, loadDeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { newTestRun } from './helpers/gatedRuns';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

const TEMP = realpathSync(tmpdir());
const SECRET_TEXT = 'THE PROTECTED B PLAN';

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}
const PB = label('ca-protected', 'Protected B');
const PA = label('ca-protected', 'Protected A');

function clearance(scale: string, level: string): Clearance {
  return { scale, level, compartments: [], releasability: [] };
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(TEMP, 'near-ai-labels-project-'));
  await mkdir(path.join(root, 'secret'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'secret', 'plan.md'), `${SECRET_TEXT}\n`);
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'notes.md'), 'public notes\n');
  return root;
}

interface Started { host: GateHost; storage: string; secrets: MemorySecrets; root: string; problems: string[] }

/** A gate started on temporary storage for a project, the folder open in the stub; with `clearances`, its policy is the default plus those clearances. */
async function started(options: { clearances?: Clearance[]; root?: string; storage?: string; secrets?: MemorySecrets } = {}): Promise<Started> {
  const storage = options.storage ?? await mkdtemp(path.join(TEMP, 'near-ai-labels-storage-'));
  const secrets = options.secrets ?? new MemorySecrets();
  const root = options.root ?? await project();
  stub.setWorkspaceFolders([root]);
  const problems: string[] = [];
  let host = gateCommands.registerGate(createFakeContext(storage, secrets) as never, { notify: (message) => problems.push(message) });
  await host.state();
  if (options.clearances !== undefined) {
    // A policy this install signed itself, with the extra clearances, accepted as the last valid one (the way Apply Policy Draft will make one).
    const identity = await loadDeviceIdentity(secrets);
    assert.ok(identity !== undefined);
    const base = defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: Date.now() });
    const payload: PolicyBundle = { ...base, clearances: [...base.clearances, ...options.clearances].sort((a, b) => (`${a.scale}/${a.level}` < `${b.scale}/${b.level}` ? -1 : 1)) };
    await writeFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), `${JSON.stringify(signPayload(identity, 'policy-bundle', payload), null, 2)}\n`);
    await writeLastValid(secrets, { at: Date.now(), hash: bundleHash(payload) });
    host = gateCommands.registerGate(createFakeContext(storage, secrets) as never, { notify: (message) => problems.push(message) });
    const state = await host.state();
    assert.equal(state.state, 'valid', JSON.stringify(state));
  }
  return { host, storage, secrets, root, problems };
}

function resetUi(): void {
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.inputAnswers.length = 0;
  stub.messageAnswers.length = 0;
  stub.notifications.length = 0;
}

/** Runs Set Label on a path of the project with the given answers: scale, level, compartments, handling, then any reason and confirm. */
async function setLabelVia(root: string, relative: string, answers: { scale: string; level?: string; compartments?: string; handling?: string[]; reason?: string; confirm?: string }): Promise<unknown> {
  resetUi();
  stub.quickPickAnswers.push(answers.scale);
  if (answers.level !== undefined) stub.quickPickAnswers.push(answers.level, answers.handling ?? []);
  if (answers.level !== undefined) stub.inputAnswers.push(answers.compartments ?? '');
  if (answers.reason !== undefined) stub.inputAnswers.push(answers.reason);
  if (answers.confirm !== undefined) stub.messageAnswers.push(answers.confirm);
  const target = relative === '' ? undefined : { fsPath: path.join(root, ...relative.replace(/\/$/, '').split('/')) };
  return stub.commands.get(gateCommands.SET_LABEL_COMMAND)?.(target);
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function scripted(calls: ToolCall[]): { streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> } {
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

/** An agent run in the project under the host's runtime: the tool outputs, and the whole transcript as text. */
async function agentRun(s: Started, calls: ToolCall[], root = s.root): Promise<{ outputs: string[]; transcript: string }> {
  const gate = await s.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'labels', agentId: 'main' }, presence: 'person', context: 'interactive' });
  const events: AgentEvent[] = [];
  const run = newTestRun({
    client: scripted(calls) as never, model: 'm', tools: [readTool, bashTool], gate,
    context: { root, checkpoints: new RunCheckpoints('labels'), shell: new ShellSession(root), readFiles: new Set() },
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: 'deny' }), emit: (event) => events.push(event)
  });
  const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
  const outputs = events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);
  return { outputs, transcript: JSON.stringify(result.messages) };
}

async function projectRecords(s: Started, root = s.root): Promise<DecisionRecord[]> {
  await s.host.flush();
  const file = path.join(s.storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

const ruleOf = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';

async function mapVerifies(s: Started, root = s.root): Promise<boolean> {
  const envelope: unknown = JSON.parse(await readFile(path.join(root, LABEL_MAP_FILE), 'utf8'));
  return verifyPayload(envelope, { purpose: 'label-map', status: await localKeyStatus(identityDir(s.storage), s.secrets) }).ok;
}

// ---- Task 1: the tracer ----

test('tracer: Set Label marks a file Protected B in a signed map, and an agent\'s Read of it is refused because the person holds no such clearance', async () => {
  const s = await started({ clearances: [clearance('ca-protected', 'Protected B')] });
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected B' }), true);
  // CLAS-07 and CLAS-02: the not-accreditation words come before the first pick, and the scale caveat sits beside the Canadian and NATO scales.
  assert.equal(stub.quickPickRequests[0]?.placeHolder, LABELS_NOT_ACCREDITATION_TEXT);
  const caveated = stub.quickPickRequests[0]?.items.filter((item) => item.detail === SCALE_PRESETS_CAVEAT_TEXT).map((item) => item.label).sort();
  assert.deepEqual(caveated, ['ca-classified', 'ca-protected', 'nato']);
  assert.equal(await mapVerifies(s), true, 'the label file is signed under label-map with this computer\'s key');
  // The person's policy goes back to the default, which holds no clearance on the Canadian scale.
  await s.host.reset();
  const ran = await agentRun(s, [call('r1', 'Read', { file_path: 'secret/plan.md' })]);
  assert.match(ran.outputs[0] ?? '', /^Not allowed: This file is labelled ca-protected\/Protected B, and your policy gives you no clearance on that scale\./);
  assert.ok(!ran.transcript.includes(SECRET_TEXT), 'the file\'s content never reached the transcript');
  const records = await projectRecords(s);
  assert.equal(records.filter((record) => ruleOf(record) === 'label.set').length, 1, 'one label.set record');
  const refused = records.find((record) => ruleOf(record) === 'label.dominance');
  assert.ok(refused !== undefined, 'the refusal is on record');
  assert.equal(refused.unmapped.nearAi.label?.level, 'Protected B');
  // An unlabelled file in the same project is still read.
  const plain = await agentRun(s, [call('r2', 'Read', { file_path: 'notes.md' })]);
  assert.match(plain.outputs[0] ?? '', /public notes/);
});

test('CLAS-07 on a fresh install with no label anywhere: Set Label\'s first pick shows the not-accreditation words, and dismissing it changes nothing', async () => {
  const s = await started();
  assert.equal(await setLabelVia(s.root, '', { scale: '' }), false);
  assert.equal(stub.quickPickRequests[0]?.placeHolder, LABELS_NOT_ACCREDITATION_TEXT);
  assert.equal(existsSync(path.join(s.root, LABEL_MAP_FILE)), false);
});

test('Set Label refuses a label the person\'s own clearance does not cover and names Edit Policy, writing nothing (D-27)', async () => {
  const s = await started();
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected B' }), false);
  const warned = stub.notifications.find((entry) => entry.level === 'warn');
  assert.match(warned?.message ?? '', /NEAR AI: Edit Policy first/);
  assert.equal(existsSync(path.join(s.root, LABEL_MAP_FILE)), false);
});

test('the Set Label command is contributed with an Explorer menu entry, in the NEAR AI category', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command: string }>> } };
  const command = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.label.set');
  assert.deepEqual(command, { command: 'nearAi.label.set', title: 'Set Label', category: 'NEAR AI' });
  assert.ok(manifest.contributes.menus['explorer/context']?.some((entry) => entry.command === 'nearAi.label.set'));
});

test('every runtime the host gives has a label reader, one per folder, and its records stay on known rules', async () => {
  const s = await started();
  const other = await project();
  const runtime = await s.host.runtimeFor({ root: s.root, actor: { kind: 'agent', sessionId: 'x' }, presence: 'person', context: 'interactive' });
  assert.ok(runtime.labels !== undefined);
  assert.equal(runtime.labels(s.root), s.host.labelsFor(s.root), 'the host keeps one reader per project');
  assert.notEqual(runtime.labels(other), runtime.labels(s.root), 'a worktree or another folder has its own');
  const noFolder = await s.host.runtimeFor({ actor: { kind: 'agent', sessionId: 'y' }, presence: 'person', context: 'interactive' });
  assert.ok(noFolder.labels !== undefined);
});
