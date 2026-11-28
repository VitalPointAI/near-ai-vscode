// Phase 33 plan 27 (D-10, D-13, D-21, D-42, D-58, D-60, D-61; superseded 33-11). Share with people in the session backend, over the session's live
// engine and the engine bundle. The tracer runs two hosted people against a real hub child (D-46 skip rule): the lead shares a staff project, connects
// your organization's server and invites; the second person opens the invitation file, is admitted after the six words, opens the welcome and goes
// live with a certified session key. Every signature the roster checks is a person key's. Then the server actions on a single machine: grant with
// the trade-off, revoke, change address, re-admit with twelve words, the single-machine copy and the presence setting. Fictional exercise data only.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { STAFF_SHARE_TEXT, type ShareOutcome } from '../extension/src/common/staff-share.ts';
import type { ServiceResult } from '../extension/src/common/service-result.ts';
import { INVITE_OPEN_TEXT, InviteOpenHandler, invitationFields, type InvitationOpened } from '../extension/src/browser/staff/invite-open-handler.ts';
import { SESSION_KEY_TEXT, startSessionKeys } from '../extension/src/node/staff/session-keys.ts';
import { createPendingActions } from '../extension/src/node/staff/person-signer.ts';
import { SHOW_WORK_SECRET, StaffShareService, type StaffShareApi } from '../extension/src/node/staff/share-service.ts';
import { loadStaffEngine, type EngineProject, type StaffEngine } from '../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine } from '../extension/src/node/staff/staff-live-engine.ts';
import type * as StaffEntry from '../tools/staff-engine-entry.ts';
import { buildHubFile } from '../../src/domain/replica/hubFile.ts';
import { readGrant } from '../../src/domain/replica/cellKeys.ts';
import { signKemBinding } from '../../src/domain/replica/deviceKem.ts';
import { serverPinWords } from '../../src/domain/replica/serverWords.ts';
import { ensureLabelCell } from '../../src/staff/replica/labelCells.ts';
import { hubNodeOrSkip, startHubChild } from '../../src/test/helpers/hubChild.ts';
import { MemorySecrets, grantsOn } from '../../src/test/helpers/labelCellWorld.ts';
import { rosterDevice } from '../../src/test/helpers/replicaRosterWorld.ts';
import { fixedSigner } from '../../src/test/helpers/replicaWorld.ts';
import { SECRET_PRODUCT, SEED_PRODUCT, seedStaffWork } from './helpers/staff-world.ts';
import { staffProductPath } from '../../src/domain/staff/writeLimits.ts';

type ShareEngine = StaffEngine & StaffShareApi & { x25519BindingBytes(rawX25519: string, writer: string): Buffer };
// The workbench lint checks that the bundle's entry gives every name the share service types.
type EntryMatches = typeof StaffEntry extends StaffShareApi ? true : never;
const entryMatches: EntryMatches = true;

const workbenchRoot = fileURLToPath(new URL('../..', import.meta.url));
const engine = loadStaffEngine<ShareEngine>(workbenchRoot);
const INTERNAL = { scale: 'org', level: 'Internal', compartments: [], releasability: [] };

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function value<T>(answer: ServiceResult<T>, what: string): T {
  assert.equal(answer.kind, 'ok', `${what}: ${answer.kind === 'refused' ? answer.reason : ''}`);
  return (answer as { value: T }).value;
}

/** One person's session: a live engine over their folder and Share with people over it; hosted with a fake KeyService, or a single machine. */
interface Person {
  readonly root: string;
  readonly global: string;
  readonly live: StaffLiveEngine;
  readonly service: StaffShareService;
  readonly secrets: MemorySecrets;
  readonly personKey?: string;
  stale: boolean;
  signed: number;
}

