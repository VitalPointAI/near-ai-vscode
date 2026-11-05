// The DevTools Protocol client for the real-window board tests (Phase 62 plan 16, G-62-6): it finds the VS Code window, locates the board's webview
// frame and drags a card with real mouse input through Chromium's own input path. These tests run it against a fake socket that records every
// command and lets the test send replies and events.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as cdpClient from './e2e/cdp';
import { connectCdp, interceptedDrag, mouseDrag, originTarget, pressKey, webviewFrameRect, workbenchTarget } from './e2e/cdp';
import type { CdpSession, SocketLike } from './e2e/cdp';

interface Sent { id: number; method: string; params?: Record<string, any> }

class FakeSocket implements SocketLike {
  public readyState = 1;
  public readonly sent: Sent[] = [];
  public onSend: ((message: Sent) => void) | undefined;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  public send(data: string): void { const message = JSON.parse(data) as Sent; this.sent.push(message); this.onSend?.(message); }
  public close(): void { this.readyState = 3; this.emit('close', {}); }
  public addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  public reply(id: number, result: unknown): void { this.emit('message', { data: JSON.stringify({ id, result }) }); }
  public fail(id: number, message: string): void { this.emit('message', { data: JSON.stringify({ id, error: { code: -32000, message } }) }); }
  public event(method: string, params: unknown): void { this.emit('message', { data: JSON.stringify({ method, params }) }); }
  /** Replies {} to every command on the next turn, after letting the test react first. */
  public autoReply(react?: (message: Sent) => void): void {
    this.onSend = (message) => { react?.(message); setImmediate(() => this.reply(message.id, {})); };
  }
}

const TARGETS = [
  { type: 'service_worker', url: 'vscode-webview://abc/service-worker.js', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/SW' },
  { type: 'iframe', url: 'vscode-webview://abc/index.html?id=board', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/FRAME' },
  { type: 'page', url: 'vscode-file://vscode-app/opt/code/out/vs/code/electron-sandbox/processExplorer/processExplorer.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/OTHER' },
  { type: 'page', url: 'vscode-file://vscode-app/opt/code/out/vs/code/electron-sandbox/workbench/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/MAIN' }
];

async function session(socket = new FakeSocket(), timeoutMs = 2_000): Promise<{ cdp: CdpSession; socket: FakeSocket; urls: string[] }> {
  const urls: string[] = [];
  const cdp = await connectCdp(9333, { fetchJson: async (url) => { urls.push(url); return TARGETS; }, openSocket: (url) => { urls.push(url); return socket; }, timeoutMs });
  return { cdp, socket, urls };
}

const mouse = (sent: Sent[]) => sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params!);

test('workbenchTarget picks the page whose url ends with workbench.html, and nothing when there is none', () => {
  assert.equal(workbenchTarget(TARGETS)?.webSocketDebuggerUrl, 'ws://127.0.0.1:9333/devtools/page/MAIN');
  assert.equal(workbenchTarget(TARGETS.slice(0, 3)), undefined);
  assert.equal(workbenchTarget([{ type: 'iframe', url: 'x/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/I' }]), undefined, 'only a page target counts');
  assert.equal(workbenchTarget([{ type: 'page', url: 'x/workbench.html' }]), undefined, 'a page without a debugger url cannot be used');
});

test('connectCdp lists targets on 127.0.0.1, waits for the socket to open, and matches replies to calls by id', async () => {
  const socket = new FakeSocket();
  socket.readyState = 0;
  const opening = session(socket);
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = 1;
  socket.emit('open', {});
  const { cdp, urls } = await opening;
  assert.deepEqual(urls, ['http://127.0.0.1:9333/json/list', 'ws://127.0.0.1:9333/devtools/page/MAIN']);

  const first = cdp.send<{ value: number }>('Runtime.evaluate', { expression: '1' });
  const second = cdp.send<{ value: number }>('Runtime.evaluate', { expression: '2' });
  assert.deepEqual(socket.sent.map((m) => [m.id, m.method]), [[1, 'Runtime.evaluate'], [2, 'Runtime.evaluate']]);
  socket.reply(2, { value: 2 });
  socket.reply(1, { value: 1 });
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await second, { value: 2 });

  const refused = cdp.send('Input.dispatchMouseEvent', {});
  socket.fail(3, 'Invalid parameters');
  await assert.rejects(refused, /Invalid parameters/);
  cdp.close();
});

