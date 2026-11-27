import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { MAX_COMMAND_LENGTH, MAX_COMMAND_WORDS } from '../domain/commandBounds';
import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { parseToolManifest } from '../domain/gate/manifest';
import { contentsOf } from '../domain/gate/pathCover';
import { CREDENTIAL_STORES, EXTENSION_STORAGE_FOLDERS, VSCODE_SECRET_FILES, credentialReason, identityFilesReason, namesCredentialStore, namesIdentityFiles } from '../domain/gate/floor';
import type { FloorLocations } from '../domain/gate/floor';
import type { InputAs, RunsOn, ToolManifest } from '../domain/gate/manifest';
import { bundleHash, type BundleState, type GateContextName } from '../domain/gate/bundle';
import type { GateRuntime } from '../domain/gate/decide';
import type { Capability } from '../domain/gate/vocabulary';
import type { Label } from '../domain/gate/labels';
import { namesStateKeys, protectedWriteReason, STATE_FOLDER_PATH, STATE_KEYS_PATH, stateKeysReason } from '../domain/protectedPaths';
import { writeAllowedBy } from '../domain/staff/writeLimits';
import type { RunCheckpoints } from './checkpoints';
import { unifiedDiff } from './diff';
import { matchesGlob } from './glob';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, ShellSession, truncate } from './shell';
import { NETWORK_COMMAND } from './untrusted';
import { isReadOnlyShellCommand } from './readOnlyShell';
import { displayPath, resolveInWorkspace, StateKeysError, ToolError } from './workspace';

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

type FixtureEffect = { readonly verb: 'plan' } | { readonly verb: 'workspaceWrite'; readonly path: string };

export interface FixtureGateExpectation {
  readonly policyHash: string;
  readonly currentActionSettings: () => unknown;
  readonly effect: FixtureEffect;
}

/** Evidence for a synthetic child call. It narrows an ordinary gate decision and cannot authorize a call. */
export function bindFixtureGate(runtime: GateRuntime, readPolicy: () => ActionPolicy, expected: FixtureGateExpectation,
  child: Pick<ToolContext, 'agentId' | 'agentLabel'>) {
  const policy = Object.freeze({ ...readPolicy() });
  const { deviceFingerprint, sessionId } = runtime.actor;
  const { agentId, agentLabel } = child;
  const { context, presence } = runtime;
  const hash = expected.policyHash;
  const effect = Object.freeze({ ...expected.effect });
  const currentActionSettings = expected.currentActionSettings;
  const requestModeValid = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'].includes(policy.mode);
  const sample = (candidate = runtime): BundleState | undefined => {
    if (candidate !== runtime) return undefined;
    try { return runtime.bundleState(); } catch { return undefined; }
  };
  const current = (state = sample()): boolean => {
    const settings = readPolicy();
    const live = runtime.actor;
    if (!agentId || !agentLabel || child.agentId !== agentId || child.agentLabel !== agentLabel ||
        live.kind !== 'sub-agent' || live.agentId !== agentId || live.agentLabel !== agentLabel ||
        live.sessionId !== sessionId || live.deviceFingerprint !== deviceFingerprint ||
        context !== 'interactive' || presence !== 'person' || runtime.context !== context || runtime.presence !== presence ||
        !requestModeValid || policy.emergencyStop !== false || settings.mode !== policy.mode || settings.emergencyStop !== false ||
        state?.state !== 'valid' || state.hash !== hash || state.expiresAt !== state.bundle.expiresAt ||
        !(Date.parse(state.expiresAt) > (runtime.clock ?? Date.now)())) return false;
    try {
      const active = currentActionSettings();
      if (!active || typeof active !== 'object' || Array.isArray(active) ||
          !Object.hasOwn(active, 'mode') || !Object.hasOwn(active, 'emergencyStop')) return false;
      const { mode, emergencyStop } = active as Partial<ActionPolicy>;
      return mode === policy.mode && emergencyStop === false && bundleHash(state.bundle) === hash;
    } catch { return false; }
  };
  const permits = (effects: readonly Capability[]): boolean => {
    const actual = effects[0];
    return effects.length === 1 && (effect.verb === 'plan' ? actual?.verb === 'plan'
      : actual?.verb === 'workspaceWrite' && actual.paths.length === 1 && actual.paths[0] === effect.path);
  };
  return Object.freeze({ policy, hash, effect, sample, current, permits });
}

export interface ToolContext {
  root: string;
  signal: AbortSignal;
  /** Supplied only for a permitted opt-in call, through the end of that exact dispatch. */
  verifyFixtureGate?: (input: unknown, path?: string) => boolean;
  checkpoints: RunCheckpoints;
  shell: ShellSession;
  /** Files read in this run; Write and Edit refuse to change an existing file the model has not read. */
  readFiles: Set<string>;
  ripgrepPath?: string;
  onTodos?: (todos: Todo[]) => void;
  /** Directories Read, Glob, and Grep may also use (the Open-GSD runtime); never writable. */
  readOnlyRoots?: string[];
  /** The Open-GSD runtime SovAI installed and verified, whose gsd-tools the auto mode may run (see CommandContext). */
  trustedToolRoots?: string[];
  /** The managed Open-GSD runtime and the workflow preambles it ships, for the auto mode's gsd_run check. */
  gsdRuntime?: { home: string; preambles: string[] };
  /** Whether this run has read outside content (web pages, search results, attachments, MCP results). */
  tainted?(): boolean;
  /** Text of pages fetched in this run, by URL, for CheckCitations and CheckOriginality. */
  pages?: Map<string, string>;
  /** When set, writes outside this workspace-relative folder ask first (research agents write only .planning/). */
  writeScope?: string;
  /**
   * When set, Write and Edit refuse (never ask) any path outside these workspace-relative entries: a folder ends in `/`, anything else is one file.
   * A staff team's red team and release guard get one (src/domain/staff/writeLimits.ts), so a critique or a verdict can never change a plan file.
   */
  writeOnly?: readonly string[];
  /** Reports a defense that acted: hidden content removed, a likely injection flagged, an action held or blocked. */
  onSecurity?(event: SecurityEvent): void;
  /** 0.4.23: the agent making the call (its activity id, and a sub-agent's label), so a card it raises in the main chat says who asked. */
  agentId?: string;
  agentLabel?: string;
  /**
   * Whether the agent may see a project-relative path in a search's results (CLAS-03): false for a file whose label the person's clearances do not cover.
   * The loop builds it from the run's labels before a read tool runs; Glob and Grep leave such paths out and say how many they hid. Absent means no check.
   */
  canRead?: (relativePath: string) => boolean;
  /**
   * Raises the session's mark by the labels of the project-relative paths a search returns (CLAS-04, D-54). Glob and Grep call it before their results
   * reach the model; when it throws, the search fails rather than return results whose labels could not be counted.
   */
  noteRead?: (relativePaths: readonly string[]) => Promise<void>;
  /**
   * Whether the person's clearances cover a label held on a record rather than a file (an observation row, research note 11, 3.2). The loop builds it from
   * the policy before a read tool runs, by the same check as `canRead`. Absent means no gate: a tool that reads labelled records then shows nothing labelled.
   */
  canReadLabel?: (label: Label) => boolean;
  /** Raises the session's mark by the labels of the records a tool's result shows (CLAS-04), as `noteRead` does for paths. */
  noteLabels?: (labels: readonly Label[]) => Promise<void>;
}

