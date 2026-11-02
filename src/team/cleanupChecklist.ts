// The lead's local "NEAR cleanup pending" checklist (D-18): the NEAR steps of inviting and removing that did not finish, each with a status, an
// attempt count and a bounded last error, so a NEAR outage never blocks the log and nothing is forgotten. It lives next to the other per-team
// files in <globalStorage>/team/<teamId>/cleanup.json. It holds no secret, no email and no URL: member ids and names, step kinds, key ids and a
// scrubbed error. Writes are atomic and serialised, and the file is read again inside the serialised section before every change, so two
// windows on one folder never lose each other's items. This module never imports vscode.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_PATTERNS, assertNoSecrets } from '../domain/team/secrets';
import { AT_PATTERN, MEMBER_ID_PATTERN, validateName } from '../domain/team/validate';
import { scrubNearText } from './nearOrg';
import { runSerialised, writeFileAtomic } from './teamFile';

export const CLEANUP_FILE = 'cleanup.json';

// Every step kind this phase uses. send-invitation and cancel-invitation are invite-time, deliver-key and rotate-key follow a confirmation,
// zero-limit, revoke-key and remove-org-member are the removal order of D-17, and repo-access is the closing reminder.
export const CLEANUP_STEPS = ['send-invitation', 'cancel-invitation', 'deliver-key', 'rotate-key', 'zero-limit', 'revoke-key', 'remove-org-member', 'repo-access'] as const;
export type CleanupStep = (typeof CLEANUP_STEPS)[number];
export const CLEANUP_STATUSES = ['pending', 'failed', 'done', 'manual'] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

export interface CleanupItem {
  id: string;
  memberId: string;
  memberName: string;
  step: CleanupStep;
  keyId?: string;
  status: CleanupStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export type NewCleanupItem = Omit<CleanupItem, 'id' | 'attempts' | 'createdAt'>;
export interface CleanupPatch { status?: CleanupStatus; lastError?: string; keyId?: string; attempted?: boolean }

export function repoAccessText(name: string): string {
  return `Remove ${name}'s access to the git repository last, after their client has seen the removal.`;
}

// The wording with the member's name left as a placeholder, for callers that fill it in themselves.
export const REPO_ACCESS_TEXT = repoAccessText('<name>');

const FILE_VERSION = 1;
const MAX_ERROR_CHARACTERS = 300;
const ITEM_ID = /^cln-[0-9a-f]{16}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DAMAGED = 'The NEAR cleanup checklist on this computer is damaged, so it was not changed. Move cleanup.json out of the team folder to start a new one.';
const GLOBAL_SECRET_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));

// Known token shapes and the team's own secret detectors are cut out, control characters become spaces, and the text is bounded. What is left
// is safe to store and to show in a list.
function cleanError(text: string): string {
  let out = scrubNearText(text);
  for (const pattern of GLOBAL_SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out.slice(0, MAX_ERROR_CHARACTERS).trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function parseItem(value: unknown): CleanupItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(DAMAGED);
  const fields = value as Record<string, unknown>;
  const { id, memberId, memberName, step, keyId, status, attempts, lastError, createdAt } = fields;
  if (typeof id !== 'string' || !ITEM_ID.test(id)) throw new Error(DAMAGED);
  if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) throw new Error(DAMAGED);
  if (typeof memberName !== 'string' || validateName(memberName, 'memberName') !== undefined) throw new Error(DAMAGED);
  if (!oneOf(step, CLEANUP_STEPS) || !oneOf(status, CLEANUP_STATUSES)) throw new Error(DAMAGED);
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) throw new Error(DAMAGED);
  if (typeof createdAt !== 'string' || !AT_PATTERN.test(createdAt)) throw new Error(DAMAGED);
  const item: CleanupItem = { id, memberId, memberName, step, status, attempts, createdAt };
  if (keyId !== undefined) {
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error(DAMAGED);
    item.keyId = keyId;
  }
  if (lastError !== undefined) {
    if (typeof lastError !== 'string' || lastError.length > MAX_ERROR_CHARACTERS) throw new Error(DAMAGED);
    item.lastError = lastError;
  }
  return item;
}

