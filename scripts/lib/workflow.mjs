// Pure helpers for the branch, review, merge and release scripts. No I/O here, so the rules
// these scripts enforce are unit tested (scripts/test/workflow.test.mjs).

/** CI job names. They are the required status checks on `main`; keep them stable. */
export const CI_CHECKS = Object.freeze(['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan']);
/** Commit status set by scripts/agent-review.mjs after the agent review team has run. */
export const AGENT_REVIEW_CONTEXT = 'agent-review';
export const REQUIRED_CHECKS = Object.freeze([...CI_CHECKS, AGENT_REVIEW_CONTEXT]);
/** Where the CI_CHECKS must come from: jobs of this workflow file, run by GitHub Actions. */
export const CI_WORKFLOW = Object.freeze({ name: 'CI', path: '.github/workflows/ci.yml', app: 'github-actions' });

export const BRANCH_PATTERN = /^(feat|fix|chore|docs)\/[a-z0-9][a-z0-9._-]*$|^(release|hotfix)\/\d+\.\d+\.\d+$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Version carried by a `release/x.y.z` or `hotfix/x.y.z` branch name, or undefined. */
export function releaseVersionFromBranch(branch) {
  const match = /^(?:release|hotfix)\/(\d+\.\d+\.\d+)$/.exec(branch ?? '');
  return match ? match[1] : undefined;
}

/**
 * Reads a review file written by the agent review team.
 *
 * Expected shape (see docs/development-workflow.md):
 *   Verdict: PASS            (or FAIL; exactly one such line, nothing else on it)
 *   Head-SHA: <40-hex commit the team reviewed>   (exactly one)
 *   - [BLOCKER] ... (open)    - [BLOCKER][RESOLVED] ... (closed)
 * Verdict and Head-SHA lines inside code fences are ignored, so quoted code cannot fake them.
 * Severity tags count everywhere, fences included, and a fence that is never closed (or is
 * closed by a different character or a shorter run) makes the structure ambiguous, which is
 * reported in `problems` so the review fails closed.
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let fence;
  const verdicts = [];
  const headShas = [];
  const problems = [];
  const openBlockers = [];
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, resolved: 0 };
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    // Every tag on the line counts: "[BLOCKER][RESOLVED] ... [BLOCKER] ..." has one open blocker.
    for (const severity of ['BLOCKER', 'MAJOR', 'MINOR', 'NIT']) {
      const resolved = line.match(new RegExp(`\\[${severity}\\]\\s*\\[RESOLVED\\]`, 'gi'))?.length ?? 0;
      const open = (line.match(new RegExp(`\\[${severity}\\]`, 'gi'))?.length ?? 0) - resolved;
      counts.resolved += resolved;
      counts[severity.toLowerCase()] += open;
      if (severity === 'BLOCKER') for (let i = 0; i < open; i += 1) openBlockers.push(line);
    }
    const marker = fenceMarker(line);
    if (fence) {
      if (marker && marker.char === fence.char && marker.length >= fence.length && marker.info === '') fence = undefined;
      continue;
    }
    if (marker) { fence = { ...marker, line: index + 1 }; continue; }
    // Emphasis and code marks are ignored: **Verdict:** PASS and Head-SHA: `<sha>` are fine.
    const plain = line.replace(/[*_`]/g, '').trim();
    if (/^verdict\b/i.test(plain)) {
      const value = /^verdict\s*:\s*(.*)$/i.exec(plain)?.[1];
      if (value === 'PASS' || value === 'FAIL') verdicts.push(value);
      else problems.push(`line ${index + 1} ("${line.slice(0, 80)}") is not exactly "Verdict: PASS" or "Verdict: FAIL"`);
    }
    if (/^head-sha\b/i.test(plain)) {
      const value = /^head-sha\s*:\s*([0-9a-f]{40})$/i.exec(plain)?.[1];
      if (value) headShas.push(value.toLowerCase());
      else problems.push(`line ${index + 1} ("${line.slice(0, 80)}") is not exactly "Head-SHA: <40-character commit>"`);
    }
  }
  if (fence) problems.push(`the code fence opened on line ${fence.line} is never closed, so the review's structure is ambiguous`);
  if (verdicts.length > 1) problems.push(`the review has ${verdicts.length} Verdict lines; it must have exactly one`);
  if (headShas.length > 1) problems.push(`the review has ${headShas.length} Head-SHA lines; it must have exactly one`);
  const verdict = verdicts.length === 1 ? verdicts[0] : undefined;
  const headSha = headShas.length === 1 ? headShas[0] : undefined;
  return { verdict, headSha, openBlockers, counts, problems, verdictLines: verdicts.length, headShaLines: headShas.length };
}

/** A CommonMark code fence line: three or more ` or ~, then an info string (no ` after backticks). */
function fenceMarker(line) {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const info = match[2].trim();
  if (match[1][0] === '`' && info.includes('`')) return undefined;
  return { char: match[1][0], length: match[1].length, info };
}

