// Policy layers (FND-01, Phase 41 D-18 to D-22, D-28, D-31, D-60, D-62): your organization's layer is the ceiling and the personal layer can only narrow
// it, key by declared key. Pure: no I/O, no clock, no vscode, no package.
// NARROWING names, for every key a policy can hold, which way is narrower. composeLayers walks the two layers by that table: where both name a key the
// narrower value wins, a personal value wider than your organization's is replaced by the organization's and listed in `ignored` (never a lock-out, D-20),
// and a key the personal layer leaves out takes the organization's. Without an organization layer the personal layer is the whole policy, as today (D-18).
// wideningOf names what a new edit would widen, so an editor refuses it before signing; a value already clamped at load never blocks an unrelated edit.
// Imported values are used only inside functions, never at module load.
import type { PolicySigner } from './authorizations';
import { LEGAL_BASIS_EXEMPT_CLASSES } from './authorizations';
import type { PolicyEndpoint } from './endpoints';
import { POLICY_SECTIONS } from './features';
import { SCALE_PRESETS, levelIndex, parseLabel } from './labels';
import type { Label, ScaleTable } from './labels';
import { parsePolicyDocument } from './policyDocument';
import type { PolicyDocument } from './policyDocument';
import { LOCKABLE_ANSWERS, parseLimitsSection, parseOnboardingSection, parseRegimes, parseResidencySection } from './sections';
import type { ExportRegime, LockableAnswer } from './sections';
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
import type { Fields, Parsed } from './shape';

/** The ways a key can be narrower. `superset` is a list a layer may only add to (D-60's export regimes). */
export const NARROWING_DIRECTIONS = Object.freeze([
  'tier-stricter', 'subset', 'number-lower', 'ceiling-dominated', 'boolean-safe', 'organization-only', 'superset',
  // Phase 70.1 (D-17): a classification cost ratio or recall target is narrower when higher (more raises).
  'number-higher'
] as const);
export type NarrowingDirection = (typeof NARROWING_DIRECTIONS)[number];

export interface NarrowingRule {
  readonly direction: NarrowingDirection;
  /** tier-stricter: the values, weakest first. A value not on the list cannot be compared and counts as wider. */
  readonly order?: readonly string[];
  /** boolean-safe: the value that is never wider. */
  readonly safe?: boolean;
  /**
   * What a key your organization's layer leaves out means: no limit (`weakest`), nothing allowed (`strictest`, the default), or the parser's default
   * (`default`: a boolean-safe key keeps a personal safe value, and any other personal value goes without being listed, so the default applies).
   */
  readonly absent?: 'weakest' | 'strictest' | 'default';
  /** The rule covers every key below this one. */
  readonly subtree?: true;
}

function rule(direction: NarrowingDirection, extra: Omit<NarrowingRule, 'direction'> = {}): NarrowingRule {
  return Object.freeze({ direction, ...extra });
}

/** Routing tiers, weakest first (routing.ts ROUTING_TIERS; a test holds them equal). */
const TIERS = Object.freeze(['any-cloud', 'attested-cloud', 'local-only', 'deny']);
/** Agent modes, weakest first: the reverse of decide.ts's order for effectiveMode, whose lowest is approve-risky. */
const MODES = Object.freeze(['fully-autonomous', 'auto', 'mostly-autonomous', 'approve-risky']);
/**
 * Model use tiers a request is raised to, weakest first (models.ts USE_TIERS): useTierFor only raises, and a higher tier needs a more trusted model, so the
 * higher tier is the narrower one.
 */
const MODEL_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);

const ONLY = rule('organization-only');
const ONLY_TREE = rule('organization-only', { subtree: true });
const FALSE_SAFE = rule('boolean-safe', { safe: false });
/** A people.organization permission: left out by your organization it is the mode's own behaviour, which a personal `true` cannot go past. */
const FALSE_SAFE_OR_MODE = rule('boolean-safe', { safe: false, absent: 'default' });
const MODEL_TIER = rule('tier-stricter', { order: MODEL_TIERS, absent: 'weakest' });
const LOWER = rule('number-lower');
const LOWER_OR_NONE = rule('number-lower', { absent: 'weakest' });

/**
 * Every key path a policy can hold and its direction, in the order the policy editor shows the sections. `*` is one data key (a label key, a server id, a
 * verb); `[]` is any item of a list. A key path with no entry is unknown: composition keeps your organization's value and lists a different personal one.
 */
