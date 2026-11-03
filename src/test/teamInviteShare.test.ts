// Invite shares the team setup first (Phase 61 plan 20, G-61-2 and G-61-3), driven through the vscode stub on real git. An invite is only made
// once the team setup is online on the team's main version, with one plain confirmation ('Share and continue') when it is not; when teammates
// cannot reach the project, or the online home cannot be reached, the person is told before the questions and nothing is written. Every prompt
// goes through the prompts module, so under the extension-host test variable a script answers them all and VS Code sees none.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { parseInviteBundle } from '../team/inviteBundle';
import { planShare, shareTeamSetup } from '../team/projectHome';
import { TEAM_FILE_REL, readTeamFile } from '../team/teamFile';
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
const shareModule = require('../services/team/shareFlow') as typeof import('../services/team/shareFlow');
const promptsModule = require('../services/team/teamPrompts') as typeof import('../services/team/teamPrompts');
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, LOCAL_ONLY_TEXT, registerTeamMode } = commandsModule;
const { INVITE_COMMAND, INVITE_NEEDS_SHARE_TEXT, LINK_EXPLANATION, LINK_NOW_CHOICE, NOT_NOW_CHOICE } = memberModule;
const { SHARE_TEXT } = shareModule;
const { promptTap } = promptsModule;

const PUBLIC_URL = 'https://example.invalid/team.git';
const EM_DASH = '—';

interface Lead {
  fixture: TeamFixture;
  root: string;
  context: FakeContext;
  handle: ReturnType<typeof registerTeamMode>;
  fake: FakeNear | undefined;
  run(command: string, ...args: unknown[]): Promise<void>;
}

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
  stub.setMessageResponder(undefined);
  stub.outputChannels.forEach((channel) => { channel.lines.length = 0; });
}

// The lead turns Team Mode on in clone a through the Enable command, with origin at a public-looking address mapped back to the bare remote.
// The team setup is NOT shared: Enable only commits it on this computer. With `near` a fake NEAR has one organization the lead owns.
async function withLead(work: (lead: Lead) => Promise<void>, options: { near?: boolean } = {}): Promise<void> {
  stub.outputChannels.length = 0;
  stub.commands.clear();
  clearUi();
  const fixture = await createTeamFixture({ clones: ['a'], initialised: true });
  const root = fixture.clones['a'] as string;
  const context = createFakeContext(fixture.storageDir('a'), new MemorySecrets());
  const fake = options.near === true ? await startFakeNear() : undefined;
  let handle: ReturnType<typeof registerTeamMode> | undefined;
  try {
    let tokens: { accessToken: string; refreshToken: string } | undefined;
    if (fake !== undefined) {
      tokens = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
      fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
      fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    }
    stub.setWorkspaceFolders([root]);
    handle = registerTeamMode(context as never, fake === undefined ? {} : { nearBaseUrl: fake.baseUrl, signIn: async () => tokens });
    assert.equal(await handle.ready, 'solo');
    const own = new Map(stub.commands);
    const run = async (command: string, ...args: unknown[]): Promise<void> => {
      const handler = own.get(command);
      assert.ok(handler !== undefined, `${command} is registered`);
      await handler(...args);
    };
    gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.inputAnswers.push('Share team', 'Lead Owner', 'lead@example.invalid');
    await run(ENABLE_COMMAND);
    assert.equal(handle.session()?.teamFile.name, 'Share team', 'Enable started the session');
    clearUi();
    await work({ fixture, root, context, handle, fake, run });
  } finally {
    await handle?.session()?.sync();
    for (const subscription of context.subscriptions) subscription.dispose();
    await fake?.close();
    await fixture.cleanup();
  }
}

// The team setup put online with the core share, as Share Team Setup would.
async function shareNow(lead: Lead): Promise<void> {
  const teamFile = await readTeamFile(lead.root);
  assert.ok(teamFile !== undefined);
  const plan = await planShare({ projectRoot: lead.root, teamFile, branch: 'main' });
  const shared = await shareTeamSetup({ projectRoot: lead.root, teamFile, branch: 'main', plan });
  assert.equal(shared.ok, true, JSON.stringify(shared));
}

