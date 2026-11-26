// Legacy archive fixtures. No shipped replica path imports this adapter.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { dominates } from '../../domain/gate/dominance';
import type { DominanceContext } from '../../domain/gate/dominance';
import { parseClearance, parseLabel } from '../../domain/gate/labels';
import { selectedFrontierFence, validFrontierStatementFields, validateFrontierInventory } from '../../domain/replica/acceptedFrontier';
import type { FrontierSelection, FrontierStatementFields } from '../../domain/replica/acceptedFrontier';
import { HASH_PATTERN, STREAM_ID_PATTERN, parseHeaderShape, sha256Hex } from '../../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { isRosterWriterAt } from '../../domain/replica/roster';
import { epochAt, granteesAt } from '../../domain/replica/rosterCells';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import type { KeyRing } from '../../domain/replica/rosterView';
import { canonicalBytes, verifySignature } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import type { ReplicaStore } from '../../staff/replica/store';
import { syncFolder } from '../../staff/staffFiles';

type ReplicaPathProblem = 'symlink' | 'not-a-store' | 'unreadable';

export type FrontierStatement = FrontierStatementFields & { version: 1 };
const ACCEPTED_FRONTIER_DIR = 'accepted-frontiers';
const MAX_ACCEPTED_FRONTIER_BYTES = 32 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface FrontierCustodyContext extends FrontierSelection {
  // Only independently verified private evidence for this project and exact historical position may cross this seam.
  historicalPolicyAt: (stream: string, roster: string, epoch: number) => { label: unknown; context: DominanceContext } | undefined;
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
function validStatement(value: unknown): value is FrontierStatement {
  return closed(value, ['version', 'project', 'genesis', 'stream', 'before', 'requirement', 'heads', 'membership']) &&
    value.version === 1 && validFrontierStatementFields(value);
}

function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.concat([Buffer.from(`near-ai/accepted-frontier/1/${domain}\n`), canonicalBytes(value)]);
}

export function frontierRoot(value: unknown): string | undefined {
  return validStatement(value) ? createHash('sha256').update(domainBytes('statement-root', value)).digest('hex') : undefined;
}

export function frontierSigningBytes(statement: FrontierStatement, writer: string): Buffer {
  return domainBytes('custodian-attestation', [statement, writer]);
}

export function verifiesFrontierCustody(value: unknown, context: FrontierCustodyContext): boolean {
  if (!closed(value, ['payload', 'writer', 'signature']) || !validStatement(value.payload) ||
    !isHash(value.writer) || typeof value.signature !== 'string') return false;
  const { payload, writer, signature } = value;
  const { roster } = context;
  const root = frontierRoot(payload);
  if (root === undefined) return false;
  const fence = selectedFrontierFence(payload, context, root);
  if (fence === undefined) return false;
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

export function openAcceptedFrontier(file: unknown, context: FrontierCustodyContext & { historicalKey: KeyRing; expectedStream?: string }): FrontierArchiveResult {
  if (!closed(file, ['signed', 'entries', 'blobs', 'proofs']) || !isRecord(file.signed) ||
    !validStatement(file.signed.payload) ||
    !verifiesFrontierCustody(file.signed, context) || !Array.isArray(file.entries) || !Array.isArray(file.blobs)) return REFUSED;
  const inventory = validateFrontierInventory(file, file.signed.payload, context);
  if (inventory === 'missing') return WAITING;
  if (inventory === 'invalid') return REFUSED;

  const entries: SealedEntry[] = [];
  for (const value of file.entries) {
    if (!isRecord(value) || typeof value.body !== 'string') return REFUSED;
    const parsed = parseHeaderShape(value.header);
    if (!parsed.ok) return REFUSED;
    entries.push(Object.freeze({ header: Object.freeze({ ...parsed.header, body: Object.freeze({ ...parsed.header.body }) }), body: value.body }));
  }
  const blobs = file.blobs.map(({ hash, bytes }: SealedBlob) => Object.freeze({ hash, bytes }));
  return Object.freeze({ status: 'ready', entries: Object.freeze(entries), blobs: Object.freeze(blobs) });
}

/** Is any part from `root` down `parts` a symbolic link? Missing parts are fine (made later). Anything else that is not a folder is not a store. */
async function checkPath(root: string, parts: readonly string[]): Promise<ReplicaPathProblem | undefined> {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return 'symlink';
      if (!info.isDirectory()) return 'not-a-store';
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      return 'unreadable';
    }
  }
  return undefined;
}

