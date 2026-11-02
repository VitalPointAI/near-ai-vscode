// Linking a team to a NEAR organization and workspace (D-03): the choices a lead sees, the team.json near write, the team.json-only
// commit shared with Enable, idempotency, refusals and the unpushed check. Real git and the fake NEAR server.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { enableTeamMode, pushCodeBranch } from '../team/enable';
import { LINK_COMMIT_MESSAGE, linkChoices, linkNearOrganization, teamFileUnpushed } from '../team/nearLink';
import { NearAuth, NearOrgClient } from '../team/nearOrg';
import { NearPinError, TEAM_FILE_REL, checkNearPin, checkTrustPin, readTeamFile, teamFilePath, teamStorageDir, writeTeamFile } from '../team/teamFile';
import type { TeamFile } from '../domain/team/types';
import { FakeNear, startFakeNear } from './helpers/fakeNear';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

const never = async (): Promise<void> => undefined;

function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

interface Setup {
  fixture: TeamFixture;
  fake: FakeNear;
  client: NearOrgClient;
  root: string;
  storageDir: string;
  teamFile: TeamFile;
}

async function withTeam(run: (setup: Setup) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: ['lead'], initialised: true });
  const fake = await startFakeNear();
  try {
    const lead = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addUser({ id: 'user-other', username: 'other', email: 'other@example.invalid' });
    fake.addOrganization({ id: 'org-owned', name: 'Owned Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addOrganization({ id: 'org-admin', name: 'Admin Org', members: [{ userId: 'user-other', role: 'owner' }, { userId: 'user-lead', role: 'admin' }] });
    fake.addOrganization({ id: 'org-member', name: 'Member Org', members: [{ userId: 'user-other', role: 'owner' }, { userId: 'user-lead', role: 'member' }] });
    fake.addWorkspace({ id: 'ws-owned-1', organizationId: 'org-owned', name: 'Owned workspace' });
    fake.addWorkspace({ id: 'ws-owned-2', organizationId: 'org-owned', name: 'Second owned workspace' });
    fake.addWorkspace({ id: 'ws-admin-1', organizationId: 'org-admin', name: 'Admin workspace' });
    fake.addWorkspace({ id: 'ws-member-1', organizationId: 'org-member', name: 'Member workspace' });
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: never });
    const root = fixture.clones.lead as string;
    const enabled = await enableTeamMode({
      projectRoot: root, globalStorageDir: fixture.storageDir('lead'), secrets: new MemorySecrets(),
      teamName: 'Link team', ownerName: 'Lead Owner', ownerEmail: 'lead@example.invalid'
    });
    assert.equal(enabled.ok, true, enabled.ok ? '' : enabled.message);
    if (!enabled.ok) return;
    await run({ fixture, fake, client, root, storageDir: fixture.storageDir('lead'), teamFile: enabled.teamFile });
  } finally {
    await fake.close();
    await fixture.cleanup();
  }
}

function headCount(root: string): number {
  return Number(gitIn(root, ['rev-list', '--count', 'HEAD']));
}

