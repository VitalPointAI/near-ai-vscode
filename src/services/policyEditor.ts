import * as vscode from 'vscode';
import { bundleHash } from '../domain/gate/bundle';
import { proposalOf } from '../domain/gate/proposal';
import type { DirectionOf, ProposalChange } from '../domain/gate/proposal';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { openPanel } from './webview/openPanel';

// The policy editor (FND-09, Phase 41 D-44, D-47): one page, "Your organization's rules" (or "Your rules" without an organization), that shows the rules
// read only and receives proposals. Every flow that would change the rules calls openPolicyProposal(change); the person applies it to their own rules,
// which this device signs. Wiring to commands and the host is 41-14's: the host hands its dependencies to registerPolicyEditor.
// Every message from the page is untrusted: it is checked field by field in one switch, and a move the state does not offer changes nothing.

export const POLICY_EDITOR_VIEW_TYPE = 'nearAiPolicy';
export const POLICY_EDITOR_TITLE = "Your organization's rules";
export const POLICY_EDITOR_TITLE_OWN = 'Your rules';

/** The rules the editor shows, from the host's bundle state (41-09). */
export interface PolicyEditorState {
  readonly personal: PolicyDocument;
  /** bundleHash of the signed personal layer. */
  readonly personalHash: string;
  readonly organization?: PolicyDocument;
  readonly organizationHash?: string;
  /** The fingerprint of the key that signs your organization's rules. */
  readonly organizationIssuer?: string;
  /** True when your organization's rules were signed by this device (D-23). */
  readonly organizationSignedHere: boolean;
  /** The rules in force: the layers composed. */
  readonly effective: PolicyDocument;
}

export type PolicyApplyAnswer = { readonly ok: true } | { readonly ok: false; readonly text: string };

export type ProposalEventId = 'policy.proposal-applied' | 'policy.proposal-exported';

export interface PolicyEditorDeps {
  state(): PolicyEditorState | undefined;
  directionOf: DirectionOf;
  /** Signs `next` as the personal layer through the host, refusing when the stored layer's hash is no longer `baseHash`. */
  applyPersonal(next: PolicyDocument, baseHash: string): Promise<PolicyApplyAnswer>;
  /** This device's signer, or undefined when it has none. */
  signer(): PayloadSigner | undefined;
  /** Today's Reset flow; what it touches is the host's (D-21). */
  reset(): Promise<void>;
  /** Today's JSON view of the rules as stored. */
  showStored(): Promise<void>;
  record(id: ProposalEventId, detail: { proposalHash: string; changes: number; from: string }): void;
  onDidChange(listener: () => void): { dispose(): void };
}

/** A change a flow proposes: who asks, why, and the next rules computed from the current ones. */
export interface PolicyChange {
  /** The flow that proposes it, in a few plain words. */
  readonly from: string;
  readonly reason?: string;
  /** Your own rules, or your organization's; by default your organization's when it has rules here. */
  readonly target?: 'personal' | 'organization';
  next(current: PolicyDocument): PolicyDocument;
}

export type ProposalOutcome = 'applied' | 'discarded';

type Action = 'apply' | 'discard';

interface Pending {
  readonly id: string;
  readonly change: PolicyChange;
  readonly from: string;
  readonly base: PolicyDocument;
  readonly baseHash: string;
  readonly next: PolicyDocument;
  readonly changes: readonly ProposalChange[];
  readonly resolve: (outcome: ProposalOutcome) => void;
  busy: boolean;
}

const MAX_FROM = 120;
const MAX_REASON = 500;
const MAX_TEXT = 500;

let host: { context: { readonly extensionUri: vscode.Uri }; deps: PolicyEditorDeps } | undefined;
let panel: vscode.WebviewPanel | undefined;
let pending: Pending | undefined;
let notice: string | undefined;
let counter = 0;

const cut = (text: string, max: number) => text.slice(0, max);

/** Stores the host's dependencies; the returned disposable forgets them and closes the page. */
export function registerPolicyEditor(context: { readonly extensionUri: vscode.Uri }, deps: PolicyEditorDeps): vscode.Disposable {
  host = { context, deps };
  const listener = deps.onDidChange(() => { void post(); });
  return { dispose: () => { listener.dispose(); panel?.dispose(); host = undefined; } };
}

function titleOf(state: PolicyEditorState | undefined): string {
  return state?.organization === undefined ? POLICY_EDITOR_TITLE_OWN : POLICY_EDITOR_TITLE;
}

