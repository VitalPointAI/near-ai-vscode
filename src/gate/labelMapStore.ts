// The project's label map on disk (CLAS-01, D-25, D-53, D-59): `.planning/.near-ai/labels.json`, signed with this install's device key through the one
// signer under the purpose `label-map`, and read back and checked with this install's key history. Node I/O only: this module never imports vscode, and
// SecretStorage is reached through the type-only SecretStorageLike interface. Nothing here waits on the network.
//
// The rules that matter most:
// - A map that does not verify (changed by hand, merged, or signed by a key this computer does not know) only ever RAISES a label. It is resolved over the
//   entries this computer last verified, so a hand edit can neither lower nor drop a verified label, and it is never signed again without the person's yes.
// - A map that exists but cannot be read (a merge conflict, a cut-off write) holds agent reads in the project until it reads again.
// - A map that was deleted, or replaced by an older signed copy, never reads as "no labels" (D-59): this extension's storage keeps a marker of the last map
//   this computer verified for each project (the envelope's hash, the revision, the signing time, the entry count and the verified entries). Missing with a
//   marker, an older revision, the same revision with another hash, or a newer map that drops a key without naming it in its signed `removed` list is
//   `rolled-back`, which holds agent reads too. A removal on purpose is a signed change that names the keys it drops and moves the marker.
// - Check, sign, write, read back and the marker update all happen inside one lock per project in this extension's storage, so two windows changing labels
//   at once take turns and neither loses the other's raise.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { MAX_LABEL_MAP_BYTES, PROJECT_ENTRY_KEY, labelMapKeys, labelMapRevision, nextRevision, parseLabelMap, resolveLabel, withRevision } from '../domain/gate/labelMap';
import type { LabelMapPayload, LabelMapState, LabelSource, LabelView, ResolvedLabel } from '../domain/gate/labelMap';
import { raiseMark } from '../domain/gate/dominance';
import type { Label, ScaleTable } from '../domain/gate/labels';
import { canonicalBytes } from '../domain/team/canonical';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { findSecrets } from '../domain/team/secrets';
import { MAX_PAYLOAD_BYTES, PayloadError, signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { identityDir, loadDeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { writeFileAtomic } from '../team/teamFile';
import { gateDir } from './bundleStore';
import { projectLogKey } from './decisionLog';

/** The one label file of a project, relative to its root (D-25). */
export const LABEL_MAP_FILE = '.planning/.near-ai/labels.json';
/** The lock's file name after the project's key, in `<globalStorage>/gate/locks`. */
export const LABEL_MAP_LOCK_FILE = 'labels.lock';
/** The folder of the last-verified markers in the gate folder, one file per project (D-59). Never the project. */
export const LABEL_MARKERS_DIR = 'label-markers';
const LOCKS_DIR = 'locks';
/** A file larger than this is not read at all; the verifier's own limit applies to what is signed, this one protects memory. */
const MAX_LABEL_FILE_BYTES = MAX_PAYLOAD_BYTES * 2;
const MARKER_VERSION = 1;

/** The sentence an unreadable map gives (D-53). */
export const LABEL_MAP_UNREADABLE_TEXT =
  "This project's label file .planning/.near-ai/labels.json cannot be read (for example, it has a merge conflict), so NEAR AI cannot tell which files are labelled. Fix the file, then run NEAR AI: Set Label to sign it again.";

/** The sentence a deleted or older map gives (D-59). */
export const LABEL_MAP_ROLLED_BACK_TEXT =
  "This project's label file .planning/.near-ai/labels.json is missing, or cannot be checked against the one this computer last checked, so labels may have been removed without a signature. Agents cannot read files in this project until you put the file back (for example with git restore) or run NEAR AI: Set Label, which offers to sign the labels this computer last checked again.";

/** The sentence of a signed label file that is not the one this computer last checked, such as another branch's (D-61). */
export const LABEL_MAP_OTHER_REVISION_TEXT =
  "This project's label file .planning/.near-ai/labels.json is signed, but it is an older or different copy than the one this computer last checked (for example after switching branches). Agents cannot read files in this project until you choose Use this branch's labels, or switch back.";

/** The button that accepts another branch's signed labels as current (D-61). */
export const USE_BRANCH_LABELS_ACTION = "Use this branch's labels";

/** The notice for a map that does not verify, told once per window (D-53). */
export const LABEL_MAP_UNVERIFIED_TEXT =
  "This project's label file .planning/.near-ai/labels.json is not signed by a key this computer knows (it was changed by hand, merged, or signed on another computer). NEAR AI uses it only where it makes a label stricter, never where it would lower one. Run NEAR AI: Set Label to sign it again with this computer's key.";

/** The question before an unverified map is signed again with this computer's key (D-53). */
export const LABEL_MAP_RESIGN_QUESTION = "Sign it again with this computer's key, keeping only the labels that raise?";

/** The question before the labels this computer last verified are signed again over a missing, older or unreadable file (D-59). */
export const LABEL_MAP_RESTORE_QUESTION = 'Sign the labels this computer last checked again?';

/** A change that wrote nothing, with a plain message. */
export class LabelMapError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LabelMapError';
  }
}

