// An in-memory fake of the NEAR AI Cloud routes Team Mode uses, served over real HTTP on 127.0.0.1.
// It reproduces the real server's traps on purpose, so a client that gets one wrong fails a test:
//   - a spend limit is read only from camelCase `spendLimit`; a snake_case or missing field stores no
//     limit and still answers 200 (a mis-cased body silently removes the cap)
//   - check_api_key answers 402 once usage reaches the limit, so a limit of 0 blocks at once
//   - the key secret is returned by the create call only
//   - a new key can take a while to authenticate (setActivationDelayMs)
//   - invite-by-email answers 200 with one result per email and never an invitation id
//   - an invitation is visible only to the user whose login email matches
//   - a refresh token is single use: refreshing returns a new one and the old one answers 401
//   - invite, cancel and member removal need org owner or admin; key routes need any membership
// The request log holds the method, the path and the kind of credential, never a token or a key.
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export type FakeRole = 'owner' | 'admin' | 'member';
export type FakeAuthKind = 'session' | 'refresh' | 'api-key' | 'none';

export interface FakeRequest { method: string; path: string; auth: FakeAuthKind; status: number }

export interface FakeFailRule {
  method: string;
  pathPrefix: string;
  /** An HTTP status to answer, or 'drop' to destroy the connection. */
  status: number | 'drop';
  /** How many matching requests fail before the route behaves normally again. */
  times: number;
  retryAfterSeconds?: number;
  /** The error message in the body. Defaults to a plain one. */
  message?: string;
  /** Do the route's work first, then fail: the request took effect but the caller never hears so. */
  afterEffect?: boolean;
}

export interface FakeNear {
  /** http://127.0.0.1:<port>/v1 */
  baseUrl: string;
  requests: FakeRequest[];
  addUser(user: { id: string; username: string; email: string }): { accessToken: string; refreshToken: string };
  addOrganization(org: { id: string; name: string; members: Array<{ userId: string; role: FakeRole }> }): void;
  addWorkspace(ws: { id: string; organizationId: string; name: string }): void;
  key(id: string): { spendLimitNanoUsd: number | null; usageNanoUsd: number; revoked: boolean; secret: string } | undefined;
  addUsage(keyId: string, nanoUsd: number): void;
  setActivationDelayMs(ms: number): void;
  fail(rule: FakeFailRule): void;
  /** The token in the invitation email for this address, when an invitation is pending. */
  emailedToken(email: string): string | undefined;
  close(): Promise<void>;
}

interface UserRecord { id: string; username: string; email: string; accessToken: string; refreshToken: string }
interface OrgRecord { id: string; name: string; members: Map<string, FakeRole> }
interface WorkspaceRecord { id: string; organizationId: string; name: string }
interface InvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  role: FakeRole;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token: string;
  invitedBy: string;
  createdAt: string;
}
interface UsageRecord { id: string; model: string; totalCost: number; createdAt: string }
interface KeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  secret: string;
  createdBy: string;
  createdAtMs: number;
  revoked: boolean;
  spendLimit: number | null;
  usage: number;
  history: UsageRecord[];
}

type Credential = { kind: 'session' | 'refresh'; user: UserRecord } | { kind: 'api-key'; key: KeyRecord } | { kind: 'none' };

