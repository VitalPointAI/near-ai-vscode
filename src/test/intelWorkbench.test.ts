// The intel-workbench tools (design 10, 6.2; WP-INT): safe under the Phase 70 gate (every tool declares a manifest the format accepts, names only the
// J2 register files it touches so the label check sees them, reaches no network and runs on this machine), reachable by a member only through an
// `mcp:intel-workbench` grant, offered only to staff teams, and with no tool that approves anything. Then each tool run against a real folder.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { grantedIntelWorkbenchTools, INTEL_WORKBENCH_SERVER, INTEL_WORKBENCH_TOOL_NAMES, intelToolName, intelWorkbenchTools } from '../agent/intelWorkbench';
import { RunCheckpoints } from '../agent/checkpoints';
import { readEffectPaths } from '../agent/gateLabels';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { builtInTools } from '../agent/toolCatalog';
import type { AgentTool, ToolContext } from '../agent/tools';
import { effectsFor, parseToolManifest, shorthandFor } from '../domain/gate/manifest';
import { decidePir, parseRegisterText, renderRegister } from '../domain/staff/intel';
import { grantsMcpTool } from '../mcp/tools';
import { AgentConversation } from '../services/agentSession';
import { StaffHost } from '../staff/staffHost';
import { testSigner, trusting } from './helpers/staffFixtures';
import type { AgentTurnRequest } from '../services/agentSession';

const NOW = Date.UTC(2026, 10, 18, 12, 0);
const REGISTERS = ['.planning/staff/products/j2/source-register.json', '.planning/staff/products/j2/pir-register.json', '.planning/staff/products/j2/collection-plan.json'];

function workbench(): Map<string, AgentTool<any>> {
  return new Map(intelWorkbenchTools({ now: () => NOW }).map((tool) => [tool.name.replace(`mcp__${INTEL_WORKBENCH_SERVER}__`, ''), tool]));
}

function folder(): { root: string; context: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-intel-'));
  const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('intel', path.join(root, '.ckpt')), shell: {} as never, readFiles: new Set<string>(), agentLabel: 'osint-analyst' } as ToolContext;
  return { root, context };
}

/**
 * Runs a workbench tool. A read tool's answer is fenced whole as untrusted content (staffFence.ts, drop 2 review): that is checked here, and the text
 * inside the fence (after a draft's note) is returned, so each test below reads the answer itself.
 */
async function call(tools: Map<string, AgentTool<any>>, name: string, raw: Record<string, unknown>, context: ToolContext): Promise<string> {
  const tool = tools.get(name)!;
  const text = await tool.run(tool.parse(raw), context);
  if (tool.capability !== 'read') return text;
  const fence = new RegExp(`^<untrusted-content id="([0-9a-f]{8})" source="intel-workbench: ${name}">\\n(?:\\[This is a draft for you to write[^\\n]*\\]\\n)?([\\s\\S]*)\\n</untrusted-content id="\\1">$`);
  const match = fence.exec(text);
  assert.ok(match, `${name} answers fenced:\n${text.slice(0, 200)}`);
  return match[2];
}

const SOURCE = {
  title: 'Bridge at Ashby Ford reported closed', source: 'Fictional Gazette', origin: 'Ashby district office', discipline: 'OSINT',
  reportedAt: '2026-11-18T09:00Z', accessedAt: '2026-11-18T10:00Z', reliability: 'B', credibility: 2, claims: ['bridge-closed-ashby'], deceptionNote: 'none seen'
};
const PIR = { requirement: 'Will the adversary cross at Ashby Ford?', decisionPoint: 'DP 2: commit the reserve', ltiov: '2026-11-19T06:00Z', indicators: ['Bridging assets forward', 'Recon at the ford'] };

// ---- The gate -----------------------------------------------------------------------------------------------------------------------------------

test('every workbench tool declares a manifest the format accepts, under its own name, frozen, on this machine, with no host', () => {
  const tools = intelWorkbenchTools();
  assert.equal(tools.length, 13);
  assert.deepEqual(tools.map((tool) => tool.name), INTEL_WORKBENCH_TOOL_NAMES);
  for (const tool of tools) {
    const parsed = parseToolManifest(JSON.parse(JSON.stringify(tool.manifest)));
    assert.equal(parsed.ok, true, `${tool.name} manifest parses`);
    assert.equal(tool.manifest.tool, tool.name);
    assert.equal(tool.manifest.runsOn, 'this-machine');
    assert.deepEqual(tool.manifest.hosts, [], `${tool.name} reaches no host`);
    assert.deepEqual(tool.manifest.credentials, []);
    assert.ok(Object.isFrozen(tool.manifest) && Object.isFrozen(tool.manifest.effects), `${tool.name} manifest is frozen`);
    assert.ok(tool.manifest.contexts.includes('interactive'));
    assert.equal(tool.untrusted, undefined, 'its results are the project\'s own files, read like Read reads them');
    assert.equal(tool.autoSafe, undefined);
  }
});