export const NARROWING: Readonly<Record<string, NarrowingRule>> = Object.freeze({
  'labels.scales': ONLY_TREE,
  'labels.mappings': rule('subset', { subtree: true }),
  'labels.defaultLabel': ONLY_TREE,
  'labels.routing.levels.*': rule('tier-stricter', { order: TIERS, absent: 'strictest' }),
  'labels.routing.handling.*': rule('tier-stricter', { order: TIERS, absent: 'weakest' }),
  // D-62: the reserved compartments CGP, ITAR and EAR are entries here, so a personal layer can add or tighten one and never loosen it.
  'labels.routing.compartments.*': rule('tier-stricter', { order: TIERS, absent: 'weakest' }),
  // D-28: membership by id; a personal entry your organization lacks counts only at org/Public, and only when personalApprovals is on.
  'endpoints[]': rule('subset'),
  'endpoints[].id': ONLY,
  'endpoints[].class': ONLY,
  'endpoints[].host': ONLY,
  'endpoints[].scheme': ONLY,
  'endpoints[].region': ONLY,
  'endpoints[].attestation': ONLY,
  'endpoints[].provider': ONLY,
  'endpoints[].tlsPins': ONLY,
  'endpoints[].maxLabel': rule('ceiling-dominated'),
  // D-31: a personal entry counts only when its signer is one your organization lists in people.signers.
  'authorizations[]': ONLY_TREE,
  // D-42. A section that leaves `mode` out is report mode, the weakest; `unknownMaxTier` has one value, T0, declared so a later value has a rule.
  'models.mode': rule('tier-stricter', { order: ['report', 'enforce'], absent: 'weakest' }),
  'models.unknownMaxTier': rule('tier-stricter', { order: ['T0'] }),
  'models.tierByLevel.*': MODEL_TIER,
  'models.tierByProject.*': MODEL_TIER,
  // Passports are your organization's: a personal layer can neither add one (a model with no passport is T0, and a passport replaces a shipped one by id)
  // nor drop, raise or lower one (without it, or with it lower, another matching passport can become the stricter one that applies, with wider hosting).
  // Only `hosting` narrows: which passport applies never depends on it, so fewer hosting classes is always narrower.
  'models.passports[]': ONLY,
  'models.passports[].id': ONLY,
  'models.passports[].match': ONLY,
  'models.passports[].developer': ONLY,
  'models.passports[].origin': ONLY,
  'models.passports[].lineage.family': ONLY,
  'models.passports[].lineage.base': ONLY,
  'models.passports[].lineage.teachers': ONLY,
  'models.passports[].lineage.teachers[].model': ONLY,
  'models.passports[].lineage.teachers[].origin': ONLY,
  'models.passports[].lineage.teachers[].method': ONLY,
  'models.passports[].lineage.method': ONLY,
  'models.passports[].licence.id': ONLY,
  'models.passports[].licence.obligations': ONLY,
  'models.passports[].licence.inherited': ONLY,
  'models.passports[].legal.coveredByUsLaw': ONLY,
  'models.passports[].legal.entityList': ONLY,
  'models.passports[].legal.removalOrders': ONLY,
  'models.passports[].hosting': rule('subset'),
  'models.passports[].artifact.format': ONLY,
  'models.passports[].artifact.sha256': ONLY,
  'models.passports[].artifact.quantization': ONLY,
  'models.passports[].artifact.remoteCode': ONLY,
  'models.passports[].evaluation.report': ONLY,
  'models.passports[].evaluation.sha256': ONLY,
  'models.passports[].evaluation.at': ONLY,
  'models.passports[].maxTier': ONLY,
  'models.passports[].issuedAt': ONLY,
  'models.passports[].expiresAt': ONLY,
  'models.passports[].reevaluateOn': ONLY,
  'models.defaults.*': ONLY,
  // Fewer entries means fewer weights the local model manager may fetch; each entry is your organization's as written.
  'models.localCatalogue': rule('subset'),
  'models.localCatalogue[].passport': ONLY,
  'models.localCatalogue[].artifacts': ONLY,
  'models.localCatalogue[].artifacts[].format': ONLY,
  'models.localCatalogue[].artifacts[].quantization': ONLY,
  'models.localCatalogue[].artifacts[].source': ONLY,
  'models.localCatalogue[].artifacts[].sha256': ONLY,
  'models.localCatalogue[].artifacts[].sizeBytes': ONLY,
  'models.localCatalogue[].artifacts[].licence.id': ONLY,
  'models.localCatalogue[].artifacts[].licence.url': ONLY,
  'models.localCatalogue[].minFitBand': ONLY,
  'models.order': ONLY,
  'agents.maxMode.*': rule('tier-stricter', { order: MODES }),
  'agents.contexts.*': rule('subset'),
  'agents.mcp.unattended': rule('subset'),
  'agents.mcp.labelCeilings.*': rule('ceiling-dominated', { absent: 'weakest', subtree: true }),
  'agents.requireAccreditedDevice': rule('boolean-safe', { safe: true }),
  'residency.required': rule('subset', { absent: 'weakest' }),
  'residency.byLevel.*': rule('subset', { absent: 'weakest' }),
  'people.clearances': rule('ceiling-dominated', { absent: 'weakest', subtree: true }),
  'people.signers': ONLY_TREE,
  'people.organization.mode': rule('subset'),
  'people.organization.allowedModes': ONLY,
  'people.organization.projectMayChoose': FALSE_SAFE,
  'people.organization.settings.mayDecline': FALSE_SAFE_OR_MODE,
  'people.organization.settings.acting': FALSE_SAFE_OR_MODE,
  'people.organization.settings.temporary': FALSE_SAFE_OR_MODE,
  'people.organization.settings.dualHatting': FALSE_SAFE_OR_MODE,
  'people.organization.settings.guests': FALSE_SAFE_OR_MODE,
  'people.organization.settings.enrolAtReport': rule('boolean-safe', { safe: true, absent: 'default' }),
  'people.organization.settings.overdueDays': LOWER,
  'people.organization.settings.maxDelegationDepth': LOWER,
  'onboarding.contacts': ONLY_TREE,
  'onboarding.locked': ONLY_TREE,
  'onboarding.kindsOfWork': ONLY,
  'onboarding.defaultScale': ONLY,
  'onboarding.discovery.networks': rule('subset', { subtree: true }),
  'onboarding.discovery.scanRanges': rule('subset', { subtree: true }),
  'onboarding.discovery.announce': FALSE_SAFE,
  'onboarding.discovery.personalApprovals': FALSE_SAFE,
  'limits.spend.dailyNanoUsd': LOWER_OR_NONE,
  'limits.spend.vaultHoursPerDay': LOWER_OR_NONE,
  'limits.spend.hubDailyNanoUsd': LOWER_OR_NONE,
  // Reserved fields have no meaning yet (D-05): your organization's apply, and a personal one is never listed.
  'reserved': ONLY_TREE,
  // D-60: a layer may add regimes and never remove one (wideningOf refuses a removal); officials and registration are your organization's.
  'exportControl.regimes': rule('superset'),
  'exportControl.officials': ONLY_TREE,
  'exportControl.registration': ONLY_TREE,
  'exportControl.suggestRules': rule('tier-stricter', { order: ['off', 'standard', 'automatic'], absent: 'weakest' }),
  'exportControl.agentNetwork': rule('tier-stricter', { order: ['refuse'] }),
  'exportControl.retention.neverAutoPrune': rule('boolean-safe', { safe: true }),
  'exportControl.incidents.contacts': ONLY,
  // Phase 71 (D-12): who may issue, the status lists and their keys, and freshness are your organization's alone. What sensitive data asks of a person
  // may only be added to: a personal or project layer adds a requirement and never drops one (48.1 D-25).
  'credentials.root': ONLY_TREE,
  'credentials.issuance': ONLY_TREE,
  'credentials.suites': ONLY,
  'credentials.didMethods': ONLY,
  'credentials.statusLists': ONLY_TREE,
  'credentials.statusTtl': ONLY,
  'credentials.maxOfflineAge': ONLY_TREE,
  'credentials.requiredBySensitivity.*': rule('superset', { absent: 'weakest' }),
  'credentials.fallbackPersonKeys': ONLY,
  'agreements.items': ONLY_TREE,
  // Phase 70.1 (D-17): a personal or project layer may only make classification stricter. The system-high, the shadow settings and the classifier roles
  // are your organization's alone; a threshold may only fall (a higher cost ratio or recall target, more raises); markings, code words, fact types and
  // rules may only be added; review may only look sooner. thresholds, markings, codeWords and the rules compose by their own functions (SPECIAL).
  'classification.systemHigh': ONLY_TREE,
  // The three fields come before the entry row: a pattern that ends in `*` also matches every key below it, and the first match wins.
  'classification.thresholds.*.costRatio': rule('number-higher'),
  'classification.thresholds.*.recallTarget': rule('number-higher'),
  'classification.thresholds.*.secondFamily': rule('boolean-safe', { safe: true }),
  'classification.thresholds.*': rule('superset'),
  'classification.shadow.defaultMode': ONLY,
  'classification.shadow.levels': ONLY,
  'classification.roles': ONLY_TREE,
  'classification.review.jumpLevels': LOWER,
  'classification.review.topLevel': rule('boolean-safe', { safe: true }),
  'classification.review.lowerRequestAgeDays': LOWER,
  'classification.markings[]': rule('superset'),
  'classification.codeWords.listLabel': ONLY_TREE,
  'classification.codeWords.entries[]': rule('superset'),
  'classification.factTypes': rule('superset'),
  'classification.guideRules[]': rule('superset'),
  'classification.compilationRules[]': rule('superset'),
  // Phase 45.1 (D-02): the label table for allies is your organization's security officer's alone.
  'labelInterop.version': ONLY,
  'labelInterop.scales': ONLY_TREE
});

