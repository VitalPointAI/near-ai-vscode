// What the observations tools ask of the rows a reader may see (research note 11, sections 3.2, 4.3, 4.4 and 5; WP-OBS and WP-TOOLS): tracks, "as known at
// T", what changed since a time, and corroboration by independent origin. Pure: no I/O, no clock (the time is passed in), no vscode.
//
// Every function here takes rows the reader's clearance already covers. The store drops the others before anything is computed, so an answer is the same
// as from a store that never held them (the two-compartment test), and a track's last known position never comes from a row the reader cannot see.
import { parseIsoMillis } from '../../gate/shape';
import { originKey } from '../intel';
import type { DecayPolicy } from './feeds';
import type { Observation } from './observation';
import { cutNote, SLICE_DEFAULT_LIMIT, sliceObservations } from './slices';
import type { SliceContext, SliceQuery } from './slices';
import { buildTrack } from './tracks';
import type { TrackState, TrackView } from './tracks';
import type { ObsParsed } from './read';

/** "As known at T": the rows learned by `knownBy`. A correction learned after T does not hide the row it corrects. */
export function knownBy(rows: readonly Observation[], at: string | undefined): readonly Observation[] {
  if (at === undefined) return rows;
  const limit = parseIsoMillis(at);
  return rows.filter((row) => parseIsoMillis(row.knownAt) <= limit);
}

/** How a track's decay and closing are looked up: the decay of the feed of its newest row, and whether a person closed it by a time. */
export interface TrackLookup {
  readonly decayOf: (feed: string) => DecayPolicy | null;
  /** When the track was closed, if it was. */
  readonly closedAt: (trackId: string) => string | undefined;
}

/**
 * One track as the reader may see it, at `now`, or as known at `knownByAt` (rows learned later left out, decay judged at that time, and closed only if it
 * was closed by then). Undefined when the reader sees no row of it.
 */
export function trackAt(rows: readonly Observation[], trackId: string, lookup: TrackLookup, now: number, knownByAt?: string): TrackView | undefined {
  const pool = knownBy(rows, knownByAt);
  const at = knownByAt !== undefined ? parseIsoMillis(knownByAt) : now;
  const own = pool.filter((row) => row.trackId === trackId);
  if (own.length === 0) return undefined;
  const newest = own.reduce((best, row) => (parseIsoMillis(row.validAt) > parseIsoMillis(best.validAt) ? row : best));
  const closed = lookup.closedAt(trackId);
  return buildTrack(trackId, own, () => true, at, lookup.decayOf(newest.feed), closed !== undefined && parseIsoMillis(closed) <= at);
}

/** Every track among the rows, at `now` (or as known at a time). */
export function tracksAt(rows: readonly Observation[], lookup: TrackLookup, now: number, knownByAt?: string): TrackView[] {
  const ids = [...new Set(knownBy(rows, knownByAt).flatMap((row) => (row.trackId ? [row.trackId] : [])))].sort();
  return ids.flatMap((id) => {
    const track = trackAt(rows, id, lookup, now, knownByAt);
    return track ? [track] : [];
  });
}

/** One kind of change a watch officer reads (note 11, section 5: new, moved, went stale, went dark). */
export interface TrackChange {
  readonly trackId: string;
  readonly change: 'new' | 'moved' | 'stale' | 'dark' | 'back' | 'closed';
  readonly from?: TrackState;
  readonly to: TrackState;
  readonly last: Observation;
}

export interface ChangesResult {
  /** Rows in the slice learned after `since`, capped like any slice. */
  readonly rows: readonly Observation[];
  readonly total: number;
  readonly cut: boolean;
  readonly note?: string;
  readonly tracks: readonly TrackChange[];
}

function samePlace(a: Observation, b: Observation): boolean {
  return JSON.stringify(a.geometry) === JSON.stringify(b.geometry);
}

/** Every row a slice matches, uncapped: the evaluator applies no cap of its own beyond the query's limit. */
export function everyMatch(rows: readonly Observation[], query: SliceQuery, context: SliceContext): ObsParsed<readonly Observation[]> {
  const result = sliceObservations(rows, { ...query, limit: Number.MAX_SAFE_INTEGER }, context);
  return result.ok ? { ok: true, value: result.value.rows } : result;
}

/**
 * What changed in a slice since `since`: the rows learned after it (capped at the slice's limit, newest last), and for every track with a row in the slice,
 * whether it is new, moved, went stale, went dark (lost), came back or was closed, comparing the track as known at `since` with the track now.
 * Corroboration and corrections are judged over every row the reader sees; only the answer is narrowed to rows learned after `since`.
 */
