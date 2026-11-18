// Owner, 2026-11-18: "teams should typically be built with preference to run agents in parallel vice sequential whenever possible keeping work separated
// and then bring together to merge and sort out conflicts." Every place a team is made or led says so: the lead's prompt, the note a run working with a
// team gets, the AI team builder, the built-in teams and the recommended project team, and (as advice) the local team check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { checkNotes, checkTeam, checkWarnings, INTEGRATION_STEP, PARALLEL_NOTE_IDS, SEPARATE_AREA } from '../agent/teamCheck';
import { parseProposal, TEAM_BUILDER_PROMPT } from '../agent/teamBuilder';
import { draftFromMarkdown, type DraftMember, type TeamDraft } from '../agent/teamMarkdown';
import { newTeamTemplate, parseTeam, PARALLEL_MERGE_NOTE, recommendedProjectTeam, renderTeam, teamLeadPrompt, teamMembersNote, type TeamDefinition } from '../agent/teams';
import { buildDashboard, type DashboardTeam } from '../domain/teamDashboard';
import type { ActivitySessionSummary } from '../domain/activity';
import { buildStudioContext, reviewDraft, startingPointDraft } from '../services/teamStudioPage';
import type { DirectoryInput } from '../services/toolsDirectory';

const input: DirectoryInput = {
  gsd: { version: '1.40.0', skills: [], agents: [] }, teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [],
  models: [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }],
  settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3' }, roleModels: {}, visionModel: 'x', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'x' }
};
const context = buildStudioContext(input, { hasProject: true, knowledgeBase: false });
const parallelNotes = (draft: TeamDraft) => checkTeam(draft).filter((finding) => PARALLEL_NOTE_IDS.includes(finding.id)).map((finding) => finding.id);

const team: TeamDefinition = { slug: 'web', name: 'Web', description: 'Builds the site', file: '/t/web.md', members: [
  { name: 'frontend', role: 'implementer', tools: [], instructions: 'Builds pages.' },
  { name: 'backend', role: 'implementer', tools: [], instructions: 'Builds the API.' }
] };

