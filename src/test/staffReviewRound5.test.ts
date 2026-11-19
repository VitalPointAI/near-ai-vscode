// Review round 5 of drop 1 (#109): the PIR register is read from its one source, the intel workbench's JSON, and has no stale register schema; reading
// a register is its own read-only tool, so a read never asks for a write approval; and Decide a PIR says why it cannot read the register instead of
// saying that no PIR is waiting.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { intelToolName, intelWorkbenchTools } from '../agent/intelWorkbench';
import { STAFF_REGISTER_READ_TOOL, STAFF_REGISTER_TOOL, STAFF_REGISTER_TOOLS } from '../agent/staff/grants';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { staffTools, WRITE_LIMITED_STAFF_TOOLS } from '../agent/staffTools';
import { parseTeam } from '../agent/teams';
import type { AgentTool, ToolContext } from '../agent/tools';
import { STAFF_COMMANDS } from '../domain/staff/commands';
import { registerPath } from '../domain/staff/intel';
import { REGISTER_SCHEMAS } from '../domain/staff/registers';
import { buildStaffRoomModel } from '../domain/staff/staffRoom';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { MemorySecrets } from './helpers/teamHarness';
import { callTool, J2_TEAM, J3_TEAM, J5_TEAM, staffWorld } from './helpers/staffFixtures';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');
test.after(() => { uninstall(); hosts.configureStaffHosts(undefined); });

const REGISTER = 'mcp__staff-products__register';
const REGISTER_READ = 'mcp__staff-products__register_read';
const PIR = { requirement: 'Will the adversary cross at Ashby Ford?', decisionPoint: 'DP 2: commit the reserve', ltiov: '2026-11-19T06:00Z', indicators: ['Bridging seen'], requestedBy: 'j3' };

function workbench(root: string, decisions: () => Promise<ReadonlyMap<string, never>>): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools = new Map(intelWorkbenchTools({ decisions }).map((tool) => [tool.name, tool as AgentTool<Record<string, unknown>>]));
  const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('intel', path.join(root, '.ckpt')), shell: {} as never, readFiles: new Set<string>(), agentLabel: 'requirements-manager' } as unknown as ToolContext;
  return async (name, args) => { const tool = tools.get(intelToolName(name))!; return tool.run(tool.parse(args), context); };
}

test('the PIR register: no stale schema, its read returns the workbench\'s JSON register, writes and proposals point to the workbench, and the Staff Room still shows the PIRs', async () => {
  assert.equal(REGISTER_SCHEMAS['pir-register'], undefined, 'the register tool keeps no second PIR schema');
  const world = await staffWorld();
  const call = workbench(world.root, () => world.host.pirDecisions() as never);
  await call('pir_add', PIR);
  await call('pir_publish', {});
  const read = await callTool(world, J3_TEAM, REGISTER_READ, { register: 'pir-register' }, 'joc-chief');
  assert.ok(read.ok, read.text);
  const value = JSON.parse(read.text) as { register: string; source: string; entries: Array<{ id: string; requirement: string }> };
  assert.equal(value.source, registerPath('pir-register'));
  assert.deepEqual(value.entries.map((entry) => [entry.id, entry.requirement]), [['PIR-1', PIR.requirement]]);
  for (const action of ['write', 'propose']) {
    const refused = await callTool(world, J2_TEAM, REGISTER, { action, register: 'pir-register', rows: [] }, 'requirements-manager');
    assert.match(refused.text, /kept by the intel workbench/, action);
  }
  // A register that cannot be read says so; it never reads as empty.
  await writeFile(path.join(world.root, registerPath('pir-register')), '{ not json');
  const broken = await callTool(world, J3_TEAM, REGISTER_READ, { register: 'pir-register' }, 'joc-chief');
  assert.equal(broken.ok, false);
  assert.match(broken.text, /pir-register\.json cannot be read/);
  // The Staff Room's J2 workspace reads the PIRs from the JSON register; the generated product is not a shared register row.
  const fresh = await staffWorld();
  const freshCall = workbench(fresh.root, () => fresh.host.pirDecisions() as never);
  await freshCall('pir_add', PIR);
  await freshCall('pir_publish', {});
  const proposed = await callTool(fresh, J2_TEAM, 'mcp__staff-products__propose', { product: 'pir-register', kind: 'register' }, 'requirements-manager');
  assert.ok(proposed.ok, proposed.text);
  const snapshot = await fresh.host.snapshot();
  assert.ok(snapshot.registry.some((view) => view.product === 'pir-register'), 'the generated product is still a product');
  assert.equal(snapshot.registers.find((entry) => entry.product === 'pir-register'), undefined, 'and not a shared register row');
  const model = buildStaffRoomModel(await loadStaffRoomInput(fresh.host, fresh.root, Date.parse('2026-11-18T12:00:00Z')));
  assert.deepEqual(model.j2.pirs.map((pir) => pir.id), ['PIR-1']);
  assert.deepEqual(model.j2.problems, []);
});

