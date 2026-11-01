// TeamSession on real git with the vscode stub installed for the whole file: first sync, status bar states, audit mirroring across restarts,
// Verify Team Log, rejected events printed once, an unreachable remote with a credential canary, a rewritten log, the trust pin and the
// real-editor wiring (focus, setting changes, disposables). Lazy requires keep every vscode import behind the installed stub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { TeamEvent, TeamFile } from '../domain/team/types';
import { auditMarkFile, projectMarkScope } from '../team/auditMirror';
import type { VerifyReport } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { newEventId, newTeamId } from '../team/identity';
import { NEUTRAL_IDENTITY_ENV, runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import type { TransportStatus } from '../team/transport';
import { TrustPinError, parseTeamFile } from '../team/teamFile';
import { teamMaterializer } from '../domain/team/materialize';
import type { TeamState } from '../domain/team/types';
import { createOwner, createTeamFixture, gitIn, testGenesis } from './helpers/teamHarness';
import type { TeamFixture, TestGenesis, TestOwner } from './helpers/teamHarness';
import { signed } from './helpers/teamEvents';
import { makeCanaries } from './helpers/teamCanary';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });

const { TeamSession, UPDATE_EXTENSION_TEXT, READ_ONLY_TEXT, createVscodeTeamSession, formatVerifyReport, projectAuditSink, TEAM_OUTPUT_CHANNEL } = sessionModule;
const { PAUSED_REWRITTEN_TEXT, PAUSED_UNREACHABLE_TEXT, createTeamStatusBar } = barModule;
const statusTextFor = (status: TransportStatus): { text: string; tooltip: string } => barModule.statusText(status, TEAM_NAME);
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];

const EM_DASH = '\u2014';
const TEAM_NAME = 'Session team';
const turn = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 15); });
  }
}

interface Request { ms: number; callback: () => void; cleared: boolean; fired: boolean }
class FakeTimers {
  public readonly requests: Request[] = [];
  public set(callback: () => void, ms: number): unknown {
    const request: Request = { ms, callback, cleared: false, fired: false };
    this.requests.push(request);
    return request;
  }
  public clear(handle: unknown): void { (handle as Request).cleared = true; }
  public get live(): Request[] { return this.requests.filter((request) => !request.cleared && !request.fired); }
  public delays(): number[] { return this.requests.map((request) => request.ms); }
  public fire(): void {
    const request = this.live[this.live.length - 1];
    assert.ok(request !== undefined, 'a timer is waiting');
    request.fired = true;
    request.callback();
  }
}

interface Rig {
  fixture: TeamFixture;
  owner: TestOwner;
  genesis: TestGenesis;
  teamFile: TeamFile;
  projectRoot: string;
  globalStorage: string;
  timers: FakeTimers;
  fetches: { count: number };
  git: GitRunner;
  sessions: Session[];
}

function resetStub(): void {
  stub.outputChannels.length = 0;
  stub.statusBarItems.length = 0;
  stub.notifications.length = 0;
  stub.configUpdates.length = 0;
  stub.inputAnswers.length = 0;
  stub.messageAnswers.length = 0;
}

// A fixture with a bare remote, the clone the session runs in ("a"), a clone for raw pushes, and the genesis already on the remote.
async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a', 'raw'] });
  const sessions: Session[] = [];
  try {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: TEAM_NAME });
    const projectRoot = fixture.clones['a'] as string;
    const seed = new GitTransport<TeamState>({
      mirrorDir: path.join(fixture.storageDir('seed'), 'coordination.git'), projectRoot, remote: 'origin', ref: DEFAULT_COORDINATION_REF,
      materializer: teamMaterializer(genesis.anchor), baseDelayMs: 1
    });
    const pushed = await seed.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
    assert.equal(pushed.ok, true);
    const fetches = { count: 0 };
    const git: GitRunner = (args, options) => {
      if (args.includes('fetch')) fetches.count += 1;
      return runGit(args, options);
    };
    await run({
      fixture, owner, genesis, teamFile: parseTeamFile(genesis.teamFileText), projectRoot, globalStorage: fixture.storageDir('a'),
      timers: new FakeTimers(), fetches, git, sessions
    });
  } finally {
    for (const session of sessions) session.dispose();
    await fixture.cleanup();
  }
}

interface Started { session: Session; lines: string[]; shows: { count: number }; progress: string[] }

