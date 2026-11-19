// The structured staff registers (design 10, 3.1, 4.3 and 4.5; WP-SHARED): the CCIR register, the PIR register, the RFI tracker, the facts and
// assumptions ledger, the annex tracker, the synchronization matrix, the DST and DSM, the targeting workbook and the operations centre's event log.
// Pure: no I/O, no clock, no vscode.
//
// A register is a staff product like any other (a Markdown file with the staff header, through the release state machine). Its body is a table a person
// reads and, below it, the same rows as a fenced JSON block the tools read, so one file holds one version and one hash. Rows are checked against the
// register's columns here, which is what lets the gates check them mechanically (02 s3.5): every PIR has a decision point and a latest time of value,
// every assumption an invalidation trigger, every targeting row both review marks.
import type { StaffSectionId } from './doctrine';
import { STAFF_SECTION_IDS } from './doctrine';
import type { RfiAnsweredEvent, RfiOpenedEvent, RfiOverdueEvent } from './events';
import { isOneLine, isRecord, ownValue } from './parse';
import type { ProductKind } from './products';
import { STAFF_MARKERS } from './products';

export interface RegisterColumn {
  readonly key: string;
  readonly title: string;
  readonly required?: boolean;
  /** Allowed values; absent means any one line of text. */
  readonly values?: readonly string[];
  /** `time`: `YYYY-MM-DDTHH:MM:SSZ` or with milliseconds. `number`: a whole number. */
  readonly form?: 'time' | 'number';
}

export interface RegisterSchema {
  readonly register: string;
  readonly title: string;
  readonly kind: ProductKind;
  readonly columns: readonly RegisterColumn[];
  /** For a register with parts (the CCIR register): the column whose value names the part a row belongs to. */
  readonly partColumn?: string;
  /** Extra rules beyond the columns, each a plain sentence when broken. */
  readonly rules?: ReadonlyArray<(row: RegisterRow) => string | undefined>;
}

export type RegisterRow = Readonly<Record<string, string | number>>;

const SECTION_VALUES: readonly string[] = [...STAFF_SECTION_IDS];

/** The second mark every targeting row carries beside the legal review mark (design 10, 7 item 2: commander-or-delegate and legal review). */
export const COMMANDER_REVIEW_MARK = 'COMMANDER OR DELEGATE REVIEW REQUIRED';

