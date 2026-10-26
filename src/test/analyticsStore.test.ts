import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalyticsStore } from '../services/analyticsStore';
import { buildFleetView } from '../services/fleetView';
import { hostAttribution } from '../domain/activity';

const activity = { sessions: [{ sessionId: 'session-analytics-001', project: 'demo', phase: '04', events: [
  { id: 'e1', sessionId: 'session-analytics-001', timestamp: '2026-01-01T00:00:00.000Z', kind: 'agent' as const, status: 'running' as const, summary: 'Agent deployed', agentId: 'agent-1', agentRole: 'implementer', action: 'Implement analytics', model: 'model-a', route: 'local/model-a', inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.1, approvalRequired: false },
  { id: 'e2', sessionId: 'session-analytics-001', timestamp: '2026-01-01T00:00:01.000Z', kind: 'agent' as const, status: 'completed' as const, summary: 'Agent completed', agentId: 'agent-1', agentRole: 'implementer', action: 'Implement analytics', model: 'model-a', route: 'local/model-a', inputTokens: 5, outputTokens: 7, actualCostUsd: 0.08, durationMs: 1000, approvalRequired: true }
] }] };

test('analytics projects durable agent lifecycle into fleet, timeline, cost, latency, and filters', async () => {
  const store = new AnalyticsStore(activity);
  const result = await store.query({ role: 'implementer' });
  assert.deepEqual(result.fleet.counts, { deployed: 1, active: 0, waiting: 0, completed: 1, failed: 0, cancelled: 0 });
  assert.equal(result.agents[0]?.route, 'local/model-a');
  assert.equal(result.cost.inputTokens, 15);
  assert.equal(result.cost.outputTokens, 27);
  assert.equal(result.latency.p95Ms, 1000);
  assert.equal(result.models['model-a'], 2);
  assert.equal(result.timeline.length, 2);
});

test('analytics export is bounded and excludes prompt or credential-shaped content', async () => {
  const store = new AnalyticsStore({ sessions: [{ ...activity.sessions[0], events: [{ ...activity.sessions[0].events[0], summary: 'private prompt authorization=super-secret' }] }] });
  const exported = await store.export();
  assert.doesNotMatch(exported, /private prompt|super-secret|authorization=/i);
  assert.doesNotMatch(exported, /events\s*:/i);
});

test('fleet view keeps operational facts in quiet mode while changing presentation copy', () => {
  const snapshot = { counts: { deployed: 1, active: 0, waiting: 0, completed: 1, failed: 0, cancelled: 0 }, agents: [{ agentId: 'agent-1', role: 'reviewer', task: 'Review', status: 'completed' as const, tokens: 3, estimatedCostUsd: 0, actualCostUsd: 0, approvalRequired: false, updatedAt: '2026-01-01' }], timeline: [], cost: { requests: 1, inputTokens: 1, outputTokens: 2, estimatedUsd: 0, actualUsd: 0, cacheHits: 0 }, latency: { count: 0, totalMs: 0 }, models: {}, reputation: [] };
  const view = buildFleetView(snapshot, true);
  assert.equal(view.quiet, true);
  assert.match(view.agents[0].label, /reviewer.*completed/);
  assert.equal(view.counts.failed, 0);
});

test('analytics snapshots organization and project attribution, preserves estimate versus actual, and isolates profile switches', async () => {
  const orgA = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Workspace A', 'profile-company-a', 'Company A');
  const orgB = hostAttribution('project-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Workspace B', 'profile-company-b', 'Company B');
  const source = { sessions: [
    { sessionId: 'session-attribution-a', project: 'Workspace A', attribution: orgA, phase: '05', events: [
      { id: 'a-start', sessionId: 'session-attribution-a', timestamp: '2026-01-01T00:00:00.000Z', attribution: orgA, kind: 'model' as const, status: 'running' as const, summary: 'Provider request started.', requestId: 'req-a', model: 'model-a', inputTokens: 10, estimatedCostUsd: 0.4 },
      { id: 'a-done', sessionId: 'session-attribution-a', timestamp: '2026-01-01T00:00:01.000Z', attribution: orgA, kind: 'model' as const, status: 'completed' as const, summary: 'Assistant response completed.', requestId: 'req-a', model: 'model-a', outputTokens: 20, actualCostUsd: 0.35 }
    ] },
    { sessionId: 'session-attribution-b', project: 'Workspace B', attribution: orgB, phase: '05', events: [
      { id: 'b-done', sessionId: 'session-attribution-b', timestamp: '2026-01-01T00:00:02.000Z', attribution: orgB, kind: 'model' as const, status: 'completed' as const, summary: 'Assistant response completed.', requestId: 'req-b', inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.2, actualCostUsd: 0.18 }
    ] },
    { sessionId: 'session-attribution-legacy', project: 'Old workspace', phase: '04', events: [
      { id: 'legacy', sessionId: 'session-attribution-legacy', timestamp: '2026-01-01T00:00:03.000Z', kind: 'model' as const, status: 'completed' as const, summary: 'Legacy request' }
    ] }
  ] };
  const store = new AnalyticsStore(source);
  const onlyA = await store.query({ organizationProfileId: orgA.organizationProfileId, projectId: orgA.projectId });
  assert.equal(onlyA.timeline.every((event) => event.organizationProfileId === orgA.organizationProfileId && event.projectId === orgA.projectId), true);
  assert.equal(onlyA.cost.estimatedUsd, 0.4);
  assert.equal(onlyA.cost.actualUsd, 0.35);
  assert.equal(onlyA.cost.groups?.[0]?.attribution.projectLabel, 'Workspace A');
  assert.equal(onlyA.cost.requests, 1);
  const all = await store.query();
  assert.equal(all.cost.groups?.length, 3);
  assert.equal(all.timeline.some((event) => event.attributionStatus === 'legacy-unknown'), true);
  assert.equal((await store.query({ organizationProfileId: orgB.organizationProfileId })).cost.actualUsd, 0.18);
  const exported = await store.export({ organizationProfileId: orgA.organizationProfileId });
  assert.match(exported, /Company A|Workspace A/);
  assert.doesNotMatch(exported, /api[_ -]?key|refresh[-_ ]?token|private prompt|raw context|command\s*[:=]|req-b/gi);
});

test('analytics rejects forged filter values and leaves provider values unavailable when absent', async () => {
  const store = new AnalyticsStore({ sessions: [{ sessionId: 'session-legacy-unknown', project: 'Legacy', events: [{ id: 'legacy-only', sessionId: 'session-legacy-unknown', timestamp: '2026-01-01T00:00:00.000Z', kind: 'model', status: 'completed', summary: 'No provider usage' }] }] });
  const forged = await store.query({ organizationProfileId: 'profile-company-a', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ...( { actualUsd: 999, organizationDisplayName: 'apiKey=secret' } as unknown as object) });
  assert.equal(forged.totalEvents, 0);
  const legacy = await store.query();
  assert.equal(legacy.timeline[0]?.attributionStatus, 'legacy-unknown');
  assert.equal(legacy.cost.estimatedUsd, undefined);
  assert.equal(legacy.cost.actualUsd, undefined);
});
