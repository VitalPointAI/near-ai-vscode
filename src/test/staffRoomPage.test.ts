// The Staff Room page (WP-ROOM), run in a small DOM with the real map script: the host's picture drawn (rail states, squads, ledger, decisions, the J2
// registers from the fixture files), decision buttons that only post the product and version hash, messages from the host checked before anything is
// drawn, stillness under reduced motion and Calm, and the keyboard flow.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildCopPicture, syntheticGeography } from '../domain/staff/cop';
import type { CopPicture } from '../domain/staff/cop';
import { parseScenarioText } from '../domain/staff/scenario';
import { handoffsFor } from '../domain/staff/staffRoom';
import type { StaffRoomModel } from '../domain/staff/staffRoom';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { modelOf, NOW, project, SCENARIO, sectionsProject } from './helpers/staffRoomFixture';

const MEDIA = path.join(__dirname, '..', '..', 'media', 'staffRoom');

type Animation = { frames: unknown[]; options: Record<string, unknown>; onfinish?: () => void; cancel(): void; finish(): void };

class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(event: unknown) => void>>();
  style: Record<string, string> & { setProperty(name: string, value: string): void } = Object.assign(Object.create(null), { setProperty(this: Record<string, string>, name: string, value: string) { this[name] = value; } });
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = ''; selected = false; disabled = false; tabIndex = -1;
  offsetLeft = 0; offsetWidth = 80; clientWidth = 0;
  animations: Animation[] = [];
  private text = '';
  constructor(public tagName: string, private readonly doc: FakeDoc) {}
  get parentNode(): FakeNode | undefined { return this.parent; }
  get isConnected(): boolean { let node: FakeNode | undefined = this; while (node?.parent) node = node.parent; return node === this.doc.body; }
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
  // The DOM calls the COP map component (media/staff/copMap.js) uses.
  appendChild(child: FakeNode) { this.append(child); return child; }
  removeChild(child: FakeNode) { child.remove(); return child; }
  get firstChild(): FakeNode | undefined { return this.children[0]; }
  get lastChild(): FakeNode | undefined { return this.children[this.children.length - 1]; }
  get childNodes(): FakeNode[] { return this.children; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; } }
  replaceChildren(...nodes: FakeNode[]) { for (const child of this.children) child.parent = undefined; this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name: string) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string, event: Record<string, unknown> = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, ...event }); }
  click() { this.fire('click'); }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 90, bottom: 30, width: 80, height: 20 }; }
  animate(frames: unknown[], options: Record<string, unknown> = {}) {
    const animation: Animation = { frames, options, cancel() {}, finish() { this.onfinish?.(); } };
    this.animations.push(animation);
    this.doc.animations.push(animation);
    return animation;
  }
  all(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.all()]); }
}
class FakeDoc {
  body = new FakeNode('body', this);
  documentElement = { clientWidth: 1200 };
  activeElement: FakeNode | null = null;
  hidden = false;
  animations: Animation[] = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(theme: string) {
    this.body.className = theme;
    for (const id of ['app', 'announce', 'alert']) { const node = new FakeNode('div', this); node.id = id; this.body.append(node); }
  }
  getElementById(id: string) { return this.body.all().find((node) => node.id === id) ?? null; }
  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeNode(tag, this); }
  createTextNode(text: string) { const node = new FakeNode('#text', this); node.textContent = text; return node; }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  key(key: string, target?: FakeNode) { for (const listener of this.listeners.get('keydown') ?? []) listener({ key, target: target ?? this.activeElement ?? this.body, preventDefault() {} }); }
}

/** Timers the test drives by hand: each pending callback by its delay, run with fire(ms). */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => { next += 1; pending.set(next, { fn, ms }); return next; },
    clearTimeout: (id: number) => { pending.delete(id); },
    fire(ms: number) { for (const [id, timer] of [...pending]) if (timer.ms === ms) { pending.delete(id); timer.fn(); } }
  };
}

