// The sidebar Team section host (G-61-5, plan 61-21): it feeds the Team section model to the NEAR AI chat sidebar and runs the Team Mode command
// mapped to a clicked button. The page is untrusted, so only {type:'team-action', action} with an action from the fixed list runs anything, and only
// the command TEAM_ACTION_COMMANDS maps it to. The vscode stub is installed for the whole file; the host itself needs only types from vscode.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
test.after(() => { uninstall(); });
const hostModule = require('../services/team/teamSectionHost') as typeof import('../services/team/teamSectionHost');
const { createTeamSectionHost, parseTeamSectionMessage } = hostModule;
const { TEAM_ACTION_COMMANDS } = require('../domain/team/teamSection') as typeof import('../domain/team/teamSection');
type TeamModeHandle = import('../services/team/teamCommands').TeamModeHandle;
type Model = import('../domain/team/teamSection').TeamSectionModel;

// A Team Mode handle with no session (a project without a team, or Team Mode not started), whose change listeners the test can fire.
function soloHandle(): TeamModeHandle & { fire(): void; listeners: number } {
  const listeners = new Set<() => void>();
  return {
    ready: Promise.resolve('solo'),
    session: () => undefined,
    onDidChange(listener: () => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    fire() { for (const listener of [...listeners]) listener(); },
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

test('tracer: a project with no team gets Turn on Team Mode (primary) then Join a team, and clicking Turn on Team Mode runs Enable', async () => {
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
    assert.deepEqual(first.actions.map((action) => [action.id, action.primary]), [['turn-on', true], ['join', false]]);
    assert.equal(first.compact, true);
    const before = states(record).length;
    await record.receive({ type: 'team-action', action: 'turn-on' });
    assert.deepEqual(commands, ['nearAi.team.enable'], 'Enable ran once');
    assert.equal(states(record).length, before + 1, 'a fresh team-state follows the command');
  } finally {
    host.dispose();
    project.cleanup();
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
