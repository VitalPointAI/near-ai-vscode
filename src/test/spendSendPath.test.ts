// Regression tests for the spend drift between the extension and the NEAR AI Cloud console
// (.planning/debug/spend-drift-vs-console.md): the sidebar's real host path (attachChatToView ->
// AgentConversation -> AgentRun -> NearAiClient) against a fake NEAR AI that bills every request
// it serves, like NEAR's usage table. Each scenario checks that the spend ledger holds every
// billed request at NEAR's own figure and that the chat status line, Agent Activity, and the
// daily limit all show that one total.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { deriveProfileId } from '../domain/auth';
import { totalNanoUsd } from '../services/spendLedger';

const BASE = 'https://cloud-api.near.ai/v1';
const MAIN = 'moonshotai/kimi-k3';
const FAST = 'Qwen/Qwen3.6-35B-A3B-FP8';
/** nano-USD per token: [input, output]. */
const PRICE: Record<string, [number, number]> = { [MAIN]: [1000, 3000], [FAST]: [150, 600], 'z-ai/glm-5.3': [500, 2000] };

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const CONFIG: Record<string, unknown> = { actionPolicy: 'auto', 'agent.saveTranscripts': false };
const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, name: 'demo', getConfiguration: () => ({ get: (key: string, fallback?: unknown) => (key in CONFIG ? CONFIG[key] : fallback), inspect: (key: string) => (key in CONFIG ? { key, workspaceValue: CONFIG[key] } : { key }), update: async () => undefined, has: (key: string) => key in CONFIG }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showErrorMessage: () => Promise.resolve(undefined), showInformationMessage: () => Promise.resolve(undefined), showWarningMessage: () => Promise.resolve(undefined), activeTextEditor: undefined },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
};

function withVscode<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

