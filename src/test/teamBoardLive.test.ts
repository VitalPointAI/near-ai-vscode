// The live board at the session level (Phase 62 plan 07, BOARD-02 git half): two members on two real clones, the owner blocks a card, and the
// developer's window sees it after exactly one of its own poll intervals and not before. Also the change hook, card history from the first sync,
// the board-visible trigger (a visible board keeps the focused poll interval and nothing about who looked is ever written), and the status bar
// counts. Timers fire by hand on a fake monotonic clock; git, the log and the roster are real. Lazy requires keep every vscode import behind the stub.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { countReady, effectiveColumn } from '../domain/team/work';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent } from '../domain/team/types';
import { importPlans } from '../team/importPlans';
import { UNFOCUSED_POLL_MS } from '../team/syncScheduler';
import { BRANCH_MISSING_REASON } from '../team/transport';
import { openLog, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { LiveTimers, turn, until, withLiveTeam } from './helpers/teamLiveRig';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });

const { TeamSession, projectAuditSink } = sessionModule;
const { createTeamStatusBar } = barModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];

const POLL_MS = 15_000;
const REASON = 'waiting for the API key';
const BLOCKED_PLAN = 'plan:90-02';

interface Started { session: Session; lines: string[]; timers: LiveTimers; focus: { value: boolean }; bar: { text: string; tooltip: string; command?: string } }

async function startSession(rig: Rig, who: 'owner' | Participant, overrides: Partial<Omit<SessionDeps, 'focused'>> & { focused?: boolean } = {}): Promise<Started> {
  const v = stub.vscode as {
    window: {
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const person = who === 'owner' ? undefined : who;
  const timers = new LiveTimers();
  const focus = { value: overrides.focused ?? true };
  const lines: string[] = [];
  const { focused: _ignored, ...rest } = overrides;
  const root = rootOf(rig, person === undefined ? 'a' : person.clone);
  const statusBar = createTeamStatusBar();
  const item = stub.statusBarItems[stub.statusBarItems.length - 1];
  assert.ok(rig.teamFile !== undefined);
  const session = await TeamSession.start({
    projectRoot: root, globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir, teamFile: rig.teamFile,
    secrets: person === undefined ? rig.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar, audit: projectAuditSink(root),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => focus.value, timers, nearBaseUrl: rig.fake.baseUrl, autoImport: false,
    ...rest
  });
  const view = { get text(): string { return item?.text ?? ''; }, get tooltip(): string { return item?.tooltip ?? ''; }, get command(): string | undefined { return item?.command; } };
  return { session, lines, timers, focus, bar: view };
}

async function importFixture(rig: Rig): Promise<void> {
  const owner = await openLog(rig, 'owner');
  const result = await importPlans({
    log: owner.log, source: { projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' }, storageDir: storageOf(rig, 'owner'), mode: 'command'
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  assert.equal(result.ok ? result.written : -1, 13);
}

test('tracer: member A blocks a card and member B sees it after exactly one poll interval and not before', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const b = await startSession(rig, rig.dev);
    try {
      assert.deepEqual(b.timers.delays(), [POLL_MS], 'the first sync arms one poll at the focused interval');
      const before = b.session.state().items.get(BLOCKED_PLAN);
      assert.ok(before !== undefined, 'B has read the import');
      assert.equal(before.blocked, undefined);
      const columnBefore = effectiveColumn(b.session.state().items, before);
      const received: CommittedEvent[] = [];
      b.session.onStateChange((entries) => { received.push(...entries); });

      const owner = await openLog(rig, 'owner');
      const appended = await owner.log.append(() => [{ type: 'item.blocked', body: { id: BLOCKED_PLAN, reason: REASON } }]);
      assert.equal(appended.ok, true, appended.ok ? '' : appended.reason);

      // Time has not moved: B has not polled, so it cannot know.
      for (let index = 0; index < 5; index += 1) await turn();
      assert.equal(b.session.state().items.get(BLOCKED_PLAN)?.blocked, undefined, 'not before the poll');
      assert.equal(received.length, 0);
      assert.deepEqual(b.timers.delays(), [POLL_MS], 'no extra timer was made');

      b.timers.fire();
      await until(() => b.session.state().items.get(BLOCKED_PLAN)?.blocked !== undefined, 'the blocked card to arrive');
      const after = b.session.state().items.get(BLOCKED_PLAN);
      assert.equal(after?.blocked?.reason, REASON);
      assert.equal(received.length, 1, 'the listener got the one new entry');
      assert.equal(received[0]?.verdict?.accepted, true);
      // Blocked is a flag and never a column: a stored card keeps its stored state, and the board shows it in the Backlog while it is blocked (D-10, D-11).
      assert.equal(after?.state, before.state);
      assert.equal(columnBefore, 'ready', 'the fixture plan is ready before it is blocked');
      assert.equal(effectiveColumn(b.session.state().items, after as NonNullable<typeof after>), 'backlog');
      const history = b.session.itemHistory(BLOCKED_PLAN);
      assert.equal(history[0]?.type, 'item.blocked');
      assert.equal(history[0]?.reason, REASON);
      assert.equal(history[history.length - 1]?.type, 'item.imported', 'history reaches back to the first sync of the window');
    } finally {
      b.session.dispose();
    }
  });
});

test('a poll that brings nothing new notifies no listener, and a listener that throws never reaches the transport', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const b = await startSession(rig, rig.dev);
    try {
      let calls = 0;
      b.session.onStateChange(() => { calls += 1; throw new Error('listener failure'); });
      const owner = await openLog(rig, 'owner');
      await owner.log.append(() => [{ type: 'item.blocked', body: { id: BLOCKED_PLAN, reason: REASON } }]);
      b.timers.fire();
      await until(() => calls === 1, 'the listener to be called');
      await until(() => b.timers.live.length === 1, 'the next poll to be armed');
      assert.ok(b.lines.some((line) => line.includes('listener failure')), 'the failure is written to the output channel');
      assert.equal(b.session.state().items.get(BLOCKED_PLAN)?.blocked?.reason, REASON, 'the state still updated');

      b.timers.fire();
      await until(() => b.timers.requests.length === 3, 'the second poll to finish');
      for (let index = 0; index < 3; index += 1) await turn();
      assert.equal(calls, 1, 'an empty poll notifies nobody');
    } finally {
      b.session.dispose();
    }
  });
});

