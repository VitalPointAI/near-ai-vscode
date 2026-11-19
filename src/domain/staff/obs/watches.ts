// Standing watches (research note 11, 4.5; WP-OBS0): an armed indicator that drafts, never decides. Pure: no I/O, no clock (times are passed in), no
// vscode. WP-WATCH builds the matching runtime on these rules.
//
// Three rules hold whatever the runtime does:
//   - Drafts only. A match drafts an INTREP and, when it bears on an adversary COA indicator, a revised threat assessment or COA ranking, as drafts in
//     the release state machine; it marks dependent products "source changed" and alerts a named person. No watch releases, approves or tasks anything
//     (the J2 recommends, the J3 approves collection).
//   - A named person. Only a person arms, rejects, disarms or acknowledges a watch, and every alert goes to a named person, never to a member.
//   - Attended runs only. Until Phase 74 run contracts exist, a watch is evaluated only while a person has the staff run open (owner decision Q5,
//     2026-11-18); without one it is paused, and matches found on resume are queued with a count, never dropped.
import { parseIsoMillis } from '../../gate/shape';
import { isNamedPerson } from '../release';
import type { StaffActor } from '../release';
import { childPath, choice, fail, field, fields, int, isoTime, list, obsRefused, optionalField, reading, templateLabel, text, uniqueList } from './read';
import type { ObsFailure, ObsParsed } from './read';
import { parseSliceQuery } from './slices';
import type { SliceQuery } from './slices';

export const WATCH_STATES = ['proposed', 'armed', 'paused', 'matched', 'drafting', 'awaiting-review', 'expired', 'disarmed', 'rejected'] as const;
export type WatchState = (typeof WATCH_STATES)[number];
export const TERMINAL_WATCH_STATES: readonly WatchState[] = ['expired', 'disarmed', 'rejected'];

export const WATCH_EVENTS = ['arm', 'reject', 'match', 'pause', 'resume', 'draft', 'drafts-ready', 'abandon', 'acknowledge', 'expire', 'disarm'] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];

/** What a match may produce: drafts, a "source changed" mark and an alert. Nothing else is expressible. */
export const WATCH_OUTPUTS = ['draft-intrep', 'draft-threat-revision', 'draft-ecoa-revision', 'mark-source-changed', 'alert-person'] as const;
export type WatchOutput = (typeof WATCH_OUTPUTS)[number];

/** How a watch runs. `unattended` waits for Phase 74 run contracts and is refused until then. */
export const WATCH_RUN_MODES = ['attended'] as const;
export type WatchRunMode = (typeof WATCH_RUN_MODES)[number];

export const WATCH_PAUSE_REASONS = ['no-attended-run', 'source-degraded', 'person'] as const;
export type WatchPauseReason = (typeof WATCH_PAUSE_REASONS)[number];

/** Design values for alert fatigue (note 11, 4.5): one alert per watch per subject within the window; over the hourly cap, a digest instead. */
export const WATCH_DEFAULTS = { dedupeWindowMinutes: 30, alertsPerPersonPerHour: 4 } as const;

/** The person a watch alerts: a name and a role on record, never a member. */
export interface WatchAlertee { readonly name: string; readonly role: string }

/** The match a watch is working on: when it was raised, the observations it rests on, and how many of them were found while it was paused. */
export interface WatchMatch { readonly at: string; readonly observations: readonly string[]; readonly missed: number }

/** A draft a member made for a match, as the product ledger holds it: the product and the version recorded. */
export interface WatchDraftRef { readonly product: string; readonly version: number }

/** The most observation ids a watch keeps queued or on one match, and the most subjects it remembers for de-duplication. */
export const WATCH_CAPS = { queued: 500, matchObservations: 100, recent: 200, drafts: 5 } as const;

