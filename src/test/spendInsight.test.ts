// Spend visibility: where the figures come from, totals by calendar period, the burn rate and
// time to depletion, and what a failed usage summary or token test means. Local time is a fixed
// zone with daylight saving so period starts are checked across a DST change.
process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NearAiError } from '../services/nearAiClient';
import { SpendAccount } from '../services/spendAccount';
import { BALANCE_UNAVAILABLE_TEXT, buildSpendInsight, burnRate, burnView, CONSOLE_URL, costSource, creditsView, depletion, describeUsageError, durationText, emptyCounts, periodFigure, periodStarts, SpendPeriod, tokenStatus, tokenTestMessage, TOP_UP_TOOLTIP } from '../services/spendInsight';
import { emptyTotals, SpendLedger } from '../services/spendLedger';
import { NearUsageSummary, ReportingApi } from '../services/spendReconciler';

const at = (text: string) => new Date(text).getTime();
const hhmm = (time: number) => new Date(time).toISOString().slice(11, 16);
const DAY = 86_400_000;
const TOKEN = 'rpt-0123456789abcdef0123';

test('period starts are local midnight of today, Monday, the 1st, and January 1st', () => {
  // Wednesday 2026-10-28 15:30 local.
  const now = new Date(2026, 9, 28, 15, 30).getTime();
  assert.deepEqual(periodStarts(now), {
    today: new Date(2026, 9, 28).getTime(),
    week: new Date(2026, 9, 26).getTime(),
    month: new Date(2026, 9, 1).getTime(),
    year: new Date(2026, 0, 1).getTime()
  });
  // Sunday belongs to the week that began the Monday before; Monday starts a new one.
  assert.equal(periodStarts(new Date(2026, 10, 1, 23, 59).getTime()).week, new Date(2026, 9, 26).getTime());
  assert.equal(periodStarts(new Date(2026, 10, 2, 0, 1).getTime()).week, new Date(2026, 10, 2).getTime());
  // Across the November DST change the week still starts at local midnight (not 24 h multiples).
  const afterDst = periodStarts(new Date(2026, 10, 3, 9).getTime());
  assert.equal(new Date(afterDst.week).getHours(), 0);
  assert.equal(new Date(afterDst.week).getDate(), 2);
  // Just after midnight on January 1st, every period starts then.
  const newYear = new Date(2027, 0, 1, 0, 5).getTime();
  const starts = periodStarts(newYear);
  assert.equal(starts.year, new Date(2027, 0, 1).getTime());
  assert.equal(starts.month, starts.year);
  assert.equal(starts.today, starts.year);
  assert.equal(starts.week, new Date(2026, 11, 28).getTime(), 'the week began on Monday in the old year');
});

test('period starts follow the UTC day boundary when chosen', () => {
  const now = Date.UTC(2026, 9, 28, 2, 0); // Wednesday 02:00 UTC, still Tuesday evening in Toronto
  assert.deepEqual(periodStarts(now, 'utc'), { today: Date.UTC(2026, 9, 28), week: Date.UTC(2026, 9, 26), month: Date.UTC(2026, 9, 1), year: Date.UTC(2026, 0, 1) });
  assert.equal(periodStarts(now, 'local').today, new Date(2026, 9, 27).getTime());
});

