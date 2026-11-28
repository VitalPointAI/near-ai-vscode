// SovAI: Add Your Organization's Rules (FND-01, D-11 to D-14, D-20, D-27): the command a person runs to take the enrolment file or the rules file their
// organization's security contact gave them, and the one-time notices at start. Editor layer: it shows the file picker and the messages, and leaves every
// check to the organization store and the host, which judge the file again under their lock.
//
// A new key, or a key handover, is used only after the person compared the twelve words aloud and pressed the one button that says so; closing the modal
// writes nothing. A newer rules file signed by the pinned key needs no words. An older, foreign or broken file is refused, said and recorded.
import { readFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { bundleHash } from '../domain/gate/bundle';
import {
  ENROLMENT_FILE_EXTENSION, ISSUER_WORDS_MATCH, ORGANIZATION_LAYER_REFUSALS, ORGANIZATION_RULES_FILE_EXTENSION, ROTATION_WORDS_LEAD, contactShown, issuerDetailsLine,
  issuerWordsPrompt, issuerWordsQuestion, organizationEndingText
} from '../domain/gate/enrolment';
import { ignoredSettingsNotice } from '../domain/gate/layers';
import type { IgnoredSetting } from '../domain/gate/layers';
import { MAX_ORGANIZATION_LAYER_BYTES } from '../domain/gate/policyDocument';
import type { GateHost } from '../gate/host';
import { OrganizationStoreError, migrationNoticeText, previewOrganizationFile } from '../gate/organizationStore';
import type { SecretStorageLike } from './auth';

export const ADD_ORGANIZATION_RULES_COMMAND = 'nearAi.organization.addRules';

/** How one run of the command ended. */
export type AddRulesOutcome = 'enrolled' | 'rotated' | 'updated' | 'unchanged' | 'declined' | 'refused' | 'cancelled';

/** The memento keys of the one-time notices (D-20, D-27): the personal layer's hash, and the hash of the ignored list, last told. */
export const MIGRATION_NOTICE_KEY = 'nearAi.policy.migrationNoticeShown';
export const IGNORED_NOTICE_KEY = 'nearAi.policy.ignoredNoticeShown';

export const UNCHANGED_RULES_TEXT = 'These are the rules already in use. Nothing was changed.';
export const RULES_NOT_USED_TEXT = "Nothing was changed: SovAI could not use your organization's rules.";
export const RULES_FILE_UNREADABLE_TEXT = 'Nothing was changed: SovAI could not read that file.';

export function enrolledText(name: string): string {
  return `Your organization's rules from ${name} are now in use on this computer.`;
}

export function rotatedText(name: string): string {
  return `Your organization's new key is now in use on this computer, with the rules from ${name}.`;
}

export function updatedText(date: string): string {
  return `Your organization's rules dated ${date} are now in use.`;
}

/** The few Memento members the notices use. Optional everywhere: without one every notice counts as not yet shown (a lost flag only repeats it). */
export interface NoticeMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface AddRulesDeps {
  readonly globalStorageDir: string;
  readonly secrets: SecretStorageLike;
  /** The host's time, in epoch milliseconds. */
  readonly now: () => number;
  /** Shows a plain notice (the ignored settings). */
  readonly tell: (message: string) => void;
  readonly memento?: NoticeMemento;
}

const NAME_FALLBACK = 'your organization';

function warn(message: string): void {
  void Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => undefined);
}

function inform(message: string): void {
  void Promise.resolve(vscode.window.showInformationMessage(message)).catch(() => undefined);
}

/** The ignored list as one value, so a list told before is not told again and a changed one is. */
function ignoredHash(ignored: readonly IgnoredSetting[]): string {
  return bundleHash(ignored.map((entry) => ({ key: entry.key, yours: entry.yours, allowed: entry.allowed })));
}

/** Tells the ignored settings when there are any and records the list as told. `always` tells it even when this list was told before (after an acceptance). */
async function tellIgnored(host: GateHost, tell: (message: string) => void, memento: NoticeMemento | undefined, always: boolean): Promise<void> {
  const ignored = host.policyLayers().ignored;
  const notice = ignoredSettingsNotice(ignored);
  if (notice === undefined) return;
  const hash = ignoredHash(ignored);
  if (!always && memento?.get(IGNORED_NOTICE_KEY) === hash) return;
  tell(notice);
  await Promise.resolve(memento?.update(IGNORED_NOTICE_KEY, hash)).catch(() => undefined);
}

/**
 * SovAI: Add Your Organization's Rules. Picks one file, refuses one too large before reading it, previews it (nothing written), asks for the twelve words
 * for a new key or a handover, and only then hands it to the host, which reads it again under its lock.
 */
