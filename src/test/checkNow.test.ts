// "Check now" (owner, 2026-11-06): the chat was waiting on a CI or review verdict the person could already see was in, and there was no way to make it
// look again immediately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as vm from 'node:vm';
import { CHECK_NOW_MARKER, WAITING_INSTRUCTIONS, checkNowMessage, isCheckNow } from '../domain/checkNow';

test('the Check now message is marked, and says exactly what to do', () => {
  const message = checkNowMessage();
  assert.match(message, new RegExp(`^\\[${CHECK_NOW_MARKER}\\]`), 'it carries the marker');
  assert.match(message, /Check the real state now instead of waiting/);
  assert.match(message, /review verdict from GitHub again/);
  assert.match(message, /Do not sleep or wait again for this same verdict/);
  // It stands for itself: no em or en dash, plain words.
  assert.equal(/[\u2013\u2014]/.test(message), false);
  assert.equal(isCheckNow(message), true);
  assert.equal(isCheckNow('carry on with the plan'), false);
  // A sub-agent's row names that agent, because the main run is the one that receives the message.
  const named = checkNowMessage('gsd-planner');
  assert.match(named, /pressed it on gsd-planner's row/);
  assert.equal(isCheckNow(named), true, 'the marker still comes first, so it is still read as a check');
  assert.doesNotMatch(named, /[\u2013\u2014]/);
});

test('a run is told to wait by checking again, so a Check now lands quickly and an early verdict is seen at once', () => {
  // 0.4.18 review: Open-GSD's own guidance says "Never wait with sleep", so this note says the same thing rather than prescribing a sleep loop.
  assert.match(WAITING_INSTRUCTIONS, /never wait with `sleep`/);
  assert.match(WAITING_INSTRUCTIONS, /Check now/);
  assert.match(WAITING_INSTRUCTIONS, /Steer/);
  assert.match(WAITING_INSTRUCTIONS, /\.near-ai\/scratch\//);
});

// A DOM just large enough to start the real chat page, so the button is judged by what it does rather than by the words in its source. The page needs
// only a handful of node methods and the five helper kits panelView loads before it; anything it reaches for that is missing fails the test loudly.
function chatPage(): { nodes: Map<string, StubNode>; send: (data: unknown) => void; posts: unknown[]; sent: () => unknown[] } {
  const nodes = new Map<string, StubNode>();
  const posts: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const document = new StubDocument(nodes);
  const window = new StubNode('window');
  const context: Record<string, unknown> = {
    document, window, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Intl, structuredClone,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { public observe(): void {} public unobserve(): void {} public disconnect(): void {} },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { posts.push(message); }, getState: () => undefined, setState: () => undefined })
  };
  // The kits panelView loads before chat.js, stubbed to their published shapes.
  Object.assign(window, {
    nearMarkdown: { render: (text: string) => text },
    nearTables: { capture: () => ({ wraps: [], scroll: [], focused: -1, inner: -1 }), restore: () => [], syncTabStop: () => undefined, focusLeft: () => undefined, watchSizes: () => ({ observe: () => undefined, release: () => undefined, reset: () => undefined }) },
    nearPending: { createPendingQueue: () => ({ add: () => undefined, close: () => undefined, remove: () => undefined }) },
    nearComposer: { insertCommand: (value: string) => ({ text: value, caret: 0 }) },
    nearSetup: { renderSetupNudge: () => undefined, welcomeState: () => 'ready', applyWelcomeState: () => undefined }
  });
  window.addEventListener = ((type: string, listener: (event: { data: unknown }) => void) => { if (type === 'message') listeners.push(listener); }) as never;
  context.globalThis = context;
  vm.createContext(context);
  const source = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  new vm.Script(source, { filename: 'chat.js' }).runInContext(context);
  // Messages are made inside the page's own context, so they are compared as plain data rather than by prototype.
  const sent = () => posts.map((message) => JSON.parse(JSON.stringify(message)) as unknown);
  return { nodes, send: (data) => { for (const listener of listeners) listener({ data }); }, posts, sent };
}

