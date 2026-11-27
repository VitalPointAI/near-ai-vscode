// D-48 of 0.4.34: a staff project knows its section teams. Set Up a Staff Team records each section's team in the project's staff settings
// (`staff.teams`), and the chat's "Staff teams" card, the /team menu and the Staff Room all read that one record, checked against the team library.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { J2_STAFF_TEMPLATE, J5_STAFF_TEMPLATE } from '../agent/staff/templates';
import { TeamLibrary } from '../agent/teams';
import { defaultStaffSettings, parseStaffSettings, staffSettingsJson } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { buildStaffRoomModel, parseStaffRoomMessage } from '../domain/staff/staffRoom';
import type { StaffRoomModel } from '../domain/staff/staffRoom';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { projectHasStaffTeam, projectHasTeam } from '../services/setupSteps';
import { applyStaffSetup, planStaffSetup, PROJECT_JSON, requestedSection, staffTeamCandidates } from '../services/staffSetup';
import { linkStaffTeam, projectStaffTeams, projectStaffTeamsReported, staffMenuEntries } from '../services/staffTeams';
import { onStaffTeamsChanged } from '../services/staffSetup';
import { setCasProbe } from '../staff/staffFiles';
import { handleStaffRoomMessage } from '../staff/staffRoomHost';
import type { StaffRoomEffects } from '../staff/staffRoomHost';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { FakeDocument, FakeNode } from './helpers/fakeDom';
import { project as staffRoomProject, NOW } from './helpers/staffRoomFixture';

const ROOT = path.join(__dirname, '..', '..');
const settings = (overrides: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...overrides });

async function folders(): Promise<{ root: string; library: TeamLibrary }> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-teams-'));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  return { root, library: new TeamLibrary(path.join(base, 'store')) };
}

async function setUp(root: string, library: TeamLibrary, templateId: string, options = { settings: settings(), locality: 'local' as const }, replace = false) {
  const projectJson = await readFile(path.join(root, PROJECT_JSON), 'utf8').catch(() => undefined);
  const plan = planStaffSetup({ templateId, options, ...(projectJson !== undefined ? { projectJson } : {}) });
  return applyStaffSetup(root, library, plan, { replace });
}

const projectJsonOf = async (root: string) => JSON.parse(await readFile(path.join(root, PROJECT_JSON), 'utf8')) as { staff: Record<string, unknown>; [key: string]: unknown };

// ---- The record ---------------------------------------------------------------------------------------------------------------------------------

test('staff.teams is read strictly: the four section keys only, each its own, each a team name; a round trip is exact', () => {
  const read = parseStaffSettings({ teams: { j2: 'j2-us-joint-operational', j5: 'j5-us-joint-operational' } });
  assert.ok(read.ok);
  assert.deepEqual(read.value.teams, { j2: 'j2-us-joint-operational', j5: 'j5-us-joint-operational' });
  assert.deepEqual(parseStaffSettings(staffSettingsJson(read.value)), read, 'what is written reads back the same');
  assert.deepEqual(staffSettingsJson(read.value).teams, { j2: 'j2-us-joint-operational', j5: 'j5-us-joint-operational' });
  // No teams yet: nothing is written for them, and an empty object reads as none.
  assert.equal('teams' in staffSettingsJson(defaultStaffSettings()), false);
  const empty = parseStaffSettings({ teams: {} });
  assert.ok(empty.ok && empty.value.teams === undefined);
  for (const [value, reason] of [
    [{ teams: { j1: 'x' } }, 'unknown-field'],
    [{ teams: { j2: 'x', command: 'y' } }, 'unknown-field'],
    [{ teams: { j2: '../escape' } }, 'wrong-type'],
    [{ teams: { j2: 'J2-Upper' } }, 'wrong-type'],
    [{ teams: { j2: 7 } }, 'wrong-type'],
    [{ teams: ['j2'] }, 'not-an-object'],
    [{ teams: 'j2' }, 'not-an-object']
  ] as const) {
    const refused = parseStaffSettings(value);
    assert.ok(!refused.ok && refused.reason === reason, JSON.stringify(value));
  }
  // A key that is only inherited is never read as the project's team (an object with another prototype is refused outright).
  const inherited = parseStaffSettings({ teams: Object.create({ j2: 'j2-us-joint-operational' }) as object });
  assert.ok(!inherited.ok || inherited.value.teams === undefined);
  // JSON's own __proto__ key is an unknown field, never a prototype.
  const proto = parseStaffSettings(JSON.parse('{"teams":{"__proto__":{"j2":"x"}}}'));
  assert.ok(!proto.ok && proto.reason === 'unknown-field');
});

