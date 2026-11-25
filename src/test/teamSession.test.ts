// TeamSession on real git with the vscode stub installed for the whole file: first sync, status bar states, audit mirroring across restarts,
// Verify Team Log, rejected events printed once, an unreachable remote with a credential canary, a rewritten log, the trust pin and the
// real-editor wiring (focus, setting changes, disposables), and the G-60-1 focus rules: events that change nothing neither re-arm the poll
// nor sync, and a focus change during the first sync still sets the cadence. Lazy requires keep every vscode import behind the installed stub.
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
import { UNFOCUSED_POLL_MS } from '../team/syncScheduler';
import type { TransportStatus } from '../team/transport';
import { TrustPinError, parseTeamFile, pinTrust, projectTrustDir, teamStorageDir } from '../team/teamFile';
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

const { TeamSession, UPDATE_EXTENSION_TEXT, READ_ONLY_TEXT, createVscodeTeamSession, focusTransitions, formatVerifyReport, projectAuditSink, sameFailureKey, TEAM_OUTPUT_CHANNEL } = sessionModule;
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
// The clock never moves: these tests fire timers by hand, so a constant now() keeps the scheduler's anchor on the same clock as set() (IN-02).
class FakeTimers {
  public readonly requests: Request[] = [];
  public now(): number { return 0; }
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
  // One test's window focus must never leak into the next.
  stub.fireWindowState(true, true);
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
    assert.equal(READ_ONLY_TEXT.includes('for this team'), false);
    assert.equal((started.session as unknown as { signing: boolean }).signing, false);
    assert.equal(lastItem().text, `Team: ${TEAM_NAME}`);
    assert.equal((await auditRows(rig.projectRoot)).length, 2);
    await started.session.sync();
    assert.deepEqual(stub.configUpdates, [], 'no setting is written by start or sync, and no key is created');
  });
});

test('a computer whose identity is not in this team roster is told it is read-only, once, and writes no key or setting', async () => {
  await withRig(async (rig) => {
    const { MemorySecrets } = await import('./helpers/teamHarness');
    const { createDeviceIdentity } = await import('../team/identity');
    const secrets = new MemorySecrets();
    await createDeviceIdentity(secrets);
    const keysBefore = [...secrets.values.keys()];
    const started = await startSession(rig, { secrets });
    await started.session.sync();
    assert.equal(started.lines.filter((line) => line === READ_ONLY_TEXT).length, 1, 'said once, not on every sync');
    assert.equal((started.session as unknown as { signing: boolean }).signing, false);
    assert.deepEqual([...secrets.values.keys()], keysBefore, 'opening a team never creates a key');
    assert.deepEqual(stub.configUpdates, []);
  });
});

// ---- Verify Team Log ----

test('verifyLog prints the full report to the channel, shows a summary and Show details opens the channel', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    stub.messageAnswers.push('Show details');
    const report = await started.session.verifyLog();
    assert.ok(report !== undefined);
    assert.deepEqual(started.progress, ['Checking the team record']);

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
    assert.deepEqual(stub.notifications.at(-1), { level: 'info', message: 'The team record passed its check: 2 events, 1 member, 0 rejected' });
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
    assert.deepEqual(stub.notifications.at(-1), { level: 'warn', message: 'The team record was checked and has problems: 3 events, 1 member, 1 rejected.' });
    assert.equal((await auditRows(rig.projectRoot)).length, 2);
    assertPlainCopy(started.lines);
  });
});

