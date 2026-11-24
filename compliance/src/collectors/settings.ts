import type { Observation } from '../model.ts';
import type { Collector, CollectorContext, FetchJson } from './types.ts';
import { AGENT_REVIEW_CONTEXT, CI_CHECKS } from '../../../scripts/lib/workflow.mjs';
import { asObject, checkRepository, COMMIT_SHA, githubGet, githubList, requireFetch } from './github.ts';
// The GitHub Actions app ID used in the documented main protection settings.
const ACTIONS_APP_ID = 15368;
export const SETTINGS_CHECKS = Object.freeze(['required-checks', 'docs-required', 'enforce-admins', 'review-required', 'main-change-protection', 'tag-ruleset', 'environment-container-release', 'environment-agent-review-gates', 'codeowners-valid'] as const);
export interface SettingsInput { readonly repository: string; }
const value = (subject: string, passed: boolean, context: CollectorContext, counts: Record<string, number> = {}): Observation => ({ collector: 'settings', subject, passed, collectedAt: context.now.toISOString(), commit: context.commit, ...(context.runUrl ? { runUrl: context.runUrl } : {}), counts });
const CODEOWNERS_MAX_BYTES = 3_000_000;
const CONTENTS_READ = { collector: 'settings', permission: 'Contents read' };
const ACTIONS_READ = { collector: 'settings', permission: 'Actions read' };

async function environmentObservation(
  fetch: FetchJson, repository: string, name: 'container-release' | 'agent-review-gates', context: CollectorContext
): Promise<Observation> {
  const subject = `environment-${name}`;
  const endpoint = `/repos/${repository}/environments/${name}`;
  try {
    const environment = asObject(await githubGet(fetch, endpoint, {}, ACTIONS_READ));
    const policy = asObject(environment?.deployment_branch_policy);
    if (environment?.name !== name || typeof environment.can_admins_bypass !== 'boolean' ||
        !Array.isArray(environment.protection_rules) || !policy) {
      return value(subject, false, context, { unverified: 1 });
    }
    const reviewers = environment.protection_rules.map(asObject).filter((rule) => rule?.type === 'required_reviewers');
    const configured = reviewers.length === 1 && Array.isArray(reviewers[0]?.reviewers)
      ? reviewers[0].reviewers : [];
    const hasReviewers = configured.length > 0 && configured.every((entry) => {
      const item = asObject(entry);
      const reviewer = asObject(item?.reviewer);
      return (item?.type === 'User' || item?.type === 'Team') && typeof reviewer?.id === 'number' &&
        Number.isSafeInteger(reviewer.id) && reviewer.id > 0;
    });
    if (!hasReviewers || environment.can_admins_bypass) return value(subject, false, context);
    if (name === 'agent-review-gates') {
      return value(subject, policy.protected_branches === true && policy.custom_branch_policies === false, context);
    }
    if (policy.protected_branches !== false || policy.custom_branch_policies !== true) return value(subject, false, context);
    const entries = await githubList(fetch, `${endpoint}/deployment-branch-policies`, {}, { ...ACTIONS_READ, key: 'branch_policies' });
    const [tag] = entries.map(asObject);
    return value(subject, entries.length === 1 && tag?.type === 'tag' && tag.name === 'v*.*.*', context);
  } catch {
    return value(subject, false, context, { unverified: 1 });
  }
}

async function readTree(fetch: FetchJson, repository: string, sha: string): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const response = asObject(await githubGet(fetch, `/repos/${repository}/git/trees/${sha}`, {}, CONTENTS_READ));
  if (response?.truncated !== false || !Array.isArray(response.tree)) throw new Error('GitHub did not provide a complete tree');
  const entries = new Map<string, Record<string, unknown>>();
  for (const raw of response.tree) {
    const entry = asObject(raw);
    if (typeof entry?.path !== 'string' || entries.has(entry.path)) throw new Error('GitHub returned invalid tree entries');
    entries.set(entry.path, entry);
  }
  return entries;
}

