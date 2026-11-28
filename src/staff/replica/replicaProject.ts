// ReplicaProject joins the local store and the roster/key folds for a shared project (D-07, D-19, D-24, D-44, D-46).
// Its genesis pin lives outside the project and is set only by creation or admission. The project.json copy must match it (D-46).
// It folds the roster first, then reuses the main fold context until the roster, keys or available blobs change (Pitfall 1).
// Writes derive seq, prev, lamport, roster and epoch from that checked state.
// Private keys, unwrapped epoch keys and join secrets remain in SecretStorage and memory (P-31-23).
import { randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { identityDir as identityDirOf } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import type { AsyncPayloadSigner, PayloadSigner, SignRefused, SignedPayload } from '../../domain/team/signedPayload';
import { SESSION_REFUSALS, isPersonKeyKind, requiresActionId } from '../../domain/replica/sessionKeys';
import type { RoutingTable } from '../../domain/gate/routing';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { buildGrantAsync, grantHash, newEpochKey, openLabel, readGrant } from '../../domain/replica/cellKeys';
import type { CellGrant } from '../../domain/replica/cellKeys';
import { signKemBinding } from '../../domain/replica/deviceKem';
import { buildGrantPagesAsync, wrapsFor } from '../../domain/replica/grantPages';
import { CELL_ACCESS_FEATURE } from '../../domain/replica/features';
import { BLOB_MAX_BYTES, GENESIS_PREV, HASH_PATTERN, STREAM_ID_PATTERN, blobBytesHash, buildEntryAsync, entryHash, openBlob, openBody, verifyHeader, writerIdOf } from '../../domain/replica/entry';
import type { Actor, BuiltEntry, Dep, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { addEntries, createFoldState } from '../../domain/replica/fold';
import type { FoldResult, FoldState } from '../../domain/replica/fold';
import { buildWelcome, readWelcome, welcomeProjectOf } from '../../domain/replica/invite';
import type { WelcomeFile } from '../../domain/replica/invite';
import { validateProjectData } from '../../domain/replica/kindSchemas/project';
import { ORIGIN_ROSTER, ROSTER_KIND_OWNER, foldRoster, isRosterWriterAt, legacyReadingGrants, managedWriteAllowed, rosterSignature, rosterView } from '../../domain/replica/roster';
import { storedAccessProofs } from '../../domain/replica/rotationGrants';
import type { RosterAnchor, RosterFoldInput, RosterState } from '../../domain/replica/roster';
import { epochAt, epochsAt } from '../../domain/replica/rosterCells';
import { deviceKeyOf, hubCellsAt } from '../../domain/replica/rosterMembers';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { checkpointHash } from '../../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../../domain/replica/checkpoint';
import type { Citation } from '../../domain/replica/chain';
import type { HeadSet } from '../../domain/replica/transport';
import { GENESIS_PIN_FILE, GENESIS_PIN_FOLDER, anchorOf, genesisPinFile, projectFile, readAnchorFile, sameAnchor, writeAnchorFile } from './anchorFile';
import { DecodeHost } from './decodeHost';
import type { DecodeVerdict } from './decodeHost';
import { DeviceKeyRing, loadOrCreateKemKeys, sameReadingKeys } from './keyring';
import * as kemPublish from './kemPublish';
import { ReplicaStore, START_AGAIN_INTENT_FILE, STORE_REFUSALS, finishStartAgain, sharedHistoryMissing } from './store';
import type { CheckVerdict, ForeignCheck, IngestResult, StartedAgain, StoreRefusal, StoreRefused } from './store';
import { foldCheckpoints, trustedCheckpointsOf } from './foldCheckpoints';
import type { SyncLocal } from './hubSync';
import { UPDATE_SENTENCE, ensureRequireArmed, requireProblem } from './requireGate';
import { deviceKeys, ringDevice, storeDeps, wrapV2AtCreation } from './projectDevice';
import type { DeviceKeys, LocalDevice, ReplicaProjectDeps } from './projectDevice';
import { canWriteCurrentEpoch } from './wrapPlan';
import { isSupersededManagedContinuity, previewManagedContinuity, preparePlacedManagedHandoff } from './managedGrantDelivery';
import type { ManagedHandoff, ManagedKeyFile } from './managedGrantDelivery';
import { ingestManagedDelivery, promoteManagedDeliveries } from './managedGrantIntake';
import type { ManagedPacket, ManagedStagedSend } from './managedSync';
import { authorizeHostedFinish } from './managedRecovery';
import type { DescribeFinishCell, HostedFinishDraft, HostedFinishWrite } from './managedRecovery';
import { managedAccessActionBytes, managedActionCurrent, verifyManagedStage } from './managedWithdrawal';

// The pin and project.json helpers live in anchorFile.ts; they are re-exported here so existing imports keep working.
export { GENESIS_PIN_FILE, GENESIS_PIN_FOLDER, anchorOf, genesisPinFile, projectFile, sameAnchor };

// Closed list of the host's refusals, in plain words. No message names a key, a secret or a full hash, and none uses a dash as punctuation.
export const PROJECT_REFUSALS_HOST = {
  'pin-mismatch': 'This project folder names a different shared project than the one this computer joined, so it was not opened. Nothing was changed. If the folder was replaced, put the right copy back, or ask your staff lead for help.',
  'not-shared': 'This project folder holds a shared staff project that this computer has not joined, so it was not opened. Nothing was changed. To work in it, ask your staff lead for an invitation.',
  'store-refused': 'The shared history in this project folder could not be opened, so nothing was changed.',
  'no-key': 'This computer does not hold the key for this part of the shared project, so nothing was written. Ask your staff lead to give this device access.',
  'rekey-pending': 'This part needs a current key before you can write to it. Sync the project or ask the person who manages access to finish the key change.',
  'pin-damaged': 'The record of which shared project this folder belongs to cannot be read, so the project was not opened. Nothing was changed. Ask your staff lead for help.',
  'already-shared': 'This project folder already holds a shared staff project, so a second one was not made. Nothing was changed.',
  'welcome-refused': 'The welcome file could not be used, so nothing was changed. Ask your staff lead for a new one.',
  'needs-update': UPDATE_SENTENCE,
  'signer-refused': 'Your key did not sign this change, so nothing was written.',
  'person-key-required': SESSION_REFUSALS['person-key-required'],
  'action-required': 'This change needs your own confirmation for this one action, so nothing was written.'
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

/**
 * Finishes a Start Again left unfinished in `root` (32-CONTEXT D-03) before anything decides the folder holds no shared project: while it is
 * unfinished the store folder, and project.json in it, may be gone. Nothing is made for a folder with no intent. A refusal is the store's.
 */
async function finishUnfinished(root: string, deps: ReplicaProjectDeps): Promise<ProjectRefused | undefined> {
  try {
    await lstat(path.join(path.resolve(root), ...START_AGAIN_INTENT_FILE.split('/')));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
  }
  const device = await deviceKeys(deps);
  const finished = await finishStartAgain(root, storeDeps(deps, device.identity));
  return 'ok' in finished ? undefined : storeRefused(finished);
}

/** The refusal of a folder whose shared history went missing (its store folder is gone beside a folder set aside that holds project.json). */
function historyMissing(): ProjectRefused {
  return storeRefused({ refused: 'rolled-back', message: STORE_REFUSALS['rolled-back'] });
}

export function isProjectRefused(value: unknown): value is ProjectRefused {
  return isRecord(value) && typeof value.refused === 'string' && Object.hasOwn(PROJECT_REFUSALS_HOST, value.refused) && typeof value.message === 'string';
}

export type { LocalDevice, ReplicaProjectDeps } from './projectDevice';

/** A signature of the device the roster names, or ReplicaProjectError signer-refused with the key store's own sentence (the flows return it). */
export async function settled<T>(signed: Promise<T | SignRefused>): Promise<T> {
  const value = await signed;
  if (isRecord(value) && typeof value.refused === 'string' && !('payload' in value) && !('entry' in value)) throw new ReplicaProjectError(refuse('signer-refused', value.refused));
  return value as T;
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

const PASS = { ok: true as const };
const AWAITING_KEY: CheckVerdict = { ok: false, awaiting: 'key' };
const AWAITING_BLOB: CheckVerdict = { ok: false, awaiting: 'blob' };
const MAX_BLOB_CHARS = Math.ceil((BLOB_MAX_BYTES * 4) / 3);

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
  stream?: string;
  deps?: readonly string[];
  contentBlob?: SealedBlob;
  accessProof?: unknown;
  stageAccess?: (entry: string) => unknown;
  roster?: string;
  actor?: Actor;
  at?: string;
  signer?: PayloadSigner | AsyncPayloadSigner;
  action?: string;
}
export type AppendOwnResult = { ok: true; hash: string; built: BuiltEntry } | ProjectRefused;
export interface OwnEntry { hash: string; stream: string; seq: number; data: unknown }
/** A cell this device holds an epoch of (heldCells): label is the sealed label as opened here, for a cell that is not the base cell. */
export interface HeldCell { cell: string; base: boolean; epochs: number[]; label?: unknown }
export type WelcomeResult = { ok: true; added: number; held: Array<{ hash: string; reason: string }> } | ProjectRefused;
export interface ProjectState { roster: RosterState; fold: FoldResult }

export class ReplicaProject {
  private readonly fed = new Set<string>();
  private readonly blobCache = new Map<string, SealedBlob>();
  private readonly grantHashes = new Set<string>();
  private readonly grantList: unknown[] = [];
  private evidence: Array<{ hash: string; value: unknown }> = [];
  private readonly lamports = new Map<string, number>();
  private foldState: FoldState | undefined;
  // The checkpoints the fold uses (foldCheckpoints.ts): what each hub's witness trusts, seeded once from the witness memory, kept by each exchange.
  private trusted: Map<string, SignedCheckpoint | undefined> | undefined;
  private stored: SignedCheckpoint[] | undefined;
  private checkpointKey = '';
  private ctx: ReplicaContext | undefined;
  private ctxKey: string | undefined;
  private rosterState: RosterState | undefined;
  private rosterKey: string | undefined;
  private recordedHead: string | undefined;
  private recheckKey: string | undefined;
  private ownDecoder: DecodeHost | undefined;
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
    return { signer: keys.identity, rosterSigner: keys.roster, writer: keys.writer, publicKey: keys.roster.publicKey, x25519: keys.encryption.publicKey, x25519Sig: keys.encryption.binding, ...(keys.kem === undefined ? {} : { kem: keys.kem }) };
  }

  /**
   * Opens the shared project in `root`. A Start Again left unfinished is finished first (32-CONTEXT D-03). Undefined when the folder holds no shared
   * project (no project.json, and no folder set aside beside a missing store folder holds one). Refused when this computer has not joined it (no
   * pin), when project.json disagrees with the pin, when either cannot be read, when the store refuses, or rolled-back when the store folder is gone
   * beside a folder set aside that holds project.json (its shared history went missing; Start Again carries from that folder).
   */
  public static async open(root: string, deps: ReplicaProjectDeps): Promise<ReplicaProject | ProjectRefused | undefined> {
    const unfinished = await finishUnfinished(root, deps);
    if (unfinished !== undefined) return unfinished;
    const local = await readAnchorFile(projectFile(root));
    if (local.kind === 'missing') return (await sharedHistoryMissing(root)) ? historyMissing() : undefined;
    if (local.kind === 'damaged') return refuse('pin-damaged');
    const pin = await readAnchorFile(genesisPinFile(deps.globalStorageDir, local.anchor.project));
    if (pin.kind === 'damaged') return refuse('pin-damaged');
    if (pin.kind === 'missing') return refuse('not-shared');
    if (!sameAnchor(pin.anchor, local.anchor)) return refuse('pin-mismatch');
    const device = await deviceKeys(deps);
    const store = await ReplicaStore.open(root, storeDeps(deps, device.identity));
    if (!(store instanceof ReplicaStore)) return storeRefused(store);
    const ring = await DeviceKeyRing.load(deps.secrets, pin.anchor.project, ringDevice(device));
    const project = new ReplicaProject(path.resolve(root), pin.anchor, deps, store, ring, device);
    // This computer's post-quantum keys, published once where the runtime passes the probe (33.2 D-05).
    if (deps.publishKem === true && deps.personSigner === undefined && deps.sessionSigner === undefined) {
      await kemPublish.ensureDeviceKem(project, { loadKeys: () => loadOrCreateKemKeys(deps.secrets, { identityDir: deps.identityDir ?? identityDirOf(deps.globalStorageDir) }) });
    }
    return project;
  }

  /**
   * Makes a new shared project in `root` with this device's person as the lead (D-07): a base cell key at epoch 1, its founding grant wrapped to
   * this device, and the genesis that commits to it. Written in this order: the key (SecretStorage), the pin (extension storage), the grant, the
   * genesis, project.json, then roster.require { require@1 } so the feature check is armed from the start (Phase 33 D-08). When the store already holds a genesis this device wrote and pinned (a crash before project.json), that one is used
   * again instead of building a second (Pitfall 4). A folder that already holds a shared project made by this device returns it; one made by
   * another lead is refused already-shared. The device the roster names signs the founding grant and the genesis: the person key when hosted (33-27).
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
      const ring = await DeviceKeyRing.load(deps.secrets, pin.anchor.project, ringDevice(device));
      const reused = new ReplicaProject(path.resolve(root), pin.anchor, deps, store, ring, device);
      const rearmed = await ensureRequireArmed(reused, { withWrapV2: wrapV2AtCreation(deps) && device.kem !== undefined });
      return isProjectRefused(rearmed) ? rearmed : reused;
    }

    const now = deps.now?.() ?? new Date();
    const project = randomBytes(16).toString('hex');
    const baseKey = newEpochKey();
    // New shared work starts post-quantum (33.2 D-05): the lead's device names its post-quantum keys in the genesis, bound by its own key, and the
    // base cell's first key is wrapped with cell-wrap/v2. Where this computer does not know wrap@2, the project starts as before. A hosted session
    // binds its post-quantum keys with the person key after opening (publishPersonKem), not in a genesis the session key would sign, so it starts as
    // before too.
    const kem = wrapV2AtCreation(deps) && device.roster === device.identity ? device.kem : undefined;
    const pages = await settled(buildGrantPagesAsync(device.roster, {
      cell: project, epoch: 1, roster: ORIGIN_ROSTER, labelSealed: '',
      wraps: wrapsFor({ format: kem === undefined ? 1 : 2, cell: project, epoch: 1, epochKey: baseKey, devices: [{ writer: device.writer, x25519: device.encryption.publicKey, ...(kem === undefined ? {} : { kem }) }] }).wraps
    }));
    const founding = pages[0];
    const lead = {
      writer: device.writer, publicKey: device.roster.publicKey, x25519: device.encryption.publicKey, x25519Sig: device.encryption.binding, slot: 1,
      ...(kem === undefined ? {} : { kem: signKemBinding(kem, device.writer, (bytes) => device.identity.sign(bytes)) })
    };
    const data: Record<string, unknown> = {
      project, name: input.name, profile: input.profile, labelMapHash: input.labelMapHash,
      lead: { member: input.lead.member, writer: device.writer, device: lead },
      cells: [{ cell: project, epoch: 1, grant: grantHash(founding) }],
      ...(input.level === undefined ? {} : { level: input.level })
    };
    const problem = validateProjectData('project.genesis', data, 'genesis');
    if (problem !== undefined) throw new Error(`The shared project was not made: ${problem}.`);
    const genesis = await settled(buildEntryAsync({
      signer: device.roster, key: baseKey, stream: project, seq: 0, prev: GENESIS_PREV, epoch: 1,
      body: { deps: [], roster: ORIGIN_ROSTER, lamport: 1, at: now.toISOString(), actor: { kind: 'person' }, kind: 'project.genesis', data }
    }));
    const anchor: RosterAnchor = { genesisHash: genesis.hash, project, lead: { member: input.lead.member, writer: device.writer, publicKey: device.roster.publicKey, x25519: device.encryption.publicKey } };

    const ring = await DeviceKeyRing.load(deps.secrets, project, ringDevice(device));
    await ring.addOwn(project, 1, baseKey, grantHash(founding));
    if (!(await writeAnchorFile(genesisPinFile(deps.globalStorageDir, project), anchor))) return refuse('pin-damaged');
    for (const page of pages) {
      const grant = await store.putGrant(project, 1, page);
      if (!('ok' in grant)) return storeRefused(grant);
    }
    const created = new ReplicaProject(path.resolve(root), anchor, deps, store, ring, device);
    const appended = device.roster === device.identity ? await store.appendOwn([genesis]) : await store.ingestForeign([genesis.entry], [], async () => PASS);
    if (!('ok' in appended)) return storeRefused(appended);
    if (!(await writeAnchorFile(projectFile(root), anchor))) return refuse('pin-damaged');
    created.lamports.set(genesis.hash, 1);
    // New shared work requires wrap@2 from the start where this computer knows it (33.2 D-05).
    const armed = await ensureRequireArmed(created, { withWrapV2: kem !== undefined });
    if (isProjectRefused(armed)) return armed;
    // The genesis names only the lead's member id; the name the person gave is the lead's first member.update (33-14), as every other member's is.
    const named = input.lead.name === undefined ? undefined : await created.appendChecked(() => ({ kind: 'member.update', data: { member: input.lead.member, name: input.lead.name }, options: {}, check: () => undefined }));
    return named !== undefined && isProjectRefused(named) ? named : created;
  }

  /**
   * Pins a project's genesis on this computer from the invitation it read (D-07), before the welcome arrives. A pin that already names the same
   * anchor is kept; one that names another is never replaced (pin-mismatch).
   */
  public static async pinAnchor(deps: ReplicaProjectDeps, anchor: RosterAnchor): Promise<{ ok: true; first: boolean } | ProjectRefused> {
    const checked = anchorOf(anchor);
    if (checked === undefined) throw new Error('Nothing was pinned: the project anchor is not in the shape this version writes.');
    const file = genesisPinFile(deps.globalStorageDir, checked.project);
    const before = await readAnchorFile(file);
    if (before.kind === 'damaged') return refuse('pin-damaged');
    if (before.kind === 'anchor') return sameAnchor(before.anchor, checked) ? { ok: true, first: false } : refuse('pin-mismatch');
    return (await writeAnchorFile(file, checked)) ? { ok: true, first: true } : refuse('pin-mismatch');
  }

  /**
   * Starts this computer's shared history of the project in `root` again, after the person confirmed it (31-REVIEW MJ-08): only when its store is
   * refused rolled-back, damaged or mark-unverified (ReplicaStore.startAgain). The store folder is moved aside, never deleted; this device's own
   * signed entries, the grants, the blobs and project.json are carried into a new one; its mark starts again. A Start Again left unfinished is
   * finished first, and a store folder that is gone beside a folder set aside holding project.json is started again from that folder (32-CONTEXT
   * D-03). Undefined when the folder holds no shared project. The rest of the history comes back with a new welcome file, opened with Staff: Join Staff Project.
   */
  public static async startHistoryAgain(root: string, deps: ReplicaProjectDeps): Promise<StartedAgain | ProjectRefused | undefined> {
    const unfinished = await finishUnfinished(root, deps);
    if (unfinished !== undefined) return unfinished;
    const local = await readAnchorFile(projectFile(root));
    if (local.kind === 'missing' && !(await sharedHistoryMissing(root))) return undefined;
    const device = await deviceKeys(deps);
    const result = await ReplicaStore.startAgain(root, storeDeps(deps, device.identity));
    return 'ok' in result ? result : storeRefused(result);
  }

  /**
   * Joins a shared project in `root` from the welcome file the lead returned after admitting this device (D-15, D-44, D-45). The welcome is read
   * against the pinned genesis (the pin from pinAnchor, or `anchor` on a first join when nothing is pinned yet) and this device's writer; a welcome
   * for another project is refused pin-mismatch and anything else wrong welcome-refused, before anything is written. Then: the pin is written if it
   * was not, the roster entries go into the store through the decode check as entries from outside (D-05), the grants are stored, the roster is
   * folded so the key ring takes the keys of the grants it placed (CR-01), and project.json is written. A folder that holds another shared project
   * is refused pin-mismatch.
   */
  public static async joinFromWelcome(root: string, deps: ReplicaProjectDeps, welcome: unknown, anchor?: RosterAnchor): Promise<ReplicaProject | ProjectRefused> {
    const project = anchor?.project ?? welcomeProjectOf(welcome);
    if (project === undefined || !STREAM_ID_PATTERN.test(project)) return refuse('welcome-refused');
    const pinFile = genesisPinFile(deps.globalStorageDir, project);
    const pin = await readAnchorFile(pinFile);
    if (pin.kind === 'damaged') return refuse('pin-damaged');
    if (pin.kind === 'anchor' && anchor !== undefined && !sameAnchor(pin.anchor, anchor)) return refuse('pin-mismatch');
    const pinned = pin.kind === 'anchor' ? pin.anchor : anchor === undefined ? undefined : anchorOf(anchor);
    if (pinned === undefined) return refuse('not-shared');
    const device = await deviceKeys(deps);
    const read = readWelcome(welcome, { genesisHash: pinned.genesisHash, writer: device.writer });
    if (!read.ok) return read.reason === 'wrong-project' ? refuse('pin-mismatch') : refuse('welcome-refused', read.message);
    const local = await readAnchorFile(projectFile(root));
    if (local.kind === 'damaged') return refuse('pin-damaged');
    if (local.kind === 'anchor' && !sameAnchor(local.anchor, pinned)) return refuse('pin-mismatch');
    // Every check has passed; from here on the join writes.
    const ring = await DeviceKeyRing.load(deps.secrets, pinned.project, ringDevice(device));
    if (pin.kind === 'missing' && !(await writeAnchorFile(pinFile, pinned))) return refuse('pin-mismatch');
    const store = await ReplicaStore.open(root, storeDeps(deps, device.identity));
    if (!(store instanceof ReplicaStore)) return storeRefused(store);
    const joined = new ReplicaProject(path.resolve(root), pinned, deps, store, ring, device);
    const received = await joined.receiveWelcome(read.welcome, read.entries);
    if (isProjectRefused(received)) return received;
    if (local.kind === 'missing' && !(await writeAnchorFile(projectFile(root), pinned))) return refuse('pin-damaged');
    return joined;
  }
  public get projectId(): string {
    return this.anchor.project;
  }
  public signerOf(kind: string): PayloadSigner | AsyncPayloadSigner {
    return (isPersonKeyKind(kind) ? this.deps.personSigner : undefined) ?? this.deps.sessionSigner ?? this.device.identity;
  }
  public get deviceWriter(): string {
    return this.device.writer;
  }
  public get signer(): DeviceIdentity {
    return this.device.identity;
  }
  public get rosterSigner(): PayloadSigner | AsyncPayloadSigner {
    return this.device.roster;
  }
  public signGrant(grant: CellGrant): Promise<SignedPayload<CellGrant>> {
    return settled(buildGrantAsync(this.device.roster, grant));
  }

  /** The signed pages of one epoch grant (33.2 D-04), signed by the device the roster names; throws ReplicaProjectError signer-refused as signGrant. */
  public signGrantPages(grant: CellGrant): Promise<Array<SignedPayload<CellGrant>>> {
    return settled(buildGrantPagesAsync(this.device.roster, grant));
  }

  /** How many times the main fold had to start again (Pitfall 1: it does not rise when nothing changed). */
  public get refolds(): number {
    return this.foldState?.refolds ?? 0;
  }
  public context(): ReplicaContext {
    if (this.ctx === undefined) throw new Error('Fold the project with state() before asking for its context.');
    return this.ctx;
  }
  public state(): Promise<ProjectState> {
    return this.exclusive(() => this.foldNow());
  }
  public appendOwn(kind: string, data: unknown, options: AppendOwnOptions = {}): Promise<AppendOwnResult> {
    return this.appendPlanned<never>(() => ({ kind, data, options }));
  }
  public appendChecked<R extends { ok: false }>(prepare: (state: ProjectState) => R | {
    kind: string; data: unknown; options: AppendOwnOptions; check: (fold: FoldResult, hash: string) => R | undefined
  }): Promise<AppendOwnResult | R> {
    return this.appendPlanned(prepare, true);
  }
  public async finishHostedCell(draft: HostedFinishDraft, action: string, describe: DescribeFinishCell, routing?: RoutingTable): Promise<AppendOwnResult> {
    const finish = await authorizeHostedFinish(this, draft, action, describe, routing, () => this.now(), () => this.exclusive(async () => {
      const { roster } = await this.foldNow();
      return { roster, snapshot: await this.store.appendSnapshot() };
    }));
    return finish === undefined ? refuse('action-required') : this.appendPlanned<never>(() => finish, true, finish);
  }
  private appendPlanned<R extends { ok: false }>(prepare: (state: ProjectState) => R | {
    kind: string; data: unknown; options: AppendOwnOptions; check?: (fold: FoldResult, hash: string) => R | undefined
  }, checked = false, finish?: HostedFinishWrite): Promise<AppendOwnResult | R> {
    return this.exclusive(async () => {
      let race: StoreRefused | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const expected = await this.store.appendSnapshot();
        const state = await this.foldNow();
        if (expected !== await this.store.appendSnapshot()) continue;
        const write = prepare(state);
        if ('ok' in write) return write;
        const hosted = this.device.roster !== this.device.identity;
        const finishCurrent = () => finish !== undefined && finish.scope.approved() && finish.matches(state.roster);
        if (finish !== undefined && (!hosted || !finishCurrent() || finish.snapshot !== expected || !state.roster.requiredFrom.has(CELL_ACCESS_FEATURE))) return refuse('action-required');
        if (finish === undefined && hosted && write.kind === 'cell.rekey' && state.roster.requiredFrom.has(CELL_ACCESS_FEATURE)) return refuse('action-required');
        const hostedStage = write.options.stageAccess !== undefined && hosted && finish === undefined;
        const action = hostedStage ? managedAccessActionBytes(state.roster, this.device.writer, write.kind, write.data) : undefined;
        if (hostedStage && !managedActionCurrent(this.device.roster, write.options.action, action)) return refuse('action-required');
        let matchesEntry: ((entry: BuiltEntry) => boolean) | undefined;
        const built = await this.buildOwn(state.roster, write.kind, write.data, write.options, finish === undefined ? undefined : async (input) => {
          const result = await finish.scope.signEntry(input, finish.data.accessRoot, async () =>
            'ok' in await this.store.refresh() && await this.store.appendSnapshot() === expected && finishCurrent());
          if ('refused' in result) return result;
          matchesEntry = result.matches;
          return result.built;
        });
        if (!('entry' in built)) return finish !== undefined && !finishCurrent() ? refuse('action-required') : built;
        if (write.check !== undefined) {
          const prior = this.foldState;
          if (prior === undefined) throw new Error('A checked write requires a current fold.');
          const ctx = built.blobs.length === 0 ? prior.ctx : { ...prior.ctx, blobs: (hash: string) => built.blobs.find((blob) => blob.hash === hash) ?? prior.ctx.blobs(hash) };
          const refused = write.check(addEntries(prior, [built.entry], ctx).result, built.hash);
          if (refused !== undefined) return refused;
        }
        const stage = write.options.stageAccess?.(built.hash);
        if (write.options.stageAccess !== undefined && (!checked || !verifyManagedStage(built, stage, this.rosterInputs(state.roster)))) return refuse('rekey-pending');
        const writer = built.entry.header.writer;
        const deadline = state.roster.requiredFrom.has(CELL_ACCESS_FEATURE) ? state.roster.sessions.get(writer)?.notAfter : undefined;
        const frozenStage = finish === undefined || stage === undefined ? undefined : canonicalBytes(stage);
        const mayCommit = deadline === undefined && action === undefined && finish === undefined ? undefined : () =>
          (deadline === undefined || Date.parse(deadline) > this.now().getTime()) &&
          (action === undefined || managedActionCurrent(this.device.roster, write.options.action, action)) &&
          (finish === undefined || (finishCurrent() && matchesEntry?.(built) === true && frozenStage?.equals(canonicalBytes(stage)) === true));
        const result = writer === writerIdOf(this.device.identity.publicKey) ? await this.store.appendOwn([built], expected, mayCommit, stage) : await this.storeSigned(built, expected, mayCommit, stage);
        if ('ok' in result) {
          for (const blob of built.blobs) this.blobCache.set(blob.hash, blob);
          return { ok: true as const, hash: built.hash, built };
        }
        if (finish !== undefined && result.refused === 'snapshot-changed') return refuse('action-required');
        if (result.refused !== 'out-of-order' && result.refused !== 'snapshot-changed') return storeRefused(result);
        if (action !== undefined && !managedActionCurrent(this.device.roster, write.options.action, action)) return refuse('action-required');
        race = result;
      }
      if (checked) return storeRefused(race ?? { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
      return storeRefused({ refused: 'out-of-order', message: 'This update does not follow the last one this device wrote to the shared history, so nothing was written. Nothing was changed.' });
    });
  }
  public findOwn(kind: string, predicate: (data: unknown) => boolean): Promise<OwnEntry | undefined> {
    return this.exclusive(async () => {
      // The ring answers only the keys the roster settled, so the roster is folded first.
      await this.foldNow();
      for (const entry of this.store.entries()) {
        if (entry.header.writer !== this.device.writer) continue;
        const opened = await this.openEntry(entry);
        if (opened === undefined || opened.kind !== kind) continue;
        if (predicate(opened.data)) return { hash: entryHash(entry.header), stream: entry.header.stream, seq: entry.header.seq, data: opened.data };
      }
      return undefined;
    });
  }

  /** Every own stored entry of a kind whose data the predicate accepts, with its stream and hash, in the store's order. findOwn without stopping. */
  public findOwnAll(kind: string, predicate: (data: unknown) => boolean): Promise<OwnEntry[]> {
    return this.exclusive(async () => {
      await this.foldNow();
      const found: OwnEntry[] = [];
      for (const entry of this.store.entries()) {
        if (entry.header.writer !== this.device.writer) continue;
        const opened = await this.openEntry(entry);
        if (opened === undefined || opened.kind !== kind) continue;
        if (predicate(opened.data)) found.push({ hash: entryHash(entry.header), stream: entry.header.stream, seq: entry.header.seq, data: opened.data });
      }
      return found;
    });
  }

  /**
   * The cells of the roster at its head of which this device's ring holds at least one epoch, sorted by cell: whether it is the base cell, the epochs
   * held, and for any other cell its label as sealed (any value; the caller reads it), opened from a grant of a held epoch, newest epoch first, as
   * membership's cellLabel does. A cell whose label does not open here has no label.
   */
  public heldCells(): Promise<HeldCell[]> {
    return this.exclusive(async () => {
      const { roster } = await this.foldNow();
      const position = roster.positions.length - 1;
      const held: HeldCell[] = [];
      for (const cell of [...roster.cells.cells.keys()].sort()) {
        if (epochAt(roster.cells, cell, position) === undefined) continue;
        const epochs = epochsAt(roster.cells, cell, position).map((item) => item.epoch).filter((epoch) => this.keys.holds(cell, epoch));
        if (epochs.length === 0) continue;
        if (cell === this.anchor.project) {
          held.push({ cell, base: true, epochs });
          continue;
        }
        const record = roster.cells.cells.get(cell);
        let label: unknown;
        for (const grant of [...(record?.grants ?? [])].sort((a, b) => b.epoch - a.epoch)) {
          if (grant.grant.labelSealed === '') continue;
          const key = this.keys.epochKey(cell, grant.epoch);
          if (key === undefined) continue;
          label = openLabel(key, cell, grant.epoch, grant.grant.labelSealed);
          if (label !== undefined) break;
        }
        held.push(label === undefined ? { cell, base: false, epochs } : { cell, base: false, epochs, label });
      }
      return held;
    });
  }
  public putGrants(grants: readonly unknown[], evidence: readonly unknown[] = []): Promise<{ ok: true; stored: number; opened: number } | ProjectRefused> {
    return this.exclusive(async () => {
      const own: unknown[] = [];
      for (const signed of grants) {
        const grant = readGrant(signed);
        own.push(grant.ok && this.device.roster !== this.device.identity && grant.signer.publicKey === this.device.identity.publicKey ? await this.signGrant(grant.grant) : signed);
      }
      const read = own.map((signed) => {
        const grant = readGrant(signed);
        if (!grant.ok) throw new Error('Nothing was stored: one of the cell grants does not read.');
        return { signed, grant: grant.grant };
      });
      for (const item of read) {
        const stored = await this.store.putGrant(item.grant.cell, item.grant.epoch, item.signed);
        if (!('ok' in stored)) return storeRefused(stored);
      }
      for (const opening of evidence) {
        const stored = await this.store.putAccessEvidence(opening);
        if (!('ok' in stored)) return storeRefused(stored);
      }
      const before = this.keys.size;
      const folded = await this.settledFold();
      if (folded !== undefined) return folded;
      return { ok: true as const, stored: read.length, opened: this.keys.size - before };
    });
  }
  public managedHandoffInbox() {
    return this.deps.knownFeatures?.includes(CELL_ACCESS_FEATURE) === true ? this.store.managedHandoffs(this.projectId, this.device.writer, () => this.now()).inbox() : undefined;
  }
  public sealManagedHandoff(input: ManagedHandoff): Promise<ManagedPacket | undefined>;
  public sealManagedHandoff(input: ManagedHandoff, durable: true): Promise<ManagedStagedSend | undefined>;
  public sealManagedHandoff(input: ManagedHandoff, durable: 'file', repeat?: string): Promise<ManagedKeyFile | undefined>;
  public sealManagedHandoff(input: ManagedHandoff, durable: boolean | 'file' = false, repeat?: string): Promise<ManagedPacket | ManagedStagedSend | ManagedKeyFile | undefined> {
    return this.exclusive(async () => {
      const { roster } = await this.foldNow();
      if (!isRosterWriterAt(roster, this.device.writer, roster.positions.length - 1)) return undefined;
      const signer = this.deps.sessionSigner ?? (this.device.roster === this.device.identity ? this.device.identity : undefined);
      const prepared = signer === undefined ? undefined : preparePlacedManagedHandoff(roster, this.evidence.map(({ value }) => value),
        input, this.now(), { authority: this.device.writer, signer });
      if (!durable || prepared === undefined) return prepared?.seal();
      const handoffs = this.store.managedHandoffs(this.projectId, this.device.writer, () => this.now());
      const snapshot = await this.store.appendSnapshot();
      return durable === 'file' ? handoffs.exportFile(prepared, snapshot, repeat) : handoffs.stage(prepared, snapshot);
    });
  }
  public supersededManagedContinuity(value: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.deps.knownFeatures?.includes(CELL_ACCESS_FEATURE) !== true) return false;
      const { writer, privateKey: x25519, kem } = ringDevice(this.device);
      return isSupersededManagedContinuity((await this.foldNow()).roster, { writer, x25519, kem }, value, this.now());
    });
  }
  public ingestManagedGrantDelivery(file: unknown, source: 'file' | 'peer' = 'file'): Promise<{ ok: true } | ProjectRefused> {
    return this.exclusive(async () => {
      if (this.deps.knownFeatures?.includes(CELL_ACCESS_FEATURE) !== true) return refuse('needs-update');
      const { writer, privateKey: x25519, kem } = ringDevice(this.device);
      const { roster } = await this.foldNow();
      const result = await ingestManagedDelivery(this.store, roster, this.evidence, { writer, x25519, kem }, file, source, () => this.now());
      if ('refused' in result) return 'message' in result ? storeRefused(result) : refuse(result.refused);
      const checked = result.verified;
      return await this.settledFold() ?? (checked === true || this.keys.holds(checked.cell, checked.epoch) ? { ok: true as const } : refuse('no-key'));
    });
  }
  public ingestWelcome(welcome: unknown): Promise<WelcomeResult> {
    return this.exclusive(async () => {
      const read = readWelcome(welcome, { genesisHash: this.anchor.genesisHash, writer: this.device.writer });
      if (!read.ok) return read.reason === 'wrong-project' ? refuse('pin-mismatch') : refuse('welcome-refused', read.message);
      return this.receiveWelcome(read.welcome, read.entries);
    });
  }
  public ingestForeign(entries: readonly unknown[], blobs: readonly SealedBlob[], packets: readonly ManagedPacket[] = []):
    Promise<(IngestResult & { paired?: readonly string[] }) | ProjectRefused> {
    return this.exclusive(async () => {
      const check = this.foreignCheck(blobs);
      const current = packets.length > 0 && this.deps.knownFeatures?.includes(CELL_ACCESS_FEATURE) === true ? (await this.foldNow()).roster : undefined;
      const expected = current === undefined ? undefined : await this.store.appendSnapshot();
      const { writer, privateKey: x25519, kem } = ringDevice(this.device);
      const pair = current === undefined ? undefined : previewManagedContinuity(this.rosterInputs(current), current, entries, { writer, x25519, kem }, packets);
      const result = await this.store.ingestForeign(entries, blobs, check, pair === undefined ? undefined : expected,
        pair === undefined ? undefined : () => this.now().getTime() < pair.expiresAt, pair);
      if (!('ok' in result)) return storeRefused(result);
      if (pair === undefined || (await this.foldNow()).roster.accessRevision?.entry !== pair.root) return result;
      return { ...result, paired: pair.handles.filter(({ digest }) => this.evidence.some(({ hash }) => hash === digest)).map(({ handle }) => handle) };
    });
  }
  public heldForCheck(): Array<{ hash: string; reason: string }> {
    return this.store.heldForCheck();
  }

  /** Build one admitted device's welcome with only its permitted grants. */
  public welcomeFor(writer: string, cells: readonly string[]): Promise<WelcomeFile> {
    return this.exclusive(async () => {
      const own = this.store.entries().filter((entry) => entry.header.stream === this.anchor.project);
      const genesis = own.find((entry) => entryHash(entry.header) === this.anchor.genesisHash);
      if (genesis === undefined) throw new Error('The welcome file was not made: this computer does not hold the project genesis.');
      const roster: SealedEntry[] = [];
      const blobs = new Map<string, SealedBlob>();
      for (const entry of own) {
        const opened = await this.openEntry(entry);
        // The roster line, and each device's post-quantum keys (33.2 D-03), which a device needs to wrap keys to the others.
        if (opened === undefined || (ROSTER_KIND_OWNER[opened.kind] === undefined && opened.kind !== 'device.kem')) continue;
        roster.push(entry);
        if (opened.blob === undefined) continue;
        const blob = this.blobCache.get(opened.blob) ?? await this.store.blob(opened.blob);
        if (blob !== undefined) blobs.set(blob.hash, blob);
      }
      const grants = (await this.foldNow()).roster.requiredFrom.has(CELL_ACCESS_FEATURE) ? [] : (await this.store.grants()).grants;
      return buildWelcome({ genesis, roster, blobs: [...blobs.values()], grants: grants.map((grant) => grant.signed), writer, cells });
    });
  }

  // ---- read access for the one-shot hub sync (32-23) -------------------------------------------------------------------------------------------

  /** Per stream, the head of every writer's log in the store (entries the decode check refused left out of the list of writers). */
  public heads(): Promise<HeadSet['streams']> {
    return this.exclusive(async () => {
      await this.refreshed();
      const streams = new Map<string, HeadSet['streams'][number]>();
      const seen = new Set<string>();
      for (const entry of this.store.rosterEntries()) {
        const { stream, writer } = entry.header;
        if (seen.has(`${stream}/${writer}`)) continue;
        seen.add(`${stream}/${writer}`);
        const head = this.store.head(stream, writer);
        if (head === undefined) continue;
        const row = streams.get(stream) ?? { stream, heads: [] };
        row.heads.push({ writer, seq: head.seq, hash: head.hash });
        streams.set(stream, row);
      }
      return [...streams.values()];
    });
  }

  /** The head of one writer's log in one stream, or undefined when the store holds none. */
  public head(stream: string, writer: string): Promise<{ seq: number; hash: string } | undefined> {
    return this.exclusive(async () => {
      await this.refreshed();
      return this.store.head(stream, writer);
    });
  }
  public holds(hashes: readonly string[]): Promise<Set<string>> {
    return this.exclusive(async () => {
      await this.refreshed();
      return new Set(hashes.filter((hash) => this.store.has(hash)));
    });
  }

  /** The stored entries of one writer in one stream above a seq, in seq order (entries the decode check refused left out). */
  public entriesAfter(stream: string, writer: string, seq: number): Promise<SealedEntry[]> {
    return this.exclusive(async () => {
      await this.refreshed();
      return this.store.rosterEntries().filter((entry) => entry.header.stream === stream && entry.header.writer === writer && entry.header.seq > seq).sort((a, b) => a.header.seq - b.header.seq);
    });
  }

  /** A blob this computer holds, or undefined. */
  public blob(hash: string): Promise<SealedBlob | undefined> {
    return this.exclusive(async () => this.blobCache.get(hash) ?? await this.store.blob(hash));
  }

  /** The blobs that entries waiting for a blob cite and this computer does not hold. */
  public wantedBlobs(): Promise<string[]> {
    return this.exclusive(async () => {
      const { fold } = await this.foldNow();
      // Entries the decode check waits on for a blob, and entries the fold holds for one (a proposal's text, a compaction's state).
      const waiting = new Set([...this.store.waitingForCheck().filter((item) => item.reason === 'awaiting-blob').map((item) => item.hash), ...fold.held.flatMap((item) => (item.reason === 'missing-blob' && item.hash !== undefined ? [item.hash] : []))]);
      const wanted = new Set<string>();
      for (const entry of this.store.rosterEntries()) {
        if (!waiting.has(entryHash(entry.header))) continue;
        for (const hash of this.citedBlobs(entry)) if (!this.blobCache.has(hash) && (await this.store.blob(hash)) === undefined) wanted.add(hash);
      }
      return [...wanted].sort();
    });
  }

  /** The blobs the given stored entries use, as append blobRefs: a body's blob and a compaction's state blob. Entries this device cannot open name none. */
  public blobsCitedBy(hashes: readonly string[]): Promise<Array<{ entry: string; blob: string }>> {
    return this.exclusive(async () => {
      await this.foldNow();
      const wanted = new Set(hashes);
      const refs: Array<{ entry: string; blob: string }> = [];
      for (const entry of this.store.rosterEntries()) {
        const hash = entryHash(entry.header);
        if (!wanted.has(hash)) continue;
        for (const blob of this.citedBlobs(entry)) refs.push({ entry: hash, blob });
      }
      return refs;
    });
  }

  /**
   * The deps that entries the chain stage holds for a missing predecessor cite and the store does not hold, each with the citing entry's stream
   * (D-50, D-63): the hub sync cites them for its withheld finding. Only those held entries are opened, and only their bodies (not a blob they use).
   */
  public missingDeps(): Promise<Citation[]> {
    return this.exclusive(async () => {
      const { fold } = await this.foldNow();
      const cited = new Map<string, Citation>();
      for (const held of fold.held) {
        if (held.stage !== 'chain' || held.reason !== 'missing-predecessor' || held.hash === undefined) continue;
        const entry = this.entryByHash(held.hash);
        const key = entry === undefined ? undefined : this.keys.epochKey(entry.header.stream, entry.header.epoch);
        const plain = entry === undefined || key === undefined ? undefined : openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
        const body = plain === undefined ? undefined : parseJson(plain);
        if (entry === undefined || !isRecord(body) || !Array.isArray(body.deps)) continue;
        for (const dep of body.deps as unknown[]) {
          if (!isRecord(dep) || typeof dep.writer !== 'string' || !HASH_PATTERN.test(dep.writer) || typeof dep.hash !== 'string' || !HASH_PATTERN.test(dep.hash)) continue;
          if (!Number.isSafeInteger(dep.seq) || (dep.seq as number) < 0 || cited.has(dep.hash) || this.store.has(dep.hash)) continue;
          cited.set(dep.hash, { stream: entry.header.stream, writer: dep.writer, seq: dep.seq as number, hash: dep.hash });
        }
      }
      return [...cited.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    });
  }

  /** Raw grants for legacy sync. Managed grants use a separate recipient-only delivery path. */
  public signedGrants(): Promise<Array<{ hash: string; signed: unknown }>> {
    return this.exclusive(async () => (await this.foldNow()).roster.requiredFrom.has(CELL_ACCESS_FEATURE) ? [] : (await this.store.grants()).grants.map((grant) => ({ hash: grant.hash, signed: grant.signed })));
  }

  /** Stores a signed checkpoint as evidence (the store names it by its checkpoint hash). */
  public putCheckpoint(signed: SignedCheckpoint): Promise<{ ok: true; hash: string } | ProjectRefused> {
    return this.exclusive(async () => {
      const stored = await this.store.putCheckpoint(signed);
      this.stored = undefined;
      return 'ok' in stored ? stored : storeRefused(stored);
    });
  }

  /** After an exchange: the newest checkpoint this hub's witness trusts, or undefined when it distrusts the hub. The next fold uses it. */
  public trustCheckpoint(hub: string, newest: SignedCheckpoint | undefined): void {
    (this.trusted ??= new Map()).set(hub, newest);
  }
  public checkpoints(): Promise<SignedCheckpoint[]> {
    return this.exclusive(async () => (await this.store.checkpoints()).checkpoints.map((item) => item.signed as SignedCheckpoint));
  }

  /** The cells the hub with this writer id holds at the roster head (the base cell and those granted with hub.grant), or undefined. */
  public hubCells(hubWriter: string): Promise<readonly string[] | undefined> {
    return this.exclusive(async () => {
      const { roster } = await this.foldNow();
      const device = deviceKeyOf(roster.members, hubWriter);
      return device === undefined ? undefined : hubCellsAt(roster.members, device.member, roster.positions.length - 1);
    });
  }

  /** Ends the decode worker this project made for itself (one passed in deps is the caller's to close). */
  public async close(): Promise<void> {
    await this.tail;
    const decoder = this.ownDecoder;
    this.ownDecoder = undefined;
    if (decoder !== undefined) await decoder.close();
  }

  // ---- inside ------------------------------------------------------------------------------------------------------------------------------------

  /** Runs one public step at a time on this object, so a fold never sees half of another step. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
  private decoder(): DecodeHost {
    if (this.deps.decodeHost !== undefined) return this.deps.decodeHost;
    this.ownDecoder ??= new DecodeHost();
    return this.ownDecoder;
  }

  /**
   * A welcome already read and checked: its entries stored through the decode check, its grants stored, and the roster folded so the key ring takes
   * the keys of the grants the roster placed. The welcome is not signed as a whole, so none of its grants is opened on its own word (CR-01).
   */
  private async receiveWelcome(welcome: WelcomeFile, entries: readonly SealedEntry[]): Promise<WelcomeResult> {
    const ingested = await this.store.ingestForeign(entries, welcome.blobs, this.foreignCheck(welcome.blobs));
    if (!('ok' in ingested)) return storeRefused(ingested);
    for (const signed of welcome.grants) {
      const grant = readGrant(signed);
      if (!grant.ok) continue;
      const stored = await this.store.putGrant(grant.grant.cell, grant.grant.epoch, signed);
      if (!('ok' in stored)) return storeRefused(stored);
    }
    const folded = await this.settledFold();
    if (folded !== undefined) return folded;
    return { ok: true, added: ingested.added, held: ingested.held };
  }

  /**
   * The store's ForeignCheck (D-05). Opens the body of a doc.update or doc.compact with this device's keys (and its blob, from this delivery or the
   * store) and asks the decode worker about the update bytes or the compacted state; a refusal holds the entry with the worker's reason. An entry
   * whose epoch key or blob is not here yet cannot be checked, so it waits (awaiting-key, awaiting-blob) and never reaches the fold unchecked
   * (31-REVIEW MJ-07). Every other kind, and a body that does not open under the key this device holds, passes: the fold checks it, holds it, or
   * refuses it.
   */
  private foreignCheck(blobs: readonly SealedBlob[]): ForeignCheck {
    const given = new Map<string, SealedBlob>();
    for (const blob of blobs) {
      if (!isRecord(blob) || typeof blob.hash !== 'string' || typeof blob.bytes !== 'string' || blob.bytes.length > MAX_BLOB_CHARS) continue;
      if (blobBytesHash(blob) === blob.hash) given.set(blob.hash, blob);
    }
    const blobOf = async (hash: unknown): Promise<SealedBlob | undefined> => {
      if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return undefined;
      return given.get(hash) ?? this.blobCache.get(hash) ?? await this.store.blob(hash);
    };
    return async (entry) => {
      const { stream, epoch } = entry.header;
      const key = this.keys.epochKey(stream, epoch);
      if (key === undefined) return AWAITING_KEY;
      const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
      const body = plain === undefined ? undefined : parseJson(plain);
      if (!isRecord(body) || (body.kind !== 'doc.update' && body.kind !== 'doc.compact')) return PASS;
      let data: unknown = body.data;
      if (body.blob !== undefined) {
        const blob = await blobOf(body.blob);
        if (blob === undefined) return AWAITING_BLOB;
        const opened = openBlob(key, stream, epoch, blob);
        if (opened === undefined) return PASS;
        data = parseJson(opened);
      }
      if (!isRecord(data)) return PASS;
      let verdict: DecodeVerdict;
      if (body.kind === 'doc.update') {
        if (typeof data.update !== 'string') return PASS;
        verdict = await this.decoder().inspect('update', Buffer.from(data.update, 'base64url'));
      } else {
        const state = await blobOf(data.stateBlob);
        if (state === undefined) return AWAITING_BLOB;
        const opened = openBlob(key, stream, epoch, state);
        if (opened === undefined) return PASS;
        verdict = await this.decoder().inspect('state', opened);
      }
      if (verdict.ok) return PASS;
      return { ok: false, reason: `The decode check refused this ${body.kind === 'doc.update' ? 'update' : 'compaction'} (${verdict.error}).` };
    };
  }
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Reads what other windows wrote since the store last looked; refused like open when a file went backwards. */
  private async refreshed(): Promise<void> {
    const refreshed = await this.store.refresh();
    if (!('ok' in refreshed)) throw new ReplicaProjectError(storeRefused(refreshed));
  }
  /** The blobs an entry's body names, when this device can open it: the body's own blob and a compaction's state blob. */
  private citedBlobs(entry: SealedEntry): string[] {
    const key = this.keys.epochKey(entry.header.stream, entry.header.epoch);
    if (key === undefined) return [];
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    const body = plain === undefined ? undefined : parseJson(plain);
    if (!isRecord(body)) return [];
    const found: string[] = [];
    if (typeof body.blob === 'string' && HASH_PATTERN.test(body.blob)) found.push(body.blob);
    if (body.kind === 'doc.compact' && isRecord(body.data) && typeof body.data.stateBlob === 'string' && HASH_PATTERN.test(body.data.stateBlob)) found.push(body.data.stateBlob);
    if (body.kind === 'version.propose' && isRecord(body.data) && typeof body.data.textBlob === 'string' && HASH_PATTERN.test(body.data.textBlob)) found.push(body.data.textBlob);
    return found;
  }
  private async foldNow(): Promise<ProjectState> {
    const refreshed = await this.store.refresh();
    if (!('ok' in refreshed)) throw new ReplicaProjectError(storeRefused(refreshed));
    await this.loadGrants();
    await this.loadBlobs();
    await this.recheckWaiting();
    // The roster fold reads awaiting-key entries to settle the keys (CR-01). The main fold only takes entries that pass the retry (MJ-07).
    const rosterEntries = this.store.rosterEntries();
    const evidenceKey = this.evidence.map(({ hash }) => hash).join(',');
    const rosterKey = (): string => `${rosterEntries.length}|${this.grantHashes.size}|${this.keys.version}|${this.blobCache.size}|${evidenceKey}`;
    if (this.rosterState === undefined || rosterKey() !== this.rosterKey) {
      this.rosterState = await this.foldRosterAndKeys(rosterEntries);
      this.rosterKey = rosterKey();
    }
    // POST-01 (D-06): a required feature this build lacks stops the project here, before any other family is folded. The store keeps every entry.
    if (requireProblem(this.rosterState, this.deps.knownFeatures) !== undefined) throw new ReplicaProjectError(refuse('needs-update'));
    await this.recheckWaiting();
    const entries = this.store.entries();
    const roster = this.rosterState;
    const ctxKey = `${rosterSignature(roster)}|${this.keys.version}|${this.blobCache.size}|${evidenceKey}`;
    if (this.ctx === undefined || ctxKey !== this.ctxKey) {
      this.ctx = this.buildContext(roster);
      this.ctxKey = ctxKey;
    }
    // A changed set of usable checkpoints folds everything again under it (the order and the join bases depend on it).
    const checkpoints = await this.usableCheckpoints(roster);
    const key = checkpoints.map(checkpointHash).join(',');
    if (key !== this.checkpointKey) { this.checkpointKey = key; this.foldState = undefined; this.fed.clear(); }
    const fresh = entries.filter((entry) => !this.fed.has(entryHash(entry.header)));
    if (this.foldState === undefined) this.foldState = createFoldState(this.ctx, { checkpoints });
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
  /** The stored checkpoints the witness of an admitted hub trusts (foldCheckpoints.ts); the witness memory is read once, at the first fold. */
  private async usableCheckpoints(roster: RosterState): Promise<SignedCheckpoint[]> {
    this.stored ??= (await this.store.checkpoints()).checkpoints.map((item) => item.signed as SignedCheckpoint);
    if (this.stored.length > 0) this.trusted ??= await trustedCheckpointsOf(this.deps.secrets, this.projectId, this.stored);
    return foldCheckpoints(this.stored, this.trusted ?? new Map(), rosterView(roster), this.projectId, roster.positions.at(-1) as string);
  }

  /**
   * Runs the decode check again on the entries still waiting for it (31-REVIEW MJ-07) when something that could change its answer changed: a key
   * arrived in the ring, a blob arrived, or an entry nobody had checked was found on disk.
   */
  private async recheckWaiting(): Promise<void> {
    const key = `${this.keys.version}|${this.blobCache.size}|${this.store.waitingVersion}`;
    if (key === this.recheckKey) return;
    if (this.store.waitingForCheck().length > 0) {
      const rechecked = await this.store.recheck(this.foreignCheck([]));
      if (!('ok' in rechecked)) throw new ReplicaProjectError(storeRefused(rechecked));
    }
    this.recheckKey = key;
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

  /** A fold run for its effect on the key ring, after grants or a welcome were stored: undefined, or the refusal when the store refuses on refresh. */
  private async settledFold(): Promise<ProjectRefused | undefined> {
    try {
      await this.foldNow();
      return undefined;
    } catch (error) {
      if (error instanceof ReplicaProjectError) return error.refusal;
      throw error;
    }
  }
  private rosterInputs(roster?: RosterState, entries: readonly SealedEntry[] = this.store.rosterEntries(), reading = roster && this.readingKeys(roster, entries)): RosterFoldInput {
    return { entries, anchor: this.anchor, grants: this.grantList, grantEvidence: this.evidence.map(({ value }) => value), now: this.now(),
      keys: (stream, epoch) => this.keys.epochKey(stream, epoch) ?? (stream === this.anchor.project ? reading?.get(epoch) : undefined),
      blobs: (hash) => this.blobCache.get(hash) };
  }
  /** Settle the roster and its placed keys in turns (CR-01, D-44). Temporary reading keys are never used for writes. */
  private async foldRosterAndKeys(entries: readonly SealedEntry[]): Promise<RosterState> {
    const project = this.anchor.project;
    let reading = new Map<number, Buffer>();
    const fold = (): RosterState => foldRoster(this.rosterInputs(undefined, entries, reading));
    let roster = fold();
    // Each turn reaches at least one more base epoch or ends the loop, so the bound only stops a roster that keeps changing its mind.
    const epochs = new Set(entries.filter((entry) => entry.header.stream === project).map((entry) => entry.header.epoch)).size;
    for (let turn = 0; turn < 2 * epochs + 2; turn += 1) {
      const { writer, privateKey: x25519, kem } = ringDevice(this.device);
      if (this.deps.knownFeatures?.includes(CELL_ACCESS_FEATURE) === true &&
          await promoteManagedDeliveries(this.store, roster, this.evidence, { writer, x25519, kem }, () => this.now())) {
        this.evidence = await this.store.accessEvidence();
        roster = fold();
      }
      const settled = await this.keys.settle(roster.cells);
      const next = this.readingKeys(roster, entries);
      if (settled === 0 && sameReadingKeys(next, reading)) break;
      reading = next;
      roster = fold();
    }
    return roster;
  }

  /** Temporary base-epoch keys for historical reads (D-45) must open an entry signed by a roster authority. */
  private readingKeys(roster: RosterState, entries: readonly SealedEntry[]): Map<number, Buffer> {
    const project = this.anchor.project;
    const keys = new Map<number, Buffer>();
    const unheld = new Set<number>();
    for (const entry of entries) if (entry.header.stream === project && !this.keys.holds(project, entry.header.epoch)) unheld.add(entry.header.epoch);
    if (unheld.size === 0) return keys;
    const candidates = this.keys.readingCandidates(project, legacyReadingGrants(roster, this.grantList)).filter((candidate) => unheld.has(candidate.epoch));
    if (candidates.length === 0) return keys;
    const tried = new Set(candidates.map((candidate) => candidate.epoch));
    const holders = new Set<string>([this.anchor.lead.member]);
    for (const lead of roster.leads) holders.add(lead.member);
    for (const deputy of roster.deputies) if (deputy.member !== undefined) holders.add(deputy.member);
    const waiting = new Map<number, SealedEntry[]>();
    for (const entry of entries) {
      const { stream, epoch, writer } = entry.header;
      if (stream !== project || !tried.has(epoch)) continue;
      const device = deviceKeyOf(roster.members, writer);
      if (device === undefined || !holders.has(device.member) || !verifyHeader(entry.header, device.publicKey)) continue;
      const list = waiting.get(epoch) ?? [];
      list.push(entry);
      waiting.set(epoch, list);
    }
    for (const candidate of candidates) {
      const sealed = waiting.get(candidate.epoch);
      if (sealed === undefined || keys.has(candidate.epoch)) continue;
      if (sealed.some((entry) => openBody(candidate.key, entry.header, Buffer.from(entry.body, 'base64url')) !== undefined)) keys.set(candidate.epoch, candidate.key);
    }
    return keys;
  }
  /** Grants new on disk since the last look, kept for the roster fold. Only the grants the fold places are opened into the key ring (settle). */
  private async loadGrants(): Promise<void> {
    const { grants } = await this.store.grants();
    this.evidence = await this.store.accessEvidence();
    for (const grant of grants) {
      if (this.grantHashes.has(grant.hash)) continue;
      this.grantHashes.add(grant.hash);
      this.grantList.push(grant.signed);
    }
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
  private async storeSigned(built: BuiltEntry, expected: string, mayCommit?: () => boolean, stage?: unknown): Promise<IngestResult | StoreRefused> {
    const result = await this.store.ingestForeign([built.entry], built.blobs, this.foreignCheck(built.blobs), expected, mayCommit, stage === undefined ? undefined : { root: built.hash, evidence: [stage] });
    // This device built it with keys it holds, so a held or waiting answer is a broken invariant, never a race to retry.
    if ('ok' in result && result.held.length + result.waiting.length > 0) throw new ReplicaProjectError(refuse('store-refused'));
    return result;
  }
  private async buildOwn(roster: RosterState, kind: string, data: unknown, options: AppendOwnOptions, build = buildEntryAsync): Promise<BuiltEntry | ProjectRefused> {
    const stream = options.stream ?? this.anchor.project;
    if (!STREAM_ID_PATTERN.test(stream)) throw new Error('Nothing was written: a stream id is 32 lowercase hex characters.');
    const cited = options.roster ?? roster.positions[roster.positions.length - 1];
    const position = roster.positionOf.get(cited);
    if (position === undefined) throw new Error('Nothing was written: the roster this entry would cite is not in this project\'s roster.');
    const epoch = epochAt(roster.cells, stream, position);
    const key = epoch === undefined ? undefined : this.keys.epochKey(stream, epoch);
    if (epoch === undefined || key === undefined) return refuse('no-key');
    const rosterControl = stream === this.anchor.project && // Recovery remains available during rotation.
      (Object.hasOwn(ROSTER_KIND_OWNER, kind) || kind === 'device.kem' || kind === 'session.certify');
    const chosen = options.signer ?? this.signerOf(kind);
    if (!rosterControl && !(managedWriteAllowed(roster, stream, epoch, writerIdOf(chosen.publicKey), position, this.now(),
      options.accessProof, this.evidence.flatMap(({ value }) => storedAccessProofs(value, roster.accessRevision?.entry))) ??
      canWriteCurrentEpoch(roster, stream, epoch))) return refuse('rekey-pending');
    // 33.1 D-09: in a hosted project only the person signer signs a person-key kind, and a kind outside Phase 33's list only under its action.
    const person = this.deps.personSigner;
    if ((person !== undefined || this.deps.sessionSigner !== undefined) && isPersonKeyKind(kind) && chosen !== person) return refuse('person-key-required');
    if (person !== undefined && options.action === undefined && requiresActionId(kind)) return refuse('action-required');
    const action = options.action;
    const signer = action === undefined ? chosen : { fingerprint: chosen.fingerprint, publicKey: chosen.publicKey, sign: async (bytes: Buffer) => chosen.sign(bytes, { action }) };
    const head = this.store.head(stream, writerIdOf(signer.publicKey));
    const deps: Dep[] = (options.deps ?? []).map((hash) => {
      const entry = this.entryByHash(hash);
      if (entry === undefined) throw new Error('Nothing was written: an entry this one depends on is not in this project\'s store.');
      return { writer: entry.header.writer, seq: entry.header.seq, hash };
    });
    const preds = [...(head === undefined ? [] : [head.hash]), ...deps.map((dep) => dep.hash)];
    const lamport = 1 + Math.max(0, ...preds.map((hash) => this.lamportOf(hash)));
    const body = ROSTER_KIND_OWNER[kind] !== undefined && kind !== 'project.genesis' && isRecord(data) && !Object.hasOwn(data, 'rosterPrev') ? { ...data, rosterPrev: cited } : data;
    const built = await build({
      signer, key, stream, seq: head === undefined ? 0 : head.seq + 1, prev: head?.hash ?? GENESIS_PREV, epoch,
      body: { deps, roster: cited, lamport, at: options.at ?? this.now().toISOString(), actor: options.actor ?? { kind: 'person' }, kind, data: body }
    });
    if (!('entry' in built)) return refuse('signer-refused', built.refused);
    if (options.contentBlob !== undefined) {
      if (openBlob(key, stream, epoch, options.contentBlob) === undefined) return refuse('store-refused');
      built.blobs.push(options.contentBlob);
    }
    return built;
  }
}

/** Present the store and its verified intake to the normal hub exchange. */
export function syncLocalOf(project: ReplicaProject): SyncLocal {
  const settle = <T>(value: T | ProjectRefused): T => {
    if (isProjectRefused(value)) throw new ReplicaProjectError(value);
    return value;
  };
  return {
    project: project.projectId,
    writer: project.deviceWriter,
    roster: async () => rosterView((await project.state()).roster),
    heads: () => project.heads(),
    head: (stream, writer) => project.head(stream, writer),
    holds: (hashes) => project.holds(hashes),
    entriesAfter: (stream, writer, seq) => project.entriesAfter(stream, writer, seq),
    blob: (hash) => project.blob(hash),
    wantedBlobs: () => project.wantedBlobs(),
    blobsCitedBy: (hashes) => project.blobsCitedBy(hashes),
    grants: () => project.signedGrants(),
    managed: {
      seal: (offer) => project.sealManagedHandoff(offer), prepare: (offer) => project.sealManagedHandoff(offer, true),
      stage: async (value) => !isProjectRefused(await project.ingestManagedGrantDelivery(value, 'peer')),
      superseded: (value) => project.supersededManagedContinuity(value)
    },
    async ingest(entries, blobs, packets) {
      const received = await project.ingestForeign(entries, blobs, packets);
      if (isProjectRefused(received) && received.store === 'snapshot-changed' && packets?.length) return { added: 0, notStored: entries.length };
      const result = settle(received);
      return { added: result.added, notStored: result.deferred + result.flooded + result.dropped, paired: result.paired };
    },
    async putGrants(grants) {
      settle(await project.putGrants(grants));
    },
    checkpoints: () => project.checkpoints(),
    async putCheckpoint(signed) {
      settle(await project.putCheckpoint(signed));
    },
    covered: (hub) => project.hubCells(hub),
    missingDeps: () => project.missingDeps(),
    trustCheckpoint: (hub, newest) => project.trustCheckpoint(hub, newest)
  };
}
