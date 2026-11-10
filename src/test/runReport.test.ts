import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ActivityEvent, ActivitySessionSummary } from '../domain/activity';
import { boundEvents, ActivityStore } from '../services/activityStore';
import { ActivityFeed } from '../services/agentActivity';
import { countersOf, runSplitOf } from '../services/activityOverview';
import { approvalTimeouts, formatRunReport, percentile, runPerformanceReport } from '../services/runReport';

// PERF-07: the activity history keeps a run's whole story (bounded by size, not 100 events), records cached tokens and where the time went, and the
// report reads it back.

test('a session keeps more than 100 events, bounded by bytes rather than a count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-perf07-'));
  const store = new ActivityStore(root);
  const { sessionId } = await store.start({ sessionId: 'session-perf07-many', project: 'demo' });
  for (let index = 0; index < 250; index += 1) await store.append(sessionId, { status: 'completed', kind: 'tool', tool: 'Bash', summary: `Tool call ${index} finished.` });
  const reopened = await new ActivityStore(root).get(sessionId);
  assert.equal(reopened?.events.length, 250, 'all 250 events survive a reload');

  const small = new ActivityStore(await mkdtemp(path.join(tmpdir(), 'near-ai-perf07-bytes-')), { maxEventBytesPerSession: 4_096 });
  const started = await small.start({ sessionId: 'session-perf07-bytes', project: 'demo' });
  for (let index = 0; index < 100; index += 1) await small.append(started.sessionId, { status: 'completed', kind: 'tool', summary: `Tool call ${index} finished.` });
  const bounded = await small.get(started.sessionId);
  const bytes = bounded!.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
  assert.ok(bytes <= 4_096, `events fit the byte bound (${bytes})`);
  assert.ok(bounded!.events.length > 3 && bounded!.events.length < 100, 'oldest events are dropped first');
  assert.match(bounded!.events.at(-1)!.summary, /Tool call 99/);
});

test('boundEvents keeps the newest event even when it alone is over the bound', () => {
  const big = { id: 'x', sessionId: 's', timestamp: '', kind: 'tool', status: 'completed', summary: 'y'.repeat(5_000) } as ActivityEvent;
  assert.equal(boundEvents([big, big], 5_000, 1_024).length, 1);
});

test('model events record cached tokens and sessions keep the run split across a reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-perf07-split-'));
  const store = new ActivityStore(root);
  const { sessionId } = await store.start({ sessionId: 'session-perf07-split', project: 'demo' });
  await store.append(sessionId, { status: 'completed', kind: 'model', summary: 'Model turn completed.', inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, durationMs: 4_000 });
  await store.addStats(sessionId, { cachedInputTokens: 800, approvalTimeouts: 2 });
  await store.setRunSplit(sessionId, { wallMs: 10_000, modelMs: 4_000, toolMs: 3_000, approvalWaitMs: 2_000, idleMs: 1_000, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 });
  const reopened = await new ActivityStore(root).get(sessionId);
  assert.equal(reopened?.events.at(-1)?.cachedInputTokens, 800);
  assert.equal(reopened?.stats?.cachedInputTokens, 800);
  assert.equal(reopened?.stats?.approvalTimeouts, 2);
  assert.deepEqual(reopened?.run, { wallMs: 10_000, modelMs: 4_000, toolMs: 3_000, approvalWaitMs: 2_000, idleMs: 1_000, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 });
  assert.match(await readFile(store.filePath, 'utf8'), /"run":\{"wallMs":10000/);
});

test('the run split of a main agent adds up to its wall time, with paused and background waits as idle', () => {
  let now = 0;
  const feed = new ActivityFeed({ maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 }, () => now);
  feed.agentStarted({ agentId: 'main-run-1', agent: 'agent', runId: 'run-1', model: 'm' });
  now = 1_000; feed.toolStarted('main-run-1', 'c1', 'Bash', '{}', 'Bash');
  now = 3_000; feed.approvalAsked('main-run-1');
  now = 5_000; feed.approvalSettled('main-run-1', 'allowed');
  now = 6_000; feed.toolEnded('main-run-1', 'c1', true, 'ok');
  now = 10_000; feed.turn('main-run-1', { verificationStatus: 'unknown', latencyMs: 4_000, firstTokenMs: 1_000, inputTokens: 100, outputTokens: 10, cachedInputTokens: 60 });
  feed.waitingForAgents('main-run-1', true);
  now = 13_000; feed.waitingForAgents('main-run-1', false);
  feed.approvalTimedOut('main-run-1');
  now = 14_000; feed.agentEnded('main-run-1', 'completed');
  const stat = feed.agentStat('main-run-1')!;
  const split = runSplitOf(stat, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }, now);
  assert.equal(split.wallMs, 14_000);
  assert.equal(split.modelMs + split.toolMs + split.approvalWaitMs + split.idleMs, split.wallMs);
  assert.equal(split.approvalWaitMs, 2_000);
  assert.equal(split.idleMs, 3_000, 'the background wait is idle');
  assert.equal(split.modelMs, 4_000);
  assert.equal(countersOf(stat, now).cachedInputTokens, 60);
  assert.equal(countersOf(stat, now).approvalTimeouts, 1);
});

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + seconds * 1000).toISOString();
const event = (seconds: number, fields: Partial<ActivityEvent>): ActivityEvent => ({ id: `e${seconds}`, sessionId: 'session-fixture-1', timestamp: at(seconds), kind: 'tool', status: 'running', summary: 'x', ...fields });

