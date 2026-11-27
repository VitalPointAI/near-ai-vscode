import { persistInstitutionalStaffSetup, planInstitutionalStaffSetup } from './helpers/institutional/institutionalSetup';
import { createInstitutionalStaffSetupFixture } from './helpers/institutional/institutionalPicker';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { INSTITUTIONAL_COMMAND_GROUP_TEAM, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, institutionalCommandGroupDefinition, institutionalCommandGroupSkill, institutionalRole, selectedTeamAgents } from './helpers/institutional/institutionalCommand';
import { staffGuidanceIn, withStaffGuidance } from '../agent/staff/guidance';
import { J2_STAFF_TEMPLATE, J3_STAFF_TEMPLATE, J4_STAFF_TEMPLATE, J5_STAFF_TEMPLATE, STAFF_TEMPLATES } from '../agent/staff/templates';
import { builtInStaffServers } from '../agent/staffServers';
import { applyGuidanceUpdate, applyTeamUpdate, detectTemplate, planStaffGuidanceUpdate, planTeamUpdate } from '../agent/teamUpdate';
import { parseTeam, TeamLibrary } from '../agent/teams';
import { PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { defaultStaffSettings, parseStaffSettings } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { applyStaffSetup, levelChoices, nationChoices, planStaffSetup, profileChoices, settingsFrom, staffTeamFileName, staffTeamTarget, templateQuestions } from '../services/staffSetup';
import { buildStudioContext, parseStudioMessage } from '../services/teamStudioPage';
import { TeamUpdater } from '../services/teamUpdates';
import { setCasProbe } from '../staff/staffFiles';
import { buildToolsDirectory, type DirectoryInput } from '../services/toolsDirectory';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

// Drop 1 integration: the staff servers on the Tools page and in the Team Studio picker, SovAI: Set Up a Staff Team, and Update Team for staff teams.

const input: DirectoryInput = {
  gsd: { version: '1.40.0', skills: [], agents: [] }, teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [],
  models: [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }],
  settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3' }, roleModels: {}, visionModel: 'x', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'x' }
};
const settings = (overrides: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...overrides });
const DECISION_VERBS = /__(?:approve|reject|release|supersede|decide|sign)\b/;

// ---- Item 9: the tools show up ----------------------------------------------------------------------------------------------------------------

test('the Tools page lists the eight built-in staff servers with every tool and grant, and no decision verb', () => {
  const directory = buildToolsDirectory(input);
  assert.deepEqual(directory.staffServers.map((server) => server.grant), ['mcp:staff-products', 'mcp:guard-scan', 'mcp:intel-workbench', 'mcp:observations', 'mcp:cop-map', 'mcp:logistics', 'mcp:orders', 'mcp:battle-rhythm']);
  const names = directory.staffServers.flatMap((server) => server.tools.map((tool) => tool.name));
  for (const tool of builtInStaffServers().flatMap((server) => server.tools)) assert.ok(names.includes(tool.name), tool.name);
  assert.ok(names.includes('mcp__staff-products__lint') && names.includes('mcp__guard-scan__scan') && names.includes('mcp__intel-workbench__source_add') && names.includes('mcp__logistics__calc_run') && names.includes('mcp__orders__assemble') && names.includes('mcp__battle-rhythm__ics_import'));
  for (const name of names) assert.doesNotMatch(name, DECISION_VERBS);
  for (const server of directory.staffServers) assert.ok(server.tools.every((tool) => tool.name.startsWith(`mcp__${server.id}__`)), server.id);
  // The intel-workbench is not a catalog tool, so the staff servers are where the page shows it.
  assert.ok(!directory.tools.some((tool) => tool.name.startsWith('mcp__intel-workbench__') || tool.name.startsWith('mcp__logistics__')));
});

test('the Tools page script draws the staff servers', () => {
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'tools', 'tools.js'), 'utf8');
  assert.match(script, /renderStaffServers\(root, data\.staffServers \|\| \[\]\)/);
  assert.match(script, /Built-in staff servers/);
});

test('the Team Studio tool picker offers each staff server as a grant and tool by tool, grouped by server', () => {
  const context = buildStudioContext(input, { hasProject: true, knowledgeBase: false });
  for (const server of builtInStaffServers()) {
    const grant = context.tools.find((tool) => tool.name === server.grant);
    assert.ok(grant?.server && grant.server.id === server.id, server.grant);
    for (const tool of server.tools) {
      const found = context.tools.filter((entry) => entry.name === tool.name);
      assert.equal(found.length, 1, `${tool.name} is offered once`);
      assert.equal(found[0].server?.id, server.id, tool.name);
    }
  }
  for (const tool of context.tools) assert.doesNotMatch(tool.name, DECISION_VERBS);
  // Plain tools carry no server.
  assert.equal(context.tools.find((tool) => tool.name === 'Read')?.server, undefined);
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'teams', 'teams.js'), 'utf8');
  assert.match(page, /tool\.status !== 'off' && !tool\.server/, '"Everything" leaves the staff servers out');
});

// ---- Item 10: Set Up a Staff Team --------------------------------------------------------------------------------------------------------------

