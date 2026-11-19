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
import { childPath, choice, fail, field, fields, int, isoTime, obsRefused, optionalField, reading, templateLabel, text, uniqueList } from './read';
import type { ObsFailure, ObsParsed } from './read';
import { parseSliceQuery } from './slices';
import type { SliceQuery } from './slices';

export const WATCH_STATES = ['proposed', 'armed', 'paused', 'matched', 'drafting', 'awaiting-review', 'expired', 'disarmed', 'rejected'] as const;
export type WatchState = (typeof WATCH_STATES)[number];
export const TERMINAL_WATCH_STATES: readonly WatchState[] = ['expired', 'disarmed', 'rejected'];

export const WATCH_EVENTS = ['arm', 'reject', 'match', 'pause', 'resume', 'draft', 'drafts-ready', 'acknowledge', 'expire', 'disarm'] as const;
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
    const raw = fields(value, path, ['id', 'title', 'pir', 'indicator', 'condition', 'ltiov', 'alert', 'outputs', 'runMode', 'state', 'missedWhilePaused', 'label'], ['pausedReason']);
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
      label: templateLabel(field(raw, 'label'), at('label'))
    };
  });
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
  { from: ['awaiting-review'], event: 'acknowledge', to: 'armed', who: 'person' },
  { from: ['proposed', 'armed', 'paused'], event: 'expire', to: 'expired', who: 'system' },
  { from: ['armed', 'paused', 'awaiting-review'], event: 'disarm', to: 'disarmed', who: 'person' }
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

