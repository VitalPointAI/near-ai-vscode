// Enable Team Mode on real git: preconditions, defaults, the team.json-only commit, the existing-team cases, rollback and the Push helper.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { teamMaterializer } from '../domain/team/materialize';
import { AuditStore } from '../services/auditStore';
import { API_KEY_SECRET, REFRESH_TOKEN_SECRET } from '../services/auth';
import type { GenesisAnchor, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { fileMirrorMark, mirrorRosterEvents } from '../team/auditMirror';
import { ENABLE_COMMIT_MESSAGE, checkEnablePreconditions, enableDefaults, enableTeamMode, pushCodeBranch } from '../team/enable';
import type { EnableInput } from '../team/enable';
import { TeamLog } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { DEVICE_KEY_SECRET_PREFIX, createDeviceIdentity, deviceKeySecretName, emailHash, loadDeviceIdentity } from '../team/identity';
import { GitNotFoundError, runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { TEAM_FILE_REL, parseTeamFile, readTeamFile, teamStorageDir } from '../team/teamFile';
import { deviceKeyForms, makeCanaries, scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, fakeGitResult, faultRunner, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

const OWNER_EMAIL = 'Lead.Owner@Example.invalid';
const COORDINATION_BRANCH = 'refs/heads/near-ai/coordination';
// src/services/spendTracking.ts holds this constant but imports vscode, which a node test cannot load, so the key is repeated here.
const REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken';

async function withFixture(clones: string[], run: (fixture: TeamFixture) => Promise<void>, options: { initialised?: boolean } = {}): Promise<void> {
  const fixture = await createTeamFixture({ clones, initialised: options.initialised ?? true });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function inputFor(fixture: TeamFixture, name: string, secrets: MemorySecrets, extra: Partial<EnableInput> = {}): EnableInput {
  return {
    projectRoot: fixture.clones[name] as string, globalStorageDir: fixture.storageDir(name), secrets,
    teamName: 'Enable team', ownerName: 'Lead Owner', ownerEmail: OWNER_EMAIL, ...extra
  };
}

function remoteRef(fixture: TeamFixture, ref: string): string {
  return gitIn(fixture.remote, ['rev-parse', ref]);
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

function anchorOf(teamFile: TeamFile): GenesisAnchor {
  return { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: teamFile.genesis.ownerDevice };
}

// Everything the remote's coordination branch holds, as text, for the email checks.
function remoteHistory(fixture: TeamFixture): string {
  return gitIn(fixture.remote, ['log', COORDINATION_BRANCH, '-p', '--format=%B']);
}

// The per-team folders under <globalStorage>/team; empty when none was created or all were removed.
async function teamFolders(globalStorageDir: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(globalStorageDir, 'team'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function plainDirectory(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, '.planning', '.near-ai'), { recursive: true });
  return dir;
}

test('preconditions report each missing prerequisite in plain language and write nothing', async () => {
  await withFixture(['plain'], async (fixture) => {
    const root = fixture.clones.plain as string;
    const missing = await checkEnablePreconditions(root);
    assert.deepEqual(missing.ok ? undefined : missing.code, 'not-initialised');
    assert.match(missing.ok ? '' : missing.message, /NEAR AI: Set Up/);
  }, { initialised: false });

  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const ready = await checkEnablePreconditions(root);
    assert.deepEqual(ready, { ok: true, branch: 'main' });

    const noGit: GitRunner = async () => { throw new GitNotFoundError(); };
    const gitMissing = await checkEnablePreconditions(root, 'origin', noGit);
    assert.equal(gitMissing.ok ? undefined : gitMissing.code, 'git-missing');

    gitIn(root, ['remote', 'remove', 'origin']);
    const noRemote = await checkEnablePreconditions(root);
    assert.equal(noRemote.ok ? undefined : noRemote.code, 'no-remote');
    assert.match(noRemote.ok ? '' : noRemote.message, /origin/);
  });

  const outsideRepo = await plainDirectory('near-ai-enable-norepo-');
  const emptyRepo = await plainDirectory('near-ai-enable-nocommit-');
  try {
    const notARepo = await checkEnablePreconditions(outsideRepo);
    assert.equal(notARepo.ok ? undefined : notARepo.code, 'not-a-repo');
    gitIn(emptyRepo, ['init', '-q', '-b', 'main']);
    const noCommit = await checkEnablePreconditions(emptyRepo);
    assert.equal(noCommit.ok ? undefined : noCommit.code, 'no-commit');
  } finally {
    await fs.rm(outsideRepo, { recursive: true, force: true });
    await fs.rm(emptyRepo, { recursive: true, force: true });
  }
});

test('a failed precondition stops Enable before any key, folder or file is created', async () => {
  await withFixture(['a'], async (fixture) => {
    gitIn(fixture.clones.a as string, ['remote', 'remove', 'origin']);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.code, 'no-remote');
    assert.equal(secrets.values.size, 0);
    assert.equal(existsSync(path.join(fixture.storageDir('a'), 'team')), false);
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
  });
});

test('enableDefaults reads the folder name, git identity, remote and branches', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const defaults = await enableDefaults(root);
    assert.deepEqual(defaults, {
      teamName: 'a', ownerName: 'Team Test', ownerEmail: 'team-test@example.invalid', remote: 'origin', branch: 'main', integrationBranch: 'main'
    });
    gitIn(root, ['checkout', '-q', '-b', 'feature/work']);
    gitIn(root, ['branch', '-q', '-m', 'main', 'trunk']);
    const withoutMain = await enableDefaults(root);
    assert.equal(withoutMain.branch, 'feature/work');
    assert.equal(withoutMain.integrationBranch, 'feature/work');
    gitIn(root, ['checkout', '-q', '--detach']);
    const detached = await enableDefaults(root);
    assert.equal(detached.branch, undefined);
    assert.equal(detached.integrationBranch, 'main');
  });
});