async function person(label: string, options: { hosted: boolean; staff: boolean }): Promise<Person> {
  const base = mkdtempSync(path.join(tmpdir(), `sterling-share-${label}-`));
  const root = path.join(base, 'project');
  const global = path.join(base, 'global');
  mkdirSync(options.staff ? path.join(root, '.planning', 'staff') : root, { recursive: true });
  const secrets = new MemorySecrets();
  const state = { stale: false, signed: 0 };
  let hosted: ConstructorParameters<typeof StaffLiveEngine>[0]['hosted'];
  let personKey: string | undefined;
  if (options.hosted) {
    // Your organization's KeyService: the person key in Transit, which refuses without a fresh passkey confirmation (46-07).
    const key = fixedSigner(`person/${label}`);
    personKey = key.publicKey;
    const keyService = {
      sign: async (message: string) => {
        if (state.stale) return { kind: 'refused' as const, reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm };
        state.signed += 1;
        return { kind: 'ok' as const, value: { signature: Buffer.from(key.signer.sign(Buffer.from(message, 'base64')), 'base64url').toString('base64'), keyVersion: 1 } };
      },
      personPublicKey: async () => ({ kind: 'ok' as const, value: { publicKey: key.publicKey, keyVersion: 1 } }),
    };
    const started = await startSessionKeys(keyService, { status: () => ({ mode: 'hosted' as const, state: 'active' as const }) as never }, { now: () => Date.now() }, { engine });
    assert.equal(started.kind, 'ok');
    const { privateKey } = generateKeyPairSync('x25519');
    const publicKey = Buffer.from(privateKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
    if (started.kind !== 'ok') throw new Error('the session keys were not made');
    const seeds = engine.newKemSeeds();
    const kem = { publicKeys: engine.kemPublicFromSeeds(seeds), privateKeys: engine.kemPrivateFromSeeds(seeds) };
    hosted = { keys: started.value, encryption: { publicKey, privateKey, kem, drop: () => undefined } };
  }
  const live = new StaffLiveEngine({ engine, roots: async () => [root], globalStorageDir: global, secrets, ...(hosted === undefined ? {} : { hosted }) });
  await live.start();
  const service = new StaffShareService({ engine, live: () => live, root: async () => root });
  const result: Person = { root, global, live, service, secrets, ...(personKey === undefined ? {} : { personKey }), stale: false, signed: 0 };
  Object.defineProperty(result, 'stale', { get: () => state.stale, set: (next: boolean) => { state.stale = next; } });
  Object.defineProperty(result, 'signed', { get: () => state.signed });
  return result;
}

const rowOf = (who: Person) => who.live.projects()[0];
const projectOf = (who: Person): EngineProject => who.live.project(rowOf(who).project) as EngineProject;

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: a hosted lead shares and invites; a second hosted person opens the invitation file, is admitted and goes live', async (t: TestContext) => {
  assert.equal(entryMatches, true);
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  const lead = await person('avery', { hosted: true, staff: true });
  const blake = await person('blake', { hosted: true, staff: false });
  try {
    assert.equal(value(await lead.service.view(), 'view').state, 'not-shared');
    const shared = value(await lead.service.turnOn({ clearance: INTERNAL }), 'turn on');
    assert.deepEqual(shared.withheld, []);
    const project = projectOf(lead);
    assert.equal(project.deviceWriter, engine.writerIdOf(lead.personKey as string), 'the person key is the lead device');

    value(await lead.service.connectServer({ hubFile: await server.hubFileText(), ceiling: INTERNAL }), 'connect your organization\'s server');
    await until(() => rowOf(lead), (row) => row?.state === 'live', 'the lead live on the server');
    const invited = value(await lead.service.invite({ name: 'Blake Rivers', seat: 'j4-planner', clearance: INTERNAL }), 'invite');
    assert.ok(invited.file?.name.endsWith('.near-staff-invite'));

    // The invitation file opens through the OpenHandler into the join flow, filled in.
    let opened: InvitationOpened | undefined;
    const handler = new InviteOpenHandler({ read: async () => ({ value: invited.file?.text as string }), size: async () => invited.file?.text.length }, (fields) => { opened = fields; }, () => assert.fail('no warning'));
    const uri = { path: { base: invited.file?.name as string } } as never;
    assert.equal(handler.canHandle(uri), 500);
    await handler.open(uri);
    assert.equal(opened?.text, invited.file?.text);
    const joined = value(await blake.service.openInvitation({ text: opened?.text as string, name: 'Blake Rivers' }), 'open the invitation');
    assert.equal(joined.safetyWords?.length, 6);
    const address = await engine.readHubAddress(blake.global, project.projectId);
    assert.equal(address?.address, server.address, 'the invitation\'s server address is kept for the project being joined');

    const waiting = value(await lead.service.joinRequests(), 'join requests');
    assert.equal(waiting.length, 1);
    assert.deepEqual(waiting[0].safetyWords, joined.safetyWords, 'the lead compares the same six words');
    const refusedAdmit = await lead.service.admit({ request: waiting[0].text, codeMatched: false });
    assert.equal(refusedAdmit.kind, 'refused', 'nobody is admitted unless the words matched');
    const admitted = value(await lead.service.admit({ request: waiting[0].text, codeMatched: true }), 'admit');
    const welcomed = value(await blake.service.openWelcome({ text: admitted.file?.text as string }), 'open the welcome');
    assert.ok(welcomed.message.length > 0);

    await until(() => rowOf(blake), (row) => row?.state === 'live', 'the joiner live on the server');
    const joinedProject = projectOf(blake);
    assert.equal(joinedProject.deviceWriter, engine.writerIdOf(blake.personKey as string), 'the joiner\'s person key is its device');
    const { roster } = await joinedProject.state();
    const sessions = (roster as unknown as { sessions: Map<string, { member: string }> }).sessions;
    const self = roster.members.devices.get(joinedProject.deviceWriter)?.at(-1);
    assert.ok([...sessions.values()].some((item) => item.member === self?.member), 'the joiner\'s session key is certified for its member');
    const people = await until(async () => value(await lead.service.view(), 'view').people.map((item) => item.name), (names) => names.includes('Blake Rivers'), 'the lead sees the new member');
    assert.ok(people.length >= 2);
    const theirs = await until(async () => value(await blake.service.view(), 'view').people.length, (count) => count >= 2, 'the joiner sees the people');
    assert.ok(theirs >= 2);

    // Every grant either computer stores is signed by a person key: the lead's (D-60). The session keys signed none.
    for (const at of [lead, blake]) {
      for (const { signed } of grantsOn({ root: at.root } as never)) {
        const read = readGrant(signed);
        assert.ok(read.ok);
        assert.equal(read.signer.publicKey, lead.personKey, 'a grant is the lead\'s person key\'s');
      }
    }
  } finally {
    await blake.live.stop();
    await lead.live.stop();
    await server.dispose();
  }
});

