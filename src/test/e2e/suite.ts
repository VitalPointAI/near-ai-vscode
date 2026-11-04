import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';
import type { LayoutReport } from '../../services/layoutProbe';

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
  const tests: Array<[string, () => Promise<void>]> = scenario === 'plain' ? plainTests() : projectTests();
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
    ['every panel fits narrow widths without scrolling sideways', async () => {
      // A reply with a wide table, a long code line and a long path, so the chat has something to fit.
      const before = observer.toView.length;
      await api.sidebar.request({ type: 'send', text: 'wide reply', model: 'fake-coder' });
      await observer.next('toView', (message) => message.type === 'assistant-done', before);
      const problems: string[] = [];
      // Overflow at any width a page reaches fails at once; a retry never hides it.
      const checked = new Set<string>();
      const checkOverflow = (name: string, report: LayoutReport) => {
        const key = `${name}@${report.width}`;
        if (checked.has(key)) return;
        checked.add(key);
        if (report.scrollWidth > report.clientWidth + 1 || report.bodyScrollWidth > report.bodyClientWidth + 1) problems.push(`${name} at ${report.width}px scrolls sideways: page ${report.scrollWidth} in ${report.clientWidth}, body ${report.bodyScrollWidth} in ${report.bodyClientWidth}`);
        for (const offender of report.offenders) problems.push(`${name} at ${report.width}px: ${offender}`);
        for (const scroller of report.scrollers) problems.push(`${name} at ${report.width}px: ${scroller}`);
      };
      // VS Code sometimes applies a resize late or not at all. Each width gets up to 4 tries, every try
      // set up afresh after a pause and logged, so CI shows any flakiness; only 4 misses fail the test.
      const measure = async (name: string, target: number, size: () => Promise<LayoutReport>, reset: () => Promise<void>, trace?: () => string) => {
        let report = await size();
        checkOverflow(name, report);
        for (let attempt = 2; attempt <= 4 && Math.abs(report.width - target) > 40; attempt += 1) {
          const groups = vscode.window.tabGroups.all.map((group) => `column ${group.viewColumn}${group.isActive ? ' (active)' : ''}: ${group.tabs.map((tab) => tab.label).join(', ') || 'empty'}`).join(' | ');
          console.log(`  retrying ${name} at ${target}px, attempt ${attempt} (it was ${report.width}px; editor groups: ${groups}${trace ? `; ${trace()}` : ''})`);
          await reset();
          await pause(2_000);
          report = await size();
          checkOverflow(name, report);
        }
        console.log(`  ${name} at ${report.width}px (asked ${target}px): page ${report.scrollWidth}/${report.clientWidth}, body ${report.bodyScrollWidth}/${report.bodyClientWidth}`);
        if (Math.abs(report.width - target) > 40) problems.push(`${name}: could not size the panel to ${target}px in 4 tries (it is ${report.width}px${trace ? `; ${trace()}` : ''})`);
      };
      // The sidebar: VS Code's own resize commands, a step at a time, until the chat is as close as they get.
      await vscode.commands.executeCommand('nearAiChatView.focus');
      for (const target of SIDEBAR_WIDTHS) await measure('chat', target, () => sizeSidebar(target), chatBesideEditor, () => `steps: ${sidebarTrace.join(', ')}`);
      // Narrow again, so the editor area has room for the widest editor check.
      await sizeSidebar(220);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // Editor panels: the page in the first of two editor groups, sized by the groups' proportions.
      // Pages with little to show in a fresh project get wide sample data, as their hosts would send it.
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { activityTap } = require(path.join(extension.extensionPath, 'dist/services/activityView')) as typeof import('../../services/activityView');
      const { comparisonTap } = require(path.join(extension.extensionPath, 'dist/services/modelComparisonPanel')) as typeof import('../../services/modelComparisonPanel');
      const seen: Message[] = [];
      activityTap.toView = (message) => seen.push(message as Message);
      comparisonTap.toView = (message) => seen.push(message as Message);
      const unmeasured: string[] = [];
      try {
        for (const [name, command] of PANELS) {
          await vscode.commands.executeCommand(command);
          await waitForProbe(name);
          samples.set(name, sampleData(name, seen));
          await editorAreaOnly();
          let { room, editor } = await editorRoom(name);
          for (let attempt = 2; attempt <= 4 && room < Math.max(...EDITOR_WIDTHS); attempt += 1) {
            console.log(`  retrying ${name}: measuring the editor area, attempt ${attempt} (editor area ${editor}px, page at most ${room}px)`);
            await pause(2_000);
            ({ room, editor } = await editorRoom(name));
          }
          console.log(`  ${name}: editor area ${editor}px, a page can be up to ${room}px beside a second group`);
          assert.ok(room >= Math.max(...EDITOR_WIDTHS), `the editor area holds a ${Math.max(...EDITOR_WIDTHS)}px page beside a second group (editor area ${editor}px, page at most ${room}px)`);
          for (const width of WIDER_EDITOR_WIDTHS.filter((width) => width > room)) unmeasured.push(`${name} at ${width}px (the window holds ${room}px)`);
          for (const target of [...EDITOR_WIDTHS, ...WIDER_EDITOR_WIDTHS.filter((width) => width <= room)]) await measure(name, target, () => sizeEditor(name, target, editor), async () => {
            // A fresh start: the page closed and opened again, alone in one group.
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await oneGroup();
            await vscode.commands.executeCommand(command);
            await waitForProbe(name);
          });
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
          await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
        }
      } finally {
        // Back to the usual layout for the tests after this one, whatever happened above.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
        await vscode.commands.executeCommand('workbench.view.explorer');
        await vscode.commands.executeCommand('nearAiChatView.focus');
      }
      if (unmeasured.length) console.warn(`  !! NOT MEASURED, the window is too small: ${unmeasured.join('; ')}`);
      // In CI the window must hold every width, so a width it could not measure fails rather than passing unseen.
      if (unmeasured.length && process.env.CI) problems.push(`not measured in CI (window too small): ${unmeasured.join('; ')}`);
      console.log(`  Widths measured: chat ${SIDEBAR_WIDTHS.join(', ')}px; pages ${[...EDITOR_WIDTHS, ...WIDER_EDITOR_WIDTHS].join(', ')}px${unmeasured.length ? ` except ${unmeasured.length} too wide for this window` : ''}; text set in a wider stand-in font.`);
      assert.deepEqual(problems, []);
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
    }],
    ['the Cybersecurity command opens its panel in a folder with no NEAR AI setup', async () => {
      // This is the whole reason nearAi.openCyber has its own activation event: everything else waits
      // for workspaceContains:.planning/.near-ai, and a cyber engagement can target any folder.
      const before = vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0);
      await vscode.commands.executeCommand('nearAi.openCyber');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      const cyber = tabs.find((tab) => (tab.label ?? '').includes('Cybersecurity'));
      assert.ok(cyber, `a Cybersecurity tab is open (tabs: ${tabs.map((tab) => tab.label).join(', ')}; before ${before})`);
      assert.deepEqual(await readdir(workspace), [], 'the panel writes nothing into the folder');
    }],
    ['re-running the command reveals the same panel rather than opening a second one', async () => {
      const count = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => (tab.label ?? '').includes('Cybersecurity')).length;
      assert.equal(count(), 1);
      await vscode.commands.executeCommand('nearAi.openCyber');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(count(), 1, 'the panel is a singleton (D-01)');
    }]
  ];
}

