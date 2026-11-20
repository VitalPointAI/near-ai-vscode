// Make a Single-Machine Copy (plan 31-22; owner decision 6, D-35, D-37, D-47; MUS-06). A shared staff project is folded back into today's
// single-machine files in a new folder, signed by this device. The tests check that today's own host and verifiers trust the copy, that the shared
// project is untouched byte for byte, that other people's steps are carried under the copier and a contested decision is never carried as decided,
// and that a destination in the shared project or one with staff files is refused with nothing written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { LEDGER_PROBLEMS, parseLedgerHeadMark } from '../domain/staff/ledger';
import type { ProductState } from '../domain/staff/ledger';
import type { PersonActor } from '../domain/staff/release';
import { verifyPayload } from '../domain/team/signedPayload';
import type { DeviceIdentity } from '../team/identity';
import { isMigrationRefused, ledgerHeadKey, makeMultiUser, projectionInputOf } from '../staff/replica/migrate';
import type { MigrationDeps } from '../staff/replica/migrate';
import { projectLedgerReplay } from '../staff/replica/projection';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import { makeSingleMachineCopy } from '../staff/replica/singleCopy';
import type { CopyDeps, CopyResult } from '../staff/replica/singleCopy';
import { LEDGER_DIR, LEDGER_FILE, StaffHost, productPath } from '../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const NOW = '2026-11-20T10:00:00.000Z';
const NAME = 'Exercise Northwind';
const CONOPS = 'concept-of-operations';
const DECISION_ROLE = 'commander';
const COPIER = { name: 'C. Copier', role: 'Plans officer' };

type Secrets = ReturnType<typeof memorySecrets>;

/** One install with a staff project: the project folder, the extension's global storage, its secret storage, and the device that signs. */
interface Env {
  readonly base: string;
  readonly root: string;
  readonly global: string;
  readonly secrets: Secrets;
  readonly signer: DeviceIdentity;
  readonly deps: MigrationDeps & CopyDeps;
}

