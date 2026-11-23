import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS } from '../domain/setup/records';
import { DEFAULT_ROUTING, decideRoute, type RouteFacts } from '../domain/gate/routing';
import { setProjectLabel } from '../domain/gate/labelMap';
import type { Label } from '../domain/gate/labels';
import { EXERCISE_REASON_TEXT } from '../domain/setup/landing';
import { REPLICA_PROJECT_FILE } from '../domain/staff/multiUser';
import { projectLogKey } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { SetupAuditLog } from '../gate/setupAuditLog';
import { createProjectLayerSource, readProjectLayer, readSetupGuide } from '../services/setup/projectStore';
import { singleMachineSink } from '../services/setup/projectLayerSink';
import { APPLY_TEXT, planApply, runApply, type ApplyContext, type ApplyDeps, type ApplyRunDeps, type ApplyStep } from '../services/setup/apply';
import { connectionStep } from '../services/setup/applyConnection';
import { labelStep, SIGN_LABEL_FILE_TEXT } from '../services/setup/applyLabel';
import { clearanceProposalFor } from '../services/setup/proposals';
import { remainingAfter, type ChangeItem } from '../domain/setup/changes';
import type { OrganizationProfile } from '../domain/auth';
import type { ViabilityResult } from '../domain/setup/viability';
import { MemorySecrets } from './helpers/teamHarness';

async function setup(preflight: ApplyRunDeps['preflight'] = async () => true) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-apply-'));
  const audit: unknown[] = [];
  const deps: ApplyRunDeps = {
    root,
    sink: singleMachineSink(root, { effective: () => undefined }),
    preflight,
    audit: { async append(event, body) { audit.push({ event, body }); return { ok: true, id: 'audit-record', seq: 1 }; } },
    record: {
      answers: { data: [] }, proposedLabel: null, use: 'T1', residency: { narrowed: false },
      viability: [], policy: {}, options: [], recommendation: { reasonId: 'fixture' }, choice: [], hostKind: 'desktop'
    },
    clock: () => Date.parse('2026-11-22T22:13:07.034Z')
  };
  return { audit, deps };
}

test('Apply checks viability and route before any mutation or audit write', async () => {
  const { audit, deps } = await setup(async () => false);
  const unavailable: ApplyStep = {
    changeId: 'label',
    async alreadyDone() { assert.fail('check only after preflight'); },
    async run() { assert.fail('do not mutate on stale preflight'); }
  };
  const result = await runApply([unavailable], deps);
  assert.equal(result.state, 'partly-applied');
  assert.equal(result.message, APPLY_TEXT.checkAgain);
  assert.deepEqual(result.steps.map(({ id, outcome }) => [id, outcome]), [['label', 'waiting']]);
  assert.deepEqual(audit, []);
  assert.equal(readSetupGuide(deps.root), undefined);
});

test('a refused preflight preserves every reviewed choice for a later retry', async () => {
  let ready = false;
  const { audit, deps } = await setup(async () => ready);
  const labelHost = await startLabelHost(deps.root);
  const items = [change('project-rules'), change('mode'), change('answers')];
  const context = applyContext(labelHost.labelPolicy().defaultLabel, { residency: { required: ['CA'] }, mode: 'corporate' });
  const inputs = { ...deps, labelHost };
  const refused = await runApply(planApply(items, context, inputs), inputs);
  assert.deepEqual(refused.steps.map(({ id, outcome }) => [id, outcome]), [
    ['project-rules', 'waiting'], ['mode', 'waiting'], ['answers', 'waiting']
  ]);
  assert.equal(readProjectLayer(deps.root).state, 'none');
  assert.deepEqual(audit, []);
  ready = true;
  const retry = remainingAfter(refused, items);
  assert.deepEqual(retry, items);
  assert.equal((await runApply(planApply(retry, context, inputs), inputs)).state, 'applied');
  assert.ok(readSetupGuide(deps.root));
  assert.equal(audit.length, 1);
});

