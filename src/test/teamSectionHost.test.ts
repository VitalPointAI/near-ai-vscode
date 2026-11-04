// The sidebar Team section host (G-61-5, plan 61-21): it feeds the Team section model to the NEAR AI chat sidebar and runs the Team Mode command
// mapped to a clicked button. The page is untrusted, so only {type:'team-action', action} with an action from the fixed list runs anything, and only
// the command TEAM_ACTION_COMMANDS maps it to. The vscode stub is installed for the whole file; the host itself needs only types from vscode.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { planShare, shareTeamSetup } from '../team/projectHome';
import { readTeamFile } from '../team/teamFile';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
test.after(() => { uninstall(); });
const hostModule = require('../services/team/teamSectionHost') as typeof import('../services/team/teamSectionHost');
const { createTeamSectionHost, parseTeamSectionMessage } = hostModule;
const { TEAM_ACTION_COMMANDS } = require('../domain/team/teamSection') as typeof import('../domain/team/teamSection');
const text = require('../domain/team/teamSectionText') as typeof import('../domain/team/teamSectionText');
const { ENABLE_COMMAND, registerTeamMode } = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const { INVITE_COMMAND, JOIN_COMMAND, MANAGE_MEMBERS_COMMAND, NOT_NOW_CHOICE } = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
type TeamModeHandle = import('../services/team/teamCommands').TeamModeHandle;
type TeamSession = import('../services/team/teamSession').TeamSession;
type Model = import('../domain/team/teamSection').TeamSectionModel;
type Role = import('../domain/team/types').Role;
type SharedView = import('../domain/team/teamSection').SharedView;

