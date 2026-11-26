import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { RoutingTable } from '../../domain/gate/routing';
import { MAX_GRANT_PAGES, newEpochKey, readGrant } from '../../domain/replica/cellKeys';
import { unwrapForDevice, wrapFormatOf } from '../../domain/replica/cellWrapV2';
import type { KemPrivateKeys } from '../../domain/replica/cellWrapV2';
import { BLOB_MAX_BYTES, SEALED_OVERHEAD, blobBytesHash, openBlob, sealBlob, sha256Hex } from '../../domain/replica/entry';
import type { SealedBlob } from '../../domain/replica/entry';
import { readGrantPages, wrapsFor } from '../../domain/replica/grantPages';
import type { RosterState } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { matchesGrantEvidence, openGrantEvidence } from '../../domain/replica/rotationGrants';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { formatFor, formatForDevice, wrapDeviceAt } from './wrapPlan';
import type { WrapCell } from './wrapPlan';

const HANDLE = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const DELIVERY_MS = 24 * 60 * 60 * 1000;
const PADDING_BUCKET = 16 * 1024;
const HEADER = 4;

interface Packet { v: 1; wrapped: string; body: SealedBlob }
interface ManagedGrantDelivery {
  recipient: string;
  opening: unknown;
  grant: unknown;
  pages: readonly unknown[];
  info: WrapCell;
  routing?: RoutingTable;
  now: Date;
}
interface DeliveryDevice { writer: string; x25519?: KeyObject; kem?: KemPrivateKeys }

function address(handle: string): string {
  return sha256Hex(Buffer.from(`near-ai/managed-grant-delivery/1/${handle}`)).slice(0, 32);
}

/** Seal a placed grant and its private authorization for exactly one admitted recipient. */
export function sealManagedGrantDelivery(roster: RosterState, input: ManagedGrantDelivery): { handle: string; packet: Packet } | undefined {
  const { recipient, opening, grant, pages, info, routing } = input;
  const now = input.now.getTime();
  const revision = roster.accessRevision;
  const head = roster.positions.length - 1;
  if (revision === undefined || roster.pending.length > 0 || deviceAt(roster.members, recipient, head) === undefined ||
      !Number.isFinite(now) || pages.length > MAX_GRANT_PAGES) return undefined;
  const proved = openGrantEvidence(roster.anchor.project, roster.accessHistory, opening);
  if (proved === undefined || proved.entry !== revision.entry || proved.evidence.excluded.includes(recipient)) return undefined;
  const verified = pages.length === 0 ? readGrant(grant) : readGrantPages(grant, pages);
  if (!verified.ok || (verified.grant.pages?.length ?? 0) !== pages.length) return undefined;
  const writers = verified.grant.wraps.map(({ writer }) => writer).sort();
  const { cell, epoch } = verified.grant;
  if (cell !== proved.evidence.cell || info.base !== (cell === roster.anchor.project) || epoch !== proved.evidence.epoch || epochAt(roster.cells, cell, head) !== epoch ||
      !writers.includes(recipient) || !matchesGrantEvidence(proved.evidence, { hash: verified.hash, pages: verified.grant.pages ?? [], recipients: writers })) return undefined;
  const record = roster.cells.cells.get(cell);
  const founded = record?.epochs.find((item) => item.epoch === epoch)?.from;
  if (founded === undefined || !record?.grants.some((item) => item.hash === verified.hash)) return undefined;
  const device = wrapDeviceAt(roster, recipient, head);
  const choice = formatFor(roster, info, founded, routing);
  if (choice === 'switch-first') return undefined;
  const original = wrapFormatOf(verified.grant.wraps.find(({ writer }) => writer === recipient)?.wrap ?? '');
  if (!original.ok) return undefined;
  const format = original.format === 2 ? 2 : formatForDevice(choice, device);

  const bytes = canonicalBytes({ project: roster.anchor.project, recipient, expires: now + DELIVERY_MS, grants: [grant, ...pages], opening });
  const size = Math.ceil((bytes.length + HEADER) / PADDING_BUCKET) * PADDING_BUCKET;
  if (size + SEALED_OVERHEAD > BLOB_MAX_BYTES) return undefined;
  const padded = Buffer.alloc(size);
  padded.writeUInt32BE(bytes.length);
  bytes.copy(padded, HEADER);

  const handle = randomBytes(32).toString('hex');
  const stream = address(handle);
  const key = newEpochKey();
  const wrapped = wrapsFor({ format, cell: stream, epoch: 1, epochKey: key, devices: [device] }).wraps[0]?.wrap;
  return wrapped === undefined ? undefined : { handle, packet: { v: 1, wrapped, body: sealBlob(key, stream, 1, padded) } };
}

function deliveryPacket(value: unknown): value is Packet {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.v !== 1 || typeof value.wrapped !== 'string' || value.wrapped.length > 2048 ||
      !isRecord(value.body) || Object.keys(value.body).length !== 2 || typeof value.body.hash !== 'string' || !HANDLE.test(value.body.hash) ||
      typeof value.body.bytes !== 'string' || value.body.bytes.length > Math.ceil(BLOB_MAX_BYTES * 4 / 3) || !B64.test(value.body.bytes)) return false;
  return true;
}

/** Open using only admitted device keys. The caller stages the returned grant and opening for selected-root verification. */
export function openManagedGrantDelivery(project: string, device: DeliveryDevice, handle: string, packet: unknown, now: Date):
  { grants: readonly unknown[]; opening: unknown } | undefined {
  const time = now.getTime();
  if (!HANDLE.test(handle) || !Number.isFinite(time) || !deliveryPacket(packet) || blobBytesHash(packet.body) !== packet.body.hash) return undefined;
  const stream = address(handle);
  const key = unwrapForDevice({ ...device, cell: stream, epoch: 1, wrap: packet.wrapped });
  if (key === undefined) return undefined;
  const plain = openBlob(key, stream, 1, packet.body);
  if (plain === undefined || plain.length < HEADER || plain.length % PADDING_BUCKET !== 0) return undefined;
  const length = plain.readUInt32BE();
  if (length < 1 || length > plain.length - HEADER) return undefined;
  let value: unknown;
  try { value = JSON.parse(plain.subarray(HEADER, HEADER + length).toString('utf8')) as unknown; } catch { return undefined; }
  if (!isRecord(value) || Object.keys(value).length !== 5 || value.project !== project || value.recipient !== device.writer ||
      typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires) || value.expires <= time || value.expires > time + DELIVERY_MS ||
      !Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > MAX_GRANT_PAGES + 1 ||
      !isRecord(value.opening)) return undefined;
  return { grants: value.grants, opening: value.opening };
}
