// The person's own key pasted at Join (D-21 as amended by the owner in the 0.6.4 re-test, 2026-11-05): it becomes their own profile 'My NEAR AI
// key' through the normal profile store, never the team key profile. These tests hold its guarantees: listed in the saved-profile list for their
// other projects, kept (with its key and its selection) when the team key goes, never replaced by a team key a lead delivers later, counted as
// personal spend, bound to the address it was checked against, and the key itself never written anywhere but secure storage. The last two tests
// drive the real commands on real git with the Team section host attached to a recorded page: every Team Mode profile change outside a join (the
// clean-up after the person's own removal, the unfinished-join reset) asks the page once for a fresh profile status. They live here, not in
// teamConnectRefresh.test.ts, so that file stays exactly as the RED commit 5297b2d wrote it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deriveProfileId } from '../domain/auth';
import { AuthService } from '../services/auth';
import { initProfileIndex, isTeamProfileId, listSavedProfiles } from '../services/profileIndex';
import { ProfileStore } from '../services/profileStore';
import { activeProvider, clearProviderCache } from '../services/providerCache';
import { configureSpend, disposeSpendAccounts, spendAccountFor } from '../services/spendAccount';
import type { FetchLike } from '../services/reportingSignIn';
import { pushCodeBranch } from '../team/enable';
import { createDeviceIdentity, deviceKeySecretName } from '../team/identity';
import { OWN_KEY_PROFILE_NAME, installOwnKey, installTeamKey, readInstalledKey, removeTeamKey, teamProfileId } from '../team/teamKeyProfile';
import { activeProfileOf, closeRig, createRig, enable, invite, remove, rootOf, teamIdOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { MemorySecrets, gitIn } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
test.after(() => { uninstall(); });
const { registerTeamMode } = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const { JOIN_COMMAND, JOIN_TEXT } = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
const { createTeamSectionHost } = require('../services/team/teamSectionHost') as typeof import('../services/team/teamSectionHost');

const BASE = 'https://cloud-api.near.ai/v1';
const OTHER_BASE = 'https://other-endpoint.example.invalid/v1';
const ORG = 'org-own-check';
const TEAM_ID = `team-${'c3'.repeat(16)}`;
const AUDIO = 'openai/whisper';
const PUBLIC_URL = 'https://example.invalid/team.git';
const REFRESH_STATUS = { type: 'host-request', payload: { type: 'refresh-status' } };

/** VS Code's globalState for the saved-profile list: values kept in memory. */
class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key); else this.values.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
  public dump(): string { return JSON.stringify([...this.values.entries()]); }
}

/** NEAR AI's check_api_key as a stub: answers for the one key it knows, counts the calls and keeps no key. */
function checkStub(key: string, answer: { status: 200 | 401; organizationId?: string; workspaceId?: string; keyId?: string } = { status: 200 }): { fetch: FetchLike; calls(): number } {
  let calls = 0;
  const fetch: FetchLike = async (url, init) => {
    calls += 1;
    assert.ok(url.endsWith('/check_api_key'), `only check_api_key is asked: ${url}`);
    const sent = init.headers['authorization'] === `Bearer ${key}`;
    const status = sent ? answer.status : 401;
    const body = status === 200 ? { api_key_id: answer.keyId ?? 'key-own', organization_id: answer.organizationId ?? ORG, workspace_id: answer.workspaceId ?? 'ws-own', valid: true } : { error: 'unauthorized' };
    return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls: () => calls };
}

async function filesUnder(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(folder);
  return found;
}

async function holdsKey(folder: string, key: string): Promise<string[]> {
  const holders: string[] = [];
  for (const file of await filesUnder(folder)) if ((await readFile(file)).includes(Buffer.from(key))) holders.push(file);
  return holders;
}

interface World { base: string; rootA: string; rootB: string; storage: string; secrets: MemorySecrets; auth: AuthService; memento: MemoryMemento; key: string }