/** Keys kept per layer and never compared: the envelope, and each section's own `v`. */
export const LAYER_ENVELOPE_KEYS: readonly string[] = Object.freeze([
  'bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'layer', 'parent', 'requires', 'minClient',
  'labels.v', 'agents.v', 'models.v', 'residency.v', 'people.v', 'onboarding.v', 'limits.v', 'reserved.v', 'exportControl.v', 'credentials.v', 'agreements.v',
  'classification.v', 'labelInterop.v'
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

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

interface RuleEntry {
  readonly pattern: string;
  readonly rule: NarrowingRule;
}

/** The table entry for a path: exact, then a wildcard entry, then the nearest entry above it that covers its subtree. */
function ruleEntryOf(path: string): RuleEntry | undefined {
  const normal = normalPath(path);
  const exact = own(NARROWING, normal);
  if (exact !== undefined) return { pattern: normal, rule: exact };
  const segments = segmentsOf(normal);
  const patterns = Object.keys(NARROWING);
  for (const pattern of patterns) {
    if (pattern.includes('*') && patternMatches(pattern, segments)) return { pattern, rule: NARROWING[pattern] as NarrowingRule };
  }
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const prefix = segments.slice(0, length);
    // A list's items sit under the list: `people.clearances[].scale` is below `people.clearances`.
    const listPrefix = [...prefix.slice(0, -1), (prefix[prefix.length - 1] as string).replace(/\[\]$/, '')];
    for (const pattern of patterns) {
      const found = NARROWING[pattern] as NarrowingRule;
      if (found.subtree !== true || segmentsOf(pattern).length !== length) continue;
      if (patternMatches(pattern, prefix) || patternMatches(pattern, listPrefix)) return { pattern, rule: found };
    }
  }
  return undefined;
}

/** The declared rule for a key path (an `[id]` segment reads as `[]`), or undefined when the table has none: callers count undefined as wider. */
export function directionOf(path: string): NarrowingRule | undefined {
  return ruleEntryOf(path)?.rule;
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

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isSubset(small: readonly unknown[], large: readonly unknown[]): boolean {
  const keys = new Set(large.map(stableText));
  return small.every((item) => keys.has(stableText(item)));
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? ownValue(value, key) : undefined;
}

function stringList(value: unknown): readonly string[] {
  return listOf(value).filter((item): item is string => typeof item === 'string');
}

/** `scale/level` split at the first slash, or undefined. */
function labelParts(key: unknown): { readonly scale: string; readonly level: string } | undefined {
  if (typeof key !== 'string') return undefined;
  const slash = key.indexOf('/');
  return slash <= 0 ? undefined : { scale: key.slice(0, slash), level: key.slice(slash + 1) };
}

function knownLabelKey(key: string, scales: ScaleTable): boolean {
  const parts = labelParts(key);
  return parts !== undefined && levelIndex(scales, parts.scale, parts.level) >= 0;
}

/**
 * Whether a clearance (or a ceiling) is contained by another: same scale, a level not higher, compartments and releasability a subset, and an expiry
 * not later (none when the other has none is fine; none when the other has one is later).
 */
function clearanceWithin(inner: unknown, outer: unknown, scales: ScaleTable): boolean {
  const scale = field(inner, 'scale');
  if (typeof scale !== 'string' || scale !== field(outer, 'scale')) return false;
  const innerLevel = levelIndex(scales, scale, String(field(inner, 'level')));
  const outerLevel = levelIndex(scales, scale, String(field(outer, 'level')));
  if (innerLevel < 0 || outerLevel < 0 || innerLevel > outerLevel) return false;
  if (!isSubset(listOf(field(inner, 'compartments')), listOf(field(outer, 'compartments')))) return false;
  if (!isSubset(listOf(field(inner, 'releasability')), listOf(field(outer, 'releasability')))) return false;
  const outerExpiry = field(outer, 'expiresAt');
  if (typeof outerExpiry !== 'string') return true;
  const innerExpiry = field(inner, 'expiresAt');
  return typeof innerExpiry === 'string' && Date.parse(innerExpiry) <= Date.parse(outerExpiry);
}

/** An endpoint ceiling within another, scale by scale: every scale it lists is listed by the other at the same level or higher. */
function ceilingWithin(inner: readonly string[], outer: readonly string[], scales: ScaleTable): boolean {
  return inner.every((key) => {
    const parts = labelParts(key);
    const match = outer.map(labelParts).find((other) => other !== undefined && parts !== undefined && other.scale === parts.scale);
    return parts !== undefined && match !== undefined && levelIndex(scales, parts.scale, parts.level) >= 0
      && levelIndex(scales, parts.scale, parts.level) <= levelIndex(scales, match.scale, match.level);
  });
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
    const regime = ownValue(value, 'regime');
    if (typeof regime === 'string') return `${regime} ${describe(ownValue(value, 'position'))}`;
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
// One change judged by its rule

/** Where a value sits on a tier order; absent per the rule, a value not on the order below everything (wider than any). */
function tierIndex(found: NarrowingRule, value: unknown): number {
  const order = found.order ?? [];
  if (value === undefined) return found.absent === 'weakest' ? -1 : order.length;
  return typeof value === 'string' ? order.indexOf(value) : -1;
}

/** Whether `after` is within `before` under a rule (equal counts as within). Undefined for organization-only. */
function within(found: NarrowingRule, after: unknown, before: unknown, scales: ScaleTable): boolean | undefined {
  switch (found.direction) {
    case 'tier-stricter': {
      const order = found.order ?? [];
      if (after !== undefined && (typeof after !== 'string' || !order.includes(after))) return false;
      return tierIndex(found, after) >= tierIndex(found, before);
    }
    case 'subset':
      if (before === undefined) return found.absent === 'weakest' || isEmpty(after);
      if (after === undefined) return found.absent !== 'weakest' && isEmpty(before);
      // A value that is not a list (a mode id) is within only when it is the same.
      if (!Array.isArray(after) || !Array.isArray(before)) return sameValue(after, before);
      return isSubset(after, before);
    case 'superset':
      // One item of a list that may only grow (70.1's rules and markings): adding it narrows, removing or changing it does not.
      if (before === undefined && after !== undefined && !Array.isArray(after)) return true;
      if (!Array.isArray(after) || !Array.isArray(before)) return sameValue(after, before);
      return isSubset(before, after);
    case 'number-higher':
      return typeof after === 'number' && typeof before === 'number' && after >= before;
    case 'number-lower': {
      const weakest = found.absent === 'weakest' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      const a = after === undefined ? weakest : after;
      const b = before === undefined ? weakest : before;
      return typeof a === 'number' && typeof b === 'number' && a <= b;
    }
    case 'ceiling-dominated':
      if (before === undefined && found.absent === 'weakest') return true;
      if (after === undefined) return before === undefined;
      if (Array.isArray(after) && after.every((item) => typeof item === 'string')) return ceilingWithin(stringList(after), stringList(before), scales);
      if (Array.isArray(after)) return after.every((item) => listOf(before).some((outer) => clearanceWithin(item, outer, scales)));
      return clearanceWithin(after, before, scales);
    case 'boolean-safe':
      return after === before || after === found.safe;
    case 'organization-only':
      return undefined;
  }
}

/**
 * How one change moves a key: `narrows`, `widens` or `neutral` by its declared rule; undefined for an organization-only key and for a path with no rule
 * (callers count undefined as widening). An `[id]` segment reads as `[]`. Label levels are read on `scales` (the shipped presets by default).
 */
export function narrowingOf(path: string, before: unknown, after: unknown, scales: ScaleTable = SCALE_PRESETS): 'narrows' | 'widens' | 'neutral' | undefined {
  const entry = ruleEntryOf(path);
  if (entry === undefined || entry.rule.direction === 'organization-only') return undefined;
  if (sameValue(before, after)) return 'neutral';
  return within(entry.rule, after, before, scales) === true ? 'narrows' : 'widens';
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
  /** The parts of the project layer that count, when one was given. It never changes `effective`. */
  readonly project?: ComposedProject;
}

export interface LayerInput {
  readonly organization?: PolicyDocument;
  readonly personal: PolicyDocument;
  readonly project?: ProjectLayer;
}

interface Pending {
  readonly order: number;
  readonly entry: IgnoredSetting;
  /** The key's own path, when it has one, so an entry whose value is in effect after all (a parser default) is not listed. */
  readonly segments?: readonly string[];
  readonly mine: unknown;
}

interface Context {
  readonly organization: PolicyDocument;
  readonly scales: ScaleTable;
  readonly pending: Pending[];
  endpoints: readonly PolicyEndpoint[];
}

let defaultsCache: Fields | undefined;

/** What each section parser fills for `{ v: 1 }`: a personal value equal to it is not a choice, so it is never listed. */
function sectionDefaults(): Fields {
  if (defaultsCache !== undefined) return defaultsCache;
  const out: Fields = {};
  const onboarding = parseOnboardingSection({ v: 1 }, SCALE_PRESETS);
  if (onboarding.ok) out['onboarding'] = onboarding.value;
  const limits = parseLimitsSection({ v: 1 });
  if (limits.ok) out['limits'] = limits.value;
  const residency = parseResidencySection({ v: 1 }, SCALE_PRESETS);
  if (residency.ok) out['residency'] = residency.value;
  defaultsCache = out;
  return out;
}

function valueAt(root: unknown, segments: readonly string[]): unknown {
  let here = root;
  for (const segment of segments) here = field(here, segment);
  return here;
}

function isDefault(segments: readonly string[] | undefined, mine: unknown): boolean {
  if (segments === undefined) return false;
  const found = valueAt(sectionDefaults(), segments);
  return found !== undefined && sameValue(found, mine);
}

/**
 * IN-02: the whole personal value of each listed entry, as stable text. `yours` is cut to 80 characters for display, so wideningOf compares this instead:
 * two different values that share their first 77 characters are not the same setting. Kept beside the entry so IgnoredSetting keeps its shape.
 */
const FULL_VALUE = new WeakMap<IgnoredSetting, string>();

/** The text wideningOf compares an entry by: its whole value when composition recorded one, else its display text. */
function fullValueOf(entry: IgnoredSetting): string {
  return FULL_VALUE.get(entry) ?? `display:${entry.yours}`;
}

/** Lists a wider personal value, unless it is empty, a section default, or reserved. */
function widen(context: Context, pattern: string, key: string, mine: unknown, allowed: unknown, segments?: readonly string[]): void {
  if (isEmpty(mine) || pattern.startsWith('reserved') || isDefault(segments, mine)) return;
  const entry: IgnoredSetting = Object.freeze({ key, layer: 'personal', yours: shortText(mine), allowed: shortText(allowed) });
  FULL_VALUE.set(entry, `value:${stableText(mine)}`);
  context.pending.push(segments === undefined ? { order: orderOf(pattern), entry, mine } : { order: orderOf(pattern), entry, segments, mine });
}

/** One key under its rule: the personal value when it is within your organization's, else the organization's (listed). Undefined leaves the key out. */
function composeByRule(found: NarrowingRule, pattern: string, segments: readonly string[], org: unknown, mine: unknown, context: Context): unknown {
  const key = segments.join('.');
  if (mine === undefined) return org;
  if (org === undefined) {
    if (found.direction === 'superset' || found.absent === 'weakest') return mine;
    if (found.absent === 'default') return found.direction === 'boolean-safe' && mine === found.safe ? mine : undefined;
    if (found.direction === 'boolean-safe') {
      if (mine === found.safe) return mine;
      widen(context, pattern, key, mine, found.safe, segments);
      return found.safe;
    }
    if (found.direction === 'tier-stricter' && mine === (found.order ?? [])[(found.order ?? []).length - 1]) return mine;
    widen(context, pattern, key, mine, undefined, segments);
    return undefined;
  }
  if (found.direction === 'superset') return [...new Set([...stringList(org), ...stringList(mine)])].sort();
  const keep = found.direction === 'organization-only' ? sameValue(org, mine) : within(found, mine, org, context.scales) === true;
  if (keep) return mine;
  widen(context, pattern, key, mine, org, segments);
  return org;
}

/** A record with no rule of its own: each key by its own rule. A record your organization leaves out that keeps nothing is left out too. */
function composeRecord(pattern: string, segments: readonly string[], org: unknown, mine: unknown, context: Context): unknown {
  if (!isRecord(mine)) return org;
  if (org !== undefined && !isRecord(org)) {
    // Two different kinds of value cannot be compared: your organization's stands.
    widen(context, pattern, segments.join('.'), mine, org, segments);
    return org;
  }
  const organization = isRecord(org) ? org : undefined;
  const keys = organization === undefined ? [] : Object.keys(organization);
  for (const name of Object.keys(mine)) if (!keys.includes(name)) keys.push(name);
  const out: Record<string, unknown> = {};
  for (const name of keys) {
    const childOrg = organization === undefined ? undefined : ownValue(organization, name);
    const childMine = ownValue(mine, name);
    const child = childPattern(pattern, name);
    const value = LAYER_ENVELOPE_KEYS.includes(child) ? (childMine ?? childOrg) : compose(child, [...segments, name], childOrg, childMine, context);
    if (value !== undefined) out[name] = value;
  }
  if (organization === undefined && Object.keys(out).every((name) => name === 'v')) return undefined;
  return out;
}

const SPECIAL: Readonly<Record<string, (org: unknown, mine: unknown, context: Context) => unknown>> = Object.freeze({
  endpoints: composeEndpoints,
  authorizations: composeAuthorizations,
  'people.clearances': composeClearances,
  'people.organization': composeOrganizationBlock,
  'people.organization.mode': composeOrganizationMode,
  'exportControl.officials': composeOfficials,
  'models.passports': composePassports,
  'classification.thresholds': composeThresholds,
  'classification.markings': (org: unknown, mine: unknown, context: Context) => composeById('classification.markings', org, mine, context),
  'classification.codeWords': composeCodeWords,
  'classification.guideRules': (org: unknown, mine: unknown, context: Context) => composeById('classification.guideRules', org, mine, context),
  'classification.compilationRules': (org: unknown, mine: unknown, context: Context) => composeById('classification.compilationRules', org, mine, context)
});

/**
 * classification.thresholds (70.1 D-17): per level, the higher cost ratio and recall target and the safe second-family flag win, so a threshold only ever
 * falls; a level your organization has no entry for may be added (it adds raises). A looser personal value is replaced and listed.
 */
function composeThresholds(org: unknown, mine: unknown, context: Context): unknown {
  if (!isRecord(mine)) return org;
  const organization = isRecord(org) ? org : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(organization)) out[key] = ownValue(organization, key);
  for (const key of Object.keys(mine)) {
    const yours = ownValue(mine, key);
    const theirs = ownValue(organization, key);
    if (theirs === undefined) { out[key] = yours; continue; }
    const costRatio = Math.max(Number(field(theirs, 'costRatio')), Number(field(yours, 'costRatio')));
    const recallTarget = Math.max(Number(field(theirs, 'recallTarget')), Number(field(yours, 'recallTarget')));
    const secondFamily = field(theirs, 'secondFamily') === true || field(yours, 'secondFamily') === true;
    const joined = { costRatio, recallTarget, secondFamily };
    if (!sameValue(joined, yours)) widen(context, 'classification.thresholds.*', `classification.thresholds.${key}`, yours, theirs);
    out[key] = joined;
  }
  return out;
}

/** A list keyed by `id` that may only grow (70.1 D-17): every entry of your organization's stays; a personal entry with a new id is added; sorted by id. */
function composeById(pattern: string, org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) return org;
  const out = new Map<string, unknown>();
  for (const item of listOf(org)) out.set(String(field(item, 'id')), item);
  for (const item of mine) {
    const id = String(field(item, 'id'));
    const theirs = out.get(id);
    if (theirs === undefined) out.set(id, item);
    else if (!sameValue(theirs, item)) widen(context, `${pattern}[]`, `${pattern}[${id}]`, item, theirs);
  }
  return [...out.keys()].sort().map((id) => out.get(id));
}

/** classification.codeWords: your organization's list label stands (its own when it has a list); the entries only grow. */
function composeCodeWords(org: unknown, mine: unknown, context: Context): unknown {
  if (!isRecord(mine)) return org;
  if (!isRecord(org)) return mine;
  return { listLabel: ownValue(org, 'listLabel'), entries: composeById('classification.codeWords.entries', ownValue(org, 'entries'), ownValue(mine, 'entries'), context) };
}

function compose(pattern: string, segments: readonly string[], org: unknown, mine: unknown, context: Context): unknown {
  const special = own(SPECIAL, pattern);
  if (special !== undefined) return special(org, mine, context);
  const found = own(NARROWING, pattern);
  if (found !== undefined) return composeByRule(found, pattern, segments, org, mine, context);
  if (isRecord(org) || isRecord(mine)) return composeRecord(pattern, segments, org, mine, context);
  // A key with no rule: your organization's value, and a different personal one listed (only a declared rule can let it narrow).
  if (mine === undefined) return org;
  if (org !== undefined && sameValue(org, mine)) return mine;
  widen(context, pattern, segments.join('.'), mine, org, segments);
  return org;
}

/** One endpoint both layers name: your organization's entry, with a ceiling lowered scale by scale to the personal one; a scale it lacks is dropped. */
function composeEndpoint(org: PolicyEndpoint, mine: PolicyEndpoint, context: Context): PolicyEndpoint {
  const key = `endpoints[${org.id}]`;
  for (const name of ['class', 'host', 'scheme', 'region', 'attestation', 'provider', 'tlsPins'] as const) {
    const yours = ownValue(mine as unknown as Fields, name);
    const allowed = ownValue(org as unknown as Fields, name);
    if (yours !== undefined && !sameValue(yours, allowed)) widen(context, `endpoints[].${name}`, `${key}.${name}`, yours, allowed);
  }
  const maxLabel: string[] = [];
  for (const wanted of mine.maxLabel) {
    const parts = labelParts(wanted);
    const cap = org.maxLabel.find((entry) => parts !== undefined && labelParts(entry)?.scale === parts.scale);
    if (parts === undefined || cap === undefined) continue;
    maxLabel.push(ceilingWithin([wanted], [cap], context.scales) ? wanted : cap);
  }
  maxLabel.sort();
  if (!sameValue(maxLabel, mine.maxLabel)) widen(context, 'endpoints[].maxLabel', `${key}.maxLabel`, mine.maxLabel, maxLabel);
  const out: Fields = {};
  for (const name of Object.keys(org)) out[name] = ownValue(org as unknown as Fields, name);
  out['maxLabel'] = maxLabel;
  return out as unknown as PolicyEndpoint;
}

/**
 * endpoints[] (D-24, D-28): membership by id is a subset, so a personal list that leaves one out narrows. A personal entry your organization lacks counts
 * only when your organization's layer turns on discovery.personalApprovals and the entry reaches exactly org/Public, on a host no other entry has.
 */
function composeEndpoints(org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) {
    context.endpoints = listOf(org) as readonly PolicyEndpoint[];
    return org;
  }
  const organization = listOf(org) as readonly PolicyEndpoint[];
  const approvals = context.organization.onboarding?.discovery?.personalApprovals === true && levelIndex(context.scales, 'org', 'Public') >= 0;
  const out: PolicyEndpoint[] = [];
  const found: PolicyEndpoint[] = [];
  for (const entry of mine as readonly PolicyEndpoint[]) {
    const match = organization.find((other) => other.id === entry.id);
    if (match !== undefined) out.push(composeEndpoint(match, entry, context));
    else if (approvals && sameValue(entry.maxLabel, ['org/Public'])) found.push(entry);
    else widen(context, 'endpoints[]', `endpoints[${entry.id}]`, entry.host, undefined);
  }
  for (const entry of found) {
    if (organization.some((other) => other.host === entry.host) || out.some((other) => other.host === entry.host)) {
      widen(context, 'endpoints[]', `endpoints[${entry.id}]`, entry.host, undefined);
    } else {
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  context.endpoints = out;
  return org === undefined && out.length === 0 ? undefined : out;
}

interface AuthorizationEnvelope {
  readonly signer: { readonly publicKey: string };
  readonly payload: { readonly id: string; readonly kind: string; readonly subject: Fields; readonly conditions: unknown };
}

/** D-61: an export-endpoint record for an effective place your organization does not run must cite its legal basis. */
function lacksLegalBasis(entry: AuthorizationEnvelope, endpoints: readonly PolicyEndpoint[]): boolean {
  if (entry.payload.kind !== 'export-endpoint') return false;
  const endpoint = endpoints.find((place) => place.id === ownValue(entry.payload.subject, 'endpoint'));
  if (endpoint === undefined || LEGAL_BASIS_EXEMPT_CLASSES.includes(endpoint.class)) return false;
  return field(entry.payload.conditions, 'legalBasis') === undefined;
}

/** authorizations[] (D-31): your organization's records, and a personal record only when its signer's key is one your organization lists. */
function composeAuthorizations(org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) return org;
  const organization = listOf(org) as readonly AuthorizationEnvelope[];
  const signers = (context.organization.people?.signers ?? ([] as readonly PolicySigner[])).map((signer) => signer.publicKey);
  const out: AuthorizationEnvelope[] = [...organization];
  for (const entry of mine as readonly AuthorizationEnvelope[]) {
    const id = entry.payload.id;
    const same = organization.find((other) => other.payload.id === id);
    if (same !== undefined) {
      if (!sameValue(same, entry)) widen(context, 'authorizations[]', `authorizations[${id}]`, id, undefined);
    } else if (!signers.includes(entry.signer.publicKey) || lacksLegalBasis(entry, context.endpoints)) {
      widen(context, 'authorizations[]', `authorizations[${id}]`, id, undefined);
    } else {
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.payload.id < b.payload.id ? -1 : a.payload.id > b.payload.id ? 1 : 0));
  return org === undefined && out.length === 0 ? undefined : out;
}

/** people.clearances: a personal clearance stays when one of your organization's contains it; with no organization list, the self-declared list stays. */
function composeClearances(org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) return org;
  if (!Array.isArray(org)) return mine;
  const kept: unknown[] = [];
  for (const clearance of mine) {
    if (org.some((outer) => clearanceWithin(clearance, outer, context.scales))) kept.push(clearance);
    else widen(context, 'people.clearances', 'people.clearances', clearance, org);
  }
  return kept;
}

