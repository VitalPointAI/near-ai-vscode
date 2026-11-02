// A fake `gh` for testing the scripts' orchestration (merge, tag, review submit) without GitHub.
// It answers the gh calls the scripts make from an in-memory repository state and records every
// call, so a test can check what was (and was not) done. Not a test file itself.
import { CI_CHECKS } from '../lib/workflow.mjs';

export const REPO = 'VitalPointAI/near-ai-vscode';
export const OWNER = 'ALuhning';

const notFound = (args) => new Error(`gh ${args.join(' ')} failed: gh: Not Found (HTTP 404)`);
const lines = (values) => values.map((value) => JSON.stringify(value)).join('\n');

/** Check runs, workflow run and agent-review status of a commit whose CI and review passed. */
export function greenCommit({ suiteId = 1, runId = 11, event = 'pull_request', reviewer = OWNER, review = true } = {}) {
  return {
    checkRuns: CI_CHECKS.map((name, i) => ({ id: runId * 100 + i, name, status: 'completed', conclusion: 'success', startedAt: '2026-01-01T00:00:00Z', app: 'github-actions', suiteId })),
    workflowRuns: [{ id: runId, name: 'CI', path: '.github/workflows/ci.yml', event, status: 'completed', conclusion: 'success', suiteId }],
    statuses: review ? [{ id: 1, context: 'agent-review', state: 'success', createdAt: '2026-01-01T01:00:00Z', creator: reviewer }] : []
  };
}

/**
 * state: { login, prs: { [number]: pr }, commits: { [sha]: checks or [checks, checks, ...] (one
 * per read, the last repeating) }, files: { [`${sha}:${path}`]: text }, tags: { [tag]: sha },
 * branches: { [name]: sha }, behind: { [sha]: n }, mainContains: Set of shas, threads: [],
 * protection: contexts or undefined (404), failOn: RegExp of calls that fail, mergeSha,
 * mergeFails, mergeUnconfirmed, commentFails, statusFails(state) }.
 */
