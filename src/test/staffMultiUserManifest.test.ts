// package.json contributions of the multi-user staff commands (plan 31-23, D-36, D-37) and the gate around them: the setting, the commands
// under NEAR AI with "Staff: " titles, each hidden from the Command Palette until the setting is on, plain words, none a Staff Room person decision,
// every one registered; and activation with the setting off loads nothing from src/staff/replica and makes no file, folder or secret (D-29).
// This file imports no replica module, so the module cache can prove the commands did not load one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS, STAFF_MULTI_USER_COMMANDS } from '../domain/staff/commands';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const staffCommands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const multi = require('../services/staffMultiUserCommands') as typeof import('../services/staffMultiUserCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');
test.after(() => { hosts.configureStaffHosts(undefined); uninstall(); });

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    keybindings: Array<{ command: string; key: string; mac?: string; linux?: string; win?: string; when: string }>;
    menus: { commandPalette?: Array<{ command: string; when?: string }> };
    configuration: { properties: Record<string, { type?: string; default?: unknown; scope?: string; description?: string }> };
  };
}

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const EM_DASH = '—';
const IDS = Object.values(STAFF_MULTI_USER_COMMANDS);
const REPLICA_DIR = path.join(path.resolve(__dirname, '..'), 'staff', 'replica') + path.sep;
const WHEN = 'config.nearAi.staff.multiUserPreview';
const SHOW_ATTRIBUTION = 'nearAi.staff.showWhoWroteThis';
const EDITOR_HISTORY = ['nearAi.staff.undoMyChange', 'nearAi.staff.redoMyChange'];

const TITLES: Readonly<Record<string, string>> = {
  'nearAi.staff.makeMultiUser': 'Staff: Make This Staff Project Multi-User',
  'nearAi.staff.inviteToProject': 'Staff: Invite to Staff Project',
  'nearAi.staff.joinProject': 'Staff: Join Staff Project',
  'nearAi.staff.admitToProject': 'Staff: Admit to Staff Project',
  'nearAi.staff.removeFromProject': 'Staff: Remove from Staff Project',
  'nearAi.staff.addMyOtherMachine': 'Staff: Add My Other Machine',
  'nearAi.staff.chooseRosterBranch': 'Staff: Choose Roster Branch',
  'nearAi.staff.nameDeputyLead': 'Staff: Name Deputy Lead',
  'nearAi.staff.handOverLead': 'Staff: Hand Over Staff Lead',
  'nearAi.staff.updateMember': 'Staff: Change a Staff Project Member',
  'nearAi.staff.makeSingleMachineCopy': 'Staff: Make a Single-Machine Copy',
  'nearAi.staff.startSharedHistoryAgain': 'Staff: Start This Computer\'s Shared History Again'
};

function plain(text: string, what: string): void {
  assert.equal(text.includes(EM_DASH), false, `${what} has an em-dash`);
  assert.equal(/organi[sz]ation/i.test(text.replace(/your organization/gi, '')), false, `${what}: an organization is only ever "your organization"`);
}

/** Every compiled module under dist/staff/replica that is loaded now. */
function loadedReplicaModules(): string[] {
  return Object.keys(require.cache).filter((file) => file.startsWith(REPLICA_DIR));
}

function tree(folder: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const relative = path.relative(folder, full);
      if (statSync(full).isDirectory()) { result[`${relative}/`] = 'dir'; walk(full); } else result[relative] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(folder);
  return result;
}

// First in the file, before any test could load a replica module.
test('activation with the setting off loads nothing from src/staff/replica, and every multi-user command then shows one message and makes no file, folder or secret', async () => {
  assert.deepEqual(loadedReplicaModules(), [], 'nothing loaded before activation');
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-mu-manifest-'));
  const root = path.join(base, 'project');
  mkdirSync(path.join(root, '.planning', 'staff', 'ledger'), { recursive: true });
  const storage = path.join(base, 'storage');
  const secrets = new MemorySecrets();
  const context = createFakeContext(storage, secrets);
  stub.setWorkspaceFolders([root]);
  stub.setConfig(multi.MULTI_USER_PREVIEW_SETTING, false);
  const before = tree(base);
  staffCommands.registerStaffCommands(context as never);
  assert.deepEqual(loadedReplicaModules(), [], 'activation loads no replica module');
  for (const id of IDS) {
    const shown = stub.notifications.length;
    // Answers a handler would use if it ran: none may be taken.
    stub.openDialogAnswers.push([root]);
    stub.saveDialogAnswers.push(path.join(base, 'file'));
    stub.inputAnswers.push('A. Demo', 'j2-analyst');
    stub.quickPickAnswers.push('member');
    await stub.commands.get(id)!();
    assert.equal(stub.notifications.length, shown + 1, `${id}: one message`);
    assert.deepEqual(stub.notifications[stub.notifications.length - 1], { level: 'info', message: multi.MULTI_USER_PREVIEW_OFF_TEXT }, id);
    // A modal dialog would show in messageOptions; the off message has none.
    assert.deepEqual([stub.openDialogAnswers.length, stub.saveDialogAnswers.length, stub.inputAnswers.length, stub.quickPickAnswers.length, stub.messageOptions.length], [1, 1, 2, 1, 0], `${id} asked nothing`);
    stub.openDialogAnswers.length = 0;
    stub.saveDialogAnswers.length = 0;
    stub.inputAnswers.length = 0;
    stub.quickPickAnswers.length = 0;
  }
  assert.deepEqual(loadedReplicaModules(), [], 'no command loaded a replica module');
  assert.deepEqual(tree(base), before, 'no file or folder was made, global storage included');
  assert.deepEqual([...secrets.values.keys()], [], 'no secret was made');
  for (const subscription of context.subscriptions) subscription.dispose();
  for (const id of IDS) assert.equal(stub.commands.has(id), false, `${id} is unregistered with the context`);
});

