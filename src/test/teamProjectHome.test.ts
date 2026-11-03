// The project's online home on real git (G-61-2, G-61-3): whether teammates can reach it, whether the team setup is on it, and sharing
// exactly team.json to the integration branch without moving any of the person's other work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import type { TeamFile } from '../domain/team/types';
import { enableTeamMode } from '../team/enable';
import { cleanRepoUrl } from '../team/inviteBundle';
import { SHARE_COMMIT_MESSAGE, checkOnlineHome, configuredRemoteUrl, planShare, shareTeamSetup, teamSetupShared } from '../team/projectHome';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { TEAM_FILE_REL, readTeamFile, writeTeamFile } from '../team/teamFile';
import { makeCanaries } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, fakeGitResult, faultRunner, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

const PUBLIC_URL = 'https://example.invalid/team.git';
const COORDINATION_BRANCH = 'refs/heads/near-ai/coordination';

async function withFixture(clones: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones, initialised: true });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function clone(fixture: TeamFixture, name: string): string {
  return fixture.clones[name] as string;
}

// Clone a's origin becomes a public-looking address that git maps back to the bare remote, as in the team flow rig.
function usePublicUrl(fixture: TeamFixture, name: string, url: string = PUBLIC_URL): void {
  const dir = clone(fixture, name);
  gitIn(dir, ['config', `url.${fixture.remote}.insteadOf`, url]);
  gitIn(dir, ['remote', 'set-url', 'origin', url]);
}

function recorder(real: GitRunner = runGit): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, git: async (args, options) => { calls.push([...args]); return real(args, options); } };
}

