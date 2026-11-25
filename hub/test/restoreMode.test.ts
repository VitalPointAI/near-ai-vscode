import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import { APPEND_REFUSALS } from '../src/append/checks';
import { LIMITS } from '../src/limits';
import { RESTORE_LOG_EVENTS, RESTORE_MARKER } from '../src/restore';
import { keptHub } from './helpers/faultProxy';
import type { HubInstance, KeptHub } from './helpers/faultProxy';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// Phase 33, plan 07 (D-32, D-45; F9, A6): restore mode. A hub restored from a backup by the procedure, with the marker file in its state folder,
// takes back only what a kept or handed-back checkpoint covers until every admitted person device has asked for a checkpoint since the start, then
// leaves the mode by itself and removes the marker. All names and data are fictional.

const ASK_GAP_MS = 11_000;

interface Scene {
  kept: KeptHub;
  dir: string;
  world: HubWorld;
  member: WorldDevice;
  /** The checkpoint the lead held from after the backup, which the restored hub lost. */
  lost: SignedCheckpoint;
  /** The lead's entry after the backup, which the restored hub lost. */
  after: Written;
  live: HubInstance;
}

const note = (world: HubWorld, device: WorldDevice, text: string): Written => world.write(device, { kind: 'note.add', data: { text } });

async function append(hub: Hub, session: OpenedSession, world: HubWorld, entries: readonly Written[]) {
  return session.connection.post(`/v1/projects/${world.project}/append`, { entries: entries.map((item) => item.entry) }, session.token);
}

async function ask(hub: Hub, session: OpenedSession, world: HubWorld, known: readonly unknown[] = []): Promise<SignedCheckpoint | undefined> {
  const answer = await session.connection.post(`/v1/projects/${world.project}/checkpoint`, { known }, session.token);
  assert.equal(answer.status, 200, answer.text);
  await hub.checkpoints?.settled();
  const latest = hub.store.latestCheckpoint(world.project);
  return latest === undefined ? undefined : (JSON.parse(latest.body) as SignedCheckpoint);
}

/** Before the backup: one entry and a checkpoint over it. After it: one more entry and a checkpoint the lead keeps. Then the backup is restored. */
async function restoredScene(marker: boolean): Promise<Scene> {
  const kept = keptHub();
  const dir = kept.folder('state');
  let live = await kept.instance(dir);
  const world = createHubWorld();
  world.admitHub(live.hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  world.admitMember(member);
  assert.equal((await live.hub.enrolProject(world))?.status, 201);
  let lead = await live.hub.openSession(world.lead, world.project);
  assert.equal((await append(live.hub, lead, world, [note(world, world.lead, 'Before the backup')])).status, 200);
  assert.ok(await ask(live.hub, lead, world), 'the first checkpoint was not signed');
  await live.hub.close();
  const backup = kept.copy(dir, 'backup');

  live = await kept.instance(dir);
  lead = await live.hub.openSession(world.lead, world.project);
  const after = note(world, world.lead, 'After the backup');
  assert.equal((await append(live.hub, lead, world, [after])).status, 200);
  await live.advance(ASK_GAP_MS);
  const lost = await ask(live.hub, lead, world);
  assert.ok(lost, 'the second checkpoint was not signed');
  await live.hub.close();

  kept.restore(backup, dir);
  if (marker) writeFileSync(path.join(dir, RESTORE_MARKER), '', { mode: 0o600 });
  live = await kept.instance(dir);
  return { kept, dir, world, member, lost, after, live };
}

async function withScene(marker: boolean, body: (scene: Scene) => Promise<void>): Promise<void> {
  const scene = await restoredScene(marker);
  try {
    await body(scene);
  } finally {
    await scene.live.hub.close();
    scene.kept.cleanup();
  }
}

const events = (hub: Hub): string[] => hub.restoreLogs.map((line) => line.event);

test('tracer: a hub started with the marker is in restore mode; an append beyond every kept checkpoint is 503 restoring with Retry-After, and once the lead hands back its checkpoint the lost entry is taken back', () =>
  withScene(true, async ({ live, world, lost, after }) => {
    assert.deepEqual(events(live.hub), ['hub.restore-started']);
    const lead = await live.hub.openSession(world.lead, world.project);
    const refused = await append(live.hub, lead, world, [after]);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers['retry-after'], String(LIMITS.restoreRetrySeconds));
    assert.deepEqual(refused.json(), { error: 'restoring', message: APPEND_REFUSALS.restoring, retryAfterSeconds: LIMITS.restoreRetrySeconds });
    await ask(live.hub, lead, world, [lost]);
    const taken = await append(live.hub, lead, world, [after]);
    assert.equal(taken.status, 200, taken.text);
    assert.deepEqual(taken.json<{ accepted: string[] }>().accepted, [after.hash]);
  }));

