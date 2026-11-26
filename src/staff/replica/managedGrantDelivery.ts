import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { RoutingTable } from '../../domain/gate/routing';
import { MAX_GRANT_PAGES, newEpochKey, readGrant } from '../../domain/replica/cellKeys';
import { unwrapForDevice, wrapFormatOf } from '../../domain/replica/cellWrapV2';
import type { KemPrivateKeys } from '../../domain/replica/cellWrapV2';
import { BLOB_MAX_BYTES, SEALED_OVERHEAD, blobBytesHash, openBlob, sealBlob, sha256Hex } from '../../domain/replica/entry';
import type { SealedBlob } from '../../domain/replica/entry';
import { readGrantPages, wrapsFor } from '../../domain/replica/grantPages';
import type { WrapDevice } from '../../domain/replica/grantPages';
import { managedWriteAllowed } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { matchesGrantEvidence, openGrantEvidence, readAuthoredAccessStage, readContinuityReceipt, readGrantDelivery } from '../../domain/replica/rotationGrants';
import { readAccessWriteProof } from '../../domain/replica/rotationProof';
import type { AccessWriteProof } from '../../domain/replica/rotationProof';
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
  accessProof?: unknown;
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
  const proof = readAccessWriteProof(input.accessProof);
  if (input.accessProof !== undefined && (proof?.signed.permit.device !== recipient ||
      managedWriteAllowed(roster, cell, epoch, proof.signed.permit.writer, head, input.now, proof) !== true)) return undefined;
  const device = wrapDeviceAt(roster, recipient, head);
  const choice = formatFor(roster, info, founded, routing);
  if (choice === 'switch-first') return undefined;
  const original = wrapFormatOf(verified.grant.wraps.find(({ writer }) => writer === recipient)?.wrap ?? '');
  if (!original.ok) return undefined;
  const format = original.format === 2 ? 2 : formatForDevice(choice, device);
  return sealPayload(roster.anchor.project, device, format, now, {
    grants: [grant, ...pages], opening, ...(proof === undefined ? {} : { accessProof: proof })
  });
}

export interface SupplementalHandoff { cell: string; recipient: string; info: WrapCell; routing?: RoutingTable }

/** Reoffer a placed current-epoch grant using the current opening and the recipient's exact direct permit. */
export function sealPlacedSupplemental(roster: RosterState, evidence: readonly unknown[], input: SupplementalHandoff, now: Date) {
  const revision = roster.accessRevision;
  const head = roster.positions.length - 1;
  if (revision === undefined || deviceAt(roster.members, input.recipient, head)?.kind !== 'person') return undefined;
  const stages = evidence.flatMap((value) => readAuthoredAccessStage(value) ?? []).filter((stage) => roster.accessHistory.has(stage.entry));
  const current = stages.filter((stage) => stage.entry === revision.entry);
  const opening = current.flatMap((stage) => stage.openings).find((value) =>
    openGrantEvidence(roster.anchor.project, roster.accessHistory, value)?.evidence.cell === input.cell);
  const accessProof = current.flatMap((stage) => stage.accessProofs).find((value) => {
    const permit = readAccessWriteProof(value)?.signed.permit;
    return permit !== undefined && permit.cell === input.cell && permit.writer === input.recipient &&
      managedWriteAllowed(roster, input.cell, permit.epoch, input.recipient, head, now, value) === true;
  });
  if (opening === undefined || accessProof === undefined) return undefined;
  for (const stage of stages) {
    const issued = stage.supplemental;
    if (issued?.recipients.includes(input.recipient) !== true) continue;
    const [grant, ...pages] = issued.grants;
    const sealed = sealManagedGrantDelivery(roster, { ...input, now, accessProof, opening, grant, pages });
    if (sealed !== undefined) return sealed;
  }
  return undefined;
}

/** Carry one exact writer's continuity proofs under one private handoff and one selected roster entry. */
export function sealManagedContinuityDelivery(roster: RosterState, recipient: string, input: unknown, now: Date): { handle: string; packet: Packet } | undefined {
  const receipt = readContinuityReceipt(input);
  const head = roster.positions.length - 1;
  if (receipt === undefined || receipt.entry !== roster.accessRevision?.entry || !Number.isFinite(now.getTime())) return undefined;
  const device = wrapDeviceAt(roster, recipient, head);
  let format: 1 | 2 = 1;
  for (const proof of receipt.accessProofs) {
    const { cell, epoch, writer, device: target } = proof.signed.permit;
    if (target !== recipient || managedWriteAllowed(roster, cell, epoch, writer, head, now, proof) !== true) return undefined;
    const founded = roster.cells.cells.get(cell)?.epochs.find((record) => record.epoch === epoch)?.from;
    if (founded === undefined) return undefined;
    // A private cell without a label visible to this helper uses the existing most restrictive wrap choice.
    const choice = formatFor(roster, { base: cell === roster.anchor.project }, founded);
    if (choice === 'switch-first') return undefined;
    if (formatForDevice(choice, device) === 2) format = 2;
  }
  return sealPayload(roster.anchor.project, device, format, now.getTime(), receipt);
}

function sealPayload(project: string, device: WrapDevice, format: 1 | 2, now: number, payload: object): { handle: string; packet: Packet } | undefined {
  const bytes = canonicalBytes({ project, recipient: device.writer, expires: now + DELIVERY_MS, ...payload });
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

function openPayload(project: string, device: DeliveryDevice, handle: string, packet: unknown, now: Date): Record<string, unknown> | undefined {
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
  if (!isRecord(value) || value.project !== project || value.recipient !== device.writer ||
      typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires) || value.expires <= time || value.expires > time + DELIVERY_MS) return undefined;
  const { project: _project, recipient: _recipient, expires: _expires, ...artifact } = value;
  return artifact;
}

/** Open using only admitted device keys. The caller stages the returned grant and opening for selected-root verification. */
export function openManagedGrantDelivery(project: string, device: DeliveryDevice, handle: string, packet: unknown, now: Date):
  { grants: readonly unknown[]; opening: unknown; accessProof?: AccessWriteProof } | undefined {
  return grantForRecipient(project, device.writer, openPayload(project, device, handle, packet, now));
}

function grantForRecipient(project: string, recipient: string, artifact: unknown) {
  const delivery = readGrantDelivery(artifact);
  if (delivery?.project !== project || !delivery.recipients.includes(recipient)) return undefined;
  const { grants, opening, accessProof } = delivery;
  if (accessProof !== undefined && accessProof.signed.permit.device !== recipient) return undefined;
  return { grants, opening, ...(accessProof === undefined ? {} : { accessProof }) };
}

export function openManagedGrantArtifact(project: string, device: DeliveryDevice, value: unknown, now: Date) {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.handle !== 'string') return undefined;
  const artifact = openPayload(project, device, value.handle, value.packet, now);
  const receipt = readContinuityReceipt(artifact);
  if (receipt === undefined) return grantForRecipient(project, device.writer, artifact);
  const target = receipt.accessProofs[0].signed.permit;
  return target.project === project && target.device === device.writer ? receipt : undefined;
}
