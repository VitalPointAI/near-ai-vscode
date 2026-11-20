// NEAR AI: Add Your Organization's Rules (FND-01, D-11 to D-14, D-20, D-23, D-27, D-44): every enrolment transition through the command a person runs,
// the one-time notices at start, who set the rules on the status bar and in the stored view, and the policy editor as the front door. Real files in
// temporary folders, an in-memory secret store, an in-memory memento and the recording vscode stub. Fictional names only (Example Organization).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundleHash, defaultBundlePayload, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import {
  ENROLMENT_FILE_EXTENSION, ISSUER_WORDS_MATCH, ORGANIZATION_LAYER_REFUSALS, ORGANIZATION_RULES_FILE_EXTENSION, ROTATION_WORDS_LEAD, issuerDetailsLine,
  issuerFingerprintHex, issuerWords, issuerWordsPrompt, issuerWordsQuestion, organizationEndedText, organizationEndingText
} from '../domain/gate/enrolment';
import { ignoredSettingsNotice } from '../domain/gate/layers';
import { MAX_ORGANIZATION_LAYER_BYTES } from '../domain/gate/policyDocument';
import { localHostPatternNotice } from '../domain/gate/routing';
import { signPayload } from '../domain/team/signedPayload';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { writeLastValid } from '../gate/clockMarker';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import { ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, ORGANIZATION_LAYER_FILE, migrationNoticeText, previewOrganizationFile } from '../gate/organizationStore';
import type { PolicyLayersView } from '../gate/organizationStore';
import { loadDeviceIdentity } from '../team/identity';
import { EXAMPLE_ORGANIZATION, enrolmentTextFor, organizationSections, rotationTextFor, rulesTextFor } from './helpers/enrolmentFixtures';
import { FIXED_NOW, issuerKey } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

const ADD_RULES = 'nearAi.organization.addRules';
const MIGRATION_NOTICE_KEY = 'nearAi.policy.migrationNoticeShown';
const ROOT = path.resolve(__dirname, '..', '..');

/** The few Memento members the gate uses, kept in memory: one per test "computer", shared by its windows. */
class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public get(key: string): unknown { return this.values.get(key); }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

/** One computer: its storage, its secrets, its memento and the clock its windows read. */
interface Computer {
  readonly storage: string;
  readonly secrets: MemorySecrets;
  readonly memento: MemoryMemento;
  readonly clock: { now: number };
}

/** One window of a computer: the host registerGate made and every message it told. */
interface Window {
  readonly host: GateHost;
  readonly told: string[];
}

async function computer(): Promise<Computer> {
  stub.setWorkspaceFolders([]);
  return { storage: await mkdtemp(path.join(tmpdir(), 'near-ai-enrol-cmd-')), secrets: new MemorySecrets(), memento: new MemoryMemento(), clock: { now: FIXED_NOW + 60_000 } };
}

/** Lets every queued promise and the start notices finish (they wait on no I/O of their own). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function windowOf(pc: Computer, options: { memento?: MemoryMemento | 'none'; policyEditor?: unknown } = {}): Promise<Window> {
  const told: string[] = [];
  const memento = options.memento === 'none' ? undefined : options.memento ?? pc.memento;
  const context = { ...createFakeContext(pc.storage, pc.secrets), ...(memento === undefined ? {} : { globalState: memento }) };
  const host = gateCommands.registerGate(context as never, {
    notify: (message) => { told.push(message); },
    now: () => new Date(pc.clock.now),
    ...(options.policyEditor === undefined ? {} : { policyEditor: options.policyEditor as never })
  });
  await host.state();
  await settle();
  return { host, told };
}

function resetUi(): void {
  stub.messageAnswers.length = 0;
  stub.messageOptions.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.openDialogAnswers.length = 0;
  stub.shownDocuments.length = 0;
}

async function fileWith(text: string, extension: string = ENROLMENT_FILE_EXTENSION): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-enrol-file-'));
  const file = path.join(folder, `rules${extension}`);
  await writeFile(file, text, 'utf8');
  return file;
}

/** Runs the command with this file picked and these answers to the messages, and returns its outcome. */
async function addRules(file: string | undefined, ...answers: Array<string | undefined>): Promise<unknown> {
  resetUi();
  stub.openDialogAnswers.push(file === undefined ? undefined : [file]);
  stub.messageAnswers.push(...answers);
  return stub.commands.get(ADD_RULES)?.();
}

