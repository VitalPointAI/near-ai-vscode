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
import { foldRoster, isRosterWriterAt, managedWriteAllowed } from '../../domain/replica/roster';
import type { RosterFoldInput, RosterState } from '../../domain/replica/roster';
import { addGrant, epochAt } from '../../domain/replica/rosterCells';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { matchesGrantEvidence, openGrantEvidence, readAuthoredAccessStage, readContinuityReceipt, readGrantDelivery } from '../../domain/replica/rotationGrants';
import { readAccessWriteProof } from '../../domain/replica/rotationProof';
import type { AccessWriteProof } from '../../domain/replica/rotationProof';
import { WRAP_FEATURE, wrapFormatProblem } from '../../domain/replica/wrapFormat';
import { canonicalBytes, canonicalize } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { formatFor, formatForDevice, wrapDeviceAt } from './wrapPlan';
import type { WrapCell } from './wrapPlan';
import { managedIssuanceCurrent, prepareManagedIssuance, readManagedIssuance } from './managedIssuance';
import type { IssuedManagedArtifact, ManagedIssuer } from './managedIssuance';
import type { ManagedPacket } from './managedSync';

const HANDLE = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const PADDING_BUCKET = 16 * 1024;
const HEADER = 4;
const MAX_BODY_TEXT = Math.ceil(BLOB_MAX_BYTES * 4 / 3);
/** A sealed packet's base64 text, wrap and private staging fields. */
export const MANAGED_PACKET_STAGE_MAX_BYTES = MAX_BODY_TEXT + 4096;

interface Packet { v: 1; wrapped: string; body: SealedBlob }
interface SealedDelivery { handle: string; packet: Packet }
export interface PreparedManagedHandoff {
  id: string;
  expiresAt: number;
  seal(): SealedDelivery | undefined;
}
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
export function sealManagedGrantDelivery(roster: RosterState, input: ManagedGrantDelivery, issuer: ManagedIssuer): SealedDelivery | undefined {
  return prepareGrantDelivery(roster, input, issuer)?.seal();
}

function prepareGrantDelivery(roster: RosterState, input: ManagedGrantDelivery, issuer: ManagedIssuer): PreparedManagedHandoff | undefined {
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
  return preparePayload(roster, issuer, device, format, now, {
    grants: [grant, ...pages], opening, ...(proof === undefined ? {} : { accessProof: proof })
  });
}

interface ManagedGrantHandoff { cell: string; recipient: string; info: WrapCell; routing?: RoutingTable }
export type ManagedHandoff = ManagedGrantHandoff | { recipient: string; continuity: readonly string[] };

/** Offer only the exact current proof and a placed grant from selected history; continuity can travel independently. */
export function preparePlacedManagedHandoff(roster: RosterState, evidence: readonly unknown[], input: ManagedHandoff, now: Date, issuer: ManagedIssuer): PreparedManagedHandoff | undefined {
  const revision = roster.accessRevision;
  const head = roster.positions.length - 1;
  if (revision === undefined || roster.pending.length > 0 || deviceAt(roster.members, input.recipient, head)?.kind !== 'person') return undefined;
  const stages = evidence.flatMap((value) => readAuthoredAccessStage(value) ?? []).filter((stage) => roster.accessHistory.has(stage.entry));
  const current = stages.filter((stage) => stage.entry === revision.entry);
  const proofs = new Map<string, AccessWriteProof>();
  for (const value of current.flatMap((stage) => stage.accessProofs)) {
    const proof = readAccessWriteProof(value);
    const permit = proof?.signed.permit;
    if (proof !== undefined && permit !== undefined && permit.writer === input.recipient && permit.device === input.recipient &&
        managedWriteAllowed(roster, permit.cell, permit.epoch, input.recipient, head, now, proof) === true) proofs.set(permit.cell, proof);
  }
  if ('continuity' in input) {
    const requested = new Set(input.continuity);
    if (requested.size === 0 || requested.size !== input.continuity.length || requested.size > revision.cells.length) return undefined;
    const accessProofs = [...proofs].filter(([cell]) => requested.has(cell)).map(([, proof]) => proof);
    return accessProofs.length === requested.size ? prepareContinuityDelivery(roster, input.recipient, { entry: revision.entry, accessProofs }, now, issuer) : undefined;
  }
  const opening = current.flatMap((stage) => stage.openings).find((value) =>
    openGrantEvidence(roster.anchor.project, roster.accessHistory, value)?.evidence.cell === input.cell);
  const accessProof = proofs.get(input.cell);
  if (opening === undefined || accessProof === undefined) return undefined;
  for (const stage of stages) {
    const issued = stage.founding ?? stage.supplemental;
    if (issued?.recipients.includes(input.recipient) !== true) continue;
    const [grant, ...pages] = issued.grants;
    const plan = prepareGrantDelivery(roster, { ...input, now, accessProof, opening, grant, pages }, issuer);
    if (plan !== undefined) return plan;
  }
  return undefined;
}

