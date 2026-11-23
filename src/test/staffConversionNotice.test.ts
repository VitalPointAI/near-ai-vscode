import assert from 'node:assert/strict';
import test from 'node:test';
import { conversionNoticeLines } from '../domain/staff/conversionNotice';

test('a full conversion adds no notice', () => {
  assert.deepEqual(conversionNoticeLines([], [], () => undefined), []);
});

test('withheld history is named for every product in order', () => {
  const lines = conversionNoticeLines([
    { product: 'route-plan', cell: 'public-id' },
    { product: 'annex', cell: 'public-id' }
  ], [], () => 'org/Public');
  const wayOut = 'Ask someone cleared for org/Public to make a single-machine copy and share it again.';
  assert.deepEqual(lines, [
    `Some history for annex was left out because it refers to a product with a higher label. ${wayOut}`,
    `Some history for route-plan was left out because it refers to a product with a higher label. ${wayOut}`
  ]);
});

test('unversioned products say what is present and why the versions are missing', () => {
  assert.deepEqual(conversionNoticeLines([], [{ product: 'annex' }], () => undefined), [
    'annex was brought in without its versions because it depends on a product with a higher label.'
  ]);
});

test('a missing label never exposes an internal part identifier', () => {
  const [line] = conversionNoticeLines([{ product: 'annex', cell: 'opaque-id' }], [], () => undefined);
  assert.match(line, /Ask someone cleared for the referenced product/);
  assert.doesNotMatch(line, /opaque-id|\bhub\b|\bcell\b|\u2014/);
});
