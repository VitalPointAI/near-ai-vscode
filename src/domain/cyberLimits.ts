import { normalizeCommand } from '../agent/permissions';

// The limits that make CYBER-10 true, as pure domain code: a sliding-window rate limiter, the
// wall-clock budget check that reports what a stop did not reach (D-09), and the read-only
// post-exploitation rules (D-11). No `vscode` import, no timer, no clock of its own.

export type RateDecision = { ok: true; remaining: number } | { ok: false; reason: string };
export type BudgetDecision = { ok: true; remainingMs: number } | { ok: false; reason: string; shortfall: BudgetShortfall };

/** D-09: a budget stop names what it did not reach, so it never reads as a completed scan. */
export interface BudgetShortfall {
  unreachedHosts: string[];
  unreachedChecks: string[];
  plannedHostCount: number;
  plannedCheckCount: number;
}

export interface PlannedWork {
  hosts: string[];
  checks: string[];
  completed: { hosts: string[]; checks: string[] };
}

export interface BudgetInput {
  startedAt: number;
  budgetMs: number;
  planned: PlannedWork;
}

const WINDOW_MS = 60_000;

/**
 * At most `opsPerMinute` operations in any sliding 60-second window. Idle time is not a credit:
 * after a pause a burst may at most fill the window again, never exceed it (the plan's prohibition).
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  public constructor(public readonly opsPerMinute: number, private readonly now: () => number = Date.now) {
    if (!Number.isFinite(opsPerMinute) || opsPerMinute <= 0) throw new Error('A rate limit needs a positive opsPerMinute.');
  }

  /** Records one operation, or refuses it with the rate reason. */
  public acquire(at: number = this.now()): RateDecision {
    this.evict(at);
    if (this.timestamps.length >= this.opsPerMinute) {
      return { ok: false, reason: `rate limit: ${this.opsPerMinute} ops/min reached; ${this.msUntilFree(at)} ms until the window frees a slot.` };
    }
    this.timestamps.push(at);
    return { ok: true, remaining: this.opsPerMinute - this.timestamps.length };
  }

  /** Operations counted inside the current window. */
  public get used(): number {
    this.evict(this.now());
    return this.timestamps.length;
  }

  private evict(at: number): void {
    while (this.timestamps.length && at - this.timestamps[0] >= WINDOW_MS) this.timestamps.shift();
  }

  private msUntilFree(at: number): number {
    const oldest = this.timestamps[0];
    return oldest === undefined ? 0 : Math.max(0, WINDOW_MS - (at - oldest));
  }
}

/** Inside the wall-clock budget, or the reason plus exactly which hosts and checks were not reached. */
export function checkBudget(input: BudgetInput, now: number): BudgetDecision {
  const elapsed = now - input.startedAt;
  if (elapsed < input.budgetMs) return { ok: true, remainingMs: input.budgetMs - elapsed };
  const completedHosts = new Set(input.planned.completed.hosts);
  const completedChecks = new Set(input.planned.completed.checks);
  const unreachedHosts = [...new Set(input.planned.hosts)].filter((host) => !completedHosts.has(host));
  const unreachedChecks = [...new Set(input.planned.checks)].filter((check) => !completedChecks.has(check));
  const minutes = Math.round((input.budgetMs / 60_000) * 10) / 10;
  return {
    ok: false,
    reason: `wall-clock budget reached (${minutes} min): ${unreachedHosts.length} host(s) and ${unreachedChecks.length} check(s) were not reached.`,
    shortfall: { unreachedHosts, unreachedChecks, plannedHostCount: new Set(input.planned.hosts).size, plannedCheckCount: new Set(input.planned.checks).size }
  };
}

// ---- Post-exploitation rules (D-11) ------------------------------------------------------------

/** Read-only commands a post-exploitation step may run, with the flags allowed for each. */
export const POST_EXPLOIT_ALLOWLIST: Record<string, readonly string[]> = {
  cat: ['-n', '-A', '-E', '-T'],
  ls: ['-l', '-a', '-la', '-al', '-laR', '-lah', '-h', '-R', '-t', '-r', '-1'],
  whoami: [],
  hostname: ['-f', '-s', '-i'],
  id: ['-u', '-g', '-G', '-n', '-un', '-gn', '-Gn'],
  uname: ['-a', '-s', '-r', '-m', '-n', '-v', '-o', '-sr', '-sm']
};

/** Forms that would read the whole filesystem or a credential store even with an allowed command. */
const DANGEROUS_OPERAND = /^\/?etc\/(?:shadow|gshadow)$|^\/?root\/|\.ssh\/|id_rsa|id_ed25519/;

