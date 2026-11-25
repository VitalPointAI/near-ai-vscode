/**
 * The live engine of a person's session (Phase 33 D-47 superseded, D-50 to D-52, D-61, D-64, D-67; the hooks of superseded 33-10). One per session
 * backend. It looks in the workspace roots for shared projects, opens each, and runs one live replicator for it; a folder whose project is not
 * shared starts nothing. Everything runs in the backend (D-51): the browser receives only the status rows and, on a lead's or deputy's tab, the
 * join requests.
 *
 *   start      each workspace root: open the project (undefined: not shared, nothing starts; refused: its sentence on the row)
 *              hosted: certify the session key in it (33-23), publish the person's post-quantum keys (33.2-04 publishPersonKem)
 *              single machine: publishKem at open (33.2 D-05), the device key signs as before
 *              a lead or deputy device arms roster.require (33-03)
 *              one LiveReplicator, with the session signer and the certificate in a hosted session
 *   status     every status goes to the workspace's StaffSyncStatus store and to every client as a row (state word and sentence)
 *   exchange   after each one that brought something, the projector writes the product files not open in an editor (33-06)
 *   checkpoint the compactor runs when due (33-06)
 *   join       a join-request frame reaches the clients only on a lead or deputy device (D-12)
 *   keys       the switch to post-quantum keys (33.2 D-05): this computer's cards, and switchToV2, moveCellsToV2 and giveKeys for the Staff Room
 *   update     a project that requires a feature this build lacks stops with the D-67 sentence; its store keeps every entry
 *   presence   one LivePresence per project (33-12, run here by 33-29): sealed heartbeats and cursors through the replicator, the people list
 *              to listeners (the Staff Room, the editor binding's cursors); nothing about it is stored
 *   stop       replicators stopped, projects closed, the session keys and the opened encryption key dropped
 *
 * No log line holds project text, a key, a token or a name. Nothing here imports Theia.
 */
import type { SessionKeys } from './session-keys.js';
import type { OpenedEncryptionKey } from './encryption-key.js';
import type { SecretStorageLike } from './keystore-secrets.js';
import type {
  EngineHubStanding, EngineLiveStatus, EnginePresencePerson, EnginePresenceTimers, EngineProject, EngineProjectPresence, EngineReplicator, StaffEngine,
} from './staff-engine.js';
import type { StaffJoinRequest, StaffStatusRow } from '../../common/staff-live.js';
import { STAFF_ROOM_TEXT } from '../../common/staff-room.js';
import { publishPersonKem } from './person-kem.js';

/** What a hosted session brings (33-23): its session keys and the person's opened encryption key. */
export interface HostedSessionKeys {
  readonly keys: SessionKeys;
  readonly encryption: OpenedEncryptionKey;
}

export interface StaffLiveEngineOptions {
  readonly engine: StaffEngine;
  /** The workspace roots, as Theia's workspace names them. */
  readonly roots: () => Promise<readonly string[]>;
  /** Where the engine keeps its per-person files (genesis pins, the hub address, the projector's record). */
  readonly globalStorageDir: string;
  /** The person's secrets: the key store (hosted) or this computer's keyring (single machine). */
  readonly secrets: SecretStorageLike;
  /** Present in a hosted session; absent on a single machine, where the device key path runs unchanged. */
  readonly hosted?: HostedSessionKeys;
  /** Replicator options the tests set: the transport, the timers and the clock. */
  readonly replicator?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  /** The clock and timers presence runs on (the tests set them). */
  readonly presence?: { readonly now?: () => number; readonly timers?: EnginePresenceTimers };
  /** One short line per step; never project text, a key, a token or a name. */
  readonly log?: (line: string) => void;
}

interface LiveProject {
  readonly root: string;
  readonly project: EngineProject;
  readonly deps: object;
  replicator?: EngineReplicator;
  presence?: EngineProjectPresence;
  people: EnginePresencePerson[];
  row: StaffStatusRow;
  pulled: number;
  bound: Set<string>;
  readonly subscriptions: Array<{ dispose(): void }>;
}

/** The answer of a key action: done, or refused with its reason and the sentence a person reads. */
export type StaffKeysAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly message: string };

