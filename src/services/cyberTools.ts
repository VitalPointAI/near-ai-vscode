import { execFile } from 'node:child_process';

// Host tools the harness can use when they are installed (D-12). Detection runs one fixed
// `--version` per tool through execFile (no shell, short timeout) and never installs anything:
// an install is an approval-gated action the panel offers (25-07). The one rule this module exists
// for is that a scan never reads as clean without saying which checks could not run (CYBER-12).

export type ToolEcosystem = 'npm' | 'pip' | 'brew' | 'apt' | 'binary';

export interface HostTool {
  name: string;
  purpose: string;
  ecosystem: ToolEcosystem;
  installCommand: string;
  /** The flag that makes the tool emit machine-readable output; empty when it only has text. */
  jsonFlag: string;
  /** False when the output format is assumed from documentation rather than verified (research A1-A5). */
  jsonFlagVerified: boolean;
  /** The argument that prints the tool's version; gitleaks takes `version`, the rest `--version`. */
  versionArgs: string[];
}

const announced = (name: string, purpose: string, ecosystem: ToolEcosystem, installCommand: string, jsonFlag: string, jsonFlagVerified: boolean, versionArgs = ['--version']): HostTool =>
  ({ name, purpose, ecosystem, installCommand, jsonFlag, jsonFlagVerified, versionArgs });

/** The tools the research's matrix covers, with the flags it verified and the ones it could not. */
export const TOOL_CATALOGUE: HostTool[] = [
  announced('nmap', 'Port and service discovery', 'apt', 'sudo apt install nmap (or brew install nmap)', '-oX -', true),
  announced('httpx', 'HTTP probing at scale', 'binary', 'go install github.com/projectdiscovery/httpx/cmd/httpx@latest', '-json', true),
  announced('nuclei', 'Template-driven vulnerability checks', 'binary', 'go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest', '-jsonl', true),
  announced('nikto', 'Web server misconfiguration scanning', 'apt', 'sudo apt install nikto (or brew install nikto)', '-Format json', false),
  announced('sqlmap', 'SQL injection exploitation', 'pip', 'pipx install sqlmap', '--json', false),
  announced('semgrep', 'Static analysis of source code', 'pip', 'pipx install semgrep', '--json', true),
  announced('trivy', 'Container and dependency vulnerabilities', 'binary', 'brew install trivy', '--format json', true),
  announced('gitleaks', 'Secret detection in git history', 'binary', 'brew install gitleaks', '--report-format json', true, ['version']),
  announced('whatweb', 'Web technology fingerprinting', 'apt', 'sudo apt install whatweb (or gem install whatweb)', '--json', false),
  announced('testssl.sh', 'TLS configuration testing', 'binary', 'brew install testssl', '--jsonfile', true)
];

export const TOOL_NAMES: string[] = TOOL_CATALOGUE.map((tool) => tool.name);

export interface ToolDetection { name: string; available: boolean; version?: string }

/** Runs one version command; returns its combined output, or throws when the tool is missing. */
export type VersionRunner = (command: string, args: string[]) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 3_000;

export const runVersion: VersionRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) { reject(error); return; }
    resolve(`${stdout}${stderr}`.trim());
  });
});

const VERSION_SHAPE = /\b\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?\b/;

/** Whether one host tool answers its version command, and which version it printed. */
export async function detectTool(name: string, run: VersionRunner = runVersion): Promise<ToolDetection> {
  const tool = TOOL_CATALOGUE.find((candidate) => candidate.name === name);
  if (!tool) return { name, available: false };
  try {
    const output = (await run(tool.name, tool.versionArgs)).trim();
    const version = VERSION_SHAPE.exec(output)?.[0];
    if (!output) return { name, available: false };
    return { name, available: true, ...(version ? { version } : {}) };
  } catch {
    return { name, available: false };
  }
}

/** Detection for every catalogued tool, in catalogue order. */
export async function detectTools(run: VersionRunner = runVersion, names: string[] = TOOL_NAMES): Promise<ToolDetection[]> {
  const detected: ToolDetection[] = [];
  for (const name of names) detected.push(await detectTool(name, run));
  return detected;
}

/** The tools a detection pass reported missing, in catalogue order. */
export function missingTools(detected: ToolDetection[]): string[] {
  const present = new Set(detected.filter((entry) => entry.available).map((entry) => entry.name));
  return TOOL_NAMES.filter((name) => !present.has(name));
}

/**
 * The sentence every scan summary carries, so a zero-finding result cannot read as clean when the
 * tools that would have found something are not installed (research Pitfall 1, CYBER-12).
 */
export function missingToolsNote(detected: ToolDetection[]): string {
  const missing = missingTools(detected);
  if (!missing.length) return `All ${TOOL_NAMES.length} host tool(s) were available; no check was skipped for a missing tool.`;
  return `Checks that could not run: ${missing.map((name) => `${name} (not installed)`).join(', ')}.`;
}

/** The install command for a tool, offered for approval by the panel; this never executes it. */
export function installOffer(name: string): string | undefined {
  return TOOL_CATALOGUE.find((tool) => tool.name === name)?.installCommand;
}

/** True when a tool's JSON flag is an assumption the executor must verify before trusting it. */
export function jsonFlagIsAssumed(name: string): boolean {
  const tool = TOOL_CATALOGUE.find((candidate) => candidate.name === name);
  return Boolean(tool && !tool.jsonFlagVerified);
}
