// The DevTools Protocol client for the real-window board tests (Phase 62 plan 16, G-62-6): it finds the VS Code window, locates the board's webview
// frame and drags a card with real mouse input through Chromium's own input path. These tests run it against a fake socket that records every
// command and lets the test send replies and events.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { connectCdp, interceptedDrag, mouseDrag, pressKey, webviewFrameRect, workbenchTarget } from './e2e/cdp';
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

test('the client drives only the Input domain: it never makes or dispatches DOM events, and it imports only Node built-ins', () => {
  const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'test', 'e2e', 'cdp.ts'), 'utf8');
  assert.equal(/new DragEvent|dispatchEvent/.test(source), false);
  const imports = source.split('\n').filter((line) => /^import /.test(line));
  assert.ok(imports.every((line) => /from 'node:/.test(line)), imports.join('\n'));
});