// ---- Layout at narrow widths (the pages report their own measurements through the test-only probe) ----

// The sidebar resizes in 60px steps from its 170px minimum, so every step up to about 600px is checked.
const SIDEBAR_WIDTHS = [170, 230, 290, 350, 410, 470, 530, 590];
// Editor pages: these always (run.ts opens a window wide enough), plus wider ones when the window holds them.
const EDITOR_WIDTHS = [220, 320, 470, 600];
const WIDER_EDITOR_WIDTHS = [800, 1000];
const PANELS: Array<[string, string]> = [
  ['activity', 'nearAi.openAgentActivity'], ['compare', 'nearAi.compareModels'], ['mcp', 'nearAi.manageMcp'],
  ['teams', 'nearAi.manageTeams'], ['tools', 'nearAi.openTools'], ['onboarding', 'nearAi.setup']
];
const samples = new Map<string, Message[]>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(name: string): Promise<LayoutReport> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { probeLayout } = require(path.join(extension.extensionPath, 'dist/services/layoutProbe')) as typeof import('../../services/layoutProbe');
  // The chat shares the secondary sidebar with VS Code's own chat view, which the resize steps
  // bring up; if the NEAR AI chat is not on screen when asked, it is shown again and asked once more.
  for (let attempt = 0; ; attempt += 1) {
    try { return await probeLayout(name, 5_000); } catch (error) {
      if (attempt >= 2) throw error;
      if (name === 'chat') await vscode.commands.executeCommand('nearAiChatView.focus');
      await pause(1_000);
    }
  }
}

