import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { ActivitySessionSummary } from './activity';

// Team Studio's dashboard (owner, 2026-11-17: "The Team Studio main page needs to be more of a dashboard of existing teams and their statuses, model
// setups, stats about them, rating"). Pure: every figure is worked out from records the extension already keeps, passed in by the host.
//
// - Runs: the open project's activity history (.planning/.near-ai/activity.json). A run belongs to a team by the `/team:<name>` it was started with (its
//   title), the same rule Team Live uses to find a finished run's team. The history is per project, so a library team's runs in other projects are not
//   counted here, and with no folder open there is no history at all (`history: false`).
// - Spend: each run's own figure in that history, which the run writes from the spend ledger (all its requests, sub-agents included, tagged with its run
//   id) when it ends; NEAR's reconciled figure when there is one. A run with no figure is not counted as $0.
// - Health: the free local team check (Improve with AI's first step) and the last role test Optimise all teams ran for the team.
// - Teams are kept (role tests, ratings) by a stable identity (PR 86 review), never by the path to their file: `user:<slug>` for a team in My teams,
//   `project:<hash>` for a project's team, from the project folder's real path (a link to it is the same project; case-folded on Windows).
// - Status: running now (from the live activity feed), needs attention (with the reason), ready (has run, nothing wrong) or never run.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What a team's runs come to. A field that has no record is absent, never zero. */
export interface TeamRunStats {
  runs: number;
  lastRunAt?: string;
  /** Runs still going (or cut off without an end), left out of the success rate and the average time. */
  running: number;
  completed: number;
  /** Failed, stuck, or out of turns. */
  failed: number;
  cancelled: number;
  ended: number;
  /** Completed out of ended, 0 to 1. */
  successRate?: number;
  averageMs?: number;
  timedRuns: number;
  spendUsd?: number;
  /** Runs with a recorded spend: the average per run is over these. */
  costedRuns: number;
  perRunUsd?: number;
  runsThisWeek: number;
  spendThisWeekUsd?: number;
}

/** The last role test of a team (Optimise all teams, or the final step of adding one): scores only, no model names, no task text. */
export interface RoleTestRecord { at: string; members: number; tested: number; score: number }
export interface CheckCounts { block: number; warning: number; advice: number }
export interface HealthPart { id: 'check' | 'role-tests'; label: string; score?: number; detail: string }
export interface TeamHealth { score?: number; parts: HealthPart[] }
export type TeamStatus = 'running' | 'ready' | 'attention' | 'never-run';

export interface DashboardCard {
  id: string;
  status: TeamStatus;
  /** The run going now, when there is one, so Watch it live opens Team Live on it. */
  runId?: string;
  attention: string[];
  stats: TeamRunStats;
  health: TeamHealth;
}

export interface DashboardSummary { teams: number; running: number; runsThisWeek: number; spendThisWeekUsd?: number; attention: number }
export interface TeamDashboard { now: number; history: boolean; summary: DashboardSummary; cards: Record<string, DashboardCard> }

/** A team on the dashboard, as the host lists it. `slug`: what `/team:` names it by (the project team's file is team.md, so its slug is `team`). */
export interface DashboardTeam {
  id: string;
  kind: 'project' | 'user';
  slug: string;
  file: string;
  error?: string;
  imported?: boolean;
  derived?: boolean;
  check?: CheckCounts;
  members: Array<{ name: string; model?: string; available?: boolean }>;
  /** The team's stable identity (teamKey); a project team has none when its folder could not be named. */
  key?: string;
}

export interface RunningTeam { runId: string; slug?: string; file?: string }

const TEAM_TITLE = /^\/team:([a-z0-9][a-z0-9-]{0,60})(?:\s|$)/;

/** The team a run was started with (`/team:<name> ...`), from its title; undefined for any other run. */
export function runTeamSlug(session: Pick<ActivitySessionSummary, 'title'>): string | undefined {
  return session.title ? TEAM_TITLE.exec(session.title)?.[1] : undefined;
}

const time = (iso: string | undefined): number | undefined => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};

