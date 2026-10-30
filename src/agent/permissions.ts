import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { classifyCommand, CommandContext } from './commandSafety';
import { NETWORK_COMMAND } from './untrusted';
import type { CommandSafetyCheck } from './safetyModel';

/** `reason` on an ask says why it was not run automatically; the approval card shows it. */
export type PermissionDecision = { decision: 'allow' } | { decision: 'ask'; reason?: string } | { decision: 'deny'; reason: string };

/** What the `auto` mode needs to judge a shell command. */
export interface AutoApprovalContext extends CommandContext {
  /** The private safety model, for commands the rules cannot decide; without it they ask. */
  safety?: CommandSafetyCheck;
  signal?: AbortSignal;
}

export interface PermissionRules {
  /** Commands (leading words) that run without asking when written as plain words, e.g. "npm test". */
  allowCommands: string[];
  /** Substrings that are always refused, e.g. "git push --force". */
  denyCommands: string[];
}

export const DEFAULT_RULES: PermissionRules = {
  allowCommands: ['git status', 'git diff', 'git log', 'git show', 'git branch', 'ls', 'pwd', 'node --version', 'npm --version'],
  denyCommands: ['rm -rf /', 'rm -rf ~', 'git push --force', 'git push -f', 'mkfs', ':(){']
};

/**
 * Only plain words are auto-allowed: anything else (chaining, redirects, substitution, quotes,
 * globs, `~`, variables, newlines) needs approval. Checked on the raw command, before any
 * whitespace is collapsed.
 */
const PLAIN_COMMAND = /^[A-Za-z0-9 _.\/:=@+,%-]+$/;
/** git options that write files, read outside the repository, run programs, or destroy refs. */
const RISKY_GIT_ARG = /^(?:--output(?:=|$)|-o$|--no-index$|--ext-diff$|--textconv$|--exec|--upload-pack|--receive-pack|-c$|-C$|--git-dir|--work-tree|-[a-zA-Z]*[DdMmfc][a-zA-Z]*$|--delete$|--force$|--move$|--copy$|--set-upstream|--unset-upstream|--edit-description$)/;
const SAFE_GIT_BRANCH_ARGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes']);

/** Whether a command matches an allow-list entry and is simple enough to run without asking. */
export function isAutoAllowed(command: string, allowCommands: string[]): boolean {
  const raw = command.trim();
  if (!raw || !PLAIN_COMMAND.test(raw)) return false;
  const words = raw.split(/ +/);
  if (words.some((word) => word.startsWith('/') || word.split('/').includes('..'))) return false;
  // An allow-list entry covers named remotes and local paths, never an address typed on the command line.
  if (words.some((word) => /:\/\/|^[\w.-]+@[\w.-]+:/.test(word))) return false;
  const entry = allowCommands.map((prefix) => prefix.trim().split(/\s+/)).find((prefix) => prefix[0] && prefix.every((word, index) => words[index] === word));
  if (!entry) return false;
  const rest = words.slice(entry.length);
  if (words[0] === 'git') {
    if (rest.some((word) => RISKY_GIT_ARG.test(word))) return false;
    if (words[1] === 'branch' && rest.some((word) => !SAFE_GIT_BRANCH_ARGS.has(word))) return false;
  }
  return true;
}

/**
 * Grants made from approval cards for the rest of one run: "allow edits for this run" and
 * "allow this exact command for this run".
 */
export class RunGrants {
  public edits = false;
  public readonly commands = new Set<string>();
  /** Allow-list entries added from an approval card ("always allow …") during this run. */
  public readonly allowRules = new Set<string>();
  /** Set once the run reads outside content; some actions then always ask. */
  public tainted = false;
}

/**
 * Decides whether a tool call runs, asks first, or is refused. Reads, searches, and task lists
 * always run. File writes follow the action policy. Shell commands consult the deny list, the
 * per-run grants, the allow list (simple commands only), then the action policy. In `auto` mode
 * the command classifier then decides; this synchronous form asks for commands it cannot decide
 * (decidePermissionAsync asks the safety model about those).
 */
