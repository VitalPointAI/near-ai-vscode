import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// A test window must never appear on a person's real screen (owner, 2026-11-03).
const HIDDEN_SCREEN_ONLY = 'The e2e runs only on a hidden virtual screen. Start it with xvfb-run, for example: npm run test:e2e';

// On Linux the run starts only on a screen xvfb-run made: xvfb-run points XAUTHORITY at a file in a
// folder named xvfb-run.<random>. DISPLAY alone is never trusted, because it may be the person's own
// screen. Other systems have no Xvfb, so the check does not apply there.
function onHiddenScreen(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'linux') return true;
  const auth = env.XAUTHORITY ?? '';
  return auth !== '' && /^xvfb-run\.[A-Za-z0-9]+$/.test(path.basename(path.dirname(auth))) && existsSync(auth);
}

// Under xvfb-run on a Wayland desktop, Electron would still pick the person's Wayland screen
// (WAYLAND_DISPLAY wins over the DISPLAY xvfb-run set). So the Wayland variables are removed from what
// VS Code inherits (runTests passes process.env on) and Electron is told to use X11, the hidden screen.
/**
 * NEAR_AI_E2E_WEBGL=1 gives the hidden window software WebGL (SwiftShader), which the GPU blocklist otherwise refuses under xvfb, so the Staff Room's
 * real-window check can see MapLibre draw. Off by default: the default run checks the room's SVG fallback instead.
 */
function webglArgs(): string[] {
  return process.env.NEAR_AI_E2E_WEBGL === '1' ? ['--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
}

function keepToHiddenScreen(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'linux') return [];
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  env.XDG_SESSION_TYPE = 'x11';
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  return ['--ozone-platform=x11'];
}

/**
 * The VS Code the e2e run downloads, pinned so a new VS Code release cannot change CI unannounced (1.148 changed the workbench
 * layout and the chat width check stopped working overnight). To move to a newer VS Code: run
 * `VSCODE_TEST_VERSION=<x.y.z> npm run test:e2e` locally, fix what it finds, then change this value in the same PR.
 */
const E2E_VSCODE_VERSION = '1.148.0';

// Launches a real VS Code with the extension under development, once in a project set up with the
// extension and once in an unrelated folder. Run under `xvfb-run` on Linux (`npm run test:e2e`).
async function main(): Promise<void> {
  if (!onHiddenScreen(process.env)) {
    console.error(HIDDEN_SCREEN_ONLY);
    process.exit(1);
  }
  const screenArgs = keepToHiddenScreen(process.env);
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? E2E_VSCODE_VERSION;
  for (const scenario of ['project', 'plain'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    const userData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-'));
    // A maximized window (VS Code's own setting; the test window ignores saved window sizes), so the
    // width checks can size a page to 600px beside a second editor group. CI gives xvfb a 1920x1080 screen.
    await mkdir(path.join(userData, 'User'), { recursive: true });
    // The project scenario runs real git (the Team Mode tests): VS Code's own git integration is off so it never holds the index lock while Enable
    // commits, and git reads only this config file, never the developer's or the CI runner's.
    const userSettings: Record<string, unknown> = { 'window.newWindowDimensions': 'maximized', ...(scenario === 'project' ? { 'git.enabled': false } : {}) };
    await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify(userSettings));
    const gitEnv: Record<string, string> = {};
    if (scenario === 'project') {
      const gitConfig = path.join(userData, 'e2e.gitconfig');
      await writeFile(gitConfig, ['[user]', '\tname = E2E Owner', '\temail = e2e-owner@example.com', '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', ''].join('\n'));
      gitEnv.GIT_CONFIG_GLOBAL = gitConfig;
      gitEnv.GIT_CONFIG_NOSYSTEM = '1';
    }
    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      // --password-store=basic keeps this window's secrets (Enable stores the device key) in its own temporary user data, so it never asks the
      // person's OS keyring or puts an unlock prompt on the real screen.
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--password-store=basic', '--skip-welcome', '--skip-release-notes', ...screenArgs, ...webglArgs()],
      extensionTestsEnv: { ...(process.env.NEAR_AI_E2E_SHOTS ? { NEAR_AI_E2E_SHOTS: process.env.NEAR_AI_E2E_SHOTS } : {}), NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace, NEAR_AI_E2E_USER_DATA: userData, ...gitEnv }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
