// The roster as the hub knows it (D-40, D-42, D-43, D-64). The hub folds the project's roster stream with the extension's hub-side foldRoster, using a
// key ring opened only from grants wrapped to the hub's own X25519 key: the base cell, and any cell the lead granted it. Everything the append checks
// ask comes from that fold at the hub's roster head: who is admitted, who may write the roster, and the access list of each stream, which is the
// grantees of the stream's cell from the fold's grant records (writer ids read from grants, never labels).
//
// A ProjectRoster never changes once built: withBatch folds again with more entries and grants and returns a new one, so a batch is checked against
// an overlay and the cached roster is replaced only after the store's COMMIT (D-26).
//
// Quarantine (D-43): a writer is quarantined while it has a place (stream and seq) with an equivocation proof the hub stored, or a device.quarantine
// the roster recorded, and the roster has no device.release for that place. A device.revoke ends the device itself, which the standing reports first.
//
// Session keys (Phase 33 D-62): the fold places each session.certify beside the roster line (sessionKeys.ts), so the hub reads a certified session key
// from the same fold as every client. A session key stands where its certifying device stands, and is on the access list of every stream that device
// is; it stops when the device is revoked, removed or quarantined, when its own log forks, and, by the hub's clock, at its certificate's notAfter.
import type { KeyObject } from 'node:crypto';
import { readGrant } from '@ext/domain/replica/cellKeys';
import { unwrapForDevice } from '@ext/domain/replica/cellWrapV2';
import type { KemPrivateKeys } from '@ext/domain/replica/cellWrapV2';
import type { CellGrant } from '@ext/domain/replica/cellKeys';
import { openBody, parseHeaderShape } from '@ext/domain/replica/entry';
import type { SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { validateBody } from '@ext/domain/replica/kinds';
import { foldRoster, isRosterWriterAt, rosterView } from '@ext/domain/replica/roster';
import type { RosterAnchor, RosterState } from '@ext/domain/replica/roster';
import { epochAt } from '@ext/domain/replica/rosterCells';
import { deviceAt, deviceKeyOf } from '@ext/domain/replica/rosterMembers';
import type { KeyRing, ReplicaContext, RosterView } from '@ext/domain/replica/rosterView';
import { certifiedWriter } from '@ext/domain/replica/sessionKeys';
import type { SessionCertificate } from '@ext/domain/replica/sessionKeys';
import { StoreError } from '../store/hubStore';
import type { HubStore, StoredEntry } from '../store/hubStore';

/** What the roster needs of the hub's identity: its writer id and the X25519 private key its grants are wrapped to. */
export interface RosterIdentity {
  writer: string;
  x25519Private: KeyObject;
  /** The hub's post-quantum private keys (33.2 D-03), when it has a kem key: it then opens cell-wrap/v2 wraps too. */
  kem?: { privateKeys: KemPrivateKeys };
}

/** The epoch key in a wrap addressed to the hub, by the wrap's format: v1 with the X25519 key, v2 with the post-quantum keys. Never throws. */
export function openHubWrap(identity: RosterIdentity, grant: CellGrant, wrap: string): Buffer | undefined {
  return unwrapForDevice({ cell: grant.cell, epoch: grant.epoch, writer: identity.writer, wrap, x25519: identity.x25519Private, ...(identity.kem === undefined ? {} : { kem: identity.kem.privateKeys }) });
}

/** A place in one writer's log. */
export interface Place {
  writer: string;
  stream: string;
  seq: number;
}

export type Standing = 'admitted' | 'not-admitted' | 'revoked' | 'quarantined';
/** A standing at the hub's clock: a certified session key past its certificate's notAfter is session-expired (Phase 33 D-62). */
export type ClockStanding = Standing | 'session-expired';

export interface RosterInput {
  project: string;
  anchor: RosterAnchor;
  /** Every entry of the base stream the hub keeps (other streams are never folded here). */
  entries: readonly SealedEntry[];
  /** Signed grant objects: first those the hub keeps, then new ones offered with a batch. */
  grants: readonly unknown[];
  /** Hashes of the grants the store keeps. Each was placed by the hub's fold when it was stored (enrolment and append keep placed grants only),
   *  so its key stays in the hub's ring even while a roster split leaves the roster it names off the line (CR-01). */
  kept?: ReadonlySet<string>;
  blobs: ReadonlyMap<string, SealedBlob>;
  equivocations: readonly Place[];
  identity: RosterIdentity;
  now: Date;
}

const placeKey = (place: Place): string => `${place.writer}/${place.stream}/${place.seq}`;

/** A page of catch-up when the roster is loaded from the store. */
const LOAD_PAGE = { limit: 1000, maxBytes: 4 * 1024 * 1024 };

interface RingKey {
  key: Buffer;
  grant: string;
}

/** The epoch keys wrapped to the hub in these grants; the first grant for a cell and epoch wins. */
function ringKeys(grants: readonly unknown[], identity: RosterIdentity, only?: ReadonlySet<string>): Map<string, RingKey> {
  const keys = new Map<string, RingKey>();
  for (const value of grants) {
    const read = readGrant(value);
    if (!read.ok || (only !== undefined && !only.has(read.hash))) continue;
    const grant: CellGrant = read.grant;
    const slot = `${grant.cell}/${grant.epoch}`;
    if (keys.has(slot)) continue;
    const mine = grant.wraps.find((wrap) => wrap.writer === identity.writer);
    if (mine === undefined) continue;
    const key = openHubWrap(identity, grant, mine.wrap);
    if (key !== undefined) keys.set(slot, { key, grant: read.hash });
  }
  return keys;
}

const ringOf = (keys: ReadonlyMap<string, RingKey>): KeyRing => (stream, epoch) => keys.get(`${stream}/${epoch}`)?.key;

const placedGrantsOf = (state: RosterState): Set<string> => {
  const placed = new Set<string>();
  // A paged grant (33.2 D-04) is placed under its founding page's hash; every page it lists is placed with it, so the hub keeps and serves each.
  for (const cell of state.cells.cells.values()) {
    for (const grant of cell.grants) {
      placed.add(grant.hash);
      for (const page of grant.grant.pages ?? []) placed.add(page);
    }
  }
  return placed;
};

export class ProjectRoster {
  readonly project: string;
  readonly anchor: RosterAnchor;
  readonly state: RosterState;
  readonly view: RosterView;
  /** The hub's roster head: the last applied roster entry (the genesis right after enrolment). */
  readonly head: string;
  readonly headPosition: number;
  readonly ring: KeyRing;
  /** Hashes of every grant the fold placed. */
  readonly placedGrants: ReadonlySet<string>;
  private readonly input: RosterInput;
  private readonly quarantinePlaces: readonly Place[];

  private constructor(input: RosterInput, state: RosterState, ring: KeyRing) {
    this.input = input;
    this.project = input.project;
    this.anchor = input.anchor;
    this.state = state;
    this.view = rosterView(state);
    this.headPosition = state.positions.length - 1;
    this.head = state.positions[this.headPosition] as string;
    this.ring = ring;
    this.placedGrants = placedGrantsOf(state);
    this.quarantinePlaces = input.equivocations;
  }

  /** Folds the roster. The ring is opened from the grants wrapped to the hub; if a key came from a grant the fold did not place and the store does
   *  not keep, it folds again with keys from placed or kept grants only, so a grant from someone who may not give keys never decides what the hub
   *  can read. A kept grant stays usable through a roster split below the roster it names: without it a split at a roster older than the hub's
   *  admission would leave the hub unable to open the roster, including the roster.choose that resolves the split. */
  static build(input: RosterInput): ProjectRoster {
    const fold = (keys: KeyRing): RosterState =>
      foldRoster({ entries: input.entries, anchor: input.anchor, keys, blobs: (hash) => input.blobs.get(hash), grants: input.grants, now: input.now });
    const kept = input.kept ?? new Set<string>();
    const first = ringKeys(input.grants, input.identity);
    let state = fold(ringOf(first));
    let keys = first;
    const placed = placedGrantsOf(state);
    if ([...first.values()].some((item) => !placed.has(item.grant) && !kept.has(item.grant))) {
      keys = ringKeys(input.grants, input.identity, new Set([...placed, ...kept]));
      state = fold(ringOf(keys));
    }
    return new ProjectRoster(input, state, ringOf(keys));
  }

  /** Loads the roster of an enrolled project from the store: the base stream, the grants, the blobs base entries use and the stored proofs. */
  static async load(store: HubStore, project: string, identity: RosterIdentity, now: Date): Promise<ProjectRoster> {
    const record = store.project(project);
    if (record === undefined) throw new StoreError('unknown-project');
    const anchor = JSON.parse(record.anchor) as RosterAnchor;
    const entries: SealedEntry[] = [];
    for (const streamHeads of store.heads(project)) {
      if (streamHeads.stream !== project) continue;
      for (const head of streamHeads.heads) {
        let from = 0;
        for (;;) {
          const page = store.entriesFrom(project, project, head.writer, from, LOAD_PAGE);
          for (const row of page.entries) entries.push(sealedOf(row));
          if (!page.more || page.entries.length === 0) break;
          from = (page.entries[page.entries.length - 1] as StoredEntry).seq + 1;
        }
      }
    }
    const records = store.grants(project);
    const grants = records.map((grant) => JSON.parse(grant.body) as unknown);
    const kept = new Set(records.map((grant) => grant.hash));
    const ring = ringOf(ringKeys(grants, identity));
    const blobs = new Map<string, SealedBlob>();
    for (const hash of blobsNamed(entries, ring)) {
      const bytes = await store.readBlob(project, hash);
      if (bytes !== undefined) blobs.set(hash, { hash, bytes: bytes.toString('base64url') });
    }
    const equivocations = store.equivocations(project).map((proof) => ({ writer: proof.writer, stream: proof.stream, seq: proof.seq }));
    return ProjectRoster.build({ project, anchor, entries, grants, kept, blobs, equivocations, identity, now });
  }

  /** The roster folded again with more base-stream entries, grants and blobs (an overlay for a batch). */
  withBatch(entries: readonly SealedEntry[], grants: readonly unknown[], blobs: ReadonlyMap<string, SealedBlob> = new Map()): ProjectRoster {
    const merged = new Map(this.input.blobs);
    for (const [hash, blob] of blobs) merged.set(hash, blob);
    return ProjectRoster.build({ ...this.input, entries: [...this.input.entries, ...entries], grants: [...this.input.grants, ...grants], blobs: merged });
  }

  /** The same roster once the store keeps these grants too (after COMMIT); they were placed by this fold, so the ring and state do not change. */
  withKept(hashes: readonly string[]): ProjectRoster {
    if (hashes.length === 0) return this;
    const input = { ...this.input, kept: new Set([...(this.input.kept ?? []), ...hashes]) };
    return new ProjectRoster(input, this.state, this.ring);
  }

  /** The same roster with more equivocation places; no fold is needed. */
  withEquivocations(places: readonly Place[]): ProjectRoster {
    if (places.length === 0) return this;
    const input = { ...this.input, equivocations: [...this.input.equivocations, ...places] };
    return new ProjectRoster(input, this.state, this.ring);
  }

  /** The base-stream entries and grants this roster was folded from, for a later overlay. */
  get entries(): readonly SealedEntry[] {
    return this.input.entries;
  }

  blob(hash: string): SealedBlob | undefined {
    return this.input.blobs.get(hash);
  }

  /** What verifyEntry needs to read entries the hub can open (the base cell and granted cells), for checkpoints (32-22). */
  context(now: Date): ReplicaContext {
    return { roster: this.view, keys: this.ring, blobs: (hash) => this.input.blobs.get(hash), now };
  }

  /** A stream the project has at the head: the base stream (the project id) or a cell the roster created. */
  streamKnown(stream: string): boolean {
    return stream === this.project || epochAt(this.state.cells, stream, this.headPosition) !== undefined;
  }

  /** The devices that may write the stream: the grantees of its cell at the head. Undefined for an unknown stream or a cell whose founding grant
   *  the hub does not have. */
  accessList(stream: string): readonly string[] | undefined {
    if (!this.streamKnown(stream)) return undefined;
    const grantees = this.view.cellGrantees?.(stream, this.head);
    if (grantees === undefined || this.state.sessions.size === 0) return grantees;
    // A certified session key reads and writes where its certifying device does (Phase 33 D-62).
    const sessions = [...this.state.sessions.values()].filter((certificate) => grantees.includes(certificate.device) && this.standing(certificate.writer) === 'admitted');
    return [...grantees, ...sessions.map((certificate) => certificate.writer)];
  }

  /** The certificate the fold placed for a session key, or undefined when the writer is a roster device or no certificate names it (D-62). */
  sessionOf(writer: string): SessionCertificate | undefined {
    return deviceKeyOf(this.state.members, writer) === undefined ? this.view.sessionCertificate?.(writer) : undefined;
  }

  /** The roster device a writer stands for: the device itself, or for a certified session key the device that certified it (D-62). It names
   *  the member whose credentials and review status apply to the writer (71-09). */
  deviceOf(writer: string): { publicKey: string; member: string } | undefined {
    const certificate = this.sessionOf(writer);
    return this.view.deviceKey(certificate === undefined ? writer : certificate.device);
  }

  /** How many of a device's session key certificates are still before their notAfter at the hub's clock (LIMITS.liveSessionKeysPerDevice). */
  liveSessionsOf(device: string, now: number): number {
    return [...this.state.sessions.values()].filter((certificate) => certificate.device === device && Date.parse(certificate.notAfter) > now).length;
  }

  /** standing, and for a certified session key also its certificate's notAfter against the hub's clock: session-expired once it has passed. */
  standingAt(writer: string, now: number): ClockStanding {
    const standing = this.standing(writer);
    const certificate = this.sessionOf(writer);
    return standing === 'admitted' && certificate !== undefined && Date.parse(certificate.notAfter) <= now ? 'session-expired' : standing;
  }

  /** The places this writer is quarantined at: stored proofs and roster quarantines without a device.release for that place. */
  quarantinedAt(writer: string): Place[] {
    const releases = this.state.members.releases;
    const places = new Map<string, Place>();
    for (const place of this.quarantinePlaces) if (place.writer === writer) places.set(placeKey(place), place);
    for (const key of this.state.members.quarantines) {
      const [owner, stream, seq] = key.split('/');
      if (owner === writer && stream !== undefined && seq !== undefined) places.set(key, { writer, stream, seq: Number(seq) });
    }
    return [...places.entries()].filter(([key]) => !releases.has(key)).map(([, place]) => place);
  }

  standing(writer: string): Standing {
    const certificate = this.sessionOf(writer);
    if (certificate !== undefined) return this.sessionStanding(certificate);
    if (deviceKeyOf(this.state.members, writer) === undefined) return 'not-admitted';
    if (deviceAt(this.state.members, writer, this.headPosition) === undefined) return 'revoked';
    if (this.quarantinedAt(writer).length > 0) return 'quarantined';
    return 'admitted';
  }

  /** A certified session key's standing at the head, without the clock: its own log's places, then its certifying device, then the fold's rule. */
  private sessionStanding(certificate: SessionCertificate): Standing {
    if (this.quarantinedAt(certificate.writer).length > 0) return 'quarantined';
    const device = this.standing(certificate.device);
    if (device !== 'admitted') return device === 'quarantined' ? 'quarantined' : 'revoked';
    return certifiedWriter(this.view, certificate.writer, this.head) === undefined ? 'revoked' : 'admitted';
  }

  /**
   * May this writer act for the lead at the head (the join desk: registering invitations, reading join requests): a lead or deputy device, or a
   * session key one of them certified that stands (Phase 33 D-62, 33-27). It never writes the roster: roster kinds are the person key's (D-60).
   */
  actsForRosterWriter(writer: string): boolean {
    const certificate = this.sessionOf(writer);
    if (certificate !== undefined) return this.standing(writer) === 'admitted' && this.isRosterWriter(certificate.device);
    return this.isRosterWriter(writer);
  }

  /** May this device write the roster at the head: a device of the staff lead or the deputy lead there. */
  isRosterWriter(writer: string): boolean {
    return isRosterWriterAt(this.state, writer, this.headPosition);
  }

  /** May this device write the roster at the roster with this hash (D-11: authority at the cited roster). True or false for a roster on the hub's
   *  line, at or below the head; undefined for a roster the line does not hold (not received yet, or on a branch nobody chose), which only the
   *  fold can judge once that roster is applied. */
  isRosterWriterAtRoster(writer: string, hash: string): boolean | undefined {
    const position = this.state.positionOf.get(hash);
    return position === undefined ? undefined : isRosterWriterAt(this.state, writer, position);
  }
}

/** A stored row as the entry it was received as. */
export function sealedOf(row: StoredEntry): SealedEntry {
  return { header: JSON.parse(row.header) as SealedEntry['header'], body: row.body };
}

/** The blob hashes the base-stream bodies name, for the bodies the ring opens. */
export function blobsNamed(entries: readonly SealedEntry[], ring: KeyRing): string[] {
  const named = new Set<string>();
  for (const entry of entries) {
    const shape = parseHeaderShape(entry.header);
    if (!shape.ok) continue;
    const key = ring(shape.header.stream, shape.header.epoch);
    if (key === undefined) continue;
    const plaintext = openBody(key, shape.header, Buffer.from(entry.body, 'base64url'));
    if (plaintext === undefined) continue;
    try {
      const body = validateBody(JSON.parse(plaintext.toString('utf8')) as unknown);
      if (body.ok && body.body.blob !== undefined) named.add(body.body.blob);
    } catch {
      // A body that is not JSON names no blob; the fold refuses it on its own.
    }
  }
  return [...named];
}

/** The rosters of enrolled projects, loaded on first use. */
export class RosterCache {
  private readonly rosters = new Map<string, ProjectRoster>();
  private readonly loading = new Map<string, Promise<ProjectRoster>>();
  private readonly now: () => Date;

  constructor(
    private readonly store: HubStore,
    private readonly identity: RosterIdentity,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /** The project's roster; refuses unknown-project (StoreError) for a project the hub does not hold. */
  async get(project: string): Promise<ProjectRoster> {
    const cached = this.rosters.get(project);
    if (cached !== undefined) return cached;
    const pending = this.loading.get(project);
    if (pending !== undefined) return pending;
    const load = ProjectRoster.load(this.store, project, this.identity, this.now()).finally(() => this.loading.delete(project));
    this.loading.set(project, load);
    const roster = await load;
    if (!this.rosters.has(project)) this.rosters.set(project, roster);
    return this.rosters.get(project) as ProjectRoster;
  }

  peek(project: string): ProjectRoster | undefined {
    return this.rosters.get(project);
  }

  replace(project: string, roster: ProjectRoster): void {
    this.rosters.set(project, roster);
  }

  invalidate(project: string): void {
    this.rosters.delete(project);
  }
}