test('the lead keeps the parallel rules and is told to merge the members\' branches one at a time, settle conflicts, and check once', () => {
  const lead = teamLeadPrompt(team, 'Add a login page');
  // The existing rules stay.
  assert.match(lead, /start every part that does not depend on another in the SAME turn/);
  assert.match(lead, /run_in_background/);
  assert.match(lead, /`isolation: "worktree"`/);
  assert.match(lead, /never to general-purpose or an Open-GSD agent while a member fits/);
  // Work is kept separate: each member owns an area and is told what it must not touch.
  assert.match(lead, /each member its own area[\s\S]{0,120}files, modules, or sections/i);
  assert.match(lead, /what it must not touch/);
  // Then brought together: one branch at a time into the run's branch.
  assert.match(lead, /merge their branches into this run's branch[\s\S]{0,80}one at a time/);
  // Conflicts: resolved by the lead, or handed to the member who owns the area, with both sides.
  assert.match(lead, /conflict[\s\S]{0,40}resolve it yourself/i);
  assert.match(lead, /hand the conflict to the member who owns that area, with both sides/);
  // A failed part does not hold up the rest.
  assert.match(lead, /part failed[\s\S]{0,80}does not block the others/);
  // The project's checks run once, after every merge.
  assert.match(lead, /After all the merges, run the project's checks[\s\S]{0,60}once/);
  // The report says what merged and what conflicted.
  assert.match(lead, /which branches merged, which conflicts came up and how each was resolved/);
  assert.match(lead, /what ran at the same time/);
  assert.doesNotMatch(lead, /[–—]/, 'plain text, no em or en dashes');
});

test('a run that works with a team (the Open-GSD case) is told the same: separate areas, then merge one at a time and check once', () => {
  const note = teamMembersNote(team);
  assert.ok(note.includes(PARALLEL_MERGE_NOTE));
  assert.ok(note.indexOf(PARALLEL_MERGE_NOTE) < note.indexOf('</team>'), 'inside the team note');
  assert.match(PARALLEL_MERGE_NOTE, /its own area/);
  assert.match(PARALLEL_MERGE_NOTE, /`isolation: "worktree"`[\s\S]{0,40}branch/);
  assert.match(PARALLEL_MERGE_NOTE, /merge their branches one at a time into the run's branch/);
  assert.match(PARALLEL_MERGE_NOTE, /hand it to the member who owns that area with both sides/);
  assert.match(PARALLEL_MERGE_NOTE, /fails does not block merging the others/);
  assert.match(PARALLEL_MERGE_NOTE, /checks once after all the merges/);
  assert.match(PARALLEL_MERGE_NOTE, /which branches merged, which conflicts came up/);
  assert.doesNotMatch(note, /[–—]/);
});

test('the team builder designs separate areas, an integration step, and waits only where one part needs another', () => {
  assert.match(TEAM_BUILDER_PROMPT, /work INDEPENDENTLY of the others/, 'the existing rule stays');
  assert.match(TEAM_BUILDER_PROMPT, /its own area \(files, modules, or sections of the deliverable\)/);
  assert.match(TEAM_BUILDER_PROMPT, /what area it owns and what it must not touch/);
  assert.match(TEAM_BUILDER_PROMPT, /changes files works in its own git worktree and reports its branch/);
  assert.match(TEAM_BUILDER_PROMPT, /clear integration step, done by an integrator or editor member, or by the lead/);
  assert.match(TEAM_BUILDER_PROMPT, /merges the parts \(one branch at a time\), resolves the conflicts between them, and checks the whole/);
  assert.match(TEAM_BUILDER_PROMPT, /one after another only where one part truly needs another's output, and state that need/);
  assert.doesNotMatch(TEAM_BUILDER_PROMPT, /[–—]/);
  // The starting team drafted when a reply has no members follows the same rules.
  const { proposal } = parseProposal('no json here', { idea: 'Write a brief about a market.' });
  const draft: TeamDraft = { name: proposal.name, description: proposal.description, members: proposal.members.map((member) => ({ name: member.name, role: member.role, model: member.model, tools: member.tools ?? null, instructions: member.instructions })) };
  assert.deepEqual(parallelNotes(draft), []);
});

test('every built-in team gives each member its own area, has someone who brings the parts together, and puts file-changing code members in worktrees', () => {
  for (const type of PROJECT_TYPES) {
    for (const locality of ['cloud', 'local'] as const) {
      const parsed = parseTeam(projectTypeTeam(type, 'Ship a thing', locality), '/p/team.md');
      for (const member of parsed.members) assert.match(member.instructions, SEPARATE_AREA, `${type.id}/${member.name} says what area it owns`);
      assert.ok(parsed.members.some((member) => INTEGRATION_STEP.test(member.instructions)), `${type.id} has an integration step`);
    }
  }
  // Members that change code report a branch from their own worktree for the lead to merge; names, models and tools are unchanged.
  const code: Record<string, string[]> = { software: ['developer', 'qa', 'devops'], data: ['data-engineer', 'analyst'], general: ['implementer'] };
  for (const [id, names] of Object.entries(code)) {
    const type = PROJECT_TYPES.find((candidate) => candidate.id === id)!;
    for (const name of names) {
      const member = type.members.find((candidate) => candidate.name === name)!;
      assert.match(member.instructions, /own git worktree/, `${id}/${name}`);
      assert.match(member.instructions, /report your branch for the lead to merge/, `${id}/${name}`);
    }
  }
  // Order that remains says why: one part needs another's output.
  const research = PROJECT_TYPES.find((type) => type.id === 'research')!;
  assert.match(research.members.find((member) => member.name === 'source-verifier')!.instructions, /Starts once TEAM-FINDINGS\.md is ready, because it checks those findings/);
  assert.match(research.guidance, /so the roles run in this order; within a step, the lead may split the work/);
  assert.match(PROJECT_TYPES.find((type) => type.id === 'software')!.guidance, /\*\*Parallel work:\*\*[\s\S]*merges the branches one at a time[\s\S]*does not block merging the others/);
  assert.match(PROJECT_TYPES.find((type) => type.id === 'general')!.guidance, /steps that do not need each other run at the same time/);
});

test('the recommended project team splits work into areas, and its implementer works in a worktree and reports a branch for the lead to merge', () => {
  for (const answers of [
    { goal: 'Add billing', riskLevel: 'high' as const, preferredProvider: 'near-ai', locality: 'cloud' as const, workShape: 'feature' as const },
    { goal: 'Fix a bug', riskLevel: 'medium' as const, preferredProvider: 'near-ai', locality: 'local' as const, workShape: 'feature' as const },
    { goal: 'Pick a queue', riskLevel: 'low' as const, preferredProvider: 'near-ai', locality: 'cloud' as const, workShape: 'research' as const }
  ]) {
    const parsed = parseTeam(recommendedProjectTeam(answers), '/p/team.md');
    for (const member of parsed.members) assert.match(member.instructions, SEPARATE_AREA, `${answers.goal}/${member.name}`);
    assert.ok(parsed.members.some((member) => INTEGRATION_STEP.test(member.instructions)), answers.goal);
    const implementer = parsed.members.find((member) => member.name === 'implementer');
    if (implementer) assert.match(implementer.instructions, /own git worktree[\s\S]*reports its branch[\s\S]*for the lead to merge/);
    const planner = parsed.members.find((member) => member.name === 'planner');
    if (planner) assert.match(planner.instructions, /its own area[\s\S]*at the same time[\s\S]*must wait for another's output, with the reason/);
  }
});

test('no built-in template or starting point gets the parallel-work notes, and none gets a new warning', () => {
  const drafts: Array<[string, TeamDraft]> = [['new team', draftFromMarkdown(newTeamTemplate('New'), 'team.md')]];
  for (const type of PROJECT_TYPES) for (const locality of ['cloud', 'local'] as const) drafts.push([`type:${type.id}:${locality}`, draftFromMarkdown(projectTypeTeam(type, 'Ship a thing', locality), 'team.md')]);
  for (const point of context.startingPoints.filter((entry) => entry.group === 'gsd' || entry.id === 'recommend')) {
    for (const locality of ['cloud', 'local'] as const) drafts.push([`${point.id}:${locality}`, startingPointDraft({ id: point.id, goal: 'Ship a thing', locality }, context).draft]);
  }
  for (const [label, draft] of drafts) {
    assert.deepEqual(parallelNotes(draft), [], label);
    // A local research team has no web tools, which its research members already warn about; that is not this change.
    if (!label.endsWith(':local')) assert.deepEqual(checkWarnings(checkTeam(draft)).map((issue) => issue.message), [], label);
  }
});

const member = (overrides: Partial<DraftMember> = {}): DraftMember => ({ name: 'm', role: 'reviewer', model: '', tools: ['Read', 'Grep'], instructions: 'Review the change. Report findings with file:line.', ...overrides });
const plain: TeamDraft = { name: 'Plain', description: 'Does work', members: [
  member({ name: 'builder', role: 'implementer', tools: null, instructions: 'Make the changes. Report what changed.' }),
  member({ name: 'checker' })
] };

test('the local check gives advice, never a warning, when no member owns an area or nobody brings the parts together', () => {
  const findings = checkTeam(plain);
  const areas = findings.find((finding) => finding.id === 'no-separate-areas');
  const integration = findings.find((finding) => finding.id === 'no-integration');
  assert.equal(areas?.severity, 'advice');
  assert.equal(integration?.severity, 'advice');
  assert.match(areas!.message, /its own area \(files, modules, or sections of the deliverable\)/);
  assert.match(integration!.message, /who merges the members' work, sorts out conflicts, and checks the whole/);
  assert.doesNotMatch(`${areas!.message} ${integration!.message}`, /[–—]/, 'plain words, no dashes');
  // Not shown as warnings, but as notes while editing.
  assert.deepEqual(checkWarnings(findings).filter((issue) => /own area|brings the parts together/.test(issue.message)), []);
  assert.deepEqual(checkNotes(findings).map((note) => note.message), [areas!.message, integration!.message]);
  // Other advice (no role, no lead) stays in the Improve panel only.
  assert.deepEqual(checkNotes(checkTeam({ ...plain, members: [...plain.members.map((entry) => ({ ...entry, role: '' }))] })).length, 2);

  // Each note goes once its gap is filled.
  const owned: TeamDraft = { ...plain, members: [{ ...plain.members[0]!, instructions: 'Make the changes in your own area and leave the rest to its owner. Report what changed.' }, plain.members[1]!] };
  assert.deepEqual(parallelNotes(owned), ['no-integration']);
  assert.deepEqual(parallelNotes({ ...owned, description: 'The lead merges the parts and checks the whole.' }), [], 'an integration step in the description counts');
  assert.deepEqual(parallelNotes({ ...owned, members: [owned.members[0]!, { ...owned.members[1]!, instructions: 'Merge the branches, resolve conflicts, and report the result.' }] }), []);
  // A team of one has nothing to bring together.
  assert.deepEqual(parallelNotes({ ...plain, members: [plain.members[0]!] }), []);
});

test('the studio shows the notes while editing, and they never stop a save', () => {
  const review = reviewDraft(plain, undefined, input, context);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.notes.map((note) => note.field), ['members', 'members']);
  assert.ok(review.notes.every((note) => !review.warnings.some((warning) => warning.message === note.message)));
  // A built-in has none.
  const builtIn = startingPointDraft({ id: 'type:software', goal: 'Ship', locality: 'cloud' }, context).draft;
  assert.deepEqual(reviewDraft({ ...builtIn, name: 'Software' }, undefined, input, context).notes, []);
});

test('an existing team without areas or an integration step still shows Ready on the dashboard; the notes count only as suggestions', () => {
  // A team file as people wrote them before: three members, no areas, no one named to merge.
  const existing = renderTeam('Old team', 'Plans, builds and reviews', [
    { name: 'planner', role: 'planner', model: 'standard', tools: ['Read', 'Glob', 'Grep'], instructions: 'Read the code and break the task into small steps. Do not change files. Report the plan.' },
    { name: 'implementer', role: 'implementer', model: 'deep', instructions: 'Make the changes in the plan. Run the relevant tests. Report what changed.' },
    { name: 'reviewer', role: 'reviewer', model: 'standard', tools: ['Read', 'Glob', 'Grep', 'Bash'], instructions: 'Review the changes. Report findings with file:line. Do not edit files.' }
  ]);
  const findings = checkTeam(draftFromMarkdown(existing, '/lib/old.md'));
  const check = { block: findings.filter((finding) => finding.severity === 'block').length, warning: findings.filter((finding) => finding.severity === 'warning').length, advice: findings.filter((finding) => finding.severity === 'advice').length };
  assert.deepEqual([check.block, check.warning], [0, 0]);
  assert.ok(check.advice >= 2, 'both notes are advice');
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const run = { version: 1, sessionId: 'session-old-0000', project: 'p', plans: [], agents: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }, models: [], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: new Date(now - 7_200_000).toISOString(), updatedAt: new Date(now - 3_600_000).toISOString(), endedAt: new Date(now - 3_600_000).toISOString(), outcome: 'completed', runOutcome: 'completed', continuationAvailable: false, context: { userTurns: 1, assistantTurns: 1 }, events: [], runId: 'run-old-000000', title: '/team:old go' } as unknown as ActivitySessionSummary;
  const card: DashboardTeam = { id: 'user:old', kind: 'user', slug: 'old', key: 'user:old', file: '/lib/old.md', members: [{ name: 'planner', available: true }], check };
  const dashboard = buildDashboard({ now, history: true, sessions: [run], running: [], roleTests: {}, teams: [card] });
  assert.equal(dashboard.cards['user:old']!.status, 'ready');
  assert.deepEqual(dashboard.cards['user:old']!.attention, []);
  assert.match(dashboard.cards['user:old']!.health.parts[0]!.detail, /suggestion/);
});
