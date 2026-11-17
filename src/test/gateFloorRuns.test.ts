// The floor through real runs (GATE-04, GATE-05, GATE-06, D-16, D-17, D-19, D-43, Pitfall 4): every floor rule, in every approval mode, with a person
// and with nobody, through a real AgentRun in a temporary project with a scripted model and a real shell. The shell's HOME is a stand-in home folder under
// the temporary folder, the extension's global storage is a stand-in folder there too, and every secret is in memory: no test here reads the real home or
// runs a command against a real credential store. A command that names a store is refused before anything runs, and would only reach the stand-in if not.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { floorApprovalsOnce } from '../agent/gateAdapter';
import { knowledgeTools } from '../agent/knowledgeTools';
import { AWAITING_APPROVAL_PREFIX, awaitingApprovalMessage } from '../agent/loop';
import type { ApprovalReply, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import type { PermissionRules } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, editTool, globTool, readTool, writeTool } from '../agent/tools';
import type { AgentTool, ToolContext } from '../agent/tools';
import type { ActionPolicy } from '../domain/policy';
import type { DecisionRecord } from '../domain/gate/record';
import { FLOOR_RULE_ORDER, FLOOR_RULES } from '../domain/gate/floor';
import { emptyKnowledge, mergeKnowledge } from '../domain/teamKnowledge';
import { teamLibraryDir } from '../domain/teamStorage';
import { mcpAgentTools } from '../mcp/tools';
import type { McpConnection } from '../mcp/client';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { fakeHome } from './helpers/gateFixtures';
import { bareRemote, fixtureGit } from './helpers/gitFixtures';
import { newTestConversation, newTestRun, testGateRuntime } from './helpers/gatedRuns';

const MODES = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const;
type Mode = (typeof MODES)[number];
type Presence = 'person' | 'none';
const TEMP = realpathSync(path.resolve(tmpdir()));
const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
const MARKER = 'stand-in-secret-7f3a';

/** Every folder a test here uses is under the temporary folder: never the real home, never a real project. */
function underTemp(folder: string): string {
  const real = realpathSync(folder);
  assert.ok(real === TEMP || real.startsWith(`${TEMP}${path.sep}`), `${real} is under the temporary folder`);
  return folder;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A model that makes the given calls one per turn, then stops. */
function scripted(calls: ToolCall[]) {
  let turn = 0;
  return {
    async *streamCompletion(_model: string, _messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const next = calls[turn];
      turn += 1;
      if (!next) { yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [next] }, finishReason: 'tool_calls', usage };
    }
  };
}

interface World {
  root: string;
  remote: string;
  home: string;
  storage: string;
  shell: ShellSession;
  learned: () => number;
  mcpCalls: () => number;
  tools: AgentTool<any>[];
}

