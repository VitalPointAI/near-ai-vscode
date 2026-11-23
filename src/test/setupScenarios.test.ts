import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { verifyAuthorization } from '../domain/gate/authorizations';
import { labelKey } from '../domain/gate/labels';
import { decideRoute, ROUTE_REFUSALS } from '../domain/gate/routing';
import { trustFactsFor, trustLine } from '../domain/gate/trust';
import { fillSlots, type DataAnswer } from '../domain/setup/answers';
import { RULED_OUT_WORDS_TEXT } from '../domain/setup/cards';
import { CHANGE_TEXT } from '../domain/setup/changes';
import type { GuideInbound } from '../domain/setup/guideMessages';
import { proposeLabel, useFor } from '../domain/setup/map';
import { GENERIC_CONTACT_TEXT } from '../domain/setup/policy';
import { APPROVED_DEVICE_NOTE_TEXT, RECOMMEND_REASON_TEXT } from '../domain/setup/words';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { projectLogKey } from '../gate/decisionLog';
import { SETUP_AUDIT_DIR } from '../gate/setupAuditLog';
import { createGuideController, type GuideControllerDeps } from '../services/setup/guideController';
import { routeFactsOf } from '../services/setup/guideFacts';
import { readSetupGuide } from '../services/setup/projectStore';
import { at, local, near, setup } from './helpers/getStartedHostFixture';
import { authorizationFor, DAY_MS, issuerKey, NAMED_PERSON, signAuthorization, type AuthorizationOptions } from './helpers/policyFixtures';

const localModel = { id: 'ollama-fixture', privacyBoundary: 'local' } as const;
const foundLocal = {
  ...local, state: 'viable', sentence: undefined, answeredAt: at, models: [localModel],
  routeFacts: { clientRoute: 'local', host: 'http://127.0.0.1:11434', model: localModel }
} as const;
const results = [foundLocal, near];
const internal = { kindOfWork: 'analysis', data: ['internal'], canada: 'no' } as const;
const personal = { kindOfWork: 'analysis', data: ['personal'], personalSensitive: 'yes', canada: 'no' } as const;
const classified = { kindOfWork: 'analysis', data: ['classified'], canada: 'no' } as const;
const protectedB = 'ca-protected/Protected B';
type Run = Awaited<ReturnType<typeof setup>>;

function guideFor(t: TestContext, run: Run, deps = run.deps) {
  const guide = createGuideController(deps);
  t.after(() => guide.dispose());
  return guide;
}

function screen<K extends import('../domain/setup/screens').GuideScreenModel['kind']>(run: Run, kind: K) {
  const message = run.posted.at(-1);
  assert.ok(message?.type === 'screen' && message.screen.kind === kind);
  return message.screen as Extract<typeof message.screen, { kind: K }>;
}

async function sendAnswers(guide: ReturnType<typeof guideFor>, answers: {
  data: readonly DataAnswer[]; canada?: 'no' | 'not-sure'; personalSensitive?: 'yes';
}) {
  await guide.open();
  const events: GuideInbound[] = [
    { type: 'answer', key: 'kindOfWork', value: 'analysis' }, { type: 'next' },
    { type: 'answer', key: 'data', value: [...answers.data] }, { type: 'next' },
  ];
  if (answers.personalSensitive) events.push({ type: 'answer', key: 'personalSensitive', value: answers.personalSensitive }, { type: 'next' });
  if (answers.canada) events.push({ type: 'answer', key: 'canada', value: answers.canada }, { type: 'next' });
  for (const event of events) await guide.receive(event);
}

async function reviewLocal(guide: ReturnType<typeof guideFor>) {
  await guide.receive({ type: 'choose', optionId: 'this-computer' });
  await guide.receive({ type: 'review' });
}

async function snapshotFor(deps: GuideControllerDeps) {
  const snapshot = await deps.readPolicy(at);
  assert.ok('route' in snapshot);
  return snapshot;
}