test('the session own appends notify listeners too, and a disposed listener hears nothing more', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const a = await startSession(rig, 'owner');
    try {
      const heard: string[] = [];
      const subscription = a.session.onStateChange((entries) => { for (const entry of entries) heard.push(entry.verdict?.accepted === true ? (entry.verdict.event?.type ?? '') : 'rejected'); });
      const appended = await a.session.currentLog().append(() => [{ type: 'item.blocked', body: { id: BLOCKED_PLAN, reason: REASON } }]);
      assert.equal(appended.ok, true, appended.ok ? '' : appended.reason);
      assert.deepEqual(heard, ['item.blocked']);
      assert.equal(a.session.itemHistory(BLOCKED_PLAN)[0]?.type, 'item.blocked');
      subscription.dispose();
      await a.session.currentLog().append(() => [{ type: 'item.unblocked', body: { id: BLOCKED_PLAN } }]);
      assert.deepEqual(heard, ['item.blocked'], 'nothing after dispose');
    } finally {
      a.session.dispose();
    }
  });
});

test('a visible board keeps the focused poll interval in an unfocused window, creates no timer of its own and writes nothing about who looked', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const b = await startSession(rig, rig.dev, { focused: false });
    try {
      assert.deepEqual(b.timers.delays(), [UNFOCUSED_POLL_MS], 'an unfocused window starts at the unfocused interval');
      const remoteBefore = (await fs.readdir(path.join(rig.fixture.remote, 'refs', 'heads'))).sort();

      b.session.setBoardVisible(true);
      await until(() => b.timers.delays().length === 2, 'the sync that opening the board runs');
      assert.equal(b.timers.delays()[1], POLL_MS, 'the next wait is the focused interval');
      assert.equal(b.timers.live.length, 1, 'still one pending timer');

      b.session.setBoardVisible(false);
      for (let index = 0; index < 3; index += 1) await turn();
      assert.equal(b.timers.delays()[b.timers.delays().length - 1], UNFOCUSED_POLL_MS, 'the wait goes back to the unfocused interval');
      assert.equal(b.timers.live.length, 1, 'still one pending timer');

      const remoteAfter = (await fs.readdir(path.join(rig.fixture.remote, 'refs', 'heads'))).sort();
      assert.deepEqual(remoteAfter, remoteBefore);
      assert.equal(b.lines.some((line) => /board|visible|looked|viewing/i.test(line)), false, 'the output channel says nothing about the board being open');
      const stored = await fs.readdir(b.session.storageDir());
      assert.equal(stored.some((name) => /board|visible|view/i.test(name)), false, 'no file records it');
    } finally {
      b.session.dispose();
    }
  });
});

