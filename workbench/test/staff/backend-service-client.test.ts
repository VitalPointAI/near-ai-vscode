// Phase 33 plan 24 (D-52): bindBackendService's optional withClient. Every connecting tab passes its client; the service keeps them, sends each one
// its on* notifications, and drops a client when its connection closes. Without withClient the helper binds as 46-01 did. The status service fans out
// the live engine's rows and join requests to every connected tab.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Container } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler, type RpcProxy } from '@theia/core/lib/common/messaging/index.js';
import { STAFF_STATUS_PATH, STAFF_STATUS_TEXT, StaffStatusServer, type StaffJoinRequest, type StaffStatusClient, type StaffStatusRow } from '../../extension/src/common/staff-live.ts';
import { bindBackendService } from '../../extension/src/node/backend-service.ts';
import { StaffStatusService, bindStaffStatusService, type StaffStatusSource } from '../../extension/src/node/staff/staff-status-service.ts';

interface Recorder extends StaffStatusClient {
  rows: StaffStatusRow[];
  joins: StaffJoinRequest[];
  close(): void;
}

/** A tab's client proxy: records its notifications, and close() fires onDidCloseConnection as Theia does when the tab's connection ends. */
function tab(): RpcProxy<Recorder> {
  const closers: Array<() => void> = [];
  const client = {
    rows: [] as StaffStatusRow[],
    joins: [] as StaffJoinRequest[],
    onStatus(row: StaffStatusRow) { client.rows.push(row); },
    onJoinRequest(request: StaffJoinRequest) { client.joins.push(request); },
    onDidOpenConnection: () => ({ dispose() {} }),
    onDidCloseConnection: (listener: () => void) => { closers.push(listener); return { dispose() {} }; },
    close() { for (const closer of closers) closer(); },
  };
  return client as unknown as RpcProxy<Recorder>;
}

const ROW: StaffStatusRow = { project: 'a'.repeat(32), root: '/home/sterling/workspace/exercise', state: 'live', sentence: 'Synced with your organization\'s server.' };

/** The engine as the status service reads it: rows, Sync Now, and the two listeners the test fires. */
function fakeEngine(rows: StaffStatusRow[] = [ROW]) {
  const statusListeners: Array<(row: StaffStatusRow) => void> = [];
  const joinListeners: Array<(request: StaffJoinRequest) => void> = [];
  const engine: StaffStatusSource & { emit(row: StaffStatusRow): void; join(request: StaffJoinRequest): void } = {
    projects: () => rows,
    syncNow: (project: string) => rows.find((row) => row.project === project),
    onStatus: (listener) => { statusListeners.push(listener); return { dispose() {} }; },
    onJoinRequest: (listener) => { joinListeners.push(listener); return { dispose() {} }; },
    emit: (row) => { for (const listener of statusListeners) listener(row); },
    join: (request) => { for (const listener of joinListeners) listener(request); },
  };
  return engine;
}

function handlerOf(container: Container): RpcConnectionHandler<object> {
  const handlers = container.getAll<ConnectionHandler>(ConnectionHandler);
  assert.equal(handlers.length, 1);
  assert.ok(handlers[0] instanceof RpcConnectionHandler);
  return handlers[0] as RpcConnectionHandler<object>;
}

test('withClient receives each connecting tab\'s client with the one service; without it the helper binds as before', () => {
  const container = new Container();
  const id = Symbol('Probe');
  const seen: Array<[object, object]> = [];
  bindBackendService<{ name: string }, object>(container.bind.bind(container), id, '/services/sterling-probe', () => ({ name: 'probe' }), (service, client) => { seen.push([service, client]); });
  const handler = handlerOf(container);
  assert.equal(handler.path, '/services/sterling-probe');
  const first = tab();
  const second = tab();
  const a = handler.targetFactory(first);
  const b = handler.targetFactory(second);
  assert.equal(a, b, 'one service per backend');
  assert.deepEqual(seen.map(([service, client]) => [service === a, client]), [[true, first], [true, second]]);

  const plain = new Container();
  bindBackendService(plain.bind.bind(plain), id, '/services/sterling-plain', () => ({ name: 'plain' }));
  assert.deepEqual(handlerOf(plain).targetFactory(undefined as never), { name: 'plain' });
});

test('two connected tabs both get every row and join request, and a new tab gets the current rows at once', () => {
  const engine = fakeEngine();
  const service = new StaffStatusService(() => engine);
  service.attach(engine);
  const first = tab();
  const second = tab();
  service.addClient(first);
  service.addClient(second);
  assert.deepEqual(first.rows, [ROW], 'the current row on connecting');
  const synced = { ...ROW, state: 'catching-up', sentence: 'Catching up with your organization\'s server.' };
  engine.emit(synced);
  engine.join({ project: ROW.project, invite: 'inv-blake' });
  for (const client of [first, second]) {
    assert.deepEqual(client.rows.at(-1), synced);
    assert.deepEqual(client.joins, [{ project: ROW.project, invite: 'inv-blake' }]);
  }
});

test('a closed tab is dropped and gets nothing more; rows and Sync Now answer as plain data', async () => {
  const engine = fakeEngine();
  const container = new Container();
  bindStaffStatusService(container.bind.bind(container), () => () => engine);
  const handler = handlerOf(container);
  assert.equal(handler.path, STAFF_STATUS_PATH);
  const first = tab();
  const second = tab();
  const service = handler.targetFactory(first) as StaffStatusService;
  handler.targetFactory(second);
  assert.equal(service, container.get(StaffStatusServer));
  service.attach(engine);
  assert.equal(service.clientCount, 2);
  first.close();
  assert.equal(service.clientCount, 1);
  engine.emit({ ...ROW, state: 'offline' });
  assert.equal(first.rows.length, 1, 'only the row given on connecting');
  assert.equal(second.rows.at(-1)?.state, 'offline');
  assert.deepEqual(await service.rows(), [ROW]);
  assert.deepEqual(await service.syncNow(ROW.project), { kind: 'ok', value: ROW });
  assert.deepEqual(await service.syncNow('b'.repeat(32)), { kind: 'refused', reason: STAFF_STATUS_TEXT.notOpen });
  // Before the engine has started (a hosted session not yet active) there are no rows.
  const early = new StaffStatusService(() => undefined);
  assert.deepEqual(await early.rows(), []);
});