class StubNode {
  public readonly children: StubNode[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public readonly classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false };
  public readonly listeners: Record<string, Array<(event: { preventDefault(): void; target: unknown }) => void>> = {};
  public id = '';
  public textContent = '';
  public value = '';
  public hidden = false;
  public type = '';
  public title = '';
  public disabled = false;
  public checked = false;
  public constructor(public readonly tagName: string) {}
  public append(...nodes: StubNode[]): void { this.children.push(...nodes); }
  public prepend(...nodes: StubNode[]): void { this.children.unshift(...nodes); }
  public insertBefore(node: StubNode): void { this.children.push(node); }
  public replaceChildren(...nodes: StubNode[]): void { this.children.splice(0, this.children.length, ...nodes); }
  public addEventListener(type: string, listener: (event: { preventDefault(): void; target: unknown }) => void): void { (this.listeners[type] ??= []).push(listener); }
  public removeEventListener(): void {}
  public remove(): void {}
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  public querySelector(): undefined { return undefined; }
  /** Every descendant of a role, which is how a picker lists its own options. */
  public querySelectorAll(selector: string): StubNode[] {
    const role = /\[role="([\w-]+)"\]/.exec(selector)?.[1];
    return role === undefined ? [] : this.all((node) => node.getAttribute('role') === role);
  }
  public contains(): boolean { return false; }
  public closest(): undefined { return undefined; }
  public focus(): void {}
  public blur(): void {}
  public scrollIntoView(): void {}
  public setSelectionRange(): void {}
  public getBoundingClientRect(): { width: number; height: number; top: number; left: number; bottom: number; right: number } { return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }; }
  public click(): void { for (const listener of this.listeners.click ?? []) listener({ preventDefault: () => undefined, target: this }); }
  /** Every node below this one that matches. A page may append a bare string as a separator, which is not a node. */
  public all(predicate: (node: StubNode) => boolean): StubNode[] {
    return this.children.filter((child) => child instanceof StubNode).flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]);
  }
}

class StubDocument {
  public readonly body = new StubNode('body');
  public readonly documentElement = new StubNode('html');
  public activeElement: StubNode | undefined;
  public constructor(private readonly nodes: Map<string, StubNode>) {}
  public createElement(tag: string): StubNode { return new StubNode(tag); }
  public createElementNS(_namespace: string, tag: string): StubNode { return new StubNode(tag); }
  public createTextNode(text: string): StubNode { const node = new StubNode('#text'); node.textContent = text; return node; }
  public getElementById(id: string): StubNode { if (!this.nodes.has(id)) { const node = new StubNode('div'); node.id = id; this.nodes.set(id, node); } return this.nodes.get(id) as StubNode; }
  public querySelector(): undefined { return undefined; }
  /** Every element of a role anywhere in the body, which is how the pickers find their options. */
  public querySelectorAll(selector: string): StubNode[] {
    const role = /\[role="([\w-]+)"\]/.exec(selector)?.[1];
    return role === undefined ? [] : this.body.all((node) => node.getAttribute('role') === role);
  }
  public addEventListener(): void {}
  public removeEventListener(): void {}
  public hasFocus(): boolean { return true; }
  public execCommand(): boolean { return true; }
}

test('the chat draws a real Check now button on a running agent, which posts that agent\'s own nudge', () => {
  const page = chatPage();
  // The row the host sends for a running sub-agent, exactly as agentSession posts it.
  page.send({ type: 'agents', count: 1, agents: [{ id: 'gsd-planner-abc123', label: 'gsd-planner', description: 'Draft a plan', model: 'z-ai/glm-5.3', paused: false, background: false, activity: 'Thinking', activitySince: Date.now(), startedAt: Date.now(), toolCalls: 2, turns: 1 }] });
  const panel = page.nodes.get('agents') as StubNode;
  assert.equal(panel.hidden, false, 'the agents strip is shown');
  const buttons = panel.all((node) => node.tagName === 'button').filter((node) => /^(Check now|Pause|Resume|Stop)$/.test(node.textContent));
  assert.deepEqual(buttons.map((node) => node.textContent), ['Pause', 'Check now', 'Stop'], 'the control sits on the running row');
  const nudge = buttons[1] as StubNode;
  // A hidden control, or one that names another agent, passes a source regex and fails here.
  assert.equal(nudge.hidden, false);
  page.posts.length = 0;
  nudge.click();
  assert.deepEqual(page.sent(), [{ type: 'agent-control', agentId: 'gsd-planner-abc123', action: 'nudge' }], 'the click carries this agent\'s id');
  // A paused agent offers Resume and Check now, never Pause: the nudge is still offered, because the wait can outlive the pause.
  page.send({ type: 'agents', count: 1, agents: [{ id: 'gsd-worker-def456', label: 'gsd-worker', paused: true, background: false, activity: 'Paused', activitySince: Date.now(), startedAt: Date.now(), toolCalls: 0, turns: 0 }] });
  const paused = panel.all((node) => node.tagName === 'button').filter((node) => /^(Check now|Pause|Resume|Stop)$/.test(node.textContent));
  assert.deepEqual(paused.map((node) => node.textContent), ['Resume', 'Check now', 'Stop']);
  page.posts.length = 0;
  (paused[1] as StubNode).click();
  assert.deepEqual(page.sent(), [{ type: 'agent-control', agentId: 'gsd-worker-def456', action: 'nudge' }], 'the second agent gets its own id, not the first one\'s');
});

