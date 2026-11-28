// Closed record formats and classification for the organization store.
import { createHash } from 'node:crypto';
import type { SecretStorageLike } from '../services/auth';
import { ENROLMENT_REFUSALS, ORGANIZATION_LAYER_REFUSALS, classifyEnrolment, issuerFingerprintHex, readEnrolmentFile, verifyOrganizationLayer } from '../domain/gate/enrolment';
import { MAX_ORGANIZATION_LAYER_BYTES } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyContact } from '../domain/gate/sections';
import { canonicalBytes } from '../domain/team/canonical';

/** The SecretStorage key of the pin. Read by every later version: never renamed. */
export const ORGANIZATION_ISSUER_SECRET = 'nearAi.gate.organizationIssuer';
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SERIAL = 2 ** 31;
export const NOT_ENROLLED_TEXT = 'This computer has no rules from your organization yet. Open the enrolment file your organization\'s security contact gave you first.';
export const NOT_ORGANIZATION_FILE_TEXT = 'This is not a file from your organization that this version of SovAI can read. Ask your organization\'s security contact for a new one.';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

export function timeOf(text: string): number {
  return Date.parse(text);
}

export type OrganizationChangeKind = 'enrol' | 'rotate' | 'update';

interface ProtectedHandover {
  readonly digest: string;
  readonly previousKey: string;
  readonly previousSerial: number;
  readonly previousLayer: string;
  readonly previousIssue: string;
  readonly enrolledAt: string;
  readonly edgeIssue: string;
}

interface HandoverFileHeads {
  readonly layer: string | null;
  readonly enrollment: string | null;
}

/** A change being written: the key and serial it will pin, the layer's issuedAt and hash. */
export interface PendingOrganizationPin {
  readonly kind: OrganizationChangeKind;
  readonly publicKey: string;
  readonly serial: number;
  readonly issuedAt: string;
  readonly layerHash: string;
  readonly handover?: ProtectedHandover;
  readonly priorFiles?: HandoverFileHeads;
}

/** The committed pin: the issuer key, its serial, the issuedAt and hash of the layer last accepted, when this computer enrolled. */
export interface OrganizationPin {
  readonly v: 1;
  readonly publicKey: string;
  readonly serial: number;
  readonly lastIssuedAt: string;
  readonly layerHash: string;
  readonly enrolledAt: string;
  readonly pending?: PendingOrganizationPin;
  readonly acceptedHandover?: ProtectedHandover;
  /**
   * Phase 71 (D-12): the credentials required by sensitivity of the layer in force, kept beside the pin so a newer layer found on disk is compared with
   * them even after it replaced the file. Absent when the layer in force requires none (every pin written before credentials@1 existed).
   */
  readonly requirements?: Readonly<Record<string, readonly string[]>>;
}

const MAX_REQUIREMENT_LEVELS = 256;

/** The pin's requirement map: `scale/level` keys to sorted lists of credential type names. Undefined when it is not one. */
function requirementsOf(value: unknown): Readonly<Record<string, readonly string[]>> | undefined {
  if (!isRecord(value) || Object.keys(value).length > MAX_REQUIREMENT_LEVELS) return undefined;
  const out: Record<string, readonly string[]> = {};
  for (const key of Object.keys(value)) {
    const list = own(value, key);
    if (key.length > 200 || !Array.isArray(list) || list.length > 32 || !list.every((entry) => typeof entry === 'string' && /^[A-Za-z]{1,64}$/.test(entry))) return undefined;
    out[key] = Object.freeze([...(list as string[])]);
  }
  return Object.freeze(out);
}

/** The requirement map of a layer's document, or undefined when it requires nothing. */
function requirementsOfDocument(document: PolicyDocument | undefined): Readonly<Record<string, readonly string[]>> | undefined {
  const map = document?.credentials?.requiredBySensitivity;
  if (map === undefined || Object.values(map).every((types) => types.length === 0)) return undefined;
  return map;
}

export function withRequirements(pin: OrganizationPin, document: PolicyDocument | undefined): OrganizationPin {
  const { requirements: _old, ...rest } = pin;
  const requirements = requirementsOfDocument(document);
  return Object.freeze(requirements === undefined ? rest : { ...rest, requirements });
}

/** What SecretStorage holds. A stored value that does not parse is `damaged`, never "not enrolled": the load fails closed for it. */
export type OrganizationPinRead =
  | { readonly state: 'absent' }
  | { readonly state: 'pending-enrol'; readonly pending: PendingOrganizationPin }
  | { readonly state: 'pinned'; readonly pin: OrganizationPin }
  | { readonly state: 'damaged' };