/** wrapUpgrade.ts WrapActionSkip, in words. */
const KEYS_SKIPPED: Readonly<Record<string, string>> = {
  'already-switched': STAFF_ROOM_TEXT.keysAlreadySwitched,
  'not-a-lead-device': STAFF_ROOM_TEXT.keysNotLead,
  'keys-not-published': STAFF_ROOM_TEXT.keysNotPublished,
  'not-switched': STAFF_ROOM_TEXT.keysNotSwitched,
  'nothing-to-do': STAFF_ROOM_TEXT.keysNothingToDo,
};

/** A key action's result as plain data: a skip, the project's refusal or a membership refusal keeps its sentence; a move or a grant of nothing is nothing to do. */
function keysAnswer(result: unknown): StaffKeysAnswer {
  const value = result as { ok?: boolean; skipped?: unknown; refused?: string; reason?: string; message?: string; rekeyed?: unknown[]; given?: unknown[] };
  const nothing = { ok: false, reason: 'nothing-to-do', message: STAFF_ROOM_TEXT.keysNothingToDo } as const;
  if (typeof value.skipped === 'string') return { ok: false, reason: value.skipped, message: KEYS_SKIPPED[value.skipped] ?? STAFF_ROOM_TEXT.keysNothingToDo };
  if (value.refused !== undefined) return { ok: false, reason: value.refused, message: value.message ?? STAFF_ROOM_TEXT.keysNothingToDo };
  if (value.ok === false) return { ok: false, reason: value.reason ?? 'refused', message: value.message ?? STAFF_ROOM_TEXT.keysNothingToDo };
  if ((value.rekeyed !== undefined && value.rekeyed.length === 0) || (value.given !== undefined && value.given.length === 0)) return nothing;
  return { ok: true };
}

type RowListener = (row: StaffStatusRow) => void;
type JoinListener = (request: StaffJoinRequest) => void;
type PeopleListener = (project: string, people: readonly EnginePresencePerson[]) => void;

/** In a hosted session the store's mark is trusted by the person's key store path, which only the person's token writes: any session key signs it. */
const HOSTED_MARK_KEYS = (): Promise<() => { state: 'active' }> => Promise.resolve(() => ({ state: 'active' as const }));

export class StaffLiveEngine {
  private readonly open = new Map<string, LiveProject>();
  private readonly rowListeners = new Set<RowListener>();
  private readonly joinListeners = new Set<JoinListener>();
  private readonly peopleListeners = new Set<PeopleListener>();
  private readonly certificates = new Map<string, unknown>();
  private started = false;
  private stopped = false;

  constructor(private readonly options: StaffLiveEngineOptions) {}

