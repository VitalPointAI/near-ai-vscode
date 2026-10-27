import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivityStore } from '../services/activityStore';
import { AnalyticsStore } from '../services/analyticsStore';
import { AuditStore } from '../services/auditStore';
import { discoverGsdArtifacts } from '../services/chatBridge';
import { ContextGraphMemory } from '../services/contextGraphMemory';
import { ProfileStore } from '../services/profileStore';
import { ProjectInitialization } from '../services/projectInitialization';
import { ReputationStore } from '../services/reputation';

// The extension activates in every workspace. A project that was never set up
// with NEAR AI must be left exactly as it was found.

test('panel startup reads leave an uninitialized workspace untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-untouched-'));
  const profiles = new ProfileStore(root);
  await profiles.exportMetadata();
  await profiles.getActiveProfile();
  await profiles.getActiveSelection();
  const activity = new ActivityStore(root);
  await activity.list();
  await new ProjectInitialization(root).getReusableBinding();
  await new AnalyticsStore({ sessions: await activity.list() }, new AuditStore(root), new ReputationStore(root), undefined, new ContextGraphMemory(root)).query();
  await discoverGsdArtifacts(root);
  assert.deepEqual(await readdir(root), []);
});

/** A fake installer that lays out a minimal Claude runtime the way the real one does. */
function fakeInstaller(calls: string[][], options: { latest?: string; broken?: boolean } = {}) {
  return async (command: string, args: string[], run: { env?: NodeJS.ProcessEnv }) => {
    calls.push([command, ...args]);
    if (command === 'npm') return { stdout: `"${options.latest ?? '1.20.0'}"`, stderr: '' };
    const home = run.env!.CLAUDE_CONFIG_DIR!;
    const version = /@(\d+\.\d+\.\d+)$/.exec(args.find((arg) => arg.startsWith('@opengsd/')) ?? '')![1];
    await mkdir(path.join(home, 'gsd-core', 'bin'), { recursive: true });
    await mkdir(path.join(home, 'skills', 'gsd-progress'), { recursive: true });
    await mkdir(path.join(home, 'agents'), { recursive: true });
    await writeFile(path.join(home, 'gsd-core', 'VERSION'), `${version}\n`);
    await writeFile(path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
    await writeFile(path.join(home, 'gsd-core', 'progress.md'), 'workflow');
    const include = options.broken ? path.join(home, 'gsd-core', 'missing.md') : path.join(home, 'gsd-core', 'progress.md');
    await writeFile(path.join(home, 'skills', 'gsd-progress', 'SKILL.md'), `---\nname: gsd-progress\ndescription: Show progress\n---\n@${include}\n`);
    await writeFile(path.join(home, 'agents', 'gsd-planner.md'), '---\nname: gsd-planner\ntools: Read, Grep\n---\nYou plan.\n');
    return { stdout: '', stderr: '' };
  };
}

test('in a workspace never set up with NEAR AI, runtime updates make no npm calls and start no timer', async () => {
  const { GsdRuntime, startRuntimeUpdates } = await import('../gsd/runtime');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-foreign-'));
  const calls: string[][] = [];
  const runtime = new GsdRuntime(await mkdtemp(path.join(tmpdir(), 'near-ai-store-')), fakeInstaller(calls));
  assert.equal(await startRuntimeUpdates(runtime, root, () => undefined), undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(root), []);
});

test('the runtime installs an exact version into extension storage, never ~/.claude, and checks it first', async () => {
  const { GsdRuntime } = await import('../gsd/runtime');
  const store = await mkdtemp(path.join(tmpdir(), 'near-ai-store-'));
  const calls: string[][] = [];
  const runtime = new GsdRuntime(store, fakeInstaller(calls, { latest: '1.20.0' }));
  const home = await runtime.ensure();
  assert.equal(home, path.join(store, 'gsd', '1.20.0'));
  assert.deepEqual(calls.at(-1), ['npx', '--yes', '@opengsd/gsd-core@1.20.0', '--claude', '--global']);
  assert.equal(await runtime.installedVersion(), '1.20.0');
  await runtime.ensure();
  assert.equal(calls.filter((call) => call[0] === 'npx').length, 1, 'an installed runtime is not reinstalled');
});

test('a release that fails the compatibility check never replaces the working version', async () => {
  const { GsdRuntime } = await import('../gsd/runtime');
  const store = await mkdtemp(path.join(tmpdir(), 'near-ai-store-'));
  await new GsdRuntime(store, fakeInstaller([], { latest: '1.20.0' })).ensure();
  const broken = new GsdRuntime(store, fakeInstaller([], { latest: '1.21.0', broken: true }));
  await assert.rejects(() => broken.update(), /failed the compatibility check, so the previous version stays active/);
  assert.equal(await broken.installedVersion(), '1.20.0');
  assert.deepEqual((await readdir(path.join(store, 'gsd'))).sort(), ['1.20.0', 'current.json']);
});

test('updates move only to newer releases and keep the previous version for rollback', async () => {
  const { GsdRuntime } = await import('../gsd/runtime');
  const store = await mkdtemp(path.join(tmpdir(), 'near-ai-store-'));
  await new GsdRuntime(store, fakeInstaller([], { latest: '1.20.0' })).ensure();
  const same: string[][] = [];
  assert.equal(await new GsdRuntime(store, fakeInstaller(same, { latest: '1.20.0' })).update(), undefined);
  assert.equal(same.some((call) => call[0] === 'npx'), false);
  assert.deepEqual(await new GsdRuntime(store, fakeInstaller([], { latest: '1.21.0' })).update(), { from: '1.20.0', to: '1.21.0' });
  assert.deepEqual((await readdir(path.join(store, 'gsd'))).sort(), ['1.20.0', '1.21.0', 'current.json']);
});
