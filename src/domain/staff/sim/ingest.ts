// The minimal ingest for the simulator's own formats (drop 2 integration; research note 11, 3 and 8): each simulated CoT event, AIS position sentence
// and RSS item becomes an observation row in the WP-OBS0 contract, so the simulated streams reach the J2 through the observation store like any other
// feed. It reads only what formats.ts writes: CoT event 2.0 with a point and the simulation's detail, AIS messages 1, 2, 3 and 18 in one sentence (the
// static messages 5 and 24 only name a vessel), and the structured RSS item. General importers (any CoT producer, multi-part AIS, any RSS or Atom feed)
// are WP-IMP. Partner reports are not ingested here: the partner feed stays off until a person adds the mock partner server. Pure: no I/O, no clock.
import { COT_IDENTITY_CODES, STANDARD_IDENTITIES } from '../doctrine';
import type { StandardIdentity } from '../doctrine';
import { channelHandling, channelLabel } from '../obs/feeds';
import type { ChannelDescriptor, FeedDescriptor } from '../obs/feeds';
import { gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { observationId, OBSERVATION_SCHEMA, segmentId } from '../obs/observation';
import { SIM_FEED_IDS, SIM_FEEDS } from './feeds';
import { COT_HOW, COT_UNKNOWN_ERROR, SIM_FORMAT_VERSION } from './formats';
import type { SimStream } from './script';
import type { SimMessage } from './timeline';

/** The streams this ingest takes into the store. */
export const SIM_INGESTED_STREAMS: readonly SimStream[] = ['cot-own', 'cot-intel', 'ais', 'rss'];

/** An RSS item names no position: it is placed at the centre of the exercise frame with this error, so a slice by area finds it only across the frame. */
export const RSS_AREA_ERROR_METRES = 50_000;

const xmlUnescape = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? xmlUnescape(match[1]) : undefined;
}

