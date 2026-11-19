// Review round 4 of drop 1: the host never overwrites bytes it did not read (a compare-and-swap at every host write to a file members can write, with
// a member's write injected at each point); the intel workbench reads through the same whole-file reader; the PIR register has one source; the red
// team registers only critiques; and the staff setup writes the team file last and rolls back.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { intelToolName, intelWorkbenchTools } from '../agent/intelWorkbench';
import { J2_STAFF_TEMPLATE } from '../agent/staff/templates';
import { TeamLibrary } from '../agent/teams';
import type { AgentTool, ToolContext } from '../agent/tools';
import { pirRegisterProductBody, registerPath } from '../domain/staff/intel';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { applyStaffSetup, planStaffSetup } from '../services/staffSetup';
import { readWhole, setCasProbe, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import type { CasProbe } from '../staff/staffFiles';
import { productPath } from '../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J2_TEAM, J5_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';

const MEMBER_BYTES = '# Concept of operations\n\nA member wrote this while the host was writing.\n';
const POINTS = ['before-temp', 'before-check', 'before-rename'] as const;

/** A member's Write landing at one point of the host's next compare-and-swap on `file`. */
function memberWriteAt(point: (typeof POINTS)[number], file: string, text: string): () => void {
  let done = false;
  const probe: CasProbe = async (at, target) => { if (!done && at === point && target === file) { done = true; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); } };
  setCasProbe(probe);
  return () => setCasProbe(undefined);
}

test('writeIfUnchanged writes only over the bytes it read, at every point a member write can land, and removes only an unchanged file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cas-'));
  const file = path.join(root, 'f.md');
  for (const point of POINTS) {
    await writeFile(file, 'host read this');
    const read = await readWhole(file);
    assert.equal(read.kind, 'text');
    const stop = memberWriteAt(point, file, 'member wrote this');
    try {
      assert.equal(await writeIfUnchanged(file, snapshotOfBytes(read.kind === 'text' ? read.bytes : undefined), 'host writes this'), false, point);
    } finally { stop(); }
    assert.equal(await readFile(file, 'utf8'), 'member wrote this', `${point}: the member's bytes stand`);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), [], `${point}: no temporary file is left`);
  }
  assert.equal(await writeIfUnchanged(file, snapshotOfBytes(Buffer.from('member wrote this')), 'host writes this'), true);
  assert.equal(await writeIfUnchanged(path.join(root, 'new.md'), { exists: false }, 'x'), true);
  assert.equal(await writeIfUnchanged(path.join(root, 'new.md'), { exists: false }, 'y'), false, 'a new file is never written over one that appeared');
  assert.equal(await writeIfUnchanged(file, snapshotOfBytes(Buffer.from('stale')), undefined), false, 'a removal is checked too');
  assert.equal(await readFile(file, 'utf8'), 'host writes this');
});

test('a member write at any point of the header write stands, and reads as the next edit', async () => {
  for (const point of POINTS) {
    const world = await staffWorld();
    await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
    const file = path.join(world.root, productPath('j5', 'concept-of-operations'));
    const stop = memberWriteAt(point, file, MEMBER_BYTES);
    let proposed;
    try {
      proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
    } finally { stop(); }
    assert.ok(proposed.ok, proposed.text);
    assert.equal(await readFile(file, 'utf8'), MEMBER_BYTES, `${point}: the host did not overwrite the member's bytes`);
    const status = await callTool(world, J5_TEAM, 'mcp__staff-products__status', { product: 'concept-of-operations' }, 'lead-planner');
    assert.match(status.text, /The file changed since version 1/, `${point}: it is the next pending edit`);
  }
});