test('the setup offers only what each template is written for', () => {
  assert.deepEqual(profileChoices(J2_STAFF_TEMPLATE).map((choice) => choice.value), ['us-joint', 'us-army', 'nato-ca']);
  assert.deepEqual(levelChoices(J2_STAFF_TEMPLATE, 'us-joint').map((choice) => choice.value), ['strategic', 'operational']);
  assert.deepEqual(levelChoices(J5_STAFF_TEMPLATE, 'us-army').map((choice) => choice.value), ['tactical']);
  assert.deepEqual(nationChoices('us-joint'), []);
  assert.deepEqual(nationChoices('nato-ca').map((choice) => choice.value), ['ca', 'nato']);
  assert.deepEqual(templateQuestions(J2_STAFF_TEMPLATE, { profile: 'us-army', level: 'tactical' }).echelon?.map((choice) => choice.value), ['brigade', 'battalion']);
  assert.deepEqual(templateQuestions(J2_STAFF_TEMPLATE, { profile: 'us-joint', level: 'operational' }), {});
  assert.ok(templateQuestions(J5_STAFF_TEMPLATE, { profile: 'us-army', level: 'tactical' }).variant);
  assert.equal(templateQuestions(J5_STAFF_TEMPLATE, { profile: 'us-joint', level: 'operational' }).variant, undefined);
  assert.ok(templateQuestions(J5_STAFF_TEMPLATE, { profile: 'nato-ca', level: 'operational' }).redTeam);
  assert.equal(templateQuestions(J5_STAFF_TEMPLATE, { profile: 'us-joint', level: 'operational' }).redTeam, undefined);
  // Horizons and phases the project already set are kept; a nation is only kept under NATO/Canadian.
  const kept = settingsFrom(settings({ profile: 'nato-ca', nation: 'ca', phases: ['Shape'] }), { profile: 'us-joint', level: 'operational', planningType: 'crisis' });
  assert.equal(kept.nation, undefined);
  assert.deepEqual(kept.phases, ['Shape']);
  assert.equal(settingsFrom(undefined, { profile: 'nato-ca', level: 'tactical', planningType: 'campaign' }).nation, 'nato');
});

test('the setup plan shows the roster and writes the team, skills, PROFILE.md, settings and guidance, keeping the rest', () => {
  const options = { settings: settings(), locality: 'cloud' as const };
  const agents = '# Agent instructions\n\nMy own notes.\n';
  const projectJson = JSON.stringify({ type: 'research', templateVersion: 3 });
  const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options, agents, projectJson });
  const team = parseTeam(plan.team, `${plan.roster.fileName}.md`);
  assert.equal(team.staff?.section, 'j2');
  assert.equal(team.private, true);
  assert.equal(plan.roster.members.length, team.members.length);
  assert.ok(plan.roster.humanLead, 'the roster names who decides');
  assert.ok(plan.roster.members.some((member) => member.name === 'release-guard'));
  assert.equal(plan.roster.fileName, 'j2-us-joint-operational');
  assert.match(plan.team, /^---[\s\S]*template: j2-intelligence\ntemplateVersion: \d+\ntemplateBase:/);
  const byPath = new Map(plan.writes.map((write) => [write.path, write.content]));
  assert.ok(byPath.has('.planning/staff/PROFILE.md') && byPath.has('.planning/staff/skills/icd203-standards.md'));
  const config = JSON.parse(byPath.get('.planning/.near-ai/project.json')!);
  assert.equal(config.type, 'research');
  assert.equal(config.templateVersion, 3);
  assert.ok(parseStaffSettings(config.staff).ok);
  const written = byPath.get('AGENTS.md')!;
  assert.match(written, /My own notes\./);
  assert.equal(staffGuidanceIn(written, J2_STAFF_TEMPLATE.id), J2_STAFF_TEMPLATE.render(options).guidance);
  assert.throws(() => planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options, projectJson: '[1]' }), /not a JSON object/);
  assert.throws(() => planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options, projectJson: '{oops' }), /not valid JSON/);
  // A J5 team for the same project keeps the J2 block and adds its own.
  const j5 = planStaffSetup({ templateId: J5_STAFF_TEMPLATE.id, options, agents: written });
  const both = j5.writes.find((write) => write.path === 'AGENTS.md')!.content;
  assert.ok(staffGuidanceIn(both, J2_STAFF_TEMPLATE.id) && staffGuidanceIn(both, J5_STAFF_TEMPLATE.id));
  assert.notEqual(staffTeamFileName(J5_STAFF_TEMPLATE, options), plan.roster.fileName);
  assert.equal(staffTeamFileName(J2_STAFF_TEMPLATE, { settings: settings({ profile: 'us-army', level: 'tactical' }), echelon: 'battalion' }), 'j2-us-army-tactical-battalion');
});

test('applying the setup writes into the project and the team library, archives an earlier team, and refuses symbolic links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'staff-setup-'));
  const library = new TeamLibrary(path.join(root, 'store'));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options: { settings: settings(), locality: 'local' } });
  const first = await applyStaffSetup(project, library, plan);
  assert.equal(parseTeam(await readFile(first.teamFile, 'utf8'), first.teamFile).staff?.section, 'j2');
  assert.ok((await library.list()).some((entry) => entry.file === first.teamFile && entry.team?.staff));
  assert.ok(first.written.includes('AGENTS.md'));
  assert.match(await readFile(path.join(project, '.planning', 'staff', 'PROFILE.md'), 'utf8'), /\S/);
  // A second setup of the same team needs the person's yes, and keeps the earlier file in the archive.
  await assert.rejects(applyStaffSetup(project, library, plan), /already in your teams/);
  assert.equal((await staffTeamTarget(library, plan)).exists, true);
  const second = await applyStaffSetup(project, library, plan, { replace: true });
  assert.ok(second.archived && (await library.archived()).includes(second.archived));
  // A link on the way into the project is refused before anything is written.
  const linked = path.join(root, 'linked');
  await mkdir(path.join(linked, '.planning'), { recursive: true });
  await mkdir(path.join(root, 'elsewhere'), { recursive: true });
  await symlink(path.join(root, 'elsewhere'), path.join(linked, '.planning', 'staff'));
  const before = await readdir(library.directory);
  await assert.rejects(applyStaffSetup(linked, library, { ...plan, roster: { ...plan.roster, fileName: 'another' } }), /symbolic link/);
  assert.deepEqual(await readdir(library.directory), before);
  assert.deepEqual(await readdir(path.join(root, 'elsewhere')), []);
});