export async function addOrganizationRules(host: GateHost, deps: AddRulesDeps): Promise<AddRulesOutcome> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Use these rules',
    filters: { "Your organization's rules": [ENROLMENT_FILE_EXTENSION.slice(1), ORGANIZATION_RULES_FILE_EXTENSION.slice(1)] }
  });
  const file = picked?.[0]?.fsPath;
  if (file === undefined) return 'cancelled';
  await host.state();
  const refuse = (sentence: string, reason: string): AddRulesOutcome => {
    warn(sentence);
    host.recordPolicyEvent('policy.organization-refused', reason);
    return 'refused';
  };
  let text: string;
  try {
    // T-41-141: the size is checked before anything is read into memory.
    if ((await stat(file)).size > MAX_ORGANIZATION_LAYER_BYTES) return refuse(ORGANIZATION_LAYER_REFUSALS['too-large'], 'too-large');
    text = await readFile(file, 'utf8');
  } catch {
    warn(RULES_FILE_UNREADABLE_TEXT);
    return 'refused';
  }
  const preview = await previewOrganizationFile(deps.globalStorageDir, deps.secrets, text, deps.now());
  if (preview.kind === 'refused') return refuse(preview.sentence, preview.reason);
  if (preview.kind === 'same') {
    inform(UNCHANGED_RULES_TEXT);
    return 'unchanged';
  }
  const name = preview.name ?? NAME_FALLBACK;
  // An update, or the rules in use written again over a missing or replaced copy, is signed by the key in use: no words to compare (WR-01).
  const pinnedKey = preview.kind === 'update' || preview.kind === 'repair';
  if (!pinnedKey && preview.kind !== 'resume') {
    // A new key or a handover: the words are compared aloud first (D-12, D-14). A file that gives no words is never taken without them.
    if (preview.words === undefined) return refuse(ORGANIZATION_LAYER_REFUSALS.malformed, 'malformed');
    const question = preview.kind === 'rotate' ? `${ROTATION_WORDS_LEAD} ${issuerWordsQuestion(name)}` : issuerWordsQuestion(name);
    const detail = `${issuerWordsPrompt(preview.words)}\n\n${issuerDetailsLine(preview.fingerprintHex)}`;
    const answer = await vscode.window.showWarningMessage(question, { modal: true, detail }, ISSUER_WORDS_MATCH);
    if (answer !== ISSUER_WORDS_MATCH) return 'declined';
  }
  try {
    const confirmation = preview.kind === 'resume' ? { expectedPending: preview.expectedPending } : pinnedKey ? {} : { wordsConfirmed: true };
    const state = await host.acceptOrganizationFile(text, confirmation);
    if (state.state !== 'valid') warn(state.sentence);
  } catch (error) {
    // The host recorded a refused file already; a change that could not be written is said in its own words.
    warn(error instanceof OrganizationStoreError ? error.message : RULES_NOT_USED_TEXT);
    return 'refused';
  }
  const outcome: AddRulesOutcome = preview.kind === 'enrol' ? 'enrolled' : (preview.kind === 'rotate' || preview.kind === 'resume') ? 'rotated' : 'updated';
  inform(outcome === 'enrolled' ? enrolledText(name) : outcome === 'rotated' ? rotatedText(name) : updatedText(preview.issuedAt.slice(0, 10)));
  await tellIgnored(host, deps.tell, deps.memento, true);
  return outcome;
}

/**
 * The notices at start (D-20, D-27, D-14): the migration of a v1 personal layer's local servers once per personal layer (recorded as policy.migrated),
 * the personal settings your organization ignores once per distinct list, and your organization's rules ending soon once per window.
 */
export async function startNotices(host: GateHost, context: { readonly globalState?: NoticeMemento }, tell: (message: string) => void): Promise<{ migrationShown: boolean }> {
  await host.state();
  const layers = host.policyLayers();
  const memento = context.globalState;
  let migrationShown = false;
  const migration = migrationNoticeText(layers.migration);
  const personalHash = layers.personal?.hash;
  if (migration !== undefined && personalHash !== undefined && memento?.get(MIGRATION_NOTICE_KEY) !== personalHash) {
    tell(migration);
    migrationShown = true;
    await Promise.resolve(memento?.update(MIGRATION_NOTICE_KEY, personalHash)).catch(() => undefined);
    host.recordPolicyEvent('policy.migrated', `${String(layers.migration.length)} local servers`);
  }
  await tellIgnored(host, tell, memento, false);
  const organization = layers.organization;
  if (organization.state === 'valid' && organization.endsSoon) tell(organizationEndingText(organization.expiresAt.slice(0, 10), contactShown(organization.contacts)));
  return { migrationShown };
}
