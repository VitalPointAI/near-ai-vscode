import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivitySessionSummary, emptyAgentCounts, emptySessionStats, SessionStats } from '../domain/activity';
import { buildWindowSummary, countersOf, historyPage, nowRows, OverviewSpend, runTitleFor, windowStart } from '../services/activityOverview';
import { ActivityStore } from '../services/activityStore';
import { ActivityFeed } from '../services/agentActivity';
import { emptyTotals, SpendFilter, SpendTotals } from '../services/spendLedger';

const HOUR = 3_600_000;
// 2026-03-10 15:00 UTC.
const NOW = Date.UTC(2026, 2, 10, 15, 0, 0);

function withVscodeStub<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode'
    ? { Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/'), toString() { return this.path; } }) }, workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }, window: {}, commands: {} }
    : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

const stats = (patch: Partial<SessionStats>): SessionStats => ({ ...emptySessionStats(), ...patch });

function session(id: string, startedAt: number, patch: Partial<ActivitySessionSummary> = {}): ActivitySessionSummary {
  return { version: 1, sessionId: `session-${id}-0000`, project: 'demo', plans: [], agents: emptyAgentCounts(), models: [], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt + 60_000).toISOString(), outcome: 'completed', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: [], runId: `run-${id}-abcdef`, ...patch };
}

/** A ledger stand-in: per-filter totals, with "today" reported by NEAR when asked. */
function fakeSpend(byFilter: (filter: SpendFilter) => Partial<SpendTotals>, near = false): OverviewSpend & { asked: SpendFilter[] } {
  const asked: SpendFilter[] = [];
  return {
    asked,
    totals: (filter = {}) => { asked.push(filter); return { ...emptyTotals(), ...byFilter(filter) }; },
    today: () => near ? { text: '$1.00 today (NEAR)', tooltip: 'NEAR', source: 'near', near: {} } : { text: '$0.40 confirmed + ~$0.02 pending today', tooltip: 'local', source: 'pending' },
    window: (window) => ({ text: window === 'conversation' ? '$0.10 this conversation (confirmed)' : '$2.00 confirmed', tooltip: 'x', source: 'confirmed' })
  };
}

const sessions = [
  session('a', NOW - 1 * HOUR, { conversationId: 'conv-current-1', title: 'Fix the login bug', stats: stats({ agents: 2, turns: 5, toolCalls: 4, toolErrors: 1, retries: 3, rateLimited: 2, generateMs: 4_000, toolMs: 6_000, userWaitMs: 2_000, nearWaitMs: 8_000, inputTokens: 1_000, outputTokens: 100, approvalsAutoAllowed: 3, approvalsAsked: 2, approvalsDeclined: 1, tools: { Bash: { calls: 3, errors: 1 }, Read: { calls: 1, errors: 0 } }, models: { 'z-ai/glm-5.3': { agents: 1, turns: 3, retries: 3, rateLimited: 2, errors: 0, stopped: 0, inputTokens: 700, outputTokens: 60 }, 'qwen/qwen3': { agents: 1, turns: 2, retries: 0, rateLimited: 0, errors: 0, stopped: 0, inputTokens: 300, outputTokens: 40 } } }) }),
  session('b', NOW - 2 * HOUR, { conversationId: 'conv-other-22', stats: stats({ agents: 1, turns: 1, errors: 1, approvalsExpired: 1, models: { 'z-ai/glm-5.3': { agents: 1, turns: 1, retries: 0, rateLimited: 0, errors: 1, stopped: 0, inputTokens: 10, outputTokens: 1 } } }), runOutcome: 'failed' }),
  session('c', NOW - 3 * 24 * HOUR, { conversationId: 'conv-old-333', stats: stats({ agents: 1, stopped: 1, models: { 'qwen/qwen3': { agents: 1, turns: 0, retries: 0, rateLimited: 0, errors: 0, stopped: 1, inputTokens: 0, outputTokens: 0 } } }), runOutcome: 'cancelled' }),
  session('d', NOW - 10 * 24 * HOUR, { stats: stats({ agents: 9 }) })
];