  /** Opens every shared project in the workspace roots and starts its replicator. Once. */
  public async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const root of await this.options.roots()) {
      if (this.stopped) return;
      await this.startRoot(root);
    }
  }

  /** Stops every replicator, closes every project and drops the session's keys. Idempotent. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const live of this.open.values()) await this.close(live);
    this.open.clear();
    this.options.hosted?.keys.stop();
    this.options.hosted?.encryption.drop();
  }

  /** The row of every open shared project. */
  public projects(): StaffStatusRow[] {
    return [...this.open.values()].map((live) => live.row);
  }

  /** The open project with this id, for later native plans (binding, Staff Room). */
  public project(id: string): EngineProject | undefined {
    return this.find(id)?.project;
  }

  /** Products open in a bound editor (33-25): the projector leaves their files to the binding. */
  public setBound(id: string, products: readonly string[]): void {
    const live = this.find(id);
    if (live !== undefined) live.bound = new Set(products);
  }

  /** What Share with people (33-27) works with: the deps shared projects open with here, the person's secrets and storage, the session keys. */
  public shareContext(): { deps: object; secrets: SecretStorageLike; globalStorageDir: string; hosted?: HostedSessionKeys } {
    const { secrets, globalStorageDir, hosted } = this.options;
    return { deps: this.depsFor(), secrets, globalStorageDir, ...(hosted === undefined ? {} : { hosted }) };
  }

  /** Hosted: the session key's certificate in this project, which a lead flow's own connection to the server carries (33-27). */
  public certificateOf(id: string): unknown {
    return this.certificates.get(id);
  }

  /** Opens a folder that became shared, or opens it again after its server changed (33-27): its replicator starts as at start. */
  public async reopen(root: string): Promise<void> {
    if (this.stopped) return;
    const live = this.open.get(root);
    if (live !== undefined) {
      this.open.delete(root);
      await this.close(live);
    }
    await this.startRoot(root);
  }

  /** The projection input of an open project (the fold, its entries and labels), for the editor binding's product lookup (33-25). */
  public async projectionInput(id: string): Promise<unknown> {
    const live = this.find(id);
    return live === undefined ? undefined : this.options.engine.projectionInputOf(live.project as never, live.deps as never);
  }

  /** The open project with the deps it was opened with (the engine's SharedProjectHost), for the Staff Room's acts (33-26). */
  public shared(id: string): { readonly project: EngineProject; readonly deps: object; readonly root: string } | undefined {
    const live = this.find(id);
    return live === undefined ? undefined : { project: live.project, deps: live.deps, root: live.root };
  }

  /** The cards of the switch to post-quantum keys this computer sees in an open project (33.2 D-05), with the host's clearance check. */
  public async wrapCards(id: string): Promise<unknown[]> {
    const live = this.find(id);
    return live === undefined ? [] : this.options.engine.wrapCardsFor({ project: live.project, deps: live.deps } as never);
  }

  /** The lead's switch: one roster.require wrap@2, signed by the person key (a step-up in a hosted session). */
  public switchToV2(id: string): Promise<StaffKeysAnswer> {
    return this.keysAct(id, (shared) => this.options.engine.switchToV2(shared));
  }

  /** One scheduled rekey per part whose computers all have post-quantum keys; with includeWaiting, the others now too. */
  public moveCellsToV2(id: string, includeWaiting: boolean): Promise<StaffKeysAnswer> {
    return this.keysAct(id, (shared) => this.options.engine.moveCellsToV2(shared, { includeWaiting }));
  }

  /** A later grant of the current key to each computer that published its post-quantum keys late. */
  public giveKeys(id: string): Promise<StaffKeysAnswer> {
    return this.keysAct(id, (shared) => this.options.engine.giveKeys(shared));
  }

  private async keysAct(id: string, act: (shared: never) => Promise<unknown>): Promise<StaffKeysAnswer> {
    const live = this.find(id);
    if (live === undefined) return { ok: false, reason: 'not-open', message: STAFF_ROOM_TEXT.notOpen };
    const answer = keysAnswer(await act({ project: live.project, deps: live.deps } as never));
    if (answer.ok) live.replicator?.localAppended();
    else this.log(`staff: a key change was not written (${answer.reason})`);
    return answer;
  }

  /** A bound editor wrote changes (33-25): the replicator pushes them. */
  public localAppended(id: string): void {
    this.find(id)?.replicator?.localAppended();
  }

  /** Runs one exchange for the project now; undefined when it is not open here. */
  public syncNow(id: string): StaffStatusRow | undefined {
    const live = this.find(id);
    live?.replicator?.syncNow();
    return live?.row;
  }

  public onStatus(listener: RowListener): { dispose(): void } {
    this.rowListeners.add(listener);
    return { dispose: () => { this.rowListeners.delete(listener); } };
  }

  public onJoinRequest(listener: JoinListener): { dispose(): void } {
    this.joinListeners.add(listener);
    return { dispose: () => { this.joinListeners.delete(listener); } };
  }

  /** The people list of an open project, each time it changes (33-29: cursors; the Staff Room's people). */
  public onPeople(listener: PeopleListener): { dispose(): void } {
    this.peopleListeners.add(listener);
    return { dispose: () => { this.peopleListeners.delete(listener); } };
  }

  /** The people list of an open project now, or undefined when presence does not run for it. */
  public people(id: string): readonly EnginePresencePerson[] | undefined {
    const live = this.find(id);
    return live?.presence === undefined ? undefined : live.people;
  }

  /** This person's selection in a product of the project, as Yjs relative positions; at most 10 sends a second (LivePresence). */
  public cursor(id: string, cell: string, product: string, anchor?: string, head?: string): void {
    const presence = this.find(id)?.presence;
    if (presence === undefined) return;
    if (presence.holds(cell)) {
      presence.presence.cursor(cell, product, anchor, head);
      return;
    }
    // A cell this computer came to hold since presence last read the project (a grant, a product made here): read it again first.
    void presence.refresh().then(() => presence.presence.cursor(cell, product, anchor, head), () => undefined);
  }

  /** This person left the product they worked in. */
  public idle(id: string): void {
    this.find(id)?.presence?.presence.idle();
  }

  private find(id: string): LiveProject | undefined {
    return [...this.open.values()].find((live) => live.project.projectId === id);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private async close(live: LiveProject): Promise<void> {
    for (const subscription of live.subscriptions) subscription.dispose();
    await live.presence?.presence.stop().catch(() => undefined);
    live.presence = undefined;
    await live.replicator?.stop();
    await live.project.close();
  }

  /** Presence over the project, sent by the writer the replicator signs as (the session key in a hosted session). */
  private async startPresence(live: LiveProject, replicator: EngineReplicator, signer: { readonly publicKey: string }): Promise<void> {
    const { engine } = this.options;
    const { postPresence, leavePresence } = replicator;
    if (postPresence === undefined || leavePresence === undefined) return;
    try {
      const presence = await engine.openProjectPresence(live.project as never, {
        send: { postPresence: (cell, sealed) => postPresence.call(replicator, cell, sealed), leavePresence: (cell) => leavePresence.call(replicator, cell) },
        writer: engine.writerIdOf(signer.publicKey),
        setPeople: (people) => {
          live.people = people;
          for (const listener of [...this.peopleListeners]) listener(live.project.projectId, people);
        },
        ...(this.options.presence?.now === undefined ? {} : { now: this.options.presence.now }),
        ...(this.options.presence?.timers === undefined ? {} : { timers: this.options.presence.timers }),
      });
      if (this.stopped) return;
      live.presence = presence;
      presence.presence.start();
    } catch {
      this.log('staff: presence did not start for a shared project');
    }
  }

  private depsFor(): object {
    const { hosted, secrets, globalStorageDir, now, engine } = this.options;
    const base = { secrets, globalStorageDir, cellOrder: engine.cellOrderHook(now === undefined ? {} : { now }), ...(now === undefined ? {} : { now }) };
    if (hosted === undefined) return { ...base, publishKem: true };
    const privateKey = hosted.encryption.privateKey;
    if (privateKey === undefined) throw new Error('The session\'s encryption key was dropped before the project opened.');
    const kemPublic = hosted.encryption.kem?.publicKeys;
    const kemPrivate = hosted.encryption.kem?.privateKeys;
    return {
      ...base,
      keyStatus: HOSTED_MARK_KEYS,
      sessionSigner: hosted.keys.sessionSigner,
      personSigner: hosted.keys.personSigner,
      // The binding (the person key's signature over the X25519 key) is made when the person joins a project (33-27); opening does not use it.
      hosted: {
        personPublicKey: hosted.keys.personSigner.publicKey, encryption: { publicKey: hosted.encryption.publicKey, privateKey, binding: '' },
        // The person's post-quantum keys, when the envelope holds them (33.2-04): a project that requires wrap@2 opens here too.
        ...(kemPrivate === undefined || kemPublic === undefined ? {} : { kem: { publicKeys: kemPublic, privateKeys: kemPrivate } }),
      },
    };
  }

  private async startRoot(root: string): Promise<void> {
    const { engine } = this.options;
    const deps = this.depsFor();
    let opened: EngineProject | { refused: string; message: string } | undefined;
    try {
      opened = await engine.ReplicaProject.open(root, deps as never);
    } catch {
      this.log('staff: a workspace folder could not be opened as shared work');
      return;
    }
    if (opened === undefined) return;
    if (engine.isProjectRefused(opened)) {
      this.log(`staff: a shared project was refused (${opened.refused})`);
      return;
    }
    const project = opened;
    const live: LiveProject = {
      root, project, deps, pulled: 0, bound: new Set(), subscriptions: [],
      people: [],
      row: { project: project.projectId, root, state: 'connecting', sentence: engine.syncSentence({ state: 'connecting', findings: [] } as never) },
    };
    this.open.set(root, live);

    const hub = await this.admittedHub(project, deps);
    const certificate = await this.certify(project);
    await this.publishKem(project);
    const armed = await engine.ensureRequireArmed(project as never);
    if (armed !== null && typeof armed === 'object' && 'refused' in armed) this.log(`staff: the feature check was not armed (${String((armed as { refused: unknown }).refused)})`);

    const address = hub === undefined ? undefined : await engine.readHubAddress(this.options.globalStorageDir, project.projectId, { hub: hub.hub });
    const memory = engine.hubMemoryOf(this.options.secrets as never);
    const signer = this.options.hosted?.keys.sessionSigner ?? project.signer;
    const replicator = new engine.LiveReplicator({
      local: engine.syncLocalOf(project as never),
      memory,
      hub: hub?.writer === undefined ? undefined : { id: hub.hub, writer: hub.writer, certPin: hub.certPin },
      address: () => Promise.resolve(address?.address),
      signer,
      ...(certificate === undefined ? {} : { certificate }),
      // A person who joins loads each log this computer holds nothing of from the newest trusted checkpoint (D-43); other logs are untouched.
      startFromBase: true,
      isLeadDevice: () => this.isLeadDevice(project),
      onJoinRequest: (invite?: string) => this.joinRequest(project, invite),
      onCheckpoint: () => { void this.compact(live, hub, memory); },
      onPresence: (frame: Record<string, unknown>) => { live.presence?.presence.receive(frame); },
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      log: (line: string) => this.log(`staff: ${line}`),
      ...this.options.replicator,
    } as never);
    live.replicator = replicator;
    live.subscriptions.push(replicator.onStatus((status) => { void this.statusChanged(live, status); }));
    await replicator.start();
    await this.startPresence(live, replicator, signer);
    await this.statusChanged(live, replicator.status);
  }

  private async admittedHub(project: EngineProject, deps: object): Promise<EngineHubStanding | undefined> {
    const standing = await this.options.engine.hubStanding({ project, deps } as never);
    return standing.find((hub) => hub.standing === 'admitted' && hub.writer !== undefined);
  }

  /** The person key's member and slot in this project (D-61: the person key is a device of the member). */
  private async seatOf(project: EngineProject): Promise<{ member: string; slot: number } | undefined> {
    const { roster } = await project.state();
    const records = roster.members.devices.get(project.deviceWriter) ?? [];
    const record = [...records].reverse().find((item) => item.kind === 'person' && item.slot !== undefined);
    return record === undefined ? undefined : { member: record.member, slot: record.slot as number };
  }

  /** Hosted: one session.certify in this project, signed by the person key; its entry goes to the transport (33-22). */
  private async certify(project: EngineProject): Promise<unknown> {
    const hosted = this.options.hosted;
    if (hosted === undefined) return undefined;
    const seat = await this.seatOf(project);
    if (seat === undefined) {
      this.log('staff: the person key is not a device of this shared project');
      return undefined;
    }
    // A project opened again in this session (33-27 reopen) keeps its one certificate: your organization's server knows the session key by it.
    const known = this.certificates.get(project.projectId);
    if (known !== undefined) return known;
    const certified = await hosted.keys.certificate(project, seat);
    if (certified.kind === 'refused') {
      this.log('staff: the session key was not certified in a shared project');
      return undefined;
    }
    this.certificates.set(project.projectId, certified.value.entry);
    return certified.value.entry;
  }

  /** Hosted: the person's post-quantum keys, published once per project through the person key (33.2-04). */
  private async publishKem(project: EngineProject): Promise<void> {
    const hosted = this.options.hosted;
    const kem = hosted?.encryption.kem;
    if (hosted === undefined || kem === undefined) return;
    const published = await publishPersonKem(project as never, hosted.keys.personSigner, kem, this.options.engine);
    if (published.kind === 'refused') this.log('staff: the post-quantum keys wait for the next confirmation');
  }

  private async isLeadDevice(project: EngineProject): Promise<boolean> {
    const { roster } = await project.state();
    return this.options.engine.isRosterWriterAt(roster as never, project.deviceWriter, roster.positions.length - 1);
  }

  private joinRequest(project: EngineProject, invite?: string): void {
    const request: StaffJoinRequest = { project: project.projectId, ...(invite === undefined ? {} : { invite }) };
    for (const listener of [...this.joinListeners]) listener(request);
  }

  private async compact(live: LiveProject, hub: EngineHubStanding | undefined, memory: object): Promise<void> {
    if (hub === undefined || this.stopped) return;
    try {
      // The compactor and the witness memory name your organization's server by its writer id, as the exchange does (transport.hub).
      const { compacted } = await this.options.engine.compactAfterCheckpoint(live.project as never, { hub: hub.writer, memory } as never);
      if (compacted.length > 0) live.replicator?.localAppended();
    } catch {
      this.log('staff: compaction was skipped after a checkpoint');
    }
  }

  private async statusChanged(live: LiveProject, status: EngineLiveStatus): Promise<void> {
    if (this.stopped) return;
    const { engine } = this.options;
    engine.syncStatusFor(live.root).setStatus(status as never);
    live.row = {
      project: live.project.projectId, root: live.root, state: status.state, sentence: engine.syncSentence(status as never),
      ...(status.lastSyncedAt === undefined ? {} : { lastSyncedAt: status.lastSyncedAt }),
    };
    for (const listener of [...this.rowListeners]) listener(live.row);
    if (status.state === 'needs-update') {
      // The shared work needs a newer version of Sterling (D-06, D-67): this project stops here, and its store keeps every entry.
      await live.replicator?.stop();
      return;
    }
    if (status.pulled > live.pulled) {
      live.pulled = status.pulled;
      // What this computer holds may have changed (a grant, a roster change): presence reads it again.
      await live.presence?.refresh().catch(() => undefined);
      await this.projectFiles(live);
    }
  }

  /** The projector after an exchange that brought something: files not open in a bound editor are written from the fold (33-06). */
  private async projectFiles(live: LiveProject): Promise<void> {
    try {
      const input = await this.options.engine.projectionInputOf(live.project as never, live.deps as never);
      const result = await this.options.engine.projectLive(live.root, input as never, { globalStorageDir: this.options.globalStorageDir, project: live.project.projectId, bound: live.bound });
      this.log(`staff: projected ${result.written.length} product file(s), left ${result.left.length}`);
    } catch (error) {
      this.log(`staff: the product files were not written after an exchange (${error instanceof Error ? error.name : 'error'})`);
    }
  }
}

