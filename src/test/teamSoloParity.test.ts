// D-24 and TEAM-01: in a project without .planning/.near-ai/team.json, activation does one fs.stat and nothing else (no timers, output
// channel, status bar item, team storage or team core module), a team command only explains how to enable Team Mode, and a project with a
// team starts its session lazily. The vscode stub is installed for the whole file. Team modules are loaded lazily inside the team test, so
// require.cache can prove the solo tests loaded none of them.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, IMPORT_PLANS_COMMAND, OPEN_BOARD_COMMAND, SOLO_TEXT, VERIFY_LOG_COMMAND, registerTeamMode } = commandsModule;

const DIST_ROOT = path.resolve(__dirname, '..');
const TEAM_DIRS = ['team', path.join('domain', 'team'), path.join('services', 'team')].map((dir) => path.join(DIST_ROOT, dir) + path.sep);
const COMMANDS_FILE = path.join(DIST_ROOT, 'services', 'team', 'teamCommands.js');
// The membership commands are registered at activation too. Like teamCommands.js this module imports only vscode and Node built-ins; its handlers
// load the team core with dynamic imports, which the solo tests below prove never run.
const MEMBER_COMMANDS_FILE = path.join(DIST_ROOT, 'services', 'team', 'memberCommands.js');

// Every compiled team module in the module cache except the two command modules themselves.
function loadedTeamModules(): string[] {
  return Object.keys(require.cache).filter((file) => file !== COMMANDS_FILE && file !== MEMBER_COMMANDS_FILE && TEAM_DIRS.some((dir) => file.startsWith(dir)));
}

type TimerFn = (...args: unknown[]) => unknown;
interface TimerSpy { setTimeoutCalls: number[]; setIntervalCalls: number; cleared: unknown[]; created: Array<{ ms: number; handle: unknown }>; restore(): void }

function spyTimers(): TimerSpy {
  const g = globalThis as unknown as Record<'setTimeout' | 'setInterval' | 'clearTimeout', TimerFn>;
  const real = { setTimeout: g.setTimeout, setInterval: g.setInterval, clearTimeout: g.clearTimeout };
  const spy: TimerSpy = { setTimeoutCalls: [], setIntervalCalls: 0, cleared: [], created: [], restore: () => { Object.assign(g, real); } };
  g.setTimeout = (...args: unknown[]): unknown => {
    const handle = real.setTimeout(...args);
    const ms = typeof args[1] === 'number' ? args[1] : 0;
    spy.setTimeoutCalls.push(ms);
    spy.created.push({ ms, handle });
    return handle;
  };
  g.setInterval = (...args: unknown[]): unknown => { spy.setIntervalCalls += 1; return real.setInterval(...args); };
  g.clearTimeout = (...args: unknown[]): unknown => { spy.cleared.push(args[0]); return real.clearTimeout(...args); };
  return spy;
}

// Counts calls to the fs/promises functions a solo activation could use. Only stat is allowed, and only once.
function spyFs(): { calls: Record<string, number>; restore(): void } {
  const fsp = require('node:fs/promises') as unknown as Record<string, TimerFn>;
  const names = ['stat', 'lstat', 'access', 'readFile', 'readdir', 'mkdir', 'writeFile', 'open', 'rm', 'rename'];
  const calls: Record<string, number> = {};
  const real: Record<string, TimerFn> = {};
  for (const name of names) {
    const original = fsp[name] as TimerFn;
    real[name] = original;
    fsp[name] = (...args: unknown[]): unknown => { calls[name] = (calls[name] ?? 0) + 1; return original(...args); };
  }
  return { calls, restore: () => { for (const name of names) fsp[name] = real[name] as TimerFn; } };
}

function resetStub(): void {
  stub.outputChannels.length = 0;
  stub.statusBarItems.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.configUpdates.length = 0;
  stub.inputAnswers.length = 0;
  stub.messageAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.commands.clear();
  stub.webviewPanels.length = 0;
  stub.viewProviders.length = 0;
  stub.externalCommands.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.progress.length = 0;
  stub.setWorkspaceFolders([]);
}

function soloProject(): { root: string; storage: string; cleanup(): void } {
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-solo-'));
  const root = path.join(base, 'project');
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  return { root, storage: path.join(base, 'storage'), cleanup: () => { rmSync(base, { recursive: true, force: true }); } };
}

test('team modules are not loaded before anything calls registerTeamMode', () => {
  assert.deepEqual(loadedTeamModules(), [], 'importing teamCommands must not pull in the team core');
});