/** Decides the `agent-review` status for a parsed review and the PR's current head. */
export function reviewDecision(review, currentHeadSha) {
  const reasons = [...(review.problems ?? [])];
  if (review.verdict === 'FAIL') reasons.push('the review verdict is FAIL');
  else if (review.verdict !== 'PASS' && !review.verdictLines) reasons.push('the review file has no "Verdict: PASS" or "Verdict: FAIL" line');
  if (!review.headSha) {
    if (!review.headShaLines) reasons.push('the review file has no "Head-SHA:" line naming the commit reviewed');
  } else if (!/^[0-9a-f]{40}$/i.test(currentHeadSha ?? '')) {
    reasons.push('the current head of the PR is unknown, so the review cannot be matched to it');
  } else if (review.headSha !== currentHeadSha.toLowerCase()) {
    reasons.push(`the review covers ${review.headSha.slice(0, 7)} but the PR head is now ${currentHeadSha.slice(0, 7)}; review the new commits`);
  }
  if (review.openBlockers.length > 0) reasons.push(`${review.openBlockers.length} open BLOCKER finding(s)`);
  return { state: reasons.length === 0 ? 'success' : 'failure', reasons };
}

/**
 * Normalizes `gh pr view --json statusCheckRollup` entries (CheckRun and StatusContext) into
 * { name, state } with state one of success, pending, failure, skipped, neutral. For display in
 * the review comment only: the merge and release gates use evaluateCommit, which also checks
 * where each report comes from.
 */
export function normalizeChecks(rollup) {
  const latest = new Map();
  for (const entry of rollup ?? []) {
    let name;
    let state;
    if (entry.__typename === 'StatusContext' || entry.context !== undefined) {
      name = entry.context;
      const s = String(entry.state ?? '').toUpperCase();
      state = s === 'SUCCESS' ? 'success' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failure';
    } else {
      name = entry.name;
      const status = String(entry.status ?? '').toUpperCase();
      const conclusion = String(entry.conclusion ?? '').toUpperCase();
      if (status !== 'COMPLETED') state = 'pending';
      else if (conclusion === 'SUCCESS') state = 'success';
      else if (conclusion === 'SKIPPED') state = 'skipped';
      else if (conclusion === 'NEUTRAL') state = 'neutral';
      else state = 'failure';
    }
    if (!name) continue;
    // A run that has not finished wins over a finished one: a queued re-run has no start time.
    const startedAt = state === 'pending' ? Infinity : Date.parse(entry.startedAt ?? entry.completedAt ?? '') || 0;
    const previous = latest.get(name);
    if (!previous || startedAt >= previous.startedAt) latest.set(name, { name, state, startedAt, url: entry.detailsUrl ?? entry.targetUrl });
  }
  return [...latest.values()].map(({ name, state, url }) => ({ name, state, url }));
}

/** Every required check must be green; any other check that failed also blocks. */
export function evaluateChecks(checks, required = REQUIRED_CHECKS) {
  const problems = [];
  const byName = new Map(checks.map((check) => [check.name, check]));
  for (const name of required) {
    const check = byName.get(name);
    if (!check) problems.push(`required check "${name}" has not reported on the head commit`);
    else if (check.state !== 'success') problems.push(`required check "${name}" is ${check.state}`);
  }
  for (const check of checks) {
    if (!required.includes(check.name) && check.state === 'failure') problems.push(`check "${check.name}" failed`);
  }
  return { ok: problems.length === 0, problems };
}

