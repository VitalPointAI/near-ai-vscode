// The simulated timeline (research note 11, 8.1 and 8.2; WP-SIM): the inject script and the scenario expanded into every message the streams carry, in
// one fixed order, on the exercise calendar. Nothing here reads a clock or a random source, so the same scenario and script always give the same
// messages, byte for byte, whatever speed the player later runs at. Pure: no I/O, no clock, no vscode.
import { demoScript } from '../demoScripts';
import type { ResolvedDemoScript } from '../demoScripts';
import { defaultStaffSettings } from '../profiles';
import type { StaffSettings } from '../profiles';
import { gridCentre, gridErrorMetres, gridToWgs84 } from '../obs/frame';
import type { GridMetres, GridReference } from '../obs/frame';
import type { Scenario } from '../scenario';
import {
  aisClassAPosition, aisClassAStaticVoyage, aisClassBPosition, aisClassBStatic, AIS_NAV_STATUS, AIS_SHIP_TYPES, COT_HOW, cotEventXml, isoTime, SIM_LINK_BASE,
  SIM_MARKING
} from './formats';
import type { PartnerReport, RssItemSpec } from './formats';
import { formatScenarioTime } from './script';
import type { Inject, InjectScript, MarkerInject, SimStream, TrackInject, VesselInject } from './script';

/** The most messages one timeline may hold. */
export const SIM_MAX_MESSAGES = 50_000;
/** How often a vessel repeats its static data (AIS sends it every six minutes; the simulator every six scenario hours keeps the stream small). */
export const AIS_STATIC_EVERY_MINUTES = 360;
/** GPS circular error for own tracks, in metres. */
export const OWN_TRACK_ERROR_M = 10;
/** The label partner simulations carry: inside the template ceiling. */
export const SIM_PARTNER_LABEL = 'org/Internal';

interface MessageBase {
  /** Position in the timeline: the order every run emits in. */
  readonly seq: number;
  /** Milliseconds on the exercise calendar (UTC). */
  readonly at: number;
  readonly scenarioTime: string;
  readonly inject: string;
}
export interface CotMessage extends MessageBase { readonly stream: 'cot-own' | 'cot-intel'; readonly channel: string; readonly subject: string; readonly xml: string }
export interface AisMessage extends MessageBase { readonly stream: 'ais'; readonly channel: string; readonly subject: string; readonly sentences: readonly string[] }
export interface RssMessage extends MessageBase { readonly stream: 'rss'; readonly channel: string; readonly item: RssItemSpec }
export interface PartnerMessage extends MessageBase { readonly stream: 'partner'; readonly channel: string; readonly report: PartnerReport }
/** Not traffic: the start of a J2 demo beat, shown to the presenter. A held marker pauses the player once it is reached. */
export interface MarkerMessage extends MessageBase { readonly stream: 'marker'; readonly beat: number; readonly title: string; readonly hold: boolean }
export type SimMessage = CotMessage | AisMessage | RssMessage | PartnerMessage | MarkerMessage;
export type TrafficMessage = Exclude<SimMessage, MarkerMessage>;

export interface SimTimeline {
  readonly scenario: string;
  readonly exercise: string;
  /** D-day 0000 on the exercise calendar, in milliseconds. */
  readonly dDay: number;
  readonly start: number;
  readonly end: number;
  readonly messages: readonly SimMessage[];
  readonly outlets: InjectScript['outlets'];
  readonly partner: InjectScript['partner'];
}

const MINUTE = 60_000;
const KNOT_MS = 1852 / 3600;

/** A J2 demo beat's title, as the resolved demo script names it for the team's doctrine profile. */
export function j2BeatTitle(script: ResolvedDemoScript, beat: number): string {
  const entry = script.beats[beat - 1];
  if (!entry) throw new Error(`The J2 demo has no beat ${beat}.`);
  return entry.title;
}

