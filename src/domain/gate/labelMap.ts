// Label map v1 (CLAS-01, D-25): the one file per project, `.planning/.near-ai/labels.json`, that says which label a file, a folder or the project carries.
// It is committed with the project so labels travel with it, and it is signed through Phase 69's one signer under the purpose `label-map`.
// Pure: no I/O, no clock, no vscode, no package. Reading and writing the file is a later plan; this file holds the format, the key rule and the resolution.
//
// Resolution order: the file's own entry, then the nearest labelled ancestor folder, then the project entry, then the bundle's default label.
// A label only ever restricts, so a map that does not verify (tampered, or signed by a device this one does not know) is applied only where it RAISES the
// label the verified sources give, never where it would lower one, and the result says so (`raisedByUnverified`) so the person can be told.
import { normalizeRelative } from '../protectedPaths';
import { raiseMark } from './dominance';
import type { Mark } from './dominance';
import { parseLabel } from './labels';
import type { Label, ScaleTable } from './labels';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';

export const LABEL_MAP_VERSION = 1;

/** The label map's own vocabulary version: the version of the label format its entries use (labels v1). */
const LABEL_MAP_VOCABULARY = 1;

/** The size a writer refuses to go above: the signed envelope must stay under MAX_PAYLOAD_BYTES (256 KiB) once the signature and the wrapper are added. */
export const MAX_LABEL_MAP_BYTES = 200 * 1024;

const MAX_KEY_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

export interface LabelMapPayload {
  readonly labelMapVersion: 1;
  readonly vocabulary: 1;
  /** The label of the project as a whole; absent means the bundle's default applies below the folders. */
  readonly project?: Label;
  /** Keyed by normalised project-relative path; a folder's key ends with `/`. */
  readonly entries: Readonly<Record<string, Label>>;
  /**
   * The map's revision (D-59): a whole number every signed write raises by one, so an older signed copy put back is told apart from the newest. Absent
   * means 0. Inside the signed bytes like everything else.
   */
  readonly revision?: number;
  /**
   * The keys this revision dropped from the one before it (D-59): a removal or a rename is a signed change that names what it took away, so a map that
   * drops a key without naming it is held as rolled back. The project entry is PROJECT_ENTRY_KEY. Absent means none.
   */
  readonly removed?: readonly string[];
}

/** The key that names the project entry in `removed` and in an entry count. No path key can be it, because a path key never starts with `(`. */
export const PROJECT_ENTRY_KEY = '(project)';

/** The most keys one revision may name as removed; a larger removal is split by the writer into several revisions. */
export const MAX_REMOVED_KEYS = 5000;

/** Where a resolved label came from. */
export type LabelOrigin = 'file' | 'folder' | 'project' | 'default';

export interface ResolvedLabel {
  readonly mark: Mark;
  /** Where the verified sources took the label from. */
  readonly origin: LabelOrigin;
  /** True when a map that did not verify raised the label above what the verified sources gave. */
  readonly raisedByUnverified: boolean;
}

/**
 * The key an entry is stored under: the path normalised with `normalizeRelative`, with a trailing `/` for a folder. Refused: an empty path, a `..`
 * segment, a leading `/`, a backslash, a drive prefix, a control character, and anything over 512 characters.
 */
export function labelMapKey(path: string, isFolder: boolean): Parsed<string> {
  if (typeof path !== 'string' || path === '') return refused('wrong-type', '');
  if (path.length > MAX_KEY_LENGTH) return refused('not-allowed-here', '');
  if (path.startsWith('/') || path.includes('\\') || DRIVE_PREFIX.test(path) || CONTROL_CHARACTERS.test(path)) return refused('not-allowed-here', '');
  if (path.split('/').includes('..')) return refused('not-allowed-here', '');
  const normalised = normalizeRelative(path);
  if (normalised === '') return refused('wrong-type', '');
  const key = isFolder ? `${normalised}/` : normalised;
  return key.length > MAX_KEY_LENGTH ? refused('not-allowed-here', '') : { ok: true, value: key };
}

/** A stored key is valid only in its own canonical form, so one entry has one spelling. */
function canonicalKey(key: string): Parsed<string> {
  const keyed = labelMapKey(key, key.endsWith('/'));
  return keyed.ok && keyed.value === key ? keyed : refused(keyed.ok ? 'not-allowed-here' : keyed.reason, '');
}

