// Accepted-frontier evidence is private and read-only. These checks confer no grants or write authority.
import { createHash } from 'node:crypto';
import { dominates } from '../gate/dominance';
import type { DominanceContext } from '../gate/dominance';
import { parseClearance, parseLabel } from '../gate/labels';
import { canonicalBytes, verifySignature } from '../team/canonical';
import { isRecord } from '../team/validate';
import { BLOB_MAX_BYTES, GENESIS_PREV, HASH_PATTERN, SEALED_OVERHEAD, STREAM_ID_PATTERN, blobBytesHash, entryHash, openBlob } from './entry';
import type { SealedBlob, SealedEntry } from './entry';
import { buildFromCompaction, inspectState } from './doc';
import { MAX_STATE_BYTES } from './kindSchemas/doc';
import { CELL_ACCESS_FEATURE } from './features';
import { isRosterWriterAt, rosterView } from './roster';
import type { RosterState } from './roster';
import { epochAt, granteesAt } from './rosterCells';
import { deviceAt, memberAt } from './rosterMembers';
import { verifiedCellAccess } from './rotationProof';
import type { KeyRing, ReplicaContext } from './rosterView';
import { sealedBlobWithin } from './updateGuard';
import { verifyEntry } from './verify';
import type { VerifiedEntry } from './verify';
import { readVersionBlob } from './versions';

const MAX_LEAVES = 65_536;

interface EntryHead { writer: string; sequence: number; hash: string }
export type FrontierLeaf = ({ kind: 'entry' } & EntryHead) | { kind: 'blob'; entry: string; hash: string };
export interface FrontierMembership { entries: number; blobs: number; root: string }
export interface FrontierProof { index: number; siblings: readonly string[] }

export interface FrontierStatement {
  version: 1;
  project: string;
  genesis: string;
  stream: string;
  before: string;
  requirement: string;
  heads: readonly EntryHead[];
  membership: FrontierMembership;
}

export interface FrontierCustodyContext {
  pin: { project: string; genesis: string };
  roster: RosterState;
  accessEntry: string;
  opening: unknown;
  // Only independently verified private evidence for this project and exact historical position may cross this seam.
  historicalPolicyAt: (stream: string, roster: string, epoch: number) => { label: unknown; context: DominanceContext } | undefined;
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
const isStream = (value: unknown): value is string => typeof value === 'string' && STREAM_ID_PATTERN.test(value);
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.concat([Buffer.from(`near-ai/accepted-frontier/1/${domain}\n`), canonicalBytes(value)]);
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domainBytes(domain, value)).digest('hex');
}

const EMPTY = digest('empty-leaf', null);
const node = (left: string, right: string): string => digest('node', [left, right]);
const membershipRoot = (entries: number, blobs: number, treeRoot: string): string => digest('membership', [entries, blobs, treeRoot]);

function validHead(value: Record<string, unknown>): boolean {
  return isHash(value.writer) && natural(value.sequence) && isHash(value.hash);
}

function validLeaf(value: unknown): value is FrontierLeaf {
  if (!isRecord(value)) return false;
  return value.kind === 'entry'
    ? closed(value, ['kind', 'writer', 'sequence', 'hash']) && validHead(value)
    : value.kind === 'blob' && closed(value, ['kind', 'entry', 'hash']) && isHash(value.entry) && isHash(value.hash);
}

function validMembership(value: unknown): value is FrontierMembership {
  return closed(value, ['entries', 'blobs', 'root']) && natural(value.entries) && natural(value.blobs) && isHash(value.root) &&
    value.entries + value.blobs <= MAX_LEAVES && (value.entries > 0 || value.blobs === 0);
}

function tuple(leaf: FrontierLeaf): readonly unknown[] {
  return leaf.kind === 'entry' ? [leaf.writer, leaf.sequence, leaf.hash] : [leaf.entry, leaf.hash];
}

const leafDigest = (leaf: FrontierLeaf): string => digest(`${leaf.kind}-leaf`, tuple(leaf));

function proofDepth(total: number): number {
  return Math.ceil(Math.log2(Math.max(1, total)));
}

