import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';
import { connectCdp, interceptedDrag, mouseDrag, pressKey, webviewFrameRect, type CdpSession, type Point } from './cdp';
import { captureScreen, readXwd } from './xwdPng';
import { fillScreen } from './x11Window';

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

// NEAR_AI_E2E_SCENARIO names one scenario, or several run one after another in the same window (the lead's window runs team-lead, then team-confirm).
export async function run(): Promise<void> {
  const scenarios = (process.env.NEAR_AI_E2E_SCENARIO ?? 'project').split(',');
  let failed = 0;
  try {
    for (const scenario of scenarios) {
      const tests: Array<[string, () => Promise<void>]> = scenario === 'plain' ? plainTests() : scenario === 'team' ? teamTests() : scenario === 'board' ? boardTests()
        : scenario === 'team-lead' ? teamLeadTests() : scenario === 'team-join' ? teamJoinTests() : scenario === 'team-confirm' ? teamConfirmTests() : projectTests();
      for (const [name, body] of tests) {
        try { await body(); console.log(`✔ [${scenario}] ${name}`); } catch (error) { failed += 1; console.error(`✖ [${scenario}] ${name}\n`, error); }
      }
    }
  } finally {
    // The fake model servers a window's scenarios started (connectProfile) close after that window's last test.
    await Promise.all(windowServers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => { resolve(); }); })));
  }
  if (failed) throw new Error(`${failed} extension-host test(s) failed in the ${scenarios.join(' and ')} scenario.`);
}

// Fake model servers started for this window, closed once its last scenario has run.
const windowServers: Server[] = [];

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
      assert.ok(ids.includes('plan:90-02'), `the imported cards are drawn (${ids.length} cards: ${ids.join(', ')})`);
      // Owner decisions 2026-11-03 (G-62-3, G-62-7, plan 62-21): Done starts folded and a folded column draws no card, so the done plan:90-01 is not drawn.
      assert.equal(ids.includes('plan:90-01'), false, 'the done card is not drawn while Done is folded');
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

// ---- the invite scenarios: two windows open at once on one online home, driven only by the buttons of the sidebar Team section -------------------
// The lead's window (the lead's project) runs team-lead, then team-confirm; the invitee's window (their copy, made before Team Mode was on) runs
// team-join. The online home is a local bare folder behind a test-only insteadOf rule on a public-looking address (run.ts). Every prompt is answered
// by a script through promptTap and recorded; the invite text passes from the lead's window to the invitee's in a handoff folder.

type TeamActionName = 'turn-on' | 'join' | 'share' | 'invite' | 'members' | 'board' | 'link' | 'check';
// hidden and profile (61-25): whether the whole section is hidden, and the readiness state the page last read from profile-status (null before any).
interface SectionFacts { id: number; heading: string; status: string; actions: Array<{ id: TeamActionName; label: string; badge?: string }>; hidden?: boolean; profile?: string | null; error?: string }
type PromptRecordView = import('../../services/team/teamPrompts').PromptRecord;
type PromptStepView = import('../../services/team/teamPrompts').PromptStep;

const STEP_MS = 20_000;
const INVITE_PREFIX = 'near-ai-invite-v1.';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// The invitee joins in another window, so the lead's window waits longer for that step than for one of its own.
const OTHER_WINDOW_MS = 180_000;
// One counter for the whole window, so the answer to a probe is never mistaken for an earlier one (team-lead and team-confirm share a window).
let probes = 0;

// Bounded polling: the condition's value once it holds, or a failure that says what was awaited.
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = STEP_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await sleep(250);
  }
}