function actionsOf(): Action[] {
  if (pending === undefined) return [];
  return ['apply', 'discard'];
}

async function post(): Promise<void> {
  if (panel === undefined || host === undefined) return;
  const state = host.deps.state();
  const proposal = pending === undefined ? undefined : {
    id: pending.id,
    from: pending.from,
    ...(pending.change.reason === undefined ? {} : { reason: cut(pending.change.reason, MAX_REASON) }),
    changes: pending.changes.map((change) => ({ section: change.section, key: change.key, direction: change.direction, effect: change.effect }))
  };
  await panel.webview.postMessage({
    type: 'state', title: titleOf(state), sections: [], ...(proposal === undefined ? {} : { proposal }), actions: actionsOf(), ...(notice === undefined ? {} : { notice })
  });
}

function show(): vscode.WebviewPanel {
  if (host === undefined) throw new Error('The rules page is not ready yet.');
  if (panel !== undefined) { panel.reveal(); return panel; }
  const view = openPanel(host.context, {
    viewType: POLICY_EDITOR_VIEW_TYPE, title: titleOf(host.deps.state()), folder: 'policy', script: 'policy.js', style: 'policy.css', probe: 'policy',
    body: '<header><h1 id="title"></h1></header><p id="notice" role="status" aria-live="polite"></p><section id="proposal" hidden></section><div id="sections"></div>'
  });
  panel = view;
  view.onDidDispose(() => {
    panel = undefined;
    finish('discarded');
  });
  view.onDidChangeViewState((event) => { if (event.webviewPanel.visible) void post(); });
  view.webview.onDidReceiveMessage(async (message: unknown) => {
    try {
      await receive(message);
    } catch (error) {
      void view.webview.postMessage({ type: 'error', text: cut(error instanceof Error ? error.message : String(error), MAX_TEXT) });
    }
    await post();
  });
  return view;
}

/** Ends the shown proposal with an outcome. */
function finish(outcome: ProposalOutcome): void {
  const done = pending;
  pending = undefined;
  done?.resolve(outcome);
}

/** The id field of a page message, or undefined when it is not the shown proposal's. */
function proposalFor(message: Readonly<Record<string, unknown>>): Pending | undefined {
  return pending !== undefined && typeof message['id'] === 'string' && message['id'] === pending.id ? pending : undefined;
}

async function receive(message: unknown): Promise<void> {
  if (host === undefined || typeof message !== 'object' || message === null || Array.isArray(message)) return;
  const fields = message as Readonly<Record<string, unknown>>;
  switch (fields['type']) {
    case 'ready': break;
    case 'apply': {
      const shown = proposalFor(fields);
      if (shown === undefined || shown.busy || !actionsOf().includes('apply')) break;
      shown.busy = true;
      try {
        const answer = await host.deps.applyPersonal(shown.next, shown.baseHash);
        if (!answer.ok) { notice = cut(answer.text, MAX_TEXT); break; }
        host.deps.record('policy.proposal-applied', { proposalHash: bundleHash(shown.changes.map((change) => ({ section: change.section, key: change.key }))), changes: shown.changes.length, from: shown.from });
        notice = 'Your rules were changed.';
        finish('applied');
      } finally {
        shown.busy = false;
      }
      break;
    }
    case 'discard': if (proposalFor(fields) !== undefined) { notice = undefined; finish('discarded'); } break;
    default: break;
  }
}

/** Opens the editor showing the rules. */
export function openPolicyEditor(): void {
  show();
  void post();
}

/** Shows a proposed change and resolves when it is applied or discarded. */
export function openPolicyProposal(change: PolicyChange): Promise<ProposalOutcome> {
  if (host === undefined) return Promise.reject(new Error('The rules page is not ready yet.'));
  const state = host.deps.state();
  if (state === undefined) return Promise.reject(new Error('Your rules cannot be read right now, so nothing was proposed.'));
  const base = state.personal;
  const next = change.next(base);
  const changes = proposalOf(base, next, host.deps.directionOf);
  counter += 1;
  return new Promise<ProposalOutcome>((resolve) => {
    pending = { id: `proposal-${String(counter)}`, change, from: cut(change.from, MAX_FROM), base, baseHash: state.personalHash, next, changes, resolve, busy: false };
    notice = undefined;
    show();
    void post();
  });
}
