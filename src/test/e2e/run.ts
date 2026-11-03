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

const SCENARIOS = ['project', 'plain', 'team', 'team-lead', 'team-join', 'team-confirm'] as const;
type Scenario = (typeof SCENARIOS)[number];

// Launches a real VS Code with the extension under development: in a project set up with the extension, in an unrelated folder, in a git project where
// Team Mode gets enabled, and then three launches of one invite: the lead turns Team Mode on and invites (user data L), the invitee joins from a copy that
// is behind (user data J), and the lead confirms them (user data L again, so the lead's device key in SecretStorage is still there). The three invite
// launches use the basic password store, so SecretStorage persists between launches without an OS keyring. Run under `xvfb-run` on Linux
// (`npm run test:e2e`), or with DISPLAY set to a running display.
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  const invite = await prepareInviteProjects();
  try {
    const leadUserData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-lead-'));
    const joinUserData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-join-'));
    for (const scenario of SCENARIOS as readonly Scenario[]) {
      const inviteLaunch = scenario === 'team-lead' || scenario === 'team-join' || scenario === 'team-confirm';
      let workspace: string;
      let userData: string;
      if (inviteLaunch) {
        workspace = scenario === 'team-join' ? invite.copy : invite.lead;
        userData = scenario === 'team-join' ? joinUserData : leadUserData;
      } else {
        workspace = await mkdtemp(path.join(tmpdir(), `near-ai-e2e-${scenario}-`));
        if (scenario === 'project') await mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true });
        if (scenario === 'team') await prepareTeamProject(workspace, extensionDevelopmentPath);
        userData = await mkdtemp(path.join(tmpdir(), 'near-ai-e2e-user-'));
      }
      await runTests({
        version,
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
          workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes',
          ...(inviteLaunch ? ['--password-store=basic'] : [])
        ],
        extensionTestsEnv: {
          NEAR_AI_E2E: '1', NEAR_AI_E2E_SCENARIO: scenario, NEAR_AI_E2E_WORKSPACE: workspace,
          ...(inviteLaunch ? { NEAR_AI_E2E_HANDOFF: invite.handoff, NEAR_AI_E2E_REMOTE: invite.remote } : {})
        }
      });
    }
  } finally {
    // The invite text is a test secret: it is not left on disk, whatever happened above.
    await rm(invite.handoff, { recursive: true, force: true });
    if (existsSync(invite.handoff)) throw new Error(`The handoff folder could not be removed: ${invite.handoff}`);
    console.log('The handoff folder with the invite text is removed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
