import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { checkTeam, reportsToCycles } from '../agent/teamCheck';
import { checkDraft, draftFromMarkdown, teamMarkdown, type TeamDraft } from '../agent/teamMarkdown';
import { applySuggestion } from '../agent/teamRefine';
import { parseTeam, reportsToKey, TeamLibrary } from '../agent/teams';

// PR #69 review: a reports-to value that is not already a member name (`Lead`, `Team Lead`, mixed case, from a hand-written or imported file) must be
// compared the same way everywhere: one helper, reportsToKey, used by the parser, the studio's save and round trip, the local check and Improve with AI.

const file = (value: string) => `---
name: Crew
description: Builds things
---

## team-lead
role: planner

Plan the work. Report the plan.

## writer
role: writer
reports-to: ${value}

Write the brief. Report where it is.
`;

test('one helper normalises reports-to: Lead, Team Lead and mixed case name the member they mean', () => {
  assert.equal(reportsToKey('Team Lead'), 'team-lead');
  assert.equal(reportsToKey('  TEAM-lead '), 'team-lead');
  assert.equal(reportsToKey(''), '');
  assert.equal(reportsToKey(undefined), '');
  assert.equal(parseTeam(file('Team Lead'), 'crew.md').members[1].reportsTo, 'team-lead');
});

test('a team whose file says reports-to: Team Lead (any spelling) saves, unchanged or edited, and slug values still save byte for byte', () => {
  for (const value of ['Team Lead', 'TEAM LEAD', 'team-Lead', 'team-lead']) {
    const text = file(value);
    const draft = draftFromMarkdown(text, 'crew.md');
    assert.deepEqual(checkDraft(draft, text).errors, [], value);
    assert.equal(teamMarkdown(draft, text), text, `${value}: an unchanged save keeps the file byte for byte`);
    const edited = { ...draft, description: 'Builds better things' };
    assert.deepEqual(checkDraft(edited, text).errors, [], value);
    assert.equal(teamMarkdown(edited, text), text.replace('Builds things', 'Builds better things'), value);
  }
});

test('a draft that carries the written spelling (kept work, the page) checks and saves the same way', () => {
  const text = file('team-lead');
  const base = draftFromMarkdown(text, 'crew.md');
  for (const value of ['Team Lead', 'TEAM-LEAD', 'Team-Lead']) {
    const draft: TeamDraft = { ...base, members: base.members.map((member, index) => (index === 1 ? { ...member, reportsTo: value } : member)) };
    assert.deepEqual(checkDraft(draft, text).errors, [], value);
    assert.equal(teamMarkdown(draft, text), text, `${value}: the same boss, so the section is kept`);
    assert.deepEqual(checkTeam(draft).filter((finding) => finding.id.startsWith('reports-to')), [], `${value}: the local check finds the boss`);
  }
  // A loop written in two spellings is still a loop.
  assert.deepEqual(reportsToCycles([{ name: 'a', reportsTo: 'B' }, { name: 'b', reportsTo: 'A' }]), ['a', 'b']);
  // Improve with AI: removing the boss clears a mixed-case line that names it, so the team still saves.
  const draft: TeamDraft = { ...base, members: base.members.map((member, index) => (index === 1 ? { ...member, reportsTo: 'Team Lead' } : member)) };
  const removed = applySuggestion(draft, { id: 's1', kind: 'remove-member', member: 'team-lead', base: draft.members[0].instructions, proposed: '', reason: 'r', editable: false }, { original: text });
  assert.ok('draft' in removed, JSON.stringify(removed));
  assert.equal(removed.draft.members[0].reportsTo, undefined);
});

test('an imported team file with reports-to: Lead opens, saves and re-saves in the library', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-reports-to-')));
  const imported = file('Team Lead').replace('## team-lead', '## Team Lead');
  const saved = await library.importTeam('Crew', imported);
  const text = await readFile(saved, 'utf8');
  const draft = draftFromMarkdown(text, saved);
  assert.equal(draft.members[0].name, 'team-lead');
  assert.deepEqual(checkDraft(draft, text).errors, []);
  assert.equal(teamMarkdown(draft, text), text);
});
