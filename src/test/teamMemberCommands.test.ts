// The membership commands (Phase 61 plan 13) driven through the vscode stub on real git: Invite, Join, Manage Team Members, Link Your
// Organization and Sign Out of NEAR AI for This Team. The commands are thin adapters, so these tests check what the person sees and what lands in the
// log, the clipboard, SecretStorage and the output channel. Secret-shaped values (invite codes, API keys, refresh tokens) are built at run
// time or read back from the code under test, never written as literals. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { CleanupChecklist, repoAccessText } from '../team/cleanupChecklist';
import { createDeviceIdentity, deviceKeySecretName, newMemberId, sealKeySecretName } from '../team/identity';
import { parseInviteBundle } from '../team/inviteBundle';
import { INVITE_FILE } from '../team/invite';
import { NO_ORG_NOTICE } from '../team/join';
import { nearSessionSecretName } from '../team/nearSession';
import { LINK_COMMIT_MESSAGE } from '../team/nearLink';
import { planShare, shareTeamSetup } from '../team/projectHome';
import { TEAM_FILE_REL, readTeamFile, teamStorageDir } from '../team/teamFile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
import { makeCanaries } from './helpers/teamCanary';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { FakeContext } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const memberModule = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, SHARE_COMMAND, registerTeamMode } = commandsModule;
const {
  INVITE_COMMAND, JOIN_COMMAND, JOIN_TEXT, LINK_EXPLANATION, LINK_NEAR_COMMAND, LINK_NOW_CHOICE, MANAGE_MEMBERS_COMMAND, NOT_NOW_CHOICE, SIGN_OUT_NEAR_COMMAND, parseUsdToNanoUsd
} = memberModule;

const EM_DASH = '—';
const WITHOUT_NEAR = 'Invite without signing in';
const WITHOUT_KEY_NOW = 'Continue without signing in';
const PUBLIC_URL = 'https://example.invalid/team.git';

function resetStub(): void {
  stub.outputChannels.length = 0;
  stub.statusBarItems.length = 0;
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
  stub.openedExternal.length = 0;
  stub.progress.length = 0;
  stub.setProgressCancel(undefined);
  stub.setMessageResponder(undefined);
  stub.commands.clear();
  stub.setWorkspaceFolders([]);
}

// Clears what was shown so far, keeping the stub's registered commands.
function clearUi(): void {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.clipboardWrites.length = 0;
  stub.externalCommands.length = 0;
  stub.progress.length = 0;
  stub.outputChannels.forEach((channel) => { channel.lines.length = 0; });
}

const progressNamed = (title: string): { title?: string; cancellable: boolean; messages: string[] } | undefined => stub.progress.find((entry) => entry.title === title);

interface Team {
  fixture: TeamFixture;
  root: string;
  storage: string;
  secrets: MemorySecrets;
  context: FakeContext;
  handle: ReturnType<typeof registerTeamMode>;
  canaries: ReturnType<typeof makeCanaries>;
  fake: FakeNear | undefined;
  // How many times the lead's browser sign-in was asked for, and the tokens it hands back (the lead's by default).
  signIns: { count: number; tokens: { accessToken: string; refreshToken: string } | undefined };
  run(command: string, ...args: unknown[]): Promise<void>;
}

function leadLog(team: Team): NonNullable<ReturnType<Team['handle']['session']>> {
  const session = team.handle.session();
  assert.ok(session !== undefined, 'the lead window has a session');
  return session;
}

