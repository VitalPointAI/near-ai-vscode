import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { classifyCommand, CommandContext } from './commandSafety';
import { NETWORK_COMMAND } from './untrusted';
import { VERIFIER_FILES, VERIFIER_MANIFEST } from '../gsd/verifierScaffold';

// PERF-01: what a sub-agent may run without a person at the screen. Measured on two research projects, sub-agents spent hours parked on approval cards
// for their own verification scripts: `bash scripts/verify.sh` is `unknown` to the rules (an interpreter runs code they cannot see), so it asked, and
// nobody was there to answer. This module decides only that narrow class, and only ever upgrades an "ask" to an "allow": it never touches a refusal,
// and everything the rules call risky, anything that reaches the network, and any script it cannot fully read still asks.
//
// Allowed, for an unattended sub-agent in the auto or mostly-autonomous modes:
//   1. a command the deterministic rules already call `safe` (read-only commands, read-only git, tests, lint, typecheck, builds, and writes inside the
//      agent's own root, which is its git worktree when it has one): the same verdict auto mode acts on, now also in mostly-autonomous;
//   2. a verification script run by an interpreter (bash, sh, node, python3), when the script sits inside the agent's root, is named like a check or is
//      named by the plan, and its text passes the static content check below.
// Never: a `risky` verdict (push, publish, delete outside, credential paths), a network command, a script outside the root, a script the run itself
// wrote after reading outside content, or a script whose text mentions the network, deletion, publishing, credentials, subprocesses or a path outside
// the root.

/** What the unattended check needs beyond the classifier's context. */
export interface UnattendedScope {
  /** Scripts the plan or task names (workspace-relative or absolute), which count as verification scripts whatever they are called. */
  planScripts?: string[];
  /** When the run started (ms): a script changed since then was written by this run. */
  runStartedAt?: number;
  /** When the run (any of its agents) first read outside content (ms); a file changed after it asks. Falls back to runStartedAt when unknown. */
  taintedAt?: number;
}

export interface UnattendedVerdict { allow: boolean; reason: string }

/** A script named like a check: verify, check, gate, lint, test, typecheck, validate, audit (also as part of a longer name or folder). */
const VERIFY_NAME = /(?:^|[\\/._-])(?:verify|verif|check|checks|gate|gates|lint|test|tests|typecheck|validate|validation|audit)(?:[\\/._-]|s?$)/i;
const INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3', 'python']);
const SCRIPT_EXTENSION = /\.(?:sh|bash|mjs|cjs|js|py)$/i;
const PLAIN_WORD = /^[A-Za-z0-9_./:=@+,%-]+$/;
const MAX_SCRIPT_BYTES = 256 * 1024;

/**
 * Text a verification script may not contain for it to run unattended. Each line is a class of action the approval policy promises to ask about, or a
 * way to do one that a text check cannot follow (a subprocess or eval runs code this check never sees).
 */