// A Team Mode handle with no session (a project without a team, or Team Mode not started), whose change listeners the test can fire. Just me for
// now is kept in memory here, as the real handle keeps it in VS Code's workspace state, and setJustMe tells the listeners.
function soloHandle(): TeamModeHandle & { fire(): void; listeners: number; justMeCalls: boolean[] } {
  const listeners = new Set<() => void>();
  const justMeCalls: boolean[] = [];
  let justMe = false;
  const fire = (): void => { for (const listener of [...listeners]) listener(); };
  return {
    ready: Promise.resolve('solo'),
    session: () => undefined,
    onDidChange(listener: () => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    boardSummary: () => undefined,
    justMe: () => justMe,
    async setJustMe(value: boolean) { justMeCalls.push(value); justMe = value; fire(); },
    fire,
    justMeCalls,
    get listeners() { return listeners.size; }
  };
}

function soloProject(): { root: string; cleanup(): void } {
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-section-'));
  const root = path.join(base, 'project');
  mkdirSync(path.join(root, '.planning'), { recursive: true });
  return { root, cleanup: () => { rmSync(base, { recursive: true, force: true }); } };
}

type Webview = Parameters<ReturnType<typeof createTeamSectionHost>['attach']>[0];
function webviewView(): { webview: Webview; record: RecordedWebview; view: { visible: boolean; onDidChangeVisibility(listener: () => void): { dispose(): void } } } {
  const made = stub.createWebviewView();
  const view = made.view as { webview: Webview; visible: boolean; onDidChangeVisibility(listener: () => void): { dispose(): void } };
  return { webview: view.webview, record: made.record, view };
}

const states = (record: RecordedWebview): Array<Model | null> =>
  record.posted.filter((message): message is { type: 'team-state'; model: Model | null } => (message as { type?: string }).type === 'team-state').map((message) => message.model);
const lastState = (record: RecordedWebview): Model | null | undefined => states(record).at(-1);

// ---- Task 1: the tracer ------------------------------------------------------------------------------------------------------------------

test('tracer: a project with no team gets Invite someone (primary), Join a team and Just me for now, and Invite someone runs the invite', async () => {
  const project = soloProject();
  const commands: string[] = [];
  const host = createTeamSectionHost({
    team: soloHandle(), firstFolder: () => project.root, testSeams: false,
    executeCommand: async (command: string) => { commands.push(command); return undefined; }
  });
  try {
    const { webview, record } = webviewView();
    host.attach(webview);
    await host.refresh();
    const first = states(record)[0];
    assert.ok(first, 'a team-state was posted on attach');
    assert.deepEqual(first.actions.map((action) => [action.id, action.primary]), [['invite', true], ['join', false], ['solo', false]]);
    assert.equal(first.heading, 'Working with your agents');
    assert.equal(first.placement, 'section');
    const before = states(record).length;
    await record.receive({ type: 'team-action', action: 'invite' });
    assert.deepEqual(commands, [INVITE_COMMAND], 'the invite ran once');
    assert.equal(states(record).length, before + 1, 'a fresh team-state follows the command');
  } finally {
    host.dispose();
    project.cleanup();
  }
});

// Lists every file under a folder, so a test can see that nothing was written.
function filesIn(dir: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return (readdirSync(dir, { recursive: true }) as string[]).map(String).sort();
}

test('Just me for now keeps the choice through the handle only: no command, no file, no event, and the next model is the quiet empty-chat line', async () => {
  const project = soloProject();
  const commands: string[] = [];
  const handle = soloHandle();
  const host = createTeamSectionHost({ team: handle, firstFolder: () => project.root, testSeams: false, executeCommand: async (command: string) => { commands.push(command); return undefined; } });
  try {
    const { webview, record } = webviewView();
    host.attach(webview);
    await host.refresh();
    const files = filesIn(project.root);
    assert.deepEqual(parseTeamSectionMessage({ type: 'team-action', action: 'solo' }), { type: 'team-action', action: 'solo' });
    await record.receive({ type: 'team-action', action: 'solo' });
    await host.refresh();
    assert.deepEqual(handle.justMeCalls, [true], 'the choice went to the handle once');
    assert.deepEqual(commands, [], 'no command ran');
    assert.deepEqual(filesIn(project.root), files, 'no file was written in the project');
    const model = lastState(record);
    assert.equal(model?.placement, 'empty-chat-line');
    assert.equal(model?.status, text.TEAM_STATUS.justMe);
    assert.deepEqual(model?.actions.map((action) => [action.id, action.label]), [['invite', 'Invite people'], ['join', 'Join a team']]);
    // The quiet line's links run the same commands as the section's buttons.
    await record.receive({ type: 'team-action', action: 'join' });
    assert.deepEqual(commands, [JOIN_COMMAND]);
  } finally {
    host.dispose();
    project.cleanup();
  }
});

test('Just me for now is ignored once the project has a team, and turn-on is no longer an action the page can post', async () => {
  assert.equal(parseTeamSectionMessage({ type: 'team-action', action: 'turn-on' }), undefined, 'turn-on is refused');
  assert.equal(parseTeamSectionMessage({ type: 'team-action', action: 'solo', extra: 1 }), undefined);
  const fake = fakeSession({ me: 'owner', members: LEAD_TEAM });
  const t = fakeHost(fake.session);
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    await t.handle.setJustMe(true);
    await t.host.refresh();
    assert.equal(lastState(t.record)?.placement, 'section', 'a team project draws its section');
    assert.deepEqual(t.commands, []);
  } finally {
    t.cleanup();
  }
});

test('with no folder open the section is hidden: the model is null', async () => {
  const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => undefined, testSeams: false, executeCommand: async () => undefined });
  try {
    const { webview, record } = webviewView();
    host.attach(webview);
    await host.refresh();
    assert.ok(states(record).length >= 1);
    assert.equal(lastState(record), null);
  } finally {
    host.dispose();
  }
});

test('every action id runs only the command mapped to it', async () => {
  const project = soloProject();
  const commands: string[] = [];
  const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => project.root, testSeams: false, executeCommand: async (command: string) => { commands.push(command); return undefined; } });
  try {
    const { webview, record } = webviewView();
    host.attach(webview);
    for (const [action, command] of Object.entries(TEAM_ACTION_COMMANDS)) {
      commands.length = 0;
      await record.receive({ type: 'team-action', action });
      assert.deepEqual(commands, [command], action);
    }
  } finally {
    host.dispose();
    project.cleanup();
  }
});