async function enable(fixture: TeamFixture, name: string): Promise<TeamFile> {
  const result = await enableTeamMode({
    projectRoot: clone(fixture, name), globalStorageDir: fixture.storageDir(name), secrets: new MemorySecrets(),
    teamName: 'Home team', ownerName: 'Lead Owner'
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  const file = await readTeamFile(clone(fixture, name));
  assert.ok(file !== undefined);
  return file;
}

function remoteHasRef(fixture: TeamFixture, ref: string): boolean {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', fixture.remote, ref], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 2) return false;
    throw error;
  }
}

interface LocalSnapshot { heads: string; head: string; headCommit: string; index: string; status: string }

// Everything of the person's own work that sharing must leave alone: every local branch, HEAD, the index and the working tree status.
function snapshot(dir: string): LocalSnapshot {
  return {
    heads: gitIn(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
    head: gitIn(dir, ['symbolic-ref', '-q', 'HEAD']),
    headCommit: gitIn(dir, ['rev-parse', 'HEAD']),
    index: gitIn(dir, ['ls-files', '-s', '--debug']),
    status: gitIn(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])
  };
}

function pushes(calls: string[][]): string[][] {
  return calls.filter((call) => call[0] === 'push');
}

// git push, options, then exactly the remote name and <commit>:refs/heads/<branch>; never a force, mirror, all, tags or delete.
function assertNarrowPush(call: string[], remote: string, branch: string): void {
  for (const flag of call.filter((arg) => arg.startsWith('-'))) {
    assert.ok(!/^(--force|-f$|--force-with-lease|--mirror|--all|--tags|--delete|-d$|--prune)/.test(flag), `forbidden push option ${flag}`);
  }
  const positional = call.slice(1).filter((arg) => !arg.startsWith('-'));
  assert.equal(positional.length, 2, call.join(' '));
  assert.equal(positional[0], remote);
  assert.match(positional[1] ?? '', new RegExp(`^[0-9a-f]{40,64}:refs/heads/${branch}$`));
}

function leftoverShareIndexes(dir: string): string[] {
  const gitDir = gitIn(dir, ['rev-parse', '--absolute-git-dir']);
  return readdirSync(gitDir).filter((name) => name.startsWith('near-ai-share-index'));
}

function remoteFileOf(fixture: TeamFixture, rev: string): string {
  return execFileSync('git', ['show', `${rev}:${TEAM_FILE_REL}`], { cwd: fixture.remote, encoding: 'utf8' });
}

function remoteHasObject(fixture: TeamFixture, object: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', object], { cwd: fixture.remote, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// An unrelated local commit (a README edit) that must never reach the online home.
function commitReadmeEdit(dir: string, text = 'A local note that is not shared yet.\n'): string {
  writeFileSync(path.join(dir, 'README.md'), `# Team test project\n${text}`, 'utf8');
  gitIn(dir, ['commit', '-q', '-am', 'local readme edit']);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

// ---- Task 1: the online home and whether the team setup is on it ----------------------------------------------------------------------

test('checkOnlineHome tells shareable, local-only, no-remote and not-shareable from git config alone, with no network call', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    const { git, calls } = recorder();

    usePublicUrl(fixture, 'a');
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'shareable', remote: 'origin' });
    assert.equal(await configuredRemoteUrl(dir, 'origin', git), PUBLIC_URL, 'the raw configured value, not the insteadOf rewrite');

    gitIn(dir, ['remote', 'set-url', 'origin', 'git@example.invalid:team/repo.git']);
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'shareable', remote: 'origin' });

    gitIn(dir, ['remote', 'set-url', 'origin', fixture.remote]);
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'local-only', remote: 'origin' });

    gitIn(dir, ['remote', 'set-url', 'origin', 'file:///tmp/x']);
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'local-only', remote: 'origin' });

    // Remote helpers and an unsupported scheme: cleanRepoUrl refuses them, and its sentence is the reason.
    for (const url of ['ext::sh -c true', 'fd::3', 'ftp://example.invalid/x.git']) {
      gitIn(dir, ['remote', 'set-url', 'origin', url]);
      const home = await checkOnlineHome(dir, 'origin', git);
      const refused = cleanRepoUrl(url);
      assert.equal(refused.ok, false);
      assert.deepEqual(home, { kind: 'not-shareable', remote: 'origin', reason: refused.ok ? '' : refused.reason });
      const text = JSON.stringify(home);
      assert.ok(!text.includes(url) && !text.includes('example.invalid'), `the reason never carries the address: ${text}`);
    }
    // Credentials: cleanRepoUrl would strip them for an invite, but an address this computer reaches with a password or token in it is not
    // one teammates can use as it is, so it is not shareable, with cleanRepoUrl's own credentials sentence.
    const credentialsSentence = cleanRepoUrl('user:password@example.invalid:repo.git');
    assert.equal(credentialsSentence.ok, false);
    for (const url of ['https://user:secret@example.invalid/x.git', 'https://secrettoken@example.invalid/x.git', 'ssh://git:secret@example.invalid/x.git', 'user:secret@example.invalid:x.git']) {
      gitIn(dir, ['remote', 'set-url', 'origin', url]);
      const home = await checkOnlineHome(dir, 'origin', git);
      assert.deepEqual(home, { kind: 'not-shareable', remote: 'origin', reason: credentialsSentence.ok ? '' : credentialsSentence.reason }, url);
      const text = JSON.stringify(home);
      assert.ok(!text.includes(url) && !text.includes('secret') && !text.includes('example.invalid'), `the reason never carries the address: ${text}`);
    }
    gitIn(dir, ['remote', 'set-url', 'origin', 'ssh://git@example.invalid/team.git']);
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'shareable', remote: 'origin' }, 'a plain ssh login name is not a credential');

    assert.deepEqual(await checkOnlineHome(dir, 'upstream', git), { kind: 'no-remote', remote: 'upstream' });
    assert.deepEqual(await checkOnlineHome(dir, '-bad name', git), { kind: 'no-remote', remote: '-bad name' });
    gitIn(dir, ['remote', 'remove', 'origin']);
    assert.deepEqual(await checkOnlineHome(dir, 'origin', git), { kind: 'no-remote', remote: 'origin' });

    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call[0], 'config', `only git config is read: ${call.join(' ')}`);
  });
});