// Waits for a sync that a command nudged to finish, then stops the window, so the folders can be removed without a sync writing into them.
async function closeWindow(window: { context: FakeContext; handle: ReturnType<typeof registerTeamMode> | undefined }): Promise<void> {
  await window.handle?.session()?.sync();
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

// A lead's window: the project's origin is given a public-looking address, which the bundle must carry, then Enable Team Mode runs through the
// command (so the session, device key and team.json are the product's own). With `near` there is also a fake NEAR with one organization the lead
// owns (two workspaces), one the lead is only a member of, and a second person who can be invited as a lead.
async function withTeam(work: (team: Team) => Promise<void>, options: { near?: boolean } = {}): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a', 'b'], initialised: true });
  const root = fixture.clones['a'] as string;
  const secrets = new MemorySecrets();
  const canaries = makeCanaries();
  const storage = fixture.storageDir('a');
  const context = createFakeContext(storage, secrets);
  const fake = options.near === true ? await startFakeNear() : undefined;
  const signIns: Team['signIns'] = { count: 0, tokens: undefined };
  if (fake !== undefined) {
    signIns.tokens = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addOrganization({ id: 'org-2', name: 'Other Org', members: [{ userId: 'user-other', role: 'owner' }, { userId: 'user-lead', role: 'member' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    fake.addWorkspace({ id: 'ws-2', organizationId: 'org-1', name: 'Second workspace' });
    fake.addWorkspace({ id: 'ws-9', organizationId: 'org-2', name: 'Other workspace' });
  }
  let registeredHandle: ReturnType<typeof registerTeamMode> | undefined;
  try {
    stub.setWorkspaceFolders([root]);
    const handle = registerTeamMode(context as never, fake === undefined ? {} : {
      nearBaseUrl: fake.baseUrl,
      signIn: async () => { signIns.count += 1; return signIns.tokens; }
    });
    registeredHandle = handle;
    assert.equal(await handle.ready, 'solo');
    // This window's handlers, kept so a later window registering the same command ids does not take over this one's calls.
    const own = new Map(stub.commands);
    const run = async (command: string, ...args: unknown[]): Promise<void> => {
      const handler = own.get(command);
      assert.ok(handler !== undefined, `${command} is registered`);
      await handler(...args);
    };
    // The online home is given its public-looking address before Enable, so Enable sees a home teammates can reach and asks nothing extra.
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.inputAnswers.push('Invite team', 'Lead Owner', 'lead@example.invalid');
    await run(ENABLE_COMMAND);
    assert.equal(handle.session()?.teamFile.name, 'Invite team', 'Enable started the session');
    // The team setup is put online with the core share, so an invite finds it online and asks no share question (61-20). Inviting with the setup
    // not online is covered in teamInviteShare.test.ts.
    await shareSetup(root);
    clearUi();
    await work({ fixture, root, storage, secrets, context, handle, canaries, fake, signIns, run });
  } finally {
    await closeWindow({ context, handle: registeredHandle });
    await fake?.close();
    await removeFixture(fixture);
  }
}

// This computer's team.json put on main at origin by the core share, as Share Team Setup does after its confirmation.
async function shareSetup(root: string): Promise<void> {
  const teamFile = await readTeamFile(root);
  assert.ok(teamFile !== undefined, 'the team file exists');
  const plan = await planShare({ projectRoot: root, teamFile, branch: 'main' });
  const shared = await shareTeamSetup({ projectRoot: root, teamFile, branch: 'main', plan });
  assert.equal(shared.ok, true, JSON.stringify(shared));
}

// G-61-3 (owner, 2026-11-03): Link Your Organization shares the team setup it changed with one confirmation ('Share'), through the share flow.
const LINK_SHARE_QUESTION = 'Share your team setup so teammates see the organization link?';
const LINK_NOT_SHARED = 'The link is saved on this computer only. Teammates will not see it until you share your team setup. Choose Share in the Team section of your NEAR AI sidebar.';
const shareWhenAsked = (text: string, actions: string[]): string | undefined => (text === LINK_SHARE_QUESTION && actions.includes('Share') ? 'Share' : undefined);
const remoteTeamJson = (t: Team): string => gitIn(t.fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`]);

// The lead links the team to Team Org / Team workspace through the Link command and answers its one share confirmation, so a clone sees the
// linked team.json (was: the test pushed the code branch itself, because the command only offered a push).
async function linkAndPush(t: Team): Promise<void> {
  stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace');
  stub.setMessageResponder(shareWhenAsked);
  await t.run(LINK_NEAR_COMMAND);
  stub.setMessageResponder(undefined);
  assert.deepEqual(JSON.parse(remoteTeamJson(t)).near, { organizationId: 'org-1', workspaceId: 'ws-1' }, `the link was shared (${stub.notifications.map((entry) => entry.message).join(' | ')})`);
  clearUi();
}

interface Joiner { root: string; storage: string; secrets: MemorySecrets; context: FakeContext; handle: ReturnType<typeof registerTeamMode>; run(command: string, ...args: unknown[]): Promise<void> }

// A teammate's window on the second clone, after the lead pushed team.json. Opening it replaces the lead window's registered commands in the stub,
// as a second VS Code window would have its own. `folder: false` is a window with no project open.
async function openJoiner(t: Team, options: { folder?: boolean; pull?: boolean; secrets?: MemorySecrets } = {}): Promise<Joiner> {
  const root = t.fixture.clones['b'] as string;
  if (options.pull !== false) gitIn(root, ['pull', '-q', '--ff-only']);
  const secrets = options.secrets ?? new MemorySecrets();
  const storage = t.fixture.storageDir('b');
  const context = createFakeContext(storage, secrets);
  stub.setWorkspaceFolders(options.folder === false ? [] : [root]);
  const fake = t.fake;
  const handle = registerTeamMode(context as never, fake === undefined ? {} : {
    nearBaseUrl: fake.baseUrl,
    signIn: async () => { t.signIns.count += 1; return t.signIns.tokens; }
  });
  await handle.ready;
  clearUi();
  const own = new Map(stub.commands);
  const run = async (command: string, ...args: unknown[]): Promise<void> => {
    const handler = own.get(command);
    assert.ok(handler !== undefined, `${command} is registered`);
    await handler(...args);
  };
  return { root, storage, secrets, context, handle, run };
}

// The lead invites someone and the bundle comes back from the clipboard.
async function inviteBundle(t: Team, person: { name: string; email: string; role: string; amount?: string }): Promise<string> {
  stub.inputAnswers.push(person.name, person.email, person.amount ?? '5');
  // The organization choice comes first when the team is not linked (61-20).
  if (t.handle.session()?.teamFile.near === undefined) stub.quickPickAnswers.push(NOT_NOW_CHOICE);
  stub.quickPickAnswers.push(person.role, '7 days');
  stub.setMessageResponder(copyWhenOffered);
  const before = stub.clipboardWrites.length;
  await t.run(INVITE_COMMAND);
  stub.setMessageResponder(undefined);
  assert.equal(stub.clipboardWrites.length, before + 1, `the bundle was copied (${stub.notifications.map((entry) => entry.message).join(' | ')})`);
  return stub.clipboardWrites[before] as string;
}

const outputLines = (): string[] => stub.outputChannels.flatMap((channel) => channel.lines);
const everythingShown = (): string => JSON.stringify({
  lines: outputLines(), notifications: stub.notifications, notificationActions: stub.notificationActions, quickPicks: stub.quickPickRequests,
  inputs: stub.inputRequests.map((request) => [request.title, request.prompt, request.value, request.placeHolder]),
  bars: stub.statusBarItems.map((item) => [item.text, item.tooltip])
});
const copyWhenOffered = (_text: string, actions: string[]): string | undefined => (actions.includes('Copy invite') ? 'Copy invite' : undefined);
// G-61-5 (owner, 2026-11-03): the invite modal says how to hand the invite over and what the invitee does, and closing it asks once more.
const HOW_TO_SEND = 'Send it to them in a private message, such as a direct chat or an email. It works once. To join, they open the project in VS Code, open the NEAR AI sidebar, choose Join a team and paste the invite. If they do not have the project yet, Join a team offers to download it.';
const CLOSE_WITHOUT_COPYING = 'Close without copying? The invite is not shown again.';
const shownMessages = (): string[] => stub.notifications.map((entry) => entry.message);
const modalsShown = (): Array<{ message: string; detail: string | undefined; actions: string[] | undefined }> => stub.notifications.flatMap((entry, index) => (stub.notificationOptions[index]?.modal === true
  ? [{ message: entry.message, detail: stub.notificationOptions[index]?.detail, actions: stub.notificationActions[index] }] : []));

// Everything written under a folder, as one text, for the scans that the invite is stored nowhere (D-05, T-61-98).
async function filesUnder(dir: string): Promise<string> {
  if (!existsSync(dir)) return '';
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')));
  return texts.join('\n');
}

// ---- the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: Invite to Team asks its questions, writes member.invited, and shows the bundle once with Copy invite, how to send it, and nowhere else', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);

    // The bundle reached the clipboard exactly once, and it is the one the log knows.
    assert.equal(stub.clipboardWrites.length, 1);
    const bundleText = stub.clipboardWrites[0] as string;
    const bundle = parseInviteBundle(bundleText);
    const session = t.handle.session();
    assert.equal(bundle.team, session?.teamFile.teamId);
    const member = session?.state().members.get(bundle.member);
    assert.equal(member?.status, 'invited');
    assert.equal(member?.allocationNanoUsd, 5_000_000_000, 'five dollars as integer nano-USD');
    assert.equal(member?.invite?.ttlSeconds, 604_800, 'seven days');

    // One modal, with Copy invite, carrying the bundle and then how to send it in its detail, and nothing else carrying it (G-61-5).
    const modals = stub.notifications.flatMap((entry, index) => (stub.notificationOptions[index]?.modal === true ? [{ entry, index }] : []));
    assert.equal(modals.length, 1, 'exactly one modal');
    assert.equal(modals[0]?.entry.message, 'Invite ready for Ana');
    assert.equal(stub.notificationOptions[modals[0]?.index as number]?.detail, `${bundleText}\n\n${HOW_TO_SEND}`, 'the invite, a blank line, then how to send it');
    assert.deepEqual(stub.notificationActions[modals[0]?.index as number], ['Copy invite']);
    assert.equal(stub.notificationOptions.filter((options) => options?.detail?.includes(bundleText) === true).length, 1, 'the bundle is shown once');
    assert.ok(stub.notifications.some((entry, index) => stub.notificationOptions[index]?.modal !== true && entry.message === 'Invite for Ana copied. Send it to them in a private message.'), 'copying is announced');
    assert.equal(everythingShown().includes(bundleText), false, 'not in the channel, the other messages, the inputs or the status bar');
    assert.equal(everythingShown().includes(bundle.code), false, 'the code is nowhere either');
    // Nor in the settings, SecretStorage, the extension storage or the project's team folder.
    const stored = [JSON.stringify(stub.configUpdates), JSON.stringify([...t.secrets.values.values()]), await filesUnder(t.storage), await filesUnder(path.join(t.root, '.planning', '.near-ai'))].join('\n');
    assert.equal(stored.includes(bundleText), false, 'the invite is stored nowhere');
    assert.equal(stored.includes(bundle.code), false, 'nor is its code');

    // The skip path says plainly that there is no provider cap, once.
    assert.equal(stub.notifications.filter((entry) => entry.message === NO_ORG_NOTICE).length, 1);

    // UI review issue 1: the write runs in a progress notification that says what it is doing.
    assert.deepEqual(progressNamed('Inviting Ana'), { title: 'Inviting Ana', cancellable: false, messages: ['Saving the invitation to the team record'] });
  });
});

test('Invite offers the roles and the four lifetimes with seven days first, and explains linking with Link now or Not now when the team has no organization', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    await t.run(INVITE_COMMAND);
    // 61-20: the organization choice comes first, then the questions.
    assert.deepEqual(stub.quickPickRequests[0]?.labels, ['Link now', 'Not now, everyone uses their own key']);
    assert.equal(stub.quickPickRequests[0]?.placeHolder, 'Your organization is the account that pays for your team\'s AI, so each person can get a spending limit.');
    assert.equal(stub.quickPickRequests[0]?.placeHolder, LINK_EXPLANATION);
    assert.deepEqual(stub.quickPickRequests[1]?.labels, ['Developer', 'Reviewer', 'Observer', 'Lead']);
    assert.deepEqual([...(stub.quickPickRequests[2]?.labels ?? [])].sort(), ['14 days', '24 hours', '3 days', '7 days']);
    assert.equal(stub.quickPickRequests[2]?.labels[0], '7 days', 'the first item is the one Enter picks');
    assert.ok(stub.notifications.some((entry) => entry.message === NO_ORG_NOTICE), 'Not now continues the invite and says everyone uses their own key');
    assert.ok(stub.notifications.some((entry) => entry.message.startsWith('The invite for Ana')), 'the invite was still made');
    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]), ['Name of the person you are inviting', 'Their email address', 'Allocation in US dollars']);
  });
});

test('a lifetime of 24 hours is stored as 86400 seconds', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Bo', 'bo@example.invalid', '0.01');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Observer', '24 hours');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);
    const bundle = parseInviteBundle(stub.clipboardWrites[0] as string);
    const member = t.handle.session()?.state().members.get(bundle.member);
    assert.equal(member?.invite?.ttlSeconds, 86_400);
    assert.equal(member?.allocationNanoUsd, 10_000_000, 'one cent');
  });
});

test('closing the invite asks once more before it is lost; Close says it can be issued again from Members and never repeats the invite', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder((text, actions) => (text === CLOSE_WITHOUT_COPYING && actions.includes('Close') ? 'Close' : undefined));
    await t.run(INVITE_COMMAND);
    assert.equal(stub.clipboardWrites.length, 0);
    const modals = modalsShown();
    assert.deepEqual(modals.map((modal) => [modal.message, modal.actions]), [['Invite ready for Ana', ['Copy invite']], [CLOSE_WITHOUT_COPYING, ['Copy invite', 'Close']]]);
    const detail = modals[0]?.detail as string;
    assert.ok(detail.startsWith('near-ai-invite-v1.'));
    const bundleText = detail.split('\n')[0] as string;
    assert.equal(JSON.stringify(modals[1]).includes(bundleText), false, 'the second question does not show the invite again');
    const later = stub.notifications.filter((_entry, index) => stub.notificationOptions[index]?.modal !== true).map((entry) => entry.message);
    assert.deepEqual(later, [NO_ORG_NOTICE, 'The invite for Ana was not copied. You can issue it again from Members in the Team section of your NEAR AI sidebar.']);
    assert.equal(everythingShown().includes(bundleText), false);
    assert.equal(t.handle.session()?.state().members.size, 2, 'the invitation stays, so it can be issued again');
  });
});

test('dismissing both invite modals is the same as Close: nothing is copied and the person reads where to issue it again', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    await t.run(INVITE_COMMAND);
    assert.equal(stub.clipboardWrites.length, 0);
    assert.deepEqual(modalsShown().map((modal) => modal.message), ['Invite ready for Ana', CLOSE_WITHOUT_COPYING], 'asked once more, and only once');
    assert.ok(shownMessages().includes('The invite for Ana was not copied. You can issue it again from Members in the Team section of your NEAR AI sidebar.'), shownMessages().join(' | '));
  });
});

test('choosing Copy invite in the second question copies the invite once and announces it', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder((text, actions) => (text === CLOSE_WITHOUT_COPYING && actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    const modals = modalsShown();
    assert.deepEqual(modals.map((modal) => modal.message), ['Invite ready for Ana', CLOSE_WITHOUT_COPYING]);
    assert.equal(stub.clipboardWrites.length, 1, 'copied once');
    const bundleText = stub.clipboardWrites[0] as string;
    assert.equal(modals[0]?.detail, `${bundleText}\n\n${HOW_TO_SEND}`, 'the copied invite is the one shown');
    assert.equal(parseInviteBundle(bundleText).team, t.handle.session()?.teamFile.teamId);
    assert.ok(shownMessages().includes('Invite for Ana copied. Send it to them in a private message.'), shownMessages().join(' | '));
    assert.equal(shownMessages().some((message) => message.includes('not copied')), false);
    assert.equal(everythingShown().includes(bundleText), false, 'not in the channel or any other message');
  });
});

// ---- amounts ----------------------------------------------------------------------------------------------------------------------------

test('parseUsdToNanoUsd turns dollars into integer nano-USD with string arithmetic and refuses everything else', () => {
  assert.equal(parseUsdToNanoUsd('5'), 5_000_000_000);
  assert.equal(parseUsdToNanoUsd('5.5'), 5_500_000_000);
  assert.equal(parseUsdToNanoUsd('5.25'), 5_250_000_000);
  assert.equal(parseUsdToNanoUsd('0.01'), 10_000_000);
  assert.equal(parseUsdToNanoUsd(' 12 '), 12_000_000_000);
  assert.equal(parseUsdToNanoUsd('0'), 0);
  assert.equal(parseUsdToNanoUsd('5.255'), undefined, 'more than two decimals');
  assert.equal(parseUsdToNanoUsd('-1'), undefined);
  assert.equal(parseUsdToNanoUsd('1e3'), undefined);
  assert.equal(parseUsdToNanoUsd(''), undefined);
  assert.equal(parseUsdToNanoUsd('.5'), undefined);
  assert.equal(parseUsdToNanoUsd('5.'), undefined);
  assert.equal(parseUsdToNanoUsd('$5'), undefined);
  assert.equal(parseUsdToNanoUsd('9007199254.74'), undefined, 'too large to keep as an exact integer');
  // A decimal that floating point gets wrong stays exact.
  assert.equal(parseUsdToNanoUsd('0.07'), 70_000_000);
  assert.equal(parseUsdToNanoUsd('1.15'), 1_150_000_000);
});

test('the questions refuse an empty name, an address without @ and an amount that is not dollars and cents', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    await t.run(INVITE_COMMAND);
    const [name, email, amount] = stub.inputRequests;
    assert.equal(typeof name?.validateInput?.(''), 'string');
    assert.equal(name?.validateInput?.('Ana'), undefined);
    assert.equal(typeof email?.validateInput?.('not-an-address'), 'string');
    assert.equal(email?.validateInput?.('ana@example.invalid'), undefined);
    assert.equal(typeof amount?.validateInput?.('5.255'), 'string');
    assert.equal(typeof amount?.validateInput?.('-1'), 'string');
    assert.equal(amount?.validateInput?.('5.25'), undefined);
  });
});

// ---- cancelling -------------------------------------------------------------------------------------------------------------------------

test('cancelling at any question writes nothing to the log, the clipboard or the invitation list', async () => {
  // 61-20: the organization choice comes first, so every later stage answers it with Not now; the first stage stops at it.
  const stages: Array<{ inputs: string[]; picks: string[] }> = [
    { inputs: [], picks: [] },
    { inputs: [], picks: [NOT_NOW_CHOICE] },
    { inputs: ['Ana'], picks: [NOT_NOW_CHOICE] },
    { inputs: ['Ana', 'ana@example.invalid'], picks: [NOT_NOW_CHOICE] },
    { inputs: ['Ana', 'ana@example.invalid'], picks: [NOT_NOW_CHOICE, 'Developer'] },
    { inputs: ['Ana', 'ana@example.invalid', '5'], picks: [NOT_NOW_CHOICE, 'Developer'] }
  ];
  await withTeam(async (t) => {
    const session = t.handle.session();
    const before = session?.state().head.eventId;
    const accepted = session?.state().accepted;
    for (const stage of stages) {
      clearUi();
      stub.inputAnswers.push(...stage.inputs);
      stub.quickPickAnswers.push(...stage.picks);
      stub.setMessageResponder(copyWhenOffered);
      await t.run(INVITE_COMMAND);
      assert.equal(session?.state().head.eventId, before, `no event after stopping with ${stage.inputs.length} typed answers and ${stage.picks.length} picks`);
      assert.equal(session?.state().accepted, accepted);
      assert.equal(stub.clipboardWrites.length, 0);
    }
    const storageDir = teamStorageDir(t.storage, session?.teamFile.teamId as string);
    assert.equal(existsSync(path.join(storageDir, INVITE_FILE)), false, 'no invitation list was written');
  });
});

// ---- wording ----------------------------------------------------------------------------------------------------------------------------

test('nothing the Invite command shows contains an em-dash', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);
    assert.equal(everythingShown().includes(EM_DASH), false);
  });
});

// ---- Join Team --------------------------------------------------------------------------------------------------------------------------

test('Join with no project open offers Get the project, runs git.clone with the invite address, and writes nothing', async () => {
  await withTeam(async (t) => {
    const bundleText = await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t, { folder: false });
    stub.inputAnswers.push(bundleText);
    stub.setMessageResponder((_text, actions) => (actions.includes('Get the project') ? 'Get the project' : undefined));
    await j.run(JOIN_COMMAND);

    assert.equal(stub.inputRequests[0]?.password, true, 'the pasted invite is masked');
    // 61-20 (owner, 2026-11-03): the sentence points at the Join a team button in the sidebar instead of the palette command.
    assert.deepEqual(stub.notifications.map((entry) => entry.message), [
      'This invite is for a project that is not open here. Choose Get the project to download it, open it, then choose Join a team in the NEAR AI sidebar and paste the invite again.'
    ]);
    assert.deepEqual(stub.notificationActions[0], ['Get the project']);
    assert.deepEqual(stub.externalCommands, [{ command: 'git.clone', args: [PUBLIC_URL] }]);
    assert.equal(j.secrets.values.size, 0, 'nothing was stored in SecretStorage');
    assert.equal(existsSync(j.storage), false, 'nothing was written to the extension storage');
    assert.equal(everythingShown().includes(PUBLIC_URL), false, 'the repository address is not shown or logged');
    assert.equal(everythingShown().includes(bundleText), false);
    await closeWindow(j);
  });
});

test('Join inside the matching project joins as an observer, says what comes next, and restarts the session with the new device key', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const bundleText = await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t);
    assert.equal(j.handle.session()?.memberId(), undefined, 'before joining this computer is not on the team');
    const requestsBefore = (t.fake?.requests.length ?? 0);
    const signInsBefore = t.signIns.count;
    stub.inputAnswers.push(bundleText, 'Dana D');
    await j.run(JOIN_COMMAND);

    assert.equal(stub.inputRequests[0]?.password, true, 'the bundle is masked');
    assert.equal(stub.inputRequests[1]?.value, 'Team Test', 'the display name defaults to git user.name');
    assert.equal(t.signIns.count, signInsBefore, 'a developer never signs in to NEAR');
    assert.equal(t.fake?.requests.length, requestsBefore, 'and the join made no NEAR request');
    // 61-30: the lead-made team key becomes this project's profile by itself once a lead confirms the person.
    assert.ok(stub.notifications.some((entry) => entry.message === 'You joined Invite team as an observer. Once a lead confirms you, your team key becomes this project\'s profile.'), stub.notifications.map((entry) => entry.message).join(' | '));
    const memberId = parseInviteBundle(bundleText).member;
    assert.equal(j.handle.session()?.memberId(), memberId, 'the restarted session signs with the new device key');
    // UI review issue 1: Join says each step.
    assert.deepEqual(progressNamed('Joining Invite team')?.messages, ['Reading the team record and checking your invitation', 'Making the keys for this computer', 'Saving your join to the team record']);
    assert.ok(j.secrets.values.has(deviceKeySecretName((await readTeamFile(j.root))?.teamId as string)));
    assert.equal(everythingShown().includes(bundleText), false);
    assert.equal(everythingShown().includes(parseInviteBundle(bundleText).code), false);
    await closeWindow(j);
  }, { near: true });
});

test('Join in a team without a NEAR organization asks for the member\'s own key in a masked input and says spend is not capped', async () => {
  await withTeam(async (t) => {
    const bundleText = await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t);
    stub.inputAnswers.push(bundleText, 'Dana D');
    // 61-30: the masked box comes after the pick of your own key, a saved profile or later.
    stub.quickPickAnswers.push(JOIN_TEXT.pasteOwnKey);
    await j.run(JOIN_COMMAND);
    const keyPrompt = stub.inputRequests[2];
    assert.equal(keyPrompt?.password, true, 'the key is masked');
    assert.equal(stub.notifications.filter((entry) => entry.message.includes(NO_ORG_NOTICE)).length, 1, 'the notice is shown once');
    assert.ok(stub.notifications.some((entry) => entry.message.startsWith('You joined Invite team as an observer.')));
    assert.equal(j.handle.session()?.memberId(), parseInviteBundle(bundleText).member);
    await closeWindow(j);
  });
});

test('Join as a lead invitee signs in to NEAR once and reports the organization invitation', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const bundleText = await inviteBundle(t, { name: 'Lee', email: 'lee@example.invalid', role: 'Lead' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t);
    const before = t.signIns.count;
    t.signIns.tokens = t.fake?.addUser({ id: 'user-lee-2', username: 'lee2', email: 'lee@example.invalid' });
    stub.inputAnswers.push(bundleText, 'Lee L');
    await j.run(JOIN_COMMAND);
    assert.equal(t.signIns.count, before + 1, 'the lead invitee signed in once');
    assert.ok(stub.notifications.some((entry) => entry.message === 'You joined your organization, the account that pays for your team\'s AI.'), stub.notifications.map((entry) => entry.message).join(' | '));
    assert.equal(everythingShown().includes(t.signIns.tokens?.refreshToken as string), false, 'no token is shown');
    await closeWindow(j);
  }, { near: true });
});

test('Join refuses text that is not an invite without echoing it, and cancelling the paste changes nothing', async () => {
  await withTeam(async (t) => {
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t);
    await j.run(JOIN_COMMAND);
    assert.equal(stub.notifications.length, 0, 'cancelling the paste says nothing');
    stub.inputAnswers.push('definitely not an invite');
    await j.run(JOIN_COMMAND);
    assert.equal(stub.notifications.length, 1);
    assert.equal(stub.notifications[0]?.level, 'error');
    assert.equal(everythingShown().includes('definitely not an invite'), false);
    assert.equal(j.secrets.values.size, 0);
    await closeWindow(j);
  });
});

test('an unfinished earlier join is offered a reset only when the team list does not show this computer', async () => {
  await withTeam(async (t) => {
    const bundleText = await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const teamId = (await readTeamFile(t.root))?.teamId as string;
    // An interrupted join left a device key behind on the teammate's computer.
    const leftover = new MemorySecrets();
    await createDeviceIdentity(leftover, teamId);
    assert.ok(leftover.values.has(deviceKeySecretName(teamId)));
    const j = await openJoiner(t, { secrets: leftover });
    stub.inputAnswers.push(bundleText, 'Dana D');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove unfinished keys') ? 'Remove unfinished keys' : undefined));
    await j.run(JOIN_COMMAND);
    assert.equal(j.secrets.values.has(deviceKeySecretName(teamId)), false, 'the unfinished keys were removed');
    assert.equal(j.secrets.values.has(sealKeySecretName(teamId)), false);
    assert.ok(stub.notifications.some((entry) => entry.message.includes('re-issue')), 'it tells the person to ask for a re-issued invite');
    await closeWindow(j);
  });
});

// ---- Link Your Organization -------------------------------------------------------------------------------------------------------------

test('Link signs in, lists only organizations the lead owns or administers, commits team.json only, and shares the team setup after one confirmation', async () => {
  await withTeam(async (t) => {
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Second workspace');
    stub.setMessageResponder(shareWhenAsked);
    await t.run(LINK_NEAR_COMMAND);

    assert.equal(t.signIns.count, 1, 'signed in once');
    assert.deepEqual([stub.quickPickRequests[0]?.placeHolder, stub.quickPickRequests[0]?.labels], [LINK_EXPLANATION, [LINK_NOW_CHOICE, NOT_NOW_CHOICE]], 'the one-line explanation comes first');
    assert.deepEqual(stub.quickPickRequests[1]?.labels, ['Team Org'], 'the organization where the lead is only a member is not offered');
    assert.deepEqual(stub.quickPickRequests[2]?.labels, ['Team workspace', 'Second workspace']);
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-2' });
    assert.equal(gitIn(t.root, ['log', '-1', '--format=%s']), LINK_COMMIT_MESSAGE);
    assert.equal(gitIn(t.root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);
    assert.ok(t.secrets.values.has(nearSessionSecretName((await readTeamFile(t.root))?.teamId as string)), 'the sign-in is kept for this team');
    assert.ok(shownMessages().includes('Linked Invite team to Team Org.'), shownMessages().join(' | '));
    // One confirmation, in a modal, with Share; then the online team setup has the link.
    const asked = stub.notifications.flatMap((entry, index) => (entry.message === LINK_SHARE_QUESTION ? [index] : []));
    assert.equal(asked.length, 1, 'asked once');
    assert.equal(stub.notificationOptions[asked[0] as number]?.modal, true);
    assert.deepEqual(stub.notificationActions[asked[0] as number], ['Share']);
    assert.equal(remoteTeamJson(t), (await fs.readFile(path.join(t.root, TEAM_FILE_REL), 'utf8')).trim(), 'the online team.json is this computer\'s');
    assert.deepEqual(JSON.parse(remoteTeamJson(t)).near, { organizationId: 'org-1', workspaceId: 'ws-2' }, 'the online team setup has the link');
    assert.ok(shownMessages().includes('Your team setup is online. Teammates can now join.'), shownMessages().join(' | '));
    assert.equal(stub.notificationActions.some((actions) => actions?.includes('Share with my team') === true), false, 'no old push offer');
    assert.equal(stub.notifications.some((entry) => /Pushed|push|origin|commit|branch/i.test(entry.message)), false, 'no git words in what is shown');
    assert.ok(outputLines().includes('team.json is committed on main. Sharing pushes it.'), 'the git detail is in the channel only');
    assert.equal(t.handle.session()?.teamFile.near?.workspaceId, 'ws-2', 'the session was restarted on the new team.json');
    // UI review issue 1: reading the lists can be stopped; the write cannot.
    assert.equal(progressNamed('Reading your organizations')?.cancellable, true);
    assert.deepEqual(progressNamed('Linking Invite team to Team Org'), { title: 'Linking Invite team to Team Org', cancellable: false, messages: ['Saving the link in this project'] });
    assert.equal(everythingShown().includes(t.signIns.tokens?.refreshToken as string), false);
  }, { near: true });
});

test('declining the share after Link keeps the link on this computer and says teammates will not see it until it is shared, pointing at Share in the Team section', async () => {
  await withTeam(async (t) => {
    const remoteBefore = gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']);
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' }, 'the link is kept on this computer');
    assert.equal(gitIn(t.root, ['log', '-1', '--format=%s']), LINK_COMMIT_MESSAGE);
    assert.equal(gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']), remoteBefore, 'nothing was shared');
    assert.equal(JSON.parse(remoteTeamJson(t)).near, undefined, 'the online team setup has no link yet');
    assert.equal(stub.notifications.filter((entry) => entry.message === LINK_SHARE_QUESTION).length, 1, 'asked once');
    assert.ok(shownMessages().includes('Linked Invite team to Team Org.'), shownMessages().join(' | '));
    assert.equal(shownMessages().at(-1), LINK_NOT_SHARED, shownMessages().join(' | '));
    assert.ok(outputLines().some((line) => line.includes('not on main online (declined)')), outputLines().join(' | '));
    assert.equal(stub.notificationActions.some((actions) => actions?.includes('Share with my team') === true), false, 'no old push offer');
  }, { near: true });
});

test('no membership command pushes a branch: memberCommands.ts has no push offer or push helper, and the team setup goes online only through the share flow', () => {
  const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'services', 'team', 'memberCommands.ts'), 'utf8');
  for (const gone of ['pushCodeBranch', 'offerPush', 'pushBranch', 'Share with my team']) assert.equal(source.includes(gone), false, `${gone} is gone`);
  assert.match(source, /reason: 'link'/);
});

test('the handle tells listeners when Link restarts the session on the new team.json', async () => {
  await withTeam(async (t) => {
    const seen: Array<string | undefined> = [];
    const listener = t.handle.onDidChange(() => { seen.push(t.handle.session()?.teamFile.near?.workspaceId); });
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Second workspace');
    await t.run(LINK_NEAR_COMMAND);
    listener.dispose();
    assert.ok(seen.includes('ws-2'), 'a listener heard the restart on the linked team.json');
  }, { near: true });
});

test('a Link whose save for the team does not finish says so in plain words with Show details, and keeps the git step in the channel', async () => {
  await withTeam(async (t) => {
    await fs.writeFile(path.join(t.root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    const warning = stub.notifications.findIndex((entry) => entry.level === 'warn');
    assert.ok(warning >= 0, stub.notifications.map((entry) => entry.message).join(' | '));
    assert.equal(stub.notifications[warning]?.message, 'The link is saved in this project, but saving it for the team did not finish. Choose Show details for the one step that is left.');
    assert.deepEqual(stub.notificationActions[warning], ['Show details']);
    assert.ok(outputLines().some((line) => line.includes('hook rejected this commit message') && line.includes(`git add -f ${TEAM_FILE_REL}`)), 'the channel has the git reason and the step');
    assert.equal(stub.notifications.some((entry) => /commit|git add/i.test(entry.message)), false, 'no git words in what is shown');
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' }, 'the link is on disk');
  }, { near: true });
});

test('Link does not sign in again when this team already has a NEAR session, says so when already linked, and asks before replacing a link', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const signIns = t.signIns.count;
    stub.quickPickAnswers.push('Team Org', 'Team workspace');
    const head = gitIn(t.root, ['rev-parse', 'HEAD']);
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(t.signIns.count, signIns, 'no second sign-in');
    assert.equal(gitIn(t.root, ['rev-parse', 'HEAD']), head, 'linking the same organization again commits nothing');
    assert.ok(stub.notifications.some((entry) => entry.message.includes('already linked')), stub.notifications.map((entry) => entry.message).join(' | '));
  }, { near: true });
});

test('Link of a different organization is only done after a clear confirmation', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const head = gitIn(t.root, ['rev-parse', 'HEAD']);
    stub.quickPickAnswers.push('Team Org', 'Second workspace');
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(gitIn(t.root, ['rev-parse', 'HEAD']), head, 'declining the confirmation changes nothing');
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    clearUi();
    stub.quickPickAnswers.push('Team Org', 'Second workspace');
    stub.setMessageResponder((_text, actions) => (actions.includes('Replace link') ? 'Replace link' : undefined));
    await t.run(LINK_NEAR_COMMAND);
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-2' });
  }, { near: true });
});

test('Link Your Organization first explains the organization in one line; Not now changes nothing and says so, and Link now signs in', async () => {
  await withTeam(async (t) => {
    clearUi();
    const fileBefore = await fs.readFile(path.join(t.root, TEAM_FILE_REL), 'utf8');
    const head = gitIn(t.root, ['rev-parse', 'HEAD']);
    const secretsBefore = [...t.secrets.values.keys()].sort();
    stub.quickPickAnswers.push(NOT_NOW_CHOICE);
    await t.run(LINK_NEAR_COMMAND);
    assert.deepEqual(stub.quickPickRequests.map((request) => [request.title, request.placeHolder, request.labels]), [
      ['Link Your Organization', LINK_EXPLANATION, [LINK_NOW_CHOICE, NOT_NOW_CHOICE]]
    ], 'one pick, the explanation, nothing else');
    assert.ok(stub.quickPickRequests[0]?.descriptions[0]?.includes('Sign in to NEAR AI'), 'Link now says it signs in to NEAR AI');
    assert.equal(t.signIns.count, 0, 'Not now asks for no sign-in');
    assert.equal(await fs.readFile(path.join(t.root, TEAM_FILE_REL), 'utf8'), fileBefore, 'team.json is unchanged');
    assert.equal(gitIn(t.root, ['rev-parse', 'HEAD']), head, 'nothing was saved for the team');
    assert.deepEqual([...t.secrets.values.keys()].sort(), secretsBefore, 'SecretStorage is unchanged');
    assert.deepEqual(shownMessages(), [`Nothing was changed. ${NO_ORG_NOTICE}`]);
    clearUi();

    // Closing the pick is the same as Not now, without a message.
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(t.signIns.count, 0);
    assert.equal(await fs.readFile(path.join(t.root, TEAM_FILE_REL), 'utf8'), fileBefore);
    clearUi();

    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(t.signIns.count, 1, 'Link now goes on into the sign-in');
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    clearUi();

    // A team that is already linked goes straight to the organization pickers.
    stub.quickPickAnswers.push('Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(stub.quickPickRequests.some((request) => request.placeHolder === LINK_EXPLANATION), false, 'no explanation once linked');
    assert.ok(shownMessages().some((message) => message.includes('already linked')), shownMessages().join(' | '));
  }, { near: true });
});

// ---- Sign Out of NEAR AI for This Team ---------------------------------------------------------------------------------------------------

test('Sign out deletes only this team\'s NEAR session, and with none says there is nothing to sign out of', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const teamId = (await readTeamFile(t.root))?.teamId as string;
    t.secrets.values.set(nearSessionSecretName('team-other'), 'another team session');
    assert.ok(t.secrets.values.has(deviceKeySecretName(teamId)));
    await t.run(SIGN_OUT_NEAR_COMMAND);
    assert.equal(t.secrets.values.has(nearSessionSecretName(teamId)), false);
    assert.equal(t.secrets.values.has(nearSessionSecretName('team-other')), true, 'another team keeps its session');
    assert.ok(t.secrets.values.has(deviceKeySecretName(teamId)), 'the device key is untouched');
    assert.deepEqual(stub.notifications.map((entry) => entry.message), ['Signed out of NEAR AI for Invite team.']);
    clearUi();
    await t.run(SIGN_OUT_NEAR_COMMAND);
    assert.equal(stub.notifications.length, 1);
    assert.ok(stub.notifications[0]?.message.includes('nothing to sign out of'));
  }, { near: true });
});

// ---- Invite in a team linked to NEAR ----------------------------------------------------------------------------------------------------

test('inviting a developer in a linked team never signs in to NEAR or invites them to the organization', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await t.run(SIGN_OUT_NEAR_COMMAND);
    clearUi();
    const before = { signIns: t.signIns.count, requests: t.fake?.requests.length };
    await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    assert.equal(t.signIns.count, before.signIns);
    assert.equal(t.fake?.requests.length, before.requests, 'no NEAR request at all');
    assert.equal(stub.notifications.some((entry) => entry.message === NO_ORG_NOTICE), false, 'no degraded-team notice in a linked team');
  }, { near: true });
});

test('inviting a lead in a linked team asks the lead to sign in to NEAR first, and then invites them to the organization', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await t.run(SIGN_OUT_NEAR_COMMAND);
    // Signing out ended the old session at NEAR, so the next browser sign-in hands back a fresh one.
    t.signIns.tokens = t.fake?.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    clearUi();
    stub.inputAnswers.push('Lee', 'lee@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    const before = t.signIns.count;
    await t.run(INVITE_COMMAND);
    assert.equal(t.signIns.count, before + 1, 'the lead was asked to sign in');
    assert.notEqual(t.fake?.emailedToken('lee@example.invalid'), undefined, 'the NEAR organization invitation was sent');
    assert.equal(stub.clipboardWrites.length, 1);
  }, { near: true });
});

// 61-20 (owner, 2026-11-03): instead of warning after the fact, Invite shares the team setup first with one confirmation, so the link is online
// before anyone is invited. Was: "... whose NEAR link is not shared yet warns that a teammate who gets the project now would not see it".
test('inviting in a linked team whose organization link is not shared yet asks once to share the team setup first, and then the online setup has the link', async () => {
  await withTeam(async (t) => {
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    clearUi();
    stub.inputAnswers.push('Dana', 'dana@example.invalid', '5');
    stub.quickPickAnswers.push('Developer', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes('Share and continue') ? 'Share and continue' : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    stub.setMessageResponder(undefined);
    assert.equal(stub.notificationActions.filter((actions) => actions.includes('Share and continue')).length, 1, 'one share confirmation');
    assert.deepEqual(JSON.parse(gitIn(t.fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`])).near, { organizationId: 'org-1', workspaceId: 'ws-1' }, 'the online team setup has the link');
    assert.equal(stub.notifications.some((entry) => entry.message.includes('not shared')), false, 'no after-the-fact warning');
    assert.equal(stub.clipboardWrites.length, 1, 'the invite was made after the share');
    clearUi();
    await inviteBundle(t, { name: 'Eve', email: 'eve@example.invalid', role: 'Developer' });
    assert.equal(stub.notificationActions.some((actions) => actions.includes('Share and continue')), false, 'no share question once the setup is online');
  }, { near: true });
});

