import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const git = (cwd: string, args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };

// The team scenario's project: a git repository on main with the fixture roadmap committed and pushed to a bare remote, so Team Mode can be enabled on it
// and the plan import has a roadmap on the integration branch. The identity is local to the repository, so the developer's own git setup is not needed.
async function prepareTeamProject(workspace: string, extensionDevelopmentPath: string): Promise<void> {
  const remote = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-remote-'));
  git(remote, ['init', '--bare', '-q', '-b', 'main']);
  await cp(path.join(extensionDevelopmentPath, 'test', 'fixtures', 'gsd-import', 'planning'), path.join(workspace, '.planning'), { recursive: true });
  await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(workspace, '.gitignore'), '.planning/.near-ai/\n', 'utf8');
  git(workspace, ['init', '-q', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'E2E Owner']);
  git(workspace, ['config', 'user.email', 'owner@example.invalid']);
  git(workspace, ['add', '.gitignore', '.planning']);
  git(workspace, ['commit', '-q', '-m', 'project with the fixture roadmap']);
  git(workspace, ['remote', 'add', 'origin', remote]);
  git(workspace, ['push', '-q', 'origin', 'main']);
}

// The invite scenarios' online home. The projects' origin is a public-looking https address, and a test-only insteadOf rule in each test repository
// sends git to a local bare folder instead, so the invite's address check runs unchanged: nothing in the extension accepts a local path (T-61-92).
const PUBLIC_URL = 'https://example.invalid/e2e-team.git';

interface InviteProjects { remote: string; lead: string; copy: string; handoff: string }

// The lead's project (NEAR AI set up, no team yet) and the invitee's copy of it, made before Team Mode is on, so the copy is behind once the lead shares
// the team setup. The copy has no .planning/.near-ai. Both identities are local to their repository.
async function prepareInviteProjects(): Promise<InviteProjects> {
  const remote = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-invite-remote-'));
  git(remote, ['init', '--bare', '-q', '-b', 'main']);
  const lead = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-lead-'));
  await writeFile(path.join(lead, 'README.md'), '# E2E team project\n', 'utf8');
  await writeFile(path.join(lead, '.gitignore'), '.planning/.near-ai/\n', 'utf8');
  await mkdir(path.join(lead, '.planning', '.near-ai'), { recursive: true });
  git(lead, ['init', '-q', '-b', 'main']);
  git(lead, ['config', 'user.name', 'E2E Lead']);
  git(lead, ['config', 'user.email', 'lead@example.invalid']);
  git(lead, ['config', `url.${remote}.insteadOf`, PUBLIC_URL]);
  git(lead, ['add', 'README.md', '.gitignore']);
  git(lead, ['commit', '-q', '-m', 'the project before Team Mode']);
  git(lead, ['remote', 'add', 'origin', PUBLIC_URL]);
  git(lead, ['push', '-q', 'origin', 'main']);
  // The copy is fetched from the public address through the same rule, so its origin is the public address too.
  const parent = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-copy-'));
  const copy = path.join(parent, 'project');
  git(parent, ['clone', '-q', '-c', `url.${remote}.insteadOf=${PUBLIC_URL}`, PUBLIC_URL, copy]);
  git(copy, ['config', 'user.name', 'E2E Joiner']);
  git(copy, ['config', 'user.email', 'joiner@example.invalid']);
  // Holds the invite text between the lead's launch and the invitee's; removed after the last launch (T-61-93).
  const handoff = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-handoff-'));
  return { remote, lead, copy, handoff };
}

// ---- the hidden virtual screen (owner, 2026-11-03: a test window must never appear on a person's real screen) -----------------------------------

const HIDDEN_SCREEN_ONLY = 'The e2e runs only on a hidden virtual screen. Start it with xvfb-run, for example: xvfb-run -a node dist/test/e2e/run.js';