/** Carry one exact writer's continuity proofs under one private handoff and one selected roster entry. */
export function sealManagedContinuityDelivery(roster: RosterState, recipient: string, input: unknown, now: Date, issuer: ManagedIssuer): SealedDelivery | undefined {
  return prepareContinuityDelivery(roster, recipient, input, now, issuer)?.seal();
}

function prepareContinuityDelivery(roster: RosterState, recipient: string, input: unknown, now: Date, issuer: ManagedIssuer): PreparedManagedHandoff | undefined {
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
  return preparePayload(roster, issuer, device, format, now.getTime(), { ...receipt });
}

function preparePayload(roster: RosterState, issuer: ManagedIssuer, device: WrapDevice, format: 1 | 2, now: number,
  artifact: Record<string, unknown>): PreparedManagedHandoff | undefined {
  if (format === 1 ? device.x25519 === undefined : device.kem === undefined) return undefined;
  const plan = prepareManagedIssuance(roster, issuer, device.writer, now, artifact);
  if (plan === undefined) return undefined;
  const { issuedAt: _issuedAt, ...binding } = plan.binding;
  const id = sha256Hex(canonicalBytes(['near-ai/managed-send/2', device, format, binding]));
  return { id, expiresAt: plan.expiresAt, seal() {
    const handle = randomBytes(32).toString('hex');
    const issued = plan.issue(handle);
    if (issued === undefined) return undefined;
    const bytes = canonicalBytes(issued);
    const size = Math.ceil((bytes.length + HEADER) / PADDING_BUCKET) * PADDING_BUCKET;
    return size + SEALED_OVERHEAD > BLOB_MAX_BYTES ? undefined : sealPrepared(handle, device, format, size, bytes);
  } };
}

function sealPrepared(handle: string, device: WrapDevice, format: 1 | 2, size: number, bytes: Buffer): SealedDelivery | undefined {
  const padded = Buffer.alloc(size);
  padded.writeUInt32BE(bytes.length);
  bytes.copy(padded, HEADER);
  const stream = address(handle);
  const key = newEpochKey();
  const wrapped = wrapsFor({ format, cell: stream, epoch: 1, epochKey: key, devices: [device] }).wraps[0]?.wrap;
  return wrapped === undefined ? undefined : { handle, packet: { v: 1, wrapped, body: sealBlob(key, stream, 1, padded) } };
}

export function deliveryPacket(value: unknown): value is Packet {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.v !== 1 || typeof value.wrapped !== 'string' || value.wrapped.length > 2048 ||
      !isRecord(value.body) || Object.keys(value.body).length !== 2 || typeof value.body.hash !== 'string' || !HANDLE.test(value.body.hash) ||
      typeof value.body.bytes !== 'string' || value.body.bytes.length > MAX_BODY_TEXT || !B64.test(value.body.bytes)) return false;
  return true;
}

export const MANAGED_KEY_FILE_NAME = 'shared-keys.near-staff-keys';
export interface ManagedKeyFile { name: string; text: string; repeat: string }