export function buildFrontierMembership(leaves: readonly FrontierLeaf[]):
  { commitment: FrontierMembership; proof(leaf: FrontierLeaf): FrontierProof | undefined } | undefined {
  if (leaves.length > MAX_LEAVES) return undefined;
  const occupied = new Set<string>();
  const sorted = [];
  let entries = 0;
  for (const leaf of leaves) {
    if (!validLeaf(leaf)) return undefined;
    const slot = leaf.kind === 'entry' ? `entry/${leaf.writer}/${leaf.sequence}` : `blob/${leaf.entry}/${leaf.hash}`;
    if (occupied.has(slot)) return undefined;
    occupied.add(slot);
    if (leaf.kind === 'entry') entries += 1;
    sorted.push({ kind: leaf.kind, sortBytes: canonicalBytes(tuple(leaf)), hash: leafDigest(leaf) });
  }
  const blobs = leaves.length - entries;
  if (entries === 0 && blobs > 0) return undefined;
  sorted.sort((a, b) => a.kind === b.kind ? Buffer.compare(a.sortBytes, b.sortBytes) : a.kind === 'entry' ? -1 : 1);
  const indices = new Map(sorted.map(({ hash }, index) => [hash, index]));
  const depth = proofDepth(sorted.length);
  const layer = sorted.map(({ hash }) => hash);
  while (layer.length < 2 ** depth) layer.push(EMPTY);
  const layers = [layer];
  while (layers.length <= depth) {
    const previous = layers[layers.length - 1];
    const next = [];
    for (let index = 0; index < previous.length; index += 2) next.push(node(previous[index], previous[index + 1]));
    layers.push(next);
  }
  const commitment = { entries, blobs, root: membershipRoot(entries, blobs, layers[depth][0]) };
  return {
    commitment,
    proof(leaf) {
      if (!validLeaf(leaf)) return undefined;
      const index = indices.get(leafDigest(leaf));
      if (index === undefined) return undefined;
      return { index, siblings: layers.slice(0, -1).map((level, height) => level[(index >> height) ^ 1]) };
    }
  };
}

export function verifiesFrontierMembership(commitment: unknown, leaf: unknown, proof: unknown): boolean {
  if (!validMembership(commitment) || !validLeaf(leaf) || !closed(proof, ['index', 'siblings']) || !natural(proof.index)) return false;
  const { entries, blobs, root } = commitment;
  const { index, siblings } = proof;
  const total = entries + blobs;
  if (index >= total || (leaf.kind === 'entry') !== (index < entries) || !Array.isArray(siblings) || siblings.length !== proofDepth(total)) return false;
  let hash = leafDigest(leaf);
  let padding = EMPTY;
  for (let height = 0; height < siblings.length; height += 1) {
    const sibling: unknown = siblings[height];
    const siblingStart = ((index >> height) ^ 1) << height;
    if (!isHash(sibling) || (siblingStart >= total && sibling !== padding)) return false;
    hash = ((index >> height) & 1) === 0 ? node(hash, sibling) : node(sibling, hash);
    padding = node(padding, padding);
  }
  return membershipRoot(entries, blobs, hash) === root;
}

function validStatement(value: unknown): value is FrontierStatement {
  if (!closed(value, ['version', 'project', 'genesis', 'stream', 'before', 'requirement', 'heads', 'membership']) ||
    value.version !== 1 || !isStream(value.project) || !isStream(value.stream) || value.stream === value.project ||
    !isHash(value.genesis) || !isHash(value.before) || !isHash(value.requirement) || !validMembership(value.membership) ||
    !Array.isArray(value.heads) || value.heads.length > value.membership.entries) return false;
  let prev = '';
  let entries = 0;
  for (const head of value.heads) {
    if (!closed(head, ['writer', 'sequence', 'hash']) || !validHead(head) || typeof head.writer !== 'string' ||
      !natural(head.sequence) || head.writer <= prev || head.sequence >= value.membership.entries) return false;
    prev = head.writer;
    entries += head.sequence + 1;
  }
  return entries === value.membership.entries;
}

export function frontierRoot(value: unknown): string | undefined {
  return validStatement(value) ? digest('statement-root', value) : undefined;
}

export function frontierSigningBytes(statement: FrontierStatement, writer: string): Buffer {
  return domainBytes('custodian-attestation', [statement, writer]);
}

