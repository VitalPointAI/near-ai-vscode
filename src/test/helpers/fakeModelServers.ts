// All data is fictional.
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SERVER_PROBE_TABLE } from '../../domain/setup/servers';
import type { ServerKind } from '../../domain/setup/servers';
import { CERTS_DIR, FIXTURE_CA, FIXTURE_CERT } from './fakeHubServer';

const MODEL = 'example-model';
const MODELS = { data: [{ id: MODEL }] };
const signatures: Record<ServerKind, Record<string, unknown>> = {
  ollama: { '/api/version': { version: '1.2.3' }, '/api/tags': { models: [{ name: MODEL, size: 12, digest: 'example-digest' }] } },
  'llama-cpp': { '/props': { default_generation_settings: {} } },
  lemonade: { '/v1/health': { status: 'ready', model_loaded: true } },
  'lm-studio': { '/api/v1/models': { models: [{ key: MODEL, size_bytes: 12, type: 'llm' }] } },
  vllm: { '/version': { version: '1.2.3' } },
  nim: { '/v1/health/ready': { ready: true }, '/v1/metadata': { modelInfo: [] } },
  localai: { '/readyz': 'ready' },
  jan: {},
  'openai-compatible': {},
};

export interface FakeRequestLog {
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly bodyBytes: number;
}

export interface FakeModelScript {
  readonly tls?: boolean;
  readonly port?: number;
  readonly answer?: (request: FakeRequestLog, signal: AbortSignal) => Response | Promise<Response> | undefined;
}

export const MODEL_TEST_CA = FIXTURE_CA;
export const MODEL_TEST_PIN = createHash('sha256')
  .update(new X509Certificate(FIXTURE_CERT).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

export function createFakeModelServer(kind: ServerKind, script: FakeModelScript = {}) {
  const row = SERVER_PROBE_TABLE.find((entry) => entry.kind === kind)!;
  const port = script.port ?? row.ports[0] ?? 443;
  const requests: FakeRequestLog[] = [];
  const messages: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    request.signal.throwIfAborted();
    const body = await request.text();
    const log = {
      method: request.method, path: new URL(request.url).pathname,
      headerNames: [...request.headers.keys()], bodyBytes: Buffer.byteLength(body),
    };
    requests.push(log);
    const answer = script.answer?.(log, request.signal);
    if (answer !== undefined) return answer;
    if (log.path === '/v1/chat/completions' && log.method === 'POST') {
      messages.push(JSON.parse(body).messages);
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    }
    if (log.path === '/v1/models') {
      return kind === 'jan' ? new Response(null, { status: 401 }) : Response.json(MODELS);
    }
    const fixture = signatures[kind][log.path];
    if (fixture === undefined) return new Response(null, { status: 404 });
    return typeof fixture === 'string' ? new Response(fixture) : Response.json(fixture);
  };
  return { row: { ...row, ports: [port] }, port, requests, messages, fetch };
}

export async function startFakeModelServer(kind: ServerKind, script: FakeModelScript = {}) {
  const fake = createFakeModelServer(kind, script);
  const scheme = script.tls ? 'https' : 'http';
  const serve: http.RequestListener = (req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const reply = await fake.fetch(`${scheme}://127.0.0.1${req.url}`, {
        method: req.method, headers: req.headers as RequestInit['headers'], signal: controller.signal,
        ...(body.length === 0 ? {} : { body }),
      });
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      res.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(() => res.destroy());
  };
  const server = script.tls
    ? https.createServer({ cert: FIXTURE_CERT, key: readFileSync(join(CERTS_DIR, 'patched', 'server.key')) }, serve)
    : http.createServer(serve);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    ...fake, port, row: { ...fake.row, ports: [port] },
    url: `${scheme}://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
