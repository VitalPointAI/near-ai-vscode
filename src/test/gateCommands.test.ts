// What the person sees of the policy (OFFL-02, OFFL-03, D-13, D-23, D-27, D-33, D-41): the status bar item and its plain words for every state, the read-only
// Show Policy view, the confirmed and recorded Reset Policy to Defaults, and the Policy step in the setup view. Runs with the recording vscode stub.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload, failedClosed, parseBundle } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY, projectLogKey } from '../gate/decisionLog';
import { SessionMark } from '../domain/gate/dominance';
import { GateHost } from '../gate/host';
import { NO_SECRET_STORAGE_TEXT } from '../gate/organizationStore';
import type { SecretStorageLike } from '../services/auth';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const setupSteps = require('../services/setupSteps') as typeof import('../services/setupSteps');
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
const gateStatusBar = require('../services/gateStatusBar') as typeof import('../services/gateStatusBar');
test.after(() => { uninstall(); });

const EM_DASH = '—';
const DAY = 24 * 60 * 60 * 1000;

async function started(secrets = new MemorySecrets(), storage?: string): Promise<{ host: ReturnType<typeof gateCommands.registerGate>; storage: string; secrets: MemorySecrets; state: BundleState }> {
  const dir = storage ?? await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-'));
  const host = gateCommands.registerGate(createFakeContext(dir, secrets) as never, { notify: () => undefined });
  const state = await host.state();
  return { host, storage: dir, secrets, state };
}

function barFor(index: number): (typeof stub.statusBarItems)[number] {
  return stub.statusBarItems[index] as (typeof stub.statusBarItems)[number];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 1: the status bar and Show Policy

function validState(overrides: Partial<Extract<BundleState, { state: 'valid' }>> = {}): BundleState {
  return {
    state: 'valid', bundle: {} as never, hash: 'h'.repeat(64), signer: { fingerprint: 'fp', publicKey: 'pk' } as never,
    expiresAt: '2027-03-04T05:06:07.000Z', renewDue: false, ...overrides
  };
}

test('gateStatusText: valid shows "Policy" with the expiry date in the tooltip and no warning', () => {
  const shown = gateStatusBar.gateStatusText(validState(), Date.parse('2026-11-16T00:00:00.000Z'));
  assert.equal(shown.text, 'Policy');
  assert.match(shown.tooltip, /Your policy is signed and valid until 2027-03-04\./);
  assert.equal(shown.warning, false);
});

test('gateStatusText: a policy in its last days reads "renewing" and does not warn', () => {
  const shown = gateStatusBar.gateStatusText(validState({ renewDue: true }), Date.parse('2027-02-20T00:00:00.000Z'));
  assert.equal(shown.text, 'Policy: renewing');
  assert.match(shown.tooltip, /valid until 2027-03-04/);
  assert.equal(shown.warning, false);
});

test('gateStatusText: failed closed reads "reading only", carries the bundle\'s own sentence as it is, and warns, for every reason', () => {
  for (const reason of Object.keys(BUNDLE_FAILURES) as Array<keyof typeof BUNDLE_FAILURES>) {
    const shown = gateStatusBar.gateStatusText(failedClosed(reason), 0);
    assert.equal(shown.text, 'Policy: reading only');
    assert.ok(shown.tooltip.includes(BUNDLE_FAILURES[reason]), reason);
    assert.equal(shown.warning, true);
    assert.ok(!shown.tooltip.includes(EM_DASH));
  }
});

test('gateStatusText: a state that says valid but has passed its end reads as expired, and a check that has not finished reads "checking"', () => {
  const late = gateStatusBar.gateStatusText(validState(), Date.parse('2027-03-04T05:06:07.000Z'));
  assert.equal(late.warning, true);
  assert.ok(late.tooltip.includes(BUNDLE_FAILURES.expired));
  const waiting = gateStatusBar.gateStatusText(undefined, 0);
  assert.equal(waiting.text, 'Policy: checking');
  assert.equal(waiting.warning, false);
});

test('registerGate creates the status bar item nearAi.gate with its command, and shows "Policy" for a fresh install', async () => {
  const before = stub.statusBarItems.length;
  stub.setWorkspaceFolders([]);
  await started();
  const items = stub.statusBarItems.slice(before).filter((item) => item.id === 'nearAi.gate');
  assert.equal(items.length, 1);
  const item = items[0] as (typeof items)[number];
  assert.equal(item.name, 'SovAI Policy');
  assert.equal(item.command, 'nearAi.policy.show');
  assert.equal(item.priority, 49);
  assert.equal(item.visible, true);
  assert.equal(item.text, 'Policy');
  assert.equal(item.backgroundColor, undefined);
});

test('a policy file that was changed shows "Policy: reading only" with the bundle\'s sentence and the warning background', async () => {
  const first = await started();
  const file = path.join(gateDir(first.storage), POLICY_BUNDLE_FILE);
  const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.replace('"Restricted"', '"Restricteb"'), 'utf8');
  const before = stub.statusBarItems.length;
  const second = await started(first.secrets, first.storage);
  assert.equal(second.state.state, 'failed-closed');
  const item = barFor(before);
  assert.equal(item.id, 'nearAi.gate');
  assert.equal(item.text, 'Policy: reading only');
  assert.ok(item.tooltip.includes(BUNDLE_FAILURES['bad-signature']));
  assert.equal((item.backgroundColor as { id: string }).id, 'statusBarItem.warningBackground');
});

