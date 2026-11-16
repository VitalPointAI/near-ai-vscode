// Sharing a team as one file, importing it, and the approval an imported team needs before it runs (0.4.26). Pure functions and a real TeamLibrary.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { buildTeamPackage, cleanKnowledge, findLocalPaths, importQuestion, readTeamMarkdown, readTeamPackage, shareProblems, TEAM_PACKAGE_FORMAT, TEAM_PACKAGE_VERSION, TeamPackageError } from '../agent/teamPackage';
import { importedTeamQuestion, libraryTeamAllowed, newTeamTemplate, parseTeam, renderTeam, TeamLibrary, workingTeamFor } from '../agent/teams';
import { emptyKnowledge, type TeamKnowledge } from '../domain/teamKnowledge';
import { filterPicker, teamPicker, NO_SAVED_TEAMS_TEXT, type LibraryTeam, type StudioStartingPoint } from '../services/teamStudioPage';

const TEAM = renderTeam('Web crew', 'Builds pages', [
  { name: 'lead', role: 'planner', model: 'deep', tools: ['Read', 'Grep'], instructions: 'Plan the work.' },
  { name: 'dev', role: 'implementer', instructions: 'Build it and run the tests.' }
]);

function knowledge(): TeamKnowledge {
  const now = '2026-11-16T00:00:00.000Z';
  return { ...emptyKnowledge('web-crew', now), nodes: [
    { id: 'n1', label: 'Supplier', kind: 'organisation', functions: [], origin: 'research', firstSeen: now, lastSeen: now, mentions: 1, facts: [
      { text: 'Ships from the depot listed in /home/someone/projects/acme/notes.md', origin: 'document', source: '/home/someone/projects/acme/notes.md' },
      { text: 'Publishes prices online', origin: 'research', source: 'https://example.com/prices' },
      { text: 'Its staging key is api_key=abc123def456', origin: 'interaction' }
    ] }
  ] };
}

// ---------- export ----------

test('a share file holds the team text and a summary, and no path, home folder or setting from this computer', () => {
  const home = '/home/someone';
  const file = path.join(home, '.near-ai-teams', 'teams', 'web-crew.md');
  const text = buildTeamPackage(TEAM, file);
  const pkg = JSON.parse(text);
  assert.deepEqual(Object.keys(pkg), ['format', 'formatVersion', 'team', 'knowledge', 'listing', 'integrity']);
  assert.equal(pkg.format, TEAM_PACKAGE_FORMAT);
  assert.equal(pkg.formatVersion, TEAM_PACKAGE_VERSION);
  assert.deepEqual({ ...pkg.team, markdown: undefined }, { name: 'Web crew', description: 'Builds pages', members: 2, markdown: undefined });
  assert.equal(pkg.team.markdown, TEAM, 'the team text exactly as saved');
  assert.equal(pkg.knowledge, null, 'no knowledge unless it was included');
  assert.equal(pkg.listing, null, 'the marketplace listing is reserved and empty');
  assert.match(pkg.integrity, /^sha256-[A-Za-z0-9+/]+=*$/);
  for (const needle of [home, file, '.near-ai-teams', 'someone']) assert.equal(text.includes(needle), false, needle);
});