function verifiedAuthorization(options: AuthorizationOptions) {
  const key = issuerKey();
  const body = authorizationFor({ ...options, issuedAt: new Date(at).toISOString() });
  const signer = { ...NAMED_PERSON, publicKey: key.publicKey, fingerprint: key.fingerprint };
  const verdict = verifyAuthorization(signAuthorization(body, key), { signers: [signer], now: at });
  assert.ok(verdict.ok, JSON.stringify(verdict));
  return { body: verdict.body, selfSigned: verdict.selfSigned };
}

function withApproval(run: Run, options: AuthorizationOptions, deviceId?: string): GuideControllerDeps {
  const approval = verifiedAuthorization(options);
  return { ...run.deps, async readPolicy(now) {
    const snapshot = await run.deps.readPolicy(now);
    if (!('route' in snapshot)) return snapshot;
    const route = { ...snapshot.route, deviceId: deviceId ?? snapshot.route.deviceId, authorizations: [approval] };
    if (options.kind === 'protected-b') {
      route.endpoints = [{ id: 'near-approved', class: 'nearai-tee', host: 'cloud-api.near.ai',
        scheme: 'https', tlsPins: [], region: 'CA', maxLabel: [protectedB] }];
      return { ...snapshot, route, routing: { ...snapshot.routing,
        levels: { ...snapshot.routing.levels, [protectedB]: 'attested-cloud' } } };
    }
    return { ...snapshot, route };
  } };
}

function proposedMark(snapshot: Awaited<ReturnType<typeof snapshotFor>>, answers: typeof personal | typeof internal) {
  return [proposeLabel(answers, { scales: snapshot.route.scales, routing: snapshot.routing }).proposed];
}

async function auditText({ storage, root }: Run) {
  return readFile(path.join(storage, GATE_DIR_NAME, SETUP_AUDIT_DIR, projectLogKey(root) + '.jsonl'), 'utf8');
}

test('SC2 keeps Protected B on a verified loopback route and waits for clearance', async (t) => {
  const run = await setup({ results });
  const guide = guideFor(t, run);
  await sendAnswers(guide, personal);
  const options = screen(run, 'options');
  const snapshot = await snapshotFor(run.deps);
  const mark = proposedMark(snapshot, personal);
  const facts = routeFactsOf(near, at);
  assert.ok(facts);
  assert.equal(labelKey(mark[0]), protectedB);
  const denied = decideRoute(mark, snapshot.routing, { ...facts, use: useFor(personal) }, snapshot.defaultLabel, snapshot.floor, snapshot.route);
  assert.equal(denied.allowed, false);
  assert.equal(options.recommended[0]?.optionId, 'this-computer');
  assert.match(options.reason ?? '', /on a computer your organization controls\./);
  assert.equal(options.ruledOut[0]?.optionId, 'near-private');
  assert.equal(options.ruledOut[0]?.reason, denied.reason);
  assert.equal(options.ruledOut[0]?.outcomeText, RULED_OUT_WORDS_TEXT);
  await reviewLocal(guide);
  const review = screen(run, 'check');
  const label = review.changes.find(({ area }) => area === 'label');
  assert.match(label?.text ?? '', /Protected B/);
  assert.equal(label?.waitsFor, 'rules-change');
  assert.ok(review.changes.some(({ id, effect }) => id === 'your-rules:clearance' && effect === 'proposal'));
});

test('SC2 names the verified Protected B authorization on the exact allowed endpoint', async (t) => {
  const run = await setup({ results });
  const deps = withApproval(run, { kind: 'protected-b', subject: { endpoint: 'near-approved' }, scope: { labels: [protectedB] } });
  const guide = guideFor(t, run, deps);
  await sendAnswers(guide, personal);
  const snapshot = await snapshotFor(deps);
  const mark = proposedMark(snapshot, personal);
  const facts = routeFactsOf(near, at);
  assert.ok(facts);
  const context = { mark, routing: snapshot.routing, defaultLabel: snapshot.defaultLabel };
  const decision = decideRoute(mark, snapshot.routing, { ...facts, use: useFor(personal) }, snapshot.defaultLabel, snapshot.floor, snapshot.route);
  assert.equal(decision.allowed, true, decision.reason);
  const expected = trustLine(trustFactsFor(decision, facts, context), snapshot.route.scales);
  assert.ok(expected.text.includes(NAMED_PERSON.name));
  const card = screen(run, 'options').available.find(({ optionId }) => optionId === 'near-private');
  assert.equal(card?.trustLine, expected.text);
});

