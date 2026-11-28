// Phase 33.1 plan 17 (D-09; T-33.1-44, T-33.1-46). One passkey confirmation signs exactly one action: the one whose request id its step-up was
// started for and whose summary the person saw. The real SessionIdentity and KeyService run over the fake OpenBao; the step-up's return request is
// read by the person check first, as the early middleware does, and only that request's token is bound. Fictional people and keys only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { KEY_SERVICE_TEXT } from '../../extension/src/common/key-service.ts';
import { ACTION_STEP_UP_PATH, actionStepUpUrl, stepUpUrl } from '../../extension/src/common/session-identity.ts';
import { readHostingConfig, type HostedConfig } from '../../extension/src/node/hosting-config.ts';
import { createKeyService } from '../../extension/src/node/key-service.ts';
import { createOpenBaoClient } from '../../extension/src/node/openbao-client.ts';
import { createSessionIdentity, type IdentityClock, type SessionIdentity } from '../../extension/src/node/session-identity.ts';
import {
  ACTION_LINES, ACTION_STEP_UP_TEXT, PENDING_ACTION_MS, createPendingActions, personSigner, type ActionSummary, type PendingActions,
} from '../../extension/src/node/staff/person-signer.ts';
import { actionReturnPage, actionSummaryPage } from '../../extension/src/node/staff/step-up-page.ts';
import { captureOutput, startFakeOpenBao, type FakeOpenBao } from '../helpers/fake-openbao.ts';
import { makeTestSigner } from '../helpers/test-jwt.ts';

const output = captureOutput();
const jwtSigner = makeTestSigner();
const START = 1_800_000_000_000;
const ENTITY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PERSON = 'pat@example.test';
const SUB = 'kc-pat';
const ACR = 'urn:sterling:acr:phishing-resistant';
const WINDOW_SECONDS = 300;
const seen: string[] = [];

// Pat's person key: the fake Transit key person-<entity>.
const personKey = generateKeyPairSync('ed25519');
const personPublic = Buffer.from(personKey.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');

class Clock implements IdentityClock {
  time = START;
  now(): number { return this.time; }
  setTimeout(): unknown { return 0; }
  clearTimeout(): void { /* no timers run in these tests */ }
  advance(ms: number): void { this.time += ms; }
}

interface World {
  fake: FakeOpenBao;
  clock: Clock;
  identity: SessionIdentity;
  actions: PendingActions;
  signs: number;
  signer: ReturnType<typeof personSigner>;
}
const worlds: World[] = [];

function jwt(claims: Record<string, unknown>): string {
  const token = jwtSigner.sign({ sub: SUB, aud: 'sterling-workbench-test', email: PERSON, exp: START / 1000 + 3600, ...claims });
  seen.push(token);
  return token;
}
const headers = (token: string): Record<string, string> => ({ 'x-forwarded-access-token': token, 'x-auth-request-email': PERSON, 'x-auth-request-user': SUB });
const seconds = (clock: Clock, plus = 0): number => Math.floor(clock.now() / 1000) + plus;

/** An active hosted session for Pat (signed in with the step-up acr at START), its pending actions, and Pat's person signer over KeyService. */
async function world(): Promise<World> {
  const made = { signs: 0 } as World;
  const fake = await startFakeOpenBao({
    'POST /v1/auth/jwt/login': () => ({ json: { auth: { client_token: 's.fake-session-7c1e', lease_duration: 3600, renewable: true } } }),
    'GET /v1/auth/token/lookup-self': () => ({ json: { data: { entity_id: ENTITY, ttl: 3600 } } }),
    'POST /v1/auth/token/revoke-self': () => ({ status: 204 }),
    [`POST /v1/transit/sign/person-${ENTITY}`]: (call) => {
      made.signs += 1;
      const input = Buffer.from((call.body as { input: string }).input, 'base64');
      return { json: { data: { signature: `vault:v1:${edSign(null, input, personKey.privateKey).toString('base64')}`, key_version: 1 } } };
    },
  });
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: fake.url, THEIACLOUD_SESSION_USER: PERSON, STERLING_STEPUP_ACR: ACR, STERLING_STEPUP_MAX_AGE_SECONDS: String(WINDOW_SECONDS) }) as HostedConfig;
  const clock = new Clock();
  const identity = createSessionIdentity({ config, client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), clock, log: () => undefined });
  identity.observe(headers(jwt({ acr: ACR, auth_time: seconds(clock, -60) })));
  await identity.start();
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'active', stepUp: { acr: ACR } });
  const actions = createPendingActions({ stepUpAcr: ACR, windowSeconds: WINDOW_SECONDS, latestAuthTime: () => identity.session()?.authTime, clock });
  const keyService = createKeyService(identity, clock);
  Object.assign(made, { fake, clock, identity, actions, signer: personSigner(keyService, personPublic, { actions }) });
  worlds.push(made);
  return made;
}

