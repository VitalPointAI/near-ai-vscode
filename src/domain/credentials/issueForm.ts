// The Issue credential form (Phase 71, 71-12; D-15, D-21): which types an officer may issue now, the claims each needs in plain words, the checks
// before the review step, and the sentences the officer reads before they sign. Pure and host-neutral: no I/O, no clock, no vscode, no package. The
// scales come from the caller (your organization's policy). The officer's backend runs it through the identity engine; the card only shows what it
// answers. issuerAuthority (issuerAuthority.ts) still decides at signing time; this form only keeps the officer from asking for what would be refused.
import { RESERVED_EXPORT_COMPARTMENTS, levelIndex, scaleOf, shownCompartment } from '../gate/labels';
import type { ScaleTable } from '../gate/labels';
import { PERSON_ATTRIBUTE_TYPES, SERVES_VALUES, credentialTimeMs } from './types';

/** A role the officer holds now, as their backend verified it (its status clear). */
export interface HeldRole {
  readonly type: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/** The parts of credentials@1 the form reads. */
export interface FormPolicy {
  readonly issuance: Readonly<Record<string, { readonly role: string; readonly ceiling?: { readonly scale: string; readonly upTo: string } } | undefined>>;
  readonly scales: ScaleTable;
}

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly kind: 'person' | 'choice' | 'text' | 'date';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
}

export interface Issuable {
  readonly type: string;
  readonly label: string;
  /** Plain words of the highest level, for a type with levels. */
  readonly ceiling?: string;
  /** The ceiling as scale and level, for the checks. */
  readonly ceilingLevel?: { readonly scale: string; readonly upTo: string };
  readonly compartments?: readonly string[];
  readonly regimes?: readonly string[];
  /** The latest end of the roles that allow it: nothing issued may last longer. */
  readonly roleValidUntil: string;
  readonly fields: readonly FormField[];
}

/** What the officer filled in. `until` is the last day, YYYY-MM-DD. */
export interface FormValues {
  readonly personName: string;
  readonly subject: string;
  readonly until: string;
  readonly claims: Readonly<Record<string, string>>;
}

export type FormCheck = { readonly ok: true; readonly validUntil: string } | { readonly ok: false; readonly field: string; readonly message: string };

/** Every sentence of the form (D-21). None quotes a DID, a key or an index. */
export const ISSUE_FORM_TEXT = {
  person: 'The person',
  personHint: 'Their identity, which they copy from their own identity page, and their name as you know them.',
  personName: 'Their name',
  until: 'Last day',
  untilHint: 'The credential ends after this day. It can never last longer than your own role.',
  scale: 'Scale',
  level: 'Level',
  organization: 'Organization',
  compartment: 'Compartment',
  serves: 'How they serve',
  nationality: 'Nationality (three-letter country code)',
  regime: 'Export rules',
  basis: 'Basis (the licence or authorization)',
  agreement: 'Agreement',
  scope: 'Where it applies (organization, project:<id> or section:<id>)',
  missing: 'Fill in this field.',
  notAPerson: 'This is not a person\'s identity. Ask them to copy it from their own identity page.',
  aboveCeiling: 'This level is above what your role allows.',
  notOffered: 'Choose one of the offered values.',
  pastRole: 'This is after your own role ends. Choose an earlier last day.',
  notFuture: 'The last day must be after today.',
  badDate: 'Enter the last day as a date.',
} as const;

/** How the types read in sentences. */
export const TYPE_LABEL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  MembershipCredential: 'membership', ClearanceCredential: 'clearance', CompartmentCredential: 'compartment access', ServiceCredential: 'service',
  NationalityCredential: 'nationality', AffiliationCredential: 'affiliation', ExportEligibilityCredential: 'export eligibility',
  AccessAgreementCredential: 'access agreement', VisitClearanceCredential: 'visit clearance', ObserverAccessCredential: 'observer access',
  DeviceBindingCredential: 'computer binding',
});

/** The scales as sentences name them; any other scale is "the <name> scale". */
export const SCALE_WORDS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'ca-classified': 'the Canadian classified scale', 'ca-protected': 'the Canadian protected scale', nato: 'the NATO scale', org: 'your organization\'s scale',
});