async function withWorld(run: (world: World) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-own-key-'));
  const rootA = path.join(base, 'alpha-site');
  const rootB = path.join(base, 'beta-app');
  const storage = path.join(base, 'global-storage');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await mkdir(storage, { recursive: true });
  const memento = new MemoryMemento();
  initProfileIndex(memento);
  const secrets = new MemorySecrets();
  try {
    await run({ base, rootA, rootB, storage, secrets, auth: new AuthService(secrets), memento, key: `sk-own-${'9f'.repeat(16)}` });
  } finally {
    initProfileIndex(undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function installOwn(world: World, root = world.rootA): Promise<string> {
  const check = checkStub(world.key);
  const result = await installOwnKey({ projectRoot: root, secrets: world.secrets, apiKey: Buffer.from(world.key, 'utf8'), baseUrl: BASE, fetch: check.fetch });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(check.calls(), 1, 'one check, no second probe');
  if (!result.ok) throw new Error('not installed');
  return result.profileId;
}

test('the own key is listed in the saved-profile list by name and folder, and another project on this computer can use it', async () => {
  await withWorld(async (world) => {
    const profileId = await installOwn(world);
    assert.equal(profileId, deriveProfileId(world.rootA, OWN_KEY_PROFILE_NAME));
    assert.equal(isTeamProfileId(profileId), false);
    const listed = listSavedProfiles().filter((entry) => entry.profileId === profileId);
    assert.equal(listed.length, 1, 'listed once');
    assert.equal(listed[0]?.displayName, 'My NEAR AI key');
    assert.equal(listed[0]?.projectLabel, 'alpha-site');
    assert.equal(listed[0]?.organization, ORG, 'the organization the key check named');
    const storeB = new ProfileStore(world.rootB, world.auth, { validator: async () => undefined });
    const offered = listSavedProfiles(storeB.projectScopeId).find((entry) => entry.profileId === profileId);
    assert.ok(offered !== undefined, 'offered in another project');
    const used = await storeB.useSavedProfile(offered);
    assert.equal(used.validation.status, 'valid');
    assert.equal((await storeB.getActiveSelection())?.profileId, profileId, 'the other project now uses it');
    assert.equal(world.memento.dump().includes(world.key), false, 'the saved-profile list holds no key');
  });
});

test('taking a team key out of the project leaves the own profile, its key and its selection', async () => {
  await withWorld(async (world) => {
    const profileId = await installOwn(world);
    const result = await removeTeamKey({ projectRoot: world.rootA, globalStorageDir: world.storage, teamId: TEAM_ID, secrets: world.secrets });
    assert.deepEqual(result, {});
    const store = new ProfileStore(world.rootA, world.auth);
    assert.equal((await store.getActiveSelection())?.profileId, profileId, 'still selected');
    assert.equal((await store.get(profileId))?.displayName, 'My NEAR AI key', 'still there');
    assert.equal(await world.auth.getScopedApiKey(store.getScope(profileId)), world.key, 'its key is still in secure storage');
  });
});

test('a team key a lead delivers later gets its own profile, remembers the own profile, and taking it out selects the own profile again', async () => {
  await withWorld(async (world) => {
    const ownId = await installOwn(world);
    const teamKey = `sk-team-${'7e'.repeat(16)}`;
    const check = checkStub(teamKey, { status: 200, organizationId: 'org-team', workspaceId: 'ws-team', keyId: 'key-team' });
    const installed = await installTeamKey({
      projectRoot: world.rootA, globalStorageDir: world.storage, teamId: TEAM_ID, teamName: 'Harbor', secrets: world.secrets, apiKey: Buffer.from(teamKey, 'utf8'),
      baseUrl: BASE, expect: { organizationId: 'org-team', workspaceId: 'ws-team' }, keyId: 'key-team', fetch: check.fetch, attempts: 1
    });
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message);
    assert.equal(installed.ok && installed.profileId, teamProfileId(TEAM_ID), 'the team key has its own profile');
    const store = new ProfileStore(world.rootA, world.auth);
    assert.equal((await store.getActiveSelection())?.profileId, teamProfileId(TEAM_ID));
    assert.equal((await store.get(ownId))?.displayName, 'My NEAR AI key', 'the own profile is untouched');
    assert.equal(await world.auth.getScopedApiKey(store.getScope(ownId)), world.key, 'the own key is untouched');
    assert.equal(await world.auth.getScopedApiKey(store.getScope(teamProfileId(TEAM_ID))), teamKey);
    assert.equal((await readInstalledKey(world.storage, TEAM_ID))?.previousProfileId, ownId, 'the own profile is the one to go back to');
    const removed = await removeTeamKey({ projectRoot: world.rootA, globalStorageDir: world.storage, teamId: TEAM_ID, secrets: world.secrets });
    assert.equal(removed.restoredProfileId, ownId);
    const fresh = new ProfileStore(world.rootA, world.auth);
    assert.equal((await fresh.getActiveSelection())?.profileId, ownId, 'the own profile is selected again');
    assert.equal(await world.auth.getScopedApiKey(fresh.getScope(ownId)), world.key);
  });
});

test('in a team project the own profile\'s runs are tagged personal spend, not team spend', async () => {
  await withWorld(async (world) => {
    await mkdir(path.join(world.rootA, '.planning', '.near-ai'), { recursive: true });
    await writeFile(path.join(world.rootA, '.planning', '.near-ai', 'team.json'), '{}\n', 'utf8');
    const ledgerDir = path.join(world.base, 'ledger');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input).replace(BASE, '');
      if (url === '/models') return Response.json({ data: [{ id: AUDIO, pricing: { input: 0, output: 0, request: '0.006' } }] });
      if (url === '/model/list') return Response.json({ models: [] });
      if (url === '/audio/transcriptions') return Response.json({ text: 'hello' }, { headers: { 'inference-id': `inf-${Math.random().toString(16).slice(2)}` } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    configureSpend({ dir: ledgerDir, timers: false });
    clearProviderCache();
    try {
      await installOwn(world);
      const active = await activeProvider(world.rootA, world.auth);
      assert.ok(active !== undefined, 'the own profile gives a provider');
      await active.provider.client.listModelsWithPricing();
      await active.provider.client.transcribeAudio(AUDIO, new Uint8Array([1, 2, 3]), 'clip.wav', 'audio/wav');
      const account = spendAccountFor(BASE, world.key);
      assert.ok(account !== undefined, 'the key has a spend account');
      await account.ledger.flush();
      const entries = account.ledger.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.keyScope, 'personal');
    } finally {
      globalThis.fetch = realFetch;
      disposeSpendAccounts();
      clearProviderCache();
    }
  });
});

test('the own key is bound to the address it was checked against: another address gets no key', async () => {
  await withWorld(async (world) => {
    const profileId = await installOwn(world);
    const scope = new ProfileStore(world.rootA, world.auth).getScope(profileId);
    assert.equal(await world.auth.getScopedApiKeyFor(scope, BASE), world.key);
    await assert.rejects(() => world.auth.getScopedApiKeyFor(scope, OTHER_BASE), /not the one its key was saved for/);
  });
});

test('the buffer holding the key is all zeros after a success and after a refusal, and a refused key stores and selects nothing', async () => {
  await withWorld(async (world) => {
    const accepted = Buffer.from(world.key, 'utf8');
    const ok = await installOwnKey({ projectRoot: world.rootA, secrets: world.secrets, apiKey: accepted, baseUrl: BASE, fetch: checkStub(world.key).fetch });
    assert.equal(ok.ok, true);
    assert.ok(accepted.every((byte) => byte === 0), 'wiped after a success');

    const refusedSecrets = new MemorySecrets();
    const refused = Buffer.from('sk-refused-0123456789abcdef', 'utf8');
    const no = await installOwnKey({ projectRoot: world.rootB, secrets: refusedSecrets, apiKey: refused, baseUrl: BASE, fetch: checkStub(world.key).fetch });
    assert.deepEqual(no, { ok: false, code: 'invalid', message: 'NEAR AI did not accept this key. Check it and try again.' });
    assert.ok(refused.every((byte) => byte === 0), 'wiped after a refusal');
    assert.equal(refusedSecrets.values.size, 0, 'nothing stored');
    assert.deepEqual(await new ProfileStore(world.rootB, new AuthService(refusedSecrets)).list(), [], 'no profile');
  });
});

// ---- the real commands on real git ------------------------------------------------------------------------------------------------------------

function clearUi(): void {
  for (const list of [stub.outputChannels, stub.notifications, stub.notificationActions, stub.notificationOptions, stub.configUpdates, stub.inputAnswers, stub.inputRequests,
    stub.messageAnswers, stub.quickPickAnswers, stub.quickPickRequests, stub.clipboardWrites, stub.externalCommands, stub.progress]) (list as unknown[]).length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
}

type Webview = Parameters<ReturnType<typeof createTeamSectionHost>['attach']>[0];
function page(): { webview: Webview; record: RecordedWebview } {
  const made = stub.createWebviewView();
  return { webview: (made.view as { webview: Webview }).webview, record: made.record };
}

const refreshRequests = (record: RecordedWebview): number => record.posted.filter((message) => JSON.stringify(message) === JSON.stringify(REFRESH_STATUS)).length;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

interface DevWindow { handle: ReturnType<typeof registerTeamMode>; commands: Map<string, (...args: unknown[]) => unknown>; host: ReturnType<typeof createTeamSectionHost>; record: RecordedWebview; close(): Promise<void> }

// The owner turns Team Mode on in clone a (no organization), publishes main and invites the developer; the developer's window is on clone b, a
// teammate's copy pointing at the same public address, with the Team section host attached to a recorded page.
async function withDevWindow(before: ((rig: Rig) => Promise<void>) | undefined, work: (rig: Rig, bundle: string, window: DevWindow) => Promise<void>): Promise<void> {
  clearUi();
  stub.setConfig('nearAi.team.pollSeconds', 3600);
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
    assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
    const b = rootOf(rig, 'b');
    gitIn(b, ['config', `url.${rig.fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(b, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    const { bundle } = await invite(rig, rig.dev);
    if (before !== undefined) await before(rig);
    stub.setWorkspaceFolders([b]);
    const context = createFakeContext(rig.fixture.storageDir('b'), rig.dev.secrets);
    const handle = registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    await handle.ready;
    const commands = new Map(stub.commands);
    const host = createTeamSectionHost({ team: handle, firstFolder: () => b, executeCommand: async () => undefined, now: () => 0, testSeams: false });
    const shown = page();
    host.attach(shown.webview);
    await host.refresh();
    const close = async (): Promise<void> => {
      host.dispose();
      await handle.session()?.sync();
      for (const subscription of context.subscriptions) subscription.dispose();
    };
    try {
      await work(rig, bundle, { handle, commands, host, record: shown.record, close });
    } finally {
      await close();
    }
  } finally {
    await closeRig(rig);
  }
}

async function joinWithOwnKey(rig: Rig, bundle: string, window: DevWindow): Promise<void> {
  stub.inputAnswers.push(bundle, 'Dana D', rig.dev.ownKey as string);
  stub.quickPickAnswers.push(JOIN_TEXT.pasteOwnKey);
  const join = window.commands.get(JOIN_COMMAND);
  assert.ok(join !== undefined);
  await join();
  await settle();
}

test('Join with Paste your own key writes the key into no project file, saved-profile entry, team storage file, notice or output line', async () => {
  const memento = new MemoryMemento();
  initProfileIndex(memento);
  try {
    await withDevWindow(undefined, async (rig, bundle, window) => {
      await joinWithOwnKey(rig, bundle, window);
      const key = rig.dev.ownKey as string;
      const b = rootOf(rig, 'b');
      const active = await activeProfileOf(rig, rig.dev);
      assert.equal(active, deriveProfileId(b, OWN_KEY_PROFILE_NAME));
      assert.equal(isTeamProfileId(active ?? ''), false, 'not a team key profile');
      assert.deepEqual(await holdsKey(b, key), [], 'no file of the project (profile file included) holds the key');
      assert.equal(memento.dump().includes(key), false, 'the saved-profile list holds no key');
      assert.ok(listSavedProfiles().some((entry) => entry.profileId === active), 'the own profile is in the saved-profile list');
      assert.deepEqual(await holdsKey(rig.fixture.storageDir('b'), key), [], 'no file under the team storage folder holds the key');
      assert.equal(JSON.stringify(stub.notifications).includes(key), false, 'no notice holds the key');
      assert.equal(JSON.stringify(stub.outputChannels.flatMap((channel) => channel.lines)).includes(key), false, 'no output line holds the key');
    });
  } finally {
    initProfileIndex(undefined);
  }
});

test('after the person\'s own removal the page is asked once for a fresh profile status, and the own profile, its key and its selection stay', async () => {
  await withDevWindow(undefined, async (rig, bundle, window) => {
    await joinWithOwnKey(rig, bundle, window);
    const b = rootOf(rig, 'b');
    const ownId = deriveProfileId(b, OWN_KEY_PROFILE_NAME);
    assert.equal(await activeProfileOf(rig, rig.dev), ownId);
    await remove(rig, 'owner', rig.dev);
    window.record.posted.length = 0;
    await window.handle.session()?.sync();
    await settle();
    assert.equal(window.handle.session()?.isRemoved(), true, 'the developer\'s computer saw the removal');
    assert.equal(refreshRequests(window.record), 1, `the page is asked once for a fresh profile status; it got ${JSON.stringify(window.record.posted.map((m) => (m as { type?: string }).type))}`);
    const store = new ProfileStore(b, new AuthService(rig.dev.secrets));
    assert.equal((await store.getActiveSelection())?.profileId, ownId, 'the own profile is still selected');
    assert.equal((await store.get(ownId))?.displayName, 'My NEAR AI key', 'the own profile is still there');
    assert.equal(await new AuthService(rig.dev.secrets).getScopedApiKey(store.getScope(ownId)), rig.dev.ownKey, 'its key is still in secure storage');
  });
});

test('the unfinished-join reset (Remove unfinished keys) asks the page once for a fresh profile status', async () => {
  // An interrupted join left the copy up to date and a device key for this team on the developer's computer before the window opened, so the
  // window runs a team session that does not show this computer.
  await withDevWindow(async (rig) => {
    gitIn(rootOf(rig, 'b'), ['pull', '-q', '--ff-only', 'origin', 'main']);
    await createDeviceIdentity(rig.dev.secrets, teamIdOf(rig));
  }, async (rig, bundle, window) => {
    assert.ok(window.handle.session() !== undefined, 'the window runs the team session');
    assert.ok(rig.dev.secrets.values.has(deviceKeySecretName(teamIdOf(rig))));
    window.record.posted.length = 0;
    stub.inputAnswers.push(bundle, 'Dana D');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove unfinished keys') ? 'Remove unfinished keys' : undefined));
    const join = window.commands.get(JOIN_COMMAND);
    assert.ok(join !== undefined);
    await join();
    await settle();
    stub.setMessageResponder(undefined);
    assert.equal(rig.dev.secrets.values.has(deviceKeySecretName(teamIdOf(rig))), false, `the unfinished keys were removed: ${stub.notifications.map((n) => n.message).join(' | ')}`);
    assert.equal(refreshRequests(window.record), 1, `the page is asked once for a fresh profile status; it got ${JSON.stringify(window.record.posted.map((m) => (m as { type?: string }).type))}`);
  });
});
