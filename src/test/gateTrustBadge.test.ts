// The trust badge on each cloud answer (CLAS-08, D-56): one pure function picks one of three states from the checks that ran, the page draws it under its
// own run's answer, the session checks each TEE answer once in the background and never leaves a badge at "Checking now", and the badge explains itself.
// Attestation tests use the recorded fixtures and fake fetches; nothing reaches the network and no key is read.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BADGE_CHECK_TIMEOUT_MS, TRUST_BADGE_STATES, TRUST_BADGE_TEXT, TRUST_BADGE_TITLES, TRUST_VERIFICATIONS, trustBadgeFor, trustBadgeRank,
  type TrustBadge, type TrustBadgeFacts, type TrustVerification
} from '../domain/gate/trustBadge';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import { DEFAULT_RULES } from '../agent/permissions';
import { chatPage, type StubNode } from './helpers/chatPage';
import { FakeDocument, type FakeNode } from './helpers/fakeDom';
import { newTestConversation } from './helpers/gatedRuns';

const ROOT = path.join(__dirname, '..', '..');

interface TrustKit {
  renderTrustBadge(doc: FakeDocument, container: FakeNode, badge: unknown, post: (message: unknown) => void, runId: string): FakeNode | undefined;
  STATES: readonly string[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = require(path.join(ROOT, 'media', 'chat', 'trustBadge.js')) as TrustKit;

const NOW = Date.UTC(2026, 10, 18, 12);
const BOUND: ConnectionBindingFact = { state: 'bound', host: 'https://cloud-api.near.ai/v1', checkedAt: NOW, fingerprint: 'ab'.repeat(32) };

/** Every input at its best: a TEE model on NEAR AI Cloud's endpoint, signed, over a connection held to a fresh bound fact, no earlier failure. */
const BEST: TrustBadgeFacts = { route: 'near', nearEndpoint: true, boundary: 'tee', hasEvidence: true, verification: 'signed', connection: BOUND, connectionFresh: true, earlierCheckFailed: false };

const badgeOf = (facts: Partial<TrustBadgeFacts>): TrustBadge => {
  const badge = trustBadgeFor({ ...BEST, ...facts });
  assert.ok(badge !== undefined);
  return badge;
};

// ---- Task 1 (tracer): the pure state, the page kit, the real page ----

test('tracer: every input at its best is Verified private model, with its title and explanation', () => {
  const badge = badgeOf({});
  assert.equal(badge.state, 'verified-private');
  assert.equal(badge.title, 'Verified private model');
  assert.equal(badge.explanation, TRUST_BADGE_TEXT.explanation['verified-private']);
  assert.deepEqual(badge.reasons, []);
  assert.equal(badge.helpers, TRUST_BADGE_TEXT.helpers);
  assert.match(badge.helpers, /Helper agents in the run may have used other models/);
});

test('the three titles are the owner\'s words, and an answer through a local client gets no badge', () => {
  assert.deepEqual([...TRUST_BADGE_STATES], ['verified-private', 'model-verified', 'not-verified']);
  assert.deepEqual(TRUST_BADGE_TITLES, { 'verified-private': 'Verified private model', 'model-verified': 'Model verified, connection not proven', 'not-verified': 'Not verified' });
  assert.equal(trustBadgeFor({ ...BEST, route: 'local' }), undefined);
  assert.equal(BADGE_CHECK_TIMEOUT_MS, 20_000);
});

test('one fact set per reason: each says why in plain words', () => {
  const cases: Array<[Partial<TrustBadgeFacts>, TrustBadge['state'], string]> = [
    [{ verification: 'pending' }, 'not-verified', TRUST_BADGE_TEXT.checking],
    [{ verification: 'timed-out' }, 'not-verified', TRUST_BADGE_TEXT.timedOut],
    [{ verification: 'unavailable', verificationSummary: 'The attestation report could not be fetched (fetch failed).' }, 'not-verified', `${TRUST_BADGE_TEXT.unavailable} The attestation report could not be fetched (fetch failed).`],
    [{ verification: 'failed', verificationSummary: 'The signature does not match the signing address.' }, 'not-verified', `${TRUST_BADGE_TEXT.failed} The signature does not match the signing address.`],
    [{ boundary: 'cloud', forwardedTo: 'Example Provider', verification: 'not-run' }, 'not-verified', 'This model runs outside a verified enclave: NEAR AI forwards it to Example Provider.'],
    [{ boundary: 'cloud', verification: 'not-run' }, 'not-verified', TRUST_BADGE_TEXT.forwardedSomewhere],
    [{ boundary: undefined, verification: 'not-run' }, 'not-verified', TRUST_BADGE_TEXT.unknownModel],
    [{ nearEndpoint: false, verification: 'not-run' }, 'not-verified', TRUST_BADGE_TEXT.otherEndpoint],
    [{ hasEvidence: false, verification: 'not-run' }, 'not-verified', TRUST_BADGE_TEXT.noSignature],
    [{ earlierCheckFailed: true }, 'not-verified', TRUST_BADGE_TEXT.earlierFailed],
    [{ connection: { state: 'unavailable', host: BOUND.host } }, 'model-verified', `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.unavailable}`],
    [{ connection: { state: 'not-bound', host: BOUND.host } }, 'model-verified', `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection['not-bound']}`],
    [{ connection: { state: 'unknown', host: BOUND.host } }, 'model-verified', `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.unknown}`],
    [{ connection: undefined }, 'model-verified', `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.unknown}`],
    [{ connectionFresh: false }, 'model-verified', `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.stale}`]
  ];
  for (const [facts, state, reason] of cases) {
    const badge = badgeOf(facts);
    assert.equal(badge.state, state, JSON.stringify(facts));
    assert.ok(badge.reasons.includes(reason), `${JSON.stringify(facts)}: ${JSON.stringify(badge.reasons)}`);
    assert.equal(badge.title, TRUST_BADGE_TITLES[state]);
    assert.equal(badge.explanation, TRUST_BADGE_TEXT.explanation[state]);
  }
  // A forwarded model's badge never says it is being checked.
  assert.ok(!badgeOf({ boundary: 'cloud', verification: 'not-run' }).reasons.includes(TRUST_BADGE_TEXT.checking));
  // No reason sentence is empty or carries an em-dash.
  for (const value of Object.values(TRUST_BADGE_TEXT).flatMap((entry) => typeof entry === 'string' ? [entry] : Object.values(entry))) {
    assert.ok(value.length > 0 && !value.includes('—'), value);
  }
});

test('edge CLAS-08 ordering: over every combination, making any one input worse never makes the badge stronger, and Verified private model needs every input at its best', () => {
  const boundaries: Array<TrustBadgeFacts['boundary']> = ['tee', 'cloud', 'local', undefined];
  const connections: Array<[string, Pick<TrustBadgeFacts, 'connection' | 'connectionFresh'>]> = [
    ['bound', { connection: BOUND, connectionFresh: true }],
    ['not-bound', { connection: { state: 'not-bound', host: BOUND.host }, connectionFresh: false }],
    ['unavailable', { connection: { state: 'unavailable', host: BOUND.host }, connectionFresh: false }],
    ['unknown', { connection: { state: 'unknown', host: BOUND.host }, connectionFresh: false }],
    ['none', { connection: undefined, connectionFresh: false }],
    ['stale', { connection: BOUND, connectionFresh: false }]
  ];
  assert.deepEqual([...TRUST_VERIFICATIONS], ['not-run', 'pending', 'signed', 'failed', 'unavailable', 'timed-out']);
  type Combo = { boundary: TrustBadgeFacts['boundary']; nearEndpoint: boolean; hasEvidence: boolean; verification: TrustVerification; connection: number; earlierCheckFailed: boolean };
  const factsOf = (combo: Combo): TrustBadgeFacts => ({ route: 'near', boundary: combo.boundary, nearEndpoint: combo.nearEndpoint, hasEvidence: combo.hasEvidence, verification: combo.verification, verificationSummary: 'Summary.', earlierCheckFailed: combo.earlierCheckFailed, ...connections[combo.connection]![1] });
  const rankOf = (combo: Combo): number => trustBadgeRank(trustBadgeFor(factsOf(combo))!.state);
  // Each input's values, best first: worse means any later value.
  const dimensions: Array<[keyof Combo, unknown[]]> = [
    ['boundary', boundaries], ['nearEndpoint', [true, false]], ['hasEvidence', [true, false]],
    ['verification', ['signed', ...TRUST_VERIFICATIONS.filter((value) => value !== 'signed')]], ['connection', connections.map((_, index) => index)], ['earlierCheckFailed', [false, true]]
  ];
  const combos: Combo[] = [];
  for (const boundary of boundaries) for (const nearEndpoint of [true, false]) for (const hasEvidence of [true, false]) for (const verification of TRUST_VERIFICATIONS) for (let connection = 0; connection < connections.length; connection += 1) for (const earlierCheckFailed of [false, true]) {
    combos.push({ boundary, nearEndpoint, hasEvidence, verification, connection, earlierCheckFailed });
  }
  assert.equal(combos.length, 4 * 2 * 2 * 6 * 6 * 2, 'boundary 4, endpoint 2, signature id 2, 6 verification outcomes, 6 connection states, earlier failure 2');
  assert.equal(combos.length, 1152);
  let compared = 0;
  for (const combo of combos) {
    const rank = rankOf(combo);
    for (const [key, values] of dimensions) {
      const at = values.indexOf(combo[key]);
      for (const worse of values.slice(at + 1)) {
        const worsened = { ...combo, [key]: worse } as Combo;
        assert.ok(rankOf(worsened) <= rank, `${JSON.stringify(combo)} made ${String(key)} worse (${String(worse)}) and got stronger`);
        compared += 1;
      }
    }
    const allBest = dimensions.every(([key, values]) => combo[key] === values[0]);
    const allButConnection = dimensions.every(([key, values]) => key === 'connection' || combo[key] === values[0]);
    assert.equal(rank === 2, allBest, `Verified private model only with every input at its best: ${JSON.stringify(combo)}`);
    assert.equal(rank >= 1, allButConnection, `Model verified only with every input but the connection at its best: ${JSON.stringify(combo)}`);
    if (combo.verification !== 'signed') assert.equal(rank, 0, 'a check that is not signed is always Not verified');
  }
  assert.ok(compared > combos.length, 'every worse value of every input was compared');
});

test('the kit draws one button per state with its title, an aria-label and aria-expanded, and nothing for a state outside the three', () => {
  const doc = new FakeDocument();
  for (const state of TRUST_BADGE_STATES) {
    const container = doc.createElement('div');
    doc.body.append(container);
    const badge = { state, title: TRUST_BADGE_TITLES[state], explanation: TRUST_BADGE_TEXT.explanation[state], reasons: [], helpers: TRUST_BADGE_TEXT.helpers };
    const button = kit.renderTrustBadge(doc, container, badge, () => undefined, 'run-1-aaaaaa');
    assert.ok(button !== undefined);
    assert.equal(button.tagName, 'button');
    assert.equal(button.type, 'button');
    assert.equal(button.attributes.get('data-state'), state);
    assert.equal(button.attributes.get('aria-label'), `Trust: ${TRUST_BADGE_TITLES[state]}. Show details`);
    assert.equal(button.attributes.get('aria-expanded'), 'false');
    assert.ok(button.all((node) => node.textContent === TRUST_BADGE_TITLES[state]).length === 1, 'the title is in words');
    assert.ok(button.all((node) => node.attributes.get('aria-hidden') === 'true' && node.textContent.length > 0).length === 1, 'an icon, hidden from screen readers');
    // Drawn again, the one badge is updated, never a second one added.
    kit.renderTrustBadge(doc, container, { ...badge, state: 'not-verified', title: 'Not verified' }, () => undefined, 'run-1-aaaaaa');
    assert.equal(container.all((node) => node.tagName === 'button' && node.className === 'trust-badge').length, 1);
  }
  const container = doc.createElement('div');
  for (const bad of [undefined, null, 'verified-private', { state: 'verified', title: 'Verified' }, { state: 'verified-private' }, { state: 'not-verified', title: '' }]) {
    assert.equal(kit.renderTrustBadge(doc, container, bad, () => undefined, 'run-1-aaaaaa'), undefined, JSON.stringify(bad));
  }
  assert.equal(container.children.length, 0);
});

/** Every node under a page node. */
function under(node: StubNode): StubNode[] { return node.all(() => true); }
const badgesUnder = (node: StubNode): StubNode[] => under(node).filter((child) => child.tagName === 'button' && child.className === 'trust-badge');
const textOf = (node: StubNode): string => [node.textContent, ...under(node).map((child) => child.textContent)].join(' ');

async function answerOn(page: ReturnType<typeof chatPage>, runId: string): Promise<StubNode> {
  const transcript = page.nodes.get('transcript')!;
  page.send({ type: 'assistant-start', model: 'tee-model', privacy: 'Private · runs in NEAR TEE' });
  page.send({ type: 'assistant-done', runId, usage: { inputTokens: 1, outputTokens: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return transcript.children.at(-1)!;
}

const NOT_VERIFIED = { state: 'not-verified', title: 'Not verified', explanation: TRUST_BADGE_TEXT.explanation['not-verified'], reasons: [TRUST_BADGE_TEXT.checking], helpers: TRUST_BADGE_TEXT.helpers };

test('the real chat page shows one badge reading "Not verified" under that run\'s answer; a badge for an unknown run id or an unknown state draws nothing', async () => {
  const page = chatPage();
  const transcript = page.nodes.get('transcript')!;
  const reply = await answerOn(page, 'run-1-aaaaaa');
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: NOT_VERIFIED });
  const badges = badgesUnder(reply);
  assert.equal(badges.length, 1);
  assert.match(textOf(badges[0]!), /Not verified/);
  assert.equal(badges[0]!.getAttribute('aria-label'), 'Trust: Not verified. Show details');
  page.send({ type: 'trust-badge', runId: 'run-9-ffffff', badge: NOT_VERIFIED });
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: { ...NOT_VERIFIED, state: 'trusted' } });
  assert.equal(badgesUnder(transcript).length, 1, 'nothing more was drawn anywhere');
  assert.equal(badgesUnder(reply)[0]!.getAttribute('data-state'), 'not-verified', 'an unknown state changed nothing');
});

test('edge CLAS-08 concurrency on the page: a badge for an earlier run updates only that run\'s answer, never the newest one', async () => {
  const page = chatPage();
  const first = await answerOn(page, 'run-1-aaaaaa');
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: NOT_VERIFIED });
  const second = await answerOn(page, 'run-2-bbbbbb');
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: { ...NOT_VERIFIED, state: 'model-verified', title: 'Model verified, connection not proven' } });
  assert.equal(badgesUnder(second).length, 0, 'the newest answer has no badge of another run');
  assert.equal(badgesUnder(first).length, 1);
  assert.equal(badgesUnder(first)[0]!.getAttribute('data-state'), 'model-verified');
});

