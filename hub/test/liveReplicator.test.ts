import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { entryHash } from '@ext/domain/replica/entry';
import { RESTORE_MARKER } from '../src/restore';
import { liveClient, reaches } from './helpers/liveClient';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';

// Phase 33, plan 09 (D-06, D-09, D-12 to D-14, D-32; DESIGN 10.4): the live replicator against the real in-process hub on loopback, Yjs-free, on
// Node 26. A heads frame wakes the other computer; restore mode, a required feature this build lacks and a device the roster no longer admits each
// reach their state with its reason. All names and data are fictional.

interface Team { world: HubWorld; member: WorldDevice }

async function enrolled(hub: Hub, prepare: (world: HubWorld, member: WorldDevice) => void = () => undefined): Promise<Team> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  world.admitMember(member);
  prepare(world, member);
  const answer = await hub.enrolProject(world);
  assert.equal(answer?.status, 201, answer?.text ?? 'no answer');
  return { world, member };
}

test('tracer: A appends one change; the hub\'s heads frame wakes B, and B holds it in under one second over loopback', () =>
  withHub({}, async (hub) => {
    const { world, member } = await enrolled(hub);
    const a = liveClient(hub, world, world.lead);
    const b = liveClient(hub, world, member);
    try {
      await a.replicator.start();
      await b.replicator.start();
      await reaches(a.replicator, (status) => status.state === 'live', 'A live');
      await reaches(b.replicator, (status) => status.state === 'live', 'B live');
      // Let both streams open and their first exchange settle.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const written = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional live note' } });
      assert.ok(a.replica.add(written.entry));
      const started = Date.now();
      a.replicator.localAppended();
      const hash = entryHash(written.entry.header);
      while (!b.replica.has(hash)) {
        if (Date.now() - started > 5000) assert.fail(`B never held the change; B's log: ${b.log.join(' | ')}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const elapsed = Date.now() - started;
      console.log(`loopback latency A append to B holding it: ${elapsed} ms`);
      assert.ok(elapsed < 1000, `took ${elapsed} ms`);
      assert.ok(b.log.includes('wake heads'), b.log.join('\n'));
    } finally {
      await a.replicator.stop();
      await b.replicator.stop();
    }
  }));

test('restoring: a hub started in restore mode answers a new change restoring, so the replicator shows offline with reason restoring, and live once the mode ends', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-live-restore-'));
  await writeFile(path.join(dir, RESTORE_MARKER), '', { mode: 0o600 });
  await withHub({ dir }, async (hub) => {
    assert.equal(hub.restore?.active(), true);
    const { world } = await enrolled(hub);
    const a = liveClient(hub, world, world.lead);
    try {
      const written = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional change made during the restore' } });
      assert.ok(a.replica.add(written.entry));
      await a.replicator.start();
      const offline = await reaches(a.replicator, (status) => status.state === 'offline', 'offline');
      assert.equal(offline.reason, 'restoring');
      hub.restore?.end('marker-removed');
      a.replicator.syncNow();
      await reaches(a.replicator, (status) => status.state === 'live', 'live after the mode ended');
      assert.ok(hub.store.entryByHash(world.project, entryHash(written.entry.header)), 'the change made during the restore reached the hub');
    } finally {
      await a.replicator.stop();
    }
  });
});

test('needs-update: a project that requires positions@1, which neither this hub nor this build folds, puts the replicator in needs-update and it stays there', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub, (w) => { w.rosterEntry(w.lead, 'roster.require', { features: ['positions@1', 'require@1'] }); });
    const a = liveClient(hub, world, world.lead);
    try {
      await a.replicator.start();
      const status = await reaches(a.replicator, (item) => item.state === 'needs-update', 'needs-update');
      assert.equal(status.reason, 'needs-update');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(a.replicator.status.state, 'needs-update', 'nothing leaves needs-update but an update');
    } finally {
      await a.replicator.stop();
    }
  }));

test('refused: a device the roster no longer admits is refused with the session\'s reason', () =>
  withHub({}, async (hub) => {
    const { world, member } = await enrolled(hub, (w, m) => { w.rosterEntry(w.lead, 'device.revoke', { member: m.member, writer: m.writer }); });
    const b = liveClient(hub, world, member);
    try {
      await b.replicator.start();
      const status = await reaches(b.replicator, (item) => item.state === 'refused', 'refused');
      assert.equal(status.reason, 'not-admitted');
    } finally {
      await b.replicator.stop();
    }
  }));
