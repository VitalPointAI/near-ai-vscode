// The client side of your organization's sync hub on the wire (D-29, D-35, D-36, D-37, D-41, D-49, D-51, D-69; DESIGN 9 and 10.4). Node I/O only, no
// editor API and no Yjs, so the hub's own tests can bundle it (D-27). It implements ReplicaTransport (kind hub, live, enforcesAppend) and speaks
// exactly the shapes of hub/src/http/routes.ts.
//
// Trust. The hub is trusted by one of two closed choices, never by the system's certificate authorities:
// - { pin }: the SPKI hash of the hub's certificate key, from the hub file or the roster (hub.admit certPin). The certificate chain is not checked;
//   the pin is checked on the peer certificate after the handshake and before any request byte is written, and a mismatch closes the connection.
// - { ca }: your organization's certificate authority (PEM). Only that CA is given to TLS, and the certificate must name the host connected to.
// TLS is 1.3 only.
//
// Sessions (D-35). A session belongs to one TLS connection: POST /v1/session {project} gives a challenge, and the answer signs the hub's writer id,
// the project, the challenge and exportKeyingMaterial(32, 'near-ai-hub-session/v1') of that connection. The token is kept on the connection object it
// was issued on and is only ever sent there. The hub closes a connection idle for 5 seconds, so when a connection is gone the next call opens a new
// one and a new session first. A token the hub no longer knows on a live connection (expired, unknown) gets a new session on that connection.
//
// The states of one call:
//   no connection --open (10 s limit)--> connected (pin or CA checked) --session--> ready --call--> answered
//   connected --pin or CA mismatch--> closed, nothing sent (attention)      connect failed or timed out --> unreachable (offline)
//   ready --connection closed by the hub--> no connection (the next call opens a new one; a call in flight on a reused connection is tried once more)
//   ready --401 token-expired, unknown-token or other-connection--> new session on the same connection, the call tried once more
//   ready --403 session-refused or 401 revoked or quarantined--> refused
//
// Answers are hostile input: every body is read with a byte cap before it is parsed (a declared length past the cap is refused before any byte is
// read), and every answer must name the project and, where it answers about one, the stream and writer asked for, or it is refused wrong-project and
// nothing from it is returned.
//
// The event reader (D-37) keeps its own connection and session, because a stream occupies the connection it runs on. Frame ids are a per-connection
// counter used only to report a gap; Last-Event-ID is never sent. 204 means stop, and resync or the end of the stream means run heads catch-up.
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import * as tls from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { readGrant } from '../../domain/replica/cellKeys';
import type { SignedCheckpoint } from '../../domain/replica/checkpoint';
import { BLOB_MAX_BYTES, HASH_PATTERN, STREAM_ID_PATTERN } from '../../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, buildSessionAnswer, certPinOf } from '../../domain/replica/hubFile';
import type { HeadSet, PullRequest, PushResult, ReplicaTransport, Unsubscribe } from '../../domain/replica/transport';
import type { PayloadSigner } from '../../domain/team/signedPayload';

const MIB = 1024 * 1024;
/** How long a connection may take to reach the hub, finish TLS and be checked (DESIGN 15.3: offline after 10 seconds). */
export const CONNECT_TIMEOUT_MS = 10_000;
/** The largest JSON answer read: a 4 MiB catch-up page plus its envelope (project, stream, writer, head and the latest checkpoint). */
export const RESPONSE_MAX_BYTES = 4 * MIB + 256 * 1024;
/** The largest blob or grant answer read. */
export const BLOB_RESPONSE_MAX_BYTES = BLOB_MAX_BYTES;
/** The largest server-sent event frame read; past it the stream is closed. */
export const EVENT_FRAME_MAX_BYTES = MIB + 64 * 1024;
/** Per append: the hub takes at most 200 entries and 64 grants, and 4 MiB of body. */
export const APPEND_MAX_ENTRIES = 200;
export const APPEND_MAX_GRANTS = 64;
export const APPEND_MAX_BYTES = 3 * MIB;
/** The hub takes at most this many checkpoints in one ask. */
export const CHECKPOINTS_PER_ASK = 16;
const PIN_PATTERN = /^[0-9a-f]{64}$/;

/** Every way a call to the hub can fail, each with one plain sentence. */
export const HUB_TRANSPORT_FAILURES = {
  unreachable: 'The hub could not be reached within 10 seconds, or the connection to it was lost. This computer keeps working and tries again later.',
  'pin-mismatch': 'The hub presented a certificate whose pin is not the one your organization published for it, so nothing was sent.',
  'ca-refused': 'The hub presented a certificate that your organization\'s certificate authority did not issue for its address, so nothing was sent.',
  'wrong-hub': 'The hub answered as another hub than the one this project admitted, so nothing was sent to it.',
  'session-refused': 'The hub did not accept this device for this project.',
  'rate-limited': 'The hub asked this computer to wait before calling again.',
  'too-large': 'The hub sent an answer larger than this computer reads, so it was not read.',
  'wrong-project': 'The hub answered with data from another project or another part of it, and it was refused.',
  malformed: 'The hub sent an answer this computer cannot read.',
  'hub-error': 'The hub refused the call.'
} as const;
export type HubTransportFailure = keyof typeof HUB_TRANSPORT_FAILURES;

