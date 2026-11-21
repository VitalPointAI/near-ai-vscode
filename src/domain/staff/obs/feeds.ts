// Feed and channel descriptors (research note 11, sections 2, 4.2, 4.3 and 4.6; WP-OBS0): what a feed is, how it enters, under what licence, at what
// label, how it decays and what it does under load. Pure: no I/O, no clock, no vscode.
//
// A feed is the v0.6.0 "source" and follows its lifecycle (data platform design 4.1), with one extra path for streams with no history: `approved` to
// `live` directly. A channel is one stream inside a feed (one AIS receiver, one RSS outlet, one patrol net); reliability grades the channel, once, by a
// person. Licences decide more than formats do: restricted sources (ACLED, social media, a research-only flight network, a developer-only news plan) stay
// off until your organization records a licence that covers this use, and their data is never used for training (owner decision Q8, 2026-11-18).
import { PARTNER_ONLY_DISCIPLINES, INTELLIGENCE_DISCIPLINES, SOURCE_RELIABILITY_GRADES, INFORMATION_CREDIBILITY_GRADES } from '../doctrine';
import type { InformationCredibility, IntelligenceDiscipline, SourceReliability } from '../doctrine';
import { isNamedPerson } from '../release';
import type { PersonActor } from '../release';
import { bool, childPath, choice, fail, field, fields, int, list, optionalField, reading, slug, templateLabel, text } from './read';
import type { ObsFailure, ObsParsed } from './read';
import { belowOnScale } from '../../gate/dominance';
import { activeScales } from '../../gate/labelAlgebra';

// ---- Classes, categories, formats and transports ------------------------------------------------------------------------------------------------

/** Feed classes by how they behave under load (note 11, 4.6). */
export const FEED_CLASSES = ['positions', 'events', 'reports', 'gridded', 'static'] as const;
export type FeedClass = (typeof FEED_CLASSES)[number];

/** What a feed carries: intelligence reporting (J2), own and coalition positions (J3), or the environment (weather and terrain). */
export const FEED_CATEGORIES = ['intelligence', 'own-force', 'environment'] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

/** The formats drop 2 and the v0.6.0 connectors read (note 11, 2.1). Formats are public; what decides use is the source's licence class. */
export const FEED_FORMATS = [
  'cot', 'tak-protocol', 'ais-nmea', 'adsb-json', 'geojson', 'kml', 'geopackage', 'rss', 'atom', 'gdelt-events', 'grib2', 'netcdf', 'dem', 'ogc-features',
  'sensorthings', 'partner-mcp'
] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];

/**
 * How a feed reaches the extension. `file-import` and `loopback` never leave the machine. `outside` is a live connection to a server that is not your
 * organization's own, which reveals the area being watched (design 10, 6.1 and 6.2), so it is never on by default. `partner` is a remote MCP server under a
 * person-written manifest with its own label ceiling (WP-GATE), routed local-only.
 */
export const FEED_TRANSPORTS = ['file-import', 'loopback', 'outside', 'partner'] as const;
export type FeedTransport = (typeof FEED_TRANSPORTS)[number];

/** Licence classes (note 11, 2.3). */
export const LICENCE_CLASSES = ['open', 'organization-own', 'restricted-terms', 'partner-only', 'simulated'] as const;
export type LicenceClass = (typeof LICENCE_CLASSES)[number];

/** Training rights, as the v0.6.0 item card records them (`training.rights`): `unknown` means not allowed. */
export const TRAINING_RIGHTS = ['yes', 'no', 'unknown'] as const;
export type TrainingRights = (typeof TRAINING_RIGHTS)[number];

export interface LicenceClassRule {
  /** The label a feed of this class gets when its descriptor names none. */
  readonly defaultLabel: string;
  /** The lowest label a descriptor may give it. */
  readonly floorLabel: string;
  /** Whether training on its data is ever possible. */
  readonly trainingAllowed: boolean;
  readonly note: string;
}

