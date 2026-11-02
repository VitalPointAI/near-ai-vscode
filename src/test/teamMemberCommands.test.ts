// The membership commands (Phase 61 plan 13) driven through the vscode stub on real git: Invite, Join, Manage Team Members, Link Team to NEAR
// Organization and Sign Out of NEAR (Team). The commands are thin adapters, so these tests check what the person sees and what lands in the
// log, the clipboard, SecretStorage and the output channel. Secret-shaped values (invite codes, API keys, refresh tokens) are built at run
// time or read back from the code under test, never written as literals. Team modules load lazily, as in the product.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { parseInviteBundle } from '../team/inviteBundle';
import { INVITE_FILE } from '../team/invite';
import { teamStorageDir } from '../team/teamFile';
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
const { INVITE_COMMAND, parseUsdToNanoUsd } = memberModule;

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
  run(command: string, ...args: unknown[]): Promise<void>;
}

// A lead's window: Enable Team Mode through the command (so the session, device key and team.json are the product's own), then the project's
// origin is given a public-looking address, which the bundle must carry.
async function withTeam(work: (team: Team) => Promise<void>): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a', 'b'], initialised: true });
  const root = fixture.clones['a'] as string;
  const secrets = new MemorySecrets();
  const canaries = makeCanaries();
  const storage = fixture.storageDir('a');
  const context = createFakeContext(storage, secrets);
  try {
    stub.setWorkspaceFolders([root]);
    const handle = registerTeamMode(context as never);
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
    await work({ fixture, root, storage, secrets, context, handle, canaries, run });
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await fixture.cleanup();
  }
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
