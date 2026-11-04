// Ask to join, the commands and the automatic steps (Phase 61 plan 29, G-61-9), driven through the vscode stub on real git with two or three
// windows: a person with a copy of the project asks and copies a request, the owner accepts it in Members, the person's computer joins by itself on
// its next sync, and the accepting computer confirms them by itself (sending the team key when it can). Each window keeps its own command
// handlers and is brought to the front (its folder and its handlers) before it acts, as a second VS Code window would. Code values are read back
// from the code under test, never written as literals. Emails use .invalid addresses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceKeySecretName, sealKeySecretName } from '../team/identity';
import { parseJoinRequest } from '../team/joinRequest';
import { planShare, shareTeamSetup } from '../team/projectHome';
import { readTeamFile } from '../team/teamFile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { FakeContext } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const memberModule = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, registerTeamMode } = commandsModule;
const { MANAGE_MEMBERS_COMMAND } = memberModule;
const ASK_TO_JOIN = 'nearAi.team.askToJoin';

const EM_DASH = '—';
const PUBLIC_URL = 'https://example.invalid/team.git';
const TEAM = 'Invite team';
const HOW_TO_SEND = 'Send it to the person who runs the team, in a chat or an email. They open Members in the Team section of their NEAR AI sidebar, choose Accept a request and paste it. They see the same check code, so tell it to them to show the request is yours. This computer joins the team by itself once they accept, the next time NEAR AI is open here.';

function resetStub(): void {
  stub.outputChannels.length = 0;
  stub.statusBarItems.length = 0;
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
  clearUi();
  // No background poll runs during a test: every sync below is asked for.
  stub.setConfig('nearAi.team.pollSeconds', 3600);
}

function clearUi(): void {
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
  stub.setProgressCancel(undefined);
  stub.setMessageResponder(undefined);
  stub.outputChannels.forEach((channel) => { channel.lines.length = 0; });
}

const shownMessages = (): string[] => stub.notifications.map((entry) => entry.message);
const outputLines = (): string[] => stub.outputChannels.flatMap((channel) => channel.lines);
const modalsShown = (): Array<{ message: string; detail: string | undefined; actions: string[] | undefined }> => stub.notifications.flatMap((entry, index) => (stub.notificationOptions[index]?.modal === true
  ? [{ message: entry.message, detail: stub.notificationOptions[index]?.detail, actions: stub.notificationActions[index] }] : []));