/** Makes `parts` under `base`, refusing a symbolic link on the way. */
async function ensureDir(base: string, parts: readonly string[]): Promise<string> {
  const problem = await checkPath(base, parts);
  if (problem) throw new Error(problem);
  const dir = path.join(base, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Syncs the fixture bytes before installing them atomically. */
async function writeAtomic(
  file: string, bytes: Buffer, mode: number, beforePublish: () => Promise<void>
): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await beforePublish();
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function frontierFileHandle(scope: string, bytes: Buffer): string {
  return sha256Hex(canonicalBytes([scope, sha256Hex(bytes)]));
}

/** Reads bounded exact bytes without following links or an unbounded file growth. */
async function readFrontierFile(file: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ACCEPTED_FRONTIER_BYTES) throw new Error('unreadable');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('unreadable');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error('unreadable');
    return bytes;
  } finally {
    await handle.close();
  }
}

const FRONTIER_REFUSED = { status: 'refused' } as const;

interface FrontierStoreRequest extends FrontierCustodyContext {
  stream: string;
  reader: string;
  expectedSnapshot: string;
  historicalKey: KeyRing;
}

type FrontierStoreResult = { status: 'ready'; handle: string } | { status: 'waiting' | 'refused' };

/** Keeps immutable verified history outside the live log, blob and grant namespaces. */
export async function putAcceptedFrontier(store: ReplicaStore, input: Buffer, request: FrontierStoreRequest): Promise<FrontierStoreResult> {
  if (input.length > MAX_ACCEPTED_FRONTIER_BYTES) return FRONTIER_REFUSED;
  const bytes = Buffer.from(input);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return await store['locked'](async (): Promise<FrontierStoreResult> => {
      const scope = await frontierScope(store, request);
      if (scope === undefined) return FRONTIER_REFUSED;
      const verified = openAcceptedFrontier(value, { ...request, expectedStream: request.stream });
      if (verified.status !== 'ready') return verified;
      const handle = frontierFileHandle(scope, bytes);
      const dir = await ensureDir(store.dir, [ACCEPTED_FRONTIER_DIR]);
      const file = path.join(dir, `${handle}.json`);
      const existing = await readFrontierFile(file);
      if (existing !== undefined) return existing.equals(bytes) ? { status: 'ready', handle } : FRONTIER_REFUSED;

      await syncFolder(dir);
      await syncFolder(store.dir);
      await writeAtomic(file, bytes, 0o600, async () => {
        if (await frontierScope(store, request) !== scope ||
          openAcceptedFrontier(value, { ...request, expectedStream: request.stream }).status !== 'ready') throw new Error('snapshot-changed');
      });
      await syncFolder(dir);
      return { status: 'ready', handle };
    });
  } catch {
    return FRONTIER_REFUSED;
  }
}

/** Re-verifies the same bytes and signed selection under the replica lock after a restart. */
export async function openStoredAcceptedFrontier(store: ReplicaStore, handle: string, request: FrontierStoreRequest): Promise<FrontierArchiveResult> {
  if (!HASH_PATTERN.test(handle)) return FRONTIER_REFUSED;
  try {
    return await store['locked'](async () => {
      const scope = await frontierScope(store, request);
      if (scope === undefined || await checkPath(store.root, [...store['parts'], ACCEPTED_FRONTIER_DIR])) return FRONTIER_REFUSED;
      const bytes = await readFrontierFile(path.join(store.dir, ACCEPTED_FRONTIER_DIR, `${handle}.json`));
      if (bytes === undefined || frontierFileHandle(scope, bytes) !== handle || await frontierScope(store, request) !== scope) return FRONTIER_REFUSED;
      return openAcceptedFrontier(JSON.parse(bytes.toString('utf8')), { ...request, expectedStream: request.stream });
    });
  } catch {
    return FRONTIER_REFUSED;
  }
}

async function frontierScope(store: ReplicaStore, request: FrontierStoreRequest): Promise<string | undefined> {
  if (request.reader !== store['own'].writer || !STREAM_ID_PATTERN.test(request.stream)) return undefined;
  await store['verifyAppendSnapshot'](request.expectedSnapshot);
  const head = request.roster.positions.at(-1);
  const selected = request.roster.accessRevision;
  if (head === undefined || head !== store['mark']?.rosterHead || selected?.entry !== request.accessEntry) return undefined;
  const stored = [head, request.pin.genesis, selected.entry];
  if (!stored.every((hash) => store['byHash'].get(hash)?.header.stream === request.pin.project && !store['held'].has(hash) && !store['waiting'].has(hash))) return undefined;
  return sha256Hex(canonicalBytes(['accepted-frontier-store/1', request.pin.project, request.pin.genesis, head, selected.entry, selected.root, request.stream, request.reader]));
}
