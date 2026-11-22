import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_ROUTING, decideRoute, type RouteFacts } from '../domain/gate/routing';
import { trustFactsFor, trustLine, type TrustContext } from '../domain/gate/trust';
import { USE_TIER_WORDS } from '../domain/gate/useTier';
import { CARD_LINE_KEYS, cardFor, choiceNeedsReason, NO_APPROVAL_TEXT, RULED_OUT_WORDS_TEXT, type CardInput } from '../domain/setup/cards';
import { OPTION_KINDS } from '../domain/setup/ids';
import { initialViability } from '../domain/setup/viability';
import { countHits } from './helpers/copyLintScan';
import { FIXED_NOW } from './helpers/policyFixtures';

const facts: RouteFacts = {
  clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true,
  model: { id: 'example-model', privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW,
  binding: { state: 'bound', host: 'https://cloud-api.near.ai/v1', checkedAt: FIXED_NOW }
};
const context: TrustContext = {
  mark: [{ scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] }],
  routing: DEFAULT_ROUTING
};
const decision = decideRoute(context.mark, context.routing, facts);
const input: CardInput = {
  facts, context, scales: SCALE_PRESETS,
  outcome: { optionId: 'near-private:example', kind: 'near-private', outcome: 'recommended', decision },
  viability: { ...initialViability('near-private:example', 'near-private', 'desktop'), state: 'viable' }
};

test('D-12: the last line is the trust line', () => {
  assert.equal(decision.allowed, true);
  const card = cardFor(input);
  assert.equal(card.trustLine, trustLine(trustFactsFor(decision, facts, context, { verification: 'not-checked' }), SCALE_PRESETS).text);
  const checked = cardFor({ ...input, verification: 'verified-private' });
  assert.equal(checked.trustLine, trustLine(trustFactsFor(decision, facts, context, { verification: 'verified-private' }), SCALE_PRESETS).text);
  assert.doesNotMatch(card.trustLine ?? '', /org\/Internal/);
});

test('ruled-out card', () => {
  const refusal = 'Nothing was sent. Ask your administrator about this option.';
  const card = cardFor({ ...input, outcome: { ...input.outcome, outcome: 'ruled-out', refusal } });
  assert.deepEqual([card.reason, card.trustLine, card.describedById, card.outcomeText],
    [refusal, undefined, 'reason-near-private-example', RULED_OUT_WORDS_TEXT]);
});

test('not-available card', () => {
  const fix = { action: 'install', label: 'Install a local server' } as const;
  const sentence = 'No local AI server was found.';
  const card = cardFor({
    ...input, outcome: { optionId: 'this-computer', kind: 'this-computer', outcome: 'not-available' },
    viability: { ...initialViability('this-computer', 'this-computer', 'desktop'), state: 'not-detected', sentence, fix }
  });
  assert.deepEqual([card.reason, card.fix, card.trustLine], [sentence, fix, undefined]);
});

test('GUIDE-05: six lines for every kind', () => {
  for (const kind of OPTION_KINDS) {
    const card = cardFor({
      ...input, outcome: { kind, optionId: kind, outcome: 'not-available' },
      viability: initialViability(kind, kind, 'desktop')
    });
    assert.deepEqual(Object.keys(card.lines), [...CARD_LINE_KEYS]);
    const lines = CARD_LINE_KEYS.map((key) => card.lines[key]);
    assert.ok(lines.every((line) => /\.$/.test(line)), kind);
    const words = [card.title, ...lines, card.approvalNote];
    for (const line of words) {
      assert.doesNotMatch(line.replaceAll('NEAR AI private hardware (checked each time it is used)', ''), /\bprivate\b/i);
      assert.doesNotMatch(line, /\b(?:[\w-]+\/[\w-]+|T[0-3])\b/);
    }
    assert.deepEqual(countHits(words.map((text) => ({ text })), 'src/domain/setup/cards.ts'), {});
  }
});

test('D-36: approval note', () => {
  const approved = cardFor({ ...input, approval: { name: 'Example model', use: 'T2' } });
  assert.ok(approved.approvalNote.includes('Example model'));
  assert.ok(approved.approvalNote.includes(USE_TIER_WORDS.T2));
  assert.doesNotMatch(approved.approvalNote, /\bT[0-3]\b/);
  assert.equal(cardFor(input).approvalNote, NO_APPROVAL_TEXT);
  const reported = cardFor({
    ...input, outcome: { ...input.outcome, outcome: 'available', decision: { ...decision, wouldRefuse: ['route.passport'] } }
  });
  assert.equal(reported.outcome, 'available');
  assert.equal(reported.approvalNote, NO_APPROVAL_TEXT);
  assert.equal(reported.trustLine, cardFor(input).trustLine);
});

test('provider, region and measured speed fill the card slots', () => {
  const kind = 'vendor-tee';
  const card = cardFor({
    ...input, provider: 'Example provider', speed: 'Measured at 24 tokens per second.',
    outcome: { optionId: kind, kind, outcome: 'not-available' },
    viability: {
      ...initialViability(kind, kind, 'desktop'),
      endpoint: { class: 'vendor-tee', region: 'CA', host: 'example.org', scheme: 'https', tlsPins: [] }
    }
  });
  assert.match(card.title, /Example provider.*Canada/);
  assert.equal(card.lines.speed, 'Measured at 24 tokens per second.');
  assert.doesNotMatch(JSON.stringify(card), /\{(?:provider|region|speed)\}/);
});

test('D-14: only a different choice with a recommendation needs a reason', () => {
  assert.equal(choiceNeedsReason('this-computer', 'near-private'), true);
  assert.equal(choiceNeedsReason('this-computer', 'this-computer'), false);
  assert.equal(choiceNeedsReason('this-computer', undefined), false);
  assert.equal(choiceNeedsReason(undefined, 'near-private'), false);
});
