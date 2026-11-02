// A typed client for the NEAR AI Cloud organization, invitation, workspace key, spend-limit and
// usage routes Team Mode needs. It never imports `vscode`, sends HTTP only through the injected
// fetch, and never puts a bearer token, a refresh token or a key secret in anything it throws.
//
// Money is whole nano-USD (1 USD = 1,000,000,000). A spend limit is sent in exactly one place,
// spendLimitBody(), as camelCase { spendLimit: { amount, currency } }: NEAR ignores any other
// spelling and, on the spend-limit route, treats a missing field as "remove the limit" while still
// answering 200. Every create and set answer is therefore checked to carry the amount that was sent.
import { isSecureEndpoint } from '../domain/config';
import { redactSecrets } from '../domain/redaction';
import { FetchLike } from '../services/reportingSignIn';

export const NEAR_SPEND_CURRENCY = 'USD';

/** The lead's session: a current access token, and a way to get a new one after NEAR refuses it. */
export interface NearAuth {
  accessToken(): Promise<string>;
  refreshAfterUnauthorized(): Promise<string | undefined>;
}

export type NearOrgErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'bad-request' | 'rate-limited' | 'server' | 'network' | 'bad-response' | 'limit-mismatch';

export class NearOrgError extends Error {
  public readonly status: number;
  public readonly code: NearOrgErrorCode;

  public constructor(status: number, code: NearOrgErrorCode, message: string) {
    super(message);
    this.name = 'NearOrgError';
    this.status = status;
    this.code = code;
  }
}

export type NearRole = 'owner' | 'admin' | 'member';
export interface NearOrganization { id: string; name: string; role: NearRole }
export interface NearWorkspace { id: string; name: string; organizationId: string }
export interface NearOrgMember { userId: string; role: NearRole; email?: string }
export interface NearInvitation { id: string; organizationId: string; email: string; role: string; status: string; expiresAt?: string; organizationName?: string }
export type InviteOutcome = { ok: true; alreadyMember: boolean } | { ok: false; reason: string };
export interface NearKey {
  id: string;
  name: string;
  workspaceId: string;
  createdByUserId?: string;
  isActive: boolean;
  /** Whole nano-USD, or null when the key has no limit. */
  spendLimitNanoUsd: number | null;
  usageNanoUsd: number | null;
}
/** The secret is the `sk-` key; the caller wipes it. It is only ever in the create answer. */
export interface CreatedNearKey { key: NearKey; secret: Buffer }
export interface NearUsageEntry { id: string; model: string; totalCostNanoUsd: number; createdAt: string }
export type CheckedKey =
  | { status: 'valid' | 'capped'; organizationId: string; workspaceId?: string; apiKeyId: string }
  | { status: 'invalid' | 'unavailable'; reason: string };

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const MAX_ERROR_TEXT = 300;
const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const MAX_RETRY_AFTER_MS = 60_000;
const NANO_SCALE = 9;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const enc = encodeURIComponent;

// ---- text that may reach a message or the UI ----

const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\brt_[A-Za-z0-9_-]{6,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g
];

/**
 * NEAR's own words, made safe to show: the credentials this client holds are cut out, anything that
 * looks like a bearer, session, refresh or key secret is hidden, control characters are dropped and
 * the length is bounded.
 */
export function scrubNearText(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  out = redactSecrets(out);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, '[REDACTED]');
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT);
}

/** The message in NEAR's error body: `{error:{message}}`, `{error, error_description}` or `{message}`. */
function bodyMessage(json: unknown): string {
  if (!isObject(json)) return '';
  const error = json['error'];
  if (isObject(error) && typeof error['message'] === 'string') return error['message'];
  if (typeof json['error_description'] === 'string') return json['error_description'];
  if (typeof error === 'string') return error;
  if (typeof json['message'] === 'string') return json['message'];
  return '';
}

function codeForStatus(status: number): NearOrgErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'bad-request';
}

function badResponse(status: number, what: string): NearOrgError {
  return new NearOrgError(status, 'bad-response', `NEAR AI Cloud answered with something unexpected (${what}).`);
}