const FORBIDDEN_CONTENT: Array<[RegExp, string]> = [
  [/\b(?:curl|wget|ncat|socat|ssh|scp|sftp|rsync|telnet|ftp)\b|\bnc\s/i, 'it calls a network program'],
  [/\bhttps?:\/\//i, 'it names a URL'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|\b(?:urllib|requests|httpx|aiohttp|socket|paramiko|ftplib|smtplib)\b|http\.client/, 'it can reach the network'],
  [/(?:require\s*\(|from\s+|import\s*\(?)\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|vm)['"]/, 'it loads a network or process module'],
  [/child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:Sync|File|FileSync)?\s*\(|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\bsubprocess\b|\beval\b|new\s+Function|(?:^|[;&|(]\s*)(?:source|\.)\s+\S|\bsudo\b|\bxargs\b/m, 'it starts other programs or evaluates code'],
  [/\brm\s+-|\brm\s+[^\s|;&]+|\brmdir\b|\bunlink|\brmSync\b|\brm\s*\(|\bshutil\.rmtree|\bos\.remove|\s-delete\b|\bshred\b|\btruncate\b|\bgit\s+(?:reset|clean|checkout|restore)\b/, 'it deletes or discards files'],
  [/\bgit\s+push\b|\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\bvsce\b|\bovsx\b|\btwine\b|\bgh\s+(?:release|pr|api)\b|\bdocker\s+push\b|\bcargo\s+publish\b/, 'it publishes or pushes'],
  [/\.ssh\b|\.aws\b|\.gnupg|near-credentials|\.npmrc|\.netrc|\.pypirc|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.(?:pem|p12|pfx|keystore|kbkey)\b|\bcredentials?\b|(?:^|[^\w])\.env\b|process\.env|os\.environ|getenv|\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)/i, 'it names a credential or the environment'],
  [/(?:^|[\s'"`=(,])~\//, 'it names a path in a home directory'],
  [/\.\.[\\/]/, 'it names a path above its own folder']
];

/** Absolute paths a check may name: the interpreter on a shebang line, the null device, and the temporary folder. */
const HARMLESS_ABSOLUTE = /^\/(?:usr\/(?:local\/)?bin\/(?:env|bash|sh|node|python3?)|bin\/(?:bash|sh)|dev\/null|dev\/stdout|dev\/stderr|tmp(?:\/|$))/;

const inside = (root: string, file: string): boolean => file === root || file.startsWith(`${root}${path.sep}`);

/** Why a script's text must not run unattended, or undefined when nothing in it is forbidden. */
export function forbiddenScriptContent(text: string, root: string): string | undefined {
  // Comments are checked too: a script is judged by everything in it, so a commented-out command is not a way to sneak past the check.
  for (const [pattern, reason] of FORBIDDEN_CONTENT) if (pattern.test(text)) return reason;
  for (const match of text.matchAll(/(?:^|[\s'"`=(,:])(\/[A-Za-z0-9_.@+-][^\s'"`),;]*)/g)) {
    const named = match[1];
    if (HARMLESS_ABSOLUTE.test(named)) continue;
    if (!inside(root, path.resolve(named))) return `it names ${named}, outside the project`;
  }
  return undefined;
}

/** For a shell script (a list of commands), the first line the rules call risky, judged as a command run from the script's own folder. */
function riskyShellLine(text: string, context: CommandContext): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const verdict = classifyCommand(line, context);
    if (verdict.verdict === 'risky') return `a line of it is risky: ${verdict.reason}`;
  }
  return undefined;
}

/** The script a command runs, when it is exactly `[cd <dir> &&] [interpreter] <script> [plain arguments]`. */
export function scriptInvocation(command: string, cwd: string): { script: string; cwd: string } | undefined {
  let rest = command.trim();
  let folder = cwd;
  const cd = /^cd\s+([A-Za-z0-9_./:=@+,%-]+)\s*&&\s*/.exec(rest);
  if (cd) { folder = path.resolve(cwd, cd[1]); rest = rest.slice(cd[0].length); }
  const words = rest.split(/\s+/).filter(Boolean);
  if (!words.length || words.some((word) => !PLAIN_WORD.test(word))) return undefined;
  let index = 0;
  if (INTERPRETERS.has(words[0])) index = 1;
  const script = words[index];
  if (!script || !SCRIPT_EXTENSION.test(script) || script.startsWith('-')) return undefined;
  // Options to the interpreter itself (node --eval, python -c) are never part of this shape: the first word after it must be the script.
  return { script: path.resolve(folder, script), cwd: folder };
}

/**
 * Whether `command` runs a verification script that may run unattended. The script must resolve (symbolic links followed) inside the root, be a
 * readable file under 256 KiB, be named like a check or by the plan, not have been written by this run after it read outside content, and pass the
 * content check.
 */
export async function verificationScript(command: string, context: CommandContext & UnattendedScope, tainted: boolean): Promise<UnattendedVerdict> {
  const root = path.resolve(context.root);
  const invocation = scriptInvocation(command, context.cwd ?? root);
  if (!invocation) return { allow: false, reason: 'it is not a plain run of one script' };
  if (!inside(root, invocation.cwd)) return { allow: false, reason: 'it runs from outside the project' };
  let real: string;
  let realRoot: string;
  try { real = await realpath(invocation.script); realRoot = await realpath(root); } catch { return { allow: false, reason: 'the script does not exist' }; }
  if (!inside(realRoot, real)) return { allow: false, reason: 'the script is outside the project' };
  const relative = path.relative(realRoot, real).split(path.sep).join('/');
  const named = (context.planScripts ?? []).some((entry) => {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized === relative || (path.isAbsolute(entry) && path.resolve(entry) === invocation.script);
  });
  if (!named && !VERIFY_NAME.test(relative)) return { allow: false, reason: `${relative} is not named like a check and the plan does not name it` };
  // Every file the script can run is judged, not only the entry: each relative import, require, dynamic import and script it invokes, recursively.
  const problem = await checkClosure(real, realRoot, context, tainted);
  if (problem) return { allow: false, reason: `${relative} cannot run unattended: ${problem}` };
  return { allow: true, reason: `${relative} is a verification script inside the project` };
}

/** node: built-ins a verification script may load: files and paths only, nothing that starts programs or reaches the network. */
const ALLOWED_BUILTINS = new Set(['fs', 'fs/promises', 'path', 'url', 'util', 'assert', 'assert/strict']);
/** Python standard modules a verification script may import; anything else (and any relative import) asks. */
const ALLOWED_PYTHON = new Set(['json', 're', 'sys', 'pathlib', 'math', 'csv', 'collections', 'statistics', 'argparse', 'decimal', 'fractions', 'itertools', 'functools', 'typing', 'dataclasses', 'datetime', 'string', 'textwrap', 'unicodedata', 'enum', 'glob', 'fnmatch']);
const MAX_CLOSURE_FILES = 50;
const JS_FILE = /\.(?:mjs|cjs|js)$/i;
const SHELL_FILE = /\.(?:sh|bash)$/i;

/** SHA-256 of a file's text, as the scaffold manifest records it. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * What one file of a script's closure loads or runs, or a reason it cannot be followed: JavaScript imports, re-exports, `require` and `import()`
 * (a non-literal argument fails closed), Python imports, and scripts a shell script runs.
 */
export function dependenciesOf(file: string, text: string, shellCwd = path.dirname(file)): { relative: string[]; builtins: string[] } | { problem: string } {
  const relative: string[] = [];
  const builtins: string[] = [];
  const take = (specifier: string): string | undefined => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) { relative.push(specifier); return undefined; }
    const name = specifier.replace(/^node:/, '');
    if (ALLOWED_BUILTINS.has(name)) { builtins.push(name); return undefined; }
    return `it loads ${specifier}, which is not a file of the project or an allowed built-in`;
  };
  if (JS_FILE.test(file)) {
    // A call whose argument is not one string literal is decided at run time, so nothing here can follow it.
    if (/\b(?:require|import)\s*\(\s*(?!['"][^'"\n]*['"]\s*\))/.test(text)) return { problem: 'it loads a module chosen at run time' };
    const patterns = [/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"\n]+)['"]/g, /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"\n]+)['"]/g, /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) { const problem = take(match[1]); if (problem) return { problem }; }
  } else if (/\.py$/i.test(file)) {
    for (const match of text.matchAll(/^\s*(?:from\s+(\S+)\s+import|import\s+([\w.,\s]+))/gm)) {
      const modules = match[1] ? [match[1]] : match[2].split(',').map((item) => item.trim().split(/\s+/)[0]);
      for (const module of modules) if (module.startsWith('.') || !ALLOWED_PYTHON.has(module.split('.')[0])) return { problem: `it imports ${module}, which is not an allowed standard module` };
    }
    if (/\b__import__\b|\bimportlib\b/.test(text)) return { problem: 'it imports a module chosen at run time' };
  } else if (SHELL_FILE.test(file) || /^#!.*\b(?:ba)?sh\b/.test(text)) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const words = line.split(/\s+/);
      const runsScript = INTERPRETERS.has(words[0]) || /^\.?\.?\//.test(words[0]) || SCRIPT_EXTENSION.test(words[0]);
      if (!runsScript) continue;
      // A shell script's commands run from the folder it was started in, not its own.
      const invoked = scriptInvocation(line, shellCwd);
      if (!invoked) return { problem: `it runs another program in a way that cannot be followed (${line.slice(0, 80)})` };
      relative.push(invoked.script);
    }
  }
  return { relative, builtins };
}

/** The scaffold's recorded hashes (.planning/.near-ai/verifiers.json), by project-relative path; empty when there is none. */
async function scaffoldManifest(root: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(path.join(root, VERIFIER_MANIFEST), 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  } catch {
    return {};
  }
}

/**
 * Checks every file a verification script can run: the entry, and recursively each relative import, require, dynamic import and invoked script. Each
 * must resolve inside the project, be a small regular file, not have changed during a run that read outside content, pass the content check (and, for
 * shell, the per-line rules), and, if it is one of the scaffolded verifier files, still match the hash recorded when it was scaffolded. A cycle, an
 * unresolvable or non-literal load, or more than MAX_CLOSURE_FILES files asks. Returns the first problem, or undefined when the whole closure is clean.
 */
async function checkClosure(entry: string, realRoot: string, context: CommandContext & UnattendedScope, tainted: boolean): Promise<string | undefined> {
  const manifest = await scaffoldManifest(realRoot);
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = async (requested: string, from: string): Promise<string | undefined> => {
    let file: string;
    try { file = await realpath(requested); } catch { return `${from} loads ${path.basename(requested)}, which does not exist`; }
    const shown = path.relative(realRoot, file).split(path.sep).join('/');
    if (!inside(realRoot, file)) return `${from} loads a file outside the project`;
    if (onPath.has(file)) return `${shown} is part of an import cycle`;
    if (done.has(file)) return undefined;
    if (done.size + onPath.size >= MAX_CLOSURE_FILES) return 'it loads too many files to check';
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return `${shown} is not a small regular file`;
    const since = context.taintedAt ?? context.runStartedAt;
    if (tainted && since !== undefined && info.mtimeMs >= since - 1_000) return `${shown} changed after this run read outside content`;
    const text = await readFile(file, 'utf8');
    const recorded = manifest[shown] ?? (VERIFIER_FILES[shown] !== undefined ? contentHash(VERIFIER_FILES[shown]) : undefined);
    if (recorded !== undefined && contentHash(text) !== recorded) return `${shown} is a scaffolded verifier that has changed since it was scaffolded`;
    const forbidden = forbiddenScriptContent(text, realRoot);
    if (forbidden) return `${shown}: ${forbidden}`;
    if (SHELL_FILE.test(file) || /^#!.*\b(?:ba)?sh\b/.test(text)) {
      const line = riskyShellLine(text, { ...context, root: realRoot, cwd: path.dirname(file) });
      if (line) return `${shown}: ${line}`;
    }
    const dependencies = dependenciesOf(file, text, context.cwd ?? realRoot);
    if ('problem' in dependencies) return `${shown}: ${dependencies.problem}`;
    onPath.add(file);
    for (const dependency of dependencies.relative) {
      const problem = await visit(path.resolve(path.dirname(file), dependency), shown);
      if (problem) return problem;
    }
    onPath.delete(file);
    done.add(file);
    return undefined;
  };
  return visit(entry, path.relative(realRoot, entry));
}

/**
 * The unattended decision for one shell command: allow when the rules call it safe, or when it runs a verification script that passes every check
 * above. Anything that can reach the network is never allowed here, whatever the rules say about it.
 */
export async function unattendedDecision(command: string, context: CommandContext & UnattendedScope, tainted: boolean): Promise<UnattendedVerdict> {
  const text = command.trim();
  if (!text) return { allow: false, reason: 'there is no command' };
  if (NETWORK_COMMAND.test(text)) return { allow: false, reason: 'it can reach the network' };
  const classified = classifyCommand(text, context);
  if (classified.verdict === 'risky') return { allow: false, reason: classified.reason };
  if (classified.verdict === 'safe') return { allow: true, reason: `the rules call it safe (${classified.reason})` };
  return verificationScript(text, context, tainted);
}

/** Scripts a plan or task prompt names (e.g. `scripts/verify-gates.sh`), for the unattended check. */
export function scriptsNamedIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s`'"(])((?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:sh|bash|mjs|cjs|js|py))\b/g)) if (!match[1].includes('..')) found.add(match[1].replace(/^\.\//, ''));
  return [...found].slice(0, 50);
}