test('tracer: after Enable the team setup is not shared until main is pushed, and a different organization link counts as not shared', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');

    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'not-shared', missing: 'team-file' });

    gitIn(dir, ['push', '-q', 'origin', 'main']);
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'shared' });

    const linked: TeamFile = { ...teamFile, near: { organizationId: 'org_123', workspaceId: 'ws:456' } };
    await writeTeamFile(dir, linked);
    gitIn(dir, ['add', '-f', TEAM_FILE_REL]);
    gitIn(dir, ['commit', '-q', '-m', 'link the organization']);
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile: linked, branch: 'main' }), { kind: 'not-shared', missing: 'different-team-file' });
    // The online home still holds the team setup this computer had before, which is shared from the old file's point of view.
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'shared' });
  });
});

test('teamSetupShared reports a missing integration branch, a missing coordination record, an unreachable home and a local-only home', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');

    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'release' }), { kind: 'not-shared', missing: 'branch' });

    // The online home cannot be reached: git's rewrite points at a folder that does not exist.
    gitIn(dir, ['config', '--unset-all', `url.${fixture.remote}.insteadOf`]);
    gitIn(dir, ['config', `url.${path.join(fixture.root, 'missing.git')}.insteadOf`, PUBLIC_URL]);
    const unknown = await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' });
    assert.equal(unknown.kind, 'unknown');
    assert.ok(unknown.kind === 'unknown' && unknown.detail !== '' && !unknown.detail.includes(PUBLIC_URL), JSON.stringify(unknown));
    gitIn(dir, ['config', '--unset-all', `url.${path.join(fixture.root, 'missing.git')}.insteadOf`]);
    gitIn(dir, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);

    // A local-only origin is refused before any network call.
    gitIn(dir, ['remote', 'set-url', 'origin', fixture.remote]);
    const { git, calls } = recorder();
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main', git }), {
      kind: 'not-reachable-by-teammates', home: { kind: 'local-only', remote: 'origin' }
    });
    assert.ok(calls.every((call) => call[0] !== 'fetch' && call[0] !== 'ls-remote' && call[0] !== 'push'), JSON.stringify(calls));
    usePublicUrl(fixture, 'a');

    gitIn(fixture.remote, ['update-ref', '-d', COORDINATION_BRANCH]);
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'record-missing' });
  });
});

test('a team.json on the online home that cannot be read as a team file counts as a different team file', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    const other = clone(fixture, 'b');
    writeFileSync(path.join(other, '.planning', '.near-ai', 'team.json'), '{ not json', 'utf8');
    gitIn(other, ['add', '-f', TEAM_FILE_REL]);
    gitIn(other, ['commit', '-q', '-m', 'broken team file']);
    gitIn(other, ['push', '-q', 'origin', 'main']);
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'not-shared', missing: 'different-team-file' });
    assert.equal(readFileSync(path.join(dir, TEAM_FILE_REL), 'utf8').includes(teamFile.teamId), true, 'the local file is untouched');
  });
});

// ---- Task 2: planning and sharing exactly the team setup ------------------------------------------------------------------------------

test('only the Enable commit unshared on main: planShare gives fast-forward 1 and the share moves the online main to the local main', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    const { git, calls } = recorder();
    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'main', git }), { kind: 'fast-forward', commits: 1 });
    const before = snapshot(dir);
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git }), { ok: true, how: 'fast-forward' });
    assert.equal(gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']), gitIn(dir, ['rev-parse', 'refs/heads/main']));
    assert.deepEqual(snapshot(dir), before);
    assert.equal(pushes(calls).length, 1);
    for (const call of pushes(calls)) assertNarrowPush(call, 'origin', 'main');
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'shared' });
  });
});

