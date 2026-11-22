import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { J2_STAFF_TEMPLATE } from '../agent/staff/templates';
import { guidanceFingerprint } from '../agent/teamFingerprints';
import { TeamLibrary } from '../agent/teams';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_MODE } from '../domain/org/modes';
import { REPLICA_PROJECT_FILE } from '../domain/staff/multiUser';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { applyResearchProfile } from '../gsd/researchProfile';
import { applyStaffSetup, planStaffSetup } from '../services/staffSetup';
import { TeamUpdater } from '../services/teamUpdates';
import { PROJECT_LAYER_WIDENING_TEXT, projectLayerSinkFor, singleMachineSink } from '../services/setup/projectLayerSink';
import { PROJECT_JSON_FILE, PROJECT_JSON_UNREADABLE_TEXT, createProjectLayerSource, projectMode, readProjectLayer, readSetupGuide, updateProjectJson } from '../services/setup/projectStore';
import type { SetupGuideEntry } from '../domain/setup/answers';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

const projectLayer = { v: 1, residency: { required: ['CA'] } };
const setupGuide: SetupGuideEntry = { v: 1, answers: { data: ['public'], canada: 'yes' }, chosen: [], pending: [] };

async function fixture(value: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-project-'));
  const file = path.join(root, PROJECT_JSON_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return { root, file, read: async () => JSON.parse(await readFile(file, 'utf8')) };
}

test('D-33: updating the guide retains settings written by other features', async () => {
  const original = { staff: { level: 'operational' }, gsdProfile: 'research', type: 'software' };
  const { root, read } = await fixture(original);
  assert.deepEqual(await updateProjectJson(root, (current) => ({ ...current, setupGuide })), { ok: true });
  assert.deepEqual(await read(), { ...original, setupGuide });
  assert.equal(readSetupGuide(root)?.answers.canada, 'yes');
});

test('an invalid or oversized project file is refused without changing its bytes', async () => {
  const { root, file } = await fixture([]);
  for (const text of ['[]', '{', JSON.stringify({ note: 'x'.repeat(300 * 1024) })]) {
    await writeFile(file, text);
    assert.deepEqual(await updateProjectJson(root, (current) => ({ ...current, setupGuide })), { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT });
    assert.equal(await readFile(file, 'utf8'), text);
  }
});

test('50 concurrent guide updates are serialized and a polling reader always sees complete JSON', async () => {
  const { root, read } = await fixture({ count: 0 });
  let finished = false;
  let reads = 0;
  const polling = (async () => {
    while (!finished) {
      assert.equal(typeof (await read()).count, 'number');
      reads += 1;
    }
  })();
  try {
    const results = await Promise.all(Array.from({ length: 50 }, () =>
      updateProjectJson(root, (current) => ({ ...current, count: Number(current.count) + 1 }))));
    assert.ok(results.every(({ ok }) => ok));
    assert.deepEqual(await read(), { count: 50 });
    assert.ok(reads > 0);
  } finally {
    finished = true;
    await polling;
  }
});

async function setUpStaff(root: string, file: string, library: TeamLibrary, number: number) {
  const settings = { ...defaultStaffSettings(), phases: [`Example phase ${number}`] };
  const plan = planStaffSetup({
    templateId: J2_STAFF_TEMPLATE.id, options: { settings, locality: 'local' },
    projectJson: await readFile(file, 'utf8'), agents: await readFile(path.join(root, 'AGENTS.md'), 'utf8').catch(() => undefined)
  });
  return applyStaffSetup(root, library, plan, { replace: true });
}

test('a staff setup planned earlier preserves residency and guide settings saved before apply', async () => {
  const { root, file, read } = await fixture({});
  const library = new TeamLibrary(path.join(root, 'library'));
  const plan = planStaffSetup({
    templateId: J2_STAFF_TEMPLATE.id,
    options: { settings: defaultStaffSettings(), locality: 'local' },
    projectJson: await readFile(file, 'utf8')
  });
  assert.deepEqual(await updateProjectJson(root, (current) => ({ ...current, projectLayer, setupGuide })), { ok: true });
  await applyStaffSetup(root, library, plan);
  const current = await read();
  assert.deepEqual(current.projectLayer, projectLayer);
  assert.deepEqual(current.setupGuide, setupGuide);
  assert.equal(current.staff.teams.j2, plan.roster.fileName);
});

test('interleaved guide and staff updates retain both latest settings', async () => {
  const { root, file, read } = await fixture({ projectLayer });
  const library = new TeamLibrary(path.join(root, 'library'));
  for (let number = 1; number <= 20; number++) {
    const record = { ...setupGuide, recordId: String(number) };
    assert.deepEqual(await updateProjectJson(root, (current) => ({ ...current, setupGuide: record })), { ok: true });
    await setUpStaff(root, file, library, number);
  }
  const current = await read();
  assert.equal(current.setupGuide.recordId, '20');
  assert.deepEqual(current.staff.phases, ['Example phase 20']);
  assert.deepEqual(current.projectLayer, projectLayer);
});

test('staff setup, Update Team and the research profile carry the guide keys forward', async () => {
  const { root, file, read } = await fixture({ projectLayer, setupGuide, type: 'research', templateVersion: 1 });
  const library = new TeamLibrary(path.join(root, 'library'));
  await setUpStaff(root, file, library, 1);
  const assertGuideKeys = async () => {
    const current = await read();
    assert.deepEqual(current.projectLayer, projectLayer);
    assert.deepEqual(current.setupGuide, setupGuide);
  };
  await assertGuideKeys();

  const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures', 'teams');
  const teamFile = TeamLibrary.projectTeamFile(root);
  await writeFile(teamFile, await readFile(path.join(fixtures, 'wearable-research-team.md')));
  const agents = await readFile(path.join(fixtures, 'wearable-research-AGENTS.md'), 'utf8');
  await writeFile(path.join(root, 'AGENTS.md'), agents);
  const guidance = agents.slice(agents.indexOf('## Project type'), agents.indexOf('\n<!-- near-ai:project-type:end'));
  await writeFile(file, JSON.stringify({ ...(await read()), guidanceBase: guidanceFingerprint(guidance) }));
  const updater = new TeamUpdater(library);
  const preview = await updater.preview(teamFile);
  assert.equal(preview?.guidance?.action, 'auto');
  assert.equal((await updater.apply(preview!, {})).configFile, file);
  await assertGuideKeys();
  await applyResearchProfile(root);
  assert.equal((await read()).gsdProfile, 'research');
  await assertGuideKeys();
});

test('a project write only narrows the region list and preserves locked answers', async () => {
  const { root, file, read } = await fixture({});
  const effective = policyDocumentFor({ key: deviceKey() });
  const policy = { ...effective, people: { ...effective.people!, organization: {
    mode: 'corporate' as const, allowedModes: ['corporate'] as const, projectMayChoose: true, settings: { maxDelegationDepth: 1, overdueDays: 7 }
  } } };
  const source = createProjectLayerSource({ readFileSync, statSync, scales: () => SCALE_PRESETS, now: () => 0 });
  assert.equal(source.read(root).state, 'none');
  const sink = singleMachineSink(root, { effective: () => policy, source });
  const exercise = { reason: 'Example exercise', setAt: '2026-11-22T00:00:00.000Z' };
  const canada = { required: ['CA'] as const };
  assert.deepEqual(await sink.write({ residency: canada, mode: 'corporate', lock: ['canada'], exercise }), { state: 'written' });
  assert.equal(source.read(root).state, 'valid');
  assert.deepEqual(await sink.write({ residency: canada }), { state: 'written' });
  assert.deepEqual((await read()).projectLayer.exercise, exercise);
  const before = await readFile(file, 'utf8');
  for (const rejected of [{ residency: { required: ['CA', 'US'] as const } }, { mode: 'military' as const }]) {
    assert.deepEqual(await sink.write(rejected), { state: 'refused', text: PROJECT_LAYER_WIDENING_TEXT });
    assert.equal(await readFile(file, 'utf8'), before);
  }
  assert.deepEqual(await sink.write({ exercise: null, setupGuide }), { state: 'written' });
  assert.deepEqual(await read(), { projectLayer: { ...projectLayer, mode: 'corporate', locked: { canada: true } }, setupGuide });
});

test('a newly shared project makes both sinks wait without writing', async () => {
  const { root, file } = await fixture({ projectLayer });
  const deps = { effective: () => undefined };
  const openSink = await projectLayerSinkFor(root, deps);
  assert.equal(openSink.kind, 'single-machine');
  const shared = path.join(root, REPLICA_PROJECT_FILE);
  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, '{}');
  const sharedSink = await projectLayerSinkFor(root, deps);
  assert.equal(sharedSink.kind, 'shared');
  const before = await readFile(file, 'utf8');
  for (const sink of [openSink, sharedSink]) {
    assert.deepEqual(await sink.write({ setupGuide }), { state: 'waits', for: 'shared-project' });
  }
  assert.equal(await readFile(file, 'utf8'), before);
});

