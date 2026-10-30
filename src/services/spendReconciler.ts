import { describeUsageError, TokenTestResult } from './spendInsight';
import { SpendEntry, SpendLedger } from './spendLedger';

// Settles ledger entries with NEAR's actual cost. The queue is the ledger itself (entries with an
// inference-id and no actual), so it survives a reload. Each entry is asked about at fixed ages
// after its response ended (5 s, 30 s, 2 min, 10 min, then every 10 min), all due IDs in one
// POST /v1/billing/costs of at most 10,000. NEAR answers 0 with a warning for usage it has not
// recorded yet; an ID still at 0 after ZERO_SETTLE_MS is settled as $0.

export const RECONCILE_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000];
export const RECONCILE_REPEAT_MS = 600_000;
export const ZERO_SETTLE_MS = 600_000;
export const MAX_BILLING_BATCH = 10_000;
/** Entries another window wrote are left to it until they are this old. */
export const FOREIGN_GRACE_MS = 600_000;
/** A stream still marked open after this long belonged to a window that went away. */
export const ORPHAN_OPEN_MS = 1_800_000;

export interface BillingCostsAnswer {
  /** nano-USD per requested ID; IDs NEAR left out are missing. */
  costs: Map<string, number>;
  /** NEAR's warning that some IDs matched no usage record (those report 0). */
  warning: boolean;
}

export interface BillingApi {
  billingCosts(requestIds: string[], signal?: AbortSignal): Promise<BillingCostsAnswer>;
  /** True while NEAR is rate limiting this key (any model cooling down): billing waits. */
  rateLimited?(): boolean;
}

export interface ReconcilerOptions {
  now?: () => number;
  schedule?: number[];
  repeatMs?: number;
  zeroSettleMs?: number;
  maxBatch?: number;
}

export class SpendReconciler {
  private api: BillingApi | undefined;
  private readonly now: () => number;
  private readonly schedule: number[];
  private readonly repeatMs: number;
  private readonly zeroSettleMs: number;
  private readonly maxBatch: number;
  private readonly tries = new Map<string, { count: number; last: number }>();
  private blockedUntil = 0;
  private failures = 0;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Billing calls made, for tests and diagnostics. */
  public calls = 0;

  public constructor(private readonly ledger: SpendLedger, options: ReconcilerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? RECONCILE_SCHEDULE_MS;
    this.repeatMs = options.repeatMs ?? RECONCILE_REPEAT_MS;
    this.zeroSettleMs = options.zeroSettleMs ?? ZERO_SETTLE_MS;
    this.maxBatch = Math.max(1, Math.min(MAX_BILLING_BATCH, options.maxBatch ?? MAX_BILLING_BATCH));
  }

  /** The client billing calls go through (the latest one created for this key). */
  public attach(api: BillingApi): void { this.api = api; }

  /** Ticks every `intervalMs` without keeping the process alive. */
  public start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** One billing call for the IDs that are due, unless one is running or NEAR asked us to wait. */
  public async tick(): Promise<void> {
    await this.ledger.refresh();
    const now = this.now();
    await this.ask(this.ledger.pending().filter((entry) => this.due(entry, now)));
  }

  /**
   * Asks at once about these entries (a run that just ended), skipping the schedule but not a
   * backoff NEAR asked for. Entries NEAR has not recorded yet stay queued on the schedule.
   */
  public async reconcileNow(filter: (entry: SpendEntry) => boolean): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    await this.ask(this.ledger.pending().filter((entry) => entry.status !== 'open' && filter(entry)));
  }

  private due(entry: SpendEntry, now: number): boolean {
    const ended = entry.endedAt ?? entry.at;
    if (entry.status === 'open' && now - entry.at < ORPHAN_OPEN_MS) return false;
    const age = now - ended;
    const tried = this.tries.get(entry.requestId!);
    if (entry.writer !== this.ledger.writer) {
      if (age < FOREIGN_GRACE_MS) return false;
      return !tried || now - tried.last >= this.repeatMs;
    }
    const count = tried?.count ?? 0;
    if (count < this.schedule.length) return age >= this.schedule[count];
    return now - (tried?.last ?? 0) >= this.repeatMs;
  }

  private async ask(entries: SpendEntry[]): Promise<void> {
    if (!entries.length || !this.api || this.inFlight || this.now() < this.blockedUntil || this.api.rateLimited?.()) return;
    const batch = entries.slice(0, this.maxBatch);
    const run = this.call(batch);
    this.inFlight = run;
    try { await run; } finally { this.inFlight = undefined; }
  }

  private async call(batch: SpendEntry[]): Promise<void> {
    const ids = batch.map((entry) => entry.requestId!);
    const now = this.now();
    for (const id of ids) { const tried = this.tries.get(id); this.tries.set(id, { count: (tried?.count ?? 0) + 1, last: now }); }
    let answer: BillingCostsAnswer;
    try {
      this.calls += 1;
      answer = await this.api!.billingCosts(ids);
    } catch (error) {
      this.failures += 1;
      const status = (error as { status?: unknown }).status;
      const retryAfter = (error as { retryAfterMs?: unknown }).retryAfterMs;
      const base = status === 429 ? 60_000 : status === 401 || status === 403 ? 600_000 : 30_000;
      const wait = Math.max(typeof retryAfter === 'number' ? retryAfter : 0, Math.min(600_000, base * (2 ** Math.min(4, this.failures - 1))));
      this.blockedUntil = this.now() + wait;
      return;
    }
    this.failures = 0;
    for (const entry of batch) {
      const id = entry.requestId!;
      const cost = answer.costs.get(id);
      if (cost !== undefined && cost > 0) this.ledger.settle(id, cost);
      else if (cost === 0 && !answer.warning) this.ledger.settle(id, 0);
      else if (this.now() - (entry.endedAt ?? entry.at) >= this.zeroSettleMs) this.ledger.settle(id, 0, 'zero');
      else continue;
      this.tries.delete(id);
    }
  }
}

