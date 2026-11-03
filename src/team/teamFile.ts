// .planning/.near-ai/team.json (D-21): the project's pointer to its team, treated as attacker-influenced input (D-01).
// Anyone who can push to the code branch can edit this file, so every field is validated before use, nothing in it is a secret,
// and a local trust pin (RESEARCH Pitfall 10) refuses a later file that names a different team or owner key.
// This module never imports vscode.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalize } from '../domain/team/canonical';
import { isGitRefName } from '../domain/team/policy';
import { assertNoSecrets } from '../domain/team/secrets';
import type { DeviceRef, NearLink, TeamFile } from '../domain/team/types';
import { AT_PATTERN, EVENT_ID_PATTERN, TEAM_ID_PATTERN, isRecord, validateDeviceRef, validateName } from '../domain/team/validate';

export const TEAM_FILE_REL = '.planning/.near-ai/team.json';
// A remote name can never start with a dash, so the value cannot become a git option; it is also always passed as its own argv entry.
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const COORDINATION_REF_PATTERN = /^refs\/(heads|near-ai)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

const NEAR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TEAM_FILE_BYTES = 16 * 1024;
const TRUST_FILE = 'trust.json';
const TRUST_VERSION = 1;

export class TeamFileError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TeamFileError';
  }
}

export class TrustPinError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TrustPinError';
  }
}

export function teamFilePath(projectRoot: string): string {
  return path.join(projectRoot, ...TEAM_FILE_REL.split('/'));
}

function refuse(field: string): never {
  throw new TeamFileError(`team.json has a missing or invalid "${field}" and was not used.`);
}

function exactKeys(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) return refuse(field);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      // The key name is attacker text, so the message names the object, never the key.
      throw new TeamFileError(`team.json has an unexpected extra field in "${field}" and was not used.`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return refuse(`${field === 'team.json' ? '' : `${field}.`}${key}`);
  }
  return value;
}

function checked(reason: string | undefined, field: string): void {
  if (reason !== undefined) refuse(field);
}

function validRef(ref: unknown): ref is string {
  // The pattern keeps the coordination ref to a plain alphabet; the shared validator applies git's own rules (WR-09).
  return typeof ref === 'string' && COORDINATION_REF_PATTERN.test(ref) && isGitRefName(ref);
}

function parseNear(value: unknown): NearLink {
  const near = exactKeys(value, 'near', ['organizationId', 'workspaceId']);
  if (typeof near.organizationId !== 'string' || !NEAR_ID_PATTERN.test(near.organizationId)) return refuse('near.organizationId');
  if (typeof near.workspaceId !== 'string' || !NEAR_ID_PATTERN.test(near.workspaceId)) return refuse('near.workspaceId');
  return { organizationId: near.organizationId, workspaceId: near.workspaceId };
}

// Fixed key order so the committed file diffs cleanly and every device writes the same bytes.
function ordered(file: TeamFile): Record<string, unknown> {
  const result: Record<string, unknown> = {
    version: 1,
    teamId: file.teamId,
    name: file.name,
    coordination: { transport: file.coordination.transport, ref: file.coordination.ref, remote: file.coordination.remote },
    genesis: { eventId: file.genesis.eventId, ownerDevice: { fingerprint: file.genesis.ownerDevice.fingerprint, publicKey: file.genesis.ownerDevice.publicKey } }
  };
  if (file.near !== undefined) result.near = { organizationId: file.near.organizationId, workspaceId: file.near.workspaceId };
  result.createdAt = file.createdAt;
  return result;
}

export function serialiseTeamFile(file: TeamFile): string {
  return `${JSON.stringify(ordered(file), null, 2)}\n`;
}

// The genesis copy on the coordination branch is canonical JSON of the same fields.
export function canonicalTeamFile(file: TeamFile): string {
  return canonicalize(ordered(file));
}