const SCALE = 9;
const CURRENCY = 'USD';
const MAX_BODY_BYTES = 1_000_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function startFakeNear(options: { keySecretPrefix?: string; membersIncludeEmail?: boolean } = {}): Promise<FakeNear> {
  const secretPrefix = options.keySecretPrefix ?? 'sk-fake-';
  const users = new Map<string, UserRecord>();
  const orgs = new Map<string, OrgRecord>();
  const workspaces = new Map<string, WorkspaceRecord>();
  const keys = new Map<string, KeyRecord>();
  const invitations: InvitationRecord[] = [];
  const faults: FakeFailRule[] = [];
  const requests: FakeRequest[] = [];
  const suppressed = new WeakSet<FakeRequest>();
  let activationDelayMs = 0;

  const randomToken = (prefix: string) => `${prefix}${randomBytes(18).toString('hex')}`;
  const nowIso = () => new Date().toISOString();

  const credentialOf = (header: string | undefined): Credential => {
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) return { kind: 'none' };
    const token = match[1];
    for (const user of users.values()) {
      if (user.accessToken === token) return { kind: 'session', user };
      if (user.refreshToken === token) return { kind: 'refresh', user };
    }
    for (const key of keys.values()) if (key.secret === token) return { kind: 'api-key', key };
    return { kind: 'none' };
  };

  const kindOfHeader = (header: string | undefined): FakeAuthKind => {
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) return 'none';
    const credential = credentialOf(header);
    if (credential.kind !== 'none') return credential.kind;
    // An unknown or stale bearer is still logged by what it looks like, never by its value.
    if (match[1].startsWith('rt_')) return 'refresh';
    if (match[1].startsWith(secretPrefix)) return 'api-key';
    return 'session';
  };

  const roleIn = (orgId: string, userId: string): FakeRole | undefined => orgs.get(orgId)?.members.get(userId);
  const canManage = (role: FakeRole | undefined) => role === 'owner' || role === 'admin';
  const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  const readBody = (req: IncomingMessage): Promise<{ raw: string; tooLarge: boolean }> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks).toString('utf8'), tooLarge: size > MAX_BODY_BYTES }));
    req.on('error', reject);
  });

  const send = (res: ServerResponse, entry: FakeRequest, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (suppressed.has(entry)) return;
    entry.status = status;
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const fail = (res: ServerResponse, entry: FakeRequest, status: number, message: string, type: string) => send(res, entry, status, { error: { message, type } });

  const price = (nano: number) => ({ amount: nano, scale: SCALE, currency: CURRENCY });

  const keyJson = (key: KeyRecord, extra: { secret?: boolean; usage?: boolean } = {}) => ({
    id: key.id,
    key: extra.secret ? key.secret : null,
    key_prefix: key.secret.slice(0, 8),
    name: key.name,
    workspace_id: key.workspaceId,
    created_by_user_id: key.createdBy,
    created_at: new Date(key.createdAtMs).toISOString(),
    expires_at: null,
    is_active: !key.revoked,
    last_used_at: null,
    deleted_at: null,
    spend_limit: key.spendLimit === null ? null : price(key.spendLimit),
    usage: extra.usage === false ? null : price(key.usage)
  });

  /** The limit a request body asks for, read the way the real server does: camelCase `spendLimit` only. */
  const requestedLimit = (body: unknown): { ok: true; amount: number | null } | { ok: false } => {
    if (!isObject(body)) return { ok: true, amount: null };
    const limit = body['spendLimit'];
    if (limit === undefined || limit === null) return { ok: true, amount: null };
    if (!isObject(limit) || limit['currency'] !== CURRENCY) return { ok: false };
    const amount = limit['amount'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return { ok: false };
    return { ok: true, amount };
  };

  /** The real list routes default to 20 rows and cap a page at 100. */
  const page = (url: URL): { limit: number; offset: number } => ({
    limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100),
    offset: Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  });

  const paged = <T>(url: URL, rows: T[]): { rows: T[]; total: number; limit: number; offset: number } => {
    const { limit, offset } = page(url);
    return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  };

  const invitationJson = (invitation: InvitationRecord) => ({
    id: invitation.id,
    organization_id: invitation.organizationId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invited_by_user_id: invitation.invitedBy,
    created_at: invitation.createdAt,
    expires_at: new Date(Date.parse(invitation.createdAt) + 7 * 86_400_000).toISOString(),
    responded_at: null,
    email_status: 'sent'
  });

  const memberJson = (orgId: string, userId: string, role: FakeRole) => ({ id: `member-${userId}`, organization_id: orgId, user_id: userId, role, joined_at: nowIso(), invited_by: null });

  const acceptInto = (invitation: InvitationRecord, user: UserRecord) => {
    orgs.get(invitation.organizationId)?.members.set(user.id, invitation.role);
    invitation.status = 'accepted';
    return { message: 'Invitation accepted', organization_member: memberJson(invitation.organizationId, user.id, invitation.role) };
  };

  // ---- routes ----

  const route = async (res: ServerResponse, entry: FakeRequest, method: string, url: URL, body: unknown, authHeader: string | undefined): Promise<void> => {
    const credential = credentialOf(authHeader);
    const path = url.pathname;

    // The one route a key authenticates by itself.
    if (method === 'POST' && path === '/v1/check_api_key') {
      if (credential.kind !== 'api-key' || credential.key.revoked || Date.now() - credential.key.createdAtMs < activationDelayMs) {
        return fail(res, entry, 401, 'Invalid or expired API key', 'unauthorized');
      }
      const key = credential.key;
      if (key.spendLimit !== null && key.usage >= key.spendLimit) return fail(res, entry, 402, 'API key spend limit exceeded', 'api_key_limit_exceeded');
      const workspace = workspaces.get(key.workspaceId);
      return send(res, entry, 200, { api_key_id: key.id, organization_id: workspace?.organizationId ?? '', workspace_id: key.workspaceId, valid: true });
    }

    // Refresh-token routes. The refresh token is single use: a new pair replaces the old one.
    if (method === 'POST' && path === '/v1/users/me/access-tokens') {
      if (credential.kind !== 'refresh') return send(res, entry, 401, { error: 'invalid_token', error_description: 'Invalid or expired refresh token' });
      const user = credential.user;
      user.accessToken = randomToken('fa-');
      user.refreshToken = randomToken('rt_');
      return send(res, entry, 200, { access_token: user.accessToken, refresh_token: user.refreshToken, refresh_token_expiration: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    }
    if (method === 'POST' && path === '/v1/auth/logout') {
      // Idempotent: a token that is already dead is answered the same way. Only this session ends.
      if (credential.kind === 'refresh') {
        credential.user.accessToken = randomToken('fa-');
        credential.user.refreshToken = randomToken('rt_');
      }
      return send(res, entry, 200, { message: 'Logged out successfully' });
    }

    if (credential.kind !== 'session') return fail(res, entry, 401, 'Invalid or expired token', 'unauthorized');
    const user = credential.user;

    if (method === 'GET' && path === '/v1/users/me') {
      const mine = [...orgs.values()].filter((org) => org.members.has(user.id));
      return send(res, entry, 200, {
        id: user.id,
        username: user.username,
        email: user.email,
        auth_provider: 'github',
        is_active: true,
        organizations: mine.map((org) => ({ id: org.id, name: org.name, role: org.members.get(user.id), is_active: true, created_at: nowIso() })),
        workspaces: []
      });
    }

    if (method === 'GET' && path === '/v1/users/me/invitations') {
      const mine = invitations.filter((invitation) => invitation.status === 'pending' && sameEmail(invitation.email, user.email));
      return send(res, entry, 200, mine.map((invitation) => ({ ...invitationJson(invitation), organization_name: orgs.get(invitation.organizationId)?.name ?? '', invited_by_display_name: null })));
    }

    const acceptById = /^\/v1\/users\/me\/invitations\/([^/]+)\/accept$/.exec(path);
    if (method === 'POST' && acceptById) {
      const invitation = invitations.find((candidate) => candidate.id === decodeURIComponent(acceptById[1]) && sameEmail(candidate.email, user.email));
      if (!invitation) return fail(res, entry, 404, 'Invitation not found', 'not_found');
      if (roleIn(invitation.organizationId, user.id)) return fail(res, entry, 409, 'User is already a member of this organization', 'conflict');
      if (invitation.status !== 'pending') return fail(res, entry, 400, 'Invitation is no longer pending', 'invalid_request');
      return send(res, entry, 200, acceptInto(invitation, user));
    }

    const acceptByToken = /^\/v1\/invitations\/([^/]+)\/accept$/.exec(path);
    if (method === 'POST' && acceptByToken) {
      const invitation = invitations.find((candidate) => candidate.token === decodeURIComponent(acceptByToken[1]));
      if (!invitation) return fail(res, entry, 404, 'Invitation not found', 'not_found');
      if (!sameEmail(invitation.email, user.email)) return fail(res, entry, 403, 'This invitation was sent to a different email address', 'forbidden');
      if (roleIn(invitation.organizationId, user.id)) return fail(res, entry, 409, 'User is already a member of this organization', 'conflict');
      if (invitation.status !== 'pending') return fail(res, entry, 400, 'Invitation is no longer pending', 'invalid_request');
      return send(res, entry, 200, acceptInto(invitation, user));
    }

    if (method === 'GET' && path === '/v1/organizations') {
      const mine = [...orgs.values()].filter((org) => org.members.has(user.id));
      const { rows, total, limit, offset } = paged(url, mine);
      return send(res, entry, 200, {
        organizations: rows.map((org) => ({ id: org.id, name: org.name, description: null, is_active: true, owner_id: [...org.members].find(([, role]) => role === 'owner')?.[0] ?? '', role: org.members.get(user.id), created_at: nowIso(), updated_at: nowIso(), settings: {} })),
        total,
        limit,
        offset
      });
    }

    const orgRoute = /^\/v1\/organizations\/([^/]+)\/(workspaces|members(?:\/.*)?)$/.exec(path);
    if (orgRoute) {
      const orgId = decodeURIComponent(orgRoute[1]);
      const org = orgs.get(orgId);
      if (!org) return fail(res, entry, 404, 'Organization not found', 'not_found');
      const role = org.members.get(user.id);
      if (!role) return fail(res, entry, 403, 'You are not a member of this organization', 'forbidden');
      const rest = orgRoute[2];

      if (method === 'GET' && rest === 'workspaces') {
        const { rows, total, limit, offset } = paged(url, [...workspaces.values()].filter((ws) => ws.organizationId === orgId));
        return send(res, entry, 200, { workspaces: rows.map((ws) => ({ id: ws.id, name: ws.name, description: null, organization_id: ws.organizationId, is_active: true, created_by_user_id: user.id })), total, limit, offset });
      }

      if (method === 'GET' && rest === 'members') {
        const { rows, total, limit, offset } = paged(url, [...org.members]);
        const members = rows.map(([userId, memberRole]) => {
          const record = users.get(userId);
          return {
            id: `member-${userId}`,
            organization_id: orgId,
            role: memberRole,
            joined_at: nowIso(),
            user: { id: userId, username: record?.username ?? null, display_name: null, created_at: nowIso(), ...(options.membersIncludeEmail === true && record ? { email: record.email } : {}) }
          };
        });
        return send(res, entry, 200, { members, total, limit, offset });
      }

      if (method === 'POST' && rest === 'members/invite-by-email') {
        if (!canManage(role)) return fail(res, entry, 403, 'Only owners and admins can invite members', 'forbidden');
        const asked = isObject(body) && Array.isArray(body['invitations']) ? body['invitations'] : undefined;
        if (!asked || asked.length === 0) return fail(res, entry, 400, 'invitations is required', 'invalid_request');
        const results = asked.map((item) => {
          const email = isObject(item) && typeof item['email'] === 'string' ? item['email'] : '';
          const wanted = isObject(item) ? item['role'] : undefined;
          const result = (success: boolean, error?: string) => ({ email, success, email_sent: success, error: error ?? null, email_error: null, member: null });
          if (email === '' || (wanted !== 'owner' && wanted !== 'admin' && wanted !== 'member')) return result(false, 'Invalid email or role');
          if (wanted === 'owner') return result(false, 'Owner invitations are disabled');
          if ([...org.members.keys()].some((memberId) => { const record = users.get(memberId); return record !== undefined && sameEmail(record.email, email); })) return result(false, 'User is already a member of this organization');
          if (invitations.some((invitation) => invitation.organizationId === orgId && invitation.status === 'pending' && sameEmail(invitation.email, email))) return result(false, 'An invitation is already pending for this email');
          invitations.push({ id: `inv_${randomBytes(6).toString('hex')}`, organizationId: orgId, email, role: wanted, status: 'pending', token: randomToken('invtok-'), invitedBy: user.id, createdAt: nowIso() });
          return result(true);
        });
        const successful = results.filter((result) => result.success).length;
        return send(res, entry, 200, { results, total: results.length, successful, failed: results.length - successful });
      }

      if (method === 'GET' && rest === 'members/invitations') {
        if (!canManage(role)) return fail(res, entry, 403, 'Only owners and admins can list invitations', 'forbidden');
        const status = url.searchParams.get('status');
        return send(res, entry, 200, invitations.filter((invitation) => invitation.organizationId === orgId && (status === null || invitation.status === status)).map(invitationJson));
      }

      const cancel = /^members\/invitations\/([^/]+)$/.exec(rest);
      if (method === 'DELETE' && cancel) {
        if (!canManage(role)) return fail(res, entry, 403, 'Only owners and admins can cancel invitations', 'forbidden');
        const index = invitations.findIndex((invitation) => invitation.organizationId === orgId && invitation.id === decodeURIComponent(cancel[1]));
        if (index < 0) return fail(res, entry, 404, 'Invitation not found', 'not_found');
        if (invitations[index].status !== 'pending') return fail(res, entry, 400, 'Only pending invitations can be cancelled', 'invalid_request');
        invitations.splice(index, 1);
        return send(res, entry, 204);
      }

      const remove = /^members\/([^/]+)$/.exec(rest);
      if (method === 'DELETE' && remove) {
        const targetId = decodeURIComponent(remove[1]);
        const targetRole = org.members.get(targetId);
        if (!canManage(role) && targetId !== user.id) return fail(res, entry, 403, 'Only owners and admins can remove members', 'forbidden');
        if (targetRole === undefined) return fail(res, entry, 404, 'Member not found', 'not_found');
        if (role === 'admin' && targetRole === 'owner') return fail(res, entry, 403, 'An admin cannot remove an owner', 'forbidden');
        if (targetRole === 'owner' && [...org.members.values()].filter((memberRole) => memberRole === 'owner').length === 1) return fail(res, entry, 400, 'Cannot remove the last owner of an organization', 'invalid_request');
        org.members.delete(targetId);
        return send(res, entry, 204);
      }
    }

    const keyRoute = /^\/v1\/workspaces\/([^/]+)\/api-keys(?:\/([^/]+)(\/spend-limit|\/usage\/history)?)?$/.exec(path);
    if (keyRoute) {
      const workspaceId = decodeURIComponent(keyRoute[1]);
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return fail(res, entry, 404, 'Workspace not found', 'not_found');
      if (!roleIn(workspace.organizationId, user.id)) return fail(res, entry, 403, 'You are not a member of this organization', 'forbidden');
      const keyId = keyRoute[2] === undefined ? undefined : decodeURIComponent(keyRoute[2]);
      const suffix = keyRoute[3];

      if (keyId === undefined && method === 'POST') {
        if (!isObject(body) || typeof body['name'] !== 'string' || body['name'].length === 0) return fail(res, entry, 400, 'name is required', 'invalid_request');
        const limit = requestedLimit(body);
        if (!limit.ok) return fail(res, entry, 400, 'spendLimit must be a whole amount of zero or more in USD', 'invalid_request');
        const key: KeyRecord = {
          id: `key_${randomBytes(6).toString('hex')}`,
          workspaceId,
          name: body['name'],
          secret: randomToken(secretPrefix),
          createdBy: user.id,
          createdAtMs: Date.now(),
          revoked: false,
          spendLimit: limit.amount,
          usage: 0,
          history: []
        };
        keys.set(key.id, key);
        return send(res, entry, 201, keyJson(key, { secret: true, usage: false }));
      }

      if (keyId === undefined && method === 'GET') {
        const { rows, total, limit, offset } = paged(url, [...keys.values()].filter((key) => key.workspaceId === workspaceId && !key.revoked));
        return send(res, entry, 200, { api_keys: rows.map((key) => keyJson(key)), total, limit, offset });
      }

      if (keyId !== undefined) {
        const key = keys.get(keyId);
        if (!key || key.workspaceId !== workspaceId || key.revoked) return fail(res, entry, 404, 'API key not found', 'not_found');
        if (suffix === '/spend-limit' && method === 'PATCH') {
          const limit = requestedLimit(body);
          if (!limit.ok) return fail(res, entry, 400, 'spendLimit must be a whole amount of zero or more in USD', 'invalid_request');
          // The real trap: no camelCase spendLimit means "remove the limit", and the answer is still 200.
          key.spendLimit = limit.amount;
          return send(res, entry, 200, keyJson(key));
        }
        if (suffix === '/usage/history' && method === 'GET') {
          const { rows, total, limit, offset } = paged(url, [...key.history].reverse());
          return send(res, entry, 200, {
            data: rows.map((row) => ({ id: row.id, workspace_id: workspaceId, api_key_id: key.id, model: row.model, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, total_cost: row.totalCost, total_cost_display: `$${(row.totalCost / 10 ** SCALE).toFixed(6)}`, inference_type: 'chat_completion', created_at: row.createdAt })),
            total,
            limit,
            offset
          });
        }
        if (suffix === undefined && method === 'DELETE') {
          key.revoked = true;
          return send(res, entry, 204);
        }
      }
    }

    return fail(res, entry, 404, 'No such route', 'not_found');
  };

  const applyFault = (req: IncomingMessage, res: ServerResponse, entry: FakeRequest, rule: FakeFailRule) => {
    if (rule.status === 'drop') {
      entry.status = 0;
      req.socket.destroy();
      return;
    }
    send(res, entry, rule.status, { error: { message: rule.message ?? 'Injected failure', type: 'injected' } }, rule.retryAfterSeconds === undefined ? {} : { 'retry-after': String(rule.retryAfterSeconds) });
  };

  /** A path as logged: the emailed invitation token is a credential, so it is never kept. */
  const loggedPath = (path: string) => path.replace(/^(\/v1\/invitations\/)[^/]+(\/accept)$/, '$1:token$2');

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const entry: FakeRequest = { method, path: loggedPath(url.pathname), auth: kindOfHeader(authHeader), status: 0 };
    requests.push(entry);

    const { raw, tooLarge } = await readBody(req);
    if (tooLarge) return fail(res, entry, 413, 'Request body too large', 'invalid_request');
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, entry, 400, 'Request body is not JSON', 'invalid_request');
      }
    }

    const rule = faults.find((candidate) => candidate.times > 0 && candidate.method === method && url.pathname.startsWith(candidate.pathPrefix));
    if (rule) {
      rule.times -= 1;
      if (rule.afterEffect !== true) return applyFault(req, res, entry, rule);
      suppressed.add(entry);
      await route(res, entry, method, url, body, authHeader);
      suppressed.delete(entry);
      return applyFault(req, res, entry, rule);
    }
    return route(res, entry, method, url, body, authHeader);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake server failure', type: 'server_error' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    addUser(user) {
      const record: UserRecord = { ...user, accessToken: randomToken('fa-'), refreshToken: randomToken('rt_') };
      users.set(user.id, record);
      return { accessToken: record.accessToken, refreshToken: record.refreshToken };
    },
    addOrganization(org) {
      orgs.set(org.id, { id: org.id, name: org.name, members: new Map(org.members.map((member) => [member.userId, member.role])) });
    },
    addWorkspace(ws) {
      workspaces.set(ws.id, { ...ws });
    },
    key(id) {
      const key = keys.get(id);
      return key && { spendLimitNanoUsd: key.spendLimit, usageNanoUsd: key.usage, revoked: key.revoked, secret: key.secret };
    },
    addUsage(keyId, nanoUsd) {
      const key = keys.get(keyId);
      if (!key) throw new Error(`The fake has no key ${keyId}.`);
      key.usage += nanoUsd;
      key.history.push({ id: `use_${randomBytes(6).toString('hex')}`, model: 'fake-model', totalCost: nanoUsd, createdAt: nowIso() });
    },
    setActivationDelayMs(ms) {
      activationDelayMs = ms;
    },
    fail(rule) {
      faults.push({ ...rule });
    },
    emailedToken(email) {
      return invitations.find((invitation) => invitation.status === 'pending' && sameEmail(invitation.email, email))?.token;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
