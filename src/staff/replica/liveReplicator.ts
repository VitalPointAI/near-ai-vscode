// The live replicator of one shared project on one device (Phase 33, D-09, D-11, D-49; DESIGN 10.4 and 15.3). It adds no transport and no
// protocol: it builds HubTransport with the blobsCitedBy constructor option from the project (F1), runs every exchange as syncOnce, and uses the
// hub's event stream only as a wake-up (Pattern 1). A heads frame or a local append schedules one exchange, coalesced (trailing 250 ms, at most one
// in flight); it never calls HubTransport.subscribe, which drops frames (F2). Local changes are written to the store first and pushed by the next
// exchange, so a failed push leaves them in the store, queued, never lost.
//
// Node I/O only, no editor API, and no value import that loads Yjs or the fold (only hubSync and hubTransport, which the hub's tests bundle), so
// hub/test can bundle this file with a memory replica. The connection state is the pure machine of src/domain/replica/syncMachine.ts.
import { initialSyncState, transition } from '../../domain/replica/syncMachine';
import type { SyncEvent, SyncMachineState, SyncState } from '../../domain/replica/syncMachine';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { syncOnce } from './hubSync';
import type { HubMemory, SyncLocal, SyncReport, SyncTransport } from './hubSync';
import { HubTransport } from './hubTransport';
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

const REAL_TIMERS: LiveTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

type Wake = 'start' | 'heads' | 'local' | 'sync-now' | 'stream-open' | 'stream-end' | 'roster';

export class LiveReplicator {
  private machine: SyncMachineState;
  private readonly listeners = new Set<(status: LiveStatus) => void>();
  private readonly timers: LiveTimers;
  private readonly now: () => Date;
  private transport: LiveTransport | undefined;
  private reader: EventReader | undefined;
  private generation = 0;
  private started = false;
  private pulled = 0;
  private pushed = 0;
  private lastSyncedAt: number | undefined;
  private scheduled: { handle: unknown; wake: Wake } | undefined;
  private inFlight: Promise<void> | undefined;
  private again: Wake | undefined;
  private readonly work = new Set<Promise<unknown>>();

  public constructor(private readonly options: LiveReplicatorOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? ((): Date => new Date());
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
    this.fire({ kind: 'start', hasHub: this.options.hub !== undefined && address !== undefined });
    if (this.machine.state === 'connecting') this.track(this.connect(this.generation));
  }

  /** Stops every timer, the event stream and the connection, and ends in single-machine once the exchange in flight has finished. */
  public async stop(): Promise<void> {
    this.generation += 1;
    this.started = false;
    this.cancelScheduled();
    this.reader?.close();
    this.reader = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.fire({ kind: 'stop' });
    await Promise.allSettled([...this.work]);
  }

  /** Sync Now: an exchange at once while live. */
  public syncNow(): void {
    this.fire({ kind: 'sync-now' });
    if (this.machine.state === 'live') this.schedule('sync-now', 0);
  }

  /** The editor wrote to the store: push it with the next exchange. */
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

  private fire(event: SyncEvent): void {
    const next = transition(this.machine, event, this.now().getTime());
    if (next === this.machine) return;
    const changed = next.state !== this.machine.state;
    this.machine = next;
    if (changed) this.log(`state ${next.state}`);
    const status = this.status;
    for (const listener of [...this.listeners]) listener(status);
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
    if (generation !== this.generation) return;
    if (transport === undefined) return;
    await this.exchange('start', generation);
    if (generation === this.generation && this.machine.state === 'live') this.track(this.readEvents(transport, generation));
  }

  /** The transport as syncOnce sees it, reporting connected and session-ok once the first heads answer arrives (TLS, pin and session all passed). */
  private watched(transport: LiveTransport, generation: number): SyncTransport {
    return {
      project: transport.project,
      hub: transport.hub,
      hubHeads: async () => {
        const heads = await transport.hubHeads();
        if (generation === this.generation) {
          this.fire({ kind: 'connected' });
          this.fire({ kind: 'session-ok' });
        }
        return heads;
      },
      entries: (stream, writer, from) => transport.entries(stream, writer, from),
      append: (batch, blobOf) => transport.append(batch, blobOf),
      getBlob: (hash) => transport.getBlob(hash),
      grant: (hash) => transport.grant(hash),
      askCheckpoint: (known) => transport.askCheckpoint(known)
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

  /** One syncOnce, at most one in flight; a wake during it runs one more exchange after it. */
  private async exchange(wake: Wake, generation: number): Promise<void> {
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
        if (generation === this.generation) this.fire({ kind: 'exchange', outcome: 'attention', reason: 'local-replica', findings: [] });
        this.log(`exchange failed locally: ${error instanceof Error ? error.name : 'error'}`);
        return;
      }
      if (generation !== this.generation) return;
      this.pulled += report.pulled;
      this.pushed += report.pushed;
      if (report.outcome === 'synced') this.lastSyncedAt = this.now().getTime();
      const event: SyncEvent = { kind: 'exchange', outcome: report.outcome, findings: report.findings.map((finding) => finding.kind) };
      if (report.reason !== undefined) event.reason = report.reason;
      this.fire(event);
      this.log(`exchange ${wake} done ${report.outcome}`);
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = undefined;
      const next = this.again;
      this.again = undefined;
      if (next !== undefined && generation === this.generation && this.machine.state === 'live') this.schedule(next);
    }
  }

  /** Reads the event stream fully (F2): heads wakes an exchange; join-request, presence, checkpoint and roster go to their hooks. */
  private async readEvents(transport: LiveTransport, generation: number): Promise<void> {
    const reader = await transport.events();
    if (generation !== this.generation) { reader.close(); return; }
    this.reader = reader;
    // A change that arrived between the first exchange and the stream opening sent its heads frame to nobody: one exchange covers it.
    this.schedule('stream-open');
    for await (const report of reader) {
      if (generation !== this.generation) break;
      if (report.kind !== 'frame') continue;
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
    if (this.reader === reader) this.reader = undefined;
  }
}
