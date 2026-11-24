// Checks on the GitHub Actions workflow files that the rest of the process relies on. There is
// no YAML parser in the dependencies, so these read the files as text, split into top-level
// keys and jobs by indentation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('release jobs that hold a write token or deployment approval run no npm install scripts and no npm cache', () => {
  const all = jobs(read('release.yml'));
  const privileged = [...all].filter(([, job]) => /(?:contents|packages):\s*write|environment:/.test(job));
  assert.ok(privileged.length >= 2, 'the release and publish jobs are found');
  for (const [id, job] of privileged) {
    for (const line of job.split('\n').filter((l) => /\bnpm (ci|install|i)\b/.test(l))) {
      assert.match(line, /--ignore-scripts/, `${id}: ${line.trim()}`);
    }
    assert.doesNotMatch(job, /cache:\s*npm/, `${id} must not restore an npm cache`);
  }
  for (const id of ['build', 'image']) {
    assert.doesNotMatch(all.get(id), /(?:contents|packages):\s*write/, `${id} is read-only`);
  }
  const writers = [...all].filter(([, job]) => /(?:contents|packages):\s*write/.test(job)).map(([id]) => id);
  for (const id of writers) assert.doesNotMatch(all.get(id), /npm (ci|install|test|run)|actions\/checkout/, `${id} only handles the built artifact`);
});

test('root lint, root tests and both VSIX build paths disable dependency lifecycle scripts', () => {
  const ci = jobs(read('ci.yml'));
  const lint = ci.get('lint');
  assert.match(lint, /^\s*- run: npm ci --ignore-scripts$/m);
  assert.match(lint, /^\s*- run: npm run lint$/m);
  assert.match(ci.get('test'), /^\s*- run: npm ci --ignore-scripts$/m);
  assert.match(ci.get('test'), /^\s*run: npm test$/m);
  for (const job of [ci.get('release-content'), jobs(read('release.yml')).get('build')]) {
    assert.match(job, /^\s*- run: npm ci --ignore-scripts$/m);
    assert.doesNotMatch(job, /^\s*- run: npm ci\s*$/m);
    assert.match(job, /^\s*run: npm run verify:release$/m);
  }
});

test('the Sterling image bundles the verified VSIX and is smoke-tested before archiving', () => {
  const image = jobs(read('release.yml')).get('image');
  assert.match(image, /needs:\s*build\b/);
  assert.match(image, /name: release-vsix/);
  assert.match(image, /needs\.build\.outputs\.sha256/);
  assert.match(image, /sha256sum --check[\s\S]*docker build --target release/);
  assert.match(image, /docker run[\s\S]*curl[\s\S]*docker exec[\s\S]*docker save/);
  assert.match(image, /archive_sha256: \$\{\{ steps\.archive\.outputs\.sha256 \}\}/);
  assert.match(image, /image_id: \$\{\{ steps\.archive\.outputs\.image_id \}\}/);
  assert.match(image, /name: sterling-image/);
});