export const SERVES_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'regular-force': 'Regular Force', 'reserve-force': 'Reserve Force', 'public-servant': 'public servant', contractor: 'contractor',
  'allied-military': 'allied military', industry: 'industry',
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const NATIONALITY = /^[A-Z]{3}$/;
const SCOPE = /^(organization|(project|section):[A-Za-z0-9._-]{1,128})$/;
/** The types the card can issue; visit clearances and observer access come from their own flows (guests and observers). */
const FORM_TYPES = PERSON_ATTRIBUTE_TYPES.filter((type) => type !== 'VisitClearanceCredential' && type !== 'ObserverAccessCredential');

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function typeLabel(type: string): string {
  return own(TYPE_LABEL_TEXT, type) ?? type;
}

function scaleWords(scales: ScaleTable, scale: string): string {
  return own(SCALE_WORDS_TEXT, scale) ?? `the ${scaleOf(scales, scale)?.name ?? scale} scale`;
}

/** The epoch milliseconds of the start of a YYYY-MM-DD day, UTC, or NaN. */
function dayStart(day: string): number {
  const match = DAY.exec(day);
  if (match === null) return Number.NaN;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : Number.NaN;
}

/** A credential's validUntil for a last day: the start of the next day, UTC, so it holds through that day. */
export function validUntilFor(lastDay: string): string {
  const start = dayStart(lastDay);
  return Number.isNaN(start) ? '' : new Date(start + DAY_MS).toISOString().replace('.000Z', 'Z');
}

/** "31 March", with the year when it is not `today`'s year. */
function shownDay(day: string, today: number): string {
  const start = dayStart(day);
  const date = new Date(start);
  const shown = `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] as string}`;
  return date.getUTCFullYear() === new Date(today).getUTCFullYear() ? shown : `${shown} ${String(date.getUTCFullYear())}`;
}

/** The lower of two ceilings on one scale; undefined when they are on different scales (then nothing on levels can be issued). */
function lower(scales: ScaleTable, a: { scale: string; upTo: string } | undefined, b: { scale: string; upTo: string } | undefined): { scale: string; upTo: string } | undefined | 'none' {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a.scale !== b.scale) return 'none';
  return levelIndex(scales, a.scale, a.upTo) <= levelIndex(scales, b.scale, b.upTo) ? a : b;
}

function claimFields(type: string, issuable: Omit<Issuable, 'fields'>, scales: ScaleTable): FormField[] {
  const text = (name: string, label: string): FormField => ({ name, label, kind: 'text' });
  switch (type) {
    case 'ClearanceCredential': {
      const ceiling = issuable.ceilingLevel;
      const scaleIds = ceiling === undefined ? Object.keys(scales) : [ceiling.scale];
      const levels = scaleIds.flatMap((scale) => (scaleOf(scales, scale)?.levels ?? [])
        .filter((_level, rank) => ceiling === undefined || rank <= levelIndex(scales, ceiling.scale, ceiling.upTo)));
      return [
        { name: 'scale', label: ISSUE_FORM_TEXT.scale, kind: 'choice', options: scaleIds.map((scale) => ({ value: scale, label: scaleOf(scales, scale)?.name ?? scale })) },
        { name: 'atLeast', label: ISSUE_FORM_TEXT.level, kind: 'choice', options: [...new Set(levels)].map((level) => ({ value: level, label: level })) },
      ];
    }
    case 'MembershipCredential': case 'AffiliationCredential': return [text('organization', ISSUE_FORM_TEXT.organization)];
    case 'CompartmentCredential': return [issuable.compartments === undefined ? text('compartment', ISSUE_FORM_TEXT.compartment)
      : { name: 'compartment', label: ISSUE_FORM_TEXT.compartment, kind: 'choice', options: issuable.compartments.map((token) => ({ value: token, label: shownCompartment(token) })) }];
    case 'ServiceCredential': return [{ name: 'serves', label: ISSUE_FORM_TEXT.serves, kind: 'choice', options: SERVES_VALUES.map((value) => ({ value, label: own(SERVES_TEXT, value) ?? value })) }];
    case 'NationalityCredential': return [text('nationality', ISSUE_FORM_TEXT.nationality)];
    case 'ExportEligibilityCredential': return [
      { name: 'regime', label: ISSUE_FORM_TEXT.regime, kind: 'choice', options: (issuable.regimes ?? RESERVED_EXPORT_COMPARTMENTS).map((token) => ({ value: token, label: shownCompartment(token) })) },
      text('basis', ISSUE_FORM_TEXT.basis),
    ];
    case 'AccessAgreementCredential': return [text('agreement', ISSUE_FORM_TEXT.agreement), text('scope', ISSUE_FORM_TEXT.scope)];
    default: return [];
  }
}