export function parseTeamFile(text: string): TeamFile {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEAM_FILE_BYTES) throw new TeamFileError('team.json is larger than 16 KB and was not used.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TeamFileError('team.json is not valid JSON.', { cause: error });
  }
  if (isRecord(parsed) && parsed.version !== undefined && parsed.version !== 1) {
    throw new TeamFileError('team.json was written by a newer version of NEAR AI. Update the extension to use Team Mode in this project.');
  }
  const top = exactKeys(parsed, 'team.json', ['version', 'teamId', 'name', 'coordination', 'genesis', 'createdAt'], ['near']);
  if (top.version !== 1) return refuse('version');
  if (typeof top.teamId !== 'string' || !TEAM_ID_PATTERN.test(top.teamId)) return refuse('teamId');
  checked(validateName(top.name, 'name'), 'name');
  const coordination = exactKeys(top.coordination, 'coordination', ['transport', 'ref', 'remote']);
  if (coordination.transport !== 'git') return refuse('coordination.transport');
  if (!validRef(coordination.ref)) return refuse('coordination.ref');
  if (typeof coordination.remote !== 'string' || !REMOTE_NAME_PATTERN.test(coordination.remote)) return refuse('coordination.remote');
  const genesis = exactKeys(top.genesis, 'genesis', ['eventId', 'ownerDevice']);
  if (typeof genesis.eventId !== 'string' || !EVENT_ID_PATTERN.test(genesis.eventId)) return refuse('genesis.eventId');
  checked(validateDeviceRef(genesis.ownerDevice, 'genesis.ownerDevice'), 'genesis.ownerDevice');
  if (typeof top.createdAt !== 'string' || !AT_PATTERN.test(top.createdAt)) return refuse('createdAt');
  const ownerDevice = genesis.ownerDevice as DeviceRef;
  const file: TeamFile = {
    version: 1,
    teamId: top.teamId,
    name: top.name as string,
    coordination: { transport: 'git', ref: coordination.ref, remote: coordination.remote },
    genesis: { eventId: genesis.eventId, ownerDevice: { fingerprint: ownerDevice.fingerprint, publicKey: ownerDevice.publicKey } },
    createdAt: top.createdAt
  };
  if (Object.prototype.hasOwnProperty.call(top, 'near')) file.near = parseNear(top.near);
  return file;
}

// undefined only when the file does not exist; an unreadable or corrupt file is an error, never "no team".
export async function readTeamFile(projectRoot: string): Promise<TeamFile | undefined> {
  let text: string;
  try {
    text = await fs.readFile(teamFilePath(projectRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseTeamFile(text);
}

// Writes to one path run strictly in call order. The queue tail never rejects so one failure does not block later writes,
// but every caller still receives its own task's result or error.
const writeQueues = new Map<string, Promise<void>>();

export function runSerialised<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

function withCleanupFailure(error: unknown, cleanupError: unknown): unknown {
  if (error instanceof Error) {
    if (error.cause === undefined) error.cause = cleanupError;
    return error;
  }
  return new Error(String(error), { cause: cleanupError });
}

// Temp file in the same directory, then rename onto the target. A failure removes the temp file and rethrows the original
// error; if the removal also fails, that failure rides along as the error's cause instead of being dropped.
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    try {
      await fs.rm(temporary, { force: true });
    } catch (cleanupError) {
      throw withCleanupFailure(error, cleanupError);
    }
    throw error;
  }
}

export async function writeTeamFile(projectRoot: string, file: TeamFile): Promise<void> {
  assertNoSecrets(file, 'team.json');
  const text = serialiseTeamFile(file);
  parseTeamFile(text);
  const target = path.resolve(teamFilePath(projectRoot));
  await runSerialised(target, () => writeFileAtomic(target, text));
}

// <globalStorage>/team/<teamId> (D-16). The id comes from team.json, so it is checked before it becomes a path segment.
export function teamStorageDir(globalStorageDir: string, teamId: string): string {
  if (!TEAM_ID_PATTERN.test(teamId)) throw new TeamFileError('The team id is not valid, so no storage folder was chosen.');
  return path.join(globalStorageDir, 'team', teamId);
}

interface TrustPin { version: 1; teamId: string; genesisEventId: string; ownerFingerprint: string }

const PIN_MISMATCH = "This project's team.json names a different team or owner key than this computer saw before. Team Mode is paused until you confirm the change with your team.";

function parsePin(text: string): TrustPin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TrustPinError('The saved trust record for this team cannot be read. Team Mode is paused until it is checked.', { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== TRUST_VERSION || typeof parsed.teamId !== 'string' || typeof parsed.genesisEventId !== 'string' || typeof parsed.ownerFingerprint !== 'string') {
    throw new TrustPinError('The saved trust record for this team is not in a form this version understands. Team Mode is paused until it is checked.');
  }
  return { version: 1, teamId: parsed.teamId, genesisEventId: parsed.genesisEventId, ownerFingerprint: parsed.ownerFingerprint };
}

// Trust on first use: the first team.json seen for a storage folder is pinned; a later one must name the same team, genesis and owner key.
export async function checkTrustPin(storageDir: string, file: TeamFile): Promise<'first-seen' | 'match'> {
  const pinFile = path.resolve(storageDir, TRUST_FILE);
  const wanted: TrustPin = { version: 1, teamId: file.teamId, genesisEventId: file.genesis.eventId, ownerFingerprint: file.genesis.ownerDevice.fingerprint };
  return runSerialised<'first-seen' | 'match'>(pinFile, async () => {
    let text: string | undefined;
    try {
      text = await fs.readFile(pinFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (text === undefined) {
      await writeFileAtomic(pinFile, `${JSON.stringify(wanted, null, 2)}\n`);
      return 'first-seen';
    }
    const pinned = parsePin(text);
    if (pinned.teamId !== wanted.teamId || pinned.genesisEventId !== wanted.genesisEventId || pinned.ownerFingerprint !== wanted.ownerFingerprint) {
      throw new TrustPinError(PIN_MISMATCH);
    }
    return 'match';
  });
}

// ---- the NEAR link pin (CR-01) --------------------------------------------------------------------------------------------------------
//
// team.json `near` decides which NEAR organization and workspace a lead's client caps, revokes and creates keys in, and which one a member's
// client expects a delivered key to belong to. Any committer can edit it, so the first link this computer trusts (when it links, joins, or
// first reads a linked team.json) is pinned next to trust.json, and every later NEAR key step checks the file against that pin. The pin holds
// two ids, nothing secret. Only the lead's own Link command, where the organization and workspace are picked from NEAR's lists, changes it.

const NEAR_PIN_FILE = 'near-pin.json';

interface NearPin { version: 1; teamId: string; organizationId: string; workspaceId: string }

export const NEAR_PIN_MISMATCH = "This project's team.json names a different organization or workspace than this computer linked before, so no team key was changed there. Check with your team which link is right; a lead can confirm it with \"NEAR AI: Link Your Organization\".";
const NEAR_PIN_GONE = "This project's team.json no longer names the organization this computer linked before, so no team key was changed. Check with your team why the link was removed; a lead can link it again with \"NEAR AI: Link Your Organization\".";
const NEAR_PIN_DAMAGED = 'The saved organization link for this team cannot be read, so no team key was changed. A lead can link the team again with "NEAR AI: Link Your Organization".';

/** A team.json `near` that does not match the link this computer pinned. Also a TrustPinError, so every pin catch handles it. */
export class NearPinError extends TrustPinError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NearPinError';
  }
}

function parseNearPin(text: string): NearPin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new NearPinError(NEAR_PIN_DAMAGED, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== TRUST_VERSION || typeof parsed.teamId !== 'string' || typeof parsed.organizationId !== 'string' || typeof parsed.workspaceId !== 'string') {
    throw new NearPinError(NEAR_PIN_DAMAGED);
  }
  return { version: 1, teamId: parsed.teamId, organizationId: parsed.organizationId, workspaceId: parsed.workspaceId };
}

