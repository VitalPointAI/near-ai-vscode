// The passport step of decideRoute (model provenance design 6.2 and 12.2, Phase 41 D-42, Phase 74.1 D-11 to D-13): whether the passport of a request's
// model covers its use at the place it would run, why not when it does not, and the records that allowed it when it does. Pure: no I/O, no clock, no
// vscode. Moved out of routing.ts, which only decides what the step's answer means: a refusal under `models.mode: enforce`, a report under `report`.
// Gap values are written into records, so a value here never changes meaning (74.1 D-11).
import { authorizationCovers } from './authorizations';
import type { EndpointClass } from './endpoints';
import { USE_TIERS, passportCovers, resolvePassport } from './models';
import type { ModelsSection, ResolvedPassport, UseTier } from './models';
import type { AllowingRecord, VerifiedAuthorization } from './routing';

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

const WHO_TO_ASK = 'Who to ask: your organization\'s security contact.';

/** One sentence per gap, in the refusal form: nothing was sent, what, why, what you can do, and who to ask. */
export const PASSPORT_GAP_TEXT: Readonly<Record<PassportGapId, string>> = Object.freeze({
  unknown: `Nothing was sent. Your organization has not approved this model. A model with no approval may be used only for research, in the research workspace. Choose a model your organization approved for this work, or ask for this one to be reviewed. ${WHO_TO_ASK}`,
  expired: `Nothing was sent. This model's approval has expired. An expired approval allows research only, in the research workspace. Choose a model with a current approval, or ask for this one to be approved again. ${WHO_TO_ASK}`,
  'tier-exceeded': `Nothing was sent. This model is not approved for this use. Its approval covers less than this request needs, for example chat you review but not agent work. Choose a model approved for this work, or ask for this model's approval to be reviewed. ${WHO_TO_ASK}`,
  'acceptance-missing': `Nothing was sent. This model is approved for research only, and chat you review needs a signed risk acceptance that covers this model, project and label. None does. Choose a model approved for this work, or ask for a risk acceptance under your organization's rules. ${WHO_TO_ASK}`,
  'acceptance-expired': `Nothing was sent. The risk acceptance that let this model serve chat you review has expired, so the model is research only again. Choose a model approved for this work, or ask for the acceptance to be renewed. ${WHO_TO_ASK}`,
  revoked: `Nothing was sent. Your organization has withdrawn this model's approval for every use, research included. Choose another model. ${WHO_TO_ASK}`,
  'hosting-mismatch': `Nothing was sent. This model is not approved to run where this request would go. Its approval names other places to run it. Choose a place its approval names, or another approved model. ${WHO_TO_ASK}`,
  'artifact-mismatch': `Nothing was sent. The model files at this place are not the ones your organization approved, and different files behind the same name need their own evaluation. Use the approved files, or ask for these to be evaluated. ${WHO_TO_ASK}`,
  licence: `Nothing was sent. This model's licence allows your organization's use for research only, outside the vendor's own service. Use it through the vendor's service, or choose another model. ${WHO_TO_ASK}`,
  'not-evaluated': `Nothing was sent. Your organization has not evaluated this model for this use, and under its rules a model takes any role above research only after that evaluation. Choose an evaluated model, or ask for this one to be evaluated. ${WHO_TO_ASK}`
});

/** The models section a policy with none runs: report mode with the shipped passports alone (provenance O1, 74.1 D-12). */
export const SHIPPED_REPORT_MODELS: ModelsSection = Object.freeze({ v: 1, mode: 'report', unknownMaxTier: 'T0' });

/** What one request asks of its model's passport. */
export interface PassportStepInput {
  readonly modelId: string;
  /** The use of the request (useTierFor), already raised by the policy's own tables. */
  readonly use: UseTier;
  /** The class of the place the request would run; a request with no place counts as a closed API, the widest class. */
  readonly endpointClass: EndpointClass;
  /** The `scale/level` keys a t1-risk authorization is asked about: one per label, or a single undefined for a mark with none. */
  readonly labelKeys: ReadonlyArray<string | undefined>;
  readonly project?: string;
  readonly authorizations: readonly VerifiedAuthorization[];
  readonly now: number;
}

/** What the passport step found: whether the passport covers the request, why not, the passport, and the records that allowed it when it covers. */
export interface PassportStepResult {
  readonly covers: boolean;
  readonly gap?: PassportGapId;
  readonly resolved?: ResolvedPassport;
  readonly records: readonly AllowingRecord[];
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
  const risks = input.authorizations.filter((candidate) => input.labelKeys.every((key) => authorizationCovers(candidate.body, {
    kind: 't1-risk', subject: { model: subject }, project: input.project, label: key, use: 't1'
  }, input.now)));
  const verdict = passportCovers({ resolved, use: input.use, endpointClass: input.endpointClass, t1RiskCovers: risks.length > 0, now: input.now });
  const found = resolved === undefined ? {} : { resolved };
  if (!verdict.covers) return { covers: false, gap: verdict.why, ...found, records: [] };
  if (resolved === undefined) return { covers: true, records: [] };
  const records: AllowingRecord[] = [Object.freeze({ kind: 'model-approval' as const, passport: resolved.passport.id, maxTier: resolved.maxTier, expiresAt: resolved.passport.expiresAt })];
  // A use above the passport's tier went only because a named person accepted the risk: that record allowed it too.
  if (USE_TIERS.indexOf(input.use) > USE_TIERS.indexOf(resolved.maxTier)) records.push(...risks.map((risk) => authorizationRecord(risk)));
  return { covers: true, resolved, records };
}