test('the page cannot make the host run anything else: unknown actions, command ids, extra keys and junk are refused', async () => {
  const refused: unknown[] = [
    { type: 'team-action', action: 'delete-everything' },
    { type: 'team-action', action: 'nearAi.team.enable' },
    { type: 'team-action', action: 'workbench.action.terminal.new' },
    { type: 'team-action', action: 'turn-on', command: 'workbench.action.terminal.new' },
    { type: 'team-action', action: 'turn-on', extra: 1 },
    { type: 'team-action', action: ['turn-on'] },
    { type: 'team-action', action: 'TURN-ON' },
    { type: 'team-action', action: 'constructor' },
    { type: 'team-action', action: '__proto__' },
    { type: 'team-action' },
    { type: 'command', command: 'nearAi.team.enable' },
    ['team-action', 'turn-on'],
    [{ type: 'team-action', action: 'turn-on' }],
    'team-action',
    'turn-on',
    42,
    null,
    undefined,
    Object.assign(Object.create({ type: 'team-action', action: 'turn-on' }) as object, {})
  ];
  for (const value of refused) assert.equal(parseTeamSectionMessage(value), undefined, JSON.stringify(value));
  assert.deepEqual(parseTeamSectionMessage({ type: 'team-action', action: 'invite' }), { type: 'team-action', action: 'invite' });

  const project = soloProject();
  const commands: string[] = [];
  const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => project.root, testSeams: false, executeCommand: async (command: string) => { commands.push(command); return undefined; } });
  try {
    const { webview, record } = webviewView();
    host.attach(webview);
    for (const value of refused) await record.receive(value);
    assert.deepEqual(commands, [], 'no refused message ran a command');
  } finally {
    host.dispose();
    project.cleanup();
  }
});

test('extension.ts builds the host from the Team Mode handle and gives it to the sidebar before the view provider is registered', () => {
  const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
  const created = source.indexOf('createTeamSectionHost({ team');
  const handed = source.indexOf('sidebar.setTeamSection(');
  const registered = source.indexOf('registerWebviewViewProvider(NearAiPanelViewProvider.viewId');
  assert.ok(source.indexOf('registerTeamMode(') < created, 'the host is made from the registerTeamMode handle');
  assert.ok(created > 0 && handed > created, 'the host is handed to the sidebar');
  assert.ok(registered > handed, 'before the sidebar view provider is registered');
  assert.match(source, /context\.subscriptions\.push\(teamSection\)/, 'the host is disposed with the extension');
});

// ---- Task 2: the team states from the running session ------------------------------------------------------------------------------------

interface FakeMember { id: string; name: string; role: Role; pendingRole?: Role; status?: 'invited'; removedEvent?: string; invitedEvent?: string; invite?: { commitTime: number; ttlSeconds: number } }
interface FakeOptions { me?: string; members: FakeMember[]; name?: string; ownerId?: string; linked?: boolean; removed?: boolean; status?: { kind: 'live' | 'syncing' | 'offline' | 'paused' | 'removed'; text: string } }

// A session as the host reads it: the team state, this computer's member id, the removed flag, the connection chip and state change listeners.
function fakeSession(options: FakeOptions): { session: TeamSession; fire(): void; listeners(): number } {
  const listeners = new Set<() => void>();
  const name = options.name ?? 'Harbor';
  const members = new Map(options.members.map((member) => [member.id, { devices: [], emailHashes: [], skills: [], availability: 'available', wipLimit: 2, joinedAt: '', joinedEvent: 'e0', ...member }]));
  const teamFile = {
    version: 1, teamId: 'team-1', name, coordination: { transport: 'git', ref: 'refs/near-ai/team', remote: 'origin' }, genesis: { eventId: 'e0', ownerDevice: {} }, createdAt: '',
    ...(options.linked === true ? { near: { organizationId: 'org-1', workspaceId: 'ws-1' } } : {})
  };
  const state = { team: { id: 'team-1', name, ownerId: options.ownerId ?? 'owner', policy: { integrationBranch: 'main' } }, members, deviceIndex: new Map() };
  const session = {
    teamFile,
    state: () => state,
    memberId: () => options.me,
    isRemoved: () => options.removed === true,
    boardStatus: () => options.status ?? { kind: 'live', text: 'Live' },
    onStateChange(listener: () => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }
  };
  return { session: session as unknown as TeamSession, fire: () => { for (const listener of [...listeners]) listener(); }, listeners: () => listeners.size };
}

