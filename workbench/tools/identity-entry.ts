// The identity engine the workbench backend calls (Phase 71, 71-10 and 71-12): the same pure did:webvh, credential, status list and device-word code
// the extension, the hub and the fold use, bundled by tools/build-engine.mjs into engine/identity.cjs and loaded by the backend on first use.
export { buildGenesisEntry, buildUpdateEntry, methodsAt, verifyWebvhLog } from '../../src/domain/did/didWebvh';
export { COMPUTER_INDEX_FROM, computerSlotService } from '../../src/domain/credentials/computerSlots';
export { decodePublicKeyMultibase, encodePublicKeyMultibase } from '../../src/domain/credentials/multibase';
export { credentialHash, issueCredential, readCredential, verifyCredential } from '../../src/domain/credentials/profile';
export { issuerAuthority } from '../../src/domain/credentials/issuerAuthority';
export { STATUS_LIST_VALIDITY_MS, buildStatusList, clearSuspension, setBit, signStatusList, statusAt, verifyStatusList } from '../../src/domain/credentials/statusList';
export { PERSON_ATTRIBUTE_TYPES, ROLE_TYPES } from '../../src/domain/credentials/types';
export { issuableTypes, liftSentence, reviewSentence, revokeSentence, suspendSentence, typeLabel, validUntilFor, validateForm } from '../../src/domain/credentials/issueForm';
export { CREDENTIAL_CONTEXTS } from '../../src/domain/credentials/context';
export { SCALE_PRESETS } from '../../src/domain/gate/labels';
export { deviceFingerprint, deviceIdentityWords } from '../../src/domain/did/deviceWords';