test('no workbench tool declares anything that leaves the machine: no network, MCP call, shell, send, publish, spend, secret or model', () => {
  const allowed = new Set(['read', 'workspaceWrite']);
  for (const tool of intelWorkbenchTools()) {
    for (const effect of tool.manifest.effects) {
      assert.ok(!('from' in effect && effect.from === 'command'), `${tool.name} has no command effect`);
      assert.ok(allowed.has((effect as { verb: string }).verb), `${tool.name} declares ${(effect as { verb: string }).verb}`);
    }
    assert.equal(shorthandFor(tool.manifest), tool.capability, `${tool.name}: the settings layer's shorthand agrees with the manifest`);
    assert.ok(['read', 'workspaceWrite'].includes(tool.capability), tool.name);
  }
});

test('each tool names exactly the register files it touches, so the gate\'s label check sees every one', () => {
  const tools = workbench();
  const expected: Record<string, { reads: string[]; writes: string[] }> = {
    source_add: { reads: [REGISTERS[0]], writes: [REGISTERS[0]] },
    source_list: { reads: [REGISTERS[0]], writes: [] },
    independence_check: { reads: [REGISTERS[0]], writes: [] },
    pir_add: { reads: [REGISTERS[1]], writes: [REGISTERS[1]] },
    pir_update: { reads: [REGISTERS[1], REGISTERS[0]], writes: [REGISTERS[1]] },
    pir_list: { reads: [REGISTERS[1], REGISTERS[2]], writes: [] },
    pir_publish: { reads: [REGISTERS[1], '.planning/staff/products/j2/pir-register.md'], writes: ['.planning/staff/products/j2/pir-register.md'] },
    collection_recommend: { reads: [REGISTERS[2], REGISTERS[1]], writes: [REGISTERS[2]] },
    collection_plan: { reads: [REGISTERS[2], REGISTERS[1]], writes: [] },
    intsum_draft: { reads: [REGISTERS[0], REGISTERS[1], '.planning/.near-ai/project.json'], writes: [] },
    intrep_draft: { reads: [REGISTERS[0], REGISTERS[1], '.planning/.near-ai/project.json'], writes: [] },
    compilation_check: { reads: ['.planning/staff/products/j2/intsum-181200z-nov-26.md', REGISTERS[0]], writes: [] },
    check: { reads: [...REGISTERS], writes: [] }
  };
  assert.deepEqual([...tools.keys()].sort(), Object.keys(expected).sort());
  for (const [name, tool] of tools) {
    const input = name === 'compilation_check' ? { path: '.planning/staff/products/j2/intsum-181200z-nov-26.md' } : {};
    const effects = effectsFor(tool.manifest, input);
    assert.ok(effects.ok, `${name} effects fill from the call`);
    if (!effects.ok) continue;
    assert.deepEqual(readEffectPaths(effects.value), expected[name].reads, `${name} reads`);
    const writes = effects.value.flatMap((effect) => (effect.verb === 'workspaceWrite' ? effect.paths : []));
    assert.deepEqual(writes, expected[name].writes, `${name} writes`);
  }
});

test('the compilation check with no path is refused by the gate rather than read as the whole project', () => {
  const tool = workbench().get('compilation_check')!;
  assert.equal(effectsFor(tool.manifest, {}).ok, false);
  assert.throws(() => tool.parse({}), /path/);
});

test('no tool approves, rejects or releases: no such tool exists and the PIR status enum offers neither', () => {
  for (const tool of intelWorkbenchTools()) {
    assert.doesNotMatch(tool.name, /approve|reject|release|decide|task/i, tool.name);
    const status = (tool.parameters as { properties?: Record<string, { enum?: string[] }> }).properties?.status;
    if (status?.enum) assert.deepEqual(status.enum.filter((value) => /approved|rejected/.test(value)), [], `${tool.name} status enum`);
  }
});

// ---- Who gets it --------------------------------------------------------------------------------------------------------------------------------

