// Your organization's rules on this computer (Phase 41, FND-01, FND-02, D-12 to D-15, D-18 to D-21, D-27, D-57): the pin in SecretStorage, the layer
// under gate/organization/, the layered load every decision reads, and the host's accept, Apply and Reset. Real files in temp folders and in-memory
// secret stores; every key is made at test time from a label (policyFixtures). Fictional names only. The host tests live here: there is no gateHost file.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { bundleHash } from '../domain/gate/bundle';
import { GATE_DIR_NAME, POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, ORGANIZATION_LAYER_FILE, OrganizationStoreError, setOrganizationWriteProbe } from '../gate/organizationStore';
import { enrolmentTextFor } from './helpers/enrolmentFixtures';
import { FIXED_NOW, issuerKey } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';

interface World {
  readonly storage: string;
  readonly secrets: MemorySecrets;
  /** The clock every host of this world reads; tests move it. */
  readonly clock: { now: number };
  /** Every host made in this world, flushed before the folder is removed. */
  readonly hosts: GateHost[];
}

async function withWorld(work: (world: World) => Promise<void>): Promise<void> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-organization-'));
  try {
    const world: World = { storage, secrets: new MemorySecrets(), clock: { now: FIXED_NOW }, hosts: [] };
    try {
      await work(world);
    } finally {
      await Promise.all(world.hosts.map((host) => host.flush().catch(() => undefined)));
    }
  } finally {
    setOrganizationWriteProbe(undefined);
    await rm(storage, { recursive: true, force: true });
  }
}

function hostOf(world: World): GateHost {
  const host = new GateHost({ globalStorageDir: world.storage, secrets: world.secrets, productVersion: '0.0.0-test', now: () => new Date(world.clock.now) });
  world.hosts.push(host);
  return host;
}

function organizationFolder(world: World): string {
  return path.join(gateDir(world.storage), ORGANIZATION_DIR_NAME);
}

function layerFile(world: World): string {
  return path.join(organizationFolder(world), ORGANIZATION_LAYER_FILE);
}

/** The api.operation of every record in the install log, after the host's queue is written. */
async function installOperations(host: GateHost, world: World): Promise<string[]> {
  await host.flush();
  let text: string;
  try {
    text = await readFile(path.join(world.storage, GATE_DIR_NAME, DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  return text.trim().split('\n').filter((line) => line !== '').map((line) => String((JSON.parse(line) as { api?: { operation?: string } }).api?.operation));
}

function pinOf(world: World): Record<string, unknown> | undefined {
  const text = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
  return text === undefined ? undefined : JSON.parse(text) as Record<string, unknown>;
}

function levelOf(host: GateHost, key: string): string | undefined {
  const state = host.bundleState();
  assert.equal(state.state, 'valid', state.state === 'failed-closed' ? state.sentence : '');
  return state.state === 'valid' ? state.bundle.routing.levels[key] : undefined;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 1: the tracer

test('D-13: enrolling writes the pin pending, the layer file, then the pin, and decisions read the narrowed policy', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    assert.equal((await host.start()).state, 'valid');
    assert.notEqual(levelOf(host, 'org/Internal'), 'local-only', 'the starting rules do not keep org/Internal on this computer');
    const steps: string[] = [];
    setOrganizationWriteProbe((step) => { steps.push(step); });

    const state = await host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true });
    assert.equal(state.state, 'valid');
    assert.equal(levelOf(host, 'org/Internal'), 'local-only', 'every decision reads your organization\'s narrowing');
    assert.deepEqual(steps, ['pin-pending', 'layer-written', 'pin-committed']);
    const pin = pinOf(world);
    assert.equal(pin?.['publicKey'], issuerKey().publicKey);
    assert.equal(pin?.['pending'], undefined, 'the pin is committed');
    assert.equal(await exists(layerFile(world)), true);
    assert.ok((await installOperations(host, world)).includes('policy.enrolled'));
    assert.equal(host.policyLayers().organization.state, 'valid');
  });
});

test('a new host on the same storage and secrets starts with the same composed policy and hash', async () => {
  await withWorld(async (world) => {
    const first = hostOf(world);
    await first.start();
    const accepted = await first.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true });
    assert.equal(accepted.state, 'valid');
    await first.flush();
    world.clock.now = FIXED_NOW + 60_000;
    const second = hostOf(world);
    const again = await second.start();
    assert.equal(again.state, 'valid');
    if (again.state !== 'valid' || accepted.state !== 'valid') return;
    assert.equal(again.hash, accepted.hash);
    assert.deepEqual(again.bundle, accepted.bundle);
    assert.equal(levelOf(second, 'org/Internal'), 'local-only');
  });
});

test('D-12: an enrolment that was not confirmed aloud changes nothing', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    const before = await host.start();
    for (const confirmation of [{}, { wordsConfirmed: false }]) {
      await assert.rejects(host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), confirmation), (error: unknown) => {
        assert.ok(error instanceof OrganizationStoreError);
        assert.match(error.message, /^Nothing was changed:/);
        return true;
      });
    }
    assert.equal(world.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false, 'no pin');
    assert.equal(await exists(organizationFolder(world)), false, 'no organization folder');
    assert.deepEqual(host.bundleState(), before);
    assert.equal((await installOperations(host, world)).includes('policy.organization-refused'), false, 'declining is not a refused file');
  });
});

test('D-18: without an organization layer the host\'s state and hash are exactly the personal layer\'s', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    const state = await host.start();
    assert.equal(state.state, 'valid');
    assert.equal(host.policyLayers().organization.state, 'none');
    const envelope = JSON.parse(await readFile(path.join(gateDir(world.storage), POLICY_BUNDLE_FILE), 'utf8')) as { payload: unknown };
    if (state.state === 'valid') assert.equal(state.hash, bundleHash(envelope.payload));
    assert.equal(host.policyLayers().failedLayer, undefined);
    assert.deepEqual(host.policyLayers().ignored, []);
  });
});
