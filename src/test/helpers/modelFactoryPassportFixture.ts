import { createHash } from 'node:crypto';
import type { Mark } from '../../domain/gate/dominance';
import { parseLabel, SCALE_PRESETS, type ScaleTable } from '../../domain/gate/labels';
import { parseModelsSection, passportHash, type Passport } from '../../domain/gate/models';
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
