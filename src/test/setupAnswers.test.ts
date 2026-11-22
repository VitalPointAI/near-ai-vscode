import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentWorkDefault, AGENT_WORK_ANSWERS } from '../domain/setup/answers';
import { useFor } from '../domain/setup/map';
import * as words from '../domain/setup/words';
import { countHits } from './helpers/copyLintScan';

test('GUIDE-01: Q4 determines the use and Q1 supplies its default', () => {
  assert.deepEqual(AGENT_WORK_ANSWERS.map((agentWork) => useFor({ data: ['public'], agentWork })), ['T2', 'T1', 'T2']);
  for (const [kindOfWork, answer] of [
    ['software', 'agents'], ['analysis', 'answers-only'], ['writing', 'answers-only'], ['staff', 'not-sure'],
  ] as const) {
    assert.equal(agentWorkDefault(kindOfWork), answer);
  }
});

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

test('D-32, D-43: guide copy uses plain words and leaves a slot for the contact', () => {
  const text = Object.entries(words).filter(([name]) => name.endsWith('_TEXT')).flatMap(([, value]) => strings(value));
  for (const sentence of text) assert.doesNotMatch(sentence, /\b[a-z][a-z\d-]*\/[A-Z]/);
  assert.deepEqual(countHits(text.map((entry) => ({ text: entry })), 'src/domain/setup/words.ts'), {});
  assert.match(words.STOP_CLASSIFIED_TEXT, /\{contact\}/);
});
