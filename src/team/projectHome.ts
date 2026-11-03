// The project's online home (G-61-2, G-61-3) as a VS Code-free core. checkOnlineHome reads git config only, with no network, and decides
// with the invite's own cleanRepoUrl whether teammates can reach the team remote, so Enable and Invite can never disagree.
// teamSetupShared asks the online home whether the coordination record is there and whether the integration branch holds this computer's
// team.json. The configured URL can carry a credential: it is never placed in a result, and every detail passes through redactGitMessage
// (Phase 60 D-34). This module never imports vscode and holds no people-facing words: only codes and redacted technical details.
import type { TeamFile } from '../domain/team/types';
import { networkEnv } from './enable';
import { cleanRepoUrl } from './inviteBundle';
import { fetchIntegrationBranch } from './integrationSource';
import { gitText, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { REMOTE_NAME_PATTERN, TEAM_FILE_REL, TeamFileError, canonicalTeamFile, parseTeamFile } from './teamFile';

export type OnlineHome =
  | { kind: 'shareable'; remote: string }
  | { kind: 'no-remote'; remote: string }
  | { kind: 'local-only'; remote: string }
  /** reason is cleanRepoUrl's fixed sentence, never the URL. */
  | { kind: 'not-shareable'; remote: string; reason: string };

export interface ShareInput { projectRoot: string; teamFile: TeamFile; branch: string; git?: GitRunner }

export type SharedState =
  | { kind: 'shared' }
  | { kind: 'not-shared'; missing: 'branch' | 'team-file' | 'different-team-file' }
  /** The coordination ref is not on the online home. */
  | { kind: 'record-missing' }
  | { kind: 'not-reachable-by-teammates'; home: OnlineHome }
  /** Offline, or git could not answer. */
  | { kind: 'unknown'; detail: string };

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 60_000;
// team.json is at most 16 KB (parseTeamFile); anything over this cap is not read and counts as a different file.
const MAX_TEAM_FILE_READ_BYTES = 64 * 1024;
const FILE_SCHEME = /^file:/i;
const SCHEME_AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/;
// cleanRepoUrl's own sentence for a local path, taken from cleanRepoUrl itself so the two can never drift apart.
const LOCAL_PATH_REASON = ((): string => {
  const refused = cleanRepoUrl('./a-local-folder');
  return refused.ok ? '' : refused.reason;
})();
// cleanRepoUrl's own sentence for an address with a password or token in its user part.
const CREDENTIALS_REASON = ((): string => {
  const refused = cleanRepoUrl('user:password@example.invalid:repo.git');
  return refused.ok ? '' : refused.reason;
})();

// cleanRepoUrl removes a credential from an http, https or ssh address so an invite can carry the rest. The online home check is
// stricter (T-61-70): an address this computer reaches with a password or token in it is not one teammates can use as it is. Any user part
// of an http or https address counts (a token is often written as the user name); for ssh only a password does (git@ is a login name).
function carriesCredentials(url: string): boolean {
  const match = SCHEME_AUTHORITY.exec(url.trim());
  if (match === null) return false;
  const authority = match[2] ?? '';
  const at = authority.lastIndexOf('@');
  if (at < 0) return false;
  const userInfo = authority.slice(0, at);
  const scheme = (match[1] ?? '').toLowerCase();
  return scheme === 'http' || scheme === 'https' ? userInfo !== '' : userInfo.includes(':');
}

// The remote URL exactly as configured (the same rule as the invite): `git remote get-url` would apply insteadOf rewrites, which can point
// at a private mirror. The value can hold a credential, so callers never log it or put it in a result.
export async function configuredRemoteUrl(projectRoot: string, remote: string, git: GitRunner = runGit): Promise<string> {
  if (!REMOTE_NAME_PATTERN.test(remote)) return '';
  const result = await git(['config', '--get', `remote.${remote}.url`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  return result.code === 0 ? gitText(result) : '';
}

function homeOf(remote: string, url: string): OnlineHome {
  if (url.trim() === '') return { kind: 'no-remote', remote };
  const cleaned = cleanRepoUrl(url);
  if (cleaned.ok) return carriesCredentials(url) ? { kind: 'not-shareable', remote, reason: CREDENTIALS_REASON } : { kind: 'shareable', remote };
  if (cleaned.reason === LOCAL_PATH_REASON || FILE_SCHEME.test(url.trim())) return { kind: 'local-only', remote };
  return { kind: 'not-shareable', remote, reason: cleaned.reason };
}

// No network: only `git config` is read.
export async function checkOnlineHome(projectRoot: string, remote: string, git: GitRunner = runGit): Promise<OnlineHome> {
  return homeOf(remote, await configuredRemoteUrl(projectRoot, remote, git));
}

// Redacts a git message and removes the configured URL in every form it could be printed in.
function scrub(message: string, url: string): string {
  let text = message;
  for (const form of [url, redactGitMessage(url)]) {
    if (form.trim() !== '') text = text.split(form).join('<remote address>');
  }
  return redactGitMessage(text);
}

function failureText(result: GitResult): string {
  return result.stderr.trim() || `git exited with code ${result.code}`;
}

// A runner that adds the non-interactive network environment to every call, so an ssh passphrase prompt cannot hang a fetch.
function withEnv(git: GitRunner, env: Record<string, string>): GitRunner {
  return (args, options = {}) => git(args, { ...options, env: { ...env, ...options.env } });
}

type TeamFileAt = { kind: 'missing' } | { kind: 'present'; blob: string; same: boolean };

// team.json at a commit, compared with this computer's file in canonical form. A file that is not a regular file, is over the read cap or
// does not parse is present but not the same.
async function teamFileAt(projectRoot: string, commit: string, teamFile: TeamFile, git: GitRunner = runGit): Promise<TeamFileAt> {
  const listed = await git(['ls-tree', '-z', commit, '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (listed.code !== 0) throw new Error(`Reading the team file failed: ${redactGitMessage(failureText(listed))}`);
  const row = listed.stdout.toString('utf8').split('\0').find((line) => line.endsWith(`\t${TEAM_FILE_REL}`));
  if (row === undefined) return { kind: 'missing' };
  const [mode, type, blob] = row.slice(0, row.indexOf('\t')).split(' ');
  if (type !== 'blob' || blob === undefined || (mode !== '100644' && mode !== '100755')) return { kind: 'present', blob: blob ?? '', same: false };
  const read = await git(['cat-file', 'blob', blob], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS, maxStdoutBytes: MAX_TEAM_FILE_READ_BYTES });
  if (read.overflowed === true) return { kind: 'present', blob, same: false };
  if (read.code !== 0) throw new Error(`Reading the team file failed: ${redactGitMessage(failureText(read))}`);
  try {
    return { kind: 'present', blob, same: canonicalTeamFile(parseTeamFile(read.stdout.toString('utf8'))) === canonicalTeamFile(teamFile) };
  } catch (error) {
    if (error instanceof TeamFileError) return { kind: 'present', blob, same: false };
    throw error;
  }
}

// What the online home holds, read in order: is it reachable by teammates (no network), is the coordination record there, does the
// integration branch exist, and does its team.json match. Shared by teamSetupShared and the share planner.
type Inspection =
  | { kind: 'home'; home: OnlineHome }
  | { kind: 'record-missing' }
  | { kind: 'offline'; detail: string }
  | { kind: 'branch-missing' }
  | { kind: 'fetched'; tip: string; remote: TeamFileAt };

async function inspectOnlineHome(input: ShareInput): Promise<Inspection> {
  const git = input.git ?? runGit;
  const { projectRoot, teamFile, branch } = input;
  const remote = teamFile.coordination.remote;
  const url = await configuredRemoteUrl(projectRoot, remote, git);
  const home = homeOf(remote, url);
  if (home.kind !== 'shareable') return { kind: 'home', home };
  try {
    const net = withEnv(git, await networkEnv(projectRoot, git));
    const probe = await net(['ls-remote', '--exit-code', remote, teamFile.coordination.ref], { cwd: projectRoot, timeoutMs: NETWORK_TIMEOUT_MS });
    if (probe.code === 2) return { kind: 'record-missing' };
    if (probe.code !== 0) return { kind: 'offline', detail: scrub(failureText(probe), url) };
    const fetched = await fetchIntegrationBranch(projectRoot, remote, branch, net);
    if (!fetched.ok) return fetched.kind === 'missing' ? { kind: 'branch-missing' } : { kind: 'offline', detail: scrub(fetched.reason, url) };
    return { kind: 'fetched', tip: fetched.commit, remote: await teamFileAt(projectRoot, fetched.commit, teamFile, git) };
  } catch (error) {
    // A thrown message passes the same scrub, so not even an unexpected failure can carry the configured URL.
    throw new Error(scrub(error instanceof Error ? error.message : String(error), url));
  }
}

export async function teamSetupShared(input: ShareInput): Promise<SharedState> {
  let inspected: Inspection;
  try {
    inspected = await inspectOnlineHome(input);
  } catch (error) {
    return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  switch (inspected.kind) {
    case 'home': return { kind: 'not-reachable-by-teammates', home: inspected.home };
    case 'record-missing': return { kind: 'record-missing' };
    case 'offline': return { kind: 'unknown', detail: inspected.detail };
    case 'branch-missing': return { kind: 'not-shared', missing: 'branch' };
    case 'fetched':
      if (inspected.remote.kind === 'missing') return { kind: 'not-shared', missing: 'team-file' };
      return inspected.remote.same ? { kind: 'shared' } : { kind: 'not-shared', missing: 'different-team-file' };
  }
}