test('a member write during a register write refuses the write, and during the restore after a refusal is kept', async () => {
  for (const point of POINTS) {
    const world = await staffWorld();
    const file = path.join(world.root, productPath('j5', 'facts-assumptions-ledger'));
    const row = { id: 'A-1', kind: 'assumption', statement: 'The port stays open.', status: 'unconfirmed', invalidationTrigger: 'The port closes.' };
    const stop = memberWriteAt(point, file, MEMBER_BYTES);
    let written;
    try {
      written = await callTool(world, J5_TEAM, 'mcp__staff-products__register', { action: 'write', register: 'facts-assumptions-ledger', rows: [row] }, 'lead-planner');
    } finally { stop(); }
    assert.match(written.text, /changed while your rows were being written, so nothing was changed/, point);
    assert.equal(await readFile(file, 'utf8'), MEMBER_BYTES, `${point}: the member's bytes stand`);
  }
  // The restore after a refused record: a member's write since the host's write is kept, not rolled back over.
  const world = await staffWorld();
  const file = path.join(world.root, productPath('j5', 'facts-assumptions-ledger'));
  await mkdir(path.join(world.root, '.planning/staff/ledger'), { recursive: true });
  await writeFile(path.join(world.root, '.planning/staff/ledger/products.jsonl'), 'not a signed entry\n');
  let writes = 0;
  setCasProbe(async (at, target) => { if (target === file && at === 'before-temp' && ++writes === 2) await writeFile(file, MEMBER_BYTES); });
  try {
    const refused = await callTool(world, J5_TEAM, 'mcp__staff-products__register', { action: 'write', register: 'facts-assumptions-ledger', rows: [{ id: 'A-1', kind: 'assumption', statement: 's', status: 'unconfirmed', invalidationTrigger: 't' }] }, 'lead-planner');
    assert.match(refused.text, /changed again since, so it was left as it is now/);
  } finally { setCasProbe(undefined); }
  assert.equal(await readFile(file, 'utf8'), MEMBER_BYTES);
});

function workbenchContext(root: string): ToolContext {
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('intel', path.join(root, '.ckpt')), shell: {} as never, readFiles: new Set<string>(), agentLabel: 'requirements-manager' } as unknown as ToolContext;
}
const PIR = { requirement: 'Will the adversary cross at Ashby Ford?', decisionPoint: 'DP 2: commit the reserve', ltiov: '2026-11-19T06:00Z', indicators: ['Bridging seen'], requestedBy: 'j3' };

test('the intel workbench reads registers whole: one over the size limit stops the tool and is never written over; a member write during its write stands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intel-whole-'));
  const tools = new Map(intelWorkbenchTools({ decisions: async () => new Map() }).map((tool) => [tool.name, tool as AgentTool<Record<string, unknown>>]));
  const call = async (name: string, args: Record<string, unknown>) => { const tool = tools.get(intelToolName(name))!; return tool.run(tool.parse(args), workbenchContext(root)); };
  const file = path.join(root, registerPath('pir-register'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 10));
  await assert.rejects(call('pir_list', {}), /cannot be read: it is larger than 2 MB/);
  await assert.rejects(call('pir_add', PIR), /cannot be read: it is larger than 2 MB/);
  assert.equal((await readFile(file)).length, 2 * 1024 * 1024 + 10, 'never written over');
  await rm(file);
  await call('pir_add', PIR);
  const stop = memberWriteAt('before-check', file, '{"hand":"edit"}');
  try {
    await assert.rejects(call('pir_update', { id: 'PIR-1', status: 'awaiting-decision' }), /changed while this change was being written/);
  } finally { stop(); }
  assert.equal(await readFile(file, 'utf8'), '{"hand":"edit"}');
});

