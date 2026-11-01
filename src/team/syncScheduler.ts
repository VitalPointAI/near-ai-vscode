// Polling scheduler for a running team (D-19, D-25). It decides only WHEN a sync runs; what a sync does is the caller's run function.
// Focused windows poll every pollSeconds, unfocused windows every 120 s, a focus event or a nudge runs at once, and two syncs never overlap.
// A run that reports unhealthy (or throws) backs the delay off exponentially up to 10 minutes; a healthy run resets it.
// Timers only schedule polls and never order events. This module never imports vscode.

export const UNFOCUSED_POLL_MS = 120_000;
export const MAX_BACKOFF_MS = 600_000;
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 3600;
export const DEFAULT_POLL_SECONDS = 15;

export interface SchedulerTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SyncSchedulerOptions {
  // Resolves true when the sync was healthy, false when it ended in a paused or offline state. A throw counts as unhealthy.
  run: () => Promise<boolean>;
  pollSeconds: () => number;
  focused: () => boolean;
  timers?: SchedulerTimers;
  // Every error thrown by run is delivered here, never dropped.
  onError: (error: unknown) => void;
}

// The default timers unref the handle so a pending poll can never keep a process alive on its own.
const defaultTimers: SchedulerTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
};

function baseSeconds(configured: number): number {
  const seconds = Number.isFinite(configured) ? configured : DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, seconds));
}

export class SyncScheduler {
  private readonly timers: SchedulerTimers;
  private handle: unknown;
  private timerPending = false;
  private inFlight: Promise<void> | undefined;
  private followUp = false;
  private stopped = true;
  private focusedNow: boolean;
  private failureCount = 0;

  public constructor(private readonly options: SyncSchedulerOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.focusedNow = options.focused();
  }

  public get failures(): number {
    return this.failureCount;
  }

  // Runs once immediately, then keeps polling until stop().
  public start(): void {
    this.stopped = false;
    this.failureCount = 0;
    this.focusedNow = this.options.focused();
    this.requestRun();
  }

  // No run starts after this. A run already in flight finishes but schedules nothing further.
  public stop(): void {
    this.stopped = true;
    this.followUp = false;
    this.clearTimer();
  }

  // Run as soon as no run is in flight. Any number of nudges during one run cause exactly one follow-up.
  public nudge(): void {
    this.requestRun();
  }

  public focusChanged(focused: boolean): void {
    this.focusedNow = focused;
    if (this.stopped) return;
    if (focused) {
      this.requestRun();
      return;
    }
    // Losing focus only lengthens the wait. A run in flight reschedules with the new interval when it ends.
    if (this.inFlight === undefined) {
      this.clearTimer();
      this.schedule();
    }
  }

  // The wait before the next poll: the focus-aware base, doubled per consecutive failure and capped at 10 minutes.
  // A poll interval longer than the cap is never shortened by a failure.
  public nextDelay(): number {
    const base = this.focusedNow ? baseSeconds(this.options.pollSeconds()) * 1000 : UNFOCUSED_POLL_MS;
    if (this.failureCount === 0) return base;
    return Math.max(base, Math.min(MAX_BACKOFF_MS, base * 2 ** this.failureCount));
  }

  private clearTimer(): void {
    if (!this.timerPending) return;
    this.timerPending = false;
    this.timers.clear(this.handle);
    this.handle = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timerPending = true;
    this.handle = this.timers.set(() => {
      this.timerPending = false;
      this.handle = undefined;
      this.requestRun();
    }, this.nextDelay());
  }

  private requestRun(): void {
    if (this.stopped) return;
    this.clearTimer();
    if (this.inFlight !== undefined) {
      this.followUp = true;
      return;
    }
    this.inFlight = this.cycle();
  }

  // Never rejects: every failure of run or of the error handler ends up reported.
  private async cycle(): Promise<void> {
    try {
      do {
        this.followUp = false;
        await this.runOnce();
      } while (this.followUp && !this.stopped);
    } finally {
      this.inFlight = undefined;
    }
    this.schedule();
  }

  private async runOnce(): Promise<void> {
    let healthy: boolean;
    try {
      healthy = await this.options.run();
    } catch (error) {
      healthy = false;
      this.report(error);
    }
    this.failureCount = healthy ? 0 : this.failureCount + 1;
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch (handlerError) {
      // The handler is the last place an error can go, so a failure inside it is written to the host log rather than lost.
      console.error('NEAR AI Team: the sync error handler failed.', handlerError, 'Original error:', error);
    }
  }
}
