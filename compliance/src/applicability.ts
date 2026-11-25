// The component applicability map (44.1, D-06 to D-13). A rule source in compliance/applicability/ says which facets (short facts about a component)
// each component carries and which facets give a component a part in each control. From those, `classify` decides whether a component implements,
// supports or has no part in a control, with a reason built from the facet words. A not-applicable class takes effect at a level only while a review
// stage covering that level lists the component with the SHA-256 of its current section. Applicability is never tailoring: it cannot remove a row,
// mark a row Not applicable or change any other responsibility. The source keys avoid `status`, `state` and `met` (test/noStatus.test.ts).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ApplicabilityClass, ApplicabilityRecord, ComponentInput } from './model.ts';
import type { ResponsibilityTable } from './responsibility.ts';
import { loadJson, validateOurs } from './validate.ts';

export type FacetClass = Exclude<ApplicabilityClass, 'not-applicable'>;

/** One facet: the words its reason uses, written to follow "a component that". */
export interface Facet { readonly words: string }

/** A component's facets, each carried as implements or supports, with where the catalogue says so. */
export interface ComponentFacets {
  readonly role: string;
  readonly facets: Readonly<Record<string, { readonly class: FacetClass; readonly basis: string }>>;
}

/** The facets that give a component a part in a control. An empty list means no product facet does. */
export interface ControlRule { readonly facets: readonly string[] }

/** A per-pair decision that replaces the rules, only with a reason, a reviewer and a date (D-08). */
export interface ApplicabilityOverride {
  readonly component: string;
  readonly control: string;
  readonly class: ApplicabilityClass;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
}

/** compliance/applicability/rules.json. */
export interface ApplicabilityRules {
  readonly kind: 'rules';
  readonly facets: Readonly<Record<string, Facet>>;
  readonly components: Readonly<Record<string, ComponentFacets>>;
  readonly controls: Readonly<Record<string, ControlRule>>;
  readonly overrides: readonly ApplicabilityOverride[];
}

/** One review stage: the levels it covers, who reviewed, when, and the section hash of each component as reviewed (D-11, D-12). */
export interface ApplicabilityReviewStage {
  readonly id: string;
  readonly levels: readonly string[];
  readonly reviewer: { readonly role: string; readonly name: string };
  readonly reviewedAt: string;
  readonly components: Readonly<Record<string, string>>;
}

/** compliance/applicability/reviews.json. */
export interface ApplicabilityReviews {
  readonly kind: 'reviews';
  readonly stages: readonly ApplicabilityReviewStage[];
}

/** What the rules decide for one pair. */
export interface ApplicabilityDecision {
  readonly class: ApplicabilityClass;
  readonly reason: string;
}

/** The canonical classification of one component: what a review signs (statements are never part of it, D-11). */
export interface ComponentSection {
  readonly component: string;
  readonly facets: Readonly<Record<string, { readonly class: FacetClass; readonly basis: string }>>;
  readonly controls: readonly (readonly [control: string, cls: ApplicabilityClass, reason: string])[];
}

/** An enhancement (`ac-02.01`) falls back to its base control (`ac-02`) unless it has its own rule. */
export function baseControl(control: string): string { return control.replace(/\.\d+$/, ''); }

/** The rule that covers a control: its own, or its base control's. */
export function controlRule(rules: ApplicabilityRules, control: string): ControlRule | undefined {
  return Object.hasOwn(rules.controls, control) ? rules.controls[control] : Object.hasOwn(rules.controls, baseControl(control)) ? rules.controls[baseControl(control)] : undefined;
}

const listWords = (items: readonly string[]): string => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The components that carry any of the given facets, sorted. */
function carriers(rules: ApplicabilityRules, facets: readonly string[]): string[] {
  return Object.keys(rules.components).filter((component) => facets.some((facet) => Object.hasOwn(rules.components[component].facets, facet))).sort();
}