test('a team holding something that looks like a key is refused; one naming a local folder needs the person to agree', () => {
  const secret = renderTeam('Leaky', 'x', [{ name: 'dev', instructions: 'Use api_key=sk-live-0123456789abcdef when calling the service.' }]);
  const refused = shareProblems(secret, '/t/leaky.md');
  assert.match(refused.refused ?? '', /^This team can't be shared: member dev holds something that looks like a key, token or password\./);
  assert.equal((refused.refused ?? '').includes('sk-live'), false, 'the refusal never repeats the value');
  const local = renderTeam('Local', 'x', [{ name: 'dev', instructions: 'Read the notes in /home/someone/notes.md first.' }, { name: 'qa', instructions: 'Test it.' }]);
  assert.deepEqual(shareProblems(local, '/t/local.md', '/home/someone'), { paths: ['member dev'] });
  assert.deepEqual(shareProblems(TEAM, '/t/web.md', '/home/someone'), { paths: [] });
});

test('every built-in project type team can be shared as it is generated (no false alarms)', () => {
  for (const type of PROJECT_TYPES) {
    for (const locality of ['cloud', 'local'] as const) {
      const text = projectTypeTeam(type, 'Ship the thing', locality);
      assert.deepEqual(shareProblems(text, '/t/team.md', '/home/someone'), { paths: [] }, `${type.id} ${locality}`);
      assert.equal(readTeamPackage(buildTeamPackage(text, '/t/team.md')).team.members.length, parseTeam(text, 'x.md').members.length);
    }
  }
  assert.deepEqual(shareProblems(newTeamTemplate('Mine'), '/t/mine.md'), { paths: [] });
});

test('included knowledge loses local paths, local sources and secrets; web sources stay', () => {
  const cleaned = cleanKnowledge(knowledge(), '/home/someone');
  assert.ok(cleaned);
  const text = JSON.stringify(cleaned);
  assert.equal(text.includes('/home/someone'), false);
  assert.equal(text.includes('abc123def456'), false);
  assert.match(text, /https:\/\/example\.com\/prices/);
  const facts = cleaned!.nodes[0]!.facts;
  assert.equal(facts[0]!.source, undefined, 'a local source is dropped, not rewritten');
  assert.match(facts[0]!.text, /\[a local path\]/);
  // Round trip with the knowledge.
  const read = readTeamPackage(buildTeamPackage(TEAM, '/t/web.md', cleaned));
  assert.equal(read.facts, 3);
  assert.deepEqual(read.knowledge, cleaned);
  assert.deepEqual(findLocalPaths('see C:\\Users\\someone\\x.txt and ~/notes and file:///tmp/a and https://h/x').sort(), ['C:\\Users\\someone\\x.txt', 'file:///tmp/a', '~/notes']);
});

// ---------- import ----------

test('a share file round-trips through import: the same team, members and text', () => {
  const read = readTeamPackage(buildTeamPackage(TEAM, '/t/web.md'));
  assert.equal(read.markdown, TEAM);
  assert.deepEqual(read.team.members.map((member) => [member.name, member.role]), [['lead', 'planner'], ['dev', 'implementer']]);
  assert.equal(read.knowledge, null);
  const question = importQuestion(read);
  assert.match(question, /^Add the team "Web crew" to your teams\? Builds pages\. 2 members: lead \(planner\), model deep, tools: Read, Grep; dev \(implementer\), tools: Read/);
  assert.match(question, /It stays untrusted: the first time it runs you are asked to approve it\.$/);
});

test('a tampered or malformed share file is refused with a plain message', () => {
  const good = buildTeamPackage(TEAM, '/t/web.md');
  const pkg = JSON.parse(good);
  const damaged = /^This team file was changed or damaged after it was shared, so it was not imported\. Ask for the file again\.$/;
  const cases: Array<[string, string, RegExp]> = [
    ['an instruction changed', JSON.stringify({ ...pkg, team: { ...pkg.team, markdown: pkg.team.markdown.replace('Build it', 'Delete everything') } }), damaged],
    ['a tool added', JSON.stringify({ ...pkg, team: { ...pkg.team, markdown: pkg.team.markdown.replace('tools: Read, Grep', 'tools: Read, Grep, Bash') } }), damaged],
    ['the summary changed', JSON.stringify({ ...pkg, team: { ...pkg.team, members: 5 } }), damaged],
    ['a digest that does not match', JSON.stringify({ ...pkg, integrity: 'sha256-AAAA' }), damaged],
    ['an extra key', JSON.stringify({ ...pkg, run: 'curl evil' }), damaged],
    ['a listing in version 1', JSON.stringify({ ...pkg, listing: { price: 1 } }), damaged],
    ['knowledge of the wrong shape', JSON.stringify({ ...pkg, knowledge: { nodes: 'x' } }), damaged],
    ['not JSON', 'not json at all', /^This file is not a NEAR AI team\./],
    ['another format', JSON.stringify({ ...pkg, format: 'something-else' }), /^This file is not a NEAR AI team\./],
    ['a newer version', JSON.stringify({ ...pkg, formatVersion: 2 }), /^This team was shared from a newer version of NEAR AI\. Update the extension, then import it again\.$/],
    ['too large', `${' '.repeat(3 * 1024 * 1024)}{}`, /too large/]
  ];
  for (const [what, text, message] of cases) {
    assert.throws(() => readTeamPackage(text), (error: unknown) => error instanceof TeamPackageError && message.test(error.message), what);
  }
  // A share file whose (consistent) team text holds a key is refused too, even though it was not edited after export.
  const leaky = renderTeam('Leaky', 'x', [{ name: 'dev', instructions: 'token: Bearer abcdefghijklmnop' }]);
  const forged = JSON.parse(buildTeamPackage(TEAM, '/t/web.md'));
  forged.team = { name: 'Leaky', description: 'x', members: 1, markdown: leaky };
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  forged.integrity = `sha256-${createHash('sha256').update(JSON.stringify([leaky, null])).digest('base64')}`;
  assert.throws(() => readTeamPackage(JSON.stringify(forged)), /looks like a key, token or password/);
  assert.throws(() => readTeamMarkdown('---\ndescription: no name\n---\n'), /This team file can't be used: The team needs a name/);
});

// ---------- the approval an imported team needs ----------

test('an imported team asks before it first runs; declining keeps it unapproved, approving makes it one of the person\'s teams', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-imported-')));
  const own = await library.create('Own crew', TEAM.replace('Web crew', 'Own crew'));
  const imported = await library.importTeam('Web crew', TEAM);
  assert.deepEqual([...await library.pendingImports()], ['web-crew.md']);
  const asked: string[] = [];
  const ownTeam = parseTeam(await readFile(own, 'utf8'), own);
  assert.equal(await libraryTeamAllowed(ownTeam, library, async (question) => { asked.push(question); return true; }), true);
  assert.equal(asked.length, 0, 'a team the person made is never asked about');
  const team = parseTeam(await readFile(imported, 'utf8'), imported);
  assert.equal(await libraryTeamAllowed(team, library, async (question) => { asked.push(question); return false; }), false);
  assert.equal(await libraryTeamAllowed(team, library, async (question) => { asked.push(question); return undefined; }), false, 'closing the question is not approval');
  assert.equal(await library.isPendingImport(imported), true);
  assert.equal(asked.length, 2);
  assert.equal(asked[0], importedTeamQuestion(team));
  assert.match(asked[0]!, /^The team "Web crew" was imported from a file and has not been approved yet: lead \(planner\), dev \(implementer\)\. Use it\?/);
  assert.equal(await libraryTeamAllowed(team, library, async () => true), true);
  assert.equal(await library.isPendingImport(imported), false);
  assert.equal(await libraryTeamAllowed(team, library, async () => { throw new Error('asked again'); }), true, 'approved once, never asked again');
  // A project's own team is never an imported library team (it has its own question).
  assert.equal(await library.isPendingImport(TeamLibrary.projectTeamFile('/some/project')), false);
});

test('an unapproved import stays unapproved through Duplicate, Archive and Restore, and Delete forgets it', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-imported-')));
  const imported = await library.importTeam('Web crew', TEAM);
  const copy = await library.duplicate(imported, 'Web crew copy');
  assert.equal(await library.isPendingImport(copy), true, 'copying is never a way round the question');
  const archived = await library.archive(imported);
  assert.equal(await library.isPendingImport(archived), true);
  const restored = await library.restore(archived);
  assert.equal(await library.isPendingImport(restored), true);
  await library.delete(copy);
  assert.deepEqual((await readdir(path.join(library.directory, '.imported'))).sort(), ['web-crew.md']);
  // A legacy Import of a .md file is unapproved too.
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'near-ai-outside-')), 'shared.md');
  await writeFile(outside, newTeamTemplate('Shared team'));
  assert.equal(await library.isPendingImport(await library.import(outside)), true);
});

