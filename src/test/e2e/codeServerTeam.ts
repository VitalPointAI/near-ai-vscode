// The automatic join in code-server, in a real browser (0.6.4 re-test, carol step 9; debug session ask-join-connect-no-refresh). The owner's
// code-server re-test showed a requester's Connect screen staying put after her request was accepted and her computer joined by itself, where a real
// VS Code window and every stubbed layer behaved. So this test drives the real extension in code-server: the requester in a real browser with real
// mouse input, and the owner's side under the vscode stub on the same real git repository (the owner's part is not what is in question, and two VS
// Code windows and a browser at once is one heavy run too many).
//
// It records every team-state the sidebar frame receives (a listener the test adds to that frame) and reads what the Connect group drew, so a
// missing refresh (the host never posted) is told apart from an ignored one (the page received it and did not draw).
//
// Variants (NEAR_AI_E2E_TEAM_VARIANTS, a comma list; unset runs all three):
//   A: the requester's code-server keeps its own storage, as a person running their own server.
//   B: the owner's side uses the requester's code-server global storage folder (owner decision B, 2026-11-05: one server shared by several people).
//   C: like A, with the requester's browser tab sent to the background from before the accept until 60 s after it, then brought back.
//
// Not part of npm test: it needs a code-server install and a Chromium-based browser, and runs only on a hidden xvfb-run screen. For example:
//   npm run compile && NEAR_AI_CODE_SERVER=/path/to/code-server NEAR_AI_E2E_BROWSER=/path/to/brave xvfb-run -a node dist/test/e2e/codeServerTeam.js
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gitIn } from '../helpers/teamHarness';
import { MemorySecrets } from '../helpers/teamHarness';
import type { Rig } from '../helpers/teamFlowRig';
import { closeRig, createRig, enable, invite, rootOf } from '../helpers/teamFlowRig';
import type { RecordedWebview } from '../helpers/vscodeStub';
import { createFakeContext, createVscodeStub, installVscodeStub } from '../helpers/vscodeStub';
import { connectCdp, mouseDrag, mouseMove, originTarget, pressKey } from './cdp';
import type { CdpSession, Point } from './cdp';

const USAGE = 'Set NEAR_AI_CODE_SERVER to a code-server folder (with bin/code-server) and NEAR_AI_E2E_BROWSER to a Chromium-based browser, then run under xvfb-run, for example: NEAR_AI_CODE_SERVER=/path/to/code-server NEAR_AI_E2E_BROWSER=/path/to/brave NEAR_AI_E2E_TEAM_VARIANTS=A xvfb-run -a node dist/test/e2e/codeServerTeam.js';
const HIDDEN_SCREEN_ONLY = 'This test runs only on a hidden virtual screen. Start it with xvfb-run, for example: xvfb-run -a node dist/test/e2e/codeServerTeam.js';
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const VARIANTS = ['A', 'B', 'C'] as const;
type Variant = typeof VARIANTS[number];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const TEAM = 'E2E team';
const OWN_KEY_SENTENCE = 'has no organization linked';
const JOINED_WITHIN_MS = 120_000;
const CONNECT_WITHIN_MS = 45_000;

// The same rule as run.ts and codeServerBoard.ts (owner, 2026-11-03): only a screen xvfb-run made, never the person's own screen.
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
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: (${last as Error}).message)` : ''}`);
}

// The packaged-extension contents of .vscodeignore, rebuilt here without the test build: what a person installs from the Marketplace.
function installExtension(destination: string): void {
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(EXTENSION_ROOT, 'package.json'), path.join(destination, 'package.json'));
  for (const folder of ['dist', 'media', 'resources', 'vendor']) cpSync(path.join(EXTENSION_ROOT, folder), path.join(destination, folder), { recursive: true });
  // The test build is not part of the extension a person installs.
  rmSync(path.join(destination, 'dist', 'test'), { recursive: true, force: true });
  rmSync(path.join(destination, 'media', 'board', 'layout-probe.js'), { force: true });
}

