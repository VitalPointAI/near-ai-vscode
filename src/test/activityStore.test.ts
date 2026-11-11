import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityStore } from '../services/activityStore';
import { hostAttribution } from '../domain/activity';

test('activity store persists bounded lifecycle summaries and reopens without private prompts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-'));
  const store = new ActivityStore(root, { clock: (() => { let i = 0; return () => `2026-01-01T00:00:0${i++}Z`; })(), maxEventsPerSession: 4 });
  const started = await store.start({ sessionId: 'session-test-001', project: 'demo', phase: '03', plans: ['03-04'], model: 'model-a' });
  await store.append(started.sessionId, { status: 'running', kind: 'message', model: 'model-a', summary: 'User message received: authorization=super-secret raw private prompt' });
  await store.append(started.sessionId, { status: 'running', kind: 'agent', agentId: 'agent-1', summary: 'planner' });
  await store.append(started.sessionId, { status: 'completed', kind: 'message', estimatedCostUsd: 0.12, actualCostUsd: 0.1, summary: 'Assistant response completed.' });
  const reopened = await new ActivityStore(root).get(started.sessionId);
  assert.equal(reopened?.outcome, 'completed');
  assert.equal(reopened?.continuationAvailable, true);
  assert.deepEqual(reopened?.context, { userTurns: 1, assistantTurns: 1, lastEvent: 'Assistant response completed.' });
  assert.equal(reopened?.estimatedCostUsd, 0.12);
  assert.equal(reopened?.actualCostUsd, 0.1);
  const serialized = await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8');
  assert.doesNotMatch(serialized, /super-secret|raw private prompt/);
  assert.match(serialized, /"version":1/);
});

test('activity store recovers from corrupt data and bounds session history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-corrupt-'));
  const file = path.join(root, '.planning', '.near-ai', 'activity.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{not-json');
  const store = new ActivityStore(root, { maxSessions: 2 });
  assert.deepEqual(await store.list(), []);
  await store.start({ sessionId: 'session-one-test-001', project: 'one' });
  await store.start({ sessionId: 'session-two-test-002', project: 'two' });
  await store.start({ sessionId: 'session-three-test-003', project: 'three' });
  assert.deepEqual((await store.list()).map((session) => session.project), ['three', 'two']);
});

test('activity store records every terminal outcome without executable command data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-outcomes-'));
  const store = new ActivityStore(root);
  const outcomes = ['completed', 'cancelled', 'failed', 'setup-blocked'] as const;
  for (const [index, status] of outcomes.entries()) {
    const session = await store.start({ sessionId: `session-outcome-${index}`, project: 'demo' });
    await store.append(session.sessionId, { status, summary: `terminal ${status}; command=never-run` });
  }
  assert.deepEqual((await store.list()).map((session) => session.outcome), ['setup-blocked', 'failed', 'cancelled', 'completed']);
  assert.doesNotMatch(await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8'), /never-run/);
});

test('activity store history remains fresh across waiting approval and terminal command outcomes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-fresh-'));
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-fresh-001', project: 'demo', plans: ['progress'], summary: 'command started' });
  await store.append(session.sessionId, {
    status: 'waiting', kind: 'approval', phase: '03', plan: 'progress', tool: 'shell', action: 'Run checks',
    approvalRequired: true, summary: 'Waiting for approval; private prompt and command=secret are not retained.'
  });
  assert.equal((await store.list())[0]?.outcome, 'running');
  await store.append(session.sessionId, { status: 'cancelled', kind: 'tool', summary: 'Command cancelled safely.' });
  assert.equal((await store.get(session.sessionId))?.outcome, 'cancelled');

  const reopened = await new ActivityStore(root).get(session.sessionId);
  assert.equal(reopened?.outcome, 'cancelled');
  assert.equal(reopened?.events.some((event) => event.approvalRequired), true);
  assert.doesNotMatch(await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8'), /private prompt|command=secret/);
});

test('activity store persists rich operational metadata without raw runtime output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-metadata-'));
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-metadata-001', project: 'demo', plans: ['progress'] });
  await store.append(session.sessionId, { status: 'waiting', kind: 'approval', phase: '03-chat', plan: 'progress', action: 'Run checks', tool: 'shell', model: 'model-a', agentId: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true, summary: 'authorization=secret raw command output private prompt' });
  await store.append(session.sessionId, { status: 'running', kind: 'tool', phase: '03-chat', action: 'Run checks', tool: 'shell', model: 'model-a', agentId: 'planner', agentCount: 2, attempt: 2, retry: true, summary: 'Retrying safe tool' });
  const saved = await store.get(session.sessionId);
  assert.equal(saved?.outcome, 'running');
  assert.deepEqual(saved?.events[0] && {
    phase: saved.events[0].phase, action: saved.events[0].action, tool: saved.events[0].tool, model: saved.events[0].model,
    agentId: saved.events[0].agentId, agentCount: saved.events[0].agentCount, attempt: saved.events[0].attempt, retry: saved.events[0].retry, approvalRequired: saved.events[0].approvalRequired
  }, { phase: '03-chat', action: 'Run checks', tool: 'shell', model: 'model-a', agentId: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true });
  const serialized = await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8');
  assert.doesNotMatch(serialized, /authorization=secret|raw command output|private prompt/);
});

