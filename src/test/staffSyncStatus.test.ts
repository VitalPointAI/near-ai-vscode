import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { StaffSyncStatus, syncStatusFor } from '../services/staffSyncStatus';
import type { LiveStatus } from '../staff/replica/liveReplicator';

const live = (): LiveStatus => ({
  state: 'live', since: 100, findings: ['finding-one'], pulled: 3, pushed: 2, lastSyncedAt: 200
});

test('normalized workspace roots share the same status store while other projects stay isolated', () => {
  const root = path.resolve('fixtures', 'staff-status-project');
  const shared = syncStatusFor(root);
  assert.equal(syncStatusFor(root + path.sep + '.'), shared);
  const separate = syncStatusFor(path.join(root, 'other'));
  assert.notEqual(separate, shared);
  assert.equal(shared.status, undefined);
  shared.setStatus(live());
  assert.equal(separate.status, undefined);
  shared.setStatus(undefined);
});

test('each changed connection status is published once, including a clear when the service stops', () => {
  const store = new StaffSyncStatus();
  const seen: Array<LiveStatus | undefined> = [];
  const listener = store.onChange(() => seen.push(store.status));
  const first = live();
  const incremental = { ...first, pulled: first.pulled + 1, findings: ['finding-two'] };
  const offline: LiveStatus = { ...incremental, state: 'offline', since: 300, reason: 'unreachable', retryAt: 400 };

  store.setStatus(first);
  store.setStatus(live());
  store.setStatus(incremental);
  store.setStatus(offline);
  store.setStatus({ ...offline, findings: [...offline.findings] });
  store.setStatus(undefined);
  store.setStatus(undefined);
  assert.deepEqual(seen, [first, incremental, offline, undefined]);
  listener.dispose();
  store.setStatus(first);
  assert.equal(seen.length, 4);
});

test('published status snapshots are isolated from mutations by producers and consumers', () => {
  const store = new StaffSyncStatus();
  const status = live();
  store.setStatus(status);
  status.findings.push('producer mutation');
  status.pulled = 100;
  store.status?.findings.push('consumer mutation');
  assert.deepEqual(store.status, live());
});
