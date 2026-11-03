// Joining from a copy of the team's project the invitee already has (Phase 61 plan 18, G-61-4). Real git in mkdtemp folders: clone a is the
// owner, clone b was cloned before Team Mode was turned on and points at the same public address through an insteadOf rule, exactly like
// clone a. prepareJoin brings b up to date by itself when that is safe, and refuses with a precise reason, changing nothing, when it is not.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { pushCodeBranch } from '../team/enable';
import { parseInviteBundle } from '../team/inviteBundle';
import { prepareJoin } from '../team/join';
import type { JoinPreparation } from '../team/join';
import { catchUpCopy, projectAddressKey } from '../team/joinCatchUp';
import type { CatchUpReason } from '../team/joinCatchUp';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { TEAM_FILE_REL, readTeamFile, teamFilePath, writeTeamFile } from '../team/teamFile';
import { newTeamId } from '../team/identity';
import { closeRig, createRig, enable, invite, rootOf, teamIdOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { gitIn } from './helpers/teamHarness';

const PUBLIC_URL = 'https://example.invalid/team.git';

// Clone b gets the same public address as clone a, mapped to the real bare remote, so it is a copy of the same project.
function pointAtPublic(rig: Rig, clone: 'b' | 'c', target: string = rig.fixture.remote): void {
  const dir = rootOf(rig, clone);
  gitIn(dir, ['config', `url.${target}.insteadOf`, PUBLIC_URL]);
  gitIn(dir, ['remote', 'set-url', 'origin', PUBLIC_URL]);
}

interface Recorder { git: GitRunner; calls: string[][] }

function recorder(): Recorder {
  const calls: string[][] = [];
  return { calls, git: async (args, options) => { calls.push([...args]); return runGit(args, options); } };
}

// The owner turns Team Mode on in clone a, publishes main (unless told not to) and invites a developer. Clone b is behind and clean.
async function withTeam(run: (rig: Rig, bundle: string) => Promise<void>, options: { publish?: boolean; linked?: boolean } = {}): Promise<void> {
  const rig = await createRig({ linked: options.linked ?? false });
  try {
    await enable(rig);
    if (options.publish !== false) {
      const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
      assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
    }
    pointAtPublic(rig, 'b');
    const { bundle } = await invite(rig, rig.dev);
    await run(rig, bundle);
  } finally {
    await closeRig(rig);
  }
}

function remoteMain(rig: Rig): string {
  return gitIn(rig.fixture.remote, ['rev-parse', 'refs/heads/main']);
}

// T-61-75, T-61-76: only these git commands, a merge only ever as a fast-forward, the private ref the only one ever deleted, and nothing the
// invite says (its address) or any address at all ever reaches git.
const ALLOWED_GIT = new Set(['config', 'symbolic-ref', 'rev-parse', 'fetch', 'ls-remote', 'cat-file', 'merge-base', 'status', 'ls-files', 'update-ref', 'merge']);

function auditCalls(calls: string[][], bundle: string): void {
  const repo = parseInviteBundle(bundle).repo;
  for (const args of calls) {
    const command = args[0] ?? '';
    assert.ok(ALLOWED_GIT.has(command), `git ${command} is not used by a catch-up`);
    if (command === 'update-ref') assert.deepEqual(args, ['update-ref', '-d', 'refs/near-ai/catch-up/head']);
    if (command === 'merge') assert.ok(args.includes('--ff-only'), 'a merge is only ever a fast-forward');
    if (command === 'config') assert.ok(args[1] === '--get' || args[1] === '--get-regexp', 'git config is only read');
    for (const arg of args) {
      assert.equal(arg.includes(repo), false, 'the invite\'s address never reaches git');
      assert.equal(arg.includes('example.invalid'), false, 'no address reaches git');
      assert.equal(/:\/\//.test(arg), false, 'no URL argument reaches git');
    }
  }
}

interface Snapshot { head: string; branches: string; staged: string; status: string }

// HEAD (or the detached commit), every local branch, the staged changes and the working tree status.
function snapshot(dir: string): Snapshot {
  return {
    head: `${gitIn(dir, ['rev-parse', 'HEAD'])} ${gitIn(dir, ['rev-parse', '--symbolic-full-name', 'HEAD'])}`,
    branches: gitIn(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
    staged: gitIn(dir, ['diff', '--cached', '--binary']),
    status: gitIn(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])
  };
}

// prepareJoin refuses with the reason and the invite's own address and team, changes nothing in the copy, and uses only safe git calls.
async function refusedWith(rig: Rig, bundle: string, reason: CatchUpReason, dir: string = rootOf(rig, 'b')): Promise<Extract<JoinPreparation, { kind: 'not-ready' }>> {
  const before = snapshot(dir);
  const recorded = recorder();
  const prepared = await prepareJoin({ projectRoot: dir, bundleText: bundle, git: recorded.git });
  assert.equal(prepared.kind, 'not-ready', JSON.stringify(prepared.kind === 'ready' ? { kind: prepared.kind, updated: prepared.updated } : prepared));
  if (prepared.kind !== 'not-ready') throw new Error('not refused');
  assert.equal(prepared.reason, reason);
  assert.equal(prepared.repoUrl, parseInviteBundle(bundle).repo);
  assert.equal(prepared.teamId, teamIdOf(rig));
  assert.deepEqual(snapshot(dir), before, 'nothing in the copy changed');
  auditCalls(recorded.calls, bundle);
  return prepared;
}

function readyOf(prepared: JoinPreparation): Extract<JoinPreparation, { kind: 'ready' }> {
  assert.equal(prepared.kind, 'ready', JSON.stringify(prepared.kind === 'ready' ? prepared.kind : prepared));
  if (prepared.kind !== 'ready') throw new Error('not ready');
  return prepared;
}

// ---- Task 1: a behind copy of the same project is brought up to date ---------------------------------------------------------------------

test('tracer: a behind clone of the same project is brought up to date by itself and prepareJoin answers ready', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    assert.equal(await readTeamFile(b), undefined, 'clone b was made before Team Mode and has no team.json');
    assert.notEqual(gitIn(b, ['rev-parse', 'HEAD']), remoteMain(rig), 'clone b is behind the published main');

    const steps: string[] = [];
    const recorded = recorder();
    const prepared = readyOf(await prepareJoin({ projectRoot: b, bundleText: bundle, git: recorded.git, onStep: (step) => steps.push(step) }));
    assert.equal(prepared.updated, true);
    assert.deepEqual(steps, ['update']);
    assert.equal(prepared.teamFile.teamId, teamIdOf(rig));
    assert.equal(gitIn(b, ['rev-parse', 'HEAD']), remoteMain(rig), 'clone b now has the published main');
    assert.equal(gitIn(b, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal((await readTeamFile(b))?.teamId, teamIdOf(rig));
    assert.ok(recorded.calls.some((args) => args[0] === 'fetch'), 'the copy was fetched');
    assert.ok(recorded.calls.some((args) => args[0] === 'merge'), 'the copy was fast-forwarded');
    auditCalls(recorded.calls, bundle);
  });
});

test('a copy that is already up to date with a matching team.json is ready with no update and no network call', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    gitIn(b, ['pull', '-q', '--ff-only', 'origin', 'main']);
    const recorded = recorder();
    const prepared = readyOf(await prepareJoin({ projectRoot: b, bundleText: bundle, git: recorded.git }));
    assert.equal(prepared.updated, undefined);
    assert.equal('updated' in prepared, false);
    assert.equal(recorded.calls.some((args) => args[0] === 'fetch' || args[0] === 'ls-remote'), false, 'no network call');
  });
});

