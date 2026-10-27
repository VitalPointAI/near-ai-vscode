import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionCapability } from '../domain/policy';
import type { RunCheckpoints } from './checkpoints';
import { unifiedDiff } from './diff';
import { matchesGlob } from './glob';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, ShellSession, truncate } from './shell';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export interface ToolContext {
  root: string;
  signal: AbortSignal;
  checkpoints: RunCheckpoints;
  shell: ShellSession;
  /** Files read in this run; Write and Edit refuse to change an existing file the model has not read. */
  readFiles: Set<string>;
  ripgrepPath?: string;
  onTodos?: (todos: Todo[]) => void;
  /** Directories Read, Glob, and Grep may also use (the Open-GSD runtime); never writable. */
  readOnlyRoots?: string[];
}

/** What an approval card shows before a risky call runs. */
export type ToolPreview = { kind: 'diff'; path: string; diff: string } | { kind: 'command'; command: string; cwd: string; background: boolean } | { kind: 'note'; text: string };

export interface AgentTool<I = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability: ActionCapability;
  /** Validates the model's arguments; throws ToolError with a message the model can act on. */
  parse(raw: Record<string, unknown>): I;
  /** A short title for the activity row, e.g. "Read src/extension.ts". */
  title(input: I, context: ToolContext): string;
  preview?(input: I, context: ToolContext): Promise<ToolPreview>;
  /** A reason to always ask first, e.g. reading a likely credential file or writing into `.git/`. */
  sensitive?(input: I, context: ToolContext): string | undefined | Promise<string | undefined>;
  run(input: I, context: ToolContext): Promise<string>;
}

/** Files that usually hold credentials; reading one asks first, since its contents go to the model. */
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_[a-z0-9]+|[^/]*\.(?:pem|key|p12|pfx|keystore)|credentials?(?:\.[a-z]+)?|secrets?(?:\.[a-z]+)?)$|\.near-credentials|\.aws\/|\.ssh\//i;

export function sensitivePathReason(requested: string): string | undefined {
  return isSensitivePath(requested) ? `${requested} looks like it may contain credentials, and its contents would be sent to the model.` : undefined;
}

/** Tests the path as written (normalized, so `.env/` and `./.env/.` count) and as it resolves. */
export function isSensitivePath(file: string): boolean {
  return SENSITIVE_FILE.test(path.posix.normalize(file.replace(/\\/g, '/')).replace(/\/+$/, ''));
}

/** Reading a path asks first when either the path or the file it resolves to looks like a credential. */
export async function sensitiveRead(requested: string | undefined, context: ToolContext): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  if (isSensitivePath(requested)) return sensitivePathReason(requested);
  const resolved = await resolveInWorkspace(context.root, requested, context.readOnlyRoots).catch(() => undefined);
  return resolved && isSensitivePath(resolved) ? `${requested} resolves to ${resolved}, which looks like it may contain credentials, and its contents would be sent to the model.` : undefined;
}

/**
 * Writes that always ask, even after "allow edits for this run": git's own files (hooks and
 * config run code on the next git command) and this extension's project settings.
 */
const PROTECTED_WRITE = /(?:^|\/)(?:\.git|\.planning\/\.near-ai)(?:\/|$)/;

export async function protectedWrite(requested: string, context: ToolContext): Promise<string | undefined> {
  const resolved = await resolveInWorkspace(context.root, requested).catch(() => undefined);
  const relative = resolved ? path.relative(context.root, resolved).split(path.sep).join('/') : requested;
  if (relative.endsWith('.planning/.near-ai/team.md')) return undefined;
  return PROTECTED_WRITE.test(relative) ? `${requested} is inside ${relative.startsWith('.git') || relative.includes('/.git') ? '.git, where hooks and config run code on the next git command' : '.planning/.near-ai, which holds this project\'s NEAR AI settings'}. Approve this write only if you expect it.` : undefined;
}

const MAX_READ_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', '.next', '.cache']);

const str = (raw: Record<string, unknown>, key: string, required = true): string | undefined => {
  const value = raw[key];
  if (value === undefined || value === null || value === '') { if (required) throw new ToolError(`Missing required parameter "${key}".`); return undefined; }
  if (typeof value !== 'string') throw new ToolError(`Parameter "${key}" must be a string.`);
  return value;
};
const num = (raw: Record<string, unknown>, key: string): number | undefined => {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw new ToolError(`Parameter "${key}" must be a number.`);
  return parsed;
};
const bool = (raw: Record<string, unknown>, key: string): boolean => raw[key] === true || raw[key] === 'true';

