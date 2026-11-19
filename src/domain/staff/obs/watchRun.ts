// The standing watch runtime's rules (research note 11, 4.5; WP-WATCH): the register file, the trust check against the signed decision log, matching
// new observations, de-duplication, the alert rate limit and digest, the latest time of value, and the draft a match leads to. Pure: no I/O, no clock
// (times are passed in), no vscode. src/staff/watchHost.ts reads and writes the files and calls these.
//
// What holds whatever calls these:
//   - A watch runs only when a person armed it. Arming and retiring are signed person decisions in the decision log (personDecisions.ts, subject kind
//     `watch`), over the hash of the watch as the person saw it. A watch the file calls armed, paused or matched without a matching signed decision reads
//     as proposed, and one a person retired reads as disarmed, whatever the file says, so a member writing the file by hand cannot arm anything.
//   - Nothing is evaluated without an attended run: evaluateWatch does nothing when `attended` is false.
//   - A match is never dropped: matches found while a watch is paused, or busy with an earlier match, are queued and delivered when it is armed again.
//   - A watch drafts only. Its drafts say plainly that they are drafts for the named person, and they go through the release state machine.
import { createHash } from 'node:crypto';
import { parseIsoMillis } from '../../gate/shape';
import { canonicalize } from '../../team/canonical';
import { formatDtg } from '../intel';
import type { PersonDecisionEntry } from '../personDecisions';
import { renderProductHeader } from '../products';
import type { StaffLevel, StaffProfileId } from '../doctrine';
import type { FeedEvent, WatchAlertEvent, WatchMatchedEvent, WatchPausedEvent, WatchStateEvent } from './events';
import type { Observation } from './observation';
import { sliceObservations } from './slices';
import type { SliceContext } from './slices';
import { alertMode, isDuplicateMatch, parseWatch, TERMINAL_WATCH_STATES, WATCH_CAPS, WATCH_DEFAULTS, watchTransition } from './watches';
import type { StandingWatch, WatchActor, WatchAlertee, WatchEvent, WatchPauseReason } from './watches';

export const WATCH_REGISTER = 'standing-watches';
export const WATCH_FORMAT_VERSION = 1;
/** The most watches one register holds. */
export const WATCH_REGISTER_MAX = 200;

// ---- The register file -------------------------------------------------------------------------------------------------------------------------

/** The register as file text, one watch per line, in the shape of the intel workbench's registers. */
export function renderWatchRegister(entries: readonly StandingWatch[]): string {
  const lines = entries.map((entry, index) => `    ${JSON.stringify(entry)}${index < entries.length - 1 ? ',' : ''}`);
  return `{\n  "register": "${WATCH_REGISTER}",\n  "formatVersion": ${WATCH_FORMAT_VERSION},\n  "entries": [\n${lines.join('\n')}${lines.length ? '\n' : ''}  ]\n}\n`;
}

export type WatchRegisterRead = { readonly ok: true; readonly entries: StandingWatch[] } | { readonly ok: false; readonly message: string };

/**
 * Reads the register strictly. Every watch must read: a register with one damaged watch is refused whole, so a write never drops a watch it could not
 * read. Missing text is an empty register.
 */
export function parseWatchRegisterText(text: string | undefined): WatchRegisterRead {
  if (text === undefined) return { ok: true, entries: [] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, message: 'The standing watches file is not JSON.' }; }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as { register?: unknown; formatVersion?: unknown; entries?: unknown } : undefined;
  if (!record || record.register !== WATCH_REGISTER || record.formatVersion !== WATCH_FORMAT_VERSION || !Array.isArray(record.entries)) {
    return { ok: false, message: 'The standing watches file is not a standing-watches register of format version 1.' };
  }
  if (record.entries.length > WATCH_REGISTER_MAX) return { ok: false, message: `The standing watches file holds more than ${WATCH_REGISTER_MAX} watches.` };
  const entries: StandingWatch[] = [];
  for (let index = 0; index < record.entries.length; index += 1) {
    const parsed = parseWatch(record.entries[index], `entries[${index}]`);
    if (!parsed.ok) return { ok: false, message: `Standing watch ${index + 1} does not read: ${parsed.message}` };
    if (entries.some((entry) => entry.id === parsed.value.id)) return { ok: false, message: `Two standing watches are called ${parsed.value.id}.` };
    entries.push(parsed.value);
  }
  return { ok: true, entries };
}

