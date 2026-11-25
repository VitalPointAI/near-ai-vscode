// The projection adapter (plan 31-11; D-28, D-33): the fold of a multi-user project turned into exactly what today's single-machine staff host
// produces, so everything that reads staff state today keeps working. Pure over its input: no file, clock or secret I/O.
//
// How: today's reducers are reused, never changed (D-28). For each product the fold's versions family is turned into the ledger entries today's host
// would have written for the same history (a propose per version, a verdict, submit, decision, release, withdraw or supersede per accepted act), in the
// fold's total order, and those entries are replayed through ledger.ts apply(). The result is then checked against the fold's own release record of
// every version: when today's ledger would tell a different story (two concurrent verdicts that disagree, a contested decision, an act on a version
// today's ledger cannot reach), the product is shown with the fold's record for its newest version and marked tampered with a plain reason, so the
// projection never shows a step, an approval or a release the fold does not hold.
//
// What the fold does not keep, and how it is filled:
// - Ledger sequence numbers: history items are numbered by their place in the projected sequence, not by ledger lines. Compare history on what both
//   sides record (step, version, actor name, time).
// - Times: the fold's version records keep entry hashes, not times, so the caller passes each admitted entry's time in `entries` (projectionEntry).
// - The decision request's options, dissent and deadline: version.submit carries only the decision role, so a projected request has none, as today's
//   replay gives for a submit without a request.
// - Runs: an agent's act carries its run; a person's step takes the run of the open request or of the last step, as today's host does.
// - Version hashes: the fold names a version by replicaVersionHash, which pins dependencies by hash. Today's ledger pins by version number. A version
//   without pins has the same hash both ways; a version with pins gets today's hash from its text, which the caller passes in `texts` when it has
//   opened the version blob, and keeps the fold's hash otherwise.
//
// Imported products (plan 31-19; D-31, D-32): a project made multi-user from a single-machine one carries today's product ledger whole, in its
// project.import entry, and each product as a live text and (when its text is known) one version, every one of those entries citing the import in its
// deps. Older versions, gate verdicts, approvals and releases stay only as the original signed entries inside the import. So for an imported product
// whose shared history has nothing after the imported version, the projection is the replay of the imported ledger (verified at import by the staff
// lead, and checked here against the import's head, count and file hash), and the product carries IMPORTED_APPROVAL_TEXT for any approval it holds.
// Once acts are written on top (Phase 33), the fold's own projection above applies.
//
// Label cells (plan 32-10; D-17, D-20, D-22 revised, D-23): a conversion keeps each product in the cell for its label, the whole product ledger in the
// lead-only legacy cell, and in each label cell a products import of scope cell carrying only that cell's products' lines. So the imported history
// comes from the whole import when this machine holds it (importOf), and otherwise from each cell import it holds (scopedImportsOf), every line of it
// verified on its own (replayScopedImport). A member below a cell holds neither its import nor its products, and sees exactly the cells it holds. A
// product shows its cell's label (cellLabels), and a version whose label is not its cell's is marked tampered. A 0.4.35 preview project keeps its
// products in the base cell, which cellLabels never names, so it is shown as before.
//
// writeProjections, at the end of this file, is the one function here that touches files: it writes the product files and the passthrough ledgers
// (decisions, calculator, wargame) a migrated project keeps at their usual paths, through writeIfUnchanged.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fingerprintOf } from '../../domain/team/canonical';
import type { Actor } from '../../domain/replica/entry';
import type { FoldResult } from '../../domain/replica/fold';
import { DEFAULT_PRODUCT_LABEL } from '../../domain/replica/productCells';
import type { ProjectImport, ProjectOutput } from '../../domain/replica/projectFold';
import type { ProductTextOutput } from '../../domain/replica/textFold';
import type { RosterView } from '../../domain/replica/rosterView';
import type { VerifiedEntry } from '../../domain/replica/verify';
import { actorForTransition, personForTransition } from '../../domain/replica/versions';
import type { ProductVersions, VersionAct, VersionRecord, VersionView } from '../../domain/replica/versions';
import { STAFF_LEVELS, STAFF_PROFILE_IDS } from '../../domain/staff/doctrine';
import { eventsForTransition } from '../../domain/staff/events';
import type { StaffEvent } from '../../domain/staff/events';
import { apply, LEDGER_ENTRY_VERSION, LEDGER_GENESIS, LINE_CLOSING_STATES, parseLedgerEntry, productHash, projectHeader, replayLedger } from '../../domain/staff/ledger';
import type { HistoryItem, LedgerEntry, LedgerReplay, ProductMetaInput, ProductState } from '../../domain/staff/ledger';
import { PRODUCT_KINDS, renderProductHeader, splitProductFile } from '../../domain/staff/products';
import type { ProductDependency } from '../../domain/staff/products';
import type { ProductRecord, ReleaseEvent, StaffActor } from '../../domain/staff/release';
import { staffProductPath } from '../../domain/staff/writeLimits';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { verifyPayload } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from '../staffFiles';

