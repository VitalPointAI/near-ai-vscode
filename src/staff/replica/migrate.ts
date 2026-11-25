// Make This Staff Project Multi-User (MUS-06; D-28 to D-34, D-46): a single-machine staff project becomes a shared one without loss. Node I/O only;
// never imports vscode.
//
// The steps, in order, each one safe to run again (D-34):
//   verify       today's four ledgers are checked exactly as today's host checks them: products.jsonl with its signed head mark from SecretStorage,
//                decisions.jsonl, calculator.jsonl, and the unsigned wargame ledger. A broken ledger stops here with today's sentence and its way out
//                (Set Aside the Product Ledger, or Use This Branch's Ledger), before anything is written (D-30). So does a label the conversion needs
//                that the clearance the lead declares (options.leadClearance) does not cover: not-cleared-for-label, the D-19 sentence for each such
//                label with the products that carry it. With no clearance declared only org/Public is covered (D-68).
//   genesis      the shared project is made with this device's person as the staff lead (ReplicaProject.createSharedProject, which reuses a genesis
//                this device already wrote and pinned).
//   cells        the lead's declared clearance is written to the roster when it differs, then one cell per label in use (each product's label, and
//                org/Internal for the calculator and wargame ledgers) and the lead-only legacy cell when the product ledger or the decision log is
//                present (labelCells.ts; D-15, D-16, D-20). A cell this device already holds for the label is reused, so a label never gets two.
//   import       per D-20: the whole product ledger (its file and signed head mark) and the whole decision log go into the legacy cell; each label
//                cell holding products gets a products import of scope cell carrying only its products' lines, byte for byte, with the whole
//                ledger's head and count; the calculator and wargame ledgers go whole into the org/Internal cell. Nothing goes into the base cell. Each
//                import is looked up by ledger, scope and stream first and never sealed twice: a second seal is a second signed header at one seq.
//                A product any of whose lines names a product the cell's label does not cover (in meta.dependsOn) has none of its lines in the cell
//                import: a signed line cannot be edited, and the name must not reach a device cleared only for the cell (D-18, D-23; CR-02). It is
//                listed withheld, and the cell carries it as its live text (and a version when one can be made); the legacy cell keeps every line.
//   reconstruct  each product becomes a live text in the cell for its label (appendProductEntry) and, when its current text is known and its pins
//                can be named, one version whose text is the original's (proposeVersion; D-32). Every one of these entries cites its cell's products
//                import, which is how the projection tells an imported product. A pin to a product whose label its own does not cover leaves the
//                product with its live text only (pin-above-cell, D-18). The lead's role change is a roster entry and cites nothing. Approvals and
//                releases stay as their original signed entries inside the imports. A product file changed since an earlier run wrote its text
//                stops the conversion product-changed, before anything is written (MJ-09).
//   move-legacy  the four originals move to .planning/staff/legacy/ keeping their paths under .planning/staff; nothing is deleted, the head mark in
//                SecretStorage is left as it is, and a file already in the legacy folder is never written over (D-33).
//   projections  the product files are written from the fold and the decisions, calculator and wargame ledgers back from their imports at their
//                usual paths (projection.ts writeProjections). A product file whose text is not the fold's is never written over: the conversion
//                stops product-changed instead of finishing.
//   complete     project.json records that the conversion finished; a later run is refused already-shared.
//
// Not imported in Phase 31 (D-32): observations, and every file with no replica kind yet (registers, calculator records, gate reports, proposals,
// settings). They stay where they are, unchanged.
//
// The state of a conversion is read from disk each run, never kept in memory between runs: a step whose result is already in the store or on disk
// does nothing, so a run interrupted after any step and run again writes the same entries and reaches the same files.
import { createHash } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { dominates } from '../../domain/gate/dominance';
import { SCALE_PRESETS } from '../../domain/gate/labels';
import type { Label, ScaleTable } from '../../domain/gate/labels';
import { canonicalBytes } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { verifyPayload } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import { clientIdOf } from '../../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../domain/replica/doc';
import { openBlob } from '../../domain/replica/entry';
import { validateProjectData } from '../../domain/replica/kindSchemas/project';
import { DEFAULT_PRODUCT_LABEL, importScopeOf, labelFromText, labelText, sameLabel } from '../../domain/replica/productCells';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import { verifyEntry } from '../../domain/replica/verify';
import { replicaVersionHash } from '../../domain/replica/versions';
import type { Pin } from '../../domain/replica/versions';
import { STAFF_SECTION_IDS } from '../../domain/staff/doctrine';
import { LEDGER_PROBLEMS, parseLedgerHeadMark, productHash, replayLedger } from '../../domain/staff/ledger';
import type { LedgerHeadMark, LedgerReplay, ProductState } from '../../domain/staff/ledger';
import { CALC_LEDGER_FILE, replayCalcLedger } from '../../domain/staff/logistics';
import { LEGACY_DIR, REPLICA_PROJECT_FILE, multiUserNoticeLines } from '../../domain/staff/multiUser';
import { DECISION_LOG_FILE, replayPersonDecisions } from '../../domain/staff/personDecisions';
import { splitProductFile } from '../../domain/staff/products';
import { defaultStaffSettings, parseStaffSettings } from '../../domain/staff/profiles';
import { parseWargamePhase } from '../../domain/staff/wargame';
import { staffProductPath } from '../../domain/staff/writeLimits';
import { identityDir as identityDirOf } from '../../team/identity';
import { localKeyStatus } from '../../team/keyHistory';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from '../staffFiles';
import { LEDGER_DIR, LEDGER_FILE, LEDGER_HEAD_SECRET_PREFIX, STAFF_SETTINGS_FILE, USE_BRANCH_LEDGER_WAY_OUT, WARGAME_DIR, WARGAME_FILE, unreadableText } from '../staffHost';
import { NOT_CLEARED_TEXT, appendProductEntry, cellLabelTexts, ensureLabelCell, ensureLegacyCell, proposeVersion } from './labelCells';
import type { ProductWriteResult } from './labelCells';
import { clearedFor, updateMember } from './membership';
import type { Gate, SharedProjectHost } from './membership';
import { IMPORTED_PRODUCTS_LEDGER, PROJECTION_LEFT_REASONS, ledgerLinesOf, projectionEntry, writeProjections } from './projection';
import type { PassthroughLedger, ProjectionEntry, ProjectionInput, ProjectionWrite } from './projection';
import { ReplicaProject, projectFile } from './replicaProject';
import type { ReplicaProjectDeps } from './replicaProject';
import { ReplicaStore } from './store';

// ---- the steps and the ledgers ---------------------------------------------------------------------------------------------------------------------

