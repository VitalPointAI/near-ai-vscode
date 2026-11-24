// Live presence of one shared project on one device (Phase 33, D-18, D-21, D-35; DESIGN 10.5). Node-free beyond node:crypto through presence.ts,
// no editor API, no Yjs, nothing written to disk. It sends this device's sealed heartbeat every HEARTBEAT_MS through the replicator's one transport
// and reads the presence frames the replicator hands it, so the Staff Room can list who is here and what they work on.
//
// What is sent where (Pitfall 10):
//  - the base cell gets online and the position only;
//  - a product's name, its cursor (Yjs relative positions) and the agents count go only in that product's own cell, so a person who cannot open
//    that cell never learns the product exists;
//  - with "Show others what I am working on" off, every cell gets the heartbeat only.
// Cursor changes go at most CURSOR_MAX_PER_SECOND times a second. A frame that does not open, or whose member is not the roster's member of the
// device that sent it, is dropped. Names and positions shown come from this device's roster, never from the message. A person not heard from for
// PRESENCE_TTL_MS, or who left, shows as last seen. Presence is advisory only: nothing decides on it.
import { openPresence, presenceAllowedFor, sealPresence } from '../../domain/replica/presence';
import type { PresenceMessage } from '../../domain/replica/presence';

export const HEARTBEAT_MS = 5000;
/** The hub's time to live of a heartbeat (hub/src/live/presence.ts PRESENCE_TIMING). */
export const PRESENCE_TTL_MS = 30_000;
export const CURSOR_MAX_PER_SECOND = 10;

/** One row of the people list the Staff Room shows (handed to the status store through setPeople by the native engine, 33-24). */
export interface PresencePerson {
  member: string;
  /** The person's name and position as this device's roster has them. */
  name: string;
  position?: string;
  live: boolean;
  /** When the person was last heard from, in milliseconds since the epoch. */
  lastSeen: number;
  /** The product they work on, only when this device holds that product's cell. */
  product?: string;
  /** Agents they run on this shared work, only when this device holds the cell the count came in. */
  runs?: number;
  /** Their selection in that product, as Yjs relative positions. */
  cursor?: { anchor: string; head: string };
}

/** What a device's roster answers about another device. */
export interface PresenceRoster {
  /** The member a device belongs to, or undefined when the roster does not know the device. */
  memberOf(writer: string): string | undefined;
  /** The member's name and position word at the roster head. */
  person(member: string): { name: string; position?: string } | undefined;
}

export interface PresenceTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LivePresenceOptions {
  /** The replicator's transport passthrough: no-ops while not live. */
  send: { postPresence(cell: string, sealed: string): Promise<void>; leavePresence(cell: string): Promise<void> };
  /** This device's writer id and member, and the base cell (the project id). */
  writer: string;
  member: string;
  baseCell: string;
  /** This device's position word, as its roster has it. */
  position: () => string | undefined;
  /** The cells this device holds now, the base cell included, each with its current epoch. */
  cells: () => ReadonlyArray<{ cell: string; epoch: number }>;
  /** The epoch key of a cell and epoch this device holds. */
  keyFor: (cell: string, epoch: number) => Buffer | undefined;
  roster: () => PresenceRoster;
  /** "Show others what I am working on" (on by default). */
  showWork?: () => boolean;
  /** How many agents this device runs on this shared work. */
  runningAgents?: () => number;
  /** The people list, each time it changes. */
  setPeople?: (people: PresencePerson[]) => void;
  now?: () => number;
  timers?: PresenceTimers;
}

const REAL_TIMERS: PresenceTimers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

interface Heard { member: string; writer: string; lastSeen: number; left: boolean; seq: number; product?: { cell: string; product: string; runs?: number; cursor?: { anchor: string; head: string } } }

export class LivePresence {
  private readonly timers: PresenceTimers;
  private readonly now: () => number;
  private heartbeat: unknown;
  private started = false;
  private seq = 0;
  private working: { cell: string; product: string; anchor?: string; head?: string } | undefined;
  private readonly cursorTimes: number[] = [];
  private readonly heard = new Map<string, Heard>();
  private readonly listeners = new Set<(people: PresencePerson[]) => void>();

  public constructor(private readonly options: LivePresenceOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? Date.now;
  }

