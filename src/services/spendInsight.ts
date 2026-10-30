import type { ReportingTokenState } from './reportingToken';
import { DayBoundary, dayStart, nanoToUsd, SpendTotals, totalNanoUsd } from './spendLedger';

// Where the spend figures come from, totals by calendar period, the burn rate, what is known about
// the organization's credits, and where to top them up. Pure: no VS Code API, no network, and no
// token (only whether one is stored and how NEAR last answered). Every display (Agent Activity,
// the chat's status tooltip) builds its words here, so an estimate is never labelled actual.

/** The NEAR AI Cloud console. Credits are bought in its Credits section, after signing in. */
export const CONSOLE_URL = 'https://cloud.near.ai/dashboard';
export const TOP_UP_TEXT = 'Top up credits';
export const TOP_UP_TOOLTIP = 'Opens the NEAR AI Cloud console in your browser; you may need to sign in, then open Credits to add credits. NEAR has no payment link that works without signing in.';
export const BALANCE_UNAVAILABLE_TEXT = 'Not available through NEAR\'s API';
export const BALANCE_UNAVAILABLE_TOOLTIP = 'NEAR AI Cloud only shows an organization\'s remaining credits to a signed-in console session (GET /v1/organizations/{org_id}/usage/balance). An API key or a usage reporting token cannot read it, so the remaining credits and the time until they run out are not shown here. Open the console to see them.';
export const BURN_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** Unique NEAR requests by how their cost is known. */
export interface RequestCounts {
  /** NEAR's billing API reported the actual cost. */
  reconciled: number;
  /** Has an inference-id; waiting for NEAR's figure (counted at the estimate). */
  pending: number;
  /** No inference-id: only the list-price estimate will ever be known. */
  estimated: number;
}

export const emptyCounts = (): RequestCounts => ({ reconciled: 0, pending: 0, estimated: 0 });

/** A figure NEAR's usage summary returned, and the period start it covers. */
export interface NearFigure { nanoUsd: number; at: number; since: number }

export type CostSourceKind = 'near' | 'per-request' | 'estimated' | 'none';
export type TokenStatusState = 'missing' | 'off' | 'unchecked' | 'working' | 'failing';

export interface TokenStatus {
  state: TokenStatusState;
  /** One line for the page. */
  text: string;
  /** NEAR's problem, when the token is set and the last check failed (never the token itself). */
  problem?: string;
}

export interface CostSource {
  kind: CostSourceKind;
  /** e.g. "Actual (NEAR billing)". */
  label: string;
  /** What exactly, e.g. "3 of 5 requests today reconciled with NEAR's billing; 2 still estimated". */
  detail: string;
  token: TokenStatus;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** How the usage reporting token is doing: missing, switched off, not yet asked, answering, or failing. */
export function tokenStatus(input: { tokenState: ReportingTokenState; okAt?: number; problem?: string; formatTime?: (at: number) => string }): TokenStatus {
  const time = input.formatTime ?? clock;
  if (input.tokenState === 'missing') return { state: 'missing', text: 'No usage reporting token is set.' };
  if (input.tokenState === 'off') return { state: 'off', text: 'A usage reporting token is set but not used (nearAi.spend.useNearUsageTotal is off).' };
  if (input.problem) return { state: 'failing', text: `The usage reporting token is set, but NEAR's usage summary failed${input.okAt ? ` (last worked at ${time(input.okAt)})` : ''}.`, problem: input.problem };
  if (input.okAt) return { state: 'working', text: `The usage reporting token works: NEAR's usage summary answered at ${time(input.okAt)}.` };
  return { state: 'unchecked', text: 'The usage reporting token is set; NEAR has not been asked yet.' };
}

/**
 * Where today's figure comes from. "Actual (NEAR billing)" only when NEAR's usage summary answered
 * for today; "Actual per request" only when at least one request was reconciled with
 * /v1/billing/costs (with how many are still estimates); otherwise the list-price estimate.
 */
export function costSource(input: { tokenState: ReportingTokenState; near?: NearFigure; okAt?: number; problem?: string; counts: RequestCounts; formatTime?: (at: number) => string }): CostSource {
  const time = input.formatTime ?? clock;
  const token = tokenStatus({ tokenState: input.tokenState, okAt: input.okAt ?? input.near?.at, problem: input.problem, formatTime: time });
  if (input.tokenState === 'set' && input.near) {
    const stale = input.problem ? '; the latest check failed, so it may be out of date' : '';
    return { kind: 'near', label: 'Actual (NEAR billing)', detail: `NEAR AI Cloud's usage summary for this API key, from every computer using it, as of ${time(input.near.at)}${stale}.`, token };
  }
  const { reconciled, pending, estimated } = input.counts;
  const total = reconciled + pending + estimated;
  if (!total) return { kind: 'none', label: 'No spend recorded yet', detail: 'No NEAR AI requests from this computer today.', token };
  const unsettled = pending + estimated;
  if (reconciled > 0) {
    return { kind: 'per-request', label: 'Actual per request (billing/costs)', detail: `${reconciled} of ${plural(total, 'request')} today reconciled with NEAR's billing; ${unsettled ? `${unsettled} still estimated from list prices` : 'none estimated'}. This computer only.`, token };
  }
  return { kind: 'estimated', label: 'Estimated from list prices', detail: `None of today's ${plural(total, 'request')} is reconciled with NEAR's billing yet${pending ? `; ${pending} waiting for NEAR's figure` : ''}. This computer only.`, token };
}

// ---- totals by calendar period ----

export type SpendPeriod = 'today' | 'week' | 'month' | 'year';
export const PERIODS: SpendPeriod[] = ['today', 'week', 'month', 'year'];
const PERIOD_LABEL: Record<SpendPeriod, string> = { today: 'Today', week: 'This week', month: 'This month', year: 'This year' };

/** Start (ms) of today, this week (from Monday), this month, and this year, in local time (or UTC). */
export function periodStarts(now: number, boundary: DayBoundary = 'local'): Record<SpendPeriod, number> {
  const today = dayStart(now, boundary);
  const date = new Date(today);
  if (boundary === 'utc') {
    const weekday = (date.getUTCDay() + 6) % 7;
    return { today, week: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday), month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), year: Date.UTC(date.getUTCFullYear(), 0, 1) };
  }
  const weekday = (date.getDay() + 6) % 7;
  return { today, week: new Date(date.getFullYear(), date.getMonth(), date.getDate() - weekday).getTime(), month: new Date(date.getFullYear(), date.getMonth(), 1).getTime(), year: new Date(date.getFullYear(), 0, 1).getTime() };
}

