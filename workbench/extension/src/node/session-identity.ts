/**
 * The identity part of the session state machine (DESIGN section 7; D-03, D-21 to D-25, D-37, D-38). One record per backend process, because
 * one backend serves one person (D-03): the latest forwarded sign-in token with its claims, the OpenBao token and lease, the entity id, and
 * the state. Nothing here imports Theia; the clock and timers are injected so every transition is tested.
 *
 *   local                       no STERLING_OPENBAO_ADDR; terminal, never inferred from a missing header (D-25)
 *   identity  -> active         a forwarded token for THEIACLOUD_SESSION_USER logs in to auth/<mount>/login; lookup-self gives the entity id,
 *                               and whether the entity is a guest's (policy guest-account in identity_policies: its secrets are under guests/)
 *   identity  -> failed         no token within IDENTITY_TIMEOUT_MS (token-missing), the person check fails (person-mismatch),
 *                               OpenBao unreachable (store-unreachable) or refusing (store-refused); no secret is read
 *   active    -> active         renew-self at half the lease; a refused renewal re-logs in once with the latest unexpired token
 *   active    -> failed         that re-login fails too (with its reason), or no unexpired token is left (token-missing)
 *   failed    -> identity       Retry (the same path as start); a token-missing failure also leaves by itself when a token arrives
 *   any       -> stopping       stop() (Theia's onStop on SIGINT and SIGTERM): revoke-self within 3 s, errors swallowed
 *   stopping  -> stopped        the token is dropped; nothing leaves stopped
 *
 * The forwarded token's signature is never checked here: OpenBao's jwt login checks it (research Pattern 3), so acr and auth_time read from
 * it are a workbench-side guard only. Tokens and the entity id never reach a log line, an error text or a status (T-46-06).
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { FailureReason, IdentityState, SessionIdentityStatus } from '../common/session-identity.js';
import type { HostedConfig, HostingConfig } from './hosting-config.js';
import { GUEST_ACCOUNT_POLICY, type KvSpace } from './kv-path.js';
import { OpenBaoError, type OpenBaoClient } from './openbao-client.js';

export const SessionIdentity = Symbol('SessionIdentity');

/** How long `identity` waits for a forwarded sign-in token before it is `failed` (46-02 planning choice 1). */
export const IDENTITY_TIMEOUT_MS = 60_000;
/** The share of Theia's shutdown time the revoke may use. */
export const REVOKE_BUDGET_MS = 3_000;

const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IdentityClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What backend consumers (46-07's key store and key service) use, only while active. Never sent to the browser. */
export interface ActiveSession {
  readonly token: string;
  readonly entityId: string;
  /**
   * Where the person's own secrets are: `guests` when OpenBao gives the entity policy guest-account, else `users` (kv-path.ts). OpenBao
   * enforces it either way: a guest is denied users/, and staff never reach guests/. Absent means users.
   */
  readonly space?: KvSpace;
  /** The latest forwarded sign-in token (the JWT), for KeyService's step-up login only. Backend only, like the token. */
  readonly forwardedToken: string;
  readonly acr?: string;
  /** Seconds since the epoch, from the latest forwarded token. */
  readonly authTime?: number;
  /** The latest forwarded token's subject (33.1 D-09). */
  readonly sub?: string;
  /** The subject of the token the session became active with: a step-up binds an action only when the two are the same person (33.1-17). */
  readonly activeSub?: string;
  readonly client: OpenBaoClient;
  readonly config: HostedConfig;
}

export interface SessionIdentity {
  /** Reads the forwarded sign-in headers of one HTTP request or WebSocket upgrade. Never throws. */
  observe(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, now?: number): void;
  /** Begins the identity check; resolves once a login it started has settled. */
  start(): Promise<void>;
  /** From `failed`, the same path as start; does nothing in any other state. */
  retry(): Promise<void>;
  /** Revokes the OpenBao token (best effort, 3 s) and ends `stopped`. */
  stop(): Promise<void>;
  status(): SessionIdentityStatus;
  session(): ActiveSession | undefined;
}

export interface SessionIdentityOptions {
  readonly config: HostingConfig;
  /** Required in hosted mode. */
  readonly client?: OpenBaoClient;
  readonly clock?: IdentityClock;
  /** One line per transition, with the state and a reason code only. Default: console.info. */
  readonly log?: (line: string) => void;
}

interface Claims {
  readonly sub?: string;
  readonly email?: string;
  readonly exp: number;
  readonly acr?: string;
  readonly authTime?: number;
}

interface Forwarded {
  readonly jwt: string;
  readonly claims: Claims;
}

const realClock: IdentityClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** Decodes the payload of a compact JWT; undefined when it cannot be read. The signature is left to OpenBao. */
function readClaims(jwt: string): Claims | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp)) return undefined;
  return {
    exp: record.exp,
    ...(typeof record.sub === 'string' ? { sub: record.sub } : {}),
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
    ...(typeof record.acr === 'string' ? { acr: record.acr } : {}),
    ...(typeof record.auth_time === 'number' ? { authTime: record.auth_time } : {}),
  };
}

