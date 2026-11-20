// The sections of policy bundle v2 that hold today's v1 fields and the small Phase 41 sections (FND-02, FND-05, Phase 41 D-04, D-05, D-08, D-28, D-33, D-34,
// D-60, D-63). Pure: no I/O, no clock, no vscode, no package.
// Every section is an object with its own `v: 1`; another number is `unknown-version` at `<section>.v`, which reads as "update the extension". Keys are exact
// (checkKeys), values are read as own properties and never spread, every result is frozen, and set-like lists are sorted and unique so two documents that
// mean the same thing hash the same. Optional keys with a stated default are filled, so a parsed section is its own v2 wire form.
// Imported values are used only inside functions, never at module load, so a later cycle through routing.ts stays safe.
import type { ActionPolicyMode } from '../policy';
import {
  MAX_ANCHOR_ROOTS, MAX_MAPPINGS, MAX_STATUS_LISTS, mappingKey, parseAnchorRoot, parseContexts, parseList, parseMaxMode, parseMaxOfflineAge,
  parseMcpLabelCeilings, parseScales, parseServerIds, parseSetList, parseStatusList
} from './bundle';
import type { AnchorRoot, GateContextName, StatusListRef } from './bundle';
import { parseLabel, parseMapping } from './labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from './labels';
import { parseRouting } from './routing';
import type { RoutingTable } from './routing';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed, Refusal } from './shape';
import type { CapabilityVerb } from './vocabulary';

export const SECTION_VERSION = 1;

/** The section's `v`: 1, another number `unknown-version` (update the extension), anything else `wrong-type`. Undefined when it is 1. */
export function checkSectionVersion(value: Fields, path: string): Refusal | undefined {
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== SECTION_VERSION) return refused('unknown-version', childPath(path, 'v'));
  return v === SECTION_VERSION ? undefined : refused('wrong-type', childPath(path, 'v'));
}

/** The opening every section parser shares: an object, `v` read before the keys (so a newer section with new keys says "update"), then the exact keys. */
export function openSection(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Parsed<Fields> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== SECTION_VERSION) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v', ...required], optional) ?? checkSectionVersion(value, path);
  return keys ?? { ok: true, value };
}

