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
import { captureScreen, readXwd } from './xwdPng';

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
}
interface BoardModelView { selectedMilestone: string; cards: Array<{ id: string; kind: string; column: string; milestoneId?: string }> }

/** A PNG's own width and height, from its IHDR chunk. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const png = await readFile(file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function boardTests(): Array<[string, () => Promise<void>]> {
  const board = new Observer();
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  let api: NearAiTestApi;
  let tap: typeof import('../../services/team/boardView')['boardTap'];
  let asks = 0;
  let editorWidth = 0;
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
  // The whole hidden screen as a PNG in the screens folder, when the run gave the framebuffer folder (NEAR_AI_E2E_FBDIR); it must be the screen's size.
  const screenshot = async (name: string): Promise<void> => {
    const fbdir = process.env.NEAR_AI_E2E_FBDIR;
    const screens = process.env.NEAR_AI_E2E_SCREENS;
    if (fbdir === undefined || fbdir === '' || screens === undefined || screens === '') { console.log(`(no screenshot ${name}: the run has no framebuffer folder)`); return; }
    const out = path.join(screens, name);
    await captureScreen(fbdir, out);
    const screen = readXwd(await readFile(path.join(fbdir, 'Xvfb_screen0')));
    assert.deepEqual(await pngSize(out), { width: screen.width, height: screen.height }, `${name} is the whole screen`);
  };

  return [
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
      // The page draws the imported cards.
      await until('the imported cards on the page', async () => ((await ask({ action: 'rects' })).cards.length > 0 ? true : undefined));
    }],
    ['the editor area has the whole window: no side bars, no panel and one editor group', async () => {
      for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) await vscode.commands.executeCommand(command);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
      const report = await settled('the editor area alone', (r) => r.layout === 'kanban');
      editorWidth = report.width;
      assert.ok(editorWidth >= 1000, `the board is ${editorWidth} px wide`);
    }],
    ['at the full editor width the layout probe finds nothing wrong, and the screen is saved as board-dark-full.png', async () => {
      const report = await settled('the full editor width', (r) => r.layout === 'kanban');
      await screenshot(`board-${report.theme || 'dark'}-full.png`);
      assert.equal(report.layout, 'kanban');
      assert.deepEqual(report.problems, [], problemsOf(report));
    }],
    ['after scrolling down and sideways the toolbar and the column header row stay solid on top and cover no card', async () => {
      const report = await ask({ action: 'scroll', top: 600, left: 300 });
      assert.deepEqual(report.problems, [], problemsOf(report));
      const back = await ask({ action: 'scroll', top: 0, left: 0 });
      assert.deepEqual(back.problems, [], problemsOf(back));
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
