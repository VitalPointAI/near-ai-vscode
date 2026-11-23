import { createHash } from 'node:crypto';
import type { AgentTool } from '../agent/tools';
import { displayHost, McpConnection, McpSecrets, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpAgentTools, mcpToolChanges, mcpToolDescription, mcpToolDigest, mcpToolDigests, newServerManifest, serverManifest } from '../mcp/tools';
import type { McpToolChanges } from '../mcp/tools';
import { defaultMcpContexts, mcpToolEffects, parseMcpManifest, parseMcpServerEffects } from '../domain/gate/manifest';
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
  /** How the tools the server lists now differ from the ones the person approved (WP-GATE); absent when they do not, or nothing is connected. */
  toolChanges?: McpToolChanges;
}

/** The notice for a server whose tools changed after the person approved them (WP-GATE). Plain words; names only the tools, never what they say. */
export function toolChangesNotice(serverName: string, changes: McpToolChanges): string {
  const parts = [
    ...(changes.added.length ? [`new: ${changes.added.join(', ')}`] : []),
    ...(changes.changed.length ? [`changed description, inputs or hints: ${changes.changed.join(', ')}`] : []),
    ...(changes.removed.length ? [`no longer listed: ${changes.removed.join(', ')}`] : [])
  ];
  const held = changes.added.length + changes.changed.length > 0 ? ' New and changed tools are not offered to agents until you approve them.' : '';
  return `MCP server ${serverName} changed its tools since you approved them (${parts.join('; ')}).${held} Review them with SovAI: Manage MCP Connections and choose Approve tool changes.`;
}

/** The notice for a tool whose description looks like it tries to instruct the assistant (WP-GATE): it is fenced as untrusted, and the person is told. */
export function descriptionWarningNotice(serverName: string, toolName: string, warnings: readonly string[]): string {
  return `The description of ${toolName} on MCP server ${serverName} ${warnings.join('; ')}. It is passed to the model only as fenced, untrusted text; check that you trust this server.`;
}

/** The three things the MCP page lets a person say a tool does (D-06, D-07). */
export const MCP_DECLARE_CHOICES = Object.freeze(['reads', 'changes-remote', 'unknown'] as const);
export type McpDeclareChoice = (typeof MCP_DECLARE_CHOICES)[number];

/** A refusal of a declaration whose message is ours, plain and safe to show on the page. Any other error is shown as DECLARE_FAILED_TEXT. */
export class McpDeclareRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'McpDeclareRefused';
  }
}

/** A refusal of an approval of tool changes whose message is ours, plain and safe to show on the page (review round 1). */
export class McpApproveRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'McpApproveRefused';
  }
}

export const APPROVE_FAILED_TEXT = 'NEAR AI could not save your approval of these tools, so nothing was changed and they stay held. Try again, or reload the window.';

/** Runs an approval of tool changes for the MCP page and never rejects: our refusal is shown as it is, anything else as APPROVE_FAILED_TEXT. */
export async function approveOrReport(run: () => Promise<void>, show: (text: string) => void): Promise<void> {
  try {
    await run();
  } catch (error) {
    try { show(error instanceof McpApproveRefused ? error.message.slice(0, 300) : APPROVE_FAILED_TEXT); } catch { /* a message that cannot be shown changes nothing */ }
  }
}

export const DECLARE_FAILED_TEXT = 'NEAR AI could not save what that tool does, so nothing was changed. Try again, or reload the window.';

/**
 * Runs one declaration for the MCP page and never rejects: a plain refusal of ours is shown as it is, and any other failure (a storage error, say, whose text
 * could carry a name or a path) is shown as the fixed sentence above, never as the raw error text. `show` is called at most once and is itself never allowed to throw.
 */
export async function declareOrReport(run: () => Promise<void>, show: (text: string) => void): Promise<void> {
  try {
    await run();
  } catch (error) {
    try { show(error instanceof McpDeclareRefused ? error.message.slice(0, 300) : DECLARE_FAILED_TEXT); } catch { /* a message that cannot be shown changes nothing */ }
  }
}

const SERVERS_KEY = 'nearAi.mcp.servers';
/** The user setting that declares what a local server's tools may do. */
export const LOCAL_EFFECTS_SETTING = 'nearAi.mcp.localServerEffects';
const ENABLED_KEY = 'nearAi.mcp.enabled';
/** The ids of servers whose tool approval was ever recorded (review round 1), kept apart from the servers so a lost record is noticed after a reload too. */
const APPROVED_ONCE_KEY = 'nearAi.mcp.toolsApprovedOnce';
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

