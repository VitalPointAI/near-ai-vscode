// SovAI: Add Your Organization's Rules (FND-01, D-11 to D-14, D-20, D-23, D-27, D-44): every enrolment transition through the command a person runs,
// the one-time notices at start, who set the rules on the status bar and in the stored view, and the policy editor as the front door. Real files in
// temporary folders, an in-memory secret store, an in-memory memento and the recording vscode stub. Fictional names only (Example Organization).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { POLICY_BUNDLE_FILE, POLICY_DRAFT_BASE_FILE, POLICY_DRAFT_FILE, STALE_DRAFT_TEXT, gateDir, parsePolicyDraft } from '../gate/bundleStore';
import { writeLastValid } from '../gate/clockMarker';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import { ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, ORGANIZATION_LAYER_FILE, OrganizationStore, migrationNoticeText, previewOrganizationFile, setOrganizationWriteProbe } from '../gate/organizationStore';
import type { PolicyLayersView } from '../gate/organizationStore';
import type { PolicyChange } from '../services/policyEditor';
import { loadDeviceIdentity } from '../team/identity';
import { EXAMPLE_ORGANIZATION, enrolmentTextFor, organizationSections, rotationTextFor, rulesTextFor } from './helpers/enrolmentFixtures';
import { DAY_MS, FIXED_NOW, issuerKey } from './helpers/policyFixtures';
import { autoApplyPolicyEditor, recordingPolicyEditor } from './helpers/policyEditorFake';
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

test('the command is contributed in the SovAI category and shown in the palette', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: { commandPalette?: Array<{ command: string; when?: string }> } };
  };
  const entry = manifest.contributes.commands.find((item) => item.command === ADD_RULES);
  assert.deepEqual([entry?.title, entry?.category], ["Add Your Organization's Rules", 'SovAI']);
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

test('WR-01: when the rules file is missing, opening the enrolment file in use again writes it back without the words', async () => {
  const pc = await computer();
  await enrolledWindow(pc);
  const pin = pc.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
  await rm(path.join(gateDir(pc.storage), ORGANIZATION_DIR_NAME, ORGANIZATION_LAYER_FILE));
  const window = await windowOf(pc);
  assert.equal(window.host.bundleState().state, 'failed-closed', 'the missing file fails the policy closed');
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey()))), 'updated');
  assert.equal(stub.messageOptions.some((entry) => entry.modal === true), false, 'no words: the file is the one the pin names');
  assert.equal(levelOf(window.host, 'org/Internal'), 'local-only');
  assert.equal(pc.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, 'the pin did not move');
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey()))), 'unchanged', 'once written back, the same file changes nothing');
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
  assert.equal(valid.text, 'Standing Orders');
  assert.equal(valid.tooltip, 'Your organization\'s Standing Orders (Example Organization) are signed and valid until 2027-02-18. Your settings on this computer can only narrow them. Click to see your Standing Orders.');
  assert.equal(valid.warning, false);
  const late = Date.parse('2027-01-25T00:00:00.000Z');
  const ending = gateStatusBar.gateStatusText(validState(), late, undefined, layersWith(EXAMPLE_VALID));
  assert.equal(ending.text, 'Standing Orders: ends soon');
  assert.equal(gateStatusBar.POLICY_ENDS_SOON_TEXT, 'Standing Orders: ends soon');
  assert.ok(ending.tooltip.includes(organizationEndingText('2027-02-18', SECURITY_DESK)), ending.tooltip);
  // Past its end, a state that still says valid reads as your organization's own ending sentence.
  const ended = gateStatusBar.gateStatusText(validState(), Date.parse('2027-03-01T00:00:00.000Z'), undefined, layersWith(EXAMPLE_VALID, { expiry: { state: 'failed-closed', reason: 'expired', sentence: organizationEndedText('2027-02-18', SECURITY_DESK) } }));
  assert.equal(ended.text, 'Standing Orders: reading only');
  assert.ok(ended.tooltip.includes(organizationEndedText('2027-02-18', SECURITY_DESK)));
  assert.doesNotMatch(ended.tooltip, /Reset/);

  // The registered item after a real enrolment.
  const pc = await computer();
  const window = await enrolledWindow(pc);
  const bar = stub.statusBarItems.filter((item) => item.id === 'nearAi.gate').at(-1) as (typeof stub.statusBarItems)[number];
  const state = window.host.bundleState();
  assert.equal(state.state, 'valid');
  if (state.state === 'valid') assert.equal(bar.tooltip, `Your organization's Standing Orders (Example Organization) are signed and valid until ${state.expiresAt.slice(0, 10)}. Your settings on this computer can only narrow them. Click to see your Standing Orders.`);
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
  assert.equal(bar.text, 'Standing Orders: reading only');
  if (state.state === 'failed-closed') assert.ok(bar.tooltip.includes(state.sentence));
  assert.doesNotMatch(bar.tooltip, /Reset/);
  const view = await stub.contentProviders.get('near-ai-policy')?.provideTextDocumentContent(undefined);
  assert.ok(view?.includes(`Ask ${SECURITY_DESK} about your organization's Standing Orders.`), view);
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
  assert.ok(failed.includes(`This view only shows your Standing Orders. Editing it changes nothing. Ask ${SECURITY_DESK} about your organization's Standing Orders.`), failed);
  assert.doesNotMatch(failed, /Reset/);
  // A personal failure under no organization keeps today's note.
  assert.equal(gateCommands.policyDocumentText(failedClosed('bad-signature'), now, layersWith(undefined, { failedLayer: 'personal' })), gateCommands.policyDocumentText(failedClosed('bad-signature'), now));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 3: the policy editor is the front door