/** What the projection needs to know about one admitted entry, by entry hash. */
export interface ProjectionEntry {
  readonly at: string;
  readonly writer: string;
  readonly member: string;
  readonly kind: string;
  readonly data: unknown;
  /** The entry's actor, for an agent's run. */
  readonly actor?: Actor;
  /** The hashes of the entries it depends on: a reconstructed product's entries cite their ledger's import here (31-19). */
  readonly deps?: readonly string[];
}

export interface ProjectionInput {
  readonly fold: FoldResult;
  readonly entries: ReadonlyMap<string, ProjectionEntry>;
  readonly roster: RosterView;
  /** The text of each version the caller has opened, by replica version hash. Needed only for versions with pins (see the file comment). */
  readonly texts?: ReadonlyMap<string, string>;
  /**
   * The label of each label cell the caller holds, by stream, as people read it (labelCells.ts cellLabelTexts). A product in one of them is shown
   * with that label and must carry it; the base cell (a 0.4.35 preview project's products) has no entry and is not checked.
   */
  readonly cellLabels?: ReadonlyMap<string, string>;
}

/** Why the projection cannot vouch for a product, in the words a person reads. */
export const PROJECTION_PROBLEMS = {
  disagrees: 'The shared history of this product holds steps that today\'s product ledger cannot show one after another (for example gate verdicts or decisions made at the same time that disagree), so this view cannot vouch for it.',
  unreadable: 'A step in the shared history of this product could not be turned into a product ledger entry (its header, a pin or its time is missing), so this view cannot vouch for it.',
  'label-mismatch': 'This product\'s label is not the label of the part of the project it is kept in, so this view cannot vouch for it.'
} as const;

/** The projection's view of one admitted entry. */
export function projectionEntry(entry: VerifiedEntry): ProjectionEntry {
  return { at: entry.body.at, writer: entry.header.writer, member: entry.member, kind: entry.body.kind, data: entry.data, actor: entry.body.actor, deps: entry.body.deps.map((dep) => dep.hash) };
}

// ---- One product -------------------------------------------------------------------------------------------------------------------------------

/** One projected ledger step: the entry, where it sits in the fold's order, the history it added and the product's state after it. */
interface ProjectedStep {
  readonly order: number;
  readonly entry: LedgerEntry;
  readonly added: readonly HistoryItem[];
  readonly after: ProductState;
}

interface ProductProjection {
  readonly stream: string;
  readonly state: ProjectedProductState;
  readonly steps: readonly ProjectedStep[];
  /** For a product shown from an imported ledger: how many entries that ledger holds (counted once in the replay). */
  readonly legacyEntries?: number;
}

interface Candidate {
  readonly order: number;
  readonly version: number;
  readonly entry: string;
  readonly act?: VersionAct;
}

const DECISION_KINDS: readonly string[] = ['version.decide', 'version.release', 'version.withdraw', 'version.supersede'];

class ProjectionProblem extends Error {
  constructor(readonly reason: keyof typeof PROJECTION_PROBLEMS) { super(reason); }
}

interface Context {
  readonly input: ProjectionInput;
  readonly order: ReadonlyMap<string, number>;
  /** `${product}@${replica hash}` to version number, over every product of the fold, for mapping pins back to numbers. */
  readonly numbers: ReadonlyMap<string, number>;
}

/** The device fingerprint today's ledger records for the device a replica writer id names: both come from the same Ed25519 key. */
function fingerprintFor(writer: string, roster: RosterView): string {
  const key = roster.deviceKey(writer);
  if (key === undefined) return writer;
  try {
    return fingerprintOf(Buffer.from(key.publicKey, 'base64url'));
  } catch {
    return writer;
  }
}

/** An actor as the fold presents it to release.ts, with a person's device named by its fingerprint as today's ledger does. */
function withFingerprint<A extends StaffActor | undefined>(actor: A, roster: RosterView): A {
  if (actor === undefined || actor.kind !== 'person') return actor;
  return { ...actor, deviceFingerprint: fingerprintFor(actor.deviceFingerprint, roster) } as A;
}

function dependsOnOf(view: VersionView, context: Context): ProductDependency[] {
  return view.pins.map((pin) => {
    const version = context.numbers.get(`${pin.product}@${pin.hash}`);
    if (version === undefined) throw new ProjectionProblem('unreadable');
    return { product: pin.product, version };
  });
}

/** Today's version hash of a fold version: the same text with its pins as product@version. */
function legacyHashOf(view: VersionView, dependsOn: readonly ProductDependency[], context: Context): string {
  if (view.pins.length === 0) return view.hash;
  const text = context.input.texts?.get(view.hash);
  // Without the text the hash with numbered pins cannot be known; the fold's hash stands, and today's header check reads the file as changed.
  return text === undefined ? view.hash : productHash(text, dependsOn);
}

