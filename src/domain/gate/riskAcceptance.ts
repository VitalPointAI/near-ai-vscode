// An exception for chat you review (74.1 D-20, provenance design 5.3, owner O3): one model, approved for research only, allowed for chat a person reviews
// in named projects and labels for at most 90 days, by a named person of your organization. On screen it is an "exception" (owner, 2026-11-25); in records
// and code it is a `t1-risk` authorization ("risk acceptance" never appears on screen). Pure: no clock (the caller passes the time) and no key (signing is
// the editor's). It exists only under your organization's rules: with no organization layer nothing is drafted, and nothing signed on one computer alone
// allows a model.
import { AUTHORIZATION_ID_PATTERN, MAX_DAYS_BY_KIND, SUBJECT_VALUE_PATTERN, parseAuthorizationBody } from './authorizations';
import type { AuthorizationBody } from './authorizations';
import type { Passport } from './models';
import { dateShown, originShown } from './placeWords';

/** Every sentence of the exception section (74.1-UI-SPEC S11). Placeholders in braces are filled by code. */
export const EXCEPTION_TEXT = Object.freeze({
  sectionTitle: 'Exceptions for chat you review',
  sectionIntro: 'An exception lets one model that is approved for research only answer chat you review, in named projects and labels, for at most 90 days. A named person in your organization signs it, and it counts only when your organization\'s rules carry it.',
  noOrg: 'Exceptions need your organization\'s rules. This computer has none, so no exception can be drafted, and nothing signed on this computer allows a model. Models approved for research only stay in the research workspace.',
  researchOnlyTitle: 'Models approved for research only',
  exceptionsTitle: 'Exceptions',
  rowResearchOnly: '{model} · {origin} · Research only',
  ask: 'Ask to allow for chat you review',
  rowActive: '{model}: Allowed for chat you review by {name} until {date}',
  rowScope: 'Projects: {projects}. Labels: {labels}.',
  rowEnded: '{model}: Ended on {date}',
  rowTriggered: '{model}: Ended on {date}, because the model changed ({change})',
  rowWithdrawn: '{model}: Withdrawn by your organization on {date}',
  renew: 'Renew exception',
  oneDraft: 'Finish or close the open request first.',
  formTitle: 'Ask to allow {model} for chat you review',
  legalTitle: 'Read first',
  legalNone: 'No legal flags are recorded for this model.',
  legalEntityList: 'On the US Entity List.',
  legalCoveredByUsLaw: 'Covered AI under a US law (FY2026 NDAA Sec. 1532).',
  legalRemoval: 'Removal ordered: {order}.',
  useLabel: 'Use',
  useValue: 'Chat you review: a person reads every answer. No tools and no file changes.',
  projectsLabel: 'Projects it covers',
  labelsLabel: 'Labels it covers',
  conditionsLabel: 'Conditions',
  conditionDefaults: Object.freeze(['A person reviews every answer', 'No tools', 'A model of another family checks the answers']),
  addCondition: 'Add a condition',
  benefitLabel: 'Mission benefit',
  benefitHint: 'What this model does for the mission that an approved model cannot. Your organization reads this.',
  personLabel: 'Named person (Name, Position)',
  personName: 'Name',
  personPosition: 'Position',
  personKeyNotListed: 'Your key is not on your organization\'s list of signers yet. The exception counts only after your organization adds it.',
  endsLabel: 'Ends on',
  endsHint: 'At most 90 days from today: on or before {date}.',
  review: 'Review the request',
  close: 'Close without saving',
  reviewTitle: 'Check the request before you sign',
  reviewNext: 'When you sign, SovAI saves a file for {contact}. Nothing changes on this computer. The exception counts only when your organization\'s rules carry it.',
  sign: 'Sign and save the request',
  change: 'Change the request',
  signing: 'Signing the request',
  saved: 'Request saved to {file}. Send it to {contact}. Nothing changes here until your organization\'s rules carry the exception.',
  notSaved: 'Not saved. Your draft is still here.',
  signFailed: 'The request could not be signed: {reason}. Nothing was saved.',
  errEnds: 'An exception can last at most 90 days. Choose {date} or earlier.',
  errEndsPast: 'Choose a date after today.',
  errProjects: 'Choose at least one project.',
  errLabels: 'Choose at least one label.',
  errPerson: 'Give the named person\'s name and position.',
  errBenefit: 'Say what this model does for the mission.',
  errUse: 'An exception covers chat you review only.',
  errConditions: 'Use at most 8 conditions, each at most 280 characters.',
  noProject: 'Open the project this exception is for, then ask again.',
  loading: 'Loading models and exceptions',
  catalogueError: 'The models list could not be loaded: {reason}. Your exceptions are still listed below.',
  noResearchOnly: 'Every model in the list is approved above research only, so none needs an exception.',
  noneYet: 'No exceptions yet.',
  contactFallback: 'your organization\'s security contact',
  reviewModel: 'Model',
  reviewLegal: 'Read first'
});

