// Make This Staff Project Multi-User (MUS-06; D-28 to D-34, D-46): a single-machine staff project becomes a shared one without loss. Node I/O only;
// never imports vscode.
//
// The steps, in order, each one safe to run again (D-34):
//   verify       today's four ledgers are checked exactly as today's host checks them: products.jsonl with its signed head mark from SecretStorage,
//                decisions.jsonl, calculator.jsonl, and the unsigned wargame ledger. A broken ledger stops here with today's sentence and its way out
//                (Set Aside the Product Ledger, or Use This Branch's Ledger), before anything is written (D-30).
//   genesis      the shared project is made with this device's person as the staff lead (ReplicaProject.createSharedProject, which reuses a genesis
//                this device already wrote and pinned).
//   import       one project.import per legacy file present, carrying the legacy head (the last entry digest of a signed ledger, the sha256 of the
//                file for the wargame ledger), the entry count, the product ledger's signed head mark, and the whole file (D-31, D-46). An import of
//                the ledger is looked up first and never sealed twice: a second seal is a second signed header at one seq, a fork (Pitfall 4).
//   reconstruct  each product becomes a live text written by the lead's device and, when its current text is known and its pins can be named, one
//                version whose text is the original's (D-32). Every one of these entries cites the products import in its deps, which is how the
//                projection tells an imported product. Approvals and releases stay as their original signed entries inside the import.
//   move-legacy  the four originals move to .planning/staff/legacy/ keeping their paths under .planning/staff; nothing is deleted, the head mark in
//                SecretStorage is left as it is, and a file already in the legacy folder is never written over (D-33).
//   projections  the product files are written from the fold and the decisions, calculator and wargame ledgers back from their imports at their
//                usual paths (projection.ts writeProjections).
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
import { canonicalBytes } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { verifyPayload } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import { clientIdOf } from '../../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../domain/replica/doc';
import { SEALED_OVERHEAD, openBlob, sealBlob } from '../../domain/replica/entry';
import { MAX_STATE_BYTES } from '../../domain/replica/kindSchemas/doc';
import { validateProjectData } from '../../domain/replica/kindSchemas/project';
import type { RosterState } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
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
import { IMPORTED_PRODUCTS_LEDGER, ledgerLinesOf, projectionEntry, writeProjections } from './projection';
import type { PassthroughLedger, ProjectionEntry, ProjectionInput, ProjectionWrite } from './projection';
import { ReplicaProject, isProjectRefused, projectFile } from './replicaProject';
import type { ReplicaProjectDeps } from './replicaProject';
import { ReplicaStore } from './store';

// ---- the steps and the ledgers ---------------------------------------------------------------------------------------------------------------------

export const MIGRATION_STEPS = ['verify', 'genesis', 'import', 'reconstruct', 'move-legacy', 'projections', 'complete'] as const;
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
const SET_ASIDE_WAY_OUT = 'A person can set it aside with NEAR AI: Staff: Set Aside the Product Ledger, which keeps the old file and starts a new one.';

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

/** Plain sentences for every way a conversion stops. A broken ledger's message is this sentence followed by today's sentence for that ledger. */
export const MIGRATION_REFUSALS = {
  'ledger-broken': 'This project was not made multi-user, because one of its ledgers does not verify. Nothing was written.',
  'already-shared': 'This project is already multi-user, so nothing was changed.',
  'no-staff-project': 'This folder holds no staff project (there is no .planning/staff folder), so there is nothing to make multi-user. Nothing was changed.',
  'ledger-changed': 'A ledger changed after this project started becoming multi-user, so the conversion stopped and nothing more was written. Ask your staff lead for help: the shared history already holds the ledger as it was.',
  'project-refused': 'The shared project could not be made, so the conversion stopped.'
} as const;
export type MigrationRefusal = keyof typeof MIGRATION_REFUSALS;
export interface MigrationRefused { refused: MigrationRefusal; message: string; ledger?: LegacyLedgerId }

const refuse = (reason: MigrationRefusal, message?: string, ledger?: LegacyLedgerId): MigrationRefused =>
  ({ refused: reason, message: message ?? MIGRATION_REFUSALS[reason], ...(ledger === undefined ? {} : { ledger }) });

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

/**
 * Verifies today's four ledgers exactly as today's host does (D-30), writing nothing. Each is read from its usual path, or from its legacy path once
 * an interrupted conversion has moved it there. A ledger that is absent is skipped, except the product ledger when its head mark says it held entries
 * (today's host reads that as cut short or deleted). The first ledger that does not verify, or cannot be read whole, refuses with today's sentence.
 */