/** The next free watch id. */
export function nextWatchId(entries: readonly StandingWatch[]): string {
  const highest = entries.reduce((max, entry) => Math.max(max, Number(entry.id.slice('WATCH-'.length)) || 0), 0);
  return `WATCH-${highest + 1}`;
}

// ---- Trust -------------------------------------------------------------------------------------------------------------------------------------

/** The hash of what a person arms: everything that decides what the watch matches, whom it alerts and what it may produce. */
export function watchWording(watch: StandingWatch): string {
  const { title, pir, indicator, condition, ltiov, alert, outputs, label } = watch;
  return createHash('sha256').update(canonicalize({ title, pir, indicator, condition, ltiov, alert, outputs, label })).digest('hex');
}

/** The states only a signed arm decision can put a watch in. */
const ARMED_FAMILY: readonly string[] = ['armed', 'paused', 'matched', 'drafting', 'awaiting-review'];

/**
 * The watch as the signed decision log proves it. Armed, paused, matched, drafting or awaiting review needs the latest signed decision on the watch to
 * be `approved` over its exact wording; otherwise it reads as proposed (and evaluates nothing). A watch whose latest signed decision is `rejected` reads
 * as rejected (never armed) or disarmed (retired), whatever the file says.
 */
export function trustWatch(watch: StandingWatch, decision: PersonDecisionEntry | undefined): { readonly watch: StandingWatch; readonly problem?: string } {
  const strip = (state: 'proposed' | 'rejected' | 'disarmed'): StandingWatch => {
    const { pausedReason: _p, match: _m, drafting: _d, ...rest } = watch;
    void _p; void _m; void _d;
    return { ...rest, state };
  };
  if (decision?.decision === 'rejected') {
    if (watch.state === 'rejected' || watch.state === 'disarmed') return { watch };
    const state = ARMED_FAMILY.includes(watch.state) || watch.state === 'expired' ? 'disarmed' : 'rejected';
    return { watch: strip(state), problem: `${watch.id} was retired by ${decision.person.name} (${decision.person.role}); the file says ${watch.state}, so it reads as ${state}.` };
  }
  if (!ARMED_FAMILY.includes(watch.state)) return { watch };
  if (decision?.decision === 'approved' && decision.wording === watchWording(watch)) return { watch };
  return {
    watch: strip('proposed'),
    problem: decision ? `${watch.id} changed after a person armed it, so it reads as proposed until a person arms it again.` : `${watch.id} has no signed arm decision, so it reads as proposed until a person arms it.`
  };
}

/** Whether a watch at `watchLabel` may look at a row: the same label, or Public. A watch never sees above its own label, so its drafts are never below what they used. */
export function watchSees(watchLabel: string, rowLabel: string): boolean {
  return rowLabel === watchLabel || rowLabel === 'org/Public';
}

// ---- Steps and events --------------------------------------------------------------------------------------------------------------------------

export function actorText(actor: WatchActor): string {
  if (actor.kind === 'system') return 'system';
  if (actor.kind === 'agent') return `member:${actor.member}`;
  return `person:${actor.name} (${actor.role})`;
}

export interface WatchStepContext {
  readonly at: number;
  readonly attendedRun: boolean;
  readonly run: string | null;
  readonly pauseReason?: WatchPauseReason;
  readonly reason?: string;
}

export type WatchStepResult = { readonly ok: true; readonly watch: StandingWatch; readonly events: FeedEvent[] } | { readonly ok: false; readonly message: string };