test('Set Up a Staff Team records the section\'s team; another section adds its own; a re-run replaces only its own entry (after the archive)', async () => {
  const { root, library } = await folders();
  await writeFile(path.join(root, 'keep.txt'), 'x');
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify({ type: 'research', staff: { profile: 'us-joint', level: 'operational' } }));
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  let config = await projectJsonOf(root);
  assert.equal(config.type, 'research', 'the other fields are kept');
  assert.deepEqual(config.staff.teams, { j2: 'j2-us-joint-operational' });
  await setUp(root, library, J5_STAFF_TEMPLATE.id);
  config = await projectJsonOf(root);
  assert.deepEqual(config.staff.teams, { j2: 'j2-us-joint-operational', j5: 'j5-us-joint-operational' });
  // The J2 again, for the US Army at tactical level with the battalion roster: a different team name, and the J5 entry stays.
  const army = { settings: settings({ profile: 'us-army', level: 'tactical' }), echelon: 'battalion' as const, locality: 'local' as const };
  await setUp(root, library, J2_STAFF_TEMPLATE.id, army);
  config = await projectJsonOf(root);
  assert.deepEqual(config.staff.teams, { j2: 'j2-us-army-tactical-battalion', j5: 'j5-us-joint-operational' });
  // The same team set up again: refused without the archive confirm, and with it the file is archived and the entry stays the one name.
  await assert.rejects(setUp(root, library, J2_STAFF_TEMPLATE.id, army), /already in your teams/);
  const again = await setUp(root, library, J2_STAFF_TEMPLATE.id, army, true);
  assert.ok(again.archived);
  assert.deepEqual((await projectJsonOf(root)).staff.teams, { j2: 'j2-us-army-tactical-battalion', j5: 'j5-us-joint-operational' });
});

test('the file-name rule names the setup\'s teams for a section, profile and level (and the battalion J2)', () => {
  assert.deepEqual(staffTeamCandidates('j2', settings()), ['j2-us-joint-operational']);
  assert.deepEqual(staffTeamCandidates('j2', settings({ profile: 'us-army', level: 'tactical' })), ['j2-us-army-tactical', 'j2-us-army-tactical-battalion']);
  assert.deepEqual(staffTeamCandidates('j4', settings({ profile: 'nato-ca', level: 'operational' })), ['j4-nato-ca-operational']);
});

// ---- Reading it back ------------------------------------------------------------------------------------------------------------------------------

