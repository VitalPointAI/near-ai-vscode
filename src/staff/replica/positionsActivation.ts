// Turning positions on in a shared project (Phase 33.1 plan 03; D-05, D-11, D-22, D-26, D-39; POST-01, DESIGN 5.7). Host-neutral: no vscode, no Theia.
//
// - turnOnPositions: the lead's one action. It writes roster.require with positions@1 (and verified-clearance@1 when your organization's rules carry a
//   credentials@1 section), then the first project.mode with the mode, the signed settings and the policy hash. Each write is one checked append
//   under the project's write lock, and each is decided from the fold, so a call that stopped after the requirement writes only the mode the next
//   time, and a call after both writes nothing.
// - changeMode: a later project.mode, refused while an invitation is open or a posting has not taken effect (DESIGN 5.7); with rules that now carry
//   credentials@1 it requires verified-clearance@1 first.
// - requireVerifiedClearance: one roster.require with verified-clearance@1, once, on a project with positions on (owner decision O11).
// - settingsLooserThan: the signed settings looser than the person's own effective rules, for the lead's Share section (33.1-10).
//
// Every refusal is decided before anything is signed, with the fold's own rules (positionWriteProblem). The entries are signed by the project's
// signer for their kind, which in a hosted session is the person signer: pass the id of the one action the person confirmed (33.1-17). A refused
// step-up comes back unchanged as the project's refusal.
import { POSITIONS_FEATURE, VERIFIED_CLEARANCE_FEATURE } from '../../domain/replica/features';
import { leadAt, modeChangeBlockedAt, positionSettingsAt, positionWriteProblem, positionsRequiredAt, projectModeAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { settingsLooserThanMode } from '../../domain/replica/rosterPositions';
import { DEFAULT_MAX_DELEGATION_DEPTH, DEFAULT_OVERDUE_DAYS, ORGANIZATION_SETTING_KEYS } from '../../domain/org/modes';
import type { ModeId, OrganizationSettingKey, OrganizationSettings } from '../../domain/org/modes';
import type { AppendOwnResult, ReplicaProject } from './replicaProject';
import { appendRequire } from './requireGate';

/** Your organization's rules as the lead's backend hands them over (the people.organization section and the policy it came from, D-11, D-39). */
export interface PositionsRules {
  /** The mode this shared work runs in: the mode the folder was set up in, or your organization's default (D-26). */
  readonly mode: ModeId;
  readonly allowedModes: readonly ModeId[];
  readonly settings: OrganizationSettings;
  /** The SHA-256 of the signed policy these rules come from. */
  readonly policy: string;
  /** The policy's credentials@1 section, when it carries one (D-39). Only its presence is read here. */
  readonly credentials?: unknown;
}

/** Why a positions action wrote nothing. Each sentence is shown as is (D-22: no project, no hub, no mode word). */
export const POSITIONS_REFUSALS = {
  'not-the-lead': 'Only the lead can do this, so nothing was written.',
  'mode-not-allowed-here': 'Your organization\'s rules do not allow this way of working, so nothing was written.',
  'settings-looser-than-mode': 'These settings allow more than this way of working does, so nothing was written.',
  'mode-change-pending': 'An invitation or a posting is still open. Withdraw the invitation or wait for the posting to take effect, then change how this shared work runs.',
  'positions-off': 'Positions are not turned on for this shared work yet, so nothing was written.',
  'mode-refused': 'This way of working could not be written for this shared work, so nothing was written.'
} as const;
export type PositionsRefusal = keyof typeof POSITIONS_REFUSALS;

/** What a positions action did: the hashes it wrote (none when everything was already in place), or why it wrote nothing. */
export type PositionsResult = { ok: true; written: string[] } | { ok: false; refused: string; message: string };

// The sentence for a plain invitation in an assignment mode lives with the other multi-user texts (multiUser.ts), where membership.ts reads it too.
export { INVITE_NOT_IN_MODE_TEXT, inviteNotInModeText } from '../../domain/staff/multiUser';

/** The reason written into the first project.mode (signed data, at most 200 characters). */
export const POSITIONS_ON_REASON = 'Positions turned on from your organization\'s rules.';

const refusal = (reason: PositionsRefusal): PositionsResult => ({ ok: false, refused: reason, message: POSITIONS_REFUSALS[reason] });
const fromAppend = (result: AppendOwnResult | { ok: false; refused: string; message: string }): PositionsResult | undefined =>
  'refused' in result ? { ok: false, refused: result.refused, message: result.message } : undefined;

type Project = Pick<ReplicaProject, 'appendChecked' | 'deviceWriter' | 'state'>;
const headOf = (roster: RosterState): number => roster.positions.length - 1;
const isLeadDevice = (project: Project, roster: RosterState): boolean => {
  const member = deviceAt(roster.members, project.deviceWriter, headOf(roster))?.member;
  return member !== undefined && member === leadAt(roster, headOf(roster));
};

const sameSettings = (a: OrganizationSettings, b: OrganizationSettings): boolean =>
  ORGANIZATION_SETTING_KEYS.every((key) => a[key] === b[key]);

/** The features to require now: positions@1, with verified-clearance@1 when the rules carry credentials@1. */
const featuresFor = (rules: PositionsRules): string[] => (rules.credentials === undefined ? [POSITIONS_FEATURE] : [POSITIONS_FEATURE, VERIFIED_CLEARANCE_FEATURE]);

/** Writes the features still missing, from the lead's device, under the given action. Nothing when every one is required. */
async function requireMissing(project: Project, features: readonly string[], action: string | undefined): Promise<PositionsResult> {
  const written = await appendRequire(project, (roster) => {
    if (!isLeadDevice(project, roster)) return { ok: false, skipped: 'not-a-lead-device' };
    const missing = features.filter((feature) => !roster.required.includes(feature));
    return missing.length === 0 ? { ok: false, skipped: 'already-armed' } : missing;
  }, action === undefined ? {} : { action });
  if ('skipped' in written) return written.skipped === 'not-a-lead-device' ? refusal('not-the-lead') : { ok: true, written: [] };
  return fromAppend(written) ?? { ok: true, written: [(written as { hash: string }).hash] };
}

/** Writes one project.mode, checked against the fold's own rule first. `skipSame` writes nothing when the same mode, settings and policy hold. */
async function writeMode(project: Project, rules: PositionsRules, reason: string, action: string | undefined, skipSame: boolean): Promise<PositionsResult> {
  const data = { mode: rules.mode, settings: { ...rules.settings }, policy: rules.policy, reason };
  const written = await project.appendChecked<{ ok: false; refused: string; message: string } | { ok: false; same: true }>(({ roster }) => {
    const head = headOf(roster);
    if (!isLeadDevice(project, roster)) return { ok: false, refused: 'not-the-lead', message: POSITIONS_REFUSALS['not-the-lead'] };
    if (skipSame && roster.posts.modes.length > 0 && projectModeAt(roster, head) === rules.mode && sameSettings(positionSettingsAt(roster, head), rules.settings)
      && roster.posts.modes[roster.posts.modes.length - 1]?.policy === rules.policy) return { ok: false, same: true };
    if (modeChangeBlockedAt(roster, head)) return { ok: false, refused: 'mode-change-pending', message: POSITIONS_REFUSALS['mode-change-pending'] };
    // The fold's own rule; with no signed time an invitation past its expiry still counts as open, which only ever refuses more.
    const problem = positionWriteProblem(roster, { writer: project.deviceWriter, kind: 'project.mode', data, actor: { kind: 'person' }, at: new Date(0).toISOString() }, head);
    if (problem !== undefined) {
      const reason = MODE_PROBLEMS[problem] ?? 'mode-refused';
      return { ok: false, refused: reason, message: POSITIONS_REFUSALS[reason] };
    }
    return { kind: 'project.mode', data, options: action === undefined ? {} : { action }, check: () => undefined };
  });
  if ('same' in written) return { ok: true, written: [] };
  return fromAppend(written as AppendOwnResult | { ok: false; refused: string; message: string }) ?? { ok: true, written: [(written as { hash: string }).hash] };
}

// How the fold's refusal of a project.mode reads as this action's refusal.
const MODE_PROBLEMS: Readonly<Record<string, PositionsRefusal>> = {
  'positions-not-required': 'positions-off', 'mode-not-allowed': 'not-the-lead', 'settings-looser-than-mode': 'settings-looser-than-mode', 'mode-change-pending': 'mode-change-pending'
};

/** Checks the rules before anything is signed: the mode is one your organization allows and the settings do not widen it. */
function rulesProblem(rules: PositionsRules): PositionsResult | undefined {
  if (!rules.allowedModes.includes(rules.mode)) return refusal('mode-not-allowed-here');
  return settingsWiden(rules) ? refusal('settings-looser-than-mode') : undefined;
}

const settingsWiden = (rules: PositionsRules): boolean => settingsLooserThanMode(rules.mode, rules.settings).length > 0;

/**
 * The lead turns positions on: roster.require (positions@1, with verified-clearance@1 when the rules carry credentials@1), then the first
 * project.mode. Runs again safely: what the fold already holds is not written twice.
 */
export async function turnOnPositions(project: Project, rules: PositionsRules, signing: { action?: string } = {}): Promise<PositionsResult> {
  const problem = rulesProblem(rules);
  if (problem !== undefined) return problem;
  const required = await requireMissing(project, featuresFor(rules), signing.action);
  if (!required.ok) return required;
  const mode = await writeMode(project, rules, POSITIONS_ON_REASON, signing.action, true);
  return mode.ok ? { ok: true, written: [...required.written, ...mode.written] } : mode;
}

/** A later change of the way of working (DESIGN 5.7). With rules that now carry credentials@1, verified-clearance@1 is required first (D-39). */
export async function changeMode(project: Project, rules: PositionsRules, reason: string, signing: { action?: string } = {}): Promise<PositionsResult> {
  const problem = rulesProblem(rules);
  if (problem !== undefined) return problem;
  const { roster } = await project.state();
  if (!positionsRequiredAt(roster, headOf(roster))) return refusal('positions-off');
  if (!isLeadDevice(project, roster)) return refusal('not-the-lead');
  if (modeChangeBlockedAt(roster, headOf(roster))) return refusal('mode-change-pending');
  const required = rules.credentials === undefined ? { ok: true as const, written: [] } : await requireVerifiedClearance(project, signing);
  if (!required.ok) return required;
  const mode = await writeMode(project, rules, reason, signing.action, false);
  return mode.ok ? { ok: true, written: [...required.written, ...mode.written] } : mode;
}

/** One roster.require with verified-clearance@1 on a project with positions on, written by the lead once; nothing when already required. */
export async function requireVerifiedClearance(project: Project, signing: { action?: string } = {}): Promise<PositionsResult> {
  const { roster } = await project.state();
  if (!positionsRequiredAt(roster, headOf(roster))) return refusal('positions-off');
  return requireMissing(project, [VERIFIED_CLEARANCE_FEATURE], signing.action);
}

// A permission a false turns off, and the duty a true turns on (effectiveBehaviour, Phase 41 D-40).
const PERMISSIONS: readonly OrganizationSettingKey[] = ['acting', 'dualHatting', 'guests', 'mayDecline', 'temporary'];

/**
 * The signed settings that are looser than the person's own effective rules, sorted: a permission the person's rules turn off and the signed settings
 * do not, the duty to enrol only at report when the signed settings drop it, and a larger delegation depth or a longer overdue time. Empty when the
 * signed settings are as tight as the person's own.
 */
export function settingsLooserThan(signed: OrganizationSettings, local: OrganizationSettings): string[] {
  const looser: string[] = [];
  for (const key of PERMISSIONS) if (local[key] === false && signed[key] !== false) looser.push(key);
  if (local.enrolAtReport === true && signed.enrolAtReport !== true) looser.push('enrolAtReport');
  if ((signed.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH) > (local.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH)) looser.push('maxDelegationDepth');
  if ((signed.overdueDays ?? DEFAULT_OVERDUE_DAYS) > (local.overdueDays ?? DEFAULT_OVERDUE_DAYS)) looser.push('overdueDays');
  return looser.sort();
}
