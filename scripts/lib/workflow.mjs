// Pure helpers for the branch, review, merge and release scripts. No I/O here, so the rules
// these scripts enforce are unit tested (scripts/test/workflow.test.mjs).

/** CI job names. They are the required status checks on `main`; keep them stable. */
export const CI_CHECKS = Object.freeze(['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan']);
/** Commit status set by scripts/agent-review.mjs after the agent review team has run. */
export const AGENT_REVIEW_CONTEXT = 'agent-review';
/**
 * The only GitHub account whose `agent-review` status the merge and release gates trust: the
 * repository owner, whose account the review agents run as. Fixed here rather than taken from
 * whoever runs a script, so another admin running merge-pr cannot have their own status
 * accepted. Changing it is a change to the gates and goes through review like one.
 */
export const AGENT_REVIEW_ACCOUNT = 'ALuhning';
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
 * Each line is first normalized the way GitHub shows it (normalizeReviewLine), so an escaped,
 * spaced, fullwidth or zero-width-split [BLOCKER] still counts, and a tag written with lookalike
 * letters from another script is reported in `problems`.
 * Verdict and Head-SHA lines inside code fences are ignored, so quoted code cannot fake them.
 * Severity tags count everywhere, fences and HTML comments included. Anything GitHub would show
 * differently from how it is read here is reported in `problems`, so the review fails closed:
 * a fence never closed (or closed by a different character or a shorter run), a fence-like line
 * indented 4 or more spaces (text or code on GitHub, never a fence), a Verdict or Head-SHA inside
 * an HTML comment, a quote, a list item or an indented block, and an HTML comment never closed.
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let fence;
  const verdicts = [];
  const headShas = [];
  const problems = [];
  const openBlockers = [];
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, resolved: 0 };
  let comment;
  for (const [index, raw] of lines.entries()) {
    const full = normalizeReviewLine(raw);
    const line = full.trim();
    // Every tag on the line counts: "[BLOCKER][RESOLVED] ... [BLOCKER] ..." has one open blocker.
    const tags = severityTags(line);
    for (const [i, tag] of tags.entries()) {
      if (tag.lookalike) {
        problems.push(`line ${index + 1} ("${line.slice(0, 80)}") has a tag that looks like [${tag.lookalike}] but is not written in plain letters; write severity tags as plain ASCII`);
      }
      if (!SEVERITIES.includes(tag.word)) continue;
      const next = tags[i + 1];
      if (next?.word === 'RESOLVED' && /^[\s*_]*$/.test(line.slice(tag.end, next.start))) counts.resolved += 1;
      else {
        counts[tag.word.toLowerCase()] += 1;
        if (tag.word === 'BLOCKER') openBlockers.push(line);
      }
    }
    if (fence) {
      // A closing fence may be indented at most 3 spaces; a deeper one is content.
      const marker = indentOf(full) <= 3 ? fenceMarker(line) : undefined;
      if (marker && marker.char === fence.char && marker.length >= fence.length && marker.info === '') fence = undefined;
      continue;
    }
    // HTML comments are not shown on GitHub, so a Verdict or Head-SHA inside one is refused.
    const startsInComment = Boolean(comment);
    const parts = splitComments(full, startsInComment);
    if (!startsInComment && parts.open) comment = { line: index + 1 };
    if (!parts.open) comment = undefined;
    if (/\b(?:verdict|head-sha)\s*:/i.test(parts.hidden.replace(/[*_`]/g, ''))) {
      problems.push(`line ${index + 1} has a Verdict or Head-SHA inside an HTML comment, which GitHub does not show; remove it`);
    }
    const visible = parts.visible.trim();
    if (!visible) continue;
    const indent = startsInComment ? 0 : indentOf(parts.visible);
    const marker = fenceMarker(visible);
    if (marker && indent <= 3) { fence = { ...marker, line: index + 1 }; continue; }
    if (marker) {
      problems.push(`line ${index + 1} looks like a code fence but is indented 4 or more spaces, so GitHub may show it as text; indent code fences by at most 3 spaces`);
    }
    // Emphasis and code marks are ignored: **Verdict:** PASS and Head-SHA: `<sha>` are fine.
    const plain = visible.replace(/[*_`]/g, '').trim();
    // A Verdict or Head-SHA inside a quote, a list item or an indented block is shown as part of
    // that block, not as the review's own line, so it is refused rather than guessed at.
    const unwrapped = plain.replace(/^(?:(?:>|[-+*]|\d{1,9}[.)])\s*)+/, '');
    if ((indent > 3 || unwrapped !== plain) && /^(?:verdict|head-sha)\s*:/i.test(unwrapped)) {
      problems.push(`line ${index + 1} ("${line.slice(0, 80)}") has a Verdict or Head-SHA inside a quote, list or indented block; put it on its own line, not indented`);
      continue;
    }
    if (indent > 3) continue;
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
  if (comment) problems.push(`the HTML comment opened on line ${comment.line} is never closed, so GitHub hides everything after it`);
  if (verdicts.length > 1) problems.push(`the review has ${verdicts.length} Verdict lines; it must have exactly one`);
  if (headShas.length > 1) problems.push(`the review has ${headShas.length} Head-SHA lines; it must have exactly one`);
  const verdict = verdicts.length === 1 ? verdicts[0] : undefined;
  const headSha = headShas.length === 1 ? headShas[0] : undefined;
  return { verdict, headSha, openBlockers, counts, problems, verdictLines: verdicts.length, headShaLines: headShas.length };
}

const SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'NIT'];
const TAG_WORDS = [...SEVERITIES, 'RESOLVED'];
// Characters GitHub shows as nothing (zero-width, joiners, bidi controls, variation selectors).
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
// Brackets that look like [ and ] (fullwidth ones are already mapped by NFKC).
const OPEN_LIKE = /[\u2045\u2772\u27E6\u27EC\u2983\u2985\u298B\u298D\u298F\u3010\u3014\u3016\u3018\u301A]/g;
const CLOSE_LIKE = /[\u2046\u2773\u27E7\u27ED\u2984\u2986\u298C\u298E\u2990\u3011\u3015\u3017\u3019\u301B]/g;
// Cyrillic and Greek capitals and small letters that look like Latin ones.
const CONFUSABLE = new Map(Object.entries({
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', к: 'k', м: 'm', н: 'h', т: 't',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ν: 'v', ι: 'i', κ: 'k', İ: 'I', ı: 'i'
}));

