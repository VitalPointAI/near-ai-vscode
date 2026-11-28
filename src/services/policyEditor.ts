import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SELF_SIGNED_TEXT } from '../domain/gate/authorizations';
import { bundleHash } from '../domain/gate/bundle';
import { POLICY_SECTION_IDS, PROPOSAL_FILE_EXTENSION, policySections, proposalOf, proposalPayload } from '../domain/gate/proposal';
import type { DirectionOf, PolicySectionId, ProposalChange, ProposalPayload } from '../domain/gate/proposal';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyContact } from '../domain/gate/sections';
import { PayloadError, signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { STALE_DRAFT_TEXT } from '../gate/bundleStore';
import { openPanel } from './webview/openPanel';

// The policy editor (FND-09, Phase 41 D-44, D-47, D-23): one page, "Your organization's rules" (or "Your rules" without an organization), that shows the
// rules read only and receives proposals. Every flow that would change the rules calls openPolicyProposal(change). On your own rules, which this device
// signs, the person applies it; under your organization's rules it is saved as a signed file for your organization's contacts and nothing changes on this
// computer (your organization's key is kept offline, D-17). Wiring to commands and the host is 41-14's: the host hands its dependencies to
// registerPolicyEditor.
//
// A proposal's states: shown, then applied (your own rules, the host signed them), exported (your organization's rules, the file written), discarded
// (Discard, or the page closed), replaced (a newer proposal), or stale (the rules it was made from changed while it was shown: only Discard). Every
// message from the page is untrusted: it is checked field by field in one switch, must name the shown proposal, and a move the state does not offer
// changes nothing.

export const POLICY_EDITOR_VIEW_TYPE = 'nearAiPolicy';
export const POLICY_EDITOR_TITLE = "Your organization's rules";
export const POLICY_EDITOR_TITLE_OWN = 'Your rules';

/** How a proposal ends. One closed list; a proposal never ends half-done. */
export const PROPOSAL_OUTCOMES = Object.freeze(['applied', 'exported', 'discarded', 'replaced'] as const);
export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];

/** The first sentence after a proposal is saved for your organization. */
export const PROPOSAL_EXPORTED_TEXT = 'Nothing changed on this computer.';
/** Said when your organization's rules name no contact. */
export const NO_CONTACT_TEXT = "Send this file to whoever manages your organization's rules.";
/** The last sentence after a proposal is saved for your organization. */
export const ORGANIZATION_SENDS_TEXT = "Your organization's rules change when they send new rules.";
/** Shown when your organization's rules were signed by a key other than this device's (D-23). */
export const SET_BY_ORGANIZATION_TEXT = 'Set by your organization';
/** Shown for rules this device signed itself (D-23). */
export const SELF_SIGNED_RULES_TEXT = `These rules are ${SELF_SIGNED_TEXT}.`;
export const APPLIED_TEXT = 'Your rules were changed.';
export const NO_CHANGE_TEXT = 'This proposal changes nothing in your rules.';
export const UNREADABLE_TEXT = 'Your rules cannot be read right now.';

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
  /** The host's safe explanation when there is no usable policy to display. */
  unavailableNotice?(): string | undefined;
  directionOf: DirectionOf;
  /** Signs `next` as the personal layer through the host, refusing when the stored layer's hash is no longer `baseHash` (STALE_DRAFT_TEXT). */
  applyPersonal(next: PolicyDocument, baseHash: string): Promise<PolicyApplyAnswer>;
  /** This device's signer, or undefined when it has none. */
  signer(): PayloadSigner | undefined;
  /** Today's Reset flow; what it touches is the host's (D-21). */
  reset(): Promise<void>;
  /** Today's JSON view of the rules as stored. */
  showStored(): Promise<void>;
  record(id: ProposalEventId, detail: { proposalHash: string; changes: number; from: string }): void;
  onDidChange(listener: () => void): { dispose(): void };
  /** Opens an unsigned draft of your own rules (today's Edit Policy flow). Absent: the page offers no Edit my rules. */
  editOwn?(): Promise<void>;
  /** True while a draft of your own rules waits to be applied. */
  hasDraft?(): boolean;
  /** Shows the waiting draft on this page as a proposal (today's Apply Policy Draft flow). */
  applyDraft?(): Promise<void>;
}

