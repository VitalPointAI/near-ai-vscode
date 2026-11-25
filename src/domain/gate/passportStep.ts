// The passport step of decideRoute (model provenance design 6.2 and 12.2, Phase 41 D-42, Phase 74.1 D-11 to D-14): whether the passport of a request's
// model covers its use at the place it would run, why not when it does not, the words of that refusal, and the records that allowed it when it does.
// Pure: no I/O, no clock, no vscode. routing.ts decides what the step's answer means: a refusal under `models.mode: enforce`, a report under `report`.
// Gap values are written into records, so a value here never changes meaning (74.1 D-11).
import { authorizationCovers } from './authorizations';
import type { EndpointClass, EndpointRegion } from './endpoints';
import { USE_TIERS, passportCovers, resolvePassport } from './models';
import type { ModelsSection, ResolvedPassport, UseTier } from './models';
import type { AllowingRecord, VerifiedAuthorization } from './routing';
import { dateShown, placeShown } from './placeWords';
import { USE_TIER_WORDS } from './useTier';

/** Why a passport does not cover a request (74.1 D-11): each is the reason recorded beside the one rule `route.passport`. */
export const PASSPORT_GAPS = Object.freeze([
  'unknown',
  'expired',
  'tier-exceeded',
  'acceptance-missing',
  'acceptance-expired',
  'revoked',
  'hosting-mismatch',
  'artifact-mismatch',
  'licence',
  'not-evaluated'
] as const);
export type PassportGapId = (typeof PASSPORT_GAPS)[number];

/** What a gap's sentence says: the model, the uses, the dates, the places, the person who accepted the risk, and who to ask. */
export interface PassportGapDetails {
  /** The model id the request named. */
  readonly model: string;
  /** This request's use. */
  readonly use: UseTier;
  /** The use the model's approval covers now. */
  readonly approvedUse?: UseTier;
  /** When the approval ends (or ended). */
  readonly expiresAt?: string;
  readonly licence?: string;
  /** The ended risk acceptance: who signed it and when it ended. */
  readonly acceptance?: { readonly name: string; readonly expiresAt: string };
  /** The places the approval names, and the one this request would run on, in the Runs on words. */
  readonly approvedPlaces?: readonly string[];
  readonly place?: string;
  /** The models that would go instead (74.1 D-14): undefined when not worked out, empty when none would. */
  readonly alternatives?: readonly string[];
  /** The sentence that ends every refusal: "Who to ask: ...". */
  readonly whoToAsk: string;
}

const words = (use: UseTier | undefined): string => USE_TIER_WORDS[use ?? 'T0'];
const list = (items: readonly string[] | undefined): string => {
  const shown = [...(items ?? [])];
  if (shown.length <= 1) return shown[0] ?? 'no place';
  return `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1] as string}`;
};
/** The ways forward a refusal names before who to ask: the models that would go instead, or that none would here. */
function forward(details: PassportGapDetails): string {
  if (details.alternatives === undefined) return '';
  if (details.alternatives.length === 0) return ' No model approved for this work is available here; your organization\'s own server, a Cohere vault or the research workspace may be ways forward.';
  return ` Choose one of these models instead: ${details.alternatives.join(', ')}.`;
}
const end = (details: PassportGapDetails): string => `${forward(details)} ${details.whoToAsk}`;

