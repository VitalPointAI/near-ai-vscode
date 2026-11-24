// This computer's replica features (POST-01; 33.2 D-05): the shared registry, with wrap@2 where the cell-wrap/v2 probe passes, probed once per
// process. Its own file, importing only pure domain modules, so the hub transport (which hub tests compile without Yjs) and the feature check share it.
import { probeWrapV2 } from '../../domain/replica/cellWrapV2';
import { knownReplicaFeatures } from '../../domain/replica/features';

let probed: readonly string[] | undefined;

/** The features this computer folds and announces: KNOWN_REPLICA_FEATURES, plus wrap@2 where the probe passed. */
export function clientReplicaFeatures(): readonly string[] {
  probed ??= knownReplicaFeatures(probeWrapV2());
  return probed;
}
