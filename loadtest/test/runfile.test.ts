import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashRun, loadRunFiles, readRun, verifyRunFile, writeRunFile } from '../src/runfile.ts';
import { makeRun, stage } from './fixtures/run.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'loadtest-runfile-'));
const written = (): { dir: string; file: string; text: string } => {
  const dir = scratch();
  const file = writeRunFile(dir, makeRun());
  return { dir, file, text: readFileSync(file, 'utf8') };
};

test('a written run file verifies and names itself by its id', () => {
  const { file, text } = written();
  assert.match(file, /20261123T120000Z-rig1\.run\.json$/);
  const run = verifyRunFile(text);
  assert.equal(run.id, '20261123T120000Z-rig1');
  assert.match(run.hash, /^sha256:[0-9a-f]{64}$/);
});

test('changing any value makes verify refuse', () => {
  const { text } = written();
  const parsed = JSON.parse(text);
  parsed.stages[0].start.readyMs.cold[0] += 1;
  assert.throws(() => verifyRunFile(JSON.stringify(parsed)), /hash/);
  const other = JSON.parse(text);
  other.inputs.sessionsPerUser = 2;
  assert.throws(() => verifyRunFile(JSON.stringify(other)), /hash/);
});

test('adding a key makes verify refuse', () => {
  const { text } = written();
  const parsed = JSON.parse(text);
  parsed.stages[0].note = 'extra';
  assert.throws(() => verifyRunFile(JSON.stringify(parsed)), /unknown key/);
  const top = JSON.parse(text);
  top.extra = 1;
  assert.throws(() => verifyRunFile(JSON.stringify(top)), /unknown key/);
});

test('a missing field is refused', () => {
  const { text } = written();
  const parsed = JSON.parse(text);
  delete parsed.hardware.storageClass;
  assert.throws(() => verifyRunFile(JSON.stringify(parsed)), /missing/);
});

test('reordering keys does not change the hash', () => {
  const run = makeRun();
  const reversed = Object.fromEntries(Object.entries(run).reverse()) as typeof run;
  assert.equal(hashRun(reversed), hashRun(run));
  const { text } = written();
  const parsed = JSON.parse(text);
  const shuffled = Object.fromEntries(Object.entries(parsed).reverse());
  assert.equal(verifyRunFile(JSON.stringify(shuffled)).hash, parsed.hash);
});

test('a second write with the same id fails and leaves the first file as it was', () => {
  const { dir, text } = written();
  assert.throws(() => writeRunFile(dir, makeRun({ endedAt: makeRun().endedAt + 1 })), /EEXIST|exists/);
  assert.equal(readFileSync(join(dir, '20261123T120000Z-rig1.run.json'), 'utf8'), text);
});

test('a token-shaped string anywhere makes the write refuse', () => {
  const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJsb2FkdGVzdC11c2VyLTAwMDEifQ', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');
  assert.throws(() => writeRunFile(scratch(), makeRun({ hardware: { ...makeRun().hardware, network: `bearer ${jwt}` } })), /secret|token/);
  const github = 'ghp_' + 'a'.repeat(36);
  assert.throws(() => writeRunFile(scratch(), makeRun({ rig: 'rig1', versions: { ...makeRun().versions, keycloak: github } })), /secret|token/);
  // The scanner's allow marker does not let a token into a run file.
  assert.throws(() => writeRunFile(scratch(), makeRun({ versions: { ...makeRun().versions, keycloak: `${github} secret-scan: allow` } })), /secret|token/);
});

test('a float or a negative number is refused', () => {
  assert.throws(() => writeRunFile(scratch(), makeRun({ peakConcurrency: 1.5 })), /integer/);
  assert.throws(() => writeRunFile(scratch(), makeRun({ peakConcurrency: -1 })), /integer|negative/);
  const { text } = written();
  const parsed = JSON.parse(text);
  parsed.stages[0].start.readyMs.cold[0] = 10.5;
  assert.throws(() => verifyRunFile(JSON.stringify(parsed)), /integer/);
});

test('stages out of ascending order and raw arrays out of order are refused', () => {
  assert.throws(() => writeRunFile(scratch(), makeRun({ stages: [stage(250), stage(50)] })), /ascending/);
  const unsorted = stage(50, { perPerson: { active: { sessions: 2, cpuMillicores: [300, 200], memoryBytes: [1, 2], volumeBytes: [1, 2] }, idle: { sessions: 0, cpuMillicores: [], memoryBytes: [] } } });
  assert.throws(() => writeRunFile(scratch(), makeRun({ stages: [unsorted] })), /ascending/);
});

test('an id that is not <UTC start>-<rig> or a kind outside load, experiment and dry-run is refused', () => {
  assert.throws(() => writeRunFile(scratch(), makeRun({ id: '../escape' })), /id/);
  assert.throws(() => writeRunFile(scratch(), makeRun({ kind: 'estimate' as 'load' })), /kind/);
});

test('loadRunFiles verifies every run file in a folder and refuses one whose name is not its id', () => {
  const { dir } = written();
  assert.equal(loadRunFiles(dir).length, 1);
  assert.deepEqual(loadRunFiles(join(dir, 'absent')), []);
  const other = scratch();
  const file = writeRunFile(other, makeRun());
  mkdirSync(join(other, 'sub'));
  writeFileSync(join(other, '20261123T130000Z-rig1.run.json'), readFileSync(file));
  assert.throws(() => loadRunFiles(other), /name/);
});

test('readRun refuses a file over the size cap', () => {
  assert.throws(() => readRun(' '.repeat(5 * 1024 * 1024 + 1)), /size/);
});
