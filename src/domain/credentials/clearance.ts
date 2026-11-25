// The gate's clearance from credentials (Phase 71, D-19, VCRD-07, O11). Pure. When your organization's policy with credentials@1 is in force, the gate's
// clearances come only from here, over the person's checked credentials; otherwise the person's own declared clearances keep working on their own
// computer, shown as declared, not verified (D-08). Legacy `clearance` fields on Phase 31 member records are declarations: once a project requires
// credentials they count only for unmarked data and the lowest level of a scale.
import { levelIndex } from '../gate/labels';
import type { Clearance, Label, ScaleTable } from '../gate/labels';
import { clearancesOf, isCheckedFacts } from './mayRelease';
import type { CredentialFacts } from './mayRelease';

/** The gate's Clearance[] from checked facts: the highest threshold per scale, the compartments and releasability tokens held. Unchecked input gives none. */
export function clearanceFromCredentials(facts: CredentialFacts, scales: ScaleTable): readonly Clearance[] {
  return isCheckedFacts(facts) ? clearancesOf(facts, scales) : Object.freeze([]);
}

/** O11, as SECURITY.md and README say it (gateDocs.test.ts): what a declared clearance is worth under your organization's credential rules. */
export const DECLARED_COUNTS_ONLY_LOWEST_TEXT =
  'Under your organization\'s credential rules, a declared clearance counts at most for unmarked work and the lowest level of a scale. Anything above needs a verified credential.';

/**
 * O11: whether a legacy declared clearance may count for this label. Without a credentials requirement in the project, yes (nothing changes). With one,
 * only for an unmarked label or the lowest level of the label's scale.
 */
export function declaredClearanceCounts(label: Label | undefined, policy: { readonly scales: ScaleTable }, projectRequiresCredentials: boolean): boolean {
  if (!projectRequiresCredentials || label === undefined) return true;
  return levelIndex(policy.scales, label.scale, label.level) === 0;
}