export function fillException(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] as string : whole));
}

/** The model's legal flags as the person reads them before anything else (design 5.3): the Entity List first, then US law, then each removal order. */
export function legalFlagsLine(passport: Pick<Passport, 'legal'> | undefined): string {
  if (passport === undefined) return '';
  const parts: string[] = [];
  if (passport.legal.entityList) parts.push(EXCEPTION_TEXT.legalEntityList);
  if (passport.legal.coveredByUsLaw) parts.push(EXCEPTION_TEXT.legalCoveredByUsLaw);
  for (const order of passport.legal.removalOrders) parts.push(fillException(EXCEPTION_TEXT.legalRemoval, { order }));
  return parts.join(' ');
}

/** The longest an exception may last, in days (owner O3); the schema's own number. */
export const EXCEPTION_MAX_DAYS = MAX_DAYS_BY_KIND['t1-risk'] as number;
/** The longest a mission benefit or a condition may be (the record's own limits). */
export const MAX_BENEFIT = 200;
export const MAX_CONDITION = 280;
export const MAX_CONDITIONS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields of an exception draft, as the page posts them. */
export interface ExceptionDraftInput {
  readonly id: string;
  /** The passport id the exception is about (the subject the gate asks about). */
  readonly model: string;
  /** Exactly `['t1']`; anything else is refused. Absent means chat you review. */
  readonly uses?: readonly string[];
  readonly projects: readonly string[];
  readonly labels: readonly string[];
  readonly conditions: readonly string[];
  readonly benefit: string;
  readonly person: { readonly name: string; readonly position: string };
  /** The end day, `YYYY-MM-DD`; the exception ends at the start of that day (UTC). */
  readonly endsOn: string;
  /** ISO time of the draft; the signer signs at exactly this time. */
  readonly issuedAt: string;
}

export type ExceptionField = 'use' | 'projects' | 'labels' | 'benefit' | 'person' | 'ends' | 'conditions';
export type ExceptionDraft = { readonly ok: true; readonly body: AuthorizationBody } | { readonly ok: false; readonly errors: Readonly<Partial<Record<ExceptionField, string>>> };

/** The first and last allowed end days for a draft made at `issuedAt`: tomorrow, and today plus 90 days (UTC dates). */
export function endsOnBounds(issuedAt: string): { readonly min: string; readonly max: string; readonly fallback: string } {
  const at = Date.parse(issuedAt);
  const day = (offset: number) => new Date(Math.floor(at / DAY_MS) * DAY_MS + offset * DAY_MS).toISOString().slice(0, 10);
  return { min: day(1), max: day(EXCEPTION_MAX_DAYS), fallback: day(30) };
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const unique = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))].sort();

/**
 * The exception's body from a draft, or the sentence for every field that is wrong (design 5.3, O3): chat you review only, at least one project and one
 * label, a named person with a position, a mission benefit, and an end day from tomorrow to 90 days from today. The body parses with
 * parseAuthorizationBody (kind t1-risk, uses ['t1']).
 */
