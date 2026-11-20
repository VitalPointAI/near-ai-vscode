// The J5, J3 and J4 workspaces of the Staff Room (UX concept 5.6 to 5.11; design 10, 3.3 to 3.5; owner direction 2026-11-19): each section's own view
// of the staff run, built from what the project really holds. Pure: no I/O, no clock (the time is passed in), no vscode.
//
// Every figure here comes from a product in the ledger, a register, the wargame ledger, the calculator records the calculator ledger vouches for, or a
// LOGSTAT report: the page draws it and decides nothing. A product's tables are read as data (the first Markdown table with the columns the section's
// skill gives it); a table that is not there is simply not drawn, and the workspace says what would fill it. Decisions stay on the shared decision list
// (staffRoom.ts), so a button in a section workspace is the same signed, person-only path as everywhere else.
import { DOCTRINE_PROFILES, FRAGMENTARY_ORDER, LOGISTICS_TERMS } from './doctrine';
import type { StaffProfileId, StaffSectionId } from './doctrine';
import type { DecisionQueueEntry, StaffEvent } from './events';
import { bandOf, consolidateLogstat, formatNumber, movementBoard } from './logistics';
import type { BandSetting, CalcRecord, LogstatReport, MovementRecord, ReadinessRecord } from './logistics';
import { blocking, checkAnnexes, compareLetters } from './orders';
import type { OrderProductFacts } from './orders';
import { writerOf } from './ownership';
import type { StaffWriter } from './ownership';
import type { ProductView } from './readModels';
import { BATTLE_RHYTHM_REPEAT_DAYS } from './registers';
import type { RegisterRow } from './registers';
import { productTitle } from './productTitle';
import { PHASE_SIDE } from './wargame';
import type { WargameEntry } from './wargame';