test('nearAi.staff.multiUserPreview is a boolean, off by default, application scope, with a plain description', () => {
  assert.equal(multi.MULTI_USER_PREVIEW_SETTING, 'nearAi.staff.multiUserPreview');
  const setting = manifest.contributes.configuration.properties[multi.MULTI_USER_PREVIEW_SETTING];
  assert.ok(setting !== undefined, 'the setting is contributed');
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
  assert.equal(setting.scope, 'application', 'a repository cannot turn multi-user staff projects on for the people who open it');
  assert.ok((setting.description ?? '').length > 0);
  plain(setting.description ?? '', 'the setting description');
  assert.match(setting.description ?? '', /declared by the staff lead, not verified/);
});

test('each multi-user command is contributed under NEAR AI with its "Staff: " title', () => {
  assert.deepEqual([...IDS].sort(), Object.keys(TITLES).sort());
  for (const id of IDS) {
    const entries = manifest.contributes.commands.filter((entry) => entry.command === id);
    assert.deepEqual(entries, [{ command: id, title: TITLES[id], category: 'NEAR AI' }], id);
    plain(TITLES[id], id);
  }
});

test('the Command Palette gates multi-user commands and hides editor history commands', () => {
  const palette = manifest.contributes.menus.commandPalette ?? [];
  for (const id of IDS) assert.deepEqual(palette.filter((entry) => entry.command === id), [{ command: id, when: WHEN }], id);
  const staffEntries = palette.filter((entry) => entry.command.startsWith('nearAi.staff.'));
  assert.deepEqual(staffEntries.map((entry) => entry.command).sort(), [...IDS, ...EDITOR_HISTORY, SHOW_ATTRIBUTION].sort());
  for (const command of EDITOR_HISTORY) assert.deepEqual(staffEntries.filter((entry) => entry.command === command), [{ command, when: 'false' }]);
  assert.equal(JSON.stringify(manifest).split(WHEN).length - 1, IDS.length, 'each when clause names the setting exactly');
});

test('the attribution command appears only for a bound editor', () => {
  assert.deepEqual(manifest.contributes.commands.filter(({ command }) => command === SHOW_ATTRIBUTION), [
    { command: SHOW_ATTRIBUTION, title: 'Staff: Show Who Wrote This', category: 'NEAR AI' }
  ]);
  assert.deepEqual(manifest.contributes.menus.commandPalette?.filter(({ command }) => command === SHOW_ATTRIBUTION), [
    { command: SHOW_ATTRIBUTION, when: 'nearAi.staffBoundEditor' }
  ]);
});

test('shared history shortcuts only resolve when the bound text editor has focus', () => {
  const [undo, redo] = EDITOR_HISTORY;
  const when = 'editorTextFocus && nearAi.staffBoundEditor';
  assert.deepEqual(manifest.contributes.commands.filter(({ command }) => EDITOR_HISTORY.includes(command)), [
    { command: undo, title: 'Staff: Undo My Change', category: 'NEAR AI' },
    { command: redo, title: 'Staff: Redo My Change', category: 'NEAR AI' }
  ]);
  assert.deepEqual(manifest.contributes.keybindings.filter(({ command }) => EDITOR_HISTORY.includes(command)), [
    { command: undo, key: 'ctrl+z', mac: 'cmd+z', when },
    { command: redo, key: 'ctrl+shift+z', mac: 'cmd+shift+z', when },
    { command: redo, key: '', linux: 'ctrl+y', win: 'ctrl+y', when }
  ]);
});

test('none of the commands is a Staff Room person decision or an existing staff command, and no agent source names one', () => {
  for (const id of IDS) {
    assert.equal(PERSON_DECISION_COMMANDS.includes(id), false, id);
    assert.equal((Object.values(STAFF_COMMANDS) as string[]).includes(id), false, id);
  }
  const agentDir = path.join(ROOT, 'src', 'agent');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else if (name.endsWith('.ts')) files.push(full);
    }
  };
  walk(agentDir);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const id of IDS) assert.equal(text.includes(id), false, `${path.relative(ROOT, file)} names ${id}`);
  }
});

test('registerStaffCommands registers every contributed multi-user command', () => {
  stub.commands.clear();
  const context = createFakeContext(path.join(tmpdir(), 'near-ai-mu-manifest-none'), new MemorySecrets());
  staffCommands.registerStaffCommands(context as never);
  const contributed = manifest.contributes.commands.map((entry) => entry.command).filter((id) => IDS.includes(id as (typeof IDS)[number]));
  assert.equal(contributed.length, Object.keys(TITLES).length);
  assert.deepEqual(contributed.filter((id) => !stub.commands.has(id)), [], 'contributed commands without a handler');
  for (const subscription of context.subscriptions) subscription.dispose();
});