function metaOf(view: VersionView, dependsOn: readonly ProductDependency[]): ProductMetaInput {
  const header = view.header;
  // Checked in full by parseLedgerEntry when the propose entry is read back; a header that does not fit fails there.
  return { kind: header.kind, label: header.label, profile: header.profile, level: header.level, dependsOn: [...dependsOn] } as ProductMetaInput;
}

function projectProduct(product: ProductVersions, context: Context): ProductProjection | undefined {
  if (product.versions.length === 0) return undefined;
  const roster = context.input.roster;
  const records = new Map<number, VersionRecord>(product.records.map((record) => [record.number, record]));
  const views = new Map<number, VersionView>(product.versions.map((view) => [view.number, view]));
  const byHash = new Map<string, VersionView>(product.versions.map((view) => [view.hash, view]));
  const refused = new Set(product.refusals.map((refusal) => refusal.entry));
  const orderOf = (entry: string): number => {
    const index = context.order.get(entry);
    if (index === undefined) throw new ProjectionProblem('unreadable');
    return index;
  };
  const atOf = (entry: string): string => {
    const found = context.input.entries.get(entry);
    if (found === undefined) throw new ProjectionProblem('unreadable');
    return found.at;
  };

  const hashes = new Map<string, string>();
  const metas = new Map<number, ProductMetaInput>();
  const steps: ProjectedStep[] = [];
  let state: ProductState | undefined;
  try {
    for (const view of product.versions) {
      const dependsOn = dependsOnOf(view, context);
      hashes.set(view.hash, legacyHashOf(view, dependsOn, context));
      metas.set(view.number, metaOf(view, dependsOn));
    }
    const legacy = (hash: string): string => hashes.get(hash) ?? hash;

    // Every proposal and every act the fold did not refuse, in the fold's total order.
    const candidates: Candidate[] = [];
    for (const view of product.versions) {
      candidates.push({ order: orderOf(view.entry), version: view.number, entry: view.entry });
      for (const act of records.get(view.number)?.acts ?? []) {
        if (refused.has(act.entry)) continue;
        // A decline settles nothing on its own: it is no step of today's machine.
        if (act.kind === 'version.decide' && act.data.outcome === 'decline') continue;
        candidates.push({ order: orderOf(act.entry), version: view.number, entry: act.entry, act });
      }
    }
    candidates.sort((a, b) => a.order - b.order);

    for (const candidate of candidates) {
      const record = records.get(candidate.version) as VersionRecord;
      const view = views.get(candidate.version) as VersionView;
      const at = atOf(candidate.entry);
      const lastRun = state?.request?.run ?? state?.history[state.history.length - 1]?.run ?? 'person';
      const base = { v: LEDGER_ENTRY_VERSION, seq: steps.length, prev: LEDGER_GENESIS, at, product: product.product, section: product.section };
      let draft: Record<string, unknown>;
      const act = candidate.act;
      if (act === undefined) {
        // A proposal: the owner side is presented as the owner seat, as the fold does (versions.ts actorForTransition).
        const proposer = context.input.entries.get(candidate.entry)?.actor;
        const opensLine = state === undefined || LINE_CLOSING_STATES.includes(state.record.state);
        const edit = state !== undefined && (state.record.state === 'guard-checked' || state.record.state === 'awaiting-decision');
        draft = {
          ...base,
          run: proposer?.kind === 'agent' ? proposer.run : lastRun,
          ...(opensLine ? { roles: { ...record.roles } } : {}),
          event: { type: edit ? 'edit' : 'propose', hash: legacy(view.hash) },
          actor: { kind: 'agent', member: record.roles.owner },
          meta: metas.get(view.number)
        };
      } else {
        const current = state as ProductState;
        const role = current.record.decisionFor ?? 'owner-side';
        const who = { actor: act.actor, member: act.member, writer: act.writer, roster: act.roster };
        const actor: StaffActor = act.actor.kind === 'person' && DECISION_KINDS.includes(act.kind)
          ? withFingerprint(personForTransition(act.member, role, act.writer, act.roster, roster), roster)
          : withFingerprint(actorForTransition(who, roster, record.roles, act.kind === 'version.submit'), roster);
        const data = act.data as Record<string, unknown>;
        let event: ReleaseEvent;
        switch (act.kind) {
          case 'version.verdict':
            event = { type: 'verdict', gate: data.gate as 'guard' | 'tradecraft', verdict: data.verdict as 'CLEARED', hash: legacy(view.hash), reasons: [...(data.reasons as string[])] };
            break;
          case 'version.submit':
            event = { type: 'submit', decisionFor: data.decisionFor as string };
            break;
          case 'version.decide':
            event = data.outcome === 'approve' ? { type: 'approve', hash: legacy(view.hash) } : { type: 'reject', reasons: [...(data.reasons as string[])] };
            break;
          case 'version.release':
            event = { type: 'release', hash: legacy(view.hash) };
            break;
          case 'version.withdraw':
            event = { type: 'withdraw', reason: data.reason as string };
            break;
          case 'version.supersede': {
            const newer = byHash.get(data.byHash as string);
            if (newer === undefined) throw new ProjectionProblem('disagrees');
            event = { type: 'supersede', byVersion: newer.number };
            break;
          }
          default:
            throw new ProjectionProblem('unreadable');
        }
        // A step on a version that is not the current one reaches today's ledger only as a step on an older, closed line.
        const line = candidate.version === current.record.version ? undefined : candidate.version;
        draft = { ...base, run: act.actor.kind === 'agent' ? act.actor.run : lastRun, ...(line === undefined ? {} : { line }), event, actor };
      }
      const entry = parseLedgerEntry(draft);
      if (entry === undefined) throw new ProjectionProblem('unreadable');
      const next = apply(state, entry);
      if (next === undefined || next.tampered !== undefined) throw new ProjectionProblem('disagrees');
      steps.push({ order: candidate.order, entry, added: next.history.slice(state?.history.length ?? 0), after: next });
      state = next;
    }
    const done = state as ProductState;
    if (!agreesWithFold(done, product)) throw new ProjectionProblem('disagrees');
    return { stream: product.stream, state: done, steps };
  } catch (error) {
    if (!(error instanceof ProjectionProblem)) throw error;
    return { stream: product.stream, state: fallback(product, state, hashes, metas, error.reason, roster, context.input.cellLabels?.get(product.stream)), steps: [] };
  }
}

