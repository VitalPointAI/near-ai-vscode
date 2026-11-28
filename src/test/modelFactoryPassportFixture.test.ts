import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gradePlan } from '../benchmark/graders';
import { bundleHash } from '../domain/gate/bundle';
import { passportCovers, passportHash, resolvePassport, type Passport } from '../domain/gate/models';
import { canonicalBytes } from '../domain/team/canonical';
import type { PayloadSigner } from '../domain/team/signedPayload';
import {
  acceptEvaluatedCandidate, recordStage, type CandidateRecord, type EvaluationCandidate, type EvaluationExpectation,
  type EvaluationReport, type SignedFixture, type Stage, type StageAuthority, type StageRequest, type StageSelection,
} from './helpers/modelFactoryPassportFixture';
import { deviceKey, issuerKey, policyDocumentFor, signOrganizationLayer } from './helpers/policyFixtures';

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

function reportFixture(now = clock, passportTimes: Partial<Pick<Passport, 'issuedAt' | 'expiresAt'>> = {}) {
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
    ...passportTimes,
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

function stageFixture(passportTimes: Partial<Pick<Passport, 'issuedAt' | 'expiresAt'>> = {}) {
  const { candidate, expected } = reportFixture(clock, passportTimes);
  const issuer = issuerKey('fictional-installed-layer');
  const keys = { shadow: deviceKey('fictional-shadow-reviewer'), canary: deviceKey('fictional-canary-reviewer') };
  const effects: CandidateRecord[] = [];
  assert.equal(acceptEvaluatedCandidate(candidate, expected, (row) => effects.push(row)), true, 'the stage fixture needs a valid inactive record');
  const inactive = effects.pop()!;

  function layer(options: { mode?: 'report' | 'enforce'; passports?: Passport[]; at?: number; key?: PayloadSigner } = {}) {
    const key = options.key ?? issuer;
    const base = policyDocumentFor({ key, layer: 'organization', now: options.at ?? clock - 10_000 });
    const document = {
      ...base, requires: [...new Set([...base.requires, 'models@1'])].sort(),
      models: { v: 1 as const, mode: options.mode ?? 'enforce', unknownMaxTier: 'T0' as const, passports: options.passports ?? [candidate.passport] },
    };
    return { envelope: signOrganizationLayer(document, key), hash: bundleHash(document), models: document.models };
  }
  const installed = layer();
  const authority: StageAuthority = {
    now: clock, record: inactive, candidate, evaluation: expected, layerSha256: installed.hash, issuer, issuerActive: true,
    approvals: { shadow: { key: keys.shadow, active: true }, canary: { key: keys.canary, active: true } },
    clearance: [{ scale: 'ca-classified', level: 'Secret', compartments: ['ALPHA'], releasability: ['CAN'] }],
    role: 'fixture-archive-review', use: 'T0', endpointClass: 'local',
  };

  function select(stage: Stage, change: Partial<StageSelection> = {}, key = keys[stage]) {
    return signed('fictional-model-stage-selection.v1', {
      decision: 'select', predecessor: stage === 'shadow' ? 'inactive' : 'shadow', stage, model: inactive.model,
      version: structuredClone(inactive.version), reportSha256: inactive.reportSha256, passportSha256: inactive.passportSha256,
      role: authority.role, use: authority.use, endpointClass: authority.endpointClass,
      issuedAt: iso(clock - 1_000), expiresAt: iso(clock + 10_000), ...change,
    } satisfies StageSelection, key);
  }

  function adopted(
    selection: SignedFixture<StageSelection>, policy = installed,
    change: Partial<{ layerSha256: string; selectionSha256: string; issuedAt: string; expiresAt: string }> = {}
  ): StageRequest {
    const adoption = signed('fictional-model-stage-adoption.v1', {
      layerSha256: policy.hash, selectionSha256: digestOf(selection), issuedAt: iso(clock - 500), expiresAt: iso(clock + 5_000),
      ...change,
    }, issuer);
    return { selection, policy: policy.envelope, adoption };
  }

  return { authority, effects, layer, installed, select, adopted };
}

test('two separate human selections and their own verified adoption record shadow then canary eligibility', () => {
  const { authority, effects, select, adopted, installed } = stageFixture();
  const record = (row: CandidateRecord) => effects.push(row);
  const shadow = select('shadow');
  assert.equal(recordStage({ selection: shadow, policy: installed.envelope }, () => authority, record), 'held');
  assert.equal(effects.length, 0);
  const shadowRequest = adopted(shadow);
  assert.equal(recordStage(shadowRequest, () => authority, record), 'recorded');
  const first = effects[0]!;
  assert.equal(first.state, 'shadow');
  assert.equal(first.visibleResult, 'incumbent');
  const afterShadow = { ...authority, record: first };
  assert.equal(recordStage(shadowRequest, () => afterShadow, record), 'held');
  const canary = select('canary');
  assert.equal(recordStage({ ...adopted(canary), adoption: shadowRequest.adoption }, () => afterShadow, record), 'held');
  assert.equal(recordStage(adopted(canary), () => afterShadow, record), 'recorded');
  assert.deepEqual(effects.map(({ state }) => state), ['shadow', 'canary']);
});

test('signed decline and detached, substituted or stale approval evidence have no stage effects', () => {
  const { authority, effects, layer, select, adopted } = stageFixture();
  const record = (row: CandidateRecord) => effects.push(row);
  const shadow = select('shadow');
  const otherHandling = [{ ...authority.record.version.mark[0]!, handling: ['no-agent-tools'] }];
  const reportOnly = layer({ mode: 'report' });
  const laterLayer = layer({ at: clock + 1 });
  const otherIssuer = layer({ key: issuerKey('other-fictional-issuer') });
  const noPassport = layer({ passports: [] });
  const cases: [string, StageRequest, StageAuthority][] = [
    ['skip shadow', adopted(select('canary')), authority],
    ['unapproved signer', adopted(select('shadow', {}, deviceKey('other-officer'))), authority],
    ['revoked selection', adopted(shadow), { ...authority, approvals: { ...authority.approvals, shadow: { ...authority.approvals.shadow, active: false } } }],
    ['missing mark', adopted(select('shadow', { version: { ...authority.record.version, mark: [] } })), authority],
    ['handling substituted', adopted(select('shadow', { version: { ...authority.record.version, mark: otherHandling } })), authority],
    ['passport digest mismatch', adopted(select('shadow', { passportSha256: inventedDigest('other-passport') })), authority],
    ['changed served digest', adopted(select('shadow', { version: { ...authority.record.version, servedWeights: inventedDigest('other-weights') } })), authority],
    ['selection expiry', adopted(select('shadow', { expiresAt: iso(clock) })), authority],
    ['wrong adoption hash', adopted(shadow, undefined, { selectionSha256: inventedDigest('other-selection') }), authority],
    ['expired adoption', adopted(shadow, undefined, { expiresAt: iso(clock) }), authority],
    ['wrong installed hash', adopted(shadow), { ...authority, layerSha256: inventedDigest('other-layer') }],
    ['report mode', adopted(shadow, reportOnly), { ...authority, layerSha256: reportOnly.hash }],
    ['future layer', adopted(shadow, laterLayer), { ...authority, layerSha256: laterLayer.hash }],
    ['wrong policy issuer', adopted(shadow, otherIssuer), { ...authority, layerSha256: otherIssuer.hash }],
    ['no matching policy passport', adopted(shadow, noPassport), { ...authority, layerSha256: noPassport.hash }],
    ['no clearance', adopted(shadow), { ...authority, clearance: [] }],
  ];
  for (const [name, request, currentAuthority] of cases) assert.equal(recordStage(request, () => currentAuthority, record), 'held', name);
  assert.equal(recordStage(adopted(select('shadow', { decision: 'decline' })), () => authority, record), 'declined');
  assert.deepEqual(effects, []);
});

test('the exact policy passport must be current even when general passport coverage allows T0', () => {
  for (const dates of [{ issuedAt: iso(clock + 1) }, { expiresAt: iso(clock) }]) {
    const { authority, effects, installed, select, adopted } = stageFixture(dates);
    const resolved = resolvePassport(installed.models, authority.record.model, clock);
    assert.ok(resolved);
    assert.deepEqual(passportCovers({ resolved, use: 'T0', endpointClass: 'local', now: clock, t1RiskCovers: false }), { covers: true });
    assert.equal(recordStage(adopted(select('shadow')), () => authority, (row) => effects.push(row)), 'held');
    assert.deepEqual(effects, []);
  }
});

test('losing current authority immediately before the recorder leaves the version inactive', () => {
  const { authority, effects, select, adopted } = stageFixture();
  let reads = 0;
  const readAuthority = () => ++reads === 1 ? authority : { ...authority, issuerActive: false };
  assert.equal(recordStage(adopted(select('shadow')), readAuthority, (row) => effects.push(row)), 'held');
  assert.equal(reads, 2);
  assert.deepEqual(effects, []);
});
