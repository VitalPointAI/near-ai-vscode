// The staff product ledger (design 10, 4.1; WP-SHARED): the decision log every product's state is replayed from. Pure: no I/O, no clock, no vscode.
//
// Every step of the release state machine is one ledger entry, signed with this device's key (`signPayload`, purpose `staff-ledger`) and chained to the
// entry before it by the SHA-256 of that entry's canonical form. A person's approve, reject, release or supersede is signed by the same key as that
// person's signature; until verified identities arrive (Phase 71) the name and role are self-declared and every surface says so. An agent never holds the
// key (it lives in VS Code's secret storage), so it cannot write an entry that verifies: a line it adds, changes, removes or reorders breaks the chain, and
// every product the ledger touches from that point reads as `draft (tampered)`.
//
// The product file's header is a projection of this ledger. A header that claims a state, version or verdict the ledger does not hold reads as tampered;
// so does an approved or released product whose text changed on disk. Nothing here repairs a tampered product silently: the next step a member or a
// person takes through the tool or the commands writes the header again from the ledger.
import { createHash } from 'node:crypto';
import { canonicalize } from '../team/canonical';
import type { PayloadVerdict } from '../team/signedPayload';
import { STAFF_LEVELS, STAFF_PROFILE_IDS, STAFF_SECTION_IDS } from './doctrine';
import type { StaffLevel, StaffProfileId, StaffSectionId } from './doctrine';
import type { DecisionOption } from './events';
import { isOneLine, isOneOf, isRecord, ownValue, STAFF_SLUG } from './parse';
import { LABEL_PATTERN, PRODUCT_KINDS } from './products';
import type { HeaderVerdict, ProductDependency, ProductHeader, ProductKind } from './products';
import {
  GUARD_VERDICTS, PRODUCT_HASH_PATTERN, RELEASE_EVENT_TYPES, startProduct, TRADECRAFT_VERDICTS, transition
} from './release';
import type {
  AgentActor, GuardVerdict, ProductRecord, ProductRoles, ReleaseEvent, ReleaseState, StaffActor, StaffGate, TradecraftVerdict, TransitionRecord
} from './release';

export const LEDGER_ENTRY_VERSION = 1;
/** The `prev` of the first entry. */
export const LEDGER_GENESIS = '0'.repeat(64);
/** The most entries one ledger holds; past this the host refuses to append rather than slow every read. */
export const MAX_LEDGER_ENTRIES = 20_000;

/**
 * The actor recorded for a change found by hash: the file changed outside the staff tools and nobody can say who changed it. The slug is reserved; a
 * team member may not be called `file-change`.
 */
export const FILE_CHANGE_ACTOR: AgentActor = Object.freeze({ kind: 'agent', member: 'file-change' });
export const RESERVED_MEMBER_SLUGS: readonly string[] = ['file-change'];

/** What a product is, fixed when it is first proposed or changed with a new version: the header fields the state machine does not hold. */
export interface ProductMetaInput {
  readonly kind: ProductKind;
  readonly label: string;
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly dependsOn: readonly ProductDependency[];
}

/** What a submit carries for the decision queue: the options with their risk, the dissent beside them (never dropped), and the deadline if any. */
export interface DecisionRequestInput {
  readonly options: readonly DecisionOption[];
  readonly dissent: readonly string[];
  readonly deadline?: string;
}

