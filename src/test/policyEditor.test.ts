import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SELF_SIGNED_TEXT } from '../domain/gate/authorizations';
import { bundleHash } from '../domain/gate/bundle';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { POLICY_SECTION_IDS, PROPOSAL_FILE_EXTENSION, policySections, proposalOf } from '../domain/gate/proposal';
import { verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { activeKeys, deviceKey, fullDocumentFor, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

// The policy editor's host controller (FND-09, Phase 41 D-44, D-47), driven as VS Code drives it: a stand-in panel and save dialog, and fake host
// dependencies that record every call. Each harness loads a fresh copy of the editor, so no test sees another's panel or proposal.

type Message = Record<string, any>;
type Handler = (value: unknown) => unknown;
type EditorModule = typeof import('../services/policyEditor');
type PanelModule = typeof import('../services/webview/openPanel');

interface EditorState {
  personal: PolicyDocument;
  personalHash: string;
  organization?: PolicyDocument;
  organizationHash?: string;
  organizationIssuer?: string;
  organizationSignedHere: boolean;
  effective: PolicyDocument;
}

interface Calls {
  applyPersonal: Array<{ next: PolicyDocument; baseHash: string }>;
  record: Array<{ id: string; detail: Record<string, unknown> }>;
  reset: number;
  showStored: number;
  signer: number;
  editOwn: number;
  applyDraft: number;
}

interface HarnessOptions {
  state: EditorState | undefined;
  applyAnswer?: { ok: true } | { ok: false; text: string };
  signer?: PayloadSigner;
  /** The host offers Edit my rules and Apply my draft (41-15); `draft` says whether a draft waits. */
  ownRules?: { draft: { on: boolean } };
  /** applyPersonal waits for this before it answers (an Apply still running). */
  applyGate?: Promise<void>;
}

interface Harness {
  editor: EditorModule;
  panels: PanelModule;
  posted: Message[];
  calls: Calls;
  created: Array<{ viewType: string; title: string; options: Record<string, unknown> }>;
  saveAnswers: Array<{ fsPath: string; path: string } | undefined>;
  saveCalls: Array<Record<string, any>>;
  writes: Array<{ path: string; text: string }>;
  failWrite: { on: boolean };
  html(): string;
  /** What the page sends; resolves when the host has handled it. */
  send(message: unknown): Promise<void>;
  /** The person closes the panel. */
  close(): void;
  /** The host's rules change: the new state is read and the editor told. */
  change(state: EditorState | undefined): void;
  /** The host's rules change and the editor is not told yet (a change racing a click). */
  swap(state: EditorState | undefined): void;
  lastState(): Message;
}

const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });

function harness(options: HarnessOptions): Harness {
  const posted: Message[] = [];
  const handlers: { message?: Handler; viewState?: Handler; dispose?: () => void } = {};
  const created: Harness['created'] = [];
  const saveAnswers: Harness['saveAnswers'] = [];
  const saveCalls: Harness['saveCalls'] = [];
  const writes: Harness['writes'] = [];
  const failWrite = { on: false };
  const listeners: Array<() => void> = [];
  let state = options.state;
  const panel = {
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (value: unknown) => value,
      postMessage: async (message: Message) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: Handler) => { handlers.message = handler; return { dispose: () => undefined }; }
    },
    onDidChangeViewState: (handler: Handler) => { handlers.viewState = handler; return { dispose: () => undefined }; },
    onDidDispose: (handler: () => void) => { handlers.dispose = handler; return { dispose: () => undefined }; },
    reveal: () => undefined,
    dispose: () => { handlers.dispose?.(); }
  };
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')), file: (value: string) => uri(value) },
    ViewColumn: { Active: -1 },
    window: {
      createWebviewPanel: (viewType: string, title: string, _column: unknown, panelOptions: Record<string, unknown>) => { created.push({ viewType, title, options: panelOptions }); return panel; },
      showSaveDialog: async (dialog: Record<string, any>) => { saveCalls.push(dialog); return saveAnswers.shift(); }
    },
    workspace: {
      workspaceFolders: undefined,
      fs: {
        writeFile: async (target: { fsPath: string }, bytes: Uint8Array) => {
          if (failWrite.on) throw new Error('The disk is full.');
          writes.push({ path: target.fsPath, text: Buffer.from(bytes).toString('utf8') });
        }
      }
    }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  for (const name of ['../services/policyEditor', '../services/webview/openPanel', '../services/layoutProbe']) delete require.cache[require.resolve(name)];
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let editor: EditorModule;
  let panels: PanelModule;
  try {
    editor = require('../services/policyEditor') as EditorModule;
    panels = require('../services/webview/openPanel') as PanelModule;
  } finally {
    nodeModule._load = originalLoad;
  }
  const calls: Calls = { applyPersonal: [], record: [], reset: 0, showStored: 0, signer: 0, editOwn: 0, applyDraft: 0 };
  const own = options.ownRules;
  const context = { extensionUri: uri('/extension'), subscriptions: [] as unknown[] };
  editor.registerPolicyEditor(context as never, {
    state: () => state,
    directionOf: () => undefined,
    applyPersonal: async (next, baseHash) => { calls.applyPersonal.push({ next, baseHash }); await options.applyGate; return options.applyAnswer ?? { ok: true }; },
    signer: () => { calls.signer += 1; return options.signer; },
    reset: async () => { calls.reset += 1; },
    showStored: async () => { calls.showStored += 1; },
    record: (id, detail) => { calls.record.push({ id, detail: { ...detail } }); },
    onDidChange: (listener) => { listeners.push(listener); return { dispose: () => undefined }; },
    ...(own === undefined ? {} : {
      editOwn: async () => { calls.editOwn += 1; own.draft.on = true; },
      hasDraft: () => own.draft.on,
      applyDraft: async () => { calls.applyDraft += 1; }
    })
  });
  return {
    editor,
    panels,
    posted,
    calls,
    created,
    saveAnswers,
    saveCalls,
    writes,
    failWrite,
    html: () => panel.webview.html,
    send: async (message) => { await handlers.message?.(message); },
    close: () => panel.dispose(),
    change: (next) => { state = next; for (const listener of listeners) listener(); },
    swap: (next) => { state = next; },
    lastState: () => {
      const states = posted.filter((message) => message.type === 'state');
      assert.ok(states.length > 0, 'the host posted a state');
      return states[states.length - 1] as Message;
    }
  };
}

/** The starting rules as this device's own layer, with no organization layer. */
function ownState(): EditorState {
  const personal = policyDocumentFor({ key: deviceKey() });
  return { personal, personalHash: bundleHash(personal), organizationSignedHere: false, effective: personal };
}

function editedDoc(base: PolicyDocument, edit: (doc: Record<string, any>) => void): PolicyDocument {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  edit(copy);
  return copy as unknown as PolicyDocument;
}

/** The change a flow hands the editor: Organization: Internal may go to any AI service. */
const widenInternal = {
  from: 'Example flow',
  next: (current: PolicyDocument) => editedDoc(current, (doc) => { doc['labels'].routing.levels['org/Internal'] = 'any-cloud'; })
};

