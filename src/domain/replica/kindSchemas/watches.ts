// Data schemas for the watches family: watch.define, watch.assign, watch.match, watch.state and watch.killSwitch (DESIGN 10.6, 15.6; D-07). Hub-side: pure,
// no Yjs; it must not import kinds.ts. Owner: 30-04. Phase 35 folds these kinds and may extend them before any store exists.
import { isRecord } from '../../team/validate';
import { invalidAt } from './shared';
import { flagCheck, hashCheck, lineCheck, listOf, oneOf, slugCheck, timeCheck, validateShape } from './project';
import type { Check, Shape } from './project';

// The states of DESIGN 15.6, as a closed list.
export const WATCH_STATES = ['proposed', 'armed', 'rejected', 'matched', 'drafting', 'awaiting-review', 'paused', 'expired', 'disarmed'] as const;
export const WATCH_RUNNER_CHOICES = ['hub', 'attended'] as const;
const MAX_FEEDS = 16;
const MAX_OBSERVATIONS = 64;
const OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
// Either the whole project, or one watch by id.
const SCOPE = /^(project|watch:[a-z0-9][a-z0-9-]{0,63})$/;

const observationCheck: Check = (value, path) => (typeof value === 'string' && OBSERVATION_ID.test(value) ? undefined : invalidAt(path));
const scopeCheck: Check = (value, path) => (typeof value === 'string' && SCOPE.test(value) ? undefined : invalidAt(path));
const windowCheck: Check = (value, path) => {
  if (!isRecord(value)) return invalidAt(path);
  const names = Object.keys(value);
  if (names.length !== 2 || !names.includes('from') || !names.includes('to')) return invalidAt(path);
  return timeCheck(value.from, `${path}.from`) ?? timeCheck(value.to, `${path}.to`);
};

const SHAPES: Readonly<Record<string, Shape>> = {
  'watch.define': { required: { watch: slugCheck, title: lineCheck(120), criteria: lineCheck(4000), feeds: listOf(slugCheck, MAX_FEEDS) }, optional: { expiresAt: timeCheck } },
  'watch.assign': { required: { watch: slugCheck, runner: oneOf(WATCH_RUNNER_CHOICES) }, optional: { fallback: oneOf(['attended']) } },
  // The match id is the hash of the watch id, the sorted observation ids and the window (DESIGN 10.6), the same on the hub and on the edge.
  'watch.match': { required: { watch: slugCheck, matchId: hashCheck, observations: listOf(observationCheck, MAX_OBSERVATIONS), window: windowCheck } },
  'watch.state': { required: { watch: slugCheck, state: oneOf(WATCH_STATES) }, optional: { reason: lineCheck(200) } },
  'watch.killSwitch': { required: { scope: scopeCheck, on: flagCheck, reason: lineCheck(200) } }
};

// Returns a reason, or undefined when the data is valid.
export function validateWatchesData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}
