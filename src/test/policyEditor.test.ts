import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleHash } from '../domain/gate/bundle';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

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
}

interface HarnessOptions {
  state: EditorState | undefined;
  applyAnswer?: { ok: true } | { ok: false; text: string };
  signer?: PayloadSigner;
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
  const calls: Calls = { applyPersonal: [], record: [], reset: 0, showStored: 0, signer: 0 };
  const context = { extensionUri: uri('/extension'), subscriptions: [] as unknown[] };
  editor.registerPolicyEditor(context as never, {
    state: () => state,
    directionOf: () => undefined,
    applyPersonal: async (next, baseHash) => { calls.applyPersonal.push({ next, baseHash }); return options.applyAnswer ?? { ok: true }; },
    signer: () => { calls.signer += 1; return options.signer; },
    reset: async () => { calls.reset += 1; },
    showStored: async () => { calls.showStored += 1; },
    record: (id, detail) => { calls.record.push({ id, detail: { ...detail } }); },
    onDidChange: (listener) => { listeners.push(listener); return { dispose: () => undefined }; }
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
  const h = harness({ state });
  const outcome = h.editor.openPolicyProposal(widenInternal);
  await settle();
  const shown = h.lastState();
  assert.equal(shown.title, 'Your rules');
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
  assert.equal(h.calls.record[0]?.detail['from'], 'Example flow');
  assert.match(String(h.calls.record[0]?.detail['proposalHash']), /^[0-9a-f]{64}$/);
  assert.equal(await outcome, 'applied');
  assert.equal(h.lastState().proposal, undefined, 'after applying, the rules are shown with no proposal');
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
  assert.equal(h.created[0]?.title, 'Your rules');
  assert.equal(h.created[0]?.viewType, h.editor.POLICY_EDITOR_VIEW_TYPE);
  const context = { extensionUri: uri('/extension'), subscriptions: [] };
  const spec = { viewType: 'example', folder: 'policy', script: 'policy.js', style: 'policy.css', body: '', probe: 'example' };
  assert.throws(() => h.panels.openPanel(context as never, { ...spec, title: 'NEAR AI: Rules' }), /prefix/);
  assert.throws(() => h.panels.openPanel(context as never, { ...spec, title: 'Near AI: Rules' }), /prefix/);
  assert.equal(h.created.length, 1, 'a refused title opens no panel');
  // A second panel gets its own nonce.
  const second = harness({ state: ownState() });
  second.editor.openPolicyEditor();
  const other = /script-src 'nonce-([^']+)'/.exec(second.html())?.[1];
  assert.ok(other !== undefined && other !== nonce, 'a fresh nonce per panel');
});

test('D-47: an apply that does not name the shown proposal changes nothing', async () => {
  const h = harness({ state: ownState() });
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