async function openSidebar(root: string, auth: AuthService) {
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  const disposed: Array<() => void> = [];
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const { attachChatToView } = withVscode(() => require('../services/chat') as typeof import('../services/chat'));
  const view = {
    webview: { html: '', postMessage: async (message: Record<string, unknown>) => { posted.push(message); if (message.type === 'approval-request') setTimeout(() => { void receive?.({ type: 'approval-reply', callId: message.callId, decision: 'allow' }); }, 5); if (message.type === 'questions-request') setTimeout(() => { void receive?.({ type: 'questions-reply', id: message.id, answers: [] }); }, 5); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: (handler: () => void) => { disposed.push(handler); return { dispose() {} }; }
  };
  await withVscode(() => attachChatToView({ subscriptions: [], globalStorageUri: { fsPath: path.join(root, '.global') }, extensionUri: { fsPath: root }, secrets: new MemorySecrets() } as never, auth, view as never, '<html></html>'));
  return { posted, send: (message: unknown) => receive!(message), close: () => { for (const handler of disposed) handler(); } };
}

async function gsdProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-spend-'));
  const auth = new AuthService(new MemorySecrets());
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: BASE, authMode: 'apiKey' }, 'sk-test-key');
  const home = path.join(root, '.global', 'gsd', '1.20.0');
  await mkdir(path.join(home, 'gsd-core', 'bin'), { recursive: true });
  await mkdir(path.join(home, 'agents'), { recursive: true });
  await writeFile(path.join(home, 'gsd-core', 'VERSION'), '1.20.0\n');
  await writeFile(path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs'), '');
  for (const skill of ['gsd-progress', 'gsd-plan-phase']) {
    await mkdir(path.join(home, 'skills', skill), { recursive: true });
    await writeFile(path.join(home, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill}\n---\n<arguments>$ARGUMENTS</arguments>\nWORKFLOW for ${skill}.\n`);
  }
  await writeFile(path.join(home, 'agents', 'gsd-phase-researcher.md'), '---\nname: gsd-phase-researcher\ndescription: gsd-phase-researcher\ntools: Read, Grep, Bash\n---\nYou are the GSD gsd-phase-researcher.\n');
  await writeFile(path.join(root, '.global', 'gsd', 'current.json'), JSON.stringify({ version: '1.20.0' }));
  await writeFile(path.join(root, 'ROADMAP.md'), '# Phase 9\n');
  await writeFile(path.join(root, 'STATE.md'), '# State\nPhase 9\n');
  await writeFile(path.join(root, 'BIG.md'), `# Big\n${'lorem ipsum dolor sit amet '.repeat(260)}\n`);
  return { root, auth };
}

type Delta = Record<string, unknown>;
const call = (index: number, id: string, name: string, args: Record<string, unknown>) => ({ index, id, function: { name, arguments: JSON.stringify(args) } });
const read = (index: number, id: string, file: string) => call(index, id, 'Read', { file_path: file });
const bash = (index: number, id: string, command: string) => call(index, id, 'Bash', { command, description: 'probe' });
const spawn = (index: number, id: string, n: number, background = false) => call(index, id, 'Agent', { subagent_type: 'gsd-phase-researcher', description: `research ${n}`, prompt: `Research task number ${n}.`, model: 'haiku', ...(background ? { run_in_background: true } : {}) });

const PLAN_MAIN: Delta[] = [
  { tool_calls: [read(0, 'r1', 'STATE.md')] },
  { tool_calls: [spawn(0, 'a0', 0), spawn(1, 'a1', 1), spawn(2, 'b0', 2, true)] },
  { tool_calls: [bash(0, 'm1', 'node main-probe.js')] },
  { content: 'Plan ready; waiting for the background researcher.' },
  { content: 'Done.' }
];
const CHILD: (n: number) => Delta[] = (n) => [
  { tool_calls: [bash(0, `c${n}`, `node probe-${n}.js`)] },
  { content: `Report ${n}.` }
];
const readsThen = (from: number, text: string): Delta[] => [0, 1, 2, 3, 4, 5].map((i) => ({ tool_calls: [read(0, `big${from + i}`, i % 2 ? 'BIG.md' : 'STATE.md')] }) as Delta).concat([{ content: text }]);
const READS_MAIN: Delta[] = [...readsThen(0, 'Read it all.'), ...readsThen(10, 'Read it all again.')];

interface Bill { id: string; who: string; model: string; kind: string; promptTokens: number; completionTokens: number; nano: number; at: number }
interface Cfg {
  main: Delta[];
  /** `${who}#${turn}` keys whose first attempt streams one chunk and then drops (NEAR has already done the work). */
  dropFirst?: Set<string>;
  /** `${who}#${turn}` keys that stream slowly (ms before the reply), so a stop lands mid-stream. */
  slow?: Map<string, number>;
  /** `${who}#${turn}` keys answered with a non-retryable HTTP 400 (not billed). */
  fail?: Set<string>;
  contextLength?: number;
}

function fakeNear(bills: Bill[], ids: { n: number }, cfg: Cfg, t0: number, billingCalls: number[]) {
  const attempts = new Map<string, number>();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const p = String(input).replace(BASE, '');
    let body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: string }>; requestIds?: string[] } | undefined;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    if (p === '/models/pricing') return new Response(JSON.stringify({ error: { message: 'GET /v1/models/pricing is not implemented by NEAR AI Cloud yet', type: 'not_implemented' } }), { status: 501 });
    if (p === '/models') return Response.json({ data: Object.keys(PRICE).map((id) => ({ id, pricing: { input: PRICE[id][0] / 1000, output: PRICE[id][1] / 1000 }, ...(cfg.contextLength && id === MAIN ? { context_length: cfg.contextLength } : {}) })) });
    if (p === '/model/list') return Response.json({ models: Object.keys(PRICE).map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'tinfoil' } })) });
    if (p === '/billing/costs') {
      // Like NEAR: unknown IDs report 0 with a warning.
      const wanted = body?.requestIds ?? [];
      billingCalls.push(wanted.length);
      const rows = wanted.map((requestId) => ({ requestId, costNanoUsd: bills.find((bill) => bill.id === requestId)?.nano ?? 0 }));
      return Response.json({ requests: rows, ...(rows.some((row) => row.costNanoUsd === 0) ? { warning: 'Some request IDs matched no usage record.' } : {}) });
    }
    if (p !== '/chat/completions') return new Response('not found', { status: 404 });
    const model = body?.model ?? '';
    const sys = String(body?.messages?.[0]?.content ?? '');
    const who = /You compress an agent conversation/.test(sys) ? 'compaction' : /check shell commands for a coding agent/.test(sys) ? 'safety' : (/^You are the GSD ([\w-]+)\./.exec(sys) ? `child${/Research task number (\d+)/.exec(String(body?.messages?.[1]?.content ?? ''))?.[1] ?? '?'}` : 'main');
    const turn = (body?.messages ?? []).filter((m) => m.role === 'assistant').length;
    const key = `${who}#${turn}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (cfg.fail?.has(key)) return new Response(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error' } }), { status: 400 });
    const promptTokens = Math.ceil(String(init?.body ?? '').length / 4);
    const [inPrice, outPrice] = PRICE[model] ?? [1000, 3000];
    ids.n += 1;
    const id = `inf-${ids.n}`;
    const bill = (completionTokens: number, kind: string) => bills.push({ id, who, model, kind, promptTokens, completionTokens, nano: promptTokens * inPrice + completionTokens * outPrice, at: Date.now() - t0 });
    if (body?.stream === false) {
      bill(20, 'once');
      const text = who === 'safety' ? '{"allow": true, "reason": "probe"}' : 'ok';
      return new Response(JSON.stringify({ id: `chatcmpl-${ids.n}`, choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json', 'inference-id': id } });
    }
    const script = who === 'main' ? cfg.main : who === 'compaction' ? [{ content: 'Summary of the earlier work.' }] : CHILD(Number(who.replace('child', '')) || 0);
    const delta = who === 'compaction' ? { content: 'Summary of the earlier work.' } : script[turn] ?? { content: 'done' };
    const chunk = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const drop = cfg.dropFirst?.has(key) && attempt === 1;
    const slowMs = cfg.slow?.get(key) ?? 0;
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(chunk({ id: `chatcmpl-${ids.n}`, choices: [{ delta: { content: '' } }] }));
        if (drop) {
          controller.enqueue(chunk({ id: `chatcmpl-${ids.n}`, choices: [{ delta: { content: 'Partial answer that will be lost... ' } }] }));
          bill(30, 'partial-dropped');
          setTimeout(() => controller.error(new TypeError('terminated: other side closed')), 20);
          return;
        }
        if (slowMs) {
          const aborted = await new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), slowMs); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true }); });
          if (aborted) { bill(15, 'aborted-by-stop'); try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* closed */ } return; }
        }
        bill(40, 'stream');
        controller.enqueue(chunk({ id: `chatcmpl-${ids.n}`, choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] }));
        controller.enqueue(chunk({ id: `chatcmpl-${ids.n}`, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 40 } }));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'inference-id': id } });
  };
}


interface Outcome {
  name: string;
  bills: Bill[];
  billedNano: number;
  billingCalls: number[];
  posted: Array<Record<string, unknown>>;
  account: import('../services/spendAccount').SpendAccount;
  displays: { statusLine?: string; statusTooltip?: string; agentActivity?: string; spendingLimitsUsd: number; ledgerUsd: number; todayText: string };
}

async function scenario(name: string, cfg: Cfg, drive: (sidebar: Awaited<ReturnType<typeof openSidebar>>) => Promise<void>): Promise<Outcome> {
  const { root, auth } = await gsdProject();
  const bills: Bill[] = [];
  const billingCalls: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeNear(bills, { n: 0 }, cfg, Date.now(), billingCalls) as typeof fetch;
  const loop = require('../agent/loop') as typeof import('../agent/loop');
  const originalDelays = [...loop.RETRY_DELAYS_MS];
  loop.RETRY_DELAYS_MS.splice(0, loop.RETRY_DELAYS_MS.length, ...originalDelays.map(() => 50));
  let sidebar: Awaited<ReturnType<typeof openSidebar>> | undefined;
  try {
    sidebar = await openSidebar(root, auth);
    await drive(sidebar);
    // Background work and the run-end reconciliation settle.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { shownSpendAccount } = require('../services/spendAccount') as typeof import('../services/spendAccount');
    const account = shownSpendAccount()!;
    assert.ok(account, 'the sidebar follows the key\'s spend account');
    await account.ledger.flush();
    // What the scheduled reconciliation would do over the next minutes, at once.
    await account.settleNow(() => true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const { activityStatus, sharedActivityFeed } = withVscode(() => require('../services/activityView') as typeof import('../services/activityView'));
    const status = [...sidebar.posted].reverse().find((message) => message.type === 'status' && String(message.value).includes('$'));
    const today = account.today();
    const billedNano = bills.reduce((sum, bill) => sum + bill.nano, 0);
    return {
      name, bills, billedNano, billingCalls, posted: sidebar.posted, account,
      displays: { statusLine: status ? String(status.value) : undefined, statusTooltip: status?.tooltip as string | undefined, agentActivity: activityStatus(sharedActivityFeed(), account).spend?.text, spendingLimitsUsd: account.spentTodayUsd().usd, ledgerUsd: totalNanoUsd(account.totals()) / 1e9, todayText: today.text }
    };
  } finally {
    // Closing the view ends the conversation and its shells.
    sidebar?.close();
    globalThis.fetch = originalFetch;
    loop.RETRY_DELAYS_MS.splice(0, loop.RETRY_DELAYS_MS.length, ...originalDelays);
  }
}

/** The ledger has every request NEAR billed, at NEAR's figure, and every display shows that one total. */
function assertReconciled(outcome: Outcome): void {
  const totals = outcome.account.totals();
  assert.ok(outcome.billedNano > 0, `${outcome.name}: NEAR billed something`);
  assert.equal(totals.confirmedNanoUsd, outcome.billedNano, `${outcome.name}: under-count is 0 (ledger confirmed ${totals.confirmedNanoUsd}, NEAR billed ${outcome.billedNano})`);
  assert.equal(totals.pendingNanoUsd + totals.estimatedNanoUsd, 0, `${outcome.name}: nothing is left pending or estimated once NEAR has answered`);
  const billedIds = new Set(outcome.bills.map((bill) => bill.id));
  const ledgerIds = new Set(outcome.account.ledger.list().map((entry) => entry.requestId).filter(Boolean));
  assert.deepEqual([...billedIds].filter((id) => !ledgerIds.has(id)), [], `${outcome.name}: every billed request is in the ledger`);
  const usd = (nano: number) => `$${(nano / 1e9).toFixed(2)}`;
  assert.equal(outcome.displays.todayText, `${usd(outcome.billedNano)} today (confirmed)`);
  assert.ok(outcome.displays.statusLine?.endsWith(outcome.displays.todayText), `${outcome.name}: the chat status line shows the ledger's total (${outcome.displays.statusLine})`);
  assert.match(outcome.displays.statusTooltip ?? '', /Confirmed: NEAR's billing API reported the actual cost/);
  assert.equal(outcome.displays.agentActivity, outcome.displays.todayText, `${outcome.name}: Agent Activity shows the same total`);
  assert.equal(outcome.displays.spendingLimitsUsd, outcome.billedNano / 1e9, `${outcome.name}: the daily limit checks the same total`);
  assert.ok(outcome.billingCalls.every((count) => count <= 10_000));
}

