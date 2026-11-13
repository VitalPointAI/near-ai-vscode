// Pure rules for "Give this project an online home" (D-14): repository names, the plain notes for public and private, the saved setup progress, which
// step comes next after an interruption, and how a GitHub answer is sorted into one plain sentence. No vscode, no network, no files.

export type Visibility = 'public' | 'private';

/** Shown next to the choice, every time. Neither is preselected (D-14). */
export const VISIBILITY_NOTES: Readonly<Record<Visibility, string>> = {
  private: "Private: only you and people you invite can see it. GitHub's free plan limits some features for private repositories.",
  public: "Public: anyone can see this project's code. Your NEAR AI chats, keys and other state stay encrypted and unreadable to others."
};

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A repository name suggested from the folder's name: anything GitHub would not accept becomes '-'. */
export function repoNameFromFolder(folderName: string): string {
  const cleaned = folderName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '').replace(/\.git$/i, '').slice(0, 100).replace(/[-.]+$/, '');
  return validateRepoName(cleaned) ? cleaned : 'project';
}

/** Letters, digits, '.', '-' and '_' only, up to 100 characters; not '.' or '..' and not ending in '.git'. */
export function validateRepoName(name: string): boolean {
  return REPO_NAME.test(name) && name !== '.' && name !== '..' && !/\.git$/i.test(name);
}

/** A GitHub account name: letters, digits and single hyphens inside, up to 39 characters. */
export function validateLogin(login: string): boolean {
  return LOGIN.test(login);
}

/** The only address a created repository may have. The flow accepts nothing else from the API or from gh. */
export function expectedCloneUrl(login: string, name: string): string {
  return `https://github.com/${login}/${name}.git`;
}

export type OnlineHomeStep = 'init' | 'signin' | 'visibility' | 'create' | 'remote' | 'sync' | 'offer-code' | 'done';
export const ONLINE_HOME_STEPS: readonly OnlineHomeStep[] = ['init', 'signin', 'visibility', 'create', 'remote', 'sync', 'offer-code', 'done'];
export type OnlineHomeMethod = 'vscode' | 'gh' | 'url';

export interface OnlineHomeRepo {
  owner: string;
  name: string;
  url: string;
  /** A pasted address says nothing about it, so it is 'unknown'. */
  visibility: Visibility | 'unknown';
}

/** What is saved between steps. It never holds a token: nothing here comes from a credential. */
export interface OnlineHomeProgress {
  step: OnlineHomeStep;
  method: OnlineHomeMethod;
  repo?: OnlineHomeRepo;
  startedAt: string;
}

export interface OnlineHomeFacts {
  /** The project folder is a git repository of its own. */
  isRepo: boolean;
  /** The saved repository's address is already a remote of the project. */
  hasRemote: boolean;
  /** GitHub still has the saved repository. Not asked for a pasted address. */
  repoExists: boolean;
}

/**
 * Where a setup carries on, given the last step it finished. A saved repository that still exists is never created again: the next step is adding it as a remote, then the sync
 * branch. Without a saved repository (or when GitHub no longer has it) the person starts again at signing in, and is asked public or private again.
 */
export function nextOnlineHomeStep(progress: OnlineHomeProgress | undefined, facts: OnlineHomeFacts): OnlineHomeStep {
  if (!facts.isRepo) return 'init';
  if (!progress?.repo || !facts.repoExists) return 'signin';
  if (!facts.hasRemote) return 'remote';
  // `step` is the last one finished: once the sync branch is pushed, the turn-on flow is not run a second time.
  if (progress.step === 'done') return 'done';
  return progress.step === 'sync' || progress.step === 'offer-code' ? 'offer-code' : 'sync';
}

export type GitHubErrorKind = 'name-taken' | 'permission' | 'offline' | 'not-found' | 'other';

/** One plain sentence per kind; nothing from the response body is repeated. */
export const GITHUB_MESSAGES: Readonly<Record<GitHubErrorKind, string>> = {
  'name-taken': 'A repository with that name already exists on your account. Choose another name.',
  permission: 'GitHub did not allow creating the repository. Sign in again and allow repository access.',
  offline: 'Could not reach GitHub. Check your internet connection and try again; your progress is saved.',
  'not-found': 'GitHub could not find that repository.',
  other: 'GitHub could not do that just now. Try again in a moment; your progress is saved.'
};

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body) ?? ''; } catch { return ''; }
}

/** Sorts a GitHub (or gh) answer: status 0 or undefined means the request never got an answer. */
export function classifyGitHubError(status: number | undefined, body?: unknown): GitHubErrorKind {
  if (status === undefined || status === 0) return 'offline';
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'not-found';
  if (status === 422 && /already exists/i.test(bodyText(body))) return 'name-taken';
  return 'other';
}
