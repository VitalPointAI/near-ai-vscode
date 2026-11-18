// The trust badge on each cloud answer (CLAS-08, D-56): one pure function picks one of three states from the checks that ran, the page draws it under its
// own run's answer, the session checks each TEE answer once in the background and never leaves a badge at "Checking now", and the badge explains itself.
// Attestation tests use the recorded fixtures and fake fetches; nothing reaches the network and no key is read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BADGE_CHECK_TIMEOUT_MS, MAX_TRUST_BYTES, MAX_TRUST_RECORDS, mergeTrustRecords, trustBadgeFromRecord, TRUST_BADGE_STATES, TRUST_BADGE_TEXT, TRUST_BADGE_TITLES, TRUST_VERIFICATIONS, parseTrustRecord, trustBadgeFor, trustBadgeRank,
  trustRecordKey, trustRecordOf, type TrustBadge, type TrustBadgeFacts, type TrustRecord, type TrustVerification
} from '../domain/gate/trustBadge';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import type { Label } from '../domain/gate/labels';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation } from '../services/agentSession';
import { NearAiClient, type AgentMessage, type CompletionEvent, type ToolCall } from '../services/nearAiClient';
import type { ConnectionBindingSource } from '../services/connectionBinding';
import { TranscriptStore } from '../services/transcripts';
import { ThreadStore, chatLabelOf, mergeMeta, validMeta, type ThreadMeta } from '../services/threadStore';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ConversationLog } from '../services/conversations';
import { entriesToView } from '../domain/state/threadView';
import { findSecrets } from '../domain/team/secrets';
import { MemorySecrets } from './helpers/stateFixtures';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { openTrustDetails, TRUST_DETAILS_NOT_KEPT_TEXT } from '../services/trustDetails';
import { createVscodeStub } from './helpers/vscodeStub';
import { TEST_ROOT, personalSign, testQuote, testSigner } from './helpers/attestationFixtures';
import { labelledProject } from './helpers/markFixtures';
import { chatPage, type StubNode } from './helpers/chatPage';
import { FakeDocument, type FakeNode } from './helpers/fakeDom';
import { newTestConversation, testGateHost } from './helpers/gatedRuns';

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

// ---- Task 2: the badge reflects the checks that actually ran, once per answer, settles even offline, and Check again reruns them ----

const NEAR_URL = 'https://cloud-api.near.ai/v1';
const SIGNING = testSigner('near-ai-gateway-test-key');
const IMPOSTOR = testSigner('someone-else');
const CONFIDENTIAL: Label = { scale: 'org', level: 'Confidential', compartments: [], releasability: [], handling: [] };

interface Cloud {
  readonly client: NearAiClient;
  readonly content: string[];
  /** Signature requests by chat id. */
  readonly signatures: Map<string, number>;
  readonly signatureCount: () => number;
  readonly reportGets: () => number;
  /** Content requests that went over the pinned fetch the binding source gave (a fetch of its own, distinct from the client's). */
  readonly pinned: () => number;
  /** What the signature endpoint does now: sign with the gateway key, sign with another key, throw as when offline, or answer only when released. */
  mode: 'valid' | 'bad-signature' | 'offline' | 'hang';
  release: () => void;
}

/**
 * A fake NEAR AI Cloud that streams answers and signs them the way NEAR does, from the recorded quote fixtures. `tee-model` runs in a TEE and `fwd-model` is
 * forwarded to another provider. The connection fact is bound (with a pinned fetch that is this same fake), another state, or absent (no binding source).
 */