/**
 * Today's ledger and the fold tell the same story when every version that heads a line in the projection has the state the fold gives that version,
 * and every version the projection replaced within its line (a revision before any decision closed it) is one the fold has not closed either.
 */
function agreesWithFold(state: ProductState, product: ProductVersions): boolean {
  const heads = new Map<number, ProductRecord>([[state.record.version, state.record]]);
  for (const line of state.older) heads.set(line.record.version, line.record);
  const newest = product.versions[product.versions.length - 1];
  if (state.record.version !== newest.number) return false;
  for (const record of product.records) {
    const head = heads.get(record.number);
    if (head !== undefined ? head.state !== record.release.state : LINE_CLOSING_STATES.includes(record.release.state)) return false;
  }
  return true;
}

/** A product the projection cannot vouch for: the fold's own record of its newest version, with no gate mark or request claimed, marked tampered. */
function fallback(product: ProductVersions, partial: ProductState | undefined, hashes: ReadonlyMap<string, string>, metas: ReadonlyMap<number, ProductMetaInput>, reason: keyof typeof PROJECTION_PROBLEMS, roster: RosterView, cellLabel?: string): ProductState {
  const newest = product.records[product.records.length - 1];
  const legacy = (hash: string): string => hashes.get(hash) ?? hash;
  const fold = newest.release;
  const record: ProductRecord = {
    ...fold,
    hash: legacy(fold.hash),
    ...(fold.guardCleared === undefined ? {} : { guardCleared: legacy(fold.guardCleared) }),
    ...(fold.tradecraftSignOff === undefined ? {} : { tradecraftSignOff: legacy(fold.tradecraftSignOff) }),
    ...(fold.approval === undefined ? {} : { approval: { hash: legacy(fold.approval.hash), by: withFingerprint(fold.approval.by, roster) } }),
    ...(fold.rejection === undefined ? {} : { rejection: { ...fold.rejection, by: withFingerprint(fold.rejection.by, roster) } }),
    ...(fold.withdrawal === undefined ? {} : { withdrawal: { ...fold.withdrawal, by: withFingerprint(fold.withdrawal.by, roster) } })
  };
  // A header that cannot be read still needs a meta of today's shape; the first value of each list stands in, the label is the cell's (its scale and
  // level, as today's ledger keeps a label) or today's default when the cell's label is not known here, and the product reads as tampered.
  const label = cellLabel === undefined ? DEFAULT_PRODUCT_LABEL : scaleLevel(cellLabel);
  const meta = metas.get(newest.number) ?? { kind: PRODUCT_KINDS[0], label, profile: STAFF_PROFILE_IDS[0], level: STAFF_LEVELS[0], dependsOn: [] } as ProductMetaInput;
  return { record, meta, history: partial?.history ?? [], approvedVersions: partial?.approvedVersions ?? [], older: partial?.older ?? [], tampered: PROJECTION_PROBLEMS[reason] };
}

// ---- The whole fold ----------------------------------------------------------------------------------------------------------------------------

function projectAll(input: ProjectionInput): Map<string, ProductProjection> {
  const products = (input.fold.families.versions as ProductVersions[] | undefined) ?? [];
  const order = new Map<string, number>(input.fold.order.map((hash, index) => [hash, index]));
  const numbers = new Map<string, number>();
  for (const product of products) for (const view of product.versions) numbers.set(`${product.product}@${view.hash}`, view.number);
  const context: Context = { input, order, numbers };
  const out = new Map<string, ProductProjection>();
  // The fold lists products by stream, then name. Today's ledger keys products by name alone; when two streams hold one name, the first stream's
  // product is shown, as it sorts first on every machine.
  for (const product of products) {
    if (out.has(product.product)) continue;
    const projected = projectProduct(product, context);
    if (projected !== undefined) out.set(product.product, projected);
  }
  overlayImported(input, products, out);
  checkCellLabels(input, out);
  return out;
}