export type FigureSource = 'near' | 'per-request' | 'partial' | 'estimated' | 'none';

export interface PeriodFigure {
  period: SpendPeriod;
  label: string;
  since: number;
  usd: number;
  /** e.g. "$12.40". */
  text: string;
  source: FigureSource;
  /** e.g. "Actual (NEAR billing)" or "Partly estimated: 8 of 10 reconciled". */
  sourceText: string;
  tooltip: string;
}

const money = (usd: number) => `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;

/** One figure: NEAR's own when it covers exactly this period, else this computer's ledger, labelled by how sure it is. */
export function periodFigure(period: SpendPeriod, since: number, ledger: { totals: SpendTotals; counts: RequestCounts }, near?: NearFigure, formatTime: (at: number) => string = clock): PeriodFigure {
  const label = PERIOD_LABEL[period];
  if (near && near.since === since) {
    const usd = nanoToUsd(near.nanoUsd);
    return { period, label, since, usd, text: money(usd), source: 'near', sourceText: 'Actual (NEAR billing)', tooltip: `NEAR AI Cloud's usage summary for this API key since ${new Date(since).toLocaleDateString()}, from every computer using it (as of ${formatTime(near.at)}).` };
  }
  const usd = nanoToUsd(totalNanoUsd(ledger.totals));
  const { reconciled, pending, estimated } = ledger.counts;
  const total = reconciled + pending + estimated;
  const base = `This computer's spend ledger since ${new Date(since).toLocaleDateString()} (other computers using the key are not included).`;
  if (!total) return { period, label, since, usd: 0, text: money(0), source: 'none', sourceText: 'No requests', tooltip: base };
  if (!pending && !estimated) return { period, label, since, usd, text: money(usd), source: 'per-request', sourceText: 'Actual per request', tooltip: `${base} Every request's cost was reported by NEAR's billing API (/v1/billing/costs).` };
  if (reconciled) return { period, label, since, usd, text: money(usd), source: 'partial', sourceText: `Partly estimated: ${reconciled} of ${total} reconciled`, tooltip: `${base} ${reconciled} of ${plural(total, 'request')} have NEAR's actual cost; ${pending + estimated} are counted at list-price estimates.` };
  return { period, label, since, usd, text: money(usd), source: 'estimated', sourceText: 'Estimated from list prices', tooltip: `${base} None of these ${plural(total, 'request')} is reconciled with NEAR's billing yet.` };
}

