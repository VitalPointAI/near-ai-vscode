// Hostile headers and bodies through the real verifier and fold (plan 30-04, task 1). Every hostile shape must land in exactly one result list with a
// named reason and must never throw. Hostile JSON for prototype keys comes from JSON.parse text, because an object literal would not make an own
// __proto__ key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { GENESIS_PREV, INLINE_BODY_MAX_BYTES, buildEntry, entryHash, headerAad, openBody, prepareEntrySigning, sealBody, sha256Hex, signHeader, verifyHeader } from '../domain/replica/entry';
import type { BuildEntryInput, EntryHeader, SealedBlob, SealedEntry, UnsignedHeader } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { staticRosterView } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifyOutcome } from '../domain/replica/verify';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { WORLD_AT, createWorld, fixedSigner, rng } from './helpers/replicaWorld';
import type { Rng, World } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function twoWriters(): World {
  return createWorld({ members: [{ member: 'mbr-aaaa', name: 'Ada', devices: ['A'] }, { member: 'mbr-bbbb', name: 'Bo', devices: ['B'] }] });
}

// An entry whose body is exactly the given plaintext bytes, sealed and signed correctly, so only the plaintext can be at fault.
function forge(world: World, writerName: string, plaintext: Buffer, place: { seq?: number; prev?: string; epoch?: number; stream?: string } = {}): SealedEntry {
  const fixed = world.signerOf(writerName);
  const stream = place.stream ?? world.stream;
  const epoch = place.epoch ?? 0;
  const seq = place.seq ?? 0;
  const prev = place.prev ?? GENESIS_PREV;
  const wire = sealBody(world.keyFor(stream, epoch), { stream, writer: fixed.writer, seq, prev, epoch }, plaintext);
  const header = signHeader(fixed.signer, { v: 2, stream, writer: fixed.writer, seq, prev, epoch, body: { hash: sha256Hex(wire), size: wire.length } });
  return { header, body: wire.toString('base64url') };
}

function goodBody(world: World): Record<string, unknown> {
  return { deps: [], roster: world.rosterHash, lamport: 1, at: WORLD_AT, actor: { kind: 'person' }, kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } };
}

const asBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

function rejectedReason(outcome: VerifyOutcome): string {
  assert.equal(outcome.status, 'rejected', JSON.stringify(outcome).slice(0, 200));
  return outcome.status === 'rejected' ? outcome.reason : '';
}

function productsOf(result: FoldResult): ProductTextOutput[] {
  return result.families.doc as ProductTextOutput[];
}

test('prepared roster signing fixes one sealed body and blob and rejects a different artifact', () => {
  const world = twoWriters();
  const signer = world.signerOf('A').signer;
  const data = { cell: world.stream, epoch: 2, grant: HASH_A, reason: 'device-revoked', detail: 'X'.repeat(INLINE_BODY_MAX_BYTES) };
  const input: BuildEntryInput = { signer, stream: world.stream, seq: 0, prev: GENESIS_PREV, epoch: 0, key: world.keyFor(world.stream, 0),
    body: { deps: [], roster: world.rosterHash, lamport: 1, at: WORLD_AT, actor: { kind: 'person' }, kind: 'cell.rekey', data } };
  const candidate = prepareEntrySigning(input);
  assert.ok(candidate);
  const first = candidate.signingBytes();
  const wrong = prepareEntrySigning({ ...input, body: { ...input.body, data: { ...data, grant: HASH_B } } });
  assert.ok(wrong);
  assert.equal(candidate.finish(signer.sign(wrong.signingBytes())), undefined);
  data.grant = HASH_B;
  candidate.signingBytes().fill(0);
  assert.equal(candidate.signingBytes().equals(first), true);
  const built = candidate.finish(signer.sign(first));
  assert.ok(built);
  assert.equal(verifyHeader(built.entry.header, signer.publicKey), true);
  assert.equal(built.blobs.length, 1);
  assert.equal(candidate.matches(built), true);
  const replacement = wrong.finish(signer.sign(wrong.signingBytes()));
  assert.ok(replacement);
  assert.equal(candidate.matches({ ...built, entry: { ...built.entry, body: replacement.entry.body } }), false);
  assert.equal(candidate.matches({ ...built, blobs: [{ ...built.blobs[0], bytes: 'changed' }] }), false);
});