/** people.organization (D-40): your organization's block decides; a personal block under a layer without one has nothing to narrow and is listed. */
function composeOrganizationBlock(org: unknown, mine: unknown, context: Context): unknown {
  if (mine === undefined) return org;
  if (org === undefined) {
    widen(context, 'people.organization.allowedModes', 'people.organization', mine, undefined);
    return undefined;
  }
  return composeRecord('people.organization', ['people', 'organization'], org, mine, context);
}

/** people.organization.mode: kept when it is one of your organization's allowedModes. */
function composeOrganizationMode(org: unknown, mine: unknown, context: Context): unknown {
  if (mine === undefined) return org;
  const allowed = stringList(field(field(context.organization.people, 'organization'), 'allowedModes'));
  if (typeof mine === 'string' && allowed.includes(mine)) return mine;
  widen(context, 'people.organization.mode', 'people.organization.mode', mine, allowed, ['people', 'organization', 'mode']);
  return org;
}

/**
 * exportControl.officials (D-60): your organization's officials for the regimes it lists; for a regime only the personal layer adds, the personal layer's
 * official, so every effective regime still names the position that signs its decisions.
 */
function composeOfficials(org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) return org;
  const organization = listOf(org);
  const regimes = organization.map((official) => field(official, 'regime'));
  const onTheirs = mine.filter((official) => regimes.includes(field(official, 'regime')));
  const theirs = organization.filter((official) => onTheirs.some((other) => field(other, 'regime') === field(official, 'regime')));
  if (!sameValue(onTheirs, theirs)) widen(context, 'exportControl.officials', 'exportControl.officials', onTheirs, theirs);
  const out = [...organization, ...mine.filter((official) => !regimes.includes(field(official, 'regime')))];
  out.sort((a, b) => { const left = String(field(a, 'regime')); const right = String(field(b, 'regime')); return left < right ? -1 : left > right ? 1 : 0; });
  return org === undefined && out.length === 0 ? undefined : out;
}