test('S1. a GSD plan step in auto mode (2 foreground + 1 background sub-agent, safety checks): every request is in the ledger, at NEAR\'s cost', async () => {
  const outcome = await scenario('S1', { main: PLAN_MAIN }, async (sidebar) => { await sidebar.send({ type: 'open-command', command: 'plan-phase', model: MAIN }); });
  assertReconciled(outcome);
  const kinds = new Set(outcome.account.ledger.list().map((entry) => entry.kind));
  for (const kind of ['main', 'sub-agent', 'safety'] as const) assert.ok(kinds.has(kind), `S1 records ${kind} requests`);
  const runIds = new Set(outcome.account.ledger.list().map((entry) => entry.runId));
  assert.equal(runIds.size, 1, 'the sub-agents (background one included) and safety checks belong to the run');
  // The reply footer: the run's ledger total, then NEAR's figure for all of it.
  const done = outcome.posted.find((message) => message.type === 'assistant-done') as { usage: { estimatedCostUsd: number }; spend: { text: string } };
  const cost = outcome.posted.find((message) => message.type === 'assistant-cost') as { actualCostUsd: number } | undefined;
  assert.ok(done.spend.text.endsWith('this run'));
  assert.ok(cost, 'the footer gets NEAR\'s actual cost');
  assert.equal(Math.round(cost.actualCostUsd * 1e9), outcome.billedNano);
});