const samePerson = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function failureOf(error: unknown): FailureReason {
  if (error instanceof OpenBaoError) return error.kind === 'refused' ? 'store-refused' : 'store-unreachable';
  return 'store-unreachable';
}

class Refusal extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

export function createSessionIdentity(options: SessionIdentityOptions): SessionIdentity {
  if (options.config.mode === 'local') {
    return {
      observe: () => undefined,
      start: async () => undefined,
      retry: async () => undefined,
      stop: async () => undefined,
      status: () => ({ mode: 'local' }),
      session: () => undefined,
    };
  }
  const config: HostedConfig = options.config;
  const client = options.client;
  if (!client) throw new Error('Hosted session identity needs an OpenBao client.');
  const clock = options.clock ?? realClock;
  const log = options.log ?? ((line: string) => console.info(line));

  let state: IdentityState = 'identity';
  let reason: FailureReason | undefined;
  let latest: Forwarded | undefined;
  let baoToken: string | undefined;
  let entityId: string | undefined;
  let space: KvSpace = 'users';
  let activeSub: string | undefined;
  let leaseEndsAt = 0;
  let identityTimer: unknown;
  let renewTimer: unknown;
  /** Bumped by start, retry, a failure and stop: an older login or renewal that finishes late sees it changed and drops its result. */
  let generation = 0;
  let loggingIn: Promise<void> | undefined;

  const say = (line: string): void => log(`Sterling session identity: ${line}`);
  const clearTimers = (): void => {
    if (identityTimer !== undefined) clock.clearTimeout(identityTimer);
    if (renewTimer !== undefined) clock.clearTimeout(renewTimer);
    identityTimer = undefined;
    renewTimer = undefined;
  };
  const moveTo = (next: IdentityState, why?: FailureReason): void => {
    state = next;
    reason = why;
    say(why ? `${next} (${why})` : next);
  };
  const revokeQuietly = (token: string): Promise<void> =>
    client.request('POST', 'auth/token/revoke-self', { token }).then(() => undefined, () => undefined);
  const fail = (why: FailureReason): void => {
    generation += 1;
    clearTimers();
    const token = baoToken;
    baoToken = undefined;
    entityId = undefined;
    if (token !== undefined) void revokeQuietly(token);
    moveTo('failed', why);
  };
  const unexpired = (now: number): Forwarded | undefined => (latest && latest.claims.exp * 1000 > now ? latest : undefined);

  /** auth/<mount>/login with the token, then lookup-self for the entity id and space. Throws a Refusal or an OpenBaoError. */
  async function login(jwt: string, mine: number): Promise<{ token: string; entity: string; space: KvSpace; lease: number }> {
    const answer = await client!.request('POST', `auth/${config.jwtMount}/login`, { body: { role: config.jwtRole, jwt } });
    const auth = (answer.json as { auth?: { client_token?: unknown; lease_duration?: unknown } } | undefined)?.auth;
    if (typeof auth?.client_token !== 'string' || auth.client_token === '' || typeof auth.lease_duration !== 'number') {
      throw new Refusal('store-unreachable');
    }
    const token = auth.client_token;
    try {
      const looked = await client!.request('GET', 'auth/token/lookup-self', { token });
      const data = (looked.json as { data?: { entity_id?: unknown; identity_policies?: unknown } } | undefined)?.data;
      const entity = data?.entity_id;
      if (typeof entity !== 'string' || !ENTITY_ID.test(entity)) throw new Refusal('store-refused');
      if (mine !== generation) throw new Refusal('store-refused');
      const guest = Array.isArray(data?.identity_policies) && data.identity_policies.includes(GUEST_ACCOUNT_POLICY);
      return { token, entity, space: guest ? 'guests' : 'users', lease: auth.lease_duration };
    } catch (error) {
      void revokeQuietly(token);
      throw error;
    }
  }

  function scheduleRenewal(leaseSeconds: number, mine: number): void {
    leaseEndsAt = clock.now() + leaseSeconds * 1000;
    if (leaseSeconds <= 0) return; // a token without a lease never needs renewing
    renewTimer = clock.setTimeout(() => void renew(mine), (leaseSeconds * 1000) / 2);
  }

  async function renew(mine: number): Promise<void> {
    renewTimer = undefined;
    if (mine !== generation || state !== 'active' || baoToken === undefined) return;
    try {
      const answer = await client!.request('POST', 'auth/token/renew-self', { token: baoToken, body: {} });
      if (mine !== generation) return;
      const lease = (answer.json as { auth?: { lease_duration?: unknown } } | undefined)?.auth?.lease_duration;
      scheduleRenewal(typeof lease === 'number' ? lease : 0, mine);
    } catch (error) {
      if (mine !== generation) return;
      if (error instanceof OpenBaoError && error.kind === 'refused') {
        await relogin(mine);
        return;
      }
      // Unreachable for now: the token still works until its lease ends, so try again at half the time left; with too little left, fail.
      const left = leaseEndsAt - clock.now();
      if (left > 2_000) renewTimer = clock.setTimeout(() => void renew(mine), left / 2);
      else fail(failureOf(error));
    }
  }

  /** One re-login after a refused renewal, with the latest unexpired forwarded token. */
  async function relogin(mine: number): Promise<void> {
    const forwarded = unexpired(clock.now());
    baoToken = undefined; // refused: it no longer works
    if (!forwarded) { fail('token-missing'); return; }
    try {
      const fresh = await login(forwarded.jwt, mine);
      if (fresh.entity !== entityId || fresh.space !== space) {
        void revokeQuietly(fresh.token);
        fail('store-refused');
        return;
      }
      baoToken = fresh.token;
      say('active (renewed by a new sign-in)');
      scheduleRenewal(fresh.lease, mine);
    } catch (error) {
      if (mine !== generation) return;
      fail(error instanceof Refusal ? error.reason : failureOf(error));
    }
  }

  /** Logs in with the latest token if there is one; resolves when that attempt has settled. */
  function attempt(): Promise<void> {
    if (loggingIn) return loggingIn;
    const forwarded = unexpired(clock.now());
    if (state !== 'identity' || !forwarded) return Promise.resolve();
    const mine = generation;
    loggingIn = (async () => {
      try {
        const fresh = await login(forwarded.jwt, mine);
        if (mine !== generation || state !== 'identity') { void revokeQuietly(fresh.token); return; }
        clearTimers();
        baoToken = fresh.token;
        entityId = fresh.entity;
        space = fresh.space;
        activeSub = forwarded.claims.sub;
        moveTo('active');
        scheduleRenewal(fresh.lease, mine);
      } catch (error) {
        if (mine !== generation) return;
        fail(error instanceof Refusal ? error.reason : failureOf(error));
      } finally {
        loggingIn = undefined;
      }
    })();
    return loggingIn;
  }

  /** The start path, shared by start, Retry and a late token after token-missing. */
  function begin(): Promise<void> {
    generation += 1;
    clearTimers();
    baoToken = undefined;
    entityId = undefined;
    activeSub = undefined;
    moveTo('identity');
    const mine = generation;
    identityTimer = clock.setTimeout(() => {
      identityTimer = undefined;
      if (mine === generation && state === 'identity' && !loggingIn) fail('token-missing');
    }, IDENTITY_TIMEOUT_MS);
    return attempt();
  }

  let started = false;

  return {
    observe(headers, now = clock.now()) {
      if (state === 'stopping' || state === 'stopped') return;
      const record = headers as Record<string, string | string[] | undefined>;
      const jwt = header(record, 'x-forwarded-access-token');
      if (jwt === undefined) return;
      const claims = readClaims(jwt);
      if (!claims) { say('ignored a sign-in token (token-unreadable)'); return; }
      if (claims.exp * 1000 <= now) { say('ignored a sign-in token (token-expired)'); return; }
      const email = header(record, 'x-auth-request-email');
      if (email === undefined) { say('ignored a sign-in token (email-missing)'); return; }
      // The user header is read with the others; the person check compares emails only (46-02 planning choice 4).
      const matches = samePerson(email, config.sessionUser) && (claims.email === undefined || samePerson(claims.email, config.sessionUser));
      if (!matches) {
        if (state === 'identity' && started) { fail('person-mismatch'); return; }
        if (state === 'failed' && reason === 'token-missing') { fail('person-mismatch'); return; }
        say('ignored a sign-in token (person-mismatch)');
        return;
      }
      latest = { jwt, claims };
      if (!started) return;
      if (state === 'identity') void attempt();
      else if (state === 'failed' && reason === 'token-missing') void begin();
    },
    async start() {
      if (started || state === 'stopping' || state === 'stopped') return;
      started = true;
      await begin();
    },
    async retry() {
      if (state !== 'failed') return;
      await begin();
    },
    async stop() {
      if (state === 'stopping' || state === 'stopped') return;
      generation += 1;
      clearTimers();
      const token = baoToken;
      baoToken = undefined;
      entityId = undefined;
      latest = undefined;
      moveTo('stopping');
      if (token !== undefined) {
        let budget: unknown;
        await Promise.race([
          revokeQuietly(token),
          new Promise<void>((resolve) => { budget = clock.setTimeout(resolve, REVOKE_BUDGET_MS); }),
        ]);
        clock.clearTimeout(budget);
      }
      moveTo('stopped');
    },
    status() {
      return {
        mode: 'hosted',
        state,
        ...(state === 'failed' && reason ? { reason } : {}),
        ...(config.stepUpAcr ? { stepUp: { acr: config.stepUpAcr } } : {}),
      };
    },
    session() {
      if (state !== 'active' || baoToken === undefined || entityId === undefined || latest === undefined) return undefined;
      const claims = latest.claims;
      return {
        token: baoToken,
        entityId,
        space,
        forwardedToken: latest.jwt,
        ...(claims.acr === undefined ? {} : { acr: claims.acr }),
        ...(claims.authTime === undefined ? {} : { authTime: claims.authTime }),
        ...(claims.sub === undefined ? {} : { sub: claims.sub }),
        ...(activeSub === undefined ? {} : { activeSub }),
        client: client!,
        config,
      };
    },
  };
}
