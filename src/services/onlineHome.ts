// "Give this project an online home" (D-14, SYNC-09): on the person's click, git init when the folder is not a repository, sign in to GitHub, ask
// public or private (every time, nothing preselected), create the repository under their account, add it as the project's remote, then hand over to the
// turn-on flow that pushes the encrypted sync branch. Each step is saved without any token, so an interrupted setup resumes and never creates a second
// repository. The GitHub token is only ever held in memory: it reaches the GitHub API as an Authorization header and git only through the child
// process environment, never in arguments, files, settings, logs or messages. No vscode here: the editor-facing parts are in onlineHomeVscode.ts, so
// tests run on plain node with fakes for GitHub, sign-in and gh.
import { mkdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { redactSecrets } from '../domain/redaction';
import { ONLINE_HOME_STEPS, VISIBILITY_NOTES, expectedCloneUrl, repoNameFromFolder, validateLogin, validateRepoName } from '../domain/state/onlineHome';
import type { OnlineHomeMethod, OnlineHomeProgress, OnlineHomeRepo, OnlineHomeStep, Visibility } from '../domain/state/onlineHome';
import { createUserRepo } from './githubApi';
import type { FetchLike } from './githubApi';
import { GitNotFoundError, gitText, redactGitMessage, runStateGit } from './stateGit';
import type { GitRunner } from './stateGit';
import { stateHomeFor, writeFileAtomic } from './stateHome';
import type { ProjectStateHome } from './stateHome';

const PROGRESS_FILE = 'online-home.json';

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
  /** Called when the flow is over, so a progress display can close. */
  done?(): void;
}

/** What the turn-on flow gets once the remote exists: the remote's name and address, and a git runner that signs in to GitHub for this call only. */
export interface OnlineHomeRemote { name: string; url: string; git: GitRunner }

export interface OnlineHomeInput {
  root: string;
  home?: ProjectStateHome;
  ui: OnlineHomeUi;
  auth: GitHubAuth;
  fetchFn?: FetchLike;
  /** The runner for every git call except the person's own code push. Defaults to the sync runner. */
  git?: GitRunner;
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
    env: { ...options.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header }
  });
}

function progressFile(home: ProjectStateHome): string {
  return path.join(home.paths.sync, PROGRESS_FILE);
}

const METHODS: readonly OnlineHomeMethod[] = ['vscode', 'gh', 'url'];

function parseRepo(value: unknown): OnlineHomeRepo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const repo = value as Record<string, unknown>;
  if (typeof repo.owner !== 'string' || typeof repo.name !== 'string' || typeof repo.url !== 'string') return undefined;
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
  const repo = parseRepo(record.repo);
  return repo ? { step, method, repo, startedAt: record.startedAt } : undefined;
}

/** Saves the setup so far. Only these four fields are written; nothing here can hold a token. */
export async function writeProgress(home: ProjectStateHome, progress: OnlineHomeProgress): Promise<void> {
  await mkdir(home.paths.sync, { recursive: true, mode: 0o700 });
  const record: OnlineHomeProgress = { step: progress.step, method: progress.method, startedAt: progress.startedAt };
  if (progress.repo) record.repo = { owner: progress.repo.owner, name: progress.repo.name, url: progress.repo.url, visibility: progress.repo.visibility };
  await writeFileAtomic(progressFile(home), `${JSON.stringify(record, null, 2)}\n`);
}

const NOT_ALLOWED = 'GitHub did not allow creating the repository. Sign in again and allow repository access.';
const NO_GIT = 'Git is not installed, so an online home cannot be set up. Everything still works on this computer.';

function clean(text: string): string {
  return redactSecrets(redactGitMessage(text));
}

async function sameFolder(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([realpath(a).catch(() => path.resolve(a)), realpath(b).catch(() => path.resolve(b))]);
  return first === second;
}

/** The project's remote names; a name that does not exist yet is chosen for the new one. */
async function remoteNames(git: GitRunner, root: string): Promise<string[]> {
  const listed = await git(['-C', root, 'remote']);
  return listed.code === 0 ? gitText(listed).split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
}

export async function onlineHomeFlow(input: OnlineHomeInput): Promise<OnlineHomeResult> {
  const { ui, root } = input;
  const base = input.git ?? runStateGit;
  const say = (text: string): void => ui.progress(clean(text));
  const tell = (text: string): void => ui.message(clean(text));
  try {
    if (!(await ui.confirmStart())) return { status: 'declined' };
    const home = input.home ?? stateHomeFor(root);
    await home.ensure();
    const saved = await readProgress(home);
    const startedAt = saved?.startedAt ?? new Date().toISOString();
    const method: OnlineHomeMethod = 'vscode';
    let repo: OnlineHomeRepo | undefined = saved?.repo;
    const save = async (step: OnlineHomeStep): Promise<void> => {
      await writeProgress(home, { step, method, repo, startedAt });
      await input.onStep?.(step);
    };

    // 1. A repository of its own.
    const top = await base(['-C', root, 'rev-parse', '--show-toplevel']);
    const isRepo = top.code === 0 && await sameFolder(gitText(top), root);
    if (!isRepo) {
      say('Setting up git in this folder…');
      const made = await base(['-C', root, 'init', '-q']);
      if (made.code !== 0) { tell('Git could not set up this folder. Nothing was created on GitHub.'); return { status: 'failed', message: 'Git could not set up this folder.' }; }
      await save('init');
    }

    // 2. Sign in, ask public or private, create the repository.
    say('Signing in to GitHub…');
    const token = await input.auth.token();
    if (token === undefined) { tell(NOT_ALLOWED); return { status: 'cancelled', message: NOT_ALLOWED }; }
    await save('signin');
    const visibility = await ui.pickVisibility(VISIBILITY_NOTES);
    if (visibility === undefined) return { status: 'cancelled', message: 'Nothing was created on GitHub.' };
    await save('visibility');
    const name = (await ui.askName(repoNameFromFolder(path.basename(root))))?.trim();
    if (name === undefined || !validateRepoName(name)) return { status: 'cancelled', message: 'Nothing was created on GitHub.' };
    say(`Creating your ${visibility} repository "${name}" on GitHub…`);
    const created = await createUserRepo(token, { name, private: visibility === 'private' }, input.fetchFn);
    repo = { owner: created.owner, name: created.name, url: created.url, visibility: created.visibility };
    await save('create');

    // 3. Add it as the project's remote.
    say('Adding it to this project…');
    const taken = await remoteNames(base, root);
    const remoteName = taken.includes('origin') ? 'near-ai-home' : 'origin';
    const added = await base(['-C', root, 'remote', 'add', remoteName, repo.url]);
    if (added.code !== 0) { tell('Git could not add the online repository to this project. Run the setup again to retry.'); return { status: 'failed', message: 'Git could not add the online repository.' }; }
    await save('remote');

    // 4. The turn-on flow pushes the encrypted sync branch.
    say('Saving your encrypted project state there…');
    const finished = await input.afterRemote({ name: remoteName, url: repo.url, git: withGitHubAuth(base, token) });
    if (finished === false) return { status: 'sync-incomplete', remote: { name: remoteName, url: repo.url }, message: 'The online repository is set up, but syncing is not turned on yet.' };
    await save('sync');
    await save('done');
    return { status: 'done', remote: { name: remoteName, url: repo.url } };
  } catch (error) {
    if (error instanceof GitNotFoundError) { tell(NO_GIT); return { status: 'failed', message: NO_GIT }; }
    throw error;
  } finally {
    ui.done?.();
  }
}
