import * as path from 'node:path';
import { ToolError } from '../agent/workspace';

// A connection to one MCP server through the official SDK's client (vendored in vendor/mcp):
// a local command over stdio, or a remote server over Streamable HTTP with an SSE fallback.

export type McpApproval = 'ask-for-changes' | 'ask-every-call' | 'trusted';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  /** stdio: the program and its arguments. */
  command?: string;
  args?: string[];
  approval: McpApproval;
  /** Tools the user switched off for this server. */
  disabledTools?: string[];
}

/** Values kept in SecretStorage: a remote URL may carry the access token itself. */
export interface McpSecrets { url?: string; headers?: Record<string, string>; env?: Record<string, string> }

export interface McpToolInfo { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; destructive: boolean }

type Sdk = {
  Client: new (info: { name: string; version: string }, options: { capabilities: Record<string, unknown> }) => SdkClient;
  StdioClientTransport: new (options: { command: string; args?: string[]; env?: Record<string, string>; stderr?: string; cwd?: string }) => SdkTransport;
  getDefaultEnvironment(): Record<string, string>;
  StreamableHTTPClientTransport: new (url: URL, options?: { requestInit?: RequestInit }) => SdkTransport;
  SSEClientTransport: new (url: URL, options?: { requestInit?: RequestInit; eventSourceInit?: Record<string, unknown> }) => SdkTransport;
};
type SdkTransport = { close(): Promise<void> };
type SdkClient = {
  connect(transport: SdkTransport, options?: { timeout?: number }): Promise<void>;
  listTools(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean }>;
  getServerVersion(): { name: string; version: string } | undefined;
  close(): Promise<void>;
};

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 200;
let sdk: Sdk | undefined;

function loadSdk(): Sdk {
  if (!sdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sdk = require(path.join(__dirname, '..', '..', 'vendor', 'mcp', 'mcp-client.cjs')) as Sdk;
    } catch (error) {
      throw new ToolError(`The MCP client is missing from this installation (${(error as Error).message}).`);
    }
  }
  return sdk;
}

/** Remote servers must use https (http only for this machine). */
export function validateServerUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return 'Enter the server URL, e.g. https://mcp.example.com/mcp.'; }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  return 'The URL must use https:// (http:// only for localhost).';
}

/** The host to show for a remote server; the full URL may contain its token. */
export function displayHost(secrets: McpSecrets): string {
  try { return secrets.url ? new URL(secrets.url).host : ''; } catch { return ''; }
}

export class McpConnection {
  private client: SdkClient | undefined;
  private transport: SdkTransport | undefined;
  public tools: McpToolInfo[] = [];
  public serverInfo: string | undefined;

  public constructor(private readonly config: McpServerConfig, private readonly secrets: McpSecrets, private readonly cwd?: string) {}

  public get connected(): boolean { return Boolean(this.client); }

  public async connect(): Promise<void> {
    if (this.client) return;
    const { Client, StdioClientTransport, getDefaultEnvironment, StreamableHTTPClientTransport, SSEClientTransport } = loadSdk();
    const attempt = async (transport: SdkTransport) => {
      const client = new Client({ name: 'near-ai-vscode', version: '0.4.0' }, { capabilities: {} });
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
      this.client = client;
      this.transport = transport;
    };
    if (this.config.transport === 'stdio') {
      if (!this.config.command) throw new ToolError(`${this.config.name} has no command to run.`);
      // Only a minimal environment plus the values configured for this server, never the editor's own.
      await attempt(new StdioClientTransport({ command: this.config.command, args: this.config.args ?? [], env: { ...getDefaultEnvironment(), ...(this.secrets.env ?? {}) }, stderr: 'pipe', ...(this.cwd ? { cwd: this.cwd } : {}) }));
    } else {
      const problem = this.secrets.url ? validateServerUrl(this.secrets.url) : 'No URL is set.';
      if (problem) throw new ToolError(`${this.config.name}: ${problem}`);
      const url = new URL(this.secrets.url!);
      const requestInit: RequestInit = { headers: this.secrets.headers ?? {} };
      try {
        await attempt(new StreamableHTTPClientTransport(url, { requestInit }));
      } catch (streamable) {
        // Older servers speak only the SSE transport.
        try { await attempt(new SSEClientTransport(url, { requestInit })); } catch { throw streamable; }
      }
    }
    const version = this.client!.getServerVersion();
    this.serverInfo = version ? `${version.name} ${version.version}` : undefined;
    await this.refreshTools();
  }

  public async refreshTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new ToolError(`${this.config.name} is not connected.`);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const tool of page.tools) tools.push({ name: tool.name, description: (tool.description ?? '').slice(0, 2_000), inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }, readOnly: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint === true });
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    this.tools = tools.slice(0, MAX_TOOLS);
    return this.tools;
  }

  /** Calls a tool and returns its result as text; a tool-reported error throws. */
  public async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) await this.connect();
    const result = await this.client!.callTool({ name, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
    const parts = (result.content ?? []).map((item) => {
      if (item.type === 'text') return String(item.text ?? '');
      if (item.type === 'image' || item.type === 'audio') return `[${item.type} ${String(item.mimeType ?? '')} not shown]`;
      if (item.type === 'resource') { const resource = item.resource as { text?: string; uri?: string } | undefined; return resource?.text ?? `[resource ${resource?.uri ?? ''}]`; }
      if (item.type === 'resource_link') return `[link ${String(item.uri ?? '')}${item.name ? ` (${String(item.name)})` : ''}]`;
      return JSON.stringify(item);
    });
    if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
    const text = parts.join('\n').trim() || '(no content)';
    if (result.isError) throw new ToolError(`${this.config.name} reported an error from ${name}: ${text.slice(0, 2_000)}`);
    return text;
  }

  public async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
    await this.transport?.close().catch(() => undefined);
    this.transport = undefined;
  }
}
