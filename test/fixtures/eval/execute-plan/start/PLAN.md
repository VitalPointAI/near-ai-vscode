# Phase 2: Search, delete, and safe storage

Implements R3–R5 of the notes CLI. Run it with `node src/cli.js <command>`; notes are
stored in the file named by the NOTES_FILE environment variable (default `./notes.json`).
Run the tests with `npm test`.

## Task 1 — Search (R3)
Files: src/store.js, src/cli.js
- `notes search <word>` prints every note whose text contains `<word>`, ignoring case,
  in the same format as `list`, newest first.
- If nothing matches, print `No notes match "<word>".` and exit 0.

## Task 2 — Delete (R4)
Files: src/store.js, src/cli.js
- `notes delete <id>` removes that note, prints `Deleted note <id>`, and exits 0.
- An unknown or non-numeric id prints `No note with id <id>` to stderr, exits 1, and
  leaves the file unchanged.

## Task 3 — Corrupted storage (R5)
Files: src/store.js, src/cli.js
- If the notes file exists but is not valid JSON (or is not a list), copy it to
  `<file>.bak` and stop with a clear message on stderr saying the file is corrupted and
  where the backup is. Exit code 2, and no stack trace.
- Never overwrite a corrupted file, including when adding a note.
- A missing file still means there are no notes yet.

## Task 4 — Tests
Files: test/
- Add tests for search, delete (including an unknown id), and a corrupted file.
- Keep test/store.test.js passing unchanged.

## Verification
`npm test` passes, and each behaviour above works from the command line.