test('every section reads as ready, missing (deleted or renamed, never a command) or not set up, with matching library teams offered to link', async () => {
  const { root, library } = await folders();
  assert.deepEqual(await projectStaffTeams(root, library.directory), { staff: false, sections: [] }, 'no project.json: not a staff project');
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify({ type: 'research' }));
  assert.equal((await projectStaffTeams(root, library.directory)).staff, false);
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  await setUp(root, library, J5_STAFF_TEMPLATE.id);
  let teams = await projectStaffTeams(root, library.directory);
  assert.equal(teams.staff, true);
  assert.deepEqual(teams.sections.map((entry) => [entry.section, entry.code, entry.state, entry.team ?? '']), [
    ['j2', 'J-2', 'ready', 'j2-us-joint-operational'], ['j5', 'J-5', 'ready', 'j5-us-joint-operational'], ['j3', 'J-3', 'none', ''], ['j4', 'J-4', 'none', '']
  ]);
  assert.match(teams.sections[0].title ?? '', /\S/);
  // The J5 file renamed in the library: missing, by its recorded name.
  await rename(path.join(library.directory, 'j5-us-joint-operational.md'), path.join(library.directory, 'my-plans.md'));
  teams = await projectStaffTeams(root, library.directory);
  assert.deepEqual([teams.sections[1].state, teams.sections[1].team, teams.sections[1].title], ['missing', 'j5-us-joint-operational', undefined]);
  // A file that no longer reads as a team is missing too.
  await writeFile(path.join(library.directory, 'j2-us-joint-operational.md'), 'not a team');
  assert.equal((await projectStaffTeams(root, library.directory)).sections[0].state, 'missing');
  // A J3 team in the library under the rule's name, not recorded: offered, never linked by reading.
  await writeFile(path.join(library.directory, 'j3-us-joint-operational.md'), '---\nname: J3 ops\ndescription: x\n---\n\n## lead\nrole: lead\n\nLead.\n');
  teams = await projectStaffTeams(root, library.directory);
  assert.deepEqual([teams.sections[2].state, teams.sections[2].candidates], ['none', ['j3-us-joint-operational']]);
  assert.equal((await projectJsonOf(root)).staff.teams && 'j3' in ((await projectJsonOf(root)).staff.teams as object), false);
  // Settings that do not read: the reason, never an empty list without it.
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify({ staff: { teams: { j9: 'x' } } }));
  const bad = await projectStaffTeams(root, library.directory);
  assert.equal(bad.staff, true);
  assert.match(bad.problem ?? '', /not valid/);
  await writeFile(path.join(root, PROJECT_JSON), '{oops');
  assert.match((await projectStaffTeams(root, library.directory)).problem ?? '', /not valid JSON/);
});

test('linking an older project\'s library team: only a matching team, only for a section without one, never over a change, never through a link', async () => {
  const { root, library } = await folders();
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  // An older project: the J2 team is in the library, the settings record none.
  const config = await projectJsonOf(root);
  delete config.staff.teams;
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify(config, null, 2));
  assert.equal(await projectHasStaffTeam(root), false);
  assert.deepEqual((await projectStaffTeams(root, library.directory)).sections[0].candidates, ['j2-us-joint-operational']);
  assert.deepEqual(await linkStaffTeam(root, library.directory, 'j2', 'j5-us-joint-operational'), { ok: false, message: 'j5-us-joint-operational is not a J2 team for this project\'s profile and level.' });
  assert.match((await linkStaffTeam(root, library.directory, 'j5', 'j5-us-joint-operational') as { message: string }).message, /not in your teams/);
  // A member's write lands between the read and the write: nothing is written over it.
  setCasProbe(async (point, file) => { if (point === 'before-check' && file.endsWith('project.json')) await writeFile(file, JSON.stringify({ ...config, edited: true }, null, 2)); });
  try {
    assert.match((await linkStaffTeam(root, library.directory, 'j2', 'j2-us-joint-operational') as { message: string }).message, /changed while/);
  } finally { setCasProbe(undefined); }
  assert.equal((await projectJsonOf(root)).edited, true, 'the member\'s write stands');
  assert.deepEqual(await linkStaffTeam(root, library.directory, 'j2', 'j2-us-joint-operational'), { ok: true });
  const linked = await projectJsonOf(root);
  assert.deepEqual(linked.staff.teams, { j2: 'j2-us-joint-operational' });
  assert.equal(linked.edited, true, 'every other field is kept');
  assert.equal(await projectHasStaffTeam(root), true);
  assert.match((await linkStaffTeam(root, library.directory, 'j2', 'j2-us-joint-operational') as { message: string }).message, /already has a J2 team/);
  // A symbolic link on the way is refused before anything is read.
  const other = await folders();
  await mkdir(path.join(other.root, '.planning'), { recursive: true });
  await symlink(path.join(root, '.planning', '.near-ai'), path.join(other.root, '.planning', '.near-ai'));
  assert.match((await linkStaffTeam(other.root, library.directory, 'j2', 'j2-us-joint-operational') as { message: string }).message, /symbolic link/);
});

