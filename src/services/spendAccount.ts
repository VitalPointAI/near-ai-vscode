import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DayBoundary, dayStart, emptyTotals, nanoToUsd, SpendEntry, SpendFilter, SpendFinish, SpendLedger, SpendStart, SpendTotals, spendIdentity, totalNanoUsd } from './spendLedger';
import type { ReportingTokenState } from './reportingToken';
import { buildSpendInsight, BURN_WINDOW_DAYS, costSource, periodStarts, PERIODS, RequestCounts, SpendInsight, SpendPeriod, TokenTestResult } from './spendInsight';
import { BillingApi, NearUsageFigure, NearUsageSummary, ReportingApi, SpendReconciler } from './spendReconciler';

// One API key's spend on this computer: its ledger, the reconciliation with NEAR's billing API,
// NEAR's own total when a usage reporting token is set, and the daily limit. Every display asks
// an account for its figures, so they all agree. No VS Code API here: the host configures it.

/** What NearAiClient needs: record each billable response, and check the daily limit first. */
export interface SpendSink {
  /** Records a billable response as it starts; the returned function records how it ended (only its first call counts). */
  begin(input: SpendStart): (result: SpendFinish) => void;
  /** The daily limit, when today's spend has reached it. */
  limitReached(): { spentUsd: number; limitUsd: number; source: 'near' | 'local' } | undefined;
  /** The client billing and usage reports go through. */
  attach(api: BillingApi & Partial<ReportingApi>): void;
}

export interface SpendConfig {
  /** Folder for the ledgers (the extension's global storage). */
  dir: string;
  dayBoundary?: () => DayBoundary;
  /** nearAi.dailySpendLimitUsd; 0 means none. */
  dailyLimitUsd?: () => number;
  /** The usage reporting token (rpt-…), when the user set one. */
  reportingToken?: () => Promise<string | undefined>;
  now?: () => number;
  /** Start the reconciliation and usage timers (default true). */
  timers?: boolean;
}

/** A spend figure with how sure it is, ready to show. */
export interface SpendView {
  totals: SpendTotals;
  /** NEAR's own total for this key today, when a reporting token is set and NEAR answered. */
  near?: NearUsageFigure;
  /** The figure to show and to check limits against, in USD. */
  usd: number;
  /** e.g. "$1.00 today (NEAR)" or "$0.40 confirmed + ~$0.02 pending today". */
  text: string;
  tooltip: string;
  source: 'near' | 'confirmed' | 'pending' | 'none';
}

export type SpendWindow = 'today' | 'run' | 'conversation' | 'request';

const ACTIVE_MS = 120_000;

export class SpendAccount implements SpendSink {
  public readonly ledger: SpendLedger;
  public readonly reconciler: SpendReconciler;
  public readonly usage: NearUsageSummary;
  private readonly now: () => number;
  private lastBillableAt = 0;
  private open = 0;