test('projectAddressKey gives one key for every way of writing the same address, and none for a local path, a file address or a password', () => {
  const key = projectAddressKey('https://github.com/Org/Repo.git');
  assert.equal(key, 'github.com/org/repo');
  for (const same of ['https://github.com/org/repo/', 'git@github.com:org/repo.git', 'ssh://git@github.com/org/repo', 'ssh://git@github.com:22/org/repo.git', 'https://GitHub.com/org/repo']) {
    assert.equal(projectAddressKey(same), key, same);
  }
  for (const other of ['https://gitlab.com/org/repo.git', 'https://github.com/org/other.git', 'git@github.com:other/repo.git', 'ssh://git@github.com:2222/org/repo']) {
    assert.notEqual(projectAddressKey(other), key, other);
  }
  for (const none of ['/home/someone/repo', './repo', 'C:\\work\\repo', 'file:///tmp/repo.git', 'https://user:secret@github.com/org/repo.git', 'ssh://git:secret@github.com/org/repo', 'ext::sh -c touch% /tmp/x', '']) {
    assert.equal(projectAddressKey(none), undefined, none);
  }
});

// ---- Task 2: every refusal leaves the copy untouched -------------------------------------------------------------------------------------

test('a copy with an edited tracked file is not updated (local-changes), and the edit, HEAD, branches, index and status stay as they were', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    const readme = path.join(b, 'README.md');
    await fs.writeFile(readme, '# Team test project\nMy own edit\n', 'utf8');
    await refusedWith(rig, bundle, 'local-changes');
    assert.equal(await fs.readFile(readme, 'utf8'), '# Team test project\nMy own edit\n');

    // The core answer itself: a code only.
    const direct = await catchUpCopy({ projectRoot: b, remote: 'origin', teamId: teamIdOf(rig) });
    assert.deepEqual(direct, { ok: false, reason: 'local-changes' });

    // A staged change is a local change too.
    gitIn(b, ['add', 'README.md']);
    await refusedWith(rig, bundle, 'local-changes');
  });
});

