import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import type http from 'node:http';
import test from 'node:test';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import type { HubMemory, SyncReport } from '@ext/staff/replica/hubSync';
import { checkpointConflict, checkpointHash, readCheckpoint, recomputeCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Checkpoint, CheckpointEntry, SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Citation } from '@ext/domain/replica/chain';
import { buildEntry, entryHash, openBody } from '@ext/domain/replica/entry';
import type { SealedEntry } from '@ext/domain/replica/entry';
import { WITHHELD_GRACE_MS, DELAYED_AFTER_MS, witnessCheckpoint } from '@ext/domain/replica/hubWitness';
import type { HubFindingKind, WitnessState } from '@ext/domain/replica/hubWitness';
import { foldRoster, rosterView } from '@ext/domain/replica/roster';
import { verifyEntry } from '@ext/domain/replica/verify';
import { jsonAnswer, keptHub, readAnswer, withJson, wrapHarnessHub } from './helpers/faultProxy';
import type { FaultAnswer, FaultLayer, FaultPlan, HubInstance } from './helpers/faultProxy';
import { startHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { NOW_MS, createHubWorld, worldDevice } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import type { MemoryReplica } from './helpers/memoryReplica';
import { EventClient, ManualScheduler } from './helpers/sseReader';

// Phase 32, plan 26 (D-45, D-50, D-53, D-63, D-70; MUS-08): the malicious-hub harness. The real hub runs in process with the fault layer of
// helpers/faultProxy.ts in front of its request listener, so TLS and the session binding stay real while the layer changes what the hub answers.
// Rollback and a forked view use more instances of the same hub (its keys and certificate) on copies of its state folder, as a hostile operator
// could. The clients are the extension's own transport and one-shot sync over in-memory replicas (no fold, no Yjs).
//
// Every fault of D-53 is one table row. The rows run in an order drawn from a seeded generator, and every random choice a row makes comes from a
// generator seeded with the same seed and the row's name: the seed is printed as a test diagnostic, and HUB_HARNESS_SEED=<seed> repeats the run.
// HUB_HARNESS_FAULTS_OFF=1 runs every row with its fault switched off: each row's expectation must then fail, which is the proof that the row
// exercises its fault (the regression proof of a harness over finished code). All names and data are fictional.

const SEED = process.env.HUB_HARNESS_SEED ?? String(randomInt(1, 2 ** 31));
const FAULTS_OFF = process.env.HUB_HARNESS_FAULTS_OFF === '1';
const MIN_GAP_MS = 60_000;

/** A small seeded generator (mulberry32 over sha256 of the label): numbers in [0, 1). */
function generator(label: string): () => number {
  let state = createHash('sha256').update(label, 'utf8').digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

// ---- clients --------------------------------------------------------------------------------------------------------------------------------

/** What a client also reads from bodies it can open: the blobs entries cite and the deps they cite that it does not hold. */
interface Opening {
  missingDeps(): Promise<Citation[]>;
}

type Replica = MemoryReplica & Opening;

interface Client {
  device: WorldDevice;
  replica: Replica;
  memory: HubMemory;
}

/**
 * A memory replica that opens the bodies it holds keys for, as a device's real replica does: it names the blobs its entries cite (wanted when it does
 * not hold them, and as append blobRefs) and the deps they cite that it does not hold (D-50, D-63).
 */
function opening(world: HubWorld, device: WorldDevice, base: MemoryReplica): Replica {
  const bodyOf = (entry: SealedEntry): { deps?: Array<{ writer: string; seq: number; hash: string }>; blob?: string } | undefined => {
    const key = world.ringFor(device)(entry.header.stream, entry.header.epoch);
    if (key === undefined) return undefined;
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    if (plain === undefined) return undefined;
    try {
      return JSON.parse(plain.toString('utf8')) as { deps?: Array<{ writer: string; seq: number; hash: string }>; blob?: string };
    } catch {
      return undefined;
    }
  };
  return {
    ...base,
    async wantedBlobs() {
      const wanted = new Set<string>();
      for (const entry of base.all()) {
        const blob = bodyOf(entry)?.blob;
        if (typeof blob === 'string' && (await base.blob(blob)) === undefined) wanted.add(blob);
      }
      return [...wanted].sort();
    },
    async blobsCitedBy(hashes) {
      const asked = new Set(hashes);
      const refs: Array<{ entry: string; blob: string }> = [];
      for (const entry of base.all()) {
        const hash = entryHash(entry.header);
        const blob = asked.has(hash) ? bodyOf(entry)?.blob : undefined;
        if (typeof blob === 'string') refs.push({ entry: hash, blob });
      }
      return refs;
    },
    async missingDeps() {
      const cited = new Map<string, Citation>();
      for (const entry of base.all()) {
        for (const dep of bodyOf(entry)?.deps ?? []) {
          if (!base.has(dep.hash) && !cited.has(dep.hash)) cited.set(dep.hash, { stream: entry.header.stream, writer: dep.writer, seq: dep.seq, hash: dep.hash });
        }
      }
      return [...cited.values()];
    },
  };
}

/** A device's computer: a replica of the world as it is now (or the entries given) and its own witness memory. */
function clientOf(world: HubWorld, device: WorldDevice, entries?: readonly SealedEntry[]): Client {
  return { device, replica: opening(world, device, memoryReplica(world, device, entries ?? world.entries)), memory: hubMemoryOf(new MemorySecrets()) };
}

/** One exchange over a new pinned connection at the hub's clock; waits for any checkpoint the closing ask started. */
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

const kinds = (report: SyncReport): HubFindingKind[] => report.findings.map((item) => item.kind);
const findingOf = (report: SyncReport, kind: HubFindingKind) => report.findings.find((item) => item.kind === kind);
const hashesOf = (replica: MemoryReplica): string[] => replica.all().map((entry) => entryHash(entry.header)).sort();
const short = (id: string): string => id.slice(0, 12);

const note = (world: HubWorld, device: WorldDevice, extra: { stream?: string; deps?: Written[]; text?: string } = {}): Written =>
  world.write(device, {
    kind: 'note.add',
    data: { text: extra.text ?? 'Fictional observation' },
    ...(extra.stream === undefined ? {} : { stream: extra.stream }),
    ...(extra.deps === undefined ? {} : { deps: extra.deps.map((dep) => ({ writer: dep.writer, seq: dep.seq, hash: dep.hash })) }),
  });

/** No finding sentence or detail carries a key, a token or a full hash (D-50). */
function assertClean(reports: readonly SyncReport[], hub: Hub, devices: readonly WorldDevice[]): void {
  for (const report of reports) {
    const text = JSON.stringify(report.findings);
    assert.doesNotMatch(text, /[0-9a-f]{64}/, 'a finding carries a full hash');
    assert.doesNotMatch(text, /[A-Za-z0-9_-]{40,}/, 'a finding carries a token or a key');
    for (const secret of [hub.keys.signing, hub.keys.encryption, hub.identity.publicKey, hub.identity.x25519, ...devices.map((device) => device.publicKey)]) {
      assert.ok(!text.includes(secret), 'a finding carries a key');
    }
  }
}

async function loadWitness(client: Client, hub: Hub, world: HubWorld): Promise<WitnessState> {
  return client.memory.load(hub.identity.writer, world.project);
}

const signedOf = (record: { body: string } | undefined): SignedCheckpoint | undefined => (record === undefined ? undefined : (JSON.parse(record.body) as SignedCheckpoint));
const payloadOf = (signed: SignedCheckpoint): Checkpoint => readCheckpoint(signed.payload) as Checkpoint;

/** The entries of a request body (an append batch), read before the hub would read them. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- scenes ---------------------------------------------------------------------------------------------------------------------------------

/** A fresh in-process hub with the fault layer in front of it, and the world's project enrolled. */
interface Scene {
  hub: Hub;
  scheduler: ManualScheduler;
  layer: FaultLayer;
  world: HubWorld;
  /** Member B. */
  member: WorldDevice;
  /** Member C, a third writer. */
  officer: WorldDevice;
  /** A label cell of the lead, B and C that is not granted to the hub: no checkpoint can cover it (D-63). */
  ungranted: string;
  /** Puts a fault in place, unless HUB_HARNESS_FAULTS_OFF is set. */
  fault(plan: FaultPlan): void;
  /** Moves the hub's clock and timers, then lets any signing they started finish. */
  advance(ms: number): Promise<void>;
}

function team(hub: Hub, options: { ungranted?: boolean } = {}): { world: HubWorld; member: WorldDevice; officer: WorldDevice; ungranted: string } {
  const world = createHubWorld({ causalLamport: true });
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  const officer = world.device('OFFICER-C', 'mbr-c');
  world.admitMember(member);
  world.admitMember(officer);
  const ungranted = options.ungranted === false ? '' : world.labelCell('ops', [world.lead, member, officer]).cell;
  return { world, member, officer, ungranted };
}

async function withScene(body: (scene: Scene) => Promise<void>): Promise<void> {
  const scheduler = new ManualScheduler();
  const hub = await startHub({ scheduler });
  scheduler.onAdvance = (ms) => hub.advance(ms);
  const layer = wrapHarnessHub(hub);
  try {
    const made = team(hub);
    const enrolled = await hub.enrolProject(made.world);
    assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
    await body({
      hub,
      scheduler,
      layer,
      ...made,
      fault: (plan) => {
        if (!FAULTS_OFF) layer.set(plan);
      },
      advance: async (ms) => {
        scheduler.advance(ms);
        await hub.checkpoints?.settled();
      },
    });
  } finally {
    layer.restore();
    await hub.close();
  }
}

/** The roster as a client folds it and every entry opened with every key of the world: what a lead's computer recomputes checkpoints from. */
function openedEntries(world: HubWorld): CheckpointEntry[] {
  const keys = (stream: string, epoch: number): Buffer => world.keyOf(stream, epoch);
  const blobs = (hash: string) => world.blobs.get(hash);
  const now = new Date(NOW_MS);
  const view = rosterView(foldRoster({ entries: world.entries.filter((entry) => entry.header.stream === world.project), anchor: world.anchor(), keys, blobs, grants: world.grants, now }));
  const opened: CheckpointEntry[] = [];
  for (const entry of world.entries) {
    const outcome = verifyEntry(entry, { roster: view, keys, blobs, now });
    if (outcome.status === 'verified') opened.push(outcome.entry);
  }
  return opened;
}

// Answer rewriters.

/** An entries answer with its entries replaced. */
function entriesPage(answer: FaultAnswer, change: (entries: Array<{ header: { seq: number } & Record<string, unknown>; body: string }>, page: Record<string, unknown>) => Record<string, unknown>): FaultAnswer {
  const page = readAnswer(answer);
  if (page === undefined || answer.status !== 200) return answer;
  return withJson(answer, change(page.entries as Array<{ header: { seq: number } & Record<string, unknown>; body: string }>, page));
}

const pageOf = (hub: Hub, project: string, stream: string, writer: string, from = 0) =>
  hub.store.entriesFrom(project, stream, writer, from, { limit: 1000, maxBytes: 4 * 1024 * 1024 }).entries.map((entry) => ({ header: JSON.parse(entry.header) as Record<string, unknown>, body: entry.body }));

// ---- the fault table (D-53) ------------------------------------------------------------------------------------------------------------------

interface Row {
  name: string;
  run(random: () => number): Promise<void>;
}

const rows: Row[] = [
  {
    name: 'withheld (tracer): the fault layer drops one catch-up entry while the heads still name it; B names withheld after the grace period, never stores the next entry without it, and stores both once the fault is gone',
    run: () =>
      withScene(async ({ hub, world, member, fault, layer, advance }) => {
        const a = clientOf(world, world.lead);
        const b = clientOf(world, member);
        const first = note(world, world.lead, { text: 'Fictional first report' });
        const second = note(world, world.lead, { text: 'Fictional second report' });
        assert.ok(a.replica.add(first.entry) && a.replica.add(second.entry));
        const pushed = await sync(hub, world, a);
        assert.equal(pushed.outcome, 'synced', JSON.stringify(pushed));
        assert.equal(pushed.pushed, 2);

        fault({
          answer: (request, answer) =>
            request.route === 'entries' && request.device === member.writer
              ? entriesPage(answer, (entries, page) => ({ ...page, entries: entries.filter((entry) => entryHash(entry.header as never) !== first.hash) }))
              : answer,
        });
        const early = await sync(hub, world, b);
        assert.deepEqual(kinds(early), [], 'withheld before the grace period');
        assert.equal(b.replica.has(second.hash), false, 'the second entry was stored without the first');
        await advance(WITHHELD_GRACE_MS);
        const late = await sync(hub, world, b);
        assert.ok(kinds(late).includes('withheld'), JSON.stringify(late.findings));
        assert.equal(findingOf(late, 'withheld')?.detail.writer, short(world.lead.writer));
        assert.equal(b.replica.has(first.hash) || b.replica.has(second.hash), false);

        layer.clear();
        const honest = await sync(hub, world, b);
        assert.deepEqual(kinds(honest), [], JSON.stringify(honest.findings));
        assert.ok(b.replica.has(first.hash) && b.replica.has(second.hash));
        assertClean([early, late, honest], hub, [world.lead, member]);
      }),
  },
  {
    name: 'withheld by a dep in an ungranted cell: an entry citing one the hub never serves, which no checkpoint can show, is named withheld after the grace period',
    run: () =>
      withScene(async ({ hub, world, member, officer, ungranted, fault, advance }) => {
        const b = clientOf(world, member);
        const cited = note(world, officer, { stream: ungranted, text: 'Fictional sighting' });
        const citing = note(world, world.lead, { stream: ungranted, deps: [cited], text: 'Fictional assessment of the sighting' });
        const a = clientOf(world, world.lead);
        const pushed = await sync(hub, world, a);
        assert.equal(pushed.pushed, 2, JSON.stringify(pushed));

        // The hub hides C's log in the ungranted cell: no head names it and catch-up serves nothing of it.
        fault({
          answer: (request, answer) => {
            if (request.route === 'heads') {
              const heads = readAnswer<{ streams: Array<{ stream: string; heads: Array<{ writer: string }> }> }>(answer);
              if (heads === undefined) return answer;
              return withJson(answer, { ...heads, streams: heads.streams.map((stream) => (stream.stream === ungranted ? { ...stream, heads: stream.heads.filter((head) => head.writer !== officer.writer) } : stream)) });
            }
            if (request.route === 'entries' && request.query.get('stream') === ungranted && request.query.get('writer') === officer.writer) {
              return entriesPage(answer, (_entries, page) => ({ ...page, entries: [], more: false, head: null }));
            }
            return answer;
          },
        });
        const early = await sync(hub, world, b);
        assert.ok(b.replica.has(citing.hash), 'the citing entry arrived');
        assert.equal(b.replica.has(cited.hash), false);
        assert.deepEqual(kinds(early), [], JSON.stringify(early.findings));
        await advance(WITHHELD_GRACE_MS);
        const late = await sync(hub, world, b);
        assert.ok(kinds(late).includes('withheld'), JSON.stringify(late.findings));
        assert.equal(findingOf(late, 'withheld')?.detail.writer, short(officer.writer));
        assert.equal(findingOf(late, 'withheld')?.detail.stream, short(ungranted));
        assert.ok(hub.store.checkpoints(world.project).every((record) => payloadOf(JSON.parse(record.body) as SignedCheckpoint).streams.every((stream) => stream.stream !== ungranted)), 'a checkpoint lists the ungranted cell');
        assertClean([early, late], hub, [world.lead, member, officer]);
      }),
  },
  {
    name: 'delayed: with checkpoints stripped from every answer and event while appends are accepted, A names delayed after 5 minutes connected and not before',
    run: () =>
      withScene(async ({ hub, world, fault, layer, advance }) => {
        const a = clientOf(world, world.lead);
        // The fault is in place before the event stream opens: the layer filters the frames of streams it saw open.
        fault({
          answer: (request, answer) => {
            if (!['heads', 'entries', 'append', 'checkpoint'].includes(request.route)) return answer;
            const value = readAnswer(answer);
            if (value === undefined || !('checkpoint' in value)) return answer;
            const rest: Record<string, unknown> = { ...value };
            delete rest.checkpoint;
            return withJson(answer, rest);
          },
          frame: (_request, frame) => (frame.includes('event: checkpoint') ? undefined : frame),
        });
        const reader = await EventClient.open(hub, world.lead, world.project);
        const stream = await reader.events();
        try {
          const written = note(world, world.lead);
          assert.ok(a.replica.add(written.entry));
          const first = await sync(hub, world, a);
          assert.equal(first.pushed, 1, JSON.stringify(first));
          assert.deepEqual(kinds(first), []);
          await advance(DELAYED_AFTER_MS - MIN_GAP_MS);
          const before = await sync(hub, world, a);
          assert.deepEqual(kinds(before), [], 'delayed before 5 minutes');
          await advance(MIN_GAP_MS);
          const after = await sync(hub, world, a);
          assert.ok(kinds(after).includes('delayed'), JSON.stringify(after.findings));
          assert.ok((findingOf(after, 'delayed')?.count ?? 0) >= 5);
          assert.ok(hub.store.checkpoints(world.project).length >= 1, 'the hub signed checkpoints the layer stripped');
          assert.ok(layer.stats.framesDropped >= 1, 'no checkpoint event was held back');
          assert.equal(stream.frames.filter((frame) => frame.event === 'checkpoint').length, 0);
          assertClean([first, before, after], hub, [world.lead]);
        } finally {
          reader.close();
        }
      }),
  },
  {
    name: 'replayed: every entry served twice and the old ones again is counted replayed, and the final entry set equals an honest run',
    run: (random) =>
      withScene(async ({ hub, world, member, fault, layer }) => {
        const honest = clientOf(world, member);
        const replayed = clientOf(world, member);
        for (let index = 0; index < 4; index += 1) note(world, world.lead, { text: `Fictional report ${index}` });
        const a = clientOf(world, world.lead);
        await sync(hub, world, a);
        const clean = await sync(hub, world, honest);
        assert.deepEqual(kinds(clean), []);

        fault({
          answer: (request, answer) =>
            request.route === 'entries' && request.device === member.writer
              ? entriesPage(answer, (entries, page) => {
                  const all = pageOf(hub, world.project, request.query.get('stream') as string, request.query.get('writer') as string);
                  return { ...page, entries: shuffle([...entries, ...entries, ...all], random) };
                })
              : answer,
        });
        const report = await sync(hub, world, replayed);
        layer.clear();
        assert.ok(kinds(report).includes('replayed'), JSON.stringify(report.findings));
        assert.ok((findingOf(report, 'replayed')?.count ?? 0) > 0);
        assert.equal(report.outcome, 'synced');
        assert.deepEqual(hashesOf(replayed.replica), hashesOf(honest.replica));
        assert.equal((await loadWitness(replayed, hub, world)).replayed > 0, true);
        assertClean([report], hub, [world.lead, member]);
      }),
  },
  {
    name: 'reorder: pages reversed and writers and streams interleaved in another order give no finding, and the final entry set equals an honest run',
    run: (random) =>
      withScene(async ({ hub, world, member, officer, ungranted, fault, layer }) => {
        const honest = clientOf(world, member);
        const reordered = clientOf(world, member);
        for (let index = 0; index < 3; index += 1) {
          note(world, world.lead, { text: `Fictional lead report ${index}` });
          note(world, officer, { text: `Fictional officer report ${index}` });
          note(world, officer, { stream: ungranted, text: `Fictional cell report ${index}` });
        }
        const a = clientOf(world, world.lead);
        await sync(hub, world, a);
        const clean = await sync(hub, world, honest);
        assert.deepEqual(kinds(clean), []);

        let reversed = 0;
        fault({
          answer: (request, answer) => {
            if (request.device !== member.writer) return answer;
            if (request.route === 'entries') {
              return entriesPage(answer, (entries, page) => {
                if (entries.length > 1) reversed += 1;
                return { ...page, entries: [...entries].reverse() };
              });
            }
            if (request.route === 'heads') {
              const heads = readAnswer<{ streams: Array<{ stream: string; heads: unknown[] }> }>(answer);
              if (heads === undefined) return answer;
              return withJson(answer, { ...heads, streams: shuffle(heads.streams.map((stream) => ({ ...stream, heads: shuffle(stream.heads, random) })), random) });
            }
            return answer;
          },
        });
        const report = await sync(hub, world, reordered);
        layer.clear();
        assert.deepEqual(kinds(report), [], JSON.stringify(report.findings));
        assert.ok(reversed >= 2, 'no page held two or more entries to reverse, so the row proves nothing');
        assert.deepEqual(hashesOf(reordered.replica), hashesOf(honest.replica));
        assert.ok(report.pulled >= 9);
      }),
  },
  {
    name: 'rolled-back (base cell, through the checkpoint): A switched to a second instance on an older copy names rolled-back, hands back its newer checkpoint and re-pushes until that instance holds A\'s heads',
    run: async () => {
      const kept = keptHub();
      const dir = kept.folder('state');
      let current: HubInstance | undefined = await kept.instance(dir);
      let rolled: HubInstance | undefined;
      try {
        const { world } = team(current.hub, { ungranted: false });
        assert.equal((await current.hub.enrolProject(world))?.status, 201);
        const a = clientOf(world, world.lead);
        assert.ok(a.replica.add(note(world, world.lead, { text: 'Fictional first report' }).entry));
        await sync(current.hub, world, a);
        await sync(current.hub, world, a);
        const c1 = signedOf(current.hub.store.latestCheckpoint(world.project));
        assert.ok(c1, 'C1 was not signed');
        await current.hub.close();
        current = undefined;
        // The operator's older copy, taken after a clean stop.
        const older = kept.copy(dir, 'older');

        current = await kept.instance(dir);
        const newer = note(world, world.lead, { text: 'Fictional second report' });
        assert.ok(a.replica.add(newer.entry));
        await sync(current.hub, world, a);
        await current.advance(MIN_GAP_MS);
        const fine = await sync(current.hub, world, a);
        assert.deepEqual(kinds(fine), []);
        const c2 = signedOf(current.hub.store.latestCheckpoint(world.project));
        assert.ok(c2 && checkpointHash(c2) !== checkpointHash(c1), 'C2 was not signed');
        const held = await loadWitness(a, current.hub, world);
        assert.equal(held.newest === undefined ? undefined : checkpointHash(held.newest), checkpointHash(c2));
        await current.hub.close();
        current = undefined;

        rolled = await kept.instance(FAULTS_OFF ? dir : older);
        const shown = signedOf(rolled.hub.store.latestCheckpoint(world.project));
        assert.ok(shown);
        // Through the checkpoint: the hub's latest, given to the witness A held before this exchange, is below the newest A kept.
        const direct = witnessCheckpoint(held, shown, await a.replica.roster());
        assert.deepEqual(direct.findings.map((item) => item.kind), ['rolled-back']);
        const report = await sync(rolled.hub, world, a);
        assert.ok(kinds(report).includes('rolled-back'), JSON.stringify(report.findings));
        assert.equal(report.outcome, 'attention');
        assert.equal(report.repushed, true);
        assert.ok(report.handedBack >= 1, 'the newer checkpoint was not handed back');
        assert.ok(rolled.hub.store.checkpoints(world.project).some((record) => record.hash === checkpointHash(c2)), 'the hub does not hold C2 again');
        for (const stream of await a.replica.heads()) {
          for (const head of stream.heads) assert.deepEqual(rolled.hub.store.headOf(world.project, stream.stream, head.writer), { seq: head.seq, hash: head.hash });
        }
        assertClean([report], rolled.hub, [world.lead]);
      } finally {
        await current?.hub.close();
        await rolled?.hub.close();
        kept.cleanup();
      }
    },
  },
  {
    name: 'rolled-back (ungranted cell, through the witness\'s heads): no checkpoint lists the cell, the hub\'s heads for it are below what A saw it accept, and A re-pushes until they reach A\'s',
    run: async () => {
      const kept = keptHub();
      const dir = kept.folder('state');
      let current: HubInstance | undefined = await kept.instance(dir);
      let rolled: HubInstance | undefined;
      try {
        const { world, ungranted } = team(current.hub);
        assert.equal((await current.hub.enrolProject(world))?.status, 201);
        const a = clientOf(world, world.lead);
        assert.ok(a.replica.add(note(world, world.lead, { stream: ungranted, text: 'Fictional first cell report' }).entry));
        await sync(current.hub, world, a);
        await sync(current.hub, world, a);
        await current.hub.close();
        current = undefined;
        const older = kept.copy(dir, 'older');

        current = await kept.instance(dir);
        const newer = note(world, world.lead, { stream: ungranted, text: 'Fictional second cell report' });
        assert.ok(a.replica.add(newer.entry));
        const pushed = await sync(current.hub, world, a);
        assert.equal(pushed.pushed, 1);
        const kept1 = await loadWitness(a, current.hub, world);
        await current.hub.close();
        current = undefined;

        rolled = await kept.instance(FAULTS_OFF ? dir : older);
        const report = await sync(rolled.hub, world, a);
        const found = findingOf(report, 'rolled-back');
        assert.ok(found, JSON.stringify(report.findings));
        assert.equal(found.detail.stream, short(ungranted));
        assert.equal(found.count, 1, 'only the ungranted cell went back');
        assert.equal(report.handedBack, 0, 'a checkpoint was involved');
        const after = await loadWitness(a, rolled.hub, world);
        assert.equal(after.newest === undefined ? undefined : checkpointHash(after.newest), kept1.newest === undefined ? undefined : checkpointHash(kept1.newest), 'the kept newest checkpoint changed');
        assert.ok(rolled.hub.store.checkpoints(world.project).every((record) => payloadOf(JSON.parse(record.body) as SignedCheckpoint).streams.every((stream) => stream.stream !== ungranted)));
        assert.equal(report.repushed, true);
        assert.deepEqual(rolled.hub.store.headOf(world.project, ungranted, world.lead.writer), { seq: newer.seq, hash: newer.hash });
        assertClean([report], rolled.hub, [world.lead]);
      } finally {
        await current?.hub.close();
        await rolled?.hub.close();
        kept.cleanup();
      }
    },
  },
  {
    name: 'forked-view: two instances from one copy each sign a checkpoint over a different base cell entry; A shown the other one names forked-view and keeps both signed checkpoints as the proof',
    run: async () => {
      const kept = keptHub();
      const dir = kept.folder('state');
      const opened: HubInstance[] = [];
      try {
        const setup = await kept.instance(dir);
        opened.push(setup);
        const { world, member } = team(setup.hub, { ungranted: false });
        assert.equal((await setup.hub.enrolProject(world))?.status, 201);
        await setup.hub.close();
        opened.pop();
        const x = await kept.instance(kept.copy(dir, 'x'));
        opened.push(x);
        const y = await kept.instance(kept.copy(dir, 'y'));
        opened.push(y);
        const layer = wrapHarnessHub(x.hub);

        const a = clientOf(world, world.lead);
        const b = clientOf(world, member);
        assert.ok(a.replica.add(note(world, world.lead, { text: 'Fictional report seen by X' }).entry));
        assert.ok(b.replica.add(note(world, member, { text: 'Fictional report seen by Y' }).entry));
        await sync(x.hub, world, a);
        assert.deepEqual(kinds(await sync(x.hub, world, a)), []);
        await sync(y.hub, world, b);
        assert.deepEqual(kinds(await sync(y.hub, world, b)), []);
        const cx = signedOf(x.hub.store.latestCheckpoint(world.project));
        const cy = signedOf(y.hub.store.latestCheckpoint(world.project));
        assert.ok(cx && cy);

        if (!FAULTS_OFF) {
          layer.set({
            answer: (request, answer) => {
              if (request.route !== 'heads' && request.route !== 'checkpoint') return answer;
              const value = readAnswer(answer);
              return value === undefined || answer.status !== 200 ? answer : withJson(answer, { ...value, checkpoint: cy });
            },
          });
        }
        const report = await sync(x.hub, world, a);
        layer.restore();
        assert.ok(kinds(report).includes('forked-view'), JSON.stringify(report.findings));
        assert.equal(report.outcome, 'attention');
        const proof = (await a.replica.checkpoints()).map(checkpointHash);
        assert.ok(proof.includes(checkpointHash(cx)) && proof.includes(checkpointHash(cy)), 'A does not keep both signed checkpoints');
        assert.equal(checkpointConflict(cx, cy)?.reason, 'equal-count-tip-mismatch');
        const witness = await loadWitness(a, x.hub, world);
        assert.equal(witness.distrusted, true);
        assert.deepEqual([witness.proof?.a, witness.proof?.b].map((item) => (item === undefined ? '' : checkpointHash(item))).sort(), [checkpointHash(cx), checkpointHash(cy)].sort());
        assertClean([report], x.hub, [world.lead, member]);
      } finally {
        for (const instance of opened) await instance.hub.close();
        kept.cleanup();
      }
    },
  },
  {
    name: 'injected: an entry for B\'s writer signed by a key the roster does not hold is named injected and A does not store it',
    run: () =>
      withScene(async ({ hub, world, member, fault }) => {
        const a = clientOf(world, world.lead);
        const b = clientOf(world, member);
        const real = note(world, member, { text: 'Fictional member report' });
        assert.ok(b.replica.add(real.entry));
        await sync(hub, world, b);
        const forger = worldDevice('FORGER', 'mbr-forger');
        const built = buildEntry({
          signer: forger.signer,
          key: world.keyOf(world.project, 1),
          stream: world.project,
          seq: real.seq + 1,
          prev: real.hash,
          epoch: 1,
          body: { deps: [], roster: world.head, lamport: 1000, at: '2026-11-19T11:00:00.000Z', actor: { kind: 'person' }, kind: 'note.add', data: { text: 'Forged order' } },
        });
        const forged: SealedEntry = { header: { ...built.entry.header, writer: member.writer }, body: built.entry.body };
        const forgedHash = entryHash(forged.header);
        fault({
          answer: (request, answer) =>
            request.route === 'entries' && request.query.get('writer') === member.writer ? entriesPage(answer, (entries, page) => ({ ...page, entries: [...entries, forged] })) : answer,
        });
        const report = await sync(hub, world, a);
        assert.ok(kinds(report).includes('injected'), JSON.stringify(report.findings));
        assert.equal(findingOf(report, 'injected')?.detail.reason, 'bad-signature');
        assert.equal(a.replica.has(forgedHash), false, 'the forged entry was stored');
        assert.ok(a.replica.has(real.hash));
        assert.equal(hub.store.entryByHash(world.project, forgedHash), undefined);
        assertClean([report], hub, [world.lead, member, forger]);
      }),
  },
  {
    name: 'corrupt-blob: one byte flipped in a blob answer is named corrupt-blob and nothing is stored; the honest retry stores the blob',
    run: (random) =>
      withScene(async ({ hub, world, member, fault, layer }) => {
        const b = clientOf(world, member);
        const big = note(world, world.lead, { text: `Fictional long assessment ${'of the exercise area '.repeat(1200)}` });
        assert.equal(big.blobs.length, 1, 'the body did not move to a blob');
        const blob = big.blobs[0]?.hash as string;
        const a = clientOf(world, world.lead);
        const pushed = await sync(hub, world, a);
        assert.ok(pushed.pushed >= 1, JSON.stringify(pushed));
        assert.ok(hub.store.blobInfo(world.project, blob) !== undefined, 'the hub does not hold the blob');

        fault({
          answer: (request, answer) => {
            if (request.route !== 'blob-get' || answer.status !== 200) return answer;
            const bytes = Buffer.from(answer.body);
            const at = Math.floor(random() * bytes.length);
            bytes[at] = (bytes[at] as number) ^ 0x01;
            return { ...answer, body: bytes };
          },
        });
        const report = await sync(hub, world, b);
        assert.ok(b.replica.has(big.hash), 'the entry citing the blob was not pulled');
        assert.ok(kinds(report).includes('corrupt-blob'), JSON.stringify(report.findings));
        assert.equal(findingOf(report, 'corrupt-blob')?.detail.blob, short(blob));
        assert.equal(await b.replica.blob(blob), undefined, 'the corrupt blob was stored');
        assert.equal(report.blobs, 0);

        layer.clear();
        const retry = await sync(hub, world, b);
        assert.equal(retry.blobs, 1);
        assert.ok((await b.replica.blob(blob)) !== undefined);
        assert.deepEqual(kinds(retry), []);
        assertClean([report, retry], hub, [world.lead, member]);
      }),
  },
  {
    name: 'delayed after selective refusal: the hub refuses A\'s appends only, while B\'s are taken; A names delayed after 5 minutes connected',
    run: () =>
      withScene(async ({ hub, world, member, fault, advance }) => {
        const a = clientOf(world, world.lead);
        const b = clientOf(world, member);
        await sync(hub, world, a);
        const start = await sync(hub, world, a);
        assert.deepEqual(kinds(start), []);
        let refused = 0;
        fault({
          refuse: async (request) => {
            if (request.route !== 'append' || request.device !== world.lead.writer) return undefined;
            const batch = JSON.parse((await readBody(request.req)).toString('utf8')) as { entries: SealedEntry[] };
            refused += batch.entries.length;
            const refusals = batch.entries.map((entry, index) => ({ index, hash: entryHash(entry.header), reason: 'rate-limited' }));
            return jsonAnswer(200, { project: world.project, accepted: [], refused: refusals, rosterHead: world.head });
          },
        });
        const mine = note(world, world.lead, { text: 'Fictional report the hub refuses' });
        assert.ok(a.replica.add(mine.entry));
        const theirs = note(world, member, { text: 'Fictional report the hub takes' });
        assert.ok(b.replica.add(theirs.entry));
        const first = await sync(hub, world, a);
        assert.equal(first.pushed, FAULTS_OFF ? 1 : 0);
        assert.deepEqual(kinds(first), []);
        const taken = await sync(hub, world, b);
        assert.equal(taken.pushed, 1, 'the hub refused B too');
        await advance(DELAYED_AFTER_MS - 1000);
        assert.deepEqual(kinds(await sync(hub, world, a)), [], 'delayed before 5 minutes');
        await advance(1000);
        const after = await sync(hub, world, a);
        assert.ok(kinds(after).includes('delayed'), JSON.stringify(after.findings));
        assert.ok(refused >= 1);
        assert.equal(hub.store.entryByHash(world.project, mine.hash), undefined);
        assertClean([first, after], hub, [world.lead, member]);
      }),
  },
  {
    name: 'wrong-project: an entries page of a second project enrolled on the same hub, served under this project\'s path, is named wrong-project and nothing is ingested',
    run: () =>
      withScene(async ({ hub, world, member, fault }) => {
        const other = createHubWorld({ projectLabel: 'eastwind', leadLabel: 'LEAD-EAST', causalLamport: true });
        other.admitHub(hub.identity);
        assert.equal((await hub.enrolProject(other))?.status, 201);
        const b = clientOf(world, member);
        const a = clientOf(world, world.lead);
        assert.ok(a.replica.add(note(world, world.lead).entry));
        await sync(hub, world, a);
        const before = hashesOf(b.replica);
        fault({
          answer: (request, answer) => {
            if (request.route !== 'entries' || request.project !== world.project) return answer;
            const entries = pageOf(hub, other.project, other.project, other.lead.writer);
            const head = hub.store.headOf(other.project, other.project, other.lead.writer) ?? null;
            return withJson(answer, { project: other.project, stream: other.project, writer: other.lead.writer, entries, more: false, head });
          },
        });
        const report = await sync(hub, world, b);
        assert.ok(kinds(report).includes('wrong-project'), JSON.stringify(report.findings));
        assert.equal(report.outcome, 'attention');
        assert.equal(report.pulled, 0);
        assert.deepEqual(hashesOf(b.replica), before, 'something was ingested');
        assertClean([report], hub, [world.lead, member, other.lead]);
      }),
  },
  {
    name: 'withheld after a catch-up ended early with more false before the heads were reached',
    run: (random) =>
      withScene(async ({ hub, world, member, fault, layer, advance }) => {
        const b = clientOf(world, member);
        const written = Array.from({ length: 6 }, (_, index) => note(world, world.lead, { text: `Fictional report ${index}` }));
        const a = clientOf(world, world.lead);
        await sync(hub, world, a);
        fault({
          answer: (request, answer) =>
            request.route === 'entries' && request.device === member.writer
              ? entriesPage(answer, (entries, page) => {
                  const keep = entries.length < 2 ? 0 : 1 + Math.floor(random() * (entries.length - 1));
                  return { ...page, entries: entries.slice(0, keep), more: false };
                })
              : answer,
        });
        const early = await sync(hub, world, b);
        assert.deepEqual(kinds(early), []);
        assert.equal(b.replica.has((written.at(-1) as Written).hash), false);
        await advance(WITHHELD_GRACE_MS);
        const late = await sync(hub, world, b);
        assert.ok(kinds(late).includes('withheld'), JSON.stringify(late.findings));
        assert.equal(b.replica.has((written.at(-1) as Written).hash), false, 'the hub\'s head was reached');
        layer.clear();
        const honest = await sync(hub, world, b);
        assert.deepEqual(kinds(honest), []);
        assert.ok(written.every((item) => b.replica.has(item.hash)));
        assertClean([early, late, honest], hub, [world.lead, member]);
      }),
  },
  {
    name: 'honest chain (control, D-70): three checkpoints with a late concurrent entry between the second and the third raise no forked-view and no rolled-back',
    run: () =>
      withScene(async ({ hub, world, member, officer, advance }) => {
        const lead = clientOf(world, world.lead);
        const observer = clientOf(world, member);
        const late = clientOf(world, officer);
        const reports: SyncReport[] = [];
        const step = async (client: Client): Promise<void> => {
          const report = await sync(hub, world, client);
          reports.push(report);
          assert.equal(report.outcome, 'synced', JSON.stringify(report));
        };
        // C writes its first entry now (lamport 1) but sends it only after the second checkpoint.
        const concurrent = note(world, officer, { text: 'Fictional late sighting' });
        assert.equal(concurrent.seq, 0);
        assert.ok(late.replica.add(concurrent.entry));

        assert.ok(lead.replica.add(note(world, world.lead, { text: 'Fictional report 1' }).entry));
        await step(lead);
        await step(observer);
        assert.ok(lead.replica.add(note(world, world.lead, { text: 'Fictional report 2' }).entry));
        assert.ok(lead.replica.add(note(world, world.lead, { text: 'Fictional report 3' }).entry));
        await step(lead);
        await advance(MIN_GAP_MS);
        await step(observer);
        await step(late);
        await advance(MIN_GAP_MS);
        await step(observer);
        await step(lead);
        await step(late);

        const signed = hub.store.checkpoints(world.project).map((record) => JSON.parse(record.body) as SignedCheckpoint);
        assert.ok(signed.length >= 3, `${signed.length} checkpoints were signed`);
        for (const report of reports) {
          assert.ok(!kinds(report).includes('forked-view') && !kinds(report).includes('rolled-back'), JSON.stringify(report.findings));
        }
        const newest = (await loadWitness(observer, hub, world)).newest;
        assert.equal(newest === undefined ? undefined : checkpointHash(newest), checkpointHash(signed.at(-1) as SignedCheckpoint));
        // The control has its teeth: without the earlier checkpoints nested the last one does not recompute, because the late entry sorts first.
        const opened = openedEntries(world);
        const [c1, c2, c3] = signed.slice(-3).map(payloadOf) as [Checkpoint, Checkpoint, Checkpoint];
        assert.deepEqual(recomputeCheckpoint(c3, opened, undefined, [c1, c2]), { ok: true, mismatches: [] });
        assert.equal(recomputeCheckpoint(c3, opened).ok, false, 'the late entry did not change the order: the control proves nothing');
        assertClean(reports, hub, [world.lead, member, officer]);
      }),
  },
];

const order = shuffle(rows, generator(`${SEED}/order`));

test(`seed ${SEED}: the fault rows run in an order drawn from it; HUB_HARNESS_SEED=${SEED} repeats this order and every random choice`, (t) => {
  t.diagnostic(`HUB_HARNESS_SEED=${SEED}${FAULTS_OFF ? ' (faults switched off)' : ''}`);
  for (const [index, row] of order.entries()) t.diagnostic(`${index + 1}. ${row.name}`);
  assert.equal(new Set(order.map((row) => row.name)).size, rows.length);
  assert.deepEqual(shuffle(rows, generator(`${SEED}/order`)).map((row) => row.name), order.map((row) => row.name), 'the same seed gave another order');
});

for (const row of order) test(row.name, () => row.run(generator(`${SEED}/${row.name}`)));
