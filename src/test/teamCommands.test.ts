// The Enable Team Mode and Verify Team Log commands end to end through the vscode stub, on real git: the questions and their defaults,
// the team.json-only commit, Push only when clicked, quiet cancellation, the existing-team and failure messages, and a SEC-01 canary scan
// of every place the command layer can show or store text. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { API_KEY_SECRET, REFRESH_TOKEN_SECRET } from '../services/auth';
import { DEVICE_KEY_SECRET } from '../team/identity';
import { TEAM_FILE_REL, projectTrustDir, readTeamFile, teamStorageDir } from '../team/teamFile';
import { enableTeamMode } from '../team/enable';
import { deviceKeyFormDigests, deviceKeyForms, makeCanaries, scanFiles, scanFilesForDigests, scanGitObjects, scanGitObjectsForDigests } from './helpers/teamCanary';
import type { LabelledDigest, Needle } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { FakeContext } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, PREVIEW_OFF_TEXT, PUSH_ACTION, TRUST_CONFIRM_ACTION, TRUST_NEW_TEAM_ACTION, VERIFY_ACTION, VERIFY_LOG_COMMAND, registerTeamMode, teamModeTestApi } = commandsModule;

const EM_DASH = '—';
const COORDINATION_BRANCH = 'refs/heads/near-ai/coordination';
// src/services/spendTracking.ts holds this constant but imports vscode, which a node test cannot load, so the key is repeated here.
const REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken';

interface Project {
  fixture: TeamFixture;
  root: string;
  storage: string;
  secrets: MemorySecrets;
  canaries: ReturnType<typeof makeCanaries>;
  context: FakeContext;
  handle: ReturnType<typeof registerTeamMode>;
  enable(answers: Array<string | undefined>, choices?: Array<string | undefined>): Promise<void>;
  verify(): Promise<void>;
}

function resetStub(): void {
  stub.outputChannels.length = 0;
  stub.statusBarItems.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.configUpdates.length = 0;
  stub.inputAnswers.length = 0;
  stub.messageAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
}

async function withProject(run: (project: Project) => Promise<void>, options: { initialised?: boolean; folderOpen?: boolean; preview?: boolean } = {}): Promise<void> {
  resetStub();
  // Enable is only offered to a person who turned the preview on; tests that need it off say so.
  stub.setConfig('nearAi.team.preview', options.preview ?? true);
  const fixture = await createTeamFixture({ clones: ['a'], initialised: options.initialised ?? true });
  const root = fixture.clones['a'] as string;
  const canaries = makeCanaries();
  const secrets = new MemorySecrets();
  secrets.values.set(API_KEY_SECRET, canaries.apiKey);
  secrets.values.set(REFRESH_TOKEN_SECRET, canaries.refreshToken);
  secrets.values.set(REPORTING_TOKEN_KEY, canaries.reportingToken);
  const storage = fixture.storageDir('a');
  const context = createFakeContext(storage, secrets);
  try {
    if (options.folderOpen !== false) stub.setWorkspaceFolders([root]);
    const handle = registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    const run1 = async (command: string): Promise<void> => {
      const handler = stub.commands.get(command);
      assert.ok(handler !== undefined, `${command} is registered`);
      await handler();
    };
    await run({
      fixture, root, storage, secrets, canaries, context, handle,
      async enable(answers, choices = []) {
        stub.inputAnswers.push(...answers);
        stub.messageAnswers.push(...choices);
        await run1(ENABLE_COMMAND);
      },
      verify: () => run1(VERIFY_LOG_COMMAND)
    });
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await fixture.cleanup();
  }
}

const outputLines = (): string[] => stub.outputChannels.flatMap((channel) => channel.lines);
const messages = (): string[] => stub.notifications.map((entry) => entry.message);
const remoteMain = (fixture: TeamFixture): string => gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']);
const remoteHasCoordination = (fixture: TeamFixture): boolean => gitIn(fixture.remote, ['for-each-ref', COORDINATION_BRANCH]) !== '';
const teamJsonExists = async (root: string): Promise<boolean> => (await readTeamFile(root)) !== undefined;

// Every place the command layer can show text: channel lines, notifications, status bar text and tooltips.
function uiText(): string {
  return JSON.stringify({ lines: outputLines(), notifications: stub.notifications, bars: stub.statusBarItems.map((item) => [item.text, item.tooltip]) });
}

