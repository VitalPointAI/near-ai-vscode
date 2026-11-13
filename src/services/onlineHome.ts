// "Give this project an online home" (D-14, SYNC-09): on the person's click, git init when the folder is not a repository, sign in to GitHub, ask
// public or private (every time, nothing preselected), create the repository under their account, add it as the project's remote, then hand over to the
// turn-on flow that pushes the encrypted sync branch. Each step is saved without any token, so an interrupted setup resumes and never creates a second
// repository. The GitHub token is only ever held in memory: it reaches the GitHub API as an Authorization header and git only through the child
// process environment, never in arguments, files, settings, logs or messages. No vscode here: the editor-facing parts are in onlineHomeVscode.ts, so
// tests run on plain node with fakes for GitHub, sign-in and gh.
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { redactSecrets } from '../domain/redaction';
import { GITHUB_MESSAGES, ONLINE_HOME_STEPS, VISIBILITY_NOTES, expectedCloneUrl, nextOnlineHomeStep, repoNameFromFolder, validateLogin, validateRepoName } from '../domain/state/onlineHome';
import type { GitHubErrorKind, OnlineHomeMethod, OnlineHomeProgress, OnlineHomeRepo, OnlineHomeStep, Visibility } from '../domain/state/onlineHome';
import { GitHubApiError, createUserRepo, getRepo, isSafeBranchName, setDefaultBranch } from './githubApi';
import type { FetchLike } from './githubApi';
import { GitNotFoundError, addGitConfigEnv, gitText, redactGitMessage, runStateGit } from './stateGit';
import type { GitRunner } from './stateGit';
import { stateHomeFor, writeFileAtomic } from './stateHome';
import type { ProjectStateHome } from './stateHome';
import { STATE_REF, classifyGitFailure, validateRemote } from './stateTransport';
import { pushProjectCode, runPersonGit } from './codePushCheck';
import type { CodePushUi } from './codePushCheck';

const PROGRESS_FILE = 'online-home.json';

