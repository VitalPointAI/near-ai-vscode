import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { GENESIS_PREV, chainLine, type ChainLine } from '../domain/gate/auditChain';
import { parseOnboardingSection } from '../domain/gate/sections';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { buildAbandonedRecord, buildGuideRecord, buildScanRecord, snapshotOf } from '../domain/setup/guideRecord';
import { createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS, type AuditEventId } from '../domain/setup/records';
import { canonicalize } from '../domain/team/canonical';
import { projectLogKey } from '../gate/decisionLog';
import { MAX_SETUP_RECORD_BYTES, MAX_SETUP_ROTATED_FILES, SETUP_AUDIT_TEXT, SetupAuditLog } from '../gate/setupAuditLog';
import { recordedModelName } from '../gate/sessionMark';

const EVENT = 'setup.guide.applied';
const NOW = Date.UTC(2026, 10, 22);
const ANSWERS = { kindOfWork: 'software', data: ['public'], canada: 'no', agentWork: 'agents' } as const;
const GUIDE_INPUT = {
  answers: ANSWERS,
  proposedLabel: { scale: 'org', level: 'Public' },
  use: 'T1', residency: { narrowed: false },
  viability: [
    { optionId: 'this-computer', kind: 'this-computer', state: 'viable', models: [], checkedAt: NOW, hostKind: 'desktop' },
    { optionId: 'near-private', kind: 'near-private', state: 'not-detected', models: [], hostKind: 'desktop' },
  ],
  policy: { organization: 'a'.repeat(64) },
  options: [{ optionId: 'this-computer', outcome: 'viable' }],
  recommendation: { optionId: 'this-computer', reasonId: 'local-available' },
  choice: ['this-computer'], changes: [{ id: 'label', outcome: 'done' }], hostKind: 'desktop',
} as const;

async function fixture() {
  const storage = await mkdtemp(path.join(tmpdir(), 'setup-audit-'));
  const key = projectLogKey(path.join(storage, 'project'));
  const registry = createAuditEventRegistry();
  for (const spec of GUIDE_AUDIT_EVENT_SPECS) registry.register(spec);
  const dir = path.join(storage, 'gate', 'setup');
  const file = path.join(dir, `${key}.jsonl`);
  return { storage, key, registry, dir, file, head: path.join(dir, `${key}.head.json`) };
}

async function linesOf(file: string): Promise<ChainLine[]> {
  return (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as ChainLine);
}

test('D-19: one Apply, one chained record', async () => {
  const { storage, key, registry, file } = await fixture();
  const log = new SetupAuditLog({ globalStorageDir: storage, projectKey: key, registry, onWriteFailure: assert.fail, clock: () => NOW });
  const body = buildGuideRecord(GUIDE_INPUT);
  const first = await log.append(EVENT, body);
  const second = await log.append(EVENT, body);
  const [one, two] = await linesOf(file);
  assert.deepEqual(first, { ok: true, id: one.hash.slice(0, 16), seq: 1 });
  assert.deepEqual(second, { ok: true, id: two.hash.slice(0, 16), seq: 2 });
  assert.equal(two.prev, one.hash);
  assert.deepEqual(await log.verify(), { ok: true, head: { seq: 2, hash: two.hash } });
});

test('D-35: the hash covers the previous hash and all canonical record metadata', () => {
  const prev = '0'.repeat(64);
  const at = new Date(NOW).toISOString();
  const body = { z: 2, a: 'one' };
  const expected = createHash('sha256').update(prev + canonicalize({ seq: 1, event: EVENT, at, body })).digest('hex');
  assert.equal(GENESIS_PREV, prev);
  assert.deepEqual(chainLine(prev, 1, EVENT, at, body), { seq: 1, prev, hash: expected, event: EVENT, at, body });
});

test('an unknown id, an unregistered id and an unknown body key are refused before writing', async () => {
  const { storage, key, registry, file } = await fixture();
  const log = new SetupAuditLog({ globalStorageDir: storage, projectKey: key, registry, onWriteFailure: () => {} });
  const body = buildGuideRecord(GUIDE_INPUT);
  assert.equal((await log.append(EVENT, body)).ok, true);
  const original = await readFile(file, 'utf8');
  assert.equal((await log.append('setup.unknown' as AuditEventId, body)).ok, false);
  assert.equal((await log.append('local-models.installed', body)).ok, false);
  assert.equal((await log.append(EVENT, { ...body, unknown: 'extra' })).ok, false);
  assert.equal(await readFile(file, 'utf8'), original);
});

