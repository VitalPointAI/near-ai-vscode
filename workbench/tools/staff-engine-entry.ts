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