test('Enable accepts valid git branch names that the old ASCII pattern refused and falls back to main for a name no rule allows (WR-09)', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    gitIn(root, ['branch', '-q', '-m', 'main', 'trunk']);
    gitIn(root, ['checkout', '-q', '-b', 'feature/c++#1@caf\u00E9']);
    const defaults = await enableDefaults(root);
    assert.equal(defaults.integrationBranch, 'feature/c++#1@caf\u00E9');
    const result = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), true);
  });
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    gitIn(root, ['branch', '-q', '-m', 'main', 'trunk']);
    // Git allows a zero-width character in a branch name; the shared rules do not, so the default must not fail Enable.
    gitIn(root, ['checkout', '-q', '-b', 'zero\u200Bwidth']);
    assert.equal((await enableDefaults(root)).integrationBranch, 'main');
    const result = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
  });
});

test('Enable creates the team, the device key, the orphan coordination branch and a team.json-only commit, and never pushes the code branch', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const root = fixture.clones.a as string;
    writeFileSync(path.join(root, 'staged.txt'), 'staged by the user\n', 'utf8');
    gitIn(root, ['add', 'staged.txt']);
    const mainBefore = remoteRef(fixture, 'refs/heads/main');
    const secrets = new MemorySecrets();

    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { teamFile } = result;
    assert.equal(result.remote, 'origin');
    assert.equal(result.branch, 'main');

    const onDisk = parseTeamFile(await fs.readFile(path.join(root, TEAM_FILE_REL), 'utf8'));
    assert.deepEqual(onDisk, teamFile);
    assert.equal(teamFile.coordination.ref, DEFAULT_COORDINATION_REF);
    assert.equal(teamFile.coordination.remote, 'origin');
    assert.equal(teamFile.name, 'Enable team');
    assert.deepEqual(await readTeamFile(root), teamFile);

    assert.equal(gitIn(root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);
    assert.equal(gitIn(root, ['log', '-1', '--format=%s']), ENABLE_COMMIT_MESSAGE);
    assert.equal(gitIn(root, ['rev-parse', 'HEAD']), result.commit);
    assert.equal(gitIn(root, ['diff', '--cached', '--name-only']), 'staged.txt', 'the file the user staged is still staged and was not committed');
    assert.equal(remoteRef(fixture, 'refs/heads/main'), mainBefore, 'the code branch was never pushed');

    assert.equal(gitIn(fixture.remote, ['rev-list', '--count', COORDINATION_BRANCH]), '1', 'one genesis commit');
    assert.equal(gitIn(fixture.remote, ['rev-list', '--parents', '-n', '1', COORDINATION_BRANCH]).split(' ').length, 1, 'the genesis commit has no parent');
    const files = gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', COORDINATION_BRANCH]).split('\n');
    assert.equal(files.length, 3);
    assert.equal(files.filter((name) => /^events\/\d{12}-evt-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name)).length, 2);
    assert.ok(files.includes('team.json'));

    assert.deepEqual([...secrets.values.keys()], [deviceKeySecretName(teamFile.teamId)]);
    assert.ok(existsSync(path.join(teamStorageDir(fixture.storageDir('a'), teamFile.teamId), 'trust.json')));

    const anchor = anchorOf(teamFile);
    const transport = new GitTransport<TeamState>({
      mirrorDir: path.join(fixture.storageDir('b'), 'coordination.git'), projectRoot: fixture.clones.b as string, remote: 'origin',
      ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor), baseDelayMs: 1
    });
    const report = await new TeamLog({ anchor, transport }).verifyAll();
    assert.equal(report.accepted, 2);
    assert.equal(report.rejected.length, 0);
    assert.equal(report.members.length, 1);
    assert.equal(report.members[0]?.role, 'owner');
  });
});

