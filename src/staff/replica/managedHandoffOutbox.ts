import { HASH_PATTERN, sha256Hex } from '../../domain/replica/entry';
import { canonicalBytes, canonicalize } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { MANAGED_KEY_FILE_NAME, deliveryPacket, managedKeyFile, readManagedKeyFile } from './managedGrantDelivery';
import type { ManagedKeyFile, PreparedManagedHandoff } from './managedGrantDelivery';
import { managedHandoffFile, MAX_HANDOFF_ATTEMPTS, nextHandoffRetry, openManagedHandoffInbox, validTime } from './managedHandoffInbox';
import type { ManagedHandoffFiles } from './managedHandoffInbox';
import type { ManagedStagedSend } from './managedSync';

const MAX_ROWS = 64;
const MAX_BYTES = 24 * 1024 * 1024;

interface PendingSend {
  id: string;
  handle: string;
  expiresAt: number;
  nextAt: number;
  attempts: number;
}

type Send = PendingSend & (
  | { state: 'queued'; packet: unknown }
  | { state: 'uploaded' | 'published' | 'expired' }
);

function isSend(value: unknown): value is Send {
  if (!isRecord(value) || typeof value.id !== 'string' || !HASH_PATTERN.test(value.id) ||
      typeof value.handle !== 'string' || !HASH_PATTERN.test(value.handle) ||
      !validTime(value.expiresAt) || !validTime(value.nextAt) || value.nextAt > value.expiresAt ||
      !validTime(value.attempts) || value.attempts === 0 || value.attempts > MAX_HANDOFF_ATTEMPTS) return false;
  return value.state === 'queued' ? Object.keys(value).length === 7 && deliveryPacket(value.packet) :
    Object.keys(value).length === 6 && (value.state === 'uploaded' || value.state === 'published' || value.state === 'expired');
}

function readSends(value: unknown): Send[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.v !== 1 || !Array.isArray(value.rows) ||
      value.rows.length > MAX_ROWS || !value.rows.every(isSend)) return undefined;
  const rows: Send[] = value.rows;
  return new Set(rows.map(({ id }) => id)).size === rows.length && new Set(rows.map(({ handle }) => handle)).size === rows.length ? rows : undefined;
}

interface FileExport { id: string; handle: string; reservedAt: number; expiresAt: number; text: string; digest: string }

function fileDigest({ id, handle, reservedAt, expiresAt, text }: Omit<FileExport, 'digest'>): string {
  return sha256Hex(canonicalBytes([id, handle, reservedAt, expiresAt, text]));
}

function isFileExport(value: unknown): value is FileExport {
  if (!isRecord(value) || Object.keys(value).length !== 6 || typeof value.id !== 'string' || !HASH_PATTERN.test(value.id) ||
      typeof value.handle !== 'string' || !HASH_PATTERN.test(value.handle) || !validTime(value.reservedAt) ||
      !validTime(value.expiresAt) || value.expiresAt <= value.reservedAt || typeof value.text !== 'string' ||
      typeof value.digest !== 'string' || !HASH_PATTERN.test(value.digest)) return false;
  const file = readManagedKeyFile(value.text);
  return file?.handle === value.handle && fileDigest({ id: value.id, handle: value.handle, reservedAt: value.reservedAt,
    expiresAt: value.expiresAt, text: value.text }) === value.digest;
}

function readFileExports(value: unknown): FileExport[] | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.v !== 1 || !Array.isArray(value.rows) ||
      value.rows.length > MAX_ROWS || !value.rows.every(isFileExport)) return undefined;
  const rows: FileExport[] = value.rows;
  return new Set(rows.map(({ id }) => id)).size === rows.length && new Set(rows.map(({ handle }) => handle)).size === rows.length ? rows : undefined;
}