test('publish waits for protected approval and verifies the tested image before registry access', () => {
  const text = read('release.yml');
  const publish = jobs(text).get('publish');
  const list = steps(publish);
  assert.match(list[0], /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(list[0], /name: sterling-image/);
  assert.match(list[1], /needs\.image\.outputs\.archive_sha256/);
  assert.match(list[1], /needs\.image\.outputs\.image_id/);
  assert.match(list[1], /sha256sum --check[\s\S]*docker load[\s\S]*docker image inspect[\s\S]*docker login ghcr\.io/);
  assert.match(list[1], /docker manifest inspect "\$ref"[\s\S]*\.config\.digest[\s\S]*docker push/);
  assert.match(list[1], /docker manifest inspect "\$digest"[\s\S]*\.config\.digest == \$id[\s\S]*image=\$digest/);
  assert.match(publish, /needs:\s*\[build, package, attest, image\]/);
  assert.match(publish, /needs\.image\.result == 'success'/);
  assert.match(publish, /needs\.attest\.result == 'success'/);
  assert.match(publish, /needs\.build\.outputs\.package_required == 'true' && needs\.package\.result == 'success'/);
  assert.match(publish, /permissions:\s*\n\s*packages: write/);
  assert.match(publish, /environment:\s*(?:\n\s*name: )?container-release/);
  assert.doesNotMatch(text, /name: marketplace/);
  assert.match(publish, /GHCR_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(text, /VSCE_PAT|\bvsce publish\b/);
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
  assert.match(review, /^      pr: \$\{\{ steps\.target\.outputs\.pr \}\}$/m);
  assert.match(review, /^      sha: \$\{\{ steps\.review\.outputs\.sha \}\}$/m);
  assert.match(review, /REVIEW_MODEL_API_KEY: \$\{\{ secrets\.REVIEW_MODEL_API_KEY \}\}/);
  assert.match(review, /REVIEW_MODEL: \$\{\{ vars\.REVIEW_MODEL \}\}/);
  assert.match(review, /REVIEW_MODEL_BASE_URL: \$\{\{ vars\.REVIEW_MODEL_BASE_URL \}\}/);
  assert.match(review, /\^\[0-9\]\+\$/, 'a dispatched PR number is validated');
  assert.match(review, /--expected-head "\$EXPECTED_HEAD"/, 'a PR whose head moved after CI is skipped');
  // The gate holds no secrets and is the owner's click.
  const gate = all.get('owner-approval');
  assert.match(gate, /^    name: 'owner approval \(gate change\) PR #\$\{\{ needs\.review\.outputs\.pr \}\} @ \$\{\{ needs\.review\.outputs\.sha \}\}'$/m);
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
  const installer = steps(job).find((step) => /path: compliance\/out\/vsix/.test(step));
  assert.match(installer, /name: vsix-\$\{\{ github\.sha \}\}/);
  assert.match(installer, /needs\.release-content\.result == 'success'/);
  const inputs = steps(job).find((step) => /name: Write collector inputs and changed paths/.test(step));
  assert.match(inputs, /VSIX_RESULT: \$\{\{ needs\.release-content\.result \}\}/);
  assert.match(inputs, /if \(process\.env\.VSIX_RESULT === "success"\)[\s\S]*read\("extension\/sbom\.cdx\.json"\)[\s\S]*retainVsix: true/);
  const scan = steps(job).find((step) => /secret-scan\.mjs --dir/.test(step));
  const upload = steps(job).find((step) => /name: compliance-bundle/.test(step));
  assert.match(scan, /id: bundle_scan/);
  assert.match(upload, /if: steps\.bundle_scan\.outcome == 'success'/);
  assert.match(job, /FAIL_ON_DROP:/);
  assert.match(job, /npm audit[\s\S]*continue-on-error: true|continue-on-error: true[\s\S]*npm audit/);
});

test('root, relay and hub test reports are always uploaded without changing required checks', async () => {
  const all = jobs(read('ci.yml'));
  for (const id of ['test', 'relay', 'hub']) {
    const job = all.get(id);
    assert.match(job, /NEAR_AI_TEST_REPORT/);
    assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/);
    const upload = steps(job).find((step) => step.includes(`name: test-report-${id === 'test' ? 'root' : id}`));
    assert.ok(upload, `report upload exists for ${id}`);
    const guard = id === 'test' ? '' : `steps.has_${id}.outputs.present == 'true' && `;
    assert.ok(upload.includes(`if: ${guard}always()`));
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
  assert.match(daily, /if: github\.ref == 'refs\/heads\/main' && \(/);
  assert.match(daily, /mkdir -p compliance\/out\n[\s\S]*> compliance\/out\/audit-root\.json/);
  assert.match(daily, /environment:\s*compliance-settings/);
  const scheduledCheckout = steps(daily).find((step) => step.includes('uses: actions/checkout@'));
  const scheduledPrior = steps(daily).find((step) => step.includes('name: Download CI evidence for the assessed commit'));
  assert.ok(scheduledCheckout.includes('ref: ${{ github.sha }}'));
  assert.ok(scheduledPrior.includes('COMMIT: ${{ github.sha }}'));
  assert.ok(scheduledPrior.includes('--branch main --event push --status success --commit "$COMMIT"'));
  const scheduledInputs = steps(daily).find((step) => /name: Write scheduled collector inputs/.test(step));
  assert.match(scheduledInputs, /documents: \{ repoRoot: "\." \}, crypto: \{ repoRoot: "\." \}/);
  assert.equal((scheduled.match(/COMPLIANCE_SETTINGS_TOKEN/g) ?? []).length, 1);
  const scheduledBundleScan = steps(daily).find((step) => /secret-scan\.mjs --dir/.test(step));
  assert.ok(scheduledBundleScan, 'daily evidence secret-scans the completed bundle');
  assert.match(scheduledBundleScan, /continue-on-error:\s*true/, 'a secret finding is reported without failing daily evidence collection');
  assert.match(scheduledBundleScan, /id: bundle_scan/);
  const upload = steps(daily).find((step) => /name: compliance-bundle/.test(step));
  assert.match(upload, /if: steps\.bundle_scan\.outcome == 'success'/);
  const weekly = jobs(scheduled).get('weekly-oscal');
  assert.match(weekly, /npm --prefix compliance ci --ignore-scripts[\s\S]*node compliance\/src\/cli\.ts validate/);
  const weeklyValidation = steps(weekly).find((step) => step.includes('Validate and resolve every OSCAL profile'));
  assert.ok(weekly.includes('stageAssessorItsg33Profile(process.argv[1])'));
  assert.ok(weeklyValidation.includes('profile="compliance/out/assessor-oscal/profiles/$name"'));
  assert.ok(weeklyValidation.includes("! -path 'compliance/catalogs/itsg-33/annex-3a.json'"));
  assert.match(weeklyValidation, /continue-on-error:\s*true/);
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
  assert.ok(pkg.includes('sh compliance/ci/oscal-validate.sh package "$directory"'));
  assert.ok(pkg.includes('stageAssessorItsg33Profile(process.argv[1])'));
  assert.ok(pkg.includes('profile="compliance/out/assessor-oscal/profiles/$name"'));
  assert.match(attest, /needs:\s*\[build, package\]/);
  assert.match(attest, /contents:\s*read[\s\S]*id-token:\s*write[\s\S]*attestations:\s*write/);
  assert.equal((text.match(/id-token:\s*write/g) ?? []).length, 1);
  assert.match(attest, /sha256sum --check/);
  assert.match(attest, /subject-checksums: release\/subjects\.sha256/);
  assert.match(attest, /actions\/attest@[0-9a-f]{40}/);
  assert.match(trestle, /--require-hashes --no-deps/);
  assert.match(trestle, /continue-on-error:\s*true/);
  assert.ok(trestle.includes('trestle import -f "$root/oscal/component-definitions/extension.json"'));
  assert.match(release, /needs:\s*\[build, package, attest, publish\]/);
  assert.match(release, /needs\.publish\.result == 'success'/);
  assert.match(release, /needs\.build\.outputs\.package_required == 'true' && needs\.package\.result == 'success'/);
  assert.match(release, /package_sha256/);
  assert.match(release, /IMAGE: \$\{\{ needs\.publish\.outputs\.image \}\}/);
  assert.match(release, /assets\+=\(sterling-image\.txt\)[\s\S]*gh release create/);
});

test('only main pushes and versioned hotfix branch dispatches publish compliance bundles', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-ci-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'compliance'));
  writeFileSync(path.join(dir, 'compliance', 'package.json'), '{}');
  const job = jobs(read('ci.yml')).get('compliance');
  const detect = steps(job).find((step) => /id: has_compliance/.test(step));
  assert.ok(detect);
  const script = detect.split('\n').slice(detect.split('\n').findIndex((line) => line.trim() === 'run: |') + 1).join('\n');
  const output = path.join(dir, 'output');
  for (const [event, branch, refType, kind] of [
    ['push', 'main', 'branch', 'main'],
    ['workflow_dispatch', 'hotfix/0.4.36', 'branch', 'release'],
    ['workflow_dispatch', 'hotfix/0.4.36', 'tag', ''],
    ['workflow_dispatch', 'hotfix/debug', 'branch', ''],
    ['workflow_dispatch', 'main', 'branch', ''],
    ['pull_request', 'hotfix/0.4.36', 'branch', ''],
  ]) {
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-c', script], { cwd: dir, env: { ...process.env, EVENT: event, BRANCH: branch, REF_TYPE: refType, GITHUB_OUTPUT: output } });
    assert.equal(readFileSync(output, 'utf8'), `present=true\n${kind ? `publish_as=${kind}\n` : ''}`, `${event} ${refType} ${branch}`);
  }
  assert.match(job, /if: steps\.has_compliance\.outputs\.publish_as != ''[\s\S]*secret-scan\.mjs --dir/);
  assert.match(job, /if: steps\.bundle_scan\.outcome == 'success'/);
  const inputs = steps(job).find((step) => /name: Write collector inputs and changed paths/.test(step));
  assert.match(inputs, /documents: \{ repoRoot: "\." \}, crypto: \{ repoRoot: "\." \}/);
});