const PB_CLEARANCE = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [] };
const draftFile = (pc: Computer): string => path.join(gateDir(pc.storage), POLICY_DRAFT_FILE);
const baseFile = (pc: Computer): string => path.join(gateDir(pc.storage), POLICY_DRAFT_BASE_FILE);
const storedBytes = (pc: Computer): Promise<string> => readFile(path.join(gateDir(pc.storage), POLICY_BUNDLE_FILE), 'utf8');

/** Runs Edit Policy (its notice dismissed) and returns the draft. */
async function editDraft(pc: Computer): Promise<Record<string, unknown>> {
  resetUi();
  assert.equal(await stub.commands.get('nearAi.policy.edit')?.(), draftFile(pc));
  return JSON.parse(await readFile(draftFile(pc), 'utf8')) as Record<string, unknown>;
}

/** Edit Policy, then the draft with a Protected B clearance added (the v1 form Edit Policy writes for the starting rules). */
async function draftWithClearance(pc: Computer): Promise<void> {
  const draft = await editDraft(pc);
  await writeFile(draftFile(pc), JSON.stringify({ ...draft, clearances: [...(draft['clearances'] as unknown[]), PB_CLEARANCE] }, null, 2));
}

async function applyDraft(): Promise<unknown> {
  resetUi();
  return stub.commands.get('nearAi.policy.applyDraft')?.();
}

function holdsProtectedB(host: GateHost): boolean {
  return host.labelPolicy().clearances.some((clearance) => clearance.scale === 'ca-protected' && clearance.level === 'Protected B');
}

test('D-44: SovAI: Policy and Show Policy open the editor, whose deps read both layers from the host and judge direction with narrowingOf', async () => {
  const pc = await computer();
  const fake = recordingPolicyEditor();
  const window = await windowOf(pc, { policyEditor: fake });
  assert.equal(fake.registered.length, 1, 'registered once');
  resetUi();
  await stub.commands.get('nearAi.policy.open')?.();
  await stub.commands.get('nearAi.policy.show')?.();
  assert.equal(fake.opened.length, 2, 'each command opened the editor once');
  assert.equal(stub.shownDocuments.length, 0, 'neither opened the stored text');
  const layers = window.host.policyLayers();
  const state = fake.deps().state();
  assert.ok(state !== undefined);
  assert.equal(state.personal, layers.personal?.document);
  assert.equal(state.personalHash, layers.personal?.hash);
  assert.equal(state.effective, layers.effective);
  assert.equal(state.organization, undefined);
  assert.equal(state.organizationSignedHere, false);
  const directionOf = fake.deps().directionOf;
  assert.equal(directionOf('labels', 'routing.levels.org/Internal', 'attested-cloud', 'any-cloud'), 'widens');
  assert.equal(directionOf('labels', 'routing.levels.org/Internal', 'any-cloud', 'local-only'), 'narrows');
  assert.equal(directionOf('labels', 'routing.levels.org/Internal', 'local-only', 'local-only'), 'neutral');
  // Under your organization's rules the state carries its layer, and its key is not this computer's.
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey())), ISSUER_WORDS_MATCH), 'enrolled');
  const organization = window.host.policyLayers().organization;
  const enrolled = fake.deps().state();
  assert.ok(organization.state === 'valid' && enrolled !== undefined);
  if (organization.state === 'valid' && enrolled !== undefined) {
    assert.equal(enrolled.organization, organization.document);
    assert.equal(enrolled.organizationHash, organization.hash);
    assert.equal(enrolled.organizationIssuer, organization.document.issuer.fingerprint);
    assert.equal(enrolled.organizationSignedHere, false);
    assert.equal(enrolled.effective, window.host.policyLayers().effective);
  }
});