test('the open handler takes only .near-staff-invite files, fills in the name and expiry, and refuses a file too large to be an invitation', async () => {
  const text = JSON.stringify({ payload: { name: 'Exercise Northwind', expiresAt: '2026-12-01T00:00:00.000Z' } });
  const shown: InvitationOpened[] = [];
  const warnings: string[] = [];
  const handler = new InviteOpenHandler({ read: async () => ({ value: text }), size: async () => text.length }, (fields) => { shown.push(fields); }, (line) => warnings.push(line));
  assert.equal(handler.canHandle({ path: { base: 'inv-1.near-staff-invite' } } as never), 500);
  assert.equal(handler.canHandle({ path: { base: 'notes.md' } } as never), 0);
  await handler.open({ path: { base: 'inv-1.near-staff-invite' } } as never);
  assert.deepEqual(shown, [{ text, name: 'Exercise Northwind', expiresAt: '2026-12-01T00:00:00.000Z' }]);
  assert.deepEqual(invitationFields('not json'), { text: 'not json' });
  const big = new InviteOpenHandler({ read: async () => ({ value: '' }), size: async () => 10 * 1024 * 1024 }, () => assert.fail('not shown'), (line) => warnings.push(line));
  await big.open({ path: { base: 'inv-2.near-staff-invite' } } as never);
  assert.deepEqual(warnings, [INVITE_OPEN_TEXT.tooLarge]);
});

test('a conversion names each product it withheld with its way out (D-31), and the share section\'s trade-off is the engine\'s word for word', async () => {
  assert.equal(STAFF_SHARE_TEXT.tradeOff, engine.HUB_GRANT_TRADE_OFF);
  const lead = await person('withheld', { hosted: false, staff: true });
  try {
    const conversion = { ok: true as const, notices: ['n'], cells: [{ cell: 'c'.repeat(32), label: 'org/Confidential' }], withheld: [{ product: 'logistics-estimate', cell: 'c'.repeat(32) }], unversioned: [] };
    const service = new StaffShareService({ engine: { ...engine, makeMultiUser: async () => conversion } as never, live: () => lead.live, root: async () => lead.root });
    const result = value(await service.turnOn({}), 'turn on');
    assert.deepEqual(result.withheld, ['Some history for logistics-estimate was left out because it refers to a product with a higher label. Ask someone cleared for org/Confidential to make a single-machine copy and share it again.']);
  } finally {
    await lead.live.stop();
  }
});

test('a hosted lead shares staff work that already holds products: each product is converted, with its text, into a part the lead opens (33-30)', async () => {
  const lead = await person('products', { hosted: true, staff: true });
  try {
    await seedStaffWork(lead.root);
    const shared = value(await lead.service.turnOn({ clearance: { ...INTERNAL, level: 'Confidential' } }), 'turn on');
    assert.deepEqual(shared.withheld, []);
    const input = await lead.live.projectionInput(rowOf(lead).project) as { fold: { families: Record<string, unknown> } };
    const texts = (input.fold.families.doc as Array<{ product: string; text: string }> | undefined) ?? [];
    assert.deepEqual(texts.map((item) => item.product).sort(), [SECRET_PRODUCT.product, SEED_PRODUCT.product].sort());
    assert.ok(texts.find((item) => item.product === SEED_PRODUCT.product)?.text.includes('The enemy holds the river crossings.'));
  } finally {
    await lead.live.stop();
  }
});

