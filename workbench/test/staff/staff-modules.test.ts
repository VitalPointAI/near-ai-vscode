// Phase 33 plan 31 (D-52): the staff modules. The backend module binds the session's live engine (StaffLiveSession), the status service at its RPC
// path and the lifecycle contribution once, and calls each backend part once; the frontend module binds this tab's status client and the status
// proxy, and calls each of the five browser parts once. The frontend module imports no engine, key or Yjs module.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Container, type interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging/index.js';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { STAFF_STATUS_PATH, StaffStatusServer } from '../../extension/src/common/staff-live.ts';
import { StaffLiveSessionId, createStaffBackendModule } from '../../extension/src/node/staff-backend-module.ts';
import { SessionIdentity } from '../../extension/src/node/session-identity.ts';

const extensionRoot = fileURLToPath(new URL('../../../extension/', import.meta.url));

function spies<K extends string>(names: readonly K[]): { parts: Record<K, (bind: interfaces.Bind) => void>; calls: Record<K, number> } {
  const calls = Object.fromEntries(names.map((name) => [name, 0])) as Record<K, number>;
  const parts = Object.fromEntries(names.map((name) => [name, (bind: interfaces.Bind) => { assert.equal(typeof bind, 'function'); calls[name] += 1; }])) as Record<K, (bind: interfaces.Bind) => void>;
  return { parts, calls };
}

test('the backend module binds the live session, the status service and its lifecycle once, and calls each backend part once', () => {
  const { parts, calls } = spies(['binding', 'staffRoom', 'share'] as const);
  const container = new Container();
  // The session's identity, as 46-02 binds it: the lifecycle contribution resolves the live session, which reads it.
  container.bind(SessionIdentity).toConstantValue({ status: () => ({ mode: 'local' }) });
  container.load(createStaffBackendModule(parts, () => undefined));
  assert.deepEqual(calls, { binding: 1, staffRoom: 1, share: 1 });
  assert.equal(container.isBound(StaffLiveSessionId), true);
  assert.equal(container.isBound(StaffStatusServer), true);
  const handlers = container.getAll<ConnectionHandler>(ConnectionHandler);
  assert.deepEqual(handlers.map((handler) => (handler as RpcConnectionHandler<object>).path), [STAFF_STATUS_PATH]);
  assert.equal(container.getAll(BackendApplicationContribution).length, 1);
});

test('the frontend module calls each of the five browser parts once, binds the status client, and imports nothing of the engine', async () => {
  const imports = readFileSync(`${extensionRoot}src/browser/staff-frontend-module.ts`, 'utf8').split('\n').filter((line) => line.startsWith('import ')).join('\n');
  for (const forbidden of [/\/node\//, /staff-engine/, /session-keys/, /encryption-key/, /yjs/i, /replica/i]) assert.doesNotMatch(imports, forbidden);
  const { createStaffFrontendModule, StaffStatusEvents } = await import('../../extension/src/browser/staff-frontend-core.ts');
  const { parts, calls } = spies(['binding', 'presence', 'staffRoom', 'share', 'status'] as const);
  const container = new Container();
  container.load(createStaffFrontendModule(parts));
  assert.deepEqual(calls, { binding: 1, presence: 1, staffRoom: 1, share: 1, status: 1 });
  assert.equal(container.isBound(StaffStatusServer), true);
  const events = container.get(StaffStatusEvents);
  const seen: string[] = [];
  events.onDidChangeStatus((row) => seen.push(row.state));
  events.onDidRequestJoin((request) => seen.push(`join ${request.invite ?? ''}`));
  events.onStatus({ project: 'a'.repeat(32), root: '/home/sterling/workspace/exercise', state: 'live', sentence: 'Synced with your organization\'s server.' });
  events.onJoinRequest({ project: 'a'.repeat(32), invite: 'inv-casey' });
  assert.deepEqual(seen, ['live', 'join inv-casey']);
});
