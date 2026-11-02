// The lead's side of inviting (TEAM-02, D-05, D-06, D-10, D-21, D-22). One call writes member.invited and returns the single invite bundle to
// copy. The code exists in memory and in the returned bundle only: the log gets the key derived from it, the local invite list gets who was
// invited, and the code bytes are zero-filled once the bundle is built. The repo URL is read raw from git config, cleaned of credentials, and
// never logged or placed in an error. This module never imports vscode.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SecretLeakError, assertNoSecrets } from '../domain/team/secrets';
import { INVITABLE_ROLES, ROLES } from '../domain/team/types';
import type { Role, TeamFile, TeamState } from '../domain/team/types';
import { MEMBER_ID_PATTERN, validateName } from '../domain/team/validate';
import { CleanupChecklist } from './cleanupChecklist';
import { NoDeviceKeyError } from './eventLog';
import type { EventIntent, TeamLog } from './eventLog';
import { emailHash, newMemberId } from './identity';
import { encodeInviteBundle, cleanRepoUrl } from './inviteBundle';
import { deriveInviteKey, generateInviteCode } from './inviteCode';
import { scrubNearText } from './nearOrg';
import type { NearOrgClient } from './nearOrg';
import { REMOTE_NAME_PATTERN, runSerialised, teamStorageDir, writeFileAtomic } from './teamFile';
import { gitText, redactGitMessage, runGit } from './runGit';
import type { GitRunner } from './runGit';
import type { AppendResult } from './transport';

// The lead's local display cache: who was invited, never the code and never a URL.
export const INVITE_FILE = 'invites.json';

const LOCAL_TIMEOUT_MS = 30_000;
const MAX_EMAIL_LENGTH = 254;
const MIN_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 2_592_000;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const EVENT_ID = /^evt-[0-9A-HJKMNP-TV-Z]{26}$/;
const INVITE_FILE_VERSION = 1;

export interface InviteInput {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  log: TeamLog;
  name: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  allocationNanoUsd: number;
  ttlSeconds: number;
  org?: NearOrgClient;
  git?: GitRunner;
}

export type InviteResult =
  | { ok: true; memberId: string; bundle: string; nearInvitation: 'sent' | 'already-member' | 'queued' | 'not-applicable'; notice?: string }
  | { ok: false; code: 'remote-url' | 'refused' | 'conflict' | 'offline'; message: string };

export type ReissueInput = Omit<InviteInput, 'name' | 'email' | 'role' | 'allocationNanoUsd'> & { oldMemberId: string; email: string };

export interface InviteDirectoryEntry { memberId: string; name: string; email: string; role: Role; invitedEvent: string }

function refuse(message: string): { ok: false; code: 'refused'; message: string } {
  return { ok: false, code: 'refused', message };
}

function validEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && email.includes('@') && !CONTROL_CHARACTERS.test(email) && !/\s/.test(email);
}

// ---- the local invite list --------------------------------------------------------------------------------------------------------

function inviteFilePath(storageDir: string): string {
  return path.resolve(storageDir, INVITE_FILE);
}

function parseEntry(value: unknown): InviteDirectoryEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const { memberId, name, email, role, invitedEvent } = fields;
  if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) return undefined;
  if (typeof name !== 'string' || validateName(name, 'name') !== undefined) return undefined;
  if (typeof email !== 'string' || !validEmail(email)) return undefined;
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return undefined;
  if (typeof invitedEvent !== 'string' || !EVENT_ID.test(invitedEvent)) return undefined;
  return { memberId, name, email, role: role as Role, invitedEvent };
}

async function readEntries(file: string): Promise<InviteDirectoryEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('The saved list of invitations could not be read.', { cause: error });
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['invites'] : undefined;
  if (!Array.isArray(list)) throw new Error('The saved list of invitations is not in a form this version understands.');
  // An entry that does not parse is dropped; the log still knows the invitation, only the name and email shown beside it are lost.
  return list.flatMap((item) => {
    const entry = parseEntry(item);
    return entry === undefined ? [] : [entry];
  });
}

export async function readInviteDirectory(storageDir: string): Promise<InviteDirectoryEntry[]> {
  const file = inviteFilePath(storageDir);
  return runSerialised(file, () => readEntries(file));
}

// Adds or replaces the entry for this member. The file is read again inside the serialised section, so two writers on one folder both land.
export async function recordInvite(storageDir: string, entry: InviteDirectoryEntry): Promise<void> {
  const file = inviteFilePath(storageDir);
  await runSerialised(file, async () => {
    const existing = await readEntries(file);
    const invites = [...existing.filter((item) => item.memberId !== entry.memberId), { ...entry }];
    const body = { version: INVITE_FILE_VERSION, invites };
    assertNoSecrets(body, 'The invitation list');
    await writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
  });
}

// ---- the invite ---------------------------------------------------------------------------------------------------------------------