async function runPage(options: { reduced?: boolean; state?: Record<string, unknown>; theme?: string; window?: Record<string, unknown>; copMap?: boolean; styles?: Record<string, string>; timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: never) => void } } = {}) {
  const doc = new FakeDoc(options.theme ?? 'vscode-dark');
  const posts: Array<Record<string, any>> = [];
  const states: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const window: Record<string, unknown> = { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener); }, ...options.window };
  const sandbox = vm.createContext({
    document: doc, window,
    matchMedia: (query: string) => ({ matches: Boolean(options.reduced) && /reduce/.test(query), addEventListener() {} }),
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, any>) => posts.push(JSON.parse(JSON.stringify(message))), getState: () => options.state, setState: (state: Record<string, unknown>) => states.push(JSON.parse(JSON.stringify(state))) }),
    ...(options.timers ? { setTimeout: options.timers.setTimeout, clearTimeout: options.timers.clearTimeout } : { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimeout }), setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval,
    JSON, Map, Set, Date, String, Number, Boolean, Object, Array, Math, RegExp,
    ...(options.styles ? { getComputedStyle: () => ({ getPropertyValue: (name: string) => options.styles![name] ?? '' }) } : {})
  });
  // The page's order (staffRoomPanel.ts): the shared label placement, the COP map, the room's map, the room.
  vm.runInContext(await readFile(path.join(MEDIA, '..', 'staff', 'declutter.js'), 'utf8'), sandbox, { timeout: 1000 });
  if (options.copMap) vm.runInContext(await readFile(path.join(MEDIA, '..', 'staff', 'copMap.js'), 'utf8'), sandbox, { timeout: 1000 });
  vm.runInContext(await readFile(path.join(MEDIA, 'staffMap.js'), 'utf8'), sandbox, { timeout: 1000 });
  vm.runInContext(await readFile(path.join(MEDIA, 'staffWorkspaces.js'), 'utf8'), sandbox, { timeout: 1000 });
  vm.runInContext(await readFile(path.join(MEDIA, 'staffRoom.js'), 'utf8'), sandbox, { timeout: 1000 });
  const all = () => doc.body.all();
  const byClass = (cls: string) => all().filter((node) => node.classList.contains(cls));
  const byText = (text: string | RegExp) => all().filter((node) => (typeof text === 'string' ? node.textContent === text : text.test(node.textContent)) && node.tagName !== '#text');
  return {
    doc, window, posts, states, all, byClass, byText, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data: JSON.parse(JSON.stringify(data)) })),
    /** Sends the object as it is, without a structured clone, so a test can offer the page an inherited key. */
    dispatchRaw: (data: unknown) => listeners.forEach((listener) => listener({ data }))
  };
}

let fixture: { model: StaffRoomModel; cues: unknown[] } | undefined;
async function fixtureModel(): Promise<{ model: StaffRoomModel; cues: unknown[] }> {
  if (fixture) return fixture;
  const { world } = await project();
  const input = await loadStaffRoomInput(world.host, world.root, NOW);
  fixture = { model: await modelOf(world), cues: handoffsFor(input.settings, input.events, input.registry) };
  return fixture;
}

test('the page asks for the picture, then draws the rail, squads, ledger and decisions from the host\'s model', async () => {
  const { model } = await fixtureModel();
  const page = await runPage();
  assert.deepEqual(page.posts[0], { type: 'ready' });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  // Rail: one card per step, its status in words.
  const steps = page.byClass('step');
  assert.equal(steps.length, model.rail.length);
  assert.ok(steps[0].classList.contains('s-done'));
  assert.ok(steps[2].classList.contains('s-waiting'));
  assert.match(steps[2].getAttribute('aria-label')!, /Waiting for a named person/);
  assert.ok(steps.find((step) => step.dataset.step === '6')!.classList.contains('human'));
  // Squads: five pods, a working token with its state in words, the person from the ledger in gold.
  assert.equal(page.byClass('pod').length, 5);
  const token = page.all().find((node) => node.dataset.token === 'j2:threat-analyst')!;
  assert.ok(token.classList.contains('s-working'));
  assert.match(token.getAttribute('aria-label')!, /working: Drafting Adversary coa set/);
  assert.ok(page.byClass('person').some((node) => node.textContent === 'R. Example (J5 director)'));
  // Ledger: a row per product with the state machine's words.
  assert.equal(page.byClass('prod').length, model.ledger.length);
  assert.ok(page.byClass('st-pill').some((node) => node.textContent === 'awaiting decision'));
  // Decisions: gold, counted, with the dissent unedited.
  assert.equal(page.byClass('n')[0].textContent, String(model.decisions.length));
  assert.ok(page.byText('The red team holds COA 2 is safer.').length > 0);
  assert.ok(page.byText(/Exercise IRON LANTERN/).length > 0);
});

test('a decision button posts only the product and the version hash; the page never shows a decision before the ledger does', async () => {
  const { model } = await fixtureModel();
  const page = await runPage();
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const decide = model.decisions.find((card) => card.kind === 'decide')!;
  // The room's decisions panel (each section workspace shows its own cards too; see the workspace tests).
  const buttons = page.byClass('decide')[0].all().filter((node) => node.tagName === 'button' && node.getAttribute('data-action'));
  assert.deepEqual(buttons.map((node) => node.getAttribute('data-action')).sort(), ['approve', 'reject', 'release']);
  const approve = buttons.find((node) => node.getAttribute('data-action') === 'approve')!;
  approve.click();
  assert.deepEqual(page.posts.at(-1), { type: 'decide', action: 'approve', product: decide.product, hash: decide.hash });
  // Not optimistic: the card stays, the button says to confirm in VS Code, and the pill still reads awaiting decision.
  assert.equal(approve.textContent, 'Confirm in VS Code…');
  assert.ok(page.byClass('st-pill').some((node) => node.textContent === 'awaiting decision'));
  // Every message the page can send is one the host's validator accepts, and none names a command.
  const kinds = new Set(page.posts.map((post) => post.type));
  assert.ok([...kinds].every((kind) => ['ready', 'decide', 'open', 'open-product', 'select-run'].includes(kind)));
  assert.ok(page.posts.every((post) => !('command' in post)));
});

