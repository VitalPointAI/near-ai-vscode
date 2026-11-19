// The staff-products host (design 10, 4.1 to 4.5 and 6.2; WP-SHARED): the release state machine wired to real product files, the shared registers, the
// wargame ledger, guard-scan, the tradecraft lint, and the staff events. Node I/O only: this module never imports vscode, so the tests drive it directly.
//
// Where things live in the project:
// - products:        .planning/staff/products/<section>/<product>.md (a staff header, then the body), with gate reports beside them in guard/ and
//                    tradecraft/ (src/domain/staff/writeLimits.ts staffProductPath, the one layout every package uses)
// - J2 registers:    .planning/staff/products/j2/{source-register,pir-register,collection-plan}.json (intel.ts; the source register is the one
//                    the tradecraft lint reads)
// - the ledger:      .planning/staff/ledger/products.jsonl, one signed entry per line, chained (src/domain/staff/ledger.ts)
// - the events:      .planning/staff/ledger/events.jsonl, one staff event per line, for the Staff Room, Team Live and replay
// - the wargame:     .planning/staff/wargame/ledger.jsonl
// - proposals:       .planning/staff/proposals/<product>/ (design 10, 4.3)
// - guard settings:  .planning/.near-ai/staff-guard.json (the exercise box and real entities; agents must ask before writing there), and
//                    .planning/staff/real-entities.txt (more real entities, one per line, shared with the demo scenario import)
//
// Two kinds of caller reach this host and nothing else does. A team member, through the staff-products, guard-scan and lint tools (src/agent/staffTools.ts),
// which can only propose, give a gate verdict, submit, withdraw, read and write registers, record the wargame and mark a step. And a person, through
// the VS Code commands (src/services/staffCommands.ts), which alone can approve, reject, release or supersede, signed with this device's key. The state
// machine refuses a decision from any agent whatever this host is asked, so the two paths never meet.
import { registerPath } from '../domain/staff/intel';
import { GUARD_CONFIG_FILE } from '../domain/staff/realEntities';
import { readRealEntities } from './realEntities';
import { staffProductPath, staffWriteLimit, writeAllowedBy } from '../domain/staff/writeLimits';
import { mkdir, readFile, readdir, rename, appendFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { STAFF_SECTION_IDS } from '../domain/staff/doctrine';
import type { CrosswalkStep, StaffLevel, StaffProfileId, StaffSectionId } from '../domain/staff/doctrine';
import { eventsForTransition, STAFF_EVENT_TYPES } from '../domain/staff/events';
import type { CcirTriggeredEvent, DecisionOption, StaffEvent, StepEnteredEvent, WaitingEvent } from '../domain/staff/events';
import { guardScan, guardScanText } from '../domain/staff/guardScan';
import type { ExerciseBox, GuardConfig, GuardScanResult } from '../domain/staff/guardScan';
import {
  apply, entryDigest, FILE_CHANGE_ACTOR, gateReportPath, headerDisagreement, LEDGER_ENTRY_VERSION, LEDGER_GENESIS, LINE_CLOSING_STATES, MAX_LEDGER_ENTRIES,
  productHash, projectHeader, RELEASE_GUARD_SLUG, replayLedger, RESERVED_MEMBER_SLUGS, TAMPER_REASONS, TRADECRAFT_REVIEWER_SLUG, TRADECRAFT_SECTIONS
} from '../domain/staff/ledger';
import type { DecisionRequestInput, LedgerEntry, LedgerReplay, ProductMetaInput, ProductState, TamperReason } from '../domain/staff/ledger';
import { mayWrite, phaseFrom, proposalFolder, sharedProduct, TRANSITION_PRODUCT, writerIn, writerOf } from '../domain/staff/ownership';
import type { StaffPhase } from '../domain/staff/ownership';
import { isOneLine, STAFF_SLUG } from '../domain/staff/parse';
import { LABEL_PATTERN, parseProductHeader, PRODUCT_KINDS, renderProductHeader, splitProductFile, STAFF_MARKERS } from '../domain/staff/products';
import type { ProductDependency, ProductHeader, ProductKind } from '../domain/staff/products';
import { defaultStaffSettings, parseStaffSettings, stepName } from '../domain/staff/profiles';
import { copModel, currentSteps, decisionQueue, productRegistry, sharedRegisters, stepBoard } from '../domain/staff/readModels';
import type { FileCheck, ProductView } from '../domain/staff/readModels';
import { checkRow, overdueRfis, parseRegisterBody, registerSchema, renderRegisterBody, rfiChanges, writeRows } from '../domain/staff/registers';
import type { RegisterRow } from '../domain/staff/registers';
import { isNamedPerson, RELEASE_REFUSALS, transition } from '../domain/staff/release';
import type { PersonActor, ProductRoles, ReleaseEvent, StaffActor, StaffGate } from '../domain/staff/release';
import { lintTradecraft, sourcesFrom, tradecraftLintText } from '../domain/staff/tradecraftLint';
import type { TradecraftFinding } from '../domain/staff/tradecraftLint';
import { checkOrder, deriveFromWargame, parseWargamePhase, wargameTurnEvent } from '../domain/staff/wargame';
import type { WargameEntry } from '../domain/staff/wargame';
import { withFileLock } from '../services/stateMirrorLock';
import { writeFileAtomic } from '../team/teamFile';

export const LEDGER_DIR = '.planning/staff/ledger';
export const LEDGER_FILE = 'products.jsonl';
export const EVENTS_FILE = 'events.jsonl';
export const WARGAME_DIR = '.planning/staff/wargame';
export const WARGAME_FILE = 'ledger.jsonl';
export { GUARD_CONFIG_FILE, REAL_ENTITIES_FILE } from '../domain/staff/realEntities';
export const CALCULATOR_DIR = '.planning/staff/calculator';
/** The source register the tradecraft lint reads when a product carries no sources block of its own (intel-workbench writes it). */
export const SOURCES_FILE = registerPath('source-register');
const LEDGER_LOCK = 'ledger.lock';
const EVENTS_LOCK = 'events.lock';
const WARGAME_LOCK = 'wargame.lock';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS_READ = 20_000;

/** The J2 products the tradecraft gate reads beside the product it checks, by their conventional names (design 10, 3.2). */
export const J2_LINT_INPUTS = { pirs: 'pir-register', hvts: 'hvt-list', adversaryCoas: 'adversary-coa-set' } as const;

export function productPath(section: StaffSectionId, product: string): string {
  return staffProductPath(section, product);
}

/** The team a staff run works with, as the tools see it: its section, its members, and the member who leads (integrates) the section. */
export interface StaffTeamInfo {
  readonly slug: string;
  readonly section: StaffSectionId;
  readonly members: readonly string[];
  /** The member that reports to no other member: the section's integrator, who may submit its products. */
  readonly sectionLead: string;
  readonly profile?: StaffProfileId;
  readonly level?: StaffLevel;
}

/** Who calls: the member (undefined for the run's lead agent, which is not a member), the run, and the folder its files are in (its worktree, if any). */
export interface StaffCaller {
  readonly member?: string;
  readonly run: string;
  readonly root: string;
  readonly team: StaffTeamInfo;
}

export type StaffResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

export interface StaffHostOptions {
  /** The project root: the ledger, events and settings live here. */
  readonly root: string;
  /** This device's identity, which signs every ledger entry. */
  readonly signer: () => Promise<PayloadSigner>;
  /** The keys this computer trusts to have signed ledger entries. */
  readonly keyStatus: () => Promise<KeyStatusLookup>;
  readonly now?: () => number;
}

type EntryDraft = Omit<LedgerEntry, 'v' | 'seq' | 'prev' | 'at'>;

const ok = (text: string): StaffResult => ({ ok: true, text });
const refuse = (message: string): StaffResult => ({ ok: false, message });

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch { return undefined; }
}

