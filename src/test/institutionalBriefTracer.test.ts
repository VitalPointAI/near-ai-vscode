import { createInstitutionalStaffSetupFixture } from './helpers/institutional/institutionalPicker';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_TURN_CEILING_MS } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { INSTITUTIONAL_COMMAND_GROUP_MEMBER, INSTITUTIONAL_COMMAND_GROUP_TEAM, selectSyntheticInstitutionalCommandGroup, selectSyntheticInstitutionalJ2Catalogue, selectSyntheticInstitutionalJ3ActionRegister, selectSyntheticInstitutionalJ7Observation, selectSyntheticInstitutionalJ7Findings, selectSyntheticInstitutionalJ6BusinessServices, selectSyntheticInstitutionalJ5Evidence, selectSyntheticInstitutionalJ9Remits, selectSyntheticInstitutionalJ4Inventory, selectSyntheticInstitutionalJ8Budget, selectSyntheticInstitutionalJ1Monitoring, selectSyntheticInstitutionalAccessibility, selectedInstitutionalScope, institutionalChildTools, selectedTeamAgents } from './helpers/institutional/institutionalCommand';
import { TeamLibrary, type TeamDefinition } from '../agent/teams';
import { resolveInWorkspace } from '../agent/workspace';
import { bundleHash } from '../domain/gate/bundle';
import type { DecisionRecord } from '../domain/gate/record';
import type { ActionPolicy } from '../domain/policy';
import { institutionalSourceHash, type InstitutionalBriefSource } from './helpers/institutional/institutionalBrief';
import { canonicalBytes } from '../domain/team/canonical';
import { signPayload } from '../domain/team/signedPayload';
import { setCasProbe } from '../staff/staffFiles';
import { readInstitutionalDraftReview, storeInstitutionalDraft, verifyInstitutionalDraftTarget } from './helpers/institutional/institutionalDraftStore';
import type { AgentTurnRequest } from '../services/agentSession';
import { StreamInterruptedError, type AgentMessage, type CompletionEvent, type ToolCall, type ToolDefinition } from '../services/nearAiClient';
import { newTestConversation, testBundleState, testGateRuntime } from './helpers/gatedRuns';
import { testSigner } from './helpers/staffFixtures';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const accessibilityTeam = 'institutional-ss-accessibility-v1';
const accessibilityDirectory = '.planning/staff/institutional/special/accessibility-reviews';
const readAccessibility = 'ReadInstitutionalAccessibilityEvidence';
const saveAccessibility = 'SaveInstitutionalAccessibilityReviewDraft';
const monitoringTeam = 'institutional-j1-service-monitoring-v1';
const monitoringDirectory = '.planning/staff/institutional/j1/service-monitoring';
const readMonitoring = 'ReadInstitutionalServiceAggregate';
const saveMonitoring = 'SaveInstitutionalServiceMonitoringDraft';
const budgetTeam = 'institutional-j8-budget-evidence-v1';
const budgetDirectory = '.planning/staff/institutional/j8/budget-evidence';
const readBudget = 'ReadInstitutionalBudgetEvidence';
const saveBudget = 'SaveInstitutionalBudgetEvidenceDraft';
const inventoryTeam = 'institutional-j4-inventory-counts-v1';
const inventoryDirectory = '.planning/staff/institutional/j4/inventory-counts';
const readInventory = 'ReadInstitutionalInventoryCount';
const saveInventory = 'SaveInstitutionalInventoryDraft';
const remitTeam = 'institutional-j9-library-remits-v1';
const remitDirectory = '.planning/staff/institutional/j9/service-remits';
const readRemit = 'ReadInstitutionalLibraryRemit';
const saveRemit = 'SaveInstitutionalLibraryRemitDraft';
const planningTeam = 'institutional-j5-evidence-assumptions-v1';
const planningDirectory = '.planning/staff/institutional/j5/evidence-assumptions';
const readPlanningEvidence = 'ReadInstitutionalPlanningEvidence';
const savePlanningRegister = 'SaveInstitutionalPlanningRegisterDraft';
const businessServicesTeam = 'institutional-j6-business-services-v1';
const businessServicesDirectory = '.planning/staff/institutional/j6/business-services';
const readBusinessService = 'ReadInstitutionalBusinessService';
const saveBusinessServices = 'SaveInstitutionalBusinessServicesDraft';
const catalogueTeam = 'institutional-j2-records-catalogue-v1';
const catalogueDirectory = '.planning/staff/institutional/j2/catalogue';
const readCatalogue = 'ReadInstitutionalRecordMetadata';
const saveCatalogue = 'SaveInstitutionalRecordsCatalogueDraft';
const draftDirectory = '.planning/staff/institutional/command/briefs';
const observationTeam = 'institutional-j7-lessons-v1';
const observationDirectory = '.planning/staff/institutional/j7/observations';
const readObservation = 'ReadInstitutionalLessonsEvidence';
const saveObservation = 'SaveInstitutionalObservationDraft';
const saveFindings = 'SaveInstitutionalAfterActionDraft';
const findingsDirectory = '.planning/staff/institutional/j7/after-action';
const registerDirectory = '.planning/staff/institutional/j3/action-registers';
const registerTeam = 'institutional-j3-action-register-v1';
const readRegister = 'ReadInstitutionalActionEvidence';
const saveRegister = 'SaveInstitutionalActionRegisterDraft';
const readTool = 'ReadInstitutionalBriefEvidence';
const draftTool = 'SaveInstitutionalBriefDraft';
const model = 'fictional-local';
const secondModel = 'fictional-backup';
const idleDeadline = 20;
const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
const publicExtracts = [
  { id: 'front-desk-log', revision: '1', date: '2026-11-02', label: 'org/Public', text: 'Nine patrons asked for earlier access.' },
  { id: 'facilities-note', revision: '3', date: '2026-11-03', label: 'org/Public', text: 'Facilities disagrees with opening earlier.', dissentAttribution: 'Facilities' },
] as const;
const cite = (source: typeof publicExtracts[number]) => ({ sourceId: source.id, revision: source.revision, start: 0, end: source.text.length, quote: source.text });
const brief = {
  productId: 'office-service-hours',
  decisionRequested: 'Review whether to change the fictional office service hours.',
  facts: [{ text: 'There is demand for earlier access.', evidence: [cite(publicExtracts[0])] }],
  alternatives: ['Retain current hours', 'Trial an earlier opening'],
  assumptions: ['The scheduling pattern remains stable.'],
  dissent: [{ attribution: 'Facilities', text: 'Facilities objects to an earlier opening.', evidence: [cite(publicExtracts[1])] }],
  dependencies: ['Review staffing availability.'],
};

const toolCall = (id: string, name: string, input: unknown): ToolCall => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(input) },
});

async function stageInstitutionalSetup(root: string, choice: {
  label: string; team: string; keySegment?: string;
  checkPrompts?: (requests: ReturnType<typeof createVscodeStub>['quickPickRequests']) => void;
} = {
  label: 'Institutional Command Group', team: INSTITUTIONAL_COMMAND_GROUP_TEAM,
}) {
  const stub = createVscodeStub();
  Object.assign(stub.vscode as object, { QuickPickItemKind: { Separator: -1 } });
  const uninstall = installVscodeStub(stub);
  const moduleId = require.resolve('../services/staffSetupCommand');
  const cached = require.cache[moduleId];
  delete require.cache[moduleId];
  const profile = new Map<string, unknown>();
  const globalState = {
    get: (key: string) => profile.get(key),
    update: async (key: string, value: unknown) => { profile.set(key, JSON.parse(JSON.stringify(value))); },
  };
  try {
    const { registerStaffSetup, SET_UP_ACTION } = require('../services/staffSetupCommand') as typeof import('../services/staffSetupCommand');
    const library = new TeamLibrary(path.join(root, 'unused-library'));
    registerStaffSetup({ subscriptions: [], globalState } as never, { library, fixture: createInstitutionalStaffSetupFixture(stub.vscode as never, SET_UP_ACTION) });
    stub.setWorkspaceFolders([root]);
    stub.quickPickAnswers.push(choice.label, '$(check) Set up the team');
    const setup = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(setup);
    await setup();
    choice.checkPrompts?.(stub.quickPickRequests);
    assert.equal(profile.size, 1, 'the registered setup stages only the selected institutional role');
    const [[key, raw]] = [...profile.entries()];
    const record = raw as Record<string, unknown>;
    assert.equal(record.team, choice.team);
    if (choice.keySegment) assert.equal(key, `nearAi.staff.institutional.${choice.keySegment}.v1.${createHash('sha256').update(root).digest('hex')}`);
    assert.equal(await library.findRunTeam(choice.team, root), undefined);
    return record;
  } finally {
    uninstall();
    if (cached) require.cache[moduleId] = cached;
    else delete require.cache[moduleId];
  }
}

async function newFixture(logText = publicExtracts[0].text as string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-brief-fixture-')));
  const drafts = path.join(root, draftDirectory);
  await mkdir(drafts, { recursive: true });
  let staged = await stageInstitutionalSetup(root);
  const project = createHash('sha256').update(root).digest('hex');
  const runId = 'run-institutional-fixture';
  let sources: InstitutionalBriefSource[] = [{ ...publicExtracts[0], text: logText }, publicExtracts[1]]
    .map((entry) => ({ ...entry, project, spans: [{ start: 0, end: entry.text.length }] }));
  let parentsProved = true;
  let lease = false;
  let onSourceRead: (() => void) | undefined;
  const initial = testBundleState();
  assert.equal(initial.state, 'valid');
  const alternate = { ...initial.bundle, issuedAt: new Date(Date.parse(initial.bundle.issuedAt) - 1).toISOString() };
  let current = initial;
  let actionSettings: ActionPolicy = { mode: 'fully-autonomous', emergencyStop: false };
  const fixture = {
    root, runId, policyHash: initial.hash, bundleState: () => current, readStaged: () => staged, model,
    currentActionSettings: () => actionSettings,
    currentSources: () => { onSourceRead?.(); return sources; },
    // The suite alone controls the parents in the fresh 0700 root. A proof
    // withdrawal or another owner blocks entering the fixture's interlock.
    withStableParents: async <T>(run: () => Promise<T>): Promise<T> => {
      if (!parentsProved || lease) throw new Error('The isolated fixture does not hold its parent directories.');
      lease = true;
      try { return await run(); } finally { lease = false; }
    },
  };
  const team = await selectSyntheticInstitutionalCommandGroup(fixture);
  const readReview = async (hash: string) => {
    const reopened = await selectSyntheticInstitutionalCommandGroup(fixture);
    const scope = selectedInstitutionalScope(reopened);
    assert.ok(scope);
    const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, hash);
    assert.equal(review.kind, 'brief');
    return review;
  };
  return { fixture, team, drafts, readReview,
    stopThroughLiveSettings: () => { actionSettings = { ...actionSettings, emergencyStop: true }; },
    changePolicy: () => { current = { ...initial, bundle: alternate, hash: bundleHash(alternate) }; },
    restorePolicy: () => { current = initial; },
    withdrawParents: () => { parentsProved = false; },
    replaceStaged: () => { staged = { ...staged as object, echelon: 'L2' }; },
    reviseSources: () => { sources = sources.map((source) => ({ ...source, revision: 'next' })); },
    onSourceRead: (observe: () => void) => { onSourceRead = observe; } };
}

const acceptedSteps = [
  toolCall('read-log', readTool, { sourceId: publicExtracts[0].id }),
  toolCall('read-dissent', readTool, { sourceId: publicExtracts[1].id }),
  toolCall('draft', draftTool, brief),
];