const isPublicKey = (value: unknown): value is string => typeof value === 'string' && PUBLIC_KEY_PATTERN.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isSerial = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SERIAL;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function handoverOf(value: unknown): ProtectedHandover | undefined {
  if (!isRecord(value) || !exactKeys(value, ['digest', 'previousKey', 'previousSerial', 'previousLayer', 'previousIssue', 'enrolledAt', 'edgeIssue'])) return undefined;
  const { digest, previousKey, previousSerial, previousLayer, previousIssue, enrolledAt, edgeIssue } = value;
  if (!isHash(digest) || !isPublicKey(previousKey) || !isSerial(previousSerial) || !isHash(previousLayer) ||
    !isTime(previousIssue) || !isTime(enrolledAt) || !isTime(edgeIssue)) return undefined;
  return Object.freeze({ digest, previousKey, previousSerial, previousLayer, previousIssue, enrolledAt, edgeIssue });
}

export function handoverDigest(envelope: unknown, proof: Omit<ProtectedHandover, 'digest'>): string {
  const { previousKey, previousSerial, previousLayer, previousIssue, enrolledAt, edgeIssue } = proof;
  return createHash('sha256').update(canonicalBytes([
    'near-ai/accepted-organization-handover/1', previousKey, previousSerial, previousLayer, previousIssue, enrolledAt, edgeIssue, envelope
  ])).digest('hex');
}

export function pendingFingerprint(pin: OrganizationPin): string {
  return createHash('sha256').update(canonicalBytes(['near-ai/organization-handover-preview/1', pin])).digest('hex');
}

export function samePin(a: OrganizationPin, b: OrganizationPin): boolean {
  return canonicalBytes(a).equals(canonicalBytes(b));
}

function pendingOf(value: unknown): PendingOrganizationPin | undefined {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'publicKey', 'serial', 'issuedAt', 'layerHash'], ['handover', 'priorFiles'])) return undefined;
  const kind = own(value, 'kind');
  const publicKey = own(value, 'publicKey');
  const serial = own(value, 'serial');
  const issuedAt = own(value, 'issuedAt');
  const layerHash = own(value, 'layerHash');
  if ((kind !== 'enrol' && kind !== 'rotate' && kind !== 'update') || !isPublicKey(publicKey) || !isSerial(serial) || !isTime(issuedAt) || !isHash(layerHash)) return undefined;
  const handover = handoverOf(value.handover);
  if (Object.hasOwn(value, 'handover') && (kind !== 'rotate' || handover === undefined)) return undefined;
  const prior = value.priorFiles;
  let priorFiles: HandoverFileHeads | undefined;
  if (Object.hasOwn(value, 'priorFiles')) {
    if (handover === undefined || !isRecord(prior) || !exactKeys(prior, ['layer', 'enrollment']) ||
      (prior.layer !== null && !isHash(prior.layer)) || (prior.enrollment !== null && !isHash(prior.enrollment))) return undefined;
    priorFiles = Object.freeze({ layer: prior.layer, enrollment: prior.enrollment });
  }
  return Object.freeze({ kind, publicKey, serial, issuedAt, layerHash, ...(handover === undefined ? {} : { handover }),
    ...(priorFiles === undefined ? {} : { priorFiles }) });
}

function pinOf(text: string): OrganizationPinRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'damaged' };
  }
  if (!isRecord(value) || own(value, 'v') !== 1) return { state: 'damaged' };
  if (exactKeys(value, ['v', 'pending'])) {
    const pending = pendingOf(own(value, 'pending'));
    return pending !== undefined && pending.kind === 'enrol' ? { state: 'pending-enrol', pending } : { state: 'damaged' };
  }
  if (!exactKeys(value, ['v', 'publicKey', 'serial', 'lastIssuedAt', 'layerHash', 'enrolledAt'], ['pending', 'requirements', 'acceptedHandover'])) return { state: 'damaged' };
  const publicKey = own(value, 'publicKey');
  const serial = own(value, 'serial');
  const lastIssuedAt = own(value, 'lastIssuedAt');
  const layerHash = own(value, 'layerHash');
  const enrolledAt = own(value, 'enrolledAt');
  if (!isPublicKey(publicKey) || !isSerial(serial) || !isTime(lastIssuedAt) || !isHash(layerHash) || !isTime(enrolledAt)) return { state: 'damaged' };
  let requirements: Readonly<Record<string, readonly string[]>> | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'requirements')) {
    requirements = requirementsOf(own(value, 'requirements'));
    if (requirements === undefined) return { state: 'damaged' };
  }
  const acceptedHandover = handoverOf(value.acceptedHandover);
  if (Object.hasOwn(value, 'acceptedHandover') && acceptedHandover === undefined) return { state: 'damaged' };
  const base = { v: 1 as const, publicKey, serial, lastIssuedAt, layerHash, enrolledAt, ...(requirements === undefined ? {} : { requirements }),
    ...(acceptedHandover === undefined ? {} : { acceptedHandover }) };
  if (!Object.prototype.hasOwnProperty.call(value, 'pending')) return { state: 'pinned', pin: Object.freeze(base) };
  const pending = pendingOf(own(value, 'pending'));
  // A pending first enrolment beside a committed pin is not a state this store writes.
  if (pending === undefined || pending.kind === 'enrol') return { state: 'damaged' };
  return { state: 'pinned', pin: Object.freeze({ ...base, pending }) };
}

