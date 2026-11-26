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
export { CELL_ACCESS_FEATURE, UPDATE_SENTENCE } from '../../src/domain/replica/features';
export { isRosterWriterAt } from '../../src/domain/replica/roster';
export { cellOrderHook } from '../../src/staff/replica/membership';
// 33-27: Share with people (extension/src/node/staff/share-service.ts StaffShareApi). The executed conversion, membership and hub flows, the
// single-machine copy, the hub address, re-admission and the server's twelve words.
export { makeMultiUser } from '../../src/staff/replica/migrate';
export { admitJoinRequest, cellsAt, inviteToProject, joinFromInvite, openWelcome, removeFromProject, reviewJoinRequest } from '../../src/staff/replica/membership';
export { managedWithdrawalActionBytes } from '../../src/staff/replica/managedWithdrawal';
export { HUB_GRANT_TRADE_OFF, openHubTransport, connectProjectToHub, fetchJoinRequests, grantCellToHub, inviteThroughHub, revokeHub, sendJoinRequestThroughHub } from '../../src/staff/replica/hubMembership';
export { readmitHub } from '../../src/staff/replica/hubReadmit';
export { writeHubAddress } from '../../src/staff/replica/hubAddress';
export { makeSingleMachineCopy } from '../../src/staff/replica/singleCopy';
export { hubIdOf, isHubAddress } from '../../src/domain/replica/hubFile';
export { readInvite } from '../../src/domain/replica/invite';
export { memberAt } from '../../src/domain/replica/rosterMembers';
export { serverPinWords } from '../../src/domain/replica/serverWords';
export { conversionNoticeLines } from '../../src/domain/staff/conversionNotice';
export { SCALE_PRESETS, labelKey } from '../../src/domain/gate/labels';
// 33-25: the editor binding core (33-04) runs unchanged in the backend over the document channel, and the product files a bound editor opens are
// found by the projection's own paths and headers.
export { EditorBinding, HEADER_KEPT_TEXT, RESYNC_LOG_LINE } from '../../src/staff/replica/editorBinding';
export { projectProductFile, projectProductStates } from '../../src/staff/replica/projection';
export { staffProductPath } from '../../src/domain/staff/writeLimits';
// 33-26: the native Staff Room. The live model, the version acts with their decision stamp, the contested cards and version rows, and the roster split.
export { memberNameAt, staffRoomLive, whoCanSee } from '../../src/domain/staff/staffRoomLive';
export { CHANGED_WHILE_DECIDING_TEXT, VersionActs } from '../../src/staff/replica/versionActs';
export { changesSinceRows, contestedCards, pendingConfirmation } from '../../src/staff/replica/contested';
export { chooseRosterBranch, describeRosterBranches } from '../../src/staff/replica/membership';
// 33.2-07: the switch to post-quantum keys in the Staff Room: this computer's cards and the three actions (switch, move, give keys).
export { giveKeys, moveCellsToV2, switchToV2, wrapCardsFor } from '../../src/staff/replica/wrapUpgrade';