test('Governance shows the failed trust check when rules are unavailable', async (t) => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-no-secrets-'));
  const { Uri, window } = stub.vscode as typeof import('vscode');
  type PanelState = { notice?: string; sections: unknown[]; actions: unknown[]; pageActions: unknown[] };
  const posted: PanelState[] = [];
  let close: (() => void) | undefined;
  let closeWindow = async (): Promise<void> => undefined;
  Object.assign(Uri, { joinPath: (base: { fsPath: string }, ...parts: string[]) => Uri.file(path.join(base.fsPath, ...parts)) });
  Object.assign(window, { createWebviewPanel: (_type: string, title: string) => ({
    title,
    webview: {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (message: PanelState) => { posted.push(message); return true; },
      onDidReceiveMessage: () => undefined
    },
    onDidChangeViewState: () => undefined,
    onDidDispose: (listener: () => void) => { close = listener; },
    dispose: () => { close?.(); }
  }) });
  t.after(async () => {
    await closeWindow();
    Reflect.deleteProperty(Uri, 'joinPath');
    Reflect.deleteProperty(window, 'createWebviewPanel');
  });
  const open = async (secrets: SecretStorageLike) => {
    await closeWindow();
    posted.length = 0;
    const context = { ...createFakeContext(storage, secrets), extensionUri: Uri.file(storage) };
    const host = gateCommands.registerGate(context as never, { notify: () => undefined });
    closeWindow = async () => {
      for (const item of context.subscriptions) item.dispose();
      await host.flush();
    };
    await stub.commands.get(gateCommands.OPEN_POLICY_COMMAND)?.();
    const panel = posted.at(-1);
    assert.ok(panel, 'the installed Governance command posted to the real Policy Editor');
    return { host, panel };
  };

  const bundle = path.join(gateDir(storage), POLICY_BUNDLE_FILE);
  const refused = () => Promise.reject(new Error('This workbench has no secret store.'));
  let storeAttempts = 0;
  const unavailable = await open({ get: refused, store: () => { storeAttempts += 1; return refused(); }, delete: refused });
  const state = unavailable.host.bundleState();
  assert.equal(state.state, 'failed-closed');
  assert.equal(state.state === 'failed-closed' && state.sentence, NO_SECRET_STORAGE_TEXT);
  assert.equal(unavailable.host.policyLayers().effective, undefined);
  assert.deepEqual([unavailable.panel.sections, unavailable.panel.actions, unavailable.panel.pageActions], [[], [], []]);
  await assert.rejects(unavailable.host.reset(), /could not use its signing key/);
  assert.equal(storeAttempts, 0);
  assert.equal(existsSync(bundle), false);

  const secrets = new MemorySecrets();
  const ready = await open(secrets);
  assert.equal(ready.host.bundleState().state, 'valid');
  assert.ok(ready.panel.sections.length > 0);
  assert.equal(ready.panel.notice, undefined);

  const tampered = (await readFile(bundle, 'utf8')).replace('"Restricted"', '"Restricteb"');
  await writeFile(bundle, tampered);
  const invalid = await open(secrets);
  assert.equal(invalid.host.bundleState().state, 'failed-closed');
  assert.deepEqual([invalid.panel.sections, invalid.panel.actions, invalid.panel.pageActions], [[], [], []]);
  assert.equal(await readFile(bundle, 'utf8'), tampered);
  assert.equal(unavailable.panel.notice, `${NO_SECRET_STORAGE_TEXT} Ask your administrator to set up a secret store, then reopen the workbench.`);
  assert.equal(invalid.panel.notice, BUNDLE_FAILURES['bad-signature']);
});

