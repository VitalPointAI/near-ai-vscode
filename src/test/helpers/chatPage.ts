// The real chat page (media/chat/chat.js) started on a DOM stand-in, so webview behaviour is judged by what the page does rather than by the words in
// its source. Shared by the chat page tests (Check now, steering and attachments).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';
import * as vm from 'node:vm';

// A DOM just large enough to start the real chat page, so the button is judged by what it does rather than by the words in its source. The page needs
// only a handful of node methods and the helper kits panelView loads before it (the trust badge kit is the real one); anything it reaches for that is missing fails the test loudly.
/** An event as the page's listeners see it, with whether a listener already used it. */
export interface StubEvent { key?: string; target: StubNode; defaultPrevented: boolean; preventDefault(): void }

export function chatPage(): { nodes: Map<string, StubNode>; send: (data: unknown) => void; posts: unknown[]; sent: () => unknown[]; dispatch: (type: string, target: StubNode, key?: string) => StubEvent; focused: () => StubNode | undefined } {
  focused = undefined;
  const nodes = new Map<string, StubNode>();
  const posts: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const document = new StubDocument(nodes);
  const window = new StubNode('window');
  const context: Record<string, unknown> = {
    document, window, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Intl, structuredClone, crypto: webcrypto,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { public observe(): void {} public unobserve(): void {} public disconnect(): void {} },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { posts.push(message); }, getState: () => undefined, setState: () => undefined })
  };
  // The kits panelView loads before chat.js, stubbed to their published shapes.
  Object.assign(window, {
    // parse gives no blocks: an answer's text is not drawn, but its reply node and footer are, so tests can follow replies by run.
    nearMarkdown: { render: (text: string) => text, parse: () => [] },
    nearTables: { capture: () => ({ wraps: [], scroll: [], focused: -1, inner: -1 }), restore: () => [], syncTabStop: () => undefined, focusLeft: () => undefined, watchSizes: () => ({ observe: () => undefined, release: () => undefined, reset: () => undefined }) },
    // A real queue: the page tracks which prompts are pinned, and a stub that answered nothing would hide a card that never appeared.
    nearPending: {
      createPendingQueue: () => {
        const items: Array<{ id: string }> = [];
        return {
          add: (item: { id: string }) => { if (items.some((known) => known.id === item.id)) return false; items.push(item); return true; },
          has: (id: string) => items.some((known) => known.id === id),
          resolve: (id: string) => { const at = items.findIndex((known) => known.id === id); return at < 0 ? undefined : items.splice(at, 1)[0]; },
          size: () => items.length,
          current: () => items[0],
          position: () => (items.length ? 1 : 0),
          select: () => true,
          step: () => items[0],
          list: () => [...items],
          clear: () => items.splice(0, items.length)
        };
      },
      headerText: () => 'Waiting for you',
      waitingText: (item: { title: string }) => 'Waiting: ' + item.title,
      outcomeText: (item: { title: string }, outcome: string) => outcome + ': ' + item.title
    },
    nearComposer: { insertCommand: (value: string) => ({ text: value, caret: 0 }) },
    nearSetup: { renderSetupNudge: () => undefined, welcomeState: () => 'ready', applyWelcomeState: () => undefined }
  });
  window.addEventListener = ((type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener); }) as never;
  context.globalThis = context;
  vm.createContext(context);
  // The real trust badge kit (CLAS-08) runs before the page, as panelView loads it, so a page test judges the real drawing rather than a stub.
  const kit = readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'chat', 'trustBadge.js'), 'utf8');
  new vm.Script(kit, { filename: 'trustBadge.js' }).runInContext(context);
  const source = readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  new vm.Script(source, { filename: 'chat.js' }).runInContext(context);
  // Messages are made inside the page's own context, so they are compared as plain data rather than by prototype.
  const sent = () => posts.map((message) => JSON.parse(JSON.stringify(message)) as unknown);
  // As a browser delivers it: the target, each of its ancestors, then the document (it bubbles), so a page-wide listener sees what the others did.
  const dispatch = (type: string, target: StubNode, key?: string): StubEvent => {
    const event: StubEvent = { ...(key === undefined ? {} : { key }), target, defaultPrevented: false, preventDefault: () => { event.defaultPrevented = true; } };
    for (let at: StubNode | undefined = target; at; at = at.parent) for (const listener of at.listeners[type] ?? []) listener(event);
    for (const listener of document.listeners[type] ?? []) listener(event);
    return event;
  };
  return { nodes, send: (data) => { for (const listener of listeners) listener({ data }); }, posts, sent, dispatch, focused: () => focused };
}