// ---- The session posts the badge for the lead agent's cloud answers ----

const PRIVATE = 'Private · runs in NEAR TEE';
const EVIDENCE = { chatId: 'chatcmpl-1', requestHash: 'a', responseHash: 'b' };

/** A client that is not NEAR AI Cloud (no endpoint said), answering once with a signature id. */
function plainClient(evidence: typeof EVIDENCE | undefined = EVIDENCE): unknown {
  return {
    async *streamCompletion() { yield { type: 'done' as const, message: { role: 'assistant' as const, content: 'ok' }, finishReason: 'stop', usage: { verificationStatus: 'unknown' as const, latencyMs: 1, ...(evidence ? { evidence } : {}) } }; },
    async actualCostsUsd() { return undefined; },
    async verifyResponse() { return { outcome: 'signed' as const, summary: 'Signed.', checks: {}, notChecked: [] }; }
  };
}

test('the session posts one badge for a cloud answer after assistant-done, and none for an answer through a local client', async () => {
  for (const [privacy, local, expected] of [[PRIVATE, false, 1], ['Local · runs on this machine', true, 0]] as const) {
    const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-'));
    const posted: Array<{ type: string; runId?: string; badge?: TrustBadge }> = [];
    const conversation = newTestConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'));
    await conversation.send({ text: 'hi', client: plainClient() as never, model: 'tee-model', privacy, local, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
    const badges = posted.filter((message) => message.type === 'trust-badge');
    assert.equal(badges.length, expected, privacy);
    if (expected) {
      const done = posted.findIndex((message) => message.type === 'assistant-done');
      assert.ok(posted.indexOf(badges[0]!) > done, 'after the answer is on the page');
      assert.equal(badges[0]!.runId, posted[done]!.runId);
      // Not NEAR AI Cloud's own endpoint, so nothing is checked and the badge says why.
      assert.equal(badges[0]!.badge!.state, 'not-verified');
      assert.ok(badges[0]!.badge!.reasons.includes(TRUST_BADGE_TEXT.otherEndpoint));
    }
    assert.ok(!posted.some((message) => message.type === 'response-verifiable'), 'the old Verify signature row is gone');
  }
});
