const fs = require('node:fs');
const path = require('node:path');

function file() {
  return process.env.NOTES_FILE || path.join(process.cwd(), 'notes.json');
}

class CorruptedError extends Error {}

function load() {
  if (!fs.existsSync(file())) return [];
  const text = fs.readFileSync(file(), 'utf8');
  let notes;
  try { notes = JSON.parse(text); } catch { notes = undefined; }
  if (!Array.isArray(notes)) {
    fs.writeFileSync(file() + '.bak', text);
    throw new CorruptedError(file() + ' is corrupted; a backup was saved to ' + file() + '.bak');
  }
  return notes;
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

function search(word) {
  const wanted = word.toLowerCase();
  return load().filter((note) => note.text.toLowerCase().includes(wanted));
}

function remove(id) {
  const notes = load();
  const index = notes.findIndex((note) => String(note.id) === String(id));
  if (index < 0) return false;
  notes.splice(index, 1);
  save(notes);
  return true;
}

module.exports = { file, load, save, add, search, remove, CorruptedError };