async function cloud(connection: ConnectionBindingFact['state'] | 'none' = 'bound'): Promise<Cloud> {
  const content: string[] = [];
  const answers = new Map<string, { request: string; response: string }>();
  const signatures = new Map<string, number>();
  let reports = 0;
  let released!: () => void;
  const held = new Promise<void>((resolve) => { released = resolve; });
  const state: { mode: Cloud['mode'] } = { mode: 'valid' };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'tee-model' }, { id: 'fwd-model' }] });
    if (method === 'GET' && url.pathname.endsWith('/model/list')) {
      return Response.json({ models: [
        { modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } },
        { modelId: 'fwd-model', metadata: { attestationSupported: false, providerType: 'external', providerConfig: { base_url: 'https://api.example-provider.com/v1' } } }
      ] });
    }
    if (method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const chatId = `chatcmpl-${String(content.length + 1)}`;
      content.push(chatId);
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const response = chunk({ id: chatId, choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + chunk({ id: chatId, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n';
      answers.set(chatId, { request: String(init?.body), response });
      return new Response(response, { headers: { 'content-type': 'text/event-stream', 'inference-id': `inf-${chatId}` } });
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/signature/')) {
      const chatId = decodeURIComponent(url.pathname.slice('/v1/signature/'.length));
      signatures.set(chatId, (signatures.get(chatId) ?? 0) + 1);
      if (state.mode === 'offline') throw new TypeError('fetch failed');
      if (state.mode === 'hang') await held;
      const answer = answers.get(chatId);
      if (answer === undefined) return new Response('{}', { status: 404 });
      const text = `${createHash('sha256').update(answer.request).digest('hex')}:${createHash('sha256').update(answer.response).digest('hex')}`;
      return Response.json({ text, signature: personalSign(text, (state.mode === 'bad-signature' ? IMPOSTOR : SIGNING).key), signing_address: SIGNING.address, signing_algo: 'ecdsa' });
    }
    if (method === 'GET' && url.pathname.endsWith('/attestation/report')) {
      reports += 1;
      const reportData = Buffer.alloc(64);
      Buffer.from(SIGNING.address.slice(2), 'hex').copy(reportData, 0);
      Buffer.from(url.searchParams.get('nonce') ?? '', 'hex').copy(reportData, 32);
      return Response.json({ model_attestations: [{ signing_address: SIGNING.address, signing_algo: 'ecdsa', intel_quote: testQuote(reportData) }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const fact = (): ConnectionBindingFact => connection === 'bound' ? { state: 'bound', host: NEAR_URL, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) } : { state: connection as ConnectionBindingFact['state'], host: NEAR_URL, checkedAt: Date.now() };
  // The pinned fetch is a fetch of its own (PR #95 review round 3), so a request that goes over it can be told from one that does not.
  let pinnedCalls = 0;
  const pinnedFetch = (async (input: string | URL | Request, init?: RequestInit) => { pinnedCalls += 1; return fetchFn(input, init); }) as typeof fetch;
  const binding: ConnectionBindingSource | undefined = connection === 'none' ? undefined : { current: fact, refresh: async () => fact(), markNotBound: () => undefined, fetchFor: () => pinnedFetch };
  const client = new NearAiClient({ baseUrl: NEAR_URL, apiKey: 'test-key', fetchFn, route: 'near', ...(binding ? { binding } : {}), maxRetries: 0, attestationTrust: { trustedRoot: TEST_ROOT } });
  await client.listModels();
  return {
    client, content, signatures, signatureCount: () => [...signatures.values()].reduce((sum, count) => sum + count, 0), reportGets: () => reports, pinned: () => pinnedCalls,
    get mode() { return state.mode; }, set mode(value) { state.mode = value; },
    release: () => released()
  };
}

interface BadgeChat {
  readonly conversation: AgentConversation;
  readonly posted: Array<{ type: string; runId?: string; badge?: TrustBadge }>;
  readonly badges: () => Array<{ runId: string; badge: TrustBadge }>;
  /** The badge timers the session set, in order; firing one is BADGE_CHECK_TIMEOUT_MS passing. */
  readonly timers: Array<{ run: () => void; ms: number; cleared: boolean }>;
}

/** A chat in a project labelled org/Confidential, or unlabelled (org/Public), whose badge timers are under the test's control. */
function badgeChat(projectLabel: Label | null = null): BadgeChat {
  const root = projectLabel === null ? mkdtempSync(path.join(tmpdir(), 'near-ai-badge-')) : labelledProject({ project: projectLabel });
  const posted: BadgeChat['posted'] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = testGateHost();
  const timers: BadgeChat['timers'] = [];
  conversation.badgeTimers = {
    set: (run, ms) => { timers.push({ run, ms, cleared: false }); return timers.length - 1; },
    clear: (handle) => { const timer = timers[handle as number]; if (timer) timer.cleared = true; }
  };
  const badges = () => posted.filter((message) => message.type === 'trust-badge').map((message) => ({ runId: message.runId!, badge: message.badge! }));
  return { conversation, posted, badges, timers };
}

const send = (chat: BadgeChat, client: NearAiClient, model = 'tee-model', privacy = PRIVATE) =>
  chat.conversation.send({ text: 'hello', client, model, privacy, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });

/** Lets every check that can settle settle, and its badge be posted. */
const settle = async (): Promise<void> => { for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('a TEE answer at org/Confidential, over the connection pinned to a fresh bound fact: Checking now, then Verified private model; the route\'s check is reused, one signature request', async () => {
  const near = await cloud('bound');
  const chat = badgeChat(CONFIDENTIAL);
  await send(chat, near.client);
  await settle();
  const badges = chat.badges();
  assert.equal(badges.length, 2);
  assert.equal(badges[0]!.badge.state, 'not-verified');
  assert.deepEqual(badges[0]!.badge.reasons, [TRUST_BADGE_TEXT.checking]);
  assert.equal(badges[1]!.badge.state, 'verified-private');
  assert.equal(badges[1]!.badge.title, 'Verified private model');
  assert.equal(badges[1]!.runId, badges[0]!.runId);
  assert.equal(near.signatures.get('chatcmpl-1'), 1, 'exactly one /signature request for the chat id: the badge used plan 25\'s check');
  assert.equal(near.signatureCount(), 1);
  assert.ok(chat.timers[0]!.cleared, 'the timeout was cleared when the check settled');
  assert.equal(chat.timers[0]!.ms, BADGE_CHECK_TIMEOUT_MS);
});

// The owner's decision of 2026-11-18 (PR #95): a Public request also goes over the pinned connection while a fresh proof exists. This test asserted the
// opposite before; the fake's binding now gives a pinned fetch of its own (PR #95 review round 3), so the pinned path is the one exercised here.
test('at org/Public with a fresh proof, a request through a real session goes over the pinned connection and its signed answer is Verified private model', async () => {
  const near = await cloud('bound');
  const chat = badgeChat();
  await send(chat, near.client);
  await settle();
  assert.equal(near.pinned(), 1, 'the content request went over the binding source\'s pinned fetch');
  const last = chat.badges().at(-1)!.badge;
  assert.equal(last.state, 'verified-private');
  assert.deepEqual(last.reasons, []);
  assert.equal(near.signatureCount(), 1, 'one signature request for the answer, through the report cache');
});

test('the connection unavailable, unknown or absent: Model verified, connection not proven, with the cause sentence among its reasons', async () => {
  for (const [state, cause] of [['unavailable', TRUST_BADGE_TEXT.connection.unavailable], ['unknown', TRUST_BADGE_TEXT.connection.unknown], ['none', TRUST_BADGE_TEXT.connection.unknown]] as const) {
    const near = await cloud(state);
    const chat = badgeChat();
    await send(chat, near.client);
    await settle();
    const last = chat.badges().at(-1)!.badge;
    assert.equal(last.state, 'model-verified', state);
    assert.ok(last.reasons.includes(`${TRUST_BADGE_TEXT.connectionNotProven} ${cause}`), `${state}: ${JSON.stringify(last.reasons)}`);
  }
});

test('a signature that does not match the fixture is Not verified with the failure summary; a check that cannot reach NEAR AI is Not verified, could not be checked', async () => {
  const bad = await cloud('bound');
  bad.mode = 'bad-signature';
  const failedChat = badgeChat();
  await send(failedChat, bad.client);
  await settle();
  const failed = failedChat.badges().at(-1)!.badge;
  assert.equal(failed.state, 'not-verified');
  assert.ok(failed.reasons.some((reason) => reason.startsWith(TRUST_BADGE_TEXT.failed) && /signature/i.test(reason)), JSON.stringify(failed.reasons));
  const offline = await cloud('bound');
  offline.mode = 'offline';
  const offlineChat = badgeChat();
  await send(offlineChat, offline.client);
  await settle();
  const unavailable = offlineChat.badges().at(-1)!.badge;
  assert.equal(unavailable.state, 'not-verified');
  assert.ok(unavailable.reasons.some((reason) => reason.startsWith(TRUST_BADGE_TEXT.unavailable)), JSON.stringify(unavailable.reasons));
  assert.equal(offlineChat.conversation.routeAttestation.failed, false, 'a check that cannot run sets nothing');
});

test('D-56: a check that never settles shows Not verified, could not be checked in time, after BADGE_CHECK_TIMEOUT_MS; when it settles later that run\'s badge updates', async () => {
  const near = await cloud('bound');
  near.mode = 'hang';
  const chat = badgeChat();
  await send(chat, near.client);
  await settle();
  assert.equal(chat.badges().length, 1, 'still Checking now');
  assert.equal(chat.timers.length, 1);
  chat.timers[0]!.run();
  const timedOut = chat.badges().at(-1)!;
  assert.equal(timedOut.badge.state, 'not-verified');
  assert.ok(timedOut.badge.reasons.includes(TRUST_BADGE_TEXT.timedOut));
  assert.ok(!timedOut.badge.reasons.includes(TRUST_BADGE_TEXT.checking), 'no longer Checking now');
  near.mode = 'valid';
  near.release();
  await settle();
  const late = chat.badges().at(-1)!;
  assert.equal(late.runId, timedOut.runId);
  assert.equal(late.badge.state, 'verified-private', 'the late result updates the badge');
  assert.equal(chat.badges().length, 3);
});

test('a forwarded model\'s answer is Not verified with the forwarded reason, and the fake server saw no /signature request', async () => {
  const near = await cloud('bound');
  const chat = badgeChat();
  await send(chat, near.client, 'fwd-model', 'Not private · forwarded to example-provider.com');
  await settle();
  const badges = chat.badges();
  assert.equal(badges.length, 1, 'posted once, never checking');
  assert.equal(badges[0]!.badge.state, 'not-verified');
  assert.ok(badges[0]!.badge.reasons.includes('This model runs outside a verified enclave: NEAR AI forwards it to example-provider.com.'), JSON.stringify(badges[0]!.badge.reasons));
  assert.ok(!badges[0]!.badge.reasons.includes(TRUST_BADGE_TEXT.checking));
  assert.equal(near.signatureCount(), 0);
  assert.equal(chat.timers.length, 0, 'no check, so no timer');
});

test('a chat whose check failed earlier: Not verified even when this answer\'s check is signed; Check again on the failed answer clears it for later badges', async () => {
  const near = await cloud('bound');
  near.mode = 'bad-signature';
  const chat = badgeChat();
  await send(chat, near.client);
  await settle();
  const firstRun = chat.badges().at(-1)!.runId;
  assert.equal(chat.badges().at(-1)!.badge.state, 'not-verified');
  near.mode = 'valid';
  await send(chat, near.client);
  await settle();
  const second = chat.badges().at(-1)!;
  assert.notEqual(second.runId, firstRun);
  assert.equal(second.badge.state, 'not-verified', 'signed, but an earlier check of the chat failed');
  assert.ok(second.badge.reasons.includes(TRUST_BADGE_TEXT.earlierFailed));
  // Check again on the first answer passes now: its badge and the second one's no longer carry the earlier failure.
  const again = await chat.conversation.checkAgain(firstRun);
  assert.equal(again?.state, 'verified-private');
  assert.equal(chat.conversation.trustBadge(second.runId)?.state, 'verified-private');
});

test('Check again reruns the check afresh and gives the updated badge for that run id; on the answer that set the stop, a signed result clears the stop', async () => {
  const near = await cloud('bound');
  near.mode = 'bad-signature';
  const chat = badgeChat(CONFIDENTIAL);
  await send(chat, near.client);
  await settle();
  const runId = chat.badges().at(-1)!.runId;
  assert.equal(chat.conversation.routeAttestation.failed, true, 'the failed check stopped attested-cloud for the chat');
  const before = near.signatureCount();
  near.mode = 'valid';
  const badge = await chat.conversation.checkAgain(runId);
  assert.equal(near.signatureCount(), before + 1, 'a fresh check');
  assert.equal(badge?.state, 'verified-private');
  assert.equal(chat.conversation.routeAttestation.failed, false, 'the stop is cleared');
  // A run id the session never badged gives nothing.
  assert.equal(await chat.conversation.checkAgain('run-9-ffffff'), undefined);
});

test('edge CLAS-08 concurrency: a check for run A that settles after run B started updates only A\'s badge', async () => {
  const near = await cloud('bound');
  near.mode = 'hang';
  const chat = badgeChat();
  await send(chat, near.client);
  const runA = chat.badges().at(-1)!.runId;
  await send(chat, near.client);
  const runB = chat.badges().at(-1)!.runId;
  assert.notEqual(runA, runB);
  near.mode = 'valid';
  near.release();
  await settle();
  const settledA = chat.badges().filter((entry) => entry.runId === runA);
  const settledB = chat.badges().filter((entry) => entry.runId === runB);
  assert.equal(settledA.length, 2, 'A: Checking now, then its own result');
  assert.equal(settledB.length, 2, 'B: Checking now, then its own result');
  assert.equal(settledA.at(-1)!.badge.state, 'verified-private');
  assert.equal(settledB.at(-1)!.badge.state, 'verified-private');
});

test('a sub-agent\'s answer posts no trust badge: only the lead agent\'s answer has one (D-56)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-sub-'));
  const call: ToolCall = { id: 'a1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'designer', description: 'design', prompt: 'You are the designer. go' }) } };
  let subAnswers = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (/You are the designer\./.test(String(messages[1]?.content ?? '')) && messages[0]!.role === 'system' && messages.length === 2) {
        subAnswers += 1;
        yield { type: 'done', message: { role: 'assistant', content: 'designed' }, finishReason: 'stop', usage: { ...usage, evidence: { chatId: 'chatcmpl-sub', requestHash: 'a', responseHash: 'b' } } };
        return;
      }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage: { ...usage, evidence: EVIDENCE } };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<{ type: string; runId?: string }> = [];
  const conversation = newTestConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: client as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd: { home: root, skills: [], shellEnv: {}, agents: [{ name: 'designer', description: 'designs', tools: [], body: 'You design.', file: path.join(root, 'agents', 'designer.md') }] } });
  } finally {
    conversation.dispose();
  }
  assert.equal(subAnswers, 1, 'the sub-agent answered');
  const badges = posted.filter((message) => message.type === 'trust-badge');
  assert.equal(badges.length, 1, 'one badge, the lead\'s');
  assert.equal(badges[0]!.runId, posted.find((message) => message.type === 'assistant-done')!.runId);
});

// ---- Task 3: a click explains the badge and opens the full attestation on request, in colours that read in every theme ----

interface FullKit extends TrustKit { TEXT: Record<string, string> }
const fullKit = kit as FullKit;

const FAILED_BADGE = {
  state: 'not-verified', title: 'Not verified', explanation: TRUST_BADGE_TEXT.explanation['not-verified'],
  reasons: [`${TRUST_BADGE_TEXT.failed} The signature does not match the signing address.`], helpers: TRUST_BADGE_TEXT.helpers,
  notChecked: ['platform TCB status and certificate revocation (Intel collateral)', 'which code the enclave runs (measurements)']
};

function drawnBadge(badge: unknown = FAILED_BADGE): { doc: FakeDocument; button: FakeNode; details: FakeNode; posts: unknown[] } {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  doc.body.append(container);
  const posts: unknown[] = [];
  const button = fullKit.renderTrustBadge(doc, container, badge, (message) => posts.push(message), 'run-1-aaaaaa')!;
  const details = container.find((node) => node.className === 'trust-details')!;
  return { doc, button, details, posts };
}
const wordsIn = (node: FakeNode): string => [node.textContent, ...node.all(() => true).map((child) => child.textContent)].join(' ');
const buttonIn = (node: FakeNode, label: string): FakeNode | undefined => node.find((child) => child.tagName === 'button' && child.textContent === label);

test('a click opens the details: the explanation, the reasons, the helper-agent sentence and what is not checked; aria-expanded follows; Escape closes them and returns focus to the badge', () => {
  const { doc, button, details } = drawnBadge();
  assert.equal(details.hidden, true, 'closed at first');
  assert.equal(button.attributes.get('aria-controls'), details.id);
  button.click();
  assert.equal(button.attributes.get('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
  const words = wordsIn(details);
  assert.ok(words.includes(TRUST_BADGE_TEXT.explanation['not-verified']));
  assert.ok(words.includes('The check failed: The signature does not match the signing address.'));
  assert.ok(words.includes(TRUST_BADGE_TEXT.helpers));
  assert.ok(words.includes('Not checked in the editor: platform TCB status and certificate revocation (Intel collateral), which code the enclave runs (measurements). '));
  details.press('Escape');
  assert.equal(details.hidden, true);
  assert.equal(button.attributes.get('aria-expanded'), 'false');
  assert.equal(doc.activeElement, button, 'focus is back on the badge');
  // A second click opens them again; a key other than Escape changes nothing.
  button.click();
  button.press('Enter');
  assert.equal(details.hidden, false);
});

test('Check again posts verify-response and Show full attestation posts trust-details, each for the badge\'s own run id; an update keeps the details open', () => {
  const { button, details, posts } = drawnBadge();
  button.click();
  buttonIn(details, 'Check again')!.click();
  buttonIn(details, 'Show full attestation')!.click();
  assert.deepEqual(posts, [{ type: 'verify-response', runId: 'run-1-aaaaaa' }, { type: 'trust-details', runId: 'run-1-aaaaaa' }]);
  assert.ok(buttonIn(details, 'Checking again…'), 'Check again says it is checking until the badge comes back');
  // The updated badge arrives: the details stay open and show the new words, with Check again ready again.
  const container = button.parent!.parent!;
  fullKit.renderTrustBadge(new FakeDocument(), container, { ...FAILED_BADGE, state: 'model-verified', title: TRUST_BADGE_TITLES['model-verified'], explanation: TRUST_BADGE_TEXT.explanation['model-verified'], reasons: [] }, () => undefined, 'run-1-aaaaaa');
  assert.equal(details.hidden, false);
  assert.ok(wordsIn(details).includes(TRUST_BADGE_TEXT.explanation['model-verified']));
  assert.ok(buttonIn(details, 'Check again'));
});

test('a replayed badge (a reopened chat) shows its explanation and reasons but neither button, and says the full attestation is kept only while the window that checked it is open', () => {
  const { button, details } = drawnBadge({ ...FAILED_BADGE, replayed: true, reasons: [...FAILED_BADGE.reasons, TRUST_BADGE_TEXT.replayed] });
  button.click();
  assert.equal(buttonIn(details, 'Check again'), undefined);
  assert.equal(buttonIn(details, 'Show full attestation'), undefined);
  const words = wordsIn(details);
  assert.ok(words.includes(TRUST_BADGE_TEXT.keptWhileOpen));
  assert.ok(words.includes(TRUST_BADGE_TEXT.replayed));
  assert.ok(words.includes(TRUST_BADGE_TEXT.explanation['not-verified']));
});

test('the kit\'s own words are the host\'s, and it never writes markup', () => {
  assert.equal(fullKit.TEXT.fullCheck, TRUST_BADGE_TEXT.fullCheck);
  assert.equal(fullKit.TEXT.keptWhileOpen, TRUST_BADGE_TEXT.keptWhileOpen);
  assert.equal(fullKit.TEXT.notChecked, TRUST_BADGE_TEXT.notChecked);
  const source = readFileSync(path.join(ROOT, 'media', 'chat', 'trustBadge.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
  // Report text with markup in a reason is drawn as text.
  const { button, details } = drawnBadge({ ...FAILED_BADGE, reasons: ['<img src=x onerror=alert(1)>'] });
  button.click();
  assert.ok(details.all((node) => node.textContent === '<img src=x onerror=alert(1)>').length === 1);
  assert.equal(details.all((node) => node.tagName === 'img').length, 0);
});

test('the real chat page: the badge opens its details, and Check again and Show full attestation post for the run (with the chat id)', async () => {
  const page = chatPage();
  const reply = await answerOn(page, 'run-1-aaaaaa');
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: FAILED_BADGE });
  const badge = badgesUnder(reply)[0]!;
  badge.click();
  assert.equal(badge.getAttribute('aria-expanded'), 'true');
  assert.match(textOf(reply), /The signature does not match/);
  const before = page.sent().length;
  under(reply).find((node) => node.tagName === 'button' && node.textContent === 'Check again')!.click();
  under(reply).find((node) => node.tagName === 'button' && node.textContent === 'Show full attestation')!.click();
  const posted = page.sent().slice(before) as Array<{ type: string; runId: string }>;
  assert.deepEqual(posted.map((message) => [message.type, message.runId]), [['verify-response', 'run-1-aaaaaa'], ['trust-details', 'run-1-aaaaaa']]);
});

test('the bridge accepts trust-details with exactly a run id (and the chat id), and refuses extra fields or a bad run id', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'trust-details', runId: 'run-1-abcdef' }), { type: 'trust-details', runId: 'run-1-abcdef' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'trust-details', runId: 'run-1-abcdef', conversationId: 'conv-mf3k2-0a1b2c3d' }), { type: 'trust-details', runId: 'run-1-abcdef', conversationId: 'conv-mf3k2-0a1b2c3d' });
  assert.equal(parseChatWebviewMessage({ type: 'trust-details', runId: 'run-1-abcdef', report: '{}' }), undefined);
  for (const runId of ['run-1', '../run-1-abcdef', 'run-1-ABCDEF', 'run-1-abcdef ', 42, undefined]) {
    assert.equal(parseChatWebviewMessage({ type: 'trust-details', runId }), undefined, String(runId));
  }
});