/** Lets the host's posted promises settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('D-44: a proposal on your own rules is shown and applied', async () => {
  const state = ownState();
  const h = harness({ state, signer: deviceKey() });
  const outcome = h.editor.openPolicyProposal({ ...widenInternal, from: 'Edit my rules' });
  await settle();
  const shown = h.lastState();
  assert.deepEqual(shown.actions, ['apply', 'discard']);
  assert.equal(shown.proposal.changes.length, 1);
  assert.equal(shown.proposal.changes[0].key, 'routing.levels.org/Internal');
  assert.equal(shown.proposal.changes[0].effect, 'Organization: Internal work could go to a server that is not verified.');
  assert.equal(shown.proposal.changes[0].direction, 'widens');
  await h.send({ type: 'apply', id: shown.proposal.id });
  assert.equal(h.calls.applyPersonal.length, 1);
  assert.equal(h.calls.applyPersonal[0]?.baseHash, state.personalHash);
  assert.deepEqual(h.calls.applyPersonal[0]?.next, widenInternal.next(state.personal));
  assert.equal(h.calls.record.length, 1);
  assert.equal(h.calls.record[0]?.id, 'policy.proposal-applied');
  assert.equal(h.calls.record[0]?.detail['changes'], 1);
  assert.equal(h.calls.record[0]?.detail['from'], 'Edit my rules');
  assert.equal(h.calls.record[0]?.detail['proposalHash'], '3c9b825aed652d71c4bd878b339c8d50c0812415429af218c08540260ace593d');
  assert.equal(await outcome, 'applied');
  assert.equal(h.lastState().proposal, undefined, 'after applying, the rules are shown with no proposal');
  assert.equal(shown.title, 'Your Standing Orders');
  assert.equal(shown.proposal.from, 'Edit my Standing Orders');
});

test('IN-08, D-44: Apply is not offered on your own rules when this device has no signing key, and a forged Apply does nothing', async () => {
  const state = ownState();
  const unsigned = harness({ state });
  const outcome = unsigned.editor.openPolicyProposal(widenInternal);
  await settle();
  const shown = unsigned.lastState();
  assert.equal(shown.title, 'Your Standing Orders');
  assert.equal(shown.proposal.changes.length, 1, 'the proposal is still shown');
  assert.deepEqual(shown.actions, ['discard'], 'no Apply without a key to sign your rules');
  await unsigned.send({ type: 'apply', id: shown.proposal.id });
  assert.equal(unsigned.calls.applyPersonal.length, 0);
  assert.equal(unsigned.calls.record.length, 0);
  assert.equal(await settled(outcome), false, 'the proposal waits');
  await unsigned.send({ type: 'discard', id: shown.proposal.id });
  assert.equal(await outcome, 'discarded');
  // The same proposal on a device with its key offers Apply.
  const signed = harness({ state, signer: deviceKey() });
  void signed.editor.openPolicyProposal(widenInternal);
  await settle();
  assert.deepEqual(signed.lastState().actions, ['apply', 'discard']);
});

test('the panel has one CSP with a fresh nonce, base.css and the page script, and a title with no brand prefix', async () => {
  const h = harness({ state: ownState() });
  h.editor.openPolicyEditor();
  await settle();
  const html = h.html();
  assert.equal((html.match(/Content-Security-Policy/g) ?? []).length, 1, 'one CSP');
  assert.match(html, /default-src 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
  assert.ok(nonce !== undefined && nonce.length >= 16, 'a nonce');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(scripts.length >= 1);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `every script carries the nonce: ${tag}`);
  assert.ok(scripts.some((tag) => tag.includes('/media/policy/policy.js')), 'the page script');
  assert.match(html, /href="\/extension\/media\/shared\/base\.css"/);
  assert.match(html, /href="\/extension\/media\/policy\/policy\.css"/);
  assert.equal(h.created[0]?.title, 'Your Standing Orders');
  assert.equal(h.created[0]?.viewType, h.editor.POLICY_EDITOR_VIEW_TYPE);
  const context = { extensionUri: uri('/extension'), subscriptions: [] };
  const spec = { viewType: 'example', folder: 'policy', script: 'policy.js', style: 'policy.css', body: '', probe: 'example' };
  assert.throws(() => h.panels.openPanel(context as never, { ...spec, title: 'NEAR AI: Rules' }), /prefix/);
  assert.throws(() => h.panels.openPanel(context as never, { ...spec, title: 'Near AI: Rules' }), /prefix/);
  assert.throws(() => h.panels.openPanel(context as never, { ...spec, title: 'SovAI: Rules' }), /prefix/);
  assert.equal(h.created.length, 1, 'a refused title opens no panel');
  // A second panel gets its own nonce.
  const second = harness({ state: ownState() });
  second.editor.openPolicyEditor();
  const other = /script-src 'nonce-([^']+)'/.exec(second.html())?.[1];
  assert.ok(other !== undefined && other !== nonce, 'a fresh nonce per panel');
});

test('D-47: an apply that does not name the shown proposal changes nothing', async () => {
  const h = harness({ state: ownState(), signer: deviceKey() });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const id = h.lastState().proposal.id as string;
  for (const forged of [{ type: 'apply' }, { type: 'apply', id: 'proposal-999' }, { type: 'apply', id: 7 }, { type: 'apply', id: [id] }, 'apply', null, [{ type: 'apply', id }]]) {
    await h.send(forged);
  }
  assert.equal(h.calls.applyPersonal.length, 0);
  assert.equal(h.calls.record.length, 0);
  assert.equal(h.lastState().proposal.id, id, 'the proposal is still shown');
  await h.send({ type: 'discard', id });
  assert.equal(await outcome, 'discarded');
});

/** Your organization's rules (every section, contacts security and export control), and this device's own rules under them. */
function organizationState(options: { signedHere?: boolean; contacts?: boolean } = {}): EditorState {
  const plain = fullDocumentFor(issuerKey());
  if (options.contacts === false) delete plain['onboarding'];
  if (options.contacts === false) plain['requires'] = (plain['requires'] as string[]).filter((feature) => feature !== 'onboarding@1');
  const parsed = parsePolicyDocument(plain);
  assert.ok(parsed.ok, `the organization fixture parses: ${parsed.ok ? '' : parsed.message}`);
  const organization = parsed.value;
  const personal = policyDocumentFor({ key: deviceKey() });
  return {
    personal, personalHash: bundleHash(personal), organization, organizationHash: bundleHash(organization), organizationIssuer: issuerKey().fingerprint,
    organizationSignedHere: options.signedHere === true, effective: organization
  };
}

