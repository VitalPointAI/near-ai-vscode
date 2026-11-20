// One gate for every built-in staff server a run is given beside the staff-products tools (intel-workbench, observations, cop-map, logistics, orders, battle-rhythm), the way
// drop 1 review round 3 gated the intel-workbench: a call counts only from a member of the team whose own tools line grants that tool (the whole server
// `mcp:<id>`, a family pattern such as `mcp__logistics__calc*`, or the tool's name; the file-writing families in OWN_GRANT_FAMILIES only by their own grant). The run's lead is not a member, so it cannot call them, and neither
// can a member without the grant. A team where no member is granted any of a server's tools gets none of them. Pure: no I/O, no vscode.
import { grantsMcpTool } from '../mcp/tools';
import { OBSERVATIONS_WATCH } from './staff/grants';
import type { AgentTool, ToolContext } from './tools';

/**
 * Tool families that write files and are granted only by their own grant: the family pattern (for example `mcp__observations__watch_*`), a narrower
 * pattern inside it, or the tool's own name. A whole-server grant (`mcp:observations`, `mcp__observations__*`) or any wider pattern does not grant them,
 * so a hand-written tools line that asks for a server's reads never also hands out its file-writing tools. Each entry is the family's name prefix.
 */
export const OWN_GRANT_FAMILIES: readonly string[] = [OBSERVATIONS_WATCH.slice(0, -1)];

/** True when the tools line grants the tool: for a tool of an own-grant family, only by that family's own grant; otherwise as any MCP grant reads. */
export function grantsStaffTool(granted: readonly string[], tool: string): boolean {
  const family = OWN_GRANT_FAMILIES.find((prefix) => tool.startsWith(prefix));
  if (!family) return grantsMcpTool([...granted], tool);
  return granted.some((entry) => entry === tool || (entry.endsWith('*') && entry.startsWith(family) && tool.startsWith(entry.slice(0, -1))));
}

export interface GrantedTeam { readonly members: ReadonlyArray<{ readonly name: string; readonly tools: readonly string[] }> }

/** True when the named member of the team is granted the tool by its own tools line. */
export function memberGranted(team: GrantedTeam, member: string | undefined, tool: string): boolean {
  const entry = member === undefined ? undefined : team.members.find((candidate) => candidate.name === member);
  return Boolean(entry && grantsStaffTool(entry.tools, tool));
}

/** What a tools line names to grant the tool, for refusals: the family's own grant for an own-grant family, else the whole server. */
function grantFor(server: string, tool: string): string {
  const family = OWN_GRANT_FAMILIES.find((prefix) => tool.startsWith(prefix));
  return family ? `${family}*` : `mcp:${server}`;
}

/**
 * The server's tools a run with this team is given: only those some member is granted, each offered only to, and refusing every caller but, the
 * members whose own tools line grants it.
 * `hint` ends the refusal (who to ask instead).
 */
export function grantedToMembers(team: GrantedTeam, server: string, tools: readonly AgentTool<any>[], hint = ''): AgentTool<any>[] {
  return tools
    .filter((tool) => team.members.some((member) => grantsStaffTool(member.tools, tool.name)))
    .map((tool) => ({
      ...tool,
      // Offered exactly to the callers `forbidden` lets through: never to the run's lead, never to a member whose tools line does not grant it.
      offeredTo: (agentLabel: string | undefined) => memberGranted(team, agentLabel, tool.name) && (tool.offeredTo?.(agentLabel) ?? true),
      forbidden: async (input: unknown, context: ToolContext) => {
        if (!memberGranted(team, context.agentLabel, tool.name)) return `${tool.name} is for the team members whose tools line grants it (${grantFor(server, tool.name)}); ${context.agentLabel ?? 'the run\'s lead'} is not one of them.${hint ? ` ${hint}` : ''}`;
        return tool.forbidden ? tool.forbidden(input as never, context) : undefined;
      }
    }));
}