export async function verifyLegacyLedgers(root: string, deps: VerifyDeps): Promise<{ ok: true; ledgers: LegacyRead[] } | MigrationRefused> {
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
  return { ok: true, ledgers };
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
}

export interface ImportedLedger { readonly ledger: LegacyLedgerId; readonly legacyHead: string; readonly count: number; readonly entry: string; readonly marked: boolean }

export interface MigrationResult {
  readonly ok: true;
  /** The last step done; `complete` when the whole conversion is done. */
  readonly completed: MigrationStep;
  readonly project?: string;
  readonly imported: ImportedLedger[];
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

/** The import step: one project.import per legacy file present, each looked up before anything is sealed (P-31-26). */
async function importLedgers(project: ReplicaProject, ledgers: readonly LegacyRead[]): Promise<ImportedLedger[]> {
  const out: ImportedLedger[] = [];
  for (const read of ledgers) {
    const found = await project.findOwn('project.import', (data) => isRecord(data) && data.ledger === read.ledger);
    if (found !== undefined) {
      const data = found.data as { legacyHead: string; count: number; mark?: string };
      // The same ledger imported with another head: the ledger changed since; a second import would make two histories of one ledger.
      if (data.legacyHead !== read.head || data.count !== read.count) throw new Stop(refuse('ledger-changed', undefined, read.ledger));
      out.push({ ledger: read.ledger, legacyHead: read.head, count: read.count, entry: found.hash, marked: data.mark !== undefined });
      continue;
    }
    const data: Record<string, unknown> = { ledger: read.ledger, legacyHead: read.head, count: read.count, file: read.bytes.toString('base64url'), ...(read.mark === undefined ? {} : { mark: read.mark }) };
    const problem = validateProjectData('project.import', data, 'import');
    if (problem !== undefined) throw new Error(`The ${read.ledger} ledger was not imported: ${problem}.`);
    out.push({ ledger: read.ledger, legacyHead: read.head, count: read.count, entry: appended(await project.appendOwn('project.import', data)), marked: read.mark !== undefined });
  }
  return out;
}

/**
 * The reconstruct step (D-32). The lead first gets the section roles the products need, so its device counts as each product's owner side (a staff lead
 * alone does not). Then, per product, in dependency order: product.create with the ledger's roles, a doc.client in the lead's slot, the text in
 * doc.update pieces, and, when the file's body is exactly the current version's text and every pin names a reconstructed version, version.propose with
 * that text and its header in a sealed blob. Each entry cites the products import; each is looked up before it is written.
 */
async function reconstruct(project: ReplicaProject, root: string, replay: LedgerReplay, importEntry: string, leadMember: string): Promise<{ products: string[]; versions: string[] }> {
  const products = replay.products;
  const sections = [...new Set([...products.values()].map((state) => state.record.section))].sort((a, b) => STAFF_SECTION_IDS.indexOf(a) - STAFF_SECTION_IDS.indexOf(b));
  let { roster } = await project.state();
  const at = roster.positions.length - 1;
  const roles = memberAt(roster.members, leadMember, at)?.roles ?? [];
  const wanted = ['member', ...sections.map((section) => `section_lead:${section}`)];
  if (!wanted.every((role) => roles.includes(role))) {
    appended(await project.appendOwn('member.update', { member: leadMember, roles: [...new Set([...roles, ...wanted])] }, { deps: [importEntry] }));
    ({ roster } = await project.state());
  }
  const position = roster.positions.length - 1;
  const slot = deviceAt(roster.members, project.deviceWriter, position)?.slot ?? 1;
  const stream = project.projectId;
  const epoch = epochAt(roster.cells, stream, position);
  const key = epoch === undefined ? undefined : project.keys.epochKey(stream, epoch);
  if (epoch === undefined || key === undefined) throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} This computer does not hold the key of the project's base cell.`));

  const own = await ownEntries(project, ['product.create', 'doc.client', 'doc.update', 'version.propose']);
  const has = (kind: string, match: (data: Record<string, unknown>) => boolean): boolean => own.some((item) => item.kind === kind && match(item.data));
  const counters = new Map([...products.keys()].sort().map((name, index) => [name, index] as const));
  const replicaHashes = new Map<string, string>();
  const versions: string[] = [];
  const deps = { deps: [importEntry] };

