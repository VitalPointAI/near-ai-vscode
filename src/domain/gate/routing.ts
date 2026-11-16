// The routing table of the policy bundle (CLAS-05, D-30, D-37, D-47): which tier of model a label's level may be sent to. Pure: no I/O, no clock, no vscode,
// no package. This file holds the table, its shipped default and its parser, then the decision that reads it: which tier a mark needs (D-47: strictest wins)
// and whether one client, endpoint and model satisfy that tier, judged from local facts only before anything is sent (D-36, D-37).
// Strictness only goes one way: a handling flag, a compartment or a level can raise the tier, and the strictest of them wins when the decision is made.
// A label can never relax a tier (D-47); only your organization changing the bundle's table does.
import { LOOPBACK_HOSTS } from '../config';
import type { Mark } from './dominance';
import { LABEL_TOKEN_PATTERN, labelKey } from './labels';
import type { Label, ScaleTable } from './labels';
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

function stricter(a: RoutingTier, b: RoutingTier): RoutingTier {
  return TIER_ORDER[b] > TIER_ORDER[a] ? b : a;
}

function tableTier(table: Readonly<Record<string, RoutingTier>>, key: string): RoutingTier | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * The tier one label needs: its level's tier, made stricter by a compartment entry and by an entry for any of its handling flags that the table lists.
 * Nothing here can relax a tier (D-47). A level the table does not list is `deny`, so an unknown label can only narrow where content may go.
 * `no-agent-tools` is not a routing key and never changes a tier.
 */
export function tierForLabel(label: Label, routing: RoutingTable): RoutingTier {
  let tier: RoutingTier = tableTier(routing.levels, labelKey(label)) ?? 'deny';
  for (const compartment of label.compartments) {
    const entry = tableTier(routing.compartments, compartment);
    if (entry !== undefined) tier = stricter(tier, entry);
  }
  for (const flag of ROUTING_HANDLING_FLAGS) {
    const entry = routing.handling[flag];
    if (entry !== undefined && label.handling.includes(flag)) tier = stricter(tier, entry);
  }
  return tier;
}

/**
 * The strictest tier over every label of the mark, in the order any-cloud, attested-cloud, local-only, deny. The answer does not depend on the order of
 * the labels. A session starts at the project's default label, so a mark is never empty; an empty mark given anyway takes `defaultLabel`'s tier when the
 * caller supplies it and is `deny` otherwise, because nothing is known about what the chat has read.
 */
export function tierForMark(mark: Mark, routing: RoutingTable, defaultLabel?: Label): RoutingTier {
  if (mark.length === 0) return defaultLabel === undefined ? 'deny' : tierForLabel(defaultLabel, routing);
  let tier: RoutingTier = 'any-cloud';
  for (const label of mark) tier = stricter(tier, tierForLabel(label, routing));
  return tier;
}

