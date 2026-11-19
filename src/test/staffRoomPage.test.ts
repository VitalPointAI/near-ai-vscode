// The Staff Room page (WP-ROOM), run in a small DOM with the real map script: the host's picture drawn (rail states, squads, ledger, decisions, the J2
// registers from the fixture files), decision buttons that only post the product and version hash, messages from the host checked before anything is
// drawn, stillness under reduced motion and Calm, and the keyboard flow.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { handoffsFor } from '../domain/staff/staffRoom';
import type { StaffRoomModel } from '../domain/staff/staffRoom';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { modelOf, NOW, project } from './helpers/staffRoomFixture';

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

async function runPage(options: { reduced?: boolean; state?: Record<string, unknown>; theme?: string } = {}) {
  const doc = new FakeDoc(options.theme ?? 'vscode-dark');
  const posts: Array<Record<string, any>> = [];
  const states: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const window: Record<string, unknown> = { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener); } };
  const sandbox = vm.createContext({
    document: doc, window,
    matchMedia: (query: string) => ({ matches: Boolean(options.reduced) && /reduce/.test(query), addEventListener() {} }),
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, any>) => posts.push(JSON.parse(JSON.stringify(message))), getState: () => options.state, setState: (state: Record<string, unknown>) => states.push(JSON.parse(JSON.stringify(state))) }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimeout, setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval,
    JSON, Map, Set, Date, String, Number, Boolean, Object, Array, Math, RegExp
  });
  vm.runInContext(await readFile(path.join(MEDIA, 'staffMap.js'), 'utf8'), sandbox, { timeout: 1000 });
  vm.runInContext(await readFile(path.join(MEDIA, 'staffRoom.js'), 'utf8'), sandbox, { timeout: 1000 });
  const all = () => doc.body.all();
  const byClass = (cls: string) => all().filter((node) => node.classList.contains(cls));
  const byText = (text: string | RegExp) => all().filter((node) => (typeof text === 'string' ? node.textContent === text : text.test(node.textContent)) && node.tagName !== '#text');
  return { doc, posts, states, all, byClass, byText, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data: JSON.parse(JSON.stringify(data)) })) };
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
  const buttons = page.all().filter((node) => node.tagName === 'button' && node.getAttribute('data-action'));
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
  // J5, J3 and J4 say what is coming.
  const j3 = page.doc.getElementById('pane-j3')!;
  assert.match(j3.textContent, /Coming in drop 2/);
  assert.match(j3.textContent, /synchronization matrix/);
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