export const LICENCE_CLASS_RULES: Readonly<Record<LicenceClass, LicenceClassRule>> = {
  open: { defaultLabel: 'org/Public', floorLabel: 'org/Public', trainingAllowed: true, note: 'Public data under an open licence: ingest with the attribution the licence asks for.' },
  'organization-own': { defaultLabel: 'org/Internal', floorLabel: 'org/Public', trainingAllowed: true, note: 'Your organization\'s own reports and positions, at your organization\'s labels.' },
  'restricted-terms': {
    defaultLabel: 'org/Internal', floorLabel: 'org/Internal', trainingAllowed: false,
    note: 'Public data whose terms restrict this use: off until your organization records a licence that covers it; never used for training.'
  },
  'partner-only': {
    defaultLabel: 'org/Internal', floorLabel: 'org/Internal', trainingAllowed: false,
    note: 'Partner reporting: only through a partner integration, routed local-only, and in staff projects only as a fictional simulation.'
  },
  simulated: { defaultLabel: 'org/Internal', floorLabel: 'org/Public', trainingAllowed: false, note: 'A simulated feed: exercise data, always shown with the SIM badge.' }
};

// ---- Feed class policies: decay and backpressure (note 11, 4.3 and 4.6) -------------------------------------------------------------------------

/** When a track built from this feed goes stale and then lost. Design values to be measured in the demo, not claims about the feeds. */
export interface DecayPolicy { readonly staleAfterSeconds: number; readonly lostAfterSeconds: number }

export interface FeedClassPolicy {
  /** What the runtime does when the feed outruns it. */
  readonly underLoad: 'coalesce-latest-per-track' | 'spill-then-degrade' | 'queue' | 'replace-older-run' | 'bulk-job';
  /** What it never does. */
  readonly never: string;
  /** The decay a track from this class gets unless the descriptor sets its own; static data does not decay. */
  readonly decay: DecayPolicy | null;
}

export const FEED_CLASS_POLICIES: Readonly<Record<FeedClass, FeedClassPolicy>> = {
  positions: { underLoad: 'coalesce-latest-per-track', never: 'Drop a track\'s first or last position.', decay: { staleAfterSeconds: 120, lostAfterSeconds: 900 } },
  events: { underLoad: 'spill-then-degrade', never: 'Drop a message silently.', decay: { staleAfterSeconds: 900, lostAfterSeconds: 3600 } },
  reports: { underLoad: 'queue', never: 'Drop a report.', decay: { staleAfterSeconds: 6 * 3600, lostAfterSeconds: 24 * 3600 } },
  gridded: { underLoad: 'replace-older-run', never: 'Mix model runs in one layer.', decay: { staleAfterSeconds: 6 * 3600, lostAfterSeconds: 24 * 3600 } },
  static: { underLoad: 'bulk-job', never: 'Block a live feed.', decay: null }
};

// ---- The catalogue of named public sources (note 11, 2.1 and 2.2) ----------------------------------------------------------------------------

export interface CatalogueSource {
  readonly id: string;
  readonly title: string;
  readonly licenceClass: 'open' | 'restricted-terms';
  /** What the licence asks to be shown, or why the source stays off. */
  readonly terms: string;
  /** The note 11 source tag, so a reviewer can find the licence read. */
  readonly evidence: string;
}

