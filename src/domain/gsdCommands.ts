export interface GsdCommandDefinition {
  command: string;
  title: string;
  category: 'Start' | 'Workflow' | 'Context' | 'Review' | 'Manage';
  description: string;
}

export const GSD_COMMANDS: readonly GsdCommandDefinition[] = [
  { command: 'new-project', title: 'Start a new project', category: 'Start', description: 'Create project context and requirements from an idea.' },
  { command: 'onboard', title: 'Onboard an existing codebase', category: 'Start', description: 'Map an existing repository and establish GSD context.' },
  { command: 'next', title: 'Continue with the next step', category: 'Workflow', description: 'Inspect project state and choose the appropriate next action.' },
  { command: 'progress', title: 'Show project progress', category: 'Workflow', description: 'Review phases, plans, current state, and recommended action.' },
  { command: 'discuss-phase', title: 'Discuss a phase', category: 'Workflow', description: 'Clarify phase intent and capture decisions before planning.' },
  { command: 'plan-phase', title: 'Plan a phase', category: 'Workflow', description: 'Create an executable phase plan with verification steps.' },
  { command: 'execute-phase', title: 'Execute a phase', category: 'Workflow', description: 'Run phase plans with dependency-aware agent execution.' },
  { command: 'verify-work', title: 'Verify completed work', category: 'Review', description: 'Validate the implementation conversationally against acceptance criteria.' },
  { command: 'code-review', title: 'Review changed code', category: 'Review', description: 'Check changed source for bugs, security, and maintainability.' },
  { command: 'audit-uat', title: 'Audit outstanding UAT', category: 'Review', description: 'Find unresolved verification and acceptance gaps.' },
  { command: 'map-codebase', title: 'Map the codebase', category: 'Context', description: 'Generate architecture and codebase intelligence for agents.' },
  { command: 'graphify', title: 'Build the project knowledge graph', category: 'Context', description: 'Create or inspect the planning knowledge graph.' },
  { command: 'thread', title: 'Manage a context thread', category: 'Context', description: 'Preserve decisions and continuity across sessions.' },
  { command: 'stats', title: 'Show GSD statistics', category: 'Manage', description: 'Display phases, plans, requirements, and project metrics.' },
  { command: 'settings', title: 'Configure GSD workflow', category: 'Manage', description: 'Adjust workflow toggles, model profile, and automation.' },
  { command: 'update', title: 'Update Open-GSD', category: 'Manage', description: 'Update the installed GSD runtime and inspect its changelog.' }
];

export function searchGsdCommands(query: string): GsdCommandDefinition[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...GSD_COMMANDS];
  return GSD_COMMANDS.filter((definition) => [
    definition.command, definition.title, definition.category, definition.description
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
}