test('a newer notice keeps its own 6 seconds: the older notice\'s hide timer is cleared, not left to hide it early', async () => {
  const timers = manualTimers();
  const page = await runPage({ timers });
  const toast = () => page.byClass('toast')[0];
  page.dispatch({ type: 'notice', text: 'First notice' });
  assert.equal(toast().hidden, false);
  assert.equal([...timers.pending.values()].filter((timer) => timer.ms === 6000).length, 1);
  page.dispatch({ type: 'notice', text: 'Second notice' });
  assert.equal([...timers.pending.values()].filter((timer) => timer.ms === 6000).length, 1, 'the first notice\'s timer was cleared');
  assert.equal(toast().textContent, 'Second notice');
  timers.fire(6000);
  assert.equal(toast().hidden, true, 'the second notice hides after its own 6 seconds');
  page.dispatch({ type: 'notice', text: 'Third notice' });
  assert.equal(toast().hidden, false, 'a notice after one has hidden shows again');
});

test('a message from the host that does not fit the model is ignored', async () => {
  const { model } = await fixtureModel();
  const page = await runPage();
  page.dispatch({ type: 'staff-room', model: { ...model, v: 2 } });
  page.dispatch({ type: 'staff-room', model: { ...model, decisions: [{ product: 'x', hash: 1, kind: 'approve-now' }] } });
  page.dispatch({ type: 'staff-room', model: null });
  assert.equal(page.byClass('step').length, 0);
  page.dispatch({ type: 'staff-room', model, cues: [{ kind: 'run', from: 'x', to: 'y', label: 'z', workspace: 'j2' }] });
  assert.equal(page.byClass('step').length, model.rail.length);
});

test('the J2 workspace shows the threat picture, PIRs linked to decision points, collection, sources and watches from the fixtures', async () => {
  const { model } = await fixtureModel();
  const page = await runPage({ state: { workspace: 'j2' } });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const pane = page.doc.getElementById('pane-j2')!;
  assert.equal(pane.hidden, false);
  assert.equal(page.doc.getElementById('pane-war-room')!.hidden, true);
  const text = pane.textContent;
  for (const expected of ['MLCOA', 'MDCOA', 'Likely (55 to 80 percent).', 'We have moderate confidence in this judgement because two independent origins report the positions.', '1-41 MECH', 'B2',
    'PIR-1', 'Supports DP 2: commit the reserve', 'NAI 2', 'Needs a partner', 'The J2 recommends; the J3 approves', 'SRC-1', 'WATCH-1', 'no person has the staff run open', 'Alerts K. Sample (J2)']) {
    assert.ok(text.includes(expected), `the J2 workspace shows ${expected}`);
  }
  // The map is in the J2 workspace, with hostile diamonds, the adversary axes and the frame's grid.
  assert.ok(page.byClass('mapbox')[0].parent === page.doc.getElementById('pane-j2')!.all().find((node) => node.classList.contains('mapslot')));
  assert.ok(page.byClass('aff-H').length >= 5);
  assert.equal(page.byClass('ax').length, 2);
  assert.ok(page.byClass('glab').some((node) => /^KQ \d\d$/.test(node.textContent)));
  // Map as table: every unit in words.
  page.doc.key('m', page.doc.body);
  assert.ok(page.byClass('listview')[0].hidden === false);
  assert.ok(page.byClass('listview')[0].textContent.includes('Hostile'));
  // J5, J3 and J4 are workspaces of their own now, with nothing to say they are coming.
  for (const id of ['j5', 'j3', 'j4']) assert.doesNotMatch(page.doc.getElementById(`pane-${id}`)!.textContent, /Coming in drop 2|drop 2/);
});

test('under reduced motion, nothing moves: no animations, and hand-offs are still links with words', async () => {
  const { model, cues } = await fixtureModel();
  assert.ok(cues.length > 0);
  const page = await runPage({ reduced: true });
  page.dispatch({ type: 'staff-room', model, cues });
  assert.equal(page.doc.animations.length, 0);
  assert.ok(page.all().some((node) => node.classList.contains('still-link')));
  assert.equal(page.byClass('comet').length, 0);
  assert.ok(page.byClass('callout').some((node) => node.textContent.length > 0), 'status lines appear whole');
});

test('with motion, the room wakes up and hand-offs travel; Calm stops all of it', async () => {
  const { model, cues } = await fixtureModel();
  const page = await runPage();
  page.dispatch({ type: 'staff-room', model, cues });
  assert.ok(page.doc.animations.length > 10, 'the rail, squads and map animate in');
  assert.ok(page.byClass('comet').length > 0, 'a hand-off travels');
  const calm = page.byText('Calm').find((node) => node.tagName === 'button')!;
  calm.click();
  assert.equal(calm.getAttribute('aria-pressed'), 'true');
  assert.ok(page.doc.getElementById('app')!.classList.contains('calm'));
  const before = page.doc.animations.length;
  page.dispatch({ type: 'staff-room', model: { ...model, now: model.now + 1 }, cues });
  assert.equal(page.doc.animations.length, before);
  assert.equal(page.states.at(-1)!.calm, true);
});

test('themes follow VS Code and cycle night, day and high contrast', async () => {
  const { model } = await fixtureModel();
  const light = await runPage({ theme: 'vscode-light' });
  light.dispatch({ type: 'staff-room', model, cues: [] });
  assert.ok(light.doc.getElementById('app')!.classList.contains('day'));
  const hc = await runPage({ theme: 'vscode-high-contrast' });
  assert.ok(hc.doc.getElementById('app')!.classList.contains('hc'));
  hc.doc.key('t', hc.doc.body);
  assert.ok(hc.doc.getElementById('app')!.classList.contains('night'));
});