// The remote URL exactly as configured. `git remote get-url` would apply the user's insteadOf rewrites, which can point at a private mirror
// or hold a credential helper's expansion; the teammate needs the address the project names, not the one this computer rewrites it to.
async function configuredRemoteUrl(projectRoot: string, remote: string, git: GitRunner): Promise<string> {
  if (!REMOTE_NAME_PATTERN.test(remote)) return '';
  const result = await git(['config', '--get', `remote.${remote}.url`], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  return result.code === 0 ? gitText(result) : '';
}

function failureOf(result: Extract<AppendResult, { ok: false }>): InviteResult {
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

function checkTtl(ttlSeconds: number): string | undefined {
  return Number.isSafeInteger(ttlSeconds) && ttlSeconds >= MIN_TTL_SECONDS && ttlSeconds <= MAX_TTL_SECONDS ? undefined : 'The invitation lifetime must be between 1 hour and 30 days.';
}

function checkInput(input: InviteInput): string | undefined {
  if (validateName(input.name, 'name') !== undefined) return 'The name must be 1 to 80 characters with no line breaks.';
  if (!validEmail(input.email.trim())) return 'The email address is not valid. Use a full address such as name@example.com.';
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) return 'That role cannot be invited. Choose lead, developer, reviewer or observer.';
  if (!Number.isSafeInteger(input.allocationNanoUsd) || input.allocationNanoUsd < 0) return 'The allocation must be a whole number of nano-USD, zero or more.';
  return checkTtl(input.ttlSeconds);
}

// ---- NEAR at invite time (D-21, D-22) ------------------------------------------------------------------------------------------------

type NearStep = { nearInvitation: 'sent' | 'already-member' | 'queued' | 'not-applicable'; notice?: string };

const SESSION_NEEDED = 'The team invitation is ready, but no NEAR invitation was sent because you are not signed in to NEAR. It is on your cleanup list; sign in and retry.';
const QUEUED = 'The team invitation is ready, but the NEAR organization invitation could not be sent. It is on your cleanup list so you can retry it.';

function errorText(error: unknown): string {
  return scrubNearText(error instanceof Error ? error.message : String(error));
}

// Only a lead is invited to the NEAR organization, as an admin (D-22). Everyone else gets a key from the lead's client and never touches NEAR
// (D-21). Nothing here can stop the team invitation: it is already in the log, and a failure becomes a checklist item with Retry (D-18).
async function inviteToNear(input: ReissueInput | InviteInput, ids: { memberId: string; name: string; email: string; role: Role; reissue: boolean }, storageDir: string): Promise<NearStep> {
  const near = input.teamFile.near;
  if (near === undefined || ids.role !== 'lead') return { nearInvitation: 'not-applicable' };
  const checklist = new CleanupChecklist(storageDir);
  const queue = async (status: 'pending' | 'failed', lastError?: string): Promise<NearStep> => {
    const base = { memberId: ids.memberId, memberName: ids.name, step: 'send-invitation' as const, status };
    try {
      await checklist.add([lastError === undefined ? base : { ...base, lastError }]);
    } catch (error) {
      return { nearInvitation: 'queued', notice: `${QUEUED} The cleanup list could not be saved either: ${errorText(error)}` };
    }
    return { nearInvitation: 'queued', notice: status === 'pending' ? SESSION_NEEDED : QUEUED };
  };
  if (input.org === undefined) return queue('pending');
  try {
    // A re-issue keeps the NEAR invitation the first issue sent if it is still pending: NEAR refuses a second one for the same address anyway.
    if (ids.reissue) {
      const pending = await input.org.listInvitations(near.organizationId, 'pending');
      if (pending.some((invitation) => invitation.email.toLowerCase() === ids.email.toLowerCase())) {
        return { nearInvitation: 'sent', notice: 'The NEAR invitation sent earlier is still waiting to be accepted, so no second one was sent.' };
      }
    }
    const outcome = await input.org.inviteByEmail(near.organizationId, ids.email, 'admin');
    if (outcome.ok) return { nearInvitation: outcome.alreadyMember ? 'already-member' : 'sent' };
    return queue('failed', outcome.reason);
  } catch (error) {
    return queue('failed', errorText(error));
  }
}

// ---- issuing --------------------------------------------------------------------------------------------------------------------------

interface IssuePlan { name: string; role: Exclude<Role, 'owner'>; allocationNanoUsd: number }

// Decides, from the freshest state, what the new invitation is. A re-issue also names the invitation it replaces.
type PlanOf = (state: TeamState) => ({ conflict: string } | (IssuePlan & { replaces?: string }));

async function issue(input: InviteInput | ReissueInput, email: string, plan: PlanOf, reissue: boolean): Promise<InviteResult> {
  const git = input.git ?? runGit;
  const teamId = input.teamFile.teamId;
  const raw = await configuredRemoteUrl(input.projectRoot, input.teamFile.coordination.remote, git);
  const cleaned = cleanRepoUrl(raw);
  if (!cleaned.ok) return { ok: false, code: 'remote-url', message: cleaned.reason };

  const memberId = newMemberId();
  const code = generateInviteCode();
  try {
    const invitePublicKey = deriveInviteKey(code.bytes, teamId, memberId).publicKey;
    let chosen: IssuePlan | undefined;
    let appended: AppendResult;
    try {
      // The builder runs again after every lost race, so the plan is always read from the state the event will sit on.
      appended = await input.log.append((state) => {
        const decided = plan(state);
        if ('conflict' in decided) return decided;
        chosen = { name: decided.name, role: decided.role, allocationNanoUsd: decided.allocationNanoUsd };
        const invited: EventIntent = {
          type: 'member.invited',
          body: {
            memberId, name: decided.name, emailHashes: [emailHash(teamId, email)], role: decided.role, allocationNanoUsd: decided.allocationNanoUsd,
            ttlSeconds: input.ttlSeconds, invite: { publicKey: invitePublicKey }
          }
        };
        return decided.replaces === undefined ? [invited] : [{ type: 'member.removed', body: { memberId: decided.replaces } }, invited];
      });
    } catch (error) {
      if (error instanceof SecretLeakError || error instanceof NoDeviceKeyError) return refuse(error.message);
      throw error;
    }
    if (!appended.ok) return failureOf(appended);
    const invitedEvent = appended.events.find((event) => event.type === 'member.invited');
    if (invitedEvent === undefined || chosen === undefined) return refuse('The invitation was saved but its event could not be found.');
    const { name, role } = chosen;

    const storageDir = teamStorageDir(input.globalStorageDir, teamId);
    const notices: string[] = [];
    try {
      await recordInvite(storageDir, { memberId, name, email, role, invitedEvent: invitedEvent.id });
    } catch (error) {
      // The invitation is already in the log. Losing the display cache costs only the name and email shown beside it, so the bundle is still returned.
      notices.push(`The invitation was sent, but this computer could not save it to the local invitation list: ${redactGitMessage(error instanceof Error ? error.message : String(error))}`);
    }
    const bundle = encodeInviteBundle({
      v: 1, repo: cleaned.url, team: teamId, ref: input.teamFile.coordination.ref, member: memberId, code: code.text,
      ...(input.teamFile.near === undefined ? {} : { near: { organizationId: input.teamFile.near.organizationId, workspaceId: input.teamFile.near.workspaceId } })
    });
    const near = await inviteToNear(input, { memberId, name, email, role, reissue }, storageDir);
    if (near.notice !== undefined) notices.push(near.notice);
    const result: InviteResult = { ok: true, memberId, bundle, nearInvitation: near.nearInvitation };
    if (notices.length > 0) result.notice = notices.join(' ');
    return result;
  } finally {
    // D-05: once the bundle is built the clear code is not needed again. The string copy in the bundle is the only one left.
    code.bytes.fill(0);
  }
}

export async function inviteMember(input: InviteInput): Promise<InviteResult> {
  const problem = checkInput(input);
  if (problem !== undefined) return refuse(problem);
  const plan: IssuePlan = { name: input.name.trim(), role: input.role, allocationNanoUsd: input.allocationNanoUsd };
  return issue(input, input.email.trim(), () => plan, false);
}

// D-10: a lost bundle, an expired invitation or a wrong lifetime is fixed by replacing the invitation. member.removed for the old id and
// member.invited for a new id are one batch, so the old code stops working in the same commit that the new one starts. The person, role and
// allocation carry over; the lifetime is the one given now.
export async function reissueInvite(input: ReissueInput): Promise<InviteResult> {
  if (!MEMBER_ID_PATTERN.test(input.oldMemberId)) return refuse('That invitation id is not valid.');
  const email = input.email.trim();
  if (!validEmail(email)) return refuse('The email address is not valid. Use a full address such as name@example.com.');
  const ttl = checkTtl(input.ttlSeconds);
  if (ttl !== undefined) return refuse(ttl);
  const teamId = input.teamFile.teamId;
  return issue(input, email, (state) => {
    const old = state.members.get(input.oldMemberId);
    if (old === undefined || old.status !== 'invited' || old.removedEvent !== undefined) return { conflict: 'That invitation is no longer pending, so it cannot be re-issued.' };
    if (!old.emailHashes.includes(emailHash(teamId, email))) return { conflict: 'That email address is not the one this invitation was made for.' };
    const role = old.pendingRole ?? 'observer';
    if (role === 'owner') return { conflict: 'That invitation is not for a role that can be invited.' };
    return { name: old.name, role, allocationNanoUsd: old.allocationNanoUsd ?? 0, replaces: old.id };
  }, true);
}