export function verifiesFrontierCustody(value: unknown, context: FrontierCustodyContext): boolean {
  if (!closed(value, ['payload', 'writer', 'signature']) || !validStatement(value.payload) ||
    !isHash(value.writer) || typeof value.signature !== 'string') return false;
  const { payload, writer, signature } = value;
  const { roster, pin, opening } = context;
  if (pin.project !== payload.project || pin.genesis !== payload.genesis ||
    roster.anchor.project !== pin.project || roster.anchor.genesisHash !== pin.genesis || roster.pending.length !== 0) return false;
  const fence = roster.requiredFrom.get(CELL_ACCESS_FEATURE);
  const access = roster.accessRevision;
  if (fence === undefined || roster.positions[fence] !== payload.requirement || roster.positions[fence - 1] !== payload.before ||
    access === undefined || access.entry !== context.accessEntry || roster.accessHistory.size !== 1 ||
    roster.accessHistory.get(access.entry) !== access ||
    (roster.positionOf.get(access.predecessor) ?? -1) < fence ||
    !closed(opening, ['commitment', 'cell']) || !isRecord(opening.commitment) || opening.commitment.frontierRoot !== digest('statement-root', payload) ||
    verifiedCellAccess(access, opening.commitment, opening.cell, payload.stream) === undefined) return false;

  const before = fence - 1;
  const device = deviceAt(roster.members, writer, before);
  const epoch = epochAt(roster.cells, payload.stream, before);
  if (device === undefined || epoch === undefined || !isRosterWriterAt(roster, writer, before) ||
    granteesAt(roster.cells, payload.stream, before, (candidate) => deviceAt(roster.members, candidate, before) !== undefined)?.includes(writer) !== true ||
    !verifySignature(frontierSigningBytes(payload, writer), signature, device.publicKey)) return false;
  const declared = memberAt(roster.members, device.member, before)?.clearance;
  const historical = context.historicalPolicyAt(payload.stream, payload.before, epoch);
  if (!isRecord(declared) || historical === undefined || !Number.isFinite(historical.context.now)) return false;
  const { handling: _handling, ...fields } = declared;
  const clearance = parseClearance(fields, historical.context.scales);
  const label = parseLabel(historical.label, historical.context.scales);
  return clearance.ok && label.ok && dominates(clearance.value, label.value, historical.context);
}

export type FrontierArchiveResult =
  | { status: 'waiting' | 'refused' }
  | { status: 'ready'; entries: readonly SealedEntry[]; blobs: readonly SealedBlob[] };

const WAITING = Object.freeze({ status: 'waiting' } as const);
const REFUSED = Object.freeze({ status: 'refused' } as const);

function archivedBlob(value: unknown): SealedBlob | undefined {
  if (!closed(value, ['hash', 'bytes'])) return undefined;
  const { hash, bytes } = value;
  if (!isHash(hash) || typeof bytes !== 'string') return undefined;
  const blob = { hash, bytes };
  if (!sealedBlobWithin(blob, BLOB_MAX_BYTES - SEALED_OVERHEAD) || !/^[A-Za-z0-9_-]+$/.test(bytes) ||
    Buffer.from(bytes, 'base64url').toString('base64url') !== bytes || blobBytesHash(blob) !== hash) return undefined;
  return Object.freeze(blob);
}

type NestedReference = { kind: 'compaction' | 'version'; hash: string };
function nestedReference(entry: VerifiedEntry): NestedReference | 'unsupported' | undefined {
  const { kind } = entry.body;
  if (kind === 'obs.segment' || kind === 'obs.coalesced') return 'unsupported';
  if (kind !== 'doc.compact' && kind !== 'version.propose') return undefined;
  if (!isRecord(entry.data)) return 'unsupported';
  const hash = kind === 'doc.compact' ? entry.data.stateBlob : entry.data.textBlob;
  if (!isHash(hash)) return 'unsupported';
  return { kind: kind === 'doc.compact' ? 'compaction' : 'version', hash };
}

function validNested(reference: NestedReference, entry: VerifiedEntry, ctx: ReplicaContext): boolean {
  if (reference.kind === 'version') return readVersionBlob(ctx, entry, reference.hash).ok;
  const { stream, epoch } = entry.header;
  const key = ctx.keys(stream, epoch);
  const blob = ctx.blobs(reference.hash);
  if (key === undefined || blob === undefined || !sealedBlobWithin(blob, MAX_STATE_BYTES)) return false;
  const plain = openBlob(key, stream, epoch, blob);
  if (plain === undefined) return false;
  const result = inspectState(plain);
  return !('error' in result) && result.structs.every((struct) => struct.parentOk) && buildFromCompaction(plain, []) !== undefined;
}