function teamHandle(initial: TeamSession | undefined): TeamModeHandle & { fire(): void; setSession(session: TeamSession | undefined): void } {
  let current = initial;
  let justMe = false;
  const listeners = new Set<() => void>();
  const fire = (): void => { for (const listener of [...listeners]) listener(); };
  return {
    ready: Promise.resolve(current === undefined ? 'solo' : 'team'),
    session: () => current,
    onDidChange(listener: () => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    boardSummary: () => undefined,
    justMe: () => justMe,
    async setJustMe(value: boolean) { justMe = value; fire(); },
    fire,
    setSession(session: TeamSession | undefined) { current = session; }
  };
}

const LEAD_TEAM: FakeMember[] = [{ id: 'owner', name: 'Olive', role: 'owner' }, { id: 'lead', name: 'Lee', role: 'lead' }, { id: 'dev', name: 'Dev', role: 'developer' }];

// A host over a fake session in a folder without team.json, with a counting shared check and a clock the test moves.
function fakeHost(session: TeamSession | undefined, over: Partial<import('../services/team/teamSectionHost').TeamSectionHostDeps> = {}) {
  const project = soloProject();
  const handle = teamHandle(session);
  const clock = { now: 1_000 };
  const checks: Array<{ projectRoot: string; teamFile: unknown; branch: string }> = [];
  const commands: string[] = [];
  let shared: SharedView = 'yes';
  const host = createTeamSectionHost({
    team: handle, firstFolder: () => project.root, testSeams: false, now: () => clock.now,
    executeCommand: async (command: string) => { commands.push(command); return undefined; },
    checkShared: async (input) => { checks.push(input); return shared; },
    ...over
  });
  const { webview, record, view } = webviewView();
  return {
    host, handle, clock, checks, commands, record, view, webview, project,
    setShared(value: SharedView) { shared = value; },
    cleanup() { host.dispose(); project.cleanup(); }
  };
}

test('a removed member sees only the removed sentence and no button', async () => {
  const fake = fakeSession({ me: 'dev', members: LEAD_TEAM.map((member) => (member.id === 'dev' ? { ...member, removedEvent: 'e9' } : member)), removed: true, status: { kind: 'removed', text: 'Removed' } });
  const t = fakeHost(fake.session);
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    const model = lastState(t.record);
    assert.equal(model?.status, text.TEAM_STATUS.removed);
    assert.deepEqual(model?.actions, []);
    assert.equal(t.checks.length, 0, 'no online check for a removed member');
  } finally {
    t.cleanup();
  }
});

test('an offline session puts Check the team first and says what the connection says', async () => {
  const fake = fakeSession({ me: 'lead', members: LEAD_TEAM, status: { kind: 'offline', text: 'Offline: the team could not be reached' } });
  const t = fakeHost(fake.session);
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    const model = lastState(t.record);
    assert.equal(model?.status, 'Offline: the team could not be reached.');
    assert.equal(model?.actions[0]?.id, 'check');
    assert.equal(model?.actions[0]?.primary, true);
    assert.ok(model?.actions.some((action) => action.id === 'members'), 'the rest is still offered');
  } finally {
    t.cleanup();
  }
});

test('the online check runs only for the owner or a lead: a developer never calls it', async () => {
  const developer = fakeHost(fakeSession({ me: 'dev', members: LEAD_TEAM }).session);
  try {
    developer.host.attach(developer.webview);
    await developer.host.refresh();
    await developer.host.refresh({ recheckShared: true });
    assert.equal(developer.checks.length, 0);
    const model = lastState(developer.record);
    assert.equal(model?.status, text.memberStatus('Harbor'));
    assert.deepEqual(model?.actions.map((action) => action.id), ['board', 'members']);
  } finally {
    developer.cleanup();
  }
  const lead = fakeHost(fakeSession({ me: 'lead', members: LEAD_TEAM }).session);
  try {
    lead.setShared('no');
    lead.host.attach(lead.webview);
    await lead.host.refresh();
    assert.equal(lead.checks.length, 1, 'a lead is checked once');
    assert.deepEqual(lead.checks[0], { projectRoot: lead.project.root, teamFile: (lead.handle.session() as unknown as { teamFile: unknown }).teamFile, branch: 'main' });
    const model = lastState(lead.record);
    assert.equal(model?.actions[0]?.id, 'share');
    assert.equal(model?.status, text.notSharedStatus('Harbor'));
  } finally {
    lead.cleanup();
  }
});