test('the cost source is NEAR billing only when NEAR answered for today, per request only when something was reconciled', () => {
  const now = at('2026-10-28T16:00:00Z');
  const near = { nanoUsd: 2_000_000_000, at: now, since: now - 3_600_000 };
  const counts = { reconciled: 3, pending: 1, estimated: 1 };
  const actual = costSource({ tokenState: 'set', near, counts, formatTime: hhmm });
  assert.equal(actual.kind, 'near');
  assert.equal(actual.label, 'Actual (NEAR billing)');
  assert.match(actual.detail, /as of 16:00/);
  assert.equal(actual.token.state, 'working');

  const perRequest = costSource({ tokenState: 'missing', counts, formatTime: hhmm });
  assert.equal(perRequest.kind, 'per-request');
  assert.equal(perRequest.label, 'Actual per request (billing/costs)');
  assert.match(perRequest.detail, /3 of 5 requests today reconciled with NEAR's billing; 2 still estimated/);
  assert.equal(perRequest.token.state, 'missing');

  const estimate = costSource({ tokenState: 'missing', counts: { reconciled: 0, pending: 2, estimated: 1 } });
  assert.equal(estimate.kind, 'estimated');
  assert.equal(estimate.label, 'Estimated from list prices');
  assert.match(estimate.detail, /None of today's 3 requests/);

  assert.equal(costSource({ tokenState: 'missing', counts: emptyCounts() }).kind, 'none');
  // A token that is switched off never makes the figure "actual (NEAR billing)", even with an old figure.
  assert.equal(costSource({ tokenState: 'off', near, counts }).kind, 'per-request');
});

test('a failing token is reported with its problem, and an old NEAR figure is marked possibly out of date', () => {
  const now = at('2026-10-28T16:00:00Z');
  const failing = costSource({ tokenState: 'set', problem: 'NEAR rejected the usage reporting token (HTTP 401)', counts: { reconciled: 0, pending: 0, estimated: 2 } });
  assert.equal(failing.kind, 'estimated', 'without NEAR\'s figure the estimate is never called actual');
  assert.equal(failing.token.state, 'failing');
  assert.match(failing.token.problem!, /HTTP 401/);
  const stale = costSource({ tokenState: 'set', near: { nanoUsd: 1, at: now, since: now }, problem: 'NEAR AI Cloud could not be reached: offline.', counts: emptyCounts() });
  assert.equal(stale.kind, 'near');
  assert.match(stale.detail, /latest check failed/);
  assert.equal(tokenStatus({ tokenState: 'set' }).state, 'unchecked');
  assert.equal(tokenStatus({ tokenState: 'off' }).state, 'off');
  assert.match(tokenStatus({ tokenState: 'set', okAt: now, problem: 'x', formatTime: hhmm }).text, /last worked at 16:00/);
});

test('each period figure is NEAR\'s when it covers exactly that period, else the ledger labelled by how much is reconciled', () => {
  const since = new Date(2026, 9, 1).getTime();
  const totals = { ...emptyTotals(), confirmedNanoUsd: 8_000_000_000, pendingNanoUsd: 2_000_000_000, requests: 10, pendingRequests: 2 };
  const near = periodFigure('month', since, { totals, counts: { reconciled: 8, pending: 2, estimated: 0 } }, { nanoUsd: 12_500_000_000, at: since + DAY, since });
  assert.deepEqual([near.text, near.source, near.sourceText], ['$12.50', 'near', 'Actual (NEAR billing)']);
  const other = periodFigure('month', since, { totals, counts: { reconciled: 8, pending: 2, estimated: 0 } }, { nanoUsd: 1, at: since, since: since - DAY });
  assert.deepEqual([other.text, other.source, other.sourceText], ['$10.00', 'partial', 'Partly estimated: 8 of 10 reconciled'], 'a NEAR figure for another start is not used');
  const all = periodFigure('week', since, { totals: { ...totals, pendingNanoUsd: 0 }, counts: { reconciled: 8, pending: 0, estimated: 0 } });
  assert.equal(all.source, 'per-request');
  assert.equal(all.sourceText, 'Actual per request');
  const none = periodFigure('today', since, { totals: { ...emptyTotals(), estimatedNanoUsd: 3_000_000, requests: 1 }, counts: { reconciled: 0, pending: 0, estimated: 1 } });
  assert.deepEqual([none.text, none.source, none.sourceText], ['$0.0030', 'estimated', 'Estimated from list prices']);
  assert.equal(periodFigure('year', since, { totals: emptyTotals(), counts: emptyCounts() }).source, 'none');
});

test('burn rate is the trailing 7 days divided by 7, and depletion is the remaining credits over that rate', () => {
  assert.equal(burnRate(14), 2);
  assert.equal(burnRate(0), 0);
  assert.equal(burnRate(-1), 0);
  assert.equal(burnRate(Number.NaN), 0);
  const now = at('2026-10-28T12:00:00Z');
  assert.deepEqual(depletion(10, 2, now), { days: 5, at: now + 5 * DAY });
  assert.equal(depletion(10, 0, now), undefined, 'nothing spent: it never runs out');
  assert.deepEqual(depletion(-3, 2, now), { days: 0, at: now }, 'already used up');
  assert.equal(durationText(5), 'about 5 days');
  assert.equal(durationText(0.25), 'about 6 hours');
  assert.equal(durationText(0.01), 'less than an hour');
  const burn = burnView(7, 'ledger');
  assert.equal(burn.text, '$1.00/day');
  assert.match(burn.tooltip, /divided by 7: a trailing 7-day average/);
  assert.match(burn.tooltip, /this computer's spend ledger/);
});

test('without a real balance the credits say so; with one, the time to depletion is shown with its method', () => {
  const now = at('2026-10-28T12:00:00Z');
  const burn = burnView(14, 'near');
  const unknown = creditsView({ burn, now });
  assert.equal(unknown.available, false);
  assert.equal(unknown.text, BALANCE_UNAVAILABLE_TEXT);
  assert.match(unknown.tooltip, /usage\/balance/);
  assert.equal(unknown.depletionText, undefined);
  const known = creditsView({ remainingUsd: 20, burn, now });
  assert.equal(known.available, true);
  assert.equal(known.text, '$20.00');
  assert.match(known.depletionText!, /^about 10 days/);
  assert.match(known.tooltip, /remaining credits divided by the burn rate/);
});

test('usage summary and token test errors are mapped to what went wrong, never echoing the token', () => {
  const error = (status: number, message = 'x', detail?: string) => new NearAiError(status, message, false, undefined, detail ? { detail } : {});
  assert.equal(describeUsageError(error(401), 'summary').code, 'token-rejected');
  assert.equal(describeUsageError(error(401), 'api-key').code, 'api-key-rejected');
  assert.equal(describeUsageError(error(402), 'api-key').code, 'out-of-credits');
  const wrongOrg = describeUsageError(error(403), 'summary', { organizationId: 'org-123' });
  assert.equal(wrongOrg.code, 'wrong-org');
  assert.match(wrongOrg.message, /organization org-123/);
  assert.equal(describeUsageError(error(429), 'summary').code, 'rate-limited');
  assert.equal(describeUsageError(error(408), 'summary').code, 'timeout');
  assert.equal(describeUsageError(error(503), 'api-key').code, 'server');
  assert.match(describeUsageError(error(400, 'bad', 'start_time is invalid'), 'summary').message, /NEAR says: start_time is invalid/);
  const network = describeUsageError(new NearAiError(0, 'NEAR AI request failed: getaddrinfo ENOTFOUND cloud-api.near.ai.', true), 'summary');
  assert.equal(network.code, 'network');
  assert.match(network.message, /could not be reached: getaddrinfo ENOTFOUND cloud-api\.near\.ai\.$/);
  assert.equal(describeUsageError(new NearAiError(0, 'NEAR AI\'s usage summary had no total.', false), 'summary').code, 'bad-response');
  assert.equal(describeUsageError(new Error('boom'), 'summary').code, 'unexpected');
  for (const status of [400, 401, 403, 429, 500]) assert.doesNotMatch(describeUsageError(error(status, `with ${TOKEN}`), 'summary').message, /rpt-/);
  assert.match(tokenTestMessage({ ok: true, at: at('2026-10-28T16:00:00Z'), nanoUsd: 1_230_000_000, organizationId: 'o' }, hhmm), /works: NEAR's usage summary answered at 16:00 with \$1\.23 today/);
  assert.match(tokenTestMessage({ ok: false, code: 'wrong-org', message: 'other org' }), /test failed: other org/);
});

test('top up opens the console, and says signing in may be needed', () => {
  assert.equal(CONSOLE_URL, 'https://cloud.near.ai/dashboard');
  assert.match(TOP_UP_TOOLTIP, /you may need to sign in/);
});

class FakeReporting implements ReportingApi {
  public checks = 0;
  public calls: Array<{ token: string; startTime: string }> = [];
  public fail?: { stage: 'check' | 'summary'; error: Error };
  public constructor(public nano: (startTime: string) => number) {}
  public async checkApiKey() {
    this.checks += 1;
    if (this.fail?.stage === 'check') throw this.fail.error;
    return { organizationId: 'org-1', apiKeyId: 'key-1' };
  }
  public async usageSummary(token: string, _organizationId: string, query: { apiKeyId: string; startTime: string; endTime: string }) {
    if (this.fail?.stage === 'summary') throw this.fail.error;
    this.calls.push({ token, startTime: query.startTime });
    return this.nano(query.startTime);
  }
}

test('Test token now asks NEAR fresh and reports success, or the exact problem, updating the figure', async () => {
  let clock = at('2026-10-28T16:00:00Z');
  const reporting = new FakeReporting(() => 4_000_000_000);
  let token: string | undefined = TOKEN;
  const usage = new NearUsageSummary({ now: () => clock, dayStart: () => at('2026-10-28T04:00:00Z'), token: async () => token, active: () => false });
  assert.equal((await usage.testToken()).ok, false, 'no client yet');
  assert.equal(usage.attached, false);
  usage.attach(reporting);
  const ok = await usage.testToken();
  assert.deepEqual(ok, { ok: true, at: clock, nanoUsd: 4_000_000_000, organizationId: 'org-1' });
  assert.equal(usage.today()?.nanoUsd, 4_000_000_000);
  assert.equal(usage.okAt, clock);
  clock += 1_000;
  reporting.fail = { stage: 'summary', error: new NearAiError(403, 'forbidden', false) };
  const wrong = await usage.testToken();
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.code, 'wrong-org');
  assert.match(usage.problem!, /different organization/);
  reporting.fail = { stage: 'check', error: new NearAiError(402, 'no credits', false) };
  const broke = await usage.testToken();
  assert.equal(!broke.ok && broke.code, 'out-of-credits');
  assert.equal(reporting.checks, 3, 'the organization is asked fresh on every test');
  token = undefined;
  const none = await usage.testToken();
  assert.equal(!none.ok && none.code, 'no-token');
});

test('NEAR\'s week, month, year, and last-7-days figures are asked at most every 10 minutes, and only with a token', async () => {
  let clock = at('2026-10-28T16:00:00Z');
  const starts = { week: at('2026-10-26T04:00:00Z'), month: at('2026-10-01T04:00:00Z'), year: at('2026-01-01T05:00:00Z'), lastWeek: clock - 7 * DAY };
  const reporting = new FakeReporting((startTime) => (Date.parse(startTime) === starts.year ? 90_000_000_000 : 1_000_000_000));
  let token: string | undefined = TOKEN;
  const usage = new NearUsageSummary({ now: () => clock, dayStart: () => at('2026-10-28T04:00:00Z'), token: async () => token, active: () => false });
  usage.attach(reporting);
  await usage.refreshPeriods(starts);
  assert.equal(reporting.calls.length, 4);
  assert.equal(usage.period('year', starts.year)?.nanoUsd, 90_000_000_000);
  assert.equal(usage.period('year', starts.month), undefined, 'a figure for another start is not given');
  clock += 60_000;
  await usage.refreshPeriods({ ...starts, lastWeek: clock - 7 * DAY });
  assert.equal(reporting.calls.length, 4, 'not again within 10 minutes (the moving 7-day start does not count)');
  clock += 600_000;
  await usage.refreshPeriods(starts);
  assert.equal(reporting.calls.length, 8);
  token = undefined;
  await usage.refreshPeriods(starts, true);
  assert.equal(reporting.calls.length, 8, 'no token, no call');
  assert.ok(reporting.calls.every((call) => call.token === TOKEN));
});

test('the ledger counts unique requests by how their cost is known, and a reader can span the whole year', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-insight-'));
  let clock = at('2026-03-10T12:00:00Z');
  const march = new SpendLedger(dir, { now: () => clock, writer: 'w' });
  march.start({ path: '/chat/completions', status: 'completed', requestId: 'march-1', estimateNanoUsd: 5_000_000 });
  march.settle('march-1', 7_000_000);
  await march.flush();
  clock = at('2026-10-28T12:00:00Z');
  const october = new SpendLedger(dir, { now: () => clock, writer: 'w' });
  await october.refresh();
  assert.equal(october.list().length, 0, 'March is not read by default');
  october.start({ path: '/chat/completions', status: 'completed', requestId: 'a', estimateNanoUsd: 1_000_000 });
  october.start({ path: '/chat/completions', status: 'completed', requestId: 'a', estimateNanoUsd: 1_000_000 });
  october.start({ path: '/chat/completions', status: 'completed', requestId: 'b', estimateNanoUsd: 1_000_000 });
  october.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 1_000_000 });
  october.settle('a', 2_000_000);
  assert.deepEqual(october.requestCounts(), { reconciled: 1, pending: 1, estimated: 1 });
  await october.flush();
  const year = new SpendLedger(dir, { now: () => clock, writer: 'reader', from: at('2026-01-01T00:00:00Z') });
  await year.refresh();
  assert.deepEqual(year.requestCounts(), { reconciled: 2, pending: 1, estimated: 1 });
  assert.equal(year.totals().confirmedNanoUsd, 9_000_000);
});