async function runFixture(
  fixture: Awaited<ReturnType<typeof newFixture>>['fixture'],
  team: TeamDefinition,
  options: {
    steps?: readonly ToolCall[]; onChildTurn?: (turn: number) => void; root?: string; runId?: string;
    onStart?: (stop: () => void) => void; modelInterruption?: 'retryable' | 'silent'; wrongChildActor?: boolean;
  } = {},
) {
  const root = options.root ?? fixture.root;
  const offers: string[][] = [];
  const readOffers: unknown[] = [];
  const catalogueOffers: Record<string, unknown>[][] = [];
  const toolResults = new Map<string, string>();
  const results: string[] = [];
  const childRequests: { model: string; idle?: number; turn?: number; admitted: boolean }[] = [];
  let parentTurn = 0;
  let childTurn = 0;
  const client = {
    async *streamCompletion(selectedModel: string, messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal,
      deadlines: { idleTimeoutMs?: number; turnTimeoutMs?: number }): AsyncGenerator<CompletionEvent> {
      for (const message of messages) {
        if (message.role !== 'tool') continue;
        results.push(message.content);
        toolResults.set(message.tool_call_id, message.content);
      }
      const child = /Prepare a CG-07 decision brief using only evidence|Draft the fictional J3-07 office-hours action register|Draft a fictional J7-09 office-hours observation|Draft fictional J7-10 office-hours findings|Draft a fictional J2-IS01 office records catalogue|Draft a fictional J6-IT01 business-service catalogue|Draft a fictional J5-03 office migration evidence register|Draft a fictional J9-CL02 public-library remit comparison|Draft a fictional J4-02 office inventory reconciliation|Draft a fictional J8-02 office budget evidence reconciliation|Draft a fictional J1-05 office help aggregate|Draft a fictional SS-18 help-sheet accessibility review/.test(String(messages[0].content));
      let call: ToolCall | undefined;
      if (child) {
        const admitted = messages.some((message) => message.role === 'tool' && String(message.content).includes(publicExtracts[0].text));
        childRequests.push({ model: selectedModel, idle: deadlines.idleTimeoutMs, turn: deadlines.turnTimeoutMs, admitted });
        options.onChildTurn?.(childTurn);
        offers.push(tools.map((item) => item.function.name).sort());
        readOffers.push(tools.find((item) => item.function.name === readObservation)?.function.parameters);
        if (team.slug === catalogueTeam || team.slug === businessServicesTeam || team.slug === planningTeam || team.slug === remitTeam || team.slug === inventoryTeam || team.slug === budgetTeam || team.slug === monitoringTeam || team.slug === accessibilityTeam) catalogueOffers.push(tools.map(({ function: tool }) => tool.parameters));
        if (!options.modelInterruption || childTurn === 0) call = (options.steps ?? acceptedSteps)[childTurn++];
        else if (selectedModel === model) {
          if (options.modelInterruption === 'silent') await delay(deadlines.idleTimeoutMs ?? 100, undefined, { signal });
          throw new StreamInterruptedError('The fictional model stopped responding.', true, undefined, { kind: 'stalled', idleMs: deadlines.idleTimeoutMs ?? idleDeadline });
        }
      } else if (parentTurn++ === 0) {
        call = toolCall('spawn-drafter', 'Agent', { subagent_type: team.slug === accessibilityTeam ? 'accessibility-review-drafter' : team.slug === monitoringTeam ? 'service-monitoring-drafter' : team.slug === budgetTeam ? 'budget-evidence-drafter' : team.slug === inventoryTeam ? 'inventory-count-drafter' : team.slug === remitTeam ? 'library-remit-drafter' : team.slug === planningTeam ? 'planning-evidence-drafter' : team.slug === businessServicesTeam ? 'business-services-drafter' : team.slug === catalogueTeam ? 'records-catalogue-drafter' : team.slug === observationTeam ? 'lessons-drafter'
          : team.slug === registerTeam ? 'action-register-drafter' : INSTITUTIONAL_COMMAND_GROUP_MEMBER, prompt: 'Prepare the local administrative draft.' });
      }
      yield { type: 'done', message: { role: 'assistant', content: call ? null : 'Done', ...(call ? { tool_calls: [call] } : {}) }, finishReason: call ? 'tool_calls' : 'stop', usage };
    },
  };
  const posted: Record<string, unknown>[] = [];
  const conversation = newTestConversation(root, (event) => posted.push(event), path.join(root, '.checkpoints'));
  conversation.fixtureHost = {
    teamAgents: selectedTeamAgents,
    async child(team, input) {
      const tools = await institutionalChildTools(team, input, {
        verify: (scope, draft) => verifyInstitutionalDraftTarget(scope, resolveInWorkspace, draft),
        commit: (scope, draft, verify) => storeInstitutionalDraft(scope, resolveInWorkspace, draft, verify),
      });
      return tools === undefined ? undefined : {
        tools,
        timing: {
          stallRetries: 0,
          ...(input.modelStallMs ? { idleTimeoutMs: input.modelStallMs, turnCeilingMs: DEFAULT_TURN_CEILING_MS } : {}),
        },
      };
    },
  };
  const runtimes: ReturnType<typeof testGateRuntime>[] = [];
  conversation.gateHost = { async runtimeFor(request) {
    const actor = { ...request.actor, deviceFingerprint: 'fictional-brief' };
    if (options.wrongChildActor && actor.kind === 'sub-agent') actor.agentId = 'other-fictional-child';
    const runtime = testGateRuntime({ actor, presence: request.presence, context: request.context });
    runtimes.push(runtime);
    return { ...runtime, bundleState: fixture.bundleState };
  } };
  const requestPolicy: ActionPolicy = { mode: 'fully-autonomous', emergencyStop: false };
  const request = {
    text: 'Prepare an internal decision brief for review.', client: client as never, model, local: true,
    privacy: 'Local recording model', policy: requestPolicy, rules: DEFAULT_RULES, team,
    route: { kind: 'local', attestation: false }, modelCatalog: [{ id: model, privacyBoundary: 'local' }, ...(options.modelInterruption ? [{ id: secondModel, privacyBoundary: 'local' }] : [])],
    ...(options.modelInterruption ? { backupModel: secondModel, modelStallMs: idleDeadline } : {}), runId: options.runId ?? fixture.runId,
  } satisfies AgentTurnRequest;
  options.onStart?.(() => conversation.stop());
  try { await conversation.send(request); } finally { conversation.dispose(); }
  return { offers, readOffers, catalogueOffers, toolResults, results, posted, childRequests, requestPolicy, decisions: runtimes.flatMap((runtime): DecisionRecord[] => runtime.records) };
}

test('registered setup passes the exact staged record into a real confined child and reviews its draft', async () => {
  const { drafts, fixture, team, readReview, reviseSources } = await newFixture();
  const { offers, results, posted, decisions } = await runFixture(fixture, team);

  assert.deepEqual(offers[0], [readTool, draftTool], 'the staged child only sees the two admitted tools');
  assert.ok(!posted.some((event) => event.type === 'approval-request'));
  const files = await readdir(drafts);
  assert.equal(files.length, 1);
  const bytes = await readFile(path.join(drafts, files[0]));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(files[0], `${hash}.json`);
  assert.ok(results.some((result) => result.includes(hash)), 'the tool returns the exact digest for review');
  const stored = JSON.parse(bytes.toString());
  assert.equal(stored.echelon, 'L3');
  assert.equal(stored.duty, 'CG-07');
  assert.equal(stored.kind, 'brief');
  assert.deepEqual(stored.body.dissent, brief.dissent);
  const review = await readReview(hash);
  assert.equal(review.version, hash);
  assert.deepEqual(review.sources.map(({ id, revision }) => [id, revision]), [['facilities-note', '3'], ['front-desk-log', '1']]);
  assert.deepEqual(await readdir(path.join(fixture.root, '.planning', 'staff')), ['institutional']);
  const saved = decisions.find((decision) => decision.api.request.uid === 'draft');
  assert.equal(saved?.action_id, 1, 'the exact draft goes through the current gate');
  reviseSources();
  await assert.rejects(readReview(hash), /admitted source revision and span/);
});

test('the recording child never receives institutional capability through a copied, foreign or wrong-run selection', async () => {
  const subject = await newFixture();
  const foreign = await realpath(await mkdtemp(path.join(tmpdir(), 'institutional-brief-other-')));
  await assert.rejects(selectSyntheticInstitutionalCommandGroup({ ...subject.fixture, root: foreign }), /staged project/);
  for (const [team, options] of [
    [structuredClone(subject.team), {}],
    [subject.team, { root: foreign }],
    [subject.team, { runId: 'different-fixture' }],
  ] as const) {
    const state = await runFixture(subject.fixture, team, options);
    assert.deepEqual(state.offers, []);
    assert.ok(!state.posted.some((event) => event.type === 'approval-request'));
  }
  assert.deepEqual(await readdir(subject.drafts), []);
});

test('current evidence and an exact path are required before any approval or draft write', async () => {
  const subject = await newFixture();
  const unsupported = toolCall('unsupported', 'Write', { file_path: 'someone-elses-file', content: 'unapproved' });
  const unknown = toolCall('unknown-evidence', readTool, { sourceId: 'outside-fixture' });
  const malformed = toolCall('invalid-draft', draftTool, { ...brief, file_path: 'unapproved' });
  const stale = toolCall('stale-draft', draftTool, brief);
  let installs = 0;
  setCasProbe(() => { installs += 1; });
  try {
    const state = await runFixture(subject.fixture, subject.team, {
      steps: [unsupported, unknown, malformed, stale],
      onChildTurn: (turn) => { if (turn === 3) subject.reviseSources(); },
    });
    assert.ok(!state.posted.some((event) => event.type === 'approval-request'));
    assert.match(state.results.join(' '), /unknown tool|unavailable/);
    for (const id of ['unsupported', 'unknown-evidence', 'invalid-draft', 'stale-draft']) {
      assert.equal(state.decisions.find((record) => record.api.request.uid === id)?.action_id, 2, id);
    }
    assert.equal(installs, 0);
    assert.deepEqual(await readdir(subject.drafts), []);
  } finally { setCasProbe(undefined); }
  const missing = await newFixture();
  missing.withdrawParents();
  const state = await runFixture(missing.fixture, missing.team, { steps: [acceptedSteps[2]] });
  assert.ok(!state.posted.some((event) => event.type === 'approval-request'));
  assert.deepEqual(await readdir(missing.drafts), []);
});

test('an intervening draft leaf stays intact and an alias cannot become the selected target', async () => {
  const subject = await newFixture();
  let target: string | undefined;
  setCasProbe(async (point, file) => {
    if (point !== 'before-rename' || target) return;
    target = file;
    await writeFile(file, 'intervening bytes', { flag: 'wx' });
  });
  try {
    const state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
    assert.ok(target);
    assert.equal(await readFile(target, 'utf8'), 'intervening bytes');
    assert.ok(!state.results.some((result) => result.includes('"state":"draft"')));
    assert.deepEqual(await readdir(subject.drafts), [path.basename(target)]);
    const second = await newFixture();
    const hash = path.basename(target, '.json');
    const scope = selectedInstitutionalScope(second.team);
    assert.ok(scope);
    await symlink(target, path.join(second.drafts, `${hash}.json`));
    await assert.rejects(second.readReview(hash), /outside the workspace|project scope changed/);
  } finally { setCasProbe(undefined); }
});

test('an intervening dangling draft link is rejected at the leaf check', async () => {
  const subject = await newFixture();
  const referent = path.join(subject.drafts, 'missing-referent');
  const transitions: string[] = [];
  let link: string | undefined;
  setCasProbe(async (point, file) => {
    transitions.push(point);
    if (point === 'before-check') {
      link = file;
      await symlink(referent, file);
    }
  });
  try {
    const state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
    assert.ok(link, 'the race arrives at the leaf existence check');
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.equal(await readlink(link), referent);
    await assert.rejects(lstat(referent), { code: 'ENOENT' });
    assert.deepEqual(await readdir(subject.drafts), [path.basename(link)]);
    assert.ok(!state.results.some((result) => result.includes('"state":"draft"')));
    assert.deepEqual(transitions, ['before-check'], 'the dangling link cannot reach the final link step');
  } finally { setCasProbe(undefined); }
});

test('publication can be retried after interruptions without a premature review or duplicate', async () => {
  const subject = await newFixture();
  for (const pointExpected of ['before-rename', 'after-install'] as const) {
    setCasProbe((point) => { if (point === pointExpected) throw new Error('Interruption fixture'); });
    try {
      const state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
      assert.ok(!state.results.some((result) => result.includes('"state":"draft"')));
      assert.equal((await readdir(subject.drafts)).length, pointExpected === 'before-rename' ? 0 : 1);
    } finally { setCasProbe(undefined); }
  }
  const retry = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
  assert.ok(retry.results.some((result) => result.includes('"state":"draft"')));
  const files = await readdir(subject.drafts);
  assert.equal(files.length, 1);
  const hash = path.basename(files[0], '.json');
  assert.equal((await subject.readReview(hash)).version, hash);
  subject.replaceStaged();
  await assert.rejects(subject.readReview(hash), /staged project/);
});

test('institutional authority is still needed at the exact leaf installation', async () => {
  for (const change of ['source', 'setup', 'activity'] as const) {
    const subject = await newFixture();
    let stop: (() => void) | undefined;
    let reached = false;
    let installs = 0;
    setCasProbe((point) => {
      if (point === 'after-install') installs += 1;
      if (point !== 'before-rename') return;
      reached = true;
      if (change === 'source') subject.reviseSources();
      else if (change === 'setup') subject.replaceStaged();
      else stop?.();
    });
    let result: Awaited<ReturnType<typeof runFixture>>;
    try {
      result = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]], onStart: (cancel) => { stop = cancel; } });
    } finally { setCasProbe(undefined); }
    assert.ok(reached, `${change} control reached the final pre-link probe`);
    assert.equal(installs, 0, `${change} invalidation prevents the native effect`);
    assert.deepEqual(await readdir(subject.drafts), []);
    assert.ok(!result.results.some((value) => value.includes('"state":"draft"')));
    if (change === 'source') {
      const revised = {
        ...brief,
        facts: brief.facts.map((entry) => ({ ...entry, evidence: entry.evidence.map((cite) => ({ ...cite, revision: 'next' })) })),
        dissent: brief.dissent.map((entry) => ({ ...entry, evidence: entry.evidence.map((cite) => ({ ...cite, revision: 'next' })) })),
      };
      const selected = await selectSyntheticInstitutionalCommandGroup(subject.fixture);
      const retry = await runFixture(subject.fixture, selected, { steps: [toolCall('current-draft', draftTool, revised)] });
      assert.ok(retry.results.some((value) => value.includes('"state":"draft"')));
      const files = await readdir(subject.drafts);
      assert.equal(files.length, 1);
      assert.ok((await subject.readReview(path.basename(files[0], '.json'))).sources.every((entry) => entry.revision === 'next'));
    }
  }
});

test('the real gate decision does not authorize a draft after the pinned policy changes', async () => {
  const subject = await newFixture();
  let reached = false;
  let installs = 0;
  setCasProbe((point) => {
    if (point === 'after-install') installs += 1;
    if (point !== 'before-rename') return;
    reached = true;
    subject.changePolicy();
  });
  let state: Awaited<ReturnType<typeof runFixture>>;
  try { state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] }); }
  finally { setCasProbe(undefined); }
  assert.ok(reached, 'the effect reached the last pre-link probe');
  const admitted = state.decisions.find((decision) => decision.api.request.uid === 'draft');
  assert.equal(admitted?.action_id, 1);
  assert.equal(admitted.unmapped.nearAi.bundleHash, subject.fixture.policyHash);
  assert.notEqual(subject.fixture.bundleState().hash, subject.fixture.policyHash);
  assert.equal(installs, 0, 'the replacement policy must hold the exact save');
  assert.deepEqual(await readdir(subject.drafts), []);
  assert.ok(!state.results.some((value) => value.includes('"state":"draft"')));
});

test('the draft gate refuses an independent emergency stop even while the original request stays unchanged', async () => {
  const subject = await newFixture();
  let reached = false;
  let installs = 0;
  setCasProbe((point) => {
    if (point === 'after-install') installs += 1;
    if (point !== 'before-rename') return;
    reached = true;
    subject.stopThroughLiveSettings();
  });
  let state: Awaited<ReturnType<typeof runFixture>>;
  try { state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] }); }
  finally { setCasProbe(undefined); }
  assert.ok(reached);
  assert.deepEqual(state.requestPolicy, { mode: 'fully-autonomous', emergencyStop: false });
  assert.equal(subject.fixture.currentActionSettings().emergencyStop, true);
  assert.equal(state.decisions.find((entry) => entry.api.request.uid === 'draft')?.action_id, 1);
  assert.equal(installs, 0, 'live emergency stop must close the confined save');
  assert.deepEqual(await readdir(subject.drafts), []);
  assert.ok(!state.results.some((value) => value.includes('"state":"draft"')));
});

test('the real selected child cannot save through a same-label runtime with a different actor ID', async () => {
  const subject = await newFixture();
  const state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]], wrongChildActor: true });
  assert.deepEqual(state.offers[0], [readTool, draftTool], 'the actual selected child was offered the confined tools');
  assert.equal(state.decisions.find((entry) => entry.api.request.uid === 'draft')?.action_id, 2,
    'a mismatched runtime actor must receive a denied gate decision');
  assert.ok(!state.posted.some((entry) => entry.type === 'approval-request' ||
    (entry.type === 'permission' && entry.tool === draftTool && entry.decision !== 'denied')));
  assert.deepEqual(await readdir(subject.drafts), []);
  assert.ok(!state.results.some((value) => value.includes('"state":"draft"')));
});