/** Named public sources whose licence decides whether they may be used. A descriptor naming one of these takes its licence class from here. */
export const FEED_CATALOGUE: readonly CatalogueSource[] = [
  { id: 'acled', title: 'ACLED conflict events', licenceClass: 'restricted-terms', terms: 'Government bodies need a public-sector licence; use as embeddings or knowledge-base input needs written consent; no redistribution.', evidence: 'note 11 [F40]' },
  { id: 'social-media', title: 'Social media platform content', licenceClass: 'restricted-terms', terms: 'Platform terms bar surveillance and monitoring uses, and government surveillance uses.', evidence: 'note 11 [F42][F43]' },
  { id: 'flight-research-network', title: 'Research flight tracking network', licenceClass: 'restricted-terms', terms: 'Research, education and government purposes only; no redistribution.', evidence: 'note 11 [F15][F16]' },
  { id: 'news-developer-plan', title: 'News API developer plan', licenceClass: 'restricted-terms', terms: 'Free developer plans are for development only.', evidence: 'note 11 [F41]' },
  { id: 'gdelt', title: 'GDELT events and knowledge graph', licenceClass: 'open', terms: 'Unlimited use including governmental, with a citation and a link.', evidence: 'note 11 [F39]' },
  { id: 'ecmwf-open-data', title: 'ECMWF open forecast data', licenceClass: 'open', terms: 'CC-BY-4.0: show the attribution wording ECMWF asks for.', evidence: 'note 11 [F28]' },
  { id: 'copernicus-dem', title: 'Copernicus DEM GLO-30', licenceClass: 'open', terms: 'Free licence: show the DLR notice.', evidence: 'note 11 [F34]' },
  { id: 'natural-earth', title: 'Natural Earth', licenceClass: 'open', terms: 'Public domain.', evidence: 'note 11 [F37]' },
  { id: 'openstreetmap', title: 'OpenStreetMap extracts', licenceClass: 'open', terms: 'ODbL: show the attribution; share-alike applies to a derived database used publicly; public tile servers forbid offline use.', evidence: 'note 11 [F35]' }
];

export function catalogueSource(id: string): CatalogueSource | undefined {
  return FEED_CATALOGUE.find((entry) => entry.id === id);
}

// ---- Descriptors ------------------------------------------------------------------------------------------------------------------------------

export interface ChannelDescriptor {
  readonly id: string;
  readonly title: string;
  /** The intelligence discipline, or null for own-force and environment channels. */
  readonly discipline: IntelligenceDiscipline | null;
  /** The channel's reliability, set by a person in the source register; F ("cannot be judged") until then. */
  readonly reliability: SourceReliability;
  /** The credibility a new observation starts at, before corroboration from an independent origin raises it: 6 ("cannot be judged") by default. */
  readonly credibility: InformationCredibility;
  /** The emitter for machine feeds (two receivers hearing one transponder are one origin). Absent: each message names its own origin. */
  readonly origin?: string;
  /** A label above the feed's, inside the template ceiling. Never lower than the feed's. */
  readonly label?: string;
}

export interface FeedDescriptor {
  readonly id: string;
  readonly title: string;
  readonly category: FeedCategory;
  readonly feedClass: FeedClass;
  readonly format: FeedFormat;
  readonly transport: FeedTransport;
  readonly licenceClass: LicenceClass;
  /** A named public source from FEED_CATALOGUE, whose licence class the descriptor must match. */
  readonly catalogue?: string;
  /** Your organization's record of a licence that covers this use; required before a restricted source can be turned on. */
  readonly licenceRecord?: string;
  readonly attribution?: string;
  readonly trainingRights: TrainingRights;
  /** The label every row gets unless its channel sets a higher one. Absent: the licence class default. */
  readonly label?: string;
  /** Always true for a `simulated` licence class, and every row from it is marked simulated. */
  readonly simulated: boolean;
  /** Track decay; absent: the feed class default. */
  readonly decay?: DecayPolicy;
  /** The most messages a minute the runtime takes from it; above that the class's load policy applies. */
  readonly maxMessagesPerMinute?: number;
  readonly channels: readonly ChannelDescriptor[];
}

export const FEED_MAX_CHANNELS = 50;
const MAX_DECAY_SECONDS = 30 * 24 * 3600;

