import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NearAiTestApi } from '../../extension';
import { connectCdp, mouseClick, mouseDrag, mouseMove, pressKey, webviewFrameRect, type CdpSession, type Point } from './cdp';
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
interface Layer { box: Box; dotId: string | null; texts: Array<{ text: string; box: Box }>; buttons: Array<{ name: string; width: number; height: number; box: Box }>; titleHeights?: { scrollHeight: number; clientHeight: number; clamp: string } }
interface TimelineReport {
  view: string; direction: string; horizontalDisabled: boolean; zoom: number;
  scroller: { rect: Box; scrollTop: number; scrollLeft: number; scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } | null;
  dots: TimelineDotReport[]; more: Array<Box & { milestone: string; step: number; text: string }>; tiles: Array<Box & { milestone: string; text: string }>;
  phaseLabels: Array<{ id: string; milestone: string; box: Box; text: string }>;
  headers: Array<{ id: string; title: string; box: Box; sticky: boolean }>; percents: Array<{ milestone: string; what: string; text: string; box: Box }>;
  now: { milestone: string; step: number; line: Box | null; pill: Box | null; text: string } | null;
  overall: { box: Box; text: string } | null; preview: Layer | null; card: Layer | null; focusedDot: string | null; controls: Controls;
  firstScreen: { nowVisible: boolean; nowStepDotVisible: boolean };
  notices: Array<{ milestone: string; text: string; box: Box }>; folds: Array<{ milestone: string; text: string; box: Box }>;
  focusedStop: { kind: 'dot' | 'tile' | 'more'; id: string | null; milestone: string; step: number } | null;
  error: { text: string; box: Box; buttons: Array<{ name: string; width: number; height: number; box: Box }> } | null;
  metrics?: { drawMs: number | null; frames: { count: number; p95: number | null } };
}
interface LayoutReport { width: number; height: number; layout: string; theme: string; problems: string[]; cards: Array<{ id: string }>; controls?: Controls; timeline?: TimelineReport }
/** The timeline the host sent with the last board state (62.1-01): the model's own order, Now and percents. */
interface TimelineModelView {
  milestones: Array<{ id: string; title: string; active: boolean; finished: boolean; steps: number; cardCount: number; cycle: boolean; cycleNote?: string; percentText: string }>;
  dots: Array<{ cardId: string; milestoneId: string; step: number; slot: number; phaseId?: string }>;
  edges: Array<{ from: string; to: string }>;
  now?: { milestoneId: string; step: number; stepCount: number; phaseId?: string; allDone: boolean; sentence: string; title: string };
  percent?: { finished: number; counted: number; percent?: number; text: string };
}
interface ModelView {
  selectedMilestone: string; cards: Array<{ id: string; kind: string; column: string; held: boolean; milestoneId?: string; moves: Array<{ key: string }> }>;
  timeline?: TimelineModelView; timelineProblem?: boolean;
}
/** A stop of the timeline's roving focus (UI-SPEC "Keyboard Model"): a dot, or the +{n} button of a stack over the cap. */
interface Stop { id: string | null; step: number; index: number }
type TeamLogT = import('../../team/eventLog').TeamLog;
type TeamStateT = import('../../domain/team/types').TeamState;
type ShapeT = NonNullable<typeof import('../../services/team/boardView')['boardTap']['shape']>;
/** The UI-SPEC's loop note (timelineText.ts CYCLE_NOTE), which the band shows when cards wait for each other in a loop. */
const CYCLE_TEXT = 'Some cards here wait for each other in a loop, so their order cannot be worked out. They are shown in plan number order.';

/** The Ready bug the owner's second client adds on the board (a board item id: item: and 26 Crockford base-32 characters). */
const BUG = `item:${'0'.repeat(22)}TMBG`;
const HOLD_TEXT = 'Backlog (put on hold)';
/** The frame budget (D-08): a 60 fps target, and a failure under 30 fps. */
const FRAME_TARGET_MS = 17;
const FRAME_FAIL_MS = 33;

const centre = (b: Box): { x: number; y: number } => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
const overlaps = (a: Box, b: Box, pad = 0): boolean => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
const within = (b: Box, area: Box, margin = 0): boolean => b.left >= area.left + margin - 1 && b.top >= area.top + margin - 1 && b.right <= area.right - margin + 1 && b.bottom <= area.bottom - margin + 1;
const unfinished = (column: string | undefined): boolean => column !== 'done' && column !== 'cancelled';

