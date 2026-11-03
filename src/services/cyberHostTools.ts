import { TOOL_CATALOGUE, installOffer } from './cyberTools';
import type { CyberEvidenceStore } from './cyberLedgerStore';

// Host-tool execution with verbatim capture (D-27 evidence kind 2, D-12, D-28). 25-03 owns
// detection and the install command; this module owns running a detected tool and storing its own
// stdout bytes as hash-chained evidence. The bytes are never re-serialized, re-formatted, or
// truncated before hashing: the blob is the evidence of record, and only the model-facing text is
// shortened. A tool that is not installed produces a named absent-with-reason record, so an empty
// result can never read as "the tool ran and found nothing".

/** How one tool is asked for machine-readable output. `args` receives the engagement's target. */
export interface HostToolInvocation {
  args(target: string): string[];
  format: 'json' | 'jsonl' | 'xml' | 'sarif' | 'text';
  /** False when the flag is taken from documentation rather than verified (25-03's research A1-A5). */
  verified: boolean;
}

/**
 * The machine-readable request per catalogue tool. nmap's `-oX -` sends XML to stdout; testssl.sh
 * writes its JSON to the file named after `--jsonfile`, and `-` is its stdout spelling. The three
 * tools 25-03 marks unverified keep their catalogue flag and say so in the provenance.
 */
export const HOST_TOOL_INVOCATION: Record<string, HostToolInvocation> = {
  nuclei: { args: (target) => ['-u', target, '-jsonl', '-silent'], format: 'jsonl', verified: true },
  nmap: { args: (target) => ['-oX', '-', target], format: 'xml', verified: true },
  semgrep: { args: (target) => ['--sarif', '--config', 'auto', target], format: 'sarif', verified: true },
  trivy: { args: (target) => ['--format', 'json', target], format: 'json', verified: true },
  httpx: { args: (target) => ['-u', target, '-json'], format: 'jsonl', verified: true },
  gitleaks: { args: (target) => ['--report-format', 'json', '--report-path', '-', target], format: 'json', verified: true },
  testssl: { args: (target) => ['--jsonfile', '-', target], format: 'json', verified: true },
  nikto: { args: (target) => ['-h', target, '-Format', 'json'], format: 'json', verified: false },
  sqlmap: { args: (target) => ['-u', target, '--batch', '--json'], format: 'json', verified: false },
  whatweb: { args: (target) => ['--json', target], format: 'json', verified: false }
};

export interface HostToolProvenance {
  tool: string;
  argv: string[];
  /** The version `detectTool` reported, or '' when the tool did not answer its version command. */
  version: string;
  /** Null for an absent tool: nothing ran, so there is no exit status to claim. */
  exitCode: number | null;
  durationMs: number;
  format: HostToolInvocation['format'] | 'absent';
  jsonFlagVerified: boolean;
}

export interface HostToolResult {
  status: 'captured' | 'failed' | 'absent';
  /** The hash of the stored blob: the tool's own stdout, or the absent record. */
  evidenceHash: string;
  provenance: HostToolProvenance;
  /** Truncated text for findings and the model; the stored blob is the untruncated bytes. */
  stdoutText: string;
}

export interface HostToolRunnerOutput { stdout: Buffer; stderr: string; exitCode: number; durationMs: number }

export interface HostToolRunner { run(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<HostToolRunnerOutput> }

export interface HostToolDeps {
  detect(tool: string): Promise<{ available: boolean; version?: string }>;
  runner: HostToolRunner;
  evidence: CyberEvidenceStore;
  installCommand?(tool: string): string | undefined;
  now?: () => number;
}

export interface HostToolRequest { runId: string; tool: string; target: string; timeoutMs?: number; signal?: AbortSignal }

export class HostToolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HostToolError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const TEXT_LIMIT = 4_000;

/** The argv for one tool, refusing a name outside the catalogue (T-25-27). */
export function hostToolArgv(tool: string, target: string): { argv: string[]; invocation: HostToolInvocation } {
  const invocation = HOST_TOOL_INVOCATION[tool];
  if (!invocation) throw new HostToolError(`"${tool}" is not a host tool this harness can run.`);
  if (!TOOL_CATALOGUE.some((entry) => entry.name === tool)) throw new HostToolError(`"${tool}" is not in the tool catalogue, so it has no install command or verified flag.`);
  if (!target.trim()) throw new HostToolError('A host tool needs a target.');
  return { argv: [tool, ...invocation.args(target)], invocation };
}

export async function runHostTool(request: HostToolRequest, deps: HostToolDeps): Promise<HostToolResult> {
  const now = deps.now ?? (() => Date.now());
  const { argv, invocation } = hostToolArgv(request.tool, request.target);
  const detection: { available: boolean; version?: string } = await deps.detect(request.tool).catch(() => ({ available: false }));

  if (!detection.available) {
    // Absence is evidence, never a skip: the record names the tool and how to install it.
    const installCommand = deps.installCommand?.(request.tool) ?? installOffer(request.tool) ?? `install ${request.tool}`;
    const reason = `${request.tool} is not installed, so its checks did not run.`;
    const evidenceHash = await deps.evidence.putAbsent(request.runId, { kind: 'absent', tool: request.tool, installCommand, reason });
    return {
      status: 'absent',
      evidenceHash,
      provenance: { tool: request.tool, argv: [], version: '', exitCode: null, durationMs: 0, format: 'absent', jsonFlagVerified: invocation.verified },
      stdoutText: `Absent: ${reason} Install it with: ${installCommand}`,
    };
  }

  const started = now();
  const result = await deps.runner.run(argv, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, request.signal);
  const durationMs = result.durationMs || now() - started;
  // The raw bytes go to the store exactly as the tool printed them.
  const evidenceHash = await deps.evidence.put(request.runId, result.stdout);
  const stdoutText = result.stdout.toString('utf8');
  return {
    status: result.exitCode === 0 ? 'captured' : 'failed',
    evidenceHash,
    provenance: { tool: request.tool, argv, version: detection.version ?? '', exitCode: result.exitCode, durationMs, format: invocation.format, jsonFlagVerified: invocation.verified },
    stdoutText: stdoutText.length > TEXT_LIMIT ? `${stdoutText.slice(0, TEXT_LIMIT)}\n[… ${stdoutText.length - TEXT_LIMIT} characters omitted; the stored blob is complete]` : stdoutText,
  };
}

/** The production runner: one shell command, the raw stdout captured before any truncation. */
export function shellRunner(run: (command: string) => Promise<{ output: string; exitCode: number }>): HostToolRunner {
  return {
    async run(argv, _timeoutMs, _signal) {
      const started = Date.now();
      const result = await run(argv.map(quote).join(' '));
      return { stdout: Buffer.from(result.output, 'utf8'), stderr: '', exitCode: result.exitCode, durationMs: Date.now() - started };
    }
  };
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