/** The registers the staff-products tool keeps. A name outside this list is refused: a register is only checkable when its columns are known. */
export const REGISTER_SCHEMAS: Readonly<Record<string, RegisterSchema>> = {
  'ccir-register': {
    register: 'ccir-register', title: 'Commander\'s critical information requirements', kind: 'register', partColumn: 'type',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'type', title: 'Type', required: true, values: ['pir', 'ffir'] },
      { key: 'requirement', title: 'Requirement', required: true },
      { key: 'decisionPoint', title: 'Decision point supported', required: true },
      { key: 'ltiov', title: 'Latest time of value', form: 'time' },
      { key: 'reportTo', title: 'Report to' },
      { key: 'status', title: 'Status', required: true, values: ['proposed', 'active', 'answered', 'retired'] }
    ],
    rules: [(row) => (row.type === 'pir' && row.ltiov === undefined ? 'A PIR needs a latest time of value.' : undefined)]
  },
  'pir-register': {
    register: 'pir-register', title: 'PIR and IR register', kind: 'register',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'type', title: 'Type', required: true, values: ['pir', 'ir', 'sir'] },
      { key: 'requirement', title: 'Requirement', required: true },
      { key: 'decisionPoint', title: 'Decision point supported' },
      { key: 'indicators', title: 'Indicators' },
      { key: 'ltiov', title: 'Latest time of value', form: 'time' },
      { key: 'status', title: 'Status', required: true, values: ['proposed', 'active', 'answered', 'retired'] }
    ],
    // 02 T9: every PIR is tied to a decision point and a latest time of value.
    rules: [(row) => (row.type === 'pir' && (row.decisionPoint === undefined || row.ltiov === undefined) ? 'A PIR needs a decision point and a latest time of value.' : undefined)]
  },
  'rfi-tracker': {
    register: 'rfi-tracker', title: 'RFI tracker', kind: 'register', partColumn: 'part',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'part', title: 'Part', values: ['intelligence'] },
      { key: 'from', title: 'From', required: true, values: SECTION_VALUES },
      { key: 'to', title: 'To', required: true, values: [...SECTION_VALUES, 'higher'] },
      { key: 'question', title: 'Question', required: true },
      { key: 'suspense', title: 'Suspense', required: true, form: 'time' },
      { key: 'status', title: 'Status', required: true, values: ['open', 'answered', 'closed'] },
      { key: 'answer', title: 'Answer' }
    ],
    rules: [(row) => (row.status === 'answered' && row.answer === undefined ? 'An answered RFI needs its answer.' : undefined)]
  },
  'facts-assumptions-ledger': {
    register: 'facts-assumptions-ledger', title: 'Facts and assumptions', kind: 'register',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'kind', title: 'Kind', required: true, values: ['fact', 'assumption'] },
      { key: 'statement', title: 'Statement', required: true },
      { key: 'status', title: 'Status', required: true, values: ['valid', 'invalidated', 'unconfirmed', 'confirmed'] },
      { key: 'invalidationTrigger', title: 'Invalidation trigger' },
      { key: 'owner', title: 'Owner' },
      { key: 'source', title: 'Source' }
    ],
    // Design 10, 4.6: every assumption has an invalidation trigger; a fact has a source.
    rules: [
      (row) => (row.kind === 'assumption' && row.invalidationTrigger === undefined ? 'An assumption needs an invalidation trigger.' : undefined),
      (row) => (row.kind === 'fact' && row.source === undefined ? 'A fact needs a source.' : undefined)
    ]
  },
  'annex-tracker': {
    register: 'annex-tracker', title: 'Annex tracker', kind: 'register',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'subject', title: 'Subject', required: true },
      { key: 'letter', title: 'Letter' },
      { key: 'owner', title: 'Owner', required: true },
      { key: 'status', title: 'Status', required: true, values: ['not-started', 'drafting', 'in-review', 'done'] }
    ]
  },
  'sync-matrix': {
    register: 'sync-matrix', title: 'Synchronization matrix', kind: 'matrix',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'row', title: 'Row', required: true, values: ['enemy', 'collection', 'manoeuvre', 'fires', 'sustainment', 'information', 'protection', 'decision-points'] },
      { key: 'hHourOffsetMinutes', title: 'H-hour offset (min)', required: true, form: 'number' },
      { key: 'entry', title: 'Entry', required: true },
      { key: 'section', title: 'Section', values: SECTION_VALUES },
      { key: 'coa', title: 'COA' }
    ]
  },
  'dst-dsm': {
    register: 'dst-dsm', title: 'Decision support template and matrix', kind: 'matrix',
    columns: [
      { key: 'id', title: 'Decision point', required: true },
      { key: 'description', title: 'Decision', required: true },
      { key: 'indicator', title: 'Indicator' },
      { key: 'nai', title: 'NAI' },
      { key: 'pir', title: 'PIR' },
      { key: 'recommendedAction', title: 'Recommended action' },
      { key: 'decisionMaker', title: 'Decision maker', required: true },
      { key: 'coa', title: 'COA' }
    ]
  },
  'targeting-workbook': {
    register: 'targeting-workbook', title: 'Targeting workbook (notional targets in a fictional scenario)', kind: 'register',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'system', title: 'Target system', required: true },
      { key: 'function', title: 'Function', required: true },
      { key: 'priority', title: 'Priority', values: ['high-value', 'high-payoff', 'other'] },
      { key: 'legalReview', title: 'Legal review', required: true, values: [STAFF_MARKERS.legalReview] },
      { key: 'commanderReview', title: 'Commander review', required: true, values: [COMMANDER_REVIEW_MARK] }
    ]
  },
  // Design 10, 3.4 (joc-chief, watch-officer) and 03 A6, A14 item 7: the watch logs facts in a standard form (time, source, what was reported) and
  // flags matches against the CCIRs and the DSM's decision points; interpretation is the JOC chief's.
  'event-log': {
    register: 'event-log', title: 'Event log (operations centre)', kind: 'register',
    columns: [
      { key: 'id', title: 'ID', required: true },
      { key: 'time', title: 'Time (UTC)', required: true, form: 'time' },
      { key: 'source', title: 'Source', required: true },
      { key: 'report', title: 'What was reported', required: true },
      { key: 'ccir', title: 'CCIR matched' },
      { key: 'decisionPoint', title: 'Decision point matched' },
      { key: 'status', title: 'Status', required: true, values: ['logged', 'escalated', 'closed'] }
    ],
    rules: [(row) => (row.status === 'escalated' && row.ccir === undefined && row.decisionPoint === undefined ? 'An escalated entry names the CCIR or decision point it matched.' : undefined)]
  }
};

