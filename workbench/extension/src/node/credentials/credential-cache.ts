/**
 * The person's verified credentials in a hosted session (Phase 71, 71-13; D-11, D-15, D-18, research 4.1 and 4.3). Backend only; nothing here
 * imports Theia.
 *
 *   rules      your organization's signed rules (STERLING_ORGANIZATION_POLICY, checked against STERLING_ORGANIZATION_POLICY_KEY): credentials@1 and
 *              the scales. Without them, or without credentials@1, the session has no credential state and nothing changes (D-08).
 *   wallet     the extension's own Wallet (src/gate/wallet.ts) over the person's wallet folder in OpenBao (kv/<space>/<entity>/credentials-wallet/,
 *              which the inbox pickup fills, read with the person's own token): the same checker the fold uses, never a copy of it.
 *   trust      HubTrustSource (src/gate/hubTrustSource.ts) over the person's hub session through the replica's pinned connection: logs and lists,
 *              fetched again a tenth of the time to live early (Wallet.keepFresh). A decision never waits on it.
 *   state      fresh | stale (past the time to live: protected actions are refused, Retry) | unavailable (a needed log or list cannot be read:
 *              connect to your organization's server, then Retry), with its sentence; read by the status RPC. Nothing waits silently.
 *   release    the key release check (src/staff/replica/keyRelease.ts) the staff engine's key ring asks; it refuses everything once the session
 *              has ended or OpenBao refused the person's own token (an entity disabled), even for epochs already granted.
 *
 * Credential code takes TokenFacts only (token-facts.ts), never the raw sign-in token. No credential body, key, token or status index is logged.
 */
import type { TokenFacts } from './token-facts.js';

export const CredentialCacheId = Symbol('CredentialCache');

export type CredentialState = 'fresh' | 'stale' | 'unavailable';

/** What the browser is told: the state, its sentence and, where the person can act, the action word. */
export interface CredentialStatus {
  readonly state: CredentialState;
  readonly message: string;
  readonly action?: string;
}

/** A trust fetch through the replica's hub connection (HubTransport.trustSession). */
export interface CacheHubFetch {
  getLog(path: string): Promise<string | undefined>;
  getList(name: string): Promise<string | undefined>;
  getWitness?(path: string): Promise<string | undefined>;
}

/** The release decision as the key ring reads it (keyRelease.ts ReleaseDecision). */
export type CacheReleaseDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly sentence: string; readonly action?: 'retry' | 'connect' };
export type CacheReleaseCheck = (cell: string, label: unknown) => CacheReleaseDecision;

/** The rules in force as the engine's checks take them: credentials@1, the scales and the approved mappings. */
export interface CachePolicy {
  readonly section: {
    readonly root: { readonly did: string };
    readonly issuance: Readonly<Record<string, { readonly role: string } | undefined>>;
    readonly statusLists: readonly { readonly uri: string; readonly purpose: 'revocation' | 'suspension'; readonly key: string }[];
    readonly statusTtl: number;
  };
  readonly scales: unknown;
  readonly mappings: readonly unknown[];
}

interface EngineWalletView { readonly cache: { readonly state: CredentialState; readonly refreshedAt?: number; readonly ttlMs: number } }
interface EngineWallet {
  verifiedView(): EngineWalletView;
  load(): Promise<EngineWalletView>;
  onDidChange(listener: (view: EngineWalletView) => void): { dispose(): void };
  keepFresh(source: object, timers?: object): { dispose(): void; settled(): Promise<void> };
  wantedDids(): Promise<string[]>;
}
interface EngineHubTrust { refresh(dids: readonly string[]): Promise<string> }

/** The names the cache runs from the staff engine bundle (tools/staff-engine-entry.ts), so the wallet's facts and the key ring's check are one module. */
export interface CredentialEngine {
  readonly Wallet: new (secrets: SecretsLike, trust: object, now: () => number, holder: string) => EngineWallet;
  readonly HubTrustSource: new (options: object) => EngineHubTrust & object;
  keyReleaseFor(policy: () => CachePolicy | undefined, view: () => object, now: () => number, siteKind?: 'connected' | 'edge'): CacheReleaseCheck;
  verifyOrganizationLayer(file: unknown, options: { readonly issuerPublicKey: string; readonly now: number }):
  { readonly ok: true; readonly document: { readonly credentials?: CachePolicy['section']; readonly labels: { readonly scales: unknown; readonly mappings?: readonly unknown[] } } } | { readonly ok: false };
  readCredential(value: unknown, scales: unknown, options: { readonly signed: boolean }): { readonly ok: true; readonly value: { readonly claims: { readonly id: string } } } | { readonly ok: false };
  walletStateAt(view: object, now: number): CredentialState;
  walletStateText(view: object, now: number): { readonly text: string; readonly action?: 'retry' | 'connect' };
  readonly WALLET_SECRET_KEY: string;
}