// ---- reading answers, field by field ----

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw badResponse(0, what);
  return value;
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) throw badResponse(0, `${what}.${key}`);
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireRole(source: Record<string, unknown>, what: string): NearRole {
  const role = source['role'];
  if (role !== 'owner' && role !== 'admin' && role !== 'member') throw badResponse(0, `${what}.role`);
  return role;
}

/**
 * A { amount, scale, currency } price as whole nano-USD, by integer arithmetic only. A scale below 9
 * is multiplied up; a scale above 9 is divided down and rounded up, so a spend figure is never
 * understated. Null and absent mean "none".
 */
function priceToNano(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw badResponse(0, what);
  const { amount, scale, currency } = value;
  if (currency !== NEAR_SPEND_CURRENCY) throw badResponse(0, `${what}.currency`);
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw badResponse(0, `${what}.amount`);
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > 18) throw badResponse(0, `${what}.scale`);
  const whole = BigInt(amount);
  let nano: bigint;
  if (scale === NANO_SCALE) nano = whole;
  else if (scale < NANO_SCALE) nano = whole * 10n ** BigInt(NANO_SCALE - scale);
  else {
    const divisor = 10n ** BigInt(scale - NANO_SCALE);
    nano = (whole + divisor - 1n) / divisor;
  }
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) throw badResponse(0, `${what}.amount`);
  return Number(nano);
}

function parseKey(value: unknown): NearKey {
  const source = requireObject(value, 'key');
  if (typeof source['is_active'] !== 'boolean') throw badResponse(0, 'key.is_active');
  const createdBy = optionalString(source, 'created_by_user_id');
  const name = source['name'];
  return {
    id: requireString(source, 'id', 'key'),
    name: typeof name === 'string' ? name : '',
    workspaceId: requireString(source, 'workspace_id', 'key'),
    ...(createdBy === undefined ? {} : { createdByUserId: createdBy }),
    isActive: source['is_active'],
    spendLimitNanoUsd: priceToNano(source['spend_limit'], 'key.spend_limit'),
    usageNanoUsd: priceToNano(source['usage'], 'key.usage')
  };
}

function parseInvitation(value: unknown): NearInvitation {
  const source = requireObject(value, 'invitation');
  const expiresAt = optionalString(source, 'expires_at');
  const organizationName = optionalString(source, 'organization_name');
  return {
    id: requireString(source, 'id', 'invitation'),
    organizationId: requireString(source, 'organization_id', 'invitation'),
    email: requireString(source, 'email', 'invitation'),
    role: requireString(source, 'role', 'invitation'),
    status: requireString(source, 'status', 'invitation'),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(organizationName === undefined ? {} : { organizationName })
  };
}

function parseInvitationList(value: unknown): NearInvitation[] {
  if (!Array.isArray(value)) throw badResponse(0, 'invitations');
  return value.map(parseInvitation);
}

function checkEmail(email: string): string {
  if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !email.includes('@') || /[\s\u0000-\u001f]/.test(email)) throw new RangeError('That is not an email address.');
  return email;
}

/** The only place a spend limit body is built. A limit is a safe integer of zero or more. */
function spendLimitBody(nanoUsd: number): { spendLimit: { amount: number; currency: typeof NEAR_SPEND_CURRENCY } } {
  if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0) throw new RangeError('A spend limit is a whole number of nano-USD, zero or more.');
  return { spendLimit: { amount: nanoUsd, currency: NEAR_SPEND_CURRENCY } };
}

// ---- the client ----

interface Answer { status: number; json: unknown }

interface SendOptions {
  body?: unknown;
  /** Extra values that must never appear in an error message (an emailed token in the path). */
  secrets?: readonly string[];
  /** Safe to repeat: GET, DELETE and the spend-limit PATCH. POST is never retried. */
  idempotent?: boolean;
  /** Statuses that are returned to the caller instead of thrown. */
  accept?: readonly number[];
}

