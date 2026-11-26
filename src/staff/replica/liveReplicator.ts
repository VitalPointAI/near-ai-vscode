// The live replicator of one shared project on one device (Phase 33, D-09, D-11, D-49; DESIGN 10.4 and 15.3). It adds no transport and no
// protocol: it builds HubTransport with the blobsCitedBy constructor option from the project (F1), runs every exchange as syncOnce, and uses the
// hub's event stream only as a wake-up (Pattern 1). A heads frame or a local append schedules one exchange, coalesced (trailing 250 ms, at most one
// in flight); it never calls HubTransport.subscribe, which drops frames (F2). Local changes are written to the store first and pushed by the next
// exchange, so a failed push leaves them in the store, queued, never lost.
//
// Timers (D-09): the machine names one timer per state (syncTimerOf). Connecting and authenticating give up to offline after giveUpMs, offline
// retries at its back-off time, and Sync Now or a network change retries at once. Leaving the connected states closes the connection and the event
// stream; a connection that never answered is closed by the give-up, and whatever it was doing is ignored (each connection has a generation). An
// event stream that ends while live runs one exchange (which finds a server that went away: offline) and opens again after the server's retry wait,
// REOPEN_MS at least. A stream that cannot open is a lost link. Finding ids stay ids here; liveSentences.ts (33-09) turns them into sentences.
//
// 33-09 completes it: every frame is read through readLiveFrame (hubLive.ts) before use; a join-request reaches onJoinRequest only on a lead
// device; roster, checkpoint and equivocation frames each run one exchange. A synced exchange that met an injected change, a corrupt attachment or
// withheld changes is attention; delayed and replayed stay live with the finding listed. A project that needs a feature this build lacks
// (needs-update, from the exchange or from the local fold) stops until updated(). Attention and refused wait for the lead, so the replicator looks
// again every LEAD_PROBE_MS (the lead's hub.readmit or admission reaches it that way). A gap of more than resumeGapMs between ticks (sleep, a
// hidden tab) counts as a lost link and reconnects at once; a networkProbe, when given, retries at once when its answer changes (D-09 as amended:
// the session backend has none, so production code passes none).
//
// Node I/O only, no editor API, and no value import that loads Yjs or the fold (only hubSync and hubTransport, which the hub's tests bundle), so
// hub/test can bundle this file with a memory replica. The connection state is the pure machine of src/domain/replica/syncMachine.ts.
//
// 33-14: onCheckpoint runs after an exchange that made a newer checkpoint of this hub the trusted newest one in this computer's witness, not when
// the frame arrives. The frame came before the exchange that reads the checkpoint, and the device whose own ask made the hub sign hears no
// frame at all, so the compactor ran on the previous checkpoint or not at all.
import { checkpointHash } from '../../domain/replica/checkpoint';
import { CONNECT_GIVE_UP_MS, initialSyncState, syncTimerOf, transition } from '../../domain/replica/syncMachine';
import type { SyncEvent, SyncMachineState, SyncState } from '../../domain/replica/syncMachine';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { syncOnce } from './hubSync';
import type { HubMemory, SyncLocal, SyncReport, SyncTransport } from './hubSync';
import type { ManagedSyncHandoffs } from './managedSync';
import { readLiveFrame } from './hubLive';
import type { PresenceFrame } from './hubLive';
import { HubTransport, HubTransportError } from './hubTransport';
import type { EventReader, HubTransportOptions } from './hubTransport';

/** What the replicator needs of HubTransport: what syncOnce calls, the event stream and close. */
export type LiveTransport = SyncTransport & Pick<HubTransport, 'events' | 'close' | 'postPresence' | 'leavePresence'>;