test('choosing Link now while inviting links the team first, without asking twice, and the bundle carries the link', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Dana', 'dana@example.invalid', '5');
    // 61-20: the organization choice comes first, and the invite's one share confirmation puts the linked team setup online.
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace', 'Developer', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes('Share and continue') ? 'Share and continue' : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    assert.equal(stub.quickPickRequests.filter((request) => request.placeHolder === LINK_EXPLANATION).length, 1, 'the explanation is asked once');
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    assert.equal(stub.clipboardWrites.length, 1);
    assert.deepEqual(parseInviteBundle(stub.clipboardWrites[0] as string).near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    assert.equal(stub.notifications.some((entry) => entry.message === NO_ORG_NOTICE), false);
  }, { near: true });
});

// ---- Manage Team Members ----------------------------------------------------------------------------------------------------------------

// A teammate is invited, joins from the second clone, and the lead's window syncs so it knows about them.
async function joinMember(t: Team, person: { name: string; email: string; role: string; displayName: string }): Promise<{ memberId: string; bundle: string; secrets: MemorySecrets }> {
  const bundle = await inviteBundle(t, person);
  gitIn(t.root, ['push', '-q', 'origin', 'main']);
  const j = await openJoiner(t);
  stub.inputAnswers.push(bundle, person.displayName);
  await j.run(JOIN_COMMAND);
  await closeWindow(j);
  // The lead's window is the one in front again.
  stub.setWorkspaceFolders([t.root]);
  await t.handle.session()?.sync();
  clearUi();
  return { memberId: parseInviteBundle(bundle).member, bundle, secrets: j.secrets };
}

