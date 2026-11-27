// Checks on the GitHub Actions workflow files that the rest of the process relies on. There is
// no YAML parser in the dependencies, so these read the files as text, split into top-level
// keys and jobs by indentation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('the release build prepares the pinned hub before running the root tests', () => {
  const release = steps(jobs(read('release.yml')).get('build'));
  const hubRequired = /if: hashFiles\('hub\/package\.json'\) != ''/;
  const hubNode = release.findIndex((step) => step.includes("node-version: '26.13.1'"));
  const hubBuild = release.findIndex((step) => step.includes('NEAR_AI_HUB_NODE='));
  const rootNode = release.findIndex((step) => step.includes("node-version: '24'"));
  const rootTest = release.findIndex((step) => /^\s*run: npm test$/m.test(step));
  assert.ok(hubNode >= 0 && hubNode < hubBuild && hubBuild < rootNode && rootNode < rootTest,
    'provision and build the hub before setting up and testing the extension');
  assert.match(release[hubNode], hubRequired);
  assert.match(release[hubBuild], hubRequired);
  assert.match(release[hubBuild], /working-directory: hub[\s\S]*NEAR_AI_HUB_NODE=\$\(command -v node\)[\s\S]*\$GITHUB_ENV[\s\S]*npm ci --ignore-scripts[\s\S]*npm run build/);
});

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

