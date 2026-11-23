import type { Observation } from '../model.ts';
import type { Collector, CollectorContext, FetchJson } from './types.ts';
import { asObject, checkRepository, collectorError, COMMIT_SHA, githubList, requireFetch } from './github.ts';

const SOURCE = 'review-trail';
// Mirrors scripts/lib/workflow.mjs REVIEW_ACCOUNT.
const REVIEW_ACCOUNT = 'near-ai-reviewer';
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const pullRequests = { collector: SOURCE, permission: 'Pull requests read' };
const commitStatuses = { collector: SOURCE, permission: 'Commit statuses read' };

export interface ReviewsInput {
  readonly repository: string;
  readonly since: string;
}

interface MergedPullRequest {
  readonly number: number;
  readonly head: string;
  readonly mergeCommit: string;
  readonly mergedAt: number;
}

function githubTimestamp(value: unknown): number {
  return typeof value === 'string' && GITHUB_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
}

function mergedMainPulls(rows: readonly unknown[], now: number): MergedPullRequest[] {
  const merged: MergedPullRequest[] = [];
  const numbers = new Set<number>();
  for (const row of rows) {
    const pr = asObject(row);
    const base = asObject(pr?.base)?.ref;
    if (pr && typeof base === 'string' && (base !== 'main' || pr.merged_at === null)) continue;

    const number = pr?.number;
    const head = asObject(pr?.head)?.sha;
    const mergeCommit = pr?.merge_commit_sha;
    const mergedAt = githubTimestamp(pr?.merged_at);
    if (
      base !== 'main' || typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0 || numbers.has(number)
      || typeof head !== 'string' || !COMMIT_SHA.test(head) || typeof mergeCommit !== 'string' || !COMMIT_SHA.test(mergeCommit)
      || !Number.isFinite(mergedAt) || mergedAt > now
    ) {
      throw collectorError('unexpected-response', 'review-trail: GitHub returned an invalid or duplicate merged pull request');
    }
    numbers.add(number);
    merged.push({ number, head, mergeCommit, mergedAt });
  }
  return merged;
}

function approvedStatus(rows: readonly unknown[], mergedAt: number): boolean {
  // GitHub returns commit statuses newest first. The merge gate also rejects spoofed agent-review statuses.
  let latestState: string | undefined;
  for (const row of rows) {
    const status = asObject(row);
    if (typeof status?.context !== 'string') return false;
    if (status.context !== 'agent-review') continue;

    const createdAt = githubTimestamp(status.created_at);
    if (!Number.isFinite(createdAt)) return false;
    if (createdAt > mergedAt) continue;

    const login = asObject(status.creator)?.login;
    if (typeof login !== 'string' || login.toLowerCase() !== REVIEW_ACCOUNT || typeof status.state !== 'string') return false;
    latestState ??= status.state;
  }
  return latestState === 'success';
}

function approvedHead(rows: readonly unknown[], pr: MergedPullRequest): boolean {
  // GitHub returns PR reviews in chronological order.
  let headApproved = false;
  for (const row of rows) {
    const review = asObject(row);
    if (review?.state === 'PENDING' || review?.state === 'COMMENTED') continue;
    if (review?.state !== 'APPROVED' && review?.state !== 'CHANGES_REQUESTED' && review?.state !== 'DISMISSED') return false;

    const login = asObject(review.user)?.login;
    const submittedAt = githubTimestamp(review.submitted_at);
    if (!Number.isFinite(submittedAt)) return false;
    if (submittedAt > pr.mergedAt) continue;
    if (typeof login !== 'string') return false;
    if (login.toLowerCase() !== REVIEW_ACCOUNT) continue;

    headApproved = review.state === 'APPROVED' && review.commit_id === pr.head;
  }
  return headApproved;
}

async function hasAgentReview(fetch: FetchJson, repository: string, pr: MergedPullRequest): Promise<boolean> {
  const [statuses, reviews] = await Promise.all([
    githubList(fetch, `/repos/${repository}/commits/${pr.head}/statuses`, {}, commitStatuses),
    githubList(fetch, `/repos/${repository}/pulls/${pr.number}/reviews`, {}, pullRequests),
  ]);
  return approvedStatus(statuses, pr.mergedAt) && approvedHead(reviews, pr);
}

export const reviewsCollector: Collector<ReviewsInput> = Object.freeze({
  id: SOURCE,
  window: 'settings',
  async collect(input: ReviewsInput, context: CollectorContext): Promise<Observation[]> {
    const repository = checkRepository(input?.repository, SOURCE);
    const fetch = requireFetch(context.fetchJson, SOURCE);
    const since = typeof input.since === 'string' ? Date.parse(input.since) : NaN;
    const now = context.now.getTime();
    if (!Number.isFinite(since)) throw collectorError('invalid-input', 'review-trail: invalid since');
    if (typeof context.commit !== 'string' || !COMMIT_SHA.test(context.commit)) throw collectorError('invalid-input', 'review-trail: invalid assessed commit');
    if (!Number.isFinite(now)) throw collectorError('invalid-input', 'review-trail: invalid collection date');

    const rows = await githubList(fetch, `/repos/${repository}/pulls`, { base: 'main', state: 'closed' }, pullRequests);
    const merged = mergedMainPulls(rows, now);
    const recent = merged.filter((pr) => pr.mergedAt >= since);
    const assessed = merged.filter((pr) => pr.mergeCommit === context.commit);
    const failed = new Set<number>();
    for (const pr of merged) {
      if (pr.mergedAt < since && pr.mergeCommit !== context.commit) continue;
      if (!await hasAgentReview(fetch, repository, pr)) failed.add(pr.number);
    }

    const missing = recent.filter((pr) => failed.has(pr.number));
    const assessedPassed = assessed.length === 1 && !failed.has(assessed[0].number);
    const observation = (subject: string, passed: boolean, counts: Record<string, number>): Observation => ({
      collector: SOURCE,
      subject,
      passed,
      collectedAt: context.now.toISOString(),
      commit: context.commit,
      ...(context.runUrl ? { runUrl: context.runUrl } : {}),
      counts,
    });
    return [
      observation('agent-review', recent.length > 0 && missing.length === 0, {
        prs: recent.length,
        missing: missing.length,
        ...Object.fromEntries(missing.map((pr) => [`pr-${pr.number}`, 1])),
      }),
      observation('assessed-commit-agent-review', assessedPassed, {
        prs: assessed.length,
        missing: assessed.filter((pr) => failed.has(pr.number)).length,
      }),
      observation('gate-approvals', false, { unverified: 1 }),
      observation('publish-approvals', false, { unverified: 1 }),
    ];
  },
});