test('Show Policy opens a read-only document with the hash, the self-declared clearance text, the scales caveat and the "what is live" line above the scales, clearances and routing', async () => {
  const { storage, state } = await started();
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  const filesBefore = (await readdir(gateDir(storage))).sort();
  const bytesBefore = await readFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), 'utf8');
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  assert.equal(stub.shownDocuments.length, 1);
  const shown = stub.shownDocuments[0] as { uri: string; text: string };
  assert.ok(shown.uri.startsWith('near-ai-policy:'));
  const text = shown.text;
  assert.ok(text.includes(state.hash), 'the bundle hash');
  assert.ok(text.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.ok(text.includes(SCALE_PRESETS_CAVEAT_TEXT));
  assert.ok(text.includes(gateCommands.POLICY_ROUTING_TEXT));
  // PR 4c (plan 24): the clearances are checked on reads, and each chat's label decides where its content is sent.
  assert.match(gateCommands.POLICY_ROUTING_TEXT, /checks the clearances below when an agent reads a labelled file/);
  assert.match(gateCommands.POLICY_ROUTING_TEXT, /Each chat's label decides where its content is sent/);
  assert.doesNotMatch(gateCommands.POLICY_ROUTING_TEXT, /does not use the scales and clearances/);
  assert.ok(text.includes(state.bundle.issuer.fingerprint), 'the issuer');
  assert.ok(text.includes(state.expiresAt), 'the expiry');
  assert.ok(text.includes('"bundleVersion": 1'), 'the pretty-printed payload');
  assert.ok(text.includes('anchorRoots') && text.includes('statusLists') && text.includes('maxOfflineAge'), 'the reserved fields');
  const notUsed = text.indexOf(gateCommands.POLICY_ROUTING_TEXT);
  for (const heading of ['\nScales\n', '\nClearances\n', '\nRouting tiers']) {
    const at = text.indexOf(heading);
    assert.ok(at > notUsed, `${heading.trim()} comes after the "not used yet" line`);
  }
  assert.ok(text.indexOf('"scales"') > notUsed, 'the JSON copy of the scales also comes after the line');
  assert.ok(text.indexOf(CLEARANCE_SELF_ASSERTED_TEXT) < text.indexOf('\nRouting tiers'), 'the clearance text sits with the clearances');
  assert.ok(text.includes(gateCommands.unlabelledDefaultText(state.bundle.defaultLabel)), 'the unlabelled-content sentence arrived with plan 21, when clearance checks went live');
  assert.ok(!text.includes(EM_DASH));
  assert.doesNotMatch(text, /NEAR organization/);
  // Looking changes nothing: the file and its folder are as they were.
  assert.equal(await readFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), 'utf8'), bytesBefore);
  assert.deepEqual((await readdir(gateDir(storage))).sort(), filesBefore);
});

test('Show Policy for a policy that failed shows the sentence, says only reading and planning run, and holds no policy JSON', async () => {
  const first = await started();
  const file = path.join(gateDir(first.storage), POLICY_BUNDLE_FILE);
  await writeFile(file, (await readFile(file, 'utf8')).replace('"Restricted"', '"Restricteb"'), 'utf8');
  await started(first.secrets, first.storage);
  stub.shownDocuments.length = 0;
  await stub.commands.get(gateCommands.SHOW_POLICY_AS_STORED_COMMAND)?.();
  const text = (stub.shownDocuments[0] as { text: string }).text;
  assert.ok(text.includes(BUNDLE_FAILURES['bad-signature']));
  assert.match(text, /only reading and planning/);
  assert.ok(!text.includes('bundleVersion'));
});

test('policyDocumentText for a policy that failed is exactly the title, the note, the state line and the sentence, with no blank line after the sentence', () => {
  const sentence = BUNDLE_FAILURES['bad-signature'];
  const expected = [
    'Your SovAI policy',
    '',
    'This view only shows your policy. Editing it changes nothing. To change the policy file itself, open SovAI: Policy and choose Reset my rules, which resets your own rules only.',
    '',
    'State: not usable, so only reading and planning are allowed',
    sentence
  ].join('\n');
  assert.equal(gateCommands.policyDocumentText(failedClosed('bad-signature'), 0), expected);
  // A state that carries no sentence adds no line at all, not an empty one.
  const silent = { ...failedClosed('bad-signature'), sentence: '' };
  assert.equal(gateCommands.policyDocumentText(silent, 0), expected.slice(0, expected.length - sentence.length - 1));
  assert.ok(!gateCommands.policyDocumentText(silent, 0).endsWith('\n'));
});