test('a project with a staff team counts as having a team; staff settings with none do not', async () => {
  const { root, library } = await folders();
  assert.equal(await projectHasTeam(root), false);
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify({ staff: { profile: 'us-joint' } }));
  assert.equal(await projectHasTeam(root), false);
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  assert.equal(await projectHasTeam(root), true);
});

test('the /team menu lists the ready staff teams first, in section order, labelled by section', async () => {
  const { root, library } = await folders();
  await setUp(root, library, J5_STAFF_TEMPLATE.id);
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  const entries = staffMenuEntries(await projectStaffTeams(root, library.directory));
  assert.deepEqual(entries.map((entry) => entry.command), ['team:j2-us-joint-operational', 'team:j5-us-joint-operational']);
  assert.match(entries[0].description, /^J-2 intelligence staff team/);
  assert.match(entries[1].title, /^J-5 plans: /);
  assert.equal(entries[0].argumentHint, '<task for the J-2 team>');
  // A missing team is not offered as a command.
  await rename(path.join(library.directory, 'j2-us-joint-operational.md'), path.join(library.directory, 'gone.md'));
  assert.deepEqual(staffMenuEntries(await projectStaffTeams(root, library.directory)).map((entry) => entry.command), ['team:j5-us-joint-operational']);
  // The host puts these first (src/services/chat.ts commandList).
  const chat = await readFile(path.join(ROOT, 'src', 'services', 'chat.ts'), 'utf8');
  assert.match(chat, /return \[\.\.\.staff, \.\.\.all\.filter\(\(entry\) => !listed\.has\(entry\.command\)\), \.\.\.await gsdCommandList\(host\)\];/);
});

// ---- The chat's card --------------------------------------------------------------------------------------------------------------------------------

interface StaffKit {
  renderStaffTeams(doc: FakeDocument, container: FakeNode, model: unknown, post: (message: unknown) => void, fill: (text: string) => void): FakeNode | undefined;
  STAFF_TEXT: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = require(path.join(ROOT, 'media', 'chat', 'setup.js')) as StaffKit;

function emptyChat(): { doc: FakeDocument; welcome: FakeNode } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome-ready';
  doc.body.append(welcome);
  return { doc, welcome };
}

const CARD_MODEL = {
  staff: true,
  sections: [
    { section: 'j2', code: 'J-2', role: 'Intelligence', state: 'ready', team: 'j2-us-joint-operational', title: 'J-2 intelligence' },
    { section: 'j5', code: 'J-5', role: 'Plans', state: 'missing', team: 'j5-us-joint-operational' },
    { section: 'j3', code: 'J-3', role: 'Operations', state: 'none', candidates: ['j3-us-joint-operational'] },
    { section: 'j4', code: 'J-4', role: 'Logistics', state: 'none' }
  ]
};