export interface StandingWatch {
  readonly id: string;
  readonly title: string;
  /** The PIR and indicator it serves (drop 1 PIR register ids). */
  readonly pir: string;
  readonly indicator: string;
  /** The condition: a slice (area or NAI, time window, minimum grades, disciplines). */
  readonly condition: SliceQuery;
  /** The PIR's latest time of value: past it, the watch expires. */
  readonly ltiov: string;
  readonly alert: WatchAlertee;
  readonly outputs: readonly WatchOutput[];
  readonly runMode: WatchRunMode;
  readonly state: WatchState;
  readonly pausedReason?: WatchPauseReason;
  /** Matches found while paused, queued for the person on resume. */
  readonly missedWhilePaused: number;
  readonly label: string;
  // Runtime fields (WP-WATCH), written only by the watch host:
  /** Who drafted it: `person:<name> (<role>)` or `member:<slug>`. */
  readonly proposedBy?: string;
  /** The known time the watch has looked at observations through. Rows known later are new to it. */
  readonly cursor?: string;
  /** Observations found while the watch could not raise a match (paused, or busy with one), delivered when it is armed again: never dropped. */
  readonly queued?: readonly string[];
  /** Subjects matched recently, for de-duplication within the window. */
  readonly recent?: ReadonlyArray<{ readonly subject: string; readonly at: string }>;
  /** The match being worked on (matched, drafting, awaiting-review). */
  readonly match?: WatchMatch;
  /** The member run drafting it now. */
  readonly drafting?: { readonly run: string; readonly member: string };
  /** The drafts made for the match, waiting in the release state machine. */
  readonly drafts?: readonly WatchDraftRef[];
  /** Why it ended, or why its last step happened, in one line. */
  readonly reason?: string;
}

const WATCH_ID = /^WATCH-[1-9][0-9]{0,5}$/;
const PIR_ID = /^PIR-[1-9][0-9]{0,4}$/;
const INDICATOR_ID = /^IND-[1-9][0-9]{0,5}$/;

/**
 * Reads a watch strictly. An output outside WATCH_OUTPUTS (release, approve, task collection) is `drafts-only`; a run mode other than `attended` is
 * `attended-only`; an alert to a member rather than a person is `not-a-person`.
 */
export function parseWatch(value: unknown, path = ''): ObsParsed<StandingWatch> {
  return reading(() => {
    const raw = fields(value, path, ['id', 'title', 'pir', 'indicator', 'condition', 'ltiov', 'alert', 'outputs', 'runMode', 'state', 'missedWhilePaused', 'label'], ['pausedReason', ...WATCH_RUNTIME_FIELDS]);
    const at = (key: string): string => childPath(path, key);
    const id = (key: string, pattern: RegExp): string => {
      const v = field(raw, key);
      if (typeof v !== 'string' || !pattern.test(v)) fail('wrong-type', at(key));
      return v;
    };
    const condition = parseSliceQuery(field(raw, 'condition'), at('condition'));
    if (!condition.ok) fail(condition.reason, condition.path);
    const alertRaw = field(raw, 'alert');
    if (alertRaw !== null && typeof alertRaw === 'object' && Object.prototype.hasOwnProperty.call(alertRaw, 'member')) fail('not-a-person', at('alert'));
    const alert = fields(alertRaw, at('alert'), ['name', 'role']);
    const outputs = uniqueList(field(raw, 'outputs'), at('outputs'), WATCH_OUTPUTS.length + 5, (item, where) => {
      if (typeof item !== 'string' || !(WATCH_OUTPUTS as readonly string[]).includes(item)) fail('drafts-only', where);
      return item as WatchOutput;
    });
    if (!outputs.includes('alert-person')) fail('missing-field', at('outputs'));
    const runMode = field(raw, 'runMode');
    if (!(WATCH_RUN_MODES as readonly unknown[]).includes(runMode)) fail('attended-only', at('runMode'));
    const state = choice(WATCH_STATES, field(raw, 'state'), at('state'));
    const pausedReason = optionalField(raw, 'pausedReason', path, (v, where) => choice(WATCH_PAUSE_REASONS, v, where));
    if ((state === 'paused') !== (pausedReason !== undefined)) fail(state === 'paused' ? 'missing-field' : 'unknown-field', at('pausedReason'));
    return {
      id: id('id', WATCH_ID), title: text(field(raw, 'title'), at('title'), 200), pir: id('pir', PIR_ID), indicator: id('indicator', INDICATOR_ID),
      condition: condition.value, ltiov: isoTime(field(raw, 'ltiov'), at('ltiov')),
      alert: { name: text(field(alert, 'name'), childPath(at('alert'), 'name'), 120), role: text(field(alert, 'role'), childPath(at('alert'), 'role'), 120) },
      outputs, runMode: 'attended', state, ...(pausedReason ? { pausedReason } : {}),
      missedWhilePaused: int(field(raw, 'missedWhilePaused'), at('missedWhilePaused'), 0, 1_000_000),
      label: templateLabel(field(raw, 'label'), at('label')),
      ...runtimeFields(raw, path)
    };
  });
}

const WATCH_RUNTIME_FIELDS = ['proposedBy', 'cursor', 'queued', 'recent', 'match', 'drafting', 'drafts', 'reason'] as const;
const OBS_ID = /^obs-[0-9a-f]{64}$/;
const MEMBER_SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const PRODUCT_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function obsIds(value: unknown, path: string, max: number): string[] {
  return uniqueList(value, path, max, (item, where) => {
    if (typeof item !== 'string' || !OBS_ID.test(item)) fail('wrong-type', where);
    return item;
  });
}

