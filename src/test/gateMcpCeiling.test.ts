// WP-GATE (a Phase 70 follow-up, research note 01 section 4): a label ceiling per MCP server in the signed policy bundle, enforced for every label and every
// routing tier before anything is sent, with a decision record for each refusal. These are security tests and blocking. Every server here is a stand-in
// object; nothing reaches the network, and no key material is written down (keys are generated at run time).
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateStep, gateToolCall, mcpCeilingText, mcpCeilingUnjudgedText, mcpCeilingVerdictFor } from '../agent/gateAdapter';
import type { MemoryGateRuntime } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import type { AgentTool } from '../agent/tools';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload, isDefaultBundle, parseBundle, verifyBundleEnvelope } from '../domain/gate/bundle';
import type { BundleState, GateContextName, PolicyBundle } from '../domain/gate/bundle';
import { GATE_RULE_IDS, RECORD_RULE_IDS } from '../domain/gate/decide';
import type { GateRuntime } from '../domain/gate/decide';
import { SessionMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import type { Clearance, Label } from '../domain/gate/labels';
import { validateDecisionRecord } from '../domain/gate/record';
import { ROUTING_TIERS } from '../domain/gate/routing';
import type { RoutingTier } from '../domain/gate/routing';
import { fingerprintOf } from '../domain/team/canonical';
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import type { McpConnection, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpAgentTools } from '../mcp/tools';
import { grantsAt, label, runWith, call } from './helpers/markFixtures';
import { testGateRuntime } from './helpers/gatedRuns';

const ORG = ['Public', 'Internal', 'Confidential', 'Restricted'] as const;
const MODES = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const;
type Loose = any; // a payload under edit: one value changed at a time

const ceilingOf = (scale: string, level: string, extra: Partial<Clearance> = {}): Clearance => ({ scale, level, compartments: [], releasability: [], ...extra });

/** The shipped default payload with an edit, parsed the way the verifier parses it, so every bundle a test runs under is one the parser accepts. */
function bundleWith(edit: (payload: Loose) => void): PolicyBundle {
  const payload: Loose = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: 'device-test', publicKey: 'A'.repeat(43) }, now: Date.now() })));
  edit(payload);
  const parsed = parseBundle(payload);
  if (!parsed.ok) throw new Error(`test bundle did not parse: ${parsed.reason} at ${parsed.path}`);
  return parsed.value;
}

function stateOf(bundle: PolicyBundle): BundleState {
  return { state: 'valid', bundle, hash: bundleHash(bundle), signer: bundle.issuer, expiresAt: bundle.expiresAt, renewDue: false };
}

/** A runtime under the given bundle: the test runtime's sink and actor, with that policy in force. */
function runtimeUnder(bundle: PolicyBundle, options: { presence?: GateRuntime['presence']; context?: GateContextName; clock?: () => number } = {}): MemoryGateRuntime {
  const base = testGateRuntime({ ...(options.presence === undefined ? {} : { presence: options.presence }), ...(options.context === undefined ? {} : { context: options.context }) });
  const state = stateOf(bundle);
  return { ...base, bundleState: () => state, ...(options.clock === undefined ? {} : { clock: options.clock }) };
}

/** A stand-in MCP connection that remembers every call it was asked to send. */
function fakeConnection(tools: McpToolInfo[]): McpConnection & { sent: Array<{ tool: string; args: unknown }> } {
  const sent: Array<{ tool: string; args: unknown }> = [];
  return { tools, connected: true, sent, call: async (tool: string, args: unknown) => { sent.push({ tool, args }); return 'ok'; } } as unknown as McpConnection & { sent: Array<{ tool: string; args: unknown }> };
}

const LOOKUP: McpToolInfo = { name: 'lookup', description: 'Looks up a part.', inputSchema: { type: 'object' }, readOnly: true, destructive: false };
const ORDER: McpToolInfo = { name: 'order', description: 'Places an order.', inputSchema: { type: 'object' }, readOnly: false, destructive: false };