test('the account\'s insight labels each period, falls back to the ledger without a token, and never calls an estimate actual', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-insight-'));
  const clock = new Date(2026, 9, 28, 12, 0).getTime();
  let token: string | undefined;
  const account = new SpendAccount('insight', { dir, now: () => clock, timers: false, dayBoundary: () => 'local', reportingToken: async () => token });
  const reporting = new FakeReporting(() => 50_000_000_000);
  account.attach({ billingCosts: async () => ({ costs: new Map(), warning: false }), checkApiKey: () => reporting.checkApiKey(), usageSummary: (t, o, q) => reporting.usageSummary(t, o, q) });
  account.ledger.start({ path: '/chat/completions', status: 'completed', requestId: 'r1', estimateNanoUsd: 1_000_000_000 });
  account.ledger.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 500_000_000 });
  account.ledger.settle('r1', 1_200_000_000);
  await account.ledger.flush();

  const local = await account.insight('missing');
  assert.equal(local.source.kind, 'per-request');
  assert.match(local.source.detail, /1 of 2 requests today reconciled/);
  assert.deepEqual(local.periods.map((figure) => [figure.period, figure.text, figure.source]), (['today', 'week', 'month', 'year'] as SpendPeriod[]).map((period) => [period, '$1.70', 'partial']));
  assert.equal(local.burn.source, 'ledger');
  assert.equal(local.credits.available, false);
  assert.equal(local.token.canTest, false);
  assert.equal(reporting.calls.length, 0, 'no token: NEAR is not asked');
  assert.match(account.today().tooltip, /^Cost source: Actual per request \(billing\/costs\)\. 1 of 2 requests/);

  token = TOKEN;
  await account.usage.tick();
  await account.insight('set');
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20 && reporting.calls.length < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const near = await account.insight('set');
  assert.equal(near.source.kind, 'near');
  assert.equal(near.source.label, 'Actual (NEAR billing)');
  assert.deepEqual(near.periods.map((figure) => figure.source), ['near', 'near', 'near', 'near']);
  assert.equal(near.periods[3].text, '$50.00');
  assert.equal(near.burn.source, 'near');
  assert.equal(near.token.state, 'working');
  assert.equal(near.token.canTest, true);
  assert.match(account.today().tooltip, /^Cost source: Actual \(NEAR billing\)/);
});

test('the page builder keeps the cost source honest when the token is off', () => {
  const now = new Date(2026, 9, 28, 12).getTime();
  const starts = periodStarts(now);
  const ledger = Object.fromEntries((['today', 'week', 'month', 'year'] as SpendPeriod[]).map((period) => [period, { totals: { ...emptyTotals(), pendingNanoUsd: 1_000_000, requests: 1, pendingRequests: 1 }, counts: { reconciled: 0, pending: 1, estimated: 0 } }])) as Parameters<typeof buildSpendInsight>[0]['ledger'];
  const insight = buildSpendInsight({ tokenState: 'off', now, boundary: 'local', near: { today: { nanoUsd: 9, at: now, since: starts.today } }, ledger, ledgerLastWeekUsd: 0 });
  assert.equal(insight.source.kind, 'estimated');
  assert.ok(insight.periods.every((figure) => figure.source === 'estimated'));
  assert.equal(insight.token.state, 'off');
  assert.equal(insight.topUp.text, 'Top up credits');
});