/** Display caps: the page never receives more than it can show. Large registers are capped here and again, page by page, on screen. */
const CAP = { text: 400, short: 160, rows: 200, products: 60, activity: 12, wargame: 200, calcs: 60, formula: 30 } as const;
const clip = (text: unknown, max: number = CAP.text): string => {
  const value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
/** A product's title in the profile's words (frago-1 reads as the profile's fragmentary order). */
const titleOf = (ctx: Pick<WorkspaceContext, 'profile'>, product: string): string => productTitle(product, ctx.profile);
const PILL: Readonly<Record<string, string>> = {
  draft: 'draft', 'draft (held)': 'held', 'draft (tampered)': 'tampered', 'guard-checked': 'checked', 'awaiting decision': 'awaiting', approved: 'approved',
  rejected: 'rejected', released: 'released', superseded: 'superseded', withdrawn: 'withdrawn'
};

// ---- Markdown tables --------------------------------------------------------------------------------------------------------------------------------

export interface MarkdownTable { readonly headers: readonly string[]; readonly rows: ReadonlyArray<readonly string[]> }

/** Every pipe table in a Markdown body, outside fenced blocks: its header cells and its rows (the separator row dropped). */
export function markdownTables(body: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const headers = cells(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|') && rows.length < CAP.rows; j += 1) rows.push(cells(lines[j]));
    tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

/** The first table whose headers match every pattern, with a column finder. */
function tableWith(body: string | undefined, patterns: readonly RegExp[]): { table: MarkdownTable; col: (pattern: RegExp) => number } | undefined {
  if (!body) return undefined;
  const table = markdownTables(body).find((candidate) => patterns.every((pattern) => candidate.headers.some((header) => pattern.test(header))));
  return table && { table, col: (pattern: RegExp) => table.headers.findIndex((header) => pattern.test(header)) };
}
const at = (row: readonly string[], index: number): string => (index >= 0 ? row[index] ?? '' : '');

/** The leading number of a cell ("3: holds the ford" is 3), or undefined. */
function leadingNumber(text: string): number | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

// ---- Shared shapes ------------------------------------------------------------------------------------------------------------------------------------

/** One of a section's products, as its workspace lists it: owner, version and the release state in the state machine's words. */
export interface WorkspaceProduct {
  readonly product: string;
  readonly title: string;
  readonly kind: string;
  readonly version: number;
  readonly display: string;
  readonly pill: string;
  readonly owner: string;
  readonly at: string;
  readonly approvedBy?: string;
}

/** A line of agent work in this section (violet on the page). */
export interface WorkspaceActivity { readonly at: string; readonly member: string; readonly text: string }

/** Who writes a shared register now, and the signed act that moved it (the transition brief, approved by a person). */
export interface RegisterOwner {
  readonly writer: string;
  readonly phase: 'planning' | 'execution';
  readonly handover?: { readonly from: string; readonly to: string; readonly by: string; readonly at: string };
  readonly note: string;
}

interface SectionCommon {
  readonly products: readonly WorkspaceProduct[];
  readonly activity: readonly WorkspaceActivity[];
  readonly problems: readonly string[];
}

export interface J5Workspace extends SectionCommon {
  readonly tests: readonly string[];
  readonly cells: ReadonlyArray<{
    readonly coa: string; readonly owner: string; readonly theme: string; readonly differs: string; readonly product?: WorkspaceProduct;
    readonly validity: ReadonlyArray<{ readonly test: string; readonly result: 'pass' | 'fail' | 'risk' | 'unknown'; readonly reason: string }>; readonly distinctFrom: string
  }>;
  readonly comparison: {
    readonly coas: readonly string[];
    readonly criteria: ReadonlyArray<{ readonly criterion: string; readonly definition: string; readonly weight?: number; readonly scores: ReadonlyArray<{ readonly score?: number; readonly text: string }> }>;
    readonly totals: ReadonlyArray<{ readonly coa: string; readonly total: number; readonly best: boolean }>;
    /** The person who approved the criteria and weights, from the signed ledger; absent while they are only proposed. */
    readonly approval?: { readonly by: string; readonly at: string; readonly product: string; readonly version: number };
    readonly product?: WorkspaceProduct;
  };
  readonly wargame: {
    readonly total: number;
    readonly games: ReadonlyArray<{
      readonly coa: string; readonly enemyCoa: string; readonly next: string;
      readonly turns: ReadonlyArray<{
        readonly turn: number; readonly when: string;
        readonly phases: ReadonlyArray<{ readonly phase: string; readonly side: string; readonly moves: readonly string[]; readonly results: readonly string[]; readonly decisionPoints: readonly string[]; readonly recordedBy: string; readonly at: string }>
      }>
    }>;
    readonly problem?: string;
  };
  readonly brief: { readonly product?: WorkspaceProduct; readonly recommendation: string; readonly dissent: readonly string[]; readonly redTeam?: WorkspaceProduct; readonly decisionFor?: string };
  readonly annexes: {
    readonly rows: ReadonlyArray<{ readonly id: string; readonly subject: string; readonly letter: string; readonly owner: string; readonly status: string; readonly product: string; readonly state: string; readonly findings: readonly string[]; readonly blocked: boolean }>;
    readonly findings: number;
    readonly blocking: number;
    readonly product?: WorkspaceProduct;
  };
}

export interface J3Workspace extends SectionCommon {
  readonly eventLog: { readonly total: number; readonly escalated: number; readonly rows: ReadonlyArray<{ readonly id: string; readonly time: string; readonly source: string; readonly report: string; readonly ccir: string; readonly decisionPoint: string; readonly status: string }> };
  readonly ccir: ReadonlyArray<{ readonly id: string; readonly type: string; readonly requirement: string; readonly decisionPoint: string; readonly status: string; readonly ltiov: string }>;
  readonly triggers: ReadonlyArray<{ readonly at: string; readonly ccir: string; readonly report: string; readonly member: string }>;
  readonly dsm: { readonly owner: RegisterOwner; readonly rows: ReadonlyArray<{ readonly id: string; readonly description: string; readonly indicator: string; readonly nai: string; readonly pir: string; readonly action: string; readonly maker: string; readonly coa: string; readonly matched: boolean }> };
  readonly sync: { readonly owner: RegisterOwner; readonly total: number; readonly from: number; readonly to: number; readonly rows: ReadonlyArray<{ readonly row: string; readonly cells: ReadonlyArray<{ readonly id: string; readonly offset: number; readonly entry: string; readonly section: string; readonly coa: string }> }> };
  /** The fragmentary order in the profile's words: FRAGORD under the US profiles, Frag O under NATO/Canadian. */
  readonly frago: string;
  readonly fragos: readonly WorkspaceProduct[];
  readonly rhythm: { readonly events: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; /** ISO time, or empty when the repeat is not shown. */ readonly next: string; readonly minutes: number; readonly repeat: string; readonly chair: string; readonly inputs: string; readonly outputs: string }>; readonly product?: WorkspaceProduct };
  readonly suspenses: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly question: string; readonly suspense: string; readonly overdue: boolean }>;
}

export interface J4Workspace extends SectionCommon {
  readonly logstat: {
    readonly reports: number;
    readonly units: ReadonlyArray<{ readonly unit: string; readonly report: string; readonly band: string; readonly lines: ReadonlyArray<{ readonly commodity: string; readonly uom: string; readonly onHand: string; readonly capacity: string; readonly daysOfSupply: string; readonly band: string; readonly words: string; readonly forecast: string; readonly calc: string }> }>;
    readonly heldOut: ReadonlyArray<{ readonly unit: string; readonly report: string; readonly rules: readonly string[] }>;
  };
  readonly calcs: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly title: string; readonly by: string; readonly at: string; readonly result: string; readonly formula: readonly string[] }>;
  readonly calcProblems: readonly string[];
  readonly movement: ReadonlyArray<{ readonly table: string; readonly serial: string; readonly what: string; readonly mode: string; readonly from: string; readonly to: string; readonly arrives: string; readonly required: string; readonly feasible: boolean; readonly why: string }>;
  readonly readiness: ReadonlyArray<{ readonly equipment: string; readonly onHand: number; readonly ready: number; readonly percent: number; readonly asOf: string; readonly stale: boolean; readonly record: string }>;
  /** The profile's name for the logistics annex: "Logistics annex", or "Sustainment annex" under the US Army profile. */
  readonly annexName: string;
  readonly annexes: ReadonlyArray<{ readonly product: string; readonly title: string; readonly state: string; readonly pill: string; readonly version: number; readonly owner: string; readonly tracker: string }>;
  readonly supportability: ReadonlyArray<{ readonly coa: string; readonly fn: string; readonly judgement: string; readonly culminates: string; readonly calc: string; readonly verified: boolean; readonly level: 'ok' | 'risk' | 'bad' | 'unknown' }>;
}

export interface SectionWorkspaces { readonly j5: J5Workspace; readonly j3: J3Workspace; readonly j4: J4Workspace }

// ---- Inputs ------------------------------------------------------------------------------------------------------------------------------------------

