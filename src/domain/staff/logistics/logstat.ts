// LOGSTAT reading and validation (design 10, 3.5 and 6.2; research note 03, B5 and B12; WP-LOG). Pure: no I/O, no clock, no vscode.
//
// A LOGSTAT is "a compilation of data that requires analysis before action" (03 B5): this module reads one unit's report strictly and checks it against
// the plausibility rules of the J4 template's logstat-definitions skill, numbered as the skill numbers them, so a finding sent back to a unit names the
// rule it breaks. Nothing here changes a reported number: a report that fails a rule stays out of the consolidation until its unit sends one that passes.
// The amber and red bands are settings a person fills in the skill's table; a commodity with no setting shows no band, and every band shows the numbers
// behind it (03 B12 item 7).
//
// A finding quotes figures the unit reported, which no calculator record stands behind and none should: the log says what the unit sent, it computes
// nothing. So a finding names the unit of measure once, after the figures ("On hand is 1,200, above the capacity of 1,000 (both in litres)"), and the
// validation log product does not read as a staff number to guard-scan's number rule. Every planning number still comes from the calculator.
import { LOGSTAT_TERMS } from '../doctrine';
import { checkStaffKeys, isOneLine, isRecord, ownValue, STAFF_SLUG } from '../parse';
import { formatNumber } from './calculator';
import type { CalcRecord, CalcResult, ConsumptionRecord } from './calculator';

export const LOGSTAT_DIR = '.planning/staff/logistics/logstat';
export const LOGSTAT_REPORTS_DIR = `${LOGSTAT_DIR}/reports`;
export const LOGSTAT_VALIDATION_FILE = `${LOGSTAT_DIR}/validation.jsonl`;
export const LOGSTAT_VALIDATION_PRODUCT = 'logstat-validation-log';

const MAX_LINES = 200;
const MAX_QUANTITY = 1e12;
/** How close a reported figure must be to the one the rule computes: rounding in a unit's spreadsheet is not a finding. */
const BALANCE_TOLERANCE = 0.01;
const DAYS_TOLERANCE = 0.05;
const REQUIRED_TOLERANCE = 0.005;

export interface LogstatLine {
  readonly commodity: string;
  /** Unit of measure: litres, rations, short tons. */
  readonly uom: string;
  readonly onHand: number;
  readonly received: number;
  readonly consumed: number;
  readonly capacity: number;
  /** The need over the forecast period, from a calculator record. */
  readonly required?: number;
  readonly daysOfSupply?: number;
  /** The forecast need to LOGSTAT_TERMS.forecastHours hours. */
  readonly forecast?: number;
  /** The calculator record behind required and days of supply. */
  readonly calc?: string;
  /** Bulk stock this unit carries for another unit, reported apart from its own (rule 4). */
  readonly carriedFor?: string;
}

export interface LogstatReport {
  readonly id: string;
  readonly unit: string;
  readonly reportedAt: string;
  readonly lines: readonly LogstatLine[];
  /** Who entered it and when, filled by the host. */
  readonly submittedBy?: string;
  readonly submittedAt?: string;
}

const fail = <T>(message: string): CalcResult<T> => ({ ok: false, message });

const quantity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_QUANTITY;

/**
 * Reads a report strictly. Out-of-range values such as a negative on hand are read as given, because the plausibility rules, not the reader, say what is
 * wrong with them: a report is never refused at the door for a number the analyst must flag back to the unit.
 */
