import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

// Launches a real VS Code with the extension under development: in a project set up with the extension, in an unrelated folder, and in a git
// project where Team Mode gets enabled. Run under `xvfb-run` on Linux (`npm run test:e2e`), or with DISPLAY set to a running display.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  for (const scenario of ['project', 'plain', 'team'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    if (scenario === 'team') await prepareTeamProject(workspace, extensionDevelopmentPath);
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
