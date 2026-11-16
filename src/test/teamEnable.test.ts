// Enable Team Mode on real git: preconditions, defaults, the team.json-only commit, the existing-team cases, rollback and the Push helper.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
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
import { ENABLE_COMMIT_MESSAGE, ENABLE_PREVIEW_OFF_MESSAGE, checkEnablePreconditions, enableDefaults, enableTeamMode, pushCodeBranch } from '../team/enable';
import type { EnableInput } from '../team/enable';
import { TeamLog } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { DEVICE_KEY_SECRET, createDeviceIdentity, identityDir, loadDeviceIdentity, loadOrCreateDeviceIdentity } from '../team/identity';
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, readKeyHistory } from '../team/keyHistory';
import { GitNotFoundError, runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { TEAM_FILE_REL, parseTeamFile, projectTrustDir, readTeamFile, teamStorageDir } from '../team/teamFile';
import { deviceKeyForms, identityKeyNeedles, keyHistoryHeadNeedles, makeCanaries, scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, fakeGitResult, faultRunner, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

const OWNER_EMAIL = 'Lead.Owner@Example.invalid';
const COORDINATION_BRANCH = 'refs/heads/near-ai/coordination';
// src/services/spendTracking.ts holds this constant but imports vscode, which a node test cannot load, so the key is repeated here.
const REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken';

// The secret names held, without the saved end of the key history (which stays after a key is forgotten, since the history is kept).
function storedKeys(secrets: MemorySecrets): string[] {
  return [...secrets.values.keys()].filter((key) => key !== KEY_HISTORY_HEAD_SECRET);
}

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
    teamName: 'Enable team', ownerName: 'Lead Owner', previewEnabled: true, ...extra
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
    assert.deepEqual(ready, { ok: true, projectRoot: root, remote: 'origin', branch: 'main' });

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

test('the core refuses to enable unless the caller says the preview is on, and then creates and asks nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    for (const previewEnabled of [undefined, false] as const) {
      const secrets = new MemorySecrets();
      const calls: string[][] = [];
      const git: GitRunner = async (args, options) => { calls.push([...args]); return runGit(args, options); };
      const { previewEnabled: _on, ...withoutFlag } = inputFor(fixture, 'a', secrets, { git });
      const result = await enableTeamMode(previewEnabled === undefined ? withoutFlag : { ...withoutFlag, previewEnabled });
      assert.equal(result.ok, false, `preview flag ${String(previewEnabled)}`);
      assert.equal(result.ok ? undefined : result.code, 'preview-off');
      assert.equal(result.ok ? undefined : result.message, ENABLE_PREVIEW_OFF_MESSAGE);
      assert.deepEqual(calls, [], 'not even a read-only git call ran, so nothing was asked of the project or the remote');
      assert.equal(secrets.values.size, 0, 'no device key was created');
      assert.equal(existsSync(path.join(fixture.storageDir('a'), 'team')), false, 'no team folder or trust pin was written');
      assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false, 'no team.json was written');
      assert.equal(gitIn(fixture.clones.a as string, ['status', '--porcelain']), '');
      assert.equal(gitIn(fixture.remote, ['for-each-ref', DEFAULT_COORDINATION_REF]), '', 'nothing reached the remote');
    }
    const secrets = new MemorySecrets();
    assert.equal((await enableTeamMode(inputFor(fixture, 'a', secrets))).ok, true, 'with the flag, Enable runs as before');
  });
});

