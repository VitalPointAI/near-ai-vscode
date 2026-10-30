import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Signing in to NEAR AI Cloud to create a usage reporting token, so nobody has to find a console
// session token and call the API by hand. NEAR's OAuth login (GitHub or Google) accepts a
// frontend_callback on http://127.0.0.1:<port>, and puts the session's access and refresh tokens in
// that URL's fragment. A one-time listener on 127.0.0.1 serves a page that reads the fragment,
// posts it back, and removes it from the address bar. The session creates a read-only rpt- token
// with no expiry, revokes the one this extension made before, and is then signed out, which
// revokes both of its tokens. Only the rpt- token is kept. No VS Code imports.

export type SignInProvider = 'github' | 'google';
export interface SessionTokens { accessToken: string; refreshToken: string }

export type SignInErrorCode = 'cancelled' | 'timeout' | 'denied' | 'provider-conflict' | 'expired' | 'not-admin' | 'remote' | 'failed';

export class SignInError extends Error {
  public constructor(public readonly code: SignInErrorCode, message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY = 16 * 1024;
const CALLBACK_PREFIX = '/near-ai/signed-in/';

/** NEAR's login URL for `provider`, sending the session to `callback` (no query or fragment allowed). */
export function loginUrl(baseUrl: string, provider: SignInProvider, callback: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/auth/${provider}?frontend_callback=${encodeURIComponent(callback)}`;
}

/** Whether `url` is on this machine's loopback, the only plain-HTTP callback NEAR accepts. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

/**
 * What NEAR put in the callback's fragment: the session's tokens, or why sign-in failed.
 * Accepts the fragment alone (with or without '#') or the whole address pasted from a browser.
 */
export function parseCallback(input: string): SessionTokens {
  const text = input.trim();
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : text;
  const params = new URLSearchParams(hash);
  const accessToken = params.get('token') ?? '';
  const refreshToken = params.get('refresh_token') ?? '';
  if (accessToken && refreshToken) return { accessToken, refreshToken };
  const error = params.get('error');
  if (error === 'oauth_provider_conflict') {
    throw new SignInError('provider-conflict', params.get('error_description') ?? 'This email is registered with another sign-in method. Sign in with that one.');
  }
  if (error) throw new SignInError('denied', `NEAR AI sign-in failed: ${params.get('error_description') ?? error}`);
  throw new SignInError('failed', 'The address has no NEAR AI sign-in in it. Copy the whole address after signing in.');
}

export interface LoopbackSignIn {
  /** The callback URL to give NEAR (the forwarded address in a remote window). */
  callback: string;
  /** Where the listener is on this machine. */
  local: string;
  /** Resolves with the session once the browser posts it back. */
  tokens: Promise<SessionTokens>;
  close(): void;
}

/**
 * Starts the one-time listener on 127.0.0.1. `external` maps the local callback to the address the
 * browser uses (VS Code's port forwarding for a remote window); it must stay on loopback, since NEAR
 * accepts no other plain-HTTP callback. Only the exact random path is served, the token post must
 * come from that page's origin, and the listener closes after one sign-in, a timeout, or `signal`.
 */
export async function startLoopbackSignIn(options: { external?: (local: string) => Promise<string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LoopbackSignIn> {
  const path = CALLBACK_PREFIX + randomBytes(16).toString('hex');
  const scriptNonce = randomBytes(16).toString('base64');
  let settle: { resolve(tokens: SessionTokens): void; reject(error: Error): void } | undefined;
  const tokens = new Promise<SessionTokens>((resolve, reject) => { settle = { resolve, reject }; });
  tokens.catch(() => undefined);
  const origins = new Set<string>();
  let done = false;

  const server = createServer((request, response) => { void handle(request, response); });
  const finish = (result: SessionTokens | Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
    if (result instanceof Error) settle!.reject(result); else settle!.resolve(result);
  };
  const onAbort = () => finish(new SignInError('cancelled', 'Sign-in was cancelled.'));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (done || url.pathname !== path || url.search) { response.writeHead(404, headers).end(); return; }
    if (request.method === 'GET') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'` });
      response.end(callbackPage(scriptNonce));
      return;
    }
    if (request.method !== 'POST' || !origins.has(String(request.headers.origin ?? ''))) { response.writeHead(403, headers).end(); return; }
    let body = '';
    try {
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > MAX_BODY) throw new Error('too long');
      }
    } catch {
      response.writeHead(413, headers).end();
      return;
    }
    try {
      const session = parseCallback(body);
      response.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Signed in. You can close this tab and go back to VS Code.', () => finish(session));
    } catch (error) {
      response.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(`${(error as Error).message} You can close this tab.`, () => finish(error as Error));
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const local = `http://127.0.0.1:${port}${path}`;
  let callback = local;
  try {
    callback = options.external ? await options.external(local) : local;
  } catch {
    callback = local;
  }
  if (!isLoopbackUrl(callback)) {
    server.close();
    throw new SignInError('remote', 'This VS Code window is not on the machine its browser runs on, so NEAR AI cannot send the sign-in back to it.');
  }
  for (const address of [local, callback]) origins.add(new URL(address).origin);
  const timer = setTimeout(() => finish(new SignInError('timeout', 'Sign-in timed out after 5 minutes.')), options.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  timer.unref?.();
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
  return { callback, local, tokens, close: () => finish(new SignInError('cancelled', 'Sign-in was cancelled.')) };
}

/** The page NEAR redirects to: hands the fragment to the listener and takes it off the address bar. */
function callbackPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NEAR AI for VS Code</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font: 16px system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem;">
<h1 style="font-size: 1.25rem;">NEAR AI for VS Code</h1><p id="m">Finishing sign-in…</p>
<script nonce="${nonce}">
const hash = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const m = document.getElementById('m');
if (!hash) m.textContent = 'Nothing to finish here. Go back to VS Code and try again.';
else fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hash })
  .then((r) => r.text()).then((t) => { m.textContent = t; }, () => { m.textContent = 'VS Code stopped waiting. Go back to VS Code and try again.'; });
