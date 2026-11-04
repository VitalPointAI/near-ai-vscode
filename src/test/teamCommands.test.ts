// The Enable Team Mode and Verify Team Log commands end to end through the vscode stub, on real git: the questions and their defaults,
// the team.json-only commit, Push only when clicked, quiet cancellation, the existing-team and failure messages, and a SEC-01 canary scan
// of every place the command layer can show or store text. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { API_KEY_SECRET, REFRESH_TOKEN_SECRET } from '../services/auth';
import { deviceKeySecretName } from '../team/identity';
import { cleanRepoUrl } from '../team/inviteBundle';
import { TEAM_FILE_REL, readTeamFile, teamStorageDir } from '../team/teamFile';
import { deviceKeyForms, makeCanaries, scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { FakeContext } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, PUSH_ACTION, SHARE_COMMAND, SHOW_DETAILS_ACTION, VERIFY_ACTION, VERIFY_LOG_COMMAND, createSessionSlot, registerTeamMode } = commandsModule;
const { CONNECT_NEAR_AI_ACTION, NOT_CONNECTED_TEXT, STILL_NOT_CONNECTED_TEXT } = commandsModule;
const { JUST_ME_KEY, LOCAL_ONLY_TEXT, NOT_NOW_ACTION, NOT_SHAREABLE_TEXT, SOLO_TEXT, TURN_ON_ANYWAY_ACTION } = commandsModule;

// VS Code's workspace state for one project, kept in memory: the only place Just me for now is stored.
class FakeMemento {
  readonly values = new Map<string, unknown>();
  readonly updates: Array<[string, unknown]> = [];
  keys(): readonly string[] { return [...this.values.keys()]; }
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.updates.push([key, value]); if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}
// The address teammates would use. An insteadOf rule maps it back to the fixture's bare remote, so git still works on this computer.
const PUBLIC_URL = 'https://example.invalid/team.git';

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
  // How many times Enable asked the extension to connect NEAR AI (the chat's Set up key flow).
  connects: number;
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
  stub.notificationOptions.length = 0;
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
}

// `connect` stands in for the extension's key setup (configureApiKey): it gets the project folder and may set NEAR AI up there.
async function withProject(
  run: (project: Project) => Promise<void>,
  options: { initialised?: boolean; folderOpen?: boolean; connect?: (root: string) => Promise<void>; home?: 'public' | 'local'; workspaceState?: FakeMemento } = {}
): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a'], initialised: options.initialised ?? true });
  const root = fixture.clones['a'] as string;
  const canaries = makeCanaries();
  const secrets = new MemorySecrets();
  secrets.values.set(API_KEY_SECRET, canaries.apiKey);
  secrets.values.set(REFRESH_TOKEN_SECRET, canaries.refreshToken);
  secrets.values.set(REPORTING_TOKEN_KEY, canaries.reportingToken);
  const storage = fixture.storageDir('a');
  const context: FakeContext & { workspaceState?: FakeMemento } = createFakeContext(storage, secrets);
  if (options.workspaceState !== undefined) context.workspaceState = options.workspaceState;
  // By default the project's online home is an address teammates can reach; `home: 'local'` keeps the fixture's folder path as origin.
  if (options.home !== 'local') {
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
  }
  try {
    if (options.folderOpen !== false) stub.setWorkspaceFolders([root]);
    const counter = { connects: 0 };
    const handle = registerTeamMode(context as never, {
      connectNearAi: async () => { counter.connects += 1; await options.connect?.(root); }
    });
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
      verify: () => run1(VERIFY_LOG_COMMAND),
      get connects() { return counter.connects; }
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

test('Enable asks for team name, owner name and email with defaults, creates team.json, starts the session and offers Share with my team and Check the team', async () => {
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
    assert.equal(stub.statusBarItems[0]?.text, '$(organization) Team: Command team');
    assert.equal(gitIn(p.root, ['log', '-1', '--format=%s']), 'chore(team): enable NEAR AI Team Mode');
    assert.equal(gitIn(p.root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);

    const doneIndex = stub.notifications.findIndex((entry) => entry.message.startsWith('Your team for Command team is ready'));
    const done = stub.notifications[doneIndex];
    assert.ok(done !== undefined, 'the confirmation is shown');
    assert.equal(done.level, 'info');
    assert.deepEqual([PUSH_ACTION, VERIFY_ACTION], ['Share with my team', 'Check the team']);
    assert.deepEqual(stub.notificationActions[doneIndex], [PUSH_ACTION, VERIFY_ACTION]);
    // J-10: plain words in the notification; the git detail is in the channel only.
    assert.equal(done.message, 'Your team for Command team is ready. Share it so teammates can see the team.');
    assert.ok(outputLines().includes('team.json is committed on main. Sharing puts only team.json on main at origin.'));
    assert.equal(remoteMain(p.fixture), mainBefore, 'the code branch was not pushed because Push was not clicked');
    assert.deepEqual(stub.configUpdates, [], 'settings were never written');
    assert.ok(remoteHasCoordination(p.fixture), 'the coordination branch exists on the remote');
    assert.equal(stub.notificationOptions.some((options) => options?.modal === true), false, 'an online home teammates can reach brings no warning');
  });
});

