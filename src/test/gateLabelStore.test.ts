// The project's signed label map (CLAS-01, CLAS-02, CLAS-07, D-25, D-26, D-27, D-42, D-53, D-59): Set Label signs a label into
// .planning/.near-ai/labels.json, an agent cannot read what the person's clearance does not cover, a map nobody here signed only raises and is never signed
// again silently, an unreadable or rolled-back map holds reads, labels follow renames, and two writers take turns. Real files in temporary folders, an
// in-memory secret store and the recording vscode stub; no test reads the real home folder or makes a network call.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, readTool, writeTool } from '../agent/tools';
import { gateToolCall } from '../agent/gateAdapter';
import { RunGrants as Grants } from '../agent/permissions';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { PolicyBundle } from '../domain/gate/bundle';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { MAX_LABEL_MAP_BYTES, setLabelEntry } from '../domain/gate/labelMap';
import type { LabelMapPayload } from '../domain/gate/labelMap';
import { LABELS_NOT_ACCREDITATION_TEXT, SCALE_PRESETS, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import type { Clearance, Label } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { writeLastValid } from '../gate/clockMarker';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import { LABEL_MAP_FILE, LABEL_MAP_OTHER_REVISION_TEXT, LABEL_MARKER_SECRET_PREFIX, LABEL_MARKERS_DIR, USE_BRANCH_LABELS_ACTION, LABEL_MAP_ROLLED_BACK_TEXT, LABEL_MAP_UNREADABLE_TEXT, LABEL_MAP_UNVERIFIED_TEXT, LabelMapError, readLabelMarker, updateLabelMap } from '../gate/labelMapStore';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { createDeviceIdentity, identityDir, loadDeviceIdentity, loadOrCreateDeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { newTestRun } from './helpers/gatedRuns';
import { FileSecrets } from './helpers/keyHistoryChild';
import type { LabelChildReply, LabelChildStart } from './helpers/labelMapChild';
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
    await writeFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), `${JSON.stringify(signPayload(identity, 'policy-bundle', payload, { now: () => new Date(payload.issuedAt) }), null, 2)}\n`);
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
async function agentRun(s: Started, calls: ToolCall[], root = s.root, approve = false): Promise<{ outputs: string[]; transcript: string }> {
  const gate = await s.host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'labels', agentId: 'main' }, presence: 'person', context: 'interactive' });
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  const run = newTestRun({
    client: scripted(calls) as never, model: 'm', tools: [readTool, bashTool], gate,
    context: { root, checkpoints: new RunCheckpoints('labels'), shell, readFiles: new Set() },
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: approve ? 'allow' : 'deny' }), emit: (event) => events.push(event)
  });
  const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal).finally(() => shell.dispose());
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
  assert.match(ran.outputs[0] ?? '', /^Not allowed: This file is labelled Canada, Protected: Protected B, and your policy gives you no clearance on that scale\./);
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

test('Set Label refuses a label outside the person\'s clearance and names the Standing Orders action, writing nothing (D-27)', async () => {
  const s = await started();
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected B' }), false);
  const warned = stub.notifications.find((entry) => entry.level === 'warn');
  assert.match(warned?.message ?? '', /open SovAI: Standing Orders and choose Edit my Standing Orders/);
  assert.equal(existsSync(path.join(s.root, LABEL_MAP_FILE)), false);
});

test('the Set Label command is contributed with an Explorer menu entry, in the SovAI category', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command: string }>> } };
  const command = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.label.set');
  assert.deepEqual(command, { command: 'nearAi.label.set', title: 'Set Label', category: 'SovAI' });
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

// ---- Task 2: maps nobody here signed, unreadable and rolled-back maps, renames, limits and two writers ----

const INTERNAL = label('org', 'Internal');
const CONFIDENTIAL = label('org', 'Confidential');

/** The label a path resolves to now, through the host's reader under the policy in force. */
async function labelOf(s: Started, relative: string): Promise<string> {
  const policy = s.host.labelPolicy();
  const view = await s.host.labelsFor(s.root).view(policy.scales);
  return view.resolve(relative, policy.defaultLabel).mark.map((each) => `${each.scale}/${each.level}`).join('+');
}

async function stateOf(s: Started): Promise<string> {
  return (await s.host.labelsFor(s.root).view(s.host.labelPolicy().scales)).state;
}