// ---- burn rate, remaining credits, time to depletion ----

/** Average spend per day over a window of `days` days. */
export function burnRate(spentUsd: number, days = BURN_WINDOW_DAYS): number {
  if (!(days > 0) || !Number.isFinite(spentUsd) || spentUsd <= 0) return 0;
  return spentUsd / days;
}

/** When `remainingUsd` runs out at `perDayUsd`; undefined when nothing is being spent or nothing is left to count down. */
export function depletion(remainingUsd: number, perDayUsd: number, now: number): { days: number; at: number } | undefined {
  if (!Number.isFinite(remainingUsd) || !(perDayUsd > 0)) return undefined;
  const days = Math.max(0, remainingUsd) / perDayUsd;
  return { days, at: now + days * DAY_MS };
}

/** "about 3 days", "about 5 hours", "less than an hour". */
export function durationText(days: number): string {
  if (days >= 2) return `about ${Math.round(days)} days`;
  const hours = days * 24;
  if (hours >= 1) return `about ${plural(Math.round(hours), 'hour')}`;
  return 'less than an hour';
}

export interface BurnView { usdPerDay: number; text: string; source: 'near' | 'ledger'; tooltip: string }

export function burnView(spentUsd: number, source: 'near' | 'ledger'): BurnView {
  const usdPerDay = burnRate(spentUsd);
  const from = source === 'near' ? 'NEAR AI Cloud\'s usage summary for this API key' : 'this computer\'s spend ledger (other computers using the key are not included)';
  return { usdPerDay, text: `${money(usdPerDay)}/day`, source, tooltip: `The last ${BURN_WINDOW_DAYS} days' spend (${money(spentUsd)}, from ${from}) divided by ${BURN_WINDOW_DAYS}: a trailing ${BURN_WINDOW_DAYS}-day average.` };
}

export interface CreditsView {
  available: boolean;
  /** The remaining credits, or why they are not shown. */
  text: string;
  tooltip: string;
  /** When the remaining credits run out at the burn rate, when both are known. */
  depletionText?: string;
}

/** The remaining credits, only when a real balance is known; otherwise says plainly that NEAR's API does not give it. */
export function creditsView(input: { remainingUsd?: number; burn: BurnView; now: number }): CreditsView {
  if (input.remainingUsd === undefined || !Number.isFinite(input.remainingUsd)) return { available: false, text: BALANCE_UNAVAILABLE_TEXT, tooltip: BALANCE_UNAVAILABLE_TOOLTIP };
  const left = depletion(input.remainingUsd, input.burn.usdPerDay, input.now);
  const depletionText = left ? `${durationText(left.days)} (around ${new Date(left.at).toLocaleDateString()})` : 'Not running down (no spend in the last 7 days)';
  return { available: true, text: money(input.remainingUsd), depletionText, tooltip: `Time to depletion: the remaining credits divided by the burn rate. ${input.burn.tooltip}` };
}

// ---- what a failed usage summary or token test means ----

export type UsageErrorCode = 'no-token' | 'no-client' | 'api-key-rejected' | 'out-of-credits' | 'token-rejected' | 'wrong-org' | 'bad-request' | 'rate-limited' | 'timeout' | 'network' | 'server' | 'bad-response' | 'unexpected';

export interface UsageProblem { code: UsageErrorCode; message: string; status?: number }

/**
 * Turns an error from POST /v1/check_api_key (`stage: 'api-key'`) or GET .../usage/summary
 * (`stage: 'summary'`) into words. Errors from NearAiClient already have the token redacted; the
 * messages here never include it.
 */
