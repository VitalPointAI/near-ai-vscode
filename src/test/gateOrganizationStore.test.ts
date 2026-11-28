// Your organization's rules on this computer (Phase 41, FND-01, FND-02, D-12 to D-15, D-18 to D-21, D-27, D-57): the pin in SecretStorage, the layer
// under gate/organization/, the layered load every decision reads, and the host's accept, Apply and Reset. Real files in temp folders and in-memory
// secret stores; every key is made at test time from a label (policyFixtures). Fictional names only. The host tests live here: there is no gateHost file.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import { labelKeyShown } from '../domain/gate/labelAlgebra';
import { signPayload } from '../domain/team/signedPayload';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { writeLastValid } from '../gate/clockMarker';
import { buildEnrolment, buildOrganizationLayer, contactShown, fileTextOf, organizationEndedText } from '../domain/gate/enrolment';
import { GATE_DIR_NAME, POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import {
  DAMAGED_PIN_TEXT, ENROLMENT_RECORD_FILE, NOT_ENROLLED_TEXT, NO_SECRET_STORAGE_TEXT, ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, ORGANIZATION_LAYER_FILE, OrganizationStore,
  OrganizationStoreError, migrationNoticeText,
  previewOrganizationFile, setOrganizationWriteProbe
} from '../gate/organizationStore';
import { loadDeviceIdentity } from '../team/identity';
import { EXAMPLE_ORGANIZATION, enrolmentTextFor, organizationSections, rotationTextFor, rulesTextFor } from './helpers/enrolmentFixtures';
import { DAY_MS, FIXED_NOW, issuerKey } from './helpers/policyFixtures';
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: every organization state

/** Your organization's sections with one routing level set, so a rules update changes something a decision reads. */
function sectionsWith(level: string, tier: string): Record<string, unknown> {
  const sections = organizationSections();
  ((sections['labels'] as { routing: { levels: Record<string, string> } }).routing.levels)[level] = tier;
  return sections;
}

async function personalHash(world: World): Promise<string> {
  const envelope = JSON.parse(await readFile(path.join(gateDir(world.storage), POLICY_BUNDLE_FILE), 'utf8')) as { payload: unknown };
  return bundleHash(envelope.payload);
}

async function enrolled(world: World, options: Parameters<typeof enrolmentTextFor>[1] = {}): Promise<GateHost> {
  const host = hostOf(world);
  await host.start();
  const state = await host.acceptOrganizationFile(enrolmentTextFor(issuerKey(), options), { wordsConfirmed: true });
  assert.equal(state.state, 'valid', state.state === 'failed-closed' ? state.sentence : '');
  return host;
}

function failedOf(state: ReturnType<GateHost['bundleState']>): { reason: string; sentence: string; ownPolicy?: true } {
  assert.equal(state.state, 'failed-closed');
  return state.state === 'failed-closed' ? state : { reason: '', sentence: '' };
}

const SECURITY_DESK = contactShown(EXAMPLE_ORGANIZATION.contacts);

test('a secret store that cannot be read fails closed; with nothing from your organization on this computer it says so calmly', async () => {
  await withWorld(async (world) => {
    // A fresh Sterling workbench in local mode: every secret read rejects (workbench/extension/src/node/key-stores.ts "unavailable").
    const unavailable = {
      get: async () => { throw new Error('Secrets are unavailable'); },
      store: async () => { throw new Error('Secrets are unavailable'); },
      delete: async () => { throw new Error('Secrets are unavailable'); }
    };
    const fresh = await new OrganizationStore(world.storage, unavailable).load(FIXED_NOW);
    assert.equal(fresh.state, 'failed');
    assert.ok(fresh.state === 'failed' && fresh.failure.state === 'failed-closed' && fresh.failure.reason === 'identity-unavailable', 'still failed closed');
    assert.equal(fresh.state === 'failed' ? fresh.sentence : '', NO_SECRET_STORAGE_TEXT);
    // Once this computer holds files from your organization, a record of its key was kept: the sentence says the record could not be read.
    await mkdir(organizationFolder(world), { recursive: true });
    await writeFile(layerFile(world), '{}');
    const enrolled = await new OrganizationStore(world.storage, unavailable).load(FIXED_NOW);
    assert.equal(enrolled.state, 'failed');
    assert.match(enrolled.state === 'failed' ? enrolled.sentence : '', /could not read its record of your organization's key/);
  });
});

test('D-13: a crash after the layer file and before the pin leaves this computer not enrolled', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    await host.start();
    setOrganizationWriteProbe((step) => { if (step === 'layer-written') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true }), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal((pinOf(world)?.['pending'] as { kind?: string } | undefined)?.kind, 'enrol', 'the crash left the pending first enrolment');
    assert.equal(await exists(layerFile(world)), true, 'and the layer file');

    const after = hostOf(world);
    const state = await after.start();
    assert.equal(after.policyLayers().organization.state, 'none');
    assert.equal(state.state, 'valid');
    if (state.state === 'valid') assert.equal(state.hash, await personalHash(world), 'the personal policy alone');
    assert.notEqual(levelOf(after, 'org/Internal'), 'local-only');

    const again = await after.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true });
    assert.equal(again.state, 'valid');
    assert.equal(levelOf(after, 'org/Internal'), 'local-only', 'a second confirmed enrolment enrols');
    assert.equal(pinOf(world)?.['pending'], undefined);
  });
});

test('D-13, CR-01: a pending pin with no layer file is not enrolled; a layer file with no pin fails closed as a damaged pin', async () => {
  await withWorld(async (world) => {
    const pending = { kind: 'enrol', publicKey: issuerKey().publicKey, serial: 1, issuedAt: new Date(FIXED_NOW).toISOString(), layerHash: 'a'.repeat(64) };
    await world.secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify({ v: 1, pending }));
    const host = hostOf(world);
    assert.equal((await host.start()).state, 'valid');
    assert.equal(host.policyLayers().organization.state, 'none');
    assert.notEqual(levelOf(host, 'org/Internal'), 'local-only');
  });
  await withWorld(async (world) => {
    // This computer has its own policy; then a rules file appears with no pin. A first enrolment that never committed leaves its pending pin (above),
    // so files with no pin at all mean the pin was lost: the whole policy fails closed, never the personal layer alone (CR-01).
    assert.equal((await hostOf(world).start()).state, 'valid');
    await mkdir(organizationFolder(world), { recursive: true });
    const empty = hostOf(world);
    assert.equal((await empty.start()).state, 'valid', 'an empty organization folder says nothing (allowed side)');
    assert.equal(empty.policyLayers().organization.state, 'none');
    const text = rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'));
    await writeFile(layerFile(world), text);
    const host = hostOf(world);
    const failed = failedOf(await host.start());
    assert.equal(failed.sentence, DAMAGED_PIN_TEXT);
    assert.equal(failed.ownPolicy, undefined, 'never the personal layer\'s reset mark');
    const view = host.policyLayers().organization;
    assert.equal(view.state === 'failed' ? view.reason : view.state, 'damaged-pin');
    assert.equal(await readFile(layerFile(world), 'utf8'), text, 'and left on disk as it was');
  });
});

