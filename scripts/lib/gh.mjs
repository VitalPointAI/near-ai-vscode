// Thin wrappers around the GitHub CLI (`gh`) and git. Arguments are passed as arrays, never
// through a shell, so PR titles, branch names and file contents cannot inject commands.
import { execFileSync } from 'node:child_process';

export function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function gh(args, options) { return run('gh', args, options); }
export function ghJson(args, options) { return JSON.parse(gh(args, options) || 'null'); }
export function git(args, options) { return run('git', args, options); }

/** owner/name of the repository: --repo flag, then GH_REPO, then the current checkout. */
export function resolveRepo(flag) {
  if (flag) return flag;
  if (process.env.GH_REPO) return process.env.GH_REPO;
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

export const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'author', 'baseRefName', 'headRefName', 'headRefOid',
  'mergeable', 'mergeStateStatus', 'statusCheckRollup', 'files', 'additions', 'deletions', 'body'
].join(',');

export function viewPr(repo, number) {
  return ghJson(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS]);
}

/** Polls while GitHub is still computing mergeability (mergeable UNKNOWN). */
export async function viewPrSettled(repo, number, attempts = 6) {
  let pr = viewPr(repo, number);
  for (let i = 1; i < attempts && (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000 * i));
    pr = viewPr(repo, number);
  }
  return pr;
}

/** Required status check contexts from branch protection, or [] when the branch is not protected. */
export function protectedContexts(repo, branch) {
  try {
    const result = ghJson(['api', `repos/${repo}/branches/${branch}/protection/required_status_checks`]);
    const fromChecks = (result?.checks ?? []).map((check) => check.context);
    return [...new Set([...(result?.contexts ?? []), ...fromChecks])];
  } catch {
    return [];
  }
}

/** Review threads that are still unresolved on the PR (every page of them). */
export function unresolvedThreads(repo, number) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved path}}}}}';
  const threads = [];
  let after;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`];
    if (after) args.push('-f', `after=${after}`);
    const page = ghJson(args)?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error(`could not read the review threads of #${number}`);
    threads.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return threads.filter((thread) => !thread.isResolved);
}

/** How many commits the head is behind the base branch on GitHub. */
export function behindBy(repo, base, headSha) {
  return ghJson(['api', `repos/${repo}/compare/${base}...${headSha}`, '--jq', '{behind: .behind_by, ahead: .ahead_by}']);
}

export function parseArgs(argv, flags) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (flags.boolean?.includes(key)) { options[key] = true; continue; }
    if (!flags.string?.includes(key)) throw new Error(`unknown option --${key}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    options[key] = value;
  }
  return { positional, options };
}

export function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** Every value of a paginated `gh api` call, one JSON value per line (the jq ends in `tojson`). */
function ghLines(endpoint, jq) {
  return gh(['api', '--paginate', endpoint, '--jq', jq]).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * Everything the merge and release gates need about one commit (see evaluateCommit in
 * workflow.mjs): every check run attempt with the app and check suite it came from, the workflow
 * runs on the commit, and every commit status with the account that set it.
 */
export function commitChecks(repo, sha) {
  return {
    checkRuns: ghLines(`repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=all`,
      '.check_runs[] | {id, name, status, conclusion, startedAt: .started_at, completedAt: .completed_at, app: .app.slug, suiteId: .check_suite.id, url: .html_url} | tojson'),
    workflowRuns: ghLines(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
      '.workflow_runs[] | {id, name, path, event, suiteId: .check_suite_id} | tojson'),
    statuses: ghLines(`repos/${repo}/commits/${sha}/statuses?per_page=100`,
      '.[] | {id, context, state, createdAt: .created_at, creator: .creator.login, url: .target_url} | tojson')
  };
}

/** The GitHub account the scripts run as: the only account whose `agent-review` status counts. */
export function currentLogin() {
  const login = gh(['api', 'user', '--jq', '.login']).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)) throw new Error(`could not read the GitHub account gh runs as (got "${login}")`);
  return login;
}

/** A file's text at a commit, through the API (no local checkout needed). */
export function fileAt(repo, filePath, ref) {
  const encoded = gh(['api', `repos/${repo}/contents/${filePath}?ref=${ref}`, '--jq', '.content']).replace(/\s/g, '');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** True when a failed gh call failed because GitHub answered 404 Not Found. */
export function isNotFound(error) {
  return /\(HTTP 404\)/.test(error instanceof Error ? error.message : String(error));
}

/** The commit a branch points at on GitHub, or undefined when the branch does not exist. */
export function branchHead(repo, branch) {
  try {
    return ghJson(['api', `repos/${repo}/git/ref/heads/${branch}`]).object.sha;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** The commit a tag points at, or undefined when the tag does not exist. */
export function tagCommit(repo, tag) {
  let ref;
  try {
    ref = ghJson(['api', `repos/${repo}/git/ref/tags/${tag}`]);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (ref.object.type === 'commit') return ref.object.sha;
  return ghJson(['api', `repos/${repo}/git/tags/${ref.object.sha}`]).object.sha;
}

/** Creates the annotated tag v<version> on sha. Pushing a v*.*.* tag starts release.yml. */
export function createAnnotatedTag(repo, version, sha) {
  const tag = `v${version}`;
  const tagObject = ghJson(['api', '-X', 'POST', `repos/${repo}/git/tags`, '-f', `tag=${tag}`, '-f', `message=${version}`, '-f', `object=${sha}`, '-f', 'type=commit']);
  gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${tagObject.sha}`]);
  return tag;
}
