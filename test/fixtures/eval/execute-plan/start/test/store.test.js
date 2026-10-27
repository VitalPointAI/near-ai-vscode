const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('add then load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  process.env.NOTES_FILE = path.join(dir, 'notes.json');
  const store = require('../src/store');
  store.add('first');
  store.add('second');
  assert.deepEqual(store.load().map((note) => note.text), ['first', 'second']);
});
