// The cutover rule (33.2 D-06): once a project's folded roster.require includes wrap@2, no epoch founded after that roster.require may carry an
// X25519 (cell-wrap/v1) wrap, on any grant or grant page of it. Epochs founded before the switch keep their v1 wraps and stay readable, and a later
// grant of such an epoch may use either format. The rule reads only roster positions, never arrival order or a clock, so every replica and your
// organization's server, which call this one function, agree. Pure and hub-side.
import type { GrantWrap } from './cellKeys';
import { wrapFormatOf } from './cellWrapV2';

/** The sentences SECURITY.md "How cell keys are wrapped" carries word for word (33.2 D-11), checked by the docs test. */
export const WRAP_SECURITY_SENTENCES: readonly string[] = Object.freeze([
  'New shared work, and every project its lead switches to post-quantum keys, wraps each cell key with a hybrid of P-256 and ML-KEM-768, joined by HKDF-SHA256 and sealed with AES-256-GCM.',
  'Keys given before the switch keep their older X25519 wraps and stay readable.',
  'Protected B work is never wrapped the older way, so a project must switch before it shares Protected B work.',
  'ML-KEM-1024 with P-384 is reserved for Protected C and classified work, pending the Cyber Centre\'s advice.',
  'Signatures stay Ed25519.'
]);

/** The feature a project requires to be post-quantum (33.2 D-05, D-08). */
export const WRAP_FEATURE = 'wrap@2';

export const WRAP_FORMAT_REFUSALS = {
  'old-wrap-after-switch': 'This key was given the older way after the project switched to post-quantum keys, so it is refused. Give the key again from an updated computer.'
} as const;
export type WrapFormatRefusal = keyof typeof WRAP_FORMAT_REFUSALS;

/**
 * Why a grant (or one page of it) of an epoch founded at epochFoundedAt cannot be placed, or undefined. requiredAt is the roster position of the
 * roster.require that first named wrap@2, undefined while the project has not switched.
 */
export function wrapFormatProblem(grant: { wraps: readonly GrantWrap[] }, epochFoundedAt: number, requiredAt: number | undefined): WrapFormatRefusal | undefined {
  if (requiredAt === undefined || epochFoundedAt <= requiredAt) return undefined;
  return grant.wraps.some((item) => { const format = wrapFormatOf(item.wrap); return format.ok && format.format === 1; }) ? 'old-wrap-after-switch' : undefined;
}

/**
 * The format a new wrap for an epoch must use: 'v2' for an epoch founded after the switch (or a new epoch once switched, epochFoundedAt undefined),
 * 'either' otherwise. The wrap preparer still writes v2 wherever the device has v2 keys; 'either' only allows v1 for one that has none yet.
 */
export function wrapFormatFor(requiredAt: number | undefined, epochFoundedAt: number | undefined): 'v2' | 'either' {
  if (requiredAt === undefined) return 'either';
  return epochFoundedAt === undefined || epochFoundedAt > requiredAt ? 'v2' : 'either';
}
