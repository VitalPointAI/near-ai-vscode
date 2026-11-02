// IN-05 and advisory A1 of 62-SECURITY.md: the extension hands its test API (the Team Mode handle, SecretStorage and the storage folder) only to the
// extension-host tests, which set NEAR_AI_E2E=1. A normal activation returns undefined, and the board's test seams stay off.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

// The shared stub covers what the adapters under test use. activate() touches far more of the API, so every member the stub lacks answers with an
// inert function that returns itself (so .dispose(), event registration and constructors all work and do nothing). Only this file does that.
/* eslint-disable @typescript-eslint/no-explicit-any */
const inert: any = new Proxy(function inert(): void { /* nothing */ }, {
  get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert
});
function permissive(value: any): any {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      if (key in target) return permissive(Reflect.get(target, key, receiver));
      return typeof key === 'symbol' || key === 'then' ? undefined : inert;
    }
  });
}
const stub = createVscodeStub();
const uninstall = installVscodeStub({ ...stub, vscode: permissive(stub.vscode) });
test.after(() => { uninstall(); });

async function activateWith(e2e: string | undefined): Promise<{ result: unknown; dispose(): void }> {
  const before = process.env.NEAR_AI_E2E;
  if (e2e === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = e2e;
  const storage = mkdtempSync(path.join(tmpdir(), 'near-ai-activate-'));
  const workspace = (stub.vscode as { workspace: { getConfiguration(section: string): { update(key: string, value: unknown): Promise<void> } } }).workspace;
  await workspace.getConfiguration('nearAi').update('autoInstallGsd', false);
  const context = { ...createFakeContext(storage, { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) }), globalState: { get: () => undefined, update: async () => undefined, keys: () => [] }, workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] }, extensionPath: path.resolve(__dirname, '..', '..') };
  try {
    const { activate } = require('../extension') as typeof import('../extension');
    const result = activate(context as never);
    return {
      result,
      dispose: () => {
        for (const item of (context.subscriptions as Array<{ dispose?: () => unknown }>).splice(0)) { try { item.dispose?.(); } catch { /* best effort */ } }
        rmSync(storage, { recursive: true, force: true });
      }
    };
  } finally {
    if (before === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = before;
  }
}

test('IN-05: activate() returns undefined without NEAR_AI_E2E=1, so SecretStorage and the team handle never leave the extension', async () => {
  for (const value of [undefined, '', '0', 'true', ' 1']) {
    const run = await activateWith(value);
    try {
      assert.equal(run.result === undefined, true, `NEAR_AI_E2E=${JSON.stringify(value)} returns nothing`);
    } finally {
      run.dispose();
    }
  }
  const e2e = await activateWith('1');
  try {
    assert.equal(typeof e2e.result === 'object' && e2e.result !== null && 'team' in e2e.result, true, 'the extension-host tests still get their API');
  } finally {
    e2e.dispose();
  }
});