function inviteKit() {
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  const section = (): typeof import('../../services/team/teamSectionHost')['teamSectionTap'] =>
    load<typeof import('../../services/team/teamSectionHost')>('services/team/teamSectionHost').teamSectionTap;
  const prompts = (): typeof import('../../services/team/teamPrompts')['promptTap'] =>
    load<typeof import('../../services/team/teamPrompts')>('services/team/teamPrompts').promptTap;
  const handoff = process.env.NEAR_AI_E2E_HANDOFF!;
  const remote = process.env.NEAR_AI_E2E_REMOTE!;

  // One probe of the real page: what the Team section draws, after clicking one of its drawn buttons when asked. A click is never repeated.
  async function probe(click?: TeamActionName): Promise<SectionFacts> {
    const tap = section();
    assert.ok(tap.probe, 'the Team section probe is offered under NEAR_AI_E2E=1');
    probes += 1;
    const id = probes;
    await tap.probe({ id, ...(click === undefined ? {} : { click }) });
    return until(`the Team section to answer probe ${id}`, () => tap.facts.find((fact) => fact.id === id) as SectionFacts | undefined, 5_000);
  }

  // Waits until the section shows what the predicate wants (the page may still be loading, or the host still refreshing).
  async function facts(what: string, predicate: (facts: SectionFacts) => boolean, timeoutMs = STEP_MS, poke?: () => void): Promise<SectionFacts> {
    let last: SectionFacts | undefined;
    try {
      return await until(`the Team section to show ${what}`, async () => {
        poke?.();
        last = await probe().catch(() => undefined);
        return last !== undefined && predicate(last) ? last : undefined;
      }, timeoutMs);
    } catch (error) {
      throw new Error(`${(error as Error).message} Last seen: ${JSON.stringify(last)}`);
    }
  }

  // Clicks a drawn button with a script for the prompts the command shows. The steps are used up as they answer.
  async function click(action: TeamActionName, steps: PromptStepView[]): Promise<void> {
    prompts().script = steps.map((step) => ({ ...step }));
    const before = await probe(action);
    assert.equal(before.error, undefined, `${action} is drawn in the Team section`);
  }

  // The command reached its last prompt and every scripted step was used.
  async function finished(what: string, last: (record: PromptRecordView) => boolean): Promise<PromptRecordView> {
    const record = await until(what, () => prompts().shown.find(last));
    await until('every scripted step to be used', () => prompts().script?.length === 0);
    return record;
  }

  // No prompt was left unanswered, and no sentence the window showed has a git word or the old name of the paying account (G-61-6). The invite line
  // itself is left out of the scan: it is a code, not words.
  function assertPlain(): void {
    const { bannedPattern } = require(path.join(extension().extensionPath, 'dist/test/helpers/plainWords')) as typeof import('../helpers/plainWords');
    const shown = prompts().shown;
    assert.ok(shown.length > 0, 'the flow showed something');
    for (const record of shown) {
      assert.notEqual(record.unanswered, true, `a prompt was left unanswered: ${JSON.stringify(record)}`);
      const detail = (record.detail ?? '').split('\n').filter((line) => !line.startsWith(INVITE_PREFIX)).join('\n');
      for (const text of [record.text, detail, ...record.choices]) {
        assert.doesNotMatch(text, bannedPattern, `plain words only: ${JSON.stringify(record.text)}`);
      }
    }
  }

  // The team as another computer reads it from the online home: its own mirror, no signer, the anchor from this project's team.json.
  async function readLog(projectRoot: string): Promise<import('../../domain/team/types').TeamState> {
    const { TeamLog } = load<typeof import('../../team/eventLog')>('team/eventLog');
    const { GitTransport } = load<typeof import('../../team/gitTransport')>('team/gitTransport');
    const { teamMaterializer } = load<typeof import('../../domain/team/materialize')>('domain/team/materialize');
    const { readTeamFile, teamStorageDir } = load<typeof import('../../team/teamFile')>('team/teamFile');
    const teamFile = await readTeamFile(projectRoot);
    assert.ok(teamFile, 'the project has team.json');
    const anchor = { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
    const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-reader-'));
    const transport = new GitTransport({
      mirrorDir: path.join(teamStorageDir(mirrorRoot, teamFile.teamId), 'coordination.git'), projectRoot,
      remote: teamFile.coordination.remote, ref: teamFile.coordination.ref, materializer: teamMaterializer(anchor), baseDelayMs: 1
    });
    const reader = new TeamLog({ anchor, transport });
    await reader.sync();
    return reader.state();
  }

  const memberNamed = (state: import('../../domain/team/types').TeamState, name: string): import('../../domain/team/types').Member | undefined =>
    [...state.members.values()].find((member) => member.name === name && member.status !== 'invited' && member.removedEvent === undefined);

  const remoteTeamFile = (): { teamId: string } | undefined => {
    try {
      return JSON.parse(execFileSync('git', ['-C', remote, 'show', 'main:.planning/.near-ai/team.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { teamId: string };
    } catch {
      return undefined;
    }
  };

  async function activate(): Promise<NearAiTestApi> {
    const api = (await extension().activate())!;
    assert.ok(api?.team, 'the test API carries the team handle');
    // From here on no prompt reaches a real dialog: an empty script records a prompt nobody answered instead of waiting for a person.
    prompts().script = [];
    prompts().shown.length = 0;
    await vscode.commands.executeCommand('nearAiChatView.focus');
    return api;
  }

  // 61-25: the Team section shows only once a NEAR AI profile works. This connects a local profile against a fake model server (the project
  // scenario's way), checks that it works, and refreshes the sidebar so the page reads the new profile-status. The profile files land under
  // .planning/.near-ai, which these projects ignore, so a copy still counts as clean. The server closes after the window's last test.
  async function connectProfile(api: NearAiTestApi): Promise<void> {
    const server = await fakeModelServer();
    windowServers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const { ProfileStore } = load<typeof import('../../services/profileStore')>('services/profileStore');
    const { clearProviderCache } = load<typeof import('../../services/providerCache')>('services/providerCache');
    const profile = await new ProfileStore(workspace, api.auth).configure({ profileId: 'profile-e2e-local', displayName: 'E2E (local)', organization: 'E2E', baseUrl: url, authMode: 'apiKey', provider: 'local' }, '');
    assert.equal(profile.validation.status, 'valid', profile.validation.error);
    clearProviderCache();
    await api.sidebar.refresh();
  }

  // Right after activation, before any profile: the section is hidden and the page knows there is no profile to use.
  async function assertHiddenWithoutProfile(): Promise<void> {
    const hidden = await facts('nothing before a profile works', (seen) => seen.hidden === true && seen.profile === 'connect');
    assert.deepEqual(hidden.actions, [], 'no team button can be seen');
    const refused = await probe('turn-on');
    assert.equal(refused.error, 'hidden', 'a hidden button cannot be clicked');
  }

  return { load, prompts, handoff, remote, facts, click, finished, assertPlain, readLog, memberNamed, remoteTeamFile, activate, connectProfile, assertHiddenWithoutProfile };
}

const ids = (facts: SectionFacts): TeamActionName[] => facts.actions.map((action) => action.id);

function teamLeadTests(): Array<[string, () => Promise<void>]> {
  const kit = inviteKit();
  let api: NearAiTestApi;
  return [
    ['before a NEAR AI profile works the Team section is hidden; once a local profile is connected it shows Turn on Team Mode without a reload', async () => {
      api = await kit.activate();
      await kit.assertHiddenWithoutProfile();
      await kit.connectProfile(api);
      const shown = await kit.facts('the section once the profile works', (facts) => facts.hidden === false && facts.actions.length > 0);
      assert.equal(shown.profile, 'ready');
      assert.equal(shown.actions[0]?.id, 'turn-on', 'Turn on Team Mode is the primary action');
      assert.ok(ids(shown).includes('join'), 'Join a team is offered');
    }],
    ['the lead\'s project has no team yet, and the Team section offers Turn on Team Mode first and Join a team', async () => {
      api = await kit.activate();
      assert.equal(await api.team.handle.ready, 'solo', 'no team yet');
      const shown = await kit.facts('Turn on Team Mode', (facts) => facts.actions.length > 0);
      assert.equal(shown.actions[0]?.id, 'turn-on', 'Turn on Team Mode is the primary action');
      assert.ok(ids(shown).includes('join'), 'Join a team is offered');
    }],
    ['Turn on Team Mode in the section asks the team name, your name and email once, and turns Team Mode on; Share comes next', async () => {
      await kit.click('turn-on', [
        { match: 'Team name', answer: 'E2E team' },
        { match: 'Your name as teammates will see it', answer: 'E2E Lead' },
        { match: 'Your email (optional)', answer: '' },
        { match: 'Team Mode is on for', answer: undefined }
      ]);
      const done = await kit.finished('the Team Mode is on message', (record) => record.text.startsWith('Team Mode is on for E2E team'));
      assert.equal(done.modal, false, 'the result is a plain message');
      assert.ok(existsSync(path.join(workspace, '.planning', '.near-ai', 'team.json')), 'team.json exists');
      const session = await until('the team session to run', () => api.team.handle.session());
      assert.equal(session.teamFile.name, 'E2E team');
      // The setup is not online yet, so Share takes the place of Invite someone until it is (61-17).
      const shown = await kit.facts('Share first', (facts) => facts.actions[0]?.id === 'share');
      assert.equal(ids(shown).includes('invite'), false, 'Invite someone waits until the setup is shared');
      assert.match(shown.status, /not shared yet/);
      assert.equal(kit.remoteTeamFile(), undefined, 'nothing of the team is on the online home\'s main version yet');
    }],
    ['Share in the section puts the team setup online after one confirmation, and Invite someone comes next', async () => {
      await kit.click('share', [{ match: 'Share your team setup so teammates can join?', answer: 'Share' }]);
      await kit.finished('the shared message', (record) => record.text === 'Your team setup is online. Teammates can now join.');
      const confirmations = kit.prompts().shown.filter((record) => record.modal && record.text.includes('Share your team setup'));
      assert.equal(confirmations.length, 1, 'one confirmation');
      assert.equal(kit.remoteTeamFile()?.teamId, api.team.handle.session()!.teamFile.teamId, 'main online holds the lead\'s team.json');
      const shown = await kit.facts('Invite someone first', (facts) => facts.actions[0]?.id === 'invite');
      assert.ok(ids(shown).includes('members'), 'Members is offered');
    }],
    ['Invite someone in the section asks about the organization, who and what role, and shows the invite once with Copy invite', async () => {
      const clipboardBefore = await vscode.env.clipboard.readText();
      try {
        await kit.click('invite', [
          { match: 'Not now, everyone uses their own key', answer: 'Not now' },
          { match: 'Name of the person you are inviting', answer: 'E2E Joiner' },
          { match: 'Their email address', answer: 'joiner@example.invalid' },
          { match: 'Role for', answer: 'Developer' },
          { match: 'Allocation in US dollars', answer: '0' },
          { match: 'How long the invite works', answer: '7 days' },
          { match: 'Invite ready for E2E Joiner', answer: 'Copy invite' }
        ]);
        await kit.finished('the copied message', (record) => record.text.startsWith('Invite for E2E Joiner copied'));
        const shown = kit.prompts().shown.filter((record) => record.detail?.startsWith(INVITE_PREFIX) === true);
        assert.equal(shown.length, 1, 'the invite is shown exactly once');
        const [modal] = shown;
        assert.equal(modal!.modal, true);
        assert.deepEqual(modal!.choices, ['Copy invite']);
        assert.equal(modal!.answer, 'Copy invite');
        const bundle = modal!.detail!.split('\n')[0]!;
        assert.equal(kit.prompts().shown.filter((record) => JSON.stringify(record).includes(bundle)).length, 1, 'the invite is in no other prompt');
        assert.equal(await vscode.env.clipboard.readText(), bundle, 'the clipboard holds the invite');
        // Written whole, then renamed, so the invitee's window never reads half an invite.
        await writeFile(path.join(kit.handoff, 'bundle.part'), bundle, { encoding: 'utf8', mode: 0o600 });
        await rename(path.join(kit.handoff, 'bundle.part'), path.join(kit.handoff, 'bundle.txt'));
      } finally {
        await vscode.env.clipboard.writeText(clipboardBefore);
      }
      assert.equal(kit.remoteTeamFile()?.teamId, api.team.handle.session()!.teamFile.teamId, 'main online still holds the lead\'s team.json');
      const shown = await kit.facts('one invite not used yet', (facts) => facts.actions[0]?.id === 'invite' && /1 invite is not used yet/.test(facts.status));
      assert.ok(shown, 'Invite someone stays first, and the status counts the invite');
    }],
    ['every prompt of the lead\'s window was answered and spoke plain words', async () => {
      kit.assertPlain();
    }]
  ];
}

function teamJoinTests(): Array<[string, () => Promise<void>]> {
  const kit = inviteKit();
  let api: NearAiTestApi;
  let bundle = '';
  const head = (cwd: string, ref: string): string => execFileSync('git', ['-C', cwd, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  return [
    ['before a NEAR AI profile works the invitee\'s Team section is hidden; once a local profile is connected it shows Join a team without a reload', async () => {
      api = await kit.activate();
      await kit.assertHiddenWithoutProfile();
      await kit.connectProfile(api);
      const shown = await kit.facts('the section once the profile works', (facts) => facts.hidden === false && ids(facts).includes('join'));
      assert.equal(shown.profile, 'ready');
      assert.equal(execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'the profile files are ignored, so the copy is still clean');
    }],
    ['the invitee\'s copy has no team yet, and the Team section offers Join a team', async () => {
      api = await kit.activate();
      assert.equal(await api.team.handle.ready, 'solo', 'no team.json in this copy yet');
      const shown = await kit.facts('Join a team', (facts) => ids(facts).includes('join'));
      assert.equal(shown.error, undefined);
    }],
    ['the lead\'s invite arrives, and this copy is now behind the online home', async () => {
      // The lead's window runs at the same time and leaves the invite in the handoff folder once it has shared the setup and made the invite.
      bundle = await until('the lead\'s window to hand over the invite', async () => {
        const text = await readFile(path.join(kit.handoff, 'bundle.txt'), 'utf8').catch(() => '');
        return text.trim().startsWith(INVITE_PREFIX) ? text.trim() : undefined;
      }, OTHER_WINDOW_MS);
      assert.notEqual(head(workspace, 'HEAD'), head(kit.remote, 'main'), 'the copy is behind the online home');
      assert.equal(existsSync(path.join(workspace, '.planning', '.near-ai', 'team.json')), false, 'the copy has no team.json yet');
    }],
    ['Join a team with the pasted invite brings the copy up to date by itself and joins as an observer waiting for a lead', async () => {
      await kit.click('join', [
        { match: 'Paste the invite your lead sent you', answer: bundle },
        { match: 'Your name as teammates will see it', answer: 'E2E Joiner' },
        { match: 'Paste your own NEAR AI API key', answer: '' }
      ]);
      const joined = await kit.finished('the joined message', (record) => record.text.startsWith('You joined E2E team'));
      assert.equal(joined.text, 'You joined E2E team as an observer. Your lead confirms you as a developer.');
      const shown = kit.prompts().shown;
      assert.ok(shown.some((record) => record.text === 'Your copy of the project was brought up to date.'), 'the copy was brought up to date and said so');
      const paste = shown.find((record) => record.text.startsWith('Paste the invite your lead sent you'));
      assert.equal(paste?.answer, 'hidden', 'the pasted invite is recorded as hidden');
      assert.equal(JSON.stringify(shown).includes(bundle), false, 'the invite text is in no record');
      assert.equal(head(workspace, 'HEAD'), head(kit.remote, 'main'), 'the copy is at the online home\'s main version');
      const teamFile = JSON.parse(await readFile(path.join(workspace, '.planning', '.near-ai', 'team.json'), 'utf8')) as { teamId: string; name: string };
      assert.equal(teamFile.name, 'E2E team');
      assert.equal(teamFile.teamId, kit.remoteTeamFile()?.teamId);
      const member = kit.memberNamed(await kit.readLog(workspace), 'E2E Joiner');
      assert.ok(member, 'the team record has E2E Joiner');
      assert.equal(member.role, 'observer');
      assert.equal(member.pendingRole, 'developer');
    }],
    ['the Team section then says a lead confirms them, with nothing to invite', async () => {
      const shown = await kit.facts('waiting for a lead', (facts) => /A lead confirms you/.test(facts.status));
      assert.equal(ids(shown).includes('invite'), false, 'no Invite someone');
      assert.equal(ids(shown).includes('join'), false, 'no Join a team any more');
    }],
    ['every prompt of the invitee\'s window was answered and spoke plain words', async () => {
      kit.assertPlain();
    }]
  ];
}

// Runs in the lead's window after team-lead: the same window, so the lead's device key is the one that window made.
function teamConfirmTests(): Array<[string, () => Promise<void>]> {
  const kit = inviteKit();
  let api: NearAiTestApi;
  return [
    ['once the invitee has joined in their own window, the lead\'s Team section shows one person waiting in Members', async () => {
      api = await kit.activate();
      const session = api.team.handle.session();
      assert.ok(session, 'the lead\'s team session still runs');
      const { loadDeviceIdentity } = kit.load<typeof import('../../team/identity')>('team/identity');
      assert.ok(await loadDeviceIdentity(api.team.secrets, session.teamFile.teamId), 'the lead\'s device key is in this window\'s SecretStorage');
      // The session picks up the join on its next sync; it is nudged on every look instead of waiting for its own timer.
      const shown = await kit.facts('Members with 1 waiting', (facts) => facts.actions.find((action) => action.id === 'members')?.badge === '1 waiting',
        OTHER_WINDOW_MS, () => { api.team.handle.session()?.nudge(); });
      assert.match(shown.status, /1 person is waiting for you in Members/);
    }],
    ['Members in the section confirms E2E Joiner as a developer', async () => {
      await kit.click('members', [
        { match: 'E2E Joiner', answer: 'E2E Joiner' },
        { match: 'Confirm', answer: 'Confirm' }
      ]);
      const said = await kit.finished('the confirmed message', (record) => record.text.startsWith('E2E Joiner is now a developer.'));
      assert.equal(said.modal, false);
      const member = await until('the team record online to show E2E Joiner as a developer', async () => {
        const found = kit.memberNamed(await kit.readLog(workspace), 'E2E Joiner');
        return found?.role === 'developer' ? found : undefined;
      });
      assert.equal(member.pendingRole, undefined, 'no role waits any more');
      const shown = await kit.facts('no one waiting', (facts) => {
        const members = facts.actions.find((action) => action.id === 'members');
        return members !== undefined && members.badge === undefined;
      });
      assert.match(shown.status, /1 other member/);
    }],
    ['every prompt of the confirmation was answered and spoke plain words', async () => {
      kit.assertPlain();
    }]
  ];
}

// ---- the board scenario (62-21): this repository's own roadmap on a test project, measured in a real window on a hidden screen -------------------

// What media/board/layout-probe.js answers (62-16): the real page measured in CSS pixels, and every broken layout or readability rule as a sentence.
interface LayoutReport {
  width: number; height: number; layout: string; theme: string; problems: string[];
  toolbar: { height: number; background: string; position: string };
  region: { left: number; top: number; width: number; height: number; scrollTop: number; scrollLeft: number };
  heads: Array<{ column: string; left: number; right: number; folded: boolean }>;
  lanes: Array<{ lane: string; top: number; bottom: number; collapsed: boolean }>;
  cells: Array<{ lane: string; column: string; left: number; top: number; width: number; height: number }>;
  cards: Array<{ id: string; column: string; lane: string; left: number; top: number; width: number; height: number; draggable: boolean }>;
  visibleCards: number;
  focused?: { id: string; top: number; bottom: number; visible: boolean };
}
// The screenshot matrix (62-22): four widths, four themes, and a few extra views.
type MatrixWidth = 480 | 900 | 1400 | 'full';
const MATRIX_WIDTHS: MatrixWidth[] = [480, 900, 1400, 'full'];
/** How near the asked width the board's group must come. */
const WIDTH_SLACK = 40;
/** One line of screens/index.json: a frame the owner can open, and what the probe measured just before it was taken. */
interface ScreenEntry { file: string; theme: string; askedWidth: MatrixWidth; reachedWidth: number; layout: string; view: string; problems: number }
/** The four built-in theme kinds, the probe's theme field (the page's body class) for each, and the name the screenshots use. */
const MATRIX_THEMES = [
  { uiTheme: 'vs-dark', probe: 'dark', name: 'dark' },
  { uiTheme: 'vs', probe: 'light', name: 'light' },
  { uiTheme: 'hc-black', probe: 'high-contrast', name: 'hc' },
  { uiTheme: 'hc-light', probe: 'high-contrast-light', name: 'hc-light' }
] as const;
type MatrixTheme = typeof MATRIX_THEMES[number];
/** The probe's theme (the page's body class) as the screenshot names write it. */
const themeName = (probeTheme: string): string => ({ dark: 'dark', light: 'light', 'high-contrast': 'hc', 'high-contrast-light': 'hc-light' } as Record<string, string>)[probeTheme] ?? (probeTheme || 'dark');
interface BoardModelView { selectedMilestone: string; cards: Array<{ id: string; kind: string; column: string; milestoneId?: string }> }

/** A PNG's own width and height, from its IHDR chunk. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const png = await readFile(file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ---- real drags in the board window (62-23, G-62-6) ------------------------------------------------------------------------------------------------
// The board's own drag log (board.js, data-e2e pages only): what the browser's drag events did on the page.
interface DragLogEntry { event: 'dragstart' | 'dragenter' | 'drop' | 'dragend'; column: string; lane: string; verdict: string }
/** The bug the second client adds for the drags: a board item id (item: and 26 Crockford base-32 characters). */
const DRAG_ITEM = `item:${'0'.repeat(22)}DRAG`;
type DragPath = 'mouse' | 'intercepted';

function boardTests(): Array<[string, () => Promise<void>]> {
  const board = new Observer();
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  let api: NearAiTestApi;
  let tap: typeof import('../../services/team/boardView')['boardTap'];
  let asks = 0;
  let editorWidth = 0;
  let planlessPhase = '';
  const problemsOf = (report: LayoutReport): string => `${report.layout} at ${report.width} by ${report.height} px:\n  ${report.problems.join('\n  ')}`;

  // One question to the page's layout probe and its one answer.
  const ask = async (request: { action: 'measure' | 'scroll' | 'focus' | 'rects'; top?: number; left?: number; itemId?: string }): Promise<LayoutReport> => {
    asks += 1;
    const id = asks;
    const before = board.fromView.length;
    await tap.layout!({ id, ...request });
    return (await board.next('fromView', (message) => message.type === 'e2e-layout-report' && message.id === id, before)).report as LayoutReport;
  };
  // Measures once the page has stopped changing size: three readings in a row that agree (a resize reaches the page a little later), and `wanted` holds.
  const settled = async (what: string, wanted: (report: LayoutReport) => boolean = () => true): Promise<LayoutReport> => {
    let last = await ask({ action: 'measure' });
    let steady = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(250);
      const next = await ask({ action: 'measure' });
      steady = next.width === last.width && next.height === last.height && next.layout === last.layout && wanted(next) ? steady + 1 : 0;
      if (steady >= 2) return next;
      last = next;
    }
    throw new Error(`The board did not settle (${what}); last reading ${last.layout} at ${last.width} by ${last.height} px`);
  };
  // Presses a column header on the page (the board's e2e probe), as a person's click would.
  const press = async (column: string): Promise<void> => {
    asks += 1;
    const id = 10_000 + asks;
    const before = board.fromView.length;
    await tap.probe!({ id, action: 'column', column });
    await board.next('fromView', (message) => message.type === 'e2e-facts' && message.id === id, before);
  };
  const fbdir = process.env.NEAR_AI_E2E_FBDIR ?? '';
  const screens = process.env.NEAR_AI_E2E_SCREENS ?? '';
  const photographing = fbdir !== '' && screens !== '';
  const index: ScreenEntry[] = [];
  const one = async (): Promise<void> => {
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
  };
  // Sizes the board's group to the asked width: the whole editor area for 'full', else within WIDTH_SLACK px of the target beside a second group, in
  // up to 4 logged tries. VS Code applies group sizes only when the layout changes shape (so each try goes back to one group first), and the board's
  // group can come out on either side (so the sizes follow the side the reading shows it on). A width the window cannot reach fails with the measured
  // room on a screenshot run, and is logged as not measured otherwise (the default xvfb-run screen is smaller).
  const sizeTo = async (asked: MatrixWidth): Promise<LayoutReport | undefined> => {
    if (asked === 'full') {
      await one();
      return settled('one group', (r) => r.width >= editorWidth - 10);
    }
    let fraction = Math.min(0.9, asked / editorWidth);
    let boardFirst = true;
    let last: LayoutReport | undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await one();
      await settled('one group', (r) => r.width >= editorWidth - 10).catch(() => undefined);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: boardFirst ? [{ size: fraction }, { size: 1 - fraction }] : [{ size: 1 - fraction }, { size: fraction }] });
      const report = await settled('two groups', (r) => r.width < editorWidth - 10).catch(() => undefined);
      console.log(`(width ${asked}: try ${attempt} with ${Math.round(fraction * 100)} percent ${boardFirst ? 'first' : 'second'} reached ${report === undefined ? 'no steady reading' : `${report.width} px, ${report.layout}`})`);
      if (report === undefined) continue;
      last = report;
      if (Math.abs(report.width - asked) <= WIDTH_SLACK) return report;
      if (Math.abs(report.width - (1 - fraction) * editorWidth) < Math.abs(report.width - fraction * editorWidth)) { boardFirst = !boardFirst; continue; }
      fraction = Math.max(0.05, Math.min(0.95, fraction * asked / report.width));
    }
    const room = `the editor area is ${editorWidth} px and the last try reached ${last === undefined ? 'no steady reading' : `${last.width} px`}`;
    if (photographing) throw new Error(`The board's group could not be sized to ${asked} px within ${WIDTH_SLACK} px: ${room}`);
    console.log(`(width ${asked} not measured: ${room})`);
    return undefined;
  };
  // The whole hidden screen as a PNG in the screens folder, when the run gave the framebuffer folder (NEAR_AI_E2E_FBDIR); it must be the screen's size.
  // A frame is taken only after a reading with no problem (T-62-79): the owner never reviews a frame the probe did not check, and screens/index.json
  // says what the probe measured for each one. VS Code's notification toasts sit outside the page, so they are cleared first.
  const photograph = async (file: string, view: string, asked: MatrixWidth, report: LayoutReport): Promise<void> => {
    if (report.problems.length > 0) throw new Error(`No screenshot ${file}: the last reading found ${report.problems.length} problems`);
    if (!photographing) { console.log(`(no screenshot ${file}: the run has no framebuffer folder)`); return; }
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideToasts');
    await sleep(400);
    const out = path.join(screens, file);
    await captureScreen(fbdir, out);
    const screen = readXwd(await readFile(path.join(fbdir, 'Xvfb_screen0')));
    assert.deepEqual(await pngSize(out), { width: screen.width, height: screen.height }, `${file} is the whole screen`);
    index.push({ file, theme: themeName(report.theme), askedWidth: asked, reachedWidth: report.width, layout: report.layout, view, problems: report.problems.length });
    await writeFile(path.join(screens, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  };
  // One width of a theme's row: sized, back at the top, settled, measured with no problem, photographed.
  const top = async (asked: MatrixWidth): Promise<LayoutReport | undefined> => {
    const sized = await sizeTo(asked);
    if (sized === undefined) return undefined;
    // No card keeps the focus an earlier step gave it (the probe's focus rule is for a person's own keyboard focus), as after a click on empty space.
    await act({ action: 'blur' });
    await ask({ action: 'scroll', top: 0, left: 0 });
    const report = await settled(`${asked} px at the top`, (r) => r.width === sized.width);
    assert.equal(report.layout, asked === 480 ? 'list' : 'kanban', `the board at ${report.width} px`);
    assert.deepEqual(report.problems, [], problemsOf(report));
    await photograph(`board-${themeName(report.theme)}-${asked}.png`, 'top', asked, report);
    return report;
  };
  // The built-in theme of a kind: VS Code's own default for it (the default color theme for dark, else the default of the preferred light, high
  // contrast or high contrast light setting), when a built-in theme of that kind has that id; otherwise a built-in Default theme of the kind. Applied to
  // the test window's fresh user settings only (run.ts gives every board run a new user data folder, T-62-78), then the page's theme field must follow.
  const applyTheme = async (theme: MatrixTheme): Promise<string> => {
    const themes = vscode.extensions.all.filter((e) => e.id.startsWith('vscode.'))
      .flatMap((e) => ((e.packageJSON as { contributes?: { themes?: Array<{ id?: string; label?: string; uiTheme?: string }> } }).contributes?.themes ?? []))
      .filter((t) => t.uiTheme === theme.uiTheme)
      .map((t) => t.id ?? t.label ?? '')
      .filter((id) => id !== '');
    const workbench = vscode.workspace.getConfiguration('workbench');
    const preferred = ({ 'vs-dark': 'preferredDarkColorTheme', vs: 'preferredLightColorTheme', 'hc-black': 'preferredHighContrastColorTheme', 'hc-light': 'preferredHighContrastLightColorTheme' } as const)[theme.uiTheme];
    const defaults = [theme.uiTheme === 'vs-dark' ? workbench.inspect<string>('colorTheme')?.defaultValue : undefined, workbench.inspect<string>(preferred)?.defaultValue];
    const chosen = defaults.find((id): id is string => id !== undefined && themes.includes(id)) ?? themes.find((id) => id.startsWith('Default ')) ?? themes[0];
    assert.ok(chosen !== undefined, `a built-in ${theme.uiTheme} theme exists`);
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', chosen, vscode.ConfigurationTarget.Global);
    await settled(`the ${chosen} theme`, (r) => r.theme === theme.probe);
    return chosen;
  };
  // One question to the page's own probe (board.js, E2E only): it acts as a person would and reports what is drawn, focused and open.
  const act = async (probe: { action: 'facts' | 'focus' | 'key' | 'open' | 'group' | 'blur'; itemId?: string; key?: string; group?: string }): Promise<Message> => {
    asks += 1;
    const id = 10_000 + asks;
    const before = board.fromView.length;
    await tap.probe!({ id, ...probe });
    return board.next('fromView', (message) => message.type === 'e2e-facts' && message.id === id, before);
  };
  const fullyIn = (c: LayoutReport['cards'][number], r: LayoutReport['region']): boolean =>
    c.width > 0 && c.height > 0 && c.left >= r.left - 1 && c.top >= r.top - 1 && c.left + c.width <= r.left + r.width + 1 && c.top + c.height <= r.top + r.height + 1;
  // In a kanban width: the board region scrolled 600 px down and 400 px right keeps the toolbar and the header row on top and opaque (the probe's
  // rules), then the last card of the first open lane, focused as the arrow keys do, is fully visible below the header row. Back at the top after.
  const scrollAndFocus = async (theme: MatrixTheme, asked: MatrixWidth, photo: boolean): Promise<void> => {
    await act({ action: 'blur' });
    const scrolled = await ask({ action: 'scroll', top: 600, left: 400 });
    assert.deepEqual(scrolled.problems, [], problemsOf(scrolled));
    if (photo) await photograph(`board-${theme.name}-${asked}-scrolled.png`, 'scrolled', asked, scrolled);
    const atTop = await ask({ action: 'scroll', top: 0, left: 0 });
    const lane = atTop.lanes.find((l) => !l.collapsed);
    assert.ok(lane !== undefined, 'a lane is open');
    const last = atTop.cards.filter((c) => c.lane === lane.lane && c.width > 0).sort((a, b) => a.top - b.top || a.left - b.left).at(-1);
    assert.ok(last !== undefined, `the ${lane.lane} lane has cards`);
    const focused = await ask({ action: 'focus', itemId: last.id });
    assert.equal(focused.focused?.id, last.id, `${last.id} has focus`);
    assert.equal(focused.focused?.visible, true, `${last.id} is fully visible below the header row`);
    assert.deepEqual(focused.problems, [], problemsOf(focused));
    await act({ action: 'blur' });
    await ask({ action: 'scroll', top: 0, left: 0 });
  };
  // One theme's row: the theme applied, then the list under 520 px, 900 px and the full width, then 1400 px, where Done is opened (and, in the dark
  // theme, the detail, the Move to... menu and Group by Phase are shown), each measured with no problem and photographed.
  const row = (theme: MatrixTheme): Array<[string, () => Promise<void>]> => {
    const scrolledPhoto = theme.name === 'dark' || theme.name === 'light';
    const label = (asked: MatrixWidth): string => (asked === 'full' ? 'the full editor width' : `${asked} px`);
    const tests: Array<[string, () => Promise<void>]> = [
      [`${theme.name}: the built-in ${theme.uiTheme} theme is applied to the test window and the page follows`, async () => {
        const chosen = await applyTheme(theme);
        console.log(`(theme ${theme.name}: ${chosen})`);
      }],
      ...([480, 900, 'full', 1400] as MatrixWidth[]).map((asked): [string, () => Promise<void>] => [
        `${theme.name} at ${label(asked)}: nothing wrong at the top${asked === 480 ? '' : ', scrolled down and sideways, or with the last card of the first open lane focused'}, and board-${theme.name}-${asked}.png is saved`,
        async () => {
          const report = await top(asked);
          if (report === undefined) return;
          assert.equal(report.theme, theme.probe, `the ${theme.name} theme`);
          if (asked !== 480) await scrollAndFocus(theme, asked, scrolledPhoto && asked === 1400);
        }
      ]),
      [`${theme.name} at 1400 px with Done open: the folded stub becomes a column of done cards, every card readable, and board-${theme.name}-1400-done.png is saved`, async () => {
        const before = await settled('before Done opens', (r) => r.layout === 'kanban');
        if (Math.abs(before.width - 1400) > WIDTH_SLACK) { if (photographing) throw new Error(`The board is ${before.width} px, not 1400`); console.log('(Done open not measured: 1400 px was not reached)'); return; }
        assert.equal(before.heads.find((head) => head.column === 'done')?.folded, true, 'Done starts folded');
        await act({ action: 'blur' });
        await press('done');
        try {
          const report = await settled('Done open', (r) => r.heads.some((head) => head.column === 'done' && !head.folded));
          assert.ok(report.cards.some((c) => c.column === 'done'), 'the Done cards are drawn');
          assert.deepEqual(report.problems, [], problemsOf(report));
          await photograph(`board-${theme.name}-1400-done.png`, 'done', 1400, report);
        } finally {
          // Folded again whatever happened, so the next theme's row starts from the board's own first view.
          await press('done');
        }
        const folded = await settled('Done folded again', (r) => r.heads.some((head) => head.column === 'done' && head.folded));
        assert.deepEqual(folded.problems, [], problemsOf(folded));
      }]
    ];
    if (theme.name === 'dark') tests.push(
      [`dark at 1400 px with a phase card's detail open: the selected card stays visible beside the drawer, nothing wrong, and board-dark-1400-detail.png is saved`, async () => {
        const before = await settled('before the detail', (r) => r.layout === 'kanban');
        if (Math.abs(before.width - 1400) > WIDTH_SLACK) { if (photographing) throw new Error(`The board is ${before.width} px, not 1400`); return; }
        const phase = before.cards.find((c) => c.id.startsWith('phase:') && fullyIn(c, before.region));
        assert.ok(phase !== undefined, `a phase card is on the first screen (${before.cards.filter((c) => fullyIn(c, before.region)).map((c) => c.id).join(', ')})`);
        const facts = await act({ action: 'open', itemId: phase.id });
        assert.equal(facts.detailOpen, true, 'the detail is open');
        const report = await settled('the detail open', (r) => r.layout === 'kanban');
        assert.deepEqual(report.problems, [], problemsOf(report));
        const seen = report.cards.find((c) => c.id === phase.id);
        // The drawer is 360 px wide (at most half the page) on the right, above the board.
        const drawerLeft = report.width - Math.min(360, report.width / 2);
        assert.ok(seen !== undefined && fullyIn(seen, report.region) && seen.left + seen.width <= drawerLeft + 1, `${phase.id} is fully visible left of the drawer`);
        await photograph('board-dark-1400-detail.png', 'detail', 1400, report);
        const closed = await act({ action: 'key', key: 'Escape' });
        assert.equal(closed.detailOpen, false, 'Escape closes the detail');
        assert.equal(closed.focusedCard, phase.id, 'focus returns to the card');
        await act({ action: 'blur' });
      }],
      [`dark at 1400 px with Move to... open on a card: nothing wrong, and board-dark-1400-menu.png is saved`, async () => {
        const before = await settled('before the menu', (r) => r.layout === 'kanban');
        if (Math.abs(before.width - 1400) > WIDTH_SLACK) { if (photographing) throw new Error(`The board is ${before.width} px, not 1400`); return; }
        const card = before.cards.find((c) => c.column === 'backlog' && fullyIn(c, before.region));
        assert.ok(card !== undefined, 'a Backlog card is on the first screen');
        await act({ action: 'focus', itemId: card.id });
        const facts = await act({ action: 'key', key: 'm' });
        assert.equal(facts.menuOpen, true, 'M opens the Move to... menu');
        const report = await settled('the menu open', (r) => r.layout === 'kanban');
        assert.deepEqual(report.problems, [], problemsOf(report));
        await photograph('board-dark-1400-menu.png', 'menu', 1400, report);
        const closed = await act({ action: 'key', key: 'Escape' });
        assert.equal(closed.menuOpen, false, 'Escape closes the menu');
        await act({ action: 'blur' });
      }],
      [`dark at 1400 px grouped by phase: nothing wrong, every card readable, and board-dark-1400-by-phase.png is saved`, async () => {
        const before = await settled('before Group by Phase', (r) => r.layout === 'kanban');
        if (Math.abs(before.width - 1400) > WIDTH_SLACK) { if (photographing) throw new Error(`The board is ${before.width} px, not 1400`); return; }
        const facts = await act({ action: 'group', group: 'phase' });
        assert.equal(facts.groupBy, 'phase', 'grouped by phase');
        const report = await settled('grouped by phase', (r) => r.layout === 'kanban' && r.lanes.every((l) => !before.lanes.some((b) => b.lane === l.lane)));
        assert.ok(report.cards.length > 0, 'cards are drawn');
        assert.deepEqual(report.problems, [], problemsOf(report));
        await photograph('board-dark-1400-by-phase.png', 'by-phase', 1400, report);
        const back = await act({ action: 'group', group: 'member' });
        assert.equal(back.groupBy, 'member', 'grouped by member again');
        await settled('grouped by member again', (r) => r.lanes.some((l) => before.lanes.some((b) => b.lane === l.lane)));
      }]
    );
    tests.push([`${theme.name}: every frame of the row was taken`, async () => {
      const frames = index.filter((e) => e.theme === theme.name).map((e) => e.file);
      console.log(`(theme ${theme.name}: ${frames.length} frames${frames.length ? `: ${frames.join(', ')}` : ''})`);
      if (photographing) assert.equal(frames.length, 5 + (scrolledPhoto ? 1 : 0) + (theme.name === 'dark' ? 3 : 0), 'frames in this theme');
    }]);
    return tests;
  };

  // ---- real drags (62-23) -----------------------------------------------------------------------------------------------------------------------
  // The drags go through Chromium's own input: DevTools Protocol mouse events on the VS Code window (mouseDrag), or, only when those start no drag in
  // this Electron, Chromium's intercepted drag delivered with Input.dispatchDragEvent (interceptedDrag). Nothing here makes an event inside the page.
  let cdp: CdpSession | undefined;
  let dragPath: DragPath | undefined;
  let boardRemote = '';
  /** Page errors caught before the drags (the width matrix's resizes can leave ResizeObserver notices); the drags must add none. */
  let errorsBeforeDrags = 0;
  /** Events on the coordination branch of the board project's online home (a local bare folder behind a test-only insteadOf rule, run.ts). */
  const eventsOnRemote = (): number => Number(execFileSync('git', ['-C', boardRemote, 'rev-list', '--count', 'refs/heads/near-ai/coordination'], { encoding: 'utf8' }).trim());
  const dragFacts = async (): Promise<{ log: DragLogEntry[]; count: number; live: string; facts: Message }> => {
    const facts = await act({ action: 'facts' });
    return { log: (facts.dragLog as DragLogEntry[] | undefined) ?? [], count: Number(facts.dragCount ?? 0), live: String(facts.live ?? ''), facts };
  };
  /** The drag log entries written since `before` (the page keeps the last 20). */
  const since = (now: { log: DragLogEntry[]; count: number }, before: number): DragLogEntry[] => now.log.slice(Math.max(0, now.log.length - (now.count - before)));
  const describeLog = (entries: DragLogEntry[]): string => entries.map((e) => `${e.event} ${e.lane}/${e.column} ${e.verdict}`).join('; ') || 'nothing';
  // Where a card and a cell of its own row are on the VS Code window: the probe's page positions plus the webview frame's place in the window. The card
  // is first brought into view (focus scrolls it there), then let go of. The drop point is the cell's middle across, at the card's own height (the
  // cells of a row stretch to the row), kept inside the visible board region.
  const aim = async (id: string, column: string, pick?: (cells: LayoutReport['cells'], card: LayoutReport['cards'][number], region: LayoutReport['region']) => LayoutReport['cells'][number] | undefined): Promise<{ from: Point; to: Point; report: LayoutReport; lane: string; targetLane: string }> => {
    await ask({ action: 'focus', itemId: id });
    await act({ action: 'blur' });
    const report = await ask({ action: 'rects' });
    const c = report.cards.find((x) => x.id === id);
    assert.ok(c !== undefined && c.width > 0 && c.height > 0, `${id} is drawn`);
    const target = pick ? pick(report.cells, c, report.region) : report.cells.find((x) => x.lane === c.lane && x.column === column);
    assert.ok(target !== undefined && target.width > 0, `the ${column} cell ${pick ? 'chosen' : `of the ${c.lane} row`} is drawn`);
    assert.ok(cdp !== undefined, 'the DevTools connection is open');
    const frame = await webviewFrameRect(cdp, { width: report.width, height: report.height });
    assert.ok(frame !== undefined, `the board's webview frame (${report.width} by ${report.height}) is found in the window`);
    const r = report.region;
    const inside = (y: number, top: number, height: number): number => Math.max(Math.max(top, r.top) + 8, Math.min(y, Math.min(top + height, r.top + r.height) - 8));
    const from = { x: Math.round(frame.left + c.left + Math.min(60, c.width / 2)), y: Math.round(frame.top + c.top + Math.min(24, c.height / 2)) };
    const to = { x: Math.round(frame.left + target.left + target.width / 2), y: Math.round(frame.top + inside(c.top + c.height / 2, target.top, target.height)) };
    return { from, to, report, lane: c.lane, targetLane: target.lane };
  };
  /** The model's sentences for this card, from the last state the host sent. */
  const refusalsOf = (id: string): Record<string, string> => {
    const state = [...board.toView].reverse().find((m) => m.type === 'state' && m.model !== undefined && cardOf(m, id) !== undefined);
    return ((state === undefined ? undefined : (cardOf(state, id) as unknown as { refusals?: Record<string, string> }).refusals) ?? {});
  };
  const refusalLine = async (id: string): Promise<string> => ((((await dragFacts()).facts.refusals as Array<{ id: string; text: string }> | undefined) ?? []).find((r) => r.id === id)?.text ?? '');
  /**
   * One real drag from `from` to `to`. Mouse input first; when the board's drag log shows no dragstart from it within 2 s, the intercepted drag. The
   * first drag that works fixes the path for the rest of the run. `whileOver` runs with the pointer over the target and the button held (mouse path).
   */
  const realDrag = async (from: Point, to: Point, options: { whileOver?: () => Promise<void> } = {}): Promise<{ path: DragPath; entries: DragLogEntry[] }> => {
    assert.ok(cdp !== undefined, 'the DevTools connection is open');
    const before = (await dragFacts()).count;
    const started = async (): Promise<DragLogEntry[] | undefined> => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const entries = since(await dragFacts(), before);
        if (entries.some((e) => e.event === 'dragstart')) return entries;
        if (Date.now() > deadline) return undefined;
        await sleep(100);
      }
    };
    if (dragPath !== 'intercepted') {
      await mouseDrag(cdp, from, to, { steps: 24, pauseMs: 30, ...(options.whileOver === undefined ? {} : { whileOver: options.whileOver }) });
      const entries = await started();
      if (entries !== undefined) {
        // Let the drop and dragend reach the log.
        await until('the drag to end on the page', async () => (since(await dragFacts(), before).some((e) => e.event === 'dragend') ? true : undefined), 5_000)
          .catch(() => undefined);
        dragPath = 'mouse';
        return { path: 'mouse', entries: since(await dragFacts(), before) };
      }
      if (dragPath === 'mouse') throw new Error(`The mouse drag started no drag this time. Drag log: ${describeLog(since(await dragFacts(), before))}`);
      console.log(`(mouse input started no drag in this Electron; drag log since: ${describeLog(since(await dragFacts(), before))}; trying the intercepted drag)`);
    }
    const intercepted = await interceptedDrag(cdp, from, to, { timeoutMs: 5_000 });
    const entries = since(await dragFacts(), before);
    if (!intercepted || !entries.some((e) => e.event === 'dragstart')) {
      throw new Error(`Neither real input path started a drag. Intercepted: ${intercepted}. Drag log: ${describeLog(entries)}`);
    }
    await until('the drag to end on the page', async () => (since(await dragFacts(), before).some((e) => e.event === 'dragend' || e.event === 'drop') ? true : undefined), 5_000)
      .catch(() => undefined);
    dragPath = 'intercepted';
    return { path: 'intercepted', entries: since(await dragFacts(), before) };
  };

  const allBoardTests: Array<[string, () => Promise<void>]> = [
    ['activates in the board project, a git project holding this repository\'s committed roadmap', async () => {
      api = (await extension().activate())!;
      assert.ok(api?.team, 'the test API carries the team handle');
      assert.equal(await api.team.handle.ready, 'solo', 'no team yet');
      assert.ok(existsSync(path.join(workspace, '.planning', 'ROADMAP.md')), 'the roadmap is in the project');
    }],
    ['Team Mode is enabled and the board opens with the layout probe on the page', async () => {
      const { enableTeamMode } = load<typeof import('../../team/enable')>('team/enable');
      const enabled = await enableTeamMode({
        projectRoot: workspace, globalStorageDir: api.team.globalStorageDir, secrets: api.team.secrets,
        teamName: 'E2E board team', ownerName: 'E2E Owner', remote: 'origin', integrationBranch: 'main'
      });
      assert.equal(enabled.ok, true, enabled.ok ? '' : enabled.message);
      tap = load<typeof import('../../services/team/boardView')>('services/team/boardView').boardTap;
      tap.toView = (message) => board.record(board.toView, message);
      tap.fromView = (message) => board.record(board.fromView, message);
      await vscode.commands.executeCommand('nearAi.team.openBoard');
      await board.next('fromView', (message) => message.type === 'ready');
      await board.next('toView', (message) => message.type === 'state');
      assert.ok(tap.layout, 'the layout hook is offered under NEAR_AI_E2E=1');
      const first = await ask({ action: 'rects' });
      assert.ok(first.width > 0, 'the probe on the page answers');
    }],
    ['the roadmap is imported, and the current milestone\'s phases without plans are Backlog cards', async () => {
      await vscode.commands.executeCommand('nearAi.team.importPlans', { milestone: 'current' });
      const state = await board.next('toView', (message) => {
        if (message.type !== 'state' || message.model === undefined) return false;
        const model = message.model as BoardModelView;
        return model.cards.some((card) => card.kind === 'plan') && model.cards.some((card) => card.kind === 'phase' && card.milestoneId === model.selectedMilestone);
      }, 0, 60_000);
      const model = state.model as BoardModelView;
      const phase = model.cards.find((card) => card.kind === 'phase' && card.milestoneId === model.selectedMilestone)!;
      assert.equal(phase.column, 'backlog', `${phase.id} is a Backlog card`);
      planlessPhase = phase.id;
      // The page draws the imported cards.
      await until('the imported cards on the page', async () => ((await ask({ action: 'rects' })).cards.length > 0 ? true : undefined));
    }],
    ['the window fills the hidden screen, and the editor area has the whole window: no side bars, no panel and one editor group', async () => {
      for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) await vscode.commands.executeCommand(command);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
      const before = await settled('the editor area alone', (r) => r.layout === 'kanban');
      // Under Xvfb there is no window manager, so VS Code's maximized setting does nothing and the window keeps its 1440 by 900 default (62-21). The
      // run gives it the whole screen itself; on a screenshot run that is required, otherwise the run measures what the window has.
      try {
        const filled = await fillScreen();
        console.log(`(the window ${filled.before.width} by ${filled.before.height} at ${filled.before.x},${filled.before.y} now fills the ${filled.screen.width} by ${filled.screen.height} hidden screen: ${filled.after.width} by ${filled.after.height}, the pointer parked at ${filled.pointer.x},${filled.pointer.y})`);
        assert.deepEqual(filled.after, { x: 0, y: 0, width: filled.screen.width, height: filled.screen.height }, 'the window has the whole screen');
      } catch (error) {
        if (photographing) throw error;
        console.log(`(the window keeps its size: ${String((error as Error).message ?? error)})`);
      }
      const report = before.width >= 1000 && !photographing ? await settled('the editor area alone', (r) => r.layout === 'kanban')
        : await settled('the editor area of the whole screen', (r) => r.layout === 'kanban' && r.width > before.width);
      editorWidth = report.width;
      console.log(`(the editor area is ${editorWidth} by ${report.height} px; it was ${before.width} by ${before.height} px)`);
      assert.ok(editorWidth >= 1000, `the board is ${editorWidth} px wide`);
    }],
    ['first open, before anything changes the view: Backlog and Ready open, the later four, Done and Cancelled folded, Unassigned open, Backlog work in full view and the first planless phase reachable without a click', async () => {
      const report = await settled('the first open', (r) => r.layout === 'kanban' && r.cards.length > 0);
      assert.deepEqual(report.heads.filter((head) => head.folded).map((head) => head.column), ['claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
      assert.deepEqual(report.heads.filter((head) => !head.folded).map((head) => head.column), ['backlog', 'ready']);
      const unassigned = report.lanes.find((lane) => lane.lane === 'unassigned');
      assert.ok(unassigned !== undefined && !unassigned.collapsed, 'the Unassigned lane is open');
      assert.ok(report.visibleCards >= 1, `${report.visibleCards} cards are fully visible`);
      const r = report.region;
      const inView = report.cards.filter((c) => c.width > 0 && c.height > 0 && c.left >= r.left - 1 && c.top >= r.top - 1 && c.left + c.width <= r.left + r.width + 1 && c.top + c.height <= r.top + r.height + 1);
      assert.ok(inView.some((c) => c.column === 'backlog'), `a Backlog card is fully visible without any click (in view: ${inView.map((c) => c.id).join(', ')})`);
      const phase = report.cards.find((c) => c.id === planlessPhase);
      assert.ok(phase !== undefined && phase.column === 'backlog' && phase.width > 0 && phase.height > 0, `${planlessPhase} is drawn in the open Backlog cell`);
      if (!inView.some((c) => c.id === planlessPhase)) {
        // 62-19 orders a column by phase, then plan, so this repository's unfinished Phase 62 plans come before the first phase without plans. Scrolling
        // the board region alone, with no click, brings it fully into view under the header row.
        const below = Math.ceil(phase.top + phase.height - (r.top + r.height));
        console.log(`(${planlessPhase} starts ${Math.ceil(phase.top - r.top)} px into a ${r.height} px board region, behind ${inView.length} fully visible cards)`);
        const scrolled = await ask({ action: 'scroll', top: below + 48 });
        const seen = scrolled.cards.find((c) => c.id === planlessPhase)!;
        const s = scrolled.region;
        assert.ok(seen.top >= s.top - 1 && seen.top + seen.height <= s.top + s.height + 1, `${planlessPhase} is fully visible after scrolling the board region by ${scrolled.region.scrollTop} px`);
        assert.deepEqual(scrolled.problems, [], problemsOf(scrolled));
        await ask({ action: 'scroll', top: 0, left: 0 });
      }
    }],
    // The screenshot matrix (62-22, G-62-2, G-62-4, G-62-7): every theme at four widths, scrolled, focused, with Done open, and the extra views.
    ...MATRIX_THEMES.flatMap(row),
    ['back in the dark theme at the full editor width with Done opened once, every drawn card is readable: none in a folded column, whole words on a line, the card\'s own look', async () => {
      await applyTheme(MATRIX_THEMES[0]);
      await sizeTo('full');
      await act({ action: 'blur' });
      const before = await settled('before Done opens', (r) => r.layout === 'kanban');
      if (before.heads.find((head) => head.column === 'done')?.folded === true) await press('done');
      const report = await settled('Done open', (r) => r.heads.some((head) => head.column === 'done' && !head.folded));
      assert.ok(report.cards.some((c) => c.column === 'done'), 'the Done cards are drawn');
      assert.deepEqual(report.problems, [], problemsOf(report));
      const scrolled = await ask({ action: 'scroll', top: 600, left: 400 });
      assert.deepEqual(scrolled.problems, [], problemsOf(scrolled));
    }],
    ['the screenshot index lists every frame with no problem in any', async () => {
      if (!photographing) return;
      const listed = JSON.parse(await readFile(path.join(screens, 'index.json'), 'utf8')) as ScreenEntry[];
      const pngs = (await readdir(screens)).filter((f) => f.endsWith('.png')).sort();
      assert.deepEqual(listed.map((e) => e.file).sort(), pngs, 'one index line per PNG');
      assert.ok(listed.every((e) => e.problems === 0), 'no frame with a problem');
      console.log(`(${pngs.length} frames in ${screens})`);
    }],
    // ---- real drags (62-23, G-62-6): dark, 1400 px, Group by Member, one editor group beside a second -------------------------------------------
    ['drag set-up: dark at 1400 px grouped by member, a bug the owner\'s second client adds with scope and an estimate is Ready, and the window\'s DevTools endpoint answers', async () => {
      const port = Number(process.env.NEAR_AI_E2E_CDP_PORT ?? '');
      assert.ok(Number.isInteger(port) && port > 0, 'run.ts gives the board window a DevTools port');
      boardRemote = execFileSync('git', ['-C', workspace, 'config', '--get-regexp', '^url\\..*\\.insteadof$'], { encoding: 'utf8' }).trim().split(/\s+/)[0].replace(/^url\./, '').replace(/\.insteadof$/i, '');
      assert.ok(existsSync(boardRemote), 'the online home is the local bare folder');
      await applyTheme(MATRIX_THEMES[0]);
      const sized = await sizeTo(1400);
      assert.ok(sized === undefined || sized.layout === 'kanban', 'the kanban');
      const grouped = await act({ action: 'group', group: 'member' });
      assert.equal(grouped.groupBy, 'member', 'grouped by member');
      await act({ action: 'blur' });
      await ask({ action: 'scroll', top: 0, left: 0 });

      // The owner's second client (another computer with the same device key) adds the bug, as in the team scenario.
      const session = api.team.handle.session();
      assert.ok(session, 'a session is running');
      const { TeamLog } = load<typeof import('../../team/eventLog')>('team/eventLog');
      const { GitTransport } = load<typeof import('../../team/gitTransport')>('team/gitTransport');
      const { teamMaterializer } = load<typeof import('../../domain/team/materialize')>('domain/team/materialize');
      const { loadDeviceIdentity } = load<typeof import('../../team/identity')>('team/identity');
      const { teamStorageDir } = load<typeof import('../../team/teamFile')>('team/teamFile');
      const teamFile = session!.teamFile;
      const anchor = { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-board-second-'));
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
      const appended = await second.append(() => [{ type: 'item.created', body: { id: DRAG_ITEM, kind: 'bug', title: 'Drag me to Backlog', scope: ['src/team/**'], requirements: [], mustHaves: [], estimate: { tokens: 2000 } } }]);
      assert.equal(appended.ok, true, appended.ok ? '' : appended.reason);
      session!.nudge();
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, DRAG_ITEM)?.column === 'ready', toBefore, 30_000);
      assert.equal(cardOf(state, DRAG_ITEM)?.held, false, 'not on hold');
      await until('the bug drawn in Ready', async () => ((await ask({ action: 'rects' })).cards.some((c) => c.id === DRAG_ITEM && c.column === 'ready' && c.draggable) ? true : undefined));
      const drawn = (await ask({ action: 'rects' })).cards;
      const kinds = (ids: string[]): string => ['plan', 'phase', 'item'].map((k) => `${ids.filter((id) => id.startsWith(`${k}:`)).length} ${k}`).join(', ');
      console.log(`(${drawn.filter((c) => c.draggable).length} of ${drawn.length} drawn cards can be dragged by the owner: ${kinds(drawn.filter((c) => c.draggable).map((c) => c.id))}; not draggable: ${kinds(drawn.filter((c) => !c.draggable).map((c) => c.id))})`);

      errorsBeforeDrags = (((await dragFacts()).facts.errors as string[] | undefined) ?? []).length;
      cdp = await connectCdp(port);
      const version = await cdp.send<{ product?: string }>('Browser.getVersion').catch(() => ({ product: 'unknown' }));
      console.log(`(DevTools endpoint on 127.0.0.1:${port}: ${version.product ?? 'unknown'})`);
    }],
    ['a real mouse drag of the Ready bug into Backlog of its own row puts it on hold: one move request, one more signed event, and the card drawn in Backlog', async () => {
      const { from, to, lane } = await aim(DRAG_ITEM, 'backlog');
      const events = eventsOnRemote();
      const fromBefore = board.fromView.length;
      const toBefore = board.toView.length;
      const { path: used, entries } = await realDrag(from, to);
      console.log(`drag path: ${used}`);
      console.log(`(drag log: ${describeLog(entries)})`);
      const start = entries.findIndex((e) => e.event === 'dragstart');
      assert.deepEqual(entries[start], { event: 'dragstart', column: 'ready', lane, verdict: 'started' }, `the browser's own dragstart (log: ${describeLog(entries)})`);
      assert.deepEqual(entries.find((e) => e.event === 'drop'), { event: 'drop', column: 'backlog', lane, verdict: 'ok' }, `the drop lands on Backlog of the same row (log: ${describeLog(entries)})`);
      const posted = await board.next('fromView', (message) => message.type === 'move', fromBefore);
      assert.deepEqual(posted, { type: 'move', itemId: DRAG_ITEM, target: 'hold' });
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, DRAG_ITEM)?.held === true, toBefore, 30_000);
      assert.equal(cardOf(state, DRAG_ITEM)?.column, 'backlog', 'the next state shows the bug in Backlog');
      await until('one more event on the coordination record', () => (eventsOnRemote() === events + 1 ? true : undefined), 20_000);
      assert.equal(board.fromView.slice(fromBefore).filter((m) => m.type === 'move').length, 1, 'exactly one move request');
      await until('the bug drawn in Backlog', async () => ((await ask({ action: 'rects' })).cards.some((c) => c.id === DRAG_ITEM && c.column === 'backlog') ? true : undefined));
    }],
    ['Escape during a real drag over the offered Ready cell cancels it: nothing is posted, no event is written, the card stays in Backlog and the cancel is announced; drag-over-dark-1400.png shows the offered cell', async () => {
      const { from, to, lane } = await aim(DRAG_ITEM, 'ready');
      const events = eventsOnRemote();
      const fromBefore = board.fromView.length;
      let overFrame = false;
      let cancelledBy = '';
      // VS Code's notification toasts sit outside the page; they are cleared before the button is pressed, since the frame is taken mid-drag.
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('notifications.hideToasts');
      const logBefore = (await dragFacts()).count;
      const { path: used, entries } = await realDrag(from, to, {
        whileOver: async () => {
          // The frame with the pointer held over the offered cell: the probe's reading at that moment goes into index.json, whatever it found.
          await sleep(300);
          const reading = await ask({ action: 'measure' });
          console.log(`(mid-drag reading: ${reading.problems.length} problems${reading.problems.length ? `: ${reading.problems.join(' | ')}` : ''})`);
          if (photographing) {
            const file = 'drag-over-dark-1400.png';
            await captureScreen(fbdir, path.join(screens, file));
            index.push({ file, theme: themeName(reading.theme), askedWidth: 1400, reachedWidth: reading.width, layout: reading.layout, view: 'drag-over', problems: reading.problems.length });
            await writeFile(path.join(screens, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
            overFrame = true;
          } else console.log('(no screenshot drag-over-dark-1400.png: the run has no framebuffer folder)');
          await pressKey(cdp!, 'Escape');
          await sleep(300);
          if (since(await dragFacts(), logBefore).some((e) => e.event === 'dragend')) cancelledBy = 'Escape';
          else {
            // Chromium's DevTools-driven drag does not hear keys while the button is held (a native drag hears Escape in the system's drag loop and
            // cancels it there). Input.cancelDragging is that same cancel, done by Chromium: the page gets the dragend with no drop it gets after Escape.
            console.log('(Escape did not reach the DevTools-driven drag; Chromium cancels it with Input.cancelDragging, as the system does on Escape)');
            await cdp!.send('Input.cancelDragging');
            await sleep(300);
            cancelledBy = 'Input.cancelDragging after Escape';
          }
        }
      });
      console.log(`(drag log: ${describeLog(entries)}; cancelled by ${cancelledBy || 'nothing'})`);
      if (used === 'intercepted') console.log('(no drag-over frame: an intercepted drag holds no pointer over the page)');
      else if (photographing) assert.ok(overFrame, 'the mid-drag frame was taken');
      assert.ok(entries.some((e) => e.event === 'dragenter' && e.column === 'ready' && e.lane === lane && e.verdict === 'ok'), `the pointer was over the offered Ready cell (log: ${describeLog(entries)})`);
      assert.equal(entries.some((e) => e.event === 'drop' && e.verdict !== 'ignored'), false, `no drop is taken (log: ${describeLog(entries)})`);
      await sleep(1_500);
      assert.deepEqual(board.fromView.slice(fromBefore).filter((m) => m.type === 'move'), [], 'nothing is posted');
      assert.equal(eventsOnRemote(), events, 'no event is written');
      const live = await until('the cancel announced', async () => { const l = (await dragFacts()).live; return /^Move cancelled\. The card is still in /.test(l) ? l : undefined; }, 5_000);
      console.log(`(announced: ${live})`);
      const report = await ask({ action: 'rects' });
      assert.equal(report.cards.find((c) => c.id === DRAG_ITEM)?.column, 'backlog', 'the card is still in Backlog');
    }],
    ['a real drag of the held bug onto the folded In progress column is refused: nothing posted or written, the card stays in Backlog with the model\'s reason, which is announced; drag-refused-dark-1400.png shows it', async () => {
      const sentence = refusalsOf(DRAG_ITEM)['in-progress'];
      assert.ok(typeof sentence === 'string' && sentence.length > 0, 'the model carries the In progress sentence');
      const { from, to, lane } = await aim(DRAG_ITEM, 'in-progress');
      const events = eventsOnRemote();
      const fromBefore = board.fromView.length;
      const { entries } = await realDrag(from, to);
      console.log(`(drag log: ${describeLog(entries)})`);
      assert.deepEqual(entries.find((e) => e.event === 'drop'), { event: 'drop', column: 'in-progress', lane, verdict: 'no' }, `the drop lands on In progress and is refused (log: ${describeLog(entries)})`);
      await sleep(1_500);
      assert.deepEqual(board.fromView.slice(fromBefore).filter((m) => m.type === 'move'), [], 'no move request reaches the host');
      assert.equal(eventsOnRemote(), events, 'the record gains no event');
      assert.equal(await refusalLine(DRAG_ITEM), sentence, 'the card shows the reason');
      const live = await until('the refusal announced', async () => { const l = (await dragFacts()).live; return l.startsWith("Can't move ") && l.endsWith(` to In progress. ${sentence}`) ? l : undefined; }, 5_000);
      console.log(`(announced: ${live})`);
      const report = await settled('the refused drop', (r) => r.cards.some((c) => c.id === DRAG_ITEM && c.column === 'backlog'));
      assert.deepEqual(report.problems, [], problemsOf(report));
      const seen = report.cards.find((c) => c.id === DRAG_ITEM)!;
      assert.ok(fullyIn(seen, report.region), 'the card with its reason is fully in view');
      await photograph('drag-refused-dark-1400.png', 'drag-refused', 1400, report);
    }],
    ['grouped by phase, a real drag into another phase row is refused with the row sentence and nothing is moved', async () => {
      const facts = await act({ action: 'group', group: 'phase' });
      assert.equal(facts.groupBy, 'phase', 'grouped by phase');
      await settled('grouped by phase', (r) => r.layout === 'kanban' && !r.lanes.some((l) => l.lane === 'unassigned'));
      const { from, to, lane, targetLane } = await aim(DRAG_ITEM, 'backlog', (cells, card, region) => cells
        .filter((x) => x.column === 'backlog' && x.lane !== card.lane && x.width > 0 && x.height > 0 && x.top + x.height > region.top + 16 && x.top < region.top + region.height - 16)
        .sort((a, b) => Math.abs(a.top - card.top) - Math.abs(b.top - card.top))[0]);
      assert.notEqual(targetLane, lane, 'the target is another row');
      const events = eventsOnRemote();
      const fromBefore = board.fromView.length;
      const { entries } = await realDrag(from, to);
      console.log(`(drag log: ${describeLog(entries)})`);
      assert.deepEqual(entries.find((e) => e.event === 'drop'), { event: 'drop', column: 'backlog', lane: targetLane, verdict: 'no' }, `the drop lands in row ${targetLane} and is refused (log: ${describeLog(entries)})`);
      await sleep(1_500);
      assert.deepEqual(board.fromView.slice(fromBefore).filter((m) => m.type === 'move'), [], 'nothing is posted');
      assert.equal(eventsOnRemote(), events, 'no event is written');
      assert.equal(await refusalLine(DRAG_ITEM), 'This card stays in its own row. Drop it in another column of the same row.');
      const back = await act({ action: 'group', group: 'member' });
      assert.equal(back.groupBy, 'member', 'grouped by member again');
      await settled('grouped by member again', (r) => r.lanes.some((l) => l.lane === 'unassigned'));
    }],
    ['Move to... is still the keyboard path in the same window: M, then Down to Ready (release the hold) and Enter releases the hold', async () => {
      const toBefore = board.toView.length;
      const fromBefore = board.fromView.length;
      // Real keys from the keyboard input of the window (DevTools Protocol), so Enter presses the menu item as a person's Enter does.
      let facts = await act({ action: 'focus', itemId: DRAG_ITEM });
      assert.equal(facts.focusedCard, DRAG_ITEM, 'the card takes focus');
      assert.equal(facts.hasFocus, true, 'the board page has the keyboard');
      await pressKey(cdp!, 'm');
      facts = await act({ action: 'facts' });
      assert.equal(facts.menuOpen, true, 'M opens Move to...');
      for (let step = 0; step < 8 && facts.focusedText !== 'Ready (release the hold)'; step += 1) { await pressKey(cdp!, 'ArrowDown'); facts = await act({ action: 'facts' }); }
      assert.equal(facts.focusedText, 'Ready (release the hold)', 'Down reaches Ready (release the hold)');
      await pressKey(cdp!, 'Enter');
      const posted = await board.next('fromView', (message) => message.type === 'move', fromBefore);
      assert.deepEqual(posted, { type: 'move', itemId: DRAG_ITEM, target: 'release' });
      const state = await board.next('toView', (message) => message.type === 'state' && cardOf(message, DRAG_ITEM)?.held === false, toBefore, 30_000);
      assert.equal(cardOf(state, DRAG_ITEM)?.column, 'ready', 'the card is shown in Ready again');
      await until('the bug drawn in Ready', async () => ((await ask({ action: 'rects' })).cards.some((c) => c.id === DRAG_ITEM && c.column === 'ready') ? true : undefined));
      assert.deepEqual((((await dragFacts()).facts.errors as string[] | undefined) ?? []).slice(errorsBeforeDrags), [], 'no page error during the drags');
    }],
    ['the drag frames are in the screenshot index, and the DevTools connection is closed', async () => {
      cdp?.close();
      cdp = undefined;
      if (!photographing) return;
      const listed = JSON.parse(await readFile(path.join(screens, 'index.json'), 'utf8')) as ScreenEntry[];
      const pngs = (await readdir(screens)).filter((f) => f.endsWith('.png')).sort();
      assert.deepEqual(listed.map((e) => e.file).sort(), pngs, 'one index line per PNG');
      assert.equal(listed.find((e) => e.file === 'drag-refused-dark-1400.png')?.view, 'drag-refused');
      assert.equal(listed.find((e) => e.file === 'drag-refused-dark-1400.png')?.problems, 0);
      if (dragPath === 'mouse') assert.equal(listed.find((e) => e.file === 'drag-over-dark-1400.png')?.view, 'drag-over');
    }]
  ];
  return allBoardTests;
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