/** Writes the project's map by hand: the envelope as it is, with its payload changed by `edit` (so the signature no longer matches). */
async function handEdit(s: Started, edit: (payload: Record<string, unknown> & { entries: Record<string, unknown> }) => void): Promise<void> {
  const file = path.join(s.root, LABEL_MAP_FILE);
  const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: Record<string, unknown> & { entries: Record<string, unknown> } };
  edit(envelope.payload);
  await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`);
}

/** A labelled project: secret/plan.md at Protected B (the person holds that clearance) and src/a.ts at Internal, both set through Set Label. */
async function labelled(): Promise<Started> {
  const s = await started({ clearances: [clearance('ca-protected', 'Protected B')] });
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected B' }), true);
  assert.equal(await setLabelVia(s.root, 'src/a.ts', { scale: 'org', level: 'Internal' }), true);
  return s;
}

test('a map changed by hand is unverified: a label it raises applies, one it lowers does not, and the person is told once per window', async () => {
  const s = await labelled();
  await handEdit(s, (payload) => {
    payload.entries['secret/plan.md'] = PA;
    payload.entries['notes.md'] = CONFIDENTIAL;
  });
  assert.equal(await stateOf(s), 'unverified');
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected B', 'the lowering did not apply');
  assert.equal(await labelOf(s, 'notes.md'), 'org/Confidential', 'the raise did');
  await stateOf(s);
  assert.equal(s.problems.filter((message) => message === LABEL_MAP_UNVERIFIED_TEXT).length, 1, 'told once');
});

test('a map signed by a key this computer does not know (a teammate\'s, before Phase 71) only raises too', async () => {
  const s = await labelled();
  const teammate = await createDeviceIdentity(new MemorySecrets());
  const file = path.join(s.root, LABEL_MAP_FILE);
  const theirs = JSON.parse(await readFile(file, 'utf8')) as { payload: LabelMapPayload };
  const payload = { ...theirs.payload, entries: { ...theirs.payload.entries, 'secret/plan.md': PA, 'notes.md': CONFIDENTIAL } };
  await writeFile(file, `${JSON.stringify(signPayload(teammate, 'label-map', payload), null, 2)}\n`);
  assert.equal(await stateOf(s), 'unverified');
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected B');
  assert.equal(await labelOf(s, 'notes.md'), 'org/Confidential');
});

test('a hand edit that deletes or lowers a verified label still resolves it from what this computer last verified (D-59)', async () => {
  const s = await labelled();
  await handEdit(s, (payload) => { delete payload.entries['secret/plan.md']; payload.entries['src/a.ts'] = label('org', 'Public'); });
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected B');
  assert.equal(await labelOf(s, 'src/a.ts'), 'org/Internal');
  // Under the person's own Protected B clearance the read is allowed; under the default policy (no such clearance) the deleted entry still refuses it.
  const allowed = await agentRun(s, [call('r1', 'Read', { file_path: 'secret/plan.md' })]);
  assert.match(allowed.outputs[0] ?? '', new RegExp(SECRET_TEXT), 'read under the person\'s own clearance');
  await s.host.reset();
  const refused = await agentRun(s, [call('r2', 'Read', { file_path: 'secret/plan.md' })]);
  assert.match(refused.outputs[0] ?? '', /^Not allowed: This file is labelled Canada, Protected: Protected B, and your policy gives you no clearance on that scale\./);
  assert.ok(!refused.transcript.includes(SECRET_TEXT), 'the hand edit did not drop the label');
});

test('Set Label on an unverified map asks before signing it again: Cancel leaves the bytes, Sign Again keeps the verified entries and only the raises', async () => {
  const s = await labelled();
  await handEdit(s, (payload) => {
    payload.entries['secret/plan.md'] = PA;
    payload.entries['notes.md'] = CONFIDENTIAL;
  });
  const file = path.join(s.root, LABEL_MAP_FILE);
  const before = await readFile(file, 'utf8');
  assert.equal(await setLabelVia(s.root, 'src/', { scale: 'org', level: 'Internal' }), false, 'dismissed');
  assert.equal(stub.messageOptions.at(-1)?.modal, true);
  assert.equal(await readFile(file, 'utf8'), before, 'Cancel wrote nothing');
  assert.equal(await setLabelVia(s.root, 'src/', { scale: 'org', level: 'Internal', confirm: gateCommands.SIGN_AGAIN_ACTION }), true);
  assert.equal(await mapVerifies(s), true);
  const payload = (JSON.parse(await readFile(file, 'utf8')) as { payload: LabelMapPayload }).payload;
  assert.equal(payload.entries['secret/plan.md']?.level, 'Protected B', 'the lowering was not kept');
  assert.equal(payload.entries['notes.md']?.level, 'Confidential', 'the raise was');
  assert.equal(payload.entries['src/']?.level, 'Internal', 'and the change itself');
  assert.equal(await stateOf(s), 'verified');
});

test('an automatic write never signs an unverified map: no confirm, nothing written, and a plain error', async () => {
  const s = await labelled();
  await handEdit(s, (payload) => { payload.entries['notes.md'] = CONFIDENTIAL; });
  const file = path.join(s.root, LABEL_MAP_FILE);
  const before = await readFile(file, 'utf8');
  await assert.rejects(() => s.host.changeLabels(s.root, (map) => map), (error: unknown) => error instanceof LabelMapError && /never signed again without you/.test(error.message));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('a map with a merge conflict is unreadable: every agent read in that project is refused with the sentence, and reads come back once it is fixed and signed again', async () => {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  const good = await readFile(file, 'utf8');
  await writeFile(file, `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> other\n`);
  assert.equal(await stateOf(s), 'unreadable');
  const ran = await agentRun(s, [call('r1', 'Read', { file_path: 'notes.md' })]);
  assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_UNREADABLE_TEXT}`);
  await writeFile(file, good);
  assert.equal(await stateOf(s), 'verified');
  const again = await agentRun(s, [call('r2', 'Read', { file_path: 'notes.md' })]);
  assert.match(again.outputs[0] ?? '', /public notes/);
});