/** Measures once the panel has stopped changing size (a resize reaches the page a little later). */
async function settled(name: string): Promise<LayoutReport> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { postToPage } = require(path.join(extension.extensionPath, 'dist/services/layoutProbe')) as typeof import('../../services/layoutProbe');
  // A wider font than VS Code's (monospace, 10% larger), so a run here also catches a layout that
  // only overflows with another machine's fonts.
  await postToPage(name, { type: 'layout-stress' });
  for (const message of samples.get(name) ?? []) await postToPage(name, message);
  let last = await probe(name);
  let steady = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await pause(250);
    const next = await probe(name);
    // Three readings in a row that agree: the page has finished resizing.
    steady = next.width === last.width && next.scrollWidth === last.scrollWidth ? steady + 1 : 0;
    if (steady >= 2) return next;
    last = next;
  }
  return last;
}

async function waitForProbe(name: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await probe(name); await pause(1_000); return; } catch (error) { if (Date.now() > deadline) throw error; await pause(250); }
  }
}

/**
 * How wide the editor area is, and the widest the page can be beside a second group at its minimum.
 * Alone in one group, the page is exactly as wide as the editor area.
 */
async function editorRoom(name: string): Promise<{ room: number; editor: number }> {
  await oneGroup();
  const editor = (await settled(name)).width;
  const most = await sizeEditor(name, editor, editor);
  return { room: most.width, editor };
}

/** Gives the editor area the whole window (no sidebars or panel) for the editor page checks. */
async function editorAreaOnly(): Promise<void> {
  for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) await vscode.commands.executeCommand(command);
}

async function oneGroup(): Promise<void> {
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
  await pause(500);
}

/** Waits (up to `ms`) until the page's width passes `test`, then until it settles. */
async function widthWhen(name: string, test: (width: number) => boolean, ms = 5_000): Promise<LayoutReport> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !test((await probe(name)).width)) await pause(200);
  return settled(name);
}

/**
 * Splits the editor area in two and sizes the page's group to the target width, measuring each try.
 * VS Code applies new group sizes only when the layout changes shape (so it goes back to one group
 * first), sometimes a little late (so a try that changed nothing is made again), and the page's group
 * can come out on either side (so the sizes follow the side the measurement shows it on).
 */
