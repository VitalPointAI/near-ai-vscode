// The policy editor's wiring (FND-09, D-44): the port the gate's commands reach the editor page through, the host-backed dependencies the page is given,
// and Apply Policy Draft as a proposal on that page. Editor layer. The page applies a change only through `applyPersonal`, which hands it to the host's own
// checks (the stale base, the widening check against your organization's rules, the signature); nothing here signs or writes the policy itself.
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { projectScopeId } from '../domain/contextGraph';
import { narrowingOf } from '../domain/gate/layers';
import { CLEARANCE_SELF_ASSERTED_TEXT } from '../domain/gate/labels';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PolicySectionId } from '../domain/gate/proposal';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { BundleStoreError, POLICY_DRAFT_BASE_FILE, POLICY_DRAFT_FILE, STALE_DRAFT_TEXT, gateDir, parsePolicyDraft } from '../gate/bundleStore';
import type { GateHost } from '../gate/host';
import { NO_SECRET_STORAGE_TEXT } from '../gate/organizationStore';
import { loadDeviceIdentity } from '../team/identity';
import type { SecretStorageLike } from './auth';
import { standingOrdersInstructions } from './gateStatusBar';
import { openPolicyEditor, openPolicyProposal, registerPolicyEditor } from './policyEditor';
import type { PolicyChange, PolicyEditorDeps, PolicyEditorState, ProposalOutcome } from './policyEditor';

export const POLICY_APPLIED_TEXT = `Your Standing Orders were changed, signed with this computer's key and recorded. ${CLEARANCE_SELF_ASSERTED_TEXT}`;
export const NO_DRAFT_TEXT = 'There is no draft to apply. Open SovAI: Standing Orders and choose Edit my Standing Orders first.';
export const OPEN_FAILED_TEXT = 'SovAI could not open your Standing Orders.';
const APPLY_FAILED_TEXT = 'SovAI could not apply your Standing Orders draft. Nothing was changed.';
const UNTRUSTED_TEXT = 'SovAI could not verify your Standing Orders. Nothing was changed.';
/** Origin used in proposal hashes and decision records. */
const DRAFT_FROM = 'Edit my rules';

/** How the gate's commands reach the policy editor page; a test passes its own. */
export interface PolicyEditorPort {
  register(deps: PolicyEditorDeps): { dispose(): unknown };
  open(at?: string): unknown;
  propose(change: PolicyChange): Promise<ProposalOutcome>;
}

/** The real page (41-08), or undefined when the context has no extension folder to load it from. */
export function defaultPolicyEditorPort(context: { readonly extensionUri?: vscode.Uri }): PolicyEditorPort | undefined {
  const extensionUri = context.extensionUri;
  if (extensionUri === undefined) return undefined;
  return {
    register: (deps) => registerPolicyEditor({ extensionUri }, deps),
    open: (at) => { openPolicyEditor(at as PolicySectionId | undefined); },
    propose: (change) => openPolicyProposal(change)
  };
}

/** The editor's view of the host's layers: undefined while the personal layer, or the policy in force, cannot be read (your organization's failure). */
export function editorStateOf(host: GateHost, devicePublicKey: string | undefined): PolicyEditorState | undefined {
  const layers = host.policyLayers();
  if (layers.personal === undefined || layers.effective === undefined) return undefined;
  const organization = layers.organization.state === 'valid' ? layers.organization : undefined;
  return {
    personal: layers.personal.document,
    personalHash: layers.personal.hash,
    ...(organization === undefined ? {} : { organization: organization.document, organizationHash: organization.hash, organizationIssuer: organization.document.issuer.fingerprint }),
    organizationSignedHere: organization !== undefined && devicePublicKey !== undefined && organization.issuerPublicKey === devicePublicKey,
    effective: layers.effective
  };
}

export interface PolicyEditorHooks {
  readonly secrets: SecretStorageLike;
  /** Today's confirmed Reset flow; the only caller of the host's reset stays the gate's commands. */
  reset(): Promise<unknown>;
  /** Today's read-only stored text view. */
  showStored(): Promise<void>;
  /** Edit Policy and Apply Policy Draft, for the page's Edit my rules and Apply my draft; the draft lives under this storage folder. */
  readonly ownRules?: { readonly globalStorageDir: string; edit(): Promise<unknown>; applyDraft(): Promise<unknown> };
}