test('the rejections a session remembers are bounded to the most recent ones, with one plain note of how many were let go, and dedupe still holds inside the bound', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig, { reportedLimit: 2 });
    const forged = [3, 4, 5, 6].map((lamport) => tamperedEvent(rig, lamport));
    const printed = (event: TeamEvent): number => started.lines.filter((text) => text.startsWith(`Rejected event ${event.id}:`)).length;
    const forgotten = (): string[] => started.lines.filter((text) => text.startsWith('Team Mode no longer remembers'));

    rawPush(rig.fixture.clones['raw'] as string, [forged[0] as TeamEvent, forged[1] as TeamEvent], 'raw: two forgeries');
    assert.equal(await started.session.sync(), true);
    assert.equal(await started.session.sync(), true);
    assert.deepEqual([printed(forged[0] as TeamEvent), printed(forged[1] as TeamEvent)], [1, 1], 'inside the bound each is printed once, however often it comes back');
    assert.deepEqual(forgotten(), [], 'nothing has been let go yet');

    rawPush(rig.fixture.clones['raw'] as string, [forged[2] as TeamEvent], 'raw: a third forgery');
    assert.equal(await started.session.sync(), true);
    assert.equal(printed(forged[2] as TeamEvent), 1);
    assert.equal(forgotten().length, 1, 'one note once the oldest entry was let go');
    assert.match(forgotten()[0] as string, /oldest 1 rejected event or problem/);

    rawPush(rig.fixture.clones['raw'] as string, [forged[3] as TeamEvent], 'raw: a fourth forgery');
    assert.equal(await started.session.sync(), true);
    assert.equal(printed(forged[3] as TeamEvent), 1);
    assert.equal(forgotten().length, 1, 'the note is not repeated');
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
    assert.equal(UPDATE_EXTENSION_TEXT, 'Some events need a newer version of SovAI. Update the extension to read them.');
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
      { id: 'm1', name: `Ann\nInjected line ${'x'.repeat(600)}`, role: 'lead', removed: false, devices: [{ fingerprint: 'fp-1', state: 'active' }, { fingerprint: 'fp-2', state: 'revoked' }, { fingerprint: 'fp-3', state: 'rotated', replacedBy: 'fp-4' }, { fingerprint: 'fp-5', state: 'unknown' }] },
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
  assert.ok(lines.some((line) => line.includes('device fp-1, device fp-2 (revoked), device fp-3 (rotated, replaced by fp-4), device fp-5 (unknown)')));
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
    assert.equal(PAUSED_UNREACHABLE_TEXT, 'Team sync paused: offline');
    assert.ok(lastItem().tooltip.startsWith('The team remote could not be reached'));
    assert.ok(lastItem().tooltip.includes('right away when this window gets focus'));
    for (const text of everyShownText(started.lines)) {
      assert.equal(text.includes(canaries.urlPassword), false, `password not in: ${text}`);
      assert.equal(text.includes(userName), false, `user name not in: ${text}`);
    }
    assert.equal(started.lines.filter((line) => line.startsWith(PAUSED_UNREACHABLE_TEXT)).length, 1, 'the paused state is written once while it lasts');

    const before = rig.fetches.count;
    started.session.focusChanged(false);
    started.session.focusChanged(true);
    await until(() => rig.fetches.count > before, 'focus to retry at once');

    gitIn(rig.projectRoot, ['remote', 'set-url', 'origin', rig.fixture.remote]);
    await until(() => rig.timers.live.length === 1, 'the retry to settle');
    started.session.focusChanged(false);
    started.session.focusChanged(true);
    await until(() => lastItem().text === `Team: ${TEAM_NAME}`, 'the status bar to recover');
    assert.ok(started.lines.includes('Team sync is working again.'));
    await until(() => rig.timers.delays().at(-1) === 15_000, 'the delay to reset');
    assertPlainCopy(started.lines);
  });
});

