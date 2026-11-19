// Data schemas for the runs family: run.start, run.lane, run.claim, run.release, run.summary and run.end (DESIGN 11, 15.7; D-07). Hub-side: pure, no Yjs;
// it must not import kinds.ts. Owner: 30-04. Phase 35 folds these kinds and may extend them before any store exists.
// Only a signed summary is shared. Transcripts, prompts and tool calls stay on the machine that ran them (DESIGN 11.1), so no kind has a field for them.
import { countBelow, lineCheck, oneOf, slugCheck, validateShape } from './project';
import type { Check, Shape } from './project';
import { invalidAt } from './shared';

export const LANE_STATES = ['working', 'waiting', 'done', 'failed'] as const;
export const RUN_OUTCOMES = ['done', 'failed', 'cancelled'] as const;
// A claim's lease in seconds. The design's default is 20 minutes; the cap keeps one forgotten claim from holding a target for days.
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 24 * 60 * 60;
const MAX_COUNT = 1_000_000_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const runCheck: Check = (value, path) => (typeof value === 'string' && RUN_ID.test(value) ? undefined : invalidAt(path));
const leaseCheck: Check = (value, path) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_LEASE_SECONDS && value <= MAX_LEASE_SECONDS ? undefined : invalidAt(path));
const count = countBelow(MAX_COUNT);

const SHAPES: Readonly<Record<string, Shape>> = {
  'run.start': { required: { run: runCheck, team: slugCheck, section: slugCheck, startedBy: slugCheck, target: lineCheck(200) } },
  'run.lane': { required: { run: runCheck, member: slugCheck, state: oneOf(LANE_STATES) }, optional: { target: lineCheck(200) } },
  'run.claim': { required: { run: runCheck, member: slugCheck, target: lineCheck(200), purpose: lineCheck(200), leaseSeconds: leaseCheck } },
  'run.release': { required: { run: runCheck, target: lineCheck(200) }, optional: { reason: lineCheck(200) } },
  // Spend is whole millionths of one US dollar, never a fractional number, so sums on different machines agree exactly.
  'run.summary': { required: { run: runCheck, proposals: count, verdicts: count, registerRows: count, spendMicros: countBelow(Number.MAX_SAFE_INTEGER), durationSeconds: count } },
  'run.end': { required: { run: runCheck, outcome: oneOf(RUN_OUTCOMES) }, optional: { reason: lineCheck(200) } }
};

// Returns a reason, or undefined when the data is valid.
export function validateRunsData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}
