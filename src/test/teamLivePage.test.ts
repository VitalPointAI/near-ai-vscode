import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildTeamLive, LiveAgentStat, teamLiveEvents, TeamLiveView } from '../agent/teamLiveState';
import { parseTeam } from '../agent/teams';

// 0.4.28: the Team Live page script, run in a small DOM: what it draws, the hand-offs it animates (and cancels), stillness under reduced motion and the
// Calm toggle, the keyboard tree pattern, and the polite announcements.

const SCRIPT = path.join(__dirname, '..', '..', 'media', 'teamLive', 'teamLive.js');

class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(event: unknown) => void>>();
  style: Record<string, string> & { setProperty(name: string, value: string): void } = Object.assign(Object.create(null), { setProperty(this: Record<string, string>, name: string, value: string) { this[name] = value; } });
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = ''; selected = false; tabIndex = -1;
  clientWidth = 0; offsetLeft = 0; offsetTop = 0; offsetHeight = 0;
  animations: Array<{ frames: unknown[]; options: Record<string, unknown>; cancelled: boolean; onfinish?: () => void; oncancel?: () => void; cancel(): void; finish(): void }> = [];
  private text = '';
  constructor(public tagName: string, private readonly doc: FakeDoc) {}
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => list().includes(name),
      add: (name: string) => { if (!list().includes(name)) this.className = [...list(), name].join(' '); },
      remove: (name: string) => { this.className = list().filter((item) => item !== name).join(' '); },
      toggle: (name: string, force?: boolean) => { const on = force ?? !list().includes(name); this.className = on ? [...new Set([...list(), name])].join(' ') : list().filter((item) => item !== name).join(' '); return on; }
    };
  }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Array<FakeNode | string>) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? this.doc.createTextNode(node) : node;
      child.remove();
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; } }
  replaceChildren(...nodes: FakeNode[]) { for (const child of this.children) child.parent = undefined; this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === 'class') this.className = value; }
  getAttribute(name: string) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string, event: Record<string, unknown> = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, stopPropagation() {}, ...event }); }
  click() { this.fire('click'); }
  focus() { this.doc.activeElement = this; }
  animate(frames: unknown[], options: Record<string, unknown> = {}) {
    const animation = { frames, options, cancelled: false, onfinish: undefined as undefined | (() => void), oncancel: undefined as undefined | (() => void), cancel() { this.cancelled = true; this.oncancel?.(); }, finish() { this.onfinish?.(); } };
    this.animations.push(animation);
    this.doc.animations.push(animation);
    return animation;
  }
  all(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.all()]); }
}
class FakeDoc {
  body = new FakeNode('body', this);
  documentElement = { clientWidth: 1000 };
  activeElement: FakeNode | null = null;
  hidden = false;
  animations: FakeNode['animations'] = [];
  listeners = new Map<string, Array<() => void>>();
  constructor() {
    for (const id of ['title', 'run-state', 'run-picker', 'calm', 'layout', 'show-chat', 'empty', 'restored', 'stage', 'card', 'announce']) { const node = new FakeNode(['calm', 'layout', 'show-chat'].includes(id) ? 'button' : 'div', this); node.id = id; this.body.append(node); }
    const run = new FakeNode('select', this); run.id = 'run'; this.getElementById('run-picker')!.append(run);
    for (const id of ['lines', 'tree', 'pulses']) { const node = new FakeNode(id === 'lines' ? 'svg' : 'div', this); node.id = id; this.getElementById('stage')!.append(node); }
  }
  getElementById(id: string) { return this.body.all().find((node) => node.id === id) ?? null; }
  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeNode(tag, this); }
  createTextNode(text: string) { const node = new FakeNode('#text', this); node.textContent = text; return node; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
}