async function populated(count: number, maxBytes?: number) {
  const f = await fixture();
  const options = { globalStorageDir: f.storage, projectKey: f.key, registry: f.registry, onWriteFailure: () => {}, maxBytes };
  const log = new SetupAuditLog(options);
  const body = buildGuideRecord(GUIDE_INPUT);
  for (let i = 0; i < count; i += 1) assert.equal((await log.append(EVENT, body)).ok, true);
  return { ...f, options, log, body };
}

function writeLines(file: string, lines: readonly ChainLine[]) {
  return writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

const edits = [
  { name: 'edited body', at: 2, why: 'hash', edit: ([one, two, three]: ChainLine[]) => [one, { ...two, body: { hostKind: 'remote' } }, three] },
  { name: 'reordered records', at: 2, why: 'seq', edit: ([one, two, three]: ChainLine[]) => [one, three, two] },
  { name: 'missing middle record', at: 2, why: 'seq', edit: ([one, , three]: ChainLine[]) => [one, three] },
  { name: 'changed previous hash', at: 3, why: 'prev', edit: ([one, two, three]: ChainLine[]) => [one, two, { ...three, prev: GENESIS_PREV }] },
] as const;

for (const { name, at, why, edit } of edits) {
  test(`Pitfall 16: detects ${name}`, async () => {
    const { log, file } = await populated(3);
    await writeLines(file, edit(await linesOf(file)));
    assert.deepEqual(await log.verify(), { ok: false, at, why });
  });
}

test('Pitfall 16: a kept head detects a missing tail', async () => {
  const { log, dir, file, head } = await populated(3);
  const lines = await linesOf(file);
  await writeLines(file, lines.slice(0, 2));
  assert.deepEqual(await log.verify(), { ok: false, at: 3, why: 'truncated' });
  await rename(head, path.join(dir, 'saved.head.json'));
  assert.deepEqual(await log.verify(), { ok: true, head: { seq: 2, hash: lines[1].hash } });
  const source = await readFile(path.resolve(__dirname, '../../src/gate/setupAuditLog.ts'), 'utf8');
  assert.match(source, /cutting both the tail and the head/);
});

test('rotation carries prev and keeps exactly four older files when the log fills', async () => {
  const { log, file, dir, key, head } = await populated(9, 1);
  const archives = (await readdir(dir)).filter((name) => name.endsWith('.jsonl') && name !== `${key}.jsonl`);
  assert.equal(archives.length, MAX_SETUP_ROTATED_FILES);
  const previous = (await linesOf(path.join(dir, `${key}.1.jsonl`))).at(-1)!;
  const [current] = await linesOf(file);
  assert.equal(current.seq, previous.seq + 1);
  assert.equal(current.prev, previous.hash);
  assert.deepEqual(JSON.parse(await readFile(head, 'utf8')), { seq: 9, hash: current.hash, start: { seq: previous.seq, prev: previous.hash } });
  assert.deepEqual(await log.latest(), { seq: 9, hash: current.hash });
  const rotated = path.join(dir, `${key}.2.jsonl`);
  const [line] = await linesOf(rotated);
  await writeLines(rotated, [{ ...line, body: { hostKind: 'remote' } }]);
  assert.deepEqual(await log.verify(), { ok: false, at: line.seq, why: 'hash' });
});

test('parallel appends from two writer instances leave consecutive sequence numbers', async () => {
  const { log, options, body, file } = await populated(0);
  const second = new SetupAuditLog(options);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? second : log).append(EVENT, body)));
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results.map(({ seq }) => seq).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  const lines = await linesOf(file);
  assert.deepEqual(lines.map(({ seq }) => seq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok((await log.verify()).ok);
});

