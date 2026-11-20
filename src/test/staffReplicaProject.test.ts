// The shared project on the host (31-18, D-07, D-19, D-24, D-44, D-46): created on disk, reopened, folded with the real roster and this device's key
// ring through one long-lived context; joined from a welcome file on a second install; entries from outside checked by the decode worker first.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { ORIGIN_ROSTER } from '../domain/replica/roster';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { REPLICA_DIR, REPLICA_PROJECT_FILE } from '../domain/staff/multiUser';
import type { SecretStorageLike } from '../services/auth';
import { DEVICE_KEY_SECRET } from '../team/identity';
import { ENCRYPTION_KEY_SECRET, EPOCH_KEY_SECRET_PREFIX } from '../staff/replica/keyring';
import { PROJECT_REFUSALS_HOST, ReplicaProject, genesisPinFile, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { updateData } from './helpers/replicaWorld';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const NOW = '2026-11-20T10:00:00.000Z';
const PRODUCT = 'intel-estimate';
const LABEL_MAP_HASH = 'c'.repeat(64);

interface Install { root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps }

/** One install: its own project folder, global storage folder and secret storage. */
function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-replica-project-${label}-`));
  const secrets = new MemorySecrets();
  const global = path.join(base, 'global');
  return { root: path.join(base, 'project'), global, secrets, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW) } };
}

function project(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

async function created(at: Install): Promise<ReplicaProject> {
  return project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: LABEL_MAP_HASH, lead: { member: 'mbr-lead', name: 'Lee Lead' }
  }));
}

function projectOutput(fold: { families: Record<string, unknown> }, stream: string): ProjectOutput[number] | undefined {
  return (fold.families.project as ProjectOutput).find((item) => item.stream === stream);
}

function productOf(fold: { families: Record<string, unknown> }): ProductTextOutput | undefined {
  return (fold.families.doc as ProductTextOutput[] | undefined)?.find((item) => item.product === PRODUCT);
}

// ---- Task 1: create, reopen, fold ------------------------------------------------------------------------------------------------------------------

test('createSharedProject makes the device key, the encryption key, a base cell key, the founding grant and the genesis; pins it outside the project; project.json names the same genesis', async () => {
  const lead = install('create');
  const shared = await created(lead);
  assert.ok(lead.secrets.values.has(DEVICE_KEY_SECRET));
  assert.ok(lead.secrets.values.has(ENCRYPTION_KEY_SECRET));
  assert.ok(lead.secrets.values.has(EPOCH_KEY_SECRET_PREFIX + shared.projectId));
  // The pin is in global storage, outside the project folder.
  const pinFile = genesisPinFile(lead.global, shared.projectId);
  assert.ok(path.relative(lead.root, pinFile).startsWith('..'), 'the pin is outside the project');
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as { v: number; anchor: { genesisHash: string; project: string } };
  assert.equal(pin.v, 1);
  assert.equal(pin.anchor.project, shared.projectId);
  assert.equal(pin.anchor.genesisHash, shared.anchor.genesisHash);
  const copy = JSON.parse(readFileSync(path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { genesisHash: string } };
  assert.equal(copy.anchor.genesisHash, shared.anchor.genesisHash);
  // The store holds the genesis, in the base cell's stream, written by this device.
  assert.ok(existsSync(path.join(lead.root, ...REPLICA_DIR.split('/'), 'streams', shared.projectId, `${shared.deviceWriter}.jsonl`)));
  const { roster, fold } = await shared.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, shared.anchor.genesisHash]);
  assert.ok(fold.applied.includes(shared.anchor.genesisHash));
  assert.deepEqual(roster.refused, []);
});

test('open on the same folder folds origin then genesis, and the fold shows the project name and its lead', async () => {
  const lead = install('reopen');
  const first = await created(lead);
  const again = project(await ReplicaProject.open(lead.root, lead.deps));
  assert.equal(again.projectId, first.projectId);
  const { roster, fold } = await again.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, first.anchor.genesisHash]);
  const output = projectOutput(fold, first.projectId);
  assert.equal(output?.name, 'Exercise Northwind');
  assert.equal(output?.profile, 'j2');
  assert.deepEqual(output?.lead, { member: 'mbr-lead', writer: first.deviceWriter });
  // The base cell's key came back from the cache in secret storage.
  assert.equal(again.keys.epochKey(first.projectId, 1)?.length, 32);
});

test('appendOwn doc.client then doc.update in the base cell: the fold shows the text attributed to this device and its member', async () => {
  const lead = install('append');
  const shared = await created(lead);
  const clientId = clientIdOf(1, 0);
  const client = await shared.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } });
  assert.ok('ok' in client, 'doc.client is written');
  const update = await shared.appendOwn('doc.update', updateData(PRODUCT, localInsert(createLocalDoc(clientId), 0, 'Enemy holds the ridge.')));
  assert.ok('ok' in update, 'doc.update is written');
  const reopened = project(await ReplicaProject.open(lead.root, lead.deps));
  for (const view of [shared, reopened]) {
    const { fold } = await view.state();
    assert.deepEqual(fold.refused, []);
    assert.deepEqual(fold.held, []);
    assert.deepEqual(fold.rejected, []);
    const product = productOf(fold);
    assert.equal(product?.text, 'Enemy holds the ridge.');
    assert.deepEqual(product?.attribution.map((span) => [span.writer, span.member, span.clientId]), [[shared.deviceWriter, 'mbr-lead', clientId]]);
  }
});

test('one context object is reused: two state() calls with nothing new do not refold, and an own doc entry is appended without a refold', async () => {
  const lead = install('context');
  const shared = await created(lead);
  const first = await shared.state();
  const context = shared.context();
  const refolds = shared.refolds;
  const second = await shared.state();
  assert.equal(shared.context(), context, 'the same context object');
  assert.equal(shared.refolds, refolds, 'no refold');
  assert.equal(second.fold, first.fold, 'the same fold result');
  // A doc entry changes neither the roster, the key ring nor the blob set: the context stays and the fold appends.
  const clientId = clientIdOf(1, 0);
  assert.ok('ok' in await shared.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } }));
  const third = await shared.state();
  assert.equal(shared.context(), context);
  assert.equal(shared.refolds, refolds);
  assert.equal(third.fold.applied.length, first.fold.applied.length + 1);
});

test('open returns undefined for a folder with no shared project and makes nothing; a project.json that disagrees with the pin is refused pin-mismatch, and one this computer never joined not-shared', async () => {
  const empty = install('empty');
  assert.equal(await ReplicaProject.open(empty.root, empty.deps), undefined);
  assert.equal(existsSync(empty.root), false, 'nothing was created');

  const lead = install('mismatch');
  const shared = await created(lead);
  const file = path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/'));
  const original = readFileSync(file, 'utf8');
  const swapped = JSON.parse(original) as { v: 1; anchor: { genesisHash: string; project: string } };
  swapped.anchor.genesisHash = 'd'.repeat(64);
  writeFileSync(file, JSON.stringify(swapped));
  const refused = await ReplicaProject.open(lead.root, lead.deps);
  assert.deepEqual(refused, { refused: 'pin-mismatch', message: PROJECT_REFUSALS_HOST['pin-mismatch'] });

  // The same folder opened by another install that never joined: not-shared, and no pin is written for it.
  writeFileSync(file, original);
  const stranger = install('stranger');
  const notJoined = await ReplicaProject.open(lead.root, stranger.deps);
  assert.deepEqual(notJoined, { refused: 'not-shared', message: PROJECT_REFUSALS_HOST['not-shared'] });
  assert.equal(existsSync(genesisPinFile(stranger.global, shared.projectId)), false);
});

test('createSharedProject run again after a crash before project.json uses the genesis already stored instead of building a second (Pitfall 4)', async () => {
  const lead = install('retry');
  const first = await created(lead);
  rmSync(path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/')));
  const second = await created(lead);
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.anchor.genesisHash, first.anchor.genesisHash);
  const { roster, fold } = await second.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, first.anchor.genesisHash]);
  assert.equal(fold.order.length, 1, 'one genesis');
  // And once project.json is back, a third call returns the same project.
  const third = await created(lead);
  assert.equal(third.anchor.genesisHash, first.anchor.genesisHash);
});