/** One sentence per gap, in the refusal form: nothing was sent, what, why, what you can do, and who to ask (EXPERIENCE.md section 3). */
export const PASSPORT_GAP_TEXT: Readonly<Record<PassportGapId, (details: PassportGapDetails) => string>> = Object.freeze({
  unknown: (d: PassportGapDetails) => `Nothing was sent. ${d.model} has no approval from your organization. A model with no approval may be used only for research, in the research workspace. Choose a model approved for ${words(d.use)}, or ask for this one to be reviewed.${end(d)}`,
  expired: (d: PassportGapDetails) => `Nothing was sent. The approval of ${d.model} ended on ${dateShown(d.expiresAt ?? '')}. An approval that has ended allows research only, in the research workspace. Choose a model with a current approval, or ask for this one to be approved again.${end(d)}`,
  'tier-exceeded': (d: PassportGapDetails) => `Nothing was sent. ${d.model} is approved for ${words(d.approvedUse)}, and this request is ${words(d.use)}. Choose a model approved for ${words(d.use)}, or ask for this model's approval to be reviewed.${end(d)}`,
  'acceptance-missing': (d: PassportGapDetails) => `Nothing was sent. ${d.model} is approved for research only. Chat you review needs an exception that a named person in your organization signed for this model, project and label, and none covers this request. Choose a model approved for chat you review, or ask for an exception.${end(d)}`,
  'acceptance-expired': (d: PassportGapDetails) => `Nothing was sent. The exception by ${d.acceptance?.name ?? 'a named person'} that let ${d.model} serve chat you review ended on ${dateShown(d.acceptance?.expiresAt ?? '')}, so the model is research only again. Ask for the exception to be renewed, or choose a model approved for chat you review.${end(d)}`,
  revoked: (d: PassportGapDetails) => `Nothing was sent. Your organization has withdrawn the approval of ${d.model} for every use, research included. Choose another model.${end(d)}`,
  'hosting-mismatch': (d: PassportGapDetails) => `Nothing was sent. ${d.model} is approved to run on ${list(d.approvedPlaces)}, and this request would run on ${d.place ?? 'a place your rules do not name'}. Choose a place its approval names, or another approved model.${end(d)}`,
  'artifact-mismatch': (d: PassportGapDetails) => `Nothing was sent. The model files of ${d.model} at this place are not the ones your organization approved, and different files under the same name need their own evaluation. Use the approved files, or ask for these to be evaluated.${end(d)}`,
  licence: (d: PassportGapDetails) => `Nothing was sent. The licence of ${d.model} (${d.licence ?? 'its licence'}) allows research only outside the vendor's own service. Use it through the vendor's service, or choose another model.${end(d)}`,
  'not-evaluated': (d: PassportGapDetails) => `Nothing was sent. Your organization has not evaluated ${d.model} for ${words(d.use)}, and under its rules a model takes any role above research only after that evaluation. Choose an evaluated model, or ask for this one to be evaluated.${end(d)}`
});

/** The models section a policy with none runs: report mode with the shipped passports alone (provenance O1, 74.1 D-12). */
export const SHIPPED_REPORT_MODELS: ModelsSection = Object.freeze({ v: 1, mode: 'report', unknownMaxTier: 'T0' });

/**
 * The sentence that ends every passport refusal: your organization's security contact by name when its rules give one, its generic words under your
 * organization's layer without one, and this computer's words with no organization layer.
 */
export function whoToAsk(contact: { readonly name: string; readonly how: string } | undefined, organization: boolean): string {
  if (contact !== undefined) return `Who to ask: ${contact.name} (${contact.how}).`;
  return organization ? 'Who to ask: your organization\'s security contact.' : 'Who to ask: whoever set up the rules on this computer.';
}

/** Where a request would run, as the passport step reads it. */
export interface PassportPlace {
  readonly class: EndpointClass;
  readonly region: EndpointRegion;
  readonly provider?: string;
}

/** What one request asks of its model's passport. */
export interface PassportStepInput {
  readonly modelId: string;
  /** The use of the request (useTierFor), already raised by the policy's own tables. */
  readonly use: UseTier;
  /** The place the request would run; a request with no place counts as a closed API, the widest class. */
  readonly place?: PassportPlace;
  /** The `scale/level` keys a t1-risk authorization is asked about: one per label, or a single undefined for a mark with none. */
  readonly labelKeys: ReadonlyArray<string | undefined>;
  readonly project?: string;
  readonly authorizations: readonly VerifiedAuthorization[];
  /** The weights' hash the place reports, when it reports one. */
  readonly observedArtifact?: string;
  readonly whoToAsk: string;
  readonly now: number;
}

