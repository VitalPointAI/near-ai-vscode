import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dayStart, nanoToUsd, SpendLedger, spendIdentity, totalNanoUsd, withSpendTag, currentSpendTag } from '../services/spendLedger';
import { BillingApi, BillingCostsAnswer, NearUsageSummary, ReportingApi, SpendReconciler, USAGE_POLL_ACTIVE_MS, USAGE_POLL_IDLE_MS } from '../services/spendReconciler';
import { SpendAccount, spendView } from '../services/spendAccount';

const tempDir = () => mkdtemp(path.join(tmpdir(), 'near-ai-ledger-'));

test('two windows appending to one key\'s ledger at once: every entry is kept and both sum to the same total', async () => {
  const dir = await tempDir();
  const a = new SpendLedger(dir, { writer: 'window-a' });
  const b = new SpendLedger(dir, { writer: 'window-b' });
  const ids: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const ledger = i % 2 ? a : b;
    const id = ledger.start({ path: '/chat/completions', model: 'm', requestId: `req-${i}`, estimateNanoUsd: 1_000 + i, kind: 'main' });
    ledger.finish(id, { status: 'completed', inputTokens: 10, outputTokens: 5, estimateNanoUsd: 2_000 + i });
    ids.push(id);
  }
  await Promise.all([a.flush(), b.flush()]);
  await Promise.all([a.refresh(), b.refresh()]);
  const expected = Array.from({ length: 200 }, (_, i) => 2_000 + i).reduce((sum, value) => sum + value, 0);
  assert.equal(totalNanoUsd(a.totals()), expected);
  assert.equal(totalNanoUsd(b.totals()), expected);
  assert.equal(a.totals().requests, 200);
  assert.equal(a.totals().pendingRequests, 200, 'nothing is confirmed until NEAR reports it');
  // Each line on disk is a whole record: no interleaving.
  const files = await readdir(dir);
  for (const file of files) for (const line of (await readFile(path.join(dir, file), 'utf8')).trim().split('\n')) JSON.parse(line);
  // A settlement in one window reaches the other.
  b.settle('req-0', 5_000);
  await b.flush();
  await a.refresh();
  assert.equal(a.totals({ requestId: 'req-0' }).confirmedNanoUsd, 5_000);
});

