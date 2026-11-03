// Key delivery (TEAM-02, D-15, D-21 to D-25). The lead's client confirms a member, creates that member's NEAR API key in the team workspace with
// the allocation as its spend limit in the same create call, seals the key to each of the member's seal-capable devices, and records only the
// key id and the sealed entries in the signed log. The member's client opens its entry with the X25519 key kept in SecretStorage and installs
// the key as the project's active credential. The clear key is a Buffer between the create answer and the seal on the lead's side, and between
// the open and the install on the member's side; both are zero-filled in finally blocks. It is never logged, put in an error, a checklist item,
// a local file or an event. This module never imports `vscode`.
import { createHash, randomBytes } from 'node:crypto';
import { keyNeedsRotation, sealCapableFingerprints } from '../domain/team/invite';
import type { Member, NearLink, SealedEntryBody, TeamFile } from '../domain/team/types';
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike } from '../services/reportingSignIn';
import type { CleanupChecklist, CleanupStep } from './cleanupChecklist';
import { NoDeviceKeyError } from './eventLog';
import type { TeamLog } from './eventLog';
import { loadSealIdentity } from './identity';
import { SEAL_SCHEME, sealTo, wipe } from './keySeal';
import type { CreatedNearKey, NearOrgClient } from './nearOrg';
import { NearOrgError, scrubNearText } from './nearOrg';
import { NearSessionError } from './nearSession';
import { redactGitMessage } from './runGit';
import { SecretLeakError } from '../domain/team/secrets';
import { NearPinError, checkNearPin, teamStorageDir } from './teamFile';
import { installTeamKey, readInstalledKey } from './teamKeyProfile';
import type { AppendResult } from './transport';

export type DeliveryResult = { ok: true; keyId: string; notice?: string } | { ok: false; code: 'no-device' | 'not-linked' | 'near' | 'log' | 'signed-out'; message: string };
export type ConfirmResult =
  | { ok: true; roleChanged: boolean; key: 'delivered' | 'queued' | 'not-applicable'; message: string }
  | { ok: false; code: 'not-pending' | 'refused' | 'conflict' | 'offline'; message: string };
export type InstallDeliveredResult = { status: 'installed'; keyId: string } | { status: 'none' | 'already-installed' | 'not-for-this-device' } | { status: 'failed'; message: string };

/** The steps a confirmation or key delivery reports while it runs, so the caller can say what is happening (UI review issue 1). */
export type DeliveryStep = 'confirm' | 'read-old' | 'create' | 'seal' | 'log' | 'retire';

interface LeadInput { log: TeamLog; teamFile: TeamFile; memberId: string; org: NearOrgClient; checklist: CleanupChecklist; onStep?: (step: DeliveryStep) => void }

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

function errorText(error: unknown): string {
  return scrubNearText(error instanceof Error ? error.message : String(error));
}

function nearFailure(error: unknown): DeliveryResult {
  if (error instanceof NearSessionError && (error.code === 'signed-out' || error.code === 'expired')) return fail('signed-out', error.message);
  return fail('near', errorText(error));
}

export const signInToSendKeyText = (memberName: string): string => `Sign in to NEAR to send ${memberName}'s key.`;

const NOT_LINKED_TEXT = 'This team is not linked to a NEAR organization, so there is no key to send.';

// CR-01: the workspace a key is created, capped and revoked in is team.json `near`, but only when it matches the link this computer pinned.
async function trustedLink(teamFile: TeamFile, storageDir: string): Promise<{ ok: true; near: NearLink | undefined } | { ok: false; message: string }> {
  try {
    return { ok: true, near: await checkNearPin(storageDir, teamFile) };
  } catch (error) {
    if (error instanceof NearPinError) return { ok: false, message: error.message };
    return { ok: false, message: `The saved NEAR link for this team could not be checked, so no NEAR key was changed: ${errorText(error)}` };
  }
}

// ---- the lead's cleanup list (D-18, D-25) -------------------------------------------------------------------------------------------------

type Person = { id: string; name: string };
type OpenStatus = 'pending' | 'failed' | 'manual';

