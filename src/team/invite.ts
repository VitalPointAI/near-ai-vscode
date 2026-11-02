// The lead's side of inviting (TEAM-02, D-05, D-06, D-10, D-21, D-22). One call writes member.invited and returns the single invite bundle to
// copy. The code exists in memory and in the returned bundle only: the log gets the key derived from it, the local invite list gets who was
// invited, and the code bytes are zero-filled once the bundle is built. The repo URL is read raw from git config, cleaned of credentials, and
// never logged or placed in an error. This module never imports vscode.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SecretLeakError, assertNoSecrets } from '../domain/team/secrets';
import { INVITABLE_ROLES, ROLES } from '../domain/team/types';
import type { Role, TeamFile } from '../domain/team/types';
import { MEMBER_ID_PATTERN, validateName } from '../domain/team/validate';
import { NoDeviceKeyError } from './eventLog';
import type { TeamLog } from './eventLog';
import { emailHash, newMemberId } from './identity';
import { encodeInviteBundle, cleanRepoUrl } from './inviteBundle';
import { deriveInviteKey, generateInviteCode } from './inviteCode';
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

function checkInput(input: InviteInput): string | undefined {
  if (validateName(input.name, 'name') !== undefined) return 'The name must be 1 to 80 characters with no line breaks.';
  if (!validEmail(input.email.trim())) return 'The email address is not valid. Use a full address such as name@example.com.';
  if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) return 'That role cannot be invited. Choose lead, developer, reviewer or observer.';
  if (!Number.isSafeInteger(input.allocationNanoUsd) || input.allocationNanoUsd < 0) return 'The allocation must be a whole number of nano-USD, zero or more.';
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < MIN_TTL_SECONDS || input.ttlSeconds > MAX_TTL_SECONDS) return 'The invitation lifetime must be between 1 hour and 30 days.';
  return undefined;
}

export async function inviteMember(input: InviteInput): Promise<InviteResult> {
  const problem = checkInput(input);
  if (problem !== undefined) return refuse(problem);
  const git = input.git ?? runGit;
  const teamId = input.teamFile.teamId;
  const name = input.name.trim();
  const email = input.email.trim();

  const raw = await configuredRemoteUrl(input.projectRoot, input.teamFile.coordination.remote, git);
  const cleaned = cleanRepoUrl(raw);
  if (!cleaned.ok) return { ok: false, code: 'remote-url', message: cleaned.reason };

  const memberId = newMemberId();
  const code = generateInviteCode();
  try {
    const invitePublicKey = deriveInviteKey(code.bytes, teamId, memberId).publicKey;
    let appended: AppendResult;
    try {
      appended = await input.log.append(() => [{
        type: 'member.invited',
        body: {
          memberId, name, emailHashes: [emailHash(teamId, email)], role: input.role, allocationNanoUsd: input.allocationNanoUsd,
          ttlSeconds: input.ttlSeconds, invite: { publicKey: invitePublicKey }
        }
      }]);
    } catch (error) {
      if (error instanceof SecretLeakError || error instanceof NoDeviceKeyError) return refuse(error.message);
      throw error;
    }
    if (!appended.ok) return failureOf(appended);
    const invitedEvent = appended.events.find((event) => event.type === 'member.invited');
    if (invitedEvent === undefined) return refuse('The invitation was saved but its event could not be found.');

    let notice: string | undefined;
    try {
      await recordInvite(teamStorageDir(input.globalStorageDir, teamId), { memberId, name, email, role: input.role, invitedEvent: invitedEvent.id });
    } catch (error) {
      // The invitation is already in the log. Losing the display cache costs only the name and email shown beside it, so the bundle is still returned.
      notice = `The invitation was sent, but this computer could not save it to the local invitation list: ${redactGitMessage(error instanceof Error ? error.message : String(error))}`;
    }
    const bundle = encodeInviteBundle({
      v: 1, repo: cleaned.url, team: teamId, ref: input.teamFile.coordination.ref, member: memberId, code: code.text,
      ...(input.teamFile.near === undefined ? {} : { near: { organizationId: input.teamFile.near.organizationId, workspaceId: input.teamFile.near.workspaceId } })
    });
    const result: InviteResult = { ok: true, memberId, bundle, nearInvitation: 'not-applicable' };
    if (notice !== undefined) result.notice = notice;
    return result;
  } finally {
    // D-05: once the bundle is built the clear code is not needed again. The string copy in the bundle is the only one left.
    code.bytes.fill(0);
  }
}