test('on() delivers events by method name and its returned function removes the listener', async () => {
  const { cdp, socket } = await session();
  const seen: unknown[] = [];
  const off = cdp.on('Input.dragIntercepted', (params) => { seen.push(params); });
  socket.event('Input.dragIntercepted', { data: { items: [] } });
  socket.event('Page.frameNavigated', { frame: {} });
  off();
  socket.event('Input.dragIntercepted', { data: { items: ['late'] } });
  assert.deepEqual(seen, [{ data: { items: [] } }]);
  cdp.close();
});

test('a closed socket rejects every pending call and later calls, and a reply that never comes rejects after timeoutMs', async () => {
  const { cdp, socket } = await session();
  const a = cdp.send('Runtime.evaluate', { expression: '1' });
  const b = cdp.send('Runtime.evaluate', { expression: '2' });
  socket.close();
  await assert.rejects(a, /closed/);
  await assert.rejects(b, /closed/);
  await assert.rejects(cdp.send('Runtime.evaluate', {}), /closed/);

  const slow = await session(new FakeSocket(), 60);
  const started = Date.now();
  await assert.rejects(slow.cdp.send('Runtime.evaluate', { expression: '3' }), /Runtime\.evaluate did not answer within 60 ms/);
  assert.ok(Date.now() - started < 1_000, 'the timeout is bounded');
  slow.cdp.close();
});

test('connectCdp refuses a debugger address that is not on this computer, and says which pages it saw when VS Code is missing', async () => {
  const remote = [{ type: 'page', url: 'x/workbench.html', webSocketDebuggerUrl: 'ws://example.com:9333/devtools/page/MAIN' }];
  await assert.rejects(connectCdp(9333, { fetchJson: async () => remote, openSocket: () => new FakeSocket() }), /127\.0\.0\.1/);
  await assert.rejects(connectCdp(9333, { fetchJson: async () => TARGETS.slice(0, 2), openSocket: () => new FakeSocket() }), /workbench\.html/);
});

