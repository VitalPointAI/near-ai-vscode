import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';
import type { LayoutReport } from '../../services/layoutProbe';
import type { VerifyReport } from '../../team/eventLog';
import { makeCanaries, scanFiles, scanFilesForDigests, scanGitObjects, scanGitObjectsForDigests } from '../helpers/teamCanary';
import type { LabelledDigest } from '../helpers/teamCanary';

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
    ['a fresh profile signs its first policy file at activation and it verifies (Phase 70, D-14, D-48)', async () => {
      const policy = await api.gate.state();
      assert.equal(policy.state, 'valid', `the first policy file is signed and verifies (${policy.state === 'failed-closed' ? policy.reason : ''})`);
    }],
    ['the sidebar webview loads its script under the CSP and asks the host for models', async () => {
      api.sidebar.tap = { toView: (message) => observer.record(observer.toView, message), fromView: (message) => observer.record(observer.fromView, message) };
      await vscode.commands.executeCommand('nearAiChatView.focus');
      await observer.next('fromView', (message) => message.type === 'load-models');
    }],
    ['a project with no online home opens with "No online home · Set up" on the sync control, without a click (G-27-4b)', async () => {
      // The temporary project has no git repository, so the local check of its remotes finds no home. The page is told as soon as the panel is open.
      const status = await observer.next('toView', (message) => message.type === 'sync-status' && (message.model as { state?: string } | undefined)?.state === 'no-home');
      const model = status.model as { label: string; action: string };
      assert.equal(model.label, 'No online home · Set up');
      assert.equal(model.action, 'set-up-home');
      assert.equal(existsSync(path.join(workspace, '.git')), false, 'the check wrote no repository into the folder');
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
    ['a working profile without a project team shows the "no team yet" card, and Not now hides it', async () => {
      const before = observer.toView.length;
      const asked = observer.fromView.length;
      await api.sidebar.refresh();
      // Wait for the refresh's round trip (view → host → view) before going on.
      await observer.next('fromView', (message) => message.type === 'refresh-status', asked);
      await observer.next('toView', (message) => message.type === 'setup-nudge' && message.show === true, before);
      const dismissed = observer.toView.length;
      // Sent through the view, as the card's button would.
      await api.sidebar.request({ type: 'setup-nudge', action: 'later' });
      await observer.next('fromView', (message) => message.type === 'setup-nudge' && message.action === 'later', asked);
      await observer.next('toView', (message) => message.type === 'setup-nudge' && message.show === false, dismissed);
      // Nothing older brings it back, and a new refresh keeps it hidden.
      const again = observer.toView.length;
      const refreshAt = observer.fromView.length;
      await api.sidebar.request({ type: 'refresh-status' });
      await observer.next('fromView', (message) => message.type === 'refresh-status', refreshAt);
      await observer.next('toView', (message) => message.type === 'setup-nudge', again);
      const shown = observer.toView.slice(dismissed).filter((message) => message.type === 'setup-nudge');
      assert.equal(shown.at(-1)?.show, false, JSON.stringify(shown));
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
      const checkOverflow = (name: string, report: LayoutReport, state = '') => {
        const key = `${name}@${report.width}${state}`;
        if (checked.has(key)) return;
        checked.add(key);
        const where = `${name} at ${report.width}px${state ? ` (${state})` : ''}`;
        if (report.scrollWidth > report.clientWidth + 1 || report.bodyScrollWidth > report.bodyClientWidth + 1) problems.push(`${where} scrolls sideways: page ${report.scrollWidth} in ${report.clientWidth}, body ${report.bodyScrollWidth} in ${report.bodyClientWidth}`);
        for (const offender of report.offenders) problems.push(`${where}: ${offender}`);
        for (const scroller of report.scrollers) problems.push(`${where}: ${scroller}`);
        // A control the person must read whole (the profile name, the sync state) whose text is cut short (G-27-4a).
        for (const cut of report.clipped) problems.push(`${where}: clipped ${cut}`);
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
      for (const target of SIDEBAR_WIDTHS) {
        await measure('chat', target, () => sizeSidebar(target), chatBesideEditor, () => `steps: ${sidebarTrace.join(', ')}`);
        // The same width in each of the five sync states, with a realistic profile name: nothing a person must read may be cut short.
        for (const [state, report] of await chatInEverySyncState()) checkOverflow('chat', report, state);
      }
      // The chat shows the real profile and sync status again for the tests after this one.
      await api.sidebar.refresh();
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
    ['the Staff Room\'s J5, J3 and J4 workspaces fit a narrow and a normal width without scrolling sideways (owner direction 2026-11-19)', async () => {
      // Each section workspace opened through the open command's argument (the real host path), with a full sample room, measured by the layout probe.
      const problems: string[] = [];
      try {
        await vscode.commands.executeCommand('nearAi.openStaffRoom');
        await waitForProbe('staff-room');
        samples.set('staff-room', sampleData('staff-room', []));
        await editorAreaOnly();
        const { room, editor } = await editorRoom('staff-room');
        const widths = [320, room >= 800 ? 800 : Math.max(470, Math.min(600, room))];
        for (const workspace of ['j5', 'j3', 'j4']) {
          await vscode.commands.executeCommand('nearAi.openStaffRoom', workspace);
          for (const target of widths) {
            const report = await sizeEditor('staff-room', target, editor);
            const where = `staff-room ${workspace} at ${report.width}px`;
            console.log(`  ${where} (asked ${target}px): page ${report.scrollWidth}/${report.clientWidth}, body ${report.bodyScrollWidth}/${report.bodyClientWidth}`);
            if (report.scrollWidth > report.clientWidth + 1 || report.bodyScrollWidth > report.bodyClientWidth + 1) problems.push(`${where} scrolls sideways: page ${report.scrollWidth} in ${report.clientWidth}`);
            for (const offender of report.offenders) problems.push(`${where}: ${offender}`);
            for (const scroller of report.scrollers) problems.push(`${where}: ${scroller}`);
            for (const cut of report.clipped) problems.push(`${where}: clipped ${cut}`);
            if (Math.abs(report.width - target) > 40) problems.push(`${where}: could not size the panel to ${target}px`);
          }
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
        await vscode.commands.executeCommand('workbench.view.explorer');
      }
      assert.deepEqual(problems, []);
    }],
    ['an image waiting for review shows its card in the narrow chat without overflow, and its answer goes back through the view (0.4.23)', async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { postToPage } = require(path.join(extension.extensionPath, 'dist/services/layoutProbe')) as typeof import('../../services/layoutProbe');
      await vscode.commands.executeCommand('nearAiChatView.focus');
      const id = 'img-0e2e0e2e0e2e';
      // A wide image, a long path and model, and a sub-agent's label: the card must still fit the sidebar as the host sends it. The width is one
      // constant shared by the fixture and the check below (0.4.25), so changing the fixture cannot leave the check pinned to an old number.
      const IMAGE_WIDTH = 1200;
      await postToPage('chat', { type: 'image-review-request', id, path: `report/img/${'a-rather-long-folder-name/'.repeat(3)}hero-image-for-the-report.png`, model: LONG_MODEL, prompt: 'A lighthouse at dusk. '.repeat(20), attempt: 3, sizeKb: 1, image: `data:image/png;base64,${solidPng(IMAGE_WIDTH, 40).toString('base64')}`, agent: 'gsd-designer' });
      await pause(500);
      const report = await probe('chat');
      console.log(`  image review card at ${report.width}px: page ${report.scrollWidth}/${report.clientWidth}, body ${report.bodyScrollWidth}/${report.bodyClientWidth}`);
      assert.ok(report.scrollWidth <= report.clientWidth + 1 && report.bodyScrollWidth <= report.bodyClientWidth + 1, `the chat scrolls sideways with the card: ${JSON.stringify(report)}`);
      assert.deepEqual(report.offenders, [], 'nothing in the card reaches past the edge');
      // The data: image must actually render (second review of PR 51), not just fit: a broken image fits too. Decoding is asynchronous, so it is
      // read again for a few seconds before failing.
      const preview = async () => (await probe('chat')).images?.find((image) => image.element.includes('image-review-preview'));
      let shown = await preview();
      for (let attempt = 0; attempt < 20 && !(shown && shown.naturalWidth > 0); attempt += 1) { await pause(250); shown = await preview(); }
      assert.ok(shown, 'the card shows the image');
      assert.equal(shown.naturalWidth, IMAGE_WIDTH, `the data: image renders at its own width: ${JSON.stringify(shown)}`);
      // Sent through the view, as the card's Request changes button would. The host has no such draft waiting, so nothing else happens.
      const asked = observer.fromView.length;
      await api.sidebar.request({ type: 'image-review-reply', id, decision: 'changes', feedback: 'Warmer light, please.' });
      const reply = await observer.next('fromView', (message) => message.type === 'image-review-reply' && message.id === id, asked);
      assert.equal(reply.feedback, 'Warmer light, please.');
      await postToPage('chat', { type: 'prompt-closed', id, outcome: 'cancelled' });
    }],
    ['the trust badge renders under a cloud answer in the real chat page, not under a local one, and comes back after the view reloads (CLAS-08)', async () => {
      // The local profile's answers so far carry no badge.
      assert.deepEqual((await probe('chat')).trustBadges ?? [], [], 'no badge under a local answer');
      const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { ProfileStore } = require(path.join(extension.extensionPath, 'dist/services/profileStore')) as typeof import('../../services/profileStore');
      const { clearProviderCache } = require(path.join(extension.extensionPath, 'dist/services/providerCache')) as typeof import('../../services/providerCache');
      const profiles = new ProfileStore(workspace, api.auth);
      // A cloud-kind profile on the fake server: its answers come through a NEAR client, which is not NEAR AI Cloud's own endpoint, so the badge is Not verified.
      const cloud = await profiles.configure({ profileId: 'profile-e2e-cloud', displayName: 'E2E (cloud)', organization: 'E2E', baseUrl: url, authMode: 'apiKey', provider: 'near-ai' }, 'e2e-key');
      try {
        assert.equal(cloud.validation.status, 'valid', cloud.validation.error);
        clearProviderCache();
        const before = observer.toView.length;
        await api.sidebar.refresh();
        await observer.next('toView', (message) => message.type === 'models' && JSON.stringify(message.models).includes('fake-coder'), before);
        const sent = observer.toView.length;
        await api.sidebar.request({ type: 'send', text: 'Say hi', model: 'fake-coder' });
        const done = await observer.next('toView', (message) => message.type === 'assistant-done', sent);
        const badge = await observer.next('toView', (message) => message.type === 'trust-badge' && message.runId === done.runId, sent);
        assert.equal((badge.badge as { state: string }).state, 'not-verified');
        const shown = await settled('chat');
        assert.deepEqual(shown.trustBadges, [{ state: 'not-verified', title: 'Not verified' }], 'one badge, reading Not verified');
        assert.deepEqual(shown.clipped, [], 'nothing clipped');
        assert.deepEqual(shown.offenders, [], 'nothing past the panel\'s edge');
        // Show full attestation opens a read-only JSON tab on its own scheme, titled by the answer's time and model: no unsaved state, and an edit is refused.
        await api.sidebar.request({ type: 'trust-details', runId: String(done.runId) });
        let editor = vscode.window.activeTextEditor;
        for (let attempt = 0; attempt < 40 && editor?.document.uri.scheme !== 'near-ai-attestation'; attempt += 1) { await pause(250); editor = vscode.window.activeTextEditor; }
        assert.equal(editor?.document.uri.scheme, 'near-ai-attestation', 'the attestation opened in its own read-only scheme');
        const attestation = editor!.document;
        assert.equal(attestation.languageId, 'json');
        assert.equal((JSON.parse(attestation.getText()) as { answer: { runId: string } }).answer.runId, done.runId);
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        assert.match(tab?.label ?? '', /^Attestation: answer at \d\d:\d\d, fake-coder$/, 'the tab is titled by the answer\'s time and model');
        assert.equal(tab?.isPreview, true, 'a preview tab');
        // Typing into the focused tab, as a person would, changes nothing: the editor is read-only, so there is nothing to save.
        const text = attestation.getText();
        await vscode.window.showTextDocument(attestation, { preview: true, preserveFocus: false });
        await vscode.commands.executeCommand('type', { text: 'x' });
        await pause(250);
        assert.equal(attestation.getText(), text, 'typing does not change the document');
        assert.equal(attestation.isDirty, false, 'nothing to save');
        assert.equal(attestation.isUntitled, false);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.commands.executeCommand('nearAiChatView.focus');
        // The view reloads; the host replays the conversation when the page says it is ready, and the badge is drawn again.
        const ready = observer.fromView.length;
        await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        await vscode.commands.executeCommand('nearAiChatView.focus');
        await observer.next('fromView', (message) => message.type === 'chat-ready', ready, 30_000);
        let again = await probe('chat');
        for (let attempt = 0; attempt < 20 && (again.trustBadges ?? []).length === 0; attempt += 1) { await pause(250); again = await probe('chat'); }
        assert.deepEqual(again.trustBadges, [{ state: 'not-verified', title: 'Not verified' }], 'the badge is shown again after the reload');
      } finally {
        // Every later test runs on the local profile, as before.
        await profiles.select('profile-e2e-local');
        clearProviderCache();
        await api.sidebar.refresh();
      }
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
    ['the Staff Room shows the real COP map for a loaded scenario, with no content security policy violation (real-window check)', async () => {
      // The starter scenario in this project, as Load Staff Exercise Scenario writes it, so the room has a frame to draw the COP map over.
      const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      await mkdir(path.join(workspace, '.planning', 'staff', 'scenario'), { recursive: true });
      await writeFile(path.join(workspace, '.planning', 'staff', 'scenario', 'scenario.json'), await readFile(path.join(extension.extensionPath, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
      await vscode.commands.executeCommand('nearAi.openStaffRoom');
      await waitForProbe('staff-room');
      let report = await probe('staff-room');
      for (let waited = 0; waited < 20_000 && !(report.map?.maplibre || report.map?.note); waited += 500) { await pause(500); report = await probe('staff-room'); }
      // Read by the person running the check: which renderer drew, and why when it fell back.
      console.log(`[real-window] Staff Room map: ${report.map?.maplibre ? 'MapLibre canvas drawn' : `SVG fallback (${report.map?.note || 'no reason shown'})`}; CSP violations: ${(report.cspViolations ?? []).length}`);
      assert.deepEqual(report.cspViolations ?? [], [], 'no content security policy violation in the Staff Room');
      assert.ok(report.map?.maplibre || /2D map/.test(report.map?.note ?? ''), `the room drew the COP map, or said why it fell back (${JSON.stringify(report.map)})`);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }],
    ['the Staff Room\'s map is the main panel once a scenario is loaded: in view without scrolling, most of the panel\'s height, with a working layer drawer and full map, at a normal and a narrow width (D-48 of 0.4.34)', async () => {
      // The scenario the test above wrote is still in the project. The real host sends the room, so no sample model is posted over it.
      samples.delete('staff-room');
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { postToPage } = require(path.join(extension.extensionPath, 'dist/services/layoutProbe')) as typeof import('../../services/layoutProbe');
      const problems: string[] = [];
      try {
        await vscode.commands.executeCommand('nearAi.openStaffRoom', 'war-room');
        await waitForProbe('staff-room');
        await editorAreaOnly();
        const { room, editor } = await editorRoom('staff-room');
        for (const target of [editor, room >= 800 ? 420 : Math.max(380, Math.min(420, room))]) {
          let report = target === editor ? await settled('staff-room') : await sizeEditor('staff-room', target, editor);
          for (let waited = 0; waited < 20_000 && !(report.map?.box && (report.map.maplibre || report.map.note)); waited += 500) { await pause(500); report = await probe('staff-room'); }
          await pause(800);
          report = await probe('staff-room');
          const where = `staff-room war room at ${report.width}px (${report.map?.maplibre ? 'MapLibre' : 'SVG map'})`;
          const box = report.map?.box;
          console.log(`  ${where}: map ${box ? `${box.top}-${box.bottom} (${box.height}px) of ${box.viewport}px, scrolled ${box.scrollY}` : 'not found'}; page ${report.scrollWidth}/${report.clientWidth}`);
          if (!box) { problems.push(`${where}: no map box`); continue; }
          if (box.scrollY !== 0 || box.top < 0 || box.bottom > box.viewport + 1) problems.push(`${where}: the map is not in view without scrolling (${JSON.stringify(box)})`);
          // At the normal width the map is most of the panel; at the narrow width the header and tabs wrap, so it must only be in view.
          if (target === editor && box.height < 0.55 * box.viewport) problems.push(`${where}: the map covers ${Math.round((100 * box.height) / box.viewport)}% of the panel's height, under 55%`);
          if (report.scrollWidth > report.clientWidth + 1 || report.bodyScrollWidth > report.bodyClientWidth + 1) problems.push(`${where}: scrolls sideways (${report.scrollWidth} in ${report.clientWidth})`);
          for (const offender of report.offenders) problems.push(`${where}: ${offender}`);
          // The layer drawer opens with focus inside, and Escape closes it with focus back on its button.
          await postToPage('staff-room', { type: 'layout-act', act: 'open-layers' });
          await pause(700);
          const opened = await probe('staff-room');
          if (!opened.map?.drawer?.open || !opened.map.drawer.focusInside || !opened.map.drawer.switches) problems.push(`${where}: the layer drawer did not open with focus inside (${JSON.stringify(opened.map?.drawer)})`);
          if (opened.scrollWidth > opened.clientWidth + 1) problems.push(`${where}: the open drawer scrolls the page sideways`);
          await postToPage('staff-room', { type: 'layout-act', act: 'escape' });
          await pause(700);
          const closed = await probe('staff-room');
          if (closed.map?.drawer?.open || !closed.map?.drawer?.buttonFocused) problems.push(`${where}: Escape did not close the drawer back to its button (${JSON.stringify(closed.map?.drawer)})`);
          // Full map covers the whole panel, and Escape brings the room back.
          await postToPage('staff-room', { type: 'layout-act', act: 'full-map' });
          await pause(700);
          const full = await probe('staff-room');
          if (!full.map?.full || !full.map.box || full.map.box.top > 1 || full.map.box.height < full.map.box.viewport - 2) problems.push(`${where}: Full map does not fill the panel (${JSON.stringify(full.map?.box)})`);
          await postToPage('staff-room', { type: 'layout-act', act: 'escape' });
          await pause(700);
          if ((await probe('staff-room')).map?.full) problems.push(`${where}: Escape did not leave the full map`);
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
        await vscode.commands.executeCommand('workbench.view.explorer');
      }
      assert.deepEqual(problems, []);
    }],
    ...teamProjectTests(() => api)
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
    // Phase 70 (D-14) changed this test on purpose. It used to say that no device key is stored here. The gate now creates the device identity at
    // activation, in every folder, because it signs its first policy file with it (a fresh install needs no network and no setup), so Team Mode
    // alone is no longer the only thing that makes one. What still holds: no team session and nothing written into the folder. What is new: the
    // gate signed its first policy file and it verifies.
    ['a folder without team.json starts no team session; the gate signs its own first policy there and writes nothing into the folder (D-14, D-30, Phase 70 D-14)', async () => {
      const api = vscode.extensions.getExtension<NearAiTestApi>(EXTENSION_ID)!.exports;
      assert.ok(api, 'the extension is active, so the test API is there');
      assert.equal(await api.team.ready, 'solo');
      assert.equal(api.team.session(), undefined, 'no team session');
      const policy = await api.gate.state();
      assert.equal(policy.state, 'valid', `the first policy file is signed and verifies (${policy.state === 'failed-closed' ? policy.reason : ''})`);
      assert.ok(await api.team.deviceKeyEvidence() !== undefined, 'the gate created the device identity it signs with');
      assert.deepEqual(await readdir(workspace), [], 'the folder is still empty');
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

// ---- Team Mode in a real window (D-30): Enable Team Mode from the Command Palette behind the preview, then Verify Team Log ----

const PREVIEW_OFF_SIGNAL = 'Enable Team Mode ran from the Command Palette with nearAi.team.preview off';
const A3_SIGNAL = 'Enable Team Mode did not start from the Command Palette with nearAi.team.preview on (A3)';
const NO_TEAM_JSON_SIGNAL = 'Enable Team Mode did not write .planning/.near-ai/team.json within 60 s';
const TEAM_FILE_PATH = path.join('.planning', '.near-ai', 'team.json');

/**
 * Puts keyboard focus somewhere the Command Palette can keep it. The palette closes when it loses focus, and a test before the Team Mode tests leaves a
 * chat run finishing in a webview and notifications on screen, which could take focus a moment after the palette opened; every accept after that went to
 * a closed palette, so the control step failed before any product code ran (0.4.26). Closing the palette and notifications, focusing the editor group and
 * letting it settle removes that window.
 */
async function settleFocus(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await pause(500);
}

/**
 * Runs a command the way a person does: opens the Command Palette on the label and accepts the selected item every 400 ms until `done()` holds
 * or the time is up. Input boxes the command opens take the same accept, so they keep the value they were opened with. The first accept
 * waits 400 ms so the list has filtered. No text is typed. Focus is settled first (settleFocus).
 *
 * `attempts` above 1 opens the palette again (focus settled each time) when an attempt ends without `done()`: only for a command that is safe to run
 * twice and changes nothing when it does not run, which is the control step alone. Every Enable Team Mode run, with the preview off or on, gets one
 * attempt, so a second Enable can never start (PR #67 review). Returns the attempts used.
 */
async function runFromPalette(label: string, done: () => boolean, timeoutMs: number, attempts = 1): Promise<number> {
  let used = 0;
  while (used < attempts && !done()) {
    used += 1;
    await settleFocus();
    await vscode.commands.executeCommand('workbench.action.quickOpen', `>${label}`);
    const deadline = Date.now() + timeoutMs;
    while (!done() && Date.now() < deadline) {
      await pause(400);
      if (done()) break;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
  return used;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await pause(stepMs);
  }
  return condition();
}

// The NEAR AI Team output channel is written to a log file under the window's user data; a failure in it explains a missing team.json.
async function teamLogTail(): Promise<string> {
  const userData = process.env.NEAR_AI_E2E_USER_DATA;
  if (userData === undefined) return '';
  const found: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.name.includes('NEAR AI Team')) found.push(child);
    }
  };
  await walk(path.join(userData, 'logs'), 0);
  const texts = await Promise.all(found.map((file) => readFile(file, 'utf8').catch(() => '')));
  return texts.join('\n').split('\n').slice(-12).join('\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function teamProjectTests(getApi: () => NearAiTestApi): Array<[string, () => Promise<void>]> {
  let remote = '';
  const teamFilePath = path.join(workspace, TEAM_FILE_PATH);
  const preview = () => vscode.workspace.getConfiguration('nearAi').inspect<boolean>('team.preview')?.globalValue;
  const userSettingsPath = path.join(process.env.NEAR_AI_E2E_USER_DATA!, 'User', 'settings.json');
  const commitSubject = () => { try { return git(workspace, ['log', '-1', '--format=%s']); } catch { return ''; } };
  return [
    ['Enable Team Mode is in the Command Palette only with the preview on (D-13, D-24, A3)', async () => {
      // A scratch repository with one commit and an origin that is a local bare repository: git runs only in these two temporary folders, under the
      // isolated git config run.ts gave this window.
      assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1', 'git reads no system config');
      assert.equal(path.basename(process.env.GIT_CONFIG_GLOBAL ?? ''), 'e2e.gitconfig', 'git reads only the e2e config file');
      remote = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-remote-'));
      git(workspace, ['init', '-b', 'main']);
      await writeFile(path.join(workspace, 'README.md'), 'A scratch project for the Team Mode e2e.\n');
      git(workspace, ['add', 'README.md']);
      git(workspace, ['commit', '-m', 'first commit']);
      git(remote, ['init', '--bare']);
      git(workspace, ['remote', 'add', 'origin', remote]);
      assert.equal(git(workspace, ['log', '-1', '--format=%an']), 'E2E Owner');

      // Control: a built-in command with a visible effect works through the palette, so a failure below is the product's and not the harness's.
      const tabs = () => vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0);
      const tabsBefore = tabs();
      // Up to three attempts, each with focus settled: opening an untitled file is safe to repeat, and the step only has to show the palette CAN run a
      // command. A build whose palette cannot be driven at all still fails here, after the third attempt.
      const controlAttempts = await runFromPalette('File: New Untitled Text File', () => tabs() > tabsBefore, 8_000, 3);
      assert.ok(tabs() > tabsBefore, `the Command Palette did not run File: New Untitled Text File in ${controlAttempts} attempts, so the harness cannot drive the palette in this VS Code build`);
      if (controlAttempts > 1) console.log(`  palette control step needed ${controlAttempts} attempts`);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      // Preview off (the default): Enable is not offered, so accepting for 5 s starts nothing.
      assert.equal(vscode.workspace.getConfiguration('nearAi').get('team.preview'), false);
      await runFromPalette('NEAR AI: Enable Team Mode', () => existsSync(teamFilePath), 5_000, 1);
      await pause(1_000);
      assert.equal(existsSync(teamFilePath), false, PREVIEW_OFF_SIGNAL);
      await vscode.commands.executeCommand('notifications.clearAll');

      // Preview on, at the user (Global) target, as a person would set it.
      await vscode.workspace.getConfiguration('nearAi').update('team.preview', true, vscode.ConfigurationTarget.Global);
      assert.ok(await waitUntil(() => preview() === true, 10_000), 'nearAi.team.preview is true at the user target');
      await pause(1_000);
    }],
    ['Enable Team Mode answers its prompts with their defaults and commits only team.json (D-30)', async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
      const { ENABLE_COMMIT_MESSAGE } = require(path.join(extension.extensionPath, 'dist/team/enable')) as typeof import('../../team/enable');
      const { DEFAULT_COORDINATION_REF } = require(path.join(extension.extensionPath, 'dist/team/gitTransport')) as typeof import('../../team/gitTransport');
      const enabled = () => existsSync(teamFilePath) && commitSubject() === ENABLE_COMMIT_MESSAGE && getApi().team.session() !== undefined;
      await runFromPalette('NEAR AI: Enable Team Mode', enabled, 60_000);
      if (!enabled()) {
        // The commit and the session follow team.json by a moment, so wait for them before judging.
        await waitUntil(enabled, 10_000);
      }
      const tail = await teamLogTail();
      assert.ok(existsSync(teamFilePath), `${existsSync(path.join(workspace, '.git')) ? NO_TEAM_JSON_SIGNAL : 'the scratch repository is missing'}. If no prompt ever opened this is also ${A3_SIGNAL}. NEAR AI Team log:\n${tail}`);
      assert.equal(commitSubject(), ENABLE_COMMIT_MESSAGE, `the Enable commit was not made. NEAR AI Team log:\n${tail}`);
      assert.deepEqual(git(workspace, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'), [TEAM_FILE_PATH.split(path.sep).join('/')], 'HEAD holds only team.json');
      const teamFile = JSON.parse(await readFile(teamFilePath, 'utf8')) as { coordination: { ref: string }; genesis: { ownerDevice: { fingerprint: string } } };
      assert.equal(teamFile.coordination.ref, DEFAULT_COORDINATION_REF);
      assert.notEqual(git(remote, ['for-each-ref', DEFAULT_COORDINATION_REF]), '', 'the coordination branch is on the bare remote');
      assert.ok(getApi().team.session() !== undefined, 'a team session is running');
      await vscode.commands.executeCommand('notifications.clearAll');
    }],
    ['Verify Team Log reports the owner and no rejected events (D-30, D-31)', async () => {
      const report = await vscode.commands.executeCommand<VerifyReport | undefined>('nearAi.team.verifyLog');
      assert.ok(report !== undefined, 'Verify Team Log returned no report');
      assert.deepEqual(report.rejected, [], `rejected events: ${JSON.stringify(report.rejected)}`);
      assert.equal(report.refused, undefined);
      assert.equal(report.unsupported, 0);
      assert.ok(report.events >= 1 && report.events === report.accepted, `events ${report.events}, accepted ${report.accepted}`);
      assert.equal(report.members.length, 1);
      assert.equal(report.members[0]?.role, 'owner');
      assert.equal(report.members[0]?.devices.filter((device) => device.state === 'active').length, 1);
      assert.equal(report.status.state, 'ok');
      await vscode.commands.executeCommand('notifications.clearAll');
    }],
    ['no rendering of the new device key or the owner email reaches settings, team.json or the remote (TMR-03)', async () => {
      const evidence = await getApi().team.deviceKeyEvidence();
      assert.ok(evidence !== undefined, 'Enable stored a device key');
      const teamFile = JSON.parse(await readFile(teamFilePath, 'utf8')) as { teamId: string; genesis: { ownerDevice: { fingerprint: string; publicKey: string } } };
      assert.equal(evidence.fingerprint, teamFile.genesis.ownerDevice.fingerprint);
      assert.equal(evidence.publicKey.base64url, teamFile.genesis.ownerDevice.publicKey);
      assert.equal(Buffer.from(evidence.publicKey.base64url, 'base64url').toString('hex'), evidence.publicKey.hex);
      assert.equal(Buffer.from(evidence.publicKey.base64url, 'base64url').toString('base64'), evidence.publicKey.base64);
      assert.match(evidence.privateKeySha256, /^[0-9a-f]{64}$/, 'the evidence carries the digest of the stored text, never the text');
      // PKCS#8 DER as base64, base64url and hex; the seed as hex, base64url and padded and unpadded base64; SPKI DER as hex (repeats dropped).
      assert.ok(evidence.privateFormDigests.length >= 6 && evidence.privateFormDigests.length <= 8, `renderings: ${evidence.privateFormDigests.length}`);
      assert.ok(evidence.privateFormDigests.some((digest) => digest.length === 96), 'the PKCS#8 DER hex rendering is covered');
      assert.ok(evidence.privateFormDigests.some((digest) => digest.length === 88), 'the SPKI DER hex rendering is covered');
      assert.ok(evidence.privateFormDigests.some((digest) => digest.length === 44), 'the padded seed base64 rendering is covered');

      const digests: LabelledDigest[] = [
        ...evidence.privateFormDigests.map((digest, index) => ({ ...digest, label: `device key form ${index}` }))
      ];
      const workspaceSettings = path.join(workspace, '.vscode', 'settings.json');
      const files = [userSettingsPath, teamFilePath, ...(existsSync(workspaceSettings) ? [workspaceSettings] : [])];
      const ownerEmail = 'e2e-owner@example.com';
      // The address is never asked for or stored, and neither is a hash of it with the public team id (which a guess could test).
      const email = [
        { label: 'owner email', value: ownerEmail },
        { label: 'owner email hash with the team id', value: createHash('sha256').update(`${teamFile.teamId}:${ownerEmail}`).digest('hex') },
        { label: 'owner email hash', value: createHash('sha256').update(ownerEmail).digest('hex') }
      ];

      // Controls: the same scanners do find a planted look-alike (a made-up value, not the key) in a file and in an object of the remote, so the
      // empty results below mean something. The planted value is hashed here; the real key never enters this window.
      const fake = makeCanaries().apiKey.padEnd(64, 'A').slice(0, 64);
      const fakeDigest: LabelledDigest = { label: 'planted', length: fake.length, sha256: createHash('sha256').update(fake).digest('hex') };
      const controlFile = path.join(path.dirname(userSettingsPath), 'canary-control.txt');
      await writeFile(controlFile, `{"x":"${fake}"}\n`);
      assert.deepEqual((await scanFilesForDigests([controlFile], [fakeDigest])).map((hit) => hit.split(': ')[1]), ['planted'], 'the file scanner finds a planted value');
      execFileSync('git', ['--git-dir', remote, 'hash-object', '-w', '--stdin'], { input: `note ${fake}\n` });
      assert.deepEqual(await scanGitObjectsForDigests(remote, [fakeDigest]), ['planted'], 'the object scanner finds a planted value');
      const gitConfigPath = process.env.GIT_CONFIG_GLOBAL as string;
      assert.deepEqual((await scanFiles([gitConfigPath], email)).map((hit) => hit.split(': ')[1]), ['owner email'], 'the email scanner sees the address where it is by construction');

      assert.deepEqual(await scanFilesForDigests(files, digests), [], 'user settings, workspace settings and team.json');
      assert.deepEqual(await scanGitObjectsForDigests(remote, digests), [], 'bare remote objects');
      assert.deepEqual(await scanFiles(files, email), [], 'the owner email and its guessable hashes are not in settings or team.json');
      assert.deepEqual(await scanGitObjects(remote, email), [], 'the owner email and its guessable hashes are not on the remote');
      await vscode.commands.executeCommand('notifications.clearAll');
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
  ['teams', 'nearAi.manageTeams'], ['tools', 'nearAi.openTools'], ['onboarding', 'nearAi.setup'], ['team-live', 'nearAi.openTeamLive'],
  ['staff-room', 'nearAi.openStaffRoom']
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

/** A profile name of a realistic length (24 characters), as someone's own profile might be called. */
const PROFILE_NAME = 'Research-Team-Profile-01';

/**
 * Shows the chat a profile with a long name and then, one after another, each of the five sync states (built by the host's own
 * syncStatusMessage, so the words are the real ones), measuring the page after each. The longest attention sentence is about 80 characters.
 */
async function chatInEverySyncState(): Promise<Array<[string, LayoutReport]>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { postToPage } = require(path.join(extension.extensionPath, 'dist/services/layoutProbe')) as typeof import('../../services/layoutProbe');
  const { syncStatusMessage } = require(path.join(extension.extensionPath, 'dist/domain/state/syncStatus')) as typeof import('../../domain/state/syncStatus');
  const now = Date.now();
  const statuses: Array<[string, Parameters<typeof syncStatusMessage>[0]]> = [
    ['off', { state: 'off' }],
    ['syncing', { state: 'syncing', reason: 'open' }],
    ['synced', { state: 'synced', at: new Date(2026, 8, 30, 12, 59).toISOString() }],
    ['attention', { state: 'attention', message: 'Could not reach GitHub, so your latest changes will go up on the next try here.' }],
    ['no-home', { state: 'no-home', message: 'This project has no online home yet.' }]
  ];
  await postToPage('chat', { type: 'profile-status', value: { profiles: [{ profileId: 'profile-e2e-name', displayName: PROFILE_NAME, organization: 'E2E', validation: { status: 'valid' } }], activeProfileId: 'profile-e2e-name' } });
  const reports: Array<[string, LayoutReport]> = [];
  for (const [state, status] of statuses) {
    await postToPage('chat', syncStatusMessage(status, { now, dismissed: true }));
    await pause(300);
    reports.push([state, await probe('chat')]);
  }
  return reports;
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
  if (name === 'team-live') return [teamLiveSample()];
  if (name === 'staff-room') return [staffRoomSample()];
  if (name === 'teams') return [teamsDashboardSample()];
  return [];
}

/**
 * 0.4.31: Team Studio's dashboard as its host would send it, with long names, long model ids, every status, reasons, stats and ratings, worked out by
 * the extension's own code from a made-up run history, so every width from 220 to 1000px is measured with a full page.
 */
function teamsDashboardSample(): Message {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { buildDashboard } = require(path.join(extension.extensionPath, 'dist/domain/teamDashboard')) as typeof import('../../domain/teamDashboard');
  const now = Date.now();
  const member = (name: string, privacy: string, extra: Record<string, unknown> = {}) => ({ name, role: 'researcher', tier: 'deep', model: LONG_MODEL, privacy, privacyText: privacy, available: true, ...extra });
  const long = 'Finds every competitor in a market, writes a brief with a citation for each claim, checks the brief against its sources and designs a cover for it, then hands it over.';
  const teams = [
    { id: 'project', kind: 'project', name: 'Market research team with a rather long name for this project', description: long, command: '/team:project ', rating: 4, check: { block: 0, warning: 0, advice: 1 }, members: [member('research-analyst-with-a-long-name', 'tee'), member('brief-writer', 'forwarded', { tier: 'standard' }), member('reviewer', 'local', { tier: 'fast' }), member('designer', 'tee'), member('checker', 'tee')] },
    { id: 'user:imported-team-with-a-long-name', kind: 'user', name: 'Imported team with a long name that wraps onto several lines', description: long, command: '/team:imported-team-with-a-long-name ', imported: true, check: { block: 0, warning: 2, advice: 0 }, members: [member('a-member-whose-model-is-gone', 'unknown', { tier: 'model', model: 'vendor/a-model-that-is-no-longer-offered-with-a-long-id', available: false })] },
    { id: 'user:web', kind: 'user', name: 'Web', description: 'Builds pages', command: '/team:web ', private: true, check: { block: 0, warning: 0, advice: 0 }, members: [member('dev', 'tee')] }
  ];
  const session = (id: string, title: string, ago: number, outcome: 'completed' | 'failed', cost: number) => ({ version: 1, sessionId: `session-${id}-0000`, project: 'p', plans: [], agents: {}, models: [], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: new Date(now - ago).toISOString(), updatedAt: new Date(now).toISOString(), outcome: 'completed', continuationAvailable: false, context: { userTurns: 1, assistantTurns: 1 }, events: [], runId: `run-${id}-000000`, title, runOutcome: outcome, endedAt: new Date(now - ago + 754_000).toISOString(), estimatedCostUsd: cost });
  const dashboard = buildDashboard({
    now, history: true, roleTests: {}, running: [{ runId: 'run-e2e-000000', slug: 'web' }],
    sessions: [session('a', '/team:project go', 3_600_000, 'completed', 12.3456), session('b', '/team:team again', 86_400_000, 'failed', 0.0012)] as never,
    teams: teams.map((team) => ({ id: team.id, kind: team.kind as 'project' | 'user', slug: team.kind === 'project' ? 'team' : team.id.slice(5), file: `/e2e/${team.id}.md`, ...(team.imported ? { imported: true } : {}), check: team.check, members: team.members }))
  });
  return { type: 'library', library: { teams, archived: [{ id: 'archived:an-archived-team-with-a-very-long-name', name: 'An archived team with a very long name' }] }, dashboard };
}

/**
 * The Staff Room as its host would send it, built by the extension's own code: the IRON LANTERN scenario on the map, a run with long member names in
 * every state, and an adversary COA set, so every width from 220 to 1000px is measured with a full room.
 */
function staffRoomSample(): Message {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { buildStaffRoomModel } = require(path.join(extension.extensionPath, 'dist/domain/staff/staffRoom')) as typeof import('../../domain/staff/staffRoom');
  const { parseScenarioText } = require(path.join(extension.extensionPath, 'dist/domain/staff/scenario')) as typeof import('../../domain/staff/scenario');
  const { defaultStaffSettings } = require(path.join(extension.extensionPath, 'dist/domain/staff/profiles')) as typeof import('../../domain/staff/profiles');
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const scenario = parseScenarioText(readFileSync(path.join(extension.extensionPath, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 11, minute)).toISOString();
  const events = [
    { type: 'staff.step.entered', run: 'run-e2e', at: at(0), section: 'j2', step: 3, stepName: 'COA development' },
    { type: 'staff.step.entered', run: 'run-e2e', at: at(0), section: 'j5', step: 3, stepName: 'COA development' },
    { type: 'staff.lane.started', run: 'run-e2e', at: at(1), section: 'j2', member: 'threat-analyst-with-a-rather-long-member-name', product: 'adversary-coa-set' },
    { type: 'staff.lane.started', run: 'run-e2e', at: at(2), section: 'j2', member: 'collection-manager', product: 'collection-plan' },
    { type: 'staff.waiting', run: 'run-e2e', at: at(3), section: 'j5', member: 'lead-planner', waitingOn: 'human', what: 'The commander\'s guidance on the two COA themes before the cells start' },
    { type: 'staff.lane.finished', run: 'run-e2e', at: at(4), section: 'j2', member: 'watch-officer', product: 'intsum', outcome: 'done' }
  ];
  const coaBody = '## Most likely course of action\n\n41 CSTL BDE defends Port Calder from PL COPPER, holding Ashby Ford with 1-41 MECH at KQ 4532. We assess this is likely. We have moderate confidence.\n\n## Most dangerous course of action\n\n3-41 ARMD counter-attacks from KQ 4726 west to Ashby Ford KQ 4528 and on towards AA OAK. This is unlikely. We have low confidence.\n';
  const { checkMovementTable } = require(path.join(extension.extensionPath, 'dist/domain/staff/logistics')) as typeof import('../../domain/staff/logistics');
  // The J5, J3 and J4 workspaces with long words in every place a person reads, so each width is measured with a full section.
  const long = 'a long entry that wraps across several lines at narrow widths without pushing anything past the edge of the panel';
  const move = checkMovementTable({ id: 'move-with-a-long-identifier', title: `Notional reception with ${long}`, serials: [{ serial: 'SERIAL-0001-LONG', what: `Bridging stock, ${long}`, mode: 'road', from: 'port-alpha-with-a-long-name', to: 'depot-bravo-with-a-long-name', load: 100, loadUnit: 'short tons', lift: { asset: 'heavy equipment transporters', count: 4, capacityEach: 20 }, distanceKm: 120, speedKmh: 40, handlingHours: 2, ready: '2026-11-19T06:00:00Z', required: '2026-11-19T10:00:00Z' }] }, { computedBy: 'mobility-planner-with-a-long-name', run: 'run-e2e', at: at(5) });
  const workspaces = {
    bodies: {
      'coa-themes': `| COA | Owner | Theme in one sentence | What must differ |\n|---|---|---|---|\n| COA A | coa-cell-a-with-a-long-member-name | Seize the port from the sea, ${long} | ${long} |\n| COA B | coa-cell-b | Cross the ford, ${long} | ${long} |\n`,
      'coa-validity': `| COA | Suitable | Feasible | Acceptable | Distinguishable | Complete | Distinct from |\n|---|---|---|---|---|---|---|\n| COA A | pass | risk: ${long} | pass | pass | fail: ${long} | COA B |\n`,
      'comparison-matrix': `| Criterion | Definition | Weight | COA A score and rationale | COA B score and rationale |\n|---|---|---|---|---|\n| Tempo with a long criterion name | ${long} | 3 | 4: ${long} | 2: ${long} |\n`,
      'coa-decision-brief': `## Recommendation\n\nThe staff recommends COA A, ${long}.\n`,
      'coa-supportability': `| Course of action | Function | Judgement | Where and when support runs out | Calculator record |\n|---|---|---|---|---|\n| COA A | Supply | Supportable with risk: ${long} | ${long} | calc:move-with-a-long-identifier |\n`
    },
    registers: {
      eventLog: [{ id: 'E1-LONG-IDENTIFIER', time: '2026-11-19T11:10:00Z', source: `Feed with ${long}`, report: `Armour moving, ${long}`, ccir: 'PIR-1-LONG', decisionPoint: 'DP-2-LONG', status: 'escalated' }],
      syncMatrix: [{ id: 's1', row: 'decision-points', hHourOffsetMinutes: 2880, entry: `DP 2, ${long}`, coa: 'coa-a' }, { id: 's2', row: 'enemy', hHourOffsetMinutes: -360, entry: long, section: 'j2' }],
      battleRhythm: [{ id: 'BR1', title: `Commander's update brief, ${long}`, kind: 'working-group', start: '2026-11-19T13:00:00Z', durationMinutes: 30, repeat: 'daily', chair: 'chief-of-staff-with-a-long-name', inputs: long, outputs: long }],
      rfi: [{ id: 'RFI-7-LONG', from: 'j3', to: 'higher', question: long, suspense: '2026-11-19T09:00:00Z', status: 'open' }],
      annexTracker: [{ id: 'A1', subject: 'logistics', letter: 'Q', owner: 'j4-director-with-a-long-name', status: 'drafting', product: 'logistics-annex' }]
    },
    wargame: { entries: [{ coa: 'coa-a-with-a-long-name', enemyCoa: 'mdcoa-with-a-long-name', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [{ unit: `1-41 MECH ${long}`, side: 'friendly', path: [] }], results: [long], decisionPoints: [{ id: 'DP2', description: long, decisionMaker: 'commander' }], sync: [], branches: [], recordedBy: 'plans-writer', at: at(6) }] },
    logistics: { records: move.ok ? [move.value] : [], recordProblems: [`calc:forged ${long}`], reports: [{ id: 'bn1-report-with-a-long-identifier', unit: `1st Battalion, ${long}`, reportedAt: '2026-11-19T10:00:00Z', lines: [{ commodity: `Class III (bulk), ${long}`, uom: 'litres', onHand: 6000, received: 0, consumed: 0, capacity: 30000, forecast: 100 }] }], bands: [] }
  };
  const model = buildStaffRoomModel({
    now: Date.UTC(2026, 10, 19, 12, 0), settings: defaultStaffSettings(), registry: [], decisions: [], cop: { layers: [], eventTail: [] }, events: events as never,
    ...(scenario.ok ? { scenario: scenario.value } : {}), j2: { sources: [], pirs: [], plan: [], enemyCoaBody: coaBody, enemyCoaProduct: 'adversary-coa-set' }, workspaces: workspaces as never
  });
  return { type: 'staff-room', model, cues: [] };
}

/**
 * 0.4.28: a team run as Team Live's host would send it, with long names, every state and helpers, built by the extension's own code. Its tree is three
 * cards wide, so the narrower widths show the indented list and the wider ones the tree.
 */
function teamLiveSample(): Message {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
  const { buildTeamLive } = require(path.join(extension.extensionPath, 'dist/agent/teamLiveState')) as typeof import('../../agent/teamLiveState');
  const { parseTeam } = require(path.join(extension.extensionPath, 'dist/agent/teams')) as typeof import('../../agent/teams');
  const team = parseTeam(['---', 'name: Market research team with a rather long name', 'description: Finds, writes and checks', '---', '',
    '## research-analyst-with-a-long-name', 'role: researcher', '', 'Search the web. Report each finding with its URL.', '',
    '## brief-writer', 'role: writer', 'reports-to: research-analyst-with-a-long-name', '', 'Write the brief. Report where it is.', '',
    '## reviewer', 'role: reviewer', '', 'Check the brief. Report problems.', '', '## designer', 'role: designer', '', 'Make the cover. Report the file.', ''].join('\n'), 'market.md');
  const runId = 'run-1700000000000-e2e111';
  const now = Date.now();
  const stat = (agentId: string, agent: string, extra: Record<string, unknown> = {}) => ({ agentId, agent, runId, model: LONG_MODEL, status: 'running', phase: 'tool', tool: 'WebSearch', startedAt: now - 95_000, turns: 12, toolCalls: 34, costUsd: 0.0123, boundary: 'tee', parentId: `main-${runId}`, ...extra });
  const stats = [
    stat(`main-${runId}`, 'team:market', { parentId: undefined, phase: 'waiting-agents', team: 'market', reportsDelivered: 2 }),
    stat('research-analyst-with-a-long-name-aaa111', 'research-analyst-with-a-long-name', { task: 'Find every competitor in the market and their prices for the brief', member: true }),
    stat('research-analyst-with-a-long-name-aaa222', 'research-analyst-with-a-long-name', { status: 'completed', member: true, endedAt: now - 20_000 }),
    stat('brief-writer-bbb111', 'brief-writer', { phase: 'waiting-you', waitingKind: 'image', member: true, task: 'Draft the market brief with the cover image' }),
    stat('reviewer-ccc111', 'reviewer', { phase: 'queued', member: true, task: 'Check the brief' }),
    stat('general-purpose-ddd111', 'general-purpose', { parentId: 'research-analyst-with-a-long-name-aaa111', task: 'Check a quote from a very long source document about pricing', phase: 'cooling-down', coolReason: 'rate-limited' }),
    stat('gsd-verifier-eee111', 'gsd-verifier', { parentId: 'brief-writer-bbb111', status: 'failed', boundary: 'cloud' })
  ];
  const view = buildTeamLive({ runId, stats: stats as never, team });
  return { type: 'team-live', now, runs: [{ runId, title: 'team:market', running: true, startedAt: now - 95_000 }, { runId: 'run-1700000000000-e2e222', title: 'A second team running at the same time', running: true, startedAt: now - 5_000 }], runId, view, events: [] };
}

const WIDE_REPLY = [
  'A wide reply:', '',
  '| Model | Overall | Coding | Research | Planning | Execution | Passed | Median time | Tokens/s | Cost |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  '| deepseek/deepseek-v4.1-flash-with-a-long-name | 8.1 | 8.4 | 7.9 | 8.0 | 8.2 | 90% | 41 s | 55 | $0.0123 |', '',
  '```ts', `const veryLongLine = '${'x'.repeat(200)}';`, '```', '',
  `See /home/someone/projects/${'deeply-nested-folder/'.repeat(8)}file.ts and https://example.com/${'segment/'.repeat(12)}page`
].join('\n');

/** A PNG of one colour, `width` by `height`, made here so the test needs no image file. */
function solidPng(width: number, height: number): Buffer {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data: Buffer) => { let c = 0xffffffff; for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]); };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
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