export function parseLogstatReport(value: unknown): CalcResult<LogstatReport> {
  if (!isRecord(value)) return fail('A LOGSTAT is an object with id, unit, reportedAt and lines.');
  const keys = checkStaffKeys(value, '', ['id', 'unit', 'reportedAt', 'lines'], ['submittedBy', 'submittedAt']);
  if (keys) return fail(`The LOGSTAT has fields id, unit, reportedAt and lines, and nothing else (${keys.message}).`);
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !STAFF_SLUG.test(id)) return fail('id is the report id: lower case letters, digits and dashes, such as 1-bn-181200z.');
  const unit = ownValue(value, 'unit');
  if (!isOneLine(unit, 120)) return fail('unit is the reporting unit, one line (fictional units only).');
  const reportedAt = ownValue(value, 'reportedAt');
  if (typeof reportedAt !== 'string' || !Number.isFinite(Date.parse(reportedAt))) return fail('reportedAt is the report time, an ISO time such as 2026-11-18T12:00:00Z.');
  const lines = ownValue(value, 'lines');
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) return fail(`lines is a list of 1 to ${MAX_LINES} commodities.`);
  const out: LogstatLine[] = [];
  for (const [index, line] of lines.entries()) {
    const where = `Line ${index + 1}`;
    if (!isRecord(line)) return fail(`${where} is an object.`);
    const lineKeys = checkStaffKeys(line, '', ['commodity', 'uom', 'onHand', 'received', 'consumed', 'capacity'], ['required', 'daysOfSupply', 'forecast', 'calc', 'carriedFor']);
    if (lineKeys) return fail(`${where} has commodity, uom, onHand, received, consumed, capacity, and optionally required, daysOfSupply, forecast, calc and carriedFor (${lineKeys.message}).`);
    for (const key of ['commodity', 'uom'] as const) if (!isOneLine(ownValue(line, key), 80)) return fail(`${where}: ${key} is one line.`);
    for (const key of ['onHand', 'received', 'consumed', 'capacity'] as const) if (!quantity(ownValue(line, key))) return fail(`${where} (${String(ownValue(line, 'commodity'))}): ${key} is a number.`);
    for (const key of ['required', 'daysOfSupply', 'forecast'] as const) {
      const field = ownValue(line, key);
      if (field !== undefined && !quantity(field)) return fail(`${where} (${String(ownValue(line, 'commodity'))}): ${key} is a number when given.`);
    }
    const calc = ownValue(line, 'calc');
    if (calc !== undefined && (typeof calc !== 'string' || !STAFF_SLUG.test(calc))) return fail(`${where}: calc is a calculator record id, as products cite it after calc:.`);
    const carriedFor = ownValue(line, 'carriedFor');
    if (carriedFor !== undefined && !isOneLine(carriedFor, 120)) return fail(`${where}: carriedFor is the unit the stock is carried for, one line.`);
    out.push(JSON.parse(JSON.stringify(line)) as LogstatLine);
  }
  const submittedBy = ownValue(value, 'submittedBy');
  const submittedAt = ownValue(value, 'submittedAt');
  return {
    ok: true,
    value: {
      id, unit: (unit as string).trim(), reportedAt, lines: out,
      ...(typeof submittedBy === 'string' ? { submittedBy } : {}), ...(typeof submittedAt === 'string' ? { submittedAt } : {})
    }
  };
}

// ---- The plausibility rules --------------------------------------------------------------------------------------------------------------------

/** The rules, numbered as the logstat-definitions skill numbers them. Rule 6 is the consolidation's: a report that fails stays out. */
export const LOGSTAT_RULES = {
  1: 'On hand is never below zero and never above capacity.',
  2: 'On hand agrees with the last report plus received minus consumed.',
  3: `Every commodity has a forecast to ${LOGSTAT_TERMS.forecastHours} hours.`,
  4: 'A forward unit\'s own needs are reported apart from the bulk stocks it carries for others.',
  5: 'Days of supply and required come from a calculator record, never from the report\'s own arithmetic.',
  6: 'A report that fails a rule goes back to its unit with the rule named, and stays out of the consolidation until it passes.'
} as const;
export type LogstatRule = keyof typeof LOGSTAT_RULES;

export interface LogstatFinding {
  readonly rule: LogstatRule;
  readonly commodity: string;
  readonly message: string;
}

export interface LogstatValidation {
  readonly report: string;
  readonly unit: string;
  readonly passed: boolean;
  readonly findings: readonly LogstatFinding[];
  /** The report this one was checked against for rule 2, when there was one. */
  readonly against?: string;
}

const lineKey = (line: LogstatLine): string => `${line.commodity.trim().toLowerCase()}\u0000${(line.carriedFor ?? '').trim().toLowerCase()}`;
const lineName = (line: LogstatLine): string => (line.carriedFor ? `${line.commodity} (carried for ${line.carriedFor})` : line.commodity);
const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));

/**
 * The report a report is checked against for rule 2: the same unit's latest earlier report that itself passed. A report that failed went back to its
 * unit and never became the baseline, so the unit's corrected report is balanced against the last good one.
 */
export function previousReport(report: LogstatReport, all: readonly LogstatReport[], records: ReadonlyMap<string, CalcRecord> = new Map()): LogstatReport | undefined {
  const at = Date.parse(report.reportedAt);
  const earlier = all
    .filter((other) => other.id !== report.id && other.unit === report.unit && Date.parse(other.reportedAt) < at)
    .sort((a, b) => Date.parse(a.reportedAt) - Date.parse(b.reportedAt));
  let baseline: LogstatReport | undefined;
  for (const candidate of earlier) if (checkReport(candidate, baseline, records).length === 0) baseline = candidate;
  return baseline;
}

