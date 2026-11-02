import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';

// Runs inside the extension host. Messages are observed on both sides of the real sidebar webview,
// so every request below goes host → webview script → host, as a user's click would.

const EXTENSION_ID = 'VitalPoint.near-ai-vscode';
const workspace = process.env.NEAR_AI_E2E_WORKSPACE!;
type Message = { type: string; [key: string]: unknown };

class Observer {
  public readonly toView: Message[] = [];
  public readonly fromView: Message[] = [];
  private waiters: Array<() => void> = [];
  public record(list: Message[], message: unknown): void { list.push(message as Message); for (const wake of this.waiters.splice(0)) wake(); }
  public async next(list: 'toView' | 'fromView', predicate: (message: Message) => boolean, after = 0, timeoutMs = 20_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this[list].slice(after).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for a ${list} message. Seen: ${this[list].map((message) => message.type).join(', ')}`);
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 250); });
    }
  }
}

export async function run(): Promise<void> {
  const scenario = process.env.NEAR_AI_E2E_SCENARIO;
  const tests: Array<[string, () => Promise<void>]> = scenario === 'plain' ? plainTests() : scenario === 'team' ? teamTests() : projectTests();
  let failed = 0;
  for (const [name, body] of tests) {
    try { await body(); console.log(`✔ [${scenario}] ${name}`); } catch (error) { failed += 1; console.error(`✖ [${scenario}] ${name}\n`, error); }
  }
  if (failed) throw new Error(`${failed} extension-host test(s) failed in the ${scenario} scenario.`);
}

function projectTests(): Array<[string, () => Promise<void>]> {
  const observer = new Observer();
  let api: NearAiTestApi;
  let server: Server | undefined;
  return [
    ['activates in a project set up with the extension and registers every contributed command', async () => {
      const extension = vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
      api = (await extension.activate())!;
      assert.ok(api, 'the test API is returned when NEAR_AI_E2E=1');
      const registered = new Set(await vscode.commands.getCommands(true));
      const contributed = (extension.packageJSON.contributes.commands as Array<{ command: string }>).map((entry) => entry.command);
      assert.deepEqual(contributed.filter((command) => !registered.has(command)), [], 'contributed commands without a handler');
    }],
    ['the sidebar webview loads its script under the CSP and asks the host for models', async () => {
      api.sidebar.tap = { toView: (message) => observer.record(observer.toView, message), fromView: (message) => observer.record(observer.fromView, message) };
      await vscode.commands.executeCommand('nearAiChatView.focus');
      await observer.next('fromView', (message) => message.type === 'load-models');
    }],
    ['a local profile lists the runtime\'s models in the picker', async () => {
      server = await fakeModelServer();
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { ProfileStore } = require(path.join(extension.extensionPath, 'dist/services/profileStore')) as typeof import('../../services/profileStore');
      const { clearProviderCache } = require(path.join(extension.extensionPath, 'dist/services/providerCache')) as typeof import('../../services/providerCache');
      const profile = await new ProfileStore(workspace, api.auth).configure({ profileId: 'profile-e2e-local', displayName: 'E2E (local)', organization: 'E2E', baseUrl: url, authMode: 'apiKey', provider: 'local' }, '');
      assert.equal(profile.validation.status, 'valid', profile.validation.error);
      clearProviderCache();
      const before = observer.toView.length;
      await api.sidebar.refresh();
      const models = await observer.next('toView', (message) => message.type === 'models' && JSON.stringify(message.models).includes('fake-coder'), before);
      assert.match(JSON.stringify(models.models), /fake-coder/);
    }],
    ['a message streams a reply through the agent and reports usage', async () => {
      const before = observer.toView.length;
      await api.sidebar.request({ type: 'send', text: 'Say hi', model: 'fake-coder' });
      await observer.next('toView', (message) => message.type === 'assistant-done', before);
      const text = observer.toView.slice(before).filter((message) => message.type === 'assistant-delta').map((message) => message.text).join('');
      assert.match(text, /Hi from the fake model/);
    }],
    ['Agent Activity shows the overview and history while visible, and nothing while hidden', async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { activityTap } = require(path.join(extension.extensionPath, 'dist/services/activityView')) as typeof import('../../services/activityView');
      const page = new Observer();
      activityTap.toView = (message) => page.record(page.toView, message);
      activityTap.fromView = (message) => page.record(page.fromView, message);
      const titles = (message: Record<string, unknown>) => ((message.history as { rows: Array<{ title: string }> }).rows).map((row) => row.title);
      await vscode.commands.executeCommand('nearAi.openAgentActivity');
      await page.next('fromView', (message) => message.type === 'ready');
      const first = await page.next('toView', (message) => message.type === 'overview');
      assert.ok(titles(first).includes('Say hi'), 'the earlier run is in History');
      const summary = first.summary as { runs: number; tokens: { output: number } };
      assert.ok(summary.runs >= 1 && summary.tokens.output > 0, JSON.stringify(summary));
      assert.ok(!('entries' in first), 'no raw event log');
      assert.ok(!('insight' in first), 'a local runtime has no NEAR bill, so no spend section');
      const before = page.toView.length;
      await api.sidebar.request({ type: 'send', text: 'Say hi again', model: 'fake-coder' });
      await observer.next('toView', (message) => message.type === 'assistant-done', observer.toView.length - 1);
      await page.next('toView', (message) => message.type === 'overview' && titles(message).includes('Say hi again'), before);
      // Hidden: another editor takes the tab's place, and the page gets nothing until it is shown again.
      await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const hidden = page.toView.length;
      await api.sidebar.request({ type: 'send', text: 'Say hi while hidden', model: 'fake-coder' });
      await observer.next('toView', (message) => message.type === 'assistant-done', observer.toView.length - 1);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(page.toView.length, hidden, 'no messages while the page is hidden');
      const readyAt = page.fromView.length;
      await vscode.commands.executeCommand('nearAi.openAgentActivity');
      await page.next('fromView', (message) => message.type === 'ready', readyAt);
      const again = await page.next('toView', (message) => message.type === 'overview' && titles(message).includes('Say hi while hidden'), hidden);
      assert.ok(again, 'showing it again sends what happened meanwhile');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }],
    ['Compare Models opens, lists the key\'s models, and grades with the hidden tests inside VS Code', async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { comparisonTap } = require(path.join(extension.extensionPath, 'dist/services/modelComparisonPanel')) as typeof import('../../services/modelComparisonPanel');
      const page = new Observer();
      comparisonTap.toView = (message) => page.record(page.toView, message);
      comparisonTap.fromView = (message) => page.record(page.fromView, message);
      await vscode.commands.executeCommand('nearAi.compareModels');
      await page.next('fromView', (message) => message.type === 'ready');
      const state = (await page.next('toView', (message) => message.type === 'state')).state as { catalog: Array<{ id: string }>; leaderboard: unknown[]; taskSets: Array<{ id: string; tasks: unknown[] }> };
      assert.deepEqual(state.catalog.map((entry) => entry.id), ['fake-coder']);
      assert.deepEqual(state.leaderboard, []);
      assert.deepEqual(state.taskSets.map((set) => [set.id, set.tasks.length]), [['full', 8], ['short', 4]]);
      // The page asks for an estimate on load; one model is not enough to compare.
      const estimate = await page.next('toView', (message) => message.type === 'estimate');
      assert.match(String(estimate.problem), /at least 2/);
      // The hidden-test grader runs Node.js from the extension host (Electron as Node.js), not from PATH.
      const { gradeExecution, loadExecutionTasks, setUpExecutionTask } = require(path.join(extension.extensionPath, 'dist/benchmark/execution')) as typeof import('../../benchmark/execution');
      const [task] = (await loadExecutionTasks()).filter((candidate) => candidate.name === 'spec-implement');
      const root = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-grade-'));
      await setUpExecutionTask(task, root, true);
      const graded = await gradeExecution(task, root);
      assert.deepEqual({ score: graded.score, misses: graded.misses }, { score: 10, misses: [] });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }],
    ['a file write asks for approval, applies on approval, and Revert removes it', async () => {
      const before = observer.toView.length;
      await api.sidebar.request({ type: 'send', text: 'write notes', model: 'fake-coder' });
      const approval = await observer.next('toView', (message) => message.type === 'approval-request', before);
      assert.equal(approval.tool, 'Write');
      assert.equal(existsSync(path.join(workspace, 'notes.txt')), false, 'nothing is written before approval');
      await api.sidebar.request({ type: 'approval-reply', callId: String(approval.callId), decision: 'allow' });
      const changes = await observer.next('toView', (message) => message.type === 'run-changes', before);
      assert.equal(await readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'hello from e2e\n');
      await api.sidebar.request({ type: 'revert-run', runId: String(changes.runId) });
      await observer.next('toView', (message) => message.type === 'run-reverted', before);
      assert.equal(existsSync(path.join(workspace, 'notes.txt')), false);
      server?.close();
    }],
    ['Open Team Board in a project with no team opens no board and posts nothing', async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { boardTap, BOARD_PANEL_TYPE } = require(path.join(extension.extensionPath, 'dist/services/team/boardView')) as typeof import('../../services/team/boardView');
      const page = new Observer();
      boardTap.toView = (message) => page.record(page.toView, message);
      boardTap.fromView = (message) => page.record(page.fromView, message);
      try {
        await vscode.commands.executeCommand('nearAi.team.openBoard');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        assert.deepEqual([...page.toView, ...page.fromView], [], 'no message in either direction');
        const panels = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
          .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(BOARD_PANEL_TYPE));
        assert.equal(panels.length, 0, 'no board panel');
      } finally {
        boardTap.toView = undefined;
        boardTap.fromView = undefined;
      }
    }]
  ];
}

// ---- the team scenario: a git project whose integration branch holds the fixture roadmap -------------------------------------------------------

interface BoardCardView { id: string; column: string; held: boolean; blocked?: { reason: string } }

function cardsOf(message: Message): BoardCardView[] {
  return ((message.model as { cards: BoardCardView[] }).cards);
}

function cardOf(message: Message, id: string): BoardCardView | undefined {
  return cardsOf(message).find((card) => card.id === id);
}

function teamTests(): Array<[string, () => Promise<void>]> {
  const board = new Observer();
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  let api: NearAiTestApi;
  let tap: typeof import('../../services/team/boardView')['boardTap'];
  let remote = '';
  const countOnRemote = (): number => Number(execFileSync('git', ['-C', remote, 'rev-list', '--count', 'refs/heads/near-ai/coordination'], { encoding: 'utf8' }).trim());
  return [
    ['activates in a git project and registers every contributed command, the board commands included', async () => {
      api = (await extension().activate())!;
      assert.ok(api?.team, 'the test API carries the team handle');
      const registered = new Set(await vscode.commands.getCommands(true));
      const contributed = (extension().packageJSON.contributes.commands as Array<{ command: string }>).map((entry) => entry.command);
      assert.deepEqual(contributed.filter((command) => !registered.has(command)), [], 'contributed commands without a handler');
      for (const command of ['nearAi.team.openBoard', 'nearAi.team.importPlans']) assert.ok(registered.has(command), command);
      assert.equal(await api.team.handle.ready, 'solo', 'no team yet');
      remote = execFileSync('git', ['-C', workspace, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    }],
    ['Team Mode is enabled and the real board page loads under the CSP and asks for its state', async () => {
      const { enableTeamMode } = load<typeof import('../../team/enable')>('team/enable');
      const enabled = await enableTeamMode({
        projectRoot: workspace, globalStorageDir: api.team.globalStorageDir, secrets: api.team.secrets,
        teamName: 'E2E team', ownerName: 'E2E Owner', remote: 'origin', integrationBranch: 'main'
      });
      assert.equal(enabled.ok, true, enabled.ok ? '' : enabled.message);
      tap = load<typeof import('../../services/team/boardView')>('services/team/boardView').boardTap;
      tap.toView = (message) => board.record(board.toView, message);
      tap.fromView = (message) => board.record(board.fromView, message);
      await vscode.commands.executeCommand('nearAi.team.openBoard');
      await board.next('fromView', (message) => message.type === 'ready');
      await board.next('toView', (message) => message.type === 'state');
    }],
    ['the board shows the fixture roadmap, and Import Plans can be run again', async () => {
      // The session imports the roadmap when it starts, so the cards may already be on the board; the command then changes nothing.
      await vscode.commands.executeCommand('nearAi.team.importPlans', { milestone: 'current' });
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, 'plan:90-01') !== undefined && cardOf(message, 'plan:90-02') !== undefined);
      assert.equal(cardOf(state, 'plan:90-01')?.column, 'done');
      assert.equal(cardOf(state, 'plan:90-02')?.column, 'ready');
    }],
    ['the real page draws the imported cards, a card takes focus and the Move menu opens and steps from the keyboard, with no page error (CR-01)', async () => {
      // The page reports what it drew (test seam, NEAR_AI_E2E only). Before CR-01 the first render threw in Chromium on a NodeList, so no card was focusable.
      let probes = 0;
      const ask = async (probe: { action: 'facts' | 'focus' | 'key'; itemId?: string; key?: string }): Promise<Message> => {
        probes += 1;
        const id = probes;
        const before = board.fromView.length;
        await tap.probe!({ id, ...probe });
        return board.next('fromView', (message) => message.type === 'e2e-facts' && message.id === id, before);
      };
      assert.ok(tap.probe, 'the page probe is offered under NEAR_AI_E2E=1');
      let facts = await ask({ action: 'facts' });
      for (let tries = 0; tries < 20 && !(facts.cardIds as string[]).includes('plan:90-02'); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        facts = await ask({ action: 'facts' });
      }
      const ids = facts.cardIds as string[];
      assert.ok(ids.includes('plan:90-01') && ids.includes('plan:90-02'), `the imported cards are drawn (${ids.length} cards: ${ids.join(', ')})`);
      assert.ok((facts.draggable as number) > 0, 'the render listeners ran: at least one card is draggable');
      assert.deepEqual(facts.errors, [], 'no page error after the render');
      facts = await ask({ action: 'focus', itemId: 'plan:90-02' });
      assert.equal(facts.focusedCard, 'plan:90-02', 'the card takes focus');
      facts = await ask({ action: 'key', key: 'ArrowRight' });
      assert.deepEqual(facts.errors, [], 'arrow keys move between cards without an error');
      facts = await ask({ action: 'focus', itemId: 'plan:90-02' });
      facts = await ask({ action: 'key', key: 'm' });
      assert.equal(facts.menuOpen, true, 'M opens the Move menu');
      assert.ok((facts.menuItems as number) > 0, 'the menu lists moves');
      assert.equal(facts.focusedRole, 'menuitem', 'focus is in the menu');
      facts = await ask({ action: 'key', key: 'ArrowDown' });
      assert.equal(facts.focusedRole, 'menuitem', 'Down steps through the menu');
      facts = await ask({ action: 'key', key: 'Escape' });
      assert.equal(facts.menuOpen, false, 'Escape closes the menu');
      assert.equal(facts.focusedCard, 'plan:90-02', 'focus returns to the card');
      assert.deepEqual(facts.errors, [], 'no page error at any step');
    }],
    ['a move sent through the real page reaches the host, and the next state shows the card on hold', async () => {
      const fromBefore = board.fromView.length;
      const toBefore = board.toView.length;
      await tap.request!({ type: 'move', itemId: 'plan:90-02', target: 'hold' });
      const posted = await board.next('fromView', (message) => message.type === 'move', fromBefore);
      assert.deepEqual(posted, { type: 'move', itemId: 'plan:90-02', target: 'hold' });
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, 'plan:90-02')?.held === true, toBefore);
      assert.equal(cardOf(state, 'plan:90-02')?.column, 'backlog');
    }],
    ['a refused move produces a refused message and writes no event', async () => {
      const events = countOnRemote();
      const toBefore = board.toView.length;
      await tap.request!({ type: 'move', itemId: 'plan:90-01', target: 'release' });
      const refused = await board.next('toView', (message) => message.type === 'refused', toBefore);
      assert.equal(refused.itemId, 'plan:90-01');
      assert.ok(typeof refused.reason === 'string' && refused.reason.length > 0, 'the refusal says why');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(countOnRemote(), events, 'the remote holds no new event');
    }],
    ['an event from a second client appears in the open board after the session polls, without a reload', async () => {
      const session = api.team.handle.session();
      assert.ok(session, 'a session is running');
      const { TeamLog } = load<typeof import('../../team/eventLog')>('team/eventLog');
      const { GitTransport } = load<typeof import('../../team/gitTransport')>('team/gitTransport');
      const { teamMaterializer } = load<typeof import('../../domain/team/materialize')>('domain/team/materialize');
      const { loadDeviceIdentity } = load<typeof import('../../team/identity')>('team/identity');
      const { teamStorageDir } = load<typeof import('../../team/teamFile')>('team/teamFile');
      const teamFile = session!.teamFile;
      const anchor = { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
      // The second client has its own mirror of the coordination branch, as another computer would.
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-second-'));
      const transport = new GitTransport({
        mirrorDir: path.join(teamStorageDir(mirrorRoot, teamFile.teamId), 'coordination.git'), projectRoot: workspace,
        remote: teamFile.coordination.remote, ref: teamFile.coordination.ref, materializer: teamMaterializer(anchor), baseDelayMs: 1
      });
      const identity = await loadDeviceIdentity(api.team.secrets, teamFile.teamId);
      assert.ok(identity, 'the owner device key is in SecretStorage');
      const reader = new TeamLog({ anchor, transport });
      await reader.sync();
      const memberId = reader.state().deviceIndex.get(identity!.fingerprint);
      assert.ok(memberId, 'the device is a member');
      const second = new TeamLog({ anchor, transport, signer: { identity: identity!, memberId: memberId! } });
      await second.sync();
      const toBefore = board.toView.length;
      const reason = 'waiting for the API key';
      const appended = await second.append(() => [{ type: 'item.blocked', body: { id: 'plan:90-02', reason } }]);
      assert.equal(appended.ok, true, appended.ok ? '' : appended.reason);
      session!.nudge();
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, 'plan:90-02')?.blocked?.reason === reason, toBefore, 20_000);
      assert.ok(state, 'the open board received the other client\'s change');
    }]
  ];
}

function plainTests(): Array<[string, () => Promise<void>]> {
  return [
    ['does not activate on startup in a folder not set up with the extension', async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, false);
    }],
    ['opening the sidebar there writes nothing into the folder', async () => {
      await vscode.commands.executeCommand('nearAiChatView.focus');
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.equal(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, true, 'the view activates the extension');
      assert.deepEqual(await readdir(workspace), []);
    }]
  ];
}

/** A minimal OpenAI-compatible server: one model, a text reply, and a Write tool call. */
async function fakeModelServer(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fake-coder' }] })); return; }
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end('{}'); return; }
      const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: string | null }> };
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const delta = last.role === 'tool' ? { content: 'Done.' }
        : String(lastUser?.content).includes('write notes') ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'notes.txt', content: 'hello from e2e\n' }) } }] }
          : { content: 'Hi from the fake model.' };
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', choices: [{ delta }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', choices: [{ delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