/** How many told notices of each kind a window remembers (PR #102 review): a server that changes its listing every turn cannot grow them without bound. */
export const MAX_TOLD_NOTICES = 500;

/**
 * A set of notices already told, oldest first, holding at most `limit` (the oldest is forgotten first, and may then be told once more). Each key is kept
 * as its sha256, so a long listing or description costs 64 characters, not its own length.
 */
export class ToldNotices {
  private readonly keys = new Set<string>();
  public constructor(private readonly limit: number = MAX_TOLD_NOTICES) {}
  public get size(): number { return this.keys.size; }
  /** True the first time `key` is seen (and it is remembered); false while it is still remembered. */
  public firstTime(key: string): boolean {
    const digest = createHash('sha256').update(key).digest('hex');
    if (this.keys.has(digest)) return false;
    this.keys.add(digest);
    while (this.keys.size > this.limit) this.keys.delete(this.keys.values().next().value as string);
    return true;
  }
}

export class McpRegistry {
  private readonly live = new Map<string, Live>();
  /** Description warnings already told in this window, by server, tool and digest, so one description is reported once, not on every message. */
  private readonly toldWarnings = new ToldNotices();
  /** Tool-change notices already told in this window, by server and the digest of the approved and listed tools, so one change is told once, not every turn. */
  private readonly toldChanges = new ToldNotices();
  /** The tail of the queue of writes to the stored server list. */
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  /**
   * `localServerEffects` reads the user setting `nearAi.mcp.localServerEffects` (only the person's own user value: a workspace cannot declare what a server
   * may do), when the tools are built; absent, nothing is declared.
   */
  public constructor(private readonly global: KeyValueStore, private readonly workspace: KeyValueStore, private readonly secrets: SecretStore, private readonly cwd?: string, private readonly connect: (config: McpServerConfig, secrets: McpSecrets, cwd?: string) => McpConnection = (config, values, root) => new McpConnection(config, values, root), private readonly localServerEffects: () => unknown = () => undefined) {}