/** One event through the state machine (watches.ts watchTransition), with the events the staff log records for it. */
export function applyWatchEvent(watch: StandingWatch, event: WatchEvent, actor: WatchActor, context: WatchStepContext): WatchStepResult {
  const step = watchTransition(watch, event, actor, { at: context.at, attendedRun: context.attendedRun, ...(context.pauseReason ? { pauseReason: context.pauseReason } : {}) });
  if (!step.ok) return { ok: false, message: `${watch.id}: ${step.message}` };
  const at = new Date(context.at).toISOString();
  let next: StandingWatch = step.value.watch;
  if (context.reason) next = { ...next, reason: context.reason.slice(0, 300) };
  const events: FeedEvent[] = [];
  if (step.value.from !== step.value.to) {
    events.push({ type: 'staff.watch.state', run: context.run, at, watch: watch.id, from: step.value.from, to: step.value.to, actor: actorText(actor), ...(context.reason ? { reason: context.reason.slice(0, 300) } : {}) } satisfies WatchStateEvent);
  }
  if (next.state === 'paused' && (step.value.from !== 'paused' || event === 'match')) {
    events.push({ type: 'staff.watch.paused', run: context.run, at, watch: watch.id, reason: next.pausedReason ?? 'no-attended-run', missed: next.missedWhilePaused } satisfies WatchPausedEvent);
  }
  return { ok: true, watch: next, events };
}

// ---- Matching ----------------------------------------------------------------------------------------------------------------------------------

/** What one row is about, for de-duplication: its track, else its subject, else the row itself. */
export function matchSubject(row: Observation): string {
  return (row.trackId ?? row.subjectRef ?? row.obsId).slice(0, 120);
}

export interface WatchEvaluation {
  readonly watch: StandingWatch;
  readonly events: FeedEvent[];
  /** A match raised now: the observations it rests on and how many were found while paused. */
  readonly raised?: { readonly observations: readonly string[]; readonly missed: number };
  readonly changed: boolean;
}

export interface WatchEvaluationInput {
  readonly watch: StandingWatch;
  /** Every row the store holds; the watch's own label clamp is applied here. */
  readonly rows: readonly Observation[];
  /** The scenario context for areas (frame, control measures, order of battle); `visible` is the watch's label clamp and is set here. */
  readonly context: Omit<SliceContext, 'visible'>;
  readonly now: number;
  readonly run: string | null;
  /** Whether a person-attended run or the Staff Room is open. Without one nothing is evaluated. */
  readonly attended: boolean;
  /** Feeds whose source is degraded now. */
  readonly degradedFeeds: ReadonlySet<string>;
}

const SYSTEM = { kind: 'system' } as const;

function uniq(ids: readonly string[], cap: number): string[] {
  return [...new Set(ids)].slice(-cap);
}

/**
 * Looks at the observations a watch has not seen yet, once. What happens depends on its state:
 *   - armed: new matches (de-duplicated per subject within the window) and anything queued raise one match (`matched`);
 *   - paused by a person or a degraded source: matches are counted and queued, never dropped; a degraded pause ends by itself when the source recovers;
 *   - paused with no attended run: the observations that came in meanwhile are counted as missed, the watch resumes, and they are delivered as a match;
 *   - matched, drafting or awaiting review: new matches are queued for when a person acknowledges.
 * Past the latest time of value a proposed, armed or paused watch expires. Without an attended run nothing changes at all.
 */
