// The wallet's trust source backed by your organization's hub (Phase 71, D-11, D-14, OFFL-01). It fetches the status lists your organization's rules
// name and the did:webvh logs a check needs, over the hub connection the replica already holds (HubTransport: the hub's pin or your organization's
// certificate authority, and a hub session). It never opens a connection of its own.
//
// - Every object is verified before it is kept: a list against the one key your organization's rules name for it, and only when it is newer than the
//   held copy (a revocation never clears); a log only when the whole log verifies. A refused or failed fetch keeps the last verified copy.
// - A list's fetchedAt moves only when the hub answered a copy that verifies and is the newest one known, so the wallet turns stale on its own when
//   the hub stops answering, and unavailable only when no copy covers the need.
// - Reads are memory only: didState, list and roles never wait on the network. refresh runs one at a time.
// - Without a hub, the imported trust files answer alone, and the source says so.
import type { IssuerPolicy } from '../domain/credentials/issuerAuthority';
import { decodePublicKeyMultibase } from '../domain/credentials/multibase';
import { newerThan, verifyStatusList } from '../domain/credentials/statusList';
import type { StatusListState } from '../domain/credentials/statusList';
import { didHostPath } from '../domain/credentials/trustExport';
import { verifyWebvhLog } from '../domain/did/didWebvh';
import type { WebvhState } from '../domain/did/didWebvh';
import type { TrustSource } from './wallet';

/** What HubTrustSource reads from the hub, through the replica's connection: a log by its DID path and a list by its name. Undefined is a 404. */
export interface HubTrustFetch {
  getLog(path: string): Promise<string | undefined>;
  getList(name: string): Promise<string | undefined>;
  /** The log's witness file, for a log whose entries are witnessed. */
  getWitness?(path: string): Promise<string | undefined>;
}

export const HUB_TRUST_TEXT = {
  filesOnly: 'No server of your organization is set up here, so your credentials are checked only against the trust files you imported.'
} as const;

/** refreshed: every fetch answered a copy that verifies; kept: something failed and the last verified copies stay; files-only: no hub; unavailable: no rules or nothing held. */
export type HubRefreshOutcome = 'refreshed' | 'kept' | 'files-only' | 'unavailable';

export interface HubTrustSourceOptions {
  /** Your organization's rules in force (credentials@1 and the scales), verified; undefined when none are. */
  readonly policy: () => IssuerPolicy | undefined;
  /** The hub reached through the replica's connection; undefined when none is set up or connected. */
  readonly hub: () => HubTrustFetch | undefined;
  /** The role credentials an issuer relies on, as the person's wallet received them (hosted) or the trust files hold them. */
  readonly roles?: (did: string) => readonly unknown[];
  /** The imported trust files, used where the hub holds nothing and alone when there is no hub. */
  readonly files?: TrustSource;
  readonly now: () => number;
}

interface HeldList { readonly credential: unknown; readonly state: StatusListState; readonly hash: string; readonly fetchedAt: number }

const LIST_ROUTE = '/v1/trust/status/';