async function runPage(options: { reduced?: boolean; width?: number; state?: Record<string, unknown> } = {}) {
  const doc = new FakeDoc();
  doc.getElementById('stage')!.clientWidth = options.width ?? 1000;
  const posts: Array<Record<string, any>> = [];
  const states: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const sandbox = vm.createContext({
    document: doc,
    window: { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener); } },
    matchMedia: (query: string) => ({ matches: Boolean(options.reduced) && /reduce/.test(query), addEventListener() {} }),
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, any>) => posts.push(JSON.parse(JSON.stringify(message))), getState: () => options.state, setState: (state: Record<string, unknown>) => states.push({ ...state }) }),
    // The page's one clock must not keep the test process alive.
    setTimeout, clearTimeout, setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval, JSON, Map, Set, Date, String, Number, Boolean, Object, Array, Math, RegExp
  });
  vm.runInContext(await readFile(SCRIPT, 'utf8'), sandbox, { timeout: 1000 });
  const cards = () => doc.getElementById('tree')!.children;
  const card = (id: string) => cards().find((node) => node.dataset.id === id)!;
  return { doc, posts, states, cards, card, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data })), settle: () => new Promise((resolve) => setTimeout(resolve, 450)) };
}

const TEAM = parseTeam(`---
name: Research
description: Finds and writes
---

## researcher
role: researcher

Search the web. Report each finding with its URL.

## writer
role: writer
reports-to: researcher

Write the brief. Report where it is.

## reviewer
role: reviewer

Check the brief. Report problems.
`, 'research.md');

const RUN = 'run-1700000000000-aaa111';
const stat = (agentId: string, agent: string, extra: Partial<LiveAgentStat> = {}): LiveAgentStat => ({ agentId, agent, runId: RUN, model: 'z-ai/glm-5.3', status: 'running', phase: 'thinking', startedAt: 1_000, turns: 1, toolCalls: 2, costUsd: 0.001, boundary: 'tee', parentId: agentId.startsWith('main-') ? undefined : `main-${RUN}`, ...extra });
const LEAD = stat(`main-${RUN}`, 'team:research', { team: 'research' });
function frame(stats: LiveAgentStat[], previous?: TeamLiveView): { message: Record<string, unknown>; view: TeamLiveView } {
  const view = buildTeamLive({ runId: RUN, stats, team: TEAM });
  return { view, message: { type: 'team-live', now: Date.now(), runs: [{ runId: RUN, title: 'team:research', running: true, startedAt: 1_000 }], runId: RUN, view, events: teamLiveEvents(previous, view) } };
}

test('page: draws every card in its state with words, as a tree with levels, and says the summary once', async () => {
  const page = await runPage();
  assert.deepEqual(page.posts, [{ type: 'ready' }]);
  assert.equal(page.doc.getElementById('empty')!.hidden, false);
  const { message } = frame([LEAD, stat('researcher-aaa111', 'researcher', { phase: 'tool', tool: 'WebSearch', task: 'Find sources' }), stat('general-purpose-bbb111', 'general-purpose', { parentId: 'researcher-aaa111', task: 'Check a quote', phase: 'waiting-you', waitingKind: 'question' })]);
  page.dispatch(message);
  assert.equal(page.doc.getElementById('empty')!.hidden, true);
  assert.deepEqual(page.cards().map((node) => node.dataset.id), ['lead', 'm:researcher', 'm:writer', 'g:general-purpose-bbb111', 'm:reviewer']);
  assert.deepEqual(page.cards().map((node) => node.getAttribute('aria-level')), ['1', '2', '3', '3', '2']);
  assert.match(page.card('m:researcher').textContent, /researcher.*Working.*Running WebSearch.*Task: Find sources.*TEE.*glm-5\.3/);
  assert.match(page.card('m:writer').className, /state-bench/);
  assert.match(page.card('m:writer').textContent, /Not asked yet/);
  assert.match(page.card('g:general-purpose-bbb111').textContent, /Check a quote.*Needs you: an answer to a question.*Answer in chat.*From researcher/);
  assert.equal(page.doc.getElementById('tree')!.getAttribute('role') ?? 'tree', 'tree');
  assert.equal(page.cards().filter((node) => node.tabIndex === 0).length, 1, 'one tab stop for the whole tree');
  assert.match(page.doc.getElementById('stage')!.className, /\bwide\b/, 'a wide panel draws the tree');
  assert.match(page.card('m:researcher').style.transform, /^translate\(\d+px, \d+px\)$/);
  assert.equal(page.doc.animations.length, 0, 'the first picture has no catch-up animation');
  await page.settle();
  assert.match(page.doc.getElementById('announce')!.textContent, /^Team Research: 1 needs you, 1 working\.$/);
  // Narrow: the same cards as an indented list, with no positions.
  const narrow = await runPage({ width: 300 });
  narrow.dispatch(message);
  assert.match(narrow.doc.getElementById('stage')!.className, /\blist\b/);
  assert.equal(narrow.card('m:researcher').style.transform, '');
  assert.equal(narrow.card('m:writer').style['--depth'], '2');
});

