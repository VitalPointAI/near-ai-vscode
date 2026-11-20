import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, openLabel, sealLabel, unwrapEpochKey, wrapEpochKey } from '@ext/domain/replica/cellKeys';
import type { CellGrant } from '@ext/domain/replica/cellKeys';
import { entryHash, openBlob, openBody, writerIdOf } from '@ext/domain/replica/entry';
import type { SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import type { KeyRing } from '@ext/domain/replica/rosterView';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { HubTransport, enrolmentRequest } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import type { HubMemory, SyncReport } from '@ext/staff/replica/hubSync';
import { blobsNamed } from '../src/append/rosterCache';
import { hubIdentityOf, issueHubFile } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { HealthRegistry } from '../src/health';
import { listen } from '../src/http/server';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { Logger } from '../src/log/logger';
import { Redactor } from '../src/log/redact';
import { composeHub } from '../src/main';
import type { ComposedHub } from '../src/main';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { HUB_ADDRESS, NOW_MS, createHubWorld, streamOf } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import type { MemoryReplica } from './helpers/memoryReplica';
import { makeTlsFixture } from './helpers/tlsFixture';
import type { TlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 27 (D-24, D-55, MUS-08): the hub reads only the roster and the cells granted to it. Every other cell reaches it, rests on its disk
// and leaves it only as ciphertext. The proof is a byte capture over a real session: real clients (the extension's hub transport and one-shot sync
// over memory replicas built from hub-side modules) drive the real hub in process; a wrapper on the hub server's request listener records every
// request and response byte of every connection (event stream frames included); a logger sink records every log line the binary's wiring would
// write; and every file under the state folder (database, write-ahead log, shared memory file, blob folder) is read raw while the hub runs and
// again after a clean close. Canaries are searched as UTF-8, UTF-16LE, hex, base64 and base64url (the last two at all three byte offsets), and
// every clean search is paired with a positive control that finds a canary where it was put. All names and data are fictional.

// ---- The search -------------------------------------------------------------------------------------------------------------------------------

/** One place searched: what it is (a file, a request, a log line) and its bytes. */
interface Place {
  where: string;
  bytes: Buffer;
}

interface Hit {
  where: string;
  encoding: string;
}

/** base64 and base64url forms of some bytes at each of the three byte offsets they can start at inside a longer encoded value (only the characters
 *  fully decided by those bytes are kept, so the form matches wherever the bytes sit). */
function encodedForms(bytes: Buffer, prefix = ''): Array<{ encoding: string; bytes: Buffer }> {
  const forms: Array<{ encoding: string; bytes: Buffer }> = [];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (let offset = 0; offset < 3; offset += 1) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/, '');
      const first = Math.ceil((8 * offset) / 6);
      const last = Math.floor((8 * (offset + bytes.length) - 6) / 6);
      forms.push({ encoding: `${prefix}${encoding}@${offset}`, bytes: Buffer.from(encoded.slice(first, last + 1), 'ascii') });
    }
  }
  return forms;
}

/**
 * The forms a canary takes in bytes: UTF-8, UTF-16LE, hex (both cases), base64 and base64url at all three offsets, and (beyond the plan's five)
 * each base64 or base64url form encoded once more, so text a document update carries (UTF-8 inside base64url update bytes) is found even inside a
 * body that was stored or sent without its seal.
 */
function canaryForms(value: string): Array<{ encoding: string; bytes: Buffer }> {
  const bytes = Buffer.from(value, 'utf8');
  const once = encodedForms(bytes);
  return [
    { encoding: 'utf8', bytes },
    { encoding: 'utf16le', bytes: Buffer.from(value, 'utf16le') },
    { encoding: 'hex', bytes: Buffer.from(bytes.toString('hex'), 'ascii') },
    { encoding: 'HEX', bytes: Buffer.from(bytes.toString('hex').toUpperCase(), 'ascii') },
    ...once,
    ...once.flatMap((form) => encodedForms(form.bytes, `${form.encoding} in `)),
  ];
}

/** Every place and encoding a canary is found in. */
function search(places: readonly Place[], canary: string): Hit[] {
  const forms = canaryForms(canary);
  const hits: Hit[] = [];
  for (const place of places) for (const form of forms) if (place.bytes.includes(form.bytes)) hits.push({ where: place.where, encoding: form.encoding });
  return hits;
}