async function readText(absolute: string): Promise<string> {
  const info = await stat(absolute).catch(() => undefined);
  if (!info) throw new ToolError('File does not exist.');
  if (info.isDirectory()) throw new ToolError('That path is a directory. Use Glob to list files.');
  if (info.size > MAX_READ_BYTES) throw new ToolError(`File is ${Math.round(info.size / 1024)} KB; files over 5 MB are not read. Use Grep to search it.`);
  const bytes = await readFile(absolute);
  if (bytes.subarray(0, 8000).includes(0)) throw new ToolError('File looks binary and was not read.');
  return bytes.toString('utf8');
}

export const readTool: AgentTool<{ path: string; offset: number; limit: number }> = {
  name: 'Read',
  description: 'Read a text file from the workspace. Returns lines prefixed with line numbers (`   12\\t...`). Reads up to 2000 lines; pass offset (1-based line) and limit for longer files. Read a file before editing or overwriting it.',
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path relative to the workspace root, or absolute inside it.' }, offset: { type: 'number', description: 'First line to read (1-based).' }, limit: { type: 'number', description: 'Number of lines to read.' } }, required: ['file_path'], additionalProperties: false },
  capability: 'read',
  parse: (raw) => ({ path: str(raw, 'file_path')!, offset: Math.max(1, Math.floor(num(raw, 'offset') ?? 1)), limit: Math.min(MAX_READ_LINES, Math.max(1, Math.floor(num(raw, 'limit') ?? MAX_READ_LINES))) }),
  title: (input) => `Read ${input.path}`,
  sensitive: (input, context) => sensitiveRead(input.path, context),
  async run(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path, context.readOnlyRoots);
    const text = await readText(absolute);
    context.readFiles.add(absolute);
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return '(empty file)';
    const slice = lines.slice(input.offset - 1, input.offset - 1 + input.limit);
    const width = String(input.offset + slice.length).length;
    const body = slice.map((line, index) => `${String(input.offset + index).padStart(width)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line}`).join('\n');
    const remaining = lines.length - (input.offset - 1 + slice.length);
    return remaining > 0 ? `${body}\n\n[${remaining} more lines. Read again with offset ${input.offset + slice.length} to continue.]` : body;
  }
};

async function requireRead(context: ToolContext, absolute: string): Promise<boolean> {
  const exists = Boolean(await stat(absolute).catch(() => undefined));
  if (exists && !context.readFiles.has(absolute)) throw new ToolError('Read the file first so the change is based on its current contents.');
  return exists;
}

export const writeTool: AgentTool<{ path: string; content: string }> = {
  name: 'Write',
  description: 'Create a file, or replace an existing file entirely. Prefer Edit for changes to existing files. An existing file must be Read first.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string', description: 'The complete new file contents.' } }, required: ['file_path', 'content'], additionalProperties: false },
  capability: 'workspaceWrite',
  parse: (raw) => ({ path: str(raw, 'file_path')!, content: typeof raw.content === 'string' ? raw.content : (() => { throw new ToolError('Parameter "content" must be a string.'); })() }),
  title: (input) => `Write ${input.path}`,
  sensitive: (input, context) => protectedWrite(input.path, context),
  async preview(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path);
    const before = await readFile(absolute, 'utf8').catch(() => '');
    return { kind: 'diff', path: displayPath(context.root, absolute), diff: unifiedDiff(before, input.content, displayPath(context.root, absolute)) };
  },
  async run(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path);
    const existed = await requireRead(context, absolute);
    await context.checkpoints.capture(absolute);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, input.content, 'utf8');
    context.readFiles.add(absolute);
    return `${existed ? 'Replaced' : 'Created'} ${displayPath(context.root, absolute)} (${input.content.split('\n').length} lines).`;
  }
};