test('D-15: a rules file signed by this computer\'s key is refused unknown-key, on disk and through accept', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const device = await loadDeviceIdentity(world.secrets);
    assert.ok(device);
    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    const own = fileTextOf(buildOrganizationLayer(device, sectionsWith('org/Public', 'any-cloud'), { now: FIXED_NOW + DAY_MS, days: 90 }));
    await assert.rejects(host.acceptOrganizationFile(own, { wordsConfirmed: true }), (error: unknown) => {
      assert.ok(error instanceof OrganizationStoreError);
      assert.equal(error.reason, 'unknown-key');
      assert.equal(error.refused, true);
      assert.match(error.message, /^Nothing was changed/);
      return true;
    });
    assert.ok((await installOperations(host, world)).includes('policy.organization-refused'));
    assert.equal(levelOf(host, 'org/Internal'), 'local-only', 'the rules in force stay');

    await writeFile(layerFile(world), own);
    const next = hostOf(world);
    const failed = failedOf(await next.start());
    assert.equal(failed.reason, 'unknown-key');
    assert.equal(failed.ownPolicy, undefined, 'never the personal layer\'s reset mark');
    assert.ok(failed.sentence.includes(`Ask ${SECURITY_DESK} for the rules file`), failed.sentence);
    assert.equal(next.policyLayers().failedLayer, 'organization');
    const operations = await installOperations(next, world);
    assert.equal(operations.filter((operation) => operation === 'policy.organization-refused').length, 2, 'the accept refusal, then the start once');
  });
});

test('D-14: an older rules file is refused and recorded, and the rules in force stay', async () => {
  await withWorld(async (world) => {
    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    const host = await enrolled(world, { now: FIXED_NOW + 2 * DAY_MS });
    const before = host.bundleState();
    const bytes = await readFile(layerFile(world), 'utf8');
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    const older = rulesTextFor(issuerKey(), sectionsWith('org/Restricted', 'any-cloud'), { now: FIXED_NOW + DAY_MS });
    await assert.rejects(host.acceptOrganizationFile(older, {}), (error: unknown) => {
      assert.ok(error instanceof OrganizationStoreError);
      assert.equal(error.reason, 'older');
      assert.match(error.message, /^Nothing was changed\. These rules are older/);
      return true;
    });
    assert.ok((await installOperations(host, world)).includes('policy.organization-refused'));
    assert.deepEqual(host.bundleState(), before);
    assert.equal(await readFile(layerFile(world), 'utf8'), bytes);
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin);
  });
});

test('D-14, D-21: an older rules file put back on disk fails the whole policy closed as replaced, never the personal layer alone', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const old = await readFile(layerFile(world), 'utf8');
    world.clock.now = FIXED_NOW + DAY_MS;
    assert.equal((await host.acceptOrganizationFile(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'attested-cloud'), { now: FIXED_NOW + DAY_MS }), {})).state, 'valid');
    await writeFile(layerFile(world), old);
    const next = hostOf(world);
    const failed = failedOf(await next.start());
    assert.equal(failed.reason, 'replaced');
    assert.equal(failed.ownPolicy, undefined);
    assert.equal(failed.sentence.includes('Reset'), false, failed.sentence);
    assert.equal(next.policyLayers().failedLayer, 'organization');
    assert.notEqual(failed.sentence, BUNDLE_FAILURES.replaced, 'your organization\'s sentence, not the personal one');
  });
});

test('D-14: a newer rules file signed by the pin is accepted as policy.organization-updated, and a crash between its file and the pin rolls forward at the next start', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    world.clock.now = FIXED_NOW + DAY_MS;
    const state = await host.acceptOrganizationFile(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'attested-cloud'), { now: FIXED_NOW + DAY_MS }), {});
    assert.equal(state.state, 'valid');
    assert.equal(levelOf(host, 'org/Public'), 'attested-cloud');
    assert.ok((await installOperations(host, world)).includes('policy.organization-updated'));

    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    setOrganizationWriteProbe((step, kind) => { if (step === 'layer-written' && kind === 'update') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'), { now: FIXED_NOW + 2 * DAY_MS }), {}), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal((pinOf(world)?.['pending'] as { kind?: string } | undefined)?.kind, 'update');

    const next = hostOf(world);
    assert.equal((await next.start()).state, 'valid');
    assert.equal(levelOf(next, 'org/Public'), 'local-only', 'the newer rules are in force');
    assert.ok((await installOperations(next, world)).filter((operation) => operation === 'policy.organization-updated').length >= 2);
    const pin = pinOf(world);
    assert.equal(pin?.['pending'], undefined, 'the pin was committed at start');
    assert.equal(pin?.['lastIssuedAt'], new Date(FIXED_NOW + 2 * DAY_MS).toISOString());
  });
});

test('D-14: a key handover needs the words again; afterwards only the new key\'s rules are accepted', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('handover-old');
    const fresh = issuerKey('handover-new');
    const host = hostOf(world);
    await host.start();
    assert.equal((await host.acceptOrganizationFile(enrolmentTextFor(old), { wordsConfirmed: true })).state, 'valid');
    world.clock.now = FIXED_NOW + DAY_MS;
    const handover = rotationTextFor(old, fresh, { now: FIXED_NOW + DAY_MS });
    await assert.rejects(host.acceptOrganizationFile(handover, {}), (error: unknown) => error instanceof OrganizationStoreError && /^Nothing was changed:/.test(error.message));
    assert.equal(pinOf(world)?.['publicKey'], old.publicKey, 'declining keeps the old key');

    assert.equal((await host.acceptOrganizationFile(handover, { wordsConfirmed: true })).state, 'valid');
    assert.equal(pinOf(world)?.['publicKey'], fresh.publicKey);
    assert.equal(pinOf(world)?.['serial'], 2);
    assert.ok((await installOperations(host, world)).includes('policy.organization-updated'));

    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    await assert.rejects(host.acceptOrganizationFile(rulesTextFor(old, organizationSections(), { now: FIXED_NOW + 2 * DAY_MS }), {}), (error: unknown) => {
      assert.ok(error instanceof OrganizationStoreError);
      assert.equal(error.reason, 'unknown-key');
      return true;
    });
    assert.equal((await host.acceptOrganizationFile(rulesTextFor(fresh, sectionsWith('org/Public', 'local-only'), { now: FIXED_NOW + 2 * DAY_MS }), {})).state, 'valid');
    assert.equal(levelOf(host, 'org/Public'), 'local-only');
  });
});