test('the chat\'s Staff teams card lists each section: Task fills the message box, a missing team offers Set up again, others Set up or Link', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  const filled: string[] = [];
  const card = kit.renderStaffTeams(doc, welcome, CARD_MODEL, (message) => posts.push(message), (text) => filled.push(text))!;
  assert.equal(welcome.children[0], card);
  assert.equal(card.attributes.get('role'), 'region');
  assert.equal(card.attributes.get('aria-labelledby'), 'staff-teams-title');
  assert.equal(doc.getElementById('staff-teams-title')?.textContent, 'Staff teams');
  const buttons = card.all((node) => node.tagName === 'button');
  const byKey = (key: string) => buttons.find((button) => button.getAttribute('data-key') === key)!;
  assert.deepEqual(buttons.map((button) => [button.getAttribute('data-key'), button.textContent, button.type]), [
    ['task-j2', 'Task', 'button'],
    ['setup-j5', 'Set up again', 'button'],
    ['link-j3-j3-us-joint-operational', 'Link j3-us-joint-operational', 'button'],
    ['setup-j3', 'Set up', 'button'],
    ['setup-j4', 'J-4 logistics', 'button']
  ]);
  assert.match(byKey('task-j2').getAttribute('aria-label') ?? '', /Task the J-2 intelligence team, j2-us-joint-operational/);
  assert.ok(card.all((node) => node.textContent === 'Set up another section:').length === 1);
  assert.ok(card.all((node) => /Missing from your teams/.test(node.textContent)).length === 1);
  // The missing team is named but never offered as a command.
  assert.equal(card.all((node) => /\/team:j5/.test(node.textContent)).length, 0);
  byKey('task-j2').click();
  assert.deepEqual(filled, ['/team:j2-us-joint-operational']);
  assert.deepEqual(posts, [], 'Task sends nothing to the host');
  byKey('setup-j5').click();
  byKey('link-j3-j3-us-joint-operational').click();
  byKey('setup-j4').click();
  assert.deepEqual(posts, [
    { type: 'staff-teams', action: 'set-up', section: 'j5' },
    { type: 'staff-teams', action: 'link', section: 'j3', team: 'j3-us-joint-operational' },
    { type: 'staff-teams', action: 'set-up', section: 'j4' }
  ]);
  for (const text of Object.values(kit.STAFF_TEXT)) assert.doesNotMatch(text, /[—–]/, text);
});

test('the card redraws in place keeping the focused button, ignores what does not fit, and goes away outside a staff project', () => {
  const { doc, welcome } = emptyChat();
  const first = kit.renderStaffTeams(doc, welcome, CARD_MODEL, () => undefined, () => undefined)!;
  doc.activeElement = first.all((node) => node.getAttribute('data-key') === 'setup-j4')[0];
  const second = kit.renderStaffTeams(doc, welcome, CARD_MODEL, () => undefined, () => undefined)!;
  assert.equal(welcome.all((node) => node.id === 'staff-teams').length, 1);
  assert.equal(doc.activeElement?.getAttribute('data-key'), 'setup-j4');
  assert.ok(second.contains(doc.activeElement));
  // A section the card does not know, or a team name not in the library's form, is not drawn.
  const odd = kit.renderStaffTeams(doc, welcome, { sections: [{ section: 'j9', code: 'J9', role: 'x', state: 'ready', team: 'x' }, { section: 'j2', code: 'J-2', role: 'Intelligence', state: 'ready', team: 'rm -rf' }] }, () => undefined, () => undefined)!;
  assert.equal(odd.all((node) => node.tagName === 'button').length, 0);
  // Link candidates are only an array of team names (#124 review): anything else in that field leaves the section plain "not set up", never a
  // "Found:" line with nothing to link.
  for (const candidates of ['j2-us-joint-operational', { 0: 'j2-us-joint-operational', length: 1 }, [42], [null, 'rm -rf'], 7]) {
    const card = kit.renderStaffTeams(doc, welcome, { sections: [{ section: 'j2', code: 'J-2', role: 'Intelligence', state: 'none', candidates }] }, () => undefined, () => undefined)!;
    assert.equal(card.all((node) => /^link-/.test(node.getAttribute('data-key') ?? '')).length, 0, JSON.stringify(candidates));
    assert.equal(card.all((node) => node.className === 'staff-team-missing').length, 0, `no "Found:" line for ${JSON.stringify(candidates)}`);
    assert.equal(card.all((node) => node.getAttribute('data-key') === 'setup-j2').length, 1, JSON.stringify(candidates));
  }
  const mixed = kit.renderStaffTeams(doc, welcome, { sections: [{ section: 'j2', code: 'J-2', role: 'Intelligence', state: 'none', candidates: [42, 'j2-us-joint-operational'] }] }, () => undefined, () => undefined)!;
  assert.deepEqual(mixed.all((node) => /^link-/.test(node.getAttribute('data-key') ?? '')).map((node) => node.getAttribute('data-key')), ['link-j2-j2-us-joint-operational']);
  // A first section to set up says so.
  const none = kit.renderStaffTeams(doc, welcome, { sections: CARD_MODEL.sections.map((entry) => ({ section: entry.section, code: entry.code, role: entry.role, state: 'none' })) }, () => undefined, () => undefined)!;
  assert.ok(none.all((node) => node.textContent === 'Set up a section:').length === 1);
  assert.equal(kit.renderStaffTeams(doc, welcome, null, () => undefined, () => undefined), undefined);
  assert.equal(doc.getElementById('staff-teams'), undefined);
});