test('releases require GitHub CI evidence on the exact release head when the base supports compliance', () => {
  const all = jobs(read('release.yml'));
  const build = all.get('build');
  assert.match(build, /evidence_branch="hotfix\/\$version"/);
  assert.match(build, /compliance\/package\.json is required for a main release/);
  assert.match(build, /git cat-file -e "\$base:compliance\/package\.json"[\s\S]*package_required=false/);
  const pkg = all.get('package');
  assert.match(pkg, /if: needs\.build\.outputs\.package_required == 'true'/);
  assert.match(pkg, /event=push\n[^\n]*"\$EVIDENCE_BRANCH" != main[^\n]*event=workflow_dispatch/);
  assert.match(pkg, /gh run list --workflow ci\.yml --branch "\$EVIDENCE_BRANCH" --event "\$event" --status success --commit "\$COMMIT"/);
  assert.match(pkg, /!result\.ok \|\| manifest\.commit !== process\.env\.COMMIT/);
  for (const id of ['attest', 'release']) {
    const job = all.get(id);
    assert.match(job, /package_required == 'true' && needs\.package\.result == 'success'/);
    assert.match(job, /package_required == 'false' && needs\.package\.result == 'skipped'/);
    assert.match(job, /if \[ "\$PACKAGE_REQUIRED" = true \]; then[\s\S]*"\$PACKAGE"/);
  }
  assert.match(all.get('release'), /needs\.attest\.result == 'success'/);
});