test('an unrelated local commit before Enable: planShare gives setup-only and only team.json reaches the online home, nothing local moves', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const oldTip = gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const readmeCommit = commitReadmeEdit(dir);
    const teamFile = await enable(fixture, 'a');
    const { git, calls } = recorder();
    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'main', git }), { kind: 'setup-only' });

    const before = snapshot(dir);
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git }), { ok: true, how: 'setup-only' });
    assert.deepEqual(snapshot(dir), before, 'local branches, HEAD, the index and the working tree are untouched');
    assert.deepEqual(leftoverShareIndexes(dir), [], 'the temporary index is removed');
    assert.equal(pushes(calls).length, 1);
    for (const call of pushes(calls)) assertNarrowPush(call, 'origin', 'main');

    const shared = gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']);
    assert.equal(gitIn(fixture.remote, ['rev-parse', `${shared}^`]), oldTip, 'one new commit on the old online tip');
    assert.equal(gitIn(fixture.remote, ['rev-list', '--count', `${oldTip}..${shared}`]), '1');
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%s', shared]), SHARE_COMMIT_MESSAGE);
    assert.equal(gitIn(fixture.remote, ['diff-tree', '--no-commit-id', '-r', '--name-only', shared]), TEAM_FILE_REL);
    assert.equal(remoteFileOf(fixture, shared), readFileSync(path.join(dir, TEAM_FILE_REL), 'utf8'), 'byte for byte the local team.json');
    assert.equal(remoteHasObject(fixture, readmeCommit), false, 'the unrelated commit stays on this computer');
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'shared' });

    // The lead catches up without a conflict, by merge and, from the same starting point, by rebase.
    const start = gitIn(dir, ['rev-parse', 'HEAD']);
    gitIn(dir, ['fetch', '-q', 'origin']);
    gitIn(dir, ['merge', '-q', '--no-edit', 'origin/main']);
    assert.equal(readFileSync(path.join(dir, TEAM_FILE_REL), 'utf8'), remoteFileOf(fixture, shared));
    assert.equal(gitIn(dir, ['status', '--porcelain']), '');
    gitIn(dir, ['reset', '-q', '--hard', start]);
    gitIn(dir, ['pull', '-q', '--rebase', 'origin', 'main']);
    assert.equal(gitIn(dir, ['rev-list', '--count', 'origin/main..HEAD']), '1', 'only the README commit is left; the Enable commit was already applied');
    assert.equal(gitIn(dir, ['log', '-1', '--format=%s', 'HEAD']), 'local readme edit');
  });
});

test('Enable on a feature branch: the share lands on main, not on the feature branch, and the lead fast-forwards main', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    gitIn(dir, ['checkout', '-q', '-b', 'feature']);
    const teamFile = await enable(fixture, 'a');
    assert.equal(gitIn(dir, ['rev-parse', 'main']), gitIn(fixture.remote, ['rev-parse', 'main']), 'main is unchanged');
    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'setup-only' });
    const before = snapshot(dir);
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main' }), { ok: true, how: 'setup-only' });
    assert.deepEqual(snapshot(dir), before);
    assert.equal(remoteHasRef(fixture, 'refs/heads/feature'), false);
    assert.equal(remoteFileOf(fixture, 'refs/heads/main'), readFileSync(path.join(dir, TEAM_FILE_REL), 'utf8'));

    gitIn(dir, ['fetch', '-q', 'origin']);
    gitIn(dir, ['checkout', '-q', 'main']);
    gitIn(dir, ['merge', '-q', '--ff-only', 'origin/main']);
    assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), gitIn(fixture.remote, ['rev-parse', 'main']));
  });
});

test('an online home without the integration branch: planShare gives first-upload, and only that consented plan uploads the local branch', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    gitIn(fixture.remote, ['update-ref', '-d', 'refs/heads/main']);
    const plan = await planShare({ projectRoot: dir, teamFile, branch: 'main' });
    assert.deepEqual(plan, { kind: 'first-upload' });

    const { git, calls } = recorder();
    const unasked = await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git });
    assert.equal(unasked.ok, false);
    assert.equal(!unasked.ok && unasked.code, 'changed', 'without the first-upload plan nothing is uploaded');
    assert.equal(pushes(calls).length, 0);
    assert.equal(remoteHasRef(fixture, 'refs/heads/main'), false);

    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git, plan }), { ok: true, how: 'first-upload' });
    assert.equal(gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']), gitIn(dir, ['rev-parse', 'refs/heads/main']));
    for (const call of pushes(calls)) assertNarrowPush(call, 'origin', 'main');

    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'release' }), {
      kind: 'blocked', reason: 'no-local-branch', detail: 'Neither this computer nor the team remote has the integration branch release.'
    });
  });
});

