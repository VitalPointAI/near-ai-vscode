#!/usr/bin/env node
// Tags a release commit as v<version>, which starts .github/workflows/release.yml. merge-pr.mjs
// does this automatically after a release/x.y.z PR merges; use this script to retry a tag that
// did not get created, or to release a hotfix branch cut from an older tag.
//
//   node scripts/tag-release.mjs <x.y.z> [--sha <commit>] [--repo owner/name] [--no-wait]
//
// Without --sha it tags the current head of main. It refuses unless package.json at that commit
// is <x.y.z>, CHANGELOG.md has a "## <x.y.z>" section, and every CI job on the commit passed.
import { fail, gh, parseArgs, resolveRepo } from './lib/gh.mjs';
import { tagRelease } from './lib/release.mjs';
import { VERSION_PATTERN } from './lib/workflow.mjs';

const usage = 'usage: tag-release.mjs <x.y.z> [--sha <commit>] [--repo owner/name] [--no-wait]';

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['repo', 'sha'], boolean: ['no-wait'] });
  const [version] = positional;
  if (!VERSION_PATTERN.test(version ?? '')) fail(usage);
  const repo = resolveRepo(options.repo);
  const sha = options.sha ?? gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`--sha must be a full 40-character commit hash, got "${sha}"`);
  await tagRelease(repo, version, sha, { wait: !options['no-wait'] });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