  public constructor(public readonly identity: string, private readonly config: SpendConfig) {
    this.now = config.now ?? Date.now;
    const dir = path.join(config.dir, 'spend', identity);
    this.ledger = new SpendLedger(dir, { now: this.now });
    this.reconciler = new SpendReconciler(this.ledger, { now: this.now });
    const keyFile = path.join(dir, 'key.json');
    this.usage = new NearUsageSummary({
      now: this.now,
      dayStart: () => this.dayStart(),
      token: () => config.reportingToken?.() ?? Promise.resolve(undefined),
      active: () => this.active,
      identity: {
        load: async () => { const value = JSON.parse(await fs.readFile(keyFile, 'utf8')) as { organizationId?: unknown; apiKeyId?: unknown }; return typeof value.organizationId === 'string' && typeof value.apiKeyId === 'string' ? { organizationId: value.organizationId, apiKeyId: value.apiKeyId } : undefined; },
        save: async (value) => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(keyFile, `${JSON.stringify(value)}\n`, 'utf8'); }
      }
    });
    if (config.timers !== false) { this.reconciler.start(); this.usage.start(); }
    // What this and other windows recorded before (this month and last) is read at once.
    this.ready = this.ledger.refresh();
  }

  /** Settles once the ledger's earlier entries are read. */
  public readonly ready: Promise<void>;

  public attach(api: BillingApi & Partial<ReportingApi>): void {
    this.reconciler.attach(api);
    if (api.checkApiKey && api.usageSummary) this.usage.attach(api as ReportingApi);
  }

  public begin(input: SpendStart): (result: SpendFinish) => void {
    const id = this.ledger.start(input);
    this.lastBillableAt = this.now();
    const open = (input.status ?? 'open') === 'open';
    if (open) this.open += 1;
    let finished = !open;
    return (result) => {
      if (finished) return;
      finished = true;
      this.open = Math.max(0, this.open - 1);
      this.lastBillableAt = this.now();
      this.ledger.finish(id, result);
    };
  }

  /** A run is going or a request finished in the last two minutes: NEAR's total is polled every minute. */
  public get active(): boolean { return this.open > 0 || this.now() - this.lastBillableAt < ACTIVE_MS; }

  public dayStart(): number { return dayStart(this.now(), this.config.dayBoundary?.() ?? 'local'); }

  public totals(filter: SpendFilter = {}): SpendTotals { return this.ledger.totals(filter); }

  /** Today's spend for this key: NEAR's figure when a reporting token is set, else this computer's ledger. */
  public today(): SpendView {
    const since = this.dayStart();
    const totals = this.ledger.totals({ since });
    const near = this.usage.today();
    const view = spendView(totals, 'today', near, this.usage.problem);
    // Where the figure comes from, first: NEAR's billing, per-request actuals, or list-price estimates.
    const source = costSource({ tokenState: near || this.usage.problem ? 'set' : 'missing', near, counts: this.ledger.requestCounts({ since }) });
    return { ...view, tooltip: `Cost source: ${source.label}. ${source.detail} ${view.tooltip}` };
  }

  /** Unique requests by how their cost is known. */
  public requestCounts(filter: SpendFilter = {}): RequestCounts { return this.ledger.requestCounts(filter); }

  private yearReader: { since: number; ledger: SpendLedger } | undefined;

  /**
   * Everything Agent Activity shows about spend: the cost source and the token's state, totals for
   * today, this week, this month, and this year (NEAR's when the token works, else this
   * computer's ledger, labelled per figure), the 7-day burn rate, and the credits.
   */
  public async insight(tokenState: ReportingTokenState, options: { refreshNear?: boolean } = {}): Promise<SpendInsight> {
    const now = this.now();
    const boundary = this.config.dayBoundary?.() ?? 'local';
    const starts = periodStarts(now, boundary);
    const lastWeek = now - BURN_WINDOW_DAYS * 86_400_000;
    // NEAR's period figures arrive later (at most every 10 minutes); the page updates when they do.
    if (tokenState === 'set' && options.refreshNear !== false) void this.usage.refreshPeriods({ week: starts.week, month: starts.month, year: starts.year, lastWeek }).catch(() => undefined);
    // The main ledger reads this and last month's files; the year's total reads every month's.
    if (this.yearReader?.since !== starts.year) this.yearReader = { since: starts.year, ledger: new SpendLedger(path.join(this.config.dir, 'spend', this.identity), { now: this.now, writer: `reader-${this.ledger.writer}`, from: starts.year }) };
    const year = this.yearReader.ledger;
    await year.refresh();
    const ledgerFor = (period: SpendPeriod) => {
      const source = period === 'year' ? year : this.ledger;
      return { totals: source.totals({ since: starts[period] }), counts: source.requestCounts({ since: starts[period] }) };
    };
    const ledger = Object.fromEntries(PERIODS.map((period) => [period, ledgerFor(period)])) as Record<SpendPeriod, ReturnType<typeof ledgerFor>>;
    const today = this.usage.today();
    const near: Partial<Record<SpendPeriod, NearUsageFigure>> = {
      ...(today ? { today } : {}),
      ...Object.fromEntries((['week', 'month', 'year'] as const).map((period) => [period, this.usage.period(period, starts[period])]).filter(([, figure]) => figure))
    };
    const nearLastWeek = this.usage.period('lastWeek');
    return buildSpendInsight({
      tokenState, now, boundary, near,
      // A 7-day figure older than the refresh interval and a bit is not used for the burn rate.
      ...(nearLastWeek && now - nearLastWeek.at < 900_000 ? { nearLastWeek } : {}),
      okAt: this.usage.okAt,
      problem: this.usage.problem,
      ledger,
      ledgerLastWeekUsd: nanoToUsd(totalNanoUsd(this.ledger.totals({ since: lastWeek })))
    });
  }

  /** Checks the usage reporting token against NEAR now. */
  public testReportingToken(): Promise<TokenTestResult> { return this.usage.testToken(); }

  public window(window: Exclude<SpendWindow, 'today'>, filter: SpendFilter): SpendView {
    return spendView(this.ledger.totals(filter), window);
  }

  /** Spend to check the daily limit against: the larger of NEAR's total and this computer's ledger. */
  public spentTodayUsd(): { usd: number; source: 'near' | 'local' } {
    const local = nanoToUsd(totalNanoUsd(this.ledger.totals({ since: this.dayStart() })));
    const near = this.usage.today();
    return near && nanoToUsd(near.nanoUsd) >= local ? { usd: nanoToUsd(near.nanoUsd), source: 'near' } : { usd: local, source: 'local' };
  }

  public limitReached(): { spentUsd: number; limitUsd: number; source: 'near' | 'local' } | undefined {
    const limit = this.config.dailyLimitUsd?.() ?? 0;
    if (!(limit > 0)) return undefined;
    const spent = this.spentTodayUsd();
    return spent.usd >= limit ? { spentUsd: spent.usd, limitUsd: limit, source: spent.source } : undefined;
  }

  /** Asks NEAR now about these entries (a run that ended); what NEAR has not recorded yet stays queued. */
  public async settleNow(filter: (entry: SpendEntry) => boolean): Promise<void> {
    await this.reconciler.reconcileNow(filter).catch(() => undefined);
    this.usage.soon();
  }

  public onChange(listener: () => void): { dispose(): void } {
    const a = this.ledger.onChange(listener);
    const b = this.usage.onChange(listener);
    return { dispose: () => { a.dispose(); b.dispose(); } };
  }

  public dispose(): void { this.reconciler.stop(); this.usage.stop(); }
}

