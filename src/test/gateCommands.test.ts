// What the person sees of the policy (OFFL-02, OFFL-03, D-13, D-23, D-27, D-33, D-41): the status bar item and its plain words for every state, the read-only
// Show Policy view, the confirmed and recorded Reset Policy to Defaults, and the Policy step in the setup view. Runs with the recording vscode stub.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, SCALE_PRESETS_CAVEAT_TEXT } from '../domain/gate/labels';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
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