/** Find the first CODEOWNERS candidate in GitHub's documented precedence. Tree metadata distinguishes blobs from symlinks. */
async function codeownersAtRef(fetch: FetchJson, repository: string, commit: string): Promise<Record<string, unknown> | undefined> {
  const root = await readTree(fetch, repository, commit);
  for (const directory of ['.github', '', 'docs']) {
    let entries = root;
    if (directory) {
      const folder = root.get(directory);
      if (folder?.type !== 'tree') continue;
      if (typeof folder.sha !== 'string' || !COMMIT_SHA.test(folder.sha)) throw new Error('GitHub returned an invalid subtree');
      entries = await readTree(fetch, repository, folder.sha);
    }
    const candidate = entries.get('CODEOWNERS');
    if (candidate) return candidate;
  }
  return undefined;
}

async function codeownersObservation(fetch: FetchJson, repository: string, context: CollectorContext): Promise<Observation> {
  const subject = 'codeowners-valid';
  if (!COMMIT_SHA.test(context.commit)) return value(subject, false, context, { unverified: 1 });
  try {
    const response = asObject(await githubGet(fetch, `/repos/${repository}/codeowners/errors`, { ref: context.commit }, CONTENTS_READ));
    if (!Array.isArray(response?.errors)) return value(subject, false, context, { unverified: 1 });
    if (response.errors.length) return value(subject, false, context, { errors: response.errors.length });

    const file = await codeownersAtRef(fetch, repository, context.commit);
    if (!file) return value(subject, false, context, { missing: 1 });
    const valid = file.type === 'blob' && (file.mode === '100644' || file.mode === '100755') &&
      typeof file.sha === 'string' && COMMIT_SHA.test(file.sha) &&
      typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size > 0 && file.size < CODEOWNERS_MAX_BYTES;
    return value(subject, valid, context, valid ? { errors: 0 } : { invalid: 1 });
  } catch {
    // Failure to verify this file must not erase independent branch or environment observations.
    return value(subject, false, context, { unverified: 1 });
  }
}

export const settingsCollector: Collector<SettingsInput> = Object.freeze({
  id: 'settings',
  window: 'settings',
  async collect(input: SettingsInput, context: CollectorContext): Promise<Observation[]> {
    const repository = checkRepository(input?.repository, 'settings');
    const fetch = requireFetch(context.fetchJson, 'settings');
    const adminRead = { collector: 'settings', permission: 'Administration read' };
    const protection = asObject(await githubGet(fetch, `/repos/${repository}/branches/main/protection`, {}, adminRead));
    const required = asObject(protection?.required_status_checks);
    const checks = Array.isArray(required?.checks) ? required.checks.map(asObject) : [];
    const check = (name: string, appId?: number) => {
      const present = checks.filter((item) => item?.context === name);
      return present.length === 1 && (appId === undefined || present[0]?.app_id === appId);
    };
    const expected = [...CI_CHECKS, AGENT_REVIEW_CONTEXT];
    const checksPresent = expected.filter((name) => check(name, name === AGENT_REVIEW_CONTEXT ? undefined : ACTIONS_APP_ID)).length;
    const checksRequired = required?.strict === true && checksPresent === expected.length;
    const flag = (name: string, expected: boolean) => asObject(protection?.[name])?.enabled === expected;
    const admins = flag('enforce_admins', true);
    const review = asObject(protection?.required_pull_request_reviews);
    const count = review?.required_approving_review_count;
    const reviewRequired = typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && review?.dismiss_stale_reviews === true;
    const protections = [checksRequired, admins, reviewRequired, flag('required_linear_history', true),
      flag('allow_force_pushes', false), flag('allow_deletions', false), flag('required_conversation_resolution', true)];
    const [containerRelease, gates, codeowners] = await Promise.all([
      environmentObservation(fetch, repository, 'container-release', context),
      environmentObservation(fetch, repository, 'agent-review-gates', context),
      codeownersObservation(fetch, repository, context)
    ]);
    return [
      value('required-checks', checksRequired, context, { required: expected.length, present: checksPresent }),
      value('docs-required', check('docs', ACTIONS_APP_ID), context),
      value('enforce-admins', admins, context),
      value('review-required', reviewRequired, context),
      value('main-change-protection', protections.every(Boolean), context, { required: protections.length, present: protections.filter(Boolean).length }),
      // Read-only settings collection cannot verify the rulesets' bypass actors.
      value('tag-ruleset', false, context, { unverified: 1 }),
      containerRelease, gates, codeowners
    ];
  }
});