/** Write-shaped, lateral, and persistence forms, refused by name (D-11's hard list). */
const WRITE_SHAPED = new Set(['rm', 'rmdir', 'mv', 'cp', 'chmod', 'chown', 'touch', 'mkdir', 'tee', 'dd', 'shred', 'truncate', 'install', 'ln', 'sed', 'awk', 'python', 'python3', 'perl', 'ruby', 'node', 'sh', 'bash', 'zsh', 'dash', 'eval', 'source', 'exec', 'xargs', 'env', 'sudo', 'su']);
const PERSISTENCE = new Set(['crontab', 'useradd', 'userdel', 'usermod', 'groupadd', 'systemctl', 'service', 'chkconfig', 'at', 'ssh-keygen', 'update-rc.d', 'rc-update']);
const LATERAL = new Set(['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'rsync', 'curl', 'wget']);
/** Shell metacharacters that turn one read-only command into a write or a second command. */
const SHELL_METACHARACTER = /[|&;<>$`(){}\[\]*?!#~\n\\]/;

export type PostExploitVerdict = { allowed: true } | { allowed: false; reason: string };

/** Whether a post-exploitation command is a plain read-only form; the refusal names the rule. */
export function postExploitAllowed(command: string): PostExploitVerdict {
  const raw = command.trim();
  if (!raw) return { allowed: false, reason: 'post-exploitation rule: the command is empty.' };
  const normalized = normalizeCommand(raw);
  const words = normalized.split(' ');
  const [program, ...rest] = words;
  if (WRITE_SHAPED.has(program)) return { allowed: false, reason: `post-exploitation rule: "${program}" can write or execute, so only read-only commands are allowed.` };
  if (PERSISTENCE.has(program)) return { allowed: false, reason: `post-exploitation rule: "${program}" is a persistence mechanism.` };
  if (LATERAL.has(program)) return { allowed: false, reason: `post-exploitation rule: "${program}" can reach another host (lateral movement).` };
  if (!(program in POST_EXPLOIT_ALLOWLIST)) return { allowed: false, reason: `post-exploitation rule: "${program}" is not on the read-only allowlist (${Object.keys(POST_EXPLOIT_ALLOWLIST).join(', ')}).` };
  const operators = SHELL_METACHARACTER.exec(raw.replace(/^[a-z0-9]+/, ''));
  if (operators) return { allowed: false, reason: `post-exploitation rule: "${operators[0]}" chains, redirects, substitutes, or globs, which a read-only step may not do.` };
  const flags = rest.filter((word) => word.startsWith('-'));
  const operands = rest.filter((word) => !word.startsWith('-'));
  const permitted = POST_EXPLOIT_ALLOWLIST[program];
  const foreign = flags.find((flag) => !permitted.includes(flag));
  if (foreign) return { allowed: false, reason: `post-exploitation rule: "${program} ${foreign}" is not an allowed read-only form (allowed: ${permitted.length ? permitted.join(' ') : 'no flags'}).` };
  const sensitive = operands.find((operand) => DANGEROUS_OPERAND.test(operand));
  if (sensitive) return { allowed: false, reason: `post-exploitation rule: "${sensitive}" is a credential store.` };
  const absolute = operands.find((operand) => operand.startsWith('/'));
  if (absolute) return { allowed: false, reason: `post-exploitation rule: "${absolute}" is an absolute path; post-exploitation reads stay inside the sandbox working directory.` };
  const climbing = operands.find((operand) => operand.split('/').includes('..'));
  if (climbing) return { allowed: false, reason: 'post-exploitation rule: ".." climbs out of the sandbox working directory.' };
  return { allowed: true };
}

// ---- Run vehicle (where a run is driven from) ---------------------------------------------------

/**
 * Which vehicle drives a run. 'panel' is the appliance: the panel starts the engine and shows the
 * timeline, so closing the panel ends the run. 'chat' borrows the chat turn: the run is a message in
 * a conversation, so it survives closing any panel and is steerable in plain language.
 */
export type RunVehicle = 'panel' | 'chat';

/**
 * The vehicle a depth profile defaults to, and why. Long runs lose too much when their vehicle
 * closes on them, so a deep run defaults to the chat; short runs default to the panel, where the
 * timeline is tighter than a chat transcript.
 */
export function defaultVehicle(depth: 'quick' | 'standard' | 'deep'): { vehicle: RunVehicle; reason: string } {
  if (depth === 'deep') {
    return { vehicle: 'chat', reason: 'A deep run can take 45 minutes. In chat it keeps going if you close this panel, and you can steer it by typing.' };
  }
  return { vehicle: 'panel', reason: 'Quick and standard runs finish inside this panel, which shows the tighter timeline. Closing the panel stops the run.' };
}

/** True when the vehicle survives the panel being closed. */
export function survivesPanelClose(vehicle: RunVehicle): boolean {
  return vehicle === 'chat';
}