function element(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}\\b[^>]*/?>`).exec(xml)?.[0];
}

export interface CotEvent {
  readonly uid: string;
  readonly type: string;
  readonly how: string;
  readonly time: string;
  readonly stale: string;
  readonly lat: number;
  readonly lon: number;
  readonly ce: number | null;
  readonly callsign?: string;
  readonly remarks?: string;
  readonly course?: number;
  readonly speed?: number;
  /** Footprint corners, `[lat, lon]`, when the event carries a shape. */
  readonly shape: ReadonlyArray<readonly [number, number]>;
}

/** One CoT event as the simulator writes it, or undefined when it is not one. */
export function parseCotEvent(xml: string): CotEvent | undefined {
  const event = element(xml, 'event');
  const point = element(xml, 'point');
  if (!event || !point) return undefined;
  const uid = attribute(event, 'uid');
  const type = attribute(event, 'type');
  const how = attribute(event, 'how');
  const time = attribute(event, 'time');
  const stale = attribute(event, 'stale');
  const lat = Number(attribute(point, 'lat'));
  const lon = Number(attribute(point, 'lon'));
  if (!uid || !type || !how || !time || !stale || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const ceText = Number(attribute(point, 'ce'));
  const contact = element(xml, 'contact');
  const track = element(xml, 'track');
  const remarks = /<remarks>([^<]*)<\/remarks>/.exec(xml)?.[1];
  const shape = [...xml.matchAll(/<link point="(-?[0-9.]+),(-?[0-9.]+)"\/>/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
  const callsign = contact ? attribute(contact, 'callsign') : undefined;
  const course = track ? Number(attribute(track, 'course')) : NaN;
  const speed = track ? Number(attribute(track, 'speed')) : NaN;
  return {
    uid, type, how, time, stale, lat, lon, ce: Number.isFinite(ceText) && ceText !== COT_UNKNOWN_ERROR ? ceText : null, shape,
    ...(callsign ? { callsign } : {}), ...(remarks !== undefined ? { remarks: xmlUnescape(remarks) } : {}),
    ...(Number.isFinite(course) ? { course } : {}), ...(Number.isFinite(speed) ? { speed } : {})
  };
}

/** The standard identity a CoT atom type claims (`a-h-G` is hostile), or undefined for a non-atom. */
export function cotIdentity(type: string): StandardIdentity | undefined {
  const parts = type.split('-');
  if (parts[0] !== 'a' || parts.length < 2) return undefined;
  return STANDARD_IDENTITIES.find((identity) => COT_IDENTITY_CODES[identity] === parts[1]);
}

// ---- AIS ----------------------------------------------------------------------------------------------------------------------------------------

export interface AisPosition { readonly type: number; readonly mmsi: number; readonly lat: number; readonly lon: number; readonly speedKnots?: number; readonly courseDegrees?: number; readonly headingDegrees?: number }
export interface AisStatic { readonly type: number; readonly mmsi: number; readonly name: string }

function payloadBits(payload: string): number[] | undefined {
  const bits: number[] = [];
  for (const char of payload) {
    let value = char.charCodeAt(0) - 48;
    if (value < 0 || value > 71 || (value > 39 && value < 48)) return undefined;
    if (value > 40) value -= 8;
    for (let bit = 5; bit >= 0; bit -= 1) bits.push((value >> bit) & 1);
  }
  return bits;
}

function uint(bits: readonly number[], start: number, width: number): number {
  let value = 0;
  for (let index = start; index < start + width; index += 1) value = value * 2 + (bits[index] ?? 0);
  return value;
}

function int(bits: readonly number[], start: number, width: number): number {
  const value = uint(bits, start, width);
  return bits[start] ? value - 2 ** width : value;
}

function sixBitText(bits: readonly number[], start: number, chars: number): string {
  const table = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';
  let out = '';
  for (let index = 0; index < chars; index += 1) out += table[uint(bits, start + index * 6, 6)] ?? '';
  return out.replace(/@+$/, '').trim();
}

function checksumOk(sentence: string): boolean {
  const match = /^!(.*)\*([0-9A-F]{2})$/.exec(sentence.trim());
  if (!match) return false;
  let sum = 0;
  for (const char of match[1]) sum ^= char.charCodeAt(0);
  return sum === parseInt(match[2], 16);
}

/** One `!AIVDM` sentence as the simulator writes it: a position (1, 2, 3, 18), the name of a class B vessel (24 part A), or undefined. */
export function parseAisSentence(sentence: string): AisPosition | AisStatic | undefined {
  if (!checksumOk(sentence)) return undefined;
  const fields = sentence.trim().split('*')[0].split(',');
  if (fields[0] !== '!AIVDM' || fields.length < 7 || fields[1] !== '1') return undefined;
  const bits = payloadBits(fields[5]);
  if (!bits || bits.length < 38) return undefined;
  const type = uint(bits, 0, 6);
  const mmsi = uint(bits, 8, 30);
  if (type === 24 && uint(bits, 38, 2) === 0) return { type, mmsi, name: sixBitText(bits, 40, 20) };
  if (type !== 1 && type !== 2 && type !== 3 && type !== 18) return undefined;
  const at = type === 18 ? { sog: 46, lon: 57, lat: 85, cog: 112, hdg: 124 } : { sog: 50, lon: 61, lat: 89, cog: 116, hdg: 128 };
  const longitude = int(bits, at.lon, 28) / 600_000;
  const latitude = int(bits, at.lat, 27) / 600_000;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return undefined;
  const sog = uint(bits, at.sog, 10);
  const cog = uint(bits, at.cog, 12);
  const hdg = uint(bits, at.hdg, 9);
  return {
    type, mmsi, lat: latitude, lon: longitude,
    ...(sog !== 1023 ? { speedKnots: sog / 10 } : {}), ...(cog !== 3600 ? { courseDegrees: cog / 10 } : {}), ...(hdg !== 511 ? { headingDegrees: hdg } : {})
  };
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
      const footprint = event.shape.length >= 4;
      const identity = cotIdentity(event.type);
      const how = event.how === COT_HOW.gps ? 'gps' : event.how === COT_HOW.estimated ? 'estimated' : 'reported';
      return [{
        ...common(`${event.uid}@${event.time}`), validAt: event.time, validUntil: event.stale,
        geometry: footprint ? { type: 'Polygon', coordinates: [event.shape.map(([lat, lon]) => [round(lon, 7), round(lat, 7)])] } : { type: 'Point', coordinates: [round(event.lon, 7), round(event.lat, 7)] },
        error: { circularMetres: event.ce, verticalMetres: null }, how, subjectRef: event.uid, observedType: event.type, ...(identity ? { claimedIdentity: identity } : {}),
        attributes: {
          ...(event.callsign ? { name: event.callsign } : {}), ...(event.remarks ? { excerpt: event.remarks.slice(0, 500) } : {}),
          ...(event.course !== undefined ? { courseDegrees: event.course } : {}), ...(event.speed !== undefined ? { speedMetresPerSecond: event.speed } : {})
        },
        deceptionNote: message.stream === 'cot-own' ? 'none seen: own-force position report' : 'not assessed yet: a simulated report for the J2 to weigh',
        extractor: { codec: 'sim-cot', version: SIM_FORMAT_VERSION },
        ...(footprint ? {} : { trackId: `cot:${event.uid}` })
      }];
    }
    if (message.stream === 'ais') {
      const out: Array<Record<string, unknown>> = [];
      for (const sentence of message.sentences) {
        const parsed = parseAisSentence(sentence);
        if (!parsed) continue;
        if ('name' in parsed) { if (parsed.name) this.names.set(parsed.mmsi, parsed.name); continue; }
        const name = this.names.get(parsed.mmsi);
        out.push({
          ...common(`${parsed.mmsi}@${iso(message.at)}`), validAt: known,
          geometry: { type: 'Point', coordinates: [round(parsed.lon, 6), round(parsed.lat, 6)] }, error: { circularMetres: 10, verticalMetres: null }, how: 'reported',
          subjectRef: String(parsed.mmsi),
          attributes: {
            ...(name ? { name } : {}), ...(parsed.speedKnots !== undefined ? { speedMetresPerSecond: round(parsed.speedKnots * 1852 / 3600, 2) } : {}),
            ...(parsed.courseDegrees !== undefined ? { courseDegrees: parsed.courseDegrees } : {}), ...(parsed.headingDegrees !== undefined ? { headingDegrees: parsed.headingDegrees } : {})
          },
          deceptionNote: 'not assessed yet: AIS is self-reported by the vessel', extractor: { codec: 'sim-ais', version: SIM_FORMAT_VERSION }, trackId: `mmsi:${parsed.mmsi}`
        });
      }
      return out;
    }
    if (message.stream !== 'rss') return [];
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