test('Apply continues independent steps after failures and audits each outcome', async () => {
  const { audit, deps } = await setup();
  const finished: string[] = [];
  const steps: ApplyStep[] = [
    { changeId: 'label', async alreadyDone() { return false; }, async run() { throw new Error('private detail'); } },
    { changeId: 'connection:near-private', async alreadyDone() { return true; }, async run() { assert.fail('already selected'); } },
    { changeId: 'mode', async alreadyDone() { return false; }, async run() {
      finished.push('mode'); return { id: 'mode', outcome: 'done' };
    } }
  ];
  const result = await runApply(steps, deps);
  assert.deepEqual(finished, ['mode']);
  assert.equal(result.state, 'partly-applied');
  assert.deepEqual(result.steps.map(({ id, outcome }) => [id, outcome]), [
    ['label', 'failed'], ['connection:near-private', 'already-done'], ['mode', 'done']
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
  assert.equal(audit.length, 1);
  assert.match(JSON.stringify(audit[0]), /setup\.guide\.applied/);
});

test('Apply links a completed run to saved answers and its one audit record', async () => {
  const { audit, deps } = await setup();
  const answers = { v: 1 as const, answers: { data: [] }, chosen: [], pending: [] };
  const result = await runApply([{
    changeId: 'answers',
    async alreadyDone() { return false; },
    async run() {
      assert.equal((await deps.sink.write({ setupGuide: answers })).state, 'written');
      return { id: 'answers', outcome: 'done' };
    }
  }], deps);
  assert.equal(result.state, 'applied');
  assert.equal(readSetupGuide(deps.root)?.recordId, 'audit-record');
  assert.equal(readSetupGuide(deps.root)?.appliedAt, '2026-11-22T22:13:07.034Z');
  assert.equal(audit.length, 1);
});

const at = Date.parse('2026-11-22T22:13:07.034Z');
const profile: OrganizationProfile = {
  version: 1, profileId: 'profile-test', displayName: 'Test', organization: 'Test',
  provider: 'near-ai', baseUrl: 'https://models.test/v1', authMode: 'apiKey',
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), validation: { status: 'valid' }
};
const chosen: ViabilityResult = {
  optionId: 'near-private', kind: 'near-private', state: 'viable', models: [], hostKind: 'desktop',
  checkedAt: at, answeredAt: at, routeFacts: { clientRoute: 'near', host: profile.baseUrl }
};

function change(area: ChangeItem['area'], id: string = area): ChangeItem {
  return { id, area, group: 'changed', text: 'Apply the reviewed setting', effect: 'apply' };
}

function applyContext(label: Label, project: ApplyContext['project'] = {}): ApplyContext {
  return { project, label: { proposed: label, label: [`${label.scale}/${label.level}`], outcome: 'raise', reason: 'Fixture' } };
}

async function startLabelHost(root: string): Promise<GateHost> {
  const host = new GateHost({
    globalStorageDir: await mkdtemp(path.join(tmpdir(), 'near-ai-setup-apply-host-')),
    projectRoot: root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(at)
  });
  await host.start();
  return host;
}

test('Apply raises the signed label, selects a saved connection, records the mode and is idempotent', async () => {
  const { deps: base } = await setup();
  const root = base.root;
  const globalStorageDir = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-apply-install-'));
  const labelHost = new GateHost({ globalStorageDir, projectRoot: root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(at) });
  await labelHost.start();
  const registry = createAuditEventRegistry();
  for (const spec of GUIDE_AUDIT_EVENT_SPECS) registry.register(spec);
  const projectKey = projectLogKey(root);
  const audit = new SetupAuditLog({ globalStorageDir, projectRoot: root, projectKey, registry, clock: () => at, onWriteFailure: assert.fail });
  const policy = labelHost.labelPolicy();
  let active: OrganizationProfile | undefined;
  let selects = 0;
  const deps: ApplyDeps = {
    ...base, labelHost, audit,
    record: { ...base.record, choice: ['near-private'], viability: [chosen] },
    connection: connectionStep({
      root, chosen: [chosen], projectName: 'Test',
      profiles: {
        getActiveProfile: async () => active, list: async () => [profile],
        select: async (profileId) => {
          assert.equal(profileId, profile.profileId);
          selects++;
          active = profile;
          return { version: 1, projectId: 'project-test', profileId, selectedAt: profile.createdAt };
        },
        configure: async () => assert.fail('a saved connection needs no configuration')
      },
      configureConnection: async () => assert.fail('a saved connection needs no key')
    })
  };
  const proposal = { ...policy.defaultLabel, level: 'Internal' };
  const context: ApplyContext = {
    label: { proposed: proposal, label: ['org/Internal'], outcome: 'raise', reason: 'Fixture' },
    project: { mode: 'corporate' }
  };
  const items: readonly ChangeItem[] = [
    { id: 'answers', area: 'answers', group: 'changed', text: 'Save answers', effect: 'apply' },
    { id: 'mode', area: 'mode', group: 'changed', text: 'Set mode', effect: 'apply' },
    { id: 'connection:near-private', area: 'connection', group: 'added', text: 'Set connection', effect: 'apply' },
    { id: 'label', area: 'label', group: 'added', text: 'Raise label', effect: 'apply' }
  ];
  const run = () => runApply(planApply(items, context, deps), deps);
  const first = await run();
  assert.equal(first.state, 'applied');
  assert.deepEqual(first.steps.map(({ id }) => id), ['label', 'connection:near-private', 'mode', 'answers']);
  assert.equal(readSetupGuide(root)?.recordId, first.recordId);
  assert.deepEqual(readSetupGuide(root)?.chosen, ['near-private']);
  const layer = readProjectLayer(root, policy.scales);
  assert.equal(layer.state === 'valid' && layer.layer.mode, 'corporate');
  const view = await labelHost.labelsFor(root).view(policy.scales);
  assert.equal(view.state, 'verified');
  assert.equal(view.resolve('', policy.defaultLabel).mark[0].level, 'Internal');
  const labelFile = path.join(root, '.planning/.near-ai/labels.json');
  const before = await readFile(labelFile, 'utf8');
  const second = await run();
  assert.equal(second.state, 'applied');
  assert.deepEqual(second.steps.map(({ outcome }) => outcome), Array(4).fill('already-done'));
  assert.equal(selects, 1);
  assert.equal(await readFile(labelFile, 'utf8'), before);
  const verdict = await audit.verify();
  assert.equal(verdict.ok && verdict.head?.seq, 2);
});

test('Apply cannot sign a label beyond the person’s current clearance', async () => {
  const { deps } = await setup();
  const host = new GateHost({
    globalStorageDir: await mkdtemp(path.join(tmpdir(), 'near-ai-setup-apply-clearance-')),
    projectRoot: deps.root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(at)
  });
  await host.start();
  const label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] };
  const step = labelStep({
    host, root: deps.root, clock: () => at,
    proposal: { proposed: label, label: ['ca-protected/Protected B'], outcome: 'raise', reason: 'Fixture' }
  });
  const report = await runApply([step], deps);
  assert.equal(report.steps[0]?.outcome, 'waiting');
  assert.equal((await host.labelsFor(deps.root).view(host.labelPolicy().scales)).state, 'none');
});