test('already shared: planShare gives already and shareTeamSetup makes no push', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    gitIn(dir, ['push', '-q', 'origin', 'main']);
    const { git, calls } = recorder();
    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'main', git }), { kind: 'already' });
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git }), { ok: true, how: 'already' });
    assert.equal(pushes(calls).length, 0);
  });
});

test('with no user name or email in any git config the setup-only commit is made with the neutral NEAR AI identity', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    commitReadmeEdit(dir);
    const teamFile = await enable(fixture, 'a');
    gitIn(dir, ['config', '--unset', 'user.name']);
    gitIn(dir, ['config', '--unset', 'user.email']);
    // Without this git could guess an address from the host name; the person has told git nothing.
    gitIn(dir, ['config', 'user.useConfigOnly', 'true']);
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main' }), { ok: true, how: 'setup-only' });
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main']), 'NEAR AI Team <coordination@near-ai.invalid>|NEAR AI Team <coordination@near-ai.invalid>');
    assert.deepEqual(leftoverShareIndexes(dir), []);
  });
});

test("with the person's identity in git config the setup-only commit is theirs", async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    commitReadmeEdit(dir);
    const teamFile = await enable(fixture, 'a');
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main' }), { ok: true, how: 'setup-only' });
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%an <%ae>', 'main']), 'Team Test <team-test@example.invalid>');
  });
});

// ---- Task 3: races, refusals and redaction --------------------------------------------------------------------------------------------

// Clone b, a teammate on the same online home, pushes an unrelated commit to main. Returns the new commit.
function teammatePushes(fixture: TeamFixture, n: number): string {
  const other = clone(fixture, 'b');
  gitIn(other, ['pull', '-q', '--ff-only', 'origin', 'main']);
  writeFileSync(path.join(other, `teammate-${n}.txt`), `change ${n}\n`, 'utf8');
  gitIn(other, ['add', `teammate-${n}.txt`]);
  gitIn(other, ['commit', '-q', '-m', `teammate change ${n}`]);
  gitIn(other, ['push', '-q', 'origin', 'main']);
  return gitIn(other, ['rev-parse', 'HEAD']);
}

// Runs `before` just ahead of every push this runner is asked to make, and records the push arguments.
function beforeEveryPush(before: () => void): { git: GitRunner; pushCalls: string[][] } {
  const pushCalls: string[][] = [];
  return {
    pushCalls,
    git: async (args, options) => {
      if (args[0] === 'push') {
        before();
        pushCalls.push([...args]);
      }
      return runGit(args, options);
    }
  };
}

test('a teammate pushing between the plan and the push: the share re-plans as setup-only and lands on top of their commit', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    assert.deepEqual(await planShare({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'fast-forward', commits: 1 });
    let theirs = '';
    let raced = false;
    const { git, pushCalls } = beforeEveryPush(() => {
      if (raced) return;
      raced = true;
      theirs = teammatePushes(fixture, 1);
    });
    const before = snapshot(dir);
    assert.deepEqual(await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git }), { ok: true, how: 'setup-only' });
    assert.equal(pushCalls.length, 2, 'the first push lost the race, the second landed');
    for (const call of pushCalls) assertNarrowPush(call, 'origin', 'main');
    assert.equal(gitIn(fixture.remote, ['rev-parse', 'main^']), theirs, "the teammate's commit stays, as the parent of the share commit");
    assert.equal(gitIn(fixture.remote, ['diff-tree', '--no-commit-id', '-r', '--name-only', 'main']), TEAM_FILE_REL);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(await teamSetupShared({ projectRoot: dir, teamFile, branch: 'main' }), { kind: 'shared' });
  });
});

