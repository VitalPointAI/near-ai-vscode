// Plan 15, task 1 (tracer): turning sync on shows the recovery code once and pushes, and a second computer that enters the code gets the chats, the profile
// and the NEAR AI key (saved under its own project scope, bound to its endpoint) with nothing typed. Local bare repositories and fakes only.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { StateRefusedError } from '../domain/state/keys';
import { openApiKeyCopy } from '../services/stateApiKey';
import { enterCodeFlow, turnOnFlow } from '../services/syncFlows';
import { ENDPOINT, KEY_SENTINEL, PROFILE, REFRESH_SENTINEL, bareRemote, computer, fakeUi, fixtureGit, folderWithoutRemote, setUpProfile } from './helpers/flowFixtures';
import { scanRemote } from './helpers/gitFixtures';
import { SIX_TURNS, chain, remotePayloads, type Machine } from './helpers/syncFixtures';

const THREAD = 'conv-restore-1';

async function seedThread(c: ReturnType<typeof computer>): Promise<string[]> {
  await c.threads.create({ id: THREAD, title: 'Restore me', model: 'near/model-a', origin: 'panel' });
  const entries = chain(THREAD, c.parts.writer, SIX_TURNS);
  await c.threads.appendEntries(THREAD, entries);
  return entries.map((entry) => entry.id).sort();
}

test('tracer: turning sync on shows the code once and pushes; a second computer that enters it gets the chat, the profile and the NEAR AI key', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  const ids = await seedThread(a);

  const turnOn = fakeUi();
  const result = await turnOnFlow({ env: a.env, ui: turnOn.ui });
  assert.equal(result.status, 'on');
  assert.equal(turnOn.shown.length, 1, 'the recovery code is shown exactly once');
  assert.match(turnOn.shown[0] as string, /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/, 'it is 13 groups of 4');
  assert.equal(turnOn.confirms.length, 1, 'what the git host can and cannot see is explained before anything is made');
  assert.match(turnOn.confirms[0] as string, /cannot read your chats or your key/);
  assert.ok(existsSync(path.join(remote, 'refs', 'heads', 'near-ai', 'state')), 'the first sync pushed the state branch');

  const b = computer(remote, 'bravo');
  const enter = fakeUi({ code: turnOn.shown[0] });
  const restored = await enterCodeFlow({ env: b.env, ui: enter.ui });
  assert.equal(restored.status, 'restored');
  assert.match(enter.messages.join('\n'), /Your chats, runs, comparisons and model choices are here, and your NEAR AI key is set up for this project\./);
  assert.equal(enter.shown.length, 0, 'entering a code shows no code');

  // The chat, in full.
  assert.ok((await b.threads.index()).some((item) => item.id === THREAD && item.title === 'Restore me'));
  assert.deepEqual((await b.threads.entries(THREAD)).map((entry) => entry.id).sort(), ids);

  // The profile, to be checked by the existing check.
  const profiles = await b.store.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.profileId, PROFILE);
  assert.equal(profiles[0]?.validation.status, 'stale');
  assert.equal(profiles[0]?.organization, 'Example Company');

  // The key, under this computer's own project scope, for the endpoint it was saved for and no other.
  assert.notEqual(a.store.projectScopeId, b.store.projectScopeId, 'the two computers have different project scopes');
  assert.equal(await b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), ENDPOINT), KEY_SENTINEL);
  await assert.rejects(() => b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), 'https://other.example.test/v1'), /not the one its key was saved for/);

  // This computer's own sealed copy, for its other editors, opens to the same key.
  assert.deepEqual(await readdir(b.home.paths.apiKeysDir), [`${PROFILE}.enc`]);
  assert.equal((await openApiKeyCopy(b.home, b.keys, PROFILE))?.apiKey, KEY_SENTINEL);

  // Sync is on for B and nothing was kept of the code anywhere under B's state home or secrets.
  const code = turnOn.shown[0] as string;
  for (const name of await allFiles(b.home.dir)) assert.ok(!(await readFile(name)).includes(code.replace(/-/g, '')) && !(await readFile(name)).includes(code), `${name} holds the code`);
  for (const value of b.secrets.values.values()) assert.ok(!value.includes(code) && !value.includes(code.replace(/-/g, '')));
});

