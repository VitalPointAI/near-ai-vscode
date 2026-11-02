// The membership commands (Phase 61 plan 13) driven through the vscode stub on real git: Invite, Join, Manage Team Members, Link Team to NEAR
// Organization and Sign Out of NEAR (Team). The commands are thin adapters, so these tests check what the person sees and what lands in the
// log, the clipboard, SecretStorage and the output channel. Secret-shaped values (invite codes, API keys, refresh tokens) are built at run
// time or read back from the code under test, never written as literals. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { CleanupChecklist, repoAccessText } from '../team/cleanupChecklist';
import { createDeviceIdentity, deviceKeySecretName, newMemberId, sealKeySecretName } from '../team/identity';
import { parseInviteBundle } from '../team/inviteBundle';
import { INVITE_FILE } from '../team/invite';
import { nearSessionSecretName } from '../team/nearSession';
import { LINK_COMMIT_MESSAGE } from '../team/nearLink';
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
const { ENABLE_COMMAND, registerTeamMode } = commandsModule;
const { INVITE_COMMAND, JOIN_COMMAND, LINK_NEAR_COMMAND, MANAGE_MEMBERS_COMMAND, SIGN_OUT_NEAR_COMMAND, parseUsdToNanoUsd } = memberModule;

const EM_DASH = '—';
const WITHOUT_NEAR = 'Invite without NEAR';
const WITHOUT_KEY_NOW = 'Continue without NEAR';
const PUBLIC_URL = 'https://example.invalid/team.git';
const NO_ORG_NOTICE = 'No NEAR organization linked: spend is not capped at the provider.';

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

// A lead's window: Enable Team Mode through the command (so the session, device key and team.json are the product's own), then the project's
// origin is given a public-looking address, which the bundle must carry. With `near` there is also a fake NEAR with one organization the lead
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
    stub.inputAnswers.push('Invite team', 'Lead Owner', 'lead@example.invalid');
    await run(ENABLE_COMMAND);
    assert.equal(handle.session()?.teamFile.name, 'Invite team', 'Enable started the session');
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    clearUi();
    await work({ fixture, root, storage, secrets, context, handle, canaries, fake, signIns, run });
  } finally {
    await closeWindow({ context, handle: registeredHandle });
    await fake?.close();
    await removeFixture(fixture);
  }
}

// The lead links the team to Team Org / Team workspace through the Link command, then pushes the code branch so a clone sees team.json.
async function linkAndPush(t: Team): Promise<void> {
  stub.quickPickAnswers.push('Team Org', 'Team workspace');
  await t.run(LINK_NEAR_COMMAND);
  gitIn(t.root, ['push', '-q', 'origin', 'main']);
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
  stub.quickPickAnswers.push(person.role, '7 days');
  if (t.handle.session()?.teamFile.near === undefined) stub.quickPickAnswers.push('Skip');
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
const copyWhenOffered = (_text: string, actions: string[]): string | undefined => (actions.includes('Copy') ? 'Copy' : undefined);

// ---- the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: Invite to Team asks its questions, writes member.invited, and shows the bundle once with Copy and nowhere else', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push('Developer', '7 days', 'Skip');
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

    // One modal, with Copy, carrying the bundle in its detail and nothing else carrying it.
    const modals = stub.notifications.flatMap((entry, index) => (stub.notificationOptions[index]?.modal === true ? [{ entry, index }] : []));
    assert.equal(modals.length, 1, 'exactly one modal');
    assert.equal(modals[0]?.entry.message, 'Invite ready for Ana. Send them this invite; it works once and is not shown again.');
    assert.equal(stub.notificationOptions[modals[0]?.index as number]?.detail, bundleText);
    assert.deepEqual(stub.notificationActions[modals[0]?.index as number], ['Copy']);
    assert.equal(stub.notificationOptions.filter((options) => options?.detail === bundleText).length, 1, 'the bundle is shown once');
    assert.equal(everythingShown().includes(bundleText), false, 'not in the channel, the other messages, the inputs or the status bar');
    assert.equal(everythingShown().includes(bundle.code), false, 'the code is nowhere either');

    // The skip path says plainly that there is no provider cap, once.
    assert.equal(stub.notifications.filter((entry) => entry.message === NO_ORG_NOTICE).length, 1);

    // UI review issue 1: the write runs in a progress notification that says what it is doing.
    assert.deepEqual(progressNamed('Inviting Ana'), { title: 'Inviting Ana', cancellable: false, messages: ['Saving the invitation to the team log'] });
  });
});

