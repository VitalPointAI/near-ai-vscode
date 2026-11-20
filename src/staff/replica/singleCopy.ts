// Make a Single-Machine Copy (owner decision 6; D-35 as refined by D-47; MUS-06): the safe way back from a shared staff project. The shared state is
// folded into today's single-machine files in a new folder the person chooses, signed by this device with today's single-chain signer and head mark,
// so the copy is an ordinary single-machine staff project that today's host verifies. Node I/O only; never imports vscode.
//
// What the copy holds:
//   products.jsonl    today's product ledger: for each product the steps that brought it where the shared projection shows it, chained from
//                     LEDGER_GENESIS with entryDigest and signed by this device (purpose staff-ledger), and the signed head mark (staff-ledger-head)
//                     in SecretStorage under the key today's host computes for the copy's folder. A product shown from the imported ledger (31-19) is
//                     carried from that ledger's own entries; a product the shared project made is carried from the fold's versions family, in the
//                     fold's total order, as the projection (31-11) reads it.
//   decisions.jsonl   the imported decision log, each decision chained again and signed by this device (purpose staff-decision).
//   calculator.jsonl  the imported calculator ledger, chained again and signed by this device (purpose staff-ledger).
//   the wargame       the imported wargame ledger, byte for byte (it is unsigned and unchained).
//   product files     each product's header as the copy's own ledger projects it, then its live text from the shared project.
//
// Honest about who decided what (D-47; P-31-30):
// - Today's ledger refuses a person whose device is not the signer (person-key), so a step a person took on another device is carried under this
//   device with the name "<Name> (approved in the shared project, carried by <Copier>)" (the verb follows the step), at most 120 characters. Nothing
//   is ever signed as another person. A step this device's own person took keeps its name.
// - A version whose decision is contested in the shared project is never carried as decided: none of its decision steps is carried, the version
//   stays where its submit left it (awaiting a decision), its open request carries the note "contested at copy time", and the result lists it.
//   Steps the shared project has not settled (waiting for confirmation, or held) are not carried either.
//
// The shared project is never written (P-31-31): the destination is refused when it is the shared project's folder or inside it, and when it already
// holds staff files. Every refusal is checked before anything is written. The copy is first written to a staging folder beside its final place
// (.planning/staff.copy-<random>), and only when every file is there is that folder renamed to .planning/staff in one step, so a copy that fails part
// way never looks like a staff project. The copy's signed head mark is stored after every file is staged and before that rename, and taken back when
// the rename fails, so a copy in place always has its mark on this computer (D-07). Nothing is ever deleted.
//
// Not carried in Phase 31: the files no replica kind covers yet (registers, calculator record files, gate reports, proposals, settings, observations)
// and events.jsonl; the copy's StaffHost starts its own events. A person can copy those files by hand.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { fingerprintOf } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { signPayload, verifyPayload } from '../../domain/team/signedPayload';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import type { RosterView } from '../../domain/replica/rosterView';
import { actorForTransition, personForTransition } from '../../domain/replica/versions';
import type { ProductVersions, VersionAct, VersionView } from '../../domain/replica/versions';
import { apply, entryDigest, LEDGER_ENTRY_VERSION, LEDGER_GENESIS, LINE_CLOSING_STATES, parseLedgerEntry, productHash, replayLedger } from '../../domain/staff/ledger';
import type { LedgerEntry, LedgerHeadMark, ProductMetaInput, ProductState } from '../../domain/staff/ledger';
import { STAFF_SECTION_IDS } from '../../domain/staff/doctrine';
import { CALC_LEDGER_FILE, parseCalcLedgerEntry, replayCalcLedger } from '../../domain/staff/logistics';
import { multiUserNoticeLines, REPLICA_DIR } from '../../domain/staff/multiUser';
import { DECISION_LOG_FILE, DECISION_LOG_GENESIS, decisionDigest, parsePersonDecision, replayPersonDecisions } from '../../domain/staff/personDecisions';
import type { PersonDecisionEntry } from '../../domain/staff/personDecisions';
import type { ProductDependency } from '../../domain/staff/products';
import type { PersonActor, ReleaseEvent, StaffActor } from '../../domain/staff/release';
import { staffProductPath } from '../../domain/staff/writeLimits';
import { readWhole, writeIfUnchanged } from '../staffFiles';
import { LEDGER_DIR, LEDGER_FILE, WARGAME_DIR, WARGAME_FILE } from '../staffHost';
import { ledgerHeadKey, projectionInputOf } from './migrate';
import { foldTexts, IMPORTED_PRODUCTS_LEDGER, importedFile, importOf, ledgerLinesOf, projectImportedLedger, projectProductFile, projectProductStates } from './projection';
import type { ProjectionInput } from './projection';
import { ReplicaProject, isProjectRefused } from './replicaProject';
import type { ReplicaProjectDeps } from './replicaProject';

