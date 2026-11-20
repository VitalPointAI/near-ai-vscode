// One list of where AI may run (endpoints@1, FND-03, Phase 41 D-24 to D-28, D-52). Pure: no I/O, no clock, no vscode, no package.
// Each entry names one place by class, exact host (a `*.` pattern only for your organization's own plain servers), scheme, TLS pins, region and the
// highest label it may receive (`maxLabel`, at most one level per scale; a scale not listed means nothing from that scale reaches it). The parser refuses
// every entry that would let content go where the routing rules never may: a level that stays on this computer off this computer, the levels no third
// party may hold on a third party's service, and anything above the pattern ceiling on a pattern host.
// `migrateLocalHosts` reads a v1 policy's `routing.localHosts` as endpoints at today's effect (D-27), except the levels that now need a pinned connection and
// a signed authorization (Protected B and NATO Restricted on the shipped scales, D-52), and lists each loss.
// routing.ts is imported for isThisComputerOnly and THIS_COMPUTER_ONLY_LEVELS, used only inside functions, never at module load, so 41-10's routing.ts may
// import this file without a load-time cycle; RoutingTable is a type only. Nothing here imports bundle.ts.
import { isLoopbackHost } from '../config';
import { levelIndex, scaleOf } from './labels';
import type { Label, ScaleTable } from './labels';
import { THIS_COMPUTER_ONLY_LEVELS, isThisComputerOnly } from './routing';
import type { RoutingTable, RoutingTier } from './routing';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';
import { parseHostPattern } from './vocabulary';

/**
 * Who runs the place and how it is proven: this computer; your organization's own server, plain or proven to run in private hardware; NEAR AI Cloud's
 * private hardware; a vendor's private hardware or region; a service that forwards elsewhere; a closed API.
 */
export const ENDPOINT_CLASSES = Object.freeze(['local', 'org-plain', 'org-tee', 'nearai-tee', 'vendor-tee', 'vendor-region', 'forwarded', 'closed-api'] as const);
export type EndpointClass = (typeof ENDPOINT_CLASSES)[number];

/** Where a place runs: stated by contract for vendors and by your organization for its own servers. `unstated` never satisfies a residency rule (D-33). */
export const ENDPOINT_REGIONS = Object.freeze(['CA', 'US', 'EU', 'unstated'] as const);
export type EndpointRegion = (typeof ENDPOINT_REGIONS)[number];

/** `https` everywhere; `http-loopback` only for a host on this computer. */
export const ENDPOINT_SCHEMES = Object.freeze(['https', 'http-loopback'] as const);
export type EndpointScheme = (typeof ENDPOINT_SCHEMES)[number];

export interface PolicyEndpoint {
  /** A stable token that records and authorizations cite. */
  readonly id: string;
  readonly class: EndpointClass;
  /** An exact lowercase host, or `*.example.org` for an org-plain entry. */
  readonly host: string;
  readonly scheme: EndpointScheme;
  /** Zero to four SHA-256 hashes of the server's public key (SPKI), 64 lowercase hex each, the shape connectionBinding.ts uses. */
  readonly tlsPins: readonly string[];
  readonly region: EndpointRegion;
  /** `scale/level` keys, sorted, at most one per scale. */
  readonly maxLabel: readonly string[];
  /** The verifier for org-tee and vendor-tee (implicit for nearai-tee). */
  readonly attestation?: string;
  /** Which ModelEndpoint adapter talks to it. */
  readonly provider?: string;
}

export const MAX_ENDPOINTS = 128;
export const MAX_TLS_PINS = 4;
export const ENDPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TLS_PIN_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SCALE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** IPv6 loopback as the URL parser writes it; the host grammar of the vocabulary has no brackets, so it is named here. */
const IPV6_LOOPBACK = '[::1]';

/** The classes run by someone other than you or your organization, where no third party may hold the levels below (D-25). */
export const THIRD_PARTY_CLASSES: readonly EndpointClass[] = Object.freeze(['vendor-tee', 'vendor-region', 'forwarded', 'closed-api'] as const);