function readChannel(value: unknown, path: string): ChannelDescriptor {
  const raw = fields(value, path, ['id', 'title', 'discipline'], ['reliability', 'credibility', 'origin', 'label']);
  const discipline = field(raw, 'discipline') === null ? null : choice(INTELLIGENCE_DISCIPLINES, field(raw, 'discipline'), childPath(path, 'discipline'));
  const reliability = optionalField(raw, 'reliability', path, (v, at) => choice(SOURCE_RELIABILITY_GRADES, v, at)) ?? 'F';
  const credibility = optionalField(raw, 'credibility', path, (v, at) => {
    if (typeof v !== 'number' || !INFORMATION_CREDIBILITY_GRADES.includes(v as InformationCredibility)) fail(typeof v === 'string' && /^[A-Fa-f]\s*[1-6]$/.test(v) ? 'grades-separate' : 'unknown-value', at);
    return v as InformationCredibility;
  }) ?? 6;
  const origin = optionalField(raw, 'origin', path, (v, at) => text(v, at, 300));
  const label = optionalField(raw, 'label', path, templateLabel);
  return {
    id: slug(field(raw, 'id'), childPath(path, 'id')), title: text(field(raw, 'title'), childPath(path, 'title'), 120), discipline, reliability, credibility,
    ...(origin !== undefined ? { origin } : {}), ...(label !== undefined ? { label } : {})
  };
}

/**
 * Reads a feed descriptor and holds it to the licence and label rules: a catalogue source keeps its licence class; restricted and partner-only data is
 * never used for training; a descriptor label is inside the template ceiling and not below its class's floor; a channel label is not below the feed's;
 * partner-only disciplines (HUMINT, SIGINT, MASINT, CI) enter only from a simulated feed (note 11, 2.3).
 */
export function parseFeedDescriptor(value: unknown, path = ''): ObsParsed<FeedDescriptor> {
  return reading(() => {
    const raw = fields(value, path, ['id', 'title', 'category', 'feedClass', 'format', 'transport', 'licenceClass', 'trainingRights', 'simulated', 'channels'], [
      'catalogue', 'licenceRecord', 'attribution', 'label', 'decay', 'maxMessagesPerMinute'
    ]);
    const at = (key: string): string => childPath(path, key);
    const licenceClass = choice(LICENCE_CLASSES, field(raw, 'licenceClass'), at('licenceClass'));
    const catalogue = optionalField(raw, 'catalogue', path, (v, where) => {
      const entry = catalogueSource(slug(v, where));
      if (!entry) fail('unknown-value', where);
      if (entry.licenceClass !== licenceClass) fail('licence-restricted', at('licenceClass'));
      return entry.id;
    });
    const trainingRights = choice(TRAINING_RIGHTS, field(raw, 'trainingRights'), at('trainingRights'));
    if (!LICENCE_CLASS_RULES[licenceClass].trainingAllowed && trainingRights !== 'no') fail('licence-restricted', at('trainingRights'));
    const simulated = bool(field(raw, 'simulated'), at('simulated'));
    if ((licenceClass === 'simulated') !== simulated) fail('unknown-value', at('simulated'));
    const transport = choice(FEED_TRANSPORTS, field(raw, 'transport'), at('transport'));
    if (licenceClass === 'partner-only' && transport !== 'partner') fail('local-only', at('transport'));
    const label = optionalField(raw, 'label', path, templateLabel);
    // Ranked by the label module on the active policy's scales (D-35); the licence floors are all organization labels.
    if (label !== undefined && belowOnScale(label, LICENCE_CLASS_RULES[licenceClass].floorLabel, activeScales())) fail('label-too-low', at('label'));
    const feedLabel = label ?? LICENCE_CLASS_RULES[licenceClass].defaultLabel;
    const channels = list(field(raw, 'channels'), at('channels'), FEED_MAX_CHANNELS, readChannel);
    if (channels.length === 0) fail('missing-field', at('channels'));
    channels.forEach((channel, index) => {
      if (channels.findIndex((other) => other.id === channel.id) !== index) fail('duplicate-entry', `${at('channels')}[${index}].id`);
      if (channel.label !== undefined && belowOnScale(channel.label, feedLabel, activeScales())) fail('label-too-low', `${at('channels')}[${index}].label`);
      if (channel.discipline !== null && PARTNER_ONLY_DISCIPLINES.includes(channel.discipline) && !simulated) fail('partner-simulation-only', `${at('channels')}[${index}].discipline`);
    });
    const decay = optionalField(raw, 'decay', path, (v, where) => {
      const d = fields(v, where, ['staleAfterSeconds', 'lostAfterSeconds']);
      const stale = int(field(d, 'staleAfterSeconds'), childPath(where, 'staleAfterSeconds'), 1, MAX_DECAY_SECONDS);
      const lost = int(field(d, 'lostAfterSeconds'), childPath(where, 'lostAfterSeconds'), 1, MAX_DECAY_SECONDS);
      if (lost <= stale) fail('time-order', childPath(where, 'lostAfterSeconds'));
      return { staleAfterSeconds: stale, lostAfterSeconds: lost };
    });
    const licenceRecord = optionalField(raw, 'licenceRecord', path, (v, where) => text(v, where, 300));
    const attribution = optionalField(raw, 'attribution', path, (v, where) => text(v, where, 300));
    const maxMessagesPerMinute = optionalField(raw, 'maxMessagesPerMinute', path, (v, where) => int(v, where, 1, 1_000_000));
    return {
      id: slug(field(raw, 'id'), at('id')), title: text(field(raw, 'title'), at('title'), 120),
      category: choice(FEED_CATEGORIES, field(raw, 'category'), at('category')),
      feedClass: choice(FEED_CLASSES, field(raw, 'feedClass'), at('feedClass')),
      format: choice(FEED_FORMATS, field(raw, 'format'), at('format')),
      transport, licenceClass,
      ...(catalogue !== undefined ? { catalogue } : {}), ...(licenceRecord !== undefined ? { licenceRecord } : {}),
      ...(attribution !== undefined ? { attribution } : {}),
      trainingRights, ...(label !== undefined ? { label } : {}), simulated,
      ...(decay !== undefined ? { decay } : {}), ...(maxMessagesPerMinute !== undefined ? { maxMessagesPerMinute } : {}),
      channels
    };
  });
}

