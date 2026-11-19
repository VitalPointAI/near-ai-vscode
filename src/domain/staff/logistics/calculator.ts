// The consumption calculator (design 10, 6.2; research note 03, B5, B8 and B12 item 1; WP-LOG). Pure: no I/O, no clock, no vscode.
//
// Language models produce plausible but false consumption rates (03 B12 item 1), so the calculator never takes a rate from an agent. A rate is a planning
// factor a named person entered in the project's factor file (.planning/.near-ai/staff-factors.json, which an agent must ask before changing); the agent
// names the factor and gives the force list and the days. The calculator multiplies, shows the formula with every input on every result, and keeps the
// result as a calculator record that a product cites as calc:<id>. The extension ships no planning factor table of any kind, government or otherwise:
// with no factor file, the calculator refuses and says how a person adds one.
//
// Three kinds of record come from the logistics server, and all three are calculator records a product can cite: a consumption calculation, a readiness
// import (readiness.ts) and a notional movement table check (movement.ts). Each holds its formula lines, so calc_read shows the working for any of them.
import { createHash } from 'node:crypto';
import { STAFF_TEMPLATE_LABELS } from '../doctrine';
import { checkStaffKeys, isOneLine, isRecord, ownValue, STAFF_SLUG } from '../parse';

/** The factor file a person keeps; an agent must ask before writing anything under .planning/.near-ai. */
export const FACTORS_FILE = '.planning/.near-ai/staff-factors.json';
/** Where the calculator keeps its records, one JSON file per record (`<id>.json`), the folder guard-scan reads. */
export const CALCULATOR_RECORD_DIR = '.planning/staff/calculator';
export const CALC_RECORD_VERSION = 1;
export const CALC_RECORD_KINDS = ['consumption', 'readiness', 'movement'] as const;
export type CalcRecordKind = (typeof CALC_RECORD_KINDS)[number];

const MAX_FACTORS = 500;
const MAX_LINES = 100;
const MAX_RATE = 1e9;
const MAX_COUNT = 1e7;
const MAX_DAYS = 3650;

export type CalcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };
const fail = <T>(message: string): CalcResult<T> => ({ ok: false, message });
const done = <T>(value: T): CalcResult<T> => ({ ok: true, value });

/** One planning factor a person entered: a rate per unit per day, in one unit of measure. */
export interface PlanningFactor {
  readonly id: string;
  /** What the rate is for, in a line: "Fuel for one cargo truck". */
  readonly what: string;
  readonly rate: number;
  /** The unit of the rate's quantity: litres, rations, short tons. */
  readonly unit: string;
  /** What the rate is per, read after "per": "vehicle per day", "person per day". */
  readonly per: string;
  /** The named person who entered it. */
  readonly enteredBy: string;
  readonly note?: string;
}

/** The text a person writes to start the factor file, with one example factor, for the calculator's refusal and the calc_factors tool. */
export const FACTORS_EXAMPLE = JSON.stringify({
  factors: [{ id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 0, unit: 'litres', per: 'vehicle per day', enteredBy: 'Your name', note: 'Exercise value; replace 0 with the rate you plan with.' }]
}, null, 2);

const finiteIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Reads the factor file strictly: every field checked, nothing unknown kept, ids unique. */
export function parseFactors(text: string): CalcResult<PlanningFactor[]> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(`${FACTORS_FILE} is not valid JSON.`); }
  if (!isRecord(value) || checkStaffKeys(value, '', ['factors'])) return fail(`${FACTORS_FILE} is an object with one field, "factors", a list.`);
  const list = ownValue(value, 'factors');
  if (!Array.isArray(list) || list.length > MAX_FACTORS) return fail(`"factors" in ${FACTORS_FILE} is a list of at most ${MAX_FACTORS} factors.`);
  const out: PlanningFactor[] = [];
  for (const [index, item] of list.entries()) {
    const where = `factor ${index + 1} in ${FACTORS_FILE}`;
    if (!isRecord(item) || checkStaffKeys(item, '', ['id', 'what', 'rate', 'unit', 'per', 'enteredBy'], ['note'])) return fail(`${where} has fields id, what, rate, unit, per, enteredBy and an optional note, and nothing else.`);
    const id = ownValue(item, 'id');
    if (typeof id !== 'string' || !STAFF_SLUG.test(id)) return fail(`${where}: id is lower case letters, digits and dashes.`);
    if (out.some((factor) => factor.id === id)) return fail(`${where}: the id ${id} is used twice.`);
    const rate = ownValue(item, 'rate');
    if (!finiteIn(rate, 0, MAX_RATE)) return fail(`${where} (${id}): rate is a number from 0 to ${MAX_RATE}.`);
    for (const [key, max] of [['what', 200], ['unit', 40], ['per', 60], ['enteredBy', 120]] as const) {
      if (!isOneLine(ownValue(item, key), max)) return fail(`${where} (${id}): ${key} is one line of at most ${max} characters.`);
    }
    const note = ownValue(item, 'note');
    if (note !== undefined && !isOneLine(note, 300)) return fail(`${where} (${id}): note is one line of at most 300 characters.`);
    out.push({
      id, rate, what: (ownValue(item, 'what') as string).trim(), unit: (ownValue(item, 'unit') as string).trim(), per: (ownValue(item, 'per') as string).trim(),
      enteredBy: (ownValue(item, 'enteredBy') as string).trim(), ...(typeof note === 'string' ? { note: note.trim() } : {})
    });
  }
  return done(out);
}

/** A number as the formula shows it: grouped thousands, at most two decimals, the same on every machine. */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [whole, fraction] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = fraction.replace(/0+$/, '');
  return `${rounded < 0 ? '-' : ''}${grouped}${tail ? `.${tail}` : ''}`;
}

// ---- Records -----------------------------------------------------------------------------------------------------------------------------------

/** What every calculator record carries, whatever its kind. */
export interface CalcRecordBase {
  readonly v: typeof CALC_RECORD_VERSION;
  readonly id: string;
  readonly kind: CalcRecordKind;
  readonly title: string;
  readonly label: string;
  /** The member whose call computed it, and the run. */
  readonly computedBy: string;
  readonly run: string;
  readonly at: string;
  /** The working, one line each, exactly as every result shows it. */
  readonly formula: readonly string[];
}

export interface ConsumptionLine {
  readonly factor: string;
  readonly what: string;
  readonly rate: number;
  readonly per: string;
  readonly enteredBy: string;
  readonly count: number;
  /** What was counted, as the force list names it: "cargo trucks". */
  readonly item: string;
  readonly daily: number;
}

export interface ConsumptionRecord extends CalcRecordBase {
  readonly kind: 'consumption';
  readonly unit: string;
  readonly days: number;
  readonly lines: readonly ConsumptionLine[];
  /** The requirement per day, and over the days. */
  readonly daily: number;
  readonly total: number;
  readonly onHand?: number;
  readonly daysOfSupply?: number;
}

/** A readiness line (readiness.ts): one equipment type of one unit, as imported. */
export interface ReadinessLine {
  readonly unit: string;
  readonly equipment: string;
  readonly onHand: number;
  readonly ready: number;
  readonly asOf: string;
}

export interface ReadinessRecord extends CalcRecordBase {
  readonly kind: 'readiness';
  /** The project file the data came from, and its SHA-256, so the summary can say where every figure came from. */
  readonly source: { readonly file: string; readonly sha256: string };
  readonly lines: readonly ReadinessLine[];
  /** Per equipment type, over every unit: on hand, ready and the percentage. */
  readonly byEquipment: ReadonlyArray<{ readonly equipment: string; readonly onHand: number; readonly ready: number; readonly percent: number }>;
}

/** One serial of a notional movement table (movement.ts) with its check. */
export interface MovementSerial {
  readonly serial: string;
  readonly what: string;
  readonly mode: string;
  readonly from: string;
  readonly to: string;
  readonly load: number;
  readonly loadUnit: string;
  readonly lift: { readonly asset: string; readonly count: number; readonly capacityEach: number };
  readonly distanceKm: number;
  readonly speedKmh: number;
  readonly handlingHours: number;
  readonly ready: string;
  readonly required: string;
  readonly arrives: string;
  readonly liftFeasible: boolean;
  readonly timeFeasible: boolean;
  readonly slackHours: number;
}