/** A temporary project that is a git repository with a bare remote, a dirty tracked file and an untracked file, a stand-in home and global storage. */
function world(): World {
  const remote = underTemp(bareRemote());
  const root = underTemp(mkdtempSync(path.join(tmpdir(), 'near-ai-floor-runs-')));
  fixtureGit(root, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  fixtureGit(root, ['add', 'tracked.txt']);
  fixtureGit(root, ['commit', '-q', '-m', 'first']);
  fixtureGit(root, ['remote', 'add', 'origin', remote]);
  writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo (not committed)\n');
  writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');
  mkdirSync(path.join(root, '.near-ai', 'state', 'keys'), { recursive: true });
  writeFileSync(path.join(root, '.near-ai', 'state', 'keys', 'local.key'), `${MARKER}-key\n`);
  const home = underTemp(fakeHome());
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeFileSync(path.join(home, '.ssh', 'id_ed25519'), `${MARKER}-ssh\n`);
  const storage = underTemp(mkdtempSync(path.join(tmpdir(), 'near-ai-floor-storage-')));
  mkdirSync(path.join(storage, 'identity'), { recursive: true });
  writeFileSync(path.join(storage, 'identity', 'device.json'), `${MARKER}-identity\n`);
  const shell = new ShellSession(root, undefined, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  let graph = emptyKnowledge('floor-team', '2026-11-17T10:00:00.000Z');
  let learned = 0;
  const [, learn] = knowledgeTools({ read: async () => graph, add: async (addition) => { learned += 1; graph = mergeKnowledge(graph, addition); return graph; } }, 'research');
  let mcpCalls = 0;
  // A tool whose name the manifest format cannot hold gets the restrictive manifest, whose declared effects include destroy (plan 14).
  const connection = { tools: [{ name: 'wild*card', description: 'x', inputSchema: { type: 'object' }, readOnly: true, destructive: false }], call: async () => { mcpCalls += 1; return 'ok'; } } as unknown as McpConnection;
  const [restrictive] = mcpAgentTools({ id: 'catalog', name: 'Catalog', transport: 'http', approval: 'ask-for-changes' }, connection, 'catalog.example');
  return {
    root, remote, home, storage, shell, learned: () => learned, mcpCalls: () => mcpCalls,
    tools: [readTool, writeTool, editTool, bashTool, learn!, restrictive!]
  };
}

function remoteHas(remote: string, ref: string): boolean {
  return fixtureGit(remote, ['for-each-ref', '--format=%(refname)']).split('\n').includes(ref);
}

interface FloorCase {
  readonly rule: (typeof FLOOR_RULE_ORDER)[number];
  readonly calls: (w: World) => ToolCall[];
  /** True when anything the calls would do has happened. */
  readonly ran: (w: World, outputs: string[]) => boolean;
  /** The rule a run with nobody present records, when an earlier layer refuses first (a tool that only runs while a person is there). */
  readonly nobodyRule?: string;
  /**
   * Set for the add-on server tool: its restrictive manifest says it may do anything (shell anywhere, any host, write and destroy the whole project), which
   * no concrete call can be filled from, so the gate records `manifest.effects-unknown` rather than the floor rule. It asks and is refused exactly like a floor
   * ask, with no shortcut; its card is not marked as a floor card.
   */
  readonly unknownEffects?: true;
}

const CASES: readonly FloorCase[] = [
  {
    rule: 'floor.state-keys',
    calls: () => [call('k1', 'Read', { file_path: '.near-ai/state/keys/local.key' }), call('k2', 'Bash', { command: 'cat .near-ai/state/keys/local.key' })],
    ran: (_w, outputs) => outputs.some((text) => text.includes(`${MARKER}-key`))
  },
  {
    rule: 'floor.protected-write',
    calls: () => [call('w1', 'Write', { file_path: '.git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' })],
    ran: (w) => existsSync(path.join(w.root, '.git', 'hooks', 'pre-commit'))
  },
  {
    rule: 'floor.publish',
    calls: () => [call('p1', 'Bash', { command: 'git push origin HEAD:refs/heads/floor-test' })],
    ran: (w) => remoteHas(w.remote, 'refs/heads/floor-test')
  },
  {
    rule: 'floor.destroy',
    calls: () => [call('d1', 'Bash', { command: 'git reset --hard' }), call('d2', 'Bash', { command: 'git clean -fd' })],
    ran: (w) => readFileSync(path.join(w.root, 'tracked.txt'), 'utf8') === 'one\n' || !existsSync(path.join(w.root, 'untracked.txt'))
  },
  {
    rule: 'floor.shared-write',
    calls: () => [call('l1', 'Learn', { nodes: [{ label: 'Halden Ports', kind: 'organisation' }] })],
    ran: (w) => w.learned() > 0,
    nobodyRule: 'manifest.context'
  },
  {
    rule: 'floor.credential-store',
    calls: () => [call('c1', 'Bash', { command: 'cat ~/.ssh/id_ed25519' })],
    ran: (_w, outputs) => outputs.some((text) => text.includes(`${MARKER}-ssh`))
  },
  {
    rule: 'floor.identity-files',
    calls: (w) => [call('i1', 'Bash', { command: `cat ${path.join(w.storage, 'identity', 'device.json')}` })],
    ran: (_w, outputs) => outputs.some((text) => text.includes(`${MARKER}-identity`))
  },
  {
    rule: 'floor.destroy',
    calls: (w) => [call('m1', w.tools[5]!.name, { id: 'x' })],
    ran: (w) => w.mcpCalls() > 0,
    unknownEffects: true
  }
];

interface Ran {
  outputs: string[];
  cards: ApprovalRequest[];
  records: DecisionRecord[];
}

async function runIn(w: World, calls: ToolCall[], options: { mode: Mode; presence: Presence; answer?: (card: ApprovalRequest) => ApprovalReply; rules?: PermissionRules; emergencyStop?: boolean; grants?: RunGrants }): Promise<Ran> {
  const cards: ApprovalRequest[] = [];
  const gate = { ...testGateRuntime(options.presence === 'none' ? { presence: 'none', context: 'unattended' } : {}), locations: { home: w.home, globalStorage: w.storage } };
  const context: ToolContext = { root: w.root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('floor-runs'), shell: w.shell, readFiles: new Set() };
  const policy: ActionPolicy = { mode: options.mode, emergencyStop: options.emergencyStop ?? false };
  const run = newTestRun({
    client: scripted(calls) as never, model: 'm', tools: w.tools, context, policy, rules: options.rules ?? DEFAULT_RULES, gate,
    ...(options.grants ? { grants: options.grants } : {}),
    requestApproval: async (card) => { cards.push(card); return options.answer ? options.answer(card) : { decision: 'deny' }; },
    rememberAllowRule: () => undefined,
    emit: () => undefined
  });
  const result = await run.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], new AbortController().signal);
  return { outputs: result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content)), cards, records: gate.records };
}

