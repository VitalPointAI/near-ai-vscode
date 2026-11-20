// Enrolment (D-41, D-64): the only way a project reaches the hub. The operator runs --hub-file <days>, which prints a .near-staff-hub file signed by
// the hub's own key with an enrolment id and a one-time enrolment secret; the hub keeps only the secret's hash. The staff lead's device then sends
// the project's genesis and roster (through hub.admit, hub.grant and the base cell grant to the hub), every grant it holds for the project's cells,
// the blobs those entries use, the roster head it claims and an HMAC under the enrolment secret over the enrolment id, hub, project, genesis hash and
// roster head (hubFile.ts enrolmentMac, the one function both sides use).
//
// The secret is never stored. It is derived from the hub's own X25519 private key and the enrolment id (HKDF-SHA256), so the hub can recompute it
// to check the MAC while its database holds only the hash; a copy of the database alone cannot enrol a project. A hub whose encryption key changed
// cannot use hub files it issued before, which the operator replaces with a new file.
//
// Order of the checks: the shape; the enrolment id (unknown, used or expired, before any HMAC, so an unknown id costs nothing); the MAC in constant
// time, before any roster work; the project not already held; the base cell grant wrapped to this hub's key; the genesis the hub can open; the roster
// folded with the hub-side foldRoster and its head equal to the claimed head; hub.admit in force at the head naming this hub's writer, X25519 key and
// current certificate pin; the hub among the base cell's grantees at the head. Then everything is stored in one enrolProject call.
import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readGrant, unwrapEpochKey } from '@ext/domain/replica/cellKeys';
import { BLOB_MAX_BYTES, HASH_PATTERN, STREAM_ID_PATTERN, entryHash, openBlob, openBody, parseHeaderShape, sha256Hex, verifyHeader } from '@ext/domain/replica/entry';
import type { EntryHeader, SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { ENROLMENT_ID_PATTERN, buildHubFile, certPinOf, checkEnrolmentMac, hubIdOf, isHubAddress, spkiPin } from '@ext/domain/replica/hubFile';
import type { HubFilePayload } from '@ext/domain/replica/hubFile';
import { validateBody } from '@ext/domain/replica/kinds';
import type { RosterAnchor } from '@ext/domain/replica/roster';
import { deviceAt, hubAt } from '@ext/domain/replica/rosterMembers';
import type { KeyRing } from '@ext/domain/replica/rosterView';
import { canonicalize } from '@ext/domain/team/canonical';
import type { PayloadSigner, SignedPayload } from '@ext/domain/team/signedPayload';
import { ProjectRoster } from './append/rosterCache';
import type { RosterCache } from './append/rosterCache';
import type { HubEncryptionKey, HubSigningKey } from './keys';
import type { RateLimits } from './limits';
import { StoreError } from './store/hubStore';
import type { BlobInput, BlobRef, EntryRow, GrantInput, HubStore } from './store/hubStore';

/** Everything the hub is: its ids and keys, its certificate pin and, when set, its public address. */
export interface HubIdentity {
  /** hub- and the first 16 hex characters of the writer id, as hub.admit names it. */
  hub: string;
  writer: string;
  publicKey: string;
  signer: PayloadSigner;
  x25519: string;
  x25519Sig: string;
  x25519Private: KeyObject;
  certPin: string;
  address?: string;
}

/** The hub's identity from its two keys and its certificate (PEM text or DER bytes) or the certificate's key. The pin is the SPKI pin, so a renewed
 *  certificate with the same key keeps it (32-RESEARCH Pitfall 6). */
export function hubIdentityOf(signing: HubSigningKey, encryption: HubEncryptionKey, certificate: string | Buffer | KeyObject, address?: string): HubIdentity {
  const certPin = typeof certificate === 'string' || Buffer.isBuffer(certificate) ? certPinOf(certificate) : spkiPin(certificate);
  return {
    hub: hubIdOf(signing.writer),
    writer: signing.writer,
    publicKey: signing.publicKey,
    signer: signing.signer,
    x25519: encryption.x25519,
    x25519Sig: encryption.x25519Sig,
    x25519Private: encryption.privateKey,
    certPin,
    ...(address === undefined || address === '' ? {} : { address }),
  };
}

export const HUB_FILE_DAYS = Object.freeze({ min: 1, max: 30, default: 7 });
const DAY_MS = 24 * 60 * 60 * 1000;
const ENROLMENT_SECRET_INFO = 'near-ai-hub/enrolment-secret/v1';

export const ISSUE_REFUSALS = {
  days: 'A hub file lasts from 1 to 30 days. Give a whole number of days in that range, such as 7.',
  address: 'The hub has no public address, so a hub file cannot say where to reach it. Set HUB_PUBLIC_ADDRESS to the name and port devices use, such as hub.example.org:8443.',
} as const;
export type IssueRefusal = keyof typeof ISSUE_REFUSALS;
export type IssueResult = { ok: true; file: SignedPayload<HubFilePayload>; text: string } | { ok: false; reason: IssueRefusal; message: string };

/** The enrolment secret of one enrolment id: HKDF-SHA256 of the hub's X25519 private key, salted with the id. Never stored. */
function enrolmentSecretOf(identity: HubIdentity, enrolment: string): Buffer {
  const jwk = identity.x25519Private.export({ format: 'jwk' }) as { d?: string };
  const ikm = Buffer.from(jwk.d ?? '', 'base64url');
  try {
    return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(enrolment, 'utf8'), Buffer.from(ENROLMENT_SECRET_INFO, 'utf8'), 32));
  } finally {
    ikm.fill(0);
  }
}