export class StubNode {
  public readonly children: StubNode[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  // A real class list over `className`, because the page checks membership (`querySelector('.pending-paused')`) and a stub that always said "no" would
  // hide exactly the defect a test like this exists to catch.
  public className = '';
  public readonly classList = {
    add: (name: string) => { if (!this.className.split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
    remove: (name: string) => { this.className = this.className.split(/\s+/).filter((part) => part && part !== name).join(' '); },
    toggle: (name: string) => { this.classList.contains(name) ? this.classList.remove(name) : this.classList.add(name); },
    contains: (name: string) => this.className.split(/\s+/).includes(name)
  };
  public readonly listeners: Record<string, Array<(event: { key?: string; preventDefault(): void; target: unknown }) => void>> = {};
  public id = '';
  public textContent = '';
  public value = '';
  public hidden = false;
  public type = '';
  public title = '';
  public disabled = false;
  public checked = false;
  public constructor(public readonly tagName: string) {}
  /** The child nodes, as a fragment's caller reads them. */
  public get childNodes(): StubNode[] { return this.children; }
  /** The node this one is a child of. As in a real DOM, adding a node somewhere moves it there, and `remove()` takes it out. */
  public parent: StubNode | undefined;
  private adopt(node: StubNode | string): StubNode | string { if (node instanceof StubNode) { node.remove(); node.parent = this; } return node; }
  public append(...nodes: Array<StubNode | string>): void { for (const node of nodes) this.children.push(this.adopt(node) as StubNode); }
  public appendChild(node: StubNode): StubNode { this.children.push(this.adopt(node) as StubNode); return node; }
  public prepend(...nodes: StubNode[]): void { this.children.unshift(...nodes.map((node) => this.adopt(node) as StubNode)); }
  public insertBefore(node: StubNode, before?: StubNode | null): void {
    this.adopt(node);
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
  }
  public replaceChildren(...nodes: StubNode[]): void { for (const child of this.children.splice(0)) if (child instanceof StubNode) child.parent = undefined; for (const node of nodes) this.appendChild(node); }
  public addEventListener(type: string, listener: (event: { key?: string; preventDefault(): void; target: unknown }) => void): void { (this.listeners[type] ??= []).push(listener); }
  public removeEventListener(): void {}
  public remove(): void {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = undefined;
  }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  /** A descendant by class, which is how the page checks whether a note is already on a card. */
  public querySelector(selector: string): StubNode | undefined {
    const cls = /^\.([\w-]+)$/.exec(selector)?.[1];
    if (cls === undefined) return undefined;
    return this.all((node) => node.className.split(/\s+/).includes(cls))[0];
  }
  /** Every descendant of a role, which is how a picker lists its own options. */
  public querySelectorAll(selector: string): StubNode[] {
    const role = /\[role="([\w-]+)"\]/.exec(selector)?.[1];
    return role === undefined ? [] : this.all((node) => node.getAttribute('role') === role);
  }
  public contains(node: StubNode): boolean { return this.all((child) => child === node).length > 0; }
  public closest(): undefined { return undefined; }
  public focus(): void { focused = this; }
  public blur(): void { if (focused === this) focused = undefined; }
  public scrollIntoView(): void {}
  public setSelectionRange(): void {}
  public getBoundingClientRect(): { width: number; height: number; top: number; left: number; bottom: number; right: number } { return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }; }
  public click(): void { for (const listener of this.listeners.click ?? []) listener({ preventDefault: () => undefined, target: this }); }
  /** A key press, as the page's own listeners see it. */
  public press(key: string): void { for (const listener of this.listeners.keydown ?? []) listener({ key, preventDefault: () => undefined, target: this }); }
  /** Every node below this one that matches. A page may append a bare string as a separator, which is not a node. */
  public all(predicate: (node: StubNode) => boolean): StubNode[] {
    return this.children.filter((child) => child instanceof StubNode).flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]);
  }
}

// Focus is global to a page, so the focused node is held here and the document reports it.
let focused: StubNode | undefined;

class StubDocument {
  public readonly body = new StubNode('body');
  public readonly documentElement = new StubNode('html');
  public get activeElement(): StubNode | undefined { return focused; }
  public constructor(private readonly nodes: Map<string, StubNode>) {}
  public createElement(tag: string): StubNode { return new StubNode(tag); }
  public createElementNS(_namespace: string, tag: string): StubNode { return new StubNode(tag); }
  /** A reopened chat's history is drawn in fragments; here a fragment is a plain node, which keeps what was drawn in it findable. */
  public createDocumentFragment(): StubNode { return new StubNode('#fragment'); }
  public createTextNode(text: string): StubNode { const node = new StubNode('#text'); node.textContent = text; return node; }
  public getElementById(id: string): StubNode { if (!this.nodes.has(id)) { const node = new StubNode('div'); node.id = id; this.nodes.set(id, node); } return this.nodes.get(id) as StubNode; }
  public querySelector(): undefined { return undefined; }
  /** Every element of a role anywhere in the body, which is how the pickers find their options. */
  public querySelectorAll(selector: string): StubNode[] {
    const role = /\[role="([\w-]+)"\]/.exec(selector)?.[1];
    return role === undefined ? [] : this.body.all((node) => node.getAttribute('role') === role);
  }
  /** The page's own document-wide listeners, which a test reaches through chatPage's dispatch. */
  public readonly listeners: Record<string, Array<(event: StubEvent) => void>> = {};
  public addEventListener(type: string, listener: (event: StubEvent) => void): void { (this.listeners[type] ??= []).push(listener); }
  public removeEventListener(): void {}
  public hasFocus(): boolean { return true; }
  public execCommand(): boolean { return true; }
}

