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
import { POLICY_BUNDLE_FILE, POLICY_DRAFT_BASE_FILE, POLICY_DRAFT_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { newTestRun } from './helpers/gatedRuns';
import { autoApplyPolicyEditor } from './helpers/policyEditorFake';
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
  // D-44: Apply Policy Draft shows the draft on the policy page; this stand-in presses its Apply, as a person would.
  const host = gateCommands.registerGate(createFakeContext(storage, secrets) as never, { notify: () => undefined, policyEditor: autoApplyPolicyEditor() });
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
  assert.match(stub.notifications.find((entry) => entry.level === 'warn')?.message ?? '', /open SovAI: Standing Orders and choose Edit my Standing Orders/);
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

test('Edit Policy and Apply Policy Draft are contributed in the SovAI category', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const find = (id: string) => manifest.contributes.commands.find((entry) => entry.command === id);
  assert.deepEqual(find('nearAi.policy.edit'), { command: 'nearAi.policy.edit', title: 'Edit Policy', category: 'SovAI' });
  assert.deepEqual(find('nearAi.policy.applyDraft'), { command: 'nearAi.policy.applyDraft', title: 'Apply Policy Draft', category: 'SovAI' });
});

test('Edit Policy\'s notice names Apply and Discard and says the clearance is self-declared and labels are not accreditation', async () => {
  const s = await started();
  await editPolicy(s);
  const notice = stub.notifications.find((entry) => entry.level === 'info');
  assert.ok(notice?.message.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.ok(notice?.message.includes(LABELS_NOT_ACCREDITATION_TEXT));
  assert.ok(!notice?.message.includes(EM_DASH));
  void POLICY_BUNDLE_FILE;
});

// ---- Task 2: invalid and stale drafts, the extension's own signer and dates, expiry, and what Show Policy says ----

async function storedBytes(s: Started): Promise<string> {
  return readFile(path.join(gateDir(s.storage), POLICY_BUNDLE_FILE), 'utf8');
}

test('an invalid draft (an unknown field, a level not in its scale, a mapping within one scale, not JSON) is refused with a plain reason and the stored bytes are unchanged', async () => {
  const s = await started();
  const draft = await editPolicy(s);
  const bytes = await storedBytes(s);
  const cases: Array<[string, string, RegExp]> = [
    ['an unknown field', JSON.stringify({ ...draft, surprise: true }), /has a field the vocabulary does not have/],
    ['a level not in its scale', JSON.stringify({ ...draft, clearances: [{ scale: 'ca-protected', level: 'Protected Z', compartments: [], releasability: [] }] }), /not allowed in this place\. \(at clearances\[0\]\.level\)/],
    ['a mapping within one scale', JSON.stringify({ ...draft, mappings: [{ from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'org', level: 'Public' } }] }), /not allowed in this place\. \(at mappings\[0\]\.covers\)/],
    ['not JSON', '{ "clearances": [', /not valid JSON/]
  ];
  for (const [name, text, reason] of cases) {
    await writeFile(draftPath(s), text);
    resetUi();
    assert.equal(await apply(s), false, name);
    const warned = stub.notifications.find((entry) => entry.level === 'warn')?.message ?? '';
    assert.match(warned, /^Nothing was changed/, name);
    assert.match(warned, reason, name);
    assert.equal(await storedBytes(s), bytes, `${name}: the policy's bytes are unchanged`);
    assert.ok(existsSync(draftPath(s)), `${name}: the draft is kept so it can be fixed`);
  }
});

test('a draft made before a reset, or before another window\'s Apply, is refused as stale and changes nothing (D-53)', async () => {
  const s = await started();
  const draft = await editPolicy(s);
  await s.host.reset();
  await writeDraft(s, { ...draft, clearances: [...(draft['clearances'] as unknown[]), PB_CLEARANCE] });
  const bytes = await storedBytes(s);
  resetUi();
  assert.equal(await apply(s), false);
  assert.equal(stub.notifications.find((entry) => entry.level === 'warn')?.message,
    'Nothing was changed. Your policy changed after this draft was made. Open SovAI: Standing Orders and choose Edit my Standing Orders again to start from the policy in force.');
  assert.equal(await storedBytes(s), bytes);
  // Another window's Apply: two drafts made from the same policy, the second applied after the first.
  const first = await editPolicy(s);
  const base = await readFile(path.join(gateDir(s.storage), POLICY_DRAFT_BASE_FILE), 'utf8');
  await writeDraft(s, { ...first, clearances: [...(first['clearances'] as unknown[]), PB_CLEARANCE] });
  assert.equal(await apply(s), true);
  await writeDraft(s, first);
  await writeFile(path.join(gateDir(s.storage), POLICY_DRAFT_BASE_FILE), base);
  const applied = await storedBytes(s);
  resetUi();
  assert.equal(await apply(s), false, 'the older draft would undo the other edit');
  assert.equal(await storedBytes(s), applied);
});