/** A run's spend: NEAR's reconciled figure when there is one, else the ledger's estimate; undefined when neither was recorded. */
function runCost(session: ActivitySessionSummary): number | undefined {
  const value = session.actualCostUsd ?? session.estimatedCostUsd;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** How long an ended run took: its own split when it has one, else its start to its end. */
function runDuration(session: ActivitySessionSummary): number | undefined {
  if (session.run && session.run.wallMs > 0) return session.run.wallMs;
  const start = time(session.startedAt);
  const end = time(session.endedAt);
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}

/** The figures for one team's runs. */
export function teamRunStats(sessions: readonly ActivitySessionSummary[], now: number): TeamRunStats {
  const stats: TeamRunStats = { runs: 0, running: 0, completed: 0, failed: 0, cancelled: 0, ended: 0, timedRuns: 0, costedRuns: 0, runsThisWeek: 0 };
  let last: number | undefined;
  let lastIso: string | undefined;
  let totalMs = 0;
  let spend: number | undefined;
  let weekSpend: number | undefined;
  for (const session of sessions) {
    stats.runs += 1;
    const started = time(session.startedAt);
    if (started !== undefined && (last === undefined || started > last)) { last = started; lastIso = session.startedAt; }
    const thisWeek = started !== undefined && started >= now - WEEK_MS;
    if (thisWeek) stats.runsThisWeek += 1;
    const cost = runCost(session);
    if (cost !== undefined) {
      stats.costedRuns += 1;
      spend = (spend ?? 0) + cost;
      if (thisWeek) weekSpend = (weekSpend ?? 0) + cost;
    }
    const outcome = session.runOutcome;
    if (!outcome) { stats.running += 1; continue; }
    stats.ended += 1;
    if (outcome === 'completed') stats.completed += 1;
    else if (outcome === 'cancelled') stats.cancelled += 1;
    else stats.failed += 1;
    const duration = runDuration(session);
    if (duration !== undefined) { stats.timedRuns += 1; totalMs += duration; }
  }
  if (lastIso) stats.lastRunAt = lastIso;
  if (stats.ended) stats.successRate = stats.completed / stats.ended;
  if (stats.timedRuns) stats.averageMs = totalMs / stats.timedRuns;
  if (spend !== undefined) { stats.spendUsd = spend; stats.perRunUsd = spend / stats.costedRuns; }
  if (weekSpend !== undefined) stats.spendThisWeekUsd = weekSpend;
  return stats;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The team's health: the local check (100, less 15 for each problem and 5 for each suggestion; nothing when it holds something that looks like a key) and
 * the last role test's average score, each shown with its own score; the health is the average of the parts that have one.
 */
export function teamHealth(check: CheckCounts | undefined, roleTest?: RoleTestRecord, error?: string): TeamHealth {
  const parts: HealthPart[] = [];
  if (error || !check) parts.push({ id: 'check', label: 'Local check', detail: 'The team file needs fixing before it can be checked.' });
  else if (check.block) parts.push({ id: 'check', label: 'Local check', score: 0, detail: 'It holds something that looks like a key, token or password.' });
  else {
    const score = Math.max(0, 100 - 15 * check.warning - 5 * check.advice);
    const found = [check.warning ? plural(check.warning, 'problem') : '', check.advice ? plural(check.advice, 'suggestion') : ''].filter(Boolean).join(' and ');
    parts.push({ id: 'check', label: 'Local check', score, detail: found ? `${found}. Open the team to see them.` : 'No problems found.' });
  }
  if (roleTest && !error) parts.push({ id: 'role-tests', label: 'Role tests', score: roleTest.score, detail: `${roleTest.tested} of ${roleTest.members} members passed a role test, ${roleTest.score}% on average (${roleTest.at.slice(0, 10)}).` });
  else parts.push({ id: 'role-tests', label: 'Role tests', detail: 'Not tested yet. Optimise all teams tests each member\'s role.' });
  const scored = parts.flatMap((part) => (part.score === undefined ? [] : [part.score]));
  return { ...(scored.length ? { score: Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length) } : {}), parts };
}

/** What a role test came to, from its outcomes: the best usable score of each member (a failed or untested member is 0), as a percentage. */
export function roleTestSummary<T extends { results: ReadonlyArray<{ score: number; outOf: number; failed: boolean }> }>(outcomes: readonly T[], members: number, at: string): RoleTestRecord {
  // Each member's share is held to 0..1 (PR 86 review: a grader scoring past its total made a record over 100, which reading it back then dropped).
  const share = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const best = outcomes.map((outcome) => Math.max(0, ...outcome.results.filter((result) => !result.failed && result.outOf > 0).map((result) => share(result.score / result.outOf))));
  const tested = outcomes.filter((outcome) => outcome.results.some((result) => !result.failed && result.outOf > 0)).length;
  const count = Math.max(members, outcomes.length);
  const score = count ? Math.round((100 * best.reduce((sum, value) => sum + value, 0)) / count) : 0;
  return { at, members: Math.min(100, count), tested: Math.min(100, tested), score: Math.min(100, Math.max(0, score)) };
}

/** The key role tests were kept under before PR 86's review: a hash of the team file's path. Read only, to move them to the team's identity once. */
export function legacyRoleTestKey(file: string): string {
  return createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
}

/** A folder's identity from its real path: trailing separators dropped, case folded on Windows (as file comparisons there are), hashed. */
export function folderIdentity(real: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = real.length > 1 ? real.replace(/[\\/]+$/, '') || real : real;
  const folded = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  return createHash('sha256').update(folded).digest('hex').slice(0, 16);
}

/** A project's identity: its folder's real path (a link to it is the same project), or its absolute path when that cannot be resolved. */
export async function projectIdentity(root: string): Promise<string> {
  const real = await realpath(root).catch(() => path.resolve(root));
  return folderIdentity(real);
}

/** The stable key a team is kept under: `user:<slug>` in My teams, `project:<identity>` for a project's team (undefined without the identity). */
export function teamKey(team: { kind: 'project' | 'user'; slug: string }, project?: string): string | undefined {
  if (team.kind === 'project') return project ? `project:${project}` : undefined;
  return `user:${team.slug}`;
}

const TEAM_KEY = /^(?:user:[a-z0-9][a-z0-9-]{0,60}|project:[0-9a-f]{16})$/;
const LEGACY_KEY = /^[0-9a-f]{16}$/;

/** Role tests kept under the old path keys, moved to the teams' identities: a record already under the new key (newer) is kept. Done once. */
export function migrateRoleTests(records: Record<string, RoleTestRecord>, moves: ReadonlyArray<{ from: string; to: string }>): { records: Record<string, RoleTestRecord>; changed: boolean } {
  const next = { ...records };
  let changed = false;
  for (const { from, to } of moves) {
    const old = next[from];
    if (!old || from === to) continue;
    if (!next[to]) next[to] = old;
    delete next[from];
    changed = true;
  }
  return { records: next, changed };
}

/** The person's own rating of a team, kept on this computer by the team's identity: 1 to 5 stars, or 0 when they cleared it. */
export interface RatingRecord { rating: number; at: string }
export const MAX_RATINGS = 500;

/** The kept ratings with this one set (0 clears it, and is kept so a rating line from an earlier build is not read again), the oldest dropped past 500. */
export function withRating(records: Record<string, RatingRecord>, key: string, rating: number, at: string, max = MAX_RATINGS): Record<string, RatingRecord> {
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('A rating is a whole number of stars from 0 to 5.');
  const entries = Object.entries({ ...records, [key]: { rating, at } }).sort((a, b) => a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
}

/** The kept ratings read back: anything that is not a team's key with a whole number from 0 to 5 is dropped. */
export function parseRatings(value: unknown): Record<string, RatingRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: Record<string, RatingRecord> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!TEAM_KEY.test(key) || !entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== 'string' || time(record.at) === undefined || !count(record.rating, 5)) continue;
    records[key] = { rating: record.rating, at: record.at };
  }
  return records;
}

