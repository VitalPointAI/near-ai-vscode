// Key scope tagging (Phase 61 plan 12, D-14): every request made with a team key profile is tagged keyScope team; a request in a Team Mode project made
// with any other profile is tagged personal; a solo project gets no tag at all, so its ledger lines are exactly what 0.4.8 wrote.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectCredentialScope } from '../domain/auth';
import type { OrganizationProfile } from '../domain/auth';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { activeProvider, clearProviderCache } from '../services/providerCache';
import { createNearAiProvider } from '../services/providerFactory';
import { configureSpend, disposeSpendAccounts, spendAccountFor } from '../services/spendAccount';
import { SpendLedger, currentSpendTag, withSpendTag } from '../services/spendLedger';
import type { SpendEntry } from '../services/spendLedger';
import { teamProfileId } from '../team/teamKeyProfile';
import { MemorySecrets } from './helpers/teamHarness';

const BASE = 'https://cloud-api.near.ai/v1';
const AUDIO = 'openai/whisper';
const TEAM_ID = `team-${'b2'.repeat(16)}`;
const TEAM_KEY = 'sk-team-key-for-scope-test';
const PERSONAL_KEY = 'sk-personal-key-for-scope-test';

function fetchStub(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input).replace(BASE, '');
    if (url === '/models') return Response.json({ data: [{ id: AUDIO, pricing: { input: 0, output: 0, request: '0.006' } }] });
    if (url === '/model/list') return Response.json({ models: [] });
    if (url === '/audio/transcriptions') return Response.json({ text: 'hello' }, { headers: { 'inference-id': `inf-${Math.random().toString(16).slice(2)}` } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function profile(profileId: string): OrganizationProfile {
  return {
    version: 1, profileId, displayName: profileId, organization: 'Example', provider: 'near-ai', baseUrl: BASE, authMode: 'apiKey',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'valid', validatedAt: '2026-01-01T00:00:00Z' }
  };
}

interface Rig { dir: string; root: string; auth: AuthService; store: ProfileStore }

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-scope-ledger-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-scope-project-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchStub();
  configureSpend({ dir, timers: false });
  clearProviderCache();
  try {
    const auth = new AuthService(new MemorySecrets());
    await run({ dir, root, auth, store: new ProfileStore(root, auth, { validator: async () => undefined }) });
  } finally {
    globalThis.fetch = realFetch;
    disposeSpendAccounts();
    clearProviderCache();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

async function configureProfile(rig: Rig, profileId: string, key: string): Promise<void> {
  await rig.store.configure({ profileId, displayName: profileId, organization: 'Example', baseUrl: BASE, authMode: 'apiKey' }, key);
}

async function markTeamProject(root: string): Promise<void> {
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, '.planning', '.near-ai', 'team.json'), '{}\n', 'utf8');
}

type Client = Awaited<ReturnType<typeof createNearAiProvider>>['client'];

// One billable request, then the entries the key's ledger holds for it.
async function oneRequest(client: Client, key: string): Promise<SpendEntry[]> {
  await client.listModelsWithPricing();
  await client.transcribeAudio(AUDIO, new Uint8Array([1, 2, 3]), 'clip.wav', 'audio/wav');
  const account = spendAccountFor(BASE, key);
  assert.ok(account !== undefined, 'the key has a spend account');
  await account.ledger.flush();
  return account.ledger.list();
}

async function ledgerLines(dir: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else lines.push(...(await readFile(full, 'utf8')).split('\n').filter((line) => line.trim() !== ''));
    }
  };
  await walk(dir);
  return lines;
}