test('SC3 leaves the connection unchecked and rejects forged choices for classified work', async (t) => {
  const run = await setup({ results });
  const guide = guideFor(t, run);
  await sendAnswers(guide, classified);
  const stopped = screen(run, 'stopped');
  assert.equal(stopped.sentence, fillSlots(RECOMMEND_REASON_TEXT.classified, { contact: GENERIC_CONTACT_TEXT }));
  assert.ok(stopped.whoToAsk.includes(GENERIC_CONTACT_TEXT));
  assert.equal(stopped.approvedDevice, undefined);
  await guide.receive({ type: 'choose', optionId: 'this-computer' });
  assert.deepEqual(screen(run, 'stopped'), stopped);
  assert.equal(run.calls.checks, 0);
  await guide.receive({ type: 'next' });
  const review = screen(run, 'check');
  assert.ok(review.changes.some(({ area }) => area === 'label'));
  assert.ok(review.changes.every(({ area }) => area === 'label' || area === 'your-rules'));
  assert.equal(readSetupGuide(run.root), undefined);
  const verified = await run.audit.verify();
  assert.ok(verified.ok);
  assert.equal(verified.head, undefined);
});

test('SC3 names an approved device for the exact classified level while keeping the stop', async (t) => {
  const run = await setup({ results });
  const subject = { device: 'approved-device' };
  const expires = at + DAY_MS;
  const approval = {
    kind: 'accredited-device', subject, scope: { labels: ['ca-classified/Top Secret'], uses: ['t1'] },
    expiresAt: new Date(expires).toISOString()
  } as const;
  const guide = guideFor(t, run, withApproval(run, approval, subject.device));
  await sendAnswers(guide, classified);
  assert.equal(screen(run, 'stopped').approvedDevice, fillSlots(APPROVED_DEVICE_NOTE_TEXT, { name: NAMED_PERSON.name }));
  assert.equal(run.calls.checks, 0);
  const otherDevice = guideFor(t, run, withApproval(run, approval, 'other-device'));
  await sendAnswers(otherDevice, classified);
  assert.equal(screen(run, 'stopped').approvedDevice, undefined);
  const otherLevel = guideFor(t, run, withApproval(run, { ...approval, scope: { ...approval.scope, labels: ['ca-classified/Secret'] } }, subject.device));
  await sendAnswers(otherLevel, classified);
  assert.equal(screen(run, 'stopped').approvedDevice, undefined);
  run.setTime(expires);
  await guide.receive({ type: 'ready' });
  assert.equal(screen(run, 'stopped').approvedDevice, undefined);
});

test('SC4 enforces Canada residency already set in the signed personal policy', async (t) => {
  const run = await setup({ results });
  const policy = run.host.policyLayers().personal;
  assert.ok(policy);
  const requires = [...new Set([...policy.document.requires, 'residency@1'])].sort();
  await run.host.applyPolicyDraft(JSON.stringify({ ...policy.document, requires, residency: { v: 1, required: ['CA'] } }), policy.hash);
  const guide = guideFor(t, run);
  await sendAnswers(guide, internal);
  const options = screen(run, 'options');
  assert.equal(options.recommended[0]?.optionId, 'this-computer');
  assert.equal(options.ruledOut[0]?.reason, ROUTE_REFUSALS['route.residency']);
});