/** The reason a component has no part, from the facet words and the components that carry the facets. */
function notApplicableReason(rules: ApplicabilityRules, facets: readonly string[]): string {
  if (facets.length === 0) return 'the applicability rules give no component a part in this control, so your organization carries it.';
  const needs = facets.map((facet) => `${Object.hasOwn(rules.facets, facet) ? rules.facets[facet].words : facet} (facet ${facet})`).join(' or that ');
  const who = carriers(rules, facets);
  return `this control needs a component that ${needs}; ${who.length === 0 ? 'no component carries that here' : `${listWords(who)} ${who.length === 1 ? 'carries' : 'carry'} that here`}, and this component does not.`;
}

/**
 * Classifies one component in one control: implements when it carries one of the control's facets as implements, supports when it carries one as
 * supports, not-applicable with a reason otherwise, and undefined when no rule covers the control or the component has no entry in the rules (the pair
 * then behaves exactly as without a map). An override for the pair wins.
 */
export function classify(rules: ApplicabilityRules, component: string, control: string): ApplicabilityDecision | undefined {
  const override = rules.overrides.find((entry) => entry.component === component && entry.control === control);
  if (override) return { class: override.class, reason: override.reason };
  if (!Object.hasOwn(rules.components, component)) return undefined;
  const rule = controlRule(rules, control);
  if (!rule) return undefined;
  const carried = rule.facets.flatMap((facet) => Object.hasOwn(rules.components[component].facets, facet) ? [rules.components[component].facets[facet].class] : []);
  if (carried.includes('implements')) return { class: 'implements', reason: '' };
  if (carried.includes('supports')) return { class: 'supports', reason: '' };
  return { class: 'not-applicable', reason: notApplicableReason(rules, rule.facets) };
}

/** JSON with every object's keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * One component's section: its facets with their basis, and its class and reason in every control the rules, its overrides or the map's in-scope
 * controls (`controls`, from `mapControls`) name, sorted. The SHA-256 is over the canonical JSON. Adding a statement never changes it; changing a
 * facet, a rule, an override or a reason does, and so does a profile change that brings a new control into scope (D-11).
 */
export function componentSection(rules: ApplicabilityRules, component: string, controls: readonly string[] = []): { readonly section: ComponentSection; readonly sha256: string } {
  const named = new Set([...Object.keys(rules.controls), ...rules.overrides.filter((entry) => entry.component === component).map((entry) => entry.control), ...controls]);
  const classified = [...named].sort().flatMap((control) => {
    const decision = classify(rules, component, control);
    return decision ? [[control, decision.class, decision.reason] as const] : [];
  });
  const facets = Object.hasOwn(rules.components, component) ? rules.components[component].facets : {};
  const section: ComponentSection = { component, facets, controls: classified };
  return { section, sha256: createHash('sha256').update(canonicalJson(section)).digest('hex') };
}

/** The applicability the dashboard asks for: one lookup per level, control and component. */
export interface ApplicabilityIndex {
  readonly rules: ApplicabilityRules;
  readonly reviews: ApplicabilityReviews;
  /** The current section hash of a component. */
  sectionHash(component: string): string;
  /** The pair's applicability at a level, or undefined when no rule covers it. */
  for(level: string, control: string, component: string): ApplicabilityRecord | undefined;
}

/** True when a review stage covering the level lists the component with exactly its current section hash (D-11). */
export function isReviewed(reviews: ApplicabilityReviews, level: string, component: string, currentHash: string): boolean {
  return reviews.stages.some((stage) => stage.levels.includes(level) && Object.hasOwn(stage.components, component) && stage.components[component] === currentHash);
}

export function buildApplicabilityIndex(rules: ApplicabilityRules, reviews: ApplicabilityReviews, controls: readonly string[] = []): ApplicabilityIndex {
  const hashes = new Map<string, string>();
  const sectionHash = (component: string): string => {
    let hash = hashes.get(component);
    if (hash === undefined) { hash = componentSection(rules, component, controls).sha256; hashes.set(component, hash); }
    return hash;
  };
  return {
    rules,
    reviews,
    sectionHash,
    for(level, control, component) {
      const decision = classify(rules, component, control);
      if (!decision) return undefined;
      return { class: decision.class, reason: decision.reason, reviewed: isReviewed(reviews, level, component, sectionHash(component)) };
    }
  };
}