/** The page's own buttons beyond Show as stored and Reset: each is offered only when this device can sign your own rules (41-15). */
export const PAGE_ACTIONS = Object.freeze(['edit-own', 'apply-draft'] as const);
export type PageAction = (typeof PAGE_ACTIONS)[number];

/** A change a flow proposes: who asks, why, and the next rules computed from the current ones. */
export interface PolicyChange {
  /** The flow that proposes it, in a few plain words. */
  readonly from: string;
  readonly reason?: string;
  /** Your own rules, or your organization's; by default your organization's when it has rules here, otherwise your own. */
  readonly target?: 'personal' | 'organization';
  next(current: PolicyDocument): PolicyDocument;
}

type Target = 'personal' | 'organization';
type Action = 'apply' | 'export' | 'discard';

interface Pending {
  readonly id: string;
  readonly from: string;
  readonly reason?: string;
  readonly target: Target;
  readonly base: PolicyDocument;
  readonly baseHash: string;
  readonly next: PolicyDocument;
  readonly changes: readonly ProposalChange[];
  readonly resolve: (outcome: ProposalOutcome) => void;
  /** An Apply or an Export is running: no second one starts, and the proposal cannot be replaced. */
  busy: boolean;
  /** The rules it was made from changed while it was shown; it stays stale. */
  stale: boolean;
  /** The page was closed while it was busy: it is discarded when the running move ends without finishing it. */
  closed: boolean;
}

/** The page's folder under media/, and the base name of its script and stylesheet (built, so no file name reads as a record id). */
const PAGE = 'policy';
const MAX_FROM = 120;
const MAX_REASON = 500;
const MAX_TEXT = 500;

let host: { context: { readonly extensionUri: vscode.Uri }; deps: PolicyEditorDeps } | undefined;
let panel: vscode.WebviewPanel | undefined;
let pending: Pending | undefined;
let notice: string | undefined;
let at: PolicySectionId | undefined;
let atSeq = 0;
let counter = 0;

const cut = (text: string, max: number) => text.slice(0, max);

/** Stores the host's dependencies; the returned disposable forgets them, closes the page and discards a shown proposal. */
export function registerPolicyEditor(context: { readonly extensionUri: vscode.Uri }, deps: PolicyEditorDeps): vscode.Disposable {
  host = { context, deps };
  const listener = deps.onDidChange(() => {
    if (pending !== undefined) checkStale(pending);
    void post();
  });
  return {
    dispose: () => {
      listener.dispose();
      panel?.dispose();
      if (pending !== undefined && !pending.busy) finish(pending, 'discarded');
      host = undefined;
    }
  };
}

function titleOf(state: PolicyEditorState | undefined): string {
  return state?.organization === undefined ? POLICY_EDITOR_TITLE_OWN : POLICY_EDITOR_TITLE;
}

function setByOf(state: PolicyEditorState | undefined): string {
  if (state === undefined) return '';
  return state.organization !== undefined && !state.organizationSignedHere ? SET_BY_ORGANIZATION_TEXT : SELF_SIGNED_RULES_TEXT;
}

function hashOf(state: PolicyEditorState, target: Target): string | undefined {
  return target === 'personal' ? state.personalHash : state.organization === undefined ? undefined : state.organizationHash;
}

/** Marks the proposal stale when the rules it was made from are no longer the ones stored, or cannot be read. True when it is stale. */
function checkStale(shown: Pending): boolean {
  if (shown.stale) return true;
  const state = host?.deps.state();
  if (state === undefined || hashOf(state, shown.target) !== shown.baseHash) {
    shown.stale = true;
    notice = STALE_DRAFT_TEXT;
  }
  return shown.stale;
}