async function installOperations(window: Window, pc: Computer): Promise<string[]> {
  await window.host.flush();
  const file = path.join(gateDir(pc.storage), DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => String((JSON.parse(line) as { api?: { operation?: string } }).api?.operation));
}

function levelOf(host: GateHost, key: string): string | undefined {
  const state = host.bundleState();
  assert.equal(state.state, 'valid', state.state === 'failed-closed' ? state.sentence : '');
  return state.state === 'valid' ? state.bundle.routing.levels[key] : undefined;
}

function infos(): string[] {
  return stub.notifications.filter((entry) => entry.level === 'info').map((entry) => entry.message);
}

function warnings(): string[] {
  return stub.notifications.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 1: the tracer

test('D-12: a new key shows the twelve words, and the button puts your organization\'s rules in force', async () => {
  const pc = await computer();
  const window = await windowOf(pc);
  assert.notEqual(levelOf(window.host, 'org/Internal'), 'local-only', 'the starting rules do not keep org/Internal on this computer');
  const key = issuerKey();
  const file = await fileWith(enrolmentTextFor(key));
  assert.equal(await addRules(file, ISSUER_WORDS_MATCH), 'enrolled');
  const modal = stub.messageOptions.find((entry) => entry.modal === true);
  assert.ok(modal, 'a modal was shown');
  assert.equal(modal.message, issuerWordsQuestion('Example Organization'));
  assert.ok(modal.detail?.includes(issuerWordsPrompt(issuerWords(key.publicKey))), modal.detail);
  assert.ok(modal.detail?.includes(issuerDetailsLine(issuerFingerprintHex(key.publicKey))), modal.detail);
  // The modal's one button is the twelve words.
  const asked = stub.notificationActions[stub.notifications.findIndex((entry) => entry.message === modal.message)] as unknown[];
  assert.deepEqual(asked.slice(1), [ISSUER_WORDS_MATCH]);
  assert.equal(levelOf(window.host, 'org/Internal'), 'local-only', 'every decision reads your organization\'s rules now');
  assert.ok(infos().includes("Your organization's rules from Example Organization are now in use on this computer."), infos().join(' | '));
  assert.ok((await installOperations(window, pc)).includes('policy.enrolled'));
});

test('D-12: closing the modal writes nothing', async () => {
  const pc = await computer();
  const window = await windowOf(pc);
  const before = window.host.bundleState();
  const file = await fileWith(enrolmentTextFor(issuerKey()));
  for (const answer of [undefined, 'Not now']) {
    assert.equal(await addRules(file, answer), 'declined');
  }
  assert.equal(existsSync(path.join(gateDir(pc.storage), ORGANIZATION_DIR_NAME)), false, 'no organization folder');
  assert.equal(pc.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false, 'no pin');
  assert.deepEqual(window.host.bundleState(), before);
  const operations = await installOperations(window, pc);
  assert.equal(operations.includes('policy.enrolled'), false);
  assert.equal(operations.includes('policy.organization-refused'), false, 'declining is not a refused file');
});

test('a dismissed file picker changes nothing', async () => {
  const pc = await computer();
  const window = await windowOf(pc);
  const bytes = await readFile(path.join(gateDir(pc.storage), POLICY_BUNDLE_FILE), 'utf8');
  assert.equal(await addRules(undefined), 'cancelled');
  assert.equal(stub.notifications.length, 0, 'nothing is said');
  assert.equal(await readFile(path.join(gateDir(pc.storage), POLICY_BUNDLE_FILE), 'utf8'), bytes);
  assert.equal(pc.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false);
  void window;
});

test('the command is contributed in the NEAR AI category and shown in the palette', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: { commandPalette?: Array<{ command: string; when?: string }> } };
  };
  const entry = manifest.contributes.commands.find((item) => item.command === ADD_RULES);
  assert.deepEqual([entry?.title, entry?.category], ["Add Your Organization's Rules", 'NEAR AI']);
  assert.equal((manifest.contributes.menus.commandPalette ?? []).some((item) => item.command === ADD_RULES), false, 'no palette entry hides it');
  void ORGANIZATION_RULES_FILE_EXTENSION;
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: handover, update, refusal, the start notices and who set the rules