// On Linux the run starts only on a screen xvfb-run made: xvfb-run points XAUTHORITY at a file in a folder named xvfb-run.<random>, and a run started with
// `xvfb-run -s "... -fbdir DIR"` and NEAR_AI_E2E_FBDIR=DIR has DIR/Xvfb_screen0 while the screen runs. DISPLAY alone is never trusted: it may be the
// person's own screen. Other systems have no Xvfb, so the check does not apply there.
// Under xvfb-run on a Wayland desktop, Electron would still choose the person's Wayland screen (WAYLAND_DISPLAY wins over the DISPLAY xvfb-run set), so
// the window would appear there after all. The run therefore removes the Wayland variables from what VS Code inherits (runTests passes process.env on)
// and tells Electron to use X11, the hidden screen.
function keepToHiddenScreen(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'linux') return [];
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  env.XDG_SESSION_TYPE = 'x11';
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  return ['--ozone-platform=x11'];
}

function onHiddenScreen(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'linux') return true;
  const auth = env.XAUTHORITY ?? '';
  if (auth !== '' && /^xvfb-run\.[A-Za-z0-9]+$/.test(path.basename(path.dirname(auth))) && existsSync(auth)) return true;
  const fbdir = env.NEAR_AI_E2E_FBDIR ?? '';
  return fbdir !== '' && existsSync(path.join(fbdir, 'Xvfb_screen0'));
}

const LAUNCHES = ['project', 'plain', 'team', 'invite', 'board'] as const;

// NEAR_AI_E2E_ONLY names the launches to run (unset or empty runs all of them); an unknown name stops the run, so a typo never passes by running nothing.
function launchesToRun(value: string | undefined): Set<string> {
  const names = (value ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (names.length === 0) return new Set(LAUNCHES);
  const unknown = names.filter((name) => !(LAUNCHES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`NEAR_AI_E2E_ONLY names launches that do not exist: ${unknown.join(', ')}. Use any of ${LAUNCHES.join(', ')}.`);
  return new Set(names);
}

// ---- the board launch (62-21) --------------------------------------------------------------------------------------------------------------------

const BOARD_URL = 'https://example.invalid/e2e-board.git';

// A test project holding this repository's committed roadmap (.planning as it is at HEAD, so the board shows the real work, phases without plans
// included), pushed to a bare online home behind a public-looking address that a test-only insteadOf rule maps to the bare folder (as in 61-22).
async function prepareBoardProject(extensionDevelopmentPath: string): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-board-remote-'));
  git(remote, ['init', '--bare', '-q', '-b', 'main']);
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-board-'));
  const planning = execFileSync('git', ['-C', extensionDevelopmentPath, 'archive', '--format=tar', 'HEAD', '.planning'], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', workspace], { input: planning, stdio: ['pipe', 'ignore', 'inherit'] });
  await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# E2E board project\n', 'utf8');
  await writeFile(path.join(workspace, '.gitignore'), '.planning/.near-ai/\n', 'utf8');
  git(workspace, ['init', '-q', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'E2E Owner']);
  git(workspace, ['config', 'user.email', 'owner@example.invalid']);
  git(workspace, ['config', `url.${remote}.insteadOf`, BOARD_URL]);
  git(workspace, ['add', 'README.md', '.gitignore', '.planning']);
  git(workspace, ['commit', '-q', '-m', 'the project with this repository\'s roadmap']);
  git(workspace, ['remote', 'add', 'origin', BOARD_URL]);
  git(workspace, ['push', '-q', 'origin', 'main']);
  return workspace;
}

// A free TCP port on this computer for the board window's DevTools endpoint (62-23): asked from the system on 127.0.0.1, then let go for VS Code.
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

// Fresh user data for the board window: maximized (the test window ignores saved sizes), no start editor, and no saved board state (first open).
async function boardUserData(): Promise<string> {
  const userData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-board-'));
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'window.newWindowDimensions': 'maximized', 'workbench.startupEditor': 'none' }), 'utf8');
  return userData;
}