/** The label a row from this channel is stamped with: the channel's, else the feed's, else the licence class default. */
export function channelLabel(feed: FeedDescriptor, channel: ChannelDescriptor): string {
  return channel.label ?? feed.label ?? LICENCE_CLASS_RULES[feed.licenceClass].defaultLabel;
}

/** The handling flags a row from this feed carries: partner-only reporting and partner-only disciplines are always `local-only`. */
export function channelHandling(feed: FeedDescriptor, channel: ChannelDescriptor): Array<'local-only'> {
  const partner = feed.licenceClass === 'partner-only' || (channel.discipline !== null && PARTNER_ONLY_DISCIPLINES.includes(channel.discipline));
  return partner ? ['local-only'] : [];
}

/** The decay a track from this feed uses: the descriptor's, else the feed class default (null: static data does not decay). */
export function feedDecay(feed: FeedDescriptor): DecayPolicy | null {
  return feed.decay ?? FEED_CLASS_POLICIES[feed.feedClass].decay;
}

// ---- On by default, and turning a feed on ------------------------------------------------------------------------------------------------

/**
 * Whether a feed is on when a staff project adds it. Off by default: restricted terms (ACLED, social media and the rest, owner decision Q8), partner-only
 * feeds, and any live connection to an outside server (it reveals the area of interest). On: simulated feeds, and open or your organization's own data
 * that arrives by file import or on loopback.
 */
export function enabledByDefault(feed: FeedDescriptor): boolean {
  if (feed.licenceClass === 'restricted-terms' || feed.licenceClass === 'partner-only') return false;
  if (feed.transport === 'outside' || feed.transport === 'partner') return false;
  return true;
}

/**
 * Whether a person may turn a feed on, or why not. Only a named person turns a feed on. A restricted source needs your organization's licence record on
 * its descriptor first. A partner-only feed in a staff project must be a simulation; a real partner feed belongs on accredited systems.
 */
