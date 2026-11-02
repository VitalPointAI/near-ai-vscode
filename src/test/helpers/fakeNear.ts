// An in-memory fake of the NEAR AI Cloud routes Team Mode uses, served over real HTTP on 127.0.0.1.
// It reproduces the real server's traps on purpose, so a client that gets one wrong fails a test:
//   - a spend limit is read only from camelCase `spendLimit`; a snake_case or missing field stores no
//     limit and still answers 200 (a mis-cased body silently removes the cap)
//   - check_api_key answers 402 once usage reaches the limit, so a limit of 0 blocks at once
//   - the key secret is returned by the create call only
//   - a new key can take a while to authenticate (setActivationDelayMs)
// The request log holds the method, the path and the kind of credential, never a token or a key.
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export type FakeRole = 'owner' | 'admin' | 'member';
export type FakeAuthKind = 'session' | 'refresh' | 'api-key' | 'none';

export interface FakeRequest { method: string; path: string; auth: FakeAuthKind; status: number }

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
  close(): Promise<void>;
}

interface UserRecord { id: string; username: string; email: string; accessToken: string; refreshToken: string }
interface OrgRecord { id: string; name: string; members: Map<string, FakeRole> }
interface WorkspaceRecord { id: string; organizationId: string; name: string }
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
}

type Credential = { kind: 'session' | 'refresh'; user: UserRecord } | { kind: 'api-key'; key: KeyRecord } | { kind: 'none' };

const SCALE = 9;
const CURRENCY = 'USD';
const MAX_BODY_BYTES = 1_000_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function startFakeNear(options: { keySecretPrefix?: string } = {}): Promise<FakeNear> {
  const secretPrefix = options.keySecretPrefix ?? 'sk-fake-';
  const users = new Map<string, UserRecord>();
  const orgs = new Map<string, OrgRecord>();
  const workspaces = new Map<string, WorkspaceRecord>();
  const keys = new Map<string, KeyRecord>();
  const requests: FakeRequest[] = [];
  let activationDelayMs = 0;

  const randomToken = (prefix: string) => `${prefix}${randomBytes(18).toString('hex')}`;

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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const entry: FakeRequest = { method, path: url.pathname, auth: kindOfHeader(authHeader), status: 0 };
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

    if (credential.kind !== 'session') return fail(res, entry, 401, 'Invalid or expired token', 'unauthorized');
    const user = credential.user;

    const keyRoute = /^\/v1\/workspaces\/([^/]+)\/api-keys(?:\/([^/]+)(\/spend-limit)?)?$/.exec(path);
    if (keyRoute) {
      const workspaceId = decodeURIComponent(keyRoute[1]);
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return fail(res, entry, 404, 'Workspace not found', 'not_found');
      if (!roleIn(workspace.organizationId, user.id)) return fail(res, entry, 403, 'You are not a member of this organization', 'forbidden');
      const keyId = keyRoute[2] === undefined ? undefined : decodeURIComponent(keyRoute[2]);
      const isLimitRoute = keyRoute[3] !== undefined;

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
          usage: 0
        };
        keys.set(key.id, key);
        return send(res, entry, 201, keyJson(key, { secret: true, usage: false }));
      }

      if (keyId === undefined && method === 'GET') {
        const live = [...keys.values()].filter((key) => key.workspaceId === workspaceId && !key.revoked);
        const { limit, offset } = page(url);
        return send(res, entry, 200, { api_keys: live.slice(offset, offset + limit).map((key) => keyJson(key)), total: live.length, limit, offset });
      }

      if (keyId !== undefined) {
        const key = keys.get(keyId);
        if (!key || key.workspaceId !== workspaceId || key.revoked) return fail(res, entry, 404, 'API key not found', 'not_found');
        if (isLimitRoute && method === 'PATCH') {
          const limit = requestedLimit(body);
          if (!limit.ok) return fail(res, entry, 400, 'spendLimit must be a whole amount of zero or more in USD', 'invalid_request');
          // The real trap: no camelCase spendLimit means "remove the limit", and the answer is still 200.
          key.spendLimit = limit.amount;
          return send(res, entry, 200, keyJson(key));
        }
        if (!isLimitRoute && method === 'DELETE') {
          key.revoked = true;
          return send(res, entry, 204);
        }
      }
    }

    return fail(res, entry, 404, 'No such route', 'not_found');
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
    },
    setActivationDelayMs(ms) {
      activationDelayMs = ms;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