// ---- headers ----

test('an unknown header version is rejected unknown-header-version, whatever else the header holds', () => {
  const world = twoWriters();
  const written = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  for (const version of [1, 3, 99, 0, -2]) {
    const header = { ...written.entry.header, v: version };
    assert.equal(rejectedReason(verifyEntry({ header, body: written.entry.body }, world.ctx())), 'unknown-header-version', `v ${version}`);
  }
  for (const version of ['2', 2.5, null, undefined, true, [2]]) {
    const header = { ...written.entry.header, v: version };
    assert.equal(rejectedReason(verifyEntry({ header, body: written.entry.body }, world.ctx())), 'malformed-header', `v ${String(version)}`);
  }
  const folded = foldEntries([{ header: { ...written.entry.header, v: 3 }, body: written.entry.body }], world.ctx());
  assert.deepEqual(folded.rejected.map((item) => item.reason), ['unknown-header-version']);
  assert.deepEqual([folded.applied, folded.held, folded.kept], [[], [], []]);
});

test('headers with an extra key, a missing key, a prototype key, a bad integer, a bad id pattern or a huge extra field are rejected and never throw', () => {
  const world = twoWriters();
  const written = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  const header = written.entry.header;
  const text = JSON.stringify(header);
  const mutations: Array<[string, unknown]> = [
    ['extra key', { ...header, extra: 1 }],
    ['prototype key', JSON.parse(text.replace('{', '{"__proto__":{"admin":true},')) as unknown],
    ['constructor key', JSON.parse(text.replace('{', '{"constructor":{"prototype":{}},')) as unknown],
    ['seq -1', { ...header, seq: -1 }],
    ['seq 2^53', { ...header, seq: 2 ** 53 }],
    ['seq 1.5', { ...header, seq: 1.5 }],
    ['seq text', { ...header, seq: '0' }],
    ['epoch -1', { ...header, epoch: -1 }],
    ['epoch NaN as text', { ...header, epoch: 'NaN' }],
    ['31-hex stream', { ...header, stream: header.stream.slice(1) }],
    ['uppercase stream', { ...header, stream: header.stream.toUpperCase() === header.stream ? 'A'.repeat(32) : header.stream.toUpperCase() }],
    ['63-hex writer', { ...header, writer: header.writer.slice(1) }],
    ['63-hex prev', { ...header, prev: header.prev.slice(1) }],
    ['short sig', { ...header, sig: header.sig.slice(1) }],
    ['body as text', { ...header, body: 'x' }],
    ['body with extra key', { ...header, body: { ...header.body, more: 1 } }],
    ['body size below overhead', { ...header, body: { hash: header.body.hash, size: 3 } }],
    ['body hash 63 hex', { ...header, body: { hash: header.body.hash.slice(1), size: header.body.size } }],
    ['over 4096 canonical bytes', { ...header, pad: 'x'.repeat(5000) }]
  ];
  for (const key of Object.keys(header)) {
    const copy: Record<string, unknown> = { ...header };
    delete copy[key];
    mutations.push([`missing ${key}`, copy]);
  }
  for (const [name, mutated] of mutations) {
    const outcome = verifyEntry({ header: mutated, body: written.entry.body }, world.ctx());
    const reason = rejectedReason(outcome);
    assert.ok(reason === 'malformed-header' || reason === 'header-too-large', `${name}: ${reason}`);
    const folded = foldEntries([{ header: mutated, body: written.entry.body }], world.ctx());
    assert.equal(folded.rejected.length, 1, name);
    assert.deepEqual([folded.applied, folded.held, folded.kept, folded.refused], [[], [], [], []], name);
  }
  for (const input of [undefined, null, 5, 'text', [], [header], true]) {
    assert.equal(rejectedReason(verifyEntry(input, world.ctx())), 'malformed-header');
  }
  assert.equal(rejectedReason(verifyEntry({ body: written.entry.body }, world.ctx())), 'malformed-header');
});

