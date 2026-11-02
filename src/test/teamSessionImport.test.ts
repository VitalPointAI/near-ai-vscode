// The automatic re-import and the import entry point of a running session (Phase 62 plan 07, D-02, D-03, open question 5). An owner's or lead's window
// whose project folder has .planning/ROADMAP.md checks the integration branch after a trusted sync, at most once a minute on an injected monotonic clock,
// imports when the head differs from the last imported source, and says "Imported N items to the Team Board." once per window. Developers, windows with
// no device key, windows with the check turned off and folders without a roadmap never ask the remote. The command path and the automatic path share one
// queue. Everything runs on real git with the vscode stub installed for the whole file; fixture remotes come from the Phase 61 rig.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { newEventId } from '../team/identity';
import { redactGitMessage, runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import type { TeamFile } from '../domain/team/types';
import { remove, rootOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { FIXTURE_PLANNING, LiveTimers, commitAndPush, turn, until, withLiveTeam } from './helpers/teamLiveRig';
import { MemorySecrets, gitIn } from './helpers/teamHarness';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });

const { TeamSession, projectAuditSink, READ_ONLY_TEXT } = sessionModule;
const { createTeamStatusBar } = barModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];

const MINUTE = 60_000;
const IMPORTED_13 = 'Imported 13 items to the Team Board.';

interface Calls { lsRemote: number; integrationFetch: number }
interface Gate { armed: boolean; hit: Promise<void>; release: () => void; reached: () => void; blocked: Promise<void> }

function newGate(): Gate {
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const hit = new Promise<void>((resolve) => { reached = resolve; });
  return { armed: false, hit, release, reached, blocked };
}

const isIntegrationFetch = (args: readonly string[]): boolean => args[0] === 'fetch' && args.some((arg) => arg.includes('refs/near-ai/integration'));

interface World {
  calls: Calls;
  clock: { value: number };
  gate: Gate;
  mode: { lsRemote: 'real' | 'fail'; coordination: 'real' | 'fail' };
  git: GitRunner;
  url: string;
}

function newWorld(): World {
  const calls: Calls = { lsRemote: 0, integrationFetch: 0 };
  const gate = newGate();
  const mode: World['mode'] = { lsRemote: 'real', coordination: 'real' };
  const url = 'https://importuser:canary-pass-9f3a@git.example.invalid/team.git';
  const git: GitRunner = async (args, options) => {
    if (args[0] === 'ls-remote') {
      calls.lsRemote += 1;
      if (mode.lsRemote === 'fail') return { code: 128, stdout: Buffer.alloc(0), stderr: `fatal: unable to access '${url}/': could not resolve host\n` };
    }
    if (isIntegrationFetch(args)) {
      calls.integrationFetch += 1;
      if (gate.armed) {
        gate.armed = false;
        gate.reached();
        await gate.blocked;
      }
    } else if (args.includes('fetch') && mode.coordination === 'fail') {
      return { code: 128, stdout: Buffer.alloc(0), stderr: `fatal: unable to access '${url}/': could not resolve host\n` };
    }
    return runGit(args, options);
  };
  return { calls, clock: { value: 0 }, gate, mode, git, url };
}

interface Started { session: Session; lines: string[] }

