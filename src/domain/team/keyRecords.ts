// The local key history of a person without a team (D-09, D-21, TMR-05). Pure: no I/O, no vscode.
// A team keeps rotation and revocation in its signed event log. A person alone has no log, so the same facts are kept as a short chain of signed records:
// created (a first key), rotated (the active key hands over to a new one) and revoked (a key is withdrawn). Each record is a key-record payload signed
// through the one signer in signedPayload.ts, so a record is checked by the same verifyPayload as any other signed item.
//
// Replaying the chain gives a KeyStatusLookup of the same kind a team roster gives (teamKeyStatus), so a solo payload is checked the same way.
//
// What makes a record valid, checked in this order for each record: seq counts from 1 with no gap; prev is the hash of the previous signed record
// (empty for the first); the record passes verifyPayload for the purpose key-record against a status source that answers active ONLY for the key allowed
// to sign that record at that point (created: the new key itself; rotated: the active key; revoked: the key being withdrawn or the active key) and
// unknown for every other key; the record's own at equals the envelope's signedAt; and the change fits the state so far.
//
// Any failure makes the whole history untrusted: ok is false, the reason is a plain sentence and the lookup answers unknown for every key. A broken
// history never turns into "everything trusted". A truncation the chain alone cannot show (dropping the last records leaves a valid shorter chain) is
// caught by the head, the seq and hash of the last record, which the caller keeps somewhere the history file does not reach (SecretStorage).
import { createHash } from 'node:crypto';
import { canonicalBytes, fingerprintOf, isStrictBase64url } from './canonical';
import { NO_KNOWN_KEYS } from './keyStatus';
import type { KeyState, KeyStatus, KeyStatusLookup } from './keyStatus';
import { verifyPayload } from './signedPayload';
import type { PayloadFailureReason, SignedPayload } from './signedPayload';
import type { DeviceRef } from './types';

export type KeyRecordKind = 'created' | 'rotated' | 'revoked';

// next is present only on a rotation. A key is named by fingerprint and public key together so a record can be checked offline.
export interface KeyRecord { seq: number; prev: string; kind: KeyRecordKind; key: DeviceRef; next?: DeviceRef; at: string }
export interface KeyHistoryFile { version: 1; records: SignedPayload<KeyRecord>[] }
export interface KeyHistoryHead { seq: number; hash: string }

export type KeyHistoryReplay =
  | { ok: true; active?: DeviceRef; head?: KeyHistoryHead; lookup: KeyStatusLookup }
  | { ok: false; reason: string; lookup: KeyStatusLookup };

export const MAX_KEY_RECORDS = 1000;
export const KEY_HISTORY_VERSION = 1;
const PUBLIC_KEY_BYTES = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const REVOKED_IN_HISTORY = 'revoked in the key history';

// SHA-256 of the signed record's canonical bytes (signature included), so re-signing or editing any byte of a record changes the hash the next
// record names.
export function keyRecordHash(record: SignedPayload<KeyRecord>): string {
  return createHash('sha256').update(canonicalBytes(record)).digest('hex');
}

function fail(reason: string): { ok: false; reason: string; lookup: KeyStatusLookup } {
  return { ok: false, reason, lookup: NO_KNOWN_KEYS };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function parseDeviceRef(value: unknown): DeviceRef | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['fingerprint', 'publicKey'])) return undefined;
  const { fingerprint, publicKey } = value;
  if (typeof fingerprint !== 'string' || typeof publicKey !== 'string' || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return undefined;
  if (fingerprintOf(Buffer.from(publicKey, 'base64url')) !== fingerprint) return undefined;
  return { fingerprint, publicKey };
}

function isCanonicalTime(value: string): boolean {
  const millis = Date.parse(value);
  return !Number.isNaN(millis) && new Date(millis).toISOString() === value;
}

