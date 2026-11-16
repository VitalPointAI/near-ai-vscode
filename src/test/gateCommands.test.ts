// What the person sees of the policy (OFFL-02, OFFL-03, D-13, D-23, D-27, D-33, D-41): the status bar item and its plain words for every state, the read-only
// Show Policy view, the confirmed and recorded Reset Policy to Defaults, and the Policy step in the setup view. Runs with the recording vscode stub.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
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
  assert.equal(item.name, 'NEAR AI Policy');
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

test('Show Policy opens a read-only document with the hash, the self-declared clearance text, the scales caveat and the "not used yet" line above the scales, clearances and routing', async () => {
  const { storage, state } = await started();
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  const filesBefore = (await readdir(gateDir(storage))).sort();
  const bytesBefore = await readFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), 'utf8');
  stub.shownDocuments.length = 0;
  await stub.commands.get('nearAi.policy.show')?.();
  assert.equal(stub.shownDocuments.length, 1);
  const shown = stub.shownDocuments[0] as { uri: string; text: string };
  assert.ok(shown.uri.startsWith('near-ai-policy:'));
  const text = shown.text;
  assert.ok(text.includes(state.hash), 'the bundle hash');
  assert.ok(text.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.ok(text.includes(SCALE_PRESETS_CAVEAT_TEXT));
  assert.ok(text.includes(gateCommands.POLICY_LABELS_NOT_USED_TEXT));
  assert.ok(text.includes(state.bundle.issuer.fingerprint), 'the issuer');
  assert.ok(text.includes(state.expiresAt), 'the expiry');
  assert.ok(text.includes('"bundleVersion": 1'), 'the pretty-printed payload');
  assert.ok(text.includes('anchorRoots') && text.includes('statusLists') && text.includes('maxOfflineAge'), 'the reserved fields');
  const notUsed = text.indexOf(gateCommands.POLICY_LABELS_NOT_USED_TEXT);
  for (const heading of ['\nScales\n', '\nClearances\n', '\nRouting tiers']) {
    const at = text.indexOf(heading);
    assert.ok(at > notUsed, `${heading.trim()} comes after the "not used yet" line`);
  }
  assert.ok(text.indexOf('"scales"') > notUsed, 'the JSON copy of the scales also comes after the line');
  assert.ok(text.indexOf(CLEARANCE_SELF_ASSERTED_TEXT) < text.indexOf('\nRouting tiers'), 'the clearance text sits with the clearances');
  assert.doesNotMatch(text, /unlabell?ed/i, 'the unlabelled-content sentence arrives with plan 21, when clearance checks are live');
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
  await stub.commands.get('nearAi.policy.show')?.();
  const text = (stub.shownDocuments[0] as { text: string }).text;
  assert.ok(text.includes(BUNDLE_FAILURES['bad-signature']));
  assert.match(text, /only reading and planning/);
  assert.ok(!text.includes('bundleVersion'));
});

test('policyDocumentText for a policy that failed is exactly the title, the note, the state line and the sentence, with no blank line after the sentence', () => {
  const sentence = BUNDLE_FAILURES['bad-signature'];
  const expected = [
    'Your NEAR AI policy',
    '',
    'This view only shows your policy. Editing it changes nothing. To change the policy file itself, run NEAR AI: Reset Policy to Defaults.',
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

test('policyDocumentText is pure: the same state gives the same text, and a check that has not finished says so', () => {
  assert.equal(gateCommands.policyDocumentText(failedClosed('missing'), 0), gateCommands.policyDocumentText(failedClosed('missing'), 99));
  assert.match(gateCommands.policyDocumentText(undefined, 0), /checking your policy file/);
});

test('the commands are contributed in package.json with the NEAR AI category', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const show = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.policy.show');
  assert.deepEqual([show?.title, show?.category], ['Show Policy', 'NEAR AI']);
  assert.equal(existsSync(path.join(__dirname, '..', '..', 'package.json')), true);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: Reset Policy to Defaults and the Policy setup step

async function recordsOf(storage: string, root: string): Promise<DecisionRecord[]> {
  const file = path.join(storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
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

test('the reset command is contributed in package.json with the NEAR AI category and no em-dash in either title', async () => {
  const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const reset = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.policy.reset');
  assert.deepEqual([reset?.title, reset?.category], ['Reset Policy to Defaults', 'NEAR AI']);
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
