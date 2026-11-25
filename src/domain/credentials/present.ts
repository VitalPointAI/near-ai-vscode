// Present only what a check asks (Phase 71, VCRD-05; research risk 7). Pure. A holder cleared to Top Secret holds one ClearanceCredential per level, so a
// check that asks for "at least Secret" is shown the Secret threshold and nothing that reveals the higher one.
import type { ScaleTable } from '../gate/labels';
import { levelIndex } from '../gate/labels';
import type { VerifiedCredential } from './profile';

/** What a check asks for: a type, and for a clearance the scale and the lowest level it accepts; for other types, claims that must match exactly. */
export interface PresentationRequest {
  readonly type: string;
  readonly scale?: string;
  readonly atLeast?: string;
  readonly claims?: Readonly<Record<string, string>>;
}

function claim(credential: VerifiedCredential, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(credential.claims, key) ? (credential.claims as Readonly<Record<string, unknown>>)[key] : undefined;
}

/**
 * The credentials to present for one request: at most one. For a clearance, the threshold equal to the level asked when the holder has it, else the
 * lowest one above it on the same scale; nothing when none reaches it. For other types, the first whose claims match the request.
 */
export function presentFor<T extends { readonly verified: VerifiedCredential }>(request: PresentationRequest, wallet: readonly T[], scales: ScaleTable): readonly T[] {
  const ofType = wallet.filter((entry) => entry.verified.type === request.type);
  if (request.type === 'ClearanceCredential' && request.scale !== undefined && request.atLeast !== undefined) {
    const need = levelIndex(scales, request.scale, request.atLeast);
    if (need < 0) return Object.freeze([]);
    const candidates = ofType
      .filter((entry) => claim(entry.verified, 'scale') === request.scale)
      .map((entry) => ({ entry, rank: levelIndex(scales, request.scale as string, String(claim(entry.verified, 'atLeast'))) }))
      .filter((item) => item.rank >= need)
      .sort((a, b) => a.rank - b.rank);
    return Object.freeze(candidates.length === 0 ? [] : [candidates[0]!.entry]);
  }
  const wanted = request.claims ?? {};
  const match = ofType.find((entry) => Object.entries(wanted).every(([key, value]) => claim(entry.verified, key) === value));
  return Object.freeze(match === undefined ? [] : [match]);
}