async function startSession(rig: Rig, overrides: Partial<SessionDeps> = {}): Promise<Started> {
  const v = stub.vscode as {
    window: {
      createOutputChannel(name: string): { appendLine(line: string): void };
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const channel = v.window.createOutputChannel(TEAM_OUTPUT_CHANNEL);
  const lines = (stub.outputChannels[stub.outputChannels.length - 1] as { lines: string[] }).lines;
  const shows = { count: 0 };
  const progress: string[] = [];
  const session = await TeamSession.start({
    projectRoot: rig.projectRoot, globalStorageDir: rig.globalStorage, teamFile: rig.teamFile, secrets: rig.owner.secrets,
    output: { appendLine: (line) => { channel.appendLine(line); }, show: () => { shows.count += 1; } },
    statusBar: createTeamStatusBar(), audit: projectAuditSink(rig.projectRoot),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers: rig.timers, git: rig.git,
    withProgress: async <T>(title: string, task: () => Promise<T>): Promise<T> => { progress.push(title); return task(); },
    ...overrides
  });
  rig.sessions.push(session);
  return { session, lines, shows, progress };
}

interface AuditRow { id: string; type: string; timestamp: string; projectId?: string; metadata?: Record<string, unknown> }
async function auditRows(root: string): Promise<AuditRow[]> {
  const text = await fs.readFile(path.join(root, '.planning', '.near-ai', 'audit.json'), 'utf8');
  return (JSON.parse(text) as { events: AuditRow[] }).events;
}

function rawGit(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// What a member with plain git access can do: add a file to the coordination branch and push it as a fast-forward, skipping every TeamLog check.
function rawPush(dir: string, events: Array<TeamEvent | Record<string, unknown>>, message: string): void {
  rawGit(dir, ['fetch', '-q', 'origin', `+${DEFAULT_COORDINATION_REF}:refs/raw/coordination`]);
  const parent = rawGit(dir, ['rev-parse', 'refs/raw/coordination']);
  const indexFile = path.join(dir, '.git', `raw-index-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: indexFile, ...NEUTRAL_IDENTITY_ENV };
  try {
    rawGit(dir, ['read-tree', parent], { env });
    for (const event of events) {
      const blob = rawGit(dir, ['hash-object', '-w', '--stdin'], { env, input: canonicalize(event) });
      rawGit(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${eventPath(event as TeamEvent)}`], { env });
    }
    const tree = rawGit(dir, ['write-tree'], { env });
    const commit = rawGit(dir, ['commit-tree', tree, '-p', parent, '-m', message], { env });
    rawGit(dir, ['push', '-q', 'origin', `${commit}:${DEFAULT_COORDINATION_REF}`]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

// Properly signed, then its body changed, so the signature no longer matches.
function tamperedEvent(rig: Rig, lamport: number): TeamEvent {
  const prev = rig.genesis.events[1].id;
  const base = signed(rig.owner, { teamId: rig.teamFile.teamId, type: 'member.availability', body: { availability: 'away' }, lamport, prev });
  return { ...base, body: { availability: 'focus' } };
}

function rewriteRemote(rig: Rig): void {
  gitIn(rig.fixture.remote, ['config', 'receive.denyNonFastForwards', 'false']);
  const dir = rig.fixture.clones['raw'] as string;
  gitIn(dir, ['checkout', '-q', '--orphan', 'rewrite']);
  gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'rewrite']);
  gitIn(dir, ['push', '-q', '--force', 'origin', `rewrite:${DEFAULT_COORDINATION_REF}`]);
}

function everyShownText(lines: string[]): string[] {
  return [...lines, ...stub.statusBarItems.flatMap((item) => [item.text, item.tooltip]), ...stub.notifications.map((entry) => entry.message)];
}

function assertPlainCopy(lines: string[]): void {
  for (const text of everyShownText(lines)) assert.equal(text.includes(EM_DASH), false, `no em-dash in: ${text}`);
}

function lastItem(): { text: string; tooltip: string; command?: string; visible: boolean; disposed: boolean } {
  const item = stub.statusBarItems[stub.statusBarItems.length - 1];
  assert.ok(item !== undefined, 'a status bar item exists');
  return item;
}

// ---- first sync, status bar, audit mirror ----

test('start creates the mirror, syncs once, shows Team: <name> and writes two team-roster entries that a restart does not repeat', async () => {
  await withRig(async (rig) => {
    const first = await startSession(rig);
    assert.ok(existsSync(path.join(rig.globalStorage, 'team', rig.teamFile.teamId, 'coordination.git', 'HEAD')), 'the mirror lives in global storage');
    assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
    assert.ok(lastItem().tooltip.includes('Verify Team Log'));
    assert.equal(lastItem().command, 'nearAi.team.verifyLog');
    assert.equal(lastItem().visible, true);
    assert.ok(first.lines.some((line) => line === `Team sync is running for ${TEAM_NAME}.`));
    assert.equal((first.session as unknown as { signing: boolean }).signing, true, 'the owner key was matched to its member after the first sync');
    assert.equal(rig.fetches.count, 1, 'start syncs once, not twice');

    await until(() => rig.timers.live.length === 1, 'the first poll to be scheduled');
    assert.deepEqual(rig.timers.delays(), [15_000]);

    const rows = await auditRows(rig.projectRoot);
    assert.deepEqual(rows.map((row) => row.type), ['team-roster', 'team-roster']);
    assert.deepEqual(rows.map((row) => row.metadata?.eventType), ['team.created', 'member.joined']);
    assert.equal(rows[0]?.metadata?.role, 'owner');
    assert.equal(rows[0]?.projectId, rig.teamFile.teamId);
    const mark = JSON.parse(await fs.readFile(auditMarkFile(path.join(rig.globalStorage, 'team', rig.teamFile.teamId), projectMarkScope(rig.projectRoot)), 'utf8')) as { lamport: number };
    assert.equal(mark.lamport, 2);

    first.session.dispose();
    assert.equal(lastItem().disposed, true, 'dispose removes the status bar item');
    assert.equal(rig.timers.live.length, 0, 'dispose leaves no timer');

    const second = await startSession(rig, { timers: new FakeTimers() });
    assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
    assert.equal((await auditRows(rig.projectRoot)).length, 2, 'a restart does not mirror the same events again');
    second.session.dispose();
    assertPlainCopy(first.lines);
  });
});

test('a computer without a device key reads and mirrors but is told it is read-only', async () => {
  await withRig(async (rig) => {
    const { MemorySecrets } = await import('./helpers/teamHarness');
    const started = await startSession(rig, { secrets: new MemorySecrets() });
    assert.ok(started.lines.includes(READ_ONLY_TEXT));
    assert.equal((started.session as unknown as { signing: boolean }).signing, false);
    assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
    assert.equal((await auditRows(rig.projectRoot)).length, 2);
  });
});

// ---- Verify Team Log ----

test('verifyLog prints the full report to the channel, shows a summary and Show details opens the channel', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    stub.messageAnswers.push('Show details');
    const report = await started.session.verifyLog();
    assert.ok(report !== undefined);
    assert.deepEqual(started.progress, ['Verifying the team log']);

    const fingerprint = rig.owner.identity.fingerprint;
    const joinedId = rig.genesis.events[1].id;
    for (const expected of [
      `Verify Team Log: ${TEAM_NAME} (${rig.teamFile.teamId})`,
      'Status: ok',
      'Events: 2 (2 accepted, 0 rejected)',
      `Head: lamport 2, event ${joinedId}`,
      'Members: 1',
      `  Owner Test, owner: device ${fingerprint}`,
      'Snapshots: 0',
      'Rejected events: 0'
    ]) assert.ok(started.lines.includes(expected), `report has: ${expected}`);
    assert.deepEqual(stub.notifications.at(-1), { level: 'info', message: 'Team log verified: 2 events, 1 member, 0 rejected' });
    await until(() => started.shows.count >= 2, 'Show details to open the channel');
    assertPlainCopy(started.lines);
  });
});

