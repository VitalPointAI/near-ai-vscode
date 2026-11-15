// The messaging relay (relay/) is a separate service with its own Node version, manifest and
// lockfile. The extension must stay blind to it: nothing from relay/ may ship in the .vsix, the
// root manifest keeps no workspaces and no dependencies, the root lockfile has no relay entry, the
// root compile covers only src/, and the relay's state and secret files can never be committed.
// These checks run on the extension's own toolchain (Node 24), not the relay's.

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

test('the VSIX ignores relay/ and the root .dockerignore', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.vscodeignore'));
  assert.ok(lines.includes('relay/**'), 'without relay/** in .vscodeignore the relay source, state database and secrets would ship in the .vsix');
  assert.ok(lines.includes('.dockerignore'), 'without .dockerignore in .vscodeignore the relay Docker build allow-list would ship in the .vsix');
});

test('the extension has no workspaces, dependencies or relay lock entries', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest.workspaces, undefined, 'a root workspaces key would let the relay share the extension lockfile and bundle');
  assert.equal(manifest.dependencies, undefined, 'the extension ships a zero-dependency bundle; a root dependencies key breaks that');

  const lock = await readJson('package-lock.json');
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  const relayKeys = Object.keys(packages).filter((key) => key === 'relay' || key.startsWith('relay/'));
  assert.deepEqual(relayKeys, [], 'the root lockfile must not hold any relay package; the relay has its own lockfile');
});

test('the extension compiles only src/', async () => {
  const raw = await readFile(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8');
  const tsconfig = JSON.parse(raw) as { include?: unknown; compilerOptions?: { rootDir?: unknown } };
  assert.deepEqual(tsconfig.include, ['src/**/*.ts'], 'a wider root tsconfig include would compile relay code into the extension build');
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src', 'the root rootDir must stay src so relay files cannot be compiled into dist');
});

test('relay state and secrets are git-ignored', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.gitignore'));
  assert.ok(lines.includes('relay/state/'), 'without relay/state/ in .gitignore the relay database could be committed');
  assert.ok(lines.includes('relay/secrets/'), 'without relay/secrets/ in .gitignore relay secret files could be committed');
  for (const probe of ['relay/state/relay.db', 'relay/state/relay.db-wal', 'relay/state/relay.db-shm', 'relay/secrets/teams_app_secret', 'relay/other/x.db']) {
    // git check-ignore exits 0 when the path is ignored and 1 when it is not.
    assert.doesNotThrow(
      () => execFileSync('git', ['check-ignore', '-q', probe], { cwd: REPO_ROOT, stdio: 'ignore' }),
      `${probe} would be committable; git must ignore it`,
    );
  }
});

