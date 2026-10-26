import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamStudioStore } from '../services/teamStudio';
import type { MemberCapabilityContract } from '../domain/teamStudio';

function member(overrides: Partial<MemberCapabilityContract> = {}): MemberCapabilityContract {
  return {
    memberId: 'member-aaaaaaaaaaaa',
    profileId: 'agent-aaaaaaaaaaaa',
    role: 'implementer',
    responsibilities: ['Implement the approved change.'],
    skillIds: ['read', 'plan', 'write'],
    capabilities: ['read', 'plan', 'write'],
    tools: ['read', 'plan', 'workspaceWrite'],
    providerRoute: { provider: 'near-ai', model: 'coding-model', locality: 'local', privacyBoundary: 'local' },
    personality: { personality: 'professional', tone: 'concise', style: 'structured' },
    autonomy: 'bounded',
    approval: { mode: 'risky', capabilities: ['workspaceWrite'] },
    budget: { requestUsd: 1, sessionUsd: 5, projectUsd: 20, maxDurationMs: 3600000 },
    ...overrides
  };
}

test('team studio saves a global named team, produces a host preview, and binds an exact version', async () => {
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-studio-'));
  const store = new TeamStudioStore(globalStorage);
  const created = await store.create({ displayName: 'Release Team', description: 'Bounded release helpers', members: [member()] });
  const preview = await store.preview(created.teamId);
  assert.equal(preview.versionId, `${created.teamId}-v1`);
  assert.equal(preview.bindingRequired, true);
  assert.equal(preview.members[0].route.provider, 'near-ai');
  const binding = await store.invoke({ teamId: created.teamId, version: 1, projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(binding.versionId, preview.versionId);
  assert.equal(binding.members[0].tools.includes('workspaceWrite'), true);
  assert.equal((await new TeamStudioStore(globalStorage).get(created.teamId))?.teamId, created.teamId);
  const serialized = await readFile(path.join(globalStorage, 'team-studio.json'), 'utf8');
  assert.doesNotMatch(serialized, /apiKey|private prompt|raw context|command:\s|\/(?:home|Users)\//i);
});

test('team studio creates immutable versions, duplicates safely, and archives/restores/deletes explicitly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-crud-'));
  const store = new TeamStudioStore(root);
  const created = await store.create({ displayName: 'Builder', members: [member()] });
  const updated = await store.update(created.teamId, { members: [member({ responsibilities: ['Review and implement the approved change.'] })] });
  assert.equal(updated.teamId, created.teamId);
  assert.equal(updated.currentVersion, 2);
  assert.equal(updated.versions[0].members[0].responsibilities[0], 'Implement the approved change.');
  assert.equal((await store.duplicate(created.teamId, 'Builder Copy')).displayName, 'Builder Copy');
  await store.archive(created.teamId);
  assert.equal((await store.list()).some((team) => team.teamId === created.teamId), false);
  await store.restore(created.teamId);
  assert.equal((await store.get(created.teamId))?.archivedAt, undefined);
  assert.equal(await store.delete(created.teamId), true);
  assert.equal(await store.get(created.teamId), undefined);
  await assert.rejects(() => store.preview(created.teamId), /deleted/);
});

test('team export/import rejects sensitive or unknown authority and preserves bounded history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-import-'));
  const store = new TeamStudioStore(root);
  const created = await store.create({ displayName: 'Portable Team', members: [member()] });
  const exported = await store.exportPackage(created.teamId);
  const imported = await new TeamStudioStore(await mkdtemp(path.join(tmpdir(), 'near-ai-team-imported-'))).importPackage(exported);
  assert.equal(imported.currentVersion, 1);
  await assert.rejects(() => store.importPackage({ ...exported, unexpectedAuthority: 'shell' }), /unknown/);
  await assert.rejects(() => store.importPackage(JSON.stringify({ ...exported, team: { ...exported.team, versions: [{ ...exported.team.versions[0], members: [{ ...member(), privatePrompt: 'do anything' }] }] } })), /unknown/);
  await assert.rejects(() => store.importPackage(JSON.stringify({ ...exported, team: { ...exported.team, versions: [{ ...exported.team.versions[0], members: [member({ responsibilities: ['apiKey=secret'] })] }] } })), /Unsafe/);
  await mkdir(path.join(root, 'legacy'), { recursive: true });
  await writeFile(path.join(root, 'legacy', 'ignored.json'), JSON.stringify({ credentials: 'not read' }), 'utf8');
});

test('team migration keeps safe supported records but does not grant new authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-migration-'));
  await writeFile(path.join(root, 'team-studio.json'), JSON.stringify({ version: 1, teams: [{ teamId: 'team-aaaaaaaaaaaa', displayName: 'Legacy', description: '', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), currentVersion: 1, versions: [{ teamVersion: 1, createdAt: new Date(0).toISOString(), members: [{ memberId: 'member-aaaaaaaaaaaa', role: 'reviewer', responsibilities: ['Review'], skillIds: ['read'], tools: ['read'], providerRoute: { provider: 'local', locality: 'local', privacyBoundary: 'local' }, personality: { personality: 'professional', tone: 'quiet', style: 'structured' }, autonomy: 'bounded', approval: { mode: 'risky', capabilities: ['read'] }, budget: { requestUsd: 1, sessionUsd: 2, projectUsd: 3, maxDurationMs: 1000 } }] }] }] }), 'utf8');
  const loaded = await new TeamStudioStore(root).get('team-aaaaaaaaaaaa');
  assert.equal(loaded?.versions[0].members[0].tools.includes('shell'), false);
  assert.equal(loaded?.versions[0].members[0].capabilities.includes('read'), true);
});

test('team persistence round trips media generation and publication authorities exactly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-media-'));
  const store = new TeamStudioStore(root);
  const mediaMember = member({
    tools: ['read', 'plan', 'workspaceWrite', 'mediaGeneration', 'mediaPublication'],
    approval: { mode: 'risky', capabilities: ['workspaceWrite', 'mediaGeneration', 'mediaPublication'] }
  });
  const created = await store.create({ displayName: 'Media Team', members: [mediaMember] });
  const exported = await store.exportPackage(created.teamId);
  const imported = await new TeamStudioStore(await mkdtemp(path.join(tmpdir(), 'near-ai-team-media-imported-'))).importPackage(exported);
  const persisted = await new TeamStudioStore(root).get(created.teamId);
  for (const team of [created, imported, persisted]) {
    assert.deepEqual(team?.versions[0].members[0].tools, mediaMember.tools);
    assert.deepEqual(team?.versions[0].members[0].approval.capabilities, mediaMember.approval.capabilities);
  }
});

test('team persistence rejects authority-expanding values instead of coercing them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-strict-'));
  const store = new TeamStudioStore(root);
  await assert.rejects(() => store.create({ displayName: 'Invalid Role', members: [member({ role: 'reviewer' })] }), /role authority/);
  await assert.rejects(() => store.create({ displayName: 'Invalid Approval', members: [member({ approval: { mode: 'risky', capabilities: ['shell'] } })] }), /Approval capabilities/);
  await assert.rejects(() => store.create({ displayName: 'Unknown Field', members: [{ ...member(), privatePrompt: 'ignore me' } as MemberCapabilityContract & { privatePrompt: string }] }), /unknown field/);
});