/** The timers the replicator uses; tests give a manual clock (liveWorld FakeTimers). */
export interface LiveTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveReplicatorOptions {
  local: SyncLocal;
  memory: HubMemory;
  managed?: ManagedSyncHandoffs;
  /** Your organization's server as the roster admits it (its id, writer id and certificate pin), or undefined when the project has none. */
  hub: { id: string; writer: string; certPin: string } | undefined;
  /** The server's address for this project on this device (D-10), read at each connection, or undefined when none is known. */
  address: () => Promise<string | undefined>;
  signer: PayloadSigner;
  open?: (options: HubTransportOptions) => LiveTransport;
  now?: () => Date;
  timers?: LiveTimers;
  /** How long connecting may take before it gives up to offline (CONNECT_GIVE_UP_MS). */
  giveUpMs?: number;
  /** Called on a join-request frame with the invitation's id, on a lead device only (D-12: the lead's and deputy's devices fetch the requests). */
  onJoinRequest?: (invite?: string) => void;
  /** Whether this device may write the roster (a lead or deputy device); join-request frames reach onJoinRequest only when it says yes. */
  isLeadDevice?: () => boolean | Promise<boolean>;
  /** The network as a comparable value; when its answer changes, an offline project tries again at once. None in the session backend (D-09). */
  networkProbe?: () => string;
  /** A gap longer than this between two ticks is a lost link that reconnects at once (Pitfall 9). RESUME_GAP_MS when absent. */
  resumeGapMs?: number;
  /** The presence frame's data as the hub sent it ({ project, cell, devices, left }). */
  onPresence?: (frame: Record<string, unknown>) => void;
  /** After an exchange that made a newer checkpoint of this hub the trusted newest one here: { project, checkpoint } (its checkpointHash). */
  onCheckpoint?: (frame: Record<string, unknown>) => void;
  onRoster?: (frame: Record<string, unknown>) => void;
  /** One short line per step, for logs and tests. Never holds project text. */
  log?: (line: string) => void;
  /** A hosted session's session.certify entry for `signer` (Phase 33 D-62), passed to the transport. */
  certificate?: HubTransportOptions['certificate'];
  /** A log this computer holds nothing of starts at the newest trusted checkpoint's head (D-43): how a person who joins loads quickly. */
  startFromBase?: boolean;
}

export interface LiveStatus {
  state: SyncState;
  /** When the state was entered, in milliseconds since the epoch. */
  since: number;
  reason?: string;
  /** The witness finding ids of the last exchange. */
  findings: string[];
  /** Entries stored from the server and accepted by it since start. */
  pulled: number;
  pushed: number;
  lastSyncedAt?: number;
  managed?: SyncReport['managed'];
  retryAt?: number;
}

/** A heads frame or a local append waits this long for more before the exchange runs (Pattern 1). */
export const COALESCE_MS = 250;
/** The least wait before an ended event stream is opened again; the server's own retry wait is used when it is longer. */
export const REOPEN_MS = 1000;
/** A gap between ticks longer than this is a lost link (sleep, a hidden tab), Pitfall 9. */
export const RESUME_GAP_MS = 30_000;
/** How often the resume tick and the network probe run. */
export const TICK_MS = 5000;
/** How often attention and refused look again for the lead's action. */
export const LEAD_PROBE_MS = 60_000;
/** Findings that turn a synced exchange into attention (D-13). delayed and replayed stay live with a detail line. */
export const ESCALATING_FINDINGS: ReadonlySet<string> = new Set(['injected', 'corrupt-blob', 'withheld']);

const REAL_TIMERS: LiveTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

type Wake = 'start' | 'heads' | 'local' | 'sync-now' | 'stream-open' | 'stream-end' | 'resync' | 'roster' | 'checkpoint' | 'equivocation';
/** The states in which this device holds a connection to the server. Leaving them closes it. */
const CONNECTED: ReadonlySet<SyncState> = new Set(['connecting', 'authenticating', 'catching-up', 'live']);

export class LiveReplicator {
  private machine: SyncMachineState;
  private readonly listeners = new Set<(status: LiveStatus) => void>();
  private readonly timers: LiveTimers;
  private readonly now: () => Date;
  private readonly giveUpMs: number;
  private transport: LiveTransport | undefined;
  private reader: EventReader | undefined;
  /** Bumped by every disconnect: work of an older connection changes nothing. */
  private generation = 0;
  private started = false;
  private pulled = 0;
  private pushed = 0;
  private lastSyncedAt: number | undefined;
  private managed: SyncReport['managed'];
  private scheduled: { handle: unknown; wake: Wake } | undefined;
  private stateTimer: unknown;
  private reopenTimer: unknown;
  private inFlight: Promise<void> | undefined;
  private again: Wake | undefined;
  private readonly work = new Set<Promise<unknown>>();
  private tickTimer: unknown;
  private lastTick = 0;
  private network: string | undefined;
  private readonly resumeGapMs: number;