function checkNewItem(item: NewCleanupItem): void {
  if (!MEMBER_ID_PATTERN.test(item.memberId)) throw new RangeError('The cleanup item names a member id that is not valid.');
  if (validateName(item.memberName, 'memberName') !== undefined) throw new RangeError('The cleanup item needs a member name of 1 to 80 characters with no line breaks.');
  if (!oneOf(item.step, CLEANUP_STEPS) || !oneOf(item.status, CLEANUP_STATUSES)) throw new RangeError('The cleanup item has a step or status this version does not know.');
  if (item.keyId !== undefined && !KEY_ID.test(item.keyId)) throw new RangeError('The cleanup item names a key id that is not valid.');
}

export class CleanupChecklist {
  private readonly file: string;
  private readonly now: () => Date;

  public constructor(storageDir: string, now: () => Date = () => new Date()) {
    this.file = path.resolve(storageDir, CLEANUP_FILE);
    this.now = now;
  }

  private async read(): Promise<CleanupItem[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(DAMAGED, { cause: error });
    }
    const items = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['items'] : undefined;
    if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>)['version'] !== FILE_VERSION || !Array.isArray(items)) throw new Error(DAMAGED);
    return items.map(parseItem);
  }

  private async write(items: CleanupItem[]): Promise<void> {
    const body = { version: FILE_VERSION, items };
    assertNoSecrets(body, 'The NEAR cleanup checklist');
    await writeFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`);
  }

  public list(): Promise<CleanupItem[]> {
    return runSerialised(this.file, () => this.read());
  }

  public async forMember(memberId: string): Promise<CleanupItem[]> {
    return (await this.list()).filter((item) => item.memberId === memberId);
  }

  public add(items: NewCleanupItem[]): Promise<CleanupItem[]> {
    for (const item of items) checkNewItem(item);
    return runSerialised(this.file, async () => {
      const existing = await this.read();
      const created: CleanupItem[] = items.map((item) => {
        const made: CleanupItem = {
          id: `cln-${randomBytes(8).toString('hex')}`, memberId: item.memberId, memberName: item.memberName.trim(), step: item.step, status: item.status,
          attempts: 0, createdAt: this.now().toISOString()
        };
        if (item.keyId !== undefined) made.keyId = item.keyId;
        const error = item.lastError === undefined ? '' : cleanError(item.lastError);
        if (error !== '') made.lastError = error;
        return made;
      });
      await this.write([...existing, ...created]);
      return created.map((item) => ({ ...item }));
    });
  }

  // Returns the changed item, or undefined when no item has this id. An attempt alone keeps the last error; a finished step shows none.
  public update(id: string, patch: CleanupPatch): Promise<CleanupItem | undefined> {
    return runSerialised(this.file, async () => {
      const existing = await this.read();
      const item = existing.find((candidate) => candidate.id === id);
      if (item === undefined) return undefined;
      if (patch.status !== undefined) {
        if (!oneOf(patch.status, CLEANUP_STATUSES)) throw new RangeError('The cleanup status is not one this version knows.');
        item.status = patch.status;
      }
      if (patch.keyId !== undefined) {
        if (!KEY_ID.test(patch.keyId)) throw new RangeError('The cleanup item names a key id that is not valid.');
        item.keyId = patch.keyId;
      }
      if (patch.lastError !== undefined) {
        const error = cleanError(patch.lastError);
        if (error === '') delete item.lastError;
        else item.lastError = error;
      } else if (patch.status === 'done') {
        delete item.lastError;
      }
      if (patch.attempted === true) item.attempts += 1;
      await this.write(existing);
      return { ...item };
    });
  }
}
