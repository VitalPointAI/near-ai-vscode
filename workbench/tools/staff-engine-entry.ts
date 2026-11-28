// The engine names the staff backend uses (Phase 33 D-51; the Phase 46 D-15 pattern): bundled by tools/build-engine.mjs into engine/staff.cjs and
// loaded by the backend at run time (extension/src/node/staff/staff-engine.ts). Nothing here goes to the browser bundle.
//
// 33-23: the session-key rules and the keyring, so a hosted session certifies its session key and keeps its epoch keys and join secrets in the
// person's key store. 33-24 adds the replica project and the live replicator here, with the decode worker and the vendored Yjs they load by path.
import { labelKeyShownWithMarkings as finishLabel } from '../../src/domain/gate/labelAlgebra';
import { multiUserNoticeLines } from '../../src/domain/staff/multiUser';
import { deviceAt, memberAt as managedFileMemberAt } from '../../src/domain/replica/rosterMembers';
import { isRosterWriterAt as canSendManagedFile } from '../../src/domain/replica/roster';
import type { RosterState } from '../../src/domain/replica/roster';
import { cellsAt as finishCellsAt, gateOf } from '../../src/staff/replica/membership';
import type { CellInfo, SharedProjectHost } from '../../src/staff/replica/membership';
import { managedRecipients, pendingManagedCells, prepareHostedFinish, selectedManagedAccess } from '../../src/staff/replica/managedRecovery';

import { readManagedKeyFile } from '../../src/staff/replica/managedGrantDelivery';

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
// 33-29: native cursors (presence over an open project) and Show Who Wrote This (the product's author spans and the executed attribution words).
export { openProjectPresence } from '../../src/staff/replica/projectPresence';
export { productOutput } from '../../src/staff/replica/productFeed';
export { authorRows, namesAtRegistration } from '../../src/domain/staff/whoWroteThis';
// 33-26: the native Staff Room. The live model, the version acts with their decision stamp, the contested cards and version rows, and the roster split.
export { memberNameAt, staffRoomLive, whoCanSee } from '../../src/domain/staff/staffRoomLive';
export { CHANGED_WHILE_DECIDING_TEXT, VersionActs } from '../../src/staff/replica/versionActs';
export { changesSinceRows, contestedCards, pendingConfirmation } from '../../src/staff/replica/contested';
export { chooseRosterBranch, describeRosterBranches } from '../../src/staff/replica/membership';
// 33.2-07: the switch to post-quantum keys in the Staff Room: this computer's cards and the three actions (switch, move, give keys).
export { giveKeys, moveCellsToV2, switchToV2, wrapCardsFor } from '../../src/staff/replica/wrapUpgrade';

const finishCellInfo = (host: SharedProjectHost, roster: RosterState) =>
  finishCellsAt(roster, host.project.keys, roster.positions.length - 1, gateOf(host).scales);
const pendingPartLabel = (host: SharedProjectHost, info: CellInfo) =>
  info.base ? 'Shared project' : info.label === undefined ? 'Lead-only work' : finishLabel(info.label, gateOf(host).scales);

/** Safe choices from the current private roster. Drafts and key material stay in the session backend. */
export function pendingWorkbenchFinishParts(host: SharedProjectHost, roster: RosterState) {
  const pending = pendingManagedCells(roster, host.project.deviceWriter);
  return pending === undefined ? [] : finishCellInfo(host, roster).filter((info) => info.known && pending.includes(info.cell))
    .map((info) => ({ cell: info.cell, label: pendingPartLabel(host, info) }));
}

export function prepareWorkbenchFinish(host: SharedProjectHost, roster: RosterState, cell: string, now: Date) {
  const { project } = host;
  const info = finishCellInfo(host, roster).find((part) => part.cell === cell);
  const draft = info === undefined ? undefined : prepareHostedFinish(project, roster, info, host.routing, now);
  if (draft === undefined || info === undefined) return undefined;
  const describe = (current: SharedProjectHost, fresh: RosterState, target: string) =>
    finishCellInfo(current, fresh).find((part) => part.cell === target);
  return {
    label: pendingPartLabel(host, info),
    currentBytes(current: SharedProjectHost, fresh: RosterState, time: Date): Buffer | undefined {
      const part = current.project === project ? describe(current, fresh, cell) : undefined;
      return part === undefined ? undefined : draft.currentActionBytes(fresh, part, current.routing, time);
    },
    async commit(current: SharedProjectHost, action: string) {
      const result = current.project === project ? await project.finishHostedCell(draft, action,
        (fresh, target) => describe(current, fresh, target), current.routing) : undefined;
      if (result === undefined) return { ok: false, reason: 'action-required', message: 'Start this key change again.', notices: [] };
      return 'refused' in result ? { ok: false, reason: result.refused, message: result.message, notices: [] } :
        { ok: true, message: 'This part now uses its new key.', notices: multiUserNoticeLines() };
    }
  };
}

export function workbenchManagedFileChoices(host: SharedProjectHost, roster: RosterState) {
  const { project } = host;
  const head = roster.positions.length - 1;
  const selected = selectedManagedAccess(roster, project.deviceWriter);
  if (selected === undefined) return [];
  return finishCellInfo(host, roster).flatMap((info) => {
    const evidence = selected.cells.find((item) => item.evidence.cell === info.cell && item.decision === 'continues');
    if (!info.known || evidence === undefined) return [];
    const recipients = managedRecipients(roster, evidence).flatMap((writer) => {
      const device = deviceAt(roster.members, writer, head);
      const member = device?.kind === 'person' ? managedFileMemberAt(roster.members, device.member, head) : undefined;
      return member === undefined || device === undefined ? [] : [{ writer, label: device.slot === undefined ? member.name : `${member.name}, device ${device.slot}` }];
    });
    return recipients.length === 0 ? [] : [{ cell: info.cell, label: pendingPartLabel(host, info), recipients }];
  });
}

export async function exportWorkbenchManagedFile(host: SharedProjectHost, cell: string, recipient: string, repeat?: string) {
  const { project } = host;
  const { roster } = await project.state();
  if (!canSendManagedFile(roster, project.deviceWriter, roster.positions.length - 1)) return undefined;
  const info = finishCellInfo(host, roster).find((part) => part.cell === cell && part.known);
  return info === undefined ? undefined : project.sealManagedHandoff({ cell, recipient, info, routing: host.routing }, 'file', repeat);
}

export async function openWorkbenchManagedFile({ project }: SharedProjectHost, text: unknown) {
  const packet = readManagedKeyFile(text);
  if (packet === undefined) return { ok: false, message: 'This file is not a key file SovAI can open.', notices: [] };
  const result = await project.ingestManagedGrantDelivery(packet);
  return 'refused' in result ? { ok: false, reason: result.refused, message: result.message, notices: [] } :
    { ok: true, message: 'The key file was checked. The key becomes available when this computer has the matching shared record.', notices: [] };
}