  public constructor(private readonly options: LiveReplicatorOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? ((): Date => new Date());
    this.giveUpMs = options.giveUpMs ?? CONNECT_GIVE_UP_MS;
    this.resumeGapMs = options.resumeGapMs ?? RESUME_GAP_MS;
    this.machine = initialSyncState(this.now().getTime());
  }

  public get status(): LiveStatus {
    const { state, since, reason, findings, retryAt } = this.machine;
    const status: LiveStatus = { state, since, findings: [...findings], pulled: this.pulled, pushed: this.pushed };
    if (reason !== undefined) status.reason = reason;
    if (this.lastSyncedAt !== undefined) status.lastSyncedAt = this.lastSyncedAt;
    if (this.managed !== undefined) status.managed = this.managed;
    if (retryAt !== undefined) status.retryAt = retryAt;
    return status;
  }

  public onStatus(listener: (status: LiveStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Reads the address; with no server or no address the project stays single-machine, otherwise the first connection starts. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const address = this.options.hub === undefined ? undefined : await this.options.address();
    if (!this.started) return;
    this.fire({ kind: 'start', hasHub: this.options.hub !== undefined && address !== undefined });
    if (this.machine.state === 'single-machine') return;
    this.lastTick = this.now().getTime();
    this.network = this.options.networkProbe?.();
    this.armTick();
  }

  /** Stops every timer, the event stream and the connection, and ends in single-machine once the work in flight has finished. */
  public async stop(): Promise<void> {
    this.started = false;
    this.disconnect();
    this.fire({ kind: 'stop' });
    this.clearTimer('stateTimer');
    this.clearTimer('tickTimer');
    await Promise.allSettled([...this.work]);
  }

  /** Sync Now: a retry at once while offline (the attempts start again), an exchange at once while live. */
  public syncNow(): void {
    if (this.machine.state === 'live') this.schedule('sync-now', 0);
    else this.fire({ kind: 'sync-now' });
  }

  /** The network changed (a new address, back from sleep): an offline project tries again at once. */
  public networkChanged(): void {
    this.fire({ kind: 'network-change' });
  }

  /** Posts this device's sealed presence in one cell through the one transport while live; does nothing otherwise (33-12, D-21). */
  public async postPresence(cell: string, sealed: string): Promise<void> {
    if (this.machine.state !== 'live' || this.transport === undefined) return;
    await this.transport.postPresence(cell, sealed);
  }

  /** Leaves one cell's presence while live; does nothing otherwise. */
  public async leavePresence(cell: string): Promise<void> {
    if (this.machine.state !== 'live' || this.transport === undefined) return;
    await this.transport.leavePresence(cell);
  }

  /** This build now folds the features the shared work requires (an update): a project in needs-update connects again. */
  public updated(): void {
    this.fire({ kind: 'updated' });
  }

  /** The editor wrote to the store: push it with the next exchange. While not live it waits in the store for the next connection. */
  public localAppended(): void {
    if (this.machine.state === 'live') this.schedule('local');
  }

  // ---- inside --------------------------------------------------------------------------------------------------------------------------------------

  private log(line: string): void {
    this.options.log?.(line);
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch((error: unknown) => { this.log(`step failed: ${error instanceof Error ? error.name : 'error'}`); });
    this.work.add(settled);
    void settled.finally(() => this.work.delete(settled));
  }

  /**
   * The tick: a gap since the last one longer than resumeGapMs means this computer slept or the tab was hidden, so the link is treated as lost and
   * reconnects at once; a changed network answer retries at once too.
   */
  private armTick(): void {
    this.clearTimer('tickTimer');
    if (!this.started) return;
    this.tickTimer = this.timers.setTimeout(() => {
      this.tickTimer = undefined;
      if (!this.started) return;
      const now = this.now().getTime();
      const gap = now - this.lastTick;
      this.lastTick = now;
      if (gap > this.resumeGapMs && this.machine.state !== 'single-machine' && this.machine.state !== 'needs-update') {
        this.log(`resume gap ${Math.round(gap / 1000)} s`);
        if (CONNECTED.has(this.machine.state)) this.fire({ kind: 'lost' });
        this.fire({ kind: 'sync-now' });
      }
      const network = this.options.networkProbe?.();
      if (network !== undefined && network !== this.network) {
        this.network = network;
        this.log('network changed');
        this.networkChanged();
      }
      this.armTick();
    }, TICK_MS);
  }

  private clearTimer(which: 'stateTimer' | 'reopenTimer' | 'tickTimer'): void {
    const handle = this[which];
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this[which] = undefined;
  }

  private fire(event: SyncEvent): void {
    const before = this.machine;
    const next = transition(before, event, this.now().getTime());
    if (next === before) return;
    this.machine = next;
    if (next.state !== before.state) {
      this.log(`state ${next.state}`);
      if (CONNECTED.has(before.state) && !CONNECTED.has(next.state)) this.disconnect();
      this.armStateTimer();
      if (next.state === 'connecting' && this.started) this.track(this.connect(this.generation));
    }
    const status = this.status;
    for (const listener of [...this.listeners]) listener(status);
  }

  /** The one timer of the state the machine is in: the give-up of connecting and authenticating, the retry of offline. */
  private armStateTimer(): void {
    this.clearTimer('stateTimer');
    if (!this.started) return;
    const machine = this.machine;
    // A session key that has ended waits for the person to sign in again: looking again cannot help (Phase 33 D-62).
    if (machine.state === 'refused' && machine.reason === 'session-expired') return;
    if (machine.state === 'attention' || machine.state === 'refused') {
      // These wait for the lead; looking again now and then is how the lead's action (a hub.readmit, an admission) reaches this device.
      this.stateTimer = this.timers.setTimeout(() => {
        this.stateTimer = undefined;
        if (this.machine === machine) this.fire({ kind: 'lead-acted' });
      }, LEAD_PROBE_MS);
      return;
    }
    const timer = syncTimerOf(this.machine, this.giveUpMs);
    if (timer === undefined) return;
    this.stateTimer = this.timers.setTimeout(() => {
      this.stateTimer = undefined;
      if (this.machine === machine) this.fire({ kind: timer.event });
    }, Math.max(0, timer.at - this.now().getTime()));
  }

  /** Closes the connection, the event stream and every pending exchange of this connection. */
  private disconnect(): void {
    this.generation += 1;
    this.cancelScheduled();
    this.clearTimer('reopenTimer');
    this.inFlight = undefined;
    this.again = undefined;
    this.reader?.close();
    this.reader = undefined;
    this.transport?.close();
    this.transport = undefined;
  }

  /** The transport for this connection: HubTransport with the project's blobsCitedBy (F1), pinned to the roster's certificate pin. */
  private async transportFor(): Promise<LiveTransport | undefined> {
    if (this.transport !== undefined) return this.transport;
    const hub = this.options.hub;
    const address = await this.options.address();
    if (hub === undefined || address === undefined) return undefined;
    const local = this.options.local;
    const settings: HubTransportOptions = {
      address, project: local.project, hub: hub.writer, trust: { pin: hub.certPin }, signer: this.options.signer, now: this.now,
      blobsCitedBy: (hashes) => local.blobsCitedBy(hashes), ...(this.options.certificate === undefined ? {} : { certificate: this.options.certificate })
    };
    this.transport = this.options.open === undefined ? new HubTransport(settings) : this.options.open(settings);
    return this.transport;
  }

  /** One connection: the first exchange (connected and the session once the heads answer, then catching up), then the event stream. */
  private async connect(generation: number): Promise<void> {
    const transport = await this.transportFor();
    if (generation !== this.generation || transport === undefined) return;
    await this.exchange('start', generation);
    if (generation === this.generation && this.machine.state === 'live') this.track(this.readEvents(transport, generation));
  }

  /**
   * The transport as syncOnce sees it, reporting connected and session-ok once the first heads answer arrives (TLS, pin and session all passed).
   * A call made after this connection was closed fails at once as unreachable, so the work of a connection that gave up ends instead of opening
   * a new connection for a result nobody reads.
   */
  private watched(transport: LiveTransport, generation: number): SyncTransport {
    const live = <T>(call: () => Promise<T>): Promise<T> => (generation === this.generation ? call() : Promise.reject(new HubTransportError('unreachable')));
    const route = transport.managedRoute;
    return {
      project: transport.project,
      ...(route === undefined ? {} : { managedRoute: {
        get: (handle: string) => live(() => route.get(handle)),
        put: (handle: string, packet: unknown) => live(() => route.put(handle, packet))
      } }),
      hub: transport.hub,
      hubHeads: () => live(async () => {
        const heads = await transport.hubHeads();
        if (generation === this.generation) {
          this.fire({ kind: 'connected' });
          this.fire({ kind: 'session-ok' });
        }
        return heads;
      }),
      entries: (stream, writer, from) => live(() => transport.entries(stream, writer, from)),
      append: (batch, blobOf) => live(() => transport.append(batch, blobOf)),
      getBlob: (hash) => live(() => transport.getBlob(hash)),
      grant: (hash) => live(() => transport.grant(hash)),
      askCheckpoint: (known) => live(() => transport.askCheckpoint(known))
    };
  }

  private schedule(wake: Wake, ms = COALESCE_MS): void {
    if (this.inFlight !== undefined) {
      this.again ??= wake;
      return;
    }
    if (this.scheduled !== undefined) {
      if (ms > 0) return;
      this.cancelScheduled();
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.scheduled = undefined;
      if (generation === this.generation) this.track(this.exchange(wake, generation));
    }, ms);
    this.scheduled = { handle, wake };
  }