const ruleOf = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';
function outcomeOf(record: DecisionRecord): string {
  if (record.unmapped.nearAi.outcome !== undefined) return record.unmapped.nearAi.outcome;
  if (record.disposition_id === 8) return 'approved';
  if (record.action_id === 1) return 'allowed';
  return record.disposition_id === 2 ? 'refused-by-floor' : 'denied';
}

test('every floor rule, in every mode, with a person and with nobody: refusals show no card, asks show a card with no shortcut, nothing runs unless approved', async () => {
  let checked = 0;
  const rulesSeen = new Set<string>();
  for (const floorCase of CASES) {
    for (const mode of MODES) {
      for (const presence of ['person', 'none'] as const) {
        const w = world();
        try {
          const calls = floorCase.calls(w);
          const ran = await runIn(w, calls, { mode, presence });
          const where = `${floorCase.rule} via ${calls[0]?.function.name} (${mode}, ${presence})`;
          const recorded = floorCase.unknownEffects ? 'manifest.effects-unknown' : floorCase.rule;
          assert.equal(floorCase.ran(w, ran.outputs), false, `${where}: nothing ran`);
          assert.equal(ran.outputs.length, calls.length, where);
          const refuses = FLOOR_RULES[floorCase.rule] === 'refuse';
          if (presence === 'person' && !refuses) {
            assert.equal(ran.cards.length, calls.length, `${where}: one card per call`);
            for (const card of ran.cards) {
              assert.equal(card.grant, undefined, `${where}: no run-wide grant`);
              assert.equal(card.allowRule, undefined, `${where}: no "always allow"`);
              if (!floorCase.unknownEffects) assert.notEqual(card.floor, undefined, `${where}: marked as a floor card`);
            }
            for (const output of ran.outputs) assert.match(output, /declined/, where);
            for (const one of calls) {
              const mine = ran.records.filter((record) => record.api.request.uid === one.id);
              assert.deepEqual(mine.map(outcomeOf), ['asked', 'denied'], `${where}: asked, then the person's deny`);
              assert.deepEqual(mine.map(ruleOf), [recorded, recorded], where);
            }
          } else {
            assert.equal(ran.cards.length, 0, `${where}: no card`);
            for (const output of ran.outputs) assert.match(output, /^Not allowed: /, where);
            const expected = presence === 'none' && floorCase.nobodyRule !== undefined ? floorCase.nobodyRule : recorded;
            for (const one of calls) {
              const mine = ran.records.filter((record) => record.api.request.uid === one.id);
              assert.equal(mine.length, 1, `${where}: one record`);
              assert.equal(ruleOf(mine[0]!), expected, where);
              assert.equal(outcomeOf(mine[0]!), expected.startsWith('floor.') ? 'refused-by-floor' : 'denied', where);
            }
            if (presence === 'none' && !refuses && floorCase.nobodyRule === undefined && !floorCase.unknownEffects) assert.match(ran.outputs[0] ?? '', /Nobody is here to approve this/, where);
          }
          if (!floorCase.unknownEffects) { rulesSeen.add(floorCase.rule); checked += 1; }
        } finally {
          w.shell.dispose();
        }
      }
    }
  }
  assert.deepEqual([...rulesSeen].sort(), [...FLOOR_RULE_ORDER].sort(), 'every floor rule is exercised');
  assert.equal(checked, 7 * 4 * 2, '7 floor rules x 4 modes x 2 presences, besides the add-on server tool\'s 8');
});