/**
 * Edit my rules, and Apply my draft while a draft waits: only while your own rules can be read and this device has the key that signs them, and never
 * while a shown proposal is being applied or saved. The signer is asked only when the host offers the flow.
 */
function pageActionsOf(): PageAction[] {
  const deps = host?.deps;
  if (deps?.editOwn === undefined || pending?.busy === true) return [];
  if (deps.state() === undefined || deps.signer() === undefined) return [];
  return deps.applyDraft !== undefined && deps.hasDraft?.() === true ? ['edit-own', 'apply-draft'] : ['edit-own'];
}

/**
 * The proposal's buttons. Apply only on your own rules and only while this device has the key that signs them (D-44, IN-08): without it the host could
 * not sign the change, so only Discard is offered. Export is for your organization's rules, which your organization signs.
 */
function actionsOf(): Action[] {
  if (pending === undefined) return [];
  if (pending.stale || pending.changes.length === 0) return ['discard'];
  if (pending.target !== 'personal') return ['export', 'discard'];
  return host?.deps.signer() === undefined ? ['discard'] : ['apply', 'discard'];
}

async function post(): Promise<void> {
  if (panel === undefined || host === undefined) return;
  const view = panel;
  const state = host.deps.state();
  const title = titleOf(state);
  if (view.title !== title) view.title = title;
  const shown = pending;
  const proposal = shown === undefined ? undefined : {
    id: shown.id,
    from: shown.from,
    ...(shown.reason === undefined ? {} : { reason: shown.reason }),
    target: shown.target,
    stale: shown.stale,
    changes: shown.changes.map((change) => ({ section: change.section, key: change.key, direction: change.direction, effect: change.effect }))
  };
  const text = notice ?? (state === undefined
    ? host.deps.unavailableNotice?.() ?? UNREADABLE_TEXT
    : shown !== undefined && shown.changes.length === 0 ? NO_CHANGE_TEXT : undefined);
  await view.webview.postMessage({
    type: 'state',
    title,
    setBy: setByOf(state),
    sections: state === undefined ? [] : policySections(state.effective, state.effective.labels.scales),
    ...(proposal === undefined ? {} : { proposal }),
    actions: actionsOf(),
    pageActions: pageActionsOf(),
    ...(text === undefined ? {} : { notice: text }),
    ...(at === undefined ? {} : { at, atSeq })
  });
}