test('D-59 deletion: a deleted map with a marker is rolled back, holds every read in the project, and Set Label signs the last verified labels again', async () => {
  const s = await labelled();
  await rm(path.join(s.root, LABEL_MAP_FILE));
  assert.equal(await stateOf(s), 'rolled-back');
  for (const target of ['secret/plan.md', 'notes.md']) {
    const ran = await agentRun(s, [call('r1', 'Read', { file_path: target })]);
    assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_ROLLED_BACK_TEXT}`);
  }
  assert.ok(s.problems.includes(LABEL_MAP_ROLLED_BACK_TEXT), 'the person is told, naming the fix');
  assert.equal(await setLabelVia(s.root, 'notes.md', { scale: 'org', level: 'Internal', confirm: gateCommands.SIGN_AGAIN_ACTION }), true);
  assert.equal(await stateOf(s), 'verified');
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected B', 'the restored map still holds Protected B');
  assert.equal(await labelOf(s, 'notes.md'), 'org/Internal');
});

test('D-59, D-61 replay: an older signed copy put back, or another map at the same revision, is another revision and holds reads', async () => {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  // Revision 2 holds secret/plan.md and src/a.ts; revision 3 adds notes.md; then revision 2 is put back.
  const second = await readFile(file, 'utf8');
  assert.equal(await setLabelVia(s.root, 'notes.md', { scale: 'org', level: 'Internal' }), true);
  await writeFile(file, second);
  assert.equal(await stateOf(s), 'other-revision', 'an older copy signed by this computer\'s own key');
  // The same revision as the marker with other contents, signed by this computer's own key.
  const marker = (await readLabelMarker(s.storage, s.secrets, s.root)).marker;
  assert.ok(marker !== undefined);
  const identity = await loadDeviceIdentity(s.secrets);
  assert.ok(identity !== undefined);
  const forged = { labelMapVersion: 1, vocabulary: 1, entries: {}, revision: marker.revision } as LabelMapPayload;
  await writeFile(file, `${JSON.stringify(signPayload(identity, 'label-map', forged), null, 2)}\n`);
  assert.equal(await stateOf(s), 'other-revision', 'same revision, another hash');
  const ran = await agentRun(s, [call('r1', 'Read', { file_path: 'secret/plan.md' })]);
  assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_OTHER_REVISION_TEXT}`);
});

