// wrap@2 with its probe (33.2-05 Task 2; 33.2-CONTEXT D-05): a computer knows wrap@2 only when the cell-wrap/v2 probe passes; one that does not
// stops a project requiring it with the update sentence; new shared work requires wrap@2 from creation on a computer that knows it, and an existing
// project never gains it by being opened. Fictional names.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES, UPDATE_SENTENCE, WRAP_V2_FEATURE, coversRequired, knownReplicaFeatures } from '../domain/replica/features';
import type { SecretStorageLike } from '../services/auth';
import { clientReplicaFeatures, ensureRequireArmed } from '../staff/replica/requireGate';
import { ReplicaProject, ReplicaProjectError, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const WITHOUT_WRAP = knownReplicaFeatures(false);

function install(label: string, knownFeatures?: readonly string[]): { root: string; deps: ReplicaProjectDeps } {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-wrap-switch-${label}-`));
  // wrapV2AtCreation is what the host sets once every wrap path writes cell-wrap/v2 (33.2-06).
  const deps: ReplicaProjectDeps = { secrets: new MemorySecrets(), globalStorageDir: path.join(base, 'global'), now: () => new Date('2026-11-24T10:00:00.000Z'), wrapV2AtCreation: true };
  if (knownFeatures !== undefined) deps.knownFeatures = knownFeatures;
  return { root: path.join(base, 'project'), deps };
}

function opened(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

const created = async (at: { root: string; deps: ReplicaProjectDeps }): Promise<ReplicaProject> =>
  opened(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Kestrel', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } }));

test('knownReplicaFeatures(true) adds wrap@2 to the registry, sorted; knownReplicaFeatures(false) is the registry; this Node passes the probe', () => {
  assert.deepEqual(knownReplicaFeatures(true), [...KNOWN_REPLICA_FEATURES, WRAP_V2_FEATURE].sort());
  assert.deepEqual(knownReplicaFeatures(false), KNOWN_REPLICA_FEATURES);
  assert.ok(clientReplicaFeatures().includes(WRAP_V2_FEATURE));
  assert.equal(coversRequired([WRAP_V2_FEATURE], [WRAP_V2_FEATURE]), false, 'the registry alone does not know wrap@2');
  assert.equal(coversRequired([WRAP_V2_FEATURE], [WRAP_V2_FEATURE], knownReplicaFeatures(true)), true);
});

test('a project made shared where the probe passes requires require@1 and wrap@2 in one roster.require', async () => {
  const project = await created(install('passes'));
  const { roster } = await project.state();
  assert.deepEqual(roster.required, ['require@1', WRAP_V2_FEATURE]);
  assert.equal(roster.requiredFrom.get(WRAP_V2_FEATURE), roster.requiredFrom.get('require@1'));
  await project.close();
});

test('a project made shared where the probe fails requires require@1 only', async () => {
  const project = await created(install('fails', WITHOUT_WRAP));
  assert.deepEqual((await project.state()).roster.required, ['require@1']);
  await project.close();
});

test('a computer without wrap@2 stops a project that requires it with the update sentence', async () => {
  const at = install('stops');
  const made = await created(at);
  await made.close();
  const without = opened(await ReplicaProject.open(at.root, { ...at.deps, knownFeatures: WITHOUT_WRAP }));
  await assert.rejects(without.state(), (error: unknown) => {
    assert.ok(error instanceof ReplicaProjectError);
    assert.equal(error.refusal.refused, 'needs-update');
    assert.equal(error.refusal.message, UPDATE_SENTENCE);
    return true;
  });
  await without.close();
});

test('an existing project opened by an updated lead gains nothing: wrap@2 comes only through the lead\'s switch', async () => {
  const at = install('existing', WITHOUT_WRAP);
  const made = await created(at);
  await made.close();
  const updated = opened(await ReplicaProject.open(at.root, { ...at.deps, knownFeatures: knownReplicaFeatures(true) }));
  assert.deepEqual((await updated.state()).roster.required, ['require@1']);
  assert.deepEqual(await ensureRequireArmed(updated, { withWrapV2: true }), { ok: false, skipped: 'already-armed' });
  assert.deepEqual((await updated.state()).roster.required, ['require@1']);
  await updated.close();
});