/** Your organization's sections with one routing level set, so a rules update changes something a decision reads. */
function sectionsWith(level: string, tier: string): Record<string, unknown> {
  const sections = organizationSections();
  ((sections['labels'] as { routing: { levels: Record<string, string> } }).routing.levels)[level] = tier;
  return sections;
}

function pinOf(pc: Computer): Record<string, unknown> | undefined {
  const text = pc.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
  return text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>;
}

/** A window of a computer that took Example Organization's enrolment through the command. */
async function enrolledWindow(pc: Computer): Promise<Window> {
  const window = await windowOf(pc);
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey())), ISSUER_WORDS_MATCH), 'enrolled');
  return window;
}

test('D-14: a handover shows the words again, and only the button moves the pin to the new key', async () => {
  const pc = await computer();
  const window = await enrolledWindow(pc);
  const newKey = issuerKey('organization-issuer-2');
  const file = await fileWith(rotationTextFor(issuerKey(), newKey, { now: FIXED_NOW + 1_000 }));
  assert.equal(await addRules(file, undefined), 'declined');
  const declined = stub.messageOptions.find((entry) => entry.modal === true);
  assert.ok(declined?.message.startsWith(ROTATION_WORDS_LEAD), declined?.message);
  assert.ok(declined?.detail?.includes(issuerWordsPrompt(issuerWords(newKey.publicKey))), 'the new key\'s words');
  assert.equal(pinOf(pc)?.['publicKey'], issuerKey().publicKey, 'the old key stays');
  assert.equal(await addRules(file, ISSUER_WORDS_MATCH), 'rotated');
  assert.equal(pinOf(pc)?.['publicKey'], newKey.publicKey, 'the pin holds the new key');
  assert.ok(infos().includes("Your organization's new key is now in use on this computer, with the rules from Example Organization."), infos().join(' | '));
  void window;
});