test('a provider built for the team key tags its ledger entries keyScope team, and a reloaded ledger still has the tag', async () => {
  await withRig(async (rig) => {
    const scope = createProjectCredentialScope(rig.root, 'profile-team');
    await rig.auth.saveScopedApiKey(scope, TEAM_KEY, BASE);
    const provider = await createNearAiProvider({ auth: rig.auth, profile: profile('profile-team'), scope, keyScope: 'team' });
    const entries = await oneRequest(provider.client, TEAM_KEY);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.keyScope, 'team');

    const account = spendAccountFor(BASE, TEAM_KEY);
    const reloaded = new SpendLedger(account?.ledger.dir ?? '');
    await reloaded.refresh();
    assert.equal(reloaded.list()[0]?.keyScope, 'team');
  });
});

test('without a keyScope the entries and the lines on disk are exactly what 0.4.8 wrote', async () => {
  await withRig(async (rig) => {
    const scope = createProjectCredentialScope(rig.root, 'profile-solo');
    await rig.auth.saveScopedApiKey(scope, PERSONAL_KEY, BASE);
    const provider = await createNearAiProvider({ auth: rig.auth, profile: profile('profile-solo'), scope });
    const entries = await oneRequest(provider.client, PERSONAL_KEY);
    assert.equal(entries.length, 1);
    assert.equal('keyScope' in (entries[0] as object), false, 'no keyScope property');
    for (const line of await ledgerLines(rig.dir)) assert.equal(line.includes('keyScope') || line.includes('"ks"'), false, 'no scope on disk');
    assert.equal('keyScope' in currentSpendTag(), false);
    assert.equal('keyScope' in withSpendTag({ kind: 'main' }, () => currentSpendTag()), false);
  });
});

test('activeProvider: a team key profile is tagged team, another profile in a team project is tagged personal, a solo project gets no tag', async () => {
  await withRig(async (rig) => {
    // A team project whose active profile is the team key profile.
    await markTeamProject(rig.root);
    await configureProfile(rig, teamProfileId(TEAM_ID), TEAM_KEY);
    await rig.store.select(teamProfileId(TEAM_ID));
    const team = await activeProvider(rig.root, rig.auth);
    assert.ok(team !== undefined);
    assert.equal((await oneRequest(team.provider.client, TEAM_KEY))[0]?.keyScope, 'team');

    // The same team project after the member switches to a personal profile.
    await configureProfile(rig, 'profile-personal', PERSONAL_KEY);
    await rig.store.select('profile-personal');
    const personal = await activeProvider(rig.root, rig.auth);
    assert.ok(personal !== undefined);
    assert.equal((await oneRequest(personal.provider.client, PERSONAL_KEY))[0]?.keyScope, 'personal');
  });
  await withRig(async (rig) => {
    // A solo project: no team.json, any profile, no tag.
    await configureProfile(rig, 'profile-personal', PERSONAL_KEY);
    await rig.store.select('profile-personal');
    const solo = await activeProvider(rig.root, rig.auth);
    assert.ok(solo !== undefined);
    const entries = await oneRequest(solo.provider.client, PERSONAL_KEY);
    assert.equal(entries.length, 1);
    assert.equal('keyScope' in (entries[0] as object), false);
  });
});

// WR-05: a provider cached while the project was solo must not keep running untagged after Team Mode is enabled in the same window.
test('WR-05: enabling Team Mode in a running window tags the next personal-key run personal, without waiting for the cache to expire', async () => {
  await withRig(async (rig) => {
    await configureProfile(rig, 'profile-personal', PERSONAL_KEY);
    await rig.store.select('profile-personal');
    const solo = await activeProvider(rig.root, rig.auth);
    assert.ok(solo !== undefined);
    assert.equal('keyScope' in ((await oneRequest(solo.provider.client, PERSONAL_KEY))[0] as object), false, 'solo: no tag');

    await markTeamProject(rig.root);
    const team = await activeProvider(rig.root, rig.auth);
    assert.ok(team !== undefined);
    const entries = await oneRequest(team.provider.client, PERSONAL_KEY);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.keyScope ?? 'none').sort(), ['none', 'personal'], 'the run after enabling is tagged personal');
  });
});