test('a raw-pushed event with a broken signature is printed once, listed by verifyLog and never mirrored to audit', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    const forged = tamperedEvent(rig, 3);
    rawPush(rig.fixture.clones['raw'] as string, [forged], 'raw: tampered body');

    assert.equal(await started.session.sync(), true, 'a rejected event is not an unhealthy sync');
    assert.equal(await started.session.sync(), true);
    const line = `Rejected event ${forged.id}: ${TEAM_REJECTION_REASONS.badSignature}`;
    assert.equal(started.lines.filter((text) => text === line).length, 1, 'printed once per session even after a second sync');
    assert.equal((await auditRows(rig.projectRoot)).length, 2, 'nothing was mirrored for the rejected event');

    const report = await started.session.verifyLog();
    assert.equal(report?.rejected.length, 1);
    assert.ok(started.lines.includes('Rejected events: 1'));
    assert.ok(started.lines.includes(`  ${line}`), 'listed under Rejected events with its reason');
    assert.deepEqual(stub.notifications.at(-1), { level: 'warn', message: 'Team log checked, with problems: 3 events, 1 member, 1 rejected.' });
    assert.equal((await auditRows(rig.projectRoot)).length, 2);
    assertPlainCopy(started.lines);
  });
});

test('an event of an unsupported type makes verifyLog tell the user to update the extension', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    const future = { ...tamperedEvent(rig, 3), type: 'item.created' };
    rawPush(rig.fixture.clones['raw'] as string, [future], 'raw: future event type');
    const report = await started.session.verifyLog();
    assert.equal(report?.unsupported, 1);
    assert.ok(started.lines.includes(UPDATE_EXTENSION_TEXT));
    assert.equal(UPDATE_EXTENSION_TEXT, 'Some events need a newer version of NEAR AI. Update the extension to read them.');
    const warning = stub.notifications.at(-1);
    assert.equal(warning?.level, 'warn');
    assert.ok(warning?.message.includes(UPDATE_EXTENSION_TEXT));
  });
});