test('keyboard flow: workspaces by number and arrows, D to the decision, arrows along the rail, Escape closes a card', async () => {
  const { model } = await fixtureModel();
  const page = await runPage({ state: { follow: true } });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  page.doc.key('2', page.doc.body);
  assert.equal(page.doc.getElementById('pane-j2')!.hidden, false);
  assert.equal(page.doc.activeElement!.id, 'tab-j2');
  assert.equal(page.states.at(-1)!.follow, false, 'choosing a workspace turns Follow the action off');
  page.doc.activeElement!.fire('keydown', { key: 'ArrowRight' });
  assert.equal(page.doc.activeElement!.id, 'tab-j5');
  assert.equal(page.doc.getElementById('pane-j5')!.hidden, false);
  page.doc.key('d', page.doc.body);
  assert.equal(page.doc.activeElement!.getAttribute('data-action'), 'approve');
  const steps = page.byClass('step');
  const current = steps.find((step) => step.tabIndex === 0)!;
  current.focus();
  current.fire('keydown', { key: 'ArrowRight' });
  assert.equal(page.doc.activeElement!.dataset.step, String(Number(current.dataset.step) + 1));
  // A ledger row opens its provenance; Escape closes it and gives focus back.
  const row = page.byClass('prod')[0];
  row.click();
  const pop = page.byClass('pop')[0];
  assert.equal(pop.hidden, false);
  assert.match(pop.textContent, /History, newest first/);
  page.doc.key('Escape', page.doc.body);
  assert.equal(pop.hidden, true);
  assert.equal(page.doc.activeElement, row);
  // Single-key shortcuts can be turned off (WCAG 2.1.4).
  page.doc.key('?', page.doc.body);
  page.byText('Single-key shortcuts: on').find((node) => node.tagName === 'button')!.click();
  page.doc.key('Escape', page.doc.body);
  page.doc.key('1', page.doc.body);
  assert.equal(page.doc.getElementById('pane-war-room')!.hidden, true);
});

test('Follow the action moves to the workspace where the work is', async () => {
  const { model } = await fixtureModel();
  const page = await runPage({ reduced: true, state: { workspace: 'war-room', follow: true } });
  page.dispatch({ type: 'staff-room', model, cues: [{ kind: 'task', from: 'section:command', to: 'member:j2:threat-analyst', label: 'Adversary coa set', workspace: 'j2' }] });
  assert.equal(page.doc.getElementById('pane-j2')!.hidden, false);
  const quiet = await runPage({ reduced: true, state: { workspace: 'war-room', follow: false } });
  quiet.dispatch({ type: 'staff-room', model, cues: [{ kind: 'task', from: 'section:command', to: 'member:j2:threat-analyst', label: 'Adversary coa set', workspace: 'j2' }] });
  assert.equal(quiet.doc.getElementById('pane-j2')!.hidden, true);
  assert.ok(quiet.doc.getElementById('tab-j2')!.classList.contains('live'), 'a dot says something is happening there');
});

// ---- The map: the COP map when it can run, the SVG map with the reason when it cannot, and labels that never cover each other ----------------

