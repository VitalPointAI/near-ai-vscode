import type { AgentTool } from '../agent/tools';
import { fenceUntrusted } from '../agent/untrusted';
import { ToolError } from '../agent/workspace';
import type { McpConnection, McpServerConfig, McpToolInfo } from './client';

// An MCP server's tools as agent tools named mcp__<server>__<tool> (the convention Open-GSD's
// agent definitions use, e.g. mcp__context7__*). Arguments go to that server; results are outside
// content. Whether a call asks first follows the server's approval setting and the tool's hints.

const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');

export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${slug(serverId)}__${slug(tool)}`.slice(0, 64);
}

/** Whether a team member's or agent's tool list grants this MCP tool: exact name, mcp:<server>, or a trailing * pattern. */
export function grantsMcpTool(granted: string[], toolName: string): boolean {
  return granted.some((entry) => {
    if (entry === toolName) return true;
    const server = /^mcp:([\w-]+)$/.exec(entry)?.[1];
    if (server) return toolName.startsWith(`mcp__${slug(server)}__`);
    return entry.endsWith('*') && toolName.startsWith(entry.slice(0, -1));
  });
}

export interface McpCallStats { onCall(serverId: string, ok: boolean, ms: number): void }

export function mcpAgentTools(config: McpServerConfig, connection: McpConnection, host: string, stats?: McpCallStats): AgentTool<Record<string, unknown>>[] {
  const disabled = new Set(config.disabledTools ?? []);
  return connection.tools.filter((tool) => !disabled.has(tool.name)).map((tool) => mcpAgentTool(config, connection, tool, host, stats));
}

function mcpAgentTool(config: McpServerConfig, connection: McpConnection, tool: McpToolInfo, host: string, stats?: McpCallStats): AgentTool<Record<string, unknown>> {
  const where = host ? `${config.name} (${host})` : config.name;
  const readOnly = tool.readOnly && !tool.destructive;
  const asks = config.approval === 'ask-every-call' || (config.approval === 'ask-for-changes' && !readOnly);
  const schema = tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  return {
    name: mcpToolName(config.id, tool.name),
    description: `[MCP: ${config.name}] ${tool.description || tool.name}`.slice(0, 1_024),
    parameters: schema,
    // Read-only tools on a server that isn't "ask every call" follow the normal rules for reads.
    capability: readOnly && config.approval !== 'ask-every-call' ? 'read' : 'network',
    untrusted: true,
    parse: (raw) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
      return raw;
    },
    title: () => `${config.name} › ${tool.name}`,
    async preview(input) {
      const args = JSON.stringify(input, null, 2);
      return { kind: 'note', text: `Call ${tool.name} on ${where}. These arguments are sent to that server:\n${args.length > 4_000 ? `${args.slice(0, 4_000)}\n…` : args}${tool.destructive ? '\n\nThe server marks this tool as able to change or delete data.' : ''}` };
    },
    risky: () => (asks ? `${config.approval === 'ask-every-call' ? `${config.name} is set to ask before every call.` : `${tool.name} can change data on ${config.name}.`} Approve it only if you expect this call.` : undefined),
    async run(input, context) {
      const started = Date.now();
      try {
        const text = await connection.call(tool.name, input, context.signal);
        stats?.onCall(config.id, true, Date.now() - started);
        const fenced = fenceUntrusted(`MCP ${config.name} · ${tool.name}`, text);
        if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: `MCP ${config.name} · ${tool.name}`, detail: fenced.warnings.join('; ') });
        return fenced.text;
      } catch (error) {
        stats?.onCall(config.id, false, Date.now() - started);
        throw error;
      }
    }
  };
}
