// The loopback emitters for the simulated feeds (research note 11, 4.7 and 8.2; WP-SIM): two CoT streams and one AIS stream over TCP, the RSS outlets
// and the mock partner MCP server over HTTP. Everything binds to 127.0.0.1 and nothing else: the simulator never opens an outbound connection, never
// multicasts and never transmits on a radio, so the demo runs offline and reveals nothing (ROADMAP ground rules; note 11, 8.2).
//
// Endpoints (ports are chosen by the system unless given):
//   tcp://127.0.0.1:<cotOwn>     CoT events, one XML event a line (friendly tracks)
//   tcp://127.0.0.1:<cotIntel>   CoT events, one XML event a line (spot reports, contacts, the imagery footprint)
//   tcp://127.0.0.1:<ais>        AIS !AIVDM sentences, one a line, CR LF
//   http://127.0.0.1:<http>/rss/<outlet>.xml   RSS 2.0, one document per outlet, the newest 100 items first
//   http://127.0.0.1:<http>/mcp                the mock partner server (MCP, Streamable HTTP, stateless JSON responses)
// A client that connects late gets the latest message of every track at once, then the live stream.
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';
import { PARTNER_ONLY_DISCIPLINES } from '../../domain/staff/doctrine';
import { partnerToolResult, rssDocument, SIM_BADGE, SIM_FORMAT_VERSION, SIM_LINK_BASE, SIM_MARKING, SIM_STATEMENT } from '../../domain/staff/sim/formats';
import type { PartnerReport, RssItemSpec } from '../../domain/staff/sim/formats';
import type { SimMessage, SimTimeline } from '../../domain/staff/sim/timeline';

/** The only address the simulator binds to. */
export const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Refuses any bind address but loopback. */
export function assertLoopback(host: string): void {
  if (host !== LOOPBACK_HOST) throw new Error(`The simulator binds only to ${LOOPBACK_HOST}, never to ${JSON.stringify(host)}.`);
}

export const SIM_MAX_CLIENTS = 16;
/** A client that falls this far behind is dropped rather than letting the stream buffer without limit. */
export const SIM_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const SIM_MAX_RSS_ITEMS = 100;
export const SIM_MAX_REQUEST_BYTES = 64 * 1024;
export const PARTNER_TOOL = 'partner_reports';
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface SimPorts { readonly cotOwn?: number; readonly cotIntel?: number; readonly ais?: number; readonly http?: number }

export interface SimEndpoints {
  readonly cotOwn: string;
  readonly cotIntel: string;
  readonly ais: string;
  readonly rss: Readonly<Record<string, string>>;
  readonly partnerMcp: string;
}

interface Stream { readonly server: TcpServer; readonly clients: Set<Socket>; readonly latest: Map<string, string>; readonly eol: string }

export class SimServers {
  private streams: { cotOwn: Stream; cotIntel: Stream; ais: Stream } | undefined;
  private http: HttpServer | undefined;
  private httpPort = 0;
  private readonly rssItems = new Map<string, RssItemSpec[]>();
  private readonly partnerReports: PartnerReport[] = [];
  private lastBuilt: number;

  constructor(private readonly timeline: SimTimeline) {
    this.lastBuilt = timeline.start;
    for (const outlet of timeline.outlets) this.rssItems.set(outlet.id, []);
  }

  /** Opens every server on loopback. */
  async start(ports: SimPorts = {}): Promise<SimEndpoints> {
    if (this.streams) throw new Error('The simulation servers are already running.');
    const cotOwn = await this.openStream(ports.cotOwn ?? 0, '\n');
    const cotIntel = await this.openStream(ports.cotIntel ?? 0, '\n');
    const ais = await this.openStream(ports.ais ?? 0, '\r\n');
    this.streams = { cotOwn, cotIntel, ais };
    this.http = createHttpServer((request, response) => { void this.handle(request, response); });
    this.http.maxConnections = SIM_MAX_CLIENTS * 4;
    this.httpPort = await listen(this.http, ports.http ?? 0);
    return this.endpoints();
  }

