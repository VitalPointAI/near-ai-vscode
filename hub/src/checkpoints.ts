// The hub's signed checkpoints (D-45, D-46, D-54, D-63; DESIGN 4.6 and 10.8). For each project the hub fixes the final order of what it can read
// and signs it with its own key, so a client can tell a rolled-back or forked hub from an honest one.
//
// What a checkpoint covers (D-63). A version 2 head names the head entry's lamport and the newest roster in its past, and the order sorts by lamport:
// all of that is inside sealed bodies. So the hub covers only entries it can open (the base cell, and cells granted to it with hub.grant whose grants
// reached it), and of those only the largest causally closed set: an entry is covered when the entry before it in its writer's log and every dep
// are covered, and, as a client's chain stage requires, its lamport is one more than the largest of theirs and it cites no roster older than they
// do. An entry that fails is not covered, nor anything after it in that writer's log. Every other cell is guarded by the clients' high-water marks
// and by deps citing entries never delivered, never by a checkpoint.
//
// Order. Heads come from checkpointHeads. The order is the one a client's recomputeCheckpoint gives with every earlier checkpoint of this hub nested
// in it (checkpointOrder: sort(C1), then sort(C2 minus C1), and so on): the hub keeps the order hash of each stream as of its latest checkpoint and
// extends it with the sorted new entries, which is that order without holding every earlier covered set in memory.
//
// Kept checkpoints (D-46, D-54, D-70). Every checkpoint of this hub in the store counts, the ones clients handed back after a restore included.
// While one of them names a head the hub does not cover, the hub signs nothing for that project and logs checkpoint.waiting; once clients re-push,
// the next checkpoint nests after it. Kept checkpoints that do not form one chain of nested sets, or whose order the hub cannot reproduce, stop
// signing for that project with checkpoint.conflict: never a silent guess.
//
// Timing (D-45). After entries arrive the hub signs 2 seconds after the last arrival, but never sooner than 60 seconds after its previous
// checkpoint of that project. An ask signs at once when the covered set grew and the last ask-signed checkpoint of that project is at least
// 10 seconds old. A covered set that did not grow is never signed again. One job runs at a time per project.
//
// Size. A checkpoint that would pass CHECKPOINT_MAX_BYTES drops granted streams from the end of stream id order (never the base cell stream),
// recomputes the closed set, and logs checkpoint.trimmed with counts.
//
// Privacy (T-32-89). Opened bodies stay in memory, reduced to what ordering needs (deps, roster, lamport and the plain fields of the body); their
// data is dropped at once and never written or logged. Log lines carry the project id, counts and a reason word only.
import {
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_VERSION,
  ORDER_TIP_START,
  checkpointConflict,
  checkpointHash,
  checkpointHeads,
  normaliseCheckpoint,
  readCheckpoint,
  signCheckpoint,
} from '@ext/domain/replica/checkpoint';
import type { Checkpoint, CheckpointEntry, CheckpointStream, SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import { GENESIS_PREV, REPLICA_SIGNED_AT, parseHeaderShape, sha256Hex } from '@ext/domain/replica/entry';
import type { EntryBody, EntryHeader, SealedBlob } from '@ext/domain/replica/entry';
import { checkpointOrder } from '@ext/domain/replica/order';
import type { ReplicaContext } from '@ext/domain/replica/rosterView';
import { verifyEntry } from '@ext/domain/replica/verify';
import { canonicalBytes, canonicalize } from '@ext/domain/team/canonical';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';
import { blobsNamed } from './append/rosterCache';
import type { ProjectRoster, RosterCache } from './append/rosterCache';
import type { EventHub, LiveChannel, Scheduler, Timer } from './live/events';
import type { HubStore } from './store/hubStore';

export const CHECKPOINT_TIMING = Object.freeze({
  /** Sign this long after the last arrival. */
  debounceMs: 2000,
  /** Never sooner than this after the previous checkpoint of the project. */
  minGapMs: 60_000,
  /** An ask signs at once only when the last ask-signed checkpoint of the project is at least this old. */
  askGapMs: 10_000,
});

/** A page of entries read from the store while opening a writer's log. */
const READ_PAGE = { limit: 1000, maxBytes: 4 * 1024 * 1024 };
/** The length of an Ed25519 signature as base64url, for the size of a checkpoint before it is signed. */
const SIG_CHARS = 86;

export type CheckpointLogLevel = 'info' | 'warn' | 'error';
/** One log line: an event name and flat fields (the project id, counts and a reason word). */
export type CheckpointLog = (level: CheckpointLogLevel, event: string, fields: Record<string, string | number>) => void;

export interface CheckpointerDeps {
  store: HubStore;
  cache: RosterCache;
  identity: { writer: string; signer: PayloadSigner };
  events: EventHub;
  scheduler: Scheduler;
  /** Milliseconds. */
  now: () => number;
  log?: CheckpointLog;
}

/** What one signing attempt came to, for tests and logs. */
export type AttemptOutcome = 'signed' | 'unchanged' | 'waiting' | 'conflict' | 'too-soon' | 'stopped' | 'too-large' | 'failed';

/** An opened entry reduced to what checkpoints need: no data and no blob. */
type Opened = CheckpointEntry;

interface WriterLog {
  key: string;
  stream: string;
  writer: string;
  /** The opened entries of this log, seq 0 upwards with no gap. */
  entries: Opened[];
  /** A verification that refused the entry at this seq for good: nothing from here on can be opened. */
  refusedAt?: number;
}

/** Per writer log (stream/writer), how many entries from seq 0 a set covers. */
type Frontier = Map<string, number>;

interface ChainItem {
  hash: string;
  signed: SignedCheckpoint;
  checkpoint: Checkpoint;
  frontier: Frontier;
  total: number;
}

/** The order state as of the latest kept checkpoint: what it covers and the running order hash and count of each stream. */
interface ChainTip {
  frontier: Frontier;
  total: number;
  streams: Map<string, { count: number; tip: string }>;
}

interface Cover {
  frontier: Frontier;
  total: number;
  entries: Opened[];
}

const EMPTY_TIP = (): ChainTip => ({ frontier: new Map(), total: 0, streams: new Map() });

const logKey = (stream: string, writer: string): string => `${stream}/${writer}`;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The chained order hash extended by these hashes: the step orderTipOf takes from ORDER_TIP_START. */
function extendTip(tip: string, hash: string): string {
  return sha256Hex(Buffer.concat([Buffer.from(tip, 'hex'), Buffer.from(hash, 'hex')]));
}

/** The frontier a checkpoint's heads give. */
function frontierOf(checkpoint: Checkpoint): Frontier {
  const frontier: Frontier = new Map();
  for (const stream of checkpoint.streams) for (const head of stream.heads) frontier.set(logKey(stream.stream, head.writer), head.seq + 1);
  return frontier;
}

const totalOf = (checkpoint: Checkpoint): number => checkpoint.streams.reduce((sum, stream) => sum + stream.count, 0);

/** True when every log of a is covered at least as far by b. */
function within(a: Frontier, b: Frontier): boolean {
  for (const [key, count] of a) if ((b.get(key) ?? 0) < count) return false;
  return true;
}

/** The exact size of the signed envelope this checkpoint becomes, so trimming never has to try a signature. */
function signedSize(signer: PayloadSigner, checkpoint: Checkpoint): number {
  const normal = normaliseCheckpoint(checkpoint) as Checkpoint;
  const envelope = {
    v: 1,
    purpose: 'staff-replica',
    signer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey },
    signedAt: REPLICA_SIGNED_AT,
    payload: normal,
    sig: 'A'.repeat(SIG_CHARS),
  };
  return canonicalBytes(envelope).length;
}