test('the chat draws the Staff teams card from the host and fills the message box with the composer\'s own insert', async () => {
  const script = await readFile(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /case 'staff-teams': if \(setupKit\.renderStaffTeams\) setupKit\.renderStaffTeams\(document, welcomeReady, m\.model, post, fillCommand\); break;/);
  assert.match(script, /function fillCommand\(text\) \{[\s\S]*?window\.nearComposer\.insertCommand\(input\.value, text\)[\s\S]*?input\.setSelectionRange\(next\.caret, next\.caret\)/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const composer = require(path.join(ROOT, 'media', 'chat', 'composer.js')) as { insertCommand(draft: string, command: string): { text: string; caret: number } };
  assert.deepEqual(composer.insertCommand('', '/team:j2-us-joint-operational'), { text: '/team:j2-us-joint-operational ', caret: 30 });
});

test('the card\'s messages are exact: no extra, missing or inherited key, a known section and a team name only', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'staff-teams', action: 'set-up', section: 'j3' }), { type: 'staff-teams', action: 'set-up', section: 'j3' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'staff-teams', action: 'link', section: 'j3', team: 'j3-us-joint-operational' }), { type: 'staff-teams', action: 'link', section: 'j3', team: 'j3-us-joint-operational' });
  for (const bad of [
    { type: 'staff-teams', action: 'set-up', section: 'j3', team: 'x' },
    { type: 'staff-teams', action: 'set-up', section: 'j3', conversationId: 'conv-abcdefgh' },
    { type: 'staff-teams', action: 'set-up' },
    { type: 'staff-teams', action: 'link', section: 'j3' },
    { type: 'staff-teams', action: 'set-up', section: 'j1' },
    { type: 'staff-teams', action: 'set-up', section: 'command' },
    { type: 'staff-teams', action: 'link', section: 'j3', team: '../../etc/passwd' },
    { type: 'staff-teams', action: 'link', section: 'j3', team: 'Upper' },
    { type: 'staff-teams', action: 'run', section: 'j3' },
    Object.assign(Object.create({ section: 'j3' }) as object, { type: 'staff-teams', action: 'set-up' }),
    Object.assign(Object.create({ action: 'set-up' }) as object, { type: 'staff-teams', section: 'j3' }),
    Object.assign(Object.create({ type: 'staff-teams' }) as object, { action: 'set-up', section: 'j3' })
  ]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
});

test('the setup command takes a section only as { section } and names the team and how to task it when it is done', async () => {
  assert.equal(requestedSection({ section: 'j5' }), 'j5');
  for (const bad of [undefined, 'j5', ['j5'], { section: 'j1' }, { section: 'j5', templateId: 'x' }, Object.create({ section: 'j5' }) as object]) assert.equal(requestedSection(bad), undefined, JSON.stringify(bad));
  const source = await readFile(path.join(ROOT, 'src', 'services', 'staffSetupCommand.ts'), 'utf8');
  assert.match(source, /export const TASK_NOW_ACTION = 'Task it now';/);
  assert.match(source, /const taskNow = translated \? 'Confier une tâche maintenant' : TASK_NOW_ACTION;/);
  assert.match(source, /const staffRoom = translated \? 'Ouvrir la salle d’état-major' : OPEN_STAFF_ROOM_ACTION;/);
  assert.match(source, /const actions = chat \? \[taskNow, staffRoom\] : \[staffRoom\];/);
  assert.match(source, /if \(choice === taskNow && chat\) void chat\.prefill\(`\/team:\$\{slug\}`\);/);
  const extension = await readFile(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /registerStaffSetup\(context, \{ chat: sidebar \}\);/, 'activation supplies Chat and leaves fixture setup disabled');
  assert.match(extension, /registerStaffRoom\(context, gate, sidebar\);/);
});