// The test above failed now and then on a loaded machine ("the paused state is written once while it lasts: 3 !== 1"). git's own words for an
// unreachable remote carry how long the connect took ("Failed to connect to 127.0.0.1 port 1 after 0 ms"), and that figure moves with the machine's
// load, so each poll could look like a new reason and write the paused line again. Here every failed fetch reports a different time, as a loaded
// machine would, and the line must still be written once.
test('a remote that stays down is written once even when git reports a different connect time on every try', async () => {
  await withRig(async (rig) => {
    let tries = 0;
    const git: GitRunner = async (args, options) => {
      const result = await rig.git(args, options);
      if (result.code === 0 || !/ after \d+ ms/.test(result.stderr)) return result;
      tries += 1;
      return { ...result, stderr: result.stderr.replace(/ after \d+ ms/g, ` after ${tries * 7} ms`) };
    };
    const started = await startSession(rig, { git });
    await until(() => rig.timers.requests.length === 1, 'the first poll');
    gitIn(rig.projectRoot, ['remote', 'set-url', 'origin', 'http://127.0.0.1:1/team.git']);
    for (let failure = 1; failure <= 4; failure += 1) {
      rig.timers.fire();
      await until(() => rig.timers.requests.length === failure + 1, `failure ${failure} to be scheduled`);
    }
    assert.ok(tries >= 4, `every try reported its own connect time (${tries})`);
    assert.equal(lastItem().text, PAUSED_UNREACHABLE_TEXT);
    const paused = started.lines.filter((line) => line.startsWith(PAUSED_UNREACHABLE_TEXT));
    assert.equal(paused.length, 1, 'the paused state is written once while it lasts');
    assert.ok(paused[0]?.includes('after 7 ms'), 'the first reason is written as git gave it');
    assert.equal(started.lines.filter((line) => line.startsWith('Team sync failed')).length <= 1, true, 'and no failure line repeats for a time alone');

    // The remote comes back: the recovery is still written, so only the time figure is ignored.
    gitIn(rig.projectRoot, ['remote', 'set-url', 'origin', rig.fixture.remote]);
    started.session.focusChanged(false);
    started.session.focusChanged(true);
    await until(() => lastItem().text === `Team: ${TEAM_NAME}`, 'the status bar to recover');
    assert.ok(started.lines.includes('Team sync is working again.'));
  });
});

test('sameFailureKey leaves out only the time and byte figures of a git failure', () => {
  const refused = (ms: number): string => `fatal: unable to access 'http://127.0.0.1:1/team.git/': Failed to connect to 127.0.0.1 port 1 after ${ms} ms: Could not connect to server`;
  assert.equal(sameFailureKey(refused(0)), sameFailureKey(refused(213)));
  const timedOut = (ms: number, got: number, of: number): string => `fatal: unable to access 'https://example.invalid/t.git/': Operation timed out after ${ms} milliseconds with ${got} out of ${of} bytes received`;
  assert.equal(sameFailureKey(timedOut(30001, 0, 0)), sameFailureKey(timedOut(30044, 512, 2048)));
  assert.notEqual(sameFailureKey(refused(0)), sameFailureKey(refused(0).replace('port 1 ', 'port 2 ')), 'another port is another failure');
  assert.notEqual(sameFailureKey(refused(0)), sameFailureKey(timedOut(1, 0, 0)), 'another kind of failure is new');
  assert.equal(sameFailureKey('fatal: could not read Username for \'https://example.invalid\''), 'fatal: could not read Username for \'https://example.invalid\'', 'a reason with no figures is unchanged');
});