test('a person approving a floor card runs that one call; "for this run" grants nothing, so the next identical call asks again', async () => {
  for (const decision of ['allow', 'allow-run', 'allow-always'] as const) {
    const w = world();
    try {
      const command = 'printf x >> .git/hooks/post-commit';
      const grants = new RunGrants();
      const ran = await runIn(w, [call('a1', 'Bash', { command }), call('a2', 'Bash', { command })], { mode: 'fully-autonomous', presence: 'person', answer: () => ({ decision }), grants });
      assert.equal(ran.cards.length, 2, `${decision}: the second identical call asked again`);
      assert.equal(readFileSync(path.join(w.root, '.git', 'hooks', 'post-commit'), 'utf8'), 'xx', `${decision}: each approved call ran once`);
      assert.equal(grants.commands.size, 0, `${decision}: no command was granted for the run`);
      assert.equal(grants.allowRules.size, 0, `${decision}: no allow rule was added`);
      assert.deepEqual(ran.records.map(outcomeOf), ['asked', 'approved', 'asked', 'approved'], decision);
    } finally {
      w.shell.dispose();
    }
  }
  const w = world();
  try {
    const grants = new RunGrants();
    // The floor write is approved "for this run"; the plain write after it still asks, because nothing was granted for the run.
    const ran = await runIn(w, [call('e1', 'Write', { file_path: '.git/hooks/pre-commit', content: 'a' }), call('e2', 'Write', { file_path: 'notes.md', content: 'b' })], {
      mode: 'approve-risky', presence: 'person', grants, answer: (card) => ({ decision: card.floor ? 'allow-run' : 'deny' })
    });
    assert.equal(ran.cards.length, 2, 'the plain write asked: the floor approval did not turn on edits for the run');
    assert.equal(grants.edits, false);
    assert.equal(readFileSync(path.join(w.root, '.git', 'hooks', 'pre-commit'), 'utf8'), 'a');
  } finally {
    w.shell.dispose();
  }
});

test('the deny list beats a floor ask, and the emergency stop refuses every floor action with no card', async () => {
  const w = world();
  try {
    const pushed = await runIn(w, [call('f1', 'Bash', { command: 'git push --force origin HEAD:refs/heads/forced' })], { mode: 'fully-autonomous', presence: 'person' });
    assert.equal(pushed.cards.length, 0);
    assert.match(pushed.outputs[0] ?? '', /deny list/);
    assert.equal(ruleOf(pushed.records[0]!), 'settings.deny-list');
    assert.equal(remoteHas(w.remote, 'refs/heads/forced'), false);
  } finally {
    w.shell.dispose();
  }
  for (const floorCase of CASES) {
    const v = world();
    try {
      const calls = floorCase.calls(v);
      const stopped = await runIn(v, calls, { mode: 'fully-autonomous', presence: 'person', emergencyStop: true });
      assert.equal(stopped.cards.length, 0, floorCase.rule);
      assert.equal(floorCase.ran(v, stopped.outputs), false, floorCase.rule);
      for (const record of stopped.records) assert.equal(ruleOf(record), 'settings.emergency-stop', floorCase.rule);
    } finally {
      v.shell.dispose();
    }
  }
});