export function evaluateWatch(input: WatchEvaluationInput): WatchEvaluation {
  const unchanged: WatchEvaluation = { watch: input.watch, events: [], changed: false };
  if (!input.attended) return unchanged;
  let watch = input.watch;
  if (TERMINAL_WATCH_STATES.includes(watch.state)) return unchanged;
  const events: FeedEvent[] = [];
  const context = (reason?: string, pauseReason?: WatchPauseReason): WatchStepContext => ({ at: input.now, attendedRun: true, run: input.run, ...(reason ? { reason } : {}), ...(pauseReason ? { pauseReason } : {}) });
  const apply = (event: WatchEvent, reason?: string, pauseReason?: WatchPauseReason): boolean => {
    const result = applyWatchEvent(watch, event, SYSTEM, context(reason, pauseReason));
    if (!result.ok) return false;
    watch = result.watch;
    events.push(...result.events);
    return true;
  };
  const ltiovPassed = input.now > parseIsoMillis(watch.ltiov);
  if (watch.state === 'proposed') {
    if (ltiovPassed && apply('expire', 'Its latest time of value passed before a person armed it.')) return { watch, events, changed: true };
    return unchanged;
  }
  if (ltiovPassed && (watch.state === 'armed' || watch.state === 'paused')) {
    const queued = watch.queued?.length ?? 0;
    apply('expire', `Its latest time of value passed.${queued ? ` ${queued} queued observation${queued === 1 ? '' : 's'} stay in the record.` : ''}`);
    return { watch, events, changed: true };
  }

  // The rows it has not looked at: known after its cursor and by now, inside its label.
  const cursor = watch.cursor ? parseIsoMillis(watch.cursor) : -Infinity;
  const fresh = input.rows.filter((row) => watchSees(watch.label, row.label) && parseIsoMillis(row.knownAt) > cursor && parseIsoMillis(row.knownAt) <= input.now);
  const sliced = fresh.length ? sliceObservations(fresh, { ...watch.condition, limit: 500 }, { ...input.context, visible: (label) => watchSees(watch.label, label) }) : undefined;
  const matching = sliced?.ok ? sliced.value.rows : [];
  // De-duplicated: one match per subject within the window, counting the subjects matched recently.
  const windowMs = WATCH_DEFAULTS.dedupeWindowMinutes * 60_000;
  const recent = (watch.recent ?? []).map((entry) => ({ subject: entry.subject, at: parseIsoMillis(entry.at) })).filter((entry) => input.now - entry.at < windowMs);
  const kept: Observation[] = [];
  for (const row of matching) {
    const subject = matchSubject(row);
    if (isDuplicateMatch(recent, subject, input.now)) continue;
    recent.push({ subject, at: input.now });
    kept.push(row);
  }
  const latestKnown = fresh.reduce((max, row) => Math.max(max, parseIsoMillis(row.knownAt)), cursor);
  const before = JSON.stringify(watch);
  watch = {
    ...watch,
    ...(Number.isFinite(latestKnown) ? { cursor: new Date(latestKnown).toISOString() } : {}),
    recent: recent.slice(-WATCH_CAPS.recent).map((entry) => ({ subject: entry.subject, at: new Date(entry.at).toISOString() }))
  };
  const ids = kept.map((row) => row.obsId);
  const feeds = watch.condition.feeds ?? [];
  const degraded = feeds.filter((feed) => input.degradedFeeds.has(feed));

  if (watch.state === 'paused') {
    if (watch.pausedReason === 'no-attended-run') {
      // Back with a person: what came in meanwhile is what it missed.
      watch = { ...watch, missedWhilePaused: watch.missedWhilePaused + ids.length, queued: uniq([...(watch.queued ?? []), ...ids], WATCH_CAPS.queued) };
      const missed = watch.missedWhilePaused;
      apply('resume', missed ? `A person is attending again. Missed while paused: ${missed} match${missed === 1 ? '' : 'es'}, queued for the person.` : 'A person is attending again.');
    } else {
      for (let index = 0; index < ids.length; index += 1) apply('match');
      if (ids.length) watch = { ...watch, queued: uniq([...(watch.queued ?? []), ...ids], WATCH_CAPS.queued) };
      if (watch.pausedReason === 'source-degraded' && degraded.length === 0) {
        const missed = watch.missedWhilePaused;
        apply('resume', `Its source recovered.${missed ? ` Missed while paused: ${missed} match${missed === 1 ? '' : 'es'}, queued for the person.` : ''}`);
      }
    }
    if (watch.state === 'paused') return { watch, events, changed: events.length > 0 || JSON.stringify(watch) !== before };
  } else if (watch.state === 'armed' && degraded.length) {
    watch = { ...watch, queued: uniq([...(watch.queued ?? []), ...ids], WATCH_CAPS.queued), missedWhilePaused: watch.missedWhilePaused + ids.length };
    apply('pause', `Its source is degraded: ${degraded.join(', ')}.`, 'source-degraded');
    return { watch, events, changed: true };
  } else if (watch.state !== 'armed') {
    // Busy with a match: new ones wait for the person's acknowledgement.
    if (ids.length) watch = { ...watch, queued: uniq([...(watch.queued ?? []), ...ids], WATCH_CAPS.queued) };
    return { watch, events, changed: JSON.stringify(watch) !== before };
  }

  // Armed: anything queued and anything new is one match.
  const delivered = uniq([...(watch.queued ?? []), ...ids], WATCH_CAPS.queued);
  if (!delivered.length) return { watch, events, changed: JSON.stringify(watch) !== before };
  const missed = watch.missedWhilePaused;
  const observations = delivered.slice(0, WATCH_CAPS.matchObservations);
  const rest = delivered.slice(WATCH_CAPS.matchObservations);
  const matchedAt = new Date(input.now).toISOString();
  if (!apply('match', `${delivered.length} observation${delivered.length === 1 ? '' : 's'} met the condition${missed ? `, ${missed} of them found while paused` : ''}.`)) return { watch, events, changed: true };
  watch = { ...watch, match: { at: matchedAt, observations, missed }, queued: rest };
  if (!watch.queued?.length) { const { queued: _q, ...without } = watch; void _q; watch = without; }
  events.push({ type: 'staff.watch.matched', run: input.run, at: matchedAt, watch: watch.id, pir: watch.pir, indicator: watch.indicator, observations } satisfies WatchMatchedEvent);
  return { watch, events, raised: { observations, missed }, changed: true };
}