test('a verify that cannot run is reported to the channel and to the user', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    const failing = (): never => { throw new Error('the replay failed'); };
    (started.session as unknown as { log: { verifyAll: () => Promise<never> } }).log.verifyAll = async () => failing();
    assert.equal(await started.session.verifyLog(), undefined);
    assert.ok(started.lines.includes('Verify Team Log failed: the replay failed'));
    assert.equal(stub.notifications.at(-1)?.level, 'warn');
  });
});

test('formatVerifyReport lists refused logs, removed members, revoked devices and secret warnings, and flattens hostile text', () => {
  const report: VerifyReport = {
    events: 5, accepted: 3, head: { eventId: 'evt-X', lamport: 4 }, snapshots: 1, unsupported: 2, refused: 'genesis does not match',
    members: [
      { id: 'm1', name: `Ann\nInjected line ${'x'.repeat(600)}`, role: 'lead', removed: false, devices: [{ fingerprint: 'fp-1', revoked: false }, { fingerprint: 'fp-2', revoked: true }] },
      { id: 'm2', name: 'Bob', role: 'developer', removed: true, devices: [] }
    ],
    rejected: [{ eventId: 'evt-bad', reason: 'signature is not valid' }, { eventId: 'events/odd\u0007name.json', reason: 'malformed event' }],
    secretWarnings: ['evt-1: $.note'],
    status: { state: 'offline', reason: 'could not read from https://user:hunter2@example.com/repo.git' }
  };
  const teamFile: TeamFile = {
    version: 1, teamId: newTeamId(), name: 'Report team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: newEventId(), ownerDevice: { fingerprint: 'fp-1', publicKey: 'key' } }, createdAt: '2026-01-01T00:00:00.000Z'
  };
  const lines = formatVerifyReport(report, teamFile);
  assert.ok(lines.every((line) => !line.includes('\n') && !line.includes('\u0007') && !line.includes(EM_DASH)));
  assert.ok(lines.every((line) => line.length < 700));
  assert.ok(lines.some((line) => line.startsWith('Status: offline (could not read from https://')));
  assert.equal(lines.some((line) => line.includes('hunter2') || line.includes('user:')), false, 'credentials in a status reason are removed');
  assert.ok(lines.includes('Log refused: genesis does not match'));
  assert.ok(lines.includes('  Bob, developer (removed): no devices'));
  assert.ok(lines.some((line) => line.includes('device fp-1, device fp-2 (revoked)')));
  assert.ok(lines.includes('Events: 5 (3 accepted, 2 rejected)'));
  assert.ok(lines.includes('Snapshots: 1'));
  assert.ok(lines.includes('Secret-like values found (warning only):'));
  assert.ok(lines.includes('  evt-1: $.note'));
  assert.ok(lines.includes(UPDATE_EXTENSION_TEXT));
});