export const MIGRATION_STEPS = ['verify', 'genesis', 'cells', 'import', 'reconstruct', 'move-legacy', 'projections', 'complete'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export type LegacyLedgerId = 'products' | 'decisions' | 'calculator' | 'wargame';

/** One of today's ledgers: where it is, how today's host verifies it, and what its legacy head is (31-RESEARCH, "Today's ledgers"). */
export interface LegacyLedger {
  readonly ledger: LegacyLedgerId;
  /** From the project root. */
  readonly path: string;
  /** Where migration moves it: the same path under .planning/staff, inside the legacy folder. */
  readonly legacyPath: string;
  /** How today's host verifies it. */
  readonly verifiedBy: 'replayLedger with the head mark' | 'replayPersonDecisions' | 'replayCalcLedger' | 'parseWargamePhase per line';
  /** last-entry-digest: entryDigest of the last entry (a signed, chained ledger); file-sha256: the sha256 of the file (unsigned, unchained). */
  readonly head: 'last-entry-digest' | 'file-sha256';
  /** Only the product ledger has a signed head mark in SecretStorage (D-46, Pitfall 5). */
  readonly marked: boolean;
}

const STAFF_ROOT = '.planning/staff/';
const legacyPathOf = (relative: string): string => `${LEGACY_DIR}/${relative.slice(STAFF_ROOT.length)}`;

export const LEGACY_LEDGERS: readonly LegacyLedger[] = [
  { ledger: 'products', path: `${LEDGER_DIR}/${LEDGER_FILE}`, legacyPath: legacyPathOf(`${LEDGER_DIR}/${LEDGER_FILE}`), verifiedBy: 'replayLedger with the head mark', head: 'last-entry-digest', marked: true },
  { ledger: 'decisions', path: `${LEDGER_DIR}/${DECISION_LOG_FILE}`, legacyPath: legacyPathOf(`${LEDGER_DIR}/${DECISION_LOG_FILE}`), verifiedBy: 'replayPersonDecisions', head: 'last-entry-digest', marked: false },
  { ledger: 'calculator', path: `${LEDGER_DIR}/${CALC_LEDGER_FILE}`, legacyPath: legacyPathOf(`${LEDGER_DIR}/${CALC_LEDGER_FILE}`), verifiedBy: 'replayCalcLedger', head: 'last-entry-digest', marked: false },
  { ledger: 'wargame', path: `${WARGAME_DIR}/${WARGAME_FILE}`, legacyPath: legacyPathOf(`${WARGAME_DIR}/${WARGAME_FILE}`), verifiedBy: 'parseWargamePhase per line', head: 'file-sha256', marked: false }
];

/** The ledgers a migrated project keeps at their usual paths, written back from their imports (the product ledger becomes the fold). */
export const PASSTHROUGH_LEDGERS: readonly PassthroughLedger[] = LEGACY_LEDGERS.filter((item) => item.ledger !== IMPORTED_PRODUCTS_LEDGER).map((item) => ({ ledger: item.ledger, path: item.path }));

// Today's way out of a broken product ledger, word for word (staffHost.ts SET_ASIDE_WAY_OUT and ledgerWayOut; a test pins it to the host's refusal).
const SET_ASIDE_WAY_OUT = 'A person can set it aside with SovAI: Staff: Set Aside the Product Ledger, which keeps the old file and starts a new one.';

function productLedgerWayOut(reason: string): string {
  return reason === LEDGER_PROBLEMS.truncated || reason === LEDGER_PROBLEMS.replaced ? `${USE_BRANCH_LEDGER_WAY_OUT} Otherwise: ${SET_ASIDE_WAY_OUT}` : SET_ASIDE_WAY_OUT;
}

/** Today's sentence for a broken ledger, as today's host refuses a write to it. */
function brokenText(ledger: LegacyLedgerId, broken: { seq: number; reason: string }): string {
  const from = `cannot be trusted from entry ${broken.seq + 1}: ${broken.reason}`;
  switch (ledger) {
    case 'products': return `The staff ledger ${from} Nothing was recorded, and nothing more can be until a person looks at it. ${productLedgerWayOut(broken.reason)}`;
    case 'decisions': return `The decision log ${from} Nothing was recorded.`;
    case 'calculator': return `The calculator ledger ${from} Nothing more can be recorded until a person looks at it.`;
    default: return `The wargame ledger ${from}`;
  }
}

/**
 * The label of the base cell, which carries the roster and project-level entries only (D-21). Products are no longer kept there: each goes into the
 * cell for its label (D-15, D-16), so a conversion no longer refuses a label for the base cell's sake.
 */
export const BASE_CELL_LABEL = 'org/Public';

/** Plain sentences for every way a conversion stops. A broken ledger's message is this sentence followed by today's sentence for that ledger. */
export const MIGRATION_REFUSALS = {
  'ledger-broken': 'This project was not made multi-user, because one of its ledgers does not verify. Nothing was written.',
  'already-shared': 'This project is already multi-user, so nothing was changed.',
  'no-staff-project': 'This folder holds no staff project (there is no .planning/staff folder), so there is nothing to make multi-user. Nothing was changed.',
  'ledger-changed': 'A ledger changed after this project started becoming multi-user, so the conversion stopped and nothing more was written. Ask your staff lead for help: the shared history already holds the ledger as it was.',
  'not-cleared-for-label': 'This project was not made multi-user, because some of its parts carry a label your declared clearance does not cover. Nothing was written.',
  'product-changed': 'A product file changed after this project started becoming multi-user, so the conversion stopped and nothing more was written. The file was left as it is, with the change in it. To finish, copy the file somewhere safe, put back the text it had when the conversion started (git or your backups hold it), and run Make This Staff Project Multi-User again. Your copy keeps the change.',
  'project-refused': 'The shared project could not be made, so the conversion stopped.'
} as const;
export type MigrationRefusal = keyof typeof MIGRATION_REFUSALS;
export interface MigrationRefused {
  refused: MigrationRefusal;
  message: string;
  ledger?: LegacyLedgerId;
  /** product-changed: the product file, from the project root. */
  file?: string;
  /** not-cleared-for-label: each label the declared clearance does not cover, as people read it. */
  labels?: string[];
}

const refuse = (reason: MigrationRefusal, message?: string, ledger?: LegacyLedgerId): MigrationRefused =>
  ({ refused: reason, message: message ?? MIGRATION_REFUSALS[reason], ...(ledger === undefined ? {} : { ledger }) });

/** The refusal for a product file whose text is no longer what the conversion read and recorded (MJ-09), naming the file. */
const productChanged = (file: string): MigrationRefused =>
  ({ refused: 'product-changed', message: `${MIGRATION_REFUSALS['product-changed']} The file: ${file}.`, file });

// The products a label refusal names before it says how many more there are.
const LABEL_LIST_LIMIT = 10;

// The calculator and wargame ledgers name no product; they are kept in the org/Internal cell (D-20), today's default product label.
const LEDGERS_LABEL = DEFAULT_PRODUCT_LABEL;
const LEDGERS_AT_LEDGERS_LABEL: readonly LegacyLedgerId[] = ['calculator', 'wargame'];
const LEDGERS_ONLY_TEXT = 'No product has that label: the calculator or wargame ledger of this project is kept at it.';
const ORG_PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };

/** A label a conversion needs: its text as people read it, the label when the scales know it, and the products that carry it (sorted). */
export interface NeededLabel { readonly text: string; readonly label?: Label; readonly products: string[] }

