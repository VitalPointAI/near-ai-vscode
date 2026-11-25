/**
 * What the native Issue credential card shows (Phase 71, 71-12; D-15, D-21, D-22), as plain data the widget renders: the issue steps (form, review,
 * confirm, result), the officer's issued credentials with the actions each state allows, and the "Credentials to revoke" section, which exists only
 * while a revocation request is open. Every sentence about a credential comes from the backend (issueForm.ts through the issuer service); this
 * file adds only the card's own headings and buttons. State is never shown by colour alone: each row carries its state in words. No Theia here.
 */
import type { IssuableType, IssuedCredentialView, RevocationComputerView, RevocationRequestView } from './issuer-service.js';

export const CARD_TEXT = {
  title: 'Issue credential',
  command: 'Issue Credential',
  intro: 'Issue a credential your role allows, to a person in your organization. You read exactly what you sign before you confirm.',
  type: 'Credential',
  nothingIssuable: 'Your roles do not allow issuing any credential here.',
  review: 'Review',
  confirm: 'Confirm and sign',
  back: 'Back',
  cancel: 'Cancel',
  signing: 'Waiting for your passkey or security key…',
  issued: 'Credentials you issued',
  noneIssued: 'You have not issued any credentials yet.',
  toRevoke: 'Credentials to revoke',
  toRevokeIntro: 'Your organization ended these people\'s access. Revoke or suspend what you issued to them.',
  seen: 'Seen',
  revoke: 'Revoke',
  suspend: 'Suspend',
  lift: 'Lift suspension',
  download: 'Save the file',
  refresh: 'Refresh',
  noneOfYours: 'You issued nothing to this person that is still active.',
  computer: 'computer',
  revokeComputer: 'Revoke this computer',
} as const;

export const STATE_TEXT: Readonly<Record<IssuedCredentialView['state'], string>> = {
  active: 'Active', suspended: 'Suspended', revoked: 'Revoked', unknown: 'Status not known right now',
};
/** The codicon beside each state, so the state reads without colour. */
export const STATE_ICON: Readonly<Record<IssuedCredentialView['state'], string>> = {
  active: 'pass', suspended: 'debug-pause', revoked: 'circle-slash', unknown: 'question',
};

export type CardAction = 'revoke' | 'suspend' | 'lift' | 'revoke-computer';

export interface CredentialRow {
  readonly hash: string;
  readonly title: string;
  readonly state: string;
  readonly icon: string;
  readonly until: string;
  /** Each action with the sentence read before the step-up. */
  readonly actions: readonly { readonly action: CardAction; readonly label: string; readonly review: string }[];
}

/** Which actions a credential's state allows: a revocation is final, a suspension can be lifted, an unknown state allows nothing yet. */
export function rowFor(view: IssuedCredentialView): CredentialRow {
  const action = (name: 'revoke' | 'suspend' | 'lift'): { action: CardAction; label: string; review: string } => ({
    action: name, label: name === 'revoke' ? CARD_TEXT.revoke : name === 'suspend' ? CARD_TEXT.suspend : CARD_TEXT.lift, review: view.reviews[name],
  });
  const actions = view.state === 'active' ? [action('revoke'), action('suspend')] : view.state === 'suspended' ? [action('revoke'), action('lift')] : [];
  return { hash: view.hash, title: `${view.personName}: ${view.label}`, state: STATE_TEXT[view.state], icon: STATE_ICON[view.state], until: view.validUntil, actions };
}

export interface RequestSection {
  readonly id: string;
  readonly heading: string;
  readonly detail: string;
  readonly seenAt?: string;
  /** Only the credentials this officer issued to the person that are not revoked; each with Revoke and Suspend (or Lift). */
  readonly rows: readonly CredentialRow[];
  readonly empty?: string;
}

/** A computer a request names (D-25): Revoke only, which a named officer does; the binding's state in words. */
export function computerRow(view: RevocationComputerView): CredentialRow {
  const state = view.state === 'revoked' ? 'revoked' : view.state === 'unknown' ? 'unknown' : 'active';
  return {
    hash: `computer-${String(view.slot)}`, title: `${CARD_TEXT.computer} ${view.device.slice(4, 12)} (bound ${view.claimedAt.slice(0, 10)})`, state: STATE_TEXT[state], icon: STATE_ICON[state],
    until: '', actions: view.state === 'active' ? [{ action: 'revoke-computer', label: CARD_TEXT.revokeComputer, review: view.review }] : [],
  };
}

/** The "Credentials to revoke" section: undefined when no request is open, so the section disappears. */
export function requestsSection(requests: readonly RevocationRequestView[]): readonly RequestSection[] | undefined {
  if (requests.length === 0) return undefined;
  return requests.map((request) => {
    if (!request.current) return { id: request.id, heading: request.message, detail: '', rows: [] };
    const rows = [...request.credentials.filter((view) => view.state !== 'revoked').map(rowFor), ...request.computers.filter((view) => view.state !== 'revoked').map(computerRow)];
    return {
      id: request.id, heading: request.personName, detail: request.reasonText, seenAt: request.seenAt, rows,
      ...(rows.length === 0 ? { empty: CARD_TEXT.noneOfYours } : {}),
    };
  });
}

/** The issue steps. Each step shows one thing; a refusal keeps the form filled in and says why in one sentence. */
export type IssueStep =
  | { readonly step: 'form'; readonly message?: string }
  | { readonly step: 'review'; readonly sentence: string }
  | { readonly step: 'signing'; readonly sentence: string }
  | { readonly step: 'done'; readonly sentence: string; readonly fileName?: string };

export type IssueEvent =
  | { readonly kind: 'reviewed'; readonly sentence: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly fix?: string }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'back' }
  | { readonly kind: 'issued'; readonly sentence: string; readonly fileName?: string }
  | { readonly kind: 'again' };

/** The next step. Only a review can be confirmed; a refusal at any step returns to the filled-in form with its sentence. */
export function nextStep(current: IssueStep, event: IssueEvent): IssueStep {
  switch (event.kind) {
    case 'reviewed': return current.step === 'form' ? { step: 'review', sentence: event.sentence } : current;
    case 'confirm': return current.step === 'review' ? { step: 'signing', sentence: current.sentence } : current;
    case 'issued': return current.step === 'signing' ? { step: 'done', sentence: event.sentence, ...(event.fileName === undefined ? {} : { fileName: event.fileName }) } : current;
    case 'refused': return { step: 'form', message: event.fix === undefined ? event.reason : `${event.reason} ${event.fix}.` };
    case 'back': return current.step === 'review' ? { step: 'form' } : current;
    case 'again': return { step: 'form' };
    default: return current;
  }
}

/** The type picker: the issuable types, each with its ceiling in words. */
export function typeOptions(types: readonly IssuableType[]): readonly { readonly value: string; readonly label: string }[] {
  return types.map((type) => ({ value: type.type, label: type.ceiling === undefined ? type.label : `${type.label} (up to ${type.ceiling})` }));
}