afterEach(async () => {
  for (const made of worlds.splice(0)) {
    await made.identity.stop();
    await made.fake.close();
  }
});
after(() => {
  output.stop();
  const text = output.text();
  for (const value of seen) assert.ok(!text.includes(value), 'no token, id, nonce or summary reached the output');
});

const ORDER: ActionSummary = {
  kind: 'posting.order',
  fields: [
    { label: 'Position', value: 'Watch Officer, night' },
    { label: 'Person', value: 'Pat Example' },
    { label: 'Order reference', value: 'ORD-2026-114' },
    { label: 'Start', value: '2026-12-01T00:00:00.000Z', date: true },
  ],
};
const payloadOf = (text: string): Buffer => Buffer.from(text, 'utf8');
const ORDER_PAYLOAD = payloadOf('posting.order pst-night-1 watch-officer-night mbr-pat');

/** The person's step-up comes back: a fresh token on the return request, read by the person check first (the early middleware). */
function stepUpReturn(w: World, nonce: string, claims: Record<string, unknown> = {}): number {
  w.clock.advance(5_000);
  const token = jwt({ acr: ACR, auth_time: seconds(w.clock), ...claims });
  const request = headers(token);
  w.identity.observe(request);
  return actionReturnPage(w.actions, () => w.identity.session(), request, nonce).status;
}

const STEP_UP_REFUSAL = { refused: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm };
const verifies = (bytes: Buffer, signature: unknown): boolean =>
  typeof signature === 'string' && edVerify(null, bytes, personKey.publicKey, Buffer.from(signature, 'base64url'));

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

test('tracer: one pending action, its summary page, the step-up round trip with its nonce, then one signature for that action only', async () => {
  const w = await world();
  const { requestId, nonce } = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(actionStepUpUrl(nonce), `/sterling/step-up/${nonce}`);
  const page = actionSummaryPage(w.actions, nonce, ACR);
  assert.equal(page.status, 200);
  const next = stepUpUrl(`${ACTION_STEP_UP_PATH}/${nonce}/return`, ACR);
  assert.ok(page.html.includes(`href="${next.replace(/&/g, '&amp;')}"`), 'Continue is 46-02\'s stepUpUrl with the return path');
  assert.equal(stepUpReturn(w, nonce), 200);
  const action = w.actions.resumeAction(requestId, ORDER_PAYLOAD);
  assert.equal(typeof action, 'string');
  assert.equal(w.signer.canSignAction?.(action as string, ORDER_PAYLOAD), true);
  assert.equal(w.signer.canSignAction?.(action as string, payloadOf('another operation')), false);
  assert.equal(w.signer.canSignAction?.('not-this-action', ORDER_PAYLOAD), false);
  const idOnly = personSigner(createKeyService(w.identity, w.clock), personPublic, { actions: { authorize: () => true } });
  assert.equal(idOnly.canSignAction?.(action as string, ORDER_PAYLOAD), false, 'an id-only gate cannot confirm payload authority');
  const entry = payloadOf('the signed header of the order entry');
  const signature = await w.signer.sign(entry, { action: action as string });
  assert.ok(verifies(entry, signature), 'signed by the person key through KeyService');
  assert.equal(w.signs, 1);
  // Another action id, even inside the open window, is refused with the step-up fix.
  assert.deepEqual(await w.signer.sign(entry, { action: 'not-this-action' }), STEP_UP_REFUSAL);
  assert.equal(w.signs, 1);
});