/** The labels a conversion of these ledgers needs, sorted by text: each product's label, and org/Internal when a calculator or wargame ledger is present. */
export function neededLabels(ledgers: readonly LegacyRead[], scales: ScaleTable = SCALE_PRESETS): NeededLabel[] {
  const out = new Map<string, { text: string; label?: Label; products: string[] }>();
  const add = (raw: string, product?: string): void => {
    const label = labelFromText(raw, scales);
    const text = label === undefined ? raw : labelText(label);
    const item = out.get(text) ?? { text, ...(label === undefined ? {} : { label }), products: [] };
    if (product !== undefined) item.products.push(product);
    out.set(text, item);
  };
  const replay = ledgers.find((item) => item.ledger === IMPORTED_PRODUCTS_LEDGER)?.replay;
  for (const [product, state] of replay?.products ?? []) add(state.meta.label, product);
  if (ledgers.some((item) => LEDGERS_AT_LEDGERS_LABEL.includes(item.ledger))) add(LEDGERS_LABEL);
  return [...out.values()].sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).map((item) => ({ ...item, products: [...item.products].sort() }));
}

/** The gate a conversion decides labels with: the scales given (the presets when none), no mappings, and the clock. */
function gateFor(scales: ScaleTable | undefined, now: (() => Date) | undefined): Gate {
  const table = scales ?? SCALE_PRESETS;
  return { scales: table, context: { scales: table, mappings: [], now: (now?.() ?? new Date()).getTime() } };
}

/** May a lead with this declared clearance (or none) convert a part carrying the label (D-19, D-68), by the rule labelCells.ts makes cells with? */
function covers(leadClearance: unknown, label: Label | undefined, gate: Gate): boolean {
  if (label === undefined) return false;
  if (leadClearance === undefined) return sameLabel(label, ORG_PUBLIC);
  return clearedFor(leadClearance, { cell: '', base: false, label, known: true }, false, gate);
}

/** The not-cleared-for-label refusal: the sentence, then for each label the D-19 sentence and the products carrying it (at most ten named). */
function notCleared(labels: readonly NeededLabel[]): MigrationRefused {
  const parts = labels.map((item) => {
    if (item.products.length === 0) return `${NOT_CLEARED_TEXT(item.text)} ${LEDGERS_ONLY_TEXT}`;
    const named = item.products.slice(0, LABEL_LIST_LIMIT).join(', ');
    const more = item.products.length > LABEL_LIST_LIMIT ? `, and ${item.products.length - LABEL_LIST_LIMIT} more` : '';
    return `${NOT_CLEARED_TEXT(item.text)} Products with that label: ${named}${more}.`;
  });
  return { refused: 'not-cleared-for-label', message: `${MIGRATION_REFUSALS['not-cleared-for-label']} ${parts.join(' ')}`, labels: labels.map((item) => item.text) };
}

export function isMigrationRefused(value: unknown): value is MigrationRefused {
  return isRecord(value) && typeof value.refused === 'string' && Object.hasOwn(MIGRATION_REFUSALS, value.refused) && typeof value.message === 'string';
}

// ---- verify ----------------------------------------------------------------------------------------------------------------------------------------

/** What verify needs: the SecretStorage that holds the product ledger's head mark, and the key status today's staff host verifies ledgers with. */
export interface VerifyDeps {
  secrets: ReplicaProjectDeps['secrets'];
  staffKeyStatus: () => Promise<KeyStatusLookup>;
}

/** One legacy ledger present and verified: where it was read, its bytes, its legacy head and count, and (products) the head mark's text. */
export interface LegacyRead {
  readonly ledger: LegacyLedgerId;
  /** The path it was read from: its usual path, or its legacy path once an interrupted conversion moved it there. */
  readonly path: string;
  readonly bytes: Buffer;
  readonly head: string;
  readonly count: number;
  readonly mark?: string;
  /** The product ledger's replay (products only). */
  readonly replay?: LedgerReplay;
}