/** Where along a route a thing is after `metres`: the point and the direction of travel (degrees true). Loops go out and back. */
export function alongRoute(route: readonly GridMetres[], metres: number, loop: boolean): { point: GridMetres; course: number } {
  if (route.length === 1) return { point: route[0], course: 0 };
  const legs = route.slice(1).map((to, index) => ({ from: route[index], to, length: Math.hypot(to.eastingMetres - route[index].eastingMetres, to.northingMetres - route[index].northingMetres) }));
  const total = legs.reduce((sum, leg) => sum + leg.length, 0);
  if (total === 0) return { point: route[0], course: 0 };
  let distance = metres;
  let reverse = false;
  if (loop) {
    const cycle = distance % (2 * total);
    reverse = cycle > total;
    distance = reverse ? 2 * total - cycle : cycle;
  } else {
    distance = Math.min(distance, total);
  }
  let walked = 0;
  for (const leg of legs) {
    if (distance <= walked + leg.length || leg === legs[legs.length - 1]) {
      const share = leg.length === 0 ? 0 : Math.min(1, (distance - walked) / leg.length);
      const point = { eastingMetres: leg.from.eastingMetres + (leg.to.eastingMetres - leg.from.eastingMetres) * share, northingMetres: leg.from.northingMetres + (leg.to.northingMetres - leg.from.northingMetres) * share };
      const dx = (leg.to.eastingMetres - leg.from.eastingMetres) * (reverse ? -1 : 1);
      const dy = (leg.to.northingMetres - leg.from.northingMetres) * (reverse ? -1 : 1);
      return { point, course: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 };
    }
    walked += leg.length;
  }
  return { point: route[route.length - 1], course: 0 };
}

/** The bearing in degrees true from one grid position to another (grid north is true north in the frame's local plane). */
export function gridBearing(from: GridMetres, to: GridMetres): number {
  return ((Math.atan2(to.eastingMetres - from.eastingMetres, to.northingMetres - from.northingMetres) * 180) / Math.PI + 360) % 360;
}

interface Pending { readonly at: number; readonly line: number; readonly order: number; readonly make: (seq: number) => SimMessage }

/**
 * Expands the script into the timeline. Beat titles and the mid-demo report come from the J2 demo script resolved for `settings` (the team's doctrine
 * profile and level), so the presenter sees the same words in both. Throws on a script that would make more than SIM_MAX_MESSAGES messages.
 */
