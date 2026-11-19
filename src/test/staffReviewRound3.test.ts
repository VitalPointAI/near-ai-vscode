// Review round 3 of drop 1: a person's decision counts only with a signed decision-log entry; register writes take a per-register lock and re-read
// inside it; a header is written over the body as it is on disk under the ledger lock, never over a body read before the append.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { parseRegisterText, registerPath, renderRegister, trustPirDecisions } from '../domain/staff/intel';
import type { PirEntry } from '../domain/staff/intel';
import { parseRegisterBody, REGISTER_SCHEMAS } from '../domain/staff/registers';
import { DECISION_LOG_FILE, pirWording, replayPersonDecisions } from '../domain/staff/personDecisions';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import { LEDGER_DIR, productPath } from '../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J2_TEAM, J3_TEAM, J5_TEAM, staffWorld, testSigner, trusting, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const REGISTER = 'mcp__staff-products__register';
const T = '2026-11-18T12:00:00.000Z';

function pir(status: PirEntry['status']): PirEntry {
  return {
    id: 'PIR-1', requirement: 'Will the adversary cross?', decisionPoint: 'DP 2', ltiov: '2026-11-19T06:00:00.000Z', indicators: [{ id: 'IND-1', text: 'Bridging seen' }],
    status, requestedBy: 'j3', answeredBy: [], label: 'org/Internal', addedBy: 'requirements-manager'
  } as unknown as PirEntry;
}