function staffSetupVscode() {
  const stub = createVscodeStub();
  Object.assign(stub.vscode as object, { QuickPickItemKind: { Separator: -1 } });
  const uninstall = installVscodeStub(stub);
  const commandModule = require.resolve('../services/staffSetupCommand');
  const cached = require.cache[commandModule];
  delete require.cache[commandModule];
  try {
    const command = require(commandModule) as typeof import('../services/staffSetupCommand');
    return { stub, setUpStaffTeam: command.setUpStaffTeam, registerStaffSetup: command.registerStaffSetup, fixture: createInstitutionalStaffSetupFixture(stub.vscode as never, command.SET_UP_ACTION), uninstall };
  } catch (error) {
    uninstall();
    throw error;
  } finally {
    if (cached) require.cache[commandModule] = cached;
    else delete require.cache[commandModule];
  }
}

function profileState() {
  const records = new Map<string, unknown>();
  const writes: string[] = [];
  const globalState = {
    get: <T>(key: string) => records.get(key) as T | undefined,
    async update(key: string, value: unknown) {
      writes.push(key);
      records.set(key, structuredClone(value));
    },
    setKeysForSync() { assert.fail('institutional staging is local to this profile'); },
  };
  return { records, writes, globalState, context: { subscriptions: [], globalState } as never };
}

const institutionalStageKey = (project: string) => `nearAi.staff.institutional.commandGroup.v1.${createHash('sha256').update(project).digest('hex')}`;

test('Studio staff setup confirms the selected physical project and holds changes to reviewed files or the shared team', async () => {
  for (const scenario of ['write', 'edit during questions', 'edit at confirmation', 'replace directory', 'switch during apply', 'team appeared', 'existing shared team'] as const) {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-staff-setup-')));
    const other = path.join(temp, 'other');
    const root = path.join(temp, 'selected');
    const projectFile = path.join(root, '.planning', '.near-ai', 'project.json');
    const agentsFile = path.join(root, 'AGENTS.md');
    const profileFile = path.join(root, '.planning', 'staff', 'PROFILE.md');
    const profileBytes = '# Existing staff profile\n';
    const projectBytes = '{"custom":"preserve"}';
    const agentBytes = '# Existing project notes\n';
    await mkdir(other);
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(projectFile, projectBytes);
    await writeFile(agentsFile, agentBytes);
    if (scenario === 'switch during apply') {
      await mkdir(path.dirname(profileFile), { recursive: true });
      await writeFile(profileFile, profileBytes);
    }
    const library = new TeamLibrary(path.join(temp, 'library'));
    const team = path.join(library.directory, 'j4-us-joint-operational.md');
    await mkdir(library.directory, { recursive: true });
    if (scenario === 'existing shared team') await writeFile(team, 'Earlier shared team');
    const originalDirectory = await stat(root, { bigint: true });
    const { stub, setUpStaffTeam, uninstall } = staffSetupVscode();
    let selected = true;
    let wroteAfterSwitch = false;
    const sameDirectory = () => {
      try { return statSync(root, { bigint: true }).ino === originalDirectory.ino; } catch { return false; }
    };
    try {
      stub.setWorkspaceFolders([other, root]);
      const window = (stub.vscode as typeof import('vscode')).window;
      const quickPick = window.showQuickPick as (items: unknown, options: { title?: string; placeHolder?: string }) => Promise<unknown>;
      Object.defineProperty(window, 'showQuickPick', { configurable: true, value: async (items: unknown, options: { title?: string; placeHolder?: string }) => {
        if (scenario === 'edit during questions' && options.placeHolder?.startsWith('Which doctrine profile')) await writeFile(agentsFile, '# Edited while answering\n');
        if (options.title?.includes('check the roster')) {
          if (scenario === 'edit at confirmation') await writeFile(agentsFile, '# Edited while confirming\n');
          if (scenario === 'team appeared') await writeFile(team, 'New shared team');
          if (scenario === 'replace directory') {
            await rename(root, path.join(temp, 'original'));
            await mkdir(path.dirname(projectFile), { recursive: true });
            await writeFile(projectFile, projectBytes);
            await writeFile(agentsFile, agentBytes);
          }
        }
        return quickPick(items, options);
      } });
      stub.quickPickAnswers.push(profileChoices(J4_STAFF_TEMPLATE).find(({ value }) => value === 'us-joint')!.label,
        'Operational', 'Campaign', 'Local runtime only', '$(check) Set up the team');
      const options = { library, section: 'j4' as const, studio: {
        root, name: 'Selected project', projectJson: projectBytes,
        isCurrent: () => selected && sameDirectory(), isSameDirectory: sameDirectory
      } };
      if (scenario === 'switch during apply') setCasProbe(async (point, file) => {
        if (file !== profileFile) return;
        if (point === 'before-rename') selected = false;
        if (point === 'before-temp' && !selected) wroteAfterSwitch = await readFile(profileFile, 'utf8') !== profileBytes;
      });
      const result = await setUpStaffTeam(options);
      assert.deepEqual(await readdir(other), [], scenario);
      assert.ok(stub.quickPickRequests.every(({ title }) => !title?.includes('which project?')), scenario);
      const roster = stub.quickPickRequests.find(({ title }) => title?.includes('check the roster'));
      if (scenario === 'write') {
        assert.equal(result, team);
        assert.match(roster?.items[0].detail ?? '', /Selected project/);
        assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).custom, 'preserve');
        continue;
      }
      assert.equal(result, undefined, scenario);
      assert.equal(await readFile(projectFile, 'utf8'), projectBytes, scenario);
      assert.equal(await readFile(agentsFile, 'utf8'), scenario === 'edit during questions' ? '# Edited while answering\n' : scenario === 'edit at confirmation' ? '# Edited while confirming\n' : agentBytes, scenario);
      const planning = await readdir(path.join(root, '.planning'));
      if (scenario === 'switch during apply') {
        assert.equal(wroteAfterSwitch, false, 'no changed bytes may become visible after the workspace switch');
        assert.equal(await readFile(profileFile, 'utf8'), profileBytes);
        assert.deepEqual(await readdir(path.dirname(profileFile)), ['PROFILE.md']);
        assert.deepEqual(planning.sort(), ['.near-ai', 'staff']);
      } else {
        assert.deepEqual(planning, ['.near-ai'], scenario);
      }
      assert.deepEqual(await library.archived(), [], scenario);
      if (scenario === 'team appeared' || scenario === 'existing shared team') {
        assert.equal(await readFile(team, 'utf8'), scenario === 'team appeared' ? 'New shared team' : 'Earlier shared team');
      } else {
        assert.deepEqual(await readdir(library.directory), [], scenario);
      }
      assert.ok(stub.notifications.some(({ message }) => /changed|shared/i.test(message)), scenario);
      if (scenario === 'edit during questions' || scenario === 'existing shared team') assert.equal(roster, undefined, scenario);
    } finally {
      setCasProbe(undefined);
      uninstall();
    }
  }
});

