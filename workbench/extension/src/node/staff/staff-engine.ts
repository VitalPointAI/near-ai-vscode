/**
 * The staff engine bundle as the backend sees it (Phase 33 D-51; the Phase 46 D-15 pattern). tools/staff-engine-entry.ts re-exports the
 * host-neutral engine names from the repository's src/, tools/build-engine.mjs bundles them into `<appRoot>/engine/staff.cjs`, and the backend
 * loads that file on first use. The extension's own code cannot import src/ (its rootDir is extension/src), so the names it calls are typed here
 * structurally; the workbench lint checks this interface against the entry. Nothing here imports Theia, and nothing here reaches the browser.
 */
import type { KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultAppRoot } from '../team-preview-reader.js';

/** The fields a session key's binding covers (src/domain/replica/sessionKeys.ts). */
export interface SessionBindingFields {
  readonly project: string;
  readonly member: string;
  readonly device: string;
  readonly sessionKey: string;
  readonly slot: number;
  readonly notAfter: string;
}

/** The data of a session.certify entry: the binding fields without the project, and the session key's own signature over the binding. */
export interface SessionCertifyData {
  readonly member: string;
  readonly device: string;
  readonly sessionKey: string;
  readonly slot: number;
  readonly notAfter: string;
  readonly sessionSig: string;
}

/** A device's post-quantum public keys as base64url (src/domain/replica/cellWrapV2.ts KemPublicKeys). */
export interface KemPublicKeys {
  readonly p256: string;
  readonly mlkem768: string;
}

/** The post-quantum private parts as kept: the 32-byte P-256 scalar and the 64-byte ML-KEM-768 seed. */
export interface KemSeeds {
  readonly p256: Buffer;
  readonly mlkem768: Buffer;
}

export interface KemPrivateKeys {
  readonly p256: KeyObject;
  readonly mlkem768: KeyObject;
}

/** A refusal of the replica project (src/staff/replica/replicaProject.ts ProjectRefused). */
export interface EngineRefused {
  readonly refused: string;
  readonly message: string;
}

/** A device's versions in the roster, as far as the live engine reads them. */
export interface EngineDeviceRecord {
  readonly member: string;
  readonly slot?: number;
  readonly kind: 'person' | 'hub';
}

/** The roster state, as far as the live engine reads it; anything else of it is passed back to the engine untouched. */
export interface EngineRoster {
  readonly required?: readonly string[];
  readonly positions: readonly string[];
  readonly members: { readonly devices: ReadonlyMap<string, readonly EngineDeviceRecord[]> };
}

/** An open shared project (ReplicaProject), as far as the live engine uses it. */
export interface EngineProject {
  readonly projectId: string;
  readonly deviceWriter: string;
  readonly signer: { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string };
  state(): Promise<{ readonly roster: EngineRoster; readonly fold: unknown }>;
  appendOwn(kind: string, data: unknown, options?: object): Promise<{ readonly ok: true; readonly hash: string; readonly built: { readonly entry: unknown } } | EngineRefused>;
  close(): Promise<void>;
}

/** The replicator's status (src/staff/replica/liveReplicator.ts LiveStatus). */
export interface EngineLiveStatus {
  readonly state: string;
  readonly since: number;
  readonly reason?: string;
  readonly findings: readonly string[];
  readonly pulled: number;
  readonly pushed: number;
  readonly lastSyncedAt?: number;
  readonly retryAt?: number;
}

/** One live replicator (src/staff/replica/liveReplicator.ts LiveReplicator). */
export interface EngineReplicator {
  readonly status: EngineLiveStatus;
  onStatus(listener: (status: EngineLiveStatus) => void): { dispose(): void };
  start(): Promise<void>;
  stop(): Promise<void>;
  syncNow(): void;
  localAppended(): void;
}

/** One hub as the roster has it (src/staff/replica/hubMembership.ts HubStanding). */
export interface EngineHubStanding {
  readonly hub: string;
  readonly writer?: string;
  readonly certPin: string;
  readonly standing: 'admitted' | 'revoked';
}

/** The live engine's names (33-24): the replica project, the live replicator and what runs beside them. */
export interface StaffLiveApi {
  readonly ReplicaProject: { open(root: string, deps: never): Promise<EngineProject | EngineRefused | undefined> };
  isProjectRefused(value: unknown): value is EngineRefused;
  syncLocalOf(project: never): object;
  readonly LiveReplicator: new (options: never) => EngineReplicator;
  hubMemoryOf(secrets: never): object;
  hubStanding(shared: never): Promise<EngineHubStanding[]>;
  readHubAddress(globalStorageDir: string, project: string, expect?: { readonly hub?: string }): Promise<{ readonly address: string } | undefined>;
  ensureRequireArmed(project: never): Promise<unknown>;
  projectLive(root: string, input: never, options: { readonly globalStorageDir: string; readonly project: string; readonly bound?: ReadonlySet<string> }): Promise<{ readonly written: string[]; readonly left: ReadonlyArray<{ readonly path: string; readonly reason: string }> }>;
  projectionInputOf(project: never, deps: never): Promise<unknown>;
  compactAfterCheckpoint(project: never, input: never): Promise<{ readonly compacted: string[] }>;
  syncStatusFor(root: string): { setStatus(status: never): void };
  syncSentence(status: never): string;
  readonly UPDATE_SENTENCE: string;
  isRosterWriterAt(state: never, writer: string, position: number): boolean;
  /** The cell order the fold checks writes against (D-25), as the extension's staff host builds it. */
  cellOrderHook(options: { readonly now?: () => Date }): unknown;
}