/** What an answer named, kept on a wrong-project failure so the witness can name it. */
export interface ResponseLabelSeen { project: string; stream?: string }

export class HubTransportError extends Error {
  public constructor(
    public readonly failure: HubTransportFailure,
    public readonly detail: { reason?: string; status?: number; retryAfterSeconds?: number; label?: ResponseLabelSeen } = {}
  ) {
    super(HUB_TRANSPORT_FAILURES[failure]);
    this.name = 'HubTransportError';
  }

  public get reason(): string | undefined { return this.detail.reason; }
  public get status(): number | undefined { return this.detail.status; }
  public get retryAfterSeconds(): number | undefined { return this.detail.retryAfterSeconds; }
}

/** The closed trust choice: the hub's SPKI pin, or your organization's CA. Never the system's certificate authorities. */
export type HubTrust = { pin: string } | { ca: string };

export interface HubTransportOptions {
  /** host:port, or [IPv6]:port. */
  address: string;
  project: string;
  /** The hub's writer id: the hub a session answer names. */
  hub: string;
  trust: HubTrust;
  /** This device's signer: the session answer is signed with it. */
  signer: PayloadSigner;
  /** The name sent in TLS and checked against the certificate in CA mode; the address's host when absent. */
  servername?: string;
  now?: () => Date;
  connectTimeoutMs?: number;
  responseMaxBytes?: number;
}

export interface HubHeads extends HeadSet {
  project: string;
  rosterHead: string;
  /** Hashes of the cell grants this device may fetch through GET /v1/blobs/:hash. */
  grants: string[];
  /** The hub's latest checkpoint as sent: unchecked here, the witness checks it. */
  checkpoint?: SignedCheckpoint;
}

export interface EntriesPage {
  project: string;
  stream: string;
  writer: string;
  /** As sent: unchecked here, the sync verifies every one. */
  entries: unknown[];
  more: boolean;
  head: { seq: number; hash: string } | null;
  checkpoint?: unknown;
}

export interface AppendBatch {
  entries: readonly SealedEntry[];
  grants?: readonly unknown[];
  blobRefs?: ReadonlyArray<{ entry: string; blob: string }>;
}

/** The blob a 409 blob-missing answer asks for, from wherever this computer keeps it. */
export type BlobLookup = (hash: string) => SealedBlob | undefined | Promise<SealedBlob | undefined>;

export interface AppendAnswer {
  project: string;
  accepted: string[];
  refused: Array<{ index: number; hash?: string; reason: string }>;
  grantsRefused: Array<{ index: number; reason: string }>;
  rosterHead: string;
  checkpoint?: unknown;
  /** True when the hub said a blob was missing and the batch was sent again after the blobs were put. */
  blobsPut: boolean;
}

export type BlobFetch = { kind: 'blob'; hash: string; bytes: Buffer } | { kind: 'missing'; hash: string } | { kind: 'corrupt'; hash: string; bytes: Buffer };
export type GrantFetch = { kind: 'grant'; hash: string; signed: unknown } | { kind: 'missing'; hash: string } | { kind: 'refused'; hash: string; reason: string };

export interface CheckpointAnswer { project: string; kept: number; checkpoint?: unknown }
export interface EnrolAnswer { project: string; rosterHead: string; hub: string }

/** What the event reader reports, in order. */
export type EventReport =
  | { kind: 'frame'; event: HubEventName; id: number; data: Record<string, unknown> }
  | { kind: 'gap'; expected: number; got: number }
  | { kind: 'stopped' }
  | { kind: 'resync' }
  | { kind: 'closed' }
  | { kind: 'wrong-project'; event: string }
  | { kind: 'malformed' };
export const HUB_EVENT_NAMES = ['heads', 'presence', 'checkpoint', 'roster', 'equivocation', 'join-request', 'resync'] as const;
export type HubEventName = typeof HUB_EVENT_NAMES[number];

export interface EventReader extends AsyncIterable<EventReport> {
  /** The retry delay the hub asked for, in milliseconds, once read. */
  readonly retryMs: number | undefined;
  close(): void;
}

interface RawAnswer { status: number; headers: IncomingHttpHeaders; body: Buffer }
interface CallBody { json?: unknown; bytes?: Buffer }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
const isStream = (value: unknown): value is string => typeof value === 'string' && STREAM_ID_PATTERN.test(value);
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** host and port of an address; refused when it is not host:port. */
export function parseHubAddress(address: string): { host: string; port: number } {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(address);
  const port = match === null ? 0 : Number(match[2]);
  if (match === null || port < 1 || port > 65535) throw new Error('The hub address is not host:port.');
  const host = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1];
  return { host, port };
}

