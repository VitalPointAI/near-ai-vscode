// The J2 intelligence workbench rules (design 10, 3.2, 4.4, 6.2 and 7; research note 02; WP-INT). Pure: no I/O, no clock (every time is passed in),
// no vscode. The agent tools in src/agent/intelWorkbench.ts read and write the registers through these functions and nothing else.
//
// Three registers, each a JSON file with one writer (design 10, 4.3): the source register (osint-analyst and geoint-analyst), the PIR register
// (requirements-manager) and the collection plan (collection-manager). The rules they hold:
//   - Reliability (A to F, of the source) and credibility (1 to 6, of the information) are two fields graded separately, never one combined grade.
//   - Independence is by origin, not by report: two reports from one origin are one piece of evidence, so they never count as corroboration.
//   - Every PIR names the decision point it supports and a latest time of value. Only a named person approves or rejects a PIR; no tool can.
//   - The collection plan holds recommendations only. The J3 approves asset allocation; partner-only disciplines always need a partner.
//   - INTSUM and INTREP drafts are skeletons with the facts filled in from the registers and the judgement left to the analyst.
//   - The compilation-risk check never clears anything: it either finds nothing mechanical or asks a person with authority.
import { decisionKey, decisionMatches, pirWording } from './personDecisions';
import type { PersonDecisionEntry } from './personDecisions';
import { parseIsoMillis } from '../gate/shape';
import {
  COLLECTION_PLAN_HEADINGS, COLLECTION_PLAN_RULE, CONFIRMED_CREDIBILITY, DTG_MONTHS, INFORMATION_CREDIBILITY, INFORMATION_CREDIBILITY_GRADES,
  INTEL_REPORTS, INTELLIGENCE_DISCIPLINES, PARTNER_ONLY_DISCIPLINES, PIR_REGISTER_HEADINGS, SOURCE_RELIABILITY, SOURCE_RELIABILITY_GRADES,
  STAFF_TEMPLATE_LABELS
} from './doctrine';
import type { InformationCredibility, IntelligenceDiscipline, SourceReliability } from './doctrine';
import { isOneLine, isOneOf, isRecord, ownValue, STAFF_SLUG } from './parse';
import { renderProductHeader, splitProductFile } from './products';
import type { StaffSettings } from './profiles';
import type { PersonActor } from './release';

// ---- Results ----------------------------------------------------------------------------------------------------------------------------------

/** The closed list of rules a workbench call can be refused under. Every refusal names one, so a test can prove which rule held. */
export const INTEL_RULES = {
  'bad-input': 'A value is missing or has the wrong form.',
  'grades-separate': 'Reliability (A to F, of the source) and credibility (1 to 6, of the information) are graded separately, as two fields.',
  'unknown-entry': 'The register has no entry with that id.',
  'duplicate-entry': 'The register already has an entry with that id.',
  'pir-decision-point': 'Every PIR names the decision point it supports and a latest time of value.',
  'person-only': 'Only a named person approves or rejects a PIR; no member and no tool can.',
  'pir-locked': 'The commander decided on this PIR\'s wording, so it is not edited here; propose the change instead.',
  'pir-transition': 'The PIR cannot move to that status from its current one.',
  'collection-recommend-only': 'The collection plan holds recommendations only: the J2 recommends and the J3 approves the allocation of collection assets.',
  'collection-after-ltiov': 'Collection that ends after the PIR\'s latest time of value cannot support the decision.',
  'collection-indicator': 'A recommendation must name one of its PIR\'s own indicators.',
  'partner-only': 'HUMINT, SIGINT, MASINT and CI collection needs legal authority and partner systems, so the recommendation must say it needs a partner.',
  'label-ceiling': 'Staff templates hold exercise and fictional data only, at org/Internal, NATO Unclassified or Protected A at most. Higher labels belong on accredited systems.',
  'register-damaged': 'The register file is not in the workbench format.'
} as const;
export type IntelRule = keyof typeof INTEL_RULES;

export type IntelResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rule: IntelRule; readonly message: string };

function refuse(rule: IntelRule, detail?: string): { readonly ok: false; readonly rule: IntelRule; readonly message: string } {
  return { ok: false, rule, message: detail ? `${INTEL_RULES[rule].replace(/\.$/, '')} (${detail}).` : INTEL_RULES[rule] };
}
function done<T>(value: T): IntelResult<T> {
  return { ok: true, value };
}

export type FindingSeverity = 'block' | 'warning' | 'advice';
export interface IntelFinding { readonly rule: string; readonly severity: FindingSeverity; readonly subject: string; readonly message: string }

// ---- Time: ISO and DTG ------------------------------------------------------------------------------------------------------------------------

const DTG_PATTERN = /^(\d{2})(\d{2})(\d{2})Z ([A-Z]{3}) (\d{2})$/;

/** A time as a date-time group `DDHHMMZ MON YY`, always in UTC (ACP 121). */
export function formatDtg(ms: number): string {
  const date = new Date(ms);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}Z ${DTG_MONTHS[date.getUTCMonth()]} ${two(date.getUTCFullYear() % 100)}`;
}

/** A DTG back to epoch milliseconds (two-digit years are 2000 to 2099), or NaN when the text is not a DTG or names a day that does not exist. */
export function parseDtg(text: string): number {
  const match = DTG_PATTERN.exec(text.trim().toUpperCase());
  if (!match) return Number.NaN;
  const month = (DTG_MONTHS as readonly string[]).indexOf(match[4]);
  if (month < 0) return Number.NaN;
  const [day, hour, minute, year] = [Number(match[1]), Number(match[2]), Number(match[3]), 2000 + Number(match[5])];
  if (hour > 23 || minute > 59) return Number.NaN;
  const ms = Date.UTC(year, month, day, hour, minute);
  return new Date(ms).getUTCDate() === day ? ms : Number.NaN;
}

/** The DTG as a slug part for a product name: `181402z-nov-26`. */
export function dtgSlug(ms: number): string {
  return formatDtg(ms).toLowerCase().replace(/ /g, '-');
}

/**
 * A time given by a member: the gate's ISO form, a shorter ISO form in UTC (`2026-11-18T14:02Z`, `2026-11-18T14:02:00Z`), a date (`2026-11-18`, midnight
 * UTC), or a DTG. Epoch milliseconds, or NaN for anything else. A local time without a zone is refused: a register is read by people in many time zones.
 */
export function readTime(text: unknown): number {
  if (typeof text !== 'string') return Number.NaN;
  const value = text.trim();
  const exact = parseIsoMillis(value);
  if (!Number.isNaN(exact)) return exact;
  const short = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z)?$/.exec(value);
  if (short) {
    const [year, month, day] = [Number(short[1]), Number(short[2]) - 1, Number(short[3])];
    const ms = Date.UTC(year, month, day, Number(short[4] ?? 0), Number(short[5] ?? 0), Number(short[6] ?? 0));
    const check = new Date(ms);
    const valid = check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day
      && Number(short[4] ?? 0) <= 23 && Number(short[5] ?? 0) <= 59 && Number(short[6] ?? 0) <= 59;
    return valid ? ms : Number.NaN;
  }
  return parseDtg(value);
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- Labels -----------------------------------------------------------------------------------------------------------------------------------

/** Whether a label is inside the staff template ceiling (design 10, 6). */
export function isTemplateLabel(label: unknown): label is string {
  return typeof label === 'string' && STAFF_TEMPLATE_LABELS.includes(label);
}

export const DEFAULT_INTEL_LABEL = 'org/Internal';

// ---- The source register ----------------------------------------------------------------------------------------------------------------------

export interface SourceEntry {
  readonly id: string;
  readonly title: string;
  /** Who provided the item to us: an outlet, a sensor, a report series. Reliability grades this. */
  readonly source: string;
  /** Where the information first came from. Two items with one origin are one piece of evidence, whatever their sources. */
  readonly origin: string;
  readonly discipline: IntelligenceDiscipline;
  readonly url?: string;
  /** When the source published or reported it, and when we took it in (ISO). */
  readonly reportedAt: string;
  readonly accessedAt: string;
  readonly reliability: SourceReliability;
  readonly credibility: InformationCredibility;
  /** The claims the item reports on, as slugs, so reports on one claim can be compared. */
  readonly claims: readonly string[];
  /** What deception or bias could explain the item; "none seen" is an answer, a blank is not. */
  readonly deceptionNote: string;
  readonly label: string;
  readonly addedBy: string;
}

const MAX_TEXT = 300;
const MAX_CLAIMS = 20;
const SOURCE_ID = /^SRC-[1-9][0-9]{0,5}$/;
const PIR_ID = /^PIR-[1-9][0-9]{0,4}$/;
const INDICATOR_ID = /^IND-[1-9][0-9]{0,5}$/;
const COLLECTION_ID = /^CR-[1-9][0-9]{0,5}$/;
const COMBINED_GRADE = /^[A-Fa-f]\s*[1-6]$/;
const URL_PATTERN = /^https?:\/\/[^\s]{1,500}$/;

/** The key two origins are compared by: case, spacing and a trailing full stop do not make an origin independent. */
export function originKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
}

/** The next id of a register: one more than the highest number used, so ids are never reused after a hand edit removes an entry. */
export function nextId(prefix: 'SRC' | 'PIR' | 'IND' | 'CR', used: readonly string[]): string {
  const highest = used.reduce((max, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${highest + 1}`;
}

