// The hub's /v1 routes (D-34 to D-39, D-41, D-43, D-44, D-46, D-69): session, enrol, heads, append, entries and blobs (32-20), and the event
// stream, presence and the checkpoint ask (32-21), and invitations and join requests (32-25, join.ts); the client transport (32-23) speaks exactly
// these shapes.
//
// Wire rules. Every JSON answer is application/json with cache-control no-store. An error is {error: id, message: one plain sentence}, with a
// reason for session and token refusals, and never echoes the request: no path, no token, no challenge, no body. Request bodies are read with a
// byte cap before they are parsed (64 KiB for session, 4 MiB for append and enrol, 8 MiB for blobs) and a declared length past the cap is refused
// 413 before the body is read. Project ids and hashes are checked against their patterns before any lookup. Session, enrol and join take the
// per-address bucket before anything else (Pitfall 7), and join reads at most 64 KiB, so a flood costs the hub no signature check.
//
// Reading rules (T-32-76). heads lists only the streams whose cell names the device among its grantees at the roster head, and only the grant hashes
// of those cells. entries answers 404 for a stream the device may not read, exactly as for one that does not exist. A blob or a grant the device may
// not read answers exactly like one the hub does not hold.
//
// Live push (D-37, D-43). After an append's COMMIT the hub first ends the streams of every device the batch left revoked or quarantined, then
// sends roster to every admitted device when the roster head moved, one heads event per stream the batch added to (to that stream's access list,
// the pushing device left out), and equivocation to the stream's access list and the lead's and deputy's devices. Every audience is read from the
// roster cache at that moment. A stream request whose token is unknown, expired, from another connection, or whose device is revoked or
// quarantined is answered 204 with no body, so a browser-style client stops reconnecting; one with no token at all is 401.
//
// Grants travel in append and are listed in heads because they live outside the streams and the hub needs them for access lists; append names the
// blobs its entries use because the hub cannot read which blob a sealed body names (D-69).
import { createHash } from 'node:crypto';
import { CHECKPOINT_MAX_BYTES, readCheckpoint, verifyCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Checkpoint } from '@ext/domain/replica/checkpoint';
import { canonicalize } from '@ext/domain/team/canonical';
import type http from 'node:http';
import type { TLSSocket } from 'node:tls';
import { HASH_PATTERN, STREAM_ID_PATTERN } from '@ext/domain/replica/entry';
import type { EquivocationProof } from '@ext/domain/replica/equivocation';
import { APPEND_REFUSALS, appendBatch } from '../append/checks';
import type { AppendRefusal, AppendResult } from '../append/checks';
import type { ProjectRoster, RosterCache } from '../append/rosterCache';
import { enrolProject } from '../enrol';
import type { EnrolRefusal, HubIdentity } from '../enrol';
import { JoinDesk } from '../join';
import type { JoinFailure } from '../join';
import { EventHub } from '../live/events';
import { PresenceHub } from '../live/presence';
import { LIMITS } from '../limits';
import type { RateLimits } from '../limits';
import { StoreError } from '../store/hubStore';
import type { HubStore } from '../store/hubStore';
import { BASE_HEADERS, sendJson } from './server';
import type { HubHandler } from './server';
import { SESSION_REFUSALS } from './session';
import type { Session, SessionRegistry } from './session';

export interface RouteDeps {
  store: HubStore;
  cache: RosterCache;
  sessions: SessionRegistry;
  limits: RateLimits;
  identity: HubIdentity;
  /** Milliseconds; the clock for buckets, appends, enrolment and uploads. */
  now: () => number;
  /** The open event streams; a registry of its own when absent. */
  events?: EventHub;
  /** Presence in memory; one of its own, publishing through events, when absent. */
  presence?: PresenceHub;
  /** Invitations and join requests (32-25); one of its own, publishing through events, when absent. */
  join?: JoinDesk;
  /** Called after COMMIT with the entries the hub now has from an append, after the hub's own events are published. */
  onAccepted?: (project: string, accepted: readonly string[], rosterChanged: boolean) => void;
  /** Called after COMMIT with the equivocation proofs an append recorded, after the hub's own events are published. */
  onEquivocation?: (project: string, proofs: readonly EquivocationProof[]) => void;
  /** A route that failed with 500, by route id and error name only. */
  onFailure?: (route: RouteId, error: unknown) => void;
}