test('enableDefaults reads the folder name, git user name (never the email), remote and branches', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    const defaults = await enableDefaults(root);
    assert.deepEqual(defaults, { teamName: 'a', ownerName: 'Team Test', remote: 'origin', branch: 'main', integrationBranch: 'main' });
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

    assert.deepEqual(storedKeys(secrets), [DEVICE_KEY_SECRET]);
    assert.ok(existsSync(path.join(projectTrustDir(fixture.storageDir('a'), fixture.clones.a as string), 'trust.json')), 'Enable pins the team for this project');
    assert.equal(existsSync(path.join(teamStorageDir(fixture.storageDir('a'), teamFile.teamId), 'trust.json')), false);

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

// Every text an outsider could compute from a guessed address and what the repository makes public (the team id, the team name, the
// genesis event id and the owner's fingerprint): the plain and normalised address, and SHA-256 and SHA-512 of it alone, salted with each
// public value before or after (with and without a colon), as hex, base64 and base64url.
function guessableEmailForms(email: string, publicValues: string[]): string[] {
  const addresses = [...new Set([email, email.trim().toLowerCase()])];
  const inputs = addresses.flatMap((address) => [address, ...publicValues.flatMap((salt) => [`${salt}:${address}`, `${salt}${address}`, `${address}:${salt}`, `${address}${salt}`])]);
  const forms = new Set<string>(addresses);
  for (const input of inputs) {
    for (const algorithm of ['sha256', 'sha512']) {
      const digest = createHash(algorithm).update(input, 'utf8').digest();
      forms.add(digest.toString('hex'));
      forms.add(digest.toString('base64'));
      forms.add(digest.toString('base64url'));
    }
  }
  return [...forms];
}

test('no email address and no value derived from one reaches the remote or team.json: a guessed address hashed with public data matches nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const root = fixture.clones.a as string;
    gitIn(root, ['config', 'user.email', OWNER_EMAIL]);
    const defaults = await enableDefaults(root);
    assert.equal(JSON.stringify(defaults).includes('@'), false, 'the defaults do not read the git email');
    const result = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const history = remoteHistory(fixture);
    const fileText = await fs.readFile(path.join(root, TEAM_FILE_REL), 'utf8');
    assert.ok(history.includes('"ownerEmailHashes":[]') && history.includes('"emailHashes":[]'), 'both genesis bodies carry empty lists');
    assert.equal(fileText.includes('Lead Owner'), false, 'team.json holds no member details');

    const { teamFile } = result;
    const publicValues = [teamFile.teamId, teamFile.name, teamFile.genesis.eventId, teamFile.genesis.ownerDevice.fingerprint, teamFile.genesis.ownerDevice.publicKey];
    const guesses = guessableEmailForms(OWNER_EMAIL, publicValues);
    // Control: the guess list holds what the earlier format stored (SHA-256 hex of "<team id>:<lowercased address>"), so an empty result means something.
    assert.ok(guesses.includes(createHash('sha256').update(`${teamFile.teamId}:${OWNER_EMAIL.toLowerCase()}`).digest('hex')));
    const haystacks = [history, fileText, history.toLowerCase(), fileText.toLowerCase()];
    assert.deepEqual(guesses.filter((guess) => haystacks.some((text) => text.includes(guess) || text.includes(guess.toLowerCase()))), [], 'no guessable form of the address');
    assert.doesNotMatch(history, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'no address-shaped text in the coordination log');
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
    assert.equal(storedKeys(secrets).length, 1, 'the team exists on the remote, so the key is kept');
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH));

    const again = await enableTeamMode(inputFor(fixture, 'a', new MemorySecrets()));
    assert.equal(again.ok ? undefined : again.code, 'exists-locally');
  });
});

test('a failed genesis push with no earlier identity removes the key it created, the mirror and the team storage and writes no team.json', async () => {
  await withFixture(['a'], async (fixture) => {
    const git = faultRunner(runGit, [{ when: (args) => args.includes('push') && args.includes('--porcelain'), replace: () => fakeGitResult(1, '', 'fatal: unable to access the remote') }]);
    const secrets = new MemorySecrets();
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'push-failed');
    assert.match(result.message, /unable to access the remote/);
    assert.deepEqual(storedKeys(secrets), [], 'the key this call created is forgotten');
    assert.deepEqual(await teamFolders(fixture.storageDir('a')), [], 'the team storage folder, with the mirror, is gone');
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
    assert.equal(gitIn(fixture.clones.a as string, ['log', '-1', '--format=%s']), 'seed');
  });
});