// ---- Alerts ------------------------------------------------------------------------------------------------------------------------------------

const personKey = (person: WatchAlertee): string => `${person.name}\u0000${person.role}`;

/** When the alerts (not digest entries) to a person went out, from the staff log. */
export function alertTimes(events: readonly FeedEvent[], person: WatchAlertee): number[] {
  return events.filter((event): event is WatchAlertEvent => event.type === 'staff.watch.alert' && event.mode === 'alert' && personKey(event.person) === personKey(person)).map((event) => parseIsoMillis(event.at));
}

/** The digest waiting for a person: the watches and matches recorded as digest entries since their last alert. */
export function pendingDigest(events: readonly FeedEvent[], person: WatchAlertee): { readonly entries: number; readonly matches: number; readonly watches: readonly string[] } {
  let entries = 0; let matches = 0; const watches = new Set<string>();
  for (const event of events) {
    if (event.type !== 'staff.watch.alert' || personKey(event.person) !== personKey(person)) continue;
    if (event.mode === 'alert') { entries = 0; matches = 0; watches.clear(); continue; }
    entries += 1; matches += event.matches; watches.add(event.watch);
  }
  return { entries, matches, watches: [...watches] };
}

/**
 * The alert for a named person: on its own while they have had fewer than the hourly cap, otherwise a digest entry. An alert that goes out carries the
 * digest waiting for them, so nothing a digest held is lost.
 */
export function planAlert(history: readonly FeedEvent[], watch: StandingWatch, matches: number, now: number, run: string | null): { readonly event: WatchAlertEvent; readonly digest: ReturnType<typeof pendingDigest> } {
  const mode = alertMode(alertTimes(history, watch.alert), now);
  const event: WatchAlertEvent = { type: 'staff.watch.alert', run, at: new Date(now).toISOString(), watch: watch.id, person: { name: watch.alert.name, role: watch.alert.role }, mode, matches };
  return { event, digest: mode === 'alert' ? pendingDigest(history, watch.alert) : { entries: 0, matches: 0, watches: [] } };
}

// ---- Drafts ------------------------------------------------------------------------------------------------------------------------------------

/** The line every watch draft carries, so nobody reads it as released or decided. */
export function watchDraftNotice(alert: WatchAlertee): string {
  return `DRAFT for ${alert.name} (${alert.role}). Drafted by a standing watch; not released and not decided. A named person reviews it.`;
}

export type WatchDraftKind = 'intrep' | 'ecoa-revision';