/** Asserts that none of the canaries is in any of the places, naming each hit. */
function assertNowhere(places: readonly Place[], canaries: readonly string[], what: string): void {
  assert.ok(places.length > 0, `${what}: there are bytes to search`);
  const hits = canaries.flatMap((canary) => search(places, canary).map((hit) => `${canary} as ${hit.encoding} in ${hit.where}`));
  assert.deepEqual(hits, [], `${what}: a canary was found`);
}

/** Every file under a folder (recursing), its path from the folder and its bytes, the name searched with the bytes. */
function filesUnder(dir: string, label: string): Place[] {
  const out: Place[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push({ where: `${label}:${path.relative(dir, file)}`, bytes: Buffer.concat([Buffer.from(`${path.relative(dir, file)}\n`, 'utf8'), readFileSync(file)]) });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---- The hub in process, captured ---------------------------------------------------------------------------------------------------------

/** One request and its response, as the hub's request listener saw them, on one connection. */
interface Exchange {
  socket: object;
  method: string;
  path: string;
  request: Buffer[];
  response: Buffer[];
}

interface Capture {
  exchanges: Exchange[];
  /** The device that opened a session on a connection (from the session answer the hub accepted). */
  deviceOf(socket: object): string | undefined;
}

const toBuffer = (chunk: unknown, encoding?: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  return Buffer.alloc(0);
};

/**
 * Replaces the hub server's request listener with one that tees every request (method, path, headers and each body chunk as the hub's own reader
 * receives it) and every response (status, headers, and each chunk given to write and end, event stream frames included) before passing both on.
 */
function captureServer(server: https.Server): Capture {
  const listeners = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  assert.equal(listeners.length, 1, 'the hub has one request listener');
  server.removeAllListeners('request');
  const exchanges: Exchange[] = [];
  const devices = new WeakMap<object, string>();
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const exchange: Exchange = { socket: req.socket, method: req.method ?? '', path: (req.url ?? '').split('?')[0] as string, request: [], response: [] };
    exchanges.push(exchange);
    exchange.request.push(Buffer.from(`${req.method ?? ''} ${req.url ?? ''}\n${req.rawHeaders.join('\n')}\n\n`, 'utf8'));
    const emit = req.emit.bind(req);
    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'data') exchange.request.push(toBuffer(args[0]));
      return emit(event, ...args);
    }) as typeof req.emit;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.write = ((...args: unknown[]): boolean => {
      exchange.response.push(toBuffer(args[0], args[1]));
      return write(...args);
    }) as typeof res.write;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.end = ((...args: unknown[]): http.ServerResponse => {
      if (typeof args[0] !== 'function') exchange.response.push(toBuffer(args[0], args[1]));
      return end(...args);
    }) as typeof res.end;
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.writeHead = ((...args: unknown[]): http.ServerResponse => {
      exchange.response.push(Buffer.from(`${String(args[0])}\n${JSON.stringify(args.slice(1))}\n`, 'utf8'));
      return writeHead(...args);
    }) as typeof res.writeHead;
    res.on('finish', () => {
      exchange.response.push(Buffer.from(`${JSON.stringify(res.getHeaders())}\n`, 'utf8'));
      // A session answer the hub accepted names the device of this connection.
      if (exchange.path === '/v1/session' && res.statusCode === 200) {
        try {
          const body = JSON.parse(Buffer.concat(exchange.request.slice(1)).toString('utf8')) as { answer?: { signer?: { publicKey?: unknown } } };
          const publicKey = body.answer?.signer?.publicKey;
          if (typeof publicKey === 'string') devices.set(req.socket, writerIdOf(publicKey));
        } catch {
          // A challenge call: no device yet.
        }
      }
    });
    for (const listener of listeners) listener.call(server, req, res);
  });
  return { exchanges, deviceOf: (socket) => devices.get(socket) };
}

interface CapturedHub {
  port: number;
  dir: string;
  identity: HubIdentity;
  store: HubStore;
  composed: ComposedHub;
  capture: Capture;
  logLines: string[];
  logger: Logger;
  now(): number;
  advance(ms: number): void;
  /** The state folder read raw now (the hub running: the write-ahead log and shared memory file are there). */
  snapshot(label: string): Place[];
  /** Stops the hub cleanly (as the binary's stop does), then reads the state folder raw once more. */
  close(): Promise<Place[]>;
  /** Removes the state folder and the TLS fixture. */
  cleanup(): void;
}