test('ordinary Staff Setup only offers shipped templates and refuses an unexpected fixture choice', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'staff-setup-ordinary-')));
  const { stub, registerStaffSetup, uninstall } = staffSetupVscode();
  const profile = profileState();
  try {
    registerStaffSetup(profile.context);
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute);
    stub.setWorkspaceFolders([root]);
    await execute();
    const [ordinary] = stub.quickPickRequests;

    const window = (stub.vscode as typeof import('vscode')).window;
    const originalQuickPick = window.showQuickPick;
    Object.defineProperty(window, 'showQuickPick', { configurable: true, value: async () => {
      Object.defineProperty(window, 'showQuickPick', { configurable: true, value: originalQuickPick });
      return { label: 'Institutional Command Group', value: INSTITUTIONAL_COMMAND_GROUP_TEAM };
    } });
    stub.quickPickAnswers.push('$(check) Set up the team');
    await execute();

    assert.deepEqual({
      choices: ordinary.items.map(({ label }) => label),
      writes: profile.writes,
      files: await readdir(root),
    }, { choices: STAFF_TEMPLATES.map(({ label }) => label), writes: [], files: [] });
  } finally { uninstall(); }
});

test('registered Staff Setup stages only a profile-local record for each selected brigade', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-setup-')));
  const library = new TeamLibrary(path.join(temp, 'library'));
  const { stub, registerStaffSetup, fixture, uninstall } = staffSetupVscode();
  const profile = profileState();
  try {
    registerStaffSetup(profile.context, { library, fixture });
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute, 'the Team Studio command is registered');
    const legacy = { ...defaultStaffSettings(), teams: { j2: 'existing-j2' } };
    const original = JSON.stringify({ staff: legacy, type: 'research', custom: { retained: true } });
    const keys: string[] = [];
    for (const name of ['first', 'second']) {
      const root = path.join(temp, name, 'brigade');
      const metadataPath = path.join(root, '.planning', '.near-ai', 'project.json');
      await mkdir(path.dirname(metadataPath), { recursive: true });
      await writeFile(metadataPath, original);
      stub.setWorkspaceFolders([root]);
      stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
      await execute();
      const key = institutionalStageKey(root);
      keys.push(key);
      const recorded = profile.records.get(key) as Record<string, unknown> | undefined;
      assert.ok(recorded, 'confirmation stages a reloadable record');
      assert.equal(recorded.version, 1);
      assert.equal(recorded.echelon, 'L3');
      assert.equal(recorded.rootDigest, createHash('sha256').update(root).digest('hex'));
      assert.match(String(recorded.directoryDigest), /^[a-f0-9]{64}$/);
      assert.equal(recorded.team, 'institutional-command-group-v1');
      assert.equal(recorded.teamDigest, createHash('sha256').update(institutionalCommandGroupDefinition).digest('hex'));
      assert.equal(recorded.skillDigest, createHash('sha256').update(institutionalCommandGroupSkill).digest('hex'));
      assert.ok(!JSON.stringify(recorded).includes(root), 'the profile record holds digests, not a raw path');
      assert.equal(await library.findRunTeam('institutional-command-group-v1', root), undefined);
      assert.deepEqual(await library.list(root), []);
      assert.equal(await readFile(metadataPath, 'utf8'), original);
      assert.deepEqual(await readdir(path.join(root, '.planning')), ['.near-ai']);

      stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
      await execute();
      assert.deepEqual(profile.records.get(key), recorded, 'an identical record reloads without replacement');
      assert.deepEqual(profile.writes, keys, 'an identical retry performs no storage write');
    }
    assert.deepEqual([...profile.records.keys()], keys);
    assert.notEqual(keys[0], keys[1], 'equally named roots stage independently');
    assert.deepEqual((await readdir(temp)).sort(), ['first', 'second'], 'the library was not created');
    assert.ok(stub.quickPickRequests.some((request) => request.items.some((item) =>
      item.label.includes('Institutional Command Group') && item.detail?.includes('L3'))));
    assert.ok(stub.quickPickRequests.some((request) => request.items.some((item) => item.label === 'A person decides')));
    assert.ok(stub.notifications.some(({ message }) => /staged.*test fixture/i.test(message)));
    assert.ok(stub.notifications.every(({ message }) => !message.includes('IRON LANTERN')));
    assert.ok(stub.notificationActions.every((actions) => !actions.includes('Task it now')));
  } finally { uninstall(); }
});

