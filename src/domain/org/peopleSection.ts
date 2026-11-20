// The `people` section of policy bundle v2 (people@1, FND-01, FND-04, Phase 41 D-04, D-15, D-31, D-40). Pure: no I/O, no clock, no vscode, no package.
// `clearances` is the v1 `clearances` list, read with the v1 rules (self-declared on the personal layer). `organization` (mode, allowed modes, settings) is
// filled by plan 41-06; until then it is refused as not available yet. Every key stays optional, so `{ v: 1 }` parses before and after 41-06, and any key
// this section does not name is refused.
// Imported values are used only inside functions, never at module load.
import { MAX_CLEARANCES, clearanceKey, parseSetList } from '../gate/bundle';
import { parseClearance } from '../gate/labels';
import type { Clearance, ScaleTable } from '../gate/labels';
import { checkKeys, childPath, isRecord, ownValue, refused } from '../gate/shape';
import type { Parsed } from '../gate/shape';

export interface PeopleSection {
  readonly v: 1;
  /** v1 `clearances`: on the personal layer the person's own declaration (D-27 of Phase 70); absent when the section does not set it. */
  readonly clearances?: readonly Clearance[];
  /** Filled by 41-06 (mode, allowed modes, settings, D-40). */
  readonly organization?: never;
}

const PEOPLE_OPTIONAL = ['clearances', 'signers', 'organization'] as const;

export function parsePeopleSection(value: unknown, scales: ScaleTable, path = 'people'): Parsed<PeopleSection> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v'], PEOPLE_OPTIONAL);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  if (Object.prototype.hasOwnProperty.call(value, 'organization')) return refused('not-available-yet', childPath(path, 'organization'));
  if (Object.prototype.hasOwnProperty.call(value, 'signers')) return refused('not-available-yet', childPath(path, 'signers'));
  if (!Object.prototype.hasOwnProperty.call(value, 'clearances')) return { ok: true, value: Object.freeze({ v: 1 }) };
  const clearances = parseSetList(
    ownValue(value, 'clearances'), childPath(path, 'clearances'), MAX_CLEARANCES, (item, where) => parseClearance(item, scales, where), clearanceKey
  );
  if (!clearances.ok) return clearances;
  return { ok: true, value: Object.freeze({ v: 1, clearances: clearances.value }) };
}
