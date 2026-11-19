// The minimal ingest for the simulator's own formats (drop 2 integration; research note 11, 3 and 8): each simulated CoT event, AIS position sentence
// and RSS item becomes an observation row in the WP-OBS0 contract, so the simulated streams reach the J2 through the observation store like any other
// feed. It reads CoT and AIS with the same codecs as the file importers (obs/codecs, WP-IMP: one codec per format), so simulated traffic is read exactly as
// real traffic is; the static AIS messages 5 and 24 only name a vessel, and the RSS item arrives already structured. Partner reports are not ingested here: the partner feed stays off until a person adds the mock partner server. Pure: no I/O, no clock.
import { channelHandling, channelLabel } from '../obs/feeds';
import type { ChannelDescriptor, FeedDescriptor } from '../obs/feeds';
import { gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { aisAttributes, cotRecord, RSS_AREA_ERROR_METRES } from '../obs/importers';
import { observationId, OBSERVATION_SCHEMA, segmentId } from '../obs/observation';
import { AisAssembler, decodeAis, parseAisLine } from '../obs/codecs/ais';
import type { AisDecoded } from '../obs/codecs/ais';
import { cotEventFrom } from '../obs/codecs/cot';
import type { CotEvent } from '../obs/codecs/cot';
import { readXml } from '../obs/codecs/xml';
import { SIM_FEED_IDS, SIM_FEEDS } from './feeds';
import { SIM_FORMAT_VERSION } from './formats';
import type { SimStream } from './script';
import type { SimMessage } from './timeline';

export { cotIdentity } from '../obs/codecs/cot';
export type { CotEvent } from '../obs/codecs/cot';
export { RSS_AREA_ERROR_METRES };

/** The streams this ingest takes into the store. */
export const SIM_INGESTED_STREAMS: readonly SimStream[] = ['cot-own', 'cot-intel', 'ais', 'rss'];

/** One CoT event, read by the one CoT codec (obs/codecs/cot.ts) through the strict XML reader, or undefined when it is not one. */
export function parseCotEvent(xml: string): CotEvent | undefined {
  const read = readXml(xml);
  if (!read.ok) return undefined;
  const event = cotEventFrom(read.root);
  return typeof event === 'string' ? undefined : event;
}

// ---- AIS ----------------------------------------------------------------------------------------------------------------------------------------

/** One single-part `!AIVDM` sentence, read by the one AIS codec (obs/codecs/ais.ts), or undefined when it is not a whole message it reads. */
export function parseAisSentence(sentence: string): AisDecoded | undefined {
  const line = parseAisLine(sentence);
  if (!line.ok || line.sentence.fragments !== 1) return undefined;
  const message = new AisAssembler().add(line.sentence);
  const decoded = message ? decodeAis(message) : undefined;
  return typeof decoded === 'object' ? decoded : undefined;
}

// ---- Rows ---------------------------------------------------------------------------------------------------------------------------------------

function feedOf(stream: SimStream): FeedDescriptor {
  const feed = SIM_FEEDS.find((entry) => entry.id === SIM_FEED_IDS[stream]);
  if (!feed) throw new Error(`No simulated feed for ${stream}.`);
  return feed;
}

function channelOf(feed: FeedDescriptor, id: string): ChannelDescriptor | undefined {
  return feed.channels.find((channel) => channel.id === id);
}

const iso = (ms: number): string => new Date(ms).toISOString();
const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Turns simulator traffic into observation rows. It keeps the vessel names the static AIS messages carry, so later positions are named. `knownAt` is the
 * time the message was received on the store's clock (the simulation's exercise clock while it runs).
 */
export class SimIngest {
  private readonly names = new Map<number, string>();
  /** Multi-part messages (type 5) are put back together across sentences by the one AIS codec. */
  private readonly ais = new AisAssembler();

  constructor(private readonly frame: ExerciseFrame) {}

