// The Team Board in code-server, in a real browser (0.6.3 re-test, debug session .planning/debug/board-codeserver-cards-and-drag.md). The owner's
// code-server re-test failed where the real VS Code window passed, so this test serves the board's own media/board files from code-server the way the
// extension does (a webview panel: the workbench, the webview host frame, then the board page) and drives a real browser with real mouse input
// through the DevTools Protocol (Input.dispatchMouseEvent), never with page-made events.
//
// It opens the owner's board shape (one planless phase card in Backlog, done plans in a folded Done, nobody assigned) and checks:
//   1. the lane count names the cards in folded columns, the folded Done cell shows its number, and the open Backlog header is not a tall empty box;
//   2. a real drag of the phase card is picked up and its drop shows the phase card's reason, with no move request;
//   3. after a real click opens Done, a real drag of a done plan onto Backlog sends exactly one reopen request and the page says it was reopened;
//   4. as the developer (owner decision 2026-11-04, 62-27: assignees move their own cards), on the same board plus a Ready plan a lead assigned to the
//      developer and one the lead assigned to themselves: a real drop of the developer's plan on Cancelled is refused with the cancel sentence, a real
//      drag of the lead's plan is picked up and refused with the not-assignee sentence, and a real drag of the developer's plan onto Backlog of its row
//      sends exactly one hold request. None of the refused drops sends anything;
//   5. the timeline (62.1-09, D-11, UI-SPEC browser backstop), on the owner's board again with the timeline the host builds (buildTimeline): a real
//      click on Timeline draws the dots, a real hover on the phase card's dot shows the preview within 1 s, a real click opens the card with focus on
//      its title, a real Escape closes it with focus back on the dot, and a real click on a done plan's dot, its Move to... and Backlog (reopen) sends
//      exactly one reopen request, the card is held in Backlog and its dot shows the hold.
//
// Not part of npm test: it needs a code-server install and a Chromium-based browser, and runs only on a hidden xvfb-run screen. For example:
//   npm run compile && NEAR_AI_CODE_SERVER=/path/to/code-server NEAR_AI_E2E_BROWSER=/path/to/chrome xvfb-run -a node dist/test/e2e/codeServerBoard.js
// NEAR_AI_CODE_SERVER is the code-server folder that holds bin/code-server (the owner's image keeps it in /usr/lib/code-server; `docker cp` copies it
// out). NEAR_AI_E2E_SHOTS=<folder> keeps a screenshot of each step. Everything else lives in a fresh temporary folder that is removed at the end.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildBoardModel, planMove } from '../../domain/team/board';
import type { BoardModel, MoveKey } from '../../domain/team/board';
import { buildTimeline } from '../../domain/team/timeline';
import { REFUSALS } from '../../domain/team/boardText';
import { boardWorld, seedRetestBoard } from '../helpers/teamBoardWorld';
import type { BoardWorld } from '../helpers/teamBoardWorld';
import type { TestActor } from '../helpers/teamEvents';
import { connectCdp, mouseDrag, mouseMove, originTarget, pressKey } from './cdp';
import type { CdpSession, Point } from './cdp';

const USAGE = 'Set NEAR_AI_CODE_SERVER to a code-server folder (with bin/code-server) and NEAR_AI_E2E_BROWSER to a Chromium-based browser, then run under xvfb-run, for example: NEAR_AI_CODE_SERVER=/path/to/code-server NEAR_AI_E2E_BROWSER=/path/to/chrome xvfb-run -a node dist/test/e2e/codeServerBoard.js';
const HIDDEN_SCREEN_ONLY = 'This test runs only on a hidden virtual screen. Start it with xvfb-run, for example: xvfb-run -a node dist/test/e2e/codeServerBoard.js';
const MEDIA = path.resolve(__dirname, '../../../media/board');
// The page's scripts are boardView.ts's own BOARD_SCRIPTS (timeline.js included since 62.1), read from its source because boardView.ts needs the
// vscode module, which this test does not run in. A list that cannot be read stops the run.
function boardScripts(): string[] {
  const source = readFileSync(path.resolve(__dirname, '../../../src/services/team/boardView.ts'), 'utf8');
  const list = /export const BOARD_SCRIPTS = \[([^\]]*)\]/.exec(source)?.[1];
  const files = list === undefined ? [] : [...list.matchAll(/'([a-z-]+\.js)'/g)].map((m) => m[1]!);
  if (files.length === 0 || !files.includes('board.js')) throw new Error('BOARD_SCRIPTS could not be read from src/services/team/boardView.ts');
  return files;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// The same rule as run.ts (owner, 2026-11-03): only a screen xvfb-run made, never the person's own screen; DISPLAY alone is never trusted.
function onHiddenScreen(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'linux') return true;
  const auth = env.XAUTHORITY ?? '';
  if (auth !== '' && /^xvfb-run\.[A-Za-z0-9]+$/.test(path.basename(path.dirname(auth))) && existsSync(auth)) return true;
  const fbdir = env.NEAR_AI_E2E_FBDIR ?? '';
  return fbdir !== '' && existsSync(path.join(fbdir, 'Xvfb_screen0'));
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => { if (port > 0) resolve(port); else reject(new Error('No free port on 127.0.0.1')); });
    });
  });
}