/** A product file as read from disk: its parsed header (if it has one that parses), its body, and the version hash of both. */
export interface ProductFile { readonly exists: boolean; readonly header?: ProductHeader; readonly headerText: boolean; readonly body: string; readonly hash: string; readonly dependsOn: readonly ProductDependency[] }

/**
 * How a product file on disk stands against the ledger. `pending-edit`: the body changed while the product can still change, which the host records as an
 * edit. A tamper reason: a header that claims what the ledger does not hold, or a changed approved or released body. Undefined: they agree. A file whose
 * header is missing or does not parse is not tampering by itself (a member that rewrote the whole file dropped it); the host writes it again.
 */
export function fileDisagreement(state: ProductState, file: ProductFile): TamperReason | 'pending-edit' | undefined {
  const editable = state.record.state === 'draft' || state.record.state === 'guard-checked' || state.record.state === 'awaiting-decision';
  if (file.header) {
    const claimed = headerDisagreement(state, file.header, undefined);
    if (claimed !== undefined && claimed !== 'header-version') return claimed;
  }
  if (file.hash !== state.record.hash) return editable ? 'pending-edit' : 'locked-changed';
  return file.header && file.header.version !== state.record.version ? 'header-version' : undefined;
}

export class StaffHost {
  private readonly listeners = new Set<(event: StaffEvent) => void>();
  private readonly now: () => number;

  public constructor(private readonly options: StaffHostOptions) {
    this.now = options.now ?? Date.now;
  }

  public get root(): string { return this.options.root; }

