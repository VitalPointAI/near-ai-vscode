// A multi-user staff project on this machine (D-07, D-19, D-24, D-44, D-46): where the replica store (WP-R2) and the roster and cell keys (WP-R1)
// meet. Node I/O only; never imports vscode. Every later host flow (migration, membership, the staff host's shared mode, the Single-Machine Copy)
// goes through one ReplicaProject instead of building its own context.
//
// What it does:
// - Pins the project's genesis in extension storage outside the project, at <globalStorage>/staff-replica/<project>/genesis.json, the way Team
//   Mode keeps its trust pin; .planning/staff/replica/project.json is only a convenience copy, and a copy that disagrees with the pin is refused
//   (D-46). The pin is written only when this device creates the project or joins it, never when a folder is opened.
// - Opens the store, then folds in two passes (D-44): the roster stream alone from the pinned anchor, then every stream with the real RosterView.
// - Keeps one ReplicaContext object and reuses it until the roster, this device's key ring or the blob set changes, and grows the fold with
//   addEntries, so a call with nothing new refolds nothing (Pitfall 1).
// - Builds and appends this device's own entries with the right seq, prev, lamport, roster and epoch key.
//
// The state of one ReplicaProject object:
//   unfolded --state()--> folded (context built) --state() with nothing new--> folded (same context, no refold)
//   folded --entries, grants or blobs arrive--> folded (roster refolded; the context is replaced only when the roster, the key ring or the blob set
//   changed; otherwise new entries are appended to the fold)
//
// No private key, opened epoch key or join secret is written to the project folder, a log, an error message or any file (P-31-23): keys stay in
// SecretStorage and memory (keyring.ts); the pin and project.json hold only public keys and hashes.
import { randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { identityDir as identityDirOf, loadOrCreateDeviceIdentity } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { localKeyStatus } from '../../team/keyHistory';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { isRecord } from '../../domain/team/validate';
import { buildGrant, newEpochKey, wrapEpochKey } from '../../domain/replica/cellKeys';
import { grantHash, readGrant } from '../../domain/replica/cellKeys';
import { GENESIS_PREV, HASH_PATTERN, STREAM_ID_PATTERN, buildEntry, entryHash, openBlob, openBody, writerIdOf } from '../../domain/replica/entry';
import type { Actor, BuiltEntry, Dep, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { addEntries, createFoldState } from '../../domain/replica/fold';
import type { FoldResult, FoldState } from '../../domain/replica/fold';
import { validateProjectData } from '../../domain/replica/kindSchemas/project';
import { SLUG_PATTERN } from '../../domain/replica/kindSchemas/shared';
import { ORIGIN_ROSTER, ROSTER_KIND_OWNER, foldRoster, rosterView } from '../../domain/replica/roster';
import type { RosterAnchor, RosterState } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { REPLICA_PROJECT_FILE } from '../../domain/staff/multiUser';
import { readWhole, snapshotOf, writeIfUnchanged } from '../staffFiles';
import { DeviceKeyRing, loadOrCreateEncryptionKey } from './keyring';
import type { DeviceEncryptionKey } from './keyring';
import { ReplicaStore } from './store';
import type { ReplicaStoreDeps, StoreRefusal, StoreRefused } from './store';

/** Where the genesis pins live under the extension's global storage: <globalStorage>/staff-replica/<project>/genesis.json. */
export const GENESIS_PIN_FOLDER = 'staff-replica';
export const GENESIS_PIN_FILE = 'genesis.json';
/** The most bytes a pin or project.json may hold; both are a few hundred bytes. */
const ANCHOR_FILE_MAX_BYTES = 64 * 1024;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

// Closed list of the host's refusals, in plain words. No message names a key, a secret or a full hash, and none uses a dash as punctuation.
export const PROJECT_REFUSALS_HOST = {
  'pin-mismatch': 'This project folder names a different shared project than the one this computer joined, so it was not opened. Nothing was changed. If the folder was replaced, put the right copy back, or ask your staff lead for help.',
  'not-shared': 'This project folder holds a shared staff project that this computer has not joined, so it was not opened. Nothing was changed. To work in it, ask your staff lead for an invitation.',
  'store-refused': 'The shared history in this project folder could not be opened, so nothing was changed.',
  'no-key': 'This computer does not hold the key for this part of the shared project, so nothing was written. Ask your staff lead to give this device access.',
  'pin-damaged': 'The record of which shared project this folder belongs to cannot be read, so the project was not opened. Nothing was changed. Ask your staff lead for help.',
  'already-shared': 'This project folder already holds a shared staff project, so a second one was not made. Nothing was changed.',
  'welcome-refused': 'The welcome file could not be used, so nothing was changed. Ask your staff lead for a new one.'
} as const;
export type ProjectRefusal = keyof typeof PROJECT_REFUSALS_HOST;
/** A refusal; `store` names the store's own reason when the store refused. */
export interface ProjectRefused { refused: ProjectRefusal; message: string; store?: StoreRefusal }

/** Thrown by state() when the store refuses on refresh (another window changed the folder in a way the store refuses). */
export class ReplicaProjectError extends Error {
  public constructor(public readonly refusal: ProjectRefused) {
    super(refusal.message);
  }
}

function refuse(reason: ProjectRefusal, message?: string): ProjectRefused {
  return { refused: reason, message: message ?? PROJECT_REFUSALS_HOST[reason] };
}

function storeRefused(refused: StoreRefused): ProjectRefused {
  return { refused: 'store-refused', message: refused.message, store: refused.refused };
}

export function isProjectRefused(value: unknown): value is ProjectRefused {
  return isRecord(value) && typeof value.refused === 'string' && Object.hasOwn(PROJECT_REFUSALS_HOST, value.refused) && typeof value.message === 'string';
}

/** What the host gives a project: secret storage, the extension's global storage folder, and optional seams for tests and later plans. */
export interface ReplicaProjectDeps {
  secrets: SecretStorageLike;
  globalStorageDir: string;
  /** The identity folder (identity-create.lock and the key history); identityDir(globalStorageDir) when absent. */
  identityDir?: string;
  now?: () => Date;
  /** The key status that verifies this device's store marks; this device's key history when absent. */
  keyStatus?: () => Promise<KeyStatusLookup>;
  /** The cell order the fold checks writes against (D-25), built by the host from Phase 70 dominance; absent means every citation is allowed. */
  cellOrder?: (roster: RosterState, keys: DeviceKeyRing) => ReplicaContext['cellOrder'];
}

/** This device as a shared project sees it. The signer signs; no private key leaves SecretStorage and memory. */
export interface LocalDevice {
  signer: DeviceIdentity;
  writer: string;
  publicKey: string;
  /** The raw X25519 public key as base64url, and the device's signature binding it to the writer (D-19). */
  x25519: string;
  x25519Sig: string;
}

interface DeviceKeys { identity: DeviceIdentity; writer: string; encryption: DeviceEncryptionKey }

async function deviceKeys(deps: ReplicaProjectDeps): Promise<DeviceKeys> {
  const dir = deps.identityDir ?? identityDirOf(deps.globalStorageDir);
  const { identity } = await loadOrCreateDeviceIdentity(deps.secrets, { identityDir: dir, ...(deps.now === undefined ? {} : { now: deps.now }) });
  const encryption = await loadOrCreateEncryptionKey(deps.secrets, { identityDir: dir, identity });
  return { identity, writer: writerIdOf(identity.publicKey), encryption };
}

function storeDeps(deps: ReplicaProjectDeps, identity: DeviceIdentity): ReplicaStoreDeps {
  const dir = deps.identityDir ?? identityDirOf(deps.globalStorageDir);
  return {
    secrets: deps.secrets,
    signer: () => Promise.resolve(identity),
    keyStatus: deps.keyStatus ?? (() => localKeyStatus(dir, deps.secrets)),
    ...(deps.now === undefined ? {} : { now: deps.now })
  };
}

// ---- the pin and project.json ----------------------------------------------------------------------------------------------------------------------

/** The genesis pin of a project in extension storage. */
export function genesisPinFile(globalStorageDir: string, project: string): string {
  if (!STREAM_ID_PATTERN.test(project)) throw new Error('A project id is 32 lowercase hex characters.');
  return path.join(globalStorageDir, GENESIS_PIN_FOLDER, project, GENESIS_PIN_FILE);
}

/** The convenience copy of the pin in the project folder. */
export function projectFile(root: string): string {
  return path.join(path.resolve(root), ...REPLICA_PROJECT_FILE.split('/'));
}

/** A pinned anchor read from untrusted JSON: exact keys, every field in its pattern. A fresh object, never the input. */
export function anchorOf(value: unknown): RosterAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'genesisHash,lead,project') return undefined;
  const lead = value.lead;
  if (!isRecord(lead) || Object.keys(lead).sort().join(',') !== 'member,publicKey,writer,x25519') return undefined;
  const { genesisHash, project } = value;
  const { member, writer, publicKey, x25519 } = lead;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash) || typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (typeof member !== 'string' || !SLUG_PATTERN.test(member) || typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  if (typeof publicKey !== 'string' || !BASE64URL_KEY.test(publicKey) || typeof x25519 !== 'string' || !BASE64URL_KEY.test(x25519)) return undefined;
  return { genesisHash, project, lead: { member, writer, publicKey, x25519 } };
}

