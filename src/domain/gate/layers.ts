// Policy layers (FND-01, Phase 41 D-18 to D-22): your organization's layer is the ceiling and the personal layer can only narrow it, key by declared key.
// Pure: no I/O, no clock, no vscode, no package.
// NARROWING names, for every key a policy can hold, which way is narrower. composeLayers walks the two layers by that table: where both name a key the
// narrower value wins, a personal value wider than your organization's is replaced by the organization's and listed in `ignored` (never a lock-out, D-20),
// and a key the personal layer leaves out takes the organization's. Without an organization layer the personal layer is the whole policy, as today (D-18).
// wideningOf names what a new edit would widen, so an editor refuses it before signing; a value already clamped at load never blocks an unrelated edit.
// Imported values are used only inside functions, never at module load.
import { parsePolicyDocument } from './policyDocument';
import type { PolicyDocument } from './policyDocument';
import { POLICY_SECTIONS } from './features';
import type { ScaleTable } from './labels';
import { isRecord, ownValue } from './shape';

/** The ways a key can be narrower. `superset` is a list a layer may only add to (D-60's export regimes). */
export const NARROWING_DIRECTIONS = Object.freeze([
  'tier-stricter', 'subset', 'number-lower', 'ceiling-dominated', 'boolean-safe', 'organization-only', 'superset'
] as const);
export type NarrowingDirection = (typeof NARROWING_DIRECTIONS)[number];

export interface NarrowingRule {
  readonly direction: NarrowingDirection;
  /** tier-stricter: the values, weakest first. A value not on the list cannot be compared and counts as wider. */
  readonly order?: readonly string[];
  /** boolean-safe: the value that is never wider. */
  readonly safe?: boolean;
  /** What a key your organization's layer leaves out means: no limit (`weakest`) or nothing allowed (`strictest`, the default). */
  readonly absent?: 'weakest' | 'strictest';
  /** The rule covers every key below this one. */
  readonly subtree?: true;
}

function rule(direction: NarrowingDirection, extra: Omit<NarrowingRule, 'direction'> = {}): NarrowingRule {
  return Object.freeze({ direction, ...extra });
}

/** Routing tiers, weakest first (the order of routing.ts ROUTING_TIERS; a test holds them equal). */
const TIER_ORDER_LIST = Object.freeze(['any-cloud', 'attested-cloud', 'local-only', 'deny'] as const);

/**
 * Every key path a policy can hold and its direction. `*` is one data key (a label key, a server id, a verb); `[]` is any item of a list. A key path with
 * no entry here is unknown: composition keeps your organization's value and lists a different personal one.
 */
export const NARROWING: Readonly<Record<string, NarrowingRule>> = Object.freeze({
  'labels.routing.levels.*': rule('tier-stricter', { order: TIER_ORDER_LIST, absent: 'strictest' })
});

/** Keys kept per layer and never compared: the envelope, and each section's own `v`. */
export const LAYER_ENVELOPE_KEYS: readonly string[] = Object.freeze([
  'bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'layer', 'parent', 'requires', 'minClient',
  'labels.v', 'agents.v', 'models.v', 'residency.v', 'people.v', 'onboarding.v', 'limits.v', 'reserved.v', 'exportControl.v'
]);

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Paths

/** Any `[id]` segment read as `[]`, so `endpoints[models-example-org].maxLabel` reads as `endpoints[].maxLabel`. */
function normalPath(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '[]');
}