/** Reads the pin. A secret store that cannot be read throws, and the caller fails closed (like readLastValid). */
export async function readOrganizationPin(secrets: SecretStorageLike): Promise<OrganizationPinRead> {
  const text = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  if (text === undefined || text === '') return { state: 'absent' };
  return pinOf(text);
}

// Stores the pin text (or removes it, for `undefined`) and reads it back, like clockMarker.ts. Throws a plain Error when the read-back differs.
export async function storePinText(secrets: SecretStorageLike, text: string | undefined): Promise<void> {
  if (text === undefined) await secrets.delete(ORGANIZATION_ISSUER_SECRET);
  else await secrets.store(ORGANIZATION_ISSUER_SECRET, text);
  const back = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  const expected = text ?? '';
  if ((back ?? '') !== expected) throw new Error('The record of your organization\'s key could not be read back from this computer\'s secret storage, so it was not used.');
}

export function committedPin(pin: OrganizationPin): OrganizationPin {
  return Object.freeze({
    v: 1, publicKey: pin.publicKey, serial: pin.serial, lastIssuedAt: pin.lastIssuedAt, layerHash: pin.layerHash, enrolledAt: pin.enrolledAt,
    ...(pin.requirements === undefined ? {} : { requirements: pin.requirements }),
    ...(pin.acceptedHandover === undefined ? {} : { acceptedHandover: pin.acceptedHandover })
  });
}

export interface RecordFacts {
  readonly name: string;
  readonly contacts: readonly PolicyContact[];
}

export interface ReadContext {
  readonly pin: OrganizationPinRead;
  readonly deviceKey?: string;
  readonly now: number;
  readonly lastValidAt?: number;
  readonly record?: RecordFacts;
}

export interface FileFacts {
  readonly kind: OrganizationChangeKind | 'same';
  /** The org-policy-layer envelope to write. */
  readonly layer: unknown;
  readonly layerHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The key the pin will hold and the layer is signed by. */
  readonly publicKey: string;
  readonly serial: number;
  /** The enrolment envelope to keep, for an enrolment file. */
  readonly enrolment?: unknown;
  readonly name?: string;
  readonly contacts: readonly PolicyContact[];
  readonly words?: readonly string[];
  readonly fingerprintHex: string;
  /** The layer's document, so an update can be compared with the rules in force (Phase 71, D-12). */
  readonly document?: PolicyDocument;
}

type FileReading = { readonly ok: true; readonly facts: FileFacts } | { readonly ok: false; readonly reason: string; readonly sentence: string };

const refusedFile = (reason: string, sentence: string): FileReading => ({ ok: false, reason, sentence });

export function contactsOfDocument(document: PolicyDocument): readonly PolicyContact[] | undefined {
  const contacts = document.onboarding?.contacts;
  return contacts !== undefined && contacts.length > 0 ? contacts : undefined;
}

// The file's purpose decides its kind; the text is capped at 1 MiB before it is parsed. Never throws.
export function readOrganizationFile(text: string, context: ReadContext): FileReading {
  try {
    if (typeof text !== 'string') return refusedFile('malformed', NOT_ORGANIZATION_FILE_TEXT);
    if (Buffer.byteLength(text, 'utf8') > MAX_ORGANIZATION_LAYER_BYTES) return refusedFile('too-large', ORGANIZATION_LAYER_REFUSALS['too-large']);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refusedFile('malformed', NOT_ORGANIZATION_FILE_TEXT);
    }
    if (!isRecord(value)) return refusedFile('malformed', NOT_ORGANIZATION_FILE_TEXT);
    const purpose = own(value, 'purpose');
    if (purpose === 'org-enrolment') return readEnrolmentText(text, context);
    if (purpose === 'org-policy-layer') return readLayerValue(value, context);
    return refusedFile('malformed', NOT_ORGANIZATION_FILE_TEXT);
  } catch {
    return refusedFile('malformed', NOT_ORGANIZATION_FILE_TEXT);
  }
}

