// Loading an exercise scenario into a project (design 10, section 8; WP-DEMO): the loader writes the scenario and demo scripts only when the file
// reads cleanly, archives an earlier scenario instead of deleting it, never writes through a symbolic link, and the command asks before replacing.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCENARIO_DIR } from '../domain/staff/scenario';
import {
  ARCHIVE_DIR, DEMO_DIR, loadScenarioIntoProject, projectStaffSettings, readScenarioFile, REAL_ENTITIES_FILE, STARTER_SCENARIO_FILE
} from '../services/staffScenarioLoader';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const command = require('../services/staffScenario') as typeof import('../services/staffScenario');
test.after(() => { uninstall(); });

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'near-ai-staff-scenario-'));
}

async function starterText(): Promise<string> {
  const read = await readScenarioFile(STARTER_SCENARIO_FILE);
  assert.ok(read.ok);
  return read.ok ? read.text : '';
}

test('the starter scenario loads into a project with the J2 and J5 demo scripts', async () => {
  const root = await project();
  const result = await loadScenarioIntoProject(root, await starterText());
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.settingsFrom, 'defaults');
  assert.equal(result.archivedTo, undefined);
  assert.equal(result.demoSkipped, undefined);
  assert.deepEqual(result.written.filter((file) => file.startsWith(DEMO_DIR)), [`${DEMO_DIR}/j2-demo-script.md`, `${DEMO_DIR}/j5-demo-script.md`]);
  for (const file of result.written) assert.ok(existsSync(path.join(root, file)), file);
  assert.match(await readFile(path.join(root, SCENARIO_DIR, 'README.md'), 'utf8'), /Exercise IRON LANTERN/);
  assert.match(await readFile(path.join(root, DEMO_DIR, 'j2-demo-script.md'), 'utf8'), /J-2 section of JTF BEACON/);
});

test('demo scripts follow the project\'s staff settings', async () => {
  const root = await project();
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ type: 'staff', staff: { profile: 'nato-ca', level: 'operational', nation: 'ca' } }));
  const settings = await projectStaffSettings(root);
  assert.equal(settings.from, 'project');
  const result = await loadScenarioIntoProject(root, await starterText());
  assert.ok(result.ok);
  assert.match(await readFile(path.join(root, DEMO_DIR, 'j2-demo-script.md'), 'utf8'), /J2 section of JTF BEACON/);
  await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ staff: { profile: 'us-army', level: 'operational' } }));
  assert.equal((await projectStaffSettings(root)).from, 'defaults', 'a refused setting falls back to the defaults');
});

test('an earlier scenario and its demo scripts are archived, never deleted', async () => {
  const root = await project();
  const text = await starterText();
  assert.ok((await loadScenarioIntoProject(root, text, { now: new Date('2026-11-18T10:00:00.000Z') })).ok);
  await writeFile(path.join(root, SCENARIO_DIR, 'notes.md'), 'my notes');
  const again = await loadScenarioIntoProject(root, text, { now: new Date('2026-11-18T11:00:00.000Z') });
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.equal(again.archivedTo, `${ARCHIVE_DIR}/20261118T110000Z`);
  assert.equal(await readFile(path.join(root, again.archivedTo, 'scenario', 'notes.md'), 'utf8'), 'my notes');
  assert.ok(existsSync(path.join(root, again.archivedTo, 'demo', 'j2-demo-script.md')));
  assert.ok(!existsSync(path.join(root, SCENARIO_DIR, 'notes.md')));
  const third = await loadScenarioIntoProject(root, text, { now: new Date('2026-11-18T11:00:00.000Z') });
  assert.equal(third.ok, false, 'an archive folder is never reused');
  assert.ok(existsSync(path.join(root, again.archivedTo, 'scenario', 'notes.md')));
});

test('a refused scenario writes nothing and archives nothing', async () => {
  const root = await project();
  const text = await starterText();
  assert.ok((await loadScenarioIntoProject(root, text)).ok);
  const bad = text.replace('"fictional": true', '"fictional": false');
  const result = await loadScenarioIntoProject(root, bad);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /fictional/);
  assert.ok(!existsSync(path.join(root, ARCHIVE_DIR)));
  assert.ok(existsSync(path.join(root, SCENARIO_DIR, 'README.md')));
});

test('names on the project\'s real-entity list are refused', async () => {
  const root = await project();
  await mkdir(path.join(root, '.planning', 'staff'), { recursive: true });
  await writeFile(path.join(root, REAL_ENTITIES_FILE), '# real units and places\nPort Calder\n');
  const result = await loadScenarioIntoProject(root, await starterText());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /real-entity list/);
  assert.ok(!existsSync(path.join(root, SCENARIO_DIR)));
});

