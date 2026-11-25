// Contingency as code (D-73; CP-2, CP-9, CP-10): the recovery order, the restore-test record and the backup schedules measured against the
// site's recovery point objective. deploy/bundle/drill.mjs uses it; deploy/runbooks/recovery-plan.md explains it. Node built-ins only.

/** The recovery groups in the order a site comes back (D-73), with the backups each relies on. */
export const RECOVERY_GROUPS = Object.freeze([
  { id: 'platform', stage: 'stage 0', label: 'nodes; RKE2 by etcd restore with the escrowed token or a fresh install; the registry rebuilt from the last verified bundle', backups: ['etcd'] },
  { id: 'secrets', stage: '1', label: 'the HSM and OpenBao', backups: ['openbao-raft'] },
  { id: 'identity', stage: '2', label: 'Keycloak and its Postgres', backups: ['postgres-dump', 'longhorn'] },
  { id: 'registry', stage: '3', label: 'the registry\'s own service; admission back to Deny', backups: [] },
  { id: 'audit-pipeline', stage: 'gate', label: 'OpenSearch and Fluent Bit running before people return', backups: [] },
  { id: 'sessions', stage: '4', label: 'Theia Cloud sessions and workspace volumes', backups: ['longhorn'] },
  { id: 'hubs', stage: '5', label: 'the sync hubs', backups: ['longhorn'] },
  { id: 'audit', stage: '6', label: 'historical audit data from snapshots', backups: ['opensearch-snapshot'] },
]);
export const GROUP_IDS = Object.freeze(RECOVERY_GROUPS.map((group) => group.id));
export const RECORD_FORMAT = 'sterling-restore-test/1';
export const SCENARIOS = Object.freeze(['verify', 'lab-full-site', 'component']);
const KINDS = ['verify', 'restore', 'manual'];
const RESULTS = ['pass', 'fail', 'not-run'];

// ---- cron ------------------------------------------------------------------------------------------------------------------------------

const FIELDS = [{ name: 'minute', min: 0, max: 59 }, { name: 'hour', min: 0, max: 23 }, { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 }, { name: 'day of week', min: 0, max: 7 }];

/** The values one cron field allows, as a Set; throws a plain error on anything it cannot read. */
function cronField(text, { name, min, max }, expr) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`cron "${expr}": the ${name} field "${text}" is not numbers, *, ranges, lists or steps.`);
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === '*' ? min : Number(match[2]);
    const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) throw new Error(`cron "${expr}": the ${name} field "${text}" is out of range ${min}-${max}.`);
    for (let value = from; value <= to; value += step) values.add(name === 'day of week' && value === 7 ? 0 : value);
  }
  return values;
}

/**
 * The longest gap in minutes between two firings of a five-field cron expression (numbers, *, * /n, lists and ranges), found by stepping
 * minute by minute through 15 days in UTC from a Monday. Exact for daily, hourly and weekly schedules; refuses what it cannot read.
 */
export function cronIntervalMinutes(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" is not a five-field expression (macros such as @daily are not read).`);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => cronField(part, FIELDS[index], expr));
  const dayAny = parts[2] === '*';
  const weekAny = parts[4] === '*';
  const start = Date.UTC(2026, 0, 5); // a Monday
  let previous = null;
  let longest = 0;
  for (let minute = 0; minute < 15 * 1440; minute += 1) {
    const at = new Date(start + minute * 60_000);
    const dayMatch = days.has(at.getUTCDate());
    const weekMatch = weekdays.has(at.getUTCDay());
    // Cron's rule: when both day fields are restricted, either may match.
    const day = dayAny && weekAny ? true : dayAny ? weekMatch : weekAny ? dayMatch : dayMatch || weekMatch;
    if (minutes.has(at.getUTCMinutes()) && hours.has(at.getUTCHours()) && months.has(at.getUTCMonth() + 1) && day) {
      if (previous !== null) longest = Math.max(longest, minute - previous);
      previous = minute;
    }
  }
  if (!longest) throw new Error(`cron "${expr}" fires less than twice in 15 days; its interval is not checked here.`);
  return longest;
}

/** One line per backup whose longest gap exceeds the RPO, or that has no schedule while an RPO is set. `schedules`: { backup: { source, cron, gap } | null }. */
export function scheduleProblems(groups, schedules, recovery = {}) {
  const rpo = recovery.rpoMinutes;
  if (!Number.isFinite(rpo)) return [];
  const problems = [];
  const seen = new Set();
  for (const group of groups) {
    for (const backup of group.backups) {
      if (seen.has(backup) || !(backup in schedules)) continue;
      seen.add(backup);
      const schedule = schedules[backup];
      if (!schedule) problems.push(`${backup}: no schedule found, so the RPO of ${rpo} minutes cannot be met for ${group.id}.`);
      else if (schedule.gap > rpo) problems.push(`${backup}: ${schedule.source} "${schedule.cron}" leaves up to ${schedule.gap} minutes between backups, more than the RPO of ${rpo} minutes.`);
    }
  }
  return problems;
}