// ---- bodies ----

test('a well-formed forged body verifies, so every body refusal below is about the body and nothing else', () => {
  const world = twoWriters();
  const outcome = verifyEntry(forge(world, 'A', asBytes(goodBody(world))), world.ctx());
  assert.equal(outcome.status, 'verified');
});

test('bodies with too many deps, both or neither of data and blob, lamport 0, a bad time, a bad actor or a prototype key are rejected bad-body', () => {
  const world = twoWriters();
  const dep = (index: number): Record<string, unknown> => ({ writer: HASH_A, seq: index, hash: HASH_B });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['17 deps', { ...goodBody(world), deps: Array.from({ length: 17 }, (_, index) => dep(index)) }],
    ['dep with extra key', { ...goodBody(world), deps: [{ ...dep(0), extra: 1 }] }],
    ['dep with short hash', { ...goodBody(world), deps: [{ writer: HASH_A, seq: 0, hash: 'b'.repeat(63) }] }],
    ['both data and blob', { ...goodBody(world), blob: HASH_A }],
    ['lamport 0', { ...goodBody(world), lamport: 0 }],
    ['lamport 1.5', { ...goodBody(world), lamport: 1.5 }],
    ['lamport past the cap', { ...goodBody(world), lamport: 1_000_000_000_000 }],
    ['month 13', { ...goodBody(world), at: '2026-13-01T00:00:00Z' }],
    ['not a time', { ...goodBody(world), at: 'yesterday' }],
    ['agent without run', { ...goodBody(world), actor: { kind: 'agent', member: 'ada' } }],
    ['agent with a spaced member', { ...goodBody(world), actor: { kind: 'agent', member: 'Ada Lovelace', run: 'run-1' } }],
    ['person with an extra key', { ...goodBody(world), actor: { kind: 'person', extra: 1 } }],
    ['unknown actor kind', { ...goodBody(world), actor: { kind: 'robot' } }],
    ['roster 63 hex', { ...goodBody(world), roster: 'c'.repeat(63) }],
    ['kind with spaces', { ...goodBody(world), kind: 'Bad Kind!' }],
    ['extra body key', { ...goodBody(world), extra: 1 }]
  ];
  const noData: Record<string, unknown> = goodBody(world);
  delete noData.data;
  cases.push(['neither data nor blob', noData]);
  const noDeps: Record<string, unknown> = goodBody(world);
  delete noDeps.deps;
  cases.push(['no deps', noDeps]);
  const blobBad: Record<string, unknown> = goodBody(world);
  delete blobBad.data;
  cases.push(['blob not a hash', { ...blobBad, blob: 'zz' }]);
  for (const [name, body] of cases) {
    assert.equal(rejectedReason(verifyEntry(forge(world, 'A', asBytes(body)), world.ctx())), 'bad-body', name);
  }
  const prototypeText = JSON.stringify(goodBody(world)).replace('{', '{"__proto__":{"admin":true},');
  assert.equal(rejectedReason(verifyEntry(forge(world, 'A', Buffer.from(prototypeText)), world.ctx())), 'bad-body', '__proto__ key');
  for (const garbage of [Buffer.from('not json'), Buffer.from('[]'), Buffer.from('7'), Buffer.from('null'), Buffer.alloc(0)]) {
    assert.equal(rejectedReason(verifyEntry(forge(world, 'A', garbage), world.ctx())), 'bad-body', garbage.toString());
  }
});

// ---- determinism and binding ----