/** The runtime fields, each read strictly when present. */
function runtimeFields(raw: Parameters<typeof field>[0], path: string): Partial<StandingWatch> {
  const out: { -readonly [K in keyof StandingWatch]?: StandingWatch[K] } = {};
  const proposedBy = optionalField(raw, 'proposedBy', path, (v, where) => text(v, where, 200));
  if (proposedBy !== undefined) out.proposedBy = proposedBy;
  const cursor = optionalField(raw, 'cursor', path, isoTime);
  if (cursor !== undefined) out.cursor = cursor;
  const queued = optionalField(raw, 'queued', path, (v, where) => obsIds(v, where, WATCH_CAPS.queued));
  if (queued !== undefined) out.queued = queued;
  const recent = optionalField(raw, 'recent', path, (v, where) => list(v, where, WATCH_CAPS.recent, (item, itemAt) => {
    const entry = fields(item, itemAt, ['subject', 'at']);
    return { subject: text(field(entry, 'subject'), childPath(itemAt, 'subject'), 120), at: isoTime(field(entry, 'at'), childPath(itemAt, 'at')) };
  }));
  if (recent !== undefined) out.recent = recent;
  const match = optionalField(raw, 'match', path, (v, where) => {
    const entry = fields(v, where, ['at', 'observations', 'missed']);
    return {
      at: isoTime(field(entry, 'at'), childPath(where, 'at')), observations: obsIds(field(entry, 'observations'), childPath(where, 'observations'), WATCH_CAPS.matchObservations),
      missed: int(field(entry, 'missed'), childPath(where, 'missed'), 0, 1_000_000)
    };
  });
  if (match !== undefined) out.match = match;
  const drafting = optionalField(raw, 'drafting', path, (v, where) => {
    const entry = fields(v, where, ['run', 'member']);
    const member = field(entry, 'member');
    if (typeof member !== 'string' || !MEMBER_SLUG.test(member)) fail('wrong-type', childPath(where, 'member'));
    return { run: text(field(entry, 'run'), childPath(where, 'run'), 120), member };
  });
  if (drafting !== undefined) out.drafting = drafting;
  const drafts = optionalField(raw, 'drafts', path, (v, where) => list(v, where, WATCH_CAPS.drafts, (item, itemAt) => {
    const entry = fields(item, itemAt, ['product', 'version']);
    const product = field(entry, 'product');
    if (typeof product !== 'string' || !PRODUCT_SLUG.test(product)) fail('wrong-type', childPath(itemAt, 'product'));
    return { product, version: int(field(entry, 'version'), childPath(itemAt, 'version'), 1, 100_000) };
  }));
  if (drafts !== undefined) out.drafts = drafts;
  const reason = optionalField(raw, 'reason', path, (v, where) => text(v, where, 300));
  if (reason !== undefined) out.reason = reason;
  return out;
}

/** Actions a watch may never take, whatever its outputs say; the tests prove each is refused. */
export const WATCH_FORBIDDEN_ACTIONS: readonly string[] = ['release', 'approve', 'task-collection', 'arm-another-watch', 'decide'];

/** Who may cause each event: a named person, a member run (an agent) or the runtime itself (`system`). */
export const WATCH_TRANSITIONS: ReadonlyArray<{ readonly from: readonly WatchState[]; readonly event: WatchEvent; readonly to: WatchState; readonly who: 'person' | 'agent' | 'system' | 'agent-or-system' | 'person-or-system' }> = [
  { from: ['proposed'], event: 'arm', to: 'armed', who: 'person' },
  { from: ['proposed'], event: 'reject', to: 'rejected', who: 'person' },
  { from: ['armed'], event: 'match', to: 'matched', who: 'system' },
  { from: ['paused'], event: 'match', to: 'paused', who: 'system' },
  { from: ['armed'], event: 'pause', to: 'paused', who: 'person-or-system' },
  { from: ['paused'], event: 'resume', to: 'armed', who: 'person-or-system' },
  { from: ['matched'], event: 'draft', to: 'drafting', who: 'agent' },
  { from: ['drafting'], event: 'drafts-ready', to: 'awaiting-review', who: 'agent-or-system' },
  // The member run drafting it ended without drafts: the match goes back to wait for the next member run, so drafting never waits forever (WP-WATCH).
  { from: ['drafting'], event: 'abandon', to: 'matched', who: 'agent-or-system' },
  { from: ['awaiting-review'], event: 'acknowledge', to: 'armed', who: 'person' },
  { from: ['proposed', 'armed', 'paused'], event: 'expire', to: 'expired', who: 'system' },
  // A person may retire a watch whatever it is doing, so a match no member run picks up never holds it (WP-WATCH).
  { from: ['armed', 'paused', 'matched', 'drafting', 'awaiting-review'], event: 'disarm', to: 'disarmed', who: 'person' }
];

