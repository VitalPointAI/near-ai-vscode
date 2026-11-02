#!/usr/bin/env node
// Release-branch helper for the release agent, run inside the release/x.y.z (or hotfix/x.y.z)
// worktree.
//
//   node scripts/prepare-release.mjs bump <x.y.z>   sets package.json and package-lock.json
//   node scripts/prepare-release.mjs check          verifies the branch is ready for its PR
//
// `check` requires: the branch is release/<version> or hotfix/<version>, package.json and the
// lockfile both say <version>, it is higher than the last v* tag on origin, and CHANGELOG.md has a
// "## <version>" section with text. The CHANGELOG prose is written by the agent, for users.
import { readFileSync } from 'node:fs';
import { fail, git, parseArgs, run } from './lib/gh.mjs';
import { VERSION_PATTERN, changelogSection, isVersionBump, latestReleaseVersion, releaseVersionFromBranch } from './lib/workflow.mjs';

const usage = 'usage: prepare-release.mjs bump <x.y.z> | check';

/** The last release, read from GitHub (origin), since local tags can be stale in a worktree. */
function lastTagVersion() {
  return latestReleaseVersion(git(['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*']));
}

function check() {
  const problems = [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const version = releaseVersionFromBranch(branch);
  if (!version) fail(`run this on a release/x.y.z or hotfix/x.y.z branch (current: ${branch})`);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  if (pkg.version !== version) problems.push(`package.json is ${pkg.version}; run: node scripts/prepare-release.mjs bump ${version}`);
  if (lock.version !== version || lock.packages?.['']?.version !== version) problems.push('package-lock.json does not match the version; run the bump command');
  const last = lastTagVersion();
  if (last && !isVersionBump(last, version)) problems.push(`${version} is not higher than the last release tag v${last}`);
  if (!changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)) problems.push(`CHANGELOG.md has no "## ${version}" section with text`);
  if (problems.length > 0) fail(`Release ${version} is not ready:\n- ${problems.join('\n- ')}`);
  console.log(`Release ${version} is ready for its PR (last release: ${last ? `v${last}` : 'none'}).`);
}

try {
  const { positional } = parseArgs(process.argv.slice(2), {});
  const [command, version] = positional;
  if (command === 'bump') {
    if (!VERSION_PATTERN.test(version ?? '')) fail(usage);
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'inherit' });
    console.log(`package.json and package-lock.json are now ${version}. Write the "## ${version}" CHANGELOG section next.`);
  } else if (command === 'check') {
    check();
  } else {
    fail(usage);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
