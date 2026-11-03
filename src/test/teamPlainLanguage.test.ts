// The owner's first product principle (.planning/PROJECT.md): people build together without knowing git, and git terms appear only in an optional
// details view. This test reads every string literal of the Team Mode text tables (the board model words, the board page scripts, the status bar,
// the board host, the Team Mode commands and the Team section) with the TypeScript parser and fails on a developer term in anything a person reads.
// Text written to the NEAR AI Team output channel (the details view) is allowed, as are the few exact strings in OUTPUT_ONLY below, each with its
// reason. G-61-6 (owner, 2026-11-03): the paying account is "your organization", never "NEAR organization", and a wider naming scan keeps the old
// names out of every Team Mode literal and command title. The term lists and the scanner live in helpers/plainWords.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  bannedIn, bannedPattern, type Found, LEGACY_PEOPLE_FACING, literalsOf, namingIn, namingPattern, namingScanFiles, organizationPattern,
  peopleFacingFiles, readable
} from './helpers/plainWords';

const ROOT = path.resolve(__dirname, '..', '..');

// Exact strings that contain a banned term, are not passed straight to an output-channel call, and still never reach a person (each with its
// reason). An entry must still exist in its file, so the list cannot go stale.
const OUTPUT_ONLY: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: 'src/services/team/teamSession.ts', text: 'The device key for this team could not be read, so this computer runs read-only:  ',
    why: 'kept in identityProblem and written only with session.line(); the person sees READ_ONLY_TEXT'
  }
];

test('the scanner finds a banned word in a label or a sentence, and leaves output-channel lines, ids and module paths alone', () => {
  const sample = [
    "import { x } from '../team/branch';",
    "const PUSH = 'Push';",
    "const SHOWN = `Pushed ${branch} to ${remote}.`;",
    "output.appendLine(`Pushed ${branch} to ${remote}.`);",
    "deps.output.appendLine(ok ? 'team.json is committed.' : `committed on ${b}`);",
    "if (code === 'commit-failed') run('git.clone');",
    "const label = 'Share with my team';",
    "const later = () => import('../../team/remote');",
    "const A = 'Link a NEAR organization';",
    "const B = `${name} is already in your NEAR Organizations list.`;",
    "const C = 'Your NEAR organisation pays for this team.';",
    "output.appendLine('The NEAR organization could not be read.');",
    "const D = 'Your organization pays for this team.';"
  ].join('\n');
  assert.deepEqual(bannedIn('sample.ts', sample).map((found) => [found.line, found.text]), [
    [2, 'Push'], [3, 'Pushed   to  .'], [9, 'Link a NEAR organization'], [10, '  is already in your NEAR Organizations list.'],
    [11, 'Your NEAR organisation pays for this team.']
  ]);
  assert.equal(bannedPattern.test('the team log'), true);
  assert.equal(bannedPattern.test('the team record'), false);
  assert.equal(bannedPattern.test('pushover'), false, 'whole words only');
  assert.equal(bannedPattern.test('the NEAR\n  organisations'), true, 'any whitespace between the words');
  assert.equal(bannedPattern.test('your organization'), false);
});

test('the naming scanner finds the old names in any literal, output channel text included, and leaves NEAR AI and your organization alone', () => {
  const sample = [
    "output.appendLine('Removed from the NEAR organization.');",
    "const A = 'Create one in the NEAR console.';",
    "const B = `${name}'s NEAR key is set to a limit of 0.`;",
    "line('Both NEAR keys were revoked.');",
    "const C = 'The NEAR link is not shared yet.';",
    "const D = 'Your NEAR AI key and the NEAR AI website.';",
    "const E = 'Your organization pays for this team.';",
    "const F = 'nearAi.team.linkNearOrganization';",
    "import { y } from './near key';"
  ].join('\n');
  assert.deepEqual(namingIn('sample.ts', sample).map((found) => found.line), [1, 2, 3, 4, 5]);
  for (const term of ['NEAR organization', 'near Organisations', 'NEAR console', 'NEAR key', 'NEAR keys', 'NEAR  link']) {
    assert.equal(namingPattern.test(term), true, term);
  }
  for (const fine of ['NEAR AI key', 'NEAR AI website', 'your organization', 'NEAR AI: Link Your Organization', 'NEAR-linked', 'NEAR keyboard']) {
    assert.equal(namingPattern.test(fine), false, fine);
  }
});

