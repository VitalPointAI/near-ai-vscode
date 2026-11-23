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
const gatePath = '/environments/agent-review-gates';
const runsPath = '/actions/workflows/agent-review.yml/runs';
const gateRun = {
  id: 91, run_attempt: 1, path: '.github/workflows/agent-review.yml@main', event: 'workflow_run', head_branch: 'main',
  created_at: '2026-11-18T00:00:00Z', status: 'completed', conclusion: 'success',
  repository: { id: 321, full_name: 'acme/demo' }, head_repository: { id: 321, full_name: 'acme/demo' },
};
const exactRun = '/actions/runs/91';
const jobsPath = `${exactRun}/attempts/1/jobs`;
const approvalsPath = `${exactRun}/approvals`;
const gateJob = {
  name: `owner approval (gate change) PR #12 @ ${head}`, run_id: 91, status: 'completed',
  conclusion: 'success', completed_at: '2026-11-19T00:00:00Z',
};
const gateEnvironment = { name: 'agent-review-gates', id: 711 };
const reviewer = { type: 'User', reviewer: { id: 874, login: 'configured-reviewer-secret' } };
const environment = {
  ...gateEnvironment, can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', reviewers: [reviewer] }],
};
const decision = { state: 'approved', environments: [gateEnvironment], user: reviewer.reviewer, comment: 'approval-body-secret' };
const verifiedGate = {
  [gatePath]: environment,
  [runsPath]: { total_count: 1, workflow_runs: [gateRun] },
  [exactRun]: gateRun,
  [jobsPath]: { total_count: 1, jobs: [gateJob] },
  [approvalsPath]: [decision],
};

interface Responses {
  readonly pulls?: readonly unknown[];
  readonly statuses?: unknown;
  readonly reviews?: unknown;
  readonly secondPage?: boolean;
  readonly gate?: Readonly<Record<string, unknown>>;
  readonly requests?: URL[];
}

function context({ pulls = [pr], statuses = [status], reviews = [review], secondPage = false, gate, requests }: Responses = {}): CollectorContext {
  return {
    now: new Date('2026-11-21T00:00:00Z'),
    commit,
    runUrl,
    readFile: async () => '',
    fetchJson: async (url) => {
      const parsed = new URL(url);
      requests?.push(parsed);
      const { pathname, searchParams } = parsed;
      const endpoint = pathname.slice('/repos/acme/demo'.length);
      if (endpoint.startsWith('/actions/') || endpoint.startsWith('/environments/')) {
        const response = gate?.[endpoint];
        if (response instanceof Error) throw response;
        return response;
      }
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

test('the environment decision is tied to the assessed merge, exact protected job and current configured reviewer', async () => {
  const requests: URL[] = [];
  const rows = await collect({ gate: verifiedGate, requests });
  assert.equal(rows['gate-approvals'].passed, true);
  assert.equal(rows['gate-approvals'].runUrl, runUrl);
  assert.deepEqual(rows['gate-approvals'].counts, { 'approving-run': 91 });
  assert.equal(rows['publish-approvals'].passed, false);
  assert.doesNotMatch(JSON.stringify(rows), /approval-body-secret|configured-reviewer-secret|874|711/);
  const lookup = requests.find((url) => url.pathname.endsWith(runsPath));
  assert.equal(lookup?.searchParams.get('branch'), 'main');
  assert.equal(lookup?.searchParams.get('created'), '2026-11-13T00:00:00.000Z..2026-11-20T00:00:00.000Z');
  assert.equal(lookup?.searchParams.get('per_page'), '30');
});

test('gate jobs from the wrong scope, ambiguous runs, late or stale heads, and reruns stay unverified', async () => {
  const duplicate = { ...gateRun, id: 92 };
  for (const gate of [
    { [runsPath]: { total_count: 2, workflow_runs: [gateRun] } },
    ...[
      { ...gateRun, head_repository: { id: 99, full_name: 'fork/demo' } },
      { ...gateRun, head_branch: 'feature', event: 'workflow_dispatch' },
      { ...gateRun, path: '.github/workflows/other.yml@main' },
      { ...gateRun, run_attempt: 2 },
    ].map((run) => ({ [runsPath]: { total_count: 1, workflow_runs: [run] } })),
    {
      [runsPath]: { total_count: 2, workflow_runs: [gateRun, duplicate] },
      '/actions/runs/92/attempts/1/jobs': { total_count: 1, jobs: [{ ...gateJob, run_id: 92 }] },
    },
    { [jobsPath]: { total_count: 2, jobs: [gateJob, gateJob] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...gateJob, completed_at: '2026-11-20T01:00:00Z' }] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...gateJob, name: 'owner approval (gate change)' }] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...gateJob, name: `owner approval (gate change) PR #12 @ ${commit}` }] } },
    { [exactRun]: { ...gateRun, run_attempt: 2 } },
  ]) {
    const rows = await collect({ gate: { ...verifiedGate, ...gate } });
    assert.equal(rows['assessed-commit-agent-review'].passed, true);
    assert.equal(rows['gate-approvals'].passed, false);
    assert.deepEqual(rows['gate-approvals'].counts, { unverified: 1 });
  }
});

test('unavailable Actions access, unsafe settings and uncorroborated decisions preserve independent review evidence', async () => {
  for (const gate of [
    { [gatePath]: Object.assign(new Error('raw response'), { status: 403 }) },
    { [gatePath]: { ...environment, can_admins_bypass: true } },
    { [gatePath]: { ...environment, can_admins_bypass: undefined } },
    ...[[reviewer, reviewer], [{ ...reviewer, type: 'Team' }]].map((reviewers) => ({
      [gatePath]: { ...environment, protection_rules: [{ type: 'required_reviewers', reviewers }] },
    })),
    { [approvalsPath]: [] },
    { [approvalsPath]: [{ ...decision, state: 'rejected' }] },
    { [approvalsPath]: [{ ...decision, user: { id: 875 } }] },
    { [approvalsPath]: [{ ...decision, environments: [{ ...gateEnvironment, id: 712 }] }] },
    { [approvalsPath]: [decision, decision] },
    { [approvalsPath]: { approvals: [decision] } },
  ]) {
    const rows = await collect({ gate: { ...verifiedGate, ...gate } });
    assert.equal(rows['assessed-commit-agent-review'].passed, true);
    assert.equal(rows['gate-approvals'].passed, false);
  }
});

test('owner approval is never looked up without independently verified review of the exact merge', async () => {
  const requests: URL[] = [];
  const rows = await collect({ reviews: [], gate: verifiedGate, requests });
  assert.equal(rows['gate-approvals'].passed, false);
  assert.equal(requests.some((url) => url.pathname.endsWith(gatePath)), false);
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
