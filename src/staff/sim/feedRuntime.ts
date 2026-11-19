// The feed runtime of a running simulation (drop 2 integration): it takes the simulation into the project's observation store, and through the store's
// event hook into the staff event log, so the J2 workspace, the observations tools and the COP see live simulated reports.
//
// - The player's feed source events drive the store's feed lifecycle: a feed going live is registered, approved by the person who started the
//   simulation, and started; a paused feed is paused. Stopping the simulation pauses its feeds in the store rather than retiring them, so the next run
//   resumes the same feeds (a retired feed can never come back). The store records each change once, as feed.source.state, in the event log.
// - CoT, AIS and RSS traffic is ingested with the simulator's own minimal ingest (domain/staff/sim/ingest.ts), batched, and appended through the store,
//   which stamps and checks every row like any feed's. Partner reports stay out: that feed is off until a person adds the mock partner server.
// - While the simulation runs, the store keeps the exercise clock, so known times and track decay agree with the scenario, and tick() runs on a timer,
//   so tracks go stale and then lost on screen while nothing new arrives.
// No vscode: the simulation command attaches it.
import type { ExerciseFrame } from '../../domain/staff/obs/frame';
import type { FeedSourceStateEvent } from '../../domain/staff/obs/events';
import { OBS_APPEND_MAX_ROWS } from '../../domain/staff/obs/store';
import { SIM_FEED_IDS, SIM_FEEDS } from '../../domain/staff/sim/feeds';
import { SimIngest } from '../../domain/staff/sim/ingest';
import type { SimPerson } from '../../domain/staff/sim/player';
import type { SimMessage } from '../../domain/staff/sim/timeline';
import type { ObservationStore } from '../observationStore';
import type { SimSession } from './simSession';

/** How often the runtime runs the store's decay while the simulation is live, in real milliseconds. */
export const FEED_TICK_EVERY_MS = 5_000;
/** How long received traffic waits to be appended in one batch, in real milliseconds. */
export const FEED_FLUSH_EVERY_MS = 250;

export interface FeedTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
}

export const REAL_TIMERS: FeedTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => setTimeout(run, ms)
};

export interface FeedRuntimeCounts { appended: number; duplicates: number; refused: number; ticks: number; problems: string[] }

export class SimFeedRuntime {
  private readonly ingest: SimIngest;
  private chain: Promise<void> = Promise.resolve();
  private pending: Array<Record<string, unknown>> = [];
  private flushDue = false;
  private ticker: unknown;
  private stopped = false;
  readonly counts: FeedRuntimeCounts = { appended: 0, duplicates: 0, refused: 0, ticks: 0, problems: [] };

  constructor(private readonly session: SimSession, private readonly store: ObservationStore, frame: ExerciseFrame, private readonly person: SimPerson, private readonly timers: FeedTimers = REAL_TIMERS) {
    this.ingest = new SimIngest(frame);
  }

  /** Attaches to the session before it starts, so the first feed events reach the store. */
  attach(): void {
    this.store.setClock(() => this.session.status().position);
    this.session.player.onFeedEvent((event) => this.onFeedEvent(event));
    this.session.onMessage((message) => this.onMessage(message));
    this.ticker = this.timers.setInterval(() => { void this.tick(); }, FEED_TICK_EVERY_MS);
  }

  /** Flushes what is waiting, pauses the feeds, stops the timer and gives the store back its own clock. */
  async detach(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ticker !== undefined) this.timers.clearInterval(this.ticker);
    this.enqueue(() => this.flush());
    for (const feed of SIM_FEEDS) this.enqueue(() => this.toPaused(feed.id));
    await this.settled();
    this.store.setClock(undefined);
  }

  /** Waits until every queued store write has run. */
  async settled(): Promise<void> {
    let last: Promise<void> | undefined;
    while (last !== this.chain) { last = this.chain; await last; }
  }

  /** One decay pass on the store (tracks go stale, then lost), also run by the Staff Room while it is open. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    this.enqueue(async () => {
      const result = await this.store.tick();
      this.counts.ticks += 1;
      if (!result.ok) this.problem(result.message);
    });
    await this.settled();
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => this.problem(error instanceof Error ? error.message : String(error)));
  }

  private problem(message: string): void {
    if (this.counts.problems.length < 20) this.counts.problems.push(message);
  }

  private onFeedEvent(event: FeedSourceStateEvent): void {
    if (event.to === 'live') this.enqueue(() => this.toLive(event.feed));
    else if (event.to === 'paused' || event.to === 'retired') { this.enqueue(() => this.flush()); this.enqueue(() => this.toPaused(event.feed)); }
  }

  private onMessage(message: SimMessage): void {
    if (this.stopped) return;
    const rows = this.ingest.rows(message, this.store.time());
    if (!rows.length) return;
    this.pending.push(...rows);
    if (this.flushDue) return;
    this.flushDue = true;
    this.timers.setTimeout(() => { this.flushDue = false; this.enqueue(() => this.flush()); }, FEED_FLUSH_EVERY_MS);
  }

  private async flush(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0, OBS_APPEND_MAX_ROWS);
      const result = await this.store.append({ rows: batch });
      this.counts.appended += result.appended;
      this.counts.duplicates += result.duplicates;
      this.counts.refused += result.refused.length;
      if (result.message) this.problem(result.message);
      for (const refusal of result.refused.slice(0, 3)) this.problem(JSON.stringify(refusal));
    }
  }

  private async stateOf(feed: string): Promise<string | undefined> {
    const loaded = await this.store.load();
    if (!loaded.ok) { this.problem(loaded.message); return 'unreadable'; }
    return loaded.value.registry.feeds[feed]?.state;
  }

  private async move(feed: string, event: Parameters<ObservationStore['transitionFeed']>[1], person: boolean): Promise<void> {
    const result = await this.store.transitionFeed(feed, event, person ? this.person : { kind: 'system' });
    if (!result.ok) this.problem(result.message);
  }

  /** Brings a simulated feed to live in the store from wherever it is. */
  private async toLive(feed: string): Promise<void> {
    if (feed === SIM_FEED_IDS.partner) return;
    let state = await this.stateOf(feed);
    if (state === 'unreadable' || state === 'retired' || state === 'live') return;
    if (state === undefined) {
      const descriptor = SIM_FEEDS.find((entry) => entry.id === feed);
      if (!descriptor) return;
      const registered = await this.store.registerFeed(descriptor);
      if (!registered.ok) { this.problem(registered.message); return; }
      state = 'proposed';
    }
    if (state === 'proposed') { await this.move(feed, 'approve', true); state = 'approved'; }
    if (state === 'approved') await this.move(feed, 'start-live', false);
    else if (state === 'paused') await this.move(feed, 'resume', false);
    else if (state === 'degraded') await this.move(feed, 'recover', false);
  }

  private async toPaused(feed: string): Promise<void> {
    const state = await this.stateOf(feed);
    if (state === 'live' || state === 'degraded' || state === 'backfilling') await this.move(feed, 'pause', false);
  }
}