/**
 * The types the officer's current roles and the policy's issuance rules allow at `at`, with the ceiling of each (the lower of the role's and the
 * policy's) and its form. A type whose only matching roles have ended, or whose ceilings sit on different scales, is not offered.
 */
export function issuableTypes(roles: readonly HeldRole[], policy: FormPolicy, at: number): readonly Issuable[] {
  const found: Issuable[] = [];
  for (const type of FORM_TYPES) {
    const rule = own(policy.issuance, type);
    if (rule === undefined) continue;
    const matching = roles.filter((role) => role.type === rule.role && (rule.role !== 'IssuerRoleCredential' || role.claims.credentialType === type)
      && credentialTimeMs(role.validFrom) <= at && at < credentialTimeMs(role.validUntil));
    for (const role of matching) {
      const roleCeiling = typeof role.claims.scale === 'string' && typeof role.claims.upTo === 'string' ? { scale: role.claims.scale, upTo: role.claims.upTo } : undefined;
      const ceiling = lower(policy.scales, roleCeiling, rule.ceiling);
      if (ceiling === 'none') continue;
      const base = {
        type, label: typeLabel(type), roleValidUntil: role.validUntil,
        ...(ceiling === undefined ? {} : { ceiling: `${ceiling.upTo} on ${scaleWords(policy.scales, ceiling.scale)}`, ceilingLevel: ceiling }),
        ...(Array.isArray(role.claims.compartments) ? { compartments: role.claims.compartments as string[] } : {}),
        ...(Array.isArray(role.claims.regimes) ? { regimes: role.claims.regimes as string[] } : {}),
      };
      // The role that reaches highest, and among equals the one that lasts longest.
      const index = found.findIndex((entry) => entry.type === type);
      const candidate: Issuable = Object.freeze({ ...base, fields: Object.freeze(formFor(type, base, policy.scales)) });
      if (index < 0) found.push(candidate);
      else if (better(policy.scales, candidate, found[index] as Issuable)) found[index] = candidate;
    }
  }
  return Object.freeze(found);
}

function better(scales: ScaleTable, a: Issuable, b: Issuable): boolean {
  const rank = (entry: Issuable): number => (entry.ceilingLevel === undefined ? Number.MAX_SAFE_INTEGER : levelIndex(scales, entry.ceilingLevel.scale, entry.ceilingLevel.upTo));
  return rank(a) > rank(b) || (rank(a) === rank(b) && credentialTimeMs(a.roleValidUntil) > credentialTimeMs(b.roleValidUntil));
}

/** The form of one type: the person, the type's own claims in plain words, and the last day. */
export function formFor(type: string, issuable: Omit<Issuable, 'fields'>, scales: ScaleTable): readonly FormField[] {
  return Object.freeze([
    { name: 'subject', label: ISSUE_FORM_TEXT.person, kind: 'person', hint: ISSUE_FORM_TEXT.personHint },
    { name: 'personName', label: ISSUE_FORM_TEXT.personName, kind: 'text' },
    ...claimFields(type, issuable, scales),
    { name: 'until', label: ISSUE_FORM_TEXT.until, kind: 'date', hint: ISSUE_FORM_TEXT.untilHint },
  ]);
}

