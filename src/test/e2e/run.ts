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
function keepToHiddenScreen(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'linux') return [];
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  env.XDG_SESSION_TYPE = 'x11';
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  return ['--ozone-platform=x11'];
}

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
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  for (const scenario of ['project', 'plain'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    const userData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-'));
    // A maximized window (VS Code's own setting; the test window ignores saved window sizes), so the
    // width checks can size a page to 600px beside a second editor group. CI gives xvfb a 1920x1080 screen.
    await mkdir(path.join(userData, 'User'), { recursive: true });
    await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'window.newWindowDimensions': 'maximized' }));
    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes', ...screenArgs],
      extensionTestsEnv: { NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