test('the nudge action goes through the sidebar parser and reaches the agent as an interruption', async () => {
  const { parseChatWebviewMessage } = await import('../services/chatBridge');
  // The page posts this; the parser must accept it, or the button does nothing at all.
  const message = { type: 'agent-control', agentId: 'agent-1-abc123', action: 'nudge' };
  assert.deepEqual(parseChatWebviewMessage(message), { type: 'agent-control', agentId: 'agent-1-abc123', action: 'nudge' });
  // And the old actions are unchanged.
  for (const action of ['pause', 'resume', 'stop'] as const) {
    const parsed = parseChatWebviewMessage({ type: 'agent-control', agentId: 'agent-1-abc123', action }) as { action?: string } | undefined;
    assert.equal(parsed?.action, action);
  }
  assert.equal(parseChatWebviewMessage({ type: 'agent-control', agentId: 'agent-1-abc123', action: 'restart' }), undefined, 'an unknown action is refused');
});

// The between-steps picker, on the same page stand-in (owner, 2026-11-06: "clicking it doesn't let me toggle or choose to go back to asking me between
// phases"). The old test was a regex over the source, so an empty option list, which is exactly the reported bug, still passed.
test('the between-steps picker renders from the host message and offers every way back to asking', () => {
  const page = chatPage();
  const options = [
    { mode: 'approve-risky', label: 'Approve risky actions', summary: 'Asks before anything risky', description: '', risky: false },
    { mode: 'mostly-autonomous', label: 'Mostly autonomous', summary: 'Asks about outside folders', description: '', risky: false },
    { mode: 'fully-autonomous', label: 'Fully autonomous', summary: 'Runs everything', description: '', risky: true }
  ];
  page.send({ type: 'action-policy', mode: 'fully-autonomous', stopped: false, scope: 'workspace', options, autoAdvance: { on: true, text: 'Each step starts the next one by itself.' } });
  const button = page.nodes.get('advance') as StubNode;
  const menu = page.nodes.get('advance-menu') as StubNode;
  assert.equal(button.hidden, false, 'the picker is shown');
  // The chevron is the picker's affordance and is part of the label, as the markup ships it.
  assert.equal(button.textContent, 'Carrying on \u25be', 'the label says what is happening now, and keeps its chevron');
  const rendered = menu.all((node) => node.tagName === 'div' && node.id.startsWith('advance-option-')).map((node) => [node.id, node.dataset.mode]);
  assert.deepEqual(rendered, [
    ['advance-option-auto', 'auto'],
    ['advance-option-approve-risky', 'approve-risky'],
    ['advance-option-mostly-autonomous', 'mostly-autonomous'],
    ['advance-option-fully-autonomous', 'fully-autonomous']
  ], 'carrying on, then a real choice for every asking mode: a person picks rather than toggles');
  assert.equal(menu.all((node) => node.getAttribute('role') === 'option').find((node) => node.getAttribute('aria-selected') === 'true')?.dataset.mode, 'auto', 'the current choice is marked');
  // Choosing a way back to asking posts the same message the approval picker posts, which the host then saves.
  page.posts.length = 0;
  (menu.all((node) => node.id === 'advance-option-approve-risky')[0] as StubNode).click();
  assert.deepEqual(page.sent(), [{ type: 'set-action-policy', mode: 'approve-risky' }]);
  assert.equal(menu.hidden, true, 'the menu closes after a choice');
  // Stopping between steps with no mode set marks the mode that is in force, so the check never sits on "carrying on" by mistake.
  page.send({ type: 'action-policy', mode: 'mostly-autonomous', stopped: true, scope: 'workspace', options, autoAdvance: { on: false, text: 'Stops at every step.' } });
  assert.equal(button.textContent, 'Stops each step \u25be');
  assert.equal(menu.all((node) => node.getAttribute('aria-selected') === 'true')[0]?.dataset.mode, 'mostly-autonomous');
  // No options at all still leaves the way to keep carrying on, so the picker is never an empty menu.
  page.send({ type: 'action-policy', mode: 'auto', stopped: false, scope: 'workspace', options: [], autoAdvance: { on: true, text: '' } });
  assert.deepEqual(menu.all((node) => node.getAttribute('role') === 'option').map((node) => node.dataset.mode), ['auto']);
});