// 0.6.3 re-test (debug session board-codeserver-cards-and-drag): the code-server board test drives a browser tab, not the VS Code window.
test('originTarget picks the page on the code-server origin only, and connectCdp uses a given picker but still refuses an address off this computer', async () => {
  const tabs = [
    { type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/NEW' },
    { type: 'iframe', url: 'http://127.0.0.1:8123/stable-x/static/out/vs/workbench/contrib/webview/browser/pre/index.html?id=1', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/F' },
    { type: 'page', url: 'http://127.0.0.1:81230/?folder=/x', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/OTHERPORT' },
    { type: 'page', url: 'http://127.0.0.1:8123/?folder=/tmp/p', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/CS' }
  ];
  assert.equal(originTarget(tabs, 'http://127.0.0.1:8123')?.webSocketDebuggerUrl, 'ws://127.0.0.1:9333/devtools/page/CS', 'the page on that origin, not an iframe or another port');
  assert.equal(originTarget(tabs.slice(0, 3), 'http://127.0.0.1:8123'), undefined);
  const urls: string[] = [];
  const cdp = await connectCdp(9333, { fetchJson: async () => tabs, openSocket: (url) => { urls.push(url); return new FakeSocket(); }, pick: (targets) => originTarget(targets, 'http://127.0.0.1:8123') });
  assert.deepEqual(urls, ['ws://127.0.0.1:9333/devtools/page/CS']);
  cdp.close();
  await assert.rejects(connectCdp(9333, { fetchJson: async () => tabs.slice(0, 1), openSocket: () => new FakeSocket(), pick: (targets) => originTarget(targets, 'http://127.0.0.1:8123') }), /No matching page on port 9333/);
  const far = [{ type: 'page', url: 'http://127.0.0.1:8123/', webSocketDebuggerUrl: 'ws://example.com:9333/devtools/page/CS' }];
  await assert.rejects(connectCdp(9333, { fetchJson: async () => far, openSocket: () => new FakeSocket(), pick: (targets) => originTarget(targets, 'http://127.0.0.1:8123') }), /127\.0\.0\.1/);
});

test('mouseDrag presses at the start, moves in steps with the button held to exactly the end, runs whileOver, then releases', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  let sentWhenOver = -1;
  await mouseDrag(cdp, { x: 10, y: 20 }, { x: 50, y: 61 }, { steps: 4, pauseMs: 1, whileOver: async () => { sentWhenOver = socket.sent.length; } });
  assert.ok(socket.sent.every((m) => m.method === 'Input.dispatchMouseEvent'), 'only Input.dispatchMouseEvent is sent');
  const events = mouse(socket.sent);
  assert.deepEqual(events.map((e) => e.type), ['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  assert.deepEqual([events[0].x, events[0].y, events[0].button, events[0].buttons, events[0].clickCount], [10, 20, 'left', 1, 1]);
  assert.deepEqual(events.slice(1, 5).map((e) => [e.x, e.y]), [[20, 30.25], [30, 40.5], [40, 50.75], [50, 61]]);
  assert.ok(events.slice(1, 5).every((e) => e.buttons === 1 && e.button === 'left'), 'the button is held while moving');
  assert.deepEqual([events[5].x, events[5].y, events[5].button], [50, 61, 'left']);
  assert.equal(sentWhenOver, 5, 'whileOver runs after the last move and before the release');
  cdp.close();
});

test('interceptedDrag waits for Chromium to intercept the drag, then drops at the target with the intercepted data', async () => {
  const { cdp, socket } = await session();
  const data = { items: [{ mimeType: 'application/vnd.near-ai.card', data: 'plan:90-01' }], dragOperationsMask: 1 };
  let moves = 0;
  socket.autoReply((message) => {
    if (message.method === 'Input.dispatchMouseEvent' && message.params?.type === 'mouseMoved' && ++moves === 2) setImmediate(() => socket.event('Input.dragIntercepted', { data }));
  });
  const ok = await interceptedDrag(cdp, { x: 10, y: 10 }, { x: 300, y: 200 }, { timeoutMs: 2_000 });
  assert.equal(ok, true);
  const steps = socket.sent.map((m) => (m.method === 'Input.dispatchMouseEvent' || m.method === 'Input.dispatchDragEvent' ? `${m.method.slice(6)}:${m.params!.type}` : `${m.method}:${JSON.stringify(m.params)}`));
  assert.equal(steps[0], 'Input.setInterceptDrags:{"enabled":true}');
  assert.equal(steps[1], 'dispatchMouseEvent:mousePressed');
  const dropAt = steps.indexOf('dispatchDragEvent:dragEnter');
  assert.ok(dropAt > 2, 'the drag starts only after the mouse moved');
  assert.deepEqual(steps.slice(dropAt), ['dispatchDragEvent:dragEnter', 'dispatchDragEvent:dragOver', 'dispatchDragEvent:drop', 'dispatchMouseEvent:mouseReleased', 'Input.setInterceptDrags:{"enabled":false}']);
  for (const drag of socket.sent.filter((m) => m.method === 'Input.dispatchDragEvent')) {
    assert.deepEqual([drag.params!.x, drag.params!.y], [300, 200]);
    assert.deepEqual(drag.params!.data, data);
  }
  cdp.close();
});

test('interceptedDrag gives up after timeoutMs: it releases the mouse, turns interception off and returns false', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  const started = Date.now();
  const ok = await interceptedDrag(cdp, { x: 10, y: 10 }, { x: 300, y: 200 }, { timeoutMs: 150 });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 2_000, 'bounded');
  assert.equal(socket.sent.filter((m) => m.method === 'Input.dispatchDragEvent').length, 0, 'nothing is dropped');
  const last = socket.sent.slice(-2);
  assert.equal(last[0].method, 'Input.dispatchMouseEvent');
  assert.equal(last[0].params!.type, 'mouseReleased');
  assert.deepEqual([last[1].method, last[1].params], ['Input.setInterceptDrags', { enabled: false }]);
  cdp.close();
});

test('webviewFrameRect evaluates in the workbench page and returns the visible frame that matches the page size within 2 px', async () => {
  const { cdp, socket } = await session();
  const frames = [
    { left: 0, top: 0, width: 1000, height: 700, visible: false },
    { left: 300, top: 35, width: 400, height: 300, visible: true },
    { left: 320, top: 70, width: 999, height: 701.5, visible: true }
  ];
  socket.onSend = (message) => { setImmediate(() => socket.reply(message.id, { result: { type: 'object', value: frames } })); };
  assert.deepEqual(await webviewFrameRect(cdp, { width: 1000, height: 700 }), { left: 320, top: 70, width: 999, height: 701.5 });
  const call = socket.sent[0];
  assert.equal(call.method, 'Runtime.evaluate');
  assert.equal(call.params!.returnByValue, true);
  assert.match(String(call.params!.expression), /iframe/);
  assert.equal(await webviewFrameRect(cdp, { width: 1200, height: 700 }), undefined);
  socket.onSend = (message) => { setImmediate(() => socket.reply(message.id, { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } })); };
  await assert.rejects(webviewFrameRect(cdp, { width: 1000, height: 700 }), /Uncaught/);
  cdp.close();
});

test('pressKey sends keyDown then keyUp with the key, code and key code for Escape, Enter and m', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await pressKey(cdp, 'Escape');
  await pressKey(cdp, 'Enter');
  await pressKey(cdp, 'm');
  assert.ok(socket.sent.every((m) => m.method === 'Input.dispatchKeyEvent'));
  assert.deepEqual(socket.sent.map((m) => [m.params!.type, m.params!.key, m.params!.code, m.params!.windowsVirtualKeyCode]), [
    ['keyDown', 'Escape', 'Escape', 27], ['keyUp', 'Escape', 'Escape', 27],
    ['keyDown', 'Enter', 'Enter', 13], ['keyUp', 'Enter', 'Enter', 13],
    ['keyDown', 'm', 'KeyM', 77], ['keyUp', 'm', 'KeyM', 77]
  ]);
  cdp.close();
});

test('pressKey sends ArrowDown with its code and key code and no text (62-23: the Move to... menu from the real keyboard)', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await pressKey(cdp, 'ArrowDown');
  assert.deepEqual(socket.sent.map((m) => [m.params!.type, m.params!.key, m.params!.code, m.params!.windowsVirtualKeyCode, m.params!.text]), [
    ['keyDown', 'ArrowDown', 'ArrowDown', 40, undefined], ['keyUp', 'ArrowDown', 'ArrowDown', 40, undefined]
  ]);
  cdp.close();
});