test('the owner email is only present as a salted hash and the plain address is nowhere in the remote or team.json', async () => {
  await withFixture(['a'], async (fixture) => {
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const history = remoteHistory(fixture);
    assert.ok(history.includes(emailHash(result.teamFile.teamId, OWNER_EMAIL)), 'the hash of the lowercased address is in the genesis body');
    assert.equal(history.toLowerCase().includes(OWNER_EMAIL.toLowerCase()), false);
    const fileText = await fs.readFile(path.join(fixture.clones.a as string, TEAM_FILE_REL), 'utf8');
    assert.equal(fileText.toLowerCase().includes('example.invalid'), false);
    assert.equal(fileText.includes('Lead Owner'), false, 'team.json holds no member details');
  });
});

test('Enable without an email still works and signs an empty hash list', async () => {
  await withFixture(['a'], async (fixture) => {
    const result = await enableTeamMode({ ...inputFor(fixture, 'a', new MemorySecrets()), ownerEmail: '' });
    assert.equal(result.ok, true);
    assert.ok(remoteHistory(fixture).includes('"ownerEmailHashes":[]'));
  });
});

test('running Enable again reports the existing team and creates nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const first = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', first));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const headBefore = remoteRef(fixture, COORDINATION_BRANCH);
    const commitBefore = gitIn(fixture.clones.a as string, ['rev-parse', 'HEAD']);
    const second = new MemorySecrets();
    const again = await enableTeamMode(inputFor(fixture, 'a', second));
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.code, 'exists-locally');
    assert.ok(again.message.includes(result.teamFile.name));
    assert.ok(again.message.includes(result.teamFile.teamId));
    assert.deepEqual(again.teamFile, result.teamFile);
    assert.equal(second.values.size, 0);
    assert.equal(remoteRef(fixture, COORDINATION_BRANCH), headBefore);
    assert.equal(gitIn(fixture.clones.a as string, ['rev-parse', 'HEAD']), commitBefore);
  });
});

test('a corrupt team.json is reported and left alone rather than replaced', async () => {
  await withFixture(['a'], async (fixture) => {
    const file = path.join(fixture.clones.a as string, TEAM_FILE_REL);
    writeFileSync(file, '{ not json', 'utf8');
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok ? undefined : result.code, 'exists-locally');
    assert.equal(await fs.readFile(file, 'utf8'), '{ not json');
    assert.equal(secrets.values.size, 0);
  });
});