/** The hub as the binary composes it, with the binary's log wiring onto a Logger whose sink records every line, and the capture on its server. */
async function startCapturedHub(): Promise<CapturedHub> {
  const tls: TlsFixture = makeTlsFixture();
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-capture-'));
  const dir = path.join(root, 'state');
  mkdirSync(dir, { mode: 0o700 });
  const store = await openHubStore(dir);
  const signing = readSigningKey(generateKeyFile('signing'));
  const identity = hubIdentityOf(signing, readEncryptionKey(generateKeyFile('encryption'), signing), tls.certPem, HUB_ADDRESS);
  let clock = NOW_MS;
  const logLines: string[] = [];
  const logger = new Logger(new Redactor(), (line) => logLines.push(line), () => clock);
  const health = new HealthRegistry({ version: '0.0.0-test', startedAt: clock, now: () => clock });
  // The same hooks main.ts wires for the binary.
  const composed = composeHub({
    store,
    identity,
    tls: { cert: tls.certPem, key: tls.keyPem },
    health,
    now: () => clock,
    onFailure: (route, error) => logger.error('http.failed', { route, name: error instanceof Error ? error.name : 'NonError' }),
    onCheckpointLog: (level, event, fields) => logger[level](event, fields),
    onJoinLog: (level, event, fields) => logger[level](event, fields),
    onRejected: (route, method, status) => {
      const fields = { route, method, status };
      if (status >= 500) logger.error('http.rejected', fields);
      else logger.warn('http.rejected', fields);
    },
  });
  const capture = captureServer(composed.server);
  const port = await listen(composed.server, '127.0.0.1', 0);
  let closed = false;
  return {
    port,
    dir,
    identity,
    store,
    composed,
    capture,
    logLines,
    logger,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    snapshot: (label) => filesUnder(dir, label),
    async close() {
      if (!closed) {
        closed = true;
        composed.checkpoints?.stop();
        await composed.checkpoints?.settled();
        composed.join.stop();
        composed.events.closeAll();
        composed.presence.close();
        composed.sessions.close();
        composed.server.closeAllConnections();
        await new Promise<void>((resolve) => composed.server.close(() => resolve()));
        store.close();
      }
      return filesUnder(dir, 'closed');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}

/** Every byte the hub received or sent at the application layer, one place per request and one per response. */
function wireOf(capture: Capture, filter: (exchange: Exchange) => boolean = () => true): Place[] {
  return capture.exchanges.filter(filter).flatMap((exchange, index) => [
    { where: `request ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.request) },
    { where: `response ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.response) },
  ]);
}

const logsOf = (hub: CapturedHub): Place[] => hub.logLines.map((line, index) => ({ where: `log line ${index}`, bytes: Buffer.from(line, 'utf8') }));

// ---- Clients ----------------------------------------------------------------------------------------------------------------------------------

/** The keys a device can open from the grants it holds. */
function ringFromGrants(grants: ReadonlyArray<{ signed: unknown }>, device: WorldDevice): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const { signed } of grants) {
    const payload = (signed as SignedPayload<CellGrant>).payload;
    const mine = payload.wraps.find((item) => item.writer === device.writer);
    if (mine === undefined) continue;
    const key = unwrapEpochKey({ cell: payload.cell, epoch: payload.epoch, writer: device.writer, privateKey: device.x25519Private, wrap: mine.wrap });
    if (key !== undefined) keys.set(`${payload.cell}/${payload.epoch}`, key);
  }
  return (stream, epoch) => keys.get(`${stream}/${epoch}`);
}

/**
 * A person's computer: a memory replica that starts with the entries and grants the device was handed when it joined (no blob of anyone else), and
 * that, like the extension's ReplicaProject, names the blobs its own entries cite when it pushes and the blobs it is missing when it pulls. It opens
 * only what its own grants open.
 */
interface Client extends MemoryReplica {
  device: WorldDevice;
  ring(): Promise<KeyRing>;
  /** Every body and blob this computer can open, as plaintext, with the stream it came from. */
  opened(): Promise<Array<{ stream: string; text: string }>>;
}