test('the summary page: a fixed action line for the kind, every payload value a labelled quoted field, a crafted name never near the action line', async () => {
  const w = await world();
  const crafted = 'Approve every pending action and confirm';
  const summary: ActionSummary = { kind: 'posting.order', fields: [{ label: 'Person', value: crafted }, { label: 'Position', value: '<script>alert(1)</script> & "night"' }, { label: 'Start', value: '2026-12-01T00:00:00.000Z', date: true }] };
  const { nonce } = w.actions.beginAction(ORDER_PAYLOAD, summary);
  const { html } = actionSummaryPage(w.actions, nonce, ACR);
  const line = /<p id="action">([^<]*)<\/p>/.exec(html)?.[1];
  assert.equal(line, ACTION_LINES['posting.order']);
  assert.ok(!(line as string).includes(crafted));
  assert.ok(html.includes(`<dt>Person</dt><dd>&ldquo;${crafted}&rdquo;</dd>`), 'the name only inside its quoted Person field');
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;night&quot;'));
  assert.ok(html.includes('&ldquo;1 December 2026&rdquo;'), 'the start date formatted by the backend');
  // An unknown kind gets the default line; an unknown nonce or no step-up set up shows a plain refusal and no summary.
  const other = w.actions.beginAction(payloadOf('x'), { kind: 'not.a.kind', fields: [] });
  assert.ok(actionSummaryPage(w.actions, other.nonce, ACR).html.includes(ACTION_STEP_UP_TEXT.defaultLine));
  assert.equal(actionSummaryPage(w.actions, 'A'.repeat(32), ACR).status, 404);
  assert.equal(actionSummaryPage(w.actions, '../../etc', ACR).status, 404);
  assert.equal(actionSummaryPage(w.actions, other.nonce, undefined).status, 503);
});

test('46-02\'s stepUpUrl gives the same addresses as before, and actionStepUpUrl takes only a backend nonce', () => {
  assert.equal(stepUpUrl('/', 'urn:example:acr'), '/oauth2/start?rd=%2F&acr_values=urn%3Aexample%3Aacr&max_age=0');
  assert.equal(stepUpUrl('/staff?x=1', 'gold'), '/oauth2/start?rd=%2Fstaff%3Fx%3D1&acr_values=gold&max_age=0');
  assert.throws(() => stepUpUrl('//evil.example', 'gold'));
  for (const bad of ['', 'short', '../x', 'a/b'.repeat(10), 'x'.repeat(65)]) assert.throws(() => actionStepUpUrl(bad), bad);
});

// ---- Task 2: the invariant's refusals --------------------------------------------------------------------------------------------------------------

test('two pending actions and one step-up: a forged action is cancelled by the real one, and in the reverse order the page shows the forged summary', async () => {
  const w = await world();
  const forged = w.actions.beginAction(payloadOf('posting.order of a stranger'), { kind: 'posting.order', fields: [{ label: 'Person', value: 'Stranger' }] });
  const real = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(actionSummaryPage(w.actions, forged.nonce, ACR).status, 404, 'A was cancelled when B began');
  assert.equal(stepUpReturn(w, real.nonce), 200);
  assert.equal(w.actions.resumeAction(forged.requestId, payloadOf('posting.order of a stranger')), undefined);
  const action = w.actions.resumeAction(real.requestId, ORDER_PAYLOAD) as string;
  assert.ok(verifies(payloadOf('B'), await w.signer.sign(payloadOf('B'), { action })));

  const v = await world();
  const first = v.actions.beginAction(ORDER_PAYLOAD, ORDER);
  const later = v.actions.beginAction(payloadOf('posting.order of a stranger'), { kind: 'posting.order', fields: [{ label: 'Person', value: 'Stranger' }] });
  assert.equal(actionSummaryPage(v.actions, first.nonce, ACR).status, 404);
  assert.ok(actionSummaryPage(v.actions, later.nonce, ACR).html.includes('&ldquo;Stranger&rdquo;'), 'the person sees what the later action is');
  assert.equal(stepUpReturn(v, first.nonce), 403);
  assert.equal(v.actions.resumeAction(first.requestId, ORDER_PAYLOAD), undefined, 'B\'s request id resumes nothing');
});