// ---- the record ----------------------------------------------------------------------------------------------------------------------

const minutesBetween = (from, to) => Number(((Date.parse(to) - Date.parse(from)) / 60_000).toFixed(2));
const isIso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

/** A step with its achieved values computed from its times and the site's RPO target. */
export function computeStep(step, rpoTargetMinutes) {
  const achievedRpoMinutes = step.backupTakenAt ? minutesBetween(step.backupTakenAt, step.startedAt) : null;
  const achievedRtoMinutes = minutesBetween(step.startedAt, step.finishedAt);
  const target = Number.isFinite(rpoTargetMinutes) ? rpoTargetMinutes : null;
  const met = step.result !== 'pass' ? false : achievedRpoMinutes === null || target === null ? null : achievedRpoMinutes <= target;
  return { ...step, achievedRpoMinutes, achievedRtoMinutes, rpoTargetMinutes: target, met };
}

/** The record's top-level recovery time: from the first restore step's start to the last step's end, for a full-site drill only. */
export function computeRecord(record) {
  const target = Number.isFinite(record.rtoTargetMinutes) ? record.rtoTargetMinutes : null;
  if (record.scenario !== 'lab-full-site') return { ...record, rtoTargetMinutes: target, achievedRtoMinutes: null, rtoMet: null };
  const restores = record.steps.filter((step) => step.kind === 'restore');
  const first = restores.map((step) => Date.parse(step.startedAt)).sort((a, b) => a - b)[0];
  const last = record.steps.map((step) => Date.parse(step.finishedAt)).sort((a, b) => b - a)[0];
  const achieved = Number.isFinite(first) && Number.isFinite(last) ? Number(((last - first) / 60_000).toFixed(2)) : null;
  return { ...record, rtoTargetMinutes: target, achievedRtoMinutes: achieved, rtoMet: achieved === null || target === null ? null : achieved <= target };
}

/** Plain problems with a sterling-restore-test/1 record; empty when it is valid. Achieved values are recomputed and must match. */
export function validateRecord(record) {
  const problems = [];
  if (record?.format !== RECORD_FORMAT) problems.push(`format must be ${RECORD_FORMAT}`);
  if (typeof record?.site !== 'string' || !record.site) problems.push('site is missing');
  if (!SCENARIOS.includes(record?.scenario)) problems.push(`scenario must be one of ${SCENARIOS.join(', ')}`);
  if (typeof record?.operator !== 'string' || !record.operator) problems.push('operator is missing');
  if (!isIso(record?.startedAt) || !isIso(record?.finishedAt)) problems.push('startedAt and finishedAt must be UTC ISO times');
  else if (Date.parse(record.finishedAt) < Date.parse(record.startedAt)) problems.push('the record finishes before it starts');
  for (const list of ['steps', 'findings', 'correctiveActions']) if (!Array.isArray(record?.[list])) problems.push(`${list} must be a list`);
  for (const [index, step] of (Array.isArray(record?.steps) ? record.steps : []).entries()) {
    const where = `step ${index + 1} (${step?.component ?? '?'})`;
    if (!GROUP_IDS.includes(step?.group)) { problems.push(`${where}: group ${JSON.stringify(step?.group)} is not a recovery group (${GROUP_IDS.join(', ')})`); continue; }
    if (!KINDS.includes(step.kind)) problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (!RESULTS.includes(step.result)) problems.push(`${where}: result must be one of ${RESULTS.join(', ')}`);
    if (typeof step.check !== 'string' || !step.check) problems.push(`${where}: check (what was compared) is missing`);
    if (!isIso(step.startedAt) || !isIso(step.finishedAt) || (step.backupTakenAt !== null && !isIso(step.backupTakenAt))) {
      problems.push(`${where}: startedAt, finishedAt and backupTakenAt (or null) must be UTC ISO times`);
      continue;
    }
    if (Date.parse(step.finishedAt) < Date.parse(step.startedAt)) problems.push(`${where}: it finishes before it starts`);
    const expected = computeStep(step, step.rpoTargetMinutes);
    for (const field of ['achievedRpoMinutes', 'achievedRtoMinutes', 'met']) {
      if (step[field] !== expected[field]) problems.push(`${where}: ${field} is ${JSON.stringify(step[field])}, but the times and targets give ${JSON.stringify(expected[field])}`);
    }
  }
  if (!problems.length) {
    const expected = computeRecord(record);
    for (const field of ['achievedRtoMinutes', 'rtoMet']) {
      if (record[field] !== expected[field]) problems.push(`${field} is ${JSON.stringify(record[field])}, but the steps give ${JSON.stringify(expected[field])}`);
    }
  }
  return problems;
}
