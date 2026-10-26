import type { ActionCapability, ActionPolicy } from '../domain/policy';

export type PermissionDecision = { decision: 'allow' | 'ask' } | { decision: 'deny'; reason: string };

export interface PermissionRules {
  /** Command prefixes that run without asking, e.g. "npm test", "git status". */
  allowCommands: string[];
  /** Substrings that are always refused, e.g. "git push --force". */
  denyCommands: string[];
}

export const DEFAULT_RULES: PermissionRules = {
  allowCommands: ['git status', 'git diff', 'git log', 'git show', 'git branch', 'ls', 'pwd', 'node --version', 'npm --version'],
  denyCommands: ['rm -rf /', 'rm -rf ~', 'git push --force', 'git push -f', 'mkfs', ':(){']
};

/** Shell syntax that chains, redirects, or substitutes; a command containing it is never auto-allowed by prefix. */
const COMPOUND = /[;&|<>`\n]|\$\(/;

/**
 * Grants made from approval cards for the rest of one run: "allow edits for this run" and
 * "allow this exact command for this run".
 */
export class RunGrants {
  public edits = false;
  public readonly commands = new Set<string>();
}

/**
 * Decides whether a tool call runs, asks first, or is refused. Reads, searches, and task lists
 * always run. File writes follow the action policy. Shell commands consult the deny list, the
 * per-run grants, the allow list (simple commands only), then the action policy.
 */
export function decidePermission(capability: ActionCapability, command: string | undefined, policy: ActionPolicy, rules: PermissionRules, grants: RunGrants): PermissionDecision {
  if (policy.emergencyStop) return { decision: 'deny', reason: 'Emergency stop is on.' };
  if (capability === 'read' || capability === 'plan') return { decision: 'allow' };
  if (capability === 'workspaceWrite') {
    if (grants.edits || policy.mode !== 'approve-risky') return { decision: 'allow' };
    return { decision: 'ask' };
  }
  if (capability === 'shell') {
    const normalized = (command ?? '').trim().replace(/\s+/g, ' ');
    const denied = rules.denyCommands.find((pattern) => pattern && normalized.includes(pattern));
    if (denied) return { decision: 'deny', reason: `"${denied}" is on your deny list (nearAi.agent.denyCommands).` };
    if (grants.commands.has(normalized)) return { decision: 'allow' };
    if (!COMPOUND.test(normalized) && rules.allowCommands.some((prefix) => prefix && (normalized === prefix || normalized.startsWith(`${prefix} `)))) return { decision: 'allow' };
    if (policy.mode === 'fully-autonomous') return { decision: 'allow' };
    return { decision: 'ask' };
  }
  return policy.mode === 'fully-autonomous' ? { decision: 'allow' } : { decision: 'ask' };
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}