test('a hosted joiner gets the shared products they are cleared for, as text and as files, and never one above their clearance (33-30)', async (t: TestContext) => {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  const lead = await person('avery-products', { hosted: true, staff: true });
  const blake = await person('blake-products', { hosted: true, staff: false });
  try {
    await seedStaffWork(lead.root);
    value(await lead.service.turnOn({ clearance: { ...INTERNAL, level: 'Confidential' } }), 'turn on');
    value(await lead.service.connectServer({ hubFile: await server.hubFileText(), ceiling: INTERNAL }), 'connect your organization\'s server');
    await until(() => rowOf(lead), (row) => row?.state === 'live', 'the lead live on the server');
    const invited = value(await lead.service.invite({ name: 'Blake Rivers', seat: 'j2-analyst', clearance: INTERNAL }), 'invite');
    value(await blake.service.openInvitation({ text: invited.file?.text as string, name: 'Blake Rivers' }), 'open the invitation');
    const [request] = value(await lead.service.joinRequests(), 'join requests');
    const admitted = value(await lead.service.admit({ request: request.text, codeMatched: true }), 'admit');
    value(await blake.service.openWelcome({ text: admitted.file?.text as string }), 'open the welcome');
    await until(() => rowOf(blake), (row) => row?.state === 'live', 'the joiner live on the server');
    const textsOf = async (who: Person): Promise<Array<{ product: string; text: string }>> => {
      const row = rowOf(who);
      if (row === undefined) return [];
      const input = await who.live.projectionInput(row.project) as { fold: { families: Record<string, unknown> } } | undefined;
      return (input?.fold.families.doc as Array<{ product: string; text: string }> | undefined) ?? [];
    };
    const texts = await until(() => textsOf(blake), (list) => list.some((item) => item.product === SEED_PRODUCT.product), 'the joiner\'s text of the product', 60_000);
    assert.ok(texts.find((item) => item.product === SEED_PRODUCT.product)?.text.includes('The enemy holds the river crossings.'));
    assert.equal(texts.some((item) => item.product === SECRET_PRODUCT.product), false, 'never the Confidential product');
    const file = path.join(blake.root, ...staffProductPath(SEED_PRODUCT.section, SEED_PRODUCT.product).split('/'));
    await until(() => existsSync(file), (found) => found, 'the product file in the joiner\'s folder', 60_000);
  } finally {
    await blake.live.stop();
    await lead.live.stop();
    await server.dispose();
  }
});

// ---- Task 2: server actions on a single machine -------------------------------------------------------------------------------------------------

const UNREACHABLE = '127.0.0.1:9';
const CERT_PIN = 'b'.repeat(64);

function localHubFile(): string {
  const device = rosterDevice('HUB-SOUTH', 'hub');
  const kem = signKemBinding(engine.kemPublicFromSeeds(engine.newKemSeeds()), device.writer, (bytes) => device.signer.sign(bytes));
  return JSON.stringify(buildHubFile(device.signer, {
    address: UNREACHABLE, certPin: CERT_PIN, x25519: device.x25519, x25519Sig: device.x25519Sig, kem, enrolment: 'enr-00112233aabbccdd',
    enrolmentSecret: Buffer.alloc(32, 7).toString('base64url'), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), now: new Date(),
  }));
}

/** A single-machine lead with the project shared and your organization's server admitted (its enrolment unreachable, as offline). */
async function localLead(label: string): Promise<Person> {
  const lead = await person(label, { hosted: false, staff: true });
  value(await lead.service.turnOn({ clearance: INTERNAL }), 'turn on');
  const connected = await lead.service.connectServer({ hubFile: localHubFile(), ceiling: INTERNAL });
  assert.equal(connected.kind, 'refused', 'the enrolment does not reach an unreachable server');
  return lead;
}

test('grant: refused with the trade-off sentence unless confirmed; confirmed, the server holds the part', async () => {
  const lead = await localLead('grant');
  try {
    const made = await ensureLabelCell({ project: projectOf(lead), deps: lead.live.shareContext().deps } as never, 'org/Internal');
    assert.ok(made.ok);
    const part = value(await lead.service.view(), 'view').parts.find((item) => item.label === 'org/Internal');
    assert.ok(part !== undefined && !part.onServer);
    const unconfirmed = await lead.service.grant({ cell: part.cell, confirmed: false });
    assert.equal(unconfirmed.kind, 'refused');
    assert.ok(unconfirmed.kind === 'refused' && unconfirmed.reason.includes(STAFF_SHARE_TEXT.tradeOff), 'the refusal carries the trade-off word for word');
    value(await lead.service.grant({ cell: part.cell, confirmed: true }), 'grant');
    assert.equal(value(await lead.service.view(), 'view').parts.find((item) => item.cell === part.cell)?.onServer, true);
  } finally {
    await lead.live.stop();
  }
});