test('signing one header twice gives identical bytes and the same entry hash; re-sealing one body at one seq gives a different body.hash', () => {
  const world = twoWriters();
  const signer = world.signerOf('A');
  const stream = world.stream;
  const input = { signer: signer.signer, key: world.keyFor(stream, 0), stream, seq: 0, prev: GENESIS_PREV, epoch: 0, body: { deps: [], roster: world.rosterHash, lamport: 1, at: WORLD_AT, actor: { kind: 'person' as const }, kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } } };
  const first = buildEntry(input);
  const { sig, ...unsigned } = first.entry.header;
  const again = signHeader(signer.signer, unsigned as UnsignedHeader);
  assert.equal(again.sig, sig);
  assert.equal(entryHash(again), first.hash);
  assert.deepEqual(canonicalBytes(again), canonicalBytes(first.entry.header));
  const second = buildEntry(input);
  assert.notEqual(second.entry.header.body.hash, first.entry.header.body.hash);
  assert.notEqual(second.hash, first.hash);
  assert.notEqual(second.entry.header.sig, first.entry.header.sig);
  assert.equal(second.entry.header.seq, first.entry.header.seq);
});

test('a ciphertext copied under another writer header cannot be opened: the associated data binds writer, seq and prev', () => {
  const world = twoWriters();
  const original = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  const signerB = world.signerOf('B');
  const wire = Buffer.from(original.entry.body, 'base64url');
  const copiedUnder = (patch: Partial<UnsignedHeader>): SealedEntry => {
    const unsigned: UnsignedHeader = { v: 2, stream: original.stream, writer: signerB.writer, seq: 0, prev: GENESIS_PREV, epoch: 0, body: { hash: sha256Hex(wire), size: wire.length }, ...patch };
    return { header: signHeader(signerB.signer, unsigned), body: original.entry.body };
  };
  assert.equal(rejectedReason(verifyEntry(copiedUnder({}), world.ctx())), 'body-unreadable');
  // Same writer, different seq or different prev: still not readable.
  const own = world.signerOf('A');
  const reseated = (patch: Partial<UnsignedHeader>): SealedEntry => {
    const unsigned: UnsignedHeader = { v: 2, stream: original.stream, writer: own.writer, seq: 0, prev: GENESIS_PREV, epoch: 0, body: { hash: sha256Hex(wire), size: wire.length }, ...patch };
    return { header: signHeader(own.signer, unsigned), body: original.entry.body };
  };
  assert.equal(verifyEntry(reseated({}), world.ctx()).status, 'verified');
  assert.equal(rejectedReason(verifyEntry(reseated({ seq: 1 }), world.ctx())), 'body-unreadable');
  assert.equal(rejectedReason(verifyEntry(reseated({ prev: HASH_A }), world.ctx())), 'body-unreadable');
  assert.equal(rejectedReason(verifyEntry(reseated({ epoch: 1 }), world.ctx({ keys: () => world.keyFor(original.stream, 0) }))), 'body-unreadable');
  const folded = foldEntries([copiedUnder({})], world.ctx());
  assert.deepEqual(folded.rejected.map((item) => item.reason), ['body-unreadable']);
  assert.deepEqual(folded.applied, []);
});

test('headerAad has no sig and no hash key and has size, and openBody succeeds only with the header it was sealed for', () => {
  const world = twoWriters();
  const written = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  const header = written.entry.header;
  const aad = JSON.parse(headerAad(header).toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(aad).sort(), ['epoch', 'prev', 'seq', 'size', 'stream', 'v', 'writer']);
  assert.equal(aad.size, header.body.size);
  assert.equal('sig' in aad, false);
  assert.equal('hash' in aad, false);
  assert.equal('body' in aad, false);
  const wire = Buffer.from(written.entry.body, 'base64url');
  const key = world.keyFor(header.stream, header.epoch);
  assert.ok(openBody(key, header, wire) !== undefined);
  const other: EntryHeader = { ...header, seq: header.seq + 1 };
  assert.equal(openBody(key, other, wire), undefined);
  assert.equal(openBody(key, header, wire.subarray(0, 10)), undefined);
  assert.equal(openBody(Buffer.alloc(5), header, wire), undefined);
});

