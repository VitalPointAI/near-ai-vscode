// The lead's NEAR session for one team (D-01, D-02). Only {v: 1, refreshToken, label} is kept, in
// SecretStorage under nearAi.team.nearSession.<teamId>; the access token lives in memory only and is
// renewed through NEAR's rotating refresh route. This module never imports `vscode` and never puts a
// token in anything it throws: every message below is fixed text.
//
// Refresh tokens are single use. So the new one is stored before the new access token is handed out,
// concurrent callers in this window share one refresh, and a refused refresh re-reads the stored
// token once: if another window rotated it meanwhile, its newer token is used instead of giving up.
import { isSecureEndpoint } from '../domain/config';
import type { SecretStorageLike } from '../services/auth';
import { FetchLike, SessionTokens, signOut as logoutAtNear } from '../services/reportingSignIn';
import type { NearAuth } from './nearOrg';

export const NEAR_SESSION_SECRET_PREFIX = 'nearAi.team.nearSession.';

export function nearSessionSecretName(teamId: string): string {
  return `${NEAR_SESSION_SECRET_PREFIX}${teamId}`;
}

export type NearSessionErrorCode = 'signed-out' | 'expired' | 'unavailable';

export class NearSessionError extends Error {
  public readonly code: NearSessionErrorCode;

  public constructor(code: NearSessionErrorCode, message: string) {
    super(message);
    this.name = 'NearSessionError';
    this.code = code;
  }
}

const SIGNED_OUT_MESSAGE = 'You are not signed in to NEAR AI for this team. Sign in first.';
const EXPIRED_MESSAGE = 'Your NEAR sign-in for this team expired. Sign in again.';
const UNAVAILABLE_MESSAGE = 'Could not refresh your NEAR sign-in for this team. Try again in a moment.';
const REFRESH_PATH = '/users/me/access-tokens';
/** NEAR access tokens last about an hour; renewing a little early avoids sending one that is about to lapse. */
const ACCESS_TOKEN_MAX_AGE_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a refused refresh waits for another window that is still writing its newer token. */
const RECHECK_DELAY_MS = 300;
const MAX_LABEL = 80;
const REFRESH_TOKEN_SHAPE = /^rt_\S+$/;

export interface NearSessionOptions {
  teamId: string;
  secrets: SecretStorageLike;
  /** NEAR AI Cloud's API address, ending in /v1. */
  baseUrl: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Waits between re-reads of the stored token after a refused refresh; tests pass a quick one. */
  sleep?: (ms: number) => Promise<void>;
  /** The access token from the sign-in that created the session, so the first call needs no refresh. */
  initialAccessToken?: string;
}

interface StoredSession { v: 1; refreshToken: string; label: string }