  public onDidChange(listener: () => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  private changed(): void { for (const listener of this.listeners) listener(); }

  public servers(): McpServerConfig[] { return this.global.get<McpServerConfig[]>(SERVERS_KEY) ?? []; }
  public enabledHere(): string[] { return (this.workspace.get<string[]>(ENABLED_KEY) ?? []).filter((id) => this.servers().some((server) => server.id === id)); }

  private async secretsFor(id: string): Promise<McpSecrets> {
    try { return JSON.parse((await this.secrets.get(secretKey(id))) ?? '{}') as McpSecrets; } catch { return {}; }
  }

  /** Adds or replaces a server. Secret fields left undefined keep their stored values. */
  public async save(given: McpServerConfig, secrets: Partial<McpSecrets>): Promise<void> {
    // What a local server may do comes from the user setting each time the tools are built; it is never stored with the server.
    const { localEffects: _declared, ...config } = given;
    if (!SERVER_ID.test(config.id)) throw new Error('A server id is 1-31 lowercase letters, digits, or dashes.');
    const previous = await this.secretsFor(config.id);
    await this.secrets.store(secretKey(config.id), JSON.stringify({ ...previous, ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== undefined)) }));
    // The stored form is worked out inside the write, from the list as it is then, so a record another write made meanwhile is carried over.
    // A server pointed somewhere else (a new web address, transport, or program) is a different server: it keeps no tool approval (PR #102 review).
    const existing = this.servers().find((server) => server.id === config.id);
    const repointed = existing !== undefined && (existing.transport !== config.transport || existing.command !== config.command
      || JSON.stringify(existing.args ?? []) !== JSON.stringify(config.args ?? []) || (secrets.url !== undefined && secrets.url !== previous.url));
    // Its id is marked as approved once, so the next connection holds every tool for the person to approve rather than recording them as a first one.
    const dropsApproval = repointed && (existing?.approvedTools !== undefined || this.approvedOnce().includes(config.id));
    await this.writeServers(
      (servers) => { const stored = this.withManifest(config, repointed); return [...servers.filter((server) => server.id !== config.id), stored].sort((a, b) => a.name.localeCompare(b.name)); },
      dropsApproval ? (ids) => (ids.includes(config.id) ? ids : [...ids, config.id]) : undefined
    );
    await this.disconnect(config.id);
  }

  /**
   * The config as it is stored. A server added for the first time starts with the restrictive manifest; one that is already stored keeps its own, and one stored with none
   * stays without (today's behaviour, D-38). The page's save message carries no manifest, so the stored one must be carried over here or an edit would drop it.
   */
  private withManifest(config: McpServerConfig, repointed = false): McpServerConfig {
    const existing = this.servers().find((server) => server.id === config.id);
    const { manifest: _ignored, approvedTools: _approved, ...base } = config;
    // The approved tool listing is the registry's own record (WP-GATE): an edit from the page carries none, so the stored one is kept, unless the edit
    // points the server somewhere else. Then the record is dropped, and approvedFor holds every tool until the person approves the new server's listing.
    const rest: McpServerConfig = existing?.approvedTools === undefined || repointed ? base : { ...base, approvedTools: existing.approvedTools };
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
    if (!config) throw new McpDeclareRefused(`No MCP server ${serverId}.`);
    if (!(MCP_DECLARE_CHOICES as readonly string[]).includes(choice)) throw new McpDeclareRefused('Choose what the tool does: only reads, changes data on the server, or not known.');
    const offered = this.live.get(serverId)?.connection?.tools ?? [];
    if (!offered.some((tool) => tool.name === toolName)) throw new McpDeclareRefused(`${config.name} does not list a tool called ${toolName}. Connect it to see its tools.`);
    const current = serverManifest(config);
    if (current === undefined && choice === 'unknown') return;
    const base: McpManifest = current ?? { manifestVersion: 1, server: config.id, runsOn: config.transport === 'stdio' ? 'this-machine' : 'remote', hosts: [], credentials: [], contexts: defaultMcpContexts(config.transport), tools: {}, toolDefaults: 'legacy' };
    const others = Object.entries(base.tools).filter(([name]) => name !== toolName);
    let entries = others;
    if (choice !== 'unknown') {
      const effects = mcpToolEffects(undefined, { server: config.id, tool: toolName, host: displayHost(await this.secretsFor(config.id)), readOnly: choice === 'reads', destructive: false, approval: 'ask-for-changes', transport: config.transport });
      if (effects.defaults !== 'legacy') throw new McpDeclareRefused(`${toolName} has a name a declaration cannot hold, so it stays treated as able to do anything.`);
      entries = [...others, [toolName, { effects: effects.effects }]];
    }
    const parsed = parseMcpManifest({ ...base, tools: Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) });
    if (!parsed.ok) throw new McpDeclareRefused(`That declaration was refused (${parsed.reason} at ${parsed.path || 'the top'}).`);
    await this.writeServers((servers) => servers.map((server) => (server.id === serverId ? { ...server, manifest: parsed.value } : server)));
    this.changed();
  }

  public async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.secrets.delete(secretKey(id));
    await this.writeServers((servers) => servers.filter((server) => server.id !== id), (ids) => ids.filter((entry) => entry !== id));
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
    await this.writeServers((servers) => servers.map((server) => (server.id === id ? { ...server, ...change } : server)));
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
      // The first connection records the tools the person approved by adding the server (WP-GATE); later changes wait for approveToolChanges.
      if (this.approvedFor(this.servers().find((server) => server.id === id) ?? config) === undefined) await this.recordApprovedTools(id, connection.tools);
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

  /**
   * Every change to the stored server list goes through here, one at a time (review round 1): each change reads the list as the previous write left it, so
   * two servers recording their approvals at once (agentTools connects them all together) never overwrite each other's record.
   */
  private writeServers(change: (servers: McpServerConfig[]) => McpServerConfig[], approvedOnce?: (ids: string[]) => string[]): Promise<void> {
    const next = this.writing.then(async () => {
      await this.global.update(SERVERS_KEY, change(this.servers()));
      if (approvedOnce !== undefined) await this.global.update(APPROVED_ONCE_KEY, approvedOnce(this.approvedOnce()));
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  /**
   * The approved tool listing the registry goes by (review round 1): the stored one; none for a server never connected (its first connection records it);
   * and, for a server whose approval was ever recorded (APPROVED_ONCE_KEY) but whose stored record is gone, an empty one, so every tool is held until the person approves
   * them again. A lost record never reads as a first connection: the trust check fails closed.
   */
  private approvedFor(config: McpServerConfig): Record<string, string> | undefined {
    if (config.approvedTools !== undefined) return config.approvedTools;
    return this.approvedOnce().includes(config.id) ? {} : undefined;
  }

  private approvedOnce(): string[] {
    const ids = this.global.get<unknown>(APPROVED_ONCE_KEY);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  private async recordApprovedTools(id: string, tools: readonly McpToolInfo[]): Promise<void> {
    const approvedTools = mcpToolDigests(tools);
    await this.writeServers((servers) => servers.map((server) => (server.id === id ? { ...server, approvedTools } : server)), (ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  /**
   * The person approves the tools a connected server lists now, descriptions, inputs and hints included (WP-GATE): from then on they are the ones offered,
   * and a later change is held again. Only the listing of a live connection can be approved, so what is approved is what the page showed.
   */
  public async approveToolChanges(id: string): Promise<void> {
    const config = this.servers().find((server) => server.id === id);
    if (!config) throw new McpApproveRefused(`No MCP server ${id}.`);
    const connection = this.live.get(id)?.connection;
    if (!connection?.connected) throw new McpApproveRefused(`Connect ${config.name} to see its tools before approving them.`);
    await this.recordApprovedTools(id, connection.tools);
    this.changed();
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
    const declarations = this.localDeclarations(problems);
    await Promise.all(this.enabledHere().map(async (id) => {
      const name = this.servers().find((server) => server.id === id)!.name;
      try {
        const connection = await this.connectServer(id);
        // Read after connecting: the first connection records the approved tools on the stored server.
        const stored = this.servers().find((server) => server.id === id)!;
        const approved = this.approvedFor(stored);
        const config = this.withLocalEffects(approved === undefined ? stored : { ...stored, approvedTools: approved }, declarations, problems);
        const changes = mcpToolChanges(approved, connection.tools);
        const listing = `${id}\u0000${JSON.stringify(approved ?? {}, Object.keys(approved ?? {}).sort())}\u0000${JSON.stringify(mcpToolDigests(connection.tools), connection.tools.map((tool) => tool.name).sort())}`;
        if (changes !== undefined && this.toldChanges.firstTime(listing)) {
          problems.push(toolChangesNotice(config.name, changes));
        }
        const offered = mcpAgentTools(config, connection, displayHost(await this.secretsFor(id)), { onCall: (serverId, ok, ms) => this.recordCall(serverId, ok, ms) });
        const disabled = new Set(config.disabledTools ?? []);
        for (const tool of connection.tools) {
          if (disabled.has(tool.name)) continue;
          const warnings = mcpToolDescription(config.name, tool).warnings;
          const told = `${id}\u0000${tool.name}\u0000${mcpToolDigest(tool)}`;
          if (warnings.length > 0 && this.toldWarnings.firstTime(told)) {
            problems.push(descriptionWarningNotice(config.name, tool.name, warnings));
          }
        }
        tools.push(...offered);
      } catch (error) {
        problems.push(`MCP server ${name} is unavailable, so its tools are not offered this time: ${(error as Error).message}`);
      }
    }));
    return { tools, problems };
  }

  /** The user setting's declarations by server id; one that is not an object is ignored with a warning. */
  private localDeclarations(problems: string[]): Readonly<Record<string, unknown>> {
    let raw: unknown;
    try { raw = this.localServerEffects(); } catch { raw = undefined; }
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${LOCAL_EFFECTS_SETTING} is not a list of server ids with what each may do, so it is ignored and local servers' tools that change data still ask before every call.`);
      return {};
    }
    return raw as Record<string, unknown>;
  }

  /**
   * The server with what the person declared for it (owner decision after PR #74). Only a local server's declaration is used; a declaration for a server
   * with a web address, or one that does not parse, is ignored with a warning, and the server's tools decide as they did (a data-changing one keeps asking).
   */
  private withLocalEffects(config: McpServerConfig, declarations: Readonly<Record<string, unknown>>, problems: string[]): McpServerConfig {
    const { localEffects: _stale, ...clean } = config;
    if (!Object.prototype.hasOwnProperty.call(declarations, config.id)) return clean;
    if (config.transport !== 'stdio') {
      problems.push(`${config.name} has a web address, so what ${LOCAL_EFFECTS_SETTING} declares for it is ignored; it is only for servers that run on this computer.`);
      return clean;
    }
    const parsed = parseMcpServerEffects(declarations[config.id]);
    if (!parsed.ok) {
      problems.push(`What ${LOCAL_EFFECTS_SETTING} declares for ${config.name} could not be read (${parsed.reason} at ${parsed.path || 'the top'}), so it is ignored and the server's tools that change data still ask before every call.`);
      return clean;
    }
    return { ...clean, localEffects: parsed.value };
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
        ...manifestFacts(config, displayHost(secrets).replace(/:\d+$/, ''), live.connection?.tools ?? []),
        ...(() => { const changes = live.connection?.connected ? mcpToolChanges(this.approvedFor(config), live.connection.tools) : undefined; return changes === undefined ? {} : { toolChanges: changes }; })()
      };
    }));
  }

  public async dispose(): Promise<void> { await Promise.all([...this.live.keys()].map((id) => this.disconnect(id))); }
}