test('verifyHeader succeeds with only the header and the device key: no body and no cell key', () => {
  const world = twoWriters();
  const written = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  const header = written.entry.header;
  assert.equal(verifyHeader(header, world.signerOf('A').publicKey), true);
  assert.equal(verifyHeader(header, world.signerOf('B').publicKey), false);
  assert.equal(verifyHeader({ ...header, seq: 7 }, world.signerOf('A').publicKey), false);
  assert.equal(verifyHeader({ ...header, body: { ...header.body, size: header.body.size + 1 } }, world.signerOf('A').publicKey), false);
  assert.equal(verifyHeader(header, 'not a key'), false);
  assert.equal(verifyHeader(header, fixedSigner('C').publicKey), false);
});

// ---- blobs and sizes ----

test('a 20 KB doc.update is built as a blob: it folds with the blob, is held missing-blob without it, and is held missing-blob when the blob bytes change', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }] });
  const editor = world.editor('A', PRODUCT, 101);
  const text = 'abcdefghij'.repeat(2000);
  const register = editor.register();
  const big = editor.insert(0, text);
  assert.equal(world.blobs.size, 1);
  const [blob] = [...world.blobs.values()];
  assert.ok(Buffer.from(blob.bytes, 'base64url').length > INLINE_BODY_MAX_BYTES);
  const entries = [register.entry, big.entry];
  assert.equal(productsOf(foldEntries(entries, world.ctx()))[0].text, text);

  const missing = verifyEntry(big.entry, world.ctx({ blobs: () => undefined }));
  assert.deepEqual([missing.status, missing.status === 'held' ? missing.reason : ''], ['held', 'missing-blob']);

  const flipped = Buffer.from(blob.bytes, 'base64url');
  flipped[flipped.length - 1] ^= 1;
  const changed: SealedBlob = { hash: blob.hash, bytes: flipped.toString('base64url') };
  const tampered = verifyEntry(big.entry, world.ctx({ blobs: () => changed }));
  assert.deepEqual([tampered.status, tampered.status === 'held' ? tampered.reason : ''], ['held', 'missing-blob']);
  const heldFold = foldEntries(entries, world.ctx({ blobs: () => changed }));
  assert.deepEqual(heldFold.held.map((item) => item.reason), ['missing-blob']);
  assert.equal(heldFold.applied.length, 1);

  // The blob given back later releases the entry: held entries wait, they are not lost.
  assert.equal(productsOf(foldEntries(entries, world.ctx({ blobs: (hash) => (hash === blob.hash ? blob : undefined) })))[0].text, text);
});

test('a received inline body over 16 KB is rejected body-too-large', () => {
  const world = twoWriters();
  const big = { ...goodBody(world), kind: 'doc.update', data: { product: PRODUCT, update: 'A'.repeat(INLINE_BODY_MAX_BYTES + 100) } };
  assert.equal(rejectedReason(verifyEntry(forge(world, 'A', asBytes(big)), world.ctx())), 'body-too-large');
  const exactly = forge(world, 'A', Buffer.alloc(INLINE_BODY_MAX_BYTES + 1, 0x20));
  assert.equal(rejectedReason(verifyEntry(exactly, world.ctx())), 'body-too-large');
});

// ---- holds and keeps ----

