// Shared by the sync-flow tests: a computer with its own secrets, auth service, profile store and thread store over one local bare remote, the flows' environment
// built over it, and a fake for every question a flow asks the person. Nothing contacts a network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthService } from '../../services/auth';
import type { GitRunner } from '../../services/stateGit';
import { ProfileStore } from '../../services/profileStore';
import { profileSyncHooks } from '../../services/stateRestore';
import { apiKeyCopyHooks } from '../../services/stateApiKey';
import { stateHomeFor } from '../../services/stateHome';
import { stateKeysFor } from '../../services/stateKeys';
import { buildStateSync, type SyncEnv, type SyncParts, type SyncUi } from '../../services/syncFlows';
import { threadStoreFor } from '../../services/threadStore';
import { bareRemote, fixtureGit, hermeticRunner, userRepo } from './gitFixtures';
import { MemorySecrets, git as plainGit, gitInit } from './stateFixtures';

export const KEY_SENTINEL = 'near-test-SENTINEL-4f9a-key';
export const REFRESH_SENTINEL = 'refresh-test-SENTINEL-8d12';
export const ENDPOINT = 'https://example.test/v1';
export const PROFILE = 'profile-company';

export interface Computer {
  name: string;
  root: string;
  secrets: MemorySecrets;
  auth: AuthService;
  store: ProfileStore;
  parts: SyncParts;
  env: SyncEnv;
  home: ReturnType<typeof stateHomeFor>;
  keys: ReturnType<typeof stateKeysFor>;
  threads: ReturnType<typeof threadStoreFor>;
}

export interface ComputerOptions {
  /** A folder that already is a project (default: a clone with `origin` at the remote). */
  root?: string;
  /** The git runner every sync of this computer uses (default: a hermetic one). */
  git?: GitRunner;
  /** Whether this computer shares the key copies with its other editors through the project's own hook, as the extension does (default true). */
  keyCopyHook?: boolean;
  isIdle?: () => boolean;
  keepKeyInProject?: () => boolean;
  /** Makes a profile check pass (default) or fail, so a restored profile can be seen to be stale or valid. */
  validator?: () => Promise<void>;
}

/** One computer: a project folder (a clone of the remote unless `root` is given) with its own secret storage and everything built over it. */
export function computer(remoteDir: string, name: string, options: ComputerOptions = {}): Computer {
  const root = options.root ?? userRepo(remoteDir).dir;
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const keep = options.keepKeyInProject ?? (() => true);
  const writer = `${name.padEnd(6, 'x')}ed.${name.padEnd(6, 'x')}in`;
  const home = stateHomeFor(root);
  const keys = stateKeysFor(root, secrets, keep);
  const threads = threadStoreFor(root, secrets, writer, keep);
  const store = new ProfileStore(root, auth, { validator: options.validator ?? (async () => undefined) });
  if (options.keyCopyHook !== false) auth.keyCopy = apiKeyCopyHooks({ projectScopeId: store.projectScopeId, home, keys, log: () => undefined });
  const runner = options.git ?? hermeticRunner();
  const parts: SyncParts = {
    root, home, keys, threads, writer, git: runner, ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    profiles: profileSyncHooks(root, auth, keys, home),
    extra: { sleep: () => Promise.resolve(), random: () => 0 }
  };
  const env: SyncEnv = { root, home, keys, threads, makeSync: (input) => buildStateSync(parts, input), git: runner, keepKeyInProject: keep, writer };
  return { name, root, secrets, auth, store, parts, env, home, keys, threads };
}

/** A project folder with git but no remote and no commits. */
export function folderWithoutRemote(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-noremote-'));
  gitInit(dir);
  return dir;
}

/** Sets up the profile the way the extension's Set Up does: the key goes under this computer's project scope and the sealed copy is written. */
export async function setUpProfile(c: Computer, key = KEY_SENTINEL, profileId = PROFILE): Promise<void> {
  await c.store.configure({ profileId, displayName: 'Company', organization: 'Example Company', baseUrl: ENDPOINT, authMode: 'apiKey' }, key);
}

export interface FakeUi {
  ui: SyncUi;
  /** Every code passed to the screen that shows it. */
  shown: string[];
  /** Every plain message the person was shown. */
  messages: string[];
  /** Every question asked with confirm. */
  confirms: string[];
  /** What the person types for the next askCode. */
  nextCode: string | undefined;
}

export function fakeUi(options: { code?: string; confirm?: boolean; saveCode?: boolean; pickRemote?: string } = {}): FakeUi {
  const fake: FakeUi = { shown: [], messages: [], confirms: [], nextCode: options.code, ui: undefined as unknown as SyncUi };
  fake.ui = {
    showCodeOnce: async (code) => { fake.shown.push(code); return options.saveCode ?? true; },
    askCode: async () => fake.nextCode,
    confirm: async (text) => { fake.confirms.push(text); return options.confirm ?? true; },
    pickRemote: async () => options.pickRemote,
    info: (text) => { fake.messages.push(text); },
    warn: (text) => { fake.messages.push(text); }
  };
  return fake;
}

export { bareRemote, fixtureGit, plainGit };