async function startSession(rig: Rig, world: World, who: 'owner' | Participant, overrides: Partial<SessionDeps> = {}): Promise<Started> {
  const v = stub.vscode as {
    window: {
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const person = who === 'owner' ? undefined : who;
  const lines: string[] = [];
  const root = rootOf(rig, person === undefined ? 'a' : person.clone);
  assert.ok(rig.teamFile !== undefined);
  const session = await TeamSession.start({
    projectRoot: root, globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir, teamFile: rig.teamFile,
    secrets: person === undefined ? rig.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar: createTeamStatusBar(), audit: projectAuditSink(root),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers: new LiveTimers(), nearBaseUrl: rig.fake.baseUrl,
    git: world.git, monotonicNow: () => world.clock.value,
    ...overrides
  });
  return { session, lines };
}

const noticesOf = (prefix: string): string[] => stub.notifications.filter((entry) => entry.level === 'info' && entry.message.startsWith(prefix)).map((entry) => entry.message);
const hasRoadmap = (rig: Rig, clone: 'a' | 'b' | 'c'): boolean => { try { readFileSync(path.join(rootOf(rig, clone), '.planning', 'ROADMAP.md')); return true; } catch { return false; } };

// A third plan under phase 90, pushed to the integration branch from the owner's clone.
function pushNewPlan(rig: Rig): string {
  const dir = rootOf(rig, 'a');
  const source = readFileSync(path.join(FIXTURE_PLANNING, 'phases', '90-alpha', '90-02-PLAN.md'), 'utf8').replace('plan: 2', 'plan: 3');
  const target = path.join(dir, '.planning', 'phases', '90-alpha', '90-03-PLAN.md');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source, 'utf8');
  return commitAndPush(dir, 'a third plan');
}

async function inRig(run: (rig: Rig, world: World) => Promise<void>): Promise<void> {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.statusBarItems.length = 0;
  const world = newWorld();
  try {
    await withLiveTeam(async (rig) => { await run(rig, world); });
  } finally {
    world.gate.release();
  }
}

test('tracer: an owner window imports after its first trusted sync, says so once, checks the remote at most once a minute and imports a later push without a second notice', async () => {
  await inRig(async (rig, world) => {
    assert.equal(hasRoadmap(rig, 'a'), true, 'the owner clone has the roadmap');
    const owner = await startSession(rig, world, 'owner');
    try {
      assert.equal(owner.session.state().items.size, 13, 'the roadmap was imported');
      assert.deepEqual(noticesOf('Imported'), [IMPORTED_13]);
      assert.equal(world.calls.lsRemote, 1);
      assert.equal(world.calls.integrationFetch, 1);

      world.clock.value = 30_000;
      await owner.session.sync();
      assert.equal(world.calls.lsRemote, 1, 'a second sync within a minute makes no ls-remote call');

      world.clock.value = MINUTE;
      await owner.session.sync();
      assert.equal(world.calls.lsRemote, 2, 'after a minute the head is checked');
      assert.equal(world.calls.integrationFetch, 1, 'an unchanged head runs no import');
      assert.deepEqual(noticesOf('Imported'), [IMPORTED_13], 'and says nothing');

      pushNewPlan(rig);
      world.clock.value = 2 * MINUTE;
      await owner.session.sync();
      assert.equal(world.calls.lsRemote, 3);
      assert.equal(world.calls.integrationFetch, 2, 'the new head was imported');
      assert.equal(owner.session.state().items.has('plan:90-03'), true, 'the new plan is on the board');
      assert.deepEqual(noticesOf('Imported'), [IMPORTED_13], 'one notice per window, not one per import');
    } finally {
      owner.session.dispose();
    }
  });
});

// Seven more plans under phase 90 with 50 tasks each: 357 new items, more than an automatic import writes.
function pushManyPlans(rig: Rig): string {
  const dir = rootOf(rig, 'a');
  for (let plan = 10; plan < 17; plan += 1) {
    const tasks = Array.from({ length: 50 }, (_, index) => `<task type="auto">\n  <name>Task ${index + 1}: Step ${index + 1}</name>\n  <files>src/many/p${plan}t${index + 1}.ts</files>\n  <action>Do it.</action>\n</task>`).join('\n');
    const target = path.join(dir, '.planning', 'phases', '90-alpha', `90-${plan}-PLAN.md`);
    writeFileSync(target, `---\nphase: 90\nplan: ${plan}\nfiles_modified:\n  - src/many/p${plan}.ts\n---\n\n# Plan 90-${plan}: Many ${plan}\n\n<tasks>\n${tasks}\n</tasks>\n`, 'utf8');
  }
  return commitAndPush(dir, 'many plans');
}

test('WR-02: an automatic import with more changes than the ceiling writes nothing, tells the lead once in plain words, and the Import command brings them in', async () => {
  await inRig(async (rig, world) => {
    const owner = await startSession(rig, world, 'owner');
    try {
      assert.equal(owner.session.state().items.size, 13);
      pushManyPlans(rig);
      world.clock.value = MINUTE;
      await owner.session.sync();
      assert.equal(world.calls.integrationFetch, 2, 'the new head was read');
      assert.equal(owner.session.state().items.size, 13, 'nothing was written');
      const told = noticesOf('The roadmap has');
      assert.deepEqual(told, ['The roadmap has 358 changes for the Team Board. An automatic import makes at most 300, so nothing was changed. Run "NEAR AI: Import Plans to Team Board" to bring them in.']);
      assert.equal(/\u2014|\u2013/.test(told[0] ?? ''), false, 'no dash characters');

      world.clock.value = 2 * MINUTE;
      await owner.session.sync();
      assert.equal(noticesOf('The roadmap has').length, 1, 'the same head is not announced again');
      assert.equal(world.calls.integrationFetch, 2, 'and not read again');

      const result = await owner.session.importPlans({ mode: 'command' });
      assert.equal(result.ok && result.written, 358, 'the command writes them');
      assert.equal(owner.session.state().items.size, 13 + 357);
    } finally {
      owner.session.dispose();
    }
  });
});

test('a developer, a window with no device key, a window with the check turned off and a folder with no roadmap never ask the remote; the command still imports in the last one', async () => {
  await inRig(async (rig, world) => {
    gitIn(rootOf(rig, 'b'), ['pull', '-q', '--ff-only', 'origin', 'main']);
    assert.equal(hasRoadmap(rig, 'b'), true);
    const dev = await startSession(rig, world, rig.dev);
    dev.session.dispose();
    assert.deepEqual(world.calls, { lsRemote: 0, integrationFetch: 0 }, 'a developer never asks');
    assert.equal(dev.session.state().items.size, 0);

    const noKey = await startSession(rig, world, 'owner', { secrets: new MemorySecrets() });
    noKey.session.dispose();
    assert.ok(noKey.lines.includes(READ_ONLY_TEXT));
    assert.deepEqual(world.calls, { lsRemote: 0, integrationFetch: 0 }, 'a window with no device key never asks');

    const off = await startSession(rig, world, 'owner', { autoImport: false });
    off.session.dispose();
    assert.deepEqual(world.calls, { lsRemote: 0, integrationFetch: 0 }, 'autoImport false turns the check off');
    assert.equal(off.session.state().items.size, 0);

    // The lead's clone has no roadmap file yet: the gate needs it as a hint, so nothing is asked, but the command never checks it.
    assert.equal(hasRoadmap(rig, 'c'), false);
    const lead = await startSession(rig, world, rig.lead);
    try {
      assert.deepEqual(world.calls, { lsRemote: 0, integrationFetch: 0 }, 'no roadmap file, no automatic check');
      assert.equal(lead.session.state().items.size, 0);
      const result = await lead.session.importPlans({ mode: 'command' });
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      assert.equal(result.ok ? result.written : -1, 13, 'the command imported the roadmap the integration branch holds');
      assert.equal(lead.session.state().items.size, 13);
      assert.deepEqual(noticesOf('Imported'), [], 'the command path leaves the notice to its caller');

      // The roadmap file arrives with a pull and a new plan is pushed: now the lead window checks by itself.
      pushNewPlan(rig);
      gitIn(rootOf(rig, 'c'), ['pull', '-q', '--ff-only', 'origin', 'main']);
      world.clock.value = MINUTE;
      await lead.session.sync();
      assert.equal(world.calls.lsRemote, 1);
      assert.equal(lead.session.state().items.has('plan:90-03'), true, 'a lead window imports on its own');
    } finally {
      lead.session.dispose();
    }
  });
});

test('a command import started while an automatic import runs waits for it and finds nothing left to write', async () => {
  await inRig(async (rig, world) => {
    const owner = await startSession(rig, world, 'owner');
    try {
      assert.equal(owner.session.state().items.size, 13);
      pushNewPlan(rig);
      world.clock.value = MINUTE;
      world.gate.armed = true;
      const automatic = owner.session.sync();
      await world.gate.hit;

      let finished = false;
      const command = owner.session.importPlans({ mode: 'command' }).then((result) => { finished = true; return result; });
      for (let index = 0; index < 10; index += 1) await turn();
      assert.equal(finished, false, 'the command waits for the automatic import');
      assert.equal(world.calls.integrationFetch, 2, 'and has not started its own fetch');

      world.gate.release();
      await automatic;
      const result = await command;
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      assert.equal(result.ok ? result.written : -1, 0);
      assert.equal(result.ok ? result.upToDate : false, true);
      assert.equal(owner.session.state().items.has('plan:90-03'), true);
    } finally {
      owner.session.dispose();
    }
  });
});

test('a failed automatic import writes one redacted line, shows no popup, does not repeat for the same reason, and recovers on the next good check', async () => {
  await inRig(async (rig, world) => {
    world.mode.lsRemote = 'fail';
    const owner = await startSession(rig, world, 'owner');
    try {
      const failures = (): string[] => owner.lines.filter((line) => line.includes('Checking the team remote failed'));
      assert.equal(failures().length, 1);
      assert.equal(failures()[0]?.includes('canary-pass-9f3a'), false, 'the credential is redacted');
      assert.equal(failures()[0]?.includes('importuser'), false);
      assert.equal(redactGitMessage(failures()[0] ?? '') === (failures()[0] ?? ''), true);
      assert.equal(stub.notifications.filter((entry) => entry.level === 'warn').length, 0, 'no popup');
      assert.equal(owner.session.state().items.size, 0);

      world.clock.value = MINUTE;
      await owner.session.sync();
      assert.equal(world.calls.lsRemote, 2);
      assert.equal(failures().length, 1, 'the same failure is not written again');

      world.mode.lsRemote = 'real';
      world.clock.value = 2 * MINUTE;
      await owner.session.sync();
      assert.equal(owner.session.state().items.size, 13, 'the next good check imports');
      assert.deepEqual(noticesOf('Imported'), [IMPORTED_13]);
    } finally {
      owner.session.dispose();
    }
  });
});

test('boardStatus is live after a good sync, offline with a reason after a failed fetch, paused when the log is not trusted and removed after removal; canWrite follows the device key', async () => {
  await inRig(async (rig, world) => {
    const owner = await startSession(rig, world, 'owner', { autoImport: false });
    try {
      const live = owner.session.boardStatus();
      assert.equal(live.kind, 'live');
      assert.equal(live.text, 'Live');
      assert.equal(typeof live.lastUpdated, 'string');
      assert.equal(owner.session.canWrite(), true);

      world.mode.coordination = 'fail';
      assert.equal(await owner.session.sync(), false);
      const offline = owner.session.boardStatus();
      assert.equal(offline.kind, 'offline');
      assert.ok(offline.text.startsWith('Offline'), offline.text);
      assert.equal(offline.text.includes('canary-pass-9f3a'), false, 'the reason is redacted');
      assert.equal(offline.lastUpdated, live.lastUpdated, 'the last good time is kept');
      world.mode.coordination = 'real';
    } finally {
      owner.session.dispose();
    }

    const reader = await startSession(rig, world, 'owner', { secrets: new MemorySecrets(), autoImport: false });
    try {
      assert.equal(reader.session.canWrite(), false, 'no device key, no writing');
      assert.equal(reader.session.boardStatus().kind, 'live');
    } finally {
      reader.session.dispose();
    }

    const wrong: TeamFile = { ...(rig.teamFile as TeamFile), genesis: { ...(rig.teamFile as TeamFile).genesis, eventId: newEventId() } };
    const paused = await startSession(rig, world, 'owner', { teamFile: wrong, globalStorageDir: path.join(rig.fixture.root, 'wrong-storage'), autoImport: false });
    try {
      assert.equal(paused.session.boardStatus().kind, 'paused');
      assert.ok(paused.session.boardStatus().text.startsWith('Paused'));
    } finally {
      paused.session.dispose();
    }

    await remove(rig, 'owner', rig.dev);
    const removed = await startSession(rig, world, rig.dev, { autoImport: false });
    try {
      await until(() => removed.session.isRemoved(), 'the removal to be noticed');
      assert.equal(removed.session.boardStatus().kind, 'removed');
      assert.equal(removed.session.canWrite(), false);
    } finally {
      removed.session.dispose();
    }
  });
});
