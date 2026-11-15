// Test-only DevTools Protocol client (Phase 62 plan 16, G-62-6). The board e2e (62-23) starts VS Code with a debugging port on 127.0.0.1, finds the
// workbench window here, locates the board's webview frame in it and drags a card with real mouse input (Input.dispatchMouseEvent), so the drag goes
// through Chromium's own input handling the way a person's mouse does. Nothing here makes or sends events inside the page.
// 62.1-07 adds real hover moves, clicks, wheel turns (with Ctrl for zoom) and the timeline's keys with Ctrl and Shift, for the timeline e2e.
// Node built-ins only: the global WebSocket (Node 22 and later) and node:http. Every wait is bounded. This file lives under src/test, which never
// ships (the release check forbids dist/test).
import * as http from 'node:http';

export interface Point { x: number; y: number }

/** The part of a WebSocket this client uses (the global WebSocket fits; tests pass a fake). readyState 1 means open. */
export interface SocketLike {
  readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, listener: (params: any) => void): () => void;
  close(): void;
}

export type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
type Rect = { left: number; top: number; width: number; height: number };

const OPEN = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const LOCAL_SOCKET = /^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The VS Code window: the page target whose url ends with workbench.html and that can be debugged. */
export function workbenchTarget(targets: Target[]): { webSocketDebuggerUrl: string } | undefined {
  const found = targets.find((t) => t.type === 'page' && /workbench\.html$/.test(t.url) && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl !== '');
  return found ? { webSocketDebuggerUrl: found.webSocketDebuggerUrl! } : undefined;
}