test('an online home that moves before every push: after exactly the given attempts the share stops as changed and nothing local moved', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    let n = 0;
    const { git, pushCalls } = beforeEveryPush(() => { n += 1; teammatePushes(fixture, n); });
    const before = snapshot(dir);
    const result = await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main', git, attempts: 3 });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'changed');
    assert.equal(pushCalls.length, 3);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(leftoverShareIndexes(dir), []);
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%s', 'main']), 'teammate change 3', 'nothing of this computer reached main');
  });
});

test('a refusing online home (pre-receive hook, for example a protected branch) gives rejected with the redacted reason and changes nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    const hook = path.join(fixture.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch: main cannot be pushed to by https://bot:hooksecret@example.invalid/x" >&2\nexit 1\n', 'utf8');
    chmodSync(hook, 0o755);
    const tip = gitIn(fixture.remote, ['rev-parse', 'main']);
    const before = snapshot(dir);
    const result = await shareTeamSetup({ projectRoot: dir, teamFile, branch: 'main' });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'rejected');
    assert.ok(!result.ok && result.detail.includes('protected branch'), JSON.stringify(result));
    assert.ok(!result.ok && !result.detail.includes('hooksecret'), JSON.stringify(result));
    assert.deepEqual(snapshot(dir), before);
    assert.equal(gitIn(fixture.remote, ['rev-parse', 'main']), tip);
  });
});

test('no result, detail or thrown message carries a credential in the configured URL, or the configured URL of an unreachable home', async () => {
  await withFixture(['a'], async (fixture) => {
    const dir = clone(fixture, 'a');
    usePublicUrl(fixture, 'a');
    const teamFile = await enable(fixture, 'a');
    const canary = makeCanaries().urlPassword;
    const secretUrl = `https://user:${canary}@example.invalid/team.git`;
    usePublicUrl(fixture, 'a', secretUrl);

    const seen: string[] = [];
    const capture = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        seen.push(JSON.stringify(await run()));
      } catch (error) {
        seen.push(error instanceof Error ? `${error.message} ${String(error.stack)}` : String(error));
      }
    };
    const input = { projectRoot: dir, teamFile, branch: 'main' };
    const home = await checkOnlineHome(dir, 'origin');
    assert.equal(home.kind, 'not-shareable');
    seen.push(JSON.stringify(home));
    await capture(() => teamSetupShared(input));
    await capture(() => planShare(input));
    await capture(() => shareTeamSetup(input));
    await capture(() => shareTeamSetup({ ...input, plan: { kind: 'first-upload' } }));
    for (const text of seen) assert.ok(!text.includes(canary), `the canary leaked: ${text}`);

    // An https home whose rewrite points at a missing folder, and a push that fails naming the configured address.
    gitIn(dir, ['config', '--unset-all', `url.${fixture.remote}.insteadOf`]);
    gitIn(dir, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    gitIn(dir, ['config', `url.${path.join(fixture.root, 'missing.git')}.insteadOf`, PUBLIC_URL]);
    const offline: string[] = [];
    const unknown = await teamSetupShared(input);
    assert.equal(unknown.kind, 'unknown');
    offline.push(JSON.stringify(unknown));
    const blocked = await planShare(input);
    assert.equal(blocked.kind === 'blocked' && blocked.reason, 'offline');
    offline.push(JSON.stringify(blocked));
    const failed = await shareTeamSetup(input);
    assert.equal(!failed.ok && failed.code, 'offline');
    offline.push(JSON.stringify(failed));

    gitIn(dir, ['config', '--unset-all', `url.${path.join(fixture.root, 'missing.git')}.insteadOf`]);
    gitIn(dir, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    const git = faultRunner(runGit, [{
      when: (args) => args[0] === 'push',
      replace: () => fakeGitResult(128, '', `fatal: unable to access '${PUBLIC_URL}/': Could not resolve host: example.invalid\n`)
    }]);
    const noAnswer = await shareTeamSetup({ ...input, git });
    assert.equal(!noAnswer.ok && noAnswer.code, 'offline');
    offline.push(JSON.stringify(noAnswer));
    for (const text of offline) assert.ok(!text.includes(PUBLIC_URL), `the configured URL leaked: ${text}`);
  });
});
