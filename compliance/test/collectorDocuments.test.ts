// Documents collector (44-07, D-09, D-23): every required document remains
// visible as evidence, with exact named headings and a current review where required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { documentsCollector, DOCUMENT_MAX_AGE_MS, LAST_REVIEWED_PATTERN, REQUIRED_DOCUMENTS, reviewedAt } from '../src/collectors/documents.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'documents');
const ROOT = '/fixture-checkout';
const NOW = new Date('2026-11-21T00:00:00.000Z');
const COMMIT = 'c'.repeat(40);

const fileAt = (document: string): string => path.join(ROOT, document);
async function fixture(name: string): Promise<string> { return readFile(path.join(FIXTURES, name), 'utf8'); }
function context(files: Readonly<Record<string, string>>): CollectorContext {
  return { now: NOW, commit: COMMIT, readFile: async (file) => {
    if (Object.hasOwn(files, file)) return files[file];
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  } };
}

test('a current reviewed SECURITY document with all required headings passes and uses its review date', async () => {
  const text = await fixture('SECURITY.md');
  const observations = await documentsCollector.collect({ repoRoot: ROOT }, context({ [fileAt('SECURITY.md')]: text }));
  assert.deepEqual(observations[0], { collector: 'documents', subject: 'SECURITY.md', passed: true, collectedAt: '2026-10-22T00:00:00.000Z', commit: COMMIT, counts: { missing: 0, missingHeadings: 0, missingReview: 0, staleReview: 0 } });
});

test('a review 366 days old fails, while a 365-day review is still a valid record for the freshness window', async () => {
  const base = await fixture('SECURITY.md');
  const stale = base.replace('2026-10-22', '2025-11-20');
  const edge = base.replace('2026-10-22', '2025-11-21');
  const [staleObservation] = await documentsCollector.collect({ repoRoot: ROOT }, context({ [fileAt('SECURITY.md')]: stale }));
  const [edgeObservation] = await documentsCollector.collect({ repoRoot: ROOT }, context({ [fileAt('SECURITY.md')]: edge }));
  assert.equal(staleObservation.passed, false);
  assert.deepEqual(staleObservation.counts, { missing: 0, missingHeadings: 0, missingReview: 0, staleReview: 1 });
  assert.equal(edgeObservation.passed, true);
  assert.equal(NOW.getTime() - new Date(edgeObservation.collectedAt).getTime(), DOCUMENT_MAX_AGE_MS);
});

test('a missing heading fails and counts the missing headings without copying document text', async () => {
  const withoutHeading = (await fixture('SECURITY.md')).replace('## Known limitations\n\nFixture limitations.\n\n', '');
  const [observation] = await documentsCollector.collect({ repoRoot: ROOT }, context({ [fileAt('SECURITY.md')]: withoutHeading }));
  assert.equal(observation.passed, false);
  assert.equal(observation.counts?.missingHeadings, 1);
  assert.doesNotMatch(JSON.stringify(observation), /Fixture limitations|Fixture reporting/);
});

test('a required file that is gone remains a failing observation rather than disappearing', async () => {
  const observations = await documentsCollector.collect({ repoRoot: ROOT }, context({}));
  assert.equal(observations.length, REQUIRED_DOCUMENTS.length);
  const security = observations.find((observation) => observation.subject === 'SECURITY.md');
  assert.deepEqual(security?.counts, { missing: 1, missingHeadings: 3 });
  assert.equal(security?.passed, false);
});

test('the review pattern only accepts valid calendar dates', () => {
  assert.equal(LAST_REVIEWED_PATTERN.test('Last reviewed: 2026-10-22'), true);
  assert.equal(reviewedAt('2026-10-22')?.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(reviewedAt('2026-02-30'), undefined);
});

test('the real repository gives an observation for every required document', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const observations = await documentsCollector.collect({ repoRoot }, { now: NOW, commit: COMMIT, readFile: (file) => readFile(file, 'utf8') });
  assert.deepEqual(observations.map((observation) => observation.subject), REQUIRED_DOCUMENTS.map((document) => document.path));
});
