export type ActionCapability =
  | 'read'
  | 'plan'
  | 'workspaceWrite'
  /**
   * A write to shared state OUTSIDE the workspace that outlives the run: a team's knowledge graph, which every member and every later run reads. It always
   * asks a person, in every mode, because a `workspaceWrite` grant covers it otherwise and an agent reading a hostile page could then commit that page as
   * durable team memory with no prompt (0.4.19 review).
   */
  | 'sharedWrite'
  | 'shell'
  | 'network'
  | 'gitMutation'
  | 'mediaGeneration'
  | 'mediaPublication';

/**
 * `auto`: file edits run, and a shell command runs when it passes the safety check (deterministic
 * rules first, then a private model for commands the rules cannot decide); anything else asks.
 */
export type ActionPolicyMode = 'approve-risky' | 'mostly-autonomous' | 'auto' | 'fully-autonomous';

export type ActionDecision = 'allow' | 'approval-required' | 'deny';

export interface ActionPolicy {
  mode: ActionPolicyMode;
  emergencyStop: boolean;
}

const SAFE_CAPABILITIES = new Set<ActionCapability>(['read', 'plan']);

export function defaultActionPolicy(): ActionPolicy {
  return { mode: 'approve-risky', emergencyStop: false };
}

export function decideAction(policy: ActionPolicy, capability: ActionCapability): ActionDecision {
  if (policy.emergencyStop) return 'deny';
  if (SAFE_CAPABILITIES.has(capability)) return 'allow';
  if (policy.mode === 'fully-autonomous') return 'allow';
  return 'approval-required';
}