function show(): vscode.WebviewPanel {
  if (host === undefined) throw new Error('The rules page is not ready yet.');
  if (panel !== undefined) { panel.reveal(); return panel; }
  const view = openPanel(host.context, {
    viewType: POLICY_EDITOR_VIEW_TYPE, title: titleOf(host.deps.state()), folder: PAGE, script: `${PAGE}.js`, style: `${PAGE}.css`, probe: PAGE,
    body: '<header><h1 id="title"></h1><p id="set-by" class="hint"></p></header>\n<p id="notice" role="status" aria-live="polite"></p>\n'
      + '<section id="proposal" hidden></section>\n<div id="sections"></div>\n<div id="page-actions" class="page-actions"></div>'
  });
  panel = view;
  view.onDidDispose(() => {
    panel = undefined;
    const shown = pending;
    if (shown === undefined) return;
    if (shown.busy) shown.closed = true;
    else finish(shown, 'discarded');
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

/** Ends one proposal with an outcome; a proposal already ended or replaced is left as it is. */
function finish(shown: Pending, outcome: ProposalOutcome): void {
  if (pending === shown) pending = undefined;
  shown.resolve(outcome);
}

/** After a running move: a proposal whose page was closed meanwhile, and that the move did not finish, is discarded. */
function settleClosed(shown: Pending): void {
  if (shown.closed && pending === shown) finish(shown, 'discarded');
}

/** The shown proposal when the message names it by its id (a string), otherwise undefined. */
function proposalFor(message: Readonly<Record<string, unknown>>): Pending | undefined {
  const id = message['id'];
  return pending !== undefined && typeof id === 'string' && id === pending.id ? pending : undefined;
}

async function receive(message: unknown): Promise<void> {
  if (host === undefined || typeof message !== 'object' || message === null || Array.isArray(message)) return;
  const fields = message as Readonly<Record<string, unknown>>;
  const deps = host.deps;
  switch (fields['type']) {
    case 'ready': break;
    case 'apply': {
      const shown = proposalFor(fields);
      if (shown === undefined || shown.busy || !actionsOf().includes('apply') || checkStale(shown)) break;
      shown.busy = true;
      try {
        await applyProposal(deps, shown);
      } finally {
        shown.busy = false;
        settleClosed(shown);
      }
      break;
    }
    case 'export': {
      const shown = proposalFor(fields);
      if (shown === undefined || shown.busy || !actionsOf().includes('export') || checkStale(shown)) break;
      shown.busy = true;
      try {
        await exportProposal(deps, shown);
      } finally {
        shown.busy = false;
        settleClosed(shown);
      }
      break;
    }
    case 'discard': {
      const shown = proposalFor(fields);
      if (shown === undefined || shown.busy) break;
      notice = undefined;
      finish(shown, 'discarded');
      break;
    }
    case 'show-stored': await deps.showStored(); break;
    case 'reset': await deps.reset(); break;
    case 'edit-own': {
      if (!pageActionsOf().includes('edit-own')) break;
      await deps.editOwn?.();
      break;
    }
    case 'apply-draft': {
      // The draft becomes a proposal on this page, which settles only when it ends, so it is not awaited here.
      if (!pageActionsOf().includes('apply-draft')) break;
      void deps.applyDraft?.().catch(() => undefined).then(() => post());
      break;
    }
    default: break;
  }
}

function payloadOf(shown: Pending, target: { layer: 'personal' | 'organization'; hash: string; issuer: string }): ProposalPayload {
  return proposalPayload({ target, from: shown.from, ...(shown.reason === undefined ? {} : { reason: shown.reason }), changes: shown.changes });
}

async function applyProposal(deps: PolicyEditorDeps, shown: Pending): Promise<void> {
  const proposalHash = bundleHash(payloadOf(shown, { layer: 'personal', hash: shown.baseHash, issuer: shown.base.issuer.fingerprint }));
  const answer = await deps.applyPersonal(shown.next, shown.baseHash);
  if (!answer.ok) {
    notice = cut(answer.text, MAX_TEXT);
    return;
  }
  deps.record('policy.proposal-applied', { proposalHash, changes: shown.changes.length, from: shown.from });
  finish(shown, 'applied');
  notice = APPLIED_TEXT;
}

/** Your organization's contacts, the security contact first, as "name (how)". */
function contactsOf(state: PolicyEditorState): string[] {
  const contacts: readonly PolicyContact[] = state.organization?.onboarding?.contacts ?? [];
  const ordered = [...contacts.filter((contact) => contact.topic === 'security'), ...contacts.filter((contact) => contact.topic !== 'security')];
  return ordered.map((contact) => `${contact.name} (${contact.how})`);
}

function exportedNotice(contacts: readonly string[]): string {
  const send = contacts.length === 0 ? NO_CONTACT_TEXT : `Send this file to ${contacts.join(' or ')}.`;
  return `${PROPOSAL_EXPORTED_TEXT} ${send} ${ORGANIZATION_SENDS_TEXT}`;
}

const notWritten = (reason: string) => cut(`Nothing was written: ${reason.replace(/^Nothing was signed:\s*/, '')}`, MAX_TEXT);

async function exportProposal(deps: PolicyEditorDeps, shown: Pending): Promise<void> {
  const state = deps.state();
  if (state?.organization === undefined) return;
  const signer = deps.signer();
  if (signer === undefined) { notice = notWritten('this computer has no signing key yet.'); return; }
  let payload: ProposalPayload;
  let text: string;
  try {
    payload = payloadOf(shown, { layer: 'organization', hash: shown.baseHash, issuer: state.organizationIssuer ?? state.organization.issuer.fingerprint });
    text = `${JSON.stringify(signPayload(signer, 'policy-proposal', payload), null, 2)}\n`;
  } catch (error) {
    if (error instanceof PayloadError) { notice = notWritten(error.message); return; }
    throw error;
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const target = await vscode.window.showSaveDialog({
    title: 'Save a file for your organization',
    defaultUri: vscode.Uri.file(path.join(homedir(), `policy-proposal-${day}${PROPOSAL_FILE_EXTENSION}`)),
    filters: { 'Proposed rule change': [PROPOSAL_FILE_EXTENSION.slice(1)] },
    saveLabel: 'Save'
  });
  // Dismissed: nothing is written and the proposal stays shown.
  if (target === undefined) return;
  if (checkStale(shown)) return;
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  } catch (error) {
    notice = notWritten(error instanceof Error ? error.message : String(error));
    return;
  }
  deps.record('policy.proposal-exported', { proposalHash: bundleHash(payload), changes: shown.changes.length, from: shown.from });
  finish(shown, 'exported');
  notice = exportedNotice(contactsOf(state));
}

/** Opens the editor showing the rules, at one of the page's sections when `section` names one. */
export function openPolicyEditor(section?: PolicySectionId): void {
  const known = POLICY_SECTION_IDS.find((id) => id === section);
  at = known;
  if (known !== undefined) atSeq += 1;
  if (pending === undefined) notice = undefined;
  show();
  void post();
}

/**
 * Shows a proposed change and resolves with how it ended: applied, exported, discarded or replaced. Rejects, showing nothing, when the editor is not
 * registered, the rules cannot be read, your organization's rules are the target but there are none, the change gives no document, or a shown proposal
 * is being applied or saved right now.
 */
export function openPolicyProposal(change: PolicyChange): Promise<ProposalOutcome> {
  if (host === undefined) return Promise.reject(new Error('The rules page is not ready yet.'));
  if (pending?.busy === true) return Promise.reject(new Error('A change to your rules is being saved. Try again in a moment.'));
  const state = host.deps.state();
  if (state === undefined) return Promise.reject(new Error(`${UNREADABLE_TEXT} Nothing was proposed.`));
  const target: Target = change.target ?? (state.organization === undefined ? 'personal' : 'organization');
  const base = target === 'organization' ? state.organization : state.personal;
  const baseHash = hashOf(state, target);
  if (base === undefined || baseHash === undefined) {
    return Promise.reject(new Error("This computer has no rules from your organization, so nothing can be proposed to your organization."));
  }
  let next: PolicyDocument;
  let changes: readonly ProposalChange[];
  try {
    next = change.next(base);
    if (typeof next !== 'object' || next === null || Array.isArray(next)) throw new Error('The proposed rules are not a document.');
    changes = proposalOf(base, next, host.deps.directionOf, base.labels.scales);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  counter += 1;
  const id = `proposal-${String(counter)}`;
  const from = cut(typeof change.from === 'string' ? change.from : '', MAX_FROM);
  const reason = typeof change.reason === 'string' ? cut(change.reason, MAX_REASON) : undefined;
  return new Promise<ProposalOutcome>((resolve) => {
    const replaced = pending;
    pending = { id, from, ...(reason === undefined ? {} : { reason }), target, base, baseHash, next, changes, resolve, busy: false, stale: false, closed: false };
    if (replaced !== undefined) replaced.resolve('replaced');
    notice = undefined;
    at = undefined;
    show();
    void post();
  });
}