/** The pair's applicability at a level from an index, or undefined when there is no index or no rule. */
export function applicabilityFor(index: ApplicabilityIndex | undefined, level: string, control: string, component: string): ApplicabilityRecord | undefined {
  return index?.for(level, control, component);
}

/** The files of compliance/applicability/: the rules, the stage reviews and the generated lock (44.1-06). */
export const APPLICABILITY_FILES = Object.freeze({ rules: 'rules.json', reviews: 'reviews.json', lock: 'map.lock.json' } as const);

/** Checks what the schema cannot: every facet a component or control names is defined, a pair has at most one override, and every stage names real levels. */
function checkReferences(rules: ApplicabilityRules, reviews: ApplicabilityReviews, levelIds: readonly string[]): string[] {
  const problems: string[] = [];
  const defined = (facet: string) => Object.hasOwn(rules.facets, facet);
  for (const [component, entry] of Object.entries(rules.components)) for (const facet of Object.keys(entry.facets)) if (!defined(facet)) problems.push(`${APPLICABILITY_FILES.rules}: component ${component} carries undefined facet ${facet}`);
  for (const [control, rule] of Object.entries(rules.controls)) for (const facet of rule.facets) if (!defined(facet)) problems.push(`${APPLICABILITY_FILES.rules}: control ${control} names undefined facet ${facet}`);
  const pairs = new Set<string>();
  for (const entry of rules.overrides) {
    const key = `${entry.component}\u0000${entry.control}`;
    if (pairs.has(key)) problems.push(`${APPLICABILITY_FILES.rules}: more than one override for ${entry.component}, ${entry.control}`);
    pairs.add(key);
  }
  const stages = new Set<string>();
  for (const stage of reviews.stages) {
    if (stages.has(stage.id)) problems.push(`${APPLICABILITY_FILES.reviews}: stage ${stage.id} appears twice`);
    stages.add(stage.id);
    for (const level of stage.levels) if (!levelIds.includes(level)) problems.push(`${APPLICABILITY_FILES.reviews}: stage ${stage.id} names level ${level}, which does not exist`);
  }
  return problems;
}

/**
 * Loads compliance/applicability/ into an index, or returns undefined when the folder does not exist (the dashboard is then built as before). Every
 * file is validated against applicability.schema.json; a file that fails, a missing rules file or a reference problem throws.
 */
export function loadApplicability(dir: string, levelIds: readonly string[], controls: readonly string[] = []): ApplicabilityIndex | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const documents = new Map<string, unknown>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    const doc = loadJson(file);
    const valid = validateOurs(doc, 'applicability');
    if (!valid.ok) throw new Error(`${file}: invalid applicability file: ${valid.errors.join('; ')}`);
    documents.set(name, doc);
  }
  const rules = documents.get(APPLICABILITY_FILES.rules) as ApplicabilityRules | undefined;
  if (!rules || rules.kind !== 'rules') throw new Error(`${path.join(dir, APPLICABILITY_FILES.rules)}: missing or not kind rules`);
  const reviews = (documents.get(APPLICABILITY_FILES.reviews) ?? { kind: 'reviews', stages: [] }) as ApplicabilityReviews;
  if (reviews.kind !== 'reviews') throw new Error(`${path.join(dir, APPLICABILITY_FILES.reviews)}: not kind reviews`);
  const problems = checkReferences(rules, reviews, levelIds);
  if (problems.length) throw new Error(`${dir}: ${problems.join('; ')}`);
  return buildApplicabilityIndex(rules, reviews, controls);
}

// ---- The generated map (44.1-06, D-08 to D-10) ----------------------------------------------------------------------------------------------