test('pressKey sends the letters a and u with their text (62-24: Assign to... and Unassign chosen by their first letter in Move to...)', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await pressKey(cdp, 'a');
  await pressKey(cdp, 'u');
  assert.deepEqual(socket.sent.map((m) => [m.params!.type, m.params!.key, m.params!.code, m.params!.windowsVirtualKeyCode, m.params!.text]), [
    ['keyDown', 'a', 'KeyA', 65, 'a'], ['keyUp', 'a', 'KeyA', 65, undefined],
    ['keyDown', 'u', 'KeyU', 85, 'u'], ['keyUp', 'u', 'KeyU', 85, undefined]
  ]);
  cdp.close();
});

// ---- 62.1-07: real hover, click, wheel and the timeline's keys (D-11: real input only) ------------------------------------------------------

// The 62.1-07 helpers, each looked up by name and asserted to exist before it is called (the 62.1-03 boardApi pattern), and every key press
// asserted not to fail, so a missing helper or key is an assertion failure.
interface InputHelpers {
  mouseMove(cdp: CdpSession, to: { x: number; y: number }, options?: { from?: { x: number; y: number }; steps?: number }): Promise<void>;
  mouseClick(cdp: CdpSession, at: { x: number; y: number }): Promise<void>;
  wheel(cdp: CdpSession, at: { x: number; y: number }, options: { deltaX?: number; deltaY: number; ctrl?: boolean }): Promise<void>;
  pressKey(cdp: CdpSession, key: string, options?: { ctrl?: boolean; shift?: boolean }): Promise<void>;
}
function helper<K extends keyof InputHelpers>(name: K): InputHelpers[K] {
  const found = (cdpClient as unknown as Record<string, unknown>)[name];
  assert.equal(typeof found, 'function', `cdp.ts exports ${name}`);
  return found as InputHelpers[K];
}
async function press(cdp: CdpSession, key: string, options?: { ctrl?: boolean; shift?: boolean }): Promise<void> {
  await assert.doesNotReject(helper('pressKey')(cdp, key, options), `pressKey knows ${key}`);
}