function parseStored(text: string | undefined): StoredSession | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { v, refreshToken, label } = record;
  if (v !== 1 || typeof refreshToken !== 'string' || !REFRESH_TOKEN_SHAPE.test(refreshToken)) return undefined;
  if (typeof label !== 'string' || label.length > MAX_LABEL) return undefined;
  return { v: 1, refreshToken, label };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function cleanLabel(label: string): string {
  return label.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

/**
 * Keeps the session a lead just signed in with. The label says whose NEAR account it is, for the
 * sign-out prompt; it is not a secret. The returned session already holds the sign-in's access token.
 */
export async function saveNearSession(
  secrets: SecretStorageLike,
  teamId: string,
  tokens: SessionTokens,
  label: string,
  extra: Partial<Omit<NearSessionOptions, 'teamId' | 'secrets' | 'initialAccessToken'>> & { baseUrl: string }
): Promise<NearSession> {
  if (!REFRESH_TOKEN_SHAPE.test(tokens.refreshToken) || !tokens.accessToken) {
    throw new NearSessionError('unavailable', 'NEAR AI did not send a sign-in this extension can keep. Try signing in again.');
  }
  const stored: StoredSession = { v: 1, refreshToken: tokens.refreshToken, label: cleanLabel(label) };
  await secrets.store(nearSessionSecretName(teamId), JSON.stringify(stored));
  return new NearSession({ ...extra, teamId, secrets, initialAccessToken: tokens.accessToken });
}

export class NearSession implements NearAuth {
  private readonly teamId: string;
  private readonly secrets: SecretStorageLike;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cached: { token: string; obtainedAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  public constructor(options: NearSessionOptions) {
    if (!isSecureEndpoint(options.baseUrl)) throw new RangeError('The NEAR AI address must be HTTPS (plain HTTP is only allowed on this computer).');
    this.teamId = options.teamId;
    this.secrets = options.secrets;
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    if (options.initialAccessToken) this.cached = { token: options.initialAccessToken, obtainedAt: this.now() };
  }

  /** The label of the kept session, or undefined when this team has none (a damaged value is deleted). */
  public async signedIn(): Promise<{ label: string } | undefined> {
    const stored = await this.readStored();
    return stored && { label: stored.label };
  }

  /** A current access token: the one in memory while it is young, otherwise one fresh refresh. */
  public async accessToken(): Promise<string> {
    if (this.cached && this.now() - this.cached.obtainedAt < ACCESS_TOKEN_MAX_AGE_MS) return this.cached.token;
    return this.refresh();
  }

  /** Called after NEAR refused the access token: one forced refresh, or undefined when the session is gone. */
  public async refreshAfterUnauthorized(): Promise<string | undefined> {
    this.cached = undefined;
    try {
      return await this.refresh();
    } catch (error) {
      if (error instanceof NearSessionError && error.code !== 'unavailable') return undefined;
      throw error;
    }
  }

  /**
   * Ends this team's session at NEAR and forgets it here, whether or not NEAR could be reached.
   * With no kept session there is nothing to end, which counts as confirmed.
   */
  public async signOut(): Promise<{ serverConfirmed: boolean }> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    let serverConfirmed = true;
    try {
      const stored = await this.readStored();
      if (stored) serverConfirmed = await logoutAtNear(this.base, stored.refreshToken, this.fetchImpl);
    } finally {
      this.cached = undefined;
      await this.secrets.delete(nearSessionSecretName(this.teamId));
    }
    return { serverConfirmed };
  }

  private refresh(): Promise<string> {
    if (!this.inFlight) {
      const attempt = this.refreshNow().finally(() => { this.inFlight = undefined; });
      this.inFlight = attempt;
    }
    return this.inFlight;
  }

  private async refreshNow(): Promise<string> {
    const stored = await this.readStored();
    if (!stored) {
      this.cached = undefined;
      throw new NearSessionError('signed-out', SIGNED_OUT_MESSAGE);
    }
    let used = stored;
    let answer = await this.requestRefresh(used.refreshToken);
    if (answer === 'refused') {
      // Another window may have rotated the token while this one was waiting: use its newer one once.
      // The winner stores its new token only after NEAR answers it, so an unchanged value is read a
      // second time after a short wait before the refusal is believed.
      let current = await this.readStored();
      if (current && current.refreshToken === used.refreshToken) {
        await this.sleep(RECHECK_DELAY_MS);
        current = await this.readStored();
      }
      if (!current) {
        this.cached = undefined;
        throw new NearSessionError('signed-out', SIGNED_OUT_MESSAGE);
      }
      if (current.refreshToken !== used.refreshToken) {
        used = current;
        answer = await this.requestRefresh(used.refreshToken);
      }
      if (answer === 'refused') {
        this.cached = undefined;
        throw new NearSessionError('expired', EXPIRED_MESSAGE);
      }
    }
    // The single-use token is replaced on disk before the new access token is used anywhere.
    const next: StoredSession = { v: 1, refreshToken: answer.refreshToken, label: used.label };
    try {
      await this.secrets.store(nearSessionSecretName(this.teamId), JSON.stringify(next));
    } catch {
      this.cached = undefined;
      throw new NearSessionError('unavailable', UNAVAILABLE_MESSAGE);
    }
    this.cached = { token: answer.accessToken, obtainedAt: this.now() };
    return answer.accessToken;
  }

  /** One call to the rotating refresh route. 'refused' means NEAR no longer accepts that refresh token. */
  private async requestRefresh(refreshToken: string): Promise<SessionTokens | 'refused'> {
    let response;
    try {
      response = await this.fetchImpl(`${this.base}${REFRESH_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${refreshToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new NearSessionError('unavailable', UNAVAILABLE_MESSAGE);
    }
    if (response.status === 401) return 'refused';
    if (!response.ok) throw new NearSessionError('unavailable', UNAVAILABLE_MESSAGE);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new NearSessionError('unavailable', UNAVAILABLE_MESSAGE);
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const accessToken = record['access_token'];
    const newRefresh = record['refresh_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof newRefresh !== 'string' || !REFRESH_TOKEN_SHAPE.test(newRefresh)) {
      throw new NearSessionError('unavailable', UNAVAILABLE_MESSAGE);
    }
    return { accessToken, refreshToken: newRefresh };
  }

  private async readStored(): Promise<StoredSession | undefined> {
    const name = nearSessionSecretName(this.teamId);
    const text = await this.secrets.get(name);
    if (text === undefined) return undefined;
    const stored = parseStored(text);
    if (!stored) await this.secrets.delete(name);
    return stored;
  }
}
