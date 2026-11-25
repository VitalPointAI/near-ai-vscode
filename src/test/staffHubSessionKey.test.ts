// A hosted session talks to your organization's server with the person's session key (Phase 33 plan 22 task 3; D-61, D-62). The client signs the
// session with the session key and names and carries the certificate; its first exchange pushes the certificate (a device's entry in the base
// stream) before the session key's own entries; another member pulls and folds the session's text as the person's; and an ended session key is
// refused with its own sentence, never attention and never looked at again. The real-hub test follows the D-46 rule. Fictional people and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { entryHash } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { buildSessionAnswer, readSessionAnswer } from '../domain/replica/hubFile';
import { sessionCertifyData } from '../domain/replica/sessionKeys';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { refusalSentence } from '../domain/staff/liveSentences';
import { SESSION_EXPIRED_SENTENCE, hubMemoryOf, syncOnce } from '../staff/replica/hubSync';
import type { SyncTransport } from '../staff/replica/hubSync';
import { HubTransport, HubTransportError } from '../staff/replica/hubTransport';
import type { AppendBatch } from '../staff/replica/hubTransport';
import { ReplicaProject, syncLocalOf } from '../staff/replica/replicaProject';
import { hubNodeOrSkip, startHubChild } from './helpers/hubChild';
import { MemorySecrets, leadWith, project } from './helpers/labelCellWorld';
import { createLiveWorld } from './helpers/liveWorld';
import type { LiveDevice } from './helpers/liveWorld';
import { fixedSigner } from './helpers/replicaWorld';
import type { FixedSigner } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const TEXT = 'Enemy forces hold the bridge.';
const HOUR = 60 * 60 * 1000;

/** The person's device certifies a fresh session key for this project; the session key signs its binding. */
async function certifySession(p: ReplicaProject, member: string, session: FixedSigner, now: Date): Promise<{ entry: SealedEntry; slot: number }> {
  const { roster } = await p.state();
  const slot = roster.members.devices.get(p.deviceWriter)?.find((record) => record.slot !== undefined)?.slot as number;
  const data = sessionCertifyData({ project: p.projectId, member, device: p.deviceWriter, sessionKey: session.publicKey, slot, notAfter: new Date(now.getTime() + 12 * HOUR).toISOString() }, (bytes) => session.signer.sign(bytes));
  const written = await p.appendOwn('session.certify', data);
  assert.ok('ok' in written, 'ok' in written ? undefined : written.message);
  return { entry: written.built.entry, slot };
}

/** The hosted session types the text into the product with a client id from the certificate's slot. */
async function sessionTypes(hosted: ReplicaProject, slot: number, text = TEXT): Promise<string[]> {
  const clientId = clientIdOf(slot, 0);
  const client = await hosted.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } });
  const update = await hosted.appendOwn('doc.update', { product: PRODUCT, update: Buffer.from(localInsert(createLocalDoc(clientId), 0, text)).toString('base64url') });
  assert.ok('ok' in client && 'ok' in update);
  return [client.hash, update.hash];
}

/** A session key whose writer id sorts before the device's, so pushing devices first is a real rule and not the alphabet. */
function sessionKeyBefore(writer: string): FixedSigner {
  for (let index = 0; ; index += 1) {
    const candidate = fixedSigner(`HOSTED-SESSION-${index}`);
    if (candidate.writer < writer) return candidate;
  }
}