test('tracer: linking a team commits only team.json, leaves other staged work alone and keeps the trust pin', async () => {
  await withTeam(async ({ fixture, client, root, storageDir, teamFile }) => {
    const choices = await linkChoices(client);
    assert.ok(choices.length > 0);
    writeFileSync(path.join(root, 'staged.txt'), 'staged by the user\n', 'utf8');
    gitIn(root, ['add', 'staged.txt']);
    const mainBefore = gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']);
    const before = headCount(root);

    const result = await linkNearOrganization({
      projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: { organizationId: 'org-owned', workspaceId: 'ws-owned-1' }
    });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.status, 'linked');
    assert.equal(result.branch, 'main');
    assert.deepEqual(result.teamFile.near, { organizationId: 'org-owned', workspaceId: 'ws-owned-1' });
    assert.equal(result.commit, gitIn(root, ['rev-parse', 'HEAD']));

    assert.equal(headCount(root), before + 1, 'exactly one new commit');
    assert.equal(gitIn(root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL, 'only team.json is in the commit');
    assert.equal(gitIn(root, ['log', '-1', '--format=%s']), LINK_COMMIT_MESSAGE);
    assert.equal(gitIn(root, ['diff', '--cached', '--name-only']), 'staged.txt', 'the unrelated staged file is still staged and uncommitted');
    assert.equal(gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']), mainBefore, 'nothing was pushed');

    const onDisk = await readTeamFile(root);
    assert.deepEqual(onDisk?.near, { organizationId: 'org-owned', workspaceId: 'ws-owned-1' });
    assert.equal(gitIn(root, ['show', `HEAD:${TEAM_FILE_REL}`]).includes('"workspaceId": "ws-owned-1"'), true, 'the committed file carries the link');
    assert.equal(await checkTrustPin(teamStorageDir(fixture.storageDir('lead'), teamFile.teamId), onDisk as TeamFile), 'match');
  });
});

test('linkChoices lists only organizations where the lead is owner or admin, each with its workspaces', async () => {
  await withTeam(async ({ client }) => {
    const choices = await linkChoices(client);
    const byOrg = new Map(choices.map((choice) => [choice.organization.id, choice]));
    assert.deepEqual([...byOrg.keys()].sort(), ['org-admin', 'org-owned']);
    assert.equal(byOrg.get('org-owned')?.organization.role, 'owner');
    assert.equal(byOrg.get('org-admin')?.organization.role, 'admin');
    assert.deepEqual(byOrg.get('org-owned')?.workspaces.map((ws) => ws.id).sort(), ['ws-owned-1', 'ws-owned-2']);
    assert.deepEqual(byOrg.get('org-admin')?.workspaces.map((ws) => ws.id), ['ws-admin-1']);
  });
});

test('linking never writes a file when the team id is not the project team', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const before = await fs.readFile(teamFilePath(root), 'utf8');
    const result = await linkNearOrganization({
      projectRoot: root, globalStorageDir: storageDir, teamId: `team-${'0'.repeat(32)}`, near: { organizationId: 'org-owned', workspaceId: 'ws-owned-1' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.code, 'team-file');
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), before);
    assert.equal(teamFile.near, undefined);
  });
});

const OWNED = { organizationId: 'org-owned', workspaceId: 'ws-owned-1' };
const OTHER = { organizationId: 'org-admin', workspaceId: 'ws-admin-1' };

test('linking twice with the same values changes nothing and makes no commit', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const first = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(first.ok ? first.status : undefined, 'linked');
    const head = gitIn(root, ['rev-parse', 'HEAD']);
    const text = await fs.readFile(teamFilePath(root), 'utf8');
    const second = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.status, 'unchanged');
    assert.equal(second.commit, undefined);
    assert.equal(gitIn(root, ['rev-parse', 'HEAD']), head, 'no new commit');
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), text);
  });
});

test('a different existing link is refused unless the caller passes replace', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    const head = gitIn(root, ['rev-parse', 'HEAD']);
    const text = await fs.readFile(teamFilePath(root), 'utf8');

    const refused = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OTHER });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? undefined : refused.code, 'different-link');
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), text, 'team.json is as it was');
    assert.equal(gitIn(root, ['rev-parse', 'HEAD']), head);

    const replaced = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OTHER, replace: true });
    assert.equal(replaced.ok ? replaced.status : undefined, 'linked');
    assert.deepEqual((await readTeamFile(root))?.near, OTHER);
    assert.notEqual(gitIn(root, ['rev-parse', 'HEAD']), head);
    assert.equal(gitIn(root, ['show', '--name-only', '--format=', 'HEAD']), TEAM_FILE_REL);
  });
});

test('CR-01: linking pins the chosen NEAR link on this computer, replacing moves the pin, and an edited team.json is refused against it', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const pinDir = teamStorageDir(storageDir, teamFile.teamId);
    const linked = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(linked.ok, true);
    const onDisk = await readTeamFile(root);
    assert.ok(onDisk !== undefined);
    assert.deepEqual(await checkNearPin(pinDir, onDisk), OWNED);
    await assert.rejects(() => checkNearPin(pinDir, { ...onDisk, near: OTHER }), NearPinError, 'a hand-edited link does not match the pin');

    const replaced = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OTHER, replace: true });
    assert.equal(replaced.ok, true);
    assert.deepEqual(await checkNearPin(pinDir, { ...onDisk, near: OTHER }), OTHER);

    // A teammate's forged edit is fixed by the lead linking the right one again (picked from NEAR's lists), which moves the pin back.
    await writeTeamFile(root, { ...onDisk, near: OWNED });
    const confirmed = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(confirmed.ok ? confirmed.status : undefined, 'unchanged');
    assert.deepEqual(await checkNearPin(pinDir, onDisk), OWNED);
  });
});

