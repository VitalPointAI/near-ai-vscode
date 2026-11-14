// The small part of the GitHub REST API the online-home setup needs: who the token belongs to, create a repository under that account, look one up, and
// change its default branch.
// fetch is injected (tests pass a fake, nothing here reaches a network on its own). Requests go only to https://api.github.com; the token is sent only
// as the Authorization header; bodies are JSON.stringify of validated values; an error carries a kind and one plain sentence, never the token and never
// the response body. No vscode.
import { GITHUB_MESSAGES, classifyGitHubError, expectedCloneUrl, validateLogin, validateRepoName } from '../domain/state/onlineHome';
import type { GitHubErrorKind, Visibility } from '../domain/state/onlineHome';

const API = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

/** The part of fetch this client uses, so a test fake needs only a status and a text body. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export class GitHubApiError extends Error {
  public readonly kind: GitHubErrorKind;
  public constructor(kind: GitHubErrorKind) {
    super(GITHUB_MESSAGES[kind]);
    this.name = 'GitHubApiError';
    this.kind = kind;
  }
}

export interface GitHubRepo {
  owner: string;
  name: string;
  url: string;
  visibility: Visibility;
  /** The repository's default branch, only when GitHub named one that is a safe branch name. */
  defaultBranch?: string;
}

/** A branch name that can be shown, compared and sent back to GitHub unchanged: letters, digits and . _ - /, nothing git itself would refuse. */
export function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.includes('..') || value.includes('//')) return false;
  if (value.startsWith('-') || value.startsWith('/')) return false;
  return !(value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock'));
}

function defaultFetch(): FetchLike {
  return (url, init) => globalThis.fetch(url, init);
}

async function call(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, fetchFn: FetchLike | undefined): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: { status: number; text(): Promise<string> };
  try {
    response = await (fetchFn ?? defaultFetch())(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GitHubApiError(classifyGitHubError(0));
  }
  let text = '';
  try { text = await response.text(); } catch { /* an unreadable body is treated like an empty one */ }
  let json: unknown;
  try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
  if (response.status < 200 || response.status > 299) throw new GitHubApiError(classifyGitHubError(response.status, json ?? text));
  return { status: response.status, json };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** Reads a repository answer. The address must be exactly the one this account and name give: nothing else from GitHub is trusted. */
function parseRepo(json: unknown): GitHubRepo {
  const record = asRecord(json);
  const owner = asRecord(record?.owner)?.login;
  const name = record?.name;
  const cloneUrl = record?.clone_url;
  if (typeof owner !== 'string' || typeof name !== 'string' || typeof cloneUrl !== 'string' || typeof record?.private !== 'boolean') throw new GitHubApiError('other');
  if (!validateLogin(owner) || !validateRepoName(name) || cloneUrl !== expectedCloneUrl(owner, name)) throw new GitHubApiError('other');
  const repo: GitHubRepo = { owner, name, url: cloneUrl, visibility: record.private ? 'private' : 'public' };
  const defaultBranch = record.default_branch;
  if (isSafeBranchName(defaultBranch)) repo.defaultBranch = defaultBranch;
  return repo;
}

/** The account the token belongs to. */
export async function currentLogin(token: string, fetchFn?: FetchLike): Promise<string> {
  const { json } = await call(token, 'GET', '/user', undefined, fetchFn);
  const login = asRecord(json)?.login;
  if (typeof login !== 'string' || !validateLogin(login)) throw new GitHubApiError('other');
  return login;
}

/** Creates an empty repository under the signed-in account. `private` is the person's choice, never a default of ours. */
export async function createUserRepo(token: string, options: { name: string; private: boolean }, fetchFn?: FetchLike): Promise<GitHubRepo> {
  if (!validateRepoName(options.name)) throw new GitHubApiError('other');
  const { json } = await call(token, 'POST', '/user/repos', { name: options.name, private: options.private, auto_init: false }, fetchFn);
  const repo = parseRepo(json);
  if (repo.name.toLowerCase() !== options.name.toLowerCase() || repo.visibility !== (options.private ? 'private' : 'public')) throw new GitHubApiError('other');
  return repo;
}

/** The repository, or undefined when GitHub has none by that name. */
export async function getRepo(token: string, owner: string, name: string, fetchFn?: FetchLike): Promise<GitHubRepo | undefined> {
  if (!validateLogin(owner) || !validateRepoName(name)) throw new GitHubApiError('other');
  try {
    const { json } = await call(token, 'GET', `/repos/${owner}/${name}`, undefined, fetchFn);
    return parseRepo(json);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === 'not-found') return undefined;
    throw error;
  }
}

/** Makes `branch` the repository's default branch with one PATCH. Owner, name and branch are checked before any request; any 2xx answer is done. */
export async function setDefaultBranch(token: string, owner: string, name: string, branch: string, fetchFn?: FetchLike): Promise<void> {
  if (!validateLogin(owner) || !validateRepoName(name) || !isSafeBranchName(branch)) throw new GitHubApiError('other');
  await call(token, 'PATCH', `/repos/${owner}/${name}`, { default_branch: branch }, fetchFn);
}
