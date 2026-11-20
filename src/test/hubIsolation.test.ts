// Phase 32, plan 17 (D-32, D-33): your organization's sync hub (hub/) is a separate service with its own Node version, manifest and lockfile,
// like the messaging relay. The extension must stay blind to it: nothing from hub/ may ship in the .vsix, the root lockfile has no hub entry, the
// hub's state and secret files can never be committed, every PR runs the hub's own CI job, and the merge gates wait for it.
// A copy of the relay checks in relayIsolation.test.ts, adapted for the hub; the helpers are copied, not shared, so neither file can weaken the
// other. These checks run on the extension's own toolchain (Node 24), not the hub's.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function nonCommentLines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, file), 'utf8')) as Record<string, unknown>;
}

async function readWorkflow(): Promise<string> {
  return readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
}

test('the VSIX ignores hub/', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.vscodeignore'));
  assert.ok(lines.includes('hub/**'), 'without hub/** in .vscodeignore the hub source, state database and secrets would ship in the .vsix');
});

test('the root lockfile holds no hub package', async () => {
  const lock = await readJson('package-lock.json');
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  const hubKeys = Object.keys(packages).filter((key) => key === 'hub' || key.startsWith('hub/'));
  assert.deepEqual(hubKeys, [], 'the root lockfile must not hold any hub package; the hub has its own lockfile');
});

test('hub state and secrets are git-ignored, including hub secrets kept beside the relay', () => {
  for (const probe of [
    'hub/state/hub.db',
    'hub/state/hub.db-wal',
    'hub/state/hub.db-shm',
    'hub/secrets/hub_tls_key',
    'hub/secrets/hub_signing_key',
    'hub/other/x.db',
    'relay/secrets/hub/hub_signing_key',
    'relay/secrets/hub/hub_tls_key',
  ]) {
    // git check-ignore exits 0 when the path is ignored and 1 when it is not.
    assert.doesNotThrow(
      () => execFileSync('git', ['check-ignore', '-q', probe], { cwd: REPO_ROOT, stdio: 'ignore' }),
      `${probe} would be committable; git must ignore it`,
    );
  }
});

test('the hub has its own lockfile and a private package named near-ai-hub', async () => {
  await access(path.join(REPO_ROOT, 'hub', 'package-lock.json'));
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'hub', 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, 'near-ai-hub');
  assert.equal(manifest.private, true, 'the hub must stay private so it can never be published by accident');
});

/** The text of one job of ci.yml: from its two-space key line to the next two-space key. */
function ciJob(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.ok(start >= 0, `ci.yml has no ${job} job`);
  const body: string[] = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The steps of one job, each as its text from its `      - ` line to the next one. */
function jobSteps(job: string): string[] {
  const lines = job.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '    steps:');
  assert.ok(start >= 0, 'the job has steps');
  const steps: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('      - ')) steps.push([line]);
    else if (steps.length > 0) steps[steps.length - 1]!.push(line);
  }
  return steps.map((step) => step.join('\n'));
}

test('CI runs the hub job on Node 26.13.1 with pinned actions, after the relay job', async () => {
  const workflow = await readWorkflow();
  const hub = ciJob(workflow, 'hub');
  for (const needle of [
    'name: hub',
    "node-version: '26.13.1'",
    'cache-dependency-path: hub/package-lock.json',
    'working-directory: hub',
    'persist-credentials: false',
    'fetch-depth: 0',
    'npm ci --ignore-scripts',
    'npm audit --omit=dev --audit-level=high',
    'npm run lint',
    'npm test',
    'npm run test:container',
  ]) {
    assert.ok(hub.includes(needle), `the hub job must contain: ${needle}`);
  }
  assert.ok(!hub.includes('relay/'), 'the hub job uses nothing of the relay');
  const uses = hub.split(/\r?\n/).filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.ok(uses.length >= 3, 'the hub job checks out the code and sets up Node twice');
  for (const line of uses) {
    assert.match(line, /@[0-9a-f]{40}\s+# v\d/, `every action in the hub job is pinned to a full commit SHA with a version comment: ${line.trim()}`);
  }
  const lines = workflow.split(/\r?\n/);
  assert.ok(lines.indexOf('  relay:') < lines.indexOf('  hub:'), 'the hub job follows the relay job');
  // The hub's own Node version must not leak into the extension's jobs.
  assert.equal((workflow.match(/NODE_VERSION: '24'/g) ?? []).length, 1, "the workflow-level NODE_VERSION stays '24' for the extension's jobs");
  assert.ok(!ciJob(workflow, 'lint').includes('26.13.1'), 'the extension jobs stay on the default Node version');
  // The header names every required job, the hub included.
  const header = lines.slice(0, lines.findIndex((line) => line.startsWith('name:'))).join('\n');
  assert.match(header, /secret-scan,\s+relay,\s+hub\)/, 'the ci.yml header lists hub among the required checks');
});

const HAS_HUB = "if: steps.has_hub.outputs.present == 'true'";

