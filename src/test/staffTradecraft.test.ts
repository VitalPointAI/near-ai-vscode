// The J2 tradecraft lint fixtures (design 10, 4.4 part 1; ICD 203; WP-SHARED), and that SIGN-OFF is refused through the tool while it has a finding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { likelihoodTermsIn, lintTradecraft } from '../domain/staff/tradecraftLint';
import type { TradecraftInput, TradecraftRule } from '../domain/staff/tradecraftLint';
import { callTool, hashIn, J2_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';

const rules = (input: TradecraftInput): TradecraftRule[] => lintTradecraft(input).map((finding) => finding.rule);
const SOURCES = [
  { id: 'a', reliability: 'B', credibility: '2', origin: 'Wire service X', published: '2026-11-10' },
  { id: 'b', reliability: 'C', credibility: '3', origin: 'wire service x', accessed: '2026-11-11' },
  { id: 'c', reliability: 'B', credibility: 2, origin: 'Local radio', published: '2026-11-12' }
];

test('likelihood terms: the longest ICD 203 term wins, and "unlikely" is never read as "likely"', () => {
  assert.deepEqual(likelihoodTermsIn('It is very likely.'), ['very likely']);
  assert.deepEqual(likelihoodTermsIn('It is unlikely.'), ['unlikely']);
  assert.deepEqual(likelihoodTermsIn('It is almost certainly so.'), ['almost certainly']);
  assert.deepEqual(likelihoodTermsIn('It is improbable.'), ['improbable']);
});

test('a clean estimate has no finding', () => {
  const body = [
    '# Intelligence estimate', '', '## Situation', '', '- Two notional battalions hold the ridge [src:a].', '',
    '## Key judgements', '', '- The adversary will likely defend the river line.', '- We have moderate confidence in that judgement.', '',
    'MLCOA: defend the river line. MDCOA: counter-attack at night.'
  ].join('\n');
  assert.deepEqual(rules({ body, kind: 'estimate', sources: SOURCES }), []);
});

test('a key judgement must say how likely or how confident, with ICD 203 words only', () => {
  assert.deepEqual(rules({ body: '## Key judgements\n\n- The adversary will defend the river line.' }), ['judgement-unmarked']);
  assert.deepEqual(rules({ body: '## Key judgements\n\n- The adversary will possibly defend the river line.' }), ['non-standard-likelihood']);
  assert.deepEqual(rules({ body: 'We assess the adversary might attack.' }), ['non-standard-likelihood'], 'a "We assess" sentence is a judgement anywhere');
  assert.deepEqual(rules({ body: 'We assess the adversary is unlikely to attack.' }), []);
});

test('likelihood and confidence never share a sentence', () => {
  assert.deepEqual(rules({ body: 'We assess with high confidence that an attack is likely.' }), ['likelihood-and-confidence']);
  assert.deepEqual(rules({ body: 'We assess an attack is likely. We have high confidence in this.' }), []);
});

test('every fact is sourced from the register, and the register must know the source', () => {
  assert.deepEqual(rules({ body: '## Situation\n\n- Two battalions hold the ridge.' }), ['fact-unsourced']);
  assert.deepEqual(rules({ body: '## Significant activity\n\n- Shelling at dawn [src:z].', sources: SOURCES }), ['unknown-source']);
});

test('sources: separate grades A to F and 1 to 6, an origin and a date', () => {
  assert.deepEqual(rules({ body: '', sources: [{ id: 'x', reliability: 'B2', origin: 'o', published: '2026' }] }), ['source-grades']);
  assert.deepEqual(rules({ body: '', sources: [{ id: 'x', reliability: 'G', credibility: '7', origin: 'o', published: '2026' }] }), ['source-grades']);
  assert.deepEqual(rules({ body: '', sources: [{ id: 'x', reliability: 'A', credibility: '1' }] }), ['source-origin', 'source-dates']);
});

test('two reports with the same origin never count as independent confirmation', () => {
  assert.deepEqual(rules({ body: 'The move is confirmed by [src:a] and [src:b].', sources: SOURCES }), ['same-origin-confirmation']);
  assert.deepEqual(rules({ body: 'The move is confirmed by [src:a] and [src:c].', sources: SOURCES }), []);
});

test('every PIR has a decision point and a latest time of value; every HVT is in an adversary COA; MLCOA and MDCOA are named', () => {
  assert.deepEqual(rules({ body: '', pirs: [{ id: 'PIR1', type: 'pir', requirement: 'r', status: 'active' }] }), ['pir-decision-point', 'pir-ltiov']);
  assert.deepEqual(rules({ body: '', pirs: [{ id: 'IR1', type: 'ir', requirement: 'r', status: 'active' }] }), [], 'an IR need not have one');
  assert.deepEqual(rules({ body: '', hvts: ['Bridging company', 'Air defence battery'], adversaryCoas: ['COA 1 uses the bridging company.'] }), ['hvt-not-in-coa']);
  assert.deepEqual(rules({ body: 'The most likely course of action is defence.', kind: 'adversary-coa-set' }), ['mlcoa-mdcoa']);
});

test('through the tools: SIGN-OFF is refused while the lint has findings, and the lint gives the hash it checked', async () => {
  const world = await staffWorld();
  await writeBody(world.root, 'j2', 'intelligence-estimate', '# Estimate\n\n## Key judgements\n\n- The adversary will possibly attack.\n');
  const proposed = await callTool(world, J2_TEAM, 'mcp__staff-products__propose', { product: 'intelligence-estimate', kind: 'estimate' }, 'j2-chief');
  const hash = hashIn(proposed.text);
  const lint = await callTool(world, J2_TEAM, 'mcp__staff-products__lint', { product: 'intelligence-estimate' }, 'tradecraft-reviewer');
  assert.match(lint.text, /non-standard-likelihood/);
  assert.match(lint.text, /mlcoa-mdcoa/);
  assert.equal(hashIn(lint.text), hash);
  const signOff = await callTool(world, J2_TEAM, 'mcp__staff-products__verdict', { product: 'intelligence-estimate', gate: 'tradecraft', verdict: 'SIGN-OFF', hash }, 'tradecraft-reviewer');
  assert.equal(signOff.ok, false);
  assert.match(signOff.text, /SIGN-OFF is refused/);
  const notReady = await callTool(world, J2_TEAM, 'mcp__staff-products__verdict', { product: 'intelligence-estimate', gate: 'tradecraft', verdict: 'NOT READY', hash, reasons: ['Use an ICD 203 term.', 'Name the MLCOA and MDCOA.'] }, 'tradecraft-reviewer');
  assert.ok(notReady.ok, notReady.text);
  assert.equal((await world.host.snapshot()).registry[0].display, 'draft (held)');
});