async function sizeEditor(name: string, target: number, editor: number): Promise<LayoutReport> {
  let fraction = Math.min(0.99, target / editor);
  let pageFirst = true;
  let report = await settled(name);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Each change is waited for until the page shows it, so a late resize is not measured as the old one.
    await oneGroup();
    await widthWhen(name, (width) => width >= editor - 10);
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: pageFirst ? [{ size: fraction }, { size: 1 - fraction }] : [{ size: 1 - fraction }, { size: fraction }] });
    report = await widthWhen(name, (width) => width < editor - 10);
    if (Math.abs(report.width - target) <= 4 || (fraction >= 0.99 && report.width < editor - 10 && report.width > editor / 2)) return report;
    // As wide as the whole area: the split did not take yet, so the same split is asked for again.
    if (report.width >= editor - 10) continue;
    // Closer to the other group's share: the page came out on the other side.
    if (Math.abs(report.width - (1 - fraction) * editor) < Math.abs(report.width - fraction * editor)) { pageFirst = !pageFirst; continue; }
    fraction = Math.min(0.99, Math.max(0.02, fraction * target / report.width));
  }
  return report;
}

/**
 * One 60px step of the secondary sidebar (where the chat lives). VS Code's "view size" commands act
 * on whichever part has focus, and a webview's focus does not count, so they were unreliable here.
 * The editor-width commands name the editor area itself: with the primary sidebar and panel closed,
 * the only thing beside the editor area is the secondary sidebar, so it takes or gives the 60px.
 * (Mixing in the "view size" commands as a fallback made late steps land twice.)
 */
async function sidebarStep(grow: boolean, before: number): Promise<LayoutReport> {
  await vscode.commands.executeCommand(grow ? 'workbench.action.decreaseViewWidth' : 'workbench.action.increaseViewWidth');
  return changed(before);
}

/** Waits (up to 6 seconds) for the chat's width to move from `before`, then for it to settle, so a slow resize is never taken for a step that did nothing. */
async function changed(before: number): Promise<LayoutReport> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline && (await probe('chat')).width === before) await pause(200);
  return settled('chat');
}

/** Only the editor area and the chat's sidebar on screen, the chat showing. */
async function chatBesideEditor(): Promise<void> {
  for (const command of ['workbench.action.closeSidebar', 'workbench.action.closePanel', 'nearAiChatView.focus']) await vscode.commands.executeCommand(command);
  await pause(500);
}

/**
 * Steps the chat toward the target, 60px at a time, up to 12 steps. Before accepting a width it
 * measures again after a pause, so a late resize is seen; only three steps in a row that change
 * nothing mean the sidebar is at its limit.
 */
let sidebarTrace: string[] = [];

async function sizeSidebar(target: number): Promise<LayoutReport> {
  await chatBesideEditor();
  let report = await settled('chat');
  sidebarTrace = [`start ${report.width}`];
  let stuck = 0;
  for (let step = 0; step < 16 && stuck < 4; step += 1) {
    if (Math.abs(report.width - target) <= 30) {
      await pause(1_000);
      const again = await settled('chat');
      if (again.width === report.width) return again;
      sidebarTrace.push(`moved to ${again.width} while waiting`);
      report = again;
      continue;
    }
    const before = report.width;
    report = await sidebarStep(report.width < target, before);
    sidebarTrace.push(`${report.width < before ? 'narrower' : report.width > before ? 'wider' : 'no change'} ${report.width}`);
    if (report.width !== before) { stuck = 0; continue; }
    // Nothing moved: set the layout up again (focus may have gone elsewhere) before trying again.
    stuck += 1;
    await chatBesideEditor();
    await pause(1_000);
    report = await settled('chat');
  }
  return report;
}

const LONG_MODEL = 'deepseek/deepseek-v4.1-flash-with-a-rather-long-name';