test('approval timeouts are found by duration in old logs and by the pending code in new ones', () => {
  const events = [
    event(0, { status: 'running' }), event(900, { status: 'failed', summary: 'Tool call failed or was declined.' }),
    event(901, { status: 'running' }), event(905, { status: 'failed', summary: 'Tool call failed or was declined.' }),
    event(906, { status: 'running' }), event(926, { status: 'failed', errorCode: 'approval-pending', summary: 'Tool call failed or was declined.' }),
    event(930, { status: 'running' }), event(1_830, { status: 'completed', summary: 'Tool call finished.' })
  ];
  assert.equal(approvalTimeouts(events), 2, 'a 900 s failure and a pending code count; a 4 s failure and a 900 s success do not');
});

test('the report prints the split, latency percentiles, token medians, cache share and stalls', () => {
  const model = (seconds: number, latency: number, input: number, cached: number): ActivityEvent => event(seconds, { kind: 'model', status: 'completed', summary: 'Model turn completed.', durationMs: latency, inputTokens: input, cachedInputTokens: cached, outputTokens: 300 });
  const session: ActivitySessionSummary = {
    version: 1, sessionId: 'session-fixture-1', project: 'demo', plans: [], agents: { deployed: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 }, models: ['m'],
    approvals: { required: 0, approved: 0, pending: 0 }, startedAt: at(0), updatedAt: at(3_600), endedAt: at(3_600), outcome: 'completed', continuationAvailable: true, context: { userTurns: 1, assistantTurns: 1 },
    events: [model(10, 10_000, 100_000, 0), model(20, 20_000, 200_000, 150_000), model(30, 120_000, 300_000, 250_000), event(40, {}), event(940, { status: 'failed', summary: 'Tool call failed or was declined.' })],
    run: { wallMs: 3_600_000, modelMs: 1_800_000, toolMs: 900_000, approvalWaitMs: 600_000, idleMs: 300_000, inputTokens: 600_000, cachedInputTokens: 400_000, outputTokens: 900 }
  };
  const report = runPerformanceReport({ sessions: [session] });
  assert.equal(report.model.latencyP50Ms, 20_000);
  assert.equal(report.model.latencyP90Ms, 120_000);
  assert.equal(report.model.inputMedian, 200_000);
  assert.equal(report.model.cacheHitCalls, 2);
  assert.equal(report.totals.approvalTimeouts, 1);
  assert.equal(report.totals.approvalWaitMs, 600_000);
  const text = formatRunReport(report);
  assert.match(text, /\| Model wait \| 30 min \| 50% \|/);
  assert.match(text, /\| Approval wait \| 10 min \| 17% \|/);
  assert.match(text, /of which cached 400,000 \(67%\)/);
  assert.equal(percentile([], 0.5), undefined);
});

test('a log without a recorded split is estimated to fit the wall time and labelled', () => {
  const session = { version: 1, sessionId: 'session-legacy-1', project: 'demo', plans: [], agents: {}, models: [], approvals: {}, startedAt: at(0), updatedAt: at(1_000), outcome: 'completed', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: [], stats: { agents: 3, generateMs: 1_000_000, nearWaitMs: 0, toolMs: 500_000, userWaitMs: 500_000, approvalsExpired: 4 } } as unknown as ActivitySessionSummary;
  const [run] = runPerformanceReport({ sessions: [session] }).runs;
  assert.equal(run.split, false);
  assert.ok(run.modelMs + run.toolMs + run.approvalWaitMs + run.idleMs <= run.wallMs + 2);
  assert.equal(run.approvalTimeouts, 4, 'expired approvals in the counters count when events were cut');
  assert.match(formatRunReport(runPerformanceReport({ sessions: [session] })), /\(est\.\)/);
});

// Agent review of PR 34: a burst of appends must not rewrite the whole ledger once per event, and nothing may be lost.
test('a burst of appends is coalesced into a few full writes, flush waits for all of them, and the file has a total bound', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-perf07-burst-'));
  const store = new ActivityStore(root);
  const { sessionId } = await store.start({ sessionId: 'session-perf07-burst', project: 'demo' });
  const before = store.writes;
  const appends = Array.from({ length: 50 }, (_, index) => store.append(sessionId, { status: 'completed', kind: 'tool', tool: 'Bash', summary: `Tool call ${index} finished.` }));
  await Promise.all(appends);
  assert.ok(store.writes - before <= 2, `50 appends in a burst cost ${store.writes - before} full writes`);
  assert.equal((await new ActivityStore(root).get(sessionId))?.events.length, 50, 'every event reached the file');

  for (let index = 0; index < 20; index += 1) void store.append(sessionId, { status: 'completed', kind: 'tool', summary: `Late ${index}.` });
  await store.flush();
  assert.equal((await new ActivityStore(root).get(sessionId))?.events.length, 70, 'flush waits for appends nobody awaited');

  const capped = new ActivityStore(await mkdtemp(path.join(tmpdir(), 'near-ai-perf07-cap-')), { maxFileBytes: 64 * 1024 });
  for (let session = 0; session < 4; session += 1) {
    const started = await capped.start({ sessionId: `session-perf07-cap-${session}`, project: 'demo' });
    await Promise.all(Array.from({ length: 200 }, (_, index) => capped.append(started.sessionId, { status: 'completed', kind: 'tool', summary: `Event ${index} ${'x'.repeat(100)}.` })));
  }
  await capped.flush();
  assert.ok((await readFile(capped.filePath, 'utf8')).length <= 64 * 1024, 'the whole file stays under its bound');
  assert.ok(((await new ActivityStore(path.dirname(path.dirname(path.dirname(capped.filePath)))).get('session-perf07-cap-3'))?.events.length ?? 0) > 0, 'the newest session keeps its events');
});