const everythingShown = (): string => JSON.stringify({
  lines: outputLines(), notifications: stub.notifications, notificationActions: stub.notificationActions, options: stub.notificationOptions, quickPicks: stub.quickPickRequests,
  inputs: stub.inputRequests.map((request) => [request.title, request.prompt, request.value, request.placeHolder])
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

interface Window {
  root: string;
  storage: string;
  secrets: MemorySecrets;
  context: FakeContext;
  handle: ReturnType<typeof registerTeamMode>;
  // Puts this window in front: its folder is the open one and its command handlers answer executeCommand, so its session's automatic steps
  // run this window's commands.
  front(): void;
  run(command: string, ...args: unknown[]): Promise<void>;
  sync(): Promise<boolean | undefined>;
}

interface World {
  fixture: TeamFixture;
  fake: FakeNear | undefined;
  owner: Window;
  clock: { offsetMs: number };
  signIns: { count: number; tokens: { accessToken: string; refreshToken: string } | undefined };
  windows: Window[];
  open(clone: string, options?: { pull?: boolean; secrets?: MemorySecrets }): Promise<Window>;
}

async function closeWindow(window: Window): Promise<void> {
  window.front();
  await window.handle.session()?.sync();
  for (const subscription of window.context.subscriptions) subscription.dispose();
}

async function removeFixture(fixture: TeamFixture): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fixture.cleanup();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// The owner's window on clone a turns the team on through the command and shares the team setup, so clones b and c can read team.json once they
// get the latest version. With `near` a fake NEAR has the owner's organization and workspace.
async function withWorld(work: (w: World) => Promise<void>, options: { near?: boolean; clones?: string[] } = {}): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: options.clones ?? ['a', 'b'], initialised: true });
  const fake = options.near === true ? await startFakeNear() : undefined;
  const signIns: World['signIns'] = { count: 0, tokens: undefined };
  if (fake !== undefined) {
    signIns.tokens = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
  }
  const clock = { offsetMs: 0 };
  const windows: Window[] = [];
  const open = async (clone: string, openOptions: { pull?: boolean; secrets?: MemorySecrets } = {}): Promise<Window> => {
    const root = fixture.clones[clone] as string;
    if (openOptions.pull !== false && clone !== 'a') gitIn(root, ['pull', '-q', '--ff-only']);
    const secrets = openOptions.secrets ?? new MemorySecrets();
    const storage = fixture.storageDir(clone);
    const context = createFakeContext(storage, secrets);
    stub.setWorkspaceFolders([root]);
    const handle = registerTeamMode(context as never, {
      now: () => Date.now() + clock.offsetMs,
      ...(fake === undefined ? {} : { nearBaseUrl: fake.baseUrl, signIn: async () => { signIns.count += 1; return signIns.tokens; } })
    } as never);
    await handle.ready;
    const own = new Map(stub.commands);
    const front = (): void => {
      stub.setWorkspaceFolders([root]);
      for (const [id, handler] of own) stub.commands.set(id, handler);
    };
    const window: Window = {
      root, storage, secrets, context, handle, front,
      run: async (command, ...args) => {
        front();
        const handler = own.get(command);
        assert.ok(handler !== undefined, `${command} is registered`);
        await handler(...args);
      },
      sync: async () => {
        front();
        return handle.session()?.sync();
      }
    };
    windows.push(window);
    return window;
  };
  try {
    const owner = await open('a');
    gitIn(owner.root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(owner.root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.inputAnswers.push(TEAM, 'Lead Owner', 'lead@example.invalid');
    await owner.run(ENABLE_COMMAND);
    assert.equal(owner.handle.session()?.teamFile.name, TEAM, 'Enable started the session');
    const teamFile = await readTeamFile(owner.root);
    assert.ok(teamFile !== undefined);
    const plan = await planShare({ projectRoot: owner.root, teamFile, branch: 'main' });
    const shared = await shareTeamSetup({ projectRoot: owner.root, teamFile, branch: 'main', plan });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    clearUi();
    await work({ fixture, fake, owner, clock, signIns, windows, open });
  } finally {
    for (const window of [...windows].reverse()) await closeWindow(window);
    await fake?.close();
    await removeFixture(fixture);
  }
}

const copyRequest = (_text: string, actions: string[]): string | undefined => (actions.includes('Copy request') ? 'Copy request' : undefined);

// The person on `window` asks to join and copies the request; returns the copied text.
async function askAndCopy(window: Window, person: { name: string; email: string }): Promise<string> {
  stub.inputAnswers.push(person.name, person.email);
  stub.setMessageResponder(copyRequest);
  const before = stub.clipboardWrites.length;
  await window.run(ASK_TO_JOIN);
  stub.setMessageResponder(undefined);
  assert.equal(stub.clipboardWrites.length, before + 1, `the request was copied (${shownMessages().join(' | ')})`);
  return stub.clipboardWrites[before] as string;
}

// The owner (or a lead) accepts a pasted request in Members: the request, then Continue on the check-code question, then the role, allowance and
// lifetime. `email` is typed only when the request has none.
async function acceptInMembers(window: Window, requestText: string, choices: { role?: string; amount?: string; email?: string } = {}): Promise<void> {
  stub.quickPickAnswers.push('Accept a request', choices.role ?? 'Developer', '7 days');
  stub.inputAnswers.push(requestText, ...(choices.email === undefined ? [] : [choices.email]), choices.amount ?? '5');
  stub.setMessageResponder((_text, actions) => (actions.includes('Continue') ? 'Continue' : undefined));
  await window.run(MANAGE_MEMBERS_COMMAND);
  stub.setMessageResponder(undefined);
  // The command nudged a sync; it is let finish here so it cannot run later with another window in front.
  await window.sync();
}

// ---- Task 1: the tracer ------------------------------------------------------------------------------------------------------------------

test('tracer: a person asks in one window, the owner accepts in Members, and the first window joins by itself on its next sync', async () => {
  await withWorld(async (w) => {
    const dana = await w.open('b');
    assert.equal(dana.handle.session()?.memberId(), undefined, 'clone b is not on the team');
    clearUi();

    // Window B asks: the name is filled in from the computer's settings, the email is optional, and the request is shown once in a modal.
    const requestText = await askAndCopy(dana, { name: 'Dana D', email: 'dana@example.invalid' });
    assert.deepEqual(stub.inputRequests.map((request) => request.title), ['Ask to Join a Team', 'Ask to Join a Team']);
    assert.equal(stub.inputRequests[0]?.value, 'Team Test', 'the name is filled in from git user.name');
    assert.equal(stub.inputRequests[1]?.validateInput?.(''), undefined, 'the email may be left empty');
    assert.ok(requestText.startsWith('near-ai-join-request-v1.'), 'the copied text is the request');
    const request = parseJoinRequest(requestText);
    assert.equal(request.name, 'Dana D');
    assert.equal(request.email, 'dana@example.invalid');
    const modals = modalsShown();
    assert.equal(modals.length, 1, 'one modal');
    assert.equal(modals[0]?.message, `Your request to join ${TEAM}`);
    assert.deepEqual(modals[0]?.actions, ['Copy request']);
    const checkCode = /Check code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(modals[0]?.detail ?? '')?.[1];
    assert.ok(checkCode !== undefined, `the check code is shown (${modals[0]?.detail ?? ''})`);
    assert.equal(modals[0]?.detail, `${requestText}\n\nCheck code: ${checkCode}\n\n${HOW_TO_SEND}`);
    assert.ok(shownMessages().includes('Request copied. Send it to the person who runs the team.'), shownMessages().join(' | '));
    assert.equal(dana.secrets.values.has(`nearAi.team.joinRequest.${request.team}`), true, 'the request is kept on this computer');

    // Window A, the owner: Members offers Accept a request right after Invite someone, shows the check code, then asks role, allowance and lifetime.
    clearUi();
    await acceptInMembers(w.owner, requestText);
    const rows = stub.quickPickRequests[0]?.labels ?? [];
    assert.deepEqual(rows.slice(0, 2), ['Invite someone', 'Accept a request'], rows.join(' | '));
    const question = modalsShown()[0];
    assert.equal(question?.message, `Accept Dana D's request to join ${TEAM}?`);
    assert.equal(question?.detail, `Email: dana@example.invalid\nCheck code: ${checkCode}\n\nCheck the code with Dana D, for example in a call or a chat you trust, before you go on. Accept only a request you know came from them.`);
    assert.deepEqual(question?.actions, ['Continue']);
    assert.deepEqual(stub.inputRequests.map((entry) => entry.title), ['Accept a request', 'Accept a request'], 'the request and the allowance; the email came with the request');
    assert.deepEqual(stub.quickPickRequests.slice(1).map((entry) => entry.title), ['Accept a request', 'Accept a request'], 'the role and the lifetime');
    const invited = w.owner.handle.session()?.state().members.get(request.member);
    assert.equal(invited?.status, 'invited', 'member.invited for the request is in the log');
    assert.equal(invited?.invite?.publicKey, request.key);
    assert.equal(invited?.pendingRole, 'developer');
    assert.ok(shownMessages().includes(`Accepted Dana D's request. Their computer joins ${TEAM} by itself the next time NEAR AI is open there, and this computer confirms them as a developer when it sees them join.`), shownMessages().join(' | '));
    assert.equal(everythingShown().includes(EM_DASH), false);

    // Window B's next sync: it joins by itself, restarts as a member and says so.
    clearUi();
    await dana.sync();
    await until(() => shownMessages().some((message) => message.startsWith(`You are on ${TEAM} now.`)), 'the joined message');
    assert.ok(shownMessages().includes(`You are on ${TEAM} now. Your lead confirms you as a developer.`), shownMessages().join(' | '));
    assert.equal(dana.handle.session()?.memberId(), request.member, 'the restarted session signs as the new member');
    assert.equal(dana.secrets.values.has(`nearAi.team.joinRequest.${request.team}`), false, 'the stored request is forgotten');
    assert.ok(dana.secrets.values.has(deviceKeySecretName(request.team)) && dana.secrets.values.has(sealKeySecretName(request.team)));
    await w.owner.sync();
    assert.equal(w.owner.handle.session()?.state().members.get(request.member)?.joinedEvent !== undefined, true, 'member.joined is in the log');

    // Later syncs run no second completion.
    const joinedMessages = shownMessages().filter((message) => message.startsWith('You are on')).length;
    await dana.sync();
    await dana.sync();
    assert.equal(shownMessages().filter((message) => message.startsWith('You are on')).length, joinedMessages);
    assert.equal(everythingShown().includes(EM_DASH), false);
  });
});