export interface LedgerEntry {
  readonly v: typeof LEDGER_ENTRY_VERSION;
  readonly seq: number;
  readonly prev: string;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`. */
  readonly at: string;
  /** The run that made the step, or `person` for a person's command outside a run. */
  readonly run: string;
  readonly product: string;
  readonly section: StaffSectionId;
  /**
   * On the propose that starts a line only: who owns, leads, guards and (for J2) reviews the product. A product's first version starts its first line; a
   * version written after a person approved, released or withdrew the last one starts a new line with the next version number.
   */
  readonly roles?: ProductRoles;
  /** For a step on an older line (a person superseding the released version a newer one replaces): that line's version. */
  readonly line?: number;
  readonly event: ReleaseEvent;
  readonly actor: StaffActor;
  /** On a propose or an edit: the header fields of the new version. */
  readonly meta?: ProductMetaInput;
  /** On a submit: the options, dissent and deadline for the decision queue. */
  readonly request?: DecisionRequestInput;
}

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_TEXT = 500;
const MAX_LIST = 20;

function oneLines(value: unknown, max = MAX_TEXT, limit = MAX_LIST): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) => isOneLine(item, max));
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validActor(value: unknown): value is StaffActor {
  if (!isRecord(value)) return false;
  const kind = ownValue(value, 'kind');
  if (kind === 'agent') return hasOnly(value, ['kind', 'member']) && typeof ownValue(value, 'member') === 'string' && STAFF_SLUG.test(ownValue(value, 'member') as string);
  if (kind === 'person') {
    return hasOnly(value, ['kind', 'name', 'role', 'deviceFingerprint'])
      && isOneLine(ownValue(value, 'name'), 120) && isOneLine(ownValue(value, 'role'), 80) && isOneLine(ownValue(value, 'deviceFingerprint'), 200);
  }
  return false;
}

function validRoles(value: unknown): value is ProductRoles {
  if (!isRecord(value) || !hasOnly(value, ['owner', 'sectionLead', 'releaseGuard', 'tradecraftReviewer'])) return false;
  const slug = (key: string, optional = false): boolean => {
    const field = ownValue(value, key);
    return (optional && field === undefined) || (typeof field === 'string' && STAFF_SLUG.test(field));
  };
  return slug('owner') && slug('sectionLead') && slug('releaseGuard') && slug('tradecraftReviewer', true);
}

function validEvent(value: unknown): value is ReleaseEvent {
  if (!isRecord(value)) return false;
  const type = ownValue(value, 'type');
  if (!isOneOf(RELEASE_EVENT_TYPES, type)) return false;
  const hash = (): boolean => typeof ownValue(value, 'hash') === 'string' && PRODUCT_HASH_PATTERN.test(ownValue(value, 'hash') as string);
  switch (type) {
    case 'propose': case 'edit': case 'release': return hasOnly(value, ['type', 'hash']) && hash();
    case 'verdict': {
      const gate = ownValue(value, 'gate');
      const verdict = ownValue(value, 'verdict');
      return hasOnly(value, ['type', 'gate', 'verdict', 'hash', 'reasons']) && hash() && (gate === 'guard' || gate === 'tradecraft')
        && (isOneOf(GUARD_VERDICTS, verdict) || isOneOf(TRADECRAFT_VERDICTS, verdict)) && oneLines(ownValue(value, 'reasons'));
    }
    case 'submit': return hasOnly(value, ['type', 'decisionFor']) && isOneLine(ownValue(value, 'decisionFor'), 80);
    case 'approve': {
      const release = ownValue(value, 'releaseOnApproval');
      return hasOnly(value, ['type', 'hash', 'releaseOnApproval']) && hash() && (release === undefined || typeof release === 'boolean');
    }
    case 'reject': return hasOnly(value, ['type', 'reasons']) && oneLines(ownValue(value, 'reasons'));
    case 'supersede': return hasOnly(value, ['type', 'byVersion']) && Number.isSafeInteger(ownValue(value, 'byVersion'));
    case 'withdraw': return hasOnly(value, ['type', 'reason']) && isOneLine(ownValue(value, 'reason'), MAX_TEXT);
    default: return false;
  }
}

const DEPENDENCY_PRODUCT = STAFF_SLUG;

function validMeta(value: unknown): value is ProductMetaInput {
  if (!isRecord(value) || !hasOnly(value, ['kind', 'label', 'profile', 'level', 'dependsOn'])) return false;
  const depends = ownValue(value, 'dependsOn');
  return isOneOf(PRODUCT_KINDS, ownValue(value, 'kind')) && typeof ownValue(value, 'label') === 'string' && LABEL_PATTERN.test(ownValue(value, 'label') as string)
    && isOneOf(STAFF_PROFILE_IDS, ownValue(value, 'profile')) && isOneOf(STAFF_LEVELS, ownValue(value, 'level'))
    && Array.isArray(depends) && depends.length <= 50 && depends.every((entry) => isRecord(entry) && hasOnly(entry, ['product', 'version'])
      && typeof ownValue(entry, 'product') === 'string' && DEPENDENCY_PRODUCT.test(ownValue(entry, 'product') as string)
      && Number.isSafeInteger(ownValue(entry, 'version')) && (ownValue(entry, 'version') as number) >= 1);
}

function validRequest(value: unknown): value is DecisionRequestInput {
  if (!isRecord(value) || !hasOnly(value, ['options', 'dissent', 'deadline'])) return false;
  const options = ownValue(value, 'options');
  const deadline = ownValue(value, 'deadline');
  return Array.isArray(options) && options.length <= 10
    && options.every((option) => isRecord(option) && hasOnly(option, ['label', 'risk']) && isOneLine(ownValue(option, 'label'), 200) && isOneLine(ownValue(option, 'risk'), MAX_TEXT))
    && oneLines(ownValue(value, 'dissent')) && (deadline === undefined || (typeof deadline === 'string' && ISO_MILLIS.test(deadline)));
}

/** Reads one ledger entry strictly: every field checked, nothing unknown kept. Undefined when the value is not an entry this version can read. */
export function parseLedgerEntry(value: unknown): LedgerEntry | undefined {
  if (!isRecord(value) || !hasOnly(value, ['v', 'seq', 'prev', 'at', 'run', 'product', 'section', 'roles', 'line', 'event', 'actor', 'meta', 'request'])) return undefined;
  if (ownValue(value, 'v') !== LEDGER_ENTRY_VERSION) return undefined;
  const seq = ownValue(value, 'seq');
  const prev = ownValue(value, 'prev');
  const at = ownValue(value, 'at');
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof prev !== 'string' || !PRODUCT_HASH_PATTERN.test(prev) || typeof at !== 'string' || !ISO_MILLIS.test(at)) return undefined;
  if (!isOneLine(ownValue(value, 'run'), 120)) return undefined;
  const product = ownValue(value, 'product');
  if (typeof product !== 'string' || !STAFF_SLUG.test(product) || !isOneOf(STAFF_SECTION_IDS, ownValue(value, 'section'))) return undefined;
  const roles = ownValue(value, 'roles');
  if (roles !== undefined && !validRoles(roles)) return undefined;
  const line = ownValue(value, 'line');
  if (line !== undefined && (!Number.isSafeInteger(line) || (line as number) < 1)) return undefined;
  if (!validEvent(ownValue(value, 'event')) || !validActor(ownValue(value, 'actor'))) return undefined;
  const meta = ownValue(value, 'meta');
  if (meta !== undefined && !validMeta(meta)) return undefined;
  const request = ownValue(value, 'request');
  if (request !== undefined && !validRequest(request)) return undefined;
  // Checked above field by field; the value is read back through JSON so no prototype or getter survives into the entry.
  return JSON.parse(canonicalize(value)) as LedgerEntry;
}

/** The SHA-256 of a signed entry's canonical form: the next entry's `prev`. */
export function entryDigest(envelope: unknown): string {
  return createHash('sha256').update(canonicalize(envelope)).digest('hex');
}

/** The version hash of a product: its body (line endings made LF) and what it depends on, so accepting a changed source is a new version. */
export function productHash(body: string, dependsOn: readonly ProductDependency[]): string {
  const depends = dependsOn.map((entry) => `${entry.product}@${entry.version}`).join(',');
  return createHash('sha256').update(`${body.replace(/\r\n/g, '\n')}\n--depends_on: ${depends}`).digest('hex');
}

// ---- Replay ------------------------------------------------------------------------------------------------------------------------------------

export interface HistoryItem extends TransitionRecord { readonly at: string; readonly run: string; readonly seq: number }

export interface GateMark { readonly verdict: string; readonly at: string; readonly version: number; readonly reasons: readonly string[] }

export interface ProductState {
  readonly record: ProductRecord;
  readonly meta: ProductMetaInput;
  readonly history: readonly HistoryItem[];
  /** The last guard and tradecraft verdicts on the current version, for the header and the registry. */
  readonly guard?: GateMark;
  readonly tradecraft?: GateMark;
  /** The open decision request (on awaiting-decision), with the run and time it was made. */
  readonly request?: DecisionRequestInput & { readonly requestedAt: string; readonly run: string };
  /** Every version a person approved. */
  readonly approvedVersions: readonly number[];
  /** Why the ledger cannot vouch for this product, when it cannot. */
  readonly tampered?: string;
  /** Earlier lines of the same product (approved, released, withdrawn or superseded versions), oldest first. */
  readonly older: readonly ProductState[];
}

/** States that close a line: a new version after one of these starts a new line. */
export const LINE_CLOSING_STATES: readonly ReleaseState[] = ['approved', 'released', 'withdrawn', 'superseded'];

export interface LedgerReplay {
  readonly products: ReadonlyMap<string, ProductState>;
  /** Entries read and trusted. */
  readonly entries: number;
  /** The digest the next entry chains to. */
  readonly head: string;
  /** Where the chain broke, when it did: nothing after it is trusted. */
  readonly broken?: { readonly seq: number; readonly reason: string };
}

export const LEDGER_PROBLEMS = {
  unreadable: 'A ledger line could not be read as a signed entry.',
  signature: 'A ledger entry is not signed by a key this computer trusts, so it was written outside SovAI or changed.',
  chain: 'A ledger entry does not follow the one before it, so an entry was removed, reordered or added outside SovAI.',
  'person-key': 'A person\'s decision is signed by a key other than the one it names.',
  impossible: 'A ledger entry records a step the state machine refuses, so it was not written by SovAI.',
  'after-break': 'An earlier ledger entry is broken, so nothing after it can be trusted.',
  'file-unreadable': 'The ledger file could not be read in full (it is larger than the limit, or the disk refused it), so none of its entries is trusted.',
  truncated: 'The ledger ends before the last entry this computer recorded, so entries were removed from its end, or the file was deleted or replaced by an older copy.',
  replaced: 'The ledger entry this computer last recorded is not the one in the file at that place, so the ledger was replaced or rewritten.',
  'head-unverified': 'This computer\'s signed record of the ledger head does not verify, so the ledger cannot be checked against it.'
} as const;

/**
 * The ledger head this computer last saw (design 10, 4.1; the D-59 rollback marker the label map keeps): how many entries the ledger held and the digest
 * of the last one. It is signed with this device's key (purpose `staff-ledger-head`) and kept in the extension's SecretStorage, outside the project, so
 * deleting the ledger file or cutting entries off its end cannot also roll this record back.
 */
export interface LedgerHeadMark {
  readonly v: 1;
  /** Entries the ledger held. */
  readonly count: number;
  /** entryDigest of entry `count - 1`; LEDGER_GENESIS when count is 0. */
  readonly head: string;
}

export function parseLedgerHeadMark(value: unknown): LedgerHeadMark | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'count,head,v' || value.v !== 1) return undefined;
  const count = value.count;
  const head = value.head;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || typeof head !== 'string' || !/^[0-9a-f]{64}$/.test(head)) return undefined;
  return { v: 1, count, head };
}
export type LedgerProblem = keyof typeof LEDGER_PROBLEMS;

/**
 * Replays signed ledger lines into product states. `verify` checks one envelope's signature and key (verifyPayload with purpose `staff-ledger` and the
 * keys this computer trusts). The first line that fails any check breaks the chain: nothing after it is applied, and every product it or a later line
 * names is marked tampered with the reason. With `expect`, the head this computer last recorded, a ledger shorter than it or with another entry at its
 * place is broken too (`truncated`, `replaced`).
 */
export function replayLedger(envelopes: readonly unknown[], verify: (envelope: unknown) => PayloadVerdict<unknown>, expect?: LedgerHeadMark): LedgerReplay {
  const products = new Map<string, ProductState>();
  let head = LEDGER_GENESIS;
  let broken: { seq: number; reason: string } | undefined;
  let entries = 0;
  let headAtMark: string | undefined;
  const mark = (product: string | undefined, reason: string): void => {
    if (product === undefined) return;
    const state = products.get(product);
    if (state && state.tampered === undefined) products.set(product, { ...state, tampered: reason });
  };
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const named = isRecord(envelope) && isRecord(ownValue(envelope, 'payload')) ? ownValue(ownValue(envelope, 'payload') as Record<string, unknown>, 'product') : undefined;
    const namedProduct = typeof named === 'string' ? named : undefined;
    if (broken) { mark(namedProduct, LEDGER_PROBLEMS['after-break']); continue; }
    const fail = (problem: LedgerProblem): void => {
      broken = { seq: index, reason: LEDGER_PROBLEMS[problem] };
      mark(namedProduct, LEDGER_PROBLEMS[problem]);
    };
    const verdict = verify(envelope);
    if (!verdict.ok) { fail(verdict.reason === 'malformed' ? 'unreadable' : 'signature'); continue; }
    const entry = parseLedgerEntry(verdict.payload);
    if (!entry) { fail('unreadable'); continue; }
    if (entry.seq !== index || entry.prev !== head) { fail('chain'); continue; }
    if (entry.actor.kind === 'person' && entry.actor.deviceFingerprint !== verdict.signer.fingerprint) { fail('person-key'); continue; }
    const applied = apply(products.get(entry.product), entry);
    if (!applied) { fail('impossible'); continue; }
    products.set(entry.product, applied);
    head = entryDigest(envelope);
    entries += 1;
    if (expect && entries === expect.count) headAtMark = head;
  }
  // Checked against the head this computer last recorded: a ledger cut short, deleted or replaced reads as tampered, every product in it too, because
  // which entries went missing (a HOLD, a decision) cannot be known.
  if (!broken && expect && expect.count > 0) {
    const problem: LedgerProblem | undefined = entries < expect.count ? 'truncated' : headAtMark !== expect.head ? 'replaced' : undefined;
    if (problem) {
      broken = { seq: Math.min(entries, expect.count - 1), reason: LEDGER_PROBLEMS[problem] };
      for (const product of [...products.keys()]) mark(product, LEDGER_PROBLEMS[problem]);
    }
  }
  return { products, entries, head, ...(broken ? { broken } : {}) };
}

/** One entry applied to one product's state, or undefined when the state machine refuses it. */
export function apply(state: ProductState | undefined, entry: LedgerEntry): ProductState | undefined {
  if (state === undefined) {
    if (entry.event.type !== 'propose' || !entry.roles || !entry.meta || entry.line !== undefined) return undefined;
    const started = startProduct({ product: entry.product, section: entry.section, roles: entry.roles }, entry.actor, entry.event.hash);
    if (!started.ok) return undefined;
    return { record: started.record, meta: entry.meta, history: stamp(started.transitions, entry), approvedVersions: [], older: [] };
  }
  if (state.tampered !== undefined) return state;
  if (entry.section !== state.record.section) return undefined;
  if (entry.roles !== undefined) return newLine(state, entry);
  if (entry.line !== undefined) return onOlderLine(state, entry);
  const next = step(state, entry);
  return next === undefined ? undefined : { ...next, older: state.older };
}

/** A new version after a person closed the current line: it starts at the next version number, and the closed line is kept. */
function newLine(state: ProductState, entry: LedgerEntry): ProductState | undefined {
  if (!LINE_CLOSING_STATES.includes(state.record.state) || entry.event.type !== 'propose' || !entry.meta || !entry.roles || entry.line !== undefined) return undefined;
  const started = startProduct({ product: entry.product, section: entry.section, roles: entry.roles }, entry.actor, entry.event.hash);
  if (!started.ok) return undefined;
  const version = state.record.version + 1;
  const record: ProductRecord = { ...started.record, version };
  const transitions = started.transitions.map((item) => ({ ...item, version }));
  const closed: ProductState = { ...state, older: [] };
  return { record, meta: entry.meta, history: [...state.history, ...stamp(transitions, entry)], approvedVersions: state.approvedVersions, older: [...state.older, closed] };
}

/** A step on an older line: a person superseding a released version (or withdrawing one). Nothing else reaches an older line. */
function onOlderLine(state: ProductState, entry: LedgerEntry): ProductState | undefined {
  if (entry.event.type !== 'supersede' && entry.event.type !== 'withdraw') return undefined;
  const index = state.older.findIndex((line) => line.record.version === entry.line);
  if (index < 0) return undefined;
  const line = state.older[index];
  const next = step(line, entry);
  if (next === undefined) return undefined;
  const added = next.history.slice(line.history.length);
  const older = [...state.older.slice(0, index), { ...next, older: [] }, ...state.older.slice(index + 1)];
  return { ...state, history: [...state.history, ...added], older };
}

function step(state: ProductState, entry: LedgerEntry): Omit<ProductState, 'older'> | undefined {
  const result = transition(state.record, entry.event, entry.actor);
  if (!result.ok) return undefined;
  const record = result.record;
  const history = [...state.history, ...stamp(result.transitions, entry)];
  const newVersion = record.version !== state.record.version;
  const event = entry.event;
  if (newVersion && !entry.meta) return undefined;
  // A new version voids every verdict and request on the old one (the state machine already cleared them on the record).
  let guard = newVersion ? undefined : state.guard;
  let tradecraft = newVersion ? undefined : state.tradecraft;
  let request = newVersion ? undefined : state.request;
  if (event.type === 'verdict') {
    const markOf: GateMark = { verdict: event.verdict, at: entry.at, version: record.version, reasons: [...event.reasons] };
    if (event.gate === 'guard') guard = markOf; else tradecraft = markOf;
  }
  if (event.type === 'submit') request = { options: entry.request?.options ?? [], dissent: entry.request?.dissent ?? [], ...(entry.request?.deadline ? { deadline: entry.request.deadline } : {}), requestedAt: entry.at, run: entry.run };
  if (event.type === 'approve' || event.type === 'reject' || event.type === 'withdraw') request = undefined;
  const approvedVersions = event.type === 'approve' ? [...state.approvedVersions, record.version] : state.approvedVersions;
  const meta = newVersion && entry.meta ? entry.meta : state.meta;
  return {
    record, meta, history, approvedVersions,
    ...(guard ? { guard } : {}), ...(tradecraft ? { tradecraft } : {}), ...(request ? { request } : {})
  };
}

function stamp(transitions: readonly TransitionRecord[], entry: LedgerEntry): HistoryItem[] {
  return transitions.map((item) => ({ ...item, at: entry.at, run: entry.run, seq: entry.seq }));
}

// ---- The header as a projection, and tamper checks ---------------------------------------------------------------------------------------------

/** Where a gate's report for one version lives, relative to the product's own folder (design 10, 4.1 header example and 4.2). */
export function gateReportPath(gate: StaffGate, product: string, version: number): string {
  return `${gate === 'guard' ? 'guard' : 'tradecraft'}/${product}-v${version}.md`;
}

/** The header the ledger says the product file should carry. */
export function projectHeader(state: ProductState): ProductHeader {
  const { record, meta } = state;
  const mark = <V extends string>(gate: StaffGate, value: GateMark | undefined): HeaderVerdict<V> | undefined => value === undefined
    ? undefined
    : { verdict: value.verdict as V, at: value.at, report: gateReportPath(gate, record.product, value.version) };
  const guard = mark<GuardVerdict>('guard', state.guard);
  const tradecraft = mark<TradecraftVerdict>('tradecraft', state.tradecraft);
  // A product past the guard always shows the CLEARED verdict that let it through, even after a later step (a header must carry it, products.ts).
  return {
    product: record.product, kind: meta.kind, section: record.section, owner: record.roles.owner, profile: meta.profile, level: meta.level,
    version: record.version, state: record.state, label: meta.label,
    // The state machine keeps the role through approve, reject and release, and clears it only with a new version.
    ...(record.decisionFor !== undefined ? { decisionFor: record.decisionFor } : {}),
    dependsOn: [...meta.dependsOn],
    ...(guard ? { guard } : {}),
    ...(tradecraft ? { tradecraft } : {})
  };
}

export const TAMPER_REASONS = {
  'header-missing': 'The product file has no staff header, but the ledger holds the product.',
  'header-state': 'The header claims a state the ledger does not hold.',
  'header-version': 'The header claims a version the ledger does not hold.',
  'header-verdict': 'The header claims a gate verdict the ledger does not hold.',
  'header-identity': 'The header names a different product, section or owner than the ledger.',
  'locked-changed': 'The approved or released text changed on disk after a person decided on it.',
  'not-in-ledger': 'The header claims a state past draft, but the ledger has no record of the product.'
} as const;
export type TamperReason = keyof typeof TAMPER_REASONS;

/**
 * Whether a product file on disk agrees with the ledger. `header` is the parsed header (undefined when the file has none or it does not parse) and
 * `hash` the version hash of the file's body and the header's depends_on. Returns the first disagreement, or undefined when they agree. A body that changed
 * while the product can still change is not tampering: it is an edit, which the host records as a new version before it calls this.
 */
export function headerDisagreement(state: ProductState | undefined, header: ProductHeader | undefined, hash: string | undefined): TamperReason | undefined {
  if (state === undefined) return header !== undefined && header.state !== 'draft' ? 'not-in-ledger' : undefined;
  if (header === undefined) return 'header-missing';
  const record = state.record;
  if (header.product !== record.product || header.section !== record.section || header.owner !== record.roles.owner) return 'header-identity';
  if ((record.state === 'approved' || record.state === 'released') && hash !== undefined && hash !== record.hash) return 'locked-changed';
  if (header.state !== record.state) return 'header-state';
  if (header.version !== record.version) return 'header-version';
  const expected = projectHeader(state);
  if ((header.guard?.verdict ?? null) !== (expected.guard?.verdict ?? null) || (header.tradecraft?.verdict ?? null) !== (expected.tradecraft?.verdict ?? null)) return 'header-verdict';
  return undefined;
}

// ---- What a person and the UI see ------------------------------------------------------------------------------------------------------------

/** The state words the ledger and the Staff Room show (UX concept 5.4): the machine's words, plus `draft (held)` and `draft (tampered)`. */
export type DisplayState = 'draft' | 'draft (held)' | 'draft (tampered)' | 'guard-checked' | 'awaiting decision' | 'approved' | 'rejected' | 'released' | 'superseded' | 'withdrawn';

export function displayState(state: ReleaseState, flags: { readonly held?: boolean; readonly tampered?: boolean }): DisplayState {
  if (flags.tampered) return 'draft (tampered)';
  if (state === 'draft' && flags.held) return 'draft (held)';
  return state === 'awaiting-decision' ? 'awaiting decision' : state;
}

/**
 * Whether a product depends on a version of another product older than that product's newest approved version (design 10, 4.1, dependency propagation).
 * The product is only marked: it drops back to draft when its owner accepts the change by writing a new version that depends on the new one.
 */
export function changedSources(state: ProductState, all: ReadonlyMap<string, ProductState>): ProductDependency[] {
  const changed: ProductDependency[] = [];
  for (const dependency of state.meta.dependsOn) {
    const source = all.get(dependency.product);
    if (!source) continue;
    const newest = Math.max(0, ...source.approvedVersions);
    if (newest > dependency.version) changed.push({ product: dependency.product, version: newest });
  }
  return changed;
}

/** The roles a product of a section gets from its team: the section lead, the release-guard and, for J2, the tradecraft reviewer (design 10, 3.2, 4.4). */
export const RELEASE_GUARD_SLUG = 'release-guard';
export const TRADECRAFT_REVIEWER_SLUG = 'tradecraft-reviewer';
/** Sections whose products pass the tradecraft gate before the release-guard (design 10, 4.4). */
export const TRADECRAFT_SECTIONS: readonly StaffSectionId[] = ['j2'];

