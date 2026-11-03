// The project's online home (G-61-2, G-61-3) as a VS Code-free core. checkOnlineHome reads git config only, with no network, and decides
// with the invite's own cleanRepoUrl whether teammates can reach the team remote, so Enable and Invite can never disagree.
// teamSetupShared asks the online home whether the coordination record is there and whether the integration branch holds this computer's
// team.json. The configured URL can carry a credential: it is never placed in a result, and every detail passes through redactGitMessage
// (Phase 60 D-34). This module never imports vscode and holds no people-facing words: only codes and redacted technical details.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { TeamFile } from '../domain/team/types';
import { networkEnv } from './enable';
import { classifyPush } from './gitTransport';
import { cleanRepoUrl } from './inviteBundle';
import { fetchIntegrationBranch, integrationRef, isAncestor } from './integrationSource';
import { NEUTRAL_IDENTITY_ENV, gitText, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { REMOTE_NAME_PATTERN, TEAM_FILE_REL, TeamFileError, canonicalTeamFile, parseTeamFile, serialiseTeamFile } from './teamFile';

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

export const SHARE_COMMIT_MESSAGE = 'chore(team): share the team setup';

export type SharePlan =
  | { kind: 'already' }
  | { kind: 'fast-forward'; commits: number }
  | { kind: 'setup-only' }
  | { kind: 'first-upload' }
  | { kind: 'blocked'; reason: 'not-reachable-by-teammates' | 'record-missing' | 'no-local-branch' | 'offline'; detail: string; home?: OnlineHome };

export type ShareResult =
  | { ok: true; how: 'already' | 'fast-forward' | 'setup-only' | 'first-upload' }
  | { ok: false; code: 'not-reachable-by-teammates' | 'record-missing' | 'no-local-branch' | 'offline' | 'rejected' | 'changed'; detail: string };

// At most this many unshared commits are checked one by one for a fast-forward; a longer run is shared with a setup-only commit instead.
const MAX_FAST_FORWARD_COMMITS = 100;
const COMMIT_TIMEOUT_MS = 120_000;

// A plan with what executing it needs: the online tip the plan was made against and the local branch commit.
type Planned =
  | { plan: Extract<SharePlan, { kind: 'already' | 'blocked' }> }
  | { plan: Extract<SharePlan, { kind: 'fast-forward' }>; local: string }
  | { plan: Extract<SharePlan, { kind: 'first-upload' }>; local: string }
  | { plan: Extract<SharePlan, { kind: 'setup-only' }>; tip: string; local: string | undefined; url: string };

function homeDetail(home: OnlineHome): string {
  if (home.kind === 'not-shareable') return home.reason;
  return home.kind === 'local-only' ? `The team remote "${home.remote}" is a folder on this computer.` : `This project has no remote named "${home.remote}".`;
}

async function localBranchCommit(projectRoot: string, branch: string, git: GitRunner): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const commit = gitText(result);
  return result.code === 0 && commit !== '' ? commit : undefined;
}

