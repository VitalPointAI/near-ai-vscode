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