// ---- what a person reads ---------------------------------------------------------------------------------------------------------------------------

/** Plain sentences for every way a copy is refused. Each one is checked before anything is written. */
export const COPY_REFUSALS = {
  'destination-inside-shared': 'The copy was not made, because the folder you chose is the shared project\'s folder or inside it, and the copy never writes into the shared project. Nothing was written. Choose a new folder outside the shared project.',
  'destination-has-staff-files': 'The copy was not made, because the folder you chose already holds staff files (a .planning/staff folder). Nothing was written. Choose a new, empty folder.',
  'not-shared': 'The copy was not made, because this folder holds no shared staff project. Nothing was written. A project that is not shared is already a single-machine project.',
  'project-refused': 'The copy was not made, because the shared project could not be opened. Nothing was written.'
} as const;
export type CopyRefusal = keyof typeof COPY_REFUSALS;

/** The note a version whose decision is contested in the shared project carries in the copy (D-35). */
export const CONTESTED_AT_COPY_TEXT = 'contested at copy time';

/** The longest person name today's ledger keeps (ledger.ts validActor). */
const MAX_NAME = 120;

/** The verbs a carried step is named with: an approval, a rejection, a release, a withdrawal or a supersession, and a decision log entry. */
export type CarriedAct = 'approved' | 'rejected' | 'released' | 'withdrawn' | 'superseded';

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** The longest start of `text` (whole code points, so no surrogate pair is cut) that is at most `max` UTF-16 units long. */
function cut(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out.trimEnd();
}

/**
 * The name a step another person took is carried under in the copy (D-47): "<Name> (approved in the shared project, carried by <Copier>)", the
 * verb following the step. At most 120 characters: the carried name is shortened first, and the copier's name only when it alone would not fit.
 */
export function carriedApprovalName(name: string, copier: string, act: CarriedAct = 'approved'): string {
  const head = ` (${act} in the shared project, carried by `;
  // The copier's name gets at most what leaves room for one character of the carried name.
  const copierName = cut(oneLine(copier) || 'this computer\'s person', MAX_NAME - head.length - 2);
  const tail = `${head}${copierName})`;
  const carried = cut(oneLine(name) || 'a person', MAX_NAME - tail.length) || '?';
  return `${carried}${tail}`;
}

// ---- inputs and results ----------------------------------------------------------------------------------------------------------------------------

/** What a copy needs: the shared project's dependencies (secret storage, global storage, clock), and the person this device signs for. */
export interface CopyDeps extends ReplicaProjectDeps {
  /** The person making the copy, as today's host names a person: every step another person took is carried under this name. */
  copier: { readonly name: string; readonly role: string };
}

/** A product the copy could not carry exactly as the shared projection shows it, with the reason. */
export interface CopyDifference { readonly product: string; readonly reason: string }

export interface CopyResult {
  readonly ok: true;
  /** The copy's staff folder. */
  readonly destination: string;
  /** Every file written, by path from the destination. */
  readonly written: string[];
  /** How many steps or decisions other people took were carried under this device (D-47). */
  readonly carried: number;
  /** Each version whose decision is contested in the shared project, as product@version: left undecided in the copy. */
  readonly contested: string[];
  /** Products whose shared history today's ledger cannot show step by step: carried up to the step it refuses, and listed here. */
  readonly differs: CopyDifference[];
  /** Imported ledgers that were not carried, with the reason (their import does not verify, or is not plain text). */
  readonly left: Array<{ ledger: string; reason: string }>;
  /** The notices every multi-user result shows (D-13). */
  readonly notices: string[];
}
export interface CopyRefused { readonly ok: false; readonly refused: CopyRefusal; readonly message: string }

const refuse = (reason: CopyRefusal, message?: string): CopyRefused => ({ ok: false, refused: reason, message: message ?? COPY_REFUSALS[reason] });

