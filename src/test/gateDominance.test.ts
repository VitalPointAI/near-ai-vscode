// Clearance dominance and the mark join (CLAS-03, CLAS-04, D-28, D-29): the tracer cases on the default scale.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Clearance, Label } from '../domain/gate/labels';
import { dominates, raiseMark } from '../domain/gate/dominance';
import type { DominanceContext } from '../domain/gate/dominance';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const context: DominanceContext = { scales: SCALE_PRESETS, now: NOW };

function label(level: string): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [] };
}

function clearance(level: string): Clearance {
  return { scale: 'org', level, compartments: [], releasability: [] };
}

test('a clearance at a higher level dominates, and one level lower does not', () => {
  assert.equal(dominates(clearance('Restricted'), label('Confidential'), context), true);
  assert.equal(dominates(clearance('Confidential'), label('Confidential'), context), true);
  assert.equal(dominates(clearance('Internal'), label('Confidential'), context), false);
});

test('raising a mark only ever goes up', () => {
  const start = [label('Public')];
  const raised = raiseMark(start, label('Confidential'), SCALE_PRESETS);
  assert.deepEqual(raised.map((entry) => entry.level), ['Confidential']);
  const again = raiseMark(raised, label('Internal'), SCALE_PRESETS);
  assert.deepEqual(again.map((entry) => entry.level), ['Confidential']);
  assert.deepEqual(start.map((entry) => entry.level), ['Public']);
  assert.notEqual(raised, start);
});