test('D-59 removal on purpose: Set Label\'s Remove choice signs a removal that names the key, the marker moves, and the file reads at the default label', async () => {
  const s = await labelled();
  assert.equal(await setLabelVia(s.root, 'src/a.ts', { scale: gateCommands.REMOVE_LABEL_ITEM, reason: 'No longer internal.' }), true);
  const payload = (JSON.parse(await readFile(path.join(s.root, LABEL_MAP_FILE), 'utf8')) as { payload: LabelMapPayload }).payload;
  assert.deepEqual(payload.removed, ['src/a.ts']);
  assert.equal(payload.revision, 3);
  assert.equal((await readLabelMarker(s.storage, s.secrets, s.root)).marker?.revision, 3);
  assert.equal(await stateOf(s), 'verified');
  assert.equal(await labelOf(s, 'src/a.ts'), 'org/Public');
  const records = await projectRecords(s);
  assert.ok(records.some((record) => ruleOf(record) === 'label.set' && record.status_detail === 'No longer internal.'), 'the removal and its reason are on record');
  // A newer map signed by this computer's key that drops a key without naming it is another revision (D-61), never verified.
  const identity = await loadDeviceIdentity(s.secrets);
  assert.ok(identity !== undefined);
  const dropped = { ...payload, revision: 4, entries: {} } as LabelMapPayload;
  delete (dropped as { removed?: unknown }).removed;
  await writeFile(path.join(s.root, LABEL_MAP_FILE), `${JSON.stringify(signPayload(identity, 'label-map', dropped), null, 2)}\n`);
  assert.equal(await stateOf(s), 'other-revision');
});

test('VS Code renames move the entry, and a renamed folder moves its whole subtree', async () => {
  const s = await labelled();
  await mkdir(path.join(s.root, 'lib'));
  await rename(path.join(s.root, 'src', 'a.ts'), path.join(s.root, 'lib', 'a.ts'));
  await stub.fireRename([{ from: path.join(s.root, 'src', 'a.ts'), to: path.join(s.root, 'lib', 'a.ts') }]);
  assert.equal(await labelOf(s, 'lib/a.ts'), 'org/Internal');
  assert.equal(await labelOf(s, 'src/a.ts'), 'org/Public');
  await rename(path.join(s.root, 'secret'), path.join(s.root, 'private'));
  await stub.fireRename([{ from: path.join(s.root, 'secret'), to: path.join(s.root, 'private') }]);
  assert.equal(await labelOf(s, 'private/plan.md'), 'ca-protected/Protected B');
  assert.equal(await stateOf(s), 'verified');
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: root } });
}

test('an agent\'s successful mv, git mv and git -C . mv -- move the entry; a failed one, or one with several sources, does not', async () => {
  for (const command of ['mv src/a.ts lib/a.ts', 'git mv src/a.ts lib/a.ts', 'git -C . mv -- src/a.ts lib/a.ts']) {
    const s = await labelled();
    await mkdir(path.join(s.root, 'lib'));
    git(s.root, 'init', '-q');
    git(s.root, 'add', '-A');
    git(s.root, '-c', 'user.email=test@example.org', '-c', 'user.name=test', 'commit', '-qm', 'init');
    await agentRun(s, [call('b1', 'Bash', { command })], s.root, true);
    assert.ok(existsSync(path.join(s.root, 'lib', 'a.ts')), `${command} ran`);
    assert.equal(await labelOf(s, 'lib/a.ts'), 'org/Internal', command);
    assert.equal(await stateOf(s), 'verified', command);
  }
  const s = await labelled();
  await agentRun(s, [call('b2', 'Bash', { command: 'mv src/a.ts nowhere/a.ts' })], s.root, true);
  assert.equal(await labelOf(s, 'src/a.ts'), 'org/Internal', 'a failed mv moves nothing');
  await mkdir(path.join(s.root, 'lib'));
  await writeFile(path.join(s.root, 'b.ts'), 'b\n');
  await agentRun(s, [call('b3', 'Bash', { command: 'mv src/a.ts b.ts lib/' })], s.root, true);
  assert.ok(existsSync(path.join(s.root, 'lib', 'a.ts')));
  assert.equal(await labelOf(s, 'lib/a.ts'), 'org/Public', 'several sources are not followed');
  assert.equal(await labelOf(s, 'src/a.ts'), 'org/Internal', 'the old entry stays for the missing-path report');
});

test('entries whose path is gone are reported once and stay in the map', async () => {
  const s = await labelled();
  await rm(path.join(s.root, 'src', 'a.ts'));
  s.host.labelsFor(s.root).invalidate();
  await stateOf(s);
  await stateOf(s);
  const reported = s.problems.filter((message) => message.includes('no longer exist'));
  assert.equal(reported.length, 1);
  assert.match(reported[0] ?? '', /src\/a\.ts/);
  const payload = (JSON.parse(await readFile(path.join(s.root, LABEL_MAP_FILE), 'utf8')) as { payload: LabelMapPayload }).payload;
  assert.ok(payload.entries['src/a.ts'] !== undefined, 'kept');
});