// ---- NEAR's own total for this key (needs a usage reporting token) ----

export interface ReportingApi {
  /** POST /v1/check_api_key with the inference key: which organization and key ID it is. */
  checkApiKey(): Promise<{ organizationId: string; apiKeyId: string }>;
  /** GET /v1/organizations/{org}/usage/summary with the reporting token; total nano-USD. */
  usageSummary(token: string, organizationId: string, query: { apiKeyId: string; startTime: string; endTime: string }): Promise<number>;
}

export const USAGE_POLL_ACTIVE_MS = 60_000;
export const USAGE_POLL_IDLE_MS = 300_000;
/** NEAR's figures for the week, month, year, and last 7 days are asked for at most this often. */
export const PERIOD_REFRESH_MS = 600_000;

export interface NearUsageFigure {
  nanoUsd: number;
  /** When NEAR answered. */
  at: number;
  /** The start of the day it covers. */
  since: number;
}

export interface UsageSummaryOptions {
  now?: () => number;
  /** Start (ms) of the day the total is for. */
  dayStart: () => number;
  token: () => Promise<string | undefined>;
  /** Whether a run is going (polls every minute) or not (every 5 minutes). */
  active: () => boolean;
  /** Remembered organization and key IDs, so check_api_key is asked once per key. */
  identity?: { load(): Promise<{ organizationId: string; apiKeyId: string } | undefined>; save(value: { organizationId: string; apiKeyId: string }): Promise<void> };
}

export class NearUsageSummary {
  private api: ReportingApi | undefined;
  private readonly now: () => number;
  private figure: NearUsageFigure | undefined;
  private ids: { organizationId: string; apiKeyId: string } | undefined;
  private nextAt = 0;
  private failures = 0;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  /** Why the last poll failed (no secrets), for the tooltip. */
  public problem: string | undefined;
  /** When NEAR's usage summary last answered. */
  public okAt: number | undefined;
  public polls = 0;
  /** NEAR's totals since other period starts (this week, month, year; the last 7 days), by name. */
  private readonly periods = new Map<string, NearUsageFigure>();
  private periodsAt = 0;
  private periodsKey = '';
  private periodsInFlight: Promise<void> | undefined;

  public constructor(private readonly options: UsageSummaryOptions) {
    this.now = options.now ?? Date.now;
  }

  public attach(api: ReportingApi): void { this.api = api; }

  /** Whether a client is attached to ask NEAR through (none until this key's client is made). */
  public get attached(): boolean { return Boolean(this.api); }

  /** NEAR's total for today, while it is still today's. */
  public today(): NearUsageFigure | undefined {
    return this.figure && this.figure.since === this.options.dayStart() ? { ...this.figure } : undefined;
  }

  public onChange(listener: () => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }

  public start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Polls again soon (a run just ended), still at most once a minute. */
  public soon(): void { this.nextAt = Math.min(this.nextAt, (this.figure?.at ?? 0) + USAGE_POLL_ACTIVE_MS); }

  /** Forgets NEAR's figure (the token was cleared). */
  public reset(): void { this.figure = undefined; this.nextAt = 0; this.problem = undefined; this.okAt = undefined; this.periods.clear(); this.periodsAt = 0; this.periodsKey = ''; this.notify(); }

  /** NEAR's total since `since` under `name`, when the last answer covered exactly that start. */
  public period(name: string, since?: number): NearUsageFigure | undefined {
    const figure = this.periods.get(name);
    return figure && (since === undefined || figure.since === since) ? { ...figure } : undefined;
  }

