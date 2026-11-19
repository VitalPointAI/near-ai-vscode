// The simulation player (research note 11, 8.2; UX concept 5.13; WP-SIM): plays a timeline on a compressed clock with speed control (0.5x, 1x, 2x,
// 4x), pause, resume and step, and holds at the J2 demo's mid-demo report so the presenter can run the next beat. The clock is given, never read, so a
// test plays the same timeline on a virtual clock. Pure apart from the timers it is handed: no I/O, no vscode.
//
// States and transitions (every other pair is refused):
//   idle     --start-->   running
//   running  --pause-->   paused        (a person)
//   running  --hold-->    paused        (a held marker was reached)
//   paused   --resume-->  running
//   paused   --step-->    paused        (emits the next group of messages that share one time)
//   running | paused  --(last message emitted)-->  finished
//   any but stopped   --stop-->   stopped
// Speed may change in idle, running or paused; the scenario position never jumps when it does.
//
// The player also writes the feed source events the feed picture reads (obs/events.ts): each simulated feed goes approved then live on start, paused
// and live again with the player, and retired on stop, always with `simulated: true`, so every source in the picture carries the SIM badge.
import type { FeedSourceStateEvent } from '../obs/events';
import { feedSourceTransition } from '../obs/feeds';
import type { FeedSourceEvent, FeedSourceState } from '../obs/feeds';
import type { PersonActor } from '../release';
import { SIM_FEEDS } from './feeds';
import { formatScenarioTime } from './script';
import type { SimMessage, SimTimeline } from './timeline';

export const SIM_SPEEDS = [0.5, 1, 2, 4] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
/** Scenario seconds that pass in one real second at 1x: one scenario hour every 12 seconds, so IRON LANTERN's three days play in about a quarter hour. */
export const SIM_SCENARIO_SECONDS_PER_SECOND = 300;

export const SIM_STATES = ['idle', 'running', 'paused', 'finished', 'stopped'] as const;
export type SimState = (typeof SIM_STATES)[number];
export type SimPauseReason = 'person' | 'hold';

export interface SimScheduler {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SimStatus {
  readonly state: SimState;
  readonly speed: SimSpeed;
  /** Where the scenario clock is, on the exercise calendar and in the scenario's own form. */
  readonly position: number;
  readonly scenarioTime: string;
  readonly emitted: number;
  readonly total: number;
  readonly pausedFor?: SimPauseReason;
  /** The J2 demo beat the timeline is in, once a marker has been reached. */
  readonly beat?: { readonly beat: number; readonly title: string };
}

export type SimRefusal = 'bad-transition' | 'bad-speed';
export type SimResult = { readonly ok: true; readonly status: SimStatus } | { readonly ok: false; readonly reason: SimRefusal; readonly status: SimStatus };

/** Who runs the simulation: a named person, who alone may retire its feeds by stopping it. */
export type SimPerson = PersonActor;

export class SimPlayer {
  private state: SimState = 'idle';
  private speed: SimSpeed = 1;
  private position: number;
  private anchorReal = 0;
  private anchorPosition: number;
  private next = 0;
  private timer: unknown;
  private pausedFor: SimPauseReason | undefined;
  private beat: { beat: number; title: string } | undefined;
  private readonly sources = new Map<string, FeedSourceState>();
  private readonly messageListeners: Array<(message: SimMessage) => void> = [];
  private readonly eventListeners: Array<(event: FeedSourceStateEvent) => void> = [];
  private readonly statusListeners: Array<(status: SimStatus) => void> = [];

  constructor(readonly timeline: SimTimeline, private readonly scheduler: SimScheduler, private readonly person: SimPerson) {
    this.position = timeline.start;
    this.anchorPosition = timeline.start;
  }

  onMessage(listener: (message: SimMessage) => void): void { this.messageListeners.push(listener); }
  onFeedEvent(listener: (event: FeedSourceStateEvent) => void): void { this.eventListeners.push(listener); }
  onStatus(listener: (status: SimStatus) => void): void { this.statusListeners.push(listener); }

  status(): SimStatus {
    const position = this.state === 'running' ? this.currentPosition() : this.position;
    return {
      state: this.state, speed: this.speed, position, scenarioTime: formatScenarioTime((position - this.timeline.dDay) / 60_000),
      emitted: this.next, total: this.timeline.messages.length, ...(this.pausedFor ? { pausedFor: this.pausedFor } : {}), ...(this.beat ? { beat: { ...this.beat } } : {})
    };
  }

  start(): SimResult {
    if (this.state !== 'idle') return this.refuse('bad-transition');
    for (const feed of SIM_FEEDS) {
      this.moveSource(feed.id, null, 'approved');
      this.moveSource(feed.id, 'approved', 'live', 'start-live');
    }
    this.state = 'running';
    this.anchor(this.timeline.start);
    this.pump();
    return this.ok();
  }

  pause(): SimResult {
    if (this.state !== 'running') return this.refuse('bad-transition');
    this.toPaused('person');
    return this.ok();
  }

  resume(): SimResult {
    if (this.state !== 'paused') return this.refuse('bad-transition');
    this.pausedFor = undefined;
    this.state = 'running';
    this.sourcesTo('live', 'resume');
    this.anchor(this.position);
    this.pump();
    return this.ok();
  }