// ---- The merge and release gate over one commit ------------------------------------------------

const time = (value) => Date.parse(value ?? '') || 0;
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function checkRunState(run) {
  if (String(run.status ?? '').toLowerCase() !== 'completed') return 'pending';
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  return ['success', 'skipped', 'neutral'].includes(conclusion) ? conclusion : 'failure';
}

function statusState(status) {
  const state = String(status.state ?? '').toLowerCase();
  return state === 'success' || state === 'pending' ? state : 'failure';
}

/**
 * The newest of several reports of one thing. For check runs (unfinishedFirst) an attempt that
 * has not finished always wins, since a queued re-run has no start time yet.
 */
function newest(entries, startOf, { unfinishedFirst = false } = {}) {
  const rank = (entry) => Number(unfinishedFirst && entry.state === 'pending');
  return [...entries].sort((a, b) => (rank(b) - rank(a)) || (startOf(b) - startOf(a)) || ((b.id ?? 0) - (a.id ?? 0)))[0];
}

/**
 * Decides whether the checks on one commit pass the merge or release gate.
 *
 * `commit` is what scripts/lib/gh.mjs commitChecks returns: every check run attempt
 * ({ id, name, status, conclusion, startedAt, app, suiteId }), the workflow runs on the commit
 * ({ name, path, event, suiteId }) and every commit status with who set it
 * ({ id, context, state, createdAt, creator }).
 *
 * - The CI_CHECKS count only as check runs of CI_WORKFLOW (that file, GitHub Actions). Every CI
 *   run on the commit must pass them; within one run the newest attempt counts. A report with
 *   the same name from anywhere else refuses, so a duplicate-named job cannot stand in for or
 *   mask the real one.
 * - `agent-review` counts only as a commit status set by `reviewer` (the account the scripts run
 *   as). A check run of that name, or the status set by any other account, refuses.
 * - Any other required name must be green wherever it reports; any other failed check refuses.
 * - With exactCommitCi (tagging a release), at least one CI run must have tested the commit
 *   itself (a push or a run started by hand), not only a pull request's merge with main.
 *
 * Returns { ok, problems, waiting }: `waiting` is true when the only problems are CI jobs that
 * are still running or have not reported yet.
 */
