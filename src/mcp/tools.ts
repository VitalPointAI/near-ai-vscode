import { declareManifest } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { mcpToolEffects, parseMcpManifest, RESTRICTIVE_EFFECTS } from '../domain/gate/manifest';
import type { McpManifest, McpToolEffects, ToolManifest } from '../domain/gate/manifest';
import type { ActionCapability } from '../domain/policy';
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

/** What a server added from now on starts with: every tool undeclared and most restrictive, only while the person is there (D-06). */
export function newServerManifest(id: string, transport: 'http' | 'stdio'): McpManifest {
  const draft = (server: string) => parseMcpManifest({ manifestVersion: 1, server, runsOn: transport === 'stdio' ? 'this-machine' : 'remote', hosts: [], credentials: [], contexts: ['interactive'], tools: {}, toolDefaults: 'restrictive' });
  const parsed = draft(id);
  const fallback = parsed.ok ? parsed : draft('server');
  if (!fallback.ok) throw new Error(`The restrictive starting manifest did not parse (${fallback.reason}); this is a bug.`);
  return fallback.value;
}

/**
 * The manifest the gate reads for a server: none for one configured before manifests existed (today's behaviour, D-38), the stored one when it parses, and the
 * restrictive starting one when what is stored does not (a hand-edited or damaged settings file never widens what a server may do, T-70-31).
 */
export function serverManifest(config: McpServerConfig): McpManifest | undefined {
  if (config.manifest === undefined) return undefined;
  const parsed = parseMcpManifest(config.manifest);
  if (parsed.ok) return parsed.value;
  return newServerManifest(config.id, config.transport);
}

/** The effects, contexts and shorthand of one tool of one server, from the server's manifest (exact tool name only) or, with none, from today's rules. */
export function mcpToolDecision(config: McpServerConfig, tool: McpToolInfo, host: string): McpToolEffects {
  return mcpToolEffects(serverManifest(config), {
    server: config.id, tool: tool.name, host, readOnly: tool.readOnly, destructive: tool.destructive, approval: config.approval, transport: config.transport,
    ...(config.localEffects === undefined ? {} : { localEffects: config.localEffects }),
    ...(tool.hints?.destructive === undefined ? {} : { destructiveHint: tool.hints.destructive }),
    ...(tool.hints?.openWorld === undefined ? {} : { openWorldHint: tool.hints.openWorld })
  });
}

/**
 * The settings layer's one-word view of an MCP tool. For a server with no manifest, or an undeclared tool on a server set to follow today's rules, it is today's split: a
 * read-only tool on a server not set to ask every call is `read`, anything else `network`. A declared or restrictive tool is a `read` when it only calls the server and
 * `network` when it also reaches anything else; a server set to ask before every call is never quieter than `network`.
 */
export function mcpToolCapability(config: McpServerConfig, tool: McpToolInfo, host: string): ActionCapability {
  const decision = mcpToolDecision(config, tool, host);
  // A local server's tool decided by the person's declaration for the server: what was declared says it, unless the server asks before every call.
  if (decision.defaults === 'server') return config.approval === 'ask-every-call' ? 'network' : decision.shorthand;
  if (serverManifest(config) === undefined || decision.defaults === 'legacy') {
    const readOnly = tool.readOnly && !tool.destructive;
    return readOnly && config.approval !== 'ask-every-call' ? 'read' : 'network';
  }
  if (config.approval === 'ask-every-call') return 'network';
  // The call on the server itself is a read, as it is for a read-only tool today; anything else a declaration or the restrictive default adds is network.
  return decision.effects.every((effect) => effect.verb === 'mcp') ? 'read' : 'network';
}

/**
 * The manifest of one MCP tool: the server's own when it has one (GATE-02, GATE-03, D-06), else the legacy one (D-38). A read-only tool on a server that is not set to
 * ask every call is a call on that server; any other tool is a call that also reaches the server's host. It is built from the same facts `capability` is computed from,
 * by `mcpToolEffects`, so the gate sees exactly what the settings layer sees. The server's own hints are a claim, and so is a declaration; its results are outside
 * content. A name the format cannot hold falls back to the restrictive effects rather than stopping the server from connecting.
 */
export function mcpToolManifest(config: McpServerConfig, tool: McpToolInfo, host: string): ToolManifest {
  const name = mcpToolName(config.id, tool.name);
  const remote = config.transport === 'http' ? ({ runsOn: 'remote' } as const) : {};
  const found = mcpToolDecision(config, tool, host);
  const hostsOf = (effects: readonly { readonly verb: string; readonly hosts?: readonly string[] }[]) => effects.flatMap((effect) => (effect.verb === 'network' ? effect.hosts ?? [] : []));
  try {
    return declareManifest({ tool: name, effects: found.effects, hosts: hostsOf(found.effects), contexts: found.contexts, untrusted: true, ...remote });
  } catch {
    return declareManifest({ tool: name, effects: RESTRICTIVE_EFFECTS, hosts: hostsOf(RESTRICTIVE_EFFECTS), contexts: ['interactive'], untrusted: true, ...remote });
  }
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
    // Without a manifest, read-only tools on a server that isn't "ask every call" follow the normal rules for reads; a manifest decides for the tools it declares.
    capability: mcpToolCapability(config, tool, host),
    manifest: mcpToolManifest(config, tool, host),
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
