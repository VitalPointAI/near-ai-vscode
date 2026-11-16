// The routing table of the policy bundle (CLAS-05, D-30, D-37, D-47): which tier of model a label's level may be sent to. Pure: no I/O, no clock, no vscode,
// no package. This file holds the table, its shipped default and its parser; the decision that reads the table is a later plan.
// Strictness only goes one way: a handling flag, a compartment or a level can raise the tier, and the strictest of them wins when the decision is made.
// A label can never relax a tier (D-47); only your organization changing the bundle's table does.
import { LABEL_TOKEN_PATTERN } from './labels';
import type { ScaleTable } from './labels';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';
import { parseHostPattern } from './vocabulary';
import type { HostPattern } from './vocabulary';

/** Where a model request may go. `deny` sends nowhere. */
export const ROUTING_TIERS = Object.freeze(['any-cloud', 'attested-cloud', 'local-only', 'deny'] as const);
export type RoutingTier = (typeof ROUTING_TIERS)[number];

/** Strictness, lowest first: a higher number is stricter, and `deny` is the strictest. */
export const TIER_ORDER: Readonly<Record<RoutingTier, number>> = Object.freeze({ 'any-cloud': 0, 'attested-cloud': 1, 'local-only': 2, deny: 3 });

/**
 * The handling flags that choose a tier. This is a subset of HANDLING_FLAGS: `no-agent-tools` refuses agent tools for the content and never chooses a tier,
 * so it has no entry in a routing table.
 */
export const ROUTING_HANDLING_FLAGS = Object.freeze(['local-only'] as const);
export type RoutingHandlingFlag = (typeof ROUTING_HANDLING_FLAGS)[number];

export interface RoutingTable {
  /** Keyed `scale/level`, one entry for every level of every scale the bundle declares. */
  readonly levels: Readonly<Record<string, RoutingTier>>;
  readonly handling: Readonly<Partial<Record<RoutingHandlingFlag, RoutingTier>>>;
  /** Keyed by compartment token. Empty means no compartment changes a tier. */
  readonly compartments: Readonly<Record<string, RoutingTier>>;
  /** Hosts your organization names as local for `local-only` (D-37). Empty by default: only a loopback runtime counts. */
  readonly localHosts: readonly HostPattern[];
}

/** The CLAS-05 defaults. Protected B stays local-only because no CCCS Medium assessment of NEAR AI Cloud was found (D-30). */
export const DEFAULT_ROUTING: RoutingTable = Object.freeze({
  levels: Object.freeze({
    'org/Public': 'any-cloud',
    'org/Internal': 'attested-cloud',
    'org/Confidential': 'attested-cloud',
    'org/Restricted': 'local-only',
    'ca-protected/Protected A': 'attested-cloud',
    'ca-protected/Protected B': 'local-only',
    'ca-protected/Protected C': 'local-only',
    'ca-classified/Confidential': 'local-only',
    'ca-classified/Secret': 'local-only',
    'ca-classified/Top Secret': 'local-only',
    'nato/NATO Unclassified': 'attested-cloud',
    'nato/NATO Restricted': 'local-only',
    'nato/NATO Confidential': 'local-only',
    'nato/NATO Secret': 'local-only',
    'nato/Cosmic Top Secret': 'local-only'
  } as const),
  handling: Object.freeze({ 'local-only': 'local-only' } as const),
  compartments: Object.freeze({}),
  localHosts: Object.freeze([])
});

const MAX_LOCAL_HOSTS = 64;

function parseTier(value: unknown, path: string): Parsed<RoutingTier> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = ROUTING_TIERS.find((tier) => tier === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

/** Every `scale/level` key a table over these scales must have. */
function expectedLevelKeys(scales: ScaleTable): string[] {
  const keys: string[] = [];
  for (const id of Object.keys(scales)) {
    const scale = scales[id];
    if (scale !== undefined) for (const level of scale.levels) keys.push(`${id}/${level}`);
  }
  return keys;
}

function parseLevels(value: unknown, scales: ScaleTable, path: string): Parsed<Record<string, RoutingTier>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const expected = expectedLevelKeys(scales);
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) return refused('unknown-field', childPath(path, key.slice(0, 40)));
  }
  const out: Record<string, RoutingTier> = {};
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return refused('missing-field', childPath(path, key));
    const tier = parseTier(ownValue(value, key), childPath(path, key));
    if (!tier.ok) return tier;
    out[key] = tier.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseHandling(value: unknown, path: string): Parsed<Partial<Record<RoutingHandlingFlag, RoutingTier>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Partial<Record<RoutingHandlingFlag, RoutingTier>> = {};
  for (const key of Object.keys(value)) {
    const flag = ROUTING_HANDLING_FLAGS.find((candidate) => candidate === key);
    if (flag === undefined) return refused('unknown-field', childPath(path, key.slice(0, 40)));
    const tier = parseTier(ownValue(value, key), childPath(path, key));
    if (!tier.ok) return tier;
    out[flag] = tier.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseCompartments(value: unknown, path: string): Parsed<Record<string, RoutingTier>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Record<string, RoutingTier> = {};
  for (const key of Object.keys(value)) {
    if (!LABEL_TOKEN_PATTERN.test(key)) return refused('wrong-type', childPath(path, key.slice(0, 40)));
    const tier = parseTier(ownValue(value, key), childPath(path, key));
    if (!tier.ok) return tier;
    out[key] = tier.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseLocalHosts(value: unknown, path: string): Parsed<readonly HostPattern[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_LOCAL_HOSTS) return refused('not-allowed-here', path);
  const out: HostPattern[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const host = parseHostPattern(value[index], where, 'ceiling');
    if (!host.ok) return host;
    // A lone * would call every host local, which is the opposite of what local-only is for.
    if (host.value === '*') return refused('not-allowed-here', where);
    if (out.includes(host.value)) return refused('duplicate', where);
    out.push(host.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/**
 * Parses a routing table against the scales it will be used with. Unknown tiers, unknown keys, a level without an entry and a handling key outside
 * ROUTING_HANDLING_FLAGS (`no-agent-tools`, `attested-cloud-ok` or anything else) are each refused, so no level can fall through to an unknown tier.
 */
export function parseRouting(value: unknown, scales: ScaleTable, path = ''): Parsed<RoutingTable> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['levels', 'handling', 'compartments', 'localHosts']);
  if (keys !== undefined) return keys;
  const levels = parseLevels(ownValue(value, 'levels'), scales, childPath(path, 'levels'));
  if (!levels.ok) return levels;
  const handling = parseHandling(ownValue(value, 'handling'), childPath(path, 'handling'));
  if (!handling.ok) return handling;
  const compartments = parseCompartments(ownValue(value, 'compartments'), childPath(path, 'compartments'));
  if (!compartments.ok) return compartments;
  const localHosts = parseLocalHosts(ownValue(value, 'localHosts'), childPath(path, 'localHosts'));
  if (!localHosts.ok) return localHosts;
  return { ok: true, value: Object.freeze({ levels: levels.value, handling: handling.value, compartments: compartments.value, localHosts: localHosts.value }) };
}