/** What a member gives to add an item. The grades are two separate fields; one combined grade such as "B2" is refused. */
export interface SourceDraft {
  readonly title: unknown; readonly source: unknown; readonly origin: unknown; readonly discipline: unknown; readonly url?: unknown;
  readonly reportedAt: unknown; readonly accessedAt: unknown; readonly reliability: unknown; readonly credibility: unknown; readonly claims?: unknown;
  readonly deceptionNote: unknown; readonly label?: unknown; readonly grade?: unknown;
}

function oneLine(value: unknown, field: string, max = MAX_TEXT): IntelResult<string> {
  return isOneLine(value, max) ? done(value.trim()) : refuse('bad-input', field);
}

/** Reads the two grades. Each comes from its own scale; a combined grade in either field, or a `grade` field, is the `grades-separate` refusal. */
export function readGrades(reliability: unknown, credibility: unknown, combined?: unknown): IntelResult<{ reliability: SourceReliability; credibility: InformationCredibility }> {
  if (combined !== undefined) return refuse('grades-separate', 'give reliability and credibility as two fields, not one grade');
  if (typeof reliability === 'string' && COMBINED_GRADE.test(reliability.trim())) return refuse('grades-separate', 'reliability holds a combined grade');
  if (typeof credibility === 'string' && COMBINED_GRADE.test(credibility.trim())) return refuse('grades-separate', 'credibility holds a combined grade');
  if (typeof reliability !== 'string' || !isOneOf(SOURCE_RELIABILITY_GRADES, reliability.trim().toUpperCase())) return refuse('grades-separate', 'reliability must be one letter from A to F');
  const credibilityNumber = typeof credibility === 'string' && /^[1-6]$/.test(credibility.trim()) ? Number(credibility.trim()) : credibility;
  if (typeof credibilityNumber !== 'number' || !INFORMATION_CREDIBILITY_GRADES.includes(credibilityNumber as InformationCredibility)) {
    return refuse('grades-separate', 'credibility must be one number from 1 to 6');
  }
  return done({ reliability: reliability.trim().toUpperCase() as SourceReliability, credibility: credibilityNumber as InformationCredibility });
}

function readClaims(value: unknown): IntelResult<string[]> {
  if (value === undefined) return done([]);
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) return refuse('bad-input', 'claims');
  const claims: string[] = [];
  for (const claim of value) {
    if (typeof claim !== 'string' || !STAFF_SLUG.test(claim.trim())) return refuse('bad-input', 'claims: each claim is a short slug such as bridge-closed-ashby');
    if (!claims.includes(claim.trim())) claims.push(claim.trim());
  }
  return done(claims);
}

function readLabel(value: unknown): IntelResult<string> {
  if (value === undefined) return done(DEFAULT_INTEL_LABEL);
  return isTemplateLabel(value) ? done(value) : refuse('label-ceiling', typeof value === 'string' ? value.slice(0, 60) : 'label');
}

/** Checks a member's new item and gives the entry to store, with the next free id. */
export function buildSourceEntry(draft: SourceDraft, register: readonly SourceEntry[], addedBy: string): IntelResult<SourceEntry> {
  const grades = readGrades(draft.reliability, draft.credibility, draft.grade);
  if (!grades.ok) return grades;
  const title = oneLine(draft.title, 'title');
  if (!title.ok) return title;
  const source = oneLine(draft.source, 'source', 120);
  if (!source.ok) return source;
  const origin = oneLine(draft.origin, 'origin', 120);
  if (!origin.ok) return origin;
  if (!isOneOf(INTELLIGENCE_DISCIPLINES, draft.discipline)) return refuse('bad-input', `discipline: one of ${INTELLIGENCE_DISCIPLINES.join(', ')}`);
  let url: string | undefined;
  if (draft.url !== undefined && draft.url !== '') {
    if (typeof draft.url !== 'string' || !URL_PATTERN.test(draft.url.trim())) return refuse('bad-input', 'url');
    url = draft.url.trim();
  }
  const reported = readTime(draft.reportedAt);
  const accessed = readTime(draft.accessedAt);
  if (Number.isNaN(reported)) return refuse('bad-input', 'reportedAt: an ISO time in UTC, a date or a DTG');
  if (Number.isNaN(accessed)) return refuse('bad-input', 'accessedAt: an ISO time in UTC, a date or a DTG');
  if (accessed < reported) return refuse('bad-input', 'accessedAt is before reportedAt');
  const claims = readClaims(draft.claims);
  if (!claims.ok) return claims;
  const deceptionNote = oneLine(draft.deceptionNote, 'deceptionNote: say what deception or bias could explain the item, or "none seen"');
  if (!deceptionNote.ok) return deceptionNote;
  const label = readLabel(draft.label);
  if (!label.ok) return label;
  return done({
    id: nextId('SRC', register.map((entry) => entry.id)),
    title: title.value, source: source.value, origin: origin.value, discipline: draft.discipline,
    ...(url ? { url } : {}),
    reportedAt: iso(reported), accessedAt: iso(accessed),
    reliability: grades.value.reliability, credibility: grades.value.credibility,
    claims: claims.value, deceptionNote: deceptionNote.value, label: label.value, addedBy
  });
}

/** The two grades as people write them together (`B2`), for display only; they are always stored and checked as two fields. */
export function gradeText(entry: Pick<SourceEntry, 'reliability' | 'credibility'>): string {
  return `${entry.reliability}${entry.credibility}`;
}

export function gradeWords(entry: Pick<SourceEntry, 'reliability' | 'credibility'>): string {
  return `${SOURCE_RELIABILITY[entry.reliability].toLowerCase()} source, information ${INFORMATION_CREDIBILITY[entry.credibility].toLowerCase()}`;
}

// ---- Independence by origin -------------------------------------------------------------------------------------------------------------------

export interface Corroboration {
  readonly claim: string;
  /** Every item that reports the claim. */
  readonly reports: readonly string[];
  /** The distinct origins among them, in the order first seen. */
  readonly origins: readonly string[];
  /** How many independent pieces of evidence there are: one per origin, however many reports share it. */
  readonly independent: number;
  /** More reports than origins: some of them repeat each other. */
  readonly repeated: boolean;
  /** Two or more independent origins. Reports that share one origin never make this true. */
  readonly corroborated: boolean;
}

export function corroboration(register: readonly SourceEntry[], claim: string): Corroboration {
  const reports = register.filter((entry) => entry.claims.includes(claim));
  const origins: string[] = [];
  const keys: string[] = [];
  for (const entry of reports) {
    const key = originKey(entry.origin);
    if (!keys.includes(key)) { keys.push(key); origins.push(entry.origin); }
  }
  return { claim, reports: reports.map((entry) => entry.id), origins, independent: origins.length, repeated: reports.length > origins.length, corroborated: origins.length >= 2 };
}