// Records one unfinished NEAR step. An open item for the same member and step (and key, when one is named) is updated, so a retry never
// piles up duplicates, and a failed attempt counts. Returns a sentence when the list itself could not be saved, never throws.
async function note(checklist: CleanupChecklist, person: Person, step: CleanupStep, status: OpenStatus, lastError?: string, keyId?: string): Promise<string | undefined> {
  try {
    const open = (await checklist.forMember(person.id)).find((item) => item.step === step && item.status !== 'done' && (keyId === undefined || item.keyId === keyId));
    if (open !== undefined) {
      await checklist.update(open.id, { status, ...(lastError === undefined ? {} : { lastError }), ...(status === 'failed' ? { attempted: true } : {}) });
      return undefined;
    }
    const [created] = await checklist.add([{ memberId: person.id, memberName: person.name, step, status, ...(keyId === undefined ? {} : { keyId }), ...(lastError === undefined ? {} : { lastError }) }]);
    if (status === 'failed' && created !== undefined) await checklist.update(created.id, { attempted: true });
    return undefined;
  } catch (error) {
    return `The cleanup list could not be saved: ${errorText(error)}`;
  }
}

// A step that went through settles every open item for it.
async function settle(checklist: CleanupChecklist, person: Person, step: CleanupStep): Promise<string | undefined> {
  try {
    for (const item of await checklist.forMember(person.id)) {
      if (item.step === step && item.status !== 'done') await checklist.update(item.id, { status: 'done' });
    }
    return undefined;
  } catch (error) {
    return `The cleanup list could not be updated: ${errorText(error)}`;
  }
}

const joinNotes = (notes: Array<string | undefined>): string => notes.filter((text): text is string => text !== undefined && text !== '').join(' ');

const KEY_NOT_FOUND_TEXT = 'NEAR did not find this key in the linked workspace, so it was not capped or revoked here. Find it in the NEAR console, set its limit to 0 and revoke it.';

// Sets a key to a limit of 0 and then revokes it, in that order so a half-finished clean-up never leaves a spendable key. A key NEAR does not
// find in the linked workspace is never counted as done (CR-01): it becomes a manual item for the NEAR console. A step that failed goes on the
// list with the key id; when the revoke worked the zero-limit step no longer matters. Returns the sentences to add to what the lead is told.
async function retireKey(input: LeadInput, near: NearLink, person: Person, keyId: string): Promise<string[]> {
  let zeroError: string | undefined;
  try {
    if (await input.org.setSpendLimit(near.workspaceId, keyId, 0) === 'missing') zeroError = KEY_NOT_FOUND_TEXT;
  } catch (error) {
    zeroError = errorText(error);
  }
  try {
    if (await input.org.revokeKey(near.workspaceId, keyId) === 'missing') {
      const problem = await note(input.checklist, person, 'revoke-key', 'manual', KEY_NOT_FOUND_TEXT, keyId);
      return ['NEAR did not find a key it should have in the linked workspace, so that key was not revoked here. It is on your cleanup list; check it in the NEAR console.', ...(problem === undefined ? [] : [problem])];
    }
    return [];
  } catch (error) {
    const sentences = [await note(input.checklist, person, 'revoke-key', 'failed', errorText(error), keyId)];
    if (zeroError !== undefined) sentences.push(await note(input.checklist, person, 'zero-limit', zeroError === KEY_NOT_FOUND_TEXT ? 'manual' : 'failed', zeroError, keyId));
    return [zeroError === undefined ? 'The unused key could not be revoked. It has a limit of 0 and is on your cleanup list.' : 'The unused key could not be zeroed or revoked. It is on your cleanup list.', ...sentences.filter((text): text is string => text !== undefined)];
  }
}

// Records a failed delivery and says what happened. A missing sign-in is pending (nothing was tried); everything else is a failed attempt.
async function recordFailure(input: LeadInput, person: Person, step: CleanupStep, result: Extract<DeliveryResult, { ok: false }>, extra: string[] = []): Promise<DeliveryResult> {
  const signedOut = result.code === 'signed-out';
  const problem = await note(input.checklist, person, step, signedOut ? 'pending' : 'failed', signedOut ? signInToSendKeyText(person.name) : result.message);
  const message = joinNotes([result.message, ...extra, problem]);
  return { ok: false, code: result.code, message };
}