test('Enable asks for team name and owner name with defaults (never an email), creates team.json, starts the session and offers Push and Verify Team Log', async () => {
  await withProject(async (p) => {
    const mainBefore = remoteMain(p.fixture);
    await p.enable(['Command team', 'Lead Owner']);

    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]), ['Team name', 'Your name as teammates will see it']);
    assert.equal(stub.inputRequests[0]?.value, 'a', 'the team name defaults to the folder name');
    assert.equal(stub.inputRequests[1]?.value, 'Team Test', 'the owner name defaults to git user.name');
    assert.equal(JSON.stringify(stub.inputRequests).includes('@'), false, 'no prompt asks for or shows an email address');

    const teamFile = await readTeamFile(p.root);
    assert.ok(teamFile !== undefined, 'team.json was written');
    assert.equal(teamFile.name, 'Command team');
    assert.equal(p.handle.session()?.teamFile.teamId, teamFile.teamId, 'the session is running');
    assert.equal(stub.statusBarItems.length, 1);
    assert.equal(stub.statusBarItems[0]?.text, 'Team: Command team');
    assert.equal(gitIn(p.root, ['log', '-1', '--format=%s']), 'chore(team): enable NEAR AI Team Mode');
    assert.equal(gitIn(p.root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);

    const doneIndex = stub.notifications.findIndex((entry) => entry.message.startsWith('Team Mode is on for Command team'));
    const done = stub.notifications[doneIndex];
    assert.ok(done !== undefined, 'the confirmation is shown');
    assert.equal(done.level, 'info');
    assert.deepEqual(stub.notificationActions[doneIndex], [PUSH_ACTION, VERIFY_ACTION]);
    assert.equal(done.message, 'Team Mode is on for Command team. Share it so teammates can see the team.');
    assert.ok(outputLines().includes('team.json is committed on main. Sharing pushes main to origin.'), 'the git detail stays in the channel');
    assert.equal(remoteMain(p.fixture), mainBefore, 'the code branch was not pushed because Push was not clicked');
    assert.deepEqual(stub.configUpdates, [], 'settings were never written');
    assert.ok(remoteHasCoordination(p.fixture), 'the coordination branch exists on the remote');
  });
});

test('choosing Push pushes the current branch and reports it', async () => {
  await withProject(async (p) => {
    const mainBefore = remoteMain(p.fixture);
    await p.enable(['Push team', 'Lead Owner'], [PUSH_ACTION]);
    const head = gitIn(p.root, ['rev-parse', 'HEAD']);
    assert.notEqual(head, mainBefore);
    assert.equal(remoteMain(p.fixture), head, 'the remote main now equals the clone HEAD');
    assert.ok(messages().includes('Shared with your team.'));
    assert.equal(messages().some((message) => message.includes('Pushed main')), false, 'the notification has no git words');
    assert.ok(outputLines().includes('Pushed main to origin.'));
  });
});

// 0.4.26 (PR #62 review): a key-history warning from any path, not only Enable's own call, reaches the NEAR AI Team channel once Team Mode is in use.
test('once Team Mode is on, a key-history warning from a path that passed no callback reaches the NEAR AI Team channel', async () => {
  const { appendKeyRecord, KEY_HISTORY_FILE } = require('../team/keyHistory') as typeof import('../team/keyHistory');
  const { identityDir, loadDeviceIdentity } = require('../team/identity') as typeof import('../team/identity');
  await withProject(async (p) => {
    await p.enable(['Warn team', 'Lead Owner']);
    const identity = await loadDeviceIdentity(p.secrets);
    assert.ok(identity !== undefined);
    const folder = identityDir(p.storage);
    const file = path.join(folder, KEY_HISTORY_FILE);
    const failing = {
      get: (key: string) => p.secrets.get(key), delete: (key: string) => p.secrets.delete(key),
      store: async (): Promise<void> => {
        await rm(file, { force: true });
        await mkdir(path.join(file, 'blocked'), { recursive: true });
        throw new Error('store failed');
      }
    };
    await assert.rejects(appendKeyRecord(folder, failing, identity, { kind: 'revoked', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey } }), /saved end could not be stored/);
    assert.ok(outputLines().some((line) => line.startsWith('The key history could not be put back')), outputLines().join('\n'));
  });
});

