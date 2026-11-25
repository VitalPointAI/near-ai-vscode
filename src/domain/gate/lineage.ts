// The different-family rule for every checking role (Phase 74.1 D-19, design 9; MPRV-09): a model never checks work by a model of its own family, because
// a shared family can share a backdoor or a triggered fault. The family comes only from the passport's lineage (a brand name is not lineage: a Nemotron
// post-trained on Llama is a Llama). Pure: no I/O, no clock, no vscode. Phase 32.2's assignability and Phase 74.3's runner call familyOf and checkerFor
// (one family function, 74.1 D-03).
import { resolvePassport } from './models';
import type { ModelsSection } from './models';

/** Every role that checks another model's work (74.1 D-19). */
export const CHECKING_ROLES = Object.freeze(['editor', 'plan-checker', 'red-team', 'release-guard', 'reviewer', 'safety', 'tradecraft-reviewer'] as const);
export type CheckingRole = (typeof CHECKING_ROLES)[number];

/** What a checker choice can end in besides a model. Written into records, so a value never changes meaning. */
export const CHECK_OUTCOMES = Object.freeze(['check.same-family'] as const);
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** The sentence of `check.same-family`: the model not given the check, its family, and that a person decides. */
export function sameFamilyText(model: string, family: string): string {
  return `This check was not given to ${model}, because it comes from the same family (${family}) as the model it checks, and no approved model of another family is available. A person decides instead.`;
}

/** The family of a model: its passport's lineage family, or undefined with no passport (such a model checks nothing). */
export function familyOf(modelId: string, models: ModelsSection | undefined, now: number): string | undefined {
  return resolvePassport(models, modelId, now)?.passport.lineage.family;
}

/** The catalogue models of each passport id, in the ids' order (each id's models in catalogue order): a job's preference as model ids. */
export function preferredModels(passportIds: readonly string[], catalog: ReadonlyArray<{ readonly id: string }>, models: ModelsSection | undefined, now: number): string[] {
  const out: string[] = [];
  for (const passportId of passportIds) {
    for (const entry of catalog) {
      if (!out.includes(entry.id) && resolvePassport(models, entry.id, now)?.passport.id === passportId) out.push(entry.id);
    }
  }
  return out;
}

/** The two families a check names in its record (`checkFamilies`, 74.1 D-23). */
export interface CheckFamilies {
  readonly author?: string;
  readonly checker?: string;
}

export type CheckerChoice =
  | { readonly model: string; readonly families: CheckFamilies }
  | { readonly person: true; readonly outcome: CheckOutcome; readonly reason: string; readonly families: CheckFamilies };

/**
 * Who checks the work of `authorModelId` in `role`: the first model of `preference` (the role's configured model first, then its preference, as model
 * ids) that has a family, is not of the author's family, and that `allows` (the gate, for a checking job) lets run; otherwise a person, with
 * `check.same-family`. Never a model of the author's family, never a model with no passport. An author with no passport has no family, so any checker
 * of a known family may check it.
 */
export function checkerFor(
  role: CheckingRole, authorModelId: string, preference: readonly string[], allows: (modelId: string) => boolean, context: { readonly models: ModelsSection | undefined; readonly now: number }
): CheckerChoice {
  void role;
  const author = familyOf(authorModelId, context.models, context.now);
  let sameFamily: string | undefined;
  for (const candidate of preference) {
    if (candidate.trim() === '') continue;
    const family = familyOf(candidate, context.models, context.now);
    if (family === undefined) continue;
    if (author !== undefined && family === author) { sameFamily = sameFamily ?? candidate; continue; }
    if (!allows(candidate)) continue;
    return Object.freeze({ model: candidate, families: Object.freeze({ ...(author === undefined ? {} : { author }), checker: family }) });
  }
  const named = sameFamily ?? authorModelId;
  return Object.freeze({
    person: true as const, outcome: 'check.same-family' as const, reason: sameFamilyText(named, author ?? 'unknown'),
    families: Object.freeze(author === undefined ? {} : { author })
  });
}