// ---- the destination -------------------------------------------------------------------------------------------------------------------------------

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The real path of `target`: its nearest existing folder resolved through symbolic links, then the rest of the path as given. */
async function realOf(target: string): Promise<string> {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);

/** Why the destination cannot take a copy of the shared project, or undefined. Writes nothing. */
async function destinationProblem(sharedRoot: string, destination: string): Promise<CopyRefusal | undefined> {
  const shared = await realOf(sharedRoot);
  const target = await realOf(destination);
  // The shared project's folder and everything in it (its replica folder above all) is never written; neither is a folder the shared project is in
  // the staff folder of.
  if (within(target, shared) || within(target, path.join(shared, ...REPLICA_DIR.split('/'))) || within(shared, path.join(target, '.planning', 'staff'))) return 'destination-inside-shared';
  if (await exists(path.join(destination, '.planning', 'staff'))) return 'destination-has-staff-files';
  return undefined;
}

// ---- the product ledger ----------------------------------------------------------------------------------------------------------------------------

type Draft = Omit<LedgerEntry, 'v' | 'seq' | 'prev'>;

/** One step to carry: its draft, where it sorts, and which version of which product it is for. */
interface Step { readonly order: number; readonly draft: Draft; readonly decision: boolean }

const DECISION_KINDS: readonly string[] = ['version.decide', 'version.release', 'version.withdraw', 'version.supersede'];

/** The device fingerprint today's ledger records for a replica writer id (both come from the same Ed25519 key), as the projection does. */
function fingerprintFor(writer: string, roster: RosterView): string {
  const key = roster.deviceKey(writer);
  if (key === undefined) return writer;
  try {
    return fingerprintOf(Buffer.from(key.publicKey, 'base64url'));
  } catch {
    return writer;
  }
}

function withFingerprint(actor: StaffActor, roster: RosterView): StaffActor {
  return actor.kind === 'person' ? { ...actor, deviceFingerprint: fingerprintFor(actor.deviceFingerprint, roster) } : actor;
}

function verbOf(event: ReleaseEvent): CarriedAct {
  switch (event.type) {
    case 'reject': return 'rejected';
    case 'release': return 'released';
    case 'withdraw': return 'withdrawn';
    case 'supersede': return 'superseded';
    default: return 'approved';
  }
}

/**
 * Steps of one product the shared project made (not shown from an import), read from the fold's versions family in the fold's total order as the
 * projection reads them (31-11), with the copy's rules for decisions: a contested version carries none, and acts the fold refused, has not settled
 * (pending confirmation) or holds are not carried.
 */