test('D-14: expired organization rules fail the whole policy closed with the date and the contact, and the clock set back does not revive them', async () => {
  await withWorld(async (world) => {
    await enrolled(world, { layerDays: 40 });
    const ended = organizationEndedText(new Date(FIXED_NOW + 40 * DAY_MS).toISOString().slice(0, 10), SECURITY_DESK);

    world.clock.now = FIXED_NOW + 5 * DAY_MS;
    const early = hostOf(world);
    assert.equal((await early.start()).state, 'valid');
    const earlyView = early.policyLayers().organization;
    assert.equal(earlyView.state === 'valid' && earlyView.endsSoon, false, 'more than 30 days left');

    world.clock.now = FIXED_NOW + 15 * DAY_MS;
    const soon = hostOf(world);
    assert.equal((await soon.start()).state, 'valid', 'still valid within its last 30 days');
    const soonView = soon.policyLayers().organization;
    assert.equal(soonView.state === 'valid' && soonView.endsSoon, true);

    world.clock.now = FIXED_NOW + 41 * DAY_MS;
    const late = hostOf(world);
    const failed = failedOf(await late.start());
    assert.equal(failed.reason, 'expired');
    assert.equal(failed.sentence, ended);
    assert.equal(late.policyLayers().failedLayer, 'organization');

    world.clock.now = FIXED_NOW + 5 * DAY_MS;
    const setBack = hostOf(world);
    assert.equal(failedOf(await setBack.start()).sentence, ended, 'the clock marker keeps the later time');
  });
});

test('D-14: rules that expire while the window is open read as ended with your organization\'s sentence', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world, { layerDays: 40 });
    world.clock.now = FIXED_NOW + 41 * DAY_MS;
    const failed = failedOf(host.bundleState());
    assert.equal(failed.sentence, organizationEndedText(new Date(FIXED_NOW + 40 * DAY_MS).toISOString().slice(0, 10), SECURITY_DESK));
    assert.notEqual(failed.sentence, BUNDLE_FAILURES.expired);
  });
});

test('D-21: a personal layer that fails under an organization layer fails closed with failedLayer personal', async () => {
  await withWorld(async (world) => {
    await enrolled(world);
    const file = path.join(gateDir(world.storage), POLICY_BUNDLE_FILE);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: { expiresAt: string } };
    envelope.payload.expiresAt = new Date(FIXED_NOW + 3000 * DAY_MS).toISOString();
    await writeFile(file, JSON.stringify(envelope));
    const next = hostOf(world);
    const failed = failedOf(await next.start());
    assert.equal(failed.reason, 'bad-signature');
    assert.equal(failed.sentence, BUNDLE_FAILURES['bad-signature'], 'the personal sentence, whose fix is the personal reset');
    assert.equal(next.policyLayers().failedLayer, 'personal');
    assert.equal(next.policyLayers().organization.state, 'valid');
  });
});

test('D-20: a wider personal value is listed in policyLayers().ignored and the policy stays valid', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    assert.equal(host.bundleState().state, 'valid');
    const ignored = host.policyLayers().ignored;
    assert.ok(ignored.some((entry) => entry.key.includes('org/Internal') && entry.layer === 'personal'), JSON.stringify(ignored));
  });
});

test('D-57: a crash during a key handover, after its files and before the pin, finishes at the next start under the new key', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('crash-old');
    const fresh = issuerKey('crash-new');
    const host = hostOf(world);
    await host.start();
    assert.equal((await host.acceptOrganizationFile(enrolmentTextFor(old), { wordsConfirmed: true })).state, 'valid');
    world.clock.now = FIXED_NOW + DAY_MS;
    setOrganizationWriteProbe((step, kind) => { if (step === 'layer-written' && kind === 'rotate') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(rotationTextFor(old, fresh, { now: FIXED_NOW + DAY_MS }), { wordsConfirmed: true }), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal(pinOf(world)?.['publicKey'], old.publicKey, 'the committed pin still names the old key');

    const next = hostOf(world);
    assert.equal((await next.start()).state, 'valid', 'the handover finished, never a lock-out');
    assert.equal(pinOf(world)?.['publicKey'], fresh.publicKey);
    assert.equal(pinOf(world)?.['pending'], undefined);
    assert.ok((await installOperations(next, world)).includes('policy.organization-updated'));
    const view = next.policyLayers().organization;
    assert.equal(view.state === 'valid' ? view.name : undefined, EXAMPLE_ORGANIZATION.name, 'the name is read from the record the new key signed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 3: v2 Apply under your organization's rules, Reset of the personal layer only, the migration changes

function personalStoredOf(host: GateHost): Record<string, unknown> {
  const personal = host.policyLayers().personal;
  assert.ok(personal, 'the personal layer was read');
  return JSON.parse(JSON.stringify(personal.stored)) as Record<string, unknown>;
}

function withLevel(payload: Record<string, unknown>, level: string, tier: string): Record<string, unknown> {
  const routing = payload['routing'] as { levels: Record<string, string> };
  return { ...payload, routing: { ...routing, levels: { ...routing.levels, [level]: tier } } };
}

function composedHash(host: GateHost): string {
  const state = host.bundleState();
  assert.equal(state.state, 'valid');
  return state.state === 'valid' ? state.hash : '';
}

test('D-20: under your organization\'s rules an Apply that widens is refused with the key named, one that narrows is applied, and a value already clamped does not block an unrelated edit', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const file = path.join(gateDir(world.storage), POLICY_BUNDLE_FILE);
    const bytes = await readFile(file, 'utf8');
    const stored = personalStoredOf(host);
    assert.equal((stored['routing'] as { levels: Record<string, string> }).levels['org/Internal'], 'attested-cloud', 'the personal value is wider and was clamped at load');

    await assert.rejects(host.applyPolicyDraft(JSON.stringify(withLevel(stored, 'org/Internal', 'any-cloud')), composedHash(host)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Nothing was changed\. Your organization's rules do not allow \S*org\/Internal\S* to be wider than /);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), bytes, 'the stored bytes are unchanged');
    assert.equal(levelOf(host, 'org/Internal'), 'local-only');

    // An unrelated narrowing edit is applied, with the clamped org/Internal value left as it was in the personal layer.
    const result = await host.applyPolicyDraft(JSON.stringify(withLevel(stored, 'org/Public', 'attested-cloud')), composedHash(host));
    assert.equal(result.state.state, 'valid');
    assert.equal(levelOf(host, 'org/Public'), 'attested-cloud');
    assert.equal(levelOf(host, 'org/Internal'), 'local-only');
    const written = (JSON.parse(await readFile(file, 'utf8')) as { payload: Record<string, unknown> }).payload;
    assert.equal(written['bundleVersion'], 2);
    const organization = host.policyLayers().organization;
    assert.equal(organization.state, 'valid');
    if (organization.state === 'valid') assert.deepEqual(written['parent'], { hash: organization.hash, issuer: organization.document.issuer.fingerprint });
    assert.ok((await installOperations(host, world)).includes('policy.edit'));
  });
});

test('D-21: Reset under your organization\'s rules re-signs only the personal layer', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const layerBytes = await readFile(layerFile(world), 'utf8');
    const recordBytes = await readFile(path.join(organizationFolder(world), ENROLMENT_RECORD_FILE), 'utf8');
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    const personalBefore = await personalHash(world);
    world.clock.now = FIXED_NOW + DAY_MS;
    const result = await host.reset();
    assert.equal(result.state.state, 'valid');
    const operations = await installOperations(host, world);
    assert.ok(operations.includes('policy.reset-personal'));
    assert.equal(operations.includes('policy.reset'), false);
    assert.equal(await readFile(layerFile(world), 'utf8'), layerBytes, 'your organization\'s layer is byte for byte the same');
    assert.equal(await readFile(path.join(organizationFolder(world), ENROLMENT_RECORD_FILE), 'utf8'), recordBytes);
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, 'the pin is unchanged');
    assert.notEqual(await personalHash(world), personalBefore, 'the personal layer was re-signed');
    assert.equal(levelOf(host, 'org/Internal'), 'local-only', 'still narrowed');
  });
  await withWorld(async (world) => {
    // Without your organization's rules, Reset is recorded as before (allowed side).
    const host = hostOf(world);
    await host.start();
    await host.reset();
    const operations = await installOperations(host, world);
    assert.ok(operations.includes('policy.reset'));
    assert.equal(operations.includes('policy.reset-personal'), false);
  });
});