export const MAX_ROLE_TESTS = 200;

/** The kept role tests with this one added (replacing the team's earlier one), the oldest dropped past MAX_ROLE_TESTS. */
export function withRoleTest(records: Record<string, RoleTestRecord>, key: string, record: RoleTestRecord, max = MAX_ROLE_TESTS): Record<string, RoleTestRecord> {
  const entries = Object.entries({ ...records, [key]: record }).sort((a, b) => a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
}

const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** The kept role tests read back: anything that is not a well-formed record is dropped. */
export function parseRoleTests(value: unknown): Record<string, RoleTestRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: Record<string, RoleTestRecord> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(TEAM_KEY.test(key) || LEGACY_KEY.test(key)) || !entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== 'string' || time(record.at) === undefined || !count(record.members, 100) || !count(record.tested, 100) || !count(record.score, 100)) continue;
    records[key] = { at: record.at, members: record.members, tested: record.tested, score: record.score };
  }
  return records;
}

/** Which of these teams a history run or a running run belongs to: the project team by `project` or its file name `team`, the others by their name. */
function teamForSlug(teams: readonly DashboardTeam[], slug: string): DashboardTeam | undefined {
  const project = teams.find((team) => team.kind === 'project');
  if (slug === 'project' && project) return project;
  if (slug === project?.slug) return project;
  return teams.find((team) => team.kind === 'user' && team.slug === slug);
}

