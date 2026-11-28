// The policy editor's "Exceptions for chat you review" section (74.1-11 Task 2, D-20, 74.1-UI-SPEC S11), driven as VS Code drives it: a stand-in panel and
// save dialog. Under your organization's rules a named person drafts, reviews, signs and saves a request; nothing changes locally and no policy edit is
// recorded. With no organization layer there is no draft, whatever the page asks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAuthorization } from '../domain/gate/authorizations';
import type { AuthorizationBody } from '../domain/gate/authorizations';
import { bundleHash } from '../domain/gate/bundle';
import { authorizationRecord, passportStep } from '../domain/gate/passportStep';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { ProposalPayload } from '../domain/gate/proposal';
import { trustLine } from '../domain/gate/trust';
import type { TrustFacts } from '../domain/gate/trust';
import { verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import { activeKeys, deviceKey, fullDocumentFor, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

type Message = Record<string, any>;
type EditorModule = typeof import('../services/policyEditor');

const NOW = Date.parse('2026-11-25T15:00:00.000Z');
const PROJECT = { id: 'project-harrow', name: 'Harrow Ridge' };
const PERSON = { name: 'Avery Chen', role: 'Director, Intelligence' };

interface EditorState { personal: PolicyDocument; personalHash: string; organization?: PolicyDocument; organizationHash?: string; organizationIssuer?: string; organizationSignedHere: boolean; effective: PolicyDocument }

function organizationState(key: PayloadSigner, extra: (doc: Record<string, any>) => void = () => undefined): EditorState {
  const plain = fullDocumentFor(issuerKey()) as Record<string, any>;
  plain['people'].signers = [...plain['people'].signers, { ...PERSON, publicKey: key.publicKey, fingerprint: key.fingerprint }].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  extra(plain);
  const parsed = parsePolicyDocument(plain);
  assert.ok(parsed.ok, `the organization fixture parses: ${parsed.ok ? '' : parsed.message}`);
  const organization = parsed.value;
  const personal = policyDocumentFor({ key });
  return { personal, personalHash: bundleHash(personal), organization, organizationHash: bundleHash(organization), organizationIssuer: issuerKey().fingerprint, organizationSignedHere: false, effective: organization };
}

function ownState(key: PayloadSigner): EditorState {
  const personal = policyDocumentFor({ key });
  return { personal, personalHash: bundleHash(personal), organizationSignedHere: false, effective: personal };
}

function harness(state: EditorState, signer: PayloadSigner | undefined, projects = [PROJECT]) {
  const posted: Message[] = [];
  const handlers: { message?: (value: unknown) => unknown; dispose?: () => void } = {};
  const saveAnswers: Array<{ fsPath: string } | undefined> = [];
  const writes: Array<{ path: string; text: string }> = [];
  const records: string[] = [];
  const applied: unknown[] = [];
  const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });
  const panel = {
    visible: true, iconPath: undefined as unknown,
    webview: {
      html: '', cspSource: 'vscode-resource:', asWebviewUri: (value: unknown) => value,
      postMessage: async (message: Message) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: (value: unknown) => unknown) => { handlers.message = handler; return { dispose: () => undefined }; }
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    onDidDispose: (handler: () => void) => { handlers.dispose = handler; return { dispose: () => undefined }; },
    reveal: () => undefined,
    dispose: () => { handlers.dispose?.(); }
  };
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')), file: (value: string) => uri(value) },
    ViewColumn: { Active: -1 },
    window: { createWebviewPanel: () => panel, showSaveDialog: async () => saveAnswers.shift() },
    workspace: { workspaceFolders: undefined, fs: { writeFile: async (target: { fsPath: string }, bytes: Uint8Array) => { writes.push({ path: target.fsPath, text: Buffer.from(bytes).toString('utf8') }); } } }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  for (const name of ['../services/policyEditor', '../services/policyExceptions', '../services/webview/openPanel', '../services/layoutProbe']) delete require.cache[require.resolve(name)];
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let editor: EditorModule;
  try {
    editor = require('../services/policyEditor') as EditorModule;
  } finally {
    nodeModule._load = originalLoad;
  }
  editor.registerPolicyEditor({ extensionUri: uri('/extension') } as never, {
    state: () => state, directionOf: () => undefined,
    applyPersonal: async (next) => { applied.push(next); return { ok: true }; },
    signer: () => signer, reset: async () => undefined, showStored: async () => undefined,
    record: (id) => { records.push(id); }, onDidChange: () => ({ dispose: () => undefined }),
    exceptions: { projects: () => projects, now: () => NOW }
  });
  editor.openPolicyEditor();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const view = (): Message => {
    const states = posted.filter((message) => message.type === 'state');
    return (states[states.length - 1] as Message).exceptions as Message;
  };
  return {
    editor, posted, saveAnswers, writes, records, applied, view,
    send: async (message: unknown) => { await handlers.message?.(message); await settle(); },
    ready: async () => { await handlers.message?.({ type: 'ready' }); await settle(); }
  };
}