class ProjectCheckpointer {
  private readonly logs = new Map<string, WriterLog>();
  private readonly located = new Map<string, { log: WriterLog; seq: number }>();
  private readonly blobs = new Map<string, SealedBlob>();
  private chain: ChainItem[] = [];
  private tip: ChainTip = EMPTY_TIP();
  private readonly seen = new Set<string>();
  private chainLoaded = false;
  /** An ask may have handed checkpoints back: read the store again at the next attempt. */
  private reloadWanted = true;
  /** The kept chain was checked and tip is its order state. */
  private validated = true;
  private conflict: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: Timer | undefined;
  private lastSigned = Number.NEGATIVE_INFINITY;
  private lastAskSigned = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly project: string,
    private readonly deps: CheckpointerDeps,
    private readonly isStopped: () => boolean,
  ) {}

  /** Entries were accepted: sign 2 seconds after the last arrival, but never sooner than 60 seconds after the previous checkpoint. */
  arrived(): void {
    const now = this.deps.now();
    if (this.timer !== undefined) this.deps.scheduler.clearTimeout(this.timer);
    const due = Math.max(now + CHECKPOINT_TIMING.debounceMs, this.lastSigned + CHECKPOINT_TIMING.minGapMs);
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.enqueue('timer');
    }, due - now);
  }

  /** A client asked (and may have handed back checkpoints): the kept checkpoints are read again and an ask may sign at once. */
  asked(): Promise<AttemptOutcome> {
    this.reloadWanted = true;
    return this.enqueue('ask');
  }

  /** Clears the debounce timer; true when one was set. */
  cancel(): boolean {
    if (this.timer === undefined) return false;
    this.deps.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
    return true;
  }

  get pendingTimer(): boolean {
    return this.timer !== undefined;
  }

  settled(): Promise<unknown> {
    return this.queue;
  }

  enqueue(trigger: 'timer' | 'ask'): Promise<AttemptOutcome> {
    const job = this.queue.then(() => this.attempt(trigger));
    this.queue = job.catch(() => undefined);
    return job.catch((error: unknown) => {
      this.deps.log?.('error', 'checkpoint.failed', { project: this.project, name: error instanceof Error ? error.name : 'NonError' });
      return 'failed' as const;
    });
  }

  private async attempt(trigger: 'timer' | 'ask'): Promise<AttemptOutcome> {
    if (this.isStopped()) return 'stopped';
    if (this.conflict !== undefined) return 'conflict';
    if (trigger === 'ask' && this.deps.now() - this.lastAskSigned < CHECKPOINT_TIMING.askGapMs) return 'too-soon';
    // Arrivals from here on schedule a new timer; the store is read after this point, so none is lost.
    if (trigger === 'ask') this.cancel();
    const roster = await this.deps.cache.get(this.project);
    if (this.isStopped()) return 'stopped';
    await this.refresh(roster);
    if (this.isStopped()) return 'stopped';

    this.loadChain();
    const all = this.cover(roster, undefined);
    const waiting = this.missingHeads(all.frontier);
    if (waiting > 0) {
      this.deps.log?.('warn', 'checkpoint.waiting', { project: this.project, missingHeads: waiting, kept: this.chain.length });
      return 'waiting';
    }
    if (!this.validated) {
      const reason = this.validateChain();
      if (reason !== undefined) {
        this.conflict = reason;
        this.deps.log?.('error', 'checkpoint.conflict', { project: this.project, reason, kept: this.chain.length });
        return 'conflict';
      }
    }
    if (all.total <= this.tip.total) return 'unchanged';

    const built = this.fit(roster, all);
    if (built === undefined) return 'too-large';
    const { checkpoint, cover, dropped } = built;
    if (dropped > 0) {
      this.deps.log?.('warn', 'checkpoint.trimmed', { project: this.project, dropped, streams: checkpoint.streams.length });
      if (!within(this.tip.frontier, cover.frontier) || cover.total <= this.tip.total) return 'too-large';
    }
    if (this.isStopped()) return 'stopped';
    const signed = signCheckpoint(this.deps.identity.signer, checkpoint);
    const hash = checkpointHash(signed);
    const now = this.deps.now();
    const latest = this.deps.store.latestCheckpoint(this.project);
    // A handed-back checkpoint may carry a signing time placed ahead of now; this one covers more, so it must stay the latest.
    const signedAt = latest === undefined ? now : Math.max(now, latest.signedAt + 1);
    this.deps.store.putCheckpoint(this.project, { hash, body: canonicalize(signed), signedAt, receivedAt: now });
    const payload = readCheckpoint(signed.payload) as Checkpoint;
    this.chain.push({ hash, signed, checkpoint: payload, frontier: cover.frontier, total: cover.total });
    this.seen.add(hash);
    this.tip = this.advance(this.tip, cover.frontier);
    this.lastSigned = now;
    if (trigger === 'ask') this.lastAskSigned = now;
    this.deps.events.publish(
      this.project,
      (writer) => (this.deps.cache.peek(this.project) ?? roster).standing(writer) === 'admitted',
      'checkpoint',
      { project: this.project, checkpoint: signed },
    );
    this.deps.log?.('info', 'checkpoint.signed', { project: this.project, streams: payload.streams.length, entries: cover.total, trigger });
    return 'signed';
  }

  /** Opens what is new in every writer's log of the project, in seq order, stopping at the first entry that does not open. */
  private async refresh(roster: ProjectRoster): Promise<void> {
    const ctx = this.contextOf(roster);
    for (const streamHeads of this.deps.store.heads(this.project)) {
      for (const head of streamHeads.heads) {
        const key = logKey(streamHeads.stream, head.writer);
        let log = this.logs.get(key);
        if (log === undefined) {
          log = { key, stream: streamHeads.stream, writer: head.writer, entries: [] };
          this.logs.set(key, log);
        }
        if (head.seq < log.entries.length || log.refusedAt !== undefined) continue;
        await this.openFrom(log, ctx, roster);
      }
    }
  }

  private contextOf(roster: ProjectRoster): ReplicaContext {
    const base = roster.context(new Date(this.deps.now()));
    return { ...base, blobs: (hash) => base.blobs(hash) ?? this.blobs.get(hash) };
  }

  private async openFrom(log: WriterLog, ctx: ReplicaContext, roster: ProjectRoster): Promise<void> {
    for (;;) {
      const page = this.deps.store.entriesFrom(this.project, log.stream, log.writer, log.entries.length, READ_PAGE);
      for (const row of page.entries) {
        if (row.seq !== log.entries.length) return;
        const header = parseHeaderShape(JSON.parse(row.header) as unknown);
        // A cell the hub holds no key for: nothing to open, and no verification is spent on it.
        if (!header.ok || ctx.keys(header.header.stream, header.header.epoch) === undefined) return;
        const sealed = { header: header.header, body: row.body };
        let outcome = verifyEntry(sealed, ctx);
        if (outcome.status === 'held' && outcome.reason === 'missing-blob') {
          for (const hash of blobsNamed([sealed], roster.ring)) {
            const bytes = await this.deps.store.readBlob(this.project, hash);
            if (bytes !== undefined) this.blobs.set(hash, { hash, bytes: bytes.toString('base64url') });
          }
          outcome = verifyEntry(sealed, ctx);
        }
        if (outcome.status === 'rejected') log.refusedAt = row.seq;
        if (outcome.status !== 'verified') return;
        const { deps, roster: cited, lamport, at, actor, kind } = outcome.entry.body;
        const body: EntryBody = { deps, roster: cited, lamport, at, actor, kind };
        const opened: Opened = { hash: outcome.entry.hash, header: outcome.entry.header as EntryHeader, body };
        this.located.set(opened.hash, { log, seq: log.entries.length });
        log.entries.push(opened);
      }
      if (!page.more || page.entries.length === 0) return;
    }
  }

  /**
   * The largest causally closed set of opened entries in the given streams (all when undefined): an entry is covered when its prev and every dep
   * are, and its lamport and roster citation pass the checks a client's chain stage makes. A log stops at its first entry that is not covered.
   */
  private cover(roster: ProjectRoster, streams: ReadonlySet<string> | undefined): Cover {
    const covered = new Map<string, number>();
    const newest = new Map<string, number>();
    const coveredHashes = new Set<string>();
    const rosterAt = (hash: string): number => roster.view.rosterPosition(hash) ?? -1;
    const waiters = new Map<string, WriterLog[]>();
    const queue: WriterLog[] = [];
    for (const log of this.logs.values()) if (streams === undefined || streams.has(log.stream)) queue.push(log);
    const broken = new Set<string>();
    while (queue.length > 0) {
      const log = queue.pop() as WriterLog;
      if (broken.has(log.key)) continue;
      for (;;) {
        const index = covered.get(log.key) ?? 0;
        const entry = log.entries[index];
        if (entry === undefined) break;
        const preds = [...(entry.header.prev === GENESIS_PREV ? [] : [entry.header.prev]), ...entry.body.deps.map((dep) => dep.hash)];
        const missing = preds.find((pred) => !coveredHashes.has(pred));
        if (missing !== undefined) {
          const list = waiters.get(missing) ?? [];
          list.push(log);
          waiters.set(missing, list);
          break;
        }
        const lamportOf = (hash: string): number => {
          const at = this.located.get(hash) as { log: WriterLog; seq: number };
          return (at.log.entries[at.seq] as Opened).body.lamport;
        };
        let newestRoster = -1;
        for (const pred of preds) {
          const at = this.located.get(pred) as { log: WriterLog; seq: number };
          const source = at.log.entries[at.seq] as Opened;
          newestRoster = Math.max(newestRoster, rosterAt(pred), rosterAt(source.body.roster), newest.get(pred) as number);
        }
        if (entry.body.lamport !== 1 + Math.max(0, ...preds.map(lamportOf)) || rosterAt(entry.body.roster) < newestRoster) {
          broken.add(log.key);
          break;
        }
        newest.set(entry.hash, newestRoster);
        coveredHashes.add(entry.hash);
        covered.set(log.key, index + 1);
        for (const next of waiters.get(entry.hash) ?? []) queue.push(next);
        waiters.delete(entry.hash);
      }
    }
    const entries: Opened[] = [];
    for (const [key, count] of covered) entries.push(...(this.logs.get(key) as WriterLog).entries.slice(0, count));
    return { frontier: covered, total: entries.length, entries };
  }

  /** Reads this hub's kept checkpoints from the store when they may have changed (first use, or an ask that may have handed some back). */
  private loadChain(): void {
    if (this.chainLoaded && !this.reloadWanted) return;
    this.chainLoaded = true;
    this.reloadWanted = false;
    const fresh: ChainItem[] = [];
    for (const record of this.deps.store.checkpoints(this.project)) {
      if (this.seen.has(record.hash)) continue;
      this.seen.add(record.hash);
      let signed: SignedCheckpoint;
      try {
        signed = JSON.parse(record.body) as SignedCheckpoint;
      } catch {
        continue;
      }
      const checkpoint = readCheckpoint(signed?.payload);
      if (checkpoint === undefined || checkpoint.signer !== this.deps.identity.writer || checkpoint.project !== this.project) continue;
      fresh.push({ hash: record.hash, signed, checkpoint, frontier: frontierOf(checkpoint), total: totalOf(checkpoint) });
    }
    if (fresh.length === 0) return;
    this.chain = [...this.chain, ...fresh].sort((a, b) => a.total - b.total || compareText(a.hash, b.hash));
    this.validated = false;
  }

  /** How many heads of kept checkpoints the hub does not cover (a head the hub holds as another entry counts too). */
  private missingHeads(frontier: Frontier): number {
    let missing = 0;
    for (const item of this.chain) {
      for (const stream of item.checkpoint.streams) {
        for (const head of stream.heads) {
          const key = logKey(stream.stream, head.writer);
          const log = this.logs.get(key);
          if ((frontier.get(key) ?? 0) <= head.seq || log?.entries[head.seq]?.hash !== head.hash) missing += 1;
        }
      }
    }
    return missing;
  }

  /**
   * Checks the kept checkpoints form one chain the hub can reproduce: each covers everything the one before it covered, no two disagree about the
   * same count (checkpointConflict), and each one's counts and order hashes are what the nested order gives. Sets the order state of the latest.
   * Returns a reason word when they do not.
   */
  private validateChain(): string | undefined {
    // First the pairs, so two checkpoints that prove a disagreement on their own are named as such.
    for (let index = 1; index < this.chain.length; index += 1) {
      const previous = this.chain[index - 1] as ChainItem;
      const item = this.chain[index] as ChainItem;
      if (!within(previous.frontier, item.frontier)) return 'not-nested';
      const conflict = checkpointConflict(previous.signed, item.signed);
      if (conflict !== undefined) return conflict.reason;
    }
    let tip = EMPTY_TIP();
    for (const item of this.chain) {
      tip = this.advance(tip, item.frontier);
      for (const [stream, state] of tip.streams) {
        const listed = item.checkpoint.streams.find((candidate: CheckpointStream) => candidate.stream === stream);
        if (listed === undefined || listed.count !== state.count || listed.orderTip !== state.tip) return 'order-mismatch';
      }
      if (item.checkpoint.streams.some((stream) => !tip.streams.has(stream.stream))) return 'order-mismatch';
    }
    this.tip = tip;
    this.validated = true;
    return undefined;
  }

  /** The order state after a checkpoint covering frontier, nested after tip: the new entries sorted (one checkpointOrder bucket) and chained on. */
  private advance(tip: ChainTip, frontier: Frontier): ChainTip {
    const delta: Opened[] = [];
    for (const [key, count] of frontier) {
      const log = this.logs.get(key) as WriterLog;
      delta.push(...log.entries.slice(tip.frontier.get(key) ?? 0, count));
    }
    const streams = new Map([...tip.streams].map(([stream, state]) => [stream, { ...state }]));
    for (const entry of checkpointOrder(delta, [])) {
      const state = streams.get(entry.header.stream) ?? { count: 0, tip: ORDER_TIP_START };
      state.count += 1;
      state.tip = extendTip(state.tip, entry.hash);
      streams.set(entry.header.stream, state);
    }
    return { frontier: new Map(frontier), total: tip.total + delta.length, streams };
  }

  /** The checkpoint for a cover: heads from checkpointHeads, counts and order hashes nested after the chain tip. */
  private checkpointOf(roster: ProjectRoster, cover: Cover): Checkpoint {
    const heads = checkpointHeads(cover.entries, roster.view);
    const order = this.advance(this.tip, cover.frontier);
    const streams: CheckpointStream[] = [...heads.keys()].sort(compareText).map((stream) => {
      const state = order.streams.get(stream) as { count: number; tip: string };
      return { stream, heads: heads.get(stream) ?? [], count: state.count, orderTip: state.tip };
    });
    return { type: 'checkpoint', v: CHECKPOINT_VERSION, project: this.project, signer: this.deps.identity.writer, rosterHead: roster.head, streams };
  }

  /**
   * The checkpoint of everything covered, or, past CHECKPOINT_MAX_BYTES, of the closed set left when granted streams are dropped from the end of
   * stream id order (the base cell stream never is). The fewest streams are dropped: dropping more never makes a checkpoint larger.
   */
  private fit(roster: ProjectRoster, all: Cover): { checkpoint: Checkpoint; cover: Cover; dropped: number } | undefined {
    const signer = this.deps.identity.signer;
    const first = this.checkpointOf(roster, all);
    if (signedSize(signer, first) <= CHECKPOINT_MAX_BYTES) return { checkpoint: first, cover: all, dropped: 0 };
    const granted = [...new Set(all.entries.map((entry) => entry.header.stream))].filter((stream) => stream !== this.project).sort(compareText);
    const attempt = (dropped: number): { checkpoint: Checkpoint; cover: Cover } | undefined => {
      const cover = this.cover(roster, new Set([this.project, ...granted.slice(0, granted.length - dropped)]));
      const checkpoint = this.checkpointOf(roster, cover);
      return signedSize(signer, checkpoint) <= CHECKPOINT_MAX_BYTES ? { checkpoint, cover } : undefined;
    };
    let low = 1;
    let high = granted.length;
    let best: { checkpoint: Checkpoint; cover: Cover; dropped: number } | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const found = attempt(middle);
      if (found === undefined) {
        low = middle + 1;
      } else {
        best = { ...found, dropped: middle };
        high = middle - 1;
      }
    }
    if (best === undefined) this.deps.log?.('error', 'checkpoint.too_large', { project: this.project, streams: granted.length + 1 });
    return best;
  }
}