test('when nobody answers a floor card in time, the agent is told the call is allowed once if approved, not for the rest of the run', () => {
  const floor = awaitingApprovalMessage({ floor: { callKey: 'k' } });
  assert.ok(floor.startsWith(AWAITING_APPROVAL_PREFIX));
  assert.match(floor, /allowed once, not for the rest of this run/);
  assert.doesNotMatch(floor, /allowed for the rest of this run\./);
  assert.match(awaitingApprovalMessage({ grant: { command: 'npm install' } }), /allowed for the rest of this run\./, 'a card that offers a grant keeps its words');
});

// PR #74 review round 6: what the agent is told follows what the card offers. A card with no grant (effects the gate cannot read, a held action) grants
// nothing, so the agent is not told the call would be allowed for the rest of the run; only a card that carries a grant says that.
test('the waiting message matches the card: floor once, a grant for the rest of the run, no grant nothing ahead of time', () => {
  const none = awaitingApprovalMessage({});
  assert.ok(none.startsWith(AWAITING_APPROVAL_PREFIX));
  assert.doesNotMatch(none, /for the rest of this run\./);
  assert.doesNotMatch(none, /allowed once/);
  assert.match(none, /grants nothing ahead of time/);
  assert.match(awaitingApprovalMessage({ grant: { edits: true } }), /allowed for the rest of this run\./);
  assert.match(awaitingApprovalMessage({ floor: { callKey: 'k' }, grant: { command: 'x' } }), /allowed once/, 'a floor card never carries a grant; if it did, once wins');
});

test('through a real run: an effects-unknown card nobody answers tells the agent nothing is granted, and a grantable one says the rest of the run', async () => {
  const w = world();
  try {
    const unknown = await runIn(w, [call('u1', w.tools[5]!.name, { id: 'x' })], { mode: 'fully-autonomous', presence: 'person', answer: () => ({ decision: 'pending' }) });
    assert.equal(unknown.cards.length, 1);
    assert.equal(unknown.cards[0]!.grant, undefined, 'the card offers no grant');
    assert.match(unknown.outputs[0] ?? '', /grants nothing ahead of time/);
    assert.doesNotMatch(unknown.outputs[0] ?? '', /for the rest of this run/);
    const grantable = await runIn(w, [call('g1', 'Bash', { command: 'npm install left-pad' })], { mode: 'approve-risky', presence: 'person', answer: () => ({ decision: 'pending' }) });
    assert.notEqual(grantable.cards[0]?.grant, undefined, 'this card offers a grant');
    assert.match(grantable.outputs[0] ?? '', /allowed for the rest of this run\./);
  } finally {
    w.shell.dispose();
  }
});