async function freshEnv(label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-copy-${label}-`));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  const global = path.join(base, 'global');
  const secrets = memorySecrets();
  const device = await ReplicaProject.localDevice({ secrets, globalStorageDir: global, now: () => new Date(NOW) });
  const signer = device.signer;
  return { base, root, global, secrets, signer, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW), staffKeyStatus: async () => trusting(signer), copier: COPIER } };
}

/** Today's host over a folder, signed by the env's device, its head kept in the env's secrets. */
function hostAt(env: Env, root: string, trust: KeyTrust = (signer) => trusting(signer)): StaffHost {
  const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
  return new StaffHost({ root, signer: async () => env.signer, keyStatus: async () => trust(env.signer), headStore: env.secrets, now: () => { clock.now += 1000; return clock.now; } });
}
type KeyTrust = (signer: DeviceIdentity) => ReturnType<typeof trusting>;

function worldOf(env: Env): StaffWorld {
  const world: StaffWorld = {
    root: env.root, signer: env.signer, clock: { now: 0 }, host: hostAt(env, env.root), headStore: env.secrets,
    reload: () => { world.host = hostAt(env, env.root); return world.host; },
    person: (name = 'A. Demo', role = DECISION_ROLE): PersonActor => ({ kind: 'person', name, role, deviceFingerprint: env.signer.fingerprint })
  };
  return world;
}

function must(result: { ok: boolean; text: string }, what: string): string {
  assert.ok(result.ok, `${what}: ${result.text}`);
  return result.text;
}

/** A product proposed, guard-cleared, submitted, approved and released by today's host. */
async function releasedProduct(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', CONOPS, CLEAN_BODY);
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan' }, 'lead-planner'), 'propose'));
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE }, 'lead-planner'), 'submit');
  const approved = await world.host.decide(world.person(), { product: CONOPS, action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  const released = await world.host.decide(world.person(), { product: CONOPS, action: 'release', hash });
  assert.ok(released.ok, released.ok ? '' : released.message);
}

async function migrated(label: string): Promise<Env> {
  const env = await freshEnv(label);
  await releasedProduct(worldOf(env));
  const result = await makeMultiUser(env.root, env.deps, { name: NAME });
  assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
  return env;
}

/** The shared projection of an env's project, as today's host would show it. */
async function sharedReplay(env: Env) {
  const project = await ReplicaProject.open(env.root, env.deps);
  assert.ok(project instanceof ReplicaProject, `the shared project opens (${isProjectRefused(project) ? project.message : String(project)})`);
  try {
    return projectLedgerReplay(await projectionInputOf(project, env.deps));
  } finally {
    await project.close();
  }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Every file under a folder, by path, with the sha256 of its bytes (the replica store included). */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(path.relative(root, file).split(path.sep).join('/'), sha256(readFileSync(file)));
    }
  };
  walk(root);
  return out;
}

async function copied(env: Env, destination: string, deps: CopyDeps = env.deps): Promise<CopyResult> {
  const result = await makeSingleMachineCopy(env.root, destination, deps);
  assert.ok(result.ok, result.ok ? '' : `the copy is made: ${result.message}`);
  return result;
}

// ---- Task 1: the tracer -----------------------------------------------------------------------------------------------------------------------------

test('tracer: a migrated project with one released product copies to a new folder that today\'s host replays without a break', async () => {
  const env = await migrated('tracer');
  const shared = (await sharedReplay(env)).products.get(CONOPS) as ProductState;
  assert.equal(shared.record.state, 'released');
  const destination = path.join(env.base, 'copy');
  const result = await copied(env, destination);
  assert.ok(result.written.includes(`${LEDGER_DIR}/${LEDGER_FILE}`), 'the product ledger is written');
  assert.ok(result.written.includes(productPath('j5', CONOPS)), 'the product file is written');
  assert.equal(result.carried, 0, 'every step was taken by this device\'s own person, so nothing is carried under another name');
  assert.deepEqual(result.contested, []);
  assert.deepEqual(result.differs, []);

  // The head mark is kept, signed by this device, under the key today's host computes for the copy's folder, before any host has looked at the copy.
  const markText = env.secrets.values.get(ledgerHeadKey(destination));
  assert.ok(markText !== undefined, 'the copy writes its head mark under the copy\'s key');

  // Today's host, rooted at the copy as any single-machine project, replays it without a break and shows the product as the shared projection does.
  const host = hostAt(env, destination);
  const replay = await host.replay();
  assert.equal(replay.broken, undefined, 'the copy\'s product ledger verifies with today\'s verifier');
  const state = replay.products.get(CONOPS) as ProductState;
  assert.ok(state !== undefined);
  assert.equal(state.tampered, undefined);
  assert.equal(state.record.state, shared.record.state);
  assert.equal(state.record.version, shared.record.version);
  assert.equal(state.record.hash, shared.record.hash);
  assert.deepEqual(state.meta, shared.meta);
  assert.deepEqual(state.approvedVersions, shared.approvedVersions);
  // The product file agrees with the copy's ledger: today's status shows it released, not tampered.
  const status = await host.productState(CONOPS);
  assert.equal(status?.state, 'released');
  assert.equal(status?.tampered, undefined);

  // The mark names the ledger's own count and head, so today's replay did not need to move it; a copy cut short reads as truncated.
  assert.equal(env.secrets.values.get(ledgerHeadKey(destination)), markText, 'the replay left the copy\'s mark as the copy wrote it');
  const verdict = verifyPayload(JSON.parse(markText) as unknown, { purpose: 'staff-ledger-head', status: trusting(env.signer) });
  assert.ok(verdict.ok);
  assert.deepEqual(parseLedgerHeadMark(verdict.payload), { v: 1, count: replay.entries, head: replay.head });
  const ledgerFile = path.join(destination, LEDGER_DIR, LEDGER_FILE);
  const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  writeFileSync(ledgerFile, `${lines.slice(0, -1).join('\n')}\n`);
  assert.equal((await hostAt(env, destination).replay()).broken?.reason, LEDGER_PROBLEMS.truncated, 'today\'s host found the copy\'s head mark');
});

test('the shared project is byte for byte untouched by a copy: every file under it and every secret but the copy\'s new head mark', async () => {
  const env = await migrated('untouched');
  const filesBefore = tree(env.base);
  const secretsBefore = new Map(env.secrets.values);
  const destination = path.join(env.base, 'copy');
  await copied(env, destination);
  const filesAfter = tree(env.base);
  for (const [file, hash] of filesBefore) assert.equal(filesAfter.get(file), hash, `${file} is unchanged`);
  const added = [...filesAfter.keys()].filter((file) => !filesBefore.has(file));
  assert.ok(added.length > 0 && added.every((file) => file.startsWith('copy/')), `only the copy's files are new (${added.filter((file) => !file.startsWith('copy/')).join(', ')})`);
  const secretsAfter = new Map(env.secrets.values);
  const markKey = ledgerHeadKey(destination);
  assert.ok(secretsAfter.has(markKey) && !secretsBefore.has(markKey));
  secretsAfter.delete(markKey);
  assert.deepEqual(secretsAfter, secretsBefore, 'no other secret changed');
});
