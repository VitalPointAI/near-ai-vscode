// The agent tools over observations (research note 11, section 5; WP-OBS0): names, inputs and caps of the local `observations` server. WP-TOOLS builds
// the server against these, first over an in-memory fake of the store; the v0.6.0 host serves the same names and inputs, so swapping the backend changes
// nothing an agent sees. Pure: no I/O, no clock, no vscode.
//
// Every tool runs on the machine (`runsOn: local`) with no hosts; every output is capped and its free text fenced as untrusted; every answer is clamped
// to the asking member's clearance. Arming a watch and merging a layer change are a person's and an owner's steps, so the tools only propose them.
import type { SliceQuery } from './slices';

export const OBSERVATIONS_SERVER = 'observations';

export const OBS_TOOL_NAMES = [
  'obs.slice', 'obs.track', 'obs.near', 'obs.changes', 'obs.corroboration', 'obs.timeline', 'obs.feeds', 'watch.propose', 'watch.list', 'cop.layer.propose'
] as const;
export type ObsToolName = (typeof OBS_TOOL_NAMES)[number];

/** The most features any one answer carries; the answer says so when it was cut (slices.ts cutNote). */
export const OBS_TOOL_MAX_FEATURES = 200;
/** The most characters of free text (excerpts) in one answer, before the fence. */
export const OBS_TOOL_MAX_TEXT = 20_000;

export interface ObsSliceInput { readonly slice: SliceQuery }
/** One track. `knownBy` gives the track as the staff knew it at that time ("as known at T"): rows learned later are left out, and decay is judged then. */
export interface ObsTrackInput { readonly trackId: string; readonly since?: string; readonly knownBy?: string }
/** What is near a place or along a route in a window: a grid reference or a control measure id, and a distance. */
export interface ObsNearInput { readonly place: string; readonly withinMetres: number; readonly validFrom?: string; readonly validTo?: string; readonly knownBy?: string }
/** What changed in a slice since T: new, moved, gone stale, gone dark. The main input for watch officers. */
export interface ObsChangesInput { readonly slice: SliceQuery; readonly since: string }
/** For a subject (a track or a scenario id): independent origins, grades and contradictions, by the drop 1 corroboration rules. */
export interface ObsCorroborationInput { readonly subject: string }
export interface ObsTimelineInput { readonly slice: SliceQuery; readonly by: 'valid' | 'known' }
/** Each feed's source state, why it is degraded or paused, its rows, gaps and last known time, and any part of the store that cannot be read. */
export interface ObsFeedsInput { readonly feed?: string }
/** A drafted watch: it starts `proposed` and only a person arms it (watches.ts). */
export interface WatchProposeInput {
  readonly title: string; readonly pir: string; readonly indicator: string; readonly condition: SliceQuery; readonly ltiov: string;
  readonly alert: { readonly name: string; readonly role: string }
}
export interface WatchListInput { readonly states?: readonly string[] }
/** A proposed change to a layer the member does not own; the owner merges it (design 10, 4.3). */
export interface CopLayerProposeInput { readonly layer: string; readonly summary: string; readonly change: string }

export interface ObsToolSpec {
  readonly name: ObsToolName;
  readonly summary: string;
  /** Whether it changes anything. Only proposals do, and a proposal is a draft until a person or owner acts. */
  readonly proposes: boolean;
}

/** The tool list a person reads in the server's capability manifest. */
export const OBS_TOOLS: readonly ObsToolSpec[] = [
  { name: 'obs.slice', summary: 'Observations that match a slice, capped, newest last.', proposes: false },
  { name: 'obs.track', summary: 'One track with its grades and gaps, as you may see it.', proposes: false },
  { name: 'obs.near', summary: 'What is near a place or along a route in a time window.', proposes: false },
  { name: 'obs.changes', summary: 'What changed in a slice since a time: new, moved, stale, dark.', proposes: false },
  { name: 'obs.corroboration', summary: 'Independent origins, grades and contradictions for a subject.', proposes: false },
  { name: 'obs.timeline', summary: 'Events in a slice in valid-time or known-time order.', proposes: false },
  { name: 'obs.feeds', summary: 'Each feed\'s state, gaps and last report, and what cannot be read.', proposes: false },
  { name: 'watch.propose', summary: 'Draft a standing watch; a named person arms it.', proposes: true },
  { name: 'watch.list', summary: 'Armed watches and their recent matches.', proposes: false },
  { name: 'cop.layer.propose', summary: 'Propose a change to a layer you do not own; its owner merges it.', proposes: true }
];

/** The manifest facts every observations tool shares: runs on the machine, reaches no host. */
export const OBS_TOOL_MANIFEST = { runsOn: 'local', hosts: [] as readonly string[] } as const;