const money = (usd: number) => `$${usd.toFixed(2)}`;
const fine = (usd: number) => `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;

/** Formats a window's totals with where the figure comes from. */
export function spendView(totals: SpendTotals, window: SpendWindow, near?: NearUsageFigure, nearProblem?: string): SpendView {
  const confirmed = nanoToUsd(totals.confirmedNanoUsd);
  const pending = nanoToUsd(totals.pendingNanoUsd);
  const estimated = nanoToUsd(totals.estimatedNanoUsd);
  const local = confirmed + pending + estimated;
  const suffix = window === 'today' ? ' today' : window === 'run' ? ' this run' : window === 'conversation' ? ' this conversation' : '';
  const format = window === 'request' || window === 'run' ? fine : money;
  const parts: string[] = [];
  if (confirmed > 0 || (pending === 0 && estimated === 0)) parts.push(`${format(confirmed)} confirmed`);
  if (pending > 0) parts.push(`~${format(pending)} pending`);
  if (estimated > 0) parts.push(`~${format(estimated)} est.`);
  const localText = totals.requests === 0 ? `${format(0)}${suffix}` : parts.length === 1 && confirmed > 0 ? `${format(confirmed)}${suffix} (confirmed)` : `${parts.join(' + ')}${suffix}`;
  const explain = 'Confirmed: NEAR\'s billing API reported the actual cost. Pending: waiting for NEAR to report it (shown at the estimate). Est.: NEAR gave no request ID to check, so only the estimate is known.';
  const thisComputer = `This computer: ${parts.join(' + ')} (${totals.requests} request${totals.requests === 1 ? '' : 's'}${totals.pendingRequests ? `, ${totals.pendingRequests} pending` : ''}).`;
  if (window === 'today' && near) {
    const usd = nanoToUsd(near.nanoUsd);
    const at = new Date(near.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { totals, near, usd: Math.max(usd, local), source: 'near', text: `${money(usd)}${suffix} (NEAR)`, tooltip: `NEAR AI Cloud's usage summary for this API key today, from every computer using it (updated ${at}). ${thisComputer} ${explain}` };
  }
  const source: SpendView['source'] = totals.requests === 0 ? 'none' : pending > 0 || estimated > 0 ? 'pending' : 'confirmed';
  const tokenNote = window === 'today' ? (nearProblem ? ` NEAR's own total is unavailable: ${nearProblem}` : ' Set a usage reporting token (NEAR AI: Set Usage Reporting Token) to show NEAR\'s own total for this key, including other computers.') : '';
  return { totals, usd: local, source, text: localText, tooltip: `${thisComputer} ${explain}${tokenNote}` };
}

// ---- the accounts of this extension host ----

let config: SpendConfig | undefined;
const accounts = new Map<string, SpendAccount>();
let shown: SpendAccount | undefined;

/** Called at activation (and by hosts in tests) with where ledgers live and the settings they follow. */
export function configureSpend(next: SpendConfig): void {
  config = next;
}

/** The account for a key, or undefined when spend tracking is not configured or there is no key. */
export function spendAccountFor(baseUrl: string, apiKey: string): SpendAccount | undefined {
  if (!config || !apiKey) return undefined;
  const identity = spendIdentity(baseUrl, apiKey);
  const key = `${config.dir}\u0000${identity}`;
  let account = accounts.get(key);
  if (!account) { account = new SpendAccount(identity, config); accounts.set(key, account); }
  shown = account;
  return account;
}

/** The account the displays show (the one the current workspace last used). */
export function shownSpendAccount(): SpendAccount | undefined { return shown; }
export function showSpendAccount(account: SpendAccount | undefined): void { if (account) shown = account; }

/** Every account's NEAR figure is dropped (the reporting token changed). */
export function resetNearUsage(): void { for (const account of accounts.values()) account.usage.reset(); }

export function disposeSpendAccounts(): void { for (const account of accounts.values()) account.dispose(); accounts.clear(); shown = undefined; }

export { emptyTotals };