export type RouteId =
  | 'session'
  | 'enrol'
  | 'heads'
  | 'append'
  | 'entries'
  | 'blob-put'
  | 'blob-get'
  | 'events'
  | 'presence'
  | 'checkpoint'
  | 'invites'
  | 'join'
  | 'join-requests';

export const ROUTE_ERRORS = {
  'not-found': 'There is nothing at this address on the hub.',
  'method-not-allowed': 'This address does not answer that method.',
  'too-large': 'The request body is larger than this call accepts.',
  malformed: 'The request is not in a shape the hub can read.',
  'rate-limited': 'Too many calls came from this address. Wait the time the hub gives, then try again.',
  'blob-mismatch': 'The uploaded bytes do not have the hash the address names. Upload the blob again.',
  'pending-quota': 'This device has uploaded too many blobs that no entry uses yet. Send the entries that use them first.',
  'too-many-streams': 'This device or address already has as many event streams open as the hub allows. Close one, or wait the time the hub gives.',
  forbidden: 'This device is not on the access list of that part of the project.',
  'checkpoint-refused': 'A checkpoint handed back is not one this hub signed for this project, so none of them was kept.',
  internal: 'The hub could not answer this request. Try again later.',
} as const;
export type RouteError = keyof typeof ROUTE_ERRORS;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function sendError(res: http.ServerResponse, status: number, error: RouteError, extra: Record<string, string> = {}): void {
  sendJson(res, status, JSON.stringify({ error, message: ROUTE_ERRORS[error] }), extra);
}

/** Bytes as the answer, with the project named in a header. */
function sendBytes(res: http.ServerResponse, bytes: Buffer, project: string): void {
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'x-near-ai-project': project });
  res.end(bytes);
}

/** Refuses a body larger than cap: 413, and the connection is closed after the answer so the rest of the body is never parsed. */
function refuseTooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!res.headersSent) sendError(res, 413, 'too-large', { connection: 'close' });
  req.resume();
}

/** Reads the body with a byte cap. A declared length past the cap is refused before any byte is read; a body that grows past it is cut off. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse, cap: number): Promise<Buffer | undefined> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > cap)) {
    refuseTooLarge(req, res);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | undefined): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        chunks.length = 0;
        refuseTooLarge(req, res);
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onError = (): void => finish(undefined);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** The body as JSON, or undefined after answering 413 or 400. */
async function readJson(req: http.IncomingMessage, res: http.ServerResponse, cap: number): Promise<{ value: unknown } | undefined> {
  const bytes = await readBody(req, res, cap);
  if (bytes === undefined) {
    if (!res.headersSent) sendError(res, 400, 'malformed');
    return undefined;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    sendError(res, 400, 'malformed');
    return undefined;
  }
}

/** One presented checkpoint: at most the checkpoint size limit plus room for its envelope (version, purpose, signer, time and signature). */
const CHECKPOINT_ENVELOPE_BYTES = 4 * 1024;
/** At most this many checkpoints in one ask. */
export const CHECKPOINTS_PER_ASK = 16;
const CHECKPOINT_BODY_BYTES = CHECKPOINTS_PER_ASK * (CHECKPOINT_MAX_BYTES + CHECKPOINT_ENVELOPE_BYTES) + 1024;

/** How much of the project a checkpoint covers: the entries it counts in all its streams. An honest hub's later checkpoints cover more. */
const coverageOf = (checkpoint: Checkpoint): number => checkpoint.streams.reduce((total, stream) => total + stream.count, 0);

const ENROL_STATUS: Readonly<Partial<Record<EnrolRefusal, number>>> = { 'rate-limited': 429, malformed: 400, 'project-exists': 409 };
const APPEND_STATUS: Readonly<Partial<Record<AppendRefusal, number>>> = {
  'malformed-batch': 400,
  'unknown-project': 404,
  'batch-too-large': 413,
  'rate-limited': 429,
  'blob-missing': 409,
};