test('a project that became shared waits for project-local changes and can still select its connection', async () => {
  const { deps: base } = await setup();
  const root = base.root;
  const file = path.join(root, REPLICA_PROJECT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}');
  const labelHost = new GateHost({
    globalStorageDir: await mkdtemp(path.join(tmpdir(), 'near-ai-setup-apply-shared-')),
    projectRoot: root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(at)
  });
  await labelHost.start();
  const deps: ApplyDeps = {
    ...base,
    labelHost,
    connection: { changeId: 'connection:near-private', alreadyDone: async () => false,
      run: async () => ({ id: 'connection:near-private', outcome: 'done' }) }
  };
  const label = { ...labelHost.labelPolicy().defaultLabel, level: 'Internal' };
  const items: readonly ChangeItem[] = [
    { id: 'label', area: 'label', group: 'added', text: 'Raise label', effect: 'apply' },
    { id: 'connection:near-private', area: 'connection', group: 'added', text: 'Set connection', effect: 'apply' },
    { id: 'mode', area: 'mode', group: 'changed', text: 'Set mode', effect: 'apply' },
    { id: 'answers', area: 'answers', group: 'changed', text: 'Record answers', effect: 'apply' }
  ];
  const report = await runApply(planApply(items, {
    label: { proposed: label, label: ['org/Internal'], outcome: 'raise', reason: 'Fixture' },
    project: { mode: 'corporate' }
  }, deps), deps);
  assert.deepEqual(report.steps.map(({ outcome }) => outcome), ['waiting', 'done', 'waiting', 'waiting']);
  assert.equal(readSetupGuide(root), undefined);
  assert.equal(readProjectLayer(root).state, 'none');
  assert.equal((await labelHost.labelsFor(root).view(labelHost.labelPolicy().scales)).state, 'none');
});

test('Apply creates a matching keyless local profile through the profile store', async () => {
  const { deps } = await setup();
  const baseUrl = 'http://127.0.0.1:11434/v1';
  const local: ViabilityResult = { ...chosen, optionId: 'this-computer', kind: 'this-computer',
    routeFacts: { clientRoute: 'local', host: baseUrl } };
  const step = connectionStep({
    root: deps.root, chosen: [local], projectName: 'Test',
    configureConnection: async () => assert.fail('a new local profile needs no key flow'),
    profiles: {
      getActiveProfile: async () => undefined,
      list: async () => [],
      select: async () => assert.fail('configures the new profile instead of selecting a saved profile'),
      configure: async (input, key) => {
        assert.equal(key, '');
        assert.equal(input.baseUrl, baseUrl);
        assert.equal(input.provider, 'local');
        return { ...profile, ...input, provider: 'local' };
      }
    }
  });
  assert.equal((await runApply([step], deps)).steps[0]?.outcome, 'done');
});