export interface MovementRecord extends CalcRecordBase {
  readonly kind: 'movement';
  /** Always true: the logistics server never builds or imports a real deployment database (03 B4). */
  readonly notional: true;
  /** The table this one revises, when it does. */
  readonly supersedes?: string;
  readonly serials: readonly MovementSerial[];
}

export type CalcRecord = ConsumptionRecord | ReadinessRecord | MovementRecord;

/** The record file's text: canonical key order is not needed, because the hash is of the exact bytes written and the ledger holds that hash. */
export function renderRecord(record: CalcRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The SHA-256 of a record file's exact bytes: what the calculator ledger holds. */
export function recordHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Reads a record file's text back. Undefined when it is not a record this version wrote. */
export function parseRecord(text: string): CalcRecord | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || ownValue(value, 'v') !== CALC_RECORD_VERSION) return undefined;
  const id = ownValue(value, 'id');
  const kind = ownValue(value, 'kind');
  const formula = ownValue(value, 'formula');
  if (typeof id !== 'string' || !STAFF_SLUG.test(id) || !(CALC_RECORD_KINDS as readonly unknown[]).includes(kind)) return undefined;
  if (!Array.isArray(formula) || !formula.every((line) => typeof line === 'string')) return undefined;
  return value as unknown as CalcRecord;
}

/** The record as a person or member reads it: what it computed, the formula, the inputs' sources. */
export function describeRecord(record: CalcRecord): string {
  return [
    `calc:${record.id} (${record.kind}): ${record.title}`,
    `Computed by ${record.computedBy} in run ${record.run} at ${record.at}. Label: ${record.label}.`,
    'Formula:',
    ...record.formula.map((line) => `  ${line}`)
  ].join('\n');
}

// ---- Consumption -------------------------------------------------------------------------------------------------------------------------------

export interface ConsumptionInput {
  readonly id: string;
  readonly title: string;
  /** Each line names a factor by id and gives the count from the force list. */
  readonly lines: ReadonlyArray<{ readonly factor: string; readonly count: number; readonly item?: string }>;
  readonly days: number;
  /** On hand now, in the same unit, for days of supply. */
  readonly onHand?: number;
  readonly label?: string;
}

/** Who and when, filled by the host. */
export interface RecordStamp { readonly computedBy: string; readonly run: string; readonly at: string }

export const DEFAULT_CALC_LABEL = 'org/Internal';

/** Checks the common fields every record kind takes from a call: an id that is a slug, a one-line title, a template label. */
export function checkRecordHead(input: { id: unknown; title: unknown; label?: unknown }): CalcResult<{ id: string; title: string; label: string }> {
  if (typeof input.id !== 'string' || !STAFF_SLUG.test(input.id)) return fail('id is the record id products cite as calc:<id>: lower case letters, digits and dashes, at most 64 characters, such as fuel-phase-1.');
  if (!isOneLine(input.title, 200)) return fail('title is one line saying what was computed, at most 200 characters, such as "Class III (bulk) for phase 1".');
  const label = input.label === undefined ? DEFAULT_CALC_LABEL : input.label;
  if (typeof label !== 'string' || !STAFF_TEMPLATE_LABELS.includes(label)) return fail(`label is one of ${STAFF_TEMPLATE_LABELS.join(', ')}. Exercise and fictional data only.`);
  return done({ id: input.id, title: input.title.trim(), label });
}

/**
 * The calculation: for each line, the person's rate times the count; the daily requirement is their sum; the requirement is the daily times the days;
 * days of supply, when on hand is given, is on hand divided by the daily requirement. Every factor must be in one unit, or the sum would mean nothing.
 */