test('a member reaches the workbench only through an mcp:intel-workbench grant, or one of its tools by name', () => {
  for (const name of INTEL_WORKBENCH_TOOL_NAMES) {
    assert.match(name, /^mcp__intel-workbench__[a-z_]+$/);
    assert.equal(grantsMcpTool(['mcp:intel-workbench'], name), true, name);
    assert.equal(grantsMcpTool(['Read', 'Write', 'mcp:cop-map'], name), false, name);
  }
  assert.equal(grantsMcpTool([intelToolName('source_list')], intelToolName('source_add')), false);
});

function runTools(team: Record<string, unknown> | undefined): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-intel-run-'));
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  const request = { text: 'x', client: {}, model: 'm', privacy: 'private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, ...(team ? { team: { slug: 'j2', name: 'J2', description: 'd', file: path.join(root, 'j2.md'), members: [], ...team } } : {}) } as unknown as AgentTurnRequest;
  const toolsFor = (conversation as unknown as { toolsFor(...args: unknown[]): AgentTool<any>[] }).toolsFor.bind(conversation);
  return toolsFor(request, { root, cwd: root }, new RunGrants(), [], async () => undefined, new AbortController().signal, 'run-1').map((tool) => tool.name);
}

test('a staff team\'s run is given the workbench only when a member is granted it; a plain team and a plain chat are not', () => {
  const member = (tools: string[]) => ({ staff: { section: 'j2', steps: {}, products: [], layers: [] }, members: [{ name: 'osint-analyst', tools, instructions: 'x' }] });
  const staff = runTools(member(['Read', 'mcp:intel-workbench']));
  const ungranted = runTools(member(['Read']));
  const plain = runTools({});
  const chat = runTools(undefined);
  assert.deepEqual(staff.filter((name) => name.startsWith('mcp__intel-workbench__')), [...INTEL_WORKBENCH_TOOL_NAMES]);
  assert.deepEqual(staff.filter((name) => !name.startsWith('mcp__intel-workbench__')), ungranted, 'everything else is unchanged');
  assert.equal(ungranted.some((name) => name.startsWith('mcp__intel-workbench__')), false, 'no member granted it: the run gets none');
  assert.equal(plain.some((name) => name.startsWith('mcp__intel-workbench__')), false);
  assert.equal(chat.some((name) => name.startsWith('mcp__intel-workbench__')), false);
  const catalog = new Set(builtInTools().map((tool) => tool.name));
  assert.equal(INTEL_WORKBENCH_TOOL_NAMES.some((name) => catalog.has(name)), false, 'a local server\'s tools, like a connected server\'s, are not built-in catalog entries');
});

