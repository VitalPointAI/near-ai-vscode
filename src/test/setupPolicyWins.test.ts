import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { decideRoute } from '../domain/gate/routing';
import type { ModeId } from '../domain/org/modes';
import { modeName, term } from '../domain/org/terms';
import type { GuideInbound } from '../domain/setup/guideMessages';
import { MODE_SET_BY_ORGANIZATION_TEXT, MODE_SUGGESTED_TEXT } from '../domain/setup/modes';
import { GENERIC_CONTACT_TEXT } from '../domain/setup/policy';
import type { GuideScreenModel } from '../domain/setup/screens';
import type { ViabilityResult } from '../domain/setup/viability';
import { STARTING_RULES_TEXT } from '../domain/setup/words';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { projectLogKey } from '../gate/decisionLog';
import { SETUP_AUDIT_DIR } from '../gate/setupAuditLog';
import { createGuideController } from '../services/setup/guideController';
import { routeFactsOf } from '../services/setup/guideFacts';
import { PROJECT_LAYER_WIDENING_TEXT } from '../services/setup/projectLayerSink';
import { projectMode, readProjectLayer, readSetupGuide } from '../services/setup/projectStore';
import { enrolmentTextFor, EXAMPLE_ORGANIZATION, organizationSections } from './helpers/enrolmentFixtures';
import { at, near, setup } from './helpers/getStartedHostFixture';
import { DAY_MS, issuerKey } from './helpers/policyFixtures';

const model = { id: 'ollama-fixture', privacyBoundary: 'local' } as const;
const verifiedLocal: ViabilityResult = {
  optionId: 'this-computer', kind: 'this-computer', state: 'viable', answeredAt: at, hostKind: 'container', models: [model],
  routeFacts: { clientRoute: 'local', host: 'http://127.0.0.1:11434', model }
};
type Run = Awaited<ReturnType<typeof setup>>;

function guideFor(t: TestContext, run: Run, close?: () => void) {
  const guide = createGuideController({ ...run.deps, close });
  t.after(() => guide.dispose());
  return guide;
}

function screen<K extends GuideScreenModel['kind']>(run: Run, kind: K) {
  const message = run.posted.at(-1);
  assert.ok(message?.type === 'screen' && message.screen.kind === kind);
  return message.screen as Extract<GuideScreenModel, { kind: K }>;
}

async function enrol(run: Run, options: { choose?: boolean; expires?: number; lockCanada?: boolean } = {}) {
  const enrolled = await run.host.acceptOrganizationFile(enrolmentTextFor(issuerKey(), {
    now: at, layerDays: options.expires, sections: organizationSections({
      people: { v: 1, organization: {
        mode: 'public-service', allowedModes: ['military', 'public-service'], projectMayChoose: options.choose ?? false
      } },
      onboarding: {
        v: 1, contacts: EXAMPLE_ORGANIZATION.contacts, kindsOfWork: ['analysis', 'staff'],
        ...(options.lockCanada ? { locked: { canada: true } } : {})
      },
      ...(options.lockCanada ? { residency: { v: 1, required: ['CA'] } } : {})
    })
  }), { wordsConfirmed: true });
  assert.equal(enrolled.state, 'valid', enrolled.state === 'failed-closed' ? enrolled.sentence : '');
}

async function answerToOptions(guide: ReturnType<typeof guideFor>, options: { staff?: boolean; lockedCanada?: boolean } = {}) {
  await guide.open();
  const events: GuideInbound[] = [
    { type: 'answer', key: 'kindOfWork', value: options.staff ? 'staff' : 'analysis' },
    { type: 'next' }, { type: 'answer', key: 'data', value: ['internal'] }, { type: 'next' }
  ];
  if (!options.lockedCanada) events.push({ type: 'answer', key: 'canada', value: 'no' }, { type: 'next' });
  for (const event of events) await guide.receive(event);
}

async function reviewLocal(guide: ReturnType<typeof guideFor>) {
  await guide.receive({ type: 'choose', optionId: 'this-computer' });
  await guide.receive({ type: 'review' });
}