test('the Canada rule is enforced by the existing GateHost route for the project after Apply', async () => {
  const { deps } = await setup();
  const root = deps.root;
  const labelHost = await startLabelHost(root);
  const { defaultLabel, scales } = labelHost.labelPolicy();
  const source = createProjectLayerSource({ readFileSync, statSync, scales: () => scales, now: () => at });
  const useSource = labelHost.useProjectLayerSource(source.read);
  const runtime = await labelHost.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'example' }, presence: 'person', context: 'interactive' });
  const near: RouteFacts = {
    clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true,
    model: { id: 'example/private', privacyBoundary: 'tee' }, attestationFailed: false, now: at
  };
  const route = (facts: RouteFacts) => decideRoute([], DEFAULT_ROUTING, facts, defaultLabel, undefined, runtime.routePolicy?.(at));
  assert.equal(route(near).allowed, true);
  const input: ApplyDeps = { ...deps, labelHost, sink: singleMachineSink(root, { effective: () => labelHost.policyLayers().effective, source }) };
  const context = applyContext(defaultLabel, { residency: { required: ['CA'] } });
  assert.equal((await runApply(planApply([change('project-rules')], context, input), input)).state, 'applied');
  assert.deepEqual(runtime.routePolicy?.(at)?.residency?.required, ['CA']);
  assert.equal(route(near).rule, 'route.residency');
  assert.equal(route({
    ...near, clientRoute: 'local', host: 'http://127.0.0.1:11434/v1', nearEndpoint: false,
    model: { id: 'example/local', privacyBoundary: 'local' }
  }).allowed, true);
  useSource.dispose();
});

test('staff exercise and mode are saved together and each has its own audit outcome', async () => {
  const { audit, deps } = await setup();
  const root = deps.root;
  const labelHost = await startLabelHost(root);
  const { defaultLabel, scales } = labelHost.labelPolicy();
  const sink = singleMachineSink(root, { effective: () => labelHost.policyLayers().effective });
  let writes = 0;
  const input: ApplyDeps = {
    ...deps, labelHost,
    record: { ...deps.record, answers: { kindOfWork: 'staff', data: [] } },
    sink: { ...sink, async write(next) { writes++; return sink.write(next); } }
  };
  const exercise = { reason: EXERCISE_REASON_TEXT, setAt: new Date(at).toISOString() };
  const context = applyContext(defaultLabel, { exercise, mode: 'military' });
  const result = await runApply(planApply([change('exercise'), change('mode')], context, input), input);
  assert.equal(result.state, 'applied');
  assert.equal(writes, 1);
  const read = readProjectLayer(root, scales);
  assert.ok(read.state === 'valid');
  assert.equal(read.layer.mode, 'military');
  assert.deepEqual(read.layer.exercise, exercise);
  assert.deepEqual(result.steps.map(({ id, outcome }) => [id, outcome]), [['mode', 'done'], ['exercise', 'done']]);
  assert.match(JSON.stringify(audit[0]), /"changes":\[\{"id":"mode","outcome":"done"\},\{"id":"exercise","outcome":"done"\}\]/);
});

