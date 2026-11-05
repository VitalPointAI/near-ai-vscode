// The 0.6.4 re-test (owner, 2026-11-05); the first two tests are RED. The sidebar's Connect screen gives way to the chat only when the page gets a fresh profile-status
// (media/chat/readiness.js); the host sends one on load and when the page asks with refresh-status. 61-30 made the Team section host ask once when a
// team key a lead delivered is installed. These tests drive the real commands on real git through the vscode stub with the Team section host
// attached to a recorded page, and never call host.refresh() themselves after the action under test: what the page gets is what it gets by itself.
// - debug session join-own-key-connect-stuck (bob, step 5): Join a team without an organization with Paste your own key installs a working,
//   selected profile, but the page is never asked for a fresh profile status, so the Connect screen stays. The own key is also stored as the team
//   key profile ("<team> (team key)", profile-team-*), not as the person's own profile.
// - debug session ask-join-connect-no-refresh (carol, step 9): the last test, GREEN on purpose: after the automatic join the host posts the
//   no-organization Connect status by itself, so that layer is ruled out (the cause is in a layer this stub does not have; see the session).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as sectionText from '../domain/team/teamSectionText';
import { isTeamProfileId } from '../services/profileIndex';
import { pushCodeBranch } from '../team/enable';
import { planShare, shareTeamSetup } from '../team/projectHome';
import { readTeamFile } from '../team/teamFile';
import { activeProfileOf, closeRig, createRig, enable, invite, rootOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
test.after(() => { uninstall(); });
const { ENABLE_COMMAND, registerTeamMode } = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const { JOIN_COMMAND, JOIN_TEXT, MANAGE_MEMBERS_COMMAND } = require('../services/team/memberCommands') as typeof import('../services/team/memberCommands');
const { createTeamSectionHost } = require('../services/team/teamSectionHost') as typeof import('../services/team/teamSectionHost');

const PUBLIC_URL = 'https://example.invalid/team.git';
const REFRESH_STATUS = { type: 'host-request', payload: { type: 'refresh-status' } };

function clearUi(): void {
  for (const list of [stub.outputChannels, stub.notifications, stub.notificationActions, stub.notificationOptions, stub.configUpdates, stub.inputAnswers, stub.inputRequests,
    stub.messageAnswers, stub.quickPickAnswers, stub.quickPickRequests, stub.clipboardWrites, stub.externalCommands, stub.progress]) (list as unknown[]).length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
}

type Webview = Parameters<ReturnType<typeof createTeamSectionHost>['attach']>[0];
function page(): { webview: Webview; record: RecordedWebview } {
  const made = stub.createWebviewView();
  return { webview: (made.view as { webview: Webview }).webview, record: made.record };
}

const refreshRequests = (record: RecordedWebview): number => record.posted.filter((message) => JSON.stringify(message) === JSON.stringify(REFRESH_STATUS)).length;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

// The owner turns Team Mode on in clone a (no organization), publishes main and invites the developer; clone b is a teammate's copy, behind and
// clean, pointing at the same public address.
async function withInvite(work: (rig: Rig, bundle: string) => Promise<void>): Promise<void> {
  clearUi();
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
    assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
    const b = rootOf(rig, 'b');
    gitIn(b, ['config', `url.${rig.fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(b, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    const { bundle } = await invite(rig, rig.dev);
    await work(rig, bundle);
  } finally {
    await closeRig(rig);
  }
}

test('Join with Paste your own key: the page is asked for a fresh profile status once the key works, so the Connect screen gives way to the chat', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    stub.setWorkspaceFolders([b]);
    const context = createFakeContext(rig.fixture.storageDir('b'), rig.dev.secrets);
    const handle = registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    await handle.ready;
    const own = new Map(stub.commands);
    const host = createTeamSectionHost({ team: handle, firstFolder: () => b, executeCommand: async () => undefined, now: () => 0, testSeams: false });
    const shown = page();
    host.attach(shown.webview);
    await host.refresh();
    try {
      assert.equal(await activeProfileOf(rig, rig.dev), undefined, 'no profile before the join: the page is on the Connect screen');
      shown.record.posted.length = 0;
      stub.inputAnswers.push(bundle, 'Dana D', rig.dev.ownKey as string);
      stub.quickPickAnswers.push(JOIN_TEXT.pasteOwnKey);
      const join = own.get(JOIN_COMMAND);
      assert.ok(join !== undefined);
      await join();
      await settle();
      assert.ok(await activeProfileOf(rig, rig.dev) !== undefined, 'the checked key is this project\'s selected profile');
      assert.equal(refreshRequests(shown.record), 1, `the page is asked once for a fresh profile status; it got ${JSON.stringify(shown.record.posted.map((m) => (m as { type?: string }).type))}`);
    } finally {
      host.dispose();
      await handle.session()?.sync();
      for (const subscription of context.subscriptions) subscription.dispose();
    }
  });
});

test('Join with Paste your own key: the own key becomes the person\'s own profile, not the team key profile', async () => {
  await withInvite(async (rig, bundle) => {
    const b = rootOf(rig, 'b');
    stub.setWorkspaceFolders([b]);
    const context = createFakeContext(rig.fixture.storageDir('b'), rig.dev.secrets);
    const handle = registerTeamMode(context as never, { nearBaseUrl: rig.fake.baseUrl });
    await handle.ready;
    const own = new Map(stub.commands);
    try {
      stub.inputAnswers.push(bundle, 'Dana D', rig.dev.ownKey as string);
      stub.quickPickAnswers.push(JOIN_TEXT.pasteOwnKey);
      const join = own.get(JOIN_COMMAND);
      assert.ok(join !== undefined);
      await join();
      const active = await activeProfileOf(rig, rig.dev);
      assert.ok(active !== undefined, 'a profile is selected');
      assert.equal(isTeamProfileId(active), false, `the own key is the person's own profile (saved-profile list, kept on removal, personal spend), not ${active}`);
    } finally {
      await handle.session()?.sync();
      for (const subscription of context.subscriptions) subscription.dispose();
    }
  });
});