export function mayEnable(feed: FeedDescriptor, actor: PersonActor | { readonly kind: 'agent'; readonly member: string }): { readonly ok: true } | { readonly ok: false; readonly reason: ObsFailure } {
  if (!isNamedPerson(actor)) return { ok: false, reason: 'not-a-person' };
  if (feed.licenceClass === 'restricted-terms' && feed.licenceRecord === undefined) return { ok: false, reason: 'licence-restricted' };
  if (feed.licenceClass === 'partner-only' && !feed.simulated) return { ok: false, reason: 'partner-simulation-only' };
  return { ok: true };
}

// ---- Source lifecycle (data platform design 4.1, plus the live-only path of note 11, 4.2) ----------------------------------------------------

export const FEED_SOURCE_STATES = ['proposed', 'approved', 'backfilling', 'live', 'degraded', 'paused', 'retired'] as const;
export type FeedSourceState = (typeof FEED_SOURCE_STATES)[number];

export const FEED_SOURCE_EVENTS = ['approve', 'reject', 'start-backfill', 'start-live', 'caught-up', 'degrade', 'recover', 'resync', 'pause', 'resume', 'retire'] as const;
export type FeedSourceEvent = (typeof FEED_SOURCE_EVENTS)[number];

/** Why a source is degraded: a gap in the stream, a queue that overflowed its spill cap, or too many messages that did not parse. */
export const DEGRADED_REASONS = ['gap', 'overflow', 'parse-errors', 'auth', 'throttled'] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** Every allowed transition; `person` marks the ones only a named person may make. Anything not listed is refused. */
export const FEED_SOURCE_TRANSITIONS: ReadonlyArray<{ readonly from: FeedSourceState; readonly event: FeedSourceEvent; readonly to: FeedSourceState; readonly person: boolean }> = [
  { from: 'proposed', event: 'approve', to: 'approved', person: true },
  { from: 'proposed', event: 'reject', to: 'retired', person: true },
  { from: 'approved', event: 'start-backfill', to: 'backfilling', person: false },
  { from: 'approved', event: 'start-live', to: 'live', person: false },
  { from: 'backfilling', event: 'caught-up', to: 'live', person: false },
  { from: 'backfilling', event: 'degrade', to: 'degraded', person: false },
  { from: 'backfilling', event: 'pause', to: 'paused', person: false },
  { from: 'live', event: 'degrade', to: 'degraded', person: false },
  { from: 'live', event: 'pause', to: 'paused', person: false },
  { from: 'live', event: 'retire', to: 'retired', person: true },
  { from: 'degraded', event: 'recover', to: 'live', person: false },
  { from: 'degraded', event: 'resync', to: 'backfilling', person: false },
  { from: 'degraded', event: 'pause', to: 'paused', person: false },
  { from: 'degraded', event: 'retire', to: 'retired', person: true },
  { from: 'paused', event: 'resume', to: 'live', person: false },
  { from: 'paused', event: 'resync', to: 'backfilling', person: false },
  { from: 'paused', event: 'retire', to: 'retired', person: true }
];

/**
 * The next state of a feed source, or a refusal. A feed with no history (`hasHistory` false) goes straight from `approved` to `live`; one with history
 * backfills first. A paused or degraded source with history to catch up on resyncs through `backfilling`.
 */
export function feedSourceTransition(from: FeedSourceState, event: FeedSourceEvent, actor: PersonActor | { readonly kind: 'agent' | 'system'; readonly member?: string }, hasHistory: boolean):
  { readonly ok: true; readonly to: FeedSourceState } | { readonly ok: false; readonly reason: ObsFailure } {
  const rule = FEED_SOURCE_TRANSITIONS.find((entry) => entry.from === from && entry.event === event);
  if (!rule) return { ok: false, reason: 'bad-transition' };
  if (rule.person && actor.kind !== 'person') return { ok: false, reason: 'not-a-person' };
  if (from === 'approved' && event === 'start-live' && hasHistory) return { ok: false, reason: 'bad-transition' };
  if (from === 'approved' && event === 'start-backfill' && !hasHistory) return { ok: false, reason: 'bad-transition' };
  return { ok: true, to: rule.to };
}