function completeChain(entries: readonly SealedEntry[], heads: readonly EntryHead[]): boolean {
  const ordered = [...entries].sort((a, b) => a.header.writer === b.header.writer
    ? a.header.seq - b.header.seq : a.header.writer < b.header.writer ? -1 : 1);
  let offset = 0;
  for (const head of heads) {
    let prev = GENESIS_PREV;
    for (let seq = 0; seq <= head.sequence; seq += 1) {
      const sealed = ordered[offset];
      if (sealed === undefined || sealed.header.writer !== head.writer || sealed.header.seq !== seq || sealed.header.prev !== prev) return false;
      prev = entryHash(sealed.header);
      offset += 1;
    }
    if (prev !== head.hash) return false;
  }
  return offset === ordered.length;
}

/** Opens private historical objects from an independently authenticated, selected file. No live store or key-settlement path is involved. */
export function openAcceptedFrontier(file: unknown, context: FrontierCustodyContext & { historicalKey: KeyRing; expectedStream?: string }): FrontierArchiveResult {
  if (!closed(file, ['signed', 'entries', 'blobs', 'proofs']) || !isRecord(file.signed) ||
    !validStatement(file.signed.payload) || !Array.isArray(file.entries) || !Array.isArray(file.blobs) || !Array.isArray(file.proofs) ||
    !verifiesFrontierCustody(file.signed, context)) return REFUSED;
  const { membership, heads, stream, before } = file.signed.payload;
  if (context.expectedStream !== undefined && stream !== context.expectedStream) return REFUSED;
  if (file.entries.length > membership.entries || file.blobs.length > membership.blobs ||
    file.proofs.length > membership.entries + membership.blobs) return REFUSED;
  if (file.entries.length < membership.entries || file.proofs.length < membership.entries + membership.blobs) return WAITING;

  const proofs = new Set<string>();
  const leaves: FrontierLeaf[] = [];
  for (const row of file.proofs) {
    if (!closed(row, ['leaf', 'proof']) || !validLeaf(row.leaf) || !verifiesFrontierMembership(membership, row.leaf, row.proof)) return REFUSED;
    const hash = leafDigest(row.leaf);
    if (proofs.has(hash)) return REFUSED;
    proofs.add(hash);
    leaves.push(row.leaf);
  }
  const canonical = buildFrontierMembership(leaves);
  if (canonical?.commitment.root !== membership.root) return REFUSED;

  const blobs = new Map<string, SealedBlob>();
  for (const value of file.blobs) {
    const blob = archivedBlob(value);
    if (blob === undefined || blobs.has(blob.hash)) return REFUSED;
    blobs.set(blob.hash, blob);
  }
  const ctx: ReplicaContext = { roster: rosterView(context.roster), keys: context.historicalKey, blobs: (hash) => blobs.get(hash), now: new Date(0) };
  const foundBlobs = new Set<string>();
  const entries: SealedEntry[] = [];
  const prefixPosition = ctx.roster.rosterPosition(before);
  if (prefixPosition === undefined) return REFUSED;
  for (const value of file.entries) {
    if (!closed(value, ['header', 'body']) || typeof value.body !== 'string') return REFUSED;
    const checked = verifyEntry(value, ctx);
    if (checked.status === 'held') return checked.reason === 'missing-blob' || checked.reason === 'missing-key' ? WAITING : REFUSED;
    if (checked.status !== 'verified' || checked.entry.keep !== undefined) return REFUSED;
    const { header, hash, body } = checked.entry;
    if (header.stream !== stream || (ctx.roster.rosterPosition(body.roster) ?? Infinity) > prefixPosition ||
      !proofs.delete(leafDigest({ kind: 'entry', writer: header.writer, sequence: header.seq, hash }))) return REFUSED;

    const nested = nestedReference(checked.entry);
    if (nested === 'unsupported') return REFUSED;
    const referred = new Set([body.blob, nested?.hash]);
    for (const ref of referred) {
      if (ref === undefined) continue;
      if (!proofs.delete(leafDigest({ kind: 'blob', entry: hash, hash: ref }))) return REFUSED;
      if (!blobs.has(ref)) return WAITING;
      foundBlobs.add(ref);
    }
    if (nested !== undefined && !validNested(nested, checked.entry, ctx)) return REFUSED;
    entries.push(Object.freeze({ header: Object.freeze({ ...header, body: Object.freeze({ ...header.body }) }), body: value.body }));
  }
  if (proofs.size !== 0 || foundBlobs.size !== blobs.size || !completeChain(entries, heads)) return REFUSED;
  return Object.freeze({ status: 'ready', entries: Object.freeze(entries), blobs: Object.freeze([...blobs.values()]) });
}
