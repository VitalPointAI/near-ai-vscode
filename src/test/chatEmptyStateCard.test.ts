// The card in the chat and the report-only notice (74.1-13 Task 2, D-22, D-28, 74.1-UI-SPEC S8, S9, S10): a route.passport refusal with no model that
// would pass becomes the card; with alternatives it stays the sentence. The first would-refuse of route.passport in a session raises a notice that has no
// dismiss, stays for the session, and goes only when the effective mode turns to enforce; Adopt opens a proposal on a personal layer and nothing else.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import type { PassportRefusal, RouteDecision } from '../domain/gate/routing';
import type { PolicyLayersView } from '../gate/organizationStore';
import { routeRecordFor, sessionRouteFrom } from '../gate/sessionMark';
import { providerErrorPost } from '../services/chatBridge';
import { RouteRefusedError } from '../services/nearAiClient';
import { REPORT_MODE_TEXT, adoptProposal, modelPolicyAction, reportNoticeStatus, reportNoticeView, resetReportNoticeForTests, startReportModeNotice } from '../services/reportModeNotice';
import { testGateRuntime } from './helpers/gatedRuns';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

const REPO = path.resolve(__dirname, '..', '..');
const refusal = (alternatives?: string[]): PassportRefusal => ({
  model: 'z-ai/glm-5.3', use: 'T2', labels: ['org/Internal'], place: 'NEAR AI private hardware', whoToAsk: 'Who to ask: whoever set up the rules on this computer.', organization: false,
  ...(alternatives === undefined ? {} : { alternatives })
});

function layers(options: { mode?: 'report' | 'enforce'; organization?: boolean } = {}): PolicyLayersView {
  const personal = policyDocumentFor({ key: deviceKey() });
  const effective = { ...personal, ...(options.mode === undefined ? {} : { models: { v: 1, mode: options.mode, unknownMaxTier: 'T0' } }) } as PolicyDocument;
  const organization = options.organization === true
    ? { state: 'valid', document: { ...effective, onboarding: { v: 1, contacts: [{ topic: 'security', name: 'Security desk', how: 'security@example.org' }], locked: {}, kindsOfWork: [] } }, hash: 'h' }
    : { state: 'none' };
  return { organization, personal: { document: personal, hash: 'p', stored: {} }, effective, ignored: [], migration: [] } as unknown as PolicyLayersView;
}

