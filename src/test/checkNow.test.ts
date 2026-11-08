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
  focused = undefined;
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
  // Messages are made inside the page's own context, so they are compared as plain data rather than by prototype.
  const sent = () => posts.map((message) => JSON.parse(JSON.stringify(message)) as unknown);
  return { nodes, send: (data) => { for (const listener of listeners) listener({ data }); }, posts, sent };
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

class StubDocument {
  public readonly body = new StubNode('body');
  public readonly documentElement = new StubNode('html');
  public get activeElement(): StubNode | undefined { return focused; }
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

// 0.4.19 review: the picker's options sit at tabIndex -1, so nothing told a screen reader which one the arrows were on, and Escape pressed while the
// focus was still on the button did nothing. Both are driven on the real page rather than matched in the source.
test('the between-steps picker names the active option and closes on Escape from its button', () => {
  const page = chatPage();
  const options = [
    { mode: 'approve-risky', label: 'Approve risky actions', summary: 'Asks before anything risky', description: '', risky: false },
    { mode: 'mostly-autonomous', label: 'Mostly autonomous', summary: 'Asks about outside folders', description: '', risky: false }
  ];
  page.send({ type: 'action-policy', mode: 'approve-risky', stopped: false, scope: 'workspace', options, autoAdvance: { on: false, text: 'Stops at every step.' } });
  const button = page.nodes.get('advance') as StubNode;
  const menu = page.nodes.get('advance-menu') as StubNode;
  // The markup ships the menu hidden; a stub node starts visible, so this is the page as loaded.
  menu.hidden = true;
  assert.equal(menu.getAttribute('aria-activedescendant'), undefined, 'a closed menu names no option');
  // The button opens the menu, focuses the current choice, and names it to assistive tech.
  button.click();
  assert.equal(menu.hidden, false, 'the button opens the menu');
  assert.equal(menu.getAttribute('aria-activedescendant'), 'advance-option-approve-risky', 'the selected option is the active descendant');
  // ArrowDown moves the active option, and the name moves with it.
  menu.press('ArrowDown');
  assert.equal(menu.getAttribute('aria-activedescendant'), 'advance-option-mostly-autonomous');
  // Escape on the listbox closes it, as before.
  menu.press('Escape');
  assert.equal(menu.hidden, true, 'Escape in the menu closes it');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.getAttribute('aria-activedescendant'), undefined, 'a closed menu names no option');
  // Escape while the focus is on the BUTTON also closes the menu, which is where a person's focus starts.
  button.click();
  assert.equal(menu.hidden, false);
  button.press('Escape');
  assert.equal(menu.hidden, true, 'Escape on the button closes the open menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  // Escape with the menu already closed stays harmless, and posts nothing.
  page.posts.length = 0;
  button.press('Escape');
  assert.equal(menu.hidden, true);
  assert.deepEqual(page.sent(), [], 'Escape never chooses an option');
});

test('a run that parks on a timeout keeps its approval card and says it is paused', () => {
  // The review's finding: the branch was never exercised, so a wrong card shape would have shipped silently.
  const page = chatPage();
  page.send({ type: 'approval-request', callId: 'p1', tool: 'Bash', title: 'Run npm test', preview: { kind: 'note', text: 'npm test' } });
  const card = page.nodes.get('pending') as StubNode;
  assert.ok(card, 'the approval card is pinned');
  page.posts.length = 0;
  page.send({ type: 'approval-paused', callId: 'p1', minutes: 15, text: 'No one answered within 15 minutes, so the run is paused on this step. It has not run.' });
  // The card is still there, with the note on it, so the answer is still owed.
  const note = card.all((node) => node.className.split(/\s+/).includes('pending-paused'));
  assert.equal(note.length, 1, 'the card carries the paused note');
  assert.match(note[0]?.textContent ?? '', /paused on this step/);
  // A second paused message for the same prompt does not stack notes.
  page.send({ type: 'approval-paused', callId: 'p1', minutes: 15, text: 'Still paused.' });
  assert.equal(card.all((node) => node.className.split(/\s+/).includes('pending-paused')).length, 1, 'no duplicate note');
  // And a pause for a card that is not pinned is announced rather than dropped.
  // A pause for a card that is not pinned becomes a notice in the transcript, which is how the page tells the person.
  page.send({ type: 'approval-paused', callId: 'gone', minutes: 5, text: 'The run is paused and its card is gone.' });
  const transcript = page.nodes.get('transcript') as StubNode;
  const said = transcript.children.filter((node) => node instanceof StubNode).flatMap((node) => [node, ...node.all(() => true)]).map((node) => node.textContent).join(' ');
  assert.match(said, /card is gone/, `an unknown card still reaches the person, saw: ${said.slice(0, 200)}`);
});
