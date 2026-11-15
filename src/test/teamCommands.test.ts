// The Enable Team Mode and Verify Team Log commands end to end through the vscode stub, on real git: the questions and their defaults,
// the team.json-only commit, Push only when clicked, quiet cancellation, the existing-team and failure messages, and a SEC-01 canary scan
// of every place the command layer can show or store text. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { API_KEY_SECRET, REFRESH_TOKEN_SECRET } from '../services/auth';
import { DEVICE_KEY_SECRET } from '../team/identity';
import { TEAM_FILE_REL, readTeamFile, teamStorageDir } from '../team/teamFile';
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
const { ENABLE_COMMAND, PREVIEW_OFF_TEXT, PUSH_ACTION, VERIFY_ACTION, VERIFY_LOG_COMMAND, registerTeamMode, teamModeTestApi } = commandsModule;

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

test('Enable asks for team name, owner name and email with defaults, creates team.json, starts the session and offers Push and Verify Team Log', async () => {
  await withProject(async (p) => {
    const mainBefore = remoteMain(p.fixture);
    await p.enable(['Command team', 'Lead Owner', 'lead@example.invalid']);

    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]), ['Team name', 'Your name as teammates will see it', 'Your email is kept only as a scrambled code (a salted hash) in the team record, never as plain text']);
    assert.equal(stub.inputRequests[0]?.value, 'a', 'the team name defaults to the folder name');
    assert.equal(stub.inputRequests[1]?.value, 'Team Test', 'the owner name defaults to git user.name');
    assert.equal(stub.inputRequests[2]?.value, 'team-test@example.invalid', 'the email defaults to git user.email');
    assert.equal(stub.inputRequests[2]?.prompt, 'Your email is kept only as a scrambled code (a salted hash) in the team record, never as plain text.');

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
    await p.enable(['Push team', 'Lead Owner', ''], [PUSH_ACTION]);
    const head = gitIn(p.root, ['rev-parse', 'HEAD']);
    assert.notEqual(head, mainBefore);
    assert.equal(remoteMain(p.fixture), head, 'the remote main now equals the clone HEAD');
    assert.ok(messages().includes('Shared with your team.'));
    assert.equal(messages().some((message) => message.includes('Pushed main')), false, 'the notification has no git words');
    assert.ok(outputLines().includes('Pushed main to origin.'));
  });
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
    await p.enable(['Failing push', 'Lead Owner', ''], [PUSH_ACTION]);
    const failure = stub.notifications.find((entry) => entry.level === 'error');
    assert.ok(failure !== undefined, 'the failed push is shown as an error');
    assert.ok(failure.message.startsWith('Pushing main to origin failed'));
    assert.ok(outputLines().includes(failure.message), 'and kept in the channel');
  });
});

test('choosing Verify Team Log writes the report to the NEAR AI Team channel', async () => {
  await withProject(async (p) => {
    await p.enable(['Verify team', 'Lead Owner', ''], [VERIFY_ACTION]);
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
    await p.enable(['Palette team', 'Lead Owner', '']);
    stub.notifications.length = 0;
    await p.verify();
    assert.ok(outputLines().some((line) => line.startsWith('Verify Team Log: Palette team')));
    assert.ok(messages().some((message) => message.startsWith('The team record passed its check')));
  });
});

test('cancelling any input box returns quietly: no team.json, no message, no key, no storage, nothing on the remote', async () => {
  for (const answers of [[undefined], ['Cancel team', undefined], ['Cancel team', 'Lead Owner', undefined]] as Array<Array<string | undefined>>) {
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
    await p.enable(['Existing team', 'Lead Owner', '']);
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

test('a folder that is not set up for NEAR AI gets an error that names NEAR AI: Set Up', async () => {
  await withProject(async (p) => {
    await p.enable([]);
    assert.equal(stub.notifications.length, 1);
    assert.equal(stub.notifications[0]?.level, 'error');
    assert.ok(stub.notifications[0]?.message.includes('NEAR AI: Set Up'));
    assert.ok(outputLines().includes(stub.notifications[0]?.message as string));
    assert.equal(stub.inputRequests.length, 0);
  }, { initialised: false });
});

test('with no folder open Enable asks the user to open the project folder', async () => {
  await withProject(async (p) => {
    await p.enable([]);
    assert.deepEqual(stub.notifications.map((entry) => [entry.level, entry.message]), [['error', 'Open your project folder first, then run "NEAR AI: Enable Team Mode" again.']]);
    assert.equal(stub.inputRequests.length, 0);
  }, { folderOpen: false });
});

test('a failing commit-msg hook shows a warning with the plain message and the same text in the channel', async () => {
  await withProject(async (p) => {
    writeFileSync(path.join(p.root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    await p.enable(['Hook team', 'Lead Owner', '']);
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
    await p.enable(['Unreachable team', 'Lead Owner', '']);
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
    await p.enable([p.canaries.apiKey, 'Lead Owner', '']);
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

    await p.enable(['Canary team', 'Lead Owner', 'canary.lead@example.invalid'], [VERIFY_ACTION]);
    await p.verify();
    const teamFile = await readTeamFile(p.root);
    assert.ok(teamFile !== undefined);
    const storageDir = teamStorageDir(p.storage, teamFile.teamId);
    const deviceKey = p.secrets.values.get(DEVICE_KEY_SECRET);
    assert.ok(deviceKey !== undefined, 'the device key is in secret storage');
    const needles: Needle[] = [
      ...p.canaries.labelled(),
      { label: 'remote user', value: 'canaryuser' },
      { label: 'plain email', value: 'canary.lead@example.invalid' },
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
    assert.deepEqual(await scanGitObjects(p.fixture.remote, needles), [], 'bare remote');
    assert.deepEqual(await scanGitObjects(path.join(p.root, '.git'), needles, { includeConfig: false }), [], 'project repository objects');
  });
});

test('no message, channel line, status text or tooltip contains an em-dash', async () => {
  await withProject(async (p) => {
    await p.enable(['Plain team', 'Lead Owner', ''], [VERIFY_ACTION]);
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
    await p.enable(['Report team', 'Lead Owner', 'lead@example.invalid']);
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
    await p.enable(['Seam team', 'Lead Owner', 'lead@example.invalid']);
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
      writeFileSync(planted, `before: "${form}", after\n${form}ZZ`);
      assert.deepEqual(await scanFilesForDigests([planted], digests), [`planted.txt/planted.txt: private form ${index}`], `form ${index} is found`);
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
