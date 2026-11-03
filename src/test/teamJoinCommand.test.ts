// The Join Team command over every answer of prepareJoin (Phase 61 plan 20, G-61-4), on real git through the vscode stub. Clone a is the owner's
// (Team Mode on, origin at a public-looking address), clone b is a teammate's copy made before Team Mode, pointing at the same address. Join
// brings a behind, clean copy up to date by itself and says so; a copy that could lose work or is on another version is left alone with a plain
// sentence and Get a fresh copy; a setup that is not online says to ask the inviter to share; offline offers Try again; only a different or
// missing project offers Get the project. The invite, its code and the project address never reach what the person reads, the channel, settings
// or storage.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { pushCodeBranch } from '../team/enable';
import { parseInviteBundle } from '../team/inviteBundle';
import { readTeamFile } from '../team/teamFile';
import { closeRig, codeOf, createRig, enable, invite, rootOf, teamIdOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { gitIn } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { FakeContext } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const memberModule = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
test.after(() => { uninstall(); });
const { registerTeamMode } = commandsModule;
const { JOIN_COMMAND, JOIN_TEXT } = memberModule;

const PUBLIC_URL = 'https://example.invalid/team.git';
const EM_DASH = '—';

function clearUi(): void {
  stub.outputChannels.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.configUpdates.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.clipboardWrites.length = 0;
  stub.externalCommands.length = 0;
  stub.progress.length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
}

interface Window { root: string | undefined; storage: string; context: FakeContext; handle: ReturnType<typeof registerTeamMode>; run(): Promise<void> }

// The owner turns Team Mode on in clone a, publishes main (unless told not to) and invites a developer. Clone b points at the same public address
// and is behind and clean.
async function withInvite(work: (rig: Rig, bundle: string) => Promise<void>, options: { publish?: boolean } = {}): Promise<void> {
  clearUi();
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    if (options.publish !== false) {
      const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
      assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
    }
    const b = rootOf(rig, 'b');
    gitIn(b, ['config', `url.${rig.fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(b, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    const { bundle } = await invite(rig, rig.dev);
    await work(rig, bundle);
  } finally {
    await closeRig(rig);
  }
}

// A teammate's VS Code window on a folder (or none), with Team Mode registered as the product does.
async function openWindow(rig: Rig, folder: string | undefined): Promise<Window> {
  clearUi();
  const storage = rig.fixture.storageDir('b');
  const context = createFakeContext(storage, rig.dev.secrets);
  stub.setWorkspaceFolders(folder === undefined ? [] : [folder]);
  const handle = registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
  await handle.ready;
  const own = new Map(stub.commands);
  return {
    root: folder, storage, context, handle,
    run: async (): Promise<void> => {
      const handler = own.get(JOIN_COMMAND);
      assert.ok(handler !== undefined, 'Join Team is registered');
      await handler();
    }
  };
}

async function closeWindow(window: Window): Promise<void> {
  await window.handle.session()?.sync();
  for (const subscription of window.context.subscriptions) subscription.dispose();
}

interface Snapshot { head: string; branches: string; staged: string; status: string }

function snapshot(dir: string): Snapshot {
  return {
    head: `${gitIn(dir, ['rev-parse', 'HEAD'])} ${gitIn(dir, ['rev-parse', '--symbolic-full-name', 'HEAD'])}`,
    branches: gitIn(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
    staged: gitIn(dir, ['diff', '--cached', '--binary']),
    status: gitIn(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])
  };
}

const remoteMain = (rig: Rig): string => gitIn(rig.fixture.remote, ['rev-parse', 'refs/heads/main']);
const outputLines = (): string[] => stub.outputChannels.flatMap((channel) => channel.lines);
const messages = (): string[] => stub.notifications.map((entry) => entry.message);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// The invite, its code and the project address are in nothing the person reads, the channel, settings or the extension storage.
function assertPrivate(window: Window, bundle: string): void {
  const code = codeOf(bundle);
  const read = JSON.stringify({
    notifications: stub.notifications, options: stub.notificationOptions, actions: stub.notificationActions, picks: stub.quickPickRequests,
    inputs: stub.inputRequests.map((request) => [request.title, request.prompt, request.value, request.placeHolder]), progress: stub.progress
  });
  for (const secret of [bundle, code]) {
    assert.equal(read.includes(secret), false, 'not in what the person reads');
    assert.equal(outputLines().join('\n').includes(secret), false, 'not in the channel');
    assert.equal(JSON.stringify(stub.configUpdates).includes(secret), false, 'not in settings');
    for (const file of filesUnder(window.storage)) {
      if (file.includes(`${path.sep}coordination.git${path.sep}`)) continue;
      assert.equal(readFileSync(file).toString('latin1').includes(secret), false, `not stored in ${path.basename(file)}`);
    }
  }
  assert.equal(read.includes(PUBLIC_URL), false, 'the address is not shown');
  assert.equal(outputLines().join('\n').includes(PUBLIC_URL), false, 'nor written to the channel');
  assert.equal(read.includes(EM_DASH), false);
}

// ---- brought up to date ---------------------------------------------------------------------------------------------------------------

test('a behind, clean copy of the same project is brought up to date by itself, says so, then asks the name and joins as an observer', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    assert.notEqual(gitIn(b, ['rev-parse', 'HEAD']), remoteMain(rig), 'clone b is behind');
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle, 'Dana D');
    let inputsWhenSaid = -1;
    stub.setMessageResponder((text) => {
      if (text === JOIN_TEXT.updated) inputsWhenSaid = stub.inputRequests.length;
      return undefined;
    });
    await w.run();

    assert.deepEqual(stub.progress.find((entry) => entry.title === JOIN_TEXT.title), { title: 'Joining', cancellable: false, messages: ['Getting the latest version of the project'] });
    assert.equal(JOIN_TEXT.updated, 'Your copy of the project was brought up to date.');
    assert.ok(messages().includes(JOIN_TEXT.updated), messages().join(' | '));
    assert.equal(inputsWhenSaid, 1, 'said after the paste and before the name question');
    assert.equal(stub.inputRequests[1]?.prompt, 'Your name as teammates will see it');
    assert.ok(messages().includes('You joined Flow team as an observer. Your lead confirms you and sends your team key.'), messages().join(' | '));
    assert.equal(gitIn(b, ['rev-parse', 'HEAD']), remoteMain(rig), 'the copy now has the online main');
    assert.equal((await readTeamFile(b))?.teamId, teamIdOf(rig));
    assert.equal(w.handle.session()?.memberId(), parseInviteBundle(bundle).member, 'joined with this computer\'s new key');
    assert.equal(stub.externalCommands.length, 0, 'no download was offered');
    assertPrivate(w, bundle);
    await closeWindow(w);
  });
});

// ---- left alone, with a plain way forward ----------------------------------------------------------------------------------------------

test('a copy with changes that are not online yet is left untouched; Get a fresh copy downloads the invite\'s project and nothing else runs', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    await fs.writeFile(path.join(b, 'README.md'), '# Team test project\nMy own edit\n', 'utf8');
    const before = snapshot(b);
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle);
    stub.setMessageResponder((_text, actions) => (actions.includes(JOIN_TEXT.freshCopy) ? JOIN_TEXT.freshCopy : undefined));
    await w.run();

    assert.deepEqual(messages(), [JOIN_TEXT.localChanges]);
    assert.match(JOIN_TEXT.localChanges, /changes that are not online yet/);
    assert.match(JOIN_TEXT.localChanges, /nothing in it was changed/);
    assert.match(JOIN_TEXT.localChanges, /fresh copy/);
    assert.deepEqual(stub.notificationActions[0], ['Get a fresh copy']);
    assert.deepEqual(stub.externalCommands, [{ command: 'git.clone', args: [PUBLIC_URL] }], 'only the download the person chose');
    assert.equal(stub.inputRequests.length, 1, 'no name question');
    assert.deepEqual(snapshot(b), before, 'the copy is unchanged');
    assert.equal(await fs.readFile(path.join(b, 'README.md'), 'utf8'), '# Team test project\nMy own edit\n');
    assert.equal(rig.dev.secrets.values.size, 0, 'nothing was stored');
    assertPrivate(w, bundle);
    await closeWindow(w);
  });
});

test('a copy with work that is not online is left untouched with the same sentence; closing it downloads nothing', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    await fs.writeFile(path.join(b, 'mine.txt'), 'local work\n', 'utf8');
    gitIn(b, ['add', 'mine.txt']);
    gitIn(b, ['commit', '-q', '-m', 'local work']);
    const before = snapshot(b);
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle);
    await w.run();
    assert.deepEqual(messages(), [JOIN_TEXT.localChanges]);
    assert.deepEqual(stub.notificationActions[0], ['Get a fresh copy']);
    assert.deepEqual(stub.externalCommands, [], 'nothing runs unless chosen');
    assert.deepEqual(snapshot(b), before);
    assert.equal(await readTeamFile(b), undefined);
    assertPrivate(w, bundle);
    await closeWindow(w);
  });
});

test('a copy set to another version says so plainly with Get a fresh copy, and is not changed', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    gitIn(b, ['switch', '-q', '-c', 'feature']);
    const before = snapshot(b);
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle);
    stub.setMessageResponder((_text, actions) => (actions.includes(JOIN_TEXT.freshCopy) ? JOIN_TEXT.freshCopy : undefined));
    await w.run();
    assert.deepEqual(messages(), [JOIN_TEXT.otherVersion]);
    assert.match(JOIN_TEXT.otherVersion, /different version than the one your team shares/);
    assert.deepEqual(stub.notificationActions[0], ['Get a fresh copy']);
    assert.deepEqual(stub.externalCommands, [{ command: 'git.clone', args: [PUBLIC_URL] }]);
    assert.deepEqual(snapshot(b), before);
    assertPrivate(w, bundle);
    await closeWindow(w);
  });
});

test('when the team setup is not online yet the person is told to ask the inviter to choose Share, with no button, and nothing changes', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    const before = snapshot(b);
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle);
    await w.run();
    assert.deepEqual(messages(), [JOIN_TEXT.notShared]);
    assert.match(JOIN_TEXT.notShared, /not online yet/);
    assert.match(JOIN_TEXT.notShared, /choose Share in the Team section of their NEAR AI sidebar/);
    assert.match(JOIN_TEXT.notShared, /paste the invite again/);
    assert.deepEqual(stub.notificationActions[0], [], 'no button');
    assert.deepEqual(stub.externalCommands, []);
    assert.deepEqual(snapshot(b), before);
    assertPrivate(w, bundle);
    await closeWindow(w);
  }, { publish: false });
});

test('an online home that cannot be reached offers Try again, which prepares again with the same paste and then joins', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    gitIn(b, ['config', '--remove-section', `url.${rig.fixture.remote}`]);
    gitIn(b, ['config', `url.${path.join(rig.fixture.root, 'missing.git')}.insteadOf`, PUBLIC_URL]);
    const before = snapshot(b);
    const w = await openWindow(rig, b);
    stub.inputAnswers.push(bundle, 'Dana D');
    let offline = 0;
    stub.setMessageResponder((text, actions) => {
      if (text !== JOIN_TEXT.offline) return undefined;
      offline += 1;
      assert.deepEqual(actions, ['Try again']);
      assert.deepEqual(snapshot(b), before, 'nothing changed before Try again');
      // The connection comes back before the person chooses Try again.
      gitIn(b, ['config', '--remove-section', `url.${path.join(rig.fixture.root, 'missing.git')}`]);
      gitIn(b, ['config', `url.${rig.fixture.remote}.insteadOf`, PUBLIC_URL]);
      return 'Try again';
    });
    await w.run();
    assert.equal(offline, 1);
    assert.match(JOIN_TEXT.offline, /could not be reached/);
    assert.equal(stub.inputRequests.filter((request) => request.password === true).length, 1, 'the invite was pasted once');
    assert.equal(stub.progress.filter((entry) => entry.title === JOIN_TEXT.title).length, 2, 'prepared twice');
    assert.ok(messages().includes(JOIN_TEXT.updated));
    assert.equal(gitIn(b, ['rev-parse', 'HEAD']), remoteMain(rig));
    assert.equal(w.handle.session()?.memberId(), parseInviteBundle(bundle).member);
    assert.ok(outputLines().some((line) => line.includes('(offline)')), 'the technical reason is in the channel');
    assertPrivate(w, bundle);
    await closeWindow(w);
  });
});

// ---- a different or missing project ----------------------------------------------------------------------------------------------------

test('a different project or no open folder offers Get the project, and the sentence says to open it and choose Join a team in the NEAR AI sidebar', async () => {
  await withInvite(async (rig, bundle) => {
    const none = await openWindow(rig, undefined);
    stub.inputAnswers.push(bundle);
    stub.setMessageResponder((_text, actions) => (actions.includes('Get the project') ? 'Get the project' : undefined));
    await none.run();
    assert.deepEqual(messages(), [JOIN_TEXT.cloneNeeded]);
    assert.match(JOIN_TEXT.cloneNeeded, /open it/);
    assert.match(JOIN_TEXT.cloneNeeded, /choose Join a team in the NEAR AI sidebar/);
    assert.deepEqual(stub.notificationActions[0], ['Get the project']);
    assert.deepEqual(stub.externalCommands, [{ command: 'git.clone', args: [PUBLIC_URL] }]);
    assertPrivate(none, bundle);
    await closeWindow(none);

    const c = rootOf(rig, 'c');
    gitIn(c, ['config', `url.${rig.fixture.remote}.insteadOf`, 'https://example.invalid/other.git']);
    gitIn(c, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git']);
    const before = snapshot(c);
    const other = await openWindow(rig, c);
    stub.inputAnswers.push(bundle);
    await other.run();
    assert.deepEqual(messages(), [JOIN_TEXT.cloneNeeded]);
    assert.deepEqual(stub.externalCommands, [], 'nothing runs unless chosen');
    assert.deepEqual(snapshot(c), before);
    assertPrivate(other, bundle);
    await closeWindow(other);
  });
});