/** Whether a promise has settled yet, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await settle();
  return done;
}

const SAVED = uri('/example/rules-request.near-policy-proposal');

test('D-44: under an organization layer the title is your organization\'s rules and the proposal is exported', async () => {
  const state = organizationState();
  const signer = deviceKey();
  const h = harness({ state, signer });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const shown = h.lastState();
  assert.equal(shown.title, "Your organization's Standing Orders");
  assert.equal(h.created[0]?.title, "Your organization's Standing Orders");
  assert.deepEqual(shown.actions, ['export', 'discard'], 'no Apply: your organization signs its own rules');
  const id = shown.proposal.id as string;
  // A forged Apply changes nothing and calls nothing.
  await h.send({ type: 'apply', id });
  assert.equal(h.calls.applyPersonal.length, 0);
  assert.equal(h.calls.signer, 0);
  assert.equal(h.calls.record.length, 0);
  assert.equal(h.saveCalls.length, 0);
  assert.equal(await settled(outcome), false, 'still shown');
  h.saveAnswers.push(SAVED);
  await h.send({ type: 'export', id });
  assert.equal(h.saveCalls.length, 1);
  assert.ok(String(h.saveCalls[0]?.defaultUri?.fsPath).endsWith(PROPOSAL_FILE_EXTENSION), 'the default name ends with the proposal extension');
  assert.match(path.basename(String(h.saveCalls[0]?.defaultUri?.fsPath)), /^policy-proposal-\d{8}\.near-policy-proposal$/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.path, SAVED.fsPath);
  const envelope = JSON.parse(h.writes[0]?.text ?? '') as Record<string, any>;
  const verdict = verifyPayload<Record<string, any>>(envelope, { purpose: 'policy-proposal', status: activeKeys(signer) });
  assert.ok(verdict.ok, 'a signed policy-proposal file');
  assert.deepEqual(verdict.payload.target, { layer: 'organization', hash: state.organizationHash, issuer: state.organizationIssuer });
  assert.equal(verdict.payload.from, 'Example flow');
  assert.deepEqual(verdict.payload.changes.map((change: Record<string, unknown>) => change.key), ['routing.levels.org/Internal']);
  assert.equal(h.calls.record.length, 1);
  assert.equal(h.calls.record[0]?.id, 'policy.proposal-exported');
  assert.equal(h.calls.record[0]?.detail['proposalHash'], bundleHash(verdict.payload));
  assert.equal(h.calls.applyPersonal.length, 0, 'nothing changes on this computer');
  assert.equal(await outcome, 'exported');
  const notice = String(h.lastState().notice);
  assert.ok(notice.startsWith(h.editor.PROPOSAL_EXPORTED_TEXT), notice);
  assert.ok(notice.includes('Security desk (security@example.org)'), notice);
  assert.ok(notice.indexOf('Security desk') < notice.indexOf('Export control desk'), 'the security contact first');
  assert.equal(h.lastState().proposal, undefined);
});

test('D-44: no contact named, and a dismissed save dialog writes nothing', async () => {
  const h = harness({ state: organizationState({ contacts: false }), signer: deviceKey() });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const id = h.lastState().proposal.id as string;
  await h.send({ type: 'export', id });
  assert.equal(h.saveCalls.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.record.length, 0);
  assert.equal(h.lastState().proposal.id, id, 'the proposal stays shown');
  assert.equal(await settled(outcome), false);
  h.saveAnswers.push(SAVED);
  await h.send({ type: 'export', id });
  assert.equal(h.writes.length, 1);
  assert.equal(await outcome, 'exported');
  const notice = String(h.lastState().notice);
  assert.ok(notice.includes(h.editor.NO_CONTACT_TEXT), notice);
  assert.equal(h.editor.NO_CONTACT_TEXT, "Send this file to whoever manages your organization's Standing Orders.");
});

test('D-44: an export that cannot be signed or written says nothing was written and keeps the proposal', async () => {
  const unsigned = harness({ state: organizationState() });
  const first = unsigned.editor.openPolicyProposal(widenInternal);
  await settle();
  await unsigned.send({ type: 'export', id: unsigned.lastState().proposal.id });
  assert.match(String(unsigned.lastState().notice), /^Nothing was written/);
  assert.equal(unsigned.saveCalls.length, 0);
  assert.equal(unsigned.writes.length, 0);
  assert.equal(await settled(first), false);
  const failing = harness({ state: organizationState(), signer: deviceKey() });
  const second = failing.editor.openPolicyProposal(widenInternal);
  await settle();
  failing.failWrite.on = true;
  failing.saveAnswers.push(SAVED);
  await failing.send({ type: 'export', id: failing.lastState().proposal.id });
  assert.equal(failing.lastState().notice, 'Nothing was written: The disk is full.');
  assert.equal(failing.calls.record.length, 0);
  assert.ok(failing.lastState().proposal !== undefined);
  assert.equal(await settled(second), false);
});

test('D-44: a proposal for your own rules under your organization is applied there', async () => {
  const state = organizationState();
  const h = harness({ state, signer: deviceKey() });
  const outcome = h.editor.openPolicyProposal({ ...widenInternal, target: 'personal' });
  await settle();
  assert.equal(h.lastState().title, "Your organization's Standing Orders");
  assert.deepEqual(h.lastState().actions, ['apply', 'discard']);
  await h.send({ type: 'export', id: h.lastState().proposal.id });
  assert.equal(h.saveCalls.length, 0, 'no export for your own rules');
  await h.send({ type: 'apply', id: h.lastState().proposal.id });
  assert.equal(h.calls.applyPersonal[0]?.baseHash, state.personalHash);
  assert.equal(await outcome, 'applied');
  // Your organization's rules cannot be the target without them.
  const own = harness({ state: ownState() });
  await assert.rejects(own.editor.openPolicyProposal({ ...widenInternal, target: 'organization' }), /organization/);
  assert.equal(own.created.length, 0);
});

test('D-47: a proposal goes stale when your rules change under it', async () => {
  const state = ownState();
  const h = harness({ state });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const id = h.lastState().proposal.id as string;
  h.change({ ...state, personalHash: 'f'.repeat(64) });
  await settle();
  const staleNotice = 'Your policy changed after this draft was made. Open SovAI: Standing Orders and choose Edit my Standing Orders again to start from the policy in force.';
  assert.equal(h.lastState().notice, staleNotice);
  assert.deepEqual(h.lastState().actions, ['discard']);
  assert.equal(h.lastState().proposal.stale, true);
  await h.send({ type: 'apply', id });
  assert.equal(h.calls.applyPersonal.length, 0, 'Apply while stale changes nothing');
  assert.equal(h.calls.record.length, 0);
  await h.send({ type: 'discard', id });
  assert.equal(await outcome, 'discarded');
  // A change that races the click is caught when Apply is pressed.
  const racing = harness({ state, signer: deviceKey() });
  const raced = racing.editor.openPolicyProposal(widenInternal);
  await settle();
  racing.swap({ ...state, personalHash: 'e'.repeat(64) });
  await racing.send({ type: 'apply', id: racing.lastState().proposal.id });
  assert.equal(racing.calls.applyPersonal.length, 0);
  assert.equal(racing.lastState().notice, staleNotice);
  assert.equal(await settled(raced), false);
  // Your organization's rules changing under an export makes it stale too, and so do rules that cannot be read.
  const org = organizationState();
  const exporting = harness({ state: org, signer: deviceKey() });
  void exporting.editor.openPolicyProposal(widenInternal);
  await settle();
  exporting.change({ ...org, organizationHash: 'd'.repeat(64) });
  await settle();
  assert.deepEqual(exporting.lastState().actions, ['discard']);
  exporting.saveAnswers.push(SAVED);
  await exporting.send({ type: 'export', id: exporting.lastState().proposal.id });
  assert.equal(exporting.saveCalls.length, 0);
  const unreadable = harness({ state });
  void unreadable.editor.openPolicyProposal(widenInternal);
  await settle();
  unreadable.change(undefined);
  await settle();
  assert.deepEqual(unreadable.lastState().actions, ['discard']);
});

test('D-47: discard shows the rules again', async () => {
  const h = harness({ state: ownState() });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  await h.send({ type: 'discard', id: h.lastState().proposal.id });
  assert.equal(await outcome, 'discarded');
  assert.equal(h.lastState().proposal, undefined);
  assert.deepEqual(h.lastState().actions, []);
  assert.equal(h.lastState().sections.length, POLICY_SECTION_IDS.length);
  assert.equal(h.calls.applyPersonal.length + h.calls.record.length, 0);
});

test('D-47: closing the page discards the proposal', async () => {
  const h = harness({ state: ownState() });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  h.close();
  assert.equal(await outcome, 'discarded');
  assert.equal(h.calls.applyPersonal.length + h.calls.record.length, 0);
});

test('D-47: a newer proposal replaces the shown one', async () => {
  const h = harness({ state: ownState(), signer: deviceKey() });
  const first = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const firstId = h.lastState().proposal.id as string;
  const second = h.editor.openPolicyProposal({
    from: 'Another flow',
    next: (current: PolicyDocument) => editedDoc(current, (doc) => { doc['labels'].routing.levels['org/Public'] = 'local-only'; })
  });
  assert.equal(await first, 'replaced');
  await settle();
  const shown = h.lastState();
  assert.notEqual(shown.proposal.id, firstId);
  assert.equal(shown.proposal.from, 'Another flow');
  assert.deepEqual(shown.proposal.changes.map((change: Record<string, unknown>) => change.key), ['routing.levels.org/Public']);
  await h.send({ type: 'apply', id: firstId });
  assert.equal(h.calls.applyPersonal.length, 0, 'an Apply for the replaced proposal changes nothing');
  assert.equal(h.created.length, 1, 'one panel');
  await h.send({ type: 'apply', id: shown.proposal.id });
  assert.equal(await second, 'applied');
  assert.deepEqual([...h.editor.PROPOSAL_OUTCOMES], ['applied', 'exported', 'discarded', 'replaced']);
});

test('D-44: a refusal from applying is shown and nothing else changes', async () => {
  const h = harness({ state: ownState(), signer: deviceKey(), applyAnswer: { ok: false, text: 'Nothing was changed. Your rules cannot be trusted right now.' } });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const id = h.lastState().proposal.id as string;
  await h.send({ type: 'apply', id });
  assert.equal(h.calls.applyPersonal.length, 1);
  assert.equal(h.lastState().notice, 'Nothing was changed. Your rules cannot be trusted right now.');
  assert.equal(h.calls.record.length, 0);
  assert.equal(h.lastState().proposal.id, id);
  assert.deepEqual(h.lastState().actions, ['apply', 'discard']);
  assert.equal(await settled(outcome), false);
});

test('D-23: who set the rules', async () => {
  const byOrganization = harness({ state: organizationState() });
  byOrganization.editor.openPolicyEditor();
  await settle();
  assert.equal(byOrganization.lastState().setBy, 'Set by your organization');
  assert.equal(byOrganization.editor.SET_BY_ORGANIZATION_TEXT, 'Set by your organization');
  for (const state of [ownState(), organizationState({ signedHere: true })]) {
    const h = harness({ state });
    h.editor.openPolicyEditor();
    await settle();
    assert.ok(String(h.lastState().setBy).includes(SELF_SIGNED_TEXT), String(h.lastState().setBy));
  }
});

test('D-44: the rules are shown read only, at the section asked for', async () => {
  const state = organizationState();
  const h = harness({ state });
  h.editor.openPolicyEditor('limits');
  await settle();
  const shown = h.lastState();
  assert.deepEqual(shown.sections, JSON.parse(JSON.stringify(policySections(state.effective))));
  assert.equal(shown.at, 'limits');
  assert.deepEqual(shown.actions, []);
  const other = harness({ state });
  other.editor.openPolicyEditor('nowhere' as never);
  await settle();
  assert.equal(other.lastState().at, undefined);
});

test('D-44: Show as stored and Reset are page buttons, and other messages are ignored', async () => {
  const h = harness({ state: ownState() });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const id = h.lastState().proposal.id as string;
  await h.send({ type: 'show-stored' });
  assert.equal(h.calls.showStored, 1);
  await h.send({ type: 'reset' });
  assert.equal(h.calls.reset, 1);
  for (const ignored of [{ type: 'drop-rules' }, { type: 5 }, { type: ['apply'] }, { type: 'export', id: {} }, { type: 'discard', id: 1 }, { type: 'discard' }, undefined, 'reset', 42]) {
    await h.send(ignored);
  }
  assert.equal(h.calls.showStored + h.calls.reset, 2);
  // IN-08: the signer is asked whether this device has one, to decide whether Apply is offered; none here, so only Discard is, and nothing was applied,
  // recorded or saved.
  assert.equal(h.calls.applyPersonal.length + h.calls.record.length + h.saveCalls.length, 0);
  assert.deepEqual(h.lastState().actions, ['discard']);
  assert.equal(h.lastState().proposal.id, id);
  assert.equal(await settled(outcome), false);
});

/** Words never put in front of a person on this page (GLOSSARY sections 1, 3 and 5; the plan's copy rule). */
const FORBIDDEN_COPY = [/\u2014/, /endpoint/i, /\bTEE\b/i, /\btier/i, /\blayer/i, /\bissuer/i, /policy bundle/i, /NEAR(\s+AI)?('s)?\s+organization/i, /\bteam\b/i];

function assertCopy(text: string, where: string): void {
  for (const word of FORBIDDEN_COPY) assert.doesNotMatch(text, word, `${where}: "${text}" has ${String(word)}`);
}

test('copy on the page', async () => {
  // The page script's word strings (they hold a space or start with a capital); identifiers and message types are not copy.
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'policy', 'policy.js'), 'utf8');
  const code = script.replace(/^\s*\/\/.*$/gm, '');
  const literals = [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map((match) => match[1] ?? match[2] ?? '');
  const words = literals.filter((literal) => / /.test(literal) || /^[A-Z]/.test(literal));
  assert.ok(words.includes('Apply to my Standing Orders') && words.includes('Save a file for your organization') && words.includes('Reset my Standing Orders'), 'the button labels are found');
  for (const literal of words) assertCopy(literal, 'policy.js');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // The host HTML's text, the texts the editor exports, every section title and an effect sentence.
  const h = harness({ state: organizationState() });
  h.editor.openPolicyEditor();
  const text = h.html().replace(/<[^>]*>/g, ' ');
  assertCopy(text, 'host html');
  for (const exported of [h.editor.POLICY_EDITOR_TITLE, h.editor.POLICY_EDITOR_TITLE_OWN, h.editor.PROPOSAL_EXPORTED_TEXT, h.editor.NO_CONTACT_TEXT, h.editor.SET_BY_ORGANIZATION_TEXT]) {
    assertCopy(exported, 'editor text');
  }
  const state = organizationState();
  for (const section of policySections(state.effective)) assertCopy(section.title, 'section title');
  for (const change of proposalOf(state.personal, widenInternal.next(state.personal))) assertCopy(change.effect, 'effect');
  assert.doesNotMatch(readFileSync(path.join(__dirname, '..', 'services', 'policyEditor.js'), 'utf8'), /getConfiguration/);
  assert.doesNotMatch(readFileSync(path.join(__dirname, '..', 'services', 'webview', 'openPanel.js'), 'utf8'), /getConfiguration/);
});

// ---- 41-15: with Edit Policy off the palette, the page itself starts an edit of your own rules (Edit my rules) and applies a waiting draft ----

test('41-15: Edit my rules is offered when this device can sign your own rules and runs the Edit Policy flow; Apply my draft follows a waiting draft', async () => {
  const draft = { on: false };
  const h = harness({ state: ownState(), signer: deviceKey(), ownRules: { draft } });
  h.editor.openPolicyEditor();
  await settle();
  assert.deepEqual(h.lastState().pageActions, ['edit-own'], 'no draft yet: Edit my rules only');
  await h.send({ type: 'edit-own' });
  assert.equal(h.calls.editOwn, 1, 'the Edit Policy flow ran');
  assert.deepEqual(h.lastState().pageActions, ['edit-own', 'apply-draft'], 'the draft it wrote can be applied from the page');
  await h.send({ type: 'apply-draft' });
  await settle();
  assert.equal(h.calls.applyDraft, 1, 'the Apply Policy Draft flow ran');
  // Under your organization's rules the draft is still of your own rules, which this device signs.
  const organization = harness({ state: organizationState(), signer: deviceKey(), ownRules: { draft: { on: false } } });
  organization.editor.openPolicyEditor();
  await settle();
  assert.deepEqual(organization.lastState().pageActions, ['edit-own']);
  await organization.send({ type: 'edit-own' });
  assert.equal(organization.calls.editOwn, 1);
  // The page script draws exactly the offered buttons, with these words.
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'policy', 'policy.js'), 'utf8');
  assert.match(script, /'edit-own': 'Edit my Standing Orders'/);
  assert.match(script, /'apply-draft': 'Apply my draft'/);
  assert.match(script, /renderPageActions\(message\.pageActions\)/);
});