test('registered Staff Setup stages the fictional action register separately from the legacy J3 link', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-action-setup-')));
  const library = new TeamLibrary(path.join(root, 'unused-library'));
  const { stub, registerStaffSetup, fixture, uninstall } = staffSetupVscode();
  const profile = profileState();
  const slug = INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
  const { definition, skill, lead } = institutionalRole(slug);
  try {
    registerStaffSetup(profile.context, { library, fixture, chat: { async prefill() { assert.fail('the staged role has no start action'); } } });
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute);
    stub.setWorkspaceFolders([root]);
    stub.quickPickAnswers.push('Institutional G3 Action Register', undefined);
    await execute();
    assert.deepEqual(profile.writes, [], 'cancelling the role roster has no effect');
    stub.quickPickAnswers.push('Institutional G3 Action Register', '$(check) Set up the team');
    assert.equal(await execute(), undefined, 'registered staging does not return a launchable team');
    const rootDigest = createHash('sha256').update(root).digest('hex');
    const key = `nearAi.staff.institutional.j3ActionRegister.v1.${rootDigest}`;
    const recorded = profile.records.get(key) as Record<string, unknown> | undefined;
    assert.ok(recorded, 'the J3 selection stages its own profile-local binding');
    assert.equal(recorded.team, slug);
    assert.equal(recorded.echelon, 'L3');
    assert.equal(recorded.rootDigest, rootDigest);
    assert.equal(recorded.teamDigest, createHash('sha256').update(definition).digest('hex'));
    assert.equal(recorded.skillDigest, createHash('sha256').update(skill).digest('hex'));
    assert.deepEqual(profile.writes, [key]);
    assert.deepEqual(await readdir(root), []);
    const general = stub.quickPickRequests[0];
    for (const label of ['Institutional Command Group', 'Institutional G3 Action Register', 'J3 operations']) {
      assert.ok(general.items.some((item) => item.label === label && (!label.startsWith('Institutional') || item.detail?.includes('L3'))));
    }
    const roster = stub.quickPickRequests.find((request) => request.title === 'Institutional G3 Action Register: check the roster');
    assert.ok(roster);
    assert.ok(roster.items.some((item) => /Stages the .*action register draft skill/i.test(item.detail ?? '')));
    assert.ok(roster.items.some((item) => item.label === `$(person) ${lead}` && /reviews the action register draft/i.test(item.detail ?? '')));
    assert.ok(roster.items.some((item) => item.label === '$(hubot) action-register-drafter' && /approved local test fixture/i.test(item.detail ?? '')));
    assert.ok(stub.notifications.some(({ message }) => /staged.*office-hours action register draft.*approved local test fixture/i.test(message)));
    assert.ok(!stub.notifications.some(({ message }) => /\/team:|IRON LANTERN/.test(message)));
    assert.ok(stub.notificationActions.every((actions) => actions.length === 0));
    assert.equal(await library.findRunTeam(slug, root), undefined);
    assert.deepEqual(await library.list(root), []);
    assert.deepEqual(selectedTeamAgents(parseTeam(definition, `${slug}.md`)), [], 'an unbranded reserved definition remains inert');

    const requestCount = stub.quickPickRequests.length;
    stub.quickPickAnswers.push(undefined);
    await execute({ section: 'j3' });
    const [legacy] = stub.quickPickRequests.slice(requestCount);
    assert.equal(legacy.title, 'Set up a staff team (2/6)');
    assert.match(legacy.placeHolder ?? '', /Which doctrine profile/);
    assert.deepEqual(legacy.items.map(({ label }) => label), profileChoices(J3_STAFF_TEMPLATE).map(({ label }) => label));
    assert.deepEqual(profile.writes, [key], 'the legacy section link never stages an institutional role');
  } finally { uninstall(); }
});