/** Sample data with long names and every column filled, built on what the page's host last sent it. */
function sampleData(name: string, seen: Message[]): Message[] {
  const last = (type: string) => [...seen].reverse().find((message) => message.type === type);
  if (name === 'activity') {
    const overview = last('overview');
    if (!overview) return [];
    const now = Date.now();
    const running = [{ agentId: 'main-run-e2e', runId: 'run-e2e', label: 'Main agent working on a long task name', model: LONG_MODEL, boundary: 'cloud', phase: 'tool', tool: 'Bash', startedAt: now - 95_000, phaseSince: now - 5_000, turns: 12, toolCalls: 34, costUsd: 0.0123 },
      { agentId: 'sub-e2e', runId: 'run-e2e', label: 'gsd-planner', sub: true, model: LONG_MODEL, boundary: 'tee', phase: 'waiting-you', startedAt: now - 40_000, phaseSince: now - 20_000, turns: 3, toolCalls: 4, costUsd: 0.002 }];
    const summary = overview.summary as Record<string, unknown>;
    const models = [{ model: LONG_MODEL, agents: 3, turns: 40, rateLimited: 2, retries: 5, errors: 1, stopped: 1, inputTokens: 1_234_567, outputTokens: 345_678 }];
    return [{ ...overview, running, summary: summary.empty ? summary : { ...summary, models } }];
  }
  if (name === 'compare') {
    const state = last('state')?.state as Record<string, unknown> | undefined;
    if (!state) return [];
    const entry = (rank: number, model: string) => ({ rank, model, privacy: 'forwarded', privacyText: 'Forwarded', forwardedTo: 'another provider', holds: ['Planner (gsd-planner)'], inCatalog: true, stale: [], missingTasks: [], score: 8.1, runs: 8, tasks: ['a', 'b'],
      byKind: { coding: { score: 8.4, tasks: 2, runs: 2 }, research: { score: 7.9, tasks: 2, runs: 2 }, planning: { score: 8, tasks: 2, runs: 2 }, execution: { score: 8.2, tasks: 2, runs: 2 } },
      passRate: 0.9, passes: 7, medianSeconds: 41, tokPerSec: 55, costPerRunUsd: 0.0123, costUsd: 0.1, failures: 1, stalls: 2, lastTested: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const history = [{ id: 'run-e2e', startedAt: new Date().toISOString(), models: [LONG_MODEL, 'zai-org/GLM-5.3-FP8'], taskSet: 'full', mode: 'reuse', ran: 8, reused: 4, costUsd: 0.12, status: 'cancelled', stopReason: 'Cancelled' }];
    return [{ type: 'state', state: { ...state, leaderboard: [entry(1, LONG_MODEL), entry(2, 'zai-org/GLM-5.3-FP8')], history } }];
  }
  if (name === 'mcp') {
    const server = { config: { id: 'catalog', name: 'Product catalog server with a long descriptive name', transport: 'stdio', approval: 'ask-for-changes', command: 'npx', args: ['-y', '@example/a-very-long-package-name-for-an-mcp-server', '--root=/home/someone/projects/deeply/nested/folder/structure'], disabledTools: [] },
      state: 'error', serverInfo: 'example-server 1.2.3', error: 'Could not start: /home/someone/projects/deeply/nested/folder/structure/node_modules/.bin/a-very-long-package-name-for-an-mcp-server exited with code 1',
      enabledHere: true, calls: 12, errors: 2, averageMs: 340, lastUsed: Date.now(), hasSecrets: { url: false, headers: [], env: [] },
      tools: [{ name: 'search_products_by_a_long_identifier_name', description: 'Searches the catalog.', readOnly: true }, { name: 'delete_product', description: 'Deletes a product.', destructive: true }] };
    return [{ type: 'state', servers: [server], project: 'a-project-folder-with-a-long-name', saved: false }];
  }
  return [];
}

const WIDE_REPLY = [
  'A wide reply:', '',
  '| Model | Overall | Coding | Research | Planning | Execution | Passed | Median time | Tokens/s | Cost |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  '| deepseek/deepseek-v4.1-flash-with-a-long-name | 8.1 | 8.4 | 7.9 | 8.0 | 8.2 | 90% | 41 s | 55 | $0.0123 |', '',
  '```ts', `const veryLongLine = '${'x'.repeat(200)}';`, '```', '',
  `See /home/someone/projects/${'deeply-nested-folder/'.repeat(8)}file.ts and https://example.com/${'segment/'.repeat(12)}page`
].join('\n');

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
          : String(lastUser?.content).includes('wide reply') ? { content: WIDE_REPLY }
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
