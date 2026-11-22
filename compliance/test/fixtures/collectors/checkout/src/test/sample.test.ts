// Fixture for the tests collector (44-07). It stands in for a checkout's source test file: make-report.mjs copies it to dist/test/ and runs it
// through scripts/run-tests.mjs with NEAR_AI_TEST_REPORT set, so the committed reports have the reporter's real shape. It is outside the compliance
// test glob (test/*.test.ts) and never runs with the package tests: one test below fails on purpose. Plain JavaScript syntax only, so the copy
// runs as a .js file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

test('sample passes', () => {
  assert.equal(1 + 1, 2);
});

test('sample is skipped', { skip: 'fixture skip' }, () => {});

test('sample is still to do', { todo: true }, () => {});

describe('sample suite', () => {
  test('sample fails on purpose', () => {
    assert.equal(1 + 1, 3);
  });
});

// The name is in the source but the test is registered only when asked, so the report never holds it: the not-run case.
if (process.env.NEAR_AI_SAMPLE_EXTRA === '1') {
  test('sample runs only when asked', () => {});
}