test('D-44: without an editor page the policy commands open the stored view, so the person always sees the policy', async () => {
  const pc = await computer();
  await windowOf(pc);
  resetUi();
  await stub.commands.get('nearAi.policy.open')?.();
  assert.equal(stub.shownDocuments.length, 1);
  assert.ok(stub.shownDocuments[0]?.uri.startsWith('near-ai-policy:'));
});

test('D-44: Apply Policy Draft shows the draft as a proposal, and nothing is signed until the page applies it through the deps', async () => {
  const pc = await computer();
  const fake = recordingPolicyEditor();
  const window = await windowOf(pc, { policyEditor: fake });
  await draftWithClearance(pc);
  const bytes = await storedBytes(pc);
  assert.equal(await applyDraft(), false, 'a discarded proposal changes nothing');
  assert.equal(fake.proposed.length, 1);
  assert.equal(fake.proposed[0]?.target, 'personal');
  assert.equal(fake.proposed[0]?.from, 'Edit my rules');
  assert.equal(await storedBytes(pc), bytes, 'nothing was signed');
  assert.ok(existsSync(draftFile(pc)), 'a discarded proposal keeps the draft');
  assert.equal(holdsProtectedB(window.host), false);
  const state = fake.deps().state();
  assert.ok(state !== undefined);
  if (state === undefined) return;
  const next = (fake.proposed[0] as PolicyChange).next(state.personal);
  assert.ok(next.people?.clearances?.some((clearance) => clearance.scale === 'ca-protected' && clearance.level === 'Protected B'), 'the proposal is the draft');
  // Refused side: a base that is not the stored personal layer's hash is stale and signs nothing.
  const stale = await fake.deps().applyPersonal(next, 'f'.repeat(64));
  assert.deepEqual(stale, { ok: false, text: `Nothing was changed. ${STALE_DRAFT_TEXT}` });
  assert.equal(await storedBytes(pc), bytes);
  // Allowed side: the page's Apply at the shown base signs it.
  assert.deepEqual(await fake.deps().applyPersonal(next, state.personalHash), { ok: true });
  assert.notEqual(await storedBytes(pc), bytes);
  assert.equal(holdsProtectedB(window.host), true);
});

test('D-44: with the page\'s Apply the policy changes, the draft files are removed and the applied sentence is shown', async () => {
  const pc = await computer();
  const window = await windowOf(pc, { policyEditor: autoApplyPolicyEditor() });
  await draftWithClearance(pc);
  assert.equal(await applyDraft(), true);
  assert.equal(holdsProtectedB(window.host), true);
  assert.equal(existsSync(draftFile(pc)), false);
  assert.equal(existsSync(baseFile(pc)), false);
  assert.deepEqual(infos(), [gateCommands.POLICY_APPLIED_TEXT]);
  assert.ok((await installOperations(window, pc)).includes('policy.edit'));
});