test('profiles that reuse another project\'s key and team profiles are not sent or restored, no refresh token travels, and no plaintext key is in the remote', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  await a.store.create({ profileId: 'profile-team-alpha', displayName: 'Team', organization: 'Example Company', baseUrl: ENDPOINT, authMode: 'apiKey' });
  await a.auth.saveScopedApiKey(a.store.getScope('profile-team-alpha'), 'team-key-SENTINEL-1b7e', ENDPOINT);
  await a.auth.saveScopedRefreshToken(a.store.getScope(PROFILE), REFRESH_SENTINEL);
  // A profile whose key lives in another project (a linked copy), written the way the profile file keeps one.
  const file = a.store.filePath;
  const ledger = JSON.parse(await readFile(file, 'utf8')) as { profiles: Array<Record<string, unknown>> };
  ledger.profiles.push({
    version: 1, profileId: 'profile-linked', displayName: 'Linked', organization: 'Example Company', provider: 'near-ai', baseUrl: ENDPOINT, authMode: 'apiKey',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', validation: { status: 'stale' }, keySource: { projectId: `project-${'a'.repeat(32)}`, profileId: 'profile-linked' }
  });
  await writeFile(file, `${JSON.stringify(ledger)}\n`);

  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');

  const sent = await sentRecords(remote, a);
  assert.deepEqual(sent.filter((record) => record.kind === 'profile').map((record) => record.id), [PROFILE], 'only the project\'s own profile is sent');
  assert.deepEqual(sent.filter((record) => record.kind === 'secret').map((record) => record.id), [PROFILE], 'only its sealed key copy is sent');
  const scan = scanRemote(remote, [KEY_SENTINEL, REFRESH_SENTINEL, 'team-key-SENTINEL-1b7e']);
  assert.deepEqual(scan.hits, [], 'nothing readable reaches the remote');

  const b = computer(remote, 'bravo');
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code: turnOn.shown[0] }).ui })).status, 'restored');
  assert.deepEqual((await b.store.list()).map((profile) => profile.profileId), [PROFILE]);
  const scope = b.store.getScope(PROFILE);
  assert.equal(await b.auth.getScopedRefreshToken(scope), undefined, 'no refresh token was written');
  for (const value of b.secrets.values.values()) assert.ok(!value.includes(REFRESH_SENTINEL), 'no secret holds the refresh token');
  assert.equal(await b.auth.getScopedApiKey(b.store.getScope('profile-team-alpha')), undefined);
});

test('a wrong code, and a code that is not a code, give one plain refusal and create no state folder at all', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  await seedThread(a);
  assert.equal((await turnOnFlow({ env: a.env, ui: fakeUi().ui })).status, 'on');

  const b = computer(remote, 'bravo');
  const wrong = fakeUi({ code: '0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000' });
  const outcome = await enterCodeFlow({ env: b.env, ui: wrong.ui });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.message, new StateRefusedError('wrong-code-or-damaged').message);
  assert.ok(!existsSync(path.join(b.root, '.near-ai')), 'a wrong code creates no folder in the project');

  const junk = fakeUi({ code: 'not a recovery code' });
  const refusal = await enterCodeFlow({ env: b.env, ui: junk.ui });
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.message, new StateRefusedError('wrong-code-or-damaged').message);
  assert.ok(!existsSync(path.join(b.root, '.near-ai')));
  assert.deepEqual(await b.store.list(), []);
});

test('turning on with no remote starts the online-home flow once and goes on to the code and the first push only when it reports a remote; declining writes nothing', async () => {
  const remote = bareRemote({ withMain: false });
  const root = folderWithoutRemote();
  const c = computer(remote, 'charlie', { root });
  let started = 0;
  const decline = await turnOnFlow({ env: c.env, ui: fakeUi().ui, onlineHome: async () => { started += 1; return { status: 'declined' }; } });
  assert.equal(started, 1);
  assert.equal(decline.status, 'cancelled');
  assert.ok(!existsSync(path.join(root, '.near-ai')), 'declining writes no state folder');
  assert.ok(!existsSync(path.join(remote, 'refs', 'heads', 'near-ai')), 'and pushes nothing');

  const noFlow = fakeUi();
  assert.equal((await turnOnFlow({ env: c.env, ui: noFlow.ui })).status, 'no-home');
  assert.match(noFlow.messages.join('\n'), /no online home/);
  assert.ok(!existsSync(path.join(root, '.near-ai')));

  const accept = fakeUi();
  const done = await turnOnFlow({
    env: c.env, ui: accept.ui,
    onlineHome: async (afterRemote) => {
      started += 1;
      fixtureGit(root, ['remote', 'add', 'origin', remote]);
      const finished = await afterRemote({ name: 'origin', url: remote, git: c.parts.git as never });
      return { status: finished === false ? 'sync-incomplete' : 'done', remote: { name: 'origin', url: remote } };
    }
  });
  assert.equal(started, 2, 'the online-home flow ran once for the accepting call');
  assert.equal(done.status, 'on');
  assert.equal(accept.shown.length, 1, 'the code screen follows');
  assert.ok(existsSync(path.join(remote, 'refs', 'heads', 'near-ai', 'state')), 'and the first push');
});

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(full)); else out.push(full);
  }
  return out;
}

/** Every record the remote's hot objects hold, opened with the computer's key. */
async function sentRecords(remote: string, c: ReturnType<typeof computer>): Promise<Array<{ kind: string; id: string; body: unknown }>> {
  const asMachine = { keys: c.keys, home: c.home } as unknown as Machine;
  const payloads = await remotePayloads(remote, asMachine);
  const records: Array<{ kind: string; id: string; body: unknown }> = [];
  for (const payload of payloads) for (const record of ((payload as { records?: unknown[] }).records ?? []) as Array<{ kind: string; id: string; body: unknown }>) records.push(record);
  return records;
}
