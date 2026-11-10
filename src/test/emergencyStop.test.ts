import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The emergency stop must reach every open window. globalState is per-window in memory, so windows share the stop through a file in the extension's
// global storage folder, which is the same folder for every window. Two "windows" here are two loads of the module pointed at one folder.

function stubVscode(): { restore(): void; visible(): boolean } {
  let shown = false;
  const vscodeStub = {
    window: { createStatusBarItem: () => ({ show() { shown = true; }, hide() { shown = false; }, dispose() {} }) },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1, Right: 2 }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  return { restore: () => { nodeModule._load = originalLoad; }, visible: () => shown };
}

/** A fresh copy of the module, as a separate window would have. */
function freshWindow(): typeof import('../services/emergencyStop') {
  const id = require.resolve('../services/emergencyStop');
  delete require.cache[id];
  return require(id) as typeof import('../services/emergencyStop');
}

const memento = () => {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback), update: async (key: string, value: unknown) => { values.set(key, value); } };
};

test('a stop pressed in one window reaches another through the shared file, and is announced there once', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-stop-'));
  const stub = stubVscode();
  const subscriptions: Array<{ dispose(): void }> = [];
  try {
    const one = freshWindow();
    one.initEmergencyStop({ subscriptions, globalState: memento(), globalStorageUri: { fsPath: storage } } as never);
    const two = freshWindow();
    two.initEmergencyStop({ subscriptions, globalState: memento(), globalStorageUri: { fsPath: storage } } as never);
    const seenByTwo: boolean[] = [];
    two.onDidChangeEmergencyStop((engaged) => { seenByTwo.push(engaged); });

    await one.setEmergencyStop(true);
    assert.equal(JSON.parse(await readFile(path.join(storage, 'emergency-stop.json'), 'utf8')).engaged, true, 'the stop is in the shared file');
    assert.equal(two.isEmergencyStopped(), false, 'window two has not checked yet');
    two.checkOtherWindows();
    assert.equal(two.isEmergencyStopped(), true, 'window two now refuses to run');
    assert.deepEqual(seenByTwo, [true], 'and announced it, which is what stops its runs');
    two.checkOtherWindows();
    assert.deepEqual(seenByTwo, [true], 'once');
    assert.equal(stub.visible(), true);

    await one.setEmergencyStop(false);
    two.checkOtherWindows();
    assert.equal(two.isEmergencyStopped(), false);
    assert.deepEqual(seenByTwo, [true, false]);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    stub.restore();
  }
});

test('a window\'s own change is announced once, never again by its own check, and a damaged shared file changes nothing', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-stop-'));
  const stub = stubVscode();
  const subscriptions: Array<{ dispose(): void }> = [];
  try {
    const one = freshWindow();
    one.initEmergencyStop({ subscriptions, globalState: memento(), globalStorageUri: { fsPath: storage } } as never);
    const seen: boolean[] = [];
    one.onDidChangeEmergencyStop((engaged) => { seen.push(engaged); });
    await one.setEmergencyStop(true);
    one.checkOtherWindows();
    assert.deepEqual(seen, [true]);
    await writeFile(path.join(storage, 'emergency-stop.json'), '{ half', 'utf8');
    one.checkOtherWindows();
    assert.equal(one.isEmergencyStopped(), true, 'an unreadable file never releases a stop');
    assert.deepEqual(seen, [true]);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    stub.restore();
  }
});

test('a stop recorded before the shared file existed still holds after a reload', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-stop-'));
  const stub = stubVscode();
  const subscriptions: Array<{ dispose(): void }> = [];
  try {
    const state = memento();
    await state.update('nearAi.emergencyStop', true);
    const one = freshWindow();
    one.initEmergencyStop({ subscriptions, globalState: state, globalStorageUri: { fsPath: storage } } as never);
    assert.equal(one.isEmergencyStopped(), true);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    stub.restore();
  }
});
