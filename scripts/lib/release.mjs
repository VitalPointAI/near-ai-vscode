// Tagging a release commit. Shared by merge-pr.mjs (after a release/x.y.z PR merges) and
// tag-release.mjs (manual or hotfix use). The tag starts .github/workflows/release.yml.
import { commitChecks, createAnnotatedTag, fileAt, tagCommit } from './gh.mjs';
import { CI_CHECKS, changelogSection, evaluateCommit } from './workflow.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits (up to timeoutMs) for the CI jobs on sha to finish, then requires them all green, from
 * the CI workflow only (see evaluateCommit).
 */
export async function waitForCi(repo, sha, { timeoutMs = 45 * 60_000, log = console.log, required = CI_CHECKS, reviewer } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const result = evaluateCommit(commitChecks(repo, sha), { required, reviewer });
    if (result.ok) return;
    if (!result.waiting || Date.now() > deadline) throw new Error(`CI on ${sha.slice(0, 7)} is not green:\n- ${result.problems.join('\n- ')}`);
    if (!announced) { log(`Waiting for CI on ${sha.slice(0, 7)} to finish...`); announced = true; }
    await sleep(20_000);
  }
}

/**
 * Checks that sha is a releasable x.y.z (package.json version and a CHANGELOG section) with
 * green CI, then creates v<version> on it. Idempotent: an existing tag on the same commit is
 * accepted; one on a different commit is refused.
 */
export async function tagRelease(repo, version, sha, { wait = true, log = console.log } = {}) {
  const tag = `v${version}`;
  const existing = tagCommit(repo, tag);
  if (existing && existing !== sha) throw new Error(`${tag} already exists on ${existing.slice(0, 7)}, not ${sha.slice(0, 7)}. Marketplace versions cannot be reused; release the fix as the next patch version.`);
  const pkg = JSON.parse(fileAt(repo, 'package.json', sha));
  if (pkg.version !== version) throw new Error(`package.json at ${sha.slice(0, 7)} is ${pkg.version}, not ${version}`);
  if (!changelogSection(fileAt(repo, 'CHANGELOG.md', sha), version)) throw new Error(`CHANGELOG.md at ${sha.slice(0, 7)} has no "## ${version}" section`);
  if (wait) await waitForCi(repo, sha, { log });
  else {
    const result = evaluateCommit(commitChecks(repo, sha), { required: CI_CHECKS });
    if (!result.ok) throw new Error(`CI on ${sha.slice(0, 7)} is not green:\n- ${result.problems.join('\n- ')}`);
  }
  if (existing) { log(`${tag} already points at ${sha.slice(0, 7)}.`); return tag; }
  createAnnotatedTag(repo, version, sha);
  log(`Tagged ${sha.slice(0, 7)} as ${tag}. The Release workflow now builds the VSIX and the GitHub release; publishing waits for the owner's approval in the "marketplace" environment.`);
  return tag;
}
