import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AuthorizationBody } from '../domain/gate/authorizations';
import { effectiveMaxTier } from '../domain/gate/models';
import type { Passport } from '../domain/gate/models';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { REVOKE_ALL_USES } from '../domain/gate/passportState';
import { PROPOSAL_FILE_EXTENSION, proposalOf, proposalPayload } from '../domain/gate/proposal';
import type { DirectionOf } from '../domain/gate/proposal';
import { EXCEPTION_TEXT, draftRiskAcceptance, endsOnBounds, exceptionRow, fillException, legalFlagsLine, researchOnlyRow } from '../domain/gate/riskAcceptance';
import type { ExceptionDraftInput, ExceptionField } from '../domain/gate/riskAcceptance';
import { SHIPPED_PASSPORTS } from '../domain/gate/shippedPassports';
import { PayloadError, signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';

// The policy editor's "Exceptions for chat you review" section (74.1-11, D-20, 74.1-UI-SPEC S11). Shown only under your organization's rules. A named
// person drafts one exception at a time, reviews exactly what will be signed, signs it with this computer's key as their inner signature, and saves it as
// a request for your organization through the same "Save a file for your organization" path the editor uses. Nothing changes on this computer and no
// policy edit is recorded. Every page message is checked here field by field and must name the shown draft; the page only renders and posts.

/** What the section needs from the host, beyond the editor's own state and signer. */
export interface ExceptionDeps {
  /** The open projects, by the id an exception names (projectScopeId) and the folder's name. */
  projects(): readonly { readonly id: string; readonly name: string }[];
  now(): number;
}

export interface ExceptionEditorState {
  readonly organization?: PolicyDocument;
  readonly organizationHash?: string;
  readonly organizationIssuer?: string;
  readonly effective: PolicyDocument;
}

interface Draft {
  readonly id: string;
  readonly model: string;
  readonly issuedAt: string;
  stage: 'draft' | 'review' | 'signing';
  fields: Omit<ExceptionDraftInput, 'id' | 'model' | 'issuedAt'>;
  errors: Partial<Record<ExceptionField, string>>;
  body?: AuthorizationBody;
}

let draft: Draft | undefined;
let status: string | undefined;
let saved: string | undefined;
let counter = 0;

/** Forgets the section's draft (the page was closed, or a test starts over). */
export function resetExceptions(): void {
  draft = undefined;
  status = undefined;
  saved = undefined;
}

/** The research-only passports of the effective rules: your organization's and the shipped ones it does not replace, not withdrawn for every use. */
function researchOnlyPassports(effective: PolicyDocument, now: number): Passport[] {
  const own = effective.models?.passports ?? [];
  const ids = new Set(own.map((passport) => passport.id));
  return [...own, ...SHIPPED_PASSPORTS.filter((passport) => !ids.has(passport.id))]
    .filter((passport) => effectiveMaxTier(passport, now) === 'T0' && !passport.legal.removalOrders.includes(REVOKE_ALL_USES))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function passportOf(effective: PolicyDocument, id: string): Passport | undefined {
  return (effective.models?.passports ?? []).find((passport) => passport.id === id) ?? SHIPPED_PASSPORTS.find((passport) => passport.id === id);
}

function exceptionsOf(organization: PolicyDocument): SignedPayload<AuthorizationBody>[] {
  return (organization.authorizations ?? []).filter((envelope) => envelope.payload.kind === 't1-risk');
}

/** The first security contact of your organization's rules, as "name (how)", or the plain words for it. */
function contactOf(organization: PolicyDocument): string {
  const contacts = organization.onboarding?.contacts ?? [];
  const first = contacts.find((contact) => contact.topic === 'security') ?? contacts[0];
  return first === undefined ? EXCEPTION_TEXT.contactFallback : `${first.name} (${first.how})`;
}

function labelOptions(effective: PolicyDocument): Array<{ scale: string; labels: string[] }> {
  return Object.entries(effective.labels.scales).map(([id, scale]) => ({ scale: scale.name, labels: scale.levels.map((level) => `${id}/${level}`) }));
}

/** This device's listed signer entry in your organization's rules, if any. */
function listedSigner(organization: PolicyDocument, signer: PayloadSigner | undefined): { name: string; role: string } | undefined {
  if (signer === undefined) return undefined;
  return organization.people?.signers?.find((entry) => entry.fingerprint === signer.fingerprint && entry.publicKey === signer.publicKey);
}

/** The section's view for the page. */
export function exceptionsView(state: ExceptionEditorState | undefined, signer: PayloadSigner | undefined, deps: ExceptionDeps | undefined): Record<string, unknown> | undefined {
  if (state === undefined || deps === undefined) return undefined;
  const words = { ...EXCEPTION_TEXT, conditionDefaults: [...EXCEPTION_TEXT.conditionDefaults] };
  const organization = state.organization;
  if (organization === undefined) return { words, noOrg: EXCEPTION_TEXT.noOrg };
  const now = deps.now();
  const projects = deps.projects();
  const research = researchOnlyPassports(state.effective, now).map((passport) => ({ id: passport.id, text: researchOnlyRow(passport) }));
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const rows = exceptionsOf(organization).map((envelope) => {
    const row = exceptionRow(envelope.payload, now, { projectName: (id) => names.get(id) ?? id });
    return { id: envelope.payload.id, ...row, renew: signer !== undefined && envelope.signer.fingerprint === signer.fingerprint };
  });
  const view: Record<string, unknown> = { words, research, rows, oneDraft: draft !== undefined };
  if (status !== undefined) view['status'] = status;
  if (saved !== undefined) view['saved'] = saved;
  if (draft !== undefined) {
    const bounds = endsOnBounds(draft.issuedAt);
    const passport = passportOf(state.effective, draft.model);
    view['draft'] = {
      id: draft.id, model: draft.model, stage: draft.stage, title: fillException(EXCEPTION_TEXT.formTitle, { model: draft.model }),
      legal: legalFlagsLine(passport) || EXCEPTION_TEXT.legalNone, fields: draft.fields, errors: draft.errors,
      projects, labels: labelOptions(state.effective), ends: { ...bounds, hint: fillException(EXCEPTION_TEXT.endsHint, { date: fillDate(bounds.max) }) },
      ...(listedSigner(organization, signer) === undefined ? { keyNotListed: EXCEPTION_TEXT.personKeyNotListed } : {}),
      ...(draft.stage === 'draft' ? {} : { review: reviewOf(draft, passport, projects, organization) })
    };
  }
  return view;
}

function fillDate(day: string): string {
  const [year, month, date] = day.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(Number(date))} ${months[Number(month) - 1] ?? ''} ${year ?? ''}`;
}

/** Everything the signature will cover, in words (WCAG 3.3.4). */
function reviewOf(shown: Draft, passport: Passport | undefined, projects: readonly { id: string; name: string }[], organization: PolicyDocument): Record<string, unknown> {
  const body = shown.body;
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return {
    title: EXCEPTION_TEXT.reviewTitle,
    facts: [
      [EXCEPTION_TEXT.reviewModel, shown.model],
      [EXCEPTION_TEXT.reviewLegal, legalFlagsLine(passport) || EXCEPTION_TEXT.legalNone],
      [EXCEPTION_TEXT.useLabel, EXCEPTION_TEXT.useValue],
      [EXCEPTION_TEXT.projectsLabel, (body?.scope.projects ?? []).map((id) => names.get(id) ?? id).join(', ')],
      [EXCEPTION_TEXT.labelsLabel, (body?.scope.labels ?? []).join(', ')],
      [EXCEPTION_TEXT.conditionsLabel, Array.isArray(body?.conditions) ? (body?.conditions as string[]).join('; ') : ''],
      [EXCEPTION_TEXT.benefitLabel, body?.evidence ?? ''],
      [EXCEPTION_TEXT.personLabel, body === undefined ? '' : `${body.namedPerson.name}, ${body.namedPerson.role}`],
      [EXCEPTION_TEXT.endsLabel, fillDate(shown.fields.endsOn)]
    ],
    next: fillException(EXCEPTION_TEXT.reviewNext, { contact: contactOf(organization) })
  };
}

const strings = (value: unknown, max: number): string[] | undefined => (Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && entry.length <= 300) ? value as string[] : undefined);

/** The draft's fields from a page message, checked field by field against what the section offered; undefined when anything is malformed. */
function fieldsFrom(value: unknown, state: ExceptionEditorState, deps: ExceptionDeps): Draft['fields'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const projects = strings(fields['projects'], 64);
  const labels = strings(fields['labels'], 64);
  const conditions = strings(fields['conditions'], 16);
  const person = fields['person'];
  const benefit = fields['benefit'];
  const endsOn = fields['endsOn'];
  if (projects === undefined || labels === undefined || conditions === undefined || typeof benefit !== 'string' || benefit.length > 2000 || typeof endsOn !== 'string' || endsOn.length > 10) return undefined;
  if (typeof person !== 'object' || person === null) return undefined;
  const name = (person as Record<string, unknown>)['name'];
  const position = (person as Record<string, unknown>)['position'];
  if (typeof name !== 'string' || typeof position !== 'string' || name.length > 200 || position.length > 200) return undefined;
  // Only projects that are open and labels your rules have can be named.
  const open = new Set(deps.projects().map((project) => project.id));
  const known = new Set(labelOptions(state.effective).flatMap((scale) => scale.labels));
  if (!projects.every((project) => open.has(project)) || !labels.every((label) => known.has(label))) return undefined;
  return { projects, labels, conditions, benefit, person: { name, position }, endsOn };
}

/** Handles one exception message from the page. Returns true when the message was one of the section's. */
export async function receiveException(
  fields: Readonly<Record<string, unknown>>, state: ExceptionEditorState | undefined, signer: PayloadSigner | undefined, deps: ExceptionDeps | undefined, directionOf: DirectionOf
): Promise<boolean> {
  const type = fields['type'];
  if (typeof type !== 'string' || !type.startsWith('exception-')) return false;
  // No organization layer: no exception at all, whatever the page asks (D-20, T-74.1-57).
  if (state?.organization === undefined || deps === undefined) return true;
  const organization = state.organization;
  const named = (): Draft | undefined => (draft !== undefined && fields['draft'] === draft.id ? draft : undefined);
  switch (type) {
    case 'exception-ask':
    case 'exception-renew': {
      if (draft !== undefined) { status = EXCEPTION_TEXT.oneDraft; break; }
      const now = deps.now();
      if (deps.projects().length === 0) { status = EXCEPTION_TEXT.noProject; break; }
      let model: string | undefined;
      let from: AuthorizationBody | undefined;
      if (type === 'exception-ask') {
        const asked = fields['model'];
        model = researchOnlyPassports(state.effective, now).find((passport) => passport.id === asked)?.id;
      } else {
        const envelope = exceptionsOf(organization).find((entry) => entry.payload.id === fields['id']);
        // Renew only one this computer's key signed: the named person renews their own.
        if (envelope !== undefined && signer !== undefined && envelope.signer.fingerprint === signer.fingerprint && 'model' in envelope.payload.subject) {
          from = envelope.payload;
          model = envelope.payload.subject.model;
        }
      }
      if (model === undefined) break;
      const issuedAt = new Date(now).toISOString();
      const listed = listedSigner(organization, signer);
      counter += 1;
      const id = `ra-${issuedAt.slice(0, 10).replace(/-/g, '')}-${String(now % 1_000_000).padStart(6, '0')}${String(counter)}`;
      const open = new Set(deps.projects().map((project) => project.id));
      draft = {
        id, model, issuedAt, stage: 'draft', errors: {},
        fields: {
          projects: (from?.scope.projects ?? []).filter((project) => open.has(project)),
          labels: [...(from?.scope.labels ?? [])],
          conditions: Array.isArray(from?.conditions) ? [...(from?.conditions as string[])] : [...EXCEPTION_TEXT.conditionDefaults],
          // A renewal's mission benefit is written again (74.1-UI-SPEC: renew keeps the scope, not the benefit).
          benefit: '',
          person: { name: listed?.name ?? from?.namedPerson.name ?? '', position: listed?.role ?? from?.namedPerson.role ?? '' },
          endsOn: endsOnBounds(issuedAt).fallback
        }
      };
      status = undefined;
      saved = undefined;
      break;
    }
    case 'exception-review': {
      const shown = named();
      if (shown === undefined || shown.stage !== 'draft') break;
      const given = fieldsFrom(fields['fields'], state, deps);
      if (given === undefined) break;
      shown.fields = given;
      const result = draftRiskAcceptance({ id: shown.id, model: shown.model, issuedAt: shown.issuedAt, ...given });
      if (!result.ok) { shown.errors = result.errors; break; }
      shown.errors = {};
      shown.body = result.body;
      shown.stage = 'review';
      break;
    }
    case 'exception-change': {
      const shown = named();
      if (shown !== undefined && shown.stage === 'review') shown.stage = 'draft';
      break;
    }
    case 'exception-close': {
      if (named() !== undefined && draft?.stage !== 'signing') { draft = undefined; status = undefined; }
      break;
    }
    case 'exception-sign': {
      const shown = named();
      if (shown === undefined || shown.stage !== 'review' || shown.body === undefined) break;
      shown.stage = 'signing';
      try {
        await signAndSave(shown, shown.body, organization, state, signer, directionOf);
      } finally {
        if (draft === shown && shown.stage === 'signing') shown.stage = 'review';
      }
      break;
    }
    default: break;
  }
  return true;
}

async function signAndSave(shown: Draft, body: AuthorizationBody, organization: PolicyDocument, state: ExceptionEditorState, signer: PayloadSigner | undefined, directionOf: DirectionOf): Promise<void> {
  if (signer === undefined) { status = fillException(EXCEPTION_TEXT.signFailed, { reason: 'this computer has no signing key yet' }); return; }
  let text: string;
  try {
    // The named person's inner signature, at exactly the draft's time (the record's issuedAt is its signing time).
    const envelope = signPayload(signer, 'policy-authorization', body, { now: () => new Date(body.issuedAt) });
    const next = { ...organization, authorizations: [...(organization.authorizations ?? []), envelope].sort((a, b) => (a.payload.id < b.payload.id ? -1 : 1)) } as PolicyDocument;
    const changes = proposalOf(organization, next, directionOf, organization.labels.scales);
    const payload = proposalPayload({
      target: { layer: 'organization', hash: state.organizationHash ?? '', issuer: state.organizationIssuer ?? organization.issuer.fingerprint },
      from: EXCEPTION_TEXT.sectionTitle, reason: body.evidence, changes
    });
    text = `${JSON.stringify(signPayload(signer, 'policy-proposal', payload), null, 2)}\n`;
  } catch (error) {
    const reason = error instanceof PayloadError || error instanceof Error ? error.message.replace(/^Nothing was signed:\s*/, '').replace(/\.$/, '') : String(error);
    status = fillException(EXCEPTION_TEXT.signFailed, { reason });
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Save a file for your organization',
    defaultUri: vscode.Uri.file(path.join(homedir(), `exception-request-${body.id}${PROPOSAL_FILE_EXTENSION}`)),
    filters: { 'Proposed rule change': [PROPOSAL_FILE_EXTENSION.slice(1)] },
    saveLabel: 'Save'
  });
  if (target === undefined) { status = EXCEPTION_TEXT.notSaved; return; }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  } catch (error) {
    status = fillException(EXCEPTION_TEXT.signFailed, { reason: (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') });
    return;
  }
  draft = undefined;
  status = undefined;
  saved = fillException(EXCEPTION_TEXT.saved, { file: target.fsPath, contact: contactOf(organization) });
  void shown;
}