interface Matched {
  route: RouteId;
  params: { project?: string; hash?: string };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Matched['params']) => Promise<void>;

interface RouteEntry {
  /** Path segments; ':project' and ':hash' are parameters checked against their patterns. */
  path: readonly string[];
  methods: Readonly<Record<string, { id: RouteId; handler: Handler }>>;
}

/** The handler for the /v1 routes, given to createHubServer. */
export function createRoutes(deps: RouteDeps): HubHandler {
  const { store, cache, sessions, limits, identity } = deps;
  const events = deps.events ?? new EventHub({ now: deps.now });
  const presence = deps.presence ?? new PresenceHub(events, { now: deps.now, accessList: async (project, cell) => (await cache.get(project)).accessList(cell) });
  const desk = deps.join ?? new JoinDesk({ store, cache, identity, events, now: deps.now });

  const addressOf = (req: http.IncomingMessage): string => req.socket.remoteAddress ?? 'unknown';

  /** The authenticated session, or undefined after answering 401 or 403. */
  const authenticate = async (req: http.IncomingMessage, res: http.ServerResponse, project?: string): Promise<Session | undefined> => {
    const auth = await sessions.authenticate(req, project);
    if (auth.ok) return auth.session;
    req.resume();
    sendJson(res, auth.status, JSON.stringify({ error: auth.status === 401 ? 'unauthenticated' : 'forbidden', reason: auth.reason, message: auth.message }));
    return undefined;
  };

  const mayRead = (roster: ProjectRoster, writer: string) => (stream: string): boolean => roster.accessList(stream)?.includes(writer) === true;

  const checkpointOf = (project: string): { checkpoint?: unknown } => {
    const latest = store.latestCheckpoint(project);
    return latest === undefined ? {} : { checkpoint: JSON.parse(latest.body) as unknown };
  };

  const session: Handler = async (req, res) => {
    const taken = limits.takeAddress('session', addressOf(req), deps.now());
    if (!taken.ok) {
      req.resume();
      sendError(res, 429, 'rate-limited', { 'retry-after': String(taken.retryAfterSeconds) });
      return;
    }
    const body = await readJson(req, res, LIMITS.smallBodyBytes);
    if (body === undefined) return;
    const value = body.value;
    const keys = isRecord(value) ? Object.keys(value) : [];
    const socket = req.socket as TLSSocket;
    const refuse = (reason: keyof typeof SESSION_REFUSALS): void => {
      if (reason === 'malformed') sendError(res, 400, 'malformed');
      else sendJson(res, 403, JSON.stringify({ error: 'session-refused', reason, message: SESSION_REFUSALS[reason] }));
    };
    if (isRecord(value) && keys.length === 1 && keys[0] === 'project') {
      const result = sessions.challenge(socket, value.project);
      if (result.ok) sendJson(res, 200, JSON.stringify(result.body));
      else refuse(result.reason);
      return;
    }
    if (isRecord(value) && keys.length === 1 && keys[0] === 'answer') {
      const result = await sessions.answer(socket, value.answer);
      if (result.ok) sendJson(res, 200, JSON.stringify(result.body));
      else refuse(result.reason);
      return;
    }
    sendError(res, 400, 'malformed');
  };

  const enrol: Handler = async (req, res) => {
    // The bucket before the body is read: an address past its rate costs the hub nothing (Pitfall 7).
    const now = deps.now();
    const taken = limits.takeAddress('enrol', addressOf(req), now);
    if (!taken.ok) {
      req.resume();
      sendJson(res, 429, JSON.stringify({ error: 'rate-limited', message: ROUTE_ERRORS['rate-limited'] }), { 'retry-after': String(taken.retryAfterSeconds) });
      return;
    }
    const body = await readJson(req, res, LIMITS.enrolBodyBytes);
    if (body === undefined) return;
    const result = await enrolProject({ store, identity, now: new Date(now), cache }, body.value);
    if (result.ok) {
      sendJson(res, 201, JSON.stringify({ project: result.project, rosterHead: result.rosterHead, hub: identity.hub }));
      return;
    }
    const extra: Record<string, string> = result.retryAfterSeconds === undefined ? {} : { 'retry-after': String(result.retryAfterSeconds) };
    sendJson(res, ENROL_STATUS[result.reason] ?? 403, JSON.stringify({ error: result.reason, message: result.message }), extra);
  };

  const heads: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    req.resume();
    const roster = await cache.get(project);
    const may = mayRead(roster, auth.writer);
    const streams = store.heads(project).filter((item) => may(item.stream)).map((item) => ({ stream: item.stream, heads: item.heads }));
    const grants = store.grants(project).filter((grant) => may(grant.cell)).map((grant) => grant.hash);
    sendJson(res, 200, JSON.stringify({ project, rosterHead: roster.head, streams, grants, ...checkpointOf(project) }));
  };

  const append: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    const body = await readJson(req, res, LIMITS.appendBodyBytes);
    if (body === undefined) return;
    const value = body.value;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'entries' && key !== 'grants' && key !== 'blobRefs') || !Array.isArray(value.entries)) {
      sendJson(res, 400, JSON.stringify({ error: 'malformed-batch', message: APPEND_REFUSALS['malformed-batch'] }));
      return;
    }
    const outcome = await appendBatch(
      {
        project,
        device: auth.writer,
        entries: value.entries as unknown[],
        ...(value.grants === undefined ? {} : { grants: value.grants as unknown[] }),
        ...(value.blobRefs === undefined ? {} : { blobRefs: value.blobRefs as Array<{ entry: string; blob: string }> }),
      },
      { store, cache, limits, now: deps.now() },
    );
    if (!outcome.ok) {
      const extra: Record<string, string> = outcome.retryAfterSeconds === undefined ? {} : { 'retry-after': String(outcome.retryAfterSeconds) };
      sendJson(res, APPEND_STATUS[outcome.reason] ?? 400, JSON.stringify({ error: outcome.reason, message: outcome.message }), extra);
      return;
    }
    // Answered only now, after COMMIT: everything in accepted is on disk.
    const result = outcome.result;
    const announce = (): Promise<void> => publishAppend(project, auth.writer, result);
    sendJson(
      res,
      200,
      JSON.stringify({
        project,
        accepted: result.accepted,
        refused: result.refused,
        ...(result.grants.refused.length === 0 ? {} : { grantsRefused: result.grants.refused }),
        rosterHead: result.rosterHead,
        ...checkpointOf(project),
      }),
    );
    try {
      await announce();
    } catch {
      // Publishing never changes what the hub stored or answered.
    }
    try {
      if (result.accepted.length > 0 || result.rosterChanged) deps.onAccepted?.(project, result.accepted, result.rosterChanged);
      if (result.equivocations.length > 0) deps.onEquivocation?.(project, result.equivocations);
    } catch {
      // A failing hook never changes what the hub stored or answered.
    }
  };

  /** After COMMIT: standing first, then roster, heads and equivocation events, each to the audience the roster gives now (see the header). */
  const publishAppend = async (project: string, pusher: string, result: AppendResult): Promise<void> => {
    const roster = await cache.get(project);
    if (result.rosterChanged || result.equivocations.length > 0) {
      // A device the batch revoked or quarantined hears nothing more. Its next call, a new stream included, is refused by the session check.
      events.end((owner) => owner.project === project && roster.standing(owner.writer) !== 'admitted');
    }
    if (result.rosterChanged) events.publish(project, (writer) => roster.standing(writer) === 'admitted', 'roster', { project, head: roster.head });

    const touched = new Map<string, Set<string>>();
    for (const entry of result.stored) {
      const writers = touched.get(entry.stream) ?? new Set<string>();
      writers.add(entry.writer);
      touched.set(entry.stream, writers);
    }
    for (const [stream, writers] of touched) {
      const access = roster.accessList(stream);
      if (access === undefined) continue;
      const heads = [...writers]
        .sort()
        .flatMap((writer) => {
          const head = store.headOf(project, stream, writer);
          return head === undefined ? [] : [{ writer, seq: head.seq, hash: head.hash }];
        });
      if (heads.length === 0) continue;
      events.publish(project, (writer) => writer !== pusher && access.includes(writer), 'heads', { project, stream, heads });
    }

    for (const proof of result.equivocations) {
      const { stream, writer, seq } = proof.a;
      const access = roster.accessList(stream) ?? [];
      events.publish(project, (device) => access.includes(device) || roster.isRosterWriter(device), 'equivocation', {
        project,
        stream,
        writer,
        seq,
        proof: { a: proof.a, b: proof.b, publicKey: proof.publicKey },
      });
    }
    if (result.stored.length > 0) events.channel.emit('entries', project);
  };

  /** GET /v1/projects/:p/events: the stream stays open on this connection until the device, the roster or the hub ends it. */
  const eventStream: Handler = async (req, res, params) => {
    const project = params.project as string;
    req.resume();
    const auth = await sessions.authenticate(req, project);
    if (!auth.ok) {
      // 204 tells a browser-style client to stop reconnecting: its token or its device's standing will not pass again (D-37).
      if (auth.status === 401 && auth.reason !== 'no-token') {
        res.writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end();
      } else {
        sendJson(res, auth.status, JSON.stringify({ error: auth.status === 401 ? 'unauthenticated' : 'forbidden', reason: auth.reason, message: auth.message }));
      }
      return;
    }
    const writer = auth.session.writer;
    const opened = events.open(res, {
      project,
      writer,
      address: addressOf(req),
      expiresAt: auth.session.expiresAt,
      // A roster not held in memory is loaded again, never taken as admitted (IN-07).
      allowed: () => cache.peek(project)?.standing(writer) === 'admitted' || cache.get(project).then((roster) => roster.standing(writer) === 'admitted'),
    });
    if (!opened.ok) sendError(res, 429, 'too-many-streams', { 'retry-after': String(opened.retryAfterSeconds) });
  };

  /**
   * POST /v1/projects/:p/presence {cell, sealed} or {cell, leave: true} (D-38): at most 2 KiB, refused 413 before it is parsed; the cell id is
   * checked, then the pushing device's token bucket (the same one appends take), then the device's place on the cell's access list. The sealed
   * value is passed on as it came, never opened, never stored and never logged.
   */
  const presencePost: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    const body = await readJson(req, res, LIMITS.presenceBytes);
    if (body === undefined) return;
    const value = body.value;
    const keys = isRecord(value) ? Object.keys(value).sort().join(',') : '';
    const cell = isRecord(value) ? value.cell : undefined;
    const beat = keys === 'cell,sealed' && isRecord(value) && typeof value.sealed === 'string' && /^[A-Za-z0-9_-]+$/.test(value.sealed);
    const leaving = keys === 'cell,leave' && isRecord(value) && value.leave === true;
    if (typeof cell !== 'string' || !STREAM_ID_PATTERN.test(cell) || (!beat && !leaving)) {
      sendError(res, 400, 'malformed');
      return;
    }
    const taken = limits.takeWriter(auth.writer, 1, deps.now());
    if (!taken.ok) {
      sendError(res, 429, 'rate-limited', { 'retry-after': String(taken.retryAfterSeconds) });
      return;
    }
    const roster = await cache.get(project);
    if (roster.accessList(cell)?.includes(auth.writer) !== true) {
      sendError(res, 403, 'forbidden');
      return;
    }
    if (beat) presence.heartbeat(project, cell, auth.writer, (value as { sealed: string }).sealed);
    else presence.leave(project, cell, auth.writer);
    sendJson(res, 200, JSON.stringify({ project, cell }));
  };

  /**
   * POST /v1/projects/:p/checkpoint {known?: [signed checkpoints]}: asks the hub for a checkpoint, handing back the hub's own checkpoints the client
   * holds (D-46, D-54, D-70: a restored hub may have lost them). Every one must verify as signed by this hub's key for this project at a roster
   * position the hub knows; one that does not refuses the whole request 400 and nothing is kept. Verified ones the store lacks are kept as
   * evidence, placed in the signing order by how much they cover, so one covering less than a checkpoint the hub holds never becomes the latest.
   * The answer carries the latest checkpoint; the checkpoint channel hears the ask (32-22 signs).
   */
  const checkpoint: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    const body = await readJson(req, res, CHECKPOINT_BODY_BYTES);
    if (body === undefined) return;
    const value = body.value;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== 'known') || (value.known !== undefined && !Array.isArray(value.known))) {
      sendError(res, 400, 'malformed');
      return;
    }
    const known = (value.known ?? []) as unknown[];
    if (known.length > CHECKPOINTS_PER_ASK) {
      sendError(res, 413, 'too-large');
      return;
    }
    const roster = await cache.get(project);
    const verified: Array<{ hash: string; text: string; coverage: number }> = [];
    for (const item of known) {
      const verdict = verifyCheckpoint(item, roster.view);
      if (!verdict.ok || verdict.checkpoint.signer !== identity.writer || verdict.checkpoint.project !== project) {
        sendError(res, 400, 'checkpoint-refused');
        return;
      }
      verified.push({ hash: verdict.hash, text: canonicalize(item), coverage: coverageOf(verdict.checkpoint) });
    }
    const now = deps.now();
    let kept = 0;
    for (const item of verified.sort((a, b) => a.coverage - b.coverage)) {
      const held = store.checkpoints(project).map((record) => {
        const payload = readCheckpoint((JSON.parse(record.body) as { payload?: unknown }).payload);
        return { hash: record.hash, signedAt: record.signedAt, coverage: payload === undefined ? 0 : coverageOf(payload) };
      });
      if (held.some((record) => record.hash === item.hash)) continue;
      // Below every held checkpoint that covers at least as much; otherwise after all of them.
      const above = held.filter((record) => record.coverage >= item.coverage).map((record) => record.signedAt);
      const signedAt = above.length > 0 ? Math.max(0, Math.min(...above) - 1) : Math.max(now, ...held.map((record) => record.signedAt + 1));
      if (store.putCheckpoint(project, { hash: item.hash, body: item.text, signedAt, receivedAt: now }) === 'stored') kept += 1;
    }
    sendJson(res, 200, JSON.stringify({ project, kept, ...checkpointOf(project) }));
    events.channel.emit('checkpoint', project);
  };

  const entries: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    req.resume();
    const target = req.url ?? '';
    const query = new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?') + 1) : '');
    const stream = query.get('stream');
    const writer = query.get('writer');
    const fromText = query.get('from') ?? '0';
    if (stream === null || !STREAM_ID_PATTERN.test(stream) || writer === null || !HASH_PATTERN.test(writer) || !/^\d{1,15}$/.test(fromText)) {
      sendError(res, 400, 'malformed');
      return;
    }
    const roster = await cache.get(project);
    if (!mayRead(roster, auth.writer)(stream)) {
      sendError(res, 404, 'not-found');
      return;
    }
    const from = Number(fromText);
    const page = store.entriesFrom(project, stream, writer, from, { limit: LIMITS.catchUpEntries, maxBytes: LIMITS.catchUpBytes });
    const last = page.entries[page.entries.length - 1];
    // The head reached: the last entry given, or with none given, the writer's head at the hub (null when the hub holds none).
    const head = last !== undefined ? { seq: last.seq, hash: last.hash } : (store.headOf(project, stream, writer) ?? null);
    sendJson(
      res,
      200,
      JSON.stringify({
        project,
        stream,
        writer,
        entries: page.entries.map((entry) => ({ header: JSON.parse(entry.header) as unknown, body: entry.body })),
        more: page.more,
        head,
        ...checkpointOf(project),
      }),
    );
  };

  const blobPut: Handler = async (req, res, params) => {
    const hash = params.hash as string;
    const auth = await authenticate(req, res);
    if (auth === undefined) return;
    const declared = req.headers['content-length'];
    const pending = store.unreferencedBytesOf(auth.project, auth.writer);
    if (declared !== undefined && /^\d{1,12}$/.test(declared) && Number(declared) <= LIMITS.blobBytes && pending + Number(declared) > LIMITS.pendingBlobBytesPerUploader) {
      req.resume();
      sendError(res, 413, 'pending-quota', { connection: 'close' });
      return;
    }
    const bytes = await readBody(req, res, LIMITS.blobBytes);
    if (bytes === undefined) {
      if (!res.headersSent) sendError(res, 400, 'malformed');
      return;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      sendError(res, 400, 'blob-mismatch');
      return;
    }
    const held = store.blobInfo(auth.project, hash) !== undefined;
    if (!held && store.unreferencedBytesOf(auth.project, auth.writer) + bytes.length > LIMITS.pendingBlobBytesPerUploader) {
      sendError(res, 413, 'pending-quota');
      return;
    }
    try {
      const stored = await store.putBlob(auth.project, hash, bytes, auth.writer, deps.now());
      sendJson(res, stored === 'stored' ? 201 : 200, JSON.stringify({ project: auth.project, hash }));
    } catch (error) {
      if (error instanceof StoreError && error.id === 'blob-too-large') sendError(res, 413, 'too-large');
      else if (error instanceof StoreError && error.id === 'blob-mismatch') sendError(res, 400, 'blob-mismatch');
      else if (error instanceof StoreError && error.id === 'invalid-record') sendError(res, 400, 'malformed');
      else throw error;
    }
  };

  const blobGet: Handler = async (req, res, params) => {
    const hash = params.hash as string;
    const auth = await authenticate(req, res);
    if (auth === undefined) return;
    req.resume();
    const project = auth.project;
    const roster = await cache.get(project);
    const may = mayRead(roster, auth.writer);
    const grant = store.grant(project, hash);
    if (grant !== undefined && may(grant.cell)) {
      sendBytes(res, Buffer.from(grant.body, 'utf8'), project);
      return;
    }
    const info = store.blobInfo(project, hash);
    if (info !== undefined && (info.uploadedBy === auth.writer || store.blobStreams(project, hash).some(may))) {
      const bytes = await store.readBlob(project, hash);
      if (bytes !== undefined) {
        sendBytes(res, bytes, project);
        return;
      }
    }
    sendError(res, 404, 'not-found');
  };

  /** A refusal from join.ts: {error, message}, no reason field and nothing from the request. */
  const sendJoinFailure = (res: http.ServerResponse, outcome: JoinFailure): void => {
    sendJson(res, outcome.status, JSON.stringify({ error: outcome.reason, message: outcome.message }));
  };

  /** POST /v1/projects/:p/invites {invite, expiresAt, checkKey}: a lead or deputy device registers an invitation (D-48). 201 stored, 200 held. */
  const invites: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    const body = await readJson(req, res, LIMITS.smallBodyBytes);
    if (body === undefined) return;
    const outcome = await desk.register(project, auth.writer, body.value);
    if (!outcome.ok) {
      sendJoinFailure(res, outcome);
      return;
    }
    sendJson(res, outcome.status, JSON.stringify({ project, invite: outcome.invite, held: outcome.held }));
  };

  /**
   * POST /v1/join {join, request}: no session. The per-address bucket first, then at most 64 KiB of body (a larger declared length is refused 413
   * before any byte is read), then join.ts's checks. 202 {project, invite, held} when the request is kept.
   */
  const joinPost: Handler = async (req, res) => {
    const taken = limits.takeAddress('join', addressOf(req), deps.now());
    if (!taken.ok) {
      req.resume();
      sendJson(res, 429, JSON.stringify({ error: 'rate-limited', message: ROUTE_ERRORS['rate-limited'] }), { 'retry-after': String(taken.retryAfterSeconds) });
      return;
    }
    const body = await readJson(req, res, LIMITS.smallBodyBytes);
    if (body === undefined) return;
    const outcome = await desk.join(body.value);
    if (!outcome.ok) {
      sendJoinFailure(res, outcome);
      return;
    }
    sendJson(res, 202, JSON.stringify({ project: outcome.project, invite: outcome.invite, held: outcome.held }));
  };

  /** GET /v1/projects/:p/join-requests: the requests kept for the project, for a lead or deputy device only. */
  const joinRequests: Handler = async (req, res, params) => {
    const project = params.project as string;
    const auth = await authenticate(req, res, project);
    if (auth === undefined) return;
    req.resume();
    const outcome = await desk.list(project, auth.writer);
    if (!outcome.ok) {
      sendJoinFailure(res, outcome);
      return;
    }
    sendJson(res, 200, JSON.stringify({ project, requests: outcome.requests }));
  };

  const table: readonly RouteEntry[] = [
    { path: ['v1', 'session'], methods: { POST: { id: 'session', handler: session } } },
    { path: ['v1', 'enrol'], methods: { POST: { id: 'enrol', handler: enrol } } },
    { path: ['v1', 'projects', ':project', 'heads'], methods: { GET: { id: 'heads', handler: heads } } },
    { path: ['v1', 'projects', ':project', 'append'], methods: { POST: { id: 'append', handler: append } } },
    { path: ['v1', 'projects', ':project', 'entries'], methods: { GET: { id: 'entries', handler: entries } } },
    { path: ['v1', 'projects', ':project', 'events'], methods: { GET: { id: 'events', handler: eventStream } } },
    { path: ['v1', 'projects', ':project', 'presence'], methods: { POST: { id: 'presence', handler: presencePost } } },
    { path: ['v1', 'projects', ':project', 'checkpoint'], methods: { POST: { id: 'checkpoint', handler: checkpoint } } },
    { path: ['v1', 'projects', ':project', 'invites'], methods: { POST: { id: 'invites', handler: invites } } },
    { path: ['v1', 'projects', ':project', 'join-requests'], methods: { GET: { id: 'join-requests', handler: joinRequests } } },
    { path: ['v1', 'join'], methods: { POST: { id: 'join', handler: joinPost } } },
    { path: ['v1', 'blobs', ':hash'], methods: { PUT: { id: 'blob-put', handler: blobPut }, GET: { id: 'blob-get', handler: blobGet } } },
  ];

  const match = (pathname: string): { entry: RouteEntry; params: Matched['params'] } | undefined => {
    const segments = pathname.split('/').slice(1);
    for (const entry of table) {
      if (entry.path.length !== segments.length) continue;
      const params: Matched['params'] = {};
      let ok = true;
      for (let index = 0; index < entry.path.length && ok; index += 1) {
        const want = entry.path[index] as string;
        const got = segments[index] as string;
        if (want === ':project') {
          if (STREAM_ID_PATTERN.test(got)) params.project = got;
          else ok = false;
        } else if (want === ':hash') {
          if (HASH_PATTERN.test(got)) params.hash = got;
          else ok = false;
        } else if (want !== got) ok = false;
      }
      if (ok) return { entry, params };
    }
    return undefined;
  };

  return (req, res) => {
    const target = req.url ?? '/';
    const queryAt = target.indexOf('?');
    const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
    const found = match(pathname);
    if (found === undefined) {
      req.resume();
      sendError(res, 404, 'not-found');
      return;
    }
    const method = req.method ?? 'GET';
    const route = Object.hasOwn(found.entry.methods, method) ? found.entry.methods[method] : undefined;
    if (route === undefined) {
      req.resume();
      sendError(res, 405, 'method-not-allowed', { allow: Object.keys(found.entry.methods).join(', ') });
      return;
    }
    route.handler(req, res, found.params).catch((error: unknown) => {
      try {
        deps.onFailure?.(route.id, error);
      } catch {
        // A failing hook never changes the answer.
      }
      if (!res.headersSent) sendError(res, 500, 'internal');
      else res.destroy();
    });
  };
}