function clientOf(world: HubWorld, device: WorldDevice, entries: readonly SealedEntry[], grants: ReadonlyArray<SignedPayload<CellGrant>>): Client {
  const base = memoryReplica({ ...world, grants: [...grants], blobs: new Map<string, SealedBlob>() }, device, entries);
  const ring = async (): Promise<KeyRing> => ringFromGrants(await base.grants(), device);
  const cited = async (list: readonly SealedEntry[]): Promise<Array<{ entry: string; blob: string; stream: string; epoch: number }>> => {
    const keys = await ring();
    const out: Array<{ entry: string; blob: string; stream: string; epoch: number }> = [];
    for (const entry of list) {
      for (const blob of blobsNamed([entry], keys)) out.push({ entry: hashOfEntry(entry), blob, stream: entry.header.stream, epoch: entry.header.epoch });
    }
    return out;
  };
  return {
    ...base,
    device,
    ring,
    async blobsCitedBy(hashes) {
      const wanted = new Set(hashes);
      return (await cited(base.all().filter((entry) => wanted.has(hashOfEntry(entry))))).map(({ entry, blob }) => ({ entry, blob }));
    },
    async wantedBlobs() {
      const missing: string[] = [];
      for (const item of await cited(base.all())) if ((await base.blob(item.blob)) === undefined) missing.push(item.blob);
      return missing;
    },
    async opened() {
      const keys = await ring();
      const out: Array<{ stream: string; text: string }> = [];
      for (const entry of base.all()) {
        const key = keys(entry.header.stream, entry.header.epoch);
        if (key === undefined) continue;
        const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
        if (plain !== undefined) out.push({ stream: entry.header.stream, text: plain.toString('utf8') });
      }
      for (const item of await cited(base.all())) {
        const key = keys(item.stream, item.epoch);
        const blob = await base.blob(item.blob);
        if (key === undefined || blob === undefined) continue;
        const plain = openBlob(key, item.stream, item.epoch, blob);
        if (plain !== undefined) out.push({ stream: item.stream, text: plain.toString('utf8') });
      }
      return out;
    },
  };
}

const hashOfEntry = (entry: SealedEntry): string => entryHash(entry.header);

/** The grants a device holds when it joins: the ones wrapped to it so far. */
const grantsTo = (world: HubWorld, device: WorldDevice): Array<SignedPayload<CellGrant>> => world.grants.filter((grant) => grant.payload.wraps.some((wrap) => wrap.writer === device.writer));
const baseEntries = (world: HubWorld): SealedEntry[] => world.entries.filter((entry) => entry.header.stream === world.project);

/** A write by a device, kept on its own computer (its blob too), as the extension keeps what it writes before any sync. */
function writeOn(world: HubWorld, client: Client, options: Parameters<HubWorld['write']>[1]): Written {
  const written = world.write(client.device, options);
  assert.ok(client.add(written.entry), 'the writer keeps its own entry');
  return written;
}

async function keepBlobs(client: Client, written: Written): Promise<void> {
  await client.ingest([], written.blobs);
}

function transportFor(hub: CapturedHub, world: HubWorld, device: WorldDevice): HubTransport {
  return new HubTransport({
    address: `127.0.0.1:${hub.port}`,
    project: world.project,
    hub: hub.identity.writer,
    trust: { pin: hub.identity.certPin },
    signer: device.signer,
    servername: 'localhost',
    now: () => new Date(hub.now()),
  });
}

const memories = new Map<string, HubMemory>();

/** One exchange of the device's computer with the hub, as the extension runs it. */
async function sync(hub: CapturedHub, world: HubWorld, client: Client): Promise<SyncReport> {
  // The checkpoint ask at the end of each exchange signs at once only when 10 seconds have passed since the last ask that signed (D-45).
  hub.advance(11_000);
  let memory = memories.get(client.device.writer);
  if (memory === undefined) {
    memory = hubMemoryOf(new MemorySecrets());
    memories.set(client.device.writer, memory);
  }
  const transport = transportFor(hub, world, client.device);
  try {
    const report = await syncOnce(transport, client, memory, { now: () => new Date(hub.now()) });
    assert.equal(report.outcome, 'synced', JSON.stringify(report));
    return report;
  } finally {
    transport.close();
    await hub.composed.checkpoints?.settled();
  }
}

/** Issues a hub file and enrols the project from the lead's computer, as connectProjectToHub does. */
async function enrol(hub: CapturedHub, world: HubWorld, lead: Client): Promise<void> {
  const issued = issueHubFile(hub.store, hub.identity, { days: 7, now: new Date(hub.now()) });
  assert.ok(issued.ok, issued.ok ? '' : issued.message);
  const body = await enrolmentRequest(lead, issued.file.payload, { genesisHash: world.genesisHash, rosterHead: world.head });
  const transport = transportFor(hub, world, world.lead);
  try {
    await transport.enrol(body);
  } finally {
    transport.close();
  }
}

