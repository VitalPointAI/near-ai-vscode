// package.json contributions for Team Mode and their registration: the seven commands, the pollSeconds setting, and no new dependency.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
const memberModule = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
test.after(() => { uninstall(); });

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    views: Record<string, Array<{ type?: string; id: string; name: string; when?: string; visibility?: string }>>;
    configuration: { properties: Record<string, { type?: string; default?: unknown; minimum?: number; maximum?: number; scope?: string; description?: string }> };
  };
}

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const EM_DASH = '—';

test('package.json contributes Enable Team Mode and Check Team Record (the verifyLog id) under the NEAR AI category', () => {
  const byId = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  const enable = byId.get('nearAi.team.enable');
  const verify = byId.get('nearAi.team.verifyLog');
  assert.deepEqual([enable?.title, enable?.category], ['Enable Team Mode', 'NEAR AI']);
  assert.deepEqual([verify?.title, verify?.category], ['Check Team Record', 'NEAR AI']);
  assert.equal(commandsModule.ENABLE_COMMAND, 'nearAi.team.enable');
  assert.equal(commandsModule.VERIFY_LOG_COMMAND, 'nearAi.team.verifyLog');
  assert.equal(barModule.VERIFY_LOG_COMMAND, commandsModule.VERIFY_LOG_COMMAND, 'the status bar item points at the registered command');
});

test('package.json contributes the five membership commands under the NEAR AI category with plain titles', () => {
  const byId = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  const expected: Array<[string, string]> = [
    ['nearAi.team.invite', 'Invite to Team'],
    ['nearAi.team.join', 'Join Team'],
    ['nearAi.team.manageMembers', 'Manage Team Members'],
    ['nearAi.team.linkNearOrganization', 'Link Team to NEAR Organization'],
    ['nearAi.team.signOutNear', 'Sign Out of NEAR (Team)']
  ];
  for (const [id, title] of expected) {
    const entry = byId.get(id);
    assert.deepEqual([entry?.title, entry?.category], [title, 'NEAR AI'], id);
    assert.ok((entry?.icon ?? '').startsWith('$('), `${id} has an icon`);
  }
  assert.equal(memberModule.INVITE_COMMAND, 'nearAi.team.invite');
  assert.equal(memberModule.LINK_NEAR_COMMAND, 'nearAi.team.linkNearOrganization');
  assert.equal(memberModule.SIGN_OUT_NEAR_COMMAND, 'nearAi.team.signOutNear');
});

test('the command ids kept in memberCommands equal the copies in teamSession, which solo activation never loads', () => {
  // memberCommands keeps its own copies so a solo project never loads the session module; this pins them to the session's.
  const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
  assert.equal(memberModule.JOIN_COMMAND, sessionModule.JOIN_COMMAND);
  assert.equal(memberModule.MANAGE_MEMBERS_COMMAND, sessionModule.MANAGE_MEMBERS_COMMAND);
  // The Import now button of the WR-02 notice runs the registered Import command.
  assert.equal(sessionModule.IMPORT_PLANS_COMMAND, commandsModule.IMPORT_PLANS_COMMAND);
});

test('package.json contributes Open Team Board and Import Plans to Team Board with plain titles and icons', () => {
  const byId = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  assert.deepEqual([byId.get('nearAi.team.openBoard')?.title, byId.get('nearAi.team.openBoard')?.category, byId.get('nearAi.team.openBoard')?.icon], ['Open Team Board', 'NEAR AI', '$(project)']);
  assert.deepEqual([byId.get('nearAi.team.importPlans')?.title, byId.get('nearAi.team.importPlans')?.category, byId.get('nearAi.team.importPlans')?.icon], ['Import Plans to Team Board', 'NEAR AI', '$(sync)']);
  assert.equal(commandsModule.OPEN_BOARD_COMMAND, 'nearAi.team.openBoard');
  assert.equal(commandsModule.IMPORT_PLANS_COMMAND, 'nearAi.team.importPlans');
  assert.equal(commandsModule.OPEN_BOARD_COMMAND, barModule.OPEN_BOARD_COMMAND, 'the status bar click lands on the registered command');
});