test('Apply refuses an invalid label map without signing it and still saves independent settings', async () => {
  const { deps } = await setup();
  const root = deps.root;
  const labelHost = await startLabelHost(root);
  const { defaultLabel, scales } = labelHost.labelPolicy();
  await labelHost.changeLabels(root, (map) => setProjectLabel(map, defaultLabel));
  const file = path.join(root, '.planning/.near-ai/labels.json');
  const original = await readFile(file, 'utf8');
  const changed = original.replace(/("level"\s*:\s*")Public"/, '$1Internal"');
  assert.notEqual(changed, original);
  await writeFile(file, changed);
  labelHost.labelsFor(root).invalidate();
  assert.notEqual((await labelHost.labelsFor(root).view(scales)).state, 'verified');
  const input: ApplyDeps = { ...deps, labelHost };
  const context = applyContext({ ...defaultLabel, level: 'Internal' }, { mode: 'corporate' });
  const result = await runApply(planApply([change('label'), change('mode')], context, input), input);
  assert.equal(result.state, 'partly-applied');
  assert.deepEqual(result.steps[0], { id: 'label', outcome: 'failed', message: SIGN_LABEL_FILE_TEXT });
  assert.equal(result.steps[1]?.outcome, 'done');
  assert.equal(await readFile(file, 'utf8'), changed);
});

test('a connection requiring a key delegates to the existing flow and rechecks what it selected', async () => {
  const { deps } = await setup();
  const localBaseUrl = 'http://127.0.0.1:11434/v1';
  const local: ViabilityResult = { ...chosen, optionId: 'this-computer', kind: 'this-computer',
    routeFacts: { clientRoute: 'local', host: localBaseUrl } };
  let active = profile;
  let accepted = false;
  let prompts = 0;
  const step = connectionStep({
    root: deps.root, chosen: [chosen, local], projectName: 'Test',
    profiles: {
      getActiveProfile: async () => active, list: async () => [active],
      select: async () => assert.fail('no saved hybrid profile exists'),
      configure: async () => assert.fail('the guide must hand key entry to the existing flow')
    },
    async configureConnection(reviewed) {
      assert.deepEqual(reviewed, { provider: 'hybrid', nearBaseUrl: chosen.routeFacts?.host, localBaseUrl });
      prompts++;
      if (accepted) active = { ...profile, provider: 'hybrid', localBaseUrl };
      return accepted;
    }
  });
  assert.equal((await runApply([step], deps)).steps[0]?.outcome, 'waiting');
  accepted = true;
  assert.equal((await runApply([step], deps)).steps[0]?.outcome, 'done');
  assert.equal((await runApply([step], deps)).steps[0]?.outcome, 'already-done');
  assert.equal(prompts, 2);
});

test('after a clearance is applied in the rules, retry writes only the remaining signed label', async () => {
  const { deps, audit } = await setup();
  const root = deps.root;
  const labelHost = await startLabelHost(root);
  const { defaultLabel } = labelHost.labelPolicy();
  const protectedB: Label = { ...defaultLabel, scale: 'ca-protected', level: 'Protected B' };
  const items = [change('label'), change('mode'), change('answers')];
  const input: ApplyDeps = { ...deps, labelHost };
  const context = applyContext(protectedB, { mode: 'corporate' });
  const first = await runApply(planApply(items, context, input), input);
  assert.equal(first.state, 'partly-applied');
  assert.deepEqual(first.steps.map(({ outcome }) => outcome), ['waiting', 'done', 'done']);
  assert.deepEqual(readSetupGuide(root)?.pending, ['label']);
  const proposal = clearanceProposalFor(protectedB, false);
  const personal = labelHost.policyLayers().personal;
  assert.ok(proposal && personal);
  // Simulate the separate policy editor approval using the same host boundary.
  const signed = await labelHost.applyPolicyDraft(JSON.stringify(proposal.next(personal.document)), personal.hash);
  assert.equal(signed.state.state, 'valid');
  const retry = remainingAfter(first, items);
  assert.deepEqual(retry.map(({ id }) => id), ['label']);
  const final = await runApply(planApply(retry, context, input), input);
  assert.equal(final.state, 'applied');
  assert.deepEqual(final.steps, [{ id: 'label', outcome: 'done' }]);
  const policy = labelHost.labelPolicy();
  assert.equal((await labelHost.labelsFor(root).view(policy.scales)).resolve('', policy.defaultLabel).mark[0].level, 'Protected B');
  assert.deepEqual(readSetupGuide(root)?.pending, []);
  assert.equal(audit.length, 2);
});

test('a stopped classified setup can raise an approved label without opening a connection', async () => {
  const { deps } = await setup();
  const root = deps.root;
  const labelHost = await startLabelHost(root);
  const { defaultLabel } = labelHost.labelPolicy();
  const label: Label = { ...defaultLabel, scale: 'ca-classified', level: 'Secret' };
  const proposal = clearanceProposalFor(label, false);
  const personal = labelHost.policyLayers().personal;
  assert.ok(proposal && personal);
  const signed = await labelHost.applyPolicyDraft(JSON.stringify(proposal.next(personal.document)), personal.hash);
  assert.equal(signed.state.state, 'valid');
  const input: ApplyDeps = {
    ...deps, labelHost, record: { ...deps.record, answers: { data: ['classified'] }, proposedLabel: label },
    connection: { changeId: 'connection:near-private', alreadyDone: async () => assert.fail('stopped choices have no connection'),
      run: async () => assert.fail('stopped choices never configure a connection') }
  };
  const result = await runApply(planApply([change('label')], applyContext(label), input), input);
  assert.equal(result.state, 'applied');
  assert.deepEqual(result.steps, [{ id: 'label', outcome: 'done' }]);
  const policy = labelHost.labelPolicy();
  assert.equal((await labelHost.labelsFor(root).view(policy.scales)).resolve('', policy.defaultLabel).mark[0].level, 'Secret');
});