export type WatchActor = StaffActor | { readonly kind: 'system' };

export interface WatchStep {
  readonly watch: StandingWatch;
  readonly from: WatchState;
  readonly to: WatchState;
  readonly event: WatchEvent;
}

/** What the runtime knows when it applies an event: the time, and whether a person has the staff run open. */
export interface WatchContext { readonly at: number; readonly attendedRun: boolean; readonly pauseReason?: WatchPauseReason }

/**
 * Applies one event to a watch, or refuses it. Arming without an attended run arms the watch straight into `paused` (no-attended-run). A match needs an
 * attended run and a time before the latest time of value; a match while paused is counted, not dropped; resuming needs an attended run; the person's
 * acknowledgement clears the missed count.
 */
export function watchTransition(watch: StandingWatch, event: WatchEvent, actor: WatchActor, context: WatchContext): ObsParsed<WatchStep> {
  const rule = WATCH_TRANSITIONS.find((entry) => entry.event === event && entry.from.includes(watch.state));
  if (!rule) return obsRefused('bad-transition', 'event');
  const person = actor.kind === 'person' && isNamedPerson(actor);
  const allowed = rule.who === 'person' ? person
    : rule.who === 'agent' ? actor.kind === 'agent'
      : rule.who === 'system' ? actor.kind === 'system'
        : rule.who === 'agent-or-system' ? actor.kind === 'agent' || actor.kind === 'system'
          : person || actor.kind === 'system';
  if (!allowed) return obsRefused(rule.who === 'person' ? 'not-a-person' : 'bad-transition', 'actor');
  // A watch a person paused is resumed by a person: the runtime resumes only the pauses it made itself.
  if (event === 'resume' && actor.kind === 'system' && watch.pausedReason === 'person') return obsRefused('not-a-person', 'actor');
  const ltiovPassed = context.at > parseIsoMillis(watch.ltiov);
  if (ltiovPassed && ['arm', 'match', 'resume', 'draft'].includes(event)) return obsRefused('ltiov-passed', 'ltiov');
  if (event === 'expire' && !ltiovPassed) return obsRefused('bad-transition', 'ltiov');
  if (!context.attendedRun && ['match', 'resume', 'draft'].includes(event)) return obsRefused('attended-only', 'run');
  let next: StandingWatch;
  if (event === 'arm' && !context.attendedRun) {
    next = { ...watch, state: 'paused', pausedReason: 'no-attended-run' };
  } else if (event === 'pause') {
    next = { ...watch, state: 'paused', pausedReason: context.pauseReason ?? (actor.kind === 'person' ? 'person' : 'no-attended-run') };
  } else if (event === 'match' && watch.state === 'paused') {
    next = { ...watch, missedWhilePaused: watch.missedWhilePaused + 1 };
  } else {
    const { pausedReason: _dropped, ...rest } = watch;
    void _dropped;
    next = { ...rest, state: rule.to, ...(event === 'acknowledge' ? { missedWhilePaused: 0 } : {}) };
  }
  return { ok: true, value: { watch: next, from: watch.state, to: next.state, event } };
}

/** Whether a watch output is allowed. Anything outside WATCH_OUTPUTS is refused as `drafts-only`. */
export function checkWatchOutput(output: string): ObsFailure | undefined {
  return (WATCH_OUTPUTS as readonly string[]).includes(output) ? undefined : 'drafts-only';
}

/** Whether a match repeats one already raised for the same subject within the de-duplication window. */
export function isDuplicateMatch(previous: ReadonlyArray<{ readonly at: number; readonly subject: string }>, subject: string, at: number, windowMinutes: number = WATCH_DEFAULTS.dedupeWindowMinutes): boolean {
  return previous.some((match) => match.subject === subject && at - match.at >= 0 && at - match.at < windowMinutes * 60_000);
}

/** Whether the next alert to a person goes out on its own or joins the digest, given when their last alerts went out. */
export function alertMode(sentAt: readonly number[], now: number, perHour: number = WATCH_DEFAULTS.alertsPerPersonPerHour): 'alert' | 'digest' {
  return sentAt.filter((time) => now - time >= 0 && now - time < 3_600_000).length >= perHour ? 'digest' : 'alert';
}