async function until<T>(find: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error('the expected message never arrived');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a sub-agent\'s floor card answered late allows that exact call once: the retried call runs with no card, and a second retry asks again', async () => {
  const root = underTemp(mkdtempSync(path.join(tmpdir(), 'near-ai-floor-late-')));
  mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const hook = { file_path: '.git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' };
  let subTurn = 0;
  let leadTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content ?? '').startsWith('You help')) {
        subTurn += 1;
        if (subTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('s1', 'Write', hook)] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'Queued the hook; it is waiting for approval.' }, finishReason: 'stop', usage };
        return;
      }
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'add the hook', description: 'hook' })] }, finishReason: 'tool_calls', usage }; return; }
      const told = messages.some((message) => String(message.content ?? '').startsWith('<approval-update agent="helper" decision="allowed-once">'));
      const did = (id: string): boolean => messages.some((message) => message.role === 'tool' && message.tool_call_id === id);
      if (!told) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`wait${leadTurn}`, 'Read', { file_path: '.git/HEAD' })] }, finishReason: 'tool_calls', usage }; return; }
      if (!did('l2')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('l2', 'Write', hook)] }, finishReason: 'tool_calls', usage }; return; }
      if (!did('l3')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('l3', 'Write', hook)] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const posted: Array<Record<string, unknown>> = [];
  const conversation = newTestConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 20;
  const running = conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, projectAgents: [{ name: 'helper', description: 'helper', tools: ['Write', 'Read'], body: 'You help.', file: path.join(root, 'team.md') }] });
  try {
    const card = await until(() => posted.find((message) => message.type === 'approval-request' && String(message.callId).endsWith(':s1')));
    assert.equal(card.floor, true, 'the page is told it is a floor card, so it offers no "for this run"');
    assert.equal(card.allowRule, undefined);
    const waiting = await until(() => posted.find((message) => message.type === 'tool-end' && String(message.output).startsWith(AWAITING_APPROVAL_PREFIX)));
    assert.match(String(waiting.output), /allowed once/, 'the sub-agent is told the call would be allowed once');
    assert.equal(existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), false, 'nothing ran while the card waited');
    conversation.answerApproval(String(card.callId), { decision: 'allow-run' });
    // The lead retries the exact call once (it runs with no card), then again: that one asks, and the person declines it.
    const again = await until(() => posted.find((message) => message.type === 'approval-request' && message.callId === 'l3'));
    assert.equal(existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), true, 'the retried call ran once');
    conversation.answerApproval(String(again.callId), { decision: 'deny' });
    await running;
  } finally {
    conversation.dispose();
  }
  const cards = posted.filter((message) => message.type === 'approval-request').map((message) => String(message.callId));
  assert.equal(cards.some((id) => id === 'l2'), false, 'the retried call showed no card');
  assert.equal(cards.filter((id) => id.endsWith(':s1') || id === 'l3').length, 2);
  assert.ok(posted.some((message) => message.type === 'tool-end' && message.callId === 'l2' && message.ok === true), 'the retried call ran');
  assert.ok(posted.some((message) => message.type === 'tool-end' && message.callId === 'l3' && message.ok === false), 'the second retry was declined');
});

test('a late floor approval is kept beside the run\'s grants, never in them, and is used up by one call', () => {
  const grants = new RunGrants();
  const once = floorApprovalsOnce(grants);
  assert.equal(once.size, 0);
  once.add('key', 1_000);
  assert.equal(floorApprovalsOnce(grants).has('key', 1_000), true, 'the same set for the same run');
  assert.equal(floorApprovalsOnce(new RunGrants()).has('key', 1_000), false, 'another run has its own');
  assert.equal(grants.commands.size + grants.allowRules.size, 0);
  assert.equal(grants.edits, false);
});