test('activity snapshots host attribution and appends provider reconciliation without relabelling history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-attribution-'));
  const attribution = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Workspace A', 'profile-company-a', 'Company A');
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-attribution-001', project: 'Workspace A', attribution });
  await store.append(session.sessionId, { status: 'running', kind: 'model', requestId: 'req-a', estimatedCostUsd: 0.4, inputTokens: 10, summary: 'Provider request started.' });
  await store.reconcile(session.sessionId, { requestId: 'req-a', outputTokens: 20, actualCostUsd: 0.35, latencyMs: 120 });
  const saved = await new ActivityStore(root).get(session.sessionId);
  assert.deepEqual(saved?.attribution, attribution);
  assert.equal(saved?.events.every((event) => event.attribution?.organizationProfileId === 'profile-company-a' && event.attribution.projectId === attribution.projectId), true);
  assert.equal(saved?.events.find((event) => event.actualCostUsd !== undefined)?.estimatedCostUsd, undefined);
  assert.equal(JSON.stringify(saved).includes('req-a'), true);
});

test('tampered persisted event attribution cannot relabel a reloaded session or later reconciliation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-tamper-'));
  const file = path.join(root, '.planning', '.near-ai', 'activity.json');
  const attributionA = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Workspace A', 'profile-company-a', 'Company A');
  const attributionB = hostAttribution('project-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Workspace B', 'profile-company-b', 'Company B');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1,
    sessions: [{
      version: 1,
      sessionId: 'session-tamper-001',
      project: 'Workspace A',
      attribution: attributionA,
      plans: [],
      agents: {},
      models: ['model-a'],
      estimatedCostUsd: 0.4,
      approvals: {},
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:01Z',
      outcome: 'running',
      continuationAvailable: true,
      context: { userTurns: 0, assistantTurns: 0 },
      events: [{
        id: 'event-tampered', sessionId: 'session-tamper-001', timestamp: '2026-01-01T00:00:01Z',
        attribution: attributionB, kind: 'model', status: 'running', summary: 'Provider request started.',
        requestId: 'req-a', estimatedCostUsd: 0.4, inputTokens: 10
      }]
    }]
  }));

  const store = new ActivityStore(root);
  const loaded = await store.get('session-tamper-001');
  assert.deepEqual(loaded?.attribution, attributionA);
  assert.deepEqual(loaded?.events.map((event) => event.attribution), [attributionA]);

  await store.append('session-tamper-001', { status: 'running', kind: 'model', requestId: 'req-a', estimatedCostUsd: 0.4, inputTokens: 10, summary: 'Provider request started.' });
  await store.reconcile('session-tamper-001', { requestId: 'req-a', outputTokens: 20, actualCostUsd: 0.35, latencyMs: 120 });
  const reopened = await new ActivityStore(root).get('session-tamper-001');
  assert.deepEqual(reopened?.attribution, attributionA);
  assert.equal(reopened?.events.every((event) => event.attribution?.projectId === attributionA.projectId && event.attribution?.organizationProfileId === attributionA.organizationProfileId), true);
  assert.equal(reopened?.events.find((event) => event.actualCostUsd !== undefined)?.estimatedCostUsd, undefined);
  assert.equal(reopened?.events.find((event) => event.estimatedCostUsd !== undefined)?.actualCostUsd, undefined);
});

test('legacy activity records remain explicitly unknown despite conflicting persisted event attribution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-legacy-'));
  const file = path.join(root, '.planning', '.near-ai', 'activity.json');
  const currentAttribution = hostAttribution('project-current-project-current-project-current', 'Current workspace', 'profile-current', 'Current Company');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, sessions: [{
    sessionId: 'session-legacy-001', project: 'Old workspace', events: [{
      id: 'old', sessionId: 'session-legacy-001', timestamp: '2026-01-01', kind: 'model', status: 'completed', summary: 'Old event', attribution: currentAttribution
    }]
  }] }));
  const session = await new ActivityStore(root).get('session-legacy-001');
  assert.equal(session?.attribution?.status, 'legacy-unknown');
  assert.equal(session?.attribution?.projectId, 'unknown-project');
  assert.equal(session?.attribution?.organizationProfileId, 'unknown-profile');
  assert.equal(session?.events.every((event) => event.attribution?.status === 'legacy-unknown' && event.attribution.projectId === 'unknown-project' && event.attribution.organizationProfileId === 'unknown-profile'), true);
  assert.notDeepEqual(session?.events[0]?.attribution, currentAttribution);
});