test('a write past MAX_LABEL_MAP_BYTES and a path the signer would refuse as secret-like are refused with plain messages, writing nothing', async () => {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  const before = await readFile(file, 'utf8');
  const many = (map: LabelMapPayload): LabelMapPayload => {
    let out = map;
    for (let index = 0; index < Math.ceil(MAX_LABEL_MAP_BYTES / 100) + 10; index += 1) out = setLabelEntry(out, `bulk/file-${String(index).padStart(6, '0')}-with-a-long-name-to-fill-space.txt`, INTERNAL);
    return out;
  };
  await assert.rejects(() => s.host.changeLabels(s.root, many), (error: unknown) => error instanceof LabelMapError && /byte limit/.test(error.message));
  const secretLike = 'keys/sk-abcdefghijklmnop.txt';
  await assert.rejects(() => s.host.changeLabels(s.root, (map) => setLabelEntry(map, secretLike, INTERNAL)), (error: unknown) => error instanceof LabelMapError && error.message.includes(secretLike));
  assert.equal(await readFile(file, 'utf8'), before);
});

interface Writer { child: ChildProcess; ready: Promise<void>; done: Promise<LabelChildReply & { type: 'done' }> }

function startWriter(start: LabelChildStart): Writer {
  const child = fork(path.join(__dirname, 'helpers', 'labelMapChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: LabelChildReply) => { if (message.type === 'ready') resolve(); });
    child.on('exit', (code) => { reject(new Error(`the writer exited with ${String(code)} before it was ready: ${stderr}`)); });
  });
  const done = new Promise<LabelChildReply & { type: 'done' }>((resolve, reject) => {
    child.on('message', (message: LabelChildReply) => { if (message.type === 'done') resolve(message); });
    child.on('exit', (code) => { reject(new Error(`the writer exited with ${String(code)} without an answer: ${stderr}`)); });
  });
  ready.catch(() => undefined);
  done.catch(() => undefined);
  child.send(start);
  return { child, ready, done };
}

test('two writers (two processes) raising different entries at once both land, and the map verifies', async () => {
  const storage = await mkdtemp(path.join(TEMP, 'near-ai-labels-race-'));
  const root = await project();
  const secretsFile = path.join(storage, 'secrets.json');
  const secrets = new FileSecrets(secretsFile);
  await loadOrCreateDeviceIdentity(secrets, { identityDir: identityDir(storage) });
  await updateLabelMap(root, (map) => map, { globalStorageDir: storage, secrets, scales: SCALE_PRESETS, defaultLabel: SHIPPED_DEFAULT_LABEL });
  const writers = [startWriter({ type: 'start', globalStorageDir: storage, secretsFile, root, key: 'notes.md', label: INTERNAL }), startWriter({ type: 'start', globalStorageDir: storage, secretsFile, root, key: 'src/a.ts', label: CONFIDENTIAL })];
  let results: Array<LabelChildReply & { type: 'done' }>;
  try {
    await Promise.all(writers.map((writer) => writer.ready));
    for (const writer of writers) writer.child.send({ type: 'go' });
    results = await Promise.all(writers.map((writer) => writer.done));
  } finally {
    for (const writer of writers) writer.child.kill();
  }
  for (const result of results) assert.equal(result.ok, true, result.message);
  const envelope: unknown = JSON.parse(await readFile(path.join(root, LABEL_MAP_FILE), 'utf8'));
  const verdict = verifyPayload<LabelMapPayload>(envelope, { purpose: 'label-map', status: await localKeyStatus(identityDir(storage), secrets) });
  assert.ok(verdict.ok);
  if (verdict.ok) {
    assert.equal(verdict.payload.entries['notes.md']?.level, 'Internal');
    assert.equal(verdict.payload.entries['src/a.ts']?.level, 'Confidential');
    assert.equal(verdict.payload.revision, 3);
  }
});