test('a remote that already has a coordination log stops Enable before a device key is created', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const first = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(first.ok, true);
    const headBefore = remoteRef(fixture, COORDINATION_BRANCH);
    const secrets = new MemorySecrets();
    const second = await enableTeamMode(inputFor(fixture, 'b', secrets));
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.code, 'exists-remotely');
    assert.match(second.message, /This remote already has a coordination log/);
    assert.equal(secrets.values.size, 0);
    assert.equal(existsSync(path.join(fixture.storageDir('b'), 'team')), false);
    assert.equal(existsSync(path.join(fixture.clones.b as string, TEAM_FILE_REL)), false);
    assert.equal(remoteRef(fixture, COORDINATION_BRANCH), headBefore);
  });
});

test('an unreachable remote stops Enable with the reason and nothing is created', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    gitIn(root, ['remote', 'set-url', 'origin', path.join(fixture.root, 'does-not-exist.git')]);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok ? undefined : result.code, 'remote-unreachable');
    assert.equal(secrets.values.size, 0);
    assert.equal(existsSync(path.join(root, TEAM_FILE_REL)), false);
  });
});

test('invalid input is refused before anything is created', async () => {
  await withFixture(['a'], async (fixture) => {
    const cases: Array<[string, Partial<EnableInput>]> = [
      ['empty team name', { teamName: '   ' }],
      ['team name with a line break', { teamName: 'one\ntwo' }],
      ['empty owner name', { ownerName: '' }],
      ['email without an at sign', { ownerEmail: 'not-an-email' }],
      ['email with a space', { ownerEmail: 'a b@example.invalid' }],
      ['email over 254 characters', { ownerEmail: `${'a'.repeat(250)}@example.invalid` }],
      ['integration branch with a space', { integrationBranch: 'bad branch' }],
      ['remote that looks like an option', { remote: '--upload-pack=x' }]
    ];
    for (const [label, extra] of cases) {
      const secrets = new MemorySecrets();
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, extra));
      assert.equal(result.ok ? undefined : result.code, 'invalid-input', label);
      assert.equal(secrets.values.size, 0, label);
    }
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
  });
});

test('a failing commit hook leaves team.json unstaged on disk, explains the exact command and a re-run reports the existing team', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const hook = path.join(root, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'commit-failed');
    assert.ok(result.teamFile !== undefined);
    assert.match(result.message, /hook rejected this commit message/);
    assert.ok(result.message.includes(`git add -f ${TEAM_FILE_REL}`));
    assert.ok(result.message.includes(`git commit --only -m "${ENABLE_COMMIT_MESSAGE}" -- ${TEAM_FILE_REL}`));
    assert.ok(existsSync(path.join(root, TEAM_FILE_REL)), 'team.json stays on disk');
    assert.equal(gitIn(root, ['diff', '--cached', '--name-only']), '', 'team.json is not left staged');
    assert.equal(gitIn(root, ['log', '-1', '--format=%s']), 'seed', 'no commit was made');
    assert.equal(secrets.values.size, 1, 'the team exists on the remote, so the key is kept');
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH));

    const again = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(again.ok ? undefined : again.code, 'exists-locally');
  });
});

test('a failed genesis push removes the device key, the mirror and the team storage and writes no team.json', async () => {
  await withFixture(['a'], async (fixture) => {
    const git = faultRunner(runGit, [{ when: (args) => args.includes('push') && args.includes('--porcelain'), replace: () => fakeGitResult(1, '', 'fatal: unable to access the remote') }]);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'push-failed');
    assert.match(result.message, /unable to access the remote/);
    assert.equal(secrets.values.size, 0, 'the device key is gone');
    assert.deepEqual(await teamFolders(fixture.storageDir('a')), [], 'the team storage folder, with the mirror, is gone');
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
    assert.equal(gitIn(fixture.clones.a as string, ['log', '-1', '--format=%s']), 'seed');
  });
});

test('a genesis push whose reply was lost but that landed is detected and Enable finishes', async () => {
  await withFixture(['a'], async (fixture) => {
    const git = faultRunner(runGit, [{
      when: (args) => args.includes('push') && args.includes('--porcelain'), runReal: true, times: 1,
      replace: () => fakeGitResult(1, '', 'fatal: the remote end hung up unexpectedly')
    }]);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, true);
    assert.equal(secrets.values.size, 1);
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH));
    assert.equal(gitIn(fixture.clones.a as string, ['log', '-1', '--format=%s']), ENABLE_COMMIT_MESSAGE);
  });
});