const remoteMain = (lead: Lead): string => gitIn(lead.fixture.remote, ['rev-parse', 'refs/heads/main']);
const remoteTeamJson = (lead: Lead): string => gitIn(lead.fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`]);
const localTeamJson = (lead: Lead): string => readFileSync(path.join(lead.root, TEAM_FILE_REL), 'utf8').trim();
const invitedCount = (lead: Lead): number => [...(lead.handle.session()?.state().members.values() ?? [])].filter((member) => member.status === 'invited').length;
const outputLines = (): string[] => stub.outputChannels.flatMap((channel) => channel.lines);
const modalIndexes = (): number[] => stub.notifications.flatMap((_entry, index) => (stub.notificationOptions[index]?.modal === true ? [index] : []));
const shownText = (): string => JSON.stringify({
  notifications: stub.notifications, options: stub.notificationOptions, actions: stub.notificationActions, picks: stub.quickPickRequests,
  inputs: stub.inputRequests.map((request) => [request.title, request.prompt, request.value, request.placeHolder]), progress: stub.progress
});

// The invite answers: the organization choice first when the team is not linked, then the questions.
function answerQuestions(options: { linked: boolean }): void {
  if (!options.linked) stub.quickPickAnswers.push(NOT_NOW_CHOICE);
  stub.quickPickAnswers.push('Developer', '7 days');
  stub.inputAnswers.push('Ana', 'ana@example.invalid', '5');
}

// ---- the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: inviting with the team setup not online asks once to share it first, shares exactly team.json, then asks the questions and shows the invite', async () => {
  await withLead(async (lead) => {
    const before = remoteMain(lead);
    assert.throws(() => remoteTeamJson(lead), 'the team setup is not online yet');
    answerQuestions({ linked: false });
    let inputsWhenAsked = -1;
    stub.setMessageResponder((text, actions) => {
      if (actions.includes(SHARE_TEXT.shareAndContinue)) {
        inputsWhenAsked = stub.inputRequests.length;
        return SHARE_TEXT.shareAndContinue;
      }
      return actions.includes('Copy invite') ? 'Copy invite' : undefined;
    });
    await lead.run(INVITE_COMMAND);

    const modals = modalIndexes();
    assert.equal(stub.notifications[modals[0] as number]?.message, SHARE_TEXT.inviteQuestion, 'the first modal is the one share confirmation');
    assert.deepEqual(stub.notificationActions[modals[0] as number], [SHARE_TEXT.shareAndContinue]);
    assert.equal(stub.notifications.filter((entry) => entry.message === SHARE_TEXT.inviteQuestion).length, 1, 'asked once');
    assert.equal(inputsWhenAsked, 0, 'the share was asked before any question');
    assert.deepEqual(stub.quickPickRequests[0]?.labels, [LINK_NOW_CHOICE, NOT_NOW_CHOICE], 'the organization choice comes first');

    assert.notEqual(remoteMain(lead), before, 'the online main moved');
    assert.equal(remoteTeamJson(lead), localTeamJson(lead), 'the online main holds this computer\'s team.json');
    assert.ok(stub.notifications.some((entry) => entry.message === SHARE_TEXT.shared), 'the person reads that the setup is online');

    assert.deepEqual(stub.inputRequests.map((request) => request.prompt?.split('.')[0]), ['Name of the person you are inviting', 'Their email address', 'Allocation in US dollars']);
    assert.equal(invitedCount(lead), 1, 'member.invited is in the log');
    assert.deepEqual(stub.progress.find((entry) => entry.title === 'Inviting Ana')?.messages, ['Saving the invitation to the team record']);
    assert.equal(stub.clipboardWrites.length, 1);
    const bundleText = stub.clipboardWrites[0] as string;
    const bundle = parseInviteBundle(bundleText);
    assert.equal(bundle.repo, PUBLIC_URL);
    const last = modals[modals.length - 1] as number;
    assert.equal(stub.notifications[last]?.message, 'Invite ready for Ana', 'the bundle modal comes last');
    assert.deepEqual(stub.notificationActions[last], ['Copy invite']);
    assert.ok(stub.notificationOptions[last]?.detail?.startsWith(`${bundleText}\n\n`), 'the invite, a blank line, then how to send it');
    assert.equal(stub.notificationOptions.filter((options) => options?.detail?.includes(bundleText) === true).length, 1, 'the bundle is shown once');
    const elsewhere = JSON.stringify({ lines: outputLines(), notifications: stub.notifications, picks: stub.quickPickRequests, inputs: stub.inputRequests, progress: stub.progress });
    assert.equal(elsewhere.includes(bundleText), false, 'the bundle is in no other message, prompt or channel line');
    assert.equal(elsewhere.includes(bundle.code), false, 'nor is its code');
    assert.equal(shownText().includes(EM_DASH), false);
  });
});

test('declining the share asks no question, makes no invite, leaves the online home unchanged and says why', async () => {
  await withLead(async (lead) => {
    const before = remoteMain(lead);
    answerQuestions({ linked: false });
    await lead.run(INVITE_COMMAND);
    assert.deepEqual(stub.notifications.filter((_entry, index) => stub.notificationOptions[index]?.modal === true).map((entry) => entry.message), [SHARE_TEXT.inviteQuestion]);
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(stub.quickPickRequests.length, 1, 'only the organization choice');
    assert.equal(invitedCount(lead), 0, 'no member.invited');
    assert.equal(remoteMain(lead), before, 'nothing was shared');
    assert.equal(stub.clipboardWrites.length, 0);
    assert.ok(stub.notifications.some((entry) => entry.message === INVITE_NEEDS_SHARE_TEXT), stub.notifications.map((entry) => entry.message).join(' | '));
    assert.match(INVITE_NEEDS_SHARE_TEXT, /No invite was made/);
    assert.match(INVITE_NEEDS_SHARE_TEXT, /online/);
  });
});

test('a project kept only on this computer is explained in a modal before any question, with what to do, and nothing is written', async () => {
  await withLead(async (lead) => {
    gitIn(lead.root, ['remote', 'set-url', 'origin', lead.fixture.remote]);
    const before = remoteMain(lead);
    const head = gitIn(lead.root, ['rev-parse', 'HEAD']);
    answerQuestions({ linked: false });
    await lead.run(INVITE_COMMAND);
    const modals = modalIndexes();
    assert.equal(modals.length, 1, stub.notifications.map((entry) => entry.message).join(' | '));
    assert.equal(stub.notifications[modals[0] as number]?.message, LOCAL_ONLY_TEXT, 'the reason is a modal, not only a Show details notification');
    assert.match(stub.notificationOptions[modals[0] as number]?.detail ?? '', /online/, 'the modal says what to do');
    assert.equal(stub.quickPickRequests.length, 0, 'not even the organization choice was asked');
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(invitedCount(lead), 0);
    assert.equal(remoteMain(lead), before);
    assert.equal(gitIn(lead.root, ['rev-parse', 'HEAD']), head, 'nothing changed on this computer either');
    assert.equal(stub.notifications.some((entry) => entry.message.includes(lead.fixture.remote)), false, 'the folder is not named to the person');
  });
});

test('an online home that cannot be reached is said plainly before the questions; nothing is written and no address is shown', async () => {
  await withLead(async (lead) => {
    gitIn(lead.root, ['config', '--remove-section', `url.${lead.fixture.remote}`]);
    gitIn(lead.root, ['config', `url.${path.join(lead.fixture.root, 'missing.git')}.insteadOf`, PUBLIC_URL]);
    const before = remoteMain(lead);
    answerQuestions({ linked: false });
    await lead.run(INVITE_COMMAND);
    assert.ok(stub.notifications.some((entry) => entry.message === SHARE_TEXT.offline), stub.notifications.map((entry) => entry.message).join(' | '));
    assert.equal(stub.inputRequests.length, 0, 'no question was asked');
    assert.equal(stub.notifications.some((entry) => entry.message === SHARE_TEXT.inviteQuestion), false, 'no share confirmation');
    assert.equal(invitedCount(lead), 0);
    assert.equal(remoteMain(lead), before);
    assert.equal(stub.clipboardWrites.length, 0);
    assert.equal(JSON.stringify(stub.notifications).includes(PUBLIC_URL), false);
    assert.equal(JSON.stringify(stub.notifications).includes('missing.git'), false);
  });
});

test('with the team setup already online there is no share question: the organization choice, the questions and the invite, as before', async () => {
  await withLead(async (lead) => {
    await shareNow(lead);
    const before = remoteMain(lead);
    answerQuestions({ linked: false });
    stub.setMessageResponder((_text, actions) => (actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await lead.run(INVITE_COMMAND);
    assert.equal(stub.notifications.some((entry) => entry.message === SHARE_TEXT.inviteQuestion || entry.message === SHARE_TEXT.already), false, 'nothing about sharing');
    assert.deepEqual(modalIndexes().map((index) => stub.notifications[index]?.message), ['Invite ready for Ana']);
    assert.equal(stub.clipboardWrites.length, 1);
    assert.equal(invitedCount(lead), 1);
    assert.equal(remoteMain(lead), before, 'nothing new was shared');
  });
});

test('choosing Link now while inviting links first, and the one share confirmation puts the linked team.json online; the bundle carries the link', async () => {
  await withLead(async (lead) => {
    stub.quickPickAnswers.push(LINK_NOW_CHOICE, 'Team Org', 'Team workspace', 'Developer', '7 days');
    stub.inputAnswers.push('Dana', 'dana@example.invalid', '5');
    stub.setMessageResponder((_text, actions) => (actions.includes(SHARE_TEXT.shareAndContinue) ? SHARE_TEXT.shareAndContinue : actions.includes('Copy invite') ? 'Copy invite' : undefined));
    await lead.run(INVITE_COMMAND);
    assert.deepEqual([stub.quickPickRequests[0]?.placeHolder, stub.quickPickRequests[0]?.labels], [LINK_EXPLANATION, [LINK_NOW_CHOICE, NOT_NOW_CHOICE]], 'the organization choice comes first');
    assert.deepEqual((await readTeamFile(lead.root))?.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    assert.equal(stub.notifications.filter((entry) => entry.message === SHARE_TEXT.inviteQuestion).length, 1, 'one share confirmation');
    assert.equal(stub.notificationActions.some((actions) => actions.includes('Share with my team')), false, 'the link flow asked no share question of its own');
    assert.equal(remoteTeamJson(lead), localTeamJson(lead), 'the online team.json is the linked one');
    assert.deepEqual(JSON.parse(remoteTeamJson(lead)).near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    assert.equal(stub.clipboardWrites.length, 1);
    assert.deepEqual(parseInviteBundle(stub.clipboardWrites[0] as string).near, { organizationId: 'org-1', workspaceId: 'ws-1' });
    assert.equal(invitedCount(lead), 1);
  }, { near: true });
});

test('under the extension-host test variable a script answers every invite prompt, each is recorded in order, and VS Code is shown none', async () => {
  await withLead(async (lead) => {
    const previous = process.env.NEAR_AI_E2E;
    process.env.NEAR_AI_E2E = '1';
    promptTap.shown.length = 0;
    promptTap.script = [
      { match: 'Not now', answer: NOT_NOW_CHOICE },
      { match: SHARE_TEXT.shareAndContinue, answer: SHARE_TEXT.shareAndContinue },
      { match: 'Name of the person', answer: 'Ana' },
      { match: 'Their email address', answer: 'ana@example.invalid' },
      { match: 'Developer', answer: 'Developer' },
      { match: 'Allocation in US dollars', answer: '5' },
      { match: '7 days', answer: '7 days' },
      { match: 'Invite ready', answer: 'Copy invite' }
    ];
    try {
      await lead.run(INVITE_COMMAND);
      assert.deepEqual(promptTap.script, [], 'every step was used');
      assert.equal(promptTap.shown.some((record) => record.unanswered === true), false, JSON.stringify(promptTap.shown));
      const asked = promptTap.shown.filter((record) => record.kind !== 'message' || record.modal);
      assert.deepEqual(asked.map((record) => [record.kind, record.answer]), [
        ['pick', NOT_NOW_CHOICE], ['message', SHARE_TEXT.shareAndContinue], ['input', 'Ana'], ['input', 'ana@example.invalid'], ['pick', 'Developer'],
        ['input', '5'], ['pick', '7 days'], ['message', 'Copy invite']
      ]);
      assert.equal(asked[1]?.text, SHARE_TEXT.inviteQuestion);
      const bundleText = stub.clipboardWrites[0] as string;
      assert.ok(bundleText.startsWith('near-ai-invite-v1.'));
      assert.equal(promptTap.shown.filter((record) => JSON.stringify(record).includes(bundleText)).length, 1, 'only the bundle modal record holds the invite');
      assert.equal(promptTap.shown.filter((record) => record.detail?.startsWith(`${bundleText}\n\n`) === true).length, 1, 'the bundle modal detail is the invite, a blank line, then how to send it');
      assert.equal(stub.inputRequests.length + stub.quickPickRequests.length + stub.notifications.length, 0, 'VS Code was shown nothing');
      assert.equal(invitedCount(lead), 1);
      assert.equal(remoteTeamJson(lead), localTeamJson(lead));
    } finally {
      if (previous === undefined) delete process.env.NEAR_AI_E2E;
      else process.env.NEAR_AI_E2E = previous;
      promptTap.script = undefined;
      promptTap.shown.length = 0;
    }
  });
});

test('under the extension-host test variable, closing the invite asks once more, and Copy invite there copies it; only the first record holds the invite', async () => {
  await withLead(async (lead) => {
    await shareNow(lead);
    const previous = process.env.NEAR_AI_E2E;
    process.env.NEAR_AI_E2E = '1';
    promptTap.shown.length = 0;
    promptTap.script = [
      { match: 'Not now', answer: NOT_NOW_CHOICE },
      { match: 'Name of the person', answer: 'Ana' },
      { match: 'Their email address', answer: 'ana@example.invalid' },
      { match: 'Developer', answer: 'Developer' },
      { match: 'Allocation in US dollars', answer: '5' },
      { match: '7 days', answer: '7 days' },
      { match: 'Invite ready', answer: undefined },
      { match: 'Close without copying', answer: 'Copy invite' }
    ];
    try {
      await lead.run(INVITE_COMMAND);
      assert.deepEqual(promptTap.script, [], 'every step was used');
      const modals = promptTap.shown.filter((record) => record.kind === 'message' && record.modal);
      assert.deepEqual(modals.map((record) => [record.text, record.choices, record.answer]), [
        ['Invite ready for Ana', ['Copy invite'], undefined],
        ['Close without copying? The invite is not shown again.', ['Copy invite', 'Close'], 'Copy invite']
      ]);
      assert.equal(stub.clipboardWrites.length, 1, 'copied once');
      const bundleText = stub.clipboardWrites[0] as string;
      const code = parseInviteBundle(bundleText).code;
      assert.equal(promptTap.shown.filter((record) => JSON.stringify(record).includes(bundleText)).length, 1, 'only the first modal record holds the invite');
      assert.equal(promptTap.shown.filter((record) => JSON.stringify(record).includes(code)).length, 0, 'its code is in no record as plain text (the invite carries it encoded)');
      assert.ok(promptTap.shown.some((record) => record.text === 'Invite for Ana copied. Send it to them in a private message.'));
      assert.equal(outputLines().some((line) => line.includes(bundleText) || line.includes(code)), false, 'not in the channel');
      assert.equal(stub.inputRequests.length + stub.quickPickRequests.length + stub.notifications.length, 0, 'VS Code was shown nothing');
    } finally {
      if (previous === undefined) delete process.env.NEAR_AI_E2E;
      else process.env.NEAR_AI_E2E = previous;
      promptTap.script = undefined;
      promptTap.shown.length = 0;
    }
  });
});
