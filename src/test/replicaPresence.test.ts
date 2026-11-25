// The sealed presence format (Phase 33, 33-12; D-18, D-21, D-35; Pattern 4): sealed under the cell's epoch key with AAD of the cell, epoch and
// writer, a closed plaintext shape, a size limit, and nothing about a product in the base cell. Fictional data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PRESENCE_PLAINTEXT, PRESENCE_INFO, openPresence, presenceAllowedFor, readPresence, sealPresence } from '../domain/replica/presence';
import type { PresenceMessage } from '../domain/replica/presence';
import { PRESENCE_BODY_MAX_BYTES } from '../staff/replica/hubTransport';
import { epochKey, streamId } from './helpers/replicaWorld';

const CELL = streamId('presence/cell');
const BASE = streamId('presence/base');
const WRITER = 'a'.repeat(64);
const OTHER_WRITER = 'b'.repeat(64);
const KEY1 = epochKey('presence/cell/1');
const KEY2 = epochKey('presence/cell/2');
const keys = (cell: string, epoch: number): Buffer | undefined => (cell === CELL ? (epoch === 1 ? KEY1 : epoch === 2 ? KEY2 : undefined) : cell === BASE && epoch === 1 ? KEY1 : undefined);
const here: PresenceMessage = { v: 1, kind: 'here', member: 'mbr-avery', position: 'J2 analyst', seq: 3 };
const working: PresenceMessage = { v: 1, kind: 'cursor', member: 'mbr-avery', product: 'intel-estimate', anchor: 'AAEC', head: 'AAED', runs: 2, seq: 4 };

test('the info string is near-ai/presence/v1', () => {
  assert.equal(PRESENCE_INFO, 'near-ai/presence/v1');
});

test('seal then open with the same key and place gives the message back', () => {
  for (const message of [here, working]) {
    const sealed = sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, message);
    assert.deepEqual(openPresence(keys, { cell: CELL, writer: WRITER }, sealed), message);
  }
});

test('a flipped byte does not open', () => {
  const sealed = Buffer.from(sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, here), 'base64url');
  sealed[sealed.length - 1] ^= 1;
  assert.equal(openPresence(keys, { cell: CELL, writer: WRITER }, sealed.toString('base64url')), undefined);
});

test('another cell or another writer in the associated data does not open', () => {
  const sealed = sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, here);
  assert.equal(openPresence(keys, { cell: BASE, writer: WRITER }, sealed), undefined);
  assert.equal(openPresence(keys, { cell: CELL, writer: OTHER_WRITER }, sealed), undefined);
});

test('a wrong epoch does not open: the epoch the bytes name chooses the key, and a key of another epoch fails', () => {
  const sealed = Buffer.from(sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, here), 'base64url');
  sealed.writeUInt32BE(2, 0);
  assert.equal(openPresence(keys, { cell: CELL, writer: WRITER }, sealed.toString('base64url')), undefined);
  assert.equal(openPresence(() => undefined, { cell: CELL, writer: WRITER }, sealPresence(KEY2, { cell: CELL, epoch: 2, writer: WRITER }, here)), undefined, 'no key for that epoch');
});

test('a plaintext over the limit or with an unknown key is refused before sealing', () => {
  assert.throws(() => sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, { ...here, position: 'x'.repeat(MAX_PRESENCE_PLAINTEXT) }));
  assert.throws(() => sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, { ...here, note: 'extra' } as unknown as PresenceMessage));
  assert.equal(readPresence({ ...here, extra: 1 }), undefined);
  assert.equal(readPresence({ ...here, v: 2 }), undefined);
  assert.equal(readPresence({ v: 1, kind: 'cursor', member: 'mbr-a', anchor: 'AAEC', seq: 1 }), undefined, 'a cursor needs its product');
});

test('the largest message fits the hub\'s 2 KiB presence body with its cell', () => {
  const largest: PresenceMessage = { v: 1, kind: 'cursor', member: 'm'.repeat(64), position: 'p'.repeat(120), product: 'q'.repeat(64), anchor: 'A'.repeat(256), head: 'B'.repeat(256), runs: 1000, seq: Number.MAX_SAFE_INTEGER };
  const sealed = sealPresence(KEY1, { cell: CELL, epoch: 1, writer: WRITER }, largest);
  assert.ok(Buffer.byteLength(JSON.stringify({ cell: CELL, sealed }), 'utf8') <= PRESENCE_BODY_MAX_BYTES);
});

test('the base cell carries online and the position only: never a product, its cursor or the agents count', () => {
  assert.equal(presenceAllowedFor(here, BASE, BASE), true);
  assert.equal(presenceAllowedFor(working, BASE, BASE), false);
  assert.equal(presenceAllowedFor({ ...here, runs: 1 }, BASE, BASE), false);
  assert.equal(presenceAllowedFor(working, CELL, BASE), true);
});

test('openPresence never throws on junk', () => {
  for (const junk of ['', '!!', 'AAAA', 'A'.repeat(5000), 7 as unknown as string]) assert.equal(openPresence(keys, { cell: CELL, writer: WRITER }, junk), undefined);
});