const GOOD_FIELDS = {
  projects: [PROJECT.id], labels: ['org/Internal'], conditions: ['A person reviews every answer', 'No tools', 'A model of another family checks the answers'],
  benefit: 'Reads Chinese technical papers for the J2 cell.', person: { name: PERSON.name, position: PERSON.role }, endsOn: '2026-12-25'
};

test('D-20: with no organization layer the section says exceptions need your organization\'s rules, offers nothing, and refuses a crafted draft', async () => {
  const h = harness(ownState(deviceKey()), deviceKey());
  await h.ready();
  const view = h.view();
  assert.equal(view.noOrg, 'Exceptions need your organization\'s rules. This computer has none, so no exception can be drafted, and nothing signed on this computer allows a model. Models approved for research only stay in the research workspace.');
  assert.equal(view.research, undefined);
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  assert.equal(h.view().draft, undefined);
  assert.equal(h.view().noOrg !== undefined, true);
});

test('D-20: under your organization\'s rules a research-only model offers Ask, and the draft opens with the legal flags first and today plus 30 days', async () => {
  const key = deviceKey();
  const h = harness(organizationState(key), key);
  await h.ready();
  const research = h.view().research as Array<{ id: string; text: string }>;
  assert.ok(research.some((row) => row.id === 'z-ai/glm' && row.text === 'z-ai/glm · China · Research only'));
  assert.ok(!research.some((row) => row.id === 'openai/gpt-oss'), 'a model approved above research needs no exception');
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  const draft = h.view().draft;
  assert.equal(draft.title, 'Ask to allow z-ai/glm for chat you review');
  assert.match(draft.legal, /^On the US Entity List\./);
  assert.equal(draft.fields.endsOn, '2026-12-25');
  assert.deepEqual(draft.ends, { min: '2026-11-26', max: '2027-02-23', fallback: '2026-12-25', hint: 'At most 90 days from today: on or before 23 Feb 2027.' });
  assert.deepEqual(draft.fields.person, { name: PERSON.name, position: PERSON.role }, 'the listed signer\'s name and position are filled in');
  assert.equal(draft.keyNotListed, undefined);
  assert.equal(h.view().oneDraft, true);
  // One draft at a time.
  await h.send({ type: 'exception-ask', model: 'deepseek-ai/deepseek' });
  assert.equal(h.view().draft.model, 'z-ai/glm');
  assert.equal(h.view().status, 'Finish or close the open request first.');
});

test('page messages are checked field by field and must name the shown draft; invalid fields come back with their sentences and nothing is signed', async () => {
  const key = deviceKey();
  const h = harness(organizationState(key), key);
  await h.ready();
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  const id = h.view().draft.id as string;
  await h.send({ type: 'exception-review', draft: 'ra-other', fields: GOOD_FIELDS });
  await h.send({ type: 'exception-review', draft: id, fields: { ...GOOD_FIELDS, projects: ['project-not-open'] } });
  await h.send({ type: 'exception-review', draft: id, fields: { ...GOOD_FIELDS, labels: ['org/Made Up'] } });
  assert.equal(h.view().draft.stage, 'draft', 'a crafted project or label the page was not offered changes nothing');
  await h.send({ type: 'exception-review', draft: id, fields: { ...GOOD_FIELDS, projects: [], benefit: '', endsOn: '2027-03-30' } });
  assert.deepEqual(h.view().draft.errors, { projects: 'Choose at least one project.', benefit: 'Say what this model does for the mission.', ends: 'An exception can last at most 90 days. Choose 23 Feb 2027 or earlier.' });
  await h.send({ type: 'exception-sign', draft: id });
  assert.equal(h.writes.length, 0);
});

