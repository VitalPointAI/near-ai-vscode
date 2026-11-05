// A fake DOM and webview harness for node:vm tests of the media/board scripts (62-09 to 62-13). It is generic on purpose: the element tree, attributes,
// selectors, event dispatch with bubbling, keyboard and drag events, focus tracking, ResizeObserver and matchMedia stubs, timers under test control and
// acquireVsCodeApi with getState and setState, so the later board scripts add tests without editing this file. Like the real page, its elements throw
// when markup is assigned or inserted: the board must write text only (T-62-32).
// The sidebar's media/chat scripts load through the same harness (scripts: 'chat'), with an optional section#team and a nearChat stub (61-17).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

export type Listener = (event: FakeEvent) => void;

export class FakeEvent {
  [key: string]: any;
  type: string;
  bubbles: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false && !['focus', 'blur'].includes(type);
    Object.assign(this, init);
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

// ---- selectors -------------------------------------------------------------------------------------------------------------------------------

type Simple = { k: 'tag' | 'id' | 'class'; v: string } | { k: 'attr'; name: string; op?: string; v?: string } | { k: 'not'; inner: Simple[] };
interface Step { combinator: ' ' | '>' | ''; compound: Simple[] }

function parseCompound(text: string): Simple[] {
  const out: Simple[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    if (ch === '#' || ch === '.') {
      const m = /^[#.]([\w-]+)/.exec(rest);
      if (m === null) throw new Error(`unsupported selector ${text}`);
      out.push({ k: ch === '#' ? 'id' : 'class', v: m[1] });
      i += m[0].length;
    } else if (ch === '[') {
      const end = text.indexOf(']', i);
      const m = /^([\w:-]+)(?:([~|^$*]?=)"?([^"]*)"?)?$/.exec(text.slice(i + 1, end));
      if (m === null) throw new Error(`unsupported selector ${text}`);
      out.push({ k: 'attr', name: m[1], ...(m[2] === undefined ? {} : { op: m[2], v: m[3] }) });
      i = end + 1;
    } else if (rest.startsWith(':not(')) {
      const end = text.indexOf(')', i);
      out.push({ k: 'not', inner: parseCompound(text.slice(i + 5, end)) });
      i = end + 1;
    } else if (ch === '*') {
      i += 1;
    } else {
      const m = /^[\w-]+/.exec(rest);
      if (m === null) throw new Error(`unsupported selector ${text}`);
      out.push({ k: 'tag', v: m[0].toLowerCase() });
      i += m[0].length;
    }
  }
  return out;
}

function parseSelector(selector: string): Step[][] {
  const groups: string[] = [];
  let depth = 0;
  let quote = false;
  let current = '';
  for (const ch of selector) {
    if (ch === '"') quote = !quote;
    if (!quote && (ch === '[' || ch === '(')) depth += 1;
    if (!quote && (ch === ']' || ch === ')')) depth -= 1;
    if (ch === ',' && depth === 0 && !quote) { groups.push(current); current = ''; } else current += ch;
  }
  groups.push(current);
  return groups.map((group) => {
    const steps: Step[] = [];
    let compound = '';
    let combinator: Step['combinator'] = '';
    let inner = 0;
    let q = false;
    const flush = (): void => { if (compound !== '') { steps.push({ combinator, compound: parseCompound(compound) }); compound = ''; combinator = ' '; } };
    for (const ch of group.trim()) {
      if (ch === '"') q = !q;
      if (!q && (ch === '[' || ch === '(')) inner += 1;
      if (!q && (ch === ']' || ch === ')')) inner -= 1;
      if (inner === 0 && !q && ch === ' ') flush();
      else if (inner === 0 && !q && ch === '>') { flush(); combinator = '>'; } else compound += ch;
    }
    flush();
    return steps;
  });
}

function matchSimple(node: FakeNode, simple: Simple): boolean {
  switch (simple.k) {
    case 'tag': return node.localName === simple.v;
    case 'id': return node.id === simple.v;
    case 'class': return node.className.split(/\s+/).includes(simple.v);
    case 'not': return !simple.inner.every((entry) => matchSimple(node, entry));
    case 'attr': {
      const value = node.getAttribute(simple.name);
      if (value === null) return false;
      if (simple.op === undefined) return true;
      const wanted = simple.v ?? '';
      switch (simple.op) {
        case '=': return value === wanted;
        case '*=': return value.includes(wanted);
        case '^=': return value.startsWith(wanted);
        case '$=': return value.endsWith(wanted);
        case '~=': return value.split(/\s+/).includes(wanted);
        default: return false;
      }
    }
  }
}

function matchSteps(node: FakeNode, steps: Step[], index: number): boolean {
  const step = steps[index];
  if (node.nodeType !== 1 || !step.compound.every((entry) => matchSimple(node, entry))) return false;
  if (index === 0) return true;
  if (step.combinator === '>') return node.parentNode !== null && matchSteps(node.parentNode, steps, index - 1);
  for (let up = node.parentNode; up !== null; up = up.parentNode) if (matchSteps(up, steps, index - 1)) return true;
  return false;
}

// ---- nodes -----------------------------------------------------------------------------------------------------------------------------------

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const FOCUSABLE = new Set(['button', 'input', 'select', 'textarea', 'a']);
// The links from a node to the rest of the page. They are kept out of what util.inspect prints: a failing strict assertion prints both sides at
// depth 1000 and diffs the lines with a diff whose memory grows with the square of the line count, and while these links were enumerable one
// node printed the whole page again from every node on the way, millions of lines, until the process ran out of memory (62-12 incident).
const INSPECT_HIDDEN = ['doc', 'parentNode', 'kids', 'listeners', 'captures', 'onText'];
/** True when addEventListener's third argument asks for the capture phase (true, or { capture: true }). */
const isCapture = (options: unknown): boolean => options === true || (typeof options === 'object' && options !== null && (options as { capture?: unknown }).capture === true);

// What a browser hands back from querySelectorAll, childNodes and children (WR-05). A real NodeList has length, index access, item, forEach,
// entries, keys, values and iteration, and an HTMLCollection has no forEach either. Neither has map, filter, find, indexOf or some, so page
// code that calls those on the raw result throws in Chromium (CR-01). These stand-ins have exactly the browser's members, so the same
// mistake throws here too. Test code that wants Array methods converts with Array.from first, the way the page has to.
export class FakeHTMLCollection {
  readonly [index: number]: FakeNode;
  readonly length: number;
  constructor(nodes: readonly FakeNode[]) {
    this.length = nodes.length;
    nodes.forEach((node, index) => { Object.defineProperty(this, index, { value: node, enumerable: true }); });
  }
  item(index: number): FakeNode | null { return index >= 0 && index < this.length ? this[index] : null; }
  *[Symbol.iterator](): IterableIterator<FakeNode> { for (let index = 0; index < this.length; index += 1) yield this[index]; }
}

export class FakeNodeList extends FakeHTMLCollection {
  forEach(callback: (node: FakeNode, index: number, list: FakeNodeList) => void, thisArg?: unknown): void {
    for (let index = 0; index < this.length; index += 1) callback.call(thisArg, this[index], index, this);
  }
  *entries(): IterableIterator<[number, FakeNode]> { for (let index = 0; index < this.length; index += 1) yield [index, this[index]]; }
  *keys(): IterableIterator<number> { for (let index = 0; index < this.length; index += 1) yield index; }
  *values(): IterableIterator<FakeNode> { yield* this; }
}

export class FakeNode {
  [key: string]: any;
  nodeType: number;
  parentNode: FakeNode | null = null;
  /** The child nodes as an Array, for the fake's own bookkeeping. Page code sees them only through childNodes and children (browser shapes). */
  kids: FakeNode[] = [];
  listeners = new Map<string, Listener[]>();
  /** The capture-phase listeners (62.1-06): they run from the root down to the target before the target's own and the bubbling ones, as in a browser. */
  captures = new Map<string, Listener[]>();
  attrs = new Map<string, string>();
  localName: string;
  tagName: string;
  namespaceURI: string | null;
  doc: FakeDocument;
  onText?: (text: string) => void;
  clientWidth = 0;
  scrollTop = 0;
  scrollLeft = 0;
  selected = false;
  checked = false;
  private text = '';
  private current = '';
  private styles = new Map<string, string>();
  dataset: Record<string, string>;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string; getPropertyValue(name: string): string; [key: string]: any };

