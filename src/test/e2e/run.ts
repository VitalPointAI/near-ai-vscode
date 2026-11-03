import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Launches a real VS Code with the extension under development: in a project set up with the extension, in an unrelated folder and in a git project where
// Team Mode gets enabled, one after another. Then one invite in two windows open at the same time: the lead's window (team-lead, then team-confirm)
// turns Team Mode on, shares, invites, and once the invitee has joined confirms them; the invitee's window (team-join) joins from a copy that is behind.
// The lead's steps stay in one window because VS Code keeps all storage, SecretStorage included, in memory while extension tests run, so the lead's
// device key cannot outlive the window and is never written anywhere else (T-61-94). The basic password store keeps VS Code from looking for an OS
// keyring (no keyring prompt on a desktop display). Run under `xvfb-run` on Linux (`npm run test:e2e`), or with DISPLAY set to a running display.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  const launch = (scenario: string, workspace: string, userData: string, extra: { args?: string[]; env?: Record<string, string> } = {}): Promise<number> => runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes', ...(extra.args ?? [])],
    extensionTestsEnv: { NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace, ...(extra.env ?? {}) }
  });
  for (const scenario of ['project', 'plain', 'team'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
    if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
    if (scenario === 'team') await prepareTeamProject(workspace, extensionDevelopmentPath);
    await launch(scenario, workspace, await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-')));
  }
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
