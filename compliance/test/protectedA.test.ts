import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { protectedAForTailoring } from '../src/import/itsp-10-033-01.ts';
import { validateOscal } from '../src/validate.ts';

const profile = JSON.parse(readFileSync(new URL('../profiles/protected-a.json', import.meta.url), 'utf8'));

test('Protected A imports the Medium profile with include-all and validates as OSCAL', () => {
  assert.equal(profile.profile.imports[0].href, 'itsp-10-033-01-medium.json');
  assert.deepEqual(profile.profile.imports[0]['include-all'], {});
  assert.deepEqual(validateOscal(profile, 'profile', { ours: true }), { ok: true, errors: [] });
});

test('Protected A contains no exclusion while reviewed tailoring has no removals', () => {
  assert.equal(profile.profile.modify, undefined);
  assert.deepEqual(protectedAForTailoring([]).profile.modify, undefined);
});

test('refuses a tailoring removal without a reviewer', () => {
  assert.throws(() => protectedAForTailoring([{ control: 'xa-01', reason: 'test only', reviewer: '', reviewedAt: '2026-11-21' }]), /reviewer/);
});