// ---- unreachable remote, backoff, focus ----

test('an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers', async () => {
  await withRig(async (rig) => {
    const canaries = makeCanaries();
    const userName = `canaryuser${randomBytes(4).toString('hex')}`;
    const started = await startSession(rig);
    await until(() => rig.timers.requests.length === 1, 'the first poll');

    gitIn(rig.projectRoot, ['remote', 'set-url', 'origin', `http://${userName}:${canaries.urlPassword}@127.0.0.1:1/team.git`]);
    for (let failure = 1; failure <= 7; failure += 1) {
      rig.timers.fire();
      await until(() => rig.timers.requests.length === failure + 1, `failure ${failure} to be scheduled`);
    }
    assert.deepEqual(rig.timers.delays(), [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    assert.equal(lastItem().text, PAUSED_UNREACHABLE_TEXT);
    assert.equal(PAUSED_UNREACHABLE_TEXT, 'Team sync paused: remote unreachable');
    assert.ok(lastItem().tooltip.startsWith('The team remote could not be reached'));
    assert.ok(lastItem().tooltip.includes('right away when this window gets focus'));
    for (const text of everyShownText(started.lines)) {
      assert.equal(text.includes(canaries.urlPassword), false, `password not in: ${text}`);
      assert.equal(text.includes(userName), false, `user name not in: ${text}`);
    }
    assert.equal(started.lines.filter((line) => line.startsWith(PAUSED_UNREACHABLE_TEXT)).length, 1, 'the paused state is written once while it lasts');

    const before = rig.fetches.count;
    started.session.focusChanged(true);
    await until(() => rig.fetches.count > before, 'focus to retry at once');

    gitIn(rig.projectRoot, ['remote', 'set-url', 'origin', rig.fixture.remote]);
    await until(() => rig.timers.live.length === 1, 'the retry to settle');
    started.session.focusChanged(true);
    await until(() => lastItem().text === `Team: ${TEAM_NAME}`, 'the status bar to recover');
    assert.ok(started.lines.includes('Team sync is working again.'));
    await until(() => rig.timers.delays().at(-1) === 15_000, 'the delay to reset');
    assertPlainCopy(started.lines);
  });
});

test('a rewritten coordination branch shows the log rewritten state with the D-33 sentence', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    rewriteRemote(rig);
    assert.equal(await started.session.sync(), false);
    assert.equal(lastItem().text, PAUSED_REWRITTEN_TEXT);
    assert.equal(PAUSED_REWRITTEN_TEXT, 'Team sync paused: log rewritten');
    assert.equal(lastItem().tooltip, TEAM_REJECTION_REASONS.logRewritten);
    assert.ok(started.lines.some((line) => line.startsWith(`${PAUSED_REWRITTEN_TEXT}.`) && line.includes(TEAM_REJECTION_REASONS.logRewritten)));
    assertPlainCopy(started.lines);
  });
});

// ---- trust pin ----

test('a changed team.json stops the session with TrustPinError and creates no timers or status bar item', async () => {
  await withRig(async (rig) => {
    (await startSession(rig)).session.dispose();
    const changed: TeamFile = { ...rig.teamFile, genesis: { ...rig.teamFile.genesis, eventId: newEventId() } };
    const timers = new FakeTimers();
    await assert.rejects(() => startSession(rig, { teamFile: changed, timers }), TrustPinError);
    assert.equal(timers.requests.length, 0, 'no timer was created');

    const created = stub.statusBarItems.length;
    const context = { globalStorageUri: { fsPath: rig.globalStorage }, secrets: rig.owner.secrets, subscriptions: [] as unknown[] };
    const channel = { appendLine: (): void => undefined, show: (): void => undefined };
    await assert.rejects(() => createVscodeTeamSession(context as never, rig.projectRoot, changed, channel), TrustPinError);
    assert.equal(stub.statusBarItems.length, created + 1);
    assert.equal(lastItem().disposed, true, 'the status bar item made for the failed session was removed');
    assert.deepEqual(context.subscriptions, []);
  });
});

// ---- audit mirror failures ----

