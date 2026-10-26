import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAgentCounts } from '../domain/activity';

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
