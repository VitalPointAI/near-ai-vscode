// A member's team API key as the project's active credential (D-14, D-20, D-23). The key goes into a
// project-scoped profile profile-team-<10 hex of sha256(teamId)> through the same ProfileStore the
// rest of the extension reads, so chat and every other feature use it with no extra wiring. The
// member's own profile is remembered in <storage>/join.json and can be restored; it is never deleted.
// Local files here hold ids only, never a key. This module never imports `vscode`.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TEAM_PROFILE_PREFIX, deriveProfileId } from '../domain/auth';
import { AuthService } from '../services/auth';
import type { SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import type { FetchLike } from '../services/reportingSignIn';
import { checkApiKey } from './nearOrg';
import { runSerialised, teamStorageDir, writeFileAtomic } from './teamFile';

const JOIN_FILE = 'join.json';
const KEY_FILE = 'key.json';
/** A new key can take up to about ten seconds to be accepted, so six tries two seconds apart. */
const DEFAULT_ATTEMPTS = 6;
const RETRY_WAIT_MS = 2000;
const MAX_NAME = 40;
const NAME_SUFFIX = ' (team key)';

export type TeamKeyInstallResult =
  | { ok: true; profileId: string; capped: boolean }
  | { ok: false; code: 'invalid' | 'wrong-organization' | 'wrong-workspace' | 'unavailable'; message: string };

export interface InstallTeamKeyInput {
  projectRoot: string;
  globalStorageDir: string;
  teamId: string;
  teamName: string;
  secrets: SecretStorageLike;
  /** The key, wiped (zero-filled) before this returns, whatever the outcome. */
  apiKey: Buffer;
  baseUrl: string;
  /** For a NEAR-linked team: the organization and workspace the key must belong to. */
  expect?: { organizationId: string; workspaceId: string };
  /** The NEAR id of the key the lead made for this member, kept so later steps can tell which key is installed. */
  keyId?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export function teamProfileId(teamId: string): string {
  return `${TEAM_PROFILE_PREFIX}${createHash('sha256').update(teamId).digest('hex').slice(0, 10)}`;
}

// Words ProfileStore refuses in a label, and control characters. The team name is the lead's text, so it is made safe, not trusted.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const REFUSED_WORDS = /api[_ -]?key|refresh[-_ ]?token|\btoken\b|\bbearer\b|authorization|command\s*[:=]?|private prompt|raw context|[A-Za-z]:\\/gi;

function teamLabel(teamName: string): string {
  const cleaned = teamName.replace(CONTROL_CHARACTERS, ' ').replace(REFUSED_WORDS, ' ').replace(/\s+/g, ' ').replace(/^[/\s]+/, '').trim().slice(0, MAX_NAME).trim();
  return cleaned || 'Team';
}

const MESSAGES = {
  invalid: 'NEAR AI did not accept this team key. Ask the lead to send a new one.',
  unavailable: 'Could not reach NEAR AI Cloud to check the team key. Try again in a moment.',
  'wrong-organization': 'This key belongs to a different NEAR AI organization than this team. It was not installed.',
  'wrong-workspace': 'This key belongs to a different NEAR AI workspace than this team. It was not installed.'
} as const;

type Verified = { ok: true; capped: boolean } | { ok: false; code: 'invalid' | 'wrong-organization' | 'wrong-workspace' | 'unavailable' };

async function verifyKey(input: InstallTeamKeyInput, sleep: (ms: number) => Promise<void>): Promise<Verified> {
  const attempts = Math.max(1, Math.floor(input.attempts ?? DEFAULT_ATTEMPTS));
  let last: Verified = { ok: false, code: 'unavailable' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checked = await checkApiKey(input.baseUrl, input.apiKey, input.fetch);
    if (checked.status === 'valid' || checked.status === 'capped') {
      const { expect } = input;
      if (expect && checked.organizationId !== expect.organizationId) return { ok: false, code: 'wrong-organization' };
      if (expect && checked.workspaceId !== expect.workspaceId) return { ok: false, code: 'wrong-workspace' };
      if (input.keyId && checked.apiKeyId !== '' && checked.apiKeyId !== input.keyId) return { ok: false, code: 'invalid' };
      return { ok: true, capped: checked.status === 'capped' };
    }
    // A new key is often refused for a few seconds, and an outage may pass: both are tried again.
    last = { ok: false, code: checked.status === 'invalid' ? 'invalid' : 'unavailable' };
    if (attempt < attempts) await sleep(RETRY_WAIT_MS);
  }
  return last;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: Record<string, unknown>): Promise<void> {
  const target = path.resolve(file);
  await runSerialised(target, () => writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`));
}

const idOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined);

/**
 * Checks the key with NEAR (retrying for its activation delay), then installs it as this project's
 * active profile. Nothing is stored or selected unless the check passes, so a bad re-delivery
 * leaves the working key in place. The previous active profile is remembered once.
 */
export async function installTeamKey(input: InstallTeamKeyInput): Promise<TeamKeyInstallResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const profileId = teamProfileId(input.teamId);
  const dir = teamStorageDir(input.globalStorageDir, input.teamId);
  try {
    let verification: Promise<Verified> | undefined;
    const verified = () => (verification ??= verifyKey(input, sleep));
    const first = await verified();
    if (!first.ok) return { ok: false, code: first.code, message: MESSAGES[first.code] };

    const auth = new AuthService(input.secrets);
    // The probe ProfileStore runs is the check just made against this very key, not a second one.
    const store = new ProfileStore(input.projectRoot, auth, {
      validator: async () => {
        const result = await verified();
        if (!result.ok) throw new Error(MESSAGES[result.code]);
      }
    });
    const previous = (await store.getActiveSelection())?.profileId;
    const label = teamLabel(input.teamName);
    const configured = await store.configure(
      { profileId, displayName: `${label}${NAME_SUFFIX}`, organization: label, baseUrl: input.baseUrl, authMode: 'apiKey' },
      input.apiKey.toString('utf8')
    );
    if (configured.validation.status !== 'valid') return { ok: false, code: 'unavailable', message: MESSAGES.unavailable };

    const joinFile = path.join(dir, JOIN_FILE);
    if (previous && previous !== profileId && (await readJson(joinFile))?.['previousProfileId'] === undefined) {
      await writeJson(joinFile, { previousProfileId: previous });
    }
    if (input.keyId) await writeJson(path.join(dir, KEY_FILE), { keyId: input.keyId });
    return { ok: true, profileId, capped: first.capped };
  } finally {
    input.apiKey.fill(0);
  }
}

// ---- the person's own key, pasted at Join in a team without an organization (D-21 as amended by the owner, 0.6.4 re-test 2026-11-05) -------------

/** The name of the profile a key pasted at Join becomes: the person's own profile, never the team key profile. */
export const OWN_KEY_PROFILE_NAME = 'My NEAR AI key';

const OWN_KEY_MESSAGES = {
  invalid: 'NEAR AI did not accept this key. Check it and try again.',
  unavailable: 'Could not reach NEAR AI Cloud to check your key. Try again in a moment.'
} as const;

export type OwnKeyInstallResult = { ok: true; profileId: string; capped: boolean } | { ok: false; code: 'invalid' | 'unavailable'; message: string };

export interface InstallOwnKeyInput {
  projectRoot: string;
  secrets: SecretStorageLike;
  /** The key, wiped (zero-filled) before this returns, whatever the outcome. */
  apiKey: Buffer;
  baseUrl: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** One try by default: a key that already exists needs no activation wait (D-12 as amended by D-21). */
  attempts?: number;
}

/**
 * Checks the person's own key once with NEAR AI (check_api_key only, no organization or workspace check), then makes it this project's own
 * profile 'My NEAR AI key' through the normal profile store: selected, in the saved-profile list, kept when the person leaves the team and
 * counted as personal spend. The key goes only to secure storage, bound to the address it was checked against. No team file is written.
 */
export async function installOwnKey(input: InstallOwnKeyInput): Promise<OwnKeyInstallResult> {
  try {
    const attempts = Math.max(1, Math.floor(input.attempts ?? 1));
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    let checked: Awaited<ReturnType<typeof checkApiKey>> = { status: 'unavailable', reason: '' };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      checked = await checkApiKey(input.baseUrl, input.apiKey, input.fetch);
      if (checked.status === 'valid' || checked.status === 'capped') break;
      if (attempt < attempts) await sleep(RETRY_WAIT_MS);
    }
    if (checked.status !== 'valid' && checked.status !== 'capped') {
      const code = checked.status === 'invalid' ? 'invalid' : 'unavailable';
      return { ok: false, code, message: OWN_KEY_MESSAGES[code] };
    }
    const capped = checked.status === 'capped';
    const organization = checked.organizationId.trim() || OWN_KEY_PROFILE_NAME;
    // The probe ProfileStore runs is the check just made against this very key, not a second one.
    const store = new ProfileStore(input.projectRoot, new AuthService(input.secrets), { validator: async () => undefined });
    const profileId = deriveProfileId(input.projectRoot, OWN_KEY_PROFILE_NAME);
    const configured = await store.configure(
      { profileId, displayName: OWN_KEY_PROFILE_NAME, organization, baseUrl: input.baseUrl, authMode: 'apiKey' },
      input.apiKey.toString('utf8')
    );
    if (configured.validation.status !== 'valid') return { ok: false, code: 'unavailable', message: OWN_KEY_MESSAGES.unavailable };
    return { ok: true, profileId, capped };
  } finally {
    input.apiKey.fill(0);
  }
}

/** What this device remembers about the installed team key and the profile it replaced, or undefined when neither is known. */
/** The key id of the team key installed for this project, from the team's storage folder (61-30: the sidebar tells whether a key waits). */
export async function installedKeyId(storageDir: string): Promise<string | undefined> {
  return idOrUndefined((await readJson(path.join(storageDir, KEY_FILE)))?.['keyId']);
}

export async function readInstalledKey(globalStorageDir: string, teamId: string): Promise<{ keyId?: string; previousProfileId?: string } | undefined> {
  const dir = teamStorageDir(globalStorageDir, teamId);
  const keyId = idOrUndefined((await readJson(path.join(dir, KEY_FILE)))?.['keyId']);
  const previousProfileId = idOrUndefined((await readJson(path.join(dir, JOIN_FILE)))?.['previousProfileId']);
  if (keyId === undefined && previousProfileId === undefined) return undefined;
  return { ...(keyId === undefined ? {} : { keyId }), ...(previousProfileId === undefined ? {} : { previousProfileId }) };
}

/**
 * Takes the team key out of this project: the member's earlier profile is selected again when the
 * team profile is still the active one and the earlier profile still exists, then the team profile
 * and its scoped key are removed. The earlier profile itself is never touched.
 */
export async function removeTeamKey(input: { projectRoot: string; globalStorageDir: string; teamId: string; secrets: SecretStorageLike }): Promise<{ restoredProfileId?: string }> {
  const dir = teamStorageDir(input.globalStorageDir, input.teamId);
  const profileId = teamProfileId(input.teamId);
  const store = new ProfileStore(input.projectRoot, new AuthService(input.secrets));
  const previous = idOrUndefined((await readJson(path.join(dir, JOIN_FILE)))?.['previousProfileId']);
  let restoredProfileId: string | undefined;
  if (previous && previous !== profileId && (await store.getActiveSelection())?.profileId === profileId && (await store.get(previous))) {
    try {
      await store.select(previous);
      restoredProfileId = previous;
    } catch {
      // The earlier profile can no longer be selected (its check is out of date), so nothing is selected until the member picks one.
      restoredProfileId = undefined;
    }
  }
  await store.remove(profileId);
  await fs.rm(path.join(dir, JOIN_FILE), { force: true });
  await fs.rm(path.join(dir, KEY_FILE), { force: true });
  return restoredProfileId === undefined ? {} : { restoredProfileId };
}