test('S6: Show Policy for a policy written for a newer version says to update and never offers Reset; other failures still name Reset', () => {
  for (const reason of ['needs-update', 'unknown-field', 'unsupported-version', 'vocabulary-unknown'] as const) {
    const text = gateCommands.policyDocumentText(failedClosed(reason), 0);
    assert.match(text, /update the extension/i, reason);
    assert.ok(!/Reset my rules/.test(text), reason);
    assert.match(text, /State: not usable, so only reading and planning are allowed/);
  }
  assert.match(gateCommands.policyDocumentText(failedClosed('expired'), 0), /Reset my rules/);
});

test('S6 (PR #143 review): an unknown setting in the person\'s own policy names both ways on, update or Reset with what it discards; another signer\'s never offers Reset', () => {
  const own = gateCommands.policyDocumentText({ ...failedClosed('unknown-field'), ownPolicy: true }, 0);
  assert.match(own, /If a newer version of SovAI wrote it, update the extension/);
  assert.match(own, /Reset my rules in SovAI: Policy signs a fresh default policy for your own rules only and keeps the old file beside it; every change you made to the policy is discarded/);
  const other = gateCommands.policyDocumentText(failedClosed('unknown-field'), 0);
  assert.match(other, /update the extension/);
  assert.ok(!/Reset my rules/.test(other));
  // A policy written for a newer version is never offered Reset, even the person's own.
  assert.ok(!/Reset my rules/.test(gateCommands.policyDocumentText({ ...failedClosed('needs-update'), ownPolicy: true }, 0)));
});

test('policyDocumentText lists each MCP server\'s label ceiling, and says when none is set (WP-GATE)', () => {
  const issuer = { fingerprint: 'device-test', publicKey: 'A'.repeat(43) };
  const stateFor = (ceilings: unknown): BundleState => {
    const payload = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer, now: Date.now() }))) as Record<string, any>;
    if (ceilings !== undefined) payload.ceiling.mcpLabelCeilings = ceilings;
    const parsed = parseBundle(payload);
    assert.ok(parsed.ok);
    if (!parsed.ok) throw new Error('unreachable');
    return { state: 'valid', bundle: parsed.value, hash: bundleHash(parsed.value), signer: issuer, expiresAt: parsed.value.expiresAt, renewDue: false };
  };
  assert.match(gateCommands.policyDocumentText(stateFor(undefined), Date.now()), /\n  Highest label each add-on server may receive: none set, so no server is limited by label\n/);
  const set = gateCommands.policyDocumentText(stateFor({
    partner: { scale: 'org', level: 'Internal', compartments: ['ALPHA'], releasability: ['CAN'], expiresAt: '2030-01-01T00:00:00.000Z' },
    helper: { scale: 'nato', level: 'NATO Unclassified', compartments: [], releasability: [] }
  }), Date.now());
  assert.match(set, /\n  Highest label each add-on server may receive \(a call from a chat above it is refused\):\n {4}helper: nato\/NATO Unclassified\n {4}partner: org\/Internal \(compartments ALPHA; releasable to CAN; until 2030-01-01T00:00:00\.000Z\)\n/);
  assert.equal(set.includes(String.fromCharCode(0x2014)), false);
});

test('policyDocumentText is pure: the same state gives the same text, and a check that has not finished says so', () => {
  assert.equal(gateCommands.policyDocumentText(failedClosed('missing'), 0), gateCommands.policyDocumentText(failedClosed('missing'), 99));
  assert.match(gateCommands.policyDocumentText(undefined, 0), /checking your policy file/);
});