function checkTrust(trust: unknown): HubTrust {
  if (!isRecord(trust)) throw new Error('The hub must be trusted by its certificate pin or by your organization\'s certificate authority.');
  const keys = Object.keys(trust);
  if (keys.length === 1 && keys[0] === 'pin' && typeof trust.pin === 'string' && PIN_PATTERN.test(trust.pin)) return { pin: trust.pin };
  if (keys.length === 1 && keys[0] === 'ca' && typeof trust.ca === 'string' && trust.ca.includes('-----BEGIN CERTIFICATE-----')) return { ca: trust.ca };
  throw new Error('The hub must be trusted by exactly one of its certificate pin (64 hex characters) or your organization\'s certificate authority (PEM).');
}

function retryAfterOf(headers: IncomingHttpHeaders): number | undefined {
  const value = headers['retry-after'];
  return typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : undefined;
}

function parseJson(answer: RawAnswer): unknown {
  try {
    return JSON.parse(answer.body.toString('utf8')) as unknown;
  } catch {
    throw new HubTransportError('malformed', { status: answer.status });
  }
}

/** An agent that hands out the one already-checked socket and never makes another, so a request can only go where the pin was checked. */
class OneSocketAgent extends https.Agent {
  private handed = false;

  public constructor(private readonly socket: TLSSocket) {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }

  public override createConnection(): TLSSocket {
    if (this.handed) throw new Error('The hub connection is closed; a new connection needs a new session.');
    this.handed = true;
    return this.socket;
  }
}

/** One TLS 1.3 connection to the hub, checked before anything is written, and the session token issued on it (if any). */
class HubConnection {
  public token: string | undefined;
  private isClosed = false;
  private readonly agent: OneSocketAgent;

  private constructor(public readonly socket: TLSSocket, private readonly host: string, private readonly port: number) {
    this.agent = new OneSocketAgent(socket);
    socket.once('close', () => { this.isClosed = true; });
  }

  public get closed(): boolean {
    return this.isClosed || this.socket.destroyed;
  }