/**
 * Checks one report against rules 1 to 5. `records` holds the calculator records the calculator ledger vouches for, by id; a record outside it does not
 * count for rule 5, so a hand-made file cannot stand behind a number.
 */
export function validateLogstat(report: LogstatReport, all: readonly LogstatReport[], records: ReadonlyMap<string, CalcRecord>): LogstatValidation {
  const previous = previousReport(report, all, records);
  const findings = checkReport(report, previous, records);
  return { report: report.id, unit: report.unit, passed: findings.length === 0, findings, ...(previous ? { against: previous.id } : {}) };
}

/** Rules 1 to 5 for one report against the baseline for rule 2. */
function checkReport(report: LogstatReport, previous: LogstatReport | undefined, records: ReadonlyMap<string, CalcRecord>): LogstatFinding[] {
  const findings: LogstatFinding[] = [];
  const add = (rule: LogstatRule, line: LogstatLine, message: string): void => { findings.push({ rule, commodity: lineName(line), message }); };
  const seen = new Set<string>();
  for (const line of report.lines) {
    const u = line.uom;
    // Rule 1: the stock range.
    if (line.onHand < 0) add(1, line, `On hand is ${formatNumber(line.onHand)}, below zero.`);
    if (line.capacity <= 0) add(1, line, `Capacity is ${formatNumber(line.capacity)}; it is the most the unit can hold and must be above zero.`);
    else if (line.onHand > line.capacity) add(1, line, `On hand is ${formatNumber(line.onHand)}, above the capacity of ${formatNumber(line.capacity)} (both in ${u}).`);
    if (line.received < 0) add(1, line, `Received is ${formatNumber(line.received)}, below zero.`);
    if (line.consumed < 0) add(1, line, `Consumed is ${formatNumber(line.consumed)}, below zero.`);
    // Rule 2: the balance against the last report.
    const before = previous?.lines.find((entry) => lineKey(entry) === lineKey(line));
    if (previous && before) {
      const expected = before.onHand + line.received - line.consumed;
      if (!near(line.onHand, expected, BALANCE_TOLERANCE)) {
        add(2, line, `On hand is ${formatNumber(line.onHand)}, but the last report (${previous.id}) had ${formatNumber(before.onHand)}, plus ${formatNumber(line.received)} received, minus ${formatNumber(line.consumed)} consumed, which is ${formatNumber(expected)}. The difference is ${formatNumber(line.onHand - expected)} (all in ${u}).`);
      }
      if (before.uom !== line.uom) add(2, line, `The unit of measure changed from ${before.uom} in the last report to ${line.uom}.`);
    }
    // Rule 3: the forecast.
    if (line.forecast === undefined) add(3, line, `There is no forecast to ${LOGSTAT_TERMS.forecastHours} hours.`);
    // Rule 4: own needs apart from bulk carried for others.
    const key = lineKey(line);
    if (seen.has(key)) add(4, line, 'The commodity is reported twice for the same holder; report the unit\'s own stock once and each unit\'s carried stock on a line of its own.');
    seen.add(key);
    if (line.carriedFor !== undefined && line.carriedFor.trim().toLowerCase() === report.unit.trim().toLowerCase()) add(4, line, 'Stock carried for the reporting unit itself is its own stock: report it without carriedFor.');
    if (line.carriedFor !== undefined && (line.required !== undefined || line.daysOfSupply !== undefined)) add(4, line, `Required and days of supply are the needs of ${line.carriedFor}, not of the unit carrying its stock; report them on ${line.carriedFor}'s own line.`);
    // Rule 5: required and days of supply from a calculator record.
    if (line.required !== undefined || line.daysOfSupply !== undefined) {
      const record = line.calc ? records.get(line.calc) : undefined;
      if (!line.calc) add(5, line, 'Required or days of supply is given with no calculator record (calc).');
      else if (!record) add(5, line, `calc:${line.calc} is not a calculator record the calculator ledger vouches for.`);
      else if (record.kind !== 'consumption') add(5, line, `calc:${line.calc} is a ${record.kind} record, not a consumption calculation.`);
      else checkAgainstRecord(line, record, (message) => add(5, line, message));
    }
  }
  return findings;
}