test('window focus and board visibility combine: either one keeps the focused interval', async () => {
  await withLiveTeam(async (rig) => {
    await importFixture(rig);
    const b = await startSession(rig, rig.dev, { focused: true });
    try {
      b.session.setBoardVisible(true);
      await turn();
      b.focus.value = false;
      b.session.focusChanged(false);
      for (let index = 0; index < 3; index += 1) await turn();
      assert.equal(b.timers.live.length, 1);
      assert.equal(b.timers.live[0]?.ms, POLL_MS, 'the board is still visible, so the window losing focus changes nothing');
      b.session.setBoardVisible(false);
      for (let index = 0; index < 3; index += 1) await turn();
      assert.equal(b.timers.live[0]?.ms, UNFOCUSED_POLL_MS);
    } finally {
      b.session.dispose();
    }
  });
});

// ---- the status bar (D-17) -------------------------------------------------------------------------------------------------------------------

const OK = { state: 'ok' as const };
const OPEN_BOARD = 'nearAi.team.openBoard';
const VERIFY_LOG = 'nearAi.team.verifyLog';

test('status text with cards: ready and pending counts, singular and plural forms, the open-board target and an accessibility label', () => {
  const { statusText } = barModule;
  const three = statusText(OK, 'Alpha', { ready: 3, pending: 1 });
  assert.equal(three.text, '$(organization) Team: 3 ready \u00b7 1 pending');
  assert.equal(three.plain, 'Team: 3 ready \u00b7 1 pending');
  assert.equal(three.tooltip, 'Alpha: 3 plans are ready to start. 1 member is waiting for confirmation. Click to open the Team Board.');
  assert.equal(three.accessibilityLabel, 'Team Board. 3 plans ready. 1 member waiting for confirmation. Open the Team Board.');
  assert.equal(three.command, OPEN_BOARD);
  assert.equal(three.tier, 'none');

  const none = statusText(OK, 'Alpha', { ready: 3, pending: 0 });
  assert.equal(none.text, '$(organization) Team: 3 ready');
  assert.equal(none.tooltip, 'Alpha: 3 plans are ready to start. Click to open the Team Board.');
  assert.equal(none.accessibilityLabel, 'Team Board. 3 plans ready. Open the Team Board.');

  assert.equal(statusText(OK, 'Alpha', { ready: 1, pending: 2 }).tooltip, 'Alpha: 1 plan is ready to start. 2 members are waiting for confirmation. Click to open the Team Board.');
  assert.equal(statusText(OK, 'Alpha', { ready: 1 }).accessibilityLabel, 'Team Board. 1 plan ready. Open the Team Board.');
  assert.equal(statusText(OK, 'Alpha', { ready: 0 }).text, '$(organization) Team: 0 ready');
  assert.equal(statusText(OK, 'Alpha', { ready: 0 }).tooltip, 'Alpha: No plans are ready to start. Click to open the Team Board.');
  assert.equal(statusText(OK, 'Alpha', { ready: 0 }).accessibilityLabel, 'Team Board. No plans ready. Open the Team Board.');
  assert.equal(statusText(OK, 'Alpha', { ready: 3, nearLabel: 'lead@example.invalid' }).tooltip.endsWith(' NEAR: signed in as lead@example.invalid.'), true, 'the NEAR line follows');
});

test('status text without cards keeps only the team name and the pending suffix, and always has the icon, tooltip, label and open-board target', () => {
  const { statusText } = barModule;
  const quiet = statusText(OK, 'Alpha', { nearLinked: true });
  assert.equal(quiet.text, '$(organization) Team: Alpha');
  assert.equal(quiet.tooltip, 'Team sync is working. Click to open the Team Board.');
  assert.equal(quiet.accessibilityLabel, 'Team Alpha. Sync is working. Open the Team Board.');
  assert.equal(quiet.command, OPEN_BOARD);
  const waiting = statusText(OK, 'Alpha', { pending: 2 });
  assert.equal(waiting.text, '$(organization) Team: Alpha (2 pending)');
  assert.equal(waiting.plain, 'Team: Alpha (2 pending)');
});

