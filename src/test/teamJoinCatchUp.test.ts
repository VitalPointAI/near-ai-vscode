// Joining from a copy of the team's project the invitee already has (Phase 61 plan 18, G-61-4). Real git in mkdtemp folders: clone a is the
// owner, clone b was cloned before Team Mode was turned on and points at the same public address through an insteadOf rule, exactly like
// clone a. prepareJoin brings b up to date by itself when that is safe, and refuses with a precise reason, changing nothing, when it is not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pushCodeBranch } from '../team/enable';
import { prepareJoin } from '../team/join';
import type { JoinPreparation } from '../team/join';
import { projectAddressKey } from '../team/joinCatchUp';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { readTeamFile } from '../team/teamFile';
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
