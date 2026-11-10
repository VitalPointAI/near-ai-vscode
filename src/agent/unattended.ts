import { readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { classifyCommand, CommandContext } from './commandSafety';
import { NETWORK_COMMAND } from './untrusted';

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
  [/child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:Sync|File|FileSync)?\s*\(|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\bsubprocess\b|\beval\b|new\s+Function|\bsource\s|\bsudo\b|\bxargs\b/, 'it starts other programs or evaluates code'],
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
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return { allow: false, reason: 'the script is not a small regular file' };
  const relative = path.relative(realRoot, real).split(path.sep).join('/');
  const named = (context.planScripts ?? []).some((entry) => {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized === relative || (path.isAbsolute(entry) && path.resolve(entry) === invocation.script);
  });
  if (!named && !VERIFY_NAME.test(relative)) return { allow: false, reason: `${relative} is not named like a check and the plan does not name it` };
  if (tainted && context.runStartedAt !== undefined && info.mtimeMs >= context.runStartedAt - 1_000) {
    return { allow: false, reason: `${relative} changed during this run, which has read outside content` };
  }
  const text = await readFile(real, 'utf8');
  const forbidden = forbiddenScriptContent(text, realRoot);
  if (forbidden) return { allow: false, reason: `${relative} cannot run unattended: ${forbidden}` };
  if (/\.(?:sh|bash)$/i.test(real) || /^#!.*\b(?:ba)?sh\b/.test(text)) {
    const line = riskyShellLine(text, { ...context, root: realRoot, cwd: path.dirname(real) });
    if (line) return { allow: false, reason: `${relative} cannot run unattended: ${line}` };
  }
  return { allow: true, reason: `${relative} is a verification script inside the project` };
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