test('the final current-facts check and publication finish before queued fixture changes', async () => {
  const subject = await newFixture();
  let betweenProbeAndInstall = false;
  let target = '';
  let observedBeforeMicrotask: boolean | undefined;
  let queued = false;
  subject.onSourceRead(() => {
    if (!betweenProbeAndInstall || queued) return;
    queued = true;
    queueMicrotask(() => {
      observedBeforeMicrotask = existsSync(target);
      subject.reviseSources();
    });
  });
  setCasProbe((point, file) => {
    if (point === 'before-rename') {
      target = file;
      betweenProbeAndInstall = true;
    } else if (point === 'after-install') betweenProbeAndInstall = false;
  });
  try {
    const state = await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
    assert.equal(observedBeforeMicrotask, true, 'an actual leaf is already linked when the queued change can run');
    assert.deepEqual(await readdir(subject.drafts), [path.basename(target)]);
    const bytes = await readFile(target);
    assert.equal(path.basename(target, '.json'), createHash('sha256').update(bytes).digest('hex'));
    assert.ok(!state.results.some((value) => value.includes('"state":"draft"')), 'the queued revision withholds the now-stale review');
  } finally { setCasProbe(undefined); }
});

test('the shared canonical UTF-8 bound refuses a valid-looking oversized brief before it can publish', async () => {
  const text = 'é'.repeat(3800);
  const subject = await newFixture(text);
  const quote = { ...cite(publicExtracts[0]), end: text.length, quote: text };
  const oversized = { ...brief, facts: Array.from({ length: 6 }, () => ({ text: 'Fictional reading', evidence: Array(4).fill(quote) })) };
  const encoded = JSON.stringify(oversized);
  assert.ok(encoded.length < 128 * 1024 && Buffer.byteLength(encoded) > 128 * 1024, 'the fixture distinguishes characters from bytes');
  const transitions: string[] = [];
  setCasProbe((point) => { transitions.push(point); });
  try {
    const state = await runFixture(subject.fixture, subject.team, { steps: [toolCall('large-draft', draftTool, oversized)] });
    assert.deepEqual(transitions, [], 'the oversized payload cannot reach the writer');
    assert.ok(!state.posted.some((event) => event.type === 'approval-request'));
    assert.equal(state.decisions.find((record) => record.api.request.uid === 'large-draft')?.action_id, 2);
    assert.deepEqual(await readdir(subject.drafts), []);
    assert.ok(!state.results.some((value) => value.includes('"state":"draft"')));
  } finally { setCasProbe(undefined); }
  const smaller = { ...brief, facts: [{ text: 'Fictional reading', evidence: [quote] }] };
  const accepted = await runFixture(subject.fixture, subject.team, { steps: [toolCall('small-draft', draftTool, smaller)] });
  assert.ok(accepted.results.some((value) => value.includes('"state":"draft"')));
  assert.equal((await readdir(subject.drafts)).length, 1);
});

for (const interruption of ['retryable', 'silent'] as const) {
  test(`institutional child remains pinned during ${interruption} interruption after admitted evidence`, async () => {
    const subject = await newFixture();
    const state = await runFixture(subject.fixture, subject.team, { modelInterruption: interruption });
    assert.ok(state.childRequests.some((request) => request.admitted), 'the child sees the first exact extract before interruption');
    assert.deepEqual(state.childRequests.map((request) => request.model), [model, model]);
    assert.deepEqual(state.childRequests.slice(1).map(({ idle, turn }) => [idle, turn]), [[idleDeadline, DEFAULT_TURN_CEILING_MS]]);
    assert.deepEqual(await readdir(subject.drafts), []);
    assert.ok(!state.results.some((value) => value.includes('"state":"draft"')));
  });
}

const digest = (value: unknown) => createHash('sha256').update(canonicalBytes(value)).digest('hex');

async function newRegisterFixture() {
  const subject = await newFixture();
  await runFixture(subject.fixture, subject.team, { steps: [acceptedSteps[2]] });
  const [file] = await readdir(subject.drafts);
  assert.ok(file);
  const briefVersion = path.basename(file, '.json');
  const briefReview = await subject.readReview(briefVersion);
  const staged = await stageInstitutionalSetup(subject.fixture.root, { label: 'Institutional G3 Action Register', team: registerTeam });
  const directory = path.join(subject.fixture.root, registerDirectory);
  await mkdir(directory, { recursive: true });
  const narratives = ['Facilities will prepare the office-hours notice. Desk lead confirmed receipt.',
    'The second action depends on the staffing review. The chair still needs to assign a person and date.'];
  const sources: InstitutionalBriefSource[] = narratives.map((text, index) => ({
    id: `office-actions-${index}`, revision: '1', date: '2026-11-02', label: 'org/Public', text,
    project: briefReview.project, spans: [{ start: 0, end: text.length }],
  }));
  const evidence = (index: number) => [{ sourceId: sources[index].id, revision: '1', start: 0, end: sources[index].text.length, quote: sources[index].text }];
  const decisionId = 'office-hours-accepted';
  const rows = [
    { decisionId, actionId: 'draft-notice', text: 'Prepare the office-hours notice.', owner: 'facilities-desk', dueDate: '2026-11-05',
      acceptanceCriteria: 'Draft ready for the chair.', dependencies: [], exceptions: [],
      acknowledgments: [{ owner: 'facilities-desk', date: '2026-11-02', evidence: evidence(0) }], evidence: evidence(0) },
    { decisionId, actionId: 'staffing-review', text: 'Review staffing before the office-hours change.', owner: null, dueDate: null,
      acceptanceCriteria: 'Staffing options provided to the chair.', dependencies: [{ id: 'staffing-input', crossProgramme: true }],
      exceptions: ['Chair to resolve assignment and date.'], acknowledgments: [], evidence: evidence(1) },
  ];
  const roster = { revision: '1', owners: [{ actionId: 'draft-notice', owner: 'facilities-desk' }] };
  const chair = testSigner();
  let acceptanceState = 'active';
  const asOf = '2026-11-06';
  const chairClaim = {
    schema: 1, purpose: 'fictional-office-hours-j3-07', disposition: 'accepted', chair: 'fictional-office-chair',
    decisionId, revision: '2', project: briefReview.project, directory: briefReview.directory, echelon: 'L3',
    briefVersion, briefReviewDigest: digest(briefReview), expiresAt: '2026-11-08T00:00:00.000Z', asOf,
    rosterRevision: roster.revision, rosterDigest: digest(roster),
    sourceDigests: sources.map((source) => ({ id: source.id, hash: institutionalSourceHash(source) })), actions: rows,
  };
  const accepted = signPayload(chair, 'staff-decision', chairClaim, { memberId: 'fictional-office-chair', now: () => new Date('2026-11-02T00:00:00.000Z') });
  let envelope: unknown = accepted;
  let revision = '2';
  let now = Date.parse(`${asOf}T12:00:00.000Z`);
  const fixture = {
    ...subject.fixture,
    readStaged: () => staged, currentSources: () => sources,
    actionAuthority: {
      predecessorTeam: subject.team,
      chair: { fingerprint: chair.fingerprint, publicKey: chair.publicKey },
      readPredecessor: () => subject.readReview(briefVersion),
      current: () => ({ envelope, decisionId, revision, state: acceptanceState, roster, now }),
    },
  };
  const team = await selectSyntheticInstitutionalJ3ActionRegister(fixture);
  return {
    ...subject, fixture, team, directory, accepted, rows, briefReview,
    useReviewOnly: () => { envelope = briefReview; },
    tamper: () => { envelope = { ...accepted, payload: { ...chairClaim, disposition: 'declined' } }; },
    supersede: () => { revision = '3'; },
    expire: () => { now = Date.parse('2026-11-08T00:00:00.000Z'); },
    revoke: () => { acceptanceState = 'revoked'; },
  };
}

test('the staged real J3 child saves one cited office-hours register from separate signed chair evidence', async () => {
  const subject = await newRegisterFixture();
  const result = await runFixture(subject.fixture, subject.team, { steps: [
    toolCall('action-evidence', readRegister, { sourceId: 'office-actions-0' }),
    toolCall('action-register', saveRegister, { productId: 'office-hours-register', rows: [...subject.rows, subject.rows[0]] }),
  ] });
  assert.deepEqual(result.offers[0], [readRegister, saveRegister]);
  assert.ok(result.results.some((entry) => entry.includes(subject.rows[0].evidence[0].quote)));
  assert.ok(!result.posted.some((entry) => entry.type === 'approval-request'));
  const [file, ...others] = await readdir(subject.directory);
  assert.ok(file);
  assert.deepEqual(others, []);
  const bytes = await readFile(path.join(subject.directory, file));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(file, `${version}.json`);
  assert.ok(result.results.some((entry) => entry.includes(version)));
  const saved = JSON.parse(bytes.toString());
  assert.equal(saved.duty, 'J3-07');
  assert.equal(saved.kind, 'action-register');
  assert.equal(saved.predecessor.version, subject.briefReview.version);
  assert.equal(saved.predecessor.envelopeDigest, digest(subject.accepted));
  assert.equal(saved.predecessor.decisionId, 'office-hours-accepted');
  assert.equal(saved.predecessor.revision, '2');
  assert.equal(saved.predecessor.signer, subject.accepted.signer.fingerprint);
  assert.equal(saved.body.rows.length, 2);
  assert.equal(saved.body.rows[0].overdue, true);
  assert.equal(saved.body.rows[1].owner, null);
  assert.equal(saved.body.rows[1].dueDate, null);
  assert.deepEqual(saved.body.rows[1].humanHandoff, { branch: 'J5', dependencyIds: ['staffing-input'] });
  const gate = result.decisions.find((entry) => entry.api.request.uid === 'action-register');
  assert.deepEqual(gate?.unmapped.nearAi.capability, { verb: 'workspaceWrite', paths: [`${registerDirectory}/${file}`] });
  const scope = selectedInstitutionalScope(subject.team);
  assert.ok(scope);
  assert.equal((await readInstitutionalDraftReview(scope, resolveInWorkspace, version)).version, version);
  subject.revoke();
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|changed/);
  assert.deepEqual(await readdir(subject.directory), [file]);
});

test('the J3 child holds a mere review, invalid or stale chair evidence, and unsupported facts', async () => {
  for (const change of ['useReviewOnly', 'tamper', 'supersede', 'expire', 'unsupported'] as const) {
    const subject = await newRegisterFixture();
    const rows = change === 'unsupported' ? subject.rows.map((row) => ({ ...row, dueDate: '2027-01-01' })) : subject.rows;
    if (change !== 'unsupported') subject[change]();
    const result = await runFixture(subject.fixture, subject.team, {
      steps: [toolCall('invalid-register', saveRegister, { productId: 'office-hours-register', rows })],
    });
    assert.ok(!result.posted.some((entry) => entry.type === 'approval-request'));
    assert.ok(!result.decisions.some((entry) => entry.api.request.uid === 'invalid-register' && entry.action_id === 1), change);
    assert.deepEqual(await readdir(subject.directory), [], change);
    assert.ok(!result.results.some((entry) => entry.includes('"state":"draft"')));
  }
});

test('late J3 policy, decision and Command Group authority changes hold the exact local write', async (t) => {
  for (const change of ['changePolicy', 'supersede', 'replaceBrief', 'reviseSources', 'replaceStaged'] as const) {
    await t.test(change, async () => {
      const subject = await newRegisterFixture();
      const predecessor = path.join(subject.drafts, `${subject.briefReview.version}.json`);
      const predecessorBytes = await readFile(predecessor);
      const j3Before = digest({ staged: subject.fixture.readStaged(), sources: subject.fixture.currentSources(), authority: subject.fixture.actionAuthority.current() });
      let reached = false;
      setCasProbe((point) => {
        if (point !== 'before-rename') return;
        reached = true;
        if (change === 'replaceBrief') writeFileSync(predecessor, 'Changed fictional predecessor');
        else subject[change]();
      });
      try {
        const result = await runFixture(subject.fixture, subject.team, {
          steps: [toolCall('changed-register', saveRegister, { productId: 'office-hours-register', rows: subject.rows })],
        });
        assert.ok(reached && result.decisions.some((entry) => entry.api.request.uid === 'changed-register' && entry.action_id === 1));
        if (change === 'reviseSources' || change === 'replaceStaged') {
          assert.deepEqual(await readFile(predecessor), predecessorBytes, 'the published predecessor bytes are still exact');
          assert.equal(digest({ staged: subject.fixture.readStaged(), sources: subject.fixture.currentSources(), authority: subject.fixture.actionAuthority.current() }),
            j3Before, 'the current J3 decision, extracts and staged role are unchanged');
          assert.equal(subject.fixture.bundleState().hash, subject.fixture.policyHash);
        }
        assert.deepEqual(await readdir(subject.directory), [], 'no action register is installed');
        assert.ok(!result.results.some((entry) => entry.includes('"state":"draft"')));
        if (change === 'reviseSources' || change === 'replaceStaged') {
          const attempt = await runFixture(subject.fixture, subject.team, { steps: [toolCall('held-evidence', readRegister, { sourceId: 'office-actions-0' })] });
          assert.ok(!attempt.results.some((entry) => entry.includes(subject.rows[0].evidence[0].quote)));
        }
      } finally { setCasProbe(undefined); }
    });
  }
});

test('a changed Command Group predecessor after J3 tool offer withholds the same-run quote', async () => {
  const subject = await newRegisterFixture();
  const predecessor = path.join(subject.drafts, `${subject.briefReview.version}.json`);
  const previous = await readFile(predecessor);
  const j3Before = digest({ staged: subject.fixture.readStaged(), sources: subject.fixture.currentSources(), authority: subject.fixture.actionAuthority.current() });
  const result = await runFixture(subject.fixture, subject.team, {
    steps: [
      toolCall('stale-quote', readRegister, { sourceId: 'office-actions-0' }),
      toolCall('stale-quote-draft', saveRegister, { productId: 'office-hours-register', rows: subject.rows }),
    ],
    onChildTurn(turn) {
      if (turn === 0) writeFileSync(predecessor, 'Changed fictional predecessor before the quote');
    },
  });
  assert.deepEqual(result.offers[0], [readRegister, saveRegister]);
  assert.notDeepEqual(await readFile(predecessor), previous);
  assert.equal(digest({ staged: subject.fixture.readStaged(), sources: subject.fixture.currentSources(), authority: subject.fixture.actionAuthority.current() }), j3Before);
  assert.equal(subject.fixture.bundleState().hash, subject.fixture.policyHash);
  assert.deepEqual(result.decisions.find((decision) => decision.api.request.uid === 'stale-quote')?.unmapped.nearAi.capability, { verb: 'plan' });
  assert.ok(!result.results.some((entry) => entry.includes(subject.rows[0].evidence[0].quote)), 'the actual child must receive no quote');
  assert.ok(!result.results.some((entry) => entry.includes('"state":"draft"')));
  assert.deepEqual(await readdir(subject.directory), []);
});

