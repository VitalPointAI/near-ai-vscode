// The membership commands (Phase 61 plan 13) driven through the vscode stub on real git: Invite, Join, Manage Team Members, Link Team to NEAR
// Organization and Sign Out of NEAR (Team). The commands are thin adapters, so these tests check what the person sees and what lands in the
// log, the clipboard, SecretStorage and the output channel. Secret-shaped values (invite codes, API keys, refresh tokens) are built at run
// time or read back from the code under test, never written as literals. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createDeviceIdentity, deviceKeySecretName, sealKeySecretName } from '../team/identity';
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
const { INVITE_COMMAND, JOIN_COMMAND, LINK_NEAR_COMMAND, SIGN_OUT_NEAR_COMMAND, parseUsdToNanoUsd } = memberModule;

const EM_DASH = '—';
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
  stub.outputChannels.forEach((channel) => { channel.lines.length = 0; });
}

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
    const run = async (command: string, ...args: unknown[]): Promise<void> => {
      const handler = stub.commands.get(command);
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
  const run = async (command: string, ...args: unknown[]): Promise<void> => {
    const handler = stub.commands.get(command);
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
  assert.equal(stub.clipboardWrites.length, before + 1, 'the bundle was copied');
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
