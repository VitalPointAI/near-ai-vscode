// The routing table of the policy bundle (CLAS-05, D-30, D-37, D-47): which tier of model a label's level may be sent to. Pure: no I/O, no clock, no vscode,
// no package. This file holds the table, its shipped default and its parser, then the decision that reads it: which tier a mark needs (D-47: strictest wins)
// and whether one client, endpoint and model satisfy that tier, judged from local facts only before anything is sent (D-36, D-37).
// Strictness only goes one way: a handling flag, a compartment or a level can raise the tier, and the strictest of them wins when the decision is made.
// A label can never relax a tier (D-47); only your organization changing the bundle's table does.
// The policy steps (Phase 41, FND-03 to FND-06) read endpoints.ts, authorizations.ts, residency.ts, models.ts and dominance.ts. Their functions are called
// only inside decideRoute, never at module load, so the cycles through endpoints.ts, sections.ts and bundle.ts stay safe at load.
import { isLoopbackHost } from '../config';
import { authorizationCovers } from './authorizations';
import type { AuthorizationBody, AuthorizationKind, AuthorizationQuestion } from './authorizations';
import { markDominated, meetClearance } from './dominance';
import type { Mark } from './dominance';
import { classMayHold, endpointCeilingAllows, findEndpoint, needsEndpointAuthorization } from './endpoints';
import type { EndpointClass, EndpointRegion, PolicyEndpoint } from './endpoints';
import { LABEL_TOKEN_PATTERN, labelKey } from './labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from './labels';
import type { ModelsSection, UseTier } from './models';
import { PASSPORT_GAP_TEXT, SHIPPED_REPORT_MODELS, alternativesFor, authorizationRecord, passportStep, whoToAsk } from './passportStep';
import type { CandidateModel, PassportGapId, PassportStepResult } from './passportStep';
import type { ObservedFacts } from './passportState';
import { residencyAllows } from './residency';
import type { ResidencySection } from './sections';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';
import { raiseUseTier, useTierFor } from './useTier';
import type { UseInput } from './useTier';
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

/**
 * The CLAS-05 defaults. Protected B stays local-only because no CCCS Medium assessment of NEAR AI Cloud was found (D-30). The reserved export compartments
 * CGP, EAR and ITAR are local-only (Phase 41 D-62).
 */
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
  // The starting rules keep content marked Controlled goods (Canada), ITAR or US export-controlled (EAR) on this computer (Phase 41 D-62). A fresh install
  // and the renewal of unedited starting rules get these; a policy someone edited is never changed in place.
  compartments: Object.freeze({ CGP: 'local-only', EAR: 'local-only', ITAR: 'local-only' } as const),
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
  const tier = tableTierForLabel(label, routing);
  // Owner rule (coherence review S1 and S2, PR #143 review): no cloud is accredited for classified work today, so a level that must stay on this computer is
  // at least local-only whatever the policy's table says. Every check that reads a tier (routing, network calls at a mark, records) sees the same floor.
  return isThisComputerOnly(label) ? stricter(tier, 'local-only') : tier;
}

