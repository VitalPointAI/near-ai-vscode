// The empty-state card (74.1-13 Task 1, D-22, design 8.5, 74.1-UI-SPEC S8): only the ways forward whose condition holds, who to ask last, and no tier,
// approval or rule id anywhere in its words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_STATE_TEXT, emptyStateCard } from '../domain/gate/emptyState';
import type { EmptyStateInput } from '../domain/gate/emptyState';
import { whoToAsk } from '../domain/gate/passportStep';

const CLAUDE = { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', closedApprovalCovers: true };

function input(extra: Partial<EmptyStateInput> = {}): EmptyStateInput {
  return {
    use: 'T2', label: 'Organization Public', routingTier: 'any-cloud', place: 'NEAR AI private hardware', catalog: [CLAUDE], allows: () => true,
    whoToAsk: whoToAsk({ name: 'Security desk', how: 'security@example.org' }, true), organization: true, hasOrgHostingOption: false, hasVault: false, ...extra
  };
}

const kinds = (card: ReturnType<typeof emptyStateCard>) => card.options.map((option) => option.kind);

test('D-22: at a label that may go to any cloud, with a closed-model approval covering the use, the card offers that model and says the text leaves private hardware', () => {
  const card = emptyStateCard(input());
  const closed = card.options.find((option) => option.kind === 'closed');
  assert.ok(closed && closed.kind === 'closed');
  assert.equal(closed.model, 'anthropic/claude-sonnet-5');
  assert.equal(closed.text, 'Use anthropic/claude-sonnet-5 from an outside provider (anthropic). This is allowed only because this chat\'s label, Organization Public, may go to any cloud. Your text leaves private hardware.');
  assert.equal(closed.button, 'Use anthropic/claude-sonnet-5 for this chat');
});

test('D-22: at a label kept on private hardware (local-only, Protected B) there is no closed option', () => {
  for (const routingTier of ['local-only', 'attested-cloud']) assert.deepEqual(kinds(emptyStateCard(input({ routingTier, label: 'Protected B' }))), ['near', 'research'], routingTier);
});

test('T-74.1-40: no option is offered for a model the gate would refuse, or whose approval does not cover the use', () => {
  assert.deepEqual(kinds(emptyStateCard(input({ allows: () => false }))), ['near', 'research']);
  assert.deepEqual(kinds(emptyStateCard(input({ catalog: [{ ...CLAUDE, closedApprovalCovers: false }] }))), ['near', 'research']);
});

test('P17: the AI service row appears only when the guide\'s AI services option exists, and names a Cohere vault only when one is connected', () => {
  assert.equal(kinds(emptyStateCard(input())).includes('service'), false);
  const withService = emptyStateCard(input({ hasOrgHostingOption: true }));
  assert.deepEqual(kinds(withService), ['service', 'closed', 'near', 'research']);
  assert.equal(withService.options[0]?.text, EMPTY_STATE_TEXT.serviceNoVault);
  assert.equal(emptyStateCard(input({ hasOrgHostingOption: true, hasVault: true })).options[0]?.text, 'Run an approved model on your organization\'s own server, on this computer, or through a Cohere vault. Command A+ can run through a Cohere vault or on your organization\'s own hardware.');
});

test('D-22: the NEAR AI and research workspace rows are always there, so the card is never empty', () => {
  const card = emptyStateCard(input({ catalog: [], routingTier: 'local-only' }));
  assert.deepEqual(kinds(card), ['near', 'research']);
  const near = card.options[0];
  assert.ok(near?.kind === 'near');
  assert.equal(near.detail, 'NEAR AI has been asked to host Nemotron 3, Command A+ and gpt-oss, and Western embedding and reranking models, in its private hardware. When it does, they appear in the models list.');
  assert.equal(card.options[1]?.button, 'Open Research Workspace');
});

test('P2: who to ask is the policy\'s contact, or the built sentence for this computer with no organization; it comes last', () => {
  assert.equal(emptyStateCard(input()).who, 'Who to ask: Security desk (security@example.org).');
  const own = emptyStateCard(input({ organization: false, whoToAsk: whoToAsk(undefined, false) }));
  assert.equal(own.who, 'Who to ask: whoever set up the rules on this computer.');
  assert.equal(own.facts, 'This chat is agent work at Organization Public. No model your rules allow for that is available on NEAR AI private hardware.');
  assert.equal(emptyStateCard(input()).facts, 'This chat is agent work at Organization Public. No model your organization\'s rules allow for that is available on NEAR AI private hardware.');
});

test('the card names no tier, approval or rule id', () => {
  const words = JSON.stringify(emptyStateCard(input({ hasOrgHostingOption: true })));
  assert.doesNotMatch(words, /\bT[0-3]\b|tier|passport|route\.|TEE/);
});