export function evaluateCommit(commit, { required = REQUIRED_CHECKS, reviewer, exactCommitCi = false } = {}) {
  const { checkRuns = [], workflowRuns = [], statuses = [] } = commit ?? {};
  const ciSuites = new Set(workflowRuns
    .filter((run) => run.name === CI_WORKFLOW.name && String(run.path ?? '').replace(/@.*$/, '') === CI_WORKFLOW.path)
    .map((run) => run.suiteId));
  const attempts = new Map();
  for (const run of checkRuns) {
    if (!run.name) continue;
    const key = `${run.suiteId}\u0000${run.name}`;
    attempts.set(key, [...(attempts.get(key) ?? []), { ...run, state: checkRunState(run) }]);
  }
  const runs = [...attempts.values()].map((list) => newest(list, (run) => time(run.startedAt ?? run.completedAt), { unfinishedFirst: true }))
    .map((run) => ({ ...run, fromCi: run.app === CI_WORKFLOW.app && ciSuites.has(run.suiteId) }));
  const reports = new Map();
  for (const status of statuses) {
    if (!status.context) continue;
    const key = `${status.context}\u0000${String(status.creator ?? '').toLowerCase()}`;
    reports.set(key, [...(reports.get(key) ?? []), { ...status, state: statusState(status) }]);
  }
  const latestStatuses = [...reports.values()].map((list) => newest(list, (status) => time(status.createdAt)));

  const problems = [];
  const block = (message) => problems.push({ message, waiting: false });
  const wait = (message) => problems.push({ message, waiting: true });
  const source = (run) => `${run.app ?? 'an unknown app'}${run.app === CI_WORKFLOW.app ? ` (check suite ${run.suiteId})` : ''}`;

  for (const name of required) {
    const named = runs.filter((run) => run.name === name);
    const namedStatuses = latestStatuses.filter((status) => status.context === name);
    if (name === AGENT_REVIEW_CONTEXT) {
      for (const run of named) block(`a check run named "${name}" comes from ${source(run)}; only a commit status set by ${reviewer ?? 'the expected account'} counts`);
      if (!reviewer) { block(`the account allowed to set "${name}" is unknown, so its status cannot be trusted`); continue; }
      for (const status of namedStatuses.filter((s) => !sameLogin(s.creator, reviewer))) {
        block(`"${name}" was also set by ${status.creator ?? 'an unknown account'}; only ${reviewer}'s status counts, so refusing`);
      }
      const own = namedStatuses.find((s) => sameLogin(s.creator, reviewer));
      if (!own) block(`"${name}" has not been set on this commit by ${reviewer}; run the agent review`);
      else if (own.state !== 'success') block(`"${name}" is ${own.state}`);
      continue;
    }
    if (CI_CHECKS.includes(name)) {
      for (const run of named.filter((r) => !r.fromCi)) block(`a check named "${name}" also comes from ${source(run)}, not the ${CI_WORKFLOW.name} workflow; refusing so it cannot stand in for the real job`);
      for (const status of namedStatuses) block(`a commit status named "${name}" was set by ${status.creator ?? 'an unknown account'}; "${name}" must come from the ${CI_WORKFLOW.name} workflow`);
      const fromCi = named.filter((r) => r.fromCi);
      if (fromCi.length === 0) wait(`required check "${name}" has not reported from the ${CI_WORKFLOW.name} workflow on this commit`);
      for (const run of fromCi) {
        if (run.state === 'pending') wait(`required check "${name}" is still running`);
        else if (run.state !== 'success') block(`required check "${name}" is ${run.state}`);
      }
      continue;
    }
    const all = [...named, ...namedStatuses];
    if (all.length === 0) wait(`required check "${name}" has not reported on this commit`);
    for (const entry of all) {
      if (entry.state === 'pending') wait(`required check "${name}" is still running`);
      else if (entry.state !== 'success') block(`required check "${name}" is ${entry.state}`);
    }
  }
  if (exactCommitCi) {
    const ciRuns = workflowRuns.filter((run) => ciSuites.has(run.suiteId));
    if (ciRuns.length === 0) wait(`no ${CI_WORKFLOW.name} run has started on this commit yet`);
    else if (!ciRuns.some((run) => run.event !== 'pull_request')) {
      block(`${CI_WORKFLOW.name} ran on this commit only as part of a pull request, which tests its merge with main; run it on the commit itself (gh workflow run ci.yml --ref <branch>) and tag once it passes`);
    }
  }
  for (const run of runs) if (!required.includes(run.name) && run.state === 'failure') block(`check "${run.name}" failed`);
  for (const status of latestStatuses) if (!required.includes(status.context) && status.state === 'failure') block(`status "${status.context}" (set by ${status.creator ?? 'an unknown account'}) failed`);

  const messages = [...new Set(problems.map((problem) => problem.message))];
  return { ok: messages.length === 0, problems: messages, waiting: problems.length > 0 && problems.every((problem) => problem.waiting) };
}

/**
 * What tagging `sha` as v<version> requires. A commit on main reached it through a reviewed PR, so
 * it needs green CI. The head of hotfix/<version> (a hotfix cut from an older tag) has not been
 * merged, so it also needs the owner's agent-review on that exact commit. Anything else is
 * refused, as the Release workflow would refuse it.
 */
export function releaseGate({ version, sha, onMain, hotfixHead }) {
  if (onMain) return { ok: true, hotfix: false, required: CI_CHECKS };
  if (hotfixHead && hotfixHead === sha) return { ok: true, hotfix: true, required: REQUIRED_CHECKS };
  return { ok: false, reason: `${sha.slice(0, 7)} is neither on main nor the head of hotfix/${version}, so the Release workflow would refuse it` };
}