/** The tier the policy's own table gives one label, before the this-computer rule: used only to say why a classified request was kept here. */
function tableTierForLabel(label: Label, routing: RoutingTable): RoutingTier {
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

/**
 * The label of a mark that needs the strictest tier, the first such label when several do: the one a refusal for the mark names and every label event
 * records as its target. A label whose tier cannot be read counts as deny. Undefined only for an empty mark.
 */
export function strictestLabelOf(mark: Mark, routing: RoutingTable): Label | undefined {
  let best: Label | undefined;
  let bestTier = -1;
  for (const label of mark) {
    let tier: number;
    try { tier = TIER_ORDER[tierForLabel(label, routing)]; } catch { tier = TIER_ORDER.deny; }
    if (tier > bestTier) { best = label; bestTier = tier; }
  }
  return best;
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
 * Whether an endpoint counts as this machine or a host your organization names (D-37): a loopback host (localhost, 127.0.0.1, [::1], exactly), or one
 * matching an entry of `localHosts` (an exact host, or `*.example.com` for any host below example.com), compared in lowercase. The host is the URL parser's
 * own, so a userinfo trick names the host after the `@`, and a trailing dot or another loopback address (127.0.0.2) is not local. A host that cannot be read
 * is not local.
 */
export function isLocalRouteHost(host: string, localHosts: readonly HostPattern[]): boolean {
  const name = hostnameOf(host);
  if (name === undefined) return false;
  if (isLoopbackHost(name)) return true;
  // Both sides in lowercase: the URL parser lowercases the endpoint's host, so a name the policy writes in capitals means the same host (D-37).
  return localHosts.some((given) => {
    const pattern = given.toLowerCase();
    return pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern;
  });
}

/**
 * The levels whose content never leaves this computer, whatever host the policy names as local, and that belong only on an accredited system: Protected C,
 * every Canadian classified level, and NATO Confidential and above (coherence review S1 and S2). Keyed `scale/level` on the shipped scales, whose ids and
 * level names never change in place. A level on any other scale is judged by its routing tier alone.
 */
export const THIS_COMPUTER_ONLY_LEVELS: readonly string[] = Object.freeze([
  'ca-protected/Protected C',
  'ca-classified/Confidential',
  'ca-classified/Secret',
  'ca-classified/Top Secret',
  'nato/NATO Confidential',
  'nato/NATO Secret',
  'nato/Cosmic Top Secret'
]);

/** True when the label's level is one of THIS_COMPUTER_ONLY_LEVELS. */
export function isThisComputerOnly(label: { readonly scale: string; readonly level: string }): boolean {
  return THIS_COMPUTER_ONLY_LEVELS.includes(labelKey(label));
}

/** The first label of the mark (or the default label, for an empty mark) whose level is one of THIS_COMPUTER_ONLY_LEVELS; undefined when none is. */
export function thisComputerOnlyLabelOf(mark: Mark, defaultLabel?: Label): Label | undefined {
  const labels: readonly Label[] = mark.length === 0 && defaultLabel !== undefined ? [defaultLabel] : mark;
  return labels.find((label) => isThisComputerOnly(label));
}

/** How an endpoint matches the local hosts: this computer, an exact entry, only a `*.` pattern entry, or nothing. */
export type LocalHostMatch = 'loopback' | 'exact' | 'pattern' | 'none';

/** Like isLocalRouteHost, but says how the host matched, so a stricter level can refuse a pattern match. An exact entry wins over a pattern. */
export function localHostMatch(host: string, localHosts: readonly HostPattern[]): LocalHostMatch {
  const name = hostnameOf(host);
  if (name === undefined) return 'none';
  if (isLoopbackHost(name)) return 'loopback';
  const patterns = localHosts.map((given) => given.toLowerCase());
  if (patterns.some((pattern) => !pattern.startsWith('*.') && name === pattern)) return 'exact';
  return patterns.some((pattern) => pattern.startsWith('*.') && name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1) ? 'pattern' : 'none';
}

/** True only for an endpoint written as an https URL. A bare host says nothing about its scheme, so it is not https (fail closed). */
export function usesHttps(host: string): boolean {
  const text = host.trim();
  if (!/^https:\/\//i.test(text)) return false;
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The local-hosts entries that are `*.` patterns: from this version they no longer count as local for local-only levels (coherence review S1). */
export function patternLocalHosts(routing: Pick<RoutingTable, 'localHosts'>): readonly string[] {
  return routing.localHosts.filter((entry) => entry.startsWith('*.'));
}

/**
 * The one notice a policy whose local hosts hold a `*.` pattern gets (coherence review S1): what changed, and how to fix the entry. Shown, never recorded, so
 * it may name the entries.
 */
export function localHostPatternNotice(patterns: readonly string[]): string {
  const named = patterns.slice(0, 5).join(', ');
  return `Your policy names ${named} as local. From this version, content at a local-only level (Protected B, org Restricted and NATO Restricted by default) goes to a host other than this computer only when the policy names that exact host and the runtime uses https, and Protected C, classified and NATO Confidential and above never leave this computer. To keep using a host, replace the pattern with its exact name in the policy's local hosts (in SovAI: Policy, choose Edit my rules).`;
}

/** What a chat says once, and the record keeps, when classified work runs on a computer not recorded as accredited (coherence review S2). */
export function notAccreditedText(shownLabel: string): string {
  return `This computer is not recorded as accredited for ${shownLabel}. Nothing stops you yet; your organization may require an accredited system.`;
}

/**
 * Whether the connection a request would use is proven to end inside NEAR AI Cloud's private hardware (CLAS-05 as the owner amplified it, D-50). `bound`
 * is the only state that lets content at an attested-cloud level go to NEAR AI Cloud, and only while fresh; every other state, and no fact at all, keeps
 * that content on this computer.
 */
export const CONNECTION_BINDING_STATES = Object.freeze(['bound', 'not-bound', 'unavailable', 'unknown'] as const);
export type ConnectionBindingState = (typeof CONNECTION_BINDING_STATES)[number];

/** What a binding source last found for one host. Read from memory at decision time, never fetched by a decision (OFFL-01). */
export interface ConnectionBindingFact {
  readonly state: ConnectionBindingState;
  /** The host the fact is about, as a URL or a host. A fact about another host never counts for this one. */
  readonly host: string;
  /** When the binding was checked, in epoch milliseconds. */
  readonly checkedAt?: number;
  /** The fingerprint of the bound key; present only when bound. Never written to a decision record. */
  readonly fingerprint?: string;
  /** A plain diagnostic, never shown as the refusal. */
  readonly detail?: string;
}

/** A bound fact older than this (10 minutes) no longer counts: the connection has to be proven again. */
export const BINDING_MAX_AGE_MS = 600_000;

/** True only for a bound fact with both times known and an age from zero up to, not including, BINDING_MAX_AGE_MS. No fact or no clock is never fresh. */
export function isBindingFresh(fact: ConnectionBindingFact | undefined, now: number | undefined): boolean {
  if (fact === undefined || fact.state !== 'bound') return false;
  if (typeof now !== 'number' || !Number.isFinite(now)) return false;
  if (typeof fact.checkedAt !== 'number' || !Number.isFinite(fact.checkedAt)) return false;
  const age = now - fact.checkedAt;
  return age >= 0 && age < BINDING_MAX_AGE_MS;
}

/** Why a request at an attested-cloud level was not sent to NEAR AI Cloud: `unknown` covers no fact, an unknown fact, a stale one and one for another host. */
export type BindingRefusalCause = 'not-bound' | 'unavailable' | 'unknown';

/** One plain sentence per cause. Each says nothing was sent and that content at this level stays on this computer. */
export const BINDING_REFUSALS: Readonly<Record<BindingRefusalCause, string>> = Object.freeze({
  'not-bound': 'Nothing was sent. The connection to NEAR AI Cloud could not be proven to end inside its private hardware, so content at this level stays on this computer.',
  unavailable: 'Nothing was sent. The check that the connection to NEAR AI Cloud ends inside its private hardware could not be made, so content at this level stays on this computer.',
  unknown: 'Nothing was sent. There is no recent proof that the connection to NEAR AI Cloud ends inside its private hardware. SovAI checks the connection in the background, so try again in a moment; until then, content at this level stays on this computer.'
});

/**
 * What the connection check for attested-cloud levels proves (CLAS-05 as the owner amplified it, CLAS-07). SECURITY.md carries it word for word, and a test
 * keeps the two equal.
 */
export const CONNECTION_BINDING_TEXT = 'Content at a level that needs an attested cloud goes to NEAR AI Cloud only when NEAR AI Cloud\'s attestation shows that the connection ends inside the private enclave: the enclave\'s attestation must name the certificate the server presents, and the connection that carries your request must present that certificate. When this cannot be shown, content at those levels stays on this computer, and a request with no model on this computer is refused.';

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
  /** The connection binding fact for the client's host, read from memory. Absent counts as unknown, never as bound (D-50). */
  readonly binding?: ConnectionBindingFact;
  /** The time of the decision in epoch milliseconds. Absent means no binding is fresh. */
  readonly now?: number;
  /** Whether the session can use a local model instead. Absent means no, so the refusal names the missing local model. */
  readonly localModelAvailable?: boolean;
  /** True when the request ran outside any session route and was decided with the default one: an allowed answer is then `route.default-session`. */
  readonly sessionless?: boolean;
  /**
   * The use tier of the request (useTierFor, 41-05). The passport step checks an absent use as T1; an authorization whose `scope.uses` is a list covers
   * nothing when it is absent (D-54).
   */
  readonly use?: UseTier;
  /**
   * The local facts the use was worked out from (74.1 D-13), the session's mark included. The passport step raises `use` once more by the policy's own
   * `tierByLevel` and `tierByProject`, which only the decision has and which can only raise it.
   */
  readonly useInput?: UseInput;
  /** The SHA-256 of the weights the place reports for this model, when it reports one (an attested or measured hash; 74.1 D-11 `artifact-mismatch`). */
  readonly observedArtifact?: string;
  /** The client's catalogue (74.1 D-14): a passport refusal names the ones decideRoute would allow instead. Absent: nothing is said about other models. */
  readonly candidates?: readonly CandidateModel[];
  /**
   * What was observed about the model behind the passport with this hash (74.1 D-15): the place first seen for it, the place now, and the triggers the
   * trigger log has fired for it. Read by the passport step only for that same passport. Absent: nothing observed, and the passport decides alone.
   */
  readonly observed?: ObservedFacts & { readonly passportHash: string };
  /** Team Mode's `allowedModels` (D-37): when given, a request for a model whose id is not listed is refused, with or without a policy. */
  readonly allowedModels?: readonly string[];
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
  'route.no-session',
  'route.default-session',
  'route.connection-not-bound',
  'route.local-host-not-exact',
  'route.this-computer-only',
  // Phase 41 (D-36, D-51): moved here from ROUTE_RULES_NAMED_AHEAD as decideRoute's policy steps reach each one, sentence unchanged.
  'route.model-not-allowed',
  'route.endpoint-unknown',
  'route.endpoint-ceiling',
  'route.endpoint-pin',
  'route.authorization-missing',
  'route.accredited-device',
  'route.residency',
  'route.clearance',
  // Phase 74.1 (D-11): the passport step refuses under `models.mode: enforce`; its reason is the gap's own sentence (passportStep.ts).
  'route.passport'
] as const);
export type RouteRule = (typeof ROUTE_RULES)[number];
export type RefusingRouteRule = Exclude<RouteRule, 'route.any-cloud' | 'route.attested-cloud' | 'route.local-only' | 'route.default-session'>;

/**
 * Events about a session's routing that are recorded but decide nothing themselves: the answer check after a response at an attested-cloud level, and a
 * person's Check again that clears a failed one (plan 25), and classified work running on a computer not recorded as accredited (coherence review S2,
 * recorded once per chat, refusing nothing yet), and a re-evaluation trigger that ended a model's approval (74.1 D-15, recorded once per passport hash and
 * trigger). Named now so a record written by a later version is never one this version cannot name (D-49).
 */
export const ROUTE_EVENT_IDS = Object.freeze(['route.attestation-checked', 'route.attestation-cleared', 'route.not-accredited', 'route.passport-triggered'] as const);
export type RouteEventId = (typeof ROUTE_EVENT_IDS)[number];

/** One plain sentence per refusing rule: nothing was sent, and what to do about it. */
export const ROUTE_REFUSALS: Readonly<Record<RefusingRouteRule, string>> = Object.freeze({
  'route.deny': 'Nothing was sent. Your organization\'s rules do not let content at this label go to any model. If what this chat read allows it, lower its label with SovAI: Lower This Chat\'s Label, or ask your organization\'s security officer about the routing table.',
  'route.no-local-model': 'Nothing was sent. This chat has read content that may only go to a model running on this computer, and the model for this request is not one. Add a local model and run again, or, if what this chat read allows it, use SovAI: Lower This Chat\'s Label.',
  'route.local-host-not-local': 'Nothing was sent. Your local runtime points at a host that is not on this computer and that your organization has not named as local, so it cannot count as local. Point the runtime at this computer, ask your organization to name the host as local, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.not-tee': 'Nothing was sent. This chat has read content that may only go to a model running in private hardware on NEAR AI Cloud\'s own endpoint, and this model or endpoint is not confirmed to do that. Choose a private model on NEAR AI Cloud or a local model, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.attestation-failed': 'Nothing was sent. The private hardware check of an earlier answer in this chat failed, so NEAR AI Cloud\'s models cannot count as private for this chat now. Use Check again under that answer, switch to a local model, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.no-session': 'Nothing was sent. This request did not say which route it uses, so no model can be confirmed private. Start the run again from the chat, choose a local model, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.connection-not-bound': 'Nothing was sent. Content at this level may go to NEAR AI Cloud only over a connection proven to end inside its private hardware, and this connection is not proven, so it stays on this computer. Choose a local model for this chat, or use SovAI: Lower This Chat\'s Label if what it read allows it.',
  'route.local-host-not-exact': 'Nothing was sent. From this version, content at this level goes to a host other than this computer only when your organization\'s policy names that exact host, not a *. pattern, and the runtime uses https. Name the exact host in the policy, use https, run the model on this computer, or use SovAI: Lower This Chat\'s Label if what it read allows it.',
  'route.this-computer-only': 'Nothing was sent. This chat has read content at Protected C, a classified level or NATO Confidential or above, which never leaves this computer: no cloud and no other host is accredited for it, whatever your organization\'s policy names. Run the model on this computer, or use SovAI: Lower This Chat\'s Label if what it read allows it.',
  'route.model-not-allowed': 'Nothing was sent. This model is not allowed for this work. Choose one of the models allowed for this work, or ask whoever manages those settings to allow this one.',
  'route.endpoint-unknown': 'Nothing was sent. This AI service is not one your organization\'s rules list as a place this chat\'s content may go. Choose a service your rules list or a model on this computer, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.endpoint-ceiling': 'Nothing was sent. Your organization\'s rules do not allow content at this chat\'s label on this AI service. Choose a service your rules allow for this label or a model on this computer, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.endpoint-pin': 'Nothing was sent. Content at this level may go to this AI service only over a connection whose certificate your organization\'s rules name, or one proven to end in private hardware, and this connection is neither. Use a model on this computer, ask your organization to name the certificate, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.authorization-missing': 'Nothing was sent. Content at this level may go to this AI service only with a signed approval from a person your organization names, and no approval covers this service. Ask your organization\'s security contact for one, use a model on this computer, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.accredited-device': 'Nothing was sent. Your organization\'s rules allow content at this level only on a computer recorded as accredited, and this computer is not. Use an accredited computer, ask your organization\'s security contact about this one, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.residency': 'Nothing was sent. Your organization\'s rules keep this content in the regions they name, and this AI service is not shown to run there. Choose a service in one of those regions or a model on this computer, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  'route.clearance': 'Nothing was sent. This chat\'s label is above what you are cleared for. Ask your organization\'s security contact about your clearance, or use SovAI: Lower This Chat\'s Label if what this chat read allows it.',
  // The sentence of a passport refusal with no gap (a check that could not be made); a refusal with a gap says the gap's own sentence (PASSPORT_GAP_TEXT).
  'route.passport': 'Nothing was sent. Your organization has not approved this model for this use. Choose a model your organization approved for this work, or ask your organization\'s security contact to review this one.'
});

/**
 * Route rules Phase 41 names before anything can return them (D-10, D-49, D-51). A rule enters ROUTE_RULES only when decideRoute can reach it, because
 * gateRouting checks that every ROUTE_RULES id is reached; so the new ids wait here, with their sentences, and every record id list already knows them.
 * Plan 41-10 moves each into ROUTE_RULES and ROUTE_REFUSALS, sentence unchanged, as decideRoute starts to return it; Phase 74.1 moved `route.passport`
 * (D-11). `route.export-control` stays here until Phase 45, which gives the export-control step its behaviour (D-63). No id is on this list and another
 * route list at once.
 */
export const ROUTE_RULES_NAMED_AHEAD = Object.freeze([
  'route.export-control'
] as const);
export type NamedAheadRouteRule = (typeof ROUTE_RULES_NAMED_AHEAD)[number];

/** One plain sentence per named-ahead rule, in ROUTE_REFUSALS' form: nothing was sent, why, and what to do. */
export const ROUTE_REFUSALS_NAMED_AHEAD: Readonly<Record<NamedAheadRouteRule, string>> = Object.freeze({
  'route.export-control': 'Nothing was sent. This content is marked Controlled goods (Canada), ITAR or US export-controlled (EAR), and your organization has not approved this AI service, or you sending it there, for that marking. Use a model on this computer, or ask your organization\'s export-control contact.'
});

/**
 * The reason of a request to a place your rules list over https that was made over plain http (WR-03). It is recorded under route.endpoint-pin, the rule
 * for a connection that is not the one your rules require.
 */
export const ENDPOINT_SCHEME_TEXT = 'Nothing was sent. Your organization\'s rules list this AI service for https connections only, and this connection uses plain http. Point the runtime at the service\'s https address, or use a model on this computer.';

/** The reason of a request whose route could not be worked out (a mark that cannot be read, a routing table that throws): refused, never guessed. */
export const ROUTE_CHECK_FAILED_TEXT = 'Nothing was sent. The route for this request could not be worked out, so it was refused rather than guessed. Try again; if it keeps happening, reload the window, or open SovAI: Policy to see whether your policy needs attention.';

/** An authorization body that verifyAuthorization accepted against its one key source (D-15); decideRoute reads bodies only. */
export interface VerifiedAuthorization {
  readonly body: AuthorizationBody;
  /** True when it verified against this device's own key because no organization layer exists: every screen then says "self-signed on this computer". */
  readonly selfSigned: boolean;
}

/**
 * The effective policy's inputs to decideRoute's policy steps (FND-03 to FND-06), passed by the caller already parsed and verified. Nothing here is fetched
 * at decision time.
 */
export interface RoutePolicy {
  /** The one list of places AI may run (D-24). */
  readonly endpoints: readonly PolicyEndpoint[];
  readonly authorizations: readonly VerifiedAuthorization[];
  /** Absent: no residency rule (D-33). */
  readonly residency?: ResidencySection;
  /** Absent: report mode with the shipped passports (provenance O1, 74.1 D-12). */
  readonly models?: ModelsSection;
  readonly scales: ScaleTable;
  readonly mappings: readonly ScaleMapping[];
  /** The personal layer's clearances. */
  readonly clearances: readonly Clearance[];
  /** The roster's clearances for the project (33.1). Absent: the clearance step does nothing (D-53). */
  readonly rosterClearances?: readonly Clearance[];
  /** True when an organization layer is present. */
  readonly organization: boolean;
  /** The agents section's switch (D-34); it refuses only together with `organization`. */
  readonly requireAccreditedDevice: boolean;
  /** This device's id, the subject an accredited-device authorization names. */
  readonly deviceId?: string;
  /** The project of the request (74.1 D-13); absent outside a folder, where an authorization scoped to projects covers nothing (D-54). */
  readonly project?: string;
  /** Your organization's security contact, named in every passport refusal (74.1 D-11); absent: the generic words. */
  readonly contact?: { readonly name: string; readonly how: string };
  /** Epoch milliseconds, for authorizations and passports. */
  readonly now: number;
}

/**
 * Where a request goes: a listed entry, or an implicit place with no id (this computer, NEAR AI Cloud's own endpoint, or a model forwarded from a listed
 * private-hardware entry, CR-02). Only a listed entry, or the entry a forwarded model was asked of, adds a ceiling.
 */
export interface RouteEndpoint {
  readonly id?: string;
  readonly class: EndpointClass;
  readonly region: EndpointRegion;
  readonly provider?: string;
  readonly implicit: boolean;
  readonly tlsPins: readonly string[];
}

/** What let a request go (D-38): the routing table for a label, a named person's authorization, or a model approval. */
export type AllowingRecord =
  | { readonly kind: 'routing'; readonly label: string }
  | {
    readonly kind: 'authorization';
    readonly authorizationKind: AuthorizationKind;
    readonly id: string;
    readonly name: string;
    readonly expiresAt: string;
    readonly selfSigned: boolean;
    /** The `scale/level` key the authorization was checked for; absent when it was checked for the whole mark (a residency exception). */
    readonly label?: string;
    /** A t1-risk exception's evidence text, recorded where your organization's evaluation would be (74.1 D-16); today it holds the mission benefit, not an assessment reference (G537). */
    readonly evidence?: string;
  }
  | { readonly kind: 'model-approval'; readonly passport: string; readonly maxTier: UseTier; readonly expiresAt: string };

/** The rules report mode records instead of refusing (D-34, D-42). */
export type ReportedRouteRule = 'route.accredited-device' | 'route.passport';

/** What a route.passport refusal tells the chat (74.1 D-22): the use, the label keys and place in words, the ways forward the gate found. */
export interface PassportRefusal {
  readonly model: string;
  readonly use: UseTier;
  readonly labels: readonly string[];
  readonly place?: string;
  readonly alternatives?: readonly string[];
  readonly whoToAsk: string;
  readonly organization: boolean;
}

export interface RouteDecision {
  readonly allowed: boolean;
  /** The tier the mark needs. */
  readonly tier: RoutingTier;
  readonly rule: RouteRule;
  /** Present exactly when the request is refused. */
  readonly reason?: string;
  /** With a policy: where the request goes. Absent for an unlisted host at any-cloud. */
  readonly endpoint?: RouteEndpoint;
  /** With a policy, on an allowed request: what let it go, the routing table's record first. */
  readonly allowedBy?: readonly AllowingRecord[];
  /** With a policy: the report-only rules that would have refused, sorted; absent when none would. */
  readonly wouldRefuse?: readonly ReportedRouteRule[];
  /** The label S2's notice names when this computer is not recorded as accredited for it (D-34). */
  readonly notAccredited?: Label;
  /** The TLS pins the send must hold the connection to (an org-plain place carrying a level that needs a pin, D-26). */
  readonly pinTo?: readonly string[];
  /** With a policy: the use the passport step checked (74.1 D-13, D-23). */
  readonly useTier?: UseTier;
  /** On a route.passport refusal (74.1 D-22): the facts the chat's empty-state card reads. Undefined alternatives: not worked out. */
  readonly passportRefusal?: PassportRefusal;
  /** With a policy: the passport that decided the request, by id and hash, when the model has one (D-23). */
  readonly passport?: { readonly id: string; readonly hash: string };
  /** Why the passport did not cover the request: the refusal's reason under enforce, the report's under report (D-11, D-12). */
  readonly passportGap?: PassportGapId;
}

/** The decision for a request whose route could not be worked out: deny, under the fixed rule route.deny, with ROUTE_CHECK_FAILED_TEXT. */
export function routeCheckFailed(): RouteDecision {
  return { allowed: false, tier: 'deny', rule: 'route.deny', reason: ROUTE_CHECK_FAILED_TEXT };
}

function allow(tier: RoutingTier, rule: RouteRule, facts?: RouteFacts): RouteDecision {
  return { allowed: true, tier, rule: facts?.sessionless === true ? 'route.default-session' : rule };
}

function refuse(tier: RoutingTier, rule: RefusingRouteRule): RouteDecision {
  return { allowed: false, tier, rule, reason: ROUTE_REFUSALS[rule] };
}

/**
 * How strictly a host must be local: `named` takes any local-hosts entry (attested-cloud levels, as before); `exact-https` takes a non-loopback host only
 * through an exact entry and over https (local-only levels, coherence review S1); `this-computer` takes loopback only (THIS_COMPUTER_ONLY_LEVELS).
 */
type LocalStrictness = 'named' | 'exact-https' | 'this-computer';

type NotLocalRule = 'route.no-local-model' | 'route.local-host-not-local' | 'route.local-host-not-exact' | 'route.this-computer-only';

/** `undefined` when a local client, on a host local enough for the level, serves a model the catalog marks local; otherwise the rule that says which part fails. */
function whyNotLocal(facts: RouteFacts, routing: RoutingTable, strictness: LocalStrictness = 'named'): NotLocalRule | undefined {
  if (facts.clientRoute !== 'local') return 'route.no-local-model';
  const match = localHostMatch(facts.host, routing.localHosts);
  if (match !== 'loopback') {
    if (strictness === 'this-computer') return 'route.this-computer-only';
    if (match === 'none') return 'route.local-host-not-local';
    if (strictness === 'exact-https' && (match !== 'exact' || !usesHttps(facts.host))) return 'route.local-host-not-exact';
  }
  return facts.model?.privacyBoundary === 'local' ? undefined : 'route.no-local-model';
}

/** The cause a binding fact gives for not sending: its own state when it says not-bound or unavailable, otherwise unknown (none, unknown, stale, another host). */
function bindingCause(facts: RouteFacts): BindingRefusalCause {
  const fact = facts.binding;
  if (fact === undefined || !sameHost(fact.host, facts.host)) return 'unknown';
  if (fact.state === 'not-bound' || fact.state === 'unavailable') return fact.state;
  return 'unknown';
}

function sameHost(a: string, b: string): boolean {
  const first = hostnameOf(a);
  return first !== undefined && first === hostnameOf(b);
}

/** The cause's sentence, then the rule's sentence without its own opening "Nothing was sent.", so the reason says it once. */
export function bindingReason(cause: BindingRefusalCause, rule: 'route.connection-not-bound' | 'route.no-local-model'): string {
  return `${BINDING_REFUSALS[cause]} ${ROUTE_REFUSALS[rule].replace(/^Nothing was sent\. /, '')}`;
}

function decideAttested(tier: RoutingTier, routing: RoutingTable, facts: RouteFacts, privateFloor = false): RouteDecision {
  // A local model on a local host is stricter than attested cloud, so it satisfies this tier too. Under the private floor (PR #143 review) a host other than
  // this computer counts only as S1's Protected B rule allows: an exact local-hosts entry over https, never a *. pattern or plain http.
  const why = whyNotLocal(facts, routing, privateFloor ? 'exact-https' : 'named');
  if (why === undefined) return allow(tier, 'route.attested-cloud', facts);
  if (facts.clientRoute === 'local') {
    if (why === 'route.local-host-not-exact') return refuse(tier, why);
    return refuse(tier, isLocalRouteHost(facts.host, routing.localHosts) ? 'route.not-tee' : 'route.local-host-not-local');
  }
  // Judged before sending (D-36): the TEE flag and NEAR's own endpoint, because a forwarded model cannot be attested.
  if (facts.model?.privacyBoundary !== 'tee' || !facts.nearEndpoint) return refuse(tier, 'route.not-tee');
  if (facts.attestationFailed) return refuse(tier, 'route.attestation-failed');
  // The owner's CLAS-05 amplification (D-50): a verified answer proves which model ran, not that the connection was private. Without a fresh bound fact for
  // this host the content stays on this computer; no fact, an unknown one and a stale one are never treated as bound.
  if (isBindingFresh(facts.binding, facts.now) && facts.binding !== undefined && sameHost(facts.binding.host, facts.host)) return allow(tier, 'route.attested-cloud', facts);
  const rule = facts.localModelAvailable === true ? 'route.connection-not-bound' : 'route.no-local-model';
  return { allowed: false, tier, rule, reason: bindingReason(bindingCause(facts), rule) };
}

/**
 * Whether a request may go, from the session's mark, the bundle's routing table and the local facts of the request (CLAS-05, CLAS-06, D-30, D-36, D-37).
 * `deny` refuses. `local-only` needs a local client serving a model the catalog marks local, on a loopback host, or on a host the table names exactly and
 * reached over https; a mark holding one of THIS_COMPUTER_ONLY_LEVELS needs a loopback host (coherence review S1). `attested-cloud`
 * needs a TEE model on NEAR AI Cloud's own endpoint with no failed attestation this session and a fresh bound connection fact for that host (D-50), or a
 * local model as above. `any-cloud` allows everything. An unknown model counts as not private for every tier above any-cloud. A refusal always carries a
 * plain sentence that says nothing was sent. An allowed request decided outside any session (`facts.sessionless`) is `route.default-session`. `floor`
 * raises the tier to at least that tier (attested-cloud for a private member or team, or nearAi.privacyMode tee-only), so a model counts as private only
 * when the same check the labels use passed (coherence review S4).
 */
export function decideRoute(mark: Mark, routing: RoutingTable, facts: RouteFacts, defaultLabel?: Label, floor?: RoutingTier, policy?: RoutePolicy): RouteDecision {
  const decision = decideByTable(mark, routing, facts, defaultLabel, floor);
  // A refusal of the safety patch's checks stands as it is, its words included (the private floor's among them); no policy step can widen it.
  if (!decision.allowed) return decision;
  // Step 0 (D-37): Team Mode's allowed models, with or without a policy. An unknown model is on no list.
  if (facts.allowedModels !== undefined && (facts.model === undefined || !facts.allowedModels.includes(facts.model.id))) return refuse(decision.tier, 'route.model-not-allowed');
  return policy === undefined ? decision : decidePolicySteps(decision, mark, routing, facts, defaultLabel, policy, floor);
}

/** The safety patch's decision: the tier from the table and the floor, the local and attested checks, and the this-computer and floor sentences. */
function decideByTable(mark: Mark, routing: RoutingTable, facts: RouteFacts, defaultLabel: Label | undefined, floor: RoutingTier | undefined): RouteDecision {
  const marked = tierForMark(mark, routing, defaultLabel);
  // A floor (a private member or team, or nearAi.privacyMode tee-only) only ever raises the tier, never lowers it (coherence review S4).
  const tier = floor === undefined ? marked : stricter(marked, floor);
  const privateFloor = floor !== undefined && TIER_ORDER[floor] >= TIER_ORDER['attested-cloud'];
  const decision = decideAtTier(tier, mark, routing, facts, defaultLabel, privateFloor);
  // A this-computer-only level the policy's own table would have sent to a cloud: the refusal says it never leaves this computer, not that a model is missing.
  const kept = thisComputerOnlyLabelOf(mark, defaultLabel);
  if (!decision.allowed && kept !== undefined && decision.rule === 'route.no-local-model' && TIER_ORDER[tableTierForLabel(kept, routing)] < TIER_ORDER['local-only']) {
    return refuse(decision.tier, 'route.this-computer-only');
  }
  if (decision.allowed || tier === marked || decision.reason === undefined) return decision;
  return { ...decision, reason: `Nothing was sent. ${PRIVATE_FLOOR_TEXT} ${decision.reason.replace(/^Nothing was sent\. /, '')}` };
}

/** A listed entry and the place it gives, or an implicit place with no entry. `listed` is the entry the host matched, whose ceiling and scheme apply. */
interface Place {
  readonly endpoint: RouteEndpoint;
  readonly listed?: PolicyEndpoint;
}

/**
 * CR-02: whether a model runs in the private hardware a listed entry names. NEAR AI's private hardware runs only the models NEAR AI's catalog marks TEE;
 * every other model there is forwarded to an outside provider. Your organization's or a vendor's private hardware runs a model its catalog marks TEE or one
 * the runtime serves itself (`local`). An unknown model runs in none.
 */
function runsInEntryHardware(entryClass: EndpointClass, model: RouteFacts['model']): boolean {
  const boundary = model?.privacyBoundary;
  if (entryClass === 'nearai-tee') return boundary === 'tee';
  if (entryClass === 'org-tee' || entryClass === 'vendor-tee') return boundary === 'tee' || boundary === 'local';
  return true;
}

function placeOf(facts: Pick<RouteFacts, 'host' | 'nearEndpoint' | 'model'>, endpoints: readonly PolicyEndpoint[]): Place | undefined {
  const found = findEndpoint(endpoints, facts.host);
  if (found.kind === 'listed') {
    const entry = found.endpoint;
    // CR-02: a model that does not run in the entry's private hardware is forwarded: no region (so no residency rule is met), no id (so no authorization
    // or residency exception naming the entry covers it), and no pin. The entry's ceiling still applies, with a forwarding service's limits.
    if (!runsInEntryHardware(entry.class, facts.model)) return { endpoint: implicitPlace('forwarded'), listed: entry };
    const endpoint: RouteEndpoint = entry.provider === undefined
      ? { id: entry.id, class: entry.class, region: entry.region, implicit: false, tlsPins: entry.tlsPins }
      : { id: entry.id, class: entry.class, region: entry.region, provider: entry.provider, implicit: false, tlsPins: entry.tlsPins };
    return { endpoint: Object.freeze(endpoint), listed: entry };
  }
  if (found.kind === 'this-computer') return { endpoint: implicitPlace('local') };
  // NEAR AI Cloud's own endpoint with no entry: its private hardware for a model the catalog marks TEE, otherwise a model NEAR AI forwards elsewhere.
  if (facts.nearEndpoint) return { endpoint: implicitPlace(facts.model?.privacyBoundary === 'tee' ? 'nearai-tee' : 'forwarded') };
  return undefined;
}

function implicitPlace(placeClass: EndpointClass): RouteEndpoint {
  return Object.freeze({ class: placeClass, region: 'unstated', implicit: true, tlsPins: Object.freeze([]) });
}

/**
 * Where a request goes (D-24): the entry findEndpoint gives for its host (an exact host first, then a `*.` pattern), or forwarded for a model that does not
 * run in a listed entry's private hardware (CR-02); this computer for a loopback host no entry names; NEAR AI Cloud's own endpoint with no entry as its
 * private hardware for a TEE model and as forwarded for any other; otherwise undefined.
 */
export function endpointOf(facts: Pick<RouteFacts, 'host' | 'nearEndpoint' | 'model'>, endpoints: readonly PolicyEndpoint[]): RouteEndpoint | undefined {
  return placeOf(facts, endpoints)?.endpoint;
}

/**
 * The policy steps, run only on a request the safety patch's checks allowed, in the order of D-36: the place (route.endpoint-unknown), its ceiling
 * (route.endpoint-ceiling), https to a listed place and a pin or binding (route.endpoint-pin), an authorization (route.authorization-missing), an accredited
 * device (route.accredited-device, reported unless your organization turns refusal on), residency (route.residency), the passport (route.passport, refused
 * under `models.mode: enforce` and reported otherwise, 74.1 D-11, D-12) and clearance (route.clearance). The first refusing step decides; a step that only
 * reports never hides a later refusal, and never refuses even when its check throws (WR-05); under enforce a passport check that throws refuses. The private floor (S4) is part of the safety patch's checks, so its refusal comes first and keeps its words.
 */
function decidePolicySteps(decision: RouteDecision, mark: Mark, routing: RoutingTable, facts: RouteFacts, defaultLabel: Label | undefined, policy: RoutePolicy, floor: RoutingTier | undefined): RouteDecision {
  const labels: readonly Label[] = mark.length === 0 ? (defaultLabel === undefined ? [] : [defaultLabel]) : mark;
  const strictest = strictestLabelOf(mark, routing) ?? defaultLabel;
  const allowedBy: AllowingRecord[] = strictest === undefined ? [] : [Object.freeze({ kind: 'routing' as const, label: labelKey(strictest) })];
  const place = placeOf(facts, policy.endpoints);
  const endpoint = place?.endpoint;
  // Step 1: a place your rules do not name. Above any-cloud every request needs one.
  if (endpoint === undefined && decision.tier !== 'any-cloud') return refuse(decision.tier, 'route.endpoint-unknown');
  // Step 2: a listed entry's ceiling holds every label of the mark, and the place's own class may hold it (a model forwarded from a private-hardware entry
  // takes a forwarding service's limits, CR-02); an implicit place adds none.
  const listed = place?.listed;
  if (listed !== undefined && endpoint !== undefined
    && !labels.every((label) => endpointCeilingAllows(listed, label, policy.scales) && classMayHold(endpoint.class, label, policy.scales))) {
    return refuse(decision.tier, 'route.endpoint-ceiling');
  }
  // Step 2b (WR-03): a place your rules list is reached only over https, at every level; this computer is not on the network, so a local entry is not.
  if (listed !== undefined && listed.class !== 'local' && !usesHttps(facts.host)) return { allowed: false, tier: decision.tier, rule: 'route.endpoint-pin', reason: ENDPOINT_SCHEME_TEXT };
  const local = endpoint?.class === 'local';
  const use = facts.use?.toLowerCase();
  // The levels that need a pinned or proven connection and a named authorization off this computer (D-26, D-52): Protected B, and the other local-only
  // levels except org Restricted and those that never leave this computer.
  const needing = labels.filter((label) => needsEndpointAuthorization(labelKey(label), routing));
  // Step 1 again for those levels: even at any-cloud, a place your rules do not name cannot carry them.
  if (endpoint === undefined && needing.length > 0) return refuse(decision.tier, 'route.endpoint-unknown');
  let pinTo: readonly string[] | undefined;
  if (endpoint !== undefined && !local && needing.length > 0) {
    // Step 3 (T-41-100): your organization's plain server only over a pinned connection, which the send holds it to; private hardware only over a fresh
    // connection proven for this host. A vendor region, a forwarding service and a closed API have no pin rule (D-26 names none).
    if (endpoint.class === 'org-plain') {
      if (endpoint.tlsPins.length === 0) return refuse(decision.tier, 'route.endpoint-pin');
      pinTo = endpoint.tlsPins;
    } else if (BOUND_CLASSES.includes(endpoint.class) && !freshBindingFor(facts)) {
      return refuse(decision.tier, 'route.endpoint-pin');
    }
    // Step 4 (T-41-102): a protected-b authorization naming this place's id, for each such label, project and use. A place with no id cannot be named.
    const id = endpoint.id;
    if (id === undefined) return refuse(decision.tier, 'route.authorization-missing');
    for (const label of needing) {
      const key = labelKey(label);
      const found = covering(policy, { kind: 'protected-b', subject: { endpoint: id }, project: policy.project, label: key, use });
      if (found.length === 0) return refuse(decision.tier, 'route.authorization-missing');
      for (const record of found) addRecord(allowedBy, authorizationRecord(record, key));
    }
  }
  // Step 5 (D-34): a this-computer-only level (only this computer reaches here) on a device no accredited-device authorization names is reported, and
  // refused only when your organization's layer is present and turns the switch on. A check that cannot be made covers nothing (WR-05).
  const wouldRefuse = new Set<ReportedRouteRule>();
  let notAccredited: Label | undefined;
  const device = accreditedDevice(policy, labels, use);
  for (const record of device.records) addRecord(allowedBy, record);
  if (device.missing !== undefined) {
    if (policy.organization && policy.requireAccreditedDevice) return refuse(decision.tier, 'route.accredited-device');
    wouldRefuse.add('route.accredited-device');
    notAccredited = device.missing;
  }
  // Step 6 (D-33, T-41-101): residency for every place but this computer; a host no entry names (only at any-cloud) counts as unstated.
  if (!local) {
    const residency = residencyAllows({ endpoint, labels, residency: policy.residency, authorizations: policy.authorizations, project: policy.project, use, now: policy.now });
    if (!residency.ok) return refuse(decision.tier, 'route.residency');
    if (residency.exception !== undefined) addRecord(allowedBy, authorizationRecord(residency.exception));
  }
  // Step 7 (D-42, 74.1 D-11 to D-16): the model's passport for the request's use, the use raised by the policy's own tables; its state (revoked, a fired
  // trigger) and your organization's evaluation decided in passportStep. No place counts as a closed API, the widest class. A policy with no models
  // section runs report mode with the shipped passports. A gap refuses under enforce and is reported under report; a check that throws refuses under
  // enforce (fail closed) and is reported under report (WR-05).
  const models = policy.models ?? SHIPPED_REPORT_MODELS;
  let enforce = false;
  let passport: PassportStepResult;
  let checked: UseTier | undefined;
  try {
    enforce = models.mode === 'enforce';
    checked = facts.useInput === undefined ? facts.use ?? 'T1' : raiseUseTier(facts.use ?? 'T1', useTierFor(facts.useInput, models));
    passport = passportStep(models, {
      modelId: facts.model?.id ?? '', use: checked, labelKeys: keysOf(labels), authorizations: policy.authorizations, now: policy.now,
      whoToAsk: whoToAsk(policy.contact, policy.organization),
      ...(endpoint === undefined ? {} : { place: { class: endpoint.class, region: endpoint.region, ...(endpoint.provider === undefined ? {} : { provider: endpoint.provider }) } }),
      ...(policy.project === undefined ? {} : { project: policy.project }),
      ...(facts.observedArtifact === undefined ? {} : { observedArtifact: facts.observedArtifact }),
      ...(facts.observed === undefined ? {} : { observed: facts.observed })
    });
  } catch {
    passport = { covers: false, records: [] };
  }
  const passportFacts = passportFactsOf(passport, checked);
  if (!passport.covers) {
    if (enforce) {
      // D-14: the models that would go instead, each decided the same way; they decide nothing and are never sent to.
      const candidates = facts.candidates;
      const alternatives = candidates === undefined ? undefined : alternativesFor(candidates, facts.model?.id ?? '', (model) => decideRoute(mark, routing, { ...facts, model, candidates: undefined, observed: firedOnly(facts.observed) }, defaultLabel, floor, policy), models.order);
      const details = passport.details === undefined ? undefined : { ...passport.details, ...(alternatives === undefined ? {} : { alternatives }) };
      const reason = passport.gap === undefined || details === undefined ? ROUTE_REFUSALS['route.passport'] : PASSPORT_GAP_TEXT[passport.gap](details);
      const refusal: PassportRefusal = {
        model: facts.model?.id ?? '', use: checked ?? 'T1', labels: keysOf(labels).filter((key): key is string => key !== undefined), whoToAsk: whoToAsk(policy.contact, policy.organization),
        organization: policy.organization, ...(details?.place === undefined ? {} : { place: details.place }), ...(alternatives === undefined ? {} : { alternatives })
      };
      return { allowed: false, tier: decision.tier, rule: 'route.passport', reason, ...(endpoint === undefined ? {} : { endpoint }), ...passportFacts, passportRefusal: Object.freeze(refusal) };
    }
    wouldRefuse.add('route.passport');
  }
  for (const record of passport.records) addRecord(allowedBy, record);
  // Step 8 (D-35, D-53): clearance, only with a roster clearance. The personal clearance alone already decided every read that raised the mark.
  if (policy.rosterClearances !== undefined) {
    const effective = effectiveClearances(policy.clearances, policy.rosterClearances, policy.scales, policy.mappings);
    if (!markDominated(effective, labels, { scales: policy.scales, mappings: policy.mappings, now: policy.now })) return refuse(decision.tier, 'route.clearance');
  }
  const out: { -readonly [K in keyof RouteDecision]: RouteDecision[K] } = { ...decision };
  if (endpoint !== undefined) out.endpoint = endpoint;
  out.allowedBy = Object.freeze(allowedBy);
  if (wouldRefuse.size > 0) out.wouldRefuse = Object.freeze([...wouldRefuse].sort());
  if (notAccredited !== undefined) out.notAccredited = notAccredited;
  if (pinTo !== undefined) out.pinTo = pinTo;
  return { ...out, ...passportFacts };
}

/** What another model's decision may read of this request's observations: only the triggers fired for a passport, never this model's place (74.1 D-15). */
function firedOnly(observed: RouteFacts['observed']): RouteFacts['observed'] {
  return observed === undefined ? undefined : { passportHash: observed.passportHash, ...(observed.fired === undefined ? {} : { fired: observed.fired }) };
}

/** The passport facts a decision carries for its record (74.1 D-23): the use checked, the passport by id and hash, and the gap. */
function passportFactsOf(step: PassportStepResult, use: UseTier | undefined): Pick<RouteDecision, 'useTier' | 'passport' | 'passportGap'> {
  return {
    ...(use === undefined ? {} : { useTier: use }),
    ...(step.resolved === undefined ? {} : { passport: Object.freeze({ id: step.resolved.passport.id, hash: step.resolved.hash }) }),
    ...(step.gap === undefined ? {} : { passportGap: step.gap })
  };
}

/** What the accredited-device step found: the records of the authorizations that cover this device, and the first label none covers. */
interface AccreditedDeviceStep {
  readonly records: readonly AllowingRecord[];
  readonly missing?: Label;
}

/**
 * The accredited-device check of step 5 (D-34) for each this-computer-only label of the mark. A label whose check throws (an unreadable device id, label or
 * authorization) is covered by nothing, so it is reported, or refused where your organization turns refusal on, and never thrown past the step (WR-05).
 */
function accreditedDevice(policy: RoutePolicy, labels: readonly Label[], use: string | undefined): AccreditedDeviceStep {
  const records: AllowingRecord[] = [];
  let missing: Label | undefined;
  for (const label of labels) {
    try {
      if (!isThisComputerOnly(label)) continue;
      const key = labelKey(label);
      const device = policy.deviceId;
      const found = device === undefined ? [] : covering(policy, { kind: 'accredited-device', subject: { device }, project: policy.project, label: key, use });
      if (found.length > 0) {
        records.push(...found.map((record) => authorizationRecord(record, key)));
        continue;
      }
    } catch { /* covered by nothing: reported below */ }
    missing ??= label;
  }
  return missing === undefined ? { records } : { records, missing };
}

/** The `scale/level` keys an authorization is asked about: one per label, or a single question with no label for a mark with none. */
function keysOf(labels: readonly Label[]): ReadonlyArray<string | undefined> {
  return labels.length === 0 ? [undefined] : labels.map((label) => labelKey(label));
}

/**
 * The effective clearance (D-35): the personal clearances alone when no roster is given; otherwise every defined meet of a personal and a roster
 * clearance, so the roster can only narrow what the person declared. Two clearances with no meet give nothing.
 */
export function effectiveClearances(personal: readonly Clearance[], roster: readonly Clearance[] | undefined, scales: ScaleTable, mappings: readonly ScaleMapping[]): readonly Clearance[] {
  if (roster === undefined) return personal;
  const out: Clearance[] = [];
  for (const mine of personal) {
    for (const theirs of roster) {
      const met = meetClearance(mine, theirs, scales, mappings);
      if (met !== undefined) out.push(met);
    }
  }
  return Object.freeze(out);
}

/** The classes whose connection must be proven bound to private hardware before a level that needs it goes there (D-26). */
const BOUND_CLASSES: readonly EndpointClass[] = Object.freeze(['nearai-tee', 'org-tee', 'vendor-tee'] as const);

/** A fresh bound connection fact for the request's own host (the safety patch's test, D-50). */
function freshBindingFor(facts: RouteFacts): boolean {
  return isBindingFresh(facts.binding, facts.now) && facts.binding !== undefined && sameHost(facts.binding.host, facts.host);
}

/**
 * The verified authorizations that cover the question now; each verified against its one key source before it got here (D-15). One that cannot be read
 * covers nothing, so it can never widen a decision.
 */
function covering(policy: RoutePolicy, question: AuthorizationQuestion): readonly VerifiedAuthorization[] {
  return policy.authorizations.filter((candidate) => {
    try {
      return authorizationCovers(candidate.body, question, policy.now);
    } catch {
      return false;
    }
  });
}

/** Adds a record once: an authorization by kind, id and label, any other record by its fields. */
function addRecord(records: AllowingRecord[], record: AllowingRecord): void {
  const key = JSON.stringify(record);
  if (!records.some((existing) => JSON.stringify(existing) === key)) records.push(record);
}

/** Said first in a refusal that only the private floor caused: why a request at a lower label still needed the check. */
export const PRIVATE_FLOOR_TEXT = 'This run may use only verified private hardware or this computer (a private team or member, or nearAi.privacyMode set to tee-only), and that check did not pass.';

function decideAtTier(tier: RoutingTier, mark: Mark, routing: RoutingTable, facts: RouteFacts, defaultLabel: Label | undefined, privateFloor: boolean): RouteDecision {
  if (tier === 'any-cloud') return allow(tier, 'route.any-cloud', facts);
  if (tier === 'deny') return refuse(tier, 'route.deny');
  if (facts.clientRoute === undefined) return refuse(tier, 'route.no-session');
  if (tier === 'local-only') {
    const why = whyNotLocal(facts, routing, thisComputerOnlyLabelOf(mark, defaultLabel) === undefined ? 'exact-https' : 'this-computer');
    return why === undefined ? allow(tier, 'route.local-only', facts) : refuse(tier, why);
  }
  return decideAttested(tier, routing, facts, privateFloor);
}

/**
 * The routing a failed-closed policy uses (D-53): the shipped table with every tier stricter than any-cloud raised to at least local-only, and no host named
 * as local. A broken policy never relaxes where content goes and never sends labelled content off this computer; content at the default label still goes
 * where it does today.
 */
export function routingWhileFailedClosed(): RoutingTable {
  return FAILED_CLOSED_ROUTING;
}

function raisedAboveAnyCloud(tier: RoutingTier): RoutingTier {
  return tier === 'any-cloud' ? tier : stricter(tier, 'local-only');
}

const FAILED_CLOSED_ROUTING: RoutingTable = (() => {
  const levels: Record<string, RoutingTier> = {};
  for (const key of Object.keys(DEFAULT_ROUTING.levels)) {
    const tier = tableTier(DEFAULT_ROUTING.levels, key);
    if (tier !== undefined) levels[key] = raisedAboveAnyCloud(tier);
  }
  const handling: Partial<Record<RoutingHandlingFlag, RoutingTier>> = {};
  for (const flag of ROUTING_HANDLING_FLAGS) {
    const tier = DEFAULT_ROUTING.handling[flag];
    if (tier !== undefined) handling[flag] = raisedAboveAnyCloud(tier);
  }
  const compartments: Record<string, RoutingTier> = {};
  for (const key of Object.keys(DEFAULT_ROUTING.compartments)) {
    const tier = tableTier(DEFAULT_ROUTING.compartments, key);
    if (tier !== undefined) compartments[key] = raisedAboveAnyCloud(tier);
  }
  return Object.freeze({ levels: Object.freeze(levels), handling: Object.freeze(handling), compartments: Object.freeze(compartments), localHosts: Object.freeze([]) });
})();
