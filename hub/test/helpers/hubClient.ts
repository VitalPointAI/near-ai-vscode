import https from 'node:https';
import type http from 'node:http';
import tls from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { certPinOf } from '@ext/domain/replica/hubFile';
import { sessionKeying } from '../../src/http/server';

// A minimal hub client for the tests (32-20), shaped like the transport 32-23 builds: one keep-alive TLS 1.3 connection per session, opened first
// and checked against the hub's certificate pin before any request is written (the pin is the trust decision, so the certificate chain is not
// checked), then reused for every call of that session. If the connection closes, the next call fails instead of quietly opening another one,
// because a session token works only on the connection it was issued on.

export interface HubResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

export interface CallOptions {
  /** A JSON body. */
  json?: unknown;
  /** A raw body (octet-stream). */
  bytes?: Buffer;
  token?: string;
  headers?: Record<string, string>;
  /** Send only the headers with this content-length and no body, then wait for the answer. */
  declaredLength?: number;
}

/** An agent that hands out one already-connected socket and never makes another. */
class OneSocketAgent extends https.Agent {
  private used = false;

  constructor(private readonly socket: TLSSocket) {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }

  override createConnection(): TLSSocket {
    if (this.used) throw new Error('The session connection is closed; a new connection needs a new session.');
    this.used = true;
    return this.socket;
  }
}

export class HubConnection {
  private readonly agent: OneSocketAgent;
  private isClosed = false;
  private readonly closedPromise: Promise<void>;

  private constructor(
    readonly socket: TLSSocket,
    private readonly port: number,
  ) {
    this.agent = new OneSocketAgent(socket);
    this.closedPromise = new Promise((resolve) => socket.once('close', () => {
      this.isClosed = true;
      resolve();
    }));
  }

  /** Connects, finishes the TLS 1.3 handshake and checks the certificate pin before anything is sent. */
  static open(port: number, pin: string): Promise<HubConnection> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
      const onError = (error: Error): void => reject(error);
      socket.once('error', onError);
      socket.once('secureConnect', () => {
        socket.off('error', onError);
        const peer = socket.getPeerX509Certificate();
        if (peer === undefined || certPinOf(peer.raw) !== pin) {
          socket.destroy();
          reject(new Error('The hub presented a certificate whose pin is not the pin this client expects.'));
          return;
        }
        // Errors after the handshake surface on the next call.
        socket.on('error', () => undefined);
        resolve(new HubConnection(socket, port));
      });
    });
  }

  /** exportKeyingMaterial(32, 'near-ai-hub-session/v1') of this connection, as the hub computes it on its side. */
  keying(): Buffer {
    return sessionKeying(this.socket);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** True when the connection closes within ms. */
  async closesWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.closedPromise.then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  call(method: string, target: string, options: CallOptions = {}): Promise<HubResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      let body: Buffer | undefined;
      if (options.json !== undefined) {
        body = Buffer.from(JSON.stringify(options.json), 'utf8');
        headers['content-type'] = 'application/json';
      } else if (options.bytes !== undefined) {
        body = options.bytes;
        headers['content-type'] = 'application/octet-stream';
      }
      if (options.declaredLength !== undefined) headers['content-length'] = String(options.declaredLength);
      else if (body !== undefined) headers['content-length'] = String(body.length);
      if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
      let request: http.ClientRequest;
      try {
        request = https.request({ agent: this.agent, host: '127.0.0.1', port: this.port, servername: 'localhost', rejectUnauthorized: false, method, path: target, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const text = bytes.toString('utf8');
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: bytes, text, json: <T>() => JSON.parse(text) as T });
            if (options.declaredLength !== undefined) request.destroy();
          });
          response.on('error', reject);
        });
      } catch (error) {
        reject(error as Error);
        return;
      }
      request.on('error', reject);
      if (options.declaredLength !== undefined) {
        request.flushHeaders();
        return;
      }
      request.end(body);
    });
  }

  get(target: string, token?: string): Promise<HubResponse> {
    return this.call('GET', target, token === undefined ? {} : { token });
  }

  post(target: string, json: unknown, token?: string): Promise<HubResponse> {
    return this.call('POST', target, token === undefined ? { json } : { json, token });
  }

  put(target: string, bytes: Buffer, token?: string): Promise<HubResponse> {
    return this.call('PUT', target, token === undefined ? { bytes } : { bytes, token });
  }

  close(): void {
    this.agent.destroy();
    this.socket.destroy();
  }
}
