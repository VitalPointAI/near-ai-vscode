import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewsCollector } from '../src/collectors/reviews.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

const commit = 'a'.repeat(40);
const head = 'b'.repeat(40);
const runUrl = 'https://github.com/acme/demo/actions/runs/42';
const login = 'near-ai-reviewer';
const input = { repository: 'acme/demo', since: '2026-11-01T00:00:00Z' };
const pr = { number: 12, base: { ref: 'main' }, merge_commit_sha: commit, merged_at: '2026-11-20T00:00:00Z', head: { sha: head } };
const status = { context: 'agent-review', state: 'success', creator: { login }, created_at: '2026-11-19T00:00:00Z' };
const review = { state: 'APPROVED', user: { login }, commit_id: head, submitted_at: '2026-11-19T00:00:00Z' };

interface Responses {
  readonly pulls?: readonly unknown[];
  readonly statuses?: unknown;
  readonly reviews?: unknown;
  readonly secondPage?: boolean;
}

function context({ pulls = [pr], statuses = [status], reviews = [review], secondPage = false }: Responses = {}): CollectorContext {
  return {
    now: new Date('2026-11-21T00:00:00Z'),
    commit,
    runUrl,
    readFile: async () => '',
    fetchJson: async (url) => {
      const { pathname, searchParams } = new URL(url);
      const page = searchParams.get('page');
      assert.equal(searchParams.get('per_page'), '100');
      if (pathname === '/repos/acme/demo/pulls') {
        assert.equal(searchParams.get('state'), 'closed');
        assert.equal(searchParams.get('base'), 'main');
        if (secondPage && page === '1') return Array(100).fill({ ...pr, merged_at: null });
        return pulls;
      }
      if (pathname === `/repos/acme/demo/commits/${head}/statuses`) {
        if (secondPage && page === '1') return Array(100).fill({ context: 'ci' });
        return statuses;
      }
      assert.match(pathname, /^\/repos\/acme\/demo\/pulls\/\d+\/reviews$/);
      if (secondPage && page === '1') return Array(100).fill({ state: 'COMMENTED' });
      return reviews;
    },
  };
}

async function collect(responses?: Responses) {
  return Object.fromEntries((await reviewsCollector.collect(input, context(responses))).map((row) => [row.subject, row]));
}

test('a trusted status and active approval of the head corroborate the exact main merge only', async () => {
  const rows = await collect();
  assert.equal(rows['agent-review'].passed, true);
  assert.equal(rows['assessed-commit-agent-review'].passed, true);
  assert.equal(rows['assessed-commit-agent-review'].commit, commit);
  assert.equal(rows['assessed-commit-agent-review'].runUrl, runUrl);
  assert.equal(rows['gate-approvals'].passed, false);
  assert.equal(rows['publish-approvals'].passed, false);
  assert.ok(!JSON.stringify(rows).includes(login));
});

test('an unrelated merge can corroborate the general review trail only', async () => {
  const rows = await collect({ pulls: [{ ...pr, merge_commit_sha: 'c'.repeat(40) }] });
  assert.equal(rows['agent-review'].passed, true);
  assert.equal(rows['assessed-commit-agent-review'].passed, false);
});

test('empty, unmerged, non-main, or ambiguous histories cannot establish an assessed review', async () => {
  for (const pulls of [[], [{ ...pr, merged_at: null }], [{ ...pr, base: { ref: 'dev' } }], [pr, { ...pr, number: 13 }]]) {
    const rows = await collect({ pulls });
    assert.equal(rows['assessed-commit-agent-review'].passed, false);
    if (pulls.length < 2) assert.equal(rows['agent-review'].passed, false);
  }
});

test('missing, late, stale, dismissed, and superseded approvals fail for the assessed merge', async () => {
  for (const reviews of [
    [],
    [{ ...review, submitted_at: '2026-11-20T01:00:00Z' }],
    [{ ...review, commit_id: 'd'.repeat(40) }],
    [{ ...review, state: 'DISMISSED' }],
    [review, { ...review, state: 'CHANGES_REQUESTED' }],
    [{ ...review, user: { login: 'another-user' } }],
  ]) {
    const rows = await collect({ reviews });
    assert.equal(rows['assessed-commit-agent-review'].passed, false);
    assert.equal(rows['agent-review'].counts?.['pr-12'], 1);
  }
});

test('missing, late, spoofed, malformed, and superseded statuses fail for the assessed merge', async () => {
  for (const statuses of [
    [],
    [{ ...status, created_at: '2026-11-20T01:00:00Z' }],
    [{ ...status, creator: { login: 'another-user' } }, status],
    [{ ...status, created_at: '2026' }],
    [{ ...status, state: 'pending', created_at: '2026-11-19T01:00:00Z' }, status],
  ]) {
    const rows = await collect({ statuses });
    assert.equal(rows['assessed-commit-agent-review'].passed, false);
  }
});

test('a comment or post-merge change request does not replace the approval effective at merge', async () => {
  const rows = await collect({
    reviews: [review, { ...review, state: 'COMMENTED' }, { ...review, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-20T01:00:00Z' }],
    statuses: [{ ...status, state: 'pending', created_at: '2026-11-20T01:00:00Z' }, status],
  });
  assert.equal(rows['assessed-commit-agent-review'].passed, true);
});

test('the exact assessed merge can be verified outside the recent review sample', async () => {
  const rows = await collect({
    pulls: [{ ...pr, merged_at: '2026-10-20T00:00:00Z' }],
    statuses: [{ ...status, created_at: '2026-10-19T00:00:00Z' }],
    reviews: [{ ...review, submitted_at: '2026-10-19T00:00:00Z' }],
  });
  assert.equal(rows['agent-review'].passed, false);
  assert.equal(rows['assessed-commit-agent-review'].passed, true);
});

test('paginated merge, status, and review evidence can corroborate the assessed review', async () => {
  const rows = await collect({ secondPage: true });
  assert.equal(rows['assessed-commit-agent-review'].passed, true);
});

test('malformed response lists and incomplete merged PRs fail closed', async () => {
  await assert.rejects(collect({ statuses: {} }), { code: 'unexpected-response' });
  await assert.rejects(collect({ reviews: null }), { code: 'unexpected-response' });
  await assert.rejects(collect({ pulls: [{ ...pr, merge_commit_sha: null }] }), { code: 'unexpected-response' });
});

test('invalid since is refused', async () => {
  await assert.rejects(reviewsCollector.collect({ ...input, since: 'bad' }, context()), { code: 'invalid-input' });
});

test('collector has the settings freshness window', () => assert.equal(reviewsCollector.window, 'settings'));