/** A level as the map reads it: its selected controls and the components it assesses. */
export interface MapLevel {
  readonly id: string;
  readonly title: string;
  readonly kind?: 'level' | 'overlay';
  readonly claim?: boolean;
  readonly profile: string;
  readonly components: readonly string[];
  readonly controls: readonly string[];
}

/** Everything the generator reads. */
export interface MapSources {
  readonly levels: readonly MapLevel[];
  readonly responsibilityTable: ResponsibilityTable;
  readonly components: readonly ComponentInput[];
  readonly rules: ApplicabilityRules;
}

/** compliance/applicability/map.lock.json: per component, the section hash and one line per facet and per in-scope control. */
export interface ApplicabilityLock {
  readonly kind: 'lock';
  readonly components: Readonly<Record<string, { readonly sha256: string; readonly lines: readonly string[] }>>;
}

/** The stages your organization signs, in order (D-12). Stage 3 (the appliance and the overlays) is 44.1-24's. */
export const STAGE_LEVELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'stage-1': ['unclassified', 'protected-a', 'hosted-protected-a'],
  'stage-2': ['protected-b', 'hosted-protected-b']
});

/** The levels the map covers: claim-true levels, not overlays (the appliance and the overlays are stage 3, 44.1-24). */
export function mapLevels(levels: readonly MapLevel[]): MapLevel[] {
  return levels.filter((level) => level.claim !== false && level.kind !== 'overlay');
}

/** A control is in the map's scope when its family (or a whole-control exception) is the product's or shared; your organization's families stay as they are. */
function inScope(control: string, table: ResponsibilityTable): boolean {
  const exception = table.exceptions.find((entry) => entry.control === control && entry.component === undefined);
  const family = Object.hasOwn(table.families, control.split('-')[0]) ? table.families[control.split('-')[0]] : undefined;
  const responsibility = exception?.responsibility ?? family?.responsibility ?? 'product';
  return responsibility === 'product' || responsibility === 'shared';
}

/** The in-scope controls of one level, sorted. */
export function levelMapControls(level: MapLevel, table: ResponsibilityTable): string[] {
  return [...new Set(level.controls)].filter((control) => inScope(control, table)).sort();
}

/** Every in-scope control of every level the map covers, sorted: the controls each component's section is computed over. */
export function mapControls(levels: readonly MapLevel[], table: ResponsibilityTable): string[] {
  return [...new Set(mapLevels(levels).flatMap((level) => levelMapControls(level, table)))].sort();
}

/** What keeps the map from being complete (D-08, D-09): a component with no entry in the rules, and a control no rule covers, named with its profile. */
export function mapProblems(sources: MapSources): string[] {
  const problems: string[] = [];
  const levels = mapLevels(sources.levels);
  for (const component of [...new Set(levels.flatMap((level) => level.components))].sort()) {
    if (!Object.hasOwn(sources.rules.components, component)) problems.push(`component ${component} has no entry in the applicability rules`);
  }
  const reported = new Set<string>();
  for (const level of levels) for (const control of levelMapControls(level, sources.responsibilityTable)) {
    if (controlRule(sources.rules, control)) continue;
    const key = `${control} ${level.profile}`;
    if (reported.has(key)) continue;
    reported.add(key);
    problems.push(`control ${control}, selected by ${level.profile}, is covered by no applicability rule`);
  }
  return problems;
}

const lockLine = (control: string, decision: ApplicabilityDecision): string => `${control} ${decision.class}${decision.reason ? `: ${decision.reason}` : ''}`;

/**
 * Builds the lock: for each component of the covered levels, its section hash (the hash a review signs) and one line per facet, then one line per
 * in-scope control of its levels with its class and reason. Throws on any map problem, so a new control cannot arrive unclassified (D-09).
 */