test('D-21: Apply is refused while your organization\'s layer fails, with its sentence, and nothing is written', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const stored = personalStoredOf(host);
    const base = composedHash(host);
    await writeFile(layerFile(world), '{ "not": "a layer" }\n');
    const next = hostOf(world);
    assert.equal((await next.start()).state, 'failed-closed');
    const file = path.join(gateDir(world.storage), POLICY_BUNDLE_FILE);
    const bytes = await readFile(file, 'utf8');
    await assert.rejects(next.applyPolicyDraft(JSON.stringify(withLevel(stored, 'org/Public', 'attested-cloud')), base), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Nothing was changed: your policy cannot be trusted right now, so it cannot be edited\. Your organization's rules/);
      assert.equal(error.message.match(/\bAsk\b/g)?.length, 1, 'one person to ask, named once');
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), bytes);
  });
});

test('D-27: a v1 personal layer with local hosts reports its migration changes; a v2 one reports none', async () => {
  await withWorld(async (world) => {
    const first = hostOf(world);
    await first.start();
    const identity = await loadDeviceIdentity(world.secrets);
    assert.ok(identity);
    const payload = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: FIXED_NOW }))) as Record<string, unknown>;
    payload['routing'] = { ...(payload['routing'] as Record<string, unknown>), localHosts: ['*.lab.example.org', 'models.example.org'] };
    const envelope = signPayload(identity, 'policy-bundle', payload, { now: () => new Date(FIXED_NOW) });
    await writeFile(path.join(gateDir(world.storage), POLICY_BUNDLE_FILE), `${JSON.stringify(envelope, null, 2)}\n`);
    await writeLastValid(world.secrets, { at: FIXED_NOW, hash: bundleHash(payload) });

    const host = hostOf(world);
    const state = await host.start();
    assert.equal(state.state, 'valid', state.state === 'failed-closed' ? state.sentence : '');
    const migration = host.policyLayers().migration;
    assert.deepEqual(migration.map((change) => change.host), ['*.lab.example.org', 'models.example.org'], 'one change per entry');
    const text = migrationNoticeText(migration);
    assert.ok(text !== undefined);
    assert.ok(text.includes('models.example.org'), text);
    assert.ok(text.includes(labelKeyShown('ca-protected/Protected B')), text);
    assert.ok(text.includes(labelKeyShown('nato/NATO Restricted')), text);
    assert.equal(text.includes('lab.example.org'), false, 'the pattern host lost nothing and is not named');
    assert.equal(text.includes('\u2014'), false, 'no em-dash');
    assert.equal(migrationNoticeText([]), undefined);

    const applied = await host.applyPolicyDraft(JSON.stringify(payload), composedHash(host));
    assert.equal(applied.state.state, 'valid');
    assert.deepEqual(host.policyLayers().migration, [], 'a v2 layer reports none');
  });
});

test('a preview reads a file the way accept does, with the words for an enrolment, and writes nothing', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    await host.start();
    const rules = rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'));
    const refused = await previewOrganizationFile(world.storage, world.secrets, rules, world.clock.now);
    assert.deepEqual(refused, { kind: 'refused', reason: 'not-enrolled', sentence: NOT_ENROLLED_TEXT });
    const enrolment = enrolmentTextFor(issuerKey());
    const preview = await previewOrganizationFile(world.storage, world.secrets, enrolment, world.clock.now);
    assert.equal(preview.kind, 'enrol');
    if (preview.kind === 'enrol') {
      assert.equal(preview.name, EXAMPLE_ORGANIZATION.name);
      assert.equal(preview.words?.length, 12);
      assert.deepEqual(preview.contacts, EXAMPLE_ORGANIZATION.contacts);
    }
    assert.deepEqual(await previewOrganizationFile(world.storage, world.secrets, 'not json', world.clock.now).then((value) => value.kind), 'refused');
    assert.equal(world.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false, 'nothing was pinned');
    assert.equal(await exists(organizationFolder(world)), false, 'nothing was written');
    await host.acceptOrganizationFile(enrolment, { wordsConfirmed: true });
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, enrolment, world.clock.now)).kind, 'same');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Code review fixes (41-REVIEW.md CR-01, WR-01, IN-01)

test('CR-01: the pin removed from secret storage while your organization\'s rules are on disk fails closed, and opening the enrolment file again repairs it', async () => {
  await withWorld(async (world) => {
    await enrolled(world);
    world.secrets.values.delete(ORGANIZATION_ISSUER_SECRET);
    const next = hostOf(world);
    const failed = failedOf(await next.start());
    assert.equal(failed.sentence, DAMAGED_PIN_TEXT);
    assert.equal(failed.ownPolicy, undefined, 'never the personal layer\'s reset mark');
    assert.equal(next.policyLayers().failedLayer, 'organization');
    const view = next.policyLayers().organization;
    assert.equal(view.state === 'failed' ? view.reason : view.state, 'damaged-pin', 'not the personal layer alone');

    // The way out the sentence names: the enrolment file, its words compared again (allowed side).
    const preview = await previewOrganizationFile(world.storage, world.secrets, enrolmentTextFor(issuerKey()), world.clock.now);
    assert.equal(preview.kind, 'enrol');
    assert.equal((await next.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true })).state, 'valid');
    assert.equal(levelOf(next, 'org/Internal'), 'local-only');
    assert.equal(pinOf(world)?.['pending'], undefined);
  });
});