export function computeConsumption(input: ConsumptionInput, factors: readonly PlanningFactor[], stamp: RecordStamp): CalcResult<ConsumptionRecord> {
  const head = checkRecordHead(input);
  if (!head.ok) return head;
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_LINES) return fail(`lines is a list of 1 to ${MAX_LINES} { factor, count, item } entries from the force list.`);
  if (!finiteIn(input.days, 0, MAX_DAYS) || input.days <= 0) return fail(`days is a number of days above 0 and at most ${MAX_DAYS}.`);
  if (input.onHand !== undefined && !finiteIn(input.onHand, 0, MAX_RATE * MAX_COUNT)) return fail('onHand is a number of 0 or more, in the same unit as the factors.');
  if (!factors.length) return fail(`No planning factors are set. The calculator uses only factors a person entered in ${FACTORS_FILE}; it ships none. Ask the person to add the factors you need, for example:\n${FACTORS_EXAMPLE}`);
  const lines: ConsumptionLine[] = [];
  let unit: string | undefined;
  for (const [index, line] of input.lines.entries()) {
    // A line names a factor and a count; a rate, a total or anything else given with it is refused, so no number of the agent's own gets in.
    if (!isRecord(line) || checkStaffKeys(line as never, '', ['factor', 'count'], ['item'])) return fail(`Line ${index + 1} has factor, count and an optional item, and nothing else: rates come only from the planning factors a person entered in ${FACTORS_FILE}.`);
    const factor = factors.find((entry) => entry.id === line.factor);
    if (!factor) return fail(`Line ${index + 1}: no planning factor "${String(line.factor)}" in ${FACTORS_FILE}. The factors set are: ${factors.map((entry) => entry.id).join(', ')}. Ask the person to add it; never use a rate of your own or one from a government table.`);
    if (!finiteIn(line.count, 0, MAX_COUNT) || !Number.isInteger(line.count)) return fail(`Line ${index + 1} (${factor.id}): count is a whole number from 0 to ${MAX_COUNT}, from the force list.`);
    if (line.item !== undefined && !isOneLine(line.item, 80)) return fail(`Line ${index + 1} (${factor.id}): item is one line naming what was counted.`);
    if (unit !== undefined && factor.unit !== unit) return fail(`Line ${index + 1}: ${factor.id} is in ${factor.unit}, but the earlier lines are in ${unit}. Calculate each unit of measure in a record of its own.`);
    unit = factor.unit;
    lines.push({ factor: factor.id, what: factor.what, rate: factor.rate, per: factor.per, enteredBy: factor.enteredBy, count: line.count, item: line.item?.trim() || factor.per.split(/\s+per\s+/)[0], daily: factor.rate * line.count });
  }
  const u = unit!;
  const daily = lines.reduce((sum, line) => sum + line.daily, 0);
  const total = daily * input.days;
  const daysOfSupply = input.onHand !== undefined && daily > 0 ? input.onHand / daily : undefined;
  const formula = [
    `requirement = sum over the force list of (rate x count) x days; rates are planning factors a person entered in ${FACTORS_FILE}`,
    ...lines.map((line) => `${line.factor}: ${formatNumber(line.rate)} ${u} per ${line.per} (entered by ${line.enteredBy}) x ${formatNumber(line.count)} ${line.item} = ${formatNumber(line.daily)} ${u} per day`),
    `daily requirement = ${lines.map((line) => formatNumber(line.daily)).join(' + ')} = ${formatNumber(daily)} ${u} per day`,
    `requirement = ${formatNumber(daily)} ${u} per day x ${formatNumber(input.days)} days = ${formatNumber(total)} ${u}`,
    ...(input.onHand !== undefined
      ? [daysOfSupply === undefined
          ? `days of supply: not computed, because the daily requirement is 0`
          : `days of supply = ${formatNumber(input.onHand)} ${u} on hand / ${formatNumber(daily)} ${u} per day = ${formatNumber(daysOfSupply)} days`]
      : [])
  ];
  return done({
    v: CALC_RECORD_VERSION, id: head.value.id, kind: 'consumption', title: head.value.title, label: head.value.label, ...stamp, formula,
    unit: u, days: input.days, lines, daily, total,
    ...(input.onHand !== undefined ? { onHand: input.onHand } : {}), ...(daysOfSupply !== undefined ? { daysOfSupply } : {})
  });
}

/** The result a tool returns for a new record: what it is, how to cite it, and the formula. */
export function recordResultText(record: CalcRecord, hash: string): string {
  return [
    `Recorded calc:${record.id} at ${CALCULATOR_RECORD_DIR}/${record.id}.json, with its hash ${hash} in the calculator ledger.`,
    `Cite it on the same line as each number it produced, for example "${record.title}: ... (calc:${record.id})", and list it under the product's calculator records.`,
    'Formula:',
    ...record.formula.map((line) => `  ${line}`)
  ].join('\n');
}