export function buildLock(sources: MapSources): ApplicabilityLock {
  const problems = mapProblems(sources);
  if (problems.length) throw new Error(`the applicability map is incomplete: ${problems.join('; ')}`);
  const levels = mapLevels(sources.levels);
  const controls = mapControls(sources.levels, sources.responsibilityTable);
  const components: Record<string, { sha256: string; lines: string[] }> = {};
  for (const component of [...new Set(levels.flatMap((level) => level.components))].sort()) {
    const own = [...new Set(levels.filter((level) => level.components.includes(component)).flatMap((level) => levelMapControls(level, sources.responsibilityTable)))].sort();
    const facets = Object.entries(sources.rules.components[component].facets).sort(([a], [b]) => a.localeCompare(b)).map(([facet, entry]) => `facet ${facet} ${entry.class}: ${entry.basis}`);
    const lines = own.map((control) => lockLine(control, classify(sources.rules, component, control)!));
    components[component] = { sha256: componentSection(sources.rules, component, controls).sha256, lines: [...facets, ...lines] };
  }
  return { kind: 'lock', components };
}

/** True when a component has a statement for the control: it then has a part whatever the rules say (D-08). */
function stated(sources: MapSources, component: string, control: string): boolean {
  return sources.components.find((entry) => entry.id === component)?.implemented.some((requirement) => requirement.control === control && requirement.statements.length > 0) ?? false;
}

/** Statements on pairs the rules give no part: the generator lists them for review (D-08). */
export function statementsOutsideMap(sources: MapSources): { readonly component: string; readonly control: string; readonly statements: readonly string[] }[] {
  const found: { component: string; control: string; statements: string[] }[] = [];
  const covered = new Set(mapLevels(sources.levels).flatMap((level) => level.components));
  for (const component of sources.components) {
    if (!covered.has(component.id)) continue;
    for (const requirement of component.implemented) {
      if (requirement.statements.length === 0 || classify(sources.rules, component.id, requirement.control)?.class !== 'not-applicable') continue;
      found.push({ component: component.id, control: requirement.control, statements: requirement.statements.map((statement) => statement.id) });
    }
  }
  return found.sort((a, b) => a.component.localeCompare(b.component) || a.control.localeCompare(b.control));
}

/** Per covered level: its cells with a part, its cells not applicable to their component, and the in-scope controls no component has a part in. */
export function levelSummaries(sources: MapSources): { readonly level: MapLevel; readonly applicable: number; readonly notApplicable: number; readonly noPart: readonly string[] }[] {
  return mapLevels(sources.levels).map((level) => {
    let applicable = 0;
    let notApplicable = 0;
    const noPart: string[] = [];
    for (const control of levelMapControls(level, sources.responsibilityTable)) {
      let parts = 0;
      for (const component of level.components) {
        if (stated(sources, component, control) || classify(sources.rules, component, control)?.class !== 'not-applicable') { applicable++; parts++; } else notApplicable++;
      }
      if (parts === 0) noPart.push(control);
    }
    return { level, applicable, notApplicable, noPart };
  });
}

const PAGE_HEAD = [
  '# Component applicability map',
  '',
  '<!-- Generated by `node compliance/src/cli.ts applicability --write` from compliance/applicability/rules.json. Do not edit by hand; `applicability --check` fails on any difference. -->',
  '',
  'This page says, for each component the product and hosted levels assess, which controls it implements, supports or has no part in, and why. It is derived by rules from the component catalogue (`compliance/applicability/rules.json`): each component carries facets, short facts about what it is, each with the catalogue entry or code it rests on, and each control names the facets that give a component a part in it.',
  '',
  'Your organization reviews this map. A component\'s cell reads "Not applicable to this component" with its reason only at a level whose review in `compliance/applicability/reviews.json` lists the component with the section SHA-256 shown below. When a section changes, its cells read Not met until your organization signs it again. A row no component has a part in reads "Your organization\'s responsibility", never Not applicable. The map says what each component is; it does not say that any control is met, and the decision to authorize a deployment remains your organization\'s.',
  '',
  'The families that are wholly your organization\'s (AT, CA, MA, MP, PE, PM, PS, PT), the Classified appliance and the overlays are not part of this map.'
];