  private cancelScheduled(): void {
    if (this.scheduled === undefined) return;
    this.timers.clearTimeout(this.scheduled.handle);
    this.scheduled = undefined;
  }

  /** One syncOnce, at most one in flight; a wake during it runs one more exchange after it. Its report becomes one exchange event. */
  private async exchange(wake: Wake, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.inFlight !== undefined) {
      this.again ??= wake;
      return this.inFlight;
    }
    const transport = this.transport;
    if (transport === undefined) return;
    const run = (async () => {
      this.log(`exchange ${wake}`);
      let report: SyncReport;
      const newestBefore = await this.newestCheckpoint(transport);
      try {
        report = await syncOnce(this.watched(transport, generation), this.options.local, this.options.memory, { now: this.now, managed: this.options.managed, startFromBase: this.options.startFromBase === true });
        if (report.readInFull.length > 0) this.log(`read in full ${report.readInFull.length}`);
      } catch (error) {
        // The local replica failed (syncOnce throws only for that). A fold stopped for a feature this build lacks is needs-update (D-06); anything
        // else means this device cannot sync until a person looks.
        this.log(`exchange failed locally: ${error instanceof Error ? error.name : 'error'}`);
        const refusal = (error as { refusal?: { refused?: unknown } } | undefined)?.refusal;
        if (generation !== this.generation) return;
        if (refusal?.refused === 'needs-update') this.fire({ kind: 'exchange', outcome: 'needs-update', reason: 'needs-update', findings: [] });
        else this.fire({ kind: 'exchange', outcome: 'attention', reason: 'local-replica', findings: [] });
        return;
      }
      if (generation !== this.generation) return;
      this.managed = report.managed;
      this.pulled += report.pulled;
      this.pushed += report.pushed;
      if (report.outcome === 'synced') this.lastSyncedAt = this.now().getTime();
      const findings = report.findings.map((finding) => finding.kind);
      const escalated = report.outcome === 'synced' ? findings.find((kind) => ESCALATING_FINDINGS.has(kind)) : undefined;
      const event: SyncEvent = { kind: 'exchange', outcome: escalated === undefined ? report.outcome : 'attention', findings };
      if (escalated !== undefined) event.reason = escalated;
      else if (report.reason !== undefined) event.reason = report.reason;
      if (report.retryAfterSeconds !== undefined) event.retryAfterMs = report.retryAfterSeconds * 1000;
      this.log(`exchange ${wake} done ${report.outcome}`);
      this.fire(event);
      const newestAfter = await this.newestCheckpoint(transport);
      if (newestAfter !== undefined && newestAfter !== newestBefore && generation === this.generation) {
        this.log('checkpoint newer');
        this.options.onCheckpoint?.({ project: transport.project, checkpoint: newestAfter });
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = undefined;
        const next = this.again;
        this.again = undefined;
        if (next !== undefined && generation === this.generation && this.machine.state === 'live') this.schedule(next);
      }
    }
  }

