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
// REOPEN_MS at least. A stream that cannot open is a lost link. Finding ids stay ids here; 33-09 turns them into sentences.
//
// Node I/O only, no editor API, and no value import that loads Yjs or the fold (only hubSync and hubTransport, which the hub's tests bundle), so
// hub/test can bundle this file with a memory replica. The connection state is the pure machine of src/domain/replica/syncMachine.ts.
import { CONNECT_GIVE_UP_MS, initialSyncState, syncTimerOf, transition } from '../../domain/replica/syncMachine';
import type { SyncEvent, SyncMachineState, SyncState } from '../../domain/replica/syncMachine';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { syncOnce } from './hubSync';
import type { HubMemory, SyncLocal, SyncReport, SyncTransport } from './hubSync';
import { HubTransport, HubTransportError } from './hubTransport';
import type { EventReader, HubTransportOptions } from './hubTransport';

/** What the replicator needs of HubTransport: what syncOnce calls, the event stream and close. */
export type LiveTransport = SyncTransport & Pick<HubTransport, 'events' | 'close'>;

/** The timers the replicator uses; tests give a manual clock (liveWorld FakeTimers). */
export interface LiveTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveReplicatorOptions {
  local: SyncLocal;
  memory: HubMemory;
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
  /** Called on a join-request frame (D-12: the lead's and deputy's devices fetch the requests). */
  onJoinRequest?: () => void;
  /** The presence frame's data as the hub sent it ({ project, cell, devices, left }). */
  onPresence?: (frame: Record<string, unknown>) => void;
  onCheckpoint?: (frame: Record<string, unknown>) => void;
  onRoster?: (frame: Record<string, unknown>) => void;
  /** One short line per step, for logs and tests. Never holds project text. */
  log?: (line: string) => void;
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
  retryAt?: number;
}

/** A heads frame or a local append waits this long for more before the exchange runs (Pattern 1). */
export const COALESCE_MS = 250;
/** The least wait before an ended event stream is opened again; the server's own retry wait is used when it is longer. */
export const REOPEN_MS = 1000;

const REAL_TIMERS: LiveTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

type Wake = 'start' | 'heads' | 'local' | 'sync-now' | 'stream-open' | 'stream-end' | 'resync' | 'roster';
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
  private scheduled: { handle: unknown; wake: Wake } | undefined;
  private stateTimer: unknown;
  private reopenTimer: unknown;
  private inFlight: Promise<void> | undefined;
  private again: Wake | undefined;
  private readonly work = new Set<Promise<unknown>>();

  public constructor(private readonly options: LiveReplicatorOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? ((): Date => new Date());
    this.giveUpMs = options.giveUpMs ?? CONNECT_GIVE_UP_MS;
    this.machine = initialSyncState(this.now().getTime());
  }

  public get status(): LiveStatus {
    const { state, since, reason, findings, retryAt } = this.machine;
    const status: LiveStatus = { state, since, findings: [...findings], pulled: this.pulled, pushed: this.pushed };
    if (reason !== undefined) status.reason = reason;
    if (this.lastSyncedAt !== undefined) status.lastSyncedAt = this.lastSyncedAt;
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
  }

  /** Stops every timer, the event stream and the connection, and ends in single-machine once the work in flight has finished. */
  public async stop(): Promise<void> {
    this.started = false;
    this.disconnect();
    this.fire({ kind: 'stop' });
    this.clearTimer('stateTimer');
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

  private clearTimer(which: 'stateTimer' | 'reopenTimer'): void {
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
    const timer = syncTimerOf(this.machine, this.giveUpMs);
    if (timer === undefined) return;
    const machine = this.machine;
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
      blobsCitedBy: (hashes) => local.blobsCitedBy(hashes)
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
    return {
      project: transport.project,
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
      try {
        report = await syncOnce(this.watched(transport, generation), this.options.local, this.options.memory, { now: this.now });
      } catch (error) {
        // The local replica failed (syncOnce throws only for that): this device cannot sync until a person looks.
        this.log(`exchange failed locally: ${error instanceof Error ? error.name : 'error'}`);
        if (generation === this.generation) this.fire({ kind: 'exchange', outcome: 'attention', reason: 'local-replica', findings: [] });
        return;
      }
      if (generation !== this.generation) return;
      this.pulled += report.pulled;
      this.pushed += report.pushed;
      if (report.outcome === 'synced') this.lastSyncedAt = this.now().getTime();
      const event: SyncEvent = { kind: 'exchange', outcome: report.outcome, findings: report.findings.map((finding) => finding.kind) };
      if (report.reason !== undefined) event.reason = report.reason;
      if (report.retryAfterSeconds !== undefined) event.retryAfterMs = report.retryAfterSeconds * 1000;
      this.log(`exchange ${wake} done ${report.outcome}`);
      this.fire(event);
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
      if (report.event === 'heads') {
        this.log('wake heads');
        this.schedule('heads');
      } else if (report.event === 'join-request') {
        this.options.onJoinRequest?.();
      } else if (report.event === 'presence') {
        this.options.onPresence?.(report.data);
      } else if (report.event === 'checkpoint') {
        this.options.onCheckpoint?.(report.data);
      } else if (report.event === 'roster') {
        this.options.onRoster?.(report.data);
        this.schedule('roster');
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