/** The first problem with what the officer filled in, or the credential's validUntil. `today` is the caller's clock. */
export function validateForm(issuable: Issuable, values: FormValues, scales: ScaleTable, today: number): FormCheck {
  const refuse = (field: string, message: string): FormCheck => ({ ok: false, field, message });
  if (typeof values.subject !== 'string' || values.subject.trim() === '') return refuse('subject', ISSUE_FORM_TEXT.missing);
  if (!values.subject.startsWith('did:webvh:')) return refuse('subject', ISSUE_FORM_TEXT.notAPerson);
  if (typeof values.personName !== 'string' || values.personName.trim() === '') return refuse('personName', ISSUE_FORM_TEXT.missing);
  for (const field of issuable.fields) {
    if (field.kind === 'person' || field.name === 'personName' || field.name === 'until') continue;
    const value = own(values.claims, field.name);
    if (typeof value !== 'string' || value.trim() === '') return refuse(field.name, ISSUE_FORM_TEXT.missing);
    if (field.kind === 'choice' && !(field.options ?? []).some((option) => option.value === value)) {
      return refuse(field.name, field.name === 'atLeast' && issuable.ceilingLevel !== undefined && levelIndex(scales, values.claims.scale ?? '', value) >= 0
        ? ISSUE_FORM_TEXT.aboveCeiling : ISSUE_FORM_TEXT.notOffered);
    }
  }
  if (issuable.type === 'ClearanceCredential' && issuable.ceilingLevel !== undefined) {
    const { scale, atLeast } = values.claims;
    if (scale !== issuable.ceilingLevel.scale || levelIndex(scales, scale, atLeast ?? '') > levelIndex(scales, scale, issuable.ceilingLevel.upTo)) {
      return refuse('atLeast', ISSUE_FORM_TEXT.aboveCeiling);
    }
  }
  if (issuable.type === 'NationalityCredential' && !NATIONALITY.test(values.claims.nationality ?? '')) return refuse('nationality', ISSUE_FORM_TEXT.notOffered);
  if (issuable.type === 'AccessAgreementCredential' && !SCOPE.test(values.claims.scope ?? '')) return refuse('scope', ISSUE_FORM_TEXT.notOffered);
  const start = dayStart(values.until);
  if (Number.isNaN(start)) return refuse('until', ISSUE_FORM_TEXT.badDate);
  if (start + DAY_MS <= today) return refuse('until', ISSUE_FORM_TEXT.notFuture);
  const validUntil = validUntilFor(values.until);
  if (credentialTimeMs(validUntil) > credentialTimeMs(issuable.roleValidUntil)) return refuse('until', ISSUE_FORM_TEXT.pastRole);
  return { ok: true, validUntil };
}

/** What the claims say, in plain words, for the review sentence. */
function claimWords(type: string, claims: Readonly<Record<string, string>>, scales: ScaleTable): string {
  switch (type) {
    case 'ClearanceCredential': return `${claims.atLeast ?? ''} clearance on ${scaleWords(scales, claims.scale ?? '')}`;
    case 'CompartmentCredential': return `access to the ${shownCompartment(claims.compartment ?? '')} compartment`;
    case 'ServiceCredential': return `service as ${own(SERVES_TEXT, claims.serves ?? '') ?? claims.serves ?? ''}`;
    case 'NationalityCredential': return `nationality ${claims.nationality ?? ''}`;
    case 'MembershipCredential': return `membership of ${claims.organization ?? ''}`;
    case 'AffiliationCredential': return `affiliation with ${claims.organization ?? ''}`;
    case 'ExportEligibilityCredential': return `${shownCompartment(claims.regime ?? '')} export eligibility (${claims.basis ?? ''})`;
    case 'AccessAgreementCredential': return `the access agreement ${claims.agreement ?? ''} for ${claims.scope ?? ''}`;
    default: return typeLabel(type);
  }
}

/** "You are about to issue: Secret clearance on the Canadian classified scale to Alex, until 31 March." */
export function reviewSentence(type: string, values: FormValues, scales: ScaleTable, today: number): string {
  return `You are about to issue: ${claimWords(type, values.claims, scales)} to ${values.personName.trim()}, until ${shownDay(values.until, today)}.`;
}

/** The review sentences of revoking and suspending a credential the officer's list shows. */
export function revokeSentence(type: string, personName: string): string {
  return `You are about to revoke ${personName}'s ${typeLabel(type)}. A revocation can never be undone.`;
}
export function suspendSentence(type: string, personName: string): string {
  return `You are about to suspend ${personName}'s ${typeLabel(type)}. A credential officer for this kind of credential can lift a suspension later.`;
}
export function liftSentence(type: string, personName: string): string {
  return `You are about to lift the suspension of ${personName}'s ${typeLabel(type)}.`;
}
