// POST-01 on one computer (Phase 33 D-04 to D-08, D-67): a newer lead requires a feature this build does not fold, so this computer stops the whole
// shared project with the update sentence before any other family is folded, keeps every entry, and folds everything once it is updated. Each person
// has an install of their own (createLiveWorld); entries travel through the fake transport. Fictional people and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { UPDATE_SENTENCE, WRAP_V2_FEATURE } from '../domain/replica/features';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { ProductEditor } from '../staff/replica/productEditing';
import { ReplicaProject, ReplicaProjectError, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused } from '../staff/replica/replicaProject';
import { REQUIRE_ARMED_FEATURE, clientReplicaFeatures, ensureRequireArmed, requireProblem } from '../staff/replica/requireGate';
import { carryThroughFake, createLiveWorld, liveInstall } from './helpers/liveWorld';
import type { LiveDevice, LiveWorld } from './helpers/liveWorld';

const PRODUCT = 'intel-estimate';
// A newer version folds everything this one does (wrap@2 too where the probe passes, 33.2 D-05) and positions@1.
const NEWER = [...clientReplicaFeatures(), 'positions@1'].sort();
// What a project made shared here requires from creation (D-08), with wrap@2 beside require@1 where this computer knows it (33.2 D-05).
const ARMED = clientReplicaFeatures().includes(WRAP_V2_FEATURE) ? [REQUIRE_ARMED_FEATURE, WRAP_V2_FEATURE].sort() : [REQUIRE_ARMED_FEATURE];

function opened(value: ReplicaProject | ProjectRefused | undefined, what: string): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `${what} (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

async function withWorld(run: (world: LiveWorld) => Promise<void>): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }] });
  try {
    await run(world);
  } finally {
    await world.close();
  }
}

async function refusedNeedsUpdate(work: Promise<unknown>, what: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ReplicaProjectError, `${what}: a project refusal`);
    assert.equal(error.refusal.refused, 'needs-update', what);
    assert.equal(error.refusal.message, UPDATE_SENTENCE, what);
    return true;
  });
}

function textOf(fold: { families: Record<string, unknown> }, stream: string): string | undefined {
  return ((fold.families.doc as ProductTextOutput[] | undefined) ?? []).find((item) => item.stream === stream && item.product === PRODUCT)?.text;
}

/** The lead's computer runs a newer version that folds positions@1: it requires it, then writes a product after the requirement. */
async function newerLeadRequires(world: LiveWorld): Promise<{ newer: LiveDevice; text: string; required: string }> {
  const lead = world.lead;
  const newerProject = opened(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, knownFeatures: NEWER }), 'the newer lead opens the project');
  const required = await newerProject.appendOwn('roster.require', { features: ['positions@1'] });
  assert.ok('ok' in required, 'the lead device writes the requirement');
  const editor = await ProductEditor.open(newerProject, { stream: newerProject.projectId, product: PRODUCT, actor: { kind: 'person' } });
  editor.insert(0, 'Enemy forces hold the bridge.');
  assert.deepEqual(await editor.flush(), { appended: 1, queued: 0 });
  editor.close();
  const text = textOf((await newerProject.state()).fold, newerProject.projectId);
  assert.equal(text, 'Enemy forces hold the bridge.');
  return { newer: { ...lead, project: newerProject }, text, required: required.hash };
}

test('tracer: a newer lead requires positions@1, this computer stops with the update sentence before folding anything else, and keeps every entry', async () => {
  await withWorld(async (world) => {
    const [, ben] = world.devices;
    const stream = ben.project.projectId;
    const { newer, required } = await newerLeadRequires(world);
    try {
      await carryThroughFake(newer, ben, stream);
      await refusedNeedsUpdate(ben.project.state(), 'state() stops');
      await refusedNeedsUpdate(ben.project.appendOwn('doc.client', { product: PRODUCT, clientId: 1, actor: { kind: 'person' } }), 'appendOwn stops');
      // Reads that serve other people go on: the heads and the stored entries answer, and the store kept every entry the lead wrote.
      const lead = newer.project.deviceWriter;
      const leadEntries = await newer.project.entriesAfter(stream, lead, -1);
      const kept = await ben.project.entriesAfter(stream, lead, -1);
      assert.equal(kept.length, leadEntries.length, 'every entry is kept');
      assert.ok((await ben.project.heads()).some((row) => row.stream === stream && row.heads.some((head) => head.writer === lead && head.seq === leadEntries.length - 1)));
      assert.ok((await ben.project.holds([required])).has(required));
    } finally {
      await newer.project.close();
    }
  });
});

test('no loss after the update: the same store opened by a version that folds positions@1 folds every entry, and the text equals the lead\'s', async () => {
  await withWorld(async (world) => {
    const [, ben] = world.devices;
    const stream = ben.project.projectId;
    const { newer, text } = await newerLeadRequires(world);
    try {
      await carryThroughFake(newer, ben, stream);
      await refusedNeedsUpdate(ben.project.state(), 'before the update');
      const updated = opened(await ReplicaProject.open(ben.at.root, { ...ben.at.deps, knownFeatures: NEWER }), 'the updated version opens the same store');
      try {
        const { roster, fold } = await updated.state();
        assert.deepEqual(roster.required, ['positions@1', ...ARMED].sort());
        assert.equal(textOf(fold, stream), text);
        assert.deepEqual(fold.refused, [], 'nothing was refused');
      } finally {
        await updated.close();
      }
    } finally {
      await newer.project.close();
    }
  });
});

test('a project made shared holds roster.require require@1 (with wrap@2 where this computer knows it) right after its genesis, and it folds on this computer\'s registry (D-08)', async () => {
  const at = liveInstall('solo');
  const project = opened(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }), 'the lead makes the shared project');
  try {
    const { roster } = await project.state();
    assert.deepEqual(roster.required, ARMED);
    assert.equal(roster.positions.length, 3, 'origin, genesis, then the requirement');
    const own = await project.findOwnAll('roster.require', () => true);
    assert.equal(own.length, 1);
    assert.equal(own[0].hash, roster.positions[2]);
    assert.deepEqual(own[0].data, { features: ARMED, rosterPrev: roster.positions[1] });
    assert.equal(requireProblem(roster), undefined, 'the shipped registry folds require@1');
  } finally {
    await project.close();
  }
});

test('ensureRequireArmed writes once on a lead device and never on a member device', async () => {
  await withWorld(async (world) => {
    const [ana, ben] = world.devices;
    assert.deepEqual(await ensureRequireArmed(ana.project), { ok: false, skipped: 'already-armed' }, 'the project was armed when it was made');
    assert.deepEqual(await ensureRequireArmed(ben.project), { ok: false, skipped: 'already-armed' }, 'the member sees it armed too');
    assert.equal((await ana.project.findOwnAll('roster.require', () => true)).length, 1);
  });
});

test('requireProblem lists the missing features sorted and without repeats, and nothing when this build folds every one', () => {
  assert.equal(requireProblem({ required: [] }), undefined);
  assert.equal(requireProblem({ required: ['require@1', 'replica@2'] }), undefined);
  assert.deepEqual(requireProblem({ required: ['zeta@1', 'positions@1', 'require@1'] }), { missing: ['positions@1', 'zeta@1'] });
  assert.equal(requireProblem({ required: ['positions@1'] }, NEWER), undefined, 'a newer build folds it');
  assert.equal(UPDATE_SENTENCE, 'This shared work needs a newer version of Sterling. Ask your administrator to update it.');
});
