// The whole Team Mode membership lifecycle on three real clones and the fake NEAR server (Phase 61 plan 14, success criterion 3): enable, link the
// NEAR organization, invite a developer and a lead, join, confirm, key delivery, removal by a lead through their kept NEAR session, and the removed
// computer cleaning up. The same lifecycle in a team with no NEAR organization makes no organization or workspace-key call (D-04). The steps are in
// helpers/teamFlowRig.ts; this file is what they must add up to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProfileId } from '../domain/auth';
import { serialiseState } from '../domain/team/materialize';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { CleanupChecklist } from '../team/cleanupChecklist';
import { deviceKeySecretName, sealKeySecretName } from '../team/identity';
import { NO_ORG_NOTICE } from '../team/join';
import { REMOVED_FILE, readRemovedMarker } from '../team/removedClient';
import { readTeamFile } from '../team/teamFile';
import { OWN_KEY_PROFILE_NAME, readInstalledKey, teamProfileId } from '../team/teamKeyProfile';
import {
  GIGA, LEAD_EMAIL, NEAR_LINK, PERSONAL_PROFILE, activeProfileOf, closeRig, confirm, createRig, enable, givePersonalProfile, installKey, invite, join,
  link, openLog, ownRemoval, publishProject, remove, rootOf, storageOf, teamIdOf
} from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { gitIn } from './helpers/teamHarness';

async function withRig(linked: boolean, run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await createRig({ linked });
  try {
    await run(rig);
  } finally {
    await closeRig(rig);
  }
}

