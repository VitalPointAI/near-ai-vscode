import assert from 'node:assert/strict';
import test from 'node:test';
import { runningCost, summarizeAgentCounts, type ActivityEvent } from '../domain/activity';

test('agent activity produces transparent lifecycle counts', () => {
  const counts = summarizeAgentCounts([
    { id: 'a', sessionId: 's', timestamp: '', kind: 'agent', status: 'running', summary: 'planner' },
    { id: 'b', sessionId: 's', timestamp: '', kind: 'agent', status: 'waiting', summary: 'reviewer' },
    { id: 'c', sessionId: 's', timestamp: '', kind: 'agent', status: 'completed', summary: 'coder' },
    { id: 'd', sessionId: 's', timestamp: '', kind: 'agent', status: 'failed', summary: 'tester' },
    { id: 'e', sessionId: 's', timestamp: '', kind: 'agent', status: 'cancelled', summary: 'researcher' },
    { id: 'message', sessionId: 's', timestamp: '', kind: 'message', status: 'completed', summary: 'ignored' }
  ]);
  assert.deepEqual(counts, { deployed: 5, active: 1, waiting: 1, completed: 1, failed: 1, cancelled: 1 });
});

test('agents are counted once each, by their latest event, so a finished sub-agent is not still active', () => {
  // 0.4.19 review: each sub-agent records "running" and then "completed" or "failed", and both events were counted.
  const counts = summarizeAgentCounts([
    { id: '1', sessionId: 's', timestamp: '', kind: 'agent', status: 'running', agentId: 'a', summary: 'started' },
    { id: '2', sessionId: 's', timestamp: '', kind: 'agent', status: 'running', agentId: 'b', summary: 'started' },
    { id: '3', sessionId: 's', timestamp: '', kind: 'agent', status: 'completed', agentId: 'a', summary: 'done' },
    { id: '4', sessionId: 's', timestamp: '', kind: 'agent', status: 'running', agentId: 'c', summary: 'started' },
    { id: '5', sessionId: 's', timestamp: '', kind: 'agent', status: 'failed', agentId: 'c', summary: 'failed' }
  ]);
  assert.deepEqual(counts, { deployed: 3, active: 1, waiting: 0, completed: 1, failed: 1, cancelled: 0 });
});

test('a run\'s cost adds up its requests, counts a request once, and takes a reported total as a total', () => {
  const event = (requestId: string | undefined, estimatedCostUsd: number): ActivityEvent => ({ id: 'e', sessionId: 's', timestamp: '', kind: 'model', status: 'completed', summary: 'turn', requestId, estimatedCostUsd });
  let cost = runningCost(undefined, 0.1, 'req-1', [], 'estimatedCostUsd');
  const earlier = [event('req-1', 0.1)];
  cost = runningCost(cost, 0.2, 'req-2', earlier, 'estimatedCostUsd');
  earlier.push(event('req-2', 0.2));
  assert.ok(Math.abs((cost ?? 0) - 0.3) < 1e-9, 'two turns add up');
  // The same request recorded again (queued, then done) is not counted twice; a higher figure for it replaces the lower one.
  cost = runningCost(cost, 0.2, 'req-2', earlier, 'estimatedCostUsd');
  assert.ok(Math.abs((cost ?? 0) - 0.3) < 1e-9);
  cost = runningCost(cost, 0.25, 'req-2', earlier, 'estimatedCostUsd');
  assert.ok(Math.abs((cost ?? 0) - 0.35) < 1e-9);
  // A total without a request id (a sub-agent's, or the run's from the ledger) already includes the turns: it raises the cost, never adds to it.
  assert.ok(Math.abs((runningCost(cost, 0.2, undefined, earlier, 'estimatedCostUsd') ?? 0) - 0.35) < 1e-9);
  assert.equal(runningCost(cost, 0.5, undefined, earlier, 'estimatedCostUsd'), 0.5);
  assert.equal(runningCost(cost, undefined, 'req-3', earlier, 'estimatedCostUsd'), cost, 'no figure leaves the cost alone');
});