/** The stops of one milestone band by step, in slot order, from what the page drew: its dots and its +{n} buttons. */
function stopsOf(t: TimelineReport, milestone: string): Map<number, Stop[]> {
  const steps = new Map<number, Array<Stop & { slot: number }>>();
  const add = (step: number, stop: Stop & { slot: number }): void => { const list = steps.get(step) ?? []; list.push(stop); steps.set(step, list); };
  for (const d of t.dots) if (d.milestone === milestone && d.rendered && d.box.width > 0) add(d.step, { id: d.id, step: d.step, index: 0, slot: d.slot });
  for (const m of t.more) if (m.milestone === milestone) add(m.step, { id: null, step: m.step, index: 0, slot: Number.MAX_SAFE_INTEGER });
  const out = new Map<number, Stop[]>();
  for (const step of [...steps.keys()].sort((a, b) => a - b)) {
    out.set(step, (steps.get(step) ?? []).sort((a, b) => a.slot - b.slot).map((stop, index) => ({ id: stop.id, step, index })));
  }
  return out;
}
/** Where an along key lands (UI-SPEC "Keyboard Model"): the next or previous step that has a stop, keeping the slot index, else the last slot. */
function alongFrom(stops: Map<number, Stop[]>, from: Stop, forward: boolean): Stop | undefined {
  const steps = [...stops.keys()].filter((step) => (forward ? step > from.step : step < from.step));
  const step = forward ? Math.min(...steps) : Math.max(...steps);
  const list = stops.get(step);
  if (list === undefined || list.length === 0) return undefined;
  return list[Math.min(from.index, list.length - 1)];
}
const stopOf = (stops: Map<number, Stop[]>, id: string): Stop | undefined => [...stops.values()].flat().find((stop) => stop.id === id);