async function newObservationFixture(splitFindingsEvidence = false) {
  const subject = await newFixture();
  const staged = await stageInstitutionalSetup(subject.fixture.root, { label: 'Institutional G7 Lessons', team: observationTeam, keySegment: 'j7Lessons' });
  const directory = path.join(subject.fixture.root, observationDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const sources: InstitutionalBriefSource[] = [
    { id: 'office-observer-note', revision: '1', date: '2026-11-02', label: 'org/Public', project,
      text: 'The observer saw the fictional office open at 08:00.', spans: [] },
    { id: 'office-desk-report', revision: '2', date: '2026-11-02', label: 'org/Public', project,
      text: 'The desk reviewer reported 08:10 and noted a possibly duplicate office-hours entry.', dissentAttribution: 'Desk reviewer', spans: [] },
    { id: 'office-opening-clock', revision: '4', date: '2026-11-02', label: 'org/Public', project,
      text: 'The independent office entry clock records an 08:00 opening.', spans: [] },
  ].map((source) => ({ ...source, label: 'org/Public', spans: [{ start: 0, end: source.text.length }] }));
  const addSpan = (index: number, append: string) => {
    const source = sources[index];
    const start = source.text.length + 1;
    const end = start + append.length;
    sources[index] = { ...source, text: `${source.text} ${append}`, spans: [...source.spans, { start, end }] };
  };
  if (splitFindingsEvidence) {
    addSpan(0, 'The notice board was repainted.');
    addSpan(0, 'The tea order was recorded.');
    addSpan(1, 'The desk reviewer disputes the opening time.');
  }
  const citeAt = (index: number, span = 0) => {
    const { start, end } = sources[index].spans[span];
    return [{ sourceId: sources[index].id, revision: sources[index].revision, start, end, quote: sources[index].text.slice(start, end) }];
  };
  const productId = 'trial-morning';
  const time = '2026-11-02T08:00:00.000Z';
  const approval = {
    project, directory: String(staged.directoryDigest), access: 'org/Public' as const, productId, time, timeKind: 'observed' as const,
    people: [
      { id: 'office-observer', sourceIds: [sources[0].id], kind: 'observer' as const },
      { id: 'desk-reviewer', sourceIds: [sources[1].id], kind: 'reporter' as const },
    ],
    relatedObservationIds: ['trial-desk-entry'],
    corroborations: [{ kind: 'observed', personId: 'office-observer', text: 'The observer saw an 08:00 opening.',
      evidence: [...citeAt(0), ...citeAt(2)] }],
    correction: null as { version: string; reason: string; evidence: ReturnType<typeof citeAt> } | null,
  };
  let current = approval;
  let admitted = sources;
  const fixture = {
    ...subject.fixture, readStaged: () => staged, currentSources: () => admitted, currentObservation: () => current,
  };
  const team = await selectSyntheticInstitutionalJ7Observation(fixture);
  const body = {
    productId, time, timeKind: 'observed',
    statements: [
      { kind: 'observed', personId: 'office-observer', text: 'The observer saw an 08:00 opening.', confidence: 'low', evidence: citeAt(0) },
      { kind: 'reported', personId: 'desk-reviewer', text: 'The desk reviewer reported an 08:10 opening.', confidence: 'low', evidence: citeAt(1) },
    ],
    relatedObservations: ['trial-desk-entry'],
    potentialDuplicates: [{ observationId: 'trial-desk-entry', reason: 'The report mentions a possibly duplicate entry for the trial.',
      evidence: splitFindingsEvidence ? [...citeAt(1), ...citeAt(2)] : citeAt(1) }],
    dissent: [{ attribution: 'Desk reviewer', text: 'The reported time differs from the observation.', evidence: citeAt(1, splitFindingsEvidence ? 1 : 0) }],
  };
  return {
    ...subject, fixture, team, directory, body, sources,
    correct: (version: string) => {
      current = { ...approval, correction: { version, reason: 'Record the desk account as conflicting rather than resolved.', evidence: citeAt(1) } };
    },
    support: citeAt(2), citeAt,
    withdrawCorroboration: () => { current = { ...current, corroborations: [] }; },
    withdrawReport: () => { admitted = [sources[0]]; },
  };
}

test('the registered J7 fixture preserves attributed office-hours observations and an exact correction', async () => {
  const subject = await newObservationFixture();
  const { fixture, team, body, directory } = subject;
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const steps = [toolCall('office-observer-evidence', readObservation, { sourceId: subject.sources[0].id }),
    toolCall('observation', saveObservation, body)];
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; subject.changePolicy(); } });
  try {
    const held = await runFixture(fixture, team, { steps });
    assert.ok(entered && held.decisions.some((decision) => decision.api.request.uid === 'observation' && decision.action_id === 1));
    assert.deepEqual(await readdir(directory), [], 'a late policy change holds the actual J7 file');
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
  } finally { setCasProbe(undefined); }
  subject.restorePolicy();
  const initial = await runFixture(fixture, team, { steps });
  assert.deepEqual(initial.offers[0], [readObservation, saveObservation]);
  assert.ok(initial.results.some((entry) => entry.includes(subject.sources[0].text)));
  const [first] = await readdir(directory);
  assert.ok(first);
  const firstBytes = await readFile(path.join(directory, first));
  const firstVersion = createHash('sha256').update(firstBytes).digest('hex');
  assert.equal(first, `${firstVersion}.json`);
  assert.ok(initial.results.some((entry) => entry.includes(firstVersion)));
  const stored = JSON.parse(firstBytes.toString());
  assert.equal(stored.duty, 'J7-09');
  assert.equal(stored.kind, 'observation');
  assert.equal(stored.access, 'org/Public');
  assert.equal(stored.body.statements[0].corroboration, 'unconfirmed');
  assert.equal(stored.body.statements[1].kind, 'reported');
  assert.equal(stored.body.statements[1].confidence, 'low');
  assert.deepEqual(stored.body.dissent, body.dissent);
  assert.equal(stored.sources.length, 2);
  assert.ok(stored.sources.every((source: InstitutionalBriefSource) => source.label === 'org/Public'));
  assert.deepEqual(stored.body.potentialDuplicates, body.potentialDuplicates);
  assert.deepEqual(initial.decisions.find((entry) => entry.api.request.uid === 'observation')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${observationDirectory}/${first}`] });
  assert.equal((await readInstitutionalDraftReview(scope, resolveInWorkspace, firstVersion)).version, firstVersion);

  subject.correct(firstVersion);
  const corrected = await runFixture(fixture, team, { steps: [
    toolCall('corrected-observation', saveObservation, { ...body, statements: [body.statements[0], { ...body.statements[1], text: 'The desk account reports 08:10 and conflicts with the observation.' }] }),
  ] });
  const pair = await readdir(directory);
  assert.equal(pair.length, 2);
  const second = pair.find((entry) => entry !== first)!;
  const secondVersion = path.basename(second, '.json');
  const observed = JSON.parse((await readFile(path.join(directory, second))).toString());
  assert.equal(observed.productId, stored.productId);
  assert.equal(observed.correction.version, firstVersion);
  assert.match(observed.correction.reason, /conflicting/);
  assert.deepEqual(observed.correction.evidence, body.dissent[0].evidence);
  assert.deepEqual(await readFile(path.join(directory, first)), firstBytes);
  assert.ok(corrected.results.some((entry) => entry.includes(secondVersion)));
  assert.equal((await readInstitutionalDraftReview(scope, resolveInWorkspace, secondVersion)).version, secondVersion);

  subject.withdrawReport();
  for (const version of [firstVersion, secondVersion]) {
    await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|admitted|changed/);
  }
  const withheld = await runFixture(fixture, team, { steps: [toolCall('withdrawn-extract', readObservation, { sourceId: subject.sources[1].id })] });
  assert.ok(!withheld.results.some((entry) => entry.includes(subject.sources[1].text)));
  assert.deepEqual(await readdir(directory), pair);
});

test('the real J7 child confirms corroboration only for the exact fixture-approved statement and evidence set', async () => {
  const subject = await newObservationFixture();
  const [observed, reported] = subject.body.statements;
  const contested = { ...observed, confidence: 'high', evidence: [...observed.evidence, ...reported.evidence] };
  const held = await runFixture(subject.fixture, subject.team, {
    steps: [toolCall('contested-confidence', saveObservation, { ...subject.body, statements: [contested, reported] })],
  });
  assert.deepEqual(held.offers[0], [readObservation, saveObservation]);
  assert.deepEqual(await readdir(subject.directory), [], 'two opposing accounts cannot authorize a high-confidence draft');
  assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
  assert.ok(!held.posted.some((entry) => entry.type === 'approval-request'));

  const extra = { ...contested, confidence: 'low', evidence: [...contested.evidence, ...subject.support] };
  await runFixture(subject.fixture, subject.team, {
    steps: [toolCall('extra-unapproved-support', saveObservation, { ...subject.body, statements: [extra, reported] })],
  });
  const [unconfirmed] = await readdir(subject.directory);
  assert.ok(unconfirmed);
  const mixed = JSON.parse((await readFile(path.join(subject.directory, unconfirmed))).toString());
  assert.equal(mixed.body.statements[0].corroboration, 'unconfirmed', 'an extra conflicting cite cannot stand in for the approved set');

  const supported = { ...observed, text: `  ${observed.text}  `, confidence: 'high', evidence: [...subject.support, ...observed.evidence] };
  const positive = await runFixture(subject.fixture, subject.team, {
    steps: [toolCall('exact-support', saveObservation, { ...subject.body, statements: [supported, reported] })],
  });
  const drafts = await readdir(subject.directory);
  assert.equal(drafts.length, 2);
  const confirmed = drafts.find((file) => file !== unconfirmed)!;
  const exact = JSON.parse((await readFile(path.join(subject.directory, confirmed))).toString());
  assert.equal(exact.body.statements[0].corroboration, 'confirmed');
  assert.equal(exact.body.statements[0].confidence, 'high');
  assert.equal(exact.body.statements[0].text, observed.text);
  assert.deepEqual(exact.body.dissent, subject.body.dissent);
  const version = path.basename(confirmed, '.json');
  assert.ok(positive.results.some((entry) => entry.includes(version)));
  const scope = selectedInstitutionalScope(subject.team);
  assert.ok(scope);
  assert.equal((await readInstitutionalDraftReview(scope, resolveInWorkspace, version)).version, version);
  subject.withdrawCorroboration();
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|changed|admitted/);
  assert.deepEqual(await readdir(subject.directory), drafts);
});

async function newFindingsFixture() {
  const subject = await newObservationFixture(true);
  await runFixture(subject.fixture, subject.team, { steps: [toolCall('eligible-observation', saveObservation, subject.body)] });
  const [file] = await readdir(subject.directory);
  assert.ok(file);
  const version = path.basename(file, '.json');
  const scope = selectedInstitutionalScope(subject.team);
  assert.ok(scope);
  const readObservationReview = async () => {
    const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
    assert.equal(review.kind, 'observation');
    return review;
  };
  const observation = await readObservationReview();
  const additional: InstitutionalBriefSource[] = [
    { id: 'office-trial-objective', revision: '2', date: '2026-11-02', label: 'org/Public', project: observation.project,
      text: 'The fictional office trial sought shorter morning queue waits.', spans: [] },
    { id: 'office-trial-aggregate', revision: '5', date: '2026-11-06', label: 'org/Public', project: observation.project,
      text: 'The deadline has passed and median queue time is lower. No implementation record is supplied.', spans: [] },
  ];
  for (const [index, source] of additional.entries()) additional[index] = { ...source, spans: [{ start: 0, end: source.text.length }] };
  const citeSource = (source: InstitutionalBriefSource) => [{ sourceId: source.id, revision: source.revision, start: 0,
    end: source.text.length, quote: source.text }];
  const disclosure = {
    purpose: 'fictional-office-hours-j7-10', project: observation.project, directory: observation.directory, echelon: 'L3',
    state: 'approved-for-draft', productId: 'trial-morning-findings', observationVersion: observation.version, observationReviewDigest: digest(observation),
    observationEvidence: [...subject.citeAt(0), ...subject.citeAt(0, 1), ...subject.citeAt(1, 1)],
    objective: { id: 'shorter-queue-waits', revision: '2', evidence: citeSource(additional[0]) },
    corroboratingEvidence: citeSource(additional[1]),
    owner: 'fictional-desk-owner', subjectMatterExpert: 'fictional-queue-reviewer',
    approver: { person: 'fictional-office-review-chair', level: 'fictional-brigade-l3' },
  };
  let current = disclosure;
  const fixture = {
    ...subject.fixture,
    currentSources: () => [...subject.fixture.currentSources(), ...additional],
    findingsAuthority: { predecessorTeam: subject.team, readObservation: readObservationReview, current: () => current },
  };
  const team = await selectSyntheticInstitutionalJ7Findings(fixture);
  const directory = path.join(subject.fixture.root, findingsDirectory);
  await mkdir(directory, { recursive: true });
  const candidate = {
    text: 'Reduced median queue time is a candidate result.',
    direct: subject.citeAt(0), corroborating: citeSource(additional[1]),
    conflicting: subject.citeAt(1, 1), alternateExplanations: ['Arrival volume may have fallen.'],
    uncertainty: 'No controlled comparison is available.',
    recommendation: 'Request the administrative implementation log for review.',
    implementationEvidence: 'Dated records showing the revised opening hours were used.',
    independentCheck: 'A reviewer compares the implementation record with queue measurements.',
  };
  const body = { productId: disclosure.productId, candidates: [candidate], dissent: subject.body.dissent,
    limitations: [{ gap: 'Implementation is unverified.', resolve: 'Obtain the dated opening-hours record.' }] };
  return { fixture, team, directory, body, observation, aggregate: additional[1], objective: additional[0],
    uncited: subject.citeAt(0, 1), undisclosed: subject.citeAt(0, 2), excludedSource: subject.sources[2],
    withdrawDissent: () => { current = { ...disclosure, observationEvidence: subject.citeAt(0) }; },
    restoreDisclosure: () => { current = disclosure; },
    supersede: () => { current = { ...disclosure, state: 'superseded' }; } };
}

test('exact J7-10 candidate findings stay open for independent human validation', async () => {
  const subject = await newFindingsFixture();
  const unsupported = await runFixture(subject.fixture, subject.team, { steps: [
    toolCall('unsupported-finding-state', saveFindings, { ...subject.body, validation: 'closed', release: true }),
  ] });
  assert.deepEqual(await readdir(subject.directory), []);
  assert.ok(!unsupported.posted.some((entry) => entry.type === 'approval-request'));
  assert.ok(!unsupported.decisions.some((entry) => entry.api.request.uid === 'unsupported-finding-state' && entry.action_id === 1));
  const badDirect = await runFixture(subject.fixture, subject.team, { steps: [
    toolCall('uncited-span-as-direct', saveFindings, { ...subject.body, candidates: [{ ...subject.body.candidates[0], direct: subject.uncited }] }),
    toolCall('dissent-as-direct', saveFindings, { ...subject.body, candidates: [{ ...subject.body.candidates[0], direct: subject.body.dissent[0].evidence }] }),
  ] });
  assert.deepEqual(await readdir(subject.directory), []);
  assert.ok(!badDirect.results.some((entry) => entry.includes('"state":"draft"')));
  assert.ok(!badDirect.decisions.some((entry) => ['uncited-span-as-direct', 'dissent-as-direct'].includes(entry.api.request.uid) && entry.action_id === 1));
  const valid = await runFixture(subject.fixture, subject.team, { steps: [
    toolCall('direct-evidence', readObservation, { sourceId: subject.body.candidates[0].direct[0].sourceId }),
    toolCall('dissent-evidence', readObservation, { sourceId: subject.body.dissent[0].evidence[0].sourceId }),
    toolCall('excluded-evidence', readObservation, { sourceId: subject.excludedSource.id }),
    toolCall('findings-evidence', readObservation, { sourceId: subject.aggregate.id }),
    toolCall('findings', saveFindings, subject.body),
  ] });
  assert.deepEqual(valid.offers[0], [saveFindings, readObservation].sort());
  const offeredSources = (valid.readOffers[0] as { properties: { sourceId: { enum: string[] } } }).properties.sourceId.enum;
  const direct = subject.body.candidates[0].direct[0];
  const dissent = subject.body.dissent[0].evidence[0];
  assert.deepEqual(offeredSources.sort(), [direct.sourceId, dissent.sourceId, subject.aggregate.id, subject.objective.id].sort());
  for (const quote of [direct.quote, dissent.quote, subject.aggregate.text]) assert.ok(valid.results.some((entry) => entry.includes(quote)));
  for (const quote of [subject.uncited[0].quote, subject.undisclosed[0].quote, subject.excludedSource.text]) {
    assert.ok(!valid.results.some((entry) => entry.includes(quote)));
  }
  const [file, ...others] = await readdir(subject.directory);
  assert.ok(file);
  assert.deepEqual(others, []);
  const bytes = await readFile(path.join(subject.directory, file));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(file, `${version}.json`);
  assert.ok(valid.results.some((entry) => entry.includes(version)));
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J7-10');
  assert.equal(draft.kind, 'findings');
  assert.equal(draft.observation.version, subject.observation.version);
  assert.equal(draft.observation.verification, 'unverified-draft');
  assert.equal(draft.objective.id, 'shorter-queue-waits');
  assert.equal(draft.validation, 'open');
  assert.equal(draft.release, 'disabled');
  assert.deepEqual(draft.reasoningReview, { person: 'fictional-queue-reviewer', state: 'pending' });
  assert.deepEqual(draft.requiredApproval, { person: 'fictional-office-review-chair', level: 'fictional-brigade-l3' });
  assert.equal(draft.owner, 'fictional-desk-owner');
  assert.deepEqual(draft.body.candidates, subject.body.candidates);
  assert.deepEqual(draft.body.dissent, subject.body.dissent);
  assert.deepEqual(draft.body.limitations, subject.body.limitations);
  assert.deepEqual(draft.observation.sources.map((source: InstitutionalBriefSource) => source.id).sort(), [direct.sourceId, dissent.sourceId].sort());
  const scope = selectedInstitutionalScope(subject.team);
  assert.ok(scope);
  assert.equal((await readInstitutionalDraftReview(scope, resolveInWorkspace, version)).version, version);
  const withdrawn = await runFixture(subject.fixture, subject.team, {
    steps: [toolCall('withdrawn-dissent', readObservation, { sourceId: dissent.sourceId })],
    onChildTurn(turn) { if (turn === 0) subject.withdrawDissent(); },
  });
  const previousOffer = (withdrawn.readOffers[0] as { properties: { sourceId: { enum: string[] } } }).properties.sourceId.enum;
  assert.ok(previousOffer.includes(dissent.sourceId), 'the actual child had already received the old evidence offer');
  assert.ok(!withdrawn.results.some((entry) => entry.includes(dissent.quote)));
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|admitted|changed/);
  subject.restoreDisclosure();
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; subject.supersede(); } });
  try {
    const revised = { ...subject.body, candidates: [{ ...subject.body.candidates[0], text: 'The apparent improvement still needs validation.' }] };
    const held = await runFixture(subject.fixture, subject.team, { steps: [toolCall('stale-findings', saveFindings, revised)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'stale-findings' && entry.action_id === 1));
    assert.deepEqual(await readdir(subject.directory), [file]);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
  } finally { setCasProbe(undefined); }
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|admitted|changed/);
});

test('registered G2 catalogue projects exact fictional metadata and gives the same unavailable result for hidden and missing records', async () => {
  const subject = await newFixture();
  const { root } = subject.fixture;
  const label = 'Institutional G2 Records Catalogue';
  const staged = await stageInstitutionalSetup(root, {
    label, team: catalogueTeam, keySegment: 'j2RecordsCatalogue',
    checkPrompts(requests) {
      const choice = requests[0].items.find((item) => item.label === label);
      assert.match(choice?.detail ?? '', /fictional domain steward decides .*which fields people can see/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      const action = confirmation.items.find((item) => item.label === '$(check) Set up the team');
      assert.match(action?.detail ?? '', /stages the .*office records catalogue draft skill in this editor profile/i);
      assert.match(confirmation.placeHolder ?? '', /domain steward decides .*choose .* to stage/i);
      const steward = confirmation.items.find((item) => item.label === '$(person) Fictional domain steward');
      assert.match(steward?.detail ?? '', /reviews the catalogue draft.*which fields people can see/i);
    },
  });
  const directory = path.join(root, catalogueDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const source = (id: string, text: string): InstitutionalBriefSource => ({
    id, revision: 'r1', date: '2026-11-02', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }],
  });
  const sources = [
    source('office-steward-receipt', 'The fictional domain steward recorded this metadata scope.'),
    source('office-custodian-inventory', 'The fictional custodian confirmed an administrative inventory reference.'),
  ];
  const evidence = ({ id, revision }: InstitutionalBriefSource, role: string) => ({ sourceId: id, revision, role });
  const steward = evidence(sources[0], 'fictional-domain-steward');
  const id = 'item-4d37a801';
  const ineligible = 'item-7e50ab12';
  const missing = 'item-13d958be';
  const hiddenField = 'Unshared desk procedure';
  const hiddenRow = 'Unshared paper schedule';
  const row = {
    id, confirmed: true, fields: { title: 'Fictional office opening-hours register', description: hiddenField },
    scope: 'uncertain', availability: 'documented', freshness: 'current', handling: 'local-review-only',
    custodian: evidence(sources[1], 'fictional-records-custodian'),
  };
  const inventory = [row, { ...row, id: ineligible, confirmed: false, fields: { title: hiddenRow } }];
  const receipt = {
    project, directory: staged.directoryDigest, requester: 'fictional-catalogue-reviewer', purpose: 'fictional-office-records-j2-is01',
    policyRevision: 'catalogue-r1', productId: 'office-records-catalogue', steward,
    grants: [{ id, fields: ['title'] }, { id: ineligible, fields: ['title'] }],
  };
  let current = receipt;
  const removeTitle = () => { current = { ...receipt, grants: [{ id, fields: [] }, receipt.grants[1]] }; };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => sources,
    currentCatalogue: () => ({ receipt: current, inventory }) };
  const team = await selectSyntheticInstitutionalJ2Catalogue(fixture);
  const args = { productId: receipt.productId, recordIds: [id] };
  const valid = await runFixture(fixture, team, { steps: [
    toolCall('ineligible-record', readCatalogue, { recordId: ineligible }),
    toolCall('nonexistent-record', readCatalogue, { recordId: missing }),
    toolCall('eligible-record', readCatalogue, { recordId: id }),
    toolCall('model-fields-refused', saveCatalogue, { ...args, fields: { title: 'Model supplied value' } }),
    toolCall('catalogue', saveCatalogue, args),
  ] });
  assert.deepEqual(valid.offers[0], [readCatalogue, saveCatalogue].sort());
  const unavailable = valid.toolResults.get('ineligible-record');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(unavailable, valid.toolResults.get('nonexistent-record'));
  const hiddenLookups = valid.decisions.filter((entry) => ['ineligible-record', 'nonexistent-record'].includes(entry.api.request.uid));
  assert.equal(hiddenLookups.length, 2);
  assert.deepEqual(hiddenLookups.map((entry) => entry.unmapped.nearAi.capability), [{ verb: 'plan' }, { verb: 'plan' }]);
  const result = JSON.parse(valid.toolResults.get('eligible-record')!);
  assert.deepEqual(result.fields, { title: row.fields.title });
  assert.equal(result.scope, 'uncertain');
  assert.equal(result.availability, 'documented');
  assert.equal(result.freshness, 'current');
  assert.equal(result.handling, 'local-review-only');
  assert.equal(result.custodian.role, 'fictional-records-custodian');
  assert.equal(result.steward.role, 'fictional-domain-steward');
  assert.equal(result.custodian.revision, 'r1');
  assert.ok(!valid.decisions.some((entry) => entry.api.request.uid === 'model-fields-refused' && entry.action_id === 1));
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const [file] = files;
  const bytes = await readFile(path.join(directory, file));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(file, `${version}.json`);
  const stored = JSON.parse(bytes.toString());
  assert.deepEqual(stored.body.records, [result]);
  assert.equal(stored.duty, 'J2-IS01');
  assert.equal(stored.steward.role, 'fictional-domain-steward');
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'catalogue')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${catalogueDirectory}/${file}`] });
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  const visibleOutputs = JSON.stringify([valid.catalogueOffers[0], hiddenLookups, unavailable, result, stored, review]);
  for (const value of [ineligible, missing, hiddenField, hiddenRow, sources[1].text, '"description"', '"count"']) {
    assert.ok(!visibleOutputs.includes(value), `unexpected exposed metadata: ${value}`);
  }

  const staleRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-title', readCatalogue, { recordId: id })],
    onChildTurn(turn) { if (turn === 0) removeTitle(); },
  });
  assert.equal(staleRead.toolResults.get('withdrawn-title'), unavailable);
  assert.ok(!staleRead.results.some((entry) => entry.includes(row.fields.title)));
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /current|unavailable|changed/);

  current = { ...receipt, policyRevision: 'catalogue-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; removeTitle(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('late-catalogue', saveCatalogue, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'late-catalogue' && entry.action_id === 1));
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [file]);
  } finally { setCasProbe(undefined); }
});