test('the scan covers every people-facing file by convention, and a named file that is missing fails instead of being skipped', () => {
  const files = peopleFacingFiles(ROOT);
  assert.equal(new Set(files).size, files.length, 'no file is scanned twice');
  for (const relative of LEGACY_PEOPLE_FACING) assert.ok(files.includes(relative), `${relative} is still scanned`);
  for (const relative of ['src/domain/team/teamSectionText.ts', 'media/chat/team.js']) assert.ok(files.includes(relative), `${relative} is found by convention`);
  assert.ok(!files.some((relative) => relative.endsWith('.css')), 'only scripts and TypeScript are read');
  const naming = namingScanFiles(ROOT);
  for (const relative of ['src/team/join.ts', 'src/team/nearOrg.ts', 'src/services/team/memberCommands.ts', 'src/domain/team/boardText.ts', 'media/board/board.js', 'media/chat/team.js']) {
    assert.ok(naming.includes(relative), `${relative} is in the naming scan`);
  }
  assert.ok(!naming.includes('src/domain/team/permissions.ts'), 'rejection and permission reasons are hashed state and stay out of the naming scan');
  assert.throws(() => peopleFacingFiles(path.join(ROOT, 'src')), /do not exist/);
});

test('no Team Mode text a person reads uses a developer term; git words stay in the output channel (owner principle, 2026-11-02)', () => {
  const found: Found[] = [];
  let readableLiterals = 0;
  for (const relative of peopleFacingFiles(ROOT)) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8');
    readableLiterals += literalsOf(relative, source).filter((literal) => !literal.output && readable(literal.text)).length;
    found.push(...bannedIn(relative, source, OUTPUT_ONLY));
  }
  assert.ok(readableLiterals > 300, `the scan reads the text tables (${readableLiterals} readable literals)`);
  assert.deepEqual(found.map((entry) => `${entry.file}:${entry.line}: ${entry.text}`), []);
});

test('the scan covers the words this pass replaced', () => {
  const text = peopleFacingFiles(ROOT).map((relative) => readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
  for (const shown of ['Share with my team', 'Check the team', 'Shipping', 'Parts of the project this covers (optional)', 'Get the project', 'Experiment']) {
    assert.ok(text.includes(`'${shown}'`) || text.includes(`'${shown}`) || text.includes(shown), `${shown} is in a scanned file`);
  }
  for (const entry of OUTPUT_ONLY) {
    const source = readFileSync(path.join(ROOT, entry.file), 'utf8');
    assert.ok(literalsOf(entry.file, source).some((literal) => literal.text === entry.text && bannedPattern.test(literal.text)), `allowlisted text still exists and still needs the entry: ${entry.text}`);
  }
});

test('no people-facing Team Mode text calls the paying account a NEAR organization (G-61-6, owner 2026-11-03)', () => {
  const found: Found[] = [];
  for (const relative of peopleFacingFiles(ROOT)) {
    found.push(...bannedIn(relative, readFileSync(path.join(ROOT, relative), 'utf8'), OUTPUT_ONLY).filter((entry) => organizationPattern.test(entry.text)));
  }
  assert.deepEqual(found.map((entry) => `${entry.file}:${entry.line}: ${entry.text}`), []);
});

test('the naming scan finds no NEAR organization, NEAR console, NEAR key or NEAR link in any team string literal or command title', () => {
  const found: string[] = [];
  let literals = 0;
  for (const relative of namingScanFiles(ROOT)) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8');
    literals += literalsOf(relative, source).length;
    found.push(...namingIn(relative, source).map((entry) => `${entry.file}:${entry.line}: ${entry.text}`));
  }
  assert.ok(literals > 1000, `the naming scan reads the team code (${literals} literals)`);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
  assert.ok(manifest.contributes.commands.length > 5, 'every contributed command title is read');
  for (const entry of manifest.contributes.commands) {
    if (namingPattern.test(entry.title)) found.push(`package.json ${entry.command}: ${entry.title}`);
  }
  assert.deepEqual(found, []);
});