test('over a real hub: the session key signs the session and names its certificate, the first push carries the certificate before the session\'s entries, and another member folds the text as the person\'s', async (t) => {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  try {
    const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }], hub: { fileText: await server.hubFileText() } });
    const transports: HubTransport[] = [];
    try {
      const [a, b] = world.devices as [LiveDevice, LiveDevice];
      const hub = world.hub as NonNullable<typeof world.hub>;
      const transportFor = (signer: FixedSigner['signer'], extra: { certificate?: SealedEntry } = {}): HubTransport => {
        const made = new HubTransport({ address: hub.address, project: a.project.projectId, hub: hub.writer, trust: { pin: hub.certPin }, signer, ...extra });
        transports.push(made);
        return made;
      };
      // The person's roster is at your organization's server already (the certificate cites it), as it is when a hosted session starts.
      const before = await syncOnce(transportFor(a.project.signer), a.local, a.memory);
      assert.equal(before.outcome, 'synced', JSON.stringify(before));
      const session = sessionKeyBefore(a.project.deviceWriter);
      const { entry: certificate, slot } = await certifySession(a.project, a.member, session, new Date());
      const hosted = project(await ReplicaProject.open(a.at.root, { ...a.at.deps, sessionSigner: session.signer }));
      const written = await sessionTypes(hosted, slot);
      const sessionTransport = transportFor(session.signer, { certificate });
      const appended: AppendBatch[] = [];
      const send = sessionTransport.append.bind(sessionTransport);
      sessionTransport.append = (batch, blob) => { appended.push(batch); return send(batch, blob); };
      const report = await syncOnce(sessionTransport, syncLocalOf(hosted), hubMemoryOf(new MemorySecrets()));
      assert.equal(report.outcome, 'synced', JSON.stringify(report));
      assert.deepEqual(report.refusedByHub, []);
      const order = appended.flatMap((batch) => batch.entries.map((entry) => entryHash(entry.header)));
      assert.ok(order.includes(entryHash(certificate.header)), 'the certificate was pushed');
      for (const hash of written) assert.ok(order.indexOf(entryHash(certificate.header)) < order.indexOf(hash), 'the certificate goes before the session key\'s entries');

      const pulled = await syncOnce(transportFor(b.project.signer), b.local, b.memory);
      assert.equal(pulled.outcome, 'synced', JSON.stringify(pulled));
      const { fold } = await b.project.state();
      const product = ((fold.families.doc as ProductTextOutput[] | undefined) ?? []).find((item) => item.product === PRODUCT);
      assert.equal(product?.text, TEXT);
      assert.deepEqual(product?.attribution.map((span) => [span.writer, span.member]), [[session.writer, a.member]]);
    } finally {
      for (const transport of transports) transport.close();
      await world.close();
    }
  } finally {
    await server.dispose();
  }
});

test('session-expired from your organization\'s server ends the exchange refused with its sentence, never attention, and the live state words say the same', async () => {
  const lead = await leadWith();
  const local = syncLocalOf(lead.p);
  const hub = fixedSigner('SESSION-EXPIRED-HUB');
  const transport = {
    project: lead.p.projectId,
    hub: hub.writer,
    hubHeads: () => Promise.resolve({ project: lead.p.projectId, rosterHead: 'e'.repeat(64), streams: [], grants: [] }),
    entries: (stream: string, writer: string) => Promise.resolve({ project: lead.p.projectId, stream, writer, entries: [], more: false, head: null }),
    append: () => Promise.reject(new HubTransportError('session-refused', { status: 403, reason: 'session-expired' })),
    getBlob: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    grant: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    askCheckpoint: () => Promise.resolve({ project: lead.p.projectId, kept: 0 })
  } as unknown as SyncTransport;
  const report = await syncOnce(transport, local, hubMemoryOf(new MemorySecrets()));
  assert.deepEqual([report.outcome, report.reason, report.message], ['refused', 'session-expired', SESSION_EXPIRED_SENTENCE]);
  assert.equal(SESSION_EXPIRED_SENTENCE, 'Your session key has ended. Sign in again.');
  assert.equal(refusalSentence('session-expired'), SESSION_EXPIRED_SENTENCE);
});

