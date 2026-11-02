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
import { DEFAULT_COORDINATION_REF, GitTransport } from './gitTransport';
import { createDeviceIdentity, emailHash, forgetDeviceIdentity, newMemberId, newTeamId } from './identity';
import { GitNotFoundError, gitText, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { REMOTE_NAME_PATTERN, TEAM_FILE_REL, TeamFileError, checkTrustPin, canonicalTeamFile, readTeamFile, teamStorageDir, writeTeamFile } from './teamFile';

export const ENABLE_COMMIT_MESSAGE = 'chore(team): enable NEAR AI Team Mode';

export type EnableFailureCode =
  | 'git-missing' | 'not-initialised' | 'not-a-repo' | 'no-commit' | 'no-remote' | 'remote-unreachable' | 'exists-locally' | 'exists-remotely'
  | 'invalid-input' | 'secret' | 'push-failed' | 'push-unconfirmed' | 'commit-failed';

export interface EnableInput {
  projectRoot: string;
  globalStorageDir: string;
  secrets: SecretStorageLike;
  teamName: string;
  ownerName: string;
  ownerEmail?: string;
  remote?: string;
  integrationBranch?: string;
  git?: GitRunner;
  now?: () => Date;
}

export type EnableResult =
  | { ok: true; teamFile: TeamFile; branch?: string; commit: string; remote: string }
  | { ok: false; code: EnableFailureCode; message: string; teamFile?: TeamFile };

export interface EnableDefaults {
  teamName: string;
  ownerName: string;
  ownerEmail: string;
  remote: string;
  branch?: string;
  integrationBranch: string;
}

type Preconditions = { ok: true; branch?: string } | { ok: false; code: EnableFailureCode; message: string };

const DEFAULT_REMOTE = 'origin';
const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 60_000;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_EMAIL_LENGTH = 254;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
// The same non-interactive ssh the transport uses, so a passphrase prompt cannot hang the existence check.
const DEFAULT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';

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
function manualCommitCommand(message: string): string {
  return `git add -f ${TEAM_FILE_REL} && git commit --only -m "${message}" -- ${TEAM_FILE_REL}`;
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
  // The URL is only checked for existence: it can carry credentials, so the value is discarded here.
  const url = await run(['remote', 'get-url', remote]);
  if (url.code === 2) return fail('no-remote', `This repository has no remote named "${remote}". Add one with git remote add ${remote} <url>, then enable Team Mode.`);
  if (url.code !== 0) return fail('remote-unreachable', `Git could not read the remote "${remote}": ${gitFailureText(url)}`);
  const branch = await run(['symbolic-ref', '--short', '-q', 'HEAD']);
  const name = branch.code === 0 ? gitText(branch) : '';
  return name === '' ? { ok: true } : { ok: true, branch: name };
}

async function gitConfigValue(projectRoot: string, key: string, git: GitRunner): Promise<string> {
  const result = await git(['config', '--get', key], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  return result.code === 0 ? gitText(result) : '';
}

export async function enableDefaults(projectRoot: string, git: GitRunner = runGit): Promise<EnableDefaults> {
  const [ownerName, ownerEmail] = await Promise.all([gitConfigValue(projectRoot, 'user.name', git), gitConfigValue(projectRoot, 'user.email', git)]);
  const branchResult = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const branch = branchResult.code === 0 ? gitText(branchResult) : '';
  const main = await git(['show-ref', '--verify', '-q', 'refs/heads/main'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const defaults: EnableDefaults = {
    teamName: path.basename(path.resolve(projectRoot)), ownerName, ownerEmail, remote: DEFAULT_REMOTE,
    // A current branch the shared name rules would refuse falls back to main, so Enable does not fail on a name the user never chose (WR-09).
    integrationBranch: main.code === 0 || !isGitRefName(branch) ? 'main' : branch
  };
  if (branch !== '') defaults.branch = branch;
  return defaults;
}

async function networkEnv(projectRoot: string, git: GitRunner): Promise<Record<string, string>> {
  const inherited = process.env.GIT_SSH_COMMAND;
  if (inherited !== undefined && inherited !== '') return {};
  const configured = await gitConfigValue(projectRoot, 'core.sshCommand', git);
  return { GIT_SSH_COMMAND: configured !== '' ? configured : DEFAULT_SSH_COMMAND };
}

function validateEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && email.includes('@') && !CONTROL_CHARACTERS.test(email) && !/\s/.test(email);
}

// Removes the device key and the whole team storage folder (which holds the mirror). Every failure is returned as text, never dropped.
async function rollback(secrets: SecretStorageLike, globalStorageDir: string, teamId: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    await forgetDeviceIdentity(secrets, teamId);
  } catch (error) {
    problems.push(`The device key could not be removed: ${describeError(error)}`);
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
      const probe = await git(['ls-remote', '--exit-code', remote, DEFAULT_COORDINATION_REF], { cwd: projectRoot, env: await networkEnv(projectRoot, git), timeoutMs: NETWORK_TIMEOUT_MS });
      if (probe.code === 2) return { kind: 'failed', reason, detail: '' };
    } catch (error) {
      detail = `${detail} ${describeError(error)}`;
    }
  }
  return { kind: 'unconfirmed', reason, detail };
}

// D-20: commits team.json and nothing else, for Enable and for linking a NEAR organization. add -f because projects ignore .planning/.near-ai/,
// and --only so nothing else the user has staged is committed. It never pushes. On a failure team.json is unstaged again and stays on disk;
// the message is written to follow "..., but " and ends with the exact command that finishes the job by hand.
export async function commitTeamFileOnly(projectRoot: string, message: string, git: GitRunner = runGit): Promise<{ ok: true; commit: string; branch?: string } | { ok: false; message: string }> {
  const added = await git(['add', '-f', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const committed = added.code === 0
    ? await git(['commit', '--only', '-m', message, '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: COMMIT_TIMEOUT_MS })
    : added;
  if (committed.code !== 0) {
    const reset = await git(['reset', '-q', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
    const resetNote = reset.code === 0 ? '' : ` Removing ${TEAM_FILE_REL} from the staging area also failed: ${gitFailureText(reset)}`;
    return {
      ok: false,
      message: `committing ${TEAM_FILE_REL} failed: ${gitFailureText(committed)}${resetNote} The file is saved in your project and nothing else was committed. To finish, run: ${manualCommitCommand(message)}`
    };
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const name = branch.code === 0 ? gitText(branch) : '';
  return name === '' ? { ok: true, commit: gitText(head) } : { ok: true, commit: gitText(head), branch: name };
}

export async function enableTeamMode(input: EnableInput): Promise<EnableResult> {
  const git = input.git ?? runGit;
  const now = input.now ?? ((): Date => new Date());
  const remote = input.remote ?? DEFAULT_REMOTE;
  const projectRoot = input.projectRoot;

  // Everything below up to the device key is read-only or in memory, so a stop here leaves nothing behind.
  if (!REMOTE_NAME_PATTERN.test(remote)) return fail('invalid-input', 'The remote name is not valid. Use a name such as origin.');
  const checked = await checkEnablePreconditions(projectRoot, remote, git);
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
  const ownerEmail = input.ownerEmail?.trim() ?? '';
  if (validateName(teamName, 'teamName') !== undefined) return fail('invalid-input', 'The team name must be 1 to 80 characters with no line breaks.');
  if (validateName(ownerName, 'ownerName') !== undefined) return fail('invalid-input', 'Your display name must be 1 to 80 characters with no line breaks.');
  if (ownerEmail !== '' && !validateEmail(ownerEmail)) return fail('invalid-input', 'The email address is not valid. Leave it empty or use a full address such as name@example.com.');
  const integrationBranch = input.integrationBranch ?? (await enableDefaults(projectRoot, git)).integrationBranch;
  const policy = defaultTeamPolicy({ integrationBranch });
  if (validatePolicy(policy) !== undefined) return fail('invalid-input', 'The integration branch name is not valid.');
  try {
    assertNoSecrets({ teamName, ownerName, ...(ownerEmail === '' ? {} : { ownerEmail }) }, 'The team details');
  } catch (error) {
    if (error instanceof SecretLeakError) return fail('secret', error.message);
    throw error;
  }

  // D-17: an existing coordination branch on the remote stops Enable before any key exists.
  const probe = await git(['ls-remote', '--exit-code', remote, DEFAULT_COORDINATION_REF], { cwd: projectRoot, env: await networkEnv(projectRoot, git), timeoutMs: NETWORK_TIMEOUT_MS });
  if (probe.code === 0) return fail('exists-remotely', 'This remote already has a coordination log. Joining an existing team arrives with team invitations.');
  if (probe.code !== 2) return fail('remote-unreachable', `The remote "${remote}" could not be reached, so nothing was changed: ${gitFailureText(probe)}`);

  const teamId = newTeamId();
  const memberId = newMemberId();
  // D-31: the address only feeds the hash. It is not stored, signed or returned.
  const emailHashes = ownerEmail === '' ? [] : [emailHash(teamId, ownerEmail)];
  const identity = await createDeviceIdentity(input.secrets, teamId);
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
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId);
    if (error instanceof SecretLeakError) return fail('secret', [error.message, ...problems].join(' '));
    throw error;
  }

  const transport = new GitTransport({
    mirrorDir: path.join(storageDir, 'coordination.git'), projectRoot, remote, ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(genesis.anchor), git
  });
  const outcome = await pushGenesis({ transport, events: genesis.events, teamFileText: canonicalTeamFile(teamFile), git, projectRoot, remote });
  if (outcome.kind === 'exists') {
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId);
    return fail('exists-remotely', ['This remote already has a coordination log.', ...problems].join(' '));
  }
  if (outcome.kind === 'failed') {
    const problems = await rollback(input.secrets, input.globalStorageDir, teamId);
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
    await checkTrustPin(storageDir, teamFile);
  } catch (error) {
    return {
      ok: false, code: 'commit-failed', teamFile,
      message: `The team was created on the remote, but ${TEAM_FILE_REL} could not be saved: ${describeError(error)} Nothing was committed in your project.`
    };
  }

  const committed = await commitTeamFileOnly(projectRoot, ENABLE_COMMIT_MESSAGE, git);
  if (!committed.ok) return { ok: false, code: 'commit-failed', teamFile, message: `The team was created, but ${committed.message}` };
  const result: EnableResult = { ok: true, teamFile, commit: committed.commit, remote };
  if (checked.branch !== undefined) result.branch = checked.branch;
  return result;
}

// The Push button (D-20): the only place Team Mode pushes the user's code branch, and only when the user clicks it.
export async function pushCodeBranch(projectRoot: string, remote: string, branch: string, git: GitRunner = runGit): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!REMOTE_NAME_PATTERN.test(remote)) return { ok: false, message: 'The remote name is not valid.' };
  // A branch name that starts with a dash would be read as an option.
  if (branch === '' || branch.startsWith('-') || CONTROL_CHARACTERS.test(branch)) return { ok: false, message: 'The branch name is not valid.' };
  const result = await git(['push', remote, branch], { cwd: projectRoot, env: await networkEnv(projectRoot, git), timeoutMs: NETWORK_TIMEOUT_MS });
  return result.code === 0 ? { ok: true } : { ok: false, message: `Pushing ${branch} to ${remote} failed: ${gitFailureText(result)}` };
}