test('mouseMove sends mouseMoved with no button along a straight line in the asked number of steps, ending exactly at the target', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await helper('mouseMove')(cdp, { x: 50, y: 61 }, { from: { x: 10, y: 20 }, steps: 4 });
  assert.ok(socket.sent.every((m) => m.method === 'Input.dispatchMouseEvent'), 'only Input.dispatchMouseEvent is sent');
  const events = mouse(socket.sent);
  assert.deepEqual(events.map((e) => e.type), ['mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved']);
  assert.deepEqual(events.map((e) => [e.x, e.y]), [[20, 30.25], [30, 40.5], [40, 50.75], [50, 61]]);
  assert.ok(events.every((e) => e.button === 'none' && e.buttons === 0), 'no button is held while hovering');
  socket.sent.length = 0;
  await helper('mouseMove')(cdp, { x: 7, y: 9 });
  assert.deepEqual(mouse(socket.sent).map((e) => [e.type, e.x, e.y, e.button, e.buttons]), [['mouseMoved', 7, 9, 'none', 0]], 'without a start point it moves straight to the target once');
  cdp.close();
});

test('mouseClick moves to the point, then presses and releases the left button once there', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await helper('mouseClick')(cdp, { x: 120, y: 45.5 });
  const events = mouse(socket.sent);
  assert.deepEqual(events.map((e) => [e.type, e.x, e.y]), [['mouseMoved', 120, 45.5], ['mousePressed', 120, 45.5], ['mouseReleased', 120, 45.5]]);
  assert.deepEqual([events[0].button, events[0].buttons], ['none', 0]);
  assert.deepEqual([events[1].button, events[1].buttons, events[1].clickCount], ['left', 1, 1]);
  assert.deepEqual([events[2].button, events[2].buttons, events[2].clickCount], ['left', 0, 1]);
  cdp.close();
});

test('wheel sends one mouseWheel at the point with its deltas, and with ctrl it carries the Ctrl modifier (2)', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await helper('wheel')(cdp, { x: 300, y: 200 }, { deltaY: 120 });
  await helper('wheel')(cdp, { x: 310, y: 210 }, { deltaX: -40, deltaY: 0 });
  await helper('wheel')(cdp, { x: 320, y: 220 }, { deltaY: -100, ctrl: true });
  assert.ok(socket.sent.every((m) => m.method === 'Input.dispatchMouseEvent'));
  assert.deepEqual(mouse(socket.sent).map((e) => [e.type, e.x, e.y, e.deltaX, e.deltaY, e.modifiers]), [
    ['mouseWheel', 300, 200, 0, 120, 0], ['mouseWheel', 310, 210, -40, 0, 0], ['mouseWheel', 320, 220, 0, -100, 2]
  ]);
  cdp.close();
});

test('pressKey sends every timeline key with its key, code, key code and text (text only for printable keys)', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  const keys = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Space', 'F10', 'n', '+', '=', '-', '0'] as const;
  for (const key of keys) await press(cdp, key);
  assert.ok(socket.sent.every((m) => m.method === 'Input.dispatchKeyEvent'));
  const downs = socket.sent.filter((m) => m.params!.type === 'keyDown').map((m) => [m.params!.key, m.params!.code, m.params!.windowsVirtualKeyCode, m.params!.text]);
  assert.deepEqual(downs, [
    ['ArrowUp', 'ArrowUp', 38, undefined], ['ArrowLeft', 'ArrowLeft', 37, undefined], ['ArrowRight', 'ArrowRight', 39, undefined],
    ['Home', 'Home', 36, undefined], ['End', 'End', 35, undefined], ['PageUp', 'PageUp', 33, undefined], ['PageDown', 'PageDown', 34, undefined],
    ['Tab', 'Tab', 9, undefined], [' ', 'Space', 32, ' '], ['F10', 'F10', 121, undefined], ['n', 'KeyN', 78, 'n'],
    ['+', 'Equal', 187, '+'], ['=', 'Equal', 187, '='], ['-', 'Minus', 189, '-'], ['0', 'Digit0', 48, '0']
  ]);
  const ups = socket.sent.filter((m) => m.params!.type === 'keyUp');
  assert.equal(ups.length, keys.length, 'every key is released');
  assert.ok(ups.every((m) => m.params!.text === undefined), 'a key up carries no text');
  assert.ok(socket.sent.every((m) => m.params!.modifiers === undefined), 'no modifier unless asked');
  cdp.close();
});

