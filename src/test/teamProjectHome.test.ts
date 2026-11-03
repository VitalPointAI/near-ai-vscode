// The project's online home on real git (G-61-2, G-61-3): whether teammates can reach it, whether the team setup is on it, and sharing
// exactly team.json to the integration branch without moving any of the person's other work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import type { TeamFile } from '../domain/team/types';
import { enableTeamMode } from '../team/enable';
import { cleanRepoUrl } from '../team/inviteBundle';
import { checkOnlineHome, configuredRemoteUrl, teamSetupShared } from '../team/projectHome';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { TEAM_FILE_REL, readTeamFile, writeTeamFile } from '../team/teamFile';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
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