test('a genesis push that may have landed, with the remote unreachable afterwards, keeps the device key and the mirror (WR-01)', async () => {
  await withFixture(['a'], async (fixture) => {
    const git = faultRunner(runGit, [
      { when: (args) => args.includes('push') && args.includes('--porcelain'), runReal: true, times: 1, replace: () => fakeGitResult(1, '', 'fatal: the remote end hung up unexpectedly') },
      { when: (args) => args.includes('fetch'), replace: () => fakeGitResult(128, '', 'fatal: unable to access the remote: Could not resolve host') }
    ]);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'push-unconfirmed');
    assert.match(result.message, /may have been created/);
    assert.match(result.message, /git ls-remote origin refs\/heads\/near-ai\/coordination/);
    assert.equal(secrets.values.size, 1, 'the only owner key is kept');
    assert.equal((await teamFolders(fixture.storageDir('a'))).length, 1, 'the mirror folder is kept');
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH), 'the push did land');
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
  });
});

test('a genesis push that throws before reaching the remote removes the device key and the mirror (WR-02)', async () => {
  await withFixture(['a'], async (fixture) => {
    const git: GitRunner = async (args, options) => {
      if (args.includes('push') && args.includes('--porcelain')) throw new Error('disk full while pushing');
      if (args.includes('fetch')) throw new Error('mirror unusable');
      return runGit(args, options);
    };
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'push-failed');
    assert.match(result.message, /disk full while pushing/);
    assert.equal(secrets.values.size, 0, 'the device key is gone');
    assert.deepEqual(await teamFolders(fixture.storageDir('a')), [], 'the mirror is gone');
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
  });
});

test('a genesis push that landed and then threw is recognised and Enable finishes (WR-02)', async () => {
  await withFixture(['a'], async (fixture) => {
    const git: GitRunner = async (args, options) => {
      const real = await runGit(args, options);
      if (args.includes('push') && args.includes('--porcelain')) throw new Error('connection reset after the push');
      return real;
    };
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, true);
    assert.equal(secrets.values.size, 1);
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH));
  });
});

test('pushCodeBranch pushes the current branch only when it is called', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const result = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(result.ok, true);
    const localHead = gitIn(root, ['rev-parse', 'HEAD']);
    assert.notEqual(remoteRef(fixture, 'refs/heads/main'), localHead);
    assert.deepEqual(await pushCodeBranch(root, 'origin', 'main'), { ok: true });
    assert.equal(remoteRef(fixture, 'refs/heads/main'), localHead);
  });
});

test('pushCodeBranch refuses option-like names and strips credentials from a failed push message', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    assert.equal((await pushCodeBranch(root, 'origin', '--delete')).ok, false);
    assert.equal((await pushCodeBranch(root, '--upload-pack=x', 'main')).ok, false);
    assert.equal((await pushCodeBranch(root, 'origin', 'no-such-branch')).ok, false);
    const password = `pw${randomBytes(8).toString('hex')}`;
    const git = faultRunner(runGit, [{ when: (args) => args[0] === 'push', replace: () => fakeGitResult(1, '', `fatal: unable to access 'https://someone:${password}@example.invalid/team.git/': refused`) }]);
    const failed = await pushCodeBranch(root, 'origin', 'main', git);
    assert.equal(failed.ok, false);
    const message = failed.ok ? '' : failed.message;
    assert.match(message, /Pushing main to origin failed/);
    assert.equal(message.includes(password), false);
    assert.equal(message.includes('someone'), false);
  });
});

function seedCredentials(secrets: MemorySecrets, canaries: ReturnType<typeof makeCanaries>): void {
  secrets.values.set(API_KEY_SECRET, canaries.apiKey);
  secrets.values.set(REFRESH_TOKEN_SECRET, canaries.refreshToken);
  secrets.values.set(REPORTING_TOKEN_KEY, canaries.reportingToken);
}