// The payload of one record, or undefined when it is not exactly a key record. Used on the untrusted payload to decide who may sign, and again on
// the verified copy that verifyPayload returns.
function parseKeyRecord(value: unknown): KeyRecord | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['seq', 'prev', 'kind', 'key', 'at'], ['next'])) return undefined;
  const { seq, prev, kind, key, next, at } = value;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return undefined;
  if (typeof prev !== 'string' || (prev !== '' && !HASH_PATTERN.test(prev))) return undefined;
  if (kind !== 'created' && kind !== 'rotated' && kind !== 'revoked') return undefined;
  if (typeof at !== 'string' || !isCanonicalTime(at)) return undefined;
  const keyRef = parseDeviceRef(key);
  if (keyRef === undefined) return undefined;
  const record: KeyRecord = { seq, prev, kind, key: keyRef, at };
  if (kind === 'rotated') {
    const nextRef = parseDeviceRef(next);
    if (nextRef === undefined) return undefined;
    record.next = nextRef;
  } else if (next !== undefined) {
    return undefined;
  }
  return record;
}

interface KeyEntry { publicKey: string; state: KeyState; since?: string; replacedBy?: string; reason?: string }

function sameDevice(a: DeviceRef | undefined, b: DeviceRef): boolean {
  return a !== undefined && a.fingerprint === b.fingerprint && a.publicKey === b.publicKey;
}

// The status the replay gives a verifier for one record: active for the keys allowed to sign it, unknown for everyone else.
function allowedSigners(allowed: readonly DeviceRef[]): KeyStatusLookup {
  return (key) => (allowed.some((device) => sameDevice(device, key)) ? { state: 'active' } : { state: 'unknown' });
}

function whyRefused(seq: number, reason: PayloadFailureReason, message: string): string {
  if (reason === 'unknown-key') return `Record ${seq} of the key history was signed by a key that is not allowed to make that change.`;
  if (reason === 'bad-signature') return `Record ${seq} of the key history was changed, or it was not signed by the key it names.`;
  return `Record ${seq} of the key history cannot be trusted: ${message}`;
}

function lookupOf(entries: ReadonlyMap<string, KeyEntry>): KeyStatusLookup {
  return (key) => {
    const entry = entries.get(key.fingerprint);
    if (entry === undefined || entry.publicKey !== key.publicKey) return { state: 'unknown' };
    const status: KeyStatus = { state: entry.state };
    if (entry.since !== undefined) status.since = entry.since;
    if (entry.replacedBy !== undefined) status.replacedBy = entry.replacedBy;
    if (entry.reason !== undefined) status.reason = entry.reason;
    return status;
  };
}

// Never throws. head is the seq and hash the caller kept for the last record it knows of, or undefined when it has none.
export function replayKeyHistory(file: unknown, head: KeyHistoryHead | undefined): KeyHistoryReplay {
  try {
    return replay(file, head);
  } catch {
    // Hostile input (a throwing getter, a Proxy) cannot be read, so nothing in it is trusted; the verdict is the refusal, not a thrown error.
    return fail('The key history could not be read, so no key in it is trusted.');
  }
}

function readHead(head: KeyHistoryHead | undefined): KeyHistoryHead | undefined | 'invalid' {
  if (head === undefined) return undefined;
  if (!isPlainRecord(head) || !hasExactKeys(head, ['seq', 'hash'])) return 'invalid';
  if (typeof head.seq !== 'number' || !Number.isSafeInteger(head.seq) || head.seq < 1 || typeof head.hash !== 'string' || !HASH_PATTERN.test(head.hash)) return 'invalid';
  return { seq: head.seq, hash: head.hash };
}

