const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = (file, ...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), ...args], { env: { ...process.env, NOTES_FILE: file }, encoding: 'utf8' });
const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'notes.json');

test('search ignores case', () => {
  const file = temp();
  run(file, 'add', 'Buy Milk');
  assert.match(run(file, 'search', 'milk').stdout, /Buy Milk/);
});

test('delete removes a note; an unknown id exits 1', () => {
  const file = temp();
  run(file, 'add', 'x');
  assert.equal(run(file, 'delete', '1').status, 0);
  assert.equal(run(file, 'delete', '1').status, 1);
});

test('a corrupt file is backed up and kept', () => {
  const file = temp();
  fs.writeFileSync(file, 'oops');
  assert.equal(run(file, 'list').status, 2);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), 'oops');
});