test('the canary scanners find a planted value in a git object, a file and every device key rendering', async () => {
  const canaries = makeCanaries();
  assert.equal(new Set(canaries.labelled().map((needle) => needle.value)).size, 6, 'every canary is different');
  const secrets = new MemorySecrets();
  await createDeviceIdentity(secrets, 'team-0123456789abcdef0123456789abcdef');
  const stored = secrets.values.get(deviceKeySecretName('team-0123456789abcdef0123456789abcdef')) as string;
  const forms = deviceKeyForms(stored);
  assert.ok(forms.length === 3 || forms.length === 4, 'stored form, seed hex and seed base64url, plus base64url when it differs');
  assert.equal(new Set(forms).size, forms.length);
  assert.equal(forms[0], stored);
  const needles: Needle[] = [...canaries.labelled(), ...forms.map((value, index) => ({ label: `device key form ${index}`, value }))];

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-canary-scan-'));
  try {
    const repo = path.join(dir, 'repo.git');
    gitIn(dir, ['init', '--bare', '-q', repo]);
    assert.deepEqual(await scanGitObjects(repo, needles), [], 'an empty repository has nothing to find');
    execFileSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: `before ${canaries.prompt} after`, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(await scanGitObjects(repo, needles), ['prompt']);
    mkdirSync(path.join(dir, 'files', 'nested'), { recursive: true });
    for (const [index, form] of forms.entries()) writeFileSync(path.join(dir, 'files', 'nested', `form-${index}.txt`), `x${form}x`, 'utf8');
    const hits = await scanFiles([path.join(dir, 'files')], needles);
    assert.deepEqual(hits.map((hit) => hit.split(': ')[1]).sort(), forms.map((_, index) => `device key form ${index}`).sort());
    assert.ok(hits.every((hit) => hit.startsWith('files/nested/form-')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('SEC-01 canary: no secret reaches any git object, team.json, extension storage or the audit store after Enable and roster events', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const canaries = makeCanaries();
    const secrets = new MemorySecrets();
    seedCredentials(secrets, canaries);

    // The remote URL carries a user name and password; an insteadOf rule maps it back to the real bare remote so git still works.
    const url = `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git`;
    gitIn(root, ['remote', 'set-url', 'origin', url]);
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, url]);
    mkdirSync(path.join(root, '.planning', '.near-ai', 'transcripts'), { recursive: true });
    writeFileSync(path.join(root, '.planning', '.near-ai', 'transcripts', 'canary.json'), JSON.stringify({ prompt: canaries.prompt }), 'utf8');

    const enabled = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(enabled.ok, true);
    if (!enabled.ok) return;
    const teamId = enabled.teamFile.teamId;
    const storageDir = teamStorageDir(fixture.storageDir('a'), teamId);
    const mirrorDir = path.join(storageDir, 'coordination.git');

    // Roster events written the way the session will write them: availability, skills and a second owner device.
    const anchor = anchorOf(enabled.teamFile);
    const transport = new GitTransport<TeamState>({
      mirrorDir, projectRoot: root, remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor), baseDelayMs: 1
    });
    const identity = await loadDeviceIdentity(secrets, teamId);
    assert.ok(identity !== undefined);
    if (identity === undefined) return;
    const probe = new TeamLog({ anchor, transport });
    const genesis = await probe.sync();
    assert.equal(genesis.accepted.length, 2);
    const owner = [...probe.state().members.values()][0];
    assert.ok(owner !== undefined);
    if (owner === undefined) return;
    const signer: TeamSigner = { identity, memberId: owner.id };
    const log = new TeamLog({ anchor, transport, signer });
    const secondSecrets = new MemorySecrets();
    const second = await createDeviceIdentity(secondSecrets, teamId);
    const accepted: TeamEvent[] = [...genesis.accepted];
    for (const intent of [
      { type: 'member.availability' as const, body: { availability: 'available' as const } },
      { type: 'member.skills' as const, body: { memberId: owner.id, skills: ['typescript', 'testing'] } },
      { type: 'device.added' as const, body: { memberId: owner.id, device: { fingerprint: second.fingerprint, publicKey: second.publicKey } } }
    ]) {
      const written = await log.append(() => [intent]);
      assert.equal(written.ok, true);
      if (written.ok) accepted.push(...written.events);
    }
    assert.equal(accepted.length, 5);

    const store = new AuditStore(root);
    assert.equal(await mirrorRosterEvents(store, fileMirrorMark(storageDir), accepted, (id) => log.state().members.get(id)?.role), 5);
    const auditFile = path.join(root, '.planning', '.near-ai', 'audit.json');
    assert.ok(existsSync(auditFile));

    const needles: Needle[] = [
      ...canaries.labelled(),
      { label: 'remote user', value: 'canaryuser' },
      ...deviceKeyForms(secrets.values.get(deviceKeySecretName(teamId)) as string).map((value, index) => ({ label: `device key form ${index}`, value })),
      ...deviceKeyForms(secondSecrets.values.get(deviceKeySecretName(teamId)) as string).map((value, index) => ({ label: `second device key form ${index}`, value }))
    ];

    // Controls: the same scanners do see the canaries where they are meant to be, so an empty result below means something.
    assert.deepEqual((await scanFiles([path.join(root, '.planning', '.near-ai', 'transcripts')], needles)).map((hit) => hit.split(': ')[1]), ['prompt']);
    const cloneControl = await scanGitObjects(path.join(root, '.git'), needles);
    assert.ok(cloneControl.includes('remote password') && cloneControl.includes('remote user'), 'the clone config holds the canary URL by construction');

    assert.deepEqual(await scanGitObjects(mirrorDir, needles), [], 'coordination mirror objects and config');
    assert.deepEqual(await scanGitObjects(fixture.remote, needles), [], 'bare remote objects and config');
    assert.deepEqual(await scanGitObjects(path.join(root, '.git'), needles, { includeConfig: false }), [], 'project repository objects');
    assert.deepEqual(await scanFiles([path.join(root, '.planning', '.near-ai', 'team.json'), storageDir, auditFile], needles), [], 'team.json, team storage and audit');
    assert.deepEqual(await scanFiles([fixture.storageDir('a')], needles), [], 'all extension storage');

    assert.equal(gitIn(root, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('transcripts'), false, 'the transcripts file is not in the project commit');
    assert.equal((await store.list({ type: 'team-roster' })).length, 5);
    assert.deepEqual([...secrets.values.keys()].filter((key) => key.startsWith(DEVICE_KEY_SECRET_PREFIX)), [deviceKeySecretName(teamId)], 'the device key lives only in secret storage');
  });
});