export function decidePermission(capability: ActionCapability, command: string | undefined, policy: ActionPolicy, rules: PermissionRules, grants: RunGrants, auto?: CommandContext): PermissionDecision {
  if (policy.emergencyStop) return { decision: 'deny', reason: 'Emergency stop is on.' };
  if (capability === 'read' || capability === 'plan') return { decision: 'allow' };
  if (capability === 'workspaceWrite') {
    if (grants.edits || policy.mode !== 'approve-risky') return { decision: 'allow' };
    return { decision: 'ask' };
  }
  if (capability === 'shell') {
    // The deny list is a backstop, not a sandbox: matched with quotes and escapes removed.
    const unquoted = normalizeCommand((command ?? '').replace(/["'\\]/g, ''));
    const denied = rules.denyCommands.find((pattern) => pattern && unquoted.includes(normalizeCommand(pattern)));
    if (denied) return { decision: 'deny', reason: `"${denied}" is on your deny list (nearAi.agent.denyCommands).` };
    if (grants.commands.has((command ?? '').trim())) return { decision: 'allow' };
    const allowList = [...rules.allowCommands, ...grants.allowRules];
    if (isAutoAllowed(command ?? '', allowList)) return { decision: 'allow' };
    if (policy.mode === 'fully-autonomous') return { decision: 'allow' };
    if (policy.mode === 'auto') {
      if (!auto) return { decision: 'ask', reason: 'Auto approve could not check this command.' };
      const classified = classifyCommand(command ?? '', withAllowList(auto, allowList));
      if (classified.verdict === 'safe') return { decision: 'allow' };
      return { decision: 'ask', reason: classified.verdict === 'risky' ? `Auto approve held this: ${classified.reason}.` : `The rules could not decide this command (${classified.reason}).` };
    }
    return { decision: 'ask' };
  }
  return policy.mode === 'fully-autonomous' ? { decision: 'allow' } : { decision: 'ask' };
}

/**
 * decidePermission, plus the `auto` mode's model check: a shell command the rules call `unknown`
 * goes to the private safety model, unless the run has read outside content (which could have
 * steered both the agent and the check) or no private model is available; then it asks. Every
 * other mode decides exactly as decidePermission does.
 */
export async function decidePermissionAsync(capability: ActionCapability, command: string | undefined, policy: ActionPolicy, rules: PermissionRules, grants: RunGrants, auto?: AutoApprovalContext): Promise<PermissionDecision> {
  const decided = decidePermission(capability, command, policy, rules, grants, auto);
  if (policy.mode !== 'auto' || capability !== 'shell' || decided.decision !== 'ask' || !auto) return decided;
  const classified = classifyCommand(command ?? '', withAllowList(auto, [...rules.allowCommands, ...grants.allowRules]));
  if (classified.verdict !== 'unknown') return decided;
  // Say why the safety model did not let it run: skipped (network command in a tainted run, no
  // private model), unable to answer (busy, unreachable, timed out), or answered no.
  const unplaced = `the rules couldn't place this command (${classified.reason})`;
  // After outside content, anything that can reach the network asks: that content may have asked for it.
  if (grants.tainted && NETWORK_COMMAND.test(command ?? '')) return { decision: 'ask', reason: `This run read outside content (a web page, search result, attachment, or MCP result), and this command can reach the network, so it asks; ${unplaced}.` };
  if (!auto.safety) return { decision: 'ask', reason: `No private (TEE) safety model is available to check it, and ${unplaced}.` };
  const verdict = await auto.safety.check((command ?? '').trim(), { root: auto.root, cwd: auto.cwd ?? auto.root, outsideContent: grants.tainted }, auto.signal);
  if (verdict.allow) return { decision: 'allow' };
  return { decision: 'ask', reason: verdict.reason.startsWith('Safety model:') ? verdict.reason : `${verdict.reason} Without it, ${unplaced}.` };
}

function withAllowList(context: CommandContext, allowList: string[]): CommandContext {
  return { ...context, isAllowListed: (part) => isAutoAllowed(part, allowList) };
}

/** Programs whose second word picks what they do, so an allow-list entry names both (`git push`, `npm run`). */
const VERB_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'docker', 'podman', 'pip', 'pip3', 'uv', 'poetry', 'make', 'dotnet', 'kubectl']);
/** Where the verb is still too broad (`npm run` runs any script, `gh pr` includes merge), the entry names three words. */
const THREE_WORD = new Set(['npm run', 'pnpm run', 'yarn run', 'bun run', 'gh pr', 'gh issue', 'gh run', 'gh release', 'gh repo', 'glab mr', 'glab issue', 'docker compose']);
/** Never offered for "always allow": allowing them would allow almost anything. */
const NEVER_ALLOW_LIST = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'eval', 'source', 'exec', 'xargs', 'env', 'sudo', 'su', 'doas', 'rm', 'rmdir', 'find', 'dd', 'shred', 'truncate', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'socat', 'timeout', 'nohup', 'time', 'command', 'nice', 'near', 'aws', 'gcloud', 'az']);

/**
 * The allow-list entry an approval card offers for "always allow" (`git push`, `npm install`,
 * `docker`), or undefined when the command has no part worth allowing on its own. A leading
 * `cd <dir> &&` is skipped; a chained command offers its first other part.
 */
export function suggestAllowRule(command: string): string | undefined {
  const parts = command.trim().split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
  const part = parts.find((candidate) => !/^cd(?:\s|$)/.test(candidate));
  if (!part || !PLAIN_COMMAND.test(part)) return undefined;
  const words = part.split(/ +/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].includes('/')) return undefined;
  if (NEVER_ALLOW_LIST.has(words[0])) return undefined;
  const operands = words.slice(1).filter((word) => !word.startsWith('-'));
  if (THREE_WORD.has(`${words[0]} ${operands[0]}`)) return operands[1] ? `${words[0]} ${operands[0]} ${operands[1]}` : undefined;
  if (!VERB_PROGRAMS.has(words[0])) return words[0];
  return operands[0] ? `${words[0]} ${operands[0]}` : undefined;
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}