test('change address keeps the pin and stores the new address; a bad address is refused; revoke writes the revocation', async () => {
  const lead = await localLead('address');
  try {
    const before = value(await lead.service.view(), 'view').server;
    assert.equal(before?.address, UNREACHABLE);
    assert.equal((await lead.service.changeAddress({ address: 'not an address' })).kind, 'refused');
    value(await lead.service.changeAddress({ address: '127.0.0.1:10' }), 'change address');
    const after = value(await lead.service.view(), 'view').server;
    assert.equal(after?.address, '127.0.0.1:10');
    assert.deepEqual(after?.words, serverPinWords(CERT_PIN), 'the pin, and so its twelve words, did not change');
    value(await lead.service.revoke(), 'revoke');
    assert.equal(value(await lead.service.view(), 'view').server?.standing, 'revoked');
  } finally {
    await lead.live.stop();
  }
});

test('re-admit: words that differ are refused and nothing is written; the twelve words of the pin write hub.readmit', async () => {
  const lead = await localLead('readmit');
  try {
    const positions = async (): Promise<number> => (await projectOf(lead).state()).roster.positions.length;
    const before = await positions();
    const wrong = await lead.service.readmit({ words: serverPinWords('c'.repeat(64)).join(' ') });
    assert.equal(wrong.kind, 'refused');
    assert.equal(await positions(), before);
    value(await lead.service.readmit({ words: serverPinWords(CERT_PIN).join(' ') }), 'readmit');
    assert.equal(await positions(), before + 1);
  } finally {
    await lead.live.stop();
  }
});

test('single-machine copy makes the copy and names what it left out; "Show others what I am working on" is on by default and kept per person', async () => {
  const lead = await localLead('copy');
  try {
    const destination = path.join(mkdtempSync(path.join(tmpdir(), 'sterling-share-copy-')), 'copy');
    const copied = value(await lead.service.singleCopy({ destination }), 'copy');
    assert.match(copied.message, /single-machine copy is ready/);
    assert.ok(copied.notices.length > 0, 'the copy names what it carried and left');
    assert.equal(value(await lead.service.view(), 'view').showWork, true);
    assert.equal(value(await lead.service.setShowWork(false), 'off'), false);
    assert.equal(await lead.secrets.get(SHOW_WORK_SECRET), '0');
    assert.equal(value(await lead.service.view(), 'view').showWork, false);
  } finally {
    await lead.live.stop();
  }
});

