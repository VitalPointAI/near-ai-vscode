import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { checkTeam, checkWarnings, neededCapabilities, reportsToCycles, similarity, type CheckId } from '../agent/teamCheck';
import { draftFromMarkdown, type DraftMember, type TeamDraft } from '../agent/teamMarkdown';
import { newTeamTemplate } from '../agent/teams';
import { buildStudioContext, reviewDraft, startingPointDraft } from '../services/teamStudioPage';
import type { DirectoryInput } from '../services/toolsDirectory';
import { DEFAULT_RULES } from '../agent/permissions';

// The free local team check (0.4.27): each check fires on a small example and stays quiet on the studio's own roles and templates.

const input: DirectoryInput = {
  gsd: { version: '1.40.0', skills: [], agents: [] }, teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [],
  models: [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }],
  settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3' }, roleModels: {}, visionModel: 'x', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'x' }
};
const context = buildStudioContext(input, { hasProject: true, knowledgeBase: false });
const member = (overrides: Partial<DraftMember> = {}): DraftMember => ({ name: 'm', role: 'reviewer', model: '', tools: ['Read', 'Grep'], instructions: 'Review the change. Report findings with file:line.', ...overrides });
const team = (members: DraftMember[]): TeamDraft => ({ name: 'T', description: 'Does work', members });
const ids = (draft: TeamDraft) => checkTeam(draft).map((finding) => finding.id);

test('each built-in role, with its own tools and suggested instructions, passes its own check', () => {
  for (const role of context.roles.filter((candidate) => candidate.source === 'team')) {
    const findings = checkTeam(team([member({ name: role.id, role: role.id, tools: role.tools ? [...role.tools] : null, instructions: role.suggestion })]));
    assert.deepEqual(findings.filter((finding) => finding.severity !== 'advice').map((finding) => `${finding.id}: ${finding.message}`), [], role.id);
  }
});

test('the built-in templates and starting points raise no warnings', () => {
  const drafts: Array<[string, TeamDraft]> = [['new team', draftFromMarkdown(newTeamTemplate('New'), 'team.md')]];
  for (const type of PROJECT_TYPES) drafts.push([`type:${type.id}`, draftFromMarkdown(projectTypeTeam(type, 'Ship a thing', 'cloud'), 'team.md')]);
  for (const point of context.startingPoints.filter((entry) => entry.group === 'gsd' || entry.id === 'recommend')) {
    drafts.push([point.id, startingPointDraft({ id: point.id, goal: 'Ship a thing', locality: 'cloud' }, context).draft]);
  }
  for (const [label, draft] of drafts) assert.deepEqual(checkWarnings(checkTeam(draft)).map((issue) => issue.message), [], label);
});

test('instructions that ask for a tool the member lacks: web, commands, edits and documents', () => {
  // A researcher with no tools line gets the default tools, which have no web tools: the commonest real mismatch.
  const researcher = checkTeam(team([member({ name: 'researcher', role: 'researcher', tools: null, instructions: 'Search the web for the market size and cite primary sources. Report each finding with its URL.' })]));
  const missing = researcher.find((finding) => finding.id === 'tool-missing')!;
  assert.deepEqual([missing.member, missing.field, missing.tools], [0, 'tools', ['WebSearch', 'WebFetch']]);
  assert.match(missing.message, /researcher: its instructions ask it to search or read the web, but its tools cannot/);
  assert.ok(ids(team([member({ instructions: 'Run the tests and report what failed.' })])).includes('tool-missing'));
  assert.ok(ids(team([member({ instructions: 'Fix the bugs you find. Report what changed.' })])).includes('tool-missing'));
  assert.ok(ids(team([member({ instructions: 'Turn the brief into a slide deck. Report where it is.' })])).includes('tool-missing'));
  // Negated sentences ask for nothing, and the right tool clears it.
  assert.deepEqual(neededCapabilities('Do not run the tests. Never edit the files.'), []);
  assert.ok(!ids(team([member({ tools: ['Read', 'Bash'], instructions: 'Run the tests and report what failed.' })])).includes('tool-missing'));
  // MCP tools are never guessed at, so a member with one is not told it lacks something.
  assert.ok(!ids(team([member({ tools: ['Read', 'mcp__search__query'], instructions: 'Search the web and report.' })])).includes('tool-missing'));
});

test('a "do not edit" member that holds Write or Edit is told to drop them', () => {
  const findings = checkTeam(team([member({ tools: ['Read', 'Write'], instructions: 'Review the code. Do not edit files. Report findings.' })]));
  const found = findings.find((finding) => finding.id === 'tool-unneeded-write')!;
  assert.deepEqual(found.tools, ['Write']);
  assert.match(checkTeam(team([member({ tools: null, instructions: 'Review it. Do not edit files. Report findings.' })])).find((finding) => finding.id === 'tool-unneeded-write')!.message, /Write and Edit \(from the default tools\)/);
});

