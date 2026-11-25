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

/** The features this build folds on any runtime, sorted. positions@1 is added by the release that folds positions. */
export const KNOWN_REPLICA_FEATURES: readonly string[] = Object.freeze(['cells@1', 'hub@1', 'replica@2', 'require@1']);

/** Post-quantum cell keys (33.2 D-05): known only where the runtime passes cell-wrap/v2's start-up probe (probeWrapV2). */
export const WRAP_V2_FEATURE = 'wrap@2';
// Implemented in stages. Hosts do not announce this capability until managed grants and ingress cutover are available.
export const CELL_ACCESS_FEATURE = 'cell-access@1';

/**
 * The features this build folds on this runtime: KNOWN_REPLICA_FEATURES, plus wrap@2 when the probe passed. The caller runs probeWrapV2 once at
 * start-up and passes its answer (this file imports nothing). A runtime that fails the probe lacks wrap@2, so a project that requires it stops with
 * UPDATE_SENTENCE instead of falling back.
 */
export function knownReplicaFeatures(wrapV2: boolean): readonly string[] {
  return wrapV2 ? Object.freeze([...KNOWN_REPLICA_FEATURES, WRAP_V2_FEATURE].sort()) : KNOWN_REPLICA_FEATURES;
}

/**
 * What a person sees when shared work needs a feature this build does not fold. D-67 replaces portfolio DESIGN 3.9's extension sentence: people do
 * not update a container image themselves, and Defence-edition text never calls shared work a project (D-69).
 */
export const UPDATE_SENTENCE = 'This shared work needs a newer version of Sterling. Ask your administrator to update it.';

/** True only for text of the form name@N. */
export function isReplicaFeature(value: unknown): value is string {
  return typeof value === 'string' && REPLICA_FEATURE_PATTERN.test(value);
}

/** The distinct required features this build does not fold, sorted for a stable refusal. */
export function missingFeatures(required: readonly string[], known: readonly string[] = KNOWN_REPLICA_FEATURES): string[] {
  const knownIds = new Set(known);
  return [...new Set(required)].filter((id) => !knownIds.has(id)).sort();
}

/** A session covers a requirement only when the device announces it and this build knows it (known: this build's features on this runtime). */
export function coversRequired(announced: readonly string[], required: readonly string[], known: readonly string[] = KNOWN_REPLICA_FEATURES): boolean {
  const announcedIds = new Set(announced);
  return required.every((id) => announcedIds.has(id) && known.includes(id));
}