export function readManagedKeyFile(text: unknown): ManagedPacket | undefined {
  if (typeof text !== 'string' || text.length > MANAGED_PACKET_STAGE_MAX_BYTES || Buffer.byteLength(text) > MANAGED_PACKET_STAGE_MAX_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  return isRecord(value) && Object.keys(value).length === 2 && typeof value.handle === 'string' && HANDLE.test(value.handle) &&
    deliveryPacket(value.packet) && blobBytesHash(value.packet.body) === value.packet.body.hash ? { handle: value.handle, packet: value.packet } : undefined;
}

/** One opaque file format, separate from invitation and welcome files. */
export function managedKeyFile({ handle, packet }: ManagedPacket): ManagedKeyFile {
  return { name: MANAGED_KEY_FILE_NAME, text: canonicalize({ handle, packet }), repeat: handle };
}

export function isManagedPacketStage(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 3 && typeof value.digest === 'string' && HANDLE.test(value.digest) &&
    Number.isSafeInteger(value.deadline) && isRecord(value.managedPendingPacket) &&
    typeof value.managedPendingPacket.handle === 'string' && HANDLE.test(value.managedPendingPacket.handle) &&
    deliveryPacket(value.managedPendingPacket.packet);
}

function openPayload(project: string, device: DeliveryDevice, handle: string, packet: unknown, now: Date, expectedExpiry?: number): IssuedManagedArtifact | undefined {
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
  return readManagedIssuance(value, { project, recipient: device.writer, handle, now: time, expectedExpiry });
}

/** Open using only admitted device keys. The caller stages the returned grant and opening for selected-root verification. */
export function openManagedGrantDelivery(project: string, device: DeliveryDevice, handle: string, packet: unknown, now: Date):
  { grants: readonly unknown[]; opening: unknown; accessProof?: AccessWriteProof } | undefined {
  return grantForRecipient(project, device.writer, openPayload(project, device, handle, packet, now)?.artifact);
}

function grantForRecipient(project: string, recipient: string, artifact: unknown) {
  const delivery = readGrantDelivery(artifact);
  if (delivery?.project !== project || !delivery.recipients.includes(recipient)) return undefined;
  const { grants, opening, accessProof } = delivery;
  if (accessProof !== undefined && accessProof.signed.permit.device !== recipient) return undefined;
  return { grants, opening, ...(accessProof === undefined ? {} : { accessProof }) };
}

export function openManagedGrantArtifact(project: string, device: DeliveryDevice, value: unknown, now: Date): IssuedManagedArtifact | undefined {
  if (!isRecord(value) || typeof value.handle !== 'string' || !Object.hasOwn(value, 'packet') ||
      Object.keys(value).length !== (Object.hasOwn(value, 'expectedExpiry') ? 3 : 2) ||
      (Object.hasOwn(value, 'expectedExpiry') && typeof value.expectedExpiry !== 'number')) return undefined;
  const issued = openPayload(project, device, value.handle, value.packet, now, value.expectedExpiry as number | undefined);
  if (issued === undefined) return undefined;
  const receipt = readContinuityReceipt(issued.artifact);
  if (receipt === undefined) return grantForRecipient(project, device.writer, issued.artifact) === undefined ? undefined : issued;
  const target = receipt.accessProofs[0].signed.permit;
  return target.project === project && target.device === device.writer ? issued : undefined;
}

/** Validate a live handoff against the selected roster before allowing the confidential sender to retire its handle. */
export function verifySelectedManagedArtifact(roster: RosterState, recipient: string, artifact: unknown, now: Date):
  true | { cell: string; epoch: number } | undefined {
  const revision = roster.accessRevision;
  const head = roster.positions.length - 1;
  if (revision === undefined || roster.pending.length > 0 || deviceAt(roster.members, recipient, head) === undefined) return undefined;
  const permits = (state: RosterState, proof: AccessWriteProof): boolean => {
    const { cell, epoch, writer, device } = proof.signed.permit;
    return device === recipient && managedWriteAllowed(state, cell, epoch, writer, head, now, proof) === true;
  };
  const continuity = readContinuityReceipt(artifact);
  if (continuity !== undefined) return continuity.entry === revision.entry && continuity.accessProofs.every((proof) => permits(roster, proof)) ? true : undefined;

  const delivery = readGrantDelivery(artifact);
  if (delivery?.recipients.includes(recipient) !== true) return undefined;
  const opening = openGrantEvidence(roster.anchor.project, roster.accessHistory, delivery.opening);
  if (opening?.entry !== revision.entry || opening.decision !== 'continues' || opening.evidence.excluded.includes(recipient)) return undefined;
  const [first, ...pages] = delivery.grants;
  const verified = pages.length === 0 ? readGrant(first) : readGrantPages(first, pages);
  if (!verified.ok) return undefined;
  const { cell, epoch } = verified.grant;
  const issuedAt = roster.positionOf.get(verified.grant.roster);
  const revisionAt = roster.positionOf.get(revision.entry);
  const record = roster.cells.cells.get(cell);
  const current = record?.epochs.at(-1);
  if (record === undefined || current?.epoch !== epoch || issuedAt === undefined || revisionAt === undefined || issuedAt > revisionAt ||
      wrapFormatProblem(verified.grant, current.from, roster.requiredFrom.get(WRAP_FEATURE)) !== undefined) return undefined;
  const cells = { project: roster.cells.project, cells: new Map(roster.cells.cells) };
  cells.cells.set(cell, { ...record, grants: [...record.grants] });
  const placement = addGrant(cells, { grant: verified.grant, hash: verified.hash, position: issuedAt,
    signerIsRosterWriter: isRosterWriterAt(roster, verified.signer.writer, issuedAt),
    admitted: (writer) => deviceAt(roster.members, writer, issuedAt) !== undefined });
  if (placement.status !== 'applied' || (delivery.accessProof !== undefined && !permits({ ...roster, cells }, delivery.accessProof))) return undefined;
  return { cell, epoch };
}


/** A valid receipt for a selected historical root may be discarded. It grants no authority at the new root. */
export function isSupersededManagedContinuity(roster: RosterState, device: DeliveryDevice, value: unknown, now: Date): boolean {
  if (roster.pending.length > 0 || deviceAt(roster.members, device.writer, roster.positions.length - 1) === undefined) return false;
  const decoded = openManagedGrantArtifact(roster.anchor.project, device, value, now);
  const receipt = readContinuityReceipt(decoded?.artifact);
  if (decoded === undefined || !managedIssuanceCurrent(roster, decoded, now, true) || receipt === undefined || roster.accessRevision === undefined) return false;
  const revision = roster.accessHistory.get(receipt.entry);
  const older = roster.positionOf.get(receipt.entry);
  const latest = roster.positionOf.get(roster.accessRevision.entry);
  if (revision === undefined || older === undefined || latest === undefined || older >= latest) return false;
  const historical = { ...roster, positions: roster.positions.slice(0, older + 1), accessRevision: revision };
  return verifySelectedManagedArtifact(historical, device.writer, receipt, now) === true;
}

/** Pair only continuity authenticated by the roster preview for this exact batch. */
export function previewManagedContinuity(input: RosterFoldInput, current: RosterState, entries: readonly unknown[], device: DeliveryDevice,
  packets: readonly ManagedPacket[]) {
  const pending = foldRoster({ ...input, entries: [...input.entries, ...entries] });
  const entry = pending.accessRevision?.entry;
  if (entry === undefined || entry === current.accessRevision?.entry) return undefined;
  const evidence: unknown[] = [];
  const handles: Array<{ handle: string; digest: string }> = [];
  let expiresAt = Number.MAX_SAFE_INTEGER;
  for (const packet of packets) {
    const artifact = openManagedGrantArtifact(input.anchor.project, device, packet, input.now);
    const receipt = readContinuityReceipt(artifact?.artifact);
    if (artifact === undefined || receipt?.entry !== entry || !managedIssuanceCurrent(pending, artifact, input.now) ||
        verifySelectedManagedArtifact(pending, device.writer, receipt, input.now) !== true) continue;
    expiresAt = Math.min(expiresAt, artifact.issuance.expiresAt);
    const digest = artifact.issuance.digest;
    evidence.push({ managedPendingPacket: packet, deadline: artifact.issuance.expiresAt, digest });
    handles.push({ handle: packet.handle, digest });
  }
  return evidence.length > 0 ? { root: entry, evidence, handles, expiresAt } : undefined;
}