function toolsOf(config: McpServerConfig, connection: McpConnection): AgentTool<any>[] {
  return mcpAgentTools(config, connection, config.transport === 'http' ? 'partner.example.test' : '');
}

const REMOTE: McpServerConfig = { id: 'partner', name: 'Partner', transport: 'http', approval: 'trusted' };
const LOCAL: McpServerConfig = { id: 'helper', name: 'Helper', transport: 'stdio', approval: 'trusted' };

async function decideCall(runtime: MemoryGateRuntime, tool: AgentTool<any>, mark: Mark | undefined, mode: (typeof MODES)[number] = 'fully-autonomous') {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-mcp-ceiling-'));
  return gateToolCall(runtime, {
    tool, raw: { sku: 'SW-24' }, root, callId: `${tool.name}-${mode}`, policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES,
    grants: mark === undefined ? new RunGrants() : grantsAt(mark), buildAuto: async () => undefined
  });
}

/** Routing that puts every org level at one tier, so each tier is exercised for each level. */
function routedAt(tier: RoutingTier) {
  return (payload: Loose) => { for (const level of ORG) payload.routing.levels[`org/${level}`] = tier; };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The bundle field

test('the shipped default has no MCP ceilings, still counts as the default, and its hash is unchanged by this field', () => {
  const payload = defaultBundlePayload({ issuer: { fingerprint: 'device-test', publicKey: 'A'.repeat(43) }, now: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(payload.ceiling, 'mcpLabelCeilings'), false);
  const parsed = parseBundle(JSON.parse(JSON.stringify(payload)));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.value.ceiling, 'mcpLabelCeilings'), false, 'absent stays absent, so a stored policy hashes as before');
  assert.equal(bundleHash(parsed.value), bundleHash(payload));
  assert.equal(isDefaultBundle(payload), true);
  // A policy that names a ceiling is a customised one.
  assert.equal(isDefaultBundle(bundleWith((edit) => { edit.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Internal') }; })), false);
});

test('a ceiling parses on the bundle\'s own scales, and an unknown level, scale, server id or field is refused', () => {
  const good = bundleWith((payload) => {
    payload.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Internal'), 'nato-feed': ceilingOf('nato', 'NATO Unclassified', { releasability: ['CAN', 'NATO'] }), helper: ceilingOf('org', 'Confidential', { compartments: ['ALPHA'], expiresAt: '2030-01-01T00:00:00.000Z' }) };
  });
  assert.deepEqual(Object.keys(good.ceiling.mcpLabelCeilings ?? {}).sort(), ['helper', 'nato-feed', 'partner']);
  assert.equal(good.ceiling.mcpLabelCeilings?.['helper']?.expiresAt, '2030-01-01T00:00:00.000Z');
  const refusedFor = (value: unknown): string => {
    const payload: Loose = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: 'device-test', publicKey: 'A'.repeat(43) }, now: 0 })));
    payload.ceiling.mcpLabelCeilings = value;
    const parsed = parseBundle(payload);
    assert.equal(parsed.ok, false, JSON.stringify(value));
    return parsed.ok ? '' : `${parsed.reason} ${parsed.path}`;
  };
  assert.match(refusedFor({ partner: ceilingOf('org', 'Secret') }), /not-allowed-here ceiling\.mcpLabelCeilings\.partner\.level/, 'an unknown level is refused');
  assert.match(refusedFor({ partner: ceilingOf('org', 'internal') }), /level/, 'a level differing only by case is unknown');
  assert.match(refusedFor({ partner: ceilingOf('acme', 'Public') }), /scale/, 'an unknown scale is refused');
  assert.match(refusedFor({ partner: { ...ceilingOf('org', 'Public'), handling: [] } }), /unknown-field/, 'a label field a ceiling does not take is refused');
  assert.match(refusedFor({ partner: ceilingOf('org', 'Public', { releasability: ['RELEASABLE-TO-NONE'] }) }), /not-allowed-here/);
  assert.match(refusedFor({ partner: ceilingOf('org', 'Public', { compartments: ['b', 'a'] }) }), /wrong-type|not-sorted/);
  for (const id of ['__proto__', 'Partner', 'part*', '', 'x'.repeat(32), 'has space']) assert.match(refusedFor({ [id]: ceilingOf('org', 'Public') }), /not-allowed-here|wrong-type/, `server id ${JSON.stringify(id)}`);
  assert.match(refusedFor([ceilingOf('org', 'Public')]), /wrong-type/);
  assert.match(refusedFor('org/Public'), /wrong-type/);
});