/**
 * The last map this computer verified for a project (D-59, D-62), kept in VS Code's SecretStorage under LABEL_MARKER_SECRET_PREFIX and the project's key,
 * the way the policy bundle's last-valid marker is, so deleting or replacing files on disk never erases it.
 */
export interface LabelMarker {
  readonly v: 1;
  /** Lowercase hex SHA-256 of the canonical envelope. */
  readonly hash: string;
  readonly revision: number;
  readonly signedAt: string;
  /** How many keys the map held, the project entry included. */
  readonly entries: number;
  /** Lowercase hex SHA-256 of the canonical verified payload: the base copy in the gate folder is used only when it hashes to this. */
  readonly payloadHash: string;
}

/** The SecretStorage key prefix of the label markers (D-62); the project's log key follows it, so no path is in the key. */
export const LABEL_MARKER_SECRET_PREFIX = 'nearAi.gate.labelMarker.';

/** The marker and, when its copy in the gate folder still matches, the verified payload. */
interface MarkerState {
  readonly marker?: LabelMarker;
  /** The verified payload, from the base copy, only when it hashes to the marker's payloadHash. */
  readonly base?: unknown;
}

/** What is on disk, before the scales are known. */
type RawMap =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'verified'; readonly payload: unknown; readonly hash: string; readonly signedAt: string }
  | { readonly kind: 'unverified'; readonly payload: unknown };

export function labelMapPath(root: string): string {
  return path.join(root, ...LABEL_MAP_FILE.split('/'));
}