test('the overview sums runs, time, approvals, tools, and problems by model from persisted sessions', () => {
  const spend = fakeSpend((filter) => filter.since !== undefined ? { confirmedNanoUsd: 400_000_000, pendingNanoUsd: 20_000_000, requests: 6, pendingRequests: 1, inputTokens: 1_500, outputTokens: 150 } : {});
  const summary = buildWindowSummary({ sessions, live: [], spend, window: 'today', now: NOW, boundary: 'utc' });
  assert.equal(summary.runs, 2);
  assert.equal(summary.agents, 3);
  assert.deepEqual(summary.time, { generateMs: 4_000, toolMs: 6_000, userWaitMs: 2_000, nearWaitMs: 8_000 });
  assert.deepEqual(summary.approvals, { autoAllowed: 3, asked: 2, declined: 1, expired: 1 });
  assert.deepEqual(summary.tools, [{ name: 'Bash', calls: 3, errors: 1 }, { name: 'Read', calls: 1, errors: 0 }]);
  assert.deepEqual(summary.problems, { rateLimited: 2, retries: 3, errors: 1, stopped: 0, toolErrors: 1 });
  // The model NEAR refused most comes first, so capacity problems stand out.
  assert.deepEqual(summary.models.map((model) => [model.model, model.agents, model.rateLimited, model.retries, model.errors]), [['z-ai/glm-5.3', 2, 2, 3, 1], ['qwen/qwen3', 1, 0, 0, 0]]);
  // Tokens and cost come from the ledger (it sees safety checks and summaries too), split into confirmed and pending.
  assert.deepEqual(summary.tokens, { input: 1_500, output: 150, source: 'ledger' });
  assert.equal(summary.cost?.text, '$0.40 confirmed + ~$0.02 pending today');
  assert.ok(Math.abs(summary.cost!.confirmedUsd - 0.4) < 1e-9 && Math.abs(summary.cost!.pendingUsd - 0.02) < 1e-9);
  assert.equal(summary.cost?.near, false);
  // NEAR's own figure for today is labelled as NEAR's.
  const near = buildWindowSummary({ sessions, live: [], spend: fakeSpend(() => ({ requests: 1 }), true), window: 'today', now: NOW, boundary: 'utc' });
  assert.equal(near.cost?.near, true);
  assert.match(near.cost!.text, /\(NEAR\)/);
  // Without a ledger, tokens fall back to the activity history and cost is not claimed.
  const local = buildWindowSummary({ sessions, live: [], window: 'today', now: NOW, boundary: 'utc' });
  assert.deepEqual(local.tokens, { input: 1_000, output: 100, source: 'activity' });
  assert.equal(local.cost, undefined);
});

test('windows: this conversation, today by the local or UTC day, and the last 7 days', () => {
  const spend = fakeSpend(() => ({ requests: 1 }));
  const conversation = buildWindowSummary({ sessions, live: [], spend, window: 'conversation', now: NOW, boundary: 'utc', conversationId: 'conv-current-1' });
  assert.equal(conversation.runs, 1);
  assert.deepEqual(spend.asked.at(-1), { conversationId: 'conv-current-1' });
  assert.equal(conversation.cost?.text, '$0.10 this conversation (confirmed)');
  assert.equal(buildWindowSummary({ sessions, live: [], window: 'conversation', now: NOW, boundary: 'utc' }).empty, true, 'no conversation yet');
  assert.equal(buildWindowSummary({ sessions, live: [], window: 'week', now: NOW, boundary: 'utc' }).runs, 3, 'the 10-day-old run is outside');
  assert.equal(windowStart('today', NOW, 'utc'), Date.UTC(2026, 2, 10));
  assert.equal(windowStart('week', NOW, 'utc'), Date.UTC(2026, 2, 4));
  const localToday = new Date(NOW);
  assert.equal(windowStart('today', NOW, 'local'), new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate()).getTime());
  assert.equal(windowStart('week', NOW, 'local'), new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() - 6).getTime());
  assert.equal(windowStart('conversation', NOW, 'local'), undefined);
  // A run just after UTC midnight is "today" by UTC; by a local day it depends on the zone, but it is always within 7 days.
  const early = session('e', Date.UTC(2026, 2, 10, 0, 30));
  assert.equal(buildWindowSummary({ sessions: [early], live: [], window: 'today', now: NOW, boundary: 'utc' }).runs, 1);
  assert.equal(buildWindowSummary({ sessions: [session('f', Date.UTC(2026, 2, 9, 23, 30))], live: [], window: 'today', now: NOW, boundary: 'utc' }).runs, 0);
});