  /** Sends the first heartbeat and keeps sending every HEARTBEAT_MS. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.beat();
  }

  /** Stops the heartbeat and leaves every cell. The people list is forgotten. */
  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeat !== undefined) this.timers.clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    await Promise.allSettled(this.options.cells().map(({ cell }) => this.options.send.leavePresence(cell)));
    this.heard.clear();
    this.publish();
  }

  /** The person works in `product` of `cell`, with the selection given; at most CURSOR_MAX_PER_SECOND sends a second. */
  public cursor(cell: string, product: string, anchor?: string, head?: string): void {
    this.working = { cell, product, ...(anchor === undefined ? {} : { anchor }), ...(head === undefined ? {} : { head }) };
    const now = this.now();
    while (this.cursorTimes.length > 0 && now - (this.cursorTimes[0] as number) >= 1000) this.cursorTimes.shift();
    if (this.cursorTimes.length >= CURSOR_MAX_PER_SECOND) return;
    this.cursorTimes.push(now);
    void this.sendIn(cell, 'cursor');
  }

  /** The person left the product. */
  public idle(): void {
    this.working = undefined;
  }

  public onPeople(listener: (people: PresencePerson[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** The people list now: expired heartbeats show as last seen. */
  public people(): PresencePerson[] {
    const now = this.now();
    const roster = this.options.roster();
    const rows: PresencePerson[] = [];
    for (const item of [...this.heard.values()].sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))) {
      const known = roster.person(item.member);
      if (known === undefined) continue;
      const live = !item.left && now - item.lastSeen < PRESENCE_TTL_MS;
      const row: PresencePerson = { member: item.member, name: known.name, live, lastSeen: item.lastSeen };
      if (known.position !== undefined) row.position = known.position;
      if (live && item.product !== undefined) {
        row.product = item.product.product;
        if (item.product.runs !== undefined) row.runs = item.product.runs;
        if (item.product.cursor !== undefined) row.cursor = item.product.cursor;
      }
      rows.push(row);
    }
    return rows;
  }

  /** A presence frame from the replicator ({ project, cell, devices, left }, already checked by readLiveFrame). */
  public receive(frame: Record<string, unknown>): void {
    const cell = typeof frame.cell === 'string' ? frame.cell : '';
    const devices = Array.isArray(frame.devices) ? (frame.devices as Array<{ writer?: unknown; sealed?: unknown }>) : [];
    const left = Array.isArray(frame.left) ? (frame.left as unknown[]) : [];
    const roster = this.options.roster();
    let changed = false;
    for (const device of devices) {
      if (typeof device.writer !== 'string' || typeof device.sealed !== 'string' || device.writer === this.options.writer) continue;
      const message = openPresence(this.options.keyFor, { cell, writer: device.writer }, device.sealed);
      // Dropped: a frame this device cannot open, one sealed for another place, or one whose member is not the roster's member of its device.
      if (message === undefined || roster.memberOf(device.writer) !== message.member || !presenceAllowedFor(message, cell, this.options.baseCell)) continue;
      changed = this.take(cell, device.writer, message) || changed;
    }
    for (const writer of left) {
      if (typeof writer !== 'string') continue;
      for (const item of this.heard.values()) {
        if (item.writer !== writer || item.left) continue;
        item.left = true;
        item.lastSeen = this.now();
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  // ---- inside --------------------------------------------------------------------------------------------------------------------------------------

  private take(cell: string, writer: string, message: PresenceMessage): boolean {
    const known = this.heard.get(message.member);
    if (known !== undefined && known.writer === writer && message.seq < known.seq) return false;
    const now = this.now();
    if (message.kind === 'leave') {
      this.heard.set(message.member, { member: message.member, writer, lastSeen: now, left: true, seq: message.seq });
      return true;
    }
    const item: Heard = { member: message.member, writer, lastSeen: now, left: false, seq: message.seq };
    if (cell !== this.options.baseCell && message.product !== undefined) {
      item.product = { cell, product: message.product, ...(message.runs === undefined ? {} : { runs: message.runs }), ...(message.anchor !== undefined && message.head !== undefined ? { cursor: { anchor: message.anchor, head: message.head } } : {}) };
    } else if (known?.product !== undefined && known.writer === writer) {
      item.product = known.product;
    }
    this.heard.set(message.member, item);
    return true;
  }

  private publish(): void {
    const people = this.people();
    this.options.setPeople?.(people);
    for (const listener of [...this.listeners]) listener(people);
  }

  private beat(): void {
    if (!this.started) return;
    for (const { cell } of this.options.cells()) void this.sendIn(cell, 'here');
    // A person not heard from within the time to live shows as last seen.
    if (this.heard.size > 0) this.publish();
    this.heartbeat = this.timers.setTimeout(() => {
      this.heartbeat = undefined;
      this.beat();
    }, HEARTBEAT_MS);
  }

  /** The message this device sends in one cell: online and position everywhere; the product, cursor and agents only in the product's own cell. */
  private messageFor(cell: string, kind: 'here' | 'cursor'): PresenceMessage {
    this.seq += 1;
    const message: PresenceMessage = { v: 1, kind, member: this.options.member, seq: this.seq };
    const position = this.options.position();
    if (position !== undefined) message.position = position;
    const showWork = this.options.showWork?.() ?? true;
    const working = this.working;
    if (showWork && working !== undefined && working.cell === cell && cell !== this.options.baseCell) {
      message.product = working.product;
      if (working.anchor !== undefined && working.head !== undefined) {
        message.anchor = working.anchor;
        message.head = working.head;
      }
      const runs = this.options.runningAgents?.();
      if (runs !== undefined) message.runs = runs;
    }
    if (message.kind === 'cursor' && message.product === undefined) message.kind = 'here';
    return message;
  }

  private async sendIn(cell: string, kind: 'here' | 'cursor'): Promise<void> {
    const held = this.options.cells().find((item) => item.cell === cell);
    if (held === undefined) return;
    const key = this.options.keyFor(cell, held.epoch);
    if (key === undefined) return;
    const message = this.messageFor(cell, kind);
    if (!presenceAllowedFor(message, cell, this.options.baseCell)) return;
    try {
      await this.options.send.postPresence(cell, sealPresence(key, { cell, epoch: held.epoch, writer: this.options.writer }, message));
    } catch {
      // Presence is advisory: a heartbeat that does not go is simply sent again with the next one.
    }
  }
}