// Carried forward from the PR #70 review: the folders outside the project that runs read on purpose (the managed Open-GSD runtime the file tools may read,
// and the person's teams folder the shell's checks trust) keep working once the floor is enforced, without widening what may be written or read elsewhere.
test('a file-tool read in the trusted Open-GSD folder runs with no card in every mode, a shell read of the teams folder is decided as a project read is, and a write there or a read outside every trusted folder still asks or is refused', async () => {
  const gsdHome = underTemp(mkdtempSync(path.join(tmpdir(), 'near-ai-floor-gsd-')));
  mkdirSync(path.join(gsdHome, 'bin'), { recursive: true });
  writeFileSync(path.join(gsdHome, 'bin', 'gsd-tools.cjs'), '// gsd-marker\n');
  const outside = underTemp(mkdtempSync(path.join(tmpdir(), 'near-ai-floor-outside-')));
  writeFileSync(path.join(outside, 'x.txt'), 'outside-marker\n');
  let checked = 0;
  for (const mode of MODES) {
    for (const presence of ['person', 'none'] as const) {
      const w = world();
      const teams = teamLibraryDir(w.home, {});
      mkdirSync(path.join(teams, 'crew'), { recursive: true });
      writeFileSync(path.join(teams, 'crew', 'team.md'), 'team-marker\n');
      const where = `${mode}, ${presence}`;
      try {
        const cards: ApprovalRequest[] = [];
        const gate = { ...testGateRuntime(presence === 'none' ? { presence: 'none', context: 'unattended' } : {}), locations: { home: w.home, globalStorage: w.storage } };
        const context: ToolContext = {
          root: w.root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('floor-trusted'), shell: w.shell, readFiles: new Set(),
          readOnlyRoots: [gsdHome], trustedToolRoots: [gsdHome, teams]
        };
        const calls = [
          call('t1', 'Read', { file_path: path.join(gsdHome, 'bin', 'gsd-tools.cjs') }),
          call('t2', 'Glob', { pattern: '*.cjs', path: path.join(gsdHome, 'bin') }),
          call('t3', 'Bash', { command: `cat ${path.join(teams, 'crew', 'team.md')}` }),
          call('t4', 'Write', { file_path: path.join(gsdHome, 'bin', 'planted.cjs'), content: 'x' }),
          call('t5', 'Read', { file_path: path.join(outside, 'x.txt') }),
          call('t6', 'Bash', { command: 'cat tracked.txt' })
        ];
        const run = newTestRun({
          client: scripted(calls) as never, model: 'm', tools: [readTool, writeTool, globTool, bashTool], context, policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, gate,
          requestApproval: async (card) => { cards.push(card); return { decision: 'deny' }; },
          emit: () => undefined
        });
        const result = await run.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], new AbortController().signal);
        const outputs = result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
        assert.match(outputs[0] ?? '', /gsd-marker/, `${where}: the Open-GSD runtime file was read`);
        assert.match(outputs[1] ?? '', /gsd-tools\.cjs/, `${where}: the Open-GSD runtime folder was listed`);
        // The shell read of the teams folder is decided exactly as a shell read of a project file is (approve-risky and mostly-autonomous ask before
        // every command not on the allow list, as they always have); the floor never refuses or asks about it.
        const shellRule = (id: string): string => ruleOf(gate.records.find((record) => record.api.request.uid === id)!);
        assert.equal(shellRule('t3'), shellRule('t6'), `${where}: the teams folder read is decided as a project read`);
        assert.equal(shellRule('t3').startsWith('floor.') || shellRule('t3') === 'manifest.effects-unknown', false, `${where}: ${shellRule('t3')}`);
        if (mode === 'auto' || mode === 'fully-autonomous') assert.match(outputs[2] ?? '', /team-marker/, `${where}: the teams folder was read through the shell`);
        const read = gate.records.find((record) => record.api.request.uid === 't1');
        assert.equal(ruleOf(read!), 'settings.read-plan', `${where}: a known read, decided as a read`);
        assert.equal(read?.resources[0]?.name, `${path.basename(realpathSync(gsdHome))}/bin/gsd-tools.cjs`, `${where}: the record names the file by its folder, not the machine path`);
        // A write there is never a known write: with nobody here the gate refuses it, and with a person the Write tool refuses the path itself (its card
        // preview cannot be built for a path outside the project), as it always has. The trusted folder is for reading only.
        assert.match(outputs[3] ?? '', presence === 'none' ? /^Not allowed: NEAR AI cannot tell what Write would do/ : /outside the workspace/, `${where}: ${outputs[3]}`);
        assert.equal(existsSync(path.join(gsdHome, 'bin', 'planted.cjs')), false, `${where}: nothing was written into the trusted folder`);
        assert.doesNotMatch(outputs[4] ?? '', /outside-marker/, `${where}: a file outside every trusted folder was not read`);
        const outsideRead = gate.records.find((entry) => entry.api.request.uid === 't5');
        assert.equal(ruleOf(outsideRead!), 'manifest.effects-unknown', `${where}: a read outside every trusted folder is still a call whose effects are unknown`);
        const fileCards = cards.filter((card) => card.tool !== 'Bash');
        assert.deepEqual(fileCards.map((card) => card.tool), presence === 'person' ? ['Read'] : [], `${where}: of the file tools, only the outside read asked`);
        for (const card of fileCards) {
          assert.equal(card.grant, undefined, where);
          assert.equal(card.allowRule, undefined, where);
        }
        checked += 1;
      } finally {
        w.shell.dispose();
      }
    }
  }
  assert.equal(checked, 8);
});