export const MAX_REGISTER_ROWS = 500;
const MAX_CELL = 500;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/;

export function registerSchema(register: string): RegisterSchema | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTER_SCHEMAS, register) ? REGISTER_SCHEMAS[register] : undefined;
}

export type RowCheck = { readonly ok: true; readonly row: RegisterRow } | { readonly ok: false; readonly message: string };

/** Checks one row against its register: only known columns, required ones present, allowed values, forms, and the register's own rules. */
export function checkRow(schema: RegisterSchema, raw: unknown): RowCheck {
  if (!isRecord(raw)) return { ok: false, message: 'A row must be a set of named fields.' };
  const out: Record<string, string | number> = {};
  for (const key of Object.keys(raw)) {
    const column = schema.columns.find((entry) => entry.key === key);
    if (!column) return { ok: false, message: `${schema.register} has no column "${key.slice(0, 40)}". Its columns are ${schema.columns.map((entry) => entry.key).join(', ')}.` };
    const value = ownValue(raw, key);
    if (value === undefined || value === null || value === '') continue;
    if (column.form === 'number') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { ok: false, message: `${column.key} must be a whole number.` };
      out[key] = value;
      continue;
    }
    if (!isOneLine(value, MAX_CELL)) return { ok: false, message: `${column.key} must be one line of text, at most ${MAX_CELL} characters.` };
    const text = value.trim();
    if (column.values && !column.values.includes(text)) return { ok: false, message: `${column.key} must be one of: ${column.values.join(', ')}.` };
    if (column.form === 'time' && !TIME.test(text)) return { ok: false, message: `${column.key} must be a time like 2026-11-18T14:00Z.` };
    out[key] = text;
  }
  for (const column of schema.columns) if (column.required && out[column.key] === undefined) return { ok: false, message: `Every ${schema.register} row needs ${column.key}.` };
  if (!ROW_ID.test(String(out.id))) return { ok: false, message: 'A row id is letters, digits, dots, dashes or underscores, at most 40 characters.' };
  for (const rule of schema.rules ?? []) {
    const broken = rule(out);
    if (broken) return { ok: false, message: `Row ${String(out.id)}: ${broken}` };
  }
  return { ok: true, row: out };
}

export type RowsResult = { readonly ok: true; readonly rows: readonly RegisterRow[] } | { readonly ok: false; readonly message: string };

/**
 * Applies a write to a register: each row replaces the row with the same id or is added, and `remove` drops rows by id. A writer of one part (the J2
 * requirements manager on the CCIR register's PIR rows) may only add, change or remove rows of that part. The result is checked as a whole.
 */
export function writeRows(schema: RegisterSchema, current: readonly RegisterRow[], rows: readonly unknown[], remove: readonly string[], part?: string): RowsResult {
  const next = new Map(current.map((row) => [String(row.id), row]));
  const inPart = (row: RegisterRow | undefined): boolean => part === undefined || row === undefined || (schema.partColumn !== undefined && row[schema.partColumn] === part);
  for (const id of remove) {
    if (!inPart(next.get(id))) return { ok: false, message: `Row ${id} is not in the ${part} part, so you cannot remove it.` };
    next.delete(id);
  }
  for (const raw of rows) {
    const checked = checkRow(schema, raw);
    if (!checked.ok) return checked;
    const id = String(checked.row.id);
    if (!inPart(checked.row) || !inPart(next.get(id))) return { ok: false, message: `Row ${id} is not in the ${part} part, which is the only part you write.` };
    next.set(id, checked.row);
  }
  if (next.size > MAX_REGISTER_ROWS) return { ok: false, message: `A register holds at most ${MAX_REGISTER_ROWS} rows.` };
  return { ok: true, rows: [...next.values()] };
}