function foldSteps(product: ProductVersions, input: ProjectionInput, order: ReadonlyMap<string, number>, numbers: ReadonlyMap<string, number>, contested: string[], notes: Map<string, string>): Step[] | CopyDifference {
  const roster = input.roster;
  const refused = new Set(product.refusals.map((item) => item.entry));
  const views = new Map<number, VersionView>(product.versions.map((view) => [view.number, view]));
  const byHash = new Map<string, VersionView>(product.versions.map((view) => [view.hash, view]));
  const unreadable: CopyDifference = { product: product.product, reason: 'A step in its shared history is missing its time, header or pin, so it was not carried.' };
  const steps: Step[] = [];
  const candidates: Array<{ order: number; view: VersionView; act?: VersionAct }> = [];
  for (const record of product.records) {
    const view = views.get(record.number);
    const at = order.get(record.entry);
    if (view === undefined || at === undefined) return unreadable;
    candidates.push({ order: at, view });
    const decision = view.decision;
    const unsettled = new Set([...decision.pending, ...decision.held.map((item) => item.id)]);
    if (decision.status === 'contested') {
      contested.push(`${product.product}@${view.number}`);
      const names = [...new Set(record.acts.filter((act) => decision.contested.includes(act.entry)).map((act) => roster.memberName(act.member, act.roster) ?? act.member))].sort();
      notes.set(`${product.product}@${view.number}`, cut(`${CONTESTED_AT_COPY_TEXT}: in the shared project ${names.join(' and ') || 'two people'} decided this version at the same time, so the copy leaves the decision open.`, 500));
    }
    for (const act of record.acts) {
      if (refused.has(act.entry)) continue;
      if (DECISION_KINDS.includes(act.kind) && (decision.status === 'contested' || unsettled.has(act.entry))) continue;
      // A decline settles nothing on its own: it is no step of today's machine.
      if (act.kind === 'version.decide' && act.data.outcome === 'decline') continue;
      const actOrder = order.get(act.entry);
      if (actOrder === undefined) return unreadable;
      candidates.push({ order: actOrder, view, act });
    }
  }
  candidates.sort((a, b) => a.order - b.order);

  let state: ProductState | undefined;
  const records = new Map(product.records.map((record) => [record.number, record]));
  // Each version's hash as today's ledger names it, set when its proposal is carried.
  const hashes = new Map<number, string>();
  for (const candidate of candidates) {
    const record = records.get(candidate.view.number);
    const entry = input.entries.get(candidate.act?.entry ?? candidate.view.entry);
    if (record === undefined || entry === undefined) return unreadable;
    const lastRun = state?.request?.run ?? state?.history[state.history.length - 1]?.run ?? 'person';
    const base = { at: entry.at, product: product.product, section: product.section } as const;
    let draft: Record<string, unknown>;
    const act = candidate.act;
    if (act === undefined) {
      const pins = candidate.view.pins.map((pin) => ({ product: pin.product, version: numbers.get(`${pin.product}@${pin.hash}`) }));
      if (pins.some((pin) => pin.version === undefined)) return unreadable;
      const dependsOn = pins as ProductDependency[];
      const header = candidate.view.header;
      const meta = { kind: header.kind, label: header.label, profile: header.profile, level: header.level, dependsOn } as ProductMetaInput;
      const text = input.texts?.get(candidate.view.hash);
      // Today's ledger names a version by the hash of its text with numbered pins; without the text the fold's hash stands, as in the projection.
      const hash = dependsOn.length === 0 || text === undefined ? candidate.view.hash : productHash(text, dependsOn);
      hashes.set(candidate.view.number, hash);
      const opensLine = state === undefined || LINE_CLOSING_STATES.includes(state.record.state);
      const edit = state !== undefined && (state.record.state === 'guard-checked' || state.record.state === 'awaiting-decision');
      draft = {
        ...base,
        run: entry.actor?.kind === 'agent' ? entry.actor.run : lastRun,
        ...(opensLine ? { roles: { ...record.roles } } : {}),
        event: { type: edit ? 'edit' : 'propose', hash },
        actor: { kind: 'agent', member: record.roles.owner },
        meta
      };
    } else {
      const current = state;
      if (current === undefined) return unreadable;
      const role = current.record.decisionFor ?? 'owner-side';
      const who = { actor: act.actor, member: act.member, writer: act.writer, roster: act.roster };
      const actor: StaffActor = act.actor.kind === 'person' && DECISION_KINDS.includes(act.kind)
        ? withFingerprint(personForTransition(act.member, role, act.writer, act.roster, roster), roster)
        : withFingerprint(actorForTransition(who, roster, record.roles, act.kind === 'version.submit'), roster);
      const data = act.data as Record<string, unknown>;
      const hash = hashes.get(candidate.view.number) ?? candidate.view.hash;
      let event: ReleaseEvent;
      switch (act.kind) {
        case 'version.verdict':
          event = { type: 'verdict', gate: data.gate as 'guard' | 'tradecraft', verdict: data.verdict as 'CLEARED', hash, reasons: [...(data.reasons as string[])] };
          break;
        case 'version.submit':
          event = { type: 'submit', decisionFor: data.decisionFor as string };
          break;
        case 'version.decide':
          event = data.outcome === 'approve' ? { type: 'approve', hash } : { type: 'reject', reasons: [...(data.reasons as string[])] };
          break;
        case 'version.release':
          event = { type: 'release', hash };
          break;
        case 'version.withdraw':
          event = { type: 'withdraw', reason: data.reason as string };
          break;
        case 'version.supersede': {
          const newer = byHash.get(data.byHash as string);
          if (newer === undefined) return unreadable;
          event = { type: 'supersede', byVersion: newer.number };
          break;
        }
        default:
          return unreadable;
      }
      const line = candidate.view.number === current.record.version ? undefined : candidate.view.number;
      const note = notes.get(`${product.product}@${candidate.view.number}`);
      draft = {
        ...base,
        run: act.actor.kind === 'agent' ? act.actor.run : lastRun,
        ...(line === undefined ? {} : { line }),
        event,
        actor,
        // A contested version's open request says so beside the decision the copy leaves open.
        ...(event.type === 'submit' && note !== undefined ? { request: { options: [], dissent: [note] } } : {})
      };
    }
    const parsed = parseLedgerEntry({ v: LEDGER_ENTRY_VERSION, seq: 0, prev: LEDGER_GENESIS, ...draft });
    if (parsed === undefined) return unreadable;
    const next = apply(state, parsed);
    if (next === undefined || next.tampered !== undefined) {
      // Two people taking the same decision at the same time (both approve, say) is one decision: the second step is already carried by the first.
      if (act !== undefined && DECISION_KINDS.includes(act.kind) && candidate.view.decision.status === 'effective') continue;
      return { product: product.product, reason: 'Its shared history holds steps today\'s product ledger cannot show one after another (for example gate verdicts made at the same time that disagree), so it was not carried.' };
    }
    const { v: _v, seq: _seq, prev: _prev, ...rest } = parsed;
    steps.push({ order: candidate.order, draft: rest, decision: act !== undefined && DECISION_KINDS.includes(act.kind) });
    state = next;
  }
  return steps;
}