test('a 0.4.35 preview project, its products in the base cell, is refused with its way out and never converted in place (D-48)', async () => {
  const lead = await person('preview', { hosted: false, staff: true });
  try {
    value(await lead.service.turnOn({ clearance: INTERNAL }), 'turn on');
    // The 0.4.35 preview wrote products into the base cell, which the server must read.
    const written = await projectOf(lead).appendOwn('product.create', { product: 'fuel-estimate', section: 'j4', roles: { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' }, title: 'Fuel estimate' });
    assert.ok('ok' in written);
    const positions = (await projectOf(lead).state()).roster.positions.length;
    const refused = await lead.service.connectServer({ hubFile: localHubFile(), ceiling: INTERNAL });
    assert.equal(refused.kind, 'refused');
    assert.match(refused.kind === 'refused' ? refused.reason : '', /Make a single-machine copy and make that copy multi-user again/);
    assert.equal((await projectOf(lead).state()).roster.positions.length, positions, 'nothing was written');
    assert.equal(value(await lead.service.view(), 'view').server, undefined);
  } finally {
    await lead.live.stop();
  }
});

test('managed hosted Workbench removal challenges the exact current operation before any engine write', async () => {
  let instant = 1_800_000_000_000;
  const acr = 'urn:sterling:acr:phishing-resistant';
  const actions = createPendingActions({ stepUpAcr: acr, windowSeconds: 60, latestAuthTime: () => instant / 1000, clock: { now: () => instant } });
  let selected = 'a'.repeat(64);
  let actor = 'b'.repeat(64);
  let hosted = true;
  let required = ['cell-access@1'];
  const projectId = 'd'.repeat(32);
  const member = 'mbr-fictional';
  const root = '/fictional-managed-share';
  const secrets = new MemorySecrets();
  let synced = 0;
  const writes: { target: string; action?: string }[] = [];
  const project = {
    projectId, get deviceWriter() { return actor; },
    state: async () => ({ roster: { positions: [selected], required, members: {} }, fold: {} })
  };
  const wiring = {
    engine: {
      ...engine,
      isRosterWriterAt: () => true,
      memberAt: (_state: never, target: string) => ({ name: target === member ? 'Mo Analyst' : 'Nell Planner' }),
      managedWithdrawalActionBytes: (roster: { positions: readonly string[] }, writer: string, input: { member: string }) =>
        Buffer.from(JSON.stringify([projectId, roster.positions.at(-1), writer, input.member])),
      removeFromProject: async (_shared: never, input: { member: string }, action?: string) => {
        writes.push({ target: input.member, action });
        return { ok: true, message: 'Fictional withdrawal committed.', notices: [] };
      }
    } as never,
    live: () => ({
      projects: () => [{ root, project: projectId }], project: () => project,
      shareContext: () => ({ deps: {}, secrets, globalStorageDir: root, ...(hosted ? { hosted: {} } : {}) }),
      syncNow: () => { synced += 1; }
    }) as never,
    root: async () => root, actions
  };
  const service = new StaffShareService(wiring);
  const challenge = async () => {
    const answer = value(await service.remove({ member }), 'request withdrawal confirmation');
    const pending = answer.confirmation;
    assert.ok(pending, 'a hosted managed request returns a challenge before calling the writer');
    const nonce = pending.url.split('/').at(-1);
    assert.ok(nonce);
    assert.deepEqual(actions.summaryOf(nonce)?.fields, [{ label: 'Person', value: 'Mo Analyst' }]);
    assert.equal((await service.remove({ member, requestId: pending.requestId })).kind, 'refused');
    instant += 1000;
    assert.equal(actions.bindStepUp(nonce, { acr, authTime: instant / 1000, sub: 'fictional', activeSub: 'fictional' }), true);
    return pending;
  };

  const first = await challenge();
  assert.equal(writes.length, 0);
  assert.equal(synced, 0);
  const wrongMember = { member: 'mbr-other-fictional', requestId: first.requestId };
  assert.equal((await service.remove(wrongMember)).kind, 'refused');
  actor = 'f'.repeat(64);
  assert.equal((await service.remove({ member, requestId: first.requestId })).kind, 'refused');
  actor = 'b'.repeat(64);
  selected = 'c'.repeat(64);
  const stale = { member, requestId: first.requestId };
  assert.equal((await service.remove(stale)).kind, 'refused');
  assert.equal(writes.length, 0);
  assert.equal(synced, 0);

  const current = await challenge();
  const resume = { member, requestId: current.requestId };
  assert.equal((await service.remove(resume)).kind, 'ok');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, member);
  assert.equal(typeof writes[0].action, 'string');
  assert.equal((await service.remove(resume)).kind, 'refused');
  assert.equal(writes.length, 1);
  assert.equal(synced, 1);

  hosted = false;
  assert.equal((await service.remove(resume)).kind, 'refused');
  const local = value(await service.remove({ member }), 'local withdrawal');
  assert.equal(local.confirmation, undefined);
  assert.deepEqual(writes[1], { target: member, action: undefined });
  hosted = true;
  required = [];
  const legacy = value(await service.remove({ member }), 'legacy hosted withdrawal');
  assert.equal(legacy.confirmation, undefined);
  assert.deepEqual(writes[2], { target: member, action: undefined });
  assert.equal(synced, 3);
});

test('managed Workbench Finish reviews one private draft and never falls back on a stale request', async () => {
  let instant = 1_800_000_000_000;
  const acr = 'urn:sterling:acr:phishing-resistant';
  const actions = createPendingActions({ stepUpAcr: acr, windowSeconds: 60, latestAuthTime: () => instant / 1000, clock: { now: () => instant } });
  const projectId = 'd'.repeat(32);
  const cell = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const root = '/fictional-finish-share';
  const secrets = new MemorySecrets();
  let selected = 'first';
  let authority = true;
  let signer = fixedSigner('fixture-finish-person').signer;
  let synced = 0;
  let prepares = 0;
  let refuseCommit = false;
  const writes: { cell: string; action: string }[] = [];
  const resolved = new Set<string>();
  const project = { projectId, deviceWriter: 'c'.repeat(64), state: async () => ({
    roster: { positions: [selected], required: ['cell-access@1'], members: { members: new Map(), devices: new Map() } }, fold: {}
  }) };
  let liveProject = project;
  const live = {
    projects: () => [{ root, project: projectId }], project: () => liveProject,
    shareContext: () => ({ deps: {}, secrets, globalStorageDir: root, hosted: { keys: { personSigner: signer } } }),
    syncNow: () => { synced += 1; }
  };
  const wiring = {
    live: () => live as never, root: async () => root, now: () => new Date(instant), actions,
    engine: {
      ...engine,
      isRosterWriterAt: () => authority,
      hubStanding: async () => [],
      cellsAt: () => [],
      pendingWorkbenchFinishParts: () => [{ cell, label: 'Protected A' }, { cell: other, label: 'Protected B' }]
        .filter(({ cell: target }) => !resolved.has(target)),
      prepareWorkbenchFinish: (_host: never, roster: { positions: string[] }, target: string) => {
        prepares += 1;
        if (resolved.has(target)) return undefined;
        const label = target === cell ? 'Protected A' : 'Protected B';
        const preview = Buffer.from(JSON.stringify([roster.positions.at(-1), target, 'private-fictional-draft']));
        return { label, currentBytes: (_current: never, fresh: { positions: string[] }) =>
          fresh.positions.at(-1) === roster.positions.at(-1) ? Buffer.from(preview) : undefined,
        async commit(_current: never, action: string) {
          assert.equal(actions.authorizePayload(action, preview), true);
          writes.push({ cell: target, action });
          if (refuseCommit) return { ok: false, reason: 'action-required', message: 'Mock expiry.', notices: [] };
          resolved.add(target);
          return { ok: true, message: 'Fictional Finish committed.', notices: [] };
        } };
      }
    } as never
  };
  const service = new StaffShareService(wiring);
  const call = (on: StaffShareService, target: string, requestId?: string) =>
    on.finishKeyChange({ cell: target, ...(requestId === undefined ? {} : { requestId }) });
  const challenge = async (target = cell) => {
    const response = value(await call(service, target), 'request one Finish confirmation');
    const pending = response.confirmation;
    assert.ok(pending);
    assert.deepEqual(Object.keys(pending).sort(), ['requestId', 'url']);
    assert.equal(JSON.stringify(response).includes('private-fictional-draft'), false);
    const nonce = pending.url.split('/').at(-1);
    assert.ok(nonce);
    assert.deepEqual(actions.summaryOf(nonce), { kind: 'cell.rekey.finish', fields: [{ label: 'Part', value: target === cell ? 'Protected A' : 'Protected B' }] });
    return { pending, nonce };
  };
  const bind = (nonce: string) => {
    instant += 1000;
    assert.equal(actions.bindStepUp(nonce, { acr, authTime: instant / 1000, sub: 'fictional', activeSub: 'fictional' }), true);
  };
  assert.deepEqual(value(await service.view(), 'lead pending parts').keyChanges, [
    { cell, label: 'Protected A' }, { cell: other, label: 'Protected B' }
  ]);
  const first = await challenge();
  assert.equal((await call(service, cell, first.pending.requestId)).kind, 'refused', 'an early return cannot sign');
  bind(first.nonce);
  assert.equal((await call(service, other, first.pending.requestId)).kind, 'refused');
  assert.equal((await call(new StaffShareService(wiring), cell, first.pending.requestId)).kind, 'refused', 'a backend restart drops the draft');
  selected = 'changed';
  assert.equal((await call(service, cell, first.pending.requestId)).kind, 'refused');

  const replaced = await challenge();
  bind(replaced.nonce);
  signer = fixedSigner('different-fixture-finish-person').signer;
  assert.equal((await call(service, cell, replaced.pending.requestId)).kind, 'refused');
  const replacedProject = await challenge();
  bind(replacedProject.nonce);
  liveProject = { ...project };
  assert.equal((await call(service, cell, replacedProject.pending.requestId)).kind, 'refused');
  liveProject = project;
  const supersededByOtherAction = await challenge();
  actions.beginAction(Buffer.from('different action'), { kind: 'member.remove', fields: [] });
  assert.equal(actions.summaryOf(supersededByOtherAction.nonce), undefined);
  assert.equal((await call(service, cell, supersededByOtherAction.pending.requestId)).kind, 'refused');
  const canceled = await challenge();
  const current = await challenge(other);
  assert.equal((await call(service, cell, canceled.pending.requestId)).kind, 'refused');
  bind(current.nonce);
  instant += 61_000;
  assert.equal((await call(service, other, current.pending.requestId)).kind, 'refused');
  assert.equal(writes.length, 0);
  assert.equal(synced, 0);

  const checked = await challenge();
  bind(checked.nonce);
  authority = false;
  assert.equal(value(await service.view(), 'non-lead pending parts').keyChanges, undefined);
  assert.equal((await call(service, cell, checked.pending.requestId)).kind, 'refused');
  authority = true;
  refuseCommit = true;
  const expiring = await challenge();
  bind(expiring.nonce);
  const beforeResume = prepares;
  assert.equal((await call(service, cell, expiring.pending.requestId)).kind, 'refused');
  assert.equal((await call(service, cell, expiring.pending.requestId)).kind, 'refused');
  assert.equal(prepares, beforeResume, 'a failed resume never generates another draft');
  assert.equal(writes.length, 1);
  assert.equal(synced, 0);
  refuseCommit = false;
  const renewed = await challenge();
  bind(renewed.nonce);
  assert.equal((await call(service, cell, renewed.pending.requestId)).kind, 'ok');
  assert.equal(actions.reviewAttachment(renewed.pending.requestId), undefined);
  assert.deepEqual(value(await service.view(), 'remaining pending part').keyChanges, [{ cell: other, label: 'Protected B' }]);
  assert.equal((await call(service, cell, renewed.pending.requestId)).kind, 'refused');
  assert.equal((await call(service, other, renewed.pending.requestId)).kind, 'refused');
  assert.deepEqual(writes.map((write) => write.cell), [cell, cell]);
  assert.equal(synced, 1);
});

test('Share file save and open stay bound to the selected project and exact recipient', async () => {
  const root = '/fictional-managed-files';
  const projectId = 'd'.repeat(32);
  const part = 'a'.repeat(32);
  const recipient = 'b'.repeat(64);
  const repeat = 'c'.repeat(64);
  const text = '{"handle":"fictional","packet":"ciphertext-only"}';
  const calls: string[] = [];
  let lead = true;
  let activeRoot = root;
  let switchWhileSaving = false;
  const project = { projectId, deviceWriter: 'e'.repeat(64), state: async () => ({
    roster: { positions: ['selected'], required: ['cell-access@1'], members: {} }, fold: {}
  }) };
  const live = { projects: () => [{ root, project: projectId }], project: () => project,
    shareContext: () => ({ deps: {}, secrets: new MemorySecrets(), globalStorageDir: root }), syncNow: () => undefined };
  const service = new StaffShareService({
    live: () => live as never, root: async () => activeRoot,
    engine: { ...engine, isRosterWriterAt: () => lead,
      exportWorkbenchManagedFile: async (_host: never, cell: string, target: string, prior?: string) => {
        calls.push('save');
        if (cell !== part || target !== recipient || (prior !== undefined && prior !== repeat)) return undefined;
        if (switchWhileSaving) activeRoot = '/fictional-different-project';
        return { name: 'shared-keys.near-staff-keys', text, repeat };
      },
      openWorkbenchManagedFile: async (_host: never, file: string) => {
        calls.push('open');
        return file === text ? { ok: true, message: 'Fictional private file checked.', notices: [] } :
          { ok: false, message: 'Fictional file refused.', notices: [] };
      }
    } as never
  });
  assert.equal((await service.saveManagedKeys({ project: 'wrong', cell: part, recipient })).kind, 'refused');
  assert.equal((await service.openManagedKeys({ project: 'wrong', text })).kind, 'refused');
  assert.equal(calls.length, 0);
  const saved = value(await service.saveManagedKeys({ project: projectId, cell: part, recipient }), 'save exact managed file');
  assert.deepEqual(saved.file, { name: 'shared-keys.near-staff-keys', text });
  assert.equal(saved.fileRepeat, repeat);
  const again = value(await service.saveManagedKeys({ project: projectId, cell: part, recipient, repeat }), 'repeat exact file');
  assert.deepEqual(again.file, saved.file);
  assert.equal((await service.saveManagedKeys({ project: projectId, cell: part, recipient: 'f'.repeat(64), repeat })).kind, 'refused');
  switchWhileSaving = true;
  assert.equal((await service.saveManagedKeys({ project: projectId, cell: part, recipient, repeat })).kind, 'refused');
  activeRoot = root;
  switchWhileSaving = false;
  lead = false;
  assert.equal((await service.saveManagedKeys({ project: projectId, cell: part, recipient })).kind, 'refused');
  assert.equal((await service.openManagedKeys({ project: projectId, text })).kind, 'ok');
  assert.equal((await service.openManagedKeys({ project: projectId, text: '{}' })).kind, 'refused');
  assert.deepEqual(calls, ['save', 'save', 'save', 'save', 'open', 'open']);
});

test('a hosted person key without a fresh confirmation signs nothing: the action is refused with the Staff Room sentence and its fix', async () => {
  const lead = await person('stale', { hosted: true, staff: true });
  try {
    lead.stale = true;
    const refused: ServiceResult<ShareOutcome> = await lead.service.turnOn({ clearance: INTERNAL });
    assert.deepEqual(refused, { kind: 'refused', reason: SESSION_KEY_TEXT.stepUp, fix: KEY_SERVICE_TEXT.confirm });
    assert.equal(value(await lead.service.view(), 'view').state, 'not-shared', 'nothing was shared');
    assert.equal(existsSync(path.join(lead.root, '.planning', 'staff', 'replica')), false);
  } finally {
    await lead.live.stop();
  }
});

test('a folder without a staff project offers nothing to share, and a lead action on work that is not open is refused', async () => {
  const empty = await person('empty', { hosted: false, staff: false });
  try {
    assert.equal(value(await empty.service.view(), 'view').state, 'no-project');
    assert.deepEqual(await empty.service.turnOn({}), { kind: 'refused', reason: STAFF_SHARE_TEXT.noProject });
    assert.deepEqual(await empty.service.invite({ name: 'Casey Stone', seat: 'j4-planner', clearance: INTERNAL }), { kind: 'refused', reason: STAFF_SHARE_TEXT.notOpen });
  } finally {
    await empty.live.stop();
  }
});