test('running agents count live until their counters are saved, then only once', () => {
  let now = NOW - 60_000;
  const feed = new ActivityFeed({ maxAgeMs: HOUR, maxBytes: 1 << 20 }, () => now);
  feed.agentStarted({ agentId: 'main-run-live-aaaaaa', agent: 'agent', runId: 'run-live-aaaaaa', model: 'z-ai/glm-5.3', conversationId: 'conv-current-1', boundary: 'tee' });
  feed.agentStarted({ agentId: 'gsd-planner-bbbbbb', agent: 'gsd-planner', runId: 'run-live-aaaaaa', model: 'z-ai/glm-5.3', parentId: 'main-run-live-aaaaaa', conversationId: 'conv-current-1', boundary: 'tee' });
  feed.toolStarted('gsd-planner-bbbbbb', 'c1', 'Bash npm test', '{"command":"npm test"}', 'Bash');
  now += 5_000;
  feed.approvalAsked('gsd-planner-bbbbbb');
  now += 10_000;
  feed.approvalSettled('gsd-planner-bbbbbb', 'declined');
  feed.toolEnded('gsd-planner-bbbbbb', 'c1', false, 'declined');
  feed.retry('main-run-live-aaaaaa', 'NEAR AI is busy.', { status: 429, delayMs: 30_000 });
  now = NOW;
  const live = feed.agentStats();
  const running = nowRows(live, fakeSpend((filter) => filter.agentId === 'gsd-planner-bbbbbb' ? { confirmedNanoUsd: 2_000_000, requests: 1 } : {}));
  assert.deepEqual(running.map((row) => [row.label, row.sub, row.phase, row.boundary, row.coolReason, row.costUsd]), [['agent', false, 'cooling-down', 'tee', 'rate-limited', undefined], ['gsd-planner', true, 'thinking', 'tee', undefined, 0.002]]);
  assert.equal(running[0].coolUntil, NOW - 45_000 + 30_000);
  const summary = buildWindowSummary({ sessions: [], live, window: 'conversation', now, boundary: 'utc', conversationId: 'conv-current-1' });
  assert.deepEqual([summary.runs, summary.agents, summary.problems.rateLimited, summary.approvals.asked, summary.approvals.declined, summary.time.userWaitMs], [1, 2, 1, 1, 1, 10_000]);
  assert.equal(summary.time.nearWaitMs, 45_000, 'the cooldown in progress counts as waiting on NEAR');
  // Once saved, the agent's counters come from its session, not again from the feed.
  const saved = session('live', NOW - 60_000, { runId: 'run-live-aaaaaa', conversationId: 'conv-current-1', stats: stats(countersOf(feed.agentStat('gsd-planner-bbbbbb')!, now) as SessionStats) });
  feed.agentEnded('gsd-planner-bbbbbb', 'completed');
  feed.markPersisted('gsd-planner-bbbbbb');
  const after = buildWindowSummary({ sessions: [saved], live: feed.agentStats(), window: 'conversation', now, boundary: 'utc', conversationId: 'conv-current-1' });
  assert.deepEqual([after.runs, after.agents, after.approvals.asked], [1, 2, 1]);
  assert.equal(feed.currentConversation, 'conv-current-1');
});

test('history pages newest first, with cost from the ledger, and each row opens its conversation', () => {
  const many = Array.from({ length: 32 }, (_, index) => session(`h${String(index).padStart(2, '0')}`, NOW - index * HOUR, { conversationId: `conv-history-${index}`, title: `Task ${index}`, endedAt: new Date(NOW - index * HOUR + 90_000).toISOString() }));
  const spend = fakeSpend((filter) => filter.runId === 'run-h00-abcdef' ? { confirmedNanoUsd: 1_000_000, pendingNanoUsd: 500_000, requests: 2, pendingRequests: 1 } : {});
  const first = historyPage(many, 0, spend, NOW);
  assert.deepEqual([first.page, first.pages, first.total, first.rows.length], [0, 3, 32, 15]);
  assert.deepEqual(first.rows.slice(0, 2).map((row) => [row.title, row.conversationId, row.durationMs, row.agents]), [['Task 0', 'conv-history-0', 90_000, 1], ['Task 1', 'conv-history-1', 90_000, 1]]);
  assert.equal(first.rows[0].costText, '$0.0015 (pending)');
  const last = historyPage(many, 2, spend, NOW);
  assert.deepEqual(last.rows.map((row) => row.title), ['Task 30', 'Task 31']);
  assert.equal(historyPage(many, 99, spend, NOW).page, 2, 'a page past the end shows the last');
  assert.equal(historyPage([session('x', NOW, { plans: ['gsd-progress'], runOutcome: 'max-turns' })], 0).rows[0].title, '/gsd-progress');
  assert.equal(historyPage([session('x', NOW, { runOutcome: 'max-turns' })], 0).rows[0].outcome, 'max-turns');
  const { parseActivityViewMessage } = withVscodeStub(() => require('../services/activityView') as typeof import('../services/activityView'));
  assert.deepEqual(parseActivityViewMessage({ type: 'open-conversation', conversationId: 'conv-history-3' }), { type: 'open-conversation', conversationId: 'conv-history-3' });
  assert.equal(parseActivityViewMessage({ type: 'open-conversation', conversationId: '../../etc' }), undefined);
  assert.deepEqual(parseActivityViewMessage({ type: 'history-page', page: 2 }), { type: 'history-page', page: 2 });
  assert.equal(parseActivityViewMessage({ type: 'history-page', page: -1 }), undefined);
  assert.deepEqual(parseActivityViewMessage({ type: 'set-window', window: 'week' }), { type: 'set-window', window: 'week' });
  assert.equal(parseActivityViewMessage({ type: 'set-window', window: 'year' }), undefined);
  assert.deepEqual(parseActivityViewMessage({ type: 'agent-control', agentId: 'gsd-planner-bbbbbb', action: 'pause' }), { type: 'agent-control', agentId: 'gsd-planner-bbbbbb', action: 'pause' });
  assert.equal(parseActivityViewMessage({ type: 'agent-control', agentId: 'x', action: 'pause' }), undefined);
});

