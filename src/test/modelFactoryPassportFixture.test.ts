import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gradePlan } from '../benchmark/graders';
import { passportHash, type Passport } from '../domain/gate/models';
import { canonicalBytes } from '../domain/team/canonical';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { acceptEvaluatedCandidate, type CandidateRecord, type EvaluationCandidate, type EvaluationExpectation, type EvaluationReport, type SignedFixture } from './helpers/modelFactoryPassportFixture';
import { deviceKey } from './helpers/policyFixtures';

const clock = Date.parse('2026-11-27T12:00:00.000Z');
const iso = (now: number) => new Date(now).toISOString();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (value: unknown) => sha256(canonicalBytes(value));
const inventedDigest = (name: string) => sha256(Buffer.from(`fictional-model-factory/${name}`));

const workload = '# Plan\n1. R1: verify Add.\n2. R2: verify List.\n3. R3: verify Search.\n4. R4: verify Delete.\n5. R5: verify Restore. Run node --test.';

function signed<T>(purpose: string, payload: T, key: PayloadSigner): SignedFixture<T> {
  const signer = { fingerprint: key.fingerprint, publicKey: key.publicKey };
  return { payload, signer, signature: key.sign(canonicalBytes({ purpose, payload })) };
}

function reportFixture(now = clock) {
  const evaluator = deviceKey('fictional-evaluator');
  const model = 'fixture-only/Archive-Assistant-v1';
  const evaluatedAt = iso(now - 1000);
  const report: EvaluationReport = {
    model,
    version: {
      base: inventedDigest('base'), adapter: inventedDigest('adapter'), quantization: 'Q4_K_M',
      servedWeights: inventedDigest('served-weights'),
      mark: [{ scale: 'ca-classified', level: 'Secret', compartments: ['ALPHA'], releasability: ['CAN'], handling: ['local-only'] }],
    },
    incumbent: inventedDigest('incumbent'), workload: inventedDigest('workload'), holdout: inventedDigest('holdout'), rubric: inventedDigest('rubric'),
    candidateScore: gradePlan(workload).score, incumbentScore: gradePlan('An incomplete fictional answer.').score,
    evaluatedAt, expiresAt: iso(now + 60_000),
  };
  const reportSha256 = digestOf(report);
  const passport: Passport = {
    id: 'fixture-only/archive-assistant', match: [model], developer: 'Fictional Lab', origin: 'CA',
    lineage: { family: 'fictional-family', base: 'fictional-base', teachers: [], method: 'pretrain+sft' },
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] },
    hosting: ['local'],
    artifact: { format: 'gguf', remoteCode: false, quantization: report.version.quantization, sha256: report.version.servedWeights },
    evaluation: { report: 'fixture-evaluation-1', sha256: reportSha256, at: evaluatedAt },
    maxTier: 'T2', issuedAt: iso(now - 1000), expiresAt: iso(now + 60_000), reevaluateOn: ['artifact-change', 'fine-tune'],
  };
  const candidate: EvaluationCandidate = {
    model, version: structuredClone(report.version), passport,
    report: signed('fictional-model-evaluation.v1', structuredClone(report), evaluator),
  };
  const expected: EvaluationExpectation = {
    report: structuredClone(report), reportSha256, passportSha256: passportHash(passport),
    evaluator: { fingerprint: evaluator.fingerprint, publicKey: evaluator.publicKey }, evaluatorActive: true, now,
  };
  return { candidate, expected, evaluator };
}

test('the exact evaluated version records one inactive candidate', () => {
  const { candidate, expected } = reportFixture();
  const records: CandidateRecord[] = [];
  const record = (value: CandidateRecord) => records.push(value);
  assert.equal(expected.report.candidateScore, 10);
  assert.equal(expected.report.incumbentScore, 2);
  assert.equal(acceptEvaluatedCandidate(candidate, expected, record), true);
  assert.deepEqual(records, [{
    state: 'inactive', model: candidate.model, version: candidate.version,
    reportSha256: expected.reportSha256, passportSha256: expected.passportSha256,
  }]);
});

test('report, passport and independent artifact or mark substitutions create no inactive record', () => {
  const { candidate, expected, evaluator } = reportFixture();
  const mark = candidate.version.mark[0]!;
  const alternateReports = [
    { ...candidate.report.payload, model: 'fixture-only/another-v1' },
    { ...candidate.report.payload, incumbent: inventedDigest('other-incumbent') },
    { ...candidate.report.payload, holdout: inventedDigest('other-holdout') },
  ];
  const failures: [string, EvaluationCandidate, EvaluationExpectation][] = [
    ['changed report bytes', { ...candidate, report: { ...candidate.report, payload: alternateReports[0]! } }, expected],
    ...alternateReports.map((report): [string, EvaluationCandidate, EvaluationExpectation] =>
      ['different valid signed report', { ...candidate, report: signed('fictional-model-evaluation.v1', report, evaluator) }, expected]),
    ['untrusted evaluator', { ...candidate, report: signed('fictional-model-evaluation.v1', candidate.report.payload, deviceKey('other-evaluator')) }, expected],
    ['revoked evaluator', candidate, { ...expected, evaluatorActive: false }],
    ['expired evaluation', candidate, { ...expected, now: Date.parse(expected.report.expiresAt) }],
    ['changed passport', { ...candidate, passport: { ...candidate.passport, developer: 'Another Fictional Lab' } }, expected],
    ['base', { ...candidate, version: { ...candidate.version, base: inventedDigest('other-base') } }, expected],
    ['adapter', { ...candidate, version: { ...candidate.version, adapter: inventedDigest('other-adapter') } }, expected],
    ['quantization', { ...candidate, version: { ...candidate.version, quantization: 'Q8_0' } }, expected],
    ['served digest', { ...candidate, version: { ...candidate.version, servedWeights: inventedDigest('other-weights') } }, expected],
    ['missing mark', { ...candidate, version: { ...candidate.version, mark: [] } }, expected],
    ['handling only', { ...candidate, version: { ...candidate.version, mark: [{ ...mark, handling: ['no-agent-tools'] }] } }, expected],
    ['compartment only', { ...candidate, version: { ...candidate.version, mark: [{ ...mark, compartments: ['BRAVO'] }] } }, expected],
  ];
  for (const [label, proposed, authority] of failures) {
    const records: CandidateRecord[] = [];
    assert.equal(acceptEvaluatedCandidate(proposed, authority, (row) => records.push(row)), false, label);
    assert.equal(records.length, 0, label);
  }
});
