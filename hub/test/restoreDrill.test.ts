import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import type { HubMemory, SyncReport } from '@ext/staff/replica/hubSync';
import { checkpointHash, readCheckpoint, recomputeCheckpoint, verifyCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Checkpoint, CheckpointEntry, SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import { entryHash } from '@ext/domain/replica/entry';
import type { HubFindingKind } from '@ext/domain/replica/hubWitness';
import { foldRoster, rosterView } from '@ext/domain/replica/roster';
import type { RosterView } from '@ext/domain/replica/rosterView';
import { verifyEntry } from '@ext/domain/replica/verify';
import { keptHub } from './helpers/faultProxy';
import type { HubInstance, KeptHub } from './helpers/faultProxy';
import type { Hub } from './helpers/hubHarness';
import { NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import type { MemoryReplica } from './helpers/memoryReplica';

// Phase 32, plan 26 (D-30, D-45, D-54, D-63, D-70; DESIGN 10.9): the restore drill. The operator backs up the hub's state folder after a clean stop,
// people go on working, and later the old backup is restored and the hub started on it. The hub is honest; it simply lost what came after the
// backup. Both clients notice the shorter history (rolled-back), hand back the newer checkpoints they hold and push back everything the hub lost.
// For the cells the hub can checkpoint (the base cell and a cell granted to it) the next checkpoint covers every client's heads and nests after the
// earlier ones, so no client sees a forked view; for a cell no checkpoint lists, the clients' high-water marks catch the rollback and their re-push
// makes the hub's heads equal theirs again (D-63). The drill runs in-process hub instances on one state folder and its backup (the kill -9 drill of
// 32-18 covers process death). The backup is a cold copy of the state folder, the procedure the operator section describes. All data is fictional.

const MIN_GAP_MS = 60_000;

interface Client {
  device: WorldDevice;
  replica: MemoryReplica;
  memory: HubMemory;
}

/** A device's computer: a replica of the world as it is now and its own witness memory. */
const clientOf = (world: HubWorld, device: WorldDevice): Client => ({ device, replica: memoryReplica(world, device), memory: hubMemoryOf(new MemorySecrets()) });

async function sync(hub: Hub, world: HubWorld, client: Client): Promise<SyncReport> {
  const transport = new HubTransport({
    address: `127.0.0.1:${hub.port}`,
    project: world.project,
    hub: hub.identity.writer,
    trust: { pin: hub.identity.certPin },
    signer: client.device.signer,
    servername: 'localhost',
    now: () => new Date(hub.now()),
  });
  try {
    return await syncOnce(transport, client.replica, client.memory, { now: () => new Date(hub.now()) });
  } finally {
    transport.close();
    await hub.checkpoints?.settled();
  }
}

/** GET heads as one client's device sees them. */
async function hubHeadsFor(hub: Hub, world: HubWorld, client: Client) {
  const transport = new HubTransport({ address: `127.0.0.1:${hub.port}`, project: world.project, hub: hub.identity.writer, trust: { pin: hub.identity.certPin }, signer: client.device.signer, servername: 'localhost', now: () => new Date(hub.now()) });
  try {
    return await transport.hubHeads();
  } finally {
    transport.close();
  }
}

const kinds = (report: SyncReport): HubFindingKind[] => report.findings.map((item) => item.kind);
const hashesOf = (replica: MemoryReplica): string[] => replica.all().map((entry) => entryHash(entry.header)).sort();
const payloadOf = (signed: SignedCheckpoint): Checkpoint => readCheckpoint(signed.payload) as Checkpoint;
const latestOf = (hub: Hub, project: string): SignedCheckpoint | undefined => {
  const record = hub.store.latestCheckpoint(project);
  return record === undefined ? undefined : (JSON.parse(record.body) as SignedCheckpoint);
};
const heldHashes = (hub: Hub, project: string): string[] => hub.store.checkpoints(project).map((record) => record.hash).sort();

interface Team {
  world: HubWorld;
  member: WorldDevice;
  /** A label cell of the lead and B granted to the hub (hub.grant and its key wrapped to the hub, D-64). */
  granted: string;
  /** A label cell of the lead and B the hub was never granted: no checkpoint lists it (D-63). */
  ungranted: string;
}

/** The world with member B, a granted cell and an ungranted cell, enrolled on the hub. */
async function enrolledTeam(hub: Hub): Promise<Team> {
  const world = createHubWorld({ causalLamport: true });
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  world.admitMember(member);
  const granted = world.labelCell('plans', [world.lead, member]).cell;
  world.rosterEntry(world.lead, 'hub.grant', { hub: hub.identity.hub, cell: granted });
  world.grant(world.lead, { cell: granted, roster: world.head, to: [{ writer: hub.identity.writer, x25519: hub.identity.x25519 }] });
  const ungranted = world.labelCell('ops', [world.lead, member]).cell;
  const answer = await hub.enrolProject(world);
  assert.equal(answer?.status, 201, answer?.text ?? 'no answer');
  return { world, member, granted, ungranted };
}

/** One fictional note by the client's device in each stream given, added to its own replica. */
function writeIn(world: HubWorld, client: Client, streams: readonly string[], label: string): Written[] {
  return streams.map((stream) => {
    const written = world.write(client.device, { kind: 'note.add', data: { text: `Fictional ${label}` }, stream });
    assert.ok(client.replica.add(written.entry), 'the client could not add its own entry');
    return written;
  });
}

/** The roster as a client folds it and every entry opened with every key of the world. */
function opened(world: HubWorld): { view: RosterView; entries: CheckpointEntry[] } {
  const keys = (stream: string, epoch: number): Buffer => world.keyOf(stream, epoch);
  const blobs = (hash: string) => world.blobs.get(hash);
  const now = new Date(NOW_MS);
  const view = rosterView(foldRoster({ entries: world.entries.filter((entry) => entry.header.stream === world.project), anchor: world.anchor(), keys, blobs, grants: world.grants, now }));
  const entries: CheckpointEntry[] = [];
  for (const entry of world.entries) {
    const outcome = verifyEntry(entry, { roster: view, keys, blobs, now });
    if (outcome.status === 'verified') entries.push(outcome.entry);
  }
  return { view, entries };
}

/** Every file under a folder whose bytes hold one of the needles. */
function filesHolding(dir: string, needles: readonly Buffer[]): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const bytes = readFileSync(full);
        if (needles.some((needle) => bytes.includes(needle))) found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

/** The hub's two key lines in every form a file could hold them: the line, the seed text and the raw seed bytes (D-30). */
function keyNeedles(keys: { signing: string; encryption: string }): Buffer[] {
  return [keys.signing, keys.encryption].flatMap((line) => {
    const seed = line.slice(line.lastIndexOf(':') + 1);
    const raw = Buffer.from(seed, 'base64url');
    return [Buffer.from(line, 'utf8'), Buffer.from(seed, 'utf8'), raw, Buffer.from(raw.toString('hex'), 'utf8')];
  });
}

async function withKept(body: (kept: KeptHub, track: (instance: HubInstance) => HubInstance) => Promise<void>): Promise<void> {
  const kept = keptHub();
  const running = new Set<HubInstance>();
  try {
    await body(kept, (instance) => {
      running.add(instance);
      const close = instance.hub.close.bind(instance.hub);
      instance.hub.close = async () => {
        running.delete(instance);
        await close();
      };
      return instance;
    });
  } finally {
    for (const instance of running) await instance.hub.close();
    kept.cleanup();
  }
}

test('restore drill: an old backup restored and started; both clients name rolled-back, hand back their newer checkpoints and re-push; the next checkpoint covers every client\'s heads, recomputes nested and nobody sees a forked view', () =>
  withKept(async (kept, track) => {
    const dir = kept.folder('state');
    let live = track(await kept.instance(dir));
    const { world, member, granted, ungranted } = await enrolledTeam(live.hub);
    const all = [world.project, granted, ungranted];
    const covered = [world.project, granted];
    const a = clientOf(world, world.lead);
    const b = clientOf(world, member);
    const reports: SyncReport[] = [];
    const run = async (hub: Hub, client: Client): Promise<SyncReport> => {
      const report = await sync(hub, world, client);
      reports.push(report);
      return report;
    };

    // Before the backup: both write in every cell, the hub signs C1 and both hold it.
    writeIn(world, a, all, 'first lead report');
    writeIn(world, b, all, 'first member report');
    await run(live.hub, a);
    await run(live.hub, b);
    await run(live.hub, a);
    await live.advance(MIN_GAP_MS);
    const c1 = latestOf(live.hub, world.project);
    assert.ok(c1, 'C1 was not signed');
    for (const client of [a, b]) assert.deepEqual(kinds(await run(live.hub, client)), []);
    const inBackup = heldHashes(live.hub, world.project);
    await live.hub.close();
    const backup = kept.copy(dir, 'backup');
    assert.deepEqual(filesHolding(backup, keyNeedles(kept.keys)), [], 'the backup holds a hub key');

    // After the backup: more work, C2 held by both, then B's last report under C2b, which only B holds.
    live = track(await kept.instance(dir));
    writeIn(world, a, all, 'second lead report');
    writeIn(world, b, all, 'second member report');
    await run(live.hub, a);
    await run(live.hub, b);
    await live.advance(MIN_GAP_MS);
    await run(live.hub, a);
    await run(live.hub, b);
    const c2 = latestOf(live.hub, world.project);
    assert.ok(c2 && checkpointHash(c2) !== checkpointHash(c1), 'C2 was not signed');
    for (const client of [a, b]) assert.equal(checkpointHash((await client.memory.load(live.hub.identity.writer, world.project)).newest as SignedCheckpoint), checkpointHash(c2));
    writeIn(world, b, all, 'third member report');
    await run(live.hub, b);
    await live.advance(MIN_GAP_MS);
    await run(live.hub, b);
    const c2b = latestOf(live.hub, world.project);
    assert.ok(c2b && checkpointHash(c2b) !== checkpointHash(c2), 'C2b was not signed');
    // The hub also signed a checkpoint between C1 and C2 on A's ask; that answer carried the one before it, so only B ever held it. C2 nests after it.
    const heldBy = async (client: Client): Promise<Set<string>> => new Set((await client.replica.checkpoints()).map(checkpointHash));
    const [byA, byB] = [await heldBy(a), await heldBy(b)];
    const onlyB = heldHashes(live.hub, world.project).filter((hash) => !inBackup.includes(hash) && hash !== checkpointHash(c2b) && byB.has(hash) && !byA.has(hash));
    assert.equal(onlyB.length, 1, 'the drill no longer has a checkpoint only B held');
    await live.hub.close();
    assert.deepEqual(filesHolding(dir, keyNeedles(kept.keys)), [], 'the live state folder holds a hub key');

    // The restore: the old backup goes back and the hub starts on it.
    kept.restore(backup, dir);
    live = track(await kept.instance(dir));
    assert.deepEqual(heldHashes(live.hub, world.project), inBackup);
    assert.equal(checkpointHash(latestOf(live.hub, world.project) as SignedCheckpoint), checkpointHash(c1));

    const fromA = await run(live.hub, a);
    assert.ok(kinds(fromA).includes('rolled-back'), JSON.stringify(fromA.findings));
    assert.equal(fromA.repushed, true);
    assert.ok(fromA.handedBack >= 1, 'A did not hand back C2');
    assert.ok(live.hub.checkpointLogs.some((line) => line.event === 'checkpoint.waiting'), 'the hub did not wait for the heads of C2');
    const afterA = heldHashes(live.hub, world.project);
    assert.ok(afterA.includes(checkpointHash(c2)) && !afterA.includes(checkpointHash(c2b)) && !afterA.includes(onlyB[0] as string));
    // Without the checkpoint only B held, the hub cannot reproduce C2's order: it signs nothing and waits for more to be handed back.
    assert.deepEqual(live.hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict').map((line) => line.fields.reason), ['order-mismatch']);
    // Until B has re-pushed, the hub signs nothing new.
    await live.advance(MIN_GAP_MS);
    assert.deepEqual(heldHashes(live.hub, world.project), afterA, 'the hub signed while the heads of C2b were missing');

    const fromB = await run(live.hub, b);
    assert.ok(kinds(fromB).includes('rolled-back'), JSON.stringify(fromB.findings));
    assert.equal(fromB.repushed, true);
    assert.ok(fromB.handedBack >= 1, 'B did not hand back C2b');
    assert.deepEqual(heldHashes(live.hub, world.project), [...afterA, checkpointHash(c2b), onlyB[0] as string].sort());

    // Work goes on: the next checkpoint C3 nests after everything handed back.
    writeIn(world, a, all, 'fourth lead report');
    await run(live.hub, a);
    await live.advance(MIN_GAP_MS);
    for (const client of [b, a]) assert.deepEqual(kinds(await run(live.hub, client)), []);
    const c3 = latestOf(live.hub, world.project);
    assert.ok(c3 && ![c1, c2, c2b].some((earlier) => checkpointHash(earlier) === checkpointHash(c3)), 'C3 was not signed');
    assert.equal(live.hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict').length, 1, 'the order gap did not heal once B handed back what it held');

    const { view, entries } = opened(world);
    const verdict = verifyCheckpoint(c3, view);
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    const payload = payloadOf(c3);
    assert.deepEqual(payload.streams.map((stream) => stream.stream).sort(), [...covered].sort(), 'C3 does not list exactly the base cell and the granted cell');
    for (const client of [a, b]) {
      for (const stream of (await client.replica.heads()).filter((item) => covered.includes(item.stream))) {
        const listed = payload.streams.find((item) => item.stream === stream.stream);
        for (const head of stream.heads) {
          const at = listed?.heads.find((item) => item.writer === head.writer);
          assert.ok(at !== undefined && at.seq >= head.seq, `C3 does not cover a client's head in ${stream.stream.slice(0, 8)}`);
        }
      }
      assert.equal(checkpointHash((await client.memory.load(live.hub.identity.writer, world.project)).newest as SignedCheckpoint), checkpointHash(c3));
    }
    // Recomputed with every earlier checkpoint of this hub nested (32-22), as a client holding them all does.
    const earlier = live.hub.store.checkpoints(world.project).map((record) => JSON.parse(record.body) as SignedCheckpoint).filter((item) => checkpointHash(item) !== checkpointHash(c3));
    assert.ok([c1, c2, c2b].every((item) => earlier.some((other) => checkpointHash(other) === checkpointHash(item))));
    assert.deepEqual(recomputeCheckpoint(payload, entries, undefined, earlier.map(payloadOf)), { ok: true, mismatches: [] });
    for (const report of reports) assert.ok(!kinds(report).includes('forked-view'), JSON.stringify(report.findings));
    assert.deepEqual(hashesOf(a.replica), hashesOf(b.replica), 'A and B do not hold the same entries');
  }));

test('restore drill, ungranted cell: no checkpoint lists it, so both clients name rolled-back from the hub\'s heads, re-push, and the hub\'s heads for it then equal theirs', () =>
  withKept(async (kept, track) => {
    const dir = kept.folder('state');
    let live = track(await kept.instance(dir));
    const { world, member, ungranted } = await enrolledTeam(live.hub);
    const a = clientOf(world, world.lead);
    const b = clientOf(world, member);

    writeIn(world, a, [ungranted], 'first lead cell report');
    writeIn(world, b, [ungranted], 'first member cell report');
    await sync(live.hub, world, a);
    await sync(live.hub, world, b);
    await sync(live.hub, world, a);
    await live.advance(MIN_GAP_MS);
    for (const client of [a, b]) await sync(live.hub, world, client);
    const c1 = latestOf(live.hub, world.project);
    await live.hub.close();
    const backup = kept.copy(dir, 'backup');

    live = track(await kept.instance(dir));
    writeIn(world, a, [ungranted], 'second lead cell report');
    writeIn(world, b, [ungranted], 'second member cell report');
    await sync(live.hub, world, a);
    await sync(live.hub, world, b);
    await sync(live.hub, world, a);
    writeIn(world, b, [ungranted], 'third member cell report');
    await sync(live.hub, world, b);
    await live.advance(MIN_GAP_MS);
    assert.equal(latestOf(live.hub, world.project) === undefined ? undefined : checkpointHash(latestOf(live.hub, world.project) as SignedCheckpoint), c1 === undefined ? undefined : checkpointHash(c1), 'a checkpoint followed work in the ungranted cell alone');
    await live.hub.close();

    kept.restore(backup, dir);
    live = track(await kept.instance(dir));
    for (const client of [a, b]) {
      const report = await sync(live.hub, world, client);
      const found = report.findings.find((item) => item.kind === 'rolled-back');
      assert.ok(found, JSON.stringify(report.findings));
      assert.equal(found.detail.stream, ungranted.slice(0, 12), 'the rollback was not named in the ungranted cell');
      assert.equal(report.handedBack, 0, 'a checkpoint was involved');
      assert.equal(report.repushed, true);
      assert.ok(!kinds(report).includes('forked-view'));
    }
    await sync(live.hub, world, a);
    assert.ok(live.hub.store.checkpoints(world.project).every((record) => payloadOf(JSON.parse(record.body) as SignedCheckpoint).streams.every((stream) => stream.stream !== ungranted)));
    const fromHub = (await hubHeadsFor(live.hub, world, a)).streams.find((stream) => stream.stream === ungranted);
    for (const client of [a, b]) {
      const mine = (await client.replica.heads()).find((stream) => stream.stream === ungranted);
      assert.ok(mine !== undefined && fromHub !== undefined);
      assert.deepEqual([...fromHub.heads].sort((x, y) => (x.writer < y.writer ? -1 : 1)), [...mine.heads].sort((x, y) => (x.writer < y.writer ? -1 : 1)));
    }
    assert.deepEqual(hashesOf(a.replica), hashesOf(b.replica), 'A and B do not hold the same entries');
  }));

test('restore drill: the cold backup and the live state folder hold no byte of the hub\'s signing or encryption key (D-30)', () =>
  withKept(async (kept, track) => {
    const dir = kept.folder('state');
    const live = track(await kept.instance(dir));
    const { world, granted } = await enrolledTeam(live.hub);
    const a = clientOf(world, world.lead);
    writeIn(world, a, [world.project, granted], 'report before the backup');
    await sync(live.hub, world, a);
    await live.advance(MIN_GAP_MS);
    assert.ok(live.hub.store.checkpoints(world.project).length >= 1, 'nothing was signed with the key');
    await live.hub.close();
    const backup = kept.copy(dir, 'backup');
    const needles = keyNeedles(kept.keys);
    assert.equal(needles.length, 8);
    assert.deepEqual(filesHolding(backup, needles), []);
    assert.deepEqual(filesHolding(dir, needles), []);
    // The search has teeth: a file that holds a key line is found.
    const planted = path.join(kept.folder('planted'), 'notes.txt');
    writeFileSync(planted, `kept by mistake ${kept.keys.signing}\n`);
    assert.deepEqual(filesHolding(path.dirname(planted), needles), ['notes.txt']);
  }));