async function ironLanternPicture(): Promise<CopPicture> {
  const parsed = parseScenarioText(await readFile(SCENARIO, 'utf8'));
  assert.ok(parsed.ok);
  return buildCopPicture({ marking: parsed.value.marking, frame: parsed.value.region.frame, geography: syntheticGeography(parsed.value), scenario: parsed.value, layers: [] });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A stand-in for window.nearCopMap that answers with the renderer it is given and records every call through the interface. */
function fakeCopMap(renderer: 'maplibre' | 'svg', reason?: string) {
  const calls: Array<[string, ...unknown[]]> = [];
  const api = {
    version: 1,
    mount: async (_container: unknown, options: Record<string, any>) => {
      calls.push(['mount', { renderer: options.renderer, still: options.still, nonce: options.nonce, hasClock: typeof options.clock?.now === 'function' && typeof options.clock?.set === 'function' }]);
      return {
        renderer, reason,
        setPicture: (picture: { version: number }) => calls.push(['setPicture', picture.version]),
        setLayerVisible: (id: string, on: boolean) => calls.push(['setLayerVisible', id, on]),
        highlight: (names: string[]) => calls.push(['highlight', [...names]]),
        setColours: () => calls.push(['setColours']),
        focus: () => calls.push(['focus']),
        destroy: () => calls.push(['destroy'])
      };
    }
  };
  return { api, calls, count: (name: string) => calls.filter((call) => call[0] === name).length };
}

test('the room mounts the COP map through its interface when it can run, and sends it the picture only when it changed', async () => {
  const { model } = await fixtureModel();
  const picture = await ironLanternPicture();
  const cop = fakeCopMap('maplibre');
  const page = await runPage({ state: { workspace: 'j2', hiddenLayers: ['cop-plans-layer'] }, window: { nearCopMap: cop.api }, styles: { '--map-sea': '#0A1830', '--map-ink': '#E8EEF7' } });
  page.dispatch({ type: 'staff-room', model, cues: [], picture, pictureNow: NOW });
  await settle();
  assert.deepEqual(cop.calls[0], ['mount', { renderer: 'auto', still: true, nonce: undefined, hasClock: true }], 'mounted still (no label fades), with the room\'s clock');
  const box = page.byClass('mapbox')[0];
  assert.ok(box.classList.contains('has-cop'), 'the COP map replaces the SVG map');
  assert.equal(page.byClass('copslot')[0].hidden, false);
  assert.equal(page.byClass('mapnote')[0].hidden, true, 'no fallback line while the COP map runs');
  assert.equal(cop.count('setPicture'), 1);
  assert.ok(cop.calls.some((call) => call[0] === 'setLayerVisible' && call[1] === 'cop-plans-layer' && call[2] === false), 'a layer the person hid stays hidden');
  // The model again without a picture (unchanged): nothing is sent to the map; a changed picture is.
  page.dispatch({ type: 'staff-room', model: { ...model, now: model.now + 1 }, cues: [], pictureNow: NOW + 1 });
  await settle();
  assert.equal(cop.count('setPicture'), 1);
  page.dispatch({ type: 'staff-room', model, cues: [], picture: { ...picture, marking: 'EXERCISE' }, pictureNow: NOW + 2 });
  await settle();
  assert.equal(cop.count('setPicture'), 2);
  // A picture that does not fit is never passed on.
  page.dispatch({ type: 'staff-room', model, cues: [], picture: { ...picture, version: 2 } });
  await settle();
  assert.equal(cop.count('setPicture'), 2);
  // A PIR card points at its NAIs on the COP map too.
  const pirCard = page.byClass('pir').find((node) => node.listeners.has('mouseenter'))!;
  pirCard.fire('mouseenter');
  const lit = cop.calls.filter((call) => call[0] === 'highlight').at(-1)!;
  assert.ok((lit[1] as string[]).some((name) => /^NAI /.test(name)), 'the highlight reaches the COP map');
  // Map as table still works, and hides the map from assistive tech.
  page.doc.key('m', page.doc.body);
  assert.equal(page.byClass('listview')[0].hidden, false);
  assert.equal(page.byClass('copslot')[0].getAttribute('aria-hidden'), 'true');
  page.doc.key('m', page.doc.body);
  assert.equal(page.byClass('copslot')[0].getAttribute('aria-hidden'), 'false');
  // The theme reaches the map.
  const before = cop.count('setColours');
  page.doc.key('t', page.doc.body);
  assert.equal(cop.count('setColours'), before + 1);
});

test('without WebGL or the library the room keeps its SVG map and says why', async () => {
  const { model } = await fixtureModel();
  const picture = await ironLanternPicture();
  const cop = fakeCopMap('svg', 'WebGL is not available in this window');
  const page = await runPage({ state: { workspace: 'j2' }, window: { nearCopMap: cop.api } });
  page.dispatch({ type: 'staff-room', model, cues: [], picture, pictureNow: NOW });
  await settle();
  assert.equal(cop.count('destroy'), 1, 'the component\'s own fallback is let go');
  assert.ok(!page.byClass('mapbox')[0].classList.contains('has-cop'));
  assert.equal(page.byClass('mapnote')[0].hidden, false);
  assert.equal(page.byClass('mapnote')[0].textContent, '2D map: WebGL is not available in this window.');
  assert.ok(page.byClass('aff-H').length >= 5, 'the SVG map is drawn');
  // Later pictures do not try again.
  page.dispatch({ type: 'staff-room', model, cues: [], picture: { ...picture, marking: 'X' }, pictureNow: NOW });
  await settle();
  assert.equal(cop.count('mount'), 1);

  // The real component in a window with no WebGL: the same fallback, with its reason.
  const real = await runPage({ state: { workspace: 'j2' }, copMap: true });
  real.dispatch({ type: 'staff-room', model, cues: [], picture, pictureNow: NOW });
  await settle();
  assert.match(real.byClass('mapnote')[0].textContent, /^2D map: WebGL is not available in this window\.$/);
  assert.equal(real.byClass('copslot')[0].children.length, 0, 'nothing of the component is left behind');
  assert.ok(real.byClass('aff-H').length >= 5);

  // No component script at all, and a picture the host could not build.
  const none = await runPage({ state: { workspace: 'j2' } });
  none.dispatch({ type: 'staff-room', model, cues: [], pictureProblem: 'the COP picture could not be read (bad layer)', pictureNow: NOW });
  assert.equal(none.byClass('mapnote')[0].textContent, '2D map: the COP picture could not be read (bad layer).');
  none.dispatch({ type: 'staff-room', model, cues: [], picture, pictureNow: NOW });
  await settle();
  assert.equal(none.byClass('mapnote')[0].textContent, '2D map: the COP map script did not load.');
});

test('the SVG map places every name label so no two overlap near Port Calder, and keeps every symbol (IRON LANTERN)', async () => {
  const { model } = await fixtureModel();
  const page = await runPage();
  const api = page.window.NearAiStaffMap as { create: (container: unknown, options: unknown) => Record<string, any> };
  const container = page.doc.createElement('div');
  const map = api.create(container, {});
  map.render(model.map, { mode: 'war-room' });
  type Placed = { id: string; layer?: string; hidden: boolean; text?: string; box?: { x: number; y: number; w: number; h: number }; usual?: boolean };
  const labels = JSON.parse(JSON.stringify(map.labels())) as Placed[];
  const placed = labels.filter((label) => !label.hidden);
  const overlap = (a: Placed['box'], b: Placed['box']) => a!.x < b!.x + b!.w && b!.x < a!.x + a!.w && a!.y < b!.y + b!.h && b!.y < a!.y + a!.h;
  for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) assert.ok(!overlap(placed[i].box, placed[j].box), `${placed[i].id} (${placed[i].text}) and ${placed[j].id} (${placed[j].text}) overlap`);
  // Near the port the usual spots collide, so the pass had work to do there, and the port keeps its name.
  const port = model.map.features.find((feature) => feature.name === 'Port Calder')!.points[0];
  const near = placed.filter((label) => Math.hypot(label.box!.x + label.box!.w / 2 - port[0], label.box!.y + label.box!.h / 2 - port[1]) < 40);
  assert.ok(near.length >= 3, `${near.length} labels near Port Calder`);
  assert.ok(labels.some((label) => label.hidden || label.usual === false), 'at least one label moved, was shortened or was hidden');
  assert.ok(placed.some((label) => label.text === 'Port Calder'), 'Port Calder keeps its name');
  // Every unit keeps its symbol and its name in words, even when its label had to go.
  const symbols = container.all().filter((node: FakeNode) => node.classList.contains('sym'));
  assert.equal(symbols.length, model.map.units.length);
  for (const unit of model.map.units) assert.ok(symbols.some((node: FakeNode) => (node.getAttribute('aria-label') ?? '').includes(unit.designation)), unit.designation);
  // Hiding a layer frees its room: the placement runs again and still nothing overlaps.
  map.setLayer('cop-threat-layer', false);
  const again = (JSON.parse(JSON.stringify(map.labels())) as Placed[]).filter((label) => !label.hidden);
  assert.ok(again.every((label) => label.layer !== 'cop-threat-layer'));
  for (let i = 0; i < again.length; i += 1) for (let j = i + 1; j < again.length; j += 1) assert.ok(!overlap(again[i].box, again[j].box));
  // The same model places the same way every time.
  const second = api.create(page.doc.createElement('div'), {});
  second.render(model.map, { mode: 'war-room' });
  assert.deepEqual(JSON.parse(JSON.stringify(second.labels())), labels);
});