/** The SecretStorage key of a project's product ledger head, exactly as today's host makes it (staffHost.ts headKey). */
export function ledgerHeadKey(root: string): string {
  return `${LEDGER_HEAD_SECRET_PREFIX}${createHash('sha256').update(path.resolve(root).split(path.sep).join('/')).digest('hex').slice(0, 32)}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const fileOf = (root: string, relative: string): string => path.join(root, ...relative.split('/'));

/** The readable wargame turns of a file, as today's host counts them (staffHost.ts wargameParse): a damaged line is left out. */
export function wargameCount(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { recordedBy?: unknown; at?: unknown };
      const parsed = parseWargamePhase(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'recordedBy' && key !== 'at')));
      if (parsed.ok && typeof value.recordedBy === 'string' && typeof value.at === 'string') count += 1;
    } catch { /* a damaged line is left out, as today */ }
  }
  return count;
}

type MarkRead = LedgerHeadMark | 'unverified' | undefined;

/** The head mark this computer recorded for the project, read and verified as today's host does (staffHost.ts readHead), with its raw text. */
async function readMark(root: string, deps: VerifyDeps, status: KeyStatusLookup): Promise<{ mark: MarkRead; text?: string }> {
  const text = await Promise.resolve(deps.secrets.get(ledgerHeadKey(root))).catch(() => undefined);
  if (text === undefined) return { mark: undefined };
  try {
    const verdict = verifyPayload(JSON.parse(text) as unknown, { purpose: 'staff-ledger-head', status });
    const mark = verdict.ok ? parseLedgerHeadMark(verdict.payload) : undefined;
    return { mark: mark ?? 'unverified', text };
  } catch {
    return { mark: 'unverified', text };
  }
}

/**
 * Verifies one ledger's bytes with today's verifier and key status, and gives its legacy head and count. For the product ledger `mark` is the head
 * this computer recorded (undefined when none), checked as today's host replay checks it. Exported for the test that re-verifies an import.
 */
export function verifyLegacyBytes(ledger: LegacyLedgerId, bytes: Buffer, status: KeyStatusLookup, mark?: MarkRead): { ok: true; head: string; count: number; replay?: LedgerReplay } | { ok: false; broken: { seq: number; reason: string } } {
  const lines = ledgerLinesOf(bytes);
  switch (ledger) {
    case 'products': {
      const verify = (envelope: unknown) => verifyPayload(envelope, { purpose: 'staff-ledger', status });
      if (mark === 'unverified') {
        const replay = replayLedger(lines, verify);
        return { ok: false, broken: replay.broken ?? { seq: 0, reason: LEDGER_PROBLEMS['head-unverified'] } };
      }
      const replay = replayLedger(lines, verify, mark);
      return replay.broken ? { ok: false, broken: replay.broken } : { ok: true, head: replay.head, count: replay.entries, replay };
    }
    case 'decisions': {
      const replay = replayPersonDecisions(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status }));
      return replay.broken ? { ok: false, broken: replay.broken } : { ok: true, head: replay.head, count: replay.entries };
    }
    case 'calculator': {
      const replay = replayCalcLedger(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }));
      return replay.broken ? { ok: false, broken: replay.broken } : { ok: true, head: replay.head, count: replay.entries };
    }
    default:
      return { ok: true, head: createHash('sha256').update(bytes).digest('hex'), count: wargameCount(bytes.toString('utf8')) };
  }
}

/** What verify is told: the clearance the lead declares (the command asks for it), the scales (the presets when absent) and the clock. */
export interface VerifyOptions {
  leadClearance?: unknown;
  scales?: ScaleTable;
  now?: () => Date;
}

/** Today's ledgers verified, and the labels a conversion of them needs, sorted (product labels, and org/Internal for the calculator or wargame). */
export interface VerifiedLedgers { ok: true; ledgers: LegacyRead[]; labels: string[] }

/**
 * Verifies today's four ledgers exactly as today's host does (D-30), writing nothing. Each is read from its usual path, or from its legacy path once
 * an interrupted conversion has moved it there. A ledger that is absent is skipped, except the product ledger when its head mark says it held entries
 * (today's host reads that as cut short or deleted). The first ledger that does not verify, or cannot be read whole, refuses with today's sentence.
 * A label the conversion needs that options.leadClearance does not cover (with none declared, anything but org/Public) is refused
 * not-cleared-for-label, with the D-19 sentence for each such label naming its products (D-19, D-21, D-68). A run resumed is given the same options.
 */
export async function verifyLegacyLedgers(root: string, deps: VerifyDeps, options: VerifyOptions = {}): Promise<VerifiedLedgers | MigrationRefused> {
  const status = await deps.staffKeyStatus();
  const ledgers: LegacyRead[] = [];
  for (const ledger of LEGACY_LEDGERS) {
    // Once moved, the original in the legacy folder is the ledger: a file at the usual path after that is a later one, which verify never reads.
    const at = (await exists(fileOf(root, ledger.legacyPath))) ? ledger.legacyPath : (await exists(fileOf(root, ledger.path))) ? ledger.path : undefined;
    const read = at === undefined ? { kind: 'missing' as const } : await readWhole(fileOf(root, at));
    const mark = ledger.marked ? await readMark(root, deps, status) : { mark: undefined };
    const broken = (value: { seq: number; reason: string }): MigrationRefused => refuse('ledger-broken', `${MIGRATION_REFUSALS['ledger-broken']} ${brokenText(ledger.ledger, value)}`, ledger.ledger);
    if (read.kind === 'unreadable') {
      if (ledger.ledger === 'products') return broken({ seq: 0, reason: `${LEDGER_PROBLEMS['file-unreadable']} (${read.reason}.)` });
      if (ledger.ledger === 'wargame') return refuse('ledger-broken', `${MIGRATION_REFUSALS['ledger-broken']} ${unreadableText(ledger.path, read.reason, 'Move it aside by hand (it is kept in git or your backups), then record the game again.')}`, ledger.ledger);
      return broken({ seq: 0, reason: read.reason });
    }
    const bytes = read.kind === 'text' ? read.bytes : Buffer.alloc(0);
    const verified = verifyLegacyBytes(ledger.ledger, bytes, status, mark.mark);
    if (!verified.ok) return broken(verified.broken);
    if (at === undefined) continue;
    ledgers.push({ ledger: ledger.ledger, path: at, bytes, head: verified.head, count: verified.count, ...(mark.text === undefined ? {} : { mark: mark.text }), ...(verified.replay ? { replay: verified.replay } : {}) });
  }
  // Each product goes into the cell for its label (D-15), which only a lead declared cleared for it may make (D-19): checked here, before anything is
  // written and before the command asks anything.
  const needed = neededLabels(ledgers, options.scales);
  const gate = gateFor(options.scales, options.now);
  const uncovered = needed.filter((item) => !covers(options.leadClearance, item.label, gate));
  if (uncovered.length > 0) return notCleared(uncovered);
  return { ok: true, ledgers, labels: needed.map((item) => item.text) };
}

// ---- the conversion --------------------------------------------------------------------------------------------------------------------------------

/** What a conversion needs: the replica project's dependencies (secret storage, global storage, clock), and the key status of today's staff host. */
export interface MigrationDeps extends ReplicaProjectDeps {
  staffKeyStatus: () => Promise<KeyStatusLookup>;
}

export interface MigrationOptions {
  /** Stop after this step (for the interruption tests, and for a host that runs the steps with progress between them). */
  stopAfter?: MigrationStep;
  /** The project's name in the genesis: the project folder's name when absent. */
  name?: string;
  /** The sha256 of the project's label map (D-07): the command passes it; the hash of an empty map when absent. */
  labelMapHash?: string;
  /** The lead's member id: derived from this device's writer id when absent. */
  leadMember?: string;
  /**
   * The clearance the staff lead declares for themselves (D-19; the command asks for it): written to the roster when it differs, and every label the
   * conversion needs must be one it covers. With none, only org/Public is covered (D-68). A resumed run is given the same clearance again.
   */
  leadClearance?: unknown;
  /** The label scales: SCALE_PRESETS when absent. */
  scales?: ScaleTable;
}

/** One whole import of a legacy ledger. */
export interface ImportedLedger { readonly ledger: LegacyLedgerId; readonly legacyHead: string; readonly count: number; readonly entry: string; readonly marked: boolean }
/** A products import of scope cell (D-20): the label cell it is in, its entry and how many of the ledger's lines it carries. */
export interface ScopedLedger { readonly ledger: LegacyLedgerId; readonly cell: string; readonly entry: string; readonly lines: number }
/** A cell the conversion uses: a label cell (label, as people read it) or the legacy cell (legacy, its labels), with the products it holds. */
export interface MigrationCell { readonly cell: string; readonly label?: string; readonly legacy?: string[]; readonly products: string[] }
/** A product given a live text but no version, and why. pin-above-cell: it pins a product whose label its own does not cover (D-18). */
export interface UnversionedProduct { readonly product: string; readonly reason: 'pin-above-cell' }
/**
 * A product whose ledger lines were left out of its cell's products import, and why. names-above-cell: a line names (in meta.dependsOn) a product whose
 * label the cell's does not cover, so sealing it there would put that name on every device cleared only for the cell (D-23; CR-02). The lines stay in
 * the lead-only legacy cell; the cell carries the product as its live text.
 */
export interface WithheldProduct { readonly product: string; readonly cell: string; readonly lines: number; readonly reason: 'names-above-cell' }

export interface MigrationResult {
  readonly ok: true;
  /** The last step done; `complete` when the whole conversion is done. */
  readonly completed: MigrationStep;
  readonly project?: string;
  /** The label cells, sorted by label, then the legacy cell. */
  readonly cells: MigrationCell[];
  /** One item per legacy ledger present: its whole import. */
  readonly imported: ImportedLedger[];
  /** The products import of each label cell holding products. */
  readonly scoped: ScopedLedger[];
  /** Products whose lines were left out of their cell's products import (CR-02), in the order of the cells, then by product. */
  readonly withheld: WithheldProduct[];
  /** Products reconstructed with a live text only for a reason the conversion names. */
  readonly unversioned: UnversionedProduct[];
  /** Every product of the imported ledger, and the ones reconstructed with a version (the others have a live text only; see the summary). */
  readonly products: string[];
  readonly versions: string[];
  /** The legacy files in .planning/staff/legacy/, by path from the project root. */
  readonly moved: string[];
  readonly projections?: ProjectionWrite;
  /** The notices every multi-user result shows (D-13). */
  readonly notices: string[];
}

/** project.json's record that the conversion finished, beside the anchor 31-18 writes. */
export interface MigrationMarker { readonly complete: true; readonly at: string; readonly imports: number }

async function readProjectJson(root: string): Promise<{ value: Record<string, unknown>; bytes: Buffer } | undefined> {
  const read = await readWhole(projectFile(root), 64 * 1024);
  if (read.kind !== 'text') return undefined;
  try {
    const value = JSON.parse(read.text) as unknown;
    return isRecord(value) ? { value, bytes: read.bytes } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether project.json records a finished conversion. */
export async function migrationComplete(root: string): Promise<boolean> {
  const found = await readProjectJson(root);
  return isRecord(found?.value.migration) && found?.value.migration.complete === true;
}

/** The profile and level of today's staff settings (staffHost.ts settings, without a team): the defaults when the settings say none. */
async function staffSettings(root: string): Promise<{ profile: string; level: string }> {
  const read = await readWhole(fileOf(root, STAFF_SETTINGS_FILE));
  if (read.kind === 'text') {
    try {
      const staff = (JSON.parse(read.text) as { staff?: unknown }).staff;
      if (staff !== undefined) {
        const parsed = parseStaffSettings(staff);
        if (parsed.ok) return { profile: parsed.value.profile, level: parsed.value.level };
      }
    } catch { /* an unreadable settings file falls back to the defaults, as today */ }
  }
  const defaults = defaultStaffSettings();
  return { profile: defaults.profile, level: defaults.level };
}

const PROJECT_NAME_FALLBACK = 'Staff project';

function projectName(root: string, given: string | undefined): string {
  const plain = [...(given ?? path.basename(path.resolve(root)))].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('');
  const name = plain.trim().slice(0, 120).trim();
  return name === '' ? PROJECT_NAME_FALLBACK : name;
}

// The largest piece of a product's text one doc.update carries: 60 000 UTF-16 units encode to at most 180 000 bytes, under MAX_UPDATE_BYTES (256 KiB).
const UPDATE_CHUNK = 60_000;

function chunksOf(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(text.length, index + UPDATE_CHUNK);
    // Never split a surrogate pair between two updates.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}

/** Products in dependency order (a product after those it depends on), ties and cycles by name, so pins name versions already reconstructed. */
function dependencyOrder(products: ReadonlyMap<string, ProductState>): string[] {
  const names = [...products.keys()].sort();
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < names.length) {
    const ready = names.find((name) => !done.has(name) && (products.get(name) as ProductState).meta.dependsOn.every((dep) => done.has(dep.product) || !products.has(dep.product) || dep.product === name));
    const next = ready ?? names.find((name) => !done.has(name)) as string;
    done.add(next);
    out.push(next);
  }
  return out;
}

interface OwnData { kind: string; data: Record<string, unknown> }

/** Every own entry of the given kinds, read once (findOwn's predicate collects; it never matches). */
async function ownEntries(project: ReplicaProject, kinds: readonly string[]): Promise<OwnData[]> {
  const out: OwnData[] = [];
  for (const kind of kinds) await project.findOwn(kind, (data) => { if (isRecord(data)) out.push({ kind, data }); return false; });
  return out;
}

class Stop extends Error {
  constructor(readonly refusal: MigrationRefused) { super(refusal.message); }
}

function appended(result: Awaited<ReturnType<ReplicaProject['appendOwn']>>): string {
  if ('ok' in result) return result.hash;
  throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${result.message}`));
}