test('the Team Board view sits in the NEAR AI container after the chat view and shows only while Team Mode is on', () => {
  const views = manifest.contributes.views['nearAiSecondaryViewContainer'] ?? [];
  const chat = views.findIndex((entry) => entry.id === 'nearAiChatView');
  const board = views.findIndex((entry) => entry.id === 'nearAiTeamBoardView');
  assert.ok(chat >= 0 && board > chat, 'the board view follows the chat view');
  assert.deepEqual([views[board]?.type, views[board]?.name, views[board]?.when], ['webview', 'Team Board', 'nearAi.teamMode']);
  assert.equal(views[chat]?.when, undefined, 'the chat view is not gated');
  const boardModule = require('../services/team/boardView') as typeof import('../services/team/boardView');
  assert.equal(boardModule.BOARD_VIEW_ID, 'nearAiTeamBoardView');
  assert.equal(boardModule.BOARD_PANEL_TYPE, 'nearAiTeamBoard');
});

test('nearAi.team.pollSeconds is a number 5..3600, default 15, application scope, with a plain description', () => {
  const setting = manifest.contributes.configuration.properties['nearAi.team.pollSeconds'];
  assert.ok(setting !== undefined, 'the setting is contributed');
  assert.equal(setting.type, 'number');
  assert.equal(setting.default, 15);
  assert.equal(setting.minimum, 5);
  assert.equal(setting.maximum, 3600);
  assert.equal(setting.scope, 'application', 'a repository cannot change how often clients poll its remote');
  assert.ok((setting.description ?? '').length > 0);
  assert.equal((setting.description ?? '').includes(EM_DASH), false);
});

test('the command titles and descriptions contain no em-dash', () => {
  const text = JSON.stringify(manifest.contributes.commands.filter((entry) => entry.command.startsWith('nearAi.team.')));
  assert.equal(text.includes(EM_DASH), false);
});

test('registerTeamMode registers every contributed nearAi.team command', async () => {
  const contributed = manifest.contributes.commands.map((entry) => entry.command).filter((id) => id.startsWith('nearAi.team.'));
  assert.deepEqual([...contributed].sort(), [
    'nearAi.team.enable', 'nearAi.team.importPlans', 'nearAi.team.invite', 'nearAi.team.join', 'nearAi.team.linkNearOrganization', 'nearAi.team.manageMembers', 'nearAi.team.openBoard',
    'nearAi.team.signOutNear', 'nearAi.team.verifyLog'
  ]);
  const context = createFakeContext(path.join(ROOT, 'does-not-exist'), {});
  const handle = commandsModule.registerTeamMode(context as never);
  await handle.ready;
  const registered = new Set(stub.commands.keys());
  assert.deepEqual(contributed.filter((id) => !registered.has(id)), [], 'contributed commands without a handler');
  for (const subscription of context.subscriptions) subscription.dispose();
  assert.equal(stub.commands.size, 0, 'disposing the context unregisters the commands');
});

test('in a project without a team, every membership command except Join answers with how to turn Team Mode on and does nothing else', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-manifest-solo-'));
  const root = path.join(base, 'project');
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  try {
    stub.notifications.length = 0;
    stub.inputRequests.length = 0;
    stub.quickPickRequests.length = 0;
    stub.setWorkspaceFolders([root]);
    const context = createFakeContext(path.join(base, 'storage'), {});
    const handle = commandsModule.registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    for (const id of ['nearAi.team.invite', 'nearAi.team.manageMembers', 'nearAi.team.linkNearOrganization', 'nearAi.team.signOutNear']) {
      stub.notifications.length = 0;
      await (stub.commands.get(id) as () => Promise<void>)();
      assert.deepEqual(stub.notifications.map((entry) => entry.message), [commandsModule.SOLO_TEXT], id);
    }
    assert.equal(stub.inputRequests.length + stub.quickPickRequests.length, 0, 'no question was asked');
    assert.equal(handle.session(), undefined);
    for (const subscription of context.subscriptions) subscription.dispose();
  } finally {
    stub.setWorkspaceFolders([]);
    rmSync(base, { recursive: true, force: true });
  }
});

test('package.json dependencies and devDependencies equal those at the merge base with main', (t) => {
  let base: string;
  let before: Manifest;
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    before = JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Manifest;
  } catch {
    // A checkout without a local main branch (for example a packaged or shallow copy) has no merge base to compare with.
    t.skip('no merge base with main is available in this checkout');
    return;
  }
  assert.deepEqual(manifest.dependencies, before.dependencies);
  assert.deepEqual(manifest.devDependencies, before.devDependencies);
});