/**
 * Levels no vendor, forwarding service or closed API may receive (D-25): org Restricted, Protected C, every Canadian classified level and NATO Restricted
 * and above. Keyed `scale/level` on the shipped scales.
 */
export const THIRD_PARTY_REFUSED_LEVELS: readonly string[] = Object.freeze([
  'org/Restricted',
  'ca-protected/Protected C',
  'ca-classified/Confidential',
  'ca-classified/Secret',
  'ca-classified/Top Secret',
  'nato/NATO Restricted',
  'nato/NATO Confidential',
  'nato/NATO Secret',
  'nato/Cosmic Top Secret'
]);

/** The highest a `*.` pattern host may receive, per scale; a scale not listed here gives a pattern host nothing (D-24, D-52). */
export const PATTERN_HOST_CEILING: readonly string[] = Object.freeze(['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']);

/** Classes that carry an attestation verifier of their own. */
const ATTESTED_CLASSES: readonly EndpointClass[] = Object.freeze(['org-tee', 'vendor-tee'] as const);

function isPattern(host: string): boolean {
  return host.startsWith('*.');
}

/** A loopback host as an endpoint names it: localhost, 127.0.0.1 or [::1]. */
export function isLoopbackEndpointHost(host: string): boolean {
  return host === IPV6_LOOPBACK || isLoopbackHost(host);
}

/** `scale/level` split at the first slash (a scale id has none), or undefined when it is not one. */
function splitLabelKey(key: string): { readonly scale: string; readonly level: string } | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0) return undefined;
  const scale = key.slice(0, slash);
  const level = key.slice(slash + 1);
  return SCALE_ID_PATTERN.test(scale) && level !== '' ? { scale, level } : undefined;
}

/** The ceiling entry of a list for one scale, as a level index on `scales`; -1 when the list names nothing on that scale. */
function ceilingIndex(list: readonly string[], scale: string, scales: ScaleTable): number {
  for (const key of list) {
    const parts = splitLabelKey(key);
    if (parts !== undefined && parts.scale === scale) return levelIndex(scales, scale, parts.level);
  }
  return -1;
}