// Plants the coordination branch on the bare remote right before the first push, so the push finds it already there (the 'exists' outcome).
function plantCoordinationBranch(fixture: TeamFixture): GitRunner {
  let planted = false;
  return async (args, options) => {
    if (!planted && args.includes('push') && args.includes('--porcelain')) {
      planted = true;
      const tree = execFileSync('git', ['--git-dir', fixture.remote, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim();
      const commit = execFileSync('git', ['--git-dir', fixture.remote, '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit-tree', tree, '-m', 'someone else got there first'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['--git-dir', fixture.remote, 'update-ref', COORDINATION_BRANCH, commit]);
    }
    return runGit(args, options);
  };
}

const FAILURE_PATHS: Array<{ name: string; code: string; git: (fixture: TeamFixture) => GitRunner }> = [
  {
    name: 'a failed genesis push', code: 'push-failed',
    git: () => faultRunner(runGit, [{ when: (args) => args.includes('push') && args.includes('--porcelain'), replace: () => fakeGitResult(1, '', 'fatal: unable to access the remote') }])
  },
  {
    name: 'a push that throws before reaching the remote', code: 'push-failed',
    git: () => async (args, options) => {
      if (args.includes('push') && args.includes('--porcelain')) throw new Error('disk full while pushing');
      if (args.includes('fetch')) throw new Error('mirror unusable');
      return runGit(args, options);
    }
  },
  { name: 'a coordination branch that appears on the remote during the push', code: 'exists-remotely', git: (fixture) => plantCoordinationBranch(fixture) }
];

for (const failure of FAILURE_PATHS) {
  test(`an identity that existed before a failed Enable is untouched: ${failure.name}`, async () => {
    await withFixture(['a'], async (fixture) => {
      const secrets = new MemorySecrets();
      const before = await createDeviceIdentity(secrets);
      const storedBefore = secrets.values.get(DEVICE_KEY_SECRET);
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git: failure.git(fixture) }));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, failure.code);
      assert.equal(secrets.values.get(DEVICE_KEY_SECRET), storedBefore, 'the stored key is byte for byte the same');
      assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, before.fingerprint);
      assert.deepEqual(await teamFolders(fixture.storageDir('a')), [], 'the team storage folder, with the mirror, is still removed');
      assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
    });
  });

  test(`a failed Enable forgets the key it created and no other, and the history ends with created then revoked: ${failure.name}`, async () => {
    await withFixture(['a'], async (fixture) => {
      const secrets = new MemorySecrets();
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git: failure.git(fixture) }));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, failure.code);
      assert.deepEqual(storedKeys(secrets), [], 'the key this call created is forgotten');
      assert.deepEqual(await teamFolders(fixture.storageDir('a')), []);

      const folder = identityDir(fixture.storageDir('a'));
      const file = JSON.parse(await fs.readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8')) as { records: Array<{ payload: { kind: string; key: { fingerprint: string } }; signer: { fingerprint: string } }> };
      assert.deepEqual(file.records.map((record) => record.payload.kind), ['created', 'revoked']);
      const [created, revoked] = file.records;
      assert.equal(created?.payload.key.fingerprint, revoked?.payload.key.fingerprint, 'both records are about the key this call made');
      assert.equal(revoked?.signer.fingerprint, created?.payload.key.fingerprint, 'the key signed its own withdrawal');
      const replay = await readKeyHistory(folder, secrets);
      assert.equal(replay.ok, true, 'the chain stays valid');
      assert.equal(replay.ok && replay.active, undefined);
      assert.deepEqual((await fs.readdir(folder)).filter((name) => name.startsWith('key-history.archived-')), [], 'nothing was archived or deleted');
    });
  });

  test(`a failed Enable on a computer with an identity before it leaves the key and its history unchanged: ${failure.name}`, async () => {
    await withFixture(['a'], async (fixture) => {
      const secrets = new MemorySecrets();
      const folder = identityDir(fixture.storageDir('a'));
      const before = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
      const historyBefore = await fs.readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8');
      const storedBefore = secrets.values.get(DEVICE_KEY_SECRET);
      const headBefore = secrets.values.get(KEY_HISTORY_HEAD_SECRET);
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, { git: failure.git(fixture) }));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, failure.code);
      assert.equal(secrets.values.get(DEVICE_KEY_SECRET), storedBefore);
      assert.equal(secrets.values.get(KEY_HISTORY_HEAD_SECRET), headBefore);
      assert.equal(await fs.readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8'), historyBefore, 'the history file is byte for byte the same');
      assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, before.identity.fingerprint);
    });
  });
}