test('the commands are contributed in package.json with the SovAI category', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const show = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.policy.show');
  assert.deepEqual([show?.title, show?.category], ['Show Policy', 'SovAI']);
  assert.equal(existsSync(path.join(__dirname, '..', '..', 'package.json')), true);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: Reset Policy to Defaults and the Policy setup step

async function recordsOf(storage: string, root: string): Promise<DecisionRecord[]> {
  const file = path.join(storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

async function installRecordsOf(storage: string): Promise<DecisionRecord[]> {
  const file = path.join(storage, 'gate', DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

async function tampered(root?: string): Promise<{ host: ReturnType<typeof gateCommands.registerGate>; storage: string; file: string; bytes: string; secrets: MemorySecrets }> {
  stub.setWorkspaceFolders(root === undefined ? [] : [root]);
  const first = await started();
  const file = path.join(gateDir(first.storage), POLICY_BUNDLE_FILE);
  const bytes = (await readFile(file, 'utf8')).replace('"Restricted"', '"Restricteb"');
  await writeFile(file, bytes, 'utf8');
  const second = await started(first.secrets, first.storage);
  assert.equal(second.state.state, 'failed-closed');
  return { host: second.host, storage: first.storage, file, bytes, secrets: first.secrets };
}

function resetNotifications(): void {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.messageAnswers.length = 0;
}

test('Reset Policy to Defaults is a modal that says what happens, and a confirm signs a fresh default, keeps the old file and records policy.reset', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  const { host, storage, file, bytes } = await tampered(root);
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  // The first message is the modal; its text is the plain-words warning and it has one confirm button.
  assert.equal(stub.notifications[0]?.message, gateCommands.RESET_TITLE);
  const asked = stub.notificationActions[0] as unknown[];
  assert.deepEqual(asked[0], { modal: true, detail: gateCommands.RESET_DETAIL });
  assert.deepEqual(asked.slice(1), [gateCommands.RESET_CONFIRM_ACTION]);
  assert.match(gateCommands.RESET_DETAIL, /Your current file is kept beside it/);
  assert.match(gateCommands.RESET_DETAIL, /up to what your settings allow/);
  assert.ok(!gateCommands.RESET_DETAIL.includes(EM_DASH));
  assert.deepEqual(stub.notifications.slice(1).map((entry) => [entry.level, entry.message]), [['info', gateCommands.RESET_DONE_TEXT]]);
  // A fresh default is signed and valid, and the old file is kept beside it with the same bytes.
  assert.equal(host.bundleState().state, 'valid');
  const kept = readdirSync(gateDir(storage)).filter((name) => name.startsWith(`${POLICY_BUNDLE_FILE}.replaced-`));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(path.join(gateDir(storage), kept[0] as string), 'utf8'), bytes);
  assert.notEqual(await readFile(file, 'utf8'), bytes);
  // The record names the event, and the status bar and the Policy step follow.
  await host.flush();
  const records = await recordsOf(storage, root);
  const reset = records.filter((record) => record.api.operation === 'policy.reset');
  assert.equal(reset.length, 1);
  assert.equal(reset[0]?.authorizations[0]?.policy.name, 'policy.reset');
  assert.equal(records.filter((record) => record.api.operation === 'policy.load').length, 1, 'the failed start was recorded too');
  const bar = stub.statusBarItems.filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  assert.equal(bar.text, 'Policy');
});

test('Reset with no folder open records policy.reset in the install-level log, and the start is on that record too', async () => {
  const { host, storage } = await tampered();
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  assert.equal(host.bundleState().state, 'valid');
  await host.flush();
  const records = await installRecordsOf(storage);
  const operations = records.map((record) => record.api.operation);
  assert.deepEqual(operations, ['policy.created', 'policy.load', 'policy.reset'], 'in the order they happened');
  assert.equal(records.filter((record) => record.api.operation === 'policy.reset').length, 1);
  assert.equal(records.find((record) => record.api.operation === 'policy.reset')?.authorizations[0]?.policy.name, 'policy.reset');
  assert.ok(records.some((record) => record.api.operation === 'policy.load' && record.authorizations[0]?.policy.name === 'bundle.failed-closed'), 'the failed start was recorded too');
  const folder = readdirSync(path.join(gateDir(storage), DECISIONS_DIR));
  assert.deepEqual(folder, [`${INSTALL_LOG_KEY}.jsonl`], 'no project log exists, because no project was open');
});

test('Reset with a folder open records policy.reset in the install-level log and in that project\'s log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  const { host, storage } = await tampered(root);
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  await host.flush();
  for (const records of [await installRecordsOf(storage), await recordsOf(storage, root)]) {
    assert.equal(records.filter((record) => record.api.operation === 'policy.reset').length, 1);
    assert.equal(records.filter((record) => record.api.operation === 'policy.load').length, 1);
  }
});

test('cancelling Reset Policy to Defaults changes nothing: the file keeps its bytes, nothing is kept beside it, nothing is recorded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  const { host, storage, file, bytes } = await tampered(root);
  await host.flush();
  const recordsBefore = (await recordsOf(storage, root)).length;
  const filesBefore = readdirSync(gateDir(storage)).sort();
  for (const answer of [undefined, 'Not now']) {
    resetNotifications();
    stub.messageAnswers.push(answer);
    await stub.commands.get('nearAi.policy.reset')?.();
    assert.equal(stub.notifications.length, 1, 'only the modal was shown');
  }
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.deepEqual(readdirSync(gateDir(storage)).sort(), filesBefore);
  assert.equal(host.bundleState().state, 'failed-closed');
  await host.flush();
  assert.equal((await recordsOf(storage, root)).length, recordsBefore);
});

test('a reset that cannot finish shows the plain message of the store error and leaves the policy as it was', async () => {
  stub.setWorkspaceFolders([]);
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-'));
  let broken = false;
  const now = (): Date => (broken ? new Date(Number.NaN) : new Date());
  const host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: () => undefined, now });
  assert.equal((await host.state()).state, 'valid');
  const file = path.join(gateDir(storage), POLICY_BUNDLE_FILE);
  const before = await readFile(file, 'utf8');
  broken = true;
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  const errors = stub.notifications.filter((entry) => entry.level === 'error');
  assert.deepEqual(errors.map((entry) => entry.message), ['Nothing was changed: the clock gave no valid time.']);
  broken = false;
  assert.equal(await readFile(file, 'utf8'), before);
});