test('an untracked team.json left by an earlier attempt is a local change and stays exactly as it was', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    const teamFile = rig.teamFile;
    assert.ok(teamFile !== undefined);
    await writeTeamFile(b, { ...teamFile, teamId: newTeamId() });
    const before = await fs.readFile(teamFilePath(b));
    assert.equal(gitIn(b, ['ls-files', '--others', '--', TEAM_FILE_REL]), TEAM_FILE_REL, 'git ignores the folder but the file is there, untracked');
    await refusedWith(rig, bundle, 'local-changes');
    assert.deepEqual(await fs.readFile(teamFilePath(b)), before, 'the file is unchanged byte for byte');
  });
});

test('an untracked file the online version would overwrite stops the fast-forward (local-changes) with a redacted detail', async () => {
  await withTeam(async (rig, bundle) => {
    const a = rootOf(rig, 'a');
    await fs.writeFile(path.join(a, 'notes.txt'), 'shared notes\n', 'utf8');
    gitIn(a, ['add', 'notes.txt']);
    gitIn(a, ['commit', '-q', '-m', 'notes']);
    gitIn(a, ['push', '-q', 'origin', 'main']);
    const b = rootOf(rig, 'b');
    await fs.writeFile(path.join(b, 'notes.txt'), 'my own notes\n', 'utf8');
    const refused = await refusedWith(rig, bundle, 'local-changes');
    assert.ok(refused.detail !== undefined && refused.detail !== '', 'the technical reason is kept for the output channel');
    assert.equal(refused.detail?.includes(PUBLIC_URL), false);
    assert.equal(await fs.readFile(path.join(b, 'notes.txt'), 'utf8'), 'my own notes\n');
  });
});

test('a copy with a commit that is not online is not updated (unshared-work) and nothing changes', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    await fs.writeFile(path.join(b, 'mine.txt'), 'local work\n', 'utf8');
    gitIn(b, ['add', 'mine.txt']);
    gitIn(b, ['commit', '-q', '-m', 'local work']);
    await refusedWith(rig, bundle, 'unshared-work');
    assert.equal(await readTeamFile(b), undefined);
  });
});

test('a copy on another version is not updated (other-version): a branch that is not online, an online branch without the team, and a detached copy', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    gitIn(b, ['switch', '-q', '-c', 'feature']);
    await refusedWith(rig, bundle, 'other-version');
    assert.equal(gitIn(b, ['for-each-ref', '--format=%(refname)', 'refs/near-ai']), '', 'the private ref was deleted');

    // The branch is online now but has no team.json; the online default branch has it.
    gitIn(b, ['push', '-q', 'origin', 'feature']);
    await refusedWith(rig, bundle, 'other-version');
    assert.equal(gitIn(b, ['for-each-ref', '--format=%(refname)', 'refs/near-ai']), '');

    gitIn(b, ['switch', '-q', '--detach', 'main']);
    await refusedWith(rig, bundle, 'other-version');
  });
});

test('when the owner never published the project with the team in it, the copy is not updated (not-shared)', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    await refusedWith(rig, bundle, 'not-shared');
    assert.equal(await readTeamFile(b), undefined);
    assert.equal(gitIn(b, ['for-each-ref', '--format=%(refname)', 'refs/near-ai']), '');
  }, { publish: false });
});

test('when the online home cannot be reached the copy is not updated (offline) and the detail is redacted', async () => {
  await withTeam(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    gitIn(b, ['config', '--remove-section', `url.${rig.fixture.remote}`]);
    gitIn(b, ['config', `url.${path.join(rig.fixture.root, 'missing.git')}.insteadOf`, PUBLIC_URL]);
    const refused = await refusedWith(rig, bundle, 'offline');
    assert.ok(refused.detail !== undefined && refused.detail !== '');
    assert.equal(refused.detail?.includes(PUBLIC_URL), false, 'the configured address is never in the detail');
    assert.equal(await readTeamFile(b), undefined);
  });
});
