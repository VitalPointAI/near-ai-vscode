import type { Observation } from '../model.ts';
import type { Collector, CollectorContext, FetchJson } from './types.ts';
import { asObject, checkRepository, collectorError, COMMIT_SHA, githubGet, githubList, requireFetch } from './github.ts';

const SOURCE = 'review-trail';
// Mirrors scripts/lib/workflow.mjs REVIEW_ACCOUNT.
const REVIEW_ACCOUNT = 'near-ai-reviewer';
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const pullRequests = { collector: SOURCE, permission: 'Pull requests read' };
const commitStatuses = { collector: SOURCE, permission: 'Commit statuses read' };
const actionsRead = { collector: SOURCE, permission: 'Actions read' };
const GATE_ENVIRONMENT = 'agent-review-gates';
const GATE_WORKFLOW = '.github/workflows/agent-review.yml';
const GATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GATE_RUNS = 30;
const MAX_GATE_JOBS = 10;
const MAX_GATE_APPROVALS = 20;

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

function githubId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function completeActionsRows(body: unknown, key: 'workflow_runs' | 'jobs', limit: number): Record<string, unknown>[] {
  const response = asObject(body);
  const rows = response?.[key];
  if (!Array.isArray(rows) || rows.length > limit || response?.total_count !== rows.length) {
    throw collectorError('unexpected-response', 'review-trail: GitHub did not return a complete, bounded Actions result');
  }
  return rows.map((row) => {
    const entry = asObject(row);
    if (!entry) throw collectorError('unexpected-response', 'review-trail: GitHub returned an invalid Actions record');
    return entry;
  });
}

async function configuredGateReviewer(fetch: FetchJson, root: string) {
  const environment = asObject(await githubGet(fetch, `${root}/environments/${GATE_ENVIRONMENT}`, {}, actionsRead));
  if (environment?.name !== GATE_ENVIRONMENT || environment.can_admins_bypass !== false ||
      !githubId(environment.id) || !Array.isArray(environment.protection_rules)) return;

  const rules = environment.protection_rules.map(asObject).filter((rule) => rule?.type === 'required_reviewers');
  const configured = rules.length === 1 ? rules[0]?.reviewers : undefined;
  if (!Array.isArray(configured) || configured.length !== 1) return;
  const entry = asObject(configured[0]);
  const reviewerId = asObject(entry?.reviewer)?.id;
  if (entry?.type === 'User' && githubId(reviewerId)) return { environmentId: environment.id, reviewerId };
}

function isGateRun(run: Record<string, unknown>, repository: string, since: number, mergedAt: number): run is Record<string, unknown> & { id: number } {
  const origin = asObject(run.repository);
  const head = asObject(run.head_repository);
  const sameRepository = (value: unknown) => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
  const createdAt = githubTimestamp(run.created_at);
  return githubId(run.id) && githubId(origin?.id) && origin.id === head?.id &&
    sameRepository(origin.full_name) && sameRepository(head.full_name) &&
    (run.path === GATE_WORKFLOW || run.path === `${GATE_WORKFLOW}@main` || run.path === `${GATE_WORKFLOW}@refs/heads/main`) &&
    run.head_branch === 'main' && (run.event === 'workflow_run' || run.event === 'workflow_dispatch') &&
    run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1 &&
    createdAt >= since && createdAt <= mergedAt;
}

function hasConfiguredApproval(body: unknown, environmentId: number, reviewerId: number): boolean {
  if (!Array.isArray(body) || body.length > MAX_GATE_APPROVALS) return false;
  const matching: Record<string, unknown>[] = [];
  for (const row of body) {
    const entry = asObject(row);
    if (!entry || !Array.isArray(entry.environments)) return false;
    for (const value of entry.environments) {
      const environment = asObject(value);
      if (!githubId(environment?.id) || typeof environment?.name !== 'string') return false;
      if (environment.name !== GATE_ENVIRONMENT && environment.id !== environmentId) continue;
      if (environment.name !== GATE_ENVIRONMENT || environment.id !== environmentId) return false;
      matching.push(entry);
    }
  }
  return matching.length === 1 && matching[0].state === 'approved' && asObject(matching[0].user)?.id === reviewerId;
}

async function assessedGateApproval(fetch: FetchJson, repository: string, pr: MergedPullRequest): Promise<number | undefined> {
  // We corroborate the recorded approver against the sole configured reviewer at observation time.
  // GitHub's run-wide history does not identify an attempt or time, so reruns stay unverified.
  const root = `/repos/${repository}`;
  const since = pr.mergedAt - GATE_LOOKBACK_MS;
  const window = `${new Date(since).toISOString()}..${new Date(pr.mergedAt).toISOString()}`;
  const expectedJob = `owner approval (gate change) PR #${pr.number} @ ${pr.head}`;
  try {
    const configured = await configuredGateReviewer(fetch, root);
    if (!configured) return;
    const runs = completeActionsRows(await githubGet(fetch, `${root}/actions/workflows/agent-review.yml/runs`,
      { branch: 'main', created: window, status: 'success', per_page: MAX_GATE_RUNS }, actionsRead), 'workflow_runs', MAX_GATE_RUNS);
    if (runs.some((run) => !githubId(run.id) || !githubId(run.run_attempt) || !Number.isFinite(githubTimestamp(run.created_at)))) return;
    const candidates: number[] = [];
    for (const run of runs) {
      if (!isGateRun(run, repository, since, pr.mergedAt)) continue;
      const jobs = completeActionsRows(await githubGet(fetch, `${root}/actions/runs/${run.id}/attempts/1/jobs`,
        { per_page: MAX_GATE_JOBS }, actionsRead), 'jobs', MAX_GATE_JOBS);
      if (jobs.some((job) => typeof job.name !== 'string' || job.run_id !== run.id)) return;
      const matches = jobs.filter((job) => job.name === expectedJob);
      if (matches.length > 1) return;
      if (!matches.length) continue;
      const job = matches[0];
      const completedAt = githubTimestamp(job.completed_at);
      if (job.status !== 'completed' || typeof job.conclusion !== 'string' || !Number.isFinite(completedAt)) return;
      if (job.conclusion !== 'success' || completedAt < githubTimestamp(run.created_at) || completedAt > pr.mergedAt) continue;
      candidates.push(run.id);
      if (candidates.length > 1) return;
    }
    if (candidates.length !== 1) return;
    const runId = candidates[0];
    const runPath = `${root}/actions/runs/${runId}`;
    const history = await githubGet(fetch, `${runPath}/approvals`, {}, actionsRead);
    if (!hasConfiguredApproval(history, configured.environmentId, configured.reviewerId)) return;
    // A run retried during collection could otherwise expose a later attempt's approval.
    const current = asObject(await githubGet(fetch, runPath, {}, actionsRead));
    if (current?.id === runId && isGateRun(current, repository, since, pr.mergedAt)) return runId;
  } catch {
    // Actions evidence is optional. A failed fetch must preserve the independent PR review evidence.
    return;
  }
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
    const approvingRun = assessedPassed ? await assessedGateApproval(fetch, repository, assessed[0]) : undefined;
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
      observation('gate-approvals', approvingRun !== undefined,
        approvingRun === undefined ? { unverified: 1 } : { 'approving-run': approvingRun }),
      observation('publish-approvals', false, { unverified: 1 }),
    ];
  },
});