test('the run\'s lead and a member without the grant cannot call a workbench tool; a granted member can', async () => {
  const team = { members: [{ name: 'osint-analyst', tools: ['mcp:intel-workbench'] }, { name: 'watch-officer', tools: ['Read'] }] };
  const tools = new Map(grantedIntelWorkbenchTools(team, { now: () => NOW, decisions: async () => new Map() }).map((tool) => [tool.name.replace(`mcp__${INTEL_WORKBENCH_SERVER}__`, ''), tool]));
  const { context } = folder();
  const add = tools.get('source_add')!;
  const input = add.parse(SOURCE);
  assert.match(String(await add.forbidden!(input, { ...context, agentLabel: undefined } as ToolContext)), /the run's lead is not one of them/);
  assert.match(String(await add.forbidden!(input, { ...context, agentLabel: 'watch-officer' } as ToolContext)), /watch-officer is not one of them/);
  assert.equal(await add.forbidden!(input, { ...context, agentLabel: 'osint-analyst' } as ToolContext), undefined);
  assert.equal(grantedIntelWorkbenchTools({ members: [{ name: 'watch-officer', tools: ['Read'] }] }).length, 0);
});

// ---- The tools against a real folder ----------------------------------------------------------------------------------------------------------

test('source_add stores two separate grades and the origin; a combined grade is refused with the rule\'s words', async () => {
  const tools = workbench();
  const { root, context } = folder();
  const out = await call(tools, 'source_add', SOURCE, context);
  assert.match(out, /Added SRC-1 \(B2\)/);
  assert.match(out, /bridge-closed-ashby: 1 report from 1 independent origin \(not corroborated\)/);
  const stored = parseRegisterText('source-register', readFileSync(path.join(root, REGISTERS[0]), 'utf8'));
  assert.ok(stored.ok);
  if (stored.ok) {
    assert.equal(stored.value[0].reliability, 'B');
    assert.equal(stored.value[0].credibility, 2);
    assert.equal(stored.value[0].addedBy, 'osint-analyst');
  }
  await assert.rejects(call(tools, 'source_add', { ...SOURCE, reliability: 'B2' }, context), /graded separately/);
  await assert.rejects(call(tools, 'source_add', { ...SOURCE, label: 'ca-classified/Secret' }, context), /accredited systems/);
  assert.ok(context.checkpoints.changedFiles.some((file) => file.endsWith('source-register.json')), 'the write can be undone with the run');
});

test('independence_check counts origins, not reports', async () => {
  const tools = workbench();
  const { context } = folder();
  await call(tools, 'source_add', SOURCE, context);
  await call(tools, 'source_add', { ...SOURCE, source: 'Fictional Wire' }, context);
  assert.match(await call(tools, 'independence_check', { claim: 'bridge-closed-ashby' }, context), /2 reports \(SRC-1, SRC-2\) from 1 independent origin .*Not corroborated\. Some reports repeat one origin and count once\./);
  await call(tools, 'source_add', { ...SOURCE, origin: 'Exercise patrol report', discipline: 'GEOINT' }, context);
  assert.match(await call(tools, 'independence_check', {}, context), /from 2 independent origins .*Corroborated\./);
  assert.match(await call(tools, 'source_list', { claim: 'bridge-closed-ashby' }, context), /^3 items:/);
});

test('pir_add refuses a PIR with no decision point; pir_update cannot approve; a person\'s signed decision then unlocks answering', async () => {
  const { root, context } = folder();
  const signer = testSigner();
  const host = new StaffHost({ root, signer: async () => signer, keyStatus: async () => trusting(signer), now: () => NOW });
  const tools = new Map(intelWorkbenchTools({ now: () => NOW, decisions: () => host.pirDecisions() }).map((tool) => [tool.name.replace(`mcp__${INTEL_WORKBENCH_SERVER}__`, ''), tool]));
  await assert.rejects(call(tools, 'pir_add', { ...PIR, decisionPoint: '' }, context), /decision point/);
  assert.match(await call(tools, 'pir_add', PIR, context), /Added PIR-1 as a candidate, supporting DP 2: commit the reserve, latest time of value 190600Z NOV 26, indicators IND-1, IND-2/);
  assert.match(await call(tools, 'pir_update', { id: 'PIR-1', status: 'awaiting-decision' }, context), /PIR-1 is awaiting-decision/);
  await assert.rejects(call(tools, 'pir_update', { id: 'PIR-1', status: 'approved' }, context), /Only a named person approves or rejects a PIR/);
  // The person's command (not a tool) records the decision, signed with this device's key, in the decision log; then the register.
  const person = { kind: 'person' as const, name: 'Exercise Commander', role: 'commander', deviceFingerprint: signer.fingerprint };
  assert.equal((await host.decidePir({ ...person, deviceFingerprint: 'someone-else' }, { pir: 'PIR-1', decision: 'approved' })).ok, false, 'a decision signed by another key is refused');
  const decided = await host.decidePir(person, { pir: 'PIR-1', decision: 'approved' });
  assert.ok(decided.ok, decided.ok ? '' : decided.message);
  assert.equal((await host.pirDecisions()).size, 1);
  await assert.rejects(call(tools, 'pir_update', { id: 'PIR-1', requirement: 'Reworded?' }, context), /propose the change/);
  await call(tools, 'source_add', SOURCE, context);
  assert.match(await call(tools, 'pir_update', { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-1'] }, context), /PIR-1 is answered/);
  assert.match(await call(tools, 'pir_list', {}, context), /\| PIR-1: Will the adversary cross at Ashby Ford\? \| DP 2: commit the reserve \|.*\| answered \(commander, Exercise Commander\) \|/);
});

test('a decision written into the PIR register by hand, naming anyone, is never trusted: the PIR reads as awaiting a decision', async () => {
  const { root, context } = folder();
  const signer = testSigner();
  const host = new StaffHost({ root, signer: async () => signer, keyStatus: async () => trusting(signer), now: () => NOW });
  const tools = new Map(intelWorkbenchTools({ now: () => NOW, decisions: () => host.pirDecisions() }).map((tool) => [tool.name.replace(`mcp__${INTEL_WORKBENCH_SERVER}__`, ''), tool]));
  await call(tools, 'pir_add', PIR, context);
  await call(tools, 'pir_update', { id: 'PIR-1', status: 'awaiting-decision' }, context);
  const file = path.join(root, REGISTERS[1]);
  const register = parseRegisterText('pir-register', readFileSync(file, 'utf8'));
  assert.ok(register.ok);
  if (!register.ok) return;
  // Well formed, naming this computer's own key even: still no signed entry, so it does not count.
  const forged = decidePir(register.value, 'PIR-1', 'approved', { kind: 'person', name: 'Exercise Commander', role: 'commander', deviceFingerprint: signer.fingerprint }, NOW);
  assert.ok(forged.ok);
  if (!forged.ok) return;
  writeFileSync(file, renderRegister('pir-register', forged.value));
  const listed = await call(tools, 'pir_list', {}, context);
  assert.match(listed, /\| awaiting-decision \|/);
  assert.match(listed, /decision-unrecorded \(PIR-1\)/);
  assert.match(await call(tools, 'check', {}, context), /decision-unrecorded/);
  await call(tools, 'source_add', SOURCE, context);
  await assert.rejects(call(tools, 'pir_update', { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-1'] }, context), /cannot move|pir-transition|cannot be|status/i);
  const queue = await host.pirsAwaitingDecision();
  assert.equal(('entries' in queue ? queue.entries : []).map((pir) => pir.id).join(), 'PIR-1', 'a person can still decide it properly');
  // A signed decision on other wording does not carry over to changed wording.
  const decided = await host.decidePir({ kind: 'person', name: 'Exercise Commander', role: 'commander', deviceFingerprint: signer.fingerprint }, { pir: 'PIR-1', decision: 'approved' });
  assert.ok(decided.ok);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Will the adversary cross at Ashby Ford?', 'Will the adversary cross at the bridge?'));
  assert.match(await call(tools, 'pir_list', {}, context), /decision-unrecorded \(PIR-1\)/);
});

test('a hand-edited approved PIR stops the tools with the damage named, rather than being trusted', async () => {
  const tools = workbench();
  const { root, context } = folder();
  await call(tools, 'pir_add', PIR, context);
  const file = path.join(root, REGISTERS[1]);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"status":"candidate"', '"status":"approved"'));
  await assert.rejects(call(tools, 'pir_list', {}, context), /not in the workbench format \(pir-register: PIR-1 decision\)/);
  await assert.rejects(call(tools, 'collection_recommend', { pir: 'PIR-1', indicator: 'IND-1', nai: 'NAI 3', capability: 'UAS sweep', discipline: 'GEOINT', from: '2026-11-18T18:00Z', to: '2026-11-19T04:00Z' }, context), /not in the workbench format/);
});

test('collection_recommend records a recommendation only, refuses tasking and late collection, and the plan says the J3 tasks', async () => {
  const tools = workbench();
  const { context } = folder();
  await call(tools, 'pir_add', PIR, context);
  const base = { pir: 'PIR-1', indicator: 'IND-1', nai: 'NAI 3', capability: 'UAS imagery sweep', discipline: 'GEOINT', from: '2026-11-18T18:00Z', to: '2026-11-19T04:00Z' };
  assert.match(await call(tools, 'collection_recommend', base, context), /Recommended CR-1: .*Needs J3 approval of the asset allocation\. The J2 recommends; the J3 tasks\./);
  await assert.rejects(call(tools, 'collection_recommend', { ...base, capability: 'Task the UAS troop to sweep NAI 3' }, context), /recommendations only/);
  await assert.rejects(call(tools, 'collection_recommend', { ...base, to: '2026-11-19T08:00Z' }, context), /latest time of value/);
  await assert.rejects(call(tools, 'collection_recommend', { ...base, discipline: 'HUMINT', needs: 'j3-approval' }, context), /partner/);
  const plan = await call(tools, 'collection_plan', {}, context);
  assert.match(plan, /^The J2 recommends; the J3 approves the allocation of collection assets\./);
  assert.match(plan, /single-discipline/);
});

test('intsum_draft and intrep_draft return draft products under the project\'s profile and level; they write nothing', async () => {
  const tools = workbench();
  const { root, context } = folder();
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  writeFileSync(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ staff: { profile: 'nato-ca', level: 'operational' } }));
  await call(tools, 'source_add', SOURCE, context);
  await call(tools, 'pir_add', PIR, context);
  const intsum = await call(tools, 'intsum_draft', { from: '180000Z NOV 26', to: '181200Z NOV 26' }, context);
  assert.match(intsum, /^---\nproduct: intsum-181200z-nov-26\nkind: report\nsection: j2\nowner: watch-officer\nprofile: nato-ca\nlevel: operational\nversion: 1\nstate: draft\nlabel: org\/Internal\n/);
  assert.match(intsum, /## Significant activity\n\n- SRC-1 \(B2/);
  assert.match(intsum, /## Gaps\n\n- PIR-1/);
  const intrep = await call(tools, 'intrep_draft', { event: 'Bridging vehicles seen near the ford', at: '181130Z NOV 26', sources: ['SRC-1'], indicators: ['IND-1'] }, context);
  assert.match(intrep, /product: intrep-181130z-nov-26/);
  assert.match(intrep, /Indicator IND-1 \(Bridging assets forward\) of PIR-1/);
  await assert.rejects(call(tools, 'intsum_draft', { from: '180000Z NOV 26', to: '181200Z NOV 26', label: 'nato/NATO Secret' }, context), /accredited systems/);
  assert.equal(existsSync(path.join(root, 'products', 'j2', 'intsum-181200z-nov-26.md')), false, 'the watch officer writes the product with Write');
});

test('a broken staff block in project.json stops a draft with the field named; no block uses the defaults', async () => {
  const tools = workbench();
  const { root, context } = folder();
  assert.match(await call(tools, 'intsum_draft', { from: '2026-11-18', to: '2026-11-18T12:00Z' }, context), /profile: us-joint\nlevel: operational/);
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  writeFileSync(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ staff: { profile: 'us-army', level: 'operational' } }));
  await assert.rejects(call(tools, 'intsum_draft', { from: '2026-11-18', to: '2026-11-18T12:00Z' }, context), /not valid: That profile does not offer that level/);
});

test('compilation_check asks a person when a product ties units to places, and never says cleared', async () => {
  const tools = workbench();
  const { root, context } = folder();
  mkdirSync(path.join(root, '.planning', 'staff', 'products', 'j2'), { recursive: true });
  writeFileSync(path.join(root, '.planning', 'staff', 'products', 'j2', 'risky.md'), '---\nproduct: risky\n---\n\n3rd Armoured Brigade with 40 tanks at 45.4215, -75.6972\n');
  writeFileSync(path.join(root, '.planning', 'staff', 'products', 'j2', 'calm.md'), '---\nproduct: calm\n---\n\nThe weather was clear.\n');
  const risky = await call(tools, 'compilation_check', { path: '.planning/staff/products/j2/risky.md' }, context);
  assert.match(risky, /possible compilation\. A person decides\./);
  assert.match(risky, /line 5 ties unit, location, capability detail together/);
  assert.match(risky, /Question for a person with authority:/);
  const calm = await call(tools, 'compilation_check', { path: '.planning/staff/products/j2/calm.md' }, context);
  assert.match(calm, /does not clear the product/);
  for (const text of [risky, calm]) assert.doesNotMatch(text, /CLEARED/);
  await assert.rejects(call(tools, 'compilation_check', { path: '../outside.md' }, context), /outside the workspace/);
});

test('check runs every rule over the three registers, most severe first', async () => {
  const tools = workbench();
  const { context } = folder();
  assert.match(await call(tools, 'check', {}, context), /0 source items, 0 PIRs, 0 collection recommendations\. No findings\./);
  await call(tools, 'source_add', { ...SOURCE, credibility: 1 }, context);
  await call(tools, 'source_add', { ...SOURCE, source: 'Fictional Wire' }, context);
  const out = await call(tools, 'check', {}, context);
  assert.match(out, /credibility-1-unconfirmed \(SRC-1\)/);
  assert.match(out, /repeated-origin \(bridge-closed-ashby\)/);
  assert.ok(out.indexOf('[warning]') < out.indexOf('[advice]'));
});

test('parallel adds to one register keep every entry', async () => {
  const tools = workbench();
  const { root, context } = folder();
  await Promise.all(Array.from({ length: 8 }, (_unused, index) => call(tools, 'source_add', { ...SOURCE, title: `Item ${index}` }, context)));
  const stored = parseRegisterText('source-register', readFileSync(path.join(root, REGISTERS[0]), 'utf8'));
  assert.ok(stored.ok);
  if (stored.ok) assert.deepEqual(stored.value.map((entry) => entry.id).sort(), ['SRC-1', 'SRC-2', 'SRC-3', 'SRC-4', 'SRC-5', 'SRC-6', 'SRC-7', 'SRC-8']);
});