/** A host whose layers the test changes, and the would-refuse of one model request, as the client records it. */
function session(start: PolicyLayersView) {
  resetReportNoticeForTests();
  let current = start;
  const listeners = new Set<() => void>();
  const host = { policyLayers: () => current, onDidChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const started = startReportModeNotice(host);
  const route = sessionRouteFrom(testGateRuntime());
  const facts = { clientRoute: 'near' as const, host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' as const }, attestationFailed: false };
  const request = (decision: RouteDecision) => routeRecordFor(route, decision, facts, { model: 'z-ai/glm-5.3' }, { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING });
  return {
    wouldRefuse: () => request({ allowed: true, tier: 'any-cloud', rule: 'route.any-cloud', wouldRefuse: ['route.passport'] }),
    allowedPlain: () => request({ allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }),
    change: (next: PolicyLayersView) => { current = next; for (const listener of [...listeners]) listener(); },
    layers: () => current,
    stop: () => started.dispose()
  };
}

test('D-22: a route.passport refusal with no model that would pass becomes the card; with models that would pass it stays the sentence', () => {
  const none = providerErrorPost(new RouteRefusedError('route.passport', 'Nothing was sent. ...', refusal([])));
  assert.equal(none.card?.title, 'No approved model can do this');
  assert.equal(none.card?.facts, 'This chat is agent work at Organization: Internal. No model your rules allow for that is available on NEAR AI private hardware.');
  assert.deepEqual(none.card?.options.map((option) => option.kind), ['near', 'research'], 'no closed option is offered from a refusal the gate already decided');
  assert.equal(none.card?.who, 'Who to ask: whoever set up the rules on this computer.');
  const notWorkedOut = providerErrorPost(new RouteRefusedError('route.passport', 'Nothing was sent.', refusal()));
  assert.ok(notWorkedOut.card, 'alternatives not worked out: the card too');
  const some = providerErrorPost(new RouteRefusedError('route.passport', 'Nothing was sent. Choose one of these models instead: openai/gpt-oss-120b.', refusal(['openai/gpt-oss-120b'])));
  assert.deepEqual(some, { type: 'assistant-error', text: 'Nothing was sent. Choose one of these models instead: openai/gpt-oss-120b.' });
  assert.equal(providerErrorPost(new RouteRefusedError('route.endpoint-pin', 'Nothing was sent.')).card, undefined);
  assert.equal(providerErrorPost(new Error('boom')).card, undefined);
});

test('D-22: in report mode the first would-refuse raises the notice for the session, in the chat and the status bar; a plain request does not', () => {
  const s = session(layers({ mode: 'report' }));
  s.allowedPlain();
  assert.equal(reportNoticeView(s.layers()), undefined, 'no notice before a would-refuse');
  s.wouldRefuse();
  const view = reportNoticeView(s.layers());
  assert.deepEqual({ lead: view?.lead, tail: view?.tail }, { lead: 'Agent work is running outside your rules for models', tail: ' (report only).' });
  assert.equal(view?.adopt, 'Adopt the Western defaults');
  assert.equal(view?.detail, REPORT_MODE_TEXT.detailOwn);
  assert.deepEqual(reportNoticeStatus(s.layers()), { text: '$(warning) Policy: models report only', tooltip: 'Agent work is running outside your rules for models (report only). Open it to see your policy.' });
  // A new chat tab of the same session reads the same notice: it is the session's, not one chat's.
  s.allowedPlain();
  assert.ok(reportNoticeView(s.layers()));
  s.stop();
});

test('T-74.1-58: the notice has no dismiss: a crafted dismiss message from the page changes nothing', async () => {
  const s = session(layers({ mode: 'report' }));
  s.wouldRefuse();
  const proposed: unknown[] = [];
  const deps = { layers: s.layers, propose: async (change: unknown) => { proposed.push(change); }, openResearchWorkspace: async () => undefined };
  assert.equal(await modelPolicyAction({ type: 'model-policy-action', action: 'dismiss' }, deps), true);
  assert.equal(await modelPolicyAction({ type: 'model-policy-dismiss' }, deps), false);
  assert.ok(reportNoticeView(s.layers()), 'still raised');
  assert.deepEqual(proposed, []);
  const page = readFileSync(path.join(REPO, 'media', 'chat', 'chat.js'), 'utf8');
  const notice = page.slice(page.indexOf('function renderPolicyNotice'), page.indexOf('// The reply footer'));
  assert.doesNotMatch(notice, /dismiss|close|ICONS\.close/i, 'the page renders no dismiss or close control');
  s.stop();
});

test('D-22, D-28: the notice goes when the effective mode turns to enforce, and comes back at the next would-refuse after a return to report', () => {
  const s = session(layers({ mode: 'report' }));
  s.wouldRefuse();
  s.change(layers({ mode: 'enforce', organization: true }));
  assert.equal(reportNoticeView(s.layers()), undefined);
  assert.equal(reportNoticeStatus(s.layers()), undefined);
  s.wouldRefuse();
  assert.equal(reportNoticeView(s.layers()), undefined, 'under enforce a would-refuse does not exist, and none raises it');
  s.change(layers({ mode: 'report', organization: true }));
  assert.equal(reportNoticeView(s.layers()), undefined, 'a return to report alone does not raise it');
  s.wouldRefuse();
  assert.ok(reportNoticeView(s.layers()));
  s.stop();
});

test('D-22: under your organization\'s layer the notice names your organization\'s model policy, ends its detail with who to ask, and offers no Adopt', async () => {
  const s = session(layers({ mode: 'report', organization: true }));
  s.wouldRefuse();
  const view = reportNoticeView(s.layers());
  assert.equal(`${view?.lead ?? ''}${view?.tail ?? ''}`, 'Agent work is running outside your organization\'s model policy (report only).');
  assert.equal(view?.adopt, undefined);
  assert.equal(view?.detail, 'Your organization\'s rules only report models they do not approve, so agent work keeps running on them. Each use is recorded. Who to ask: Security desk (security@example.org).');
  const proposed: unknown[] = [];
  await modelPolicyAction({ type: 'model-policy-action', action: 'adopt' }, { layers: s.layers, propose: async (change) => { proposed.push(change); }, openResearchWorkspace: async () => undefined });
  assert.deepEqual(proposed, [], 'a crafted Adopt under your organization\'s layer opens nothing');
  s.stop();
});

test('O1: Adopt on a personal layer opens a proposal adding the models section in enforce mode, with the effect in words; it never writes the policy itself', async () => {
  const s = session(layers({ mode: 'report' }));
  s.wouldRefuse();
  const proposed: Array<ReturnType<typeof adoptProposal>> = [];
  let opened = 0;
  await modelPolicyAction({ type: 'model-policy-action', action: 'adopt' }, { layers: s.layers, propose: async (change) => { proposed.push(change); }, openResearchWorkspace: async () => { opened += 1; } });
  assert.equal(proposed.length, 1);
  const change = proposed[0] as ReturnType<typeof adoptProposal>;
  assert.equal(change.target, 'personal');
  assert.equal(change.reason, 'Adopt the Western defaults: agent work is refused on models your rules do not approve for it. Agent work will be refused on every model NEAR AI hosts today until a Western model is hosted.');
  const next = change.next(s.layers().personal?.document as PolicyDocument);
  assert.deepEqual(next.models, { v: 1, mode: 'enforce', unknownMaxTier: 'T0' });
  await modelPolicyAction({ type: 'model-policy-action', action: 'open-research-workspace' }, { layers: s.layers, propose: async () => undefined, openResearchWorkspace: async () => { opened += 1; } });
  assert.equal(opened, 1);
  s.stop();
});