/** What the three workspaces are built from. Every field may be missing: a project without it simply has nothing to draw there yet. */
export interface WorkspacesInput {
  /** Product bodies (without the staff header) the workspaces read tables from, by product slug. */
  readonly bodies?: Readonly<Record<string, string>>;
  readonly registers?: { readonly syncMatrix?: readonly RegisterRow[]; readonly eventLog?: readonly RegisterRow[]; readonly ccir?: readonly RegisterRow[]; readonly rfi?: readonly RegisterRow[]; readonly battleRhythm?: readonly RegisterRow[]; readonly annexTracker?: readonly RegisterRow[] };
  readonly wargame?: { readonly entries: readonly WargameEntry[] } | { readonly unreadable: string };
  /** What the orders check knows about each product, from the ledger replay (orders.ts productFacts). */
  readonly facts?: ReadonlyMap<string, OrderProductFacts>;
  readonly logistics?: { readonly records: readonly CalcRecord[]; readonly recordProblems: readonly string[]; readonly ledgerProblem?: string; readonly reports: readonly LogstatReport[]; readonly bands: readonly BandSetting[] };
  readonly problems?: readonly string[];
}

export interface WorkspaceContext {
  readonly now: number;
  readonly profile: StaffProfileId;
  readonly coaTests: readonly string[];
  readonly registry: readonly ProductView[];
  readonly decisions: readonly DecisionQueueEntry[];
  readonly events: readonly StaffEvent[];
  readonly dsm?: readonly RegisterRow[];
  readonly code: (section: StaffSectionId) => string;
  readonly input: WorkspacesInput;
}

// ---- Helpers ------------------------------------------------------------------------------------------------------------------------------------------

function productOf(ctx: WorkspaceContext, view: ProductView): WorkspaceProduct {
  const last = view.history[view.history.length - 1];
  return {
    product: view.product, title: titleOf(ctx, view.product), kind: view.kind, version: view.version, display: view.display, pill: PILL[view.display] ?? 'draft',
    owner: clip(view.owner, 60), at: last?.at ?? '', ...(view.approvedBy ? { approvedBy: clip(`${view.approvedBy.name} (${view.approvedBy.role})`, CAP.short) } : {})
  };
}

function find(ctx: WorkspaceContext, product: string): ProductView | undefined {
  return ctx.registry.find((view) => view.product === product);
}

function sectionProducts(ctx: WorkspaceContext, section: StaffSectionId): WorkspaceProduct[] {
  return ctx.registry.filter((view) => view.section === section).slice(0, CAP.products).map((view) => productOf(ctx, view));
}

/** The section's agent work, newest first: lanes started and finished, products drafted and checked, waits. A person's decision is not agent work. */
function sectionActivity(ctx: WorkspaceContext, section: StaffSectionId): WorkspaceActivity[] {
  const out: WorkspaceActivity[] = [];
  for (let i = ctx.events.length - 1; i >= 0 && out.length < CAP.activity; i -= 1) {
    const event = ctx.events[i];
    if (!('section' in event) || event.section !== section) continue;
    let line: WorkspaceActivity | undefined;
    if (event.type === 'staff.lane.started') line = { at: event.at, member: event.member, text: `started${event.product ? ` on ${titleOf(ctx, event.product)}` : ''}` };
    else if (event.type === 'staff.lane.finished') line = { at: event.at, member: event.member, text: `${event.outcome === 'done' ? 'finished' : event.outcome === 'failed' ? 'stopped with an error' : 'was stopped'}${event.product ? `: ${titleOf(ctx, event.product)}` : ''}${event.outcome === 'failed' && event.reason ? `: ${event.reason}` : ''}` };
    else if (event.type === 'staff.lane.switched') line = { at: event.at, member: event.member, text: `switched from ${event.from} to ${event.to}: ${event.reason}` };
    else if (event.type === 'staff.product.state' && event.actor.kind === 'agent') line = { at: event.at, member: event.actor.member ?? 'an agent', text: `${titleOf(ctx, event.product)} v${event.version}: ${event.from ?? 'new'} to ${event.to}` };
    else if (event.type === 'staff.waiting') line = { at: event.at, member: event.member, text: `waits on ${event.waitingOn === 'human' ? 'a person' : ctx.code(event.waitingOn)}: ${event.what}` };
    else if (event.type === 'staff.step.entered') line = { at: event.at, member: ctx.code(section), text: `entered step ${event.step}${event.stepName ? `, ${event.stepName}` : ''}` };
    if (line) out.push({ at: line.at, member: clip(line.member, 60), text: clip(line.text, 300) });
  }
  return out;
}

const writerWords = (ctx: WorkspaceContext, writer: StaffWriter | undefined): string => (writer ? `${ctx.code(writer.section)} ${writer.member}` : 'its owner');

/** Who writes a shared register: the J5 in planning, the J3 after a person approved the transition brief (ownership.ts; readModels.ts handoverOf). */
function registerOwner(ctx: WorkspaceContext, product: string): RegisterOwner {
  const view = find(ctx, product);
  const planning = writerOf(product, { phase: 'planning', mode: 'full-staff' });
  const execution = writerOf(product, { phase: 'execution', mode: 'full-staff' });
  if (view?.handover) {
    const by = clip(`${view.handover.by.name} (${view.handover.by.role})`, CAP.short);
    return {
      writer: writerWords(ctx, view.handover.to), phase: 'execution',
      handover: { from: writerWords(ctx, view.handover.from), to: writerWords(ctx, view.handover.to), by, at: view.handover.at },
      note: `Owned by the ${writerWords(ctx, view.handover.to)} since ${by} approved the transition brief.`
    };
  }
  return {
    writer: writerWords(ctx, planning), phase: 'planning',
    note: execution && planning && (execution.section !== planning.section || execution.member !== planning.member)
      ? `Owned by the ${writerWords(ctx, planning)} while planning. It passes to the ${writerWords(ctx, execution)} only when a person approves the transition brief.`
      : `Owned by the ${writerWords(ctx, planning)}.`
  };
}