function authority(run: Run) {
  const { organization, personal } = run.host.policyLayers();
  assert.ok(organization.state === 'valid' && personal);
  return { organization: organization.hash, personal: personal.hash };
}

function assertMode(row: ReturnType<typeof screen<'check'>>['modeRow'], mode: ModeId, source: string) {
  assert.deepEqual(row, { name: modeName(mode), join: term('join', mode), source });
}

test('an expired signed organization policy shows only its fix and contact and refuses page actions', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  await enrol(run, { expires: 2 });
  run.setTime(at + 3 * DAY_MS);
  let closes = 0;
  const guide = guideFor(t, run, () => { closes++; });
  await guide.open();
  const state = run.host.bundleState();
  assert.equal(state.state, 'failed-closed');
  assert.ok(state.state === 'failed-closed');
  const fix = screen(run, 'fix');
  assert.equal(fix.sentence, state.sentence);
  assert.match(fix.whoToAsk, /Security desk · security@example\.org/);
  for (const event of [
    { type: 'next' }, { type: 'choose', optionId: 'this-computer' }, { type: 'apply' }, { type: 'abandon' }
  ] as const) await guide.receive(event);
  assert.equal(run.posted.length, 1);
  assert.equal(run.calls.checks, 0);
  assert.equal(readSetupGuide(run.root), undefined);
  await guide.receive({ type: 'close' });
  assert.equal(closes, 1);
});

test('signed organization limits govern the eligible routes and no screen offers a workaround', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  await enrol(run, { lockCanada: true });
  const guide = guideFor(t, run);
  await answerToOptions(guide, { lockedCanada: true });
  const current = screen(run, 'options');
  assert.equal(current.startingRules, undefined);
  const snapshot = await run.deps.readPolicy(at);
  assert.ok('route' in snapshot);
  const facts = routeFactsOf(near, at);
  assert.ok(facts);
  const internal = { ...snapshot.defaultLabel, scale: 'org', level: 'Internal' };
  const decision = decideRoute([internal], snapshot.routing, { ...facts, use: 'T1' }, snapshot.defaultLabel, snapshot.floor, snapshot.route);
  assert.equal(decision.allowed, false);
  assert.equal(current.ruledOut[0]?.reason, decision.reason);
  assert.match(current.whoToAsk, /Security desk · security@example\.org/);
  await guide.receive({ type: 'choose', optionId: 'near-private' });
  assert.equal(screen(run, 'options').chosen, undefined);
  await reviewLocal(guide);
  const check = screen(run, 'check');
  const canada = check.answers.find(({ key }) => key === 'canada');
  assert.equal(canada?.source, MODE_SET_BY_ORGANIZATION_TEXT);
  assert.equal(canada?.changeText, undefined);
  await guide.receive({ type: 'change', screen: 'canada' });
  assert.deepEqual(screen(run, 'check'), check);
  assert.doesNotMatch(JSON.stringify(run.posted), /edit (my rules|policy)|use another provider anyway|lower label/i);
});

test('a signed work choice list excludes an old answer and ignores the same forged answer', async (t) => {
  const run = await setup();
  assert.deepEqual(await run.deps.apply.sink.write({
    setupGuide: { v: 1, answers: { kindOfWork: 'software', data: ['internal'] }, chosen: [], pending: [] }
  }), { state: 'written' });
  await enrol(run);
  const guide = guideFor(t, run);
  await guide.open();
  const question = screen(run, 'question');
  assert.deepEqual(question.choices.map(({ value }) => value), ['analysis', 'staff', 'something-else']);
  assert.equal(question.canContinue, false);
  await guide.receive({ type: 'answer', key: 'kindOfWork', value: 'software' });
  assert.deepEqual(screen(run, 'question'), question);
  assert.equal(run.calls.checks, 0);
  assert.equal(readSetupGuide(run.root)?.answers.kindOfWork, 'software');
});