/** A property defined as an own data property, so a path named `__proto__` is an entry like any other and never changes a prototype. */
function entriesOf(pairs: ReadonlyArray<readonly [string, Label]>): Readonly<Record<string, Label>> {
  return Object.freeze(Object.fromEntries(pairs) as Record<string, Label>);
}

/** Parses a label map payload. Unknown fields, a key that is not canonical, and a label that does not parse against the scales are each refused. */
export function parseLabelMap(value: unknown, scales: ScaleTable, path = ''): Parsed<LabelMapPayload> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['labelMapVersion', 'vocabulary', 'entries'], ['project', 'revision', 'removed']);
  if (keys !== undefined) return keys;
  for (const [field, expected] of [['labelMapVersion', LABEL_MAP_VERSION], ['vocabulary', LABEL_MAP_VOCABULARY]] as const) {
    const found = ownValue(value, field);
    if (typeof found !== 'number' || !Number.isSafeInteger(found)) return refused('wrong-type', childPath(path, field));
    if (found !== expected) return refused('unknown-version', childPath(path, field));
  }
  let project: Label | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'project')) {
    const parsed = parseLabel(ownValue(value, 'project'), scales, childPath(path, 'project'));
    if (!parsed.ok) return parsed;
    project = parsed.value;
  }
  const raw = ownValue(value, 'entries');
  if (!isRecord(raw)) return refused('wrong-type', childPath(path, 'entries'));
  const pairs: Array<readonly [string, Label]> = [];
  for (const key of Object.keys(raw)) {
    const where = childPath(childPath(path, 'entries'), key.slice(0, 40));
    const checked = canonicalKey(key);
    if (!checked.ok) return refused(checked.reason, where);
    const label = parseLabel(ownValue(raw, key), scales, where);
    if (!label.ok) return label;
    pairs.push([key, label.value]);
  }
  let revision: number | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'revision')) {
    const found = ownValue(value, 'revision');
    if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) return refused('wrong-type', childPath(path, 'revision'));
    revision = found;
  }
  let removed: readonly string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'removed')) {
    const found = ownValue(value, 'removed');
    if (!Array.isArray(found) || found.length > MAX_REMOVED_KEYS) return refused('wrong-type', childPath(path, 'removed'));
    const keysRemoved: string[] = [];
    for (const [index, key] of found.entries()) {
      if (typeof key !== 'string' || (key !== PROJECT_ENTRY_KEY && !canonicalKey(key).ok)) return refused('wrong-type', `${childPath(path, 'removed')}[${String(index)}]`);
      keysRemoved.push(key);
    }
    removed = Object.freeze(keysRemoved);
  }
  return { ok: true, value: build(project, pairs, revision, removed) };
}

/** The map's revision: 0 when it carries none. */
export function labelMapRevision(map: LabelMapPayload): number {
  return map.revision ?? 0;
}

/** Every key the map holds, the project entry as PROJECT_ENTRY_KEY, sorted: what an entry count and a removal check compare. */
export function labelMapKeys(map: LabelMapPayload): readonly string[] {
  return Object.freeze([...Object.keys(map.entries), ...(map.project === undefined ? [] : [PROJECT_ENTRY_KEY])].sort());
}

/**
 * The next signed revision after `previous`: `next` with its revision one above the previous one and `removed` naming every key of `previous` it no longer
 * holds (D-59). Only a writer calls this; a reader never trusts a revision it did not verify.
 */
export function nextRevision(previous: LabelMapPayload | undefined, next: LabelMapPayload): LabelMapPayload {
  const kept = new Set(labelMapKeys(next));
  const dropped = previous === undefined ? [] : labelMapKeys(previous).filter((key) => !kept.has(key));
  return withRevision(next, (previous === undefined ? 0 : labelMapRevision(previous)) + 1, dropped);
}