  constructor(doc: FakeDocument | null, tag: string, nodeType = 1, namespaceURI: string | null = null) {
    this.doc = doc ?? (this as unknown as FakeDocument);
    this.nodeType = nodeType;
    this.localName = tag.toLowerCase();
    this.tagName = namespaceURI === null ? tag.toUpperCase() : tag;
    this.namespaceURI = namespaceURI;
    const attrs = this.attrs;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => attrs.get(`data-${kebab(key)}`),
      set: (_target, key: string, value) => { attrs.set(`data-${kebab(key)}`, String(value)); return true; },
      has: (_target, key: string) => attrs.has(`data-${kebab(key)}`),
      deleteProperty: (_target, key: string) => attrs.delete(`data-${kebab(key)}`)
    });
    const styles = this.styles;
    this.style = {
      setProperty: (name: string, value: string): void => { styles.set(name, String(value)); },
      removeProperty: (name: string): string => { const old = styles.get(name) ?? ''; styles.delete(name); return old; },
      getPropertyValue: (name: string): string => styles.get(name) ?? ''
    };
    for (const key of INSPECT_HIDDEN) Object.defineProperty(this, key, { value: this[key], writable: true, configurable: true, enumerable: false });
  }

  // Text and markup. Assigning markup throws on purpose.
  get textContent(): string { return this.nodeType === 3 ? this.text : this.kids.map((child) => child.textContent).join(''); }
  set textContent(value: string) {
    const next = String(value);
    if (this.nodeType === 3) { this.text = next; return; }
    for (const child of [...this.kids]) this.detach(child);
    if (next !== '') this.appendChild(this.doc.createTextNode(next));
    if (this.onText !== undefined) this.onText(next);
  }
  set innerHTML(_value: string) { throw new Error('markup assigned through innerHTML'); }
  get innerHTML(): string { return ''; }
  set outerHTML(_value: string) { throw new Error('markup assigned through outerHTML'); }
  get outerHTML(): string { return ''; }
  insertAdjacentHTML(): void { throw new Error('markup inserted through insertAdjacentHTML'); }

  // Attributes and reflected properties.
  setAttribute(name: string, value: unknown): void { this.attrs.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  get className(): string { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', value); }
  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(value: string) { this.attrs.set('id', value); }
  get type(): string { return this.attrs.get('type') ?? ''; }
  set type(value: string) { this.attrs.set('type', value); }
  get title(): string { return this.attrs.get('title') ?? ''; }
  set title(value: string) { this.attrs.set('title', value); }
  get hidden(): boolean { return this.attrs.has('hidden'); }
  set hidden(value: boolean) { if (value) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get disabled(): boolean { return this.attrs.has('disabled'); }
  set disabled(value: boolean) { if (value) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  get draggable(): boolean { return this.attrs.get('draggable') === 'true'; }
  set draggable(value: boolean) { this.attrs.set('draggable', String(value)); }
  get tabIndex(): number { const raw = this.attrs.get('tabindex'); return raw === undefined ? (FOCUSABLE.has(this.localName) ? 0 : -1) : Number(raw); }
  set tabIndex(value: number) { this.attrs.set('tabindex', String(value)); }
  get value(): string { return this.current; }
  set value(next: string) { this.current = String(next); }
  get classList(): { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): boolean; contains(name: string): boolean } {
    const read = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (names: string[]): void => { this.className = names.join(' '); };
    return {
      add: (...names) => write([...new Set([...read(), ...names])]),
      remove: (...names) => write(read().filter((name) => !names.includes(name))),
      toggle: (name, force) => {
        const on = force ?? !read().includes(name);
        write(on ? [...new Set([...read(), name])] : read().filter((entry) => entry !== name));
        return on;
      },
      contains: (name) => read().includes(name)
    };
  }

  // Tree.
  /** The element children as an Array, for the fake's own bookkeeping. */
  elementKids(): FakeNode[] { return this.kids.filter((child) => child.nodeType === 1); }
  get childNodes(): FakeNodeList { return new FakeNodeList(this.kids); }
  get children(): FakeHTMLCollection { return new FakeHTMLCollection(this.elementKids()); }
  get firstChild(): FakeNode | null { return this.kids[0] ?? null; }
  get lastChild(): FakeNode | null { return this.kids[this.kids.length - 1] ?? null; }
  get firstElementChild(): FakeNode | null { return this.elementKids()[0] ?? null; }
  get nextSibling(): FakeNode | null { const siblings = this.parentNode?.kids ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  get previousSibling(): FakeNode | null { const siblings = this.parentNode?.kids ?? []; return siblings[siblings.indexOf(this) - 1] ?? null; }
  get isConnected(): boolean { let node: FakeNode | null = this; while (node !== null && node.parentNode !== null) node = node.parentNode; return node === this.doc; }
  private detach(node: FakeNode): void {
    const parent = node.parentNode;
    if (parent === null) return;
    // A browser drops focus from an element that is removed or moved.
    if (this.doc.activeElement !== this.doc.body && node.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    parent.kids.splice(parent.kids.indexOf(node), 1);
    node.parentNode = null;
  }
  appendChild(node: FakeNode): FakeNode { this.detach(node); node.parentNode = this; this.kids.push(node); return node; }
  append(...nodes: Array<FakeNode | string>): void { for (const node of nodes) this.appendChild(typeof node === 'string' ? this.doc.createTextNode(node) : node); }
  prepend(...nodes: FakeNode[]): void { for (const node of [...nodes].reverse()) this.insertBefore(node, this.kids[0] ?? null); }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (ref === null) return this.appendChild(node);
    if (node === ref) return node;
    this.detach(node);
    node.parentNode = this;
    this.kids.splice(this.kids.indexOf(ref), 0, node);
    return node;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void { for (const child of [...this.kids]) this.detach(child); this.append(...nodes); }
  removeChild(node: FakeNode): FakeNode { this.detach(node); return node; }
  remove(): void { if (this.parentNode !== null) this.parentNode.detach(this); }
  before(node: FakeNode): void { this.parentNode?.insertBefore(node, this); }
  after(node: FakeNode): void { this.parentNode?.insertBefore(node, this.nextSibling); }
  contains(other: FakeNode | null): boolean { for (let node = other; node !== null; node = node.parentNode) if (node === this) return true; return false; }
  all(): FakeNode[] { return this.elementKids().flatMap((child) => [child, ...child.all()]); }
  matches(selector: string): boolean { return parseSelector(selector).some((steps) => matchSteps(this, steps, steps.length - 1)); }
  closest(selector: string): FakeNode | null { for (let node: FakeNode | null = this; node !== null; node = node.parentNode) if (node.nodeType === 1 && node.matches(selector)) return node; return null; }
  querySelectorAll(selector: string): FakeNodeList { return new FakeNodeList(this.all().filter((node) => node.matches(selector))); }
  querySelector(selector: string): FakeNode | null { return this.all().find((node) => node.matches(selector)) ?? null; }
  getBoundingClientRect(): Record<string, number> { return { x: 0, y: 0, left: 0, top: 0, right: this.clientWidth, bottom: 0, width: this.clientWidth, height: 0 }; }
  scrollIntoView(): void { /* nothing to scroll */ }

  // Events.
  addEventListener(type: string, listener: Listener, options?: unknown): void {
    const map = isCapture(options) ? this.captures : this.listeners;
    map.set(type, [...(map.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener, options?: unknown): void {
    const map = isCapture(options) ? this.captures : this.listeners;
    map.set(type, (map.get(type) ?? []).filter((entry) => entry !== listener));
  }
  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    // The capture phase, from the root down to the target (every event has one, also those that do not bubble).
    const path: FakeNode[] = [];
    for (let up: FakeNode | null = this; up !== null; up = up.parentNode) path.unshift(up);
    for (const node of path) {
      if (event.propagationStopped) break;
      const capturing = node.captures.get(event.type);
      if (capturing === undefined || capturing.length === 0) continue;
      event.currentTarget = node;
      for (const listener of [...capturing]) listener(event);
    }
    for (let node: FakeNode | null = this; node !== null && !event.propagationStopped; node = node.parentNode) {
      event.currentTarget = node;
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener(event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }
  click(): void { if (!this.disabled) this.dispatchEvent(new FakeEvent('click', { detail: 1 })); }
  // True when no ancestor is hidden, so focus on a hidden control is refused the way a browser refuses it.
  private rendered(): boolean { for (let node: FakeNode | null = this; node !== null && node.nodeType === 1; node = node.parentNode) if (node.hidden) return false; return true; }
  focus(): void {
    if (this.disabled || !this.isConnected || !this.rendered()) return;
    const previous = this.doc.activeElement;
    if (previous === this) return;
    if (previous !== this.doc.body) { previous.dispatchEvent(new FakeEvent('blur')); previous.dispatchEvent(new FakeEvent('focusout')); }
    this.doc.activeElement = this;
    this.dispatchEvent(new FakeEvent('focus'));
    this.dispatchEvent(new FakeEvent('focusin'));
  }
  blur(): void {
    if (this.doc.activeElement !== this) return;
    this.doc.activeElement = this.doc.body;
    this.dispatchEvent(new FakeEvent('blur'));
    this.dispatchEvent(new FakeEvent('focusout'));
  }
}

export class FakeDocument extends FakeNode {
  html: FakeNode;
  head: FakeNode;
  body: FakeNode;
  activeElement: FakeNode;
  visibilityState = 'visible';
  readyState = 'complete';
  constructor() {
    super(null, '#document', 9);
    this.html = new FakeNode(this, 'html');
    this.head = new FakeNode(this, 'head');
    this.body = new FakeNode(this, 'body');
    this.appendChild(this.html);
    this.html.append(this.head, this.body);
    this.activeElement = this.body;
  }
  get documentElement(): FakeNode { return this.html; }
  get hidden(): boolean { return this.visibilityState === 'hidden'; }
  createElement(tag: string): FakeNode { return new FakeNode(this, tag); }
  createElementNS(namespace: string, tag: string): FakeNode { return new FakeNode(this, tag, 1, namespace); }
  createTextNode(text: string): FakeNode { const node = new FakeNode(this, '#text', 3); node.textContent = text; return node; }
  getElementById(id: string): FakeNode | null { return this.all().find((node) => node.id === id) ?? null; }
  write(): void { throw new Error('markup written through document.write'); }
}

// ---- the harness -----------------------------------------------------------------------------------------------------------------------------

export interface DataTransferStub {
  types: string[]; effectAllowed: string; dropEffect: string; data: Map<string, string>;
  setData(type: string, value: string): void; getData(type: string): string; setDragImage(): void; clearData(): void;
}

export interface BoardHarness {
  document: FakeDocument;
  window: Record<string, any>;
  root: FakeNode;
  /** Every message the page posted to the host, as plain objects. */
  posts: Array<Record<string, any>>;
  /** What the page last stored with setState, as a plain object. */
  state: unknown;
  /** Every non-empty text the live region was given, in order. */
  announcements: string[];
  load(files: string[]): void;
  deliver(message: unknown): void;
  setWidth(px: number): void;
  setVisible(visible: boolean): void;
  advance(ms: number): void;
  click(target: FakeNode): void;
  press(target: FakeNode, key: string, init?: Record<string, unknown>): FakeEvent;
  fire(target: FakeNode, type: string, init?: Record<string, unknown>): FakeEvent;
  setValue(target: FakeNode, value: string, eventName?: string): void;
  dataTransfer(): DataTransferStub;
  live(): string;
  focused(): FakeNode;
  $(selector: string): FakeNode | null;
  $$(selector: string): FakeNode[];
  pendingTimers(): number;
}

const SCRIPT_DIRS = Object.freeze({ board: path.resolve(__dirname, '../../../media/board'), chat: path.resolve(__dirname, '../../../media/chat') });

export interface HarnessOptions {
  width?: number; reducedMotion?: boolean; state?: unknown;
  /** Where load() reads scripts from: media/board (the default) or media/chat (the sidebar). */
  scripts?: 'board' | 'chat';
  /** Starts the body with the sidebar's empty, hidden Team section (section#team, a region named Team) before #root. */
  teamSection?: boolean;
  /** Installs chat.js's window.nearChat = { post } so a sidebar module can post without loading chat.js; posts land in posts. */
  nearChat?: boolean;
}

export function createBoardHarness(options: HarnessOptions = {}): BoardHarness {
  const document = new FakeDocument();
  if (options.teamSection === true) {
    const team = document.createElement('section');
    team.id = 'team';
    team.setAttribute('role', 'region');
    team.setAttribute('aria-label', 'Team');
    team.hidden = true;
    document.body.append(team);
  }
  const root = document.createElement('div');
  root.id = 'root';
  const liveNode = document.createElement('div');
  liveNode.id = 'live';
  liveNode.className = 'sr-only';
  liveNode.setAttribute('role', 'status');
  document.body.append(root, liveNode);
  const scriptDir = SCRIPT_DIRS[options.scripts ?? 'board'];
  const announcements: string[] = [];
  liveNode.onText = (text) => { if (text !== '') announcements.push(text); };

  const posts: Array<Record<string, any>> = [];
  const harness = { state: options.state } as { state: unknown };
  const windowListeners = new Map<string, Array<(event: any) => void>>();
  const observers: Array<{ callback: (entries: any[], observer: unknown) => void; targets: FakeNode[] }> = [];
  let width = options.width ?? 800;
  root.clientWidth = width;

  // Timers under test control.
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const setTimer = (fn: () => void, ms = 0, every?: number): number => { const id = nextId++; timers.set(id, { at: clock + Math.max(0, ms), fn, ...(every === undefined ? {} : { every }) }); return id; };

  const win: Record<string, any> = {
    document,
    innerWidth: width,
    innerHeight: 600,
    console,
    setTimeout: (fn: () => void, ms?: number) => setTimer(fn, ms),
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void, ms = 0) => setTimer(fn, ms, Math.max(1, ms)),
    clearInterval: (id: number) => { timers.delete(id); },
    requestAnimationFrame: (fn: () => void) => setTimer(fn, 16),
    cancelAnimationFrame: (id: number) => { timers.delete(id); },
    matchMedia: (query: string) => ({ matches: options.reducedMotion === true && /prefers-reduced-motion/.test(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }),
    ResizeObserver: class {
      private readonly entry: { callback: (entries: any[], observer: unknown) => void; targets: FakeNode[] };
      constructor(callback: (entries: any[], observer: unknown) => void) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
      observe(target: FakeNode): void { this.entry.targets.push(target); }
      unobserve(): void { /* nothing */ }
      disconnect(): void { this.entry.targets = []; }
    },
    addEventListener: (type: string, listener: (event: any) => void) => { windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]); },
    removeEventListener: (type: string, listener: (event: any) => void) => { windowListeners.set(type, (windowListeners.get(type) ?? []).filter((entry) => entry !== listener)); }
  };
  win.window = win;
  win.self = win;
  const context = vm.createContext(win);
  const inRealm = vm.runInContext('JSON.parse', context) as (text: string) => unknown;
  const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));
  win.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => { posts.push(plain(message)); },
    getState: () => (harness.state === undefined ? undefined : inRealm(JSON.stringify(harness.state))),
    setState: (next: unknown) => { harness.state = plain(next); return next; }
  });
  if (options.nearChat === true) win.nearChat = Object.freeze({ post: (message: unknown) => { posts.push(plain(message)); } });

  const api: BoardHarness = {
    document, window: win, root, posts, announcements,
    get state(): unknown { return harness.state; },
    set state(value: unknown) { harness.state = value; },
    load(files: string[]): void {
      for (const file of files) {
        const filename = path.join(scriptDir, file);
        vm.runInContext(readFileSync(filename, 'utf8'), context, { filename, timeout: 2000 });
      }
    },
    deliver(message: unknown): void { for (const listener of windowListeners.get('message') ?? []) listener({ data: inRealm(JSON.stringify(message)) }); },
    setWidth(px: number): void {
      width = px;
      win.innerWidth = px;
      root.clientWidth = px;
      for (const entry of observers) entry.callback(entry.targets.map((target) => ({ target, contentRect: { width: px, height: 800 } })), entry);
    },
    setVisible(visible: boolean): void {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent(new FakeEvent('visibilitychange'));
    },
    advance(ms: number): void {
      const target = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        const [id, timer] = due;
        clock = timer.at;
        if (timer.every === undefined) timers.delete(id); else timer.at = clock + timer.every;
        timer.fn();
      }
      clock = target;
    },
    click(target: FakeNode): void { target.click(); },
    fire(target: FakeNode, type: string, init: Record<string, unknown> = {}): FakeEvent {
      const event = new FakeEvent(type, init);
      target.dispatchEvent(event);
      return event;
    },
    press(target: FakeNode, key: string, init: Record<string, unknown> = {}): FakeEvent {
      const event = api.fire(target, 'keydown', { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init });
      // A button activates on Enter and Space unless the page took the key.
      if (!event.defaultPrevented && (key === 'Enter' || key === ' ') && target.localName === 'button') target.click();
      return event;
    },
    setValue(target: FakeNode, value: string, eventName = 'input'): void { target.value = value; api.fire(target, eventName); },
    dataTransfer(): DataTransferStub {
      const stub: DataTransferStub = {
        types: [], effectAllowed: 'uninitialized', dropEffect: 'none', data: new Map(),
        setData(type: string, value: string): void { stub.data.set(type, value); if (!stub.types.includes(type)) stub.types.push(type); },
        getData(type: string): string { return stub.data.get(type) ?? ''; },
        setDragImage(): void { /* nothing */ },
        clearData(): void { stub.data.clear(); stub.types = []; }
      };
      return stub;
    },
    live(): string { return liveNode.textContent; },
    focused(): FakeNode { return document.activeElement; },
    $(selector: string): FakeNode | null { return document.querySelector(selector); },
    $$(selector: string): FakeNode[] { return Array.from(document.querySelectorAll(selector)); },
    pendingTimers(): number { return timers.size; }
  };
  void width;
  return api;
}
