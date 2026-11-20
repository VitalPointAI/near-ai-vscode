// Your organization's rules on this computer (Phase 41, FND-01, FND-02, D-12 to D-15, D-18 to D-21, D-27, D-57): the pin in SecretStorage, the layer
// under gate/organization/, the layered load every decision reads, and the host's accept, Apply and Reset. Real files in temp folders and in-memory
// secret stores; every key is made at test time from a label (policyFixtures). Fictional names only. The host tests live here: there is no gateHost file.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import { labelKeyShown } from '../domain/gate/labelAlgebra';
import { signPayload } from '../domain/team/signedPayload';
import { writeLastValid } from '../gate/clockMarker';
import { buildOrganizationLayer, contactShown, fileTextOf, organizationEndedText } from '../domain/gate/enrolment';
import { GATE_DIR_NAME, POLICY_BUNDLE_FILE, gateDir } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import {
  ENROLMENT_RECORD_FILE, NOT_ENROLLED_TEXT, ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, ORGANIZATION_LAYER_FILE, OrganizationStoreError, migrationNoticeText,
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

test('D-13: a pending pin with no layer file is not enrolled; a layer file with no pin is ignored', async () => {
  await withWorld(async (world) => {
    const pending = { kind: 'enrol', publicKey: issuerKey().publicKey, serial: 1, issuedAt: new Date(FIXED_NOW).toISOString(), layerHash: 'a'.repeat(64) };
    await world.secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify({ v: 1, pending }));
    const host = hostOf(world);
    assert.equal((await host.start()).state, 'valid');
    assert.equal(host.policyLayers().organization.state, 'none');
    assert.notEqual(levelOf(host, 'org/Internal'), 'local-only');
  });
  await withWorld(async (world) => {
    // This computer has its own policy; then a rules file appears with no pin (a disk writer, or a first enrolment that never committed).
    assert.equal((await hostOf(world).start()).state, 'valid');
    await mkdir(organizationFolder(world), { recursive: true });
    const text = rulesTextFor(issuerKey(), sectionsWith('org/Public', 'local-only'));
    await writeFile(layerFile(world), text);
    const host = hostOf(world);
    assert.equal((await host.start()).state, 'valid');
    assert.equal(host.policyLayers().organization.state, 'none', 'a layer with no pin is ignored');
    assert.equal(levelOf(host, 'org/Public'), 'any-cloud');
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