/** scale/level of a label text ("org/Confidential//REL CAN" gives "org/Confidential"): what today's ledger keeps of a label. */
const scaleLevel = (text: string): string => text.split('//')[0];

/**
 * A product kept in a label cell must carry that cell's label (D-17): one whose shown label (its version's, or its imported ledger's) is not the cell's,
 * on scale and level, is marked tampered and sends no events. A stream cellLabels does not name (the base cell, a cell not held) is not checked.
 */
function checkCellLabels(input: ProjectionInput, out: Map<string, ProductProjection>): void {
  if (input.cellLabels === undefined) return;
  for (const [name, item] of out) {
    const cell = input.cellLabels.get(item.stream);
    if (cell === undefined || item.state.tampered !== undefined || scaleLevel(item.state.meta.label) === scaleLevel(cell)) continue;
    out.set(name, { ...item, state: { ...item.state, tampered: PROJECTION_PROBLEMS['label-mismatch'] }, steps: [] });
  }
}

// ---- Imported products (31-19) -----------------------------------------------------------------------------------------------------------------

/** The wording every approval of an imported product carries (D-32): the original signed entry is in the import, not a replica decision. */
export const IMPORTED_APPROVAL_TEXT = 'approved on this machine before the project became multi-user, verified at import by the staff lead';
/** The project.import ledger name of today's product ledger. */
export const IMPORTED_PRODUCTS_LEDGER = 'products';

/** How a product came from an imported ledger: the import entry, and the approval wording when the imported ledger holds an approval. */
export interface ImportedProduct {
  readonly ledger: string;
  readonly entry: string;
  readonly approval?: typeof IMPORTED_APPROVAL_TEXT;
}
/** Today's ProductState, with `imported` set on a product the projection shows from an imported ledger. */
export type ProjectedProductState = ProductState & { readonly imported?: ImportedProduct };

// The imported ledger was verified at import by the staff lead with this computer's key status then; here every key is taken as the lead found it, while
// each signature is still checked against its own key and the replay must end at the import's head and count.
const AS_VERIFIED_AT_IMPORT: KeyStatusLookup = () => ({ state: 'active' });

/** The legacy file an import carries, when its bytes match the file hash the fold lists. */
export function importedFile(record: ProjectImport, entries: ReadonlyMap<string, ProjectionEntry>): Buffer | undefined {
  const data = entries.get(record.entry)?.data;
  if (record.fileHash === undefined || !isRecord(data) || typeof data.file !== 'string') return undefined;
  const bytes = Buffer.from(data.file, 'base64url');
  return createHash('sha256').update(bytes).digest('hex') === record.fileHash ? bytes : undefined;
}

/** The lines of a ledger file as today's host reads them: one JSON value per non-blank line, a line that does not parse kept as its text. */
export function ledgerLinesOf(bytes: Buffer): unknown[] {
  return bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line) as unknown; } catch { return line; } });
}

/**
 * Today's LedgerReplay of an imported product ledger: the file's lines replayed through today's replayLedger, every signature checked, and the result
 * required to end at the head and count the import records and the file to match its hash. Undefined when any of that fails, so a projection never
 * shows a product from a file the import does not vouch for.
 */
export function projectImportedLedger(importRecord: ProjectImport, bytes: Buffer): LedgerReplay | undefined {
  if (importRecord.fileHash === undefined || createHash('sha256').update(bytes).digest('hex') !== importRecord.fileHash) return undefined;
  const replay = replayLedger(ledgerLinesOf(bytes), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: AS_VERIFIED_AT_IMPORT }));
  if (replay.broken !== undefined || replay.head !== importRecord.legacyHead || replay.entries !== importRecord.count) return undefined;
  return replay;
}

/**
 * The first whole import of a ledger in the fold (streams in fold order, imports as the project family lists them): scope whole, as every Phase 31
 * import reads. A cell import (D-20) carries only some of the ledger's lines and is never the ledger; see scopedImportsOf.
 */