test('a fixed organization mode controls review and Apply without rewriting local or signed policy', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  assert.deepEqual(await run.deps.apply.sink.write({ mode: 'military' }), { state: 'written' });
  await enrol(run);
  const initialAuthority = authority(run);
  assert.equal(projectMode(run.root, run.host.policyLayers().effective), 'public-service');
  const guide = guideFor(t, run);
  await answerToOptions(guide, { staff: true });
  await reviewLocal(guide);
  const check = screen(run, 'check');
  assertMode(check.modeRow, 'public-service', MODE_SET_BY_ORGANIZATION_TEXT);
  assert.ok(!check.changes.some(({ area }) => area === 'mode'));
  await guide.receive({ type: 'apply' });
  screen(run, 'done');
  assert.equal(projectMode(run.root, run.host.policyLayers().effective), 'public-service');
  const stored = readProjectLayer(run.root, run.host.labelPolicy().scales);
  assert.ok(stored.state === 'valid');
  assert.equal(stored.layer.mode, 'military');
  assert.deepEqual(authority(run), initialAuthority);
});

test('a fixed organization mode blocks direct writes even if the local mode is on the allowed list', async () => {
  const run = await setup();
  await enrol(run);
  assert.deepEqual(await run.deps.apply.sink.write({ mode: 'military' }), { state: 'refused', text: PROJECT_LAYER_WIDENING_TEXT });
  assert.equal(readProjectLayer(run.root).state, 'none');
});

test('a delegated project mode cannot grant the clearance needed to raise a signed project label', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  await enrol(run, { choose: true });
  const initialAuthority = authority(run);
  const guide = guideFor(t, run);
  await guide.open();
  for (const event of [
    { type: 'answer', key: 'kindOfWork', value: 'staff' }, { type: 'next' },
    { type: 'answer', key: 'data', value: ['protected-b'] }, { type: 'next' },
    { type: 'answer', key: 'canada', value: 'no' }, { type: 'next' }
  ] as const) await guide.receive(event);
  await reviewLocal(guide);
  const check = screen(run, 'check');
  assertMode(check.modeRow, 'military', MODE_SUGGESTED_TEXT);
  assert.ok(check.changes.some(({ area, waitsFor }) => area === 'label' && waitsFor === 'rules-change'));
  assert.ok(!check.changes.some(({ id }) => id === 'your-rules:clearance'));
  await guide.receive({ type: 'apply' });
  const snapshot = await run.deps.readPolicy(at);
  assert.ok('route' in snapshot);
  assert.equal(snapshot.projectLabel?.level, 'Public');
  assert.equal(projectMode(run.root, run.host.policyLayers().effective), 'military');
  assert.deepEqual(authority(run), initialAuthority);
});

test('staff work applies and audits a Military mode when the organization delegates the project choice', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  await enrol(run, { choose: true });
  const initialAuthority = authority(run);
  const guide = guideFor(t, run);
  await answerToOptions(guide, { staff: true });
  await reviewLocal(guide);
  const check = screen(run, 'check');
  assertMode(check.modeRow, 'military', MODE_SUGGESTED_TEXT);
  assert.ok(check.changes.some(({ area, effect }) => area === 'mode' && effect === 'apply'));
  await guide.receive({ type: 'apply' });
  screen(run, 'done');
  assert.equal(projectMode(run.root, run.host.policyLayers().effective), 'military');
  assert.deepEqual(authority(run), initialAuthority);
  const file = path.join(run.storage, GATE_DIR_NAME, SETUP_AUDIT_DIR, projectLogKey(run.root) + '.jsonl');
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.event, 'setup.guide.applied');
  assert.ok(record.body.changes.some(({ id, outcome }: { id: string; outcome: string }) => id === 'mode' && outcome === 'done'));
  const audit = await run.audit.verify();
  assert.ok(audit.ok);
  assert.equal(audit.head?.seq, 1);
});

test('starting rules show the starting notice and generic contact without claiming organization authority', async (t) => {
  const run = await setup({ results: [verifiedLocal, near] });
  const guide = guideFor(t, run);
  await answerToOptions(guide);
  const options = screen(run, 'options');
  assert.equal(options.startingRules, STARTING_RULES_TEXT);
  assert.ok(options.whoToAsk.includes(GENERIC_CONTACT_TEXT));
  await reviewLocal(guide);
  assert.doesNotMatch(JSON.stringify(run.posted), /Set by your organization/);
});