test('page: a hand-off sends a dot down the line, the card waits for it, and an end mid-flight cancels it', async () => {
  const page = await runPage();
  const start = frame([LEAD]);
  page.dispatch(start.message);
  const handed = frame([LEAD, stat('writer-ccc111', 'writer', { task: 'Draft the brief' })], start.view);
  page.dispatch(handed.message);
  const pulses = page.doc.getElementById('pulses')!.children;
  assert.equal(pulses.length, 1);
  assert.match(pulses[0].textContent, /Draft the brief/);
  assert.equal(page.doc.animations.length, 1);
  assert.match(page.card('m:writer').className, /\bawaiting\b/, 'the card wakes when the task arrives');
  assert.match(page.card('m:writer').className, /state-working/, 'its words already say where it is');
  // It ended before the dot arrived: the pulse is cancelled and the card shows how it ended.
  const ended = frame([LEAD, stat('writer-ccc111', 'writer', { task: 'Draft the brief', status: 'cancelled' })], handed.view);
  page.dispatch(ended.message);
  assert.equal(page.doc.animations[0].cancelled, true);
  assert.equal(page.doc.getElementById('pulses')!.children.length, 0);
  assert.doesNotMatch(page.card('m:writer').className, /awaiting/);
  assert.match(page.card('m:writer').textContent, /Stopped/);
  // A finished hand-off: the report travels up.
  const again = frame([LEAD, stat('writer-ccc222', 'writer', { task: 'Shorten it' })], ended.view);
  page.dispatch(again.message);
  page.doc.animations.at(-1)!.finish();
  const docks = () => page.doc.animations.filter((animation) => animation.options.duration === 450).length;
  assert.equal(docks(), 0, 'a task arriving does not flash the report ring (review of PR 72)');
  const done = frame([LEAD, stat('writer-ccc222', 'writer', { task: 'Shorten it', status: 'completed' })], again.view);
  page.dispatch(done.message);
  assert.match(page.doc.getElementById('pulses')!.children.at(-1)!.textContent, /Report ready/);
  const report = page.doc.animations.at(-1)!;
  report.finish();
  assert.equal(docks(), 1, 'a report arriving flashes the ring of the card it reached');
  // The run stopping cancels everything at once.
  const stopped = frame([{ ...LEAD, status: 'cancelled' }, stat('writer-ccc222', 'writer', { status: 'completed' })], done.view);
  page.dispatch(stopped.message);
  assert.equal(page.doc.getElementById('pulses')!.children.length, 0);
  assert.ok(page.doc.animations.filter((animation) => animation.options.duration === 900).every((animation) => animation.cancelled || animation === page.doc.animations[1] || animation === report));
});

test('page: under reduced motion nothing animates, and states and announcements still change', async () => {
  const page = await runPage({ reduced: true });
  const start = frame([LEAD]);
  page.dispatch(start.message);
  const handed = frame([LEAD, stat('writer-ccc111', 'writer', { task: 'Draft the brief' })], start.view);
  page.dispatch(handed.message);
  const done = frame([LEAD, stat('writer-ccc111', 'writer', { task: 'Draft the brief', status: 'completed' })], handed.view);
  page.dispatch(done.message);
  assert.equal(page.doc.animations.length, 0, 'no animation starts');
  assert.equal(page.doc.getElementById('pulses')!.children.length, 0);
  assert.match(page.doc.body.className, /\bcalm\b/, 'the breathing ring is off');
  assert.match(page.card('m:writer').textContent, /Done/);
  await page.settle();
  assert.match(page.doc.getElementById('announce')!.textContent, /Research handed writer a task: Draft the brief\. writer is done\./);
});