function checkAgainstRecord(line: LogstatLine, record: ConsumptionRecord, add: (message: string) => void): void {
  if (record.unit !== line.uom) add(`calc:${record.id} is in ${record.unit}, but the line is in ${line.uom}.`);
  if (line.required !== undefined && !near(line.required, record.total, REQUIRED_TOLERANCE)) {
    add(`Required is ${formatNumber(line.required)}, but calc:${record.id} gives ${formatNumber(record.total)} (in ${record.unit}).`);
  }
  if (line.daysOfSupply !== undefined) {
    if (record.daily <= 0) add(`calc:${record.id} has a daily requirement of 0, so days of supply cannot come from it.`);
    else {
      const days = line.onHand / record.daily;
      if (Math.abs(line.daysOfSupply - days) > DAYS_TOLERANCE) add(`Days of supply is ${formatNumber(line.daysOfSupply)}, but on hand ${formatNumber(line.onHand)} divided by the daily requirement of calc:${record.id} (${formatNumber(record.daily)} per day, in ${record.unit}) is ${formatNumber(days)}.`);
    }
  }
}

// ---- Bands -------------------------------------------------------------------------------------------------------------------------------------

/** A commodity's settings from the skill's table: amber and red below a percentage of capacity. Unset values are undefined. */
export interface BandSetting { readonly commodity: string; readonly amberBelow?: number; readonly redBelow?: number }

/**
 * The band settings from the logstat-definitions skill's table ("| Commodity | Unit of measure | What capacity means | Amber below | Red below |"). A
 * commodity cell reads "Class III: ..." and matches every reported commodity that starts with "Class III" as a whole word. A blank or non-numeric cell
 * is not set.
 */