test('root lint, root tests, the VS Code test and both VSIX build paths disable dependency lifecycle scripts', () => {
  const ci = jobs(read('ci.yml'));
  // No CI job installs the root dependencies with their install scripts on (G10, 44.1-02): the VS Code test was the last exception.
  for (const [id, job] of ci) assert.doesNotMatch(job, /^\s*- run: npm ci\s*$/m, `${id} installs with install scripts on`);
  assert.match(ci.get('e2e'), /^\s*- run: npm ci --ignore-scripts$/m);
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
  // 46-03's egress suite runs against the archived image ID after the archive and every other artifact are uploaded (its harness and
  // Playwright's Chromium download run with Docker access), with a script-free install of the harness.
  const list = steps(image);
  const egress = list.findIndex((step) => step.includes('dist/test/container/egress.test.js'));
  assert.ok(egress > list.findIndex((step) => /docker save/.test(step)), 'the egress run comes after the archive is saved');
  list.forEach((step, index) => { if (/actions\/upload-artifact@/.test(step)) assert.ok(index < egress, 'every upload comes before the egress run'); });
  assert.match(list[egress], /IMAGE_ID: \$\{\{ steps\.archive\.outputs\.image_id \}\}[\s\S]*test "\$\(docker image inspect --format '\{\{\.Id\}\}' "sterling-release:\$TAG"\)" = "\$IMAGE_ID"\n\s*WORKBENCH_TEST_IMAGE="sterling-release:\$TAG" node \.\.\/scripts\/run-tests\.mjs --test-concurrency=1 dist\/test\/container\/egress\.test\.js/);
  // The UI the owner reviewed (Get Started, the work-area pages and creating a work area through the bundled extension) is checked on the
  // same archived image, in the same last step, so it cannot be missing from a release unnoticed.
  assert.match(list[egress], /egress\.test\.js\n\s*WORKBENCH_TEST_IMAGE="sterling-release:\$TAG" node \.\.\/scripts\/run-tests\.mjs --test-concurrency=1 dist\/test\/container\/get-started\.test\.js\n/);
  assert.equal(egress, list.length - 1, 'the egress and Get Started run is the image job\'s last step');
  assert.doesNotMatch(image, /npm ci(?! --ignore-scripts)|cache:\s*npm/);
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
  assert.match(list[1], /docker manifest inspect "\$ref"[\s\S]*docker pull "\$ref"[\s\S]*docker push/);
  // The recorded digest is the tested image under either Docker image store: the manifest digest
  // equals the image ID (containerd store) or the manifest's config digest does (classic store).
  assert.match(list[1], /if \[ "\$\{digest##\*@\}" != "\$IMAGE_ID" \]; then\s*docker manifest inspect "\$digest" \| jq -e --arg id "\$IMAGE_ID" '\.config\.digest == \$id'\s*fi\s*echo "image=\$digest"/);
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
  const needs = /needs:\s*\[([^\]]*)\]/.exec(job)?.[1].split(',').map((need) => need.trim()) ?? [];
  // workbench too (owner 2026-11-25): its report and image SBOM have finished uploading before this job reads them.
  for (const need of ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'docs', 'relay', 'hub', 'deploy', 'relay-image-scan', 'workbench']) assert.ok(needs.includes(need), need);
  assert.match(job, /if:\s*always\(\)/);
  assert.match(job, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  assert.match(job, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  const installer = steps(job).find((step) => /path: compliance\/out\/vsix/.test(step));
  assert.match(installer, /name: vsix-\$\{\{ github\.sha \}\}/);
  assert.match(installer, /needs\.release-content\.result == 'success'/);
  const inputs = steps(job).find((step) => /name: Write collector inputs and changed paths/.test(step));
  assert.match(inputs, /VSIX_RESULT: \$\{\{ needs\.release-content\.result \}\}/);
  assert.match(inputs, /if \(process\.env\.VSIX_RESULT === "success"\)[\s\S]*read\("extension\/sbom\.cdx\.json"\)[\s\S]*retainVsix: true/);
  // The workbench image SBOM is a subject only from a workbench job that succeeded on a commit with the workbench, and only when the file
  // arrived; otherwise no workbench-image observation exists and its rule reads missing-result.
  const image = steps(job).find((step) => /name: workbench-image-sbom\n/.test(step));
  assert.match(image, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.ok(image.includes("if: steps.has_compliance.outputs.present == 'true' && needs.workbench.result == 'success' && hashFiles('workbench/package.json') != ''"));
  assert.match(image, /path: compliance\/out\/workbench-image$/m);
  assert.ok(steps(job).indexOf(image) < steps(job).indexOf(inputs), 'the SBOM is downloaded before the inputs are written');
  assert.match(inputs, /WORKBENCH_RESULT: \$\{\{ needs\.workbench\.result \}\}/);
  assert.ok(inputs.includes('if (process.env.WORKBENCH_RESULT === "success" && existsSync(workbenchSbom)) sboms.push({ subject: "workbench-image", file: workbenchSbom });'));
  assert.ok(inputs.includes('const workbenchSbom = "compliance/out/workbench-image/workbench-image-sbom.json";'));
  assert.ok(inputs.includes('if (sboms.length > 0) collectors.sbom ='), 'no sbom input at all when neither SBOM arrived');
  const scan = steps(job).find((step) => /secret-scan\.mjs --dir/.test(step));
  const upload = steps(job).find((step) => /name: compliance-bundle/.test(step));
  assert.match(scan, /id: bundle_scan/);
  assert.match(upload, /if: steps\.bundle_scan\.outcome == 'success'/);
  assert.match(job, /FAIL_ON_DROP:/);
  assert.match(job, /npm audit[\s\S]*continue-on-error: true|continue-on-error: true[\s\S]*npm audit/);
  const all = steps(job);
  const unit = all.findIndex((step) => /run: npm --prefix compliance test$/m.test(step));
  const load = all.findIndex((step) => step.includes('loadtest/test/*.test.ts'));
  assert.ok(unit >= 0 && load > unit, 'the load-test tests run after the compliance tests');
  assert.match(all[load], /if: steps\.has_compliance\.outputs\.present == 'true'/);
  assert.match(all[load], /if \[ ! -f loadtest\/package\.json \]; then [^\n]*exit 0; fi/, 'a checkout without loadtest/ still passes');
  assert.match(all[load], /typescript\/bin\/tsc -p loadtest\/tsconfig\.json/);
  assert.match(inputs, /if \(existsSync\("workbench\/package\.json"\)\) reported\.push\("workbench"\)/);
  assert.match(inputs, /if \(existsSync\("deploy\/test"\)\) reported\.push\("deploy"\)/);
});

/** The public site evidence the dashboard may name: the reference site's export and the public site trust list only (48 D-15, VER-07). */
const DEPLOYMENT_INPUT = 'deployment: { file: "compliance/site-evidence/reference.json", signersFile: "compliance/attestations/site-signers.json" }';

test('the public workflows collect deployment evidence from the reference site only', () => {
  for (const name of ['ci.yml', 'compliance-scheduled.yml']) {
    const text = read(name);
    assert.equal(text.split(DEPLOYMENT_INPUT).length - 1, 1, `${name} names the reference export and the public trust list once`);
    assert.deepEqual([...new Set(text.match(/site-evidence\/[^"'\s]*/g))], ['site-evidence/reference.json'], `${name} names no other site export`);
    assert.deepEqual([...new Set(text.match(/attestations\/site-signers[^"'\s]*/g))], ['attestations/site-signers.json'], `${name} names no other site trust list`);
  }
});

test('every package the compliance reports list names has a job that writes and uploads its report, without changing required checks', async () => {
  const all = jobs(read('ci.yml'));
  const inputs = steps(all.get('compliance')).find((step) => /name: Write collector inputs and changed paths/.test(step));
  const base = JSON.parse(/const reported = (\[[^\]]*\]);/.exec(inputs)?.[1] ?? 'null');
  assert.deepEqual(base, ['root', 'relay', 'hub']);
  // A package added when it exists (workbench, deploy) needs its job only once it is in the checkout; until then its report is missing and
  // only that package's tests observation fails.
  const conditional = [...inputs.matchAll(/if \(existsSync\("([^"]+)"\)\) reported\.push\("([^"]+)"\);/g)].map(([, marker, id]) => ({ marker, id }));
  assert.deepEqual(conditional.map(({ id }) => id), ['workbench', 'deploy']);
  const root = new URL('../../', import.meta.url);
  const present = [...base, ...conditional.filter(({ marker }) => existsSync(new URL(marker, root))).map(({ id }) => id)];
  for (const id of present) {
    const job = all.get(id === 'root' ? 'test' : id);
    assert.ok(job, `a ${id} job exists for its report`);
    assert.ok(job.includes(`NEAR_AI_TEST_REPORT: test-report-${id}.ndjson`), `${id} writes its report`);
    assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/);
    const upload = steps(job).find((step) => step.includes(`name: test-report-${id}\n`));
    assert.ok(upload, `report upload exists for ${id}`);
    const guard = id === 'root' ? '' : `steps.has_${id}.outputs.present == 'true' && `;
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
  // Trestle refuses imports from inside its own workspace, so the package is unpacked beside it.
  assert.match(trestle, /tar -xzf "release\/\$PACKAGE" -C trestle-input/);
  assert.doesNotMatch(trestle, /-C trestle-work/);
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
    '/compliance/src/', '/compliance/components/', '/compliance/evidence-rules/', '/compliance/responsibility/', '/compliance/profiles/', '/compliance/levels.json', '/compliance/resources.json', '/scripts/resource-check.mjs',
    '/compliance/applicability/', '/compliance/coverage/']) {
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

test('the workbench job builds, tests and drives its image in a browser on Node 26, and is not a required check', async () => {
  const all = jobs(read('ci.yml'));
  const job = all.get('workbench');
  assert.ok(job, 'ci.yml has a workbench job');
  assert.match(job, /permissions:\s*\n\s*contents: read/);
  const list = steps(job);
  const presence = list.findIndex((step) => /id: has_workbench/.test(step));
  assert.ok(presence > 0, 'the presence check follows the checkout');
  assert.match(list[presence], /\[ -f workbench\/package\.json \]/);
  assert.ok(list[presence].includes('^hotfix/[0-9]+'), 'the hub\'s hotfix rule');
  assert.ok(list[presence].includes('BRANCH: ${{ github.head_ref || github.ref_name }}'), 'the branch reaches the script through env');
  for (const step of list.slice(presence + 1)) assert.match(step, /if: steps\.has_workbench\.outputs\.present == 'true'/, `guarded: ${step.trim().split('\n')[0]}`);
  assert.match(job, /node-version: '26\.13\.1'/);
  assert.match(job, /cache-dependency-path: workbench\/package-lock\.json/);
  assert.doesNotMatch(job, /npm ci(?! --ignore-scripts)/);
  // In order: install without scripts, audit, lint, unit tests with the report, the image, the browser, the container suite against that image.
  const order = [/npm ci --ignore-scripts/, /npm audit --omit=dev --audit-level=high/, /npm run lint/, /NEAR_AI_TEST_REPORT: test-report-workbench\.ndjson[\s\S]*npm test/,
    /docker build -f workbench\/Dockerfile -t sterling-workbench:ci \./, /playwright install --with-deps chromium/, /WORKBENCH_TEST_IMAGE: sterling-workbench:ci[\s\S]*npm run test:container/];
  let at = presence;
  for (const pattern of order) {
    const next = list.findIndex((step, index) => index > at && pattern.test(step));
    assert.ok(next > at, `${pattern} comes after the step before it`);
    at = next;
  }
  const build = list.find((step) => /docker build -f workbench\/Dockerfile/.test(step));
  assert.match(build, /working-directory: \./, 'the image builds from the repository root (the engine bundle reads src/)');
  assert.doesNotMatch(build, /--target/, 'CI tests the default (development) target');
  const { CI_CHECKS } = await import('../lib/workflow.mjs');
  assert.ok(!CI_CHECKS.includes('workbench'), 'workbench is not a required check');
});

test('the workbench job records the SBOM, scan and digest of the image it tested, and pushes and signs nothing', () => {
  const job = jobs(read('ci.yml')).get('workbench');
  const list = steps(job);
  const build = list.findIndex((step) => /docker build -f workbench\/Dockerfile -t sterling-workbench:ci/.test(step));
  const later = (pattern) => list.findIndex((step, index) => index > build && pattern.test(step));
  assert.ok(later(/install-tool\.sh syft/) > build && later(/install-tool\.sh grype/) > build);
  const sbom = later(/syft scan sterling-workbench:ci --output cyclonedx-json=compliance\/out\/workbench-image-sbom\.json/);
  assert.ok(sbom > build, 'the SBOM is of the image the job built');
  assert.ok(later(/grype db update/) > sbom);
  const scan = list[later(/grype sbom:compliance\/out\/workbench-image-sbom\.json --only-fixed --fail-on high --output json=compliance\/out\/workbench-image-scan\.json/)];
  assert.match(scan ?? '', /continue-on-error:\s*true/, 'findings are report-only');
  const digest = list[later(/docker image inspect --format '\{\{\.Id\}\}' sterling-workbench:ci/)];
  assert.match(digest ?? '', /compliance\/out\/workbench-image-digest\.txt/);
  assert.match(digest ?? '', /GITHUB_STEP_SUMMARY/);
  for (const name of ['workbench-image-sbom', 'workbench-image-scan', 'workbench-image-digest']) {
    const upload = list.find((step) => step.includes(`name: ${name}\n`));
    assert.ok(upload, `${name} is uploaded`);
    assert.match(upload, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.ok(upload.includes("if: steps.has_workbench.outputs.present == 'true' && always()"), `${name} is uploaded even when a later step fails`);
  }
  assert.doesNotMatch(job, /cosign|docker push|docker login|packages:\s*write|id-token|secrets\./, 'CI never publishes or signs the workbench image');
});

test('the release image job writes the release image SBOM and hands publish a hash-checked cosign, read-only', () => {
  const image = jobs(read('release.yml')).get('image');
  const list = steps(image);
  const archived = list.findIndex((step) => /name: sterling-image\n/.test(step));
  assert.ok(archived > 0, 'the image archive upload is found');
  const after = list.slice(archived + 1).join('\n');
  // #165's build, smoke and archive steps keep their order; the SBOM work comes after them.
  assert.doesNotMatch(list.slice(0, archived + 1).join('\n').replace(/^\s*#.*$/gm, ''), /syft|grype|cosign/);
  assert.match(after, /sh compliance\/ci\/install-tool\.sh syft /);
  assert.match(after, /sh compliance\/ci\/install-tool\.sh grype /);
  assert.match(after, /sh compliance\/ci\/install-tool\.sh cosign /);
  assert.ok(after.includes('syft scan "sterling-release:$TAG" --output cyclonedx-json=sterling-image-sbom.cdx.json'));
  const scan = list.find((step) => /grype sbom:sterling-image-sbom\.cdx\.json --only-fixed --fail-on high/.test(step));
  assert.match(scan ?? '', /continue-on-error:\s*true/, 'the release scan is report-only');
  const handOff = list.find((step) => /id: cosign\n/.test(step));
  assert.ok(handOff?.includes('require("./compliance/ci/tool-pins.json").cosign.sha256'), 'the cosign hash is the repository pin');
  assert.match(handOff ?? '', /sha256sum --check --strict/);
  assert.match(image, /sbom_sha256: \$\{\{ steps\.sbom\.outputs\.sha256 \}\}/);
  assert.match(image, /cosign_sha256: \$\{\{ steps\.cosign\.outputs\.sha256 \}\}/);
  for (const name of ['sterling-image-sbom', 'release-cosign']) assert.ok(list.some((step) => step.includes(`name: ${name}\n`) && /if-no-files-found: error/.test(step)), `${name} is uploaded`);
  assert.match(image, /permissions:\s*\n\s*contents: read\n(?!\s+\w+: write)/);
  assert.doesNotMatch(image, /secrets\.|COSIGN_PRIVATE_KEY/);
});

test('publish signs and attests the published digest with your organization\'s key after #165\'s push, and verifies both, never keyless', () => {
  const text = read('release.yml');
  const publish = jobs(text).get('publish');
  const list = steps(publish);
  // #165's download and push stay the first two steps (their own test checks their content).
  assert.match(list[0], /name: sterling-image$/m);
  assert.match(list[1], /id: push\n/);
  const rest = list.slice(2);
  assert.match(rest[0], /actions\/download-artifact@[0-9a-f]{40}[\s\S]*name: sterling-image-sbom\n/);
  assert.match(rest[1], /actions\/download-artifact@[0-9a-f]{40}[\s\S]*name: release-cosign\n/);
  assert.match(rest[2], /SBOM_SHA256: \$\{\{ needs\.image\.outputs\.sbom_sha256 \}\}/);
  assert.match(rest[2], /COSIGN_SHA256: \$\{\{ needs\.image\.outputs\.cosign_sha256 \}\}/);
  assert.match(rest[2], /sha256sum --check --strict/);
  const sign = rest[3];
  assert.ok(sign, 'a signing step follows the checks');
  assert.equal(rest.length, 4, 'nothing runs after the signing step');
  const env = /\n\s+env:\n([\s\S]*?)\n\s+run:/.exec(sign)?.[1] ?? '';
  assert.match(env, /COSIGN_PRIVATE_KEY: \$\{\{ secrets\.COSIGN_PRIVATE_KEY \}\}/);
  assert.match(env, /COSIGN_PASSWORD: \$\{\{ secrets\.COSIGN_PASSWORD \}\}/);
  assert.match(env, /GHCR_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(env, /IMAGE: \$\{\{ steps\.push\.outputs\.image \}\}/);
  // The key and its password reach this step only.
  assert.equal((text.match(/secrets\.COSIGN_(?:PRIVATE_KEY|PASSWORD)/g) ?? []).length, 2);
  const run = /\n\s+run: \|\n([\s\S]*)$/.exec(sign)?.[1] ?? '';
  const order = [/\^refs\/tags\/v\[0-9\]\+/, /if \[ -z "\$COSIGN_PRIVATE_KEY" \]; then echo "::error::[^"]*container-release[^"]*COSIGN_PRIVATE_KEY[^"]*"; exit 1/,
    /docker login ghcr\.io/, /cosign signing-config create --out "\$RUNNER_TEMP\/signing-config\.json"/,
    /cosign sign --key env:\/\/COSIGN_PRIVATE_KEY --signing-config "\$RUNNER_TEMP\/signing-config\.json" -y "\$IMAGE"/,
    /cosign attest --key env:\/\/COSIGN_PRIVATE_KEY --signing-config "\$RUNNER_TEMP\/signing-config\.json" --type cyclonedx --predicate sbom\/sterling-image-sbom\.cdx\.json -y "\$IMAGE"/,
    /cosign public-key --key env:\/\/COSIGN_PRIVATE_KEY > "\$RUNNER_TEMP\/cosign\.pub"/,
    /cosign verify --key "\$RUNNER_TEMP\/cosign\.pub" --insecure-ignore-tlog "\$IMAGE"/,
    /cosign verify-attestation --key "\$RUNNER_TEMP\/cosign\.pub" --insecure-ignore-tlog --type cyclonedx "\$IMAGE"/, /GITHUB_STEP_SUMMARY/];
  let at = -1;
  for (const pattern of order) {
    const match = pattern.exec(run.slice(at + 1));
    assert.ok(match, `${pattern} follows the line before it`);
    at += 1 + match.index;
  }
  assert.match(run, /trap 'docker logout ghcr\.io >\/dev\/null' EXIT/);
  assert.match(publish, /permissions:\s*\n\s*packages: write\n\s*environment:/, 'publish holds packages write and nothing else');
  assert.doesNotMatch(publish, /id-token|npm |actions\/checkout/);
  assert.doesNotMatch(text, /--identity-token|--oidc-|COSIGN_EXPERIMENTAL|--tlog-upload=true|--fulcio|--rekor/);
});

test('every workflow image build retries only a Red Hat registry refusal, and a failing build never passes', () => {
  const wrapper = new URL('../../.github/retry-registry-auth.sh', import.meta.url).pathname;
  for (const name of ['ci.yml', 'deploy-images.yml', 'release.yml']) {
    for (const line of read(name).split('\n').filter((l) => /\bdocker build\b/.test(l))) {
      assert.match(line, /bash \.github\/retry-registry-auth\.sh docker build /, `${name}: ${line.trim()}`);
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-registry-retry-'));
  try {
    const refused = 'ERROR: failed to solve: failed to fetch anonymous token: unexpected status from GET request to https://brew.registry.redhat.io/auth/realms/rhcc/protocol/redhat-docker-v2/auth?scope=repository%3Aubi9%2Fopenjdk-21-runtime%3Apull&service=docker-registry: 401 Unauthorized';
    // A fake docker that plays each queued outcome in turn ("ok", or an exit status and a message), and a sleep that does not wait.
    writeFileSync(path.join(dir, 'docker'), '#!/usr/bin/env bash\nn=$(cat "$DIR/calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$DIR/calls"\nline=$(sed -n "${n}p" "$DIR/outcomes")\n[ "$line" = ok ] && exit 0\necho "${line#* }" >&2; exit "${line%% *}"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });
    const run = (outcomes) => {
      rmSync(path.join(dir, 'calls'), { force: true });
      writeFileSync(path.join(dir, 'outcomes'), `${outcomes.join('\n')}\n`);
      let status = 0;
      try {
        execFileSync('bash', [wrapper, 'docker', 'build', '.'], { env: { ...process.env, DIR: dir, PATH: `${dir}:${process.env.PATH}` }, stdio: 'pipe' });
      } catch (error) {
        status = error.status;
      }
      return { status, calls: Number(readFileSync(path.join(dir, 'calls'), 'utf8')) };
    };
    assert.deepEqual(run([`1 ${refused}`, `1 ${refused.replace('brew.', '')}`, 'ok']), { status: 0, calls: 3 });
    assert.deepEqual(run([`1 ${refused}`, `1 ${refused}`, `1 ${refused}`, 'ok']), { status: 1, calls: 3 }, 'three runs at most');
    assert.deepEqual(run(['7 ERROR: failed to solve: process "/bin/sh -c make" did not complete successfully: exit code: 2', 'ok']), { status: 7, calls: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the required docs job blocks on the applicability drift check and the coverage ratchet; the compliance job reports coverage without failing (44.1-07, D-19)', () => {
  const ci = jobs(read('ci.yml'));
  const docs = steps(ci.get('docs'));
  const step = (pattern) => docs.find((item) => pattern.test(item));
  for (const pattern of [/npm --prefix compliance ci --ignore-scripts/, /node compliance\/src\/cli\.ts applicability --check/, /node compliance\/src\/cli\.ts coverage --check/]) {
    const found = step(pattern);
    assert.ok(found, `docs job step ${pattern}`);
    assert.doesNotMatch(found, /continue-on-error/, `${pattern} must block`);
  }
  const install = docs.findIndex((item) => /npm --prefix compliance ci --ignore-scripts/.test(item));
  assert.ok(install < docs.findIndex((item) => /coverage --check/.test(item)), 'the compliance package is installed before the checks');
  const summary = steps(ci.get('compliance')).find((item) => /coverage --bundle compliance\/out\/bundle/.test(item));
  assert.ok(summary, 'the compliance job prints the coverage summary');
  assert.match(summary, /continue-on-error: true/);
  assert.match(summary, /GITHUB_STEP_SUMMARY/);
});
