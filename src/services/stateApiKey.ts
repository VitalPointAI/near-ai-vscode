// The project's NEAR AI key, shared on this host as a sealed copy (D-15). The state home holds the key and its bound endpoint, sealed with
// AES-256-GCM under the HKDF 'api-key' subkey of the project data key, with AAD binding the state id, the record kind and the profile. A second
// editor on the same host opens it in memory, with no prompt even when sync is off, and keeps the result in its own SecretStorage.
//
// The plaintext key exists only in memory in the extension host. It is never written to a file, a log, a webview, a model request or a bundle;
// every notice below is a plain sentence without key material. No vscode here, so tests run on plain node.
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PROFILE_ID_PATTERN, ProjectCredentialScope, localKeyScope } from '../domain/auth';
import { aadFor, open, seal, subKey, type SealedBlob } from '../domain/state/keys';
import { createExclusive, ProjectStateHome, writeFileAtomic } from './stateHome';
import type { StateKeys } from './stateKeys';

const KIND = 'api-key';
const COPY_FORMAT = 1;
const MAX_COPY_BYTES = 64 * 1024;
const TEAM_PROFILE_PREFIX = 'profile-team-';

/** What is sealed. `localApiKey` is the optional key of a hybrid profile's local runtime, bound to `localEndpoint`. */
export interface ApiKeyCopy {
  profileId: string;
  endpoint: string;
  apiKey: string;
  localEndpoint?: string;
  localApiKey?: string;
}

interface CopyFile extends SealedBlob { format: typeof COPY_FORMAT }

function copyFile(home: ProjectStateHome, profileId: string): string {
  return path.join(home.paths.apiKeysDir, `${profileId}.enc`);
}

function eligible(profileId: string): boolean {
  return PROFILE_ID_PATTERN.test(profileId) && !profileId.startsWith(TEAM_PROFILE_PREFIX);
}

