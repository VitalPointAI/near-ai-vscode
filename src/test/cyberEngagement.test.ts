// The engagement store persists to the globalStorage layout (D-06) and is append-only once a run
// starts (CYBER-02): a frozen engagement's target, scope, modes, and acceptance cannot change, every
// run names its engagement, and a reload reads the same records back. Real temp directories, no mocks.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Engagement, EngagementRun } from '../domain/cyber';
import { CyberEngagementStore, EngagementFrozenError, EngagementNotFoundError } from '../services/cyberEngagementStore';

const acceptance = {
  acceptor: 'Example Organisation Ltd',
  osUser: 'test-user',
  machine: 'test-machine',
  extensionVersion: '0.4.10',
  textVersion: 'v1',
  region: 'us',
  acceptedAt: '2026-10-31T12:00:00Z'
};

function engagement(id = 'eng-00000000-0000-4000-8000-000000000001', workspace = '/workspace/example'): Engagement {
  return {
    id,
    workspace,
    target: { kind: 'url', value: 'https://example.test/' },
    resolvedScope: { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] },
    region: 'us',
    authorizationStatement: 'The acceptor owns the target and authorises this test.',
    allowedModes: ['passive', 'active'],
    exclusions: ['/health'],
    sandbox: { tier: 'tempFolder', reason: 'docker and podman are not installed' },
    acceptedDisclaimer: acceptance,
    createdAt: acceptance.acceptedAt,
    frozen: false
  };
}

function run(engagementId: string, id = 'run-0001'): EngagementRun {
  return { id, engagementId, startedAt: '2026-10-31T12:01:00Z', depth: 'standard', model: 'z-ai/glm-5.3', ledgerPath: path.join('engagements', engagementId, 'runs', id, 'ledger.jsonl'), outcome: 'running' };
}

/** One temp root per workspace key, so a second store on the same key is the reload case. */
async function workspaceRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'near-ai-cyber-store-'));
}

function storeOn(root: string, key: string): CyberEngagementStore {
  return new CyberEngagementStore(path.join(root, 'cyber', key));
}

test('an engagement is created, read back, and listed from its workspace directory', async () => {
  const store = storeOn(await workspaceRoot(), 'workspace-a');
  const created = await store.create(engagement());
  assert.equal(created.frozen, false);
  assert.equal(created.target.kind, 'url');

  const read = await store.get(created.id);
  assert.ok(read);
  assert.deepEqual(read.target, created.target);
  assert.deepEqual(read.allowedModes, ['passive', 'active']);
  assert.deepEqual(read.acceptedDisclaimer, { ...acceptance });

  assert.deepEqual((await store.list()).map((entry) => entry.id), [created.id]);
  assert.equal(await store.get('eng-missing'), undefined);
});

test('the first run freezes the engagement, every run names its engagement, and a reload reads both back', async () => {
  const root = await workspaceRoot();
  const store = storeOn(root, 'workspace-a');
  const created = await store.create(engagement());
  const record = await store.appendRun(created.id, run(created.id));
  assert.equal(record.engagementId, created.id);
  assert.equal(record.ledgerPath, path.join('engagements', created.id, 'runs', 'run-0001', 'ledger.jsonl'));

  const frozen = await store.get(created.id);
  assert.equal(frozen?.frozen, true);

  // A second store instance on the same directory is what the extension host does on reload.
  const reloaded = storeOn(root, 'workspace-a');
  assert.equal((await reloaded.get(created.id))?.frozen, true);
  assert.deepEqual((await reloaded.runs(created.id)).map((entry) => entry.engagementId), [created.id]);

  // A second, distinct run appends; reusing an id is refused.
  assert.equal((await reloaded.appendRun(created.id, run(created.id, 'run-0002'))).id, 'run-0002');
  await assert.rejects(() => reloaded.appendRun(created.id, run(created.id)), /already exists/);
});

test('a frozen engagement refuses a change to its frozen fields with a typed error', async () => {
  const store = storeOn(await workspaceRoot(), 'workspace-a');
  const created = await store.create(engagement());
  await store.appendRun(created.id, run(created.id));

  await assert.rejects(
    () => store.assertMutable(created.id, { target: { kind: 'cidr', value: '10.0.0.0/30' } }),
    (error: Error) => error instanceof EngagementFrozenError && error.field === 'target'
  );
  await assert.rejects(
    () => store.assertMutable(created.id, { allowedModes: ['passive'] }),
    (error: Error) => error instanceof EngagementFrozenError && error.field === 'allowedModes'
  );
  await assert.rejects(
    () => store.assertMutable(created.id, { acceptedDisclaimer: { ...acceptance, acceptor: 'Someone Else' } }),
    (error: Error) => error instanceof EngagementFrozenError && error.field === 'acceptedDisclaimer'
  );
  // Unchanged fields pass, and an engagement with no run yet may still change.
  await store.assertMutable(created.id, { target: created.target });

  const fresh = storeOn(await workspaceRoot(), 'workspace-b');
  const second = await fresh.create(engagement('eng-00000000-0000-4000-8000-000000000002', '/workspace/other'));
  await fresh.assertMutable(second.id, { target: { kind: 'workspace', value: '/workspace/other' } });

  await assert.rejects(
    () => store.appendRun('eng-00000000-0000-4000-8000-0000000000ff', run('eng-00000000-0000-4000-8000-0000000000ff')),
    (error: Error) => error instanceof EngagementNotFoundError
  );
});

test('a store for one workspace key does not see another workspace key\'s engagements', async () => {
  const root = await workspaceRoot();
  const first = storeOn(root, 'workspace-a');
  const second = storeOn(root, 'workspace-b');
  const created = await first.create(engagement('eng-00000000-0000-4000-8000-000000000003', '/workspace/example'));
  assert.deepEqual((await second.list()).map((entry) => entry.id), []);
  assert.equal(await second.get(created.id), undefined);
});