const lastList = (): string[] => stub.quickPickRequests[stub.quickPickRequests.length - 1]?.labels ?? [];
const manageActions = (): string[] => stub.quickPickRequests[1]?.labels ?? [];

test('Manage Team Members lists the NEAR line first, then members with their state, invitations and cleanup items', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    const dana = await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    await inviteBundle(t, { name: 'Eve', email: 'eve@example.invalid', role: 'Reviewer' });
    const fay = await inviteBundle(t, { name: 'Fay', email: 'fay@example.invalid', role: 'Observer' });
    const cleanup = new CleanupChecklist(teamStorageDir(t.storage, (await readTeamFile(t.root))?.teamId as string));
    await cleanup.add([{ memberId: dana.memberId, memberName: 'Dana D', step: 'repo-access', status: 'manual' }]);
    clearUi();
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(lastList(), [
      'Invite someone',
      // G-61-9 (61-29): accepting a request to join sits right after inviting.
      'Accept a request',
      'NEAR AI sign-in: lead',
      'Lead Owner, owner',
      'Dana D, developer, waiting for confirmation',
      'Invitation for Dana D, developer, used',
      'Invitation for Eve, reviewer, pending',
      'Invitation for Fay, observer, pending',
      'Project access for Dana D'
    ]);
    assert.ok(parseInviteBundle(fay).member.length > 0);
    assert.equal(everythingShown().includes(EM_DASH), false);
  }, { near: true });
});

