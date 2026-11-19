// Review round 2 of drop 1: a staff ledger or log that cannot be read whole is unreadable, never empty; a ledger cut short, deleted or replaced is caught
// against the signed head this computer keeps outside the project (the D-59 pattern); the staff tools declare every file they read; only servers that
// exist are granted; and a register write that is refused leaves the file as it was.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { readEffectPaths } from '../agent/gateLabels';
import { matchesGlob } from '../agent/glob';
import { builtInStaffServers } from '../agent/staffServers';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { J2_PRODUCTS, productPath as j2ProductPath } from '../agent/staff/j2Products';
import { staffTools } from '../agent/staffTools';
import { parseTeam } from '../agent/teams';
import { effectsFor } from '../domain/gate/manifest';
import { LEDGER_PROBLEMS } from '../domain/staff/ledger';
import { REAL_ENTITIES_FILE } from '../domain/staff/realEntities';
import { grantsMcpTool } from '../mcp/tools';
import { GUARD_CONFIG_FILE, LEDGER_DIR, LEDGER_FILE, LEDGER_HEAD_SECRET_PREFIX, productPath, STAFF_HOST_PATHS, STAFF_SETTINGS_FILE, StaffHost, WARGAME_DIR } from '../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, readProductFile, staffWorld, trusting, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const PROPOSE = 'mcp__staff-products__propose';
const VERDICT = 'mcp__staff-products__verdict';
const BIG = 2 * 1024 * 1024 + 16;
const ledgerFile = (world: StaffWorld) => path.join(world.root, LEDGER_DIR, LEDGER_FILE);

async function proposeAndHold(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  assert.ok(proposed.ok, proposed.text);
  const held = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'HOLD', hash: hashIn(proposed.text), reasons: ['Compilation risk.'] }, 'release-guard');
  assert.ok(held.ok, held.text);
}

// ---- 1. Unreadable is never empty --------------------------------------------------------------------------------------------------------------

test('a ledger too large to read whole is unreadable, not empty: nothing shows as fine, nothing is appended, and Set Aside is the way out', async () => {
  const world = await staffWorld();
  await proposeAndHold(world);
  await appendFile(ledgerFile(world), `${'x'.repeat(BIG)}\n`);
  const size = (await stat(ledgerFile(world))).size;
  const replay = await world.host.replay();
  assert.equal(replay.broken?.reason.startsWith(LEDGER_PROBLEMS['file-unreadable']), true, replay.broken?.reason);
  assert.match((await world.host.snapshot()).ledgerProblem ?? '', /could not be read in full/);
  await writeBody(world.root, 'j5', 'annex-c', CLEAN_BODY);
  const refused = await callTool(world, J5_TEAM, PROPOSE, { product: 'annex-c', kind: 'annex' }, 'lead-planner');
  assert.match(refused.text, /cannot be trusted[\s\S]*Nothing was recorded[\s\S]*Set Aside the Product Ledger/);
  assert.equal((await stat(ledgerFile(world))).size, size, 'nothing was appended to the oversized file');
  const kept = await world.host.setAsideLedger();
  assert.match(kept ?? '', /products\.set-aside-/);
  const again = await callTool(world, J5_TEAM, PROPOSE, { product: 'annex-c', kind: 'annex' }, 'lead-planner');
  assert.ok(again.ok, again.text);
});