async function writePirRegister(world: StaffWorld, entries: PirEntry[]): Promise<string> {
  const file = path.join(world.root, registerPath('pir-register'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderRegister('pir-register', entries));
  return file;
}

test('a PIR decision counts only with a signed entry by the person it names, on the wording decided; the host records one only through decidePir', async () => {
  const world = await staffWorld();
  const person = world.person('Exercise Commander', 'commander');
  const file = await writePirRegister(world, [pir('awaiting-decision')]);
  // A decision block written straight into the file is not decided.
  const forged = { ...pir('approved'), decision: { decision: 'approved', by: person, at: T } } as PirEntry;
  const unproven = trustPirDecisions([forged], await world.host.pirDecisions());
  assert.equal(unproven.entries[0].status, 'awaiting-decision');
  assert.equal(unproven.entries[0].decision, undefined);
  assert.equal(unproven.findings[0].rule, 'decision-unrecorded');
  // An agent can never be the decider, and an unnamed person is refused.
  assert.equal((await world.host.decidePir({ ...person, name: '' }, { pir: 'PIR-1', decision: 'approved' })).ok, false);
  assert.equal((await world.host.decidePir(person, { pir: 'PIR-1', decision: 'rejected' })).ok, false, 'a rejection needs reasons');
  const decided = await world.host.decidePir(person, { pir: 'PIR-1', decision: 'approved' });
  assert.ok(decided.ok, decided.ok ? '' : decided.message);
  const stored = parseRegisterText('pir-register', await readFile(file, 'utf8'));
  assert.ok(stored.ok);
  if (!stored.ok) return;
  const proven = trustPirDecisions(stored.value, await world.host.pirDecisions());
  assert.equal(proven.entries[0].status, 'approved');
  assert.deepEqual(proven.findings, []);
  // The same decision under another person's name, or after a wording change, is not the one recorded.
  assert.equal(trustPirDecisions([{ ...stored.value[0], decision: { ...stored.value[0].decision!, by: { ...person, name: 'Someone Else' } } }], await world.host.pirDecisions()).entries[0].status, 'awaiting-decision');
  assert.equal(trustPirDecisions([{ ...stored.value[0], requirement: 'Changed?' }], await world.host.pirDecisions()).entries[0].status, 'awaiting-decision');
});

test('the decision log is signed and chained: an entry signed by a key that is not the named person\'s, or a line changed by hand, proves nothing', async () => {
  const world = await staffWorld();
  const person = world.person('Exercise Commander', 'commander');
  await writePirRegister(world, [pir('awaiting-decision')]);
  assert.ok((await world.host.decidePir(person, { pir: 'PIR-1', decision: 'approved' })).ok);
  const log = path.join(world.root, LEDGER_DIR, DECISION_LOG_FILE);
  const line = (await readFile(log, 'utf8')).trim();
  // A line rewritten by hand (the decision flipped) breaks the signature.
  await writeFile(log, `${line.replace('"approved"', '"rejected"')}\n`);
  assert.equal((await world.host.pirDecisions()).size, 0);
  // A well-formed entry signed by another key, naming this person: the signer is not the person named.
  const other = testSigner();
  const entry = { v: 1, seq: 0, prev: '0'.repeat(64), at: T, subject: { kind: 'pir', id: 'PIR-1' }, decision: 'approved', wording: pirWording(pir('awaiting-decision')), reasons: [], person };
  const envelope = signPayload(other, 'staff-decision', entry, { now: () => new Date(T) });
  const replay = replayPersonDecisions([envelope], (value) => verifyPayload(value, { purpose: 'staff-decision', status: trusting(other) }));
  assert.equal(replay.decisions.size, 0);
  assert.match(replay.broken?.reason ?? '', /key other than the one of the person/);
  await writeFile(log, `${JSON.stringify(envelope)}\n`);
  assert.equal((await world.host.pirDecisions()).size, 0, 'an untrusted key proves nothing either');
  await appendFile(log, 'junk\n');
  assert.equal((await world.host.pirDecisions()).size, 0);
});

test('two part writers of the CCIR register at the same moment keep each other\'s rows', async () => {
  const world = await staffWorld();
  const ffir = { id: 'F1', type: 'ffir', requirement: 'Loss of the bridge', decisionPoint: 'DP2', status: 'active', reportTo: 'commander' };
  assert.ok((await callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'ccir-register', rows: [ffir] }, 'j3-director')).ok);
  const pirRow = { id: 'P1', type: 'pir', requirement: 'Will the reserve cross?', decisionPoint: 'DP1', ltiov: '2026-11-19T06:00Z', status: 'proposed' };
  const ffir2 = { ...ffir, id: 'F2', requirement: 'Loss of the port' };
  const [a, b] = await Promise.all([
    callTool(world, J2_TEAM, REGISTER, { action: 'write', register: 'ccir-register', part: 'pir', rows: [pirRow] }, 'requirements-manager'),
    callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'ccir-register', part: 'ffir', rows: [ffir, ffir2] }, 'j3-director')
  ]);
  assert.ok(a.ok, a.text);
  assert.ok(b.ok, b.text);
  const text = await readFile(path.join(world.root, productPath('j3', 'ccir-register')), 'utf8');
  const rows = parseRegisterBody(REGISTER_SCHEMAS['ccir-register'], text.replace(/^---[\s\S]*?\n---\n/, '')) ?? [];
  assert.deepEqual(rows.map((row) => row.id).sort(), ['F1', 'F2', 'P1'], 'neither writer dropped the other\'s rows');
  assert.equal((await world.host.replay()).broken, undefined);
});

test('propose writes the header over the body as it is on disk, so a member\'s write that lands in between is kept as the next edit', async () => {
  const world = await staffWorld();
  await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const later = `${CLEAN_BODY}\nA paragraph written while the propose was recording.\n`;
  // The member's second write lands after the ledger append (which recorded the first body) and before the header is written.
  const host = world.host as unknown as { append: (...args: unknown[]) => Promise<unknown> };
  const original = host.append.bind(world.host);
  let wrote = false;
  host.append = async (...args: unknown[]) => {
    const result = await original(...args);
    if (!wrote) { wrote = true; await writeBody(world.root, 'j5', 'concept-of-operations', later); }
    return result;
  };
  const first = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  assert.ok(first.ok, first.text);
  const onDisk = await readFile(path.join(world.root, productPath('j5', 'concept-of-operations')), 'utf8');
  assert.match(onDisk, /A paragraph written while the propose was recording\./, 'the later body is not overwritten');
  const status = await callTool(world, J5_TEAM, 'mcp__staff-products__status', { product: 'concept-of-operations' }, 'lead-planner');
  assert.match(status.text, /The file changed since version 1/, 'it reads as the next pending edit');
  assert.ok(hashIn(first.text));
});
