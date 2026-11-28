import { createHash } from 'node:crypto';
import { markDominated, type Mark } from '../../domain/gate/dominance';
import type { EndpointClass } from '../../domain/gate/endpoints';
import { parseLabel, SCALE_PRESETS, type Clearance, type ScaleTable } from '../../domain/gate/labels';
import { parseModelsSection, passportCovers, passportHash, resolvePassport, type Passport, type UseTier } from '../../domain/gate/models';
import { verifyPolicyLayer } from '../../domain/gate/policyDocument';
import { parseIsoMillis } from '../../domain/gate/shape';
import { canonicalBytes, verifySignature } from '../../domain/team/canonical';
import type { PayloadSignerRef } from '../../domain/team/signedPayload';

export interface VersionTuple {
  base: string;
  adapter: string;
  quantization: string;
  servedWeights: string;
  mark: Mark;
}

export interface EvaluationReport {
  model: string;
  version: VersionTuple;
  incumbent: string;
  workload: string;
  holdout: string;
  rubric: string;
  candidateScore: number;
  incumbentScore: number;
  evaluatedAt: string;
  expiresAt: string;
}

export interface SignedFixture<T> {
  payload: T;
  signer: PayloadSignerRef;
  signature: string;
}

export interface EvaluationCandidate {
  model: string;
  version: VersionTuple;
  passport: Passport;
  report: SignedFixture<EvaluationReport>;
}

export interface EvaluationExpectation {
  report: EvaluationReport;
  reportSha256: string;
  passportSha256: string;
  evaluator: PayloadSignerRef;
  evaluatorActive: boolean;
  now: number;
}

export interface CandidateRecord {
  state: 'inactive' | 'shadow' | 'canary';
  model: string;
  version: VersionTuple;
  reportSha256: string;
  passportSha256: string;
  visibleResult?: 'incumbent';
}

const evaluationPurpose = 'fictional-model-evaluation.v1';
const maximumEvidenceBytes = 16 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sameBytes = (left: unknown, right: unknown) => canonicalBytes(left).equals(canonicalBytes(right));
const current = (from: string, until: string, now: number) => parseIsoMillis(from) <= now && now < parseIsoMillis(until);

function authentic<T>(purpose: string, evidence: SignedFixture<T>, expected: PayloadSignerRef): boolean {
  if (evidence.signer.fingerprint !== expected.fingerprint || evidence.signer.publicKey !== expected.publicKey) return false;
  const bytes = canonicalBytes({ purpose, payload: evidence.payload });
  return bytes.length <= maximumEvidenceBytes && verifySignature(bytes, evidence.signature, expected.publicKey);
}

function controlledMark(mark: Mark, scales: ScaleTable): boolean {
  return Array.isArray(mark) && mark.length > 0 && mark.length <= 8 && mark.every((label) => {
    const parsed = parseLabel(label, scales);
    return parsed.ok && sameBytes(parsed.value, label);
  });
}

function checkedEvaluation(candidate: EvaluationCandidate, expected: EvaluationExpectation): boolean {
  if (!expected.evaluatorActive || !authentic(evaluationPurpose, candidate.report, expected.evaluator)) return false;
  const report = candidate.report.payload;
  const version = candidate.version;
  if (!controlledMark(version.mark, SCALE_PRESETS) || !controlledMark(report.version.mark, SCALE_PRESETS) ||
      !sameBytes(report, expected.report) || !sameBytes(version, report.version) || report.model !== candidate.model ||
      !current(report.evaluatedAt, report.expiresAt, expected.now)) return false;
  if (![version.base, version.adapter, version.servedWeights, report.incumbent, report.workload, report.holdout, report.rubric]
      .every((digest) => typeof digest === 'string' && digestPattern.test(digest))) return false;

  const digest = sha256(canonicalBytes(report));
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [candidate.passport] }, SCALE_PRESETS);
  if (!parsed.ok) return false;
  const passport = parsed.value.passports?.[0];
  return passport !== undefined && passport.match.length === 1 && passport.match[0] === candidate.model &&
    passport.artifact?.sha256 === version.servedWeights && passport.artifact.quantization === version.quantization &&
    passport.evaluation?.sha256 === digest && passport.evaluation.at === report.evaluatedAt && digest === expected.reportSha256 &&
    sameBytes(passport, candidate.passport) && passportHash(passport) === expected.passportSha256;
}

export function acceptEvaluatedCandidate(
  candidate: EvaluationCandidate,
  expected: EvaluationExpectation,
  record: (candidate: CandidateRecord) => void,
): boolean {
  let evaluated: CandidateRecord;
  try {
    if (!checkedEvaluation(candidate, expected)) return false;
    evaluated = {
      state: 'inactive', model: candidate.model, version: structuredClone(candidate.version),
      reportSha256: expected.reportSha256, passportSha256: expected.passportSha256,
    };
  } catch {
    return false;
  }
  record(evaluated);
  return true;
}

export type Stage = 'shadow' | 'canary';