test('a rewritten coordination branch shows the log rewritten state with the D-33 sentence', async () => {
  await withRig(async (rig) => {
    const started = await startSession(rig);
    rewriteRemote(rig);
    assert.equal(await started.session.sync(), false);
    assert.equal(lastItem().text, PAUSED_REWRITTEN_TEXT);
    assert.equal(PAUSED_REWRITTEN_TEXT, 'Team sync paused: record changed');
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

test('the trust pin is kept per project: swapping the team id, the genesis or the owner key in team.json is refused, even with no per-team folder', async () => {
  await withRig(async (rig) => {
    (await startSession(rig)).session.dispose();
    const pinDir = projectTrustDir(rig.globalStorage, rig.projectRoot);
    assert.ok(existsSync(path.join(pinDir, 'trust.json')), 'the pin is in the project folder');
    assert.equal(existsSync(path.join(teamStorageDir(rig.globalStorage, rig.teamFile.teamId), 'trust.json')), false, 'and not in the per-team folder');
    const stranger = await createOwner(rig.teamFile.teamId);
    const swaps: Array<[string, TeamFile]> = [
      ['team id', { ...rig.teamFile, teamId: newTeamId() }],
      ['team id and genesis together', { ...rig.teamFile, teamId: newTeamId(), genesis: { ...rig.teamFile.genesis, eventId: newEventId() } }],
      ['genesis', { ...rig.teamFile, genesis: { ...rig.teamFile.genesis, eventId: newEventId() } }],
      ['owner key', { ...rig.teamFile, genesis: { ...rig.teamFile.genesis, ownerDevice: { fingerprint: stranger.identity.fingerprint, publicKey: stranger.identity.publicKey } } }]
    ];
    for (const [label, changed] of swaps) {
      const timers = new FakeTimers();
      await assert.rejects(() => startSession(rig, { teamFile: changed, timers }), (error: unknown) => error instanceof TrustPinError && /different team or owner key/.test(error.message), label);
      assert.equal(timers.requests.length, 0, `${label}: no timer`);
      if (changed.teamId !== rig.teamFile.teamId) {
        assert.equal(existsSync(teamStorageDir(rig.globalStorage, changed.teamId)), false, `${label}: no folder was made for the swapped team`);
      }
    }
    // The original team still matches: refused attempts leave the pin alone.
    (await startSession(rig)).session.dispose();
  });
});

test('after the person deliberately trusts a re-created team, its session starts, and the old team is then refused', async () => {
  await withRig(async (rig) => {
    (await startSession(rig)).session.dispose();
    const recreated: TeamFile = { ...rig.teamFile, teamId: newTeamId(), genesis: { ...rig.teamFile.genesis, eventId: newEventId() } };
    await assert.rejects(() => startSession(rig, { teamFile: recreated }), TrustPinError);
    await pinTrust(projectTrustDir(rig.globalStorage, rig.projectRoot), recreated);
    const pinned = JSON.parse(await fs.readFile(path.join(projectTrustDir(rig.globalStorage, rig.projectRoot), 'trust.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(pinned, { version: 1, teamId: recreated.teamId, genesisEventId: recreated.genesis.eventId, ownerFingerprint: recreated.genesis.ownerDevice.fingerprint });
    // The trust step is all this test checks; the session's own sync of a team it cannot find on the remote is covered elsewhere.
    const started = await startSession(rig, { teamFile: recreated });
    started.session.dispose();
    await assert.rejects(() => startSession(rig), TrustPinError, 'the old team is now the different one');
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
      stub.fireWindowState(false);
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

test('focusTransitions forwards only real focus changes', () => {
  const forwarded: boolean[] = [];
  const listener = focusTransitions(true, (focused) => { forwarded.push(focused); });
  for (const state of [
    { focused: true, active: false }, { focused: false, active: true }, { focused: false, active: false },
    { focused: true, active: true }, { focused: true, active: true }
  ]) listener(state);
  assert.deepEqual(forwarded, [false, true]);
});

test('the vscode stub fires one window-state event per changed property and none when nothing changes, as VS Code does (IN-03)', () => {
  resetStub();
  const window = (stub.vscode as { window: { onDidChangeWindowState(listener: (state: { focused: boolean; active: boolean }) => void): { dispose(): void } } }).window;
  const events: Array<{ focused: boolean; active: boolean }> = [];
  const subscription = window.onDidChangeWindowState((state) => { events.push(state); });
  try {
    stub.fireWindowState(true, true);
    assert.deepEqual(events, [], 'an unchanged state fires nothing');
    stub.fireWindowState(false, false);
    assert.deepEqual(events, [{ focused: false, active: true }, { focused: false, active: false }], 'a change to both properties fires one event each');
    stub.fireWindowState(false, true);
    assert.deepEqual(events.slice(2), [{ focused: false, active: true }], 'an activity-only change fires one event');
    stub.fireWindowState(true, true);
    assert.deepEqual(events.slice(3), [{ focused: true, active: true }], 'a focus-only change fires one event');
  } finally {
    subscription.dispose();
    resetStub();
  }
});

test('window-state events that only change activity neither re-arm the poll nor sync, and real focus changes still do (G-60-1)', async () => {
  await withRig(async (rig) => {
    stub.setConfig('nearAi.team.pollSeconds', 20);
    const context = { globalStorageUri: { fsPath: rig.globalStorage }, secrets: rig.owner.secrets, subscriptions: [] as Array<{ dispose(): void }> };
    const channel = (stub.vscode as { window: { createOutputChannel(name: string): { appendLine(line: string): void; show(): void } } }).window.createOutputChannel(TEAM_OUTPUT_CHANNEL);
    const session = await createVscodeTeamSession(context as never, rig.projectRoot, rig.teamFile, channel, { timers: rig.timers, git: rig.git });
    try {
      await until(() => rig.timers.live.length === 1, 'exactly one pending poll');
      assert.deepEqual(rig.timers.delays(), [20_000]);
      const pending = rig.timers.live[0] as Request;
      const requestCount = rig.timers.requests.length;
      const fetchCount = rig.fetches.count;

      for (let index = 0; index < 36; index += 1) {
        stub.fireWindowState(true, index % 2 === 1);
        assert.equal(rig.timers.requests.length, requestCount, `activity-only event ${index} requested no timer`);
        assert.equal(pending.cleared, false, `activity-only event ${index} left the pending poll alone`);
      }

      stub.fireWindowState(false, true);
      assert.equal(rig.timers.requests.length, requestCount + 1, 'losing focus re-arms exactly once');
      assert.equal(pending.cleared, true, 'the focused poll was replaced');
      const unfocused = rig.timers.requests[requestCount] as Request;
      assert.equal(unfocused.ms, UNFOCUSED_POLL_MS, 'the unfocused delay counts from the last run, which ended at the same fake time');

      stub.fireWindowState(false, false);
      assert.equal(rig.timers.requests.length, requestCount + 1, 'an activity-only change after the loss requests no timer');
      assert.equal(unfocused.cleared, false, 'and leaves the unfocused poll alone');
      for (let index = 0; index < 5; index += 1) await turn();
      assert.equal(rig.fetches.count, fetchCount, 'no event so far started a sync');

      stub.fireWindowState(true, true);
      await until(() => rig.fetches.count > fetchCount, 'a real focus gain to sync at once');
      await until(() => rig.timers.live.length === 1, 'the gain run to settle');
    } finally {
      for (const disposable of context.subscriptions) disposable.dispose();
    }
  });
});

test('a focus change while the first sync is blocked still sets the cadence of the first poll (G-60-1)', async () => {
  for (const startFocused of [false, true]) {
    await withRig(async (rig) => {
      stub.setConfig('nearAi.team.pollSeconds', 5);
      stub.fireWindowState(startFocused, startFocused);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      const git: GitRunner = async (args, options) => {
        if (!held && args.includes('fetch')) {
          held = true;
          await gate;
        }
        return rig.git(args, options);
      };
      const context = { globalStorageUri: { fsPath: rig.globalStorage }, secrets: rig.owner.secrets, subscriptions: [] as Array<{ dispose(): void }> };
      const channel = (stub.vscode as { window: { createOutputChannel(name: string): { appendLine(line: string): void; show(): void } } }).window.createOutputChannel(TEAM_OUTPUT_CHANNEL);
      const starting = createVscodeTeamSession(context as never, rig.projectRoot, rig.teamFile, channel, { timers: rig.timers, git });
      // A handler attached at once, so a rejection while the test is still waiting is never unhandled. The finally awaits it on every
      // path, so a failure never leaves the first sync running against fixtures withRig is about to delete (WR-02).
      const settled = starting.then((session) => session, () => undefined);
      try {
        await until(() => held, 'the first fetch to be held');
        stub.fireWindowState(!startFocused, !startFocused);
        release();
        await starting;
        await until(() => rig.timers.requests.length >= 1, 'the first poll to be armed');
        if (startFocused) {
          assert.equal(rig.timers.delays()[0], UNFOCUSED_POLL_MS, 'a window that lost focus during the first sync polls at the unfocused delay');
        } else {
          assert.equal(rig.timers.delays()[0], 5_000, 'a window that gained focus during the first sync polls at pollSeconds');
          assert.equal(rig.timers.delays().includes(UNFOCUSED_POLL_MS), false, 'no unfocused delay was ever requested');
        }
      } finally {
        release();
        const session = await settled;
        for (const disposable of context.subscriptions) disposable.dispose();
        // The subscriptions hold the session only once start resolved inside the try. dispose() is idempotent, so this also covers a
        // session that resolved after a failure above.
        session?.dispose();
      }
    });
  }
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
    assert.equal(lastItem().text, 'Team record not trusted');
    assert.equal(lastItem().tooltip.includes('Team sync is working'), false);
    assert.ok(lastItem().tooltip.includes(TEAM_REJECTION_REASONS.logRefused));
    assert.equal(await started.session.sync(), false, 'a refused log is not a healthy sync, so the scheduler backs off');
    assert.equal(stub.notifications.filter((entry) => entry.level === 'warn' && entry.message.includes('Team record not trusted')).length, 1, 'one warning, not one per poll');
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