  /**
   * Asks NEAR for its totals since each start (e.g. this week, month, year, and 7 days ago), one
   * call each, at most every PERIOD_REFRESH_MS unless the starts changed or `force`. Only while a
   * token is set; a failure is kept as the problem, like a poll's.
   */
  public async refreshPeriods(starts: Record<string, number>, force = false): Promise<void> {
    if (this.periodsInFlight) return this.periodsInFlight;
    const key = Object.entries(starts).filter(([name]) => name !== 'lastWeek').map(([name, at]) => `${name}=${at}`).join(',');
    if (!this.api || (!force && key === this.periodsKey && this.now() - this.periodsAt < PERIOD_REFRESH_MS)) return;
    this.periodsInFlight = this.askPeriods(starts, key).finally(() => { this.periodsInFlight = undefined; });
    return this.periodsInFlight;
  }

  private async askPeriods(starts: Record<string, number>, key: string): Promise<void> {
    const token = await this.options.token().catch(() => undefined);
    if (!token) return;
    this.periodsAt = this.now();
    this.periodsKey = key;
    let stage: 'api-key' | 'summary' = 'api-key';
    try {
      const ids = await this.identity();
      stage = 'summary';
      for (const [name, since] of Object.entries(starts)) {
        const nanoUsd = await this.api!.usageSummary(token, ids.organizationId, { apiKeyId: ids.apiKeyId, startTime: new Date(since).toISOString(), endTime: new Date(this.now()).toISOString() });
        this.periods.set(name, { nanoUsd, at: this.now(), since });
      }
      this.okAt = this.now();
      this.problem = undefined;
    } catch (error) {
      this.problem = describeUsageError(error, stage, { organizationId: this.ids?.organizationId }).message;
    }
    this.notify();
  }

  /**
   * Checks the stored token now: asks NEAR which organization the API key is in (fresh, not the
   * remembered answer), then for today's usage summary with the token. Reports success or the
   * exact problem, and updates today's figure and problem as a poll would.
   */
  public async testToken(): Promise<TokenTestResult> {
    if (!this.api) return { ok: false, code: 'no-client', message: 'No NEAR AI Cloud API key is set up for this project, so there is nothing to check the token against.' };
    const token = await this.options.token().catch(() => undefined);
    if (!token) return { ok: false, code: 'no-token', message: 'No usage reporting token is set (or nearAi.spend.useNearUsageTotal is off).' };
    let stage: 'api-key' | 'summary' = 'api-key';
    try {
      this.ids = await this.api.checkApiKey();
      await this.options.identity?.save(this.ids).catch(() => undefined);
      stage = 'summary';
      const since = this.options.dayStart();
      this.polls += 1;
      const nanoUsd = await this.api.usageSummary(token, this.ids.organizationId, { apiKeyId: this.ids.apiKeyId, startTime: new Date(since).toISOString(), endTime: new Date(this.now()).toISOString() });
      const at = this.now();
      this.figure = { nanoUsd, at, since };
      this.okAt = at;
      this.failures = 0;
      this.problem = undefined;
      this.notify();
      return { ok: true, at, nanoUsd, organizationId: this.ids.organizationId };
    } catch (error) {
      const problem = describeUsageError(error, stage, { organizationId: this.ids?.organizationId });
      this.problem = problem.message;
      this.notify();
      return { ok: false, ...problem };
    }
  }

  private async identity(): Promise<{ organizationId: string; apiKeyId: string }> {
    this.ids ??= await this.options.identity?.load().catch(() => undefined);
    if (!this.ids) {
      this.ids = await this.api!.checkApiKey();
      await this.options.identity?.save(this.ids).catch(() => undefined);
    }
    return this.ids;
  }

  public async tick(): Promise<void> {
    if (this.inFlight || !this.api || this.now() < this.nextAt) return this.inFlight;
    this.inFlight = this.poll().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    const token = await this.options.token().catch(() => undefined);
    if (!token) { if (this.figure) this.reset(); this.nextAt = this.now() + USAGE_POLL_ACTIVE_MS; return; }
    const since = this.options.dayStart();
    let stage: 'api-key' | 'summary' = 'api-key';
    try {
      await this.identity();
      stage = 'summary';
      this.polls += 1;
      const nanoUsd = await this.api!.usageSummary(token, this.ids!.organizationId, { apiKeyId: this.ids!.apiKeyId, startTime: new Date(since).toISOString(), endTime: new Date(this.now()).toISOString() });
      this.figure = { nanoUsd, at: this.now(), since };
      this.okAt = this.now();
      this.failures = 0;
      this.problem = undefined;
      this.nextAt = this.now() + (this.options.active() ? USAGE_POLL_ACTIVE_MS : USAGE_POLL_IDLE_MS);
      this.notify();
    } catch (error) {
      this.failures += 1;
      this.problem = describeUsageError(error, stage, { organizationId: this.ids?.organizationId }).message;
      const retryAfter = (error as { retryAfterMs?: unknown }).retryAfterMs;
      this.nextAt = this.now() + Math.max(typeof retryAfter === 'number' ? retryAfter : 0, Math.min(USAGE_POLL_IDLE_MS * 2, USAGE_POLL_ACTIVE_MS * (2 ** Math.min(4, this.failures - 1))));
      this.notify();
    }
  }

  private notify(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* ignore */ } } }
}
