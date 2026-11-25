// Your organization's security classification guide as signed rules over typed facts (Phase 70.1, D-16, D-18; research 3.4, 3.5). Pure: no I/O, no
// clock, no vscode, no package. A model extracts facts; signed rules decide. A guide rule fires on one item's facts; a compilation rule fires on one
// item's facts and on a session's running set, so harmless answers that together reveal an association still raise the session.
import type { ClassificationRule, ClassificationSection } from '../gate/classificationSection';
import type { Floor } from './markings';

/** Where rules run: one item (guide and compilation rules) or a session's running set (compilation rules only). */
export const RULE_SCOPES = Object.freeze(['item', 'session'] as const);
export type RuleScope = (typeof RULE_SCOPES)[number];

/** The fields of a fact a rule reads: its type and its opaque subject key. */
export type RuleFact = { readonly type: string; readonly subject?: string };

/** Whether every fact type the rule needs is present, on one subject when it says sameSubject. */
export function ruleFires(rule: ClassificationRule, facts: readonly RuleFact[]): boolean {
  if (!rule.when.sameSubject) return rule.when.allOf.every((type) => facts.some((fact) => fact.type === type));
  const subjects = new Set(facts.filter((fact) => fact.subject !== undefined && fact.type === rule.when.allOf[0]).map((fact) => fact.subject as string));
  return [...subjects].some((subject) => rule.when.allOf.every((type) => facts.some((fact) => fact.type === type && fact.subject === subject)));
}

/**
 * The floors the rules give over these facts: a `guide` basis for a guide rule, a `compilation` basis for a compilation rule, each naming the rule id
 * (never the rule's text). In the session scope only compilation rules run.
 */
export function evaluateRules(facts: readonly RuleFact[], section: Pick<ClassificationSection, 'guideRules' | 'compilationRules'>, scope: RuleScope): readonly Floor[] {
  const out: Floor[] = [];
  if (scope === 'item') {
    for (const rule of section.guideRules) if (ruleFires(rule, facts)) out.push(Object.freeze({ label: rule.then, basis: Object.freeze({ kind: 'guide', ref: rule.id }) }));
  }
  for (const rule of section.compilationRules) if (ruleFires(rule, facts)) out.push(Object.freeze({ label: rule.then, basis: Object.freeze({ kind: 'compilation', ref: rule.id }) }));
  return Object.freeze(out);
}