const str = (row: RegisterRow, key: string, max: number = CAP.text): string => clip(row[key] === undefined ? '' : String(row[key]), max);

function hHour(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `H${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

// ---- J5 -----------------------------------------------------------------------------------------------------------------------------------------------

const COA_LETTER = /\bCOA[\s-]*([A-Z0-9]+)\b/i;
function coaSlug(label: string): string | undefined {
  const match = COA_LETTER.exec(label);
  return match ? `coa-${match[1].toLowerCase()}` : undefined;
}

function validityOf(cell: string): { result: 'pass' | 'fail' | 'risk' | 'unknown'; reason: string } {
  const match = /^\s*(pass|passed|fail|failed|risk|risky)\b[\s:,.;-]*(.*)$/i.exec(cell);
  if (!match) return { result: 'unknown', reason: clip(cell, 300) };
  const word = match[1].toLowerCase();
  return { result: word.startsWith('pass') ? 'pass' : word.startsWith('fail') ? 'fail' : 'risk', reason: clip(match[2], 300) };
}

function buildJ5(ctx: WorkspaceContext): J5Workspace {
  const bodies = ctx.input.bodies ?? {};
  const problems: string[] = [];
  // COA cells: the lead planner's themes, each tied to its COA product, with the profile's validity tests from the validity record.
  const themes = tableWith(bodies['coa-themes'], [/^COA$/i, /theme/i]);
  const validity = tableWith(bodies['coa-validity'], [/^COA$/i]);
  const tests = ctx.coaTests.map((test) => clip(test, 60));
  const validityFor = (coa: string) => {
    if (!validity) return { validity: [], distinctFrom: '' };
    const row = validity.table.rows.find((candidate) => coaSlug(at(candidate, validity.col(/^COA$/i))) === coaSlug(coa));
    if (!row) return { validity: [], distinctFrom: '' };
    return {
      validity: tests.map((test) => ({ test, ...validityOf(at(row, validity.col(new RegExp(`^${test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')))) })),
      distinctFrom: clip(at(row, validity.col(/distinct/i)), 200)
    };
  };
  const cells: Array<J5Workspace['cells'][number]> = [];
  for (const row of themes?.table.rows.slice(0, 6) ?? []) {
    const coa = clip(at(row, themes!.col(/^COA$/i)), 40);
    const view = coaSlug(coa) ? find(ctx, coaSlug(coa)!) : undefined;
    cells.push({ coa, owner: clip(at(row, themes!.col(/owner/i)), 60), theme: clip(at(row, themes!.col(/theme/i)), 300), differs: clip(at(row, themes!.col(/differ/i)), 300), ...(view ? { product: productOf(ctx, view) } : {}), ...validityFor(coa) });
  }
  // COA products the themes do not name yet still get their cell, so a cell's work shows from its first draft.
  for (const view of ctx.registry.filter((candidate) => /^coa-[a-z0-9]$/.test(candidate.product) && candidate.section === 'j5')) {
    if (cells.some((cell) => cell.product?.product === view.product)) continue;
    const coa = `COA ${view.product.slice(4).toUpperCase()}`;
    cells.push({ coa, owner: clip(view.owner, 60), theme: '', differs: '', product: productOf(ctx, view), ...validityFor(coa) });
  }
  cells.sort((a, b) => a.coa.localeCompare(b.coa));

  // The comparison: criteria and weights, each COA's score, weighted totals recomputed here (never taken from the product's own arithmetic).
  const matrix = tableWith(bodies['comparison-matrix'], [/criterion/i, /weight/i]);
  const coaColumns = matrix ? matrix.table.headers.map((header, index) => ({ header, index })).filter((entry) => COA_LETTER.test(entry.header)) : [];
  const coas = coaColumns.map((entry) => `COA ${COA_LETTER.exec(entry.header)![1].toUpperCase()}`);
  const criteria = (matrix?.table.rows ?? []).filter((row) => !/^\s*(\*\*)?total/i.test(at(row, matrix!.col(/criterion/i)))).slice(0, 40).map((row) => {
    const weight = leadingNumber(at(row, matrix!.col(/weight/i)));
    return {
      criterion: clip(at(row, matrix!.col(/criterion/i)), 120), definition: clip(at(row, matrix!.col(/definition/i)), 300), ...(weight !== undefined ? { weight } : {}),
      scores: coaColumns.map((entry) => { const cell = at(row, entry.index); const score = leadingNumber(cell); return { ...(score !== undefined ? { score } : {}), text: clip(cell, 300) }; })
    };
  });
  const totalsRaw = coas.map((coa, index) => ({ coa, total: Number(criteria.reduce((sum, row) => sum + (row.weight ?? 0) * (row.scores[index]?.score ?? 0), 0).toFixed(2)) }));
  const top = Math.max(...totalsRaw.map((entry) => entry.total), Number.NEGATIVE_INFINITY);
  const totals = totalsRaw.map((entry) => ({ ...entry, best: totalsRaw.length > 1 && entry.total === top && totalsRaw.filter((other) => other.total === top).length === 1 }));
  const approvalOf = (product: string) => {
    const view = find(ctx, product);
    const signed = view?.history.find((item) => item.to === 'approved' && item.actor.kind === 'person');
    return view && signed && signed.actor.kind === 'person' ? { by: clip(`${signed.actor.name} (${signed.actor.role})`, CAP.short), at: signed.at, product, version: signed.version } : undefined;
  };
  const approval = approvalOf('coa-evaluation-criteria') ?? approvalOf('mission-analysis-brief');
  const comparisonView = find(ctx, 'comparison-matrix');

  // The wargame ledger: each game (a COA against an adversary COA), turn by turn, action, reaction, counteraction.
  let wargame: J5Workspace['wargame'];
  const source = ctx.input.wargame;
  if (source && 'unreadable' in source) wargame = { total: 0, games: [], problem: clip(`The wargame ledger cannot be read whole, so it is not shown: ${source.unreadable}`) };
  else {
    const entries = (source?.entries ?? []).slice(-CAP.wargame);
    const games = new Map<string, WargameEntry[]>();
    for (const entry of entries) games.set(`${entry.coa}\u0000${entry.enemyCoa}`, [...(games.get(`${entry.coa}\u0000${entry.enemyCoa}`) ?? []), entry]);
    wargame = {
      total: source?.entries.length ?? 0,
      games: [...games.values()].map((game) => {
        const turns = new Map<number, WargameEntry[]>();
        for (const entry of game) turns.set(entry.turn, [...(turns.get(entry.turn) ?? []), entry]);
        const last = game[game.length - 1];
        const next = last.phase === 'counteraction' ? `turn ${last.turn + 1} ACTION` : `turn ${last.turn} ${last.phase === 'action' ? 'REACTION' : 'COUNTERACTION'}`;
        return {
          coa: clip(last.coa, 60), enemyCoa: clip(last.enemyCoa, 60), next,
          turns: [...turns.entries()].map(([turn, phases]) => ({
            turn, when: hHour(phases[0].hHourOffsetMinutes),
            phases: phases.map((entry) => ({
              phase: entry.phase, side: PHASE_SIDE[entry.phase], moves: entry.moves.slice(0, 10).map((move) => clip(move.unit, 80)), results: entry.results.slice(0, 10).map((line) => clip(line, 300)),
              decisionPoints: entry.decisionPoints.slice(0, 10).map((point) => clip(`${point.id}: ${point.description} (decides: ${point.decisionMaker})`, 300)), recordedBy: clip(entry.recordedBy, 60), at: entry.at
            }))
          }))
        };
      })
    };
  }

  // The decision brief, the recommendation the agents drafted, and every dissent as written.
  const briefView = find(ctx, 'coa-decision-brief');
  const briefBody = bodies['coa-decision-brief'] ?? '';
  const recommendation = (() => {
    // The first paragraph under a heading that names the recommendation, or a "Recommendation:" line.
    const lines = briefBody.replace(/\r\n/g, '\n').split('\n');
    const heading = lines.findIndex((line) => /^#{1,6}\s.*recommend/i.test(line));
    if (heading >= 0) {
      const rest = lines.slice(heading + 1);
      const start = rest.findIndex((line) => line.trim() !== '');
      if (start >= 0 && !/^#{1,6}\s/.test(rest[start])) {
        const end = rest.findIndex((line, index) => index > start && (line.trim() === '' || /^#{1,6}\s/.test(line)));
        return clip(rest.slice(start, end < 0 ? undefined : end).join(' ').replace(/\s+/g, ' ').trim(), CAP.text);
      }
    }
    const line = /^\s*(?:\*\*)?Recommendation(?:\*\*)?\s*:\s*(.+)$/im.exec(briefBody);
    return line ? clip(line[1].trim(), CAP.text) : '';
  })();
  const queued = ctx.decisions.find((entry) => entry.product === 'coa-decision-brief');
  const redTeam = find(ctx, 'red-team-critique');

  // The annex tracker, held to the ledger by the orders tool's own consistency check.
  const tracker = ctx.input.registers?.annexTracker ?? [];
  const entries = tracker.map((row) => ({ subject: String(row.subject ?? ''), ...(row.letter !== undefined ? { letter: String(row.letter) } : {}), ...(row.product !== undefined ? { product: String(row.product) } : {}), ...(row.owner !== undefined ? { owner: String(row.owner) } : {}) }));
  const findings = tracker.length ? checkAnnexes(ctx.profile, entries, ctx.input.facts ?? new Map()) : [];
  const blockingKinds = new Set(blocking(findings));
  const annexRows = tracker.slice(0, CAP.rows).map((row) => {
    const subject = String(row.subject ?? '');
    const own = findings.filter((finding) => finding.subject === subject);
    const product = row.product === undefined ? '' : String(row.product);
    const fact = product ? ctx.input.facts?.get(product) : undefined;
    return {
      id: str(row, 'id', 40), subject: clip(subject, 80), letter: str(row, 'letter', 8), owner: str(row, 'owner', 64), status: str(row, 'status', 20), product: clip(product, 120),
      state: fact ? `${fact.state} v${fact.version}` : product ? 'not in the ledger' : 'no product yet', findings: own.map((finding) => clip(finding.message, 300)), blocked: own.some((finding) => blockingKinds.has(finding))
    };
  });
  // In letter order as the profile files them (A to Z, then AA; a numbered COPD sub-annex such as SS2 after its annex); rows with no letter last.
  annexRows.sort((a, b) => (a.letter && b.letter ? compareLetters(a.letter, b.letter) : a.letter ? -1 : b.letter ? 1 : 0));
  const trackerView = find(ctx, 'annex-tracker');

  return {
    tests, cells,
    comparison: { coas, criteria, totals, ...(approval ? { approval } : {}), ...(comparisonView ? { product: productOf(ctx, comparisonView) } : {}) },
    wargame,
    brief: {
      ...(briefView ? { product: productOf(ctx, briefView) } : {}), recommendation, dissent: (queued?.dissent ?? []).slice(0, 20).map((line) => clip(line, 500)),
      ...(redTeam ? { redTeam: productOf(ctx, redTeam) } : {}), ...(queued ? { decisionFor: clip(queued.decisionFor, 80) } : {})
    },
    annexes: { rows: annexRows, findings: findings.length, blocking: blockingKinds.size, ...(trackerView ? { product: productOf(ctx, trackerView) } : {}) },
    products: sectionProducts(ctx, 'j5'), activity: sectionActivity(ctx, 'j5'), problems
  };
}

// ---- J3 -----------------------------------------------------------------------------------------------------------------------------------------------

const SYNC_ORDER = ['enemy', 'collection', 'manoeuvre', 'fires', 'sustainment', 'information', 'protection', 'decision-points'];

/** The words shown for an event whose repeat the room does not know, in place of a date it would get wrong. */
export const REPEAT_NOT_SHOWN = 'repeat not shown';

/**
 * The next time a battle rhythm event happens at or after `now`, or undefined when a one-off event is over (or its start is not a time). A repeat the
 * battle rhythm does not define (BATTLE_RHYTHM_REPEAT_DAYS) gives 'unknown' once its first start has passed: the room says "repeat not shown" rather than
 * guess a date.
 */
export function nextOccurrence(start: string, repeat: string, now: number): number | 'unknown' | undefined {
  const first = Date.parse(start);
  if (!Number.isFinite(first)) return undefined;
  if (first >= now) return first;
  const days = Object.prototype.hasOwnProperty.call(BATTLE_RHYTHM_REPEAT_DAYS, repeat) ? BATTLE_RHYTHM_REPEAT_DAYS[repeat as keyof typeof BATTLE_RHYTHM_REPEAT_DAYS] : undefined;
  if (days === undefined) return 'unknown';
  if (days === 0) return undefined;
  const step = days * 86_400_000;
  return first + Math.ceil((now - first) / step) * step;
}

function buildJ3(ctx: WorkspaceContext): J3Workspace {
  const registers = ctx.input.registers ?? {};
  const log = [...(registers.eventLog ?? [])].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const matchedDps = new Set(log.map((row) => String(row.decisionPoint ?? '').trim().toLowerCase()).filter(Boolean));
  const eventLog = {
    total: log.length, escalated: log.filter((row) => row.status === 'escalated').length,
    rows: log.slice(0, CAP.rows).map((row) => ({ id: str(row, 'id', 40), time: str(row, 'time', 30), source: str(row, 'source', 120), report: str(row, 'report'), ccir: str(row, 'ccir', 40), decisionPoint: str(row, 'decisionPoint', 40), status: str(row, 'status', 20) }))
  };
  const ccir = (registers.ccir ?? []).slice(0, CAP.rows).map((row) => ({ id: str(row, 'id', 40), type: str(row, 'type', 8), requirement: str(row, 'requirement'), decisionPoint: str(row, 'decisionPoint', 160), status: str(row, 'status', 20), ltiov: str(row, 'ltiov', 30) }));
  const triggers = ctx.events.filter((event): event is Extract<StaffEvent, { type: 'staff.ccir.triggered' }> => event.type === 'staff.ccir.triggered').slice(-20).reverse()
    .map((event) => ({ at: event.at, ccir: clip(event.ccir, 40), report: clip(event.report, 300), member: clip(event.member, 60) }));
  const dsm = {
    owner: registerOwner(ctx, 'dst-dsm'),
    rows: (ctx.dsm ?? []).slice(0, CAP.rows).map((row) => ({
      id: str(row, 'id', 40), description: str(row, 'description', 300), indicator: str(row, 'indicator', 300), nai: str(row, 'nai', 80), pir: str(row, 'pir', 40), action: str(row, 'recommendedAction', 300),
      maker: str(row, 'decisionMaker', 80), coa: str(row, 'coa', 40), matched: matchedDps.has(String(row.id).trim().toLowerCase())
    }))
  };
  const syncRows = registers.syncMatrix ?? [];
  const offsets = syncRows.map((row) => Number(row.hHourOffsetMinutes)).filter(Number.isFinite);
  const grouped = new Map<string, Array<J3Workspace['sync']['rows'][number]['cells'][number]>>();
  for (const row of syncRows.slice(0, CAP.rows)) {
    const key = String(row.row);
    grouped.set(key, [...(grouped.get(key) ?? []), { id: str(row, 'id', 40), offset: Number(row.hHourOffsetMinutes) || 0, entry: str(row, 'entry', 300), section: str(row, 'section', 20), coa: str(row, 'coa', 40) }]);
  }
  const sync = {
    owner: registerOwner(ctx, 'sync-matrix'), total: syncRows.length, from: offsets.length ? Math.min(...offsets) : 0, to: offsets.length ? Math.max(...offsets) : 0,
    rows: [...grouped.entries()].sort((a, b) => SYNC_ORDER.indexOf(a[0]) - SYNC_ORDER.indexOf(b[0])).map(([row, cells]) => ({ row, cells: cells.sort((a, b) => a.offset - b.offset) }))
  };
  const fragos = ctx.registry.filter((view) => /(^|-)frago(-|$)/.test(view.product) || (view.section === 'j3' && view.kind === 'order')).slice(0, CAP.products).map((view) => productOf(ctx, view));
  const rhythmView = find(ctx, 'battle-rhythm-calendar');
  const rhythm = {
    // An event whose repeat the room does not know comes last, with no date and "repeat not shown" (next is then empty).
    events: (registers.battleRhythm ?? []).map((row) => ({ row, next: nextOccurrence(String(row.start), String(row.repeat), ctx.now) }))
      .filter((entry): entry is { row: RegisterRow; next: number | 'unknown' } => entry.next !== undefined)
      .sort((a, b) => (a.next === 'unknown' ? Number.MAX_SAFE_INTEGER : a.next) - (b.next === 'unknown' ? Number.MAX_SAFE_INTEGER : b.next)).slice(0, 40)
      .map(({ row, next }) => ({ id: str(row, 'id', 40), title: str(row, 'title', 160), kind: str(row, 'kind', 20), next: next === 'unknown' ? '' : new Date(next).toISOString(), minutes: Number(row.durationMinutes) || 0, repeat: next === 'unknown' ? REPEAT_NOT_SHOWN : str(row, 'repeat', 10), chair: str(row, 'chair', 80), inputs: str(row, 'inputs', 300), outputs: str(row, 'outputs', 300) })),
    ...(rhythmView ? { product: productOf(ctx, rhythmView) } : {})
  };
  const suspenses = (registers.rfi ?? []).filter((row) => row.status === 'open').sort((a, b) => String(a.suspense).localeCompare(String(b.suspense))).slice(0, CAP.rows)
    .map((row) => ({ id: str(row, 'id', 40), from: str(row, 'from', 20), to: str(row, 'to', 20), question: str(row, 'question', 300), suspense: str(row, 'suspense', 30), overdue: Date.parse(String(row.suspense)) < ctx.now }));
  return { eventLog, ccir, triggers, dsm, sync, frago: FRAGMENTARY_ORDER.abbreviation[ctx.profile], fragos, rhythm, suspenses, products: sectionProducts(ctx, 'j3'), activity: sectionActivity(ctx, 'j3'), problems: [] };
}

// ---- J4 -----------------------------------------------------------------------------------------------------------------------------------------------

const STALE_MS = 24 * 3_600_000;

function calcResult(record: CalcRecord): string {
  if (record.kind === 'consumption') return `${record.unit}: ${formatNumber(record.daily)} per day, ${formatNumber(record.total)} over ${formatNumber(record.days)} days${record.daysOfSupply !== undefined ? `; ${formatNumber(record.daysOfSupply)} days of supply on hand` : ''}`;
  if (record.kind === 'readiness') return record.byEquipment.slice(0, 6).map((entry) => `${entry.equipment} ${formatNumber(entry.percent)} percent ready (${entry.ready} of ${entry.onHand})`).join('; ');
  const late = record.serials.filter((serial) => !serial.liftFeasible || !serial.timeFeasible).length;
  return `${record.serials.length} serial${record.serials.length === 1 ? '' : 's'}${late ? `, ${late} not feasible` : ', all feasible'}`;
}

function supportLevel(judgement: string): 'ok' | 'risk' | 'bad' | 'unknown' {
  if (/\bnot supportable\b|\bunsupportable\b|\binfeasible\b|\bculminat/i.test(judgement)) return 'bad';
  if (/\brisk\b|\bwith (?:risk|mitigation)\b|\bmarginal\b|\bshort/i.test(judgement)) return 'risk';
  if (/\bsupportable\b|\bfeasible\b/i.test(judgement)) return 'ok';
  return 'unknown';
}

/** The profile's name for the logistics annex, from its annex list (Logistics, or Sustainment under the US Army profile). */
function logisticsAnnexName(profile: StaffProfileId): string {
  const placement = DOCTRINE_PROFILES[profile].annexes.logistics;
  return placement.kind === 'annex' ? `${placement.title} annex` : 'Logistics annex';
}

/** A J4 annex product's title in the profile's words: its letter and title, where movements go in a profile with no movements annex, and the profile's
 * name for the concept of support (COLS under US Joint). */
function j4AnnexTitle(ctx: WorkspaceContext, product: string): string {
  if (product === 'concept-of-support') return LOGISTICS_TERMS[ctx.profile].conceptOfSupport;
  const annexes = DOCTRINE_PROFILES[ctx.profile].annexes;
  const placement = product === 'logistics-annex' ? annexes.logistics : product === 'movements-annex' ? annexes.movements : undefined;
  if (!placement) return titleOf(ctx, product);
  if (placement.kind === 'annex') return `Annex ${placement.letter} (${placement.title})`;
  if (placement.kind === 'appendix') return `${titleOf(ctx, product)} (an appendix to Annex ${placement.toAnnex})`;
  if (placement.kind === 'within') return `${titleOf(ctx, product)} (part of Annex ${placement.annex})`;
  return clip(`${titleOf(ctx, product)}: ${placement.note}`, CAP.short);
}

function buildJ4(ctx: WorkspaceContext): J4Workspace {
  const logistics = ctx.input.logistics;
  const records = new Map((logistics?.records ?? []).map((record) => [record.id, record]));
  const bands = logistics?.bands ?? [];
  const consolidated = consolidateLogstat(logistics?.reports ?? [], records, bands);
  const units = new Map<string, J4Workspace['logstat']['units'][number] & { lines: Array<J4Workspace['logstat']['units'][number]['lines'][number]> }>();
  const colourOf = (band: string): string => (/^RED\b/.test(band) ? 'red' : /^AMBER\b/.test(band) ? 'amber' : /^GREEN\b/.test(band) ? 'green' : 'none');
  const rank = { red: 3, amber: 2, green: 1, none: 0 } as Record<string, number>;
  for (const row of consolidated.rows.slice(0, CAP.rows)) {
    const unit = units.get(row.unit) ?? { unit: clip(row.unit, 80), report: clip(row.report, 60), band: 'none', lines: [] };
    const band = colourOf(row.band);
    unit.lines.push({
      commodity: clip(row.line.carriedFor ? `${row.line.commodity} (carried for ${row.line.carriedFor})` : row.line.commodity, 120), uom: clip(row.line.uom, 30), onHand: formatNumber(row.line.onHand), capacity: formatNumber(row.line.capacity),
      daysOfSupply: row.line.daysOfSupply !== undefined ? formatNumber(row.line.daysOfSupply) : '', band, words: clip(row.band, 300), forecast: clip(row.againstForecast ?? '', 300), calc: clip(row.line.calc ?? '', 60)
    });
    if (rank[band] > rank[unit.band]) units.set(row.unit, { ...unit, band }); else units.set(row.unit, unit);
  }
  const verified = new Set(records.keys());
  const sorted = [...records.values()].sort((a, b) => b.at.localeCompare(a.at));
  const calcs = sorted.slice(0, CAP.calcs).map((record) => ({
    id: record.id, kind: record.kind, title: clip(record.title, 160), by: clip(record.computedBy, 60), at: record.at, result: clip(calcResult(record), CAP.text), formula: record.formula.slice(0, CAP.formula).map((line) => clip(line, 300))
  }));
  const board = movementBoard(sorted.filter((record): record is MovementRecord => record.kind === 'movement'));
  const movement = board.rows.slice(0, CAP.rows).map((row) => ({
    table: row.table, serial: clip(row.serial.serial, 40), what: clip(row.serial.what, 160), mode: row.serial.mode, from: clip(row.serial.from, 80), to: clip(row.serial.to, 80), arrives: row.serial.arrives, required: row.serial.required, feasible: row.feasible,
    why: row.feasible ? `Feasible, ${formatNumber(row.serial.slackHours)} h to spare` : [row.serial.liftFeasible ? '' : 'lift short', row.serial.timeFeasible ? '' : `${formatNumber(-row.serial.slackHours)} h late`].filter(Boolean).join(', ')
  }));
  // Readiness: the newest record per equipment type, flagged when its data is older than a day.
  const readiness = new Map<string, J4Workspace['readiness'][number]>();
  for (const record of sorted.filter((candidate): candidate is ReadinessRecord => candidate.kind === 'readiness')) {
    for (const entry of record.byEquipment) {
      if (readiness.has(entry.equipment)) continue;
      // The oldest report behind the figure decides whether it is stale.
      const asOf = record.lines.filter((line) => line.equipment === entry.equipment).map((line) => line.asOf).sort()[0] ?? record.at;
      readiness.set(entry.equipment, { equipment: clip(entry.equipment, 80), onHand: entry.onHand, ready: entry.ready, percent: entry.percent, asOf, stale: ctx.now - Date.parse(asOf) > STALE_MS, record: record.id });
    }
  }
  const tracker = ctx.input.registers?.annexTracker ?? [];
  const annexes = ['logistics-annex', 'movements-annex', 'concept-of-support'].map((product) => ({ product, view: find(ctx, product), row: tracker.find((row) => row.product === product) }))
    .filter((entry) => entry.view || entry.row).map(({ product, view, row }) => ({
      product, title: j4AnnexTitle(ctx, product), state: view?.display ?? 'not proposed yet', pill: view ? PILL[view.display] ?? 'draft' : 'draft', version: view?.version ?? 0, owner: clip(view?.owner ?? String(row?.owner ?? ''), 60),
      tracker: row ? clip(`Annex tracker: ${row.letter ? `Annex ${String(row.letter)}, ` : ''}${String(row.status)}`, 120) : 'Not on the annex tracker yet'
    }));
  const support = tableWith((ctx.input.bodies ?? {})['coa-supportability'], [/course of action|^COA$/i, /judgement/i]);
  const supportability = (support?.table.rows ?? []).slice(0, CAP.rows).map((row) => {
    const judgement = clip(at(row, support!.col(/judgement/i)), 300);
    const calc = at(row, support!.col(/calculator/i)).replace(/^calc:/i, '').trim();
    return {
      coa: clip(at(row, support!.col(/course of action|^COA$/i)), 60), fn: clip(at(row, support!.col(/function/i)), 80), judgement, culminates: clip(at(row, support!.col(/runs out|culminat/i)), 300),
      calc: clip(calc, 60), verified: calc !== '' && verified.has(calc), level: supportLevel(judgement)
    };
  });
  return {
    logstat: { reports: logistics?.reports.length ?? 0, units: [...units.values()], heldOut: consolidated.heldOut.slice(0, CAP.rows).map((entry) => ({ unit: clip(entry.unit, 80), report: clip(entry.report, 60), rules: entry.rules.map(String) })) },
    calcs, calcProblems: [...(logistics?.ledgerProblem ? [clip(logistics.ledgerProblem)] : []), ...(logistics?.recordProblems ?? []).slice(0, 10).map((problem) => clip(problem))],
    movement, readiness: [...readiness.values()].slice(0, CAP.rows), annexName: logisticsAnnexName(ctx.profile), annexes, supportability,
    products: sectionProducts(ctx, 'j4'), activity: sectionActivity(ctx, 'j4'), problems: []
  };
}

/** The three section workspaces. Problems reading the project are shown in the section they belong to, or in each when they belong to all. */
export function buildSectionWorkspaces(ctx: WorkspaceContext): SectionWorkspaces {
  const shared = (ctx.input.problems ?? []).slice(0, 10).map((problem) => clip(problem, 300));
  const j5 = buildJ5(ctx);
  const j3 = buildJ3(ctx);
  const j4 = buildJ4(ctx);
  return { j5: { ...j5, problems: [...j5.problems, ...shared] }, j3: { ...j3, problems: [...j3.problems, ...shared] }, j4: { ...j4, problems: [...j4.problems, ...shared] } };
}