test('registered G6 drafts the authorized office service and leaves missing ownership for its portfolio owner', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G6 Business Services';
  const staged = await stageInstitutionalSetup(root, {
    label, team: businessServicesTeam, keySegment: 'j6BusinessServices',
    checkPrompts(requests) {
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /business-service catalogue draft skill/);
      const owner = confirmation.items.find((item) => item.label === '$(person) Fictional service portfolio owner');
      assert.match(owner?.detail ?? '', /approves service entries/i);
    },
  });
  const directory = path.join(root, businessServicesDirectory);
  await mkdir(directory, { recursive: true });
  const source = (id: string, text: string): InstitutionalBriefSource => ({
    id, revision: 'r1', date: '2026-11-02', label: 'org/Public', project: String(staged.rootDigest), text,
    spans: [{ start: 0, end: text.length }],
  });
  const sources = [
    source('portfolio-scope-receipt', 'The fictional portfolio owner recorded which service documentation is available for this draft.'),
    source('office-induction-document', 'Fictional service documentation supports the office induction schedule.'),
    source('office-owner-record', 'The fictional induction coordinator is accountable for the scheduling service.'),
    source('office-welcome-desk-note', 'The fictional welcome desk has reviewed how staff ask about scheduling.'),
  ];
  const evidence = ({ id: sourceId, revision }: InstitutionalBriefSource, role: string) => ({ sourceId, revision, role });
  const serviceId = 'item-4d37a902';
  const missingOwnerId = 'item-4d37a903';
  const hiddenId = 'item-4d37a904';
  const hiddenTitle = 'Unshared Office Reservation';
  const supportInstruction = 'Ask the office welcome desk about induction scheduling.';
  const service = {
    id: serviceId, title: 'Office Induction Scheduling',
    document: evidence(sources[1], 'fictional-service-documenter'),
    owner: evidence(sources[2], 'fictional-induction-coordinator'),
    reviewDate: '2026-12-10', supportHours: '08:00-16:00 weekdays',
    userGroups: ['new-office-starters'], dependencies: ['office-room-calendar'], freshness: 'current',
    supportRoute: { desk: 'office-welcome-desk', instruction: 'ask-for-induction-scheduling',
      source: evidence(sources[3], 'fictional-office-welcome-desk') },
  };
  const services = [service, { ...service, id: missingOwnerId, title: 'Office Orientation Sign-In', owner: undefined, supportRoute: undefined },
    { ...service, id: hiddenId, title: hiddenTitle }];
  const fields = ['title', 'owner', 'review-date', 'support-hours', 'user-groups', 'dependencies', 'support-route'];
  const receipt = {
    project: staged.rootDigest, directory: staged.directoryDigest, requester: 'fictional-service-reviewer',
    purpose: 'fictional-office-services-j6-it01', policyRevision: 'service-r1', productId: 'office-business-services',
    portfolioOwner: evidence(sources[0], 'fictional-service-portfolio-owner'),
    grants: [{ id: serviceId, fields }, { id: missingOwnerId, fields }],
  };
  let current = receipt;
  const withdrawRoute = () => { current = { ...current, grants: [{ id: serviceId, fields: fields.filter((field) => field !== 'support-route') }, receipt.grants[1]] }; };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => sources,
    currentBusinessServices: () => ({ receipt: current, services }) };
  const team = await selectSyntheticInstitutionalJ6BusinessServices(fixture);
  const args = { productId: receipt.productId, recordIds: [serviceId, missingOwnerId] };
  const run = await runFixture(fixture, team, { steps: [
    toolCall('office-service', readBusinessService, { recordId: serviceId }),
    toolCall('hidden-service', readBusinessService, { recordId: hiddenId }),
    toolCall('missing-service', readBusinessService, { recordId: 'item-4d37a905' }),
    toolCall('business-services', saveBusinessServices, args),
  ] });
  assert.deepEqual(run.offers[0], [readBusinessService, saveBusinessServices].sort());
  const unavailable = run.toolResults.get('hidden-service');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(unavailable, run.toolResults.get('missing-service'));
  const [file] = await readdir(directory);
  assert.ok(file);
  const bytes = await readFile(path.join(directory, file));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(file, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J6-IT01');
  assert.equal(draft.portfolioOwner.role, 'fictional-service-portfolio-owner');
  assert.equal(draft.portfolioDecision, 'pending');
  const [entry, exception] = draft.body.records;
  assert.deepEqual(entry, JSON.parse(run.toolResults.get('office-service')!));
  assert.equal(entry.title, service.title);
  assert.equal(entry.owner.role, service.owner.role);
  assert.equal(entry.reviewDate, service.reviewDate);
  assert.equal(entry.supportHours, service.supportHours);
  assert.deepEqual(entry.userGroups, service.userGroups);
  assert.deepEqual(entry.dependencies, service.dependencies);
  assert.equal(entry.document.revision, sources[1].revision);
  assert.equal(entry.supportRoute.instruction, supportInstruction);
  assert.equal(entry.supportRoute.desk, 'Office welcome desk');
  assert.equal(entry.state, 'proposed');
  assert.equal(exception.state, 'exception');
  assert.ok(!Object.hasOwn(exception, 'owner'));
  assert.ok(exception.openIssues.includes('owner-unresolved'));
  assert.deepEqual(run.decisions.find((entry) => entry.api.request.uid === 'business-services')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${businessServicesDirectory}/${file}`] });
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  for (const value of [hiddenId, hiddenTitle, sources[3].text]) {
    assert.ok(!JSON.stringify([run.catalogueOffers[0], draft, review, run.results]).includes(value));
  }

  const heldRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-route', readBusinessService, { recordId: serviceId })],
    onChildTurn(turn) { if (turn === 0) withdrawRoute(); },
  });
  assert.equal(heldRead.toolResults.get('withdrawn-route'), unavailable);
  assert.ok(!heldRead.results.some((entry) => entry.includes(supportInstruction)));
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), /changed|unavailable|current/);

  current = { ...receipt, policyRevision: 'service-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; withdrawRoute(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('late-business-services', saveBusinessServices, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'late-business-services' && entry.action_id === 1));
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [file]);
  } finally { setCasProbe(undefined); }
});


test('registered G5 preserves estimate and assumption status and holds an exact withdrawn revision', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G5 Evidence and Assumptions';
  const staged = await stageInstitutionalSetup(root, {
    label, team: planningTeam, keySegment: 'j5EvidenceAssumptions',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional plan owner/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /evidence and assumptions register draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional plan owner')?.detail ?? '', /decides whether to carry unresolved assumptions/i);
    },
  });
  const directory = path.join(root, planningDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const source = (id: string, revision: string, text: string): InstitutionalBriefSource => ({
    id, revision, date: '2026-11-02', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }],
  });
  const sources = [
    source('office-plan-owner-note', 'r1', 'The fictional plan owner approves this evidence-register scope.'),
    source('office-asset-tally', 'r1', 'The fictional records branch attests its source tally.'),
    source('office-estimate-r4', 'r4', 'The fictional records branch supplied a staff time estimate.'),
  ];
  const sourceRef = ({ id: sourceId, revision }: InstitutionalBriefSource, role: string) => ({ sourceId, revision, role });
  const owner = sourceRef(sources[0], 'fictional-plan-owner');
  const factSource = sourceRef(sources[1], 'fictional-records-evidence-owner');
  const estimateSource = sourceRef(sources[2], 'fictional-records-evidence-owner');
  const factId = 'item-06f00001';
  const estimateId = 'item-06f00002';
  const assumptionId = 'item-06f00003';
  const unknownId = 'item-06f00004';
  const hiddenId = 'item-06f00005';
  const estimateBasis = 'The fictional index sample informed the staffing estimate.';
  const hiddenText = 'Unshared office planning entry';
  const rows = [
    { id: factId, kind: 'fact', statement: 'The reviewed office inventory contains eligible documents.', evidence: factSource,
      quantity: { value: 42, unit: 'documents' } },
    { id: estimateId, kind: 'estimate', statement: 'Estimated staff time for document review.', evidence: estimateSource,
      quantity: { value: 14, unit: 'staff-hours', basis: estimateBasis, date: '2026-11-02' } },
    { id: assumptionId, kind: 'assumption', statement: 'The office archive labels are assumed to be legible.', evidence: factSource,
      accountableRole: 'fictional-records-reviewer', reviewDate: '2026-12-10' },
    { id: unknownId, kind: 'fact', statement: 'The additional document count has yet to be confirmed.', evidence: factSource },
    { id: hiddenId, kind: 'fact', statement: hiddenText, evidence: factSource },
  ];
  const receipt = {
    project, directory: staged.directoryDigest, purpose: 'fictional-office-migration-j5-03', requester: 'fictional-planning-reviewer',
    policyRevision: 'planning-r1', productId: 'office-migration-evidence', sourceCutoff: '2026-11-02', planOwner: owner,
    recordIds: [factId, estimateId, assumptionId, unknownId],
  };
  let currentReceipt = receipt;
  let activeSources = sources;
  const withdrawEstimate = () => { activeSources = sources.map((entry) => entry.id === estimateSource.sourceId ? { ...entry, revision: 'r5' } : entry); };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => activeSources,
    currentPlanningEvidence: () => ({ receipt: currentReceipt, rows }) };
  const team = await selectSyntheticInstitutionalJ5Evidence(fixture);
  const args = { productId: receipt.productId, recordIds: receipt.recordIds };
  const valid = await runFixture(fixture, team, { steps: [
    toolCall('planning-estimate', readPlanningEvidence, { recordId: estimateId }),
    toolCall('hidden-planning-record', readPlanningEvidence, { recordId: hiddenId }),
    toolCall('missing-planning-record', readPlanningEvidence, { recordId: 'item-06f00006' }),
    toolCall('refuse-model-decision', savePlanningRegister, { ...args, approval: true, rationale: 'Accept the assumption.' }),
    toolCall('planning-register', savePlanningRegister, args),
  ] });
  assert.deepEqual(valid.offers[0], [readPlanningEvidence, savePlanningRegister].sort());
  const unavailable = valid.toolResults.get('hidden-planning-record');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(valid.toolResults.get('missing-planning-record'), unavailable);
  assert.equal(valid.toolResults.get('refuse-model-decision'), unavailable);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J5-03');
  assert.equal(draft.sourceCutoff, receipt.sourceCutoff);
  assert.equal(draft.planOwner.role, owner.role);
  assert.equal(draft.planDecision, 'pending');
  const [fact, estimate, assumption, unknown] = draft.body.records;
  assert.equal(fact.kind, 'fact');
  assert.equal(fact.validation, 'attested');
  assert.equal(fact.quantity.value, 42);
  assert.equal(estimate.kind, 'estimate');
  assert.equal(estimate.validation, 'estimated');
  assert.deepEqual(estimate.quantity, rows[1].quantity);
  assert.equal(estimate.evidence[0].revision, 'r4');
  assert.deepEqual(estimate, JSON.parse(valid.toolResults.get('planning-estimate')!));
  assert.equal(assumption.kind, 'assumption');
  assert.equal(assumption.validation, 'open');
  assert.equal(assumption.accountableRole, 'fictional-records-reviewer');
  assert.equal(assumption.reviewDate, '2026-12-10');
  assert.equal(unknown.validation, 'unresolved');
  assert.equal(unknown.quantity, null);
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'planning-register')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${planningDirectory}/${name}`] });
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  for (const hidden of [hiddenId, hiddenText, sources[2].text]) {
    assert.ok(!JSON.stringify([valid.catalogueOffers[0], valid.results, draft, review]).includes(hidden));
  }

  const staleRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-planning-read', readPlanningEvidence, { recordId: estimateId })],
    onChildTurn(turn) { if (turn === 0) withdrawEstimate(); },
  });
  assert.equal(staleRead.toolResults.get('withdrawn-planning-read'), unavailable);
  assert.ok(!staleRead.results.some((entry) => entry.includes(estimateBasis) || entry.includes(estimateSource.sourceId)));

  activeSources = sources;
  currentReceipt = { ...receipt, policyRevision: 'planning-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; withdrawEstimate(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('withdrawn-planning-write', savePlanningRegister, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'withdrawn-planning-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('withdrawn-planning-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [name]);
  } finally { setCasProbe(undefined); }
  currentReceipt = receipt;
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });
});