test('Show full attestation opens one untitled JSON document holding the signature, the signing address, who holds the key, the checks, the connection with its fingerprint and the report; nothing is written to the workspace', async () => {
  const near = await cloud('bound');
  const chat = badgeChat(CONFIDENTIAL);
  await send(chat, near.client);
  await settle();
  const runId = chat.badges().at(-1)!.runId;
  const root = (chat.conversation as unknown as { root: string }).root;
  const before = listTree(root);
  const details = chat.conversation.trustDetails(runId)!;
  assert.ok(details !== undefined);
  const stub = createVscodeStub();
  const vscodeApi = stub.vscode as unknown as Parameters<typeof openTrustDetails>[0];
  const executed: string[] = [];
  const realExecute = vscodeApi.commands.executeCommand.bind(vscodeApi.commands);
  (vscodeApi.commands as { executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown> }).executeCommand = async (command: string, ...args: unknown[]) => { executed.push(command); return realExecute(command, ...args); };
  await openTrustDetails(vscodeApi, details);
  assert.equal(stub.shownDocuments.length, 1);
  const shown = stub.shownDocuments[0]!;
  assert.match(shown.uri, /^untitled:/);
  const parsed = JSON.parse(shown.text) as { check: Record<string, unknown>; connection: Record<string, unknown>; attestationReport: unknown; badge: { state: string }; notCheckedInEditor: string[] };
  assert.equal((parsed.check.signingAddress as string).toLowerCase(), SIGNING.address.toLowerCase());
  assert.equal(parsed.check.keyHeldBy, 'the model\'s own enclave');
  assert.equal(typeof parsed.check.signature, 'string');
  assert.match(String(parsed.check.signedText), /^[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.equal((parsed.check.checks as Record<string, boolean>).signature, true);
  assert.equal(parsed.connection.state, 'bound');
  assert.equal(parsed.connection.fingerprint, 'ab'.repeat(32));
  assert.equal(parsed.connection.requestHeldToThisKey, true);
  assert.ok(Array.isArray((parsed.attestationReport as { model_attestations?: unknown[] }).model_attestations), 'the report the check used');
  assert.equal(parsed.badge.state, 'verified-private');
  assert.ok(parsed.notCheckedInEditor.length > 0);
  assert.deepEqual(executed, ['workbench.action.files.setActiveEditorReadonlyInSession'], 'the tab is made read-only for the session');
  assert.deepEqual(listTree(root), before, 'nothing was written under the workspace');
  // A run whose badge is no longer kept has no details; the host says so and offers Check again.
  assert.equal(chat.conversation.trustDetails('run-9-ffffff'), undefined);
  assert.match(TRUST_DETAILS_NOT_KEPT_TEXT, /last 20 answers of this window/);
});

test('a reused attestation report is still shown on request: the report travels with the 10-minute cache, in memory only', async () => {
  const near = await cloud('bound');
  const chat = badgeChat();
  await send(chat, near.client);
  await send(chat, near.client);
  await settle();
  assert.equal(near.reportGets(), 1, 'the second answer reused the report');
  const second = chat.badges().at(-1)!.runId;
  const details = chat.conversation.trustDetails(second) as { attestationReport: { model_attestations?: unknown[] } | null; check: { summary: string } };
  assert.match(details.check.summary, /report was reused/);
  assert.ok(Array.isArray(details.attestationReport?.model_attestations));
});

test('the badge is styled by state with VS Code theme variables only, with a visible focus and a border in high contrast, and no hard-coded colour', () => {
  const css = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('\n').filter((line) => line.includes('.trust'));
  for (const state of TRUST_BADGE_STATES) assert.ok(rules.some((line) => line.includes(`.trust-badge[data-state="${state}"]`) && line.includes('var(--vscode-')), `${state} has a rule`);
  assert.ok(rules.some((line) => line.includes('.trust-badge[data-state="verified-private"]') && line.includes('--vscode-testing-iconPassed')));
  assert.ok(rules.some((line) => line.includes('.trust-badge[data-state="model-verified"]') && line.includes('--vscode-editorWarning-foreground')));
  assert.ok(rules.some((line) => line.includes('.trust-badge:focus-visible') && line.includes('--vscode-focusBorder')), 'a visible focus');
  assert.ok(rules.some((line) => line.includes('body.vscode-high-contrast .trust-badge') && line.includes('body.vscode-high-contrast-light .trust-badge') && line.includes('--vscode-contrastBorder')), 'a border in high contrast');
  for (const line of rules) assert.doesNotMatch(line, /#[0-9a-fA-F]{3,8}\b(?!\w)|rgba?\(|hsla?\(|\b(?:red|green|orange|yellow|white|black)\b/, `no hard-coded colour: ${line}`);
  assert.doesNotMatch(css, /^\.verify\b/m, 'the old row\'s rules are gone');
});

/** Every file under a folder, with its size, so a test can show nothing was written there. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${String(statSync(full).size)}`);
    }
  };
  walk(root);
  return out.sort();
}

// ---- Plan 27 Task 1: a reopened chat shows each answer's badge as it was proven, never stronger ----

const threadStoreFor = (root: string): ThreadStore => new ThreadStore(stateHomeFor(root), stateKeysFor(root, new MemorySecrets()), { writer: 'edA.1' });

function record(key: string, state: TrustBadge['state'], at: string, reasons: string[] = []): TrustRecord {
  return { key, state, reasons, at };
}
const KEY = trustRecordKey('The answer.');
const metaWith = (lastUsedAt: string, extra: Partial<ThreadMeta>): ThreadMeta => ({ id: 'conv-trust-merge-1', title: 'Chat', model: 'm', origin: 'panel', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt, turns: 1, entries: 2, bytes: 10, tip: 't', ...extra });

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let wait = 0; wait < 100 && !done(value); wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); value = await read(); }
  return value;
}

test('plan 27 tracer: a run whose check settles keeps one record, and the reopened chat shows that badge under the same answer, replayed, in the real page', async () => {
  const near = await cloud('bound');
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-store-'));
  const store = threadStoreFor(root);
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  conversation.gateHost = testGateHost();
  await conversation.send({ text: 'hello', client: near.client, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  await settle();
  await conversation.trustRecorded();
  const meta = await waitFor(() => store.meta(conversation.id), (value) => (value?.trust ?? []).some((entry) => entry.state === 'verified-private'));
  assert.equal(meta?.trust?.length, 1, 'one record for the one answer');
  assert.equal(meta!.trust![0]!.key, trustRecordKey('done'));
  assert.equal(meta!.trust![0]!.state, 'verified-private');
  assert.ok(!JSON.stringify(meta!.trust).includes(SIGNING.address.slice(2).toLowerCase()) && !/[0-9a-f]{64}/i.test(JSON.stringify(meta!.trust)), 'no address, no fingerprint');
  // Reopened, the answer carries the badge it settled on, replayed.
  const reopened = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  reopened.gateHost = testGateHost();
  const view = await reopened.restore(conversation.id) as { items: Array<{ kind: string; text?: string; trust?: TrustBadge }> };
  const answer = view.items.find((item) => item.kind === 'assistant' && item.text === 'done');
  assert.equal(answer?.trust?.state, 'verified-private');
  assert.equal(answer?.trust?.replayed, true);
  assert.ok(answer?.trust?.reasons.includes(TRUST_BADGE_TEXT.replayed));
  const page = chatPage();
  page.send({ type: 'transcript', items: view.items });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const transcript = page.nodes.get('transcript')!;
  const badges = badgesUnder(transcript);
  assert.equal(badges.length, 1);
  assert.equal(badges[0]!.getAttribute('data-state'), 'verified-private');
  badges[0]!.click();
  const shown = textOf(transcript);
  assert.match(shown, /This shows the check made when the answer arrived\./);
  assert.match(shown, /The full attestation is kept only while the window that checked it is open\./);
  assert.ok(!under(transcript).some((node) => node.tagName === 'button' && (node.textContent === 'Check again' || node.textContent === 'Show full attestation')), 'a replayed badge has neither button');
});

test('two copies of one answer\'s record, one Verified private model and one Not verified, merge to Not verified in both orders, whichever copy is newer', () => {
  const strong = [record(KEY, 'verified-private', '2026-11-18T10:00:00.000Z')];
  const weak = [record(KEY, 'not-verified', '2026-11-18T09:00:00.000Z', ['It could not be checked in time. The badge changes if the check finishes later.'])];
  for (const [newer, older] of [['2026-11-18T12:00:00.000Z', '2026-11-18T11:00:00.000Z'], ['2026-11-18T11:00:00.000Z', '2026-11-18T12:00:00.000Z']]) {
    const a = metaWith(newer!, { trust: strong });
    const b = metaWith(older!, { trust: weak });
    for (const merged of [mergeMeta(a, b), mergeMeta(b, a)]) {
      assert.equal(merged.trust?.length, 1);
      assert.equal(merged.trust![0]!.state, 'not-verified', `newer ${newer}`);
    }
  }
  // Keys only one copy holds are all kept.
  const other = record(trustRecordKey('Another answer.'), 'verified-private', '2026-11-18T10:00:00.000Z');
  const merged = mergeMeta(metaWith('2026-11-18T12:00:00.000Z', { trust: strong }), metaWith('2026-11-18T11:00:00.000Z', { trust: [other] }));
  assert.deepEqual(merged.trust!.map((entry) => entry.key).sort(), [KEY, other.key].sort());
});

test('a record with an unknown state or a numeric reasons is dropped on read, and that answer shows no badge; 250 records keep the newest 200', () => {
  const good = record(KEY, 'model-verified', '2026-11-18T10:00:00.000Z');
  const read = validMeta(metaWith('2026-11-18T12:00:00.000Z', { trust: [good, { ...good, key: trustRecordKey('b'), state: 'verified' } as never, { ...good, key: trustRecordKey('c'), reasons: 3 } as never, { ...good, key: 'short' } as never, { ...good, key: trustRecordKey('d'), extra: 1 } as never] }), 'conv-trust-merge-1');
  assert.deepEqual(read?.trust?.map((entry) => entry.key), [KEY]);
  assert.equal(parseTrustRecord({ ...good, state: 'verified' }), undefined);
  assert.equal(parseTrustRecord({ ...good, reasons: 3 }), undefined);
  assert.equal(parseTrustRecord({ ...good, reasons: ['Signed by 0x' + 'ab'.repeat(20)] }), undefined, 'a reason holding an address is refused');
  assert.equal(parseTrustRecord({ ...good, at: 'yesterday' }), undefined);
  assert.equal(validMeta(metaWith('2026-11-18T12:00:00.000Z', { trust: 'all verified' as never }), 'conv-trust-merge-1')?.trust, undefined);
  const many = Array.from({ length: 250 }, (_, index) => record(trustRecordKey(`answer ${String(index)}`), 'not-verified', new Date(Date.UTC(2026, 10, 18, 0, index)).toISOString()));
  const kept = validMeta(metaWith('2026-11-18T12:00:00.000Z', { trust: many }), 'conv-trust-merge-1')!.trust!;
  assert.equal(kept.length, MAX_TRUST_RECORDS);
  assert.equal(kept[0]!.key, many[50]!.key, 'the oldest 50 went');
  assert.equal(kept.at(-1)!.key, many[249]!.key);
  // The view attaches nothing to an answer with no record.
  const items = entriesToView({ main: [{ id: 'e1', thread: 't', parent: null, at: '', writer: 'w', role: 'assistant', body: { text: 'no record' } }] as never, branches: [] }, { trustFor: () => undefined });
  assert.deepEqual(items, [{ kind: 'assistant', text: 'no record' }]);
});

test('a record keeps reasons in plain words with no address or fingerprint, and 200 records pass the secret scanner', () => {
  const kept = trustRecordOf('An answer.', { state: 'not-verified', reasons: [`The check failed: The response is signed by 0x${'ab'.repeat(20)}, but no quote binds ${'cd'.repeat(32)}.`] }, new Date('2026-11-18T10:00:00.000Z'));
  assert.equal(kept.reasons[0], 'The check failed: The response is signed by (hidden), but no quote binds (hidden).');
  assert.ok(parseTrustRecord(kept) !== undefined, 'what is written reads back');
  const records = Array.from({ length: 200 }, (_, index) => trustRecordOf(`answer ${String(index)}`, { state: TRUST_BADGE_STATES[index % 3]!, reasons: [TRUST_BADGE_TEXT.checking, TRUST_BADGE_TEXT.timedOut, `${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.stale}`] }, new Date(Date.UTC(2026, 10, 18, 0, index))));
  const meta = metaWith('2026-11-18T12:00:00.000Z', { trust: records });
  assert.deepEqual(findSecrets(meta), []);
  assert.ok(!/[0-9a-f]{64}/i.test(JSON.stringify(records)), 'no 64-hex string in any record');
});

test('a meta with both a label and trust records merges each by its own rule', () => {
  const confidential = { mark: [CONFIDENTIAL] };
  const publicLabel = { mark: [{ ...CONFIDENTIAL, level: 'Public' }] };
  const a = metaWith('2026-11-18T12:00:00.000Z', { label: publicLabel as never, trust: [record(KEY, 'verified-private', '2026-11-18T10:00:00.000Z')] });
  const b = metaWith('2026-11-18T11:00:00.000Z', { label: confidential as never, trust: [record(KEY, 'model-verified', '2026-11-18T09:00:00.000Z')] });
  for (const merged of [mergeMeta(a, b), mergeMeta(b, a)]) {
    const read = chatLabelOf(merged);
    assert.ok(read.kind === 'mark' && read.mark.length === 1 && read.mark[0]!.level === 'Confidential', 'the label joins upward');
    assert.equal(merged.trust![0]!.state, 'model-verified', 'the badge keeps the weaker state');
  }
});

test('a webview reload in the same window replays the logged badges, so the settled state of each run is drawn', async () => {
  const log = new ConversationLog();
  log.add({ type: 'assistant-start', model: 'tee-model', privacy: PRIVATE });
  log.add({ type: 'assistant-done', runId: 'run-1-aaaaaa', usage: { inputTokens: 1, outputTokens: 1 } });
  log.add({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: NOT_VERIFIED });
  log.add({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: { ...NOT_VERIFIED, state: 'verified-private', title: TRUST_BADGE_TITLES['verified-private'], reasons: [] } });
  const page = chatPage();
  for (const message of log.replay(new Map(), new Map())) page.send(message);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const badges = badgesUnder(page.nodes.get('transcript')!);
  assert.equal(badges.length, 1);
  assert.equal(badges[0]!.getAttribute('data-state'), 'verified-private');
});

test('a badge kept for one answer is replaced by a newer result of the same answer, and never raised by another run\'s answer with the same text', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-keep-'));
  const store = threadStoreFor(root);
  const chat = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  chat.gateHost = testGateHost();
  await chat.send({ text: 'hello', client: plainClient() as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  await chat.trustRecorded();
  const id = chat.id;
  const key = trustRecordKey('ok');
  assert.equal((await store.meta(id))?.trust?.find((entry) => entry.key === key)?.state, 'not-verified');
  await store.recordTrust(id, record(key, 'verified-private', '2026-11-18T10:00:00.000Z'));
  assert.equal((await store.meta(id))?.trust?.find((entry) => entry.key === key)?.state, 'not-verified', 'weaker wins for another writer');
  await store.recordTrust(id, record(key, 'verified-private', '2026-11-18T10:00:00.000Z'), 'replace');
  assert.equal((await store.meta(id))?.trust?.find((entry) => entry.key === key)?.state, 'verified-private', 'the same answer\'s newer result replaces it');
  const before = (await store.meta(id))!.lastUsedAt;
  await store.recordTrust(id, record(trustRecordKey('another'), 'not-verified', '2026-11-18T11:00:00.000Z'));
  assert.equal((await store.meta(id))!.lastUsedAt, before, 'keeping a badge is not using the chat');
});

// ---- PR #89 last review, minor finding 2: no attested answer goes unrecorded ----

test('review 89 minor 2: an attested answer with no signature id, or one read without hashes, records route.attestation-checked as unavailable with a plain reason', async () => {
  const { UNCHECKABLE_ANSWER_REASONS, sessionRouteFrom, withSessionRoute } = await import('../gate/sessionMark');
  const { testGateRuntime } = await import('./helpers/gatedRuns');
  const records: Array<{ authorizations: Array<{ policy: { name: string } }>; unmapped: { nearAi: { attestation?: string; reason?: string } }; message?: string }> = [];
  const runtime = testGateRuntime();
  const route = sessionRouteFrom({ ...runtime, sink: { record: (entry: unknown) => { records.push(entry as never); } } }, { markOf: () => [CONFIDENTIAL] });
  // A NEAR AI Cloud stream with no chat id (no inference id to check), over the pinned connection.
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'tee-model' }] });
    if (method === 'GET' && url.pathname.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } }] });
    if (method === 'POST' && JSON.parse(String(init?.body)).stream === false) return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(chunk({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const fact = (): ConnectionBindingFact => ({ state: 'bound', host: NEAR_URL, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) });
  const client = new NearAiClient({ baseUrl: NEAR_URL, apiKey: 'test-key', fetchFn, route: 'near', binding: { current: fact, refresh: async () => fact(), markNotBound: () => undefined, fetchFor: () => fetchFn }, maxRetries: 0 });
  await client.listModels();
  const checked = () => records.filter((entry) => entry.authorizations[0]?.policy.name === 'route.attestation-checked');
  await withSessionRoute(route, async () => { for await (const event of client.streamCompletion('tee-model', [{ role: 'user', content: 'hi' }], [])) void event; });
  assert.equal(checked().length, 1, 'the answer is recorded');
  assert.equal(checked()[0]!.unmapped.nearAi.attestation, 'unavailable');
  assert.equal(JSON.stringify(checked()[0]).includes(UNCHECKABLE_ANSWER_REASONS['no-signature-id']), true, 'with the plain reason');
  await withSessionRoute(route, () => client.completeOnce('tee-model', [{ role: 'user', content: 'hi' }], { maxTokens: 16 }));
  assert.equal(checked().length, 2, 'a non-streamed answer is recorded too');
  assert.equal(JSON.stringify(checked()[1]).includes(UNCHECKABLE_ANSWER_REASONS['no-hashes']), true);
  assert.equal(route.attestation.failed, false, 'nothing changed');
});

// ---- PR #95 review (first round, 4 minor), each with a test ----

test('review 95.1: when Check again throws, the badge is posted again with the reason it could not be checked, so the page leaves "Checking again"', async () => {
  const { checkBadgeAgain } = await import('../services/trustDetails');
  const posted: Array<Record<string, unknown>> = [];
  const shown = { state: 'model-verified' as const, title: TRUST_BADGE_TITLES['model-verified'], explanation: TRUST_BADGE_TEXT.explanation['model-verified'], reasons: [], helpers: TRUST_BADGE_TEXT.helpers };
  const agent = {
    async checkAgain(): Promise<TrustBadge | undefined> { throw new Error('socket hang up'); },
    badgeWithNotice: (_runId: string, reason: string): TrustBadge => ({ ...shown, reasons: [reason] })
  };
  await checkBadgeAgain({ agent, post: (message) => posted.push(message) }, 'run-1-aaaaaa', (error) => (error as Error).message);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.type, 'trust-badge');
  assert.deepEqual((posted[0]!.badge as TrustBadge).reasons, [`${TRUST_BADGE_TEXT.unavailable} socket hang up`]);
  assert.equal((posted[0]!.badge as TrustBadge).state, 'model-verified', 'the state the checks that ran proved');
  // In the real page the details are drawn again, so Check again is ready again.
  const page = chatPage();
  const reply = await answerOn(page, 'run-1-aaaaaa');
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: shown });
  badgesUnder(reply)[0]!.click();
  under(reply).find((node) => node.tagName === 'button' && node.textContent === 'Check again')!.click();
  assert.ok(under(reply).some((node) => node.textContent === 'Checking again…'));
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: posted[0]!.badge });
  assert.ok(!under(reply).some((node) => node.textContent === 'Checking again…'), 'no longer stuck');
  assert.match(textOf(reply), /socket hang up/);
  // With no badge for the run, a plain notice says why.
  const none: Array<Record<string, unknown>> = [];
  await checkBadgeAgain({ agent: { ...agent, badgeWithNotice: () => undefined }, post: (message) => none.push(message) }, 'run-1-aaaaaa', (error) => (error as Error).message);
  assert.deepEqual(none, [{ type: 'notice', text: `${TRUST_BADGE_TEXT.unavailable} socket hang up` }]);
  // The session's own badgeWithNotice keeps the shown badge and adds the reason once.
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-notice-'));
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'));
  await conversation.send({ text: 'hi', client: plainClient() as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  const runId = [...(conversation as unknown as { verifiable: Map<string, unknown> }).verifiable.keys()][0]!;
  const noticed = conversation.badgeWithNotice(runId, 'It could not be checked: x');
  assert.equal(noticed?.reasons.filter((reason) => reason === 'It could not be checked: x').length, 1);
  assert.equal(conversation.badgeWithNotice('run-9-ffffff', 'x'), undefined);
});

test('review 95.2: a replayed badge never says a check may still finish: the in-time reason is reworded and Checking now is left out', () => {
  const kept = trustRecordOf('An answer.', { state: 'not-verified', reasons: [TRUST_BADGE_TEXT.timedOut, TRUST_BADGE_TEXT.checking] }, new Date('2026-11-18T10:00:00.000Z'));
  const replayed = trustBadgeFromRecord(kept);
  assert.ok(!replayed.reasons.includes(TRUST_BADGE_TEXT.timedOut));
  assert.ok(!replayed.reasons.includes(TRUST_BADGE_TEXT.checking));
  assert.deepEqual(replayed.reasons, [TRUST_BADGE_TEXT.timedOutReplayed, TRUST_BADGE_TEXT.replayed]);
  assert.doesNotMatch(replayed.reasons.join(' '), /changes if the check finishes later/);
});

test('review 95.3: failed badge checks dropped past FAILED_CHECKS_KEPT still count, so later badges stay Not verified and say a new chat is needed', async () => {
  const { FAILED_CHECKS_KEPT } = await import('../services/agentSession');
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-drop-'));
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'));
  await conversation.send({ text: 'hi', client: plainClient() as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  const internals = conversation as unknown as { verifiable: Map<string, { model: string; client: unknown }>; badgeFailures: Map<string, unknown>; noteBadgeCheck(runId: string, entry: unknown, evidence: unknown, result: unknown): void };
  const [runId, entry] = [...internals.verifiable][0]!;
  const failed = { outcome: 'failed', summary: 'The signature does not match the signing address.', checks: {}, notChecked: [] };
  for (let index = 0; index <= FAILED_CHECKS_KEPT; index += 1) internals.noteBadgeCheck(runId, entry, { chatId: `chatcmpl-old-${String(index)}`, requestHash: 'a', responseHash: 'b' }, failed);
  assert.equal(internals.badgeFailures.size, FAILED_CHECKS_KEPT, 'one was dropped past the bound');
  // Every kept failure is checked again and passes: the dropped one still holds.
  internals.badgeFailures.clear();
  const badge = conversation.trustBadge(runId)!;
  assert.ok(badge.reasons.includes(TRUST_BADGE_TEXT.earlierFailedLost), JSON.stringify(badge.reasons));
  assert.equal(badge.state, 'not-verified');
  conversation.reset();
  assert.equal((conversation as unknown as { droppedBadgeFailures: number }).droppedBadgeFailures, 0, 'a new chat starts clean');
});

test('review 95.4: a chat\'s badge records are capped in bytes as well as in number, the oldest dropped first', () => {
  const long = 'x'.repeat(390);
  const many = Array.from({ length: MAX_TRUST_RECORDS }, (_, index) => trustRecordOf(`answer ${String(index)}`, { state: 'not-verified', reasons: Array.from({ length: 12 }, () => long) }, new Date(Date.UTC(2026, 10, 18, 0, index))));
  assert.ok(new TextEncoder().encode(JSON.stringify(many)).length > MAX_TRUST_BYTES, 'the fixture is over the cap');
  const kept = mergeTrustRecords(many, []);
  assert.ok(new TextEncoder().encode(JSON.stringify(kept)).length <= MAX_TRUST_BYTES);
  assert.ok(kept.length > 0 && kept.length < MAX_TRUST_RECORDS);
  assert.equal(kept.at(-1)!.key, many.at(-1)!.key, 'the newest is kept');
  assert.equal(kept[0]!.key, many[MAX_TRUST_RECORDS - kept.length]!.key, 'the oldest went first');
  // Read back from a meta, the same cap holds.
  const read = validMeta(metaWith('2026-11-18T12:00:00.000Z', { trust: many }), 'conv-trust-merge-1')!.trust!;
  assert.deepEqual(read.map((record) => record.key), kept.map((record) => record.key));
  // Small records are not touched by the byte cap.
  const small = many.map((record) => ({ ...record, reasons: [] }));
  assert.equal(mergeTrustRecords(small, []).length, MAX_TRUST_RECORDS);
});

// ---- PR #95 CI: no badge write outlives the conversation ----

test('PR 95 CI: closing a conversation while its answer\'s check is still running writes nothing afterwards, posts nothing, and clears its timeout', async () => {
  const near = await cloud('bound');
  near.mode = 'hang';
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-close-'));
  const store = threadStoreFor(root);
  const posted: Array<{ type: string }> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'), undefined, store);
  conversation.gateHost = testGateHost();
  const timers: Array<{ run: () => void; cleared: boolean }> = [];
  conversation.badgeTimers = { set: (run) => { timers.push({ run, cleared: false }); return timers.length - 1; }, clear: (handle) => { timers[handle as number]!.cleared = true; } };
  await conversation.send({ text: 'hello', client: near.client, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  const id = conversation.id;
  assert.equal(posted.filter((message) => message.type === 'trust-badge').length, 1, 'Checking now');
  // Every write the store gets from now on is counted.
  let writesAfterClose = 0;
  const recordTrust = store.recordTrust.bind(store);
  store.recordTrust = async (...args: Parameters<ThreadStore['recordTrust']>) => { writesAfterClose += 1; return recordTrust(...args); };
  await conversation.close();
  const after = posted.length;
  assert.equal(timers[0]!.cleared, true, 'the badge timeout was cleared');
  near.mode = 'valid';
  near.release();
  await settle();
  timers[0]!.run();
  await settle();
  assert.equal(writesAfterClose, 0, 'the late result wrote nothing');
  assert.equal(posted.length, after, 'and posted nothing');
  assert.equal((await store.meta(id))?.trust, undefined);
});

test('PR 95 CI: a badge settled when the run ends is saved before send returns, so nothing of the run is still being written after it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-settled-'));
  const store = threadStoreFor(root);
  let inFlight = 0;
  const recordTrust = store.recordTrust.bind(store);
  store.recordTrust = async (...args: Parameters<ThreadStore['recordTrust']>) => { inFlight += 1; try { return await recordTrust(...args); } finally { inFlight -= 1; } };
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  conversation.gateHost = testGateHost();
  await conversation.send({ text: 'hello', client: plainClient() as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  assert.equal(inFlight, 0, 'no record write is still running when send returns');
  assert.equal((await store.meta(conversation.id))?.trust?.length, 1, 'the not-checked badge is already kept');
  await conversation.close();
  // A conversation used again after close keeps its badges again.
  await conversation.send({ text: 'again', client: plainClient(undefined) as never, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  assert.equal((await store.meta(conversation.id))?.trust?.length, 1);
});

// ---- PR #95 review round 3 ----

test('review 95.r3.1: after a new chat, an old run id answers neither trustBadge nor Check again, and nothing is written to either thread', async () => {
  const near = await cloud('bound');
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-reset-'));
  const store = threadStoreFor(root);
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  conversation.gateHost = testGateHost();
  await conversation.send({ text: 'hello', client: near.client, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  await settle();
  await conversation.trustRecorded();
  const oldThread = conversation.id;
  const oldRun = [...(conversation as unknown as { verifiable: Map<string, unknown> }).verifiable.keys()][0]!;
  assert.ok(conversation.trustBadge(oldRun) !== undefined);
  conversation.reset();
  const newThread = conversation.id;
  assert.notEqual(newThread, oldThread);
  let writes = 0;
  const recordTrust = store.recordTrust.bind(store);
  store.recordTrust = async (...args: Parameters<ThreadStore['recordTrust']>) => { writes += 1; return recordTrust(...args); };
  const signaturesBefore = near.signatureCount();
  assert.equal(conversation.trustBadge(oldRun), undefined);
  assert.equal(conversation.trustDetails(oldRun), undefined);
  assert.equal(await conversation.checkAgain(oldRun), undefined);
  assert.equal(conversation.badgeWithNotice(oldRun, 'x'), undefined);
  await conversation.trustRecorded();
  assert.equal(writes, 0, 'nothing written to either thread');
  assert.equal(near.signatureCount(), signaturesBefore, 'no check was made for the old answer');
  assert.equal((await store.meta(newThread))?.trust, undefined);
});

test('review 95.r3.2: the chat panel\'s close path waits for the badge record being written, and the window\'s shutdown closes every chat still open', async () => {
  const { closeAllConversations, closeConversation, trackConversation } = await import('../services/agentSession');
  const near = await cloud('bound');
  near.mode = 'hang';
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-badge-shutdown-'));
  const store = threadStoreFor(root);
  let started!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  let finished = false;
  const recordTrust = store.recordTrust.bind(store);
  store.recordTrust = async (...args: Parameters<ThreadStore['recordTrust']>) => {
    finished = false;
    started();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await recordTrust(...args);
    finished = true;
  };
  const make = () => { const chat = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store); chat.gateHost = testGateHost(); trackConversation(chat); return chat; };
  // A tab's conversation whose check settles after the run: its record is being written when the panel closes it.
  const tab = make();
  await tab.send({ text: 'hello', client: near.client, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  near.mode = 'valid';
  near.release();
  await writing;
  assert.equal(finished, false, 'the write is in progress');
  await closeConversation(tab);
  assert.equal(finished, true, 'closeConversation returned only after the write finished');
  // The window's shutdown: a chat still open (another tab) is closed, and shutdown waits for the write it has in progress too.
  const near2 = await cloud('bound');
  near2.mode = 'hang';
  const other = make();
  await other.send({ text: 'hello', client: near2.client, model: 'tee-model', privacy: PRIVATE, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  const writing2 = new Promise<void>((resolve) => { started = resolve; });
  near2.mode = 'valid';
  near2.release();
  await writing2;
  assert.equal(finished, false, 'the second chat\'s write is in progress');
  await closeAllConversations();
  assert.equal(finished, true, 'shutdown returned only after it finished');
  let writesAfter = 0;
  store.recordTrust = async () => { writesAfter += 1; };
  await settle();
  assert.equal(writesAfter, 0, 'nothing is written after the shutdown');
  // Every production close path goes through it.
  const chatSource = readFileSync(path.join(ROOT, 'src', 'services', 'chat.ts'), 'utf8');
  assert.equal((chatSource.match(/agent\?\.dispose\(\)/g) ?? []).length, 0, 'no chat panel path disposes a conversation without closing it');
  assert.equal((chatSource.match(/void closeAgentConversation\(tab\.agent\)/g) ?? []).length, 3, 'a closed tab, a tab closing after its run, and a closed panel or view');
  assert.match(chatSource, /trackConversation\(conversation\)/);
  const extension = readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /export async function deactivate\(\): Promise<void> \{[\s\S]*?await closeAllConversations\(\);[\s\S]*?await flushSyncOnClose\(\);/);
});
