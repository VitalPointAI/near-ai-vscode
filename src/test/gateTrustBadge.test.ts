// The trust badge on each cloud answer (CLAS-08, D-56): one pure function picks one of three states from the checks that ran, the page draws it under its
// own run's answer, the session checks each TEE answer once in the background and never leaves a badge at "Checking now", and the badge explains itself.
// Attestation tests use the recorded fixtures and fake fetches; nothing reaches the network and no key is read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BADGE_CHECK_TIMEOUT_MS, TRUST_BADGE_STATES, TRUST_BADGE_TEXT, TRUST_BADGE_TITLES, TRUST_VERIFICATIONS, trustBadgeFor, trustBadgeRank,
  type TrustBadge, type TrustBadgeFacts, type TrustVerification
} from '../domain/gate/trustBadge';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import type { Label } from '../domain/gate/labels';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation } from '../services/agentSession';
import { NearAiClient, type AgentMessage, type CompletionEvent, type ToolCall } from '../services/nearAiClient';
import type { ConnectionBindingSource } from '../services/connectionBinding';
import { TranscriptStore } from '../services/transcripts';
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
  const binding: ConnectionBindingSource | undefined = connection === 'none' ? undefined : { current: fact, refresh: async () => fact(), markNotBound: () => undefined, fetchFor: () => fetchFn };
  const client = new NearAiClient({ baseUrl: NEAR_URL, apiKey: 'test-key', fetchFn, route: 'near', ...(binding ? { binding } : {}), maxRetries: 0, attestationTrust: { trustedRoot: TEST_ROOT } });
  await client.listModels();
  return {
    client, content, signatures, signatureCount: () => [...signatures.values()].reduce((sum, count) => sum + count, 0), reportGets: () => reports,
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

test('at org/Public a bound fact alone does not prove the connection: the request was not pinned, so Model verified, connection not proven, with the reason', async () => {
  const near = await cloud('bound');
  const chat = badgeChat();
  await send(chat, near.client);
  await settle();
  const last = chat.badges().at(-1)!.badge;
  assert.equal(last.state, 'model-verified');
  assert.ok(last.reasons.includes(`${TRUST_BADGE_TEXT.connectionNotProven} ${TRUST_BADGE_TEXT.connection.stale}`), JSON.stringify(last.reasons));
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
  assert.equal(late.badge.state, 'model-verified', 'the late result updates the badge');
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
  assert.equal(again?.state, 'model-verified');
  assert.equal(chat.conversation.trustBadge(second.runId)?.state, 'model-verified');
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
  assert.equal(settledA.at(-1)!.badge.state, 'model-verified');
  assert.equal(settledB.at(-1)!.badge.state, 'model-verified');
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
