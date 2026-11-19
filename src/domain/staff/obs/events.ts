// The feed and watch events the UI needs (research note 11, 4.2 and 4.5; design 10, 4.5; WP-OBS0), and the read models the map, the feed panel and the
// watch board draw from them. Types and small pure reducers only: no I/O, no clock, no vscode. Named before they ship (D-49), so a log written by a later
// version never holds an event this version cannot name.
//
// The staff events of design 10 (events.ts) carry the run they happened in. Feed events may happen outside a run (a person importing a file), so their
// `run` is null then; watch events always happen inside an attended run.
import type { StaffWriter } from '../ownership';
import { STAFF_EVENT_TYPES } from '../events';
import type { DegradedReason, FeedSourceState } from './feeds';
import { FEED_LAYERS } from './layers';
import type { TrackState } from './tracks';
import type { WatchPauseReason, WatchState } from './watches';

export const FEED_EVENT_TYPES = [
  'feed.source.state',
  'feed.gap',
  'feed.observations.appended',
  'feed.track.state',
  'feed.layer.settings',
  'staff.watch.state',
  'staff.watch.matched',
  'staff.watch.paused',
  'staff.watch.alert'
] as const;
export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

/** Every event name the staff log may hold: design 10's and these. No name is in both lists. */
export const ALL_STAFF_EVENT_TYPES: readonly string[] = [...STAFF_EVENT_TYPES, ...FEED_EVENT_TYPES];