/** `map` at the given revision, naming `removed` (none when empty). */
export function withRevision(map: LabelMapPayload, revision: number, removed: readonly string[]): LabelMapPayload {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('A revision is a whole number from 0.');
  const named = [...new Set(removed)].sort();
  // The parser refuses a longer list, so a map is never written that cannot be read back (PR #85 review). A map under MAX_LABEL_MAP_BYTES holds far fewer
  // entries than this, so one write never needs more.
  if (named.length > MAX_REMOVED_KEYS) throw new RangeError(`A revision may name at most ${String(MAX_REMOVED_KEYS)} removed labels.`);
  return build(map.project, pairsOf(map), revision, named.length === 0 ? undefined : named);
}

/** The keys that could hold a label for this path, nearest first: the file's own key, then each ancestor folder up to the top. */
function chainKeys(path: string): { readonly own: string; readonly folders: readonly string[] } | undefined {
  const own = labelMapKey(path, path.endsWith('/'));
  if (!own.ok) return undefined;
  const parts = own.value.replace(/\/$/, '').split('/');
  const folders: string[] = [];
  for (let end = parts.length - 1; end >= 1; end -= 1) folders.push(`${parts.slice(0, end).join('/')}/`);
  return { own: own.value, folders };
}

function lookup(map: LabelMapPayload | undefined, path: string): { readonly label: Label; readonly origin: LabelOrigin } | undefined {
  if (map === undefined) return undefined;
  const chain = chainKeys(path);
  if (chain !== undefined) {
    const own = ownValue(map.entries, chain.own);
    if (own !== undefined) return { label: own as Label, origin: chain.own.endsWith('/') ? 'folder' : 'file' };
    for (const folder of chain.folders) {
      const found = ownValue(map.entries, folder);
      if (found !== undefined) return { label: found as Label, origin: 'folder' };
    }
  }
  return map.project === undefined ? undefined : { label: map.project, origin: 'project' };
}

function sameMark(a: Mark, b: Mark): boolean {
  const flat = (mark: Mark): string => JSON.stringify(mark.map((label) => [label.scale, label.level, label.compartments, label.releasability, label.handling]));
  return flat(a) === flat(b);
}

export interface ResolveSources {
  /** A map whose signature verified. */
  readonly verified?: LabelMapPayload;
  /** A map that did not verify. It can raise a label and never lower one. */
  readonly unverified?: LabelMapPayload;
  /** The label of last resort, from the signed policy bundle. */
  readonly bundleDefault: Label;
  /** The scales the labels are joined on. */
  readonly scales: ScaleTable;
}

/**
 * The label of a project-relative path (a path ending in `/` is a folder): the verified map's own entry, then its nearest labelled ancestor folder,
 * then its project entry, then the bundle default. A map that did not verify then goes through `raiseMark` only, so it can raise the result and never
 * lower it, and `raisedByUnverified` says when it did. `origin` always names where the VERIFIED sources took the label from. A path that cannot be
 * keyed (it climbs out of the project, for example) has no file or folder entry and takes the project entry or the default.
 */
export function resolveLabel(path: string, sources: ResolveSources): ResolvedLabel {
  const verified = lookup(sources.verified, path);
  const base: Mark = Object.freeze([verified === undefined ? sources.bundleDefault : verified.label]);
  const origin: LabelOrigin = verified === undefined ? 'default' : verified.origin;
  const unverified = lookup(sources.unverified, path);
  if (unverified === undefined) return { mark: base, origin, raisedByUnverified: false };
  const raised = raiseMark(base, unverified.label, sources.scales);
  return sameMark(base, raised) ? { mark: base, origin, raisedByUnverified: false } : { mark: raised, origin, raisedByUnverified: true };
}

function assertKey(key: string): void {
  if (!canonicalKey(key).ok) throw new RangeError('That path cannot be used as a label map key.');
}

/** A frozen map. `revision` and `removed` are kept only when given, so a map written before D-59 keeps its exact bytes. */
function build(project: Label | undefined, pairs: ReadonlyArray<readonly [string, Label]>, revision?: number, removed?: readonly string[]): LabelMapPayload {
  return Object.freeze({
    labelMapVersion: LABEL_MAP_VERSION,
    vocabulary: LABEL_MAP_VOCABULARY,
    ...(project === undefined ? {} : { project }),
    entries: entriesOf(pairs),
    ...(revision === undefined ? {} : { revision }),
    ...(removed === undefined ? {} : { removed: Object.freeze([...removed]) })
  });
}

function pairsOf(map: LabelMapPayload): Array<readonly [string, Label]> {
  return Object.keys(map.entries).map((key) => [key, ownValue(map.entries, key) as Label] as const);
}

