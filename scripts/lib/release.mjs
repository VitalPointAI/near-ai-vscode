// Tagging a release commit. Shared by merge-pr.mjs (after a release/x.y.z PR merges) and
// tag-release.mjs (manual or hotfix use). The tag starts .github/workflows/release.yml.
import { behindBy, branchHead, commitChecks, createAnnotatedTag, currentLogin, fileAt, sleep, tagCommit } from './gh.mjs';
import { CI_CHECKS, changelogSection, evaluateCommit, releaseGate } from './workflow.mjs';

/**
 * Waits (up to timeoutMs) for the CI jobs on sha to finish, then requires them all green, from
 * the CI workflow only (see evaluateCommit). Refuses at once when a problem is not just CI still
 * running. `wait` and `now` are for tests.
 */
export async function waitForCi(repo, sha, {
  timeoutMs = 45 * 60_000, pollMs = 20_000, log = console.log, required = CI_CHECKS, reviewer, exactCommitCi = false, wait = sleep, now = Date.now
} = {}) {
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    const result = evaluateCommit(commitChecks(repo, sha), { required, reviewer, exactCommitCi });
    if (result.ok) return;
    if (!result.waiting) throw new Error(`CI on ${sha.slice(0, 7)} is not green:\n- ${result.problems.join('\n- ')}`);
    if (now() > deadline) throw new Error(`CI on ${sha.slice(0, 7)} did not finish within ${Math.round(timeoutMs / 60_000)} minutes:\n- ${result.problems.join('\n- ')}`);
    if (!announced) { log(`Waiting for CI on ${sha.slice(0, 7)} to finish...`); announced = true; }
    await wait(pollMs);
  }
}

/**
 * Checks that sha is a releasable x.y.z (package.json version and a CHANGELOG section) with
 * green CI, then creates v<version> on it. A commit on main needs green CI from a run on that
 * commit; the head of hotfix/<version> also needs the owner's agent-review on that commit (see
 * releaseGate). Idempotent: an existing tag on the same commit is accepted; one on a different
 * commit is refused.
 */
export async function tagRelease(repo, version, sha, { wait = true, log = console.log, ci = {} } = {}) {
  const tag = `v${version}`;
  const existing = tagCommit(repo, tag);
  if (existing && existing !== sha) throw new Error(`${tag} already exists on ${existing.slice(0, 7)}, not ${sha.slice(0, 7)}. Marketplace versions cannot be reused; release the fix as the next patch version.`);
  const plan = releaseGate({ version, sha, onMain: behindBy(repo, 'main', sha).ahead === 0, hotfixHead: branchHead(repo, `hotfix/${version}`) });
  if (!plan.ok) throw new Error(plan.reason);
  const pkg = JSON.parse(fileAt(repo, 'package.json', sha));
  if (pkg.version !== version) throw new Error(`package.json at ${sha.slice(0, 7)} is ${pkg.version}, not ${version}`);
  if (!changelogSection(fileAt(repo, 'CHANGELOG.md', sha), version)) throw new Error(`CHANGELOG.md at ${sha.slice(0, 7)} has no "## ${version}" section`);
  const gate = { required: plan.required, reviewer: plan.hotfix ? currentLogin() : undefined, exactCommitCi: true };
  if (wait) await waitForCi(repo, sha, { log, ...ci, ...gate });
  else {
    const result = evaluateCommit(commitChecks(repo, sha), gate);
    if (!result.ok) throw new Error(`${sha.slice(0, 7)} is not ready to release:\n- ${result.problems.join('\n- ')}`);
  }
  if (existing) { log(`${tag} already points at ${sha.slice(0, 7)}.`); return tag; }
  createAnnotatedTag(repo, version, sha);
  log(`Tagged ${sha.slice(0, 7)} as ${tag}. The Release workflow now builds the VSIX and the GitHub release; publishing waits for the owner's approval in the "marketplace" environment.`);
  return tag;
}
