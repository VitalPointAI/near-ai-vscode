// PR #74 review round 4: `npm run x` runs the script of the package.json in the folder the command runs in, not the project root's. The floor read only
// the root's, so `cd sub && npm run x`, where sub/package.json's x pushes, was read as a harmless project script and ran unasked in Full auto. The folder
// is now the shell's folder, moved by any cd or pushd earlier on the line and by --prefix, -C, --cwd, --dir and --workspace; the package.json there (or
// the nearest one above it inside the project) is read, cached by folder and read again when it changes. A folder that cannot be known, one outside the
// project, or a package.json that cannot be read gives unknown effects (the gate asks), never "a project script". Nothing here runs a command, and every
// folder is under the test run's temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext, CommandEffect } from '../agent/commandSafety';
import { floorFactsFor, gateToolCall } from '../agent/gateAdapter';
import { PackageScriptsReader } from '../agent/packageScripts';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import { testGateRuntime } from './helpers/gatedRuns';

const PUSH: CommandEffect = { verb: 'publish', target: 'git-remote' };
const REGISTRY: CommandEffect = { verb: 'publish', target: 'registry' };

function packageJson(folder: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: path.basename(folder), ...extra, scripts }, null, 2));
}

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-pkgdir-')));
  packageJson(root, { test: 'echo ok', build: 'echo build', sync: 'echo root sync' }, { workspaces: ['packages/*'] });
  packageJson(path.join(root, 'sub'), { sync: 'git push', test: 'rm -rf src', start: 'git push', tidy: 'rm -rf src' });
  packageJson(path.join(root, 'packages', 'app'), { deploy: 'npm publish', sync: 'git push' }, { name: '@acme/app' });
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'broken'));
  writeFileSync(path.join(root, 'broken', 'package.json'), '{ "scripts": { "sync": ');
  return root;
}

function classifierIn(root: string, cwd = root) {
  const reader = new PackageScriptsReader();
  const context: CommandContext = { root, cwd, home: path.join(root, '..', 'stand-in-home'), packageScriptsAt: (folder) => reader.at(folder, root) };
  return (command: string) => classifyCommand(command, context);
}

const has = (effects: readonly CommandEffect[] | undefined, wanted: CommandEffect): boolean => (effects ?? []).some((effect) => JSON.stringify(effect) === JSON.stringify(wanted));

test('npm, yarn, pnpm and bun read the scripts of the folder they run in: after cd or pushd, from the shell\'s folder, and with folder options', () => {
  const root = project();
  const classify = classifierIn(root);
  const pushes = [
    'cd sub && npm run sync', 'cd sub; npm run sync', 'cd ./sub && npm run-script sync', 'pushd sub && npm run sync', 'cd sub && npm start', 'cd sub && pnpm sync',
    'cd sub && yarn sync', 'cd sub && bun run sync', 'npm --prefix sub run sync', 'npm run sync --prefix=sub', 'npm -C sub run sync', 'yarn --cwd sub sync',
    'yarn --cwd=sub run sync', 'pnpm -C sub run sync', 'pnpm --dir sub run sync', 'bun --cwd sub run sync', 'cd packages && npm --prefix ../sub run sync'
  ];
  const wrong = pushes.filter((command) => !has(classify(command).effects, PUSH) || classify(command).effectsUnknown !== undefined);
  assert.deepEqual(wrong.map((command) => `${command} → ${JSON.stringify(classify(command))}`), []);
  assert.ok(has(classify('cd sub && npm test').effects, { verb: 'destroy', paths: ['sub/src'] }), 'the script runs in its own folder, so src is sub/src');
  assert.ok(has(classifierIn(root, path.join(root, 'sub'))('npm run tidy').effects, { verb: 'destroy', paths: ['sub/src'] }), 'the shell already in sub');
  // A folder with no package.json of its own runs the nearest one above it: the root's, which pushes nothing.
  for (const command of ['cd docs && npm run sync', 'npm run sync', 'cd docs && npm test']) {
    const result = classify(command);
    assert.equal(result.effects, undefined, command);
    assert.equal(result.effectsUnknown, undefined, command);
  }
});

test('a nested workspace package is read by its folder, by cd and by --workspace with a path', () => {
  const root = project();
  const classify = classifierIn(root);
  for (const command of ['cd packages/app && npm run deploy', 'npm run deploy -w packages/app', 'npm run deploy --workspace=packages/app', 'npm --workspace packages/app run deploy']) {
    const result = classify(command);
    assert.ok(has(result.effects, REGISTRY), `${command} → ${JSON.stringify(result)}`);
    assert.equal(result.effectsUnknown, undefined, command);
  }
});

