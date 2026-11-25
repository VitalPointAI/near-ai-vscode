// The component applicability map (44.1, D-06 to D-13). A rule source in compliance/applicability/ says which facets (short facts about a component)
// each component carries and which facets give a component a part in each control. From those, `classify` decides whether a component implements,
// supports or has no part in a control, with a reason built from the facet words. A not-applicable class takes effect at a level only while a review
// stage covering that level lists the component with the SHA-256 of its current section. Applicability is never tailoring: it cannot remove a row,
// mark a row Not applicable or change any other responsibility. The source keys avoid `status`, `state` and `met` (test/noStatus.test.ts).
import { createHash } from 'node:crypto';
import type { ApplicabilityClass, ApplicabilityRecord } from './model.ts';

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
 * One component's section: its facets with their basis, and its class and reason in every control the rules or its overrides name, sorted. The
 * SHA-256 is over the canonical JSON. Adding a statement never changes it; changing a facet, a rule, an override or a reason does (D-11).
 */
export function componentSection(rules: ApplicabilityRules, component: string): { readonly section: ComponentSection; readonly sha256: string } {
  const named = new Set([...Object.keys(rules.controls), ...rules.overrides.filter((entry) => entry.component === component).map((entry) => entry.control)]);
  const controls = [...named].sort().flatMap((control) => {
    const decision = classify(rules, component, control);
    return decision ? [[control, decision.class, decision.reason] as const] : [];
  });
  const facets = Object.hasOwn(rules.components, component) ? rules.components[component].facets : {};
  const section: ComponentSection = { component, facets, controls };
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

export function buildApplicabilityIndex(rules: ApplicabilityRules, reviews: ApplicabilityReviews): ApplicabilityIndex {
  const hashes = new Map<string, string>();
  const sectionHash = (component: string): string => {
    let hash = hashes.get(component);
    if (hash === undefined) { hash = componentSection(rules, component).sha256; hashes.set(component, hash); }
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