/** Every claim in the register, in the order first seen. */
export function claimsOf(register: readonly SourceEntry[]): string[] {
  const claims: string[] = [];
  for (const entry of register) for (const claim of entry.claims) if (!claims.includes(claim)) claims.push(claim);
  return claims;
}

/** Whether another item from a different origin reports one of this item's claims: what credibility 1 requires. */
export function independentlyConfirmed(register: readonly SourceEntry[], entry: SourceEntry): boolean {
  return entry.claims.some((claim) => register.some((other) => other.id !== entry.id && other.claims.includes(claim) && originKey(other.origin) !== originKey(entry.origin)));
}

/** The source register's findings: unconfirmed credibility 1, repeated reporting, and one source given two reliability grades. */
export function sourceFindings(register: readonly SourceEntry[]): IntelFinding[] {
  const findings: IntelFinding[] = [];
  for (const entry of register) {
    if (entry.credibility === CONFIRMED_CREDIBILITY && !independentlyConfirmed(register, entry)) {
      findings.push({
        rule: 'credibility-1-unconfirmed', severity: 'warning', subject: entry.id,
        message: `${entry.id} is graded credibility 1, which means confirmed by independent reporting, but no item from another origin reports the same claim. Grade it 2 or lower until one does.`
      });
    }
  }
  for (const claim of claimsOf(register)) {
    const found = corroboration(register, claim);
    if (found.repeated) {
      findings.push({
        rule: 'repeated-origin', severity: 'advice', subject: claim,
        message: `"${claim}" has ${found.reports.length} reports from ${found.independent} origin${found.independent === 1 ? '' : 's'} (${found.reports.join(', ')}). Reports from one origin count once; they are not corroboration.`
      });
    }
  }
  const bySource = new Map<string, Set<SourceReliability>>();
  for (const entry of register) {
    const key = originKey(entry.source);
    const grades = bySource.get(key) ?? new Set<SourceReliability>();
    grades.add(entry.reliability);
    bySource.set(key, grades);
  }
  for (const [source, grades] of bySource) {
    if (grades.size > 1) {
      findings.push({
        rule: 'reliability-differs', severity: 'warning', subject: source,
        message: `The source "${source}" is graded ${[...grades].sort().join(' and ')} on different items. Reliability grades the source, not the item: re-grade the source once, and let credibility carry what differs between items.`
      });
    }
  }
  return findings;
}

// ---- The PIR register -------------------------------------------------------------------------------------------------------------------------

export const PIR_STATUSES = ['candidate', 'awaiting-decision', 'approved', 'rejected', 'answered', 'closed'] as const;
export type PirStatus = (typeof PIR_STATUSES)[number];
/** Statuses only a named person sets (design 10, 3.1 and 4.1: members never decide). */
export const PERSON_ONLY_PIR_STATUSES: readonly PirStatus[] = ['approved', 'rejected'];
/** Statuses whose wording the commander has decided on: the requirement, decision point and latest time of value are not edited by members. */
export const DECIDED_PIR_STATUSES: readonly PirStatus[] = ['approved', 'answered', 'closed'];

/** The status moves a member may make, through the tools. Approve and reject are not here and never will be. */
export const MEMBER_PIR_MOVES: ReadonlyArray<{ readonly from: PirStatus; readonly to: PirStatus }> = [
  { from: 'candidate', to: 'awaiting-decision' },
  { from: 'awaiting-decision', to: 'candidate' },
  { from: 'rejected', to: 'candidate' },
  { from: 'approved', to: 'answered' },
  { from: 'answered', to: 'closed' }
];

export interface PirIndicator { readonly id: string; readonly text: string }

export interface PirDecision { readonly decision: 'approved' | 'rejected'; readonly by: PersonActor; readonly at: string; readonly reasons?: readonly string[] }

export interface PirEntry {
  readonly id: string;
  readonly requirement: string;
  /** The decision point the PIR supports, as the DST names it (for example "DP 2: commit the reserve"). */
  readonly decisionPoint: string;
  /** The latest time the answer is still of value to that decision (ISO). */
  readonly ltiov: string;
  readonly indicators: readonly PirIndicator[];
  readonly status: PirStatus;
  /** Who asked for it: a section or a member (J3 and J4 requirements enter here like any other, 02 s3.4). */
  readonly requestedBy: string;
  /** The items that answered it, once answered. */
  readonly answeredBy?: readonly string[];
  /** The person's decision, when there is one. */
  readonly decision?: PirDecision;
  readonly label: string;
  readonly addedBy: string;
}

export interface PirDraft {
  readonly requirement: unknown; readonly decisionPoint: unknown; readonly ltiov: unknown; readonly indicators?: unknown; readonly requestedBy?: unknown;
  readonly label?: unknown; readonly status?: unknown;
}

const MAX_INDICATORS = 12;

function readIndicatorTexts(value: unknown): IntelResult<string[]> {
  if (value === undefined) return done([]);
  if (!Array.isArray(value) || value.length > MAX_INDICATORS) return refuse('bad-input', `indicators: a list of at most ${MAX_INDICATORS}`);
  const texts: string[] = [];
  for (const text of value) {
    if (!isOneLine(text, MAX_TEXT)) return refuse('bad-input', 'indicators: each is one line of text');
    texts.push(text.trim());
  }
  return done(texts);
}

function allIndicatorIds(register: readonly PirEntry[]): string[] {
  return register.flatMap((entry) => entry.indicators.map((indicator) => indicator.id));
}

function withIndicators(register: readonly PirEntry[], existing: readonly PirIndicator[], texts: readonly string[]): PirIndicator[] {
  const used = [...allIndicatorIds(register), ...existing.map((indicator) => indicator.id)];
  const out = [...existing];
  for (const text of texts) {
    const id = nextId('IND', used);
    used.push(id);
    out.push({ id, text });
  }
  return out;
}

function readDecisionPoint(decisionPoint: unknown, ltiov: unknown): IntelResult<{ decisionPoint: string; ltiov: string }> {
  if (!isOneLine(decisionPoint, 160)) return refuse('pir-decision-point', 'decisionPoint is missing');
  const time = readTime(ltiov);
  if (Number.isNaN(time)) return refuse('pir-decision-point', 'ltiov is missing or not an ISO time in UTC, a date or a DTG');
  return done({ decisionPoint: decisionPoint.trim(), ltiov: iso(time) });
}

/** A new PIR, always a candidate: a member drafts, the commander approves (02 T9). */
export function buildPirEntry(draft: PirDraft, register: readonly PirEntry[], addedBy: string): IntelResult<PirEntry> {
  if (draft.status !== undefined && draft.status !== 'candidate') {
    return isOneOf(PERSON_ONLY_PIR_STATUSES, draft.status) ? refuse('person-only') : refuse('pir-transition', 'a new PIR is a candidate');
  }
  const requirement = oneLine(draft.requirement, 'requirement');
  if (!requirement.ok) return requirement;
  const point = readDecisionPoint(draft.decisionPoint, draft.ltiov);
  if (!point.ok) return point;
  const texts = readIndicatorTexts(draft.indicators);
  if (!texts.ok) return texts;
  const requestedBy = draft.requestedBy === undefined ? done('j2') : oneLine(draft.requestedBy, 'requestedBy', 60);
  if (!requestedBy.ok) return requestedBy;
  const label = readLabel(draft.label);
  if (!label.ok) return label;
  return done({
    id: nextId('PIR', register.map((entry) => entry.id)), requirement: requirement.value, ...point.value,
    indicators: withIndicators(register, [], texts.value), status: 'candidate', requestedBy: requestedBy.value, label: label.value, addedBy
  });
}

function withoutDecision(entry: PirEntry): PirEntry {
  const copy: { -readonly [K in keyof PirEntry]?: PirEntry[K] } = { ...entry };
  delete copy.decision;
  return copy as PirEntry;
}

