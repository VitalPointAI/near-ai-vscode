#!/usr/bin/env node
const store = require('./store');

function format(note) {
  return note.id + '  ' + note.at + '  ' + note.text;
}

const newestFirst = (notes) => notes.slice().sort((a, b) => b.at.localeCompare(a.at));

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'add') {
    const note = store.add(rest.join(' '));
    console.log('Added note ' + note.id);
    return 0;
  }
  if (command === 'list') {
    for (const note of newestFirst(store.load())) console.log(format(note));
    return 0;
  }
  if (command === 'search') {
    const word = rest.join(' ');
    const found = newestFirst(store.search(word));
    if (!found.length) console.log('No notes match "' + word + '".');
    for (const note of found) console.log(format(note));
    return 0;
  }
  if (command === 'delete') {
    if (!store.remove(rest[0])) { console.error('No note with id ' + rest[0]); return 1; }
    console.log('Deleted note ' + rest[0]);
    return 0;
  }
  console.error('Usage: notes <add|list|search|delete> ...');
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof store.CorruptedError)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