export interface StageSelection {
  decision: 'select' | 'decline';
  predecessor: 'inactive' | 'shadow';
  stage: Stage;
  model: string;
  version: VersionTuple;
  reportSha256: string;
  passportSha256: string;
  role: string;
  use: UseTier;
  endpointClass: EndpointClass;
  issuedAt: string;
  expiresAt: string;
}

export interface StageAdoption {
  layerSha256: string;
  selectionSha256: string;
  issuedAt: string;
  expiresAt: string;
}

export interface StageRequest {
  selection: SignedFixture<StageSelection>;
  policy: unknown;
  adoption?: SignedFixture<StageAdoption>;
}

export interface StageAuthority {
  now: number;
  record: CandidateRecord;
  candidate: EvaluationCandidate;
  evaluation: EvaluationExpectation;
  layerSha256: string;
  issuer: PayloadSignerRef;
  issuerActive: boolean;
  approvals: Record<Stage, { key: PayloadSignerRef; active: boolean }>;
  clearance: readonly Clearance[];
  role: string;
  use: UseTier;
  endpointClass: EndpointClass;
}

const selectionPurpose = 'fictional-model-stage-selection.v1';
const adoptionPurpose = 'fictional-model-stage-adoption.v1';

function checkStage(request: StageRequest, authority: StageAuthority): CandidateRecord | 'held' | 'declined' {
  const { now, record, candidate, evaluation, issuer, issuerActive, role, use, endpointClass } = authority;
  if (!checkedEvaluation(candidate, { ...evaluation, now }) ||
      record.model !== candidate.model || !sameBytes(record.version, candidate.version) ||
      record.reportSha256 !== evaluation.reportSha256 || record.passportSha256 !== evaluation.passportSha256) return 'held';

  const predecessor = record.state;
  if (predecessor !== 'inactive' && predecessor !== 'shadow') return 'held';
  const stage = predecessor === 'inactive' ? 'shadow' : 'canary';
  const approver = authority.approvals[stage];
  const selection = request.selection.payload;
  const { decision, issuedAt, expiresAt } = selection;
  const exactSelection: StageSelection = {
    decision, predecessor, stage, model: record.model, version: record.version,
    reportSha256: record.reportSha256, passportSha256: record.passportSha256,
    role, use, endpointClass, issuedAt, expiresAt,
  };
  if ((decision !== 'select' && decision !== 'decline') || !approver.active ||
      !authentic(selectionPurpose, request.selection, approver.key) ||
      !current(issuedAt, expiresAt, now) ||
      !controlledMark(selection.version.mark, SCALE_PRESETS) || !sameBytes(selection, exactSelection)) return 'held';
  if (decision === 'decline') return 'declined';

  const policy = verifyPolicyLayer(request.policy, {
    purpose: 'org-policy-layer', now,
    status: (key) => issuerActive && issuer.fingerprint === key.fingerprint && issuer.publicKey === key.publicKey
      ? { state: 'active' } : { state: 'unknown' },
  });
  if (policy.state !== 'valid' || policy.wireVersion !== 2 ||
      policy.hash !== authority.layerSha256 || policy.document.models?.mode !== 'enforce' ||
      !current(policy.document.issuedAt, policy.document.expiresAt, now)) return 'held';

  const adoption = request.adoption;
  if (!adoption || !authentic(adoptionPurpose, adoption, issuer) || !current(adoption.payload.issuedAt, adoption.payload.expiresAt, now) ||
      !sameBytes(adoption.payload, {
        layerSha256: policy.hash,
        selectionSha256: sha256(canonicalBytes(request.selection)),
        issuedAt: adoption.payload.issuedAt,
        expiresAt: adoption.payload.expiresAt,
      })) return 'held';

  const resolved = resolvePassport(policy.document.models, record.model, now);
  if (!resolved || resolved.source !== 'policy' || resolved.hash !== record.passportSha256 ||
      !current(resolved.passport.issuedAt, resolved.passport.expiresAt, now) ||
      !passportCovers({ resolved, use, endpointClass, t1RiskCovers: false, now }).covers) return 'held';
  const { scales, mappings } = policy.document.labels;
  if (!controlledMark(record.version.mark, scales) ||
      !markDominated(authority.clearance, record.version.mark, { scales, mappings, now })) return 'held';

  return stage === 'shadow'
    ? { ...record, version: structuredClone(record.version), state: stage, visibleResult: 'incumbent' }
    : { ...record, version: structuredClone(record.version), state: stage };
}

export function recordStage(
  request: StageRequest,
  readAuthority: () => StageAuthority,
  record: (candidate: CandidateRecord) => void,
): 'recorded' | 'declined' | 'held' {
  let final: CandidateRecord;
  try {
    const evaluated = checkStage(request, readAuthority());
    if (typeof evaluated === 'string') return evaluated;
    const current = checkStage(request, readAuthority());
    if (typeof current === 'string' || !sameBytes(current, evaluated)) return 'held';
    final = current;
  } catch {
    return 'held';
  }
  record(final);
  return 'recorded';
}