export function draftRiskAcceptance(input: ExceptionDraftInput): ExceptionDraft {
  const errors: Partial<Record<ExceptionField, string>> = {};
  const uses = input.uses ?? ['t1'];
  if (uses.length !== 1 || uses[0] !== 't1') errors.use = EXCEPTION_TEXT.errUse;
  const projects = unique(input.projects);
  if (projects.length === 0 || !projects.every((project) => SUBJECT_VALUE_PATTERN.test(project))) errors.projects = EXCEPTION_TEXT.errProjects;
  const labels = unique(input.labels);
  if (labels.length === 0 || !labels.every((label) => /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(label))) errors.labels = EXCEPTION_TEXT.errLabels;
  const name = text(input.person.name);
  const position = text(input.person.position);
  if (name === '' || position === '' || name.length > 64 || position.length > 64) errors.person = EXCEPTION_TEXT.errPerson;
  const benefit = text(input.benefit);
  if (benefit === '' || benefit.length > MAX_BENEFIT) errors.benefit = EXCEPTION_TEXT.errBenefit;
  const conditions = [...new Set(input.conditions.map((condition) => condition.trim()).filter((condition) => condition !== ''))];
  if (conditions.length > MAX_CONDITIONS || conditions.some((condition) => condition.length > MAX_CONDITION)) errors.conditions = EXCEPTION_TEXT.errConditions;
  const bounds = endsOnBounds(input.issuedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn) || !Number.isFinite(Date.parse(`${input.endsOn}T00:00:00Z`))) errors.ends = EXCEPTION_TEXT.errEndsPast;
  else if (input.endsOn < bounds.min) errors.ends = EXCEPTION_TEXT.errEndsPast;
  else if (input.endsOn > bounds.max) errors.ends = fillException(EXCEPTION_TEXT.errEnds, { date: dateShown(`${bounds.max}T00:00:00Z`) });
  if (!AUTHORIZATION_ID_PATTERN.test(input.id) || !SUBJECT_VALUE_PATTERN.test(input.model)) errors.use = errors.use ?? EXCEPTION_TEXT.errUse;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body = parseAuthorizationBody({
    v: 1, id: input.id, kind: 't1-risk', subject: { model: input.model }, scope: { projects, labels, uses: ['t1'] }, conditions, evidence: benefit,
    namedPerson: { name, role: position }, issuedAt: input.issuedAt, expiresAt: `${input.endsOn}T00:00:00.000Z`
  });
  if (!body.ok) return { ok: false, errors: { use: EXCEPTION_TEXT.errUse } };
  return { ok: true, body: body.value };
}

/** The row words of one research-only model (S11). */
export function researchOnlyRow(passport: Pick<Passport, 'id' | 'origin'>): string {
  return fillException(EXCEPTION_TEXT.rowResearchOnly, { model: passport.id, origin: originShown(passport.origin) });
}

/** How an exception in your organization's rules stands now, in the row's words. */
export function exceptionRow(body: AuthorizationBody, now: number, options: { readonly projectName?: (id: string) => string; readonly triggered?: { readonly change: string; readonly at: string } } = {}): { readonly state: 'active' | 'ended' | 'triggered' | 'withdrawn'; readonly text: string; readonly scope: string } {
  const model = 'model' in body.subject ? body.subject.model : '';
  const scope = fillException(EXCEPTION_TEXT.rowScope, {
    projects: (body.scope.projects ?? []).map((id) => options.projectName?.(id) ?? id).join(', '),
    labels: (body.scope.labels ?? []).join(', ')
  });
  if (body.revokedBy !== undefined) {
    const at = Date.parse(body.revokedBy);
    return { state: 'withdrawn', text: fillException(EXCEPTION_TEXT.rowWithdrawn, { model, date: dateShown(Number.isFinite(at) ? body.revokedBy : body.expiresAt) }), scope };
  }
  if (options.triggered !== undefined) return { state: 'triggered', text: fillException(EXCEPTION_TEXT.rowTriggered, { model, date: dateShown(options.triggered.at), change: options.triggered.change }), scope };
  if (now >= Date.parse(body.expiresAt)) return { state: 'ended', text: fillException(EXCEPTION_TEXT.rowEnded, { model, date: dateShown(body.expiresAt) }), scope };
  return { state: 'active', text: fillException(EXCEPTION_TEXT.rowActive, { model, name: body.namedPerson.name, date: dateShown(body.expiresAt) }), scope };
}