test('a reloaded ledger has the same totals, settlements, and statuses, and never stores the key', async () => {
  const dir = await tempDir();
  const first = new SpendLedger(dir);
  const done = first.start({ path: '/chat/completions', requestId: 'req-1', estimateNanoUsd: 100, kind: 'main', runId: 'run-1', conversationId: 'conv-1' });
  first.finish(done, { status: 'completed', estimateNanoUsd: 300 });
  const broken = first.start({ path: '/chat/completions', requestId: 'req-2', estimateNanoUsd: 50, kind: 'sub-agent', runId: 'run-1' });
  first.finish(broken, { status: 'partial' });
  first.start({ path: '/chat/completions', status: 'aborted', estimateNanoUsd: 40, kind: 'safety', runId: 'run-1' });
  first.settle('req-1', 250);
  await first.flush();
  const second = new SpendLedger(dir);
  await second.refresh();
  assert.deepEqual(second.totals({ runId: 'run-1' }), first.totals({ runId: 'run-1' }));
  assert.deepEqual(second.totals({ runId: 'run-1' }), { confirmedNanoUsd: 250, pendingNanoUsd: 50, estimatedNanoUsd: 40, requests: 3, pendingRequests: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  assert.equal(second.get(broken)?.status, 'partial');
  assert.equal(second.totals({ conversationId: 'conv-1' }).confirmedNanoUsd, 250);
  const identity = spendIdentity('https://cloud-api.near.ai/v1', 'sk-secret-key-123');
  assert.match(identity, /^[0-9a-f]{24}$/);
  assert.ok(!identity.includes('sk-secret'));
  assert.notEqual(identity, spendIdentity('https://cloud-api.near.ai/v1', 'sk-other-key-456'));
});

test('spend tags nest: the innermost kind wins and the run and conversation carry through', async () => {
  const seen = await withSpendTag({ kind: 'main', runId: 'run-9', conversationId: 'conv-9' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return withSpendTag({ kind: 'safety' }, async () => { await Promise.resolve(); return currentSpendTag(); });
  });
  assert.deepEqual(seen, { kind: 'safety', runId: 'run-9', conversationId: 'conv-9' });
  assert.deepEqual(currentSpendTag(), {});
});

test('today is the local calendar day by default, or the UTC day with nearAi.spend.dayBoundary = utc', async () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Edmonton';
  try {
    const now = Date.parse('2026-10-28T18:00:00Z');
    assert.equal(new Date(dayStart(now, 'local')).toISOString(), '2026-10-28T06:00:00.000Z', 'midnight in Edmonton (UTC-6)');
    assert.equal(new Date(dayStart(now, 'utc')).toISOString(), '2026-10-28T00:00:00.000Z');
    const dir = await tempDir();
    let clock = Date.parse('2026-10-28T05:00:00Z');
    const config = { dir, now: () => clock, timers: false, dayBoundary: () => 'local' as const };
    const account = new SpendAccount('identity-a', config);
    account.ledger.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 1_000_000_000 }); // 23:00 on the 27th, local
    clock = Date.parse('2026-10-28T07:00:00Z');
    account.ledger.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 250_000_000 }); // 01:00 on the 28th, local
    clock = now;
    assert.equal(account.spentTodayUsd().usd, 0.25);
    await account.ledger.flush();
    const utc = new SpendAccount('identity-a', { ...config, dayBoundary: () => 'utc' as const });
    await utc.ledger.refresh();
    assert.equal(utc.spentTodayUsd().usd, 1.25);
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

class FakeBilling implements BillingApi {
  public calls: string[][] = [];
  public failNext: { status: number; retryAfterMs?: number } | undefined;
  public constructor(public costs: Map<string, number>, public warnFor = new Set<string>()) {}
  public async billingCosts(ids: string[]): Promise<BillingCostsAnswer> {
    this.calls.push([...ids]);
    if (this.failNext) { const failure = this.failNext; this.failNext = undefined; throw Object.assign(new Error('refused'), failure); }
    const answer = new Map<string, number>();
    let warning = false;
    for (const id of ids) { if (this.warnFor.has(id) || !this.costs.has(id)) { answer.set(id, 0); warning = true; } else answer.set(id, this.costs.get(id)!); }
    return { costs: answer, warning };
  }
}

test('reconciliation asks at 5 s, 30 s, 2 min, and 10 min in batches, backs off on 429, and settles a lasting zero as $0', async () => {
  const dir = await tempDir();
  let clock = 1_000_000;
  const ledger = new SpendLedger(dir, { now: () => clock, writer: 'me' });
  const ids = ['a', 'b', 'c'];
  for (const id of ids) ledger.finish(ledger.start({ path: '/chat/completions', requestId: id, estimateNanoUsd: 10 }), { status: 'completed', estimateNanoUsd: 10 });
  const billing = new FakeBilling(new Map([['a', 7], ['b', 8]]), new Set(['b']));
  const reconciler = new SpendReconciler(ledger, { now: () => clock, maxBatch: 2 });
  reconciler.attach(billing);
  clock += 4_000; await reconciler.tick();
  assert.equal(billing.calls.length, 0, 'NEAR records usage a few seconds late, so nothing is asked before 5 s');
  clock += 1_000; await reconciler.tick();
  assert.deepEqual(billing.calls, [['a', 'b']], 'due IDs go in one batch, at most maxBatch');
  await reconciler.tick();
  assert.deepEqual(billing.calls.at(-1), ['c']);
  assert.equal(ledger.totals({ requestId: 'a' }).confirmedNanoUsd, 7);
  assert.equal(ledger.totals({ requestId: 'b' }).pendingRequests, 1, 'a zero with a warning stays pending');
  const calls = billing.calls.length;
  await reconciler.tick();
  assert.equal(billing.calls.length, calls, 'no second ask before the next step of the schedule');
  billing.failNext = { status: 429, retryAfterMs: 90_000 };
  clock += 30_000; await reconciler.tick();
  assert.equal(billing.calls.length, calls + 1);
  clock += 60_000; await reconciler.tick();
  assert.equal(billing.calls.length, calls + 1, 'Retry-After is honoured');
  clock += 31_000; await reconciler.tick();
  assert.equal(billing.calls.length, calls + 2);
  billing.warnFor.delete('b');
  billing.costs.delete('c'); // NEAR never recorded it
  clock += 2 * 60_000; await reconciler.tick();
  assert.equal(billing.calls.length, calls + 2, 'after 2 minutes the next ask is at 10 minutes');
  clock += 6 * 60_000; await reconciler.tick();
  assert.equal(billing.calls.length, calls + 3);
  assert.equal(ledger.totals({ requestId: 'b' }).confirmedNanoUsd, 8);
  const c = ledger.list({ requestId: 'c' })[0];
  assert.equal(c.actualNanoUsd, 0);
  assert.equal(c.settledBy, 'zero', 'still 0 after 10 minutes: settled as $0');
  assert.equal(ledger.pending().length, 0);
});

