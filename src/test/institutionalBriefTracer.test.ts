import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_TURN_CEILING_MS } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { INSTITUTIONAL_COMMAND_GROUP_MEMBER, INSTITUTIONAL_COMMAND_GROUP_TEAM, selectSyntheticInstitutionalCommandGroup, selectedInstitutionalScope } from '../agent/staff/institutionalCommand';
import { TeamLibrary, type TeamDefinition } from '../agent/teams';
import { resolveInWorkspace } from '../agent/workspace';
import { bundleHash } from '../domain/gate/bundle';
import type { DecisionRecord } from '../domain/gate/record';
import type { ActionPolicy } from '../domain/policy';
import type { InstitutionalBriefSource } from '../domain/staff/institutionalBrief';
import { setCasProbe } from '../staff/staffFiles';
import { readInstitutionalDraftReview } from '../staff/institutionalDraftStore';
import type { AgentTurnRequest } from '../services/agentSession';
import { StreamInterruptedError, type AgentMessage, type CompletionEvent, type ToolCall, type ToolDefinition } from '../services/nearAiClient';
import { newTestConversation, testBundleState, testGateRuntime } from './helpers/gatedRuns';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const draftDirectory = '.planning/staff/institutional/command/briefs';
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

async function stageInstitutionalSetup(root: string) {
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
    const { registerStaffSetup } = require('../services/staffSetupCommand') as typeof import('../services/staffSetupCommand');
    const library = new TeamLibrary(path.join(root, 'unused-library'));
    registerStaffSetup({ subscriptions: [], globalState } as never, undefined, library);
    stub.setWorkspaceFolders([root]);
    stub.quickPickAnswers.push('Institutional Command Group', '$(check) Set up the team');
    const setup = stub.commands.get('nearAi.setUpStaffTeam');
    assert.ok(setup);
    await setup();
    assert.equal(profile.size, 1);
    assert.equal(await library.findRunTeam(INSTITUTIONAL_COMMAND_GROUP_TEAM, root), undefined);
    return [...profile.values()][0];
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
    return readInstitutionalDraftReview(scope, resolveInWorkspace, hash);
  };
  return { fixture, team, drafts, readReview,
    stopThroughLiveSettings: () => { actionSettings = { ...actionSettings, emergencyStop: true }; },
    changePolicy: () => { current = { ...initial, bundle: alternate, hash: bundleHash(alternate) }; },
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
  const results: string[] = [];
  const childRequests: { model: string; idle?: number; turn?: number; admitted: boolean }[] = [];
  let parentTurn = 0;
  let childTurn = 0;
  const client = {
    async *streamCompletion(selectedModel: string, messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal,
      deadlines: { idleTimeoutMs?: number; turnTimeoutMs?: number }): AsyncGenerator<CompletionEvent> {
      results.push(...messages.filter((message) => message.role === 'tool').map((message) => String(message.content)));
      const child = String(messages[0].content).includes('Prepare a CG-07 decision brief using only evidence');
      let call: ToolCall | undefined;
      if (child) {
        const admitted = messages.some((message) => message.role === 'tool' && String(message.content).includes(publicExtracts[0].text));
        childRequests.push({ model: selectedModel, idle: deadlines.idleTimeoutMs, turn: deadlines.turnTimeoutMs, admitted });
        options.onChildTurn?.(childTurn);
        offers.push(tools.map((item) => item.function.name).sort());
        if (!options.modelInterruption || childTurn === 0) call = (options.steps ?? acceptedSteps)[childTurn++];
        else if (selectedModel === model) {
          if (options.modelInterruption === 'silent') await delay(deadlines.idleTimeoutMs ?? 100, undefined, { signal });
          throw new StreamInterruptedError('The fictional model stopped responding.', true, undefined, { kind: 'stalled', idleMs: deadlines.idleTimeoutMs ?? idleDeadline });
        }
      } else if (parentTurn++ === 0) {
        call = toolCall('spawn-drafter', 'Agent', { subagent_type: INSTITUTIONAL_COMMAND_GROUP_MEMBER, prompt: 'Prepare the administrative brief.' });
      }
      yield { type: 'done', message: { role: 'assistant', content: call ? null : 'Done', ...(call ? { tool_calls: [call] } : {}) }, finishReason: call ? 'tool_calls' : 'stop', usage };
    },
  };
  const posted: Record<string, unknown>[] = [];
  const conversation = newTestConversation(root, (event) => posted.push(event), path.join(root, '.checkpoints'));
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
  return { offers, results, posted, childRequests, requestPolicy, decisions: runtimes.flatMap((runtime): DecisionRecord[] => runtime.records) };
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