interface FeedEventBase<T extends FeedEventType> {
  readonly type: T;
  /** The staff run open at the time, or null for a feed event outside any run. */
  readonly run: string | null;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`, the gate's one time form. */
  readonly at: string;
}

/** A feed source changed state, with the reason a degraded or paused source shows. */
export interface FeedSourceStateEvent extends FeedEventBase<'feed.source.state'> {
  readonly feed: string; readonly from: FeedSourceState | null; readonly to: FeedSourceState; readonly reason?: DegradedReason | string; readonly simulated: boolean
}
/** A stream was cut: the map and replay show the gap, and nothing fills it in. */
export interface FeedGapEvent extends FeedEventBase<'feed.gap'> { readonly feed: string; readonly channel: string; readonly from: string; readonly to: string; readonly reason: DegradedReason }
/** Rows were appended to a segment (idempotent: re-delivered rows are counted as `duplicates`, not appended). */
export interface ObservationsAppendedEvent extends FeedEventBase<'feed.observations.appended'> {
  readonly feed: string; readonly channel: string; readonly segment: string; readonly appended: number; readonly duplicates: number;
  readonly layers: readonly string[]; readonly knownFrom: string; readonly knownTo: string; readonly simulated: boolean
}
/** A track changed display state (decay, a new observation, or a person closing it). */
export interface TrackStateEvent extends FeedEventBase<'feed.track.state'> {
  readonly trackId: string; readonly layer: string; readonly from: TrackState | null; readonly to: TrackState; readonly by?: { readonly name: string; readonly role: string }
}
/** A feed layer's settings changed (channels, grades, decay), by its owner. */
export interface FeedLayerSettingsEvent extends FeedEventBase<'feed.layer.settings'> { readonly layer: string; readonly owner: StaffWriter; readonly summary: string }
export interface WatchStateEvent extends FeedEventBase<'staff.watch.state'> {
  readonly watch: string; readonly from: WatchState | null; readonly to: WatchState; readonly actor: string; readonly reason?: string
}
/** A watch matched: what it matched and what it serves. CCIR matches also raise `staff.ccir.triggered`. */
export interface WatchMatchedEvent extends FeedEventBase<'staff.watch.matched'> {
  readonly watch: string; readonly pir: string; readonly indicator: string; readonly observations: readonly string[]; readonly area?: string
}
export interface WatchPausedEvent extends FeedEventBase<'staff.watch.paused'> { readonly watch: string; readonly reason: WatchPauseReason; readonly missed: number }
/** A named person was alerted, alone or in a digest. */
export interface WatchAlertEvent extends FeedEventBase<'staff.watch.alert'> {
  readonly watch: string; readonly person: { readonly name: string; readonly role: string }; readonly mode: 'alert' | 'digest'; readonly matches: number
}

export type FeedEvent =
  | FeedSourceStateEvent | FeedGapEvent | ObservationsAppendedEvent | TrackStateEvent | FeedLayerSettingsEvent
  | WatchStateEvent | WatchMatchedEvent | WatchPausedEvent | WatchAlertEvent;

export function isFeedEventType(value: unknown): value is FeedEventType {
  return typeof value === 'string' && (FEED_EVENT_TYPES as readonly string[]).includes(value);
}

// ---- Read models -------------------------------------------------------------------------------------------------------------------------------

export interface FeedSourceModel {
  readonly feed: string; readonly state: FeedSourceState; readonly reason?: string; readonly since: string; readonly simulated: boolean;
  readonly lastKnownAt?: string; readonly rows: number; readonly gaps: number
}

export interface FeedLayerModel {
  readonly layer: string;
  readonly title: string;
  readonly settingsOwner: StaffWriter;
  /** Feed layers are views: never writable. */
  readonly writable: false;
  /** True when any row in it came from a simulated source: the SIM badge. */
  readonly simulated: boolean;
  readonly tracks: Readonly<Record<TrackState, number>>;
  readonly lastKnownAt?: string;
}

export interface WatchBoardEntry {
  readonly watch: string; readonly state: WatchState; readonly since: string; readonly missed: number; readonly lastMatch?: string; readonly pausedReason?: WatchPauseReason
}

export interface FeedPictureModel {
  readonly sources: readonly FeedSourceModel[];
  readonly layers: readonly FeedLayerModel[];
  readonly watches: readonly WatchBoardEntry[];
  readonly gaps: readonly FeedGapEvent[];
}

/** The feed panel, the feed layers and the watch board, from the event log in order. A page rebuilt after a reload gets the same picture. */
export function feedPicture(events: readonly FeedEvent[]): FeedPictureModel {
  const sources = new Map<string, FeedSourceModel>();
  const layerSim = new Set<string>();
  const layerKnown = new Map<string, string>();
  const tracks = new Map<string, { layer: string; state: TrackState }>();
  const watches = new Map<string, WatchBoardEntry>();
  const gaps: FeedGapEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'feed.source.state': {
        const before = sources.get(event.feed);
        sources.set(event.feed, {
          feed: event.feed, state: event.to, since: event.at, simulated: event.simulated, rows: before?.rows ?? 0, gaps: before?.gaps ?? 0,
          ...(event.reason !== undefined ? { reason: event.reason } : {}), ...(before?.lastKnownAt ? { lastKnownAt: before.lastKnownAt } : {})
        });
        break;
      }
      case 'feed.gap': {
        gaps.push(event);
        const before = sources.get(event.feed);
        if (before) sources.set(event.feed, { ...before, gaps: before.gaps + 1 });
        break;
      }
      case 'feed.observations.appended': {
        const before = sources.get(event.feed);
        if (before) sources.set(event.feed, { ...before, rows: before.rows + event.appended, lastKnownAt: event.knownTo });
        for (const layer of event.layers) {
          if (event.simulated) layerSim.add(layer);
          layerKnown.set(layer, event.knownTo);
        }
        break;
      }
      case 'feed.track.state': tracks.set(event.trackId, { layer: event.layer, state: event.to }); break;
      case 'staff.watch.state': {
        const before = watches.get(event.watch);
        const paused = event.to === 'paused' ? before?.pausedReason : undefined;
        watches.set(event.watch, {
          watch: event.watch, state: event.to, since: event.at, missed: event.to === 'armed' && before?.state === 'awaiting-review' ? 0 : before?.missed ?? 0,
          ...(before?.lastMatch ? { lastMatch: before.lastMatch } : {}), ...(paused ? { pausedReason: paused } : {})
        });
        break;
      }
      case 'staff.watch.paused': {
        const before = watches.get(event.watch);
        watches.set(event.watch, { watch: event.watch, state: 'paused', since: before?.since ?? event.at, missed: event.missed, pausedReason: event.reason, ...(before?.lastMatch ? { lastMatch: before.lastMatch } : {}) });
        break;
      }
      case 'staff.watch.matched': {
        const before = watches.get(event.watch);
        if (before) watches.set(event.watch, { ...before, lastMatch: event.at });
        break;
      }
      default: break;
    }
  }
  const layers: FeedLayerModel[] = FEED_LAYERS.map((layer) => {
    const counts: Record<TrackState, number> = { live: 0, stale: 0, lost: 0, closed: 0 };
    for (const track of tracks.values()) if (track.layer === layer.layer) counts[track.state] += 1;
    const known = layerKnown.get(layer.layer);
    return {
      layer: layer.layer, title: layer.title, settingsOwner: { section: layer.settingsOwner.section, member: layer.settingsOwner.member }, writable: false,
      simulated: layerSim.has(layer.layer), tracks: counts, ...(known ? { lastKnownAt: known } : {})
    };
  });
  return { sources: [...sources.values()], layers, watches: [...watches.values()], gaps };
}
