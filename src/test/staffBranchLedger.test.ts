// Use This Branch's Ledger (drop 2): after a switch to an older or different git branch, the staff ledger there is shorter than, or different from, the
// head this computer recorded and reads as tampered. A named person, after a modal dialog that says what changes, makes this branch's ledger the one
// this computer checks against, but only when its own signatures and chain verify; a broken ledger is refused (Set Aside is its way out). Who did it is a
// signed entry in the decision log. No agent tool reaches it.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { staffTools } from '../agent/staffTools';
import { builtInTools } from '../agent/toolCatalog';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS } from '../domain/staff/commands';
import { LEDGER_PROBLEMS } from '../domain/staff/ledger';
import { DECISION_LOG_FILE } from '../domain/staff/personDecisions';
import { LEDGER_DIR, LEDGER_FILE, StaffHost } from '../staff/staffHost';
import { MemorySecrets } from './helpers/teamHarness';
import { callTool, CLEAN_BODY, J5_TEAM, staffWorld, trusting, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');
test.after(() => { uninstall(); hosts.configureStaffHosts(undefined); });

const PROPOSE = 'mcp__staff-products__propose';
const ledgerFile = (root: string): string => path.join(root, LEDGER_DIR, LEDGER_FILE);

async function propose(world: Pick<StaffWorld, 'root' | 'host'>, product: string): Promise<void> {
  await writeBody(world.root, 'j5', product, CLEAN_BODY);
  const result = await callTool(world as StaffWorld, J5_TEAM, PROPOSE, { product, kind: 'annex' }, 'lead-planner');
  assert.ok(result.ok, result.text);
}

/** A world whose ledger is an older branch's copy: one entry, where this computer recorded two. */
async function olderBranch(): Promise<{ world: StaffWorld; older: string; newer: string }> {
  const world = await staffWorld();
  await propose(world, 'annex-e');
  const older = await readFile(ledgerFile(world.root), 'utf8');
  await propose(world, 'annex-f');
  const newer = await readFile(ledgerFile(world.root), 'utf8');
  await writeFile(ledgerFile(world.root), older);
  return { world, older, newer };
}

test('an older branch\'s valid ledger: the check says so, a person uses it, the ledger then reads untampered, takes new entries, and the person is recorded', async () => {
  const { world } = await olderBranch();
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS.truncated);
  assert.match((await world.host.snapshot()).ledgerProblem ?? '', /Use This Branch's Ledger/);
  const refusal = await callTool(world, J5_TEAM, PROPOSE, { product: 'annex-e', kind: 'annex' }, 'lead-planner');
  assert.match(refusal.text, /annex-e cannot be changed: The ledger ends before[\s\S]*Use This Branch's Ledger/);
  await writeBody(world.root, 'j5', 'annex-q', CLEAN_BODY);
  const fresh = await callTool(world, J5_TEAM, PROPOSE, { product: 'annex-q', kind: 'annex' }, 'lead-planner');
  assert.match(fresh.text, /Use This Branch's Ledger[\s\S]*Set Aside the Product Ledger/, 'the refusal names both ways out');
  const check = await world.host.branchLedgerCheck();
  assert.equal(check.kind, 'other-copy');
  if (check.kind !== 'other-copy') return;
  assert.deepEqual({ reason: check.reason, recorded: check.recorded, entries: check.entries, products: check.products }, { reason: 'truncated', recorded: 2, entries: 1, products: 1 });

  // A stale view (the ledger changed since the person looked) and an unnamed person are refused.
  const stale = await world.host.adoptBranchLedger(world.person(), { head: check.head, entries: 2 });
  assert.equal(stale.ok, false);
  const unnamed = await world.host.adoptBranchLedger({ ...world.person(), name: ' ' }, { head: check.head, entries: check.entries });
  assert.equal(unnamed.ok, false);
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS.truncated, 'nothing changed');

  const used = await world.host.adoptBranchLedger(world.person('A. Demo', 'J-5 director'), { head: check.head, entries: check.entries });
  assert.ok(used.ok, used.ok ? '' : used.message);
  const replay = await world.host.replay();
  assert.equal(replay.broken, undefined);
  assert.equal(replay.products.get('annex-e')?.tampered, undefined);
  assert.equal((await world.host.branchLedgerCheck()).kind, 'current');
  // Who did it: a signed entry in the decision log.
  const log = (await readFile(path.join(world.root, LEDGER_DIR, DECISION_LOG_FILE), 'utf8')).trim().split('\n');
  const entry = (JSON.parse(log[log.length - 1]) as { payload: { subject: unknown; person: { name: string; role: string }; wording: string } }).payload;
  assert.deepEqual(entry.subject, { kind: 'ledger-head', id: '1' });
  assert.equal(entry.wording, check.head);
  assert.deepEqual([entry.person.name, entry.person.role], ['A. Demo', 'J-5 director']);
  // The decision log still replays (the new subject kind is part of it), and new work goes on, also after a reload.
  assert.equal((await world.host.pirDecisions()).size, 1);
  await propose(world, 'annex-g');
  world.reload();
  assert.equal((await world.host.replay()).broken, undefined);
  assert.equal((await world.host.replay()).entries, 2);
});

test('a ledger with a different history of the same length (replaced) can be used too', async () => {
  const world = await staffWorld();
  await propose(world, 'annex-e');
  const other = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-branch-'));
  const branch = { root: other, host: new StaffHost({ root: other, signer: async () => world.signer, keyStatus: async () => trusting(world.signer) }) };
  await propose(branch, 'annex-x');
  await writeFile(ledgerFile(world.root), await readFile(ledgerFile(other), 'utf8'));
  assert.equal((await world.host.replay()).broken?.reason, LEDGER_PROBLEMS.replaced);
  const check = await world.host.branchLedgerCheck();
  assert.ok(check.kind === 'other-copy' && check.reason === 'replaced');
  if (check.kind !== 'other-copy') return;
  assert.ok((await world.host.adoptBranchLedger(world.person(), { head: check.head, entries: check.entries })).ok);
  assert.ok((await world.host.replay()).products.has('annex-x'));
  assert.equal((await world.host.replay()).broken, undefined);
});

test('a ledger whose own chain is broken is refused: Set Aside is the way out, and nothing changes', async () => {
  const { world, newer } = await olderBranch();
  // The first entry removed: the chain breaks at once.
  await writeFile(ledgerFile(world.root), `${newer.trim().split('\n').slice(1).join('\n')}\n`);
  const check = await world.host.branchLedgerCheck();
  assert.equal(check.kind, 'broken');
  assert.match(check.kind === 'broken' ? check.message : '', /does not verify on its own[\s\S]*Set Aside the Product Ledger/);
  const refused = await world.host.adoptBranchLedger(world.person(), { head: 'a'.repeat(64), entries: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.message, /Set Aside/);
  assert.ok((await world.host.replay()).broken, 'still not trusted');
  // A ledger signed by a key this computer does not trust is broken on its own as well.
  const stranger = await staffWorld();
  await propose(stranger, 'annex-z');
  const { world: second } = await olderBranch();
  await writeFile(ledgerFile(second.root), await readFile(ledgerFile(stranger.root), 'utf8'));
  assert.equal((await second.host.branchLedgerCheck()).kind, 'broken');
  // A ledger that already reads as the recorded one has nothing to use.
  const plain = await staffWorld();
  await propose(plain, 'annex-a');
  assert.equal((await plain.host.branchLedgerCheck()).kind, 'current');
  assert.equal((await plain.host.adoptBranchLedger(plain.person(), { head: 'a'.repeat(64), entries: 1 })).ok, false);
});

test('no agent tool reaches it: not a staff tool, not in the catalog, not a Staff Room button, and nothing under src/agent or src/mcp calls it', async () => {
  const names = [...staffTools({ host: () => undefined, team: J5_TEAM, run: 'run-1' }).map((tool) => tool.name), ...builtInTools().map((tool) => tool.name)];
  assert.ok(!names.some((name) => /ledger|branch/i.test(name)), names.filter((name) => /ledger|branch/i.test(name)).join(', '));
  assert.ok(!PERSON_DECISION_COMMANDS.includes(STAFF_COMMANDS.useBranchLedger));
  const sources = path.join(__dirname, '..', '..', 'src');
  for (const folder of ['agent', 'mcp']) {
    const files = (await readdir(path.join(sources, folder), { recursive: true })).filter((file) => file.endsWith('.ts'));
    for (const file of files) {
      const text = await readFile(path.join(sources, folder, file), 'utf8');
      assert.ok(!/adoptBranchLedger|useBranchLedger|staff-ledger-head/.test(text), `${folder}/${file}`);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(sources, '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category: string }> } };
  assert.deepEqual(manifest.contributes.commands.find((entry) => entry.command === STAFF_COMMANDS.useBranchLedger), { command: STAFF_COMMANDS.useBranchLedger, title: "Staff: Use This Branch's Ledger", category: 'SovAI' });
});

test('the command: offered from the tampered message, refused without the person\'s confirmation, refused for a broken chain, and works after it', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-branch-cmd-'));
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-branch-project-'));
  stub.setWorkspaceFolders([project]);
  commands.registerStaffCommands(createFakeContext(storage, new MemorySecrets()) as never);
  assert.ok(stub.commands.has(STAFF_COMMANDS.useBranchLedger));
  const host = hosts.staffHostFor(project)!;
  const world = { root: project, host };
  await propose(world, 'annex-e');
  const older = await readFile(ledgerFile(project), 'utf8');
  await propose(world, 'annex-f');
  const newer = await readFile(ledgerFile(project), 'utf8');
  await writeFile(ledgerFile(project), older);

  // Show Products offers the command on the tampered message; dismissing the offer changes nothing.
  stub.messageAnswers.push(undefined);
  await stub.commands.get(STAFF_COMMANDS.show)!();
  const offered = stub.notifications.findIndex((entry) => /reads as tampered/.test(entry.message));
  assert.ok(offered >= 0);
  assert.deepEqual(stub.notificationActions[offered], [commands.USE_BRANCH_LEDGER_ACTION]);

  // Dismissed at the modal dialog: nothing changes.
  stub.inputAnswers.push('A. Demo', 'J-5 director');
  stub.messageAnswers.push(undefined);
  await stub.commands.get(STAFF_COMMANDS.useBranchLedger)!();
  assert.equal((await host.replay()).broken?.reason, LEDGER_PROBLEMS.truncated);
  const dialog = stub.messageOptions[stub.messageOptions.length - 1];
  assert.equal(dialog.message, commands.USE_BRANCH_LEDGER_QUESTION);
  assert.equal(dialog.modal, true);
  assert.match(dialog.detail ?? '', /last recorded a staff ledger of 2 entries\. The ledger on this branch has 1 entries for 1 products, fewer than that/);
  assert.match(dialog.detail ?? '', /self-declared/);

  // A broken chain is refused without asking anyone.
  await writeFile(ledgerFile(project), `${newer.trim().split('\n').slice(1).join('\n')}\n`);
  const before = stub.inputRequests.length;
  await stub.commands.get(STAFF_COMMANDS.useBranchLedger)!();
  assert.equal(stub.inputRequests.length, before, 'no name asked for a ledger that cannot be used');
  assert.match(stub.notifications[stub.notifications.length - 1].message, /does not verify on its own[\s\S]*Set Aside/);

  // Confirmed on the older, valid copy: it is used.
  await writeFile(ledgerFile(project), older);
  stub.inputAnswers.push('A. Demo', 'J-5 director');
  stub.messageAnswers.push(commands.USE_BRANCH_LEDGER_ACTION);
  await stub.commands.get(STAFF_COMMANDS.useBranchLedger)!();
  assert.equal((await host.replay()).broken, undefined);
  assert.match(stub.notifications[stub.notifications.length - 1].message, /is now the one this computer checks against, by A\. Demo \(J-5 director\)/);
});
