// This computer's post-quantum keys (33.2-04 Task 1; 33.2-CONTEXT D-03, D-05): made once under the identity lock and kept only in secret storage,
// published as one device.kem at the next open of a shared project, never twice, and not at all where the runtime fails the probe. Fictional names.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { kemKeysAt } from '../domain/replica/deviceKem';
import type { SecretStorageLike } from '../services/auth';
import { ensureDeviceKem } from '../staff/replica/kemPublish';
import { KEM_KEY_SECRET, loadOrCreateKemKeys } from '../staff/replica/keyring';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { identityDir } from '../team/identity';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const NOW = '2026-11-24T10:00:00.000Z';

interface Install { base: string; root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps }

function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-kem-${label}-`));
  const secrets = new MemorySecrets();
  const global = path.join(base, 'global');
  // An existing project made before the switch (wrapV2AtCreation false): the case where a device publishes its keys at its next open (D-05).
  return { base, root: path.join(base, 'project'), global, secrets, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW), publishKem: true, wrapV2AtCreation: false } };
}

function opened(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

async function sharedProject(at: Install): Promise<void> {
  const made = opened(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Kestrel', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } }));
  await made.close();
}

const kemEntries = async (project: ReplicaProject): Promise<number> => {
  const { roster } = await project.state();
  return roster.kems.size;
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

test('loadOrCreateKemKeys makes the keys once and returns the same keys after; the seeds are only in secret storage', async () => {
  const at = install('once');
  const dir = identityDir(at.global);
  const first = await loadOrCreateKemKeys(at.secrets, { identityDir: dir });
  const second = await loadOrCreateKemKeys(at.secrets, { identityDir: dir });
  assert.deepEqual(second.publicKeys, first.publicKeys);
  assert.ok(at.secrets.values.has(KEM_KEY_SECRET));
  const both = await Promise.all([loadOrCreateKemKeys(at.secrets, { identityDir: dir }), loadOrCreateKemKeys(at.secrets, { identityDir: dir })]);
  assert.deepEqual(both[0].publicKeys, first.publicKeys);
  assert.deepEqual(both[1].publicKeys, first.publicKeys);
});

test('a stored value that does not read is refused and never replaced, and the project still opens without publishing', async () => {
  const at = install('damaged');
  // Making the project shared needs readable keys (33.2-06: the genesis names them), so the stored value is damaged after that.
  await sharedProject(at);
  at.secrets.values.set(KEM_KEY_SECRET, '{"p256":"short","mlkem768":"short"}');
  await assert.rejects(() => loadOrCreateKemKeys(at.secrets, { identityDir: identityDir(at.global) }), /could not be read/);
  assert.equal(at.secrets.values.get(KEM_KEY_SECRET), '{"p256":"short","mlkem768":"short"}');
  const project = opened(await ReplicaProject.open(at.root, at.deps));
  assert.equal(await kemEntries(project), 0);
  assert.equal(at.secrets.values.get(KEM_KEY_SECRET), '{"p256":"short","mlkem768":"short"}');
  await project.close();
});

test('opening a shared project publishes one device.kem signed by this device; opening it again publishes nothing', async () => {
  const at = install('open');
  await sharedProject(at);
  const first = opened(await ReplicaProject.open(at.root, at.deps));
  const { roster } = await first.state();
  const keys = await loadOrCreateKemKeys(at.secrets, { identityDir: identityDir(at.global) });
  assert.deepEqual(kemKeysAt(roster, first.deviceWriter), keys.publicKeys);
  assert.equal(roster.kems.get(first.deviceWriter)?.device, first.deviceWriter);
  await first.close();
  const second = opened(await ReplicaProject.open(at.root, at.deps));
  assert.equal(await kemEntries(second), 1);
  assert.equal(await ensureDeviceKem(second, { loadKeys: () => loadOrCreateKemKeys(at.secrets, { identityDir: identityDir(at.global) }) }), 'present');
  await second.close();
});

test('with the probe false nothing is made or published', async () => {
  const at = install('probe');
  await sharedProject(at);
  const project = opened(await ReplicaProject.open(at.root, at.deps));
  // The open published already (this Node passes the probe); a fresh install's keys are what the failed probe must not make.
  const other = install('probe-other');
  let made = false;
  const outcome = await ensureDeviceKem(project, { probe: () => false, loadKeys: async () => { made = true; return loadOrCreateKemKeys(other.secrets, { identityDir: identityDir(other.global) }); } });
  assert.equal(outcome, 'unavailable');
  assert.equal(made, false);
  assert.equal(other.secrets.values.has(KEM_KEY_SECRET), false);
  assert.equal(await kemEntries(project), 1);
  await project.close();
});

test('no file under the project folder or the identity folder holds either seed', async () => {
  const at = install('bytes');
  await sharedProject(at);
  const project = opened(await ReplicaProject.open(at.root, at.deps));
  await project.close();
  const stored = JSON.parse(at.secrets.values.get(KEM_KEY_SECRET) as string) as { p256: string; mlkem768: string };
  const seeds = [Buffer.from(stored.p256, 'base64url'), Buffer.from(stored.mlkem768, 'base64url')];
  const files = filesUnder(at.base);
  assert.ok(files.length > 0);
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const seed of seeds) {
      assert.equal(bytes.includes(seed), false, `${file} holds a seed`);
      for (const text of [seed.toString('base64url'), seed.toString('base64'), seed.toString('hex')]) assert.equal(bytes.includes(Buffer.from(text)), false, `${file} holds a seed as text`);
    }
  }
});

test('a project made shared with wrap@2 names the lead device\'s keys in its genesis, so opening it publishes nothing more', async () => {
  const at = install('switched');
  at.deps.wrapV2AtCreation = true;
  await sharedProject(at);
  const project = opened(await ReplicaProject.open(at.root, at.deps));
  const { roster } = await project.state();
  const keys = await loadOrCreateKemKeys(at.secrets, { identityDir: identityDir(at.global) });
  assert.deepEqual(kemKeysAt(roster, project.deviceWriter), keys.publicKeys);
  assert.equal(roster.kems.size, 0, 'no device.kem was needed');
  await project.close();
});
