import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT, type Label } from '../domain/gate/labels';
import { clearanceKey } from '../domain/gate/bundle';
import { parsePeopleSection } from '../domain/org/peopleSection';
import { remainingAfter, type ChangeItem } from '../domain/setup/changes';
import { gateDir, POLICY_BUNDLE_FILE } from '../gate/bundleStore';
import { GateHost } from '../gate/host';
import type { PolicyChange } from '../services/policyEditor';
import { planApply, runApply, type ApplyDeps } from '../services/setup/apply';
import { singleMachineSink } from '../services/setup/projectLayerSink';
import { clearanceProposalFor, proposalStep, type PendingProposal } from '../services/setup/proposals';
import { enrolmentTextFor } from './helpers/enrolmentFixtures';
import { autoApplyPolicyEditor, recordingPolicyEditor, type FakePolicyEditor } from './helpers/policyEditorFake';
import { issuerKey } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const { registerGate } = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(uninstall);

const now = Date.parse('2026-11-22T22:13:07.034Z');
const pin = 'a'.repeat(64);
const protectedB: Label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] };
const approval: ChangeItem = { id: 'your-rules:server-approval', group: 'added', area: 'your-rules', text: 'Add the selected server', effect: 'proposal' };

function endpointApproval(target: PolicyChange['target'] = 'personal'): PendingProposal {
  return {
    id: 'server-approval', kind: 'endpoint-approval',
    detail: { endpointId: 'found-ollama', serverKind: 'ollama', pin },
    change: {
      from: 'Get Started', target, next: (current) => ({
        ...current,
        endpoints: [...(current.endpoints ?? []), {
          id: 'found-ollama', class: 'org-plain', host: 'found.example.test', scheme: 'https', region: 'CA',
          maxLabel: ['org/Public'], tlsPins: [pin], provider: 'ollama'
        }]
      })
    }
  };
}

async function fixture(editor: FakePolicyEditor) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-proposals-project-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-setup-proposals-storage-'));
  const secrets = new MemorySecrets();
  const host = registerGate(createFakeContext(storage, secrets) as never, { policyEditor: editor, notify: () => undefined, now: () => new Date(now) });
  await host.start();
  const audit: { event: string; body: unknown }[] = [];
  const deps: ApplyDeps = {
    root, labelHost: host,
    sink: singleMachineSink(root, { effective: () => host.policyLayers().effective }),
    audit: { async append(event, body) { audit.push({ event, body }); return { ok: true, id: 'audit-record', seq: audit.length }; } },
    record: { answers: { data: [] }, proposedLabel: null, use: 'T1', residency: { narrowed: false }, viability: [], policy: {},
      options: [], recommendation: { reasonId: 'fixture' }, choice: [], hostKind: 'desktop' },
    preflight: async () => true, clock: () => now
  };
  return { host, audit, deps, storage, secrets };
}

test('a discarded endpoint proposal stays pending and changes no policy or effective endpoints', async () => {
  const editor = recordingPolicyEditor();
  const { host, audit, deps } = await fixture(editor);
  const before = host.policyLayers();
  const proposal = endpointApproval();
  const result = await runApply(planApply([approval], {
    label: { proposed: protectedB, label: ['ca-protected/Protected B'], outcome: 'raise', reason: 'Fixture' },
    project: {}, proposals: [proposal]
  }, { ...deps, policyEditor: editor }), deps);
  assert.equal(result.state, 'partly-applied');
  assert.equal(result.steps[0]?.outcome, 'proposal-opened');
  assert.equal(result.steps[0]?.proposalOutcome, 'discarded');
  assert.deepEqual(remainingAfter(result, [approval]), [approval]);
  assert.equal(editor.proposed[0], proposal.change);
  assert.equal(host.policyLayers().personal?.hash, before.personal?.hash);
  assert.deepEqual(host.policyLayers().effective?.endpoints, before.effective?.endpoints);
  assert.deepEqual(audit[0], { event: 'setup.discovery.approved-proposal',
    body: { endpointId: 'found-ollama', serverKind: 'ollama', pin, proposalId: 'server-approval', outcome: 'discarded' } });
  assert.match(JSON.stringify(audit[1]), /"proposalOutcome":"discarded"/);
});

test('a person can apply a valid proposal through the existing editor', async () => {
  const editor = autoApplyPolicyEditor();
  const { host, audit, deps } = await fixture(editor);
  const before = host.policyLayers().personal?.hash;
  const result = await runApply([proposalStep({ port: editor, proposal: endpointApproval(), audit: deps.audit })], deps);
  assert.equal(result.state, 'applied', JSON.stringify(editor.refusals));
  assert.equal(result.steps[0]?.outcome, 'proposal-opened');
  assert.equal(result.steps[0]?.proposalOutcome, 'applied');
  assert.notEqual(host.policyLayers().personal?.hash, before);
  assert.ok(host.policyLayers().effective?.endpoints?.some(({ id }) => id === 'found-ollama'));
  assert.deepEqual(audit[0], { event: 'setup.discovery.approved-proposal',
    body: { endpointId: 'found-ollama', serverKind: 'ollama', pin, proposalId: 'server-approval', outcome: 'applied' } });
});