// 0.4.27 (PR #67 review): the sink is installed when Team Mode registers, so a key-history warning raised before Enable or any session (a rotation or a
// revocation) reaches the channel too; it is one sink, and it goes away with the extension.
test('before Enable or any session, a key-history warning from a path that passed no callback still reaches the NEAR AI Team channel', async () => {
  const { appendKeyRecord, KEY_HISTORY_FILE } = require('../team/keyHistory') as typeof import('../team/keyHistory');
  const { createDeviceIdentity, identityDir } = require('../team/identity') as typeof import('../team/identity');
  const { keyHistoryWarningSink } = require('../domain/keyHistoryWarnings') as typeof import('../domain/keyHistoryWarnings');
  let installed: ReturnType<typeof keyHistoryWarningSink>;
  await withProject(async (p) => {
    assert.equal(p.handle.session(), undefined, 'no session, no Enable');
    installed = keyHistoryWarningSink();
    assert.ok(installed !== undefined, 'the sink exists from registration');
    const identity = await createDeviceIdentity(p.secrets);
    const folder = identityDir(p.storage);
    await appendKeyRecord(folder, p.secrets, identity, { kind: 'created', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey } });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const failing = {
      get: (key: string) => p.secrets.get(key), delete: (key: string) => p.secrets.delete(key),
      store: async (): Promise<void> => {
        await rm(file, { force: true });
        await mkdir(path.join(file, 'blocked'), { recursive: true });
        throw new Error('store failed');
      }
    };
    await assert.rejects(appendKeyRecord(folder, failing, identity, { kind: 'revoked', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey } }), /saved end could not be stored/);
    assert.equal(outputLines().filter((line) => line.startsWith('The key history could not be put back')).length, 1, 'one sink, one line');
  });
  assert.notEqual(keyHistoryWarningSink(), installed!, 'deactivating removed the sink');
});

test('key-history sinks: disposing one removes exactly that one, so a disposed sink never comes back', () => {
  const { keyHistoryWarningSink, setKeyHistoryWarningSink } = require('../domain/keyHistoryWarnings') as typeof import('../domain/keyHistoryWarnings');
  const base = keyHistoryWarningSink();
  const a = (): void => undefined; const b = (): void => undefined;
  const first = setKeyHistoryWarningSink(a);
  const second = setKeyHistoryWarningSink(b);
  assert.equal(keyHistoryWarningSink(), b);
  first.dispose();
  assert.equal(keyHistoryWarningSink(), b, 'disposing the older one leaves the newer');
  second.dispose();
  assert.equal(keyHistoryWarningSink(), base, 'and neither comes back');
  first.dispose();
  assert.equal(keyHistoryWarningSink(), base, 'disposing twice is harmless');
});

test('a failing Push reports the redacted reason as an error', async () => {
  await withProject(async (p) => {
    // The bare remote refuses non-fast-forward updates, so a diverged main makes the push fail.
    const other = path.join(p.fixture.root, 'other');
    gitIn(p.fixture.root, ['clone', '-q', p.fixture.remote, other]);
    gitIn(other, ['config', 'user.name', 'Other']);
    gitIn(other, ['config', 'user.email', 'other@example.invalid']);
    writeFileSync(path.join(other, 'other.txt'), 'x', 'utf8');
    gitIn(other, ['add', 'other.txt']);
    gitIn(other, ['commit', '-q', '-m', 'other work']);
    gitIn(other, ['push', '-q', 'origin', 'main']);
    await p.enable(['Failing push', 'Lead Owner'], [PUSH_ACTION]);
    const failure = stub.notifications.find((entry) => entry.level === 'error');
    assert.ok(failure !== undefined, 'the failed push is shown as an error');
    assert.ok(failure.message.startsWith('Pushing main to origin failed'));
    assert.ok(outputLines().includes(failure.message), 'and kept in the channel');
  });
});