test('a file tool path that names a credential store or the identity folders is refused by the floor with no card, wherever the tool would look', async () => {
  for (const mode of MODES) {
    const w = world();
    try {
      const calls = [
        call('r1', 'Read', { file_path: path.join(w.home, '.ssh', 'id_ed25519') }),
        call('r2', 'Read', { file_path: path.join(w.storage, 'identity', 'device.json') }),
        call('r3', 'Read', { file_path: '~/.ssh/id_ed25519' })
      ];
      const ran = await runIn(w, calls, { mode, presence: 'person' });
      assert.equal(ran.cards.length, 0, mode);
      assert.equal(ran.outputs.some((text) => text.includes(MARKER)), false, mode);
      assert.deepEqual(ran.records.map(ruleOf), ['floor.credential-store', 'floor.identity-files', 'floor.credential-store'], mode);
    } finally {
      w.shell.dispose();
    }
  }
});

test('an allow-list entry that matches a floor action does not get past the floor: it still asks, with no shortcut', async () => {
  for (const mode of MODES) {
    const w = world();
    try {
      const rules: PermissionRules = { allowCommands: ['git push'], denyCommands: DEFAULT_RULES.denyCommands };
      const ran = await runIn(w, [call('g1', 'Bash', { command: 'git push origin HEAD:refs/heads/listed' })], { mode, presence: 'person', rules });
      assert.equal(ran.cards.length, 1, mode);
      assert.equal(ran.cards[0]?.allowRule, undefined, mode);
      assert.equal(ran.cards[0]?.grant, undefined, mode);
      assert.equal(ruleOf(ran.records[0]!), 'floor.publish', mode);
      assert.equal(remoteHas(w.remote, 'refs/heads/listed'), false, mode);
    } finally {
      w.shell.dispose();
    }
  }
});

// PR #74 review round 4: the floor reads the package.json of the folder a package manager runs in. Through a real run in Full auto with nobody present, a
// `cd sub && npm run sync` whose sub/package.json pushes is refused as a publish and nothing reaches the remote; the same name at the root (which pushes
// nothing) still runs.
test('through a real run in Full auto, cd into a package whose script pushes is refused as a publish, and nothing is pushed', async () => {
  const w = world();
  try {
    mkdirSync(path.join(w.root, 'sub'));
    writeFileSync(path.join(w.root, 'sub', 'package.json'), JSON.stringify({ name: 'sub', scripts: { sync: 'git push origin HEAD:refs/heads/from-sub-script' } }));
    writeFileSync(path.join(w.root, 'package.json'), JSON.stringify({ name: 'root', scripts: { sync: 'echo root-sync-ran' } }));
    const ran = await runIn(w, [call('s1', 'Bash', { command: 'cd sub && npm run sync' }), call('s2', 'Bash', { command: 'npm run sync' })], { mode: 'fully-autonomous', presence: 'none' });
    assert.match(ran.outputs[0] ?? '', /^Not allowed: /, 'the sub-package push is refused');
    assert.equal(remoteHas(w.remote, 'refs/heads/from-sub-script'), false, 'nothing was pushed');
    const first = ran.records.filter((record) => record.api.request.uid === 's1');
    assert.equal(ruleOf(first[0]!), 'floor.publish');
    assert.match(ran.outputs[1] ?? '', /root-sync-ran/, 'the root script, which pushes nothing, runs as before');
  } finally {
    w.shell.dispose();
  }
});