/** The plain note a search adds when it left out results for their labels. */
export function labelHiddenNote(count: number, what: 'file' | 'line'): string {
  return `${String(count)} ${what}${count === 1 ? '' : 's'} hidden because ${count === 1 ? 'its file is' : 'their files are'} labelled above your clearance.`;
}

/** The tools an agent is offered: those whose `offeredTo` lets it (`agentLabel` undefined is the run's lead). Offered equals allowed by caller. */
export function offeredTools<T extends Pick<AgentTool<any>, 'offeredTo'>>(tools: readonly T[], agentLabel: string | undefined): T[] {
  return tools.filter((tool) => tool.offeredTo?.(agentLabel) ?? true);
}

export interface SecurityEvent { kind: 'injection' | 'hidden-content' | 'held' | 'blocked'; source: string; detail: string }

/** What an approval card shows before a risky call runs. */
export type ToolPreview = { kind: 'diff'; path: string; diff: string } | { kind: 'command'; command: string; cwd: string; background: boolean } | { kind: 'note'; text: string };

export interface AgentTool<I = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability: ActionCapability;
  /**
   * What this tool can do, in the capability vocabulary (GATE-02, D-05), declared next to the tool and required: a tool without one does not compile, so no
   * tool can be added without saying what it does. The gate reads it for the call's effects and the Tools page and the team member cards read it for the
   * words; neither changes the settings layer's answer (`capability` above), which D-04 keeps.
   */
  manifest: ToolManifest;
  /**
   * The call's arguments as the manifest reads them: the defaults the tool applies itself written out (a Glob with no path searches the project, so
   * its path is `**`), because a manifest names fields and cannot say "or the default". Absent means the arguments are used as given.
   */
  manifestInput?(raw: Record<string, unknown>): Record<string, unknown>;
  /** Private synthetic child invocation. The expectation derives only from the admitted input. */
  fixtureGate?(input: I): FixtureGateExpectation;
  /** Changes nothing, so it can run alongside other lookups from the same turn even though it is not a read (e.g. a web fetch). */
  concurrent?: boolean;
  /** PERF-04: this particular call changes nothing (a read-only shell command), so it may run alongside other lookups. */
  concurrentFor?(input: I): boolean;
  /** Validates the model's arguments; throws ToolError with a message the model can act on. */
  parse(raw: Record<string, unknown>): I;
  /** A short title for the activity row, e.g. "Read src/extension.ts". */
  title(input: I, context: ToolContext): string;
  preview?(input: I, context: ToolContext): Promise<ToolPreview>;
  /**
   * A reason this call may not run at all, in any approval mode and whatever the person allowed for the run: it names the project's key folder
   * (src/domain/protectedPaths.ts, STATE_KEYS_PATH). Checked before the approval policy, so nothing asks first and nothing can allow it.
   */
  forbidden?(input: I, context: ToolContext): string | undefined | Promise<string | undefined>;
  /**
   * Whether the agent is offered this tool at all: `agentLabel` is a sub-agent's label (a team member's slug), undefined for the run's lead. A tool whose
   * `forbidden` refuses callers by who they are says the same thing here, so an agent is never offered a tool it may not call (0.4.35: the J2 lead was
   * offered the COP map's tools, called one and was refused). `forbidden` stays the check at call time. Absent means every agent is offered it.
   */
  offeredTo?(agentLabel: string | undefined): boolean;
  /** A reason to always ask first, e.g. reading a likely credential file or writing into `.git/`. */
  sensitive?(input: I, context: ToolContext): string | undefined | Promise<string | undefined>;
  /** A reason to ask even under fully-autonomous mode, e.g. a command that could send data out after the run read untrusted content. */
  risky?(input: I, context: ToolContext): string | undefined | Promise<string | undefined>;
  /** Its result is outside content: the run is treated as having read untrusted input from then on. */
  untrusted?: boolean;
  /** The id of the MCP server this tool calls, set only on MCP tools: the gate judges the server's label ceiling by it (WP-GATE). */
  mcpServer?: string;
  /**
   * 0.4.17: in Auto mode this tool runs without asking, and its own checks still apply (WebFetch's exfiltration check after outside content). Only the
   * two web tools set it, by the owner's decision that research must not be a stream of questions; an MCP or remote tool with the network
   * capability keeps asking, because nothing here knows what it sends.
   */
  autoSafe?: boolean;
  run(input: I, context: ToolContext): Promise<string>;
}

/** A manifest effect value read from one named argument of the call (the argument's name as the model sends it, not the parsed field's). */
export function fromArgument(field: string, as: InputAs = 'path'): { from: 'input'; field: string; as: InputAs } {
  return { from: 'input', field, as };
}

export const INTERACTIVE_AND_UNATTENDED: readonly GateContextName[] = Object.freeze(['interactive', 'unattended'] as const);
export const INTERACTIVE_ONLY: readonly GateContextName[] = Object.freeze(['interactive'] as const);

/**
 * Declares a built-in tool's manifest. The draft goes through the same parser a bundle or a member card would use, so a declaration the format
 * would refuse stops the extension from loading, not a call at run time. The result is frozen deeply by the parser. A built-in tool runs on this machine; a tool of a
 * remote MCP server says `remote`.
 */
export function declareManifest(draft: { tool: string; effects: readonly unknown[]; hosts?: readonly string[]; contexts: readonly GateContextName[]; untrusted?: boolean; runsOn?: RunsOn }): ToolManifest {
  const parsed = parseToolManifest({ manifestVersion: 1, tool: draft.tool, effects: draft.effects, hosts: draft.hosts ?? [], credentials: [], contexts: draft.contexts, untrusted: draft.untrusted ?? false, runsOn: draft.runsOn ?? 'this-machine' });
  if (!parsed.ok) throw new Error(`The manifest of ${draft.tool} is not valid (${parsed.reason} at ${parsed.path || 'the top'}).`);
  return parsed.value;
}

/** A call with no `path` argument means the whole project, so the manifest reads `**` (Glob, Grep, CheckOriginality). A path the call names is passed as given. */
export function withDefaultPath(raw: Record<string, unknown>): Record<string, unknown> {
  return typeof raw.path === 'string' && raw.path !== '' ? raw : { ...raw, path: '**' };
}

/**
 * The Glob and Grep form of that: the project root written as `.` or `./` is `**`, as an empty or missing path always was. A folder name is read as the folder
 * and everything under it by the manifest's `folder` source (owner-confirmed, PR #70 review), so no other change is made here.
 */
export function withRootPath(raw: Record<string, unknown>): Record<string, unknown> {
  const given = withDefaultPath(raw);
  // Only a relative spelling of the root: `/` or `C:\` is the machine's root, not the project's, and stays as written so the gate refuses it.
  const isRoot = typeof given.path === 'string' && !path.isAbsolute(given.path) && !/[\\]/.test(given.path) && contentsOf(given.path) === '**';
  return isRoot ? { ...given, path: '**' } : given;
}