test('CR-01, D-57: a crash while enrolling again over a lost pin still fails closed; only a first enrolment\'s crash reads as not enrolled', async () => {
  await withWorld(async (world) => {
    await enrolled(world);
    world.secrets.values.delete(ORGANIZATION_ISSUER_SECRET);
    const host = hostOf(world);
    assert.equal((await host.start()).state, 'failed-closed');
    setOrganizationWriteProbe((step) => { if (step === 'layer-written') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true }), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal(world.secrets.values.has(ORGANIZATION_ISSUER_SECRET), false, 'no pending pin is stored over a lost pin');

    const after = hostOf(world);
    assert.equal(failedOf(await after.start()).sentence, DAMAGED_PIN_TEXT, 'still failed closed, never the personal layer alone');
    assert.equal((await after.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true })).state, 'valid', 'the next confirmed enrolment repairs it');
    assert.equal(levelOf(after, 'org/Internal'), 'local-only');
  });
  await withWorld(async (world) => {
    // A pin that does not read is repaired the same way, and a crash during that keeps it failed closed too.
    await enrolled(world);
    await world.secrets.store(ORGANIZATION_ISSUER_SECRET, '{ "not": "a pin" }');
    const host = hostOf(world);
    assert.equal(failedOf(await host.start()).sentence, DAMAGED_PIN_TEXT);
    setOrganizationWriteProbe((step) => { if (step === 'layer-written') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true }), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal(failedOf(await hostOf(world).start()).sentence, DAMAGED_PIN_TEXT);
  });
});

test('CR-01, D-57: a first enrolment whose files cannot be taken back keeps its pending pin, so it reads as not enrolled rather than a lost pin', async () => {
  await withWorld(async (world) => {
    const host = hostOf(world);
    await host.start();
    const store = world.secrets.store.bind(world.secrets);
    let failCommit = false;
    world.secrets.store = async (key: string, value: string): Promise<void> => {
      if (failCommit && key === ORGANIZATION_ISSUER_SECRET && !value.includes('"pending"')) throw new Error('the secret store refused');
      await store(key, value);
    };
    setOrganizationWriteProbe(async (step) => {
      if (step !== 'layer-written') return;
      // The files cannot be removed (a read-only folder), and the commit of the pin fails.
      await chmod(organizationFolder(world), 0o500);
      failCommit = true;
    });
    try {
      await assert.rejects(host.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true }), (error: unknown) => {
        assert.ok(error instanceof OrganizationStoreError);
        assert.match(error.message, /^Nothing was changed/);
        return true;
      });
    } finally {
      setOrganizationWriteProbe(undefined);
      failCommit = false;
      await chmod(organizationFolder(world), 0o700);
    }
    const left = await readdir(organizationFolder(world));
    if (left.length > 0) assert.equal((pinOf(world)?.['pending'] as { kind?: string } | undefined)?.kind, 'enrol', 'files left behind keep the pending first enrolment');
    const after = hostOf(world);
    assert.equal((await after.start()).state, 'valid', 'never a lock-out');
    assert.equal(after.policyLayers().organization.state, 'none', 'not enrolled');
    assert.equal((await after.acceptOrganizationFile(enrolmentTextFor(issuerKey()), { wordsConfirmed: true })).state, 'valid', 'and enrolling again works');
    assert.equal(levelOf(after, 'org/Internal'), 'local-only');
  });
});

test('WR-01: the rules file and record missing from this computer are written again from the enrolment file in use, without moving the pin', async () => {
  await withWorld(async (world) => {
    await enrolled(world);
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    const enrolment = enrolmentTextFor(issuerKey());
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, enrolment, world.clock.now)).kind, 'same', 'intact files: nothing to do (allowed side)');
    await rm(layerFile(world));
    await rm(path.join(organizationFolder(world), ENROLMENT_RECORD_FILE));
    const host = hostOf(world);
    assert.equal(failedOf(await host.start()).reason, 'missing');

    assert.equal(String((await previewOrganizationFile(world.storage, world.secrets, enrolment, world.clock.now)).kind), 'repair');
    assert.equal((await host.acceptOrganizationFile(enrolment, {})).state, 'valid', 'no words: the file is the one the pin names');
    assert.equal(levelOf(host, 'org/Internal'), 'local-only');
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, 'the pin did not move');
    assert.equal(await exists(path.join(organizationFolder(world), ENROLMENT_RECORD_FILE)), true, 'the record is written again');
    assert.ok((await installOperations(host, world)).includes('policy.organization-updated'));

    const next = hostOf(world);
    assert.equal((await next.start()).state, 'valid', 'and at the next start');
    const view = next.policyLayers().organization;
    assert.equal(view.state === 'valid' ? view.name : undefined, EXAMPLE_ORGANIZATION.name);
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, enrolment, world.clock.now)).kind, 'same');
  });
});

test('WR-01: a rules file replaced by an older signed one is written again from the current rules file; the older one is still refused', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    const old = await readFile(layerFile(world), 'utf8');
    world.clock.now = FIXED_NOW + DAY_MS;
    const current = rulesTextFor(issuerKey(), sectionsWith('org/Public', 'attested-cloud'), { now: FIXED_NOW + DAY_MS });
    assert.equal((await host.acceptOrganizationFile(current, {})).state, 'valid');
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    await writeFile(layerFile(world), old);
    const next = hostOf(world);
    assert.equal(failedOf(await next.start()).reason, 'replaced');

    await assert.rejects(next.acceptOrganizationFile(old, {}), (error: unknown) => error instanceof OrganizationStoreError && error.reason === 'older', 'the older file is refused (refused side)');
    assert.equal(String((await previewOrganizationFile(world.storage, world.secrets, current, world.clock.now)).kind), 'repair');
    assert.equal((await next.acceptOrganizationFile(current, {})).state, 'valid');
    assert.equal(levelOf(next, 'org/Public'), 'attested-cloud');
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, 'the pin did not move');
    assert.equal((await hostOf(world).start()).state, 'valid', 'and at the next start');
  });
});

test('WR-01, D-57: an update that stops after the old layer is kept aside and before the new one is written leaves the old rules in force, never missing', async () => {
  await withWorld(async (world) => {
    const host = await enrolled(world);
    world.clock.now = FIXED_NOW + DAY_MS;
    const newer = rulesTextFor(issuerKey(), sectionsWith('org/Public', 'attested-cloud'), { now: FIXED_NOW + DAY_MS });
    setOrganizationWriteProbe((step, kind) => { if (String(step) === 'old-kept' && kind === 'update') throw new Error('the window closed'); });
    await assert.rejects(host.acceptOrganizationFile(newer, {}), /the window closed/);
    setOrganizationWriteProbe(undefined);
    assert.equal(await exists(layerFile(world)), true, 'the layer file is never missing');

    const next = hostOf(world);
    assert.equal((await next.start()).state, 'valid', 'the old rules, not failed closed as missing');
    assert.equal(levelOf(next, 'org/Internal'), 'local-only');
    assert.equal(levelOf(next, 'org/Public'), 'any-cloud', 'the update did not happen');
    assert.equal((await next.acceptOrganizationFile(newer, {})).state, 'valid', 'and can be given again');
    assert.equal(levelOf(next, 'org/Public'), 'attested-cloud');
    assert.equal(pinOf(world)?.['pending'], undefined);
  });
});