async function readNearPin(pinFile: string): Promise<NearPin | undefined> {
  try {
    return parseNearPin(await fs.readFile(pinFile, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeNearPin(pinFile: string, teamId: string, near: NearLink): Promise<void> {
  const pin: NearPin = { version: 1, teamId, organizationId: near.organizationId, workspaceId: near.workspaceId };
  await writeFileAtomic(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
}

/**
 * The NEAR link to use for this team's keys: team.json `near`, but only when it matches the link this computer pinned. The first linked
 * team.json seen is pinned (trust on first use). A file without `near` and no pin is an unlinked team (undefined). A file that names a
 * different link, or drops a pinned one, throws NearPinError, and the caller must not call NEAR for keys.
 */
export async function checkNearPin(storageDir: string, file: TeamFile): Promise<NearLink | undefined> {
  const pinFile = path.resolve(storageDir, NEAR_PIN_FILE);
  return runSerialised<NearLink | undefined>(pinFile, async () => {
    const pinned = await readNearPin(pinFile);
    if (pinned === undefined) {
      if (file.near === undefined) return undefined;
      await writeNearPin(pinFile, file.teamId, file.near);
      return { organizationId: file.near.organizationId, workspaceId: file.near.workspaceId };
    }
    if (pinned.teamId !== file.teamId) throw new NearPinError(NEAR_PIN_MISMATCH);
    if (file.near === undefined) throw new NearPinError(NEAR_PIN_GONE);
    if (pinned.organizationId !== file.near.organizationId || pinned.workspaceId !== file.near.workspaceId) throw new NearPinError(NEAR_PIN_MISMATCH);
    return { organizationId: pinned.organizationId, workspaceId: pinned.workspaceId };
  });
}

/** Records the link a lead just chose from NEAR's lists with the Link command, replacing any earlier pin. */
export async function pinNearLink(storageDir: string, teamId: string, near: NearLink): Promise<void> {
  const pinFile = path.resolve(storageDir, NEAR_PIN_FILE);
  await runSerialised(pinFile, () => writeNearPin(pinFile, teamId, near));
}