test('a folder that cannot be known, is outside the project, or has a package.json that cannot be read gives unknown effects, never a project script', () => {
  const root = project();
  const classify = classifierIn(root);
  const unknowns = [
    'cd $DIR && npm run sync', 'cd "$(git rev-parse --show-toplevel)/sub" && npm run sync', 'cd sub/* && npm run sync', 'cd - && npm run sync', 'cd .. && npm run sync',
    'cd /srv/other && npm run sync', 'cd broken && npm run sync', 'npm --prefix "$P" run sync', 'npm --prefix ../elsewhere run sync', 'npm run sync -w @acme/app',
    'npm run sync --workspaces', 'npm run sync -ws', 'pnpm -r run sync', 'pnpm --recursive sync', 'pnpm --filter app sync', 'pnpm -F app sync', 'yarn workspace app sync',
    'yarn workspaces foreach run sync', 'bun --filter app run sync', 'popd && npm run sync', 'pushd && npm run sync', '(cd sub && true); npm run sync', 'cd && npm run sync'
  ];
  const wrong = unknowns.filter((command) => classify(command).effectsUnknown === undefined || classify(command).verdict === 'safe');
  assert.deepEqual(wrong.map((command) => `${command} → ${JSON.stringify(classify(command))}`), []);
});

// PR #74 review round 8: a cache keyed on size and time missed a same-size rewrite within the clock's resolution. The file is read for every decision
// (a package.json is small), and only its parse is kept, by the file's content, so a rewrite is seen whatever its size and time.
test('the reader reads each package.json for every decision and keeps only its parse, by content', () => {
  const root = project();
  let reads = 0;
  const reader = new PackageScriptsReader({ statSync, readFileSync: ((file: string, encoding: BufferEncoding) => { reads += 1; return readFileSync(file, encoding); }) as typeof readFileSync });
  const sub = path.join(root, 'sub');
  const first = reader.at(sub, root);
  assert.equal(first.kind, 'found');
  assert.equal(reader.at(sub, root), first, 'unchanged content: the same parse');
  reader.at(path.join(sub, 'deeper'), root);
  assert.equal(reads, 3, 'read for every decision');
  packageJson(sub, { sync: 'echo nothing to push now' });
  const again = reader.at(sub, root);
  assert.deepEqual(again.kind === 'found' ? again.scripts : undefined, { sync: 'echo nothing to push now' });
  assert.equal(reader.at(path.join(root, 'broken'), root).kind, 'unreadable');
  assert.equal(reader.at(path.join(root, '..'), root).kind, 'outside');
});

test('the reader never looks above the project: a project with no package.json is outside, and nothing above it is read', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'near-ai-pkg-walk-'));
  writeFileSync(path.join(parent, 'package.json'), JSON.stringify({ scripts: { sync: 'git push' } }));
  const root = path.join(parent, 'project');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  const looked: string[] = [];
  const reader = new PackageScriptsReader({ statSync: ((file: string) => { looked.push(path.resolve(file)); return statSync(file); }) as typeof statSync, readFileSync });
  const found = reader.at(path.join(root, 'sub'), root);
  assert.equal(found.kind, 'outside', 'a package.json a package manager would find above the project is not read, so it is unknown');
  assert.deepEqual(looked.filter((file) => !file.startsWith(root + path.sep)), [], 'no file outside the project was looked at');
  assert.deepEqual(classifyCommand('cd sub && npm run sync', { root, cwd: root, packageScriptsAt: (folder) => reader.at(folder, root) }).effectsUnknown !== undefined, true, 'so its effects are unknown');
});

test('a rewrite of the same size with the same time is seen', () => {
  const root = project();
  const reader = new PackageScriptsReader();
  const folder = path.join(root, 'same');
  packageJson(folder, { sync: 'echo aaaaaa' });
  const file = path.join(folder, 'package.json');
  const STAMP = 1_700_000_000; // whole seconds, so the time set back is exactly the time read
  utimesSync(file, STAMP, STAMP);
  const before = statSync(file);
  assert.deepEqual((reader.at(folder, root) as { scripts: unknown }).scripts, { sync: 'echo aaaaaa' });
  // Same length, same time: only the content differs.
  writeFileSync(file, readFileSync(file, 'utf8').replace('echo aaaaaa', 'git push -f'));
  utimesSync(file, STAMP, STAMP);
  const after = statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual((reader.at(folder, root) as { scripts: unknown }).scripts, { sync: 'git push -f' });
  assert.ok((classifyCommand('cd same && npm run sync', { root, cwd: root, packageScriptsAt: (at) => reader.at(at, root) }).effects ?? []).length > 0, 'and the floor sees the push');
});