test('an Enable after a failed one that forgot its key makes a new key whose created record follows the revoked one', async () => {
  await withFixture(['a'], async (fixture) => {
    const secrets = new MemorySecrets();
    const failed = await enableTeamMode(inputFor(fixture, 'a', secrets, { git: (FAILURE_PATHS[0] as { git: (fixture: TeamFixture) => GitRunner }).git(fixture) }));
    assert.equal(failed.ok, false);
    const folder = identityDir(fixture.storageDir('a'));
    const first = await readKeyHistory(folder, secrets);
    assert.equal(first.ok && first.head?.seq, 2);

    const second = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const file = JSON.parse(await fs.readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8')) as { records: Array<{ payload: { kind: string; key: { fingerprint: string } } }> };
    assert.deepEqual(file.records.map((record) => record.payload.kind), ['created', 'revoked', 'created']);
    const newKey = file.records[2]?.payload.key.fingerprint;
    assert.notEqual(newKey, file.records[0]?.payload.key.fingerprint, 'a new key, not the withdrawn one');
    assert.equal(newKey, second.teamFile.genesis.ownerDevice.fingerprint, 'the new key is the owner device');
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.active?.fingerprint, newKey);
    assert.equal(replay.ok && replay.head?.seq, 3);
  });
});

test('a successful Enable on a computer that already has an identity reuses it and creates no second key', async () => {
  await withFixture(['a'], async (fixture) => {
    const secrets = new MemorySecrets();
    const before = await createDeviceIdentity(secrets);
    const result = await enableTeamMode(inputFor(fixture, 'a', secrets));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(storedKeys(secrets), [DEVICE_KEY_SECRET]);
    assert.equal(result.teamFile.genesis.ownerDevice.fingerprint, before.fingerprint, 'the owner device is the identity that was already there');
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
    assert.equal(storedKeys(secrets).length, 1);
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
    assert.equal(storedKeys(secrets).length, 1, 'the only owner key is kept');
    assert.equal((await teamFolders(fixture.storageDir('a'))).length, 1, 'the mirror folder is kept');
    assert.ok(remoteHasRef(fixture, COORDINATION_BRANCH), 'the push did land');
    assert.equal(existsSync(path.join(fixture.clones.a as string, TEAM_FILE_REL)), false);
  });
});

