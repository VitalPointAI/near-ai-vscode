import type { AgentTool } from '../agent/tools';
import { displayHost, McpConnection, McpSecrets, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpAgentTools, newServerManifest, serverManifest } from '../mcp/tools';
import { defaultMcpContexts, mcpToolEffects, parseMcpManifest } from '../domain/gate/manifest';
import type { McpManifest } from '../domain/gate/manifest';
import { describeMcpManifest, describeMcpTools, mcpToolChoiceOf } from '../domain/gate/words';
import type { McpToolChoice } from '../domain/gate/words';

// MCP servers the user has added: their settings (user-level storage), their secrets
// (SecretStorage: URLs, header values, environment values), which ones this project uses
// (workspace state, never the repository), and live connection status and call statistics
// (memory only). VS Code storage is passed in so this can be tested without VS Code.

export interface KeyValueStore { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> }
export interface SecretStore { get(key: string): Thenable<string | undefined> | Promise<string | undefined>; store(key: string, value: string): Thenable<void> | Promise<void>; delete(key: string): Thenable<void> | Promise<void> }

export type McpState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface McpServerStatus {
  config: McpServerConfig;
  host: string;
  hasSecrets: { url: boolean; headers: string[]; env: string[] };
  enabledHere: boolean;
  state: McpState;
  error?: string;
  serverInfo?: string;
  tools: McpToolInfo[];
  calls: number;
  errors: number;
  averageMs?: number;
  lastUsed?: number;
  /**
   * The server's manifest in plain sentences, in a fixed order: where it runs, what it can do, each declared tool by name in sorted order, whether it can run when
   * nobody is watching, and last the sentence that this is a declaration NEAR AI cannot check (GATE-03, D-07). Never empty, and the last entry is always that sentence.
   */
  manifestWords: string[];
  /** What the person has declared for each tool the server lists right now: `unknown` for one with no declaration. */
  toolChoices: Record<string, McpToolChoice>;
}

/** The three things the MCP page lets a person say a tool does (D-06, D-07). */
export const MCP_DECLARE_CHOICES = Object.freeze(['reads', 'changes-remote', 'unknown'] as const);
export type McpDeclareChoice = (typeof MCP_DECLARE_CHOICES)[number];

const SERVERS_KEY = 'nearAi.mcp.servers';
const ENABLED_KEY = 'nearAi.mcp.enabled';
const secretKey = (id: string) => `nearAi.mcp.server.${id}`;
export const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

interface Live { connection?: McpConnection; state: McpState; error?: string; calls: number; errors: number; totalMs: number; lastUsed?: number }

/** The manifest's words and the person's declaration for each listed tool; the claim sentence always comes last, after the declared tools. */
function manifestFacts(config: McpServerConfig, host: string, tools: McpToolInfo[]): Pick<McpServerStatus, 'manifestWords' | 'toolChoices'> {
  const manifest = serverManifest(config);
  const words = describeMcpManifest(manifest, config.transport, host);
  const claim = words.slice(-1);
  return {
    manifestWords: [...words.slice(0, -1), ...describeMcpTools(manifest), ...claim],
    toolChoices: Object.fromEntries(tools.map((tool) => [tool.name, mcpToolChoiceOf(manifest !== undefined && Object.prototype.hasOwnProperty.call(manifest.tools, tool.name) ? manifest.tools[tool.name] : undefined)]))
  };
}

