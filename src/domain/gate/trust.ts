// TrustFacts and the trust line (FND-06, D-38, D-23). Pure: no I/O, no clock, no vscode, no package. Read by the trust badge (41-13), the picker and records.
// One record says what a decision allowed: where the request runs (the place), how far the check of it got (the three shipped proof levels, or not checked
// yet), what let it go (the routing table for a label, a named person's authorization, a model approval), the label as decided and the use. The line reads
// it in three parts, always in this order and in the glossary's words: "Runs on {place} · {verified} · {allowed}". Every fixed word is in TRUST_LINE_TEXT,
// which SECURITY.md quotes (41-15) and the copy lint reads (41-11), so none is a word people never see.
import { SELF_SIGNED_TEXT } from './authorizations';
import type { Mark } from './dominance';
import type { EndpointClass, EndpointRegion } from './endpoints';
import { labelKeyShownWithMarkings } from './labelAlgebra';
import { labelKey, splitLabelKey } from './labels';
import type { Label, ScaleTable } from './labels';
import type { UseTier } from './models';
import { endpointOf, isLocalRouteHost, strictestLabelOf } from './routing';
import type { AllowingRecord, ReportedRouteRule, RouteDecision, RouteEndpoint, RouteFacts, RoutingTable } from './routing';
import { TRUST_BADGE_STATES } from './trustBadge';
import { USE_TIER_WORDS } from './useTier';
import { MONTHS, PLACE_TEXT, dateShown, placeShown } from './placeWords';

/** The date and place words live in placeWords.ts (74.1-04) and are re-exported here for the trust line's users. */
export { dateShown, placeShown };

/** How far the check of a request got: the three shipped proof levels unchanged (CLAS-08), then the state before any check ran. */
export const TRUST_VERIFICATION_LEVELS = Object.freeze([...TRUST_BADGE_STATES, 'not-checked'] as const);
export type TrustVerificationLevel = (typeof TRUST_VERIFICATION_LEVELS)[number];

/** Where a request runs: a place class (or `unknown` for a place your rules do not name), its stated region, and the names that say whose it is. */
export interface TrustPlace {
  readonly class: EndpointClass | 'unknown';
  readonly region: EndpointRegion;
  /** The entry's provider token (`cohere`, `example-api`). */
  readonly provider?: string;
  /** Where NEAR AI forwards a model that does not run in its private hardware. */
  readonly forwardedTo?: string;
  /** The id of the entry in your organization's list of places. */
  readonly endpointId?: string;
}

/** The one record the trust line, the badge, the picker and records read (D-38). */
export interface TrustFacts {
  readonly place: TrustPlace;
  readonly verification: TrustVerificationLevel;
  /** What let the request go, the routing table's record first; empty for a refused request. */
  readonly allowedBy: readonly AllowingRecord[];
  /** The label as decided (the strictest of the mark, or the default label), its compartments untouched (D-62). */
  readonly label?: Label;
  readonly use?: UseTier;
  /** The report-only rules that would have refused, sorted. */
  readonly wouldRefuse: readonly ReportedRouteRule[];
  /** The SHA-256 of the passport that decided the request, beside its model-approval record (74.1 D-23). */
  readonly passportHash?: string;
}

export interface TrustContext {
  readonly mark: Mark;
  readonly routing: RoutingTable;
  readonly defaultLabel?: Label;
}

export interface TrustExtra {
  /** Where NEAR AI forwards the model, from the catalog. */
  readonly forwardedTo?: string;
  /** The provider, when the place's entry names none. */
  readonly provider?: string;
  /** The badge's proof level once its check ran; `not-checked` until then. */
  readonly verification?: TrustVerificationLevel;
}

/** The place from the decision, or, with no place on it, from the client: this computer, a host your routing names, NEAR AI Cloud, or unknown. */
function placeFrom(decision: RouteDecision, facts: RouteFacts, routing: RoutingTable, extra: TrustExtra | undefined): TrustPlace {
  let endpoint: RouteEndpoint | undefined = decision.endpoint ?? endpointOf(facts, []);
  if (endpoint === undefined && facts.clientRoute === 'local' && isLocalRouteHost(facts.host, routing.localHosts)) {
    endpoint = { class: 'org-plain', region: 'unstated', implicit: true, tlsPins: [] };
  }
  if (endpoint === undefined) return Object.freeze({ class: 'unknown', region: 'unstated' });
  const place: { -readonly [K in keyof TrustPlace]: TrustPlace[K] } = { class: endpoint.class, region: endpoint.region };
  const provider = endpoint.provider ?? extra?.provider;
  if (provider !== undefined) place.provider = provider;
  if (endpoint.class === 'forwarded' && extra?.forwardedTo !== undefined) place.forwardedTo = extra.forwardedTo;
  if (endpoint.id !== undefined) place.endpointId = endpoint.id;
  return Object.freeze(place);
}

/**
 * The TrustFacts of one decision (D-38): its place (or the client's), `not-checked` until the badge's check runs, what allowed it (the decision's records,
 * or the routing table's record of its label for a decision made without a policy), the label as decided, the use and the reports.
 */
