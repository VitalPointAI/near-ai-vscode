// The owner's first product principle (.planning/PROJECT.md): people build together without knowing git, and git terms appear only in an optional
// details view. This test reads every string literal of the Team Mode text tables (the board model words, the board page scripts, the status bar,
// the board host and the Team Mode commands) with the TypeScript parser and fails on a developer term in anything a person reads. Text written to
// the NEAR AI Team output channel (the details view) is allowed, as are the few exact strings in OUTPUT_ONLY below, each with its reason.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..');

// The user-facing text tables of Phases 60 to 62.
const SCANNED = [
  'src/domain/team/boardText.ts',
  'media/board/board.js', 'media/board/detail.js', 'media/board/form.js', 'media/board/menu.js', 'media/board/drag.js',
  'src/services/team/teamStatusBar.ts', 'src/services/team/boardView.ts', 'src/services/team/teamCommands.ts', 'src/services/team/memberCommands.ts',
  'src/services/team/teamSession.ts'
] as const;

// Developer words a person must never need (case-insensitive, whole words). "Git" itself may be named once as the tool Team Mode needs installed.
export const BANNED_TERMS = [
  'branch', 'branches', 'commit', 'commits', 'committed', 'committing', 'push', 'pushed', 'pushing', 'pull', 'remote', 'worktree', 'glob', 'GSD',
  'repository', 'repo', 'clone', 'cloned', 'merge', 'merged', 'merging', 'rebase', 'team log', 'device key', 'pattern', 'integration branch'
] as const;

// The allowlist for output-channel-only text has two parts. OUTPUT_CALLS: any literal inside the arguments of these calls is written to the NEAR AI
// Team output channel (the optional details view), so git words are allowed there; that is where every technical reason of this pass went.
// OUTPUT_ONLY: exact strings that contain a banned term, are not passed straight to such a call, and still never reach a person (each with its
// reason). An entry must still exist in its file, so the list cannot go stale.
// teamSession's line() and reportIssue() write to the channel only (reportIssue calls line, line calls appendLine).
const OUTPUT_CALLS: readonly string[] = ['appendLine', 'line', 'reportIssue'];
const OUTPUT_ONLY: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: 'src/services/team/teamSession.ts', text: 'The device key for this team could not be read, so this computer runs read-only:  ',
    why: 'kept in identityProblem and written only with session.line(); the person sees READ_ONLY_TEXT'
  }
];

interface Found { file: string; line: number; text: string }

const bannedPattern = new RegExp(`(?<![A-Za-z])(${BANNED_TERMS.map((term) => term.replace(/ /g, '\\s+')).join('|')})(?![A-Za-z])`, 'i');

// A call to the output channel, whose text is the optional details view.
function isOutputCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return OUTPUT_CALLS.includes(name);
}

function insideOutputCall(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (isOutputCall(at)) return (at as ts.CallExpression).arguments.some((arg) => arg.pos <= node.pos && node.end <= arg.end);
    if (ts.isFunctionLike(at) || ts.isSourceFile(at)) return false;
  }
  return false;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  return ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword;
}

// A literal a person could read: a sentence (has a space) or a capitalised single word (a button such as "Push"). Lower-case tokens without a space
// are ids, codes, class names, command ids and message types.
function readable(text: string): boolean {
  const trimmed = text.trim();
  return /\s/.test(trimmed) || /^[A-Z]/.test(trimmed);
}

export function literalsOf(fileName: string, source: string): Array<{ line: number; text: string; output: boolean }> {
  const kind = fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ line: number; text: string; output: boolean }> = [];
  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    if (text !== undefined && !isModuleSpecifier(node)) {
      out.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text, output: insideOutputCall(node) });
    }
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else for (const span of node.templateSpans) visit(span.expression);
  };
  visit(file);
  return out;
}

export function bannedIn(fileName: string, source: string): Found[] {
  return literalsOf(fileName, source)
    .filter((literal) => !literal.output && readable(literal.text) && bannedPattern.test(literal.text))
    .filter((literal) => !OUTPUT_ONLY.some((entry) => entry.file === fileName && entry.text === literal.text))
    .map((literal) => ({ file: fileName, line: literal.line, text: literal.text }));
}

test('the scanner finds a banned word in a label or a sentence, and leaves output-channel lines, ids and module paths alone', () => {
  const sample = [
    "import { x } from '../team/branch';",
    "const PUSH = 'Push';",
    "const SHOWN = `Pushed ${branch} to ${remote}.`;",
    "output.appendLine(`Pushed ${branch} to ${remote}.`);",
    "deps.output.appendLine(ok ? 'team.json is committed.' : `committed on ${b}`);",
    "if (code === 'commit-failed') run('git.clone');",
    "const label = 'Share with my team';",
    "const later = () => import('../../team/remote');"
  ].join('\n');
  assert.deepEqual(bannedIn('sample.ts', sample).map((found) => [found.line, found.text]), [[2, 'Push'], [3, 'Pushed   to  .']]);
  assert.equal(bannedPattern.test('the team log'), true);
  assert.equal(bannedPattern.test('the team record'), false);
  assert.equal(bannedPattern.test('pushover'), false, 'whole words only');
});

test('no Team Mode text a person reads uses a developer term; git words stay in the output channel (owner principle, 2026-11-02)', () => {
  const found: Found[] = [];
  let readableLiterals = 0;
  for (const relative of SCANNED) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8');
    readableLiterals += literalsOf(relative, source).filter((literal) => !literal.output && readable(literal.text)).length;
    found.push(...bannedIn(relative, source));
  }
  assert.ok(readableLiterals > 300, `the scan reads the text tables (${readableLiterals} readable literals)`);
  assert.deepEqual(found.map((entry) => `${entry.file}:${entry.line}: ${entry.text}`), []);
});

test('the scan covers the words this pass replaced', () => {
  const text = SCANNED.map((relative) => readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
  for (const shown of ['Share with my team', 'Check the team', 'Shipping', 'Parts of the project this covers (optional)', 'Get the project', 'Experiment']) {
    assert.ok(text.includes(`'${shown}'`) || text.includes(`'${shown}`) || text.includes(shown), `${shown} is in a scanned file`);
  }
  for (const entry of OUTPUT_ONLY) {
    const source = readFileSync(path.join(ROOT, entry.file), 'utf8');
    assert.ok(literalsOf(entry.file, source).some((literal) => literal.text === entry.text && bannedPattern.test(literal.text)), `allowlisted text still exists and still needs the entry: ${entry.text}`);
  }
});