/** A browser tab showing code-server (0.6.3 re-test): the page target whose url is on that origin, for example http://127.0.0.1:8080/?folder=... */
export function originTarget(targets: Target[], origin: string): { webSocketDebuggerUrl: string } | undefined {
  const found = targets.find((t) => t.type === 'page' && (t.url === origin || t.url.startsWith(`${origin}/`)) && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl !== '');
  return found ? { webSocketDebuggerUrl: found.webSocketDebuggerUrl! } : undefined;
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; if (body.length > 4_000_000) request.destroy(new Error('the DevTools target list is too large')); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`the DevTools target list is not JSON: ${(error as Error).message}`)); } });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${url} did not answer within ${timeoutMs} ms`)));
    request.on('error', reject);
  });
}

function messageText(event: any): string {
  const data = event && 'data' in event ? event.data : event;
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
}

/**
 * Connects to the VS Code window's DevTools endpoint on 127.0.0.1:<port>, or to the page `pick` chooses (the code-server tab of a browser). Refuses any
 * debugger address that is not on this computer.
 */
export async function connectCdp(port: number, deps: { fetchJson?: (url: string) => Promise<unknown>; openSocket?: (url: string) => SocketLike; timeoutMs?: number; pick?: (targets: Target[]) => { webSocketDebuggerUrl: string } | undefined } = {}): Promise<CdpSession> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const list = await (deps.fetchJson ?? ((url: string) => getJson(url, timeoutMs)))(listUrl);
  const targets = Array.isArray(list) ? (list as Target[]) : [];
  const target = (deps.pick ?? workbenchTarget)(targets);
  if (!target) throw new Error(`No ${deps.pick ? 'matching page' : 'VS Code window (a page ending in workbench.html)'} on port ${port}. Pages seen: ${targets.map((t) => `${t.type} ${t.url}`).join(', ') || 'none'}`);
  if (!LOCAL_SOCKET.test(target.webSocketDebuggerUrl)) throw new Error(`The debugger address ${target.webSocketDebuggerUrl} is not on 127.0.0.1; refusing to connect`);

  const socket = deps.openSocket ? deps.openSocket(target.webSocketDebuggerUrl) : (new WebSocket(target.webSocketDebuggerUrl) as unknown as SocketLike);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const listeners = new Map<string, Set<(params: any) => void>>();
  let closed = false;
  let nextId = 1;

  const shut = (reason: string): void => {
    if (closed) return;
    closed = true;
    for (const [, call] of pending) { clearTimeout(call.timer); call.reject(new Error(reason)); }
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
    try { message = JSON.parse(messageText(event)); } catch { return; }
    if (typeof message.id === 'number') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(`DevTools refused: ${message.error.message ?? 'unknown error'}`));
      else call.resolve(message.result);
    } else if (typeof message.method === 'string') {
      for (const listener of [...(listeners.get(message.method) ?? [])]) listener(message.params);
    }
  });
  socket.addEventListener('close', () => shut('The DevTools connection closed'));
  socket.addEventListener('error', () => shut('The DevTools connection closed after an error'));

  if (socket.readyState !== OPEN) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`The DevTools connection did not open within ${timeoutMs} ms`)); try { socket.close(); } catch { /* already closed */ } }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('The DevTools connection closed before it opened')); });
    });
  }

  return {
    send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) return Promise.reject(new Error('The DevTools connection closed'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error as Error); }
      });
    },
    on(event: string, listener: (params: any) => void): () => void {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => { set.delete(listener); };
    },
    close(): void {
      shut('The DevTools connection closed');
      try { socket.close(); } catch { /* already closed */ }
    }
  };
}

// Runs in the workbench page: the box of every iframe in CSS pixels of the window, and whether it is shown. Matching by size happens in Node.
const FRAME_EXPRESSION = `(() => Array.from(document.querySelectorAll('iframe')).map((f) => {
  const r = f.getBoundingClientRect();
  const s = getComputedStyle(f);
  return { left: r.left, top: r.top, width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' };
}))()`;

/** The visible webview iframe whose size matches the board page's viewport (2 px tolerance): where the page's (0, 0) sits in the window. */
export async function webviewFrameRect(cdp: CdpSession, size: { width: number; height: number }): Promise<Rect | undefined> {
  const answer = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: FRAME_EXPRESSION, returnByValue: true });
  if (answer.exceptionDetails) throw new Error(`Finding the webview frame failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? 'unknown error'}`);
  const frames = Array.isArray(answer.result?.value) ? (answer.result!.value as Array<Rect & { visible: boolean }>) : [];
  const matches = frames
    .filter((f) => f.visible && Math.abs(f.width - size.width) <= 2 && Math.abs(f.height - size.height) <= 2)
    .sort((a, b) => (Math.abs(a.width - size.width) + Math.abs(a.height - size.height)) - (Math.abs(b.width - size.width) + Math.abs(b.height - size.height)));
  const best = matches[0];
  return best ? { left: best.left, top: best.top, width: best.width, height: best.height } : undefined;
}

const mouseEvent = (cdp: CdpSession, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', at: Point, buttons: number): Promise<unknown> =>
  cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons, clickCount: 1 });

const along = (from: Point, to: Point, share: number): Point => ({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share });

// The DevTools Protocol's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
const MODIFIER = { ctrl: 2, shift: 8 } as const;

// 62.1-07: a hover with no button held (Chromium's own hover, so the page sees pointer and mouse moves as from a person).
const hoverEvent = (cdp: CdpSession, at: Point): Promise<unknown> => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });

/** A hover move with real mouse input: from the start point to exactly the target in steps along a straight line, or one move to the target. */
export async function mouseMove(cdp: CdpSession, to: Point, options: { from?: Point; steps?: number } = {}): Promise<void> {
  if (!options.from) { await hoverEvent(cdp, to); return; }
  const steps = Math.max(1, Math.floor(options.steps ?? 8));
  for (let step = 1; step <= steps; step += 1) await hoverEvent(cdp, step === steps ? to : along(options.from, to, step / steps));
}

/** A click with real mouse input: move to the point, press and release the left button there. */
export async function mouseClick(cdp: CdpSession, at: Point): Promise<void> {
  await hoverEvent(cdp, at);
  await mouseEvent(cdp, 'mousePressed', at, 1);
  await mouseEvent(cdp, 'mouseReleased', at, 0);
}

/** One wheel turn with real input at the point: deltaY scrolls down when positive, deltaX right; ctrl holds Ctrl (Ctrl+wheel zooms the timeline). */
export async function wheel(cdp: CdpSession, at: Point, options: { deltaX?: number; deltaY: number; ctrl?: boolean }): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: options.deltaX ?? 0, deltaY: options.deltaY, modifiers: options.ctrl ? MODIFIER.ctrl : 0 });
}

/** A drag with real mouse input: press at from, move in steps with the button held to exactly to, run whileOver, release at to. */
export async function mouseDrag(cdp: CdpSession, from: Point, to: Point, options: { steps?: number; pauseMs?: number; whileOver?: () => Promise<void> } = {}): Promise<void> {
  const steps = Math.max(1, Math.floor(options.steps ?? 12));
  const pauseMs = Math.max(0, options.pauseMs ?? 16);
  let released = false;
  await mouseEvent(cdp, 'mousePressed', from, 1);
  try {
    for (let step = 1; step <= steps; step += 1) {
      await mouseEvent(cdp, 'mouseMoved', step === steps ? to : along(from, to, step / steps), 1);
      if (pauseMs) await sleep(pauseMs);
    }
    if (options.whileOver) await options.whileOver();
    released = true;
    await mouseEvent(cdp, 'mouseReleased', to, 0);
  } finally {
    // Never leave the window with the button held down.
    if (!released) await mouseEvent(cdp, 'mouseReleased', to, 0).catch(() => undefined);
  }
}

/**
 * The fallback when a plain mouse drag does not reach the page's drop handler: Chromium intercepts the drag it starts from real mouse input
 * (Input.setInterceptDrags), then the drop is delivered at to with Input.dispatchDragEvent. Returns false when no drag was intercepted in time.
 */
export async function interceptedDrag(cdp: CdpSession, from: Point, to: Point, options: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let data: unknown;
  let wake: (() => void) | undefined;
  const off = cdp.on('Input.dragIntercepted', (params) => { data = params?.data; wake?.(); });
  const waitForDrag = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
  });
  await cdp.send('Input.setInterceptDrags', { enabled: true });
  try {
    await mouseEvent(cdp, 'mousePressed', from, 1);
    const deadline = Date.now() + timeoutMs;
    const steps = 20;
    let step = 0;
    while (data === undefined && Date.now() < deadline) {
      step += 1;
      // Walk toward the target, then keep nudging around it until Chromium starts the drag or time runs out.
      const at = step <= steps ? along(from, to, step / steps) : { x: to.x + (step % 2 ? 1 : -1), y: to.y };
      await mouseEvent(cdp, 'mouseMoved', at, 1);
      if (data === undefined) await waitForDrag(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    if (data === undefined) {
      await mouseEvent(cdp, 'mouseReleased', to, 0);
      return false;
    }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
    await mouseEvent(cdp, 'mouseReleased', to, 0);
    return true;
  } finally {
    off();
    await cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
  }
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  m: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
  a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' },
  u: { key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, text: 'u' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  // 62.1-07: the timeline's keys (62.1-UI-SPEC "Keyboard Model" and the amendment's N).
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  '+': { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+' },
  // 61-33: opening a view from the Command Palette in code-server.
  p: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, text: 'p' },
  '=': { key: '=', code: 'Equal', windowsVirtualKeyCode: 187, text: '=' },
  '-': { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, text: '-' },
  '0': { key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, text: '0' }
} as const;

/**
 * A key press with real keyboard input: keyDown then keyUp. With ctrl or shift the modifier is held on both events (Ctrl+Home, Shift+F10); a
 * key held with Ctrl types no text.
 */
export async function pressKey(cdp: CdpSession, key: keyof typeof KEYS, options: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  const k = KEYS[key] as { key: string; code: string; windowsVirtualKeyCode: number; text?: string };
  const modifiers = (options.ctrl ? MODIFIER.ctrl : 0) | (options.shift ? MODIFIER.shift : 0);
  const { text, ...base } = k;
  const held = modifiers ? { modifiers } : {};
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text !== undefined && !options.ctrl ? { text } : {}), ...held });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, ...held });
}
