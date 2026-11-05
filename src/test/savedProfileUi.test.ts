// Use a saved profile's prompts (src/services/savedProfileUi.ts, 61-31): Join Team in a team without an organization runs Use a saved profile right
// after the join (61-30), so its pick and messages go through the same prompts module as the join. Under the extension-host tests (NEAR_AI_E2E
// exactly '1') with a script set, the script answers them and they are recorded, so a real window can join with a saved profile and no prompt is left
// waiting; everywhere else they are VS Code's own pick and messages, with the same options as before.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OrganizationProfile } from '../domain/auth';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const { promptTap } = require('../services/team/teamPrompts') as typeof import('../services/team/teamPrompts');
const { savedProfileUi } = require('../services/savedProfileUi') as typeof import('../services/savedProfileUi');
const profileIndex = require('../services/profileIndex') as typeof import('../services/profileIndex');
const { ProfileStore } = require('../services/profileStore') as typeof import('../services/profileStore');
test.after(() => { uninstall(); });

const ORIGINAL_E2E = process.env.NEAR_AI_E2E;

class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

function savedProfile(): OrganizationProfile {
  const now = new Date().toISOString();
  return {
    version: 1, profileId: 'profile-e2e-saved', displayName: 'E2E saved', organization: 'E2E', provider: 'local', baseUrl: 'http://127.0.0.1:9/v1',
    authMode: 'apiKey', createdAt: now, updatedAt: now, validation: { status: 'valid' }
  } as OrganizationProfile;
}

// Two projects on this computer: the profile was set up in the first and is used in the second. Returns the second project's scope id.
// Its key counts as here (hasKey answers true, 61-34): it is a local-only profile, whose key is optional.
async function twoProjects(): Promise<{ thisProject: string; cleanup(): Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-saved-ui-'));
  profileIndex.initProfileIndex(new MemoryMemento());
  const other = new ProfileStore(path.join(base, 'first-project')).projectScopeId;
  await profileIndex.recordProjectProfiles(other, 'first-project', [savedProfile()]);
  return { thisProject: new ProfileStore(path.join(base, 'second-project')).projectScopeId, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function resetStub(): void {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.progress.length = 0;
}

async function withEnv(value: string | undefined, script: Array<{ match: string; answer: string | undefined }> | undefined, work: () => Promise<void>): Promise<void> {
  resetStub();
  if (value === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = value;
  if (script === undefined) delete promptTap.script; else promptTap.script = script;
  promptTap.shown.length = 0;
  try {
    await work();
  } finally {
    if (ORIGINAL_E2E === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = ORIGINAL_E2E;
    delete promptTap.script;
    promptTap.shown.length = 0;
  }
}

test('tracer: under the extension-host tests a script picks the saved profile and the closing message is recorded, and VS Code is not asked', async () => {
  const world = await twoProjects();
  try {
    await withEnv('1', [{ match: 'Use a profile from another project', answer: 'E2E saved' }], async () => {
      const used: string[] = [];
      const outcome = await profileIndex.runUseSavedProfile(savedProfileUi(), {
        projectId: world.thisProject, hasKey: async () => true,
        use: async (entry) => { used.push(entry.displayName); return savedProfile(); },
        setUpNew: async () => { assert.fail('Set up a new profile is not chosen'); },
        refresh: async () => undefined
      });
      assert.equal(outcome, 'ready', 'the saved profile was used');
      assert.deepEqual(used, ['E2E saved'], 'the scripted profile was the one used');
      assert.equal(stub.quickPickRequests.length, 0, 'VS Code was not asked to show the pick');
      assert.deepEqual(stub.notifications, [], 'VS Code was not asked to show a message');
      const pick = promptTap.shown.find((record) => record.kind === 'pick');
      assert.equal(pick?.text, 'Use a profile from another project', 'the pick was recorded with its title');
      assert.deepEqual(pick?.choices, ['E2E saved']);
      assert.equal(pick?.answer, 'E2E saved');
      assert.ok(promptTap.shown.some((record) => record.kind === 'message' && record.text === 'E2E saved is ready for this project.'), 'the closing message was recorded');
      assert.equal(promptTap.script?.length, 0, 'the step was used');
      assert.equal(stub.progress.length, 1, 'the key check still shows its progress');
    });
  } finally {
    await world.cleanup();
  }
});

test('outside the extension-host tests the pick and messages are VS Code\'s own, with the same options as before', async () => {
  const world = await twoProjects();
  try {
    await withEnv(undefined, [{ match: 'Use a profile from another project', answer: 'E2E saved' }], async () => {
      stub.quickPickAnswers.push('E2E saved');
      const outcome = await profileIndex.runUseSavedProfile(savedProfileUi(), {
        projectId: world.thisProject, hasKey: async () => true, use: async () => savedProfile(), setUpNew: async () => undefined, refresh: async () => undefined
      });
      assert.equal(outcome, 'ready');
      assert.equal(stub.quickPickRequests.length, 1, 'VS Code showed the pick');
      assert.equal(stub.quickPickRequests[0]?.title, 'Use a profile from another project');
      assert.deepEqual(stub.notifications.map((entry) => [entry.level, entry.message]), [['info', 'E2E saved is ready for this project.']]);
      assert.deepEqual(promptTap.shown, [], 'nothing is recorded');
      assert.equal(promptTap.script?.length, 1, 'the script is not read');
    });
  } finally {
    await world.cleanup();
  }
});