test('D-20: review then sign: the request is signed with this computer\'s key as the named person\'s inner signature and saved for your organization; nothing changes locally', async () => {
  const key = deviceKey();
  const state = organizationState(key);
  const h = harness(state, key);
  await h.ready();
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  const id = h.view().draft.id as string;
  await h.send({ type: 'exception-review', draft: id, fields: GOOD_FIELDS });
  const review = h.view().draft.review;
  assert.equal(review.title, 'Check the request before you sign');
  assert.deepEqual(review.facts.map((pair: string[]) => pair[0]), ['Model', 'Read first', 'Use', 'Projects it covers', 'Labels it covers', 'Conditions', 'Mission benefit', 'Named person (Name, Position)', 'Ends on']);
  assert.equal(review.next, 'When you sign, SovAI saves a file for Security desk (security@example.org). Nothing changes on this computer. The exception counts only when your organization\'s rules carry it.');
  // Closed save dialog: not saved, the review card stays.
  h.saveAnswers.push(undefined);
  await h.send({ type: 'exception-sign', draft: id });
  assert.equal(h.view().status, 'Not saved. Your draft is still here.');
  assert.equal(h.view().draft.stage, 'review');
  h.saveAnswers.push({ fsPath: '/home/person/exception-request.near-policy-proposal' });
  await h.send({ type: 'exception-sign', draft: id });
  assert.equal(h.writes.length, 1);
  assert.equal(h.view().draft, undefined);
  assert.equal(h.view().saved, 'Request saved to /home/person/exception-request.near-policy-proposal. Send it to Security desk (security@example.org). Nothing changes here until your organization\'s rules carry the exception.');
  assert.deepEqual(h.records, [], 'no policy edit is recorded');
  assert.deepEqual(h.applied, [], 'nothing is applied locally');
  // The file: a policy proposal for your organization adding one authorization, whose inner signature is the named person's and verifies.
  const proposal = JSON.parse(h.writes[0]?.text ?? '{}') as SignedPayload<ProposalPayload>;
  assert.equal(verifyPayload(proposal, { purpose: 'policy-proposal', status: activeKeys(key) }).ok, true);
  assert.equal(proposal.payload.target.layer, 'organization');
  const added = proposal.payload.changes.find((change) => change.section === 'authorizations')?.after as SignedPayload<AuthorizationBody>;
  assert.equal(added.payload.kind, 't1-risk');
  assert.deepEqual(added.payload.scope, { projects: [PROJECT.id], labels: ['org/Internal'], uses: ['t1'] });
  const signers = state.organization?.people?.signers ?? [];
  assert.equal(verifyAuthorization(added, { signers, now: NOW + 60_000 }).ok, true);
});

