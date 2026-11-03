// The owner's plain-language rules as one shared scanner (teamPlainLanguage.test.ts reads it; later suites may too). Two lists:
// - BANNED_TERMS: developer words a person must never need, plus the old name of the paying account ("NEAR organization", G-61-6). Checked in
//   every literal a person reads; text written to the NEAR AI Team output channel (the optional details view) is allowed.
// - NAMING_TERMS: the old names for the organization, its settings page, a member's key and the organization link. Checked in every literal of
//   the Team Mode code, output channel text included, so the old naming cannot come back anywhere (owner, 2026-11-03).
// No .test suffix, so the test glob does not run this file. It reads files only; it never writes.
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

export interface Found { file: string; line: number; text: string }

// The paying account is "your organization"; NEAR AI is only the AI provider (owner, 2026-11-03).
const ORGANIZATION_TERMS = ['NEAR organization', 'NEAR organizations', 'NEAR organisation', 'NEAR organisations'] as const;

// Developer words a person must never need (case-insensitive, whole words). "Git" itself may be named once as the tool Team Mode needs installed.
export const BANNED_TERMS: readonly string[] = [
  'branch', 'branches', 'commit', 'commits', 'committed', 'committing', 'push', 'pushed', 'pushing', 'pull', 'remote', 'worktree', 'glob', 'GSD',
  'repository', 'repo', 'clone', 'cloned', 'merge', 'merged', 'merging', 'rebase', 'team log', 'device key', 'pattern', 'integration branch',
  ...ORGANIZATION_TERMS
];

// The old naming: the organization, its settings ("NEAR console"), a member's key ("NEAR key") and the organization link ("NEAR link").
export const NAMING_TERMS: readonly string[] = [...ORGANIZATION_TERMS, 'NEAR console', 'NEAR key', 'NEAR keys', 'NEAR link'];

// Whole words, case-insensitive, and a space in a term matches any run of whitespace (a sentence may wrap).
function wholeWords(terms: readonly string[]): RegExp {
  return new RegExp(`(?<![A-Za-z])(${terms.map((term) => term.replace(/ /g, '\\s+')).join('|')})(?![A-Za-z])`, 'i');
}

export const bannedPattern: RegExp = wholeWords(BANNED_TERMS);
export const namingPattern: RegExp = wholeWords(NAMING_TERMS);
export const organizationPattern: RegExp = wholeWords(ORGANIZATION_TERMS);

// Any literal inside the arguments of these calls is written to the NEAR AI Team output channel (the optional details view), so git words are
// allowed there; that is where every technical reason of this pass went. teamSession's line() and reportIssue() write to the channel only
// (reportIssue calls line, line calls appendLine).
const OUTPUT_CALLS: readonly string[] = ['appendLine', 'line', 'reportIssue'];

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
export function readable(text: string): boolean {
  const trimmed = text.trim();
  return /\s/.test(trimmed) || /^[A-Z]/.test(trimmed);
}

// Every string literal and template text of a TypeScript or JavaScript source, with its line and whether it goes to the output channel.
// Module paths (import, export, import()) are left out.
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

// Banned words in the literals a person reads. outputOnly lists exact strings of a file that contain a banned term yet never reach a person.
export function bannedIn(fileName: string, source: string, outputOnly: ReadonlyArray<{ file: string; text: string }> = []): Found[] {
  return literalsOf(fileName, source)
    .filter((literal) => !literal.output && readable(literal.text) && bannedPattern.test(literal.text))
    .filter((literal) => !outputOnly.some((entry) => entry.file === fileName && entry.text === literal.text))
    .map((literal) => ({ file: fileName, line: literal.line, text: literal.text }));
}

// The old naming in any literal, output channel text included.
export function namingIn(fileName: string, source: string): Found[] {
  return literalsOf(fileName, source)
    .filter((literal) => namingPattern.test(literal.text))
    .map((literal) => ({ file: fileName, line: literal.line, text: literal.text }));
}

// The text tables of Phases 60 to 62 named before the scan found files by itself. Each must exist: a missing one fails, never a silent skip.
export const LEGACY_PEOPLE_FACING: readonly string[] = [
  'src/domain/team/boardText.ts',
  'media/board/board.js', 'media/board/detail.js', 'media/board/form.js', 'media/board/menu.js', 'media/board/drag.js',
  'src/services/team/teamStatusBar.ts', 'src/services/team/boardView.ts', 'src/services/team/teamCommands.ts', 'src/services/team/memberCommands.ts',
  'src/services/team/teamSession.ts'
];

// The files of a directory (relative to root) whose names pass the test, sorted; a directory that does not exist gives none.
function listed(root: string, directory: string, keep: (name: string) => boolean): string[] {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

const isTs = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.d.ts');
const isTextTable = (name: string): boolean => /Text\.ts$/.test(name);
const isJs = (name: string): boolean => name.endsWith('.js');
const isTeamPage = (name: string): boolean => /^team.*\.js$/.test(name);

function unique(files: readonly string[]): string[] {
  return [...new Set(files)];
}

// Every file whose text a person reads in Team Mode: the legacy list plus, by convention, every file in src/services/team, every
// src/domain/team/*Text.ts and src/team/*Text.ts, every media/board script and every media/chat/team*.js. A new file there is scanned without
// editing the test.
export function peopleFacingFiles(root: string): string[] {
  const missing = LEGACY_PEOPLE_FACING.filter((relative) => !existsSync(path.join(root, relative)));
  if (missing.length > 0) throw new Error(`people-facing files named in the scan do not exist: ${missing.join(', ')}`);
  return unique([
    ...LEGACY_PEOPLE_FACING,
    ...listed(root, 'src/services/team', isTs),
    ...listed(root, 'src/domain/team', isTextTable),
    ...listed(root, 'src/team', isTextTable),
    ...listed(root, 'media/board', isJs),
    ...listed(root, 'media/chat', isTeamPage)
  ]);
}

// Every file the naming scan reads: every .ts in src/team and src/services/team, src/domain/team/*Text.ts, media/board/*.js and
// media/chat/team*.js. Other src/domain/team files are left out on purpose: PERMISSION_REASONS and TEAM_REJECTION_REASONS are stored in
// state.rejected, which the state hash covers, so changing them would change the Phase 60 to 62 snapshot hashes.
export function namingScanFiles(root: string): string[] {
  return unique([
    ...listed(root, 'src/team', isTs),
    ...listed(root, 'src/services/team', isTs),
    ...listed(root, 'src/domain/team', isTextTable),
    ...listed(root, 'media/board', isJs),
    ...listed(root, 'media/chat', isTeamPage)
  ]);
}
