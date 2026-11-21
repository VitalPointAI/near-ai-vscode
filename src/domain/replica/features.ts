// The replica features this build folds (POST-01, D-04, D-05, D-07). Hub-side and pure: no import at all, so your organization's server compiles
// the same registry and the same id rule as the extension (it is on HUB_SIDE in src/test/replicaBoundaries.test.ts).
//
// - KNOWN_REPLICA_FEATURES is the one registry: nothing else decides whether this build knows a feature. A project's required set (the union of its
//   folded roster.require entries) names features by id; a device or hub that lacks one stops for that project instead of folding it partly.
// - A feature id is name@N: a lower-case name (a letter, then letters, digits and hyphens, at most 32 characters) and a version 1 to 999. The version
//   is required, so a later version of a feature is a different id that an older build does not know.
// - A device announces its features inside its signed session answer (hubFile.ts), at most MAX_FEATURES ids, sorted and unique.

/** A replica feature id: name@N, the name at most 32 characters, the version 1 to 999 with no leading zero. */
export const REPLICA_FEATURE_PATTERN = /^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/;

/** At most this many ids in one feature list (a session announcement or a roster.require entry). */
export const MAX_FEATURES = 16;

/** The features this build folds, sorted. positions@1 is added by the release that folds positions. */
export const KNOWN_REPLICA_FEATURES: readonly string[] = Object.freeze(['cells@1', 'hub@1', 'replica@2', 'require@1']);

/** What a person sees when a project needs a feature this build does not fold (portfolio DESIGN 3.9, exact words). */
export const UPDATE_SENTENCE = 'This project needs a newer version of the extension. Update to keep working on it.';

/** True only for text of the form name@N. */
export function isReplicaFeature(value: unknown): value is string {
  return typeof value === 'string' && REPLICA_FEATURE_PATTERN.test(value);
}
