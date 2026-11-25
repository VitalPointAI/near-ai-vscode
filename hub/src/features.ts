// The replica features this hub folds on its runtime (POST-01; 33.2 D-05): the shared registry, with wrap@2 where the cell-wrap/v2 probe passes.
// Probed once, on first use, so a hub whose crypto cannot do ML-KEM-768 refuses a project that requires wrap@2 with needs-update instead of
// accepting wraps it cannot judge.
import { probeWrapV2 } from '@ext/domain/replica/cellWrapV2';
import { knownReplicaFeatures } from '@ext/domain/replica/features';

let probed: readonly string[] | undefined;

export function hubReplicaFeatures(): readonly string[] {
  probed ??= knownReplicaFeatures(probeWrapV2());
  return probed;
}
