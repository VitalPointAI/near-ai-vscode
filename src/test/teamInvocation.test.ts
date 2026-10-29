import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamStudioStore } from '../services/teamStudio';
import { ProjectInitialization } from '../services/projectInitialization';
import { AgentProfileStore } from '../services/agentProfiles';
import { AgentOrchestrator } from '../services/agentOrchestrator';
import { invokeBoundTeam } from '../services/agentOrchestrator';
import type { MemberCapabilityContract } from '../domain/teamStudio';

const answers = { goal: 'Ship a bounded team feature', riskLevel: 'high' as const, preferredProvider: 'near-ai', locality: 'local' as const, workShape: 'feature' as const };
function member(): MemberCapabilityContract { return { memberId: 'member-bbbbbbbbbbbb', profileId: 'agent-bbbbbbbbbbbb', role: 'implementer', responsibilities: ['Implement the selected project change.'], skillIds: ['read', 'plan', 'write'], capabilities: ['read', 'plan', 'write'], tools: ['read', 'plan', 'workspaceWrite'], providerRoute: { provider: 'near-ai', model: 'coding-model', locality: 'local', privacyBoundary: 'local' }, personality: { personality: 'direct', tone: 'concise', style: 'checklist' }, autonomy: 'bounded', approval: { mode: 'risky', capabilities: ['workspaceWrite'] }, budget: { requestUsd: 2, sessionUsd: 8, projectUsd: 30, maxDurationMs: 3600000 } }; }

test('explicit project binding rehydrates the exact selected team version and survives global edits', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-binding-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-global-'));
  const studio = new TeamStudioStore(globalStorage);
  const team = await studio.create({ displayName: 'Bound Builder', members: [member()] });
  const initialization = new ProjectInitialization(project);
  const recommendation = (await initialization.initialize(answers)).recommendation;
  await initialization.accept(recommendation, answers);
  const binding = await studio.bindProject(project, { teamId: team.teamId, version: 1, projectId: 'project-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, initialization);
  await studio.update(team.teamId, { members: [{ ...member(), providerRoute: { ...member().providerRoute, model: 'different-model' } }] });
  const rehydrated = await new ProjectInitialization(project).requireReusableBinding();
  assert.equal(rehydrated.versionId, binding.versionId);
  assert.equal(rehydrated.members[0].providerRoute.model, 'coding-model');
  assert.doesNotMatch(await readFile(path.join(project, '.planning', '.near-ai', 'agent-team.json'), 'utf8'), /private prompt|apiKey|raw context/i);
});

test('orchestration is fail-closed before binding and preserves the selected member policy after binding', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-invoke-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-invoke-global-'));
  const profiles = new AgentProfileStore(project);
  await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'implementer', capabilities: ['read', 'plan', 'write'], preferredProvider: 'near-ai', locality: 'local', preferredModel: 'coding-model' });
  const studio = new TeamStudioStore(globalStorage);
  const team = await studio.create({ displayName: 'Invoker', members: [member()] });
  const unbound = new AgentOrchestrator(project, { profiles, requireBoundTeam: true });
  await assert.rejects(() => unbound.deploy({ role: 'implementer', task: 'Implement the feature', requiredCapabilities: ['write'], actionCapability: 'workspaceWrite' }), /Bind a reusable team/);
  const binding = await studio.bind({ teamId: team.teamId, version: 1, projectId: 'project-cccccccccccccccccccccccccccccccc' });
  const orchestrator = new AgentOrchestrator(project, { profiles, requireBoundTeam: true, teamBinding: binding });
  const deployed = await orchestrator.deploy({ role: 'implementer', task: 'Implement the feature', requiredCapabilities: ['write'], actionCapability: 'workspaceWrite', estimatedCostUsd: 1, teamId: team.teamId, teamVersion: 1 });
  assert.equal(deployed.profileId, 'agent-bbbbbbbbbbbb');
  await assert.rejects(() => orchestrator.deploy({ role: 'implementer', task: 'Run an unrestricted shell', requiredCapabilities: ['write'], actionCapability: 'shell', teamId: team.teamId, teamVersion: 1 }), /tool contract/);
  await assert.rejects(() => orchestrator.deploy({ role: 'implementer', task: 'Wrong version', requiredCapabilities: ['write'], actionCapability: 'workspaceWrite', teamId: team.teamId, teamVersion: 2 }), /does not match/);
});

test('media invocation reaches only the declared member action', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-media-invoke-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-media-global-'));
  const profiles = new AgentProfileStore(project);
  await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'implementer', capabilities: ['read', 'plan', 'write'], preferredProvider: 'near-ai', locality: 'local', preferredModel: 'coding-model' });
  const mediaMember = member();
  mediaMember.tools = ['read', 'plan', 'workspaceWrite', 'mediaGeneration'];
  mediaMember.approval = { mode: 'risky', capabilities: ['workspaceWrite', 'mediaGeneration'] };
  const team = await new TeamStudioStore(globalStorage).create({ displayName: 'Media Invoker', members: [mediaMember] });
  const binding = await new TeamStudioStore(globalStorage).bind({ teamId: team.teamId, version: 1, projectId: 'project-dddddddddddddddddddddddddddddddd' });
  const orchestrator = new AgentOrchestrator(project, { profiles, requireBoundTeam: true, teamBinding: binding });
  const generated = await orchestrator.deploy({ role: 'implementer', task: 'Generate the approved media', requiredCapabilities: ['write'], actionCapability: 'mediaGeneration', estimatedCostUsd: 1, teamId: team.teamId, teamVersion: 1 });
  assert.equal(generated.profileId, 'agent-bbbbbbbbbbbb');
  await assert.rejects(() => orchestrator.deploy({ role: 'implementer', task: 'Publish media without publication authority', requiredCapabilities: ['write'], actionCapability: 'mediaPublication', teamId: team.teamId, teamVersion: 1 }), /tool contract/);
});