/** Files that usually hold credentials; reading one asks first, since its contents go to the model. */
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|id_[a-z0-9]+|[^/]*\.(?:pem|key|p12|pfx|keystore)|credentials?(?:\.[a-z]+)?|secrets?(?:\.[a-z]+)?)$|\.near-credentials|\.aws\/|\.ssh\//i;

export function sensitivePathReason(requested: string): string | undefined {
  return isSensitivePath(requested) ? `${requested} looks like it may contain credentials, and its contents would be sent to the model.` : undefined;
}

/** Tests the path as written (normalized, so `.env/` and `./.env/.` count) and as it resolves. */
export function isSensitivePath(file: string): boolean {
  const normalized = path.posix.normalize(file.replace(/\\/g, '/')).replace(/\/+$/, '');
  // The project's state folder holds its keys (27-REVIEW minor commandSafety.ts:319): reading anything in it asks.
  return SENSITIVE_FILE.test(normalized) || STATE_FOLDER_PATH.test(normalized);
}

/** Reading a path asks first when either the path or the file it resolves to looks like a credential. */
export async function sensitiveRead(requested: string | undefined, context: ToolContext): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  if (isSensitivePath(requested)) return sensitivePathReason(requested);
  const resolved = await resolveInWorkspace(context.root, requested, context.readOnlyRoots).catch(() => undefined);
  return resolved && isSensitivePath(resolved) ? `${requested} resolves to ${resolved}, which looks like it may contain credentials, and its contents would be sent to the model.` : undefined;
}

/** Whether a path (relative or absolute, either slash) is in the project's key folder, which agents may not use at all. */
export function isStateKeysPath(file: string): boolean {
  return STATE_KEYS_PATH.test(path.posix.normalize(file.replace(/\\/g, '/')));
}

/**
 * The reason a path the agent named may not be used: it is in the project's key folder as written, or resolves there (through a link, `..`, or an
 * absolute path). Undefined for any other path, and for a path that cannot be resolved (the tool's own check reports that).
 */
export async function forbiddenPath(requested: string | undefined, context: ToolContext): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  if (isStateKeysPath(requested) || namesStateKeys(requested)) return stateKeysReason(requested);
  // resolveInWorkspace itself refuses a path that resolves into the key folder (through a link, say): that refusal is this answer.
  return resolveInWorkspace(context.root, requested, context.readOnlyRoots).then(() => undefined, (error) => (error instanceof StateKeysError ? error.message : undefined));
}

/**
 * The refusal for a write outside the agent's write limit (ToolContext.writeOnly), or undefined when the agent has no limit or the path is inside it. The
 * path is resolved first, so `..`, an absolute path or a link cannot step out of the limit; a path that cannot be resolved is refused.
 */
export async function writeOnlyRefusal(requested: string, context: ToolContext): Promise<string | undefined> {
  const limit = context.writeOnly;
  if (!limit) return undefined;
  const allowed = limit.join(', ');
  const resolved = await resolveInWorkspace(context.root, requested).catch(() => undefined);
  if (!resolved) return `${requested} is not a path this agent may write. It may write only ${allowed}.`;
  const relative = path.relative(context.root, resolved).split(path.sep).join('/');
  return writeAllowedBy(limit, relative) ? undefined : `${requested} is outside what this agent may write (${allowed}). It cannot change any other file, plan files included: report what should change instead.`;
}

/** Writes that always ask, even after "allow edits for this run": see src/domain/protectedPaths.ts, which the shell guard shares. */
export async function protectedWrite(requested: string, context: ToolContext): Promise<string | undefined> {
  const resolved = await resolveInWorkspace(context.root, requested).catch(() => undefined);
  const relative = resolved ? path.relative(context.root, resolved).split(path.sep).join('/') : requested;
  if (relative.endsWith('.planning/.near-ai/team.md')) return undefined;
  if (context.writeScope && !(relative === context.writeScope || relative.startsWith(`${context.writeScope.replace(/\/$/, '')}/`))) return `${requested} is outside ${context.writeScope}, where this agent's work belongs. Approve this write only if you expect it.`;
  return protectedWriteReason(relative, requested);
}

/** A write outside the agent's folder after it read outside content asks even under fully-autonomous mode. */
async function outOfScopeAfterTaint(requested: string, context: ToolContext): Promise<string | undefined> {
  if (!context.writeScope || !context.tainted?.()) return undefined;
  const reason = await protectedWrite(requested, context);
  return reason?.includes(context.writeScope) ? `${reason} This agent has read outside content, which may have asked for this write.` : undefined;
}

const MAX_READ_LINES = 2_000;
/**
 * PERF-02: a Read without a range on a file longer than this returns only its first RANGED_READ_LINES lines, with the file's length and an outline, so
 * the agent asks for the part it needs instead of putting 2,000 lines into every later turn's context.
 */
export const LARGE_FILE_LINES = 600;
export const RANGED_READ_LINES = 400;
const MAX_OUTLINE_ENTRIES = 60;

/** Headings (Markdown) or top-level declarations (code) with their line numbers, so a ranged read can be aimed. */
export function fileOutline(lines: string[], file: string): string[] {
  const markdown = /\.(?:md|markdown|mdx|txt)$/i.test(file);
  const pattern = markdown ? /^#{1,6}\s+\S/ : /^(?:export\s+|async\s+)*(?:function|class|interface|type|const|enum|def|struct|impl|fn|func)\b|^##?\s/;
  const found: string[] = [];
  lines.forEach((line, index) => { if (found.length < MAX_OUTLINE_ENTRIES && pattern.test(line)) found.push(`${String(index + 1).padStart(6)}  ${line.trim().slice(0, 120)}`); });
  return found;
}
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