test('a registered J3 write finishes for the confirmed project when selection switches in flight', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-action-switch-')));
  const [confirmed, other] = ['confirmed', 'other'].map((name) => path.join(temp, name, 'brigade'));
  await Promise.all([confirmed, other].map((root) => mkdir(root, { recursive: true })));
  const library = new TeamLibrary(path.join(temp, 'unused-library'));
  const { stub, registerStaffSetup, fixture, uninstall } = staffSetupVscode();
  const profile = profileState();
  const team = INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
  const expected = await planInstitutionalStaffSetup({ root: confirmed, team });
  const keyFor = (root: string) => `nearAi.staff.institutional.j3ActionRegister.v1.${createHash('sha256').update(root).digest('hex')}`;
  const update = profile.globalState.update;
  let entered!: (key: string) => void;
  const writing = new Promise<string>((resolve) => { entered = resolve; });
  let complete!: () => void;
  const release = new Promise<void>((resolve) => { complete = resolve; });
  profile.globalState.update = async (key, value) => {
    entered(key);
    await release;
    await update(key, value);
  };
  try {
    registerStaffSetup(profile.context, { library, fixture, chat: { async prefill() { assert.fail('the staged role has no start action'); } } });
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute);
    stub.setWorkspaceFolders([confirmed]);
    stub.quickPickAnswers.push('Institutional G3 Action Register', '$(check) Set up the team');
    const command = Promise.resolve(execute());
    assert.equal(await Promise.race([writing, command.then(() => assert.fail('confirmation never began the write'))]), keyFor(confirmed));
    assert.deepEqual(profile.writes, []);
    stub.setWorkspaceFolders([other]);
    complete();
    assert.equal(await command, undefined);
    assert.deepEqual(profile.writes, [keyFor(confirmed)]);
    assert.deepEqual(profile.records.get(keyFor(confirmed)), expected.institutional.binding);
    assert.equal(profile.records.get(keyFor(other)), undefined);
    assert.ok(stub.notifications.some(({ message, level }) => level === 'info' && /staged.*office-hours action register draft.*approved local test fixture/i.test(message) &&
      message.includes(confirmed) && !message.includes(other)));
    assert.ok(!stub.notifications.some(({ message }) => /on hold|\/team:|IRON LANTERN/i.test(message)));
    assert.ok(stub.notificationActions.every((actions) => actions.length === 0));
    assert.deepEqual(await readdir(confirmed), []);
    assert.deepEqual(await readdir(other), []);
    assert.deepEqual(await library.list(confirmed), []);
    assert.deepEqual(await library.list(other), []);
  } finally { complete(); uninstall(); }
});

test('registered institutional setup never persists after cancellation or a changed project identity', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-setup-refusal-')));
  const captured = path.join(temp, 'captured');
  const switched = path.join(temp, 'switched');
  const replaced = path.join(temp, 'replaced');
  const library = new TeamLibrary(path.join(temp, 'library'));
  await mkdir(captured);
  await mkdir(switched);
  const { stub, registerStaffSetup, fixture, uninstall } = staffSetupVscode();
  const profile = profileState();
  try {
    registerStaffSetup(profile.context, { library, fixture });
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute);
    stub.setWorkspaceFolders([captured]);
    stub.quickPickAnswers.push('Institutional Command Group', undefined);
    await execute();
    assert.ok(stub.quickPickRequests.some((request) => request.title?.includes('check the roster')));
    const window = (stub.vscode as typeof import('vscode')).window;
    const quickPick = window.showQuickPick;
    for (const change of [
      async () => { stub.setWorkspaceFolders([switched]); },
      async () => { await rename(captured, replaced); await mkdir(captured); },
    ]) {
      Object.defineProperty(window, 'showQuickPick', { configurable: true, value: async (...args: unknown[]) => {
        const answer = await Reflect.apply(quickPick, window, args);
        const options = args[1] as { title?: string } | undefined;
        if (options?.title?.includes('check the roster')) await change();
        return answer;
      } });
      stub.setWorkspaceFolders([captured]);
      stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
      const messageStart = stub.notifications.length;
      await execute();
      assert.ok(stub.notifications.slice(messageStart).some(({ message }) => /project.*changed/i.test(message)));
    }
    assert.deepEqual(profile.writes, []);
    assert.equal(profile.records.size, 0);
    for (const directory of [captured, switched, replaced]) assert.deepEqual(await readdir(directory), []);
    assert.deepEqual((await readdir(temp)).sort(), ['captured', 'replaced', 'switched']);
    assert.ok(stub.notifications.every(({ message }) => !/staged.*test fixture/i.test(message)));
  } finally { uninstall(); }
});

test('registered institutional setup holds malformed profile state and unconfirmed persistence', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-setup-held-')));
  const project = path.join(temp, 'project');
  await mkdir(project);
  const library = new TeamLibrary(path.join(temp, 'library'));
  const { stub, registerStaffSetup, fixture, uninstall } = staffSetupVscode();
  const profile = profileState();
  try {
    registerStaffSetup(profile.context, { library, fixture });
    const execute = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(execute);
    stub.setWorkspaceFolders([project]);
    const key = institutionalStageKey(project);
    const partial = { version: 1, echelon: 'L3' };
    profile.records.set(key, partial);
    stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
    await execute();
    assert.ok(stub.notifications.some(({ message }) => /incomplete|inconsistent/i.test(message)));
    assert.deepEqual(profile.records.get(key), partial);
    assert.deepEqual(profile.writes, []);

    const failing = profileState();
    const update = failing.globalState.update;
    failing.globalState.update = async (name, value) => {
      await update(name, value);
      throw new Error('fixture write failure');
    };
    registerStaffSetup(failing.context, { library, fixture });
    const failingCommand = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(failingCommand);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stub.quickPickAnswers.length = 0;
      stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
      const messageStart = stub.notifications.length;
      await failingCommand();
      assert.ok(stub.notifications.slice(messageStart).some(({ message }) => /on hold|could not.*persist/i.test(message)));
    }
    assert.deepEqual(failing.writes, [key, key], 'a rejected update is not trusted on retry even if staging appears cached');
    assert.ok(stub.notifications.every(({ message }) => !/staged.*test fixture/i.test(message)));
    assert.deepEqual(await readdir(project), []);
    assert.deepEqual(await readdir(temp), ['project']);
  } finally { uninstall(); }
});