// Runs in the sidebar page: what the Connect group says and which buttons it drew.
const CONNECT_FACTS = `(() => {
  const group = document.querySelector('#welcome-connect .team-connect, #team-connect .team-connect-block');
  const status = group ? (group.querySelector('.team-connect-status') || {}).textContent || '' : '';
  const actions = group ? Array.from(group.querySelectorAll('.team-connect-action')).map((b) => (b.textContent || '').trim()) : [];
  return { found: !!group, status: status.trim(), actions, url: location.href };
})()`;

// Added to the sidebar frame before anything happens: every team-state it receives, so "posted and ignored" is told apart from "never posted".
const RECORDER = `(() => {
  if (window.__teamStates) return window.__teamStates.length;
  window.__teamStates = [];
  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'team-state') {
      const connect = message.model && message.model.connect ? message.model.connect.status || '' : '';
      window.__teamStates.push({ at: Date.now(), connect });
    }
  });
  return 0;
})()`;

interface ConnectFacts { found: boolean; status: string; actions: string[]; url: string }
interface Box { left: number; top: number; width: number; height: number }
interface RecordedState { at: number; connect: string }

interface VariantResult { variant: Variant; joined: boolean; ownKey: boolean; tookMs: number; states: RecordedState[]; lines: string[] }

async function runVariant(variant: Variant, options: { codeServer: string; browser: string; shots: string }): Promise<VariantResult> {
  const stub = createVscodeStub();
  const uninstall = installVscodeStub(stub);
  const { ENABLE_COMMAND, registerTeamMode } = require('../../services/team/teamCommands') as typeof import('../../services/team/teamCommands');
  const { ASK_TO_JOIN_COMMAND, MANAGE_MEMBERS_COMMAND } = require('../../services/team/memberCommands') as typeof import('../../services/team/memberCommands');
  const { planShare, shareTeamSetup } = require('../../team/projectHome') as typeof import('../../team/projectHome');
  const { readTeamFile } = require('../../team/teamFile') as typeof import('../../team/teamFile');
  const root = mkdtempSync(path.join(tmpdir(), `near-ai-codeserver-team-${variant}-`));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_SESSION_TYPE: 'x11', HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home', '.config'), XDG_DATA_HOME: path.join(root, 'home', '.local', 'share'), XDG_CACHE_HOME: path.join(root, 'home', '.cache') };
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  mkdirSync(path.join(root, 'home'), { recursive: true });
  let server: ChildProcess | undefined;
  let tab: ChildProcess | undefined;
  let cdp: CdpSession | undefined;
  let rig: Rig | undefined;
  const contexts: Array<ReturnType<typeof createFakeContext>> = [];
  const handles: Array<ReturnType<typeof registerTeamMode>> = [];
  const result: VariantResult = { variant, joined: false, ownKey: false, tookMs: 0, states: [], lines: [] };
  const check = (ok: boolean, text: string, detail = ''): void => {
    console.log(`${ok ? 'ok' : 'not ok'} - [${variant}] ${text}${ok || detail === '' ? '' : `\n    ${detail}`}`);
    result.ownKey ||= false;
    if (!ok) throw new Error(`[${variant}] ${text}`);
  };
  try {
    // The owner's side first, under the stub: Team Mode on in clone a, main published, an invite made.
    rig = await createRig({ linked: false });
    await enable(rig);
    await invite(rig, rig.dev);
    const a = rootOf(rig, 'a');
    const b = rootOf(rig, 'b');
    const ownerStorage = variant === 'B' ? path.join(root, 'shared-global-storage') : path.join(root, 'owner-global-storage');
    mkdirSync(ownerStorage, { recursive: true });

    // The requester's copy: code-server's user data holds the workspace, its global storage holds the extension's.
    const project = path.join(root, 'project');
    cpSync(b, project, { recursive: true });
    const userData = path.join(root, 'user');
    const extensionsDir = path.join(root, 'extensions');
    mkdirSync(path.join(userData, 'User'), { recursive: true });
    writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'workbench.tips.enabled': false,
      'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'update.mode': 'none', 'chat.disableAIFeatures': true,
      'nearAi.team.pollSeconds': 5
    }));
    const extension = path.join(extensionsDir, 'vitalpoint.near-ai-vscode-under-test-0.0.0');
    installExtension(extension);
    writeFileSync(path.join(root, 'config.yaml'), 'bind-addr: 127.0.0.1:0\nauth: none\ncert: false\n');

    const port = await freeLocalPort();
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(path.join(options.codeServer, 'bin', 'code-server'), ['--config', path.join(root, 'config.yaml'), '--auth', 'none', '--bind-addr', `127.0.0.1:${port}`,
      '--user-data-dir', userData, '--extensions-dir', extensionsDir, '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', '--disable-getting-started-override', project],
    { env, detached: true, stdio: 'ignore' });
    await until('code-server to answer', async () => ((await healthy(`${origin}/healthz`)) ? true : undefined), 90_000);
    console.log(`(${variant}: code-server on ${origin})`);

    const profile = path.join(root, 'browser');
    tab = spawn(options.browser, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--ozone-platform=x11', '--remote-debugging-port=0',
      '--window-position=0,0', '--window-size=1600,1000', '--force-device-scale-factor=1', '--password-store=basic',
      `${origin}/?folder=${encodeURIComponent(project)}`], { env, detached: true, stdio: 'ignore' });
    const devtools = await until('the browser DevTools port', () => {
      const file = path.join(profile, 'DevToolsActivePort');
      const first = existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) : 0;
      return first > 0 ? first : undefined;
    }, 90_000);
    cdp = await until('the code-server tab', () => connectCdp(devtools, { pick: (targets) => originTarget(targets, origin), timeoutMs: 30_000 }), 90_000);
    const session = cdp;
    const contextsSeen = new Set<number>();
    session.on('Runtime.executionContextCreated', (p) => { if (p?.context?.auxData?.isDefault) contextsSeen.add(p.context.id as number); });
    session.on('Runtime.executionContextDestroyed', (p) => { contextsSeen.delete(p?.executionContextId as number); });
    session.on('Runtime.executionContextsCleared', () => contextsSeen.clear());
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    const evaluate = async <T>(contextId: number, expression: string): Promise<T> => {
      const answer = await session.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text ?? 'evaluation failed');
      return answer.result?.value as T;
    };
    // The NEAR AI sidebar is a closed view, so its page does not exist until it is opened. A real keyboard opens it through the Command Palette,
    // as a person would: Ctrl+P, then the view's own command.
    await session.send('Page.bringToFront').catch(() => undefined);
    await pressKey(session, 'p', { ctrl: true });
    await sleep(600);
    for (const character of 'nearAiChatView.focus') {
      await session.send('Input.dispatchKeyEvent', { type: 'char', text: character });
    }
    await sleep(600);
    await pressKey(session, 'Enter');
    await sleep(2_000);
    // The sidebar's page: the frame that has the chat's Connect group and its own message listener.
    const sidebar = await until('the NEAR AI sidebar page', async () => {
      for (const id of [...contextsSeen]) if (await evaluate<boolean>(id, `!!document.getElementById('welcome') || !!document.getElementById('welcome-connect')`).catch(() => false)) return id;
      return undefined;
    }, 180_000).catch(async (error) => {
      // A failure here is about the harness opening the view, not the product: say what frames exist, and keep a picture.
      const seen: string[] = [];
      for (const id of [...contextsSeen]) {
        const described = await evaluate<string>(id, `(() => { const t = (document.title || '').slice(0, 40); const w = !!document.getElementById('welcome'); const n = document.querySelectorAll('*').length; return t + ' | welcome=' + w + ' | nodes=' + n + ' | ' + location.href.slice(0, 90); })()`).catch(() => 'unreadable');
        seen.push(`${id}: ${described}`);
      }
      throw new Error(`${(error as Error).message}. Frames seen:\n${seen.join('\n')}`);
    });
    await evaluate<number>(sidebar, RECORDER);
    const connectFacts = async (): Promise<ConnectFacts> => evaluate<ConnectFacts>(sidebar, CONNECT_FACTS);
    const states = async (): Promise<RecordedState[]> => evaluate<RecordedState[]>(sidebar, 'window.__teamStates ? window.__teamStates.slice() : []');
    const photo = async (name: string): Promise<void> => {
      if (options.shots === '') return;
      const picture = await session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(options.shots, `${variant}-${name}`), Buffer.from(picture.data, 'base64'));
    };
    const click = async (at: Point): Promise<void> => {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const centreOf = async (text: string): Promise<Point | undefined> => {
      const box = await evaluate<Box | null>(sidebar, `(() => { const n = Array.from(document.querySelectorAll('.team-connect-action')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)}); if (!n) return null; const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
      return box === null ? undefined : { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    };

    // The requester asks to join with real mouse input. The request text is shown in the notification's own detail, so the test reads it there and
    // copies it with the real Copy request button, as a person would.
    const askAt = await until('the Ask to join button', () => centreOf('Ask to join'), 180_000);
    await click(askAt);
    const request = await until('the request text', async () => {
      const found = await evaluate<string | null>(sidebar, `(() => { const nodes = Array.from(document.querySelectorAll('.notification-list-item, .monaco-list-row, [aria-label]')); for (const n of nodes) { const t = (n.textContent || ''); const m = /near-ai-join-request-v1\.[A-Za-z0-9._-]+/.exec(t); if (m) return m[0]; } return null; })()`);
      return found === null ? undefined : found;
    }, 60_000);
    console.log(`(${variant}: the request was read out of the notification)`);
    const copyAt = await until('the Copy request button', () => centreOf('Copy request'), 60_000);
    await click(copyAt);
    await sleep(1_000);
    await photo('asked.png');
    const asked = await connectFacts();
    check(asked.found, 'the Connect group is drawn with no profile', JSON.stringify(asked));

    // The owner accepts the request under the stub. Her storage follows the variant: her own, or the server's shared folder (owner decision B).
    stub.setWorkspaceFolders([a]);
    const ownerContext = createFakeContext(ownerStorage, new MemorySecrets());
    contexts.push(ownerContext);
    const owner = registerTeamMode(ownerContext as never);
    handles.push(owner);
    await owner.ready;
    const ownerCommands = new Map(stub.commands);
    const teamFile = await readTeamFile(a);
    check(teamFile !== undefined, 'the owner has a team file');
    if (teamFile !== undefined) {
      const plan = await planShare({ projectRoot: a, teamFile, branch: 'main' });
      check((await shareTeamSetup({ projectRoot: a, teamFile, branch: 'main', plan })).ok, 'the owner shares the team setup');
    }
    await photo('before-accept.png');

    // In variant C the tab goes to the background from before the accept until well after the join, then comes back.
    const background = variant === 'C';
    if (background) await session.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => undefined);
    stub.quickPickAnswers.push('Accept a request', 'Developer', '7 days');
    stub.inputAnswers.push(request, 'carol@example.invalid', '5');
    stub.setMessageResponder((_text, actions) => (actions.includes('Continue') ? 'Continue' : undefined));
    await ownerCommands.get(MANAGE_MEMBERS_COMMAND)?.();
    stub.setMessageResponder(undefined);
    await owner.session()?.sync();
    console.log(`(${variant}: the owner accepted the request)`);

    // The requester's window joins by itself, and the section then follows without a click.
    const joined = await until('the requester to join by itself', async () => {
      const statesNow = await states().catch(() => []);
      const connect = await connectFacts().catch(() => undefined);
      const onTeam = (connect?.status ?? '').includes(OWN_KEY_SENTENCE);
      return statesNow.length > 0 || onTeam ? { statesNow, connect } : undefined;
    }, JOINED_WITHIN_MS);
    const acceptedAt = Date.now();
    if (background) {
      // A tab in the background for a while, as the owner's browser had until the re-test brought it back.
      await sleep(60_000);
      await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
      await session.send('Page.bringToFront').catch(() => undefined);
    }
    const followed = await until('the Connect group to follow the automatic join', async () => {
      const connect = await connectFacts().catch(() => undefined);
      return connect !== undefined && connect.status.includes(OWN_KEY_SENTENCE) ? connect : undefined;
    }, CONNECT_WITHIN_MS).catch(() => undefined);
    result.tookMs = Date.now() - acceptedAt;
    result.states = await states().catch(() => []);
    await photo('after-join.png');
    check(joined !== undefined, 'the requester\'s window reached a new team state');
    check(followed !== undefined && followed.status.includes(OWN_KEY_SENTENCE), 'the Connect group says the team has no organization, with no click', JSON.stringify({ followed, states: result.states }));
    check(followed !== undefined && followed.actions.includes('Set up a new profile') && followed.actions.includes('Use a saved profile'), 'and it offers Set up a new profile and Use a saved profile', JSON.stringify(followed?.actions));
    result.ownKey = followed !== undefined && followed.status.includes(OWN_KEY_SENTENCE);
    console.log(`(${variant}: the Connect group followed in ${result.tookMs} ms; ${result.states.length} team-state(s) reached the page)`);

    // The extension's own NEAR AI Team channel, as the owner would read it in code-server's logs.
    const logFile = path.join(userData, 'logs');
    const channelLines: string[] = [];
    const walk = (folder: string): void => {
      if (!existsSync(folder)) return;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'NEAR AI Team.log') channelLines.push(...readFileSync(full, 'utf8').split('\n').filter(Boolean));
      }
    };
    walk(logFile);
    result.lines = channelLines;
    for (const line of channelLines) console.log(`    channel: ${line}`);
  } finally {
    try { result.states = []; } catch { /* nothing to record */ }
    cdp?.close();
    for (const child of [tab, server]) {
      if (child === undefined || child.pid === undefined || child.exitCode !== null) continue;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    for (const handle of handles.reverse()) await handle.session()?.sync().catch(() => undefined);
    for (const context of contexts) for (const subscription of context.subscriptions) subscription.dispose();
    if (rig !== undefined) await closeRig(rig).catch(() => undefined);
    uninstall();
    await sleep(1_500);
    rmSync(root, { recursive: true, force: true });
  }
  return result;
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
  const asked = process.env.NEAR_AI_E2E_TEAM_VARIANTS ?? '';
  const wanted = asked === '' ? [...VARIANTS] : asked.split(',').map((name) => name.trim().toUpperCase());
  const unknown = wanted.filter((name) => !VARIANTS.includes(name as Variant));
  if (unknown.length > 0) {
    console.error(`Unknown variant ${unknown.join(', ')}. Use a comma list of ${VARIANTS.join(', ')}.`);
    process.exitCode = 2;
    return;
  }
  const shots = process.env.NEAR_AI_E2E_SHOTS ?? '';
  if (shots !== '') mkdirSync(shots, { recursive: true });
  let failures = 0;
  const results: VariantResult[] = [];
  for (const variant of wanted as Variant[]) {
    console.log(`# variant ${variant}`);
    try {
      results.push(await runVariant(variant, { codeServer, browser, shots }));
    } catch (error) {
      failures += 1;
      console.log(`not ok - [${variant}] the variant ran\n    ${(error as Error).stack ?? String(error)}`);
    }
  }
  for (const result of results) console.log(`# variant ${result.variant}: team-states received ${result.states.length}, connect followed ${result.ownKey}`);
  console.log(failures === 0 ? '# code-server team: all checks passed' : `# code-server team: ${failures} variant(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