/** A label cell whose founding grant carries its sealed label (as labelCells.ts makes one), wrapped to the given devices. */
function sealedLabelCell(world: HubWorld, name: string, token: string, to: ReadonlyArray<{ writer: string; x25519: string }>): { cell: string; key: Buffer; founding: SignedPayload<CellGrant>; entry: Written; label: unknown } {
  const cell = streamOf(`cell/${name}`);
  const key = world.keyOf(cell, 1);
  const label = { scale: 'org', level: 'Confidential', compartments: [token], releasability: [], handling: [] };
  const wraps = to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch: 1, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
  const founding = buildGrant(world.lead.signer, { cell, epoch: 1, roster: world.head, labelSealed: sealLabel(key, cell, 1, label), wraps });
  world.grants.push(founding);
  const entry = world.rosterEntry(world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) });
  return { cell, key, founding, entry, label };
}

// ---- Canaries and product shapes ------------------------------------------------------------------------------------------------------------

const ROLES = { owner: 'j2-analyst', sectionLead: 'j2-lead', releaseGuard: 'j2-guard' };
const VERSION_HASH = createHash('sha256').update('fictional version of the product', 'utf8').digest('hex');

/** The canaries of one cell, in the places a product carries text. Fictional strings, distinct per cell. */
interface Canaries {
  name: string;
  title: string;
  text: string;
  label: string;
  reason: string;
  blob: string;
}

const canariesOf = (tag: string): Canaries => ({
  name: `canary-${tag.toLowerCase()}-name-7f3a`,
  title: `CANARY-${tag}-TITLE-91c2`,
  text: `CANARY-${tag}-TEXT-4be8`,
  label: `CANARY-${tag}-LABEL-0d57`,
  reason: `CANARY-${tag}-REASON-c3a9`,
  blob: `CANARY-${tag}-BLOB-58e1`,
});

/** Update bytes as a document update carries them: a few structure bytes, then the inserted text as UTF-8. */
const updateBytes = (text: string): string => Buffer.concat([Buffer.from([1, 1, 0xb4, 0x9e, 0xc1, 0x07, 0, 4]), Buffer.from(text, 'utf8')]).toString('base64url');

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------

test('tracer: a product in a cell not granted to the hub reaches it, member B opens it, and its canaries are in no state folder byte, wire byte or log line', async () => {
  const hub = await startCapturedHub();
  try {
    const u1 = canariesOf('T1');
    const world = createHubWorld({ causalLamport: true });
    world.admitHub(hub.identity);
    const a = world.device('MEMBER-A', 'mbr-a');
    const b = world.device('MEMBER-B', 'mbr-b');
    world.admitMember(a);
    world.admitMember(b);
    const cell = sealedLabelCell(world, 'tracer-u1', u1.label, [world.lead, a, b]);
    const lead = clientOf(world, world.lead, world.entries, world.grants);
    await enrol(hub, world, lead);
    const clientA = clientOf(world, a, baseEntries(world), grantsTo(world, a));
    const clientB = clientOf(world, b, baseEntries(world), grantsTo(world, b));

    writeOn(world, clientA, { stream: cell.cell, kind: 'product.create', data: { product: u1.name, section: 'j2', roles: ROLES, title: u1.title } });
    writeOn(world, clientA, { stream: cell.cell, kind: 'doc.update', data: { product: u1.name, update: updateBytes(`Fictional patrol summary. ${u1.text}.`) } });
    const pushed = await sync(hub, world, clientA);
    assert.equal(pushed.pushed, 2);
    const pulled = await sync(hub, world, clientB);
    assert.equal(pulled.pulled, 2);

    // The hub holds the cell's entries: the capture saw their ciphertext arrive and leave.
    const sent = hub.store.entriesFrom(world.project, cell.cell, a.writer, 0, { limit: 10, maxBytes: 1 << 20 }).entries;
    assert.equal(sent.length, 2, 'the hub stored both entries');
    const wire = wireOf(hub.capture);
    for (const row of sent) assert.ok(wire.some((place) => place.where.startsWith('request') && place.bytes.includes(Buffer.from(row.body, 'utf8'))), 'the capture saw the sealed body arrive');
    for (const row of sent) assert.ok(wire.some((place) => place.where.startsWith('response') && place.bytes.includes(Buffer.from(row.body, 'utf8'))), 'the capture saw the sealed body leave');

    const running = hub.snapshot('running');
    assert.ok(running.some((place) => place.where.endsWith('-wal')), 'the write-ahead log was read while the hub ran');
    const closed = await hub.close();
    const all = [u1.name, u1.title, u1.text, u1.label];
    assertNowhere([...running, ...closed], all, 'state folder');
    assertNowhere(wire, all, 'application layer');
    assertNowhere(logsOf(hub), all, 'log lines');
    assert.ok(hub.logLines.length > 0, 'the logger recorded lines');

    // The scenario carried the canaries: B opens both entries with the cell's key and finds them.
    const opened = (await clientB.opened()).filter((item) => item.stream === cell.cell).map((item) => ({ where: 'B opened', bytes: Buffer.from(item.text, 'utf8') }));
    for (const canary of [u1.name, u1.title, u1.text]) assert.ok(search(opened, canary).length > 0, `B finds ${canary}`);
    const labelKey = (await clientB.ring())(cell.cell, 1);
    assert.ok(labelKey !== undefined, 'B holds the cell key');
    assert.deepEqual(openLabel(labelKey, cell.cell, 1, cell.founding.payload.labelSealed), cell.label, 'B opens the sealed label with its token');
  } finally {
    await hub.close();
    hub.cleanup();
  }
});