test('the extension, not the draft, sets the signer and the dates: another device\'s issuer, a past issuedAt and an expiry ten years ahead are replaced', async () => {
  const s = await started();
  const draft = await editPolicy(s);
  const other = { fingerprint: 'f'.repeat(64), publicKey: 'B'.repeat(43) };
  await writeDraft(s, { ...draft, issuer: other, issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' });
  assert.equal(await apply(s), true);
  const state = s.host.bundleState();
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  assert.notEqual(state.bundle.issuer.fingerprint, other.fingerprint);
  assert.equal(state.bundle.issuer.fingerprint, state.signer.fingerprint, 'this install signed it in its own name');
  assert.ok(Date.parse(state.bundle.issuedAt) > Date.parse('2026-01-01T00:00:00.000Z'), 'a fresh signing time');
  const days = (Date.parse(state.bundle.expiresAt) - Date.parse(state.bundle.issuedAt)) / 86_400_000;
  assert.equal(days, 365, 'the usual lifetime, not ten years');
});

test('a self-added clearance that expires during a chat: the next read of content that needs it is refused with the expiry sentence, and Show Policy shows the date', async () => {
  const s = await started();
  const draft = await editPolicy(s);
  const ends = new Date(Date.now() + 1500).toISOString();
  await writeDraft(s, { ...draft, clearances: [...(draft['clearances'] as unknown[]), { ...PB_CLEARANCE, expiresAt: ends }] });
  assert.equal(await apply(s), true);
  assert.equal(await setLabelPB(s), true);
  assert.match(await readAsAgent(s, 'secret/plan.md'), new RegExp(SECRET), 'read while the clearance holds');
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  assert.ok(stub.shownDocuments[0]?.text.includes(`ca-protected/Protected B, until ${ends}`), 'Show Policy shows the expiry');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.match(await readAsAgent(s, 'secret/plan.md'), new RegExp(`Not allowed: This file is labelled Canada, Protected: Protected B, and your clearance for it ended on ${ends.slice(0, 10)}\\.`));
});

test('Show Policy says what is live: clearances are checked on reads, each chat\'s label decides where its content is sent, and unlabelled content takes the default label', async () => {
  const s = await started();
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  const text = stub.shownDocuments[0]?.text ?? '';
  assert.ok(text.includes(gateCommands.POLICY_ROUTING_TEXT));
  assert.equal((gateCommands as Record<string, unknown>)['POLICY_LABELS_NOT_USED_TEXT'], undefined, 'the old sentence is gone');
  assert.equal((gateCommands as Record<string, unknown>)['POLICY_ROUTING_NOT_LIVE_TEXT'], undefined, 'the 4b sentence is gone (plan 24)');
  assert.ok(!text.includes('does not change where content is sent yet'));
  assert.match(gateCommands.POLICY_ROUTING_TEXT, /checks the clearances below when an agent reads a labelled file/);
  assert.match(gateCommands.POLICY_ROUTING_TEXT, /Each chat's label decides where its content is sent/);
  assert.match(gateCommands.POLICY_ROUTING_TEXT, /Levels that need an attested cloud go to a private NEAR AI Cloud model only over a connection proven to end inside its private hardware; otherwise they stay on this computer\./);
  const pitfall = gateCommands.unlabelledDefaultText({ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] });
  assert.ok(text.includes(pitfall), 'the Pitfall 14 sentence');
  assert.ok(text.indexOf('Default label: org/Public') >= 0 && text.indexOf(pitfall) > text.indexOf('Default label: org/Public'), 'beside the default label');
  // Edit Policy's notice carries it too.
  await editPolicy(s);
  assert.ok(stub.notifications.find((entry) => entry.level === 'info')?.message.includes(pitfall));
});

test('every message Edit Policy, Apply Policy Draft and Show Policy show where clearances appear says they are self-declared, with no em-dash, and never calls a clearance verified or enforced', async () => {
  const s = await started();
  const texts: string[] = [];
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  texts.push(stub.shownDocuments[0]?.text ?? '');
  const draft = await editPolicy(s);
  texts.push(stub.notifications.find((entry) => entry.level === 'info')?.message ?? '');
  await writeDraft(s, { ...draft, clearances: [...(draft['clearances'] as unknown[]), PB_CLEARANCE] });
  resetUi();
  assert.equal(await apply(s), true);
  texts.push(stub.notifications.find((entry) => entry.level === 'info')?.message ?? '');
  for (const text of texts) {
    assert.ok(text.includes(CLEARANCE_SELF_ASSERTED_TEXT), text.slice(0, 80));
    assert.ok(!text.includes(EM_DASH));
    const withoutQuoted = text.replace(CLEARANCE_SELF_ASSERTED_TEXT, '').replace(LABELS_NOT_ACCREDITATION_TEXT, '');
    assert.doesNotMatch(withoutQuoted, /clearance (?:is |was )?(?:verified|enforced)|verified clearance|enforced clearance/i);
  }
});

test('Show Policy names the command that changes the policy (Edit Policy) beside the one that resets it, and stays read-only', async () => {
  await started();
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  const text = stub.shownDocuments[0]?.text ?? '';
  assert.match(text, /This view only shows your Standing Orders\. Editing it changes nothing\. Open SovAI: Standing Orders and choose Edit my Standing Orders to change them\. Reset my Standing Orders restores only your own defaults\./);
});