test('the online check runs at most once a minute when the sidebar is shown, and right after a share, invite, link or join', async () => {
  const fake = fakeSession({ me: 'owner', members: LEAD_TEAM });
  let visible = true;
  const t = fakeHost(fake.session);
  try {
    t.host.attach(t.webview, t.view.onDidChangeVisibility.bind(t.view) as never, () => visible);
    await t.host.refresh();
    assert.equal(t.checks.length, 1);
    // Hidden, then shown again within the minute: a fresh model and no second check.
    visible = false;
    t.record.setVisible(false);
    await t.host.refresh();
    assert.equal(t.checks.length, 1, 'no check while the sidebar is hidden');
    const posted = states(t.record).length;
    visible = true;
    t.record.setVisible(true);
    await t.host.refresh();
    assert.ok(states(t.record).length > posted, 'showing the sidebar posts a model');
    assert.equal(t.checks.length, 1, 'not again within 60 seconds');
    t.clock.now += 60_001;
    visible = false;
    t.record.setVisible(false);
    visible = true;
    t.record.setVisible(true);
    await t.host.refresh();
    assert.equal(t.checks.length, 2, 'again once a minute has passed');
    // Actions that change what is online are followed by a check at once; the others are not.
    for (const action of ['share', 'invite', 'link', 'join']) {
      const before: number = t.checks.length;
      await t.record.receive({ type: 'team-action', action });
      await t.host.refresh();
      assert.equal(t.checks.length, before + 1, `${action} is followed by a check`);
    }
    for (const action of ['members', 'board', 'check', 'solo']) {
      const before: number = t.checks.length;
      await t.record.receive({ type: 'team-action', action });
      await t.host.refresh();
      assert.equal(t.checks.length, before, `${action} is not`);
    }
    // An explicit recheck always checks.
    const before: number = t.checks.length;
    await t.host.refresh({ recheckShared: true });
    assert.equal(t.checks.length, before + 1);
  } finally {
    t.cleanup();
  }
});

test('the section follows Team Mode: a handle change, a session update and a restart each post a new model', async () => {
  const first = fakeSession({ me: 'dev', members: LEAD_TEAM });
  const t = fakeHost(undefined);
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    assert.deepEqual(lastState(t.record)?.actions.map((action) => action.id), ['invite', 'join', 'solo'], 'no session yet: no team');
    t.handle.setSession(first.session);
    t.handle.fire();
    await t.host.refresh();
    assert.equal(lastState(t.record)?.status, text.memberStatus('Harbor'), 'Team Mode started');
    assert.equal(first.listeners(), 1, 'the session is followed');

    let count = states(t.record).length;
    first.fire();
    await t.host.refresh();
    assert.ok(states(t.record).length > count, 'a session update posts a model');

    // A restart brings a new session object: the old one is let go and the new one followed.
    const second = fakeSession({ me: 'lead', members: LEAD_TEAM, name: 'Harbor two' });
    t.handle.setSession(second.session);
    t.handle.fire();
    await t.host.refresh();
    assert.equal(lastState(t.record)?.heading, text.teamHeading('Harbor two'));
    assert.equal(first.listeners(), 0, 'the old session is no longer followed');
    assert.equal(second.listeners(), 1);
    count = states(t.record).length;
    first.fire();
    await t.host.refresh();
    second.fire();
    await t.host.refresh();
    assert.ok(states(t.record).length > count);

    // Team Mode stops: back to no team.
    t.handle.setSession(undefined);
    t.handle.fire();
    await t.host.refresh();
    assert.equal(second.listeners(), 0);
  } finally {
    t.cleanup();
  }
});