test('a genesis push that throws before reaching the remote, with no earlier identity, removes the key it created and the mirror (WR-02)', async () => {
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
    assert.deepEqual(storedKeys(secrets), [], 'the key this call created is forgotten');
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
    assert.equal(storedKeys(secrets).length, 1);
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
    assert.equal((await pushCodeBranch(root, 'origin', 'main:refs/heads/other')).ok, false, 'a refspec is not a branch name');
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
  assert.equal(new Set(canaries.labelled().map((needle) => needle.value)).size, 5, 'every canary is different');
  const secrets = new MemorySecrets();
  await createDeviceIdentity(secrets);
  const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
  const forms = deviceKeyForms(stored);
  // As stored, DER hex, seed hex, seed base64url, padded seed base64 and SPKI hex, plus DER base64url and unpadded seed base64 when they
  // differ from the stored form and the seed base64url (they do whenever a + or / appears).
  assert.ok(forms.length >= 6 && forms.length <= 8, `six to eight renderings, got ${forms.length}`);
  const der = Buffer.from(stored, 'base64');
  const seed = der.subarray(der.length - 32);
  for (const [label, expected] of [
    ['DER hex', der.toString('hex')], ['seed hex', seed.toString('hex')], ['seed base64url', seed.toString('base64url')],
    ['padded seed base64', seed.toString('base64')], ['unpadded seed base64', seed.toString('base64').replace(/=+$/, '')],
    ['SPKI hex', createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).toString('hex')]
  ] as const) assert.ok(forms.includes(expected), `${label} is one of the renderings`);
  assert.ok(seed.toString('base64').endsWith('='), 'a 32 byte seed in base64 is padded');
  assert.equal(new Set(forms).size, forms.length);
  assert.equal(forms[0], stored);
  const headText = JSON.stringify({ seq: 1, hash: randomBytes(32).toString('hex') });
  assert.deepEqual(keyHistoryHeadNeedles(undefined), []);
  assert.deepEqual(keyHistoryHeadNeedles(''), []);
  assert.deepEqual(keyHistoryHeadNeedles(headText), [{ label: 'key history head', value: headText }]);
  const needles: Needle[] = [...canaries.labelled(), ...forms.map((value, index) => ({ label: `device key form ${index}`, value })), ...keyHistoryHeadNeedles(headText)];

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
    // A padded rendering contains its unpadded twin, so each file is expected to show every rendering its text contains, and no other.
    const expected = forms.flatMap((form) => forms.flatMap((other, index) => (`x${form}x`.includes(other) ? [`device key form ${index}`] : [])));
    assert.deepEqual(hits.map((hit) => hit.split(': ')[1]).sort(), expected.sort());
    for (const index of forms.keys()) assert.ok(hits.some((hit) => hit === `files/nested/form-${index}.txt: device key form ${index}`), `form ${index} is found in its own file`);
    assert.ok(hits.every((hit) => hit.startsWith('files/nested/form-')));
    writeFileSync(path.join(dir, 'files', 'head.txt'), `copied ${headText} here`, 'utf8');
    assert.ok((await scanFiles([path.join(dir, 'files', 'head.txt')], needles)).some((hit) => hit.endsWith(': key history head')), 'a copy of the saved end is found');
    execFileSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: headText, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.ok((await scanGitObjects(repo, needles)).includes('key history head'));
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
    const identity = await loadDeviceIdentity(secrets);
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
    const second = await createDeviceIdentity(secondSecrets);
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
      ...identityKeyNeedles(secrets.values, 'owner'),
      ...deviceKeyForms(secondSecrets.values.get(DEVICE_KEY_SECRET) as string).map((value, index) => ({ label: `second device key form ${index}`, value })),
      ...keyHistoryHeadNeedles(secrets.values.get(KEY_HISTORY_HEAD_SECRET))
    ];
    assert.equal(needles.filter((needle) => needle.label === 'key history head').length, 1, 'Enable saved the end of the key history, so the scan below looks for it');
    const historyFile = path.join(identityDir(fixture.storageDir('a')), KEY_HISTORY_FILE);
    assert.ok(existsSync(historyFile), 'the key history file is inside the extension storage the scan covers');
    assert.deepEqual(await scanFiles([historyFile], needles), [], 'the key history file holds no private key rendering and not the saved end');

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
    assert.deepEqual([...secrets.values.keys()].filter((key) => key === DEVICE_KEY_SECRET), [DEVICE_KEY_SECRET], 'the device key lives only in secret storage');
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
    assert.equal([...secrets.values.keys()].some((key) => key === DEVICE_KEY_SECRET), false);
    assert.deepEqual(await teamFolders(fixture.storageDir('a')), []);
    assert.equal(gitIn(root, ['log', '-1', '--format=%s']), 'seed');
  });
});