interface ProductLedger {
  readonly lines: string[];
  readonly products: ReadonlyMap<string, ProductState>;
  readonly count: number;
  readonly head: string;
  readonly carried: number;
}

/** A person actor as the copy records it: kept when this device signed for them, carried under the copier otherwise. */
function carryPerson(actor: PersonActor, signer: PayloadSigner, copier: CopyDeps['copier'], act: CarriedAct): { actor: PersonActor; carried: boolean } {
  if (actor.deviceFingerprint === signer.fingerprint) return { actor, carried: false };
  return { actor: { kind: 'person', name: carriedApprovalName(actor.name, copier.name, act), role: actor.role, deviceFingerprint: signer.fingerprint }, carried: true };
}

/** Chains the drafts from LEDGER_GENESIS, each signed by this device, checking each against the state machine; a refused step stops its product. */
function chainProducts(drafts: readonly Draft[], signer: PayloadSigner, copier: CopyDeps['copier'], signedAt: Date, differs: CopyDifference[]): ProductLedger {
  const products = new Map<string, ProductState>();
  const stopped = new Set(differs.map((item) => item.product));
  const lines: string[] = [];
  let head = LEDGER_GENESIS;
  let carried = 0;
  for (const draft of drafts) {
    if (stopped.has(draft.product)) continue;
    let actor = draft.actor;
    let carriedHere = false;
    if (actor.kind === 'person') {
      const mapped = carryPerson(actor, signer, copier, verbOf(draft.event));
      actor = mapped.actor;
      carriedHere = mapped.carried;
    }
    const entry = parseLedgerEntry({ v: LEDGER_ENTRY_VERSION, seq: lines.length, prev: head, ...draft, actor });
    const next = entry === undefined ? undefined : apply(products.get(draft.product), entry);
    if (entry === undefined || next === undefined || next.tampered !== undefined) {
      stopped.add(draft.product);
      differs.push({ product: draft.product, reason: 'A step of it does not fit today\'s product ledger, so it was carried only up to that step.' });
      continue;
    }
    const envelope = signPayload(signer, 'staff-ledger', entry, { now: () => signedAt });
    products.set(draft.product, next);
    head = entryDigest(envelope);
    lines.push(JSON.stringify(envelope));
    if (carriedHere) carried += 1;
  }
  return { lines, products, count: lines.length, head, carried };
}

// The imported ledgers were verified at import by the staff lead with that computer's key status; here every signature is still checked against its
// own key, and the replay must end at the import's head and count (as projection.ts does for the product ledger).
const AS_VERIFIED_AT_IMPORT: KeyStatusLookup = () => ({ state: 'active' });

