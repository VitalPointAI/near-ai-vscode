import assert from 'node:assert/strict';
import test from 'node:test';
import { motionPresentation } from '../domain/motion';

test('motion states provide accessible status copy without exposing reasoning', () => {
  assert.deepEqual(motionPresentation('reasoning'), { label: 'Reasoning', detail: 'Preparing a response.', live: 'polite' });
  assert.equal(motionPresentation('failure').live, 'assertive');
  assert.doesNotMatch(motionPresentation('reasoning').detail, /chain|thought|prompt/i);
});