// The number of commits in tip..local when every one of them changes exactly team.json and nothing else; undefined otherwise.
async function teamFileOnlyCommits(projectRoot: string, tip: string, local: string, git: GitRunner): Promise<number | undefined> {
  const listed = await git(['rev-list', '--parents', `--max-count=${MAX_FAST_FORWARD_COMMITS + 1}`, `${tip}..${local}`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (listed.code !== 0) return undefined;
  const rows = gitText(listed).split('\n').filter((row) => row !== '');
  if (rows.length === 0 || rows.length > MAX_FAST_FORWARD_COMMITS) return undefined;
  for (const row of rows) {
    const [commit, ...parents] = row.split(' ');
    // A merge brings in a whole other line of work, so it is never part of a fast-forward share.
    if (commit === undefined || parents.length !== 1) return undefined;
    const changed = await git(['diff-tree', '--no-commit-id', '-r', '-z', '--name-only', commit], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
    if (changed.code !== 0) return undefined;
    const paths = changed.stdout.toString('utf8').split('\0').filter((entry) => entry !== '');
    if (paths.length !== 1 || paths[0] !== TEAM_FILE_REL) return undefined;
  }
  return rows.length;
}

async function plan(input: ShareInput): Promise<Planned> {
  const git = input.git ?? runGit;
  const { projectRoot, teamFile, branch } = input;
  const inspected = await inspectOnlineHome(input);
  switch (inspected.kind) {
    case 'home':
      return { plan: { kind: 'blocked', reason: 'not-reachable-by-teammates', detail: homeDetail(inspected.home), home: inspected.home } };
    case 'record-missing':
      return { plan: { kind: 'blocked', reason: 'record-missing', detail: `The team remote has no ${teamFile.coordination.ref}.` } };
    case 'offline':
      return { plan: { kind: 'blocked', reason: 'offline', detail: inspected.detail } };
    case 'branch-missing': {
      const local = await localBranchCommit(projectRoot, branch, git);
      if (local === undefined) {
        return { plan: { kind: 'blocked', reason: 'no-local-branch', detail: `Neither this computer nor the team remote has the integration branch ${branch}.` } };
      }
      return { plan: { kind: 'first-upload' }, local };
    }
    case 'fetched': {
      if (inspected.remote.kind === 'present' && inspected.remote.same) return { plan: { kind: 'already' } };
      const local = await localBranchCommit(projectRoot, branch, git);
      if (local !== undefined && (await isAncestor(projectRoot, inspected.tip, local, git)) === true) {
        const commits = await teamFileOnlyCommits(projectRoot, inspected.tip, local, git);
        const committed = commits === undefined ? undefined : await teamFileAt(projectRoot, local, teamFile, git);
        if (commits !== undefined && committed?.kind === 'present' && committed.same) return { plan: { kind: 'fast-forward', commits }, local };
      }
      const url = await configuredRemoteUrl(projectRoot, teamFile.coordination.remote, git);
      return { plan: { kind: 'setup-only' }, tip: inspected.tip, local, url };
    }
  }
}

// What sharing would do, from a fresh look at the online home. Nothing is pushed and no local branch, HEAD or index changes; only the
// private ref refs/near-ai/integration/<branch> is updated by the fetch.
export async function planShare(input: ShareInput): Promise<SharePlan> {
  return (await plan(input)).plan;
}

// The person's own identity when git can resolve one, otherwise the neutral NEAR AI identity, so a share never fails for want of a name.
async function commitIdentityEnv(projectRoot: string, git: GitRunner): Promise<Record<string, string>> {
  const author = await git(['var', 'GIT_AUTHOR_IDENT'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  const committer = await git(['var', 'GIT_COMMITTER_IDENT'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  return author.code === 0 && committer.code === 0 ? {} : { ...NEUTRAL_IDENTITY_ENV };
}

function mustOk(result: GitResult, what: string, url: string): GitResult {
  if (result.code !== 0) throw new Error(`${what} failed: ${scrub(failureText(result), url)}`);
  return result;
}

// One commit on the online tip that changes team.json only, built with plumbing and a temporary index inside the repository's git folder.
// When the local branch already holds a team.json equal to this computer's, its exact blob is reused, so a later merge or rebase of the
// online branch meets identical bytes and cannot conflict. Nothing here checks out, resets, merges, stashes or moves a local ref.
async function buildSetupOnlyCommit(input: ShareInput, tip: string, local: string | undefined, url: string): Promise<string> {
  const git = input.git ?? runGit;
  const { projectRoot, teamFile } = input;
  const gitDir = gitText(mustOk(await git(['rev-parse', '--absolute-git-dir'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS }), 'Finding the git folder', url));
  const indexFile = path.join(gitDir, `near-ai-share-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { ...(await commitIdentityEnv(projectRoot, git)), GIT_INDEX_FILE: indexFile };
  const run = (args: string[], what: string, extra: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> =>
    git(args, { cwd: projectRoot, env, timeoutMs: extra.timeoutMs ?? LOCAL_TIMEOUT_MS, ...(extra.input === undefined ? {} : { input: extra.input }) })
      .then((result) => mustOk(result, what, url));
  let commit = '';
  let failure: unknown;
  try {
    const committed = local === undefined ? undefined : await teamFileAt(projectRoot, local, teamFile, git);
    const blob = committed?.kind === 'present' && committed.same
      ? committed.blob
      : gitText(await run(['hash-object', '-w', '--stdin'], 'Writing the team file', { input: serialiseTeamFile(teamFile) }));
    await run(['read-tree', tip], 'Reading the online tree');
    await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${TEAM_FILE_REL}`], 'Staging the team file');
    const tree = gitText(await run(['write-tree'], 'Writing the tree'));
    commit = gitText(await run(['commit-tree', tree, '-p', tip, '-m', SHARE_COMMIT_MESSAGE], 'Writing the share commit', { timeoutMs: COMMIT_TIMEOUT_MS }));
  } catch (error) {
    failure = error;
  }
  try {
    await rm(indexFile, { force: true });
  } catch (error) {
    throw new Error('Removing the temporary share index failed.', { cause: failure ?? error });
  }
  if (failure !== undefined) throw failure;
  return commit;
}

type PushOutcomeKind = { kind: 'ok' } | { kind: 'changed' | 'rejected' | 'offline'; detail: string };

// The only push this module makes: <commit>:refs/heads/<integration branch>, no force of any kind. The result is read like the coordination
// transport reads it: a lost race is 'changed', a hook, protected branch or permission refusal is 'rejected', no answer is 'offline'.
async function pushToBranch(input: ShareInput, commit: string): Promise<PushOutcomeKind> {
  const git = input.git ?? runGit;
  const { projectRoot, teamFile, branch } = input;
  const remote = teamFile.coordination.remote;
  integrationRef(branch);
  const url = await configuredRemoteUrl(projectRoot, remote, git);
  const env = await networkEnv(projectRoot, git);
  const outcome = classifyPush(await git(['push', '--porcelain', remote, `${commit}:refs/heads/${branch}`], { cwd: projectRoot, env, timeoutMs: NETWORK_TIMEOUT_MS }));
  switch (outcome.kind) {
    case 'ok':
    case 'up-to-date':
      return { kind: 'ok' };
    case 'cas-lost':
      return { kind: 'changed', detail: scrub(outcome.detail, url) };
    case 'permanent':
      return { kind: 'rejected', detail: scrub(outcome.detail, url) };
    case 'offline':
      return { kind: 'offline', detail: scrub(outcome.detail, url) };
  }
}

const DEFAULT_SHARE_ATTEMPTS = 3;
const MAX_SHARE_ATTEMPTS = 10;

function messageOf(error: unknown): string {
  return redactGitMessage(error instanceof Error ? error.message : String(error));
}

// One plan and, when there is something to push, one push.
type Attempt = { done: ShareResult } | { lost: string };

async function attemptShare(input: ShareInput & { plan?: SharePlan }): Promise<Attempt> {
  let planned: Planned;
  try {
    planned = await plan(input);
  } catch (error) {
    return { done: { ok: false, code: 'offline', detail: messageOf(error) } };
  }
  const current = planned.plan;
  if (current.kind === 'already') return { done: { ok: true, how: 'already' } };
  if (current.kind === 'blocked') return { done: { ok: false, code: current.reason, detail: current.detail } };
  if (current.kind === 'first-upload' && input.plan?.kind !== 'first-upload') {
    return { done: { ok: false, code: 'changed', detail: `The team remote has no ${input.branch} branch yet, so sharing would upload the whole branch.` } };
  }
  let commit: string;
  try {
    if ('tip' in planned) commit = await buildSetupOnlyCommit(input, planned.tip, planned.local, planned.url);
    else if ('local' in planned) commit = planned.local;
    else throw new Error('Nothing to push was planned.');
  } catch (error) {
    return { done: { ok: false, code: 'rejected', detail: messageOf(error) } };
  }
  let pushed: PushOutcomeKind;
  try {
    pushed = await pushToBranch(input, commit);
  } catch (error) {
    return { done: { ok: false, code: 'offline', detail: messageOf(error) } };
  }
  if (pushed.kind === 'ok') return { done: { ok: true, how: current.kind } };
  if (pushed.kind === 'changed') return { lost: pushed.detail };
  return { done: { ok: false, code: pushed.kind, detail: pushed.detail } };
}

// Shares the team setup by the narrowest change (D-03 and D-20 as amended 2026-11-03: the caller asks once, and only team.json is shared).
// Every attempt plans afresh from a new fetch, so a push that lost a race with a teammate is re-planned on top of their commit, up to
// `attempts` pushes (3 by default). A first upload sends the whole local branch, so it happens only when the caller passes the first-upload
// plan the person agreed to; otherwise that case returns 'changed' so the caller can ask.
export async function shareTeamSetup(input: ShareInput & { plan?: SharePlan; attempts?: number }): Promise<ShareResult> {
  const requested = input.attempts ?? DEFAULT_SHARE_ATTEMPTS;
  const attempts = Number.isFinite(requested) ? Math.min(MAX_SHARE_ATTEMPTS, Math.max(1, Math.floor(requested))) : DEFAULT_SHARE_ATTEMPTS;
  let lost = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await attemptShare(input);
    if ('done' in outcome) return outcome.done;
    lost = outcome.lost;
  }
  return { ok: false, code: 'changed', detail: `The team remote changed during each of ${attempts} attempts to share: ${lost}` };
}