export interface PirChange {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly requirement?: unknown;
  readonly decisionPoint?: unknown;
  readonly ltiov?: unknown;
  readonly addIndicators?: unknown;
  readonly answeredBy?: unknown;
}

/**
 * A member's change to one PIR. Approving or rejecting is refused under `person-only` whatever the current status. Changing the requirement, decision
 * point or latest time of value of a PIR awaiting a decision returns it to candidate (the person must see the new wording); of a decided PIR it is
 * refused, because the commander decided on that wording. Indicators may be added at any open status: breaking a PIR into indicators is the
 * requirements manager's own work.
 */
export function changePir(register: readonly PirEntry[], change: PirChange, sources: readonly SourceEntry[]): IntelResult<PirEntry[]> {
  const index = register.findIndex((entry) => entry.id === change.id);
  if (index < 0) return refuse('unknown-entry', typeof change.id === 'string' ? change.id.slice(0, 20) : 'id');
  let entry: PirEntry = register[index];
  if (change.status !== undefined && isOneOf(PERSON_ONLY_PIR_STATUSES, change.status)) return refuse('person-only');
  const wording = change.requirement !== undefined || change.decisionPoint !== undefined || change.ltiov !== undefined;
  if (wording) {
    if (DECIDED_PIR_STATUSES.includes(entry.status)) return refuse('pir-locked', entry.id);
    const requirement = change.requirement === undefined ? done(entry.requirement) : oneLine(change.requirement, 'requirement');
    if (!requirement.ok) return requirement;
    const point = readDecisionPoint(change.decisionPoint ?? entry.decisionPoint, change.ltiov ?? entry.ltiov);
    if (!point.ok) return point;
    entry = { ...entry, requirement: requirement.value, ...point.value, ...(entry.status === 'awaiting-decision' ? { status: 'candidate' as const } : {}) };
  }
  if (change.addIndicators !== undefined) {
    if (entry.status === 'closed' || entry.status === 'rejected') return refuse('pir-transition', `${entry.id} is ${entry.status}`);
    const texts = readIndicatorTexts(change.addIndicators);
    if (!texts.ok) return texts;
    entry = { ...entry, indicators: withIndicators(register, entry.indicators, texts.value) };
  }
  if (change.status !== undefined && change.status !== entry.status) {
    if (!isOneOf(PIR_STATUSES, change.status)) return refuse('bad-input', `status: one of ${PIR_STATUSES.filter((status) => !PERSON_ONLY_PIR_STATUSES.includes(status)).join(', ')}`);
    const target = change.status;
    if (!MEMBER_PIR_MOVES.some((move) => move.from === entry.status && move.to === target)) return refuse('pir-transition', `${entry.status} to ${target}`);
    if (target === 'awaiting-decision' && entry.indicators.length === 0) return refuse('pir-transition', 'give the PIR at least one indicator before it goes for decision');
    let answeredBy: string[] | undefined;
    if (target === 'answered') {
      if (!Array.isArray(change.answeredBy) || change.answeredBy.length === 0) return refuse('bad-input', 'answeredBy: the items that answered it');
      answeredBy = [];
      for (const id of change.answeredBy) {
        if (typeof id !== 'string' || !sources.some((source) => source.id === id)) return refuse('unknown-entry', typeof id === 'string' ? id.slice(0, 20) : 'answeredBy');
        answeredBy.push(id);
      }
    }
    // Leaving a decided state for candidate drops the old decision with it: a rejected PIR that is reworded goes back for a fresh decision.
    const kept: PirEntry = target === 'candidate' ? withoutDecision(entry) : entry;
    entry = { ...kept, status: target, ...(answeredBy ? { answeredBy } : {}) };
  }
  const next = register.slice();
  next[index] = entry;
  return done(next);
}

/**
 * A named person's decision on a PIR awaiting one. This is the only way a PIR becomes approved or rejected; it is called by a person's command, never
 * by a tool, and refuses an actor that is not a named person with a device fingerprint. A rejection needs reasons.
 */
export function decidePir(register: readonly PirEntry[], id: string, decision: 'approved' | 'rejected', by: PersonActor, at: number, reasons: readonly string[] = []): IntelResult<PirEntry[]> {
  if (!isRecord(by) || ownValue(by, 'kind') !== 'person' || !isOneLine(by.name, 120) || !isOneLine(by.role, 80) || !isOneLine(by.deviceFingerprint, 200)) return refuse('person-only');
  const index = register.findIndex((entry) => entry.id === id);
  if (index < 0) return refuse('unknown-entry', id.slice(0, 20));
  const entry = register[index];
  if (entry.status !== 'awaiting-decision') return refuse('pir-transition', `${entry.status} to ${decision}`);
  if (decision === 'rejected' && reasons.filter((reason) => reason.trim() !== '').length === 0) return refuse('bad-input', 'a rejection needs reasons');
  const next = register.slice();
  next[index] = { ...entry, status: decision, decision: { decision, by, at: iso(at), ...(decision === 'rejected' ? { reasons: reasons.map((reason) => reason.trim()) } : {}) } };
  return done(next);
}

/**
 * The PIRs as far as a person's decisions are proven (review round 3 of drop 1): a PIR whose status says a person decided (approved, rejected, answered,
 * closed) counts as decided only when a signed entry in the decision log recorded that decision, by that person, on that exact wording
 * (personDecisions.ts). Any other is read as awaiting a decision, its written decision dropped, with a blocking finding: a decision is never trusted from
 * the register file alone, whoever wrote it there.
 */
export function trustPirDecisions(register: readonly PirEntry[], recorded: ReadonlyMap<string, PersonDecisionEntry>): { readonly entries: PirEntry[]; readonly findings: IntelFinding[] } {
  const findings: IntelFinding[] = [];
  const entries = register.map((entry) => {
    const decided = PERSON_ONLY_PIR_STATUSES.includes(entry.status) || DECIDED_PIR_STATUSES.includes(entry.status);
    if (!decided) return entry;
    const expected = entry.status === 'rejected' ? 'rejected' : 'approved';
    const record = recorded.get(decisionKey({ kind: 'pir', id: entry.id }));
    if (entry.decision?.decision === expected && decisionMatches(record, entry.decision, pirWording(entry))) return entry;
    findings.push({ rule: 'decision-unrecorded', severity: 'block', subject: entry.id, message: `${entry.id} says ${entry.status}, but no signed decision by a person records that on this wording, so it is read as awaiting a decision. Only NEAR AI: Staff: Decide a PIR records a PIR decision.` });
    const { decision: _dropped, ...rest } = entry;
    return { ...rest, status: 'awaiting-decision' as const };
  });
  return { entries, findings };
}

/** Findings over the PIR register: latest times of value that have passed, PIRs without indicators, and decided PIRs with no collection recommended. */
export function pirFindings(register: readonly PirEntry[], plan: readonly CollectionEntry[], now: number): IntelFinding[] {
  const findings: IntelFinding[] = [];
  for (const entry of register) {
    const open = entry.status === 'candidate' || entry.status === 'awaiting-decision' || entry.status === 'approved';
    if (open && Date.parse(entry.ltiov) < now) {
      findings.push({ rule: 'ltiov-passed', severity: 'warning', subject: entry.id, message: `${entry.id}'s latest time of value (${formatDtg(Date.parse(entry.ltiov))}) has passed without an answer. Recommend it for review: the decision at ${entry.decisionPoint} no longer waits on it.` });
    }
    if (open && entry.indicators.length === 0) {
      findings.push({ rule: 'pir-no-indicators', severity: 'warning', subject: entry.id, message: `${entry.id} has no indicators, so nothing can be collected against it. Break it into indicators.` });
    }
    if (entry.status === 'approved' && !plan.some((recommendation) => recommendation.pir === entry.id)) {
      findings.push({ rule: 'pir-uncovered', severity: 'warning', subject: entry.id, message: `${entry.id} is approved but the collection plan recommends nothing against it.` });
    }
  }
  return findings;
}

// ---- The collection plan ----------------------------------------------------------------------------------------------------------------------