test('solo project: activation makes one fs.stat and no timers, channel, status item, storage or team module', async () => {
  resetStub();
  const project = soloProject();
  const timers = spyTimers();
  const fsCalls = spyFs();
  try {
    stub.setWorkspaceFolders([project.root]);
    const context = createFakeContext(project.storage, {});
    const handle = registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    timers.restore();
    fsCalls.restore();
    assert.deepEqual(fsCalls.calls, { stat: 1 }, 'one fs.stat and no other filesystem call');
    assert.deepEqual(timers.setTimeoutCalls, [], 'no setTimeout');
    assert.equal(timers.setIntervalCalls, 0, 'no setInterval');
    assert.equal(stub.outputChannels.length, 0, 'no output channel');
    assert.equal(stub.statusBarItems.length, 0, 'no status bar item');
    assert.equal(stub.notifications.length, 0, 'no message');
    assert.equal(existsSync(path.join(project.storage, 'team')), false, 'no team storage');
    assert.equal(existsSync(project.storage), false, 'no extension storage at all');
    assert.deepEqual(loadedTeamModules(), [], 'no compiled team module was loaded');
    assert.equal(handle.session(), undefined);
    assert.deepEqual([...stub.commands.keys()].sort(), [
      ENABLE_COMMAND, VERIFY_LOG_COMMAND, OPEN_BOARD_COMMAND, IMPORT_PLANS_COMMAND, 'nearAi.team.invite', 'nearAi.team.join', 'nearAi.team.manageMembers', 'nearAi.team.linkNearOrganization', 'nearAi.team.signOutNear'
    ].sort(), 'the nine Team Mode commands are registered and nothing else');
    assert.equal(stub.webviewPanels.length + stub.viewProviders.length, 0, 'no webview panel and no view provider');
    assert.deepEqual(stub.externalCommands, [], 'no context key is set');
  } finally {
    timers.restore();
    fsCalls.restore();
    project.cleanup();
  }
});

test('Open Team Board and Import Plans to Team Board in a solo project only explain how to turn Team Mode on and load nothing', async () => {
  resetStub();
  const project = soloProject();
  const timers = spyTimers();
  try {
    stub.setWorkspaceFolders([project.root]);
    const context = createFakeContext(project.storage, {});
    const handle = registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    for (const id of [OPEN_BOARD_COMMAND, IMPORT_PLANS_COMMAND]) {
      stub.notifications.length = 0;
      await stub.commands.get(id)?.();
      assert.deepEqual(stub.notifications, [{ level: 'info', message: SOLO_TEXT }], id);
      assert.deepEqual(stub.notificationActions[stub.notificationActions.length - 1], [], 'the explanation has no buttons');
    }
    // Run from the page's argument as well: the same answer.
    stub.notifications.length = 0;
    await stub.commands.get(IMPORT_PLANS_COMMAND)?.({ milestone: 'current' });
    assert.deepEqual(stub.notifications.map((entry) => entry.message), [SOLO_TEXT]);
    timers.restore();
    assert.deepEqual(timers.setTimeoutCalls, []);
    assert.equal(timers.setIntervalCalls, 0);
    assert.equal(stub.outputChannels.length + stub.statusBarItems.length, 0);
    assert.equal(stub.webviewPanels.length + stub.viewProviders.length, 0, 'no webview panel and no view provider');
    assert.equal(stub.progress.length, 0, 'no progress notification');
    assert.equal(stub.quickPickRequests.length, 0, 'no question');
    assert.deepEqual(stub.externalCommands, [], 'no context key');
    assert.deepEqual(loadedTeamModules(), [], 'no compiled team module was loaded');
    assert.equal(Object.keys(require.cache).some((file) => file.endsWith(path.join('services', 'team', 'boardView.js'))), false, 'the board module was not loaded');
  } finally {
    timers.restore();
    project.cleanup();
  }
});

test('no workspace folder resolves solo without touching the filesystem or timers', async () => {
  resetStub();
  const timers = spyTimers();
  const fsCalls = spyFs();
  try {
    const context = createFakeContext(path.join(tmpdir(), 'near-ai-solo-no-folder'), {});
    const handle = registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    timers.restore();
    fsCalls.restore();
    assert.deepEqual(fsCalls.calls, {});
    assert.deepEqual(timers.setTimeoutCalls, []);
    assert.equal(stub.outputChannels.length + stub.statusBarItems.length, 0);
    assert.deepEqual(loadedTeamModules(), []);
  } finally {
    timers.restore();
    fsCalls.restore();
  }
});

