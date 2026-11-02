// Key delivery (TEAM-02, D-15, D-21 to D-25). The lead's client confirms a member, creates that member's NEAR API key in the team workspace with
// the allocation as its spend limit in the same create call, seals the key to each of the member's seal-capable devices, and records only the
// key id and the sealed entries in the signed log. The member's client opens its entry with the X25519 key kept in SecretStorage and installs
// the key as the project's active credential. The clear key is a Buffer between the create answer and the seal on the lead's side, and between
// the open and the install on the member's side; both are zero-filled in finally blocks. It is never logged, put in an error, a checklist item,
// a local file or an event. This module never imports `vscode`.
import { createHash, randomBytes } from 'node:crypto';
import { sealCapableFingerprints } from '../domain/team/invite';
import type { Member, SealedEntryBody, TeamFile } from '../domain/team/types';
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike } from '../services/reportingSignIn';
import type { CleanupChecklist } from './cleanupChecklist';
import { NoDeviceKeyError } from './eventLog';
import type { TeamLog } from './eventLog';
import { loadSealIdentity } from './identity';
import { SEAL_SCHEME, sealTo, wipe } from './keySeal';
import type { CreatedNearKey, NearOrgClient } from './nearOrg';
import { NearOrgError, scrubNearText } from './nearOrg';
import { NearSessionError } from './nearSession';
import { redactGitMessage } from './runGit';
import { SecretLeakError } from '../domain/team/secrets';
import { installTeamKey, readInstalledKey } from './teamKeyProfile';
import type { AppendResult } from './transport';

export type DeliveryResult = { ok: true; keyId: string } | { ok: false; code: 'no-device' | 'not-linked' | 'near' | 'log' | 'signed-out'; message: string };
export type ConfirmResult =
  | { ok: true; roleChanged: boolean; key: 'delivered' | 'queued' | 'not-applicable'; message: string }
  | { ok: false; code: 'not-pending' | 'refused' | 'conflict' | 'offline'; message: string };
export type InstallDeliveredResult = { status: 'installed'; keyId: string } | { status: 'none' | 'already-installed' | 'not-for-this-device' } | { status: 'failed'; message: string };

interface LeadInput { log: TeamLog; teamFile: TeamFile; memberId: string; org: NearOrgClient; checklist: CleanupChecklist }

const MAX_KEY_NAME = 100;
const NAME_SEPARATOR = ' - ';
const UNIQUE_BYTES = 4;

// ---- the key's name ---------------------------------------------------------------------------------------------------------------------

const plain = (text: string): string => text.replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/ +/g, ' ').trim();

/**
 * A name NEAR accepts for a member's key: letters, digits, space, dot, underscore and hyphen, at most 100 characters. The last part is the
 * caller's unique token, kept whole, because createKey finds a key it may have made by its exact name and must never match an older key.
 */
export function teamKeyName(teamName: string, memberName: string, fingerprint: string): string {
  const token = plain(fingerprint).replace(/ /g, '-').slice(0, 40) || 'key';
  const room = MAX_KEY_NAME - 2 * NAME_SEPARATOR.length - token.length;
  const team = (plain(teamName) || 'Team').slice(0, Math.max(1, Math.floor(room / 2))).trim();
  const member = (plain(memberName) || 'Member').slice(0, Math.max(1, room - team.length)).trim();
  return `${team}${NAME_SEPARATOR}${member}${NAME_SEPARATOR}${token}`;
}

// One token per delivery: the device set it is for and a random part, so two deliveries never share a name.
function deliveryToken(fingerprints: readonly string[]): string {
  return `k${createHash('sha256').update(fingerprints.join(',')).digest('hex').slice(0, 8)}-${randomBytes(UNIQUE_BYTES).toString('hex')}`;
}

// ---- the lead side ----------------------------------------------------------------------------------------------------------------------

interface SealTarget { fingerprint: string; sealKey: string }

