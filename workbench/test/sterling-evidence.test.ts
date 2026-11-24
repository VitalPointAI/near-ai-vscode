import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocumentationPages, refreshRecordMatches } from '../extension/src/common/sterling-evidence.ts';

const commit = 'a'.repeat(40);
const verified = { manifest: 'verified', source: 'release', commit, fetchedAt: '2026-11-24T00:00:00Z', attestation: 'verified' };

test('a verified refresh record for exactly the same commit vouches for the dashboard', () => {
  assert.equal(refreshRecordMatches(verified, commit), true);
  assert.equal(refreshRecordMatches({ ...verified, commit: commit.toUpperCase() }, commit), true);
});

test('missing, unverified, malformed or other-commit records never vouch', () => {
  assert.equal(refreshRecordMatches(undefined, commit), false, 'no refresh.json');
  assert.equal(refreshRecordMatches({ ...verified, manifest: 'not-checked' }, commit), false, 'manifest not verified');
  assert.equal(refreshRecordMatches({ ...verified, attestation: undefined }, commit), false, 'missing field');
  assert.equal(refreshRecordMatches({ ...verified, commit: 'b'.repeat(40) }, commit), false, 'another commit');
  // A shared prefix used to count as a match; two different commits can share one.
  assert.equal(refreshRecordMatches({ ...verified, commit: commit.slice(0, 7) }, commit), false, 'short prefix');
  assert.equal(refreshRecordMatches({ ...verified, commit: `${'a'.repeat(39)}b` }, commit), false, 'same prefix, other commit');
  assert.equal(refreshRecordMatches(verified, commit.slice(0, 7)), false, 'dashboard with a short commit');
  assert.equal(refreshRecordMatches([verified], commit), false, 'array');
});

test('the documentation collection must be a non-empty list of complete pages', () => {
  const page = { source: 'docs-site/content/index.md', route: 'index.md', category: 'Overview', title: 'Welcome', html: '<h1>Hi</h1>', text: 'Hi' };
  assert.equal(isDocumentationPages([page]), true);
  for (const bad of [[], {}, null, [{ ...page, title: undefined }], [page, 'x'], [{ ...page, html: 3 }], [{ ...page, text: undefined }]]) {
    assert.equal(isDocumentationPages(bad), false, JSON.stringify(bad));
  }
});