test('open-activity for an agent focuses its row, or its run in history once it ended', () => {
  const { focusMessage } = withVscodeStub(() => require('../services/activityView') as typeof import('../services/activityView'));
  const feed = new ActivityFeed({ maxAgeMs: HOUR, maxBytes: 1 << 20 });
  feed.agentStarted({ agentId: 'gsd-planner-bbbbbb', agent: 'gsd-planner', runId: 'run-1-aaaaaa', model: 'm', parentId: 'main-run-1-aaaaaa' });
  assert.deepEqual(focusMessage(feed, 'gsd-planner-bbbbbb'), { type: 'focus-agent', agentId: 'gsd-planner-bbbbbb', runId: 'run-1-aaaaaa', running: true });
  feed.agentEnded('gsd-planner-bbbbbb', 'completed');
  assert.equal(focusMessage(feed, 'gsd-planner-bbbbbb').running, false);
  // After a reload the feed is empty; a main agent's ID still names its run.
  assert.deepEqual(focusMessage(new ActivityFeed({ maxAgeMs: HOUR, maxBytes: 1 << 20 }), 'main-run-9-cccccc'), { type: 'focus-agent', agentId: 'main-run-9-cccccc', runId: 'run-9-cccccc', running: false });
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'activity', 'activity.js'), 'utf8');
  assert.match(script, /message\.type === 'focus-agent'/);
  assert.match(script, /#now tr\[data-agent-id=/);
  assert.match(script, /#history tr\[data-run-id=/);
  assert.match(script, /classList\.add\('focused'\)[\s\S]*scrollIntoView/);
  assert.match(script, /type: 'show-in-chat'/);
});

test('the page has no raw event log: no stream, filters, or entry rendering; export is behind "Export details"', () => {
  const { activityHtml } = withVscodeStub(() => require('../services/activityView') as typeof import('../services/activityView'));
  const html = activityHtml({ asWebviewUri: (uri: unknown) => uri, cspSource: 'vscode-resource:' } as never, { path: '/media/activity', toString: () => '/media/activity' } as never);
  assert.doesNotMatch(html, /id="stream"|filter-agent|data-kind=|System prompts|Reasoning<|type="search"/);
  for (const id of ['now-heading', 'summary-heading', 'history-heading', 'export-details', 'export-usage']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /role="radiogroup" aria-label="Period"/);
  assert.match(html, /data-window="conversation"[\s\S]*data-window="today"[\s\S]*data-window="week"/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /data-format="markdown"[\s\S]*data-format="json"/);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'activity', 'activity.js'), 'utf8');
  assert.doesNotMatch(script, /'snapshot'|'entries'|innerHTML/);
  assert.match(script, /type: 'export', format: item\.dataset\.format/);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'activity', 'activity.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\s*;(?![^{]*var\()/i, 'colors come from theme variables (hex only as fallbacks)');
  assert.match(css, /@media \(max-width: 520px\)/);
});