/** Makes a hub file for the operator: a new enrolment id and secret, valid for days days. The store keeps the secret's hash only. */
export function issueHubFile(store: HubStore, identity: HubIdentity, options: { days: number; now: Date; address?: string }): IssueResult {
  const { days, now } = options;
  if (!Number.isSafeInteger(days) || days < HUB_FILE_DAYS.min || days > HUB_FILE_DAYS.max) return { ok: false, reason: 'days', message: ISSUE_REFUSALS.days };
  const address = options.address ?? identity.address;
  if (address === undefined || !isHubAddress(address)) return { ok: false, reason: 'address', message: ISSUE_REFUSALS.address };
  const enrolment = `enr-${randomBytes(8).toString('hex')}`;
  const secret = enrolmentSecretOf(identity, enrolment);
  const expiresAt = now.getTime() + days * DAY_MS;
  try {
    store.putEnrolment({ enrolment, secretHash: sha256Hex(secret), expiresAt, createdAt: now.getTime() });
    const file = buildHubFile(identity.signer, {
      address,
      certPin: identity.certPin,
      x25519: identity.x25519,
      x25519Sig: identity.x25519Sig,
      enrolment,
      enrolmentSecret: secret.toString('base64url'),
      expiresAt: new Date(expiresAt).toISOString(),
      now,
    });
    return { ok: true, file, text: `${JSON.stringify(file)}\n` };
  } finally {
    secret.fill(0);
  }
}

export const ENROL_REFUSALS = {
  'rate-limited': 'Too many enrolments came from this address. Wait the time the hub gives, then try again.',
  malformed: 'The enrolment is not in a shape this hub can read. Connect the project to the hub again from the staff lead\'s computer.',
  'enrolment-unknown': 'This hub did not issue that hub file, or can no longer use it. Ask the hub operator for a new hub file.',
  'enrolment-expired': 'The hub file has expired. Ask the hub operator for a new hub file.',
  'enrolment-used': 'The hub file was already used for a project, and each hub file enrols one project. Ask the hub operator for a new hub file.',
  'bad-mac': 'The enrolment was not made with this hub file\'s secret. Use the hub file the operator gave you, or ask for a new one.',
  'project-exists': 'This hub already holds that project.',
  'no-base-grant': 'The roster does not give this hub the key of the roster part of the project. The staff lead admits this hub again, then connects the project.',
  'wrong-key': 'The roster admits this hub with an encryption key it does not have. The staff lead admits this hub again with the key in the current hub file.',
  'genesis-unreadable': 'The hub cannot open the project\'s first entry with the key it was given, so it cannot follow the roster.',
  'roster-mismatch': 'The roster the hub folded does not end where the staff lead\'s computer says it does. Connect the project again from the staff lead\'s computer.',
  'not-admitted': 'The roster does not admit this hub. The staff lead admits this hub, then connects the project.',
  'wrong-pin': 'The roster admits this hub with another certificate pin. The staff lead admits this hub again with its current certificate pin.',
} as const;
export type EnrolRefusal = keyof typeof ENROL_REFUSALS;

/** What the staff lead's device sends (32-25 builds it). */
export interface EnrolRequest {
  enrolment: string;
  project: string;
  entries: SealedEntry[];
  grants: unknown[];
  blobs?: SealedBlob[];
  rosterHead: string;
  mac: string;
}