interface SecretsLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The person's own KV, read with their own token. A read OpenBao refuses throws an error carrying its status. */
export interface CacheKv {
  read(path: string): Promise<Record<string, unknown> | undefined>;
  list(folder: string): Promise<readonly string[]>;
}

/** The active session as the cache uses it: the token's four facts, the entity and its space. Undefined once the session is not active. */
export interface CacheSession {
  readonly token: TokenFacts;
  readonly entityId: string;
  readonly space?: 'users' | 'guests';
}

export interface CredentialCacheDeps {
  readonly engine: () => CredentialEngine | undefined;
  /** Your organization's signed rules file and its issuer key (43 base64url characters), from the site's settings; undefined when not set. */
  readonly rules: () => { readonly text: string; readonly key: string } | undefined;
  readonly kv: CacheKv;
  readonly session: () => CacheSession | undefined;
  /** The person's own did:webvh (the identity service's record); undefined until it is made. */
  readonly holder: () => Promise<string | undefined>;
  /** The person's hub session through an open shared project; undefined while none is live. */
  readonly hub: () => CacheHubFetch | undefined;
  readonly now?: () => number;
  readonly timers?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

export interface CredentialCache {
  /** The state now, or undefined when your organization's rules carry no credentials@1 (there is nothing to check). */
  state(): CredentialStatus | undefined;
  /** Your organization's rules in force with credentials@1, verified; for the issuer service and the inbox pickup. */
  policy(): CachePolicy | undefined;
  /** Starts the background refresh once the person's DID exists. Safe to call again. */
  start(): Promise<void>;
  /** Retry: fetches the logs and lists now and checks the wallet again. */
  refresh(): Promise<CredentialStatus | undefined>;
  onDidChange(listener: () => void): { dispose(): void };
  /** The key release check for the staff engine, and the event that asks it again. */
  keyRelease(): { readonly check: CacheReleaseCheck; onDidChange(listener: () => void): { dispose(): void } };
  stop(): void;
}

/** The action word the browser shows for a state that has one: Retry after connecting is still Retry. */
export const CREDENTIAL_ACTION_TEXT = 'Retry';

/** The identity status RPC's answer with the session's credential state beside it, when your organization's rules carry credentials@1. */
export function identityStatusWith<T extends object>(status: T, cache: Pick<CredentialCache, 'state'>): T & { readonly credentials?: CredentialStatus } {
  const check = cache.state();
  return check === undefined ? status : { ...status, credentials: check };
}

const WALLET_ITEM_FORMAT = 'sterling-wallet-item/1';
const MAX_ITEMS = 256;
const MAX_ROLES_PER_ITEM = 8;
const ENTRY_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** True when OpenBao refused the person's own token (403): the entity is disabled or the session was revoked. */
function refusedByStore(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ((error as { status?: unknown }).status === 403 || (error as { kind?: unknown }).kind === 'refused');
}

export function createCredentialCache(deps: CredentialCacheDeps): CredentialCache {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let wallet: EngineWallet | undefined;
  let source: (EngineHubTrust & object) | undefined;
  let running: { dispose(): void; settled(): Promise<void> } | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;
  let cutOff = false;
  let rulesSeen: { text: string; key: string; policy: CachePolicy | undefined; at: number } | undefined;
  // The role credentials each officer relies on, as the wallet items carried them (issuer-service writes them beside each credential).
  let roles = new Map<string, unknown[]>();

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never stops the cache or the other listeners.
      }
    }
  };

  function policy(): CachePolicy | undefined {
    const engine = deps.engine();
    const rules = deps.rules();
    if (engine === undefined || rules === undefined) return undefined;
    const at = now();
    // The signed rules are checked again at most once a minute, and whenever the file or key changes.
    if (rulesSeen !== undefined && rulesSeen.text === rules.text && rulesSeen.key === rules.key && at - rulesSeen.at < 60_000) return rulesSeen.policy;
    const read = engine.verifyOrganizationLayer(rules.text, { issuerPublicKey: rules.key, now: at });
    const found = read.ok && read.document.credentials !== undefined
      ? Object.freeze({ section: read.document.credentials, scales: read.document.labels.scales, mappings: read.document.labels.mappings ?? [] })
      : undefined;
    rulesSeen = { text: rules.text, key: rules.key, policy: found, at };
    return found;
  }

  /** The wallet folder as the Wallet's SecretStorage: one value, the list of checked credentials; the pickup is the only writer. */
  const walletSecrets = (engine: CredentialEngine): SecretsLike => ({
    async get(key) {
      if (key !== engine.WALLET_SECRET_KEY) return undefined;
      const session = deps.session();
      if (session === undefined) throw new Error('no active session');
      const folder = `${session.space ?? 'users'}/${session.entityId}/credentials-wallet`;
      const credentials: unknown[] = [];
      const found = new Map<string, unknown[]>();
      try {
        for (const name of (await deps.kv.list(`${folder}/`)).slice(0, MAX_ITEMS)) {
          if (!ENTRY_NAME.test(name)) continue;
          const item = await deps.kv.read(`${folder}/${name}`);
          if (item?.format !== WALLET_ITEM_FORMAT || item.credential === undefined) continue;
          credentials.push(item.credential);
          const scales = policy()?.scales;
          for (const role of Array.isArray(item.roles) ? item.roles.slice(0, MAX_ROLES_PER_ITEM) : []) {
            const read = scales === undefined ? undefined : engine.readCredential(role, scales, { signed: true });
            if (read?.ok !== true) continue;
            found.set(read.value.claims.id, [...(found.get(read.value.claims.id) ?? []), role]);
          }
        }
      } catch (error) {
        if (refusedByStore(error)) cutOff = true;
        throw error;
      }
      cutOff = false;
      roles = found;
      return JSON.stringify(credentials);
    },
    async store() {
      throw new Error('The hosted wallet is filled only by the inbox pickup.');
    },
    async delete() {
      throw new Error('The hosted wallet is filled only by the inbox pickup.');
    },
  });

  async function start(): Promise<void> {
    if (stopped || wallet !== undefined) return;
    if (starting !== undefined) return starting;
    starting = (async () => {
      const engine = deps.engine();
      if (engine === undefined || policy() === undefined || deps.session() === undefined) return;
      const holder = await deps.holder();
      if (holder === undefined || stopped || wallet !== undefined) return;
      source = new engine.HubTrustSource({ policy, hub: deps.hub, roles: (did: string) => roles.get(did) ?? [], now });
      wallet = new engine.Wallet(walletSecrets(engine), source, now, holder);
      wallet.onDidChange(emit);
      running = wallet.keepFresh(source, deps.timers);
      await running.settled();
    })().finally(() => { starting = undefined; });
    return starting;
  }

  function state(): CredentialStatus | undefined {
    const engine = deps.engine();
    if (engine === undefined || policy() === undefined) return undefined;
    const view = wallet?.verifiedView();
    if (view === undefined || cutOff) {
      const text = engine.walletStateText({ cache: { state: 'unavailable', ttlMs: 0 } }, now());
      return { state: 'unavailable', message: text.text, action: CREDENTIAL_ACTION_TEXT };
    }
    const at = now();
    const text = engine.walletStateText(view, at);
    return { state: engine.walletStateAt(view, at), message: text.text, ...(text.action === undefined ? {} : { action: CREDENTIAL_ACTION_TEXT }) };
  }

  const ended = (): boolean => stopped || cutOff || deps.session() === undefined;

  function onDidChange(listener: () => void): { dispose(): void } {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  }

  return {
    state,
    policy,
    start,
    async refresh() {
      if (wallet === undefined) await start();
      if (wallet !== undefined && source !== undefined) {
        try {
          await source.refresh(await wallet.wantedDids());
        } catch {
          // The last verified copies stay; the state says what is missing.
        }
        await wallet.load();
      }
      return state();
    },
    onDidChange,
    keyRelease() {
      const engine = deps.engine();
      const check: CacheReleaseCheck = engine === undefined
        ? () => ({ ok: true })
        : engine.keyReleaseFor(policy, () => {
          const view = wallet?.verifiedView() ?? { cache: { state: 'unavailable', ttlMs: 0 }, facts: {} };
          return { ...view, ended: ended() };
        }, now, 'connected');
      return { check, onDidChange };
    },
    stop() {
      stopped = true;
      running?.dispose();
      emit();
    },
  };
}