// ---- The Staff Room -----------------------------------------------------------------------------------------------------------------------------------

test('the Staff Room\'s section messages are exact: task-team and set-up-section with a known section, nothing extra, missing or inherited', () => {
  assert.deepEqual(parseStaffRoomMessage({ type: 'task-team', section: 'j2' }), { type: 'task-team', section: 'j2' });
  assert.deepEqual(parseStaffRoomMessage({ type: 'set-up-section', section: 'j4' }), { type: 'set-up-section', section: 'j4' });
  for (const bad of [
    { type: 'task-team', section: 'j2', team: 'j2-us-joint-operational' },
    { type: 'task-team' },
    { type: 'task-team', section: 'command' },
    { type: 'set-up-section', section: 'J2' },
    { type: 'set-up-section', section: 'j2', command: 'workbench.action.terminal.new' },
    Object.assign(Object.create({ section: 'j2' }) as object, { type: 'task-team' }),
    Object.assign(Object.create({ type: 'set-up-section' }) as object, { section: 'j2' })
  ]) assert.equal(parseStaffRoomMessage(bad), undefined, JSON.stringify(bad));
});

async function roomModel(teams?: Parameters<typeof buildStaffRoomModel>[0]['teams']): Promise<StaffRoomModel> {
  const { world } = await staffRoomProject();
  const input = await loadStaffRoomInput(world.host, world.root, NOW);
  return buildStaffRoomModel({ ...input, ...(teams ? { teams } : {}) });
}

test('each section card carries its team from the record: ready with its name, missing, or none; the command group has none', async () => {
  const without = await roomModel();
  assert.ok(without.squads.every((squad) => squad.team === undefined), 'no record read: no team line');
  const model = await roomModel([
    { section: 'j2', state: 'ready', team: 'j2-us-joint-operational' },
    { section: 'j5', state: 'missing', team: 'j5-us-joint-operational' },
    { section: 'j3', state: 'none' },
    { section: 'j4', state: 'ready', team: 'not a name' }
  ]);
  assert.deepEqual(model.squads.map((squad) => [squad.section, squad.team]), [
    ['command', undefined],
    ['j2', { state: 'ready', name: 'j2-us-joint-operational' }],
    ['j5', { state: 'missing', name: 'j5-us-joint-operational' }],
    ['j3', { state: 'none' }],
    ['j4', { state: 'none' }]
  ]);
});

test('"Task in chat" fills the chat only for the team the host last sent as ready; "Set up" runs the setup for that section', async () => {
  const model = await roomModel([{ section: 'j2', state: 'ready', team: 'j2-us-joint-operational' }, { section: 'j5', state: 'missing', team: 'j5-us-joint-operational' }]);
  const tasked: string[] = [];
  const commands: Array<[string, unknown]> = [];
  const notices: string[] = [];
  const effects: StaffRoomEffects = {
    model: () => model, runCommand: async (command, args) => { commands.push([command, args]); }, openFile: async () => undefined, selectRun: () => undefined,
    refresh: () => undefined, notice: (text) => notices.push(text), taskInChat: async (team) => { tasked.push(team); }
  };
  assert.equal(await handleStaffRoomMessage({ type: 'task-team', section: 'j2' }, effects), 'done');
  assert.deepEqual(tasked, ['j2-us-joint-operational']);
  assert.equal(await handleStaffRoomMessage({ type: 'task-team', section: 'j5' }, effects), 'refused', 'a missing team is never tasked');
  assert.equal(await handleStaffRoomMessage({ type: 'task-team', section: 'j3' }, effects), 'refused');
  assert.deepEqual(tasked, ['j2-us-joint-operational']);
  assert.equal(notices.length, 2);
  assert.equal(await handleStaffRoomMessage({ type: 'task-team', section: 'j2', team: 'evil' }, effects), 'ignored');
  assert.equal(await handleStaffRoomMessage({ type: 'set-up-section', section: 'j5' }, effects), 'done');
  assert.deepEqual(commands, [['nearAi.setUpStaffTeam', { section: 'j5' }]]);
  // Without a chat to fill, the room says so rather than doing something else.
  const { taskInChat: _unused, ...noChat } = effects;
  assert.equal(await handleStaffRoomMessage({ type: 'task-team', section: 'j2' }, noChat), 'refused');
});

