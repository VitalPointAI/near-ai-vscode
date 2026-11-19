// Readiness import and board (design 10, 3.5 and 6.2; research note 03, B8; WP-LOG). Pure: no I/O, no clock, no vscode.
//
// Readiness data comes from a CSV file a person puts in the project, never from a member's memory: the maintenance planner imports it, and the import is
// kept as a calculator record (kind `readiness`) entered in the calculator ledger, so the readiness summary cites calc:<id> and says which file and when.
// A row that does not add up (more ready than on hand) refuses the whole import with the row named: nobody fixes a figure silently. A figure older than
// the reporting period is marked stale on the board. Partner adapters for government readiness systems stay out of scope (03 B8).
import { CALC_RECORD_VERSION, checkRecordHead, formatNumber } from './calculator';
import type { CalcResult, ReadinessLine, ReadinessRecord, RecordStamp } from './calculator';

export const READINESS_COLUMNS = ['unit', 'equipment', 'on_hand', 'ready', 'as_of'] as const;
export const MAX_READINESS_BYTES = 1024 * 1024;
const MAX_ROWS = 5000;
/** The reporting period the board marks figures stale against, unless the call names another. */
export const DEFAULT_STALE_HOURS = 24;

const fail = <T>(message: string): CalcResult<T> => ({ ok: false, message });

/** Splits CSV text into rows of cells: commas, double-quoted cells with "" for a quote, CRLF or LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; } else if (char === '"') quoted = false; else value += char;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === ',') { row.push(value); value = ''; } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); value = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export interface ReadinessImportInput { readonly id: string; readonly title: string; readonly label?: string }

/**
 * Reads the CSV (columns unit, equipment, on_hand, ready, as_of, in any order, with a header row; other columns are ignored) and builds the record:
 * readiness per equipment type = ready / on hand over every unit, with the working shown.
 */
export function importReadiness(input: ReadinessImportInput, csv: string, source: { file: string; sha256: string }, stamp: RecordStamp): CalcResult<ReadinessRecord> {
  const head = checkRecordHead(input);
  if (!head.ok) return head;
  if (csv.length > MAX_READINESS_BYTES) return fail(`${source.file} is larger than 1 MB.`);
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  if (rows.length < 2) return fail(`${source.file} has no data rows. It needs a header row with ${READINESS_COLUMNS.join(', ')} and one row per unit and equipment type.`);
  if (rows.length - 1 > MAX_ROWS) return fail(`${source.file} has more than ${MAX_ROWS} rows.`);
  const header = rows[0].map((cell) => cell.trim().toLowerCase().replace(/\s+/g, '_'));
  const index = Object.fromEntries(READINESS_COLUMNS.map((column) => [column, header.indexOf(column)])) as Record<(typeof READINESS_COLUMNS)[number], number>;
  const missing = READINESS_COLUMNS.filter((column) => index[column] < 0);
  if (missing.length) return fail(`${source.file} has no ${missing.join(', ')} column. The header row names ${READINESS_COLUMNS.join(', ')}.`);
  const lines: ReadinessLine[] = [];
  for (const [offset, row] of rows.slice(1).entries()) {
    const at = `Row ${offset + 2} of ${source.file}`;
    const text = (column: (typeof READINESS_COLUMNS)[number]) => (row[index[column]] ?? '').trim();
    const unit = text('unit');
    const equipment = text('equipment');
    if (!unit || !equipment || unit.length > 120 || equipment.length > 120) return fail(`${at}: unit and equipment are each one short line.`);
    const onHand = Number(text('on_hand'));
    const ready = Number(text('ready'));
    if (!/^\d+$/.test(text('on_hand')) || !/^\d+$/.test(text('ready'))) return fail(`${at} (${unit}, ${equipment}): on_hand and ready are whole numbers.`);
    if (ready > onHand) return fail(`${at} (${unit}, ${equipment}): ready is ${ready} but on hand is ${onHand}; more cannot be ready than are held. Nothing was imported; ask the person who keeps the data to correct the row.`);
    const asOf = Date.parse(text('as_of'));
    if (!Number.isFinite(asOf)) return fail(`${at} (${unit}, ${equipment}): as_of is the time the figure was true, an ISO time.`);
    if (lines.some((line) => line.unit === unit && line.equipment === equipment)) return fail(`${at}: ${unit} and ${equipment} appear twice.`);
    lines.push({ unit, equipment, onHand, ready, asOf: new Date(asOf).toISOString() });
  }
  const totals = new Map<string, { onHand: number; ready: number }>();
  for (const line of lines) {
    const total = totals.get(line.equipment) ?? { onHand: 0, ready: 0 };
    totals.set(line.equipment, { onHand: total.onHand + line.onHand, ready: total.ready + line.ready });
  }
  const byEquipment = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([equipment, total]) => ({ equipment, ...total, percent: total.onHand > 0 ? (total.ready / total.onHand) * 100 : 0 }));
  const formula = [
    `readiness = ready / on hand x 100, per equipment type over every unit; data from ${source.file} (SHA-256 ${source.sha256})`,
    ...byEquipment.map((entry) => `${entry.equipment}: ${formatNumber(entry.ready)} ready / ${formatNumber(entry.onHand)} on hand = ${formatNumber(entry.percent)} percent`)
  ];
  return {
    ok: true,
    value: { v: CALC_RECORD_VERSION, id: head.value.id, kind: 'readiness', title: head.value.title, label: head.value.label, ...stamp, formula, source, lines, byEquipment }
  };
}

const cell = (text: string): string => text.replace(/\|/g, '/').replace(/\s+/g, ' ');

/** The readiness board: the newest import's lines, each with its readiness and whether it is older than the reporting period at `now`. */
export function readinessBoardMarkdown(records: readonly ReadinessRecord[], now: number, staleHours = DEFAULT_STALE_HOURS): string {
  if (!records.length) return 'No readiness data has been imported yet. A person puts a CSV in the project and the maintenance planner imports it with readiness_import.';
  const latest = [...records].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
  const stale = (asOf: string) => now - Date.parse(asOf) > staleHours * 3_600_000;
  const lines = [
    `From calc:${latest.id} (${latest.source.file}, imported ${latest.at} by ${latest.computedBy}). Stale means older than ${formatNumber(staleHours)} hours.`,
    '',
    '| Unit | Equipment type | On hand | Ready | Readiness | As of | Calculator record |', '|---|---|---|---|---|---|---|',
    ...latest.lines.map((line) => `| ${[line.unit, line.equipment, String(line.onHand), String(line.ready), line.onHand > 0 ? `${formatNumber((line.ready / line.onHand) * 100)} percent` : 'none held', `${line.asOf}${stale(line.asOf) ? ' (stale)' : ''}`, `calc:${latest.id}`].map(cell).join(' | ')} |`),
    '',
    'By equipment type:',
    ...latest.byEquipment.map((entry) => `- ${entry.equipment}: ${formatNumber(entry.ready)} of ${formatNumber(entry.onHand)} ready, ${formatNumber(entry.percent)} percent (calc:${latest.id})`)
  ];
  if (records.length > 1) lines.push('', `Earlier imports: ${records.filter((record) => record.id !== latest.id).map((record) => `calc:${record.id}`).join(', ')}.`);
  return lines.join('\n');
}