export function describeUsageError(error: unknown, stage: 'api-key' | 'summary', context: { organizationId?: string } = {}): UsageProblem {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
  const raw = error instanceof Error ? error.message : '';
  const detail = typeof (error as { detail?: unknown })?.detail === 'string' ? (error as { detail: string }).detail.slice(0, 200) : undefined;
  const near = detail ? ` NEAR says: ${detail}` : '';
  if (status === 429) return { code: 'rate-limited', status, message: 'NEAR is rate limiting usage reports (HTTP 429). It will be asked again in a few minutes.' };
  if (status === 408) return { code: 'timeout', status, message: 'NEAR AI did not answer in time. Check your connection and try again.' };
  if (status !== undefined && status >= 500) return { code: 'server', status, message: `NEAR AI Cloud had a server error (HTTP ${status}). Try again later.` };
  if (stage === 'api-key') {
    if (status === 401) return { code: 'api-key-rejected', status, message: 'NEAR rejected this project\'s API key (HTTP 401) when asked which organization it belongs to. Check the key with NEAR AI: Setup.' };
    if (status === 402) return { code: 'out-of-credits', status, message: 'NEAR says this organization is out of credits or this API key\'s spend limit is reached (HTTP 402). Top up credits in the NEAR AI Cloud console.' };
  } else {
    if (status === 401) return { code: 'token-rejected', status, message: 'NEAR rejected the usage reporting token (HTTP 401): it is invalid, expired, or revoked. Set a new one.' };
    if (status === 403) return { code: 'wrong-org', status, message: `The usage reporting token is for a different organization than this API key (HTTP 403)${context.organizationId ? `; the key belongs to organization ${context.organizationId}` : ''}. Create a token for that organization.` };
    if (status === 400) return { code: 'bad-request', status, message: `NEAR refused the usage summary request (HTTP 400).${near}` };
  }
  if (status === 0 && /request failed/i.test(raw)) return { code: 'network', status, message: `NEAR AI Cloud could not be reached: ${raw.replace(/^NEAR AI request failed:\s*/i, '').replace(/\.$/, '')}.` };
  if (status === 0) return { code: 'bad-response', status, message: `NEAR AI Cloud answered, but not as expected: ${raw}` };
  if (status !== undefined) return { code: 'unexpected', status, message: `NEAR AI Cloud answered HTTP ${status}${stage === 'summary' ? ' to the usage summary' : ' when checking the API key'}.${near}` };
  return { code: 'unexpected', message: `The usage summary could not be read${raw ? `: ${raw}` : ''}.` };
}

export type TokenTestResult = { ok: true; at: number; nanoUsd: number; organizationId: string } | ({ ok: false } & UsageProblem);

/** What the token test reports, in one sentence. */
export function tokenTestMessage(result: TokenTestResult, formatTime: (at: number) => string = clock): string {
  if (result.ok) return `The usage reporting token works: NEAR's usage summary answered at ${formatTime(result.at)} with ${money(nanoToUsd(result.nanoUsd))} today for this API key.`;
  return `The usage reporting token test failed: ${result.message}`;
}

// ---- everything the page shows about spend, in one object ----

export interface SpendInsight {
  source: { kind: CostSourceKind; label: string; detail: string };
  token: TokenStatus & { canTest: boolean; canFix: boolean };
  periods: PeriodFigure[];
  burn: BurnView;
  credits: CreditsView;
  topUp: { text: string; tooltip: string };
}

export interface SpendInsightInput {
  tokenState: ReportingTokenState;
  now: number;
  boundary: DayBoundary;
  /** NEAR's figures by period, when the token works. */
  near: Partial<Record<SpendPeriod, NearFigure>>;
  /** NEAR's spend over the last 7 days, when the token works. */
  nearLastWeek?: NearFigure;
  /** When NEAR's usage summary last answered, and its last problem. */
  okAt?: number;
  problem?: string;
  /** This computer's ledger per period, and over the last 7 days. */
  ledger: Record<SpendPeriod, { totals: SpendTotals; counts: RequestCounts }>;
  ledgerLastWeekUsd: number;
  /** The remaining credits, when a real balance is known (NEAR's API does not give it today). */
  remainingUsd?: number;
  formatTime?: (at: number) => string;
}

export function buildSpendInsight(input: SpendInsightInput): SpendInsight {
  const time = input.formatTime ?? clock;
  const starts = periodStarts(input.now, input.boundary);
  const using = input.tokenState === 'set';
  const near = (period: SpendPeriod) => (using ? input.near[period] : undefined);
  const todayNear = near('today');
  const source = costSource({ tokenState: input.tokenState, near: todayNear && todayNear.since === starts.today ? todayNear : undefined, okAt: input.okAt, problem: input.problem, counts: input.ledger.today.counts, formatTime: time });
  const periods = PERIODS.map((period) => periodFigure(period, starts[period], input.ledger[period], near(period), time));
  const burn = using && input.nearLastWeek ? burnView(nanoToUsd(input.nearLastWeek.nanoUsd), 'near') : burnView(input.ledgerLastWeekUsd, 'ledger');
  return {
    source: { kind: source.kind, label: source.label, detail: source.detail },
    token: { ...source.token, canTest: input.tokenState !== 'missing', canFix: source.token.state === 'failing' },
    periods,
    burn,
    credits: creditsView({ remainingUsd: input.remainingUsd, burn, now: input.now }),
    topUp: { text: TOP_UP_TEXT, tooltip: TOP_UP_TOOLTIP }
  };
}
