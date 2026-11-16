// Team Mode and project state sync run on one project and one remote. They must never share a mirror folder, a lock or a branch, and sync must never
// carry team.json (D-11, D-12, D-15, TMR-03). The same machine runs both features here, over one local bare remote.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { teamMaterializer } from '../domain/team/materialize';
import type { GenesisAnchor, TeamFile, TeamState } from '../domain/team/types';
import { MIRROR_LOCK_FILE, acquireFileLock, acquireMirrorLock } from '../services/stateMirrorLock';
import type { HeldMirrorLock } from '../services/stateMirrorLock';
import { enableTeamMode } from '../team/enable';
import { TeamLog } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport, TEAM_MIRROR_LOCK_FILE } from '../team/gitTransport';
import { loadDeviceIdentity } from '../team/identity';
import { TEAM_FILE_REL, teamStorageDir } from '../team/teamFile';
import { bareRemote, fixtureGit, tempDirectory } from './helpers/gitFixtures';
import { SIX_TURNS, chain, machine, remoteFiles, remotePayloads } from './helpers/syncFixtures';
import type { Machine } from './helpers/syncFixtures';
import { MemorySecrets as TeamSecrets } from './helpers/teamHarness';

const THREAD = 'conv-isolation1';
const STATE_BRANCH = 'refs/heads/near-ai/state';
const TEAM_NAME = 'Isolation Team Marker';
const real = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// Short waits so a wrong implementation (one that makes a team append wait for sync's lock, or the other way round) fails fast instead of hanging.
const SHORT_WAIT = { waitMs: 400 };
const BOUND_MS = 60_000;

interface World {
  remote: string;
  machine: Machine;
  teamFile: TeamFile;
  teamMirror: string;
  teamLog: TeamLog;
  cleanup(): Promise<void>;
}