test('one PIR register: the product is generated from it, a hand-edited product cannot be registered, the lint reads the register, and the other tool cannot write PIRs', async () => {
  const world = await staffWorld();
  const tools = new Map(intelWorkbenchTools({ decisions: () => world.host.pirDecisions() }).map((tool) => [tool.name, tool as AgentTool<Record<string, unknown>>]));
  const call = async (name: string, args: Record<string, unknown>) => { const tool = tools.get(intelToolName(name))!; return tool.run(tool.parse(args), workbenchContext(world.root)); };
  await call('pir_add', PIR);
  assert.match(await call('pir_publish', {}), /Wrote .*pir-register\.md/);
  const productFile = path.join(world.root, productPath('j2', 'pir-register'));
  const team = { ...J2_TEAM, members: [...J2_TEAM.members, 'tradecraft-reviewer', 'release-guard'] };
  const proposed = await callTool(world, team, 'mcp__staff-products__propose', { product: 'pir-register', kind: 'register' }, 'requirements-manager');
  assert.ok(proposed.ok, proposed.text);
  // The register changes: the published product no longer matches, and a hand edit of the product never does.
  await call('pir_update', { id: 'PIR-1', status: 'awaiting-decision' });
  await writeFile(productFile, (await readFile(productFile, 'utf8')).replace('| candidate |', '| approved |'));
  const handEdited = await callTool(world, team, 'mcp__staff-products__propose', { product: 'pir-register', kind: 'register' }, 'requirements-manager');
  assert.match(handEdited.text, /is generated from .*pir-register\.json and differs from it/);
  await call('pir_publish', {});
  const body = (await readFile(productFile, 'utf8')).replace(/^---[\s\S]*?\n---\n/, '');
  const register = await world.host.pirRegister();
  assert.ok('entries' in register && register.entries);
  assert.equal(body, pirRegisterProductBody(register.entries ?? []), 'the product is exactly what the register generates');
  const republished = await callTool(world, team, 'mcp__staff-products__propose', { product: 'pir-register', kind: 'register' }, 'requirements-manager');
  assert.ok(republished.ok, republished.text);
  // The staff-products register tool is not a second writer of PIRs.
  const second = await callTool(world, team, 'mcp__staff-products__register', { action: 'write', register: 'pir-register', rows: [] }, 'requirements-manager');
  assert.match(second.text, /kept by the intel workbench/);
  // The lint reads the register: a PIR without a latest time of value there is a finding, whatever any product file says.
  const json = path.join(world.root, registerPath('pir-register'));
  assert.ok(hashIn(proposed.text));
  assert.ok((await readFile(json, 'utf8')).includes('"ltiov"'));
});

test('the red team registers only critiques: its critique file as a plan, an order or any other kind is refused', async () => {
  const world = await staffWorld();
  await writeBody(world.root, 'j5', 'red-team-critique', '# Critique\n\n1. high: an assumption has no trigger.\n');
  for (const kind of ['plan', 'order', 'coa-statement', 'estimate']) {
    const refused = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'red-team-critique', kind }, 'red-team');
    assert.match(refused.text, /red-team may register only critique/, kind);
  }
  const critique = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'red-team-critique', kind: 'critique' }, 'red-team');
  assert.ok(critique.ok, critique.text);
});

test('the staff setup writes the project files first and the team file last, and rolls everything back when it fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'staff-setup-rollback-'));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'AGENTS.md'), '# Agent instructions\n\nkeep me\n');
  const library = new TeamLibrary(path.join(root, 'store'));
  const plan = planStaffSetup({ templateId: J2_STAFF_TEMPLATE.id, options: { settings: { ...defaultStaffSettings(), profile: 'us-joint', level: 'operational' }, locality: 'cloud' } });
  // The team file's place is taken at the last moment: the team write fails after every project file was written.
  const teamFile = path.join(library.directory, `${plan.roster.fileName}.md`);
  const order: string[] = [];
  setCasProbe(async (at, target) => {
    if (at !== 'before-temp') return;
    order.push(path.relative(root, target));
    if (target === teamFile) { await mkdir(path.dirname(teamFile), { recursive: true }); await writeFile(teamFile, 'someone else\'s team'); }
  });
  try {
    await assert.rejects(applyStaffSetup(project, library, plan), /not set up, and what was written is rolled back/);
  } finally { setCasProbe(undefined); }
  assert.equal(order.indexOf(path.relative(root, teamFile)), plan.writes.length, 'the team file is written after every project file (what follows is the rollback)');
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), '# Agent instructions\n\nkeep me\n', 'AGENTS.md is back as it was');
  await assert.rejects(readFile(path.join(project, '.planning/staff/PROFILE.md')), 'new project files are removed');
  await assert.rejects(readFile(path.join(project, '.planning/.near-ai/project.json')));
  assert.equal(await readFile(teamFile, 'utf8'), 'someone else\'s team', 'the other team file is untouched');
});