export function parseBandSettings(skillText: string): BandSetting[] {
  const lines = skillText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\|\s*Commodity\s*\|.*Amber below\s*\|\s*Red below\s*\|\s*$/i.test(line));
  if (start < 0) return [];
  const out: BandSetting[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const commodity = cells[0].split(':')[0].trim();
    const percent = (cell: string): number | undefined => {
      const match = /^(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(cell);
      const value = match ? Number(match[1]) : undefined;
      return value !== undefined && value >= 0 && value <= 100 ? value : undefined;
    };
    if (!commodity) continue;
    const amber = percent(cells[3]);
    const red = percent(cells[4]);
    out.push({ commodity, ...(amber !== undefined ? { amberBelow: amber } : {}), ...(red !== undefined ? { redBelow: red } : {}) });
  }
  return out;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The band of one line, with the numbers behind it; "no band set" when the person has not set one for its commodity. */
export function bandOf(line: LogstatLine, settings: readonly BandSetting[]): string {
  const setting = settings.find((entry) => new RegExp(`^${escapeRegExp(entry.commodity)}(?![A-Za-z])`, 'i').test(line.commodity.trim()));
  if (line.capacity <= 0) return 'no band: capacity is not above zero';
  const percent = (line.onHand / line.capacity) * 100;
  const behind = `${formatNumber(percent)} percent of capacity (on hand ${formatNumber(line.onHand)} / capacity ${formatNumber(line.capacity)})`;
  if (!setting || (setting.amberBelow === undefined && setting.redBelow === undefined)) return `no band set; ${behind}`;
  const colour = setting.redBelow !== undefined && percent < setting.redBelow ? 'RED' : setting.amberBelow !== undefined && percent < setting.amberBelow ? 'AMBER' : 'GREEN';
  const limits = [setting.amberBelow !== undefined ? `amber below ${formatNumber(setting.amberBelow)}` : '', setting.redBelow !== undefined ? `red below ${formatNumber(setting.redBelow)}` : ''].filter(Boolean).join(', ');
  return `${colour}: ${behind}; ${limits} (the project's settings)`;
}

// ---- Consolidation -----------------------------------------------------------------------------------------------------------------------------

export interface ConsolidatedRow {
  readonly unit: string;
  readonly report: string;
  readonly line: LogstatLine;
  readonly band: string;
  /** Consumption since the last report against the calculator's daily requirement over the same time, when both are known. */
  readonly againstForecast?: string;
}

export interface Consolidation {
  readonly rows: readonly ConsolidatedRow[];
  /** Units whose latest report failed a rule, with the rules, held out of the consolidation (rule 6). */
  readonly heldOut: ReadonlyArray<{ readonly unit: string; readonly report: string; readonly rules: readonly LogstatRule[] }>;
}

/**
 * The consolidation: each unit's latest report, checked again here (the rules are deterministic, so no one has to trust a log line); a report that fails
 * stays out with its unit named. For a line with a consumption record and an earlier report, consumption is compared with the forecast over the time
 * between the two reports.
 */
export function consolidateLogstat(all: readonly LogstatReport[], records: ReadonlyMap<string, CalcRecord>, bands: readonly BandSetting[]): Consolidation {
  const latest = new Map<string, LogstatReport>();
  for (const report of all) {
    const current = latest.get(report.unit);
    if (!current || Date.parse(report.reportedAt) > Date.parse(current.reportedAt)) latest.set(report.unit, report);
  }
  const rows: ConsolidatedRow[] = [];
  const heldOut: Array<{ unit: string; report: string; rules: LogstatRule[] }> = [];
  for (const report of [...latest.values()].sort((a, b) => a.unit.localeCompare(b.unit))) {
    const check = validateLogstat(report, all, records);
    if (!check.passed) { heldOut.push({ unit: report.unit, report: report.id, rules: [...new Set(check.findings.map((finding) => finding.rule))].sort() }); continue; }
    const previous = previousReport(report, all, records);
    for (const line of report.lines) {
      const record = line.calc ? records.get(line.calc) : undefined;
      let againstForecast: string | undefined;
      if (record?.kind === 'consumption' && record.daily > 0 && previous) {
        const days = (Date.parse(report.reportedAt) - Date.parse(previous.reportedAt)) / 86_400_000;
        const forecast = record.daily * days;
        if (forecast > 0) againstForecast = `consumed ${formatNumber(line.consumed)} against a forecast of ${formatNumber(forecast)} (${formatNumber(record.daily)} per day x ${formatNumber(days)} days, calc:${record.id}): ${formatNumber((line.consumed / forecast) * 100)} percent of forecast`;
      }
      rows.push({ unit: report.unit, report: report.id, line, band: bandOf(line, bands), ...(againstForecast ? { againstForecast } : {}) });
    }
  }
  return { rows, heldOut };
}

/** A table cell: one line, no pipe. */
const cell = (text: string | number | undefined): string => (text === undefined ? '' : String(typeof text === 'number' ? formatNumber(text) : text).replace(/\|/g, '/').replace(/\s+/g, ' '));

/** The consolidation as the Markdown the jloc-chief puts in the consolidated LOGSTAT product: the J4 template's headings, then held-out units. */
export function consolidationMarkdown(result: Consolidation): string {
  const head = ['Reporting unit', 'Commodity', 'Unit of measure', ...LOGSTAT_TERMS.fields, `Forecast to ${LOGSTAT_TERMS.forecastHours} hours`, 'Band', 'Against the forecast', 'Validation', 'Calculator record'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of result.rows) {
    const l = row.line;
    lines.push(`| ${[row.unit, lineName(l), l.uom, l.onHand, l.received, l.consumed, l.capacity, l.required, l.daysOfSupply, l.forecast, row.band, row.againstForecast ?? '', `passed (${row.report})`, l.calc ? `calc:${l.calc}` : ''].map(cell).join(' | ')} |`);
  }
  if (!result.rows.length) lines.push('', 'No report has passed validation yet.');
  if (result.heldOut.length) {
    lines.push('', 'Held out until the unit sends a report that passes (rule 6):');
    for (const held of result.heldOut) lines.push(`- ${held.unit} (${held.report}): rules ${held.rules.join(', ')}`);
  }
  return lines.join('\n');
}

/** One validation log line: the report, its hash when checked, who checked it, and what was found. */
export interface ValidationLogEntry extends LogstatValidation {
  readonly hash: string;
  readonly at: string;
  readonly by: string;
}

/**
 * The LOGSTAT validation log product body (the J4 template's headings: Report, Rule, Finding, Sent back to, Status), from the log, the latest check of
 * each report. The figures stay in the finding text as the unit reported them; the log quotes reports, it computes nothing.
 */
export function validationLogMarkdown(entries: readonly ValidationLogEntry[]): string {
  const latest = new Map<string, ValidationLogEntry>();
  for (const entry of entries) latest.set(entry.report, entry);
  const lines = ['# LOGSTAT validation log', '', 'Written by the logistics server\'s LOGSTAT validation tool. Nobody fixes a reported number: a finding goes back to the unit with the rule it breaks.', '', '| Report | Rule | Finding | Sent back to | Status |', '|---|---|---|---|---|'];
  for (const entry of latest.values()) {
    if (entry.passed) { lines.push(`| ${cell(entry.report)} | all | none | | passed (${cell(entry.at)}, ${cell(entry.by)}) |`); continue; }
    for (const finding of entry.findings) {
      lines.push(`| ${cell(entry.report)} | ${finding.rule} | ${cell(`${finding.commodity}: ${finding.message}`)} | ${cell(entry.unit)} | open (${cell(entry.at)}, ${cell(entry.by)}) |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
