import assert from 'node:assert/strict';
import test from 'node:test';

// The emergency stop lives in global state, which every window shares, but VS Code tells only the
// window that wrote it. A stop pressed in another window must still stop this window's runs and
// show the status item here.
//
// What this proves: the check notices a value written behind its back and announces it once. What it cannot prove: that VS Code refreshes this
// window's globalState with another window's write. The stub returns the write directly, so the real cross-window path needs a manual check in
// two windows (see the PR).

test('a stop or resume written by another window is announced here and shows on the status bar', async () => {
  const values = new Map<string, unknown>();
  const globalState = { get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback), update: async (key: string, value: unknown) => { values.set(key, value); } };
  let visible = false;
  const vscodeStub = {
    window: { createStatusBarItem: () => ({ show() { visible = true; }, hide() { visible = false; }, dispose() {} }) },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1, Right: 2 }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  const subscriptions: Array<{ dispose(): void }> = [];
  try {
    const { initEmergencyStop, onDidChangeEmergencyStop, setEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
    initEmergencyStop({ subscriptions, globalState } as never);
    const seen: boolean[] = [];
    onDidChangeEmergencyStop((engaged) => { seen.push(engaged); });
    // Another window writes the shared state directly; nothing in this window emits.
    values.set('nearAi.emergencyStop', true);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.deepEqual(seen, [true], 'the stop is announced once');
    assert.equal(visible, true);
    values.set('nearAi.emergencyStop', false);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.deepEqual(seen, [true, false]);
    assert.equal(visible, false);
    // A stop pressed in this window is announced once, not again by the check.
    await setEmergencyStop(true);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.deepEqual(seen, [true, false, true]);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    nodeModule._load = originalLoad;
  }
});