test('an unknown device is held unknown-writer, corrupted body bytes are held body-missing-or-corrupt, a missing epoch key is held missing-key, an unknown roster hash is held missing-roster', () => {
  const world = twoWriters();
  const written = world.write('A', { kind: 'doc.client', data: { product: PRODUCT, clientId: 101, actor: { kind: 'person' } } });
  const holdReason = (outcome: VerifyOutcome): string => {
    assert.equal(outcome.status, 'held', JSON.stringify(outcome).slice(0, 200));
    return outcome.status === 'held' ? outcome.reason : '';
  };

  const nobody = staticRosterView({ rosters: [{ hash: world.rosterHash, members: [] }] });
  assert.equal(holdReason(verifyEntry(written.entry, world.ctx({ roster: nobody }))), 'unknown-writer');
  assert.deepEqual(foldEntries([written.entry], world.ctx({ roster: nobody })).held.map((item) => item.reason), ['unknown-writer']);

  const wire = Buffer.from(written.entry.body, 'base64url');
  wire[wire.length - 1] ^= 1;
  const corrupt = { header: written.entry.header, body: wire.toString('base64url') };
  assert.equal(holdReason(verifyEntry(corrupt, world.ctx())), 'body-missing-or-corrupt');
  for (const body of [undefined, null, 5, '', 'a'.repeat(5000), '!!!!', written.entry.body.slice(0, 20), `${written.entry.body}AAAA`]) {
    assert.equal(holdReason(verifyEntry({ header: written.entry.header, body }, world.ctx())), 'body-missing-or-corrupt', String(body).slice(0, 30));
  }
  const folded = foldEntries([corrupt], world.ctx());
  assert.deepEqual(folded.held.map((item) => item.reason), ['body-missing-or-corrupt']);
  assert.deepEqual([folded.applied, folded.rejected], [[], []]);
  // A good copy next to the damaged one wins, whatever the order.
  assert.equal(foldEntries([corrupt, written.entry], world.ctx()).applied.length, 1);
  assert.equal(foldEntries([written.entry, corrupt], world.ctx()).applied.length, 1);

  assert.equal(holdReason(verifyEntry(written.entry, world.ctx({ keys: () => undefined }))), 'missing-key');

  const elsewhere = world.write('B', { kind: 'doc.client', data: { product: PRODUCT, clientId: 202, actor: { kind: 'person' } }, roster: 'd'.repeat(64) });
  assert.equal(holdReason(verifyEntry(elsewhere.entry, world.ctx())), 'missing-roster');
  assert.deepEqual(foldEntries([elsewhere.entry], world.ctx()).held.map((item) => item.reason), ['missing-roster']);
});

test('a device not admitted at the cited roster is kept unauthorised and changes no text', () => {
  const world = twoWriters();
  const ada = world.signerOf('A');
  const bo = world.signerOf('B');
  const later = 'e'.repeat(64);
  const roster = staticRosterView({
    rosters: [
      { hash: world.rosterHash, members: [{ member: 'mbr-aaaa', name: 'Ada', roles: ['member'], devices: [{ writer: ada.writer, publicKey: ada.publicKey }] }] },
      { hash: later, members: [
        { member: 'mbr-aaaa', name: 'Ada', roles: ['member'], devices: [{ writer: ada.writer, publicKey: ada.publicKey }] },
        { member: 'mbr-bbbb', name: 'Bo', roles: ['member'], devices: [{ writer: bo.writer, publicKey: bo.publicKey }] }
      ] }
    ]
  });
  const a = world.editor('A', PRODUCT, 101);
  const b = world.editor('B', PRODUCT, 202);
  const a0 = a.register();
  const a1 = a.insert(0, 'Ada wrote this');
  const b0 = b.register();
  const b1 = b.insert(0, 'Bo was not admitted yet');
  const ctx = world.ctx({ roster });
  const clean = foldEntries([a0.entry, a1.entry], ctx);
  const result = foldEntries([a0.entry, a1.entry, b0.entry, b1.entry], ctx);
  assert.deepEqual(result.kept.map((item) => [item.hash, item.reason]).sort(), [[b0.hash, 'unauthorised'], [b1.hash, 'unauthorised']].sort());
  assert.equal(productsOf(result)[0].text, 'Ada wrote this');
  assert.deepEqual(result.digests, clean.digests);
  assert.deepEqual([result.held, result.rejected, result.refused], [[], [], []]);
  // Bo's entries do count when they cite the later roster.
  const b2 = world.write('B', { kind: 'doc.client', data: { product: PRODUCT, clientId: 303, actor: { kind: 'person' } }, roster: later });
  const outcome = verifyEntry(b2.entry, ctx);
  assert.equal(outcome.status === 'verified' ? outcome.entry.keep : 'not verified', undefined);
});

// ---- never throws ----