test('a secret typed into the owner name is refused as well', async () => {
  await withFixture(['a'], async (fixture) => {
    const canaries = makeCanaries();
    for (const extra of [{ ownerName: canaries.refreshToken }] as Array<Partial<EnableInput>>) {
      const secrets = new MemorySecrets();
      const result = await enableTeamMode(inputFor(fixture, 'a', secrets, extra));
      assert.equal(result.ok ? undefined : result.code, 'secret');
      assert.equal(secrets.values.size, 0);
    }
    assert.equal(remoteHasRef(fixture, COORDINATION_BRANCH), false);
  });
});

// ---- GIT_SSH_COMMAND: only an inherited value passes, never the project's own config ----

const DEFAULT_SSH = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
const NETWORK_VERBS = new Set(['ls-remote', 'push', 'fetch']);

type RecordedCall = { args: string[]; env: Record<string, string> | undefined };

function recordingRunner(calls: RecordedCall[]): GitRunner {
  return async (args, options) => {
    calls.push({ args: [...args], env: options?.env === undefined ? undefined : { ...options.env } });
    return runGit(args, options);
  };
}

const networkCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter((call) => call.args.some((arg) => NETWORK_VERBS.has(arg)));

async function withSshEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env.GIT_SSH_COMMAND;
  if (value === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved;
  }
}

test('a core.sshCommand from the project config is never copied into GIT_SSH_COMMAND by Enable, Push or the transport', async () => {
  await withSshEnv(undefined, async () => {
    await withFixture(['a', 'b'], async (fixture) => {
      // Without any configured ssh command, the calls in the project get the non-interactive default (clone b, before a moves main on).
      const other = fixture.clones.b as string;
      const plain: RecordedCall[] = [];
      assert.equal((await pushCodeBranch(other, 'origin', 'main', recordingRunner(plain))).ok, true);
      assert.deepEqual(networkCalls(plain).map((call) => call.env?.GIT_SSH_COMMAND), [DEFAULT_SSH]);

      const projectSsh = 'ssh -o ProjectConfigured=yes';
      const root = fixture.clones.a as string;
      gitIn(root, ['config', 'core.sshCommand', projectSsh]);
      const calls: RecordedCall[] = [];
      const result = await enableTeamMode({ ...inputFor(fixture, 'a', new MemorySecrets()), git: recordingRunner(calls) });
      assert.equal(result.ok, true);
      const pushed = await pushCodeBranch(root, 'origin', 'main', recordingRunner(calls));
      assert.equal(pushed.ok, true);
      const transport = new GitTransport<TeamState>({
        mirrorDir: path.join(fixture.storageDir('a'), 'check.git'), projectRoot: root, remote: 'origin', ref: DEFAULT_COORDINATION_REF,
        materializer: teamMaterializer(anchorOf((result as { teamFile: TeamFile }).teamFile)), baseDelayMs: 1, git: recordingRunner(calls)
      });
      await transport.fetch();

      const network = networkCalls(calls);
      assert.ok(network.length >= 3, `network calls were recorded (${network.length})`);
      assert.deepEqual(calls.filter((call) => JSON.stringify(call.env ?? {}).includes('ProjectConfigured')), [], 'the project value is in no environment');
      for (const call of network) {
        const value = call.env?.GIT_SSH_COMMAND;
        // Calls in the project leave the ssh command to git (which reads the project config itself); the mirror, which does not read it, gets the default.
        if (call.args.includes('--git-dir')) assert.equal(value, DEFAULT_SSH, call.args.join(' '));
        else assert.equal(value, undefined, call.args.join(' '));
      }
    });
  });
});