  for (const name of dependencyOrder(products)) {
    const state = products.get(name) as ProductState;
    const { section, roles: productRoles, version, hash } = state.record;
    if (!has('product.create', (data) => data.product === name)) {
      appended(await project.appendOwn('product.create', { product: name, section, roles: { ...productRoles }, title: name }, deps));
    }
    const clientId = clientIdOf(slot, counters.get(name) as number);
    if (!has('doc.client', (data) => data.product === name && data.clientId === clientId)) {
      appended(await project.appendOwn('doc.client', { product: name, clientId, actor: { kind: 'person' } }, deps));
    }
    const read = await readWhole(fileOf(root, staffProductPath(section, name)));
    const text = read.kind === 'text' ? read.text : '';
    const body = splitProductFile(text)?.body ?? text;
    // The same client id and text give the same update bytes every run, so an update already written is found by its bytes.
    const doc = createLocalDoc(clientId);
    for (const piece of chunksOf(body)) {
      const update = Buffer.from(localInsert(doc, docText(doc).length, piece)).toString('base64url');
      if (!has('doc.update', (data) => data.product === name && data.update === update)) appended(await project.appendOwn('doc.update', { product: name, update }, deps));
    }
    // Today's ledger keeps only the hash of each version; the text is known only while the file's body is still the current version's.
    if (productHash(body, state.meta.dependsOn) !== hash) continue;
    const pins: Pin[] = [];
    for (const dependency of state.meta.dependsOn) {
      const pinned = replicaHashes.get(`${dependency.product}@${dependency.version}`);
      if (pinned === undefined) break;
      pins.push({ product: dependency.product, hash: pinned });
    }
    if (pins.length !== state.meta.dependsOn.length) continue;
    const replicaHash = replicaVersionHash(body, pins);
    replicaHashes.set(`${name}@${version}`, replicaHash);
    if (has('version.propose', (data) => data.product === name && data.hash === replicaHash)) { versions.push(name); continue; }
    const header = { kind: state.meta.kind, label: state.meta.label, profile: state.meta.profile, level: state.meta.level };
    const plain = canonicalBytes({ text: body, header });
    // A text larger than a version may hold stays a live text only.
    if (plain.length + SEALED_OVERHEAD > MAX_STATE_BYTES) continue;
    const blob = sealBlob(key, stream, epoch, plain);
    const stored = await project.ingestForeign([], [blob]);
    if (isProjectRefused(stored)) throw new Stop(refuse('project-refused', `${MIGRATION_REFUSALS['project-refused']} ${stored.message}`));
    appended(await project.appendOwn('version.propose', { product: name, hash: replicaHash, textBlob: blob.hash, snapshot: Buffer.from(snapshotOf(doc)).toString('base64url'), pins }, deps));
    versions.push(name);
  }
  return { products: [...products.keys()].sort(), versions: versions.sort() };
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
  return { fold, entries, roster: ctx.roster, texts };
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
    ({ ok: true, completed, imported: [], products: [], versions: [], moved: [], notices, ...rest });

  if (!(await exists(path.join(absolute, '.planning', 'staff')))) return refuse('no-staff-project');
  if (await migrationComplete(absolute)) return refuse('already-shared');

  const verified = await verifyLegacyLedgers(absolute, deps);
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

    const imported = await importLedgers(project, verified.ledgers);
    if (options.stopAfter === 'import') return result('import', { project: project.projectId, imported });

    const products = verified.ledgers.find((item) => item.ledger === IMPORTED_PRODUCTS_LEDGER);
    const productsImport = imported.find((item) => item.ledger === IMPORTED_PRODUCTS_LEDGER);
    const rebuilt = products?.replay !== undefined && productsImport !== undefined
      ? await reconstruct(project, absolute, products.replay, productsImport.entry, lead)
      : { products: [], versions: [] };
    if (options.stopAfter === 'reconstruct') return result('reconstruct', { project: project.projectId, imported, ...rebuilt });

    const moved = await moveLegacy(absolute, imported);
    if (options.stopAfter === 'move-legacy') return result('move-legacy', { project: project.projectId, imported, ...rebuilt, moved });

    const projections = await writeProjections(absolute, await projectionInputOf(project, deps), PASSTHROUGH_LEDGERS);
    if (options.stopAfter === 'projections') return result('projections', { project: project.projectId, imported, ...rebuilt, moved, projections });

    await writeMarker(absolute, imported.length, (deps.now?.() ?? new Date()).toISOString());
    return result('complete', { project: project.projectId, imported, ...rebuilt, moved, projections });
  } catch (error) {
    if (error instanceof Stop) return error.refusal;
    throw error;
  } finally {
    await project.close();
  }
}
