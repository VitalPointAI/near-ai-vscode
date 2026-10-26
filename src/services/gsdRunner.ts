import { spawn, ChildProcess } from 'node:child_process';
import { redactSecrets } from '../domain/redaction';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { PromptResponse } from '../domain/chatProgress';

export type GsdProgressState = 'started' | 'running' | 'output' | 'waiting' | 'retry' | 'completed' | 'failed' | 'cancelled';

export interface GsdProgressEvent {
  state: GsdProgressState;
  command: string;
  text?: string;
  exitCode?: number | null;
  prompt?: unknown;
  phase?: string;
  action?: string;
  tool?: string;
  model?: string;
  agent?: string;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  approvalRequired?: boolean;
}

export interface GsdProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin?: NodeJS.WritableStream;
  once(event: 'close' | 'error', listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type GsdProcessFactory = (file: string, args: string[], options: { cwd: string; shell: false; windowsHide: boolean }) => GsdProcess;

const defaultProcessFactory: GsdProcessFactory = (file, args, options) => spawn(file, args, options);

export interface GsdInvocation {
  file: string;
  args: string[];
  cwd: string;
}

/** Builds the argv passed to the installed Codex runtime. No shell string is accepted. */
export function officialGsdInvocation(command: string, workspaceRoot: string, executable = 'codex'): GsdInvocation {
  if (!GSD_COMMANDS.some((definition) => definition.command === command)) {
    throw new Error('Unknown Open-GSD command. Choose a command from the catalog.');
  }
  if (!workspaceRoot || workspaceRoot.includes('\0')) throw new Error('A valid workspace is required to run Open-GSD.');
  return { file: executable, args: ['exec', '--cd', workspaceRoot, `$gsd-${command}`], cwd: workspaceRoot };
}

export class GsdRunner {
  private active: GsdProcess | undefined;
  private activeCommand: string | undefined;

  public constructor(private readonly processFactory: GsdProcessFactory = defaultProcessFactory, private readonly executable = 'codex') {}

  public async run(command: string, workspaceRoot: string, onEvent: (event: GsdProgressEvent) => void): Promise<void> {
    const invocation = officialGsdInvocation(command, workspaceRoot, this.executable);
    if (this.active) throw new Error('An Open-GSD workflow is already running.');
    const process = this.processFactory(invocation.file, invocation.args, { cwd: invocation.cwd, shell: false, windowsHide: true });
    this.active = process;
    this.activeCommand = command;
    onEvent({ state: 'started', command });
    onEvent({ state: 'running', command, text: `Running $gsd-${command} in the active workspace.` });

    const output = (stream: NodeJS.ReadableStream, state: GsdProgressState) => {
      let buffered = '';
      stream.on('data', (chunk: Buffer | string) => {
        buffered += String(chunk);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) emitRuntimeLine(line);
        if (buffered && parseRuntimeEvent(buffered)) { emitRuntimeLine(buffered); buffered = ''; }
      });
      stream.on('end', () => { if (buffered.trim()) emitRuntimeLine(buffered); });
      const emitRuntimeLine = (line: string): void => {
        const raw = line.trim();
        if (!raw) return;
        const parsed = parseRuntimeEvent(raw);
        if (parsed) {
          const eventState = parsed.state ?? (parsed.approvalRequired ? 'waiting' : state);
          if (parsed.type === 'prompt' && parsed.prompt !== undefined) {
            onEvent({ state: 'waiting', command, prompt: parsed.prompt, text: 'Open-GSD is waiting for your response.', ...metadataFromRuntime(parsed) });
          } else {
            onEvent({ state: eventState, command, text: safeRuntimeText(parsed.text) ?? safeRuntimeText(raw), ...metadataFromRuntime(parsed) });
          }
          return;
        }
        const text = redactSecrets(raw).trim();
        if (text) onEvent({ state, command, text });
      };
    };
    output(process.stdout, 'output');
    output(process.stderr, 'waiting');
    await new Promise<void>((resolve) => {
      process.once('error', (error: Error) => {
        if (this.active === process) onEvent({ state: 'failed', command, text: redactSecrets(error.message) });
        resolve();
      });
      process.once('close', (exitCode: number | null) => {
        const cancelled = this.active !== process;
        if (cancelled) onEvent({ state: 'cancelled', command, exitCode });
        else if (exitCode === 0) onEvent({ state: 'completed', command, exitCode });
        else onEvent({ state: 'failed', command, exitCode, text: `Open-GSD exited with code ${exitCode ?? 'unknown'}.` });
        resolve();
      });
    });
    if (this.active === process) {
      this.active = undefined;
      this.activeCommand = undefined;
    }
  }

  public cancel(): boolean {
    if (!this.active) return false;
    const process = this.active;
    this.active = undefined;
    this.activeCommand = undefined;
    return process.kill('SIGTERM');
  }

  /** Sends one already-validated prompt response to the active runtime. */
  public respond(response: PromptResponse): boolean {
    if (!this.active?.stdin || !['prompt-choice', 'prompt-answer', 'prompt-cancel', 'prompt-resume'].includes(response.type)) return false;
    this.active.stdin.write(`${JSON.stringify(response)}\n`);
    return true;
  }

  public get runningCommand(): string | undefined { return this.activeCommand; }
}

type RuntimeEvent = Record<string, unknown> & { type?: string; state?: GsdProgressState; prompt?: unknown; text?: unknown };
const runtimeKeys = new Set(['type', 'state', 'prompt', 'text', 'phase', 'action', 'tool', 'model', 'agent', 'agentCount', 'attempt', 'retry', 'approvalRequired']);
const lifecycleStates = new Set<GsdProgressState>(['started', 'running', 'output', 'waiting', 'retry', 'completed', 'failed', 'cancelled']);

function parseRuntimeEvent(raw: string): RuntimeEvent | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    if (typeof input.type !== 'string' && typeof input.state !== 'string') return undefined;
    return Object.fromEntries(Object.entries(input).filter(([key]) => runtimeKeys.has(key))) as RuntimeEvent;
  } catch { return undefined; }
}

function safeRuntimeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return undefined;
  const redacted = redactSecrets(value).replace(/(?:private prompt|chain[- ]of[- ]thought|environment values?|raw command output)[^.;]*/gi, '[REDACTED CONTEXT]');
  return redacted.trim() || undefined;
}

function safeRuntimeScalar(value: unknown, max: number): string | undefined {
  const text = safeRuntimeText(value);
  return text && text.length <= max && !/api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer\s/i.test(text) && !/(?:^|\s)(?:\/home|\/Users|[A-Z]:\\)/.test(text) ? text : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function metadataFromRuntime(input: RuntimeEvent): Pick<GsdProgressEvent, 'phase' | 'action' | 'tool' | 'model' | 'agent' | 'agentCount' | 'attempt' | 'retry' | 'approvalRequired'> {
  const state = typeof input.state === 'string' && lifecycleStates.has(input.state as GsdProgressState) ? input.state as GsdProgressState : undefined;
  return {
    phase: safeRuntimeScalar(input.phase, 120),
    action: safeRuntimeScalar(input.action, 120),
    tool: safeRuntimeScalar(input.tool, 120),
    model: safeRuntimeScalar(input.model, 160),
    agent: safeRuntimeScalar(input.agent, 120),
    agentCount: boundedInteger(input.agentCount, 0, 1000),
    attempt: boundedInteger(input.attempt, 1, 1000),
    retry: input.retry === true || state === 'retry' ? true : undefined,
    approvalRequired: input.approvalRequired === true ? true : undefined
  };
}