test('the chat\'s read of the staff teams never fails in silence: an error is logged and becomes the card\'s reason, a bad record is logged (D-48 of 0.4.35)', async () => {
  const { root, library } = await folders();
  const logged: string[] = [];
  // Not a staff project: nothing logged, no card.
  assert.deepEqual(await projectStaffTeamsReported(root, () => library.directory, (line) => logged.push(line)), { staff: false, sections: [] });
  assert.equal(logged.length, 0);
  await setUp(root, library, J2_STAFF_TEMPLATE.id);
  assert.equal((await projectStaffTeamsReported(root, () => library.directory, (line) => logged.push(line))).sections[0].state, 'ready');
  assert.equal(logged.length, 0);
  // An unexpected error (here, working out the library folder): logged with its stack, and the card says why instead of turning into "no team yet".
  const failed = await projectStaffTeamsReported(root, () => { throw new Error('HOME is not set'); }, (line) => logged.push(line));
  assert.deepEqual([failed.staff, failed.sections, failed.problem], [true, [], 'HOME is not set. The SovAI output has the details.']);
  assert.match(logged.at(-1) ?? '', /^Staff teams could not be read: Error: HOME is not set/);
  // A record that does not read: the reason is on the card and in the log.
  await writeFile(path.join(root, PROJECT_JSON), JSON.stringify({ staff: { profile: 'nobody' } }));
  const bad = await projectStaffTeamsReported(root, () => library.directory, (line) => logged.push(line));
  assert.equal(bad.staff, true);
  assert.match(bad.problem ?? '', /are not valid/);
  assert.equal(logged.at(-1), `Staff teams: ${bad.problem}`);
});

test('Set Up a Staff Team and Link tell the chat they wrote the project\'s staff teams; a refused or failed write does not, and a listener that throws stops nothing', async () => {
  const { root, library } = await folders();
  const told: string[] = [];
  const throwing = onStaffTeamsChanged(() => { throw new Error('listener'); });
  const listening = onStaffTeamsChanged((changed) => told.push(changed));
  try {
    await setUp(root, library, J2_STAFF_TEMPLATE.id);
    assert.deepEqual(told, [root], 'the setup tells once, after everything is written');
    await assert.rejects(setUp(root, library, J2_STAFF_TEMPLATE.id), /already in your teams/);
    assert.deepEqual(told, [root], 'a refused setup tells nothing');
    // Link: the J5 team in the library, the record without it.
    await setUp(root, library, J5_STAFF_TEMPLATE.id);
    const config = await projectJsonOf(root);
    config.staff.teams = { j2: 'j2-us-joint-operational' };
    await writeFile(path.join(root, PROJECT_JSON), JSON.stringify(config, null, 2));
    told.length = 0;
    assert.match((await linkStaffTeam(root, library.directory, 'j5', 'j2-us-joint-operational') as { message: string }).message, /not a J5 team/);
    assert.deepEqual(told, [], 'a refused link tells nothing');
    assert.deepEqual(await linkStaffTeam(root, library.directory, 'j5', 'j5-us-joint-operational'), { ok: true });
    assert.deepEqual(told, [root]);
  } finally {
    throwing.dispose();
    listening.dispose();
  }
  await setUp(root, library, J2_STAFF_TEMPLATE.id, { settings: settings({ level: 'strategic' }), locality: 'local' });
  assert.deepEqual(told, [root], 'nothing after the listener is disposed');
});