type Checked = { ok: true; member: Member; targets: SealTarget[]; near: NearLink } | { ok: false; result: DeliveryResult };

// Who can be given a key: joined, not removed, not the owner, and with at least one device that can receive a sealed key. The team must have
// a NEAR link this computer trusts.
async function checkTarget(input: LeadInput, step: CleanupStep): Promise<Checked> {
  const link = await trustedLink(input.teamFile, input.checklist.storageDir);
  if (!link.ok) return { ok: false, result: fail('not-linked', link.message) };
  const near = link.near;
  if (near === undefined) return { ok: false, result: fail('not-linked', NOT_LINKED_TEXT) };
  const state = input.log.state();
  const member = state.members.get(input.memberId);
  if (member === undefined || member.removedEvent !== undefined || member.status === 'invited') {
    return { ok: false, result: fail('no-device', 'That person has not joined the team, so there is no device to send a key to.') };
  }
  if (member.id === state.team.ownerId) return { ok: false, result: fail('log', 'The team owner does not get a key through the log.') };
  if (step === 'rotate-key' && !keyNeedsRotation(member)) return { ok: false, result: fail('log', `${member.name}'s key already matches their devices, so it does not need to be replaced.`) };
  const targets = sealTargets(member);
  if (targets.length === 0) {
    // 61-05 leaves this wording to the delivery step: after a revoke the old key is still valid wherever it was already installed.
    const message = step === 'rotate-key'
      ? `${member.name} has no device that can receive a new key. Ask them to add a device from a computer that has joined the team. Until a new key is sent, their old key stays valid on every computer that already has it.`
      : `${member.name} has no device that can receive a key. Ask them to join again from their computer.`;
    return { ok: false, result: await recordFailure(input, member, step, { ok: false, code: 'no-device', message }) };
  }
  return { ok: true, member, targets, near };
}

// Whether a member.key-sealed whose push answer was lost is in the log: only a successful read of the log settles it.
async function deliveryLanded(log: TeamLog, memberId: string, keyId: string): Promise<'landed' | 'absent' | 'unknown'> {
  try {
    await log.sync();
    if (log.status().state !== 'ok') return 'unknown';
    return log.state().members.get(memberId)?.nearApiKeyId === keyId ? 'landed' : 'absent';
  } catch {
    // The check itself could not be made, which is the same as not knowing.
    return 'unknown';
  }
}

const unknownDeliveryText = (name: string, keyId: string): string =>
  `It is not known whether ${name}'s new key reached the team record, because the team could not be reached to check. The key was kept, so a delivery that did land still works. When you are online, open "NEAR AI: Manage Team Members": if ${name} still needs a key, revoke key ${keyId} in the NEAR console and send a new one.`;