test('IN-01: a same-key enrolment update keeps the higher serial, so a handover made before it and abandoned is refused', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('serial-old');
    const fresh = issuerKey('serial-new');
    const host = hostOf(world);
    await host.start();
    assert.equal((await host.acceptOrganizationFile(enrolmentTextFor(old), { wordsConfirmed: true })).state, 'valid');
    world.clock.now = FIXED_NOW + DAY_MS;
    // Your organization made a handover (serial 2), abandoned it, and sent the old key's own enrolment file again (serial 3) with newer rules.
    const abandoned = rotationTextFor(old, fresh, { now: FIXED_NOW + DAY_MS, serial: 2 });
    const update = enrolmentTextFor(old, { now: FIXED_NOW + DAY_MS, serial: 3, sections: sectionsWith('org/Public', 'attested-cloud') });
    assert.equal((await host.acceptOrganizationFile(update, {})).state, 'valid');
    assert.equal(pinOf(world)?.['serial'], 3, 'the higher serial is kept');
    assert.equal(levelOf(host, 'org/Public'), 'attested-cloud');

    const preview = await previewOrganizationFile(world.storage, world.secrets, abandoned, world.clock.now);
    assert.equal(preview.kind === 'refused' ? preview.reason : preview.kind, 'older-file');
    await assert.rejects(host.acceptOrganizationFile(abandoned, { wordsConfirmed: true }), (error: unknown) => error instanceof OrganizationStoreError && error.reason === 'older-file');
    assert.equal(pinOf(world)?.['publicKey'], old.publicKey, 'the abandoned handover did not apply');

    // A handover made after the update (serial 4) is taken (allowed side).
    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    assert.equal((await host.acceptOrganizationFile(rotationTextFor(old, fresh, { now: FIXED_NOW + 2 * DAY_MS, serial: 4 }), { wordsConfirmed: true })).state, 'valid');
    assert.equal(pinOf(world)?.['publicKey'], fresh.publicKey);
    assert.equal(pinOf(world)?.['serial'], 4);
  });
});

// Phase 71 (D-12, 48.1 D-25): what sensitive data asks of a person is only ever tightened by your organization's updates.
function credentialsSectionRequiring(required: Record<string, string[]>): Record<string, unknown> {
  const scid = 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ';
  return {
    v: 1, root: { did: `did:webvh:${scid}:hq.example.org:org`, scid }, issuance: { ClearanceCredential: { role: 'IssuerRoleCredential' } },
    suites: ['eddsa-jcs-2022'], didMethods: ['did:webvh'], statusLists: [], statusTtl: 900, maxOfflineAge: {}, requiredBySensitivity: required
  };
}

test('D-12: an update that loosens the credentials required by sensitivity is refused with one sentence and the rules in force stay; one that adds is taken', async () => {
  await withWorld(async (world) => {
    const strict = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] }) });
    const host = await enrolled(world, { sections: strict });
    const bytes = await readFile(layerFile(world), 'utf8');
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    world.clock.now = FIXED_NOW + DAY_MS;
    const looser = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential'] }) });
    await assert.rejects(host.acceptOrganizationFile(rulesTextFor(issuerKey(), looser, { now: FIXED_NOW + DAY_MS }), {}), (error: unknown) => {
      assert.ok(error instanceof OrganizationStoreError);
      assert.equal(error.reason, 'credentials-loosened');
      assert.match(error.message, /^Nothing was changed\. .*security officer/);
      return true;
    });
    assert.equal(await readFile(layerFile(world), 'utf8'), bytes, 'the active layer stays');
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin);
    const dropped = organizationSections();
    await assert.rejects(host.acceptOrganizationFile(rulesTextFor(issuerKey(), dropped, { now: FIXED_NOW + DAY_MS }), {}), (error: unknown) => error instanceof OrganizationStoreError && error.reason === 'credentials-loosened');
    const stricter = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential', 'ServiceCredential'] }) });
    assert.equal((await host.acceptOrganizationFile(rulesTextFor(issuerKey(), stricter, { now: FIXED_NOW + DAY_MS }), {})).state, 'valid');
  });
});

test('D-12: a newer signed layer put on disk that loosens the requirements fails the whole policy closed at the next start; one that adds is taken', async () => {
  await withWorld(async (world) => {
    const strict = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] }) });
    await enrolled(world, { sections: strict });
    assert.deepEqual(pinOf(world)?.['requirements'], { 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] }, 'the pin keeps the requirements in force');
    const pin = world.secrets.values.get(ORGANIZATION_ISSUER_SECRET);
    world.clock.now = FIXED_NOW + DAY_MS;
    const looser = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential'] }) });
    await writeFile(layerFile(world), rulesTextFor(issuerKey(), looser, { now: FIXED_NOW + DAY_MS }));
    const next = hostOf(world);
    const failed = failedOf(await next.start());
    assert.equal(failed.reason, 'replaced');
    assert.match(failed.sentence, /security officer/);
    assert.equal(next.policyLayers().failedLayer, 'organization');
    assert.equal(world.secrets.values.get(ORGANIZATION_ISSUER_SECRET), pin, 'the pin did not move to the looser layer');

    world.clock.now = FIXED_NOW + 2 * DAY_MS;
    const stricter = organizationSections({ credentials: credentialsSectionRequiring({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential', 'ServiceCredential'] }) });
    await writeFile(layerFile(world), rulesTextFor(issuerKey(), stricter, { now: FIXED_NOW + 2 * DAY_MS }));
    const later = hostOf(world);
    assert.equal((await later.start()).state, 'valid');
    assert.deepEqual(pinOf(world)?.['requirements'], { 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential', 'ServiceCredential'] });
  });
});

test('a durable handover resumes only the protected exact signed enrollment and layer', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('bound-old');
    const fresh = issuerKey('bound-fresh');
    const store = new OrganizationStore(world.storage, world.secrets);
    await store.accept(enrolmentTextFor(old), { wordsConfirmed: true }, FIXED_NOW);
    const at = FIXED_NOW + DAY_MS;
    const layer = buildOrganizationLayer(fresh, organizationSections(), { now: at, days: 90 });
    const handover = (now: number) => JSON.stringify(buildEnrolment(fresh, {
      organization: EXAMPLE_ORGANIZATION, layer, now, days: 30, serial: 2, rotation: old
    }));
    const interrupted = handover(at);
    const sibling = handover(at + 1);
    setOrganizationWriteProbe((step, kind) => { if (step === 'layer-written' && kind === 'rotate') throw new Error('fixture interrupted'); });
    await assert.rejects(store.accept(interrupted, { wordsConfirmed: true }, at), /fixture interrupted/);
    setOrganizationWriteProbe(undefined);
    const pending = await world.secrets.get(ORGANIZATION_ISSUER_SECRET);
    const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
    const exactRecord = await readFile(record);
    const exactLayer = await readFile(layerFile(world));
    await writeFile(record, sibling);
    const reopened = new OrganizationStore(world.storage, world.secrets);
    assert.equal((await reopened.load(at + 2)).state, 'failed');
    assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), pending);
    assert.equal(await readFile(record, 'utf8'), sibling);
    assert.deepEqual(await readFile(layerFile(world)), exactLayer);

    await writeFile(record, exactRecord);
    setFolderSyncProbe(async (dir) => {
      if (dir === organizationFolder(world)) await writeFile(record, sibling);
    });
    try {
      assert.equal((await reopened.load(at + 2)).state, 'failed');
      assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), pending);
      assert.equal(await readFile(record, 'utf8'), sibling);
    } finally {
      setFolderSyncProbe(undefined);
    }

    await writeFile(record, exactRecord);
    const completed = await reopened.load(at + 2);
    assert.equal(completed.state, 'valid');
    const protectedPin = pinOf(world);
    assert.equal(protectedPin?.publicKey, fresh.publicKey);
    assert.ok(protectedPin?.acceptedHandover);
    assert.equal(protectedPin?.pending, undefined);
    assert.deepEqual(await readFile(record), exactRecord);
    assert.deepEqual(await readFile(layerFile(world)), exactLayer);
    const selected = await world.secrets.get(ORGANIZATION_ISSUER_SECRET);
    await rename(record, `${record}.fixture-kept`);
    assert.equal((await reopened.load(at + 2)).state, 'valid', 'the exact committed layer still supplies ordinary policy');
    await writeFile(record, 'malformed retained record');
    assert.equal((await reopened.load(at + 2)).state, 'valid');
    assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), selected);
  });
});