test('registered G9 preserves independent library mandates and holds the exact consent expiry', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G9 Library Service Remits';
  const staged = await stageInstitutionalSetup(root, {
    label, team: remitTeam, keySegment: 'j9LibraryRemits',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional liaison lead/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /library service remit comparison draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional liaison lead')?.detail ?? '', /verifies each .*remit/i);
    },
  });
  const directory = path.join(root, remitDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const sources = ['liaison-review', 'branch-mandate', 'branch-consent', 'mobile-mandate', 'mobile-consent'].map((id): InstitutionalBriefSource => {
    const text = `Private fixture source text for ${id}.`;
    return { id, revision: 'r1', date: '2026-11-02', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }] };
  });
  const reference = (index: number, role: string) => ({ sourceId: sources[index].id, revision: sources[index].revision, role });
  const firstId = 'item-8e0aca01';
  const secondId = 'item-8e0aca02';
  const hiddenId = 'item-8e0aca03';
  const hiddenDetail = 'Private library roster field';
  const startsAt = '2026-11-03T08:00:00.000Z';
  const expiresAt = '2026-11-03T10:00:00.000Z';
  const validInstant = '2026-11-03T09:59:59.999Z';
  const expiredInstant = '2026-11-03T10:00:00.001Z';
  const purpose = 'fictional-library-remit-comparison-j9-cl02';
  const branchScope = ['branch-room-bookings', 'reading-session-registration'];
  const mobileScope = ['mobile-library-visits', 'reading-session-registration'];
  const organizations = [
    { id: firstId, organizationRole: 'fictional-library-branch-service', description: 'Coordinates branch reading registration and room bookings.',
      mandate: reference(1, 'fictional-branch-mandate-attestor'), confirmation: 'verified', reviewDate: '2026-12-03', scope: branchScope,
      consent: { organizationId: firstId, purpose, scope: branchScope, startsAt, expiresAt, state: 'verified',
        evidence: reference(2, 'fictional-branch-consent-attestor') }, internalNote: hiddenDetail },
    { id: secondId, organizationRole: 'fictional-mobile-library-service', description: 'Coordinates mobile visits and reading registration.',
      mandate: reference(3, 'fictional-mobile-mandate-attestor'), confirmation: 'verified', reviewDate: '2026-12-04', scope: mobileScope,
      consent: { organizationId: secondId, purpose, scope: mobileScope, startsAt, expiresAt, state: 'verified',
        evidence: reference(4, 'fictional-mobile-consent-attestor') } },
    { id: hiddenId, organizationRole: 'hidden-library-service', description: hiddenDetail },
  ];
  const receipt = {
    project, directory: staged.directoryDigest, purpose, requester: 'fictional-library-remit-reviewer',
    policyRevision: 'remit-r1', productId: 'library-service-remits', liaisonLead: reference(0, 'fictional-liaison-lead'),
    grants: [{ id: firstId, scope: branchScope }, { id: secondId, scope: mobileScope }],
  };
  let currentReceipt = receipt;
  let now = validInstant;
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => sources,
    currentLibraryRemits: () => ({ receipt: currentReceipt, organizations }), currentLibraryRemitTime: () => now };
  const team = await selectSyntheticInstitutionalJ9Remits(fixture);
  const args = { productId: receipt.productId, recordIds: [firstId, secondId] };
  const valid = await runFixture(fixture, team, { steps: [
    toolCall('branch-remit', readRemit, { recordId: firstId }),
    toolCall('hidden-remit', readRemit, { recordId: hiddenId }),
    toolCall('missing-remit', readRemit, { recordId: 'item-8e0aca04' }),
    toolCall('refuse-external-route', saveRemit, { ...args, destination: 'external', publish: true }),
    toolCall('library-remits', saveRemit, args),
  ] });
  assert.deepEqual(valid.offers[0], [readRemit, saveRemit].sort());
  const unavailable = valid.toolResults.get('hidden-remit');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(valid.toolResults.get('missing-remit'), unavailable);
  assert.equal(valid.toolResults.get('refuse-external-route'), unavailable);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J9-CL02');
  assert.equal(draft.liaisonLead.role, 'fictional-liaison-lead');
  assert.equal(draft.liaisonDecision, 'pending');
  const [branch, mobile] = draft.body.records;
  assert.deepEqual(branch, JSON.parse(valid.toolResults.get('branch-remit')!));
  assert.deepEqual(branch.scope, branchScope);
  assert.deepEqual(mobile.scope, mobileScope);
  assert.equal(branch.mandate.sourceId, sources[1].id);
  assert.equal(mobile.mandate.sourceId, sources[3].id);
  assert.equal(branch.consent.evidence.sourceId, sources[2].id);
  assert.equal(mobile.consent.evidence.sourceId, sources[4].id);
  assert.equal(branch.consent.expiresAt, expiresAt);
  assert.equal(branch.consent.purpose, purpose);
  assert.deepEqual(draft.body.overlap, [{ scope: 'reading-session-registration', organizationIds: [firstId, secondId],
    state: 'unresolved', reviewRole: 'fictional-library-legal-reviewer' }]);
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  for (const hidden of [hiddenId, hiddenDetail, sources[2].text]) {
    assert.ok(!JSON.stringify([valid.catalogueOffers[0], valid.results, draft, review]).includes(hidden));
  }
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'library-remits')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${remitDirectory}/${name}`] });

  const expiredRead = await runFixture(fixture, team, {
    steps: [toolCall('expired-library-read', readRemit, { recordId: firstId })],
    onChildTurn(turn) { if (turn === 0) now = expiredInstant; },
  });
  assert.equal(expiredRead.toolResults.get('expired-library-read'), unavailable);
  assert.ok(!expiredRead.results.some((entry) => entry.includes(organizations[0].description) || entry.includes(sources[2].id)));

  now = validInstant;
  currentReceipt = { ...receipt, policyRevision: 'remit-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; now = expiredInstant; } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('expired-library-write', saveRemit, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'expired-library-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('expired-library-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [name]);
  } finally { setCasProbe(undefined); }
  currentReceipt = receipt;
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });
});


test('registered G4 reconciles only comparable fictional counts and holds a withdrawn count revision', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G4 Inventory Counts';
  const staged = await stageInstitutionalSetup(root, {
    label, team: inventoryTeam, keySegment: 'j4InventoryCounts',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional property custodian/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /office inventory reconciliation draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional property custodian')?.detail ?? '', /decides how to resolve/i);
    },
  });
  const directory = path.join(root, inventoryDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const sources = ['custody-review-scope', 'office-count-attestation', 'office-register-attestation'].map((id): InstitutionalBriefSource => {
    const text = `Synthetic evidence for ${id} that is not part of its metadata projection.`;
    return { id, revision: 'r1', date: '2026-11-02', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }] };
  });
  const reference = (index: number, role: string) => ({ sourceId: sources[index].id, revision: sources[index].revision, role });
  const ids = ['item-4b000001', 'item-4b000002', 'item-4b000003', 'item-4b000004', 'item-4b000005'];
  const hiddenId = 'item-4b000006';
  const countSource = reference(1, 'fictional-physical-count-attestor');
  const registerSource = reference(2, 'fictional-register-attestor');
  const cutoff = '2026-11-03';
  const nextCutoff = '2026-11-04';
  const items = ids.map((id, index) => ({
    id, label: ['Office chairs', 'Paper packs', 'Office folders', 'Desk trays', 'Spare binders'][index],
    custodyRole: null, condition: 'unknown',
    count: { itemId: id, quantity: 8, unit: 'items', date: '2026-11-02', cutoff: index === 2 ? null : cutoff, evidence: countSource },
    register: { itemId: id, quantity: index === 4 ? null : 12, unit: index === 1 ? 'boxes' : 'items', date: '2026-11-02',
      cutoff: index === 3 ? nextCutoff : cutoff, evidence: registerSource },
  }));
  const receipt = {
    project, directory: staged.directoryDigest, requester: 'fictional-inventory-reviewer', purpose: 'fictional-office-inventory-j4-02',
    policyRevision: 'inventory-r1', productId: 'office-furniture-reconciliation', cutoffs: [cutoff, nextCutoff],
    propertyCustodian: reference(0, 'fictional-property-custodian'), recordIds: ids,
  };
  let currentReceipt = receipt;
  let currentItems = [...items, { ...items[0], id: hiddenId, label: 'Private supply entry' }];
  let activeSources = sources;
  const withdrawCount = () => { activeSources = sources.map((entry) => entry.id === countSource.sourceId ? { ...entry, revision: 'r2' } : entry); };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => activeSources,
    currentInventory: () => ({ receipt: currentReceipt, items: currentItems }) };
  const primary = items[0];
  for (const invalid of [
    { ...primary, register: { ...primary.register, evidence: { ...countSource, role: registerSource.role } } },
    { ...primary, count: { ...primary.count, itemId: ids[1] } },
    { ...primary, count: { ...primary.count, quantity: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    currentItems = [invalid, ...items.slice(1)];
    await assert.rejects(selectSyntheticInstitutionalJ4Inventory(fixture), { message: 'This catalogue metadata is unavailable.' });
  }
  currentItems = [...items, { ...items[0], id: hiddenId, label: 'Private supply entry' }];
  const team = await selectSyntheticInstitutionalJ4Inventory(fixture);
  const args = { productId: receipt.productId, recordIds: ids };
  const valid = await runFixture(fixture, team, { steps: [
    ...ids.map((id, index) => toolCall(`inventory-${index}`, readInventory, { recordId: id })),
    toolCall('hidden-inventory', readInventory, { recordId: hiddenId }),
    toolCall('missing-inventory', readInventory, { recordId: 'item-4b000007' }),
    toolCall('refuse-model-amounts', saveInventory, { ...args, quantity: 12, approved: true }),
    toolCall('save-inventory', saveInventory, args),
  ] });
  assert.deepEqual(valid.offers[0], [readInventory, saveInventory].sort());
  const unavailable = valid.toolResults.get('hidden-inventory');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(valid.toolResults.get('missing-inventory'), unavailable);
  assert.equal(valid.toolResults.get('refuse-model-amounts'), unavailable);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J4-02');
  assert.equal(draft.propertyCustodian.role, 'fictional-property-custodian');
  assert.equal(draft.custodianDecision, 'pending');
  const [known, wrongUnit, missingCutoff, unequalCutoffs, missingQuantity] = draft.body.records;
  assert.deepEqual(draft.body.records, ids.map((_id, index) => JSON.parse(valid.toolResults.get(`inventory-${index}`)!)));
  assert.deepEqual(known.quantityComparison, { state: 'comparable', difference: -4, unit: 'items', cutoff });
  assert.equal(known.count.evidence.sourceId, countSource.sourceId);
  assert.equal(known.register.evidence.sourceId, registerSource.sourceId);
  assert.equal(known.custodyRole, null);
  assert.equal(known.condition, 'unknown');
  assert.deepEqual(known.unresolved, ['custody-unknown', 'condition-unknown']);
  for (const [row, reason] of [[wrongUnit, 'unit-mismatch'], [missingCutoff, 'cutoff-missing'],
    [unequalCutoffs, 'cutoff-mismatch'], [missingQuantity, 'quantity-missing']] as const) {
    assert.deepEqual(row.quantityComparison, { state: 'unresolved', reason });
  }
  assert.equal(missingQuantity.register.quantity, null);
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  for (const hidden of [hiddenId, 'Private supply entry', sources[1].text]) {
    assert.ok(!JSON.stringify([valid.catalogueOffers[0], valid.results, draft, review]).includes(hidden));
  }
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'save-inventory')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${inventoryDirectory}/${name}`] });

  const heldRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-inventory-read', readInventory, { recordId: ids[0] })],
    onChildTurn(turn) { if (turn === 0) withdrawCount(); },
  });
  assert.equal(heldRead.toolResults.get('withdrawn-inventory-read'), unavailable);
  assert.ok(!heldRead.results.some((entry) => entry.includes(items[0].label) || entry.includes(countSource.sourceId)));

  activeSources = sources;
  currentReceipt = { ...receipt, policyRevision: 'inventory-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; withdrawCount(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('withdrawn-inventory-write', saveInventory, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'withdrawn-inventory-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('withdrawn-inventory-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [name]);
  } finally { setCasProbe(undefined); }
  currentReceipt = receipt;
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });
});