export function importOf(fold: FoldResult, ledger: string): ProjectImport | undefined {
  for (const stream of (fold.families.project as ProjectOutput | undefined) ?? []) {
    const found = stream.imports.find((item) => item.ledger === ledger && item.scope !== 'cell');
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A cell import of a ledger (D-20) and the stream (the label cell) it is kept in. */
export interface ScopedImport { readonly stream: string; readonly record: ProjectImport }

/** Every cell import of a ledger in the fold, with its stream, in fold order: the ones this machine holds. */
export function scopedImportsOf(fold: FoldResult, ledger: string): ScopedImport[] {
  const out: ScopedImport[] = [];
  for (const stream of (fold.families.project as ProjectOutput | undefined) ?? []) {
    for (const record of stream.imports) if (record.ledger === ledger && record.scope === 'cell') out.push({ stream: stream.stream, record });
  }
  return out;
}

/**
 * Today's state of the products a cell import carries (D-20): its file must match the hash the fold lists and hold exactly `lines` lines, every line
 * must verify on its own (each is a signed ledger entry, every key taken as the lead found it at import) and read as a ledger entry, a person's step
 * must be signed by that person's own key as replayLedger requires, and the seqs must strictly rise. The lines are a part of the ledger, so there is no
 * prev chain to follow; each product's entries are replayed through today's apply() in order, which gives the same state as the whole ledger gives it.
 * The head is the whole ledger's, as the import records it. Undefined when any of that fails.
 */
export function replayScopedImport(record: ProjectImport, bytes: Buffer): LedgerReplay | undefined {
  if (record.scope !== 'cell' || record.lines === undefined) return undefined;
  if (record.fileHash === undefined || createHash('sha256').update(bytes).digest('hex') !== record.fileHash) return undefined;
  const lines = ledgerLinesOf(bytes);
  if (lines.length !== record.lines) return undefined;
  const products = new Map<string, ProductState>();
  let last = -1;
  for (const envelope of lines) {
    const verdict = verifyPayload(envelope, { purpose: 'staff-ledger', status: AS_VERIFIED_AT_IMPORT });
    if (!verdict.ok) return undefined;
    const entry = parseLedgerEntry(verdict.payload);
    if (entry === undefined || entry.seq <= last || entry.seq >= record.count) return undefined;
    if (entry.actor.kind === 'person' && entry.actor.deviceFingerprint !== verdict.signer.fingerprint) return undefined;
    const applied = apply(products.get(entry.product), entry);
    if (applied === undefined) return undefined;
    products.set(entry.product, applied);
    last = entry.seq;
  }
  return { products, entries: lines.length, head: record.legacyHead };
}

/**
 * Does the fold hold nothing for this product beyond what was reconstructed from an import of its ledger (at most one version, citing one of `entries`,
 * and no act)? A reconstructed version cites its cell's import, which may be another import of the ledger than the one the projection reads.
 */
function onlyImported(product: ProductVersions | undefined, imports: ReadonlySet<string>, entries: ReadonlyMap<string, ProjectionEntry>): boolean {
  if (product === undefined) return true;
  if (product.versions.length > 1 || product.records.some((record) => record.acts.length > 0)) return false;
  return product.versions.every((view) => entries.get(view.entry)?.deps?.some((dep) => imports.has(dep)) === true);
}

/** Shows each product of an imported ledger replay whose shared history holds nothing more than its reconstruction. */
function overlayReplay(input: ProjectionInput, products: readonly ProductVersions[], out: Map<string, ProductProjection>, record: ProjectImport, replay: LedgerReplay, stream: string, imports: ReadonlySet<string>): void {
  for (const [name, state] of replay.products) {
    const folded = products.find((product) => product.product === name);
    if (!onlyImported(folded, imports, input.entries)) continue;
    const imported: ImportedProduct = {
      ledger: record.ledger,
      entry: record.entry,
      ...(state.approvedVersions.length > 0 || state.record.approval !== undefined ? { approval: IMPORTED_APPROVAL_TEXT } : {})
    };
    const shown: ProjectedProductState = { ...state, imported };
    out.set(name, { stream: folded?.stream ?? stream, state: shown, steps: [], legacyEntries: replay.entries });
  }
}

/**
 * The imported history (31-19, D-20): from the whole product ledger when this machine holds it (the lead, in the legacy cell, or a Phase 31 import),
 * else from each cell import it holds, each showing only its own products.
 */
function overlayImported(input: ProjectionInput, products: readonly ProductVersions[], out: Map<string, ProductProjection>): void {
  const outputs = (input.fold.families.project as ProjectOutput | undefined) ?? [];
  const imports = new Set(outputs.flatMap((item) => item.imports.filter((found) => found.ledger === IMPORTED_PRODUCTS_LEDGER).map((found) => found.entry)));
  const record = importOf(input.fold, IMPORTED_PRODUCTS_LEDGER);
  if (record !== undefined) {
    const bytes = importedFile(record, input.entries);
    const replay = bytes === undefined ? undefined : projectImportedLedger(record, bytes);
    if (replay === undefined) return;
    const stream = outputs.find((item) => item.imports.some((found) => found.entry === record.entry))?.stream ?? '';
    overlayReplay(input, products, out, record, replay, stream, imports);
    return;
  }
  for (const scoped of scopedImportsOf(input.fold, IMPORTED_PRODUCTS_LEDGER)) {
    const bytes = importedFile(scoped.record, input.entries);
    const replay = bytes === undefined ? undefined : replayScopedImport(scoped.record, bytes);
    if (replay === undefined) continue;
    // Only this import's own entry vouches for its products: a version citing another cell's import is not shown from this one.
    overlayReplay(input, products, out, scoped.record, replay, scoped.stream, new Set([scoped.record.entry]));
  }
}

/** Every product of the fold as today's ProductState. */
export function projectProductStates(input: ProjectionInput): Map<string, ProjectedProductState> {
  const out = new Map<string, ProjectedProductState>();
  for (const [product, projected] of projectAll(input)) out.set(product, projected.state);
  return out;
}

/**
 * The fold as today's LedgerReplay, which everything reading staff state uses. `entries` counts the projected ledger steps (plus the entries of an
 * imported ledger once, when a product is shown from it), `head` is the fold's digest of the streams holding products, and the replay is never broken:
 * the fold has already refused, held or quarantined what it does not trust, and a product the projection cannot vouch for is marked tampered on its own.
 */
export function projectLedgerReplay(input: ProjectionInput): LedgerReplay {
  const projected = projectAll(input);
  const products = new Map<string, ProjectedProductState>();
  let entries = 0;
  let legacy = 0;
  for (const [product, item] of projected) {
    products.set(product, item.state);
    entries += item.steps.length;
    legacy = Math.max(legacy, item.legacyEntries ?? 0);
  }
  entries += legacy;
  return { products, entries, head: productsHead(input.fold, [...projected.values()].map((item) => item.stream)) };
}

/**
 * A product file as today's host writes it (staffHost.ts writeHeader): the header the state projects, then the body, joined with nothing between. The
 * body is the product's text from the fold's doc family. Today's header check (ledger.ts headerDisagreement) then compares the file with the same state.
 */
export function projectProductFile(state: ProductState, body: string): string {
  return `${renderProductHeader(projectHeader(state))}${body}`;
}

/**
 * The staff product events today's host sends for the same history (staffHost.ts transitionEvents): every projected step in the fold's order, each
 * history item it added through eventsForTransition, with the gate and verdict of a verdict and the decision role the product waits on after the step.
 * Each event carries its step's run (an agent's act carries one; a person's step takes the run of the open request or the last step, as today's host
 * does) and `run` only for a step the fold knows no run for. Each step's time comes from the fold. A product the projection cannot vouch for
 * (tampered) sends none, so no step the fold does not hold reaches the Staff Room.
 */
export function projectStaffEvents(input: ProjectionInput, run: string): StaffEvent[] {
  const steps = [...projectAll(input).values()].filter((item) => item.state.tampered === undefined).flatMap((item) => item.steps).sort((a, b) => a.order - b.order);
  const out: StaffEvent[] = [];
  for (const step of steps) {
    const event = step.entry.event;
    const detail = event.type === 'verdict' ? { gate: event.gate, verdict: event.verdict } : {};
    const decisionFor = step.after.record.decisionFor ?? (event.type === 'submit' ? event.decisionFor : undefined);
    // The step's own run, as today's host sends it; `run` stands in for a step the fold knows no run for (today's host writes `person` there).
    const stepRun = step.entry.run === 'person' ? run : step.entry.run;
    for (const item of step.added) {
      const stamped: HistoryItem = { ...item, run: stepRun };
      out.push(...eventsForTransition(stepRun, step.entry.at, stamped, { ...detail, ...(decisionFor ? { decisionFor } : {}) }));
    }
  }
  return out;
}

/** The digest of the streams that hold products: the fold's own digest when one stream does, a hash over the sorted pairs when several do. */
export function productsHead(fold: FoldResult, streams: Iterable<string>): string {
  const pairs = [...new Set(streams)].sort().map((stream) => [stream, fold.digests[stream] ?? LEDGER_GENESIS] as const);
  if (pairs.length === 0) return LEDGER_GENESIS;
  if (pairs.length === 1) return pairs[0][1];
  return createHash('sha256').update(pairs.map(([stream, digest]) => `${stream}:${digest}`).join('\n')).digest('hex');
}

// ---- Writing the projections (31-19; D-28, D-33) -----------------------------------------------------------------------------------------------

/** A ledger a migrated project keeps at its usual path, written back from its import: its project.import name and its path from the project root. */
export interface PassthroughLedger { readonly ledger: string; readonly path: string }

/** What writeProjections did, by path from the project root. `left`: a file it did not write over, with the reason. */
export interface ProjectionWrite {
  readonly written: string[];
  readonly unchanged: string[];
  readonly left: Array<{ path: string; reason: string }>;
}

/**
 * The live text of each product in the fold's doc family, by product name (the first stream holding the name, as for the products). A product whose
 * output is known not to be its whole text (`problem`) has no live text here: it is named in `incomplete` so its file is left alone, never written
 * over with part of its text.
 */
export function foldTexts(fold: FoldResult): { texts: Map<string, string>; incomplete: Map<string, string> } {
  const texts = new Map<string, string>();
  const incomplete = new Map<string, string>();
  for (const item of (fold.families.doc as ProductTextOutput[] | undefined) ?? []) {
    if (texts.has(item.product) || incomplete.has(item.product)) continue;
    if (item.problem !== undefined) incomplete.set(item.product, item.problem);
    else texts.set(item.product, item.text);
  }
  return { texts, incomplete };
}

/** Why writeProjections left a file as it was, in the words a person reads (the `reason` of a `left` item). */
export const PROJECTION_LEFT_REASONS = {
  unreadable: 'it cannot be read',
  'not-imported': 'it holds something other than the imported ledger, so it was left as it is',
  'text-changed': 'its text is not the text in the shared history (it was edited), so it was left as it is with the edit in it',
  raced: 'it changed while it was being written, so the change there stands',
  'text-incomplete': 'its text in the shared history could not be read whole on this computer, so it was left as it is rather than written with part of its text'
} as const;

/**
 * Writes `text` at `relative` unless the file already holds it. A file that holds something else is written over only when `keep` (given the file's
 * text) returns undefined; otherwise it is left and listed with the reason `keep` gives. The write is a compare-and-swap against the text `keep` saw.
 */
async function writeProjected(root: string, relative: string, text: string, keep: (current: string) => string | undefined, out: ProjectionWrite): Promise<void> {
  const file = path.join(root, ...relative.split('/'));
  const read = await readWhole(file);
  if (read.kind === 'unreadable') { out.left.push({ path: relative, reason: `${PROJECTION_LEFT_REASONS.unreadable}: ${read.reason}` }); return; }
  if (read.kind === 'text' && read.text === text) { out.unchanged.push(relative); return; }
  const kept = read.kind === 'text' ? keep(read.text) : undefined;
  if (kept !== undefined) { out.left.push({ path: relative, reason: kept }); return; }
  const written = await writeIfUnchanged(file, read.kind === 'text' ? snapshotOfBytes(read.bytes) : { exists: false }, text);
  if (written) out.written.push(relative);
  else out.left.push({ path: relative, reason: PROJECTION_LEFT_REASONS.raced });
}

/** A product file's body as the staff host and the conversion read it: what follows its header, or the whole text when it has none. */
export function productBodyOf(text: string): string {
  return splitProductFile(text)?.body ?? text;
}

/**
 * Writes the files of a multi-user project from its fold (D-28, D-33): each product file as today's host would write it for the projected state (the
 * header, then the product's live text from the fold), and each passthrough ledger (decisions, calculator, wargame) back at its usual path, byte for
 * byte as imported. Every write is a compare-and-swap (writeIfUnchanged) and a file that already holds the projected bytes is not touched. A passthrough
 * ledger whose path already holds other bytes is left as it is and listed, never written over; nothing is ever deleted. The events log is not written:
 * an imported product adds no step to it (its events were sent when the steps were made), and steps written on top arrive with Phase 33's live layer.
 *
 * A product file is written over only when its body is already the fold's text, so only its header changes (MJ-09): a body that differs holds an
 * edit the shared history does not, and is left as it is and listed with PROJECTION_LEFT_REASONS['text-changed']. (Phase 33's live projector,
 * liveProjection.ts, writes other people's text and compares with the text it last projected instead.)
 */
export async function writeProjections(root: string, input: ProjectionInput, passthrough: readonly PassthroughLedger[] = []): Promise<ProjectionWrite> {
  const out: ProjectionWrite = { written: [], unchanged: [], left: [] };
  const { texts, incomplete } = foldTexts(input.fold);
  for (const [product, item] of projectAll(input)) {
    if (incomplete.has(product)) { out.left.push({ path: staffProductPath(item.state.record.section, product), reason: PROJECTION_LEFT_REASONS['text-incomplete'] }); continue; }
    const body = texts.get(product);
    if (body === undefined) continue;
    // A product with no text in the fold and no file on disk stays without one, as today's host leaves a product file that is gone.
    if (body === '' && (await readWhole(path.join(root, ...staffProductPath(item.state.record.section, product).split('/')))).kind === 'missing') continue;
    await writeProjected(root, staffProductPath(item.state.record.section, product), projectProductFile(item.state, body), (current) => (productBodyOf(current) === body ? undefined : PROJECTION_LEFT_REASONS['text-changed']), out);
  }
  for (const ledger of passthrough) {
    const record = importOf(input.fold, ledger.ledger);
    const bytes = record === undefined ? undefined : importedFile(record, input.entries);
    if (bytes === undefined) continue;
    const text = bytes.toString('utf8');
    // Only bytes that read back exactly as text are written: the file must come back byte for byte, never re-encoded.
    if (!Buffer.from(text, 'utf8').equals(bytes)) { out.left.push({ path: ledger.path, reason: 'its imported bytes are not plain text, so it was not written back' }); continue; }
    await writeProjected(root, ledger.path, text, () => PROJECTION_LEFT_REASONS['not-imported'], out);
  }
  return out;
}