/** The sync branch's own name, taken from the one place that defines its ref. It is the only default branch this flow ever moves away from. */
const STATE_BRANCH = STATE_REF.replace(/^refs\/heads\//, '');

/** VS Code's GitHub sign-in, or whatever stands in for it. The token is returned to the flow and kept in memory only. */
export interface GitHubAuth {
  available(): Promise<boolean>;
  token(): Promise<string | undefined>;
}

/** Everything the flow asks the person. Each question is a click or a typed answer; `undefined` means they walked away. */
export interface OnlineHomeUi {
  confirmStart(): Promise<boolean>;
  /** One plain sentence about the step that is starting. */
  progress(message: string): void;
  /** One plain sentence about a problem or a result. */
  message(text: string): void;
  /** Asked every time, with the notes for both and nothing preselected. */
  pickVisibility(notes: Readonly<Record<Visibility, string>>): Promise<Visibility | undefined>;
  /** `problem` is the reason the last name did not work. */
  askName(suggested: string, problem?: string): Promise<string | undefined>;
  /** Offered when GitHub sign-in is not available in this editor and gh is installed and signed in: 'gh' or 'url' (paste an empty repository's address). */
  pickFallback(choices: { gh: boolean }): Promise<'gh' | 'url' | undefined>;
  /** The address of an existing, empty repository. `problem` is the reason the last one did not work. */
  askRepoUrl(problem?: string): Promise<string | undefined>;
  /** The separate offer to put the person's own code online. Without it the flow never offers. */
  codePush?: CodePushOffer;
  /** Called when the flow is over, so a progress display can close. */
  done?(): void;
}

/** The code-push questions plus the first one: whether to look at pushing the code at all. Declining leaves sync working. */
export interface CodePushOffer extends CodePushUi {
  offer(): Promise<boolean>;
}

/** The GitHub command line, when it is installed and signed in. `token` is the one `gh auth token` prints, held in memory only. */
export interface GhCli {
  available(): Promise<boolean>;
  signedIn(): Promise<boolean>;
  /** Creates an empty repository under the signed-in account (never with a source or a push). Throws GitHubApiError. */
  createRepo(name: string, visibility: Visibility): Promise<{ owner: string; name: string }>;
  token(): Promise<string | undefined>;
}

export type GhExec = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What the turn-on flow gets once the remote exists: the remote's name and address, and a git runner that signs in to GitHub for this call only. */
export interface OnlineHomeRemote { name: string; url: string; git: GitRunner }

export interface OnlineHomeInput {
  root: string;
  home?: ProjectStateHome;
  ui: OnlineHomeUi;
  auth: GitHubAuth;
  fetchFn?: FetchLike;
  /** The GitHub command line, used when GitHub sign-in is not available in this editor. */
  gh?: GhCli;
  /** The runner for every git call except the person's own code push. Defaults to the sync runner. */
  git?: GitRunner;
  /** The runner for the person's own code push (their hooks and git settings apply). Defaults to a plain git runner. */
  personGit?: GitRunner;
  /** The plan-15 turn-on flow: shows the recovery code and pushes the sync branch. Return false when it did not finish. */
  afterRemote: (remote: OnlineHomeRemote) => Promise<boolean | void>;
  /** Called after each step's progress is saved. Tests use it to stop the setup part way. */
  onStep?: (step: OnlineHomeStep) => void | Promise<void>;
}

export type OnlineHomeStatus = 'declined' | 'cancelled' | 'failed' | 'sync-incomplete' | 'done';
export interface OnlineHomeResult {
  status: OnlineHomeStatus;
  /** Plain words for the person when the setup stopped. */
  message?: string;
  remote?: { name: string; url: string };
}

/**
 * A runner that signs in to github.com for each call: git reads an extra HTTP header from its own environment. The token is in the child's
 * environment only; the arguments are never changed and nothing is written to any git config file.
 */
export function withGitHubAuth(runner: GitRunner, token: string): GitRunner {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return (args, options = {}) => runner(args, {
    ...options,
    env: addGitConfigEnv(options.env, 'http.https://github.com/.extraheader', header)
  });
}

const GH_TIMEOUT_MS = 30_000;

const defaultGhExec: GhExec = (args, timeoutMs = GH_TIMEOUT_MS) => new Promise((resolve) => {
  execFile('gh', args, {
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as unknown as { code: number }).code : 127;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

function ghErrorKind(stderr: string): GitHubErrorKind {
  if (/already exists/i.test(stderr)) return 'name-taken';
  if (/\b40[13]\b|not logged in|not authenticated|not accessible|permission|scope|SAML/i.test(stderr)) return 'permission';
  if (/could not resolve host|no such host|network|timed? ?out|connection (?:refused|reset)|dial tcp/i.test(stderr)) return 'offline';
  return 'other';
}

/**
 * gh run with array arguments, a timeout and prompts switched off. The repository is made with `gh repo create <name> --private|--public` and nothing
 * else: no source, no push, no clone. The token comes from `gh auth token` into memory only, and is used for git exactly like the VS Code one.
 */
export function systemGhCli(exec: GhExec = defaultGhExec): GhCli {
  return {
    available: async () => (await exec(['--version'])).code === 0,
    signedIn: async () => (await exec(['auth', 'status'])).code === 0,
    token: async () => {
      const printed = await exec(['auth', 'token']);
      const value = printed.stdout.trim();
      return printed.code === 0 && value !== '' ? value : undefined;
    },
    createRepo: async (name, visibility) => {
      if (!validateRepoName(name)) throw new GitHubApiError('other');
      const made = await exec(['repo', 'create', name, visibility === 'private' ? '--private' : '--public']);
      if (made.code !== 0) throw new GitHubApiError(ghErrorKind(made.stderr));
      const match = /https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\s|$)/.exec(made.stdout);
      let owner = match?.[1];
      if (owner === undefined || match?.[2]?.toLowerCase() !== name.toLowerCase()) {
        const login = await exec(['api', 'user', '--jq', '.login']);
        owner = login.code === 0 ? login.stdout.trim() : undefined;
      }
      if (owner === undefined || !validateLogin(owner)) throw new GitHubApiError('other');
      return { owner, name };
    }
  };
}

function progressFile(home: ProjectStateHome): string {
  return path.join(home.paths.sync, PROGRESS_FILE);
}

const METHODS: readonly OnlineHomeMethod[] = ['vscode', 'gh', 'url'];

function parseRepo(value: unknown, method: OnlineHomeMethod): OnlineHomeRepo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const repo = value as Record<string, unknown>;
  if (typeof repo.owner !== 'string' || typeof repo.name !== 'string' || typeof repo.url !== 'string') return undefined;
  if (method === 'url') {
    // A pasted address: only what the paste check would accept, and nothing it says about the repository is trusted.
    if (repo.visibility !== 'unknown' || repo.owner.length > 39 || repo.name.length > 100 || pastedAddressProblem(repo.url) !== undefined) return undefined;
    return { owner: repo.owner, name: repo.name, url: repo.url, visibility: 'unknown' };
  }
  if (repo.visibility !== 'public' && repo.visibility !== 'private') return undefined;
  if (!validateLogin(repo.owner) || !validateRepoName(repo.name) || repo.url !== expectedCloneUrl(repo.owner, repo.name)) return undefined;
  return { owner: repo.owner, name: repo.name, url: repo.url, visibility: repo.visibility };
}

/** The saved setup, or undefined when there is none or it is not exactly what this flow writes (a file in a cloned project is not trusted). */
export async function readProgress(home: ProjectStateHome): Promise<OnlineHomeProgress | undefined> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(progressFile(home), 'utf8')); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const step = ONLINE_HOME_STEPS.find((candidate) => candidate === record.step);
  const method = METHODS.find((candidate) => candidate === record.method);
  if (!step || !method || typeof record.startedAt !== 'string' || record.startedAt.length > 40) return undefined;
  if (record.repo === undefined) return { step, method, startedAt: record.startedAt };
  const repo = parseRepo(record.repo, method);
  return repo ? { step, method, repo, startedAt: record.startedAt } : undefined;
}