class AmbiguousRotationSecrets extends MemorySecrets {
  public fault: 'exact' | 'unavailable' | 'competing' | undefined;
  public commits = 0;
  public afterCommit?: () => Promise<void>;
  private unreadable = false;
  constructor(private readonly target: string) { super(); }
  override async get(key: string): Promise<string | undefined> {
    if (key === ORGANIZATION_ISSUER_SECRET && this.unreadable && this.fault === 'unavailable') throw new Error('fixture cannot read protected slot');
    return super.get(key);
  }
  override async store(key: string, value: string): Promise<void> {
    if (key !== ORGANIZATION_ISSUER_SECRET) return super.store(key, value);
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.publicKey !== this.target || parsed.pending !== undefined) return super.store(key, value);
    this.commits += 1;
    if (this.fault === 'competing') {
      const current = { ...parsed, lastIssuedAt: new Date(FIXED_NOW + DAY_MS + 5).toISOString() };
      await super.store(key, JSON.stringify(current));
    } else {
      await super.store(key, value);
    }
    await this.afterCommit?.();
    if (this.fault === 'unavailable') this.unreadable = true;
    if (this.fault !== undefined) throw new Error('fixture acknowledges neither outcome');
  }
}

test('the handover writer reconciles an exact commit and preserves unresolved or competing state', async () => {
  for (const fault of ['exact', 'unavailable', 'competing'] as const) {
    await withWorld(async (world) => {
      const old = issuerKey(`uncertain-old-${fault}`);
      const fresh = issuerKey(`uncertain-fresh-${fault}`);
      const secrets = new AmbiguousRotationSecrets(fresh.publicKey);
      const store = new OrganizationStore(world.storage, secrets);
      await store.accept(enrolmentTextFor(old), { wordsConfirmed: true }, FIXED_NOW);
      const at = FIXED_NOW + DAY_MS;
      const text = rotationTextFor(old, fresh, { now: at });
      const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
      secrets.fault = fault;
      if (fault === 'exact') {
        assert.equal((await store.accept(text, { wordsConfirmed: true }, at)).kind, 'rotate');
      } else {
        await assert.rejects(store.accept(text, { wordsConfirmed: true }, at), OrganizationStoreError);
      }
      assert.equal(secrets.commits, 1);
      assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), JSON.parse(text));
      assert.deepEqual(JSON.parse(await readFile(layerFile(world), 'utf8')), JSON.parse(text).payload.layer);
      const exact = secrets.values.get(ORGANIZATION_ISSUER_SECRET);
      assert.ok(exact);
      const actual = JSON.parse(exact) as Record<string, unknown>;
      assert.equal(actual.publicKey, fresh.publicKey);
      assert.equal((actual as { lastIssuedAt: string }).lastIssuedAt, new Date(at + (fault === 'competing' ? 5 : 0)).toISOString());
      secrets.fault = undefined;
      const reopened = new OrganizationStore(world.storage, secrets);
      assert.equal((await reopened.load(at + 10)).state, fault === 'competing' ? 'failed' : 'valid');
      assert.equal(secrets.commits, 1);
      assert.equal(await secrets.get(ORGANIZATION_ISSUER_SECRET), exact);
    });
  }
});

test('the exact confirmed pending handover can finish before either write or with either one file staged', async () => {
  for (const staged of ['neither', 'layer', 'record'] as const) {
    await withWorld(async (world) => {
      const old = issuerKey(`partial-old-${staged}`);
      const fresh = issuerKey(`partial-new-${staged}`);
      const store = new OrganizationStore(world.storage, world.secrets);
      const original = enrolmentTextFor(old);
      await store.accept(original, { wordsConfirmed: true }, FIXED_NOW);
      const at = FIXED_NOW + DAY_MS;
      const layer = buildOrganizationLayer(fresh, organizationSections(), { now: at, days: 90 });
      const handover = (now: number) => JSON.stringify(buildEnrolment(fresh, {
        organization: EXAMPLE_ORGANIZATION, layer, now, days: 30, serial: 2, rotation: old
      }));
      const exact = handover(at);
      const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
      setOrganizationWriteProbe((step, kind) => { if (step === 'pin-pending' && kind === 'rotate') throw new Error('fixture stopped before staging'); });
      await assert.rejects(store.accept(exact, { wordsConfirmed: true }, at), /fixture stopped before staging/);
      setOrganizationWriteProbe(undefined);
      const protectedPending = await world.secrets.get(ORGANIZATION_ISSUER_SECRET);
      if (staged === 'layer') await writeFile(layerFile(world), JSON.stringify(layer));
      if (staged === 'record') await writeFile(record, exact);
      const layerBefore = await readFile(layerFile(world));
      const recordBefore = await readFile(record);
      const reopened = new OrganizationStore(world.storage, world.secrets);
      const ordinary = await reopened.load(at + 1);
      if (staged === 'layer') assert.equal(ordinary.state, 'failed');
      else {
        assert.equal(ordinary.state, 'valid');
        if (ordinary.state === 'valid') assert.equal(ordinary.issuerPublicKey, old.publicKey);
      }
      await assert.rejects(reopened.accept(handover(at + 1), { wordsConfirmed: true }, at + 2), OrganizationStoreError);
      await assert.rejects(reopened.accept(original, {}, at + 2), OrganizationStoreError);
      const sameIssuerUpdate = rulesTextFor(old, sectionsWith('org/Public', 'local-only'), { now: at + 1 });
      await assert.rejects(reopened.accept(sameIssuerUpdate, {}, at + 2), OrganizationStoreError);
      assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), protectedPending);
      assert.deepEqual(await readFile(layerFile(world)), layerBefore);
      assert.deepEqual(await readFile(record), recordBefore);
      const accepted = await reopened.accept(exact, {}, at + 2);
      assert.equal(accepted.kind, 'rotate', 'the protected confirmation already covers this exact envelope');
      assert.equal(pinOf(world)?.publicKey, fresh.publicKey);
      assert.ok(pinOf(world)?.acceptedHandover);
      assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), JSON.parse(exact));
    });
  }
});