test('the wargame ledger and the event log are unreadable, not empty, when too large; neither is written on top of', async () => {
  const world = await staffWorld();
  await mkdir(path.join(world.root, WARGAME_DIR), { recursive: true });
  await writeFile(path.join(world.root, WARGAME_DIR, 'ledger.jsonl'), 'x'.repeat(BIG));
  const turn = await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'record', phase: { coa: 'coa-a', enemyCoa: 'mlcoa', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [], results: [], decisionPoints: [] } }, 'plans-writer');
  assert.match(turn.text, /cannot be read: it is larger than 2 MB/);
  await assert.rejects(() => world.host.wargameEntries(), /cannot be read/);
  const derive = await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'derive' }, 'lead-planner');
  assert.match(derive.text, /cannot be read/);

  const events = path.join(world.root, LEDGER_DIR, 'events.jsonl');
  await mkdir(path.dirname(events), { recursive: true });
  await writeFile(events, 'x'.repeat(BIG));
  await world.host.emit([{ type: 'staff.step.entered', run: 'run-1', at: '2026-11-18T12:00:00.000Z', section: 'j5', step: 1 } as never]);
  assert.equal((await stat(events)).size, BIG, 'nothing was appended to the oversized event log');
  assert.match((await world.host.snapshot()).eventLogProblem ?? '', /events\.jsonl cannot be read/);
});

// ---- 2. The ledger head kept outside the project --------------------------------------------------------------------------------------------

test('a ledger whose last entry was cut off reads as tampered: the HOLD cannot be dropped silently', async () => {
  const world = await staffWorld();
  await proposeAndHold(world);
  assert.ok([...(world.headStore as ReturnType<typeof memorySecrets>).values.keys()].some((key) => key.startsWith(LEDGER_HEAD_SECRET_PREFIX)), 'the head is kept in secret storage');
  const lines = (await readFile(ledgerFile(world), 'utf8')).split('\n').filter(Boolean);
  await writeFile(ledgerFile(world), `${lines.slice(0, -1).join('\n')}\n`);
  const replay = await world.host.replay();
  assert.equal(replay.broken?.reason, LEDGER_PROBLEMS.truncated);
  assert.equal(replay.products.get('concept-of-operations')?.tampered, LEDGER_PROBLEMS.truncated);
  const status = await callTool(world, J5_TEAM, 'mcp__staff-products__status', { product: 'concept-of-operations' }, 'lead-planner');
  assert.match(status.text, /tampered/);
  const write = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  assert.equal(write.ok && !/cannot/.test(write.text), false);
  // A new host over the same project and the same secret storage (a window reload) still sees it.
  world.reload();
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS.truncated);
});

test('a deleted ledger, or one replaced by another, reads as tampered; Set Aside starts again; a host with no head store cannot tell', async () => {
  const world = await staffWorld();
  await proposeAndHold(world);
  const original = await readFile(ledgerFile(world), 'utf8');
  await rm(ledgerFile(world));
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS.truncated, 'deleted');
  assert.match((await world.host.snapshot()).ledgerProblem ?? '', /removed from its end, or the file was deleted/);

  await writeFile(ledgerFile(world), original);
  assert.equal((await world.host.replay()).broken, undefined, 'the original back in place reads clean');

  // Set Aside after a deletion clears the record, and work goes on.
  await rm(ledgerFile(world));
  assert.equal(await world.host.setAsideLedger(), '', 'nothing to keep, but the record is reset');
  assert.equal((await world.host.replay()).broken, undefined);
  await writeBody(world.root, 'j5', 'annex-d', CLEAN_BODY);
  assert.ok((await callTool(world, J5_TEAM, PROPOSE, { product: 'annex-d', kind: 'annex' }, 'lead-planner')).ok);

  // A replaced ledger: the same length, validly signed by this computer's key, but not the entries it recorded.
  const replaced = await staffWorld();
  await writeBody(replaced.root, 'j5', 'annex-e', CLEAN_BODY);
  assert.ok((await callTool(replaced, J5_TEAM, PROPOSE, { product: 'annex-e', kind: 'annex' }, 'lead-planner')).ok);
  const first = (await readFile(ledgerFile(replaced), 'utf8')).split('\n').filter(Boolean)[0];
  await writeBody(replaced.root, 'j5', 'annex-f', CLEAN_BODY);
  assert.ok((await callTool(replaced, J5_TEAM, PROPOSE, { product: 'annex-f', kind: 'annex' }, 'lead-planner')).ok);
  const copy = await staffWorld({ headStore: null });
  copy.host = new StaffHost({ root: copy.root, signer: async () => replaced.signer, keyStatus: async () => trusting(replaced.signer) });
  await mkdir(path.dirname(ledgerFile(copy)), { recursive: true });
  await writeFile(ledgerFile(copy), `${first}\n`);
  await writeBody(copy.root, 'j5', 'annex-g', CLEAN_BODY);
  assert.ok((await callTool(copy, J5_TEAM, PROPOSE, { product: 'annex-g', kind: 'annex' }, 'lead-planner')).ok);
  await writeFile(ledgerFile(replaced), await readFile(ledgerFile(copy), 'utf8'));
  assert.equal((await replaced.host.replay()).broken?.reason, LEDGER_PROBLEMS.replaced);

  const unguarded = await staffWorld({ headStore: null });
  await proposeAndHold(unguarded);
  const kept = (await readFile(ledgerFile(unguarded), 'utf8')).split('\n').filter(Boolean);
  await writeFile(ledgerFile(unguarded), `${kept.slice(0, -1).join('\n')}\n`);
  assert.equal((await unguarded.host.replay()).broken, undefined, 'without a head store only the chain is checked, as SECURITY.md says');
});