test('Invite offers the roles and the four lifetimes with seven days first, and Skip or Link when the team has no NEAR organization', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push('Developer', '7 days', 'Skip');
    await t.run(INVITE_COMMAND);
    assert.deepEqual(stub.quickPickRequests[0]?.labels, ['Developer', 'Reviewer', 'Observer', 'Lead']);
    assert.deepEqual([...(stub.quickPickRequests[1]?.labels ?? [])].sort(), ['14 days', '24 hours', '3 days', '7 days']);
    assert.equal(stub.quickPickRequests[1]?.labels[0], '7 days', 'the first item is the one Enter picks');
    assert.deepEqual(stub.quickPickRequests[2]?.labels, ['Link a NEAR organization', 'Skip']);
    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]), ['Name of the person you are inviting', 'Their email address', 'Allocation in US dollars']);
  });
});

test('a lifetime of 24 hours is stored as 86400 seconds', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Bo', 'bo@example.invalid', '0.01');
    stub.quickPickAnswers.push('Observer', '24 hours', 'Skip');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);
    const bundle = parseInviteBundle(stub.clipboardWrites[0] as string);
    const member = t.handle.session()?.state().members.get(bundle.member);
    assert.equal(member?.invite?.ttlSeconds, 86_400);
    assert.equal(member?.allocationNanoUsd, 10_000_000, 'one cent');
  });
});

test('closing the bundle without Copy says the invite can be issued again from Manage Team Members and never repeats it', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
    stub.quickPickAnswers.push('Developer', '7 days', 'Skip');
    await t.run(INVITE_COMMAND);
    assert.equal(stub.clipboardWrites.length, 0);
    const detail = stub.notificationOptions.find((options) => options?.modal === true)?.detail as string;
    assert.ok(detail.startsWith('near-ai-invite-v1.'));
    const later = stub.notifications.filter((_entry, index) => stub.notificationOptions[index]?.modal !== true).map((entry) => entry.message);
    assert.ok(later.some((message) => message.includes('Manage Team Members')), later.join(' | '));
    assert.equal(everythingShown().includes(detail), false);
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
    stub.quickPickAnswers.push('Developer', '7 days', 'Skip');
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
  const stages: Array<{ inputs: string[]; picks: string[] }> = [
    { inputs: [], picks: [] },
    { inputs: ['Ana'], picks: [] },
    { inputs: ['Ana', 'ana@example.invalid'], picks: [] },
    { inputs: ['Ana', 'ana@example.invalid'], picks: ['Developer'] },
    { inputs: ['Ana', 'ana@example.invalid', '5'], picks: ['Developer'] },
    { inputs: ['Ana', 'ana@example.invalid', '5'], picks: ['Developer', '7 days'] }
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
    stub.quickPickAnswers.push('Developer', '7 days', 'Skip');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);
    assert.equal(everythingShown().includes(EM_DASH), false);
  });
});

// ---- Join Team --------------------------------------------------------------------------------------------------------------------------