test('reading a register is its own read-only tool: no write approval for a read, and the write tool refuses read', async () => {
  const tools = new Map(staffTools({ host: () => undefined, team: J5_TEAM, run: 'run-1' }).map((tool) => [tool.name, tool]));
  assert.equal(tools.get(REGISTER_READ)?.capability, 'read');
  assert.equal(tools.get(REGISTER_READ)?.concurrent, true);
  assert.equal(tools.get(REGISTER)?.capability, 'workspaceWrite');
  assert.ok(!JSON.stringify(tools.get(REGISTER)?.parameters).includes('"read"'), 'the write tool offers no read action');
  assert.throws(() => tools.get(REGISTER)!.parse({ action: 'read', register: 'ccir-register' }), /mcp__staff-products__register_read/);
  assert.ok(WRITE_LIMITED_STAFF_TOOLS.has(REGISTER_READ), 'a write-limited member keeps the read');
  assert.deepEqual([...STAFF_REGISTER_TOOLS], [STAFF_REGISTER_TOOL, STAFF_REGISTER_READ_TOOL]);
  const world = await staffWorld();
  assert.ok((await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'facts-assumptions-ledger', rows: [{ id: 'A-1', kind: 'assumption', statement: 's', status: 'unconfirmed', invalidationTrigger: 't' }] }, 'lead-planner')).ok);
  const read = await callTool(world, J5_TEAM, REGISTER_READ, { register: 'facts-assumptions-ledger' }, 'red-team');
  assert.equal((JSON.parse(read.text) as { rows: unknown[] }).rows.length, 1, 'any member reads, the red team too');
});

test('every staff template member granted the register tool is granted the read tool with it', () => {
  let granted = 0;
  for (const template of STAFF_TEMPLATES) {
    for (const text of template.teams()) {
      const team = parseTeam(text, `/x/${template.file}.md`);
      for (const member of team.members) {
        if (!member.tools.includes(STAFF_REGISTER_TOOL)) continue;
        granted += 1;
        assert.ok(member.tools.includes(STAFF_REGISTER_READ_TOOL), `${template.id}: ${member.name}`);
      }
    }
  }
  assert.ok(granted > 0);
});

test('Decide a PIR says why the PIR register cannot be read, instead of saying no PIR is waiting', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-pir-cmd-'));
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-pir-project-'));
  stub.setWorkspaceFolders([project]);
  commands.registerStaffCommands(createFakeContext(storage, new MemorySecrets()) as never);
  const host = hosts.staffHostFor(project)!;
  // No register: nothing is waiting.
  assert.deepEqual(await host.pirsAwaitingDecision(), { entries: [] });
  await stub.commands.get(STAFF_COMMANDS.decidePir)!();
  assert.match(stub.notifications[stub.notifications.length - 1].message, /No PIR is awaiting a decision/);
  // A damaged register: the reason, not "none".
  const file = path.join(project, registerPath('pir-register'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{ not json');
  const queue = await host.pirsAwaitingDecision();
  assert.ok('unreadable' in queue);
  await stub.commands.get(STAFF_COMMANDS.decidePir)!();
  const last = stub.notifications[stub.notifications.length - 1];
  assert.equal(last.level, 'warn');
  assert.match(last.message, /No PIR can be decided now: .*pir-register\.json cannot be read/);
  assert.doesNotMatch(last.message, /No PIR is awaiting a decision/);
});