/** The product an INTREP draft for a match is written as. */
export function watchIntrepProduct(watch: StandingWatch, at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `intrep-${watch.id.toLowerCase()}-${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}`;
}

/** One matched row as a draft line: ids, times, feed, grades and track, and no free text from the feed (that stays fenced in the tools). */
function evidenceLine(row: Observation): string {
  return `- Observation ${row.obsId.slice(0, 16)}: valid ${row.validAt}, known ${row.knownAt}; ${row.feed}/${row.channel}${row.discipline ? ` ${row.discipline}` : ''}${row.simulated ? ' (SIM, exercise)' : ''}; reliability ${row.reliability}, credibility ${row.credibility}${row.trackId ? `; track ${row.trackId}` : ''}.`;
}

function evidence(rows: readonly Observation[]): string[] {
  const origins = new Set(rows.map((row) => row.origin.trim().toLowerCase())).size;
  return [...rows.map(evidenceLine), `${rows.length} observation${rows.length === 1 ? '' : 's'} from ${origins} independent origin${origins === 1 ? '' : 's'}; observations that share an origin count once.`];
}

export interface WatchDraftSource {
  readonly watch: StandingWatch;
  /** The rows of the match the drafting member may see. */
  readonly rows: readonly Observation[];
  readonly at: number;
  readonly owner: string;
  readonly settings: { readonly profile: StaffProfileId; readonly level: StaffLevel };
}

/** The INTREP draft for a match, as a product file in the J2 INTREP headings, with the draft notice first and the deduction left to the analyst. */
export function watchIntrepDraft(input: WatchDraftSource): { readonly product: string; readonly text: string } {
  const { watch } = input;
  const product = watchIntrepProduct(watch, input.at);
  const missed = watch.match?.missed ?? 0;
  const header = renderProductHeader({ product, kind: 'report', section: 'j2', owner: input.owner, profile: input.settings.profile, level: input.settings.level, version: 1, state: 'draft', label: watch.label, dependsOn: [] });
  const body = [
    `# INTREP ${formatDtg(input.at)}`,
    '',
    watchDraftNotice(watch.alert),
    '',
    '## Event',
    '',
    `${formatDtg(input.at)}: standing watch ${watch.id} (${watch.title}) matched ${watch.match?.observations.length ?? input.rows.length} observation${(watch.match?.observations.length ?? input.rows.length) === 1 ? '' : 's'}${missed ? `, ${missed} of them found while it was paused` : ''}.`,
    '<!-- Analyst: say in one line what happened, from the observations below. -->',
    '',
    '## Indicator triggered',
    '',
    `Indicator ${watch.indicator} of ${watch.pir}; latest time of value ${formatDtg(parseIsoMillis(watch.ltiov))}.`,
    '',
    '## Source and grades',
    '',
    ...(input.rows.length ? evidence(input.rows) : ['None of the matched observations is inside your clearance; ask the named person.']),
    '',
    '## Deduction',
    '',
    '<!-- Analyst: your deduction, with ICD 203 likelihood terms. Say what it means for the decision point and what to watch next. -->',
    '',
    '## Who needs to know',
    '',
    `${watch.alert.name} (${watch.alert.role}), named on ${watch.id}, reviews this draft and decides.`,
    ''
  ];
  return { product, text: `${header}${body.join('\n')}` };
}

/** The revision note for an adversary COA product: added by its owner to a new version, which the tradecraft gate and the release-guard check. */
export function watchEcoaRevisionNote(input: Omit<WatchDraftSource, 'owner' | 'settings'>): string {
  const { watch } = input;
  return [
    `## Revision from standing watch ${watch.id} (draft)`,
    '',
    watchDraftNotice(watch.alert),
    '',
    `Indicator ${watch.indicator} of ${watch.pir} matched at ${formatDtg(input.at)} (${watch.title}).`,
    ...(input.rows.length ? evidence(input.rows) : []),
    '',
    '<!-- Analyst: say which adversary course of action this indicator confirms or denies, and revise the likelihood and the ranking with ICD 203 terms. Keep confidence in its own sentence. A person decides whether the revision stands. -->',
    ''
  ].join('\n');
}