test('D-20: once your organization\'s rules carry it, chat you review on that model at that label reads "Allowed for chat you review by {name} until {date}", with no self-signed form', async () => {
  const key = deviceKey();
  const h = harness(organizationState(key), key);
  await h.ready();
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  const id = h.view().draft.id as string;
  await h.send({ type: 'exception-review', draft: id, fields: GOOD_FIELDS });
  h.saveAnswers.push({ fsPath: '/tmp/request.near-policy-proposal' });
  await h.send({ type: 'exception-sign', draft: id });
  const proposal = JSON.parse(h.writes[0]?.text ?? '{}') as SignedPayload<ProposalPayload>;
  const added = proposal.payload.changes.find((change) => change.section === 'authorizations')?.after as SignedPayload<AuthorizationBody>;
  const carried = organizationState(key, (doc) => { doc['authorizations'] = [...doc['authorizations'], added].sort((a: any, b: any) => (a.payload.id < b.payload.id ? -1 : 1)); });
  const verdict = verifyAuthorization(added, { signers: carried.organization?.people?.signers ?? [], now: NOW + 60_000 });
  assert.ok(verdict.ok);
  if (!verdict.ok) return;
  const step = passportStep({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] }, {
    modelId: 'z-ai/glm-5.3', use: 'T1', place: { class: 'nearai-tee', region: 'unstated' }, project: PROJECT.id, labelKeys: ['org/Internal'], authorizations: [{ body: verdict.body, selfSigned: false }], whoToAsk: '', now: NOW + 60_000
  });
  assert.equal(step.covers, true);
  const facts: TrustFacts = { verification: 'not-checked', place: { class: 'nearai-tee', region: 'unstated' }, wouldRefuse: [], allowedBy: [authorizationRecord({ body: verdict.body, selfSigned: false }, 'org/Internal')] };
  const line = trustLine(facts, carried.effective.labels.scales);
  assert.equal(line.allowed, 'Allowed for chat you review by Avery Chen until 25 Dec 2026');
  assert.equal(trustLine({ ...facts, allowedBy: [authorizationRecord({ body: verdict.body, selfSigned: true })] }, carried.effective.labels.scales).allowed, 'Allowed for chat you review by Avery Chen until 25 Dec 2026', 'no self-signed form');
});

test('Renew opens a draft with the same scope and a new end date, and an empty mission benefit; only the named person\'s own exception offers it', async () => {
  const key = deviceKey();
  const first = harness(organizationState(key), key);
  await first.ready();
  await first.send({ type: 'exception-ask', model: 'z-ai/glm' });
  const id = first.view().draft.id as string;
  await first.send({ type: 'exception-review', draft: id, fields: GOOD_FIELDS });
  first.saveAnswers.push({ fsPath: '/tmp/request.near-policy-proposal' });
  await first.send({ type: 'exception-sign', draft: id });
  const added = (JSON.parse(first.writes[0]?.text ?? '{}') as SignedPayload<ProposalPayload>).payload.changes.find((change) => change.section === 'authorizations')?.after as SignedPayload<AuthorizationBody>;
  const carried = organizationState(key, (doc) => { doc['authorizations'] = [...doc['authorizations'], added].sort((a: any, b: any) => (a.payload.id < b.payload.id ? -1 : 1)); });
  const h = harness(carried, key);
  await h.ready();
  const row = (h.view().rows as Message[]).find((entry) => entry.id === added.payload.id);
  assert.equal(row?.text, 'z-ai/glm: Allowed for chat you review by Avery Chen until 25 Dec 2026');
  assert.equal(row?.scope, 'Projects: Harrow Ridge. Labels: org/Internal.');
  assert.equal(row?.renew, true);
  await h.send({ type: 'exception-renew', id: added.payload.id });
  const draft = h.view().draft;
  assert.deepEqual({ projects: draft.fields.projects, labels: draft.fields.labels, benefit: draft.fields.benefit, endsOn: draft.fields.endsOn }, { projects: [PROJECT.id], labels: ['org/Internal'], benefit: '', endsOn: '2026-12-25' });
  const other = harness(carried, deviceKey('someone-else'));
  await other.ready();
  assert.equal((other.view().rows as Message[]).find((entry) => entry.id === added.payload.id)?.renew, false);
  await other.send({ type: 'exception-renew', id: added.payload.id });
  assert.equal(other.view().draft, undefined, 'a crafted renew of someone else\'s exception opens nothing');
});

test('with no project open, Ask opens nothing and the section says to open the project first', async () => {
  const key = deviceKey();
  const h = harness(organizationState(key), key, []);
  await h.ready();
  await h.send({ type: 'exception-ask', model: 'z-ai/glm' });
  assert.equal(h.view().draft, undefined);
  assert.equal(h.view().status, 'Open the project this exception is for, then ask again.');
});