  /** Emits the next group of messages that share one time, and stays paused. */
  step(): SimResult {
    if (this.state !== 'paused') return this.refuse('bad-transition');
    const first = this.timeline.messages[this.next];
    if (first) {
      this.position = Math.max(this.position, first.at);
      this.emitDue(this.position);
    }
    if (this.state === 'paused' && this.next >= this.timeline.messages.length) this.finish();
    this.notify();
    return this.ok();
  }

  setSpeed(speed: number): SimResult {
    if (!(SIM_SPEEDS as readonly number[]).includes(speed)) return this.refuse('bad-speed');
    if (this.state === 'finished' || this.state === 'stopped') return this.refuse('bad-transition');
    if (this.state === 'running') {
      this.position = this.currentPosition();
      this.speed = speed as SimSpeed;
      this.anchor(this.position);
      this.schedule();
    } else {
      this.speed = speed as SimSpeed;
    }
    this.notify();
    return this.ok();
  }

  stop(): SimResult {
    if (this.state === 'stopped') return this.refuse('bad-transition');
    this.clear();
    if (this.state === 'running') this.position = this.currentPosition();
    if (this.state !== 'idle') this.sourcesTo('retired', 'retire');
    this.state = 'stopped';
    this.notify();
    return this.ok();
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------------------

  private ok(): SimResult { return { ok: true, status: this.status() }; }
  private refuse(reason: SimRefusal): SimResult { return { ok: false, reason, status: this.status() }; }

  private rate(): number { return SIM_SCENARIO_SECONDS_PER_SECOND * this.speed; }

  private currentPosition(): number {
    return Math.min(this.timeline.end, this.anchorPosition + (this.scheduler.now() - this.anchorReal) * this.rate());
  }

  private anchor(position: number): void {
    this.position = position;
    this.anchorPosition = position;
    this.anchorReal = this.scheduler.now();
  }

  /** Emits what is due, then schedules the next message, or finishes. */
  private pump(): void {
    this.timer = undefined;
    if (this.state !== 'running') return;
    this.position = this.currentPosition();
    this.emitDue(this.position);
    if (this.state !== 'running') { this.notify(); return; }
    if (this.next >= this.timeline.messages.length) { this.finish(); this.notify(); return; }
    this.schedule();
    this.notify();
  }

  private schedule(): void {
    this.clear();
    const upcoming = this.timeline.messages[this.next];
    if (!upcoming || this.state !== 'running') return;
    // The real time at which the scenario clock reaches the next message, from the anchor, so rounding never drifts.
    const dueReal = this.anchorReal + (upcoming.at - this.anchorPosition) / this.rate();
    this.timer = this.scheduler.setTimeout(() => this.pump(), Math.max(0, dueReal - this.scheduler.now()));
  }

  private clear(): void {
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Emits every message at or before `position`, in timeline order; a held marker pauses the player and stops there. */
  private emitDue(position: number): void {
    const messages = this.timeline.messages;
    while (this.next < messages.length && messages[this.next].at <= position) {
      const message = messages[this.next];
      this.next += 1;
      if (message.stream === 'marker') this.beat = { beat: message.beat, title: message.title };
      for (const listener of this.messageListeners) listener(message);
      if (message.stream === 'marker' && message.hold) {
        this.position = message.at;
        if (this.state === 'running') this.toPaused('hold');
        return;
      }
    }
  }

  private toPaused(reason: SimPauseReason): void {
    // A person pauses where the clock is; a hold pauses at its marker, which emitDue has already set as the position.
    if (reason === 'person') {
      this.position = this.currentPosition();
      // Whatever is already due goes out before the pause, so a later step starts from the next time, not from a backlog.
      this.clear();
      this.emitDue(this.position);
      if (this.state !== 'running') return;
    }
    this.clear();
    this.state = 'paused';
    this.pausedFor = reason;
    this.sourcesTo('paused', 'pause');
    this.notify();
  }

  private finish(): void {
    this.clear();
    this.state = 'finished';
    this.pausedFor = undefined;
  }

  private sourcesTo(to: FeedSourceState, event: FeedSourceEvent): void {
    for (const feed of SIM_FEEDS) {
      const from = this.sources.get(feed.id);
      if (from === undefined || from === to) continue;
      this.moveSource(feed.id, from, to, event);
    }
  }

  private moveSource(feed: string, from: FeedSourceState | null, to: FeedSourceState, event?: FeedSourceEvent): void {
    if (from !== null && event !== undefined) {
      const check = feedSourceTransition(from, event, this.person, false);
      if (!check.ok || check.to !== to) throw new Error(`Feed ${feed} cannot go from ${from} to ${to}.`);
    }
    this.sources.set(feed, to);
    const record: FeedSourceStateEvent = {
      type: 'feed.source.state', run: null, at: new Date(this.scheduler.now()).toISOString(), feed, from, to, simulated: true,
      ...(to === 'paused' ? { reason: this.pausedFor === 'hold' ? 'Held at a demo beat' : 'Paused by a person' } : {})
    };
    for (const listener of this.eventListeners) listener(record);
  }

  private notify(): void {
    const status = this.status();
    for (const listener of this.statusListeners) listener(status);
  }
}