test('D-14: a newer rules file from your organization\'s key is used without the words; the same file again changes nothing', async () => {
  const pc = await computer();
  const window = await enrolledWindow(pc);
  const file = await fileWith(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'), { now: FIXED_NOW + 2_000 }), ORGANIZATION_RULES_FILE_EXTENSION);
  assert.equal(await addRules(file), 'updated');
  assert.equal(stub.messageOptions.some((entry) => entry.modal === true), false, 'no modal');
  assert.ok(infos().includes("Your organization's rules dated 2026-11-20 are now in use."), infos().join(' | '));
  assert.equal(levelOf(window.host, 'org/Public'), 'local-only');
  assert.ok((await installOperations(window, pc)).includes('policy.organization-updated'));
  const before = window.host.bundleState();
  assert.equal(await addRules(file), 'unchanged');
  assert.deepEqual(infos(), ['These are the rules already in use. Nothing was changed.']);
  assert.deepEqual(window.host.bundleState(), before);
});

test('D-14: an older, foreign or broken file is refused with the preview\'s sentence, recorded, and changes nothing', async () => {
  const pc = await computer();
  const window = await enrolledWindow(pc);
  assert.equal(await addRules(await fileWith(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'), { now: FIXED_NOW + 5_000 }), ORGANIZATION_RULES_FILE_EXTENSION)), 'updated');
  const cases: Array<[string, string]> = [
    ['older', rulesTextFor(issuerKey(), organizationSections(), { now: FIXED_NOW + 1_000 })],
    ['foreign', rulesTextFor(issuerKey('another-organization'), organizationSections(), { now: FIXED_NOW + 6_000 })],
    ['broken', '{ "not": "rules" }']
  ];
  for (const [name, text] of cases) {
    const preview = await previewOrganizationFile(pc.storage, pc.secrets, text, window.host.now());
    assert.equal(preview.kind, 'refused', name);
    const before = window.host.bundleState();
    const pin = pc.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    const refusedBefore = (await installOperations(window, pc)).filter((operation) => operation === 'policy.organization-refused').length;
    assert.equal(await addRules(await fileWith(text, ORGANIZATION_RULES_FILE_EXTENSION)), 'refused', name);
    assert.deepEqual(warnings(), [preview.kind === 'refused' ? preview.sentence : ''], name);
    assert.equal((await installOperations(window, pc)).filter((operation) => operation === 'policy.organization-refused').length, refusedBefore + 1, `${name}: recorded`);
    assert.deepEqual(window.host.bundleState(), before, `${name}: the state is unchanged`);
    assert.equal(pc.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, `${name}: the pin is unchanged`);
  }
});

test('T-41-141: a file larger than your organization\'s rules can be is refused before it is read, and recorded', async () => {
  const pc = await computer();
  const window = await windowOf(pc);
  const file = await fileWith(`{"pad":"${'x'.repeat(MAX_ORGANIZATION_LAYER_BYTES)}"}`, ORGANIZATION_RULES_FILE_EXTENSION);
  assert.equal(await addRules(file), 'refused');
  assert.deepEqual(warnings(), [ORGANIZATION_LAYER_REFUSALS['too-large']]);
  assert.ok((await installOperations(window, pc)).includes('policy.organization-refused'));
  assert.equal(pc.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false);
});

test('D-20: personal settings wider than your organization allows are named once per distinct list', async () => {
  const pc = await computer();
  const first = await enrolledWindow(pc);
  const ignored = first.host.policyLayers().ignored;
  assert.ok(ignored.length > 0, 'the starting rules hold a value wider than your organization allows');
  const notice = ignoredSettingsNotice(ignored) as string;
  assert.deepEqual(first.told.filter((message) => message === notice), [notice], 'told once, after the rules were taken');
  const second = await windowOf(pc);
  assert.equal(second.told.includes(notice), false, 'a new window with the same list says nothing');
  await second.host.acceptOrganizationFile(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'), { now: FIXED_NOW + 2_000 }), {});
  const third = await windowOf(pc);
  const changed = ignoredSettingsNotice(third.host.policyLayers().ignored) as string;
  assert.notEqual(changed, notice, 'the list changed');
  assert.deepEqual(third.told.filter((message) => message === changed), [changed], 'a changed list is told again, once');
  const fourth = await windowOf(pc, { memento: new MemoryMemento() });
  assert.ok(fourth.told.includes(changed), 'a lost flag only repeats it');
});

test('D-27: the migration notice is shown once per personal layer and recorded; the next window shows the S1 pattern notice', async () => {
  const pc = await computer();
  const fresh = await windowOf(pc);
  await fresh.host.flush();
  const identity = await loadDeviceIdentity(pc.secrets);
  assert.ok(identity);
  const payload = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: FIXED_NOW }))) as Record<string, unknown>;
  payload['routing'] = { ...(payload['routing'] as Record<string, unknown>), localHosts: ['models.example.org', '*.example.net'] };
  const envelope = signPayload(identity, 'policy-bundle', payload, { now: () => new Date(FIXED_NOW) });
  await writeFile(path.join(gateDir(pc.storage), POLICY_BUNDLE_FILE), `${JSON.stringify(envelope, null, 2)}\n`);
  await writeLastValid(pc.secrets, { at: FIXED_NOW, hash: bundleHash(payload) });
  const pattern = localHostPatternNotice(['*.example.net']);

  const first = await windowOf(pc);
  const migration = migrationNoticeText(first.host.policyLayers().migration);
  assert.ok(migration !== undefined);
  assert.deepEqual(first.told.filter((message) => message === migration), [migration]);
  assert.equal(first.told.includes(pattern), false, 'the migration notice stands in for the pattern notice in this window');
  assert.equal(pc.memento.get(MIGRATION_NOTICE_KEY), bundleHash(payload), 'the flag holds the personal layer\'s hash');
  assert.ok((await installOperations(first, pc)).includes('policy.migrated'));

  const second = await windowOf(pc);
  assert.equal(second.told.includes(migration), false);
  assert.deepEqual(second.told.filter((message) => message === pattern), [pattern], 'the pattern notice as the safety patch shows it');

  const third = await windowOf(pc, { memento: new MemoryMemento() });
  assert.ok(third.told.includes(migration), 'a lost flag only repeats it');
  void fresh;
});

/** A layers view for the pure status bar and stored view checks; only the fields they read are real. */
function layersWith(organization: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): PolicyLayersView {
  return { organization: organization ?? { state: 'none' }, ignored: [], migration: [], ...extra } as unknown as PolicyLayersView;
}

const EXAMPLE_VALID = { state: 'valid', name: 'Example Organization', contacts: EXAMPLE_ORGANIZATION.contacts, expiresAt: '2027-02-18T00:00:00.000Z', endsSoon: false };
const SECURITY_DESK = 'Security desk (security@example.org)';

function validState(expiresAt = '2027-02-18T00:00:00.000Z'): BundleState {
  return { state: 'valid', bundle: {} as never, hash: 'h'.repeat(64), signer: { fingerprint: 'fp', publicKey: 'pk' } as never, expiresAt, renewDue: false };
}

test('D-23, D-14: the status bar says who set the rules, and your organization\'s rules in their last 30 days read "Policy: ends soon"', async () => {
  const gateStatusBar = require('../services/gateStatusBar') as typeof import('../services/gateStatusBar');
  const now = Date.parse('2026-12-01T00:00:00.000Z');
  // No organization: today's words exactly.
  assert.deepEqual(gateStatusBar.gateStatusText(validState(), now, undefined, layersWith(undefined)), gateStatusBar.gateStatusText(validState(), now));
  const valid = gateStatusBar.gateStatusText(validState(), now, undefined, layersWith(EXAMPLE_VALID));
  assert.equal(valid.text, 'Policy');
  assert.equal(valid.tooltip, 'Your organization\'s rules (Example Organization) are signed and valid until 2027-02-18. Your settings on this computer can only narrow them. Click to see your policy.');
  assert.equal(valid.warning, false);
  const late = Date.parse('2027-01-25T00:00:00.000Z');
  const ending = gateStatusBar.gateStatusText(validState(), late, undefined, layersWith(EXAMPLE_VALID));
  assert.equal(ending.text, 'Policy: ends soon');
  assert.equal(gateStatusBar.POLICY_ENDS_SOON_TEXT, 'Policy: ends soon');
  assert.ok(ending.tooltip.includes(organizationEndingText('2027-02-18', SECURITY_DESK)), ending.tooltip);
  // Past its end, a state that still says valid reads as your organization's own ending sentence.
  const ended = gateStatusBar.gateStatusText(validState(), Date.parse('2027-03-01T00:00:00.000Z'), undefined, layersWith(EXAMPLE_VALID, { expiry: { state: 'failed-closed', reason: 'expired', sentence: organizationEndedText('2027-02-18', SECURITY_DESK) } }));
  assert.equal(ended.text, 'Policy: reading only');
  assert.ok(ended.tooltip.includes(organizationEndedText('2027-02-18', SECURITY_DESK)));
  assert.doesNotMatch(ended.tooltip, /Reset/);

  // The registered item after a real enrolment.
  const pc = await computer();
  const window = await enrolledWindow(pc);
  const bar = stub.statusBarItems.filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  const state = window.host.bundleState();
  assert.equal(state.state, 'valid');
  if (state.state === 'valid') assert.equal(bar.tooltip, `Your organization's rules (Example Organization) are signed and valid until ${state.expiresAt.slice(0, 10)}. Your settings on this computer can only narrow them. Click to see your policy.`);
});

test('D-21, D-23: when your organization\'s rules fail, the status bar reads "reading only" with your organization\'s sentence and never suggests Reset', async () => {
  const pc = await computer();
  await enrolledWindow(pc);
  await writeFile(path.join(gateDir(pc.storage), ORGANIZATION_DIR_NAME, ORGANIZATION_LAYER_FILE), '{ "not": "a layer" }\n');
  const window = await windowOf(pc);
  const state = window.host.bundleState();
  assert.equal(state.state, 'failed-closed');
  assert.equal(window.host.policyLayers().failedLayer, 'organization');
  const bar = stub.statusBarItems.filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  assert.equal(bar.text, 'Policy: reading only');
  if (state.state === 'failed-closed') assert.ok(bar.tooltip.includes(state.sentence));
  assert.doesNotMatch(bar.tooltip, /Reset/);
  const view = await stub.contentProviders.get('near-ai-policy')?.provideTextDocumentContent(undefined);
  assert.ok(view?.includes(`Your organization's rules need attention: ask ${SECURITY_DESK}.`), view);
  assert.doesNotMatch(view ?? '', /Reset/);
});

test('D-23: the stored view names where the rules come from; called without layers the text is as before', async () => {
  const now = Date.parse('2026-12-01T00:00:00.000Z');
  const pc = await computer();
  const window = await windowOf(pc);
  const state = window.host.bundleState();
  const own = await stub.contentProviders.get('near-ai-policy')?.provideTextDocumentContent(undefined) ?? '';
  assert.ok(own.includes('\nRules from: this computer (self-signed on this computer).\n'), own.slice(0, 300));
  const plain = gateCommands.policyDocumentText(state, window.host.now());
  assert.equal(plain.includes('Rules from'), false);
  assert.equal(own.replace('Rules from: this computer (self-signed on this computer).\n\n', ''), plain, 'the line is the only difference');
  assert.equal(gateCommands.policyDocumentText(state, window.host.now(), undefined), plain);
  await addRules(await fileWith(enrolmentTextFor(issuerKey())), ISSUER_WORDS_MATCH);
  const organization = await stub.contentProviders.get('near-ai-policy')?.provideTextDocumentContent(undefined) ?? '';
  assert.ok(organization.includes('\nRules from: your organization (Example Organization). Your settings on this computer can only narrow them.\n'), organization.slice(0, 300));
  // An organization failure: the note asks the contact and never names Reset.
  const failed = gateCommands.policyDocumentText({ state: 'failed-closed', reason: 'bad-signature', sentence: 'Your organization\'s rules were changed after they were signed.' }, now,
    layersWith({ state: 'failed', reason: 'bad-signature', sentence: 'x', contacts: EXAMPLE_ORGANIZATION.contacts }, { failedLayer: 'organization' }));
  assert.ok(failed.includes(`This view only shows your policy. Editing it changes nothing. Your organization's rules need attention: ask ${SECURITY_DESK}.`), failed);
  assert.doesNotMatch(failed, /Reset/);
  // A personal failure under no organization keeps today's note.
  assert.equal(gateCommands.policyDocumentText(failedClosed('bad-signature'), now, layersWith(undefined, { failedLayer: 'personal' })), gateCommands.policyDocumentText(failedClosed('bad-signature'), now));
});
