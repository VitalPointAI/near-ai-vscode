// REVIEW MINOR media/chat/chat.js:1161: the history queue drained only on requestAnimationFrame, and a hidden webview never runs one, so a reopened
// conversation and every approval, question and live event queued behind it stalled until the person looked at the view again (T-27-138).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as vm from 'node:vm';

interface Page {
  nodes: Map<string, StubNode>;
  send: (data: unknown) => void;
  setVisibility: (state: 'visible' | 'hidden') => void;
  /** Animation frames the page asked for and has not been given yet; running them is the test's choice. */
  frames: Array<() => void>;
  cancelled: number;
}

// The same page stand-in as checkNow.test.ts, with a document that can be hidden and animation frames that run only when the test says so.
function chatPage(initial: 'visible' | 'hidden'): Page {
  focused = undefined;
  const nodes = new Map<string, StubNode>();
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const document = new StubDocument(nodes);
  document.visibilityState = initial;
  const window = new StubNode('window');
  const frames: Array<() => void> = [];
  const page: Page = { nodes, frames, cancelled: 0, send: (data) => { for (const listener of listeners) listener({ data }); }, setVisibility: () => undefined };
  const context: Record<string, unknown> = {
    document, window, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Intl, structuredClone,
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    cancelAnimationFrame: (id: number) => { page.cancelled += 1; frames[id - 1] = () => undefined; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { public observe(): void {} public unobserve(): void {} public disconnect(): void {} },
    acquireVsCodeApi: () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined })
  };
  // The kits panelView loads before chat.js, stubbed to their published shapes.
  Object.assign(window, {
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
  const source = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  new vm.Script(source, { filename: 'chat.js' }).runInContext(context);
  page.setVisibility = (state) => {
    document.visibilityState = state;
    for (const listener of document.listeners.visibilitychange ?? []) listener({ target: document, preventDefault: () => undefined });
  };
  return page;
}

class StubNode {
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
  public append(...nodes: Array<StubNode | string>): void { for (const node of nodes) this.children.push(node as StubNode); }
  public appendChild(node: StubNode): StubNode { this.children.push(node); return node; }
  public prepend(...nodes: StubNode[]): void { this.children.unshift(...nodes); }
  public insertBefore(node: StubNode): void { this.children.push(node); }
  public replaceChildren(...nodes: StubNode[]): void { this.children.splice(0, this.children.length, ...nodes); }
  public addEventListener(type: string, listener: (event: { key?: string; preventDefault(): void; target: unknown }) => void): void { (this.listeners[type] ??= []).push(listener); }
  public removeEventListener(): void {}
  public remove(): void {}
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

/** A fragment hands its children to the node it is appended to, and the page counts them first. */
class StubFragment extends StubNode {
  public constructor() { super('#fragment'); }
  public get childNodes(): StubNode[] { return this.children; }
}

class StubDocument {
  public readonly body = new StubNode('body');
  public readonly documentElement = new StubNode('html');
  public visibilityState: 'visible' | 'hidden' = 'visible';
  public readonly listeners: Record<string, Array<(event: { target: unknown; preventDefault(): void }) => void>> = {};
  public get activeElement(): StubNode | undefined { return focused; }
  public constructor(private readonly nodes: Map<string, StubNode>) {}
  public createElement(tag: string): StubNode { return new StubNode(tag); }
  public createElementNS(_namespace: string, tag: string): StubNode { return new StubNode(tag); }
  public createDocumentFragment(): StubFragment { return new StubFragment(); }
  public createTextNode(text: string): StubNode { const node = new StubNode('#text'); node.textContent = text; return node; }
  public getElementById(id: string): StubNode { if (!this.nodes.has(id)) { const node = new StubNode('div'); node.id = id; this.nodes.set(id, node); } return this.nodes.get(id) as StubNode; }
  public querySelector(): undefined { return undefined; }
  public querySelectorAll(selector: string): StubNode[] {
    const role = /\[role="([\w-]+)"\]/.exec(selector)?.[1];
    return role === undefined ? [] : this.body.all((node) => node.getAttribute('role') === role);
  }
  public addEventListener(type: string, listener: (event: { target: unknown; preventDefault(): void }) => void): void { (this.listeners[type] ??= []).push(listener); }
  public removeEventListener(): void {}
  public hasFocus(): boolean { return true; }
  public execCommand(): boolean { return true; }
}

const SLICE = 50;
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));
const items = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: index % 2 === 0 ? 'user' : 'assistant', text: `item ${index}` }));
const reopened = (page: Page): number => (page.nodes.get('transcript') as StubNode).all((node) => node.className.split(/\s+/).includes('reopened')).length;
// The line a waiting prompt leaves in the transcript holds its words in a span, so each line is read through its own parts.
const waitingLines = (page: Page): string[] => (page.nodes.get('transcript') as StubNode).all((node) => node.className.split(/\s+/).includes('pending-line'))
  .map((line) => line.all((part) => part.tagName === 'span').map((part) => part.textContent).join(''));
const approval = { type: 'approval-request', callId: 'p1', tool: 'Bash', title: 'Run npm test', preview: { kind: 'note', text: 'npm test' } };

test('a hidden chat view still draws a reopened conversation, and the approval behind it is shown', async () => {
  const page = chatPage('hidden');
  page.send({ type: 'transcript', items: items(120) });
  page.send(approval);
  // The view is hidden, so no animation frame will ever run; the queue must not wait for one.
  await turn(); await turn(); await turn();
  assert.equal(reopened(page), 120, 'every history item is on the page');
  assert.deepEqual(waitingLines(page), ['Waiting: Run npm test'], 'the approval that came in behind the history is shown');
  assert.equal(page.frames.length, 0, 'nothing was left waiting on a frame');
});

test('a visible chat view draws the history in slices per animation frame as before', async () => {
  const page = chatPage('visible');
  page.send({ type: 'transcript', items: items(120) });
  page.send(approval);
  await turn();
  assert.equal(reopened(page), 0, 'nothing is drawn until the frame runs');
  assert.equal(page.frames.length, 1, 'one frame is asked for');
  page.frames.shift()?.();
  assert.equal(reopened(page), SLICE, 'one slice per frame');
  await turn();
  assert.equal(reopened(page), SLICE, 'a visible view does not fall back to a timer');
  while (page.frames.length) page.frames.shift()?.();
  assert.equal(reopened(page), 120);
  assert.deepEqual(waitingLines(page), ['Waiting: Run npm test'], 'the held message is handled after the last item');
});

test('a view hidden while a frame is pending moves the rest of the queue onto a timer', async () => {
  const page = chatPage('visible');
  page.send({ type: 'transcript', items: items(120) });
  page.send(approval);
  assert.equal(page.frames.length, 1);
  page.setVisibility('hidden');
  assert.equal(page.cancelled, 1, 'the pending frame is cancelled');
  await turn(); await turn(); await turn();
  assert.equal(reopened(page), 120, 'the queue drained on timers');
  assert.deepEqual(waitingLines(page), ['Waiting: Run npm test']);
});

test('the view coming back to visible never loses or doubles an item', async () => {
  const page = chatPage('hidden');
  page.send({ type: 'transcript', items: items(120) });
  page.setVisibility('visible');
  page.send({ type: 'transcript', items: [{ kind: 'user', text: 'more' }] });
  await turn(); await turn();
  while (page.frames.length) page.frames.shift()?.();
  await turn(); await turn();
  while (page.frames.length) page.frames.shift()?.();
  assert.equal(reopened(page), 121, 'each item once');
});