function randomValue(random: Rng, depth: number): unknown {
  const roll = random.int(depth > 2 ? 6 : 10);
  switch (roll) {
    case 0: return null;
    case 1: return random.int(2000) - 5;
    case 2: return random.pick(['__proto__', 'constructor', '', 'x'.repeat(random.int(300)), '0'.repeat(64), 'a'.repeat(32), '2026-11-19T11:00:00.000Z']);
    case 3: return random.chance(0.5);
    case 4: return random.int(2 ** 30) * random.int(2 ** 24);
    case 5: return random.pick([-0, 1.5, 1e300, 2 ** 53, -(2 ** 53)]);
    case 6: return Array.from({ length: random.int(5) }, () => randomValue(random, depth + 1));
    case 7: {
      const result: Record<string, unknown> = {};
      for (let index = random.int(6); index > 0; index -= 1) result[random.pick(['v', 'stream', 'writer', 'seq', 'prev', 'epoch', 'body', 'sig', 'hash', 'size', 'deps', 'kind', 'x'])] = randomValue(random, depth + 1);
      return result;
    }
    case 8: return JSON.parse(`{"__proto__":${JSON.stringify(randomValue(random, depth + 1) ?? null)},"constructor":{"prototype":{}}}`) as unknown;
    default: return random.pick(['AAAA', 'not base64url!', Buffer.from(Array.from({ length: random.int(80) }, () => random.int(256))).toString('base64url')]);
  }
}

test('verifyEntry and foldEntries never throw on 500 seeded random inputs, and junk never changes the digest of the good entries', () => {
  const world = twoWriters();
  const a = world.editor('A', PRODUCT, 101);
  const b = world.editor('B', PRODUCT, 202);
  const good = [a.register(), a.insert(0, 'Hello '), b.register(), b.insert(0, 'world')];
  const goodEntries = good.map((item) => item.entry);
  const ctx = world.ctx();
  const clean = foldEntries(goodEntries, ctx);
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = rng(seed);
    const base = random.pick(good).entry;
    const header = base.header as unknown as Record<string, unknown>;
    let input: unknown;
    switch (seed % 6) {
      case 0: input = randomValue(random, 0); break;
      case 1: input = { header: randomValue(random, 0), body: randomValue(random, 0) }; break;
      case 2: {
        const copy: Record<string, unknown> = { ...header };
        const key = random.pick(Object.keys(header));
        if (random.chance(0.5)) delete copy[key]; else copy[key] = randomValue(random, 1);
        input = { header: copy, body: base.body };
        break;
      }
      case 3: {
        const keys = Object.keys(header).slice(0, random.int(Object.keys(header).length));
        input = { header: Object.fromEntries(keys.map((key) => [key, header[key]])), body: base.body };
        break;
      }
      case 4: input = { header: base.header, body: random.pick([base.body.slice(0, random.int(base.body.length)), randomValue(random, 1), Buffer.from(Array.from({ length: random.int(300) }, () => random.int(256))).toString('base64url'), `${base.body}${base.body}`]) }; break;
      default: {
        const wire = Buffer.from(base.body, 'base64url');
        wire[random.int(wire.length)] ^= 1 << random.int(8);
        input = { header: base.header, body: wire.toString('base64url') };
      }
    }
    let outcome: VerifyOutcome | undefined;
    assert.doesNotThrow(() => { outcome = verifyEntry(input, ctx); }, `verifyEntry threw at seed ${seed}`);
    assert.ok(outcome !== undefined && ['verified', 'held', 'rejected'].includes(outcome.status), `no outcome at seed ${seed}`);
    let folded: FoldResult | undefined;
    assert.doesNotThrow(() => { folded = foldEntries([...goodEntries, input], ctx); }, `foldEntries threw at seed ${seed}`);
    if (outcome !== undefined && outcome.status !== 'verified') {
      assert.deepEqual(folded?.digests, clean.digests, `junk changed the digest at seed ${seed}`);
      assert.equal(folded?.applied.length, clean.applied.length, `junk changed what was applied at seed ${seed}`);
    }
  }
});