export const readTool: AgentTool<{ path: string; offset: number; limit: number; ranged?: boolean }> = {
  name: 'Read',
  description: 'Read a text file from the workspace. Returns lines prefixed with line numbers (`   12\\t...`). Pass offset (1-based line) and limit to read a range, up to 2000 lines at once. Without a range, a file over 600 lines returns its first 400 lines with an outline, so read large files in parts. Read a file before editing or overwriting it.',
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path relative to the workspace root, or absolute inside it.' }, offset: { type: 'number', description: 'First line to read (1-based).' }, limit: { type: 'number', description: 'Number of lines to read.' } }, required: ['file_path'], additionalProperties: false },
  capability: 'read',
  manifest: declareManifest({ tool: 'Read', effects: [{ verb: 'read', paths: [fromArgument('file_path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw) => ({ path: str(raw, 'file_path')!, offset: Math.max(1, Math.floor(num(raw, 'offset') ?? 1)), limit: Math.min(MAX_READ_LINES, Math.max(1, Math.floor(num(raw, 'limit') ?? MAX_READ_LINES))), ranged: num(raw, 'offset') !== undefined || num(raw, 'limit') !== undefined }),
  title: (input) => `Read ${input.path}`,
  forbidden: (input, context) => forbiddenPath(input.path, context),
  sensitive: (input, context) => sensitiveRead(input.path, context),
  async run(input, context) {
    const absolute = await resolveInWorkspace(context.root, input.path, context.readOnlyRoots);
    const text = await readText(absolute);
    context.readFiles.add(absolute);
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return '(empty file)';
    const large = !input.ranged && lines.length > LARGE_FILE_LINES;
    const slice = lines.slice(input.offset - 1, input.offset - 1 + (large ? RANGED_READ_LINES : input.limit));
    const width = String(input.offset + slice.length).length;
    const body = slice.map((line, index) => `${String(input.offset + index).padStart(width)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line}`).join('\n');
    const remaining = lines.length - (input.offset - 1 + slice.length);
    if (large) {
      const outline = fileOutline(lines, absolute);
      return `${body}\n\n[This file has ${lines.length} lines; only the first ${slice.length} are shown. Read the part you need with offset and limit${outline.length ? ', using this outline (line numbers)' : ''}.]${outline.length ? `\n${outline.join('\n')}` : ''}`;
    }
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
  manifest: declareManifest({ tool: 'Write', effects: [{ verb: 'workspaceWrite', paths: [fromArgument('file_path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw) => ({ path: str(raw, 'file_path')!, content: typeof raw.content === 'string' ? raw.content : (() => { throw new ToolError('Parameter "content" must be a string.'); })() }),
  title: (input) => `Write ${input.path}`,
  forbidden: async (input, context) => (await forbiddenPath(input.path, context)) ?? writeOnlyRefusal(input.path, context),
  sensitive: (input, context) => protectedWrite(input.path, context),
  risky: (input, context) => outOfScopeAfterTaint(input.path, context),
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
  manifest: declareManifest({ tool: 'Edit', effects: [{ verb: 'workspaceWrite', paths: [fromArgument('file_path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw) => {
    const oldString = typeof raw.old_string === 'string' ? raw.old_string : undefined;
    const newString = typeof raw.new_string === 'string' ? raw.new_string : undefined;
    if (!oldString) throw new ToolError('old_string must be a non-empty string.');
    if (newString === undefined) throw new ToolError('new_string must be a string.');
    if (oldString === newString) throw new ToolError('old_string and new_string are identical; nothing would change.');
    return { path: str(raw, 'file_path')!, oldString, newString, replaceAll: bool(raw, 'replace_all') };
  },
  title: (input) => `Edit ${input.path}`,
  forbidden: async (input, context) => (await forbiddenPath(input.path, context)) ?? writeOnlyRefusal(input.path, context),
  sensitive: (input, context) => protectedWrite(input.path, context),
  risky: (input, context) => outOfScopeAfterTaint(input.path, context),
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

function applyEdit(text: string, edit: { oldString: string; newString: string; replaceAll: boolean }): string {
  const input = matchLineEndings(text, edit);
  const count = text.split(input.oldString).length - 1;
  if (count === 0) throw new ToolError('old_string was not found in the file. Re-read it and copy the exact text, including whitespace.');
  if (count > 1 && !input.replaceAll) throw new ToolError(`old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all.`);
  return input.replaceAll ? text.split(input.oldString).join(input.newString) : text.replace(input.oldString, () => input.newString);
}

/**
 * Read shows a CRLF file without its \r, so the model's old_string and new_string arrive with \n line breaks. In a file
 * that uses \r\n, both are converted to \r\n, unless only the text as given matches (a file with mixed line endings).
 */
function matchLineEndings(text: string, input: { oldString: string; newString: string; replaceAll: boolean }): { oldString: string; newString: string; replaceAll: boolean } {
  if (!text.includes('\r\n')) return input;
  // old_string and new_string always take the SAME line endings as the text they match, so an edit never introduces a new mix: CRLF where the
  // match is CRLF, LF where (in a mixed file) only the LF form matches.
  const crlf = { ...input, oldString: input.oldString.replace(/\r?\n/g, '\r\n'), newString: input.newString.replace(/\r?\n/g, '\r\n') };
  if (text.includes(crlf.oldString)) return crlf;
  const lf = { ...input, oldString: input.oldString.replace(/\r\n/g, '\n'), newString: input.newString.replace(/\r\n/g, '\n') };
  return text.includes(lf.oldString) ? lf : input;
}

/** The skipped directories a glob or path names as a whole segment (`node_modules/**`), which are searched after all. */
function namedSkipDirs(...patterns: Array<string | undefined>): Set<string> {
  const segments = new Set(patterns.flatMap((pattern) => (pattern ?? '').split(/[\\/]/)));
  return new Set([...SKIP_DIRS].filter((name) => segments.has(name)));
}

async function walk(root: string, start: string, visit: (absolute: string, relative: string) => void, signal: AbortSignal, unskipped: ReadonlySet<string>): Promise<void> {
  const stack = [start];
  while (stack.length) {
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const directory = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      // The key folder is never listed or searched, whatever the pattern (0.4.23).
      if (isStateKeysPath(absolute.split(path.sep).join('/'))) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) || unskipped.has(entry.name)) stack.push(absolute); }
      else if (entry.isFile()) visit(absolute, path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
}

export const globTool: AgentTool<{ pattern: string; path?: string }> = {
  name: 'Glob',
  description: 'Find files by glob pattern, such as "**/*.ts" or "src/**/test/*.ts". Returns workspace-relative paths, most recently modified first. Skips .git, node_modules, and build output unless the pattern names them.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search; defaults to the workspace root.' } }, required: ['pattern'], additionalProperties: false },
  capability: 'read',
  manifest: declareManifest({ tool: 'Glob', effects: [{ verb: 'read', paths: [fromArgument('path'), fromArgument('path', 'folder')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  manifestInput: withRootPath,
  parse: (raw) => ({ pattern: str(raw, 'pattern')!, path: str(raw, 'path', false) }),
  title: (input) => `Find ${input.pattern}${input.path ? ` in ${input.path}` : ''}`,
  forbidden: async (input, context) => (isStateKeysPath(input.pattern) || namesStateKeys(input.pattern) ? stateKeysReason(input.pattern) : forbiddenPath(input.path, context)),
  async run(input, context) {
    const base = await resolveInWorkspace(context.root, input.path ?? '.', context.readOnlyRoots);
    const unskipped = namedSkipDirs(input.pattern);
    const found: Array<{ relative: string; absolute: string }> = [];
    let labelHidden = 0;
    await walk(context.root, base, (absolute, relative) => {
      const fromBase = path.relative(base, absolute).split(path.sep).join('/');
      if (!matchesGlob(input.pattern, fromBase)) return;
      // A file labelled above the clearances is left out, and counted, so the agent learns neither its name nor where it is (CLAS-03).
      if (context.canRead !== undefined && !context.canRead(path.relative(context.root, absolute).split(path.sep).join('/'))) { labelHidden += 1; return; }
      found.push({ relative, absolute });
    }, context.signal, unskipped);
    const labelNote = labelHidden > 0 ? `\n\n[${labelHiddenNote(labelHidden, 'file')}]` : '';
    if (found.length) await context.noteRead?.(found.map((file) => path.relative(context.root, file.absolute).split(path.sep).join('/')));
    if (!found.length) return labelHidden > 0 ? `No files matched that you may read. ${labelHiddenNote(labelHidden, 'file')}` : 'No files matched.';
    const withTimes = await Promise.all(found.slice(0, 5_000).map(async (file) => ({ ...file, mtime: (await stat(file.absolute).catch(() => undefined))?.mtimeMs ?? 0 })));
    withTimes.sort((a, b) => b.mtime - a.mtime);
    const shown = withTimes.slice(0, 500).map((file) => file.relative);
    return (found.length > shown.length ? `${shown.join('\n')}\n\n[${found.length - shown.length} more files. Narrow the pattern.]` : shown.join('\n')) + labelNote;
  }
};

export type GrepMode = 'files_with_matches' | 'content' | 'count';
export const grepTool: AgentTool<{ pattern: string; path?: string; glob?: string; mode: GrepMode; ignoreCase: boolean; context: number; headLimit: number }> = {
  name: 'Grep',
  description: 'Search file contents with a regular expression (ripgrep syntax). output_mode: "files_with_matches" (default) lists files, "content" shows matching lines with line numbers, "count" shows matches per file. Filter files with glob (e.g. "*.ts").',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] }, '-i': { type: 'boolean', description: 'Case-insensitive.' }, context: { type: 'number', description: 'Lines of context around each match (content mode).' }, head_limit: { type: 'number', description: 'Maximum lines of output.' } }, required: ['pattern'], additionalProperties: false },
  capability: 'read',
  manifest: declareManifest({ tool: 'Grep', effects: [{ verb: 'read', paths: [fromArgument('path'), fromArgument('path', 'folder')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  manifestInput: withRootPath,
  parse: (raw) => {
    const mode = (str(raw, 'output_mode', false) ?? 'files_with_matches') as GrepMode;
    if (!['files_with_matches', 'content', 'count'].includes(mode)) throw new ToolError('output_mode must be files_with_matches, content, or count.');
    return { pattern: str(raw, 'pattern')!, path: str(raw, 'path', false), glob: str(raw, 'glob', false), mode, ignoreCase: bool(raw, '-i'), context: Math.min(20, Math.max(0, Math.floor(num(raw, 'context') ?? 0))), headLimit: Math.min(2_000, Math.max(1, Math.floor(num(raw, 'head_limit') ?? 250))) };
  },
  title: (input) => `Search for ${JSON.stringify(input.pattern)}${input.glob ? ` in ${input.glob}` : ''}`,
  forbidden: async (input, context) => (input.glob !== undefined && (isStateKeysPath(input.glob) || namesStateKeys(input.glob)) ? stateKeysReason(input.glob) : forbiddenPath(input.path, context)),
  sensitive: (input, context) => sensitiveRead(input.path, context),
  async run(input, context) {
    const base = await resolveInWorkspace(context.root, input.path ?? '.', context.readOnlyRoots);
    const output = context.ripgrepPath ? parseRipgrepOutput(await ripgrep(context.ripgrepPath, base, input, context), input.mode) : await jsGrep(base, input, context);
    // Credential-looking files are left out unless the search was aimed at one (which asked first). Each line carries its
    // file apart from the text, so neither a drive letter (C:\) nor a context line (`file-12-text`) can hide which file it is.
    // The key folder is left out even of a search aimed at the state folder (0.4.23): a search aimed at the key folder itself is refused before it runs.
    const aimed = input.path !== undefined && isSensitivePath(input.path);
    const safe = output.filter((line) => line.file === undefined || ((aimed || !isSensitivePath(line.file)) && !isStateKeysPath(line.file.split(path.sep).join('/'))));
    // A line from a file labelled above the clearances is left out the same way, and counted on its own (CLAS-03).
    const canRead = context.canRead;
    const kept = canRead === undefined ? safe : safe.filter((line) => line.file === undefined || canRead(path.relative(context.root, path.resolve(context.root, line.file)).split(path.sep).join('/')));
    const labelHidden = safe.length - kept.length;
    const labelNote = labelHidden > 0 ? `\n\n[${labelHiddenNote(labelHidden, 'line')}]` : '';
    const hidden = output.length - safe.length;
    const files = [...new Set(kept.flatMap((line) => (line.file === undefined ? [] : [path.relative(context.root, path.resolve(context.root, line.file)).split(path.sep).join('/')])))];
    if (files.length) await context.noteRead?.(files);
    const lines = kept.map((line) => (line.file === undefined ? line.text : `${displayPath(context.root, line.file)}${line.text}`));
    if (!lines.length) {
      if (labelHidden > 0) return `No matches you may read. ${labelHiddenNote(labelHidden, 'line')}`;
      return hidden ? `No matches outside files that look like credentials (${hidden} line${hidden === 1 ? '' : 's'} hidden; search that file by path to include it).` : 'No matches.';
    }
    return (lines.length > input.headLimit ? `${lines.slice(0, input.headLimit).join('\n')}\n\n[${lines.length - input.headLimit} more lines. Narrow the search or raise head_limit.]` : lines.join('\n')) + labelNote;
  }
};

/** One line of Grep output: the file it comes from (absent for ripgrep's `--` group separator) and the rest, separator included (`:12:text`, `-12-text`, `:3`, or empty). */
export interface GrepLine { file?: string; text: string }

/** Parses ripgrep's `--null` output, where every file path is followed by a NUL byte instead of a separator. */
export function parseRipgrepOutput(stdout: string, mode: GrepMode): GrepLine[] {
  // With --files-with-matches, each path ends in NUL and no newline follows it.
  if (mode === 'files_with_matches') return stdout.split('\0').map((file) => file.replace(/^\r?\n/, '')).filter(Boolean).map((file) => ({ file, text: '' }));
  return stdout.split('\n').filter(Boolean).map((line) => {
    const end = line.indexOf('\0');
    if (end < 0) return { text: line };
    const rest = line.slice(end + 1);
    return { file: line.slice(0, end), text: /^\d+-/.test(rest) ? `-${rest}` : `:${rest}` };
  });
}

function ripgrep(rg: string, base: string, input: Parameters<typeof grepTool.run>[0], context: ToolContext): Promise<string> {
  const args = ['--no-heading', '--color', 'never', '--max-columns', '500', '--null'];
  if (input.mode === 'files_with_matches') args.push('--files-with-matches');
  if (input.mode === 'count') args.push('--count');
  if (input.mode === 'content') { args.push('--line-number'); if (input.context) args.push('-C', String(input.context)); }
  if (input.ignoreCase) args.push('-i');
  if (input.glob) args.push('--glob', input.glob);
  // Same exclusions as Glob and the JS fallback, even where no .gitignore exists.
  const unskipped = namedSkipDirs(input.path, input.glob);
  for (const dir of SKIP_DIRS) if (!unskipped.has(dir)) args.push('--glob', `!${dir}/`);
  args.push('--', input.pattern, base);
  return new Promise((resolve, reject) => {
    execFile(rg, args, { cwd: context.root, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, signal: context.signal }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code !== 1) reject(new ToolError(truncate(stderr || error.message)));
      else resolve(stdout);
    });
  });
}

async function jsGrep(base: string, input: Parameters<typeof grepTool.run>[0], context: ToolContext): Promise<GrepLine[]> {
  let regex: RegExp;
  try { regex = new RegExp(input.pattern, input.ignoreCase ? 'i' : ''); } catch (error) { throw new ToolError(`Invalid regular expression: ${(error as Error).message}`); }
  const files: string[] = [];
  const info = await stat(base);
  if (info.isFile()) files.push(base);
  else await walk(context.root, base, (absolute, relative) => { if (!input.glob || matchesGlob(input.glob, relative)) files.push(absolute); }, context.signal, namedSkipDirs(input.path, input.glob));
  const out: GrepLine[] = [];
  for (const file of files) {
    let text: string;
    try { text = await readText(file); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const hits = lines.map((line, index) => (regex.test(line) ? index : -1)).filter((index) => index >= 0);
    if (!hits.length) continue;
    if (input.mode === 'files_with_matches') out.push({ file, text: '' });
    else if (input.mode === 'count') out.push({ file, text: `:${hits.length}` });
    // Context lines are marked with "-", matching lines with ":", as ripgrep does.
    else for (const hit of hits) for (let index = Math.max(0, hit - input.context); index <= Math.min(lines.length - 1, hit + input.context); index += 1) out.push({ file, text: hits.includes(index) ? `:${index + 1}:${lines[index]}` : `-${index + 1}-${lines[index]}` });
    if (out.length > 5_000) break;
  }
  return out;
}

/** The most files of a command line, and the largest file, that the key-folder check reads. */
const SCRIPT_SCAN_FILES = 16;
const SCRIPT_SCAN_BYTES = 512 * 1024;

/**
 * The first file a command line names (as a word, relative to the shell's folder or absolute, inside the workspace) whose text names the project's
 * key folder, as the workspace-relative path; undefined when none does. Only files named on the command line are read, at most SCRIPT_SCAN_FILES of
 * them and only up to SCRIPT_SCAN_BYTES each, so a script the named one imports, a script `npm run` starts, or one fetched at run time is not seen.
 */
export async function scriptNamingStateKeys(command: string, context: ToolContext): Promise<string | undefined> {
  const words = [...new Set(command.split(/[\s'"`;&|()<>=]+/).filter((word) => word && !word.startsWith('-') && !/^[A-Za-z_]\w*$/.test(word) && /[./\\]/.test(word)))].slice(0, SCRIPT_SCAN_FILES);
  const cwd = context.shell?.workingDirectory ?? context.root;
  for (const word of words) {
    const requested = path.resolve(cwd, word);
    let absolute: string | undefined;
    // A word that resolves into the key folder is itself a hit (the forbidden check refuses it first; this keeps the scan from ever reading there).
    try { absolute = await resolveInWorkspace(context.root, requested); } catch (error) { if (error instanceof StateKeysError) return displayPath(context.root, requested); }
    if (!absolute) continue;
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile() || info.size > SCRIPT_SCAN_BYTES) continue;
    const text = await readFile(absolute, 'utf8').catch(() => '');
    if (namesStateKeys(text)) return displayPath(context.root, absolute);
  }
  return undefined;
}

/** At most this many (word, folder) pairs of a command line are resolved through links by the key-folder check; the text check covers every word. */
const SHELL_LINK_CHECKS = 128;
/** At most this many folders a command line's `cd`s can leave the shell in are tracked. */
const SHELL_CD_BASES = 8;

/** `{a,b}` in a shell word expanded (one brace at a time, at most 16 results); a word with no such brace is returned as it is. */
function expandBraces(word: string): string[] {
  const out: string[] = [];
  const pending = [word];
  while (pending.length && out.length + pending.length <= 16) {
    const next = pending.shift()!;
    const match = /\{([^{}]*,[^{}]*)\}/.exec(next);
    if (!match) { out.push(next); continue; }
    for (const part of match[1].split(',')) pending.push(next.slice(0, match.index) + part + next.slice(match.index + match[0].length));
  }
  return [...out, ...pending];
}

/** A shell glob segment as a regular expression (`*`, `?`, `[...]`), or undefined when it has no glob characters. */
function globSegment(segment: string): RegExp | undefined {
  if (!/[*?[]/.test(segment)) return undefined;
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    const close = char === '[' ? segment.indexOf(']', index + 2) : -1;
    if (close > 0) { source += `[${segment.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; index = close; }
    else source += char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|\\\]\[]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * An absolute path with each glob segment replaced by the name on the way into the key folder it could match (`.near-ai`, then `state` or one of its
 * previous copies, then `keys`), so `state/*` from `.near-ai` or `k*` from `.near-ai/state` reads as the key folder. A glob is treated as able to
 * match a dot name too (as with `shopt -s dotglob`), which is the safe side.
 */
function globTowardKeys(absolute: string): string {
  const parts = absolute.replace(/\\/g, '/').split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const glob = globSegment(parts[index]);
    if (!glob) continue;
    const previous = (parts[index - 1] ?? '').toLowerCase();
    const candidates = previous === '.near-ai' ? ['state', 'state.previous-x', 'state.adopt-x'] : /^state(?:\.(?:previous|adopt)-.*)?$/.test(previous) ? ['keys'] : ['.near-ai'];
    const hit = candidates.find((name) => glob.test(name));
    if (hit) parts[index] = hit;
  }
  return parts.join('/');
}

/**
 * Programs that walk a folder and read, pack or copy the files under it. `ls`, `du` and `tree` are not here: they show names and sizes, never a key.
 * A walk from the project root or any folder above `.near-ai` is still not seen (it would refuse every `grep -r` of the project); SECURITY.md says so.
 */
const FOLDER_WALKERS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'tar', 'zip', '7z', 'cpio', 'cp', 'rsync', 'scp']);

/**
 * Whether an absolute path is `.near-ai` or one of its state folders (`state`, `state.previous-*`, `state.adopt-*`): a folder that holds a key folder.
 * The project settings folder `.planning/.near-ai` holds none, so it is not one.
 */
function holdsKeyFolder(absolute: string): boolean {
  return /(?:^|\/)(?<!\/\.planning\/)\.near-ai(?:\/state(?:\.(?:previous|adopt)-[^/]*)?)?$/i.test(path.posix.normalize(absolute.replace(/\\/g, '/')).replace(/\/+$/, ''));
}

/**
 * Why a command line may not run because of the folder the shell is in, or a word that resolves into the key folder from there; undefined when
 * neither. This closes what a text check of the line alone misses: the persistent shell keeps its folder between commands, so `cd .near-ai/state`
 * then `cat keys/local.key` names no `.near-ai` in the second line. Every word is resolved against the shell's current folder and against each
 * folder a `cd` or `pushd` earlier in the same line moves to, with `{a,b}` braces expanded and globs read as reaching the key folder when they
 * could; the first SHELL_LINK_CHECKS of those are also resolved through links. A shell already inside the key folder runs nothing but a lone `cd`
 * out of it. A program that walks folders (FOLDER_WALKERS) run on, or inside, `.near-ai` or a state folder is refused too. Still a text check: a path
 * built at run time (a variable, `$(...)`, string arithmetic, base64) or a recursive walk from the project root or above is not seen; see namesStateKeys.
 */
export async function shellReachesStateKeys(command: string, context: ToolContext): Promise<string | undefined> {
  const start = context.shell?.workingDirectory ?? context.root;
  const inKeys = async (absolute: string, linkCheck: boolean): Promise<boolean> => {
    if (isStateKeysPath(globTowardKeys(absolute))) return true;
    if (!linkCheck) return false;
    return resolveInWorkspace(context.root, absolute).then(() => false, (error) => error instanceof StateKeysError);
  };
  if (await inKeys(start, true)) {
    const lone = /^\s*cd\s+(['"]?)([^\s'"`;&|()<>$]+)\1\s*$/.exec(command);
    const target = lone ? path.resolve(start, lone[2].replace(/^~(?=\/|$)/, homedir())) : undefined;
    if (target !== undefined && !(await inKeys(target, true))) return undefined;
    return `The shell's current folder, ${displayPath(context.root, start)}, is inside the project's key folder (.near-ai/state/keys), which holds the key that encrypts this project's saved chats. Agents may not run anything there, in any approval mode. Leave it first with a command that is only a cd to another folder, such as cd "${context.root}".`;
  }
  const words = command.split(/[\s'"`;&|()<>=]+/).filter((word) => word && !word.startsWith('-') && !word.includes('$'));
  // A program that walks a folder and reads or copies what is under it (gate follow-up): run on `.near-ai` or a state folder, the folders that hold the
  // key folder, it reaches the key without naming it (`grep -r x .near-ai`, `tar c .near-ai/state`), and so does one started inside such a folder.
  const walks = words.some((word) => FOLDER_WALKERS.has(path.basename(word)));
  if (walks && holdsKeyFolder(start)) return stateKeysReason(`${command.split('\n')[0]} (run in ${displayPath(context.root, start) || '.'}, a search or copy through the folder that holds the key folder)`);
  const bases = [start];
  let linkChecks = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index].replace(/^~(?=\/|$)/, homedir());
    for (const expanded of expandBraces(word)) {
      for (const base of bases) {
        const absolute = path.resolve(base, expanded);
        if (await inKeys(absolute, linkChecks++ < SHELL_LINK_CHECKS)) {
          const from = base === context.root ? '' : ` (from ${displayPath(context.root, base) || '.'})`;
          return stateKeysReason(`${words[index]}${from}`);
        }
        if (walks && holdsKeyFolder(globTowardKeys(absolute))) return stateKeysReason(`${words[index]} (a search or copy through the folder that holds the key folder)`);
      }
    }
    // A `cd` or `pushd` earlier in the line moves later words: they are read from that folder too.
    const previous = words[index - 1];
    if ((previous === 'cd' || previous === 'pushd') && bases.length < SHELL_CD_BASES) {
      for (const base of [...bases]) if (bases.length < SHELL_CD_BASES) bases.push(path.resolve(base, word));
    }
  }
  return undefined;
}

/** What a command reaches outside the project that the floor refuses (D-16): a credential store, or this extension's identity and gate folders. */
export interface CredentialReach {
  readonly credentialStore?: string;
  readonly identityFiles?: string;
  /** Set, with the reason, when the command is past the bounds the classifier reads (MAX_COMMAND_LENGTH, MAX_COMMAND_WORDS): its words were not resolved. */
  readonly unreadable?: string;
}

/** Whether a path, split into segments, is at or under `place` (also split), each segment equal to the place's or a glob that could match it. */
function reachesPlace(segments: readonly string[], place: readonly string[]): boolean {
  if (segments.length < place.length) return false;
  return place.every((name, index) => {
    const segment = segments[index];
    return segment.toLowerCase() === name.toLowerCase() || (globSegment(segment)?.test(name) ?? false);
  });
}

/** The path below `base`, in segments, or undefined when `absolute` is not inside it (the base itself is not inside it either). */
function segmentsBelow(base: string, absolute: string): string[] | undefined {
  const relative = path.relative(base, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).filter(Boolean);
}

/** The real path of a file, or of its folder with the file's name after it when the file does not exist; undefined when neither resolves. Reads no file. */
async function realPathLoose(absolute: string, resolve: (target: string) => Promise<string> = realpath): Promise<string | undefined> {
  try { return await resolve(absolute); } catch { /* not there: try its folder */ }
  try { return path.join(await resolve(path.dirname(absolute)), path.basename(absolute)); } catch { return undefined; }
}

/**
 * Whether a command line reaches a credential store or this extension's own identity and gate folders (D-16), outside the project, where the file tools
 * cannot go. The text checks of the floor come first (a store after `~`, `$HOME` or the home folder, VS Code's secrets database, a keychain command); then
 * every word is resolved, as shellReachesStateKeys does for the key folder, against the shell's folder and each folder a `cd` or `pushd` (or a bare `cd`,
 * which goes home) moves to, with `~`, `$HOME` and `${HOME}` expanded to `locations.home`, braces expanded and globs read as reaching a store when they
 * could; the first SHELL_LINK_CHECKS words are also resolved through links. It only reads the command's text and resolves paths: it never opens or lists a
 * file. Still a heuristic, with the limits FLOOR_CANNOT_SEE_TEXT names: a path built at run time or a walk down from a parent folder is not seen.
 */
export async function shellReachesCredentialStore(command: string, context: { root: string; shell?: { workingDirectory: string } }, locations: FloorLocations = {}, options: { realpath?: (target: string) => Promise<string> } = {}): Promise<CredentialReach> {
  const found: { credentialStore?: string; identityFiles?: string; unreadable?: string } = {};
  if (command.trim() === '') return found;
  // A path inside the project named like VS Code's storage is the project's own (PR #74 review round 11): read from the shell's folder.
  const byText = namesCredentialStore(command, locations, { root: context.root, cwd: context.shell?.workingDirectory ?? context.root });
  if (byText !== undefined) found.credentialStore = byText;
  const identityByText = namesIdentityFiles(command, locations);
  if (identityByText !== undefined) found.identityFiles = identityByText;
  if (found.credentialStore !== undefined && found.identityFiles !== undefined) return found;
  // The classifier's own bounds (PR #74 review round 11): past them, no word is resolved, and the command's effects are unknown to the gate.
  if (command.length > MAX_COMMAND_LENGTH) return { ...found, unreadable: 'the command is too long to check for credential folders' };
  if (command.split(/[\s'"`;&|()<>=]+/).length > MAX_COMMAND_WORDS) return { ...found, unreadable: 'the command has too many words to check for credential folders' };
  const resolveLoose = (target: string): Promise<string | undefined> => realPathLoose(target, options.realpath);
  const home = locations.home ? path.resolve(locations.home) : undefined;
  const storage = locations.globalStorage ? path.resolve(locations.globalStorage) : undefined;
  const homes = home === undefined ? [] : [...new Set([home, (await resolveLoose(home)) ?? home])];
  const storages = storage === undefined ? [] : [...new Set([storage, (await resolveLoose(storage)) ?? storage])];
  const stores = CREDENTIAL_STORES.map((store) => store.split('/'));
  // VS Code's secrets database only where VS Code keeps it (PR #74 review): its storage folder names, or this VS Code's own storage folders, as the global
  // storage is written and as it resolves. A project file of the same name is the project's.
  const secretsAt = storages.length === 0 ? [{}] : storages.map((globalStorage) => ({ globalStorage }));
  const isStore = (absolute: string): boolean => {
    if (VSCODE_SECRET_FILES.some((name) => name.toLowerCase() === path.basename(absolute).toLowerCase()) && secretsAt.some((at) => namesCredentialStore(absolute, at, { root: context.root }) !== undefined)) return true;
    return homes.some((base) => { const below = segmentsBelow(base, absolute); return below !== undefined && stores.some((store) => reachesPlace(below, store)); });
  };
  const isIdentity = (absolute: string): boolean => storages.some((base) => {
    const below = segmentsBelow(base, absolute);
    return below !== undefined && EXTENSION_STORAGE_FOLDERS.some((folder) => reachesPlace(below, [folder]));
  });
  const expandHome = (word: string): string => (home === undefined ? word : word.replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/, home));
  const start = context.shell?.workingDirectory ?? context.root;
  const bases = [start];
  // A bare `cd` (or `cd ~`) goes home: later words are read from there too.
  if (home !== undefined && /(?:^|[;&|(\n]\s*)(?:cd|pushd)\s*(?=$|[;&|)\n])/.test(command)) bases.push(home);
  // Each word as written (for the reason) and with the home folder put in (for resolving); a word the shell still expands at run time is not read.
  const words = command.split(/[\s'"`;&|()<>=]+/).filter((word) => word && !word.startsWith('-'))
    .map((shown) => ({ shown, word: expandHome(shown) })).filter(({ word }) => !word.includes('$'));
  let linkChecks = 0;
  for (let index = 0; index < words.length; index += 1) {
    const { shown, word } = words[index];
    for (const expanded of expandBraces(word)) {
      for (const base of bases) {
        const absolute = path.resolve(base, expanded);
        let real: string | undefined;
        if (found.credentialStore === undefined || found.identityFiles === undefined) {
          if (!/[*?[]/.test(absolute) && linkChecks < SHELL_LINK_CHECKS) { linkChecks += 1; real = await resolveLoose(absolute); }
        }
        if (found.credentialStore === undefined && (isStore(absolute) || (real !== undefined && isStore(real)))) found.credentialStore = credentialReason(shown);
        if (found.identityFiles === undefined && (isIdentity(absolute) || (real !== undefined && isIdentity(real)))) found.identityFiles = identityFilesReason(shown);
        if (found.credentialStore !== undefined && found.identityFiles !== undefined) return found;
      }
    }
    const previous = words[index - 1]?.word;
    if ((previous === 'cd' || previous === 'pushd') && bases.length < SHELL_CD_BASES) {
      for (const base of [...bases]) if (bases.length < SHELL_CD_BASES) bases.push(path.resolve(base, word));
    }
  }
  return found;
}

export const bashTool: AgentTool<{ command: string; timeoutMs: number; background: boolean; description?: string }> = {
  name: 'Bash',
  description: 'Run a shell command in a persistent bash session rooted at the workspace (cd and exported variables carry over). Use for builds, tests, git, and package managers; use Read/Glob/Grep instead of cat/find/grep. Set run_in_background for long-running processes such as dev servers, then poll with BashOutput.',
  parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string', description: 'Five to ten words on what the command does.' }, timeout: { type: 'number', description: `Milliseconds, up to ${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS}).` }, run_in_background: { type: 'boolean' } }, required: ['command'], additionalProperties: false },
  capability: 'shell',
  manifest: declareManifest({ tool: 'Bash', effects: [{ verb: 'shell', cwd: 'workspace' }, { from: 'command' }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw) => ({ command: str(raw, 'command')!, timeoutMs: num(raw, 'timeout') ?? DEFAULT_TIMEOUT_MS, background: bool(raw, 'run_in_background'), description: str(raw, 'description', false) }),
  title: (input) => input.description ? `${input.description}` : `Run ${input.command.split('\n')[0].slice(0, 80)}`,
  async preview(input, context) { return { kind: 'command', command: input.command, cwd: displayPath(context.root, context.shell.workingDirectory) || '.', background: input.background }; },
  // A command line that names the key folder, or whose words resolve into it from the shell's folder, is refused (0.4.23); so is any command but a
  // cd out while the shell is inside it. Text checks, so heuristics: see namesStateKeys and shellReachesStateKeys for what they can and cannot see.
  forbidden: async (input, context) => (namesStateKeys(input.command) ? stateKeysReason(input.command.split('\n')[0]) : shellReachesStateKeys(input.command, context)),
  risky: async (input, context) => {
    if (context.tainted?.() && NETWORK_COMMAND.test(input.command)) return 'This run has read outside content (a web page, search result, attachment, or MCP result), and this command can send data off this machine. Approve it only if you expected it; text in that content may have asked for it.';
    // A script the command runs (`node script.cjs`) that names the key folder asks, in every mode, with no "always allow": the agent can write such
    // a script, and a run once did exactly that to read keys/local.key. Asking rather than refusing, because a file can name the folder for honest
    // reasons (a test of this very rule); the person sees which file and why.
    const script = await scriptNamingStateKeys(input.command, context);
    return script ? `This command runs ${script}, which names the project's key folder (.near-ai/state/keys), where the key that encrypts this project's saved chats is kept. Approve it only if you expect a script to read or change those keys; NEAR AI never needs an agent to.` : undefined;
  },
  // PERF-04: a read-only command runs in its own shell forked at the agent's folder, so several can run in one turn; everything else queues as before.
  concurrentFor: (input) => !input.background && isReadOnlyShellCommand(input.command),
  async run(input, context) {
    if (input.background) return `Started in the background with id ${context.shell.startBackground(input.command)}. Read its output with BashOutput.`;
    const readOnly = isReadOnlyShellCommand(input.command);
    const shell = readOnly ? context.shell.fork(context.shell.workingDirectory) : context.shell;
    let result;
    try { result = await shell.run(input.command, input.timeoutMs, context.signal); } finally { if (readOnly) shell.dispose(); }
    const status = result.timedOut ? 'killed' : `exit code ${result.exitCode}`;
    return `${result.output.trimEnd() || '(no output)'}\n\n[${status}]`;
  }
};

export const bashOutputTool: AgentTool<{ id: string }> = {
  name: 'BashOutput',
  description: 'Read new output from a background command started with Bash run_in_background, and whether it is still running.',
  parameters: { type: 'object', properties: { bash_id: { type: 'string' } }, required: ['bash_id'], additionalProperties: false },
  capability: 'read',
  manifest: declareManifest({ tool: 'BashOutput', effects: [{ verb: 'plan' }], contexts: INTERACTIVE_AND_UNATTENDED }),
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
  // It can only stop a job this run started (ids are the run's own), never run a command, so like TodoWrite it changes
  // only the run's own state and does not ask. As 'shell' it had no command, and auto mode sent an empty one to the safety model.
  capability: 'plan',
  manifest: declareManifest({ tool: 'KillShell', effects: [{ verb: 'plan' }], contexts: INTERACTIVE_AND_UNATTENDED }),
  parse: (raw) => ({ id: str(raw, 'shell_id')! }),
  title: (input) => `Stop ${input.id}`,
  async run(input, context) { return context.shell.kill(input.id) ? `Stopped ${input.id}.` : `${input.id} was not running.`; }
};

export const todoTool: AgentTool<{ todos: Todo[] }> = {
  name: 'TodoWrite',
  description: 'Create or update the task list for this run. Use it for work with three or more steps: list the steps, keep exactly one in_progress, and mark each completed as soon as it is done. Send the full list every time.',
  parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string', description: 'Present-tense form shown while in progress, e.g. "Running tests".' } }, required: ['content', 'status'], additionalProperties: false } } }, required: ['todos'], additionalProperties: false },
  capability: 'plan',
  manifest: declareManifest({ tool: 'TodoWrite', effects: [{ verb: 'plan' }], contexts: INTERACTIVE_AND_UNATTENDED }),
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