test('registered G8 reconciles the fictional reporting basis and refuses withdrawn source evidence', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G8 Budget Evidence';
  const staged = await stageInstitutionalSetup(root, {
    label, team: budgetTeam, keySegment: 'j8BudgetEvidence',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional finance reporting officer/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /office budget evidence reconciliation draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional finance reporting officer')?.detail ?? '', /validates/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional comptroller')?.detail ?? '', /release/i);
    },
  });
  const directory = path.join(root, budgetDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const sources = ['budget-reporting-officer', 'budget-comptroller', 'budget-status-attestation', 'budget-control-attestation'].map((id): InstitutionalBriefSource => {
    const text = `Synthetic source text for ${id} that is outside the metadata view.`;
    return { id, revision: 'r1', date: '2026-11-30', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }] };
  });
  const reference = (index: number, role: string) => ({ sourceId: sources[index].id, revision: sources[index].revision, role });
  const ids = ['item-8b000001', 'item-8b000002', 'item-8b000003', 'item-8b000004'];
  const hiddenId = 'item-8b000005';
  const categories = ['authorized-balance', 'commitment', 'actual', 'accrual'];
  const period = '2026-11';
  const asOf = '2026-11-30';
  const unit = 'fictional-budget-points';
  const statusEvidence = reference(2, 'fictional-budget-status-attestor');
  const controlEvidence = reference(3, 'fictional-budget-control-attestor');
  const rows = ids.map((id, index) => ({
    id, category: categories[index],
    status: { category: categories[index], quantity: 37, period, unit, confirmation: 'verified', evidence: statusEvidence },
    control: { category: categories[index], quantity: [40, 8675309, 6543211, null][index],
      period: index === 2 ? '2026-10' : period, unit: index === 1 ? 'other-fixture-points' : unit,
      confirmation: 'verified', evidence: controlEvidence },
  }));
  const receipt = {
    project, directory: staged.directoryDigest, requester: 'fictional-budget-reviewer', purpose: 'fictional-office-budget-j8-02',
    policyRevision: 'budget-r1', productId: 'office-period-budget-evidence', period, asOf,
    reportingOfficer: reference(0, 'fictional-finance-reporting-officer'), comptroller: reference(1, 'fictional-comptroller'), recordIds: ids,
  };
  let currentReceipt = receipt;
  let activeSources = sources;
  let currentRows: readonly unknown[] = rows;
  const withdrawStatus = () => { activeSources = sources.map((entry) => entry.id === statusEvidence.sourceId ? { ...entry, revision: 'r2' } : entry); };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => activeSources,
    currentBudget: () => ({ receipt: currentReceipt, rows: [...currentRows, { ...rows[0], id: hiddenId, category: 'hidden' }] }) };
  const team = await selectSyntheticInstitutionalJ8Budget(fixture);
  const args = { productId: receipt.productId, recordIds: ids };
  const valid = await runFixture(fixture, team, { steps: [
    ...ids.map((id, index) => toolCall(`budget-${index}`, readBudget, { recordId: id })),
    toolCall('hidden-budget', readBudget, { recordId: hiddenId }),
    toolCall('missing-budget', readBudget, { recordId: 'item-8b000006' }),
    toolCall('refuse-budget-action', saveBudget, { ...args, post: true, release: true }),
    toolCall('save-budget', saveBudget, args),
  ] });
  assert.deepEqual(valid.offers[0], [readBudget, saveBudget].sort());
  const unavailable = valid.toolResults.get('hidden-budget');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(valid.toolResults.get('missing-budget'), unavailable);
  assert.equal(valid.toolResults.get('refuse-budget-action'), unavailable);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J8-02');
  assert.equal(draft.period, period);
  assert.equal(draft.asOf, asOf);
  assert.equal(draft.reportingOfficer.role, 'fictional-finance-reporting-officer');
  assert.equal(draft.comptroller.role, 'fictional-comptroller');
  assert.notEqual(draft.reportingOfficer.sourceId, draft.comptroller.sourceId);
  assert.equal(draft.validation, 'pending');
  assert.equal(draft.release, 'pending');
  const [known, wrongUnit, wrongPeriod, missingBasis] = draft.body.records;
  assert.deepEqual(draft.body.records, ids.map((_id, index) => JSON.parse(valid.toolResults.get(`budget-${index}`)!)));
  assert.deepEqual(draft.body.records.map((row: { category: string }) => row.category), categories);
  assert.deepEqual(known.comparison, { state: 'comparable', difference: -3, unit, period });
  assert.equal(known.status.evidence.sourceId, statusEvidence.sourceId);
  assert.equal(known.control.evidence.sourceId, controlEvidence.sourceId);
  for (const [row, reason] of [[wrongUnit, 'unit-incompatible'], [wrongPeriod, 'period-incompatible'],
    [missingBasis, 'comparable-basis-missing']] as const) {
    assert.deepEqual(row.comparison, { state: 'unresolved', reason });
  }
  for (const row of [wrongUnit, wrongPeriod]) {
    assert.deepEqual(Object.keys(row).sort(), ['category', 'comparison', 'id']);
  }
  assert.equal(missingBasis.control.quantity, null);
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  const exposed = JSON.stringify([valid.catalogueOffers[0], valid.results, draft, review]);
  for (const hidden of [hiddenId, 'other-fixture-points', '2026-10', '8675309', '6543211', sources[2].text]) {
    assert.ok(!exposed.includes(hidden), `unexpected budget data ${hidden}`);
  }
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'save-budget')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${budgetDirectory}/${name}`] });

  const comparableControl = rows[0].control;
  for (const [control, reason] of [
    [{ ...comparableControl, evidence: { ...statusEvidence, role: controlEvidence.role } }, 'duplicate-evidence'],
    [{ ...comparableControl, confirmation: 'disputed' }, 'disputed-evidence'],
    [{ ...comparableControl, confirmation: 'unconfirmed', evidence: null }, 'confirmation-missing'],
  ] as const) {
    currentRows = [{ ...rows[0], control }, ...rows.slice(1)];
    const steps = [toolCall('unresolved-budget', readBudget, { recordId: ids[0] })];
    if (reason === 'disputed-evidence') {
      steps.push(toolCall('save-disputed-budget', saveBudget, { productId: args.productId, recordIds: [ids[0]] }));
    }
    const unresolved = await runFixture(fixture, team, { steps });
    const actual = JSON.parse(unresolved.toolResults.get('unresolved-budget')!);
    assert.deepEqual(actual, {
      id: ids[0], category: categories[0], comparison: { state: 'unresolved', reason },
      statusEvidence: { ...statusEvidence, hash: institutionalSourceHash(sources[2]) },
      controlEvidence: control.evidence && { ...control.evidence,
        hash: institutionalSourceHash(sources[reason === 'duplicate-evidence' ? 2 : 3]) },
    });
    if (reason === 'disputed-evidence') {
      const dispute = JSON.parse(unresolved.toolResults.get('save-disputed-budget')!);
      const packet = JSON.parse((await readFile(path.join(directory, `${dispute.review.version}.json`))).toString());
      assert.deepEqual(packet.body.records, [actual]);
      assert.ok(dispute.review.sources.some(({ id }: { id: string }) => id === controlEvidence.sourceId));
      assert.deepEqual(await readInstitutionalDraftReview(scope, resolveInWorkspace, dispute.review.version), dispute.review);
    }
  }
  currentRows = rows;
  const priorDrafts = (await readdir(directory)).sort();
  assert.equal(priorDrafts.length, 2);

  const heldRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-budget-read', readBudget, { recordId: ids[0] })],
    onChildTurn(turn) { if (turn === 0) withdrawStatus(); },
  });
  assert.equal(heldRead.toolResults.get('withdrawn-budget-read'), unavailable);
  assert.ok(!heldRead.results.some((entry) => entry.includes('"quantity":37') || entry.includes(statusEvidence.sourceId)));

  activeSources = sources;
  currentReceipt = { ...receipt, policyRevision: 'budget-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; withdrawStatus(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('withdrawn-budget-write', saveBudget, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'withdrawn-budget-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('withdrawn-budget-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual((await readdir(directory)).sort(), priorDrafts);
  } finally { setCasProbe(undefined); }
  currentReceipt = receipt;
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });
});


async function newServiceMonitoringFixture() {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional G1 Service Monitoring';
  const staged = await stageInstitutionalSetup(root, {
    label, team: monitoringTeam, keySegment: 'j1ServiceMonitoring',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional HR services supervisor/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /office help aggregate draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional HR services supervisor')?.detail ?? '', /validates/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional feed custodian')?.detail ?? '', /source correction/i);
    },
  });
  const directory = path.join(root, monitoringDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const roles = [
    ['office-help-validation', 'fictional-hr-services-supervisor'],
    ['office-help-custody', 'fictional-feed-custodian'],
    ['office-help-snapshot', 'fictional-aggregate-attestor'],
    ['office-help-availability', 'fictional-feed-availability-attestor'],
  ];
  const sources = roles.map(([id]): InstitutionalBriefSource => {
    const text = `Fictional office-help fixture proof for ${id}.`;
    return { id, revision: 'r1', date: '2026-11-30', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }] };
  });
  const reference = (index: number) => ({ sourceId: sources[index].id, revision: 'r1', role: roles[index][1] });
  const recordId = 'item-1b000001';
  const productId = 'office-help-aggregate';
  const basis = { period: '2026-11', cutoff: '2026-11-30', clockBasis: 'utc-day-close', partition: 'closed-or-unresolved' };
  const receipt = {
    project, directory: staged.directoryDigest, purpose: 'fictional-office-help-j1-05', productId, recordId, ...basis,
    requester: 'fictional-service-monitoring-reviewer', approval: 'office-help-fixture-r1',
    supervisor: reference(0), feedCustodian: reference(1),
  };
  const initialCounts = { closed: 67, unresolved: 53, intake: 120 };
  const initial = { state: 'available', ...initialCounts, evidence: reference(2) };
  let sample: unknown = initial;
  let activeSources = sources;
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => activeSources,
    currentServiceMonitoring: () => ({ receipt, sample }) };
  const team = await selectSyntheticInstitutionalJ1Monitoring(fixture);
  return {
    fixture, team, directory, recordId, productId, basis, sources, initialCounts,
    setCounts: (counts: typeof initialCounts) => { sample = { ...initial, ...counts }; },
    markMissing: () => { sample = { state: 'missing', evidence: reference(3) }; },
    withdraw: () => { activeSources = sources.map((entry) => entry.id === sources[2].id ? { ...entry, revision: 'r2' } : entry); },
    restore: () => { sample = initial; activeSources = sources; },
  };
}

test('registered G1 suppresses small or divergent office-help snapshots under one fixed reporting key', async () => {
  const subject = await newServiceMonitoringFixture();
  const { fixture, team, directory, recordId, productId, sources } = subject;
  const args = { productId, recordIds: [recordId] };
  const rerun = async (runId: string, steps: ToolCall[]) => {
    const nextFixture = { ...fixture, runId };
    return runFixture(nextFixture, await selectSyntheticInstitutionalJ1Monitoring(nextFixture), { steps });
  };
  const admitted = await runFixture(fixture, team, { steps: [
    toolCall('unknown-monitoring-id', readMonitoring, { recordId: 'item-1b000002' }),
    toolCall('monitoring-read', readMonitoring, { recordId }),
    toolCall('monitoring-save', saveMonitoring, args),
  ] });
  assert.deepEqual(admitted.offers[0], [readMonitoring, saveMonitoring].sort());
  const unavailable = admitted.toolResults.get('unknown-monitoring-id');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'J1-05');
  assert.equal(draft.validation, 'pending');
  assert.equal(draft.supervisor.role, 'fictional-hr-services-supervisor');
  assert.equal(draft.feedCustodian.role, 'fictional-feed-custodian');
  assert.notEqual(draft.supervisor.sourceId, draft.feedCustodian.sourceId);
  const [snapshot] = draft.body.records;
  assert.deepEqual(snapshot, JSON.parse(admitted.toolResults.get('monitoring-read')!));
  assert.deepEqual(snapshot.basis, subject.basis);
  assert.deepEqual(snapshot.counts, subject.initialCounts);
  assert.deepEqual(snapshot.resolvedFraction, { numerator: 67, denominator: 120 });
  assert.equal(snapshot.evidence.sourceId, sources[2].id);
  assert.deepEqual(admitted.decisions.find((entry) => entry.api.request.uid === 'monitoring-save')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${monitoringDirectory}/${name}`] });
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);

  const repeated = await rerun('run-office-help-repeat', [toolCall('repeat-monitoring-save', saveMonitoring, args)]);
  assert.equal(JSON.parse(repeated.toolResults.get('repeat-monitoring-save')!).review.version, version);
  assert.deepEqual(await readdir(directory), [name]);
  assert.deepEqual(await readFile(path.join(directory, name)), bytes);

  subject.markMissing();
  const missing = await rerun('run-office-help-missing', [
    toolCall('missing-feed-read', readMonitoring, { recordId }),
    toolCall('missing-feed-save', saveMonitoring, args),
  ]);
  assert.deepEqual(JSON.parse(missing.toolResults.get('missing-feed-read')!), { state: 'unknown' });
  assert.equal(missing.toolResults.get('missing-feed-save'), unavailable);
  assert.deepEqual(await readdir(directory), [name]);

  const heldSnapshots = [{ closed: 2, unresolved: 198, intake: 200 }, { closed: 207, unresolved: 0, intake: 207 },
    { closed: 73, unresolved: 61, intake: 134 }];
  for (const [index, counts] of heldSnapshots.entries()) {
    subject.setCounts(counts);
    const held = await rerun(`run-office-help-hold-${index}`, [
      toolCall('held-monitoring-read', readMonitoring, { recordId }),
      toolCall('held-monitoring-save', saveMonitoring, args),
    ]);
    assert.equal(held.toolResults.get('held-monitoring-read'), unavailable);
    assert.equal(held.toolResults.get('held-monitoring-save'), unavailable);
    assert.deepEqual(held.catalogueOffers[0], admitted.catalogueOffers[0]);
    assert.ok(!held.decisions.some((entry) => entry.api.request.uid === 'held-monitoring-save' && entry.action_id === 1));
    const shown = JSON.stringify([held.catalogueOffers[0], held.results, held.decisions]);
    for (const hint of [recordId, ...sources.map(({ id }) => id), 'resolvedFraction', '"intake"', version, 'institutional/j1']) {
      assert.ok(!shown.includes(hint), `unexpected held report hint ${hint}`);
    }
    assert.deepEqual(await readdir(directory), [name]);
    assert.deepEqual(await readFile(path.join(directory, name)), bytes);
  }
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });

  subject.restore();
  const heldRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-monitoring-read', readMonitoring, { recordId })],
    onChildTurn(turn) { if (turn === 0) subject.withdraw(); },
  });
  assert.equal(heldRead.toolResults.get('withdrawn-monitoring-read'), unavailable);
  assert.ok(!heldRead.results.some((entry) => entry.includes(sources[2].id) || entry.includes('resolvedFraction')));
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });

  const isolated = await newServiceMonitoringFixture();
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; isolated.withdraw(); } });
  try {
    const held = await runFixture(isolated.fixture, isolated.team, { steps: [toolCall('withdrawn-monitoring-write', saveMonitoring, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'withdrawn-monitoring-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('withdrawn-monitoring-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(isolated.directory), []);
  } finally { setCasProbe(undefined); }
});


test('registered Special Staff keeps help-sheet observations, issues and evidence gaps distinct', async () => {
  const subject = await newFixture();
  const root = subject.fixture.root;
  const label = 'Institutional Special Staff Accessibility Review';
  const staged = await stageInstitutionalSetup(root, {
    label, team: accessibilityTeam, keySegment: 'specialAccessibilityReview',
    checkPrompts(requests) {
      assert.match(requests[0].items.find((item) => item.label === label)?.detail ?? '', /fictional accessibility adviser/i);
      const confirmation = requests.find((request) => request.title === `${label}: check the roster`);
      assert.ok(confirmation);
      assert.match(confirmation.items.find((item) => item.label === '$(check) Set up the team')?.detail ?? '', /help-sheet accessibility review draft skill/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional accessibility adviser')?.detail ?? '', /owns accessibility advice/i);
      assert.match(confirmation.items.find((item) => item.label === '$(person) Fictional help-sheet product owner')?.detail ?? '', /decides remediation/i);
    },
  });
  const directory = path.join(root, accessibilityDirectory);
  await mkdir(directory, { recursive: true });
  const project = String(staged.rootDigest);
  const roles = [
    ['receipt-b1a2', 'fictional-accessibility-adviser', 'r1'],
    ['receipt-b1a3', 'fictional-help-sheet-product-owner', 'r1'],
    ['receipt-b1a4', 'fictional-help-sheet-attestor', 'r5'],
    ['receipt-b1a5', 'fictional-checklist-evidence-reviewer', 'r2'],
    ['receipt-b1a6', 'fictional-checklist-evidence-reviewer', 'r3'],
  ];
  const sources = roles.map(([id, , revision]): InstitutionalBriefSource => {
    const text = `Private fixture text for ${id} that must stay outside the evidence summary.`;
    return { id, revision, date: '2026-11-30', label: 'org/Public', project, text, spans: [{ start: 0, end: text.length }] };
  });
  const reference = (index: number) => ({ sourceId: sources[index].id, revision: sources[index].revision, role: roles[index][1] });
  const ids = ['item-5a000001', 'item-5a000002', 'item-5a000003'];
  const hiddenId = 'item-5a000004';
  const rows = [
    { id: ids[0], check: 'heading-structure', condition: 'documented-observation', evidence: reference(3) },
    { id: ids[1], check: 'descriptive-link-labels', condition: 'observed-issue', evidence: reference(4) },
    { id: ids[2], check: 'alternative-format-evidence', condition: 'missing-evidence', evidence: null },
    { id: hiddenId, check: 'Unshared fixture check' },
  ];
  const receipt = {
    project, directory: staged.directoryDigest, requester: 'fictional-accessibility-reviewer',
    purpose: 'fictional-help-sheet-accessibility-ss-18', policyRevision: 'accessibility-r1', productId: 'office-help-sheet-review',
    sheetId: 'item-5a000010', sheetRevision: 'r5', checklistVersion: 'r1', sheet: reference(2),
    adviser: reference(0), productOwner: reference(1), recordIds: ids,
  };
  let currentReceipt = receipt;
  let activeSources = sources;
  const withdrawLinkEvidence = () => { activeSources = sources.map((entry) => entry.id === sources[4].id ? { ...entry, revision: 'r4' } : entry); };
  const fixture = { ...subject.fixture, readStaged: () => staged, currentSources: () => activeSources,
    currentAccessibilityReview: () => ({ receipt: currentReceipt, rows }) };
  const team = await selectSyntheticInstitutionalAccessibility(fixture);
  const args = { productId: receipt.productId, recordIds: ids };
  const valid = await runFixture(fixture, team, { steps: [
    ...ids.map((recordId, index) => toolCall(`accessibility-${index}`, readAccessibility, { recordId })),
    toolCall('hidden-accessibility', readAccessibility, { recordId: hiddenId }),
    toolCall('missing-accessibility', readAccessibility, { recordId: 'item-5a000005' }),
    toolCall('refuse-compliance-claim', saveAccessibility, { ...args, compliant: true, edit: true }),
    toolCall('save-accessibility', saveAccessibility, args),
  ] });
  assert.deepEqual(valid.offers[0], [readAccessibility, saveAccessibility].sort());
  const unavailable = valid.toolResults.get('hidden-accessibility');
  assert.ok(unavailable);
  assert.match(unavailable, /unavailable/i);
  assert.equal(valid.toolResults.get('missing-accessibility'), unavailable);
  assert.equal(valid.toolResults.get('refuse-compliance-claim'), unavailable);
  const [name] = await readdir(directory);
  assert.ok(name);
  const bytes = await readFile(path.join(directory, name));
  const version = createHash('sha256').update(bytes).digest('hex');
  assert.equal(name, `${version}.json`);
  const draft = JSON.parse(bytes.toString());
  assert.equal(draft.duty, 'SS-18');
  assert.equal(draft.sheet.id, receipt.sheetId);
  assert.equal(draft.sheet.revision, receipt.sheetRevision);
  assert.equal(draft.checklistVersion, receipt.checklistVersion);
  assert.equal(draft.adviser.role, roles[0][1]);
  assert.equal(draft.productOwner.role, roles[1][1]);
  assert.notEqual(draft.adviser.sourceId, draft.productOwner.sourceId);
  assert.equal(draft.advice, 'pending');
  assert.equal(draft.remediation, 'pending');
  assert.deepEqual(draft.body.records, ids.map((_id, index) => JSON.parse(valid.toolResults.get(`accessibility-${index}`)!)));
  const [observed, issue, gap] = draft.body.records;
  assert.deepEqual([observed.condition, issue.condition, gap.condition], ['documented-observation', 'observed-issue', 'missing-evidence']);
  assert.equal(observed.evidence.revision, 'r2');
  assert.equal(observed.issueObserved, false);
  assert.equal(issue.evidence.sourceId, sources[4].id);
  assert.equal(issue.evidence.revision, 'r3');
  assert.equal(issue.issueObserved, true);
  assert.equal(gap.evidence, null);
  assert.equal(gap.evidenceGap, true);
  const scope = selectedInstitutionalScope(team);
  assert.ok(scope);
  const review = await readInstitutionalDraftReview(scope, resolveInWorkspace, version);
  assert.equal(review.version, version);
  assert.deepEqual(valid.decisions.find((entry) => entry.api.request.uid === 'save-accessibility')?.unmapped.nearAi.capability,
    { verb: 'workspaceWrite', paths: [`${accessibilityDirectory}/${name}`] });
  const shown = JSON.stringify([valid.catalogueOffers[0], valid.results, draft, review]);
  for (const hidden of [hiddenId, 'Unshared fixture check', sources[4].text]) assert.ok(!shown.includes(hidden));

  const heldRead = await runFixture(fixture, team, {
    steps: [toolCall('withdrawn-accessibility-read', readAccessibility, { recordId: ids[1] })],
    onChildTurn(turn) { if (turn === 0) withdrawLinkEvidence(); },
  });
  assert.equal(heldRead.toolResults.get('withdrawn-accessibility-read'), unavailable);
  assert.ok(!heldRead.results.some((entry) => entry.includes('descriptive-link-labels') || entry.includes(sources[4].id)));

  activeSources = sources;
  currentReceipt = { ...receipt, policyRevision: 'accessibility-r2' };
  let entered = false;
  setCasProbe((point) => { if (point === 'before-rename') { entered = true; withdrawLinkEvidence(); } });
  try {
    const held = await runFixture(fixture, team, { steps: [toolCall('withdrawn-accessibility-write', saveAccessibility, args)] });
    assert.ok(entered && held.decisions.some((entry) => entry.api.request.uid === 'withdrawn-accessibility-write' && entry.action_id === 1));
    assert.equal(held.toolResults.get('withdrawn-accessibility-write'), unavailable);
    assert.ok(!held.results.some((entry) => entry.includes('"state":"draft"')));
    assert.deepEqual(await readdir(directory), [name]);
  } finally { setCasProbe(undefined); }
  currentReceipt = receipt;
  await assert.rejects(readInstitutionalDraftReview(scope, resolveInWorkspace, version), { message: 'This catalogue metadata is unavailable.' });
});