function healthy(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode === 200); });
    request.setTimeout(2_000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { const value = await probe(); if (value !== undefined) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
}

// The test extension: a webview panel with the board's own files, the page markup boardView.ts writes (nonce CSP, one script tag per file, data-e2e
// so the page keeps its drag log), the recorded model on 'ready', and every message from the page written to a log. A move is only logged: the test
// plans it with the real model for the step's viewer and accepts its intents into the step's signed world (owner decision 2026-11-05, 62-28), then
// writes the rebuilt model to the file, which the harness posts as the host does when the session changes. The harness never moves a card itself.
const HARNESS_JS = `const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
function activate(context) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'board');
  const log = (m) => fs.appendFileSync(process.env.HARNESS_LOG, JSON.stringify(m) + '\\n');
  let model = JSON.parse(fs.readFileSync(process.env.HARNESS_MODEL, 'utf8'));
  const panel = vscode.window.createWebviewPanel('nearAiTeamBoard', 'Team Board', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
  const nonce = crypto.randomBytes(16).toString('base64');
  const asset = (f) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  const scripts = JSON.parse(process.env.HARNESS_SCRIPTS).map((f) => '<script nonce="' + nonce + '" src="' + asset(f) + '"></script>').join('\\n');
  panel.webview.html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; style-src ' + panel.webview.cspSource + '; script-src \\'nonce-' + nonce + '\\';">'
    + '<link rel="stylesheet" href="' + asset('board.css') + '"><title>Team Board</title></head><body data-e2e="1"><div id="root"></div>'
    + '<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>' + scripts + '</body></html>';
  fs.watchFile(process.env.HARNESS_MODEL, { interval: 200 }, () => {
    model = JSON.parse(fs.readFileSync(process.env.HARNESS_MODEL, 'utf8'));
    panel.webview.postMessage({ type: 'state', model });
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(process.env.HARNESS_MODEL) });
  panel.webview.onDidReceiveMessage((m) => {
    log(m);
    if (m && m.type === 'ready') panel.webview.postMessage({ type: 'state', model });
  });
}
module.exports = { activate, deactivate() {} };
`;

// Runs in the board page: what it drew, where (in window pixels: the page's place in the window is added up through the frame elements, which code-server
// serves from its own origin), and what it said. The walk goes through frameElement's document, not window.parent: VS Code's webview host makes the
// board page's window.parent the page itself, so a walk up window.parent never ends.
const FACTS = `(() => {
  let x = 0, y = 0, w = window, n = 0;
  for (; w.frameElement && n < 5; n += 1) { const f = w.frameElement; const r = f.getBoundingClientRect(); x += r.left + f.clientLeft; y += r.top + f.clientTop; w = f.ownerDocument.defaultView; }
  if (!w.document.querySelector('.monaco-workbench')) return { error: 'the frames above the board do not lead to the workbench (' + n + ' frames up)' };
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left + x, top: r.top + y, width: r.width, height: r.height }; };
  const all = (s) => Array.from(document.querySelectorAll(s));
  return {
    heads: all('.colheads .column').map((h) => Object.assign({ column: h.getAttribute('data-column'), count: (h.querySelector('.col-count') || {}).textContent || '' }, box(h))),
    laneCounts: all('.lane').map((l) => [l.getAttribute('data-lane'), (l.querySelector('.lane-count') || {}).textContent || '']),
    cells: all('.lanes .cell').map((c) => Object.assign({ column: c.getAttribute('data-column'), lane: c.getAttribute('data-lane'), folded: c.classList.contains('collapsed'), shownCount: (c.querySelector('.folded-count') || {}).textContent || '', cards: all('.cell[data-column="' + c.getAttribute('data-column') + '"][data-lane="' + c.getAttribute('data-lane') + '"] .card').map((n) => n.getAttribute('data-id')) }, box(c))),
    cards: all('.card').map((c) => Object.assign({ id: c.getAttribute('data-id'), draggable: c.getAttribute('draggable') === 'true', refusal: (c.querySelector('.refusal-line') || {}).textContent || '' }, box(c))),
    dragLog: window.NearAiBoard.dragLog(), live: (document.getElementById('live') || {}).textContent || '',
    view: box(document.querySelector('.board-scroll') || document.body)
  };
})()`;

// Runs in the board page for the timeline steps (62.1-09): the Timeline button, the dots with their state, the preview and the card when shown, the
// card's buttons, the open menu's items, and what has focus, all in window pixels as in FACTS.
const TIMELINE_FACTS = `(() => {
  let x = 0, y = 0, w = window, n = 0;
  for (; w.frameElement && n < 5; n += 1) { const f = w.frameElement; const r = f.getBoundingClientRect(); x += r.left + f.clientLeft; y += r.top + f.clientTop; w = f.ownerDocument.defaultView; }
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left + x, top: r.top + y, width: r.width, height: r.height }; };
  const all = (s) => Array.from(document.querySelectorAll(s));
  const shown = (n) => !!n && n.isConnected && !n.hidden && n.getBoundingClientRect().width > 0;
  const named = (b) => ((b.textContent || '').trim() || b.getAttribute('aria-label') || '').trim();
  const button = document.querySelector('#view-switch button[data-view="timeline"]');
  const preview = document.getElementById('tl-preview');
  const card = document.getElementById('tl-card');
  const a = document.activeElement;
  return {
    timelineButton: button ? box(button) : null,
    dots: all('.tl-dot').map((d) => Object.assign({ id: d.getAttribute('data-id'), state: d.getAttribute('data-state') || '' }, box(d))),
    preview: shown(preview) ? box(preview) : null,
    card: shown(card) ? Object.assign({ buttons: all('#tl-card button').map((b) => Object.assign({ name: named(b) }, box(b))) }, box(card)) : null,
    menu: all('#menu [role="menuitem"]').filter(shown).map((m) => Object.assign({ text: (m.textContent || '').trim() }, box(m))),
    focus: a ? { id: a.id || '', dot: a.classList && a.classList.contains('tl-dot') ? a.getAttribute('data-id') : null } : null,
    live: (document.getElementById('live') || {}).textContent || ''
  };
})()`;
interface TimelineFacts {
  timelineButton: Box | null;
  dots: Array<Box & { id: string; state: string }>;
  preview: Box | null;
  card: (Box & { buttons: Array<Box & { name: string }> }) | null;
  menu: Array<Box & { text: string }>;
  focus: { id: string; dot: string | null } | null;
  live: string;
}

interface Box { left: number; top: number; width: number; height: number }
interface Facts {
  error?: string;
  heads: Array<Box & { column: string; count: string }>;
  laneCounts: Array<[string, string]>;
  cells: Array<Box & { column: string; lane: string; folded: boolean; shownCount: string; cards: string[] }>;
  cards: Array<Box & { id: string; draggable: boolean; refusal: string }>;
  dragLog: Array<{ event: string; column: string; lane: string; verdict: string }>;
  live: string;
  // The board's scrolling area in window pixels, so a step can tell whether a point it is about to press is on screen.
  view: Box;
}

function stop(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 2_000).unref();
}

