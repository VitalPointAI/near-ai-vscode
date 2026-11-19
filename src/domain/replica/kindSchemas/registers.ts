// Data schemas for the registers family: register.row, pir.decide and watch.decide (DESIGN 5.5, 6.4, 10.6, 15.6; D-07). Hub-side: pure, no Yjs; it must not
// import kinds.ts. Owner: 30-04. Phases 31 and 33 fold these kinds and may extend them before any store exists.
import { isRecord } from '../../team/validate';
import { invalidAt } from './shared';
import { hashCheck, lineCheck, listOf, oneOf, slugCheck, validateShape } from './project';
import type { Check, Shape } from './project';

// The registers DESIGN 5.5 names: CCIR, RFI, PIR, the synchronization matrix, the assumptions and the annex tracker.
export const REGISTER_NAMES = ['ccir', 'rfi', 'pir', 'sync-matrix', 'assumptions', 'annex-tracker'] as const;
export const WATCH_RUNNERS = ['hub', 'attended'] as const;
const MAX_FIELDS = 32;
const MAX_FIELD_TEXT = 2000;
const FIELD_NAME = /^[a-z][A-Za-z0-9_-]{0,39}$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const rowCheck: Check = (value, path) => (typeof value === 'string' && ROW_ID.test(value) ? undefined : invalidAt(path));

// The fields of one row: at most 32 named values, each a short text, a whole number or a flag (canonical JSON in a signed body has no fractions). Names cannot start with an underscore, so no prototype key.
const fieldsCheck: Check = (value, path) => {
  if (!isRecord(value)) return invalidAt(path);
  const names = Object.keys(value);
  if (names.length > MAX_FIELDS) return invalidAt(path, 'too many fields');
  for (const name of names) {
    if (!FIELD_NAME.test(name)) return invalidAt(`${path}.${name.slice(0, 40)}`, 'field name');
    const field: unknown = value[name];
    const fits = (typeof field === 'string' && field.length <= MAX_FIELD_TEXT) || typeof field === 'boolean' || (typeof field === 'number' && Number.isSafeInteger(field));
    if (!fits) return invalidAt(`${path}.${name.slice(0, 40)}`, 'field value');
  }
  return undefined;
};

const MAX_REASONS = 8;
const MAX_SEEN = 16;
const SHAPES: Readonly<Record<string, Shape>> = {
  'register.row': { required: { register: oneOf(REGISTER_NAMES), row: rowCheck, fields: fieldsCheck }, optional: { basedOn: hashCheck } },
  'pir.decide': { required: { pir: rowCheck, outcome: slugCheck, reasons: listOf(lineCheck(500), MAX_REASONS), decisionsSeen: listOf(hashCheck, MAX_SEEN) } },
  'watch.decide': { required: { watch: slugCheck, outcome: slugCheck }, optional: { runner: oneOf(WATCH_RUNNERS) } }
};

// Returns a reason, or undefined when the data is valid.
export function validateRegistersData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}