/** Saves the setup so far. Only these four fields are written; nothing here can hold a token. */
export async function writeProgress(home: ProjectStateHome, progress: OnlineHomeProgress): Promise<void> {
  await mkdir(home.paths.sync, { recursive: true, mode: 0o700 });
  const record: OnlineHomeProgress = { step: progress.step, method: progress.method, startedAt: progress.startedAt };
  if (progress.repo) record.repo = { owner: progress.repo.owner, name: progress.repo.name, url: progress.repo.url, visibility: progress.repo.visibility };
  await writeFileAtomic(progressFile(home), `${JSON.stringify(record, null, 2)}\n`);
}

const NOT_ALLOWED = GITHUB_MESSAGES.permission;
const NOT_AVAILABLE = 'GitHub sign-in is not available in this editor.';
const NO_GIT = 'Git is not installed, so an online home cannot be set up. Everything still works on this computer.';
const NESTED = "This folder is inside another git repository, so it cannot get its own online home here. Open that repository's folder instead.";
const NOT_EMPTY = 'That repository is not empty. Paste the address of a new, empty repository.';
const BAD_ADDRESS = 'That address cannot be used. Paste the address of a repository, for example https://github.com/you/project.git.';
const HAS_SECRET = 'Paste the address without a password or token in it.';
const BAD_NAME = 'That name cannot be used. Use letters, numbers, dots, dashes and underscores.';
const NOTHING_CREATED = 'Nothing was created on GitHub.';
const MAX_TRIES = 5;

function clean(text: string): string {
  return redactSecrets(redactGitMessage(text));
}

/** Why a pasted address cannot be used, or undefined when it can. A password or token in the address would end up in the project's git settings. */
function pastedAddressProblem(value: string): string | undefined {
  const checked = validateRemote(value, []);
  if (!('kind' in checked) || checked.kind !== 'url') return BAD_ADDRESS;
  if (/^(?:https|ssh):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.password !== '' || (parsed.protocol === 'https:' && parsed.username !== '')) return HAS_SECRET;
    } catch {
      return BAD_ADDRESS;
    }
  }
  return undefined;
}