/** The product ledger drafts of every product: the imported ones from the import's own entries, then the rest from the fold, in the fold's order. */
function productDrafts(input: ProjectionInput, contested: string[], differs: CopyDifference[]): Draft[] {
  const shown = projectProductStates(input);
  const imported = new Set([...shown].filter(([, state]) => state.imported !== undefined).map(([name]) => name));
  const drafts: Draft[] = [];
  if (imported.size > 0) {
    const record = importOf(input.fold, IMPORTED_PRODUCTS_LEDGER);
    const bytes = record === undefined ? undefined : importedFile(record, input.entries);
    // projectProductStates shows a product as imported only when this replay holds; read again here for its entries.
    const replay = record === undefined || bytes === undefined ? undefined : projectImportedLedger(record, bytes);
    if (bytes !== undefined && replay !== undefined) {
      for (const line of ledgerLinesOf(bytes)) {
        const payload = isRecord(line) ? line.payload : undefined;
        const entry = parseLedgerEntry(payload);
        if (entry === undefined || !imported.has(entry.product)) continue;
        const { v: _v, seq: _seq, prev: _prev, ...draft } = entry;
        drafts.push(draft);
      }
    }
  }
  const products = ((input.fold.families.versions as ProductVersions[] | undefined) ?? []);
  const order = new Map<string, number>(input.fold.order.map((hash, index) => [hash, index]));
  const numbers = new Map<string, number>();
  for (const product of products) for (const view of product.versions) numbers.set(`${product.product}@${view.hash}`, view.number);
  const steps: Step[] = [];
  const seen = new Set<string>(imported);
  for (const product of products) {
    // Today's ledger keys products by name alone; the first stream holding a name is shown, as in the projection.
    if (seen.has(product.product) || product.versions.length === 0) continue;
    seen.add(product.product);
    const result = foldSteps(product, input, order, numbers, contested, new Map());
    if (Array.isArray(result)) steps.push(...result);
    else differs.push(result);
  }
  steps.sort((a, b) => a.order - b.order);
  return [...drafts, ...steps.map((step) => step.draft)];
}

// ---- the other ledgers -----------------------------------------------------------------------------------------------------------------------------

/** The bytes of an imported ledger when its import verifies with today's verifier and ends at the import's head and count, or why not. */
function verifiedImport(input: ProjectionInput, ledger: 'decisions' | 'calculator' | 'wargame'): { bytes: Buffer } | { reason: string } | undefined {
  const record = importOf(input.fold, ledger);
  if (record === undefined) return undefined;
  const bytes = importedFile(record, input.entries);
  if (bytes === undefined) return { reason: 'its imported file does not match the hash the shared history records, so it was not carried' };
  const lines = ledgerLinesOf(bytes);
  if (ledger === 'decisions') {
    const replay = replayPersonDecisions(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status: AS_VERIFIED_AT_IMPORT }));
    if (replay.broken !== undefined || replay.head !== record.legacyHead || replay.entries !== record.count) return { reason: 'its imported entries do not verify, so it was not carried' };
  } else if (ledger === 'calculator') {
    const replay = replayCalcLedger(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: AS_VERIFIED_AT_IMPORT }));
    if (replay.broken !== undefined || replay.head !== record.legacyHead || replay.entries !== record.count) return { reason: 'its imported entries do not verify, so it was not carried' };
  } else if (createHash('sha256').update(bytes).digest('hex') !== record.legacyHead) {
    return { reason: 'its imported file does not match the head the shared history records, so it was not carried' };
  }
  return { bytes };
}

/** The decision log chained again from its genesis and signed by this device; a decision another device signed is carried under the copier (D-47). */
function chainDecisions(bytes: Buffer, signer: PayloadSigner, copier: CopyDeps['copier'], signedAt: Date): { lines: string[]; carried: number } {
  const lines: string[] = [];
  let head = DECISION_LOG_GENESIS;
  let carried = 0;
  for (const line of ledgerLinesOf(bytes)) {
    const entry = parsePersonDecision(isRecord(line) ? line.payload : undefined);
    if (entry === undefined) continue;
    const person = carryPerson(entry.person, signer, copier, entry.decision);
    const record: PersonDecisionEntry = { ...entry, seq: lines.length, prev: head, person: person.actor };
    const envelope = signPayload(signer, 'staff-decision', record, { now: () => signedAt });
    head = decisionDigest(envelope);
    lines.push(JSON.stringify(envelope));
    if (person.carried) carried += 1;
  }
  return { lines, carried };
}

/** The calculator ledger chained again from its genesis and signed by this device (its entries name agents, never persons). */
function chainCalculator(bytes: Buffer, signer: PayloadSigner, signedAt: Date): string[] {
  const lines: string[] = [];
  let head = LEDGER_GENESIS;
  for (const line of ledgerLinesOf(bytes)) {
    const entry = parseCalcLedgerEntry(isRecord(line) ? line.payload : undefined);
    if (entry === undefined) continue;
    const envelope = signPayload(signer, 'staff-ledger', { ...entry, seq: lines.length, prev: head }, { now: () => signedAt });
    head = entryDigest(envelope);
    lines.push(JSON.stringify(envelope));
  }
  return lines;
}