// G-61-3: Share with my team runs Share Team Setup, which shares exactly the team setup after one confirmation (the old push of the checked-out
// branch is gone).
test('choosing Share with my team runs Share Team Setup: one confirmation, then the online main holds this computer\'s team.json', async () => {
  const { SHARE_TEXT } = require('../services/team/shareFlow') as typeof import('../services/team/shareFlow');
  await withProject(async (p) => {
    const mainBefore = remoteMain(p.fixture);
    writeFileSync(path.join(p.root, 'notes.txt'), 'my own work in progress', 'utf8');
    gitIn(p.root, ['checkout', '-q', '-b', 'my-feature']);
    gitIn(p.root, ['checkout', '-q', 'main']);
    await p.enable(['Share team', 'Lead Owner', ''], [PUSH_ACTION, SHARE_TEXT.share]);
    assert.equal(SHARE_COMMAND, 'nearAi.team.share');
    assert.ok(stub.notifications.some((entry, index) => entry.message === SHARE_TEXT.question && stub.notificationOptions[index]?.modal === true), 'one plain confirmation');
    assert.deepEqual(gitIn(p.fixture.remote, ['diff', '--name-only', mainBefore, 'refs/heads/main']).split('\n'), [TEAM_FILE_REL], 'only the team setup reached the online main');
    assert.equal(gitIn(p.fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`]), gitIn(p.root, ['show', `HEAD:${TEAM_FILE_REL}`]));
    assert.equal(gitIn(p.fixture.remote, ['for-each-ref', 'refs/heads/my-feature']), '', 'no other branch was pushed');
    assert.ok(messages().includes(SHARE_TEXT.shared));
    assert.equal(messages().some((message) => /push|branch|origin/i.test(message)), false, 'no git words in what is shown');
  });
});

test('Share with my team after a teammate moved the online main puts only the team setup on top of their work and never moves this computer', async () => {
  const { SHARE_TEXT } = require('../services/team/shareFlow') as typeof import('../services/team/shareFlow');
  await withProject(async (p) => {
    const other = path.join(p.fixture.root, 'other');
    gitIn(p.fixture.root, ['clone', '-q', p.fixture.remote, other]);
    gitIn(other, ['config', 'user.name', 'Other']);
    gitIn(other, ['config', 'user.email', 'other@example.invalid']);
    writeFileSync(path.join(other, 'other.txt'), 'x', 'utf8');
    gitIn(other, ['add', 'other.txt']);
    gitIn(other, ['commit', '-q', '-m', 'other work']);
    gitIn(other, ['push', '-q', 'origin', 'main']);
    const theirs = remoteMain(p.fixture);
    await p.enable(['Diverged team', 'Lead Owner', ''], [PUSH_ACTION, SHARE_TEXT.share]);
    const head = gitIn(p.root, ['rev-parse', 'HEAD']);
    assert.equal(gitIn(p.fixture.remote, ['rev-parse', 'refs/heads/main^']), theirs, 'the share sits on the teammate\'s work');
    assert.deepEqual(gitIn(p.fixture.remote, ['diff', '--name-only', theirs, 'refs/heads/main']).split('\n'), [TEAM_FILE_REL]);
    assert.equal(gitIn(p.root, ['rev-parse', 'HEAD']), head, 'this computer did not move');
    assert.ok(messages().includes(SHARE_TEXT.shared));
  });
});

test('a share the online home refuses shows plain words with Show details and keeps the redacted reason in the channel', async () => {
  const { SHARE_TEXT } = require('../services/team/shareFlow') as typeof import('../services/team/shareFlow');
  await withProject(async (p) => {
    await p.enable(['Refused team', 'Lead Owner', '']);
    const hook = path.join(p.fixture.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "main only takes reviewed changes" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    stub.notifications.length = 0;
    stub.notificationActions.length = 0;
    stub.notificationOptions.length = 0;
    stub.messageAnswers.push(SHARE_TEXT.share, undefined);
    await stub.commands.get(SHARE_COMMAND)?.();
    const index = stub.notifications.findIndex((entry) => entry.message === SHARE_TEXT.rejected);
    assert.ok(index >= 0, messages().join(' | '));
    assert.deepEqual(stub.notificationActions[index], [SHOW_DETAILS_ACTION]);
    assert.ok(outputLines().some((line) => line.includes('main only takes reviewed changes')), 'the reason is in the channel');
  });
});

test('Share Team Setup from the palette in a project without a team only explains how to turn Team Mode on', async () => {
  await withProject(async () => {
    await stub.commands.get(SHARE_COMMAND)?.();
    assert.deepEqual(messages(), [SOLO_TEXT]);
    assert.equal(stub.inputRequests.length, 0);
  });
});

test('choosing Check the team writes the report to the NEAR AI Team channel', async () => {
  await withProject(async (p) => {
    await p.enable(['Verify team', 'Lead Owner', ''], [VERIFY_ACTION]);
    const lines = outputLines();
    assert.ok(lines.some((line) => line.startsWith('Check Team Record: Verify team')), 'the report header is in the channel');
    assert.ok(lines.includes('Events: 2 (2 accepted, 0 rejected)'));
    assert.ok(lines.some((line) => line.includes('Lead Owner, owner')));
    assert.ok(messages().some((message) => message.startsWith('The team record passed its check: 2 events, 1 member, 0 rejected')));
    assert.ok(stub.outputChannels.every((channel) => channel.name === 'NEAR AI Team'));
  });
});

test('the Check Team Record command works from the palette once a team exists', async () => {
  await withProject(async (p) => {
    await p.enable(['Palette team', 'Lead Owner', '']);
    stub.notifications.length = 0;
    await p.verify();
    assert.ok(outputLines().some((line) => line.startsWith('Check Team Record: Palette team')));
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
      assert.equal(stub.statusBarItems.length, 0);
      assert.equal(p.handle.session(), undefined);
    });
  }
});

test('running Enable again names the existing team, asks no question, and offers Join Team instead of promising invitations later', async () => {
  await withProject(async (p) => {
    await p.enable(['Existing team', 'Lead Owner', '']);
    const asked = stub.inputRequests.length;
    stub.notifications.length = 0;
    stub.notificationActions.length = 0;
    const commitsBefore = gitIn(p.root, ['rev-list', '--count', 'HEAD']);
    await p.enable([]);
    assert.equal(stub.inputRequests.length, asked, 'no question was asked');
    assert.equal(stub.notifications.length, 1);
    assert.equal(stub.notifications[0]?.level, 'info');
    assert.ok(stub.notifications[0]?.message.startsWith('This project already has a team: Existing team.'));
    assert.equal(stub.notifications[0]?.message.includes('arrives with team invitations'), false, 'the old promise of a later version is gone');
    assert.deepEqual(stub.notificationActions[0], ['Join Team']);
    assert.equal(gitIn(p.root, ['rev-list', '--count', 'HEAD']), commitsBefore, 'no second team and no new commit');

    // Choosing Join Team runs the Join command, which asks for the invite in a masked box.
    stub.notifications.length = 0;
    stub.messageAnswers.push('Join Team');
    await p.enable([]);
    const joinPrompt = stub.inputRequests[asked];
    assert.equal(joinPrompt?.password, true, 'the Join command ran and asked for the pasted invite');
  });
});

// G-61-1: a project where NEAR AI is not connected yet is connected from the Enable flow itself, which then carries on with its questions.
const setUpNearAi = async (root: string): Promise<void> => { mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true }); };

test('Enable where NEAR AI is not connected offers Connect NEAR AI in one modal; once connected the questions follow and Team Mode turns on', async () => {
  await withProject(async (p) => {
    await p.enable(['Connected team', 'Lead Owner', ''], [CONNECT_NEAR_AI_ACTION]);
    assert.equal(CONNECT_NEAR_AI_ACTION, 'Connect NEAR AI');
    assert.equal(stub.notifications[0]?.message, NOT_CONNECTED_TEXT);
    assert.ok(NOT_CONNECTED_TEXT.startsWith('NEAR AI is not connected in this project yet.'));
    assert.equal(stub.notificationOptions[0]?.modal, true, 'the question is a modal');
    assert.deepEqual(stub.notificationActions[0], [CONNECT_NEAR_AI_ACTION]);
    assert.equal(p.connects, 1, 'the key setup ran once');
    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]).slice(0, 2), ['Team name', 'Your name as teammates will see it'], 'the Enable questions followed');
    assert.equal((await readTeamFile(p.root))?.name, 'Connected team', 'team.json was written');
    assert.equal(p.handle.session()?.teamFile.name, 'Connected team', 'the session is running');
    assert.equal(uiText().includes('NEAR AI: Set Up'), false, 'nobody is sent to another command');
  }, { initialised: false, connect: setUpNearAi });
});

test('Enable where NEAR AI is still not connected after the key setup says so plainly, asks nothing and changes nothing', async () => {
  await withProject(async (p) => {
    const before = [...p.secrets.values.keys()].sort();
    await p.enable(['Never asked', 'Lead Owner', ''], [CONNECT_NEAR_AI_ACTION]);
    assert.equal(p.connects, 1);
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(STILL_NOT_CONNECTED_TEXT, 'NEAR AI was not connected, so your team was not set up and nothing was changed.');
    assert.deepEqual(messages(), [NOT_CONNECTED_TEXT, STILL_NOT_CONNECTED_TEXT]);
    assert.equal(await teamJsonExists(p.root), false);
    assert.deepEqual([...p.secrets.values.keys()].sort(), before, 'no key was stored');
    assert.equal(remoteHasCoordination(p.fixture), false);
    assert.equal(uiText().includes('NEAR AI: Set Up'), false);
  }, { initialised: false });
});

test('dismissing the Connect NEAR AI question changes nothing and asks no question', async () => {
  await withProject(async (p) => {
    await p.enable(['Never asked', 'Lead Owner', ''], [undefined]);
    assert.equal(p.connects, 0, 'the key setup did not run');
    assert.deepEqual(messages(), [NOT_CONNECTED_TEXT], 'only the question was shown');
    assert.equal(stub.inputRequests.length, 0);
    assert.equal(await teamJsonExists(p.root), false);
    assert.equal(remoteHasCoordination(p.fixture), false);
  }, { initialised: false });
});

// G-61-2: the online home is checked before any question. Teammates cannot reach a folder on this computer or an address with a password in it.
test('Enable with the project kept only on this computer warns first in a modal; Not now changes nothing and asks no question', async () => {
  await withProject(async (p) => {
    await p.enable(['Never asked', 'Lead Owner', ''], [NOT_NOW_ACTION]);
    assert.equal(stub.notifications[0]?.level, 'warn');
    assert.equal(stub.notifications[0]?.message, LOCAL_ONLY_TEXT);
    assert.equal(LOCAL_ONLY_TEXT, 'Teammates cannot reach this project yet, because it is kept only on this computer.');
    assert.equal(stub.notificationOptions[0]?.modal, true);
    assert.ok((stub.notificationOptions[0]?.detail ?? '').includes('for example on GitHub'), 'the detail says what to do');
    assert.deepEqual(stub.notificationActions[0], [TURN_ON_ANYWAY_ACTION, NOT_NOW_ACTION]);
    assert.deepEqual([TURN_ON_ANYWAY_ACTION, NOT_NOW_ACTION], ['Set up anyway', 'Not now']);
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(stub.notifications.length, 1, 'nothing else was shown');
    assert.equal(await teamJsonExists(p.root), false);
    assert.equal(remoteHasCoordination(p.fixture), false);
    assert.ok(outputLines().some((line) => line.includes('git remote set-url origin')), 'the technical steps are in the channel');
    assert.equal(uiText().includes(p.fixture.remote), false, 'the folder path is not shown or logged');
  }, { home: 'local' });
});

test('Set up anyway carries on; the final message says the team is for this person until the project is online, without a share button', async () => {
  await withProject(async (p) => {
    await p.enable(['Local team', 'Lead Owner', ''], [TURN_ON_ANYWAY_ACTION]);
    assert.equal(stub.inputRequests.length, 3, 'the questions followed');
    assert.equal(p.handle.session()?.teamFile.name, 'Local team', 'the team is set up');
    const done = stub.notifications.findIndex((entry) => entry.message.startsWith('Your team for Local team is ready'));
    assert.ok(done >= 0);
    assert.equal(stub.notifications[done]?.message, 'Your team for Local team is ready, for you only until the project is online where teammates can reach it.');
    assert.deepEqual(stub.notificationActions[done], [VERIFY_ACTION], 'no share button');
  }, { home: 'local' });
});

test('Enable with a password in the online home address warns with the not-shareable wording; the channel has the reason and never the address', async () => {
  await withProject(async (p) => {
    const url = 'https://user:x@example.invalid/team.git';
    gitIn(p.root, ['config', `url.${p.fixture.remote}.insteadOf`, url]);
    gitIn(p.root, ['remote', 'set-url', 'origin', url]);
    await p.enable(['Never asked', 'Lead Owner', ''], [NOT_NOW_ACTION]);
    assert.equal(stub.notifications[0]?.message, NOT_SHAREABLE_TEXT);
    assert.equal(NOT_SHAREABLE_TEXT, 'Teammates cannot reach this project yet, because the address it is kept at online cannot be given to them as it is.');
    assert.equal(stub.notificationOptions[0]?.modal, true);
    assert.deepEqual(stub.notificationActions[0], [TURN_ON_ANYWAY_ACTION, NOT_NOW_ACTION]);
    assert.equal(stub.inputRequests.length, 0);
    const refused = cleanRepoUrl('user:password@example.invalid:repo.git');
    assert.equal(refused.ok, false);
    assert.ok(outputLines().some((line) => !refused.ok && line.includes(refused.reason)), 'the cleanRepoUrl reason is in the channel');
    assert.equal(uiText().includes('example.invalid'), false, 'no address in the channel or on screen');
    assert.equal(uiText().includes('user:x'), false);
    assert.equal(await teamJsonExists(p.root), false);
  });
});

test('the handle tells listeners when Team Mode turns on, when a turn-on attempt ends, and when the window closes; a disposed listener is not called again', async () => {
  await withProject(async (p) => {
    const calls: Array<string | undefined> = [];
    let disposedCalls = 0;
    p.handle.onDidChange(() => { calls.push(p.handle.session()?.teamFile.name); });
    const gone = p.handle.onDidChange(() => { disposedCalls += 1; });
    gone.dispose();
    await p.enable([undefined]);
    assert.ok(calls.length >= 1, 'a declined turn-on attempt is reported');
    assert.deepEqual(calls.filter((name) => name !== undefined), [], 'no team was running');
    calls.length = 0;
    await p.enable(['Change team', 'Lead Owner', '']);
    assert.ok(calls.includes('Change team'), 'listeners hear once Team Mode is on');
    calls.length = 0;
    for (const subscription of p.context.subscriptions) subscription.dispose();
    p.context.subscriptions.length = 0;
    assert.ok(calls.length >= 1, 'closing the window is reported');
    assert.equal(disposedCalls, 0, 'a disposed listener is never called');
  });
});

test('SOLO_TEXT points at the Invite someone button in the NEAR AI sidebar, not a palette command, and does not name the old feature', () => {
  assert.equal(SOLO_TEXT, 'This project has no team yet. To work with other people, choose Invite someone in the NEAR AI sidebar.');
});

test('with no folder open Enable asks the user to open the project folder', async () => {
  await withProject(async (p) => {
    await p.enable([]);
    assert.deepEqual(stub.notifications.map((entry) => [entry.level, entry.message]), [['error', 'Open your project folder first, then choose Invite someone in the NEAR AI sidebar.']]);
    assert.equal(stub.inputRequests.length, 0);
  }, { folderOpen: false });
});

test('a failing commit-msg hook shows a plain warning with Show details and keeps the exact step in the channel', async () => {
  await withProject(async (p) => {
    writeFileSync(path.join(p.root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    await p.enable(['Hook team', 'Lead Owner', '']);
    const warning = stub.notifications.find((entry) => entry.level === 'warn');
    assert.ok(warning !== undefined, 'a warning is shown');
    assert.equal(warning.message, 'Your team is set up, but saving it in this project did not finish. Choose Show details for the one step that is left.');
    assert.deepEqual(stub.notificationActions[stub.notifications.indexOf(warning)], [SHOW_DETAILS_ACTION]);
    const detail = outputLines().find((line) => line.includes('hook rejected this commit message'));
    assert.ok(detail !== undefined, 'the channel has the git reason');
    assert.ok(detail.includes(`git add -f ${TEAM_FILE_REL}`), 'and the exact command to finish');
    assert.equal(stub.notifications.some((entry) => entry.message.startsWith('Your team for')), false, 'no success message');
    assert.equal(p.handle.session()?.teamFile.name, 'Hook team', 'the team exists, so its session still runs');
  });
});

test('an unreachable remote shows a plain error, writes the git reason to the channel and creates nothing', async () => {
  await withProject(async (p) => {
    const missing = 'https://example.invalid/missing.git';
    gitIn(p.root, ['config', `url.${path.join(p.fixture.root, 'no-such-remote.git')}.insteadOf`, missing]);
    gitIn(p.root, ['remote', 'set-url', 'origin', missing]);
    const before = [...p.secrets.values.keys()].sort();
    await p.enable(['Unreachable team', 'Lead Owner', '']);
    const error = stub.notifications.find((entry) => entry.level === 'error');
    assert.ok(error !== undefined);
    assert.equal(error.message, 'The place this project is hosted could not be reached, so nothing was changed. Check your internet connection and try again.');
    assert.ok(outputLines().some((line) => line.startsWith('The remote "origin" could not be reached, so nothing was changed:')), 'the channel keeps the git reason');
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

    // A password in the address means teammates cannot use it as it is: the person is told first and turns Team Mode on anyway.
    await p.enable(['Canary team', 'Lead Owner', 'canary.lead@example.invalid'], [TURN_ON_ANYWAY_ACTION, VERIFY_ACTION]);
    assert.equal(stub.notifications[0]?.message, NOT_SHAREABLE_TEXT);
    await p.verify();
    const teamFile = await readTeamFile(p.root);
    assert.ok(teamFile !== undefined);
    const storageDir = teamStorageDir(p.storage, teamFile.teamId);
    const deviceKey = p.secrets.values.get(deviceKeySecretName(teamFile.teamId));
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

// ---- Just me for now (61-26, G-61-8) ------------------------------------------------------------------------------------------------------

test('Just me for now is kept per project in VS Code workspace state under one key, tells the listeners, and writes nothing else', async () => {
  const memento = new FakeMemento();
  await withProject(async (p) => {
    assert.equal(JUST_ME_KEY, 'nearAi.team.justMe');
    assert.equal(p.handle.justMe(), false, 'not chosen yet');
    let heard = 0;
    p.handle.onDidChange(() => { heard += 1; });
    const headBefore = gitIn(p.root, ['rev-parse', 'HEAD']);
    await p.handle.setJustMe(true);
    assert.equal(p.handle.justMe(), true);
    assert.deepEqual(memento.updates, [[JUST_ME_KEY, true]], 'one workspace state write under the one key');
    assert.equal(heard, 1, 'the sidebar is told');
    assert.equal(gitIn(p.root, ['status', '--porcelain']), '', 'no file in the project changed');
    assert.equal(gitIn(p.root, ['rev-parse', 'HEAD']), headBefore, 'nothing was saved in the project history');
    assert.equal(existsSync(p.storage), false, 'no extension storage');
    assert.equal(await teamJsonExists(p.root), false, 'no team record');
    assert.equal(stub.outputChannels.length, 0, 'no channel');
    assert.deepEqual(stub.notifications, [], 'nothing shown');
    await p.handle.setJustMe(false);
    assert.equal(p.handle.justMe(), false);
    assert.equal(memento.values.has(JUST_ME_KEY), false, 'clearing removes the value');
  }, { workspaceState: memento });
});

test('without VS Code workspace state Just me for now reads as not chosen and choosing it fails nothing', async () => {
  await withProject(async (p) => {
    assert.equal(p.handle.justMe(), false);
    await p.handle.setJustMe(true);
    assert.equal(p.handle.justMe(), false, 'nowhere to keep it, so it reads as not chosen');
  });
});

test('a team starting for this project clears Just me for now', async () => {
  const memento = new FakeMemento();
  await withProject(async (p) => {
    await p.handle.setJustMe(true);
    await p.enable(['Started team', 'Lead Owner', '']);
    assert.equal(p.handle.session()?.teamFile.name, 'Started team');
    assert.equal(p.handle.justMe(), false, 'the project has a team now');
    assert.equal(memento.values.has(JUST_ME_KEY), false);
  }, { workspaceState: memento });
});

test('no sentence a person sees from these commands names the old feature', async () => {
  await withProject(async (p) => {
    await p.enable(['Words team', 'Lead Owner', '']);
    await p.verify();
    const shown = JSON.stringify({ notifications: stub.notifications, actions: stub.notificationActions, inputs: stub.inputRequests.map((request) => [request.title, request.prompt]), progress: stub.progress });
    assert.doesNotMatch(shown, /team\s+mode/i, shown);
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

// WR-06: a restart (after Join or a NEAR link) while the first session start is still syncing must end on a fresh session, not the old start.
test('WR-06: restarting while the first start is still running waits for it, disposes it and ends on a fresh session', async () => {
  interface Fake { id: number; disposed: boolean; dispose(): void }
  const made: Fake[] = [];
  const gates: Array<() => void> = [];
  const slot = createSessionSlot<Fake>(async () => {
    const fake: Fake = { id: made.length + 1, disposed: false, dispose(): void { this.disposed = true; } };
    made.push(fake);
    await new Promise<void>((release) => { gates.push(release); });
    return { session: fake, state: 'team' as const };
  });
  const first = slot.start();
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = slot.restart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(made.length, 1, 'the restart waits for the start in flight instead of joining it');
  gates.shift()?.();
  assert.equal(await first, 'team');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(made.length, 2, 'a fresh start began after the old one finished');
  assert.equal(made[0]?.disposed, true, 'the session from before the restart was disposed');
  gates.shift()?.();
  await restarted;
  assert.equal(slot.current()?.id, 2, 'the slot ends on the fresh session');
  assert.equal(made[1]?.disposed, false);

  // Two restarts at once run one after the other and end on the newest session.
  let settled = false;
  const both = Promise.all([slot.restart(), slot.restart()]).then(() => { settled = true; });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    gates.shift()?.();
  }
  await both;
  assert.equal(slot.current()?.id, made.length);
  assert.ok(made.slice(0, -1).every((fake) => fake.disposed), 'every older session was disposed');
});