export interface NearOrgClientOptions {
  baseUrl: string;
  auth: NearAuth;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Seconds from a Retry-After header, as milliseconds, when the response carries one. */
function retryAfterMs(response: object): number | undefined {
  const headers = (response as { headers?: unknown }).headers;
  if (!isObject(headers) || typeof headers['get'] !== 'function') return undefined;
  const raw = (headers['get'] as (name: string) => unknown).call(headers, 'retry-after');
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Math.min(Number(raw.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

export class NearOrgClient {
  private readonly base: string;
  private readonly auth: NearAuth;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  public constructor(options: NearOrgClientOptions) {
    if (!isSecureEndpoint(options.baseUrl)) throw new RangeError('The NEAR AI address must be HTTPS (plain HTTP is only allowed on this computer).');
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_RETRIES));
  }

  // ---- workspace keys ----

  /**
   * Creates a key with its spend limit in the same call. The secret is in this answer only. If the
   * create call fails in a way that may have made the key (a dropped connection, a timeout or a
   * server error), keys with the exact requested name are listed and revoked, so callers must give
   * each key a unique name. A limit that does not come back as sent revokes the new key.
   */
  public async createKey(workspaceId: string, name: string, spendLimitNanoUsd: number): Promise<CreatedNearKey> {
    const body = { name, ...spendLimitBody(spendLimitNanoUsd) };
    const path = `/workspaces/${enc(workspaceId)}/api-keys`;
    let answer: Answer;
    try {
      answer = await this.send('POST', path, { body });
    } catch (error) {
      if (error instanceof NearOrgError && (error.code === 'network' || error.code === 'server')) {
        const note = await this.removeKeysNamed(workspaceId, name);
        throw new NearOrgError(error.status, error.code, `${error.message} ${note}`);
      }
      throw error;
    }
    const raw = answer.json;
    const rawId = isObject(raw) ? optionalString(raw, 'id') : undefined;
    const secretText = isObject(raw) ? optionalString(raw, 'key') : undefined;
    let key: NearKey;
    try {
      key = parseKey(raw);
      if (secretText === undefined) throw badResponse(answer.status, 'key.key');
    } catch (error) {
      if (rawId === undefined) throw error;
      const note = await this.abandonKey(workspaceId, rawId);
      throw new NearOrgError(answer.status, 'bad-response', `${error instanceof Error ? error.message : 'NEAR AI Cloud answered with something unexpected.'} ${note}`);
    }
    if (key.spendLimitNanoUsd !== spendLimitNanoUsd) {
      const note = await this.abandonKey(workspaceId, key.id);
      throw new NearOrgError(answer.status, 'limit-mismatch', `NEAR AI Cloud did not store the spend limit that was sent. ${note}`);
    }
    return { key, secret: Buffer.from(secretText as string, 'utf8') };
  }

  /** Every key in the workspace that is not revoked, with its limit and lifetime usage. */
  public async listKeys(workspaceId: string): Promise<NearKey[]> {
    const rows = await this.pageAll(`/workspaces/${enc(workspaceId)}/api-keys`, 'api_keys');
    return rows.map(parseKey);
  }

  /** NEAR has no single-key read, so the list is paged and matched by id. */
  public async findKey(workspaceId: string, keyId: string): Promise<NearKey | undefined> {
    return (await this.listKeys(workspaceId)).find((key) => key.id === keyId);
  }

  /** Sets the limit. Setting the same limit twice is harmless, so this retries like a GET. */
  public async setSpendLimit(workspaceId: string, keyId: string, nanoUsd: number): Promise<NearKey | 'missing'> {
    const body = spendLimitBody(nanoUsd);
    const answer = await this.send('PATCH', `/workspaces/${enc(workspaceId)}/api-keys/${enc(keyId)}/spend-limit`, { body, idempotent: true, accept: [404] });
    if (answer.status === 404) return 'missing';
    const key = parseKey(answer.json);
    if (key.spendLimitNanoUsd !== nanoUsd) throw new NearOrgError(answer.status, 'limit-mismatch', 'NEAR AI Cloud did not store the spend limit that was sent. The key may be able to spend more than intended.');
    return key;
  }

  public async revokeKey(workspaceId: string, keyId: string): Promise<'revoked' | 'missing'> {
    const answer = await this.send('DELETE', `/workspaces/${enc(workspaceId)}/api-keys/${enc(keyId)}`, { idempotent: true, accept: [404] });
    return answer.status === 404 ? 'missing' : 'revoked';
  }

  // ---- organizations, workspaces and members ----

  public async listOrganizations(): Promise<NearOrganization[]> {
    const rows = await this.pageAll('/organizations', 'organizations');
    return rows.map((row) => {
      const source = requireObject(row, 'organization');
      return { id: requireString(source, 'id', 'organization'), name: requireString(source, 'name', 'organization'), role: requireRole(source, 'organization') };
    });
  }

  public async listWorkspaces(organizationId: string): Promise<NearWorkspace[]> {
    const rows = await this.pageAll(`/organizations/${enc(organizationId)}/workspaces`, 'workspaces');
    return rows.map((row) => {
      const source = requireObject(row, 'workspace');
      return { id: requireString(source, 'id', 'workspace'), name: requireString(source, 'name', 'workspace'), organizationId: requireString(source, 'organization_id', 'workspace') };
    });
  }

  /** Members with their role. The email is there only when the server returns one. */
  public async listMembers(organizationId: string): Promise<NearOrgMember[]> {
    const rows = await this.pageAll(`/organizations/${enc(organizationId)}/members`, 'members');
    return rows.map((row) => {
      const source = requireObject(row, 'member');
      const user = isObject(source['user']) ? source['user'] : {};
      const userId = optionalString(user, 'id') ?? optionalString(source, 'user_id');
      if (userId === undefined) throw badResponse(0, 'member.user.id');
      const email = optionalString(user, 'email') ?? optionalString(source, 'email');
      return { userId, role: requireRole(source, 'member'), ...(email === undefined ? {} : { email }) };
    });
  }

  /** Removes someone from the organization. Needs org owner or admin; the last owner cannot be removed. */
  public async removeMember(organizationId: string, userId: string): Promise<'removed' | 'missing'> {
    const answer = await this.send('DELETE', `/organizations/${enc(organizationId)}/members/${enc(userId)}`, { idempotent: true, accept: [404] });
    return answer.status === 404 ? 'missing' : 'removed';
  }

  // ---- invitations ----

  /**
   * Invites one email address to the organization. NEAR answers 200 even when the address failed, and
   * never returns an invitation id, so the result is read from the per-email answer and the id is
   * found afterwards with listInvitations. An owner cannot be invited, so the role is admin or member.
   */
  public async inviteByEmail(organizationId: string, email: string, role: 'admin' | 'member'): Promise<InviteOutcome> {
    const body = { invitations: [{ email: checkEmail(email), role }] };
    const answer = await this.send('POST', `/organizations/${enc(organizationId)}/members/invite-by-email`, { body });
    const results = requireObject(answer.json, 'invitation answer')['results'];
    const first = Array.isArray(results) ? results[0] : undefined;
    if (!isObject(first) || typeof first['success'] !== 'boolean') throw badResponse(answer.status, 'invitation results');
    if (first['success']) return { ok: true, alreadyMember: false };
    const error = typeof first['error'] === 'string' ? first['error'] : '';
    if (/already a member/i.test(error)) return { ok: true, alreadyMember: true };
    if (/insufficient permission/i.test(error)) return { ok: false, reason: 'Your NEAR role cannot invite people to this organization.' };
    return { ok: false, reason: scrubNearText(error) || 'NEAR AI Cloud did not send the invitation.' };
  }

  public async listInvitations(organizationId: string, status?: 'pending' | 'accepted' | 'declined' | 'expired'): Promise<NearInvitation[]> {
    const query = status === undefined ? '' : `?${new URLSearchParams({ status }).toString()}`;
    const answer = await this.send('GET', `/organizations/${enc(organizationId)}/members/invitations${query}`, { idempotent: true });
    return parseInvitationList(answer.json);
  }

  /** Cancels a pending invitation. NEAR refuses an invitation that is no longer pending. */
  public async cancelInvitation(organizationId: string, invitationId: string): Promise<'cancelled' | 'not-pending'> {
    const answer = await this.send('DELETE', `/organizations/${enc(organizationId)}/members/invitations/${enc(invitationId)}`, { idempotent: true, accept: [400, 404] });
    return answer.status === 400 || answer.status === 404 ? 'not-pending' : 'cancelled';
  }

  /** The signed-in user's own pending invitations, matched by login email. */
  public async myInvitations(): Promise<NearInvitation[]> {
    const answer = await this.send('GET', '/users/me/invitations', { idempotent: true });
    return parseInvitationList(answer.json);
  }

  public async acceptInvitation(invitationId: string): Promise<'accepted' | 'already-member'> {
    const answer = await this.send('POST', `/users/me/invitations/${enc(invitationId)}/accept`, { accept: [409], secrets: [invitationId] });
    return answer.status === 409 ? 'already-member' : 'accepted';
  }

  /** Accepts with the token from the invitation email. The token is a credential: never in a message. */
  public async acceptInvitationToken(token: string): Promise<'accepted' | 'already-member'> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) throw new RangeError('That is not an invitation token.');
    const answer = await this.send('POST', `/invitations/${enc(token)}/accept`, { accept: [409], secrets: [token] });
    return answer.status === 409 ? 'already-member' : 'accepted';
  }