  rows(message: SimMessage, knownAt: number): Array<Record<string, unknown>> {
    if (message.stream === 'marker' || message.stream === 'partner') return [];
    const feed = feedOf(message.stream);
    const channel = channelOf(feed, message.channel);
    if (!channel) return [];
    const known = iso(knownAt);
    const common = (messageId: string): Record<string, unknown> => ({
      schema: OBSERVATION_SCHEMA, obsId: observationId(feed.id, channel.id, messageId), messageId, segment: segmentId(feed.id, channel.id, known),
      feed: feed.id, channel: channel.id, discipline: channel.discipline, knownAt: known,
      source: channel.title, origin: channel.origin ?? channel.title, reliability: channel.reliability ?? 'F', credibility: channel.credibility ?? 6,
      label: channelLabel(feed, channel), handling: channelHandling(feed, channel), simulated: true
    });
    if (message.stream === 'cot-own' || message.stream === 'cot-intel') {
      const event = parseCotEvent(message.xml);
      if (!event) return [];
      const record = cotRecord(event);
      return [{
        ...common(record.messageId), validAt: record.validAt ?? known, ...(record.validUntil ? { validUntil: record.validUntil } : {}),
        geometry: record.geometry, error: record.error, how: record.how,
        ...(record.subjectRef ? { subjectRef: record.subjectRef } : {}), ...(record.observedType ? { observedType: record.observedType } : {}),
        ...(record.claimedIdentity ? { claimedIdentity: record.claimedIdentity } : {}), attributes: record.attributes ?? {},
        deceptionNote: message.stream === 'cot-own' ? 'none seen: own-force position report' : 'not assessed yet: a simulated report for the J2 to weigh',
        extractor: { codec: 'sim-cot', version: SIM_FORMAT_VERSION },
        ...(record.trackId ? { trackId: record.trackId } : {})
      }];
    }
    if (message.stream === 'ais') {
      const out: Array<Record<string, unknown>> = [];
      for (const sentence of message.sentences) {
        const line = parseAisLine(sentence);
        if (!line.ok) continue;
        const whole = this.ais.add(line.sentence);
        const parsed = whole ? decodeAis(whole) : undefined;
        if (typeof parsed !== 'object') continue;
        if (parsed.name) this.names.set(parsed.mmsi, parsed.name);
        if (parsed.kind !== 'position') continue;
        out.push({
          ...common(`${parsed.mmsi}@${iso(message.at)}`), validAt: known,
          geometry: { type: 'Point', coordinates: [round(parsed.lon, 6), round(parsed.lat, 6)] }, error: { circularMetres: 10, verticalMetres: null }, how: 'reported',
          subjectRef: String(parsed.mmsi), attributes: aisAttributes(parsed, this.names.get(parsed.mmsi)),
          deceptionNote: 'not assessed yet: AIS is self-reported by the vessel', extractor: { codec: 'sim-ais', version: SIM_FORMAT_VERSION }, trackId: `mmsi:${parsed.mmsi}`
        });
      }
      return out;
    }
    if (message.stream !== 'rss') return [];
    const centre = gridToWgs84(this.frame, { eastingMetres: (this.frame.extent.eastings * this.frame.squareMetres) / 2, northingMetres: (this.frame.extent.northings * this.frame.squareMetres) / 2 });
    return [{
      ...common(message.item.guid), validAt: iso(message.item.published),
      geometry: { type: 'Point', coordinates: [round(centre.longitude, 6), round(centre.latitude, 6)] }, error: { circularMetres: RSS_AREA_ERROR_METRES, verticalMetres: null }, how: 'reported',
      attributes: { name: message.item.title.slice(0, 200), excerpt: message.item.description.slice(0, 500) },
      deceptionNote: 'not assessed yet: an open-source report for the J2 to weigh', extractor: { codec: 'sim-rss', version: SIM_FORMAT_VERSION }
    }];
  }
}