/** Where the conversion keeps things: each label cell by label text, the legacy cell, and each product's label text. */
interface Placement {
  readonly cells: MigrationCell[];
  readonly byLabel: ReadonlyMap<string, string>;
  readonly legacy?: string;
  readonly labelOf: ReadonlyMap<string, string>;
}

/** A cell refusal turned into a conversion refusal. */
function cellRefused(made: { reason: string; message: string }, item?: NeededLabel): Stop {
  return new Stop(made.reason === 'not-cleared-for-label' && item !== undefined ? notCleared([item]) : refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${made.message}`));
}

/**
 * The cells step (D-15, D-16, D-19, D-20): the lead's declared clearance written to the roster when given and not already the same, then one label
 * cell per needed label (in label order) and the legacy cell for every product label when the product ledger or the decision log is present. Each is
 * reused when this device already holds one for that label (labelCells.ts), so a run interrupted after any of them makes no second one.
 */
async function makeCells(shared: SharedProjectHost, ledgers: readonly LegacyRead[], leadMember: string, options: MigrationOptions): Promise<Placement> {
  const { project } = shared;
  if (options.leadClearance !== undefined) {
    const { roster } = await project.state();
    const record = memberAt(roster.members, leadMember, roster.positions.length - 1);
    const same = record?.clearance !== undefined && canonicalBytes(record.clearance).equals(canonicalBytes(options.leadClearance));
    if (!same) {
      const changed = await updateMember(shared, { member: leadMember, clearance: options.leadClearance });
      if (!changed.ok) throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${changed.message}`));
    }
  }
  const needed = neededLabels(ledgers, options.scales);
  const cells: MigrationCell[] = [];
  const byLabel = new Map<string, string>();
  const labelOf = new Map<string, string>();
  for (const item of needed) {
    const made = await ensureLabelCell(shared, item.text);
    if (!made.ok) throw cellRefused(made, item);
    byLabel.set(item.text, made.cell);
    cells.push({ cell: made.cell, label: item.text, products: [...item.products] });
    for (const product of item.products) labelOf.set(product, item.text);
  }
  if (!ledgers.some((item) => item.ledger === IMPORTED_PRODUCTS_LEDGER || item.ledger === 'decisions')) return { cells, byLabel, labelOf };
  const labels = needed.filter((item) => item.products.length > 0).map((item) => item.text);
  const made = await ensureLegacyCell(shared, labels);
  if (!made.ok) throw cellRefused(made);
  cells.push({ cell: made.cell, legacy: labels, products: [...labelOf.keys()].sort() });
  return { cells, byLabel, legacy: made.cell, labelOf };
}

/** The product a ledger line names, or undefined for a line that is not a ledger entry. */
function productOfLine(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    const payload = isRecord(value) ? value.payload : undefined;
    return isRecord(payload) && typeof payload.product === 'string' ? payload.product : undefined;
  } catch {
    return undefined;
  }
}

/** Every product a ledger line names: its own, and each product of meta.dependsOn. Empty for a line that is not a ledger entry. */
function productsNamedBy(line: string): string[] {
  try {
    const value = JSON.parse(line) as unknown;
    const payload = isRecord(value) ? value.payload : undefined;
    if (!isRecord(payload)) return [];
    const named = typeof payload.product === 'string' ? [payload.product] : [];
    const dependsOn = isRecord(payload.meta) && Array.isArray(payload.meta.dependsOn) ? payload.meta.dependsOn : [];
    // Anything in dependsOn that is not a plain product name counts as naming something unknown, which no cell covers.
    for (const item of dependsOn) named.push(isRecord(item) && typeof item.product === 'string' ? item.product : '');
    return named;
  } catch {
    return [];
  }
}