test('an audit write that does not reach disk is reported once, keeps the mark back and is retried on the next sync', async () => {
  await withRig(async (rig) => {
    // A file where the .planning folder should be makes every audit write fail inside AuditStore, which swallows it.
    writeFileSync(path.join(rig.projectRoot, '.planning'), 'not a folder', 'utf8');
    const started = await startSession(rig);
    await started.session.sync();
    const failures = started.lines.filter((line) => line.startsWith('Team audit mirror failed'));
    assert.equal(failures.length, 1, 'the same failure is written once, not at every poll');
    assert.ok(failures[0]?.includes('could not be saved'));
    const markFile = auditMarkFile(path.join(rig.globalStorage, 'team', rig.teamFile.teamId), projectMarkScope(rig.projectRoot));
    assert.equal(existsSync(markFile), false, 'the mark did not move past unwritten entries');

    rmSync(path.join(rig.projectRoot, '.planning'), { force: true });
    assert.equal(await started.session.sync(), true);
    assert.equal((await auditRows(rig.projectRoot)).length, 2, 'the held events were mirrored after the disk recovered');
    assert.ok(existsSync(markFile));
    await started.session.sync();
    assert.equal((await auditRows(rig.projectRoot)).length, 2, 'and not twice');
  });
});

// ---- real editor wiring ----

test('createVscodeTeamSession wires focus, the pollSeconds setting and its disposables to the session', async () => {
  await withRig(async (rig) => {
    stub.setConfig('nearAi.team.pollSeconds', 20);
    const context = { globalStorageUri: { fsPath: rig.globalStorage }, secrets: rig.owner.secrets, subscriptions: [] as Array<{ dispose(): void }> };
    const channel = (stub.vscode as { window: { createOutputChannel(name: string): { appendLine(line: string): void; show(): void } } }).window.createOutputChannel(TEAM_OUTPUT_CHANNEL);
    const lines = (stub.outputChannels[stub.outputChannels.length - 1] as { lines: string[] }).lines;
    const session = await createVscodeTeamSession(context as never, rig.projectRoot, rig.teamFile, channel);
    try {
      assert.equal(session.teamFile.teamId, rig.teamFile.teamId);
      assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
      assert.equal(context.subscriptions.length, 3, 'session, window state listener and configuration listener');
      assert.equal((await auditRows(rig.projectRoot)).length, 2);

      const firstForgery = tamperedEvent(rig, 3);
      rawPush(rig.fixture.clones['raw'] as string, [firstForgery], 'raw: forgery one');
      stub.fireWindowState(true);
      await until(() => lines.some((line) => line.startsWith(`Rejected event ${firstForgery.id}`)), 'a focus event to fetch at once');

      const secondForgery = tamperedEvent(rig, 4);
      rawPush(rig.fixture.clones['raw'] as string, [secondForgery], 'raw: forgery two');
      stub.setConfig('nearAi.team.pollSeconds', 60);
      await until(() => lines.some((line) => line.startsWith(`Rejected event ${secondForgery.id}`)), 'a pollSeconds change to sync at once');
      assertPlainCopy(lines);
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose();
    }
    assert.equal(lastItem().disposed, true);
  });
});

// ---- redaction when git itself echoes the credentials ----

test('credentials in a git error never reach the tooltip, the channel or a notification, whether git reports them or throws them', async () => {
  const canaries = makeCanaries();
  const userName = `canaryuser${randomBytes(4).toString('hex')}`;
  const url = `https://${userName}:${canaries.urlPassword}@git.example.invalid/team.git`;
  const bars = [
    statusTextFor({ state: 'offline', reason: `fatal: unable to access '${url}/': could not resolve host` }),
    statusTextFor({ state: 'paused', reason: `remote said ${url}\nline two` })
  ];
  for (const shown of bars) {
    assert.equal(shown.tooltip.includes(canaries.urlPassword), false);
    assert.equal(shown.tooltip.includes(userName), false);
    assert.equal(shown.tooltip.includes('\n'), false);
    assert.equal(shown.text, PAUSED_UNREACHABLE_TEXT);
  }

  await withRig(async (rig) => {
    let mode: 'real' | 'report' | 'throw' = 'real';
    const hostile: GitRunner = (args, options) => {
      const fetching = args.includes('fetch');
      if (fetching && mode === 'report') return Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: `fatal: unable to access '${url}/': could not resolve host\n` });
      if (fetching && mode === 'throw') return Promise.reject(new Error(`git failed talking to ${url}`));
      return runGit(args, options);
    };
    const started = await startSession(rig, { git: hostile });
    mode = 'report';
    assert.equal(await started.session.sync(), false);
    assert.equal(lastItem().text, PAUSED_UNREACHABLE_TEXT);
    mode = 'throw';
    assert.equal(await started.session.sync(), false);
    assert.equal(lastItem().text, PAUSED_UNREACHABLE_TEXT);
    assert.ok(started.lines.some((line) => line.startsWith('Team sync failed:')), 'a thrown error is written to the channel');
    await started.session.verifyLog();
    for (const text of everyShownText(started.lines)) {
      assert.equal(text.includes(canaries.urlPassword), false, `password not in: ${text}`);
      assert.equal(text.includes(userName), false, `user name not in: ${text}`);
    }
    assertPlainCopy(started.lines);
  });
});