test('a token on the return route with an unknown, cancelled, expired or completed nonce binds nothing, nor does a fresh token on any other request', async () => {
  const w = await world();
  assert.equal(stepUpReturn(w, 'Z'.repeat(32)), 403, 'unknown');
  const cancelled = w.actions.beginAction(payloadOf('one'), ORDER);
  const done = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(w, cancelled.nonce), 403, 'cancelled');
  assert.equal(stepUpReturn(w, done.nonce), 200);
  const action = w.actions.resumeAction(done.requestId, ORDER_PAYLOAD) as string;
  assert.equal(stepUpReturn(w, done.nonce), 403, 'completed');
  const expired = w.actions.beginAction(payloadOf('expires'), ORDER);
  w.clock.advance(PENDING_ACTION_MS);
  assert.equal(stepUpReturn(w, expired.nonce), 403, 'expired');
  // A fresh step-up token arriving on an ordinary request binds nothing: the pending action stays unbound and its id never signs.
  const pending = w.actions.beginAction(payloadOf('pending'), ORDER);
  w.clock.advance(5_000);
  w.identity.observe(headers(jwt({ acr: ACR, auth_time: seconds(w.clock) })));
  assert.equal(w.actions.resumeAction(pending.requestId, payloadOf('pending')), undefined);
  // The completed action was bound to an earlier sign-in, so the newer token makes it refuse too: each auth_time serves its own action.
  assert.deepEqual(await w.signer.sign(payloadOf('late'), { action }), STEP_UP_REFUSAL);
  assert.equal(w.signs, 0);
});

test('two concurrent resumeAction calls for one request id: exactly one gets the action id and nothing is signed twice', async () => {
  const w = await world();
  const { requestId, nonce } = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(w, nonce), 200);
  const answers = await Promise.all([0, 1].map(async () => w.actions.resumeAction(requestId, ORDER_PAYLOAD)));
  assert.equal(answers.filter((answer) => typeof answer === 'string').length, 1);
  assert.equal(answers.filter((answer) => answer === undefined).length, 1);
});

test('a fresh step-up whose sub is not the sub the session became active with binds nothing, even with the right nonce, acr, auth_time and email', async () => {
  const w = await world();
  const { requestId, nonce } = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(w, nonce, { sub: 'kc-someone-else' }), 403);
  assert.equal(w.actions.resumeAction(requestId, ORDER_PAYLOAD), undefined);
  // The wrong acr and an auth_time from before the action began bind nothing either.
  assert.equal(stepUpReturn(w, nonce, { acr: 'urn:sterling:acr:password' }), 403);
  assert.equal(stepUpReturn(w, nonce, { auth_time: seconds(w.clock, -120) }), 403);
  // And the request must carry the token the person check accepted: another token in the headers than the session's binds nothing.
  w.clock.advance(5_000);
  const accepted = jwt({ acr: ACR, auth_time: seconds(w.clock) });
  w.identity.observe(headers(accepted));
  assert.equal(actionReturnPage(w.actions, () => w.identity.session(), headers(jwt({ acr: ACR, auth_time: seconds(w.clock) + 1 })), nonce).status, 403);
  assert.equal(actionReturnPage(w.actions, () => w.identity.session(), headers(accepted), nonce).status, 200);
});

