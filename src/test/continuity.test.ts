import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextContinuity, contextLevel } from '../domain/continuity';

test('context thresholds classify remaining headroom before exhaustion', () => {
  const thresholds = { warningRemaining: 35, criticalRemaining: 25 };
  assert.equal(contextLevel(80, thresholds), 'normal');
  assert.equal(contextLevel(35, thresholds), 'warning');
  assert.equal(contextLevel(25, thresholds), 'critical');
});

test('continuity emits only level transitions', () => {
  const transitions: string[] = [];
  const monitor = new ContextContinuity({ warningRemaining: 35, criticalRemaining: 25 }, (level) => transitions.push(level));
  monitor.observe(34);
  monitor.observe(30);
  monitor.observe(20);
  monitor.observe(10);
  monitor.observe(40);
  assert.deepEqual(transitions, ['warning', 'critical', 'normal']);
});