  /** The hash of the newest checkpoint this computer's witness trusts for this hub and project, or undefined (none, or memory unreadable). */
  private async newestCheckpoint(transport: LiveTransport): Promise<string | undefined> {
    if (this.options.onCheckpoint === undefined) return undefined;
    try {
      const newest = (await this.options.memory.load(transport.hub, transport.project)).newest;
      return newest === undefined ? undefined : checkpointHash(newest);
    } catch {
      return undefined;
    }
  }

  /** A join-request frame reaches onJoinRequest only on a lead device (the hub already sends it only to roster writers; this checks again). */
  private async joinRequest(invite: string): Promise<void> {
    const lead = this.options.isLeadDevice === undefined ? true : await this.options.isLeadDevice();
    if (lead) this.options.onJoinRequest?.(invite);
  }

  /**
   * Reads the event stream fully (F2): heads wakes an exchange; join-request, presence, checkpoint and roster go to their hooks. A stream that
   * cannot open is a lost link. A stream that ends while live runs one exchange, then opens again after the server's wait.
   */
  private async readEvents(transport: LiveTransport, generation: number): Promise<void> {
    let reader: EventReader;
    try {
      reader = await transport.events();
    } catch (error) {
      this.log(`events failed: ${error instanceof HubTransportError ? error.failure : 'error'}`);
      if (generation === this.generation) this.fire({ kind: 'lost' });
      return;
    }
    if (generation !== this.generation) { reader.close(); return; }
    this.reader = reader;
    // A change that arrived between the first exchange and the stream opening sent its heads frame to nobody: one exchange covers it.
    this.schedule('stream-open');
    let ended = 'closed';
    for await (const report of reader) {
      if (generation !== this.generation) break;
      if (report.kind === 'gap') { ended = 'gap'; break; }
      if (report.kind === 'resync') { this.schedule('resync'); continue; }
      if (report.kind !== 'frame') { ended = report.kind; continue; }
      const read = readLiveFrame(report, transport.project);
      if (!read.ok) {
        this.log(`frame ${report.event} ${read.reason}`);
        continue;
      }
      const frame = read.frame;
      if (frame.event === 'heads') {
        this.log('wake heads');
        this.schedule('heads');
      } else if (frame.event === 'join-request') {
        this.track(this.joinRequest(frame.invite));
      } else if (frame.event === 'presence') {
        this.options.onPresence?.(presenceData(transport.project, frame));
      } else if (frame.event === 'checkpoint') {
        // The exchange reads the checkpoint into the witness; onCheckpoint runs after it (exchange).
        this.schedule('checkpoint');
      } else if (frame.event === 'roster') {
        this.options.onRoster?.(report.data);
        this.schedule('roster');
      } else {
        this.schedule('equivocation');
      }
    }
    reader.close();
    if (this.reader === reader) this.reader = undefined;
    if (generation !== this.generation || this.machine.state !== 'live') return;
    this.log(`stream ended ${ended}`);
    await this.exchange('stream-end', generation);
    if (generation !== this.generation || this.machine.state !== 'live') return;
    this.reopenTimer = this.timers.setTimeout(() => {
      this.reopenTimer = undefined;
      if (generation === this.generation && this.machine.state === 'live') this.track(this.readEvents(transport, generation));
    }, Math.max(reader.retryMs ?? 0, REOPEN_MS));
  }
}

/** A presence frame as the 33-01 hook receives it, rebuilt from the checked frame: { project, cell, devices, left }. */
function presenceData(project: string, frame: PresenceFrame): Record<string, unknown> {
  return { project, cell: frame.cell, devices: frame.devices.map((device) => ({ ...device })), left: [...frame.left] };
}