test('the session answer: a session key names and carries its certificate, a device\'s answer carries neither, and a certificate that is not the entry it names is malformed', () => {
  const device = fixedSigner('ANSWER-DEVICE');
  const session = fixedSigner('ANSWER-SESSION');
  const hub = 'a'.repeat(64);
  const project = 'b'.repeat(32);
  const expectation = { hub, project, challenge: Buffer.alloc(32, 1), keying: Buffer.alloc(32, 2) };
  const now = new Date('2026-11-24T10:00:00.000Z');
  const certificate: SealedEntry = { header: { v: 2, stream: project, writer: device.writer, seq: 3, prev: 'c'.repeat(64), epoch: 1, body: { hash: 'd'.repeat(64), size: 60 }, sig: Buffer.alloc(64, 5).toString('base64url') }, body: Buffer.alloc(60, 6).toString('base64url') };
  const plain = buildSessionAnswer(device.signer, { ...expectation, features: ['cells@1'], now });
  assert.deepEqual(Object.keys(plain.payload).sort(), ['challenge', 'features', 'hub', 'keying', 'project', 'v']);
  const read = readSessionAnswer(JSON.parse(JSON.stringify(plain)), expectation);
  assert.ok(read.ok && read.certificate === undefined && read.certificateEntry === undefined);
  const certified = buildSessionAnswer(session.signer, { ...expectation, features: ['cells@1'], certificateEntry: certificate, now });
  const readCertified = readSessionAnswer(JSON.parse(JSON.stringify(certified)), expectation);
  assert.ok(readCertified.ok);
  assert.equal(readCertified.writer, session.writer);
  assert.equal(readCertified.certificate, entryHash(certificate.header));
  assert.deepEqual(readCertified.certificateEntry, certificate);
  // A payload whose certificate is not the hash of the entry it carries is malformed, before any signature is checked.
  const forged = { ...certified, payload: { ...certified.payload, certificate: 'e'.repeat(64) } };
  const readForged = readSessionAnswer(JSON.parse(JSON.stringify(forged)), expectation);
  assert.equal(readForged.ok ? 'ok' : readForged.reason, 'malformed');
});

test('a hosted session pushes the person\'s device entries (the certificate among them) before the session key\'s own, whatever their writer ids', async () => {
  const lead = await leadWith();
  const session = sessionKeyBefore(lead.p.deviceWriter);
  const { entry: certificate, slot } = await certifySession(lead.p, lead.member, session, lead.at.clock.now);
  const hosted = project(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, sessionSigner: session.signer }));
  const written = await sessionTypes(hosted, slot);
  const appended: AppendBatch[] = [];
  const transport = {
    project: lead.p.projectId,
    hub: fixedSigner('PUSH-ORDER-HUB').writer,
    hubHeads: () => Promise.resolve({ project: lead.p.projectId, rosterHead: 'e'.repeat(64), streams: [], grants: [] }),
    entries: (stream: string, writer: string) => Promise.resolve({ project: lead.p.projectId, stream, writer, entries: [], more: false, head: null }),
    append: (batch: AppendBatch) => { appended.push(batch); return Promise.resolve({ project: lead.p.projectId, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: 'e'.repeat(64), blobsPut: false }); },
    getBlob: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    grant: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    askCheckpoint: () => Promise.resolve({ project: lead.p.projectId, kept: 0 })
  } as unknown as SyncTransport;
  await syncOnce(transport, syncLocalOf(hosted), hubMemoryOf(new MemorySecrets()), { now: () => lead.at.clock.now });
  const order = appended.flatMap((batch) => batch.entries);
  const lastDevice = order.map((entry) => entry.header.writer).lastIndexOf(lead.p.deviceWriter);
  const firstSession = order.findIndex((entry) => entry.header.writer === session.writer);
  assert.ok(firstSession >= 0 && lastDevice >= 0);
  assert.ok(lastDevice < firstSession, 'every device entry goes before the first session key entry');
  assert.ok(order.some((entry) => entryHash(entry.header) === entryHash(certificate.header)));
  assert.deepEqual(order.filter((entry) => entry.header.writer === session.writer).map((entry) => entryHash(entry.header)), written);
});