test('a conversation\'s imported team that was not approved is not used, and the chat says why once', async () => {
  const team = parseTeam(TEAM, '/lib/web-crew.md');
  const find = async (slug: string) => (slug === 'web-crew' ? team : undefined);
  const first = await workingTeamFor(find, 'web-crew', undefined, async () => true, async () => false);
  assert.equal(first.team, undefined);
  assert.match(first.notice ?? '', /^The imported team "Web crew" has not been approved, so this run continues without it\. Run \/team:web-crew again to be asked\.$/);
  const again = await workingTeamFor(find, 'web-crew', first.noticed, async () => true, async () => false);
  assert.deepEqual([again.team, again.notice], [undefined, undefined], 'said once');
  const approved = await workingTeamFor(find, 'web-crew', undefined, async () => true, async () => true);
  assert.equal(approved.team, team);
});

// ---------- the new-team picker ----------

const POINTS: StudioStartingPoint[] = [
  { id: 'recommend', group: 'recommend', label: 'Recommend a team for me', description: 'Answer three questions.', members: [] },
  { id: 'type:software', group: 'project-type', label: 'Software', description: 'Build software.', members: ['planner', 'implementer'] },
  { id: 'gsd:review', group: 'gsd', label: 'Review', description: 'Review code.', members: ['code-reviewer'] },
  { id: 'empty', group: 'empty', label: 'Start empty', description: 'Add every member yourself.', members: [] }
];
const member = (name: string) => ({ name, tier: 'deep', model: 'm', privacy: 'tee' as const, privacyText: 'TEE' });
const TEAMS: LibraryTeam[] = [
  { id: 'project', kind: 'project', name: 'Project team', description: 'This repo', file: '/p/.planning/.near-ai/team.md', members: [member('dev')] },
  { id: 'user:web-crew', kind: 'user', name: 'Web crew', description: 'Builds pages', file: '/lib/web-crew.md', savedAt: '2026-11-01T10:00:00.000Z', members: [member('lead'), member('dev')] },
  { id: 'user:shared', kind: 'user', name: 'Shared', description: 'From a colleague', file: '/lib/shared.md', imported: true, members: [member('qa')] },
  { id: 'user:broken', kind: 'user', name: 'broken', description: '', file: '/lib/broken.md', error: 'The team needs a name', members: [] }
];