test('choosing Verify Team Log writes the report to the NEAR AI Team channel', async () => {
  await withProject(async (p) => {
    await p.enable(['Verify team', 'Lead Owner'], [VERIFY_ACTION]);
    const lines = outputLines();
    assert.ok(lines.some((line) => line.startsWith('Verify Team Log: Verify team')), 'the report header is in the channel');
    assert.ok(lines.includes('Events: 2 (2 accepted, 0 rejected)'));
    assert.ok(lines.some((line) => line.includes('Lead Owner, owner')));
    assert.ok(messages().some((message) => message.startsWith('The team record passed its check: 2 events, 1 member, 0 rejected')));
    assert.ok(stub.outputChannels.every((channel) => channel.name === 'NEAR AI Team'));
  });
});

test('the Verify Team Log command works from the palette once a team exists', async () => {
  await withProject(async (p) => {
    await p.enable(['Palette team', 'Lead Owner']);
    stub.notifications.length = 0;
    await p.verify();
    assert.ok(outputLines().some((line) => line.startsWith('Verify Team Log: Palette team')));
    assert.ok(messages().some((message) => message.startsWith('The team record passed its check')));
  });
});

test('cancelling any input box returns quietly: no team.json, no message, no key, no storage, nothing on the remote', async () => {
  for (const answers of [[undefined], ['Cancel team', undefined]] as Array<Array<string | undefined>>) {
    await withProject(async (p) => {
      const before = [...p.secrets.values.keys()].sort();
      await p.enable(answers);
      assert.equal(await teamJsonExists(p.root), false, `no team.json after ${answers.length} answer(s)`);
      assert.deepEqual(stub.notifications, [], 'no message at all');
      assert.deepEqual([...p.secrets.values.keys()].sort(), before, 'no key was stored');
      assert.equal(remoteHasCoordination(p.fixture), false);
      assert.equal(existsSync(path.join(p.storage, 'team')), false, 'no team storage was created');
    assert.equal(existsSync(path.join(p.storage, 'identity')), false, 'no identity folder was created');
      assert.equal(stub.statusBarItems.length, 0);
      assert.equal(p.handle.session(), undefined);
    });
  }
});

test('running Enable again names the existing team and asks nothing', async () => {
  await withProject(async (p) => {
    await p.enable(['Existing team', 'Lead Owner']);
    const asked = stub.inputRequests.length;
    stub.notifications.length = 0;
    const commitsBefore = gitIn(p.root, ['rev-list', '--count', 'HEAD']);
    await p.enable([]);
    assert.equal(stub.inputRequests.length, asked, 'no question was asked');
    assert.equal(stub.notifications.length, 1);
    assert.equal(stub.notifications[0]?.level, 'info');
    assert.ok(stub.notifications[0]?.message.startsWith('This project already has a team: Existing team.'));
    assert.equal(gitIn(p.root, ['rev-list', '--count', 'HEAD']), commitsBefore, 'no second team and no new commit');
  });
});

test('Enable refuses with the preview off: it asks nothing and creates no team.json, no device key and no storage', async () => {
  await withProject(async (p) => {
    const commitsBefore = gitIn(p.root, ['rev-list', '--count', 'HEAD']);
    await p.enable([]);
    assert.deepEqual(messages(), [PREVIEW_OFF_TEXT]);
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(await teamJsonExists(p.root), false);
    assert.equal(p.secrets.values.has(DEVICE_KEY_SECRET), false, 'no device key was created');
    assert.equal(existsSync(path.join(p.storage, 'team')), false, 'no team storage was created');
    assert.equal(gitIn(p.root, ['rev-list', '--count', 'HEAD']), commitsBefore);
    assert.equal(remoteHasCoordination(p.fixture), false);
    assert.equal(PREVIEW_OFF_TEXT.includes(EM_DASH), false);
  }, { preview: false });
});

test('a folder that is not set up for NEAR AI gets an error that names SovAI: Set Up', async () => {
  await withProject(async (p) => {
    await p.enable([]);
    assert.equal(stub.notifications.length, 1);
    assert.equal(stub.notifications[0]?.level, 'error');
    assert.ok(stub.notifications[0]?.message.includes('SovAI: Set Up'));
    assert.ok(outputLines().includes(stub.notifications[0]?.message as string));
    assert.equal(stub.inputRequests.length, 0);
  }, { initialised: false });
});

test('with no folder open Enable asks the user to open the project folder', async () => {
  await withProject(async (p) => {
    await p.enable([]);
    assert.deepEqual(stub.notifications.map((entry) => [entry.level, entry.message]), [['error', 'Open your project folder first, then run "SovAI: Enable Team Mode" again.']]);
    assert.equal(stub.inputRequests.length, 0);
  }, { folderOpen: false });
});

