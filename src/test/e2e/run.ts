import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Launches a real VS Code with the extension under development, once in a project set up with the
// extension and once in an unrelated folder. Run under `xvfb-run` on Linux (`npm run test:e2e`).
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  for (const scenario of ['project', 'plain'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    const userData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-'));
    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
