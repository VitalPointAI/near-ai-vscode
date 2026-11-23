import type { Observation } from '../model.ts';
import type { Collector, CollectorContext, FetchJson } from './types.ts';
import { asObject, checkRepository, COMMIT_SHA, githubGet, requireFetch } from './github.ts';
// Kept aligned with scripts/lib/workflow.mjs CI_CHECKS and AGENT_REVIEW_CONTEXT; docs is purposely separate (G12).
const CI_CHECKS = ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub']; const AGENT_REVIEW_CONTEXT = 'agent-review';
export const SETTINGS_CHECKS = Object.freeze(['required-checks', 'docs-required', 'enforce-admins', 'review-required', 'tag-ruleset', 'environment-marketplace', 'environment-agent-review-gates', 'codeowners-valid'] as const);
export interface SettingsInput { readonly repository: string; }
const value = (subject: string, passed: boolean, context: CollectorContext, counts: Record<string, number> = {}): Observation => ({ collector: 'settings', subject, passed, collectedAt: context.now.toISOString(), commit: context.commit, ...(context.runUrl ? { runUrl: context.runUrl } : {}), counts });
const CODEOWNERS_MAX_BYTES = 3_000_000;
const CONTENTS_READ = { collector: 'settings', permission: 'Contents read' };

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
    const protection = await githubGet(fetch, `/repos/${repository}/branches/main/protection`, {}, adminRead) as {
      required_status_checks?: { contexts?: unknown };
      enforce_admins?: { enabled?: unknown };
      required_pull_request_reviews?: { required_approving_review_count?: unknown };
    };
    const rulesets = await githubGet(fetch, `/repos/${repository}/rulesets`, {}, adminRead);
    const environments = await githubGet(fetch, `/repos/${repository}/environments`, {}, adminRead) as { environments?: unknown };
    const checks = Array.isArray(protection.required_status_checks?.contexts) ? protection.required_status_checks.contexts.filter((item): item is string => typeof item === 'string') : [];
    const expected = [...CI_CHECKS, AGENT_REVIEW_CONTEXT];
    const ruleNames = Array.isArray(rulesets) ? rulesets.map((item) => (item as { name?: unknown }).name).filter((item): item is string => typeof item === 'string') : [];
    const envs = Array.isArray(environments.environments) ? environments.environments as { name?: unknown; can_admins_bypass?: unknown }[] : [];
    const env = (name: string) => envs.find((item) => item.name === name);
    const bypass = (entry: { can_admins_bypass?: unknown } | undefined) => entry?.can_admins_bypass === true;
    return [
      value('required-checks', expected.every((name) => checks.includes(name)), context, { required: expected.length, present: expected.filter((name) => checks.includes(name)).length }),
      value('docs-required', checks.includes('docs'), context),
      value('enforce-admins', protection.enforce_admins?.enabled === true, context),
      value('review-required', typeof protection.required_pull_request_reviews?.required_approving_review_count === 'number' && protection.required_pull_request_reviews.required_approving_review_count > 0, context),
      value('tag-ruleset', ruleNames.filter((name) => /tag/i.test(name)).length >= 2, context),
      value('environment-marketplace', Boolean(env('marketplace')) && !bypass(env('marketplace')), context),
      value('environment-agent-review-gates', Boolean(env('agent-review-gates')) && !bypass(env('agent-review-gates')), context),
      await codeownersObservation(fetch, repository, context)
    ];
  }
});