/** The sentence told when GitHub did not move the default branch. It speaks of the default branch, not of creating a repository. */
function defaultBranchFailure(branch: string): string {
  return `Your code is online, but GitHub did not change the default branch, so ${STATE_BRANCH} is still shown first. Choose ${branch} as the default branch in the repository's settings on GitHub.`;
}

/**
 * After the person's code is pushed: when the repository's default branch is still the sync branch (GitHub makes the first branch pushed the default),
 * make `to` the default with one PATCH. Nothing else can move: there is no parameter that names another branch to move away from, so a default the
 * person chose is never changed. A refused, offline or unreadable answer is 'failed' with one plain sentence, never an exception.
 */
export async function moveDefaultBranch(input: { token: string; owner: string; name: string; to: string; fetchFn?: FetchLike }): Promise<{ result: 'moved' | 'unchanged' | 'failed'; message?: string }> {
  try {
    const repo = await getRepo(input.token, input.owner, input.name, input.fetchFn);
    if (repo === undefined) return { result: 'failed', message: defaultBranchFailure(input.to) };
    if (repo.defaultBranch !== STATE_BRANCH || input.to === STATE_BRANCH) return { result: 'unchanged' };
    await setDefaultBranch(input.token, input.owner, input.name, input.to, input.fetchFn);
    return { result: 'moved', message: `Your code is online, and ${input.to} is now the repository's default branch on GitHub.` };
  } catch (error) {
    if (error instanceof GitHubApiError) return { result: 'failed', message: defaultBranchFailure(input.to) };
    throw error;
  }
}

/**
 * The sentence to tell after a pushed code result, or undefined when there is nothing to say. `git` is the runner the code push used, so the branch
 * is read from the same repository.
 */