test('the hub job skips its checks only on a hotfix/x.y.z commit whose base also has no hub/, and fails on any other change without it', async () => {
  const workflow = await readWorkflow();
  const steps = jobSteps(ciJob(workflow, 'hub'));
  assert.ok(steps[0]?.includes('uses: actions/checkout@'), 'the hub job checks out the code first');
  assert.ok(steps[0]?.includes('fetch-depth: 0'), 'the hub job checks out the full history so the base commit can be read');
  assert.ok(steps[0]?.includes('persist-credentials: false'), 'the hub checkout keeps no credentials');
  const detect = steps[1] ?? '';
  assert.ok(detect.includes('id: has_hub'), 'the second step of the hub job detects whether hub/ exists');
  assert.ok(detect.includes('working-directory: .'), 'the detection step runs from the repository root');
  assert.ok(!detect.includes('if:'), 'the detection step always runs');
  assert.ok(detect.includes('BRANCH: ${{ github.head_ref || github.ref_name }}'), 'the detection step reads the branch name from env');
  assert.ok(detect.includes('EVENT: ${{ github.event_name }}'), 'the detection step reads the event name from env');
  assert.ok(detect.includes('PR_BASE: ${{ github.event.pull_request.base.sha }}'), "the detection step reads the PR's base commit from env");
  for (const step of steps.slice(2)) {
    assert.ok(step.includes(HAS_HUB), `every hub step after the detection is skipped when hub/ is missing:\n${step}`);
  }

  // Run the detection script itself, as the runner would, in a real repository with and without hub/package.json.
  const scriptLines = detect.split('\n');
  const runAt = scriptLines.findIndex((line) => line.trim() === 'run: |');
  assert.ok(runAt >= 0, 'the detection step has a run block');
  const script = scriptLines
    .slice(runAt + 1)
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n');
  assert.ok(script.includes('hub/package.json'), 'the detection is keyed on hub/package.json');
  const scratch = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-ci-detect-'));
  try {
    const repo = path.join(scratch, 'repo');
    await mkdir(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    // oldTag: a release older than the hub (it has the relay). main: the hub is added. hotfix: a fix on top of the old tag.
    // drop: a branch cut from main that deletes the hub.
    await writeFile(path.join(repo, 'README.md'), 'old\n');
    await mkdir(path.join(repo, 'relay'));
    await writeFile(path.join(repo, 'relay', 'package.json'), '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'old release');
    const oldTag = git('rev-parse', 'HEAD');
    await mkdir(path.join(repo, 'hub'));
    await writeFile(path.join(repo, 'hub', 'package.json'), '{}');
    git('add', '-A');
    git('commit', '-q', '-m', 'add the hub');
    const main = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', main);
    git('rm', '-q', '-r', 'hub');
    git('commit', '-q', '-m', 'drop the hub');
    const drop = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', oldTag);
    await writeFile(path.join(repo, 'README.md'), 'fixed\n');
    git('commit', '-q', '-am', 'hotfix');
    const hotfix = git('rev-parse', 'HEAD');

    let run = 0;
    const detectAt = async (
      commit: string,
      env: { BRANCH: string; EVENT: string; PR_BASE?: string },
    ): Promise<{ ok: boolean; output: string; stdout: string }> => {
      git('checkout', '-q', '--detach', commit);
      const outputFile = path.join(scratch, `run-${run++}.out`);
      await writeFile(outputFile, '');
      const fullEnv = { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, PR_BASE: '', ...env };
      try {
        const stdout = execFileSync('bash', ['-e', '-c', script], { cwd: repo, env: fullEnv, encoding: 'utf8' });
        return { ok: true, output: await readFile(outputFile, 'utf8'), stdout };
      } catch (error) {
        return { ok: false, output: await readFile(outputFile, 'utf8'), stdout: String((error as { stdout?: unknown }).stdout ?? '') };
      }
    };
    const assertSkipped = (result: { ok: boolean; output: string; stdout: string }, label: string): void => {
      assert.ok(result.ok, `${label}: the detection step passes`);
      assert.equal(result.output.trim(), 'present=false', `${label}: the hub checks are skipped`);
      assert.match(result.stdout, /hub checks were skipped/, `${label}: the job log says why the hub checks did not run`);
    };
    const assertFails = (result: { ok: boolean; output: string; stdout: string }, label: string): void => {
      assert.equal(result.ok, false, `${label}: the hub job must fail`);
      assert.equal(result.output.trim(), '', `${label}: no present= output is written`);
      assert.match(result.stdout, /::error title=hub missing::/, `${label}: the job log says the hub is missing`);
    };

    // A hotfix cut from a release older than the hub: absent on the head and on the base, so the job passes.
    assertSkipped(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'pull_request', PR_BASE: oldTag }), 'hotfix PR, no hub in base or head');
    assertSkipped(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'workflow_dispatch' }), 'hotfix run by hand, cut from an old tag');

    // A hotfix branch whose base has the hub but whose head deleted it fails, however the run started.
    assertFails(await detectAt(drop, { BRANCH: 'hotfix/0.4.13', EVENT: 'pull_request', PR_BASE: main }), 'hotfix PR that deletes the hub');
    assertFails(await detectAt(drop, { BRANCH: 'hotfix/0.4.13', EVENT: 'workflow_dispatch' }), 'hotfix run by hand that deletes the hub');
    assertFails(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'pull_request', PR_BASE: main }), 'hotfix PR whose base has the hub');
    // A push never skips, and a missing or unknown base never skips.
    assertFails(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'push' }), 'push without the hub');
    assertFails(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'pull_request', PR_BASE: '' }), 'hotfix PR with no base commit');
    assertFails(await detectAt(hotfix, { BRANCH: 'hotfix/0.4.13', EVENT: 'pull_request', PR_BASE: '0'.repeat(40) }), 'hotfix PR with an unknown base commit');

    // Any other branch without hub/package.json fails, even when its base has no hub either.
    for (const branch of ['fix/drop-hub', 'main', 'release/0.4.24', 'hotfix/0.4', 'hotfix/0.4.13-x', 'xhotfix/0.4.13', '']) {
      assertFails(await detectAt(hotfix, { BRANCH: branch, EVENT: 'pull_request', PR_BASE: oldTag }), `${JSON.stringify(branch)} without the hub`);
      assertFails(await detectAt(drop, { BRANCH: branch, EVENT: 'pull_request', PR_BASE: main }), `${JSON.stringify(branch)} deleting the hub`);
    }

    // With hub/package.json present the checks always run.
    for (const branch of ['fix/hub-housekeeping', 'main', 'hotfix/0.4.13']) {
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const withHub = await detectAt(main, { BRANCH: branch, EVENT: event, PR_BASE: oldTag });
        assert.ok(withHub.ok);
        assert.equal(withHub.output.trim(), 'present=true', `hub/ present runs the checks on ${branch} (${event})`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the hub job gives the older-Node refusal tests a real Node 24 and still runs everything else on 26.13.1', async () => {
  const steps = jobSteps(ciJob(await readWorkflow(), 'hub'));
  const old = steps.findIndex((step) => step.includes('uses: actions/setup-node@') && step.includes("node-version: '24'"));
  const keep = steps.findIndex((step) => step.includes('NEAR_AI_HUB_OLD_NODE=$(command -v node)') && step.includes('$GITHUB_ENV'));
  const current = steps.findIndex((step) => step.includes('uses: actions/setup-node@') && step.includes("node-version: '26.13.1'"));
  const firstNpm = steps.findIndex((step) => /run: npm /.test(step));
  assert.ok(old >= 0 && keep >= 0 && current >= 0 && firstNpm >= 0, 'the hub job installs Node 24, records its path, and installs 26.13.1');
  assert.ok(old < keep && keep < current && current < firstNpm, 'Node 24 is recorded before 26.13.1 is installed, so 26.13.1 is first on PATH for npm');
});