test('the store ignores an unsigned label and the sink writes only the supported settings', async () => {
  const { root, read } = await fixture({ projectLayer: { ...projectLayer, label: 'unsigned' } });
  assert.deepEqual(readProjectLayer(root, SCALE_PRESETS), { state: 'valid', layer: projectLayer });
  const sink = singleMachineSink(root, { effective: () => undefined });
  assert.deepEqual(await sink.write({ setupGuide }), { state: 'written' });
  assert.deepEqual(await read(), { projectLayer, setupGuide });
});

test('a linked settings file is refused and the target stays intact', async () => {
  const { root } = await fixture({});
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-project-link-'));
  const target = path.join(root, PROJECT_JSON_FILE);
  const linked = path.join(base, PROJECT_JSON_FILE);
  await mkdir(path.dirname(linked), { recursive: true });
  await symlink(target, linked);
  assert.deepEqual(await updateProjectJson(base, (current) => ({ ...current, setupGuide })), { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT });
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('D-40: the project mode follows the policy’s allowed mode list and uses the policy default otherwise', async () => {
  const { root, file } = await fixture({ projectLayer: { v: 1, mode: 'military' } });
  const base = policyDocumentFor({ key: deviceKey() });
  const organization = {
    mode: 'public-service' as const, allowedModes: ['military', 'public-service'] as const, projectMayChoose: true,
    settings: { maxDelegationDepth: 0, overdueDays: 14 }
  };
  const allowed = { ...base, people: { ...base.people!, organization } };
  const fixed = { ...base, people: { ...base.people!, organization: { ...organization, allowedModes: ['public-service'] as const } } };
  assert.equal(projectMode(root, allowed), 'military');
  assert.equal(projectMode(root, fixed), 'public-service');
  await writeFile(file, JSON.stringify({ projectLayer: { v: 1, mode: 'legacy-mode' } }));
  assert.equal(projectMode(root, base), DEFAULT_MODE);
  await writeFile(file, '{}');
  assert.equal(projectMode(root, allowed), 'public-service');
  assert.equal(projectMode(root, base), DEFAULT_MODE);
});