export const editTool: AgentTool<{ path: string; oldString: string; newString: string; replaceAll: boolean }> = {
  name: 'Edit',
  description: 'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean', description: 'Replace every occurrence.' } }, required: ['file_path', 'old_string', 'new_string'], additionalProperties: false },
  capability: 'workspaceWrite',
  parse: (raw) => {
    const oldString = typeof raw.old_string === 'string' ? raw.old_string : undefined;
    const newString = typeof raw.new_string === 'string' ? raw.new_string : undefined;
    if (!oldString) throw new ToolError('old_string must be a non-empty string.');
    if (newString === undefined) throw new ToolError('new_string must be a string.');
    if (oldString === newString) throw new ToolError('old_string and new_string are identical; nothing would change.');
    return { path: str(raw, 'file_path')!, oldString, newString, replaceAll: bool(raw, 'replace_all') };
  },
  title: (input) => `Edit ${input.path}`,
  sensitive: (input, context) => protectedWrite(input.path, context),
  async preview(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path);
    const before = await readText(absolute);
    return { kind: 'diff', path: displayPath(context.root, absolute), diff: unifiedDiff(before, applyEdit(before, input), displayPath(context.root, absolute)) };
  },
  async run(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path);
    if (!(await requireRead(context, absolute))) throw new ToolError('File does not exist. Use Write to create it.');
    const before = await readText(absolute);
    const after = applyEdit(before, input);
    await context.checkpoints.capture(absolute);
    await writeFile(absolute, after, 'utf8');
    return `Edited ${displayPath(context.root, absolute)}.`;
  }
};

function applyEdit(text: string, input: { oldString: string; newString: string; replaceAll: boolean }): string {
  const count = text.split(input.oldString).length - 1;
  if (count === 0) throw new ToolError('old_string was not found in the file. Re-read it and copy the exact text, including whitespace.');
  if (count > 1 && !input.replaceAll) throw new ToolError(`old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all.`);
  return input.replaceAll ? text.split(input.oldString).join(input.newString) : text.replace(input.oldString, () => input.newString);
}

async function walk(root: string, start: string, visit: (absolute: string, relative: string) => void, signal: AbortSignal, includeSkipped: boolean): Promise<void> {
  const stack = [start];
  while (stack.length) {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const directory = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (includeSkipped || !SKIP_DIRS.has(entry.name)) stack.push(absolute); }
      else if (entry.isFile()) visit(absolute, path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
}

export const globTool: AgentTool<{ pattern: string; path?: string }> = {
  name: 'Glob',
  description: 'Find files by glob pattern, such as "**/*.ts" or "src/**/test/*.ts". Returns workspace-relative paths, most recently modified first. Skips .git, node_modules, and build output unless the pattern names them.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search; defaults to the workspace root.' } }, required: ['pattern'], additionalProperties: false },
  capability: 'read',
  parse: (raw) => ({ pattern: str(raw, 'pattern')!, path: str(raw, 'path', false) }),
  title: (input) => `Find ${input.pattern}${input.path ? ` in ${input.path}` : ''}`,
  async run(input, context) {
    const base = await resolveInWorkspace(context.root, input.path ?? '.', context.readOnlyRoots);
    const includeSkipped = [...SKIP_DIRS].some((name) => input.pattern.includes(name));
    const found: Array<{ relative: string; absolute: string }> = [];
    await walk(context.root, base, (absolute, relative) => {
      const fromBase = path.relative(base, absolute).split(path.sep).join('/');
      if (matchesGlob(input.pattern, fromBase)) found.push({ relative, absolute });
    }, context.signal, includeSkipped);
    if (!found.length) return 'No files matched.';
    const withTimes = await Promise.all(found.slice(0, 5_000).map(async (file) => ({ ...file, mtime: (await stat(file.absolute).catch(() => undefined))?.mtimeMs ?? 0 })));
    withTimes.sort((a, b) => b.mtime - a.mtime);
    const shown = withTimes.slice(0, 500).map((file) => file.relative);
    return found.length > shown.length ? `${shown.join('\n')}\n\n[${found.length - shown.length} more files. Narrow the pattern.]` : shown.join('\n');
  }
};