test('oversized records do not write any lines', async () => {
  const { log, body, file } = await populated(0);
  const changes = Array.from({ length: MAX_SETUP_RECORD_BYTES / 32 }, () => ({ id: 'model', outcome: 'done' }));
  assert.deepEqual(await log.append(EVENT, { ...body, changes }), { ok: false, reason: 'record-too-large' });
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('a write failure reports the plain message once and never rejects', async () => {
  const { dir, options, body } = await populated(0);
  await mkdir(path.dirname(dir), { recursive: true });
  await writeFile(dir, 'Blocks the directory for all install users.');
  const failures: string[] = [];
  const log = new SetupAuditLog({ ...options, onWriteFailure: (message) => { failures.push(message); throw new Error('Callback failed'); } });
  for (let i = 0; i < 3; i += 1) assert.equal((await log.append(EVENT, body)).ok, false);
  assert.deepEqual(failures, [SETUP_AUDIT_TEXT.writeFailed]);
});

test('log and head are private on systems with POSIX mode bits', { skip: process.platform === 'win32' && 'Windows does not use POSIX mode bits' }, async () => {
  const { file, head } = await populated(1);
  for (const name of [file, head]) assert.equal((await stat(name)).mode & 0o777, 0o600);
});

test('a refused append does not extend a broken chain', async () => {
  const { log, file, body } = await populated(2);
  const [first] = await linesOf(file);
  await writeLines(file, [first]);
  assert.deepEqual(await log.append(EVENT, body), { ok: false, reason: 'truncated' });
  assert.deepEqual(await linesOf(file), [first]);
});

test('a retry after rotation moved the file but before the next append keeps the chain', async () => {
  const { dir, file, key, head, body, log, options } = await populated(1, 1);
  const [record] = await linesOf(file);
  await writeFile(head, JSON.stringify({ seq: record.seq, hash: record.hash, start: { seq: record.seq, prev: record.hash } }));
  await rename(file, path.join(dir, `${key}.1.jsonl`));
  assert.equal((await log.verify()).ok, true);
  const retry = new SetupAuditLog(options);
  assert.equal((await retry.append(EVENT, body)).ok, true);
  assert.equal((await linesOf(file))[0].prev, record.hash);
  assert.equal((await retry.latest())?.seq, 2);
});

test('SC5: caps and redacts text, and excludes hosts and paths from the viability snapshot', async () => {
  const fakeKey = `sk-${'f'.repeat(24)}`; // secret-scan: allow (fictional fixture)
  const host = 'server.example.org';
  const modelPath = '/model-store/example.gguf';
  const hash = 'b'.repeat(64);
  const input = {
    ...GUIDE_INPUT,
    answers: { ...ANSWERS, kindOfWork: 'something-else', otherKind: `analysis ${'a'.repeat(80)}` } as const,
    choiceReason: `Used ${fakeKey} on https://${host}/v1 and ${modelPath}. ${'a'.repeat(300)}`,
    viability: [{
      ...GUIDE_INPUT.viability[0],
      routeFacts: { clientRoute: 'local', host, model: { id: modelPath } } as const,
      server: { kind: 'ollama', version: '1'.repeat(42) } as const,
      models: [{ id: modelPath, sha256: hash }, { id: 'example:latest', sha256: 'invalid' }],
    }, { ...GUIDE_INPUT.viability[1], reasonCode: 'not-detected' } as const],
    proposals: ['proposal-1'], authorizations: ['authorization-1'],
  };
  const body = buildGuideRecord(input);
  assert.match(body.choiceReason ?? '', /\[REDACTED\]/);
  assert.equal(body.choiceReason?.length, 200);
  assert.equal(body.kindOfWorkText?.length, 60);
  const serialized = JSON.stringify(body);
  for (const value of [fakeKey, host, '://', '/model-store', 'otherKind']) assert.ok(!serialized.includes(value), `unexpected location or text: ${value}`);
  assert.deepEqual(body.viability, [{
    optionId: 'this-computer', state: 'viable', serverKind: 'ollama', serverVersion: '1'.repeat(40),
    models: [{ id: 'example.gguf', sha256: hash }, { id: 'example:latest' }], checkedAt: new Date(NOW).toISOString(),
  }, { optionId: 'near-private', state: 'not-detected', reasonCode: 'not-detected', models: [] }]);
  assert.deepEqual([body.proposals, body.authorizations], [['proposal-1'], ['authorization-1']]);
  const { log } = await populated(0);
  assert.equal((await log.append(EVENT, body)).ok, true);
  const ordinaryWork = buildGuideRecord({ ...GUIDE_INPUT, answers: { ...ANSWERS, otherKind: 'Unused' } });
  assert.equal(ordinaryWork.kindOfWorkText, undefined);
  assert.ok(!('otherKind' in ordinaryWork.answers));
});

test('model names follow the session mark last-part rule', () => {
  const ids = ['', '  example  ', 'llama:latest', 'group/model', '/models/example.gguf', '~/.models/model',
    'C:\\example\\one.gguf', '\\\\server\\share\\two.gguf', 'https://example.org/three', 'https://example.org:1234/'];
  const [snapshot] = snapshotOf([{ ...GUIDE_INPUT.viability[0], models: ids.map((id) => ({ id })) }]);
  assert.deepEqual(snapshot, { ...snapshot, models: ids.map((id) => ({ id: recordedModelName(id) })) });
});

test('an abandoned guide records only choice ids and its last screen', async () => {
  const { log, file } = await populated(0);
  const input = { answers: { ...ANSWERS, kindOfWork: 'something-else', otherKind: 'Private notes' }, screen: 'options', hostKind: 'desktop' } as const;
  const body = buildAbandonedRecord(input);
  assert.equal((await log.append('setup.guide.abandoned', body)).ok, true);
  assert.deepEqual((await linesOf(file))[0].body, { ...input, answers: { ...ANSWERS, kindOfWork: 'something-else' } });
});

test('scan records accept policy CIDR ranges and refuse raw addresses or extra host fields', async () => {
  const { log, file } = await populated(0);
  const scan = { phase: 'start', ranges: ['192.0.2.0/24'], ports: [1234], found: 0, hostKind: 'desktop' } as const;
  for (const cidr of ['192.0.2.0/24', '192.0.2.0/16', '192.0.2.5/32', '192.0.2.5', '192.0.2.0/15', '192.0.2.0/33', '192.0.2.256/24', 'host.example.org/24']) {
    const acceptedByPolicy = parseOnboardingSection({ v: 1, discovery: { scanRanges: [{ cidr }] } }, SCALE_PRESETS).ok;
    assert.equal((await log.append('setup.discovery.scan', { ...scan, ranges: [cidr] })).ok, acceptedByPolicy, cidr);
  }
  assert.equal((await log.append('setup.discovery.scan', { ...scan, host: '198.51.100.4' })).ok, false);
  const end = buildScanRecord({ ...scan, phase: 'end', ranges: [...scan.ranges, '198.51.100.4'], found: 1 });
  assert.deepEqual(end.ranges, scan.ranges);
  assert.equal((await log.append('setup.discovery.scan', end)).ok, true);
  assert.ok(!(await readFile(file, 'utf8')).includes('198.51.100.4'));
  assert.equal((await log.append('setup.discovery.approved-proposal', {
    endpointId: 'example', serverKind: 'ollama', pin: 'a'.repeat(64), proposalId: 'proposal-1', outcome: 'proposal-opened',
  })).ok, true);
  assert.equal((await log.latest())?.seq, 5);
});

test('32.2 D-23: registered local-models events append to the same chain', async () => {
  const { log, registry } = await populated(1);
  const body = { modelId: 'example', sha256: 'a'.repeat(64), serverKind: 'ollama', serverVersion: '1.2.3' };
  registry.register({ id: 'local-models.installed', required: Object.keys(body), optional: [] });
  assert.throws(() => registry.register({ id: 'local-models.other' as AuditEventId, required: [], optional: [] }), /Unknown audit event/);
  assert.equal((await log.append('local-models.installed', body)).ok, true);
  assert.equal((await log.latest())?.seq, 2);
});

test('a no-change Apply keeps its marker and an empty list', async () => {
  const { log, file } = await populated(0);
  const body = buildGuideRecord({ ...GUIDE_INPUT, nothingChanged: true, changes: [] });
  assert.equal((await log.append(EVENT, body)).ok, true);
  const [line] = await linesOf(file);
  const { nothingChanged, changes } = line.body as typeof body;
  assert.deepEqual({ nothingChanged, changes }, { nothingChanged: true, changes: [] });
});