// ---- review fixes ----

test('a throw while showing the status does not stop later syncs (WR-03)', async () => {
  await withRig(async (rig) => {
    const bar = createTeamStatusBar();
    let armed = false;
    const started = await startSession(rig, {
      statusBar: { update: (status, name) => { if (armed) throw new Error('status bar torn down'); bar.update(status, name); }, dispose: () => { bar.dispose(); } }
    });
    const before = rig.fetches.count;
    armed = true;
    assert.equal(await started.session.sync(), false, 'a sync that threw reports unhealthy and does not reject');
    assert.ok(started.lines.some((line) => line.startsWith('Team sync failed unexpectedly: status bar torn down')));
    armed = false;
    assert.equal(await started.session.sync(), true, 'the next sync really runs');
    assert.equal(rig.fetches.count, before + 2, 'both syncs reached the remote');
  });
});

test('a coordination log that does not match the genesis anchor shows a paused not-trusted state, warns once and backs off (WR-06)', async () => {
  await withRig(async (rig) => {
    const wrongAnchor: TeamFile = { ...rig.teamFile, genesis: { ...rig.teamFile.genesis, eventId: newEventId() } };
    const started = await startSession(rig, { teamFile: wrongAnchor, globalStorageDir: rig.fixture.storageDir('wrong-team') });
    assert.equal(lastItem().text, barModule.PAUSED_REFUSED_TEXT);
    assert.equal(lastItem().text, 'Team log not trusted');
    assert.equal(lastItem().tooltip.includes('Team sync is working'), false);
    assert.ok(lastItem().tooltip.includes(TEAM_REJECTION_REASONS.logRefused));
    assert.equal(await started.session.sync(), false, 'a refused log is not a healthy sync, so the scheduler backs off');
    assert.equal(stub.notifications.filter((entry) => entry.level === 'warn' && entry.message.includes('Team log not trusted')).length, 1, 'one warning, not one per poll');
    assert.equal(started.lines.some((line) => line === `Team sync is running for ${TEAM_NAME}.`), false);
    assertPlainCopy(started.lines);
  });
});

test('a coordination branch deleted on the remote shows a log-missing status that recovers (WR-10)', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    const head = gitIn(rig.fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]);
    gitIn(rig.fixture.remote, ['update-ref', '-d', DEFAULT_COORDINATION_REF]);
    assert.equal(await started.session.sync(), false);
    assert.equal(lastItem().text, barModule.PAUSED_MISSING_TEXT);
    assert.equal(lastItem().tooltip.includes('Team sync is working'), false);
    gitIn(rig.fixture.remote, ['update-ref', DEFAULT_COORDINATION_REF, head]);
    assert.equal(await started.session.sync(), true);
    assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
    assertPlainCopy(started.lines);
  });
});

test('a second checkout of the same team on this computer still receives the roster entries in its own audit log (WR-11)', async () => {
  await withRig(async (rig) => {
    const first = await startSession(rig);
    assert.equal((await auditRows(rig.projectRoot)).length, 2);
    first.session.dispose();
    // Same team, same global storage, another clone: it has its own audit file, so the first checkout's progress must not apply to it.
    const otherRoot = rig.fixture.clones['raw'] as string;
    const second = await startSession({ ...rig, projectRoot: otherRoot }, { timers: new FakeTimers() });
    assert.deepEqual((await auditRows(otherRoot)).map((row) => row.metadata?.eventType), ['team.created', 'member.joined']);
    assert.equal((await auditRows(rig.projectRoot)).length, 2, 'the first checkout is not written twice');
    second.session.dispose();
  });
});
