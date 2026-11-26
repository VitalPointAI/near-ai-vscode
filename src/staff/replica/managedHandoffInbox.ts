import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { HASH_PATTERN, sha256Hex } from '../../domain/replica/entry';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { syncFolder } from '../staffFiles';
import { MANAGED_HANDOFF_LIFETIME_MS, MAX_MANAGED_BATCH } from './managedSync';
import type { ManagedPendingBatch } from './managedSync';
import { readStoredArtifact } from './storeArtifacts';

const MAX_ROWS = 256;
const MAX_BYTES = 64 * 1024;
export const MAX_HANDOFF_ATTEMPTS = 6;
const INITIAL_RETRY_MS = 5000;

type Disposition = 'pending' | 'accepted' | 'superseded';
interface Row {
  handle: string;
  expiresAt: number;
  nextAt: number;
  attempts: number;
  state: Disposition;
}

export interface ManagedHandoffInbox {
  enqueue(handle: string, expiresAt: number): Promise<boolean>;
  pending(): Promise<ManagedPendingBatch>;
  accepted(handle: string): Promise<void>;
  superseded(handle: string): Promise<void>;
}

export interface ManagedHandoffFiles {
  locked<T>(work: () => Promise<T>): Promise<T>;
  folder(): Promise<string>;
  writeAtomic(file: string, bytes: Buffer, mode: number): Promise<void>;
}

export function validTime(time: unknown): time is number {
  return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0;
}

function isRow(value: unknown): value is Row {
  return isRecord(value) && Object.keys(value).length === 5 && typeof value.handle === 'string' && HASH_PATTERN.test(value.handle) &&
    validTime(value.expiresAt) && validTime(value.nextAt) && value.nextAt <= value.expiresAt &&
    validTime(value.attempts) && value.attempts <= MAX_HANDOFF_ATTEMPTS &&
    (value.state === 'pending' || value.state === 'accepted' || value.state === 'superseded');
}

function readRows(value: unknown): Row[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.v !== 1 || !Array.isArray(value.rows) ||
    value.rows.length > MAX_ROWS || !value.rows.every(isRow)) return undefined;
  const rows: Row[] = value.rows;
  return new Set(rows.map(({ handle }) => handle)).size === rows.length ? rows : undefined;
}

async function readRowsFile<Row>(file: string, maxBytes: number, parse: (value: unknown) => Row[] | undefined): Promise<Row[]> {
  try {
    if ((await lstat(file)).isFile()) {
      const stored = await readStoredArtifact(file, maxBytes, () => true);
      const rows = 'value' in stored ? parse(stored.value) : undefined;
      if (rows !== undefined) return rows;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  }
  throw new Error('The local private handoff state is unreadable.');
}

export function managedHandoffFile<Row extends { expiresAt: number }>(
  store: string, project: string, writer: string, clock: () => Date, files: ManagedHandoffFiles,
  name: 'inbox' | 'outbox' | 'file-export', maxBytes: number, parse: (value: unknown) => Row[] | undefined
) {
  const scope = sha256Hex(canonicalBytes([`near-ai/managed-handoff-${name}/1`, project, writer]));
  return function update<T>(operation: (rows: Row[], now: number) => T, check?: () => Promise<void>): Promise<T> {
    return files.locked(async () => {
      await check?.();
      const folder = await files.folder();
      const file = path.join(folder, `${scope}.json`);
      const original = await readRowsFile(file, maxBytes, parse);
      const now = clock().getTime();
      if (!validTime(now) || !Number.isSafeInteger(now + MANAGED_HANDOFF_LIFETIME_MS)) throw new Error('The local private handoff clock is invalid.');
      // Keep tombstones until the sealed packet's maximum lifetime has passed.
      const rows = original.filter(({ expiresAt }) => expiresAt > now - MANAGED_HANDOFF_LIFETIME_MS);
      const result = operation(rows, now);
      if (rows.length !== original.length || rows.some((row, index) => row !== original[index])) {
        const bytes = canonicalBytes({ v: 1, rows });
        if (bytes.length > maxBytes) throw new Error('The local private handoff queue is full.');
        await files.writeAtomic(file, bytes, 0o600);
        await syncFolder(folder);
        await syncFolder(store);
      }
      return result;
    });
  };
}

export function nextHandoffRetry(expiresAt: number, attempts: number, now: number): number {
  return Math.min(expiresAt, now + INITIAL_RETRY_MS * 2 ** attempts);
}

/** Persist recipient-side opaque addresses under the private replica store lock. */
export function openManagedHandoffInbox(
  store: string, project: string, recipient: string, clock: () => Date, files: ManagedHandoffFiles
): ManagedHandoffInbox {
  const update = managedHandoffFile(store, project, recipient, clock, files, 'inbox', MAX_BYTES, readRows);

  function settle(handle: string, state: 'accepted' | 'superseded'): Promise<void> {
    return update((rows, now) => {
      const index = rows.findIndex((row) => row.handle === handle && row.state === 'pending' && row.expiresAt > now);
      if (index !== -1) rows[index] = { ...rows[index], state };
    });
  }

  return {
    enqueue: (handle, expiresAt) => update((rows, now) => {
      if (typeof handle !== 'string' || !HASH_PATTERN.test(handle) || !validTime(expiresAt) || expiresAt <= now || expiresAt > now + MANAGED_HANDOFF_LIFETIME_MS) return false;
      const existing = rows.find((row) => row.handle === handle);
      if (existing !== undefined) return existing.expiresAt === expiresAt;
      if (rows.length >= MAX_ROWS) return false;
      rows.push({ handle, expiresAt, nextAt: now, attempts: 0, state: 'pending' });
      return true;
    }),
    pending: () => update((rows, now) => {
      const active = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.state === 'pending' && row.expiresAt > now);
      const due = active.filter(({ row }) => row.attempts < MAX_HANDOFF_ATTEMPTS && row.nextAt <= now)
        .sort((left, right) => left.row.nextAt - right.row.nextAt).slice(0, MAX_MANAGED_BATCH);
      for (const { row, index } of due) {
        const nextAt = nextHandoffRetry(row.expiresAt, row.attempts, now);
        rows[index] = { ...row, nextAt, attempts: row.attempts + 1 };
      }
      return { handles: due.map(({ row }) => row.handle), waiting: active.length > due.length, deadlines: new Map(due.map(({ row }) => [row.handle, row.expiresAt])) };
    }),
    accepted: (handle) => settle(handle, 'accepted'),
    superseded: (handle) => settle(handle, 'superseded')
  };
}