export function buildSimTimeline(scenario: Scenario, script: InjectScript, settings: StaffSettings = defaultStaffSettings()): SimTimeline {
  const j2 = demoScript('j2', settings, scenario);
  const frame = scenario.region.frame;
  if (!frame) throw new Error('The scenario has no exercise frame.');
  const dDay = Date.parse(script.exercise.dDay);
  const calendar = (minutes: number): number => dDay + Math.round(minutes * MINUTE);
  const wgs = (point: GridMetres): { lat: number; lon: number } => {
    const position = gridToWgs84(frame, point);
    return { lat: position.latitude, lon: position.longitude };
  };
  const pending: Pending[] = [];
  const push = (minutes: number, inject: Inject, order: number, make: Pending['make']): void => {
    pending.push({ at: calendar(minutes), line: inject.line, order, make });
    if (pending.length > SIM_MAX_MESSAGES) throw new Error(`The script makes more than ${SIM_MAX_MESSAGES} messages.`);
  };
  const base = (seq: number, minutes: number, inject: Inject) => ({ seq, at: calendar(minutes), scenarioTime: formatScenarioTime(minutes), inject: inject.id });
  const reportOf = (id: string | undefined) => (id === undefined ? undefined : scenario.reports.find((report) => report.id === id));

  for (const inject of script.injects) {
    switch (inject.kind) {
      case 'track': expandTrack(inject, scenario.id, script, push, base, wgs, reportOf); break;
      case 'vessel': expandVessel(inject, push, base, wgs); break;
      case 'spot': {
        const report = reportOf(inject.report);
        const demo = inject.demoInject ? j2.inject : undefined;
        if (inject.demoInject && !demo) throw new Error('The J2 demo script has no mid-demo report.');
        const remarks = demo ? demo.text : report ? `${report.id} (${report.grade ? `${report.grade.reliability}${report.grade.credibility}` : 'ungraded'}): ${report.title}. ${report.text}` : inject.id;
        inject.places.forEach((place, index) => {
          push(inject.at, inject, index, (seq) => {
            const point = wgs(gridCentre(place));
            const time = calendar(inject.at);
            return {
              ...base(seq, inject.at, inject), stream: inject.stream, channel: inject.channel, subject: `${inject.id}-${index + 1}`,
              xml: cotEventXml({
                uid: `${script.exercise.name.replace(/\s+/g, '-')}-${inject.id}-${index + 1}`, type: inject.type, identity: inject.identity, how: COT_HOW.estimated,
                time, stale: time + inject.staleMinutes * MINUTE, lat: point.lat, lon: point.lon, ce: gridErrorMetres(place), le: null,
                callsign: inject.callsign, remarks, exercise: script.exercise.name, scenario: scenario.id, inject: inject.id
              })
            };
          });
        });
        break;
      }
      case 'footprint': {
        const report = reportOf(inject.report)!;
        push(inject.at, inject, 0, (seq) => {
          const corners = inject.corners.map((corner) => wgs(corner));
          const centre = wgs({ eastingMetres: avg(inject.corners.map((c) => c.eastingMetres)), northingMetres: avg(inject.corners.map((c) => c.northingMetres)) });
          const time = calendar(inject.at);
          return {
            ...base(seq, inject.at, inject), stream: 'cot-intel', channel: inject.channel, subject: inject.id,
            xml: cotEventXml({
              uid: `${script.exercise.name.replace(/\s+/g, '-')}-${inject.id}`, type: 'u-d-f', how: COT_HOW.transcribed, time, stale: time + 24 * 60 * MINUTE,
              lat: centre.lat, lon: centre.lon, ce: null, le: null, callsign: `${report.id} footprint`,
              remarks: `${report.id} imagery footprint: ${report.title}.`, shape: [...corners, corners[0]].map((c) => [c.lat, c.lon] as const),
              exercise: script.exercise.name, scenario: scenario.id, inject: inject.id
            })
          };
        });
        break;
      }
      case 'item': {
        push(inject.at, inject, 0, (seq) => ({
          ...base(seq, inject.at, inject), stream: 'rss', channel: inject.outlet,
          item: {
            guid: `${scenario.id}:${inject.id}`, title: inject.title, description: inject.text, published: calendar(inject.at),
            link: `${SIM_LINK_BASE}/${scenario.id}/${inject.outlet}/${inject.id}`
          }
        }));
        break;
      }
      case 'partner-report': {
        push(inject.at, inject, 0, (seq) => {
          const place = inject.place;
          const location = place ? { ...roundLatLon(wgs(gridCentre(place))), ceMetres: Math.round(gridErrorMetres(place)) } : undefined;
          const bearings = inject.bearings.map((b) => {
            const from = roundLatLon(wgs(gridCentre(b.from)));
            return { station: b.station, fromLat: from.lat, fromLon: from.lon, bearingDegrees: Math.round(gridBearing(gridCentre(b.from), gridCentre(b.toward)) * 10) / 10 };
          });
          const report: PartnerReport = {
            id: inject.report ?? inject.id, discipline: inject.discipline, title: inject.title, scenarioTime: formatScenarioTime(inject.at),
            reportedAt: isoTime(calendar(inject.at)), source: inject.source, origin: inject.origin, ...(inject.grade ? { grade: inject.grade } : {}),
            text: inject.text, ...(inject.deception ? { deception: inject.deception } : {}), about: inject.about,
            ...(location ? { location } : {}), ...(bearings.length > 0 ? { bearings } : {}),
            marking: SIM_MARKING, simulated: true, handling: ['local-only'], label: SIM_PARTNER_LABEL, partner: script.partner.title
          };
          return { ...base(seq, inject.at, inject), stream: 'partner', channel: inject.discipline.toLowerCase(), report };
        });
        break;
      }
      case 'marker': {
        const marker: MarkerInject = inject;
        push(marker.at, marker, 0, (seq) => ({ ...base(seq, marker.at, marker), stream: 'marker', beat: marker.beat, title: j2BeatTitle(j2, marker.beat), hold: marker.hold }));
        break;
      }
    }
  }
  pending.sort((a, b) => a.at - b.at || a.line - b.line || a.order - b.order);
  const messages = pending.map((entry, index) => entry.make(index));
  return {
    scenario: scenario.id, exercise: script.exercise.name, dDay, start: calendar(script.window.from), end: calendar(script.window.to), messages,
    outlets: script.outlets, partner: script.partner
  };
}