/**
 * The lines of a product ledger naming one of the products, each byte for byte as in the file, joined with a newline and ending with one (D-20), except
 * every line of a product any of whose lines names a product `covered` refuses (CR-02): signed lines cannot be edited, so such a product's lines are
 * all left out (a part of a product's lines would not replay), and counted in `withheld` by product.
 */
function cellFileOf(bytes: Buffer, products: ReadonlySet<string>, covered: (product: string) => boolean): { file: Buffer; lines: number; withheld: Map<string, number> } {
  const ofCell = bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '' && products.has(productOfLine(line) ?? ''));
  const above = new Set<string>();
  for (const line of ofCell) if (!productsNamedBy(line).every(covered)) above.add(productOfLine(line) as string);
  const withheld = new Map<string, number>();
  const kept = ofCell.filter((line) => {
    const product = productOfLine(line) as string;
    if (!above.has(product)) return true;
    withheld.set(product, (withheld.get(product) ?? 0) + 1);
    return false;
  });
  return { file: Buffer.from(kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8'), lines: kept.length, withheld };
}

/**
 * Seals one project.import into a stream, unless one of that ledger and scope is already there: looked up by ledger, scope and stream before
 * anything is sealed (P-31-26). One found with another head or count means the ledger changed since: ledger-changed.
 */
async function sealImport(project: ReplicaProject, read: LegacyRead, stream: string, scope: 'whole' | 'cell', file: Buffer, lines?: number): Promise<string> {
  const found = (await project.findOwnAll('project.import', (data) => isRecord(data) && data.ledger === read.ledger && importScopeOf(data) === scope))
    .filter((item) => item.stream === stream);
  if (found.length > 0) {
    const data = found[0].data as { legacyHead: string; count: number };
    // The same ledger imported with another head: the ledger changed since; a second import would make two histories of one ledger.
    if (data.legacyHead !== read.head || data.count !== read.count) throw new Stop(refuse('ledger-changed', undefined, read.ledger));
    return found[0].hash;
  }
  const data: Record<string, unknown> = {
    ledger: read.ledger, legacyHead: read.head, count: read.count, file: file.toString('base64url'), scope,
    ...(scope === 'cell' ? { lines } : read.mark === undefined ? {} : { mark: read.mark })
  };
  const problem = validateProjectData('project.import', data, 'import');
  if (problem !== undefined) throw new Error(`The ${read.ledger} ledger was not imported: ${problem}.`);
  return appended(await project.appendOwn('project.import', data, { stream }));
}

/**
 * The import step (D-20): the product ledger and the decision log whole into the legacy cell, the calculator and wargame ledgers whole into the
 * org/Internal cell, and into each label cell holding products a products import of scope cell with only its products' lines, less the lines of a
 * product that names a product the cell's label does not cover (cellFileOf; CR-02), which are listed withheld. Nothing goes into the base cell.
 */
async function importLedgers(project: ReplicaProject, ledgers: readonly LegacyRead[], placement: Placement, gate: Gate): Promise<{ imported: ImportedLedger[]; scoped: ScopedLedger[]; withheld: WithheldProduct[] }> {
  const imported: ImportedLedger[] = [];
  const scoped: ScopedLedger[] = [];
  const withheld: WithheldProduct[] = [];
  for (const read of ledgers) {
    const stream = LEDGERS_AT_LEDGERS_LABEL.includes(read.ledger) ? placement.byLabel.get(LEDGERS_LABEL) : placement.legacy;
    if (stream === undefined) throw new Error(`The ${read.ledger} ledger has no part of the project to go into.`);
    const entry = await sealImport(project, read, stream, 'whole', read.bytes);
    imported.push({ ledger: read.ledger, legacyHead: read.head, count: read.count, entry, marked: read.mark !== undefined });
    if (read.ledger !== IMPORTED_PRODUCTS_LEDGER) continue;
    for (const cell of placement.cells) {
      if (cell.label === undefined || cell.products.length === 0) continue;
      // The same rule a pin across cells is decided with (D-18): a product the conversion holds whose label the cell's label covers.
      const covered = (product: string): boolean => labelCovers(cell.label, placement.labelOf.get(product), gate);
      const { file, lines, withheld: left } = cellFileOf(read.bytes, new Set(cell.products), covered);
      for (const [product, count] of [...left].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) withheld.push({ product, cell: cell.cell, lines: count, reason: 'names-above-cell' });
      scoped.push({ ledger: read.ledger, cell: cell.cell, entry: await sealImport(project, read, cell.cell, 'cell', file, lines), lines });
    }
  }
  return { imported, scoped, withheld };
}

/** One product as the reconstruct step reads it, before it writes anything: the body read from its file, the updates and the version that body gives. */
interface ProductPlan {
  readonly name: string;
  readonly state: ProductState;
  readonly body: string;
  readonly clientId: number;
  /** The doc after every update, for the version's snapshot. */
  readonly doc: ReturnType<typeof createLocalDoc>;
  readonly updates: string[];
  readonly pins: Pin[];
  /** The replica hash of the version this body gives; undefined when the body is not the current version's text or a pin cannot be named. */
  readonly replicaHash?: string;
}

/** Does the citing label cover the cited one (D-18): the same label always, otherwise by Phase 70 dominance, as the cell order decides a pin? */
function labelCovers(citing: string | undefined, cited: string | undefined, gate: Gate): boolean {
  if (citing === undefined || cited === undefined) return false;
  if (citing === cited) return true;
  const from = labelFromText(citing, gate.scales);
  const to = labelFromText(cited, gate.scales);
  if (from === undefined || to === undefined) return false;
  return dominates({ scale: from.scale, level: from.level, compartments: from.compartments, releasability: from.releasability }, to, gate.context);
}

/** The hash of a product entry written, or a stop with the refusal's sentence. */
function writtenHash(result: ProductWriteResult): string {
  if (result.ok) return result.hash;
  throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${result.message}`));
}

/**
 * The reconstruct step (D-32). The lead first gets the section roles the products need, so its device counts as each product's owner side (a staff lead
 * alone does not); that roster entry cites nothing. Then, per product, in dependency order, in the cell for its label (appendProductEntry): product.create
 * with the ledger's roles, a doc.client in the lead's slot, the text in doc.update pieces, and, when the file's body is exactly the current version's
 * text and every pin names a reconstructed version, version.propose with that text and its header in a sealed blob (proposeVersion). Each entry cites
 * its cell's products import; each is looked up before it is written. A product that pins a product whose label its own does not cover gets no version
 * and is listed unversioned with pin-above-cell (D-18), decided before anything is written.
 *
 * MJ-09: every product file is read and checked against what an earlier run already wrote for it before anything is written. The updates an earlier
 * run wrote use the product's client from clock 0, so they must be the first of the updates the body read now gives, byte for byte, and a version it
 * proposed must be the one this body gives. Otherwise the file changed since that run (the staff host refuses tool writes then, but not an editor), and
 * the step stops product-changed naming the file: a second update over the same clocks would fold into a mix of the old text and the new, and the
 * projections step would then write that over the edited file.
 */
async function reconstruct(shared: SharedProjectHost, root: string, replay: LedgerReplay, placement: Placement, cellImports: ReadonlyMap<string, string>, leadMember: string, gate: Gate): Promise<{ products: string[]; versions: string[]; unversioned: UnversionedProduct[] }> {
  const { project } = shared;
  const products = replay.products;
  const sections = [...new Set([...products.values()].map((state) => state.record.section))].sort((a, b) => STAFF_SECTION_IDS.indexOf(a) - STAFF_SECTION_IDS.indexOf(b));
  const { roster } = await project.state();
  const slot = deviceAt(roster.members, project.deviceWriter, roster.positions.length - 1)?.slot ?? 1;
  const own = await ownEntries(project, ['product.create', 'doc.client', 'doc.update', 'version.propose']);
  const has = (kind: string, match: (data: Record<string, unknown>) => boolean): boolean => own.some((item) => item.kind === kind && match(item.data));
  const counters = new Map([...products.keys()].sort().map((name, index) => [name, index] as const));

  // Read and check every product first, so a changed file stops the step before it writes anything.
  const replicaHashes = new Map<string, string>();
  const plans: ProductPlan[] = [];
  const unversioned: UnversionedProduct[] = [];
  for (const name of dependencyOrder(products)) {
    const state = products.get(name) as ProductState;
    const relative = staffProductPath(state.record.section, name);
    const read = await readWhole(fileOf(root, relative));
    const text = read.kind === 'text' ? read.text : '';
    const body = splitProductFile(text)?.body ?? text;
    const clientId = clientIdOf(slot, counters.get(name) as number);
    // The same client id and text give the same update bytes every run, so an update already written is found by its bytes.
    const doc = createLocalDoc(clientId);
    const updates = chunksOf(body).map((piece) => Buffer.from(localInsert(doc, docText(doc).length, piece)).toString('base64url'));
    const written = new Set(own.filter((item) => item.kind === 'doc.update' && item.data.product === name).map((item) => item.data.update));
    if (written.size > updates.length || !updates.slice(0, written.size).every((update) => written.has(update))) throw new Stop(productChanged(relative));
    // A pin to a product whose label this product's label does not cover would be refused by the fold (D-18): the product keeps its live text only.
    const ownLabel = placement.labelOf.get(name);
    const pinAbove = state.meta.dependsOn.some((dependency) => dependency.product !== name && products.has(dependency.product) && !labelCovers(ownLabel, placement.labelOf.get(dependency.product), gate));
    if (pinAbove) unversioned.push({ product: name, reason: 'pin-above-cell' });
    // Today's ledger keeps only the hash of each version; the text is known only while the file's body is still the current version's.
    const pins: Pin[] = [];
    for (const dependency of state.meta.dependsOn) {
      const pinned = replicaHashes.get(`${dependency.product}@${dependency.version}`);
      if (pinned === undefined) break;
      pins.push({ product: dependency.product, hash: pinned });
    }
    const replicaHash = !pinAbove && productHash(body, state.meta.dependsOn) === state.record.hash && pins.length === state.meta.dependsOn.length ? replicaVersionHash(body, pins) : undefined;
    // A version an earlier run proposed holds the text that run read: a body that no longer gives it has changed since (an empty file filled in, say).
    const proposed = own.filter((item) => item.kind === 'version.propose' && item.data.product === name).map((item) => item.data.hash);
    if (proposed.length > 0 && (replicaHash === undefined || !proposed.includes(replicaHash))) throw new Stop(productChanged(relative));
    if (replicaHash !== undefined) replicaHashes.set(`${name}@${state.record.version}`, replicaHash);
    plans.push({ name, state, body, clientId, doc, updates, pins, ...(replicaHash === undefined ? {} : { replicaHash }) });
  }

  const at = roster.positions.length - 1;
  const roles = memberAt(roster.members, leadMember, at)?.roles ?? [];
  const wanted = ['member', ...sections.map((section) => `section_lead:${section}`)];
  // A roster entry: it cites no import, because the base cell carries nothing of the legacy ledgers (D-15).
  if (!wanted.every((role) => roles.includes(role))) appended(await project.appendOwn('member.update', { member: leadMember, roles: [...new Set([...roles, ...wanted])] }));

  const versions: string[] = [];
  for (const plan of plans) {
    const { name, state, body, clientId, doc, pins, replicaHash } = plan;
    const { section, roles: productRoles } = state.record;
    const label = placement.labelOf.get(name) as string;
    const importEntry = cellImports.get(placement.byLabel.get(label) as string);
    if (importEntry === undefined) throw new Error(`The cell of ${name} holds no products import.`);
    const deps = [importEntry];
    if (!has('product.create', (data) => data.product === name)) {
      writtenHash(await appendProductEntry(shared, 'product.create', { product: name, section, roles: { ...productRoles }, title: name }, { label, deps }));
    }
    if (!has('doc.client', (data) => data.product === name && data.clientId === clientId)) {
      writtenHash(await appendProductEntry(shared, 'doc.client', { product: name, clientId, actor: { kind: 'person' } }, { deps }));
    }
    for (const update of plan.updates) {
      if (!has('doc.update', (data) => data.product === name && data.update === update)) writtenHash(await appendProductEntry(shared, 'doc.update', { product: name, update }, { deps }));
    }
    if (replicaHash === undefined) continue;
    if (has('version.propose', (data) => data.product === name && data.hash === replicaHash)) { versions.push(name); continue; }
    const header = { kind: state.meta.kind, label: state.meta.label, profile: state.meta.profile, level: state.meta.level };
    const proposedNow = await proposeVersion(shared, { product: name, text: body, header, pins, snapshot: snapshotOf(doc), deps });
    // A text larger than a version may hold stays a live text only.
    if (!proposedNow.ok && proposedNow.reason === 'version-too-large') continue;
    if (!proposedNow.ok) throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${proposedNow.message}`));
    versions.push(name);
  }
  return { products: [...products.keys()].sort(), versions: versions.sort(), unversioned };
}