export function sameAnchor(a: RosterAnchor, b: RosterAnchor): boolean {
  return a.genesisHash === b.genesisHash && a.project === b.project && a.lead.member === b.lead.member && a.lead.writer === b.lead.writer
    && a.lead.publicKey === b.lead.publicKey && a.lead.x25519 === b.lead.x25519;
}

type AnchorRead = { kind: 'missing' } | { kind: 'anchor'; anchor: RosterAnchor } | { kind: 'damaged' };

async function readAnchorFile(file: string): Promise<AnchorRead> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return { kind: 'damaged' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'damaged' };
  }
  const read = await readWhole(file, ANCHOR_FILE_MAX_BYTES);
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind !== 'text') return { kind: 'damaged' };
  try {
    const value = JSON.parse(read.text) as unknown;
    const anchor = isRecord(value) && value.v === 1 ? anchorOf(value.anchor) : undefined;
    return anchor === undefined ? { kind: 'damaged' } : { kind: 'anchor', anchor };
  } catch {
    return { kind: 'damaged' };
  }
}

/** Writes a pin or project.json. A file that holds the same anchor is left as it is; one that holds another is never replaced. */
async function writeAnchorFile(file: string, anchor: RosterAnchor): Promise<boolean> {
  const text = `${JSON.stringify({ v: 1, anchor }, null, 2)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readAnchorFile(file);
    if (before.kind === 'anchor') return sameAnchor(before.anchor, anchor);
    if (before.kind === 'damaged') return false;
    if (await writeIfUnchanged(file, await snapshotOf(file), text)) return true;
  }
  return false;
}

// ---- reading entries this device can open ----------------------------------------------------------------------------------------------------------

interface OpenedBody { deps: Dep[]; roster: string; lamport: number; kind: string; data: unknown; blob?: string }

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The input of a new shared project. The lead is this device's person; level is the project's level as a slug (D-49). */
export interface CreateSharedInput {
  name: string;
  profile: string;
  level?: string;
  labelMapHash: string;
  /** The lead's member id. A display name, when given, is not written by the genesis (its schema has no field for it); see 31-18-SUMMARY. */
  lead: { member: string; name?: string };
}

export interface AppendOwnOptions {
  /** The stream (a cell id); the project's base cell when absent. */
  stream?: string;
  /** Entries this one depends on, by hash; each must be in the store. */
  deps?: readonly string[];
  /** The roster cited; the roster head when absent. */
  roster?: string;
  actor?: Actor;
  at?: string;
}
export type AppendOwnResult = { ok: true; hash: string; built: BuiltEntry } | ProjectRefused;
export interface OwnEntry { hash: string; stream: string; seq: number; data: unknown }
export interface ProjectState { roster: RosterState; fold: FoldResult }

export class ReplicaProject {
  private readonly fed = new Set<string>();
  private readonly blobCache = new Map<string, SealedBlob>();
  private readonly grantHashes = new Set<string>();
  private readonly grantList: unknown[] = [];
  private readonly lamports = new Map<string, number>();
  private foldState: FoldState | undefined;
  private ctx: ReplicaContext | undefined;
  private ctxKey: string | undefined;
  private rosterState: RosterState | undefined;
  private rosterKey: string | undefined;
  private recordedHead: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    public readonly root: string,
    public readonly anchor: RosterAnchor,
    private readonly deps: ReplicaProjectDeps,
    private readonly store: ReplicaStore,
    public readonly keys: DeviceKeyRing,
    private readonly device: DeviceKeys
  ) {}

  /** This device's signing identity, X25519 public key and binding, made on first need (D-19). */
  public static async localDevice(deps: ReplicaProjectDeps): Promise<LocalDevice> {
    const keys = await deviceKeys(deps);
    return { signer: keys.identity, writer: keys.writer, publicKey: keys.identity.publicKey, x25519: keys.encryption.publicKey, x25519Sig: keys.encryption.binding };
  }

  /**
   * Opens the shared project in `root`. Undefined when the folder holds no shared project (no project.json). Refused when this computer has not
   * joined it (no pin), when project.json disagrees with the pin, when either cannot be read, or when the store refuses.
   */
  public static async open(root: string, deps: ReplicaProjectDeps): Promise<ReplicaProject | ProjectRefused | undefined> {
    const local = await readAnchorFile(projectFile(root));
    if (local.kind === 'missing') return undefined;
    if (local.kind === 'damaged') return refuse('pin-damaged');
    const pin = await readAnchorFile(genesisPinFile(deps.globalStorageDir, local.anchor.project));
    if (pin.kind === 'damaged') return refuse('pin-damaged');
    if (pin.kind === 'missing') return refuse('not-shared');
    if (!sameAnchor(pin.anchor, local.anchor)) return refuse('pin-mismatch');
    const device = await deviceKeys(deps);
    const store = await ReplicaStore.open(root, storeDeps(deps, device.identity));
    if (!(store instanceof ReplicaStore)) return storeRefused(store);
    const ring = await DeviceKeyRing.load(deps.secrets, pin.anchor.project, { writer: device.writer, privateKey: device.encryption.privateKey });
    return new ReplicaProject(path.resolve(root), pin.anchor, deps, store, ring, device);
  }

  /**
   * Makes a new shared project in `root` with this device's person as the lead (D-07): a base cell key at epoch 1, its founding grant wrapped to
   * this device, and the genesis that commits to it. Written in this order: the key (SecretStorage), the pin (extension storage), the grant, the
   * genesis, project.json. When the store already holds a genesis this device wrote and pinned (a crash before project.json), that one is used
   * again instead of building a second (Pitfall 4). A folder that already holds a shared project made by this device returns it; one made by
   * another lead is refused already-shared.
   */
  public static async createSharedProject(root: string, deps: ReplicaProjectDeps, input: CreateSharedInput): Promise<ReplicaProject | ProjectRefused> {
    const device = await deviceKeys(deps);
    const local = await readAnchorFile(projectFile(root));
    if (local.kind === 'damaged') return refuse('pin-damaged');
    if (local.kind === 'anchor') {
      const opened = await ReplicaProject.open(root, deps);
      if (opened === undefined) return refuse('pin-damaged');
      if (!(opened instanceof ReplicaProject)) return opened;
      return opened.anchor.lead.writer === device.writer ? opened : refuse('already-shared');
    }
    const store = await ReplicaStore.open(root, storeDeps(deps, device.identity));
    if (!(store instanceof ReplicaStore)) return storeRefused(store);

    // A genesis this device wrote and pinned, left without project.json: use it again.
    for (const entry of store.entries()) {
      if (entry.header.writer !== device.writer || entry.header.seq !== 0) continue;
      const pin = await readAnchorFile(genesisPinFile(deps.globalStorageDir, entry.header.stream));
      if (pin.kind !== 'anchor' || pin.anchor.genesisHash !== entryHash(entry.header) || pin.anchor.lead.writer !== device.writer) continue;
      if (!(await writeAnchorFile(projectFile(root), pin.anchor))) return refuse('pin-damaged');
      const ring = await DeviceKeyRing.load(deps.secrets, pin.anchor.project, { writer: device.writer, privateKey: device.encryption.privateKey });
      return new ReplicaProject(path.resolve(root), pin.anchor, deps, store, ring, device);
    }

    const now = deps.now?.() ?? new Date();
    const project = randomBytes(16).toString('hex');
    const baseKey = newEpochKey();
    const founding = buildGrant(device.identity, {
      cell: project, epoch: 1, roster: ORIGIN_ROSTER, labelSealed: '',
      wraps: [{ writer: device.writer, wrap: wrapEpochKey({ cell: project, epoch: 1, writer: device.writer, recipient: device.encryption.publicKey, epochKey: baseKey }) }]
    });
    const lead = { writer: device.writer, publicKey: device.identity.publicKey, x25519: device.encryption.publicKey, x25519Sig: device.encryption.binding, slot: 1 };
    const data: Record<string, unknown> = {
      project, name: input.name, profile: input.profile, labelMapHash: input.labelMapHash,
      lead: { member: input.lead.member, writer: device.writer, device: lead },
      cells: [{ cell: project, epoch: 1, grant: grantHash(founding) }],
      ...(input.level === undefined ? {} : { level: input.level })
    };
    const problem = validateProjectData('project.genesis', data, 'genesis');
    if (problem !== undefined) throw new Error(`The shared project was not made: ${problem}.`);
    const genesis = buildEntry({
      signer: device.identity, key: baseKey, stream: project, seq: 0, prev: GENESIS_PREV, epoch: 1,
      body: { deps: [], roster: ORIGIN_ROSTER, lamport: 1, at: now.toISOString(), actor: { kind: 'person' }, kind: 'project.genesis', data }
    });
    const anchor: RosterAnchor = { genesisHash: genesis.hash, project, lead: { member: input.lead.member, writer: device.writer, publicKey: device.identity.publicKey, x25519: device.encryption.publicKey } };

    const ring = await DeviceKeyRing.load(deps.secrets, project, { writer: device.writer, privateKey: device.encryption.privateKey });
    await ring.addOwn(project, 1, baseKey);
    if (!(await writeAnchorFile(genesisPinFile(deps.globalStorageDir, project), anchor))) return refuse('pin-damaged');
    const grant = await store.putGrant(project, 1, founding);
    if (!('ok' in grant)) return storeRefused(grant);
    const appended = await store.appendOwn([genesis]);
    if (!('ok' in appended)) return storeRefused(appended);
    if (!(await writeAnchorFile(projectFile(root), anchor))) return refuse('pin-damaged');
    const created = new ReplicaProject(path.resolve(root), anchor, deps, store, ring, device);
    created.lamports.set(genesis.hash, 1);
    return created;
  }

  public get projectId(): string {
    return this.anchor.project;
  }

  public get deviceWriter(): string {
    return this.device.writer;
  }

  /** This device's signer, for the pure builders (grants, invitations) a later flow writes with. */
  public get signer(): DeviceIdentity {
    return this.device.identity;
  }

  /** How many times the main fold had to start again (Pitfall 1: it does not rise when nothing changed). */
  public get refolds(): number {
    return this.foldState?.refolds ?? 0;
  }

  /** The context the last state() folded with. The same object until the roster, the key ring or the blob set changes. */
  public context(): ReplicaContext {
    if (this.ctx === undefined) throw new Error('Fold the project with state() before asking for its context.');
    return this.ctx;
  }

  /** Reads what is new in the store, folds the roster and then every stream, and records the roster head in this device's mark. */
  public state(): Promise<ProjectState> {
    return this.exclusive(() => this.foldNow());
  }

  /**
   * Builds, signs and appends one entry of this device. The stream is the base cell unless given; it cites the roster head unless given, and is
   * sealed under the stream's current epoch key at that roster. A roster kind gets rosterPrev equal to the cited roster when its data has none.
   * Refused no-key when this device does not hold that key; when another window of this install wrote first, it is built again on the new head.
   */
  public appendOwn(kind: string, data: unknown, options: AppendOwnOptions = {}): Promise<AppendOwnResult> {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { roster } = await this.foldNow();
        const built = this.buildOwn(roster, kind, data, options);
        if (!('entry' in built)) return built;
        const result = await this.store.appendOwn([built]);
        if ('ok' in result) {
          for (const blob of built.blobs) this.blobCache.set(blob.hash, blob);
          return { ok: true as const, hash: built.hash, built };
        }
        if (result.refused !== 'out-of-order') return storeRefused(result);
      }
      return storeRefused({ refused: 'out-of-order', message: 'This update does not follow the last one this device wrote to the shared history, so nothing was written. Nothing was changed.' });
    });
  }

  /** This device's own stored entry of a kind whose data the predicate accepts, or undefined. Used so a retried step does not write twice (Pitfall 4). */
  public findOwn(kind: string, predicate: (data: unknown) => boolean): Promise<OwnEntry | undefined> {
    return this.exclusive(async () => {
      for (const entry of this.store.entries()) {
        if (entry.header.writer !== this.device.writer) continue;
        const opened = await this.openEntry(entry);
        if (opened === undefined || opened.kind !== kind) continue;
        if (predicate(opened.data)) return { hash: entryHash(entry.header), stream: entry.header.stream, seq: entry.header.seq, data: opened.data };
      }
      return undefined;
    });
  }

  /** Stores signed cell grants (every one must read) and opens the ones addressed to this device into its key ring. */
  public putGrants(grants: readonly unknown[]): Promise<{ ok: true; stored: number; opened: number } | ProjectRefused> {
    return this.exclusive(async () => {
      const read = grants.map((signed) => {
        const grant = readGrant(signed);
        if (!grant.ok) throw new Error('Nothing was stored: one of the cell grants does not read.');
        return { signed, grant: grant.grant };
      });
      for (const item of read) {
        const stored = await this.store.putGrant(item.grant.cell, item.grant.epoch, item.signed);
        if (!('ok' in stored)) return storeRefused(stored);
      }
      const opened = await this.keys.openGrants(grants);
      return { ok: true as const, stored: read.length, opened };
    });
  }

  // ---- inside ------------------------------------------------------------------------------------------------------------------------------------

  /** Runs one public step at a time on this object, so a fold never sees half of another step. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async foldNow(): Promise<ProjectState> {
    const refreshed = await this.store.refresh();
    if (!('ok' in refreshed)) throw new ReplicaProjectError(storeRefused(refreshed));
    await this.loadGrants();
    await this.loadBlobs();
    const entries = this.store.entries();
    const rosterKey = `${entries.length}|${this.grantHashes.size}|${this.keys.version}|${this.blobCache.size}`;
    if (this.rosterState === undefined || rosterKey !== this.rosterKey) {
      this.rosterState = foldRoster({ entries, anchor: this.anchor, keys: this.keys.keyRing(), blobs: (hash) => this.blobCache.get(hash), grants: this.grantList, now: this.now() });
      this.rosterKey = rosterKey;
    }
    const roster = this.rosterState;
    const ctxKey = `${rosterSignature(roster)}|${this.keys.version}|${this.blobCache.size}`;
    if (this.ctx === undefined || ctxKey !== this.ctxKey) {
      this.ctx = this.buildContext(roster);
      this.ctxKey = ctxKey;
    }
    const fresh = entries.filter((entry) => !this.fed.has(entryHash(entry.header)));
    if (this.foldState === undefined) this.foldState = createFoldState(this.ctx);
    if (fresh.length > 0 || this.foldState.ctx !== this.ctx) {
      this.foldState = addEntries(this.foldState, fresh, this.ctx);
      for (const entry of fresh) this.fed.add(entryHash(entry.header));
    }
    const head = roster.positions[roster.positions.length - 1];
    if (roster.positions.length > 1 && head !== this.recordedHead && this.store.has(head)) {
      const recorded = await this.store.recordRosterHead(head);
      if (!('ok' in recorded)) throw new ReplicaProjectError(storeRefused(recorded));
      this.recordedHead = head;
    }
    return { roster, fold: this.foldState.result };
  }

  private buildContext(roster: RosterState): ReplicaContext {
    const cellOrder = this.deps.cellOrder?.(roster, this.keys);
    return {
      roster: rosterView(roster),
      keys: this.keys.keyRing(),
      blobs: (hash) => this.blobCache.get(hash),
      now: this.now(),
      ...(cellOrder === undefined ? {} : { cellOrder })
    };
  }

  /** Grants new on disk since the last look: kept for the roster fold and opened into the key ring. Unreadable grant files are left out. */
  private async loadGrants(): Promise<void> {
    const { grants } = await this.store.grants();
    const fresh: unknown[] = [];
    for (const grant of grants) {
      if (this.grantHashes.has(grant.hash)) continue;
      this.grantHashes.add(grant.hash);
      this.grantList.push(grant.signed);
      fresh.push(grant.signed);
    }
    if (fresh.length > 0) await this.keys.openGrants(fresh);
  }

  /** Blobs new on disk since the last look, read through the store (which checks each against its name and refuses links). */
  private async loadBlobs(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(path.join(this.store.dir, 'blobs'));
    } catch {
      return;
    }
    for (const name of names) {
      if (!HASH_PATTERN.test(name) || this.blobCache.has(name)) continue;
      const blob = await this.store.blob(name);
      if (blob !== undefined) this.blobCache.set(name, blob);
    }
  }

  private entryByHash(hash: string): SealedEntry | undefined {
    return this.store.entries().find((entry) => entryHash(entry.header) === hash);
  }

  /** An entry's body opened with this device's keys, with its data read from the blob when the body moved it there; undefined when it cannot be. */
  private async openEntry(entry: SealedEntry): Promise<OpenedBody | undefined> {
    const key = this.keys.epochKey(entry.header.stream, entry.header.epoch);
    if (key === undefined) return undefined;
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    const body = plain === undefined ? undefined : parseJson(plain);
    if (!isRecord(body) || typeof body.kind !== 'string' || typeof body.lamport !== 'number') return undefined;
    let data: unknown = body.data;
    if (typeof body.blob === 'string') {
      const blob = this.blobCache.get(body.blob) ?? await this.store.blob(body.blob);
      const opened = blob === undefined ? undefined : openBlob(key, entry.header.stream, entry.header.epoch, blob);
      if (opened === undefined) return undefined;
      data = parseJson(opened);
    }
    return { deps: body.deps as Dep[], roster: body.roster as string, lamport: body.lamport, kind: body.kind, data, ...(typeof body.blob === 'string' ? { blob: body.blob } : {}) };
  }

  /** The lamport of a stored entry, read from its body with this device's keys. */
  private lamportOf(hash: string): number {
    const known = this.lamports.get(hash);
    if (known !== undefined) return known;
    const entry = this.entryByHash(hash);
    const key = entry === undefined ? undefined : this.keys.epochKey(entry.header.stream, entry.header.epoch);
    const plain = entry === undefined || key === undefined ? undefined : openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    const body = plain === undefined ? undefined : parseJson(plain);
    if (!isRecord(body) || !Number.isSafeInteger(body.lamport)) throw new Error('Nothing was written: an entry this one follows cannot be read on this computer.');
    this.lamports.set(hash, body.lamport as number);
    return body.lamport as number;
  }

  private buildOwn(roster: RosterState, kind: string, data: unknown, options: AppendOwnOptions): BuiltEntry | ProjectRefused {
    const stream = options.stream ?? this.anchor.project;
    if (!STREAM_ID_PATTERN.test(stream)) throw new Error('Nothing was written: a stream id is 32 lowercase hex characters.');
    const cited = options.roster ?? roster.positions[roster.positions.length - 1];
    const position = roster.positionOf.get(cited);
    if (position === undefined) throw new Error('Nothing was written: the roster this entry would cite is not in this project\'s roster.');
    const epoch = epochAt(roster.cells, stream, position);
    const key = epoch === undefined ? undefined : this.keys.epochKey(stream, epoch);
    if (epoch === undefined || key === undefined) return refuse('no-key');
    const head = this.store.head(stream, this.device.writer);
    const deps: Dep[] = (options.deps ?? []).map((hash) => {
      const entry = this.entryByHash(hash);
      if (entry === undefined) throw new Error('Nothing was written: an entry this one depends on is not in this project\'s store.');
      return { writer: entry.header.writer, seq: entry.header.seq, hash };
    });
    const preds = [...(head === undefined ? [] : [head.hash]), ...deps.map((dep) => dep.hash)];
    const lamport = 1 + Math.max(0, ...preds.map((hash) => this.lamportOf(hash)));
    const body = ROSTER_KIND_OWNER[kind] !== undefined && kind !== 'project.genesis' && isRecord(data) && !Object.hasOwn(data, 'rosterPrev') ? { ...data, rosterPrev: cited } : data;
    const built = buildEntry({
      signer: this.device.identity, key, stream, seq: head === undefined ? 0 : head.seq + 1, prev: head?.hash ?? GENESIS_PREV, epoch,
      body: { deps, roster: cited, lamport, at: options.at ?? this.now().toISOString(), actor: options.actor ?? { kind: 'person' }, kind, data: body }
    });
    this.lamports.set(built.hash, lamport);
    return built;
  }
}

/** What the main fold's roster view answers from: the applied line, the splits and choices, and the grants placed. */
function rosterSignature(roster: RosterState): string {
  let grants = 0;
  for (const cell of roster.cells.cells.values()) grants += cell.grants.length;
  return [roster.positions.join(','), roster.pending.map((split) => `${split.at}:${split.branches.join('+')}`).join(';'), roster.choices.map((choice) => choice.choose).join(';'), String(roster.notChosen.size), String(grants)].join('|');
}