/** What a recommendation needs before it can happen: the J3's approval of the asset allocation, or a partner (partner-only disciplines). */
export const COLLECTION_NEEDS = ['j3-approval', 'partner'] as const;
export type CollectionNeed = (typeof COLLECTION_NEEDS)[number];

export interface CollectionEntry {
  readonly id: string;
  readonly pir: string;
  readonly indicator: string;
  /** The named area of interest, as the event template names it. */
  readonly nai: string;
  /** The capability the J2 recommends; never an order to an asset. */
  readonly capability: string;
  readonly discipline: IntelligenceDiscipline;
  readonly timing: { readonly from: string; readonly to: string };
  readonly needs: CollectionNeed;
  /** Always a recommendation: the J3 approves allocation and tasks assets. */
  readonly status: 'recommended';
  readonly note?: string;
  readonly label: string;
  readonly addedBy: string;
}

export interface CollectionDraft {
  readonly pir: unknown; readonly indicator: unknown; readonly nai: unknown; readonly capability: unknown; readonly discipline: unknown;
  readonly from: unknown; readonly to: unknown; readonly needs?: unknown; readonly note?: unknown; readonly label?: unknown; readonly status?: unknown;
}

/**
 * Words that turn a recommendation into an order to an asset. A recommendation says what would answer the indicator ("recommend a UAS sweep of
 * NAI 3"); it never tasks, assigns, allocates or directs anything, and never says a task has been given (02 Pitfall 4; Bastion's validation fixtures).
 */
const TASKING_WORDS = [
  /^\s*(task|assign|allocate|direct|order|launch|deploy|dispatch)\b/i,
  /\b(is|are|was|were|has been|have been|been)\s+(tasked|assigned|allocated|directed|ordered|dispatched)\b/i,
  /\btask(?:ed|ing)?\s+(?:the\s+|our\s+|a\s+)?(?!requests?\b)(?:[A-Za-z0-9-]+\s+){1,3}to\b/i
];

export function taskingLanguage(text: string): boolean {
  return TASKING_WORDS.some((pattern) => pattern.test(text));
}

export function buildCollectionEntry(draft: CollectionDraft, plan: readonly CollectionEntry[], pirs: readonly PirEntry[], addedBy: string): IntelResult<CollectionEntry> {
  if (draft.status !== undefined && draft.status !== 'recommended') return refuse('collection-recommend-only', 'status is always recommended');
  const pir = pirs.find((entry) => entry.id === draft.pir);
  if (!pir) return refuse('unknown-entry', typeof draft.pir === 'string' ? draft.pir.slice(0, 20) : 'pir');
  if (pir.status === 'rejected' || pir.status === 'closed' || pir.status === 'answered') return refuse('pir-transition', `${pir.id} is ${pir.status}; collection against it is not needed`);
  if (typeof draft.indicator !== 'string' || !pir.indicators.some((indicator) => indicator.id === draft.indicator)) return refuse('collection-indicator', `${pir.id} has ${pir.indicators.map((indicator) => indicator.id).join(', ') || 'no indicators'}`);
  const nai = oneLine(draft.nai, 'nai', 60);
  if (!nai.ok) return nai;
  const capability = oneLine(draft.capability, 'capability', 160);
  if (!capability.ok) return capability;
  const note = draft.note === undefined || draft.note === '' ? done('') : oneLine(draft.note, 'note');
  if (!note.ok) return note;
  if (taskingLanguage(capability.value) || taskingLanguage(note.value)) return refuse('collection-recommend-only', 'write what you recommend, not a tasking');
  if (!isOneOf(INTELLIGENCE_DISCIPLINES, draft.discipline)) return refuse('bad-input', `discipline: one of ${INTELLIGENCE_DISCIPLINES.join(', ')}`);
  const needs = draft.needs ?? (PARTNER_ONLY_DISCIPLINES.includes(draft.discipline) ? 'partner' : 'j3-approval');
  if (!isOneOf(COLLECTION_NEEDS, needs)) return refuse('collection-recommend-only', `needs: one of ${COLLECTION_NEEDS.join(', ')}`);
  if (PARTNER_ONLY_DISCIPLINES.includes(draft.discipline) && needs !== 'partner') return refuse('partner-only', draft.discipline);
  const from = readTime(draft.from);
  const to = readTime(draft.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return refuse('bad-input', 'from and to: ISO times in UTC, dates or DTGs');
  if (to < from) return refuse('bad-input', 'to is before from');
  if (to > Date.parse(pir.ltiov)) return refuse('collection-after-ltiov', `${pir.id}'s latest time of value is ${formatDtg(Date.parse(pir.ltiov))}`);
  const label = readLabel(draft.label);
  if (!label.ok) return label;
  return done({
    id: nextId('CR', plan.map((entry) => entry.id)), pir: pir.id, indicator: draft.indicator, nai: nai.value, capability: capability.value,
    discipline: draft.discipline, timing: { from: iso(from), to: iso(to) }, needs, status: 'recommended',
    ...(note.value ? { note: note.value } : {}), label: label.value, addedBy
  });
}

/** Findings over the plan: single-discipline reliance per PIR, collection against an unapproved PIR, and timing past a latest time of value that moved. */
export function collectionFindings(plan: readonly CollectionEntry[], pirs: readonly PirEntry[]): IntelFinding[] {
  const findings: IntelFinding[] = [];
  const byPir = new Map<string, CollectionEntry[]>();
  for (const entry of plan) byPir.set(entry.pir, [...(byPir.get(entry.pir) ?? []), entry]);
  for (const [id, entries] of byPir) {
    const pir = pirs.find((candidate) => candidate.id === id);
    if (!pir) {
      findings.push({ rule: 'collection-orphan', severity: 'warning', subject: id, message: `The collection plan recommends collection against ${id}, which is not in the PIR register.` });
      continue;
    }
    const disciplines = new Set(entries.map((entry) => entry.discipline));
    if (disciplines.size === 1) {
      findings.push({ rule: 'single-discipline', severity: 'advice', subject: id, message: `Every recommendation against ${id} uses ${[...disciplines][0]}. Avoid relying on one discipline: add another that could answer the same indicators.` });
    }
    if (pir.status === 'candidate' || pir.status === 'awaiting-decision') {
      findings.push({ rule: 'pir-not-approved', severity: 'advice', subject: id, message: `${id} is not approved yet; its recommendations are an initial plan until the commander decides.` });
    }
    for (const entry of entries) {
      if (Date.parse(entry.timing.to) > Date.parse(pir.ltiov)) {
        findings.push({ rule: 'collection-after-ltiov', severity: 'warning', subject: entry.id, message: `${entry.id} runs to ${formatDtg(Date.parse(entry.timing.to))}, after ${id}'s latest time of value (${formatDtg(Date.parse(pir.ltiov))}).` });
      }
    }
  }
  return findings;
}

/** The collection plan as the Markdown table the J3 reads, with the rule line above it. */
export function renderCollectionPlan(plan: readonly CollectionEntry[], pirs: readonly PirEntry[]): string {
  const cell = (text: string) => text.replace(/\|/g, '/');
  const rows = plan.map((entry) => {
    const pir = pirs.find((candidate) => candidate.id === entry.pir);
    const indicator = pir?.indicators.find((candidate) => candidate.id === entry.indicator);
    return `| ${entry.id}: ${cell(entry.pir)} ${cell(pir?.requirement ?? '')} | ${cell(entry.indicator)} ${cell(indicator?.text ?? '')} | ${cell(entry.nai)} | Recommend: ${cell(entry.capability)} (${entry.discipline}) | ${formatDtg(Date.parse(entry.timing.from))} to ${formatDtg(Date.parse(entry.timing.to))} | ${entry.needs === 'partner' ? 'Partner' : 'J3 approval'} |`;
  });
  return [COLLECTION_PLAN_RULE, '', `| ${COLLECTION_PLAN_HEADINGS.join(' | ')} |`, `|${COLLECTION_PLAN_HEADINGS.map(() => '---').join('|')}|`, ...rows].join('\n');
}

/** The PIR register as the Markdown table the staff reads. */
export function renderPirRegister(register: readonly PirEntry[]): string {
  const cell = (text: string) => text.replace(/\|/g, '/');
  const rows = register.map((entry) => `| ${entry.id}: ${cell(entry.requirement)} | ${cell(entry.decisionPoint)} | ${entry.indicators.map((indicator) => `${indicator.id} ${cell(indicator.text)}`).join('; ') || 'none'} | ${formatDtg(Date.parse(entry.ltiov))} | ${entry.status}${entry.decision ? ` (${entry.decision.by.role}, ${entry.decision.by.name})` : ''} |`);
  return [`| ${PIR_REGISTER_HEADINGS.join(' | ')} |`, `|${PIR_REGISTER_HEADINGS.map(() => '---').join('|')}|`, ...rows].join('\n');
}

// ---- Register files ---------------------------------------------------------------------------------------------------------------------------

export const INTEL_REGISTER_NAMES = ['source-register', 'pir-register', 'collection-plan'] as const;
export type IntelRegisterName = (typeof INTEL_REGISTER_NAMES)[number];
export const INTEL_FORMAT_VERSION = 1;

/**
 * The J2 products folder (design 10, 3.1: structured registers sit beside the products as JSON). The source register here is the project's one source
 * register: the tradecraft lint reads it too when a product carries no sources block of its own.
 */
export const INTEL_FOLDER = '.planning/staff/products/j2';
export function registerPath(name: IntelRegisterName): string {
  return `${INTEL_FOLDER}/${name}.json`;
}

/**
 * A register as file text: one entry per line, so two members' work merges line by line and a person can read a diff. Parsed back by
 * `parseRegisterText` to the same entries.
 */
export function renderRegister(name: IntelRegisterName, entries: readonly object[]): string {
  const lines = entries.map((entry, index) => `    ${JSON.stringify(entry)}${index < entries.length - 1 ? ',' : ''}`);
  return `{\n  "register": "${name}",\n  "formatVersion": ${INTEL_FORMAT_VERSION},\n  "entries": [\n${lines.join('\n')}${lines.length ? '\n' : ''}  ]\n}\n`;
}

const SOURCE_KEYS = ['id', 'title', 'source', 'origin', 'discipline', 'url', 'reportedAt', 'accessedAt', 'reliability', 'credibility', 'claims', 'deceptionNote', 'label', 'addedBy'];
const PIR_KEYS = ['id', 'requirement', 'decisionPoint', 'ltiov', 'indicators', 'status', 'requestedBy', 'answeredBy', 'decision', 'label', 'addedBy'];
const COLLECTION_KEYS = ['id', 'pir', 'indicator', 'nai', 'capability', 'discipline', 'timing', 'needs', 'status', 'note', 'label', 'addedBy'];

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const isIsoText = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(parseIsoMillis(value));

function checkSource(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, SOURCE_KEYS)) return 'fields';
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !SOURCE_ID.test(id)) return 'id';
  const grades = readGrades(ownValue(value, 'reliability'), ownValue(value, 'credibility'));
  if (!grades.ok || typeof ownValue(value, 'credibility') !== 'number') return `${id} grades`;
  for (const key of ['title', 'source', 'origin', 'deceptionNote', 'addedBy']) if (!isOneLine(ownValue(value, key), MAX_TEXT)) return `${id} ${key}`;
  if (!isOneOf(INTELLIGENCE_DISCIPLINES, ownValue(value, 'discipline'))) return `${id} discipline`;
  const url = ownValue(value, 'url');
  if (url !== undefined && (typeof url !== 'string' || !URL_PATTERN.test(url))) return `${id} url`;
  if (!isIsoText(ownValue(value, 'reportedAt')) || !isIsoText(ownValue(value, 'accessedAt'))) return `${id} times`;
  const claims = readClaims(ownValue(value, 'claims'));
  if (!claims.ok || !Array.isArray(ownValue(value, 'claims'))) return `${id} claims`;
  if (!isTemplateLabel(ownValue(value, 'label'))) return `${id} label`;
  return undefined;
}