export function has(value: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// labels (labels@1): scales, mappings, the default label and the routing table without localHosts (D-04; localHosts became endpoints, D-27)

/** The routing table of a v2 document: today's table without `localHosts`, whose entries are endpoints now. */
export type LabelsRouting = Omit<RoutingTable, 'localHosts'>;

export interface LabelsSection {
  readonly v: 1;
  readonly scales: ScaleTable;
  readonly mappings: readonly ScaleMapping[];
  readonly defaultLabel: Label;
  readonly routing: LabelsRouting;
}

/** labels: every key required, read with the v1 rules. Its scales feed every other section, so the document reads it first. */
export function parseLabelsSection(value: unknown, path = 'labels'): Parsed<LabelsSection> {
  const section = openSection(value, path, ['scales', 'mappings', 'defaultLabel', 'routing']);
  if (!section.ok) return section;
  const opened = section.value;
  const scales = parseScales(ownValue(opened, 'scales'), childPath(path, 'scales'));
  if (!scales.ok) return scales;
  const mappings = parseSetList(
    ownValue(opened, 'mappings'), childPath(path, 'mappings'), MAX_MAPPINGS, (item, where) => parseMapping(item, scales.value, where), mappingKey
  );
  if (!mappings.ok) return mappings;
  const defaultLabel = parseLabel(ownValue(opened, 'defaultLabel'), scales.value, childPath(path, 'defaultLabel'));
  if (!defaultLabel.ok) return defaultLabel;
  const routingPath = childPath(path, 'routing');
  const routingValue = ownValue(opened, 'routing');
  if (!isRecord(routingValue)) return refused('wrong-type', routingPath);
  const routingKeys = checkKeys(routingValue, routingPath, ['levels', 'handling', 'compartments']);
  if (routingKeys !== undefined) return routingKeys;
  // Rebuilt from own values with no local hosts, so the v1 table parser reads exactly these three keys and nothing a prototype could add.
  const rebuilt = { levels: ownValue(routingValue, 'levels'), handling: ownValue(routingValue, 'handling'), compartments: ownValue(routingValue, 'compartments'), localHosts: [] };
  const routing = parseRouting(rebuilt, scales.value, routingPath);
  if (!routing.ok) return routing;
  return {
    ok: true,
    value: Object.freeze({
      v: 1,
      scales: scales.value,
      mappings: mappings.value,
      defaultLabel: defaultLabel.value,
      routing: Object.freeze({ levels: routing.value.levels, handling: routing.value.handling, compartments: routing.value.compartments })
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// agents (agents@1): today's ceiling, with the MCP lists under `mcp` and the accredited-device switch (D-04, D-34)

export interface AgentsMcp {
  /** MCP servers allowed in unattended runs, by id (v1 `ceiling.unattendedMcp`). */
  readonly unattended: readonly string[];
  /** v1 `ceiling.mcpLabelCeilings`; absent when the policy names none. */
  readonly labelCeilings?: Readonly<Record<string, Clearance>>;
}

export interface AgentsSection {
  readonly v: 1;
  readonly maxMode: Readonly<Record<GateContextName, ActionPolicyMode>>;
  readonly contexts: Readonly<Partial<Record<CapabilityVerb, readonly GateContextName[]>>>;
  readonly mcp: AgentsMcp;
  /**
   * D-34: refuse classified and Protected C work on a computer with no accredited-device authorization. Only an organization layer's `true` turns
   * refusal on; the default `false` keeps today's report-only behaviour.
   */
  readonly requireAccreditedDevice: boolean;
}

export function parseAgentsSection(value: unknown, scales: ScaleTable, path = 'agents'): Parsed<AgentsSection> {
  const section = openSection(value, path, ['maxMode', 'contexts', 'mcp'], ['requireAccreditedDevice']);
  if (!section.ok) return section;
  const opened = section.value;
  const maxMode = parseMaxMode(ownValue(opened, 'maxMode'), childPath(path, 'maxMode'));
  if (!maxMode.ok) return maxMode;
  const contexts = parseContexts(ownValue(opened, 'contexts'), childPath(path, 'contexts'));
  if (!contexts.ok) return contexts;
  const mcpPath = childPath(path, 'mcp');
  const mcpValue = ownValue(opened, 'mcp');
  if (!isRecord(mcpValue)) return refused('wrong-type', mcpPath);
  const mcpKeys = checkKeys(mcpValue, mcpPath, ['unattended'], ['labelCeilings']);
  if (mcpKeys !== undefined) return mcpKeys;
  const unattended = parseServerIds(ownValue(mcpValue, 'unattended'), childPath(mcpPath, 'unattended'));
  if (!unattended.ok) return unattended;
  let mcp: AgentsMcp = Object.freeze({ unattended: unattended.value });
  if (has(mcpValue, 'labelCeilings')) {
    const ceilings = parseMcpLabelCeilings(ownValue(mcpValue, 'labelCeilings'), scales, childPath(mcpPath, 'labelCeilings'));
    if (!ceilings.ok) return ceilings;
    mcp = Object.freeze({ unattended: unattended.value, labelCeilings: ceilings.value });
  }
  let requireAccreditedDevice = false;
  if (has(opened, 'requireAccreditedDevice')) {
    const flag = ownValue(opened, 'requireAccreditedDevice');
    if (typeof flag !== 'boolean') return refused('wrong-type', childPath(path, 'requireAccreditedDevice'));
    requireAccreditedDevice = flag;
  }
  return { ok: true, value: Object.freeze({ v: 1, maxMode: maxMode.value, contexts: contexts.value, mcp, requireAccreditedDevice }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// reserved (no feature id): today's reserved v1 fields, validated for shape and ignored (D-12 of Phase 70, unchanged meaning)

export interface ReservedSection {
  readonly v: 1;
  readonly anchorRoots: readonly AnchorRoot[];
  readonly statusLists: readonly StatusListRef[];
  readonly maxOfflineAge: Readonly<Record<string, number>>;
}

export function parseReservedSection(value: unknown, scales: ScaleTable, path = 'reserved'): Parsed<ReservedSection> {
  const section = openSection(value, path, ['anchorRoots', 'statusLists', 'maxOfflineAge']);
  if (!section.ok) return section;
  const opened = section.value;
  const anchorRoots = parseList(ownValue(opened, 'anchorRoots'), childPath(path, 'anchorRoots'), MAX_ANCHOR_ROOTS, parseAnchorRoot);
  if (!anchorRoots.ok) return anchorRoots;
  const statusLists = parseList(ownValue(opened, 'statusLists'), childPath(path, 'statusLists'), MAX_STATUS_LISTS, parseStatusList);
  if (!statusLists.ok) return statusLists;
  const maxOfflineAge = parseMaxOfflineAge(ownValue(opened, 'maxOfflineAge'), scales, childPath(path, 'maxOfflineAge'));
  if (!maxOfflineAge.ok) return maxOfflineAge;
  return { ok: true, value: Object.freeze({ v: 1, anchorRoots: anchorRoots.value, statusLists: statusLists.value, maxOfflineAge: maxOfflineAge.value }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// residency (residency@1): the regions content may be sent to, for every request and per label (FND-05, D-33)

/** The regions a residency rule may name. `unstated` is an endpoint region, never a residency one: it satisfies no rule (D-33). */
export const RESIDENCY_REGIONS = Object.freeze(['CA', 'EU', 'US'] as const);
export type ResidencyRegion = (typeof RESIDENCY_REGIONS)[number];

export interface ResidencySection {
  readonly v: 1;
  /** Regions every request must stay in, sorted. Absent means no rule for all requests. */
  readonly required?: readonly ResidencyRegion[];
  /** Per `scale/level` key, the regions content at that level must stay in, sorted. */
  readonly byLevel?: Readonly<Record<string, readonly ResidencyRegion[]>>;
}

const MAX_BY_LEVEL = 256;

function parseRegionList(value: unknown, path: string): Parsed<readonly ResidencyRegion[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length === 0) return refused('empty-list', path);
  const out: ResidencyRegion[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const region = parseChoice(value[index], where, RESIDENCY_REGIONS);
    if (!region.ok) return region;
    const before = out[out.length - 1];
    if (before !== undefined && region.value === before) return refused('duplicate', where);
    if (before !== undefined && region.value < before) return refused('not-sorted', where);
    out.push(region.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function levelKeys(scales: ScaleTable): string[] {
  const keys: string[] = [];
  for (const id of Object.keys(scales)) {
    const scale = scales[id];
    if (scale !== undefined) for (const level of scale.levels) keys.push(`${id}/${level}`);
  }
  return keys;
}

export function parseResidencySection(value: unknown, scales: ScaleTable, path = 'residency'): Parsed<ResidencySection> {
  const section = openSection(value, path, [], ['required', 'byLevel']);
  if (!section.ok) return section;
  const opened = section.value;
  const out: { v: 1; required?: readonly ResidencyRegion[]; byLevel?: Readonly<Record<string, readonly ResidencyRegion[]>> } = { v: 1 };
  if (has(opened, 'required')) {
    const required = parseRegionList(ownValue(opened, 'required'), childPath(path, 'required'));
    if (!required.ok) return required;
    out.required = required.value;
  }
  if (has(opened, 'byLevel')) {
    const byLevelPath = childPath(path, 'byLevel');
    const byLevel = ownValue(opened, 'byLevel');
    if (!isRecord(byLevel)) return refused('wrong-type', byLevelPath);
    const keys = Object.keys(byLevel);
    if (keys.length > MAX_BY_LEVEL) return refused('not-allowed-here', byLevelPath);
    const known = levelKeys(scales);
    const map: Record<string, readonly ResidencyRegion[]> = {};
    for (const key of keys.sort()) {
      if (!known.includes(key)) return refused('unknown-field', childPath(byLevelPath, key.slice(0, 40)));
      const list = parseRegionList(ownValue(byLevel, key), childPath(byLevelPath, key));
      if (!list.ok) return list;
      map[key] = list.value;
    }
    out.byLevel = Object.freeze(map);
  }
  return { ok: true, value: Object.freeze(out) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// onboarding (onboarding@1): who to ask, the answers your organization fixes, the kinds of work offered and discovery (guided onboarding 9.3, D-28, D-63)

/** Who a contact is for. `export-control` is the designated or empowered official's desk (D-63). */
export const CONTACT_TOPICS = Object.freeze(['security', 'privacy', 'contract-security', 'it', 'export-control'] as const);
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** The setup answers your organization may fix. `canada` shows "must stay in Canada" answered; the rule itself is `residency`. */
export const LOCKABLE_ANSWERS = Object.freeze(['canada'] as const);
export type LockableAnswer = (typeof LOCKABLE_ANSWERS)[number];

/** The kinds of work the guided setup offers, in its default order. */
export const KINDS_OF_WORK = Object.freeze(['software', 'staff', 'analysis', 'capital-projects', 'writing'] as const);
export type KindOfWork = (typeof KINDS_OF_WORK)[number];

export interface PolicyContact {
  readonly topic: ContactTopic;
  /** A role or a person, 1 to 64 characters. */
  readonly name: string;
  /** How to reach them: an address, a number or a page, 1 to 200 characters. */
  readonly how: string;
}

export interface DiscoveryNetwork {
  readonly id: string;
  readonly dnsSuffix?: string;
  readonly gateway?: string;
}

export interface ScanRange {
  /** An IPv4 range from /16 to /32. */
  readonly cidr: string;
  /** The listed network the range belongs to; scanning runs only on it. */
  readonly network?: string;
}

export interface DiscoverySection {
  readonly networks: readonly DiscoveryNetwork[];
  /** Listen for servers that announce themselves on listed networks. Defaults to true. */
  readonly announce: boolean;
  readonly scanRanges: readonly ScanRange[];
  /** D-28: when true, a person may approve a found server, which gets maxLabel org/Public only. Defaults to false. */
  readonly personalApprovals: boolean;
}

export interface OnboardingSection {
  readonly v: 1;
  readonly contacts: readonly PolicyContact[];
  readonly locked: Readonly<Partial<Record<LockableAnswer, boolean>>>;
  readonly kindsOfWork: readonly KindOfWork[];
  readonly defaultScale?: string;
  readonly discovery?: DiscoverySection;
}

export const MAX_CONTACTS = 8;
const MAX_CONTACT_NAME = 64;
const MAX_CONTACT_HOW = 200;
const MAX_NETWORKS = 16;
const MAX_SCAN_RANGES = 32;
const NETWORK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const CIDR_PATTERN = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}/(?:1[6-9]|2[0-9]|3[0-2])$`);
const DNS_SUFFIX_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TEXT_CONTROL = /[\u0000-\u001F\u007F]/;

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function parseBoundedText(value: unknown, path: string, max: number): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > max || TEXT_CONTROL.test(value)) return refused('wrong-type', path);
  return { ok: true, value };
}

function parseBoolean(value: unknown, path: string): Parsed<boolean> {
  return typeof value === 'boolean' ? { ok: true, value } : refused('wrong-type', path);
}

function parseContact(value: unknown, path: string): Parsed<PolicyContact> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['topic', 'name', 'how']);
  if (keys !== undefined) return keys;
  const topic = parseChoice(ownValue(value, 'topic'), childPath(path, 'topic'), CONTACT_TOPICS);
  if (!topic.ok) return topic;
  const name = parseBoundedText(ownValue(value, 'name'), childPath(path, 'name'), MAX_CONTACT_NAME);
  if (!name.ok) return name;
  const how = parseBoundedText(ownValue(value, 'how'), childPath(path, 'how'), MAX_CONTACT_HOW);
  if (!how.ok) return how;
  return { ok: true, value: Object.freeze({ topic: topic.value, name: name.value, how: how.value }) };
}

/** onboarding.contacts (and an enrolment file's contacts, 41-03): up to 8 { topic, name, how }, sorted by topic then name, no entry twice. */
export function parseContacts(value: unknown, path = 'contacts'): Parsed<readonly PolicyContact[]> {
  return parseSetList(value, path, MAX_CONTACTS, parseContact, (contact) => JSON.stringify([contact.topic, contact.name]));
}

function parseLocked(value: unknown, path: string): Parsed<Readonly<Partial<Record<LockableAnswer, boolean>>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Partial<Record<LockableAnswer, boolean>> = {};
  for (const key of Object.keys(value)) {
    const answer = LOCKABLE_ANSWERS.find((candidate) => candidate === key);
    if (answer === undefined) return refused('unknown-field', childPath(path, key.slice(0, 40)));
    const flag = parseBoolean(ownValue(value, key), childPath(path, key));
    if (!flag.ok) return flag;
    out[answer] = flag.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

/** kindsOfWork: one to five kinds from KINDS_OF_WORK, in the order the setup should offer them, none twice. */
function parseKindsOfWork(value: unknown, path: string): Parsed<readonly KindOfWork[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length === 0) return refused('empty-list', path);
  if (value.length > KINDS_OF_WORK.length) return refused('not-allowed-here', path);
  const out: KindOfWork[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const kind = parseChoice(value[index], where, KINDS_OF_WORK);
    if (!kind.ok) return kind;
    if (out.includes(kind.value)) return refused('duplicate', where);
    out.push(kind.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseNetwork(value: unknown, path: string): Parsed<DiscoveryNetwork> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id'], ['dnsSuffix', 'gateway']);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !NETWORK_ID_PATTERN.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const out: { id: string; dnsSuffix?: string; gateway?: string } = { id };
  if (has(value, 'dnsSuffix')) {
    const suffix = ownValue(value, 'dnsSuffix');
    if (typeof suffix !== 'string' || !DNS_SUFFIX_PATTERN.test(suffix)) return refused('wrong-type', childPath(path, 'dnsSuffix'));
    out.dnsSuffix = suffix;
  }
  if (has(value, 'gateway')) {
    const gateway = ownValue(value, 'gateway');
    if (typeof gateway !== 'string' || !IPV4_PATTERN.test(gateway)) return refused('wrong-type', childPath(path, 'gateway'));
    out.gateway = gateway;
  }
  // A network is known by its gateway or its DNS suffix; one with neither could be any network.
  if (out.dnsSuffix === undefined && out.gateway === undefined) return refused('missing-field', childPath(path, 'gateway'));
  return { ok: true, value: Object.freeze(out) };
}

function parseScanRange(value: unknown, networks: readonly DiscoveryNetwork[], path: string): Parsed<ScanRange> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['cidr'], ['network']);
  if (keys !== undefined) return keys;
  const cidr = ownValue(value, 'cidr');
  if (typeof cidr !== 'string') return refused('wrong-type', childPath(path, 'cidr'));
  if (!CIDR_PATTERN.test(cidr)) return refused(/\/\d+$/.test(cidr) && IPV4_PATTERN.test(cidr.replace(/\/\d+$/, '')) ? 'not-allowed-here' : 'wrong-type', childPath(path, 'cidr'));
  if (!has(value, 'network')) return { ok: true, value: Object.freeze({ cidr }) };
  const network = ownValue(value, 'network');
  if (typeof network !== 'string') return refused('wrong-type', childPath(path, 'network'));
  if (!networks.some((entry) => entry.id === network)) return refused('not-allowed-here', childPath(path, 'network'));
  return { ok: true, value: Object.freeze({ cidr, network }) };
}

function parseDiscovery(value: unknown, path: string): Parsed<DiscoverySection> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['networks', 'announce', 'scanRanges', 'personalApprovals']);
  if (keys !== undefined) return keys;
  let networks: readonly DiscoveryNetwork[] = Object.freeze([]);
  if (has(value, 'networks')) {
    const parsed = parseSetList(ownValue(value, 'networks'), childPath(path, 'networks'), MAX_NETWORKS, parseNetwork, (network) => network.id);
    if (!parsed.ok) return parsed;
    networks = parsed.value;
  }
  let scanRanges: readonly ScanRange[] = Object.freeze([]);
  if (has(value, 'scanRanges')) {
    const parsed = parseSetList(
      ownValue(value, 'scanRanges'), childPath(path, 'scanRanges'), MAX_SCAN_RANGES, (item, where) => parseScanRange(item, networks, where), (range) => range.cidr
    );
    if (!parsed.ok) return parsed;
    scanRanges = parsed.value;
  }
  let announce = true;
  if (has(value, 'announce')) {
    const parsed = parseBoolean(ownValue(value, 'announce'), childPath(path, 'announce'));
    if (!parsed.ok) return parsed;
    announce = parsed.value;
  }
  let personalApprovals = false;
  if (has(value, 'personalApprovals')) {
    const parsed = parseBoolean(ownValue(value, 'personalApprovals'), childPath(path, 'personalApprovals'));
    if (!parsed.ok) return parsed;
    personalApprovals = parsed.value;
  }
  return { ok: true, value: Object.freeze({ networks, announce, scanRanges, personalApprovals }) };
}

/** onboarding, with contacts [], locked {} and all five kinds of work filled when absent; discovery, when present, with its defaults filled. */
export function parseOnboardingSection(value: unknown, scales: ScaleTable, path = 'onboarding'): Parsed<OnboardingSection> {
  const section = openSection(value, path, [], ['contacts', 'locked', 'kindsOfWork', 'defaultScale', 'discovery']);
  if (!section.ok) return section;
  const opened = section.value;
  let contacts: readonly PolicyContact[] = Object.freeze([]);
  if (has(opened, 'contacts')) {
    const parsed = parseContacts(ownValue(opened, 'contacts'), childPath(path, 'contacts'));
    if (!parsed.ok) return parsed;
    contacts = parsed.value;
  }
  let locked: Readonly<Partial<Record<LockableAnswer, boolean>>> = Object.freeze({});
  if (has(opened, 'locked')) {
    const parsed = parseLocked(ownValue(opened, 'locked'), childPath(path, 'locked'));
    if (!parsed.ok) return parsed;
    locked = parsed.value;
  }
  let kindsOfWork: readonly KindOfWork[] = Object.freeze([...KINDS_OF_WORK]);
  if (has(opened, 'kindsOfWork')) {
    const parsed = parseKindsOfWork(ownValue(opened, 'kindsOfWork'), childPath(path, 'kindsOfWork'));
    if (!parsed.ok) return parsed;
    kindsOfWork = parsed.value;
  }
  const out: { v: 1; contacts: readonly PolicyContact[]; locked: typeof locked; kindsOfWork: readonly KindOfWork[]; defaultScale?: string; discovery?: DiscoverySection } = {
    v: 1, contacts, locked, kindsOfWork
  };
  if (has(opened, 'defaultScale')) {
    const scale = ownValue(opened, 'defaultScale');
    if (typeof scale !== 'string') return refused('wrong-type', childPath(path, 'defaultScale'));
    if (!Object.prototype.hasOwnProperty.call(scales, scale)) return refused('not-allowed-here', childPath(path, 'defaultScale'));
    out.defaultScale = scale;
  }
  if (has(opened, 'discovery')) {
    const discovery = parseDiscovery(ownValue(opened, 'discovery'), childPath(path, 'discovery'));
    if (!discovery.ok) return discovery;
    out.discovery = discovery.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// limits (limits@1): spend ceilings in whole units with the unit in the key name (D-08)

export interface SpendLimits {
  /** Nano-USD per day for a person. */
  readonly dailyNanoUsd?: number;
  /** Hours per day a vault may run, 0 to 24. */
  readonly vaultHoursPerDay?: number;
  /** Nano-USD per day for your organization's hub. */
  readonly hubDailyNanoUsd?: number;
}

export interface LimitsSection {
  readonly v: 1;
  /** Absent means no ceiling from this layer. */
  readonly spend?: SpendLimits;
}

export const MAX_VAULT_HOURS_PER_DAY = 24;

function parseWhole(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): Parsed<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return refused('wrong-type', path);
  return value > max ? refused('not-allowed-here', path) : { ok: true, value };
}

export function parseLimitsSection(value: unknown, path = 'limits'): Parsed<LimitsSection> {
  const section = openSection(value, path, [], ['spend']);
  if (!section.ok) return section;
  const opened = section.value;
  if (!has(opened, 'spend')) return { ok: true, value: Object.freeze({ v: 1 }) };
  const spendPath = childPath(path, 'spend');
  const spend = ownValue(opened, 'spend');
  if (!isRecord(spend)) return refused('wrong-type', spendPath);
  const keys = checkKeys(spend, spendPath, [], ['dailyNanoUsd', 'vaultHoursPerDay', 'hubDailyNanoUsd']);
  if (keys !== undefined) return keys;
  const out: Record<string, number> = {};
  for (const key of ['dailyNanoUsd', 'vaultHoursPerDay', 'hubDailyNanoUsd'] as const) {
    if (!has(spend, key)) continue;
    const parsed = parseWhole(ownValue(spend, key), childPath(spendPath, key), key === 'vaultHoursPerDay' ? MAX_VAULT_HOURS_PER_DAY : undefined);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  return { ok: true, value: Object.freeze({ v: 1, spend: Object.freeze(out) }) };
}