/** True when the level, or any level below it on its scale, is one of `listed`. */
function atOrAboveListed(scale: string, level: string, scales: ScaleTable, listed: readonly string[]): boolean {
  const found = scaleOf(scales, scale);
  if (found === undefined) return true;
  const top = found.levels.indexOf(level);
  for (let index = 0; index <= top; index += 1) {
    if (listed.includes(`${scale}/${found.levels[index] as string}`)) return true;
  }
  return false;
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function parseHost(value: unknown, path: string): Parsed<string> {
  if (value === IPV6_LOOPBACK) return { ok: true, value: IPV6_LOOPBACK };
  const host = parseHostPattern(value, path, 'ceiling');
  if (!host.ok) return host;
  // A lone * would name every host, the opposite of a list of places.
  return host.value === '*' ? refused('not-allowed-here', path) : host;
}

function parsePins(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_TLS_PINS) return refused('not-allowed-here', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const pin: unknown = value[index];
    if (typeof pin !== 'string' || !TLS_PIN_PATTERN.test(pin)) return refused('wrong-type', where);
    if (out.includes(pin)) return refused('duplicate', where);
    if (out.length > 0 && pin < (out[out.length - 1] as string)) return refused('not-sorted', where);
    out.push(pin);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** maxLabel: sorted `scale/level` keys of the document's scales, at most one per scale, each allowed for this class and host (D-24, D-25). */
function parseMaxLabel(value: unknown, path: string, scales: ScaleTable, endpointClass: EndpointClass, host: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  const seenScales: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const key: unknown = value[index];
    if (typeof key !== 'string') return refused('wrong-type', where);
    const parts = splitLabelKey(key);
    if (parts === undefined) return refused('wrong-type', where);
    if (levelIndex(scales, parts.scale, parts.level) < 0) return refused('not-allowed-here', where);
    if (seenScales.includes(parts.scale)) return refused('duplicate', where);
    if (out.length > 0 && key < (out[out.length - 1] as string)) return refused('not-sorted', where);
    // Nothing that stays on this computer goes anywhere else, whatever the class.
    if (endpointClass !== 'local' && atOrAboveListed(parts.scale, parts.level, scales, THIS_COMPUTER_ONLY_LEVELS)) return refused('not-allowed-here', where);
    if (THIRD_PARTY_CLASSES.includes(endpointClass) && atOrAboveListed(parts.scale, parts.level, scales, THIRD_PARTY_REFUSED_LEVELS)) return refused('not-allowed-here', where);
    if (isPattern(host)) {
      const cap = ceilingIndex(PATTERN_HOST_CEILING, parts.scale, scales);
      if (cap < 0 || levelIndex(scales, parts.scale, parts.level) > cap) return refused('not-allowed-here', where);
    }
    seenScales.push(parts.scale);
    out.push(key);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseEndpoint(value: unknown, scales: ScaleTable, path: string): Parsed<PolicyEndpoint> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id', 'class', 'host', 'scheme', 'tlsPins', 'region', 'maxLabel'], ['attestation', 'provider']);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !ENDPOINT_ID_PATTERN.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const endpointClass = parseChoice(ownValue(value, 'class'), childPath(path, 'class'), ENDPOINT_CLASSES);
  if (!endpointClass.ok) return endpointClass;
  const host = parseHost(ownValue(value, 'host'), childPath(path, 'host'));
  if (!host.ok) return host;
  const loopback = isLoopbackEndpointHost(host.value);
  // The local class is exactly this computer: a loopback host is local, and nothing else is.
  if ((endpointClass.value === 'local') !== loopback) return refused('not-allowed-here', childPath(path, 'class'));
  if (isPattern(host.value) && endpointClass.value !== 'org-plain') return refused('not-allowed-here', childPath(path, 'host'));
  const scheme = parseChoice(ownValue(value, 'scheme'), childPath(path, 'scheme'), ENDPOINT_SCHEMES);
  if (!scheme.ok) return scheme;
  if (scheme.value === 'http-loopback' && !loopback) return refused('not-allowed-here', childPath(path, 'scheme'));
  const tlsPins = parsePins(ownValue(value, 'tlsPins'), childPath(path, 'tlsPins'));
  if (!tlsPins.ok) return tlsPins;
  if (tlsPins.value.length > 0 && (loopback || isPattern(host.value))) return refused('not-allowed-here', childPath(path, 'tlsPins'));
  const region = parseChoice(ownValue(value, 'region'), childPath(path, 'region'), ENDPOINT_REGIONS);
  if (!region.ok) return region;
  const maxLabel = parseMaxLabel(ownValue(value, 'maxLabel'), childPath(path, 'maxLabel'), scales, endpointClass.value, host.value);
  if (!maxLabel.ok) return maxLabel;
  const out: Record<string, unknown> = {
    id, class: endpointClass.value, host: host.value, scheme: scheme.value, tlsPins: tlsPins.value, region: region.value, maxLabel: maxLabel.value
  };
  const attested = ATTESTED_CLASSES.includes(endpointClass.value);
  if (Object.prototype.hasOwnProperty.call(value, 'attestation')) {
    const attestation = ownValue(value, 'attestation');
    if (!attested) return refused('not-allowed-here', childPath(path, 'attestation'));
    if (typeof attestation !== 'string' || !TOKEN_PATTERN.test(attestation)) return refused('wrong-type', childPath(path, 'attestation'));
    out['attestation'] = attestation;
  } else if (attested) {
    return refused('missing-field', childPath(path, 'attestation'));
  }
  if (Object.prototype.hasOwnProperty.call(value, 'provider')) {
    const provider = ownValue(value, 'provider');
    if (typeof provider !== 'string' || !TOKEN_PATTERN.test(provider)) return refused('wrong-type', childPath(path, 'provider'));
    out['provider'] = provider;
  }
  return { ok: true, value: Object.freeze(out) as unknown as PolicyEndpoint };
}

/** endpoints[]: at most MAX_ENDPOINTS entries, sorted by id, with unique ids and unique hosts (D-24). */
export function parseEndpoints(value: unknown, scales: ScaleTable, path = 'endpoints'): Parsed<readonly PolicyEndpoint[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_ENDPOINTS) return refused('not-allowed-here', path);
  const out: PolicyEndpoint[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const entry = parseEndpoint(value[index], scales, where);
    if (!entry.ok) return entry;
    const previous = out[out.length - 1];
    if (out.some((other) => other.id === entry.value.id)) return refused('duplicate', childPath(where, 'id'));
    if (previous !== undefined && entry.value.id < previous.id) return refused('not-sorted', where);
    if (out.some((other) => other.host === entry.value.host)) return refused('duplicate', childPath(where, 'host'));
    out.push(entry.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** Whether the endpoint's ceiling allows the label's level, comparing scale and level only (compartments and handling are routing's to judge). */
export function endpointCeilingAllows(endpoint: Pick<PolicyEndpoint, 'maxLabel'>, label: Pick<Label, 'scale' | 'level'>, scales: ScaleTable): boolean {
  const wanted = levelIndex(scales, label.scale, label.level);
  if (wanted < 0) return false;
  const cap = ceilingIndex(endpoint.maxLabel, label.scale, scales);
  return cap >= 0 && wanted <= cap;
}

/** The hostname of an address given as a URL or a bare host (with or without a port), lowercase, as the URL parser reads it; undefined when unreadable. */
export function endpointHostOf(address: string): string | undefined {
  const text = address.trim();
  if (text === '') return undefined;
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export type EndpointMatch =
  | { readonly kind: 'this-computer' }
  | { readonly kind: 'listed'; readonly endpoint: PolicyEndpoint; readonly match: 'exact' | 'pattern' }
  | { readonly kind: 'none' };

/**
 * The entry an address reaches: an exact host first; then this computer for a loopback host no entry names; then the longest `*.` pattern the host lies
 * strictly below (`*.lab.example.org` matches a.lab.example.org, not lab.example.org). The host is the URL parser's, so a userinfo trick names the host after
 * the `@`. An address that cannot be read reaches nothing.
 */
export function findEndpoint(endpoints: readonly PolicyEndpoint[], address: string): EndpointMatch {
  const name = endpointHostOf(address);
  if (name === undefined) return { kind: 'none' };
  const exact = endpoints.find((endpoint) => !isPattern(endpoint.host) && endpoint.host === name);
  if (exact !== undefined) return { kind: 'listed', endpoint: exact, match: 'exact' };
  if (isLoopbackEndpointHost(name)) return { kind: 'this-computer' };
  let best: PolicyEndpoint | undefined;
  for (const endpoint of endpoints) {
    if (!isPattern(endpoint.host)) continue;
    const suffix = endpoint.host.slice(1);
    if (name.endsWith(suffix) && name.length > suffix.length && (best === undefined || endpoint.host.length > best.host.length)) best = endpoint;
  }
  return best === undefined ? { kind: 'none' } : { kind: 'listed', endpoint: best, match: 'pattern' };
}

function tierOf(routing: Pick<RoutingTable, 'levels'>, key: string): RoutingTier | undefined {
  return Object.prototype.hasOwnProperty.call(routing.levels, key) ? routing.levels[key] : undefined;
}

/**
 * Whether a level needs a `protected-b` authorization naming the endpoint (D-26, D-52): Protected B always, and any other level the routing table keeps
 * local-only, except org Restricted and the levels that never leave this computer. On the shipped scales that is Protected B and NATO Restricted.
 */
export function needsEndpointAuthorization(labelKey: string, routing: Pick<RoutingTable, 'levels'>): boolean {
  if (labelKey === 'ca-protected/Protected B') return true;
  if (labelKey === 'org/Restricted' || THIS_COMPUTER_ONLY_LEVELS.includes(labelKey)) return false;
  return tierOf(routing, labelKey) === 'local-only';
}

export interface MigrationChange {
  readonly host: string;
  /** `this-computer` for a loopback entry, which makes no endpoint (this computer is always reachable). */
  readonly kind: 'exact' | 'pattern' | 'this-computer';
  readonly endpointId?: string;
  /** The levels the patched routing sent to this host that the new entry's ceiling no longer covers, sorted. */
  readonly lost: readonly string[];
}

/** `local-` and the host, with `*.` written `any-` and dots as dashes, cut to the id's length. */
function migratedIdBase(host: string): string {
  const name = isPattern(host) ? `any-${host.slice(2)}` : host;
  return `local-${name.replace(/[^a-z0-9-]/g, '-')}`.slice(0, 64);
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Reads a v1 `routing.localHosts` list as endpoints at the effect the safety patch gave it (D-27): each non-loopback host becomes an org-plain https entry
 * with no pins and region unstated, whose ceiling on each scale is the longest run of levels from the bottom that the routing table sends to any cloud or
 * attested cloud, and for an exact host also the local-only levels that need neither this computer nor an authorization. Pattern hosts are capped at
 * PATTERN_HOST_CEILING. A loopback entry makes nothing. Ids are `local-` and the host, with `-2`, `-3` for a collision in sorted host order.
 */
export function migrateLocalHosts(routing: RoutingTable, scales: ScaleTable): { readonly endpoints: readonly PolicyEndpoint[]; readonly changes: readonly MigrationChange[] } {
  const endpoints: PolicyEndpoint[] = [];
  const changes: MigrationChange[] = [];
  const taken = new Set<string>();
  for (const host of [...routing.localHosts].sort()) {
    if (isLoopbackEndpointHost(host)) {
      changes.push(Object.freeze({ host, kind: 'this-computer', lost: Object.freeze([]) }));
      continue;
    }
    const pattern = isPattern(host);
    const served = (key: string): boolean => {
      const parts = splitLabelKey(key);
      if (parts === undefined || isThisComputerOnly(parts)) return false;
      const tier = tierOf(routing, key);
      return tier === 'any-cloud' || tier === 'attested-cloud' || (!pattern && tier === 'local-only');
    };
    const maxLabel: string[] = [];
    const lost: string[] = [];
    for (const scaleId of Object.keys(scales).sort()) {
      const scale = scaleOf(scales, scaleId);
      if (scale === undefined) continue;
      const cap = pattern ? ceilingIndex(PATTERN_HOST_CEILING, scaleId, scales) : scale.levels.length - 1;
      let top = -1;
      for (let index = 0; index <= cap; index += 1) {
        const key = `${scaleId}/${scale.levels[index] as string}`;
        const tier = tierOf(routing, key);
        const parts = { scale: scaleId, level: scale.levels[index] as string };
        const keep = !isThisComputerOnly(parts)
          && (tier === 'any-cloud' || tier === 'attested-cloud' || (!pattern && tier === 'local-only' && !needsEndpointAuthorization(key, routing)));
        if (!keep) break;
        top = index;
      }
      if (top >= 0) maxLabel.push(`${scaleId}/${scale.levels[top] as string}`);
      scale.levels.forEach((level, index) => {
        const key = `${scaleId}/${level}`;
        if (served(key) && index > top) lost.push(key);
      });
    }
    const id = uniqueId(migratedIdBase(host), taken);
    taken.add(id);
    endpoints.push(Object.freeze({
      id, class: 'org-plain', host, scheme: 'https', tlsPins: Object.freeze([]), region: 'unstated', maxLabel: Object.freeze(maxLabel.sort())
    }));
    changes.push(Object.freeze({ host, kind: pattern ? 'pattern' : 'exact', endpointId: id, lost: Object.freeze(lost.sort()) }));
  }
  endpoints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({ endpoints: Object.freeze(endpoints), changes: Object.freeze(changes) });
}