  public static open(host: string, port: number, servername: string, trust: HubTrust, timeoutMs: number): Promise<HubConnection> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const options: tls.ConnectionOptions = { host, port, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: false };
      if (isIP(servername) === 0) options.servername = servername;
      // CA mode: only that CA. Pin mode: no CA at all, the pin decides. The system's list is never given.
      options.ca = 'ca' in trust ? [trust.ca] : [];
      const socket = tls.connect(options);
      const fail = (error: HubTransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new HubTransportError('unreachable')), timeoutMs);
      socket.once('error', () => fail(new HubTransportError('unreachable')));
      socket.once('close', () => fail(new HubTransportError('unreachable')));
      socket.once('secureConnect', () => {
        if (settled) return;
        const problem = HubConnection.trustProblem(socket, servername, trust);
        if (problem !== undefined) {
          fail(new HubTransportError(problem));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        // Errors after the handshake surface on the call in flight; the socket's close marks the connection gone.
        socket.on('error', () => undefined);
        resolve(new HubConnection(socket, host, port));
      });
    });
  }

  /** The trust check on the peer certificate, after the handshake and before any byte is written. */
  private static trustProblem(socket: TLSSocket, servername: string, trust: HubTrust): HubTransportFailure | undefined {
    const peer = socket.getPeerX509Certificate();
    if (peer === undefined) return 'pin' in trust ? 'pin-mismatch' : 'ca-refused';
    if ('pin' in trust) {
      let pin: string;
      try {
        pin = certPinOf(peer.raw);
      } catch {
        return 'pin-mismatch';
      }
      return pin === trust.pin ? undefined : 'pin-mismatch';
    }
    if (!socket.authorized) return 'ca-refused';
    return tls.checkServerIdentity(servername, socket.getPeerCertificate()) === undefined ? undefined : 'ca-refused';
  }

  public keying(): Buffer {
    // No context, exactly as the hub computes it (hub/src/http/server.ts); newer Node types make the third argument required.
    return this.socket.exportKeyingMaterial(SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, undefined as unknown as Buffer);
  }

  /** Sends one request on this connection and reads the answer with a byte cap. */
  public request(method: string, target: string, body: CallBody, cap: number, token?: string): Promise<RawAnswer> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      let payload: Buffer | undefined;
      if (body.json !== undefined) {
        payload = Buffer.from(JSON.stringify(body.json), 'utf8');
        headers['content-type'] = 'application/json';
      } else if (body.bytes !== undefined) {
        payload = body.bytes;
        headers['content-type'] = 'application/octet-stream';
      }
      if (payload !== undefined) headers['content-length'] = String(payload.length);
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      let request: ReturnType<typeof https.request>;
      let done = false;
      let responded = false;
      const finish = (error: Error | undefined, answer?: RawAnswer): void => {
        if (done) return;
        done = true;
        if (error !== undefined) reject(error); else resolve(answer as RawAnswer);
      };
      try {
        request = https.request({ agent: this.agent, host: this.host, port: this.port, method, path: target, headers }, (response) => {
          responded = true;
          const declared = response.headers['content-length'];
          if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > cap)) {
            request.destroy();
            finish(new HubTransportError('too-large', { status: response.statusCode }));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > cap) {
              chunks.length = 0;
              request.destroy();
              finish(new HubTransportError('too-large', { status: response.statusCode }));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => finish(undefined, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on('error', () => finish(new HubTransportError('unreachable')));
          response.on('aborted', () => finish(new HubTransportError('unreachable')));
          response.on('close', () => { if (!response.complete) finish(new HubTransportError('unreachable')); });
        });
      } catch {
        finish(new HubTransportError('unreachable'));
        return;
      }
      request.on('error', () => finish(new HubTransportError('unreachable')));
      request.on('close', () => { if (!responded) finish(new HubTransportError('unreachable')); });
      request.end(payload);
    });
  }

  /** Sends a GET whose answer is a stream, for the event reader. */
  public stream(target: string, token: string): Promise<{ response: IncomingMessage; abort: () => void }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof https.request>;
      try {
        request = https.request({ agent: this.agent, host: this.host, port: this.port, method: 'GET', path: target, headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` } }, (response) => {
          settled = true;
          resolve({ response, abort: () => request.destroy() });
        });
      } catch {
        reject(new HubTransportError('unreachable'));
        return;
      }
      request.on('error', () => { if (!settled) { settled = true; reject(new HubTransportError('unreachable')); } });
      request.end();
    });
  }

  public close(): void {
    this.isClosed = true;
    this.agent.destroy();
    this.socket.destroy();
  }
}

/** Token refusals a new session on the same connection can mend. */
const MENDABLE = new Set(['token-expired', 'unknown-token', 'other-connection', 'no-token']);

export class HubTransport implements ReplicaTransport {
  public readonly kind = 'hub' as const;
  public readonly live = true;
  public readonly enforcesAppend = true;
  public readonly project: string;
  public readonly hub: string;
  private readonly host: string;
  private readonly port: number;
  private readonly servername: string;
  private readonly trust: HubTrust;
  private readonly signer: PayloadSigner;
  private readonly now: () => Date;
  private readonly connectTimeoutMs: number;
  private readonly cap: number;
  private main: HubConnection | undefined;
  private opening: Promise<HubConnection> | undefined;
  private readonly readers = new Set<{ close(): void }>();
  private connectionsOpened = 0;

  public constructor(options: HubTransportOptions) {
    const { host, port } = parseHubAddress(options.address);
    if (!isStream(options.project)) throw new Error('A project id is 32 lowercase hex characters.');
    if (!isHash(options.hub)) throw new Error('The hub is named by its writer id, 64 lowercase hex characters.');
    this.trust = checkTrust(options.trust);
    this.host = host;
    this.port = port;
    this.servername = options.servername ?? host;
    this.project = options.project;
    this.hub = options.hub;
    this.signer = options.signer;
    this.now = options.now ?? ((): Date => new Date());
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.cap = options.responseMaxBytes ?? RESPONSE_MAX_BYTES;
  }

  /** How many TLS connections this transport opened, the event reader's included. */
  public get connections(): number {
    return this.connectionsOpened;
  }

  // ---- ReplicaTransport ----------------------------------------------------------------------------------------------------------------------------

  public async heads(streams: readonly string[]): Promise<HeadSet> {
    const all = await this.hubHeads();
    const wanted = streams.length === 0 ? all.streams : all.streams.filter((item) => streams.includes(item.stream));
    return all.checkpoint === undefined ? { streams: wanted } : { streams: wanted, checkpoint: all.checkpoint };
  }

  public async *pull(want: readonly PullRequest[]): AsyncIterable<SealedEntry | SealedBlob> {
    for (const request of want) {
      let from = request.fromSeq;
      for (;;) {
        const page = await this.entries(request.stream, request.writer, from);
        for (const entry of page.entries) yield entry as SealedEntry;
        const last = page.head;
        if (!page.more || last === null || last.seq < from) break;
        from = last.seq + 1;
      }
    }
  }

  public async push(entries: readonly SealedEntry[], blobs: readonly SealedBlob[]): Promise<PushResult> {
    const byHash = new Map(blobs.map((blob) => [blob.hash, blob]));
    const accepted: string[] = [];
    const refused: PushResult['refused'] = [];
    for (const batch of appendBatches(entries, [], [])) {
      const answer = await this.append(batch, (hash) => byHash.get(hash));
      accepted.push(...answer.accepted);
      for (const item of answer.refused) refused.push({ hash: item.hash ?? '', reason: item.reason });
    }
    return { accepted, refused };
  }

  public subscribe(onHeads: (heads: HeadSet) => void, onPresence: (sealed: Uint8Array) => void): Unsubscribe {
    let reader: EventReader | undefined;
    let stopped = false;
    void (async () => {
      try {
        reader = await this.events();
        if (stopped) { reader.close(); return; }
        for await (const report of reader) {
          if (report.kind !== 'frame') continue;
          if (report.event === 'heads' && isStream(report.data.stream) && Array.isArray(report.data.heads)) {
            onHeads({ streams: [{ stream: report.data.stream, heads: report.data.heads.filter((head): head is { writer: string; seq: number; hash: string } => isRecord(head) && isHash(head.writer) && isSeq(head.seq) && isHash(head.hash)).map((head) => ({ writer: head.writer, seq: head.seq, hash: head.hash })) }] });
          } else if (report.event === 'presence' && Array.isArray(report.data.devices)) {
            for (const device of report.data.devices) {
              if (isRecord(device) && typeof device.sealed === 'string' && /^[A-Za-z0-9_-]+$/.test(device.sealed)) onPresence(Buffer.from(device.sealed, 'base64url'));
            }
          }
        }
      } catch {
        // A stream that cannot open ends the subscription; the caller's next catch-up finds what it missed.
      }
    })();
    return () => {
      stopped = true;
      reader?.close();
    };
  }

  // ---- hub calls -----------------------------------------------------------------------------------------------------------------------------------

  /** GET heads: the streams and grant hashes this device may read, the roster head and the latest checkpoint. */
  public async hubHeads(): Promise<HubHeads> {
    const value = this.answerJson(await this.call('GET', `/v1/projects/${this.project}/heads`, {}), 200);
    if (!isRecord(value)) throw new HubTransportError('malformed');
    this.checkLabel(value);
    const streams: HeadSet['streams'] = [];
    if (!Array.isArray(value.streams) || !Array.isArray(value.grants) || !isHash(value.rosterHead)) throw new HubTransportError('malformed');
    for (const item of value.streams) {
      if (!isRecord(item) || !isStream(item.stream) || !Array.isArray(item.heads)) throw new HubTransportError('malformed');
      const heads = item.heads.map((head) => {
        if (!isRecord(head) || !isHash(head.writer) || !isSeq(head.seq) || !isHash(head.hash)) throw new HubTransportError('malformed');
        return { writer: head.writer, seq: head.seq, hash: head.hash };
      });
      streams.push({ stream: item.stream, heads });
    }
    if (!value.grants.every(isHash)) throw new HubTransportError('malformed');
    const result: HubHeads = { project: this.project, rosterHead: value.rosterHead, streams, grants: [...value.grants] as string[] };
    if (value.checkpoint !== undefined) result.checkpoint = value.checkpoint as SignedCheckpoint;
    return result;
  }

  /** GET entries: one catch-up page of one writer in one stream from a seq on. The page must name exactly what was asked. */
  public async entries(stream: string, writer: string, from: number): Promise<EntriesPage> {
    if (!isStream(stream) || !isHash(writer) || !isSeq(from)) throw new Error('A catch-up asks for a stream id, a writer id and a seq.');
    const value = this.answerJson(await this.call('GET', `/v1/projects/${this.project}/entries?stream=${stream}&writer=${writer}&from=${from}`, {}), 200);
    if (!isRecord(value)) throw new HubTransportError('malformed');
    this.checkLabel(value, stream);
    if (value.writer !== writer) throw new HubTransportError('wrong-project', { label: { project: this.project, stream } });
    if (!Array.isArray(value.entries) || typeof value.more !== 'boolean') throw new HubTransportError('malformed');
    const head = value.head;
    if (head !== null && !(isRecord(head) && isSeq(head.seq) && isHash(head.hash))) throw new HubTransportError('malformed');
    const page: EntriesPage = { project: this.project, stream, writer, entries: [...value.entries], more: value.more, head: head === null ? null : { seq: head.seq as number, hash: head.hash as string } };
    if (value.checkpoint !== undefined) page.checkpoint = value.checkpoint;
    return page;
  }

  /**
   * POST append with {entries, grants?, blobRefs?}. A 409 blob-missing answer means the hub lacks a blob the batch names: every blob of the batch that
   * this computer holds (blobs) is put, and the batch is sent once more.
   */
  public async append(batch: AppendBatch, blobOf: BlobLookup = () => undefined): Promise<AppendAnswer> {
    const body: Record<string, unknown> = { entries: batch.entries };
    if (batch.grants !== undefined && batch.grants.length > 0) body.grants = batch.grants;
    if (batch.blobRefs !== undefined && batch.blobRefs.length > 0) body.blobRefs = batch.blobRefs;
    const target = `/v1/projects/${this.project}/append`;
    let answer = await this.call('POST', target, { json: body });
    let blobsPut = false;
    if (answer.status === 409 && this.errorId(answer) === 'blob-missing') {
      for (const ref of batch.blobRefs ?? []) {
        const blob = await blobOf(ref.blob);
        if (blob !== undefined) await this.putBlob(blob.hash, Buffer.from(blob.bytes, 'base64url'));
      }
      blobsPut = true;
      answer = await this.call('POST', target, { json: body });
    }
    const value = this.answerJson(answer, 200);
    if (!isRecord(value)) throw new HubTransportError('malformed');
    this.checkLabel(value);
    if (!Array.isArray(value.accepted) || !value.accepted.every(isHash) || !Array.isArray(value.refused) || !isHash(value.rosterHead)) throw new HubTransportError('malformed');
    const refused = value.refused.map((item) => {
      if (!isRecord(item) || typeof item.reason !== 'string' || typeof item.index !== 'number') throw new HubTransportError('malformed');
      return isHash(item.hash) ? { index: item.index, hash: item.hash, reason: item.reason } : { index: item.index, reason: item.reason };
    });
    const grantsRefused = Array.isArray(value.grantsRefused)
      ? value.grantsRefused.filter(isRecord).map((item) => ({ index: typeof item.index === 'number' ? item.index : -1, reason: typeof item.reason === 'string' ? item.reason : 'refused' }))
      : [];
    const result: AppendAnswer = { project: this.project, accepted: [...value.accepted] as string[], refused, grantsRefused, rosterHead: value.rosterHead, blobsPut };
    if (value.checkpoint !== undefined) result.checkpoint = value.checkpoint;
    return result;
  }

  /** PUT a blob: 201 stored or 200 already held. */
  public async putBlob(hash: string, bytes: Buffer): Promise<void> {
    if (!isHash(hash)) throw new Error('A blob is named by its sha256.');
    const value = this.answerJson(await this.call('PUT', `/v1/blobs/${hash}`, { bytes }), 200, 201);
    if (!isRecord(value)) throw new HubTransportError('malformed');
    this.checkLabel(value);
  }

  /** GET a blob by hash; the bytes must hash to the name (else corrupt) and the answer must name this project. */
  public async getBlob(hash: string): Promise<BlobFetch> {
    if (!isHash(hash)) throw new Error('A blob is named by its sha256.');
    const answer = await this.call('GET', `/v1/blobs/${hash}`, {}, BLOB_RESPONSE_MAX_BYTES);
    if (answer.status === 404) return { kind: 'missing', hash };
    if (answer.status !== 200) this.answerJson(answer, 200);
    const named = answer.headers['x-near-ai-project'];
    if (named !== this.project) throw new HubTransportError('wrong-project', { label: { project: typeof named === 'string' ? named : '' } });
    return sha256Hex(answer.body) === hash ? { kind: 'blob', hash, bytes: answer.body } : { kind: 'corrupt', hash, bytes: answer.body };
  }

  /** A cell grant by its hash, through the blob route; its bytes must hash to the name and it must read as a signed grant. */
  public async grant(hash: string): Promise<GrantFetch> {
    const fetched = await this.getBlob(hash);
    if (fetched.kind === 'missing') return fetched;
    if (fetched.kind === 'corrupt') return { kind: 'refused', hash, reason: 'corrupt-blob' };
    let value: unknown;
    try {
      value = JSON.parse(fetched.bytes.toString('utf8')) as unknown;
    } catch {
      return { kind: 'refused', hash, reason: 'malformed' };
    }
    const read = readGrant(value);
    if (!read.ok) return { kind: 'refused', hash, reason: read.reason };
    return { kind: 'grant', hash, signed: value };
  }

  /** POST checkpoint {known}: asks for the hub's latest checkpoint, handing back hub checkpoints this computer holds (D-46, D-54, D-70). */
  public async askCheckpoint(known: readonly SignedCheckpoint[] = []): Promise<CheckpointAnswer> {
    if (known.length > CHECKPOINTS_PER_ASK) throw new Error(`At most ${CHECKPOINTS_PER_ASK} checkpoints are handed back at once.`);
    const value = this.answerJson(await this.call('POST', `/v1/projects/${this.project}/checkpoint`, { json: { known } }), 200);
    if (!isRecord(value)) throw new HubTransportError('malformed');
    this.checkLabel(value);
    if (!isSeq(value.kept)) throw new HubTransportError('malformed');
    const result: CheckpointAnswer = { project: this.project, kept: value.kept };
    if (value.checkpoint !== undefined) result.checkpoint = value.checkpoint;
    return result;
  }

  /** POST enrol: needs no session. Runs on a connection of its own, closed afterwards. Returns the project, the roster head and the hub id. */
  public async enrol(request: unknown): Promise<EnrolAnswer> {
    const connection = await this.openConnection();
    try {
      const answer = await connection.request('POST', '/v1/enrol', { json: request }, this.cap);
      const value = this.answerJson(answer, 201);
      if (!isRecord(value) || typeof value.rosterHead !== 'string' || typeof value.hub !== 'string') throw new HubTransportError('malformed');
      this.checkLabel(value);
      return { project: this.project, rosterHead: value.rosterHead, hub: value.hub };
    } finally {
      connection.close();
    }
  }

  /** The event stream on a connection and session of its own. */
  public async events(): Promise<EventReader> {
    const connection = await this.openConnection();
    try {
      await this.openSession(connection);
      const { response, abort } = await connection.stream(`/v1/projects/${this.project}/events`, connection.token as string);
      const reader = new HubEventReader(this.project, connection, response, abort, () => this.readers.delete(reader));
      this.readers.add(reader);
      return reader;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /** Closes the main connection and every event reader. */
  public close(): void {
    this.main?.close();
    this.main = undefined;
    for (const reader of [...this.readers]) reader.close();
  }

  // ---- inside --------------------------------------------------------------------------------------------------------------------------------------

  private async openConnection(): Promise<HubConnection> {
    this.connectionsOpened += 1;
    return HubConnection.open(this.host, this.port, this.servername, this.trust, this.connectTimeoutMs);
  }

  /** The main connection with a session, opening both when there is none or the hub closed it. */
  private async ready(): Promise<{ connection: HubConnection; fresh: boolean }> {
    if (this.main !== undefined && !this.main.closed && this.main.token !== undefined) return { connection: this.main, fresh: false };
    if (this.opening === undefined) {
      this.main?.close();
      this.main = undefined;
      this.opening = (async () => {
        const connection = await this.openConnection();
        try {
          await this.openSession(connection);
        } catch (error) {
          connection.close();
          throw error;
        }
        this.main = connection;
        return connection;
      })().finally(() => { this.opening = undefined; });
    }
    return { connection: await this.opening, fresh: true };
  }

  /** Opens a session on this connection: challenge, then the answer bound to this connection's keying material. The token stays on the connection. */
  private async openSession(connection: HubConnection): Promise<void> {
    connection.token = undefined;
    const challenge = this.answerJson(await connection.request('POST', '/v1/session', { json: { project: this.project } }, this.cap), 200);
    if (!isRecord(challenge) || typeof challenge.challenge !== 'string' || typeof challenge.hub !== 'string') throw new HubTransportError('malformed');
    this.checkLabel(challenge);
    if (challenge.hub !== this.hub) throw new HubTransportError('wrong-hub');
    let answer: unknown;
    try {
      answer = buildSessionAnswer(this.signer, { hub: this.hub, project: this.project, challenge: challenge.challenge, keying: connection.keying(), now: this.now() });
    } catch {
      throw new HubTransportError('malformed');
    }
    const opened = this.answerJson(await connection.request('POST', '/v1/session', { json: { answer } }, this.cap), 200);
    if (!isRecord(opened) || typeof opened.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(opened.token)) throw new HubTransportError('malformed');
    this.checkLabel(opened);
    connection.token = opened.token;
  }

  /**
   * One authenticated call. A call on a reused connection that the hub closed under it is tried once more on a new connection; a token refusal a new
   * session can mend gets a new session on the same connection and one more try.
   */
  private async call(method: string, target: string, body: CallBody, cap: number = this.cap): Promise<RawAnswer> {
    for (let attempt = 0; ; attempt += 1) {
      const { connection, fresh } = await this.ready();
      let answer: RawAnswer;
      try {
        answer = await connection.request(method, target, body, cap, connection.token);
      } catch (error) {
        if (error instanceof HubTransportError && error.failure === 'unreachable') {
          connection.close();
          if (this.main === connection) this.main = undefined;
          if (!fresh && attempt === 0) continue;
        }
        throw error;
      }
      if (answer.status === 401 && attempt === 0) {
        const reason = this.reasonOf(answer);
        if (reason !== undefined && MENDABLE.has(reason) && !connection.closed) {
          await this.openSession(connection);
          continue;
        }
      }
      return answer;
    }
  }

  private errorId(answer: RawAnswer): string | undefined {
    try {
      const value = JSON.parse(answer.body.toString('utf8')) as unknown;
      return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
    } catch {
      return undefined;
    }
  }

  private reasonOf(answer: RawAnswer): string | undefined {
    try {
      const value = JSON.parse(answer.body.toString('utf8')) as unknown;
      return isRecord(value) && typeof value.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.reason) ? value.reason : undefined;
    } catch {
      return undefined;
    }
  }

  /** The parsed body of an answer with an expected status; every other status becomes the failure it means. */
  private answerJson(answer: RawAnswer, ...ok: number[]): unknown {
    if (ok.includes(answer.status)) return parseJson(answer);
    const status = answer.status;
    const error = this.errorId(answer);
    const reason = this.reasonOf(answer);
    if (status === 429) throw new HubTransportError('rate-limited', { status, retryAfterSeconds: retryAfterOf(answer.headers) ?? 1 });
    if (status === 403 && error === 'session-refused') throw new HubTransportError('session-refused', { status, ...(reason === undefined ? {} : { reason }) });
    if (status === 401 && (reason === 'revoked' || reason === 'quarantined')) throw new HubTransportError('session-refused', { status, reason });
    if (status === 403 && reason === 'wrong-project') throw new HubTransportError('wrong-project', { status, label: { project: '' } });
    return this.hubError(status, error ?? reason);
  }

  private hubError(status: number, reason: string | undefined): never {
    const safe = reason !== undefined && /^[a-z][a-z0-9-]{0,63}$/.test(reason) ? reason : undefined;
    throw new HubTransportError('hub-error', { status, ...(safe === undefined ? {} : { reason: safe }) });
  }

  /** Every answer names this project, and the stream asked about when there is one. */
  private checkLabel(value: Record<string, unknown>, stream?: string): void {
    const project = typeof value.project === 'string' ? value.project : '';
    if (project !== this.project) throw new HubTransportError('wrong-project', { label: { project } });
    if (stream !== undefined && value.stream !== stream) throw new HubTransportError('wrong-project', { label: { project, stream: typeof value.stream === 'string' ? value.stream : '' } });
  }
}

/** Splits entries and grants into appends the hub takes: at most 200 entries, 64 grants and about 3 MiB each, grants in the first ones. */
export function appendBatches(entries: readonly SealedEntry[], grants: readonly unknown[], blobRefs: ReadonlyArray<{ entry: string; blob: string }>, entryHashOf?: (entry: SealedEntry) => string): AppendBatch[] {
  const batches: AppendBatch[] = [];
  let current: { entries: SealedEntry[]; grants: unknown[]; bytes: number } = { entries: [], grants: [], bytes: 0 };
  const flush = (): void => {
    if (current.entries.length === 0 && current.grants.length === 0) return;
    const hashes = entryHashOf === undefined ? undefined : new Set(current.entries.map(entryHashOf));
    const refs = hashes === undefined ? [] : blobRefs.filter((ref) => hashes.has(ref.entry));
    batches.push({ entries: current.entries, ...(current.grants.length === 0 ? {} : { grants: current.grants }), ...(refs.length === 0 ? {} : { blobRefs: refs }) });
    current = { entries: [], grants: [], bytes: 0 };
  };
  for (const grant of grants) {
    const size = Buffer.byteLength(JSON.stringify(grant), 'utf8');
    if (current.grants.length >= APPEND_MAX_GRANTS || (current.bytes + size > APPEND_MAX_BYTES && current.grants.length > 0)) flush();
    current.grants.push(grant);
    current.bytes += size;
  }
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 200;
    if (current.entries.length >= APPEND_MAX_ENTRIES || (current.bytes + size > APPEND_MAX_BYTES && (current.entries.length > 0 || current.grants.length > 0))) flush();
    current.entries.push(entry);
    current.bytes += size;
  }
  flush();
  return batches;
}

/** Reads server-sent events from a response, in order, as reports. One reader per connection; the connection closes with it. */
class HubEventReader implements EventReader {
  public retryMs: number | undefined;
  private readonly queue: EventReport[] = [];
  private waiting: ((result: IteratorResult<EventReport>) => void) | undefined;
  private ended = false;
  private buffer = '';
  private event: string | undefined;
  private data: string[] = [];
  private id: number | undefined;
  private lastId = 0;

  public constructor(private readonly project: string, private readonly connection: HubConnection, response: IncomingMessage, private readonly abort: () => void, private readonly onClose: () => void) {
    if (response.statusCode === 204) {
      response.resume();
      this.report({ kind: 'stopped' });
      this.finish();
      return;
    }
    const type = response.headers['content-type'];
    if (response.statusCode !== 200 || typeof type !== 'string' || !type.startsWith('text/event-stream')) {
      response.resume();
      this.report(response.statusCode === 401 || response.statusCode === 403 ? { kind: 'stopped' } : { kind: 'malformed' });
      this.finish();
      return;
    }
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => this.take(chunk));
    response.on('end', () => this.end());
    response.on('aborted', () => this.end());
    response.on('error', () => this.end());
    response.on('close', () => this.end());
  }

  public [Symbol.asyncIterator](): AsyncIterator<EventReport> {
    return {
      next: (): Promise<IteratorResult<EventReport>> => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
      return: (): Promise<IteratorResult<EventReport>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }

  public close(): void {
    if (!this.ended) this.finish();
  }

  private report(item: EventReport): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter !== undefined) {
      this.waiting = undefined;
      waiter({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.abort();
    this.connection.close();
    this.onClose();
    const waiter = this.waiting;
    this.waiting = undefined;
    waiter?.({ value: undefined, done: true });
  }

  private end(): void {
    if (this.ended) return;
    this.report({ kind: 'closed' });
    this.finish();
  }

  private take(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    if (this.buffer.length > EVENT_FRAME_MAX_BYTES) {
      this.report({ kind: 'malformed' });
      this.finish();
      return;
    }
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) return;
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      this.line(line);
      if (this.ended) return;
    }
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = /^\d{1,15}$/.test(value) ? Number(value) : undefined;
    else if (field === 'retry' && /^\d{1,9}$/.test(value)) this.retryMs = Number(value);
  }

  private dispatch(): void {
    const event = this.event;
    const data = this.data.join('\n');
    const id = this.id;
    this.event = undefined;
    this.data = [];
    this.id = undefined;
    if (event === undefined && data === '') return;
    if (id !== undefined) {
      if (id !== this.lastId + 1) this.report({ kind: 'gap', expected: this.lastId + 1, got: id });
      this.lastId = id;
    }
    if (event === undefined || !(HUB_EVENT_NAMES as readonly string[]).includes(event)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.report({ kind: 'malformed' });
      return;
    }
    if (!isRecord(parsed)) {
      this.report({ kind: 'malformed' });
      return;
    }
    if (parsed.project !== this.project) {
      this.report({ kind: 'wrong-project', event });
      return;
    }
    if (event === 'resync') {
      this.report({ kind: 'resync' });
      this.finish();
      return;
    }
    this.report({ kind: 'frame', event: event as HubEventName, id: id ?? 0, data: parsed });
  }
}