/**
 * models.passports (D-42): your organization's passports, all of them, each as written except `hosting`, which a personal layer may narrow to fewer
 * classes. A personal passport your organization lacks is dropped and listed; any other changed field is listed and your organization's stands.
 */
function composePassports(org: unknown, mine: unknown, context: Context): unknown {
  if (!Array.isArray(mine)) return org;
  const organization = listOf(org);
  const out = organization.map((passport) => {
    const id = field(passport, 'id');
    const yours = mine.find((other) => field(other, 'id') === id);
    if (yours === undefined || !isRecord(passport)) return passport;
    const key = `models.passports[${String(id)}]`;
    const result = copyOf(passport);
    for (const name of new Set([...Object.keys(passport), ...(isRecord(yours) ? Object.keys(yours) : [])])) {
      const theirs = ownValue(passport, name);
      const wanted = field(yours, name);
      if (wanted === undefined || sameValue(wanted, theirs)) continue;
      if (name === 'hosting' && Array.isArray(wanted) && wanted.length > 0 && isSubset(wanted, listOf(theirs))) result[name] = wanted;
      else widen(context, `models.passports[].${name}`, `${key}.${name}`, wanted, theirs);
    }
    return result;
  });
  for (const passport of mine) {
    const id = field(passport, 'id');
    if (!organization.some((other) => field(other, 'id') === id)) widen(context, 'models.passports[]', `models.passports[${String(id)}]`, id, undefined);
  }
  return org === undefined && out.length === 0 ? undefined : out;
}