test('the merge gates require the hub check after the relay check, and the workflow page lists it', async () => {
  const text = await readFile(path.join(REPO_ROOT, 'scripts', 'lib', 'workflow.mjs'), 'utf8');
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith('export const CI_CHECKS'));
  assert.ok(line, 'CI_CHECKS is declared in scripts/lib/workflow.mjs');
  assert.ok(line.includes("'secret-scan', 'relay', 'hub'"), 'CI_CHECKS must list hub right after relay so the merge and tag gates wait for it');
  const page = await readFile(path.join(REPO_ROOT, 'docs', 'development-workflow.md'), 'utf8');
  assert.ok(page.split(/\r?\n/).some((row) => row.startsWith('| `hub` |')), 'the gates table in docs/development-workflow.md has a hub row');
  assert.match(page, /The eight jobs run \*\*in parallel\*\*/, 'the CI section says eight jobs run in parallel');
});

test('the release check refuses hub files in the VSIX', async () => {
  const text = await readFile(path.join(REPO_ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  const hubPattern = String.raw`/^extension\/hub(?:\/|$)/`;
  // The pattern is in the forbidden list, not a stray mention elsewhere in the file.
  const list = text.slice(text.indexOf('const forbiddenPatterns'), text.indexOf('const forbidden ='));
  assert.ok(list.includes(hubPattern), 'verify-release-content must refuse anything under extension/hub, in forbiddenPatterns');
  // And it matches what it is meant to catch.
  const hubRegex = /^extension\/hub(?:\/|$)/;
  assert.ok(hubRegex.test('extension/hub/state/hub.db') && hubRegex.test('extension/hub') && hubRegex.test('extension/hub/dist/app.mjs'));
  assert.ok(!hubRegex.test('extension/hubspot.js'), 'the pattern must not catch unrelated names that start with hub');
  assert.ok(!hubRegex.test('extension/dist/hub/x.js'), 'the pattern is anchored to the package root');
});