test('a status line that is still typing stops when its node leaves the page', async () => {
  const { model } = await fixtureModel();
  const page = await runPage();
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const callout = page.byClass('callout').find((node) => node.parentNode !== undefined)!;
  assert.ok(callout, 'a squad callout is drawn');
  callout.remove();
  const frozen = callout.textContent;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(callout.textContent, frozen, 'no writes into a detached node');
  // A connected callout still finishes typing its summary.
  const live = page.byClass('callout')[0];
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(live.textContent.length > 0);
});

// ---- The J5, J3 and J4 workspaces (owner direction 2026-11-19) ----------------------------------------------------------------------------------

let sectionsFixture: { model: StaffRoomModel; cues: unknown[] } | undefined;
async function sectionsModel(): Promise<{ model: StaffRoomModel; cues: unknown[] }> {
  if (sectionsFixture) return sectionsFixture;
  const { world } = await sectionsProject();
  const input = await loadStaffRoomInput(world.host, world.root, NOW);
  sectionsFixture = { model: await modelOf(world), cues: handoffsFor(input.settings, input.events, input.registry) };
  return sectionsFixture;
}
const view = (page: Awaited<ReturnType<typeof runPage>>, id: string) => page.doc.getElementById(id)!;

test('each section workspace draws its real state from the host\'s model: products, people\'s decisions in gold, agent work in violet, and its own views', async () => {
  const { model } = await sectionsModel();
  const page = await runPage({ state: { workspace: 'j5' } });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const j5 = view(page, 'pane-j5');
  assert.equal(j5.hidden, false);
  for (const expected of ['COA A', 'Seize Port Calder from the sea', 'risk: lift for the second wave is short by one day', 'fail: no sustainment outline yet',
    'Criteria and weights approved by C. Example (commander)', 'Weighted total (recomputed)', '19', '17', 'coa-a', 'against', 'mlcoa', 'Next: turn 1 COUNTERACTION', 'DP2: Commit the reserve (decides: commander)',
    'Staff recommendation, drafted by agents', 'The staff recommends COA A', 'The red team holds COA B is safer: the beach defences are unknown.', 'Who decides: the commander.',
    'Annex D', 'not released', 'Coa decision brief v1']) assert.ok(j5.textContent.includes(expected), `the J5 workspace shows ${expected}`);
  // Gold: the section's decisions with the buttons only a person can press; violet: the agents' work, labelled as agent work.
  const strip = j5.all().find((node) => node.classList.contains('ws-decide'))!;
  assert.equal(strip.hidden, false);
  assert.ok(strip.all().some((node) => node.getAttribute('data-action') === 'approve'));
  assert.ok(j5.all().some((node) => node.classList.contains('recommend')), 'the recommendation is marked as agents\' work');
  assert.ok(j5.all().some((node) => node.classList.contains('ws-activity') && node.textContent.includes('coa-cell-a')));
  assert.ok(j5.all().some((node) => node.classList.contains('human-line') && /approved by C\. Example/.test(node.textContent)));
  const best = j5.all().find((node) => node.classList.contains('best'))!;
  assert.equal(best.getAttribute('aria-label'), 'COA A total 19, the highest');

  const j3 = view(page, 'pane-j3');
  for (const expected of ['E1', 'escalated', 'CCIR PIR-1', 'Two armoured vehicles moving off the south slope', 'CCIR PIR-1 reported as triggered by joc-chief', 'DP-2', 'Decides: commander', 'trigger reported',
    'while planning. It passes to the', 'manoeuvre', 'H+6', 'Frago 1', 'Commander\'s update brief', 'RFI-7', 'Past its suspense']) assert.ok(j3.textContent.includes(expected), `the J3 workspace shows ${expected}`);
  const j4 = view(page, 'pane-j4');
  for (const expected of ['1 Bn', 'Red', '2 Bn (bn2-191000z): failed rule 1', 'calc:fuel-phase-1', '3,500 per day', 'Bridging stock', 'lift short', 'generator', 'Data older than a day',
    'Not supportable', 'not vouched for by the calculator ledger', 'Logistics annex', 'Annex D, drafting']) assert.ok(j4.textContent.includes(expected), `the J4 workspace shows ${expected}`);
  const formulas = j4.all().filter((node) => node.classList.contains('formula'));
  assert.equal(formulas.length, 3, 'each calculator result shows its formula');
  assert.ok(formulas.some((node) => /250/.test(node.textContent)), 'with the factor a person entered');
  // Tabs carry each section's own state in words, gold when a person is needed there.
  assert.match(view(page, 'tab-j3').textContent, /1 for a person/);
  assert.ok(view(page, 'tab-j3').classList.contains('needs'));
  assert.match(view(page, 'tab-j4').textContent, /J-?4/);
});