/** The move-legacy step: rename each original into the legacy folder, only when it is at its usual path and the legacy path is free (D-33). */
async function moveLegacy(root: string, imported: readonly ImportedLedger[]): Promise<string[]> {
  const moved: string[] = [];
  for (const ledger of LEGACY_LEDGERS) {
    if (!imported.some((item) => item.ledger === ledger.ledger)) continue;
    const from = fileOf(root, ledger.path);
    const to = fileOf(root, ledger.legacyPath);
    if (!(await exists(to))) {
      if (!(await exists(from))) continue;
      await mkdir(path.dirname(to), { recursive: true });
      // Checked again just before the rename, which would replace a file another process put there.
      if (await exists(to)) continue;
      await rename(from, to);
    }
    moved.push(ledger.legacyPath);
  }
  return moved;
}

/** The store directory's dependencies, as ReplicaProject makes them, for reading the entries to project. */
async function storeDepsOf(deps: ReplicaProjectDeps) {
  const device = await ReplicaProject.localDevice(deps);
  const dir = deps.identityDir ?? identityDirOf(deps.globalStorageDir);
  return {
    secrets: deps.secrets,
    signer: () => Promise.resolve(device.signer),
    keyStatus: deps.keyStatus ?? (() => localKeyStatus(dir, deps.secrets)),
    ...(deps.now === undefined ? {} : { now: deps.now })
  };
}

