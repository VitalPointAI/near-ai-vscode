import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { grantHash } from '@ext/domain/replica/cellKeys';
import type { CellGrant } from '@ext/domain/replica/cellKeys';
import { entryHash, openBody } from '@ext/domain/replica/entry';
import { openPresence, sealPresence } from '@ext/domain/replica/presence';
import type { PresenceMessage } from '@ext/domain/replica/presence';
import { sessionCertifyData } from '@ext/domain/replica/sessionKeys';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { assertNowhere, captureServer, filesUnder, search, wireOf } from './helpers/capture';
import type { Capture, Place } from './helpers/capture';
import { startHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { liveClient, reaches } from './helpers/liveClient';
import type { LiveClient } from './helpers/liveClient';
import { memoryReplica } from './helpers/memoryReplica';

// Phase 33, plan 14 (D-35, criterion 4): the two-compartment label leak test through the live replicator. Person X is cleared for compartment one
// and person Y for compartment two; Y works in a hosted session, so Y's ordinary work is signed by a session key that Y's device certified (D-62).
// Each writes a product in its own label cell, and each sends live presence and cursor messages there. Every byte the hub received and sent on
// every connection is captured (helpers/capture.ts, shared with ciphertextOnly.test.ts), and the hub's state folder is read raw while it runs.
// No canary of the other compartment, in any form canaryForms gives, and no stream id, grant or entry of it reaches X's or Y's connections; the hub,
// which is granted neither cell, holds and relays only ciphertext; presence opens only under its own cell's key; and the session certificate
// carries nothing beyond the roster cell's binding. Each clean search is paired with a control that finds what it looks for. All data is fictional.

const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const VERSION_HASH = createHash('sha256').update('fictional version of the live product', 'utf8').digest('hex');
const Y_SLOT = 7;

interface Canaries { name: string; title: string; text: string; reason: string; position: string }

const canariesOf = (tag: string): Canaries => ({
  name: `canary-${tag.toLowerCase()}-name-3e9d`,
  title: `CANARY-${tag}-TITLE-b8f1`,
  text: `CANARY-${tag}-TEXT-62ac`,
  reason: `CANARY-${tag}-REASON-0f4e`,
  position: `CANARY-${tag}-POSITION-91d7`,
});

/** Update bytes as a document update carries them: a few structure bytes, then the inserted text as UTF-8. */
const updateBytes = (text: string): string => Buffer.concat([Buffer.from([1, 1, 0xb4, 0x9e, 0xc1, 0x07, 0, 4]), Buffer.from(text, 'utf8')]).toString('base64url');

interface Compartment { tag: string; cell: string; founding: SignedPayload<CellGrant>; canaries: Canaries; written: Written[]; sealedPresence: string[] }

interface Scene {
  hub: Hub;
  capture: Capture;
  world: HubWorld;
  x: WorldDevice;
  y: WorldDevice;
  session: WorldDevice;
  certificate: Written;
  one: Compartment;
  two: Compartment;
  lead: LiveClient;
  xc: LiveClient;
  yc: LiveClient;
  presence: Map<string, Array<Record<string, unknown>>>;
  running: Place[];
  root: string;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A person's own computer: the base stream as it was when they joined and only the grants wrapped to their device. */
function ownView(world: HubWorld, device: WorldDevice) {
  const grants = world.grants.filter((grant) => grant.payload.wraps.some((wrap) => wrap.writer === device.writer));
  return memoryReplica({ ...world, grants, blobs: new Map() }, device, world.entries.filter((entry) => entry.header.stream === world.project));
}

/** One compartment's product, written by the given key and kept on its writer's computer. */
function writeProduct(world: HubWorld, client: LiveClient, by: WorldDevice, compartment: Compartment): void {
  const { canaries, cell } = compartment;
  const product = canaries.name;
  for (const options of [
    { stream: cell, kind: 'product.create', data: { product, section: 'j4', roles: ROLES, title: canaries.title } },
    { stream: cell, kind: 'doc.update', data: { product, update: updateBytes(`Fictional exercise estimate. ${canaries.text}.`) } },
    { stream: cell, kind: 'version.verdict', data: { product, hash: VERSION_HASH, gate: 'guard', verdict: 'HOLD', reasons: [canaries.reason] } },
  ]) {
    const written = world.write(by, options);
    assert.ok(client.replica.add(written.entry));
    compartment.written.push(written);
  }
  client.replicator.localAppended();
}

/** Sealed presence as a client makes it: the message sealed under the cell's key, bound to the cell, the epoch and the sending device. */
function sealedIn(world: HubWorld, compartment: Compartment, writer: string, message: PresenceMessage): string {
  const sealed = sealPresence(world.keyOf(compartment.cell, 1), { cell: compartment.cell, epoch: 1, writer }, message);
  compartment.sealedPresence.push(sealed);
  return sealed;
}

async function buildScene(): Promise<Scene> {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-live-leak-'));
  const dir = path.join(root, 'state');
  mkdirSync(dir, { mode: 0o700 });
  const hub = await startHub({ dir });
  const capture = captureServer(hub.server);
  const clients: LiveClient[] = [];
  try {
    const world = createHubWorld({ projectLabel: 'live-compartments', causalLamport: true });
    world.admitHub(hub.identity);
    const x = world.device('PERSON-X', 'mbr-x');
    const y = world.device('PERSON-Y', 'mbr-y');
    world.admitMember(x);
    world.admitMember(y, { slot: Y_SLOT });
    const cellOf = (tag: string, label: string, member: WorldDevice): Compartment => {
      const made = world.labelCell(label, [world.lead, member]);
      return { tag, cell: made.cell, founding: made.grant, canaries: canariesOf(tag), written: [], sealedPresence: [] };
    };
    const one = cellOf('ONE', 'compartment-one', x);
    const two = cellOf('TWO', 'compartment-two', y);
    const answer = await hub.enrolProject(world);
    assert.equal(answer?.status, 201, answer?.text ?? 'no answer');

    const presence = new Map<string, Array<Record<string, unknown>>>();
    const watch = (writer: string) => {
      presence.set(writer, []);
      return { onPresence: (frame: Record<string, unknown>) => presence.get(writer)?.push(frame) };
    };
    // The lead's computer holds everything so far; X's and Y's hold the base stream and their own grants (their cell keys come from those).
    const lead = liveClient(hub, world, world.lead, watch(world.lead.writer), memoryReplica(world, world.lead, [...world.entries]));
    const xc = liveClient(hub, world, x, watch(x.writer), ownView(world, x));
    // Y's device certifies a session key; the session key signs Y's session and ordinary work, and the certificate goes with its session answer.
    const session = world.device('PERSON-Y-SESSION', y.member);
    const notAfter = new Date(NOW_MS + 11 * 60 * 60 * 1000).toISOString();
    const yView = ownView(world, y);
    const certificate = world.write(y, {
      kind: 'session.certify', at: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
      data: sessionCertifyData({ project: world.project, member: y.member, device: y.writer, sessionKey: session.publicKey, slot: Y_SLOT, notAfter }, (bytes) => session.signer.sign(bytes)),
    });
    assert.ok(yView.add(certificate.entry));
    const yc = liveClient(hub, world, y, { ...watch(session.writer), signer: session.signer, certificate: certificate.entry }, yView);
    clients.push(lead, xc, yc);
    for (const client of clients) {
      await client.replicator.start();
      await reaches(client.replicator, (status) => status.state === 'live', `${client.device.label} live`);
    }

    writeProduct(world, xc, x, one);
    writeProduct(world, yc, session, two);
    await until(() => [...one.written, ...two.written].every((written) => lead.replica.has(written.hash)), 'the lead holds both compartments');

    // Presence and cursors: X and Y each in their own cell, the lead in both (the control for what X and Y do hear).
    await xc.replicator.postPresence(one.cell, sealedIn(world, one, x.writer, { v: 1, kind: 'here', member: x.member, position: one.canaries.position, seq: 1 }));
    await xc.replicator.postPresence(one.cell, sealedIn(world, one, x.writer, { v: 1, kind: 'cursor', member: x.member, product: one.canaries.name, anchor: 'AAEC', head: 'e'.repeat(64), seq: 2 }));
    await yc.replicator.postPresence(two.cell, sealedIn(world, two, session.writer, { v: 1, kind: 'here', member: y.member, position: two.canaries.position, seq: 1 }));
    await yc.replicator.postPresence(two.cell, sealedIn(world, two, session.writer, { v: 1, kind: 'cursor', member: y.member, product: two.canaries.name, anchor: 'AAED', head: 'f'.repeat(64), seq: 2 }));
    await lead.replicator.postPresence(one.cell, sealedIn(world, one, world.lead.writer, { v: 1, kind: 'here', member: world.lead.member, seq: 1 }));
    await lead.replicator.postPresence(two.cell, sealedIn(world, two, world.lead.writer, { v: 1, kind: 'here', member: world.lead.member, seq: 1 }));
    const heard = (writer: string, cell: string): boolean => (presence.get(writer) ?? []).some((frame) => frame.cell === cell);
    await until(() => heard(world.lead.writer, one.cell) && heard(world.lead.writer, two.cell) && heard(x.writer, one.cell) && heard(session.writer, two.cell), 'the presence frames');

    // A marker everyone pulls, so every frame and page before it has been delivered.
    const marker = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional marker after the live work' } });
    assert.ok(lead.replica.add(marker.entry));
    lead.replicator.localAppended();
    await until(() => xc.replica.has(marker.hash) && yc.replica.has(marker.hash), 'X and Y hold the marker');
    for (const client of clients) await client.replicator.stop();
    const running = filesUnder(dir, 'running');
    return { hub, capture, world, x, y, session, certificate, one, two, lead, xc, yc, presence, running, root };
  } catch (error) {
    for (const client of clients) await client.replicator.stop();
    await hub.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

let built: Promise<Scene> | undefined;
const sceneOf = (): Promise<Scene> => (built ??= buildScene());
test.after(async () => {
  const scene = await built?.catch(() => undefined);
  if (scene === undefined) return;
  await scene.hub.close();
  rmSync(scene.root, { recursive: true, force: true });
});

/** Every byte the hub sent to the connections a writer authenticated on. */
const sentTo = (scene: Scene, writer: string): Place[] =>
  wireOf(scene.capture, (exchange) => scene.capture.deviceOf(exchange.socket) === writer).filter((place) => place.where.startsWith('response'));
const canaryList = (c: Compartment): string[] => [c.canaries.name, c.canaries.title, c.canaries.text, c.canaries.reason, c.canaries.position];

/** The ids and sealed bytes that would show the compartment reached a connection. */
function marks(c: Compartment): Array<{ what: string; bytes: Buffer }> {
  return [
    { what: `${c.tag} cell id`, bytes: Buffer.from(c.cell, 'utf8') },
    { what: `${c.tag} founding grant hash`, bytes: Buffer.from(grantHash(c.founding), 'utf8') },
    ...c.written.flatMap((written, index) => [
      { what: `${c.tag} entry ${index} hash`, bytes: Buffer.from(written.hash, 'utf8') },
      { what: `${c.tag} entry ${index} sealed body`, bytes: Buffer.from(written.entry.body.slice(0, 64), 'utf8') },
    ]),
    ...c.sealedPresence.map((sealed, index) => ({ what: `${c.tag} presence ${index}`, bytes: Buffer.from(sealed.slice(0, 64), 'utf8') })),
  ];
}
const found = (places: readonly Place[], c: Compartment): string[] => marks(c).filter((mark) => places.some((place) => place.bytes.includes(mark.bytes))).map((mark) => mark.what);

test('positive control: the lead opens both compartments and finds every text canary; the capture holds the connections of X, Y\'s session key and the lead', async () => {
  const scene = await sceneOf();
  const ring = scene.world.ringFor(scene.world.lead);
  for (const c of [scene.one, scene.two]) {
    const opened = c.written.map((written, index) => {
      const key = ring(written.entry.header.stream, written.entry.header.epoch);
      assert.ok(key !== undefined, `the lead holds the ${c.tag} key`);
      return { where: `${c.tag} entry ${index}`, bytes: openBody(key, written.entry.header, Buffer.from(written.entry.body, 'base64url')) ?? Buffer.alloc(0) };
    });
    for (const canary of [c.canaries.name, c.canaries.title, c.canaries.text, c.canaries.reason]) assert.ok(search(opened, canary).length > 0, `the lead finds ${canary}`);
    for (const written of c.written) assert.ok(scene.lead.replica.has(written.hash), `the lead's computer pulled ${c.tag}`);
  }
  for (const writer of [scene.world.lead.writer, scene.x.writer, scene.session.writer]) assert.ok(sentTo(scene, writer).length > 5, `the connections of ${writer.slice(0, 8)} were captured`);
  // Each person's connections did carry their own compartment, so the same marks are found where they belong.
  assert.ok(found(sentTo(scene, scene.x.writer), scene.one).includes('ONE cell id'));
  assert.ok(found(sentTo(scene, scene.session.writer), scene.two).includes('TWO cell id'));
  const toLead = sentTo(scene, scene.world.lead.writer);
  for (const c of [scene.one, scene.two]) assert.ok(found(toLead, c).includes(`${c.tag} entry 1 sealed body`), `the lead received ${c.tag}'s text`);
});

test('no canary of the other compartment, in any form, reaches X or Y; and no compartment canary is in the hub\'s state folder or any byte it received or sent', async () => {
  const scene = await sceneOf();
  assertNowhere(sentTo(scene, scene.x.writer), canaryList(scene.two), 'TWO to X');
  assertNowhere(sentTo(scene, scene.session.writer), canaryList(scene.one), 'ONE to Y');
  assertNowhere(sentTo(scene, scene.y.writer).length > 0 ? sentTo(scene, scene.y.writer) : [{ where: 'none', bytes: Buffer.alloc(0) }], canaryList(scene.one), 'ONE to Y\'s device');
  const both = [...canaryList(scene.one), ...canaryList(scene.two)];
  assertNowhere(scene.running, both, 'the hub\'s state folder');
  assertNowhere(wireOf(scene.capture), both, 'every byte the hub received or sent');
});

test('no stream id, grant, entry or presence value of the other compartment reaches X\'s or Y\'s connections (D-24 through the live path)', async () => {
  const scene = await sceneOf();
  assert.deepEqual(found(sentTo(scene, scene.x.writer), scene.two), [], 'TWO reached X');
  assert.deepEqual(found(sentTo(scene, scene.session.writer), scene.one), [], 'ONE reached Y');
  for (const written of scene.two.written) assert.equal(scene.xc.replica.has(written.hash), false);
  for (const written of scene.one.written) assert.equal(scene.yc.replica.has(written.hash), false);
});

test('presence: sealed presence and cursor messages reach only their cell\'s access list, open only under that cell\'s key, and the hub cannot open them', async () => {
  const scene = await sceneOf();
  const frames = (writer: string) => scene.presence.get(writer) ?? [];
  assert.ok(frames(scene.x.writer).every((frame) => frame.cell === scene.one.cell), 'X hears only compartment one');
  assert.ok(frames(scene.session.writer).every((frame) => frame.cell === scene.two.cell), 'Y hears only compartment two');
  const leadCells = new Set(frames(scene.world.lead.writer).map((frame) => frame.cell));
  assert.deepEqual([...leadCells].sort(), [scene.one.cell, scene.two.cell].sort());
  const roster = await scene.hub.cache.get(scene.world.project);
  for (const c of [scene.one, scene.two]) assert.equal(roster.ring(c.cell, 1), undefined, `the hub holds no key of ${c.tag}`);
  const ring = scene.world.ringFor(scene.world.lead);
  for (const frame of frames(scene.world.lead.writer)) {
    const c = frame.cell === scene.one.cell ? scene.one : scene.two;
    const other = c === scene.one ? scene.two : scene.one;
    for (const item of frame.devices as Array<{ writer: string; sealed: string }>) {
      assert.ok(c.sealedPresence.includes(item.sealed));
      const message = openPresence(ring, { cell: c.cell, writer: item.writer }, item.sealed);
      assert.ok(message !== undefined, 'the lead opens it with the cell key');
      assert.equal(openPresence((_cell, epoch) => scene.world.keyOf(other.cell, epoch), { cell: c.cell, writer: item.writer }, item.sealed), undefined, 'not with the other cell\'s key');
      assert.equal(openPresence((_cell, epoch) => roster.ring(scene.world.project, epoch), { cell: c.cell, writer: item.writer }, item.sealed), undefined, 'not with the hub\'s keys');
    }
  }
  // The positions and cursors, as plaintext, are in no byte the hub received or sent.
  assertNowhere(wireOf(scene.capture), [scene.one.canaries.position, scene.two.canaries.position], 'presence plaintext');
});

test('session.certify: Y\'s certificate travels sealed under the roster cell\'s key and carries only the session binding, nothing of either compartment', async () => {
  const scene = await sceneOf();
  const sealed = Buffer.from(scene.certificate.entry.body, 'utf8');
  const fromY = wireOf(scene.capture, (exchange) => scene.capture.deviceOf(exchange.socket) === scene.session.writer).filter((place) => place.where.startsWith('request'));
  const challenge = wireOf(scene.capture, (exchange) => exchange.path === '/v1/session').filter((place) => place.where.startsWith('request'));
  assert.ok([...fromY, ...challenge].some((place) => place.bytes.includes(sealed)), 'the certificate was sent, sealed');
  const opened = openBody(scene.world.keyOf(scene.world.project, 1), scene.certificate.entry.header, Buffer.from(scene.certificate.entry.body, 'base64url'));
  assert.ok(opened !== undefined, 'the roster cell\'s key opens it');
  const body = JSON.parse(opened.toString('utf8')) as { kind: string; data: Record<string, unknown> };
  assert.equal(body.kind, 'session.certify');
  assert.deepEqual(Object.keys(body.data).sort(), ['device', 'member', 'notAfter', 'sessionKey', 'sessionSig', 'slot']);
  const places = [{ where: 'certificate sealed', bytes: sealed }, { where: 'certificate opened', bytes: opened }];
  assertNowhere(places, [...canaryList(scene.one), ...canaryList(scene.two), scene.one.cell, scene.two.cell], 'the certificate');
  assert.equal(entryHash(scene.certificate.entry.header), scene.certificate.hash);
});