/** What the passport step found: whether the passport covers the request, why not and the sentence's details, and the records that allowed it. */
export interface PassportStepResult {
  readonly covers: boolean;
  readonly gap?: PassportGapId;
  readonly resolved?: ResolvedPassport;
  readonly records: readonly AllowingRecord[];
  /** The details of the refusal's sentence, when there is a gap. */
  readonly details?: PassportGapDetails;
}

/** The record of a named person's authorization that let a request go. */
export function authorizationRecord(found: VerifiedAuthorization, label?: string): AllowingRecord {
  const body = found.body;
  const base = { kind: 'authorization' as const, authorizationKind: body.kind, id: body.id, name: body.namedPerson.name, expiresAt: body.expiresAt, selfSigned: found.selfSigned };
  return Object.freeze(label === undefined ? base : { ...base, label });
}

/** The passport check of step 7. It decides nothing itself: decideRoute refuses on a gap under enforce and reports it under report. */
export function passportStep(models: ModelsSection, input: PassportStepInput): PassportStepResult {
  const resolved = resolvePassport(models, input.modelId, input.now);
  const subject = resolved?.passport.id ?? input.modelId;
  const question = (key: string | undefined) => ({ kind: 't1-risk' as const, subject: { model: subject }, project: input.project, label: key, use: 't1' });
  // D-20 (owner-confirmed): an exception counts only under your organization's layer, never one this device signed for itself.
  const candidates = input.authorizations.filter((candidate) => !candidate.selfSigned);
  const risks = candidates.filter((candidate) => input.labelKeys.every((key) => authorizationCovers(candidate.body, question(key), input.now)));
  // An acceptance that would cover this request had it not ended: the sentence names its person and its end.
  const ended = risks.length > 0 ? undefined : candidates.find((candidate) => {
    const endsAt = Date.parse(candidate.body.expiresAt);
    return endsAt <= input.now && input.labelKeys.every((key) => authorizationCovers(candidate.body, question(key), endsAt - 1));
  });
  const endpointClass = input.place?.class ?? 'closed-api';
  const verdict = passportCovers({
    resolved, use: input.use, endpointClass, t1RiskCovers: risks.length > 0, t1RiskExpired: ended !== undefined, now: input.now,
    ...(input.observedArtifact === undefined ? {} : { observedArtifact: input.observedArtifact })
  });
  const found = resolved === undefined ? {} : { resolved };
  if (!verdict.covers) {
    const passport = resolved?.passport;
    const details: PassportGapDetails = {
      model: input.modelId === '' ? 'This model' : input.modelId,
      use: input.use,
      ...(resolved === undefined ? {} : { approvedUse: resolved.maxTier }),
      ...(passport === undefined ? {} : { expiresAt: passport.expiresAt, licence: passport.licence.id, approvedPlaces: passport.hosting.map((place) => placeShown({ class: place, region: 'unstated' })) }),
      ...(ended === undefined ? {} : { acceptance: { name: ended.body.namedPerson.name, expiresAt: ended.body.expiresAt } }),
      place: placeShown(input.place === undefined ? { class: 'closed-api', region: 'unstated' } : { ...input.place }),
      whoToAsk: input.whoToAsk
    };
    return { covers: false, gap: verdict.why, ...found, records: [], details };
  }
  if (resolved === undefined) return { covers: true, records: [] };
  const records: AllowingRecord[] = [Object.freeze({ kind: 'model-approval' as const, passport: resolved.passport.id, maxTier: resolved.maxTier, expiresAt: resolved.passport.expiresAt })];
  // A use above the passport's tier went only because a named person accepted the risk: that record allowed it too.
  if (USE_TIERS.indexOf(input.use) > USE_TIERS.indexOf(resolved.maxTier)) records.push(...risks.map((risk) => authorizationRecord(risk)));
  return { covers: true, resolved, records };
}