function checkPir(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, PIR_KEYS)) return 'fields';
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !PIR_ID.test(id)) return 'id';
  if (!isOneLine(ownValue(value, 'requirement'), MAX_TEXT)) return `${id} requirement`;
  // The rule held on the file too: a hand-edited PIR without a decision point or a latest time of value does not load.
  if (!isOneLine(ownValue(value, 'decisionPoint'), 160) || !isIsoText(ownValue(value, 'ltiov'))) return `${id} decision point and latest time of value`;
  const indicators = ownValue(value, 'indicators');
  if (!Array.isArray(indicators) || !indicators.every((indicator) => isRecord(indicator) && onlyKeys(indicator, ['id', 'text'])
    && typeof ownValue(indicator, 'id') === 'string' && INDICATOR_ID.test(ownValue(indicator, 'id') as string) && isOneLine(ownValue(indicator, 'text'), MAX_TEXT))) return `${id} indicators`;
  const status = ownValue(value, 'status');
  if (!isOneOf(PIR_STATUSES, status)) return `${id} status`;
  const decision = ownValue(value, 'decision');
  // A decided status without a person's decision on record reads as damaged, so a hand edit cannot approve a PIR (the release state machine's rule).
  if (isOneOf(PERSON_ONLY_PIR_STATUSES, status) || decision !== undefined) {
    if (!isRecord(decision)) return `${id} decision`;
    const by = ownValue(decision, 'by');
    if (!isRecord(by) || ownValue(by, 'kind') !== 'person' || !isOneLine(ownValue(by, 'name'), 120) || !isOneLine(ownValue(by, 'role'), 80) || !isOneLine(ownValue(by, 'deviceFingerprint'), 200)) return `${id} decision`;
    if (!isIsoText(ownValue(decision, 'at')) || !isOneOf(['approved', 'rejected'] as const, ownValue(decision, 'decision'))) return `${id} decision`;
  }
  if (isOneOf(['answered', 'closed'] as const, status) && (decision === undefined || ownValue(decision as Record<string, unknown>, 'decision') !== 'approved')) return `${id} decision`;
  if (!isOneLine(ownValue(value, 'requestedBy'), 60) || !isOneLine(ownValue(value, 'addedBy'), MAX_TEXT)) return `${id} requestedBy`;
  const answeredBy = ownValue(value, 'answeredBy');
  if (answeredBy !== undefined && !(Array.isArray(answeredBy) && answeredBy.every((source) => typeof source === 'string' && SOURCE_ID.test(source)))) return `${id} answeredBy`;
  if (!isTemplateLabel(ownValue(value, 'label'))) return `${id} label`;
  return undefined;
}

function checkCollection(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, COLLECTION_KEYS)) return 'fields';
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !COLLECTION_ID.test(id)) return 'id';
  // Only recommendations load: a hand-edited "tasked" line is refused, so the plan can never claim the J2 tasked an asset.
  if (ownValue(value, 'status') !== 'recommended') return `${id} status`;
  if (typeof ownValue(value, 'pir') !== 'string' || !PIR_ID.test(ownValue(value, 'pir') as string)) return `${id} pir`;
  if (typeof ownValue(value, 'indicator') !== 'string' || !INDICATOR_ID.test(ownValue(value, 'indicator') as string)) return `${id} indicator`;
  for (const key of ['nai', 'capability', 'addedBy']) if (!isOneLine(ownValue(value, key), MAX_TEXT)) return `${id} ${key}`;
  const note = ownValue(value, 'note');
  if (note !== undefined && !isOneLine(note, MAX_TEXT)) return `${id} note`;
  if (taskingLanguage(ownValue(value, 'capability') as string) || (typeof note === 'string' && taskingLanguage(note))) return `${id} tasking`;
  const discipline = ownValue(value, 'discipline');
  if (!isOneOf(INTELLIGENCE_DISCIPLINES, discipline)) return `${id} discipline`;
  const needs = ownValue(value, 'needs');
  if (!isOneOf(COLLECTION_NEEDS, needs) || (PARTNER_ONLY_DISCIPLINES.includes(discipline) && needs !== 'partner')) return `${id} needs`;
  const timing = ownValue(value, 'timing');
  if (!isRecord(timing) || !onlyKeys(timing, ['from', 'to']) || !isIsoText(ownValue(timing, 'from')) || !isIsoText(ownValue(timing, 'to'))) return `${id} timing`;
  if (!isTemplateLabel(ownValue(value, 'label'))) return `${id} label`;
  return undefined;
}