test('Manage Team Members in a team without NEAR starts with the plain no-organization line and never talks about a cap', async () => {
  await withTeam(async (t) => {
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(lastList().slice(0, 2), ['Invite someone', 'Accept a request'], 'the owner sees Invite someone and Accept a request first (61-29)');
    assert.equal(lastList()[2], NO_ORG_NOTICE, 'then the organization line');
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.startsWith('Dana D is now a developer.')), shownMessages().join(' | '));
    assert.equal(shownMessages().some((message) => /spend cap|capped|limit/i.test(message.replace(NO_ORG_NOTICE, ''))), false, 'no cap is claimed without a NEAR organization');
    assert.equal(t.handle.session()?.state().members.get(await readMemberId(t, 'Dana D'))?.role, 'developer');
  });
});

// ---- 61-26 (G-61-8): Invite someone from Members, and inviting from a project with no team -----------------------------------------------------

test('Members lists Invite someone first for the owner and leads, and choosing it runs the invite', async () => {
  await withTeam(async (t) => {
    stub.quickPickAnswers.push('Invite someone', NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.inputAnswers.push('Gus', 'gus@example.invalid', '5');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(MANAGE_MEMBERS_COMMAND);
    stub.setMessageResponder(undefined);
    assert.equal(stub.quickPickRequests[0]?.labels[0], 'Invite someone', 'the first row of Members');
    assert.equal(stub.clipboardWrites.length, 1, `the invite was made (${shownMessages().join(' | ')})`);
    const invited = [...(t.handle.session()?.state().members.values() ?? [])].filter((member) => member.status === 'invited').map((member) => member.name);
    assert.deepEqual(invited, ['Gus'], 'member.invited is in the log');
  });
});

test('Members has no Invite someone row for a member who does not run the team', async () => {
  await withTeam(async (t) => {
    const dana = await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    const j = await openJoiner(t, { pull: false, secrets: dana.secrets });
    try {
      await j.run(MANAGE_MEMBERS_COMMAND);
      assert.ok(lastList().length > 0, 'the list was shown');
      assert.equal(lastList().includes('Invite someone'), false);
      assert.equal(lastList().includes('Accept a request'), false, 'nor Accept a request (61-29)');
    } finally {
      await closeWindow(j);
      stub.setWorkspaceFolders([t.root]);
    }
  });
});

interface Solo { fixture: TeamFixture; root: string; storage: string; context: FakeContext; handle: ReturnType<typeof registerTeamMode>; run(command: string): Promise<void> }

// A project with no team yet, with its online home at a public-looking address (or kept on this computer with `home: 'local'`).
async function withNoTeam(work: (solo: Solo) => Promise<void>, options: { home?: 'public' | 'local' } = {}): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a'], initialised: true });
  const root = fixture.clones['a'] as string;
  const storage = fixture.storageDir('a');
  const context = createFakeContext(storage, new MemorySecrets());
  let handle: ReturnType<typeof registerTeamMode> | undefined;
  try {
    if (options.home !== 'local') {
      gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
      gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    }
    stub.setWorkspaceFolders([root]);
    handle = registerTeamMode(context as never);
    assert.equal(await handle.ready, 'solo');
    const own = new Map(stub.commands);
    const run = async (command: string): Promise<void> => {
      const handler = own.get(command);
      assert.ok(handler !== undefined, `${command} is registered`);
      await handler();
    };
    await work({ fixture, root, storage, context, handle, run });
  } finally {
    await closeWindow({ context, handle });
    await removeFixture(fixture);
  }
}