test('a head record that does not verify reads the ledger as tampered', async () => {
  const world = await staffWorld();
  await proposeAndHold(world);
  const store = world.headStore as ReturnType<typeof memorySecrets>;
  const [key] = [...store.values.keys()];
  const envelope = JSON.parse(store.values.get(key)!) as { payload: { count: number } };
  envelope.payload.count = 1;
  store.values.set(key, JSON.stringify(envelope));
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS['head-unverified']);
});

// ---- 3. The staff tools declare every file the host reads ----------------------------------------------------------------------------------

test('every staff tool declares every project file the staff host reads, and writes only in the staff folder', () => {
  const covered = (file: string) => STAFF_HOST_PATHS.some((glob) => glob === file || matchesGlob(glob, file));
  for (const file of [STAFF_SETTINGS_FILE, GUARD_CONFIG_FILE, REAL_ENTITIES_FILE, `${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j2', 'intsum')]) assert.ok(covered(file), file);
  // The class: every `.planning/` path the host and its readers spell is covered, so a new one fails here until it is declared.
  const SOURCES = [path.join(__dirname, '..', '..', 'src', 'staff'), path.join(__dirname, '..', '..', 'src', 'domain', 'staff', 'realEntities.ts'), path.join(__dirname, '..', '..', 'src', 'domain', 'staff', 'writeLimits.ts')];
  const files = SOURCES.flatMap((entry) => (statSync(entry).isDirectory() ? readdirSync(entry).filter((name) => name.endsWith('.ts')).map((name) => path.join(entry, name)) : [entry]));
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'(\.planning\/[^'`$]*)'/g)) {
      // A folder (no extension in its last part) is checked by a file inside it.
      const spelled = match[1].endsWith('/') ? `${match[1]}x` : /\.[a-z]+$/.test(match[1]) ? match[1] : `${match[1]}/x`;
      assert.ok(covered(spelled), `${path.basename(file)} names ${match[1]}, which the staff tools do not declare`);
    }
  }
  const tools = staffTools({ host: () => undefined, team: J5_TEAM, run: 'r' });
  for (const tool of tools) {
    const effects = effectsFor(tool.manifest, {});
    assert.ok(effects.ok, tool.name);
    if (!effects.ok) continue;
    const reads = readEffectPaths(effects.value);
    for (const glob of STAFF_HOST_PATHS) assert.ok(reads.includes(glob) || reads.includes(glob.replace(/\*\*$/, '')), `${tool.name} declares ${glob} (it declares ${reads.join(', ')})`);
    for (const effect of effects.value.filter((entry) => entry.verb === 'workspaceWrite')) assert.deepEqual(effect.paths, ['.planning/staff/**'], tool.name);
  }
});

// ---- 4. Only servers that exist are granted ---------------------------------------------------------------------------------------------