test('the only caller of the host\'s reset is the confirmed command, and the store\'s reset is reached only through the host', () => {
  const src = path.join(__dirname, '..');
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !full.includes(`${path.sep}test${path.sep}`)) sources.push(full);
    }
  };
  walk(src);
  const callers = (needle: RegExp): string[] => sources.filter((file) => needle.test(readFileSync(file, 'utf8'))).map((file) => path.relative(src, file)).sort();
  assert.deepEqual(callers(/\bresetPolicyToDefaults\)?\(/), ['gate/bundleStore.js', 'gate/host.js']);
  assert.deepEqual(callers(/\bhost\.reset\(\)/), ['services/gateCommands.js']);
  assert.deepEqual(callers(/\bresetPolicy\(/), ['services/gateCommands.js']);
});

test('the Policy setup step is added through registerSetupStep, is done when the policy is valid, and shows the same sentence as the status bar when it is not', async () => {
  stub.setWorkspaceFolders([]);
  const bad = await tampered();
  const step = setupSteps.SETUP_STEPS.find((entry) => entry.id === 'policy');
  assert.ok(step, 'registered');
  const policy = step as import('../services/setupSteps').SetupStep;
  assert.deepEqual([policy.label, policy.icon, policy.command], ['Check your policy', 'shield', 'nearAi.policy.show']);
  const ctx = { root: '.', setting: () => undefined, facts: {} };
  assert.equal(await policy.isDone(ctx), false);
  assert.equal(policy.detail, BUNDLE_FAILURES['bad-signature']);
  const bar = stub.statusBarItems.filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  assert.ok(bar.tooltip.includes(policy.detail), 'the status bar carries the same sentence');
  const menu = await setupSteps.buildSetupMenu(setupSteps.SETUP_STEPS.filter((entry) => entry.id === 'policy'), ctx);
  assert.equal(menu[0]?.done, false);
  assert.equal(menu[0]?.detail, BUNDLE_FAILURES['bad-signature']);
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  assert.equal(await policy.isDone(ctx), true);
  assert.match(policy.detail, /signed and valid/);
  void bad;
});

test('SETUP_STEPS itself is not edited: the policy step is in the registry only after the gate registers it', () => {
  const text = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'setupSteps.ts'), 'utf8');
  assert.ok(!text.includes("'policy'"));
});