  endpoints(): SimEndpoints {
    if (!this.streams) throw new Error('The simulation servers are not running.');
    const port = (server: TcpServer): number => (server.address() as AddressInfo).port;
    const base = `http://${LOOPBACK_HOST}:${this.httpPort}`;
    return {
      cotOwn: `tcp://${LOOPBACK_HOST}:${port(this.streams.cotOwn.server)}`,
      cotIntel: `tcp://${LOOPBACK_HOST}:${port(this.streams.cotIntel.server)}`,
      ais: `tcp://${LOOPBACK_HOST}:${port(this.streams.ais.server)}`,
      rss: Object.fromEntries(this.timeline.outlets.map((outlet) => [outlet.id, `${base}/rss/${outlet.id}.xml`])),
      partnerMcp: `${base}/mcp`
    };
  }

  /** Every bound address, for the loopback check. */
  addresses(): AddressInfo[] {
    const servers: Array<TcpServer | HttpServer | undefined> = [this.streams?.cotOwn.server, this.streams?.cotIntel.server, this.streams?.ais.server, this.http];
    return servers.filter((server): server is TcpServer | HttpServer => server !== undefined).map((server) => server.address() as AddressInfo);
  }

  /** Puts one message on its stream. */
  publish(message: SimMessage): void {
    if (!this.streams) return;
    this.lastBuilt = Math.max(this.lastBuilt, message.at);
    switch (message.stream) {
      case 'cot-own': this.send(this.streams.cotOwn, message.subject, [message.xml]); break;
      case 'cot-intel': this.send(this.streams.cotIntel, message.subject, [message.xml]); break;
      case 'ais': this.send(this.streams.ais, message.subject, message.sentences); break;
      case 'rss': {
        const items = this.rssItems.get(message.channel);
        if (items) { items.unshift(message.item); items.length = Math.min(items.length, SIM_MAX_RSS_ITEMS); }
        break;
      }
      case 'partner': this.partnerReports.push(message.report); break;
      case 'marker': break;
    }
  }

  async stop(): Promise<void> {
    const streams = this.streams;
    this.streams = undefined;
    const closing: Array<Promise<void>> = [];
    for (const stream of streams ? [streams.cotOwn, streams.cotIntel, streams.ais] : []) {
      for (const client of stream.clients) client.destroy();
      closing.push(new Promise((resolve) => stream.server.close(() => resolve())));
    }
    if (this.http) {
      const http = this.http;
      this.http = undefined;
      http.closeAllConnections();
      closing.push(new Promise((resolve) => http.close(() => resolve())));
    }
    await Promise.all(closing);
  }

  // ---- TCP streams --------------------------------------------------------------------------------------------------------------------------

  private async openStream(port: number, eol: string): Promise<Stream> {
    const clients = new Set<Socket>();
    const latest = new Map<string, string>();
    const server = createTcpServer((socket) => {
      if (clients.size >= SIM_MAX_CLIENTS) { socket.destroy(); return; }
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
      socket.on('error', () => socket.destroy());
      // The stream is one-way: whatever a client sends is ignored.
      socket.on('data', () => undefined);
      for (const text of latest.values()) socket.write(text);
    });
    await listen(server, port);
    return { server, clients, latest, eol };
  }

  private send(stream: Stream, subject: string, lines: readonly string[]): void {
    const text = lines.map((line) => `${line}${stream.eol}`).join('');
    stream.latest.set(subject, text);
    for (const client of stream.clients) {
      if (client.writableLength > SIM_MAX_BUFFERED_BYTES) { client.destroy(); continue; }
      client.write(text);
    }
  }