export function changesSince(rows: readonly Observation[], query: SliceQuery, since: string, context: SliceContext, lookup: TrackLookup, now: number): ObsParsed<ChangesResult> {
  const sinceMs = parseIsoMillis(since);
  const matched = everyMatch(rows, { ...query, order: 'known' }, context);
  if (!matched.ok) return matched;
  const fresh = matched.value.filter((row) => parseIsoMillis(row.knownAt) > sinceMs);
  const limit = query.limit ?? SLICE_DEFAULT_LIMIT;
  const cut = fresh.length > limit;
  const shown = cut ? fresh.slice(fresh.length - limit) : fresh;
  const trackIds = [...new Set(matched.value.flatMap((row) => (row.trackId ? [row.trackId] : [])))].sort();
  const changes: TrackChange[] = [];
  for (const id of trackIds) {
    const before = trackAt(rows, id, lookup, now, since);
    const after = trackAt(rows, id, lookup, now);
    if (!after) continue;
    if (!before) { changes.push({ trackId: id, change: 'new', to: after.state, last: after.last }); continue; }
    if (after.state === 'closed' && before.state !== 'closed') { changes.push({ trackId: id, change: 'closed', from: before.state, to: 'closed', last: after.last }); continue; }
    if (!samePlace(before.last, after.last)) changes.push({ trackId: id, change: 'moved', from: before.state, to: after.state, last: after.last });
    if (before.state !== after.state) {
      const change = after.state === 'stale' ? 'stale' : after.state === 'lost' ? 'dark' : after.state === 'live' ? 'back' : undefined;
      if (change) changes.push({ trackId: id, change, from: before.state, to: after.state, last: after.last });
    }
  }
  return { ok: true, value: { rows: shown, total: fresh.length, cut, ...(cut ? { note: cutNote(shown.length, fresh.length) } : {}), tracks: changes } };
}

/** For a subject (a track id or a scenario id): its rows by independent origin, the grades given, and where the rows disagree. */
export interface CorroborationView {
  readonly subject: string;
  readonly rows: readonly Observation[];
  /** One entry per independent origin (origins compared as drop 1 compares them), with the rows from it. */
  readonly origins: ReadonlyArray<{ readonly origin: string; readonly rows: readonly string[] }>;
  readonly independent: number;
  /** True when two or more independent origins report on it: the drop 1 rule for credibility 1. */
  readonly corroborated: boolean;
  /** True when some rows repeat an origin another row already gave: one piece of evidence, not two. */
  readonly repeated: boolean;
  readonly contradictions: readonly string[];
}

/** The corroboration of a subject among the rows the reader sees, corrections applied. */
export function corroborationOf(rows: readonly Observation[], subject: string): CorroborationView {
  const superseded = new Set(rows.flatMap((row) => (row.supersedes ? [row.supersedes] : [])));
  const about = rows.filter((row) => !superseded.has(row.obsId) && (row.trackId === subject || (row.about ?? []).includes(subject)))
    .sort((a, b) => parseIsoMillis(a.validAt) - parseIsoMillis(b.validAt) || a.obsId.localeCompare(b.obsId));
  const origins: Array<{ origin: string; key: string; rows: string[] }> = [];
  for (const row of about) {
    const key = originKey(row.origin);
    const found = origins.find((entry) => entry.key === key);
    if (found) found.rows.push(row.obsId); else origins.push({ origin: row.origin, key, rows: [row.obsId] });
  }
  const contradictions: string[] = [];
  const identities = [...new Set(about.flatMap((row) => (row.claimedIdentity ? [row.claimedIdentity] : [])))];
  if (identities.length > 1) contradictions.push(`The rows claim different identities: ${identities.join(', ')}. A feed's identity is a claim; the J2 assesses it.`);
  const types = [...new Set(about.flatMap((row) => (row.observedType ? [row.observedType] : [])))];
  if (types.length > 1) contradictions.push(`The rows report different types: ${types.join(', ')}.`);
  const deception = about.filter((row) => !/^none seen\.?$/i.test(row.deceptionNote.trim()));
  if (deception.length) contradictions.push(`${deception.length} row${deception.length === 1 ? '' : 's'} carr${deception.length === 1 ? 'ies' : 'y'} a deception note.`);
  return {
    subject, rows: about, origins: origins.map((entry) => ({ origin: entry.origin, rows: entry.rows })), independent: origins.length,
    corroborated: origins.length >= 2, repeated: about.length > origins.length, contradictions
  };
}