test('Verify Team Log in a solo project only explains how to turn Team Mode on', async () => {
  resetStub();
  const project = soloProject();
  const timers = spyTimers();
  try {
    stub.setWorkspaceFolders([project.root]);
    const context = createFakeContext(project.storage, {});
    const handle = registerTeamMode(context as never);
    await handle.ready;
    await stub.commands.get(VERIFY_LOG_COMMAND)?.();
    timers.restore();
    assert.deepEqual(stub.notifications, [{ level: 'info', message: SOLO_TEXT }]);
    assert.deepEqual(stub.notificationActions, [[]], 'the explanation has no buttons');
    assert.equal(SOLO_TEXT, 'Team Mode is not on for this project. Run "NEAR AI: Enable Team Mode" to turn it on.');
    assert.deepEqual(timers.setTimeoutCalls, []);
    assert.equal(timers.setIntervalCalls, 0);
    assert.equal(stub.statusBarItems.length, 0);
    assert.equal(stub.outputChannels.length, 0, 'the explanation is a message, not a channel');
    assert.equal(existsSync(path.join(project.storage, 'team')), false);
    assert.deepEqual(loadedTeamModules(), []);
  } finally {
    timers.restore();
    project.cleanup();
  }
});

test('Verify Team Log with no folder open also explains and does nothing else', async () => {
  resetStub();
  const context = createFakeContext(path.join(tmpdir(), 'near-ai-solo-no-folder-2'), {});
  const handle = registerTeamMode(context as never);
  await handle.ready;
  await stub.commands.get(VERIFY_LOG_COMMAND)?.();
  assert.deepEqual(stub.notifications.map((entry) => entry.message), [SOLO_TEXT]);
  assert.deepEqual(loadedTeamModules(), []);
});

test('a team project loads the session lazily, shows Team: <name> and stops its poll timer when disposed', async () => {
  resetStub();
  const harness = require('./helpers/teamHarness') as typeof import('./helpers/teamHarness');
  const { DEFAULT_COORDINATION_REF, GitTransport } = require('../team/gitTransport') as typeof import('../team/gitTransport');
  const { teamMaterializer } = require('../domain/team/materialize') as typeof import('../domain/team/materialize');
  const { newTeamId } = require('../team/identity') as typeof import('../team/identity');
  const { parseTeamFile, writeTeamFile } = require('../team/teamFile') as typeof import('../team/teamFile');
  const fixture = await harness.createTeamFixture({ clones: ['a'], initialised: true });
  const timers = spyTimers();
  const context = { current: undefined as ReturnType<typeof createFakeContext> | undefined };
  try {
    const teamId = newTeamId();
    const owner = await harness.createOwner(teamId);
    const genesis = harness.testGenesis({ teamId, owner, name: 'Parity team' });
    const projectRoot = fixture.clones['a'] as string;
    const seed = new GitTransport({
      mirrorDir: path.join(fixture.storageDir('seed'), 'coordination.git'), projectRoot, remote: 'origin', ref: DEFAULT_COORDINATION_REF,
      materializer: teamMaterializer(genesis.anchor), baseDelayMs: 1
    });
    assert.equal((await seed.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);
    await writeTeamFile(projectRoot, parseTeamFile(genesis.teamFileText));

    stub.setWorkspaceFolders([projectRoot]);
    const fakeContext = createFakeContext(fixture.storageDir('a'), owner.secrets);
    context.current = fakeContext;
    const handle = registerTeamMode(fakeContext as never);
    assert.equal(await handle.ready, 'team');
    assert.ok(handle.session() !== undefined, 'the session is available');
    assert.ok(Object.keys(require.cache).includes(path.join(DIST_ROOT, 'services', 'team', 'teamSession.js')), 'the session module was loaded once the team was found');
    assert.equal(stub.statusBarItems.length, 1);
    assert.equal(stub.statusBarItems[0]?.text, '$(organization) Team: Parity team');
    assert.equal(stub.statusBarItems[0]?.visible, true);
    assert.ok(stub.outputChannels.some((channel) => channel.name === 'NEAR AI Team'), 'the team output channel exists once there is a team');
    const polls = timers.created.filter((entry) => entry.ms === 15_000);
    assert.ok(polls.length >= 1, 'a poll timer is waiting at the default 15 seconds');

    for (const subscription of fakeContext.subscriptions) subscription.dispose();
    timers.restore();
    assert.ok(polls.every((entry) => timers.cleared.includes(entry.handle)), 'every poll timer was cleared when the context was disposed');
    assert.equal(stub.statusBarItems[0]?.disposed, true);
  } finally {
    timers.restore();
    for (const subscription of context.current?.subscriptions ?? []) subscription.dispose();
    await fixture.cleanup();
  }
});