test('S2. two streams drop mid-response and are retried: the dropped attempts are recorded (partial) and reconciled by their inference-id', async () => {
  const outcome = await scenario('S2', { main: PLAN_MAIN, dropFirst: new Set(['main#1', 'child1#1']) }, async (sidebar) => { await sidebar.send({ type: 'open-command', command: 'plan-phase', model: MAIN }); });
  const partial = outcome.account.ledger.list().filter((entry) => entry.status === 'partial');
  assert.equal(partial.length, 2, 'both dropped streams are in the ledger');
  assert.ok(partial.every((entry) => entry.requestId && entry.estimateNanoUsd > 0), 'with a provisional estimate and the ID to reconcile');
  assertReconciled(outcome);
});

test('S3. stop pressed while the sub-agents are streaming: the stopped run, its sub-agents, and their cut-off streams all count', async () => {
  const outcome = await scenario('S3', { main: PLAN_MAIN, slow: new Map([['child0#1', 1500], ['child1#1', 1500], ['child2#1', 1500]]) }, async (sidebar) => {
    const run = sidebar.send({ type: 'open-command', command: 'plan-phase', model: MAIN });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await sidebar.send({ type: 'stop' });
    await run;
  });
  assert.ok(outcome.posted.some((message) => message.type === 'assistant-cancelled'));
  assert.ok(outcome.account.ledger.list().some((entry) => entry.status === 'aborted' && entry.kind === 'sub-agent'), 'the stopped sub-agent streams are recorded');
  assertReconciled(outcome);
});