test('the reset command is contributed in package.json with the SovAI category and no em-dash in either title', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const reset = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.policy.reset');
  assert.deepEqual([reset?.title, reset?.category], ['Reset Policy to Defaults', 'SovAI']);
  for (const entry of manifest.contributes.commands.filter((item) => item.command.startsWith('nearAi.policy.'))) assert.ok(!entry.title.includes(EM_DASH));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The status bar refreshes itself (owner-confirmed 2026-11-16, PR #70 review)

test('the registered status bar changes by itself when the policy enters its renewal window and again when it ends', async () => {
  stub.setWorkspaceFolders([]);
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-'));
  const start = Date.parse('2026-11-16T12:00:00.000Z');
  let nowMs = start;
  const queue = new Map<number, { at: number; callback: () => void }>();
  let counter = 0;
  const timers = {
    set: (callback: () => void, delayMs: number): unknown => { counter += 1; queue.set(counter, { at: nowMs + delayMs, callback }); return counter; },
    clear: (handle: unknown): void => { queue.delete(handle as number); }
  };
  const advanceTo = (target: number): void => {
    for (;;) {
      const due = [...queue.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      queue.delete(due[0]);
      nowMs = due[1].at;
      due[1].callback();
    }
    nowMs = target;
  };
  const before = stub.statusBarItems.length;
  const host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: () => undefined, now: () => new Date(nowMs), statusTimers: timers });
  const state = await host.state();
  assert.equal(state.state, 'valid');
  const bar = stub.statusBarItems.slice(before).filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  assert.equal(bar.text, 'Policy');
  assert.equal(queue.size, 1, 'one timer is waiting for the next change');
  const expires = Date.parse((state as Extract<BundleState, { state: 'valid' }>).expiresAt);
  advanceTo(expires - 30 * DAY - 1);
  assert.equal(bar.text, 'Policy');
  advanceTo(expires - 30 * DAY);
  assert.equal(bar.text, 'Policy: renewing');
  advanceTo(expires);
  assert.equal(bar.text, 'Policy: reading only');
  assert.ok(bar.tooltip.includes(BUNDLE_FAILURES.expired));
  assert.equal(queue.size, 0);
});

test('a policy that has ended is not shown as valid again when the clock is set back: the setup step and the host read the same time', async () => {
  stub.setWorkspaceFolders([]);
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-'));
  // A start date well after today's real date, so a step that read the real clock instead of the host's would still call the policy valid.
  const start = Date.parse('2035-01-01T00:00:00.000Z');
  let nowMs = start;
  const host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: () => undefined, now: () => new Date(nowMs) });
  const state = await host.state();
  assert.equal(state.state, 'valid');
  const step = gateCommands.policySetupStep(host);
  const ctx = { root: '.', setting: () => undefined, facts: {} };
  assert.equal(await step.isDone(ctx), true);
  const expires = Date.parse((state as Extract<BundleState, { state: 'valid' }>).expiresAt);
  nowMs = expires + DAY;
  assert.equal(await step.isDone(ctx), false);
  assert.ok(step.detail.includes(BUNDLE_FAILURES.expired));
  nowMs = start + 10 * DAY;
  assert.equal(await step.isDone(ctx), false, 'a clock set back does not make the ended policy valid');
  assert.ok(step.detail.includes(BUNDLE_FAILURES.expired));
  assert.equal(host.bundleState().state, 'failed-closed');
});

test('the policy\'s own events follow the open folder: after a folder change they go to the new folder\'s log, and the install-level log always gets them', async () => {
  const first = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  const second = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  stub.setWorkspaceFolders([first]);
  const { host, storage } = await started();
  const resetNow = async (): Promise<void> => {
    resetNotifications();
    stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
    await stub.commands.get('nearAi.policy.reset')?.();
    await host.flush();
  };
  const resets = async (records: Promise<DecisionRecord[]>): Promise<number> => (await records).filter((record) => record.api.operation === 'policy.reset').length;

  // The folder the window was activated with.
  await resetNow();
  assert.equal(await resets(recordsOf(storage, first)), 1);
  assert.equal(await resets(installRecordsOf(storage)), 1);

  // Another folder is opened in the same window: the event goes to its log, and the first folder's log stays as it was.
  stub.setWorkspaceFolders([second]);
  await resetNow();
  assert.equal(await resets(recordsOf(storage, second)), 1, 'the new folder\'s log received it');
  assert.equal(await resets(recordsOf(storage, first)), 1, 'the first folder\'s log did not');
  assert.equal(await resets(installRecordsOf(storage)), 2);

  // The folder is closed: only the install-level log receives it, and no project log appears for it.
  stub.setWorkspaceFolders([]);
  await resetNow();
  assert.equal(await resets(installRecordsOf(storage)), 3);
  assert.equal(await resets(recordsOf(storage, first)), 1);
  assert.equal(await resets(recordsOf(storage, second)), 1);
});