// ---- the copy --------------------------------------------------------------------------------------------------------------------------------------

const STAFF_PREFIX = '.planning/staff/';

/** For tests only: runs at each point a copy can stop, so a test can stop it there or change what is around it (as setCasProbe does for writes). */
export interface CopyProbe { (point: 'mark-stored', destination: string): Promise<void> | void }
let probe: CopyProbe | undefined;
export function setCopyProbe(next: CopyProbe | undefined): void { probe = next; }

/** Writes every file into a new staging folder beside .planning/staff. Never writes over a file; the staging folder is never deleted. */
async function stageCopy(destination: string, files: ReadonlyMap<string, string>): Promise<{ staging: string; written: string[] }> {
  const planning = path.join(destination, '.planning');
  await mkdir(planning, { recursive: true });
  const staging = path.join(planning, `staff.copy-${randomBytes(6).toString('hex')}`);
  await mkdir(staging);
  for (const [relative, text] of files) {
    const file = path.join(staging, ...relative.slice(STAFF_PREFIX.length).split('/'));
    if (!(await writeIfUnchanged(file, { exists: false }, text))) throw new Error(`The copy was not finished: ${relative} appeared in its staging folder while it was being written.`);
  }
  return { staging, written: [...files.keys()].sort() };
}

/** Renames a finished staging folder to .planning/staff in one step, unless a .planning/staff folder is already there. */
async function placeCopy(destination: string, staging: string): Promise<void> {
  const target = path.join(destination, '.planning', 'staff');
  // Checked again just before the rename, which would replace an empty folder another process made there.
  if (await exists(target)) throw new Error(`The copy was not finished: a .planning/staff folder appeared in the destination while it was being written. The copy is in ${path.relative(destination, staging)}.`);
  await rename(staging, target);
}

/**
 * Takes back the head mark this run stored, when the copy it names was not put in place (D-07): only while secret storage still holds the exact text
 * this run stored, so a mark a later copy stored is never removed. Best effort: the error that stopped the copy is the one the person sees.
 */
async function takeBackMark(deps: CopyDeps, key: string, stored: string): Promise<void> {
  try {
    if ((await deps.secrets.get(key)) === stored) await deps.secrets.delete(key);
  } catch {
    // The mark stays: it names a copy that is not in place, and the next copy into this folder stores its own over it.
  }
}

/**
 * Make a Single-Machine Copy: folds the shared project at `sharedRoot` into today's single-machine staff files at `destination`, signed by this
 * device (see the file comment). Refused, with nothing written anywhere, when the destination is in the shared project or already holds staff files,
 * and when the folder holds no shared project this computer can open. The shared project is only read.
 */