/** The hostname of an endpoint given as a URL or as a bare host (with or without a port), lowercase, in the form URL.hostname uses; undefined when unreadable. */
function hostnameOf(host: string): string | undefined {
  const text = host.trim();
  if (text === '') return undefined;
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether an endpoint counts as this machine or a host your organization names (D-37): a loopback host, or one matching an entry of `localHosts`
 * (an exact host, or `*.example.com` for any host below example.com). A host that cannot be read is not local.
 */
export function isLocalRouteHost(host: string, localHosts: readonly HostPattern[]): boolean {
  const name = hostnameOf(host);
  if (name === undefined) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  return localHosts.some((pattern) => (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern));
}

/** The facts of one request that routing can know before sending, none of them a network call (D-36). */
export interface RouteFacts {
  /** The client the run sends through: NEAR AI Cloud, a local runtime, or not said. */
  readonly clientRoute: 'near' | 'local' | undefined;
  /** The client's endpoint, as a URL or a host. */
  readonly host: string;
  /** Whether the endpoint is NEAR AI Cloud's own, where a TEE model's attestation can be checked. */
  readonly nearEndpoint: boolean;
  /** The cached catalog entry of the model. Absent when the model is unknown or the catalog has not loaded, which counts as not private. */
  readonly model: { readonly id: string; readonly privacyBoundary?: string } | undefined;
  /** True when this session already saw an attestation fail. */
  readonly attestationFailed: boolean;
}

export const ROUTE_RULES = Object.freeze([
  'route.any-cloud',
  'route.attested-cloud',
  'route.local-only',
  'route.deny',
  'route.no-local-model',
  'route.local-host-not-local',
  'route.not-tee',
  'route.attestation-failed',
  'route.no-session'
] as const);
export type RouteRule = (typeof ROUTE_RULES)[number];
export type RefusingRouteRule = Exclude<RouteRule, 'route.any-cloud' | 'route.attested-cloud' | 'route.local-only'>;

/** One plain sentence per refusing rule: nothing was sent, and what to do about it. */
export const ROUTE_REFUSALS: Readonly<Record<RefusingRouteRule, string>> = Object.freeze({
  'route.deny': 'Nothing was sent. Your organization\'s rules do not let content at this label go to any model. Start a new chat that has not read this content, or ask your organization\'s security officer about the routing table.',
  'route.no-local-model': 'Nothing was sent. This chat has read content that may only go to a model running on this computer, and the model for this request is not one. Add a local model and run again, or start a new chat that has not read this content.',
  'route.local-host-not-local': 'Nothing was sent. Your local runtime points at a host that is not on this computer and that your organization has not named as local, so it cannot count as local. Point the runtime at this computer, or ask your organization to name the host as local.',
  'route.not-tee': 'Nothing was sent. This chat has read content that may only go to a model running in private hardware on NEAR AI Cloud\'s own endpoint, and this model or endpoint is not confirmed to do that. Choose a private model on NEAR AI Cloud or a local model, or start a new chat that has not read this content.',
  'route.attestation-failed': 'Nothing was sent. The private hardware check on NEAR AI Cloud failed earlier in this session, so its models cannot count as private now. Switch to a local model, or try again in a new session.',
  'route.no-session': 'Nothing was sent. This request did not say which route it uses, so no model can be confirmed private. Start the run again from the chat, or choose a local model.'
});

export interface RouteDecision {
  readonly allowed: boolean;
  /** The tier the mark needs. */
  readonly tier: RoutingTier;
  readonly rule: RouteRule;
  /** Present exactly when the request is refused. */
  readonly reason?: string;
}

function allow(tier: RoutingTier, rule: RouteRule): RouteDecision {
  return { allowed: true, tier, rule };
}

function refuse(tier: RoutingTier, rule: RefusingRouteRule): RouteDecision {
  return { allowed: false, tier, rule, reason: ROUTE_REFUSALS[rule] };
}

/** `undefined` when a local client, on a local host, serves a model the catalog marks local; otherwise the rule that says which part fails. */
function whyNotLocal(facts: RouteFacts, routing: RoutingTable): 'route.no-local-model' | 'route.local-host-not-local' | undefined {
  if (facts.clientRoute !== 'local') return 'route.no-local-model';
  if (!isLocalRouteHost(facts.host, routing.localHosts)) return 'route.local-host-not-local';
  return facts.model?.privacyBoundary === 'local' ? undefined : 'route.no-local-model';
}

function decideAttested(tier: RoutingTier, routing: RoutingTable, facts: RouteFacts): RouteDecision {
  // A local model on a local host is stricter than attested cloud, so it satisfies this tier too.
  if (whyNotLocal(facts, routing) === undefined) return allow(tier, 'route.attested-cloud');
  if (facts.clientRoute === 'local') {
    return refuse(tier, isLocalRouteHost(facts.host, routing.localHosts) ? 'route.not-tee' : 'route.local-host-not-local');
  }
  // Judged before sending (D-36): the TEE flag and NEAR's own endpoint, because a forwarded model cannot be attested.
  if (facts.model?.privacyBoundary !== 'tee' || !facts.nearEndpoint) return refuse(tier, 'route.not-tee');
  if (facts.attestationFailed) return refuse(tier, 'route.attestation-failed');
  return allow(tier, 'route.attested-cloud');
}

/**
 * Whether a request may go, from the session's mark, the bundle's routing table and the local facts of the request (CLAS-05, CLAS-06, D-30, D-36, D-37).
 * `deny` refuses. `local-only` needs a local client on a loopback host or a host the table names, serving a model the catalog marks local. `attested-cloud`
 * needs a TEE model on NEAR AI Cloud's own endpoint with no failed attestation this session, or a local model as above. `any-cloud` allows everything.
 * An unknown model counts as not private for every tier above any-cloud. A refusal always carries a plain sentence that says nothing was sent.
 */
export function decideRoute(mark: Mark, routing: RoutingTable, facts: RouteFacts, defaultLabel?: Label): RouteDecision {
  const tier = tierForMark(mark, routing, defaultLabel);
  if (tier === 'any-cloud') return allow(tier, 'route.any-cloud');
  if (tier === 'deny') return refuse(tier, 'route.deny');
  if (facts.clientRoute === undefined) return refuse(tier, 'route.no-session');
  if (tier === 'local-only') {
    const why = whyNotLocal(facts, routing);
    return why === undefined ? allow(tier, 'route.local-only') : refuse(tier, why);
  }
  return decideAttested(tier, routing, facts);
}