/**
 * The projection input of an open shared project: the fold, every admitted entry as the projection reads it (verified again under the project's
 * context, which holds the blobs and keys), and the text of each proposed version this device can open (31-11: needed for versions with pins).
 */
export async function projectionInputOf(project: ReplicaProject, deps: ReplicaProjectDeps): Promise<ProjectionInput> {
  const { fold } = await project.state();
  const ctx = project.context();
  const store = await ReplicaStore.open(project.root, await storeDepsOf(deps));
  if (!(store instanceof ReplicaStore)) throw new Error(store.message);
  const admitted = new Set(fold.order);
  const entries = new Map<string, ProjectionEntry>();
  const texts = new Map<string, string>();
  for (const sealed of store.entries()) {
    const outcome = verifyEntry(sealed, ctx);
    if (outcome.status !== 'verified' || !admitted.has(outcome.entry.hash)) continue;
    entries.set(outcome.entry.hash, projectionEntry(outcome.entry));
    const data = outcome.entry.data;
    if (outcome.entry.body.kind !== 'version.propose' || !isRecord(data) || typeof data.textBlob !== 'string' || typeof data.hash !== 'string') continue;
    const blob = ctx.blobs(data.textBlob);
    const key = ctx.keys(outcome.entry.header.stream, outcome.entry.header.epoch);
    const opened = blob === undefined || key === undefined ? undefined : openBlob(key, outcome.entry.header.stream, outcome.entry.header.epoch, blob);
    try {
      const parsed = opened === undefined ? undefined : JSON.parse(opened.toString('utf8')) as unknown;
      if (isRecord(parsed) && typeof parsed.text === 'string') texts.set(data.hash, parsed.text);
    } catch { /* an unreadable version blob: the fold already refused that version */ }
  }
  // The label of each label cell this device holds, so the projection shows a product with its cell's label (D-17).
  return { fold, entries, roster: ctx.roster, texts, cellLabels: await cellLabelTexts(project) };
}

async function writeMarker(root: string, imports: number, at: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await readProjectJson(root);
    if (found === undefined) throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} The shared project's record in this folder cannot be read.`));
    if (isRecord(found.value.migration) && found.value.migration.complete === true) return;
    const marker: MigrationMarker = { complete: true, at, imports };
    if (await writeIfUnchanged(projectFile(root), snapshotOfBytes(found.bytes), `${JSON.stringify({ ...found.value, migration: marker }, null, 2)}\n`)) return;
  }
  throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} The shared project's record in this folder kept changing while it was being written.`));
}

/**
 * Make This Staff Project Multi-User: runs the steps in order (see the file comment), each one doing nothing when its result is already there, and
 * stops after `options.stopAfter` when given. Refused before anything is written when the folder holds no staff project, when the conversion already
 * finished, or when a ledger does not verify.
 */
export async function makeMultiUser(root: string, deps: MigrationDeps, options: MigrationOptions = {}): Promise<MigrationResult | MigrationRefused> {
  const absolute = path.resolve(root);
  const notices = multiUserNoticeLines();
  const result = (completed: MigrationStep, rest: Partial<Omit<MigrationResult, 'ok' | 'completed' | 'notices'>> = {}): MigrationResult =>
    ({ ok: true, completed, cells: [], imported: [], scoped: [], withheld: [], unversioned: [], products: [], versions: [], moved: [], notices, ...rest });

  if (!(await exists(path.join(absolute, '.planning', 'staff')))) return refuse('no-staff-project');
  if (await migrationComplete(absolute)) return refuse('already-shared');

  const verified = await verifyLegacyLedgers(absolute, deps, {
    ...(options.leadClearance === undefined ? {} : { leadClearance: options.leadClearance }),
    ...(options.scales === undefined ? {} : { scales: options.scales }),
    ...(deps.now === undefined ? {} : { now: deps.now })
  });
  if (!('ok' in verified)) return verified;
  if (options.stopAfter === 'verify') return result('verify');

  const device = await ReplicaProject.localDevice(deps);
  const leadMember = options.leadMember ?? `mbr-${device.writer.slice(0, 16)}`;
  const settings = await staffSettings(absolute);
  const made = await ReplicaProject.createSharedProject(absolute, deps, {
    name: projectName(absolute, options.name), profile: settings.profile, level: settings.level,
    labelMapHash: options.labelMapHash ?? createHash('sha256').update('').digest('hex'), lead: { member: leadMember }
  });
  if (!(made instanceof ReplicaProject)) return made.refused === 'already-shared' ? refuse('already-shared') : refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${made.message}`);
  const project = made;
  try {
    const lead = project.anchor.lead.member;
    if (options.stopAfter === 'genesis') return result('genesis', { project: project.projectId });

    const shared: SharedProjectHost = { project, deps, ...(options.scales === undefined ? {} : { scales: options.scales }) };
    const placement = await makeCells(shared, verified.ledgers, lead, options);
    const { cells } = placement;
    if (options.stopAfter === 'cells') return result('cells', { project: project.projectId, cells });

    const gate = gateFor(options.scales, deps.now);
    const { imported, scoped, withheld } = await importLedgers(project, verified.ledgers, placement, gate);
    if (options.stopAfter === 'import') return result('import', { project: project.projectId, cells, imported, scoped, withheld });

    const products = verified.ledgers.find((item) => item.ledger === IMPORTED_PRODUCTS_LEDGER);
    const cellImports = new Map(scoped.map((item) => [item.cell, item.entry] as const));
    const rebuilt = products?.replay !== undefined
      ? await reconstruct(shared, absolute, products.replay, placement, cellImports, lead, gate)
      : { products: [], versions: [], unversioned: [] };
    if (options.stopAfter === 'reconstruct') return result('reconstruct', { project: project.projectId, cells, imported, scoped, withheld, ...rebuilt });

    const moved = await moveLegacy(absolute, imported);
    if (options.stopAfter === 'move-legacy') return result('move-legacy', { project: project.projectId, cells, imported, scoped, withheld, ...rebuilt, moved });

    const projections = await writeProjections(absolute, await projectionInputOf(project, deps), PASSTHROUGH_LEDGERS);
    // A product file edited after reconstruct read it is left with the edit (MJ-09); the conversion does not finish over it, and a rerun names it.
    const edited = projections.left.find((item) => item.reason === PROJECTION_LEFT_REASONS['text-changed']);
    if (edited !== undefined) return productChanged(edited.path);
    if (options.stopAfter === 'projections') return result('projections', { project: project.projectId, cells, imported, scoped, withheld, ...rebuilt, moved, projections });

    await writeMarker(absolute, imported.length, (deps.now?.() ?? new Date()).toISOString());
    return result('complete', { project: project.projectId, cells, imported, scoped, withheld, ...rebuilt, moved, projections });
  } catch (error) {
    if (error instanceof Stop) return error.refusal;
    throw error;
  } finally {
    await project.close();
  }
}