test('a signed policy whose ceiling names an unknown level fails closed with a plain sentence; a valid one verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const signer: PayloadSigner = { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer) => edSign(null, bytes, privateKey).toString('base64url') };
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const status = (key: { fingerprint: string }) => (key.fingerprint === signer.fingerprint ? { state: 'active' as const } : { state: 'unknown' as const });
  const make = (ceilings: unknown) => {
    const payload: Loose = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, now })));
    payload.ceiling.mcpLabelCeilings = ceilings;
    return verifyBundleEnvelope(signPayload(signer, 'policy-bundle', payload, { now: () => new Date(now) }), { status, now });
  };
  const valid = make({ partner: ceilingOf('org', 'Internal') });
  assert.equal(valid.state, 'valid');
  const bad = make({ partner: ceilingOf('org', 'Top Secret') });
  assert.equal(bad.state, 'failed-closed');
  if (bad.state === 'failed-closed') {
    assert.equal(bad.reason, 'wrong-type');
    assert.equal(bad.sentence, BUNDLE_FAILURES['wrong-type']);
  }
});

test('the rule is one the records know', () => {
  assert.ok(GATE_RULE_IDS.includes('label.mcp-ceiling'));
  assert.ok(RECORD_RULE_IDS.includes('label.mcp-ceiling'));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Enforcement

test('every org label at every routing tier and every mode: a call is refused before anything is sent exactly when the chat\'s label is above the server\'s ceiling', async () => {
  for (const [config, tool] of [[REMOTE, LOOKUP], [REMOTE, ORDER], [LOCAL, LOOKUP]] as const) {
    for (const ceiling of ORG) {
      for (const tier of ROUTING_TIERS) {
        const bundle = bundleWith((payload) => { routedAt(tier)(payload); payload.ceiling.mcpLabelCeilings = { [config.id]: ceilingOf('org', ceiling) }; });
        for (const level of ORG) {
          for (const mode of MODES) {
            const runtime = runtimeUnder(bundle);
            const connection = fakeConnection([tool]);
            const [agentTool] = toolsOf(config, connection);
            const gated = await decideCall(runtime, agentTool!, [label('org', level)], mode);
            const above = ORG.indexOf(level) > ORG.indexOf(ceiling);
            const where = `${config.id}/${tool.name} ceiling ${ceiling}, chat ${level}, tier ${tier}, ${mode}`;
            if (above) {
              assert.equal(gated.decision.outcome, 'deny', where);
              assert.equal(gated.decision.rule, 'label.mcp-ceiling', where);
              assert.equal(gated.decision.reason, mcpCeilingText(config.id, label('org', level), ceilingOf('org', ceiling)), where);
              // One record of the refusal, valid, naming the rule and the label above the ceiling, and the tool only (never the arguments).
              const record = runtime.records.at(-1)!;
              assert.equal(validateDecisionRecord(record).ok, true, where);
              assert.equal(record.authorizations[0]?.policy.name, 'label.mcp-ceiling', where);
              assert.equal(record.unmapped.nearAi.outcome, undefined, `${where}: a refusal, not an ask`);
              assert.equal(record.authorizations[0]?.decision, 'Denied', where);
              assert.equal(record.unmapped.nearAi.label?.level, level, where);
              assert.equal(JSON.stringify(record).includes('SW-24'), false, `${where}: the record carries no argument`);
            } else {
              assert.notEqual(gated.decision.rule, 'label.mcp-ceiling', where);
            }
            assert.deepEqual(connection.sent, [], `${where}: deciding never sends`);
          }
        }
      }
    }
  }
});

test('a server with no ceiling, and every server under the shipped default, decides exactly as before', async () => {
  const withCeilingForOther = bundleWith((payload) => { payload.ceiling.mcpLabelCeilings = { other: ceilingOf('org', 'Public') }; });
  for (const level of ORG) {
    for (const config of [REMOTE, LOCAL]) {
      for (const tool of [LOOKUP, ORDER]) {
        const [agentTool] = toolsOf(config, fakeConnection([tool]));
        const before = await decideCall(testGateRuntime(), agentTool!, [label('org', level)]);
        const after = await decideCall(runtimeUnder(withCeilingForOther), agentTool!, [label('org', level)]);
        const where = `${config.id}/${tool.name} at ${level}`;
        assert.equal(after.decision.rule, before.decision.rule, where);
        assert.equal(after.decision.outcome, before.decision.outcome, where);
        assert.notEqual(before.decision.rule, 'label.mcp-ceiling', where);
      }
    }
  }
  assert.equal(mcpCeilingVerdictFor(testGateRuntime(), 'partner', [label('org', 'Restricted')]), undefined, 'no ceilings in the shipped default');
  assert.equal(mcpCeilingVerdictFor(runtimeUnder(withCeilingForOther), undefined, [label('org', 'Restricted')]), undefined, 'not an MCP tool');
});

test('the other scales, compartments, releasability, an expired ceiling and an empty mark', () => {
  const bundle = bundleWith((payload) => {
    payload.ceiling.mcpLabelCeilings = {
      nato: ceilingOf('nato', 'NATO Restricted'),
      canada: ceilingOf('ca-protected', 'Protected A'),
      alpha: ceilingOf('org', 'Confidential', { compartments: ['ALPHA'] }),
      fvey: ceilingOf('org', 'Internal', { releasability: ['FVEY'] }),
      lapsed: ceilingOf('org', 'Restricted', { expiresAt: '2026-01-01T00:00:00.000Z' }),
      strict: ceilingOf('org', 'Public')
    };
    payload.defaultLabel = { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] };
  });
  const runtime = runtimeUnder(bundle, { clock: () => Date.parse('2026-11-18T12:00:00.000Z') });
  const verdict = (server: string, mark: Mark | undefined) => mcpCeilingVerdictFor(runtime, server, mark)?.rule;
  const nato = ['NATO Unclassified', 'NATO Restricted', 'NATO Confidential', 'NATO Secret', 'Cosmic Top Secret'];
  nato.forEach((level, index) => assert.equal(verdict('nato', [label('nato', level)]), index > 1 ? 'label.mcp-ceiling' : undefined, level));
  ['Protected A', 'Protected B', 'Protected C'].forEach((level, index) => assert.equal(verdict('canada', [label('ca-protected', level)]), index > 0 ? 'label.mcp-ceiling' : undefined, level));
  // A label on a scale the ceiling does not cover, with no mapping, is above it (fail closed).
  assert.equal(verdict('nato', [label('org', 'Public')]), 'label.mcp-ceiling');
  assert.equal(verdict('nato', [label('nato', 'NATO Unclassified'), label('org', 'Internal')]), 'label.mcp-ceiling', 'every label of the mark must be under the ceiling');
  // Compartments: the server must hold each one the chat holds.
  assert.equal(verdict('alpha', [label('org', 'Confidential', ['ALPHA'])]), undefined);
  assert.equal(verdict('alpha', [label('org', 'Confidential', ['BRAVO'])]), 'label.mcp-ceiling');
  assert.equal(verdict('strict', [label('org', 'Public', ['ALPHA'])]), 'label.mcp-ceiling');
  // Releasability: content releasable only to some may go only to a server releasable to one of them.
  assert.equal(verdict('fvey', [{ ...label('org', 'Internal'), releasability: ['FVEY'] }]), undefined);
  assert.equal(verdict('fvey', [{ ...label('org', 'Internal'), releasability: ['CAN'] }]), 'label.mcp-ceiling');
  assert.equal(verdict('strict', [{ ...label('org', 'Public'), releasability: ['CAN'] }]), 'label.mcp-ceiling');
  // An expired ceiling receives nothing.
  assert.equal(verdict('lapsed', [label('org', 'Public')]), 'label.mcp-ceiling');
  // An empty mark, or none, is the policy's default label (here org Internal), which is above org Public.
  assert.equal(verdict('strict', []), 'label.mcp-ceiling');
  assert.equal(verdict('strict', undefined), 'label.mcp-ceiling');
  assert.equal(verdict('fvey', []), undefined);
});

test('what the call reads itself counts with the mark, and a refusal at a failed-closed policy is the policy\'s own', () => {
  const bundle = bundleWith((payload) => { payload.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Internal') }; });
  const runtime = runtimeUnder(bundle);
  assert.equal(mcpCeilingVerdictFor(runtime, 'partner', [label('org', 'Public')], [label('org', 'Confidential')])?.rule, 'label.mcp-ceiling');
  const failed: MemoryGateRuntime = { ...testGateRuntime(), bundleState: () => ({ state: 'failed-closed', reason: 'expired', sentence: BUNDLE_FAILURES.expired }) };
  assert.equal(mcpCeilingVerdictFor(failed, 'partner', [label('org', 'Restricted')]), undefined);
  const throwing: MemoryGateRuntime = { ...testGateRuntime(), bundleState: () => { throw new Error('no policy'); } };
  assert.equal(mcpCeilingVerdictFor(throwing, 'partner', [label('org', 'Restricted')]), undefined);
});

test('a run with nobody present is refused too, and a scan step that calls an MCP tool is judged the same way', async () => {
  const bundle = bundleWith((payload) => {
    payload.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Public') };
    payload.ceiling.unattendedMcp = ['partner'];
  });
  const connection = fakeConnection([LOOKUP]);
  const manifested: McpServerConfig = { ...REMOTE, manifest: { manifestVersion: 1, server: 'partner', runsOn: 'remote', hosts: [], credentials: [], contexts: ['interactive', 'unattended'], tools: {}, toolDefaults: 'legacy' } as never };
  const [agentTool] = toolsOf(manifested, connection);
  const unattended = runtimeUnder(bundle, { presence: 'none', context: 'unattended' });
  const gated = await decideCall(unattended, agentTool!, [label('org', 'Internal')]);
  assert.equal(gated.decision.rule, 'label.mcp-ceiling');
  assert.equal(gated.decision.outcome, 'deny');
  const step = runtimeUnder(bundle);
  const stepped = await gateStep(step, {
    tool: agentTool!.name, callId: 'scan/1', effects: [{ verb: 'mcp', server: 'partner', tools: ['lookup'] }], policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }, mark: new SessionMark([label('org', 'Confidential')]), mcpServer: 'partner', runsRemote: true
  });
  assert.equal(stepped.decision.rule, 'label.mcp-ceiling');
  assert.equal(step.records.at(-1)?.authorizations[0]?.policy.name, 'label.mcp-ceiling');
  assert.deepEqual(connection.sent, []);
});

test('in a real run the refused call never reaches the server, the agent is told why, and the refusal is recorded; a chat under the ceiling still calls it', async () => {
  const bundle = bundleWith((payload) => { payload.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Internal') }; });
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-mcp-ceiling-run-'));
  const high = fakeConnection([LOOKUP]);
  const highRuntime = runtimeUnder(bundle);
  const { outputs } = await runWith(root, [call('c1', 'mcp__partner__lookup', { sku: 'SW-24' })], grantsAt([label('org', 'Confidential')]), highRuntime, toolsOf(REMOTE, high));
  assert.deepEqual(high.sent, [], 'nothing was sent to the server');
  assert.match(outputs.join('\n'), /above the highest label your policy lets the MCP server "partner" receive \(org\/Internal\)/);
  assert.match(outputs.join('\n'), /NEAR AI: Lower This Chat's Label/);
  const refusals = highRuntime.records.filter((record) => record.authorizations[0]?.policy.name === 'label.mcp-ceiling');
  assert.equal(refusals.length, 1, 'one decision record for the refusal');
  assert.equal(validateDecisionRecord(refusals[0]).ok, true);
  const low = fakeConnection([LOOKUP]);
  await runWith(root, [call('c2', 'mcp__partner__lookup', { sku: 'SW-24' })], grantsAt([label('org', 'Internal')]), runtimeUnder(bundle), toolsOf(REMOTE, low));
  assert.deepEqual(low.sent, [{ tool: 'lookup', args: { sku: 'SW-24' } }], 'at or under the ceiling the call goes through');
});

test('the refusal sentence is plain: no em-dash, names the server, the label and the ceiling, and the ways on', () => {
  const text = mcpCeilingText('partner', label('org', 'Confidential') as Label, ceilingOf('org', 'Internal', { expiresAt: '2030-01-01T00:00:00.000Z' }));
  assert.equal(text.includes(String.fromCharCode(0x2014)), false);
  assert.match(text, /org\/Confidential/);
  assert.match(text, /"partner"/);
  assert.match(text, /org\/Internal, until 2030-01-01T00:00:00\.000Z/);
  assert.match(text, /nothing was sent to it/);
  assert.match(text, /NEAR AI: Edit Policy/);
});

test('a ceiling that cannot be checked refuses with its own sentence and names no label, in the verdict and in the record', async () => {
  const parsed = bundleWith((payload) => { payload.ceiling.mcpLabelCeilings = { partner: ceilingOf('org', 'Restricted') }; });
  // A ceiling whose compartments cannot be read: the check throws, and the call must still be refused (fail closed).
  const broken = Object.defineProperty({ ...ceilingOf('org', 'Restricted') }, 'compartments', { get: () => { throw new Error('unreadable'); } });
  const bundle = { ...parsed, ceiling: { ...parsed.ceiling, mcpLabelCeilings: { partner: broken } } } as PolicyBundle;
  const state: BundleState = { state: 'valid', bundle, hash: bundleHash(parsed), signer: parsed.issuer, expiresAt: parsed.expiresAt, renewDue: false };
  const runtime: MemoryGateRuntime = { ...testGateRuntime(), bundleState: () => state };
  const verdict = mcpCeilingVerdictFor(runtime, 'partner', [label('org', 'Public')]);
  assert.deepEqual(verdict, { rule: 'label.mcp-ceiling', reason: mcpCeilingUnjudgedText('partner') });
  assert.equal(mcpCeilingUnjudgedText('partner').includes('org/'), false, 'no label is blamed');
  assert.equal(mcpCeilingUnjudgedText('partner').includes(String.fromCharCode(0x2014)), false);
  const connection = fakeConnection([LOOKUP]);
  const [agentTool] = toolsOf(REMOTE, connection);
  const gated = await decideCall(runtime, agentTool!, [label('org', 'Public')]);
  assert.equal(gated.decision.rule, 'label.mcp-ceiling');
  assert.equal(gated.decision.reason, mcpCeilingUnjudgedText('partner'));
  const record = runtime.records.at(-1)!;
  assert.equal(validateDecisionRecord(record).ok, true);
  assert.equal(record.status_detail, mcpCeilingUnjudgedText('partner'));
  assert.equal(record.unmapped.nearAi.label, undefined);
  assert.deepEqual(connection.sent, []);
});