test('paused, not trusted and removed states: icon, plain form, tooltip ending, tier, click target and an accessibility label that carries the action', () => {
  const { statusText, PAUSED_UNREACHABLE_TEXT, PAUSED_REWRITTEN_TEXT, PAUSED_MISSING_TEXT, PAUSED_REFUSED_TEXT, REMOVED_TEXT } = barModule;
  const unreachable = statusText({ state: 'offline', reason: 'could not resolve host' }, 'Alpha');
  assert.equal(unreachable.text, `$(warning) ${PAUSED_UNREACHABLE_TEXT}`);
  assert.equal(unreachable.plain, PAUSED_UNREACHABLE_TEXT);
  assert.ok(unreachable.tooltip.endsWith(' The board shows the last update and cannot be changed until the connection returns. Click to run Verify Team Log.'));
  assert.equal(unreachable.accessibilityLabel, `${PAUSED_UNREACHABLE_TEXT}. Click to run Verify Team Log.`);
  assert.equal(unreachable.tier, 'warning');
  assert.equal(unreachable.command, VERIFY_LOG);

  const rewritten = statusText({ state: 'paused', reason: TEAM_REJECTION_REASONS.logRewritten }, 'Alpha');
  assert.equal(rewritten.text, `$(warning) ${PAUSED_REWRITTEN_TEXT}`);
  assert.ok(rewritten.tooltip.endsWith('Click to run Verify Team Log.'));
  assert.equal(rewritten.tier, 'warning');
  assert.equal(rewritten.command, VERIFY_LOG);

  const missing = statusText({ state: 'paused', reason: BRANCH_MISSING_REASON }, 'Alpha');
  assert.equal(missing.text, `$(warning) ${PAUSED_MISSING_TEXT}`);
  assert.ok(missing.tooltip.endsWith('Click to run Verify Team Log.'));
  assert.equal(missing.tier, 'warning');

  const refused = statusText({ state: 'paused', reason: TEAM_REJECTION_REASONS.logRefused }, 'Alpha');
  assert.equal(refused.text, `$(error) ${PAUSED_REFUSED_TEXT}`);
  assert.ok(refused.tooltip.startsWith('The team log did not pass its checks, so the board is paused.'));
  assert.ok(refused.tooltip.endsWith('Click to run Verify Team Log.'));
  assert.equal(refused.tier, 'error');
  assert.equal(refused.command, VERIFY_LOG);

  const removed = statusText(OK, 'Alpha', { removed: true });
  assert.equal(removed.text, `$(error) ${REMOVED_TEXT}`);
  assert.equal(removed.accessibilityLabel, REMOVED_TEXT);
  assert.equal(removed.tier, 'error');
  assert.equal(removed.command, undefined);

  for (const shown of [unreachable, rewritten, missing, refused, removed, statusText(OK, 'Alpha', { ready: 2 })]) {
    assert.equal(shown.plain.includes('$('), false, 'the plain form never carries icon syntax');
    assert.equal(shown.accessibilityLabel.includes('$('), false, 'the label never carries icon syntax');
  }
});

test('a team name that looks like an icon is shown as typed in the text, the tooltip and the label', () => {
  const { statusText } = barModule;
  const bare = statusText(OK, '$(alert) Evil');
  const counted = statusText(OK, '$(alert) Evil', { ready: 2 });
  for (const field of [bare.text, bare.tooltip, bare.accessibilityLabel, counted.text, counted.tooltip, counted.accessibilityLabel]) {
    assert.equal(/(^|[^\\])\$\(alert\)/.test(field), false, `${field} has an unescaped icon opener`);
  }
  assert.ok(bare.text.includes('\\$(alert) Evil'), 'the text shows the name as typed');
  assert.ok(bare.accessibilityLabel.includes('\\$(alert) Evil'));
  assert.ok(counted.tooltip.includes('\\$(alert) Evil'));
});

test('a session with no items shows the team text with the icon and a label; once the log has cards it shows the ready count from the same poll', async () => {
  await withLiveTeam(async (rig) => {
    const b = await startSession(rig, rig.dev);
    try {
      const item = stub.statusBarItems[stub.statusBarItems.length - 1];
      assert.ok(item !== undefined);
      assert.equal(item.text, '$(organization) Team: Flow team');
      assert.deepEqual(item.accessibilityInformation, { label: 'Team Flow team. Sync is working. Open the Team Board.', role: 'button' });
      assert.equal(item.command, OPEN_BOARD);
      assert.equal(item.backgroundColor, undefined);

      await importFixture(rig);
      b.timers.fire();
      const ready = (): number => countReady(b.session.state().items);
      await until(() => item.text !== '$(organization) Team: Flow team', 'the status bar to show the cards');
      assert.ok(ready() > 0, 'the fixture has ready plans');
      assert.equal(item.text, `$(organization) Team: ${ready()} ready`);
      assert.equal(item.accessibilityInformation?.label, `Team Board. ${ready() === 1 ? '1 plan' : `${ready()} plans`} ready. Open the Team Board.`);

      const before = ready();
      const owner = await openLog(rig, 'owner');
      await owner.log.append(() => [{ type: 'item.blocked', body: { id: BLOCKED_PLAN, reason: REASON } }]);
      b.timers.fire();
      await until(() => item.text !== `$(organization) Team: ${before} ready`, 'the count to follow the poll');
      assert.equal(item.text, `$(organization) Team: ${before - 1} ready`);
      assert.equal(item.command, OPEN_BOARD);
    } finally {
      b.session.dispose();
    }
  }, { planning: true });
});