function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`${label} did not finish within ${ms} ms`)); }, ms); });
  return Promise.race([work, limit]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function anchorOf(teamFile: TeamFile): GenesisAnchor {
  return { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: teamFile.genesis.ownerDevice };
}

function remoteRef(remote: string, ref: string): string {
  return fixtureGit(remote, ['rev-parse', ref]).trim();
}

// One computer with sync on (one thread pushed) and Team Mode enabled in the same project over the same remote.
async function world(): Promise<World> {
  const remote = bareRemote();
  const m = await machine(remote, 'alpha');
  const { bytes } = generateRecoveryCode();
  await m.keys.ensureDataKey();
  await m.keys.writeRecoveryWrap(bytes);
  await m.threads.create({ id: THREAD, title: 'Isolation thread', model: 'near/model-a', origin: 'panel' });
  await m.threads.appendEntries(THREAD, chain(THREAD, m.writer, SIX_TURNS));
  assert.equal((await m.sync.sync()).kind, 'synced', 'the first sync finishes');

  const storage = await tempDirectory('near-ai-isolation-storage-');
  await mkdir(path.join(m.root, '.planning', '.near-ai'), { recursive: true });
  const secrets = new TeamSecrets();
  const enabled = await enableTeamMode({
    projectRoot: m.root, globalStorageDir: storage, secrets, teamName: TEAM_NAME, ownerName: 'Isolation Owner'
  });
  if (!enabled.ok) assert.fail(`Enable did not finish: ${enabled.message}`);
  const teamFile = enabled.teamFile;
  const teamMirror = path.join(teamStorageDir(storage, teamFile.teamId), 'coordination.git');
  const anchor = anchorOf(teamFile);
  const transport = new GitTransport<TeamState>({
    mirrorDir: teamMirror, projectRoot: m.root, remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor), baseDelayMs: 1, lockTimings: SHORT_WAIT
  });
  const identity = await loadDeviceIdentity(secrets);
  assert.ok(identity !== undefined, 'Enable stored the device key');
  if (identity === undefined) throw new Error('no device key');
  const probe = new TeamLog({ anchor, transport });
  await probe.sync();
  const owner = [...probe.state().members.values()][0];
  assert.ok(owner !== undefined, 'the genesis names an owner');
  if (owner === undefined) throw new Error('no owner');
  const signer: TeamSigner = { identity, memberId: owner.id };
  const teamLog = new TeamLog({ anchor, transport, signer });
  assert.equal((await teamLog.append(() => [{ type: 'member.availability', body: { availability: 'available' } }])).ok, true, 'the first team append lands');

  return {
    remote, machine: m, teamFile, teamMirror, teamLog,
    cleanup: async () => {
      await rm(remote, { recursive: true, force: true });
      await rm(m.root, { recursive: true, force: true });
      await rm(path.dirname(path.dirname(m.mirrorDir)), { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  };
}

async function moreSyncState(w: World, text: string): Promise<void> {
  const last = (await w.machine.threads.lines(THREAD)).main.at(-1)?.id ?? null;
  await w.machine.threads.appendEntries(THREAD, chain(THREAD, w.machine.writer, [['user', text]], last));
}

const availability = (value: 'available' | 'focus'): Parameters<TeamLog['append']>[0] => () => [{ type: 'member.availability', body: { availability: value } }];

test('a team append and a project state sync at once on one remote both land, on their own branches, and sync never carries team.json', async () => {
  const w = await world();
  try {
    const teamJsonPath = path.join(w.machine.root, TEAM_FILE_REL);
    const teamJsonBefore = await readFile(teamJsonPath);
    const teamBefore = remoteRef(w.remote, DEFAULT_COORDINATION_REF);
    const stateBefore = remoteRef(w.remote, STATE_BRANCH);
    await moreSyncState(w, 'a turn written while the team appends');

    const [appended, synced] = await within(Promise.all([w.teamLog.append(availability('focus')), w.machine.sync.sync()]), BOUND_MS, 'the team append and the sync');

    assert.equal(appended.ok, true, 'the team append lands');
    assert.equal(synced.kind, 'synced', 'the sync finishes');
    assert.notEqual(remoteRef(w.remote, DEFAULT_COORDINATION_REF), teamBefore, 'the coordination branch moved');
    assert.notEqual(remoteRef(w.remote, STATE_BRANCH), stateBefore, 'the state branch moved');

    assert.equal(existsSync(path.join(w.teamMirror, MIRROR_LOCK_FILE)), false, 'sync\'s lock file never appears in the team mirror');
    assert.equal(existsSync(path.join(w.machine.mirrorDir, TEAM_MIRROR_LOCK_FILE)), false, 'the team lock file never appears in the sync mirror');

    assert.ok((await readFile(teamJsonPath)).equals(teamJsonBefore), 'team.json is byte-identical after the sync');
    assert.equal([...remoteFiles(w.remote).keys()].some((name) => name.includes('team')), false, 'no team file sits on the state branch');
    const payloads = JSON.stringify(await remotePayloads(w.remote, w.machine));
    assert.equal(payloads.includes(w.teamFile.teamId), false, 'the team id is not in any state payload');
    assert.equal(payloads.includes(TEAM_NAME), false, 'the team name is not in any state payload');
    assert.equal(payloads.includes('team.json'), false, 'team.json is not named in any state payload');
  } finally {
    await w.cleanup();
  }
});

test('holding the team mirror lock does not delay a project state sync, and each mirror only ever holds its own lock file name', async () => {
  const w = await world();
  let held: HeldMirrorLock | undefined;
  try {
    held = await acquireFileLock(w.teamMirror, TEAM_MIRROR_LOCK_FILE, { sleep: real, random: Math.random });
    assert.equal(existsSync(path.join(w.teamMirror, TEAM_MIRROR_LOCK_FILE)), true, 'the team lock is held');
    const stateBefore = remoteRef(w.remote, STATE_BRANCH);
    await moreSyncState(w, 'a turn written while the team lock is held');

    const synced = await within(w.machine.sync.sync(), BOUND_MS, 'the sync while the team lock is held');

    assert.equal(synced.kind, 'synced', 'the sync finishes while the team lock is held');
    assert.notEqual(remoteRef(w.remote, STATE_BRANCH), stateBefore, 'the state branch moved');
    assert.equal(existsSync(path.join(w.machine.mirrorDir, TEAM_MIRROR_LOCK_FILE)), false, 'the team lock name is not in the sync mirror');
    assert.equal(existsSync(path.join(w.teamMirror, MIRROR_LOCK_FILE)), false, 'sync\'s lock name is not in the team mirror');
    assert.equal(existsSync(path.join(w.teamMirror, TEAM_MIRROR_LOCK_FILE)), true, 'the team lock is still held after the sync');
  } finally {
    await held?.release();
    await w.cleanup();
  }
});

test('holding the project sync mirror lock does not delay a team append', async () => {
  const w = await world();
  let held: HeldMirrorLock | undefined;
  try {
    held = await acquireMirrorLock(w.machine.mirrorDir, { sleep: real, random: Math.random });
    assert.equal(existsSync(path.join(w.machine.mirrorDir, MIRROR_LOCK_FILE)), true, 'the sync lock is held');
    const teamBefore = remoteRef(w.remote, DEFAULT_COORDINATION_REF);

    const appended = await within(w.teamLog.append(availability('focus')), BOUND_MS, 'the team append while the sync lock is held');

    assert.equal(appended.ok, true, 'the team append lands while the sync lock is held');
    assert.notEqual(remoteRef(w.remote, DEFAULT_COORDINATION_REF), teamBefore, 'the coordination branch moved');
    assert.equal(existsSync(path.join(w.teamMirror, MIRROR_LOCK_FILE)), false, 'sync\'s lock name is not in the team mirror');
    assert.equal(existsSync(path.join(w.machine.mirrorDir, TEAM_MIRROR_LOCK_FILE)), false, 'the team lock name is not in the sync mirror');
    assert.equal(existsSync(path.join(w.machine.mirrorDir, MIRROR_LOCK_FILE)), true, 'the sync lock is still held after the append');
  } finally {
    await held?.release();
    await w.cleanup();
  }
});

test('the team mirror folder and the sync mirror folder are different paths and neither is inside the other', async () => {
  const w = await world();
  try {
    const team = path.resolve(w.teamMirror);
    const sync = path.resolve(w.machine.mirrorDir);
    assert.notEqual(team, sync);
    const inside = (outer: string, inner: string): boolean => {
      const relative = path.relative(outer, inner);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    assert.equal(inside(team, sync), false, 'the sync mirror is not inside the team mirror');
    assert.equal(inside(sync, team), false, 'the team mirror is not inside the sync mirror');
    assert.notEqual(TEAM_MIRROR_LOCK_FILE, MIRROR_LOCK_FILE, 'the two features use different lock file names');
  } finally {
    await w.cleanup();
  }
});