// Launches a real VS Code with the extension under development: in a project set up with the extension, in an unrelated folder and in a git project where
// Team Mode gets enabled, one after another. Then one invite in two windows open at the same time: the lead's window (team-lead, then team-confirm)
// turns Team Mode on, shares, invites, and once the invitee has joined confirms them; the invitee's window (team-join) joins from a copy that is behind.
// The lead's steps stay in one window because VS Code keeps all storage, SecretStorage included, in memory while extension tests run, so the lead's
// device key cannot outlive the window and is never written anywhere else (T-61-94). The basic password store keeps VS Code from looking for an OS
// keyring (no keyring prompt on a desktop display). Last, the board window (62-21): this repository's own committed roadmap on a test project, a
// maximized window, and the board measured by the layout probe at the full editor width and at a list width, with screenshots when the screen allows.
// It runs only on a hidden virtual screen made by xvfb-run (owner, 2026-11-03: test windows must never appear on a person's real screen), for example
// `xvfb-run -a node dist/test/e2e/run.js`. NEAR_AI_E2E_ONLY (a comma list of project, plain, team, invite and board) runs only those launches.
async function main(): Promise<void> {
  if (!onHiddenScreen(process.env)) {
    console.error(HIDDEN_SCREEN_ONLY);
    process.exit(1);
  }
  const screenArgs = keepToHiddenScreen(process.env);
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  const launch: Launch = (scenario, workspace, userData, extra = {}) => runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes', ...screenArgs, ...(extra.args ?? [])],
    extensionTestsEnv: { NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace, ...(extra.env ?? {}) }
  });
  const only = launchesToRun(process.env.NEAR_AI_E2E_ONLY);
  for (const scenario of ['project', 'plain', 'team'] as const) {
    if (!only.has(scenario)) continue;
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    if (scenario === 'team') await prepareTeamProject(workspace, extensionDevelopmentPath);
    await launch(scenario, workspace, await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-')));
  }
  if (only.has('invite')) await inviteWindows(launch);
  if (only.has('board')) {
    const workspace = await prepareBoardProject(extensionDevelopmentPath);
    const screens = path.join(extensionDevelopmentPath, '.vscode-test', 'screens');
    // The screenshots of a board run replace the last run's (T-62-69); screens-before keeps the red evidence and is never emptied here.
    await rm(screens, { recursive: true, force: true });
    await mkdir(screens, { recursive: true });
    const fbdir = process.env.NEAR_AI_E2E_FBDIR;
    // The board window alone gets a DevTools endpoint (62-23, T-62-71), so the suite can drag a card with real mouse input. Chromium binds it to
    // 127.0.0.1, the port is a free one chosen now, and it closes with this VS Code. No other launch and no shipped file opens one.
    const cdpPort = await freeLocalPort();
    // One CSS pixel per screen pixel, so the probe's measurements and the screenshots describe the same picture.
    await launch('board', workspace, await boardUserData(), {
      args: ['--force-device-scale-factor=1', `--remote-debugging-port=${cdpPort}`],
      env: { NEAR_AI_E2E_SCREENS: screens, NEAR_AI_E2E_CDP_PORT: String(cdpPort), ...(fbdir === undefined || fbdir === '' ? {} : { NEAR_AI_E2E_FBDIR: fbdir }) }
    });
  }
}

type Launch = (scenario: string, workspace: string, userData: string, extra?: { args?: string[]; env?: Record<string, string> }) => Promise<number>;

// One invite in two windows open at the same time (61-22).
async function inviteWindows(launch: Launch): Promise<void> {
  const invite = await prepareInviteProjects();
  try {
    const extra = { args: ['--password-store=basic'], env: { NEAR_AI_E2E_HANDOFF: invite.handoff, NEAR_AI_E2E_REMOTE: invite.remote } };
    const windows = await Promise.allSettled([
      launch('team-lead,team-confirm', invite.lead, await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-lead-')), extra),
      launch('team-join', invite.copy, await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-join-')), extra)
    ]);
    const failed = windows.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  } finally {
    // The invite text is a test secret: it is not left on disk, whatever happened above (T-61-93).
    await rm(invite.handoff, { recursive: true, force: true });
    if (existsSync(invite.handoff)) throw new Error(`The handoff folder could not be removed: ${invite.handoff}`);
    console.log('The handoff folder with the invite text is removed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