export function fakeGitHub(state) {
  const calls = [];
  const reads = new Map();
  const world = {
    login: OWNER, prs: {}, commits: {}, files: {}, tags: {}, branches: {}, behind: {}, mainContains: new Set(), threads: [], ...state
  };
  const runner = (command, args) => {
    calls.push([command, ...args]);
    const line = args.join(' ');
    if (command !== 'gh') throw new Error(`unexpected command ${command} ${line}`);
    if (world.failOn?.test(line)) throw new Error(`gh ${line} failed: gh: Server Error (HTTP 500)`);
    const [verb, sub] = args;
    if (verb === 'pr' && sub === 'view') {
      const pr = world.prs[args[2]];
      if (!pr) throw notFound(args);
      if (args.includes('state,mergeCommit')) return JSON.stringify({ state: pr.state, mergeCommit: pr.mergeCommit ?? null });
      return JSON.stringify(pr);
    }
    if (verb === 'pr' && sub === 'merge') {
      const pr = world.prs[args[2]];
      const head = args[args.indexOf('--match-head-commit') + 1];
      if (head !== pr.headRefOid) throw new Error('gh pr merge failed: head moved');
      if (world.mergeFails) throw new Error('gh pr merge failed: GraphQL: Base branch was modified');
      if (!world.mergeUnconfirmed) Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: world.mergeSha } });
      return '';
    }
    if (verb === 'pr' && sub === 'comment') {
      if (world.commentFails) throw new Error('gh pr comment failed: HTTP 502');
      return `https://github.com/${REPO}/pull/${args[2]}#issuecomment-1\n`;
    }
    if (verb === 'pr' && sub === 'diff') return 'diff --git a/x b/x\n';
    if (verb !== 'api') throw new Error(`unexpected gh ${line}`);

    const rest = args.slice(1).filter((arg) => arg !== '--paginate');
    if (rest[0] === '-X') {
      const [, method, endpoint, ...fields] = rest;
      const field = (name) => fields.find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1);
      if (method === 'POST' && /\/statuses\//.test(endpoint)) {
        if (world.statusFails?.(field('state'))) throw new Error(`gh api ${endpoint} failed: HTTP 502`);
        const sha = endpoint.split('/').pop();
        world.commits[sha] ??= { checkRuns: [], workflowRuns: [], statuses: [] };
        const checks = Array.isArray(world.commits[sha]) ? world.commits[sha].at(-1) : world.commits[sha];
        checks.statuses.push({ id: checks.statuses.length + 100, context: field('context'), state: field('state'), createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, checks.statuses.length)).toISOString(), creator: world.login });
        return '{}';
      }
      if (method === 'POST' && endpoint.endsWith('/git/tags')) {
        world.tagObject = field('object');
        return JSON.stringify({ sha: 'f'.repeat(40) });
      }
      if (method === 'POST' && endpoint.endsWith('/git/refs')) {
        world.tags[field('ref').replace('refs/tags/', '')] = world.tagObject;
        return '{}';
      }
      throw new Error(`unexpected gh ${line}`);
    }
    if (rest[0] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: world.threads } } } } });
    }
    const endpoint = rest[0];
    let match;
    if (endpoint === 'user') return `${world.login}\n`;
    if ((match = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})\/(check-runs|statuses)/.exec(endpoint)) || (match = /actions\/runs\?head_sha=([0-9a-f]{40})/.exec(endpoint))) {
      const sha = match[1];
      const kind = match[2] === 'check-runs' ? 'checkRuns' : match[2] === 'statuses' ? 'statuses' : 'workflowRuns';
      let checks = world.commits[sha] ?? { checkRuns: [], workflowRuns: [], statuses: [] };
      if (Array.isArray(checks)) {
        // One entry per full read (check runs come first in commitChecks).
        const count = (reads.get(sha) ?? 0) + (kind === 'checkRuns' ? 1 : 0);
        reads.set(sha, count);
        checks = checks[Math.min(count, checks.length) - 1];
      }
      return lines(checks[kind]);
    }
    if ((match = /\/branches\/([^/]+)\/protection\/required_status_checks$/.exec(endpoint))) {
      if (!world.protection) throw notFound(args);
      return JSON.stringify({ contexts: world.protection, checks: [] });
    }
    if ((match = /\/compare\/([^.]+)\.\.\.([0-9a-f]{40})$/.exec(endpoint))) {
      const sha = match[2];
      return JSON.stringify({ behind: world.behind[sha] ?? 0, ahead: world.mainContains.has(sha) ? 0 : 1 });
    }
    if ((match = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(endpoint))) {
      const text = world.files[`${match[2]}:${match[1]}`];
      if (text === undefined) throw notFound(args);
      return `${Buffer.from(text).toString('base64')}\n`;
    }
    if ((match = /\/git\/ref\/tags\/(.+)$/.exec(endpoint))) {
      const sha = world.tags[match[1]];
      if (!sha) throw notFound(args);
      return JSON.stringify({ object: { type: 'commit', sha } });
    }
    if ((match = /\/git\/ref\/heads\/(.+)$/.exec(endpoint))) {
      const sha = world.branches[match[1]];
      if (!sha) throw notFound(args);
      return JSON.stringify({ object: { type: 'commit', sha } });
    }
    if ((match = /\/pulls\/(\d+)\/files/.exec(endpoint))) return lines((world.prs[match[1]]?.files ?? []).map((file) => file.path));
    throw new Error(`unexpected gh ${line}`);
  };
  return { world, calls, runner, called: (pattern) => calls.filter((call) => pattern.test(call.join(' '))) };
}

/** An open PR from `branch` at `sha`, ready to merge unless overridden. */
export function openPr(number, branch, sha, extra = {}) {
  return {
    number: Number(number), title: `fix: thing ${number}`, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN', isDraft: false,
    author: { login: OWNER }, baseRefName: 'main', headRefName: branch, headRefOid: sha, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [], files: [{ path: 'src/x.ts' }], additions: 1, deletions: 0, body: '', ...extra
  };
}