test('SC4 proposes and applies Canada-only project residency for an unsure answer', async (t) => {
  const run = await setup({ results });
  const guide = guideFor(t, run);
  await sendAnswers(guide, { ...internal, canada: 'not-sure' });
  const options = screen(run, 'options');
  assert.equal(options.recommended[0]?.optionId, 'this-computer');
  assert.equal(options.ruledOut[0]?.reason, ROUTE_REFUSALS['route.residency']);
  await reviewLocal(guide);
  assert.ok(screen(run, 'check').changes.some(({ text, effect }) => text === CHANGE_TEXT.canada && effect === 'apply'));
  await guide.receive({ type: 'apply' });
  screen(run, 'done');
  const snapshot = await snapshotFor(run.deps);
  assert.deepEqual(snapshot.route.residency?.required, ['CA']);
});

test('SC5 a rerun keeps the signed Protected B label and points to its separate lowering flow', async (t) => {
  const run = await setup({ results, initialLabel: { scale: 'ca-protected', level: 'Protected B' } });
  const first = guideFor(t, run);
  await sendAnswers(first, personal);
  await reviewLocal(first);
  await first.receive({ type: 'apply' });
  screen(run, 'done');
  const guide = guideFor(t, run);
  await sendAnswers(guide, internal);
  await reviewLocal(guide);
  const review = screen(run, 'check');
  assert.ok(review.lowerLabelText);
  assert.deepEqual(review.changes.filter(({ area }) => area === 'label').map(({ waitsFor }) => waitsFor), ['lower-label-flow']);
  await guide.receive({ type: 'apply' });
  const snapshot = await snapshotFor(run.deps);
  assert.ok(snapshot.projectLabel);
  assert.equal(labelKey(snapshot.projectLabel), protectedB);
});

test('SC5 appends a verifiable no-change applied record when answers and choices agree', async (t) => {
  const run = await setup({ results });
  const first = guideFor(t, run);
  await sendAnswers(first, internal);
  await reviewLocal(first);
  await first.receive({ type: 'apply' });
  screen(run, 'done');
  const rerun = guideFor(t, run);
  await sendAnswers(rerun, internal);
  await reviewLocal(rerun);
  assert.ok(screen(run, 'check').nothingChangedText);
  await rerun.receive({ type: 'apply' });
  screen(run, 'done');
  const log = await run.audit.verify();
  assert.ok(log.ok);
  assert.equal(log.head?.seq, 2);
  const records = (await auditText(run)).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[1].event, 'setup.guide.applied');
  assert.equal(records[1].body.nothingChanged, true);
});

test('D-14 gates a different choice on a reason and records only cleaned bounded text', async (t) => {
  const run = await setup({ results });
  const guide = guideFor(t, run);
  await sendAnswers(guide, internal);
  await guide.receive({ type: 'choose', optionId: 'near-private' });
  assert.equal(screen(run, 'options').needsReason, true);
  await guide.receive({ type: 'review' });
  assert.equal(screen(run, 'options').canReview, false);
  const fakeKey = `sk-${'f'.repeat(24)}`; // secret-scan: allow (fictional fixture)
  await guide.receive({ type: 'reason', text: `Capacity ${fakeKey} ${'x'.repeat(210)}` });
  await guide.receive({ type: 'review' });
  await guide.receive({ type: 'apply' });
  screen(run, 'done');
  const text = await auditText(run);
  assert.ok(!text.includes(fakeKey));
  const record = JSON.parse(text);
  assert.match(record.body.choiceReason, /^Capacity \[REDACTED\]/);
  assert.ok(record.body.choiceReason.length <= 200);
});

test('Apply restarts checking when the reviewed result is eleven minutes old', async (t) => {
  const run = await setup({ results });
  const guide = guideFor(t, run);
  await sendAnswers(guide, internal);
  await reviewLocal(guide);
  run.setTime(at + 11 * 60_000);
  const before = run.posted.length;
  await guide.receive({ type: 'apply' });
  assert.ok(run.posted.slice(before).some((entry) => entry.type === 'screen' && entry.screen.kind === 'checking'));
  assert.equal(run.calls.checks, 2);
  assert.equal(readSetupGuide(run.root), undefined);
  assert.equal(run.calls.lands, 0);
  const snapshot = await snapshotFor(run.deps);
  assert.equal(snapshot.projectLabel?.level, 'Public');
});
