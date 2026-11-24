// The engine names the staff backend uses (Phase 33 D-51; the Phase 46 D-15 pattern): bundled by tools/build-engine.mjs into engine/staff.cjs and
// loaded by the backend at run time (extension/src/node/staff/staff-engine.ts). Nothing here goes to the browser bundle.
//
// 33-23: the session-key rules and the keyring, so a hosted session certifies its session key and keeps its epoch keys and join secrets in the
// person's key store. 33-24 adds the replica project and the live replicator here, with the decode worker and the vendored Yjs they load by path.
export { certifiedWriter, isPersonKeyKind, PERSON_KEY_KINDS, SESSION_DEFAULT_LIFETIME_MS, SESSION_MAX_LIFETIME_MS, sessionBindingBytes, sessionCertifyData } from '../../src/domain/replica/sessionKeys';
export { writerIdOf } from '../../src/domain/replica/entry';
export { x25519BindingBytes } from '../../src/domain/replica/cellKeys';
// 33.2-04: the person's post-quantum keys in the Transit envelope and their binding (device.kem).
export { kemPrivateFromSeeds, kemPublicFromSeeds, newKemSeeds, probeWrapV2 } from '../../src/domain/replica/cellWrapV2';
export { kemBindingBytes, kemKeysAt } from '../../src/domain/replica/deviceKem';
export { DeviceKeyRing, ENCRYPTION_KEY_SECRET, EPOCH_KEY_SECRET_PREFIX, forgetJoinSecret, JOIN_SECRET_PREFIX, joinSecret, storeJoinSecret } from '../../src/staff/replica/keyring';
// 33-24: the live engine of the staff backend. The replica project, the live replicator and what runs beside them: the sync status store, the
// feature check, the projector and the compactor. decodeHost.ts finds engine/decodeWorker.js beside this bundle, and doc.ts loads the vendored Yjs
// from engine/vendor/yjs (both written by tools/build-engine.mjs).
export { ReplicaProject, isProjectRefused, syncLocalOf } from '../../src/staff/replica/replicaProject';
export { LiveReplicator } from '../../src/staff/replica/liveReplicator';
export { hubMemoryOf } from '../../src/staff/replica/hubSync';
export { hubStanding } from '../../src/staff/replica/hubMembership';
export { readHubAddress } from '../../src/staff/replica/hubAddress';
export { ensureRequireArmed } from '../../src/staff/replica/requireGate';
export { projectLive } from '../../src/staff/replica/liveProjection';
export { projectionInputOf } from '../../src/staff/replica/migrate';
export { compactAfterCheckpoint } from '../../src/staff/replica/compactor';
export { syncStatusFor } from '../../src/services/staffSyncStatus';
export { syncSentence } from '../../src/domain/staff/liveSentences';
export { UPDATE_SENTENCE } from '../../src/domain/replica/features';
export { isRosterWriterAt } from '../../src/domain/replica/roster';
export { cellOrderHook } from '../../src/staff/replica/membership';