/**
 * A review line as a reader sees it on GitHub: compatibility forms folded (NFKC turns fullwidth
 * brackets and letters into ASCII), invisible characters removed, bracket entities and
 * lookalike brackets turned into [ and ], and backslash escapes before brackets dropped.
 */
export function normalizeReviewLine(line) {
  return String(line ?? '').normalize('NFKC').replace(INVISIBLE, '')
    .replace(/&(?:#0*91|#x0*5b|lbrack|lsqb);/gi, '[').replace(/&(?:#0*93|#x0*5d|rbrack|rsqb);/gi, ']')
    .replace(OPEN_LIKE, '[').replace(CLOSE_LIKE, ']')
    .replace(/\\(?=[[\]])/g, '');
}

/**
 * The bracketed tags on a normalized line, in order. `word` is the ASCII letters inside, upper
 * case, so [ BLOCKER ], [**blocker**] and [BLOCKER] are all BLOCKER. `lookalike` names the tag a
 * bracket imitates with letters from another script (fail closed: the review is refused).
 */
function severityTags(line) {
  const tags = [];
  for (const match of line.matchAll(/\[([^[\]]{0,40})\]/g)) {
    const letters = match[1].replace(/[^\p{L}]/gu, '');
    const word = /^[A-Za-z]*$/.test(letters) ? letters.toUpperCase() : '';
    let lookalike;
    if (!word && letters) {
      const latin = [...letters].map((c) => CONFUSABLE.get(c) ?? c).join('').toUpperCase();
      lookalike = TAG_WORDS.find((tag) => latin === tag
        || (latin.length === tag.length && [...latin].filter((c, i) => c === tag[i]).length >= tag.length - (tag.length >= 7 ? 2 : 1)));
    }
    tags.push({ word, lookalike, start: match.index, end: match.index + match[0].length });
  }
  return tags;
}

/** Leading indentation in columns, a tab advancing to the next multiple of 4. */
function indentOf(line) {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/**
 * Splits a line into the text GitHub shows and the text inside HTML comments (<!-- ... -->),
 * given whether a comment is already open. Comment markers inside inline code do not count.
 * Returns { visible, hidden, open } with `open` true when a comment is still open at the end.
 */
function splitComments(line, open) {
  // Blank out inline code spans (same length) so their contents cannot open or close a comment.
  const scan = line.replace(/(`+)(?:(?!\1)[^\n])*?\1/g, (span) => ' '.repeat(span.length));
  let visible = '';
  let hidden = '';
  let at = 0;
  while (at < line.length) {
    const next = scan.indexOf(open ? '-->' : '<!--', at);
    const end = next < 0 ? line.length : next;
    if (open) hidden += line.slice(at, end); else visible += line.slice(at, end);
    if (next < 0) break;
    at = next + (open ? 3 : 4);
    open = !open;
  }
  return { visible, hidden, open };
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

const CONCLUSIONS = ['success', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'failure'];
/** pending until it finished; then its conclusion (cancelled stays cancelled), unknown ones as failure. */
function checkRunState(run) {
  if (String(run.status ?? '').toLowerCase() !== 'completed') return 'pending';
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  return CONCLUSIONS.includes(conclusion) ? conclusion : 'failure';
}
const failed = (state) => !['success', 'skipped', 'neutral', 'pending'].includes(state);

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
 * ({ id, name, path, event, status, conclusion, suiteId }) and every commit status with who set it
 * ({ id, context, state, createdAt, creator }).
 *
 * - The CI_CHECKS count only as check runs of CI_WORKFLOW (that file, GitHub Actions). For the
 *   merge gate every CI run on the commit must pass them; within one run the newest attempt
 *   counts. A report with
 *   the same name from anywhere else refuses, so a duplicate-named job cannot stand in for or
 *   mask the real one.
 * - `agent-review` counts only as a commit status set by `reviewer` (AGENT_REVIEW_ACCOUNT in the
 *   scripts). A check run of that name, or the status set by any other account, refuses.
 * - Any other required name must be green wherever it reports; any other failed check refuses.
 * - With exactCommitCi (tagging a release), the CI_CHECKS are judged only on the newest CI run
 *   that tested the commit itself (a push or a run started by hand), not a pull request's merge
 *   with main. That run must have finished with conclusion success and every CI job green:
 *   queued or running is waited for; cancelled, startup_failure, a failed or missing job refuse.
 *
 * Returns { ok, problems, waiting }: `waiting` is true when the only problems are CI jobs that
 * are still running or have not reported yet.
 */
export function evaluateCommit(commit, { required = REQUIRED_CHECKS, reviewer, exactCommitCi = false } = {}) {
  const { checkRuns = [], workflowRuns = [], statuses = [] } = commit ?? {};
  const ciWorkflowRuns = workflowRuns
    .filter((run) => run.name === CI_WORKFLOW.name && String(run.path ?? '').replace(/@.*$/, '') === CI_WORKFLOW.path);
  const ciSuites = new Set(ciWorkflowRuns.map((run) => run.suiteId));
  const runIdOfSuite = new Map(ciWorkflowRuns.map((run) => [run.suiteId, run.id]));
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
  const inRun = (run) => {
    const id = runIdOfSuite.get(run.suiteId);
    return id === undefined ? '' : ` in ${CI_WORKFLOW.name} run ${id} (gh run rerun ${id} --failed)`;
  };

  // Which CI runs judge the CI_CHECKS. For the merge gate, every CI run on the commit. For tagging
  // (exactCommitCi), only the newest run that tested the commit itself (a push or a run started
  // by hand): it must have finished, with conclusion success, and every CI job in it green.
  // Pull request runs test the PR merged with main, not the commit, so they do not count there.
  let judged = ciSuites;
  let judgedRunDone = false;
  if (exactCommitCi) {
    const own = ciWorkflowRuns.filter((run) => run.event !== 'pull_request').sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    judged = new Set(own.slice(0, 1).map((run) => run.suiteId));
    if (ciWorkflowRuns.length === 0) wait(`no ${CI_WORKFLOW.name} run has started on this commit yet`);
    else if (own.length === 0) {
      block(`${CI_WORKFLOW.name} ran on this commit only as part of a pull request, which tests its merge with main; run it on the commit itself (gh workflow run ci.yml --ref <branch>) and tag once it passes`);
    } else {
      const latest = own[0];
      const status = String(latest.status ?? '').toLowerCase();
      const conclusion = String(latest.conclusion ?? '').toLowerCase();
      if (status !== 'completed') wait(`${CI_WORKFLOW.name} run ${latest.id} on this commit is ${status || 'not finished'}`);
      else {
        judgedRunDone = true;
        if (conclusion !== 'success') block(`${CI_WORKFLOW.name} run ${latest.id} on this commit ended ${conclusion || 'without a conclusion'}; re-run it (gh run rerun ${latest.id}) or start a new one, and tag once it passes`);
      }
    }
  }

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
      const fromCi = named.filter((r) => r.fromCi && judged.has(r.suiteId));
      if (fromCi.length === 0) {
        const missing = `required check "${name}" has not reported from the ${CI_WORKFLOW.name} workflow on this commit`;
        if (judgedRunDone) block(`${missing}, and the run has finished`);
        else wait(missing);
      }
      for (const run of fromCi) {
        if (run.state === 'pending') wait(`required check "${name}" is still running`);
        else if (run.state !== 'success') block(`required check "${name}" is ${run.state}${inRun(run)}`);
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
  for (const run of runs) if (!required.includes(run.name) && failed(run.state)) block(`check "${run.name}" ${run.state === 'failure' ? 'failed' : `is ${run.state}`}`);
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

/** The highest x.y.z among `v<x.y.z>` tags in `git ls-remote --tags` output, or undefined. */
export function latestReleaseVersion(lsRemoteOutput) {
  const versions = String(lsRemoteOutput ?? '').split('\n')
    .map((line) => /\trefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim())?.[1])
    .filter(Boolean);
  return versions.reduce((best, version) => (best === undefined || isVersionBump(best, version) ? version : best), undefined);
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

/** The ids of every secret rule a line matches, whether or not it carries the allow marker. */
export function matchRules(line) {
  return SECRET_RULES.filter((rule) => rule.pattern.test(line)).map((rule) => rule.id);
}

/** Findings for one line of text. Lines carrying `secret-scan: allow` are skipped. */
export function scanLine(line) {
  return line.includes(ALLOW_MARKER) ? [] : matchRules(line);
}

export function isSecretFileName(path) {
  if (SECRET_FILE_EXCEPTIONS.some((pattern) => pattern.test(path))) return false;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Parses the allowlist: one entry per line, `<path> <rule>[,<rule>...]`, and `#` starts a
 * comment. Returns a Map from path to the Set of rule ids (SECRET_RULES ids or
 * `secret-file-name`) that may match in that file; every other rule is still reported there.
 */
export function parseAllowlist(text) {
  const known = new Set([...SECRET_RULES.map((rule) => rule.id), 'secret-file-name']);
  const allow = new Map();
  for (const [index, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [file, rules = '', ...extra] = line.split(/\s+/);
    if (!rules || extra.length > 0) throw new Error(`secret-scan allowlist line ${index + 1}: "${file}" names no rules; write "<path> <rule>[,<rule>...]"`);
    const ids = rules.split(',').filter(Boolean);
    for (const id of ids) if (!known.has(id)) throw new Error(`secret-scan allowlist line ${index + 1}: unknown rule "${id}"`);
    allow.set(file, new Set([...(allow.get(file) ?? []), ...ids]));
  }
  return allow;
}

/** True when the allowlist lets `rule` match in `file`. */
export function isAllowed(allow, file, rule) {
  return allow.get(file)?.has(rule) ?? false;
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
