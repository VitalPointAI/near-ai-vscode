// The Cursor on Target identity letters (doctrine.ts; note 11 [F1][F58]): one letter per standard identity, all different, so a CoT type string reads
// back to exactly the identity it was written from.
import assert from 'node:assert/strict';
import test from 'node:test';
import { COT_IDENTITY_CODES, STANDARD_IDENTITIES } from '../domain/staff/doctrine';

test('every standard identity has one CoT letter and no two share one', () => {
  assert.deepEqual(Object.keys(COT_IDENTITY_CODES).sort(), [...STANDARD_IDENTITIES].sort());
  const letters = Object.values(COT_IDENTITY_CODES);
  assert.equal(new Set(letters).size, letters.length);
  for (const letter of letters) assert.match(letter, /^[a-z]$/);
  assert.equal(COT_IDENTITY_CODES.hostile, 'h');
  assert.equal(COT_IDENTITY_CODES.friend, 'f');
  assert.equal(COT_IDENTITY_CODES.unknown, 'u');
});