/** The hub route name of a status list id (https://<host>/v1/trust/status/<name>), or undefined when the id is not one of the hub's routes. */
export function listNameOf(id: string): string | undefined {
  try {
    const url = new URL(id);
    if (url.protocol !== 'https:' || !url.pathname.startsWith(LIST_ROUTE)) return undefined;
    const name = url.pathname.slice(LIST_ROUTE.length);
    return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

export class HubTrustSource implements TrustSource {
  private readonly lists = new Map<string, HeldList>();
  private readonly states = new Map<string, WebvhState>();
  private readonly asked = new Set<string>();
  private running: Promise<HubRefreshOutcome> | undefined;
  private hubSeen = false;

  public constructor(private readonly options: HubTrustSourceOptions) {}

  public policy(): IssuerPolicy | undefined {
    return this.options.policy();
  }

  public didState(did: string): WebvhState | undefined {
    if (this.asked.size < 256) this.asked.add(did);
    return this.states.get(did) ?? this.options.files?.didState(did);
  }

  public list(id: string): { readonly credential: unknown; readonly fetchedAt: number } | undefined {
    const held = this.lists.get(id);
    return held === undefined ? this.options.files?.list(id) : { credential: held.credential, fetchedAt: held.fetchedAt };
  }

  public roles(did: string): readonly unknown[] {
    return [...(this.options.roles?.(did) ?? []), ...(this.options.files?.roles(did) ?? [])];
  }

  public deviceBindings(): ReturnType<NonNullable<TrustSource['deviceBindings']>> {
    return this.options.files?.deviceBindings?.() ?? [];
  }

  /** Where checks read from now: the hub (with the files beside it) or the imported files alone. */
  public mode(): 'hub' | 'files' {
    return this.hubSeen || this.options.hub() !== undefined ? 'hub' : 'files';
  }

  /** The sentence to show beside the wallet's state, when there is one. */
  public sentence(): string | undefined {
    return this.mode() === 'files' ? HUB_TRUST_TEXT.filesOnly : undefined;
  }

  /** Fetches every list of your organization's rules and the logs of `dids`, the root and every DID asked for. One at a time; a call meanwhile shares it. */
  public refresh(dids: readonly string[] = []): Promise<HubRefreshOutcome> {
    if (this.running === undefined) this.running = this.fetchAll(dids).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async fetchAll(dids: readonly string[]): Promise<HubRefreshOutcome> {
    const policy = this.options.policy();
    if (policy === undefined) return 'unavailable';
    const hub = this.options.hub();
    if (hub === undefined) return this.options.files === undefined ? 'unavailable' : 'files-only';
    this.hubSeen = true;
    let failed = false;
    for (const entry of policy.section.statusLists) {
      if (!(await this.fetchList(hub, entry.uri, entry.key))) failed = true;
    }
    for (const did of new Set([policy.section.root.did, ...dids, ...this.asked])) {
      if (!(await this.fetchLog(hub, did))) failed = true;
    }
    if (!failed) return 'refreshed';
    const covered = policy.section.statusLists.every((entry) => this.list(entry.uri) !== undefined);
    return covered ? 'kept' : 'unavailable';
  }

  /** True when the hub answered a copy that verifies and is the newest known (then fetchedAt moves to now). */
  private async fetchList(hub: HubTrustFetch, id: string, key: string): Promise<boolean> {
    const name = listNameOf(id);
    if (name === undefined) return false;
    let text: string | undefined;
    try {
      text = await hub.getList(name);
    } catch {
      return false;
    }
    if (text === undefined) return false;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return false;
    }
    const now = this.options.now();
    let verified: ReturnType<typeof verifyStatusList>;
    try {
      verified = verifyStatusList(value, decodePublicKeyMultibase(key), now);
    } catch {
      return false;
    }
    if (!verified.ok || verified.list.id !== id) return false;
    const held = this.lists.get(id);
    if (held !== undefined && held.hash !== verified.hash && !newerThan(verified.list, held.state)) return false;
    if (held !== undefined && verified.list.purpose === 'revocation' && !held.state.bits.every((byte, index) => ((verified.list.bits[index] ?? 0) & byte) === byte)) return false;
    this.lists.set(id, Object.freeze({ credential: value, state: verified.list, hash: verified.hash, fetchedAt: now }));
    return true;
  }

  private async fetchLog(hub: HubTrustFetch, did: string): Promise<boolean> {
    const path = didHostPath(did);
    // Only did:webvh DIDs have a log at the hub; a did:key needs none.
    if (path === undefined) return true;
    let text: string | undefined;
    let witness: string | undefined;
    try {
      text = await hub.getLog(path);
      witness = text === undefined ? undefined : await hub.getWitness?.(path);
    } catch {
      return false;
    }
    if (text === undefined) return this.states.has(did);
    const result = verifyWebvhLog(text, { now: this.options.now(), did, ...(witness === undefined ? {} : { witnessFile: witness }) });
    if (!result.ok) return false;
    const held = this.states.get(did);
    // A log only grows: a shorter answer than the one held is an old copy and is not taken.
    if (held !== undefined && result.state.versions.length < held.versions.length) return false;
    this.states.set(did, result.state);
    return true;
  }
}