test('an agent\'s Write to the label file is a floor ask in every mode: only the extension\'s own writer signs it (D-25, D-44)', async () => {
  const s = await labelled();
  const runtime = await s.host.runtimeFor({ root: s.root, actor: { kind: 'agent', sessionId: 'w' }, presence: 'person', context: 'interactive' });
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    const raw = { file_path: LABEL_MAP_FILE, content: '{}' };
    const gated = await gateToolCall(runtime, { tool: writeTool, raw, root: s.root, callId: `w-${mode}`, policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants: new Grants(), buildAuto: async () => undefined });
    assert.equal(gated.decision.outcome, 'ask', mode);
    assert.equal(gated.decision.rule, 'floor.protected-write', mode);
    assert.equal(gated.decision.offerAlwaysAllow, false, mode);
  }
});

// ---- D-61: a branch's own signed labels are held, and accepted with one click ----

/** A labelled project whose file is then put back to an earlier signed revision, the way checking out an older branch does. */
async function switchedBranch(): Promise<{ s: Started; older: string }> {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  const older = await readFile(file, 'utf8');
  assert.equal(await setLabelVia(s.root, 'notes.md', { scale: 'org', level: 'Internal' }), true);
  await writeFile(file, older);
  return { s, older };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('D-61 branch switch: an older signed label file holds every agent read with one plain message and one button', async () => {
  const { s } = await switchedBranch();
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  assert.equal(await stateOf(s), 'other-revision');
  await settle();
  const shown = stub.notifications.findIndex((entry) => entry.message === LABEL_MAP_OTHER_REVISION_TEXT);
  assert.ok(shown >= 0, 'the person is told');
  assert.deepEqual(stub.notificationActions[shown], [USE_BRANCH_LABELS_ACTION], 'with one button');
  for (const target of ['secret/plan.md', 'notes.md']) {
    const ran = await agentRun(s, [call('r1', 'Read', { file_path: target })]);
    assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_OTHER_REVISION_TEXT}`);
  }
});

test('D-61 accept: "Use this branch\'s labels" signs that revision as current above the marker, moves the marker and records label.branch-accepted', async () => {
  const { s } = await switchedBranch();
  const before = (await readLabelMarker(s.storage, s.secrets, s.root)).marker;
  assert.ok(before !== undefined);
  stub.messageAnswers.length = 0;
  stub.messageAnswers.push(USE_BRANCH_LABELS_ACTION);
  assert.equal(await stateOf(s), 'other-revision');
  await settle();
  for (let index = 0; index < 100 && await stateOf(s) !== 'verified'; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await stateOf(s), 'verified');
  const after = (await readLabelMarker(s.storage, s.secrets, s.root)).marker;
  assert.ok(after !== undefined && after.revision === before.revision + 1, 'a revision above the marker');
  assert.equal(await labelOf(s, 'notes.md'), 'org/Public', 'this branch\'s labels: notes.md was labelled only on the other one');
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected B');
  assert.equal(await mapVerifies(s), true);
  const records = await projectRecords(s);
  assert.ok(records.some((record) => ruleOf(record) === 'label.branch-accepted'), 'the accept is on record');
  assert.match(await (await agentRun(s, [call('r1', 'Read', { file_path: 'notes.md' })])).outputs[0] ?? '', /public notes/);
});

test('D-61 decline: dismissing the message changes nothing, and reads stay held', async () => {
  const { s, older } = await switchedBranch();
  stub.messageAnswers.length = 0;
  assert.equal(await stateOf(s), 'other-revision');
  await settle();
  assert.equal(await readFile(path.join(s.root, LABEL_MAP_FILE), 'utf8'), older, 'the file is untouched');
  assert.equal(await stateOf(s), 'other-revision');
  assert.equal(await s.host.acceptBranchLabels(s.root).then(() => stateOf(s)), 'verified', 'accepting later still works');
});

test('D-61 deletion: a deleted label file holds reads with no accept button, offering git restore or signing again by hand', async () => {
  const s = await labelled();
  stub.notifications.length = 0;
  await rm(path.join(s.root, LABEL_MAP_FILE));
  assert.equal(await stateOf(s), 'rolled-back');
  await settle();
  assert.equal(stub.notifications.some((entry) => entry.message === LABEL_MAP_ROLLED_BACK_TEXT), false, 'no message with a button');
  assert.ok(s.problems.includes(LABEL_MAP_ROLLED_BACK_TEXT), 'the plain message');
  assert.match(LABEL_MAP_ROLLED_BACK_TEXT, /git restore/);
  assert.equal(await s.host.acceptBranchLabels(s.root), false, 'there is nothing to accept');
  assert.equal(await stateOf(s), 'rolled-back');
});

// ---- D-62: the marker lives in SecretStorage ----

test('D-62: the marker is kept in SecretStorage, so deleting the files on disk does not erase it', async () => {
  const s = await labelled();
  const key = `${LABEL_MARKER_SECRET_PREFIX}${projectLogKey(s.root)}`;
  const stored = await s.secrets.get(key);
  assert.ok(stored !== undefined && /"revision":2/.test(stored), 'the marker is in SecretStorage');
  assert.ok(!stored.includes(s.root) && !stored.includes('secret/plan.md'), 'with no path in it');
  // Delete every label file this extension keeps on disk, and the project's own.
  await rm(path.join(s.storage, 'gate', LABEL_MARKERS_DIR), { recursive: true, force: true });
  await rm(path.join(s.root, LABEL_MAP_FILE));
  s.host.labelsFor(s.root).invalidate();
  assert.equal(await stateOf(s), 'rolled-back', 'still known as deleted');
  const ran = await agentRun(s, [call('r1', 'Read', { file_path: 'secret/plan.md' })]);
  assert.equal(ran.outputs[0], `Not allowed: ${LABEL_MAP_ROLLED_BACK_TEXT}`);
});

test('D-62: with the base copy gone, the verified file still reads, but a hand-edited one holds reads (a lowering could not be told apart)', async () => {
  const s = await labelled();
  await rm(path.join(s.storage, 'gate', LABEL_MARKERS_DIR), { recursive: true, force: true });
  s.host.labelsFor(s.root).invalidate();
  assert.equal(await stateOf(s), 'verified');
  await handEdit(s, (payload) => { delete payload.entries['secret/plan.md']; });
  assert.equal(await stateOf(s), 'rolled-back');
  await assert.rejects(() => s.host.changeLabels(s.root, (map) => map, async () => true), (error: unknown) => error instanceof LabelMapError && /git restore/.test(error.message));
});

test('D-62 migration: a marker an earlier build kept in the storage folder moves into SecretStorage once', async () => {
  const s = await labelled();
  const key = `${LABEL_MARKER_SECRET_PREFIX}${projectLogKey(s.root)}`;
  const kept = await s.secrets.get(key);
  assert.ok(kept !== undefined);
  await s.secrets.delete(key);
  const held = await readLabelMarker(s.storage, s.secrets, s.root);
  assert.equal(held.marker?.revision, 2, 'read from the storage folder');
  assert.ok(held.base !== undefined);
  assert.equal(await s.secrets.get(key), kept, 'and written to SecretStorage');
});

// ---- D-64: defaults ----

test('D-64: LABEL_EVENT_IDS names label.branch-accepted and label.declassify-rejected, and Set Label says plainly that nothing can be labelled under a broken policy', async () => {
  const { LABEL_EVENT_IDS } = await import('../domain/gate/labels');
  assert.ok(LABEL_EVENT_IDS.includes('label.branch-accepted' as never));
  assert.ok(LABEL_EVENT_IDS.includes('label.declassify-rejected' as never));
  const s = await started();
  await writeFile(path.join(gateDir(s.storage), POLICY_BUNDLE_FILE), '{}');
  const broken = gateCommands.registerGate(createFakeContext(s.storage, s.secrets) as never, { notify: () => undefined });
  assert.equal((await broken.state()).state, 'failed-closed');
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'org', level: 'Internal' }), false);
  assert.ok(stub.notifications.some((entry) => entry.message === gateCommands.NO_LABELS_WHILE_FAILED_TEXT));
  assert.match(gateCommands.NO_LABELS_WHILE_FAILED_TEXT, /^Nothing can be labelled while your Standing Orders cannot be trusted/);
  assert.equal(existsSync(path.join(s.root, LABEL_MAP_FILE)), false);
});

// ---- PR #85 review: the removed list is bounded, and the writer never writes a map the parser refuses ----

test('withRevision takes up to MAX_REMOVED_KEYS removed keys and refuses more, and a map under the byte limit can never drop more than that in one write', async () => {
  const { MAX_REMOVED_KEYS, parseLabelMap, withRevision } = await import('../domain/gate/labelMap');
  const empty = { labelMapVersion: 1, vocabulary: 1, entries: {} } as LabelMapPayload;
  const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `f/${String(index)}`);
  const atCap = withRevision(empty, 2, keys(MAX_REMOVED_KEYS));
  assert.equal(parseLabelMap(JSON.parse(JSON.stringify(atCap)), SCALE_PRESETS).ok, true, 'at the cap the parser accepts it');
  assert.throws(() => withRevision(empty, 2, keys(MAX_REMOVED_KEYS + 1)), /at most/);
  // The smallest entry (a one-letter path at org/Public) is about 90 bytes, so the byte limit holds far fewer entries than the removed cap.
  const smallest = Buffer.byteLength(JSON.stringify({ a: label('org', 'Public') }), 'utf8') - 2;
  assert.ok(Math.floor(MAX_LABEL_MAP_BYTES / smallest) < MAX_REMOVED_KEYS);
});

test('a change that would give a map the parser refuses is refused before signing, writing nothing, so Set Label can always read back what it wrote', async () => {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  const before = await readFile(file, 'utf8');
  const broken = (map: LabelMapPayload): LabelMapPayload => ({ ...map, entries: { ...map.entries, './not/canonical': label('org', 'Internal') } });
  await assert.rejects(() => s.host.changeLabels(s.root, broken), (error: unknown) => error instanceof LabelMapError && /^Nothing was written/.test(error.message));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await stateOf(s), 'verified');
});

// ---- PR #85 final review carry-overs (fixed in 4c) ----

test('PR #85 carry-over 1: over a deleted label file, Set Label judges a lowering against the labels it restores and asks for a reason', async () => {
  const s = await labelled();
  await rm(path.join(s.root, LABEL_MAP_FILE));
  assert.equal(await stateOf(s), 'rolled-back');
  // The view reads every path at the default label while the file is gone; restoring writes Protected B back, so Protected A lowers it.
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected A', confirm: gateCommands.SIGN_AGAIN_ACTION }), false, 'no reason given, nothing changed');
  assert.equal(await stateOf(s), 'rolled-back');
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected A', reason: 'reviewed: Protected A is right', confirm: gateCommands.SIGN_AGAIN_ACTION }), true);
  assert.equal(await labelOf(s, 'secret/plan.md'), 'ca-protected/Protected A');
  const set = (await projectRecords(s)).filter((record) => ruleOf(record) === 'label.set').at(-1);
  assert.ok(JSON.stringify(set).includes('reviewed: Protected A is right'), 'the reason is on record');
});

test('PR #85 carry-over 1: over another branch\'s label file, Set Label asks for a reason before a lowering', async () => {
  const { s } = await switchedBranch();
  assert.equal(await stateOf(s), 'other-revision');
  assert.equal(await setLabelVia(s.root, 'secret/plan.md', { scale: 'ca-protected', level: 'Protected A', confirm: USE_BRANCH_LABELS_ACTION }), false, 'no reason given, nothing changed');
  assert.equal(await stateOf(s), 'other-revision');
});

test('PR #85 carry-over 2: when the label file changes between the check and the write, acceptBranchLabels writes nothing and records no accept', async () => {
  const s = await labelled();
  const file = path.join(s.root, LABEL_MAP_FILE);
  const older = await readFile(file, 'utf8');
  assert.equal(await setLabelVia(s.root, 'notes.md', { scale: 'org', level: 'Internal' }), true);
  const newer = await readFile(file, 'utf8');
  await writeFile(file, older);
  assert.equal(await stateOf(s), 'other-revision');
  const reader = s.host.labelsFor(s.root);
  const view = reader.view.bind(reader);
  let raced = false;
  reader.view = async (scales) => {
    const seen = await view(scales);
    // Another window (or git) puts the current file back right after the check.
    if (!raced && seen.state === 'other-revision') { raced = true; await writeFile(file, newer); reader.invalidate(); }
    return seen;
  };
  const before = (await readLabelMarker(s.storage, s.secrets, s.root)).marker;
  assert.equal(await s.host.acceptBranchLabels(s.root), false, 'nothing was accepted');
  assert.ok(raced);
  assert.equal(await readFile(file, 'utf8'), newer, 'the file is as the other writer left it');
  assert.equal((await readLabelMarker(s.storage, s.secrets, s.root)).marker?.revision, before?.revision, 'the marker did not move');
  assert.equal((await projectRecords(s)).some((record) => ruleOf(record) === 'label.branch-accepted'), false, 'no accept on record');
});