test('an inherited GIT_SSH_COMMAND is left to the environment: no call sets its own', async () => {
  await withSshEnv('ssh -o Inherited=yes', async () => {
    await withFixture(['a'], async (fixture) => {
      gitIn(fixture.clones.a as string, ['config', 'core.sshCommand', 'ssh -o ProjectConfigured=yes']);
      const calls: RecordedCall[] = [];
      const result = await enableTeamMode({ ...inputFor(fixture, 'a', new MemorySecrets()), git: recordingRunner(calls) });
      assert.equal(result.ok, true);
      const network = networkCalls(calls);
      assert.ok(network.length >= 2);
      assert.deepEqual(network.filter((call) => call.env?.GIT_SSH_COMMAND !== undefined).map((call) => call.args.join(' ')), []);
    });
  });
});

// ---- The remote address is checked as git resolves it (0.4.25) ----

// A `url.<base>.insteadOf` rule in the project's config can turn an allowed address into a remote helper (ext:: runs a command). Enable and the Push
// button resolve the address with `git remote get-url`, which applies those rules, and refuse it before any ls-remote or push.
for (const rule of ['insteadOf', 'pushInsteadOf']) {
  test(`Enable and Push refuse a remote that the ${rule} rule maps to ext::, before any network call`, async () => {
    await withFixture(['a'], async (fixture) => {
      const root = fixture.clones.a as string;
      gitIn(root, ['remote', 'set-url', 'origin', 'https://example.invalid/team.git']);
      gitIn(root, ['config', `url.ext::echo near-ai-rewrite-marker .${rule}`, 'https://example.invalid/']);
      const secrets = new MemorySecrets();
      const calls: RecordedCall[] = [];
      const checked = await checkEnablePreconditions(root, 'origin', recordingRunner(calls));
      assert.equal(checked.ok ? undefined : checked.code, 'remote-refused');
      assert.match(checked.ok ? '' : checked.message, /is not one Team Mode will contact/);
      assert.doesNotMatch(checked.ok ? '' : checked.message, /near-ai-rewrite-marker/, 'the refusal does not repeat the address');
      const result = await enableTeamMode({ ...inputFor(fixture, 'a', secrets), git: recordingRunner(calls) });
      assert.equal(result.ok ? undefined : result.code, 'remote-refused');
      const pushed = await pushCodeBranch(root, 'origin', 'main', recordingRunner(calls));
      assert.equal(pushed.ok, false);
      assert.match(pushed.ok ? '' : pushed.message, /is not one Team Mode will contact/);
      assert.deepEqual(networkCalls(calls).map((call) => call.args.join(' ')), [], 'no ls-remote or push ran');
      assert.equal(secrets.values.size, 0, 'no key was made');
      assert.equal(existsSync(path.join(root, TEAM_FILE_REL)), false);
    });
  });
}

// ---- Preconditions are checked once when the caller passes its result ----

test('Enable reuses a passed precondition result for the same project and remote, and checks again for any other', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const root = fixture.clones.a as string;
    const checked = await checkEnablePreconditions(root);
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    const calls: RecordedCall[] = [];
    const result = await enableTeamMode({ ...inputFor(fixture, 'a', new MemorySecrets()), checked, git: recordingRunner(calls) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.branch, 'main', 'the passed branch is used');
    const preconditionCalls = (list: RecordedCall[]): number => list.filter((call) => call.args[0] === 'rev-parse' && call.args[1] === '--is-inside-work-tree').length;
    assert.equal(preconditionCalls(calls), 0, 'git preconditions did not run again');

    // A result for another project is not trusted: the preconditions run for this one.
    const again: RecordedCall[] = [];
    const other = await enableTeamMode({ ...inputFor(fixture, 'b', new MemorySecrets()), checked, git: recordingRunner(again) });
    assert.equal(other.ok, false, 'the remote already has a coordination log');
    assert.equal(preconditionCalls(again), 1);
  });
});
