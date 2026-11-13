import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_TYPES, projectType, projectTypeTeam } from '../agent/projectTypes';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { applyTeamUpdate, planTeamUpdate, stampTeam } from '../agent/teamUpdate';
import { parseTeam } from '../agent/teams';

// A team file this version writes must stay safe in the build before it (f02cff8), which does not
// know the `privacy:` line. That parser stops reading metadata at the first line it does not
// recognise, so a privacy line before `tools:` would make it ignore the tools line and give the
// member the default tools, Bash and Write included. Writing privacy last keeps the declared tools.

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'teams');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const old = require(path.join(FIXTURES, 'parseTeam-f02cff8.cjs')) as { parseTeam(text: string, file: string): { members: Array<{ name: string; role?: string; model?: string; tools: string[]; instructions: string }> }; DEFAULT_TOOLS: string[] };

/** Every private member in `text` keeps its role, model, and exact tools in the old parser, and the privacy line is only text. */
function assertOldParserSafe(text: string, label: string): number {
  const now = parseTeam(text, 'team.md');
  const before = old.parseTeam(text, 'team.md');
  let checked = 0;
  for (const member of now.members) {
    const previous = before.members.find((entry) => entry.name === member.name)!;
    assert.equal(previous.role, member.role, `${label}/${member.name}: role`);
    assert.equal(previous.model, member.model, `${label}/${member.name}: model`);
    if (!member.privacy) continue;
    const declared = /^## (.+)\n([\s\S]*?)\n\n/m.exec(text.slice(text.indexOf(`## ${member.name}\n`)))![2].split('\n').find((line) => line.startsWith('tools: '));
    assert.ok(declared, `${label}/${member.name} declares its tools`);
    assert.deepEqual(previous.tools, declared!.slice('tools: '.length).split(', '), `${label}/${member.name}: the old build keeps the declared tools exactly`);
    assert.notDeepEqual(previous.tools, old.DEFAULT_TOOLS, `${label}/${member.name}: never the default tools`);
    assert.match(previous.instructions, /^privacy: private\n\n/, `${label}/${member.name}: the privacy line is only the first line of its instructions`);
    checked += 1;
  }
  return checked;
}

test('every built-in private member reads safely in the build before privacy existed', () => {
  const research = projectType('research')!;
  assert.equal(assertOldParserSafe(projectTypeTeam(research, 'Assess the market', 'cloud'), 'research cloud'), research.members.length, 'every research member is checked');
  assert.equal(assertOldParserSafe(projectTypeTeam(research, 'Assess the market', 'local'), 'research local'), research.members.length);
  for (const type of PROJECT_TYPES) for (const locality of ['cloud', 'local'] as const) assertOldParserSafe(stampTeam(projectTypeTeam(type, 'g', locality), type), `${type.id} ${locality}`);
  // Saved from Team Studio, as a new file and over an existing one.
  const generated = projectTypeTeam(research, 'g', 'cloud');
  const draft = draftFromMarkdown(generated, 'team.md');
  assert.equal(assertOldParserSafe(teamMarkdown(draft), 'studio new'), research.members.length);
  const edited = { ...draft, members: draft.members.map((member) => ({ ...member, instructions: `${member.instructions} Edited.` })) };
  assert.equal(assertOldParserSafe(teamMarkdown(edited, generated), 'studio edit'), research.members.length);
});

test('a team written by Update Team, including "add only the new parts", reads safely in the old build', async () => {
  const fixture = await readFile(path.join(FIXTURES, 'wearable-research-team.md'), 'utf8');
  // Seven: the update adds the research team's permanent plagiarism checker (owner decision, 2026-11-13).
  assert.equal(assertOldParserSafe(applyTeamUpdate(fixture, planTeamUpdate(fixture)!), 'update'), 7);
  const research = projectType('research')!;
  const base = stampTeam(projectTypeTeam(research, 'g', 'cloud'), research);
  const mine = base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, '## editor\nrole: reviewer\nmodel: standard\ntools: Read, CheckCitations\n\nOur house style.\n\nProject goal: g\n');
  const merged = applyTeamUpdate(mine, planTeamUpdate(mine)!, { members: { editor: 'merge' } });
  assert.match(merged, /## editor\nrole: reviewer\nmodel: standard\ntools: Read, CheckCitations, [^\n]+\nprivacy: private\n\nOur house style\./, 'the merge writes privacy last');
  assertOldParserSafe(merged, 'merge');
});

test('the remaining caveat: a hand-edited file with privacy before tools still loses its tools in the old build', () => {
  const text = '---\nname: T\n---\n\n## editor\nrole: reviewer\nprivacy: private\ntools: Read\n\nEdit.\n';
  assert.deepEqual(parseTeam(text, 't.md').members[0].tools, ['Read'], 'this version reads it correctly');
  assert.deepEqual(old.parseTeam(text, 't.md').members[0].tools, old.DEFAULT_TOOLS, 'the old build does not: documented in the rollback notes');
});
