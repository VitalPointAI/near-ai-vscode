import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
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
    if (args[0] === 'list') return { stdout: '{}', stderr: '' };
    if (args[0] === 'view') return { stdout: '"9.9.9"', stderr: '' };
    return { stdout: '', stderr: '' };
  };
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
  assert.equal(await new GsdUpdater(recordingRunner(calls), root).start(context as never), true);
  context.subscriptions.forEach((subscription) => subscription.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call.args[1] === 'list'), true);
});

test('ensureInstalled skips the installer when Open-GSD is already present', async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const runner = async (command: string, args: string[], cwd?: string) => { calls.push({ args: [command, ...args], cwd }); return { stdout: JSON.stringify({ dependencies: { '@opengsd/gsd-core': { version: '1.0.0' } } }), stderr: '' }; };
  const GsdUpdater = loadUpdater();
  assert.equal(await new GsdUpdater(runner, undefined).ensureInstalled(), true);
  assert.equal(calls.some((call) => call.args[0] === 'npx'), false);
});

test('updater never installs Open-GSD into a project that does not already have it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-no-local-'));
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  await new GsdUpdater(recordingRunner(calls), root).checkAndUpdate();
  assert.equal(calls.some((call) => call.args.includes('--local')), false);
  assert.equal(calls.some((call) => call.cwd === root), false);
  assert.deepEqual(await readdir(root), []);
});

test('updater refreshes an existing project-local Open-GSD install', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-local-'));
  await mkdir(path.join(root, '.codex', 'gsd-core'), { recursive: true });
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const GsdUpdater = loadUpdater();
  await new GsdUpdater(recordingRunner(calls), root).checkAndUpdate();
  assert.equal(calls.some((call) => call.args.includes('--local') && call.cwd === root), true);
});