  // ---- usage and the signed-in user ----

  /** One key's spend entries, newest first. A 404 means this route is not offered. */
  public async keyUsageHistory(workspaceId: string, keyId: string, page: { limit: number; offset: number } = { limit: 50, offset: 0 }): Promise<{ entries: NearUsageEntry[]; total: number } | 'not-offered'> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > PAGE_SIZE || !Number.isInteger(page.offset) || page.offset < 0) throw new RangeError('A page is 1 to 100 entries from a whole-number offset.');
    const query = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
    const answer = await this.send('GET', `/workspaces/${enc(workspaceId)}/api-keys/${enc(keyId)}/usage/history?${query.toString()}`, { idempotent: true, accept: [404] });
    if (answer.status === 404) return 'not-offered';
    const body = requireObject(answer.json, 'usage history');
    const data = body['data'];
    const total = body['total'];
    if (!Array.isArray(data) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw badResponse(answer.status, 'usage history');
    const entries = data.map((row): NearUsageEntry => {
      const source = requireObject(row, 'usage entry');
      const cost = source['total_cost'];
      if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) throw badResponse(answer.status, 'usage entry.total_cost');
      return { id: requireString(source, 'id', 'usage entry'), model: requireString(source, 'model', 'usage entry'), totalCostNanoUsd: cost, createdAt: requireString(source, 'created_at', 'usage entry') };
    });
    return { entries, total };
  }

  public async currentUser(): Promise<{ id: string; username: string; email?: string; organizationIds: string[] }> {
    const answer = await this.send('GET', '/users/me', { idempotent: true });
    const source = requireObject(answer.json, 'user');
    const organizations = source['organizations'];
    if (organizations !== null && organizations !== undefined && !Array.isArray(organizations)) throw badResponse(answer.status, 'user.organizations');
    const email = optionalString(source, 'email');
    return {
      id: requireString(source, 'id', 'user'),
      username: requireString(source, 'username', 'user'),
      ...(email === undefined ? {} : { email }),
      organizationIds: (organizations ?? []).map((organization) => requireString(requireObject(organization, 'user.organization'), 'id', 'user.organization'))
    };
  }

  // ---- internals ----

  /** Revokes a key this call made but cannot hand over; says what happened, never throws. */
  private async abandonKey(workspaceId: string, keyId: string): Promise<string> {
    try {
      await this.revokeKey(workspaceId, keyId);
      return 'The new key was revoked.';
    } catch (error) {
      return `The new key could not be revoked (${error instanceof NearOrgError ? error.code : 'unknown'}); revoke it in the NEAR console.`;
    }
  }

  /** Lists and revokes keys with this exact name; says what happened, never throws. */
  private async removeKeysNamed(workspaceId: string, name: string): Promise<string> {
    try {
      const matches = (await this.listKeys(workspaceId)).filter((key) => key.name === name);
      for (const key of matches) await this.revokeKey(workspaceId, key.id);
      return matches.length === 0 ? 'No key with that name was found.' : `Revoked ${matches.length} key${matches.length === 1 ? '' : 's'} with that name that may have been made.`;
    } catch (error) {
      return `Could not check for a key that may have been made (${error instanceof NearOrgError ? error.code : 'unknown'}); look for one in the NEAR console.`;
    }
  }

  /** GET every page of a list route until the reported total is reached. */
  private async pageAll(path: string, field: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(rows.length) });
      const answer = await this.send('GET', `${path}?${query.toString()}`, { idempotent: true });
      const body = requireObject(answer.json, field);
      const items = body[field];
      if (!Array.isArray(items)) throw badResponse(answer.status, field);
      rows.push(...items);
      const total = body['total'];
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw badResponse(answer.status, `${field}.total`);
      if (items.length === 0 || rows.length >= total) return rows;
    }
    throw badResponse(0, `${field} (too many pages)`);
  }

  /**
   * One request. A 401 gets one refresh and one retry (nothing was processed, so even a POST is safe
   * to repeat). Idempotent requests also retry on 429, 5xx and dropped connections, up to maxRetries,
   * honouring Retry-After; a POST is never retried here.
   */
  private async send(method: string, path: string, options: SendOptions = {}): Promise<Answer> {
    let token = await this.auth.accessToken();
    let refreshed = false;
    let attempt = 0;
    const url = `${this.base}${path}`;
    for (;;) {
      let status: number;
      let ok: boolean;
      let text: string;
      let waitHint: number | undefined;
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        status = response.status;
        ok = response.ok;
        waitHint = retryAfterMs(response);
        text = await response.text();
      } catch {
        if (options.idempotent === true && attempt < this.maxRetries) {
          await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new NearOrgError(0, 'network', 'Could not reach NEAR AI Cloud.');
      }

      if (status === 401 && !refreshed) {
        refreshed = true;
        const next = await this.auth.refreshAfterUnauthorized();
        if (next !== undefined) {
          token = next;
          continue;
        }
      }
      if (options.idempotent === true && (status === 429 || status >= 500) && attempt < this.maxRetries) {
        await this.sleep(waitHint ?? BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }

      let json: unknown;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (ok || (options.accept?.includes(status) ?? false)) return { status, json };
      const detail = scrubNearText(bodyMessage(json), [token, ...(options.secrets ?? [])]);
      throw new NearOrgError(status, codeForStatus(status), `NEAR AI Cloud answered HTTP ${status}${detail ? `: ${detail}` : '.'}`);
    }
  }
}