async function main(): Promise<void> {
  const codeServer = process.env.NEAR_AI_CODE_SERVER ?? '';
  const browser = process.env.NEAR_AI_E2E_BROWSER ?? '';
  if (codeServer === '' || !existsSync(path.join(codeServer, 'bin', 'code-server')) || browser === '' || !existsSync(browser)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!onHiddenScreen(process.env)) {
    console.error(HIDDEN_SCREEN_ONLY);
    process.exitCode = 1;
    return;
  }
  const shots = process.env.NEAR_AI_E2E_SHOTS ?? '';
  if (shots !== '') mkdirSync(shots, { recursive: true });

  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-e2e-codeserver-'));
  // code-server writes its logs, heartbeat and default config under HOME and the XDG folders; they all point into the temporary folder, so nothing is
  // written to the person's home folder. The Wayland variables go, so the browser stays on the hidden X screen.
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_SESSION_TYPE: 'x11', HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home', '.config'), XDG_DATA_HOME: path.join(root, 'home', '.local', 'share'), XDG_CACHE_HOME: path.join(root, 'home', '.cache') };
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  mkdirSync(path.join(root, 'home'));
  let server: ChildProcess | undefined;
  let tab: ChildProcess | undefined;
  let cdp: CdpSession | undefined;
  let failures = 0;
  const check = (ok: boolean, text: string, detail = ''): void => {
    console.log(`${ok ? 'ok' : 'not ok'} - ${text}${ok || detail === '' ? '' : `\n    ${detail}`}`);
    if (!ok) failures += 1;
  };
  try {
    // The owner's board shape, built by the real model over a signed in-memory log, seen by the owner.
    const world = await boardWorld();
    seedRetestBoard(world, 3, { readyShaped: true });
    // The owner's view of the stepped world, rebuilt after every accepted move so the page draws what the signed log now says.
    const ownerView = (): BoardModel => buildBoardModel(world.state, { nowMs: Date.now(), status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: world.owner.memberId });
    const model = ownerView();
    const ext = path.join(root, 'extensions', 'test.near-ai-board-harness-0.0.1');
    mkdirSync(path.join(ext, 'media', 'board'), { recursive: true });
    for (const file of readdirSync(MEDIA)) if (/\.(js|css)$/.test(file) && file !== 'layout-probe.js') copyFileSync(path.join(MEDIA, file), path.join(ext, 'media', 'board', file));
    writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ name: 'near-ai-board-harness', publisher: 'test', version: '0.0.1', engines: { vscode: '^1.90.0' }, main: './extension.js', activationEvents: ['onStartupFinished'] }));
    writeFileSync(path.join(ext, 'extension.js'), HARNESS_JS);
    const modelFile = path.join(root, 'model.json');
    const logFile = path.join(root, 'page-messages.log');
    writeFileSync(modelFile, JSON.stringify(model));
    writeFileSync(logFile, '');
    mkdirSync(path.join(root, 'user', 'User'), { recursive: true });
    writeFileSync(path.join(root, 'user', 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.tips.enabled': false, 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'update.mode': 'none', 'chat.disableAIFeatures': true }));
    mkdirSync(path.join(root, 'project'));
    writeFileSync(path.join(root, 'project', 'README.md'), 'Board test project\n');
    // A config file of its own, so code-server never writes one into the person's home folder.
    writeFileSync(path.join(root, 'config.yaml'), 'bind-addr: 127.0.0.1:0\nauth: none\ncert: false\n');

    const port = await freeLocalPort();
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(path.join(codeServer, 'bin', 'code-server'), ['--config', path.join(root, 'config.yaml'), '--auth', 'none', '--bind-addr', `127.0.0.1:${port}`, '--user-data-dir', path.join(root, 'user'),
      '--extensions-dir', path.join(root, 'extensions'), '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', '--disable-getting-started-override', path.join(root, 'project')],
    { env: { ...env, HARNESS_MODEL: modelFile, HARNESS_LOG: logFile, HARNESS_SCRIPTS: JSON.stringify(boardScripts()) }, detached: true, stdio: 'ignore' });
    await until('code-server to answer', async () => ((await healthy(`${origin}/healthz`)) ? true : undefined), 60_000);
    const version = (await new Promise<string>((resolve) => { const p = spawn(path.join(codeServer, 'bin', 'code-server'), ['--version'], { env }); let out = ''; p.stdout.on('data', (d) => { out += String(d); }); p.on('close', () => resolve(out.split('\n').find((line) => /^\d+\.\d+\.\d+ /.test(line)) ?? 'unknown')); }));
    console.log(`(code-server ${version} on ${origin})`);

    const profile = path.join(root, 'browser');
    tab = spawn(browser, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--ozone-platform=x11', '--remote-debugging-port=0', '--window-position=0,0',
      '--window-size=1600,1000', '--force-device-scale-factor=1', '--password-store=basic', `${origin}/?folder=${encodeURIComponent(path.join(root, 'project'))}`], { env, detached: true, stdio: 'ignore' });
    const devtools = await until('the browser DevTools port', () => {
      const file = path.join(profile, 'DevToolsActivePort');
      const first = existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) : 0;
      return first > 0 ? first : undefined;
    }, 60_000);
    cdp = await until('the code-server tab', () => connectCdp(devtools, { pick: (targets) => originTarget(targets, origin), timeoutMs: 30_000 }), 60_000);
    const session = cdp;
    const product = await session.send<{ product?: string }>('Browser.getVersion').catch(() => ({ product: 'unknown' }));
    console.log(`(browser ${product.product ?? 'unknown'})`);

    // Every frame's own page context, so the board page (two frames down) can be asked what it drew.
    const contexts = new Set<number>();
    session.on('Runtime.executionContextCreated', (p) => { if (p?.context?.auxData?.isDefault) contexts.add(p.context.id as number); });
    session.on('Runtime.executionContextDestroyed', (p) => { contexts.delete(p?.executionContextId as number); });
    session.on('Runtime.executionContextsCleared', () => contexts.clear());
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    const evaluate = async <T>(contextId: number, expression: string): Promise<T> => {
      const answer = await session.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression, contextId, returnByValue: true });
      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text ?? 'evaluation failed');
      return answer.result?.value as T;
    };
    const boardContext = await until('the board page with its cards', async () => {
      for (const id of [...contexts]) if (await evaluate<boolean>(id, `!!window.NearAiBoard && !!document.querySelector('.card')`).catch(() => false)) return id;
      return undefined;
    }, 120_000);
    const facts = async (): Promise<Facts> => {
      const value = await evaluate<Facts>(boardContext, FACTS);
      if (value.error) throw new Error(value.error);
      return value;
    };
    const photo = async (name: string): Promise<void> => {
      if (shots === '') return;
      const picture = await session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(shots, name), Buffer.from(picture.data, 'base64'));
    };
    const messages = (): Array<Record<string, unknown>> => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    // A move request from the page is planned with the real model for the step's viewer and accepted into the step's signed world, every intent in
    // order (owner decision 2026-11-05, 62-28), then the rebuilt model is written for the harness to post, as the host does after the signed event.
    // The harness never moves a card itself, so a move the log would refuse fails the step instead of being drawn.
    let handledMoves = 0;
    const applyMoves = (source: BoardWorld, actor: TestActor, viewerId: string, rebuild: () => BoardModel): void => {
      const pending = messages().filter((m) => m.type === 'move').slice(handledMoves);
      handledMoves += pending.length;
      for (const request of pending) {
        const itemId = String(request.itemId);
        const target = String(request.target) as MoveKey;
        const planned = planMove(source.state, viewerId, itemId, target);
        if (!planned.ok) throw new Error(`the page asked for ${target} on ${itemId} and the model refused it: ${planned.reason}`);
        for (const intent of planned.intents) source.accept(actor, intent.type, intent.body as never);
      }
      if (pending.length > 0) writeFileSync(modelFile, JSON.stringify(rebuild()));
    };
    const middle = (b: Box): Point => ({ x: b.left + b.width / 2, y: b.top + Math.min(40, b.height / 2) });
    const grip = (b: Box): Point => ({ x: b.left + Math.min(40, b.width / 2), y: b.top + 20 });
    const click = async (at: Point): Promise<void> => {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const cellOf = (f: Facts, column: string, lane = 'unassigned'): Facts['cells'][number] | undefined => f.cells.find((c) => c.column === column && c.lane === lane);
    const head = (f: Facts, column: string): Facts['heads'][number] | undefined => f.heads.find((h) => h.column === column);
    // Step 4 works in rows and columns further right and down than the editor shows, so it scrolls the board's own area (as a person would with the
    // scroll bars) to put what it is about to press on screen. Only the scroll position is set this way; every press and drag is real mouse input.
    const reveal = async (selector: string, inline: 'start' | 'end'): Promise<void> => {
      await evaluate<boolean>(boardContext, `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.scrollIntoView({ block: 'center', inline: '${inline}' }); return true; })()`);
      await sleep(300);
    };
    const onScreen = (p: Point, v: Box): boolean => p.x > v.left && p.x < v.left + v.width && p.y > v.top && p.y < v.top + v.height;
    // A cold code-server start keeps the page busy for a while; the first reading waits for an answer that shows the drawn board.
    let f = await until('the first reading of the board', async () => { const now = await facts(); return now.cards.length > 0 ? now : undefined; }, 120_000);
    await sleep(1_000);
    f = await facts();

    // 1. What the owner saw: the counts say where the cards are.
    await photo('codeserver-1-first-open.png');
    check(head(f, 'backlog')?.count === '1' && head(f, 'done')?.count === '3', 'the headers count Backlog 1 and Done 3', JSON.stringify(f.heads.map((h) => [h.column, h.count])));
    check(cellOf(f, 'backlog')?.cards.includes('phase:63') === true, 'the phase card is drawn in Backlog of the Unassigned row', JSON.stringify(cellOf(f, 'backlog')));
    check(f.laneCounts.some(([lane, text]) => lane === 'unassigned' && text === '(4, 3 in folded columns)'), 'the Unassigned row says (4, 3 in folded columns)', JSON.stringify(f.laneCounts));
    check(cellOf(f, 'done')?.folded === true && cellOf(f, 'done')?.shownCount === '3' && cellOf(f, 'done')?.cards.length === 0, 'the folded Done cell shows 3 and holds no card', JSON.stringify(cellOf(f, 'done')));
    const backlogHead = head(f, 'backlog');
    const doneHead = head(f, 'done');
    check(backlogHead !== undefined && doneHead !== undefined && backlogHead.height < doneHead.height - 20, 'the open Backlog header is as tall as its words, not stretched to the turned names of the folded ones', `Backlog ${backlogHead?.height} px, Done ${doneHead?.height} px`);

    // 2. A real drag of the phase card: picked up, refused with its reason, nothing sent.
    const phase = f.cards.find((c) => c.id === 'phase:63');
    const ready = cellOf(f, 'ready');
    check(phase?.draggable === true, 'the phase card can be picked up');
    if (phase && ready) {
      await mouseDrag(session, grip(phase), middle(ready), { steps: 15, pauseMs: 20 });
      f = await until('the refusal on the phase card', async () => { const now = await facts(); return now.cards.find((c) => c.id === 'phase:63')?.refusal ? now : undefined; }, 10_000).catch(async () => facts());
      await photo('codeserver-2-phase-card-refused.png');
      const log = f.dragLog;
      check(log.some((e) => e.event === 'dragstart' && e.verdict === 'started'), 'the browser started the drag', JSON.stringify(log));
      check(log.some((e) => e.event === 'drop' && e.column === 'ready' && e.verdict === 'no'), 'the drop on Ready was refused', JSON.stringify(log));
      check(f.cards.find((c) => c.id === 'phase:63')?.refusal === REFUSALS.phaseCard, 'the card shows the phase card reason', JSON.stringify(f.cards.find((c) => c.id === 'phase:63')));
      check(!messages().some((m) => m.type === 'move'), 'no move request was sent');
    }

    // 3. A real click opens Done, then a real drag reopens a finished plan in Backlog, and a second real drag releases it to Ready. The plans are
    // ready-shaped (files, an estimate, a finished dependency), so the reopen has to hold the card in Backlog to stay where it was dropped.
    const done = head(f, 'done');
    if (done) await click({ x: done.left + done.width / 2, y: done.top + 24 });
    f = await until('Done open with its cards', async () => { const now = await facts(); return (cellOf(now, 'done')?.cards.length ?? 0) === 3 ? now : undefined; }, 10_000).catch(async () => facts());
    check(cellOf(f, 'done')?.cards.length === 3 && f.laneCounts.some(([lane, text]) => lane === 'unassigned' && text === '(4)'), 'a real click opens Done: its 3 cards are drawn and the row says (4)', JSON.stringify(f.laneCounts));
    const plan = f.cards.find((c) => c.id === 'plan:60-03');
    const backlog = cellOf(f, 'backlog');
    if (plan && backlog) {
      await mouseDrag(session, grip(plan), middle(backlog), { steps: 15, pauseMs: 20 });
      f = await until('the reopen request', async () => (messages().filter((m) => m.type === 'move').length > 0 ? await facts() : undefined), 10_000).catch(async () => facts());
      applyMoves(world, world.owner, world.owner.memberId, ownerView);
      f = await until('the reopened plan in Backlog', async () => { const now = await facts(); return cellOf(now, 'backlog')?.cards.includes('plan:60-03') && now.live !== '' ? now : undefined; }, 10_000).catch(async () => facts());
      await photo('codeserver-3-plan-reopened.png');
      const moves = messages().filter((m) => m.type === 'move');
      check(moves.length === 1 && moves[0]?.itemId === 'plan:60-03' && moves[0]?.target === 'reopen', 'the drop sent exactly one reopen request for plan 60-03', JSON.stringify(moves));
      check(f.dragLog.some((e) => e.event === 'drop' && e.column === 'backlog' && e.verdict === 'ok'), 'the drop on Backlog was offered', JSON.stringify(f.dragLog));
      check(cellOf(f, 'backlog')?.cards.includes('plan:60-03') === true && f.live === 'Reopened plan 60-03 in Backlog.', 'the finished, ready-shaped plan is drawn in Backlog and the page says it was reopened', `live: ${f.live}`);
      // 3b. A real drag of the reopened card from Backlog to Ready: one release, and the card is drawn in Ready.
      const reopened = f.cards.find((c) => c.id === 'plan:60-03');
      const readyCell = cellOf(f, 'ready');
      if (reopened && readyCell) {
        await mouseDrag(session, grip(reopened), middle(readyCell), { steps: 15, pauseMs: 20 });
        f = await until('the release request', async () => (messages().filter((m) => m.type === 'move').length > 1 ? await facts() : undefined), 10_000).catch(async () => facts());
        applyMoves(world, world.owner, world.owner.memberId, ownerView);
        f = await until('the released plan in Ready', async () => { const now = await facts(); return cellOf(now, 'ready')?.cards.includes('plan:60-03') ? now : undefined; }, 10_000).catch(async () => facts());
        await photo('codeserver-3b-plan-released.png');
        const sent = messages().filter((m) => m.type === 'move').slice(1);
        check(sent.length === 1 && sent[0]?.itemId === 'plan:60-03' && sent[0]?.target === 'release', 'a real drag of the reopened plan to Ready sent exactly one release request', JSON.stringify(sent));
        check(cellOf(f, 'ready')?.cards.includes('plan:60-03') === true, 'the released plan is drawn in Ready', JSON.stringify(cellOf(f, 'ready')));
      } else check(false, 'the reopened plan and the Ready cell are drawn', JSON.stringify({ reopened, readyCell }));
    } else check(false, 'a done plan and the Backlog cell are drawn', JSON.stringify({ plan, backlog }));

    // 4. The developer's view (owner decision 2026-11-04, 62-27): the same board plus a Ready plan the lead gave the developer and one the lead kept.
    const devWorld = await boardWorld();
    seedRetestBoard(devWorld, 3, { assignedPlans: true });
    const devView = (): BoardModel => buildBoardModel(devWorld.state, { nowMs: Date.now(), status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: devWorld.dev.memberId });
    const devModel = devView();
    const mineLane = devModel.cards.find((c) => c.id === 'plan:64-01')?.lane.member ?? '';
    const leadLane = devModel.cards.find((c) => c.id === 'plan:64-02')?.lane.member ?? '';
    const sentBefore = messages().filter((m) => m.type === 'move').length;
    writeFileSync(modelFile, JSON.stringify(devModel));
    f = await until('the developer\'s board', async () => { const now = await facts(); return now.cards.some((c) => c.id === 'plan:64-01') && now.cards.some((c) => c.id === 'plan:64-02') ? now : undefined; }, 15_000);
    await sleep(500);
    f = await facts();
    await photo('codeserver-4-developer-board.png');
    check(cellOf(f, 'ready', mineLane)?.cards.includes('plan:64-01') === true && cellOf(f, 'ready', leadLane)?.cards.includes('plan:64-02') === true, 'the developer\'s plan and the lead\'s plan are drawn in Ready of their own rows', JSON.stringify(f.cells.filter((c) => c.column === 'ready')));
    check(f.cards.find((c) => c.id === 'plan:64-01')?.draggable === true && f.cards.find((c) => c.id === 'plan:64-02')?.draggable === true, 'the developer can pick up both plans');

    // 4a. A real drop of the developer's plan on Cancelled, opened by a real click first: refused with the cancel sentence, nothing sent.
    await reveal('.colheads .column[data-column="cancelled"]', 'end');
    f = await facts();
    const cancelledHead = head(f, 'cancelled');
    if (cancelledHead) await click({ x: cancelledHead.left + cancelledHead.width / 2, y: cancelledHead.top + 24 });
    f = await until('Cancelled open', async () => { const now = await facts(); return cellOf(now, 'cancelled', mineLane)?.folded === false ? now : undefined; }, 10_000).catch(async () => facts());
    await reveal('.card[data-id="plan:64-01"]', 'start');
    f = await facts();
    const mine = f.cards.find((c) => c.id === 'plan:64-01');
    const cancelled = cellOf(f, 'cancelled', mineLane);
    const cancelledAt = cancelled === undefined ? undefined : { x: cancelled.left + Math.min(40, cancelled.width / 2), y: cancelled.top + Math.min(40, cancelled.height / 2) };
    if (mine && cancelled && cancelledAt && !cancelled.folded && onScreen(grip(mine), f.view) && onScreen(cancelledAt, f.view)) {
      await mouseDrag(session, grip(mine), cancelledAt, { steps: 15, pauseMs: 20 });
      f = await until('the refusal on the developer\'s plan', async () => { const now = await facts(); return now.cards.find((c) => c.id === 'plan:64-01')?.refusal ? now : undefined; }, 10_000).catch(async () => facts());
      await photo('codeserver-5-developer-cancel-refused.png');
      check(f.dragLog.some((e) => e.event === 'drop' && e.column === 'cancelled' && e.verdict === 'no'), 'the drop on Cancelled was refused', JSON.stringify(f.dragLog.slice(-4)));
      check(f.cards.find((c) => c.id === 'plan:64-01')?.refusal === REFUSALS.cancelManagersOnly, 'the developer\'s plan shows the cancel sentence', JSON.stringify(f.cards.find((c) => c.id === 'plan:64-01')));
      check(messages().filter((m) => m.type === 'move').length === sentBefore, 'the refused cancel sent nothing');
    } else check(false, 'the developer\'s plan and an open Cancelled cell in its row are on screen', JSON.stringify({ mine, cancelled, view: f.view }));

    // 4b. A real drag of the lead's plan to Backlog of its own row: picked up, refused with the not-assignee sentence, nothing sent.
    await reveal(`.cell[data-column="backlog"][data-lane="${leadLane}"]`, 'start');
    f = await facts();
    const theirs = f.cards.find((c) => c.id === 'plan:64-02');
    const leadBacklog = cellOf(f, 'backlog', leadLane);
    if (theirs && leadBacklog && onScreen(grip(theirs), f.view) && onScreen(middle(leadBacklog), f.view)) {
      await mouseDrag(session, grip(theirs), middle(leadBacklog), { steps: 15, pauseMs: 20 });
      f = await until('the refusal on the lead\'s plan', async () => { const now = await facts(); return now.cards.find((c) => c.id === 'plan:64-02')?.refusal ? now : undefined; }, 10_000).catch(async () => facts());
      await photo('codeserver-6-developer-lead-card-refused.png');
      check(f.dragLog.some((e) => e.event === 'dragstart' && e.verdict === 'started'), 'the browser started the drag of the lead\'s plan', JSON.stringify(f.dragLog.slice(-4)));
      check(f.cards.find((c) => c.id === 'plan:64-02')?.refusal === REFUSALS.notAssigneeMove, 'the lead\'s plan shows the not-assignee sentence', JSON.stringify(f.cards.find((c) => c.id === 'plan:64-02')));
      check(messages().filter((m) => m.type === 'move').length === sentBefore, 'the refused drag sent nothing');
    } else check(false, 'the lead\'s plan and the Backlog cell of its row are on screen', JSON.stringify({ theirs, leadBacklog, view: f.view }));

    // 4c. A real drag of the developer's plan onto Backlog of its row: exactly one hold request.
    await reveal(`.cell[data-column="backlog"][data-lane="${mineLane}"]`, 'start');
    f = await facts();
    const own = f.cards.find((c) => c.id === 'plan:64-01');
    const mineBacklog = cellOf(f, 'backlog', mineLane);
    if (own && mineBacklog && onScreen(grip(own), f.view) && onScreen(middle(mineBacklog), f.view)) {
      await mouseDrag(session, grip(own), middle(mineBacklog), { steps: 15, pauseMs: 20 });
      f = await until('the hold request', async () => (messages().filter((m) => m.type === 'move').length > sentBefore ? await facts() : undefined), 10_000).catch(async () => facts());
      applyMoves(devWorld, devWorld.dev, devWorld.dev.memberId, devView);
      f = await until('the developer\'s plan in Backlog', async () => { const now = await facts(); return cellOf(now, 'backlog', mineLane)?.cards.includes('plan:64-01') ? now : undefined; }, 10_000).catch(async () => facts());
      await photo('codeserver-7-developer-plan-held.png');
      const sent = messages().filter((m) => m.type === 'move').slice(sentBefore);
      check(sent.length === 1 && sent[0]?.itemId === 'plan:64-01' && sent[0]?.target === 'hold', 'the developer\'s drop sent exactly one hold request for plan 64-01', JSON.stringify(sent));
      check(f.dragLog.some((e) => e.event === 'drop' && e.column === 'backlog' && e.lane === mineLane && e.verdict === 'ok'), 'the drop on Backlog of the developer\'s row was offered', JSON.stringify(f.dragLog.slice(-4)));
      check(cellOf(f, 'backlog', mineLane)?.cards.includes('plan:64-01') === true, 'the plan is drawn in Backlog of the developer\'s row');
    } else check(false, 'the developer\'s plan and the Backlog cell of its row are on screen', JSON.stringify({ own, mineBacklog, view: f.view }));

    // 5. The timeline (62.1-09): the owner's board again, now with the timeline the host builds from the same state and viewer.
    const tlWorld = await boardWorld();
    seedRetestBoard(tlWorld, 3, { readyShaped: true });
    const tlView = (): BoardModel => {
      const ownerModel = buildBoardModel(tlWorld.state, { nowMs: Date.now(), status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: tlWorld.owner.memberId });
      ownerModel.timeline = buildTimeline(tlWorld.state, ownerModel, { viewerId: tlWorld.owner.memberId });
      return ownerModel;
    };
    const tlModel = tlView();
    writeFileSync(modelFile, JSON.stringify(tlModel));
    await until('the owner\'s board again', async () => { const now = await facts(); return now.cards.some((c) => c.id === 'phase:63') && !now.cards.some((c) => c.id === 'plan:64-01') ? now : undefined; }, 15_000);
    const tl = async (): Promise<TimelineFacts> => evaluate<TimelineFacts>(boardContext, TIMELINE_FACTS);
    const centre = (b: Box): Point => ({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
    let t = await tl();
    check(t.timelineButton !== null, 'the Timeline button is drawn');
    if (t.timelineButton) await click(centre(t.timelineButton));
    t = await until('the timeline\'s dots', async () => { const now = await tl(); return now.dots.length > 0 ? now : undefined; }, 10_000).catch(async () => tl());
    // The first draw staggers the dots in and fades the lines in after them (62.1-06).
    await sleep(1_200);
    t = await tl();
    await photo('codeserver-8-timeline.png');
    const expected = (tlModel.timeline?.dots ?? []).map((d) => d.cardId).sort();
    check(JSON.stringify(t.dots.map((d) => d.id).sort()) === JSON.stringify(expected), `a real click on Timeline draws every card as a dot (${expected.length})`, JSON.stringify(t.dots.map((d) => d.id)));
    const phaseDot = t.dots.find((d) => d.id === 'phase:63');
    if (phaseDot) {
      const away = { x: Math.round(phaseDot.left + phaseDot.width / 2), y: Math.round(phaseDot.top + phaseDot.height + 80) };
      await mouseMove(session, away);
      await sleep(300);
      await mouseMove(session, centre(phaseDot), { from: away, steps: 8 });
      const hovered = Date.now();
      t = await until('the preview', async () => { const now = await tl(); return now.preview ? now : undefined; }, 1_000).catch(async () => tl());
      const tookMs = Date.now() - hovered;
      await photo('codeserver-9-timeline-preview.png');
      check(t.preview !== null && tookMs <= 1_000, `a real hover on the phase card's dot shows the preview within 1 s (${tookMs} ms)`, JSON.stringify(t.preview));
      await click(centre(phaseDot));
      await until('the card', async () => { const now = await tl(); return now.card ? now : undefined; }, 5_000).catch(async () => tl());
      await sleep(500);
      t = await tl();
      await photo('codeserver-10-timeline-card.png');
      check(t.card !== null, 'a real click on the dot opens its card');
      check(t.focus?.id === 'tl-card-title', 'focus is on the card\'s title', JSON.stringify(t.focus));
      await pressKey(session, 'Escape');
      t = await until('the card closed', async () => { const now = await tl(); return now.card === null ? now : undefined; }, 5_000).catch(async () => tl());
      check(t.card === null && t.focus?.dot === 'phase:63', 'a real Escape closes the card and focus is back on the phase card\'s dot', JSON.stringify(t.focus));
    } else check(false, 'the phase card\'s dot is drawn', JSON.stringify(t.dots));
    const planDot = t.dots.find((d) => d.id === 'plan:60-01');
    const sentBeforeTimeline = messages().filter((m) => m.type === 'move').length;
    if (planDot) {
      await click(centre(planDot));
      await until('the plan\'s card', async () => { const now = await tl(); return now.card ? now : undefined; }, 5_000).catch(async () => tl());
      // The card springs open from its corner for 200 ms (UI-SPEC "Motion"); its buttons are measured once it has its size.
      await sleep(500);
      t = await tl();
      const moveTo = t.card?.buttons.find((b) => b.name.startsWith('Move to'));
      check(moveTo !== undefined, 'the done plan\'s card has Move to...', JSON.stringify(t.card?.buttons.map((b) => b.name)));
      if (moveTo) await click(centre(moveTo));
      await sleep(300);
      t = await until('the Move to... menu', async () => { const now = await tl(); return now.menu.length > 0 ? now : undefined; }, 5_000).catch(async () => tl());
      await photo('codeserver-11-timeline-move-menu.png');
      const reopen = t.menu.find((m) => m.text === 'Backlog (reopen)');
      check(reopen !== undefined, 'the menu offers Backlog (reopen)', JSON.stringify(t.menu.map((m) => m.text)));
      if (reopen) await click(centre(reopen));
      await until('the reopen request from the timeline', async () => (messages().filter((m) => m.type === 'move').length > sentBeforeTimeline ? await tl() : undefined), 10_000).catch(async () => tl());
      applyMoves(tlWorld, tlWorld.owner, tlWorld.owner.memberId, tlView);
      // A reopened card is held, and the dot draws a held card as on hold (timeline.js: blocked, then on hold, then the column). The column is
      // checked on the board model below, so the dot's state and the card's column are both proven.
      t = await until('the dot marked on hold', async () => { const now = await tl(); return now.dots.find((d) => d.id === 'plan:60-01')?.state === 'held' ? now : undefined; }, 10_000).catch(async () => tl());
      await sleep(500);
      await photo('codeserver-12-timeline-reopened.png');
      const sent = messages().filter((m) => m.type === 'move').slice(sentBeforeTimeline);
      check(sent.length === 1 && sent[0]?.itemId === 'plan:60-01' && sent[0]?.target === 'reopen', 'Backlog (reopen) from the card sent exactly one reopen request for plan 60-01', JSON.stringify(sent));
      const reopenedDot = t.dots.find((d) => d.id === 'plan:60-01');
      const reopenedCard = buildBoardModel(tlWorld.state, { nowMs: Date.now(), status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: tlWorld.owner.memberId }).cards.find((c) => c.id === 'plan:60-01');
      check(reopenedDot?.state === 'held' && reopenedCard?.column === 'backlog' && reopenedCard.held === true, 'the reopened card is held and drawn in Backlog, and its dot shows the hold', JSON.stringify({ dot: reopenedDot, column: reopenedCard?.column, held: reopenedCard?.held }));
    } else check(false, 'the done plan\'s dot is drawn', JSON.stringify(t.dots));
  } catch (error) {
    check(false, 'the run finished', (error as Error).stack ?? String(error));
  } finally {
    cdp?.close();
    stop(tab);
    stop(server);
    await sleep(2_500);
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '# code-server board: all checks passed' : `# code-server board: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