/** One checkpointer per project the hub holds, created on first signal. */
export class Checkpointer {
  private readonly projects = new Map<string, ProjectCheckpointer>();
  private stopped = false;
  private readonly unlisten: Array<() => void> = [];

  constructor(private readonly deps: CheckpointerDeps) {}

  /** Listens on the in-process channel: entries accepted start the debounce, an ask may sign at once. */
  listen(channel: LiveChannel): this {
    this.unlisten.push(channel.on('entries', (project) => this.arrived(project)));
    this.unlisten.push(channel.on('checkpoint', (project) => void this.asked(project)));
    return this;
  }

  arrived(project: string): void {
    if (this.stopped) return;
    this.of(project).arrived();
  }

  asked(project: string): Promise<AttemptOutcome> {
    if (this.stopped) return Promise.resolve('stopped');
    return this.of(project).asked();
  }

  /** Whether a debounce timer is set for the project. */
  pending(project: string): boolean {
    return this.projects.get(project)?.pendingTimer ?? false;
  }

  /** Resolves when every queued signing job has finished. */
  async settled(): Promise<void> {
    for (;;) {
      const jobs = [...this.projects.values()].map((project) => project.settled());
      await Promise.all(jobs);
      const again = [...this.projects.values()].map((project) => project.settled());
      if (again.every((job, index) => job === jobs[index])) return;
    }
  }

  /** For shutdown: no timer stays set, no new job starts, and a running job signs and stores nothing from here on. Returns how many pending
   *  debounce timers were cleared. */
  stop(): number {
    this.stopped = true;
    for (const remove of this.unlisten.splice(0)) remove();
    let cleared = 0;
    for (const project of this.projects.values()) if (project.cancel()) cleared += 1;
    return cleared;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private of(project: string): ProjectCheckpointer {
    let found = this.projects.get(project);
    if (found === undefined) {
      found = new ProjectCheckpointer(project, this.deps, () => this.stopped);
      this.projects.set(project, found);
    }
    return found;
  }
}
