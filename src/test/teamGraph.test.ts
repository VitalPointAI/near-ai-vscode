// A team as a shape: the lead, the members, and who answers to whom. Every member must appear exactly once whatever the file says, because a drawing
// that drops a member, or loops forever, is worse than a list (owner, 2026-11-08).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTeamGraph } from '../agent/teamGraph';
import { parseTeam, renderTeam, type TeamDefinition, type TeamMember } from '../agent/teams';

const member = (name: string, extra: Partial<TeamMember> = {}): TeamMember => ({ name, tools: ['Read'], instructions: `${name} does its job.`, ...extra });
const team = (members: TeamMember[]): TeamDefinition => ({ slug: 't', name: 'The team', description: 'Does things', members, file: '/teams/t.md' });

test('a team with no reports-to is a lead with every member under it, which is what every existing team file says', () => {
  const graph = buildTeamGraph(team([member('planner'), member('writer')]));
  assert.deepEqual(graph.roots.map((node) => node.name), ['planner', 'writer']);
  assert.deepEqual(graph.orphaned, []);
  assert.equal(graph.team.members, 2);
  assert.equal(graph.byName.size, 2);
});

test('reports-to draws the hierarchy, and a member keeps its own children in file order', () => {
  const graph = buildTeamGraph(team([
    member('lead'),
    member('research-lead', { reportsTo: 'lead' }),
    member('scout', { reportsTo: 'research-lead' }),
    member('analyst', { reportsTo: 'research-lead' }),
    member('writer')
  ]));
  assert.deepEqual(graph.roots.map((node) => node.name), ['lead', 'writer']);
  const lead = graph.byName.get('lead')!;
  assert.deepEqual(lead.children.map((node) => node.name), ['research-lead']);
  assert.deepEqual(lead.card.leads, ['research-lead']);
  assert.deepEqual(graph.byName.get('research-lead')!.children.map((node) => node.name), ['scout', 'analyst']);
  assert.equal(graph.byName.get('scout')!.card.reportsTo, 'research-lead');
});

test('every member appears exactly once even when reports-to is wrong, names itself, or forms a loop', () => {
  for (const members of [
    [member('a', { reportsTo: 'nobody' })],
    [member('a', { reportsTo: 'a' })],
    [member('a', { reportsTo: 'b' }), member('b', { reportsTo: 'a' })],
    [member('a', { reportsTo: 'b' }), member('b', { reportsTo: 'c' }), member('c', { reportsTo: 'a' })]
  ]) {
    const graph = buildTeamGraph(team(members));
    const seen: string[] = [];
    const walk = (node: { name: string; children: Array<{ name: string; children: unknown[] }> }) => { seen.push(node.name); (node.children as Array<Parameters<typeof walk>[0]>).forEach(walk); };
    graph.roots.forEach(walk);
    assert.deepEqual(seen.sort(), members.map((entry) => entry.name).sort(), `every member is drawn once: ${JSON.stringify(members.map((entry) => entry.name))}`);
    assert.ok(graph.orphaned.length >= 1, 'a member that could not be placed under its parent is named');
  }
});

test('the member card says what it can do from its tools, and what is expected from its instructions', () => {
  const graph = buildTeamGraph(team([member('worker', {
    role: 'builder',
    model: 'Qwen/Qwen3.8-27B-abliterated',
    tools: ['Read', 'Grep', 'Bash', 'Edit', 'Remember'],
    instructions: 'Build the thing to the plan.\n\nRun the tests.\nReport the files changed and how you verified them.'
  })]), (model) => /abliterated/i.test(model));
  const card = graph.byName.get('worker')!.card;
  assert.equal(card.purpose, 'Build the thing to the plan.');
  // Paragraphs are split on a blank line, which is how the studio's own templates separate a member's steps from what it reports back.
  assert.deepEqual(card.expectations, ['Run the tests.\nReport the files changed and how you verified them.']);
  assert.deepEqual(card.capabilities, ['Read files', 'Run commands', 'Change files', 'Keep and use memory'], 'capabilities come from the tools, in a readable order');
  assert.equal(card.abliterated, true, 'a card says when the model does not refuse');
  assert.equal(card.role, 'builder');
  assert.equal(card.model, 'Qwen/Qwen3.8-27B-abliterated');
});

test('reports-to survives a save and read of the team file, and a file without it reads as before', () => {
  const text = renderTeam('T', 'D', [
    { name: 'lead', role: 'lead', instructions: 'Lead.' },
    { name: 'scout', role: 'scout', instructions: 'Scout.', reportsTo: 'lead' }
  ]);
  const parsed = parseTeam(text, '/teams/t.md');
  assert.equal(parsed.members[1]?.reportsTo, 'lead');
  assert.equal(parsed.members[0]?.reportsTo, undefined);
  // An older file has no reports-to line and still parses to exactly what it meant.
  const old = renderTeam('T', 'D', [{ name: 'solo', role: 'solo', instructions: 'Alone.' }]);
  assert.equal(parseTeam(old, '/teams/t.md').members[0]?.reportsTo, undefined);
});

// The hierarchy must survive the studio, not just parseTeam (0.4.19 review: every studio save deleted it, because TeamDraft had no such field).
test('a studio save keeps reports-to, on an edited member and on an unedited one', async () => {
  const { draftFromMarkdown, teamMarkdown } = await import('../agent/teamMarkdown');
  const { parseDraft } = await import('../services/teamStudioPage');
  const text = renderTeam('T', 'D', [
    { name: 'lead', role: 'lead', instructions: 'Lead.' },
    { name: 'scout', role: 'scout', instructions: 'Scout.', reportsTo: 'lead' }
  ]);
  const draft = draftFromMarkdown(text, '/teams/t.md');
  assert.equal(draft.members[1]?.reportsTo, 'lead', 'the draft carries the hierarchy');
  draft.members[1]!.model = 'fast';
  const saved = teamMarkdown(draft, text);
  assert.deepEqual(saved.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('reports-to:')), ['reports-to: lead'], 'the save writes it back');
  // The page's own parser must accept the field, or a draft carrying it is refused outright.
  const parsed = parseDraft({ ...draft, members: draft.members.map((member) => ({ ...member, model: member.model ?? '' })) });
  assert.ok(parsed, 'a draft with reportsTo parses');
  assert.equal(parsed.members[1]?.reportsTo, 'lead');
  // And a draft without it still parses, so existing teams are unaffected.
  const plain = parseDraft({ name: 'T', description: 'D', members: [{ name: 'a', role: 'r', model: '', tools: null, instructions: 'Does a.' }] });
  assert.ok(plain);
  assert.equal(plain.members[0]?.reportsTo, undefined);
});