test('pressKey with ctrl or shift sends the modifier (Ctrl 2, Shift 8) on both the key down and the key up: Ctrl+Home, Ctrl+End, Shift+F10', async () => {
  const { cdp, socket } = await session();
  socket.autoReply();
  await press(cdp, 'Home', { ctrl: true });
  await press(cdp, 'End', { ctrl: true });
  await press(cdp, 'F10', { shift: true });
  await press(cdp, 'Tab', { ctrl: true, shift: true });
  assert.deepEqual(socket.sent.map((m) => [m.params!.type, m.params!.key, m.params!.modifiers]), [
    ['keyDown', 'Home', 2], ['keyUp', 'Home', 2], ['keyDown', 'End', 2], ['keyUp', 'End', 2],
    ['keyDown', 'F10', 8], ['keyUp', 'F10', 8], ['keyDown', 'Tab', 10], ['keyUp', 'Tab', 10]
  ]);
  cdp.close();
});

test('connectCdp accepts localhost and refuses a look-alike address that only starts like 127.0.0.1 or localhost', async () => {
  const at = (url: string) => [{ type: 'page', url: 'x/workbench.html', webSocketDebuggerUrl: url }];
  const opened: string[] = [];
  const cdp = await connectCdp(9333, { fetchJson: async () => at('ws://localhost:9333/devtools/page/MAIN'), openSocket: (url) => { opened.push(url); return new FakeSocket(); } });
  assert.deepEqual(opened, ['ws://localhost:9333/devtools/page/MAIN']);
  cdp.close();
  for (const url of ['ws://127.0.0.1.example.com:9333/devtools/page/MAIN', 'ws://localhost.example.com:9333/devtools/page/MAIN', 'wss://127.0.0.1:9333/devtools/page/MAIN', 'ws://10.0.0.5:9333/devtools/page/MAIN']) {
    await assert.rejects(connectCdp(9333, { fetchJson: async () => at(url), openSocket: () => { throw new Error('must not open'); } }), /not on 127\.0\.0\.1; refusing/, url);
  }
});

test('the client drives only the Input domain: it never makes or dispatches DOM events, and it imports only Node built-ins', () => {
  const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'test', 'e2e', 'cdp.ts'), 'utf8');
  assert.equal(/new DragEvent|dispatchEvent/.test(source), false);
  assert.equal(/new (KeyboardEvent|MouseEvent|WheelEvent|PointerEvent|FocusEvent|InputEvent)/.test(source), false, 'no page event is made');
  // Every command the client sends is an Input domain command, except the one Runtime.evaluate that finds the webview frame's box.
  const methods = [...source.matchAll(/\.send(?:<[^>]*>)?\(\s*'([A-Za-z.]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length >= 5, `commands found: ${methods.join(', ')}`);
  assert.deepEqual(methods.filter((m) => !/^Input\./.test(m)), ['Runtime.evaluate'], `non-Input commands: ${methods.join(', ')}`);
  assert.match(source, /const LOCAL_SOCKET = \/\^ws:\\\/\\\/\(\?:127\\\.0\\\.0\\\.1\|localhost\):\\d\+\\\/\/;/, 'only local debugger addresses');
  const imports = source.split('\n').filter((line) => /^import /.test(line));
  assert.ok(imports.every((line) => /from 'node:/.test(line)), imports.join('\n'));
});