test('the pending queue survives a reload: a new window picks up IDs the old one never settled', async () => {
  const dir = await tempDir();
  let clock = 5_000_000;
  const old = new SpendLedger(dir, { now: () => clock, writer: 'old-window' });
  old.finish(old.start({ path: '/chat/completions', requestId: 'r1', estimateNanoUsd: 10 }), { status: 'completed' });
  old.start({ path: '/chat/completions', requestId: 'r2', estimateNanoUsd: 10 }); // the host died mid-stream
  await old.flush();
  const fresh = new SpendLedger(dir, { now: () => clock, writer: 'new-window' });
  const billing = new FakeBilling(new Map([['r1', 11], ['r2', 12]]));
  const reconciler = new SpendReconciler(fresh, { now: () => clock });
  reconciler.attach(billing);
  clock += 60_000; await reconciler.tick();
  assert.equal(billing.calls.length, 0, 'another window\'s entries are left to it for 10 minutes');
  clock += 10 * 60_000; await reconciler.tick();
  assert.deepEqual(billing.calls, [['r1']]);
  clock += 30 * 60_000; await reconciler.tick();
  assert.deepEqual(billing.calls.at(-1), ['r2'], 'a stream left open by a window that went away is reconciled after 30 minutes');
  assert.equal(totalNanoUsd(fresh.totals()), 23);
});

test('billing waits while NEAR is rate limiting the key', async () => {
  const dir = await tempDir();
  let clock = 0;
  const ledger = new SpendLedger(dir, { now: () => clock });
  ledger.finish(ledger.start({ path: '/chat/completions', requestId: 'x', estimateNanoUsd: 1 }), { status: 'completed' });
  let limited = true;
  const billing = Object.assign(new FakeBilling(new Map([['x', 3]])), { rateLimited: () => limited });
  const reconciler = new SpendReconciler(ledger, { now: () => clock });
  reconciler.attach(billing);
  clock = 10_000; await reconciler.tick();
  assert.equal(billing.calls.length, 0);
  limited = false; await reconciler.tick();
  assert.equal(billing.calls.length, 1);
});

class FakeReporting implements ReportingApi {
  public checks = 0;
  public summaries: Array<{ token: string; organizationId: string; apiKeyId: string; startTime: string; endTime: string }> = [];
  public constructor(public nano: number) {}
  public async checkApiKey() { this.checks += 1; return { organizationId: 'org-1', apiKeyId: 'key-1' }; }
  public async usageSummary(token: string, organizationId: string, query: { apiKeyId: string; startTime: string; endTime: string }) { this.summaries.push({ token, organizationId, ...query }); return this.nano; }
}