const CHECKS: Readonly<Record<IntelRegisterName, (value: unknown) => string | undefined>> = {
  'source-register': checkSource, 'pir-register': checkPir, 'collection-plan': checkCollection
};

export interface RegisterTypes { 'source-register': SourceEntry; 'pir-register': PirEntry; 'collection-plan': CollectionEntry }

/** Reads a register file strictly. An absent file is an empty register; a file in another shape is `register-damaged` with the entry and field named. */
export function parseRegisterText<N extends IntelRegisterName>(name: N, text: string | undefined): IntelResult<RegisterTypes[N][]> {
  if (text === undefined || text.trim() === '') return done([]);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse('register-damaged', `${name}: not JSON`); }
  if (!isRecord(value) || !onlyKeys(value, ['register', 'formatVersion', 'entries'])) return refuse('register-damaged', `${name}: fields`);
  if (ownValue(value, 'register') !== name || ownValue(value, 'formatVersion') !== INTEL_FORMAT_VERSION) return refuse('register-damaged', `${name}: register name or format version`);
  const entries = ownValue(value, 'entries');
  if (!Array.isArray(entries)) return refuse('register-damaged', `${name}: entries`);
  const ids: string[] = [];
  for (const entry of entries) {
    const problem = CHECKS[name](entry);
    if (problem) return refuse('register-damaged', `${name}: ${problem}`);
    const id = ownValue(entry as Record<string, unknown>, 'id') as string;
    if (ids.includes(id)) return refuse('register-damaged', `${name}: ${id} twice`);
    ids.push(id);
  }
  // Re-read through JSON so no prototype from the file survives (the parse rule of src/domain/staff/parse.ts).
  return done(JSON.parse(JSON.stringify(entries)) as RegisterTypes[N][]);
}

export interface IntelRegisters { readonly sources: readonly SourceEntry[]; readonly pirs: readonly PirEntry[]; readonly plan: readonly CollectionEntry[] }