const shareThenCopy = (_text: string, actions: string[]): string | undefined => (actions.includes('Share and continue') ? 'Share and continue' : actions.includes('Copy invite') ? 'Copy invite' : undefined);

test('Invite someone in a project with no team sets the team up on the way and carries on into the invite in the same command', async () => {
  await withNoTeam(async (s) => {
    stub.inputAnswers.push('Solo team', 'Lead Owner', 'Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push(NOT_NOW_CHOICE, 'Developer', '7 days');
    stub.setMessageResponder(shareThenCopy);
    await s.run(INVITE_COMMAND);
    stub.setMessageResponder(undefined);
    // The only new questions are the team name and your name, both filled in already, titled Invite someone; no email question.
    const first = stub.inputRequests.slice(0, 2);
    assert.deepEqual(first.map((request) => [request.title, request.prompt]), [['Invite someone', 'Team name'], ['Invite someone', 'Your name as teammates will see it']]);
    assert.equal(first[0]?.value, 'a', 'the team name is the folder name');
    assert.equal(first[1]?.value, 'Team Test', 'your name is the name this computer already uses');
    assert.equal(stub.inputRequests.some((request) => /email is kept only/i.test(request.prompt ?? '')), false, 'no email question for the lead');
    assert.deepEqual(stub.inputRequests.slice(2).map((request) => request.prompt?.split('.')[0]), ['Name of the person you are inviting', 'Their email address', 'Allocation in US dollars']);
    // The team exists, its setup was shared with the invite's one confirmation, and the invite was made and shown once.
    assert.equal(s.handle.session()?.teamFile.name, 'Solo team', 'the team session runs');
    assert.equal(JSON.parse(gitIn(s.fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`])).name, 'Solo team', 'the team setup is online');
    const invited = [...(s.handle.session()?.state().members.values() ?? [])].filter((member) => member.status === 'invited').map((member) => member.name);
    assert.deepEqual(invited, ['Ana'], 'member.invited is in the log');
    assert.equal(stub.clipboardWrites.length, 1, 'the invite was copied');
    assert.ok(modalsShown().some((modal) => modal.message === 'Invite ready for Ana'), 'the invite modal was shown');
    // No separate message that the team is on interrupts, and nothing on screen names the old feature.
    assert.equal(shownMessages().some((message) => /^Your team for|is ready\.|Team Mode is on/.test(message)), false, shownMessages().join(' | '));
    assert.doesNotMatch(everythingShown(), /team\s+mode/i);
  });
});

test('dismissing the team name while inviting from a project with no team stops with nothing changed', async () => {
  await withNoTeam(async (s) => {
    const head = gitIn(s.root, ['rev-parse', 'HEAD']);
    stub.inputAnswers.push(undefined as unknown as string);
    await s.run(INVITE_COMMAND);
    assert.equal(await readTeamFile(s.root), undefined, 'no team record');
    assert.equal(s.handle.session(), undefined, 'no team session');
    assert.equal(gitIn(s.root, ['rev-parse', 'HEAD']), head, 'nothing saved in the project');
    assert.equal(stub.inputRequests.length, 1, 'only the team name was asked');
    assert.equal(stub.clipboardWrites.length, 0);
    assert.equal(existsSync(path.join(s.storage, 'team')), false, 'no team storage');
  });
});

test('inviting from a project kept only on this computer warns first, as turning a team on always did; Not now changes nothing', async () => {
  await withNoTeam(async (s) => {
    const { LOCAL_ONLY_TEXT, NOT_NOW_ACTION } = commandsModule;
    stub.messageAnswers.push(NOT_NOW_ACTION);
    await s.run(INVITE_COMMAND);
    assert.equal(stub.notifications[0]?.message, LOCAL_ONLY_TEXT);
    assert.equal(stub.notificationOptions[0]?.modal, true);
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(await readTeamFile(s.root), undefined);
    assert.equal(s.handle.session(), undefined);
  }, { home: 'local' });
});

async function readMemberId(t: Team, name: string): Promise<string> {
  for (const member of t.handle.session()?.state().members.values() ?? []) if (member.name === name) return member.id;
  throw new Error(`no member named ${name}`);
}

test('Confirm makes the member their invited role and in a linked team sends a key capped at their allocation', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Confirm', 'Remove']);
    assert.ok(shownMessages().includes('Dana D is now a developer. Their team key has a spend cap of $5.00 set by you.'), shownMessages().join(' | '));
    assert.deepEqual(progressNamed('Confirming Dana D'), {
      title: 'Confirming Dana D', cancellable: false,
      messages: ['Saving the confirmation to the team record', 'Creating the key with its spend cap', 'Sealing the key to their computer', 'Saving the key delivery to the team record']
    });
    const member = t.handle.session()?.state().members.get(await readMemberId(t, 'Dana D'));
    assert.equal(member?.role, 'developer');
    assert.ok(member?.nearApiKeyId !== undefined, 'the key id is in the log');
    const key = t.fake?.key(member?.nearApiKeyId as string);
    assert.equal(key?.spendLimitNanoUsd, 5_000_000_000);
    assert.equal(everythingShown().includes(key?.secret as string), false, 'the clear key is never shown');
    assert.equal(everythingShown().includes(EM_DASH), false);
  }, { near: true });
});

test('Remove asks for confirmation, caps and revokes the key, and lists what is left with the repository reminder last', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    clearUi();
    const id = await readMemberId(t, 'Dana D');
    const keyId = t.handle.session()?.state().members.get(id)?.nearApiKeyId as string;

    // Declining the confirmation changes nothing.
    stub.quickPickAnswers.push('Dana D, developer', 'Remove');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.equal(t.handle.session()?.state().members.get(id)?.removedEvent, undefined);
    const ask = stub.notifications.findIndex((entry) => entry.message === 'Remove Dana D from Invite team?');
    assert.ok(ask >= 0, shownMessages().join(' | '));
    assert.equal(stub.notificationOptions[ask]?.modal, true);
    assert.deepEqual(stub.notificationActions[ask], ['Remove']);
    clearUi();

    stub.quickPickAnswers.push('Dana D, developer', 'Remove');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove') ? 'Remove' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.notEqual(t.handle.session()?.state().members.get(id)?.removedEvent, undefined, 'removed from the log');
    assert.equal(t.fake?.key(keyId)?.revoked, true, 'the key was revoked');
    assert.ok(shownMessages().some((message) => message.startsWith('Dana D was removed from Invite team.') && message.includes('capped at 0 and revoked')), shownMessages().join(' | '));
    // UI review issue 1: each removal step is shown while it runs; the removal can be stopped only where that is safe.
    assert.deepEqual(progressNamed('Removing Dana D from Invite team'), {
      title: 'Removing Dana D from Invite team', cancellable: true, messages: ['Setting the AI key limit to 0', 'Saving the removal to the team record', 'Revoking the AI key']
    });
    const lines = outputLines();
    const todo = lines.slice(lines.indexOf('Still to do for Dana D:') + 1).filter((line) => line.startsWith('- '));
    assert.ok(todo.length >= 1, lines.join(' | '));
    assert.equal(todo[todo.length - 1], `- ${repoAccessText('Dana D')}`, 'the repository access reminder comes last');
  }, { near: true });
});

test('UI review issue 1: stopping a removal after the log write leaves the key capped at 0 and the revoke on the cleanup list; nothing is ever left uncapped', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    clearUi();
    const id = await readMemberId(t, 'Dana D');
    const keyId = t.handle.session()?.state().members.get(id)?.nearApiKeyId as string;

    // The person clicks Cancel while the key is being capped: the cap and the log removal still finish together, then the revoke waits.
    stub.setProgressCancel((_title, message) => message === 'Setting the AI key limit to 0');
    stub.quickPickAnswers.push('Dana D, developer', 'Remove');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove') ? 'Remove' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.notEqual(t.handle.session()?.state().members.get(id)?.removedEvent, undefined, 'the removal was written');
    assert.equal(t.fake?.key(keyId)?.spendLimitNanoUsd, 0, 'the key is capped');
    assert.equal(t.fake?.key(keyId)?.revoked, false, 'the revoke waits on the cleanup list');
    assert.ok(shownMessages().some((message) => message.includes('You stopped before the last steps in your organization')), shownMessages().join(' | '));
    assert.equal(shownMessages().some((message) => message.includes('can still spend')), false);
    const teamId = (await readTeamFile(t.root))?.teamId as string;
    const items = await new CleanupChecklist(teamStorageDir(t.storage, teamId)).forMember(id);
    assert.deepEqual(items.filter((item) => item.step !== 'repo-access').map((item) => `${item.step}:${item.status}`), ['zero-limit:done', 'revoke-key:pending']);
  }, { near: true });
});

test('Remove warns that the key can still spend when it could not be capped, and keeps the manual NEAR step in the message', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    clearUi();
    const id = await readMemberId(t, 'Dana D');
    const keyId = t.handle.session()?.state().members.get(id)?.nearApiKeyId as string;
    t.fake?.fail({ method: 'PATCH', pathPrefix: `/v1/workspaces/ws-1/api-keys/${keyId}/spend-limit`, status: 500, times: 20 });
    stub.quickPickAnswers.push('Dana D, developer', 'Remove');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove') ? 'Remove' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    const warning = stub.notifications.find((entry) => entry.level === 'warn' && entry.message.includes('can still spend'));
    assert.ok(warning !== undefined, shownMessages().join(' | '));
    assert.ok(warning.message.includes("set its limit to 0 in your organization's settings on the NEAR AI website"), 'the manual step is shown as written');
    assert.notEqual(t.handle.session()?.state().members.get(id)?.removedEvent, undefined, 'the removal still happened');
  }, { near: true });
});

test('Cancel ends a pending invitation and Re-issue replaces it with a new bundle shown once in the same modal with Copy invite', async () => {
  await withTeam(async (t) => {
    const eve = await inviteBundle(t, { name: 'Eve', email: 'eve@example.invalid', role: 'Reviewer' });
    const eveId = parseInviteBundle(eve).member;
    clearUi();
    stub.quickPickAnswers.push('Invitation for Eve, reviewer, pending', 'Re-issue', '3 days');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Cancel invitation', 'Re-issue']);
    assert.equal(stub.clipboardWrites.length, 1);
    const fresh = parseInviteBundle(stub.clipboardWrites[0] as string);
    assert.notEqual(fresh.member, eveId, 'a new invitation');
    const state = t.handle.session()?.state();
    assert.notEqual(state?.members.get(eveId)?.removedEvent, undefined, 'the old invitation stopped working');
    assert.equal(state?.members.get(fresh.member)?.invite?.ttlSeconds, 259_200);
    assert.equal(everythingShown().includes(stub.clipboardWrites[0] as string), false);
    // G-61-5: Re-issue uses the same modal as Invite.
    assert.deepEqual(modalsShown(), [{ message: 'Invite ready for Eve', detail: `${stub.clipboardWrites[0] as string}\n\n${HOW_TO_SEND}`, actions: ['Copy invite'] }]);
    clearUi();

    // UI review issue 2: Cancel invitation asks first, in a modal; declining changes nothing.
    stub.setMessageResponder(undefined);
    stub.quickPickAnswers.push('Invitation for Eve, reviewer, pending', 'Cancel invitation');
    await t.run(MANAGE_MEMBERS_COMMAND);
    const ask = stub.notifications.findIndex((entry) => entry.message === 'Cancel the invitation for Eve?');
    assert.ok(ask >= 0, shownMessages().join(' | '));
    assert.equal(stub.notificationOptions[ask]?.modal, true);
    assert.match(stub.notificationOptions[ask]?.detail ?? '', /invite code stops working/);
    assert.deepEqual(stub.notificationActions[ask], ['Cancel invitation']);
    assert.equal(t.handle.session()?.state().members.get(fresh.member)?.removedEvent, undefined, 'declining kept the invitation');
    assert.ok(shownMessages().includes('The invitation for Eve was not changed.'), shownMessages().join(' | '));
    clearUi();

    stub.setMessageResponder((_text, actions) => (actions.includes('Cancel invitation') ? 'Cancel invitation' : undefined));
    stub.quickPickAnswers.push('Invitation for Eve, reviewer, pending', 'Cancel invitation');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().includes('The invitation for Eve was cancelled.'), shownMessages().join(' | '));
    assert.notEqual(t.handle.session()?.state().members.get(fresh.member)?.removedEvent, undefined);
    assert.deepEqual(progressNamed('Cancelling the invitation for Eve')?.messages, ['Saving the removal to the team record']);
  });
});

test('Manage Team Members accepts {memberId, action} from a notification and runs that action without a list', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    const id = await readMemberId(t, 'Dana D');
    await t.run(MANAGE_MEMBERS_COMMAND, { memberId: id, action: 'confirm' });
    assert.equal(stub.quickPickRequests.length, 0, 'no list was shown');
    assert.equal(t.handle.session()?.state().members.get(id)?.role, 'developer');
    assert.ok(shownMessages().some((message) => message.startsWith('Dana D is now a developer.')));
    clearUi();
    await t.run(MANAGE_MEMBERS_COMMAND, { memberId: id, action: 'not-an-action' });
    assert.equal(stub.quickPickRequests.length, 1, 'an argument it does not understand falls back to the list');
  }, { near: true });
});

test('a member without management rights sees the list read-only with no actions', async () => {
  await withTeam(async (t) => {
    const dana = await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    const j = await openJoiner(t, { pull: false, secrets: dana.secrets });
    assert.equal(j.handle.session()?.memberId(), dana.memberId, 'this window is Dana\'s');
    stub.quickPickAnswers.push('Lead Owner, owner');
    await j.run(MANAGE_MEMBERS_COMMAND);
    assert.equal(stub.quickPickRequests.length, 1, 'no second list of actions');
    assert.ok(lastList().includes('Lead Owner, owner'));
    assert.ok(shownMessages().some((message) => message.includes('Only the owner or a lead can change the team')), shownMessages().join(' | '));
    await closeWindow(j);
  });
});

test('a member without management rights is told who can share the team setup, and nothing is asked or shared', async () => {
  await withTeam(async (t) => {
    const dana = await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    const j = await openJoiner(t, { pull: false, secrets: dana.secrets });
    const before = gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']);
    clearUi();
    await j.run(SHARE_COMMAND);
    // Dana joined as a developer invitee and stays an observer until the lead confirms her.
    assert.ok(shownMessages().includes('Only the owner or a lead can share the team setup. Your role in this team is observer.'), shownMessages().join(' | '));
    assert.equal(stub.notificationOptions.some((options) => options?.modal === true), false, 'no confirmation was asked');
    assert.equal(gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']), before, 'nothing was shared');
    await closeWindow(j);
  });
});

test('Retry sends a NEAR invitation left on the cleanup list after asking the lead to sign in, Mark done is only for project access, and an unknown email is explained', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await t.run(SIGN_OUT_NEAR_COMMAND);
    t.signIns.tokens = t.fake?.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    clearUi();
    // A lead invited without NEAR leaves the NEAR invitation on the cleanup list.
    stub.inputAnswers.push('Lee', 'lee@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    assert.equal(t.fake?.emailedToken('lee@example.invalid'), undefined, 'nothing reached NEAR yet');
    const teamId = (await readTeamFile(t.root))?.teamId as string;
    const cleanup = new CleanupChecklist(teamStorageDir(t.storage, teamId));
    const lee = parseInviteBundle(stub.clipboardWrites[0] as string);
    await cleanup.add([
      { memberId: lee.member, memberName: 'Lee', step: 'repo-access', status: 'manual' },
      { memberId: newMemberId(), memberName: 'Zed', step: 'send-invitation', status: 'pending' }
    ]);
    clearUi();

    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(lastList().includes('Still to finish: Send the invitation to your organization for Lee'), lastList().join(' | '));
    assert.ok(lastList().includes('Project access for Lee'));
    clearUi();

    stub.quickPickAnswers.push('Still to finish: Send the invitation to your organization for Lee', 'Retry');
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Retry']);
    assert.notEqual(t.fake?.emailedToken('lee@example.invalid'), undefined, 'the invitation reached NEAR');
    assert.equal((await cleanup.list()).find((item) => item.memberName === 'Lee' && item.step === 'send-invitation')?.status, 'done');
    clearUi();

    // CR-02: someone the team list does not have is never invited; the item is closed instead.
    stub.quickPickAnswers.push('Still to finish: Send the invitation to your organization for Zed', 'Retry');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.includes('item was closed')), shownMessages().join(' | '));
    assert.equal((await cleanup.list()).find((item) => item.memberName === 'Zed')?.status, 'done');
    clearUi();

    // A lead invitation made on another computer has no email here, which is explained and changes nothing.
    await t.run(SIGN_OUT_NEAR_COMMAND);
    clearUi();
    stub.inputAnswers.push('Uma', 'uma@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    const umaId = parseInviteBundle(stub.clipboardWrites[0] as string).member;
    const invitesFile = path.join(teamStorageDir(t.storage, teamId), INVITE_FILE);
    const invites = JSON.parse(await fs.readFile(invitesFile, 'utf8')) as { version: number; invites: Array<{ memberId: string }> };
    await fs.writeFile(invitesFile, JSON.stringify({ ...invites, invites: invites.invites.filter((entry) => entry.memberId !== umaId) }), 'utf8');
    clearUi();
    stub.quickPickAnswers.push('Still to finish: Send the invitation to your organization for Uma', 'Retry');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.includes('only known on the computer that sent the invitation')), shownMessages().join(' | '));
    assert.equal(t.fake?.emailedToken('uma@example.invalid'), undefined);
    clearUi();

    stub.quickPickAnswers.push('Project access for Lee', 'Mark done');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Mark done']);
    assert.equal((await cleanup.list()).find((item) => item.step === 'repo-access')?.status, 'done');
  }, { near: true });
});

// CR-02: a lead's NEAR invitation left on the cleanup list must not invite the person after they were removed or their invitation was replaced.
test('CR-02: Retry of a NEAR invitation for a removed lead closes the item without signing in or inviting them, and Re-issue closes the old one', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await t.run(SIGN_OUT_NEAR_COMMAND);
    clearUi();
    // Lee is invited as a lead without a NEAR sign-in, so the NEAR invitation waits on the cleanup list, and joins.
    stub.inputAnswers.push('Lee', 'lee@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    stub.setMessageResponder(undefined);
    const bundle = stub.clipboardWrites[0] as string;
    const lee = { memberId: parseInviteBundle(bundle).member };
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t);
    stub.inputAnswers.push(bundle, 'Lee L');
    await j.run(JOIN_COMMAND);
    await closeWindow(j);
    stub.setWorkspaceFolders([t.root]);
    await t.handle.session()?.sync();
    clearUi();
    const teamId = (await readTeamFile(t.root))?.teamId as string;
    const cleanup = new CleanupChecklist(teamStorageDir(t.storage, teamId));
    assert.equal((await cleanup.forMember(lee.memberId)).some((item) => item.step === 'send-invitation' && item.status !== 'done'), true, 'the invitation was queued');

    // Removed without a NEAR sign-in: the queued invitation is closed with the removal.
    stub.quickPickAnswers.push('Lee L, lead, waiting for confirmation', 'Remove');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove') ? 'Remove' : actions.includes(WITHOUT_KEY_NOW) ? WITHOUT_KEY_NOW : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.notEqual(t.handle.session()?.state().members.get(lee.memberId)?.removedEvent, undefined, shownMessages().join(' | '));
    assert.equal((await cleanup.forMember(lee.memberId)).some((item) => item.step === 'send-invitation' && item.status !== 'done'), false, 'nothing left to send');
    clearUi();

    // A stale item still on the list (another window saved it) is closed by Retry: no sign-in, no NEAR invitation.
    await cleanup.add([{ memberId: lee.memberId, memberName: 'Lee', step: 'send-invitation', status: 'failed' }]);
    const signIns = t.signIns.count;
    stub.quickPickAnswers.push('Still to finish: Send the invitation to your organization for Lee', 'Retry');
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.equal(t.fake?.emailedToken('lee@example.invalid'), undefined, 'the removed person was not invited to the NEAR organization');
    assert.equal(t.signIns.count, signIns, 'no sign-in was asked for');
    assert.ok(shownMessages().some((message) => message.includes('item was closed')), shownMessages().join(' | '));
    assert.equal((await cleanup.forMember(lee.memberId)).some((item) => item.step === 'send-invitation' && item.status !== 'done'), false);
    clearUi();

    // Re-issuing a lead invitation closes the unsent NEAR invitation of the invitation it replaces.
    stub.inputAnswers.push('Kim', 'kim@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(INVITE_COMMAND);
    const kim = parseInviteBundle(stub.clipboardWrites[0] as string).member;
    clearUi();
    stub.quickPickAnswers.push('Invitation for Kim, lead, pending', 'Re-issue', '3 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.equal(stub.clipboardWrites.length, 1, shownMessages().join(' | '));
    assert.deepEqual((await cleanup.forMember(kim)).filter((item) => item.step === 'send-invitation').map((item) => item.status), ['done'], 'the replaced invitation will not be sent');
    assert.equal(t.fake?.emailedToken('kim@example.invalid'), undefined);
  }, { near: true });
});

test('Confirm without a NEAR sign-in leaves the key pending, the list says so, and Send key signs in and delivers it', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    await t.run(SIGN_OUT_NEAR_COMMAND);
    t.signIns.tokens = t.fake?.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    clearUi();

    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_KEY_NOW) ? WITHOUT_KEY_NOW : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    const id = await readMemberId(t, 'Dana D');
    assert.equal(t.handle.session()?.state().members.get(id)?.role, 'developer', 'the confirmation stands');
    assert.equal(t.handle.session()?.state().members.get(id)?.nearApiKeyId, undefined, 'no key yet');
    clearUi();

    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(lastList().includes('Dana D, developer, key pending'), lastList().join(' | '));
    clearUi();

    stub.quickPickAnswers.push('Dana D, developer, key pending', 'Send key');
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Send key', 'Remove']);
    const keyId = t.handle.session()?.state().members.get(id)?.nearApiKeyId;
    assert.notEqual(keyId, undefined, 'the key was sent');
    assert.equal(t.fake?.key(keyId as string)?.spendLimitNanoUsd, 5_000_000_000);
    assert.equal(everythingShown().includes(t.fake?.key(keyId as string)?.secret as string), false);
  }, { near: true });
});
