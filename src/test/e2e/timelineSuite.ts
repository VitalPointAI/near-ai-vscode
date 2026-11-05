import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';
import { connectCdp, mouseClick, webviewFrameRect, type CdpSession, type Point } from './cdp';
import { fillScreen } from './x11Window';

// The timeline scenario (62.1-08, D-11): this repository's own committed roadmap on a test project (run.ts), the board switched to its Timeline view
// in a real VS Code window on a hidden virtual screen, and every step measured by the page's layout probe (media/board/layout-probe.js, 62.1-07).
// Every click, hover, wheel turn and key press is real input through the window's DevTools endpoint (cdp.ts, Input domain only), aimed with the
// probe's boxes plus the webview frame's place in the window. Nothing here makes an event inside the page. The board scenario (suite.ts) is not
// touched: this file has its own helpers, modelled on boardTests', and suite.ts loads it only when the timeline scenario runs.

const EXTENSION_ID = 'VitalPoint.near-ai-vscode';
const workspace = process.env.NEAR_AI_E2E_WORKSPACE!;
const STEP_MS = 20_000;
type Message = { type: string; [key: string]: unknown };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

// Bounded polling: the condition's value once it holds, or a failure that says what was awaited.
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = STEP_MS, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await sleep(everyMs);
  }
}

// ---- what the probe answers (62.1-07): the parts this scenario reads --------------------------------------------------------------------------
interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface Controls {
  view: { columns: Box | null; timeline: Box | null }; direction: { horizontal: Box | null; vertical: Box | null };
  zoomOut: Box | null; zoomIn: Box | null; fit: Box | null; now: Box | null; legend: Box | null;
}
interface TimelineDotReport { id: string; label: string; milestone: string; step: number; slot: number; state: string; rendered: boolean; box: Box }
interface Layer { box: Box; dotId: string | null; texts: Array<{ text: string }>; buttons: Array<{ name: string; width: number; height: number }> }
interface TimelineReport {
  view: string; direction: string; horizontalDisabled: boolean; zoom: number;
  scroller: { rect: Box; scrollTop: number; scrollLeft: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } | null;
  dots: TimelineDotReport[]; more: Array<Box & { milestone: string; step: number; text: string }>; tiles: Array<Box & { milestone: string; text: string }>;
  headers: Array<{ id: string; title: string; box: Box }>; percents: Array<{ milestone: string; what: string; text: string }>;
  now: { milestone: string; step: number; line: Box | null; pill: Box | null; text: string } | null;
  overall: { box: Box; text: string } | null; preview: Layer | null; card: Layer | null; focusedDot: string | null; controls: Controls;
  firstScreen: { nowVisible: boolean; nowStepDotVisible: boolean };
  metrics?: { drawMs: number | null; frames: { count: number; p95: number | null } };
}
interface LayoutReport { width: number; height: number; layout: string; theme: string; problems: string[]; cards: Array<{ id: string }>; controls?: Controls; timeline?: TimelineReport }
/** The timeline the host sent with the last board state (62.1-01): the model's own order, Now and percents. */
interface TimelineModelView {
  milestones: Array<{ id: string; title: string; active: boolean; finished: boolean; steps: number; cardCount: number; cycle: boolean; cycleNote?: string; percentText: string }>;
  dots: Array<{ cardId: string; milestoneId: string; step: number; slot: number; phaseId?: string }>;
  now?: { milestoneId: string; step: number; stepCount: number; phaseId?: string; allDone: boolean; sentence: string; title: string };
  percent?: { finished: number; counted: number; percent?: number; text: string };
}
interface ModelView { selectedMilestone: string; cards: Array<{ id: string; kind: string; column: string; milestoneId?: string }>; timeline?: TimelineModelView; timelineProblem?: boolean }

const centre = (b: Box): { x: number; y: number } => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });

export function timelineTests(): Array<[string, () => Promise<void>]> {
  const board = new Observer();
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  let api: NearAiTestApi;
  let tap: typeof import('../../services/team/boardView')['boardTap'];
  let cdp: CdpSession | undefined;
  let asks = 0;
  let editorWidth = 0;
  const problemsOf = (report: LayoutReport): string => `${report.timeline ? `timeline ${report.timeline.direction}` : report.layout} at ${report.width} by ${report.height} px:\n  ${report.problems.join('\n  ')}`;

  // One question to the page's layout probe and its one answer.
  const ask = async (request: { action: 'measure' | 'scroll' | 'focus' | 'rects'; top?: number; left?: number; itemId?: string; controls?: boolean }): Promise<LayoutReport> => {
    asks += 1;
    const id = asks;
    const before = board.fromView.length;
    await tap.layout!({ id, ...request });
    return (await board.next('fromView', (message) => message.type === 'e2e-layout-report' && message.id === id, before)).report as LayoutReport;
  };
  // Measures once the page has stopped changing: three readings in a row with the same size, view, direction and scroll, and `wanted` holds.
  const settled = async (what: string, wanted: (report: LayoutReport) => boolean = () => true): Promise<LayoutReport> => {
    const shape = (r: LayoutReport): string => {
      const t = r.timeline;
      return `${r.width}x${r.height} ${r.layout} ${t ? `${t.direction} ${t.zoom} ${t.scroller?.scrollLeft ?? 0},${t.scroller?.scrollTop ?? 0} ${t.dots.length}` : 'columns'}`;
    };
    let last = await ask({ action: 'measure' });
    let steady = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(250);
      const next = await ask({ action: 'measure' });
      steady = shape(next) === shape(last) && wanted(next) ? steady + 1 : 0;
      if (steady >= 2) return next;
      last = next;
    }
    throw new Error(`The board did not settle (${what}); last reading ${shape(last)}`);
  };
  /** The last board model the host sent the page. */
  const latestModel = (): ModelView => {
    const state = [...board.toView].reverse().find((m) => m.type === 'state' && m.model !== undefined);
    assert.ok(state !== undefined, 'the host sent a board state');
    return state.model as ModelView;
  };
  /** Where the page's (0, 0) is in the VS Code window: the board's webview frame, found by the page's own size. */
  const frameOf = async (report: LayoutReport): Promise<{ left: number; top: number }> => {
    assert.ok(cdp !== undefined, 'the DevTools connection is open');
    const frame = await webviewFrameRect(cdp, { width: report.width, height: report.height });
    assert.ok(frame !== undefined, `the board's webview frame (${report.width} by ${report.height}) is found in the window`);
    return frame;
  };
  /** The middle of a box the probe measured, as a point in the window. */
  const aim = async (report: LayoutReport, box: Box | null | undefined, what: string): Promise<Point> => {
    assert.ok(box && box.width > 0 && box.height > 0, `${what} is drawn`);
    const frame = await frameOf(report);
    const c = centre(box);
    return { x: Math.round(frame.left + c.x), y: Math.round(frame.top + c.y) };
  };
  /** A real click on a box the probe measured. */
  const click = async (report: LayoutReport, box: Box | null | undefined, what: string): Promise<void> => {
    const at = await aim(report, box, what);
    await mouseClick(cdp!, at);
  };
  const timelineOf = (report: LayoutReport): TimelineReport => {
    assert.ok(report.timeline, `the page shows the timeline (${report.layout})`);
    return report.timeline;
  };

  return [
    ['activates in the timeline project, a git project holding this repository\'s committed roadmap', async () => {
      api = (await extension().activate())!;
      assert.ok(api?.team, 'the test API carries the team handle');
      assert.equal(await api.team.handle.ready, 'solo', 'no team yet');
      assert.ok(existsSync(path.join(workspace, '.planning', 'ROADMAP.md')), 'the roadmap is in the project');
    }],
    ['Team Mode is enabled, the board opens with the layout probe on the page, and the imported roadmap is drawn as cards', async () => {
      const { enableTeamMode } = load<typeof import('../../team/enable')>('team/enable');
      const enabled = await enableTeamMode({
        projectRoot: workspace, globalStorageDir: api.team.globalStorageDir, secrets: api.team.secrets,
        teamName: 'E2E timeline team', ownerName: 'E2E Owner', remote: 'origin', integrationBranch: 'main'
      });
      assert.equal(enabled.ok, true, enabled.ok ? '' : enabled.message);
      tap = load<typeof import('../../services/team/boardView')>('services/team/boardView').boardTap;
      tap.toView = (message) => board.record(board.toView, message);
      tap.fromView = (message) => board.record(board.fromView, message);
      await vscode.commands.executeCommand('nearAi.team.openBoard');
      await board.next('fromView', (message) => message.type === 'ready');
      await board.next('toView', (message) => message.type === 'state');
      assert.ok(tap.layout, 'the layout hook is offered under NEAR_AI_E2E=1');
      await vscode.commands.executeCommand('nearAi.team.importPlans', { milestone: 'current' });
      const state = await board.next('toView', (message) => {
        if (message.type !== 'state' || message.model === undefined) return false;
        const model = message.model as ModelView;
        return model.cards.some((card) => card.kind === 'plan') && model.timeline !== undefined;
      }, 0, 60_000);
      const model = state.model as ModelView;
      await until('the imported cards on the page', async () => ((await ask({ action: 'rects' })).cards.length > 0 ? true : undefined));
      const timeline = model.timeline!;
      console.log(`(the board: ${model.cards.length} cards; the timeline: ${timeline.milestones.map((m) => `${m.id} ${m.cardCount} cards in ${m.steps} steps${m.active ? ', current' : ''}`).join('; ')}; Now: ${timeline.now?.sentence ?? 'none'})`);
      assert.ok(timeline.now !== undefined && !timeline.now.allDone, 'the roadmap has unfinished work, so there is a Now step');
    }],
    ['the window fills the hidden screen, the editor area has the whole window, and the DevTools endpoint on 127.0.0.1 answers', async () => {
      for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) await vscode.commands.executeCommand(command);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
      const before = await settled('the editor area alone', (r) => r.layout === 'kanban');
      try {
        const filled = await fillScreen();
        console.log(`(the window ${filled.before.width} by ${filled.before.height} now fills the ${filled.screen.width} by ${filled.screen.height} hidden screen: ${filled.after.width} by ${filled.after.height})`);
        assert.deepEqual(filled.after, { x: 0, y: 0, width: filled.screen.width, height: filled.screen.height }, 'the window has the whole screen');
      } catch (error) {
        console.log(`(the window keeps its size: ${String((error as Error).message ?? error)})`);
      }
      const report = before.width >= 1000 ? await settled('the editor area alone', (r) => r.layout === 'kanban')
        : await settled('the editor area of the whole screen', (r) => r.layout === 'kanban' && r.width > before.width);
      editorWidth = report.width;
      console.log(`(the editor area is ${editorWidth} by ${report.height} px; it was ${before.width} by ${before.height} px)`);
      assert.ok(editorWidth >= 1000, `the board is ${editorWidth} px wide`);
      const port = Number(process.env.NEAR_AI_E2E_CDP_PORT ?? '');
      assert.ok(Number.isInteger(port) && port > 0, 'run.ts gives the timeline window a DevTools port');
      cdp = await connectCdp(port);
      const version = await cdp.send<{ product?: string }>('Browser.getVersion').catch(() => ({ product: 'unknown' }));
      console.log(`(DevTools endpoint on 127.0.0.1:${port}: ${version.product ?? 'unknown'})`);
    }],
    ['a real click on Timeline draws the roadmap as the timeline: no problem at the full editor width, the Now pill and a dot of the Now step on the first screen, and a first draw under 100 ms', async () => {
      const columns = await ask({ action: 'measure', controls: true });
      assert.equal(columns.timeline ?? null, null, 'the board opens in Columns');
      await click(columns, columns.controls?.view.timeline, 'the View switch\'s Timeline button');
      await until('the Timeline view on the page', async () => ((await ask({ action: 'rects' })).timeline?.view === 'timeline' ? true : undefined), 10_000);
      // The first draw staggers the dots in (up to 600 ms plus 160 ms) and fades the lines in after them (62.1-06).
      await sleep(1_200);
      const report = await settled('the first timeline screen', (r) => r.timeline !== undefined && r.timeline.dots.length > 0);
      const t = timelineOf(report);
      const model = latestModel().timeline!;
      console.log(`(timeline ${t.direction} at ${report.width} by ${report.height} px, zoom ${t.zoom}%: ${t.dots.length} dots drawn of ${model.dots.length}, ${t.tiles.length} folded tiles, Now ${t.now?.text ?? 'none'})`);
      assert.equal(t.view, 'timeline');
      assert.ok(report.width >= editorWidth - 10, `the full editor width (${report.width} of ${editorWidth} px)`);
      assert.deepEqual(report.problems, [], problemsOf(report));
      assert.equal(t.firstScreen.nowVisible, true, 'the Now pill is on the first screen');
      assert.equal(t.firstScreen.nowStepDotVisible, true, 'a dot of the Now step is on the first screen');
      const drawMs = t.metrics?.drawMs;
      console.log(`first draw: ${drawMs ?? 'not measured'} ms (budget 100 ms)`);
      assert.ok(typeof drawMs === 'number', 'the page measured its first draw');
      assert.ok(drawMs < 100, `the first draw took ${drawMs} ms`);
    }]
  ];
}
