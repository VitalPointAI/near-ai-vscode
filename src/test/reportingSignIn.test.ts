// Signing in to NEAR AI Cloud to create a usage reporting token: the login URL NEAR's OAuth routes
// accept, the one-time loopback listener the browser sends the session to, and what the session does
// at NEAR (create a token with no expiry, revoke the previous one, always sign out).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FetchLike, isLoopbackUrl, loginUrl, parseCallback, PASTE_CALLBACK, reportingTokenName, setUpReportingToken, SignInError, startLoopbackSignIn
} from '../services/reportingSignIn';

const BASE = 'https://cloud-api.near.ai/v1';
const SESSION = { accessToken: 'eyJ.access.jwt', refreshToken: 'rt_refresh' };
const ORG = '11111111-2222-3333-4444-555555555555';

const code = async (promise: Promise<unknown>) => { try { await promise; return 'resolved'; } catch (error) { return error instanceof SignInError ? error.code : String(error); } };

test('the login URL is NEAR\'s OAuth route with the callback as frontend_callback', () => {
  assert.equal(loginUrl(`${BASE}/`, 'github', 'http://127.0.0.1:4321/near-ai/signed-in/abc'), `${BASE}/auth/github?frontend_callback=${encodeURIComponent('http://127.0.0.1:4321/near-ai/signed-in/abc')}`);
  assert.match(loginUrl(BASE, 'google', PASTE_CALLBACK), /\/v1\/auth\/google\?frontend_callback=http%3A%2F%2F127\.0\.0\.1%3A9%2F/);
  // NEAR accepts plain HTTP only on loopback, so a callback anywhere else can't be used.
  assert.equal(isLoopbackUrl('http://127.0.0.1:5000/x'), true);
  assert.equal(isLoopbackUrl('http://localhost:5000/x'), true);
  assert.equal(isLoopbackUrl('https://code.example.com/proxy/5000/x'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com/x'), false);
  assert.equal(isLoopbackUrl(PASTE_CALLBACK), true);
});

test('the callback fragment gives the session, from the fragment alone or a pasted address', () => {
  const fragment = `token=${encodeURIComponent(SESSION.accessToken)}&refresh_token=${encodeURIComponent(SESSION.refreshToken)}`;
  assert.deepEqual(parseCallback(fragment), SESSION);
  assert.deepEqual(parseCallback(`  ${PASTE_CALLBACK}#${fragment}\n`), SESSION);
  assert.throws(() => parseCallback('error=oauth_provider_conflict&error_description=This%20email%20is%20registered%20with%20GitHub.&existing_provider=github'), (error: SignInError) => error.code === 'provider-conflict' && /registered with GitHub/.test(error.message));
  assert.throws(() => parseCallback('#error=access_denied'), (error: SignInError) => error.code === 'denied');
  assert.throws(() => parseCallback(PASTE_CALLBACK), (error: SignInError) => error.code === 'failed');
  assert.throws(() => parseCallback('token=only-access'), (error: SignInError) => error.code === 'failed', 'both tokens are needed: the refresh token signs the session out');
});

test('the loopback listener serves its page only at the random path and takes the session once, from that page', async () => {
  const signIn = await startLoopbackSignIn();
  const callback = new URL(signIn.callback);
  assert.equal(callback.hostname, '127.0.0.1');
  assert.match(callback.pathname, /^\/near-ai\/signed-in\/[0-9a-f]{32}$/);
  assert.equal(callback.search + callback.hash, '', 'NEAR rejects a callback with a query or fragment');

  const page = await fetch(signIn.callback);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(String(page.headers.get('content-security-policy')), /default-src 'none'; script-src 'nonce-[^']+'; .*connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /history\.replaceState\(null, '', location\.pathname\)/, 'the session is taken off the address bar and history');
  assert.match(html, /<script nonce="[^"]+">/);

  assert.equal((await fetch(`${callback.origin}/near-ai/signed-in/0000`)).status, 404, 'another path');
  assert.equal((await fetch(`${signIn.callback}?x=1`)).status, 404, 'a query');
  const body = `token=${SESSION.accessToken}&refresh_token=${SESSION.refreshToken}`;
  assert.equal((await fetch(signIn.callback, { method: 'POST', body })).status, 403, 'no Origin: not the page');
  assert.equal((await fetch(signIn.callback, { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status, 403, 'another site');

  const posted = await fetch(signIn.callback, { method: 'POST', body, headers: { origin: callback.origin } });
  assert.equal(posted.status, 200);
  assert.match(await posted.text(), /Signed in\. You can close this tab/);
  assert.deepEqual(await signIn.tokens, SESSION);
  await assert.rejects(fetch(signIn.callback), 'the listener is closed after one sign-in');
});

test('an error from NEAR reaches the listener as that error, and the page says so', async () => {
  const signIn = await startLoopbackSignIn();
  const origin = new URL(signIn.callback).origin;
  const answer = await fetch(signIn.callback, { method: 'POST', body: 'error=oauth_provider_conflict&error_description=Sign%20in%20with%20Google.', headers: { origin } });
  assert.match(await answer.text(), /Sign in with Google\. You can close this tab/);
  assert.equal(await code(signIn.tokens), 'provider-conflict');
});

test('the listener accepts the forwarded origin of a remote window, refuses a non-loopback one, and stops on timeout or cancel', async () => {
  let forwarded = '';
  const remote = await startLoopbackSignIn({ external: async (local) => { forwarded = local.replace(/:\d+\//, ':1/'); return forwarded; } });
  assert.equal(remote.callback, forwarded, 'NEAR is given the address the browser can reach');
  assert.notEqual(remote.local, forwarded);
  // The page is served through the forward, so its post carries the forwarded origin.
  const posted = await fetch(remote.local, { method: 'POST', body: `token=a&refresh_token=b`, headers: { origin: new URL(forwarded).origin } });
  assert.equal(posted.status, 200);
  assert.deepEqual(await remote.tokens, { accessToken: 'a', refreshToken: 'b' });
  const closing = await startLoopbackSignIn();
  closing.close();
  assert.equal(await code(closing.tokens), 'cancelled');

  assert.equal(await code(startLoopbackSignIn({ external: async (url) => url.replace('http://127.0.0.1', 'https://code.example.com/proxy') })), 'remote');
  const slow = await startLoopbackSignIn({ timeoutMs: 20 });
  assert.equal(await code(slow.tokens), 'timeout');
  const abort = new AbortController();
  const cancelled = await startLoopbackSignIn({ signal: abort.signal });
  abort.abort();
  assert.equal(await code(cancelled.tokens), 'cancelled');
});

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeNear(answers: Record<string, { status: number; body?: unknown } | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
      const answer = answers[`${init.method} ${url.replace(BASE, '')}`] ?? { status: 404, body: { error: { message: 'not found', type: 'not_found' } } };
      if (answer instanceof Error) throw answer;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body, text: async () => JSON.stringify(answer.body ?? {}) };
    }
  };
}

const CREATE = `POST /organizations/${ORG}/reporting-tokens`;
const LOGOUT = 'POST /auth/logout';
const CREATED = { status: 201, body: { id: 'tok-new', organization_id: ORG, name: 'x', token: 'rpt-0123456789abcdef0123456789abcdef', token_prefix: 'rpt-0123', created_by_user_id: 'u', created_at: '2026-10-30T00:00:00Z', scope: 'usage:read', expires_at: null } };

test('the session creates a token with no expiry, revokes the previous one, and is signed out', async () => {
  const near = fakeNear({ [CREATE]: CREATED, [`DELETE /organizations/${ORG}/reporting-tokens/tok-old`]: { status: 204 }, [LOGOUT]: { status: 200, body: { message: 'Logged out successfully' } } });
  const created = await setUpReportingToken({ baseUrl: `${BASE}/`, session: SESSION, organizationId: ORG, name: reportingTokenName(new Date('2026-10-30T12:00:00Z')), previousTokenId: 'tok-old', fetch: near.fetch });
  assert.deepEqual(created, { id: 'tok-new', token: CREATED.body.token, organizationId: ORG, previousRevoked: true });
  assert.deepEqual(near.calls.map((call) => `${call.method} ${call.url.replace(BASE, '')}`), [CREATE, `DELETE /organizations/${ORG}/reporting-tokens/tok-old`, LOGOUT]);
  assert.deepEqual(JSON.parse(near.calls[0].body!), { name: 'NEAR AI for VS Code (2026-10-30)' }, 'no expires_at: the token stays current until revoked');
  assert.equal(near.calls[0].headers.authorization, `Bearer ${SESSION.accessToken}`);
  assert.equal(near.calls[1].headers.authorization, `Bearer ${SESSION.accessToken}`);
  assert.equal(near.calls[2].headers.authorization, `Bearer ${SESSION.refreshToken}`, 'logout takes the refresh token, which revokes the whole session');
});

test('a failed revoke is reported but keeps the new token; with no previous token nothing is revoked', async () => {
  const failing = fakeNear({ [CREATE]: CREATED, [`DELETE /organizations/${ORG}/reporting-tokens/tok-old`]: { status: 500 }, [LOGOUT]: { status: 200 } });
  assert.equal((await setUpReportingToken({ baseUrl: BASE, session: SESSION, organizationId: ORG, name: 'n', previousTokenId: 'tok-old', fetch: failing.fetch })).previousRevoked, false);
  const gone = fakeNear({ [CREATE]: CREATED, [`DELETE /organizations/${ORG}/reporting-tokens/tok-old`]: { status: 404 }, [LOGOUT]: { status: 200 } });
  assert.equal((await setUpReportingToken({ baseUrl: BASE, session: SESSION, organizationId: ORG, name: 'n', previousTokenId: 'tok-old', fetch: gone.fetch })).previousRevoked, true, 'already revoked');
  const first = fakeNear({ [CREATE]: CREATED, [LOGOUT]: { status: 200 } });
  const created = await setUpReportingToken({ baseUrl: BASE, session: SESSION, organizationId: ORG, name: 'n', fetch: first.fetch });
  assert.equal('previousRevoked' in created, false);
  assert.deepEqual(first.calls.map((call) => call.method), ['POST', 'POST']);
});

test('when no token can be made the reason is specific, and the session is still signed out', async () => {
  const cases: Array<[Record<string, { status: number; body?: unknown } | Error>, string, RegExp]> = [
    [{ [CREATE]: { status: 403, body: { error: { message: 'Forbidden', type: 'forbidden' } } } }, 'not-admin', /owner or admin of the organization/],
    [{ [CREATE]: { status: 401 } }, 'expired', /did not accept the sign-in/],
    [{ [CREATE]: { status: 400, body: { error: { message: 'name must not be empty', type: 'invalid_request' } } } }, 'failed', /HTTP 400\): name must not be empty/],
    [{ [CREATE]: { status: 201, body: { id: 'x' } } }, 'failed', /no reporting token/],
    [{ [CREATE]: new Error('ECONNRESET') }, 'failed', /Could not reach NEAR AI Cloud/]
  ];
  for (const [answers, expected, message] of cases) {
    const near = fakeNear({ ...answers, [LOGOUT]: { status: 200 } });
    await assert.rejects(setUpReportingToken({ baseUrl: BASE, session: SESSION, organizationId: ORG, name: 'n', previousTokenId: 'tok-old', fetch: near.fetch }), (error: SignInError) => error.code === expected && message.test(error.message));
    assert.deepEqual(near.calls.map((call) => `${call.method} ${call.url.replace(BASE, '')}`), [CREATE, LOGOUT], `${expected}: nothing revoked, session signed out`);
    assert.ok(near.calls.every((call) => !String(call.body ?? '').includes('rt_')), 'the refresh token is only ever a header');
  }
});