export function trustFactsFor(decision: RouteDecision, facts: RouteFacts, context: TrustContext, extra?: TrustExtra): TrustFacts {
  const label = strictestLabelOf(context.mark, context.routing) ?? context.defaultLabel;
  const allowedBy: readonly AllowingRecord[] = decision.allowedBy
    ?? (decision.allowed && label !== undefined ? [Object.freeze({ kind: 'routing' as const, label: labelKey(label) })] : []);
  const trust: { -readonly [K in keyof TrustFacts]: TrustFacts[K] } = {
    place: placeFrom(decision, facts, context.routing, extra),
    verification: extra?.verification ?? 'not-checked',
    allowedBy: Object.freeze([...allowedBy]),
    wouldRefuse: Object.freeze([...(decision.wouldRefuse ?? [])])
  };
  if (label !== undefined) trust.label = label;
  const use = decision.useTier ?? facts.use;
  if (use !== undefined) trust.use = use;
  if (decision.passport !== undefined) trust.passportHash = decision.passport.hash;
  return Object.freeze(trust);
}

/** Every fixed word of the trust line (glossary rows Runs on, Verified and Allowed). */
export const TRUST_LINE_TEXT = Object.freeze({
  runsOn: 'Runs on',
  places: PLACE_TEXT.places,
  vault: PLACE_TEXT.vault,
  outsideProvider: PLACE_TEXT.outsideProvider,
  anOutsideProvider: PLACE_TEXT.anOutsideProvider,
  in: PLACE_TEXT.in,
  regions: PLACE_TEXT.regions,
  verified: Object.freeze({
    'verified-private': 'Verified',
    'model-verified': 'Model verified, connection not proven',
    'not-verified': 'Not verified',
    'not-checked': 'Not checked yet'
  } satisfies Record<TrustVerificationLevel, string>),
  allowedFor: 'Allowed for',
  allowedBy: 'Allowed by',
  allowedForChat: 'Allowed for chat you review by',
  by: 'by',
  authorization: 'authorization',
  until: 'until',
  approvedFor: 'Approved for',
  selfSigned: `(${SELF_SIGNED_TEXT})`,
  partSeparator: ' · ',
  recordSeparator: '; ',
  months: MONTHS
});

/** A `scale/level` key as people read it: the decided label's words (with its export markings) when it is that label, otherwise scale and level alone. */
function labelShownFor(key: string, decided: Label | undefined, scales: ScaleTable): string {
  if (decided !== undefined && labelKey(decided) === key) return labelKeyShownWithMarkings(decided, scales);
  const split = splitLabelKey(key);
  return split === undefined ? key : labelKeyShownWithMarkings({ ...split, compartments: [] }, scales);
}

function recordShown(record: AllowingRecord, decided: Label | undefined, scales: ScaleTable): string {
  switch (record.kind) {
    case 'routing':
      return `${TRUST_LINE_TEXT.allowedFor} ${labelShownFor(record.label, decided, scales)}`;
    case 'authorization': {
      // An exception always covers exactly one use, so it names it (74.1 P20, design 5.3): one string on every surface, and no self-signed form, because
      // a self-signed exception covers nothing (D-20).
      if (record.authorizationKind === 't1-risk') return `${TRUST_LINE_TEXT.allowedForChat} ${record.name} ${TRUST_LINE_TEXT.until} ${dateShown(record.expiresAt)}`;
      const opening = record.label === undefined
        ? TRUST_LINE_TEXT.allowedBy
        : `${TRUST_LINE_TEXT.allowedFor} ${labelShownFor(record.label, decided, scales)} ${TRUST_LINE_TEXT.by}`;
      const words = `${opening} ${record.name}'s ${TRUST_LINE_TEXT.authorization} ${record.id} ${TRUST_LINE_TEXT.until} ${dateShown(record.expiresAt)}`;
      return record.selfSigned ? `${words} ${TRUST_LINE_TEXT.selfSigned}` : words;
    }
    case 'model-approval':
      return `${TRUST_LINE_TEXT.approvedFor} ${USE_TIER_WORDS[record.maxTier]} ${TRUST_LINE_TEXT.until} ${dateShown(record.expiresAt)}`;
  }
}

export interface TrustLine {
  readonly runsOn: string;
  readonly verified: string;
  readonly allowed: string;
  /** The three parts joined by " · ", an empty part left out. */
  readonly text: string;
}

/**
 * The trust line of one TrustFacts record (D-38): "Runs on {place} · {verified} · {allowed}". Several allowing records are joined by "; "; a routing record
 * whose label an authorization also names is left out, because the authorization's words already say it. Labels are read through the label module's
 * labelKeyShownWithMarkings (scale name, display level, export markings), never as a raw key.
 */
export function trustLine(trust: TrustFacts, scales: ScaleTable): TrustLine {
  const runsOn = `${TRUST_LINE_TEXT.runsOn} ${placeShown(trust.place)}`;
  const verified = TRUST_LINE_TEXT.verified[trust.verification];
  const named = new Set(trust.allowedBy.flatMap((record) => (record.kind === 'authorization' && record.label !== undefined ? [record.label] : [])));
  const allowed = trust.allowedBy
    .filter((record) => !(record.kind === 'routing' && named.has(record.label)))
    .map((record) => recordShown(record, trust.label, scales))
    .join(TRUST_LINE_TEXT.recordSeparator);
  const text = [runsOn, verified, allowed].filter((part) => part !== '').join(TRUST_LINE_TEXT.partSeparator);
  return Object.freeze({ runsOn, verified, allowed, text });
}