/** Drops every key that names a scale or level the effective scales lack (listing each), so the effective document always parses. */
function withoutUnknownScales(out: Fields, context: Context): void {
  const scales = context.scales;
  const agents = field(out, 'agents');
  const mcp = field(agents, 'mcp');
  const ceilings = field(mcp, 'labelCeilings');
  if (isRecord(agents) && isRecord(mcp) && isRecord(ceilings)) {
    const kept: Fields = {};
    for (const id of Object.keys(ceilings)) {
      const ceiling = ownValue(ceilings, id);
      if (levelIndex(scales, String(field(ceiling, 'scale')), String(field(ceiling, 'level'))) >= 0) kept[id] = ceiling;
      else widen(context, 'agents.mcp.labelCeilings.*', `agents.mcp.labelCeilings.${id}`, ceiling, undefined);
    }
    const nextMcp: Fields = { ...copyOf(mcp) };
    if (Object.keys(kept).length > 0) nextMcp['labelCeilings'] = kept;
    else delete nextMcp['labelCeilings'];
    out['agents'] = { ...copyOf(agents), mcp: nextMcp };
  }
  const labels = field(out, 'labels');
  const routing = field(labels, 'routing');
  if (isRecord(labels) && isRecord(routing)) out['labels'] = { ...copyOf(labels), routing: withKnownLevelKeys(routing, 'levels', 'labels.routing.levels', context) };
  out['residency'] = withKnownLevelKeys(out['residency'], 'byLevel', 'residency.byLevel', context);
  out['models'] = withKnownLevelKeys(out['models'], 'tierByLevel', 'models.tierByLevel', context);
  const people = field(out, 'people');
  const clearances = field(people, 'clearances');
  if (isRecord(people) && Array.isArray(clearances)) {
    const kept = clearances.filter((clearance) => {
      const known = levelIndex(scales, String(field(clearance, 'scale')), String(field(clearance, 'level'))) >= 0;
      if (!known) widen(context, 'people.clearances', 'people.clearances', clearance, undefined);
      return known;
    });
    out['people'] = { ...copyOf(people), clearances: kept };
  }
  const onboarding = field(out, 'onboarding');
  const discovery = field(onboarding, 'discovery');
  if (isRecord(onboarding) && isRecord(discovery)) {
    // A scan range names a listed network; one whose network the effective list lacks scans nothing and goes.
    const networks = listOf(field(discovery, 'networks')).map((network) => field(network, 'id'));
    const ranges = listOf(field(discovery, 'scanRanges')).filter((range) => field(range, 'network') === undefined || networks.includes(field(range, 'network')));
    out['onboarding'] = { ...copyOf(onboarding), discovery: { ...copyOf(discovery), scanRanges: ranges } };
  }
  for (const name of Object.keys(out)) if (out[name] === undefined) delete out[name];
}

