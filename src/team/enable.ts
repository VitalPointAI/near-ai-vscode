// Enable Team Mode (D-20) as a VS Code-free flow, so it runs end to end on real git under node --test. The command adapter only collects
// input, shows progress and messages, and calls enableTeamMode. Nothing here pushes the user's code branch: pushCodeBranch exists for the
// Push button and is never called by enableTeamMode. Secrets arrive through SecretStorageLike; the device key never leaves it.
// This module never imports vscode.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultTeamPolicy, isGitRefName, validatePolicy } from '../domain/team/policy';
import { SecretLeakError, assertNoSecrets } from '../domain/team/secrets';
import type { TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { validateName } from '../domain/team/validate';
import type { SecretStorageLike } from '../services/auth';
import { teamMaterializer } from '../domain/team/materialize';
import { buildGenesisEvents } from './eventLog';
import { cleanLsRemote, cleanPush, resolveCheckedRemote } from './cleanRemote';
import { DEFAULT_COORDINATION_REF, GitTransport } from './gitTransport';
import { forgetCreatedDeviceIdentity, identityDir, loadOrCreateDeviceIdentity, newMemberId, newTeamId } from './identity';
import { GitNotFoundError, gitText, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { REMOTE_NAME_PATTERN, TEAM_FILE_REL, TeamFileError, canonicalTeamFile, pinTrust, projectTrustDir, readTeamFile, teamStorageDir, writeTeamFile } from './teamFile';

export const ENABLE_COMMIT_MESSAGE = 'chore(team): enable NEAR AI Team Mode';

export type EnableFailureCode =
  | 'git-missing' | 'not-initialised' | 'not-a-repo' | 'no-commit' | 'no-remote' | 'remote-unreachable' | 'remote-refused' | 'exists-locally' | 'exists-remotely'
  | 'invalid-input' | 'preview-off' | 'secret' | 'push-failed' | 'push-unconfirmed' | 'commit-failed';

// The same words the command shows when the setting is off, kept here so the core refuses in its own voice.
export const ENABLE_PREVIEW_OFF_MESSAGE = 'Team Mode is an early preview and is off. Turn on the setting nearAi.team.preview in Settings, then run "NEAR AI: Enable Team Mode" again.';

export interface EnableInput {
  // The preview gate holds in the core, not only in the command: Enable refuses unless the caller says the preview setting is on. The VS Code
  // command passes true after reading the setting. Anything else, including a missing value, means off.
  previewEnabled?: boolean;
  projectRoot: string;
  globalStorageDir: string;
  secrets: SecretStorageLike;
  teamName: string;
  ownerName: string;
  remote?: string;
  integrationBranch?: string;
  // A passed checkEnablePreconditions result for the same project and remote, so a caller that already checked does not run git twice.
  checked?: EnablePreconditionsOk;
  git?: GitRunner;
  now?: () => Date;
  // Where a plain warning from the key history goes (the Team Mode output channel). Never given key material.
  warn?: (message: string) => void;
}

export type EnableResult =
  | { ok: true; teamFile: TeamFile; branch?: string; commit: string; remote: string }
  | { ok: false; code: EnableFailureCode; message: string; teamFile?: TeamFile };

export interface EnableDefaults {
  teamName: string;
  ownerName: string;
  remote: string;
  branch?: string;
  integrationBranch: string;
}

export interface EnablePreconditionsOk { ok: true; projectRoot: string; remote: string; branch?: string }
type Preconditions = EnablePreconditionsOk | { ok: false; code: EnableFailureCode; message: string };

const DEFAULT_REMOTE = 'origin';
const LOCAL_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 120_000;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;

function fail(code: EnableFailureCode, message: string): { ok: false; code: EnableFailureCode; message: string } {
  return { ok: false, code, message };
}

function describeError(error: unknown): string {
  return redactGitMessage(error instanceof Error ? error.message : String(error));
}

function gitFailureText(result: GitResult): string {
  return redactGitMessage([result.stderr.trim(), gitText(result)].filter((part) => part !== '').join('\n') || `git exited with code ${result.code}`);
}

// Fixed text for the user: the only variable part is the redacted git output.
function manualCommitCommand(): string {
  return `git add -f ${TEAM_FILE_REL} && git commit --only -m "${ENABLE_COMMIT_MESSAGE}" -- ${TEAM_FILE_REL}`;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function checkEnablePreconditions(projectRoot: string, remote: string = DEFAULT_REMOTE, git: GitRunner = runGit): Promise<Preconditions> {
  const run = (args: string[]): Promise<GitResult> => git(args, { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  try {
    const version = await run(['--version']);
    if (version.code !== 0) return fail('git-missing', 'Git did not start, so Team Mode cannot be enabled. Install git or fix your PATH and try again.');
  } catch (error) {
    if (error instanceof GitNotFoundError) return fail('git-missing', 'Git was not found on this computer, so Team Mode cannot be enabled. Install git and try again.');
    throw error;
  }
  if (!(await isDirectory(path.join(projectRoot, '.planning', '.near-ai')))) {
    return fail('not-initialised', 'This project is not set up for NEAR AI yet. Run "NEAR AI: Set Up" first, then enable Team Mode.');
  }
  const inside = await run(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || gitText(inside) !== 'true') {
    return fail('not-a-repo', 'This folder is not a git repository. Team Mode shares its coordination branch through git, so run git init and add a remote first.');
  }
  const head = await run(['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.code !== 0) return fail('no-commit', 'This repository has no commits yet. Make a first commit, then enable Team Mode.');
  // The URL can carry credentials, so the value is discarded here; resolveCheckedRemote checks the resolved addresses without repeating them.
  const url = await run(['remote', 'get-url', remote]);
  if (url.code === 2) return fail('no-remote', `This repository has no remote named "${remote}". Add one with git remote add ${remote} <url>, then enable Team Mode.`);
  if (url.code !== 0) return fail('remote-unreachable', `Git could not read the remote "${remote}": ${gitFailureText(url)}`);
  // 0.4.25: every address is checked as git resolves it; the network calls below then use only those checked addresses (see cleanRemote.ts).
  const resolved = await resolveCheckedRemote(projectRoot, remote, git);
  if (!resolved.ok) return fail('remote-refused', resolved.reason);
  const branch = await run(['symbolic-ref', '--short', '-q', 'HEAD']);
  const name = branch.code === 0 ? gitText(branch) : '';
  return name === '' ? { ok: true, projectRoot, remote } : { ok: true, projectRoot, remote, branch: name };
}

async function gitConfigValue(projectRoot: string, key: string, git: GitRunner): Promise<string> {
  const result = await git(['config', '--get', key], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  return result.code === 0 ? gitText(result) : '';
}

export async function enableDefaults(projectRoot: string, git: GitRunner = runGit): Promise<EnableDefaults> {
  const ownerName = await gitConfigValue(projectRoot, 'user.name', git);
  const branchResult = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const branch = branchResult.code === 0 ? gitText(branchResult) : '';
  const main = await git(['show-ref', '--verify', '-q', 'refs/heads/main'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const defaults: EnableDefaults = {
    teamName: path.basename(path.resolve(projectRoot)), ownerName, remote: DEFAULT_REMOTE,
    // A current branch the shared name rules would refuse falls back to main, so Enable does not fail on a name the user never chose (WR-09).
    integrationBranch: main.code === 0 || !isGitRefName(branch) ? 'main' : branch
  };
  if (branch !== '') defaults.branch = branch;
  return defaults;
}

// Removes the whole team storage folder (which holds the mirror) and, only when this Enable call created it, the device key (D-22). An identity that
// existed before Enable (another team, another attempt) is never touched, and neither is a different key stored since. Every failure is returned as
// text, never dropped.
async function rollback(
  secrets: SecretStorageLike, globalStorageDir: string, teamId: string, createdKey: { fingerprint: string } | undefined, warn?: (message: string) => void
): Promise<string[]> {
  const problems: string[] = [];
  if (createdKey !== undefined) {
    try {
      await forgetCreatedDeviceIdentity(secrets, { identityDir: identityDir(globalStorageDir), fingerprint: createdKey.fingerprint, ...(warn === undefined ? {} : { warn }) });
    } catch (error) {
      problems.push(`The device key could not be removed: ${describeError(error)}`);
    }
  }
  try {
    await fs.rm(teamStorageDir(globalStorageDir, teamId), { recursive: true, force: true });
  } catch (error) {
    problems.push(`The coordination mirror could not be removed: ${describeError(error)}`);
  }
  return problems;
}

type GenesisOutcome =
  | { kind: 'pushed' }
  | { kind: 'exists' }
  | { kind: 'failed'; reason: string; detail: string }
  | { kind: 'unconfirmed'; reason: string; detail: string };

// Writes the genesis batch. A definite failure is 'failed' or 'exists'. A push without a ref line (timeout, dropped connection) and a throw
// part-way through may both have landed, so those are checked against the remote; only an answer from the remote settles them. When the
// remote cannot be asked the result is 'unconfirmed', and the caller must keep the device key.
async function pushGenesis(args: { transport: GitTransport<TeamState>; events: TeamEvent[]; teamFileText: string; git: GitRunner; projectRoot: string; remote: string }): Promise<GenesisOutcome> {
  const { transport, events, teamFileText, git, projectRoot, remote } = args;
  let reason: string;
  try {
    const pushed = await transport.append(async () => events, { genesis: { teamFileText } });
    if (pushed.ok) return { kind: 'pushed' };
    if (pushed.kind === 'exists') return { kind: 'exists' };
    if (pushed.kind !== 'offline') return { kind: 'failed', reason: redactGitMessage(pushed.reason), detail: '' };
    reason = redactGitMessage(pushed.reason);
  } catch (error) {
    reason = describeError(error);
  }
  let detail: string;
  let fetchThrew = false;
  try {
    await transport.fetch();
    const status = transport.status();
    if (status.state === 'ok') {
      return transport.head().eventId === events[1]?.id ? { kind: 'pushed' } : { kind: 'failed', reason, detail: '' };
    }
    detail = `Checking the remote afterwards also failed: ${redactGitMessage(status.reason ?? 'the remote could not be reached')}`;
  } catch (error) {
    fetchThrew = true;
    detail = `Checking the remote afterwards also failed: ${describeError(error)}`;
  }
  if (fetchThrew) {
    // The mirror could not be used for the check (for example a folder that cannot be created); ask the remote directly.
    try {
      const resolved = await resolveCheckedRemote(projectRoot, remote, git);
      if (resolved.ok && (await cleanLsRemote(git, resolved.remote, DEFAULT_COORDINATION_REF)).code === 2) return { kind: 'failed', reason, detail: '' };
    } catch (error) {
      detail = `${detail} ${describeError(error)}`;
    }
  }
  return { kind: 'unconfirmed', reason, detail };
}

export async function enableTeamMode(input: EnableInput): Promise<EnableResult> {
  const git = input.git ?? runGit;
  const now = input.now ?? ((): Date => new Date());
  const remote = input.remote ?? DEFAULT_REMOTE;
  const projectRoot = input.projectRoot;

  // First, before any git call, folder read or key: a refused Enable leaves nothing behind and asks nothing of the person.
  if (input.previewEnabled !== true) return fail('preview-off', ENABLE_PREVIEW_OFF_MESSAGE);

  // Everything below up to the device key is read-only or in memory, so a stop here leaves nothing behind.
  if (!REMOTE_NAME_PATTERN.test(remote)) return fail('invalid-input', 'The remote name is not valid. Use a name such as origin.');
  const passed = input.checked;
  const checked = passed !== undefined && passed.ok && passed.projectRoot === projectRoot && passed.remote === remote
    ? passed
    : await checkEnablePreconditions(projectRoot, remote, git);
  if (!checked.ok) return checked;

  let existing: TeamFile | undefined;
  try {
    existing = await readTeamFile(projectRoot);
  } catch (error) {
    if (error instanceof TeamFileError) return fail('exists-locally', `${error.message} Nothing was changed.`);
    throw error;
  }
  if (existing !== undefined) {
    return { ok: false, code: 'exists-locally', teamFile: existing, message: `This project already has a team: ${existing.name} (${existing.teamId}). Joining an existing team arrives with team invitations.` };
  }

  const teamName = input.teamName.trim();
  const ownerName = input.ownerName.trim();
  if (validateName(teamName, 'teamName') !== undefined) return fail('invalid-input', 'The team name must be 1 to 80 characters with no line breaks.');
  if (validateName(ownerName, 'ownerName') !== undefined) return fail('invalid-input', 'Your display name must be 1 to 80 characters with no line breaks.');
  const integrationBranch = input.integrationBranch ?? (await enableDefaults(projectRoot, git)).integrationBranch;
  const policy = defaultTeamPolicy({ integrationBranch });
  if (validatePolicy(policy) !== undefined) return fail('invalid-input', 'The integration branch name is not valid.');
  try {
    assertNoSecrets({ teamName, ownerName }, 'The team details');
  } catch (error) {
    if (error instanceof SecretLeakError) return fail('secret', error.message);
    throw error;
  }

  // D-17: an existing coordination branch on the remote stops Enable before any key exists.
  // The address is resolved and checked again here, since a passed precondition result may be older; the probe itself never reads the project's
  // git config (cleanRemote.ts).
  const resolved = await resolveCheckedRemote(projectRoot, remote, git);
  if (!resolved.ok) return fail('remote-refused', resolved.reason);
  const probe = await cleanLsRemote(git, resolved.remote, DEFAULT_COORDINATION_REF);
  if (probe.code === 0) return fail('exists-remotely', 'This remote already has a coordination log. Joining an existing team arrives with team invitations.');
  if (probe.code !== 2) return fail('remote-unreachable', `The remote "${remote}" could not be reached, so nothing was changed: ${gitFailureText(probe)}`);

  const teamId = newTeamId();
  const memberId = newMemberId();
  // No email address, and nothing derived from one, is asked for, stored or signed: the team id is public in team.json, so any hash of an
  // address salted with it could be reversed by guessing addresses. The roster format keeps its hash lists, and this version keeps them empty.
  const emailHashes: string[] = [];
  const { identity, created } = await loadOrCreateDeviceIdentity(input.secrets, { identityDir: identityDir(input.globalStorageDir), ...(input.warn === undefined ? {} : { warn: input.warn }) });
  const createdKey = created ? { fingerprint: identity.fingerprint } : undefined;
  const storageDir = teamStorageDir(input.globalStorageDir, teamId);

  let genesis: ReturnType<typeof buildGenesisEvents>;
  let teamFile: TeamFile;
  try {
    genesis = buildGenesisEvents({ teamId, teamName, owner: { memberId, name: ownerName, emailHashes }, identity, policy, now });
    teamFile = {
      version: 1, teamId, name: teamName, coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote },
      genesis: { eventId: genesis.anchor.eventId, ownerDevice: { ...genesis.anchor.ownerDevice } }, createdAt: now().toISOString()
    };
    assertNoSecrets(teamFile, 'team.json');
  } catch (error) {
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId, createdKey, input.warn);
    if (error instanceof SecretLeakError) return fail('secret', [error.message, ...problems].join(' '));
    throw error;
  }

  const transport = new GitTransport({
    mirrorDir: path.join(storageDir, 'coordination.git'), projectRoot, remote, ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(genesis.anchor), git
  });
  const outcome = await pushGenesis({ transport, events: genesis.events, teamFileText: canonicalTeamFile(teamFile), git, projectRoot, remote });
  if (outcome.kind === 'exists') {
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId, createdKey, input.warn);
    return fail('exists-remotely', ['This remote already has a coordination log.', ...problems].join(' '));
  }
  if (outcome.kind === 'failed') {
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId, createdKey, input.warn);
    return fail('push-failed', [`The team could not be created on the remote: ${outcome.reason}`, outcome.detail, ...problems, 'Nothing was kept on this computer.'].filter((part) => part !== '').join(' '));
  }
  if (outcome.kind === 'unconfirmed') {
    // The push may have landed and nothing could confirm it either way. If it did, this device key is the only owner key, so it stays.
    return fail('push-unconfirmed', [
      `The team may have been created on the remote "${remote}", but this computer could not confirm it: ${outcome.reason}`,
      outcome.detail,
      `Your device key and the local copy of the coordination log were kept. Check whether ${DEFAULT_COORDINATION_REF} exists on the remote (git ls-remote ${remote} ${DEFAULT_COORDINATION_REF}) once you are online. If it does, keep this computer's NEAR AI data, because it holds the only owner key. If it does not, you can run Enable Team Mode again.`
    ].filter((part) => part !== '').join(' '));
  }

  // The coordination branch now exists, so from here the key stays; a failure only affects the file in the user's project.
  try {
    await writeTeamFile(projectRoot, teamFile);
    // This computer just created the team and holds its owner key, so the project's pin is set to it, replacing a pin for an earlier team.
    await pinTrust(projectTrustDir(input.globalStorageDir, projectRoot), teamFile);
  } catch (error) {
    return {
      ok: false, code: 'commit-failed', teamFile,
      message: `The team was created on the remote, but ${TEAM_FILE_REL} could not be saved: ${describeError(error)} Nothing was committed in your project.`
    };
  }

  // D-20: add -f because projects ignore .planning/.near-ai/, and --only so nothing else the user has staged is committed.
  const added = await git(['add', '-f', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const committed = added.code === 0
    ? await git(['commit', '--only', '-m', ENABLE_COMMIT_MESSAGE, '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: COMMIT_TIMEOUT_MS })
    : added;
  if (committed.code !== 0) {
    const reset = await git(['reset', '-q', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
    const resetNote = reset.code === 0 ? '' : ` Removing ${TEAM_FILE_REL} from the staging area also failed: ${gitFailureText(reset)}`;
    return {
      ok: false, code: 'commit-failed', teamFile,
      message: `The team was created, but committing ${TEAM_FILE_REL} failed: ${gitFailureText(committed)}${resetNote} The file is saved in your project and nothing else was committed. To finish, run: ${manualCommitCommand()}`
    };
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const result: EnableResult = { ok: true, teamFile, commit: gitText(head), remote };
  if (checked.branch !== undefined) result.branch = checked.branch;
  return result;
}

// The Push button (D-20): the only place Team Mode pushes the user's code branch, and only when the user clicks it.
export async function pushCodeBranch(projectRoot: string, remote: string, branch: string, git: GitRunner = runGit): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!REMOTE_NAME_PATTERN.test(remote)) return { ok: false, message: 'The remote name is not valid.' };
  // A branch name that starts with a dash would be read as an option, and a colon would make it a refspec: the shared ref-name rule refuses both.
  if (!isGitRefName(branch) || CONTROL_CHARACTERS.test(branch)) return { ok: false, message: 'The branch name is not valid.' };
  const resolved = await resolveCheckedRemote(projectRoot, remote, git);
  if (!resolved.ok) return { ok: false, message: resolved.reason };
  // 0.4.25: the branch is read in the project (a local read that runs nothing), then pushed from a clean folder that reads the project's objects
  // through an alternate, so no setting, helper or hook from the project's git config runs (cleanRemote.ts).
  const commit = await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(gitText(commit))) return { ok: false, message: `There is no branch named ${branch} in this project to push.` };
  const common = await git(['rev-parse', '--git-common-dir'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (common.code !== 0 || gitText(common) === '') return { ok: false, message: `Pushing ${branch} to ${remote} failed: ${gitFailureText(common)}` };
  const objectsDir = path.join(path.resolve(projectRoot, gitText(common)), 'objects');
  const result = await cleanPush(git, resolved.remote, objectsDir, gitText(commit), branch);
  return result.code === 0 ? { ok: true } : { ok: false, message: `Pushing ${branch} to ${remote} failed: ${gitFailureText(result)}` };
}