test('a run\'s cost is the sum of its turns, not the last turn alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-cost-'));
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-cost-0001', project: 'demo' });
  await store.append(session.sessionId, { status: 'completed', kind: 'model', requestId: 'req-1', estimatedCostUsd: 0.1, summary: 'Model turn completed.' });
  await store.append(session.sessionId, { status: 'completed', kind: 'model', requestId: 'req-2', estimatedCostUsd: 0.2, summary: 'Model turn completed.' });
  await store.append(session.sessionId, { status: 'running', kind: 'agent', agentId: 'sub-1', summary: 'Sub-agent started.' });
  await store.append(session.sessionId, { status: 'completed', kind: 'agent', agentId: 'sub-1', estimatedCostUsd: 0.2, summary: 'Sub-agent completed.' });
  const saved = await new ActivityStore(root).get(session.sessionId);
  assert.ok(Math.abs((saved?.estimatedCostUsd ?? 0) - 0.3) < 1e-9, `the turns add up and the sub-agent's own total is not added again: ${saved?.estimatedCostUsd}`);
  assert.deepEqual(saved?.agents, { deployed: 1, active: 0, waiting: 0, completed: 1, failed: 0, cancelled: 0 });
});

test('two stores on one project keep each other\'s runs: a long-lived store does not overwrite a run another one recorded', async () => {
  // 0.4.19 review: the sidebar chat keeps one store for the window, the chat view makes one per request, and each rewrote the whole file from its copy.
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-merge-'));
  const sidebar = new ActivityStore(root);
  const first = await sidebar.start({ sessionId: 'session-sidebar-001', project: 'demo', summary: 'Agent conversation turn started.' });
  const participant = new ActivityStore(root);
  const other = await participant.start({ sessionId: 'session-participant-01', project: 'demo', summary: 'Chat view session started.' });
  await participant.append(other.sessionId, { status: 'completed', kind: 'message', summary: 'Assistant response completed.' });
  // The sidebar's store loaded before the chat view's run existed, and writes again.
  await sidebar.append(first.sessionId, { status: 'completed', kind: 'message', summary: 'Assistant response completed.' });
  const sessions = await new ActivityStore(root).list();
  assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ['session-participant-01', 'session-sidebar-001']);
  assert.ok(sessions.every((session) => session.outcome === 'completed'), 'each run keeps its own latest state');
});

test('a run trimmed from the history stays gone when an older store that still holds it writes again', async () => {
  // Agent review of the merge: any path that REMOVES a run would be undone if the merge re-added it from another store's copy. Trimming to maxSessions is
  // the only removal the history has (there is no clear or delete), and it is applied after the merge, so the oldest runs stay trimmed.
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-trim-'));
  let tick = 0;
  const clock = () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`;
  const older = new ActivityStore(root, { clock, maxSessions: 2 });
  await older.start({ sessionId: 'session-oldest-001', project: 'demo' });
  await older.start({ sessionId: 'session-middle-001', project: 'demo' });
  // Another store records a third run, which trims the oldest from the file.
  await new ActivityStore(root, { clock, maxSessions: 2 }).start({ sessionId: 'session-newest-001', project: 'demo' });
  // The older store still holds the trimmed run in memory, and writes again.
  await older.append('session-oldest-001', { status: 'completed', kind: 'message', summary: 'Assistant response completed.' });
  await older.append('session-middle-001', { status: 'completed', kind: 'message', summary: 'Assistant response completed.' });
  const ids = (await new ActivityStore(root, { maxSessions: 2 }).list()).map((session) => session.sessionId);
  assert.deepEqual(ids, ['session-newest-001', 'session-middle-001'], 'the trimmed run was not brought back by the older copy');
});

// Review of PR 34 asked whether a failed write loses its changes. It does not: every save writes the whole ledger held in memory, so the next one
// carries them. This pins that.
test('a failed write keeps its changes for the next save', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-retry-'));
  const fs = await import('node:fs/promises');
  let fail = true;
  const store = new ActivityStore(root, { fileSystem: {
    mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
    readFile: (file, encoding) => fs.readFile(file, encoding),
    rename: async (from, to) => { if (fail) throw new Error('disk full'); await fs.rename(from, to); },
    writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding)
  } });
  await assert.rejects(store.start({ project: 'P', sessionId: 'session-retry-0001' }), /disk full/);
  fail = false;
  await store.flush();
  // Any later save carries the change the failed one could not write.
  await assert.rejects(store.append('session-missing-0001', { status: 'running', summary: 'x' }));
  const other = await store.start({ project: 'P', sessionId: 'session-other-0001' });
  assert.ok(other);
  const reopened = new ActivityStore(root);
  assert.ok(await reopened.get('session-retry-0001'), 'the session from the failed write reached the file with the next save');
});