const controlList = (controls: readonly string[]): string => controls.length ? controls.join(', ') : 'none';
const stageOf = (id: string): string => Object.entries(STAGE_LEVELS).find(([, levels]) => levels.includes(id))?.[0].replace('stage-', '') ?? '-';

/** The readable map for your organization's review and the assessor package (D-10). */
export function renderPage(lock: ApplicabilityLock, sources: MapSources): string {
  const out: string[] = [...PAGE_HEAD, '', '## Levels', '', '| Level | Stage | Components | Cells with a part | Cells not applicable to their component | Rows no component has a part in |', '|---|---|---|---|---|---|'];
  const summaries = levelSummaries(sources);
  for (const { level, applicable, notApplicable, noPart } of summaries) out.push(`| ${level.title} (\`${level.id}\`) | ${stageOf(level.id)} | ${level.components.length} | ${applicable} | ${notApplicable} | ${noPart.length} |`);
  out.push('', '## Facets', '', '| Facet | A component that... |', '|---|---|');
  for (const [facet, entry] of Object.entries(sources.rules.facets).sort(([a], [b]) => a.localeCompare(b))) out.push(`| \`${facet}\` | ${entry.words} |`);
  out.push('', '## Components');
  for (const [component, entry] of Object.entries(lock.components)) {
    const rule = sources.rules.components[component];
    const implementsList: string[] = [];
    const supportsList: string[] = [];
    const excluded = new Map<string, string[]>();
    for (const text of entry.lines) {
      const match = /^(\S+) (implements|supports|not-applicable)(?:: (.*))?$/.exec(text);
      if (!match || text.startsWith('facet ')) continue;
      const [, control, cls, reason = ''] = match;
      if (cls === 'not-applicable') excluded.set(reason, [...(excluded.get(reason) ?? []), control]);
      else (cls === 'implements' ? implementsList : supportsList).push(control);
    }
    const levels = mapLevels(sources.levels).filter((level) => level.components.includes(component)).map((level) => level.id);
    out.push('', `### ${component}`, '', rule.role, '', `Levels: ${levels.join(', ')}. Section SHA-256: \`${entry.sha256}\`.`, '');
    const facets = Object.entries(rule.facets).sort(([a], [b]) => a.localeCompare(b));
    if (facets.length === 0) out.push('Facets: none.');
    else { out.push('Facets:', ''); for (const [facet, carried] of facets) out.push(`- \`${facet}\` (${carried.class}): ${carried.basis}`); }
    out.push('', `**Implements** (${implementsList.length}): ${controlList(implementsList)}`, '', `**Supports** (${supportsList.length}): ${controlList(supportsList)}`, '');
    const count = [...excluded.values()].reduce((sum, list) => sum + list.length, 0);
    out.push(`**Not applicable to this component** (${count}):`, '');
    if (count === 0) out.push('None.');
    else for (const [reason, controls] of excluded) out.push(`- ${controlList(controls)}: ${reason}`);
  }
  out.push('', '## Rows no component has a part in', '', 'These rows read "Your organization\'s responsibility" once the level\'s map is signed; each component keeps its own reason.');
  for (const { level, noPart } of summaries) out.push('', `### ${level.title} (\`${level.id}\`)`, '', `${noPart.length} ${noPart.length === 1 ? 'control' : 'controls'}: ${controlList(noPart)}.`);
  out.push('', '## Statements outside the map', '', 'A component that has a statement for a control has a part in it, whatever the rules say. These statements sit on pairs the rules give no part; each is for review.', '');
  const outside = statementsOutsideMap(sources);
  if (outside.length === 0) out.push('None.');
  else for (const entry of outside) out.push(`- ${entry.component}, ${entry.control}: ${entry.statements.join(', ')}`);
  return `${out.join('\n')}\n`;
}

/** The lock as committed: two-space JSON, so a review diff reads line by line. */
export function lockText(lock: ApplicabilityLock): string { return `${JSON.stringify(lock, null, 2)}\n`; }