test('every MCP grant in every staff template names a server that exists, and a member told to use cop-map is granted it; map layers are product files', () => {
  const servers = new Set(builtInStaffServers().map((server) => server.id));
  for (const template of STAFF_TEMPLATES) {
    for (const rendering of template.renderings().filter((_, index) => index % 5 === 0)) {
      for (const member of parseTeam(rendering.team, '/p/t.md').members) {
        for (const tool of member.tools) {
          const server = /^mcp__([^_]+(?:-[^_]+)*)__/.exec(tool)?.[1] ?? /^mcp:(.+)$/.exec(tool)?.[1];
          if (server) assert.ok(servers.has(server), `${rendering.key}/${member.name} is granted ${tool}, a server that does not exist`);
        }
        assert.ok(servers.has('cop-map'), 'the cop-map server exists');
        if (/cop-map/.test(member.instructions)) assert.ok(member.tools.some((tool) => tool === 'mcp:cop-map' || tool.startsWith('mcp__cop-map__')), `${member.name} is told to use cop-map, so it is granted it`);
      }
    }
  }
  for (const layer of J2_PRODUCTS.filter((product) => product.kind === 'map-layer')) {
    assert.match(j2ProductPath(layer), /^\.planning\/staff\/products\/j2\/cop-[a-z]+-layer\.md$/);
  }
});

test('every MCP grant in every rendering of every staff template grants at least one tool a built-in staff server has (drop 2: orders, battle rhythm, watches)', () => {
  const tools = builtInStaffServers().flatMap((server) => server.tools.map((tool) => tool.name));
  for (const template of STAFF_TEMPLATES) {
    for (const rendering of template.renderings()) {
      for (const member of parseTeam(rendering.team, '/p/t.md').members) {
        for (const grant of member.tools.filter((tool) => tool.startsWith('mcp__') || tool.startsWith('mcp:'))) {
          assert.ok(tools.some((tool) => grantsMcpTool([grant], tool)), `${rendering.key}/${member.name} is granted ${grant}, which names no tool of a built-in staff server`);
        }
      }
    }
  }
});

// ---- 5. A refused register write leaves the file as it was ------------------------------------------------------------------------------

test('a register write the ledger refuses puts the file back exactly, or removes the file it created', async () => {
  const world = await staffWorld();
  const register = path.join(world.root, productPath('j5', 'facts-assumptions-ledger'));
  // A broken ledger refuses every record; the register write must not leave its rows behind.
  await mkdir(path.dirname(ledgerFile(world)), { recursive: true });
  await writeFile(ledgerFile(world), 'not a signed entry\n');
  const created = await callTool(world, J5_TEAM, 'mcp__staff-products__register', { action: 'write', register: 'facts-assumptions-ledger', rows: [{ id: 'A-1', kind: 'assumption', statement: 'The port stays open.', status: 'unconfirmed', invalidationTrigger: 'The port closes.' }] }, 'lead-planner');
  assert.match(created.text, /back as it was|cannot be trusted|not recorded/);
  await assert.rejects(() => stat(register), 'the file the write created is gone again');

  const second = await staffWorld();
  const file = path.join(second.root, productPath('j5', 'facts-assumptions-ledger'));
  await writeBody(second.root, 'j5', 'facts-assumptions-ledger', '# Facts and assumptions\n\nhand-written\n');
  const before = await readFile(file, 'utf8');
  await mkdir(path.dirname(ledgerFile(second)), { recursive: true });
  await writeFile(ledgerFile(second), 'not a signed entry\n');
  const refused = await callTool(second, J5_TEAM, 'mcp__staff-products__register', { action: 'write', register: 'facts-assumptions-ledger', rows: [{ id: 'A-1', kind: 'assumption', statement: 'The port stays open.', status: 'unconfirmed', invalidationTrigger: 'The port closes.' }] }, 'lead-planner');
  assert.equal(refused.ok && !/back as it was/.test(refused.text), false, refused.text);
  assert.equal(await readFile(file, 'utf8'), before, 'the register file is byte for byte as it was');
  assert.ok(await readProductFile(second.root, 'j5', 'facts-assumptions-ledger'));
});