test('concurrent rejected institutional setup writes each require a confirmed retry', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-setup-concurrent-')));
  const roots = ['first', 'second'].map((name) => path.join(temp, name));
  await Promise.all(roots.map((root) => mkdir(root)));
  const plans = await Promise.all(roots.map(planInstitutionalStaffSetup));
  const profile = profileState();
  const update = profile.globalState.update;
  let bothCached!: () => void;
  const cached = new Promise<void>((resolve) => { bothCached = resolve; });
  profile.globalState.update = async (key, value) => {
    await update(key, value);
    if (profile.writes.length === roots.length) bothCached();
    await cached;
    throw new Error('fixture write failure');
  };

  const rejected = await Promise.allSettled(plans.map((plan) => persistInstitutionalStaffSetup(plan, profile.globalState, () => true)));
  for (const result of rejected) {
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /could not persist/i);
  }
  const keys = roots.map(institutionalStageKey);
  assert.deepEqual([...profile.records.keys()].sort(), [...keys].sort());
  profile.globalState.update = update;
  for (const plan of plans) await persistInstitutionalStaffSetup(plan, profile.globalState, () => true);
  assert.deepEqual(profile.writes.slice(roots.length), keys, 'each cached failure requires a newly accepted write');
});

test('Team Studio keeps the legacy host message and opens its chooser from the button', () => {
  assert.deepEqual(parseStudioMessage({ type: 'staff-setup' }), { type: 'staff-setup' });
  assert.equal(parseStudioMessage({ type: 'staff-setup', extra: 1 }), undefined);
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'teams', 'teams.js'), 'utf8');
  assert.match(page, /button\('Set up staff', openStaffPreview/);
  assert.match(page, /type: 'staff-preview-open'/);
  assert.match(page, /type: 'staff-preview-continue'/);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'teams', 'teams.css'), 'utf8');
  assert.match(css, /\.staff-person \{ color: var\(--vscode-charts-yellow\)/);
  assert.match(css, /\.staff-agent \{ color: var\(--vscode-charts-purple\)/);
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
  assert.ok(manifest.contributes.commands.some((command) => command.command === 'nearAi.setUpStaffTeam' && command.title === 'Set Up a Staff Team'));
});

// ---- Update Team recognises staff templates ----------------------------------------------------------------------------------------------------

test('Update Team recognises a staff team, replaces unchanged members and keeps edited ones', () => {
  const options = { settings: settings(), locality: 'cloud' as const };
  const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options });
  const ref = detectTemplate(plan.team);
  assert.equal(ref?.id, J2_STAFF_TEMPLATE.id);
  assert.equal(ref?.stamped, true);
  // A fresh team is the current rendering: every member is the same.
  const fresh = planTeamUpdate(plan.team, { staffSettings: options.settings })!;
  assert.ok(fresh.staff);
  assert.ok(fresh.members.every((member) => member.action === 'same'), JSON.stringify(fresh.members.map((member) => [member.name, member.action])));
  // The person edits one member; the settings move to crisis planning, so the rendering changes for others.
  const edited = plan.team.replace(/(## release-guard\n[\s\S]*?\n\n)/, '$1My own rule: check twice.\n\n');
  assert.notEqual(edited, plan.team);
  const crisis = settings({ planningType: 'crisis' });
  const update = planTeamUpdate(edited, { staffSettings: crisis })!;
  const guard = update.members.find((member) => member.name === 'release-guard')!;
  assert.equal(guard.action, 'choice');
  const changed = update.members.filter((member) => member.action === 'auto');
  assert.ok(changed.length > 0, 'unchanged members whose rendering moved are replaced');
  const applied = applyTeamUpdate(edited, update);
  const team = parseTeam(applied, 'team.md');
  assert.equal(team.staff?.section, 'j2');
  assert.match(applied, /My own rule: check twice\./);
  const rendered = parseTeam(J2_STAFF_TEMPLATE.render({ ...options, settings: crisis }).team, 't.md');
  for (const member of changed) assert.equal(team.members.find((entry) => entry.name === member.name)?.instructions, rendered.members.find((entry) => entry.name === member.name)?.instructions);
  // Applied again with the same settings, nothing is left to do except the member the person kept.
  const again = planTeamUpdate(applied, { staffSettings: crisis })!;
  assert.ok(again.members.every((member) => member.action === 'same' || member.action === 'kept'), JSON.stringify(again.members.map((member) => [member.name, member.action])));
});

test('Update Team picks the staff rendering that fits the file: local, battalion, J5 without a red team', () => {
  const local = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options: { settings: settings(), locality: 'local' } });
  assert.equal(planTeamUpdate(local.team, { staffSettings: settings() })?.local, true);
  const army = settings({ profile: 'us-army', level: 'tactical' });
  const battalion = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options: { settings: army, echelon: 'battalion', locality: 'cloud' } });
  const battalionPlan = planTeamUpdate(battalion.team, { staffSettings: army })!;
  assert.equal(battalionPlan.staff?.echelon, 'battalion');
  assert.ok(battalionPlan.members.every((member) => member.action === 'same'));
  const nato = settings({ profile: 'nato-ca', nation: 'ca' });
  const noRed = planStaffSetup({ templateId: J5_STAFF_TEMPLATE.id, options: { settings: nato, redTeam: false, locality: 'cloud' } });
  const noRedPlan = planTeamUpdate(noRed.team, { staffSettings: nato })!;
  assert.equal(noRedPlan.staff?.redTeam, false);
  assert.ok(!noRedPlan.members.some((member) => member.action === 'new'), 'the red team the person left out is not offered back');
});