test('releases supplement CI only with usable daily evidence from the exact main commit in this repository', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-release-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'compliance', 'out');
  const verifiedCI = path.join(out, 'bundle', 'manifest.json');
  mkdirSync(path.dirname(verifiedCI), { recursive: true });
  writeFileSync(verifiedCI, 'original verified CI manifest');

  const pkg = jobs(read('release.yml')).get('package');
  const scheduled = steps(pkg).find((step) => /id: scheduled/.test(step));
  const pack = steps(pkg).find((step) => /id: pack/.test(step));
  assert.match(scheduled, /if: needs\.build\.outputs\.evidence_branch == 'main'/);
  assert.match(pack, /RELEASE_BUNDLE: \$\{\{ steps\.scheduled\.outputs\.bundle \}\}/);
  assert.match(pack, /--bundle "\$\{RELEASE_BUNDLE:-compliance\/out\/bundle\}"/);
  const script = scheduled.split('run: |\n')[1];

  const commit = 'a'.repeat(40);
  const run = {
    head_sha: commit, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'schedule',
    repository: { id: 321 }, head_repository: { id: 321 },
  };
  const runs = path.join(dir, 'runs.json');
  writeFileSync(runs, JSON.stringify({ workflow_runs: [
    { ...run, id: 110 },
    { ...run, id: 109, head_sha: 'b'.repeat(40) },
    { ...run, id: 108, head_repository: { id: 999 } },
    { ...run, id: 107, event: 'pull_request' },
    { ...run, id: 106, head_branch: 'feature' },
    { ...run, id: 105 },
    { ...run, id: 104 },
    { ...run, id: 103 },
    { ...run, id: 102 },
    { ...run, id: 101, event: 'workflow_dispatch' },
  ] }));
  writeFileSync(path.join(dir, 'gh'), `#!/bin/bash -e
case "$4" in
  repos/acme/demo/actions/workflows/compliance-scheduled.yml/runs)
    [[ "$*" == *"-f branch=main -f head_sha=$COMMIT -f status=success -F per_page=10" ]]
    cat runs.json
    ;;
  repos/acme/demo/actions/runs/*/jobs)
    [[ "$*" == *"-f filter=latest" ]]
    conclusion=success
    upload=success
    if [[ "$4" == */105/jobs ]]; then conclusion=skipped; fi
    if [[ "$4" == */110/jobs ]]; then upload=skipped; fi
    printf '{"jobs":[{"name":"daily evidence","head_sha":"%s","status":"completed","conclusion":"%s","steps":[{"name":"Run actions/upload-artifact@hash","conclusion":"%s"}]}]}\\n' "$COMMIT" "$conclusion" "$upload"
    ;;
  repos/acme/demo/actions/runs/*/artifacts)
    [[ "$*" == *"-f name=compliance-bundle" ]]
    expired=false
    if [[ "$4" == */104/artifacts ]]; then expired=true; fi
    printf '{"artifacts":[{"name":"compliance-bundle","expired":%s}]}\\n' "$expired"
    ;;
  --repo)
    [[ "$1 $2 $5 $6 $7 $8" == "run download acme/demo --name compliance-bundle --dir" ]]
    printf '%s\\n' "$3" >> downloads
    mkdir -p "$9"
    printf '%s\\n' "$3" > "$9/manifest.json"
    [[ "$3" != 103 ]]
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(path.join(dir, 'node'), `#!/bin/bash -e
[[ "$1 $2 $3 $5 $7 $8 $9 \${11}" == "compliance/src/cli.ts bundle --inputs --out --previous compliance/out/bundle --scheduled --scheduled-run" ]]
run_id="$(cat "\${10}/manifest.json")"
[[ "\${12}" == "https://github.com/acme/demo/actions/runs/$run_id" ]]
jq -e --arg commit "$COMMIT" '.repository == "acme/demo" and .commit == $commit and .kind == "release" and .repoRoot == "." and .collectors == {}' "$4" >/dev/null
printf '%s\\n' "$run_id" >> merges
mkdir -p "$6"
printf 'partial or complete combined manifest\\n' > "$6/manifest.json"
[[ "$run_id" != 102 ]]
`, { mode: 0o755 });

  const summary = path.join(dir, 'summary');
  const output = path.join(dir, 'output');
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`, COMMIT: commit, REPOSITORY_ID: '321',
    GITHUB_REPOSITORY: 'acme/demo', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
  };
  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: dir, env });
  assert.equal(readFileSync(path.join(dir, 'downloads'), 'utf8'), '103\n102\n101\n');
  assert.equal(readFileSync(path.join(dir, 'merges'), 'utf8'), '102\n101\n');
  assert.match(readFileSync(output, 'utf8'), /^bundle=compliance\/out\/scheduled-release\.[^/]+\/combined\n$/);
  assert.match(readFileSync(summary, 'utf8'), /https:\/\/github\.com\/acme\/demo\/actions\/runs\/101/);
  assert.equal(readFileSync(verifiedCI, 'utf8'), 'original verified CI manifest');

  for (const response of [{ workflow_runs: [{ ...run, id: 103 }, { ...run, id: 102 }] }, { workflow_runs: [] }, { message: 'raw unexpected response' }]) {
    writeFileSync(runs, JSON.stringify(response));
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const log = execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: dir, env, encoding: 'utf8' });
    assert.match(log, /::warning::/);
    assert.doesNotMatch(log, /raw unexpected response/);
    assert.equal(readFileSync(output, 'utf8'), '');
    assert.match(readFileSync(summary, 'utf8'), /unavailable or unverified/);
    assert.equal(readFileSync(verifiedCI, 'utf8'), 'original verified CI manifest');
  }
});

test('CODEOWNERS routes all compliance gate paths to one owner', () => {
  const text = readFileSync(new URL('../../.github/CODEOWNERS', import.meta.url), 'utf8');
  for (const path of ['/.github/', '/SECURITY.md', '/scripts/lib/', '/scripts/test/', '/compliance/tailoring/', '/compliance/sources.json', '/compliance/catalogs/', '/compliance/attestations/',
    '/compliance/src/', '/compliance/components/', '/compliance/evidence-rules/', '/compliance/responsibility/', '/compliance/profiles/', '/compliance/levels.json', '/compliance/resources.json', '/scripts/resource-check.mjs']) {
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