export function labelMarkerPath(globalStorageDir: string, root: string): string {
  return path.join(gateDir(globalStorageDir), LABEL_MARKERS_DIR, `${projectLogKey(root)}.json`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(canonicalBytes(envelope)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The keys a payload holds, read without the scales (the marker's and a file's alike), the project entry as PROJECT_ENTRY_KEY. */
function rawKeys(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const entries = payload['entries'];
  return [...(isRecord(entries) ? Object.keys(entries) : []), ...(Object.prototype.hasOwnProperty.call(payload, 'project') ? [PROJECT_ENTRY_KEY] : [])];
}

function rawRevision(payload: unknown): number {
  const value = isRecord(payload) ? payload['revision'] : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function rawRemoved(payload: unknown): string[] {
  const value = isRecord(payload) ? payload['removed'] : undefined;
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
}

/** Reads and checks the file. Every cause the person can fix is its own kind; nothing is guessed and nothing is written. */
async function readRaw(root: string, status: KeyStatusLookup): Promise<RawMap> {
  const file = labelMapPath(root);
  let text: string;
  try {
    const size = (await stat(file)).size;
    if (size > MAX_LABEL_FILE_BYTES) return { kind: 'unreadable', detail: 'too large' };
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', detail: errorCode(error) ?? 'error' };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', detail: 'not JSON' };
  }
  if (!isRecord(envelope) || !isRecord(envelope['payload'])) return { kind: 'unreadable', detail: 'not a signed label map' };
  const verdict = verifyPayload(envelope, { purpose: 'label-map', status });
  if (verdict.ok) return { kind: 'verified', payload: verdict.payload, hash: envelopeHash(envelope), signedAt: verdict.signedAt };
  return { kind: 'unverified', payload: envelope['payload'] };
}

function payloadHashOf(payload: unknown): string {
  return createHash('sha256').update(canonicalBytes(payload)).digest('hex');
}

function markerSecretKey(root: string): string {
  return `${LABEL_MARKER_SECRET_PREFIX}${projectLogKey(root)}`;
}

function markerOf(value: unknown): LabelMarker | undefined {
  if (!isRecord(value) || value['v'] !== MARKER_VERSION || typeof value['hash'] !== 'string' || typeof value['revision'] !== 'number'
    || typeof value['signedAt'] !== 'string' || typeof value['entries'] !== 'number' || typeof value['payloadHash'] !== 'string') return undefined;
  return { v: MARKER_VERSION, hash: value['hash'], revision: value['revision'], signedAt: value['signedAt'], entries: value['entries'], payloadHash: value['payloadHash'] };
}

/** The base copy in the gate folder (the verified payload, with the marker fields beside it), or undefined. */
async function readBaseCopy(globalStorageDir: string, root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(labelMarkerPath(globalStorageDir, root), 'utf8'));
    return isRecord(value) && isRecord(value['payload']) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The marker from SecretStorage, and the verified payload when its base copy still matches (D-62). With no marker in SecretStorage, a base copy written by
 * an earlier build of 4b (which kept the marker in the gate folder) is moved into SecretStorage once. A secret store that cannot be read gives no marker for
 * a reader with no way to write one, and is retried at the next read.
 */
export async function readLabelMarker(globalStorageDir: string, secrets: SecretStorageLike, root: string): Promise<MarkerState> {
  let marker: LabelMarker | undefined;
  try {
    const text = await secrets.get(markerSecretKey(root));
    marker = text === undefined ? undefined : markerOf(JSON.parse(text));
  } catch {
    marker = undefined;
  }
  const copy = await readBaseCopy(globalStorageDir, root);
  if (marker === undefined && copy !== undefined) {
    // Migration: the marker of the storage folder becomes the SecretStorage marker.
    const legacy = markerOf({ ...copy, payloadHash: payloadHashOf(copy['payload']) });
    if (legacy !== undefined) {
      marker = legacy;
      await Promise.resolve(secrets.store(markerSecretKey(root), JSON.stringify(legacy))).catch(() => undefined);
    }
  }
  if (marker === undefined) return {};
  const base = copy !== undefined && payloadHashOf(copy['payload']) === marker.payloadHash ? copy['payload'] : undefined;
  return base === undefined ? { marker } : { marker, base };
}

/** Writes the base copy first, then the marker in SecretStorage, which is the one that counts. */
async function writeMarker(globalStorageDir: string, secrets: SecretStorageLike, root: string, marker: LabelMarker, payload: unknown): Promise<void> {
  const file = labelMarkerPath(globalStorageDir, root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify({ ...marker, payload })}\n`).catch(() => undefined);
  await secrets.store(markerSecretKey(root), JSON.stringify(marker));
}

function markerFor(raw: Extract<RawMap, { kind: 'verified' }>): LabelMarker {
  return { v: MARKER_VERSION, hash: raw.hash, revision: rawRevision(raw.payload), signedAt: raw.signedAt, entries: rawKeys(raw.payload).length, payloadHash: payloadHashOf(raw.payload) };
}

/** What the file and the marker together say (D-53, D-59). `adopt` is set when a verified map is newer than the marker (or there is none) and passes. */
interface Classified {
  readonly state: LabelMapState;
  /** The payload whose entries are trusted: the verified file, or the marker's entries under a file that does not verify. */
  readonly trusted?: unknown;
  /** The file's payload when it does not verify: it may only raise. */
  readonly untrusted?: unknown;
  /** A verified payload that is not the one the marker names (another branch's labels): used only if the person accepts it (D-61). */
  readonly candidate?: unknown;
  readonly adopt?: LabelMarker;
}

/**
 * The states (D-53, D-59, D-61, D-62): no file with a marker is `rolled-back` (deleted); a verified file this computer signed that is older than the marker,
 * another copy at the same revision, or a newer one that drops a key without a signed removal is `other-revision` (another branch's labels, say), which the
 * person can accept in one click; a file that does not verify is resolved raise-only over the marker's verified entries, and when those cannot be found
 * (their base copy was deleted or changed) it is `rolled-back` too, since a lowering could not be told apart.
 */
function classify(raw: RawMap, held: MarkerState): Classified {
  const marker = held.marker;
  switch (raw.kind) {
    case 'missing':
      return { state: marker === undefined ? 'none' : 'rolled-back' };
    case 'unreadable':
      return { state: 'unreadable' };
    case 'unverified':
      if (marker === undefined) return { state: 'unverified', untrusted: raw.payload };
      return held.base === undefined ? { state: 'rolled-back' } : { state: 'unverified', untrusted: raw.payload, trusted: held.base };
    case 'verified': {
      const fresh = markerFor(raw);
      if (marker === undefined) return { state: 'verified', trusted: raw.payload, adopt: fresh };
      if (fresh.revision < marker.revision) return { state: 'other-revision', candidate: raw.payload };
      if (fresh.revision === marker.revision) return fresh.hash === marker.hash ? { state: 'verified', trusted: raw.payload } : { state: 'other-revision', candidate: raw.payload };
      // Newer: every key the marker holds is still there, or this very revision names it as removed and follows the marker's directly. Without the base
      // copy the keys the marker held cannot be compared, so a newer map is accepted only when it holds at least as many keys.
      const kept = new Set(rawKeys(raw.payload));
      const named = new Set(rawRemoved(raw.payload));
      if (held.base === undefined) {
        if (kept.size < marker.entries && (fresh.revision !== marker.revision + 1 || kept.size + named.size < marker.entries)) return { state: 'other-revision', candidate: raw.payload };
      } else {
        const dropped = rawKeys(held.base).filter((key) => !kept.has(key));
        if (dropped.length > 0 && (fresh.revision !== marker.revision + 1 || dropped.some((key) => !named.has(key)))) return { state: 'other-revision', candidate: raw.payload };
      }
      return { state: 'verified', trusted: raw.payload, adopt: fresh };
    }
  }
}

const EMPTY_MAP: LabelMapPayload = Object.freeze({ labelMapVersion: 1, vocabulary: 1, entries: Object.freeze({}) });

function parsedOrUndefined(payload: unknown, scales: ScaleTable): LabelMapPayload | undefined {
  if (payload === undefined) return undefined;
  const parsed = parseLabelMap(payload, scales);
  return parsed.ok ? parsed.value : undefined;
}

function problemOf(state: LabelMapState): string | undefined {
  if (state === 'unreadable') return LABEL_MAP_UNREADABLE_TEXT;
  if (state === 'rolled-back') return LABEL_MAP_ROLLED_BACK_TEXT;
  if (state === 'other-revision') return LABEL_MAP_OTHER_REVISION_TEXT;
  if (state === 'unverified') return LABEL_MAP_UNVERIFIED_TEXT;
  return undefined;
}

/** The view of a classified map under the given scales. A file payload the scales cannot read is unreadable: never a guess. */
function viewOf(classified: Classified, scales: ScaleTable, missing: readonly string[]): LabelView {
  let state = classified.state;
  const trusted = parsedOrUndefined(classified.trusted, scales);
  const untrusted = parsedOrUndefined(classified.untrusted, scales);
  if ((state === 'verified' && trusted === undefined) || (state === 'unverified' && untrusted === undefined)) state = 'unreadable';
  const problem = problemOf(state);
  return Object.freeze({
    state,
    ...(problem === undefined ? {} : { problem }),
    missing,
    keys: (): readonly string[] => [...new Set([...Object.keys(trusted?.entries ?? {}), ...Object.keys(state === 'unverified' ? untrusted?.entries ?? {} : {})])],
    resolve: (relativePath: string, defaultLabel: Label): ResolvedLabel => resolveLabel(relativePath, {
      ...(trusted === undefined ? {} : { verified: trusted }),
      ...(state === 'unverified' && untrusted !== undefined ? { unverified: untrusted } : {}),
      bundleDefault: defaultLabel,
      scales
    })
  });
}

export interface LabelMapOptions {
  /** This extension's storage folder, where the marker and the lock live. None for a reader with no host: it trusts no key and keeps no marker. */
  readonly globalStorageDir?: string;
  readonly secrets?: SecretStorageLike;
}

async function statusOf(options: LabelMapOptions): Promise<KeyStatusLookup> {
  if (options.globalStorageDir === undefined || options.secrets === undefined) return NO_KNOWN_KEYS;
  try {
    return await localKeyStatus(identityDir(options.globalStorageDir), options.secrets);
  } catch {
    return NO_KNOWN_KEYS;
  }
}

/** The keys of the map whose path no longer exists in the project, sorted, so they can be reported once and never dropped silently. */
async function missingKeys(root: string, payload: unknown): Promise<string[]> {
  const keys = rawKeys(payload).filter((key) => key !== PROJECT_ENTRY_KEY).slice(0, 5000);
  const gone: string[] = [];
  for (const key of keys) {
    try {
      await stat(path.join(root, ...key.replace(/\/$/, '').split('/')));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') gone.push(key);
    }
  }
  return gone.sort();
}

/**
 * Reads the project's map and its marker and says what they hold, under the given scales. Adopts a verified map newer than the marker (or with none) by
 * writing its marker, best effort. Never throws.
 */
export async function readLabelMap(root: string, scales: ScaleTable, options: LabelMapOptions = {}): Promise<LabelView> {
  const held = await markerStateOf(options, root);
  const raw = await readRaw(root, await statusOf(options));
  const classified = classify(raw, held);
  if (classified.adopt !== undefined && raw.kind === 'verified') await adoptMarker(options, root, classified.adopt, raw.payload).catch(() => undefined);
  return viewOf(classified, scales, await missingKeys(root, classified.trusted ?? classified.untrusted).catch(() => []));
}

async function markerStateOf(options: LabelMapOptions, root: string): Promise<MarkerState> {
  if (options.globalStorageDir === undefined || options.secrets === undefined) return {};
  return readLabelMarker(options.globalStorageDir, options.secrets, root);
}

/** Writes a newer marker under the project's lock, only if the marker is still older (another window may have written a newer one meanwhile). */
async function adoptMarker(options: LabelMapOptions, root: string, marker: LabelMarker, payload: unknown): Promise<void> {
  const { globalStorageDir, secrets } = options;
  if (globalStorageDir === undefined || secrets === undefined) return;
  await withLabelLock(globalStorageDir, root, async () => {
    const now = (await readLabelMarker(globalStorageDir, secrets, root)).marker;
    if (now === undefined || now.revision < marker.revision) await writeMarker(globalStorageDir, secrets, root, marker, payload);
  });
}

async function withLabelLock<T>(globalStorageDir: string, root: string, work: () => Promise<T>): Promise<T> {
  const locks = path.join(gateDir(globalStorageDir), LOCKS_DIR);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  return withFileLock(locks, `${projectLogKey(root)}-${LABEL_MAP_LOCK_FILE}`, work);
}

/**
 * A map holding the trusted entries plus, from an untrusted map, only what the raise-only rule applies (D-53): an entry it would lower or drop is never
 * kept. An untrusted entry on another scale than the trusted label for that key cannot be held by one entry, so the trusted label stays.
 */
export function raisingOnly(trusted: LabelMapPayload, untrusted: LabelMapPayload, scales: ScaleTable, defaultLabel: Label): LabelMapPayload {
  let out: LabelMapPayload = trusted;
  const entries: Record<string, Label> = { ...trusted.entries };
  // Own data properties only, so an entry named __proto__ is an entry like any other (T-70-01).
  const put = (key: string, label: Label): void => { Object.defineProperty(entries, key, { value: label, enumerable: true, writable: true, configurable: true }); };
  const keep = (key: string, given: Label): Label | undefined => {
    const before = resolveLabel(key === PROJECT_ENTRY_KEY ? '' : key, { verified: trusted, bundleDefault: defaultLabel, scales }).mark;
    const raised = raiseMark(before, given, scales);
    if (raised.length === 1 && raised[0] !== undefined && JSON.stringify(raised) !== JSON.stringify(before)) return raised[0];
    return undefined;
  };
  for (const key of Object.keys(untrusted.entries)) {
    const label = keep(key, untrusted.entries[key] as Label);
    if (label !== undefined) put(key, label);
  }
  const project = untrusted.project === undefined ? undefined : keep(PROJECT_ENTRY_KEY, untrusted.project);
  const rebuilt = parseLabelMap({ labelMapVersion: 1, vocabulary: 1, entries, ...((project ?? trusted.project) === undefined ? {} : { project: project ?? trusted.project }) }, scales);
  if (rebuilt.ok) out = rebuilt.value;
  return out;
}

export interface UpdateLabelMapOptions {
  readonly globalStorageDir: string;
  readonly secrets: SecretStorageLike;
  readonly scales: ScaleTable;
  /** The policy's default label, for the raise-only rule. */
  readonly defaultLabel: Label;
  /**
   * Asked before a map that does not verify is signed again with this computer's key, or before the labels this computer last verified are signed again
   * over a missing, older or unreadable file. Absent (an automatic write that cannot ask): nothing is written and a LabelMapError says why.
   */
  readonly confirm?: (question: LabelMapQuestion) => Promise<boolean>;
  readonly now?: () => Date;
}

/**
 * What a change may have to ask first: `resign` an unverified file keeping only its raises (D-53), `restore` the labels this computer last checked over a
 * missing or unreadable file (D-59), or `accept` another signed copy (another branch's labels) as current (D-61).
 */
export type LabelMapQuestion = 'resign' | 'restore' | 'accept';

export interface LabelMapWrite {
  readonly payload: LabelMapPayload;
  readonly before: LabelMapPayload;
  readonly hash: string;
  readonly revision: number;
}

/** The first key of the map that the signer would refuse as secret-like, named so the person can rename it (Pitfall 9). */
function secretLikeKey(map: LabelMapPayload): string | undefined {
  return labelMapKeys(map).find((key) => findSecrets({ [key]: true }).length > 0 || findSecrets(key).length > 0);
}

/**
 * Changes the project's map under its lock: reads and checks it, applies `change` to what may be trusted, signs the result with this install's key at the
 * next revision (naming every key it dropped), writes it through a temporary file and a rename, reads it back, and moves the marker. Throws LabelMapError with
 * a plain message, having written nothing, when the change cannot be made.
 */
export async function updateLabelMap(root: string, change: (map: LabelMapPayload) => LabelMapPayload, options: UpdateLabelMapOptions): Promise<LabelMapWrite> {
  return withLabelLock(options.globalStorageDir, root, async () => {
    const identity = await loadDeviceIdentity(options.secrets).catch(() => undefined);
    if (identity === undefined) throw new LabelMapError('Nothing was written: NEAR AI has no signing key on this computer yet. Open the policy with NEAR AI: Show Policy and try again.');
    const status = await statusOf(options);
    const held = await readLabelMarker(options.globalStorageDir, options.secrets, root);
    const raw = await readRaw(root, status);
    const classified = classify(raw, held);
    const basePayload = parsedOrUndefined(held.base, options.scales);
    const ask = async (question: LabelMapQuestion, refusal: string): Promise<void> => {
      if (options.confirm === undefined) throw new LabelMapError(`Nothing was written. ${refusal}`);
      if (!await options.confirm(question)) throw new LabelMapError(question === 'accept' ? "Nothing was written: this branch's labels were not accepted." : question === 'resign' ? 'Nothing was written: the label file was not signed again.' : 'Nothing was written: the labels this computer last checked were not signed again.');
    };
    let previous: LabelMapPayload | undefined;
    let base: LabelMapPayload;
    switch (classified.state) {
      case 'none':
        previous = undefined;
        base = EMPTY_MAP;
        break;
      case 'verified': {
        const parsed = parsedOrUndefined(classified.trusted, options.scales);
        if (parsed === undefined) throw new LabelMapError(`Nothing was written. ${LABEL_MAP_UNREADABLE_TEXT}`);
        previous = parsed;
        base = parsed;
        break;
      }
      case 'unverified': {
        const untrusted = parsedOrUndefined(classified.untrusted, options.scales);
        if (untrusted === undefined) throw new LabelMapError(`Nothing was written. ${LABEL_MAP_UNREADABLE_TEXT}`);
        await ask('resign', `The label file is not signed by this computer, and it is never signed again without you. ${LABEL_MAP_UNVERIFIED_TEXT}`);
        previous = basePayload;
        base = raisingOnly(basePayload ?? EMPTY_MAP, untrusted, options.scales, options.defaultLabel);
        break;
      }
      case 'other-revision': {
        const candidate = parsedOrUndefined(classified.candidate, options.scales);
        if (candidate === undefined) throw new LabelMapError(`Nothing was written. ${LABEL_MAP_UNREADABLE_TEXT}`);
        await ask('accept', LABEL_MAP_OTHER_REVISION_TEXT);
        previous = basePayload ?? candidate;
        base = candidate;
        break;
      }
      case 'rolled-back':
      case 'unreadable': {
        if (basePayload === undefined) {
          throw new LabelMapError('Nothing was written: the labels this computer last checked cannot be found to sign again. Put .planning/.near-ai/labels.json back from git (for example with git restore), then try again.');
        }
        await ask('restore', classified.state === 'rolled-back' ? LABEL_MAP_ROLLED_BACK_TEXT : LABEL_MAP_UNREADABLE_TEXT);
        previous = basePayload;
        base = basePayload;
        break;
      }
    }
    let changed: LabelMapPayload;
    try {
      changed = nextRevision(previous, change(base));
    } catch (error) {
      if (error instanceof RangeError) throw new LabelMapError(`Nothing was written: ${error.message} Change fewer labels at once.`, { cause: error });
      throw error;
    }
    // The revision always passes the marker's, and every key the last verified map holds that the new map does not is named, so a write never reads back
    // as older than, or as an unsigned removal from, what this computer verified. A verified file newer than the marker (adopted now) is the base the next
    // revision follows.
    const lastRevision = classified.adopt?.revision ?? held.marker?.revision;
    const lastPayload = classified.adopt === undefined ? held.base : classified.trusted;
    let versioned = changed;
    if (lastRevision !== undefined) {
      const kept = new Set(labelMapKeys(changed));
      const dropped = rawKeys(lastPayload).filter((key) => !kept.has(key));
      if (labelMapRevision(changed) !== lastRevision + 1 || dropped.some((key) => !(changed.removed ?? []).includes(key))) {
        try {
          versioned = withRevision(changed, Math.max(labelMapRevision(changed), lastRevision + 1), [...(changed.removed ?? []), ...dropped]);
        } catch (error) {
          if (error instanceof RangeError) throw new LabelMapError(`Nothing was written: ${error.message} Change fewer labels at once.`, { cause: error });
          throw error;
        }
      }
    }
    // The writer never writes a map the parser would refuse, so Set Label can always read back, and so repair, what it wrote (PR #85 review).
    if (!parseLabelMap(JSON.parse(JSON.stringify(versioned)), options.scales).ok) {
      throw new LabelMapError('Nothing was written: the change would give a label file this version cannot read back.');
    }
    const size = Buffer.byteLength(JSON.stringify(versioned), 'utf8');
    if (size > MAX_LABEL_MAP_BYTES) throw new LabelMapError(`Nothing was written: the label file would be ${String(size)} bytes, over the ${String(MAX_LABEL_MAP_BYTES)} byte limit. Label a folder instead of each file in it.`);
    const secretLike = secretLikeKey(versioned);
    if (secretLike !== undefined) throw new LabelMapError(`Nothing was written: the path "${secretLike.slice(0, 120)}" looks like it holds a secret, so it cannot be kept in the label file, which travels with the project. Rename it, or label its folder.`);
    let envelope: SignedPayload<LabelMapPayload>;
    try {
      envelope = signPayload(identity, 'label-map', versioned, options.now === undefined ? {} : { now: options.now });
    } catch (error) {
      if (error instanceof PayloadError) throw new LabelMapError(error.message, { cause: error });
      throw error;
    }
    const file = labelMapPath(root);
    const before = await readFile(file, 'utf8').catch(() => undefined);
    try {
      await writeFileAtomic(file, `${JSON.stringify(envelope, null, 2)}\n`);
    } catch (error) {
      throw new LabelMapError('Nothing was written: the label file could not be saved in the project.', { cause: error });
    }
    const after = await readRaw(root, status);
    const hash = envelopeHash(envelope);
    if (after.kind !== 'verified' || after.hash !== hash) {
      if (before !== undefined) await writeFileAtomic(file, before).catch(() => undefined);
      throw new LabelMapError('The label file was saved but did not read back as written, so the old one was put back.');
    }
    await writeMarker(options.globalStorageDir, options.secrets, root, markerFor(after), after.payload).catch(() => undefined);
    return { payload: versioned, before: previous ?? EMPTY_MAP, hash, revision: labelMapRevision(versioned) };
  });
}

/**
 * The labels this computer last verified for a project (the marker's base copy, D-59, D-62), or undefined when there is none or it no longer matches the
 * marker. Set Label judges a lowering against them while the file in the project holds reads, since a write then restores them (PR #85 review).
 */
export async function lastVerifiedLabelMap(globalStorageDir: string, secrets: SecretStorageLike, root: string, scales: ScaleTable): Promise<LabelMapPayload | undefined> {
  return parsedOrUndefined((await readLabelMarker(globalStorageDir, secrets, root)).base, scales);
}

/**
 * The label reader of one project (D-25): reads the file and the marker again only when either one's size or modification time changes, and gives a view
 * under the scales asked for. A reader with no storage folder (a run with no gate host) trusts no key and keeps no marker, so every label it finds only raises.
 */
export class LabelReader implements LabelSource {
  private cached: { readonly signature: string; readonly classified: Classified; readonly missing: readonly string[] } | undefined;
  private told = new Set<string>();

  public constructor(private readonly root: string, private readonly options: LabelMapOptions & {
    /** Told once per window for each state that needs the person (unverified, unreadable, rolled-back) and for paths that are gone. */
    readonly onNotice?: (message: string, state?: LabelMapState) => void;
    /** Moves an entry after a rename the extension saw (an agent's mv). Set by the host, which can sign. */
    readonly move?: (from: string, to: string) => Promise<void>;
  } = {}) {}

  public async view(scales: ScaleTable): Promise<LabelView> {
    const signature = await this.signature();
    if (this.cached === undefined || this.cached.signature !== signature) {
      const held = await markerStateOf(this.options, this.root);
      const raw = await readRaw(this.root, await statusOf(this.options));
      const classified = classify(raw, held);
      if (classified.adopt !== undefined && raw.kind === 'verified') await adoptMarker(this.options, this.root, classified.adopt, raw.payload).catch(() => undefined);
      const missing = await missingKeys(this.root, classified.trusted ?? classified.untrusted).catch(() => []);
      // The signature is taken again after an adoption wrote the marker, so the next view does not read it all again.
      this.cached = { signature: await this.signature(), classified, missing };
    }
    const view = viewOf(this.cached.classified, scales, this.cached.missing);
    this.notice(view);
    return view;
  }

  public async followMove(from: string, to: string): Promise<void> {
    await this.options.move?.(from, to);
  }

  /** Forgets what it read, so the next view reads the file again (after this extension wrote it). */
  public invalidate(): void {
    this.cached = undefined;
  }

  private notice(view: LabelView): void {
    const tell = (key: string, message: string, state?: LabelMapState): void => {
      if (this.told.has(key)) return;
      this.told.add(key);
      try { this.options.onNotice?.(message, state); } catch { /* a notice never changes a decision */ }
    };
    // Once the file is fine again, a later problem is told again (another branch switch, say).
    if (view.state === 'verified' || view.state === 'none') for (const state of ['unverified', 'unreadable', 'rolled-back', 'other-revision']) this.told.delete(state);
    if (view.problem !== undefined) tell(view.state, view.problem, view.state);
    if (view.missing.length > 0) {
      const shown = view.missing.slice(0, 5).join(', ');
      tell(`missing:${view.missing.join('\n')}`, `Some labelled paths in .planning/.near-ai/labels.json no longer exist: ${shown}${view.missing.length > 5 ? ` and ${String(view.missing.length - 5)} more` : ''}. Their labels are kept. Run NEAR AI: Set Label on the new path, or remove the old one there.`);
    }
  }

  private async signature(): Promise<string> {
    const one = async (file: string): Promise<string> => {
      try {
        const found = await stat(file);
        return `${String(found.size)}:${String(found.mtimeMs)}:${String(found.ino)}`;
      } catch (error) {
        return errorCode(error) ?? 'gone';
      }
    };
    const marker = this.options.globalStorageDir === undefined ? 'none' : await one(labelMarkerPath(this.options.globalStorageDir, this.root));
    return `${await one(labelMapPath(this.root))}|${marker}`;
  }
}

/** Readers of projects run with no gate host, one per folder: they trust no key, so every label they find only raises (fail closed). */
const HOSTLESS_READERS = new Map<string, LabelReader>();
const MAX_HOSTLESS_READERS = 16;

export function hostlessLabelReader(root: string): LabelReader {
  const key = path.resolve(root);
  let reader = HOSTLESS_READERS.get(key);
  if (reader === undefined) {
    reader = new LabelReader(key);
    HOSTLESS_READERS.set(key, reader);
    for (const old of [...HOSTLESS_READERS.keys()].slice(0, Math.max(0, HOSTLESS_READERS.size - MAX_HOSTLESS_READERS))) HOSTLESS_READERS.delete(old);
  }
  return reader;
}