/** Every finding over the three registers together, most severe first. What the tradecraft reviewer's lint and the J2 chief read. */
export function registerFindings(registers: IntelRegisters, now: number): IntelFinding[] {
  const order: Record<FindingSeverity, number> = { block: 0, warning: 1, advice: 2 };
  const findings = [...sourceFindings(registers.sources), ...pirFindings(registers.pirs, registers.plan, now), ...collectionFindings(registers.plan, registers.pirs)];
  for (const pir of registers.pirs) {
    for (const source of pir.answeredBy ?? []) {
      if (!registers.sources.some((entry) => entry.id === source)) findings.push({ rule: 'answer-missing', severity: 'warning', subject: pir.id, message: `${pir.id} is answered by ${source}, which is not in the source register.` });
    }
  }
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---- INTSUM and INTREP drafting ---------------------------------------------------------------------------------------------------------------

const ANALYST_NOTE = (what: string) => `<!-- ${what} -->`;

function sourceLine(entry: SourceEntry, register: readonly SourceEntry[]): string {
  const corroborations = entry.claims.map((claim) => corroboration(register, claim));
  const weakest = corroborations.length ? Math.min(...corroborations.map((found) => found.independent)) : 1;
  const repeated = corroborations.some((found) => found.repeated);
  const independence = weakest >= 2 ? `${weakest} independent origins` : `one origin only${repeated ? ' (other reports repeat it)' : ''}`;
  return `- ${entry.id} (${gradeText(entry)}: ${gradeWords(entry)}; ${entry.discipline}; origin: ${entry.origin}; ${independence}) ${entry.title}. Reported ${formatDtg(Date.parse(entry.reportedAt))}.`;
}

interface DraftContext {
  readonly registers: IntelRegisters;
  readonly settings: Pick<StaffSettings, 'profile' | 'level'>;
  readonly label: string;
  readonly owner: string;
}

function draftHeader(product: string, context: DraftContext): string {
  return renderProductHeader({
    product, kind: 'report', section: 'j2', owner: context.owner, profile: context.settings.profile, level: context.settings.level,
    version: 1, state: 'draft', label: context.label, dependsOn: []
  });
}

/**
 * An INTSUM skeleton for one period: the header, the five headings, significant activity filled from the source register (items reported in the
 * period, each with its two grades and how many independent origins stand behind it), and gaps from the open PIRs. The assessment of intent and the
 * changes since last are left to the analyst, marked, because they are judgement.
 */
export function draftIntsum(context: DraftContext, period: { readonly from: number; readonly to: number }, now: number): IntelResult<string> {
  if (!isTemplateLabel(context.label)) return refuse('label-ceiling', String(context.label).slice(0, 60));
  if (!(period.from < period.to)) return refuse('bad-input', 'the period ends before it starts');
  const [period_, activity, intent, changes, gaps] = INTEL_REPORTS.intsum.headings;
  const inPeriod = context.registers.sources.filter((entry) => {
    const at = Date.parse(entry.reportedAt);
    return at >= period.from && at <= period.to;
  });
  const open = context.registers.pirs.filter((pir) => pir.status === 'approved' || pir.status === 'awaiting-decision' || pir.status === 'candidate');
  const gapLines = open.map((pir) => {
    const left = Date.parse(pir.ltiov) - now;
    const when = left < 0 ? 'latest time of value passed' : `latest time of value ${formatDtg(Date.parse(pir.ltiov))}, ${Math.floor(left / 3_600_000)} hours left`;
    return `- ${pir.id} (${pir.status}; supports ${pir.decisionPoint}): ${pir.requirement} Not answered; ${when}.`;
  });
  const body = [
    `# ${INTEL_REPORTS.intsum.name} ${formatDtg(period.to)}`,
    '',
    `## ${period_}`, '', `${formatDtg(period.from)} to ${formatDtg(period.to)}`, '',
    `## ${activity}`, '', ...(inPeriod.length ? inPeriod.map((entry) => sourceLine(entry, context.registers.sources)) : ['No items in the source register were reported in this period.']), '',
    `## ${intent}`, '', ANALYST_NOTE('Analyst: your judgement of intent, with ICD 203 likelihood terms. Mark judgements as judgements and keep confidence in its own sentence.'), '',
    `## ${changes}`, '', ANALYST_NOTE('Analyst: what changed since the last INTSUM, and why any judgement changed.'), '',
    `## ${gaps}`, '', ...(gapLines.length ? gapLines : ['No open PIRs.']), ''
  ];
  return done(`${draftHeader(`intsum-${dtgSlug(period.to)}`, context)}${body.join('\n')}`);
}

/**
 * An INTREP skeleton for an event: what happened, which indicators it fires (with the PIR and decision point each serves), the items it rests on with
 * their grades and independence, and a marked place for the deduction, which is the analyst's.
 */
export function draftIntrep(context: DraftContext, event: { readonly text: unknown; readonly at: number; readonly sources: unknown; readonly indicators?: unknown }): IntelResult<string> {
  if (!isTemplateLabel(context.label)) return refuse('label-ceiling', String(context.label).slice(0, 60));
  const text = oneLine(event.text, 'event', 500);
  if (!text.ok) return text;
  if (!Array.isArray(event.sources) || event.sources.length === 0) return refuse('bad-input', 'sources: the items the report rests on');
  const items: SourceEntry[] = [];
  for (const id of event.sources) {
    const found = context.registers.sources.find((entry) => entry.id === id);
    if (!found) return refuse('unknown-entry', typeof id === 'string' ? id.slice(0, 20) : 'sources');
    items.push(found);
  }
  const fired: string[] = [];
  if (event.indicators !== undefined) {
    if (!Array.isArray(event.indicators)) return refuse('bad-input', 'indicators');
    for (const id of event.indicators) {
      const pir = context.registers.pirs.find((entry) => entry.indicators.some((indicator) => indicator.id === id));
      if (!pir) return refuse('unknown-entry', typeof id === 'string' ? id.slice(0, 20) : 'indicators');
      const indicator = pir.indicators.find((entry) => entry.id === id)!;
      fired.push(`- Indicator ${indicator.id} (${indicator.text}) of ${pir.id}, which supports ${pir.decisionPoint}; latest time of value ${formatDtg(Date.parse(pir.ltiov))}.`);
    }
  }
  const [eventHeading, deduction] = INTEL_REPORTS.intrep.headings;
  const independent = new Set(items.map((entry) => originKey(entry.origin))).size;
  const body = [
    `# ${INTEL_REPORTS.intrep.name} ${formatDtg(event.at)}`,
    '',
    `## ${eventHeading}`, '', `${formatDtg(event.at)}: ${text.value}`, '',
    ...(fired.length ? ['Indicators fired:', ...fired, ''] : []),
    'Rests on:', ...items.map((entry) => sourceLine(entry, context.registers.sources)),
    `${items.length} item${items.length === 1 ? '' : 's'} from ${independent} independent origin${independent === 1 ? '' : 's'}.${items.length > independent ? ' Items that share an origin count once.' : ''}`, '',
    `## ${deduction}`, '', ANALYST_NOTE('Analyst: your deduction, with ICD 203 likelihood terms. Say what it means for the decision point and what to watch next.'), ''
  ];
  return done(`${draftHeader(`intrep-${dtgSlug(event.at)}`, context)}${body.join('\n')}`);
}

// ---- Compilation risk -------------------------------------------------------------------------------------------------------------------------

/** What kind of detail a line holds. A compilation is several kinds together, or the same kinds piling up across items. */
export const COMPILATION_CATEGORIES = ['unit', 'location', 'capability', 'timing'] as const;
export type CompilationCategory = (typeof COMPILATION_CATEGORIES)[number];

const ECHELON = '(?:corps|division|brigade|battalion|regiment|squadron|company|battery|flotilla|fleet|wing|group|task force|bde|bn|regt|div|sqn|coy|bty)';
const CATEGORY_PATTERNS: Readonly<Record<CompilationCategory, readonly RegExp[]>> = {
  unit: [
    new RegExp(`\\b\\d{1,3}(?:st|nd|rd|th)?\\s+(?:[A-Z][A-Za-z-]+\\s+){0,3}${ECHELON}\\b`, 'i'),
    new RegExp(`\\b${ECHELON}\\s+(?:no\\.?\\s*)?\\d{1,3}\\b`, 'i')
  ],
  location: [
    /-?\b\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/,
    /\b\d{1,3}°\s*\d{1,2}['′]\s*(?:\d{1,2}(?:\.\d+)?["″]\s*)?[NS]\b/i,
    /\b\d{1,2}[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(?:\d{4}|\d{6}|\d{8}|\d{10}|\d{2}\s\d{2}|\d{3}\s\d{3}|\d{4}\s\d{4}|\d{5}\s\d{5})\b/,
    /\bgrid\s+\d{4,10}\b/i
  ],
  capability: [
    /\b\d+\s+(?:x\s+)?(?:tanks?|launchers?|aircraft|helicopters?|vessels?|ships?|submarines?|missiles?|rockets?|radars?|guns?|howitzers?|UAVs?|UAS|drones?|APCs?|IFVs?|vehicles?|troops|soldiers|personnel)\b/i,
    /\b(?:readiness|serviceab(?:le|ility)|ammunition (?:state|stocks?)|fuel state|stocks? of|range of \d+|maximum range|order of battle|ORBAT|strength of \d+)\b/i
  ],
  timing: [
    /\b\d{6}Z\s+[A-Z]{3}\s+\d{2}\b/,
    /\b(?:will move|moving to|moved to|deploy(?:s|ed|ing)? to|arriv(?:e|es|ed|ing) (?:at|in)|depart(?:s|ed|ing)?|H-hour|D-day|NLT|no later than)\b/i
  ]
};

export interface CompilationItem { readonly id: string; readonly text: string }

export interface CompilationResult {
  /** `review` asks a person with authority; `none` means the mechanical check found no pattern. Neither clears anything. */
  readonly risk: 'none' | 'review';
  readonly reasons: readonly string[];
  readonly counts: Readonly<Record<CompilationCategory, number>>;
  /** Items that tie two or more kinds of detail together. */
  readonly associations: ReadonlyArray<{ readonly item: string; readonly categories: readonly CompilationCategory[] }>;
  readonly question?: string;
}

/**
 * How many items with unit, location or capability detail make an accumulation worth a person's look, once all three kinds are present. Five is a
 * judgement for exercise data (design 7.3 asks for a warning "when real-looking unit, location or capability data accumulates" and names no number);
 * it is one constant so a security officer can change it in one place.
 */
export const COMPILATION_ACCUMULATION_ITEMS = 5;

export const COMPILATION_QUESTION =
  'Taken together, do these items reveal an association or relationship that none of them reveals alone (EO 13526 section 1.7(e); the Canadian guidance that a bundle may be more sensitive than its parts)? A person with the authority to decide answers this; until then the release-guard writes HOLD with this question.';
export const COMPILATION_NONE_TEXT =
  'The mechanical check found no compilation pattern. This does not clear the product: the release-guard still judges compilation, and a person releases.';

export function categoriesOf(text: string): CompilationCategory[] {
  return COMPILATION_CATEGORIES.filter((category) => CATEGORY_PATTERNS[category].some((pattern) => pattern.test(text)));
}

/**
 * The compilation-risk check (design 10, 4.2 and 7.3; 02 Pitfall 10): an item that ties a unit to a location, or to a capability, is an association;
 * unit, location and capability detail spread over enough items is an accumulation. Either one is a `review` with the question for a person. The check
 * never answers the question and never says a product is cleared.
 */
export function compilationRisk(items: readonly CompilationItem[]): CompilationResult {
  const counts: Record<CompilationCategory, number> = { unit: 0, location: 0, capability: 0, timing: 0 };
  const associations: Array<{ item: string; categories: CompilationCategory[] }> = [];
  let detailed = 0;
  for (const item of items) {
    const categories = categoriesOf(item.text);
    for (const category of categories) counts[category] += 1;
    if (categories.some((category) => category !== 'timing')) detailed += 1;
    if (categories.includes('unit') && (categories.includes('location') || categories.includes('capability'))) associations.push({ item: item.id, categories });
  }
  const reasons: string[] = [];
  for (const association of associations) reasons.push(`${association.item} ties ${association.categories.join(', ')} detail together in one place.`);
  if (counts.unit > 0 && counts.location > 0 && counts.capability > 0 && detailed >= COMPILATION_ACCUMULATION_ITEMS) {
    reasons.push(`Unit, location and capability detail accumulates across ${detailed} items (${counts.unit} with units, ${counts.location} with locations, ${counts.capability} with capabilities).`);
  }
  return reasons.length
    ? { risk: 'review', reasons, counts, associations, question: COMPILATION_QUESTION }
    : { risk: 'none', reasons, counts, associations };
}

/** A product's lines, and the source register's items, as compilation items: what one product puts together with what it draws on. */
export function compilationItems(productText: string, sources: readonly SourceEntry[]): CompilationItem[] {
  // The product header is about the product, not its content, so only the body is read; line numbers still count from the top of the file.
  const parts = splitProductFile(productText);
  const skipped = parts ? productText.slice(0, productText.length - parts.body.length).split(/\r?\n/).length - 1 : 0;
  const body = parts ? parts.body : productText;
  const lines = body.split(/\r?\n/).map((line, index) => ({ id: `line ${index + 1 + skipped}`, text: line.trim() })).filter((item) => item.text !== '');
  return [...lines, ...sources.map((entry) => ({ id: entry.id, text: `${entry.title} ${entry.claims.join(' ')}` }))];
}
