// Presence (D-38; DESIGN 10.5): who is active in which cell, in memory only.
//
// A device on a cell's access list posts a heartbeat every 5 seconds holding bytes it sealed under the cell key; the hub never opens them (Phase 33
// defines their plaintext) and learns only "device D is active in cell C". Each heartbeat lives 30 seconds. Changes in one cell are sent at most
// once per 250 ms, keeping the latest value per device, with the devices that left (an explicit leave, or 30 seconds without a heartbeat) listed in
// left. A frame goes to the devices on the cell's access list at the moment it is sent, each without its own entry.
//
// Nothing here is written anywhere: no store, no blob folder, no log line. The hub keeps a map in memory and forgets it when it stops.
import type { Audience, EventHub, Scheduler, Timer } from './events';
import { realScheduler } from './events';

export const PRESENCE_TIMING = Object.freeze({
  /** How long a heartbeat counts. */
  ttlMs: 30_000,
  /** At most one presence frame per cell this often. */
  coalesceMs: 250,
  /** How often expired heartbeats are looked for while anyone is present. */
  sweepMs: 1000,
});

export interface PresenceOptions {
  scheduler?: Scheduler;
  /** Milliseconds; the clock heartbeats expire by. */
  now?: () => number;
  /** The devices on the cell's access list now, or undefined for a cell the project does not have. */
  accessList: (project: string, cell: string) => Promise<readonly string[] | undefined>;
}

interface CellPresence {
  project: string;
  cell: string;
  /** Device writer id to its latest sealed value and when that expires. */
  present: Map<string, { sealed: string; expiresAt: number }>;
  /** Devices whose value changed since the last frame. */
  changed: Set<string>;
  /** Devices that left since the last frame. */
  left: Set<string>;
  flush: Timer | undefined;
}

export class PresenceHub {
  private readonly cells = new Map<string, CellPresence>();
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly accessList: PresenceOptions['accessList'];
  private sweeper: Timer | undefined;

  constructor(
    private readonly events: EventHub,
    options: PresenceOptions,
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.now = options.now ?? Date.now;
    this.accessList = options.accessList;
  }

  /** A heartbeat: the device's latest sealed value for the cell, kept for 30 seconds. */
  heartbeat(project: string, cell: string, writer: string, sealed: string): void {
    const state = this.cellOf(project, cell);
    state.present.set(writer, { sealed, expiresAt: this.now() + PRESENCE_TIMING.ttlMs });
    state.left.delete(writer);
    state.changed.add(writer);
    this.schedule(state);
    this.sweeper ??= this.scheduler.setInterval(() => this.sweep(), PRESENCE_TIMING.sweepMs);
  }

  /** An explicit leave: the device is gone from the cell at once and listed in left in the next frame. */
  leave(project: string, cell: string, writer: string): void {
    const state = this.cells.get(`${project}/${cell}`);
    if (state === undefined || !state.present.delete(writer)) return;
    state.changed.delete(writer);
    state.left.add(writer);
    this.schedule(state);
  }

  /** How many devices are present in all cells (counts only, for tests and logs). */
  get size(): number {
    let count = 0;
    for (const state of this.cells.values()) count += state.present.size;
    return count;
  }

  /** At shutdown: no timer is left and nothing is remembered. */
  close(): void {
    for (const state of this.cells.values()) if (state.flush !== undefined) this.scheduler.clearTimeout(state.flush);
    this.cells.clear();
    if (this.sweeper !== undefined) this.scheduler.clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private cellOf(project: string, cell: string): CellPresence {
    const key = `${project}/${cell}`;
    let state = this.cells.get(key);
    if (state === undefined) {
      state = { project, cell, present: new Map(), changed: new Set(), left: new Set(), flush: undefined };
      this.cells.set(key, state);
    }
    return state;
  }

  private schedule(state: CellPresence): void {
    if (state.flush !== undefined) return;
    state.flush = this.scheduler.setTimeout(() => {
      state.flush = undefined;
      this.flush(state).catch(() => undefined);
    }, PRESENCE_TIMING.coalesceMs);
  }

  /** Expired heartbeats become leaves. */
  private sweep(): void {
    const now = this.now();
    for (const state of this.cells.values()) {
      for (const [writer, seen] of state.present) {
        if (seen.expiresAt > now) continue;
        state.present.delete(writer);
        state.changed.delete(writer);
        state.left.add(writer);
        this.schedule(state);
      }
    }
    this.forgetEmpty();
  }

  private forgetEmpty(): void {
    for (const [key, state] of this.cells) {
      if (state.present.size === 0 && state.changed.size === 0 && state.left.size === 0 && state.flush === undefined) this.cells.delete(key);
    }
    if (this.cells.size === 0 && this.sweeper !== undefined) {
      this.scheduler.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  /** One frame for the cell: the latest value of every device that changed, and every device that left, to the cell's access list now. */
  private async flush(state: CellPresence): Promise<void> {
    const devices = [...state.changed].sort().flatMap((writer) => {
      const seen = state.present.get(writer);
      return seen === undefined ? [] : [{ writer, sealed: seen.sealed }];
    });
    const left = [...state.left].sort();
    state.changed.clear();
    state.left.clear();
    this.forgetEmpty();
    if (devices.length === 0 && left.length === 0) return;
    const access = await this.accessList(state.project, state.cell);
    if (access === undefined) return;
    // A device that left the access list since its heartbeat is not announced.
    const shown = devices.filter((device) => access.includes(device.writer));
    const audience: Audience = (writer) => access.includes(writer);
    this.events.publish(state.project, audience, 'presence', (recipient) => {
      const mine = shown.filter((device) => device.writer !== recipient);
      const gone = left.filter((writer) => writer !== recipient);
      return mine.length === 0 && gone.length === 0 ? undefined : { project: state.project, cell: state.cell, devices: mine, left: gone };
    });
  }
}
