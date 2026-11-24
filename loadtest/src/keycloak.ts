// Test-realm tokens (Phase 48 D-19): a password grant against the load-test client of a realm whose name starts with `loadtest-`, on the rig only.
// The production realm keeps every non-WebAuthn flow off, so this refuses any other realm before a request is made. Tokens live in memory: they
// are never written to a file, a run file or a log, and the store will not serialise them.
import type { Fetch, TokenSource } from './service.ts';

export const TEST_REALM_PREFIX = 'loadtest-';
export const TEST_CLIENT_ID = 'loadtest-client';
/** A token is minted again when it would expire within this margin. */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;

export class TestRealmError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TestRealmError';
  }
}

export function assertTestRealm(realm: string): void {
  if (!realm.startsWith(TEST_REALM_PREFIX) || !/^[a-z0-9-]+$/.test(realm)) throw new TestRealmError(`refusing realm "${realm}": tokens come only from a test realm named ${TEST_REALM_PREFIX}*`);
}

export interface TestUser { readonly username: string; readonly email: string; readonly password: string }

export interface MintOptions {
  readonly baseUrl: string;
  readonly realm: string;
  readonly clientId?: string;
  readonly fetch?: Fetch;
}

/** One password grant. Returns the access token and its lifetime; the response body is never echoed on failure. */
export async function mintToken(options: MintOptions, user: TestUser): Promise<{ readonly token: string; readonly expiresInMs: number }> {
  assertTestRealm(options.realm);
  const doFetch = options.fetch ?? fetch;
  const url = new URL(`/realms/${encodeURIComponent(options.realm)}/protocol/openid-connect/token`, options.baseUrl);
  const body = new URLSearchParams({ grant_type: 'password', client_id: options.clientId ?? TEST_CLIENT_ID, username: user.username, password: user.password, scope: 'openid' });
  const response = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!response.ok) throw new TestRealmError(`token for ${user.username}: HTTP ${response.status}`);
  const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new TestRealmError(`token for ${user.username}: no access token in the response`);
  const seconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 60;
  return { token: parsed.access_token, expiresInMs: seconds * 1000 };
}

/** Tokens by the user's email (the identity the service sees), minted on first use and again shortly before they expire. */
export class TokenStore implements TokenSource {
  readonly #options: MintOptions;
  readonly #users: ReadonlyMap<string, TestUser>;
  readonly #now: () => number;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();

  public constructor(options: MintOptions, users: readonly TestUser[], now: () => number = Date.now) {
    assertTestRealm(options.realm);
    this.#options = options;
    this.#users = new Map(users.map((user) => [user.email, user]));
    this.#now = now;
  }

  public async tokenFor(email: string): Promise<string> {
    const held = this.#tokens.get(email);
    if (held && held.expiresAt - RENEW_MARGIN_MS > this.#now()) return held.token;
    const user = this.#users.get(email);
    if (!user) throw new TestRealmError(`${email} is not a user in the users file`);
    const minted = await mintToken(this.#options, user);
    this.#tokens.set(email, { token: minted.token, expiresAt: this.#now() + minted.expiresInMs });
    return minted.token;
  }

  /** Mints every listed user's token ahead of a stage or burst, a few at a time, so the burst measures Theia Cloud, not password hashing. */
  public async mintAll(emails: readonly string[], concurrency = 10): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => { while (next < emails.length) await this.tokenFor(emails[next++]); };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, emails.length)) }, worker));
  }

  public toJSON(): string {
    return '[tokens are held in memory only]';
  }
}

/** The users file `users` writes (Keycloak partial-import shape); read back for the passwords. */
export function parseUsersFile(text: string): TestUser[] {
  const parsed = JSON.parse(text) as { users?: Array<{ username?: unknown; email?: unknown; credentials?: Array<{ value?: unknown }> }> };
  return (parsed.users ?? []).map((entry, index) => {
    const password = entry.credentials?.[0]?.value;
    if (typeof entry.username !== 'string' || typeof entry.email !== 'string' || typeof password !== 'string') throw new TestRealmError(`users file entry ${index + 1} is incomplete`);
    return { username: entry.username, email: entry.email, password };
  });
}
