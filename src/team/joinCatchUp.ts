// Bringing an existing copy of the team's project up to date before a join (G-61-4). The invitee may already have the project open from
// before Team Mode was turned on; findSameProjectRemote decides whether the open copy is the invite's project by comparing the addresses of
// the remotes configured in this copy with the invite's address, and catchUpCopy fetches and fast-forwards the current branch only when no
// work can be lost. The invite bundle is hostile text (WR-03): its address only picks among remotes this copy already has, and git is only
// ever told a remote name. This module never imports vscode and holds no people-facing words: only codes and redacted technical details.
import { isGitRefName } from '../domain/team/policy';
import { networkEnv } from './enable';
import { cleanRepoUrl } from './inviteBundle';
import { gitText, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { REMOTE_NAME_PATTERN, TEAM_FILE_REL, TeamFileError, parseTeamFile, readTeamFile } from './teamFile';

export type CatchUpReason = 'local-changes' | 'unshared-work' | 'other-version' | 'not-shared' | 'offline';

export type CatchUpResult = { ok: true; updated: boolean; branch: string } | { ok: false; reason: CatchUpReason; detail?: string };

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 60_000;
// team.json is at most 16 KB (parseTeamFile); anything over this cap is not read and counts as not the team's file.
const MAX_TEAM_FILE_READ_BYTES = 64 * 1024;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
// The online default branch is fetched here only to tell other-version from not-shared, and the ref is deleted again straight after.
export const CATCH_UP_PROBE_REF = 'refs/near-ai/catch-up/head';
const MISSING_REMOTE_REF = /couldn't find remote ref/i;
const SYMREF_LINE = /^ref: refs\/heads\/(\S+)\tHEAD$/;

// An http, https or ssh address with a password in its user part. cleanRepoUrl would drop it, but such an address is never matched.
function hasPassword(url: string): boolean {
  const authority = SCHEME.exec(url.trim())?.[2] ?? '';
  const at = authority.lastIndexOf('@');
  return at >= 0 && authority.slice(0, at).includes(':');
}

function trimRepoPath(repoPath: string): string {
  let text = repoPath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (text.toLowerCase().endsWith('.git')) text = text.slice(0, -4);
  return text.replace(/\/+$/, '');
}

// 'host/path' in lower case, with no user, no .git and no trailing slash, so https, scp-style and ssh forms of one address compare equal.
// A default port (22 for ssh) is dropped; any other port stays part of the host. Undefined for anything cleanRepoUrl refuses (a local path,
// a file:// address, a remote helper) and for an address with a password.
export function projectAddressKey(url: string): string | undefined {
  if (typeof url !== 'string' || hasPassword(url)) return undefined;
  const cleaned = cleanRepoUrl(url);
  if (!cleaned.ok) return undefined;
  let host: string;
  let repoPath: string;
  const scheme = SCHEME.exec(cleaned.url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(cleaned.url);
    } catch {
      return undefined;
    }
    const defaultPort = (scheme === 'ssh' && parsed.port === '22') || parsed.port === '';
    host = defaultPort ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
    repoPath = parsed.pathname;
  } else {
    const colon = cleaned.url.indexOf(':');
    const head = cleaned.url.slice(0, colon);
    host = head.slice(head.lastIndexOf('@') + 1);
    repoPath = cleaned.url.slice(colon + 1);
  }
  const trimmed = trimRepoPath(repoPath);
  if (host === '' || trimmed === '') return undefined;
  return `${host}/${trimmed}`.toLowerCase();
}