test('a scenario of your own loads without the starter demo scripts, and says why', async () => {
  const root = await project();
  const own = JSON.parse(await starterText()) as Record<string, any>;
  own.reports = own.reports.filter((report: { id: string }) => report.id !== 'OS-02' && report.id !== 'OS-03');
  for (const force of own.forces) if (force.reportedBy) force.reportedBy = force.reportedBy.filter((id: string) => id !== 'OS-02' && id !== 'OS-03');
  const result = await loadScenarioIntoProject(root, JSON.stringify(own));
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.match(result.demoSkipped ?? '', /written for the starter scenario/);
  assert.ok(!existsSync(path.join(root, DEMO_DIR)));
});

test('nothing is written through a symbolic link', async () => {
  const root = await project();
  const elsewhere = await project();
  await mkdir(path.join(root, '.planning'), { recursive: true });
  await symlink(elsewhere, path.join(root, '.planning', 'staff'));
  const result = await loadScenarioIntoProject(root, await starterText());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /symbolic link/);
  assert.deepEqual(await readdir(elsewhere), []);
});

test('the command loads the starter scenario, asks before replacing it, and loads a file of your own', async () => {
  const root = await project();
  stub.setWorkspaceFolders([root]);
  command.registerStaffScenario(createFakeContext(root, undefined) as never, { pickFile: async () => ownFile });
  const run = stub.commands.get(command.LOAD_STAFF_SCENARIO_COMMAND);
  assert.ok(run, 'the command is registered');
  const ownFile = path.join(await project(), 'own.json');
  await writeFile(ownFile, (await starterText()).replace('"title": "Exercise IRON LANTERN"', '"title": "Exercise OWN"'));

  stub.quickPickAnswers.push(command.STARTER_PICK);
  await run!();
  assert.ok(existsSync(path.join(root, SCENARIO_DIR, 'scenario.json')));
  assert.match(stub.notifications.at(-1)?.message ?? '', /Exercise IRON LANTERN loaded/);

  stub.quickPickAnswers.push(command.OWN_PICK);
  stub.messageAnswers.push(undefined);
  await run!();
  assert.match(stub.messageOptions.at(-1)?.detail ?? '', /Nothing is deleted/);
  assert.match(await readFile(path.join(root, SCENARIO_DIR, 'README.md'), 'utf8'), /IRON LANTERN/, 'dismissing the question keeps the scenario');

  stub.quickPickAnswers.push(command.OWN_PICK);
  stub.messageAnswers.push(command.REPLACE_ACTION);
  await run!();
  assert.match(await readFile(path.join(root, SCENARIO_DIR, 'README.md'), 'utf8'), /Exercise OWN/);
  assert.match(stub.notifications.at(-1)?.message ?? '', /earlier scenario is in \.planning\/staff\/archive\//);

  const package_ = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
  assert.ok(package_.contributes.commands.some((entry) => entry.command === command.LOAD_STAFF_SCENARIO_COMMAND && entry.title === 'Load Staff Exercise Scenario'));
});

test('a bad file is refused with the reason and the project is untouched', async () => {
  const root = await project();
  stub.setWorkspaceFolders([root]);
  const bad = path.join(await project(), 'bad.json');
  await writeFile(bad, '{"format": "near-ai-staff-scenario", "version": 1, "marking": "SECRET"}');
  const context = createFakeContext(root, undefined);
  command.registerStaffScenario(context as never, { pickFile: async () => bad });
  stub.quickPickAnswers.push(command.OWN_PICK);
  await stub.commands.get(command.LOAD_STAFF_SCENARIO_COMMAND)!();
  const last = stub.notifications.at(-1);
  assert.equal(last?.level, 'error');
  assert.match(last?.message ?? '', /^Scenario not loaded\./);
  assert.ok(!existsSync(path.join(root, '.planning')));
});

test('a write that fails while loading shows "Scenario not loaded" with the reason, and is never an unhandled rejection', async () => {
  const root = await project();
  stub.setWorkspaceFolders([root]);
  const context = createFakeContext(root, undefined);
  command.registerStaffScenario(context as never, { load: async () => { throw new Error('EACCES: permission denied, mkdir .planning/staff'); } });
  stub.quickPickAnswers.push(command.STARTER_PICK);
  await assert.doesNotReject(async () => { await stub.commands.get(command.LOAD_STAFF_SCENARIO_COMMAND)!(); });
  const last = stub.notifications.at(-1);
  assert.equal(last?.level, 'error');
  assert.match(last?.message ?? '', /^Scenario not loaded\. EACCES: permission denied/);
});