</script></body></html>`;
}

// ---- what the session does at NEAR ----

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface CreatedReportingToken { id: string; token: string; organizationId: string }

const REQUEST_TIMEOUT_MS = 30_000;

async function call(fetchImpl: FetchLike, url: string, bearer: string, method: string, body?: unknown) {
  return fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

/** NEAR's error message from a failed response, without echoing anything we sent. */
async function errorText(response: { text(): Promise<string> }): Promise<string> {
  try {
    const body = JSON.parse(await response.text()) as { error?: { message?: unknown } | string; error_description?: unknown };
    const message = typeof body.error === 'object' ? body.error?.message : body.error_description;
    return typeof message === 'string' ? message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

export interface SetUpReportingTokenOptions {
  baseUrl: string;
  session: SessionTokens;
  /** The organization the project's API key belongs to (from /v1/check_api_key). */
  organizationId: string;
  name: string;
  /** The token this extension created last time for this organization, revoked once the new one exists. */
  previousTokenId?: string;
  fetch?: FetchLike;
}

/**
 * Creates a read-only reporting token with no expiry for the organization, revokes the previous one
 * this extension made, and signs the session out whatever happens. Throws a SignInError when the
 * token could not be created; a failed revoke or sign-out never undoes a created token.
 */
export async function setUpReportingToken(options: SetUpReportingTokenOptions): Promise<CreatedReportingToken & { previousRevoked?: boolean }> {
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  const base = options.baseUrl.replace(/\/+$/, '');
  const tokensUrl = `${base}/organizations/${encodeURIComponent(options.organizationId)}/reporting-tokens`;
  try {
    let response;
    try {
      response = await call(fetchImpl, tokensUrl, options.session.accessToken, 'POST', { name: options.name });
    } catch {
      throw new SignInError('failed', 'Could not reach NEAR AI Cloud to create the token.');
    }
    if (response.status === 401) throw new SignInError('expired', 'NEAR AI did not accept the sign-in (it may have expired). Try again.');
    if (response.status === 403) throw new SignInError('not-admin', 'Only an owner or admin of the organization this API key belongs to can create a usage reporting token. Ask one to sign in here, or to create a token for you.');
    if (!response.ok) {
      const detail = await errorText(response);
      throw new SignInError('failed', `NEAR AI could not create the token (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token : '';
    const id = typeof body.id === 'string' ? body.id : '';
    if (!/^rpt-/.test(token) || !id) throw new SignInError('failed', 'NEAR AI\'s answer had no reporting token in it.');
    let previousRevoked: boolean | undefined;
    if (options.previousTokenId && options.previousTokenId !== id) {
      previousRevoked = await call(fetchImpl, `${tokensUrl}/${encodeURIComponent(options.previousTokenId)}`, options.session.accessToken, 'DELETE')
        .then((answer) => answer.ok || answer.status === 404, () => false);
    }
    return { id, token, organizationId: options.organizationId, ...(previousRevoked === undefined ? {} : { previousRevoked }) };
  } finally {
    await signOut(base, options.session.refreshToken, fetchImpl);
  }
}

/** POST /v1/auth/logout with the refresh token: revokes the session and every access token bound to it. */
export async function signOut(baseUrl: string, refreshToken: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  return call(fetchImpl, `${baseUrl.replace(/\/+$/, '')}/auth/logout`, refreshToken, 'POST').then((answer) => answer.ok, () => false);
}

/**
 * The callback when this window can't listen where the browser is (a browser-based VS Code): NEAR
 * still sends the session there, the page fails to load, and the user pastes the address, whose
 * fragment holds it. A browser never sends a fragment to any server, so it stays in the browser.
 */
export const PASTE_CALLBACK = 'http://127.0.0.1:9/near-ai/signed-in';

/** The token's name in NEAR's list, so whoever looks there knows what made it. */
export function reportingTokenName(now = new Date()): string {
  return `NEAR AI for VS Code (${now.toISOString().slice(0, 10)})`;
}