export function timelineTests(): Array<[string, () => Promise<void>]> {
  const board = new Observer();
  const extension = (): vscode.Extension<NearAiTestApi | undefined> => vscode.extensions.getExtension<NearAiTestApi | undefined>(EXTENSION_ID)!;
  const load = <T>(file: string): T => require(path.join(extension().extensionPath, 'dist', file)) as T;
  let api: NearAiTestApi;
  let tap: typeof import('../../services/team/boardView')['boardTap'];
  let cdp: CdpSession | undefined;
  let asks = 0;
  let editorWidth = 0;
  // A probe problem names what broke; the boxes around it (headers, percents, layers, the scroll) go with it, so a real-window failure can be read
  // without running again.
  const problemsOf = (report: LayoutReport): string => {
    const t = report.timeline;
    const b = (x: Box | null | undefined): string => (x ? `${Math.round(x.left)},${Math.round(x.top)} ${Math.round(x.width)}x${Math.round(x.height)}` : 'none');
    const named = new Set(report.problems.join(' ').match(/plan \d+(?:\.\d+)?-\d+|phase:\S+|item:\S+/g) ?? []);
    const around = t === undefined || report.problems.length === 0 ? '' : [
      `scroller ${b(t.scroller?.rect)} scrolled ${t.scroller?.scrollLeft ?? 0},${t.scroller?.scrollTop ?? 0}`,
      ...t.headers.map((h) => `header ${h.id}${h.sticky ? ' sticky' : ''} ${b(h.box)}`),
      ...t.percents.map((x) => `${x.what} ${x.milestone} "${x.text}" ${b(x.box)}`),
      `card ${b(t.card?.box)}${t.card?.titleHeights ? ` (title ${JSON.stringify(t.card.titleHeights)}; texts ${t.card.texts.slice(0, 3).map((x) => `"${x.text.slice(0, 30)}" ${b(x.box)}`).join(', ')})` : ''}; preview ${b(t.preview?.box)}; Now pill ${b(t.now?.pill)}; focused ${t.focusedDot ?? 'none'}`,
      ...t.dots.filter((d) => named.has(d.label.replace(/^Plan /, 'plan ')) || [...named].some((n) => d.label.toLowerCase().includes(n))).map((d) => `dot ${d.label} ${b(d.box)}`)
    ].join('\n    ');
    return `${t ? `timeline ${t.direction}` : report.layout} at ${report.width} by ${report.height} px:\n  ${report.problems.join('\n  ')}${around ? `\n  around it:\n    ${around}` : ''}`;
  };

  // One question to the page's layout probe and its one answer.
  const ask = async (request: { action: 'measure' | 'scroll' | 'focus' | 'rects'; top?: number; left?: number; itemId?: string; controls?: boolean; resetMetrics?: boolean }): Promise<LayoutReport> => {
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
  // One question to the board's own page probe (board.js, E2E only): only its facts and a let go of focus are used here, as in 62-22 to 62-24.
  const act = async (probe: { action: 'facts' | 'blur' }): Promise<Message> => {
    asks += 1;
    const id = 10_000 + asks;
    const before = board.fromView.length;
    await tap.probe!({ id, ...probe });
    return board.next('fromView', (message) => message.type === 'e2e-facts' && message.id === id, before);
  };
  const pageErrors = async (): Promise<string[]> => ((await act({ action: 'facts' })).errors as string[] | undefined) ?? [];
  /** A point on empty canvas, in the window: inside the visible timeline area and at least 16 px from every dot, label, header and layer. */
  const emptyPoint = async (report: LayoutReport): Promise<Point> => {
    const t = timelineOf(report);
    assert.ok(t.scroller, 'the timeline scroller is drawn');
    const area = t.scroller.rect;
    const taken: Box[] = [
      ...t.dots.map((d) => d.box), ...t.more, ...t.tiles, ...t.phaseLabels.map((l) => l.box), ...t.headers.map((h) => h.box),
      ...[t.now?.pill, t.now?.line, t.card?.box, t.preview?.box].filter((b): b is Box => !!b)
    ];
    const tries: Array<{ x: number; y: number }> = [];
    for (let y = area.bottom - 24; y > area.top + 24; y -= 24) for (let x = area.left + 24; x < area.right - 24; x += 24) tries.push({ x, y });
    const free = tries.find((p) => !taken.some((b) => overlaps(b, { left: p.x, right: p.x, top: p.y, bottom: p.y, width: 0, height: 0 }, 16)));
    assert.ok(free !== undefined, 'the timeline has empty canvas to click on');
    const frame = await frameOf(report);
    return { x: Math.round(frame.left + free.x), y: Math.round(frame.top + free.y) };
  };
  /** Brings a dot fully into view the way the page's own focus handling does, lets go of focus, and measures once the scroll has ended. */
  const inView = async (id: string): Promise<{ report: LayoutReport; dot: TimelineDotReport }> => {
    await ask({ action: 'focus', itemId: id });
    await act({ action: 'blur' });
    await sleep(400);
    const report = await settled(`${id} in view`);
    const t = timelineOf(report);
    const dot = t.dots.find((d) => d.id === id);
    assert.ok(dot !== undefined && t.scroller !== null && within(dot.box, t.scroller.rect, 4) && !t.headers.some((h) => overlaps(h.box, dot.box)), `${id} is fully in view`);
    return { report, dot };
  };
  /** One real key, then a reading once the focus has moved and any scroll it caused has ended. */
  const key = async (name: Parameters<typeof pressKey>[1], options: { ctrl?: boolean; shift?: boolean } = {}, waitMs = 350): Promise<LayoutReport> => {
    await pressKey(cdp!, name, options);
    await sleep(waitMs);
    return settled(`after ${options.ctrl ? 'Ctrl+' : ''}${options.shift ? 'Shift+' : ''}${name}`);
  };
  /** A real click on the Direction switch's button, then a reading once the 320 ms cross-fade has ended. */
  const direction = async (which: 'horizontal' | 'vertical'): Promise<LayoutReport> => {
    const before = await ask({ action: 'measure' });
    await click(before, timelineOf(before).controls.direction[which], `the Direction switch's ${which} button`);
    await until(`the ${which} timeline`, async () => ((await ask({ action: 'rects' })).timeline?.direction === which ? true : undefined), 10_000);
    await sleep(600);
    return settled(`the ${which} timeline`, (r) => r.timeline?.direction === which);
  };
  // Sizes the board's group to the asked width beside a second group (VS Code applies group sizes when the layout changes shape), in up to 4 tries,
  // as boardTests' sizeTo does; 'full' is one group.
  const one = async (): Promise<void> => { await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] }); };
  const sizeTo = async (asked: number | 'full'): Promise<LayoutReport> => {
    if (asked === 'full') { await one(); return settled('one group', (r) => r.width >= editorWidth - 10); }
    let fraction = Math.min(0.9, asked / editorWidth);
    let boardFirst = true;
    let last: LayoutReport | undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await one();
      await settled('one group', (r) => r.width >= editorWidth - 10).catch(() => undefined);
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: boardFirst ? [{ size: fraction }, { size: 1 - fraction }] : [{ size: 1 - fraction }, { size: fraction }] });
      const report = await settled('two groups', (r) => r.width < editorWidth - 10).catch(() => undefined);
      console.log(`(width ${asked}: try ${attempt} with ${Math.round(fraction * 100)} percent ${boardFirst ? 'first' : 'second'} reached ${report === undefined ? 'no steady reading' : `${report.width} px`})`);
      if (report === undefined) continue;
      last = report;
      if (Math.abs(report.width - asked) <= 40) return report;
      if (Math.abs(report.width - (1 - fraction) * editorWidth) < Math.abs(report.width - fraction * editorWidth)) { boardFirst = !boardFirst; continue; }
      fraction = Math.max(0.05, Math.min(0.95, fraction * asked / report.width));
    }
    throw new Error(`The board's group could not be sized to ${asked} px within 40 px: the editor area is ${editorWidth} px and the last try reached ${last === undefined ? 'no steady reading' : `${last.width} px`}`);
  };
  /** A step starts with no card open, whatever an earlier step left (real Escape, as a person would close it). */
  const noCard = async (): Promise<void> => {
    const r = await ask({ action: 'measure' });
    if (r.timeline?.card) { await pressKey(cdp!, 'Escape'); await sleep(350); }
  };
  /** The Now dot (UI-SPEC amendment, N): the first unfinished dot of the Now step in slot order, from the model. */
  const nowDotOf = (model: ModelView): string => {
    const now = model.timeline?.now;
    assert.ok(now !== undefined, 'the model has a Now step');
    const column = new Map(model.cards.map((c) => [c.id, c.column]));
    const inStep = (model.timeline?.dots ?? []).filter((d) => d.milestoneId === now.milestoneId && d.step === now.step).sort((a, b) => a.slot - b.slot);
    const first = inStep.find((d) => unfinished(column.get(d.cardId))) ?? inStep[0];
    assert.ok(first !== undefined, 'the Now step has a dot');
    return first.cardId;
  };

  // ---- the owner's second client (62-24 pattern): another computer with the same device key, its mirror in a temporary folder -----------------
  const secondFolders: string[] = [];
  let second: TeamLogT | undefined;
  const remote = process.env.NEAR_AI_E2E_BOARD_REMOTE ?? '';
  const eventsOnRemote = (): number => Number(execFileSync('git', ['-C', remote, 'rev-list', '--count', 'refs/heads/near-ai/coordination'], { encoding: 'utf8' }).trim());
  const appendOne = async (log: TeamLogT, what: string, event: import('../../team/eventLog').EventIntent): Promise<void> => {
    const appended = await log.append(() => [event]);
    assert.equal(appended.ok, true, appended.ok ? '' : `${what}: ${appended.reason}`);
  };
  let errorsBefore = 0;
  const dotIn = (model: ModelView, id: string): string | undefined => model.timeline?.dots.find((d) => d.cardId === id)?.milestoneId;
  // The host reads boardTap.shape on its next post; the page's own retry (as the board's retry buttons send it) asks for one. Retries are 2 s apart
  // at least (the board's cool-down, T-62-49).
  let lastRetry = 0;
  const repost = async (wanted: (m: ModelView) => boolean): Promise<ModelView> => {
    const wait = lastRetry + 2_200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRetry = Date.now();
    const toBefore = board.toView.length;
    await tap.request!({ type: 'retry' });
    return (await board.next('toView', (m) => m.type === 'state' && m.model !== undefined && wanted(m.model as ModelView), toBefore, 20_000)).model as ModelView;
  };
  /** One rare state: the seam set, the page given the shaped model, the body run once the motion settled, and the seam cleared whatever happened. */
  const withShape = async (shape: ShapeT, what: string, wanted: (m: ModelView) => boolean, body: (m: ModelView) => Promise<void>): Promise<void> => {
    tap.shape = shape;
    try {
      const model = await repost(wanted);
      await sleep(1_000);
      await body(model);
    } finally {
      tap.shape = undefined;
      await repost((m) => !wanted(m) && m.timeline !== undefined);
      await sleep(800);
      console.log(`(${what}: the test seam is cleared and the board is drawn from its own state again)`);
    }
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
    }],
    ['seeding: the owner\'s second client adds a bug with its parts and size and assigns nothing; after one poll it is a Ready dot in the Added on the board band', async () => {
      errorsBefore = (await pageErrors()).length;
      const session = api.team.handle.session();
      assert.ok(session, 'a session is running');
      assert.ok(remote !== '' && existsSync(remote), 'run.ts gives the online home (a local bare folder)');
      const { TeamLog } = load<typeof import('../../team/eventLog')>('team/eventLog');
      const { GitTransport } = load<typeof import('../../team/gitTransport')>('team/gitTransport');
      const { teamMaterializer } = load<typeof import('../../domain/team/materialize')>('domain/team/materialize');
      const { loadDeviceIdentity } = load<typeof import('../../team/identity')>('team/identity');
      const { teamStorageDir } = load<typeof import('../../team/teamFile')>('team/teamFile');
      const teamFile = session.teamFile;
      const anchor = { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
      const mirrorRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-timeline-second-'));
      secondFolders.push(mirrorRoot);
      const transport = new GitTransport({
        mirrorDir: path.join(teamStorageDir(mirrorRoot, teamFile.teamId), 'coordination.git'), projectRoot: workspace,
        remote: teamFile.coordination.remote, ref: teamFile.coordination.ref, materializer: teamMaterializer(anchor), baseDelayMs: 1
      });
      // The device key stays in the window's SecretStorage, which keeps it in memory while extension tests run (T-62.1-19).
      const identity = await loadDeviceIdentity(api.team.secrets, teamFile.teamId);
      assert.ok(identity, 'the owner device key is in SecretStorage');
      const reader = new TeamLog({ anchor, transport });
      await reader.sync();
      const memberId = reader.state().deviceIndex.get(identity.fingerprint);
      assert.ok(memberId, 'the device is a member');
      second = new TeamLog({ anchor, transport, signer: { identity, memberId } });
      await second.sync();
      const toBefore = board.toView.length;
      await appendOne(second, 'the bug', { type: 'item.created', body: { id: BUG, kind: 'bug', title: 'Timeline preview hides the Now pill', scope: ['media/board/**'], requirements: [], mustHaves: [], estimate: { tokens: 3000 } } });
      session.nudge();
      const state = await board.next('toView', (message) => message.type === 'state' && (message.model as ModelView | undefined)?.cards.some((c) => c.id === BUG && c.column === 'ready') === true, toBefore, 30_000);
      const dot = (state.model as ModelView).timeline?.dots.find((d) => d.cardId === BUG);
      assert.equal(dot?.milestoneId, 'board', 'the bug is in the Added on the board band');
      const report = await until('the bug drawn as a Ready dot', async () => {
        const r = await ask({ action: 'measure' });
        return r.timeline?.dots.some((d) => d.id === BUG && d.state === 'ready' && d.milestone === 'board') ? r : undefined;
      }, 10_000);
      await sleep(1_000);
      const after = await settled('the bug added');
      assert.deepEqual(after.problems, [], problemsOf(after));
      console.log(`(the bug ${BUG} is a Ready dot at step ${(dot?.step ?? 0) + 1} of the board band; ${timelineOf(report).dots.length} dots drawn)`);
    }],
    ['real keys, horizontal: Right and Down move along and across the steps, Home and End reach the milestone\'s ends, Enter opens the card, Escape brings focus back, M opens Move to..., and N goes to the Now dot and says the Now sentence', async () => {
      const model = latestModel();
      const now = model.timeline!.now!;
      const start = nowDotOf(model);
      // A real click on empty canvas gives the board's page the keyboard (a press and release without moving only closes an open card).
      const first = await ask({ action: 'measure' });
      await mouseClick(cdp!, await emptyPoint(first));
      await ask({ action: 'focus', itemId: start });
      await sleep(400);
      let report = await settled('the Now dot focused', (r) => r.timeline?.focusedDot === start);
      let t = timelineOf(report);
      assert.deepEqual(report.problems, [], problemsOf(report));
      const stops = stopsOf(t, now.milestoneId);
      const from = stopOf(stops, start);
      assert.ok(from !== undefined, `${start} is a stop`);
      // Right: the next step that has a dot, the one the model's order names.
      const right = alongFrom(stops, from, true);
      assert.ok(right !== undefined, 'the Now step has a later step');
      const modelNext = Math.min(...model.timeline!.dots.filter((d) => d.milestoneId === now.milestoneId && d.step > from.step).map((d) => d.step));
      assert.equal(right.step, modelNext, 'the next step on the page is the model\'s next step');
      report = await key('ArrowRight');
      t = timelineOf(report);
      console.log(`(Right from ${start} at step ${from.step + 1}: ${t.focusedDot ?? 'the +n button'} at step ${right.step + 1})`);
      assert.equal(t.focusedDot, right.id, 'Right moves to the next step');
      assert.deepEqual(report.problems, [], problemsOf(report));
      // Down: the next dot in the same step, or nothing at the end of it.
      const down = stops.get(right.step)?.[right.index + 1];
      report = await key('ArrowDown');
      t = timelineOf(report);
      assert.equal(t.focusedDot, down === undefined ? right.id : down.id, down === undefined ? 'Down at the end of a step does nothing' : 'Down moves within the step');
      // Home and End: the first and the last stop of the milestone.
      const all = [...stops.values()];
      const firstStop = all[0]?.[0];
      const lastList = all[all.length - 1] ?? [];
      const lastStop = lastList[lastList.length - 1];
      report = await key('Home');
      assert.equal(timelineOf(report).focusedDot, firstStop?.id ?? null, 'Home goes to the milestone\'s first dot');
      assert.deepEqual(report.problems, [], problemsOf(report));
      report = await key('End');
      assert.equal(timelineOf(report).focusedDot, lastStop?.id ?? null, 'End goes to the milestone\'s last dot');
      assert.deepEqual(report.problems, [], problemsOf(report));
      // Enter opens the card inside the visible timeline area; Escape closes it and focus is back on the dot.
      await ask({ action: 'focus', itemId: start });
      await sleep(400);
      report = await key('Enter', {}, 450);
      t = timelineOf(report);
      assert.ok(t.card !== null, 'Enter opens the card');
      assert.ok(t.scroller !== null && within(t.card.box, t.scroller.rect), 'the card is inside the visible timeline area');
      assert.deepEqual(report.problems, [], problemsOf(report));
      report = await key('Escape', {}, 350);
      t = timelineOf(report);
      assert.equal(t.card, null, 'Escape closes the card');
      assert.equal(t.focusedDot, start, 'focus is back on the dot');
      // M opens Move to... for the focused dot; Escape closes it.
      await pressKey(cdp!, 'm');
      const menu = await until('the Move to... menu', async () => { const f = await act({ action: 'facts' }); return f.menuOpen === true ? f : undefined; }, 5_000);
      console.log(`(M on ${start}: ${(menu.menuTexts as string[]).join(', ')})`);
      await pressKey(cdp!, 'Escape');
      await until('the menu closed', async () => ((await act({ action: 'facts' })).menuOpen === false ? true : undefined), 5_000);
      // N: focus goes to the Now dot and the Now sentence is said. Home first, so N has somewhere to go.
      await key('Home');
      await pressKey(cdp!, 'n');
      const live = await until('the Now sentence said', async () => { const f = await act({ action: 'facts' }); return String(f.live ?? '').includes(now.sentence) ? String(f.live) : undefined; }, 5_000);
      // Jump to now scrolls smoothly; the reading waits for the scroll to end.
      report = await settled('after N', (r) => r.timeline?.focusedDot === start);
      assert.deepEqual(report.problems, [], problemsOf(report));
      console.log(`(N: focus on ${start}; said: ${live})`);
      assert.equal(live, now.sentence, 'the live text is the model\'s Now sentence');
    }],
    ['real keys, vertical: after a real click on Vertical, Down moves along the steps and Right within a step; then back to Horizontal', async () => {
      const model = latestModel();
      const now = model.timeline!.now!;
      const start = nowDotOf(model);
      let report = await direction('vertical');
      try {
        assert.deepEqual(report.problems, [], problemsOf(report));
        await ask({ action: 'focus', itemId: start });
        await sleep(400);
        report = await settled('the Now dot focused in vertical', (r) => r.timeline?.focusedDot === start);
        const stops = stopsOf(timelineOf(report), now.milestoneId);
        const from = stopOf(stops, start)!;
        const along = alongFrom(stops, from, true)!;
        report = await key('ArrowDown');
        assert.equal(timelineOf(report).focusedDot, along.id, 'Down moves to the next step in vertical');
        assert.deepEqual(report.problems, [], problemsOf(report));
        const across = stops.get(along.step)?.[along.index + 1];
        report = await key('ArrowRight');
        assert.equal(timelineOf(report).focusedDot, across === undefined ? along.id : across.id, across === undefined ? 'Right at the end of a step does nothing' : 'Right moves within the step in vertical');
        assert.deepEqual(report.problems, [], problemsOf(report));
        console.log(`(vertical: Down from ${start} to ${along.id ?? 'the +n button'}, Right to ${timelineOf(report).focusedDot ?? 'the +n button'})`);
      } finally {
        // Back to Horizontal whatever happened, so the next steps start from the saved direction.
        await act({ action: 'blur' });
        report = await direction('horizontal');
      }
      assert.deepEqual(report.problems, [], problemsOf(report));
    }],
    ['a real mouse: hovering a dot shows its preview after 300 ms, away from its own dot; moving off hides it; a click opens the card and a click on empty canvas closes it', async () => {
      await noCard();
      const id = nowDotOf(latestModel());
      const { report: shown, dot } = await inView(id);
      const away = await emptyPoint(shown);
      const at = await aim(shown, dot.box, `the dot ${id}`);
      await mouseMove(cdp!, away);
      await sleep(200);
      await mouseMove(cdp!, at, { from: away, steps: 8 });
      await sleep(450);
      let report = await settled('the preview shown', (r) => r.timeline?.preview !== null);
      let t = timelineOf(report);
      assert.ok(t.preview !== null, 'the preview is shown');
      const own = t.dots.find((d) => d.id === id)!;
      assert.equal(overlaps(t.preview.box, own.box), false, 'the preview is not over its own dot');
      assert.deepEqual(report.problems, [], problemsOf(report));
      console.log(`(preview of ${id}: ${Math.round(t.preview.box.width)} by ${Math.round(t.preview.box.height)} px at ${Math.round(t.preview.box.left)},${Math.round(t.preview.box.top)}; dot at ${Math.round(own.box.left)},${Math.round(own.box.top)})`);
      await mouseMove(cdp!, away, { from: at, steps: 8 });
      await sleep(400);
      report = await settled('the preview hidden', (r) => r.timeline?.preview === null);
      assert.equal(timelineOf(report).preview, null, 'moving off the dot hides the preview');
      await mouseClick(cdp!, at);
      await sleep(450);
      report = await settled('the card open', (r) => r.timeline?.card !== null);
      t = timelineOf(report);
      assert.ok(t.card !== null, 'a click opens the card');
      assert.deepEqual(report.problems, [], problemsOf(report));
      await mouseClick(cdp!, await emptyPoint(report));
      await sleep(350);
      report = await settled('the card closed', (r) => r.timeline?.card === null);
      assert.equal(timelineOf(report).card, null, 'a click on empty canvas closes the card');
      assert.deepEqual(report.problems, [], problemsOf(report));
    }],
    ['a move from the card: a real click opens the Ready bug\'s card, Move to..., then real Down and Enter to Backlog (put on hold) send exactly one move request, the record gains one signed event, and the dot is drawn held', async () => {
      const { report: shown, dot } = await inView(BUG);
      await click(shown, dot.box, 'the bug\'s dot');
      await sleep(450);
      const opened = await settled('the bug\'s card open', (r) => r.timeline?.card !== null);
      const card = timelineOf(opened).card!;
      assert.deepEqual(opened.problems, [], problemsOf(opened));
      const move = card.buttons.find((b) => b.name.startsWith('Move to...'));
      assert.ok(move !== undefined, `the card has Move to... (${card.buttons.map((b) => b.name).join(', ')})`);
      const events = eventsOnRemote();
      const fromBefore = board.fromView.length;
      const toBefore = board.toView.length;
      await click(opened, move.box, 'Move to...');
      let facts = await until('the Move to... menu', async () => { const f = await act({ action: 'facts' }); return f.menuOpen === true ? f : undefined; }, 5_000);
      console.log(`(the bug's Move to...: ${(facts.menuTexts as string[]).join(', ')})`);
      assert.ok((facts.menuTexts as string[]).includes(HOLD_TEXT), `${HOLD_TEXT} is offered`);
      for (let presses = 0; presses < 12 && facts.focusedText !== HOLD_TEXT; presses += 1) {
        await pressKey(cdp!, 'ArrowDown');
        await sleep(100);
        facts = await act({ action: 'facts' });
      }
      assert.equal(facts.focusedText, HOLD_TEXT, `real Down keys reach ${HOLD_TEXT}`);
      await pressKey(cdp!, 'Enter');
      const posted = await board.next('fromView', (message) => message.type === 'move', fromBefore, 10_000);
      assert.deepEqual(posted, { type: 'move', itemId: BUG, target: 'hold' });
      await board.next('toView', (message) => message.type === 'state' && (message.model as ModelView | undefined)?.cards.some((c) => c.id === BUG && c.held) === true, toBefore, 30_000);
      await until('one more event on the coordination record', () => (eventsOnRemote() === events + 1 ? true : undefined), 20_000);
      const held = await until('the bug drawn held', async () => { const r = await ask({ action: 'measure' }); return r.timeline?.dots.some((d) => d.id === BUG && d.state === 'held') ? r : undefined; }, 10_000);
      assert.equal(board.fromView.slice(fromBefore).filter((m) => m.type === 'move').length, 1, 'exactly one move request');
      console.log(`(one move request, ${eventsOnRemote() - events} signed event; the bug's dot is ${timelineOf(held).dots.find((d) => d.id === BUG)?.state})`);
      await pressKey(cdp!, 'Escape');
      await sleep(350);
      const closed = await settled('the bug\'s card closed', (r) => r.timeline?.card === null);
      assert.deepEqual(closed.problems, [], problemsOf(closed));
    }],
    ['a teammate moves the Now step: a change from the second client moves the Now marker within one poll, the percent changes and the new Now sentence is said, with no probe problem', async () => {
      await noCard();
      const session = api.team.handle.session();
      assert.ok(session && second, 'the session and the second client');
      const model = latestModel();
      const now = model.timeline!.now!;
      const before = await settled('before the teammate\'s change');
      const t0 = timelineOf(before);
      const percentBefore = t0.overall?.text ?? '';
      const cards = new Map(model.cards.map((c) => [c.id, c]));
      const dots = model.timeline!.dots.filter((d) => d.milestoneId === now.milestoneId);
      const open = dots.filter((d) => d.step === now.step).map((d) => cards.get(d.cardId)!).filter((c) => unfinished(c.column));
      assert.ok(open.length > 0, 'the Now step has unfinished cards');
      // The planned change: the second client marks done every unfinished card of the Now step with the board's own Mark done event, which needs
      // each to be a plan or a board item that the board can mark done. When this repository's data breaks that (a phase without plans has no move
      // on the board), the run says which card, and the teammate reopens the latest done plan before the Now step instead (the board's Reopen),
      // which moves the Now marker back to that plan's step.
      const notDone = open.filter((c) => !((c.kind === 'plan' || c.id.startsWith('item:')) && c.moves.some((m) => m.key === 'done')));
      const toBefore = board.toView.length;
      let expectLater: boolean;
      if (notDone.length === 0) {
        console.log(`(the Now step ${now.step + 1}: marking done ${open.map((c) => c.id).join(', ')})`);
        for (const c of open) await appendOne(second, `${c.id} done`, { type: 'item.updated', body: { id: c.id, changes: { state: 'done' } } });
        expectLater = true;
      } else {
        const back = dots.filter((d) => d.step < now.step).map((d) => ({ d, c: cards.get(d.cardId)! }))
          .filter(({ c }) => c.kind === 'plan' && c.column === 'done' && c.moves.some((m) => m.key === 'reopen')).sort((a, b) => b.d.step - a.d.step || b.d.slot - a.d.slot)[0];
        console.log(`(the Now step ${now.step + 1} cannot be finished from the board: ${notDone.map((c) => `${c.id} is a ${c.kind} in ${c.column} with moves ${c.moves.map((m) => m.key).join(', ') || 'none'}`).join('; ')}; the teammate reopens ${back?.c.id ?? 'nothing'} at step ${(back?.d.step ?? -1) + 1} instead)`);
        assert.ok(back !== undefined, 'a done plan before the Now step can be reopened from the board');
        await appendOne(second, `${back.c.id} reopened`, { type: 'item.reopened', body: { id: back.c.id } });
        expectLater = false;
      }
      session.nudge();
      const state = await board.next('toView', (message) => {
        const n = (message.model as ModelView | undefined)?.timeline?.now;
        return message.type === 'state' && n !== undefined && (n.milestoneId !== now.milestoneId || n.step !== now.step);
      }, toBefore, 30_000);
      const moved = (state.model as ModelView).timeline!.now!;
      const said = await until('the new Now sentence said', async () => { const f = await act({ action: 'facts' }); return String(f.live ?? '').includes(moved.sentence) ? String(f.live) : undefined; }, 10_000);
      // The marker glides 320 ms; the reading waits for it.
      await sleep(600);
      const after = await settled('the Now marker moved', (r) => r.timeline?.now?.step === moved.step && r.timeline.now.milestone === moved.milestoneId);
      const t1 = timelineOf(after);
      console.log(`(after one poll: ${t1.now?.text ?? 'none'}, ${t1.overall?.text ?? ''}; said: ${said})`);
      assert.ok(t1.now !== null && (t1.now.milestone !== now.milestoneId || (expectLater ? t1.now.step > now.step : t1.now.step < now.step)), `the Now marker moved to ${expectLater ? 'a later' : 'an earlier'} step`);
      assert.notEqual(t1.overall?.text ?? '', percentBefore, 'the overall percent changed');
      assert.deepEqual(after.problems, [], problemsOf(after));
    }],
    [`frame timing: a pan by a real drag on empty canvas, four Zoom clicks and two direction switches keep the frame interval p95 at or under ${FRAME_FAIL_MS} ms (target ${FRAME_TARGET_MS} ms)`, async () => {
      await noCard();
      const start = await settled('before the frame set');
      await ask({ action: 'measure', resetMetrics: true });
      const from = await emptyPoint(start);
      const frame = await frameOf(start);
      const area = timelineOf(start).scroller!.rect;
      const to = { x: Math.max(Math.round(frame.left + area.left + 24), from.x - 300), y: from.y };
      await mouseDrag(cdp!, from, to, { steps: 24, pauseMs: 16 });
      await sleep(1_000);
      for (const which of ['zoomIn', 'zoomIn', 'zoomOut', 'zoomOut'] as const) {
        const r = await ask({ action: 'measure' });
        await click(r, timelineOf(r).controls[which], which === 'zoomIn' ? 'Zoom in' : 'Zoom out');
        await sleep(700);
      }
      await direction('vertical');
      await sleep(500);
      const back = await direction('horizontal');
      await sleep(500);
      const metrics = timelineOf(await ask({ action: 'measure' })).metrics;
      const p95 = metrics?.frames.p95;
      console.log(`frame p95: ${p95 ?? 'not measured'} ms over ${metrics?.frames.count ?? 0} frames (target ${FRAME_TARGET_MS} ms, fail above ${FRAME_FAIL_MS} ms)`);
      assert.ok(typeof p95 === 'number' && (metrics?.frames.count ?? 0) > 0, 'frames were sampled');
      console.log(`(page errors so far: ${(await pageErrors()).length - errorsBefore} new)`);
      assert.ok(p95 <= FRAME_FAIL_MS, `the frame interval p95 is ${p95} ms`);
      assert.deepEqual(back.problems, [], problemsOf(back));
    }],
    ['no page error appeared during the real input, the move, the teammate\'s change and the frame set', async () => {
      const errors = (await pageErrors()).slice(errorsBefore);
      assert.deepEqual(errors, [], 'no new page error');
    }],
    ['narrow: under 480 px the timeline is drawn vertical with Horizontal disabled, with no problem, and at 1400 px the saved horizontal comes back', async () => {
      const errorsAtStart = (await pageErrors()).length;
      const narrow = await sizeTo(480);
      // The board's own ResizeObserver draws the page again at its 520 px breakpoint (62-21), which Chromium reports as a ResizeObserver loop
      // notice; the board scenario takes its error baseline after its resizes for the same reason (62-23). It is said here, not hidden.
      console.log(`(page errors after the 480 px resize: ${(await pageErrors()).slice(errorsAtStart).join(' | ') || 'none'})`);
      await sleep(600);
      const n = await settled('the timeline at 480 px', (r) => r.timeline?.direction === 'vertical');
      const t = timelineOf(n);
      console.log(`(at ${n.width} px: ${t.direction}, Horizontal disabled ${t.horizontalDisabled}; asked 480, reached ${narrow.width})`);
      assert.equal(t.direction, 'vertical', 'drawn vertical under 520 px');
      assert.equal(t.horizontalDisabled, true, 'Horizontal is disabled');
      assert.deepEqual(n.problems, [], problemsOf(n));
      await sizeTo(1400);
      await sleep(600);
      const wide = await settled('the timeline at 1400 px', (r) => r.timeline?.direction === 'horizontal');
      const w = timelineOf(wide);
      assert.equal(w.direction, 'horizontal', 'the saved horizontal comes back');
      assert.equal(w.horizontalDisabled, false, 'Horizontal is offered again');
      assert.deepEqual(wide.problems, [], problemsOf(wide));
      await sizeTo('full');
    }],
    // Last, whatever happened above (run() runs every step): the second client's folders go, and the run says how many (T-62.1-19).
    ['the second client\'s folders are removed', async () => {
      const folders = secondFolders.splice(0);
      for (const folder of folders) await rm(folder, { recursive: true, force: true });
      const left = folders.filter((folder) => existsSync(folder));
      console.log(`(second client folders removed: ${folders.length - left.length}${left.length ? `; still there: ${left.join(', ')}` : ''})`);
      assert.deepEqual(left, [], 'every second client folder is removed');
    }]
  ];
}