  /** Called with every staff event this host writes. Returns the function that stops it. */
  public onEvent(listener: (event: StaffEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ---- The ledger ---------------------------------------------------------------------------------------------------------------------------

  private ledgerDir(): string { return path.join(this.options.root, LEDGER_DIR); }

  private async ledgerLines(): Promise<unknown[]> {
    const text = await readText(path.join(this.ledgerDir(), LEDGER_FILE));
    if (text === undefined) return [];
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line) as unknown; } catch { return line; } });
  }

  /** The ledger replayed, every signature checked against the keys this computer trusts. */
  public async replay(): Promise<LedgerReplay> {
    const status = await this.options.keyStatus();
    return replayLedger(await this.ledgerLines(), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }));
  }

  /**
   * Appends entries under the ledger lock: `decide` sees the ledger as it is now and returns the entries to write (or a refusal). Each entry is checked
   * against the state machine before anything is written, signed, chained, and written in one append, so a refusal or a failure writes nothing.
   */
  private async append(decide: (replay: LedgerReplay) => Promise<EntryDraft[] | StaffResult> | EntryDraft[] | StaffResult): Promise<{ replay: LedgerReplay; written: LedgerEntry[] } | StaffResult> {
    await mkdir(this.ledgerDir(), { recursive: true });
    return withFileLock(this.ledgerDir(), LEDGER_LOCK, async () => {
      const replay = await this.replay();
      if (replay.broken) return refuse(`The staff ledger cannot be trusted from entry ${replay.broken.seq + 1}: ${replay.broken.reason} Nothing more can be recorded until a person looks at it (NEAR AI: Staff: Set Aside the Product Ledger keeps the old file and starts a new one).`);
      const drafts = await decide(replay);
      if (!Array.isArray(drafts)) return drafts;
      if (replay.entries + drafts.length > MAX_LEDGER_ENTRIES) return refuse('The staff ledger is full. A person can set it aside and start a new one.');
      const signer = await this.options.signer();
      const at = isoOf(this.now());
      const products = new Map(replay.products);
      const written: LedgerEntry[] = [];
      const lines: string[] = [];
      let head = replay.head;
      for (const draft of drafts) {
        const entry: LedgerEntry = { v: LEDGER_ENTRY_VERSION, seq: replay.entries + written.length, prev: head, at, ...draft };
        const applied = apply(products.get(entry.product), entry);
        if (!applied) {
          // The state machine's own sentence says why, when it has one.
          const current = products.get(entry.product);
          const why = current && entry.roles === undefined && entry.line === undefined ? transition(current.record, entry.event, entry.actor) : undefined;
          return refuse(`${why && !why.ok ? why.message : 'That step does not fit the product\'s state.'} Nothing was recorded.`);
        }
        if (entry.actor.kind === 'person' && entry.actor.deviceFingerprint !== signer.fingerprint) return refuse(RELEASE_REFUSALS['unnamed-person']);
        products.set(entry.product, applied);
        const envelope = signPayload(signer, 'staff-ledger', entry, { now: () => new Date(Date.parse(at)) });
        head = entryDigest(envelope);
        lines.push(JSON.stringify(envelope));
        written.push(entry);
      }
      if (lines.length) await appendFile(path.join(this.ledgerDir(), LEDGER_FILE), `${lines.join('\n')}\n`, 'utf8');
      return { replay: { products, entries: replay.entries + written.length, head }, written };
    });
  }

  /**
   * A person's way out of a broken ledger: the file is renamed beside itself (kept, never deleted) and a new one starts. Products whose headers claim a
   * state past draft then read as tampered until their owners write them again.
   */
  public async setAsideLedger(): Promise<string | undefined> {
    const file = path.join(this.ledgerDir(), LEDGER_FILE);
    if (await readText(file) === undefined) return undefined;
    const kept = path.join(this.ledgerDir(), `products.set-aside-${isoOf(this.now()).replace(/[:.]/g, '-')}.jsonl`);
    await withFileLock(this.ledgerDir(), LEDGER_LOCK, () => rename(file, kept));
    return path.relative(this.options.root, kept).split(path.sep).join('/');
  }

  // ---- Events ---------------------------------------------------------------------------------------------------------------------------------

  /** Every staff event recorded for this project, oldest first (the last MAX_EVENTS_READ). */
  public async events(): Promise<StaffEvent[]> {
    const text = await readText(path.join(this.ledgerDir(), EVENTS_FILE));
    if (text === undefined) return [];
    const out: StaffEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as StaffEvent;
        if (value && typeof value === 'object' && (STAFF_EVENT_TYPES as readonly string[]).includes(value.type)) out.push(value);
      } catch { /* a damaged line is skipped; the ledger, not the event log, is the record */ }
    }
    return out.slice(-MAX_EVENTS_READ);
  }

  /** Writes events to the project's event log and sends them to every listener, each once. */
  public async emit(events: readonly StaffEvent[]): Promise<void> {
    if (!events.length) return;
    await mkdir(this.ledgerDir(), { recursive: true });
    await withFileLock(this.ledgerDir(), EVENTS_LOCK, () => appendFile(path.join(this.ledgerDir(), EVENTS_FILE), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'));
    for (const event of events) for (const listener of this.listeners) { try { listener(event); } catch { /* a listener never stops the record */ } }
  }

  /** Events other parts of the extension observe (lanes, merges, nested teams, COP layers) enter the same log through here. */
  public async record(event: StaffEvent): Promise<void> {
    const allowed: readonly string[] = ['staff.lane.started', 'staff.lane.finished', 'staff.merge.started', 'staff.merge.conflict', 'staff.merge.resolved', 'staff.team.nested', 'staff.cop.updated'];
    if (!allowed.includes(event.type)) throw new Error(`${event.type} is written by the staff-products host itself.`);
    await this.emit([event]);
  }

  private transitionEvents(written: readonly LedgerEntry[], replay: LedgerReplay): StaffEvent[] {
    const out: StaffEvent[] = [];
    for (const entry of written) {
      const state = replay.products.get(entry.product);
      if (!state) continue;
      const items = state.history.filter((item) => item.seq === entry.seq);
      for (const item of items) {
        const detail = entry.event.type === 'verdict' ? { gate: entry.event.gate, verdict: entry.event.verdict } : {};
        const decisionFor = state.record.decisionFor ?? (entry.event.type === 'submit' ? entry.event.decisionFor : undefined);
        out.push(...eventsForTransition(entry.run, entry.at, item, { ...detail, ...(decisionFor ? { decisionFor } : {}) }));
      }
    }
    return out;
  }

  // ---- Product files ---------------------------------------------------------------------------------------------------------------------------

  private async readProduct(root: string, section: StaffSectionId, product: string, fallbackDepends: readonly ProductDependency[] = []): Promise<ProductFile> {
    const text = await readText(path.join(root, productPath(section, product)));
    if (text === undefined) return { exists: false, headerText: false, body: '', hash: productHash('', fallbackDepends), dependsOn: fallbackDepends };
    const parts = splitProductFile(text);
    const body = parts ? parts.body : text;
    const parsed = parts ? parseProductHeader(parts.header) : undefined;
    const header = parsed?.ok ? parsed.value : undefined;
    const dependsOn = header ? header.dependsOn : fallbackDepends;
    return { exists: true, ...(header ? { header } : {}), headerText: parts !== undefined, body, hash: productHash(body, dependsOn), dependsOn };
  }

  private async writeHeader(root: string, state: ProductState, body: string): Promise<void> {
    await writeFileAtomic(path.join(root, productPath(state.record.section, state.record.product)), `${renderProductHeader(projectHeader(state))}${body}`);
  }

  /**
   * Compares the product file with the ledger before anything acts on it. A body that changed while the product can still change is an edit: it is
   * recorded (actor `file-change`) as a new version, and the header is written again. A changed approved or released body, or a header that claims what
   * the ledger does not hold, is tampering: it is reported and nothing is recorded.
   */
  private async refresh(root: string, product: string, run: string, record = true): Promise<{ replay: LedgerReplay; file?: ProductFile; disagreement?: TamperReason; pendingEdit?: boolean }> {
    let replay = await this.replay();
    const state = replay.products.get(product);
    if (!state || state.tampered) return { replay };
    let file = await this.readProduct(root, state.record.section, product, state.meta.dependsOn);
    if (!file.exists) return { replay, file };
    const found = fileDisagreement(state, file);
    if (found !== 'pending-edit') return { replay, file, ...(found ? { disagreement: found } : {}) };
    // A read (status, guard-scan, the lint) records nothing: it reports the change, and the next write records it.
    if (!record) return { replay, file, pendingEdit: true };
    const result = await this.append(() => [{ run, product, section: state.record.section, event: { type: 'edit', hash: file.hash }, actor: FILE_CHANGE_ACTOR, meta: { ...state.meta, dependsOn: [...file.dependsOn] } }]);
    if (!('replay' in result)) return { replay, file };
    replay = result.replay;
    await this.emit(this.transitionEvents(result.written, replay));
    const updated = replay.products.get(product)!;
    await this.writeHeader(root, updated, file.body);
    file = await this.readProduct(root, updated.record.section, product, updated.meta.dependsOn);
    return { replay, file };
  }

  private async settings(team?: StaffTeamInfo): Promise<{ profile: StaffProfileId; level: StaffLevel }> {
    const text = await readText(path.join(this.options.root, '.planning', '.near-ai', 'project.json'));
    if (text !== undefined) {
      try {
        const staff = (JSON.parse(text) as { staff?: unknown }).staff;
        if (staff !== undefined) {
          const parsed = parseStaffSettings(staff);
          if (parsed.ok) return { profile: parsed.value.profile, level: parsed.value.level };
        }
      } catch { /* an unreadable project file falls back to the team's block and the defaults */ }
    }
    const defaults = defaultStaffSettings();
    return { profile: team?.profile ?? defaults.profile, level: team?.level ?? defaults.level };
  }

  /** The guard settings a person keeps for the project: the exercise box and the real-entity list. Missing or unreadable means none. */
  public async guardConfig(): Promise<GuardConfig> {
    const text = await readText(path.join(this.options.root, GUARD_CONFIG_FILE));
    let box: ExerciseBox | undefined;
    if (text !== undefined) {
      try {
        const value = JSON.parse(text) as { exerciseBox?: unknown };
        if (Array.isArray(value.exerciseBox) && value.exerciseBox.length >= 3 && value.exerciseBox.length <= 1000
          && value.exerciseBox.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
          box = value.exerciseBox.map((point: number[]) => [point[0], point[1]] as const);
        }
      } catch { /* an unreadable file sets no box, so every coordinate is held */ }
    }
    // The one real-entity list (src/staff/realEntities.ts): the guard settings' names and the list file's, as the scenario loader reads them.
    const entities = await readRealEntities(this.options.root);
    let records: Set<string> | undefined;
    try { records = new Set((await readdir(path.join(this.options.root, CALCULATOR_DIR))).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))); } catch { records = undefined; }
    return { ...(box ? { exerciseBox: box } : {}), realEntities: entities, ...(records ? { calculatorRecords: records } : {}) };
  }

  // ---- Who may act ---------------------------------------------------------------------------------------------------------------------------

  private memberOf(caller: StaffCaller): string | StaffResult {
    const member = caller.member;
    if (member === undefined || !caller.team.members.includes(member)) return refuse('Only a member of this staff team can do that. The run\'s lead coordinates; a member drafts, checks and submits its own products.');
    if (RESERVED_MEMBER_SLUGS.includes(member)) return refuse(`${member} is a reserved name and cannot act on staff products.`);
    return member;
  }

  private rolesFor(caller: StaffCaller, owner: string): ProductRoles | StaffResult {
    const team = caller.team;
    if (!team.members.includes(RELEASE_GUARD_SLUG)) return refuse(`This team has no ${RELEASE_GUARD_SLUG} member, so nothing it writes could be checked before a person sees it. Add the release-guard member to the team.`);
    const tradecraft = TRADECRAFT_SECTIONS.includes(team.section);
    if (tradecraft && !team.members.includes(TRADECRAFT_REVIEWER_SLUG)) return refuse(`This J2 team has no ${TRADECRAFT_REVIEWER_SLUG} member, and J2 products pass the tradecraft gate before the release-guard.`);
    if (owner === RELEASE_GUARD_SLUG || owner === TRADECRAFT_REVIEWER_SLUG) return refuse('A gate member checks products; it does not own them.');
    return { owner, sectionLead: team.sectionLead, releaseGuard: RELEASE_GUARD_SLUG, ...(tradecraft ? { tradecraftReviewer: TRADECRAFT_REVIEWER_SLUG } : {}) };
  }

  /**
   * The phase the project is in, read from the decision log: execution once a person has approved the transition brief (ownership.ts phaseFrom), so the
   * shared products that pass from the planners to the J3 at transition (the synchronization matrix, the DST and DSM, the assessment plan) have their
   * execution writer from then on. A section team runs on its own here; a full staff's writers are the integration's.
   */
  private writerContext(replay: LedgerReplay): { readonly phase: StaffPhase; readonly mode: 'standalone' } {
    return { phase: phaseFrom(replay.products.get(TRANSITION_PRODUCT)), mode: 'standalone' };
  }

  /** A shared product has one writer (design 10, 4.3): anyone else proposes an entry. */
  private sharedWriterProblem(product: string, caller: StaffCaller, member: string, replay: LedgerReplay): StaffResult | undefined {
    if (!sharedProduct(product)) return undefined;
    const context = this.writerContext(replay);
    if (mayWrite(product, { section: caller.team.section, member }, context, undefined, caller.team.members)) return undefined;
    const writer = writerIn(product, context, caller.team);
    return refuse(`${product} is a shared product with one writer (${writer ? `${writer.member} in ${writer.section}` : 'its owner'}). Propose your change as an entry in ${proposalFolder(product)} with the register tool's propose action, and the writer merges it.`);
  }

  // ---- Agent verbs: propose, verdict, submit, withdraw, status, list -----------------------------------------------------------------------------

  /**
   * propose: the owning member records the product file as it is now, as a new version. The first version starts the product (the caller becomes its
   * owner); a later one is a revision, and after a person approved, released or withdrew the last version it starts a new line with the next number.
   */
  public async propose(caller: StaffCaller, input: { product: string; kind?: string; label?: string; dependsOn?: readonly ProductDependency[] }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    if (!STAFF_SLUG.test(input.product)) return refuse('A product name is lower case letters, digits and dashes.');
    // A write-limited member (the red team, the release guard) registers only a product inside its limit: the red team its critique, the guard nothing.
    const limit = staffWriteLimit({ section: caller.team.section }, member);
    if (limit && !writeAllowedBy(limit, productPath(caller.team.section, input.product))) return refuse(`${member} may register only ${limit.join(', ')}; report what should change instead.`);
    const before = await this.replay();
    const shared = this.sharedWriterProblem(input.product, caller, member, before);
    if (shared) return shared;
    const existing = before.products.get(input.product);
    if (existing?.tampered) return refuse(`${input.product} cannot be changed: ${existing.tampered}`);
    const section = existing?.record.section ?? caller.team.section;
    if (section !== caller.team.section) return refuse(`${input.product} belongs to ${section}, not to this team's section. Propose your change in ${proposalFolder(input.product)}.`);
    const file = await this.readProduct(caller.root, section, input.product, input.dependsOn ?? existing?.meta.dependsOn ?? []);
    if (!file.exists) return refuse(`Write the product first, at ${productPath(section, input.product)}, then propose it.`);
    const dependsOn = input.dependsOn ?? file.dependsOn;
    const hash = productHash(file.body, dependsOn);
    const settings = await this.settings(caller.team);
    const kind = input.kind ?? file.header?.kind ?? existing?.meta.kind;
    if (!kind || !(PRODUCT_KINDS as readonly string[]).includes(kind)) return refuse(`Say what kind of product it is: one of ${PRODUCT_KINDS.join(', ')}.`);
    const label = input.label ?? existing?.meta.label ?? 'org/Internal';
    if (!LABEL_PATTERN.test(label)) return refuse('A label is scale/level, for example org/Internal.');
    const meta: ProductMetaInput = { kind: kind as ProductKind, label, profile: existing?.meta.profile ?? settings.profile, level: existing?.meta.level ?? settings.level, dependsOn: [...dependsOn] };
    const result = await this.append((replay) => {
      const state = replay.products.get(input.product);
      if (!state || LINE_CLOSING_STATES.includes(state.record.state)) {
        if (state && state.record.roles.owner !== member && !sharedProduct(input.product)) return refuse(`${input.product} is owned by ${state.record.roles.owner}. Propose your change in ${proposalFolder(input.product)}.`);
        const roles = this.rolesFor(caller, member);
        if ('ok' in roles) return roles;
        return [{ run: caller.run, product: input.product, section, roles, event: { type: 'propose', hash }, actor: { kind: 'agent', member }, meta }];
      }
      if (state.record.roles.owner !== member) return refuse(`${input.product} is owned by ${state.record.roles.owner}. Only the owner writes it; propose your change in ${proposalFolder(input.product)}.`);
      if (hash === state.record.hash) return refuse('The product has not changed since its current version.');
      // From guard-checked or awaiting-decision, the owner's new version is an edit, which drops it back to draft (accepting a changed source, too).
      const type = state.record.state === 'draft' || state.record.state === 'rejected' ? 'propose' : 'edit';
      return [{ run: caller.run, product: input.product, section, event: { type, hash }, actor: { kind: 'agent', member }, meta }];
    });
    if (!('replay' in result)) return result;
    const state = result.replay.products.get(input.product)!;
    await this.writeHeader(caller.root, state, file.body);
    await this.emit([...this.transitionEvents(result.written, result.replay), ...this.waitingEvents(caller, member, file.body)]);
    const changed = state.history[state.history.length - 1];
    return ok(`${input.product} version ${state.record.version} recorded (${changed.from ?? 'new'} to ${changed.to}). Version hash ${state.record.hash}. Next: the ${state.record.roles.tradecraftReviewer ? 'tradecraft reviewer, then the ' : ''}release-guard checks this exact version.`);
  }

  private waitingEvents(caller: StaffCaller, member: string, body: string): WaitingEvent[] {
    const out: WaitingEvent[] = [];
    const at = isoOf(this.now());
    for (const match of body.matchAll(new RegExp(`${STAFF_MARKERS.waitingOn}\\s+([A-Za-z0-9-]+)\\s*:\\s*([^\\n]{1,300})`, 'g'))) {
      const who = match[1].toLowerCase();
      const waitingOn = who === 'human' || who === 'person' || who === 'commander' ? 'human' : (STAFF_SECTION_IDS as readonly string[]).includes(who) ? who as StaffSectionId : undefined;
      if (waitingOn) out.push({ type: 'staff.waiting', run: caller.run, at, section: caller.team.section, member, waitingOn, what: match[2].trim() });
    }
    return out.slice(0, 20);
  }

  /** Runs guard-scan on the product as it is now. */
  public async scan(caller: StaffCaller, product: string): Promise<{ result: GuardScanResult; hash: string } | StaffResult> {
    const { replay, file } = await this.refresh(caller.root, product, caller.run, false);
    const state = replay.products.get(product);
    const section = state?.record.section ?? caller.team.section;
    const read = file ?? await this.readProduct(caller.root, section, product);
    if (!read.exists) return refuse(`There is no product at ${productPath(section, product)}.`);
    const header = state ? projectHeader(state) : read.header;
    const result = guardScan({ ...(header ? { header } : {}), body: read.body, section, owner: state?.record.roles.owner ?? header?.owner ?? '', config: await this.guardConfig() });
    // The hash of the file as scanned: the current version's, or the version the next write records when the file changed since.
    return { result, hash: read.hash };
  }

  public async scanText(caller: StaffCaller, product: string): Promise<StaffResult> {
    const scanned = await this.scan(caller, product);
    return 'result' in scanned ? ok(guardScanText(scanned.result, scanned.hash)) : scanned;
  }

  /** Runs the tradecraft lint on the product as it is now, with the J2 registers it reads. */
  public async lint(caller: StaffCaller, product: string): Promise<{ findings: TradecraftFinding[]; hash: string } | StaffResult> {
    const { replay, file } = await this.refresh(caller.root, product, caller.run, false);
    const state = replay.products.get(product);
    const section = state?.record.section ?? caller.team.section;
    const read = file ?? await this.readProduct(caller.root, section, product);
    if (!read.exists) return refuse(`There is no product at ${productPath(section, product)}.`);
    const kind = state?.meta.kind ?? read.header?.kind;
    const bodyOf = async (name: string): Promise<string | undefined> => {
      const other = await this.readProduct(caller.root, section, name);
      return other.exists ? other.body : undefined;
    };
    const pirBody = product === J2_LINT_INPUTS.pirs ? read.body : await bodyOf(J2_LINT_INPUTS.pirs);
    const schema = registerSchema('pir-register')!;
    const pirs = pirBody === undefined ? undefined : parseRegisterBody(schema, pirBody);
    const hvtBody = await bodyOf(J2_LINT_INPUTS.hvts);
    const hvts = hvtBody?.split('\n').map((line) => /^\s*[-*]\s+([^:|]{2,120})/.exec(line)?.[1]?.trim()).filter((name): name is string => Boolean(name));
    const coaBody = product === J2_LINT_INPUTS.adversaryCoas ? read.body : await bodyOf(J2_LINT_INPUTS.adversaryCoas);
    const sources = await this.sourcesFor(read.body);
    const findings = lintTradecraft({
      body: read.body, ...(kind ? { kind } : {}), ...(sources ? { sources } : {}), ...(pirs ? { pirs } : {}),
      ...(hvts?.length ? { hvts, adversaryCoas: coaBody ? [coaBody] : [] } : {})
    });
    return { findings, hash: read.hash };
  }

  public async lintText(caller: StaffCaller, product: string): Promise<StaffResult> {
    const linted = await this.lint(caller, product);
    return 'findings' in linted ? ok(tradecraftLintText(linted.findings, linted.hash)) : linted;
  }

  /** The sources a product cites: its own ```json staff-sources block, else the project's source register. */
  private async sourcesFor(body: string): Promise<ReturnType<typeof sourcesFrom> | undefined> {
    const block = /```json staff-sources\n([\s\S]*?)\n```/.exec(body);
    if (block) { try { return sourcesFrom(JSON.parse(block[1])); } catch { return []; } }
    const text = await readText(path.join(this.options.root, SOURCES_FILE));
    if (text === undefined) return undefined;
    try { const value = JSON.parse(text) as unknown; return sourcesFrom(Array.isArray(value) ? value : (value as { entries?: unknown; sources?: unknown })?.entries ?? (value as { sources?: unknown })?.sources); } catch { return []; }
  }

  /**
   * verdict: the release-guard's CLEARED or HOLD, or the tradecraft reviewer's SIGN-OFF or NOT READY, on the exact version hash it checked. CLEARED is
   * refused while guard-scan holds that version; SIGN-OFF while the tradecraft lint has a finding. The tool writes the gate's report beside the product.
   */
  public async verdict(caller: StaffCaller, input: { product: string; gate: StaffGate; verdict: string; hash: string; reasons: readonly string[] }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const fresh = await this.refresh(caller.root, input.product, caller.run);
    const state = fresh.replay.products.get(input.product);
    if (!state) return refuse(`${input.product} has not been proposed.`);
    if (state.tampered) return refuse(`${input.product} cannot be checked: ${state.tampered}`);
    if (fresh.disagreement) return refuse(`${input.product} reads as tampered: ${TAMPER_REASONS[fresh.disagreement]} Its owner writes it again, then you check the new version.`);
    if (!fresh.file?.exists) return refuse(`The file ${productPath(state.record.section, input.product)} is missing.`);
    if (input.hash !== state.record.hash) return refuse(`${RELEASE_REFUSALS['stale-version']} The current version is ${state.record.version}, hash ${state.record.hash}.`);
    let findingsText: string | undefined;
    if (input.gate === 'guard' && input.verdict === 'CLEARED') {
      const scanned = await this.scan(caller, input.product);
      if (!('result' in scanned)) return scanned;
      if (scanned.result.hold) return refuse(`CLEARED is refused: guard-scan holds this version.\n${guardScanText(scanned.result, scanned.hash)}`);
      findingsText = guardScanText(scanned.result, scanned.hash);
    }
    if (input.gate === 'tradecraft' && input.verdict === 'SIGN-OFF') {
      const linted = await this.lint(caller, input.product);
      if (!('findings' in linted)) return linted;
      if (linted.findings.length) return refuse(`SIGN-OFF is refused: the tradecraft lint has findings on this version.\n${tradecraftLintText(linted.findings, linted.hash)}`);
      findingsText = tradecraftLintText(linted.findings, linted.hash);
    }
    const reasons = input.reasons.map((reason) => reason.trim()).filter(Boolean);
    const event = { type: 'verdict', gate: input.gate, verdict: input.verdict, hash: input.hash, reasons } as ReleaseEvent;
    const result = await this.append(() => [{ run: caller.run, product: input.product, section: state.record.section, event, actor: { kind: 'agent', member } }]);
    if (!('replay' in result)) return result;
    const after = result.replay.products.get(input.product)!;
    await this.writeReport(caller.root, after, input.gate, input.verdict, member, reasons, findingsText);
    await this.writeHeader(caller.root, after, fresh.file?.body ?? '');
    await this.emit(this.transitionEvents(result.written, result.replay));
    return ok(`${input.verdict} recorded on ${input.product} version ${after.record.version}; it is now ${after.record.state}${after.record.held ? ' (held)' : ''}. Report: ${path.posix.join(path.posix.dirname(productPath(after.record.section, input.product)), gateReportPath(input.gate, input.product, after.record.version))}.`);
  }

  private async writeReport(root: string, state: ProductState, gate: StaffGate, verdict: string, member: string, reasons: readonly string[], findings?: string): Promise<void> {
    const file = path.join(root, path.dirname(productPath(state.record.section, state.record.product)), gateReportPath(gate, state.record.product, state.record.version));
    await mkdir(path.dirname(file), { recursive: true });
    const lines = [
      `# ${gate === 'guard' ? 'Release-guard' : 'Tradecraft'} report: ${state.record.product}, version ${state.record.version}`, '',
      `Verdict: ${verdict}`, `Version hash: ${state.record.hash}`, `By: ${member}`, `At: ${isoOf(this.now())}`, '',
      ...(reasons.length ? ['Reasons:', ...reasons.map((reason, index) => `${index + 1}. ${reason}`), ''] : []),
      ...(findings ? ['Mechanical checks:', findings, ''] : []),
      'This is a recommendation to a person. Only a named person approves or releases a staff product.', ''
    ];
    await writeFile(file, lines.join('\n'), 'utf8');
  }

  /** submit: the owner or section lead puts a guard-checked product in front of a person, with the options, their risk and the dissent. */
  public async submit(caller: StaffCaller, input: { product: string; decisionFor: string; options?: readonly DecisionOption[]; dissent?: readonly string[]; deadline?: string }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const fresh = await this.refresh(caller.root, input.product, caller.run);
    const state = fresh.replay.products.get(input.product);
    if (!state) return refuse(`${input.product} has not been proposed.`);
    if (state.tampered || fresh.disagreement) return refuse(`${input.product} reads as tampered: ${state.tampered ?? TAMPER_REASONS[fresh.disagreement!]}`);
    if (!fresh.file?.exists) return refuse(`The file ${productPath(state.record.section, input.product)} is missing.`);
    const options = (input.options ?? []).slice(0, 10).map((option) => ({ label: option.label.trim(), risk: option.risk.trim() }));
    if (!options.every((option) => isOneLine(option.label, 200) && isOneLine(option.risk, 500))) return refuse('Each option has a label and its risk, each one line.');
    const dissent = (input.dissent ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 20);
    if (!dissent.every((line) => isOneLine(line, 500))) return refuse('Each line of dissent is one line of text.');
    if (input.deadline !== undefined && Number.isNaN(Date.parse(input.deadline))) return refuse('The deadline is a time like 2026-11-18T14:00:00.000Z.');
    const request: DecisionRequestInput = { options, dissent, ...(input.deadline ? { deadline: new Date(Date.parse(input.deadline)).toISOString() } : {}) };
    const result = await this.append(() => [{ run: caller.run, product: input.product, section: state.record.section, event: { type: 'submit', decisionFor: input.decisionFor }, actor: { kind: 'agent', member }, request }]);
    if (!('replay' in result)) return result;
    const after = result.replay.products.get(input.product)!;
    await this.writeHeader(caller.root, after, fresh.file?.body ?? '');
    await this.emit(this.transitionEvents(result.written, result.replay));
    return ok(`${input.product} version ${after.record.version} is awaiting a decision by the ${after.record.decisionFor}. Only that person can approve or reject it; nothing past this point is an agent's to do. Carry on with work that does not depend on the decision.`);
  }

  /** withdraw: the owner takes back a product that no person has decided on. */
  public async withdraw(caller: StaffCaller, input: { product: string; reason: string }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const fresh = await this.refresh(caller.root, input.product, caller.run);
    const state = fresh.replay.products.get(input.product);
    if (!state) return refuse(`${input.product} has not been proposed.`);
    if (state.tampered) return refuse(`${input.product} cannot be changed: ${state.tampered}`);
    const result = await this.append(() => [{ run: caller.run, product: input.product, section: state.record.section, event: { type: 'withdraw', reason: input.reason }, actor: { kind: 'agent', member } }]);
    if (!('replay' in result)) return result;
    const after = result.replay.products.get(input.product)!;
    if (fresh.file?.exists) await this.writeHeader(caller.root, after, fresh.file.body);
    await this.emit(this.transitionEvents(result.written, result.replay));
    return ok(`${input.product} version ${after.record.version} is withdrawn.`);
  }

  /** status: one product's state, gates, request and history, after the file is compared with the ledger. */
  public async status(caller: StaffCaller, product: string): Promise<StaffResult> {
    const fresh = await this.refresh(caller.root, product, caller.run, false);
    const state = fresh.replay.products.get(product);
    if (!state) return ok(`${product} has not been proposed. Its owner writes ${productPath(caller.team.section, product)} and proposes it.`);
    const view = productRegistry(fresh.replay, new Map([[product, { ...(fresh.disagreement ? { disagreement: fresh.disagreement } : {}) }]])).find((entry) => entry.product === product)!;
    await this.noticeOverdue(fresh.replay, caller.run);
    const pending = fresh.pendingEdit && fresh.file ? `\nThe file changed since version ${state.record.version}. The next propose, verdict or submit records it as version ${state.record.version + 1} (hash ${fresh.file.hash}), and every verdict on the old version stops counting.` : '';
    return ok(`${describeView(view)}${pending}`);
  }

  /** list: every product of this team's section (or all sections), newest change first. */
  public async list(caller: StaffCaller, input: { all?: boolean }): Promise<StaffResult> {
    const replay = await this.replay();
    await this.noticeOverdue(replay, caller.run);
    const views = productRegistry(replay).filter((view) => input.all || view.section === caller.team.section);
    if (!views.length) return ok('No staff products yet.');
    return ok(views.map((view) => `- ${view.product} (${view.section}, ${view.kind}) v${view.version}: ${view.display}${view.decisionFor ? `, for the ${view.decisionFor}` : ''}${view.sourceChanged ? ', SOURCE CHANGED' : ''}; owner ${view.owner}`).join('\n'));
  }

  // ---- Step marks ----------------------------------------------------------------------------------------------------------------------------

  /** step: the run enters a crosswalk step for a section (the lead or a member says so); the profile's own step name is recorded with it. */
  public async enterStep(caller: StaffCaller, input: { section?: StaffSectionId; step: number }): Promise<StaffResult> {
    if (!Number.isInteger(input.step) || input.step < 1 || input.step > 8) return refuse('A step is a crosswalk row from 1 to 8.');
    const section = input.section ?? caller.team.section;
    const settings = await this.settings(caller.team);
    const name = stepName(settings.profile, settings.level, input.step as CrosswalkStep);
    const event: StepEnteredEvent = { type: 'staff.step.entered', run: caller.run, at: isoOf(this.now()), section, step: input.step as CrosswalkStep, stepName: name };
    await this.emit([event]);
    return ok(`${section} entered step ${input.step}${name ? ` (${name})` : ''}.`);
  }

  // ---- Registers -----------------------------------------------------------------------------------------------------------------------------

  private async registerRows(root: string, register: string, section: StaffSectionId): Promise<RegisterRow[] | undefined> {
    const schema = registerSchema(register)!;
    const file = await this.readProduct(root, section, register);
    return file.exists ? parseRegisterBody(schema, file.body) : [];
  }

  /** Where a register lives: a shared one in its writer's section, any other in the caller's. */
  private registerSection(register: string, caller: StaffCaller, replay: LedgerReplay): StaffSectionId {
    const existing = replay.products.get(register);
    if (existing) return existing.record.section;
    const writer = sharedProduct(register) ? writerOf(register, this.writerContext(replay)) : undefined;
    return writer?.section ?? caller.team.section;
  }

  public async registerRead(caller: StaffCaller, register: string): Promise<StaffResult> {
    const schema = registerSchema(register);
    if (!schema) return refuse(`There is no register called ${register}.`);
    const replay = await this.replay();
    const section = this.registerSection(register, caller, replay);
    const rows = await this.registerRows(caller.root, register, section);
    if (rows === undefined) return refuse(`${register}'s rows could not be read; its owner writes it again through this tool.`);
    if (register === 'rfi-tracker') await this.noticeOverdue(replay, caller.run, rows);
    return ok(JSON.stringify({ register, section, rows }, null, 2));
  }

  /**
   * write: the register's writer (or the writer of one of its parts) adds, changes or removes rows. The file is written again from the rows, and the new
   * version goes through the state machine: the owner's write is a propose, a part writer's an edit. RFI rows that open or are answered send their events.
   */
  public async registerWrite(caller: StaffCaller, input: { register: string; rows?: readonly unknown[]; remove?: readonly string[]; part?: string; label?: string }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const schema = registerSchema(input.register);
    if (!schema) return refuse(`There is no register called ${input.register}.`);
    const replay = await this.replay();
    const section = this.registerSection(input.register, caller, replay);
    // A write-limited member (the red team, the release guard, the J3 watch officer) writes no register outside its limit; it proposes rows instead.
    const limit = staffWriteLimit({ section: caller.team.section }, member);
    if (limit && !writeAllowedBy(limit, productPath(section, input.register))) return refuse(`${member} does not write registers; propose your rows with the propose action and the register's writer merges them.`);
    const state = replay.products.get(input.register);
    const context = this.writerContext(replay);
    const partWriter = input.part !== undefined ? writerIn(input.register, context, caller.team, input.part) : undefined;
    if (input.part !== undefined && (!partWriter || partWriter.member !== member || partWriter.section !== caller.team.section)) return refuse(`You do not write the ${input.part} part of ${input.register}.`);
    const owner = state?.record.roles.owner;
    const isOwner = input.part === undefined && (state ? owner === member : !sharedProduct(input.register) || mayWrite(input.register, { section: caller.team.section, member }, context, undefined, caller.team.members));
    if (!isOwner && input.part === undefined) return refuse(`${input.register} is written by ${owner ?? writerIn(input.register, context, caller.team)?.member ?? 'its owner'}. Propose your rows with the propose action instead.`);
    if (section !== caller.team.section && input.part === undefined) return refuse(`${input.register} belongs to ${section}.`);
    if (state?.tampered) return refuse(`${input.register} cannot be changed: ${state.tampered}`);
    if (!isOwner && state && !(['draft', 'guard-checked', 'awaiting-decision'] as const).some((value) => value === state.record.state)) {
      return refuse(`${input.register} version ${state.record.version} is ${state.record.state}; its owner writes the next version before parts can change.`);
    }
    const before = await this.registerRows(caller.root, input.register, section);
    if (before === undefined) return refuse(`${input.register}'s rows could not be read, so nothing was changed. Its owner writes it again.`);
    const written = writeRows(schema, before, input.rows ?? [], input.remove ?? [], input.part);
    if (!written.ok) return refuse(written.message);
    const body = renderRegisterBody(schema, written.rows);
    const file = path.join(caller.root, productPath(section, input.register));
    const existing = await this.readProduct(caller.root, section, input.register);
    await writeFileAtomic(file, `${existing.exists && existing.headerText && state ? renderProductHeader(projectHeader(state)) : ''}${body}`);
    let result: StaffResult;
    if (isOwner) {
      result = await this.propose(caller, { product: input.register, kind: schema.kind, ...(input.label ? { label: input.label } : {}) });
    } else {
      if (!state) return refuse(`${input.register} does not exist yet; its owner creates it first.`);
      result = await this.recordPartEdit(caller, member, input.register, input.part ?? '');
    }
    if (result.ok && input.register === 'rfi-tracker') await this.emit(rfiChanges(before, written.rows, caller.run, isoOf(this.now())));
    return result;
  }

  /** A part writer's change to a register it does not own is an edit by that member: a new version, back to draft, recorded with who made it. */
  private async recordPartEdit(caller: StaffCaller, member: string, register: string, part: string): Promise<StaffResult> {
    const result = await this.append(async (replay) => {
      const state = replay.products.get(register);
      if (!state) return refuse(`${register} does not exist yet; its owner creates it first.`);
      if (state.tampered) return refuse(`${register} cannot be changed: ${state.tampered}`);
      const file = await this.readProduct(caller.root, state.record.section, register, state.meta.dependsOn);
      if (file.hash === state.record.hash) return refuse('Nothing changed.');
      return [{ run: caller.run, product: register, section: state.record.section, event: { type: 'edit', hash: file.hash }, actor: { kind: 'agent', member }, meta: { ...state.meta, dependsOn: [...file.dependsOn] } }];
    });
    if (!('replay' in result)) return result;
    const after = result.replay.products.get(register)!;
    const file = await this.readProduct(caller.root, after.record.section, register, after.meta.dependsOn);
    await this.writeHeader(caller.root, after, file.body);
    await this.emit(this.transitionEvents(result.written, result.replay));
    return ok(`Your ${part} rows of ${register} are recorded as version ${after.record.version}; the register is back in draft for its owner's guard check.`);
  }

  /** propose (for a register): anyone writes rows as a proposal for the register's writer to merge. */
  public async registerPropose(caller: StaffCaller, input: { register: string; rows: readonly unknown[]; note?: string }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const schema = registerSchema(input.register);
    if (!schema) return refuse(`There is no register called ${input.register}.`);
    const rows: RegisterRow[] = [];
    for (const raw of input.rows) {
      const checked = checkRow(schema, raw);
      if (!checked.ok) return refuse(checked.message);
      rows.push(checked.row);
    }
    const folder = path.join(caller.root, proposalFolder(input.register));
    await mkdir(folder, { recursive: true });
    const name = `${isoOf(this.now()).replace(/[:.]/g, '-')}-${member}.json`;
    await writeFile(path.join(folder, name), `${JSON.stringify({ register: input.register, from: { section: caller.team.section, member }, note: input.note ?? '', rows }, null, 2)}\n`, 'utf8');
    return ok(`Proposed ${rows.length} row${rows.length === 1 ? '' : 's'} for ${input.register} in ${proposalFolder(input.register)}${name}. The register's writer merges it.`);
  }

  /** trigger: a member watching the CCIRs reports that one fired (design 10, 4.5, `staff.ccir.triggered`). */
  public async ccirTrigger(caller: StaffCaller, input: { ccir: string; report: string }): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    if (!isOneLine(input.report, 500)) return refuse('Say in one line what was reported.');
    const replay = await this.replay();
    const section = this.registerSection('ccir-register', caller, replay);
    const rows = await this.registerRows(caller.root, 'ccir-register', section) ?? [];
    const row = rows.find((candidate) => candidate.id === input.ccir);
    if (!row) return refuse(`There is no CCIR ${input.ccir} in the CCIR register.`);
    const now = isoOf(this.now());
    const event: CcirTriggeredEvent = { type: 'staff.ccir.triggered', run: caller.run, at: now, ccir: input.ccir, report: input.report.trim(), member, time: now };
    await this.emit([event]);
    return ok(`CCIR ${input.ccir} reported as triggered. Tell the ${String(row.reportTo ?? 'commander')} through the run's lead; the decision is a person's.`);
  }

  /** Sends `staff.rfi.overdue` once for each open RFI past its suspense. */
  private async noticeOverdue(replay: LedgerReplay, run: string, known?: readonly RegisterRow[]): Promise<void> {
    const state = replay.products.get('rfi-tracker');
    if (!state && !known) return;
    const rows = known ?? (state ? await this.registerRows(this.options.root, 'rfi-tracker', state.record.section) : undefined);
    if (!rows) return;
    const overdue = overdueRfis(rows, this.now(), run, isoOf(this.now()));
    if (!overdue.length) return;
    const sent = new Set((await this.events()).filter((event) => event.type === 'staff.rfi.overdue').map((event) => `${(event as { rfi: string }).rfi}@${(event as { suspense: string }).suspense}`));
    await this.emit(overdue.filter((event) => !sent.has(`${event.rfi}@${event.suspense}`)));
  }

  // ---- The wargame -----------------------------------------------------------------------------------------------------------------------------

  private wargameDir(): string { return path.join(this.options.root, WARGAME_DIR); }

  public async wargameEntries(): Promise<WargameEntry[]> {
    const text = await readText(path.join(this.wargameDir(), WARGAME_FILE));
    if (text === undefined) return [];
    const out: WargameEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { recordedBy?: unknown; at?: unknown };
        const parsed = parseWargamePhase(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'recordedBy' && key !== 'at')));
        if (parsed.ok && typeof value.recordedBy === 'string' && typeof value.at === 'string') out.push({ ...parsed.value, recordedBy: value.recordedBy, at: value.at });
      } catch { /* a damaged line is left out */ }
    }
    return out;
  }

  /** record: one phase of one wargame turn, in order (action, reaction, counteraction), by any member at the table. */
  public async wargameRecord(caller: StaffCaller, raw: unknown): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const parsed = parseWargamePhase(raw);
    if (!parsed.ok) return refuse(parsed.message);
    await mkdir(this.wargameDir(), { recursive: true });
    return withFileLock(this.wargameDir(), WARGAME_LOCK, async () => {
      const entries = await this.wargameEntries();
      const order = checkOrder(entries, parsed.value);
      if (order) return refuse(order);
      const entry: WargameEntry = { ...parsed.value, recordedBy: member, at: isoOf(this.now()) };
      await appendFile(path.join(this.wargameDir(), WARGAME_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
      await this.emit([wargameTurnEvent(entry, caller.run)]);
      return ok(`Recorded ${entry.coa} against ${entry.enemyCoa}, turn ${entry.turn} ${entry.phase.toUpperCase()}.`);
    });
  }

  /**
   * derive: the synchronization matrix and the DST and DSM rows from the recorded games, written to those registers when the caller is their writer,
   * and the branch list. Otherwise the rows come back for the writer.
   */
  public async wargameDerive(caller: StaffCaller): Promise<StaffResult> {
    const member = this.memberOf(caller);
    if (typeof member !== 'string') return member;
    const derived = deriveFromWargame(await this.wargameEntries());
    const context = this.writerContext(await this.replay());
    const writes: string[] = [];
    for (const [register, rows] of [['sync-matrix', derived.sync], ['dst-dsm', derived.dsm]] as const) {
      if (!rows.length) continue;
      if (!mayWrite(register, { section: caller.team.section, member }, context, undefined, caller.team.members)) { writes.push(`${register}: ${rows.length} rows for its writer, ${writerIn(register, context, caller.team)?.member}`); continue; }
      const result = await this.registerWrite(caller, { register, rows });
      writes.push(result.ok ? `${register}: ${rows.length} rows written. ${result.text}` : `${register}: not written. ${result.message}`);
    }
    return ok([
      `From ${derived.sync.length} sync matrix rows, ${derived.dsm.length} decision points and ${derived.branches.length} branches:`,
      ...writes.map((line) => `- ${line}`),
      ...(derived.branches.length ? ['Branches:', ...derived.branches.map((branch) => `- ${branch}`)] : []),
      ...(writes.some((line) => line.includes('for its writer')) ? ['Rows:', JSON.stringify({ sync: derived.sync, dsm: derived.dsm }, null, 2)] : [])
    ].join('\n'));
  }

  // ---- A person's decisions (commands only) ------------------------------------------------------------------------------------------------

  /**
   * A named person approves, rejects, releases or withdraws a product, signed with this device's key. Reached only from the VS Code commands; no agent
   * tool calls it, and the state machine refuses each of these from an agent in any case. A release also supersedes the older released version.
   */
  public async decide(person: PersonActor, input: { product: string; action: 'approve' | 'reject' | 'release' | 'withdraw'; hash?: string; reasons?: readonly string[]; releaseOnApproval?: boolean }): Promise<StaffResult> {
    if (!isNamedPerson(person)) return refuse(RELEASE_REFUSALS['unnamed-person']);
    const root = this.options.root;
    const fresh = await this.refresh(root, input.product, 'person');
    const state = fresh.replay.products.get(input.product);
    if (!state) return refuse(`${input.product} has not been proposed.`);
    if (state.tampered) return refuse(`${input.product} cannot be decided on: ${state.tampered}`);
    if (fresh.disagreement) return refuse(`${input.product} cannot be decided on: ${TAMPER_REASONS[fresh.disagreement]}`);
    const run = state.request?.run ?? state.history[state.history.length - 1]?.run ?? 'person';
    const reasons = (input.reasons ?? []).map((reason) => reason.trim()).filter(Boolean);
    let event: ReleaseEvent;
    switch (input.action) {
      case 'approve': event = { type: 'approve', hash: input.hash ?? '', ...(input.releaseOnApproval ? { releaseOnApproval: true } : {}) }; break;
      case 'release': event = { type: 'release', hash: input.hash ?? '' }; break;
      case 'reject': event = { type: 'reject', reasons }; break;
      default: event = { type: 'withdraw', reason: reasons.join('; ') }; break;
    }
    const releasing = input.action === 'release' || (input.action === 'approve' && input.releaseOnApproval === true);
    const result = await this.append(() => {
      const drafts: EntryDraft[] = [{ run, product: input.product, section: state.record.section, event, actor: person }];
      if (releasing) {
        for (const line of state.older) if (line.record.state === 'released') drafts.push({ run, product: input.product, section: state.record.section, line: line.record.version, event: { type: 'supersede', byVersion: state.record.version }, actor: person });
      }
      return drafts;
    });
    if (!('replay' in result)) return result;
    const after = result.replay.products.get(input.product)!;
    if (fresh.file?.exists) await this.writeHeader(root, after, fresh.file.body);
    await this.emit(this.transitionEvents(result.written, result.replay));
    return ok(`${input.product} version ${after.record.version} is now ${after.record.state}, by ${person.name} (${person.role}).`);
  }

  // ---- Read models ---------------------------------------------------------------------------------------------------------------------------

  /** Everything the Staff Room draws, rebuilt from the ledger, the product files and the event log. */
  public async snapshot(run?: string): Promise<{ registry: ProductView[]; decisions: ReturnType<typeof decisionQueue>; registers: ReturnType<typeof sharedRegisters>; board?: ReturnType<typeof stepBoard>; steps?: ReturnType<typeof currentSteps>; cop: ReturnType<typeof copModel>; ledgerProblem?: string }> {
    const replay = await this.replay();
    const files = new Map<string, FileCheck>();
    const rows = new Map<string, number>();
    for (const state of replay.products.values()) {
      const file = await this.readProduct(this.options.root, state.record.section, state.record.product, state.meta.dependsOn);
      const found = file.exists ? fileDisagreement(state, file) : undefined;
      files.set(state.record.product, found && found !== 'pending-edit' ? { disagreement: found } : {});
      const schema = registerSchema(state.record.product);
      if (schema && file.exists) rows.set(state.record.product, parseRegisterBody(schema, file.body)?.length ?? 0);
    }
    const registry = productRegistry(replay, files);
    const events = await this.events();
    return {
      registry, decisions: decisionQueue(replay, files), registers: sharedRegisters(replay, rows), cop: copModel(events),
      ...(run ? { board: stepBoard(events, run, registry), steps: currentSteps(events, run) } : {}),
      ...(replay.broken ? { ledgerProblem: `Entry ${replay.broken.seq + 1}: ${replay.broken.reason}` } : {})
    };
  }
}