test('deliverable, role, overlap, lead, reports-to, length', () => {
  assert.ok(ids(team([member({ instructions: 'Think about the problem carefully.' })])).includes('no-deliverable'));
  assert.ok(ids(team([member({ role: 'helper' })])).includes('generic-role'));
  const noRole = checkTeam(team([member({ role: '' })])).find((finding) => finding.id === 'no-role')!;
  assert.equal(noRole.severity, 'advice', 'an empty role is advice, not a warning');
  assert.deepEqual(checkWarnings([noRole]), []);
  const text = 'Read every changed file, check each function for missing error handling and unclear names, and report the findings with file and line.';
  assert.ok(ids(team([member({ name: 'a', role: 'checker', instructions: text }), member({ name: 'b', role: 'auditor', instructions: text })])).includes('overlap'));
  // The same role with different work is not an overlap (a code reviewer and a security reviewer).
  assert.ok(!ids(team([member({ name: 'a', instructions: 'Review the change for correctness and missing tests. Report findings with file:line.' }), member({ name: 'b', instructions: 'Check the change for injection, secrets and unsafe dependencies. Report each with severity.' })])).includes('overlap'));
  const four = ['a', 'b', 'c', 'd'].map((name, index) => member({ name, role: ['writer', 'analyst', 'tester', 'editor'][index], instructions: `Do part ${name} of the work in your own way with care. Report part ${name}.` }));
  const lead = checkTeam(team(four)).find((finding) => finding.id === 'no-lead')!;
  assert.equal(lead.severity, 'advice', 'the lead agent of a run coordinates by default, so this is advice');
  assert.ok(!ids(team(four.map((entry, index) => (index === 0 ? { ...entry, role: 'planner' } : entry)))).includes('no-lead'));
  assert.ok(!ids(team(four.map((entry, index) => (index ? { ...entry, reportsTo: 'a' } : entry)))).includes('no-lead'), 'a reports-to line names the lead');
  assert.ok(ids(team([member({ name: 'a', reportsTo: 'boss' })])).includes('reports-to-missing'));
  const loop = checkTeam(team([member({ name: 'a', reportsTo: 'b' }), member({ name: 'b', role: 'writer', reportsTo: 'a', instructions: 'Write the brief. Report it.' }), member({ name: 'c', role: 'tester', reportsTo: 'a', instructions: 'Check it. Report results.' })]));
  assert.match(loop.find((finding) => finding.id === 'reports-to-cycle')!.message, /^a, b report to each other in a circle/);
  assert.deepEqual(reportsToCycles([{ name: 'solo', reportsTo: 'solo' }]), ['solo']);
  assert.ok(ids(team([member({ instructions: `${'Check the thing carefully. '.repeat(400)}Report it.` })])).includes('too-long'));
  assert.equal(similarity('one two', 'one two'), 0, 'too short to compare');
});

test('something that looks like a key blocks the AI review and is a warning while editing', () => {
  const key = ['sk', 'proj', 'a1B2c3D4e5F6g7H8'].join('-');
  const findings = checkTeam(team([member({ instructions: `Use ${key} to call the API. Report the result.` })]));
  const secret = findings.find((finding) => finding.id === 'secret')!;
  assert.deepEqual([secret.severity, secret.member], ['block', 0]);
  assert.doesNotMatch(secret.message, /a1B2c3/, 'the finding never repeats the key');
  assert.ok(checkWarnings(findings).some((issue) => /looks like a key/.test(issue.message)));
  assert.equal(checkTeam({ name: 'T', description: `token ${key}`, members: [member()] }).filter((finding) => finding.id === 'secret').length, 1);
  const ids2: CheckId[] = checkTeam(team([member()])).map((finding) => finding.id);
  assert.deepEqual(ids2, [], 'a clean member raises nothing');
});

test('the studio review shows the local check as warnings, never as errors that stop a save', () => {
  const draft = team([member({ name: 'researcher', role: 'researcher', tools: null, instructions: 'Search the web for prices.' })]);
  const review = reviewDraft(draft, undefined, input, context);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.warnings.filter((issue) => issue.member === 0).map((issue) => issue.field), ['tools', 'instructions']);
  assert.match(review.warnings.map((issue) => issue.message).join('\n'), /search or read the web[\s\S]*does not say what it hands back|search or read the web[\s\S]*do not say what it hands back/);
});