test('a failing commit-msg hook shows a warning with the plain message and the same text in the channel', async () => {
  await withProject(async (p) => {
    writeFileSync(path.join(p.root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    await p.enable(['Hook team', 'Lead Owner']);
    const warning = stub.notifications.find((entry) => entry.level === 'warn');
    assert.ok(warning !== undefined, 'a warning is shown');
    assert.ok(warning.message.includes('hook rejected this commit message'));
    assert.ok(warning.message.includes(`git add -f ${TEAM_FILE_REL}`), 'the exact command to finish is given');
    assert.ok(outputLines().includes(warning.message), 'the channel has the same text');
    assert.equal(stub.notifications.some((entry) => entry.message.startsWith('Team Mode is on for')), false, 'no success message');
    assert.equal(p.handle.session()?.teamFile.name, 'Hook team', 'the team exists, so its session still runs');
  });
});

test('an unreachable remote shows an error, writes it to the channel and creates nothing', async () => {
  await withProject(async (p) => {
    gitIn(p.root, ['remote', 'set-url', 'origin', path.join(p.fixture.root, 'no-such-remote.git')]);
    const before = [...p.secrets.values.keys()].sort();
    await p.enable(['Unreachable team', 'Lead Owner']);
    const error = stub.notifications.find((entry) => entry.level === 'error');
    assert.ok(error !== undefined);
    assert.ok(error.message.includes('could not be reached'));
    assert.ok(outputLines().includes(error.message));
    assert.deepEqual([...p.secrets.values.keys()].sort(), before, 'no device key');
    assert.equal(await teamJsonExists(p.root), false);
  });
});

test('a secret typed as the team name is refused without repeating it anywhere', async () => {
  await withProject(async (p) => {
    await p.enable([p.canaries.apiKey, 'Lead Owner']);
    const error = stub.notifications.find((entry) => entry.level === 'error');
    assert.ok(error !== undefined, 'the refusal is shown');
    assert.equal(uiText().includes(p.canaries.apiKey), false, 'the value is not repeated in the UI or the channel');
    assert.equal(await teamJsonExists(p.root), false);
    assert.equal(remoteHasCoordination(p.fixture), false);
  });
});

test('SEC-01 canary: after Enable and Verify no secret or device key reaches the UI, settings, storage, team.json or any git object', async () => {
  await withProject(async (p) => {
    // A remote URL with a password; the insteadOf rule maps it back to the real bare remote so git still works.
    const url = `https://canaryuser:${p.canaries.urlPassword}@example.invalid/team.git`;
    gitIn(p.root, ['remote', 'set-url', 'origin', url]);
    gitIn(p.root, ['config', `url.${p.fixture.remote}.insteadOf`, url]);

    await p.enable(['Canary team', 'Lead Owner'], [VERIFY_ACTION]);
    await p.verify();
    const teamFile = await readTeamFile(p.root);
    assert.ok(teamFile !== undefined);
    const storageDir = teamStorageDir(p.storage, teamFile.teamId);
    const deviceKey = p.secrets.values.get(DEVICE_KEY_SECRET);
    assert.ok(deviceKey !== undefined, 'the device key is in secret storage');
    const needles: Needle[] = [
      ...p.canaries.labelled(),
      { label: 'remote user', value: 'canaryuser' },
      ...deviceKeyForms(deviceKey).map((value, index) => ({ label: `device key form ${index}`, value }))
    ];

    // Controls: the scanners do see a planted value, so the empty results below mean something.
    assert.ok(uiText().includes('Canary team'), 'the UI text under scan is not empty');
    assert.ok((await scanGitObjects(path.join(p.root, '.git'), needles)).includes('remote password'), 'the clone config holds the canary URL by construction');

    const ui = uiText();
    assert.deepEqual(needles.filter((needle) => ui.includes(needle.value)).map((needle) => needle.label), [], 'channel lines, notifications, status bar text and tooltips');
    assert.deepEqual(stub.configUpdates, [], 'settings were never written');
    assert.deepEqual(await scanFiles([path.join(p.root, TEAM_FILE_REL), p.storage], needles), [], 'team.json and all extension storage');
    assert.deepEqual(await scanGitObjects(path.join(storageDir, 'coordination.git'), needles), [], 'coordination mirror');
    // The address in git config is never asked for or copied: not into the UI, team.json, extension storage or the coordination log.
    const address = gitIn(p.root, ['config', 'user.email']);
    assert.match(address, /@/);
    const gitEmail: Needle[] = [{ label: 'git user.email', value: address }];
    assert.equal(uiText().includes(address), false, 'no UI text holds the git email');
    assert.deepEqual(await scanFiles([path.join(p.root, TEAM_FILE_REL), p.storage], gitEmail), [], 'team.json and extension storage hold no git email');
    assert.deepEqual(await scanGitObjects(path.join(storageDir, 'coordination.git'), gitEmail), [], 'the coordination log holds no git email');
    assert.deepEqual(await scanGitObjects(p.fixture.remote, needles), [], 'bare remote');
    assert.deepEqual(await scanGitObjects(path.join(p.root, '.git'), needles, { includeConfig: false }), [], 'project repository objects');
  });
});

test('no message, channel line, status text or tooltip contains an em-dash', async () => {
  await withProject(async (p) => {
    await p.enable(['Plain team', 'Lead Owner'], [VERIFY_ACTION]);
    await p.enable([]);
    await p.verify();
    assert.equal(uiText().includes(EM_DASH), false);
    assert.ok(stub.notifications.length >= 3, 'the check covered several messages');
  });
});

// ---- The e2e stand-in seam (D-30, D-31) ----

test('Verify Team Log resolves to the report it printed: one owner and no rejected events; in a solo project it resolves to nothing', async () => {
  await withProject(async (p) => {
    const solo = await (stub.commands.get(VERIFY_LOG_COMMAND) as () => Promise<unknown>)();
    assert.equal(solo, undefined, 'a solo project has no report');
    await p.enable(['Report team', 'Lead Owner']);
    const report = await (stub.commands.get(VERIFY_LOG_COMMAND) as () => Promise<import('../team/eventLog').VerifyReport | undefined>)();
    assert.ok(report !== undefined, 'the handler resolves to its report');
    assert.equal(report.members.length, 1);
    assert.equal(report.members[0]?.role, 'owner');
    assert.deepEqual(report.rejected, []);
    assert.equal(report.refused, undefined);
    assert.equal(report.unsupported, 0);
    assert.ok(report.events >= 1 && report.events === report.accepted);
  });
});

test('the extension builds the team test API only inside the NEAR_AI_E2E return, and registers Team Mode once', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
  const lines = source.split('\n');
  const builders = lines.filter((line) => line.includes('teamModeTestApi('));
  assert.equal(builders.length, 1);
  assert.match(builders[0] as string, /process\.env\.NEAR_AI_E2E === '1'/);
  assert.equal(source.split('registerTeamMode(context)').length - 1, 1);
  // The seam that would hand the private key to the test window must not exist (the name is split so this file does not hold it either).
  assert.equal(lines.some((line) => line.includes(`${'stored'}DeviceKey`)), false);
});

test('the test seam returns the fingerprint, the public key and digests only; its result holds no rendering of the private key', async () => {
  await withProject(async (p) => {
    const api = teamModeTestApi(p.context as never, p.handle);
    assert.equal(await api.deviceKeyEvidence(), undefined, 'no identity yet, so nothing to report');
    assert.equal(await api.ready, 'solo');
    await p.enable(['Seam team', 'Lead Owner']);
    const teamFile = await readTeamFile(p.root);
    assert.ok(teamFile !== undefined);
    const stored = p.secrets.values.get(DEVICE_KEY_SECRET) as string;
    const evidence = await api.deviceKeyEvidence();
    assert.ok(evidence !== undefined);
    assert.equal(evidence.fingerprint, teamFile.genesis.ownerDevice.fingerprint);
    const raw = Buffer.from(teamFile.genesis.ownerDevice.publicKey, 'base64url');
    assert.deepEqual(evidence.publicKey, { base64: raw.toString('base64'), base64url: raw.toString('base64url'), hex: raw.toString('hex') });
    assert.deepEqual(evidence.privateFormDigests, deviceKeyFormDigests(stored), 'the digests match the helper for the same stored secret');
    assert.equal(evidence.privateKeySha256, createHash('sha256').update(stored, 'utf8').digest('hex'));
    assert.deepEqual(Object.keys(evidence).sort(), ['fingerprint', 'privateFormDigests', 'privateKeySha256', 'publicKey']);
    const serialised = JSON.stringify(evidence);
    for (const form of deviceKeyForms(stored)) assert.equal(serialised.includes(form), false, 'no private rendering is in the result');
    assert.equal(api.session()?.teamFile.teamId, teamFile.teamId);
  });
});

test('the digest scanners find each private rendering inside surrounding text in a file and in a git object, and not the public key renderings', async () => {
  const secrets = new MemorySecrets();
  const { createDeviceIdentity } = await import('../team/identity');
  const identity = await createDeviceIdentity(secrets);
  const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
  const forms = deviceKeyForms(stored);
  const digests: LabelledDigest[] = deviceKeyFormDigests(stored).map((digest, index) => ({ ...digest, label: `private form ${index}` }));
  assert.equal(digests.length, forms.length);
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-digest-scan-'));
  try {
    const planted = path.join(dir, 'planted.txt');
    const publicOnly = path.join(dir, 'public.txt');
    const raw = Buffer.from(identity.publicKey, 'base64url');
    writeFileSync(publicOnly, `fingerprint ${identity.fingerprint}\n"key":"${raw.toString('base64')}" ${raw.toString('base64url')} ${raw.toString('hex')}\n`);
    assert.deepEqual(await scanFilesForDigests([publicOnly], digests), [], 'only public renderings');
    for (const [index, form] of forms.entries()) {
      const text = `before: "${form}", after\n${form}ZZ`;
      writeFileSync(planted, text);
      // A padded rendering contains its unpadded twin, so exactly the renderings this text contains are reported.
      const expected = forms.flatMap((other, otherIndex) => (text.includes(other) ? [`planted.txt/planted.txt: private form ${otherIndex}`] : []));
      assert.ok(expected.includes(`planted.txt/planted.txt: private form ${index}`));
      assert.deepEqual((await scanFilesForDigests([planted], digests)).sort(), expected.sort(), `form ${index} is found`);
    }
    writeFileSync(planted, forms.map((form) => `x ${form} y`).join('\n'));
    assert.equal((await scanFilesForDigests([planted], digests)).length, forms.length, 'all renderings in one file');

    // A git object: found through the uncompressed content, which hashing the raw loose object would never match.
    const repo = path.join(dir, 'repo.git');
    execFileSync('git', ['init', '--bare', '-q', repo]);
    assert.deepEqual(await scanGitObjectsForDigests(repo, digests), []);
    for (const [index, form] of forms.entries()) {
      execFileSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: `{"note":"${form}"}\n` });
      assert.ok((await scanGitObjectsForDigests(repo, digests)).includes(`private form ${index}`), `form ${index} is found in an object`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Trust pin per project (D-16) and the session disposer ----

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('stopping Team Mode disposes the running session: its status bar item goes and the handle forgets it', async () => {
  await withProject(async (p) => {
    await p.enable(['Dispose team', 'Lead Owner']);
    assert.ok(p.handle.session() !== undefined);
    // A second registration, as a new window on the same project would make; only its own disposables are released.
    const context = createFakeContext(p.storage, p.secrets);
    const itemsBefore = stub.statusBarItems.length;
    const handle = registerTeamMode(context as never);
    const own = context.subscriptions.length;
    assert.equal(await handle.ready, 'team');
    const item = stub.statusBarItems[itemsBefore] as { disposed?: boolean } | undefined;
    assert.ok(item !== undefined && item.disposed !== true, 'the new session shows its status bar item');
    for (const disposable of context.subscriptions.slice(0, own)) disposable.dispose();
    assert.equal(handle.session(), undefined, 'the handle no longer holds a session');
    assert.equal(item.disposed, true, 'the session was disposed, not only forgotten');
    for (const disposable of context.subscriptions.slice(own)) disposable.dispose();
  });
});

test('a team.json that swaps the team id is refused for this project, and only a confirmed "Trust this new team" starts a re-created team', async () => {
  await withProject(async (p) => {
    await p.enable(['First team', 'Lead Owner']);
    const first = await readTeamFile(p.root);
    assert.ok(first !== undefined);
    for (const disposable of p.context.subscriptions.splice(0)) disposable.dispose();

    // A swapped team id alone gets a fresh per-team folder, so a pin kept per team would trust it on first sight. The project pin refuses it.
    const swapped = { ...first, teamId: `team-${'f'.repeat(32)}` };
    writeFileSync(path.join(p.root, TEAM_FILE_REL), `${JSON.stringify(swapped)}\n`);
    stub.notifications.length = 0;
    stub.notificationActions.length = 0;
    stub.messageAnswers.length = 0;
    stub.messageAnswers.push(undefined);
    const refusedContext = createFakeContext(p.storage, p.secrets);
    const refused = registerTeamMode(refusedContext as never);
    assert.equal(await refused.ready, 'error');
    assert.equal(refused.session(), undefined);
    await until(() => stub.notifications.some((entry) => entry.level === 'warn' && /different team or owner key/.test(entry.message)), 'the refusal');
    const index = stub.notifications.findIndex((entry) => /different team or owner key/.test(entry.message));
    assert.deepEqual(stub.notificationActions[index], [TRUST_NEW_TEAM_ACTION]);
    assert.equal(JSON.parse(readFileSync(path.join(projectTrustDir(p.storage, p.root), 'trust.json'), 'utf8')).teamId, first.teamId, 'dismissing keeps the pin');
    for (const disposable of refusedContext.subscriptions.splice(0)) disposable.dispose();

    // The team is legitimately created again (for example by the owner on another computer): a new genesis on the remote and a new team.json.
    gitIn(p.fixture.remote, ['update-ref', '-d', COORDINATION_BRANCH]);
    execFileSync('git', ['rm', '-q', '-f', '--', TEAM_FILE_REL], { cwd: p.root });
    gitIn(p.root, ['commit', '-q', '-m', 'remove the old team']);
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'near-ai-other-computer-'));
    try {
      const recreated = await enableTeamMode({ projectRoot: p.root, globalStorageDir: elsewhere, secrets: new MemorySecrets(), teamName: 'Second team', ownerName: 'Lead Owner', previewEnabled: true });
      assert.equal(recreated.ok, true, recreated.ok ? '' : recreated.message);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
    const second = await readTeamFile(p.root);
    assert.ok(second !== undefined && second.teamId !== first.teamId);

    // Declining the modal changes nothing.
    stub.messageAnswers.length = 0;
    stub.messageAnswers.push(TRUST_NEW_TEAM_ACTION, undefined);
    const declinedContext = createFakeContext(p.storage, p.secrets);
    const declined = registerTeamMode(declinedContext as never);
    assert.equal(await declined.ready, 'error');
    await until(() => stub.messageAnswers.length === 0, 'both questions');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(declined.session(), undefined);
    assert.equal(JSON.parse(readFileSync(path.join(projectTrustDir(p.storage, p.root), 'trust.json'), 'utf8')).teamId, first.teamId);
    for (const disposable of declinedContext.subscriptions.splice(0)) disposable.dispose();

    // Choosing the action and confirming pins the new team for this project and starts it.
    stub.messageAnswers.push(TRUST_NEW_TEAM_ACTION, TRUST_CONFIRM_ACTION);
    const trustedContext = createFakeContext(p.storage, p.secrets);
    const trusted = registerTeamMode(trustedContext as never);
    assert.equal(await trusted.ready, 'error', 'the first start is refused');
    await until(() => trusted.session() !== undefined, 'the session after trusting');
    assert.equal(trusted.session()?.teamFile.teamId, second.teamId);
    const pin = JSON.parse(readFileSync(path.join(projectTrustDir(p.storage, p.root), 'trust.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(pin, { version: 1, teamId: second.teamId, genesisEventId: second.genesis.eventId, ownerFingerprint: second.genesis.ownerDevice.fingerprint });
    const confirm = stub.notificationActions.find((actions) => actions.includes(TRUST_CONFIRM_ACTION));
    assert.ok(confirm !== undefined && JSON.stringify(confirm).includes(second.genesis.ownerDevice.fingerprint), 'the modal names the new owner key');
    for (const disposable of trustedContext.subscriptions.splice(0)) disposable.dispose();
  });
});