export async function makeSingleMachineCopy(sharedRoot: string, destination: string, deps: CopyDeps): Promise<CopyResult | CopyRefused> {
  const shared = path.resolve(sharedRoot);
  const target = path.resolve(destination);
  const problem = await destinationProblem(shared, target);
  if (problem !== undefined) return refuse(problem);

  const opened = await ReplicaProject.open(shared, deps);
  if (opened === undefined) return refuse('not-shared');
  if (isProjectRefused(opened)) return refuse(opened.refused === 'not-shared' ? 'not-shared' : 'project-refused', opened.refused === 'not-shared' ? undefined : `${COPY_REFUSALS['project-refused']} ${opened.message}`);
  const project = opened;
  try {
    const input = await projectionInputOf(project, deps);
    const signer = project.signer;
    const signedAt = (deps.now ?? (() => new Date()))();
    const contested: string[] = [];
    const differs: CopyDifference[] = [];
    const left: Array<{ ledger: string; reason: string }> = [];
    const files = new Map<string, string>();

    // The product ledger and the product files.
    const ledger = chainProducts(productDrafts(input, contested, differs), signer, deps.copier, signedAt, differs);
    let carried = ledger.carried;
    if (ledger.count > 0) files.set(`${LEDGER_DIR}/${LEDGER_FILE}`, `${ledger.lines.join('\n')}\n`);
    // The live texts as the projection reads them: a product whose text is known to be incomplete here is not copied with part of its text.
    const { texts, incomplete } = foldTexts(input.fold);
    for (const product of incomplete.keys()) differs.push({ product, reason: 'Its text in the shared project could not be read whole on this computer, so its file was not copied.' });
    for (const [product, state] of ledger.products) {
      const body = texts.get(product);
      if (body === undefined) continue;
      const relative = staffProductPath(state.record.section, product);
      // A product with no text and no file in the shared project stays without one, as writeProjections leaves it.
      if (body === '' && (await readWhole(path.join(shared, ...relative.split('/')))).kind === 'missing') continue;
      files.set(relative, projectProductFile(state, body));
    }
    // A product the copy could not carry keeps its text, as a file with no staff header: today's host reads it as a product not yet proposed.
    for (const difference of differs) {
      if (ledger.products.has(difference.product)) continue;
      const body = texts.get(difference.product);
      const versions = ((input.fold.families.versions as ProductVersions[] | undefined) ?? []).find((item) => item.product === difference.product);
      const section = STAFF_SECTION_IDS.find((id) => id === versions?.section);
      if (body === undefined || body === '' || section === undefined) continue;
      files.set(staffProductPath(section, difference.product), body);
    }

    // The decision log, the calculator ledger and the wargame ledger, from their imports.
    for (const name of ['decisions', 'calculator', 'wargame'] as const) {
      const read = verifiedImport(input, name);
      if (read === undefined) continue;
      if ('reason' in read) { left.push({ ledger: name, reason: read.reason }); continue; }
      if (name === 'decisions') {
        const chained = chainDecisions(read.bytes, signer, deps.copier, signedAt);
        carried += chained.carried;
        if (chained.lines.length > 0) files.set(`${LEDGER_DIR}/${DECISION_LOG_FILE}`, `${chained.lines.join('\n')}\n`);
      } else if (name === 'calculator') {
        const lines = chainCalculator(read.bytes, signer, signedAt);
        if (lines.length > 0) files.set(`${LEDGER_DIR}/${CALC_LEDGER_FILE}`, `${lines.join('\n')}\n`);
      } else {
        const text = read.bytes.toString('utf8');
        // The unsigned wargame ledger comes across byte for byte, or not at all.
        if (!Buffer.from(text, 'utf8').equals(read.bytes)) { left.push({ ledger: name, reason: 'its imported bytes are not plain text, so it was not carried' }); continue; }
        files.set(`${WARGAME_DIR}/${WARGAME_FILE}`, text);
      }
    }

    // The copy checks itself with today's verifier before anything is written: a ledger it cannot verify is never left behind.
    const trusted: KeyStatusLookup = (key) => (key.fingerprint === signer.fingerprint ? { state: 'active' } : { state: 'unknown' });
    const check = replayLedger(ledgerLinesOf(Buffer.from(files.get(`${LEDGER_DIR}/${LEDGER_FILE}`) ?? '')), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: trusted }));
    if (check.broken !== undefined || check.entries !== ledger.count || check.head !== ledger.head) throw new Error(`The copy was not made: its own product ledger does not verify (${check.broken?.reason ?? 'its head differs'}).`);

    // Every file is staged first; then the signed head mark is stored, under the key today's host computes for the copy's folder; only then is the
    // staging folder put in place (D-07). So a copy in place always has its mark on this computer, and a stop anywhere before leaves no staff project.
    const { staging, written } = await stageCopy(target, files);
    const key = ledgerHeadKey(target);
    let stored: string | undefined;
    if (ledger.count > 0) {
      const mark: LedgerHeadMark = { v: 1, count: ledger.count, head: ledger.head };
      const text = JSON.stringify(signPayload(signer, 'staff-ledger-head', mark, { now: () => signedAt }));
      await deps.secrets.store(key, text);
      stored = text;
    }
    // Outside the catch below: a stop here leaves the mark and the staging folder, and the next copy into this folder replaces both.
    await probe?.('mark-stored', target);
    try {
      await placeCopy(target, staging);
    } catch (error) {
      // The mark names a copy that is not in place: take it back, unless another run has stored its own since.
      if (stored !== undefined) await takeBackMark(deps, key, stored);
      throw error;
    }
    return { ok: true, destination: path.join(target, '.planning', 'staff'), written, carried, contested: contested.sort(), differs, left, notices: multiUserNoticeLines() };
  } finally {
    await project.close();
  }
}
