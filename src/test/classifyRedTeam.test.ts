// The model-free red-team set (Phase 70.1 plan 04 Task 3; CLSF-02, research 3.6 and 3.8): for every case, assess never gives a label below its start on
// any field, every expected floor is covered by the result, and every expected exception is queued. Cases live in fixtures/classify/redteam/cases.json,
// unclassified and fictional. A label in a case is written `scale/level`, with `@REL,REL` for releasability and `+flag,flag` for handling.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { markAtLeast, sameMark } from '../domain/gate/dominance';
import { parseClassificationSection } from '../domain/gate/classificationSection';
import type { ClassificationSection } from '../domain/gate/classificationSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { assess } from '../domain/classify/assess';
import type { AssessInput } from '../domain/classify/assess';
import type { SessionFact } from '../domain/classify/facts';
import { parseProposalRecord } from '../domain/classify/record';

interface Case {
  readonly id: string;
  readonly description: string;
  readonly visible: string;
  readonly hidden?: string[];
  readonly start: string[];
  readonly facts?: { type: string; subject?: string }[];
  readonly session?: { type: string; subject?: string }[][];
  readonly judgement?: { proposal: string[]; probabilities: Record<string, number> };
  readonly section?: { systemHigh?: string[] };
  readonly expect: {
    readonly atLeast: string[];
    readonly exactly?: string[];
    readonly exceptions?: string[];
    readonly basisKinds?: string[];
    readonly noBasisKinds?: string[];
    readonly suggestionReasons?: string[];
  };
}

const FIXTURE = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'classify', 'redteam', 'cases.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { notice: string; cases: Case[] };
const H = 'a'.repeat(64);

/** `scale/level[@REL,REL][+flag,flag]`. */
function labelOf(spec: string): Label {
  const [main, flags] = spec.split('+') as [string, string | undefined];
  const [key, release] = main.split('@') as [string, string | undefined];
  const at = key.indexOf('/');
  return {
    scale: key.slice(0, at), level: key.slice(at + 1), compartments: [],
    releasability: release === undefined ? [] : release.split(',').sort(), handling: flags === undefined ? [] : flags.split(',').sort()
  };
}