test('page: the Calm toggle stops all movement, is remembered, and says so', async () => {
  const page = await runPage();
  const start = frame([LEAD]);
  page.dispatch(start.message);
  const calm = page.doc.getElementById('calm')!;
  calm.click();
  assert.equal(calm.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(page.states.at(-1), { calm: true, list: false });
  assert.match(page.doc.body.className, /\bcalm\b/);
  page.dispatch(frame([LEAD, stat('writer-ccc111', 'writer')], start.view).message);
  assert.equal(page.doc.animations.length, 0);
  // Remembered: a page that opens with it on stays still.
  const remembered = await runPage({ state: { calm: true } });
  assert.equal(remembered.doc.getElementById('calm')!.getAttribute('aria-pressed'), 'true');
});

test('page: more hand-offs at once than it can show are dropped, never played late; at most six move together', async () => {
  const page = await runPage();
  const start = frame([LEAD]);
  page.dispatch(start.message);
  const many = Array.from({ length: 9 }, (_, index) => stat(`gsd-worker-${String(index).padStart(6, '0')}`, 'gsd-worker', { task: `Part ${index}` }));
  page.dispatch(frame([LEAD, ...many], start.view).message);
  assert.equal(page.doc.getElementById('pulses')!.children.length, 6, 'six pulses at once, the rest queued');
  const burst = Array.from({ length: 30 }, (_, index) => stat(`gsd-helper${index}-${String(index).padStart(6, '0')}`, `gsd-helper${index}`));
  page.dispatch(frame([LEAD, ...burst], start.view).message);
  assert.ok(page.doc.getElementById('pulses')!.children.length <= 6);
  await page.settle();
  assert.match(page.doc.getElementById('announce')!.textContent, /hand-offs at once; showing where everyone is now/);
});

test('page: the keyboard walks the tree, Enter opens a card with its controls, Escape closes it and returns focus', async () => {
  const page = await runPage();
  page.dispatch(frame([LEAD, stat('researcher-aaa111', 'researcher', { task: 'Find sources' }), stat('writer-ccc111', 'writer', { parentId: 'researcher-aaa111', phase: 'paused' })]).message);
  const lead = page.card('lead');
  lead.fire('keydown', { key: 'ArrowDown' });
  assert.equal(page.doc.activeElement, page.card('m:researcher'));
  page.card('m:researcher').fire('keydown', { key: 'ArrowRight' });
  assert.equal(page.doc.activeElement, page.card('m:writer'));
  page.card('m:writer').fire('keydown', { key: 'ArrowLeft' });
  assert.equal(page.doc.activeElement, page.card('m:researcher'));
  page.card('m:researcher').fire('keydown', { key: 'End' });
  assert.equal(page.doc.activeElement, page.card('m:reviewer'));
  page.card('m:reviewer').fire('keydown', { key: 'Home' });
  assert.equal(page.doc.activeElement, lead);
  assert.equal(page.cards().filter((node) => node.tabIndex === 0).length, 1);
  page.card('m:writer').fire('keydown', { key: 'Enter' });
  assert.deepEqual(page.posts.at(-1), { type: 'open-card', agentId: 'writer-ccc111' });
  const box = page.doc.getElementById('card')!;
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /writer · writer.*Paused.*Write the brief\. Report where it is\./);
  const resume = box.all().find((node) => node.tagName === 'button' && node.textContent === 'Resume')!;
  resume.click();
  assert.deepEqual(page.posts.at(-1), { type: 'agent-control', agentId: 'writer-ccc111', action: 'resume' });
  // The host sends the end of its reply while the card is open.
  page.dispatch({ ...frame([LEAD, stat('researcher-aaa111', 'researcher'), stat('writer-ccc111', 'writer', { parentId: 'researcher-aaa111', phase: 'paused' })]).message, excerpt: { agentId: 'writer-ccc111', text: 'Brief drafted.' } });
  assert.match(box.textContent, /End of its latest reply.*Brief drafted\./);
  page.card('m:writer').fire('keydown', { key: 'Escape' });
  assert.equal(box.hidden, true);
  assert.deepEqual(page.posts.at(-1), { type: 'open-card' });
  assert.equal(page.doc.activeElement, page.card('m:writer'));
});