function readEnrolmentText(text: string, context: ReadContext): FileReading {
  const read = readEnrolmentFile(text, {
    now: context.now,
    ...(context.deviceKey === undefined ? {} : { deviceKey: context.deviceKey }),
    ...(context.lastValidAt === undefined ? {} : { lastValidAt: context.lastValidAt })
  });
  if (!read.ok) return refusedFile(read.reason, read.message);
  const pin = context.pin.state === 'pinned' ? context.pin.pin : undefined;
  const enrolment = read.enrolment;
  const contacts = contactsOfDocument(read.layer.document) ?? enrolment.organization.contacts;
  const base = {
    layer: enrolment.layer,
    layerHash: read.layer.hash,
    issuedAt: read.layer.issuedAt,
    expiresAt: read.layer.expiresAt,
    publicKey: enrolment.issuer.publicKey,
    enrolment: JSON.parse(text) as unknown,
    name: enrolment.organization.name,
    contacts,
    words: read.words,
    fingerprintHex: read.fingerprintHex,
    document: read.layer.document
  };
  const kind = classifyEnrolment(read, pin === undefined ? undefined : { publicKey: pin.publicKey, serial: pin.serial });
  if (kind === 'older-file' || kind === 'other-organization') return refusedFile(kind, ENROLMENT_REFUSALS[kind]);
  if (pin === undefined || kind === 'enrol') return { ok: true, facts: { ...base, kind: 'enrol', serial: enrolment.serial } };
  const issued = timeOf(read.layer.issuedAt);
  const last = timeOf(pin.lastIssuedAt);
  if (kind === 'rotate') {
    // A handover may not carry rules older than the rules in use (D-14).
    if (Number.isNaN(last) || issued < last) return refusedFile('older', ORGANIZATION_LAYER_REFUSALS.older);
    return { ok: true, facts: { ...base, kind: 'rotate', serial: enrolment.serial } };
  }
  // The pinned key's own enrolment file: an update of its layer, read like a rules file.
  if (read.layer.hash === pin.layerHash) return { ok: true, facts: { ...base, kind: 'same', serial: pin.serial } };
  if (Number.isNaN(last) || issued <= last) return refusedFile('older', ORGANIZATION_LAYER_REFUSALS.older);
  // The higher serial is kept (IN-01), so a handover your organization made before this file and then abandoned no longer reads as newer.
  return { ok: true, facts: { ...base, kind: 'update', serial: Math.max(pin.serial, enrolment.serial) } };
}

function readLayerValue(value: unknown, context: ReadContext): FileReading {
  if (context.pin.state !== 'pinned') return refusedFile('not-enrolled', NOT_ENROLLED_TEXT);
  const pin = context.pin.pin;
  const read = verifyOrganizationLayer(value, {
    issuerPublicKey: pin.publicKey, now: context.now, lastIssuedAt: pin.lastIssuedAt, ...(context.lastValidAt === undefined ? {} : { lastValidAt: context.lastValidAt })
  });
  if (!read.ok) return refusedFile(read.reason, read.message);
  const facts = {
    layer: value,
    layerHash: read.hash,
    issuedAt: read.issuedAt,
    expiresAt: read.expiresAt,
    publicKey: pin.publicKey,
    serial: pin.serial,
    ...(context.record === undefined ? {} : { name: context.record.name }),
    contacts: contactsOfDocument(read.document) ?? context.record?.contacts ?? [],
    fingerprintHex: issuerFingerprintHex(pin.publicKey),
    document: read.document
  };
  if (read.hash === pin.layerHash) return { ok: true, facts: { ...facts, kind: 'same' } };
  // Equal issuedAt with another hash is a different file claiming the same moment: refused like an older one.
  if (timeOf(read.issuedAt) <= timeOf(pin.lastIssuedAt)) return refusedFile('older', ORGANIZATION_LAYER_REFUSALS.older);
  return { ok: true, facts: { ...facts, kind: 'update' } };
}