test('41-15: Edit my rules and Apply my draft are refused unless offered: no signing key, rules that cannot be read, no draft, no flow, or an Apply running', async () => {
  const tryAll = async (h: Harness): Promise<void> => { for (const type of ['edit-own', 'apply-draft']) await h.send({ type }); await settle(); };
  // No key on this device to sign your own rules.
  const unsigned = harness({ state: ownState(), ownRules: { draft: { on: true } } });
  unsigned.editor.openPolicyEditor();
  await settle();
  assert.deepEqual(unsigned.lastState().pageActions, []);
  await tryAll(unsigned);
  assert.equal(unsigned.calls.editOwn + unsigned.calls.applyDraft, 0);
  // Your rules cannot be read right now.
  const unreadable = harness({ state: undefined, signer: deviceKey(), ownRules: { draft: { on: true } } });
  unreadable.editor.openPolicyEditor();
  await settle();
  assert.deepEqual(unreadable.lastState().pageActions, []);
  await tryAll(unreadable);
  assert.equal(unreadable.calls.editOwn + unreadable.calls.applyDraft, 0);
  // No draft waits: only Edit my rules.
  const noDraft = harness({ state: ownState(), signer: deviceKey(), ownRules: { draft: { on: false } } });
  noDraft.editor.openPolicyEditor();
  await settle();
  await noDraft.send({ type: 'apply-draft' });
  await settle();
  assert.equal(noDraft.calls.applyDraft, 0, 'Apply my draft with no draft changes nothing');
  // The host offers no flow (a page with no draft storage): nothing is offered, and the signer is never asked.
  const noFlow = harness({ state: ownState(), signer: deviceKey() });
  noFlow.editor.openPolicyEditor();
  await settle();
  assert.deepEqual(noFlow.lastState().pageActions, []);
  await tryAll(noFlow);
  assert.equal(noFlow.calls.signer, 0);
  // While a shown proposal is being applied, neither starts.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const busy = harness({ state: ownState(), signer: deviceKey(), ownRules: { draft: { on: true } }, applyGate: gate });
  const outcome = busy.editor.openPolicyProposal(widenInternal);
  await settle();
  const applying = busy.send({ type: 'apply', id: busy.lastState().proposal.id });
  await settle();
  await tryAll(busy);
  assert.equal(busy.calls.editOwn + busy.calls.applyDraft, 0, 'refused while an Apply runs');
  release();
  await applying;
  assert.equal(await outcome, 'applied');
  assert.deepEqual(busy.lastState().pageActions, ['edit-own', 'apply-draft'], 'offered again once the Apply ended');
  // Forged shapes are ignored.
  const forged = harness({ state: ownState(), signer: deviceKey(), ownRules: { draft: { on: true } } });
  for (const message of [{ type: ['edit-own'] }, { type: 'Edit-Own' }, 'edit-own', { type: 'apply-draft ' }]) await forged.send(message);
  await settle();
  assert.equal(forged.calls.editOwn + forged.calls.applyDraft, 0);
});