export function openManagedHandoffs(
  store: string, project: string, writer: string, clock: () => Date, files: ManagedHandoffFiles,
  verifySnapshot: (expected: string) => Promise<void>
) {
  const update = managedHandoffFile(store, project, writer, clock, files, 'outbox', MAX_BYTES, readSends);
  const updateFiles = managedHandoffFile(store, project, writer, clock, files, 'file-export', MAX_BYTES, readFileExports);

  function exportFile(plan: PreparedManagedHandoff, snapshot: string, repeat?: string): Promise<ManagedKeyFile | undefined> {
    return updateFiles((rows, now) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].expiresAt <= now) rows.splice(index, 1);
      }
      const existing = rows.find(({ id }) => id === plan.id);
      if (existing !== undefined) {
        if (existing.reservedAt > now || existing.expiresAt > plan.expiresAt || (repeat !== undefined && repeat !== existing.handle)) return undefined;
        return { name: MANAGED_KEY_FILE_NAME, text: existing.text, repeat: existing.handle };
      }
      if (repeat !== undefined || rows.length >= MAX_ROWS || plan.expiresAt <= now) return undefined;
      const sealed = plan.seal();
      if (sealed === undefined) return undefined;
      const file = managedKeyFile(sealed);
      const row = { id: plan.id, handle: sealed.handle, reservedAt: now, expiresAt: plan.expiresAt, text: file.text };
      rows.push({ ...row, digest: fileDigest(row) });
      return file;
    }, () => verifySnapshot(snapshot));
  }

  function stage(plan: PreparedManagedHandoff, snapshot: string): Promise<ManagedStagedSend | undefined> {
    return update((rows, now): ManagedStagedSend | undefined => {
      for (const [index, row] of rows.entries()) {
        if (row.state === 'queued' && row.expiresAt <= now) {
          const { packet: _packet, ...expired } = row;
          rows[index] = { ...expired, state: 'expired' };
        }
      }
      const index = rows.findIndex(({ id }) => id === plan.id);
      const row = rows[index];
      if (row === undefined) {
        if (rows.length >= MAX_ROWS || plan.expiresAt <= now) return undefined;
        const sealed = plan.seal();
        if (sealed === undefined) return undefined;
        const packet: unknown = JSON.parse(canonicalize(sealed.packet));
        const queued: Send = { handle: sealed.handle, packet, id: plan.id, expiresAt: plan.expiresAt,
          nextAt: nextHandoffRetry(plan.expiresAt, 0, now), attempts: 1, state: 'queued' };
        rows.push(queued);
        return reservation(queued);
      }
      if (row.expiresAt <= now || row.state === 'expired') return undefined;
      if (row.state === 'published') return { handle: row.handle, expiresAt: row.expiresAt, state: 'published' };
      if (row.attempts >= MAX_HANDOFF_ATTEMPTS || row.nextAt > now) return undefined;
      rows[index] = { ...row, attempts: row.attempts + 1, nextAt: nextHandoffRetry(row.expiresAt, row.attempts, now) };
      return reservation(rows[index]);
    }, () => verifySnapshot(snapshot));
  }

  function reservation(row: Send): ManagedStagedSend {
    const published = async () => { await advance(row, 'published'); };
    if (row.state === 'queued') return { handle: row.handle, expiresAt: row.expiresAt, state: 'queued', packet: row.packet, uploaded: () => advance(row, 'uploaded'), published };
    return { handle: row.handle, expiresAt: row.expiresAt, state: 'uploaded', published };
  }

  function advance(row: Send, state: 'uploaded' | 'published'): Promise<boolean> {
    return update((rows, now) => {
      const index = rows.findIndex(({ id, handle }) => id === row.id && handle === row.handle);
      const current = rows[index];
      if (current === undefined || current.expiresAt <= now) return false;
      const prior = state === 'uploaded' ? 'queued' : 'uploaded';
      if (current.state !== prior) return false;
      const { id, handle, expiresAt } = current;
      rows[index] = { id, handle, expiresAt, nextAt: nextHandoffRetry(expiresAt, 0, now), attempts: 1, state };
      return true;
    });
  }

  return { inbox: () => openManagedHandoffInbox(store, project, writer, clock, files), stage, exportFile };
}