test('a decision button in a section workspace posts only the product and the version hash, the same as the room\'s decisions panel', async () => {
  const { model } = await sectionsModel();
  const page = await runPage({ state: { workspace: 'j3', wsTabs: { j3: 'fragos' } } });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const frago = model.decisions.find((card) => card.product === 'frago-1')!;
  const fragos = view(page, 'j3panel-fragos');
  assert.equal(fragos.hidden, false);
  const approve = fragos.all().find((node) => node.getAttribute('data-action') === 'approve')!;
  approve.click();
  assert.deepEqual(page.posts.at(-1), { type: 'decide', action: 'approve', product: 'frago-1', hash: frago.hash });
  assert.equal(approve.textContent, 'Confirm in VS Code…', 'not optimistic: it waits for the signed command');
  const brief = model.decisions.find((card) => card.product === 'coa-decision-brief')!;
  const reject = view(page, 'pane-j5').all().find((node) => node.classList.contains('ws-decide'))!.all().filter((node) => node.getAttribute('data-action') === 'reject')
    .find((node) => node.parent?.parent?.dataset.product === 'coa-decision-brief')!;
  reject.click();
  assert.deepEqual(page.posts.at(-1), { type: 'decide', action: 'reject', product: 'coa-decision-brief', hash: brief.hash });
  for (const post of page.posts.filter((entry) => entry.type === 'decide')) assert.deepEqual(Object.keys(post).sort(), ['action', 'hash', 'product', 'type']);
});

test('the section workspaces are still under reduced motion and Calm, and move with motion', async () => {
  const { model } = await sectionsModel();
  for (const workspace of ['j5', 'j3', 'j4']) {
    const reduced = await runPage({ reduced: true, state: { workspace } });
    reduced.dispatch({ type: 'staff-room', model, cues: [] });
    assert.equal(reduced.doc.animations.length, 0, `${workspace} under reduced motion`);
    const calm = await runPage({ state: { workspace, calm: true } });
    calm.dispatch({ type: 'staff-room', model, cues: [] });
    view(calm, `${workspace}tab-${workspace === 'j5' ? 'compare' : workspace === 'j3' ? 'sync' : 'calcs'}`).click();
    assert.equal(calm.doc.animations.length, 0, `${workspace} in Calm`);
  }
  const moving = await runPage({ state: { workspace: 'j5' } });
  moving.dispatch({ type: 'staff-room', model, cues: [] });
  assert.ok(moving.doc.animations.some((animation) => JSON.stringify(animation.frames).includes('scaleX(0)')), 'the comparison bars grow in');
  assert.ok(moving.doc.animations.every((animation) => animation.frames.every((frame) => Object.keys(frame as object).every((key) => ['opacity', 'transform', 'strokeDashoffset'].includes(key)))), 'only transform, opacity and stroke-dashoffset animate');
});

