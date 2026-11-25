// The identity engine the workbench backend calls (Phase 71, 71-10): the same pure did:webvh, credential and device-word code the extension, the
// hub and the fold use, bundled by tools/build-engine.mjs into engine/identity.cjs and loaded by the backend on first use.
export { buildGenesisEntry, verifyWebvhLog } from '../../src/domain/did/didWebvh';
export { encodePublicKeyMultibase } from '../../src/domain/credentials/multibase';
export { issueCredential } from '../../src/domain/credentials/profile';
export { CREDENTIAL_CONTEXTS } from '../../src/domain/credentials/context';
export { SCALE_PRESETS } from '../../src/domain/gate/labels';
export { deviceFingerprint, deviceIdentityWords } from '../../src/domain/did/deviceWords';
