// Unit tests for the rules behind the review, merge, release and secret-scan scripts.
// Fake secrets are assembled at runtime so this file never matches the scanner itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRANCH_PATTERN, CI_CHECKS, REQUIRED_CHECKS, changelogSection, evaluateChecks, fitComment, isSecretFileName,
  isVersionBump, maskLine, normalizeChecks, parseAllowlist, parseReview, releaseVersionFromBranch, reviewDecision, scanLine
} from '../lib/workflow.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('a passing review names the head it covers and has no open blocker', () => {
  const review = parseReview(`# Review\n\nVerdict: PASS\nHead-SHA: ${SHA}\n\n- [MAJOR] tighten the regex\n- [BLOCKER][RESOLVED] fixed in abc1234\n- [NIT] wording`);
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.headSha, SHA);
  assert.deepEqual(review.openBlockers, []);
  assert.deepEqual(review.counts, { blocker: 0, major: 1, minor: 0, nit: 1, resolved: 1 });
  assert.deepEqual(reviewDecision(review, SHA), { state: 'success', reasons: [] });
});

test('an open blocker fails the review even when the verdict says PASS', () => {
  const decision = reviewDecision(parseReview(`Verdict: PASS\nHead-SHA: ${SHA}\n- [BLOCKER] token logged in plain text`), SHA);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join(), /1 open BLOCKER/);
});

test('a FAIL verdict, a missing verdict, or a missing head fails the review', () => {
  assert.equal(reviewDecision(parseReview(`Verdict: FAIL\nHead-SHA: ${SHA}`), SHA).state, 'failure');
  assert.match(reviewDecision(parseReview(`Head-SHA: ${SHA}`), SHA).reasons.join(), /no "Verdict/);
  assert.match(reviewDecision(parseReview('Verdict: PASS'), SHA).reasons.join(), /no "Head-SHA/);
});

test('a review of an older head is stale once new commits are pushed', () => {
  const decision = reviewDecision(parseReview(`Verdict: PASS\nHead-SHA: ${OTHER}`), SHA);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join(), /review the new commits/);
});

test('verdicts and findings inside code fences are ignored', () => {
  const review = parseReview(`Verdict: FAIL\nHead-SHA: ${SHA}\n\`\`\`\nVerdict: PASS\n- [BLOCKER] example\n\`\`\``);
  assert.equal(review.verdict, 'FAIL');
  assert.deepEqual(review.openBlockers, []);
  assert.equal(parseReview('**Verdict:** PASS').verdict, 'PASS');
});

test('check runs and commit statuses are normalized, keeping the latest run per name', () => {
  const checks = normalizeChecks([
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T01:00:00Z' },
    { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'agent-review', state: 'SUCCESS' }
  ]);
  assert.deepEqual(checks.map(({ name, state }) => [name, state]), [['test', 'success'], ['e2e', 'pending'], ['agent-review', 'success']]);
});

test('every required check must be green, and any other failed check blocks too', () => {
  const green = REQUIRED_CHECKS.map((name) => ({ name, state: 'success' }));
  assert.deepEqual(evaluateChecks(green), { ok: true, problems: [] });
  const missingReview = green.filter((check) => check.name !== 'agent-review');
  assert.match(evaluateChecks(missingReview).problems.join(), /"agent-review" has not reported/);
  const extraFailure = [...green, { name: 'codeql', state: 'failure' }];
  assert.match(evaluateChecks(extraFailure).problems.join(), /"codeql" failed/);
  assert.match(evaluateChecks(green.map((c) => (c.name === 'e2e' ? { ...c, state: 'pending' } : c))).problems.join(), /"e2e" is pending/);
  assert.ok(CI_CHECKS.every((name) => REQUIRED_CHECKS.includes(name)));
});

test('branch names follow the convention', () => {
  for (const name of ['feat/team-mode', 'fix/proxy-hint', 'chore/dev-workflow', 'docs/readme', 'release/0.4.12', 'hotfix/0.4.13']) assert.ok(BRANCH_PATTERN.test(name), name);
  for (const name of ['main', 'feature/x', 'release/next', 'fix/', 'Fix/Thing', 'hotfix/0.4']) assert.ok(!BRANCH_PATTERN.test(name), name);
  assert.equal(releaseVersionFromBranch('release/1.2.3'), '1.2.3');
  assert.equal(releaseVersionFromBranch('hotfix/1.2.4'), '1.2.4');
  assert.equal(releaseVersionFromBranch('feat/1.2.3'), undefined);
});

test('the changelog section for a version is extracted without its heading', () => {
  const md = '# Changelog\n\n## 0.4.12\n\nNew things.\n\n- one\n\n## 0.4.11\n\nOld things.\n';
  assert.equal(changelogSection(md, '0.4.12'), 'New things.\n\n- one\n');
  assert.equal(changelogSection(md, '0.4.11'), 'Old things.\n');
  assert.equal(changelogSection(md, '0.4.1'), undefined);
});

test('version bumps must go up', () => {
  assert.ok(isVersionBump('0.4.11', '0.4.12'));
  assert.ok(isVersionBump('0.4.11', '0.5.0'));
  assert.ok(!isVersionBump('0.4.11', '0.4.11'));
  assert.ok(!isVersionBump('0.4.11', '0.4.9'));
  assert.ok(!isVersionBump('0.4.11', 'v0.4.12'));
});

test('long review comments are truncated to fit GitHub', () => {
  const body = fitComment('x'.repeat(70_000));
  assert.ok(body.length <= 65_000);
  assert.match(body, /Truncated/);
});

test('the secret scan catches common key formats and masks them in its output', () => {
  const gh = ['ghp', '_', 'Z'.repeat(36)].join('');
  const near = ['ed25519', ':', '3'.repeat(88)].join('');
  const pem = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
  const aws = ['AKIA', 'Q'.repeat(16)].join('');
  assert.deepEqual(scanLine(`token = "${gh}"`), ['github-token']);
  assert.deepEqual(scanLine(near), ['near-private-key']);
  assert.deepEqual(scanLine(pem), ['private-key']);
  assert.deepEqual(scanLine(aws), ['aws-access-key']);
  assert.deepEqual(scanLine(`${gh} // secret-scan: allow`), []);
  assert.deepEqual(scanLine('ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp'), [], 'a NEAR public key is not a secret');
  const masked = maskLine(`token = "${gh}"`);
  assert.ok(!masked.includes(gh));
  assert.match(masked, /redacted 40 chars/);
});

test('committed credential files are flagged by name', () => {
  for (const path of ['.env', 'app/.env.production', 'id_rsa', 'home/.near-credentials/mainnet/a.json', 'cert.p12']) assert.ok(isSecretFileName(path), path);
  for (const path of ['.env.example', 'src/env.ts', 'docs/id_rsa.md']) assert.ok(!isSecretFileName(path), path);
});

test('the allowlist is one path per line with comments', () => {
  assert.deepEqual([...parseAllowlist('# header\nsrc/a.ts   # fake key\n\n test/b.pem\n')], ['src/a.ts', 'test/b.pem']);
});