test('the picker lists the person\'s saved teams and the built-in ones, with where each came from, under All, My teams and Built-in', () => {
  const entries = teamPicker(POINTS, TEAMS);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.source]), [['lib:web-crew', 'mine'], ['lib:shared', 'mine'], ['recommend', 'builtin'], ['type:software', 'builtin'], ['gsd:review', 'builtin'], ['empty', 'builtin']]);
  const web = entries[0]!;
  assert.deepEqual([web.label, web.description, web.memberCount, web.members, web.origin, web.teamId], ['Web crew', 'Builds pages', 2, ['lead', 'dev'], 'My team, saved 2026-11-01', 'user:web-crew']);
  assert.deepEqual([entries[1]!.origin, entries[1]!.imported], ['Imported, not approved yet', true]);
  assert.equal(entries.find((entry) => entry.id === 'type:software')!.origin, 'Built in: project type');
  assert.deepEqual(filterPicker(entries, 'all').map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.deepEqual(filterPicker(entries, 'mine').map((entry) => entry.id), ['lib:web-crew', 'lib:shared', 'empty']);
  assert.deepEqual(filterPicker(entries, 'builtin').map((entry) => entry.id), ['recommend', 'type:software', 'gsd:review', 'empty']);
  // No saved teams: My teams shows only "Start empty", and the page says how to get one.
  assert.deepEqual(filterPicker(teamPicker(POINTS, [TEAMS[0]!]), 'mine').map((entry) => entry.id), ['empty']);
  assert.match(NO_SAVED_TEAMS_TEXT, /^You have no saved teams yet\. Save a team as one of your teams in Team Studio/);
});

// 0.4.26 follow-up: anything made from an unapproved import stays unapproved, and approving the original does not approve it.
test('a duplicate of an unapproved import is unapproved in its own right: approving the original leaves it asking, and its question says where it came from', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-derived-')));
  const original = await library.importTeam('Web crew', TEAM);
  const copy = await library.duplicate(original, 'Web crew copy');
  assert.deepEqual(await library.pendingKind(copy), { kind: 'derived', from: 'Web crew' });
  assert.deepEqual(await library.pendingKind(original), { kind: 'imported' });
  // Archived and restored, the reason travels with it.
  const restored = await library.restore(await library.archive(copy));
  assert.deepEqual(await library.pendingKind(restored), { kind: 'derived', from: 'Web crew' });
  await library.approveImport(original);
  assert.equal(await library.isPendingImport(original), false);
  assert.equal(await library.isPendingImport(restored), true, 'approving the original does not approve its copy');
  const asked: string[] = [];
  const copyTeam = parseTeam(await readFile(restored, 'utf8'), restored);
  assert.equal(await libraryTeamAllowed(copyTeam, library, async (question) => { asked.push(question); return true; }), true);
  assert.match(asked[0] ?? '', /^The team "Web crew copy" was made from the imported team "Web crew", which you have not approved, and has not been approved yet: lead \(planner\), dev \(implementer\)\. Use it\?/);
  assert.equal(await library.isPendingImport(restored), false, 'each asks once');
});

test('a member copied unchanged from an unapproved team (imported or derived, in the library or archived) is found; approved and own teams are not', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-derived-')));
  const own = renderTeam('Own', 'x', [{ name: 'mine', instructions: 'Write   my\nown thing.' }]);
  await library.create('Own', own);
  assert.equal(await library.unapprovedSource([{ instructions: 'Write my own thing.' }]), undefined, 'a team the person made is not a source');
  const original = await library.importTeam('Web crew', TEAM);
  assert.equal(await library.unapprovedSource([{ instructions: 'Something new.' }, { instructions: '  Build it and   run the tests.\n' }]), 'Web crew', 'spacing does not hide a copy');
  assert.equal(await library.unapprovedSource([{ instructions: 'Build it and run the tests, then deploy.' }]), undefined, 'a changed member is the person\'s own');
  // Derived teams are sources too, and archiving does not hide one.
  const copy = await library.duplicate(original, 'Copy');
  await library.approveImport(original);
  assert.equal(await library.unapprovedSource([{ instructions: 'Plan the work.' }]), 'Copy');
  await library.archive(copy);
  assert.equal(await library.unapprovedSource([{ instructions: 'Plan the work.' }]), 'Copy');
  // A project team made from one keeps that fact on this computer, and a later rebuild from something else clears it.
  const project = TeamLibrary.projectTeamFile('/some/project');
  await library.setProjectDerived(project, 'Web crew');
  assert.equal(await library.projectDerivedFrom(project), 'Web crew');
  assert.deepEqual([...await library.pendingImports()].sort(), ['copy.md'], 'project notes are not library teams');
  await library.setProjectDerived(project, undefined);
  assert.equal(await library.projectDerivedFrom(project), undefined);
});