/** A new map with the entry for `key` set, or removed when `label` is undefined. The key must come from `labelMapKey`; any other key throws. */
export function setLabelEntry(map: LabelMapPayload, key: string, label: Label | undefined): LabelMapPayload {
  assertKey(key);
  const kept = pairsOf(map).filter(([existing]) => existing !== key);
  return build(map.project, label === undefined ? kept : [...kept, [key, label]]);
}

/** A new map with the project entry set, or removed when `label` is undefined. */
export function setProjectLabel(map: LabelMapPayload, label: Label | undefined): LabelMapPayload {
  return build(label, pairsOf(map));
}

/**
 * A new map after a rename: the entry at `from` moves to `to`, and when both are folders every entry below `from` moves below `to` as well. An entry
 * already at a destination key is replaced, as the renamed file replaced what was there. A file key cannot move to a folder key or the other way round.
 */
export function moveLabelEntry(map: LabelMapPayload, from: string, to: string): LabelMapPayload {
  assertKey(from);
  assertKey(to);
  if (from.endsWith('/') !== to.endsWith('/')) throw new RangeError('A file entry cannot move to a folder entry.');
  const folder = from.endsWith('/');
  const moves = (key: string): boolean => (folder ? key.startsWith(from) : key === from);
  const moved: Array<readonly [string, Label]> = [];
  const kept: Array<readonly [string, Label]> = [];
  for (const [key, label] of pairsOf(map)) {
    if (moves(key)) moved.push([`${to}${folder ? key.slice(from.length) : ''}`, label]);
    else kept.push([key, label]);
  }
  for (const [key] of moved) assertKey(key);
  const destinations = new Set(moved.map(([key]) => key));
  return build(map.project, [...kept.filter(([key]) => !destinations.has(key)), ...moved]);
}

/** The keys of entries whose path `exists` says is gone (a folder key keeps its trailing `/`), in sorted order, so a person can be asked what to do. */
export function missingLabelPaths(map: LabelMapPayload, exists: (key: string) => boolean): readonly string[] {
  return Object.freeze(Object.keys(map.entries).filter((key) => !exists(key)).sort());
}

/**
 * What a project's label map says, as a reader on disk found it (D-25, D-53, D-59): `none` (no map and nothing verified before), `verified`, `unverified`
 * (it only raises, over what this computer last verified), `unreadable`, `rolled-back` (deleted, or not checkable against what this computer last verified)
 * and `other-revision` (signed, but older than or different from what this computer last verified, such as another branch's, which the person can accept,
 * D-61). The last three hold agent reads in the project.
 */
export const LABEL_MAP_STATES = Object.freeze(['none', 'verified', 'unverified', 'unreadable', 'rolled-back', 'other-revision'] as const);
export type LabelMapState = (typeof LABEL_MAP_STATES)[number];

/** The states that hold every agent read in the project until a person acts: one list, so no reader can forget one (D-53, D-59, D-61). */
export const READ_HOLDING_STATES: ReadonlySet<LabelMapState> = new Set<LabelMapState>(['unreadable', 'rolled-back', 'other-revision']);

/** Whether a label file in this state holds agent reads. */
export function holdsReads(state: LabelMapState): boolean {
  return READ_HOLDING_STATES.has(state);
}

/** A map read under one set of scales: its state, the sentence the person needs when there is one, the labelled paths that are gone, and the resolution. */
export interface LabelView {
  readonly state: LabelMapState;
  readonly problem?: string;
  readonly missing: readonly string[];
  /** The label of a project-relative path (a folder ends with `/`, the project is the empty path), the bundle's default label last. */
  resolve(relativePath: string, defaultLabel: Label): ResolvedLabel;
  /** Every labelled path the map holds (trusted and untrusted alike), so a pattern can be checked against each entry it could match. */
  keys(): readonly string[];
}

/** Where a runtime reads a project's labels. The host gives one per project; it is read again only when the file changes. */
export interface LabelSource {
  view(scales: ScaleTable): Promise<LabelView>;
  /** Moves the entry of a path an agent's command renamed (D-26), signed by the host; absent where nothing can sign. */
  followMove?(from: string, to: string): Promise<void>;
}