test('the board summary slot: shown when the provider gives counts, and absent when it gives nothing', async () => {
  let summary: { ready: number; blocked: number; mine: number } | undefined = { ready: 3, blocked: 1, mine: 2 };
  const t = fakeHost(fakeSession({ me: 'dev', members: LEAD_TEAM }).session, { boardSummary: () => summary });
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    assert.deepEqual(lastState(t.record)?.board, { ready: 3, blocked: 1, mine: 2, text: text.boardSummaryText(3, 1, 2) });
    summary = undefined;
    await t.host.refresh();
    assert.equal(lastState(t.record)?.board, undefined);
  } finally {
    t.cleanup();
  }
});

test('a second click while a team action still runs is ignored, and buttons work again once it has finished', async () => {
  const commands: string[] = [];
  let finish: (() => void) | undefined;
  const t = fakeHost(fakeSession({ me: 'dev', members: LEAD_TEAM }).session, {
    executeCommand: (command: string) => { commands.push(command); return new Promise<unknown>((resolve) => { finish = () => { resolve(undefined); }; }); }
  });
  try {
    t.host.attach(t.webview);
    const running = t.record.receive({ type: 'team-action', action: 'board' });
    await new Promise((resolve) => setImmediate(resolve));
    await t.record.receive({ type: 'team-action', action: 'members' });
    assert.deepEqual(commands, ['nearAi.team.openBoard'], 'the second click ran nothing');
    finish?.();
    await running;
    const after = t.record.receive({ type: 'team-action', action: 'members' });
    await new Promise((resolve) => setImmediate(resolve));
    finish?.();
    await after;
    assert.deepEqual(commands, ['nearAi.team.openBoard', 'nearAi.team.manageMembers']);
  } finally {
    t.cleanup();
  }
});

