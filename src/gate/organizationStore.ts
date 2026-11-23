// Your organization's rules on this computer (FND-01, FND-02, D-13 to D-15, D-21, D-57): the organization layer under <globalStorage>/gate/organization/,
// the pin of the key that signs it, and the layered load every decision reads. Node I/O only: this module never imports vscode, SecretStorage is reached
// through the type-only SecretStorageLike interface, locks go through withFileLock and writes through writeFileAtomic. Nothing here waits on the network.
//
// Three key sources, never mixed (D-15): your organization's layer is checked only against the pinned issuer key, the personal layer only against this
// device's own key history (bundleStore.ts), and an enrolment file only against the key it names, after the person compared its twelve words aloud.
//
// The pin and the issuedAt of the last accepted organization layer live in SecretStorage, beside the clock marker, so a disk writer can neither reset
// them nor roll the layer back: a layer file that is older than the pin, or as old with another hash, fails the whole policy closed as replaced. The order
// of every change (D-13, D-57): the pin is stored with a `pending` record, the files are written, read back and verified, then the pin is committed.
// A crash before the commit of a first enrolment leaves the computer not enrolled (a pending first enrolment is no pin); a crash during an update or a
// key handover finishes at the next start from the pending record (its words were confirmed before it was written). An old file is copied aside before
// the new one replaces it atomically, so there is never a moment with no layer file.
//
// Files in the organization folder with no pin at all are never what this store leaves behind: a first enrolment stores its pending pin before any
// file, and a failed one removes its files before it removes that pin (or keeps the pending pin when a file could not be removed). So no pin beside
// those files means the pin was lost (secret storage cleared or switched), and the load fails closed as a damaged pin rather than dropping your
// organization's rules (CR-01). Opening your organization's enrolment file again repairs it; while it is written no pending pin is stored, so a
// crash during that repair still reads as a damaged pin, never as not enrolled.
//
// An organization layer that fails for any reason fails the whole policy closed with your organization's own sentence and contact (D-21): there is never
// a fallback to the personal layer alone, and its failed state never carries the mark that lets a surface offer the personal reset as its fix.
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { bundleHash, effectiveNow, failedClosed } from '../domain/gate/bundle';
import type { BundleFailureReason, BundleState } from '../domain/gate/bundle';
import {
  ENROLMENT_REFUSALS, MAX_ENROLMENT_FILE_BYTES, ORGANIZATION_LAYER_REFUSALS, classifyEnrolment, contactShown, issuerFingerprintHex, organizationEndedText,
  readEnrolmentFile, verifyOrganizationLayer
} from '../domain/gate/enrolment';
import type { OrganizationLayerRead } from '../domain/gate/enrolment';
import { composeLayers } from '../domain/gate/layers';
import type { IgnoredSetting } from '../domain/gate/layers';
import { MAX_ORGANIZATION_LAYER_BYTES, bundleViewOf, parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { parseContacts } from '../domain/gate/sections';
import type { PolicyContact } from '../domain/gate/sections';
import { migrateLocalHosts } from '../domain/gate/endpoints';
import type { MigrationChange } from '../domain/gate/endpoints';
import { labelKeyShown } from '../domain/gate/labelAlgebra';
import { verifyPayload } from '../domain/team/signedPayload';
import { loadDeviceIdentity } from '../team/identity';
import { writeFileAtomic } from '../team/teamFile';
import { BUNDLE_LOCK_FILE, ensurePolicyBundle, gateDir } from './bundleStore';
import type { BundleEvent, BundleResult, BundleStoreOptions } from './bundleStore';
import { readLastValid } from './clockMarker';

/** The folder under the gate folder that holds your organization's files. installEvidence.ts keeps a copy of the name; a test keeps the two equal. */
export const ORGANIZATION_DIR_NAME = 'organization';
/** Your organization's layer as last accepted: the signed org-policy-layer envelope, compact JSON. */
export const ORGANIZATION_LAYER_FILE = 'organization-layer.json';
/** The verified enrolment envelope, kept for your organization's name and contacts. */
export const ENROLMENT_RECORD_FILE = 'enrolment.json';
/** The SecretStorage key of the pin. Read by every later version: never renamed. */
export const ORGANIZATION_ISSUER_SECRET = 'nearAi.gate.organizationIssuer';

/** The command a person runs to give this computer a file from your organization (41-14 registers it). */
const ADD_RULES_COMMAND = 'SovAI: Add Your Organization\'s Rules';
const MAX_ASIDE_ATTEMPTS = 50;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SERIAL = 2 ** 31;

export const NOT_ENROLLED_TEXT = 'This computer has no rules from your organization yet. Open the enrolment file your organization\'s security contact gave you first.';
export const DAMAGED_PIN_TEXT = `NEAR AI could not read which key your organization uses on this computer. Open your organization's enrolment file again with ${ADD_RULES_COMMAND}.`;
export const WORDS_NOT_CONFIRMED_TEXT = 'Nothing was changed: the twelve words were not confirmed, so this computer does not use these rules.';
const NOT_ORGANIZATION_FILE_TEXT = 'This is not a file from your organization that this version of NEAR AI can read. Ask your organization\'s security contact for a new one.';
const MISSING_LAYER_TEXT = 'Your organization\'s rules file is missing from this computer, so only reading and planning run.';
const SECRET_UNREADABLE_TEXT = 'NEAR AI could not read its record of your organization\'s key in this computer\'s secret storage, so only reading and planning run.';
const PIN_NOT_SAVED_TEXT = 'Nothing was changed: NEAR AI could not update its record of your organization\'s key in this computer\'s secret storage.';
const FILES_NOT_SAVED_TEXT = 'Nothing was changed: your organization\'s rules could not be saved and read back in this extension\'s storage folder.';

function askFor(contact: string): string {
  return `Ask ${contact} for the rules file, then run ${ADD_RULES_COMMAND}.`;
}

/** A refusal sentence with its general "Ask your organization's security contact ..." ending removed, so the named contact is asked once. */
function withoutGeneralAsk(sentence: string): string {
  const at = sentence.indexOf(' Ask your organization\'s security contact');
  return at === -1 ? sentence : sentence.slice(0, at);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function timeOf(text: string): number {
  return Date.parse(text);
}

function dateShown(iso: string): string {
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The pin

export type OrganizationChangeKind = 'enrol' | 'rotate' | 'update';

/** A change being written: the key and serial it will pin, the layer's issuedAt and hash. */
export interface PendingOrganizationPin {
  readonly kind: OrganizationChangeKind;
  readonly publicKey: string;
  readonly serial: number;
  readonly issuedAt: string;
  readonly layerHash: string;
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

function pendingOf(value: unknown): PendingOrganizationPin | undefined {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'publicKey', 'serial', 'issuedAt', 'layerHash'])) return undefined;
  const kind = own(value, 'kind');
  const publicKey = own(value, 'publicKey');
  const serial = own(value, 'serial');
  const issuedAt = own(value, 'issuedAt');
  const layerHash = own(value, 'layerHash');
  if ((kind !== 'enrol' && kind !== 'rotate' && kind !== 'update') || !isPublicKey(publicKey) || !isSerial(serial) || !isTime(issuedAt) || !isHash(layerHash)) return undefined;
  return Object.freeze({ kind, publicKey, serial, issuedAt, layerHash });
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
  if (!exactKeys(value, ['v', 'publicKey', 'serial', 'lastIssuedAt', 'layerHash', 'enrolledAt'], ['pending'])) return { state: 'damaged' };
  const publicKey = own(value, 'publicKey');
  const serial = own(value, 'serial');
  const lastIssuedAt = own(value, 'lastIssuedAt');
  const layerHash = own(value, 'layerHash');
  const enrolledAt = own(value, 'enrolledAt');
  if (!isPublicKey(publicKey) || !isSerial(serial) || !isTime(lastIssuedAt) || !isHash(layerHash) || !isTime(enrolledAt)) return { state: 'damaged' };
  if (!Object.prototype.hasOwnProperty.call(value, 'pending')) return { state: 'pinned', pin: Object.freeze({ v: 1, publicKey, serial, lastIssuedAt, layerHash, enrolledAt }) };
  const pending = pendingOf(own(value, 'pending'));
  // A pending first enrolment beside a committed pin is not a state this store writes.
  if (pending === undefined || pending.kind === 'enrol') return { state: 'damaged' };
  return { state: 'pinned', pin: Object.freeze({ v: 1, publicKey, serial, lastIssuedAt, layerHash, enrolledAt, pending }) };
}

/** Reads the pin. A secret store that cannot be read throws, and the caller fails closed (like readLastValid). */
export async function readOrganizationPin(secrets: SecretStorageLike): Promise<OrganizationPinRead> {
  const text = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  if (text === undefined || text === '') return { state: 'absent' };
  return pinOf(text);
}

// Stores the pin text (or removes it, for `undefined`) and reads it back, like clockMarker.ts. Throws a plain Error when the read-back differs.
async function storePinText(secrets: SecretStorageLike, text: string | undefined): Promise<void> {
  if (text === undefined) await secrets.delete(ORGANIZATION_ISSUER_SECRET);
  else await secrets.store(ORGANIZATION_ISSUER_SECRET, text);
  const back = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  const expected = text ?? '';
  if ((back ?? '') !== expected) throw new Error('The record of your organization\'s key could not be read back from this computer\'s secret storage, so it was not used.');
}

function committedPin(pin: OrganizationPin): OrganizationPin {
  return Object.freeze({ v: 1, publicKey: pin.publicKey, serial: pin.serial, lastIssuedAt: pin.lastIssuedAt, layerHash: pin.layerHash, enrolledAt: pin.enrolledAt });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The test probe (D-57)

/** `old-kept` follows the copy of a file that is about to be replaced; it is reached only when there was a file to keep. */
export type OrganizationWriteStep = 'pin-pending' | 'old-kept' | 'layer-written' | 'pin-committed';
export type OrganizationWriteProbe = (step: OrganizationWriteStep, kind: OrganizationChangeKind) => void | Promise<void>;

let writeProbe: OrganizationWriteProbe | undefined;

/**
 * Test only: called and awaited after each step of a change. A probe that throws stands for the process ending at that step: nothing after it runs, not
 * even the clean-up, so a test sees exactly what a crash there leaves behind. Pass undefined to remove it.
 */
export function setOrganizationWriteProbe(probe: OrganizationWriteProbe | undefined): void {
  writeProbe = probe;
}

class StoppedByProbe {
  public constructor(public readonly cause: unknown) {}
}

async function probeStep(step: OrganizationWriteStep, kind: OrganizationChangeKind): Promise<void> {
  const probe = writeProbe;
  if (probe === undefined) return;
  try {
    await probe(step, kind);
  } catch (error) {
    throw new StoppedByProbe(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Errors and results

/** A change that did not happen, with a plain message that starts "Nothing was changed". `refused` is true when the file itself was refused. */
export class OrganizationStoreError extends Error {
  public readonly reason: string;
  public readonly refused: boolean;

  public constructor(message: string, options: { readonly reason: string; readonly refused?: boolean; readonly cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrganizationStoreError';
    this.reason = options.reason;
    this.refused = options.refused === true;
  }
}

/** The events this store reports for the caller to record. */
export type OrganizationEventId = 'policy.enrolled' | 'policy.organization-updated' | 'policy.organization-refused';

export interface OrganizationEvent {
  readonly event: OrganizationEventId;
  readonly detail?: string;
}

/**
 * `repair`: the file is the one the pin names, but the copy on this computer was missing, or another file stood in its place, so the files were written
 * again from it. The pin did not move.
 */
export type OrganizationFileKind = OrganizationChangeKind | 'same' | 'repair';

export interface OrganizationAcceptResult {
  readonly kind: OrganizationFileKind;
  /** Absent for `same`: nothing was written. */
  readonly event?: OrganizationEvent;
}

/** What a file would do on this computer, for the confirmation step (41-14). Never throws. */
export type OrganizationFilePreview =
  | {
    readonly kind: OrganizationFileKind;
    readonly name?: string;
    readonly contacts: readonly PolicyContact[];
    /** The twelve words, for an enrolment file. */
    readonly words?: readonly string[];
    readonly fingerprintHex: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }
  | { readonly kind: 'refused'; readonly reason: string; readonly sentence: string };

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reading a file a person gives this computer

interface RecordFacts {
  readonly name: string;
  readonly contacts: readonly PolicyContact[];
}

interface ReadContext {
  readonly pin: OrganizationPinRead;
  readonly deviceKey?: string;
  readonly now: number;
  readonly lastValidAt?: number;
  readonly record?: RecordFacts;
}

interface FileFacts {
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
}

type FileReading = { readonly ok: true; readonly facts: FileFacts } | { readonly ok: false; readonly reason: string; readonly sentence: string };

const refusedFile = (reason: string, sentence: string): FileReading => ({ ok: false, reason, sentence });

function contactsOfDocument(document: PolicyDocument): readonly PolicyContact[] | undefined {
  const contacts = document.onboarding?.contacts;
  return contacts !== undefined && contacts.length > 0 ? contacts : undefined;
}

// The file's purpose decides its kind; the text is capped at 1 MiB before it is parsed. Never throws.
function readOrganizationFile(text: string, context: ReadContext): FileReading {
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
    fingerprintHex: read.fingerprintHex
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
    fingerprintHex: issuerFingerprintHex(pin.publicKey)
  };
  if (read.hash === pin.layerHash) return { ok: true, facts: { ...facts, kind: 'same' } };
  // Equal issuedAt with another hash is a different file claiming the same moment: refused like an older one.
  if (timeOf(read.issuedAt) <= timeOf(pin.lastIssuedAt)) return refusedFile('older', ORGANIZATION_LAYER_REFUSALS.older);
  return { ok: true, facts: { ...facts, kind: 'update' } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Loading the layer on disk

/** The organization layer as a load found it. `event` is set when the load committed a newer layer (a roll forward, or a newer file signed by the pin). */
export type OrganizationLoad =
  | { readonly state: 'none' }
  | (OrganizationValid & { readonly event?: OrganizationEvent })
  | OrganizationFailed;

export interface OrganizationValid {
  readonly state: 'valid';
  readonly document: PolicyDocument;
  readonly hash: string;
  readonly issuerPublicKey: string;
  readonly fingerprintHex: string;
  readonly name?: string;
  readonly contacts: readonly PolicyContact[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** In the last 30 days before expiresAt (D-14's renewal notice). */
  readonly endsSoon: boolean;
}

export interface OrganizationFailed {
  readonly state: 'failed';
  readonly reason: string;
  readonly sentence: string;
  readonly name?: string;
  readonly contacts?: readonly PolicyContact[];
  /** The failed-closed state the whole policy takes. Never carries the personal layer's ownPolicy mark. */
  readonly failure: Extract<BundleState, { state: 'failed-closed' }>;
  /** True when a file was refused (recorded as policy.organization-refused), false for a missing file, an expiry or an unreadable store. */
  readonly refused: boolean;
}

export interface OrganizationStoreOptions {
  readonly now?: () => Date;
}

function damagedPin(): OrganizationFailed {
  return failedOrganization('damaged-pin', 'malformed', DAMAGED_PIN_TEXT, false);
}

function failedOrganization(
  reason: string, failure: BundleFailureReason, sentence: string, refused: boolean, facts: { readonly name?: string; readonly contacts?: readonly PolicyContact[] } = {}
): OrganizationFailed {
  return {
    state: 'failed',
    reason,
    sentence,
    ...(facts.name === undefined ? {} : { name: facts.name }),
    ...(facts.contacts === undefined ? {} : { contacts: facts.contacts }),
    failure: { state: 'failed-closed', reason: failure, sentence, detail: `Your organization's layer: ${reason}.` },
    refused
  };
}

/** The state shown when your organization's rules have ended: the date and the contact (D-14). */
function endedState(expiresAt: string, contacts: readonly PolicyContact[] | undefined): Extract<BundleState, { state: 'failed-closed' }> {
  return { state: 'failed-closed', reason: 'expired', sentence: organizationEndedText(dateShown(expiresAt), contactShown(contacts)) };
}

// A refused layer as your organization's failed state. Expired names the date and the contact; an update or a clock fix says only that; the rest add
// who to ask and the command to run. Never a personal reset sentence.
function failedFromRead(read: Extract<OrganizationLayerRead, { ok: false }>, raw: unknown, record: RecordFacts | undefined): OrganizationFailed {
  const facts = { ...(record === undefined ? {} : { name: record.name, contacts: record.contacts }) };
  if (read.reason === 'expired') {
    // The signature was checked before the expiry, so the payload's own contacts and date may be read for the sentence.
    const payload = isRecord(raw) ? own(raw, 'payload') : undefined;
    const parsed = parsePolicyDocument(payload);
    const contacts = (parsed.ok ? contactsOfDocument(parsed.value) : undefined) ?? record?.contacts;
    const expiresAt = parsed.ok ? parsed.value.expiresAt : '';
    const ended = endedState(expiresAt, contacts);
    return { ...failedOrganization('expired', 'expired', ended.sentence, false, { ...facts, ...(contacts === undefined ? {} : { contacts }) }) };
  }
  if (read.reason === 'needs-update' || read.reason === 'clock-behind') return failedOrganization(read.reason, read.failure, read.message, false, facts);
  return failedOrganization(read.reason, read.failure, `${withoutGeneralAsk(read.message)} ${askFor(contactShown(record?.contacts))}`, true, facts);
}

/**
 * Your organization's layer on this computer: reads and loads it against the pin, and accepts a file a person gives it. One instance per call is fine:
 * it holds no state beyond its options.
 */
export class OrganizationStore {
  public constructor(private readonly globalStorageDir: string, private readonly secrets: SecretStorageLike, private readonly options: OrganizationStoreOptions = {}) {}

  private get folder(): string {
    return path.join(gateDir(this.globalStorageDir), ORGANIZATION_DIR_NAME);
  }

  private get layerFile(): string {
    return path.join(this.folder, ORGANIZATION_LAYER_FILE);
  }

  private get recordFile(): string {
    return path.join(this.folder, ENROLMENT_RECORD_FILE);
  }

  /**
   * The organization layer at the effective time (the later of the clock and the clock marker, so a clock set back never revives an expired layer).
   * Never throws: a store that cannot be read fails closed.
   */
  public async load(effective: number): Promise<OrganizationLoad> {
    try {
      if (!Number.isFinite(effective)) return failedOrganization('clock-behind', 'clock-behind', ORGANIZATION_LAYER_REFUSALS['clock-behind'], false);
      return await this.loadAt(effective);
    } catch {
      return failedOrganization('unavailable', 'identity-unavailable', SECRET_UNREADABLE_TEXT, false);
    }
  }

  private async loadAt(effective: number): Promise<OrganizationLoad> {
    const read = await readOrganizationPin(this.secrets);
    // A first enrolment that did not commit is no organization layer, whatever files it wrote (D-13, D-57): its pending pin is the evidence.
    if (read.state === 'pending-enrol') return { state: 'none' };
    // No pin at all beside files of your organization means the pin was lost, never a crash of this store: fail closed (CR-01).
    if (read.state === 'absent') return (await this.folderHoldsFiles()) ? damagedPin() : { state: 'none' };
    if (read.state === 'damaged') return damagedPin();
    const pin = read.pin;
    const pendingKey = pin.pending?.kind === 'rotate' ? pin.pending.publicKey : undefined;
    const record = await this.readRecord(pendingKey === undefined ? [pin.publicKey] : [pin.publicKey, pendingKey]);
    const facts = record === undefined ? {} : { name: record.name, contacts: record.contacts };
    const raw = await this.readLayer();
    if (raw.state === 'missing') return failedOrganization('missing', 'missing', `${MISSING_LAYER_TEXT} ${askFor(contactShown(record?.contacts))}`, false, facts);
    if (raw.state === 'too-large') return failedOrganization('too-large', 'too-large', `${withoutGeneralAsk(ORGANIZATION_LAYER_REFUSALS['too-large'])} ${askFor(contactShown(record?.contacts))}`, true, facts);
    if (raw.state !== 'ok') return failedOrganization('malformed', 'unparseable', `${withoutGeneralAsk(ORGANIZATION_LAYER_REFUSALS.malformed)} ${askFor(contactShown(record?.contacts))}`, true, facts);
    // A change whose files were written before a crash finishes now (D-57): the words were confirmed, or the pin signed it, before pending was written.
    const pending = pin.pending;
    if (pending !== undefined) {
      const forward = verifyOrganizationLayer(raw.value, { issuerPublicKey: pending.publicKey, now: effective, lastIssuedAt: pin.lastIssuedAt });
      if (forward.ok && forward.hash === pending.layerHash) {
        const next: OrganizationPin = Object.freeze({
          v: 1, publicKey: pending.publicKey, serial: pending.serial, lastIssuedAt: pending.issuedAt, layerHash: pending.layerHash, enrolledAt: pin.enrolledAt
        });
        await this.commitFound(pin, next);
        return { ...this.validOf(forward, pending.publicKey, record), event: updatedEvent(forward.issuedAt, pending.publicKey) };
      }
    }
    const layer = verifyOrganizationLayer(raw.value, { issuerPublicKey: pin.publicKey, now: effective, lastIssuedAt: pin.lastIssuedAt });
    if (!layer.ok) return failedFromRead(layer, raw.value, record);
    if (layer.hash === pin.layerHash) return this.validOf(layer, pin.publicKey, record);
    if (timeOf(layer.issuedAt) > timeOf(pin.lastIssuedAt)) {
      // A newer layer signed by the pinned key: accepted, and the pin moves to it (D-14).
      const next: OrganizationPin = Object.freeze({ ...committedPin(pin), lastIssuedAt: layer.issuedAt, layerHash: layer.hash });
      await this.commitFound(pin, next);
      return { ...this.validOf(layer, pin.publicKey, record), event: updatedEvent(layer.issuedAt, pin.publicKey) };
    }
    // As old as the pin with another hash: a different file put in its place.
    return failedOrganization('older', 'replaced', `${ORGANIZATION_LAYER_REFUSALS.older} ${askFor(contactShown(record?.contacts))}`, true, facts);
  }

  private validOf(layer: Extract<OrganizationLayerRead, { ok: true }>, publicKey: string, record: RecordFacts | undefined): OrganizationValid {
    return {
      state: 'valid',
      document: layer.document,
      hash: layer.hash,
      issuerPublicKey: publicKey,
      fingerprintHex: issuerFingerprintHex(publicKey),
      ...(record === undefined ? {} : { name: record.name }),
      contacts: contactsOfDocument(layer.document) ?? record?.contacts ?? Object.freeze([]),
      issuedAt: layer.issuedAt,
      expiresAt: layer.expiresAt,
      endsSoon: layer.renewDue
    };
  }

  // Commits a pin a load found under the bundle lock, unless another window already did. Throws when it cannot, and the load fails closed.
  private async commitFound(found: OrganizationPin, next: OrganizationPin): Promise<void> {
    const dir = gateDir(this.globalStorageDir);
    await withFileLock(dir, BUNDLE_LOCK_FILE, async () => {
      const now = await readOrganizationPin(this.secrets);
      if (now.state === 'pinned' && now.pin.publicKey === next.publicKey && now.pin.layerHash === next.layerHash && now.pin.pending === undefined) return;
      if (now.state !== 'pinned' || JSON.stringify(now.pin) !== JSON.stringify(found)) throw new Error('The record of your organization\'s key changed while it was read.');
      await storePinText(this.secrets, JSON.stringify(next));
    });
  }

  // True when the organization folder holds anything (the rule installEvidence.ts reads too). A folder that cannot be read throws: the load fails closed.
  private async folderHoldsFiles(): Promise<boolean> {
    try {
      return (await readdir(this.folder)).length > 0;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async readLayer(): Promise<{ readonly state: 'ok'; readonly value: unknown } | { readonly state: 'missing' | 'too-large' | 'unreadable' }> {
    let text: string;
    try {
      if ((await stat(this.layerFile)).size > MAX_ORGANIZATION_LAYER_BYTES) return { state: 'too-large' };
      text = await readFile(this.layerFile, 'utf8');
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
    }
    try {
      return { state: 'ok', value: JSON.parse(text) as unknown };
    } catch {
      return { state: 'unreadable' };
    }
  }

  // Your organization's name and contacts from the kept enrolment envelope, verified against the pinned key (or a handover's new key). Undefined when
  // the record is missing or does not verify: a name is never read from a file the pin did not sign.
  private async readRecord(keys: readonly string[]): Promise<RecordFacts | undefined> {
    try {
      if ((await stat(this.recordFile)).size > MAX_ENROLMENT_FILE_BYTES) return undefined;
      const value: unknown = JSON.parse(await readFile(this.recordFile, 'utf8'));
      const verdict = verifyPayload<unknown>(value, {
        purpose: 'org-enrolment', status: (key) => ({ state: keys.includes(key.publicKey) ? 'active' : 'unknown' }), maxBytes: MAX_ENROLMENT_FILE_BYTES
      });
      if (!verdict.ok || !isRecord(verdict.payload)) return undefined;
      const organization = own(verdict.payload, 'organization');
      if (!isRecord(organization)) return undefined;
      const name = own(organization, 'name');
      const contacts = parseContacts(own(organization, 'contacts'));
      if (typeof name !== 'string' || name.length === 0 || name.length > 120 || !contacts.ok) return undefined;
      return { name, contacts: contacts.value };
    } catch {
      return undefined;
    }
  }

  /** Everything a file is read against: the pin, this computer's key, the clock marker and the kept record. Throws when the secret store cannot be read. */
  public async readContext(nowMs: number): Promise<ReadContext> {
    const marker = await readLastValid(this.secrets);
    const pin = await readOrganizationPin(this.secrets);
    const identity = await loadDeviceIdentity(this.secrets);
    const record = pin.state === 'pinned' ? await this.readRecord([pin.pin.publicKey]) : undefined;
    return {
      pin,
      now: nowMs,
      ...(identity === undefined ? {} : { deviceKey: identity.publicKey }),
      ...(marker.present && marker.at !== undefined ? { lastValidAt: marker.at } : {}),
      ...(record === undefined ? {} : { record })
    };
  }

  /**
   * Takes a file a person gave this computer: an enrolment file or a rules file from your organization (D-11 to D-14). Under bundle.lock it reads the
   * pin and the file again, refuses what the pin does not allow, and needs `wordsConfirmed` for a first enrolment and a key handover (D-12). Then, in
   * order: the pin with `pending`, the files (old ones copied aside as .replaced-<ms> first), the read-back, the committed pin. Any failure puts back the
   * old files and the old pin and throws OrganizationStoreError ("Nothing was changed ..."). The file in use whose copy on this computer is missing or
   * replaced is written again without moving the pin (`repair`, WR-01). Returns the event to record, none when the file is the one in use and intact.
   */
  public async accept(text: string, confirmation: { readonly wordsConfirmed?: boolean }, nowMs: number): Promise<OrganizationAcceptResult> {
    if (!Number.isFinite(nowMs)) throw new OrganizationStoreError('Nothing was changed: the clock gave no valid time.', { reason: 'clock' });
    const dir = gateDir(this.globalStorageDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return withFileLock(dir, BUNDLE_LOCK_FILE, async (): Promise<OrganizationAcceptResult> => {
      let context: ReadContext;
      try {
        context = await this.readContext(nowMs);
      } catch (error) {
        throw new OrganizationStoreError(`Nothing was changed. ${SECRET_UNREADABLE_TEXT}`, { reason: 'unavailable', cause: error });
      }
      const reading = readOrganizationFile(text, context);
      if (!reading.ok) {
        const message = reading.sentence.includes('Nothing was changed') ? reading.sentence : `Nothing was changed. ${reading.sentence}`;
        throw new OrganizationStoreError(message, { reason: reading.reason, refused: true });
      }
      const facts = reading.facts;
      if (facts.kind === 'same') {
        const repairs = await this.repairsFor(facts, context, nowMs);
        if (repairs.length === 0 || context.pin.state !== 'pinned') return { kind: 'same' };
        await this.repair(repairs, context.pin.pin, nowMs, context.lastValidAt);
        return { kind: 'repair', event: { event: 'policy.organization-updated', detail: repairDetail(facts.issuedAt, facts.publicKey) } };
      }
      if ((facts.kind === 'enrol' || facts.kind === 'rotate') && confirmation.wordsConfirmed !== true) {
        throw new OrganizationStoreError(WORDS_NOT_CONFIRMED_TEXT, { reason: 'words-not-confirmed' });
      }
      // An enrolment over a lost or damaged pin (files of your organization are here, or the stored pin does not read) stores no pending pin, so a crash
      // before its commit still reads as a damaged pin and never as not enrolled (CR-01). A folder that cannot be read counts as holding files.
      const recovering = facts.kind === 'enrol'
        && (context.pin.state === 'damaged' || (context.pin.state === 'absent' && await this.folderHoldsFiles().catch(() => true)));
      await this.write({ ...facts, kind: facts.kind }, context, nowMs, recovering);
      const event: OrganizationEventId = facts.kind === 'enrol' ? 'policy.enrolled' : 'policy.organization-updated';
      return { kind: facts.kind, event: { event, detail: changeDetail(facts.issuedAt, facts.publicKey) } };
    });
  }

  /**
   * The files to write again for a file that is the one the pin names (WR-01): the layer when the copy on disk does not read back as the pinned layer
   * (or as a pending change's layer, which the next load finishes), and, for an enrolment file, the record when it does not verify against the pinned
   * key. Empty when nothing needs writing, or the file is not exactly the pinned one (same key, same hash, same issuedAt). Reads only.
   */
  public async repairsFor(facts: FileFacts, context: ReadContext, nowMs: number): Promise<readonly FileToWrite[]> {
    if (facts.kind !== 'same' || context.pin.state !== 'pinned') return [];
    const pin = context.pin.pin;
    if (facts.publicKey !== pin.publicKey || facts.layerHash !== pin.layerHash || facts.issuedAt !== pin.lastIssuedAt) return [];
    const files: FileToWrite[] = [];
    if (!(await this.layerOnDiskIsPinned(pin, nowMs, context.lastValidAt))) files.push({ file: this.layerFile, text: layerTextOf(facts.layer) });
    if (facts.enrolment !== undefined && (await this.readRecord([pin.publicKey])) === undefined) files.push({ file: this.recordFile, text: layerTextOf(facts.enrolment) });
    return files;
  }

  private async layerOnDiskIsPinned(pin: OrganizationPin, nowMs: number, lastValidAt: number | undefined): Promise<boolean> {
    const raw = await this.readLayer();
    if (raw.state !== 'ok') return false;
    const expected: Array<readonly [string, string]> = [[pin.publicKey, pin.layerHash]];
    if (pin.pending !== undefined) expected.push([pin.pending.publicKey, pin.pending.layerHash]);
    return expected.some(([issuerPublicKey, hash]) => {
      const read = verifyOrganizationLayer(raw.value, {
        issuerPublicKey, now: nowMs, lastIssuedAt: pin.lastIssuedAt, ...(lastValidAt === undefined ? {} : { lastValidAt })
      });
      return read.ok && read.hash === hash;
    });
  }

  // Writes the pinned files again (WR-01). The pin does not move; a failure puts back what was there and throws "Nothing was changed".
  private async repair(files: readonly FileToWrite[], pin: OrganizationPin, nowMs: number, lastValidAt: number | undefined): Promise<void> {
    const touched: Touched[] = [];
    try {
      await this.writeKeepingOld(files, nowMs, touched, undefined);
      for (const entry of files) if ((await readFile(entry.file, 'utf8')) !== entry.text) throw new Error('A file did not read back as written.');
      if (!(await this.layerOnDiskIsPinned(pin, nowMs, lastValidAt))) throw new Error('Your organization\'s rules did not read back as written.');
    } catch (error) {
      await restoreFiles(touched);
      throw new OrganizationStoreError(FILES_NOT_SAVED_TEXT, { reason: 'write-failed', cause: error });
    }
  }

  // Writes each file over the one there after copying the old one aside as .replaced-<ms> (WR-01). The replace is atomic, so a crash at any point leaves
  // the old file or the new one in its place, never none. What was done goes into `touched` for restoreFiles.
  private async writeKeepingOld(files: readonly FileToWrite[], nowMs: number, touched: Touched[], kind: OrganizationChangeKind | undefined): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    for (const entry of files) {
      const aside = await asideFor(entry.file, nowMs);
      if (aside === undefined) {
        touched.push({ file: entry.file });
      } else {
        await copyFile(entry.file, aside, fsConstants.COPYFILE_EXCL);
        touched.push({ file: entry.file, aside });
        if (kind !== undefined) await probeStep('old-kept', kind);
      }
      await writeFileAtomic(entry.file, entry.text);
    }
  }

  private async write(facts: FileFacts & { readonly kind: OrganizationChangeKind }, context: ReadContext, nowMs: number, recovering: boolean): Promise<void> {
    let previous: string | undefined;
    try {
      previous = await this.secrets.get(ORGANIZATION_ISSUER_SECRET);
    } catch (error) {
      throw new OrganizationStoreError(PIN_NOT_SAVED_TEXT, { reason: 'unavailable', cause: error });
    }
    const pinned = context.pin.state === 'pinned' ? committedPin(context.pin.pin) : undefined;
    const pending: PendingOrganizationPin = { kind: facts.kind, publicKey: facts.publicKey, serial: facts.serial, issuedAt: facts.issuedAt, layerHash: facts.layerHash };
    const pendingText = JSON.stringify(pinned === undefined ? { v: 1, pending } : { ...pinned, pending });
    const restorePin = async (): Promise<void> => { await storePinText(this.secrets, previous === '' ? undefined : previous).catch(() => undefined); };
    if (!recovering) {
      try {
        await storePinText(this.secrets, pendingText);
      } catch (error) {
        await restorePin();
        throw new OrganizationStoreError(PIN_NOT_SAVED_TEXT, { reason: 'unavailable', cause: error });
      }
    }
    const files = [{ file: this.layerFile, text: layerTextOf(facts.layer) }];
    if (facts.enrolment !== undefined) files.push({ file: this.recordFile, text: layerTextOf(facts.enrolment) });
    const touched: Touched[] = [];
    try {
      // In a recovery nothing is stored at this step: the lost or damaged pin stays as it was until the commit.
      await probeStep('pin-pending', facts.kind);
      await this.writeKeepingOld(files, nowMs, touched, facts.kind);
      await probeStep('layer-written', facts.kind);
      // Read back from disk: the layer must verify against the key the pin will hold and have the hash the pending record names.
      const back = verifyOrganizationLayer(await readFile(this.layerFile, 'utf8'), {
        issuerPublicKey: facts.publicKey, now: nowMs, ...(context.lastValidAt === undefined ? {} : { lastValidAt: context.lastValidAt })
      });
      if (!back.ok || back.hash !== facts.layerHash) throw new Error('Your organization\'s rules did not read back as written.');
      for (const entry of files) if ((await readFile(entry.file, 'utf8')) !== entry.text) throw new Error('A file did not read back as written.');
      const enrolledAt = facts.kind === 'enrol' || pinned === undefined ? new Date(nowMs).toISOString() : pinned.enrolledAt;
      const committed: OrganizationPin = { v: 1, publicKey: facts.publicKey, serial: facts.serial, lastIssuedAt: facts.issuedAt, layerHash: facts.layerHash, enrolledAt };
      await storePinText(this.secrets, JSON.stringify(committed));
      await probeStep('pin-committed', facts.kind);
    } catch (error) {
      if (error instanceof StoppedByProbe) throw error.cause;
      const restored = await restoreFiles(touched);
      // A first enrolment whose files could not all be taken back keeps its pending pin, so what is left reads as not enrolled (D-57) and never as a lost
      // pin that locks this computer (CR-01). Every other change puts back the pin it found.
      if (!restored && pinned === undefined && !recovering) await storePinText(this.secrets, pendingText).catch(() => undefined);
      else await restorePin();
      throw error instanceof OrganizationStoreError ? error : new OrganizationStoreError(FILES_NOT_SAVED_TEXT, { reason: 'write-failed', cause: error });
    }
  }
}

/** A file to write in the organization folder, with its full text. */
export interface FileToWrite {
  readonly file: string;
  readonly text: string;
}

interface Touched {
  readonly file: string;
  /** The copy of the file that was there before, when there was one. */
  readonly aside?: string;
}

function layerTextOf(envelope: unknown): string {
  return `${JSON.stringify(envelope)}\n`;
}

// Puts back what writeKeepingOld changed, newest first: the kept copy over the file, or the new file removed. False when any step failed.
async function restoreFiles(touched: readonly Touched[]): Promise<boolean> {
  let restored = true;
  for (const entry of [...touched].reverse()) {
    try {
      if (entry.aside !== undefined) await rename(entry.aside, entry.file);
      else await rm(entry.file, { force: true });
    } catch {
      restored = false;
    }
  }
  return restored;
}

function changeDetail(issuedAt: string, publicKey: string): string {
  return `Your organization's rules issued at ${issuedAt}, key ${issuerFingerprintHex(publicKey).replace(/ /g, '').slice(0, 16)}.`;
}

function repairDetail(issuedAt: string, publicKey: string): string {
  return `${changeDetail(issuedAt, publicKey).slice(0, -1)}, written again on this computer.`;
}

function updatedEvent(issuedAt: string, publicKey: string): OrganizationEvent {
  return { event: 'policy.organization-updated', detail: changeDetail(issuedAt, publicKey) };
}

// A name beside `file` that nothing uses, or undefined when there is no file to keep.
async function asideFor(file: string, nowMs: number): Promise<string | undefined> {
  try {
    await stat(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  for (let attempt = 0; attempt < MAX_ASIDE_ATTEMPTS; attempt += 1) {
    const target = `${file}.replaced-${nowMs}${attempt === 0 ? '' : `-${attempt + 1}`}`;
    try {
      await stat(target);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return target;
      throw error;
    }
  }
  throw new Error('The old file could not be kept under a new name.');
}

/** What a file would do on this computer, read the way accept reads it, with nothing written. Never throws. */
export async function previewOrganizationFile(globalStorageDir: string, secrets: SecretStorageLike, text: string, nowMs: number): Promise<OrganizationFilePreview> {
  try {
    const store = new OrganizationStore(globalStorageDir, secrets);
    const context = await store.readContext(nowMs);
    const reading = readOrganizationFile(text, context);
    if (!reading.ok) return { kind: 'refused', reason: reading.reason, sentence: reading.sentence };
    const facts = reading.facts;
    // The file in use whose copy on this computer is missing or replaced is a repair, which accept writes (WR-01).
    const kind = facts.kind === 'same' && (await store.repairsFor(facts, context, nowMs)).length > 0 ? 'repair' : facts.kind;
    return {
      kind,
      ...(facts.name === undefined ? {} : { name: facts.name }),
      contacts: facts.contacts,
      ...(facts.words === undefined ? {} : { words: facts.words }),
      fingerprintHex: facts.fingerprintHex,
      issuedAt: facts.issuedAt,
      expiresAt: facts.expiresAt
    };
  } catch {
    return { kind: 'refused', reason: 'unavailable', sentence: SECRET_UNREADABLE_TEXT };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The layered policy every decision reads (D-04, D-18 to D-21)

/** Both layers, the effective policy and what the person should be told (41-13, 41-14). BundleState.valid.bundle stays today's view (D-04). */
export interface PolicyLayersView {
  readonly organization:
    | { readonly state: 'none' }
    | OrganizationValid
    | { readonly state: 'failed'; readonly reason: string; readonly sentence: string; readonly name?: string; readonly contacts?: readonly PolicyContact[] };
  readonly personal?: { readonly document: PolicyDocument; readonly hash: string; readonly stored: unknown };
  readonly effective?: PolicyDocument;
  /** Personal values wider than your organization's, replaced at load and listed (D-20). */
  readonly ignored: readonly IgnoredSetting[];
  /** A v1 personal layer's local hosts read as endpoints (D-27); empty for a v2 layer. */
  readonly migration: readonly MigrationChange[];
  readonly failedLayer?: 'organization' | 'personal';
  /** The failed-closed state to show when the effective policy ends while the window is open: your organization's sentence when its layer ends first. */
  readonly expiry?: Extract<BundleState, { state: 'failed-closed' }>;
}

export interface LayeredPolicy {
  readonly state: BundleState;
  readonly layers: PolicyLayersView;
  /** Organization events the load found, for the caller to record once. */
  readonly events: readonly OrganizationEvent[];
}

const NO_ORGANIZATION: PolicyLayersView['organization'] = Object.freeze({ state: 'none' });

function viewOf(organization: OrganizationLoad): PolicyLayersView['organization'] {
  if (organization.state === 'none') return NO_ORGANIZATION;
  if (organization.state === 'failed') {
    return {
      state: 'failed', reason: organization.reason, sentence: organization.sentence,
      ...(organization.name === undefined ? {} : { name: organization.name }),
      ...(organization.contacts === undefined ? {} : { contacts: organization.contacts })
    };
  }
  return {
    state: 'valid', document: organization.document, hash: organization.hash, issuerPublicKey: organization.issuerPublicKey, fingerprintHex: organization.fingerprintHex,
    ...(organization.name === undefined ? {} : { name: organization.name }),
    contacts: organization.contacts, issuedAt: organization.issuedAt, expiresAt: organization.expiresAt, endsSoon: organization.endsSoon
  };
}

function migrationOf(personal: BundleResult): readonly MigrationChange[] {
  if (personal.state.state !== 'valid') return Object.freeze([]);
  const stored = personal.stored;
  if (isRecord(stored) && own(stored, 'bundleVersion') === 2) return Object.freeze([]);
  const bundle = personal.state.bundle;
  if (bundle.routing.localHosts.length === 0) return Object.freeze([]);
  return migrateLocalHosts(bundle.routing, bundle.scales).changes;
}

/** The layered result of a personal layer and your organization's layer as found. Pure. */
function layered(personal: BundleResult, organization: OrganizationLoad): LayeredPolicy {
  const events: OrganizationEvent[] = [];
  if (organization.state === 'valid' && organization.event !== undefined) events.push(organization.event);
  if (organization.state === 'failed' && organization.refused) events.push({ event: 'policy.organization-refused', detail: organization.reason });
  let personalState: BundleState = personal.state;
  let personalLayer: PolicyLayersView['personal'];
  if (personal.state.state === 'valid') {
    const parsed = parsePolicyDocument(personal.stored);
    if (parsed.ok) personalLayer = Object.freeze({ document: parsed.value, hash: personal.state.hash, stored: personal.stored });
    else personalState = failedClosed('malformed', 'The stored personal layer did not read as a policy.');
  }
  const base = {
    organization: viewOf(organization),
    ...(personalLayer === undefined ? {} : { personal: personalLayer }),
    ignored: Object.freeze([]) as readonly IgnoredSetting[],
    migration: migrationOf(personal)
  };
  // Your organization's failure decides first: the personal layer alone is never the policy while your organization's layer fails (D-21).
  if (organization.state === 'failed') return { state: organization.failure, layers: { ...base, failedLayer: 'organization' }, events };
  if (personalState.state !== 'valid' || personalLayer === undefined) return { state: personalState, layers: { ...base, failedLayer: 'personal' }, events };
  if (organization.state === 'none') return { state: personalState, layers: { ...base, effective: personalLayer.document }, events };
  const composed = composeLayers({ organization: organization.document, personal: personalLayer.document });
  const organizationEndsFirst = timeOf(organization.expiresAt) <= timeOf(personalState.expiresAt);
  const state: BundleState = {
    state: 'valid',
    bundle: bundleViewOf(composed.effective),
    hash: bundleHash({ organization: organization.hash, personal: personalState.hash }),
    signer: personalState.signer,
    expiresAt: organizationEndsFirst ? organization.expiresAt : personalState.expiresAt,
    renewDue: personalState.renewDue
  };
  const expiry = organizationEndsFirst ? endedState(organization.expiresAt, organization.contacts) : failedClosed('expired');
  return { state, layers: { ...base, effective: composed.effective, ignored: composed.ignored, expiry }, events };
}

/**
 * The policy every decision reads, from a personal layer already loaded (with its stored payload) and your organization's layer read now. Never throws.
 * Without an organization layer the state is exactly the personal layer's (D-18). The effective time is the clock with the clock marker's time.
 */
export async function recompose(globalStorageDir: string, secrets: SecretStorageLike, personal: BundleResult, options: OrganizationStoreOptions = {}): Promise<LayeredPolicy> {
  try {
    const nowMs = (options.now ?? ((): Date => new Date()))().getTime();
    let lastValidAt: number | undefined;
    try {
      const marker = await readLastValid(secrets);
      if (marker.present && marker.at !== undefined) lastValidAt = marker.at;
    } catch { /* the personal layer has failed closed already when the marker cannot be read */ }
    const organization = await new OrganizationStore(globalStorageDir, secrets, options).load(effectiveNow(nowMs, lastValidAt));
    return layered(personal, organization);
  } catch {
    const failure = failedClosed('identity-unavailable', 'The layered policy could not be read.');
    return {
      state: failure,
      layers: { organization: { state: 'failed', reason: 'unavailable', sentence: failure.sentence }, ignored: Object.freeze([]), migration: Object.freeze([]), failedLayer: 'organization' },
      events: []
    };
  }
}

/** The activation load: the personal layer through ensurePolicyBundle, then recompose. Never throws. `event` is the personal layer's own event. */
export async function loadLayeredPolicy(
  globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions = {}
): Promise<LayeredPolicy & { readonly event?: BundleEvent }> {
  let personal: BundleResult;
  try {
    personal = await ensurePolicyBundle(globalStorageDir, secrets, options);
  } catch (error) {
    personal = { state: failedClosed('identity-unavailable', error instanceof Error ? error.message.slice(0, 300) : 'The policy check threw.') };
  }
  const result = await recompose(globalStorageDir, secrets, personal, options.now === undefined ? {} : { now: options.now });
  return personal.event === undefined ? result : { ...result, event: personal.event };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The migration notice (D-26, D-27)

const MIGRATION_SHOWN = 5;

/**
 * The one-time notice for a v1 personal layer's local hosts read as endpoints, naming each host that lost a level (at most five, then how many more),
 * or undefined when none lost anything. A loopback entry (this computer) is never named.
 */
export function migrationNoticeText(changes: readonly MigrationChange[]): string | undefined {
  if (changes.length === 0) return undefined;
  const lead = 'Your policy\'s local servers are now listed with every other place AI may run, with the same effect as before';
  const named = changes.filter((change) => change.kind !== 'this-computer' && change.lost.length > 0);
  if (named.length === 0) return `${lead}.`;
  const shown = named.slice(0, MIGRATION_SHOWN).map((change) => `${change.host} no longer takes ${change.lost.map((key) => labelKeyShown(key)).join(', ')}`);
  const more = named.length > MIGRATION_SHOWN ? `, and ${String(named.length - MIGRATION_SHOWN)} more` : '';
  return `${lead}, except: ${shown.join('; ')}${more}. Those levels now need a pinned connection and an authorization from your organization.`;
}
