// Edit Policy and Apply Policy Draft (D-12, D-27, D-41, D-53, CLAS-02, CLAS-03, CLAS-07, GATE-07): a person changes their own policy through an unsigned
// draft in this extension's storage, which the extension validates, signs, records and applies through the host; a stale or invalid draft changes
// nothing; the extension owns the signer and the dates; and every screen that shows a clearance says it is self-declared. Real files in temporary folders,
// an in-memory secret store and the recording vscode stub. No test reads the real home folder or makes a network call.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { readTool } from '../agent/tools';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { POLICY_BUNDLE_FILE, POLICY_DRAFT_BASE_FILE, POLICY_DRAFT_FILE, STALE_DRAFT_TEXT, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { newTestRun } from './helpers/gatedRuns';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

const TEMP = realpathSync(tmpdir());
const SECRET = 'THE PROTECTED B PLAN';
const EM_DASH = String.fromCharCode(0x2014);
const PB_CLEARANCE = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [] };

interface Started { host: GateHost; storage: string; secrets: MemorySecrets; root: string; changes: number[] }

async function started(): Promise<Started> {
  const storage = await mkdtemp(path.join(TEMP, 'near-ai-policy-edit-storage-'));
  const root = await mkdtemp(path.join(TEMP, 'near-ai-policy-edit-project-'));
  await mkdir(path.join(root, 'secret'));
  await writeFile(path.join(root, 'secret', 'plan.md'), `${SECRET}\n`);
  stub.setWorkspaceFolders([root]);
  const secrets = new MemorySecrets();
  const host = gateCommands.registerGate(createFakeContext(storage, secrets) as never, { notify: () => undefined });
  await host.state();
  const changes = [0];
  host.onDidChange(() => { changes[0] = (changes[0] ?? 0) + 1; });
  return { host, storage, secrets, root, changes };
}

function resetUi(): void {
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.inputAnswers.length = 0;
  stub.messageAnswers.length = 0;
  stub.notifications.length = 0;
  stub.shownDocuments.length = 0;
}

async function setLabelPB(s: Started): Promise<unknown> {
  resetUi();
  stub.quickPickAnswers.push('ca-protected', 'Protected B', []);
  stub.inputAnswers.push('');
  return stub.commands.get(gateCommands.SET_LABEL_COMMAND)?.({ fsPath: path.join(s.root, 'secret', 'plan.md') });
}

const draftPath = (s: Started): string => path.join(gateDir(s.storage), POLICY_DRAFT_FILE);

/** Runs Edit Policy (dismissing its notice) and returns the draft as an object. */
async function editPolicy(s: Started): Promise<Record<string, unknown>> {
  resetUi();
  const opened = await stub.commands.get(gateCommands.EDIT_POLICY_COMMAND)?.();
  assert.equal(opened, draftPath(s));
  return JSON.parse(await readFile(draftPath(s), 'utf8')) as Record<string, unknown>;
}

async function writeDraft(s: Started, draft: Record<string, unknown>): Promise<void> {
  await writeFile(draftPath(s), JSON.stringify(draft, null, 2));
}

async function apply(s: Started): Promise<unknown> {
  return stub.commands.get(gateCommands.APPLY_POLICY_DRAFT_COMMAND)?.();
}

async function installRecords(s: Started): Promise<DecisionRecord[]> {
  await s.host.flush();
  const file = path.join(s.storage, 'gate', DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`);
  return existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord) : [];
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

async function readAsAgent(s: Started, file: string): Promise<string> {
  const gate = await s.host.runtimeFor({ root: s.root, actor: { kind: 'agent', sessionId: 'edit' }, presence: 'person', context: 'interactive' });
  const events: AgentEvent[] = [];
  const shell = new ShellSession(s.root);
  const run = newTestRun({
    client: scripted([{ id: 'r1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } }]) as never, model: 'm', tools: [readTool], gate,
    context: { root: s.root, checkpoints: new RunCheckpoints('edit'), shell, readFiles: new Set() },
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'deny' }), emit: (event) => events.push(event)
  });
  await run.run([{ role: 'user', content: 'go' }], new AbortController().signal).finally(() => shell.dispose());
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output).join('\n');
}

// ---- Task 1: the tracer ----

test('tracer: a person adds a Protected B clearance through Edit Policy and Apply Policy Draft, and Set Label then accepts that label', async () => {
  const s = await started();
  assert.equal(await setLabelPB(s), false, 'refused before the clearance exists');
  assert.match(stub.notifications.find((entry) => entry.level === 'warn')?.message ?? '', /NEAR AI: Edit Policy first/);
  const before = s.host.bundleState();
  assert.equal(before.state, 'valid');
  const draft = await editPolicy(s);
  // The draft and the hash it was made from are in this extension's storage, never the project.
  assert.ok(draftPath(s).startsWith(`${s.storage}${path.sep}`));
  assert.equal((await readFile(path.join(gateDir(s.storage), POLICY_DRAFT_BASE_FILE), 'utf8')).trim(), before.state === 'valid' ? before.hash : '');
  assert.equal(existsSync(path.join(s.root, POLICY_DRAFT_FILE)), false);
  assert.equal(stub.shownDocuments.length, 1, 'the draft is opened');
  await writeDraft(s, { ...draft, clearances: [...(draft['clearances'] as unknown[]), PB_CLEARANCE] });
  const changesBefore = s.changes[0];
  assert.equal(await apply(s), true);
  assert.equal(s.changes[0], (changesBefore ?? 0) + 1, 'the host told its listeners once');
  const after = s.host.bundleState();
  assert.equal(after.state, 'valid');
  const edit = (await installRecords(s)).find((record) => record.api.operation === 'policy.edit');
  assert.ok(edit !== undefined, 'policy.edit is recorded');
  if (before.state === 'valid' && after.state === 'valid') {
    assert.notEqual(before.hash, after.hash);
    assert.equal(edit.status_detail, `The policy changed from ${before.hash} to ${after.hash}.`);
  }
  assert.equal(existsSync(draftPath(s)), false, 'the draft is removed once applied');
  assert.equal(await setLabelPB(s), true, 'Set Label accepts the label now');
  assert.match(await readAsAgent(s, 'secret/plan.md'), new RegExp(SECRET), 'and an agent under that policy reads it');
});

test('Edit Policy and Apply Policy Draft are contributed in the NEAR AI category', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const find = (id: string) => manifest.contributes.commands.find((entry) => entry.command === id);
  assert.deepEqual(find('nearAi.policy.edit'), { command: 'nearAi.policy.edit', title: 'Edit Policy', category: 'NEAR AI' });
  assert.deepEqual(find('nearAi.policy.applyDraft'), { command: 'nearAi.policy.applyDraft', title: 'Apply Policy Draft', category: 'NEAR AI' });
});

test('Edit Policy\'s notice names Apply and Discard and says the clearance is self-declared and labels are not accreditation', async () => {
  const s = await started();
  await editPolicy(s);
  const notice = stub.notifications.find((entry) => entry.level === 'info');
  assert.ok(notice?.message.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.ok(notice?.message.includes(LABELS_NOT_ACCREDITATION_TEXT));
  assert.ok(!notice?.message.includes(EM_DASH));
  void STALE_DRAFT_TEXT;
  void POLICY_BUNDLE_FILE;
});