function sealTargets(member: Member): SealTarget[] {
  const wanted = sealCapableFingerprints(member);
  return wanted.flatMap((fingerprint) => {
    const sealKey = member.devices.find((device) => device.fingerprint === fingerprint)?.sealKey;
    return sealKey === undefined ? [] : [{ fingerprint, sealKey }];
  });
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

function fail(code: Extract<DeliveryResult, { ok: false }>['code'], message: string): DeliveryResult {
  return { ok: false, code, message };
}

function nearFailure(error: unknown): DeliveryResult {
  if (error instanceof NearSessionError && (error.code === 'signed-out' || error.code === 'expired')) return fail('signed-out', error.message);
  return fail('near', scrubNearText(error instanceof NearOrgError || error instanceof Error ? error.message : String(error)));
}

type Checked = { ok: true; member: Member; targets: SealTarget[] } | { ok: false; result: DeliveryResult };

// Who can be given a key: joined, not removed, not the owner, and with at least one device that can receive a sealed key.
function checkTarget(input: LeadInput): Checked {
  if (input.teamFile.near === undefined) return { ok: false, result: fail('not-linked', 'This team is not linked to a NEAR organization, so there is no key to send.') };
  const state = input.log.state();
  const member = state.members.get(input.memberId);
  if (member === undefined || member.removedEvent !== undefined || member.status === 'invited') {
    return { ok: false, result: fail('no-device', 'That person has not joined the team, so there is no device to send a key to.') };
  }
  if (member.id === state.team.ownerId) return { ok: false, result: fail('log', 'The team owner does not get a key through the log.') };
  const targets = sealTargets(member);
  if (targets.length === 0) return { ok: false, result: fail('no-device', `${member.name} has no device that can receive a key. Ask them to join again from their computer.`) };
  return { ok: true, member, targets };
}

// Creates the key with its cap in the create call, seals it to every target, and appends member.key-sealed. The append builder re-checks the
// fresh state: the member must still be there, still hold the key this delivery replaces, and still have exactly the sealed set of devices.
async function sendKey(input: LeadInput, member: Member, targets: SealTarget[], limit: number): Promise<DeliveryResult> {
  const near = input.teamFile.near;
  if (near === undefined) return fail('not-linked', 'This team is not linked to a NEAR organization, so there is no key to send.');
  const replaces = member.nearApiKeyId;
  const fingerprints = targets.map((target) => target.fingerprint);
  let created: CreatedNearKey;
  try {
    created = await input.org.createKey(near.workspaceId, teamKeyName(input.teamFile.name, member.name, deliveryToken(fingerprints)), limit);
  } catch (error) {
    return nearFailure(error);
  }
  const keyId = created.key.id;
  let sealed: SealedEntryBody[];
  try {
    sealed = targets.map((target) => sealTo(created.secret, target.sealKey, { teamId: input.teamFile.teamId, memberId: member.id, device: target.fingerprint, keyId }));
  } finally {
    wipe(created.secret);
  }
  let appended: AppendResult;
  try {
    appended = await input.log.append((state) => {
      const fresh = state.members.get(member.id);
      if (fresh === undefined || fresh.removedEvent !== undefined) return { conflict: `${member.name} was removed from the team, so the key was not sent.` };
      if (fresh.nearApiKeyId !== replaces) return { conflict: `Another lead already sent ${member.name} a new key.` };
      if (!sameList(sealCapableFingerprints(fresh), fingerprints)) return { conflict: `${member.name}'s devices changed while the key was being made.` };
      return [{ type: 'member.key-sealed', body: { memberId: member.id, keyId, scheme: SEAL_SCHEME, sealed } }];
    });
  } catch (error) {
    if (error instanceof SecretLeakError || error instanceof NoDeviceKeyError) return fail('log', error.message);
    throw error;
  }
  if (!appended.ok) return fail('log', redactGitMessage(appended.reason));
  return { ok: true, keyId };
}

/** Sends a joined member their first key, capped at their allocation. */
export async function deliverMemberKey(input: LeadInput): Promise<DeliveryResult> {
  const checked = checkTarget(input);
  if (!checked.ok) return checked.result;
  if (checked.member.nearApiKeyId !== undefined) return fail('log', `${checked.member.name} already has a key.`);
  return sendKey(input, checked.member, checked.targets, checked.member.allocationNanoUsd ?? 0);
}

export async function rotateMemberKey(_input: LeadInput): Promise<DeliveryResult> {
  throw new Error('not implemented');
}

function confirmFailure(result: Extract<AppendResult, { ok: false }>): ConfirmResult {
  const message = redactGitMessage(result.reason);
  switch (result.kind) {
    case 'offline':
      return { ok: false, code: 'offline', message };
    case 'conflict':
    case 'busy':
      return { ok: false, code: 'conflict', message };
    default:
      return { ok: false, code: 'refused', message };
  }
}

/**
 * Confirms a member waiting for their invited role (member.role-changed), then in a NEAR-linked team sends their key. A member who joined
 * with their final role and still has no key is given the key through the same call. The confirmation stands whatever happens to the key.
 */
export async function confirmMember(input: Omit<LeadInput, 'org'> & { org?: NearOrgClient }): Promise<ConfirmResult> {
  const state = input.log.state();
  const member = state.members.get(input.memberId);
  const notPending: ConfirmResult = { ok: false, code: 'not-pending', message: 'That person is not waiting for a confirmation or a key.' };
  if (member === undefined || member.removedEvent !== undefined || member.status === 'invited' || member.id === state.team.ownerId) return notPending;
  const keyDue = input.teamFile.near !== undefined && member.nearApiKeyId === undefined && sealCapableFingerprints(member).length > 0;
  if (member.pendingRole === undefined && !keyDue) return notPending;

  let roleChanged = false;
  if (member.pendingRole !== undefined) {
    const appended = await input.log.append((fresh) => {
      const current = fresh.members.get(input.memberId);
      if (current === undefined || current.removedEvent !== undefined) return { conflict: `${member.name} was removed from the team, so nothing was confirmed.` };
      if (current.pendingRole === undefined) return { conflict: `${member.name} was already confirmed by another lead.` };
      return [{ type: 'member.role-changed', body: { memberId: input.memberId, role: current.pendingRole } }];
    });
    if (!appended.ok) return confirmFailure(appended);
    roleChanged = true;
  }
  const role = input.log.state().members.get(input.memberId)?.role ?? member.role;
  const confirmed = roleChanged ? `${member.name} is confirmed as ${role}.` : '';
  if (input.teamFile.near === undefined) return { ok: true, roleChanged, key: 'not-applicable', message: confirmed };
  if (input.org === undefined) return { ok: true, roleChanged, key: 'queued', message: `${confirmed} Their key was not sent because you are not signed in to NEAR.`.trim() };
  const delivery = await deliverMemberKey({ log: input.log, teamFile: input.teamFile, memberId: input.memberId, org: input.org, checklist: input.checklist });
  if (delivery.ok) return { ok: true, roleChanged, key: 'delivered', message: `${confirmed} Their NEAR key was sent to their computer.`.trim() };
  return { ok: true, roleChanged, key: 'queued', message: `${confirmed} Their key was not sent: ${delivery.message}`.trim() };
}

// ---- the member side --------------------------------------------------------------------------------------------------------------------

export interface InstallDeliveredInput {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  log: TeamLog;
  deviceFingerprint: string;
  secrets: SecretStorageLike;
  baseUrl: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Finds this device's sealed entry for the member's current key, opens it with the seal key in SecretStorage and installs it as the project's
 * active team key after NEAR confirms the organization and workspace. The key id of what is installed is remembered so a later call can tell.
 */
export async function installDeliveredKey(input: InstallDeliveredInput): Promise<InstallDeliveredResult> {
  const state = input.log.state();
  const memberId = state.deviceIndex.get(input.deviceFingerprint);
  const member = memberId === undefined ? undefined : state.members.get(memberId);
  if (member === undefined || memberId === undefined || member.removedEvent !== undefined) return { status: 'none' };
  const keyId = member.nearApiKeyId;
  const eventId = member.nearKeyEvent;
  if (keyId === undefined || eventId === undefined) return { status: 'none' };
  if ((await readInstalledKey(input.globalStorageDir, input.teamFile.teamId))?.keyId === keyId) return { status: 'already-installed' };
  if (!(member.nearKeyDevices ?? []).includes(input.deviceFingerprint)) return { status: 'not-for-this-device' };

  const event = await input.log.findEvent(eventId);
  if (event === undefined || event.type !== 'member.key-sealed') return { status: 'failed', message: 'The key delivery for this computer could not be found in the team log yet. Try again after the next sync.' };
  const body = event.body;
  if (body.memberId !== memberId || body.keyId !== keyId) return { status: 'failed', message: 'The key delivery in the team log does not match this member.' };
  const entry = body.sealed.find((candidate) => candidate.device === input.deviceFingerprint);
  if (entry === undefined) return { status: 'not-for-this-device' };

  const seal = await loadSealIdentity(input.secrets, input.teamFile.teamId);
  if (seal === undefined) return { status: 'failed', message: 'This computer has no key to open the delivery with. Join the team again from this computer.' };
  const opened = seal.open(entry, { teamId: input.teamFile.teamId, memberId, device: input.deviceFingerprint, keyId });
  if (opened === undefined) return { status: 'failed', message: 'The key delivery could not be opened on this computer. Ask the lead to send a new one.' };
  try {
    const installed = await installTeamKey({
      projectRoot: input.projectRoot, globalStorageDir: input.globalStorageDir, teamId: input.teamFile.teamId, teamName: input.teamFile.name, secrets: input.secrets,
      apiKey: opened, baseUrl: input.baseUrl, ...(input.teamFile.near === undefined ? {} : { expect: input.teamFile.near }), keyId,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.sleep === undefined ? {} : { sleep: input.sleep })
    });
    return installed.ok ? { status: 'installed', keyId } : { status: 'failed', message: installed.message };
  } finally {
    wipe(opened);
  }
}