// The name of a remote configured in this copy whose address is the invite's address, origin first. Reads git config only (no network).
// The invite's address is never handed to git: it is only compared with what this copy already has.
export async function findSameProjectRemote(projectRoot: string, bundleRepo: string, git: GitRunner = runGit): Promise<string | undefined> {
  const wanted = projectAddressKey(bundleRepo);
  if (wanted === undefined) return undefined;
  const listed = await git(['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (listed.code !== 0) return undefined;
  const matches: string[] = [];
  for (const line of gitText(listed).split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    if (!key.startsWith('remote.') || !key.endsWith('.url')) continue;
    const name = key.slice('remote.'.length, -'.url'.length);
    if (!REMOTE_NAME_PATTERN.test(name) || !isGitRefName(`refs/remotes/${name}/x`)) continue;
    if (projectAddressKey(line.slice(space + 1)) === wanted && !matches.includes(name)) matches.push(name);
  }
  return matches.includes('origin') ? 'origin' : matches[0];
}

interface Context { projectRoot: string; remote: string; teamId: string | undefined; git: GitRunner; net: GitRunner; url: string }

// Redacts a git message and removes the configured address in every form it could be printed in.
function detailOf(context: Context, result: GitResult): string {
  let text = result.stderr.trim() || `git exited with code ${result.code}`;
  for (const form of [context.url, redactGitMessage(context.url)]) {
    if (form.trim() !== '') text = text.split(form).join('<remote address>');
  }
  return redactGitMessage(text);
}

function refuse(reason: CatchUpReason, detail?: string): CatchUpResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function withEnv(git: GitRunner, env: Record<string, string>): GitRunner {
  return (args, options = {}) => git(args, { ...options, env: { ...env, ...options.env } });
}

async function commitOf(context: Context, ref: string): Promise<string | undefined> {
  const result = await context.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: context.projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const commit = gitText(result);
  return result.code === 0 && COMMIT_ID.test(commit) ? commit : undefined;
}

// The team id in team.json at a commit, or undefined when there is no such file or it is not a team file this client can read.
async function teamAt(context: Context, commit: string): Promise<string | undefined> {
  const read = await context.git(['cat-file', 'blob', `${commit}:${TEAM_FILE_REL}`], { cwd: context.projectRoot, timeoutMs: LOCAL_TIMEOUT_MS, maxStdoutBytes: MAX_TEAM_FILE_READ_BYTES });
  if (read.code !== 0 || read.overflowed === true) return undefined;
  try {
    return parseTeamFile(read.stdout.toString('utf8')).teamId;
  } catch (error) {
    if (error instanceof TeamFileError) return undefined;
    throw error;
  }
}

type DefaultBranch = { kind: 'has-team' } | { kind: 'no-team' } | { kind: 'offline'; detail: string };

// Does the online default branch (when it is not the copy's own branch) hold this team's team.json? Then the copy is simply on another
// version than the shared one; otherwise the project with the team in it was never shared.
async function defaultBranchHasTeam(context: Context, branch: string): Promise<DefaultBranch> {
  const { projectRoot, remote } = context;
  const listed = await context.net(['ls-remote', '--symref', remote, 'HEAD'], { cwd: projectRoot, timeoutMs: NETWORK_TIMEOUT_MS });
  if (listed.code !== 0) return { kind: 'offline', detail: detailOf(context, listed) };
  let named: string | undefined;
  for (const line of gitText(listed).split('\n')) named ??= SYMREF_LINE.exec(line)?.[1];
  if (named === undefined || named === branch || !isGitRefName(`refs/heads/${named}`)) return { kind: 'no-team' };
  const fetched = await context.net(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, `+refs/heads/${named}:${CATCH_UP_PROBE_REF}`], { cwd: projectRoot, timeoutMs: NETWORK_TIMEOUT_MS });
  try {
    if (fetched.code !== 0) return MISSING_REMOTE_REF.test(fetched.stderr) ? { kind: 'no-team' } : { kind: 'offline', detail: detailOf(context, fetched) };
    const commit = await commitOf(context, CATCH_UP_PROBE_REF);
    return commit !== undefined && await teamAt(context, commit) === context.teamId ? { kind: 'has-team' } : { kind: 'no-team' };
  } finally {
    await context.git(['update-ref', '-d', CATCH_UP_PROBE_REF], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  }
}

async function versionRefusal(context: Context, branch: string): Promise<CatchUpResult> {
  const online = await defaultBranchHasTeam(context, branch);
  if (online.kind === 'offline') return refuse('offline', online.detail);
  return refuse(online.kind === 'has-team' ? 'other-version' : 'not-shared');
}

// Brings the current branch of this copy up to the online version of the same branch, fetched from the named remote only. Every check runs
// before anything in the copy changes; the only change is a fast-forward (merge --ff-only). Nothing is reset, stashed or checked out.
export async function catchUpCopy(input: { projectRoot: string; remote: string; teamId?: string; git?: GitRunner }): Promise<CatchUpResult> {
  const git = input.git ?? runGit;
  const { projectRoot, remote, teamId } = input;
  if (!REMOTE_NAME_PATTERN.test(remote)) throw new Error('The remote name is not a valid git remote name.');
  const configured = await git(['config', '--get', `remote.${remote}.url`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const net = withEnv(git, await networkEnv(projectRoot, git));
  const context: Context = { projectRoot, remote, teamId, git, net, url: configured.code === 0 ? gitText(configured) : '' };

  const symbolic = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const branch = gitText(symbolic);
  if (symbolic.code !== 0 || branch === '' || !isGitRefName(`refs/heads/${branch}`)) return refuse('other-version');
  const head = await commitOf(context, 'HEAD');
  if (head === undefined) return refuse('other-version');

  const tracking = `refs/remotes/${remote}/${branch}`;
  const fetched = await net(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, `+refs/heads/${branch}:${tracking}`], { cwd: projectRoot, timeoutMs: NETWORK_TIMEOUT_MS });
  if (fetched.code !== 0) {
    // The branch the copy is on is not online at all: either another version than the shared one, or nothing was shared yet.
    return MISSING_REMOTE_REF.test(fetched.stderr) ? versionRefusal(context, branch) : refuse('offline', detailOf(context, fetched));
  }
  const tip = await commitOf(context, tracking);
  if (tip === undefined) return refuse('offline');

  if (await teamAt(context, tip) !== teamId) return versionRefusal(context, branch);
  if (head !== tip) {
    const ancestor = await git(['merge-base', '--is-ancestor', head, tip], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
    if (ancestor.code !== 0) return refuse('unshared-work', ancestor.code === 1 ? undefined : detailOf(context, ancestor));
  }
  const status = await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (status.code !== 0) return refuse('local-changes', detailOf(context, status));
  if (gitText(status) !== '') return refuse('local-changes');
  // git counts an ignored file as expendable and a fast-forward would overwrite it, so a team.json left by an earlier attempt is checked
  // on its own (no --exclude-standard: ignored files are listed too).
  const untracked = await git(['ls-files', '--others', '-z', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (untracked.code !== 0) return refuse('local-changes', detailOf(context, untracked));
  if (untracked.stdout.length > 0) return refuse('local-changes');

  if (head !== tip) {
    const merged = await git(['merge', '--ff-only', '--quiet', tip], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
    if (merged.code !== 0) return refuse('local-changes', detailOf(context, merged));
  }
  let onDisk: string | undefined;
  try {
    onDisk = (await readTeamFile(projectRoot))?.teamId;
  } catch (error) {
    if (!(error instanceof TeamFileError)) throw error;
  }
  if (onDisk !== teamId) return refuse('not-shared');
  return { ok: true, updated: head !== tip, branch };
}