test('D-44, T-41-142: a stale or invalid draft is refused before anything is proposed', async () => {
  const pc = await computer();
  const fake = recordingPolicyEditor('applied');
  const window = await windowOf(pc, { policyEditor: fake });
  await draftWithClearance(pc);
  // A later reset signs a different personal layer (on a fixed clock it would sign the same bytes again).
  pc.clock.now += 60_000;
  await window.host.reset();
  assert.equal(await applyDraft(), false);
  assert.deepEqual(warnings(), ['Nothing was changed. Your policy changed after this draft was made. Open SovAI: Standing Orders and choose Edit my Standing Orders again to start from the policy in force.']);
  assert.equal(fake.proposed.length, 0, 'a stale draft proposes nothing');
  assert.ok(existsSync(draftFile(pc)), 'the draft is kept');
  await editDraft(pc);
  const broken = '{ "clearances": [';
  await writeFile(draftFile(pc), broken);
  let expected = '';
  try {
    parsePolicyDraft(broken, { issuer: { fingerprint: 'f', publicKey: 'p' }, issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-11-20T00:00:00.000Z' });
  } catch (error) {
    expected = (error as Error).message;
  }
  assert.match(expected, /not valid JSON/);
  assert.equal(await applyDraft(), false);
  assert.deepEqual(warnings(), [expected]);
  assert.equal(fake.proposed.length, 0, 'an invalid draft proposes nothing');
});

test('D-44: Edit Policy drafts the personal layer\'s own document, with the personal layer\'s hash as its base', async () => {
  const pc = await computer();
  const window = await windowOf(pc, { policyEditor: autoApplyPolicyEditor() });
  await draftWithClearance(pc);
  assert.equal(await applyDraft(), true);
  const draft = await editDraft(pc);
  const personal = window.host.policyLayers().personal;
  assert.ok(personal !== undefined);
  assert.equal(draft['bundleVersion'], 2, 'the stored v2 document');
  assert.ok('people' in draft, 'it has people');
  assert.equal('clearances' in draft, false, 'not a top-level clearances');
  assert.deepEqual(draft, JSON.parse(JSON.stringify(personal?.stored)));
  assert.equal((await readFile(baseFile(pc), 'utf8')).trim(), personal?.hash);
  // Under your organization's rules the draft is still the personal layer's own document, never the narrowed view.
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey())), ISSUER_WORDS_MATCH), 'enrolled');
  const underOrganization = await editDraft(pc);
  const after = window.host.policyLayers();
  assert.deepEqual(underOrganization, JSON.parse(JSON.stringify(after.personal?.stored)));
  assert.equal((await readFile(baseFile(pc), 'utf8')).trim(), after.personal?.hash);
  const composed = window.host.bundleState();
  assert.ok(composed.state === 'valid' && composed.hash !== after.personal?.hash, 'the composed hash is not the base');
});