test('a window that was activated with no folder gives the policy\'s events to the project opened afterwards', async () => {
  const opened = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  stub.setWorkspaceFolders([]);
  const { host, storage } = await started();
  stub.setWorkspaceFolders([opened]);
  resetNotifications();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await stub.commands.get('nearAi.policy.reset')?.();
  await host.flush();
  assert.equal((await recordsOf(storage, opened)).filter((record) => record.api.operation === 'policy.reset').length, 1);
  assert.equal((await installRecordsOf(storage)).filter((record) => record.api.operation === 'policy.reset').length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// D-62: reserved export compartments read as words after the level on the label screens; records keep the tokens

function orgLabel(level: string, compartments: string[] = [], handling: string[] = []): import('../domain/gate/labels').Label {
  return { scale: 'org', level, compartments, releasability: [], handling } as import('../domain/gate/labels').Label;
}

test('D-62: a reserved compartment is shown as its words after the level', () => {
  assert.equal(gateCommands.labelShown(orgLabel('Internal', ['ITAR'])), 'Organization: Internal · ITAR');
  const cgp = gateCommands.labelShown(orgLabel('Internal', ['CGP']));
  assert.equal(cgp, 'Organization: Internal · Controlled goods (Canada)');
  assert.ok(!cgp.includes('CGP') && !cgp.includes('compartments'), cgp);
  assert.ok(gateCommands.labelShown(orgLabel('Internal', ['EAR'])).endsWith('· US export-controlled (EAR)'));
  // The words come from the label module: none is spelled in gateCommands.ts.
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'gateCommands.ts'), 'utf8');
  for (const spelled of [/Controlled goods/, /US export-controlled/, /\bITAR\b/, /\bCGP\b/, /\bEAR\b/]) assert.doesNotMatch(source, spelled);
});

test('D-62: reserved and other compartments together, and a label with no reserved compartment reads as before', () => {
  assert.equal(gateCommands.labelShown(orgLabel('Internal', ['CGP', 'PROJ-X'], ['local-only'])), 'Organization: Internal · Controlled goods (Canada), compartments PROJ-X, local-only');
  assert.equal(gateCommands.labelShown(orgLabel('Internal', ['PROJ-X', 'PROJ-Y'], ['local-only'])), 'Organization: Internal, compartments PROJ-X, PROJ-Y, local-only');
  assert.equal(gateCommands.labelShown(orgLabel('Internal')), 'Organization: Internal');
});

test('D-62: labelsShown joins each label the same way, on the Lower This Chat\'s Label picker and its messages', async () => {
  const both = [orgLabel('Restricted', ['CGP']), { scale: 'ca-protected', level: 'Protected B', compartments: ['ITAR'], releasability: [], handling: [] } as import('../domain/gate/labels').Label];
  assert.equal(gateCommands.labelsShown(both), `${gateCommands.labelShown(both[0]!)}, ${gateCommands.labelShown(both[1]!)}`);
  assert.equal(gateCommands.labelsShown(both), 'Organization: Restricted · Controlled goods (Canada), Canada, Protected: Protected B · ITAR');
  // Through the command: the picker's title shows the words; the label.declassify record keeps the tokens (next test).
  const { host, root, storage } = await chatHost();
  const session = new SessionMark([orgLabel('Restricted', ['CGP'])]);
  const chat = { id: 'conv-d62', root, mark: () => session, defaultLabel: () => orgLabel('Public'), prepareLowering: () => undefined };
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.inputAnswers.length = 0;
  stub.notifications.length = 0;
  stub.quickPickAnswers.push('Organization: Internal');
  stub.inputAnswers.push('Reviewed by the security desk.');
  assert.equal(await gateCommands.lowerChatLabel(host, chat), true);
  assert.equal(stub.quickPickRequests.at(-1)?.title, "Lower this chat's label from Organization: Restricted · Controlled goods (Canada)");
  assert.ok(stub.notifications.some((entry) => entry.message.startsWith("This chat's label is now Organization: Internal.")));
  await host.flush();
  const declassify = (await recordsOf(storage, root)).filter((record) => record.authorizations[0]?.policy.name === 'label.declassify');
  assert.equal(declassify.length, 1);
  assert.ok(JSON.stringify(declassify[0]).includes('Lowered from Organization: Restricted, compartments CGP to Organization: Internal: Reviewed by the security desk.'), 'the record keeps the token');
  assert.ok(!JSON.stringify(declassify[0]).includes('Controlled goods'), 'no shown words in the record');
});

test('D-62: records keep the tokens: labelRecorded is today\'s form with every compartment as a token', () => {
  assert.equal(gateCommands.labelRecorded(orgLabel('Internal', ['CGP'])), 'Organization: Internal, compartments CGP');
  assert.equal(gateCommands.labelRecorded(orgLabel('Internal', ['CGP', 'PROJ-X'], ['local-only'])), 'Organization: Internal, compartments CGP, PROJ-X, local-only');
});

async function chatHost(): Promise<{ host: GateHost; root: string; storage: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-project-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-cmd-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test', projectRoot: root, home: storage });
  assert.equal((await host.start()).state, 'valid');
  return { host, root, storage };
}
