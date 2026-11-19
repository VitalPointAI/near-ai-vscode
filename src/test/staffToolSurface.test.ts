// The staff tool surface (design 10, 4.1 rules and 4.2; WP-SHARED): the tools are exactly the agent verbs plus registers, wargame, step and lint, with no
// decision verb anywhere in the catalog; members get them only through their grants; the release-guard member's instructions pass the team checks; and
// a person's decisions run through the VS Code commands, signed and recorded with the person's name and role.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { HUMAN_ONLY_WORDS, staffTeamInfo, staffTools, STAFF_PRODUCT_TOOL_VERBS } from '../agent/staffTools';
import { builtInTools } from '../agent/toolCatalog';
import { parseTeam } from '../agent/teams';
import { checkTeam } from '../agent/teamCheck';
import { grantsMcpTool } from '../mcp/tools';
import { AGENT_PRODUCT_VERBS, HUMAN_ONLY_EVENTS } from '../domain/staff/release';
import { releaseGuardInstructions, releaseGuardMemberSection, RELEASE_GUARD_TOOLS } from '../domain/staff/releaseGuard';
import { STAFF_SECTION_IDS } from '../domain/staff/doctrine';
import { staffPreambleText } from '../domain/staff/products';
import { MemorySecrets } from './helpers/teamHarness';
import { callTool, CLEAN_BODY, hashIn, J5_TEAM, writeBody } from './helpers/staffFixtures';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');
test.after(() => { uninstall(); hosts.configureStaffHosts(undefined); });

const tools = staffTools({ host: () => undefined, team: J5_TEAM, run: 'run-1' });

test('the staff tools are the agent verbs, the registers, the wargame, the step mark, the lint and guard-scan: no decision verb, anywhere', () => {
  assert.deepEqual(tools.map((tool) => tool.name), [...STAFF_PRODUCT_TOOL_VERBS.map((verb) => `mcp__staff-products__${verb}`), 'mcp__guard-scan__scan']);
  assert.deepEqual([...AGENT_PRODUCT_VERBS], ['propose', 'verdict', 'submit', 'withdraw', 'status', 'list']);
  for (const tool of builtInTools()) {
    for (const word of [...HUMAN_ONLY_WORDS, ...HUMAN_ONLY_EVENTS]) assert.ok(!new RegExp(`(^|_)${word}$`, 'i').test(tool.name), `${tool.name} is a decision verb`);
  }
  for (const tool of tools) {
    const schema = JSON.stringify(tool.parameters);
    for (const word of HUMAN_ONLY_EVENTS) assert.ok(!new RegExp(`"${word}"`).test(schema), `${tool.name} offers ${word} as a value`);
  }
});

test('the verdict tool takes only gate verdicts: an approval word as a verdict is refused by the state machine', async () => {
  const world = await (await import('./helpers/staffFixtures')).staffWorld();
  await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  for (const word of ['APPROVED', 'approve', 'RELEASED']) {
    const result = await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: 'concept-of-operations', gate: 'guard', verdict: word, hash: hashIn(proposed.text) }, 'release-guard');
    assert.equal(result.ok, false, word);
  }
});

test('the staff tools are in the catalog, read tools read and write tools say what they write', () => {
  const catalog = new Map(builtInTools().map((tool) => [tool.name, tool]));
  for (const tool of tools) assert.ok(catalog.has(tool.name), tool.name);
  const read = ['mcp__staff-products__status', 'mcp__staff-products__list', 'mcp__staff-products__register_read', 'mcp__staff-products__lint', 'mcp__guard-scan__scan'];
  for (const tool of tools) assert.equal(tool.capability, read.includes(tool.name) ? 'read' : 'workspaceWrite', tool.name);
});

test('grants: mcp:staff-products, single verbs and mcp__guard-scan__* give a member exactly what they name', () => {
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => grantsMcpTool(['mcp:staff-products'], name)), names.filter((name) => name.startsWith('mcp__staff-products__')));
  assert.deepEqual(names.filter((name) => grantsMcpTool([...RELEASE_GUARD_TOOLS], name)), ['mcp__staff-products__verdict', 'mcp__staff-products__status', 'mcp__staff-products__list', 'mcp__guard-scan__scan']);
  assert.deepEqual(names.filter((name) => grantsMcpTool(['Read'], name)), []);
});