test('names from the team record are shown as safe plain text', async () => {
  const t = fakeHost(fakeSession({ me: 'dev', members: LEAD_TEAM, name: 'Harbor\n<b>x</b> $(alert)\u0007' }).session);
  try {
    t.host.attach(t.webview);
    await t.host.refresh();
    const heading = lastState(t.record)?.heading ?? '';
    assert.match(heading, /^Team: Harbor /, 'the team name is shown');
    assert.doesNotMatch(heading, /[\n\u0007]/);
    assert.doesNotMatch(heading, /(^|[^\\])\$\(/, 'no icon syntax');
  } finally {
    t.cleanup();
  }
});

// ---- the real lead and joiner windows ----------------------------------------------------------------------------------------------------

const PUBLIC_URL = 'https://example.invalid/team.git';
const copyWhenOffered = (_text: string, actions: string[]): string | undefined => (actions.includes('Copy invite') ? 'Copy invite' : undefined);

function resetStub(): void {
  for (const list of [stub.outputChannels, stub.statusBarItems, stub.notifications, stub.notificationActions, stub.notificationOptions, stub.inputAnswers, stub.inputRequests,
    stub.messageAnswers, stub.quickPickAnswers, stub.quickPickRequests, stub.clipboardWrites, stub.externalCommands, stub.progress]) (list as unknown[]).length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
}

async function removeFixture(fixture: TeamFixture): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fixture.cleanup();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface Window { root: string; context: ReturnType<typeof createFakeContext>; handle: TeamModeHandle; run(command: string): Promise<void> }

async function openWindow(fixture: TeamFixture, clone: string, secrets: MemorySecrets): Promise<Window> {
  const root = fixture.clones[clone] as string;
  const context = createFakeContext(fixture.storageDir(clone), secrets);
  stub.setWorkspaceFolders([root]);
  const handle = registerTeamMode(context as never);
  await handle.ready;
  const own = new Map(stub.commands);
  return {
    root, context, handle,
    run: async (command: string) => { const handler = own.get(command); assert.ok(handler !== undefined, `${command} is registered`); await handler(); }
  };
}

async function closeWindow(window: Window | undefined): Promise<void> {
  if (window === undefined) return;
  await window.handle.session()?.sync();
  for (const subscription of window.context.subscriptions) subscription.dispose();
}

test('a real lead and joiner: Share first, then Invite; the joiner waits; the lead sees 1 waiting until they confirm', async () => {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a', 'b'], initialised: true });
  let lead: Window | undefined;
  let joiner: Window | undefined;
  const hosts: Array<ReturnType<typeof createTeamSectionHost>> = [];
  try {
    lead = await openWindow(fixture, 'a', new MemorySecrets());
    const root = lead.root;
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.inputAnswers.push('Invite team', 'Lead Owner', 'lead@example.invalid');
    await lead.run(ENABLE_COMMAND);
    assert.equal(lead.handle.session()?.teamFile.name, 'Invite team');

    const leadHost = createTeamSectionHost({ team: lead.handle, firstFolder: () => root, executeCommand: async () => undefined, now: () => 0, testSeams: false });
    hosts.push(leadHost);
    const leadView = webviewView();
    leadHost.attach(leadView.webview);
    await leadHost.refresh();
    let model = lastState(leadView.record);
    assert.equal(model?.actions[0]?.id, 'share', `not shared yet: ${JSON.stringify(model)}`);
    assert.equal(model?.status, text.notSharedStatus('Invite team'));

    const teamFile = await readTeamFile(root);
    assert.ok(teamFile !== undefined);
    const plan = await planShare({ projectRoot: root, teamFile, branch: 'main' });
    assert.equal((await shareTeamSetup({ projectRoot: root, teamFile, branch: 'main', plan })).ok, true);
    await leadHost.refresh({ recheckShared: true });
    model = lastState(leadView.record);
    assert.equal(model?.actions[0]?.id, 'invite', `shared: ${JSON.stringify(model)}`);
    assert.equal(model?.status, text.onlyYouStatus(0));
    assert.equal(model?.actions.some((action) => action.id === 'link'), false, 'linking is offered by the invite and in Members, not as a button here');

    // The lead invites a developer; the bundle comes back from the clipboard.
    stub.inputAnswers.push('Dana', 'dana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder(copyWhenOffered);
    await lead.run(INVITE_COMMAND);
    stub.setMessageResponder(undefined);
    const bundle = stub.clipboardWrites.at(-1);
    assert.ok(bundle !== undefined, 'the invite was copied');
    gitIn(root, ['push', '-q', 'origin', 'main']);

    // A teammate's window before joining: this computer is not on the team.
    const other = fixture.clones['b'] as string;
    gitIn(other, ['pull', '-q', '--ff-only']);
    joiner = await openWindow(fixture, 'b', new MemorySecrets());
    const joinerHost = createTeamSectionHost({ team: joiner.handle, firstFolder: () => other, executeCommand: async () => undefined, now: () => 0, testSeams: false });
    hosts.push(joinerHost);
    const joinerView = webviewView();
    joinerHost.attach(joinerView.webview);
    await joinerHost.refresh();
    model = lastState(joinerView.record);
    assert.equal(model?.actions[0]?.id, 'join', `not on the team: ${JSON.stringify(model)}`);
    assert.equal(model?.status, text.notOnTeamStatus('Invite team'));

    stub.inputAnswers.push(bundle, 'Dana D');
    await joiner.run(JOIN_COMMAND);
    await joinerHost.refresh();
    model = lastState(joinerView.record);
    assert.equal(model?.status, text.waitingStatus('Invite team'), `joined and waiting: ${JSON.stringify(model)}`);
    assert.equal(model?.actions.some((action) => action.id === 'invite'), false);
    assert.deepEqual(model?.actions.map((action) => action.id), ['board']);

    // The lead's window learns about the join on its next sync.
    stub.setWorkspaceFolders([root]);
    await lead.handle.session()?.sync();
    await leadHost.refresh();
    model = lastState(leadView.record);
    const members = model?.actions.find((action) => action.id === 'members');
    assert.equal(members?.badge, '1 waiting', JSON.stringify(model));
    assert.deepEqual(model?.actions.map((action) => action.id), ['members', 'board'], 'once someone joined the section stays quiet');
    assert.match(model?.status ?? '', /1 person is waiting for you in Members/);

    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await lead.run(MANAGE_MEMBERS_COMMAND);
    await leadHost.refresh();
    model = lastState(leadView.record);
    assert.equal(model?.actions.find((action) => action.id === 'members')?.badge, undefined, `confirmed: ${JSON.stringify(model)}`);
    assert.doesNotMatch(model?.status ?? '', /waiting/);
  } finally {
    for (const host of hosts) host.dispose();
    await closeWindow(joiner);
    await closeWindow(lead);
    await removeFixture(fixture);
  }
});

// ---- Task 3: the e2e probe only under the extension-host tests ------------------------------------------------------------------------------

function withE2e<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const before = process.env.NEAR_AI_E2E;
  if (value === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = value;
  return work().finally(() => { if (before === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = before; });
}

test('without NEAR_AI_E2E exactly 1 there is no probe, and facts from the page are ignored', async () => {
  const { teamSectionTap } = hostModule;
  for (const value of [undefined, '', '0', 'true', ' 1']) {
    await withE2e(value, async () => {
      const project = soloProject();
      const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => project.root, executeCommand: async () => undefined });
      try {
        teamSectionTap.facts.length = 0;
        const { webview, record } = webviewView();
        host.attach(webview);
        await host.refresh();
        assert.equal(teamSectionTap.probe, undefined, `NEAR_AI_E2E=${JSON.stringify(value)}: no probe`);
        await record.receive({ type: 'team-e2e-facts', id: 1, heading: 'Team', status: 'x', actions: [] });
        assert.deepEqual(teamSectionTap.facts, [], 'facts are not taken');
        assert.equal(record.posted.some((message) => (message as { type?: string }).type === 'team-e2e'), false);
      } finally {
        host.dispose();
        project.cleanup();
      }
    });
  }
});

test('under NEAR_AI_E2E=1 the probe asks the page what it drew, may ask it to click a drawn button, and the answer is kept', async () => {
  const { teamSectionTap } = hostModule;
  await withE2e('1', async () => {
    const project = soloProject();
    const commands: string[] = [];
    const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => project.root, executeCommand: async (command: string) => { commands.push(command); return undefined; } });
    try {
      teamSectionTap.facts.length = 0;
      const { webview, record } = webviewView();
      host.attach(webview);
      await host.refresh();
      assert.ok(teamSectionTap.probe !== undefined, 'the probe is offered');
      await teamSectionTap.probe({ id: 3 });
      assert.deepEqual(record.posted.at(-1), { type: 'team-e2e', id: 3 });
      await record.receive({ type: 'team-e2e-facts', id: 3, heading: 'Working with your agents', status: 'Want people to work with you too?', actions: [{ id: 'invite', label: 'Invite someone' }] });
      assert.deepEqual(teamSectionTap.facts, [{ id: 3, heading: 'Working with your agents', status: 'Want people to work with you too?', actions: [{ id: 'invite', label: 'Invite someone' }] }]);
      await teamSectionTap.probe({ id: 5, click: 'solo' });
      assert.deepEqual(record.posted.at(-1), { type: 'team-e2e', id: 5, click: 'solo' }, 'the probe may click Just me for now');
      await teamSectionTap.probe({ id: 4, click: 'invite' });
      assert.deepEqual(record.posted.at(-1), { type: 'team-e2e', id: 4, click: 'invite' });
      assert.deepEqual(commands, [], 'the probe itself runs nothing: the page clicks its own button, which posts team-action');
      // Facts never run a command, and a malformed answer is not kept.
      await record.receive({ type: 'team-e2e-facts', id: 'x' });
      await record.receive({ type: 'team-e2e-facts', id: Number.NaN });
      assert.equal(teamSectionTap.facts.length, 1);
      assert.deepEqual(commands, []);
    } finally {
      host.dispose();
      project.cleanup();
    }
    assert.equal(teamSectionTap.probe, undefined, 'the probe goes away with the host');
  });
  // An explicit testSeams overrides the variable both ways.
  await withE2e(undefined, async () => {
    const project = soloProject();
    const host = createTeamSectionHost({ team: soloHandle(), firstFolder: () => project.root, executeCommand: async () => undefined, testSeams: true });
    try {
      host.attach(webviewView().webview);
      assert.ok(hostModule.teamSectionTap.probe !== undefined);
    } finally {
      host.dispose();
      project.cleanup();
    }
  });
  assert.equal(parseTeamSectionMessage({ type: 'team-e2e-facts', id: 2, status: 'x' })?.type, 'team-e2e-facts');
  assert.equal(parseTeamSectionMessage({ type: 'team-e2e', id: 2 }), undefined, 'the host never takes its own probe back');
});