test('Join with no project open offers Clone repository, runs git.clone with the invite address, and writes nothing', async () => {
  await withTeam(async (t) => {
    const bundleText = await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    const j = await openJoiner(t, { folder: false });
    stub.inputAnswers.push(bundleText);
    stub.setMessageResponder((_text, actions) => (actions.includes('Clone repository') ? 'Clone repository' : undefined));
    await j.run(JOIN_COMMAND);

    assert.equal(stub.inputRequests[0]?.password, true, 'the pasted invite is masked');
    assert.deepEqual(stub.notifications.map((entry) => entry.message), [
      'This invite is for a project that is not open. Clone it, then run NEAR AI: Join Team in the new window and paste the invite again.'
    ]);
    assert.deepEqual(stub.notificationActions[0], ['Clone repository']);
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
    assert.ok(stub.notifications.some((entry) => entry.message === 'You joined Invite team as an observer. Your lead confirms you and sends your team key.'), stub.notifications.map((entry) => entry.message).join(' | '));
    const memberId = parseInviteBundle(bundleText).member;
    assert.equal(j.handle.session()?.memberId(), memberId, 'the restarted session signs with the new device key');
    // UI review issue 1: Join says each step.
    assert.deepEqual(progressNamed('Joining Invite team')?.messages, ['Reading the team log and checking your invitation', 'Making the keys for this computer', 'Saving your join to the team log']);
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
    assert.ok(stub.notifications.some((entry) => entry.message.includes('NEAR organization')), stub.notifications.map((entry) => entry.message).join(' | '));
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

// ---- Link Team to NEAR Organization -----------------------------------------------------------------------------------------------------

test('Link signs in, lists only organizations the lead owns or administers, commits team.json only, and pushes only when asked', async () => {
  await withTeam(async (t) => {
    stub.quickPickAnswers.push('Team Org', 'Second workspace');
    const remoteBefore = gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']);
    await t.run(LINK_NEAR_COMMAND);

    assert.equal(t.signIns.count, 1, 'signed in once');
    assert.deepEqual(stub.quickPickRequests[0]?.labels, ['Team Org'], 'the organization where the lead is only a member is not offered');
    assert.deepEqual(stub.quickPickRequests[1]?.labels, ['Team workspace', 'Second workspace']);
    assert.deepEqual((await readTeamFile(t.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-2' });
    assert.equal(gitIn(t.root, ['log', '-1', '--format=%s']), LINK_COMMIT_MESSAGE);
    assert.equal(gitIn(t.root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);
    assert.equal(gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']), remoteBefore, 'nothing was pushed');
    assert.ok(t.secrets.values.has(nearSessionSecretName((await readTeamFile(t.root))?.teamId as string)), 'the sign-in is kept for this team');
    const offer = stub.notifications.findIndex((entry) => entry.message.startsWith('Linked Invite team to Team Org'));
    assert.ok(offer >= 0, stub.notifications.map((entry) => entry.message).join(' | '));
    assert.deepEqual(stub.notificationActions[offer], ['Push']);
    assert.equal(t.handle.session()?.teamFile.near?.workspaceId, 'ws-2', 'the session was restarted on the new team.json');
    // UI review issue 1: reading the lists can be stopped; the write cannot.
    assert.equal(progressNamed('Reading your NEAR organizations')?.cancellable, true);
    assert.deepEqual(progressNamed('Linking Invite team to Team Org'), { title: 'Linking Invite team to Team Org', cancellable: false, messages: ['Writing the link to team.json and committing it'] });
    assert.equal(everythingShown().includes(t.signIns.tokens?.refreshToken as string), false);
  }, { near: true });

  await withTeam(async (t) => {
    stub.quickPickAnswers.push('Team Org', 'Team workspace');
    stub.setMessageResponder((_text, actions) => (actions.includes('Push') ? 'Push' : undefined));
    await t.run(LINK_NEAR_COMMAND);
    assert.equal(gitIn(t.fixture.remote, ['rev-parse', 'refs/heads/main']), gitIn(t.root, ['rev-parse', 'HEAD']), 'choosing Push pushed the branch');
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

// ---- Sign Out of NEAR (Team) ------------------------------------------------------------------------------------------------------------

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
    assert.deepEqual(stub.notifications.map((entry) => entry.message), ['Signed out of NEAR for Invite team.']);
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
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : actions.includes('Copy') ? 'Copy' : undefined));
    const before = t.signIns.count;
    await t.run(INVITE_COMMAND);
    assert.equal(t.signIns.count, before + 1, 'the lead was asked to sign in');
    assert.notEqual(t.fake?.emailedToken('lee@example.invalid'), undefined, 'the NEAR organization invitation was sent');
    assert.equal(stub.clipboardWrites.length, 1);
  }, { near: true });
});

test('inviting in a linked team whose NEAR link is not pushed yet warns that a teammate who clones now would not see it', async () => {
  await withTeam(async (t) => {
    stub.quickPickAnswers.push('Team Org', 'Team workspace');
    await t.run(LINK_NEAR_COMMAND);
    clearUi();
    await inviteBundle(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer' });
    const warning = stub.notifications.findIndex((entry) => entry.level === 'warn' && entry.message.includes('not pushed'));
    assert.ok(warning >= 0, stub.notifications.map((entry) => entry.message).join(' | '));
    assert.deepEqual(stub.notificationActions[warning], ['Push']);
    clearUi();
    gitIn(t.root, ['push', '-q', 'origin', 'main']);
    await inviteBundle(t, { name: 'Eve', email: 'eve@example.invalid', role: 'Developer' });
    assert.equal(stub.notifications.some((entry) => entry.message.includes('not pushed')), false, 'no warning once the link is pushed');
  }, { near: true });
});

test('choosing Link a NEAR organization while inviting links the team first and the bundle carries the link', async () => {
  await withTeam(async (t) => {
    stub.inputAnswers.push('Dana', 'dana@example.invalid', '5');
    stub.quickPickAnswers.push('Developer', '7 days', 'Link a NEAR organization', 'Team Org', 'Team workspace');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(INVITE_COMMAND);
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
const shownMessages = (): string[] => stub.notifications.map((entry) => entry.message);
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
      'NEAR: signed in as lead',
      'Lead Owner, owner',
      'Dana D, developer, waiting for confirmation',
      'Invitation for Dana D, developer, used',
      'Invitation for Eve, reviewer, pending',
      'Invitation for Fay, observer, pending',
      'Repository access for Dana D'
    ]);
    assert.ok(parseInviteBundle(fay).member.length > 0);
    assert.equal(everythingShown().includes(EM_DASH), false);
  }, { near: true });
});

test('Manage Team Members in a team without NEAR starts with the plain no-organization line and never talks about a cap', async () => {
  await withTeam(async (t) => {
    await joinMember(t, { name: 'Dana', email: 'dana@example.invalid', role: 'Developer', displayName: 'Dana D' });
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.equal(lastList()[0], NO_ORG_NOTICE);
    stub.quickPickAnswers.push('Dana D, developer, waiting for confirmation', 'Confirm');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.startsWith('Dana D is now a developer.')), shownMessages().join(' | '));
    assert.equal(shownMessages().some((message) => /spend cap|capped|limit/i.test(message.replace(NO_ORG_NOTICE, ''))), false, 'no cap is claimed without a NEAR organization');
    assert.equal(t.handle.session()?.state().members.get(await readMemberId(t, 'Dana D'))?.role, 'developer');
  });
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
      messages: ['Saving the confirmation to the team log', 'Creating the key with its spend cap', 'Sealing the key to their computer', 'Saving the key delivery to the team log']
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
      title: 'Removing Dana D from Invite team', cancellable: true, messages: ['Setting the NEAR key limit to 0', 'Saving the removal to the team log', 'Revoking the NEAR key']
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
    stub.setProgressCancel((_title, message) => message === 'Setting the NEAR key limit to 0');
    stub.quickPickAnswers.push('Dana D, developer', 'Remove');
    stub.setMessageResponder((_text, actions) => (actions.includes('Remove') ? 'Remove' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.notEqual(t.handle.session()?.state().members.get(id)?.removedEvent, undefined, 'the removal was written');
    assert.equal(t.fake?.key(keyId)?.spendLimitNanoUsd, 0, 'the key is capped');
    assert.equal(t.fake?.key(keyId)?.revoked, false, 'the revoke waits on the cleanup list');
    assert.ok(shownMessages().some((message) => message.includes('You stopped before the last NEAR steps')), shownMessages().join(' | '));
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
    assert.ok(warning.message.includes('set its limit to 0 in the NEAR console'), 'the manual step is shown as written');
    assert.notEqual(t.handle.session()?.state().members.get(id)?.removedEvent, undefined, 'the removal still happened');
  }, { near: true });
});

test('Cancel ends a pending invitation and Re-issue replaces it with a new bundle shown once with Copy', async () => {
  await withTeam(async (t) => {
    const eve = await inviteBundle(t, { name: 'Eve', email: 'eve@example.invalid', role: 'Reviewer' });
    const eveId = parseInviteBundle(eve).member;
    clearUi();
    stub.quickPickAnswers.push('Invitation for Eve, reviewer, pending', 'Re-issue', '3 days');
    stub.setMessageResponder(copyWhenOffered);
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Cancel', 'Re-issue']);
    assert.equal(stub.clipboardWrites.length, 1);
    const fresh = parseInviteBundle(stub.clipboardWrites[0] as string);
    assert.notEqual(fresh.member, eveId, 'a new invitation');
    const state = t.handle.session()?.state();
    assert.notEqual(state?.members.get(eveId)?.removedEvent, undefined, 'the old invitation stopped working');
    assert.equal(state?.members.get(fresh.member)?.invite?.ttlSeconds, 259_200);
    assert.equal(everythingShown().includes(stub.clipboardWrites[0] as string), false);
    clearUi();

    stub.setMessageResponder(undefined);
    stub.quickPickAnswers.push('Invitation for Eve, reviewer, pending', 'Cancel');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().includes('The invitation for Eve was cancelled.'), shownMessages().join(' | '));
    assert.notEqual(t.handle.session()?.state().members.get(fresh.member)?.removedEvent, undefined);
    assert.deepEqual(progressNamed('Cancelling the invitation for Eve')?.messages, ['Saving the removal to the team log']);
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

test('Retry sends a NEAR invitation left on the cleanup list after asking the lead to sign in, Mark done is only for repository access, and an unknown email is explained', async () => {
  await withTeam(async (t) => {
    await linkAndPush(t);
    await t.run(SIGN_OUT_NEAR_COMMAND);
    t.signIns.tokens = t.fake?.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    clearUi();
    // A lead invited without NEAR leaves the NEAR invitation on the cleanup list.
    stub.inputAnswers.push('Lee', 'lee@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy') ? 'Copy' : undefined));
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
    assert.ok(lastList().includes('NEAR cleanup: Send the NEAR invitation for Lee'), lastList().join(' | '));
    assert.ok(lastList().includes('Repository access for Lee'));
    clearUi();

    stub.quickPickAnswers.push('NEAR cleanup: Send the NEAR invitation for Lee', 'Retry');
    stub.setMessageResponder((_text, actions) => (actions.includes('Sign in') ? 'Sign in' : undefined));
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.deepEqual(manageActions(), ['Retry']);
    assert.notEqual(t.fake?.emailedToken('lee@example.invalid'), undefined, 'the invitation reached NEAR');
    assert.equal((await cleanup.list()).find((item) => item.memberName === 'Lee' && item.step === 'send-invitation')?.status, 'done');
    clearUi();

    // CR-02: someone the team list does not have is never invited; the item is closed instead.
    stub.quickPickAnswers.push('NEAR cleanup: Send the NEAR invitation for Zed', 'Retry');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.includes('item was closed')), shownMessages().join(' | '));
    assert.equal((await cleanup.list()).find((item) => item.memberName === 'Zed')?.status, 'done');
    clearUi();

    // A lead invitation made on another computer has no email here, which is explained and changes nothing.
    await t.run(SIGN_OUT_NEAR_COMMAND);
    clearUi();
    stub.inputAnswers.push('Uma', 'uma@example.invalid', '5');
    stub.quickPickAnswers.push('Lead', '7 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy') ? 'Copy' : undefined));
    await t.run(INVITE_COMMAND);
    const umaId = parseInviteBundle(stub.clipboardWrites[0] as string).member;
    const invitesFile = path.join(teamStorageDir(t.storage, teamId), INVITE_FILE);
    const invites = JSON.parse(await fs.readFile(invitesFile, 'utf8')) as { version: number; invites: Array<{ memberId: string }> };
    await fs.writeFile(invitesFile, JSON.stringify({ ...invites, invites: invites.invites.filter((entry) => entry.memberId !== umaId) }), 'utf8');
    clearUi();
    stub.quickPickAnswers.push('NEAR cleanup: Send the NEAR invitation for Uma', 'Retry');
    await t.run(MANAGE_MEMBERS_COMMAND);
    assert.ok(shownMessages().some((message) => message.includes('only known on the computer that sent the invitation')), shownMessages().join(' | '));
    assert.equal(t.fake?.emailedToken('uma@example.invalid'), undefined);
    clearUi();

    stub.quickPickAnswers.push('Repository access for Lee', 'Mark done');
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
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy') ? 'Copy' : undefined));
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
    stub.quickPickAnswers.push('NEAR cleanup: Send the NEAR invitation for Lee', 'Retry');
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
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy') ? 'Copy' : undefined));
    await t.run(INVITE_COMMAND);
    const kim = parseInviteBundle(stub.clipboardWrites[0] as string).member;
    clearUi();
    stub.quickPickAnswers.push('Invitation for Kim, lead, pending', 'Re-issue', '3 days');
    stub.setMessageResponder((_text, actions) => (actions.includes(WITHOUT_NEAR) ? WITHOUT_NEAR : actions.includes('Copy') ? 'Copy' : undefined));
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