function replay(file: unknown, rawHead: KeyHistoryHead | undefined): KeyHistoryReplay {
  if (!isPlainRecord(file) || !hasExactKeys(file, ['version', 'records'])) return fail('The key history file is not in a form this version can read.');
  if (file.version !== KEY_HISTORY_VERSION) {
    return typeof file.version === 'number' && Number.isInteger(file.version) && file.version > KEY_HISTORY_VERSION
      ? fail('The key history was written in a newer format. Update the extension to check it.')
      : fail('The key history file is not in a form this version can read.');
  }
  const records = file.records;
  if (!Array.isArray(records)) return fail('The key history file is not in a form this version can read.');
  if (records.length > MAX_KEY_RECORDS) return fail(`The key history has more than ${MAX_KEY_RECORDS} records, which is more than this version reads.`);
  const head = readHead(rawHead);
  if (head === 'invalid') return fail('The saved end of the key history is not in a form this version can read, so the history is not trusted.');

  const entries = new Map<string, KeyEntry>();
  let active: DeviceRef | undefined;
  let prev = '';
  for (let index = 0; index < records.length; index += 1) {
    const seq = index + 1;
    const raw: unknown = records[index];
    const claimed = isPlainRecord(raw) ? parseKeyRecord(raw.payload) : undefined;
    if (claimed === undefined) return fail(`Record ${seq} of the key history is not in a form this version can read.`);
    if (claimed.seq !== seq) return fail(`Record ${seq} of the key history is out of order or a record is missing (it is numbered ${claimed.seq}).`);
    if (claimed.prev !== prev) return fail(`Record ${seq} of the key history does not follow the record before it, so a record was changed, moved or removed.`);

    // Who may sign this record, decided from the state so far (D-09): the new key itself for created; the active key for rotated; for revoked the
    // key being withdrawn (while it is active or rotated) or the active key.
    const allowed: DeviceRef[] = [];
    if (claimed.kind === 'created') {
      allowed.push(claimed.key);
    } else if (claimed.kind === 'rotated') {
      if (active !== undefined) allowed.push(active);
    } else {
      const target = entries.get(claimed.key.fingerprint);
      if (target !== undefined && target.publicKey === claimed.key.publicKey && target.state !== 'revoked') allowed.push(claimed.key);
      if (active !== undefined) allowed.push(active);
    }
    const verdict = verifyPayload<unknown>(raw, { purpose: 'key-record', status: allowedSigners(allowed) });
    if (!verdict.ok) return fail(whyRefused(seq, verdict.reason, verdict.message));
    const record = parseKeyRecord(verdict.payload);
    if (record === undefined || record.at !== verdict.signedAt) return fail(`Record ${seq} of the key history says a different time than it was signed at.`);
    // The signers allowed above were chosen from `claimed`, a first read of the untrusted record; what is applied below is the verified copy. They must be
    // the same record, so an object that reads differently the second time cannot choose who may sign what is applied.
    if (!canonicalBytes(claimed).equals(canonicalBytes(record))) return fail(`Record ${seq} of the key history reads differently each time it is looked at, so it is not trusted.`);

    if (record.kind === 'created') {
      if (active !== undefined) return fail(`Record ${seq} of the key history adds a first key while another key is still active.`);
      if (entries.has(record.key.fingerprint)) return fail(`Record ${seq} of the key history adds a key that the history already used.`);
      entries.set(record.key.fingerprint, { publicKey: record.key.publicKey, state: 'active' });
      active = record.key;
    } else if (record.kind === 'rotated') {
      if (!sameDevice(active, record.key) || record.next === undefined) return fail(`Record ${seq} of the key history replaces a key that is not the active key.`);
      if (entries.has(record.next.fingerprint)) return fail(`Record ${seq} of the key history hands over to a key that the history already used.`);
      entries.set(record.key.fingerprint, { publicKey: record.key.publicKey, state: 'rotated', since: record.at, replacedBy: record.next.fingerprint });
      entries.set(record.next.fingerprint, { publicKey: record.next.publicKey, state: 'active' });
      active = record.next;
    } else {
      const target = entries.get(record.key.fingerprint);
      if (target === undefined || target.publicKey !== record.key.publicKey) return fail(`Record ${seq} of the key history revokes a key that the history does not know.`);
      if (target.state === 'revoked') return fail(`Record ${seq} of the key history revokes a key that was already revoked.`);
      entries.set(record.key.fingerprint, { publicKey: target.publicKey, state: 'revoked', since: record.at, reason: REVOKED_IN_HISTORY });
      if (sameDevice(active, record.key)) active = undefined;
    }
    prev = keyRecordHash(raw as SignedPayload<KeyRecord>);
  }

  if (records.length === 0) {
    if (head !== undefined) return fail('The key history is empty but this computer saved an end for it, so the history file was removed or replaced.');
    return { ok: true, lookup: lookupOf(entries) };
  }
  if (head === undefined) return fail('The key history has records but this computer saved no end for it, so it cannot tell whether records were removed.');
  if (head.seq > records.length) return fail('The key history is shorter than this computer last saw it, so records were removed.');
  if (head.seq !== records.length || head.hash !== prev) return fail('The key history does not match the end this computer saved, so it was changed or replaced.');
  const result: { ok: true; active?: DeviceRef; head: KeyHistoryHead; lookup: KeyStatusLookup } = { ok: true, head: { seq: records.length, hash: prev }, lookup: lookupOf(entries) };
  if (active !== undefined) result.active = active;
  return result;
}
