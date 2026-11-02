// Pure helpers for the branch, review, merge and release scripts. No I/O here, so the rules
// these scripts enforce are unit tested (scripts/test/workflow.test.mjs).

/** CI job names. They are the required status checks on `main`; keep them stable. */
export const CI_CHECKS = Object.freeze(['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan']);
/** Commit status set by scripts/agent-review.mjs after the agent review team has run. */
export const AGENT_REVIEW_CONTEXT = 'agent-review';
export const REQUIRED_CHECKS = Object.freeze([...CI_CHECKS, AGENT_REVIEW_CONTEXT]);

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
 *   Verdict: PASS | FAIL
 *   Head-SHA: <40-hex commit the team reviewed>
 *   - [BLOCKER] ... (open)    - [BLOCKER][RESOLVED] ... (closed)
 * Lines inside ``` fences are ignored, so quoted code cannot fake a verdict or a finding.
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let inFence = false;
  let verdict;
  let headSha;
  const openBlockers = [];
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, resolved: 0 };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const verdictMatch = /^\**verdict\**\s*:\s*\**\s*(PASS|FAIL)\b/i.exec(line);
    if (verdictMatch && verdict === undefined) verdict = verdictMatch[1].toUpperCase();
    const shaMatch = /^\**head-sha\**\s*:\s*`?([0-9a-f]{40})`?/i.exec(line);
    if (shaMatch && headSha === undefined) headSha = shaMatch[1].toLowerCase();
    for (const severity of ['BLOCKER', 'MAJOR', 'MINOR', 'NIT']) {
      const tag = new RegExp(`\\[${severity}\\]`, 'i');
      if (!tag.test(line)) continue;
      const resolved = new RegExp(`\\[${severity}\\]\\s*\\[RESOLVED\\]`, 'i').test(line);
      if (resolved) { counts.resolved += 1; continue; }
      counts[severity.toLowerCase()] += 1;
      if (severity === 'BLOCKER') openBlockers.push(line);
    }
  }
  return { verdict, headSha, openBlockers, counts };
}

/** Decides the `agent-review` status for a parsed review and the PR's current head. */
export function reviewDecision(review, currentHeadSha) {
  const reasons = [];
  if (!review.verdict) reasons.push('the review file has no "Verdict: PASS" or "Verdict: FAIL" line');
  else if (review.verdict !== 'PASS') reasons.push('the review verdict is FAIL');
  if (!review.headSha) reasons.push('the review file has no "Head-SHA:" line naming the commit reviewed');
  else if (currentHeadSha && review.headSha !== currentHeadSha.toLowerCase()) {
    reasons.push(`the review covers ${review.headSha.slice(0, 7)} but the PR head is now ${currentHeadSha.slice(0, 7)}; review the new commits`);
  }
  if (review.openBlockers.length > 0) reasons.push(`${review.openBlockers.length} open BLOCKER finding(s)`);
  return { state: reasons.length === 0 ? 'success' : 'failure', reasons };
}

/**
 * Normalizes `gh pr view --json statusCheckRollup` entries (CheckRun and StatusContext) into
 * { name, state } with state one of success, pending, failure, skipped, neutral.
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
    const startedAt = Date.parse(entry.startedAt ?? entry.completedAt ?? '') || 0;
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

/** GitHub comments are limited to 65536 characters. */
export function fitComment(body, limit = 65_000) {
  if (body.length <= limit) return body;
  const note = '\n\n_(Truncated: the full review is longer than a GitHub comment allows.)_\n';
  return body.slice(0, limit - note.length) + note;
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