function segmentsOf(path: string): string[] {
  return path === '' ? [] : path.split('.');
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Whether a table pattern names these segments: `*` is one segment, or the rest when it is the pattern's last (a level name may hold a dot). */
function patternMatches(pattern: string, segments: readonly string[]): boolean {
  const parts = segmentsOf(pattern);
  if (segments.length < parts.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (part !== '*' && part !== segments[index]) return false;
  }
  return segments.length === parts.length || parts[parts.length - 1] === '*';
}

interface RuleEntry {
  readonly pattern: string;
  readonly rule: NarrowingRule;
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The table entry for a path: exact, then a wildcard entry, then the nearest entry above it that covers its subtree. */
function ruleEntryOf(path: string): RuleEntry | undefined {
  const normal = normalPath(path);
  const exact = own(NARROWING, normal);
  if (exact !== undefined) return { pattern: normal, rule: exact };
  const segments = segmentsOf(normal);
  for (const pattern of Object.keys(NARROWING)) {
    if (pattern.includes('*') && patternMatches(pattern, segments)) return { pattern, rule: NARROWING[pattern] as NarrowingRule };
  }
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const prefix = segments.slice(0, length);
    for (const pattern of Object.keys(NARROWING)) {
      const found = NARROWING[pattern] as NarrowingRule;
      if (found.subtree === true && segmentsOf(pattern).length === length && patternMatches(pattern, prefix)) return { pattern, rule: found };
    }
  }
  return undefined;
}

/** The declared rule for a key path, or undefined when the table has none (callers count undefined as wider). */
export function directionOf(path: string): NarrowingRule | undefined {
  return ruleEntryOf(path)?.rule;
}

function isEnvelopeKey(pattern: string): boolean {
  return LAYER_ENVELOPE_KEYS.includes(pattern);
}

let prefixCache: ReadonlySet<string> | undefined;

/** Every path that is a table entry, an envelope key, or a prefix of one. */
function knownPrefixes(): ReadonlySet<string> {
  if (prefixCache !== undefined) return prefixCache;
  const out = new Set<string>();
  for (const path of [...Object.keys(NARROWING), ...LAYER_ENVELOPE_KEYS]) {
    const segments = segmentsOf(path);
    for (let length = 1; length <= segments.length; length += 1) {
      const joined = segments.slice(0, length).join('.');
      out.add(joined);
      if (joined.endsWith('[]')) out.add(joined.slice(0, -2));
    }
  }
  prefixCache = out;
  return out;
}

/** The pattern of a child key: its own name when the table names it, else `*` when the table has a data-key entry there, else its own name. */
function childPattern(pattern: string, key: string): string {
  const literal = joinPath(pattern, key);
  const known = knownPrefixes();
  if (known.has(literal)) return literal;
  const wildcard = joinPath(pattern, '*');
  return known.has(wildcard) ? wildcard : literal;
}

/** Where a pattern sits in the table, so `ignored` lists keys in table order. Unknown keys come last. */
function orderOf(pattern: string): number {
  const keys = Object.keys(NARROWING);
  const index = keys.findIndex((key) => key === pattern || key.startsWith(`${pattern}.`) || key.startsWith(`${pattern}[`));
  return index < 0 ? keys.length : index;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Values

/** Key order does not change meaning, so values compare by their sorted-key JSON. */
function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(ownValue(value, key))}`).join(',')}}`;
  return value === undefined ? 'null' : JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableText(a) === stableText(b);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

const MAX_SHOWN = 80;

function describe(value: unknown): string {
  if (value === undefined || value === null) return 'nothing';
  if (typeof value === 'string') return value === '' ? 'nothing' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'nothing' : value.map(describe).join(', ');
  if (isRecord(value)) {
    const scale = ownValue(value, 'scale');
    const level = ownValue(value, 'level');
    if (typeof scale === 'string' && typeof level === 'string') return `${scale}/${level}`;
    const id = ownValue(value, 'id');
    if (typeof id === 'string') return id;
    const keys = Object.keys(value).filter((key) => key !== 'v');
    return keys.length === 0 ? 'nothing' : keys.map((key) => `${key} ${describe(ownValue(value, key))}`).join(', ');
  }
  return 'nothing';
}

/** Short plain text for a value: tiers as written, lists joined with ", ", labels `scale/level`, nothing as "nothing"; at most 80 characters. */
function shortText(value: unknown): string {
  const text = describe(value).replace(/[\u0000-\u001F\u007F]/g, ' ');
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 3)}...` : text;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Composition

/** One personal (or project) value wider than your organization allows, replaced at load and listed. Texts are short and plain. */
export interface IgnoredSetting {
  readonly key: string;
  readonly layer: 'personal' | 'project';
  readonly yours: string;
  readonly allowed: string;
}

export interface ComposedPolicy {
  readonly effective: PolicyDocument;
  readonly ignored: readonly IgnoredSetting[];
}

export interface LayerInput {
  readonly organization?: PolicyDocument;
  readonly personal: PolicyDocument;
}

interface Context {
  readonly organization: PolicyDocument;
  readonly scales: ScaleTable;
  readonly ignored: Array<{ readonly order: number; readonly entry: IgnoredSetting }>;
}

/** Whether a personal value is a real choice worth naming: not absent, not empty. */
function listable(pattern: string, mine: unknown): boolean {
  return !isEmpty(mine) && !pattern.startsWith('reserved');
}

function widen(context: Context, pattern: string, key: string, mine: unknown, allowed: unknown): void {
  if (!listable(pattern, mine)) return;
  context.ignored.push({ order: orderOf(pattern), entry: Object.freeze({ key, layer: 'personal', yours: shortText(mine), allowed: shortText(allowed) }) });
}

/** tier-stricter: the later on the order wins; a value not on it counts as wider. */
function tierNarrower(order: readonly string[], org: unknown, mine: unknown): boolean {
  const organizationIndex = order.indexOf(String(org));
  const mineIndex = order.indexOf(String(mine));
  return typeof mine === 'string' && mineIndex >= 0 && organizationIndex >= 0 && mineIndex >= organizationIndex;
}

/** One key under its rule: the personal value when it is not wider, else the organization's (listed). Undefined leaves the key out. */
function composeByRule(found: NarrowingRule, pattern: string, key: string, org: unknown, mine: unknown, context: Context): unknown {
  if (mine === undefined) return org;
  if (org === undefined) {
    if (found.absent === 'weakest') return mine;
    widen(context, pattern, key, mine, undefined);
    return undefined;
  }
  let keep = false;
  if (found.direction === 'tier-stricter') keep = tierNarrower(found.order ?? [], org, mine);
  else keep = sameValue(org, mine);
  if (keep) return mine;
  widen(context, pattern, key, mine, org);
  return org;
}

/** A record with no rule of its own: each key by its own rule. A record your organization leaves out that keeps nothing is left out too. */
function composeRecord(pattern: string, key: string, org: unknown, mine: unknown, context: Context): unknown {
  if (!isRecord(mine)) return org;
  const organization = isRecord(org) ? org : undefined;
  const keys = [...(organization === undefined ? [] : Object.keys(organization))];
  for (const name of Object.keys(mine)) if (!keys.includes(name)) keys.push(name);
  const out: Record<string, unknown> = {};
  for (const name of keys) {
    const childOrg = organization === undefined ? undefined : ownValue(organization, name);
    const childMine = ownValue(mine, name);
    const child = childPattern(pattern, name);
    const value = isEnvelopeKey(child) ? (childMine ?? childOrg) : compose(child, joinPath(key, name), childOrg, childMine, context);
    if (value !== undefined) out[name] = value;
  }
  if (organization === undefined && Object.keys(out).every((name) => name === 'v')) return undefined;
  return out;
}

function compose(pattern: string, key: string, org: unknown, mine: unknown, context: Context): unknown {
  const found = own(NARROWING, pattern);
  if (found !== undefined) return composeByRule(found, pattern, key, org, mine, context);
  if (isRecord(org) || isRecord(mine)) return composeRecord(pattern, key, org, mine, context);
  // A key with no rule: your organization's value, and a different personal one listed (it can only be narrowed by a rule).
  if (mine === undefined) return org;
  if (org !== undefined && sameValue(org, mine)) return mine;
  widen(context, pattern, key, mine, org);
  return org;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The personal envelope with the earlier expiry and the union of both layers' features. */
function envelopeOf(organization: PolicyDocument, personal: PolicyDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bundleVersion: personal.bundleVersion,
    vocabulary: personal.vocabulary,
    issuer: personal.issuer,
    issuedAt: personal.issuedAt,
    expiresAt: earlier(organization.expiresAt, personal.expiresAt),
    layer: personal.layer,
    requires: [...new Set([...organization.requires, ...personal.requires])].sort()
  };
  if (personal.parent !== undefined) out['parent'] = personal.parent;
  if (personal.minClient !== undefined) out['minClient'] = personal.minClient;
  return out;
}

function composeWithOrganization(organization: PolicyDocument, personal: PolicyDocument): ComposedPolicy {
  const context: Context = { organization, scales: organization.labels.scales, ignored: [] };
  const out = envelopeOf(organization, personal);
  for (const section of POLICY_SECTIONS) {
    const value = compose(section, section, ownValue(organization as unknown as Record<string, unknown>, section), ownValue(personal as unknown as Record<string, unknown>, section), context);
    if (value !== undefined) out[section] = value;
  }
  const ignored = context.ignored.map((item, index) => ({ ...item, index })).sort((a, b) => a.order - b.order || a.index - b.index).map((item) => item.entry);
  const parsed = parsePolicyDocument(out);
  if (parsed.ok) return { effective: parsed.value, ignored: Object.freeze(ignored) };
  return fallback(organization, personal, ignored);
}

/** When the layers cannot be combined into a policy that parses, your organization's rules apply whole and the personal layer is listed as ignored. */
function fallback(organization: PolicyDocument, personal: PolicyDocument, ignored: readonly IgnoredSetting[]): ComposedPolicy {
  const whole: IgnoredSetting = Object.freeze({ key: 'personal layer', layer: 'personal', yours: 'your personal layer', allowed: 'your organization\'s rules' });
  const out: Record<string, unknown> = envelopeOf(organization, personal);
  for (const section of POLICY_SECTIONS) {
    const value = ownValue(organization as unknown as Record<string, unknown>, section);
    if (value !== undefined) out[section] = value;
  }
  const parsed = parsePolicyDocument(out);
  return { effective: parsed.ok ? parsed.value : organization, ignored: Object.freeze([...ignored, whole]) };
}

/**
 * The effective policy of the layers (D-18 to D-20). Never throws and never changes its input. Without an organization layer the personal layer is
 * returned as it is. With one: a new frozen document with the personal envelope, the earlier expiry and the sorted union of `requires`, each key composed
 * by its rule, and every wider personal value listed in `ignored`, in table order.
 */
export function composeLayers(input: LayerInput): ComposedPolicy {
  if (input.organization === undefined) return { effective: input.personal, ignored: Object.freeze([]) };
  try {
    return composeWithOrganization(input.organization, input.personal);
  } catch {
    return fallback(input.organization, input.personal, []);
  }
}
