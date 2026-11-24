// The Theia Cloud service client (eclipse-theia/theia-cloud documentation/openapi.json): workspaces and sessions are created as the person the
// token belongs to, because the service refuses a request whose user is not the authenticated user (BaseResource, 403; research Pitfall 9).
// So every call names one test-realm user and carries that user's token; a refusal is a failed start, never retried as someone else. The app id
// the service checks comes from the environment, not a file, and the tokens come from keycloak.ts and stay in memory.
import type { SessionDriver } from './stages.ts';

export type Fetch = typeof fetch;

export interface TokenSource {
  /** The bearer token of a test-realm user, minted in memory. */
  readonly tokenFor: (user: string) => Promise<string>;
}

export interface ServiceConfig {
  readonly baseUrl: string;
  readonly appId: string;
  readonly appDefinition: string;
  readonly tokens: TokenSource;
  readonly fetch?: Fetch;
  /** Minutes the service waits for a session launch (its own default is 3). */
  readonly startTimeoutMinutes?: number;
}

export class ServiceError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
  }
}

export interface SessionSpec { readonly name: string; readonly url?: string; readonly workspace?: string }

export interface ServiceClient {
  readonly createWorkspace: (user: string) => Promise<string>;
  /** Starts a session in the workspace and returns its address. */
  readonly startSession: (user: string, workspaceName: string, signal?: AbortSignal) => Promise<string>;
  readonly reportActivity: (user: string, sessionName: string) => Promise<void>;
  readonly stopSession: (user: string, sessionName: string) => Promise<void>;
  readonly listSessions: (user: string) => Promise<SessionSpec[]>;
}

export function createServiceClient(config: ServiceConfig): ServiceClient {
  const doFetch = config.fetch ?? fetch;
  const call = async (method: string, path: string, user: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const headers: Record<string, string> = { authorization: `Bearer ${await config.tokens.tokenFor(user)}`, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await doFetch(new URL(path, config.baseUrl), { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    // The body of a refusal is not echoed: it can carry request details, and the message must be safe for a run log.
    if (!response.ok) throw new ServiceError(`${method} ${path.split('/').slice(0, 3).join('/')}: HTTP ${response.status}`, response.status);
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  };
  const segment = encodeURIComponent;
  return {
    createWorkspace: async (user) => {
      const workspace = await call('POST', '/service/workspace', user, { appId: config.appId, user, appDefinition: config.appDefinition, label: 'load test' });
      const name = typeof workspace === 'object' && workspace !== null ? (workspace as { name?: unknown }).name : undefined;
      if (typeof name !== 'string' || !name) throw new ServiceError('POST /service/workspace: no workspace name in the response', 502);
      return name;
    },
    startSession: async (user, workspaceName, signal) => {
      const url = await call('POST', '/service/session', user, { appId: config.appId, user, appDefinition: config.appDefinition, workspaceName, timeout: config.startTimeoutMinutes ?? 3 }, signal);
      if (typeof url !== 'string' || !url) throw new ServiceError('POST /service/session: no session address in the response', 502);
      return url;
    },
    reportActivity: async (user, sessionName) => { await call('PATCH', '/service/session', user, { appId: config.appId, sessionName }); },
    stopSession: async (user, sessionName) => { await call('DELETE', '/service/session', user, { appId: config.appId, user, sessionName }); },
    listSessions: async (user) => {
      const list = await call('GET', `/service/session/${segment(config.appId)}/${segment(user)}`, user);
      return Array.isArray(list) ? (list as SessionSpec[]).filter((item) => typeof item?.name === 'string') : [];
    }
  };
}

/**
 * The controller's session driver over the service: a workspace per person (created once), then the session; the probe asks the session address
 * with the owner's token and counts only a 2xx answer (a redirect to sign in is not a usable session).
 */
export function createSessionDriver(client: ServiceClient, tokens: TokenSource, fetchImpl: Fetch = fetch): SessionDriver {
  const workspaces = new Map<string, string>();
  const owners = new Map<string, string>();
  return {
    startSession: async (user, signal) => {
      let workspace = workspaces.get(user);
      if (workspace === undefined) { workspace = await client.createWorkspace(user); workspaces.set(user, workspace); }
      const url = await client.startSession(user, workspace, signal);
      const sessions = await client.listSessions(user);
      const session = sessions.find((item) => item.workspace === workspace) ?? sessions[0];
      if (session === undefined) throw new ServiceError('the started session is not listed for its user', 502);
      const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      owners.set(address, user);
      return { sessionName: session.name, url: address };
    },
    probe: async (url, signal) => {
      const user = owners.get(url);
      if (user === undefined) return false;
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${await tokens.tokenFor(user)}` }, redirect: 'manual', signal });
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 200 && response.status < 300;
    },
    reportActivity: (user, sessionName) => client.reportActivity(user, sessionName),
    stopSession: (user, sessionName) => client.stopSession(user, sessionName)
  };
}