test('export still writes every kept entry with the statistics', () => {
  const { activityMarkdown } = withVscodeStub(() => require('../services/activityView') as typeof import('../services/activityView'));
  const feed = new ActivityFeed({ maxAgeMs: HOUR, maxBytes: 1 << 20 });
  feed.agentStarted({ agentId: 'a', agent: 'agent', runId: 'r', model: 'm' }, 'Fix it');
  feed.toolStarted('a', 'c1', 'Bash npm test', '{}', 'Bash');
  feed.toolEnded('a', 'c1', true, 'ok');
  feed.agentEnded('a', 'completed');
  const markdown = activityMarkdown(feed.subscribe(() => undefined).snapshot, feed.agentStats());
  assert.match(markdown, /^# Agent activity/);
  assert.match(markdown, /\| agent \| m \| completed \|/);
  assert.match(markdown, /Fix it/);
  assert.match(markdown, /Bash npm test/);
});

test('session counters add up across agents, store instances, and reloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-overview-'));
  const first = new ActivityStore(root);
  const started = await first.start({ sessionId: 'session-sum-test-001', project: 'demo', runId: 'run-sum-abcdef', conversationId: 'conv-sum-12345', title: 'Ship it' });
  await first.addStats(started.sessionId, { agents: 1, rateLimited: 2, approvalsAsked: 1, tools: { Bash: { calls: 2, errors: 1 } }, models: { 'z-ai/glm-5.3': { agents: 1, turns: 2, retries: 2, rateLimited: 2, errors: 0, stopped: 0, inputTokens: 5, outputTokens: 1 } } });
  // Another instance (another window, or after a reload) adds to what is on disk.
  const second = new ActivityStore(root);
  await second.addStats(started.sessionId, { agents: 1, rateLimited: 1, approvalsExpired: 1, tools: { Bash: { calls: 1, errors: 0 }, Read: { calls: 4, errors: 0 } }, models: { 'z-ai/glm-5.3': { agents: 1, turns: 1, retries: 1, rateLimited: 1, errors: 1, stopped: 0, inputTokens: 2, outputTokens: 1 } } }, { outcome: 'completed' });
  const reread = (await new ActivityStore(root).get(started.sessionId))!;
  assert.deepEqual([reread.stats?.agents, reread.stats?.rateLimited, reread.stats?.approvalsAsked, reread.stats?.approvalsExpired], [2, 3, 1, 1]);
  assert.deepEqual(reread.stats?.tools, { Bash: { calls: 3, errors: 1 }, Read: { calls: 4, errors: 0 } });
  assert.deepEqual(reread.stats?.models['z-ai/glm-5.3'], { agents: 2, turns: 3, retries: 3, rateLimited: 3, errors: 1, stopped: 0, inputTokens: 7, outputTokens: 2 });
  assert.deepEqual([reread.runId, reread.conversationId, reread.title, reread.runOutcome], ['run-sum-abcdef', 'conv-sum-12345', 'Ship it', 'completed']);
  assert.ok(reread.endedAt);
  // A reader picks up what a writer added after it first loaded.
  const reader = new ActivityStore(root);
  await reader.list();
  await first.reload();
  await first.addStats(started.sessionId, { agents: 1 });
  await reader.reload();
  assert.equal((await reader.get(started.sessionId))?.stats?.agents, 3);
  // Junk on disk is dropped, not summed.
  const file = await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8');
  assert.doesNotMatch(file, /Fix the|prompt/);
});

test('run titles are the first line, redacted and truncated, and stay redacted on disk', async () => {
  assert.equal(runTitleFor('\n\n  Fix the cart  \nwith all the details below'), 'Fix the cart');
  const secret = runTitleFor('Use sk-abcdefghijklmnopqrstuvwxyz0123456789 and api_key=hunter2 to deploy');
  assert.doesNotMatch(secret!, /sk-abc|hunter2/);
  const long = runTitleFor('x'.repeat(200))!;
  assert.ok(long.length <= 80 && long.endsWith('…'), long);
  assert.equal(runTitleFor('   \n  '), undefined);
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-overview-title-'));
  const store = new ActivityStore(root);
  await store.start({ sessionId: 'session-title-test-001', project: 'demo', title: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB here' });
  assert.doesNotMatch(await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8'), /ghp_abcdefghij/);
});

test('the store keeps many runs for the overview but events only for the newest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-overview-bounds-'));
  const store = new ActivityStore(root, { maxSessions: 5, maxSessionsWithEvents: 2 });
  for (let index = 0; index < 6; index += 1) await store.start({ sessionId: `session-bound-test-${index}`, project: 'demo', summary: 'Agent conversation turn started.' });
  const listed = await new ActivityStore(root, { maxSessions: 5 }).list();
  assert.equal(listed.length, 5);
  assert.deepEqual(listed.map((item) => item.events.length), [1, 1, 0, 0, 0]);
});