test('new work waits while restore mode lasts; once every person device has asked, the mode ends, the hub removes the marker and logs hub.restore-ended', () =>
  withScene(true, async ({ live, dir, world, member, lost, after }) => {
    const lead = await live.hub.openSession(world.lead, world.project);
    await ask(live.hub, lead, world, [lost]);
    assert.equal((await append(live.hub, lead, world, [after])).status, 200);
    const fresh = note(world, world.lead, 'New work after the restore');
    assert.equal((await append(live.hub, lead, world, [fresh])).status, 503, 'the member has not handed back yet');
    assert.equal(live.hub.restore?.active(), true);
    const b = await live.hub.openSession(member, world.project);
    await live.advance(ASK_GAP_MS);
    await ask(live.hub, b, world);
    assert.equal(live.hub.restore?.active(), false);
    assert.equal(existsSync(path.join(dir, RESTORE_MARKER)), false, 'the hub removed the marker');
    assert.deepEqual(live.hub.restoreLogs.map((line) => [line.event, line.fields.reason]), [['hub.restore-started', undefined], ['hub.restore-ended', 'members-synced']]);
    assert.equal((await append(live.hub, lead, world, [fresh])).status, 200);
  }));

test('the operator removing the marker ends restore mode at the next look, at most LIMITS.restoreRetrySeconds later', () =>
  withScene(true, async ({ live, dir, world, after }) => {
    const lead = await live.hub.openSession(world.lead, world.project);
    assert.equal((await append(live.hub, lead, world, [after])).status, 503);
    rmSync(path.join(dir, RESTORE_MARKER));
    assert.equal((await append(live.hub, lead, world, [after])).status, 503, 'not looked at again yet');
    await live.advance(LIMITS.restoreRetrySeconds * 1000);
    assert.equal((await append(live.hub, lead, world, [after])).status, 200);
    assert.deepEqual(live.hub.restoreLogs.map((line) => [line.event, line.fields.reason]), [['hub.restore-started', undefined], ['hub.restore-ended', 'marker-removed']]);
  }));

test('an entry the restored hub still holds is taken in restore mode as held', () =>
  withScene(true, async ({ live, world }) => {
    const lead = await live.hub.openSession(world.lead, world.project);
    const stored = live.hub.store.entriesFrom(world.project, world.project, world.lead.writer, 0, { limit: 1000, maxBytes: 64 * 1024 * 1024 }).entries;
    const again = { entry: { header: JSON.parse(stored[stored.length - 1]?.header as string) as unknown, body: stored[stored.length - 1]?.body as string } } as unknown as Written;
    const answer = await append(live.hub, lead, world, [again]);
    assert.equal(answer.status, 200, answer.text);
  }));

test('without the marker a restored hub is not in restore mode: it logs nothing and takes new work at once', () =>
  withScene(false, async ({ live, world, after }) => {
    assert.deepEqual(live.hub.restoreLogs, []);
    assert.equal(live.hub.restore?.active(), false);
    const lead = await live.hub.openSession(world.lead, world.project);
    assert.equal((await append(live.hub, lead, world, [after])).status, 200);
  }));

test('restore mode\'s settings and log lines: the marker name, a 30 second retry, two events, and fields that name no secret, token or pin', () =>
  withScene(true, async ({ live, dir, world, member }) => {
    assert.equal(RESTORE_MARKER, 'restore-mode');
    assert.equal(LIMITS.restoreRetrySeconds, 30);
    assert.deepEqual([...RESTORE_LOG_EVENTS], ['hub.restore-started', 'hub.restore-ended']);
    for (const device of [world.lead, member]) {
      const session = await live.hub.openSession(device, world.project);
      await live.advance(ASK_GAP_MS);
      await ask(live.hub, session, world);
    }
    assert.equal(existsSync(path.join(dir, RESTORE_MARKER)), false);
    const text = JSON.stringify(live.hub.restoreLogs);
    for (const secret of [live.hub.identity.certPin, live.hub.keys.signing, live.hub.keys.encryption]) assert.equal(text.includes(secret), false);
    for (const line of live.hub.restoreLogs) assert.ok(Object.keys(line.fields).every((key) => key === 'reason' || key === 'retryAfterSeconds'), JSON.stringify(line.fields));
  }));
