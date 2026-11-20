// NEAR AI: Add Your Organization's Rules (FND-01, D-11 to D-14, D-20, D-23, D-27, D-44): every enrolment transition through the command a person runs,
// the one-time notices at start, who set the rules on the status bar and in the stored view, and the policy editor as the front door. Real files in
// temporary folders, an in-memory secret store, an in-memory memento and the recording vscode stub. Fictional names only (Example Organization).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ENROLMENT_FILE_EXTENSION, ISSUER_WORDS_MATCH, ORGANIZATION_RULES_FILE_EXTENSION, issuerDetailsLine, issuerFingerprintHex, issuerWords, issuerWordsPrompt,
  issuerWordsQuestion
} from '../domain/gate/enrolment';
import { POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import type { GateHost } from '../gate/host';
import { ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET } from '../gate/organizationStore';
import { enrolmentTextFor } from './helpers/enrolmentFixtures';
import { FIXED_NOW, issuerKey } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

const ADD_RULES = 'nearAi.organization.addRules';
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