test('a confirmed retry refuses when the other staged slot was substituted', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('partial-conflict-old');
    const fresh = issuerKey('partial-conflict-new');
    const store = new OrganizationStore(world.storage, world.secrets);
    await store.accept(enrolmentTextFor(old), { wordsConfirmed: true }, FIXED_NOW);
    const at = FIXED_NOW + DAY_MS;
    const exact = rotationTextFor(old, fresh, { now: at });
    setOrganizationWriteProbe((step, kind) => { if (step === 'pin-pending' && kind === 'rotate') throw new Error('fixture stopped'); });
    await assert.rejects(store.accept(exact, { wordsConfirmed: true }, at), /fixture stopped/);
    setOrganizationWriteProbe(undefined);
    const pending = await world.secrets.get(ORGANIZATION_ISSUER_SECRET);
    const originalLayer = await readFile(layerFile(world));
    const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
    const unrelated = enrolmentTextFor(old, { serial: 9, now: at });
    await writeFile(record, unrelated);
    await assert.rejects(store.accept(exact, {}, at + 1), OrganizationStoreError);
    assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), pending);
    assert.deepEqual(await readFile(layerFile(world)), originalLayer);
    assert.equal(await readFile(record, 'utf8'), unrelated);
  });
});

test('exact attempted-transition readback requires both files even though ordinary committed policy does not', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('readback-old');
    const fresh = issuerKey('readback-new');
    const secrets = new AmbiguousRotationSecrets(fresh.publicKey);
    const store = new OrganizationStore(world.storage, secrets);
    await store.accept(enrolmentTextFor(old), { wordsConfirmed: true }, FIXED_NOW);
    const at = FIXED_NOW + DAY_MS;
    const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
    secrets.afterCommit = () => rename(record, `${record}.fixture-kept`);
    await assert.rejects(store.accept(rotationTextFor(old, fresh, { now: at }), { wordsConfirmed: true }, at), OrganizationStoreError);
    const selected = await secrets.get(ORGANIZATION_ISSUER_SECRET);
    assert.equal(JSON.parse(selected ?? '{}').publicKey, fresh.publicKey);
    assert.equal((await store.load(at + 1)).state, 'valid');
    assert.equal(await secrets.get(ORGANIZATION_ISSUER_SECRET), selected);
    assert.equal(secrets.commits, 1);
  });
});

test('a pending preview is read-only, checks exact current scope, and never authorizes an ordinary fallthrough', async () => {
  await withWorld(async (world) => {
    const old = issuerKey('preview-resume-old');
    const fresh = issuerKey('preview-resume-new');
    const store = new OrganizationStore(world.storage, world.secrets);
    const initial = enrolmentTextFor(old);
    await store.accept(initial, { wordsConfirmed: true }, FIXED_NOW);
    const oldPin = await world.secrets.get(ORGANIZATION_ISSUER_SECRET);
    assert.ok(oldPin);
    const at = FIXED_NOW + DAY_MS;
    const exact = rotationTextFor(old, fresh, { now: at, days: 1, layerDays: 4 });
    const now = at + 2 * DAY_MS;
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, exact, now)).kind, 'refused', 'an expired invitation alone grants nothing');
    setOrganizationWriteProbe((step, kind) => { if (step === 'pin-pending' && kind === 'rotate') throw new Error('fixture interrupted before staging'); });
    try {
      await assert.rejects(store.accept(exact, { wordsConfirmed: true }, at), /fixture interrupted before staging/);
    } finally {
      setOrganizationWriteProbe(undefined);
    }
    const layer = layerFile(world);
    await writeFile(layer, JSON.stringify(JSON.parse(exact).payload.layer));
    const record = path.join(organizationFolder(world), ENROLMENT_RECORD_FILE);
    const before = [await readFile(layer), await readFile(record)];
    const secretBefore = [...world.secrets.values.entries()];
    const preview = await previewOrganizationFile(world.storage, world.secrets, exact, now);
    assert.ok(preview.kind === 'resume');
    const resume = preview.expectedPending;
    assert.match(resume, /^[a-f0-9]{64}$/);
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, initial, now)).kind, 'refused');
    const sibling = buildEnrolment(fresh, {
      organization: EXAMPLE_ORGANIZATION, layer: JSON.parse(exact).payload.layer, now: at + 1, days: 1, serial: 2, rotation: old
    });
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, JSON.stringify(sibling), now)).kind, 'refused');
    assert.equal((await previewOrganizationFile(world.storage, world.secrets, exact, at + 5 * DAY_MS)).kind, 'refused');
    assert.deepEqual(await Promise.all([readFile(layer), readFile(record)]), before);
    assert.deepEqual([...world.secrets.values.entries()], secretBefore);

    const changed = pinOf(world) as { pending: { priorFiles: { layer: string } } };
    changed.pending.priorFiles.layer = 'a'.repeat(64);
    await world.secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify(changed));
    const intent = { wordsConfirmed: false, expectedPending: resume };
    await assert.rejects(store.accept(exact, intent, now), OrganizationStoreError);
    assert.deepEqual(await Promise.all([readFile(layer), readFile(record)]), before);

    await world.secrets.store(ORGANIZATION_ISSUER_SECRET, oldPin);
    const ordinary = rulesTextFor(old, sectionsWith('org/Public', 'local-only'), { now });
    await assert.rejects(store.accept(ordinary, intent, now), OrganizationStoreError);
    assert.equal(await world.secrets.get(ORGANIZATION_ISSUER_SECRET), oldPin);
    assert.deepEqual(await Promise.all([readFile(layer), readFile(record)]), before);
  });
});