/** What the session lifecycle reads of SessionIdentity (46-02): only its status. */
export interface LiveIdentity {
  status(): { readonly mode: 'local' } | { readonly mode: 'hosted'; readonly state: string };
}

export interface StaffLiveSessionOptions {
  readonly identity: LiveIdentity;
  /** Builds the engine when the session may start: local mode at once, hosted mode at active (session keys and the encryption key, 33-23). */
  readonly create: () => Promise<StaffLiveEngine | undefined>;
  /** Called with each engine once it is made, so the status service attaches to it before it starts. */
  readonly started?: (engine: StaffLiveEngine) => void;
  readonly timers?: { setInterval(run: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  readonly intervalMs?: number;
}

const REAL_INTERVALS = {
  setInterval: (run: () => void, ms: number): unknown => setInterval(run, ms).unref(),
  clearInterval: (handle: unknown): void => clearInterval(handle as NodeJS.Timeout),
};

/**
 * The live engine follows the person's session (D-61, T-33-N10): in local mode it starts at once; in a hosted session it starts when the sign-in
 * is active and stops at stopping or stopped, which drops the session's keys. A failed sign-in starts nothing (46-02 shows its reason). The
 * identity is read on a short interval, because 46-02's SessionIdentity has no change event.
 */
export class StaffLiveSession {
  private engine: StaffLiveEngine | undefined;
  private handle: unknown;
  private busy: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(private readonly options: StaffLiveSessionOptions) {}

  public get current(): StaffLiveEngine | undefined {
    return this.engine;
  }

  /** Looks at the identity now and on every interval after. */
  public watch(): Promise<void> {
    this.handle = (this.options.timers ?? REAL_INTERVALS).setInterval(() => { void this.check(); }, this.options.intervalMs ?? 1000);
    return this.check();
  }

  /** Looks at the identity once: starts the engine when it may, stops it when the session ended. */
  public check(): Promise<void> {
    this.busy = this.busy.then(() => this.step());
    return this.busy;
  }

  /** Stops watching and stops the engine. */
  public async dispose(): Promise<void> {
    if (this.handle !== undefined) (this.options.timers ?? REAL_INTERVALS).clearInterval(this.handle);
    this.ended = true;
    await this.check();
  }

  private async step(): Promise<void> {
    const status = this.options.identity.status();
    if (this.ended || (status.mode === 'hosted' && (status.state === 'stopping' || status.state === 'stopped'))) {
      const engine = this.engine;
      this.engine = undefined;
      this.ended = true;
      await engine?.stop();
      return;
    }
    if (this.engine !== undefined || (status.mode === 'hosted' && status.state !== 'active')) return;
    const engine = await this.options.create();
    if (engine === undefined) return;
    this.engine = engine;
    this.options.started?.(engine);
    await engine.start();
  }
}