test('S4. a run that fails after its sub-agents ran: everything it used counts', async () => {
  const outcome = await scenario('S4', { main: PLAN_MAIN, fail: new Set(['main#3']) }, async (sidebar) => { await sidebar.send({ type: 'open-command', command: 'plan-phase', model: MAIN }); });
  assert.ok(outcome.posted.some((message) => message.type === 'assistant-error'));
  assertReconciled(outcome);
});

test('S5. two messages in one conversation with a small context window: summarisation requests count, and the conversation window sums both runs', async () => {
  const outcome = await scenario('S5', { main: READS_MAIN, contextLength: 6000 }, async (sidebar) => {
    await sidebar.send({ type: 'send', text: 'Read BIG.md several times.', model: MAIN });
    await sidebar.send({ type: 'send', text: 'Again, read BIG.md several times.', model: MAIN });
  });
  assert.ok(outcome.bills.some((bill) => bill.who === 'compaction'), 'the conversation was summarised');
  assert.ok(outcome.account.ledger.list().some((entry) => entry.kind === 'summary'), 'summaries are recorded');
  assertReconciled(outcome);
  const entries = outcome.account.ledger.list();
  const conversations = new Set(entries.map((entry) => entry.conversationId));
  assert.equal(conversations.size, 1);
  assert.equal(new Set(entries.map((entry) => entry.runId)).size, 2);
  assert.equal(outcome.account.totals({ conversationId: [...conversations][0] }).confirmedNanoUsd, outcome.billedNano);
});
