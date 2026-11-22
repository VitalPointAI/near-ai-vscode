// Checks on the GitHub Actions workflow files that the rest of the process relies on. There is
// no YAML parser in the dependencies, so these read the files as text, split into top-level
// keys and jobs by indentation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

/** The lines of a block that starts at `key:` with the given indentation, without the key line. */
function block(text, key, indent = 0) {
  const lines = text.split('\n');
  const pad = ' '.repeat(indent);
  const start = lines.findIndex((line) => line === `${pad}${key}:` || line.startsWith(`${pad}${key}: `));
  if (start < 0) return undefined;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(`${pad} `) && !line.trimStart().startsWith('#')) break;
    body.push(line);
  }
  return [lines[start], ...body].join('\n');
}

test('CI runs on main never share a concurrency group, so none is cancelled', () => {
  const concurrency = block(read('ci.yml'), 'concurrency');
  assert.ok(concurrency, 'ci.yml has a concurrency block');
  const group = /group:\s*(.+)/.exec(concurrency)?.[1] ?? '';
  // Pull requests share a group per PR; every other run gets its own group (the run id), because
  // GitHub cancels a queued run in a shared group whenever a newer one arrives, even with
  // cancel-in-progress false.
  assert.match(group, /github\.event_name == 'pull_request' && format\('[^']*\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(group, /\|\| format\('[^']*\{0\}', github\.run_id\)/);
  assert.doesNotMatch(group, /github\.ref\b/);
  assert.match(concurrency, /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/);
});

/** Each job of a workflow, by id, as its block of text. */
function jobs(text) {
  const body = block(text, 'jobs');
  assert.ok(body, 'the workflow has jobs');
  const result = new Map();
  let current;
  for (const line of body.split('\n').slice(1)) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (id) { current = id; result.set(id, ''); continue; }
    if (current) result.set(current, `${result.get(current)}${line}\n`);
  }
  return result;
}

/** The `- uses:` / `- name:` / `- run:` steps of a job, in order, as text. */
function steps(job) {
  return job.split(/\n(?= {6}- )/).slice(1);
}

test('release jobs that hold a write token or VSCE_PAT run no npm install scripts and no npm cache', () => {
  const all = jobs(read('release.yml'));
  const privileged = [...all].filter(([, job]) => /contents:\s*write|environment:|secrets\.VSCE_PAT/.test(job));
  assert.ok(privileged.length >= 2, 'the release and publish jobs are found');
  for (const [id, job] of privileged) {
    for (const line of job.split('\n').filter((l) => /\bnpm (ci|install|i)\b/.test(l))) {
      assert.match(line, /--ignore-scripts/, `${id}: ${line.trim()}`);
    }
    assert.doesNotMatch(job, /cache:\s*npm/, `${id} must not restore an npm cache`);
  }
  assert.doesNotMatch(all.get('build'), /contents:\s*write/, 'build, which runs npm ci with scripts, is read-only');
  const writers = [...all].filter(([, job]) => /contents:\s*write/.test(job)).map(([id]) => id);
  for (const id of writers) assert.doesNotMatch(all.get(id), /npm (ci|install|test|run)|actions\/checkout/, `${id} only handles the built artifact`);
});

test('publish checks the VSIX checksum from the build job before it does anything else', () => {
  const publish = jobs(read('release.yml')).get('publish');
  const list = steps(publish);
  assert.match(list[0], /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(list[1], /sha256sum --check/);
  assert.match(list[1], /needs\.build\.outputs\.sha256/, 'the expected checksum comes from the build job, not the artifact');
  assert.match(publish, /environment:\s*\n\s*name: marketplace/);
  assert.equal((publish.match(/secrets\.VSCE_PAT/g) ?? []).length, 1);
});

test('a release tag never replaces an existing GitHub release or its files', () => {
  const text = read('release.yml');
  assert.doesNotMatch(text, /--clobber/);
  assert.doesNotMatch(text, /gh release (upload|edit|delete)/);
  const all = jobs(text);
  for (const id of ['build', 'release']) {
    assert.match(all.get(id), /if gh release view "\$TAG"[^\n]*; then\s*\n\s*echo "::error::[^"]*already exists[^"]*"; exit 1/, `${id} refuses an existing release`);
  }
  assert.match(all.get('release'), /gh release create "\$TAG"[^\n]*--verify-tag/);
});

test('the release notes are checked against a checksum from the build job, like the VSIX', () => {
  const all = jobs(read('release.yml'));
  assert.match(all.get('build'), /notes_sha256=/, 'build records the notes checksum as an output');
  assert.match(all.get('build'), /notes_sha256: \$\{\{ steps\.checksum\.outputs\.notes_sha256 \}\}/);
  const check = steps(all.get('release')).find((step) => /sha256sum --check/.test(step));
  assert.ok(check, 'release checks checksums');
  assert.match(check, /needs\.build\.outputs\.notes_sha256/);
  assert.match(check, /release-notes\.md/);
  const order = steps(all.get('release'));
  assert.ok(order.indexOf(check) < order.findIndex((step) => /gh release create/.test(step)), 'checked before the release is created');
});

test('the release workflow does not claim protections that depend on settings not yet applied', () => {
  const header = read('release.yml').split('\nname:')[0];
  assert.doesNotMatch(header, /Only the owner can create v\* tags/);
  assert.match(header, /organization owners/);
  assert.match(header, /once the tag rulesets .* are applied/is);
});

test('the agent review workflow posts and approves only as near-ai-reviewer, from main', async () => {
  const { REVIEW_ACCOUNT } = await import('../lib/workflow.mjs');
  assert.equal(REVIEW_ACCOUNT, 'near-ai-reviewer');
  const text = read('agent-review.yml');
  const all = jobs(text);
  assert.deepEqual([...all.keys()], ['review', 'owner-approval', 'approve']);
  assert.match(block(text, 'permissions'), /permissions:\s*\n\s*contents: read\s*$/, 'the GITHUB_TOKEN only reads');
  for (const id of ['review', 'approve']) {
    const job = all.get(id);
    assert.match(job, /environment: agent-review\n/, `${id} runs in the agent-review environment`);
    assert.match(job, /GH_TOKEN: \$\{\{ secrets\.NEAR_AI_REVIEW_TOKEN \}\}/, `${id} acts as the reviewer identity`);
    assert.match(job, /GH_REPO: \$\{\{ github\.repository \}\}/, `${id} names the repository for gh`);
    assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, `${id} runs the scripts from main`);
  }
  const review = all.get('review');
  assert.match(review, /REVIEW_MODEL_API_KEY: \$\{\{ secrets\.REVIEW_MODEL_API_KEY \}\}/);
  assert.match(review, /REVIEW_MODEL: \$\{\{ vars\.REVIEW_MODEL \}\}/);
  assert.match(review, /REVIEW_MODEL_BASE_URL: \$\{\{ vars\.REVIEW_MODEL_BASE_URL \}\}/);
  assert.match(review, /\^\[0-9\]\+\$/, 'a dispatched PR number is validated');
  assert.match(review, /--expected-head "\$EXPECTED_HEAD"/, 'a PR whose head moved after CI is skipped');
  // The gate holds no secrets and is the owner's click.
  const gate = all.get('owner-approval');
  assert.match(gate, /environment: agent-review-gates/);
  assert.match(gate, /needs\.review\.outputs\.gate == 'true'/);
  assert.doesNotMatch(gate, /secrets\./, 'agent-review-gates holds no secrets');
  assert.match(gate, /permissions: \{\}/);
  // The approval needs the review's own success, and the owner's for a gate change.
  const approve = all.get('approve');
  assert.match(approve, /needs: \[review, owner-approval\]/);
  assert.match(approve, /needs\.review\.outputs\.state == 'success'/);
  assert.match(approve, /needs\.review\.outputs\.gate != 'true' \|\| needs\.owner-approval\.result == 'success'/);
  assert.match(approve, /ci-review-run\.mjs approve "\$PR" --sha "\$SHA"/);
  assert.doesNotMatch(approve, /\|\| echo/, 'a failed approval is not masked');
  // No expression is expanded inside a run script, where it could inject shell.
  for (const [id, job] of all) {
    for (const step of steps(job)) {
      // In these steps `run:` is the last key, so the script is everything after it.
      const run = /\n\s+run: ?\|?([\s\S]*)$/.exec(step)?.[1] ?? '';
      assert.doesNotMatch(run, /\$\{\{/, `${id}: no \${{ }} inside a run script`);
    }
  }
});

test('the review\'s shared time budget ends inside the review job\'s limit, so a stalled review posts its failure', async () => {
  const { REVIEW_BUDGET_SECONDS, REVIEW_JOB_MARGIN_MINUTES } = await import('../lib/ci-review.mjs');
  const review = jobs(read('agent-review.yml')).get('review');
  const limit = Number(/timeout-minutes:\s*(\d+)/.exec(review)?.[1]);
  assert.ok(limit > 0 && limit <= 360, 'the review job has a limit within GitHub\'s 360 minutes');
  assert.ok(REVIEW_BUDGET_SECONDS / 60 + REVIEW_JOB_MARGIN_MINUTES <= limit,
    `the model budget (${REVIEW_BUDGET_SECONDS / 60} minutes) plus ${REVIEW_JOB_MARGIN_MINUTES} minutes for the rest fits the job's ${limit} minutes`);
});

test('compliance is a report-only aggregate job with safe evidence handling', () => {
  const job = jobs(read('ci.yml')).get('compliance');
  assert.ok(job, 'compliance job exists');
  for (const need of ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'docs', 'relay', 'hub', 'relay-image-scan']) assert.match(job, new RegExp(`\\b${need}\\b`));
  assert.match(job, /if:\s*always\(\)/);
  assert.match(job, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  assert.match(job, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(job, /secret-scan\.mjs --dir/);
  assert.match(job, /FAIL_ON_DROP:/);
  assert.match(job, /npm audit[\s\S]*continue-on-error: true|continue-on-error: true[\s\S]*npm audit/);
});

test('root, relay and hub test reports are always uploaded without changing required checks', async () => {
  const all = jobs(read('ci.yml'));
  for (const id of ['test', 'relay', 'hub']) {
    const job = all.get(id);
    assert.match(job, /NEAR_AI_TEST_REPORT/);
    assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(job, /if:\s*always\(\)/);
    assert.match(job, /continue-on-error:\s*true/);
  }
  const { CI_CHECKS } = await import('../lib/workflow.mjs');
  assert.ok(!CI_CHECKS.includes('compliance') && !CI_CHECKS.includes('relay-image-scan'));
});

test('scheduled and CodeQL workflows are pinned, least-privilege and never PR-triggered evidence jobs', async () => {
  const scheduled = read('compliance-scheduled.yml');
  const codeql = read('codeql.yml');
  for (const text of [read('ci.yml'), scheduled, codeql, read('release.yml')]) {
    for (const match of text.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)) assert.match(match[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(block(scheduled, 'on'), /pull_request/);
  const daily = jobs(scheduled).get('daily-evidence');
  assert.match(daily, /environment:\s*compliance-settings/);
  assert.equal((scheduled.match(/COMPLIANCE_SETTINGS_TOKEN/g) ?? []).length, 1);
  assert.match(jobs(codeql).get('codeql'), /contents:\s*read[\s\S]*security-events:\s*write/);
  assert.match(codeql, /languages:\s*javascript-typescript/);
  assert.match(codeql, /build-mode:\s*none/);
  const { CI_CHECKS } = await import('../lib/workflow.mjs');
  for (const id of jobs(scheduled).keys()) assert.ok(!CI_CHECKS.includes(id));
});

test('relay image scan uses only the pinned installers and keeps findings report-only', () => {
  const job = jobs(read('ci.yml')).get('relay-image-scan');
  assert.ok(job);
  assert.match(job, /docker build[^\n]*near-ai-relay:scan/);
  assert.match(job, /compliance\/ci\/install-tool\.sh syft/);
  assert.match(job, /compliance\/ci\/install-tool\.sh grype/);
  assert.match(job, /grype db update/);
  assert.match(job, /--fail-on high/);
  assert.match(job, /continue-on-error:\s*true/);
  assert.doesNotMatch(job, /curl[^\n]*\|\s*(?:sh|bash)|wget[^\n]*\|\s*(?:sh|bash)/);
});

test('release package, attest and Trestle jobs keep privilege separated', () => {
  const text = read('release.yml');
  const all = jobs(text);
  const pkg = all.get('package'); const attest = all.get('attest'); const trestle = all.get('trestle'); const release = all.get('release');
  assert.match(pkg, /contents:\s*read[\s\S]*actions:\s*read/);
  assert.match(pkg, /npm --prefix compliance ci --ignore-scripts/);
  assert.match(attest, /needs:\s*\[build, package\]/);
  assert.match(attest, /contents:\s*read[\s\S]*id-token:\s*write[\s\S]*attestations:\s*write/);
  assert.equal((text.match(/id-token:\s*write/g) ?? []).length, 1);
  assert.match(attest, /sha256sum --check/);
  assert.match(attest, /actions\/attest@[0-9a-f]{40}/);
  assert.match(trestle, /--require-hashes --no-deps/);
  assert.match(trestle, /continue-on-error:\s*true/);
  assert.match(release, /needs:\s*\[build, package, attest\]/);
  assert.match(release, /package_sha256/);
});

test('CODEOWNERS routes all compliance gate paths to one owner', () => {
  const text = readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');
  for (const path of ['/.github/', '/SECURITY.md', '/scripts/lib/', '/scripts/test/', '/compliance/tailoring/', '/compliance/sources.json', '/compliance/catalogs/', '/compliance/attestations/']) {
    assert.match(text, new RegExp(`^${path.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s+@ALuhning\\s*$`, 'm'));
  }
});

test('new workflow shell scripts receive GitHub values only through env', () => {
  for (const name of ['ci.yml', 'compliance-scheduled.yml', 'codeql.yml', 'release.yml']) {
    for (const [id, job] of jobs(read(name))) for (const step of steps(job)) {
      const run = /\n\s+run: ?\|?([\s\S]*)$/.exec(step)?.[1] ?? '';
      assert.doesNotMatch(run, /\$\{\{/, `${name} ${id}: no GitHub expression inside a run script`);
    }
  }
});