// Creates the key with its cap in the create call, seals it to every target, and appends member.key-sealed. The append builder re-checks the
// fresh state: the member must still be there, still hold the key this delivery replaces, and still have exactly the sealed set of devices.
// Whatever goes wrong, the confirmation stands, a key that was made is zeroed and revoked, and a Retry item is left (D-25).
async function sendKey(input: LeadInput, near: NearLink, step: CleanupStep, member: Member, targets: SealTarget[], limit: number, retire?: string): Promise<DeliveryResult> {
  const replaces = member.nearApiKeyId;
  const fingerprints = targets.map((target) => target.fingerprint);
  let created: CreatedNearKey;
  input.onStep?.('create');
  try {
    created = await input.org.createKey(near.workspaceId, teamKeyName(input.teamFile.name, member.name, deliveryToken(fingerprints)), limit);
  } catch (error) {
    const failed = nearFailure(error);
    return failed.ok ? failed : recordFailure(input, member, step, failed);
  }
  const keyId = created.key.id;
  const abandon = async (failed: Extract<DeliveryResult, { ok: false }>): Promise<DeliveryResult> =>
    recordFailure(input, member, step, failed, await retireKey(input, near, member, keyId));

  let sealed: SealedEntryBody[];
  input.onStep?.('seal');
  try {
    sealed = targets.map((target) => sealTo(created.secret, target.sealKey, { teamId: input.teamFile.teamId, memberId: member.id, device: target.fingerprint, keyId }));
  } catch (error) {
    return abandon({ ok: false, code: 'log', message: `The key could not be sealed for ${member.name}: ${errorText(error)}` });
  } finally {
    wipe(created.secret);
  }
  let appended: AppendResult;
  input.onStep?.('log');
  try {
    appended = await input.log.append((state) => {
      const fresh = state.members.get(member.id);
      if (fresh === undefined || fresh.removedEvent !== undefined) return { conflict: `${member.name} was removed from the team, so the key was not sent.` };
      if (fresh.nearApiKeyId !== replaces) return { conflict: `Another lead already sent ${member.name} a new key.` };
      if (!sameList(sealCapableFingerprints(fresh), fingerprints)) return { conflict: `${member.name}'s devices changed while the key was being made.` };
      return [{ type: 'member.key-sealed', body: { memberId: member.id, keyId, scheme: SEAL_SCHEME, sealed } }];
    });
  } catch (error) {
    // Refused before anything was pushed: a secret in the event or no device key. Any other throw may have come after the push started.
    if (error instanceof SecretLeakError || error instanceof NoDeviceKeyError) return abandon({ ok: false, code: 'log', message: error.message });
    appended = { ok: false, kind: 'offline', reason: redactGitMessage(errorText(error)), attempts: 0 };
  }
  if (!appended.ok) {
    // WR-01: only an answer that says the event was not written may revoke the key. An offline answer may hide a push that landed, and then
    // the log already names this key as the member's, so only a fresh read of the log decides.
    if (appended.kind !== 'offline') return abandon({ ok: false, code: 'log', message: redactGitMessage(appended.reason) });
    const landing = await deliveryLanded(input.log, member.id, keyId);
    if (landing === 'absent') return abandon({ ok: false, code: 'log', message: redactGitMessage(appended.reason) });
    if (landing === 'unknown') {
      const text = unknownDeliveryText(member.name, keyId);
      const problem = await note(input.checklist, member, step, 'manual', text, keyId);
      return { ok: false, code: 'log', message: joinNotes([text, problem]) };
    }
  }
  // Only now, with the new key accepted by the log, is the old one taken away: zeroed first, then revoked.
  const settled = await settle(input.checklist, member, step);
  if (retire !== undefined) input.onStep?.('retire');
  const retired = retire === undefined ? [] : await retireKey(input, near, member, retire);
  const notice = joinNotes([settled, ...retired]);
  return notice === '' ? { ok: true, keyId } : { ok: true, keyId, notice };
}

/** Sends a joined member their first key, capped at their allocation. */
export async function deliverMemberKey(input: LeadInput): Promise<DeliveryResult> {
  const checked = await checkTarget(input, 'deliver-key');
  if (!checked.ok) return checked.result;
  if (checked.member.nearApiKeyId !== undefined) return fail('log', `${checked.member.name} already has a key.`);
  return sendKey(input, checked.near, 'deliver-key', checked.member, checked.targets, checked.member.allocationNanoUsd ?? 0);
}

/**
 * Replaces a member's key after a device was added or revoked (D-24). The new key's cap is the old key's cap minus its lifetime usage, never
 * below 0, so a rotation cannot give a member a second budget. The new key is delivered first; only then is the old key set to 0 and revoked.
 */
