// PR #87 review round 3: every place that raises a mark from content also feeds that content's fingerprints, through the one shared hook (D-54, D-60);
// the outbound check reads a step's whole payload; an open labelled read refuses a call that could send (fail closed); and every label event record has the
// same shape. Every project is under the temporary folder, every label file is unsigned (labels only raise), and nothing is sent.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { beginLabelledRead, gateStep, gateToolCall } from '../agent/gateAdapter';
import { OUTBOUND_MATCH_TEXT, OUTBOUND_UNCHECKED_TEXT, OutboundFingerprints } from '../agent/outboundCheck';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { INTERACTIVE_AND_UNATTENDED, declareManifest, fromArgument } from '../agent/tools';
import type { AgentTool, ToolContext } from '../agent/tools';
import { webFetchTool } from '../agent/webTools';
import type { AskRoleResult } from '../agent/cyberProtocolDriver';
import type { DisclaimerAcceptance, Engagement } from '../domain/cyber';
import { scopeFingerprint } from '../domain/cyberLegal';
import type { Step, StepRole } from '../domain/cyberProtocol';
import { SessionMark } from '../domain/gate/dominance';
import type { DecisionRecord } from '../domain/gate/record';
import { CyberEvidenceStore, CyberLedgerStore } from '../services/cyberLedgerStore';
import { startCyberRun } from '../services/cyberRun';
import type { CyberRunEvent, RunTool } from '../services/cyberRun';
import { testGateRuntime } from './helpers/gatedRuns';
import { grantsAt, keys, label, labelledProject } from './helpers/markFixtures';

const LINE = 'Quarterly figures show the river office spent four hundred thousand on contractors last year.';
const ACCEPTANCE: DisclaimerAcceptance = { acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10', textVersion: 'v1', region: 'us', acceptedAt: '2026-10-31T12:00:00Z' };
const SCOPE = { hosts: ['example.test'], ports: [443], paths: [], exclusions: [] };

function step(id: string, tool: string): Step {
  return { id, role: 'operator', action: 'probe', target: 'https://example.test/', tool, args: ['https://example.test/'], sandbox: 'none', expectedResult: 'a result', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] } };
}

class ScriptedModel {
  public constructor(private readonly replies: Partial<Record<StepRole, string[]>>) {}
  public async askRole(role: StepRole): Promise<AskRoleResult> {
    const queue = this.replies[role];
    const reply = queue?.length ? queue.shift()! : JSON.stringify({ ...step(`done-${role}`, 'done'), role, action: 'report' });
    return { kind: 'steps', role, steps: [JSON.parse(reply) as Step], repairs: 0 };
  }
}