test('NEAR\'s usage summary is polled every minute while busy and every 5 minutes when idle, and labelled (NEAR)', async () => {
  let clock = Date.parse('2026-10-28T12:00:00Z');
  let active = true;
  const reporting = new FakeReporting(1_000_000_000);
  const usage = new NearUsageSummary({ now: () => clock, dayStart: () => dayStart(clock, 'utc'), token: async () => 'rpt-0123456789abcdef0123', active: () => active });
  usage.attach(reporting);
  await usage.tick();
  assert.equal(reporting.checks, 1);
  assert.deepEqual(reporting.summaries[0], { token: 'rpt-0123456789abcdef0123', organizationId: 'org-1', apiKeyId: 'key-1', startTime: '2026-10-28T00:00:00.000Z', endTime: '2026-10-28T12:00:00.000Z' });
  assert.equal(usage.today()?.nanoUsd, 1_000_000_000);
  clock += USAGE_POLL_ACTIVE_MS - 1; await usage.tick();
  assert.equal(reporting.summaries.length, 1);
  clock += 1; active = false; await usage.tick();
  assert.equal(reporting.summaries.length, 2);
  clock += USAGE_POLL_ACTIVE_MS; await usage.tick();
  assert.equal(reporting.summaries.length, 2, 'idle: every 5 minutes');
  clock += USAGE_POLL_IDLE_MS; await usage.tick();
  assert.equal(reporting.summaries.length, 3);
  assert.equal(reporting.checks, 1, 'check_api_key is asked once');
  const view = spendView({ confirmedNanoUsd: 300_000_000, pendingNanoUsd: 0, estimatedNanoUsd: 0, requests: 3, pendingRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, 'today', usage.today());
  assert.equal(view.text, '$1.00 today (NEAR)');
  assert.match(view.tooltip, /This computer: \$0\.30 confirmed/);
});

test('without a token the display says what is confirmed and what is pending', () => {
  const totals = { confirmedNanoUsd: 400_000_000, pendingNanoUsd: 20_000_000, estimatedNanoUsd: 0, requests: 5, pendingRequests: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  assert.equal(spendView(totals, 'today').text, '$0.40 confirmed + ~$0.02 pending today');
  assert.equal(spendView({ ...totals, pendingNanoUsd: 0, pendingRequests: 0 }, 'today').text, '$0.40 today (confirmed)');
  assert.equal(spendView({ ...totals, confirmedNanoUsd: 0 }, 'today').text, '~$0.02 pending today');
  assert.match(spendView(totals, 'today').tooltip, /Set a usage reporting token/);
});

test('the daily limit uses the larger of NEAR\'s total and this computer\'s ledger', async () => {
  const dir = await tempDir();
  const clock = Date.parse('2026-10-28T12:00:00Z');
  const reporting = new FakeReporting(1_200_000_000);
  let token: string | undefined = 'rpt-0123456789abcdef0123';
  const account = new SpendAccount('limit', { dir, now: () => clock, timers: false, dayBoundary: () => 'utc', dailyLimitUsd: () => 1, reportingToken: async () => token });
  account.attach({ ...new FakeBilling(new Map()), billingCosts: async () => ({ costs: new Map(), warning: false }), checkApiKey: () => reporting.checkApiKey(), usageSummary: (t, o, q) => reporting.usageSummary(t, o, q) });
  account.ledger.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 400_000_000 });
  assert.equal(account.limitReached(), undefined, 'this computer alone is under the limit');
  await account.usage.tick();
  assert.deepEqual(account.limitReached(), { spentUsd: 1.2, limitUsd: 1, source: 'near' }, 'other computers on the same key count');
  assert.equal(account.today().text, '$1.20 today (NEAR)');
  token = undefined;
  account.usage.reset();
  account.ledger.start({ path: '/chat/completions', status: 'completed', estimateNanoUsd: 700_000_000 });
  assert.deepEqual(account.limitReached(), { spentUsd: 1.1, limitUsd: 1, source: 'local' });
  assert.equal(nanoToUsd(totalNanoUsd(account.totals())), 1.1);
});