export interface EnrolContext {
  store: HubStore;
  identity: HubIdentity;
  now: Date;
  /** When given, the enrolled roster is placed in it. */
  cache?: RosterCache;
  /** When both are given, the address bucket for enrol is taken first (D-39). */
  limits?: RateLimits;
  address?: string;
  /** Signature check of one header; injectable for tests. */
  verify?: (header: EntryHeader, publicKey: string) => boolean;
}

export type EnrolResult = { ok: true; project: string; rosterHead: string; roster: ProjectRoster } | { ok: false; reason: EnrolRefusal; message: string; retryAfterSeconds?: number };

const refuse = (reason: EnrolRefusal, extra: { retryAfterSeconds?: number } = {}): EnrolResult => ({ ok: false, reason, message: ENROL_REFUSALS[reason], ...extra });

const REQUEST_KEYS = new Set(['enrolment', 'project', 'entries', 'grants', 'blobs', 'rosterHead', 'mac']);
/** Sanity caps; the route also caps the request body at 4 MiB. */
const MAX_ENTRIES = 20_000;
const MAX_GRANTS = 4096;
const MAX_BLOBS = 256;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface ReadEntry {
  header: EntryHeader;
  hash: string;
  body: string;
  wire: Buffer;
}

interface ReadRequest {
  enrolment: string;
  project: string;
  entries: ReadEntry[];
  grants: unknown[];
  blobs: Map<string, SealedBlob>;
  rosterHead: string;
  mac: string;
}

/** The request read from hostile input: exact keys, every entry a base-stream entry whose body matches its header, one log per writer from seq 0. */
function readRequest(value: unknown): ReadRequest | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) if (!REQUEST_KEYS.has(key)) return undefined;
  const { enrolment, project, entries, grants, blobs, rosterHead, mac } = value;
  if (typeof enrolment !== 'string' || !ENROLMENT_ID_PATTERN.test(enrolment)) return undefined;
  if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (typeof rosterHead !== 'string' || !HASH_PATTERN.test(rosterHead)) return undefined;
  if (typeof mac !== 'string' || mac.length > 64) return undefined;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) return undefined;
  if (!Array.isArray(grants) || grants.length > MAX_GRANTS) return undefined;
  const blobList = blobs ?? [];
  if (!Array.isArray(blobList) || blobList.length > MAX_BLOBS) return undefined;

  const read: ReadEntry[] = [];
  const hashes = new Set<string>();
  for (const raw of entries as unknown[]) {
    if (!isRecord(raw) || typeof raw.body !== 'string') return undefined;
    const shape = parseHeaderShape(raw.header);
    if (!shape.ok || shape.header.stream !== project) return undefined;
    const header = shape.header;
    const body = raw.body;
    if (body.length > Math.ceil((header.body.size * 4) / 3) + 4 || !BASE64URL.test(body)) return undefined;
    const wire = Buffer.from(body, 'base64url');
    if (wire.toString('base64url') !== body || wire.length !== header.body.size || sha256Hex(wire) !== header.body.hash) return undefined;
    const hash = entryHash(header);
    if (hashes.has(hash)) return undefined;
    hashes.add(hash);
    read.push({ header, hash, body, wire });
  }
  // One log per writer: seq 0, 1, 2 ... each citing the one before.
  const byWriter = new Map<string, ReadEntry[]>();
  for (const entry of read) byWriter.set(entry.header.writer, [...(byWriter.get(entry.header.writer) ?? []), entry]);
  for (const log of byWriter.values()) {
    log.sort((a, b) => a.header.seq - b.header.seq);
    let prev = '0'.repeat(64);
    for (let seq = 0; seq < log.length; seq += 1) {
      const entry = log[seq] as ReadEntry;
      if (entry.header.seq !== seq || entry.header.prev !== prev) return undefined;
      prev = entry.hash;
    }
  }

  const blobMap = new Map<string, SealedBlob>();
  for (const blob of blobList as unknown[]) {
    if (!isRecord(blob) || typeof blob.hash !== 'string' || !HASH_PATTERN.test(blob.hash) || typeof blob.bytes !== 'string' || !BASE64URL.test(blob.bytes)) return undefined;
    const bytes = Buffer.from(blob.bytes, 'base64url');
    if (bytes.length > BLOB_MAX_BYTES || bytes.toString('base64url') !== blob.bytes || sha256Hex(bytes) !== blob.hash) return undefined;
    blobMap.set(blob.hash, { hash: blob.hash, bytes: blob.bytes });
  }
  return { enrolment, project, entries: read, grants: grants as unknown[], blobs: blobMap, rosterHead, mac };
}