/** One replacement in a bound document: `length` characters at `offset` become `text` (src/staff/replica/editorBinding.ts DocumentEdit). */
export interface EngineDocumentEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

/** A change of a bound document (editorBinding.ts BoundDocumentChange). */
export interface EngineDocumentChange {
  readonly edits: readonly EngineDocumentEdit[];
  readonly text: string;
  readonly version: number;
  readonly reason?: 'undo' | 'redo';
}

/** The document the binding core edits (editorBinding.ts BoundDocument). */
export interface EngineBoundDocument {
  readonly version: number;
  getText(): string;
  applyEdits(edits: readonly EngineDocumentEdit[], expectedText: string, baseVersion: number, lineEndings?: 'lf'): Promise<boolean>;
  onDidChange(listener: (change: EngineDocumentChange) => void): () => void;
}

/** One open binding (editorBinding.ts EditorBinding). */
export interface EngineEditorBinding {
  text(): string;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  flush(): Promise<{ appended: number; queued: number }>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/** A product as the projection states it, as far as the binding reads it: its section folder. */
export interface EngineProductState {
  readonly record: { readonly section: string };
}

/** The editor binding names (33-25): the binding core and the projection's paths and headers. */
export interface StaffBindingApi {
  readonly EditorBinding: {
    open(document: EngineBoundDocument, product: { project: never; stream: string; product: string; actor: { kind: 'person' }; header(): string },
      hooks: { notice?(text: string): void; log?(line: string): void; onAppended?(): void }): Promise<EngineEditorBinding>;
  };
  readonly HEADER_KEPT_TEXT: string;
  readonly RESYNC_LOG_LINE: string;
  projectProductStates(input: never): Map<string, EngineProductState>;
  projectProductFile(state: never, body: string): string;
  staffProductPath(section: never, product: string): string;
}

/** The Staff Room's names (33-26): the live model, the version acts, the contested cards and version rows, and the roster split. */
export interface StaffRoomApi {
  staffRoomLive(input: never): unknown;
  memberNameAt(roster: never, member: string, at: string): string | undefined;
  whoCanSee(roster: never, stream: string): string[];
  readonly VersionActs: new (project: never, actor: never, context?: never) => unknown;
  readonly CHANGED_WHILE_DECIDING_TEXT: string;
  contestedCards(products: never, names: (member: string, roster: string) => string | undefined): unknown[];
  changesSinceRows(products: never): unknown[];
  pendingConfirmation(products: never): unknown[];
  chooseRosterBranch(shared: never, branch: string): Promise<unknown>;
  describeRosterBranches(shared: never): Promise<unknown[]>;
  /** 33.2-07: the cards of the switch to post-quantum keys this computer sees, and their three actions (src/staff/replica/wrapUpgrade.ts). */
  wrapCardsFor(shared: never): Promise<unknown[]>;
  switchToV2(shared: never): Promise<unknown>;
  moveCellsToV2(shared: never, options?: { readonly includeWaiting?: boolean }): Promise<unknown>;
  giveKeys(shared: never): Promise<unknown>;
}

/** The engine names the staff backend calls. */
export interface StaffEngine extends StaffLiveApi, StaffBindingApi, StaffRoomApi {
  newKemSeeds(): KemSeeds;
  kemPublicFromSeeds(seeds: KemSeeds): KemPublicKeys;
  kemPrivateFromSeeds(seeds: KemSeeds): KemPrivateKeys;
  probeWrapV2(): boolean;
  kemBindingBytes(keys: KemPublicKeys, writer: string): Buffer;
  /** The roster's v2 keys for a device; the roster is the engine's RosterState, passed through untouched. */
  kemKeysAt(roster: never, writer: string): KemPublicKeys | undefined;
  sessionCertifyData(fields: SessionBindingFields, sign: (bytes: Buffer) => string): SessionCertifyData;
  writerIdOf(publicKey: string): string;
  readonly SESSION_DEFAULT_LIFETIME_MS: number;
  readonly ENCRYPTION_KEY_SECRET: string;
  readonly EPOCH_KEY_SECRET_PREFIX: string;
  readonly JOIN_SECRET_PREFIX: string;
}

const loaded = new Map<string, unknown>();

/**
 * The engine bundle under `appRoot` (by default the app root computed from this code's own location, never the working folder). Loaded once
 * per path. Throws a plain error when the bundle is missing, which is a broken image, not something a person can fix.
 */
export function loadStaffEngine<T extends object = StaffEngine>(appRoot: string = defaultAppRoot()): T {
  const file = resolve(appRoot, 'engine', 'staff.cjs');
  if (!loaded.has(file)) {
    try {
      loaded.set(file, createRequire(file)(file));
    } catch (error) {
      throw new Error('The shared-work engine is missing from this workbench build.', { cause: error });
    }
  }
  return loaded.get(file) as T;
}
