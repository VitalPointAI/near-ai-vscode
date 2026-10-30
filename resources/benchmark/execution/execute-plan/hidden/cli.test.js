const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const SAMPLE = [
  { id: 1, text: 'Buy milk', at: '2026-01-01T09:00:00.000Z' },
  { id: 2, text: 'Call mom', at: '2026-01-02T09:00:00.000Z' },
  { id: 3, text: 'MILK the cows', at: '2026-01-03T09:00:00.000Z' }
];

function setup(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-acceptance-')), 'notes.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

function notes(file, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, NOTES_FILE: file }, encoding: 'utf8', timeout: 10000 });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('search finds notes containing the word, ignoring case', () => {
  const result = notes(setup(SAMPLE), 'search', 'milk');
  assert.equal(result.code, 0);
  assert.match(result.out, /Buy milk/);
  assert.match(result.out, /MILK the cows/);
  assert.doesNotMatch(result.out, /Call mom/);
});

test('search lists matches newest first', () => {
  const result = notes(setup(SAMPLE), 'search', 'Milk');
  assert.ok(result.out.includes('MILK the cows') && result.out.indexOf('MILK the cows') < result.out.indexOf('Buy milk'), result.out);
});

test('search with no match says so and exits 0', () => {
  const result = notes(setup(SAMPLE), 'search', 'zebra');
  assert.equal(result.code, 0);
  assert.match(result.out, /No notes match/);
});

test('delete removes the note and keeps the others', () => {
  const file = setup(SAMPLE);
  const result = notes(file, 'delete', '2');
  assert.equal(result.code, 0);
  assert.match(result.out, /Deleted note 2/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((note) => note.id), [1, 3]);
});

test('delete with an unknown id exits 1 with a message and changes nothing', () => {
  const file = setup(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  const result = notes(file, 'delete', '9');
  assert.equal(result.code, 1);
  assert.match(result.err, /No note with id 9/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('delete with a non-numeric id exits 1 with a message', () => {
  const result = notes(setup(SAMPLE), 'delete', 'abc');
  assert.equal(result.code, 1);
  assert.match(result.err, /No note with id abc/);
});

test('a corrupted file gives a clear error and a backup, and is not overwritten', () => {
  const broken = '{"id": 1, "text": "half';
  const file = setup(broken);
  const result = notes(file, 'list');
  assert.equal(result.code, 2);
  assert.match(result.err, /corrupt/i);
  assert.doesNotMatch(result.err, /\n\s+at /, 'no stack trace');
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), broken);
});

test('adding to a corrupted file does not overwrite it', () => {
  const file = setup('not json');
  const result = notes(file, 'add', 'new note');
  assert.equal(result.code, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('a missing file still starts empty, and add and list still work', () => {
  const file = setup();
  assert.match(notes(file, 'add', 'hello there').out, /Added note 1/);
  assert.match(notes(file, 'list').out, /hello there/);
});

test('the plan\'s tests were written', () => {
  const dir = path.join(__dirname, '..', 'test');
  const text = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  for (const word of ['search', 'delete', 'corrupt']) assert.match(text, new RegExp(word, 'i'), 'the tests cover ' + word);
});
