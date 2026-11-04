// Ask to join (Phase 61 plan 28, G-61-9): an invite in reverse over real git. The requester's computer (clone b, team.json present, no device
// key) makes the single-use code, keeps it in SecretStorage and hands over only a signed request with the derived public key. The owner on
// clone a accepts it, which writes a normal member.invited for that key, and clone b then joins by itself with the existing code proof.
// Emails use .invalid addresses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_INVITE_TTL_SECONDS } from '../domain/team/invite';
import type { TeamFile } from '../domain/team/types';
import { deviceKeySecretName, loadDeviceIdentity, sealKeySecretName } from '../team/identity';
import {
  JOIN_REQUEST_PREFIX, acceptJoinRequest, completeJoinRequest, createJoinRequest, parseJoinRequest, readPendingRequest, requestCheckCode
} from '../team/joinRequest';
import type { AcceptResult, CompleteOutcome, JoinRequest } from '../team/joinRequest';
import { GIGA, closeRig, createRig, enable, openLog, publishProject, rootOf, teamIdOf } from './helpers/teamFlowRig';
import type { Participant, Rig, RigOptions } from './helpers/teamFlowRig';

const requestSecretName = (teamId: string): string => `nearAi.team.joinRequest.${teamId}`;

async function withRig(options: RigOptions, run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await createRig(options);
  try {
    await run(rig);
  } finally {
    await closeRig(rig);
  }
}

// The owner turned Team Mode on and published it, so clones b and c hold team.json; nobody but the owner has a device key.
async function sharedTeam(rig: Rig): Promise<TeamFile> {
  await enable(rig);
  await publishProject(rig);
  return rig.teamFile as TeamFile;
}

function ask(rig: Rig, person: Participant, extra: { name?: string; email?: string } = {}): ReturnType<typeof createJoinRequest> {
  return createJoinRequest({ secrets: person.secrets, teamFile: rig.teamFile as TeamFile, name: extra.name ?? person.name, ...(extra.email === undefined ? { email: person.email } : { email: extra.email }) });
}

type AcceptOverrides = Partial<Omit<Parameters<typeof acceptJoinRequest>[0], 'request'>> & { by?: 'owner' | Participant };

async function accept(rig: Rig, request: JoinRequest, email: string, overrides: AcceptOverrides = {}): Promise<AcceptResult> {
  const { by = 'owner', ...rest } = overrides;
  const opened = await openLog(rig, by);
  const globalStorageDir = by === 'owner' ? rig.owner.globalStorageDir : by.globalStorageDir;
  const clone = by === 'owner' ? 'a' : by.clone;
  return acceptJoinRequest({
    projectRoot: rootOf(rig, clone), globalStorageDir, teamFile: rig.teamFile as TeamFile, log: opened.log, request, email,
    role: 'developer', allocationNanoUsd: 5 * GIGA, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS,
    ...(by === 'owner' && rig.owner.org !== undefined ? { org: rig.owner.org } : {}),
    ...rest
  });
}

async function complete(rig: Rig, person: Participant, overrides: Partial<Parameters<typeof completeJoinRequest>[0]> = {}): Promise<CompleteOutcome> {
  const opened = await openLog(rig, person);
  return completeJoinRequest({
    projectRoot: rootOf(rig, person.clone), globalStorageDir: person.globalStorageDir, teamFile: rig.teamFile as TeamFile, secrets: person.secrets,
    state: opened.log.state(), nearBaseUrl: rig.fake.baseUrl, ...overrides
  });
}

function hasTeamKeys(rig: Rig, person: Participant): boolean {
  const teamId = teamIdOf(rig);
  return person.secrets.values.has(deviceKeySecretName(teamId)) || person.secrets.values.has(sealKeySecretName(teamId));
}

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: a person with a copy asks, the owner accepts, and the copy joins by itself with no code travelling', async () => {
  await withRig({ linked: false }, async (rig) => {
    await sharedTeam(rig);
    const teamId = teamIdOf(rig);
    const dev = rig.dev;

    // On clone b: the request text and the check code; the code itself stays in SecretStorage.
    const asked = await ask(rig, dev);
    assert.ok(asked.text.startsWith(JOIN_REQUEST_PREFIX), 'the request text has the join-request prefix');
    assert.match(asked.checkCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, 'the check code is 8 characters in two groups');
    assert.ok(dev.secrets.values.has(requestSecretName(teamId)), 'the request is kept in SecretStorage for this team');
    const again = await ask(rig, dev);
    assert.deepEqual(again, asked, 'asking again gives the stored request back');
    const pending = await readPendingRequest(dev.secrets, teamId);
    assert.deepEqual(pending, { text: asked.text, checkCode: asked.checkCode, memberId: asked.memberId, name: dev.name });

    // Before any accept there is nothing to join and nothing changes.
    assert.deepEqual(await complete(rig, dev), { kind: 'not-yet' });
    assert.equal(hasTeamKeys(rig, dev), false, 'no device or seal key before the accept');

    // On clone a: the owner reads the request and accepts it.
    const request = parseJoinRequest(asked.text);
    assert.equal(request.team, teamId);
    assert.equal(request.member, asked.memberId);
    assert.equal(request.name, dev.name);
    assert.equal(request.email, dev.email);
    assert.equal(requestCheckCode(request), asked.checkCode, 'both people see the same check code');
    const accepted = await accept(rig, request, dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    assert.equal(accepted.ok && accepted.memberId, asked.memberId);
    assert.equal(accepted.ok && accepted.nearInvitation, 'not-applicable');
    assert.equal('bundle' in accepted, false, 'an accepted request hands back no invite text');
    const owner = await openLog(rig, 'owner');
    const invited = owner.log.state().members.get(asked.memberId);
    assert.equal(invited?.status, 'invited');
    assert.equal(invited?.invite?.publicKey, request.key, 'the invitation is bound to the key the request carried');
    assert.equal(invited?.pendingRole, 'developer');
    assert.equal(invited?.name, dev.name);

    // Back on clone b: it finds its invitation and joins by itself.
    const done = await complete(rig, dev);
    assert.equal(done.kind, 'joined', JSON.stringify(done));
    if (done.kind !== 'joined') return;
    assert.equal(done.result.memberId, asked.memberId);
    assert.equal(done.result.role, 'observer', 'the person joins as an observer until confirmed');
    assert.equal(done.result.pendingRole, 'developer');
    const identity = await loadDeviceIdentity(dev.secrets, teamId);
    assert.ok(identity !== undefined, 'clone b made its own device key');
    await owner.log.sync();
    const joined = owner.log.state().members.get(asked.memberId);
    assert.equal(joined?.status, undefined, 'the invitation is used');
    assert.equal(joined?.role, 'observer');
    assert.equal(joined?.pendingRole, 'developer');
    assert.equal(owner.log.state().deviceIndex.get(identity?.fingerprint as string), asked.memberId, 'the join is signed by clone b\'s new device key');
    assert.equal(owner.log.state().refused, undefined);
    assert.equal(dev.secrets.values.has(requestSecretName(teamId)), false, 'the stored request is forgotten after the join');
    assert.equal(await readPendingRequest(dev.secrets, teamId), undefined);
    assert.deepEqual(await complete(rig, dev), { kind: 'none' }, 'a second completion has nothing to do');
  });
});