test('tampered persisted bindings are discarded and tampered in-memory snapshots fail before routing', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-tampered-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-tampered-global-'));
  const profiles = new AgentProfileStore(project);
  await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'implementer', capabilities: ['read', 'plan', 'write'], preferredProvider: 'near-ai', locality: 'local', preferredModel: 'coding-model' });
  const initialization = new ProjectInitialization(project);
  await initialization.accept((await initialization.initialize(answers)).recommendation, answers);
  const studio = new TeamStudioStore(globalStorage);
  const team = await studio.create({ displayName: 'Tamper Target', members: [member()] });
  const binding = await studio.bindProject(project, { teamId: team.teamId, version: 1, projectId: 'project-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, initialization);
  const artifactPath = path.join(project, '.planning', '.near-ai', 'agent-team.json');
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { reusableBinding: typeof binding };
  artifact.reusableBinding.members[0].tools = ['shell'];
  artifact.reusableBinding.members[0].approval.capabilities = ['shell'];
  await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
  assert.equal(await new ProjectInitialization(project).getReusableBinding(), undefined);
  await assert.rejects(() => new ProjectInitialization(project).requireReusableBinding(), /Bind a reusable team/);

  const tamperedCases = [
    (value: typeof binding) => ({ ...value, members: [{ ...value.members[0], role: 'reviewer' as const, skillIds: ['read', 'review'] as MemberCapabilityContract['skillIds'], capabilities: ['read', 'review'] as MemberCapabilityContract['capabilities'] }] }),
    (value: typeof binding) => ({ ...value, members: [{ ...value.members[0], providerRoute: { ...value.members[0].providerRoute, provider: 'other-provider' } }] }),
    (value: typeof binding) => ({ ...value, members: [{ ...value.members[0], tools: ['shell' as const], approval: { mode: 'risky' as const, capabilities: ['shell' as const] } }] }),
    (value: typeof binding) => ({ ...value, members: [{ ...value.members[0], budget: { ...value.members[0].budget, requestUsd: 99 } }] })
  ];
  for (const tamper of tamperedCases) {
    const orchestrator = new AgentOrchestrator(project, { profiles, requireBoundTeam: true, teamBinding: tamper(binding) });
    await assert.rejects(() => orchestrator.deploy({ role: 'implementer', task: 'Must not route tampered authority', requiredCapabilities: ['write'], actionCapability: 'workspaceWrite', teamId: team.teamId, teamVersion: 1 }), /binding|contract|fingerprint/i);
  }
});

test('team invoke crosses the host seam with exact binding and host-derived lifecycle metadata', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-chat-seam-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-chat-seam-global-'));
  const profiles = new AgentProfileStore(project);
  await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'implementer', capabilities: ['read', 'plan', 'write'], preferredProvider: 'near-ai', locality: 'local', preferredModel: 'coding-model' });
  const initialization = new ProjectInitialization(project);
  const recommendation = (await initialization.initialize(answers)).recommendation;
  recommendation.roles = recommendation.roles.filter((role) => role.role === 'implementer').map((role) => ({ ...role, profileId: 'agent-bbbbbbbbbbbb' }));
  await initialization.accept(recommendation, answers);
  const studio = new TeamStudioStore(globalStorage);
  const team = await studio.create({ displayName: 'Chat Seam Team', members: [member()] });
  const parsed = { type: 'team-invoke' as const, teamId: team.teamId, version: 1, role: 'implementer' as const, task: 'Plan the accepted bounded change', requiredCapabilities: ['write' as const], actionCapability: 'plan' as const };
  const agent = await invokeBoundTeam(project, studio, parsed);
  const binding = await new ProjectInitialization(project).requireReusableBinding();
  assert.equal(agent.status, 'running');
  assert.equal(agent.projectId, binding.projectId);
  assert.equal(agent.explanation.selectedProfileId, 'agent-bbbbbbbbbbbb');
  assert.equal(agent.routeSnapshot?.provider, 'near-ai');
  assert.equal(agent.routeSnapshot?.locality, 'local');
  await assert.rejects(() => invokeBoundTeam(project, studio, { ...parsed, version: 2 }), /exact project version|does not match|Unknown team version/);
  assert.equal(JSON.stringify(agent).match(/api[_ -]?key|token|secret|private prompt|raw context|\/home\//i), null);
});

test('team invoke fails before deployment when project acceptance or exact scope is forged', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-team-chat-unaccepted-'));
  const globalStorage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-chat-unaccepted-global-'));
  const studio = new TeamStudioStore(globalStorage);
  const team = await studio.create({ displayName: 'Needs Acceptance', members: [member()] });
  const request = { type: 'team-invoke' as const, teamId: team.teamId, version: 1, role: 'implementer' as const, task: 'Run a safe plan', requiredCapabilities: ['write' as const], actionCapability: 'plan' as const };
  await assert.rejects(() => invokeBoundTeam(project, studio, request), /Accept or customize/);
});