  // ---- HTTP: RSS and the mock partner server ------------------------------------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // DNS rebinding and cross-site requests: only this machine's own names, and no browser page from anywhere else.
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    const origin = request.headers.origin;
    if (!LOOPBACK_NAMES.has(host) || (origin !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin))) {
      return reply(response, 403, 'text/plain', 'Loopback only.');
    }
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    const rss = /^\/rss\/([a-z0-9-]+)\.xml$/.exec(url.pathname);
    if (rss && request.method === 'GET') {
      const outlet = this.timeline.outlets.find((entry) => entry.id === rss[1]);
      if (!outlet) return reply(response, 404, 'text/plain', 'No such outlet.');
      const body = rssDocument({
        title: outlet.title, description: outlet.description, link: `${SIM_LINK_BASE}/${this.timeline.scenario}/${outlet.id}`, built: this.lastBuilt,
        items: this.rssItems.get(outlet.id) ?? []
      });
      return reply(response, 200, 'application/rss+xml; charset=utf-8', body);
    }
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return reply(response, 405, 'text/plain', 'This server sends no event stream; POST JSON-RPC requests.', { Allow: 'POST' });
      const body = await readBody(request);
      if (body === undefined) return reply(response, 413, 'text/plain', 'Request too large.');
      let message: unknown;
      try { message = JSON.parse(body); } catch { return replyJson(response, 400, rpcError(null, -32700, 'Parse error')); }
      const answer = this.rpc(message);
      if (answer === undefined) { response.writeHead(202).end(); return; }
      return replyJson(response, 200, answer);
    }
    return reply(response, 404, 'text/plain', 'Not found.');
  }

  /** One JSON-RPC message for the mock partner server. Notifications get no answer. */
  rpc(message: unknown): Record<string, unknown> | undefined {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Invalid request');
    const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
    if (id === undefined) return undefined;
    const rid = typeof id === 'string' || typeof id === 'number' ? id : null;
    if (typeof method !== 'string') return rpcError(rid, -32600, 'Invalid request');
    const args = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'initialize': {
        const asked = args.protocolVersion;
        const protocolVersion = typeof asked === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(rid, {
          protocolVersion, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `${this.timeline.scenario}-partner-sim`, title: `${this.timeline.partner.title} [${SIM_BADGE}]`, version: SIM_FORMAT_VERSION },
          instructions: `${SIM_MARKING}. ${SIM_STATEMENT} A mock partner server standing in for partner-only reporting (${PARTNER_ONLY_DISCIPLINES.join(', ')}). Every report is fictional and routed local-only.`
        });
      }
      case 'ping': return rpcResult(rid, {});
      case 'tools/list': return rpcResult(rid, { tools: [this.partnerTool()] });
      case 'tools/call': {
        if (args.name !== PARTNER_TOOL) return rpcError(rid, -32602, `Unknown tool ${String(args.name)}`);
        const input = (args.arguments ?? {}) as Record<string, unknown>;
        const since = input.since;
        const discipline = input.discipline;
        if (since !== undefined && (typeof since !== 'string' || Number.isNaN(Date.parse(since)))) return rpcResult(rid, toolError('since must be an ISO 8601 time.'));
        if (discipline !== undefined && !(PARTNER_ONLY_DISCIPLINES as readonly unknown[]).includes(discipline)) return rpcResult(rid, toolError(`discipline must be one of ${PARTNER_ONLY_DISCIPLINES.join(', ')}.`));
        const reports = this.partnerReports.filter((report) => (since === undefined || Date.parse(report.reportedAt) > Date.parse(since as string)) && (discipline === undefined || report.discipline === discipline));
        return rpcResult(rid, partnerToolResult(reports, `${reports.length} report(s) released so far by the simulation.`));
      }
      default: return rpcError(rid, -32601, `Method not found: ${method}`);
    }
  }

  private partnerTool(): Record<string, unknown> {
    return {
      name: PARTNER_TOOL,
      title: `Partner reports [${SIM_BADGE}]`,
      description: `${SIM_MARKING}. Lists the fictional partner reports (${PARTNER_ONLY_DISCIPLINES.join(', ')}) the exercise simulation has released so far, oldest first. Every report is simulated, labelled and routed local-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'Only reports after this ISO 8601 time.' },
          discipline: { type: 'string', enum: [...PARTNER_ONLY_DISCIPLINES], description: 'Only reports of this discipline.' }
        },
        additionalProperties: false
      },
      annotations: { title: `Partner reports [${SIM_BADGE}]`, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    };
  }
}

function listen(server: TcpServer | HttpServer, port: number): Promise<number> {
  assertLoopback(LOOPBACK_HOST);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > SIM_MAX_REQUEST_BYTES) { if (!done) { done = true; resolve(undefined); } request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    request.on('error', () => { if (!done) { done = true; resolve(undefined); } });
  });
}

function reply(response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Exercise-Marking': SIM_MARKING, ...headers }).end(body);
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
  reply(response, status, 'application/json', JSON.stringify(body));
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: `${SIM_MARKING}. ${text}` }], isError: true };
}
