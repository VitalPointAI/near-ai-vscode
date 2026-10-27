const fs = require('node:fs');
const path = require('node:path');

function file() {
  return process.env.NOTES_FILE || path.join(process.cwd(), 'notes.json');
}

function load() {
  if (!fs.existsSync(file())) return [];
  return JSON.parse(fs.readFileSync(file(), 'utf8'));
}

function save(notes) {
  fs.writeFileSync(file(), JSON.stringify(notes, null, 2));
}

function add(text, now = new Date()) {
  const notes = load();
  const id = notes.reduce((max, note) => Math.max(max, note.id), 0) + 1;
  const note = { id, text, at: now.toISOString() };
  notes.push(note);
  save(notes);
  return note;
}

module.exports = { file, load, save, add };