export async function defaultBranchAfterPush(input: { root: string; remote: string; git: GitRunner; token?: string; owner?: string; name?: string; fetchFn?: FetchLike }): Promise<string | undefined> {
  const read = await input.git(['-C', input.root, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = read.code === 0 ? gitText(read) : '';
  if (!isSafeBranchName(branch)) return undefined;
  if (input.token !== undefined && input.owner !== undefined && input.owner !== '' && input.name !== undefined && input.name !== '') {
    const moved = await moveDefaultBranch({ token: input.token, owner: input.owner, name: input.name, to: branch, fetchFn: input.fetchFn });
    return moved.result === 'unchanged' ? undefined : moved.message;
  }
  return undefined;
}

async function sameFolder(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([realpath(a).catch(() => path.resolve(a)), realpath(b).catch(() => path.resolve(b))]);
  return first === second;
}

/** 'repo' when the folder is a repository of its own, 'nested' when it sits inside someone else's, 'none' when there is no repository. */
async function inspectFolder(git: GitRunner, root: string): Promise<'repo' | 'nested' | 'none'> {
  const top = await git(['-C', root, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) return 'none';
  return await sameFolder(gitText(top), root) ? 'repo' : 'nested';
}

/** The project's remotes and their addresses exactly as written in its own git settings (a rewrite rule is not applied). */
async function remoteEntries(git: GitRunner, root: string): Promise<Array<{ name: string; url: string }>> {
  const listed = await git(['-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$']);
  if (listed.code !== 0) return [];
  const entries: Array<{ name: string; url: string }> = [];
  for (const line of gitText(listed).split('\n')) {
    const match = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
    if (match) entries.push({ name: match[1] as string, url: match[2] as string });
  }
  return entries;
}

type Fresh = { repo: OnlineHomeRepo; method: OnlineHomeMethod; token?: string };

export async function onlineHomeFlow(input: OnlineHomeInput): Promise<OnlineHomeResult> {
  const { ui, root } = input;
  const base = input.git ?? runStateGit;
  const say = (text: string): void => ui.progress(clean(text));
  const tell = (text: string): void => ui.message(clean(text));
  const stop = (status: 'cancelled' | 'failed', message: string): OnlineHomeResult => { tell(message); return { status, message: clean(message) }; };
  try {
    if (!(await ui.confirmStart())) return { status: 'declined' };
    const home = input.home ?? stateHomeFor(root);
    await home.ensure();
    const saved = await readProgress(home);
    const startedAt = saved?.startedAt ?? new Date().toISOString();
    let method: OnlineHomeMethod = saved?.method ?? 'vscode';
    let repo: OnlineHomeRepo | undefined = saved?.repo;
    let token: string | undefined;
    const save = async (step: OnlineHomeStep): Promise<void> => {
      await writeProgress(home, { step, method, repo, startedAt });
      await input.onStep?.(step);
    };

    // A repository of its own.
    const folder = await inspectFolder(base, root);
    if (folder === 'nested') return stop('failed', NESTED);
    if (folder === 'none') {
      say('Setting up git in this folder…');
      const made = await base(['-C', root, 'init', '-q']);
      if (made.code !== 0) return stop('failed', 'Git could not set up this folder. Nothing was created on GitHub.');
      await save('init');
    }

    // A saved setup: is its repository still there, and is it already a remote?
    let repoExists = false;
    if (repo) {
      if (method === 'url') repoExists = true;
      else {
        token = method === 'gh' ? await input.gh?.token() : await input.auth.available() ? await input.auth.token() : undefined;
        if (token === undefined) repoExists = true;
        else {
          try { repoExists = (await getRepo(token, repo.owner, repo.name, input.fetchFn)) !== undefined; } catch (error) {
            if (error instanceof GitHubApiError) return stop('failed', error.message);
            throw error;
          }
        }
      }
    }
    const hasRemote = repo !== undefined && (await remoteEntries(base, root)).some((entry) => entry.url === repo?.url);
    const step = nextOnlineHomeStep(saved, { isRepo: true, hasRemote, repoExists });
    if (step === 'done' && repo) {
      tell('This project already has an online home.');
      return { status: 'done', remote: { name: (await remoteEntries(base, root)).find((entry) => entry.url === repo?.url)?.name ?? 'origin', url: repo.url } };
    }

    // Sign in, ask public or private (or take a pasted address), create the repository.
    if (step === 'init' || step === 'signin' || step === 'visibility' || step === 'create') {
      repo = undefined;
      const fresh = await createFresh();
      if ('status' in fresh) return fresh;
      repo = fresh.repo;
      method = fresh.method;
      token = fresh.token;
      await save('create');
    }
    const current = repo as OnlineHomeRepo;

    // Add it as the project's remote.
    let entry = (await remoteEntries(base, root)).find((candidate) => candidate.url === current.url);
    if (!entry) {
      say('Adding it to this project…');
      const taken = (await remoteEntries(base, root)).map((candidate) => candidate.name);
      const name = ['origin', 'near-ai-home'].find((candidate) => !taken.includes(candidate));
      if (name === undefined) return stop('failed', 'This project already has remotes named origin and near-ai-home, so the online repository was not added. Remove one and run the setup again.');
      const added = await base(['-C', root, 'remote', 'add', name, current.url]);
      if (added.code !== 0) return stop('failed', 'Git could not add the online repository to this project. Run the setup again to retry.');
      entry = { name, url: current.url };
      await save('remote');
    }
    const remote = { name: entry.name, url: current.url };

    // The turn-on flow pushes the encrypted sync branch.
    if (step !== 'offer-code') {
      say('Saving your encrypted project state there…');
      const finished = await input.afterRemote({ name: remote.name, url: remote.url, git: token === undefined ? base : withGitHubAuth(base, token) });
      if (finished === false) return { status: 'sync-incomplete', remote, message: 'The online repository is set up, but syncing is not turned on yet.' };
      await save('sync');
    }

    // Only now, and as its own question: the person's own code. Declining leaves sync working.
    if (ui.codePush && await ui.codePush.offer()) {
      say('Checking which files would go up…');
      const personGit = input.personGit ?? runPersonGit;
      const codeGit = token === undefined ? personGit : withGitHubAuth(personGit, token);
      const pushed = await pushProjectCode(root, remote.name, codeGit, { ui: ui.codePush, visibility: current.visibility });
      tell(pushed.message);
      // The default branch is looked at only after the person's own code reached the repository, never before and never for any other outcome.
      if (pushed.status === 'pushed') {
        const sentence = await defaultBranchAfterPush({ root, remote: remote.name, git: codeGit, token, owner: current.owner, name: current.name, fetchFn: input.fetchFn });
        if (sentence !== undefined) tell(sentence);
      }
    }
    await save('offer-code');
    await save('done');
    return { status: 'done', remote };

    async function createFresh(): Promise<Fresh | OnlineHomeResult> {
      let chosen: OnlineHomeMethod;
      let secret: string | undefined;
      if (await input.auth.available()) {
        chosen = 'vscode';
        say('Signing in to GitHub…');
        secret = await input.auth.token();
        if (secret === undefined) return stop('cancelled', NOT_ALLOWED);
      } else {
        tell(NOT_AVAILABLE);
        const ghReady = input.gh !== undefined && await input.gh.available() && await input.gh.signedIn();
        const choice = ghReady ? await ui.pickFallback({ gh: true }) : 'url';
        if (choice === undefined) return { status: 'cancelled', message: NOTHING_CREATED };
        chosen = choice;
        if (choice === 'gh') {
          secret = await input.gh?.token();
          if (secret === undefined) return stop('failed', NOT_ALLOWED);
        }
      }
      method = chosen;
      repo = undefined;
      await save('signin');
      return chosen === 'url' ? pasteAddress() : createRepository(chosen, secret as string);
    }

    async function createRepository(chosen: 'vscode' | 'gh', secret: string): Promise<Fresh | OnlineHomeResult> {
      const visibility = await ui.pickVisibility(VISIBILITY_NOTES);
      if (visibility === undefined) return { status: 'cancelled', message: NOTHING_CREATED };
      await save('visibility');
      let suggested = repoNameFromFolder(path.basename(root));
      let problem: string | undefined;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const answer = (await ui.askName(suggested, problem))?.trim();
        if (answer === undefined) return { status: 'cancelled', message: NOTHING_CREATED };
        if (!validateRepoName(answer)) { problem = BAD_NAME; suggested = repoNameFromFolder(answer); continue; }
        say(`Creating your ${visibility} repository "${answer}" on GitHub…`);
        try {
          const made = chosen === 'gh' && input.gh
            ? await input.gh.createRepo(answer, visibility)
            : await createUserRepo(secret, { name: answer, private: visibility === 'private' }, input.fetchFn);
          if (!validateLogin(made.owner) || !validateRepoName(made.name)) return stop('failed', GITHUB_MESSAGES.other);
          return { repo: { owner: made.owner, name: made.name, url: expectedCloneUrl(made.owner, made.name), visibility }, method: chosen, token: secret };
        } catch (error) {
          if (!(error instanceof GitHubApiError)) throw error;
          if (error.kind !== 'name-taken') return stop('failed', error.message);
          problem = error.message;
          suggested = answer;
        }
      }
      return stop('cancelled', `${NOTHING_CREATED} Try again with a different name.`);
    }

    async function pasteAddress(): Promise<Fresh | OnlineHomeResult> {
      let problem: string | undefined;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const pasted = (await ui.askRepoUrl(problem))?.trim();
        if (pasted === undefined) return { status: 'cancelled', message: 'Nothing was changed.' };
        problem = pastedAddressProblem(pasted);
        if (problem !== undefined) continue;
        // The repository must be empty: its sync branch is the first thing in it, and nothing of someone else's is mixed in.
        const listed = await base(['-C', root, 'ls-remote', pasted]);
        if (listed.code !== 0) { problem = classifyGitFailure(listed).message; continue; }
        if (gitText(listed) !== '') { problem = NOT_EMPTY; continue; }
        const named = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(pasted);
        return { repo: { owner: named?.[1] ?? '', name: named?.[2] ?? '', url: pasted, visibility: 'unknown' }, method: 'url' };
      }
      return stop('cancelled', 'Nothing was changed. Try again with the address of a new, empty repository.');
    }
  } catch (error) {
    if (error instanceof GitNotFoundError) return stop('failed', NO_GIT);
    throw error;
  } finally {
    ui.done?.();
  }
}