const sameFile = (one: string, two: string) => (process.platform === 'win32' ? path.resolve(one).toLowerCase() === path.resolve(two).toLowerCase() : path.resolve(one) === path.resolve(two));

/** Why a team needs attention, in plain words; empty when nothing does. */
function attentionOf(team: DashboardTeam): string[] {
  const reasons: string[] = [];
  if (team.error) reasons.push(`The team file needs fixing: ${team.error}`);
  if (team.imported) reasons.push(team.derived ? 'Made from an imported team you have not approved: you are asked the first time it runs.' : 'Imported and not approved yet: you are asked the first time it runs.');
  if (team.check?.block) reasons.push('The local check found something that looks like a key, token or password.');
  else if (team.check?.warning) reasons.push(`The local check found ${plural(team.check.warning, 'problem')}. Open the team to see ${team.check.warning === 1 ? 'it' : 'them'}.`);
  const missing = team.members.filter((member) => member.available === false);
  if (missing.length) reasons.push(`${missing.map((member) => `${member.name}'s model${member.model ? ` ${member.model}` : ''}`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available with your key.`);
  return reasons;
}

/** The whole dashboard: a card for each team and the summary row. */
export function buildDashboard(input: { now: number; history: boolean; sessions: readonly ActivitySessionSummary[]; running: readonly RunningTeam[]; roleTests: Record<string, RoleTestRecord>; teams: readonly DashboardTeam[] }): TeamDashboard {
  const runsOf = new Map<string, ActivitySessionSummary[]>();
  if (input.history) {
    for (const session of input.sessions) {
      const slug = runTeamSlug(session);
      const team = slug ? teamForSlug(input.teams, slug) : undefined;
      if (team) runsOf.set(team.id, [...(runsOf.get(team.id) ?? []), session]);
    }
  }
  const runningRun = new Map<string, string>();
  for (const run of input.running) {
    // By its file first; a file that matches no listed team (another case, a link, a path that moved) falls back to the name it runs under.
    const team = (run.file ? input.teams.find((entry) => sameFile(entry.file, run.file!)) : undefined) ?? (run.slug ? teamForSlug(input.teams, run.slug) : undefined);
    if (team && !runningRun.has(team.id)) runningRun.set(team.id, run.runId);
  }
  const cards: Record<string, DashboardCard> = {};
  const summary: DashboardSummary = { teams: input.teams.length, running: 0, runsThisWeek: 0, attention: 0 };
  for (const team of input.teams) {
    const stats = teamRunStats(runsOf.get(team.id) ?? [], input.now);
    const attention = attentionOf(team);
    const runId = runningRun.get(team.id);
    const status: TeamStatus = runId ? 'running' : attention.length ? 'attention' : stats.runs ? 'ready' : 'never-run';
    cards[team.id] = { id: team.id, status, ...(runId ? { runId } : {}), attention, stats, health: teamHealth(team.check, team.key ? input.roleTests[team.key] : undefined, team.error) };
    if (runId) summary.running += 1;
    if (attention.length) summary.attention += 1;
    summary.runsThisWeek += stats.runsThisWeek;
    if (stats.spendThisWeekUsd !== undefined) summary.spendThisWeekUsd = (summary.spendThisWeekUsd ?? 0) + stats.spendThisWeekUsd;
  }
  return { now: input.now, history: input.history, summary, cards };
}