/** The base cell keys wrapped to this hub, and whether some wrap to it did not open (the lead used another X25519 key). */
function baseKeys(grants: readonly unknown[], identity: HubIdentity, project: string): { ring: KeyRing; wrapped: boolean; opened: boolean } {
  const keys = new Map<string, Buffer>();
  let wrapped = false;
  for (const value of grants) {
    const read = readGrant(value);
    if (!read.ok || read.grant.cell !== project) continue;
    const mine = read.grant.wraps.find((wrap) => wrap.writer === identity.writer);
    if (mine === undefined) continue;
    wrapped = true;
    const slot = `${read.grant.cell}/${read.grant.epoch}`;
    if (keys.has(slot)) continue;
    const key = unwrapEpochKey({ cell: read.grant.cell, epoch: read.grant.epoch, writer: identity.writer, privateKey: identity.x25519Private, wrap: mine.wrap });
    if (key !== undefined) keys.set(slot, key);
  }
  return { ring: (stream, epoch) => keys.get(`${stream}/${epoch}`), wrapped, opened: keys.size > 0 };
}

interface OpenedBody {
  kind: string;
  data: unknown;
  blob?: string;
}

/** A base-stream body opened with the ring, its data read from its blob when it has one; undefined when the hub cannot open it. */
function openEntry(entry: ReadEntry, ring: KeyRing, blobs: ReadonlyMap<string, SealedBlob>): OpenedBody | undefined {
  const key = ring(entry.header.stream, entry.header.epoch);
  if (key === undefined) return undefined;
  const plaintext = openBody(key, entry.header, entry.wire);
  if (plaintext === undefined) return undefined;
  try {
    const checked = validateBody(JSON.parse(plaintext.toString('utf8')) as unknown);
    if (!checked.ok) return undefined;
    if (checked.body.blob === undefined) return { kind: checked.body.kind, data: checked.body.data };
    const blob = blobs.get(checked.body.blob);
    const opened = blob === undefined ? undefined : openBlob(key, entry.header.stream, entry.header.epoch, blob);
    return { kind: checked.body.kind, data: opened === undefined ? undefined : (JSON.parse(opened.toString('utf8')) as unknown), blob: checked.body.blob };
  } catch {
    return undefined;
  }
}