// ---- The register body: a table and its rows ---------------------------------------------------------------------------------------------------

const FENCE_OPEN = '```json staff-register';

function cell(value: string | number | undefined): string {
  return value === undefined ? '' : String(value).replace(/\|/g, '\\|');
}

/** The product body of a register: its title, a table a person reads, and the rows as JSON the tools read. */
export function renderRegisterBody(schema: RegisterSchema, rows: readonly RegisterRow[]): string {
  const head = `| ${schema.columns.map((column) => column.title).join(' | ')} |`;
  const rule = `| ${schema.columns.map(() => '---').join(' | ')} |`;
  const lines = rows.map((row) => `| ${schema.columns.map((column) => cell(row[column.key])).join(' | ')} |`);
  const data = JSON.stringify({ register: schema.register, rows }, null, 2);
  return [`# ${schema.title}`, '', ...(rows.length ? [head, rule, ...lines] : ['No rows yet.']), '', 'The rows below are the data the staff tools read. Change them through the staff-products tool.', '', FENCE_OPEN, data, '```', ''].join('\n');
}

/** The rows of a register body, checked; undefined when the body holds no register block or a row does not pass. */
export function parseRegisterBody(schema: RegisterSchema, body: string): RegisterRow[] | undefined {
  const start = body.indexOf(`${FENCE_OPEN}\n`);
  if (start < 0) return undefined;
  const from = start + FENCE_OPEN.length + 1;
  const end = body.indexOf('\n```', from);
  if (end < 0) return undefined;
  let data: unknown;
  try { data = JSON.parse(body.slice(from, end)); } catch { return undefined; }
  if (!isRecord(data) || ownValue(data, 'register') !== schema.register || !Array.isArray(ownValue(data, 'rows'))) return undefined;
  const rows: RegisterRow[] = [];
  for (const raw of ownValue(data, 'rows') as unknown[]) {
    const checked = checkRow(schema, raw);
    if (!checked.ok) return undefined;
    rows.push(checked.row);
  }
  return rows;
}

// ---- RFI events --------------------------------------------------------------------------------------------------------------------------------

type RfiEvent = RfiOpenedEvent | RfiAnsweredEvent | RfiOverdueEvent;

function rfiFields(row: RegisterRow): { rfi: string; from: StaffSectionId; to: StaffSectionId | 'higher'; suspense: string } {
  return { rfi: String(row.id), from: row.from as StaffSectionId, to: row.to as StaffSectionId | 'higher', suspense: String(row.suspense) };
}

/** The RFI events one write of the tracker causes: a new open row is opened, a row that became answered is answered. */
export function rfiChanges(before: readonly RegisterRow[], after: readonly RegisterRow[], run: string, at: string): RfiEvent[] {
  const previous = new Map(before.map((row) => [String(row.id), row]));
  const events: RfiEvent[] = [];
  for (const row of after) {
    const old = previous.get(String(row.id));
    if (!old && row.status !== 'closed') events.push({ type: 'staff.rfi.opened', run, at, ...rfiFields(row) });
    if (row.status === 'answered' && old?.status !== 'answered') events.push({ type: 'staff.rfi.answered', run, at, ...rfiFields(row) });
  }
  return events;
}

/** Open RFIs whose suspense has passed at `nowMs`, as overdue events. The host sends each one once per RFI and suspense. */
export function overdueRfis(rows: readonly RegisterRow[], nowMs: number, run: string, at: string): RfiOverdueEvent[] {
  return rows.filter((row) => row.status === 'open' && Date.parse(String(row.suspense)) < nowMs).map((row) => ({ type: 'staff.rfi.overdue', run, at, ...rfiFields(row) }));
}
