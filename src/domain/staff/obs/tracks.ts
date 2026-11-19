// Tracks and decay (research note 11, sections 3.2 and 4.3; WP-OBS0). Pure: no I/O, no clock (the time is passed in), no vscode.
//
// A track is a resolved thing plus its ordered observations, computed for the reader: the last known position a person sees uses only rows their
// clearance covers, so a higher-labelled update never leaks into a lower-cleared reader's picture. Decay changes only how a track is shown, never the
// rows: observations are never deleted by decay.
import { parseIsoMillis } from '../../gate/shape';
import type { DecayPolicy } from './feeds';
import { joinTemplateLabels } from './observation';
import type { Observation } from './observation';

export const TRACK_STATES = ['live', 'stale', 'lost', 'closed'] as const;
export type TrackState = (typeof TRACK_STATES)[number];

/** What moves a track: a new observation, the stale interval or the lost TTL passing, or a person or rule closing it (or a merge into another). */
export const TRACK_EVENTS = ['observation', 'interval-passed', 'ttl-passed', 'close', 'merge'] as const;
export type TrackEvent = (typeof TRACK_EVENTS)[number];

/** Every allowed transition (note 11, 4.3). `closed` is the end: a closed track is hidden but replayable. */
export const TRACK_TRANSITIONS: ReadonlyArray<{ readonly from: TrackState; readonly event: TrackEvent; readonly to: TrackState }> = [
  { from: 'live', event: 'observation', to: 'live' },
  { from: 'live', event: 'interval-passed', to: 'stale' },
  { from: 'live', event: 'close', to: 'closed' },
  { from: 'live', event: 'merge', to: 'closed' },
  { from: 'stale', event: 'observation', to: 'live' },
  { from: 'stale', event: 'ttl-passed', to: 'lost' },
  { from: 'stale', event: 'close', to: 'closed' },
  { from: 'stale', event: 'merge', to: 'closed' },
  { from: 'lost', event: 'observation', to: 'live' },
  { from: 'lost', event: 'close', to: 'closed' },
  { from: 'lost', event: 'merge', to: 'closed' }
];

/** The next track state, or undefined for a transition the table does not allow. */
export function trackTransition(from: TrackState, event: TrackEvent): TrackState | undefined {
  return TRACK_TRANSITIONS.find((entry) => entry.from === from && entry.event === event)?.to;
}

/**
 * The display state of an open track at `now`, from its newest observation: live until the stale time (the row's own `validUntil`, CoT's `stale`, when it
 * is earlier than the feed's interval), stale until the lost TTL, then lost. Static data (no decay policy) stays live.
 */
export function decayState(last: Pick<Observation, 'validAt' | 'validUntil'>, now: number, decay: DecayPolicy | null): Exclude<TrackState, 'closed'> {
  if (decay === null) return 'live';
  const seen = parseIsoMillis(last.validAt);
  const interval = seen + decay.staleAfterSeconds * 1000;
  const staleAt = last.validUntil !== undefined ? Math.min(parseIsoMillis(last.validUntil), interval) : interval;
  if (now < staleAt) return 'live';
  if (now < seen + decay.lostAfterSeconds * 1000) return 'stale';
  return 'lost';
}

/** A time gap in a track's observations longer than its lost TTL: shown on the track and in replay, never filled in. */
export interface TrackGap { readonly from: string; readonly to: string }

export interface TrackView {
  readonly trackId: string;
  readonly state: TrackState;
  /** The rows the reader may see, oldest first by valid time, superseded rows left out. */
  readonly observations: readonly string[];
  readonly last: Observation;
  readonly lastValidAt: string;
  /** The join of the labels of the rows used: never lower than the highest of them. */
  readonly label: string;
  readonly gaps: readonly TrackGap[];
  /** Whether any row came from a simulated source (the SIM badge). */
  readonly simulated: boolean;
}

/**
 * One track for one reader. `visible` says whether the reader's clearance covers a label; rows it does not cover are left out before anything is computed,
 * so the result is the same as from a store that never held them. Undefined when the reader sees no row of the track, or when the visible rows' labels
 * are on different scales and cannot be joined.
 */
export function buildTrack(trackId: string, rows: readonly Observation[], visible: (label: string) => boolean, now: number, decay: DecayPolicy | null, closed = false): TrackView | undefined {
  const seen = rows.filter((row) => row.trackId === trackId && visible(row.label));
  const superseded = new Set(seen.flatMap((row) => (row.supersedes ? [row.supersedes] : [])));
  const used = seen.filter((row) => !superseded.has(row.obsId))
    .sort((a, b) => parseIsoMillis(a.validAt) - parseIsoMillis(b.validAt) || a.obsId.localeCompare(b.obsId));
  if (used.length === 0) return undefined;
  const label = joinTemplateLabels(used.map((row) => row.label));
  if (label === undefined) return undefined;
  const last = used[used.length - 1];
  const gaps: TrackGap[] = [];
  if (decay !== null) {
    for (let index = 1; index < used.length; index += 1) {
      if (parseIsoMillis(used[index].validAt) - parseIsoMillis(used[index - 1].validAt) > decay.lostAfterSeconds * 1000) gaps.push({ from: used[index - 1].validAt, to: used[index].validAt });
    }
  }
  return {
    trackId, state: closed ? 'closed' : decayState(last, now, decay), observations: used.map((row) => row.obsId), last, lastValidAt: last.validAt, label, gaps,
    simulated: used.some((row) => row.simulated)
  };
}