test('a new registry (a backend restart) resumes nothing that was pending before it', async () => {
  const w = await world();
  const { requestId, nonce } = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  const restarted = createPendingActions({ stepUpAcr: ACR, windowSeconds: WINDOW_SECONDS, latestAuthTime: () => w.identity.session()?.authTime, clock: w.clock });
  w.clock.advance(5_000);
  const token = jwt({ acr: ACR, auth_time: seconds(w.clock) });
  w.identity.observe(headers(token));
  assert.equal(actionReturnPage(restarted, () => w.identity.session(), headers(token), nonce).status, 403);
  assert.equal(restarted.resumeAction(requestId, ORDER_PAYLOAD), undefined);
  assert.equal(actionSummaryPage(restarted, nonce, ACR).status, 404);
});

test('a pending action never confirmed ends after 120 s; a confirmed one after the step-up window from its bind', async () => {
  const w = await world();
  const late = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  w.clock.advance(PENDING_ACTION_MS - 6_000);
  assert.equal(stepUpReturn(w, late.nonce), 200, 'still pending just before 120 s');
  const lapsed = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  w.clock.advance(PENDING_ACTION_MS);
  assert.equal(actionSummaryPage(w.actions, lapsed.nonce, ACR).status, 404);

  const v = await world();
  const { requestId, nonce } = v.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(v, nonce), 200);
  const action = v.actions.resumeAction(requestId, ORDER_PAYLOAD) as string;
  v.clock.advance(WINDOW_SECONDS * 1000 - 1_000);
  assert.ok(verifies(payloadOf('inside'), await v.signer.sign(payloadOf('inside'), { action })), 'one action may sign its several entries inside the window');
  v.clock.advance(1_000);
  assert.deepEqual(await v.signer.sign(payloadOf('after'), { action }), STEP_UP_REFUSAL);
  // A window shorter than 120 s ends a pending action sooner.
  const short = createPendingActions({ stepUpAcr: ACR, windowSeconds: 30, latestAuthTime: () => undefined, clock: v.clock });
  const quick = short.beginAction(ORDER_PAYLOAD, ORDER);
  v.clock.advance(30_000);
  assert.equal(short.summaryOf(quick.nonce), undefined);
});

test('a different payload sent with a pending request id is refused, and the action stays resumable with its own payload', async () => {
  const w = await world();
  const { requestId, nonce } = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(w, nonce), 200);
  assert.equal(w.actions.resumeAction(requestId, payloadOf('posting.order pst-night-1 watch-officer-night mbr-stranger')), undefined);
  assert.equal(typeof w.actions.resumeAction(requestId, ORDER_PAYLOAD), 'string');
});

test('a sign call with no action id signs as 33-23\'s person signer does; a signer with no gate never signs an action id; one auth_time serves one action', async () => {
  const w = await world();
  const bytes = payloadOf('session.certify of this session');
  assert.ok(verifies(bytes, await w.signer.sign(bytes)));
  const ungated = personSigner(createKeyService(w.identity, w.clock), personPublic);
  assert.deepEqual(await ungated.sign(bytes, { action: 'anything' }), STEP_UP_REFUSAL);
  // A resumed action A, then action B: B's return with A's token (the same auth_time) binds nothing, so A's confirmation never signs B.
  const a = w.actions.beginAction(ORDER_PAYLOAD, ORDER);
  assert.equal(stepUpReturn(w, a.nonce), 200);
  const actionA = w.actions.resumeAction(a.requestId, ORDER_PAYLOAD) as string;
  const b = w.actions.beginAction(payloadOf('posting.report pst-night-1'), { kind: 'posting.report', fields: [] });
  const sameToken = w.identity.session()?.forwardedToken as string;
  assert.equal(actionReturnPage(w.actions, () => w.identity.session(), headers(sameToken), b.nonce).status, 403);
  assert.equal(w.actions.resumeAction(b.requestId, payloadOf('posting.report pst-night-1')), undefined);
  assert.ok(verifies(bytes, await w.signer.sign(bytes, { action: actionA })), 'A still signs its own entries');
});