export async function rotateMemberKey(input: LeadInput): Promise<DeliveryResult> {
  const checked = await checkTarget(input, 'rotate-key');
  if (!checked.ok) return checked.result;
  const { member, targets, near } = checked;
  const oldKeyId = member.nearApiKeyId;
  if (oldKeyId === undefined) return fail('log', `${member.name} has no key to replace.`);

  let limit = 0;
  let manual: string | undefined;
  input.onStep?.('read-old');
  try {
    const old = await input.org.findKey(near.workspaceId, oldKeyId);
    if (old === undefined) {
      manual = `NEAR no longer has ${member.name}'s earlier key, so the new key was given a limit of 0. Raise it in the NEAR console once you know what is left.`;
    } else if (old.spendLimitNanoUsd === null || old.usageNanoUsd === null || !Number.isSafeInteger(old.spendLimitNanoUsd) || !Number.isSafeInteger(old.usageNanoUsd)) {
      manual = `NEAR did not report the limit and usage of ${member.name}'s earlier key, so the new key was given a limit of 0. Raise it in the NEAR console once you know what is left.`;
    } else {
      limit = Math.max(0, old.spendLimitNanoUsd - old.usageNanoUsd);
    }
  } catch (error) {
    const failed = nearFailure(error);
    return failed.ok ? failed : recordFailure(input, member, 'rotate-key', failed);
  }

  const sent = await sendKey(input, near, 'rotate-key', member, targets, limit, oldKeyId);
  if (!sent.ok || manual === undefined) return sent;
  const problem = await note(input.checklist, member, 'rotate-key', 'manual', manual, oldKeyId);
  return { ok: true, keyId: sent.keyId, notice: joinNotes([sent.notice, manual, problem]) };
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
    input.onStep?.('confirm');
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
  if (input.org === undefined) {
    // No NEAR session on this computer: nothing can be created, so the key waits on the cleanup list with the way to send it.
    const problem = keyDue ? await note(input.checklist, member, 'deliver-key', 'pending', signInToSendKeyText(member.name)) : undefined;
    return { ok: true, roleChanged, key: 'queued', message: joinNotes([confirmed, 'Their key was not sent because you are not signed in to NEAR.', problem]) };
  }
  const delivery = await deliverMemberKey({ log: input.log, teamFile: input.teamFile, memberId: input.memberId, org: input.org, checklist: input.checklist, ...(input.onStep === undefined ? {} : { onStep: input.onStep }) });
  if (delivery.ok) return { ok: true, roleChanged, key: 'delivered', message: joinNotes([confirmed, 'Their NEAR key was sent to their computer.', delivery.notice]) };
  return { ok: true, roleChanged, key: 'queued', message: joinNotes([confirmed, `Their key was not sent: ${delivery.message}`]) };
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
  if (event === undefined || event.type !== 'member.key-sealed') return { status: 'failed', message: 'The key delivery for this computer could not be found in the team record yet. Try again after the next sync.' };
  const body = event.body;
  if (body.memberId !== memberId || body.keyId !== keyId) return { status: 'failed', message: 'The key delivery in the team record does not match this member.' };
  const entry = body.sealed.find((candidate) => candidate.device === input.deviceFingerprint);
  if (entry === undefined) return { status: 'not-for-this-device' };

  // CR-01: the organization and workspace the key must belong to come from a link this computer trusts, never from an edited team.json alone.
  const link = await trustedLink(input.teamFile, teamStorageDir(input.globalStorageDir, input.teamFile.teamId));
  if (!link.ok) return { status: 'failed', message: link.message };
  const expect = link.near;

  const seal = await loadSealIdentity(input.secrets, input.teamFile.teamId);
  if (seal === undefined) return { status: 'failed', message: 'This computer has no key to open the delivery with. Join the team again from this computer.' };
  const opened = seal.open(entry, { teamId: input.teamFile.teamId, memberId, device: input.deviceFingerprint, keyId });
  if (opened === undefined) return { status: 'failed', message: 'The key delivery could not be opened on this computer. Ask the lead to send a new one.' };
  try {
    const installed = await installTeamKey({
      projectRoot: input.projectRoot, globalStorageDir: input.globalStorageDir, teamId: input.teamFile.teamId, teamName: input.teamFile.name, secrets: input.secrets,
      apiKey: opened, baseUrl: input.baseUrl, ...(expect === undefined ? {} : { expect }), keyId,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.sleep === undefined ? {} : { sleep: input.sleep })
    });
    return installed.ok ? { status: 'installed', keyId } : { status: 'failed', message: installed.message };
  } finally {
    wipe(opened);
  }
}