/**
 * Asks NEAR whether an API key works, with the key as the bearer. 200 is valid, 402 is capped (the
 * key's limit or the organization's credit is used up), 401 and 403 are invalid, and anything else,
 * including a dropped connection, is unavailable, never valid. A new key can take several seconds to
 * be accepted, so callers retry an invalid answer for a new key before believing it.
 */
export async function checkApiKey(baseUrl: string, apiKey: Buffer | string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<CheckedKey> {
  if (!isSecureEndpoint(baseUrl)) return { status: 'unavailable', reason: 'The NEAR AI address is not an HTTPS address.' };
  const bearer = typeof apiKey === 'string' ? apiKey : apiKey.toString('utf8');
  let status: number;
  let json: unknown;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/check_api_key`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    status = response.status;
    json = await response.json().catch(() => undefined);
  } catch {
    return { status: 'unavailable', reason: 'Could not reach NEAR AI Cloud.' };
  }
  const body = isObject(json) ? json : {};
  const organizationId = typeof body['organization_id'] === 'string' ? body['organization_id'] : '';
  const apiKeyId = typeof body['api_key_id'] === 'string' ? body['api_key_id'] : '';
  const workspaceId = typeof body['workspace_id'] === 'string' && body['workspace_id'].length > 0 ? body['workspace_id'] : undefined;
  if (status === 200) {
    if (organizationId === '' || apiKeyId === '') return { status: 'unavailable', reason: 'NEAR AI Cloud did not say which organization and key this is.' };
    return { status: 'valid', organizationId, ...(workspaceId === undefined ? {} : { workspaceId }), apiKeyId };
  }
  if (status === 402) return { status: 'capped', organizationId, ...(workspaceId === undefined ? {} : { workspaceId }), apiKeyId };
  if (status === 401 || status === 403) return { status: 'invalid', reason: 'NEAR AI Cloud did not accept this key.' };
  return { status: 'unavailable', reason: `NEAR AI Cloud answered HTTP ${status}.` };
}