function avg(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundLatLon(point: { lat: number; lon: number }): { lat: number; lon: number } {
  return { lat: Math.round(point.lat * 1e6) / 1e6, lon: Math.round(point.lon * 1e6) / 1e6 };
}

function ticks(from: number, to: number, every: number): number[] {
  const out: number[] = [];
  for (let minute = from; minute <= to; minute += every) out.push(minute);
  return out;
}

type Push = (minutes: number, inject: Inject, order: number, make: Pending['make']) => void;
type Base = (seq: number, minutes: number, inject: Inject) => { seq: number; at: number; scenarioTime: string; inject: string };
type Wgs = (point: GridMetres) => { lat: number; lon: number };

function routeMetres(route: readonly GridReference[]): GridMetres[] {
  return route.map((reference) => gridCentre(reference));
}

function expandTrack(inject: TrackInject, scenarioId: string, script: InjectScript, push: Push, base: Base, wgs: Wgs, reportOf: (id: string | undefined) => Scenario['reports'][number] | undefined): void {
  const route = routeMetres(inject.route);
  const speed = inject.speedKph / 3.6;
  const report = reportOf(inject.report);
  const remarks = report ? `${report.id} (${report.grade ? `${report.grade.reliability}${report.grade.credibility}` : 'ungraded'}): ${report.title}.` : `${inject.callsign} position report.`;
  const own = inject.stream === 'cot-own';
  for (const minute of ticks(inject.from, inject.to, inject.everyMinutes)) {
    push(minute, inject, 0, (seq) => {
      const { point, course } = alongRoute(route, (minute - inject.from) * 60 * speed, inject.loop);
      const position = wgs(point);
      const time = base(seq, minute, inject).at;
      return {
        ...base(seq, minute, inject), stream: inject.stream, channel: inject.channel, subject: inject.id,
        xml: cotEventXml({
          uid: `${script.exercise.name.replace(/\s+/g, '-')}-${inject.id}`, type: inject.type, identity: inject.identity, how: own ? COT_HOW.gps : COT_HOW.estimated,
          time, stale: time + 3 * inject.everyMinutes * MINUTE, lat: position.lat, lon: position.lon, ce: own ? OWN_TRACK_ERROR_M : gridErrorMetres(inject.route[0]),
          le: null, callsign: inject.callsign, remarks, course, speed, exercise: script.exercise.name, scenario: scenarioId, inject: inject.id
        })
      };
    });
  }
}

function expandVessel(inject: VesselInject, push: Push, base: Base, wgs: Wgs): void {
  const route = routeMetres(inject.route);
  const speedMs = inject.speedKnots * KNOT_MS;
  const shipType = AIS_SHIP_TYPES[inject.shipType];
  const navStatus = AIS_NAV_STATUS[inject.navStatus];
  ticks(inject.from, inject.to, inject.everyMinutes).forEach((minute, index) => {
    push(minute, inject, 0, (seq) => {
      const { point, course } = alongRoute(route, (minute - inject.from) * 60 * speedMs, true);
      const position = wgs(point);
      const at = base(seq, minute, inject).at;
      const channel = index % 2 === 0 ? 'A' : 'B';
      const second = new Date(at).getUTCSeconds();
      const spec = { mmsi: inject.mmsi, lat: position.lat, lon: position.lon, speedKnots: speedMs === 0 ? 0 : inject.speedKnots, courseDegrees: course, headingDegrees: course, second, navStatus, channel } as const;
      const sentences = inject.vesselClass === 'A' ? aisClassAPosition(spec) : aisClassBPosition(spec);
      const staticDue = (minute - inject.from) % AIS_STATIC_EVERY_MINUTES < inject.everyMinutes;
      const statics = !staticDue ? [] : inject.vesselClass === 'A'
        ? aisClassAStaticVoyage({
          mmsi: inject.mmsi, name: inject.name, callsign: inject.callsign, shipType, dimensions: inject.dimensions, channel, sequenceId: index % 10, imo: 0,
          destination: inject.destination, draughtMetres: 0, eta: { month: 0, day: 0, hour: 24, minute: 60 }
        })
        : aisClassBStatic({ mmsi: inject.mmsi, name: inject.name, callsign: inject.callsign, shipType, dimensions: inject.dimensions, channel });
      return { ...base(seq, minute, inject), stream: 'ais', channel: 'sim-receiver', subject: String(inject.mmsi), sentences: [...statics, ...sentences] };
    });
  });
}

/** The streams a timeline feeds, and how many messages each carries. */
export function timelineCounts(timeline: SimTimeline): Readonly<Record<SimStream | 'marker', number>> {
  const counts: Record<SimStream | 'marker', number> = { 'cot-own': 0, 'cot-intel': 0, ais: 0, rss: 0, partner: 0, marker: 0 };
  for (const message of timeline.messages) counts[message.stream] += 1;
  return counts;
}