export class McpRegistry {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly global: KeyValueStore, private readonly workspace: KeyValueStore, private readonly secrets: SecretStore, private readonly cwd?: string, private readonly connect: (config: McpServerConfig, secrets: McpSecrets, cwd?: string) => McpConnection = (config, values, root) => new McpConnection(config, values, root)) {}

  public onDidChange(listener: () => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  private changed(): void { for (const listener of this.listeners) listener(); }

  public servers(): McpServerConfig[] { return this.global.get<McpServerConfig[]>(SERVERS_KEY) ?? []; }
  public enabledHere(): string[] { return (this.workspace.get<string[]>(ENABLED_KEY) ?? []).filter((id) => this.servers().some((server) => server.id === id)); }

  private async secretsFor(id: string): Promise<McpSecrets> {
    try { return JSON.parse((await this.secrets.get(secretKey(id))) ?? '{}') as McpSecrets; } catch { return {}; }
  }

  /** Adds or replaces a server. Secret fields left undefined keep their stored values. */
  public async save(config: McpServerConfig, secrets: Partial<McpSecrets>): Promise<void> {
    if (!SERVER_ID.test(config.id)) throw new Error('A server id is 1-31 lowercase letters, digits, or dashes.');
    const previous = await this.secretsFor(config.id);
    const stored = this.withManifest(config);
    await this.secrets.store(secretKey(config.id), JSON.stringify({ ...previous, ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== undefined)) }));
    await this.global.update(SERVERS_KEY, [...this.servers().filter((server) => server.id !== config.id), stored].sort((a, b) => a.name.localeCompare(b.name)));
    await this.disconnect(config.id);
  }

  /**
   * The config as it is stored. A server added for the first time starts with the restrictive manifest; one that is already stored keeps its own, and one stored with none
   * stays without (today's behaviour, D-38). The page's save message carries no manifest, so the stored one must be carried over here or an edit would drop it.
   */
  private withManifest(config: McpServerConfig): McpServerConfig {
    const existing = this.servers().find((server) => server.id === config.id);
    const { manifest: _ignored, ...rest } = config;
    const given = config.manifest ?? existing?.manifest;
    if (given === undefined) return existing ? rest : { ...rest, manifest: newServerManifest(config.id, config.transport) };
    if (existing !== undefined && existing.transport !== config.transport) {
      // Changing where a server runs changes what its manifest says about it; a server that now runs on this machine is only for runs where the person is there.
      const moved = parseMcpManifest({ ...given, runsOn: config.transport === 'stdio' ? 'this-machine' : 'remote', contexts: config.transport === 'stdio' ? ['interactive'] : given.contexts });
      return { ...rest, manifest: moved.ok ? moved.value : newServerManifest(config.id, config.transport) };
    }
    return { ...rest, manifest: given };
  }

  /**
   * Records what the person says one tool of a server does (D-06, D-07): `reads` is the call alone, `changes-remote` is the call and a connection to the server's host,
   * `unknown` takes the declaration away so the server's default for undeclared tools applies. Only a tool the connected server lists can be declared, by its exact
   * name. A server with no manifest gets one with this first declaration and keeps today's behaviour for its other tools (D-38). The whole manifest is parsed again
   * before it is stored.
   */
  public async declareMcpToolEffects(serverId: string, toolName: string, choice: McpDeclareChoice): Promise<void> {
    const config = this.servers().find((server) => server.id === serverId);
    if (!config) throw new Error(`No MCP server ${serverId}.`);
    if (!(MCP_DECLARE_CHOICES as readonly string[]).includes(choice)) throw new Error('Choose what the tool does: only reads, changes data on the server, or not known.');
    const offered = this.live.get(serverId)?.connection?.tools ?? [];
    if (!offered.some((tool) => tool.name === toolName)) throw new Error(`${config.name} does not list a tool called ${toolName}. Connect it to see its tools.`);
    const current = serverManifest(config);
    if (current === undefined && choice === 'unknown') return;
    const base: McpManifest = current ?? { manifestVersion: 1, server: config.id, runsOn: config.transport === 'stdio' ? 'this-machine' : 'remote', hosts: [], credentials: [], contexts: defaultMcpContexts(config.transport), tools: {}, toolDefaults: 'legacy' };
    const others = Object.entries(base.tools).filter(([name]) => name !== toolName);
    let entries = others;
    if (choice !== 'unknown') {
      const effects = mcpToolEffects(undefined, { server: config.id, tool: toolName, host: displayHost(await this.secretsFor(config.id)), readOnly: choice === 'reads', destructive: false, approval: 'ask-for-changes', transport: config.transport });
      if (effects.defaults !== 'legacy') throw new Error(`${toolName} has a name a declaration cannot hold, so it stays treated as able to do anything.`);
      entries = [...others, [toolName, { effects: effects.effects }]];
    }
    const parsed = parseMcpManifest({ ...base, tools: Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) });
    if (!parsed.ok) throw new Error(`That declaration was refused (${parsed.reason} at ${parsed.path || 'the top'}).`);
    await this.global.update(SERVERS_KEY, this.servers().map((server) => (server.id === serverId ? { ...server, manifest: parsed.value } : server)));
    this.changed();
  }

  public async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.secrets.delete(secretKey(id));
    await this.global.update(SERVERS_KEY, this.servers().filter((server) => server.id !== id));
    await this.workspace.update(ENABLED_KEY, this.enabledHere().filter((entry) => entry !== id));
    this.live.delete(id);
    this.changed();
  }

  public async setEnabledHere(id: string, enabled: boolean): Promise<void> {
    const ids = new Set(this.enabledHere());
    if (enabled) ids.add(id); else ids.delete(id);
    await this.workspace.update(ENABLED_KEY, [...ids]);
    if (!enabled) await this.disconnect(id);
    this.changed();
  }

  public async update(id: string, change: Partial<Pick<McpServerConfig, 'approval' | 'disabledTools'>>): Promise<void> {
    await this.global.update(SERVERS_KEY, this.servers().map((server) => (server.id === id ? { ...server, ...change } : server)));
    this.changed();
  }

  private entry(id: string): Live {
    let live = this.live.get(id);
    if (!live) { live = { state: 'disconnected', calls: 0, errors: 0, totalMs: 0 }; this.live.set(id, live); }
    return live;
  }

  public async connectServer(id: string): Promise<McpConnection> {
    const config = this.servers().find((server) => server.id === id);
    if (!config) throw new Error(`No MCP server ${id}.`);
    const live = this.entry(id);
    if (live.connection?.connected) return live.connection;
    live.state = 'connecting';
    live.error = undefined;
    this.changed();
    const connection = this.connect(config, await this.secretsFor(id), this.cwd);
    try {
      await connection.connect();
      live.connection = connection;
      live.state = 'connected';
      return connection;
    } catch (error) {
      live.state = 'error';
      live.error = (error as Error).message.slice(0, 500);
      await connection.close();
      throw error;
    } finally {
      this.changed();
    }
  }

  public async disconnect(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    await live.connection?.close();
    live.connection = undefined;
    live.state = 'disconnected';
    this.changed();
  }

  /** Agent tools for this project's servers; a server that can't connect is reported, not fatal. */
  public async agentTools(): Promise<{ tools: AgentTool<any>[]; problems: string[] }> {
    const tools: AgentTool<any>[] = [];
    const problems: string[] = [];
    await Promise.all(this.enabledHere().map(async (id) => {
      const config = this.servers().find((server) => server.id === id)!;
      try {
        const connection = await this.connectServer(id);
        tools.push(...mcpAgentTools(config, connection, displayHost(await this.secretsFor(id)), { onCall: (serverId, ok, ms) => this.recordCall(serverId, ok, ms) }));
      } catch (error) {
        problems.push(`MCP server ${config.name} is unavailable, so its tools are not offered this time: ${(error as Error).message}`);
      }
    }));
    return { tools, problems };
  }

  private recordCall(id: string, ok: boolean, ms: number): void {
    const live = this.entry(id);
    live.calls += 1;
    if (!ok) live.errors += 1;
    live.totalMs += ms;
    live.lastUsed = Date.now();
    this.changed();
  }

  /** Everything the management page shows; secrets appear only as "set" flags and header or variable names. */
  public async status(): Promise<McpServerStatus[]> {
    const enabled = new Set(this.enabledHere());
    return Promise.all(this.servers().map(async (config) => {
      const secrets = await this.secretsFor(config.id);
      const live = this.entry(config.id);
      return {
        config, host: displayHost(secrets), enabledHere: enabled.has(config.id),
        hasSecrets: { url: Boolean(secrets.url), headers: Object.keys(secrets.headers ?? {}), env: Object.keys(secrets.env ?? {}) },
        state: live.state, ...(live.error ? { error: live.error } : {}), ...(live.connection?.serverInfo ? { serverInfo: live.connection.serverInfo } : {}),
        tools: live.connection?.tools ?? [], calls: live.calls, errors: live.errors,
        ...(live.calls ? { averageMs: Math.round(live.totalMs / live.calls) } : {}), ...(live.lastUsed ? { lastUsed: live.lastUsed } : {}),
        ...manifestFacts(config, displayHost(secrets).replace(/:\d+$/, ''), live.connection?.tools ?? [])
      };
    }));
  }

  public async dispose(): Promise<void> { await Promise.all([...this.live.keys()].map((id) => this.disconnect(id))); }
}