/** The host-backed deps the page is registered with, and a disposer for the device key refresh. */
export function policyEditorDeps(host: GateHost, hooks: PolicyEditorHooks): { readonly deps: PolicyEditorDeps; dispose(): void } {
  // This device's signer, loaded once the host has started and again on each host change (a reset may make a new key history).
  let identity: PayloadSigner | undefined;
  const load = (): void => {
    void host.state().then(() => loadDeviceIdentity(hooks.secrets)).then((found) => { identity = found; }).catch(() => undefined);
  };
  load();
  const stop = host.onDidChange(load);
  const deps: PolicyEditorDeps = {
    state: () => editorStateOf(host, identity?.publicKey),
    unavailableNotice: () => {
      const state = host.bundleState();
      if (state.state === 'valid') return undefined;
      return state.sentence === NO_SECRET_STORAGE_TEXT
        ? `${NO_SECRET_STORAGE_TEXT} Ask your administrator to set up a secret store, then reopen the workbench.`
        : state.sentence || undefined;
    },
    // One key path for the narrowing table: the section, then the key, any [id] read as [] (41-02).
    directionOf: (section, key, before, after) => narrowingOf(`${section}.${key}`.replace(/\[[^\]]*\]/g, '[]'), before, after, host.policyLayers().effective?.labels.scales),
    applyPersonal: async (next, baseHash) => {
      const personal = host.policyLayers().personal;
      if (personal === undefined) return { ok: false, text: UNTRUSTED_TEXT };
      if (personal.hash !== baseHash) return { ok: false, text: `Nothing was changed. ${STALE_DRAFT_TEXT}` };
      try {
        const result = await host.applyPolicyDraft(`${JSON.stringify(next, null, 2)}\n`, baseHash);
        return result.state.state === 'valid' ? { ok: true } : { ok: false, text: result.state.sentence };
      } catch (error) {
        return { ok: false, text: error instanceof BundleStoreError ? error.message : APPLY_FAILED_TEXT };
      }
    },
    signer: () => identity,
    reset: async () => { await hooks.reset(); },
    showStored: () => hooks.showStored(),
    record: (id, detail) => { host.recordPolicyEvent(id, `${String(detail.changes)} changes from ${detail.from}, proposal ${detail.proposalHash.slice(0, 16)}`); },
    onDidChange: (listener) => ({ dispose: host.onDidChange(listener) }),
    // 74.1-11: the open folders by the id an exception names; no file is read (Restricted Mode is identical).
    exceptions: {
      projects: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ id: projectScopeId(folder.uri.fsPath), name: folder.name })),
      now: () => host.now()
    },
    ...(hooks.ownRules === undefined ? {} : ownRulesDeps(hooks.ownRules))
  };
  return { deps, dispose: stop };
}

function ownRulesDeps(own: NonNullable<PolicyEditorHooks['ownRules']>): Pick<PolicyEditorDeps, 'editOwn' | 'hasDraft' | 'applyDraft'> {
  return {
    editOwn: async () => { await own.edit(); },
    hasDraft: () => existsSync(draftFiles(own.globalStorageDir).draft),
    applyDraft: async () => { await own.applyDraft(); }
  };
}

export function draftFiles(globalStorageDir: string): { readonly draft: string; readonly base: string } {
  return { draft: path.join(gateDir(globalStorageDir), POLICY_DRAFT_FILE), base: path.join(gateDir(globalStorageDir), POLICY_DRAFT_BASE_FILE) };
}

export async function discardDraft(globalStorageDir: string): Promise<void> {
  const files = draftFiles(globalStorageDir);
  await rm(files.draft, { force: true });
  await rm(files.base, { force: true });
}

function warn(message: string): void {
  void Promise.resolve(vscode.window.showWarningMessage(standingOrdersInstructions(message))).catch(() => undefined);
}

/**
 * SovAI: Apply Policy Draft (D-41, D-44, D-53). Reads the draft and the hash it was made from; a draft made from another personal layer is stale and an
 * invalid one is refused with its plain reason, both before anything is proposed. A good draft is shown on the policy page as a proposal against the
 * personal layer, and is applied only from there. Applied: the draft files are removed. Any other ending keeps the draft. Returns true when applied.
 */
export async function proposeDraft(host: GateHost, globalStorageDir: string, port: PolicyEditorPort | undefined): Promise<boolean> {
  const files = draftFiles(globalStorageDir);
  // A draft open in the editor with changes not yet saved is saved first, so what is proposed is what the person sees.
  try {
    const open = vscode.workspace.textDocuments?.find((document) => document.uri.fsPath === files.draft);
    if (open?.isDirty === true) await open.save();
  } catch { /* the saved draft on disk is proposed */ }
  let draft: string;
  let base: string;
  try {
    draft = await readFile(files.draft, 'utf8');
    base = (await readFile(files.base, 'utf8')).trim();
  } catch {
    warn(NO_DRAFT_TEXT);
    return false;
  }
  // T-41-142: with no page to show it on, a draft is never applied unseen.
  if (port === undefined) { warn(OPEN_FAILED_TEXT); return false; }
  const state = await host.state();
  const personal = host.policyLayers().personal;
  if (personal === undefined) { warn(`${UNTRUSTED_TEXT}${state.state === 'failed-closed' ? ` ${state.sentence}` : ''}`); return false; }
  if (base !== personal.hash) { warn(`Nothing was changed. ${STALE_DRAFT_TEXT}`); return false; }
  let next: PolicyDocument;
  try {
    // Read the way the host reads it; the host sets the signer and the dates again when it signs.
    next = parsePolicyDraft(draft, { issuer: personal.document.issuer, issuedAt: personal.document.issuedAt, expiresAt: personal.document.expiresAt });
  } catch (error) {
    warn(error instanceof BundleStoreError ? error.message : APPLY_FAILED_TEXT);
    return false;
  }
  let outcome: ProposalOutcome;
  try {
    outcome = await port.propose({ from: DRAFT_FROM, target: 'personal', next: () => next });
  } catch (error) {
    warn(error instanceof Error ? error.message : APPLY_FAILED_TEXT);
    return false;
  }
  if (outcome !== 'applied') return false;
  await discardDraft(globalStorageDir).catch(() => undefined);
  void Promise.resolve(vscode.window.showInformationMessage(POLICY_APPLIED_TEXT)).catch(() => undefined);
  return true;
}
