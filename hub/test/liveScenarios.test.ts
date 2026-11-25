import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { entryHash } from '@ext/domain/replica/entry';
import { buildHubJoin, buildInvite, buildJoinRequest, hubJoinCheckKey, hubJoinMac, joinRequestHash, newJoinSecret } from '@ext/domain/replica/invite';
import { openPresence, sealPresence } from '@ext/domain/replica/presence';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { LEAD_PROBE_MS } from '@ext/staff/replica/liveReplicator';
import type { LiveReplicatorOptions, LiveTimers } from '@ext/staff/replica/liveReplicator';
import { RESTORE_MARKER } from '../src/restore';
import { startHub, withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { liveClient, reaches } from './helpers/liveClient';
import type { LiveClient } from './helpers/liveClient';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 33, plan 14 (D-12, D-21, D-32, D-42; criterion 3): the live scenarios on the hub's side, with two and three people's live replicators over
// memory replicas against the real hub in process on loopback, Yjs-free and editor-free. Live delivery, presence to a cell's access list only, a
// join request to the lead's devices only, restore mode, and a server put back to an older copy, which both computers recover from after the
// lead's re-admission. Waits are on status and held entries, never a fixed sleep. All names and data are fictional.

const DAY_MS = 24 * 60 * 60 * 1000;

interface Team { world: HubWorld; b: WorldDevice; c: WorldDevice }

/** The project with the lead and two members, B and C, enrolled on the hub. */
async function team(hub: Hub, prepare: (world: HubWorld, b: WorldDevice, c: WorldDevice) => void = () => undefined): Promise<Team> {
  const world = createHubWorld({ projectLabel: 'live-scenarios' });
  world.admitHub(hub.identity);
  const b = world.device('MEMBER-B', 'mbr-b');
  const c = world.device('MEMBER-C', 'mbr-c');
  world.admitMember(b);
  world.admitMember(c);
  prepare(world, b, c);
  const answer = await hub.enrolProject(world);
  assert.equal(answer?.status, 201, answer?.text ?? 'no answer');
  return { world, b, c };
}

/** Starts every client and waits until each is live and through its first exchange. */
async function allLive(clients: readonly LiveClient[]): Promise<void> {
  for (const client of clients) {
    await client.replicator.start();
    await reaches(client.replicator, (status) => status.state === 'live', `${client.device.label} live`);
  }
  for (const client of clients) await until(() => client.log.includes('exchange stream-open done synced'), `${client.device.label}'s first exchange`);
}

async function stopAll(clients: readonly LiveClient[]): Promise<void> {
  for (const client of clients) await client.replicator.stop();
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A fictional note by a device, kept on its own computer and told to its replicator. */
function note(world: HubWorld, client: LiveClient, text: string): string {
  const written = world.write(client.device, { kind: 'note.add', data: { text } });
  assert.ok(client.replica.add(written.entry));
  client.replicator.localAppended();
  return entryHash(written.entry.header);
}

test('live: one change reaches the two other computers in under one second each over loopback, woken by the heads frame', () =>
  withHub({}, async (hub) => {
    const { world, b, c } = await team(hub);
    const clients = [liveClient(hub, world, world.lead), liveClient(hub, world, b), liveClient(hub, world, c)];
    try {
      await allLive(clients);
      const [a, ...others] = clients;
      const hash = note(world, a, 'Fictional live note for two readers');
      const started = Date.now();
      const took: number[] = [];
      for (const other of others) {
        await until(() => other.replica.has(hash), `${other.device.label} holds the change`, 5000);
        took.push(Date.now() - started);
      }
      console.log(`loopback latency to B and C: ${took.join(' ms, ')} ms`);
      for (const ms of took) assert.ok(ms < 1000, `took ${ms} ms`);
      for (const other of others) assert.ok(other.log.includes('wake heads'), other.log.join('\n'));
    } finally {
      await stopAll(clients);
    }
  }));

test('presence: a sealed heartbeat and cursor in a label cell reach only the other devices on its access list, and open only with that cell\'s key', () =>
  withHub({}, async (hub) => {
    let cell = '';
    const { world, b, c } = await team(hub, (w, member) => { cell = w.labelCell('operations', [w.lead, member]).cell; });
    const frames = new Map<string, Array<Record<string, unknown>>>();
    const watch = (device: WorldDevice): Partial<LiveReplicatorOptions> => {
      frames.set(device.writer, []);
      return { onPresence: (frame) => frames.get(device.writer)?.push(frame) };
    };
    const clients = [liveClient(hub, world, world.lead, watch(world.lead)), liveClient(hub, world, b, watch(b)), liveClient(hub, world, c, watch(c))];
    try {
      await allLive(clients);
      const [a] = clients;
      const key = world.keyOf(cell, 1);
      const place = { cell, epoch: 1, writer: world.lead.writer };
      const here = sealPresence(key, place, { v: 1, kind: 'here', member: world.lead.member, seq: 1 });
      const cursor = sealPresence(key, place, { v: 1, kind: 'cursor', member: world.lead.member, product: 'route-plan', anchor: 'AAEC', head: 'd'.repeat(64), seq: 2 });
      await a.replicator.postPresence(cell, here);
      await until(() => (frames.get(b.writer) ?? []).length > 0, 'B hears the heartbeat');
      await a.replicator.postPresence(cell, cursor);
      await until(() => (frames.get(b.writer) ?? []).some((frame) => JSON.stringify(frame).includes(cursor)), 'B hears the cursor');
      // A marker after both: C is connected and hears the next heads frame, but never a presence frame of the cell it is off.
      const marker = note(world, a, 'Fictional marker after the presence');
      await until(() => clients[2].replica.has(marker), 'C holds the marker');
      assert.deepEqual(frames.get(c.writer), [], 'C is off the cell');
      assert.deepEqual(frames.get(world.lead.writer), [], 'the poster hears nothing of its own');
      const sealed = (frames.get(b.writer) ?? []).flatMap((frame) => (frame.devices as Array<{ writer: string; sealed: string }>));
      assert.ok(sealed.every((item) => item.writer === world.lead.writer));
      const opened = sealed.map((item) => openPresence(world.ringFor(b), { cell, writer: item.writer }, item.sealed));
      assert.deepEqual(opened.map((message) => message?.kind).sort(), ['cursor', 'here']);
      // Under any other key (C's ring, the base cell's) or as another device, it does not open.
      for (const item of sealed) {
        assert.equal(openPresence(world.ringFor(c), { cell, writer: item.writer }, item.sealed), undefined);
        assert.equal(openPresence(() => world.keyOf(world.project, 1), { cell, writer: item.writer }, item.sealed), undefined);
        assert.equal(openPresence(world.ringFor(b), { cell, writer: b.writer }, item.sealed), undefined);
      }
    } finally {
      await stopAll(clients);
    }
  }));

test('join: a join request reaches the lead\'s device as a join-request frame, and a member\'s device hears nothing of it', () =>
  withHub({}, async (hub) => {
    const { world, b } = await team(hub);
    const heard = new Map<string, Array<string | undefined>>([[world.lead.writer, []], [b.writer, []]]);
    // Both say yes to isLeadDevice: what keeps the member out is the hub's audience (D-12), not the client's own check.
    const lead = (device: WorldDevice): Partial<LiveReplicatorOptions> => ({ isLeadDevice: () => true, onJoinRequest: (invite) => heard.get(device.writer)?.push(invite) });
    const clients = [liveClient(hub, world, world.lead, lead(world.lead)), liveClient(hub, world, b, lead(b))];
    try {
      await allLive(clients);
      const newcomer = world.device('NEWCOMER', 'mbr-newcomer');
      const transport = (device: WorldDevice): HubTransport => new HubTransport({
        address: `127.0.0.1:${hub.port}`, project: world.project, hub: hub.identity.writer, trust: { pin: hub.identity.certPin }, signer: device.signer, servername: 'localhost', now: () => new Date(hub.now())
      });
      const secret = newJoinSecret();
      const invite = 'inv-live-1';
      const signed = buildInvite(world.lead.signer, {
        genesisHash: world.genesisHash, project: world.project, name: 'Exercise Live', lead: { member: world.lead.member, x25519: world.lead.x25519, publicKey: world.lead.publicKey },
        invite, secret, expiresAt: new Date(hub.now() + 7 * DAY_MS).toISOString(), now: new Date(hub.now()), hub: { address: HUB_ADDRESS, certPin: hub.identity.certPin, writer: hub.identity.writer }
      });
      const leadTransport = transport(world.lead);
      const joiner = transport(newcomer);
      try {
        await leadTransport.registerInvite({ invite, expiresAt: signed.payload.expiresAt, checkKey: hubJoinCheckKey(secret, invite) });
        const request = buildJoinRequest(newcomer.signer, signed.payload, { name: 'Person Newcomer', x25519: newcomer.x25519, now: new Date(hub.now()) });
        const fields = { hub: hub.identity.writer, project: world.project, invite, request: joinRequestHash(request) };
        const join = buildHubJoin(newcomer.signer, { hub: fields.hub, project: fields.project, request, hubMac: hubJoinMac(hubJoinCheckKey(secret, invite), fields), now: new Date(hub.now()) });
        assert.equal((await joiner.postJoin({ join, request })).held, false);
      } finally {
        leadTransport.close();
        joiner.close();
      }
      await until(() => (heard.get(world.lead.writer) ?? []).length > 0, 'the lead hears the request');
      assert.deepEqual(heard.get(world.lead.writer), [invite]);
      const marker = note(world, clients[0], 'Fictional marker after the join request');
      await until(() => clients[1].replica.has(marker), 'B holds the marker');
      assert.deepEqual(heard.get(b.writer), [], 'the member hears nothing of the request');
    } finally {
      await stopAll(clients);
    }
  }));

test('restoring: while the hub is in restore mode both computers show offline with reason restoring and keep their changes; when it ends both are live and the change crosses', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-live-scenario-restore-'));
  writeFileSync(path.join(dir, RESTORE_MARKER), '', { mode: 0o600 });
  try {
    await withHub({ dir }, async (hub) => {
      assert.equal(hub.restore?.active(), true);
      const { world, b } = await team(hub);
      const clients = [liveClient(hub, world, world.lead), liveClient(hub, world, b)];
      try {
        const [a, other] = clients;
        const hash = note(world, a, 'Fictional change made during the restore');
        const theirs = note(world, other, 'Fictional change of B made during the restore');
        for (const client of clients) await client.replicator.start();
        for (const client of clients) {
          const status = await reaches(client.replicator, (item) => item.state === 'offline', `${client.device.label} offline`);
          assert.equal(status.reason, 'restoring');
        }
        assert.ok(a.replica.has(hash) && other.replica.has(theirs), 'each change is kept on its computer');
        hub.restore?.end('marker-removed');
        for (const client of clients) client.replicator.syncNow();
        for (const client of clients) await reaches(client.replicator, (item) => item.state === 'live', `${client.device.label} live after the mode ended`);
        for (const client of clients) client.replicator.syncNow();
        await until(() => other.replica.has(hash) && a.replica.has(theirs), 'each holds the other\'s change made during the restore');
      } finally {
        await stopAll(clients);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restored copy: a server put back to an older copy shows both computers attention rolled-back; after the lead\'s re-admission, at the next look, both are live with each other\'s changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-live-scenario-fork-'));
  const dir = path.join(root, 'state');
  const backup = path.join(root, 'backup');
  mkdirSync(dir, { mode: 0o700 });
  const tls = makeTlsFixture();
  let hub = await startHub({ dir, tls });
  const keys = hub.keys;
  let clock = hub.now();
  const current = { port: hub.port };
  const clients: LiveClient[] = [];
  try {
    const { world, b } = await team(hub);
    // The clients follow the hub across restarts: the address is read at each connection and the clock is the test's.
    // The look again of attention (LEAD_PROBE_MS, a minute) runs after half a second here, so the lead's action reaches both within the test.
    const soon: LiveTimers = { setTimeout: (run, ms) => setTimeout(run, ms >= LEAD_PROBE_MS ? 500 : ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    const follow: Partial<LiveReplicatorOptions> = { address: () => Promise.resolve(`127.0.0.1:${current.port}`), now: () => new Date(clock), giveUpMs: 3000, timers: soon };
    clients.push(liveClient(hub, world, world.lead, follow), liveClient(hub, world, b, follow));
    const [a, other] = clients;
    await allLive(clients);

    // Stops the hub and starts it again with the same keys and certificate, from an older copy of its state folder when one is given.
    const restart = async (from?: string): Promise<void> => {
      clock = hub.now();
      await hub.close();
      if (from !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        cpSync(from, dir, { recursive: true });
      }
      hub = await startHub({ dir, tls, keys, now: clock + 11_000 });
      clock = hub.now();
      current.port = hub.port;
    };
    const backLive = async (): Promise<void> => {
      for (const client of clients) client.replicator.syncNow();
      for (const client of clients) await reaches(client.replicator, (item) => item.state === 'live', `${client.device.label} live again`, 15_000);
    };
    // The operator's copy of the state folder, taken while the hub is stopped.
    await hub.close();
    cpSync(dir, backup, { recursive: true });
    hub = await startHub({ dir, tls, keys, now: clock + 11_000 });
    clock = hub.now();
    current.port = hub.port;
    await backLive();

    // A change both computers see, and a checkpoint over it.
    const kept = async (client: LiveClient): Promise<number> => (await client.replica.checkpoints()).length;
    const before = [await kept(a), await kept(other)];
    const first = note(world, a, 'Fictional first report, lost in the restore');
    await until(() => other.replica.has(first), 'B holds the first report');
    // The hub signs on an ask 10 s (its clock) after its last ask-signed checkpoint; each exchange asks.
    const deadline = Date.now() + 10_000;
    while ((await kept(a)) <= before[0]! || (await kept(other)) <= before[1]!) {
      if (Date.now() > deadline) assert.fail(`no checkpoint over the first report reached both computers: ${before.join(',')} then ${await kept(a)},${await kept(other)}`);
      hub.advance(11_000);
      clock = hub.now();
      for (const client of clients) client.replicator.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // The older copy goes back, without the first report; B writes a different change there.
    const seen = clients.map((client) => {
      const states: string[] = [];
      client.replicator.onStatus((status) => { if (status.state === 'attention') states.push(`${status.reason ?? ''}`); });
      return states;
    });
    await restart(backup);
    const second = note(world, other, 'Fictional second report on the older copy');
    for (const client of clients) client.replicator.syncNow();
    await until(() => seen.every((states) => states.length > 0), 'both computers show attention', 15_000);
    for (const [index, states] of seen.entries()) assert.equal(states[0], 'rolled-back', `${clients[index]?.device.label}: ${states.join(', ')}`);

    // The lead compares the pin and re-admits the hub (the action the Staff Room offers the lead for rolled-back); every computer looks again.
    const readmit = world.rosterEntry(world.lead, 'hub.readmit', { hub: hub.identity.hub, certPin: hub.identity.certPin });
    assert.ok(a.replica.add(readmit.entry));
    for (const client of clients) client.replicator.syncNow();
    for (const client of clients) await reaches(client.replicator, (item) => item.state === 'live', `${client.device.label} live after the re-admission`, 15_000);
    await until(() => other.replica.has(readmit.hash), 'B holds the re-admission');
    await until(() => a.replica.has(second) && other.replica.has(first), 'each holds the other\'s report again');
  } finally {
    await stopAll(clients);
    await hub.close();
    tls.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