test('the clearance proposal is self-declared, additive and idempotent', async () => {
  const { host } = await fixture(recordingPolicyEditor());
  const original = host.policyLayers().personal?.document;
  assert.ok(original);
  const change = clearanceProposalFor(protectedB, false);
  assert.ok(change);
  assert.equal(change.target, 'personal');
  assert.equal(change.requiresPersonalAuthority, true);
  assert.ok(change.reason?.endsWith(CLEARANCE_SELF_ASSERTED_TEXT));
  const snapshot = JSON.stringify(original);
  const next = change.next(original);
  const clearances = next.people?.clearances ?? [];
  assert.ok(clearances.some(({ scale, level }) => scale === protectedB.scale && level === protectedB.level));
  assert.deepEqual(clearances.map(clearanceKey), [...clearances.map(clearanceKey)].sort());
  assert.equal(parsePeopleSection(next.people, next.labels.scales).ok, true);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(next.labels, original.labels);
  assert.equal(next.endpoints, original.endpoints);
  assert.deepEqual(change.next(next), next);
});

test('the guide does not propose a personal clearance under an organization policy', () => {
  assert.equal(clearanceProposalFor(protectedB, true), undefined);
});

test('the existing editor can save a self-declared clearance while the device is unenrolled', async () => {
  const editor = autoApplyPolicyEditor();
  const { host } = await fixture(editor);
  const change = clearanceProposalFor(protectedB, false);
  assert.ok(change);
  assert.equal(await editor.propose(change), 'applied', JSON.stringify(editor.refusals));
  assert.ok(host.policyLayers().personal?.document.people?.clearances?.some(
    ({ scale, level }) => scale === protectedB.scale && level === protectedB.level
  ));
});

test('the saved clearance is refused when another window enrolls after the proposal is shown', async () => {
  const editor = recordingPolicyEditor();
  const { host, storage, secrets } = await fixture(editor);
  const before = editor.deps().state();
  const change = clearanceProposalFor(protectedB, false);
  assert.ok(before && change);
  const bundle = path.join(gateDir(storage), POLICY_BUNDLE_FILE);
  const original = await readFile(bundle);
  const otherWindow = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.4.36', now: () => new Date(now) });
  const enrolled = await otherWindow.acceptOrganizationFile(enrolmentTextFor(issuerKey(), { now }), { wordsConfirmed: true });
  assert.equal(enrolled.state, 'valid');
  assert.equal(host.policyLayers().organization.state, 'none', 'the first window still has its own cached state');

  const answer = await editor.deps().applyPersonal(change.next(before.personal), before.personalHash, change.requiresPersonalAuthority);
  assert.ok(!answer.ok && answer.authorityUnavailable);
  assert.deepEqual(await readFile(bundle), original);
});

test('an exported organization proposal preserves its target without changing the local policy', async () => {
  const editor = recordingPolicyEditor('exported');
  const { host, audit, deps } = await fixture(editor);
  const before = host.policyLayers().personal?.hash;
  const result = await runApply([proposalStep({ port: editor, proposal: endpointApproval('organization'), audit: deps.audit })], deps);
  assert.equal(editor.proposed[0]?.target, 'organization');
  assert.equal(host.policyLayers().personal?.hash, before);
  assert.equal(result.state, 'partly-applied');
  assert.equal(result.steps[0]?.proposalOutcome, 'exported');
  assert.match(JSON.stringify(audit[0]), /"outcome":"exported"/);
});

test('a replaced proposal does not report a change as applied', async () => {
  const editor = recordingPolicyEditor('replaced');
  const { deps } = await fixture(editor);
  const result = await runApply([proposalStep({ port: editor, proposal: endpointApproval(), audit: deps.audit })], deps);
  assert.equal(result.state, 'partly-applied');
  assert.equal(result.steps[0]?.proposalOutcome, 'replaced');
});

test('Apply waits for the editor to settle before recording the proposal decision', async () => {
  const { audit, deps } = await fixture(recordingPolicyEditor());
  let opened!: () => void;
  let discard!: (outcome: 'discarded') => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const decision = new Promise<'discarded'>((resolve) => { discard = resolve; });
  const apply = runApply([proposalStep({
    port: { propose: () => { opened(); return decision; } },
    proposal: endpointApproval(), audit: deps.audit
  })], deps);
  await ready;
  assert.equal(audit.length, 0);
  discard('discarded');
  assert.equal((await apply).steps[0]?.proposalOutcome, 'discarded');
  assert.equal(audit.length, 2);
});