test('the relay has its own lockfile and package', async () => {
  await access(path.join(REPO_ROOT, 'relay', 'package-lock.json'));
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'relay', 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, 'near-ai-relay');
  assert.equal(manifest.private, true, 'the relay must stay private so it can never be published by accident');
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

test('CI runs the relay job on Node 26.13.1 with pinned actions', async () => {
  const workflow = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const relay = ciJob(workflow, 'relay');
  for (const needle of [
    'name: relay',
    "node-version: '26.13.1'",
    'cache-dependency-path: relay/package-lock.json',
    'working-directory: relay',
    'persist-credentials: false',
    'npm ci --ignore-scripts',
    'npm audit --omit=dev --audit-level=high',
    'npm run lint',
    'npm test',
    'npm run test:container',
  ]) {
    assert.ok(relay.includes(needle), `the relay job must contain: ${needle}`);
  }
  const uses = relay.split(/\r?\n/).filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.ok(uses.length >= 2, 'the relay job must check out the code and set up Node');
  for (const line of uses) {
    assert.match(line, /@[0-9a-f]{40}\s+# v\d/, `every action in the relay job is pinned to a full commit SHA with a version comment: ${line.trim()}`);
  }
  // The relay's own Node version must not leak into the extension's jobs.
  assert.equal((workflow.match(/NODE_VERSION: '24'/g) ?? []).length, 1, "the workflow-level NODE_VERSION stays '24' for the extension's jobs");
  assert.ok(!ciJob(workflow, 'lint').includes('26.13.1'), 'the extension jobs stay on the default Node version');
});

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

const HAS_RELAY = "if: steps.has_relay.outputs.present == 'true'";

test('the relay job skips its checks only on a hotfix/x.y.z commit that has no relay/, and fails on any other branch without it', async () => {
  const workflow = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const steps = jobSteps(ciJob(workflow, 'relay'));
  assert.ok(steps[0]?.includes('uses: actions/checkout@'), 'the relay job checks out the code first');
  const detect = steps[1] ?? '';
  assert.ok(detect.includes('id: has_relay'), 'the second step of the relay job detects whether relay/ exists');
  // The job default is working-directory: relay, which does not exist on an old tag; the detection step must not depend on it.
  assert.ok(detect.includes('working-directory: .'), 'the detection step runs from the repository root');
  assert.ok(!detect.includes('if:'), 'the detection step always runs');
  // The branch name reaches the script through env (never interpolated into it): the PR's source branch, or the pushed or dispatched ref.
  assert.ok(detect.includes('BRANCH: ${{ github.head_ref || github.ref_name }}'), 'the detection step reads the branch name from env');
  for (const step of steps.slice(2)) {
    assert.ok(step.includes(HAS_RELAY), `every relay step after the detection is skipped when relay/ is missing:\n${step}`);
  }

  // Run the detection script itself, as the runner would, on a tree with and without relay/package.json.
  const scriptLines = detect.split('\n');
  const runAt = scriptLines.findIndex((line) => line.trim() === 'run: |');
  assert.ok(runAt >= 0, 'the detection step has a run block');
  const script = scriptLines
    .slice(runAt + 1)
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n');
  const scratch = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-ci-detect-'));
  try {
    const detectIn = async (tree: string, branch: string): Promise<{ ok: boolean; output: string; stdout: string }> => {
      const outputFile = path.join(scratch, `${path.basename(tree)}.out`);
      await writeFile(outputFile, '');
      const env = { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, BRANCH: branch };
      try {
        const stdout = execFileSync('bash', ['-e', '-c', script], { cwd: tree, env, encoding: 'utf8' });
        return { ok: true, output: await readFile(outputFile, 'utf8'), stdout };
      } catch (error) {
        return { ok: false, output: await readFile(outputFile, 'utf8'), stdout: String((error as { stdout?: unknown }).stdout ?? '') };
      }
    };
    const oldTag = path.join(scratch, 'old-tag');
    await mkdir(oldTag);
    // A hotfix cut from a release older than the relay: the job passes and says why nothing ran.
    const hotfix = await detectIn(oldTag, 'hotfix/0.4.13');
    assert.ok(hotfix.ok, 'a hotfix/x.y.z commit without relay/ passes the detection step');
    assert.equal(hotfix.output.trim(), 'present=false');
    assert.match(hotfix.stdout, /relay checks were skipped/, 'the job log says why the relay checks did not run');

    // Any other branch without relay/package.json (for example a PR that deletes it) fails the job instead of reporting green.
    for (const branch of ['fix/drop-relay', 'main', 'release/0.4.24', 'hotfix/0.4', 'hotfix/0.4.13-x', 'xhotfix/0.4.13', '']) {
      const missing = await detectIn(oldTag, branch);
      assert.equal(missing.ok, false, `a commit on ${JSON.stringify(branch)} without relay/package.json must fail the relay job`);
      assert.equal(missing.output.trim(), '', `no present= output is written for ${JSON.stringify(branch)}`);
      assert.match(missing.stdout, /::error title=relay missing::/, 'the job log says the relay is missing');
    }

    const current = path.join(scratch, 'current');
    await mkdir(path.join(current, 'relay'), { recursive: true });
    await writeFile(path.join(current, 'relay', 'package.json'), '{}');
    for (const branch of ['fix/relay-housekeeping', 'main', 'hotfix/0.4.13']) {
      const withRelay = await detectIn(current, branch);
      assert.ok(withRelay.ok);
      assert.equal(withRelay.output.trim(), 'present=true', `relay/ present runs the checks on ${branch}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the relay job gives the older-Node refusal tests a real Node 24 and still runs everything else on 26.13.1', async () => {
  const workflow = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const steps = jobSteps(ciJob(workflow, 'relay'));
  const old = steps.findIndex((step) => step.includes('uses: actions/setup-node@') && step.includes("node-version: '24'"));
  const keep = steps.findIndex((step) => step.includes('NEAR_AI_RELAY_OLD_NODE=$(command -v node)') && step.includes('$GITHUB_ENV'));
  const current = steps.findIndex((step) => step.includes('uses: actions/setup-node@') && step.includes("node-version: '26.13.1'"));
  const firstNpm = steps.findIndex((step) => /run: npm /.test(step));
  assert.ok(old >= 0 && keep >= 0 && current >= 0 && firstNpm >= 0, 'the relay job installs Node 24, records its path, and installs 26.13.1');
  assert.ok(old < keep && keep < current && current < firstNpm, 'Node 24 is recorded before 26.13.1 is installed, so 26.13.1 is first on PATH for npm');
});

test('the merge gates require the relay check', async () => {
  const text = await readFile(path.join(REPO_ROOT, 'scripts', 'lib', 'workflow.mjs'), 'utf8');
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith('export const CI_CHECKS'));
  assert.ok(line, 'CI_CHECKS is declared in scripts/lib/workflow.mjs');
  assert.ok(line.includes("'secret-scan', 'relay'"), 'CI_CHECKS must list relay after secret-scan so the merge and tag gates wait for it');
});

test('the release check refuses relay files in the VSIX', async () => {
  const text = await readFile(path.join(REPO_ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  const relayPattern = String.raw`/^extension\/relay(?:\/|$)/`;
  const dockerignorePattern = String.raw`/^extension\/\.dockerignore$/`;
  assert.ok(text.includes(relayPattern), 'verify-release-content must refuse anything under extension/relay');
  assert.ok(text.includes(dockerignorePattern), 'verify-release-content must refuse extension/.dockerignore');
  // The patterns are the ones in the forbidden list, not a stray mention elsewhere in the file.
  const list = text.slice(text.indexOf('const forbiddenPatterns'), text.indexOf('const forbidden ='));
  assert.ok(list.includes(relayPattern) && list.includes(dockerignorePattern), 'both patterns must sit in forbiddenPatterns');
  // And they match what they are meant to catch.
  const relayRegex = /^extension\/relay(?:\/|$)/;
  const dockerignoreRegex = /^extension\/\.dockerignore$/;
  assert.ok(relayRegex.test('extension/relay/state/relay.db') && relayRegex.test('extension/relay'));
  assert.ok(!relayRegex.test('extension/relayed.js'), 'the pattern must not catch unrelated names that start with relay');
  assert.ok(dockerignoreRegex.test('extension/.dockerignore'));
});