test('Update Team refreshes a staff section\'s own AGENTS.md block, never the project-type block', () => {
  const options = { settings: settings(), locality: 'cloud' as const };
  const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options });
  const crisis = settings({ planningType: 'crisis' });
  const update = planTeamUpdate(plan.team, { staffSettings: crisis })!;
  const agents = withStaffGuidance('# Agent instructions\n\n<!-- near-ai:project-type:start -->\nproject text\n<!-- near-ai:project-type:end -->\n', J2_STAFF_TEMPLATE.id, J2_STAFF_TEMPLATE.render(options).guidance);
  const guidance = planStaffGuidanceUpdate(agents, update);
  assert.equal(guidance.staffTemplate, J2_STAFF_TEMPLATE.id);
  const after = applyGuidanceUpdate(agents, guidance);
  assert.equal(staffGuidanceIn(after, J2_STAFF_TEMPLATE.id), J2_STAFF_TEMPLATE.render({ ...options, settings: crisis }).guidance);
  assert.match(after, /project text/);
  // A block the person edited is their choice.
  const edited = agents.replace('## Staff section', '## Staff section (ours)');
  assert.equal(planStaffGuidanceUpdate(edited, update).action, 'choice');
});

test('a plain team is unchanged by the staff support', () => {
  const type = PROJECT_TYPES[0];
  const text = projectTypeTeam(type, 'Build it', 'cloud');
  const plan = planTeamUpdate(text)!;
  assert.equal(plan.template.id, type.id);
  assert.equal(plan.staff, undefined);
  assert.ok(!/staff:/.test(applyTeamUpdate(text, plan)));
});

test('TeamUpdater previews a library staff team against the open project\'s settings and guidance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'staff-update-'));
  const library = new TeamLibrary(path.join(root, 'store'));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const options = { settings: settings(), locality: 'cloud' as const };
  const setup = await applyStaffSetup(project, library, planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options }));
  // The person moves the project to crisis planning.
  const configFile = path.join(project, '.planning', '.near-ai', 'project.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(configFile, JSON.stringify({ ...config, staff: { ...config.staff, planningType: 'crisis' } }));
  const updater = new TeamUpdater(library, undefined, () => false, () => project);
  const preview = (await updater.preview(setup.teamFile))!;
  assert.equal(preview.plan.staff?.settings.planningType, 'crisis');
  assert.equal(preview.guidance?.action, 'auto');
  const applied = await updater.apply(preview, {});
  assert.equal(applied.configFile, undefined, 'project.json is not rewritten for a staff block');
  assert.equal(staffGuidanceIn(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), J2_STAFF_TEMPLATE.id), J2_STAFF_TEMPLATE.render({ ...options, settings: settings({ planningType: 'crisis' }) }).guidance);
  // Without an open project it still plans the team, with the defaults, and leaves AGENTS.md alone.
  const alone = await new TeamUpdater(library).preview(setup.teamFile);
  assert.ok(alone && !alone.guidance);
});

// Coherence review S5: where a staff team is set up, it says plainly that the private models NEAR AI offers today come from PRC developers, so the team is
// for fictional or exercise material only until your organization approves a model. Copy only: the team stays private and nothing about routing changes.
test('S5: the J2 and J4 team files carry the PRC-origin sentence in their "Private models only" rule, and stay private', async () => {
  const { STAFF_PRIVATE_MODELS_TEXT } = await import('../domain/staff/products');
  const { J4_STAFF_TEMPLATE } = await import('../agent/staff/templates');
  for (const template of [J2_STAFF_TEMPLATE, J4_STAFF_TEMPLATE]) {
    const plan = planStaffSetup({ templateId: template.id, options: { settings: settings(), locality: 'cloud' }, agents: '', projectJson: '{}' });
    assert.ok(JSON.stringify(plan).includes(`a run stops rather than send the work to a forwarded model. ${STAFF_PRIVATE_MODELS_TEXT}`.replace(/"/g, '\\"')), template.id);
    assert.equal(parseTeam(plan.team, `${plan.roster.fileName}.md`).private, true, 'the team is still private');
  }
});

test('S5: the staff setup\'s model step and its last message say the same sentence', async () => {
  const { STAFF_PRIVATE_MODELS_TEXT } = await import('../domain/staff/products');
  const stub = createVscodeStub();
  const uninstall = installVscodeStub(stub);
  try {
    const command = await import('../services/staffSetupCommand');
    assert.ok(command.readyMessage('J2 intelligence', 'j2', false).includes(STAFF_PRIVATE_MODELS_TEXT));
    // The model step's items, built by the code the command shows them with (PR #143 review: behaviour, not the source text).
    const choices = command.localityChoices();
    assert.deepEqual(choices.map((choice) => choice.value), ['cloud', 'local']);
    assert.equal(choices[0]?.detail, `Private models in NEAR's TEE; members that research may use the web tools. ${STAFF_PRIVATE_MODELS_TEXT}`);
  } finally { uninstall(); }
});
