/**
 * The stores behind Theia's KeyStoreService (D-04, D-17 to D-19, D-36, D-37; T-46-25, T-46-27). The six methods have the KeyStoreService
 * shape, so VSIX SecretStorage (through CredentialsService) and the @theia/ai-mcp OAuth store use them unchanged:
 *
 *   openbao      the person's own KV v2 path in your organization's OpenBao, with the session's token on every call
 *   keyring      this computer's keyring (a non-container single machine only; built in keyring-key-store.ts)
 *   unavailable  every method rejects with one plain reason; nothing is ever kept in memory instead
 *
 * The store is chosen once at start by chooseKeyStore and never changes while the backend runs. The OpenBao store reads identity.session()
 * on every call and keeps nothing: no token, no entity id and no secret value outlives the call. Rejections carry only the sentences of
 * SECRET_STORE_TEXT, never a value, a token or an entity id. Nothing here imports Theia.
 */
import { SECRET_STORE_TEXT, type SecretStoreKind } from '../common/secret-store.js';
import type { HostingConfig } from './hosting-config.js';
import { decodeSegment, secretPath, serviceFolder } from './kv-path.js';
import { OpenBaoError, type OpenBaoClient } from './openbao-client.js';
import type { ActiveSession } from './session-identity.js';

/** The KeyStoreService methods (packages/core/src/common/key-store.ts), structurally. */
export interface KeyStore {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | undefined>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findPassword(service: string): Promise<string | undefined>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
  keys(service: string): Promise<string[]>;
}

/** What the stores need from SessionIdentity: the active session, or undefined. */
export interface SessionSource {
  session(): ActiveSession | undefined;
}

/** Turns any failure into one of SECRET_STORE_TEXT's sentences, so no OpenBao detail reaches the extension that asked. */
function plain(error: unknown): Error {
  if (error instanceof OpenBaoError) return new Error(error.kind === 'refused' ? SECRET_STORE_TEXT.refused : SECRET_STORE_TEXT.unreachable);
  if (error instanceof Error && (Object.values(SECRET_STORE_TEXT) as string[]).includes(error.message)) return error;
  return new Error(SECRET_STORE_TEXT.unreachable);
}

export function createOpenBaoKeyStore(identity: SessionSource, mounts: { readonly kvMount: string }): KeyStore {
  const kv = mounts.kvMount;

  async function withSession<T>(work: (session: ActiveSession, client: OpenBaoClient) => Promise<T>): Promise<T> {
    const session = identity.session();
    if (session === undefined) throw new Error(SECRET_STORE_TEXT.notReady);
    try {
      return await work(session, session.client);
    } catch (error) {
      throw plain(error);
    }
  }

  async function read(session: ActiveSession, path: string): Promise<string | undefined> {
    const answer = await session.client.request('GET', `${kv}/data/${path}`, { token: session.token });
    if (answer.status === 404) return undefined;
    const password = (answer.json as { data?: { data?: { password?: unknown } } } | undefined)?.data?.data?.password;
    return typeof password === 'string' ? password : undefined;
  }

  async function list(session: ActiveSession, service: string): Promise<string[]> {
    const answer = await session.client.request('GET', `${kv}/metadata/${serviceFolder(session.entityId, service)}?list=true`, { token: session.token });
    if (answer.status === 404) return [];
    const names = (answer.json as { data?: { keys?: unknown } } | undefined)?.data?.keys;
    if (!Array.isArray(names)) return [];
    const accounts: string[] = [];
    for (const name of names) {
      // A folder (ends in "/") or a name this store could not have written is not one of the person's secrets.
      if (typeof name !== 'string' || name.endsWith('/')) continue;
      try { accounts.push(decodeSegment(name)); } catch { /* skipped */ }
    }
    return accounts;
  }

  async function credentials(session: ActiveSession, service: string): Promise<Array<{ account: string; password: string }>> {
    const found: Array<{ account: string; password: string }> = [];
    for (const account of await list(session, service)) {
      const password = await read(session, secretPath(session.entityId, service, account));
      if (password !== undefined) found.push({ account, password });
    }
    return found;
  }

  return {
    setPassword: (service, account, password) => withSession(async (session, client) => {
      await client.request('POST', `${kv}/data/${secretPath(session.entityId, service, account)}`, { token: session.token, body: { data: { password } } });
    }),
    getPassword: (service, account) => withSession((session) => read(session, secretPath(session.entityId, service, account))),
    // Metadata, not data: a data delete is a soft delete that keeps every version readable by an operator; this removes them all.
    deletePassword: (service, account) => withSession(async (session, client) => {
      const path = `${kv}/metadata/${secretPath(session.entityId, service, account)}`;
      const existing = await client.request('GET', path, { token: session.token });
      if (existing.status === 404) return false;
      await client.request('DELETE', path, { token: session.token });
      return true;
    }),
    findPassword: (service) => withSession(async (session) => (await credentials(session, service))[0]?.password),
    findCredentials: (service) => withSession((session) => credentials(session, service)),
    keys: (service) => withSession((session) => list(session, service)),
  };
}