test('a secret typed into the team name is refused and nothing is written anywhere', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const canaries = makeCanaries();
    const secrets = new MemorySecrets();
    seedCredentials(secrets, canaries);
    const before = [...secrets.values.keys()].sort();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { teamName: canaries.apiKey }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'secret');
    assert.equal(result.message.includes(canaries.apiKey), false, 'the refusal does not repeat the value');
    assert.equal(existsSync(path.join(root, TEAM_FILE_REL)), false);
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
    assert.deepEqual([...secrets.values.keys()].sort(), before, 'no device key was created');
    assert.equal([...secrets.values.keys()].some((key) => key.startsWith(DEVICE_KEY_SECRET_PREFIX)), false);
    assert.deepEqual(await teamFolders(fixture.storageDir('a')), []);
    assert.equal(gitIn(root, ['log', '-1', '--format=%s']), 'seed');
  });
});

test('a secret typed into the owner name or email is refused as well', async () => {
  await withFixture(['a'], async (fixture) => {
    const canaries = makeCanaries();
    for (const extra of [{ ownerName: canaries.refreshToken }, { ownerEmail: `${canaries.reportingToken}@example.invalid` }] as Array<Partial<EnableInput>>) {
      const secrets = new MemorySecrets();
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, extra));
      assert.equal(result.ok ? undefined : result.code, 'secret');
      assert.equal(secrets.values.size, 0);
    }
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
  });
});