/**
 * Reasons a release/x.y.z or hotfix/x.y.z PR must not merge yet, checked on its head before the
 * merge so nothing is left half done afterwards. An existing v<version> tag refuses unless the
 * merge is asked not to tag (a hotfix already released from its branch).
 */
export function releasePrProblems({ version, pkgVersion, changelog, existingTag, noTag = false }) {
  const problems = [];
  if (pkgVersion !== version) problems.push(`package.json on the branch is ${pkgVersion}, not ${version}; run: node scripts/prepare-release.mjs bump ${version}`);
  if (!changelogSection(changelog, version)) problems.push(`CHANGELOG.md on the branch has no "## ${version}" section with text`);
  if (existingTag && !noTag) {
    problems.push(`v${version} already exists on ${existingTag.slice(0, 7)}; if this hotfix was already released from its branch, merge it with --no-tag, otherwise release as the next patch version`);
  }
  return problems;
}

/** Why the state GitHub reports after a merge cannot be trusted for tagging, or undefined. */
export function mergeOutcomeProblem(state, mergeSha) {
  if (state !== 'MERGED') return `GitHub reports the PR as ${state || 'unknown'} after the merge command`;
  if (!/^[0-9a-f]{40}$/.test(mergeSha ?? '')) return `GitHub did not report the squash commit (got "${mergeSha ?? ''}")`;
  return undefined;
}

/** The body of `## <version>` in CHANGELOG.md, without the heading, or undefined. */
export function changelogSection(markdown, version) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${version.replaceAll('.', '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s/.test(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body.length > 0 ? `${body}\n` : undefined;
}

/** True when `next` is a higher x.y.z than `current`. */
export function isVersionBump(current, next) {
  if (!VERSION_PATTERN.test(current) || !VERSION_PATTERN.test(next)) return false;
  const a = current.split('.').map(Number);
  const b = next.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

/**
 * Joins the review text and the footer (verdict, CI table, head marker) into one comment within
 * GitHub's 65536-character limit. Only the end of the review text is cut; the footer is always
 * kept whole.
 */
export function fitComment(review, footer = '', limit = 65_000) {
  const join = (text) => (footer ? `${text}\n\n${footer}` : text);
  if (join(review).length <= limit) return join(review);
  const note = '\n\n_(Truncated: the full review is longer than a GitHub comment allows.)_';
  const room = Math.max(0, limit - join('').length - note.length);
  return join(`${review.slice(0, room)}${note}`);
}

// ---- Secret scanning ----------------------------------------------------------------------------

export const SECRET_RULES = Object.freeze([
  { id: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'near-private-key', pattern: /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}/ },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-live-key', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}/ },
  { id: 'azure-devops-pat', pattern: /\bVSCE_PAT\s*[:=]\s*['"]?[A-Za-z0-9]{52,}/ }
]);

/** File names that should never be committed, whatever they contain. */
export const SECRET_FILE_PATTERNS = Object.freeze([
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.near-credentials\//,
  /(^|\/)[^/]+\.(p12|pfx|keystore)$/
]);
const SECRET_FILE_EXCEPTIONS = [/(^|\/)\.env\.(example|sample|template)$/];

export const ALLOW_MARKER = 'secret-scan: allow';

/** Findings for one line of text. Lines carrying `secret-scan: allow` are skipped. */
export function scanLine(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  const found = [];
  for (const rule of SECRET_RULES) if (rule.pattern.test(line)) found.push(rule.id);
  return found;
}

export function isSecretFileName(path) {
  if (SECRET_FILE_EXCEPTIONS.some((pattern) => pattern.test(path))) return false;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Parses the allowlist: one repository path per line; `#` starts a comment. */
export function parseAllowlist(text) {
  return new Set(String(text ?? '').split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean));
}

/** Masks a matched line for logs so the scanner never prints a secret it found. */
export function maskLine(line) {
  let masked = line;
  for (const rule of SECRET_RULES) {
    const global = new RegExp(rule.pattern.source, 'g');
    masked = masked.replace(global, (match) => `${match.slice(0, 4)}…[redacted ${match.length} chars]`);
  }
  return masked.length > 200 ? `${masked.slice(0, 200)}…` : masked;
}