/** The pinned anchor from the genesis body, or undefined when it is not a genesis of this project written by its lead's device. */
function anchorOf(genesis: ReadEntry, opened: OpenedBody | undefined, project: string): RosterAnchor | undefined {
  if (opened === undefined || opened.kind !== 'project.genesis' || !isRecord(opened.data)) return undefined;
  const data = opened.data;
  const lead = data.lead;
  if (data.project !== project || !isRecord(lead) || !isRecord(lead.device)) return undefined;
  const { member, writer } = lead;
  const { publicKey, x25519 } = lead.device;
  if (typeof member !== 'string' || typeof writer !== 'string' || typeof publicKey !== 'string' || typeof x25519 !== 'string') return undefined;
  if (writer !== genesis.header.writer || lead.device.writer !== writer) return undefined;
  return { genesisHash: genesis.hash, project, lead: { member, writer, publicKey, x25519 } };
}

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Puts a project on the hub from its enrolment, or refuses with one of ENROL_REFUSALS. Nothing is stored unless every check passes. */
export async function enrolProject(ctx: EnrolContext, request: unknown): Promise<EnrolResult> {
  const { store, identity, now } = ctx;
  if (ctx.limits !== undefined && ctx.address !== undefined) {
    const taken = ctx.limits.takeAddress('enrol', ctx.address, now.getTime());
    if (!taken.ok) return refuse('rate-limited', { retryAfterSeconds: taken.retryAfterSeconds });
  }
  const read = readRequest(request);
  if (read === undefined) return refuse('malformed');

  // The enrolment id first, so an unknown one costs no HMAC.
  const record = store.enrolment(read.enrolment);
  if (record === undefined) return refuse('enrolment-unknown');
  if (record.usedAt !== undefined) return refuse('enrolment-used');
  if (now.getTime() > record.expiresAt) return refuse('enrolment-expired');

  // The MAC, in constant time, before any roster work. The genesis is the base-stream entry at seq 0 the MAC names; each writer's first entry is a
  // candidate, so the hub finds it by header alone without opening a body.
  const secret = enrolmentSecretOf(identity, read.enrolment);
  let genesis: ReadEntry | undefined;
  try {
    if (!sameText(sha256Hex(secret), record.secretHash)) return refuse('enrolment-unknown');
    const key = secret.toString('base64url');
    for (const entry of read.entries) {
      if (entry.header.seq !== 0) continue;
      const fields = { enrolment: read.enrolment, hub: identity.hub, project: read.project, genesisHash: entry.hash, rosterHead: read.rosterHead };
      if (checkEnrolmentMac(key, fields, read.mac)) genesis = entry;
    }
  } finally {
    secret.fill(0);
  }
  if (genesis === undefined) return refuse('bad-mac');
  if (store.project(read.project) !== undefined) return refuse('project-exists');

  // The base cell key wrapped to this hub's X25519 key: without one the hub cannot follow the roster.
  const keys = baseKeys(read.grants, identity, read.project);
  if (!keys.wrapped) return refuse('no-base-grant');
  if (!keys.opened) return refuse('wrong-key');
  const anchor = anchorOf(genesis, openEntry(genesis, keys.ring, read.blobs), read.project);
  if (anchor === undefined) return refuse('genesis-unreadable');

  const roster = ProjectRoster.build({
    project: read.project,
    anchor,
    entries: read.entries.map((entry) => ({ header: entry.header, body: entry.body })),
    grants: read.grants,
    blobs: read.blobs,
    equivocations: [],
    identity,
    now,
  });
  if (roster.head !== read.rosterHead) return refuse('roster-mismatch');

  // Every entry is signed by a device the roster knows; an entry the fold refused is still that writer's log and is kept.
  const verify = ctx.verify ?? verifyHeader;
  for (const entry of read.entries) {
    const device = roster.view.deviceKey(entry.header.writer);
    if (device === undefined || !verify(entry.header, device.publicKey)) return refuse('malformed');
  }

  // hub.admit in force at the head, for this hub's writer, X25519 key and current certificate pin.
  const members = roster.state.members;
  const hubRecord = hubAt(members, identity.hub, roster.headPosition);
  const device = deviceAt(members, identity.writer, roster.headPosition);
  if (hubRecord === undefined || device === undefined || device.member !== identity.hub || device.kind !== 'hub') return refuse('not-admitted');
  if (device.x25519 !== identity.x25519) return refuse('wrong-key');
  if (hubRecord.certPin !== identity.certPin) return refuse('wrong-pin');
  if (!(roster.accessList(read.project) ?? []).includes(identity.writer)) return refuse('no-base-grant');

  const at = now.getTime();
  const rows: EntryRow[] = read.entries.map((entry) => ({ header: canonicalize(entry.header), body: entry.body, receivedAt: at }));
  const grants: GrantInput[] = [];
  for (const value of read.grants) {
    const grant = readGrant(value);
    if (grant.ok && roster.placedGrants.has(grant.hash) && !grants.some((item) => item.hash === grant.hash)) {
      grants.push({ hash: grant.hash, cell: grant.grant.cell, epoch: grant.grant.epoch, body: canonicalize(value), receivedAt: at });
    }
  }
  const blobs: BlobInput[] = [];
  const blobRefs: BlobRef[] = [];
  for (const entry of read.entries) {
    const blob = openEntry(entry, roster.ring, read.blobs)?.blob;
    const sealed = blob === undefined ? undefined : read.blobs.get(blob);
    if (sealed === undefined) continue;
    if (!blobs.some((item) => item.hash === sealed.hash)) blobs.push({ hash: sealed.hash, bytes: Buffer.from(sealed.bytes, 'base64url'), uploadedBy: anchor.lead.writer });
    blobRefs.push({ entry: entry.hash, blob: sealed.hash, stream: read.project });
  }
  try {
    await store.enrolProject({
      project: { project: read.project, genesisHash: anchor.genesisHash, anchor: canonicalize(anchor) },
      entries: rows,
      grants,
      blobs,
      blobRefs,
      enrolment: read.enrolment,
      at,
    });
  } catch (error) {
    // Another enrolment may have won the race between the checks above and the transaction.
    if (error instanceof StoreError && error.id === 'enrolment-used') return refuse('enrolment-used');
    if (error instanceof StoreError && error.id === 'project-exists') return refuse('project-exists');
    if (error instanceof StoreError && error.id === 'not-found') return refuse('enrolment-unknown');
    throw error;
  }
  ctx.cache?.replace(read.project, roster);
  return { ok: true, project: read.project, rosterHead: roster.head, roster };
}

/** sha256 hex of text, for tests that check the store keeps a hash. */
export const secretHashOf = (secret: string): string => createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex');
