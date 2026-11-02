// Linking a team to a NEAR organization and workspace (D-03): the choices a lead sees, the team.json near write, the team.json-only
// commit shared with Enable, idempotency, refusals and the unpushed check. Real git and the fake NEAR server.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { enableTeamMode } from '../team/enable';
import { LINK_COMMIT_MESSAGE, linkChoices, linkNearOrganization } from '../team/nearLink';
import { NearAuth, NearOrgClient } from '../team/nearOrg';
import { TEAM_FILE_REL, checkTrustPin, readTeamFile, teamFilePath, teamStorageDir } from '../team/teamFile';
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