// The status code NEAR answers for a key, by asking the one route a key authenticates by itself.
async function checkKey(rig: Rig, secret: string): Promise<number> {
  const response = await fetch(`${rig.fake.baseUrl}/check_api_key`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
  return response.status;
}

async function memberKeyId(rig: Rig, person: Participant): Promise<string> {
  const opened = await openLog(rig, 'owner');
  const keyId = opened.log.state().members.get(person.memberId as string)?.nearApiKeyId;
  assert.ok(keyId !== undefined, `${person.name} has a key in the log`);
  return keyId as string;
}

// Every computer ends with the same team state once each has synced (criterion 1 of the log, shown here across the whole lifecycle).
async function assertSameState(rig: Rig): Promise<void> {
  const owner = await openLog(rig, 'owner');
  const lead = await openLog(rig, rig.lead);
  const dev = await openLog(rig, rig.dev);
  const expected = serialiseState(owner.log.state());
  assert.equal(serialiseState(lead.log.state()), expected, 'the lead sees the owner\'s state');
  assert.equal(serialiseState(dev.log.state()), expected, 'the removed developer sees the same state');
}

const isCheck = (path: string): boolean => path === '/v1/check_api_key';

test('tracer: enable, link, invite a developer and a lead, join, confirm, deliver keys, remove through the lead, clean up the removed computer', async () => {
  await withRig(true, async (rig) => {
    // The owner enables Team Mode, links the organization, and pushes the project so the teammates' clones have team.json with the link.
    const enabled = await enable(rig);
    assert.equal(enabled.teamFile.near, undefined, 'a new team has no organization yet');
    const linked = await link(rig);
    assert.equal(linked.status, 'linked');
    await publishProject(rig);
    const teamId = teamIdOf(rig);
    for (const clone of ['b', 'c'] as const) {
      assert.deepEqual((await readTeamFile(rootOf(rig, clone)))?.near, NEAR_LINK, `clone ${clone} pulled the link`);
    }
    await givePersonalProfile(rig, rig.dev);
    assert.equal(await activeProfileOf(rig, rig.dev), PERSONAL_PROFILE);

    // Invitations: only the lead is invited to the NEAR organization, and as an admin (D-21, D-22).
    const developerInvite = await invite(rig, rig.dev);
    assert.equal(developerInvite.nearInvitation, 'not-applicable');
    const leadInvite = await invite(rig, rig.lead);
    assert.equal(leadInvite.nearInvitation, 'sent');
    const pending = await rig.owner.org?.listInvitations(NEAR_LINK.organizationId, 'pending');
    assert.deepEqual(pending?.map((entry) => [entry.email, entry.role]), [[LEAD_EMAIL, 'admin']]);

    // The developer joins without a NEAR login and without one request to NEAR.
    const beforeDeveloper = rig.fake.requests.length;
    const developerJoin = await join(rig, rig.dev);
    assert.equal(rig.fake.requests.length, beforeDeveloper, 'the developer\'s join made no NEAR request');
    assert.equal(developerJoin.key, 'awaiting-lead');
    assert.equal(developerJoin.pendingRole, 'developer');
    assert.equal(developerJoin.nearInvitation, undefined);

    // The lead joins with a NEAR sign-in and accepts the organization invitation as an admin.
    const leadJoin = await join(rig, rig.lead);
    assert.equal(leadJoin.nearInvitation, 'accepted');
    const members = await rig.owner.org?.listMembers(NEAR_LINK.organizationId);
    assert.deepEqual(members?.find((member) => member.userId === 'user-lead')?.role, 'admin', 'NEAR shows the lead as an admin');
    assert.equal(rig.fake.requests.filter((request) => request.path.endsWith('/accept') && request.auth === 'session').length, 1, 'one invitation was accepted');

    // The owner confirms the lead and then the developer; each key is made with the allocation as its limit and delivered sealed.
    const leadConfirm = await confirm(rig, rig.lead);
    assert.equal(leadConfirm.key, 'delivered');
    const developerConfirm = await confirm(rig, rig.dev);
    assert.equal(developerConfirm.key, 'delivered');
    const devKeyId = await memberKeyId(rig, rig.dev);
    const leadKeyId = await memberKeyId(rig, rig.lead);
    assert.equal(rig.fake.key(devKeyId)?.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(rig.fake.key(leadKeyId)?.spendLimitNanoUsd, 20 * GIGA);

    // Each computer installs only the key sealed to it and makes it the project's active credential.
    assert.deepEqual(await installKey(rig, rig.dev), { status: 'installed', keyId: devKeyId });
    assert.deepEqual(await installKey(rig, rig.lead), { status: 'installed', keyId: leadKeyId });
    assert.equal(await activeProfileOf(rig, rig.dev), teamProfileId(teamId));
    assert.equal((await readInstalledKey(rig.dev.globalStorageDir, teamId))?.keyId, devKeyId);
    assert.equal((await readInstalledKey(rig.dev.globalStorageDir, teamId))?.previousProfileId, PERSONAL_PROFILE);
    const devSecret = rig.fake.key(devKeyId)?.secret as string;
    const leadSecret = rig.fake.key(leadKeyId)?.secret as string;
    assert.equal(await checkKey(rig, devSecret), 200, 'the developer\'s key works');

    // The developer's own window is ready to see its removal later: it holds a signing log from before.
    const developerWindow = await openLog(rig, rig.dev);
    assert.ok(developerWindow.memberId !== undefined);

    // The lead removes the developer from their own computer through the NEAR session kept from joining.
    const before = rig.fake.requests.length;
    const removed = await remove(rig, rig.lead, rig.dev);
    assert.equal(removed.kind, 'removed');
    assert.equal(removed.keyStillSpends, false);

    // Order at NEAR: the limit goes to 0, the removal reaches the coordination branch, and only then is the key revoked.
    const sent = rig.fake.requests.slice(before);
    const zeroAt = sent.findIndex((request) => request.method === 'PATCH' && request.path.endsWith(`/api-keys/${devKeyId}/spend-limit`));
    const revokeAt = sent.findIndex((request) => request.method === 'DELETE' && request.path.endsWith(`/api-keys/${devKeyId}`));
    assert.ok(zeroAt >= 0 && revokeAt >= 0, 'both NEAR calls were made');
    assert.ok(zeroAt < revokeAt, 'the spend-limit PATCH precedes the key DELETE');
    const capCall = rig.leadCalls.find((call) => call.method === 'PATCH' && call.path.endsWith(`/api-keys/${devKeyId}/spend-limit`));
    const revokeCall = rig.leadCalls.find((call) => call.method === 'DELETE' && call.path.endsWith(`/api-keys/${devKeyId}`));
    assert.ok(capCall !== undefined && revokeCall !== undefined);
    assert.equal(revokeCall.remoteEvents, capCall.remoteEvents + 1, 'exactly one event, the removal, was pushed between the cap and the revoke');
    assert.equal(rig.fake.key(devKeyId)?.spendLimitNanoUsd, 0);
    assert.equal(rig.fake.key(devKeyId)?.revoked, true);
    assert.equal(await checkKey(rig, devSecret), 401, 'the revoked key is refused');
    assert.equal(await checkKey(rig, leadSecret), 200, 'the lead\'s own key is untouched');
    assert.deepEqual((await new CleanupChecklist(storageOf(rig, rig.lead)).forMember(rig.dev.memberId as string)).map((item) => `${item.step}:${item.status}`), ['repo-access:manual']);

    // The developer's next write is refused, and the developer's computer then cleans itself.
    await developerWindow.log.sync();
    const attempt = await developerWindow.log.append(() => [{ type: 'member.availability', body: { availability: 'focus' } }]);
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.match(attempt.reason, /removed/, attempt.reason);
    const cleaned = await ownRemoval(rig, rig.dev);
    assert.equal(cleaned.restoredProfileId, PERSONAL_PROFILE);
    assert.equal(cleaned.failed, undefined);
    assert.equal(await activeProfileOf(rig, rig.dev), PERSONAL_PROFILE, 'the personal profile is back');
    assert.equal(rig.dev.secrets.values.has(deviceKeySecretName(teamId)), false, 'the device key is gone');
    assert.equal(rig.dev.secrets.values.has(sealKeySecretName(teamId)), false, 'the seal key is gone');
    assert.notEqual(await readRemovedMarker(rig.dev.globalStorageDir, teamId), undefined, `${REMOVED_FILE} was written`);
    assert.equal(await readInstalledKey(rig.dev.globalStorageDir, teamId), undefined);

    // The project's code was never touched by any of this: clone b still has only its own commits.
    assert.equal(gitIn(rootOf(rig, 'b'), ['status', '--porcelain', '--untracked-files=no']), '');
    await assertSameState(rig);
  });
});

test('the same lifecycle in a team with no NEAR organization uses the members\' own keys and makes no organization or workspace-key call', async () => {
  await withRig(false, async (rig) => {
    await enable(rig);
    await publishProject(rig);
    const teamId = teamIdOf(rig);
    assert.equal((await readTeamFile(rootOf(rig, 'b')))?.near, undefined);
    await givePersonalProfile(rig, rig.dev);
    const baseline = rig.fake.requests.length;

    assert.equal((await invite(rig, rig.dev)).nearInvitation, 'not-applicable');
    assert.equal((await invite(rig, rig.lead)).nearInvitation, 'not-applicable', 'a lead is not invited to an organization that is not linked');
    const developerJoin = await join(rig, rig.dev);
    assert.equal(developerJoin.key, 'installed', 'the pasted key was checked and installed');
    assert.ok(developerJoin.notices.includes(NO_ORG_NOTICE), 'the member is told spend is not capped');
    const leadJoin = await join(rig, rig.lead);
    assert.equal(leadJoin.key, 'installed');
    assert.equal(leadJoin.nearInvitation, undefined);

    assert.equal((await confirm(rig, rig.lead)).key, 'not-applicable');
    assert.equal((await confirm(rig, rig.dev)).key, 'not-applicable');
    // D-21 as amended by the owner in the 0.6.4 re-test (2026-11-05): the pasted key is the person's own, so it is their own profile 'My NEAR AI
    // key', selected, not the team key profile; no team key was installed, so nothing remembers a profile to go back to.
    const ownProfile = deriveProfileId(rootOf(rig, rig.dev.clone), OWN_KEY_PROFILE_NAME);
    assert.equal(await activeProfileOf(rig, rig.dev), ownProfile);
    assert.notEqual(ownProfile, teamProfileId(teamId));
    assert.equal(await readInstalledKey(rig.dev.globalStorageDir, teamId), undefined);

    const developerWindow = await openLog(rig, rig.dev);
    const removed = await remove(rig, rig.lead, rig.dev);
    assert.equal(removed.kind, 'removed');
    assert.equal(removed.keyStillSpends, false, 'there is no team key to cap');
    assert.deepEqual(removed.checklist.map((item) => `${item.step}:${item.status}`), ['repo-access:manual']);
    assert.equal(rig.leadCalls.length, 0, 'the lead made no NEAR call');

    await developerWindow.log.sync();
    const attempt = await developerWindow.log.append(() => [{ type: 'member.availability', body: { availability: 'focus' } }]);
    assert.equal(attempt.ok, false);
    const cleaned = await ownRemoval(rig, rig.dev);
    // The own profile is the person's, so the removal keeps it selected (D-21 as amended in the 0.6.4 re-test); the personal profile is untouched.
    assert.equal(cleaned.restoredProfileId, undefined);
    assert.equal(await activeProfileOf(rig, rig.dev), ownProfile);
    assert.ok(await new ProfileStore(rootOf(rig, rig.dev.clone), new AuthService(rig.dev.secrets)).get(PERSONAL_PROFILE), 'the personal profile is still there');
    assert.equal(rig.dev.secrets.values.has(deviceKeySecretName(teamId)), false);

    // Everything NEAR was asked since the invitations: the two key checks of the pasted keys, nothing else.
    const asked = rig.fake.requests.slice(baseline);
    assert.deepEqual(asked.filter((request) => !isCheck(request.path)), [], 'no organization, workspace, invitation or key-management call');
    assert.equal(asked.length, 2);
    assert.ok(asked.every((request) => request.auth === 'api-key'), 'only the members\' own keys spoke to NEAR');
    assert.equal(asked.filter((request) => request.method === 'DELETE' || request.method === 'PATCH').length, 0);
    await assertSameState(rig);
  });
});