test('through the gate in Full auto: cd into a package whose script pushes is a floor publish, an unknown folder asks, with nobody both are refused', async () => {
  const root = project();
  const reader = new PackageScriptsReader();
  for (const presence of ['person', 'none'] as const) {
    const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
    for (const [command, rule] of [['cd sub && npm run sync', 'floor.publish'], ['cd $DIR && npm run sync', 'manifest.effects-unknown']] as const) {
      const gated = await gateToolCall(runtime, {
        tool: bashTool, raw: { command }, root, callId: `${presence}-${command}`, command, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
        grants: new RunGrants(), shell: { cwd: root, packageScriptsAt: (folder) => reader.at(folder, root) }, buildAuto: async () => undefined
      });
      assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${presence}: ${command}`);
      assert.equal(gated.decision.rule, rule, `${presence}: ${command}`);
    }
  }
  const facts = await floorFactsFor({ command: 'npm --prefix sub run sync', root, packageScriptsAt: (folder) => reader.at(folder, root) });
  assert.ok(has(facts.effects, PUSH));
});

test('reading the right folder never makes a command newly safe: folder options, npm start and pnpm scripts by name stay unknown when harmless', () => {
  const root = project();
  packageJson(path.join(root, 'quiet'), { check: 'echo fine', start: 'echo fine' });
  const classify = classifierIn(root);
  for (const command of ['npm --prefix quiet run check', 'pnpm -C quiet run check', 'yarn --cwd quiet check', 'cd quiet && npm start', 'cd quiet && pnpm check', 'npm ci --prefix quiet']) {
    const result = classify(command);
    assert.equal(result.verdict, 'unknown', `${command} → ${JSON.stringify(result)}`);
    assert.equal(result.effects, undefined, command);
  }
  // A plain run in the folder it names is read as it always was.
  assert.equal(classify('cd quiet && npm run check').verdict, 'safe');
  assert.equal(classify('npm --prefix sub run sync').verdict, 'risky');
});

// PR #74 review round 6: scripts nobody read are unknown, never an empty set. A caller that hands the classifier no reader and no root scripts used to have
// `npm test` (or `cd sub && npm run x`) read as a harmless project script. One test per kind of caller of the classifier.
test('with no reader and no scripts, a named script is unknown in the root and in a subfolder, for the classifier itself', () => {
  const bare: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };
  for (const command of ['npm test', 'npm run sync', 'cd sub && npm run sync', 'yarn build', 'pnpm test', 'cd sub && npm start']) {
    const result = classifyCommand(command, bare);
    assert.notEqual(result.verdict, 'safe', `${command} → ${JSON.stringify(result)}`);
    assert.equal(typeof result.effectsUnknown, 'string', command);
  }
  // A release-like name still says what it does on its own word.
  assert.deepEqual(classifyCommand('npm run release', bare).effects, [{ verb: 'publish', target: 'release' }]);
  // Root scripts the caller read are read; a subfolder's, which nobody read, are not.
  assert.equal(classifyCommand('npm test', { ...bare, packageScripts: { test: 'echo ok' } }).verdict, 'safe');
  assert.equal(typeof classifyCommand('cd sub && npm test', { ...bare, packageScripts: { test: 'echo ok' } }).effectsUnknown, 'string');
});

test('auto approval and permissions with no reader: a named script is not run without the safety model, and with none it asks', async () => {
  const { decidePermissionAsync } = await import('../agent/permissions');
  const asked: string[] = [];
  const safety = { async check(command: string) { asked.push(command); return { allow: false, reason: 'Safety model: not checked here.' }; } };
  const bare = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };
  const withModel = await decidePermissionAsync('shell', 'npm run sync', { mode: 'auto', emergencyStop: false }, DEFAULT_RULES, new RunGrants(), { ...bare, safety });
  assert.equal(withModel.decision, 'ask');
  assert.deepEqual(asked, ['npm run sync'], 'it went to the safety model: the rules did not call it safe');
  const none = await decidePermissionAsync('shell', 'npm test', { mode: 'auto', emergencyStop: false }, DEFAULT_RULES, new RunGrants(), bare);
  assert.equal(none.decision, 'ask');
});

test('the unattended check with no reader does not let a named script run', async () => {
  const { unattendedDecision } = await import('../agent/unattended');
  for (const command of ['npm test', 'npm run sync', 'cd sub && npm run build']) {
    assert.equal((await unattendedDecision(command, { root: '/work/app', cwd: '/work/app' }, false)).allow, false, command);
  }
});

test('the gate with no reader and no scripts: a named script has unknown effects, so Full auto asks with a person and refuses with nobody', async () => {
  const root = project();
  const facts = await floorFactsFor({ command: 'npm run sync', root });
  assert.equal(typeof facts.effectsUnknown, 'string');
  for (const presence of ['person', 'none'] as const) {
    const gated = await gateToolCall(testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' }), {
      tool: bashTool, raw: { command: 'npm run sync' }, root, callId: `bare-${presence}`, command: 'npm run sync', policy: { mode: 'fully-autonomous', emergencyStop: false },
      rules: DEFAULT_RULES, grants: new RunGrants(), shell: { cwd: root }, buildAuto: async () => undefined
    });
    assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', presence);
    assert.equal(gated.decision.rule, 'manifest.effects-unknown');
  }
});

test('the cyber panel\'s permission path never runs the classifier without its context: in auto a shell step asks', async () => {
  const { decidePermission } = await import('../agent/permissions');
  // cyberRun calls decidePermission with no auto context, so the classifier is never asked and a named script is not judged safe.
  assert.equal(decidePermission('shell', 'npm run sync', { mode: 'auto', emergencyStop: false }, DEFAULT_RULES, new RunGrants(), undefined).decision, 'ask');
});
