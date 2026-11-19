// COP feed layers and who owns their settings (research note 11, 6.1; design 10, 4.3; WP-OBS0). Pure: no I/O, no clock, no vscode.
//
// The five product layers (operations, threat, terrain, logistics, plans) stay as design 10 has them, in ownership.ts. Feed layers are new and are views,
// not products: nobody writes their features by hand, so nothing may write a feature into one. The single-writer rule applies to their settings (which
// channels, which grades, which decay), and everyone else proposes a settings change to the owner. The threat layer stays the threat-analyst's assessment,
// drawn from the observation layer but distinct from it.
import type { StaffSectionId } from '../doctrine';
import { resolveWriter } from '../ownership';
import type { StaffWriter } from '../ownership';
import type { FeedCategory, FeedFormat } from './feeds';

export interface FeedLayer {
  readonly layer: string;
  readonly title: string;
  /** Who sets which channels, grades and decay the layer shows. `folds` names who holds the job in a roster without that member. */
  readonly settingsOwner: StaffWriter;
  /** Who may propose a settings change. */
  readonly contributors: readonly StaffWriter[];
  /** The feed categories and formats the layer draws from. */
  readonly categories: readonly FeedCategory[];
  readonly formats: readonly FeedFormat[];
  readonly content: string;
}

const W = (section: StaffSectionId, member: string, folds?: readonly string[]): StaffWriter => ({ section, member, ...(folds ? { folds } : {}) });

/** The feed layers of note 11, 6.1. Layer ids start `cop-feed-` so they can never be mistaken for a product layer (`cop-*-layer`). */
export const FEED_LAYERS: readonly FeedLayer[] = [
  {
    layer: 'cop-feed-friendly', title: 'Friendly positions', settingsOwner: W('j3', 'joc-chief'), contributors: [W('j3', 'airspace-maritime-liaison')],
    categories: ['own-force'], formats: ['cot', 'tak-protocol', 'partner-mcp'], content: 'Own and coalition tracks.'
  },
  {
    layer: 'cop-feed-maritime', title: 'Maritime picture', settingsOwner: W('j3', 'airspace-maritime-liaison', ['joc-chief']), contributors: [W('j2', 'watch-officer'), W('j2', 'geoint-analyst')],
    categories: ['own-force', 'intelligence'], formats: ['ais-nmea', 'cot'], content: 'AIS and radar tracks, and dark contacts.'
  },
  {
    layer: 'cop-feed-air', title: 'Air picture', settingsOwner: W('j3', 'airspace-maritime-liaison', ['joc-chief']), contributors: [W('j2', 'watch-officer')],
    categories: ['own-force', 'intelligence'], formats: ['adsb-json', 'cot'], content: 'Air tracks.'
  },
  {
    layer: 'cop-feed-intelligence', title: 'Intelligence observations', settingsOwner: W('j2', 'watch-officer', ['warning-analyst', 's2-lead']),
    contributors: [W('j2', 'collection-manager'), W('j2', 'threat-analyst')],
    categories: ['intelligence'], formats: ['cot', 'geojson', 'kml', 'geopackage', 'rss', 'atom', 'gdelt-events', 'partner-mcp'], content: 'Graded observations from every discipline.'
  },
  {
    layer: 'cop-feed-osint', title: 'OSINT events', settingsOwner: W('j2', 'osint-analyst', ['collection-manager', 'watch-officer']), contributors: [W('j2', 'watch-officer')],
    categories: ['intelligence'], formats: ['rss', 'atom', 'gdelt-events'], content: 'Geocoded public-source items.'
  },
  {
    layer: 'cop-feed-imagery', title: 'Imagery footprints', settingsOwner: W('j2', 'collection-manager', ['s2-lead']), contributors: [W('j2', 'geoint-analyst')],
    categories: ['intelligence'], formats: ['geojson', 'kml', 'cot', 'partner-mcp'], content: 'What was covered and when, never the pixels.'
  },
  {
    layer: 'cop-feed-weather', title: 'Weather', settingsOwner: W('j2', 'geoint-analyst', ['jipoe-analyst', 'ipb-analyst']), contributors: [W('j4', 'jloc-chief')],
    categories: ['environment'], formats: ['grib2', 'netcdf', 'geojson'], content: 'Wind, sea state, precipitation, visibility and alerts, with the model run time.'
  },
  {
    layer: 'cop-feed-terrain', title: 'Terrain', settingsOwner: W('j2', 'geoint-analyst', ['jipoe-analyst', 'ipb-analyst']), contributors: [W('j2', 'jipoe-analyst')],
    categories: ['environment'], formats: ['dem', 'geopackage', 'geojson'], content: 'Hillshade, contours and terrain overlays.'
  }
];

export function feedLayer(layer: string): FeedLayer | undefined {
  return FEED_LAYERS.find((entry) => entry.layer === layer);
}

/** Feed layers are views: no member, person or tool writes a feature into one. Their features come only from observations. */
export function mayWriteFeedLayerFeatures(layer: string): boolean {
  void layer;
  return false;
}

/** The settings owner of a feed layer, resolved for a section team's roster (the member that holds a folded job), or undefined for no such layer. */
export function feedLayerSettingsOwner(layer: string, team?: { readonly section: StaffSectionId; readonly members: readonly string[] }): StaffWriter | undefined {
  const entry = feedLayer(layer);
  if (!entry) return undefined;
  return team ? resolveWriter(entry.settingsOwner, team.section, team.members) : { section: entry.settingsOwner.section, member: entry.settingsOwner.member };
}

/** Whether `writer` may change a feed layer's settings directly; anyone else proposes the change to the owner. */
export function mayChangeFeedLayerSettings(layer: string, writer: StaffWriter, roster?: readonly string[]): boolean {
  const entry = feedLayer(layer);
  if (!entry) return false;
  const owner = resolveWriter(entry.settingsOwner, writer.section, roster);
  return owner.section === writer.section && owner.member === writer.member;
}

/** The feed layers a category and format feed into: where a new observation shows. */
export function layersFor(category: FeedCategory, format: FeedFormat): string[] {
  return FEED_LAYERS.filter((entry) => entry.categories.includes(category) && entry.formats.includes(format)).map((entry) => entry.layer);
}
