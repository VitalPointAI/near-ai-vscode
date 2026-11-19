// One gate for every built-in staff server a run is given beside the staff-products tools (intel-workbench, observations, cop-map, logistics), the way
// drop 1 review round 3 gated the intel-workbench: a call counts only from a member of the team whose own tools line grants that tool (the whole server
// `mcp:<id>`, a family pattern such as `mcp__logistics__calc*`, or the tool's name). The run's lead is not a member, so it cannot call them, and neither
// can a member without the grant. A team where no member is granted any of a server's tools gets none of them. Pure: no I/O, no vscode.
import { grantsMcpTool } from '../mcp/tools';
import type { AgentTool, ToolContext } from './tools';

export interface GrantedTeam { readonly members: ReadonlyArray<{ readonly name: string; readonly tools: readonly string[] }> }

/** True when the named member of the team is granted the tool by its own tools line. */
export function memberGranted(team: GrantedTeam, member: string | undefined, tool: string): boolean {
  const entry = member === undefined ? undefined : team.members.find((candidate) => candidate.name === member);
  return Boolean(entry && grantsMcpTool([...entry.tools], tool));
}

/**
 * The server's tools a run with this team is given: only those some member is granted, each refusing a caller whose own tools line does not grant it.
 * `hint` ends the refusal (who to ask instead).
 */
export function grantedToMembers(team: GrantedTeam, server: string, tools: readonly AgentTool<any>[], hint = ''): AgentTool<any>[] {
  return tools
    .filter((tool) => team.members.some((member) => grantsMcpTool([...member.tools], tool.name)))
    .map((tool) => ({
      ...tool,
      forbidden: async (input: unknown, context: ToolContext) => {
        if (!memberGranted(team, context.agentLabel, tool.name)) return `${tool.name} is for the team members whose tools line grants it (mcp:${server}); ${context.agentLabel ?? 'the run\'s lead'} is not one of them.${hint ? ` ${hint}` : ''}`;
        return tool.forbidden ? tool.forbidden(input as never, context) : undefined;
      }
    }));
}