test('positive control: a canary planted in each of the five encodings in the state folder, a captured request and a log line is found where it was put', async () => {
  const hub = await startCapturedHub();
  try {
    const plant = 'CANARY-PLANT-CONTROL-6a1d';
    const forms = canaryForms(plant);
    // The state folder: one file per encoding, each holding the canary at a different offset inside other bytes.
    const plantDir = path.join(hub.dir, 'plant');
    mkdirSync(plantDir);
    const b64url = (text: Buffer): Buffer => Buffer.from(text.toString('base64url'), 'ascii');
    const planted = [
      { file: 'utf8', bytes: Buffer.from(`x${plant}y`, 'utf8'), encoding: /^utf8$/ },
      { file: 'utf16le', bytes: Buffer.from(`xy${plant}`, 'utf16le'), encoding: /^utf16le$/ },
      { file: 'hex', bytes: Buffer.from(`00${Buffer.from(plant).toString('hex')}ff`, 'ascii'), encoding: /^hex$/ },
      { file: 'base64', bytes: Buffer.from(Buffer.concat([Buffer.from('a'), Buffer.from(plant)]).toString('base64'), 'ascii'), encoding: /^base64@1$/ },
      { file: 'base64url', bytes: b64url(Buffer.concat([Buffer.from('ab'), Buffer.from(plant)])), encoding: /^base64url@2$/ },
      { file: 'nested', bytes: b64url(Buffer.concat([Buffer.from('{"u":"'), b64url(Buffer.concat([Buffer.from('xyz'), Buffer.from(plant)]))])), encoding: / in base64url@/ },
    ];
    for (const item of planted) writeFileSync(path.join(plantDir, item.file), item.bytes);
    const disk = hub.snapshot('running');
    for (const item of planted) {
      const hits = search(disk, plant).filter((hit) => hit.where === `running:plant/${item.file}`);
      assert.ok(hits.some((hit) => item.encoding.test(hit.encoding)), `the ${item.file} plant is found as ${String(item.encoding)}: ${JSON.stringify(hits)}`);
    }
    assert.equal(forms.length, 4 + 6 + 36, 'utf8, utf16le, two hex cases, six base64 forms and each of them encoded once more');

    // A captured request: the canary in plain text in a body the hub refuses, and in base64url in a header.
    const world = createHubWorld();
    const transport = transportFor(hub, world, world.lead);
    await assert.rejects(transport.enrol({ enrolment: plant }));
    transport.close();
    const wire = wireOf(hub.capture);
    assert.ok(search(wire, plant).some((hit) => hit.where.startsWith('request') && hit.encoding === 'utf8'), 'the plant is found in the captured request');
    assert.ok(search(wire, plant).every((hit) => hit.where.startsWith('request')), 'the hub did not echo it');

    // A log line written through the same logger.
    hub.logger.info('test.plant', { detail: plant });
    assert.ok(search(logsOf(hub), plant).length > 0, 'the plant is found in the log lines');
    // And a clean search over the same places finds a canary that was never written.
    const never = 'CANARY-NEVER-WRITTEN-2f0b';
    assertNowhere([...disk, ...wire, ...logsOf(hub)], [never], 'a canary never written');
  } finally {
    await hub.close();
    hub.cleanup();
  }
});
