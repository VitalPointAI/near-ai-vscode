// The simulated feeds as feed sources (research note 11, 4.2 and 8.2; WP-SIM): one descriptor per loopback stream, in the WP-OBS0 contract, so the
// store and the importers stamp every row from them as simulated and the feed picture badges every one SIM. Pure: no I/O, no clock, no vscode.
import type { FeedDescriptor } from '../obs/feeds';
import { layersFor } from '../obs/layers';
import { SIM_STATEMENT } from './formats';
import type { SimStream } from './script';

/** The feed id each stream is published as. */
export const SIM_FEED_IDS: Readonly<Record<SimStream, string>> = {
  'cot-own': 'sim-cot-own', 'cot-intel': 'sim-cot-intel', ais: 'sim-ais', rss: 'sim-rss', partner: 'sim-partner'
};

/** F and 6, "cannot be judged": the defaults until a person grades the channel. */
const UNGRADED = { reliability: 'F', credibility: 6 } as const;

const simulated = { licenceClass: 'simulated', trainingRights: 'no', simulated: true, attribution: SIM_STATEMENT } as const;

/**
 * The five simulated feeds. Channels carry no reliability grade of their own beyond own-force GPS: a person grades a channel in the source register
 * (drop 1 intel.ts), and each report keeps the scenario's grades. Partner-only disciplines arrive only on the partner simulation, whose transport is the
 * partner integration path (a mock MCP server on loopback), so a person turns it on and every row from it is routed local-only.
 */
export const SIM_FEEDS: readonly FeedDescriptor[] = [
  {
    id: SIM_FEED_IDS['cot-own'], title: 'Simulated friendly tracks (CoT)', category: 'own-force', feedClass: 'positions', format: 'cot', transport: 'loopback', ...simulated,
    channels: [
      { id: 'tf-anvil', title: 'TF ANVIL land units', discipline: null, reliability: 'A', credibility: 2, origin: 'Own GPS position reports' },
      { id: 'tg-shoal', title: 'TG SHOAL ships', discipline: null, reliability: 'A', credibility: 2, origin: 'Own GPS position reports' },
      { id: 'air-det-lark', title: 'AIR DET LARK aircraft', discipline: null, reliability: 'A', credibility: 2, origin: 'Own GPS position reports' }
    ]
  },
  {
    id: SIM_FEED_IDS['cot-intel'], title: 'Simulated spot reports and contacts (CoT)', category: 'intelligence', feedClass: 'events', format: 'cot', transport: 'loopback', ...simulated,
    channels: [
      { id: 'recce-patrols', title: 'RECCE squadron patrols', discipline: null, ...UNGRADED },
      { id: 'infantry-patrols', title: '2 INF reconnaissance platoon', discipline: null, ...UNGRADED },
      { id: 'uas-imagery', title: 'AIR DET LARK uncrewed aircraft imagery', discipline: 'GEOINT', ...UNGRADED },
      { id: 'helicopter-radar', title: 'TG SHOAL escort helicopter radar', discipline: null, ...UNGRADED },
      { id: 'mcm-detachment', title: 'MCM DET survey', discipline: null, ...UNGRADED }
    ]
  },
  {
    id: SIM_FEED_IDS.ais, title: 'Simulated AIS (Varn Strait)', category: 'intelligence', feedClass: 'positions', format: 'ais-nmea', transport: 'loopback', ...simulated,
    channels: [{ id: 'sim-receiver', title: 'Simulated shore receiver', discipline: 'OSINT', ...UNGRADED, origin: 'Vessel transponders (self-reported)' }]
  },
  {
    id: SIM_FEED_IDS.rss, title: 'Simulated open-source reports (RSS)', category: 'intelligence', feedClass: 'reports', format: 'rss', transport: 'loopback', ...simulated,
    channels: [
      { id: 'calder-courier', title: 'Calder Courier (fictional local newspaper)', discipline: 'OSINT', ...UNGRADED },
      { id: 'social-video-digest', title: 'Peninsula social video digest (fictional)', discipline: 'OSINT', ...UNGRADED },
      { id: 'dravic-state-broadcaster', title: 'Dravic state broadcaster (fictional)', discipline: 'OSINT', ...UNGRADED }
    ]
  },
  {
    id: SIM_FEED_IDS.partner, title: 'Simulated partner reporting (mock partner server)', category: 'intelligence', feedClass: 'reports', format: 'partner-mcp', transport: 'partner', ...simulated,
    channels: [
      { id: 'humint', title: 'Partner HUMINT (simulated)', discipline: 'HUMINT', ...UNGRADED },
      { id: 'sigint', title: 'Partner SIGINT (simulated)', discipline: 'SIGINT', ...UNGRADED },
      { id: 'masint', title: 'Partner MASINT (simulated)', discipline: 'MASINT', ...UNGRADED },
      { id: 'ci', title: 'Partner CI (simulated)', discipline: 'CI', ...UNGRADED }
    ]
  }
];

export function simFeed(stream: SimStream): FeedDescriptor {
  const feed = SIM_FEEDS.find((entry) => entry.id === SIM_FEED_IDS[stream]);
  if (!feed) throw new Error(`No simulated feed for ${stream}.`);
  return feed;
}

/** The COP feed layers each simulated feed shows in: every one of them carries the SIM badge while the simulation feeds it. */
export function simLayers(): string[] {
  const layers = new Set<string>();
  for (const feed of SIM_FEEDS) for (const layer of layersFor(feed.category, feed.format)) layers.add(layer);
  return [...layers].sort();
}