type GrepMode = 'files_with_matches' | 'content' | 'count';
export const grepTool: AgentTool<{ pattern: string; path?: string; glob?: string; mode: GrepMode; ignoreCase: boolean; context: number; headLimit: number }> = {
  name: 'Grep',
  description: 'Search file contents with a regular expression (ripgrep syntax). output_mode: "files_with_matches" (default) lists files, "content" shows matching lines with line numbers, "count" shows matches per file. Filter files with glob (e.g. "*.ts").',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] }, '-i': { type: 'boolean', description: 'Case-insensitive.' }, context: { type: 'number', description: 'Lines of context around each match (content mode).' }, head_limit: { type: 'number', description: 'Maximum lines of output.' } }, required: ['pattern'], additionalProperties: false },
  capability: 'read',
  parse: (raw) => {
    const mode = (str(raw, 'output_mode', false) ?? 'files_with_matches') as GrepMode;
    if (!['files_with_matches', 'content', 'count'].includes(mode)) throw new ToolError('output_mode must be files_with_matches, content, or count.');
    return { pattern: str(raw, 'pattern')!, path: str(raw, 'path', false), glob: str(raw, 'glob', false), mode, ignoreCase: bool(raw, '-i'), context: Math.min(20, Math.max(0, Math.floor(num(raw, 'context') ?? 0))), headLimit: Math.min(2_000, Math.max(1, Math.floor(num(raw, 'head_limit') ?? 250))) };
  },
  title: (input) => `Search for ${JSON.stringify(input.pattern)}${input.glob ? ` in ${input.glob}` : ''}`,
  sensitive: (input, context) => sensitiveRead(input.path, context),
  async run(input, context) {
    const base = await resolveInWorkspace(context.root, input.path ?? '.', context.readOnlyRoots);
    const output = context.ripgrepPath ? await ripgrep(context.ripgrepPath, base, input, context) : await jsGrep(base, input, context);
    // Credential-looking files are left out unless the search was aimed at one (which asked first).
    const aimed = input.path !== undefined && isSensitivePath(input.path);
    const all = output.split('\n').filter(Boolean).map((line) => line.startsWith(context.root) ? displayPath(context.root, line.split(':')[0]) + line.slice(line.split(':')[0].length) : line);
    const lines = aimed ? all : all.filter((line) => !isSensitivePath(line.split(':')[0]));
    const hidden = all.length - lines.length;
    if (!lines.length) return hidden ? `No matches outside files that look like credentials (${hidden} line${hidden === 1 ? '' : 's'} hidden; search that file by path to include it).` : 'No matches.';
    return lines.length > input.headLimit ? `${lines.slice(0, input.headLimit).join('\n')}\n\n[${lines.length - input.headLimit} more lines. Narrow the search or raise head_limit.]` : lines.join('\n');
  }
};

function ripgrep(rg: string, base: string, input: Parameters<typeof grepTool.run>[0], context: ToolContext): Promise<string> {
  const args = ['--no-heading', '--color', 'never', '--max-columns', '500'];
  if (input.mode === 'files_with_matches') args.push('--files-with-matches');
  if (input.mode === 'count') args.push('--count');
  if (input.mode === 'content') { args.push('--line-number'); if (input.context) args.push('-C', String(input.context)); }
  if (input.ignoreCase) args.push('-i');
  if (input.glob) args.push('--glob', input.glob);
  // Same exclusions as Glob and the JS fallback, even where no .gitignore exists.
  for (const dir of SKIP_DIRS) if (!`${input.path ?? ''}${input.glob ?? ''}`.includes(dir)) args.push('--glob', `!${dir}/`);
  args.push('--', input.pattern, base);
  return new Promise((resolve, reject) => {
    execFile(rg, args, { cwd: context.root, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, signal: context.signal }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code !== 1) reject(new ToolError(truncate(stderr || error.message)));
      else resolve(stdout);
    });
  });
}

