// The state of a model passport (model provenance design 12.1, Phase 74.1 D-15, D-16): unknown, approved, expired (by date or by a re-evaluation
// trigger) or revoked. Pure: no I/O and no clock; the caller passes the time and what it observed. A state changes only with a date or a new passport
// (a new hash), never by waiting on anything else.
import { USE_TIERS, effectiveMaxTier } from './models';
import type { ReevaluationTrigger, ResolvedPassport, UseTier } from './models';
import { parseIsoMillis } from './shape';

/** The removal order that revokes a passport for every use, research included (74.1 D-15). Exactly these words; written into policies, so permanent. */
export const REVOKE_ALL_USES = 'all uses';

/** Where a model ran, as the catalogue says. */
export interface ObservedPlace {
  readonly privacyBoundary?: string;
  readonly forwardedTo?: string;
}

/** What the caller observed about the model behind a passport. */
export interface ObservedFacts {
  /** The place first seen for this passport's hash, and the place now. */
  readonly firstSeen?: ObservedPlace;
  readonly current?: ObservedPlace;
  /** A quantization, an artifact hash or a licence id the catalogue or the place reports. */
  readonly quantization?: string;
  readonly artifactSha256?: string;
  readonly licenceId?: string;
  /** Triggers already fired for this passport's hash (the trigger log). */
  readonly fired?: readonly ReevaluationTrigger[];
}

export type PassportState =
  | { readonly state: 'unknown' }
  | { readonly state: 'approved'; readonly maxTier: UseTier }
  | { readonly state: 'expired'; readonly reason: 'date' | ReevaluationTrigger }
  | { readonly state: 'revoked' };

const samePlace = (a: ObservedPlace, b: ObservedPlace): boolean => (a.privacyBoundary ?? '') === (b.privacyBoundary ?? '') && (a.forwardedTo ?? '') === (b.forwardedTo ?? '');

/** The triggers the observed facts fire now, in REEVALUATION_TRIGGERS' order of the checks below. */
function observedTriggers(resolved: ResolvedPassport, observed: ObservedFacts): ReevaluationTrigger[] {
  const passport = resolved.passport;
  const out: ReevaluationTrigger[] = [];
  if (observed.artifactSha256 !== undefined && passport.artifact !== undefined && observed.artifactSha256 !== passport.artifact.sha256) out.push('artifact-change');
  if (observed.quantization !== undefined && passport.artifact !== undefined && observed.quantization !== passport.artifact.quantization) out.push('quantization');
  if (observed.licenceId !== undefined && observed.licenceId !== passport.licence.id) out.push('licence-change');
  if (observed.firstSeen !== undefined && observed.current !== undefined && !samePlace(observed.firstSeen, observed.current)) out.push('hosting-change');
  return out;
}

/** The state of a resolved passport at `now`, given what was observed. */
export function passportState(resolved: ResolvedPassport | undefined, observed: ObservedFacts, now: number): PassportState {
  if (resolved === undefined) return { state: 'unknown' };
  const passport = resolved.passport;
  if (passport.legal.removalOrders.includes(REVOKE_ALL_USES)) return { state: 'revoked' };
  if (!(now >= parseIsoMillis(passport.issuedAt) && now < parseIsoMillis(passport.expiresAt))) return { state: 'expired', reason: 'date' };
  const listed = (trigger: ReevaluationTrigger): boolean => passport.reevaluateOn.includes(trigger);
  const fired = [...(observed.fired ?? []), ...observedTriggers(resolved, observed)].find(listed);
  if (fired !== undefined) return { state: 'expired', reason: fired };
  return { state: 'approved', maxTier: effectiveMaxTier(passport, now) };
}

/** Whether your organization evaluated this passport's model for `use` (74.1 D-16): an evaluation reference, and a tier that covers the use. */
export function passportEvaluated(resolved: ResolvedPassport | undefined, use: UseTier, now: number): boolean {
  if (resolved?.passport.evaluation === undefined) return false;
  return USE_TIERS.indexOf(effectiveMaxTier(resolved.passport, now)) >= USE_TIERS.indexOf(use);
}