test('keyboard: number keys reach each section, arrows move between workspaces and between a workspace\'s views, Home and End go to the ends', async () => {
  const { model } = await sectionsModel();
  const page = await runPage();
  page.dispatch({ type: 'staff-room', model, cues: [] });
  for (const [key, id] of [['3', 'j5'], ['4', 'j3'], ['5', 'j4']]) {
    page.doc.key(key, page.doc.body);
    assert.equal(page.doc.activeElement!.id, `tab-${id}`);
    assert.equal(view(page, `pane-${id}`).hidden, false);
  }
  page.doc.activeElement!.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(page.doc.activeElement!.id, 'tab-j3');
  // Inside the J3 workspace: the views are one tab stop, arrows move along them, and each panel follows.
  const first = view(page, 'j3tab-current');
  assert.equal(first.tabIndex, 0);
  assert.equal(view(page, 'j3tab-dsm').tabIndex, -1);
  first.focus();
  first.fire('keydown', { key: 'ArrowRight' });
  assert.equal(page.doc.activeElement!.id, 'j3tab-dsm');
  assert.equal(view(page, 'j3panel-dsm').hidden, false);
  assert.equal(view(page, 'j3panel-current').hidden, true);
  page.doc.activeElement!.fire('keydown', { key: 'End' });
  assert.equal(page.doc.activeElement!.id, 'j3tab-rhythm');
  page.doc.activeElement!.fire('keydown', { key: 'Home' });
  assert.equal(page.doc.activeElement!.id, 'j3tab-current');
  assert.equal(page.states.at(-1)!.wsTabs && (page.states.at(-1)!.wsTabs as Record<string, string>).j3, 'current', 'the view chosen is remembered');
  // Every view has its name, and every tab names its panel.
  for (const [id, tab] of [['j5', 'cells'], ['j3', 'sync'], ['j4', 'logstat']]) {
    const node = view(page, `${id}tab-${tab}`);
    assert.equal(node.getAttribute('role'), 'tab');
    assert.equal(view(page, node.getAttribute('aria-controls')!).getAttribute('aria-labelledby'), node.id);
  }
  // The COP map goes with the J3 workspace's current operations view.
  page.doc.key('4', page.doc.body);
  assert.ok(page.byClass('mapbox')[0].parent === view(page, 'pane-j3').all().find((node) => node.classList.contains('ws-map')));
});

test('the host can open the room on a workspace; a message with an extra, missing or inherited key, or an unknown workspace, is refused', async () => {
  const { model } = await sectionsModel();
  const page = await runPage({ reduced: true, state: { workspace: 'war-room' } });
  page.dispatch({ type: 'staff-room', model, cues: [] });
  const shown = () => ['war-room', 'j2', 'j5', 'j3', 'j4'].find((id) => !view(page, `pane-${id}`).hidden);
  page.dispatch({ type: 'show-workspace', workspace: 'j4', extra: true });
  page.dispatch({ type: 'show-workspace' });
  page.dispatch({ type: 'show-workspace', workspace: 'j9' });
  page.dispatch({ type: 'show-workspace', workspace: ['j4'] });
  page.dispatchRaw(Object.assign(Object.create({ workspace: 'j4' }), { type: 'show-workspace' }));
  assert.equal(shown(), 'war-room');
  page.dispatch({ type: 'show-workspace', workspace: 'j4' });
  assert.equal(shown(), 'j4');
  // A picture without the section workspaces is not drawn at all.
  const before = page.byClass('step').length;
  const { j4: _drop, ...partial } = model;
  void _drop;
  const fresh = await runPage();
  fresh.dispatch({ type: 'staff-room', model: partial });
  fresh.dispatch({ type: 'staff-room', model: { ...model, j3: { ...model.j3, eventLog: null } } });
  assert.equal(fresh.byClass('step').length, 0);
  assert.ok(before > 0);
});

test('large registers stay fast: lists show a page at a time with the rest one press away, and the page holds no demo data', async () => {
  const { model } = await sectionsModel();
  const rows = Array.from({ length: 200 }, (_, n) => ({ id: `E${n}`, time: '2026-11-19T11:00:00Z', source: 'watch', report: `Report ${n}`, ccir: '', decisionPoint: '', status: 'logged' }));
  const big = { ...model, j3: { ...model.j3, eventLog: { total: 450, escalated: 0, rows } } };
  const page = await runPage({ reduced: true, state: { workspace: 'j3' } });
  page.dispatch({ type: 'staff-room', model: big, cues: [] });
  const log = () => view(page, 'pane-j3').all().filter((node) => node.classList.contains('ev'));
  assert.equal(log().length, 40);
  const more = view(page, 'pane-j3').all().find((node) => node.tagName === 'button' && /^Show 40 more of 160$/.test(node.textContent))!;
  more.click();
  assert.equal(log().length, 80);
  // The workspace script draws only what the host sends: no exercise names, units or places of its own.
  const source = await readFile(path.join(MEDIA, 'staffWorkspaces.js'), 'utf8');
  assert.doesNotMatch(source, /IRON LANTERN|Port Calder|Harrow|Brenn|1-41|3-41|PIR-\d|DP ?-?\d|calc:[a-z]/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  // An empty project: each workspace says what would fill it.
  const empty = await runPage({ reduced: true, state: { workspace: 'j4' } });
  const blank = { ...model, decisions: [], j5: { ...model.j5, cells: [], products: [], activity: [] }, j3: { ...model.j3, fragos: [], eventLog: { total: 0, escalated: 0, rows: [] } }, j4: { ...model.j4, calcs: [], logstat: { reports: 0, units: [], heldOut: [] } } };
  empty.dispatch({ type: 'staff-room', model: blank, cues: [] });
  assert.match(view(empty, 'pane-j4').textContent, /No LOGSTAT yet/);
  assert.match(view(empty, 'pane-j5').textContent, /No COA cells yet/);
  assert.match(view(empty, 'pane-j3').textContent, /No FRAGO drafts/);
});
