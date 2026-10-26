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
import type { GsdUpdater as GsdUpdaterType } from '../services/gsdUpdater';

// The extension activates in every workspace. A project that was never set up
// with NEAR AI must be left exactly as it was found.

function loadUpdater(): typeof GsdUpdaterType {
  // gsdUpdater.ts imports VS Code host APIs for notifications only; stub that boundary.
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { workspace: { workspaceFolders: undefined }, window: { showInformationMessage: () => undefined, showWarningMessage: () => undefined } } : originalLoad(request, parent, isMain);
  try {
    return (require('../services/gsdUpdater') as typeof import('../services/gsdUpdater')).GsdUpdater;
  } finally {
    nodeModule._load = originalLoad;
  }
}

function recordingRunner(calls: Array<{ args: string[]; cwd?: string }>) {
  return async (command: string, args: string[], cwd?: string) => {
    calls.push({ args: [command, ...args], cwd });
    if (args[0] === 'view') return { stdout: '"9.9.9"', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

/** A runtime home with Open-GSD installed the way the real installer leaves it. */
async function runtimeHome(version?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-runtime-'));
  if (version) {
    await mkdir(path.join(home, 'gsd-core'), { recursive: true });
    await writeFile(path.join(home, 'gsd-core', 'VERSION'), `${version}\n`);
  }
  return home;
}

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

const fakeContext = () => ({ subscriptions: [] as Array<{ dispose(): void }> });

test('activation in a workspace never set up with NEAR AI makes no npm calls and starts no timer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-foreign-'));
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  const context = fakeContext();
  assert.equal(await new GsdUpdater(recordingRunner(calls), root).start(context as never), false);
  assert.deepEqual(calls, []);
  assert.equal(context.subscriptions.length, 0);
  assert.deepEqual(await readdir(root), []);
});

test('activation in a NEAR AI project keeps Open-GSD current', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-initiated-'));
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  const context = fakeContext();
  assert.equal(await new GsdUpdater(recordingRunner(calls), root, undefined, undefined, await runtimeHome('1.0.0')).start(context as never), true);
  context.subscriptions.forEach((subscription) => subscription.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call.args[1] === 'view'), true, 'checks the registry for a newer release');
});

test('an Open-GSD install is detected from its VERSION file, so ensureInstalled does not reinstall it', async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  assert.equal(await new GsdUpdater(recordingRunner(calls), undefined, undefined, undefined, await runtimeHome('1.19.0')).ensureInstalled(), true);
  assert.deepEqual(calls, []);
});

test('ensureInstalled installs Open-GSD only when the runtime has no VERSION file', async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  await new GsdUpdater(recordingRunner(calls), undefined, undefined, undefined, await runtimeHome()).ensureInstalled();
  assert.equal(calls.some((call) => call.args[0] === 'npx' && call.args.includes('--global')), true);
});

test('a current install is left alone; an older one is updated', async () => {
  const GsdUpdater = loadUpdater();
  const current: Array<{ args: string[]; cwd?: string }> = [];
  await new GsdUpdater(recordingRunner(current), undefined, undefined, undefined, await runtimeHome('9.9.9')).checkAndUpdate();
  assert.equal(current.some((call) => call.args[0] === 'npx'), false);
  const older: Array<{ args: string[]; cwd?: string }> = [];
  await new GsdUpdater(recordingRunner(older), undefined, undefined, undefined, await runtimeHome('9.9.8')).checkAndUpdate();
  assert.equal(older.some((call) => call.args[0] === 'npx'), true);
});

test('updater never installs Open-GSD into a project that does not already have it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-no-local-'));
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  await new GsdUpdater(recordingRunner(calls), root, undefined, undefined, await runtimeHome()).checkAndUpdate();
  assert.equal(calls.some((call) => call.args.includes('--local')), false);
  assert.equal(calls.some((call) => call.cwd === root), false);
  assert.deepEqual(await readdir(root), []);
});

test('updater refreshes an existing project-local Open-GSD install', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-local-'));
  await mkdir(path.join(root, '.codex', 'gsd-core'), { recursive: true });
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  await new GsdUpdater(recordingRunner(calls), root, undefined, undefined, await runtimeHome()).checkAndUpdate();
  assert.equal(calls.some((call) => call.args.includes('--local') && call.cwd === root), true);
});