// ---- carol, step 9: the automatic join after Ask to join ------------------------------------------------------------------------------------
// The requester's copy is made before the team existed (no team.json), as carol's was: Ask to join brings it up to date and starts the session;
// the owner accepts in Members; the requester's next sync joins by itself. The Connect part must then say what a member of a team without an
// organization does next (ownKeyStatus), with no host.refresh() from the test. GREEN on purpose (2026-11-05): the host layer refreshes by itself
// here, so the owner's step 9 failure is not in this layer; the debug session keeps the real-window repro as the next step.
type Model = import('../domain/team/teamSection').TeamSectionModel;
const ASK_TO_JOIN = 'nearAi.team.askToJoin';
const TEAM = 'Ask team';

const lastModel = (record: RecordedWebview): Model | null | undefined => record.posted
  .filter((message): message is { type: 'team-state'; model: Model | null } => (message as { type?: string }).type === 'team-state').map((message) => message.model).at(-1);

async function until(check: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('after the automatic join that follows an accepted request, the Connect part says the person needs their own key or a saved profile, by itself', async () => {
  clearUi();
  stub.setConfig('nearAi.team.pollSeconds', 3600);
  const fixture = await createTeamFixture({ clones: ['a', 'b'], initialised: true });
  const contexts: Array<ReturnType<typeof createFakeContext>> = [];
  const handles: Array<ReturnType<typeof registerTeamMode>> = [];
  const hosts: Array<ReturnType<typeof createTeamSectionHost>> = [];
  try {
    // The owner's window on clone a: Team Mode on, team setup shared.
    const a = fixture.clones['a'] as string;
    stub.setWorkspaceFolders([a]);
    const ownerContext = createFakeContext(fixture.storageDir('a'), new MemorySecrets());
    contexts.push(ownerContext);
    const owner = registerTeamMode(ownerContext as never);
    handles.push(owner);
    await owner.ready;
    const ownerCommands = new Map(stub.commands);
    gitIn(a, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(a, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.inputAnswers.push(TEAM, 'Lead Owner', 'lead@example.invalid');
    await ownerCommands.get(ENABLE_COMMAND)?.();
    const teamFile = await readTeamFile(a);
    assert.ok(teamFile !== undefined);
    const plan = await planShare({ projectRoot: a, teamFile, branch: 'main' });
    assert.equal((await shareTeamSetup({ projectRoot: a, teamFile, branch: 'main', plan })).ok, true);
    clearUi();

    // Carol's window on clone b, a copy from before the team existed, with the Team section host on its page.
    const b = fixture.clones['b'] as string;
    gitIn(b, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
    gitIn(b, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    stub.setWorkspaceFolders([b]);
    const carolContext = createFakeContext(fixture.storageDir('b'), new MemorySecrets());
    contexts.push(carolContext);
    const carol = registerTeamMode(carolContext as never);
    handles.push(carol);
    await carol.ready;
    const carolCommands = new Map(stub.commands);
    const front = (root: string, commands: Map<string, (...args: unknown[]) => unknown>): void => {
      stub.setWorkspaceFolders([root]);
      for (const [id, handler] of commands) stub.commands.set(id, handler);
    };
    const host = createTeamSectionHost({ team: carol, firstFolder: () => b, executeCommand: async () => undefined, now: () => 0, testSeams: false, boardSummary: () => carol.boardSummary() });
    hosts.push(host);
    const shown = page();
    host.attach(shown.webview);
    await host.refresh();

    // Carol asks and copies the request.
    stub.inputAnswers.push('Carol C', '');
    stub.setMessageResponder((_text, actions) => (actions.includes('Copy request') ? 'Copy request' : undefined));
    front(b, carolCommands);
    await carolCommands.get(ASK_TO_JOIN)?.();
    stub.setMessageResponder(undefined);
    const request = stub.clipboardWrites.at(-1);
    assert.ok(request?.startsWith('near-ai-join-request-v1.'), `the request was copied: ${stub.notifications.map((n) => n.message).join(' | ')}`);
    // In the product the click comes through the host, which refreshes once the command has finished (teamSectionHost runCommand).
    await host.refresh();
    assert.equal(lastModel(shown.record)?.connect?.status, sectionText.requestWaitingStatus(TEAM), `before: ${JSON.stringify(lastModel(shown.record)?.connect)}`);

    // The owner accepts in Members (email typed because the request has none).
    front(a, ownerCommands);
    stub.quickPickAnswers.push('Accept a request', 'Developer', '7 days');
    stub.inputAnswers.push(request, 'carol@example.invalid', '5');
    stub.setMessageResponder((_text, actions) => (actions.includes('Continue') ? 'Continue' : undefined));
    await ownerCommands.get(MANAGE_MEMBERS_COMMAND)?.();
    stub.setMessageResponder(undefined);
    await owner.session()?.sync();

    // Carol's next sync: her computer joins by itself.
    front(b, carolCommands);
    await carol.session()?.sync();
    assert.ok(await until(() => stub.notifications.some((n) => n.message.startsWith(`You are on ${TEAM} now.`))), `joined: ${stub.notifications.map((n) => n.message).join(' | ')}`);
    assert.ok(carol.session()?.memberId() !== undefined, 'the restarted session signs as carol');
    const wanted = sectionText.ownKeyStatus(TEAM);
    const reached = await until(() => lastModel(shown.record)?.connect?.status === wanted);
    assert.ok(reached, `the Connect part says ${wanted}; the page last got ${JSON.stringify(lastModel(shown.record)?.connect)}`);
  } finally {
    for (const host of hosts) host.dispose();
    for (const handle of handles.reverse()) await handle.session()?.sync();
    for (const context of contexts) for (const subscription of context.subscriptions) subscription.dispose();
    await fixture.cleanup().catch(() => undefined);
  }
});