test('D-44: deps.reset runs the confirmed Reset modal, deps.showStored opens the stored text view, deps.record writes the proposal records', async () => {
  const pc = await computer();
  const fake = recordingPolicyEditor();
  const window = await windowOf(pc, { policyEditor: fake });
  resetUi();
  stub.messageAnswers.push(gateCommands.RESET_CONFIRM_ACTION);
  await fake.deps().reset();
  assert.equal(stub.notifications[0]?.message, gateCommands.RESET_TITLE);
  assert.deepEqual(stub.messageOptions[0], { message: gateCommands.RESET_TITLE, modal: true, detail: gateCommands.RESET_DETAIL });
  assert.ok((await installOperations(window, pc)).includes('policy.reset'));
  resetUi();
  await fake.deps().showStored();
  assert.equal(stub.shownDocuments.length, 1);
  assert.ok(stub.shownDocuments[0]?.uri.startsWith('near-ai-policy:'));
  assert.ok(stub.shownDocuments[0]?.text.startsWith('Your Standing Orders'));
  fake.deps().record('policy.proposal-applied', { proposalHash: 'a'.repeat(64), changes: 2, from: 'Edit Policy' });
  fake.deps().record('policy.proposal-exported', { proposalHash: 'b'.repeat(64), changes: 1, from: 'Edit Policy' });
  await window.host.flush();
  const records = (await readFile(path.join(gateDir(pc.storage), DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`), 'utf8')).split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { api: { operation: string }; status_detail?: string });
  assert.equal(records.find((record) => record.api.operation === 'policy.proposal-applied')?.status_detail, `2 changes from Edit Policy, proposal ${'a'.repeat(16)}`);
  assert.equal(records.find((record) => record.api.operation === 'policy.proposal-exported')?.status_detail, `1 changes from Edit Policy, proposal ${'b'.repeat(16)}`);
  // Under your organization's rules the Reset modal says only your own settings are replaced.
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey())), ISSUER_WORDS_MATCH), 'enrolled');
  resetUi();
  stub.messageAnswers.push(undefined);
  await fake.deps().reset();
  assert.equal(stub.messageOptions[0]?.detail, gateCommands.RESET_DETAIL_ORGANIZATION);
  assert.match(gateCommands.RESET_DETAIL_ORGANIZATION, /Your organization's Standing Orders stay as they are\./);
  assert.equal(window.host.policyLayers().organization.state, 'valid', 'declining changed nothing');
});

test('D-44, owner Q9: the palette offers SovAI: Policy; Show, Edit, Apply, Reset and Show as Stored keep their ids but leave the palette', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: { commandPalette?: Array<{ command: string; when?: string }> } };
  };
  const find = (id: string) => manifest.contributes.commands.find((entry) => entry.command === id);
  assert.deepEqual([find('nearAi.policy.open')?.title, find('nearAi.policy.open')?.category], ['Standing Orders', 'SovAI']);
  assert.deepEqual([find('nearAi.policy.showAsStored')?.title, find('nearAi.policy.showAsStored')?.category], ['Show Standing Orders as Stored', 'SovAI']);
  const hidden = ['nearAi.policy.show', 'nearAi.policy.edit', 'nearAi.policy.applyDraft', 'nearAi.policy.reset', 'nearAi.policy.showAsStored'];
  const palette = manifest.contributes.menus.commandPalette ?? [];
  for (const id of hidden) {
    assert.ok(find(id) !== undefined, `${id} is still contributed`);
    assert.deepEqual(palette.filter((entry) => entry.command === id), [{ command: id, when: 'false' }], id);
  }
  assert.equal(palette.some((entry) => entry.command === 'nearAi.policy.open'), false, 'SovAI: Policy stays in the palette');
  const pc = await computer();
  await windowOf(pc, { policyEditor: recordingPolicyEditor() });
  for (const id of [...hidden, 'nearAi.policy.open', ADD_RULES]) assert.ok(stub.commands.has(id), `${id} is registered`);
});

test('D-37: nearAi.privacyMode keeps its id and values, and says what it does in the glossary\'s words', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: unknown; description?: string; enumDescriptions?: string[] }> } };
  };
  const setting = manifest.contributes.configuration.properties['nearAi.privacyMode'];
  assert.ok(setting !== undefined);
  assert.deepEqual(setting.enum, ['standard', 'tee-only']);
  assert.equal(setting.default, 'standard');
  assert.equal(setting.description, "Where chats may run. Your organization's rules and each chat's label decide first.");
  assert.deepEqual(setting.enumDescriptions, [
    'Any model your rules allow; each answer shows where it ran and what was checked.',
    'Only verified private hardware or this computer: NEAR AI private hardware, checked each time it is used, or a model on this computer.'
  ]);
  const words = [setting.description, ...(setting.enumDescriptions ?? [])].join(' ');
  assert.ok(words.includes('Only verified private hardware or this computer'));
  assert.doesNotMatch(words, /TEE|\btiers?\b|Team Mode/i);
});

test('ordinary import resumes the exact confirmed handover after its invitation expires without asking for words again', async () => {
  const pc = await computer();
  await enrolledWindow(pc);
  const next = issuerKey('command-resume-issuer');
  const at = pc.clock.now;
  const handover = rotationTextFor(issuerKey(), next, { now: at, days: 1, layerDays: 5 });
  const store = new OrganizationStore(pc.storage, pc.secrets);
  setOrganizationWriteProbe((step, kind) => {
    if (step === 'pin-pending' && kind === 'rotate') throw new Error('fixture stops before staging');
  });
  try {
    await assert.rejects(store.accept(handover, { wordsConfirmed: true }, at), /fixture stops before staging/);
  } finally {
    setOrganizationWriteProbe(undefined);
  }
  pc.clock.now += 2 * DAY_MS;
  await windowOf(pc);
  assert.equal(await addRules(await fileWith(enrolmentTextFor(issuerKey()))), 'refused');
  assert.equal(stub.messageOptions.some((entry) => entry.modal === true), false);
  assert.equal(await addRules(await fileWith(handover)), 'rotated');
  assert.equal(stub.messageOptions.some((entry) => entry.modal === true), false);
  assert.equal(pinOf(pc)?.publicKey, next.publicKey);
  assert.equal(pinOf(pc)?.pending, undefined);
});