function copyOf(value: Fields): Fields {
  const out: Fields = {};
  for (const key of Object.keys(value)) out[key] = ownValue(value, key);
  return out;
}

function withKnownLevelKeys(section: unknown, name: string, pattern: string, context: Context): unknown {
  const map = field(section, name);
  if (!isRecord(section) || !isRecord(map)) return section;
  const kept: Fields = {};
  for (const key of Object.keys(map)) {
    if (knownLabelKey(key, context.scales)) kept[key] = ownValue(map, key);
    else widen(context, `${pattern}.*`, `${pattern}.${key}`, ownValue(map, key), undefined);
  }
  const out = copyOf(section);
  if (Object.keys(kept).length > 0) out[name] = kept;
  else delete out[name];
  return out;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The personal envelope with the earlier expiry and the sorted union of both layers' features. */
function envelopeOf(organization: PolicyDocument, personal: PolicyDocument): Fields {
  const out: Fields = {
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

function sectionOf(document: PolicyDocument, section: string): unknown {
  return ownValue(document as unknown as Fields, section);
}

function composeWithOrganization(organization: PolicyDocument, personal: PolicyDocument): ComposedPolicy {
  const context: Context = { organization, scales: organization.labels.scales, pending: [], endpoints: [] };
  const out = envelopeOf(organization, personal);
  for (const section of POLICY_SECTIONS) {
    const value = compose(section, [section], sectionOf(organization, section), sectionOf(personal, section), context);
    if (value !== undefined) out[section] = value;
  }
  withoutUnknownScales(out, context);
  const parsed = parsePolicyDocument(out);
  if (!parsed.ok) return fallback(organization, personal, context);
  // A value in effect after all (the parser fills the same default in its place) is not wider and is not listed.
  const ignored = context.pending
    .filter((item) => item.segments === undefined || !sameValue(valueAt(parsed.value, item.segments), item.mine))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.order - b.item.order || a.index - b.index)
    .map(({ item }) => item.entry);
  return { effective: parsed.value, ignored: Object.freeze(ignored) };
}

/** When the layers cannot be combined into a policy that parses, your organization's rules apply whole and the personal layer is listed as ignored. */
function fallback(organization: PolicyDocument, personal: PolicyDocument, context?: Context): ComposedPolicy {
  const whole: IgnoredSetting = Object.freeze({ key: 'personal layer', layer: 'personal', yours: 'your personal layer', allowed: 'your organization\'s rules' });
  const out = envelopeOf(organization, personal);
  for (const section of POLICY_SECTIONS) {
    const value = sectionOf(organization, section);
    if (value !== undefined) out[section] = value;
  }
  const parsed = parsePolicyDocument(out);
  const ignored = [...(context?.pending ?? []).map((item) => item.entry), whole];
  return { effective: parsed.ok ? parsed.value : organization, ignored: Object.freeze(ignored) };
}

/**
 * The effective policy of the layers (D-18 to D-20). Never throws and never changes its input. Without an organization layer the personal layer is
 * returned as it is. With one: a new frozen document with the personal envelope, the earlier expiry and the sorted union of `requires`, each key composed
 * by its rule, and every wider personal value listed in `ignored`, in table order. A combination that does not parse gives your organization's rules whole.
 */
export function composeLayers(input: LayerInput): ComposedPolicy {
  const layers = composePersonal(input.organization, input.personal);
  if (input.project === undefined) return layers;
  const project = composeProject(input.project, layers.effective, input.organization);
  return { effective: layers.effective, ignored: Object.freeze([...layers.ignored, ...project.ignored]), project: project.project };
}

function composePersonal(organization: PolicyDocument | undefined, personal: PolicyDocument): ComposedPolicy {
  if (organization === undefined) return { effective: personal, ignored: Object.freeze([]) };
  try {
    return composeWithOrganization(organization, personal);
  } catch {
    return fallback(organization, personal);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The project layer (D-22, D-60): in memory in this phase; its single-machine source comes with 32.1 and its shared source with 33.1.

export interface ProjectExercise {
  /** Why the project runs as an exercise, recorded with the flag (owner Q10). 1 to 200 characters. */
  readonly reason: string;
  readonly setAt: string;
}

export interface ProjectLayer {
  readonly v: 1;
  readonly label?: Label;
  /** A mode id; it counts only when the effective people.organization.allowedModes holds it. */
  readonly mode?: string;
  readonly exercise?: ProjectExercise;
  /** Setup answers fixed for the project, as onboarding.locked has them. */
  readonly locked?: Readonly<Partial<Record<LockableAnswer, boolean>>>;
  /** Export regimes the project adds (D-60): a project can add one and never remove one. */
  readonly regimes?: readonly ExportRegime[];
}

export interface ComposedProject {
  readonly label?: Label;
  readonly mode?: string;
  readonly exercise?: ProjectExercise;
  readonly locked?: Readonly<Partial<Record<LockableAnswer, boolean>>>;
  /** The sorted union of the effective exportControl.regimes and the project's own. */
  readonly regimes: readonly ExportRegime[];
}

const PROJECT_MODE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_EXERCISE_REASON = 200;
const CONTROL = /[\u0000-\u001F\u007F]/;

function parseExercise(value: unknown, path: string): Parsed<ProjectExercise> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['reason', 'setAt']);
  if (keys !== undefined) return keys;
  const reason = ownValue(value, 'reason');
  if (typeof reason !== 'string' || reason === '' || reason.length > MAX_EXERCISE_REASON || CONTROL.test(reason)) return refused('wrong-type', childPath(path, 'reason'));
  const setAt = ownValue(value, 'setAt');
  if (typeof setAt !== 'string' || Number.isNaN(parseIsoMillis(setAt))) return refused('wrong-type', childPath(path, 'setAt'));
  return { ok: true, value: Object.freeze({ reason, setAt }) };
}

function parseProjectLocked(value: unknown, path: string): Parsed<Readonly<Partial<Record<LockableAnswer, boolean>>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Partial<Record<LockableAnswer, boolean>> = {};
  for (const key of Object.keys(value)) {
    const answer = LOCKABLE_ANSWERS.find((candidate) => candidate === key);
    if (answer === undefined) return refused('unknown-field', childPath(path, key.slice(0, 40)));
    const flag = ownValue(value, key);
    if (typeof flag !== 'boolean') return refused('wrong-type', childPath(path, key));
    out[answer] = flag;
  }
  return { ok: true, value: Object.freeze(out) };
}

/** Reads a project layer strictly: `v` 1, and optional label (on `scales`), mode, exercise (with its reason), locked answers and export regimes. */
export function parseProjectLayer(value: unknown, scales: ScaleTable, path = ''): Parsed<ProjectLayer> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v'], ['label', 'mode', 'exercise', 'locked', 'regimes']);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  const out: { v: 1; label?: Label; mode?: string; exercise?: ProjectExercise; locked?: Readonly<Partial<Record<LockableAnswer, boolean>>>; regimes?: readonly ExportRegime[] } = { v: 1 };
  if (Object.prototype.hasOwnProperty.call(value, 'label')) {
    const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
    if (!label.ok) return label;
    out.label = label.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mode')) {
    const mode = ownValue(value, 'mode');
    if (typeof mode !== 'string' || !PROJECT_MODE_PATTERN.test(mode)) return refused('wrong-type', childPath(path, 'mode'));
    out.mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'exercise')) {
    const exercise = parseExercise(ownValue(value, 'exercise'), childPath(path, 'exercise'));
    if (!exercise.ok) return exercise;
    out.exercise = exercise.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'locked')) {
    const locked = parseProjectLocked(ownValue(value, 'locked'), childPath(path, 'locked'));
    if (!locked.ok) return locked;
    out.locked = locked.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'regimes')) {
    const regimes = parseRegimes(ownValue(value, 'regimes'), childPath(path, 'regimes'));
    if (!regimes.ok) return regimes;
    out.regimes = regimes.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function projectIgnored(key: string, yours: unknown, allowed: unknown): IgnoredSetting {
  return Object.freeze({ key, layer: 'project', yours: shortText(yours), allowed: shortText(allowed) });
}

/**
 * The project layer as a narrowing input: its mode counts when the effective allowedModes holds it (or none exist), your organization's locked answers win
 * over the project's, its label and exercise flag are carried unchanged, and its regimes join the effective ones (D-22, D-60).
 */
function composeProject(project: ProjectLayer, effective: PolicyDocument, organization: PolicyDocument | undefined): { project: ComposedProject; ignored: IgnoredSetting[] } {
  const ignored: IgnoredSetting[] = [];
  const out: { label?: Label; mode?: string; exercise?: ProjectExercise; locked?: Readonly<Partial<Record<LockableAnswer, boolean>>>; regimes: readonly ExportRegime[] } = {
    regimes: Object.freeze([...new Set([...(effective.exportControl?.regimes ?? []), ...(project.regimes ?? [])])].sort())
  };
  if (project.label !== undefined) out.label = project.label;
  if (project.exercise !== undefined) out.exercise = project.exercise;
  if (project.mode !== undefined) {
    const allowed = stringList(field(field(effective.people, 'organization'), 'allowedModes'));
    if (allowed.length === 0 || allowed.includes(project.mode)) out.mode = project.mode;
    else ignored.push(projectIgnored('people.organization.mode', project.mode, allowed));
  }
  if (project.locked !== undefined) {
    const theirs = organization?.onboarding?.locked ?? {};
    const locked: Partial<Record<LockableAnswer, boolean>> = {};
    for (const answer of LOCKABLE_ANSWERS) {
      const wanted = project.locked[answer];
      if (wanted === undefined) continue;
      const fixed = theirs[answer];
      if (fixed !== undefined && fixed !== wanted) ignored.push(projectIgnored(`onboarding.locked.${answer}`, wanted, fixed));
      locked[answer] = fixed ?? wanted;
    }
    out.locked = Object.freeze(locked);
  }
  return { project: Object.freeze(out), ignored };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// New edits (D-20)

/** The value at a dotted path of a document, read by own properties. */
function documentValue(document: PolicyDocument, path: string): unknown {
  return valueAt(document, segmentsOf(path));
}

/** A superset table entry's concrete paths: itself, or for a `.*` entry (Phase 71's credentials.requiredBySensitivity.*) one per data key any layer holds. */
function supersetPaths(pattern: string, documents: readonly PolicyDocument[]): string[] {
  if (!pattern.endsWith('.*')) return [pattern];
  const parent = pattern.slice(0, -2);
  const keys = new Set<string>();
  for (const document of documents) {
    const value = documentValue(document, parent);
    if (isRecord(value)) for (const key of Object.keys(value)) keys.add(key);
  }
  return [...keys].sort().map((key) => `${parent}.${key}`);
}

/**
 * The first setting a new edit widens, or undefined: compose the organization layer with `base` and with `next`, and return the first entry of the second
 * (in table order) whose key and whole value (not the shortened display text, IN-02) the first does not list, so a value already clamped at load never
 * blocks an unrelated edit. Removing an export
 * regime your organization lists widens too (D-60), with your organization's list as the allowed value.
 */
export function wideningOf(organization: PolicyDocument | undefined, base: PolicyDocument, next: PolicyDocument): IgnoredSetting | undefined {
  if (organization === undefined) return undefined;
  const before = composeLayers({ organization, personal: base }).ignored;
  const after = composeLayers({ organization, personal: next }).ignored;
  const found: Array<{ readonly order: number; readonly entry: IgnoredSetting }> = [];
  for (const entry of after) {
    if (!before.some((other) => other.key === entry.key && fullValueOf(other) === fullValueOf(entry))) {
      found.push({ order: orderOf(ruleEntryOf(entry.key)?.pattern ?? normalPath(entry.key)), entry });
    }
  }
  for (const pattern of Object.keys(NARROWING)) {
    if ((NARROWING[pattern] as NarrowingRule).direction !== 'superset') continue;
    for (const path of supersetPaths(pattern, [organization, base, next])) {
      const theirs = stringList(documentValue(organization, path));
      const kept = stringList(documentValue(next, path));
      const removed = stringList(documentValue(base, path)).filter((item) => !kept.includes(item) && theirs.includes(item));
      if (removed.length > 0) found.push({ order: orderOf(pattern), entry: Object.freeze({ key: path, layer: 'personal', yours: shortText(kept), allowed: shortText(theirs) }) });
    }
  }
  found.sort((a, b) => a.order - b.order);
  return found[0]?.entry;
}

/** D-20: the sentence an editor shows when it refuses a widening edit before signing. */
export function widerThanOrganizationText(setting: IgnoredSetting): string {
  return `Your organization's rules do not allow ${setting.key} to be wider than ${setting.allowed}.`;
}

const NOTICE_SHOWN = 5;

/** D-20: the one notice that lists the ignored settings (at most five, then how many more), or undefined when there are none. */
export function ignoredSettingsNotice(ignored: readonly IgnoredSetting[]): string | undefined {
  if (ignored.length === 0) return undefined;
  const shown = ignored.slice(0, NOTICE_SHOWN).map((entry) => `${entry.key} (yours: ${entry.yours}, allowed: ${entry.allowed})`).join('; ');
  const more = ignored.length > NOTICE_SHOWN ? `, and ${String(ignored.length - NOTICE_SHOWN)} more` : '';
  return `These personal settings are wider than your organization allows and have no effect: ${shown}${more}.`;
}
