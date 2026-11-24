// The feature check of a shared project on this computer (POST-01; Phase 33 D-04 to D-08, D-48, D-67). Node-free and vscode-free: it reads the folded
// roster and asks the one registry, KNOWN_REPLICA_FEATURES (features.ts), which features this build folds. Nothing else keeps a list.
//
// - requireProblem: the features the project requires that this build lacks. ReplicaProject.foldNow asks it right after the roster fold and before any
//   other family is folded, and stops the whole project with the update sentence when it answers, so no entry of a later feature is ever half applied.
//   The store keeps every entry, so a build that knows the feature folds everything again with no loss.
// - ensureRequireArmed: writes roster.require { features: ['require@1'] } once, from a lead device, for a project that does not require it yet (D-08
//   at creation, D-48 for a preview project on its lead's next open). Anywhere else it writes nothing.
import { KNOWN_REPLICA_FEATURES, UPDATE_SENTENCE, missingFeatures } from '../../domain/replica/features';
import { isRosterWriterAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import type { AppendOwnResult, ReplicaProject } from './replicaProject';

export { UPDATE_SENTENCE };

/** The feature every shared project made by this build requires from its start, so the check is armed before any later feature exists (D-08). */
export const REQUIRE_ARMED_FEATURE = 'require@1';

/** The required features this build does not fold, or undefined when it folds every one. */
export function requireProblem(roster: Pick<RosterState, 'required'>, known: readonly string[] = KNOWN_REPLICA_FEATURES): { missing: string[] } | undefined {
  const missing = missingFeatures(roster.required, known);
  return missing.length === 0 ? undefined : { missing };
}

/** Why ensureRequireArmed wrote nothing: the project requires the feature already, or this device is not a lead device at the roster head. */
export type RequireArmSkip = { ok: false; skipped: 'already-armed' | 'not-a-lead-device' };

/**
 * Arms the feature check of a project: appends roster.require { features: [require@1] } when this device may write the roster at its head and the
 * required set lacks require@1. The check and the write run as one checked append, so a write by another window in between is seen and nothing is
 * written twice. Returns the append, a skip, or the project's refusal.
 */
export function ensureRequireArmed(project: Pick<ReplicaProject, 'appendChecked' | 'deviceWriter'>): Promise<AppendOwnResult | RequireArmSkip> {
  return project.appendChecked<RequireArmSkip>(({ roster }) => {
    if (roster.required.includes(REQUIRE_ARMED_FEATURE)) return { ok: false, skipped: 'already-armed' };
    if (!isRosterWriterAt(roster, project.deviceWriter, roster.positions.length - 1)) return { ok: false, skipped: 'not-a-lead-device' };
    return { kind: 'roster.require', data: { features: [REQUIRE_ARMED_FEATURE] }, options: {}, check: () => undefined };
  });
}