test('staffTeamInfo reads the section, the members and the section lead from the team file', () => {
  const text = ['---', 'name: J5 plans', 'description: d', 'privacy: private', 'staff:', '  section: j5', '---', '', '## j5-chief', 'role: Integrator', '', 'Merge. Hand back the plan.', '',
    '## lead-planner', 'role: Planner', 'reports-to: j5-chief', '', 'Plan. Hand back the plan.', '', releaseGuardMemberSection('j5', 'j5-chief')].join('\n');
  const team = parseTeam(text, '/x/j5-plans.md');
  assert.deepEqual(staffTeamInfo(team), { slug: 'j5-plans', section: 'j5', members: ['j5-chief', 'lead-planner', 'release-guard'], sectionLead: 'j5-chief' });
  assert.equal(staffTeamInfo({ ...team, staff: undefined }), undefined, 'not a staff team: no staff tools');
});

test('the release-guard member: the preamble, the boundary, a deliverable, no Write, standard tier, private, and no team-check warning in any section', () => {
  for (const section of STAFF_SECTION_IDS) {
    const text = ['---', 'name: Section', 'description: d', '---', '', '## chief', 'role: Section integrator', 'tools: Read, Write', '', 'Merges the members\' work. Hand back the estimate.', '', releaseGuardMemberSection(section, 'chief')].join('\n');
    const team = parseTeam(text, '/x/team.md');
    const guard = team.members.find((member) => member.name === 'release-guard')!;
    assert.equal(guard.model, 'standard');
    assert.equal(guard.privacy, 'private');
    assert.equal(guard.reportsTo, 'chief');
    assert.ok(!guard.tools.includes('Write') && !guard.tools.includes('Edit') && !guard.tools.includes('Bash'));
    assert.ok(guard.instructions.startsWith(staffPreambleText()));
    assert.match(guard.instructions, /you never release and you never fix/);
    assert.ok(guard.instructions.split(/\s+/).length < 1200, `${section} under the 1,200-word warning`);
    const findings = checkTeam({ name: team.name, description: team.description, members: team.members.map((member) => ({ name: member.name, role: member.role ?? '', model: member.model ?? '', tools: member.tools, instructions: member.instructions })) } as never)
      .filter((finding) => finding.member === 1 && finding.severity !== 'advice');
    assert.deepEqual(findings, [], section);
  }
  assert.match(releaseGuardInstructions('j2'), /tradecraft reviewer has not signed off/);
  assert.match(releaseGuardInstructions('j4'), /calculator record/);
});

test('the commands: a person approves through a confirmed, signed command, recorded with their name and role; dismissing changes nothing', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-cmd-'));
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-project-'));
  stub.setWorkspaceFolders([project]);
  const context = createFakeContext(storage, new MemorySecrets());
  commands.registerStaffCommands(context as never);
  for (const id of Object.values(commands.STAFF_COMMANDS)) assert.ok(stub.commands.has(id), id);
  const host = hosts.staffHostFor(project)!;
  const world = { root: project, host } as never;
  await writeBody(project, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  assert.ok(proposed.ok, proposed.text);
  const hash = hashIn(proposed.text);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: 'concept-of-operations', decisionFor: 'commander' }, 'lead-planner')).ok);

  // Dismissed at the modal: nothing is recorded.
  stub.inputAnswers.push('A. Demo', 'Commander');
  stub.messageAnswers.push(undefined);
  await stub.commands.get(commands.STAFF_COMMANDS.approve)!({ product: 'concept-of-operations', hash });
  assert.equal((await host.replay()).products.get('concept-of-operations')!.record.state, 'awaiting-decision');
  assert.ok(stub.messageOptions.some((options) => options.modal === true && /self-declared/.test(options.detail ?? '')), 'the dialog says the identity is self-declared');

  // Confirmed: approved, signed by this device, named.
  stub.inputAnswers.push('A. Demo', 'Commander');
  stub.messageAnswers.push('Approve');
  await stub.commands.get(commands.STAFF_COMMANDS.approve)!({ product: 'concept-of-operations', hash });
  const state = (await host.replay()).products.get('concept-of-operations')!;
  assert.equal(state.record.state, 'approved');
  assert.equal(state.record.approval?.by.name, 'A. Demo');
  assert.equal(state.record.approval?.by.role, 'Commander');

  // A Staff Room button that names a hash the person did not see is refused.
  stub.inputAnswers.push('A. Demo', 'Commander');
  await stub.commands.get(commands.STAFF_COMMANDS.release)!({ product: 'concept-of-operations', hash: 'e'.repeat(64) });
  assert.equal((await host.replay()).products.get('concept-of-operations')!.record.state, 'approved');

  stub.quickPickAnswers.push('concept-of-operations');
  stub.inputAnswers.push('A. Demo', 'Commander');
  stub.messageAnswers.push('Release');
  await stub.commands.get(commands.STAFF_COMMANDS.release)!();
  assert.equal((await host.replay()).products.get('concept-of-operations')!.record.state, 'released');
});
