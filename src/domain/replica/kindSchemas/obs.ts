// Data schemas for the observations family: obs.segment, obs.coalesced and obs.pruned (DESIGN 12, 10.3; D-07). Hub-side: pure, no Yjs; it must not import
// kinds.ts. Owner: 30-04. Phase 35 folds these kinds and may extend them before any store exists.
// A segment or a coalesced track set travels as a sealed blob named by its hash. These entries carry only the slice and counts, never arrays of points.
import { isRecord } from '../../team/validate';
import { invalidAt } from './shared';
import { countBelow, hashCheck, oneOf, slugCheck, streamCheck, timeCheck, validateShape } from './project';
import type { Check, Shape } from './project';

export const PRUNE_REASONS = ['retention', 'budget', 'window'] as const;
const MAX_COUNT = 1_000_000_000;

// Canonical JSON in a signed body carries whole numbers only (src/domain/team/canonical.ts), so an area is in microdegrees: one millionth of a degree,
// about 11 cm at the equator, which is far finer than a coarse area needs.
const MICRO = 1_000_000;
const degrees = (value: unknown, limitDegrees: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= limitDegrees * MICRO;

// A coarse area as a bounding box in microdegrees. East may be west of west: the box then crosses the antimeridian.
const areaCheck: Check = (value, path) => {
  if (!isRecord(value)) return invalidAt(path);
  const names = Object.keys(value);
  if (names.length !== 4 || !['west', 'south', 'east', 'north'].every((name) => names.includes(name))) return invalidAt(path);
  if (!degrees(value.west, 180)) return invalidAt(`${path}.west`);
  if (!degrees(value.south, 90)) return invalidAt(`${path}.south`);
  if (!degrees(value.east, 180)) return invalidAt(`${path}.east`);
  if (!degrees(value.north, 90)) return invalidAt(`${path}.north`);
  if (value.south > value.north) return invalidAt(path, 'south is above north');
  return undefined;
};

const count = countBelow(MAX_COUNT);
const SHAPES: Readonly<Record<string, Shape>> = {
  'obs.segment': { required: { cell: streamCheck, feed: slugCheck, area: areaCheck, from: timeCheck, to: timeCheck, rows: count, blob: hashCheck }, optional: { channel: slugCheck } },
  'obs.coalesced': { required: { cell: streamCheck, feed: slugCheck, area: areaCheck, from: timeCheck, to: timeCheck, tracks: count, points: count, blob: hashCheck } },
  'obs.pruned': { required: { cell: streamCheck, feed: slugCheck, from: timeCheck, to: timeCheck, segments: count, reason: oneOf(PRUNE_REASONS) } }
};

// Returns a reason, or undefined when the data is valid.
export function validateObsData(kind: string, data: unknown, path: string): string | undefined {
  const reason = validateShape(SHAPES, kind, data, path);
  if (reason !== undefined || !isRecord(data)) return reason;
  // A window that ends before it starts names nothing. The times are compared as times: the text form has an optional fraction, so text order is not time order.
  if (Date.parse(data.to as string) < Date.parse(data.from as string)) return invalidAt(`${path}.to`, 'ends before it starts');
  return undefined;
}