/** A cyber scan with two steps: MemoRead reads memo.md (org/Internal), then Upload sends the memo's line in its arguments, not in a command. */
async function scan(): Promise<{ uploads: string[]; events: CyberRunEvent[]; grants: RunGrants; records: DecisionRecord[] }> {
  const root = labelledProject({ entries: { 'memo.md': label('org', 'Internal') } });
  writeFileSync(path.join(root, 'memo.md'), `${LINE}\n`);
  const memoRead: AgentTool<{ path: string }> = {
    name: 'MemoRead', description: 'reads', parameters: { type: 'object', properties: {} }, capability: 'read',
    manifest: declareManifest({ tool: 'MemoRead', effects: [{ verb: 'read', paths: [fromArgument('path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: (raw) => ({ path: String(raw.path) }), title: () => 'MemoRead', run: async () => readFileSync(path.join(root, 'memo.md'), 'utf8')
  };
  const uploads: string[] = [];
  const upload: AgentTool<{ url: string; body: string }> = {
    name: 'Upload', description: 'sends', parameters: { type: 'object', properties: {} }, capability: 'read',
    manifest: declareManifest({ tool: 'Upload', effects: [{ verb: 'network', hosts: ['example.test'] }], hosts: ['example.test'], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: (raw) => ({ url: String(raw.url), body: String(raw.body) }), title: () => 'Upload', run: async (input) => { uploads.push(input.body); return 'sent'; }
  };
  const tools: RunTool[] = [
    { tool: memoRead, capability: 'read', input: () => ({ path: 'memo.md' }), target: (candidate) => candidate.target },
    { tool: upload, capability: 'read', input: () => ({ url: 'https://example.test/collect', body: LINE }), target: (candidate) => candidate.target }
  ];
  const first = step('s1', 'MemoRead');
  const second = step('s2', 'Upload');
  const replies: Partial<Record<StepRole, string[]>> = { planner: [JSON.stringify(first), JSON.stringify(second)], operator: [JSON.stringify(first), JSON.stringify(second)] };
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-mark-r3-cyber-'));
  const shell = new ShellSession(root);
  const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('r3'), shell, readFiles: new Set() };
  const grants = new RunGrants();
  grants.mark = new SessionMark([label('org', 'Public')]);
  grants.outbound = new OutboundFingerprints();
  const gate = testGateRuntime();
  const events: CyberRunEvent[] = [];
  const engagement: Engagement = {
    id: 'eng-00000000-0000-4000-8000-0000000000r3', workspace: root, target: { kind: 'url', value: 'https://example.test/' }, resolvedScope: SCOPE, region: 'us',
    authorizationStatement: 'The acceptor owns the target.', allowedModes: ['passive'], exclusions: [], sandbox: { tier: 'tempFolder' }, acceptedDisclaimer: ACCEPTANCE,
    createdAt: ACCEPTANCE.acceptedAt, frozen: false
  };
  try {
    await startCyberRun({
      engagement, currentAcceptance: { region: 'us', scope: scopeFingerprint(SCOPE), extensionVersion: '0.4.10', textVersion: 'v1' },
      driver: new ScriptedModel(replies) as never, tools, ledger: new CyberLedgerStore(directory), evidence: new CyberEvidenceStore(directory), grants,
      policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }),
      signal: new AbortController().signal, toolContext: context, gate, now: () => new Date('2026-11-17T12:00:00Z'), onEvent: (event) => events.push(event)
    });
  } finally {
    shell.dispose();
  }
  return { uploads, events, grants, records: gate.records };
}

test('review 3.1: a cyber scan at Internal whose first step reads labelled text and second step sends it in its arguments is refused', async () => {
  const { uploads, grants, records } = await scan();
  assert.deepEqual(keys(grants.mark!.current()), ['org/Internal'], 'the read raised the scan\'s own mark');
  assert.ok(grants.outbound!.size > 0, 'and fed its output to the fingerprints through the same hook');
  assert.deepEqual(uploads, [], 'the upload never ran');
  const refusal = records.find((record) => record.authorizations[0]?.policy.name === 'label.outbound-match');
  assert.ok(refusal, 'refused with label.outbound-match');
  assert.ok(JSON.stringify(refusal).includes(OUTBOUND_MATCH_TEXT.slice(0, 60)), 'with the plain sentence');
});

test('review 3.1: a step whose arguments, not its command, carry the labelled text is refused by gateStep', async () => {
  const root = labelledProject();
  const grants = grantsAt([label('org', 'Internal')]);
  grants.outbound!.add(LINE);
  const gated = await gateStep(testGateRuntime(), {
    tool: 'Upload', callId: 'u1', effects: [{ verb: 'network', hosts: ['example.test'] } as never], root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }, mark: grants.mark!, outbound: grants.outbound!, raw: { url: 'https://example.test/', body: LINE }
  });
  assert.equal(gated.decision.rule, 'label.outbound-match');
});

test('review 3.1: while a labelled read is open and not yet fingerprinted, a call that could send is refused; once settled, unrelated calls run', async () => {
  const root = labelledProject();
  const runtime = testGateRuntime();
  const grants = grantsAt([label('org', 'Internal')]);
  const read = beginLabelledRead(runtime, grants, [label('org', 'Internal')], false, 'Read');
  const decideFetch = () => gateToolCall(runtime, { tool: webFetchTool, raw: { url: 'https://example.test/?q=weather' }, root, callId: 'f', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants, buildAuto: async () => undefined });
  const open = await decideFetch();
  assert.equal(open.decision.rule, 'label.outbound-match');
  assert.equal(open.decision.reason, OUTBOUND_UNCHECKED_TEXT);
  read.settle(LINE);
  const settled = await decideFetch();
  assert.ok(!settled.decision.rule.startsWith('label.'), settled.decision.rule);
});

test('review 3.1: one shared hook raises a mark from content and feeds its fingerprints; no other source file does either', () => {
  const src = path.join(__dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'test') walk(path.join(dir, entry.name)); } else if (entry.name.endsWith('.ts')) files.push(path.join(dir, entry.name));
    }
  };
  walk(src);
  const rel = (file: string): string => path.relative(src, file).split(path.sep).join('/');
  const text = new Map(files.map((file) => [rel(file), readFileSync(file, 'utf8')]));
  // A mark rises from content only in the shared hook; agentSession raises a chat's mark only by the project's own label at a run's start.
  const raisers = [...text].filter(([, source]) => /\.raise\(/.test(source)).map(([file]) => file).sort();
  assert.deepEqual(raisers, ['agent/gateAdapter.ts', 'services/agentSession.ts']);
  const sessionRaises = (text.get('services/agentSession.ts') ?? '').split('\n').filter((line) => /\.raise\(/.test(line));
  assert.ok(sessionRaises.length === 1 && /projectLabel/.test(sessionRaises[0]!), sessionRaises.join('\n'));
  // Fingerprints are fed only by the shared hook (settle) or, for a reopened chat, as earlier results.
  const feeders = [...text].filter(([, source]) => /(outbound|Prints|fingerprints)\??\.(add|settle|open)\(/.test(source)).map(([file]) => file).sort();
  assert.deepEqual(feeders, ['agent/gateAdapter.ts']);
  // Every runner that reads content goes through the hook.
  const users = [...text].filter(([, source]) => /beginLabelledRead\(/.test(source)).map(([file]) => file).sort();
  assert.deepEqual(users, ['agent/gateAdapter.ts', 'agent/loop.ts', 'services/cyberRun.ts']);
  assert.ok(!/export function raiseRunMark/.test(text.get('agent/gateAdapter.ts') ?? ''), 'the raise alone is not exported');
});
