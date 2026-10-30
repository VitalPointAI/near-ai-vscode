#!/usr/bin/env node
const store = require('./store');

function format(note) {
  return note.id + '  ' + note.at + '  ' + note.text;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'add') {
    const note = store.add(rest.join(' '));
    console.log('Added note ' + note.id);
    return 0;
  }
  if (command === 'list') {
    const notes = store.load().slice().sort((a, b) => b.at.localeCompare(a.at));
    for (const note of notes) console.log(format(note));
    return 0;
  }
  console.error('Usage: notes <add|list> ...');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