function baseSection(systemHigh?: string[]): ClassificationSection {
  const secret = labelOf('ca-classified/Secret');
  const topSecret = labelOf('ca-classified/Top Secret');
  const pb = labelOf('ca-protected/Protected B');
  const rule = { id: 'scg-4.2', guideRef: 'SCG 4.2', label: labelOf('ca-classified/Confidential'), description: 'A unit with its location and a future move date', when: { allOf: ['future-date', 'location', 'unit'], sameSubject: true }, then: secret };
  const parsed = parseClassificationSection({
    v: 1,
    ...(systemHigh === undefined ? {} : { systemHigh: systemHigh.map(labelOf) }),
    thresholds: {
      'ca-protected/Protected A': { costRatio: 4, recallTarget: 9000, secondFamily: false },
      'ca-protected/Protected B': { costRatio: 9, recallTarget: 9500, secondFamily: false },
      'ca-classified/Confidential': { costRatio: 9, recallTarget: 9500, secondFamily: false },
      'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true }
    },
    markings: [
      { id: 'banner-protected-a-en', pattern: 'PROTECTED A', label: labelOf('ca-protected/Protected A') },
      { id: 'banner-protected-b-en', pattern: 'PROTECTED B', label: pb },
      { id: 'banner-protected-b-fr', pattern: 'PROTÉGÉ B', label: pb },
      { id: 'banner-secret', pattern: 'SECRET', label: secret },
      { id: 'banner-top-secret', pattern: 'TOP SECRET', label: topSecret },
      { id: 'banner-tres-secret-fr', pattern: 'TRÈS SECRET', label: topSecret },
      { id: 'portion-pb', pattern: 'PB', label: pb },
      { id: 'portion-s', pattern: 'S', label: secret }
    ],
    codeWords: { listLabel: secret, entries: [{ id: 'cw-1', token: 'NORTHERNEXAMPLE', label: secret }] },
    guideRules: [rule],
    compilationRules: [{ ...rule, id: 'comp-9.1', guideRef: 'SCG 9.1', description: 'A unit, a location and a future date, together' }]
  }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

const MODEL = {
  prompt: { templateHash: 'e'.repeat(64), decodingHash: 'f'.repeat(64) },
  rationale: { label: labelOf('ca-protected/Protected B'), text: 'A fictional rationale.' },
  agent: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
};

function runCase(entry: Case) {
  const section = baseSection(entry.section?.systemHigh);
  const common = { section, scales: SCALE_PRESETS, bundleHash: 'd'.repeat(64) };
  let session: readonly SessionFact[] = [];
  for (const [index, facts] of (entry.session ?? []).entries()) {
    const earlier = assess({ ...common, start: entry.start.map(labelOf), current: { item: `${entry.id}-earlier-${String(index)}`, contentHash: H, revision: 1 }, visible: '', facts, sessionFacts: session });
    assert.ok(earlier.ok);
    if (earlier.ok) session = earlier.sessionFacts;
  }
  const input: AssessInput = {
    ...common,
    start: entry.start.map(labelOf),
    current: { item: entry.id, contentHash: H, revision: 1 },
    visible: entry.visible,
    hidden: entry.hidden ?? [],
    facts: entry.facts ?? [],
    sessionFacts: session,
    ...(entry.judgement === undefined ? {} : {
      ...MODEL,
      judgement: {
        contentHash: H, proposal: entry.judgement.proposal.map(labelOf), probabilities: entry.judgement.probabilities, calibration: 'cal-redteam',
        sampleAgreement: 10000, facts: [], rationaleHash: 'c'.repeat(64),
        model: { servedModel: 'gpt-oss-20b', endpoint: 'example-org-classifier', passport: 'openai/gpt-oss', passportHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), endpointClass: 'local', useTier: 'T3' }
      }
    })
  };
  const result = assess(input);
  assert.ok(result.ok, `${entry.id}: ${result.ok ? '' : result.message}`);
  if (!result.ok) throw new Error('unreachable');
  return { input, result };
}

test('the fixture says it is unclassified test data, and holds at least 24 cases with unique ids', () => {
  assert.match(fixture.notice, /^Unclassified test data\. Fictional content only/);
  assert.ok(fixture.cases.length >= 24, String(fixture.cases.length));
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, fixture.cases.length);
});

for (const entry of fixture.cases) {
  test(`red team ${entry.id}: ${entry.description}`, () => {
    const { input, result } = runCase(entry);
    const applied = result.decision.applied;
    assert.ok(markAtLeast(applied, input.start, SCALE_PRESETS), `below start: ${JSON.stringify(applied)}`);
    assert.ok(markAtLeast(applied, entry.expect.atLeast.map(labelOf), SCALE_PRESETS), `expected floor not covered: ${JSON.stringify(applied)}`);
    if (entry.expect.exactly !== undefined) assert.ok(sameMark(applied, entry.expect.exactly.map(labelOf)), JSON.stringify(applied));
    for (const kind of entry.expect.exceptions ?? []) assert.ok(result.decision.exceptions.some((item) => item.kind === kind), `exception ${kind} not queued`);
    for (const kind of entry.expect.basisKinds ?? []) assert.ok(result.decision.bases.some((basis) => basis.kind === kind), `no ${kind} basis`);
    for (const kind of entry.expect.noBasisKinds ?? []) assert.ok(!result.decision.bases.some((basis) => basis.kind === kind), `unexpected ${kind} basis`);
    for (const reason of entry.expect.suggestionReasons ?? []) assert.ok(result.decision.suggestions.some((item) => item.reason === reason), `no ${reason} suggestion`);
    const record = parseProposalRecord(JSON.parse(JSON.stringify(result.record)), SCALE_PRESETS);
    assert.ok(record.ok, record.ok ? '' : record.message);
    assert.ok(!result.decision.bases.some((basis) => basis.ref.includes('NORTHERNEXAMPLE')), 'a code word never reaches a basis');
  });
}