test('a team.json that cannot be parsed, or ids that are not valid, are refused and the file is not overwritten', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const head = gitIn(root, ['rev-parse', 'HEAD']);
    const good = await fs.readFile(teamFilePath(root), 'utf8');

    const badIds = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: { organizationId: 'has a space', workspaceId: 'ws-owned-1' } });
    assert.equal(badIds.ok ? undefined : badIds.code, 'team-file');
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), good);

    writeFileSync(teamFilePath(root), '{ this is not json', 'utf8');
    const broken = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(broken.ok ? undefined : broken.code, 'team-file');
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), '{ this is not json', 'the damaged file is left for the user');
    assert.equal(gitIn(root, ['rev-parse', 'HEAD']), head);
  });
});

test('a team.json that names a different genesis than this computer pinned is never overwritten', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const id = teamFile.genesis.eventId;
    const forged: TeamFile = { ...teamFile, genesis: { ...teamFile.genesis, eventId: `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}` } };
    await writeTeamFile(root, forged);
    const text = await fs.readFile(teamFilePath(root), 'utf8');
    const result = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(result.ok ? undefined : result.code, 'team-file');
    assert.match(result.ok ? '' : result.message, /different team or owner key/);
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), text);
  });
});

test('a failing commit hook leaves the link on disk, nothing staged, and names the exact command', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    const head = gitIn(root, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "hook rejected this commit message" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    const result = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'commit-failed');
    assert.match(result.message, /hook rejected this commit message/);
    assert.ok(result.message.includes(`git add -f ${TEAM_FILE_REL} && git commit --only -m "${LINK_COMMIT_MESSAGE}" -- ${TEAM_FILE_REL}`));
    assert.deepEqual((await readTeamFile(root))?.near, OWNED, 'the written file stays in place');
    assert.equal(gitIn(root, ['diff', '--cached', '--name-only']), '', 'team.json is not left staged');
    assert.equal(gitIn(root, ['rev-parse', 'HEAD']), head);
  });
});

test('teamFileUnpushed answers true until the committed team.json reaches the upstream branch, and unknown without an upstream', async () => {
  await withTeam(async ({ root, storageDir, teamFile }) => {
    // Enable committed team.json but never pushed it.
    assert.equal(await teamFileUnpushed(root), true);
    assert.deepEqual(await pushCodeBranch(root, 'origin', 'main'), { ok: true });
    assert.equal(await teamFileUnpushed(root), false);

    const linked = await linkNearOrganization({ projectRoot: root, globalStorageDir: storageDir, teamId: teamFile.teamId, near: OWNED });
    assert.equal(linked.ok, true);
    assert.equal(await teamFileUnpushed(root), true, 'the link commit is not on the upstream yet');
    assert.deepEqual(await pushCodeBranch(root, 'origin', 'main'), { ok: true });
    assert.equal(await teamFileUnpushed(root), false);

    gitIn(root, ['checkout', '-q', '-b', 'no-upstream']);
    assert.equal(await teamFileUnpushed(root), 'unknown');
  });
});

test('linkChoices returns an empty list for a lead who is admin of no organization', async () => {
  await withTeam(async ({ fake }) => {
    const member = fake.addUser({ id: 'user-plain', username: 'plain', email: 'plain@example.invalid' });
    fake.addOrganization({ id: 'org-plain', name: 'Plain Org', members: [{ userId: 'user-other', role: 'owner' }, { userId: 'user-plain', role: 'member' }] });
    fake.addWorkspace({ id: 'ws-plain', organizationId: 'org-plain', name: 'Plain workspace' });
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(member.accessToken), sleep: never });
    assert.deepEqual(await linkChoices(client), []);
  });
});