/** One product as the plain text a member or a person reads. */
export function describeView(view: ProductView): string {
  const lines = [
    `${view.product} (${view.section}, ${view.kind}), version ${view.version}: ${view.display}.`,
    `Owner: ${view.owner}. Label: ${view.label}. Version hash: ${view.hash}.`
  ];
  if (view.tampered) lines.push(`Tampered: ${view.tampered}`);
  if (view.heldReasons?.length) lines.push(`Held: ${view.heldReasons.map((reason, index) => `${index + 1}. ${reason}`).join(' ')}`);
  if (view.tradecraft) lines.push(`Tradecraft: ${view.tradecraft.verdict} on version ${view.tradecraft.version}.`);
  if (view.guard) lines.push(`Release-guard: ${view.guard.verdict} on version ${view.guard.version}.`);
  if (view.decisionFor) lines.push(`Decision for: the ${view.decisionFor}.`);
  if (view.approvedBy) lines.push(`Approved by ${view.approvedBy.name} (${view.approvedBy.role}), signed with a device key; the identity is self-declared until verified credentials arrive.`);
  if (view.dependsOn.length) lines.push(`Depends on: ${view.dependsOn.map((entry) => `${entry.product}@${entry.version}`).join(', ')}.`);
  if (view.changedSources.length) lines.push(`SOURCE CHANGED: ${view.changedSources.map((entry) => `${entry.product} now has approved version ${entry.version}`).join('; ')}. The owner decides whether to take it: a new version that depends on it drops this product back to draft.`);
  const last = view.history.slice(-5).map((item) => `${item.at} v${item.version} ${item.from ?? 'new'} to ${item.to} (${item.event}) by ${item.actor.kind === 'person' ? `${item.actor.name}, ${item.actor.role}` : item.actor.member}`);
  if (last.length) lines.push('Recent steps:', ...last.map((line) => `- ${line}`));
  return lines.join('\n');
}

/** The staff hosts, one per project root, made on first use with the options the extension set at activation. */
const hosts = new Map<string, StaffHost>();
let configured: Omit<StaffHostOptions, 'root'> | undefined;

/** Called once at activation with this device's signer and trusted keys; until then the staff tools say the host is not ready. */
export function configureStaffHosts(options: Omit<StaffHostOptions, 'root'> | undefined): void {
  configured = options;
  hosts.clear();
}

export function staffHostFor(root: string): StaffHost | undefined {
  if (!configured) return undefined;
  const key = path.resolve(root);
  let host = hosts.get(key);
  if (!host) { host = new StaffHost({ ...configured, root: key }); hosts.set(key, host); }
  return host;
}

export function staffSectionOf(value: string): StaffSectionId | undefined {
  return (STAFF_SECTION_IDS as readonly string[]).includes(value) ? value as StaffSectionId : undefined;
}

export type { StaffActor };
