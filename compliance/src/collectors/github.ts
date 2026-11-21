// Shared helpers of the supply-chain and GitHub collectors (44-08): the collector error every collector throws (the bundle records it with its code,
// 44-14), and the GitHub REST reader over the injected fetchJson. Nothing here holds or adds a token: the injected fetch carries one only in the
// scheduled settings job (D-25, wired in 44-19), and reaches https://api.github.com only (T-44-29). Responses are read for ids, counts, hashes
// and pass or fail only (D-24); an error message names the endpoint and the HTTP status, never a response body.
import type { FetchJson } from './types.ts';

/** A collector failure with a stable code. A collector that throws is recorded as not ok, never as a pass (44-14). */
export interface CollectorError extends Error {
  readonly code: string;
  /** The HTTP status, when a GitHub request failed. */
  readonly status?: number;
}

/** Makes a CollectorError. The message names the collector and what failed; it never quotes a response body. */
export function collectorError(code: string, message: string, status?: number): CollectorError {
  return Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) });
}

export const GITHUB_API = 'https://api.github.com';
/** The headers every request sends. The token, when one is used, is added by the injected fetch, never here. */
export const GITHUB_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
/** GitHub's largest page. A page shorter than this is the last one. */
export const PAGE_SIZE = 100;
/** A list longer than this many pages is an error rather than a silently truncated result. */
export const MAX_PAGES = 50;

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Checks an `owner/name` repository and returns it, or throws invalid-input. */
export function checkRepository(repository: unknown, collector: string): string {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || repository.split('/')[1].startsWith('.')) {
    throw collectorError('invalid-input', `${collector}: the repository must be owner/name`);
  }
  return repository;
}

/** The injected fetch, or a no-fetch error: these collectors cannot run without one. */
export function requireFetch(fetchJson: FetchJson | undefined, collector: string): FetchJson {
  if (typeof fetchJson !== 'function') throw collectorError('no-fetch', `${collector}: no fetchJson was given`);
  return fetchJson;
}

/** The HTTP status an injected fetch attached to its error (`status`, or `response.status`), if any. */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;
  const nested = (error as { response?: { status?: unknown } }).response?.status;
  return typeof nested === 'number' ? nested : undefined;
}

/** Builds an api.github.com address from a path and query parameters (sorted, so tests and logs are stable). */
export function githubUrl(path: string, params: Readonly<Record<string, string | number>> = {}): string {
  if (!path.startsWith('/') || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..')) throw collectorError('invalid-input', `GitHub path ${path} is not a plain API path`);
  const query = new URLSearchParams();
  for (const key of Object.keys(params).sort()) query.set(key, String(params[key]));
  const search = query.toString();
  return `${GITHUB_API}${path}${search ? `?${search}` : ''}`;
}

export interface GithubRequestOptions {
  /** The collector id, for error messages. */
  readonly collector: string;
  /** The fine-grained permission the endpoint needs, named in a 401 or 403 error (research permission table). */
  readonly permission: string;
}

/**
 * GETs one GitHub endpoint through the injected fetch. 401 and 403 become a `permission` error naming the permission the token lacks; 404 becomes
 * `not-found` (callers that treat absence as evidence catch it); any other failure is `fetch-failed`. Never a pass.
 */
export async function githubGet(fetchJson: FetchJson, path: string, params: Readonly<Record<string, string | number>>, options: GithubRequestOptions): Promise<unknown> {
  const url = githubUrl(path, params);
  try {
    return await fetchJson(url, { method: 'GET', headers: GITHUB_HEADERS });
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 401 || status === 403) {
      throw collectorError('permission', `${options.collector}: GitHub refused ${path} (HTTP ${status}); the token needs ${options.permission}`, status);
    }
    if (status === 404) throw collectorError('not-found', `${options.collector}: GitHub has no ${path} (HTTP 404)`, status);
    throw collectorError('fetch-failed', `${options.collector}: reading ${path} failed${status === undefined ? '' : ` (HTTP ${status})`}`, status);
  }
}

export interface GithubListOptions<T> extends Partial<GithubRequestOptions> {
  /** For endpoints that wrap the list in an object, the key that holds it (for example `workflow_runs`). */
  readonly key?: string;
  /** Stops after the first item for which this returns true (that item is not included); for lists sorted newest first. */
  readonly stop?: (item: T) => boolean;
  readonly maxPages?: number;
}

/**
 * Lists a paginated GitHub endpoint: pages of 100 (`per_page=100&page=N`) until a page shorter than 100. A page that is not a list is an
 * `unexpected-response` error; more than `maxPages` pages is `too-many-pages`, never a truncated list.
 */
export async function githubList<T = unknown>(fetchJson: FetchJson, path: string, params: Readonly<Record<string, string | number>> = {}, options: GithubListOptions<T> = {}): Promise<T[]> {
  const request: GithubRequestOptions = { collector: options.collector ?? 'github', permission: options.permission ?? 'read access' };
  const maxPages = options.maxPages ?? MAX_PAGES;
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await githubGet(fetchJson, path, { ...params, per_page: PAGE_SIZE, page }, request);
    const list = options.key === undefined ? body : (body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[options.key] : undefined);
    if (!Array.isArray(list)) throw collectorError('unexpected-response', `${request.collector}: ${path} did not return a list`);
    for (const item of list as T[]) {
      if (options.stop?.(item)) return items;
      items.push(item);
    }
    if (list.length < PAGE_SIZE) return items;
  }
  throw collectorError('too-many-pages', `${request.collector}: ${path} has more than ${maxPages} pages`);
}

/** Encodes one path segment (a tag, a branch, an environment name). */
export const segment = (value: string): string => encodeURIComponent(value);

/** A plain object, or undefined. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