/** Seals the copy and writes keys/api/<profileId>.enc (mode 0600), creating the state home and key if this is the first use. */
export async function writeApiKeyCopy(home: ProjectStateHome, keys: StateKeys, copy: ApiKeyCopy): Promise<void> {
  if (!PROFILE_ID_PATTERN.test(copy.profileId)) throw new Error('A stable profile ID is required.');
  const apiKey = copy.apiKey.trim();
  if (!apiKey || !copy.endpoint.trim()) throw new Error('An API key and its endpoint are required.');
  const dataKey = await keys.ensureDataKey();
  const meta = await home.ensure();
  const body: ApiKeyCopy = {
    profileId: copy.profileId,
    endpoint: copy.endpoint.trim(),
    apiKey,
    ...(copy.localApiKey?.trim() && copy.localEndpoint ? { localEndpoint: copy.localEndpoint.trim(), localApiKey: copy.localApiKey.trim() } : {})
  };
  const sealed = seal(subKey(dataKey, 'api-key'), Buffer.from(JSON.stringify(body), 'utf8'), aadFor(meta.stateId, KIND, copy.profileId));
  const file: CopyFile = { format: COPY_FORMAT, ...sealed };
  await home.ensureFolder(home.paths.keysDir);
  await createExclusive(home.paths.keysGitignore, '*\n');
  await home.ensureFolder(home.paths.apiKeysDir);
  await writeFileAtomic(copyFile(home, copy.profileId), `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

/**
 * The copy for a profile, opened in memory. Undefined when there is none, when this editor has no data key (the normal set-up path follows), or
 * when the file is tampered, swapped to another profile, or taken from another project; in those last cases `notice` gets one plain sentence.
 */
export async function openApiKeyCopy(home: ProjectStateHome, keys: StateKeys, profileId: string, notice?: (sentence: string) => void): Promise<ApiKeyCopy | undefined> {
  if (!PROFILE_ID_PATTERN.test(profileId)) return undefined;
  let text: string;
  try {
    text = await readFile(copyFile(home, profileId), 'utf8');
  } catch {
    return undefined;
  }
  const dataKey = await keys.dataKey();
  if (!dataKey) return undefined;
  const meta = await home.readMeta().catch(() => undefined);
  if (!meta) return undefined;
  return openApiKeyCopyText(text, dataKey, meta.stateId, profileId, notice);
}

/**
 * Opens a sealed copy given as text (a keys/api file, or one that came from another computer inside the synced state) with the project's data key and
 * state id, in memory. Undefined when it is tampered, swapped to another profile or sealed for another project; `notice` then gets one plain sentence.
 */
export function openApiKeyCopyText(text: string, dataKey: Buffer, stateId: string, profileId: string, notice?: (sentence: string) => void): ApiKeyCopy | undefined {
  if (!PROFILE_ID_PATTERN.test(profileId)) return undefined;
  const refuse = (): undefined => { notice?.("The saved copy of this project's key was changed or is not for this project, so it was not used."); return undefined; };
  try {
    if (text.length > MAX_COPY_BYTES) return refuse();
    const file = JSON.parse(text) as Partial<CopyFile> | null;
    if (typeof file !== 'object' || file === null || file.format !== COPY_FORMAT) return refuse();
    const plain = open(subKey(dataKey, 'api-key'), { iv: file.iv as string, tag: file.tag as string, data: file.data as string }, aadFor(stateId, KIND, profileId));
    const copy = JSON.parse(plain.toString('utf8')) as Partial<ApiKeyCopy> | null;
    if (typeof copy !== 'object' || copy === null || copy.profileId !== profileId || typeof copy.apiKey !== 'string' || !copy.apiKey
      || typeof copy.endpoint !== 'string' || !copy.endpoint
      || (copy.localApiKey !== undefined && (typeof copy.localApiKey !== 'string' || typeof copy.localEndpoint !== 'string'))) return refuse();
    return {
      profileId, endpoint: copy.endpoint, apiKey: copy.apiKey,
      ...(copy.localApiKey && copy.localEndpoint ? { localEndpoint: copy.localEndpoint, localApiKey: copy.localApiKey } : {})
    };
  } catch {
    return refuse();
  }
}

/** The text of a profile's sealed copy file as it is on disk (never opened), or undefined when there is none or it is too large. */
export async function readApiKeyCopyText(home: ProjectStateHome, profileId: string): Promise<string | undefined> {
  if (!PROFILE_ID_PATTERN.test(profileId)) return undefined;
  try {
    const text = await readFile(copyFile(home, profileId), 'utf8');
    return text.length > MAX_COPY_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The profile ids that have a sealed copy file here, in order. */
export async function listApiKeyCopies(home: ProjectStateHome): Promise<string[]> {
  const names = await readdir(home.paths.apiKeysDir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.enc')).map((name) => name.slice(0, -4)).filter((id) => eligible(id)).sort();
}

/** Deletes that one profile's copy. */
export async function removeApiKeyCopy(home: ProjectStateHome, profileId: string): Promise<void> {
  if (!PROFILE_ID_PATTERN.test(profileId)) return;
  await rm(copyFile(home, profileId), { force: true });
}

/** What an AuthService asks when its own SecretStorage has no key. */
export interface ApiKeyCopyHooks {
  /** The key and endpoint for a scope from the sealed copy, or undefined. Never creates or changes anything. */
  resolve(scope: ProjectCredentialScope, endpoint?: string): Promise<{ apiKey: string; endpoint: string } | undefined>;
  /** A key was saved: rotate the copy. */
  written(scope: ProjectCredentialScope, profile: { profileId: string; baseUrl: string; localBaseUrl?: string; keySource?: unknown }, apiKey: string, localApiKey?: string): Promise<void>;
  /** A profile was removed: remove its copy. */
  removed(profileId: string): Promise<void>;
}

export interface ApiKeyCopyHookInput {
  /** The project's credential project id (path-derived, per machine). Scopes of any other project, such as a reused profile's source, are ignored. */
  projectScopeId: string;
  home: ProjectStateHome;
  keys: StateKeys;
  /** Plain sentences only; never a key. */
  log: (line: string) => void;
}

export function apiKeyCopyHooks(input: ApiKeyCopyHookInput): ApiKeyCopyHooks {
  const { projectScopeId, home, keys, log } = input;
  /** The copy file a scope reads: the profile's own, or the profile whose hybrid local key scope this is. */
  const owner = async (scope: ProjectCredentialScope): Promise<{ profileId: string; local: boolean } | undefined> => {
    if (scope.projectId !== projectScopeId) return undefined;
    if (eligible(scope.profileId) && await stat(copyFile(home, scope.profileId)).then(() => true, () => false)) return { profileId: scope.profileId, local: false };
    const names = await readdir(home.paths.apiKeysDir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.enc')) continue;
      const profileId = name.slice(0, -4);
      if (eligible(profileId) && localKeyScope({ ...scope, profileId }).profileId === scope.profileId) return { profileId, local: true };
    }
    return undefined;
  };
  return {
    async resolve(scope) {
      try {
        const found = await owner(scope);
        if (!found) return undefined;
        const copy = await openApiKeyCopy(home, keys, found.profileId, log);
        if (!copy) return undefined;
        if (found.local) return copy.localApiKey && copy.localEndpoint ? { apiKey: copy.localApiKey, endpoint: copy.localEndpoint } : undefined;
        return { apiKey: copy.apiKey, endpoint: copy.endpoint };
      } catch {
        log("The saved copy of this project's key could not be read, so it was not used.");
        return undefined;
      }
    },
    async written(scope, profile, apiKey, localApiKey) {
      if (scope.projectId !== projectScopeId || scope.profileId !== profile.profileId || profile.keySource || !eligible(profile.profileId)) return;
      try {
        await writeApiKeyCopy(home, keys, {
          profileId: profile.profileId, endpoint: profile.baseUrl, apiKey,
          ...(localApiKey && profile.localBaseUrl ? { localEndpoint: profile.localBaseUrl, localApiKey } : {})
        });
      } catch {
        log("This project's key could not be shared with other editors on this computer. It is still saved in this editor.");
      }
    },
    async removed(profileId) {
      if (!eligible(profileId)) return;
      try { await removeApiKeyCopy(home, profileId); } catch { log("The shared copy of this project's key could not be removed."); }
    }
  };
}