async function jsGrep(base: string, input: Parameters<typeof grepTool.run>[0], context: ToolContext): Promise<string> {
  let regex: RegExp;
  try { regex = new RegExp(input.pattern, input.ignoreCase ? 'i' : ''); } catch (error) { throw new ToolError(`Invalid regular expression: ${(error as Error).message}`); }
  const files: string[] = [];
  const info = await stat(base);
  if (info.isFile()) files.push(base);
  else await walk(context.root, base, (absolute, relative) => { if (!input.glob || matchesGlob(input.glob, relative)) files.push(absolute); }, context.signal, false);
  const out: string[] = [];
  for (const file of files) {
    let text: string;
    try { text = await readText(file); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const hits = lines.map((line, index) => (regex.test(line) ? index : -1)).filter((index) => index >= 0);
    if (!hits.length) continue;
    if (input.mode === 'files_with_matches') out.push(file);
    else if (input.mode === 'count') out.push(`${file}:${hits.length}`);
    else for (const hit of hits) for (let index = Math.max(0, hit - input.context); index <= Math.min(lines.length - 1, hit + input.context); index += 1) out.push(`${file}:${index + 1}:${lines[index]}`);
    if (out.length > 5_000) break;
  }
  return out.join('\n');
}

export const bashTool: AgentTool<{ command: string; timeoutMs: number; background: boolean; description?: string }> = {
  name: 'Bash',
  description: 'Run a shell command in a persistent bash session rooted at the workspace (cd and exported variables carry over). Use for builds, tests, git, and package managers; use Read/Glob/Grep instead of cat/find/grep. Set run_in_background for long-running processes such as dev servers, then poll with BashOutput.',
  parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string', description: 'Five to ten words on what the command does.' }, timeout: { type: 'number', description: `Milliseconds, up to ${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS}).` }, run_in_background: { type: 'boolean' } }, required: ['command'], additionalProperties: false },
  capability: 'shell',
  parse: (raw) => ({ command: str(raw, 'command')!, timeoutMs: num(raw, 'timeout') ?? DEFAULT_TIMEOUT_MS, background: bool(raw, 'run_in_background'), description: str(raw, 'description', false) }),
  title: (input) => input.description ? `${input.description}` : `Run ${input.command.split('\n')[0].slice(0, 80)}`,
  async preview(input, context) { return { kind: 'command', command: input.command, cwd: displayPath(context.root, context.shell.workingDirectory) || '.', background: input.background }; },
  async run(input, context) {
    if (input.background) return `Started in the background with id ${context.shell.startBackground(input.command)}. Read its output with BashOutput.`;
    const result = await context.shell.run(input.command, input.timeoutMs, context.signal);
    const status = result.timedOut ? 'killed' : `exit code ${result.exitCode}`;
    return `${result.output.trimEnd() || '(no output)'}\n\n[${status}]`;
  }
};

export const bashOutputTool: AgentTool<{ id: string }> = {
  name: 'BashOutput',
  description: 'Read new output from a background command started with Bash run_in_background, and whether it is still running.',
  parameters: { type: 'object', properties: { bash_id: { type: 'string' } }, required: ['bash_id'], additionalProperties: false },
  capability: 'read',
  parse: (raw) => ({ id: str(raw, 'bash_id')! }),
  title: (input) => `Check ${input.id}`,
  async run(input, context) {
    const job = context.shell.readBackground(input.id);
    return `${job.output.trimEnd() || '(no new output)'}\n\n[${job.running ? 'still running' : `exited with code ${job.exitCode}`}]`;
  }
};

export const killShellTool: AgentTool<{ id: string }> = {
  name: 'KillShell',
  description: 'Stop a background command started with Bash run_in_background.',
  parameters: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'], additionalProperties: false },
  capability: 'shell',
  parse: (raw) => ({ id: str(raw, 'shell_id')! }),
  title: (input) => `Stop ${input.id}`,
  async run(input, context) { return context.shell.kill(input.id) ? `Stopped ${input.id}.` : `${input.id} was not running.`; }
};

export const todoTool: AgentTool<{ todos: Todo[] }> = {
  name: 'TodoWrite',
  description: 'Create or update the task list for this run. Use it for work with three or more steps: list the steps, keep exactly one in_progress, and mark each completed as soon as it is done. Send the full list every time.',
  parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string', description: 'Present-tense form shown while in progress, e.g. "Running tests".' } }, required: ['content', 'status'], additionalProperties: false } } }, required: ['todos'], additionalProperties: false },
  capability: 'plan',
  parse: (raw) => {
    if (!Array.isArray(raw.todos)) throw new ToolError('todos must be an array.');
    const todos = raw.todos.slice(0, 50).map((item) => {
      const value = (item ?? {}) as Record<string, unknown>;
      const status = value.status;
      if (typeof value.content !== 'string' || !value.content.trim()) throw new ToolError('Every todo needs content.');
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new ToolError('status must be pending, in_progress, or completed.');
      return { content: value.content.slice(0, 300), status, ...(typeof value.activeForm === 'string' ? { activeForm: value.activeForm.slice(0, 300) } : {}) } as Todo;
    });
    return { todos };
  },
  title: (input) => `Update tasks (${input.todos.filter((todo) => todo.status === 'completed').length}/${input.todos.length} done)`,
  async run(input, context) {
    context.onTodos?.(input.todos);
    return 'Task list updated.';
  }
};

export const CORE_TOOLS: AgentTool<any>[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool, bashOutputTool, killShellTool, todoTool];

/** VS Code bundles ripgrep; its location moved between releases. Returns undefined to use the JS fallback. */
export function findRipgrep(appRoot: string, exists: (candidate: string) => boolean): string | undefined {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const target = `${process.platform}-${process.arch}`;
  const candidates = ['node_modules.asar.unpacked', 'node_modules'].flatMap((modules) => [
    path.join(appRoot, modules, '@vscode', 'ripgrep-universal', 'bin', target, binary),
    path.join(appRoot, modules, '@vscode', 'ripgrep', 'bin', binary)
  ]);
  return candidates.find(exists);
}