/** A store whose six methods all reject with `reason`; no method ever resolves (D-04, D-18). */
export function createUnavailableKeyStore(reason: string): KeyStore {
  const refuse = (): Promise<never> => Promise.reject(new Error(reason));
  return {
    setPassword: refuse,
    getPassword: refuse,
    deletePassword: refuse,
    findPassword: refuse,
    findCredentials: refuse,
    keys: refuse,
  };
}

/** A keyring store that can be asked, once, whether this computer's keyring loads and answers. */
export interface KeyringCandidate extends KeyStore {
  /** Resolves when the keyring loads and answers; rejects otherwise. Never falls back to memory. */
  probe(): Promise<void>;
}

export interface KeyStoreChoice {
  readonly kind: SecretStoreKind;
  readonly store: KeyStore;
  /** Present only when kind is unavailable. */
  readonly reason?: string;
}

export interface KeyStoreDeps {
  readonly identity: SessionSource;
  /** Makes the keyring store; called only in local mode. */
  readonly keyring: () => KeyringCandidate;
}

/** Node's codes for a module or native binding that is not there at all (the image does not build keytar, research C5). */
const MISSING_MODULE = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED']);

/**
 * The start-time choice (D-18, D-36): hosted mode is always OpenBao (the keyring is never touched); local mode is the keyring when it loads
 * and answers, and otherwise unavailable with the reason. There is no fourth branch: never an in-memory store.
 */
export async function chooseKeyStore(config: HostingConfig, deps: KeyStoreDeps): Promise<KeyStoreChoice> {
  if (config.mode === 'hosted') return { kind: 'openbao', store: createOpenBaoKeyStore(deps.identity, { kvMount: config.kvMount }) };
  let keyring: KeyringCandidate;
  try {
    keyring = deps.keyring();
    await keyring.probe();
  } catch (error) {
    const code = (error as { cause?: { code?: unknown }; code?: unknown } | undefined)?.cause?.code ?? (error as { code?: unknown } | undefined)?.code;
    const reason = typeof code === 'string' && MISSING_MODULE.has(code) ? SECRET_STORE_TEXT.noStore : SECRET_STORE_TEXT.keyringFailed;
    return { kind: 'unavailable', store: createUnavailableKeyStore(reason), reason };
  }
  return { kind: 'keyring', store: keyring };
}

/** The store Theia resolves: every call waits for the start-time choice, then goes to the chosen store. */
export function createDelegatingKeyStore(choice: () => Promise<KeyStoreChoice>): KeyStore {
  const store = async (): Promise<KeyStore> => (await choice()).store;
  return {
    setPassword: async (service, account, password) => (await store()).setPassword(service, account, password),
    getPassword: async (service, account) => (await store()).getPassword(service, account),
    deletePassword: async (service, account) => (await store()).deletePassword(service, account),
    findPassword: async (service) => (await store()).findPassword(service),
    findCredentials: async (service) => (await store()).findCredentials(service),
    keys: async (service) => (await store()).keys(service),
  };
}
