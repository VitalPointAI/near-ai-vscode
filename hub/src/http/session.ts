// Sessions bound to one TLS connection (D-35, D-39; 32-RESEARCH.md Pattern 3, Pitfalls 5 and 7).
//
// A device opens a session in two calls on one TLS connection: POST /v1/session {project} gets a fresh 32-byte challenge for that socket, and
// POST /v1/session {answer} returns a signed staff-hub-session payload over the hub's writer id, the project, the challenge and the 32 bytes both ends
// get from exportKeyingMaterial(32, 'near-ai-hub-session/v1') on that connection (server.ts sessionKeying). An answer made on another connection, for
// another hub or project, or for another or a used challenge is refused. The hub then asks its roster: the device must be a person's device,
// admitted and neither revoked nor quarantined at the roster head. The bearer token it returns is 32 random bytes kept only in memory for 15
// minutes, filed under its sha256, and bound to the keying material of the connection it was issued on, so a token copied to another connection
// is refused. Every authenticated call checks the device's standing at the current head again, so a device revoked or quarantined since it opened
// its session gets nowhere.
//
// A connection that has not opened a session within the authentication deadline (10 seconds from the handshake) is closed. GET /healthz and the
// session, enrolment and join calls work before that, inside the deadline. The deadline is for getting a session, not for an upload: a request
// whose body is still arriving when it passes (an enrolment of up to 4 MiB on a slow link) is read to the end under the server's minimum-rate rule
// and answered, and then the connection is closed unless that request opened a session (WR-03).
//
// Bounds: one open challenge per socket (a new challenge replaces the old one), single use, 60 seconds; at most 8 tokens per device and 10,000 in
// all, the oldest dropped first. Tokens, challenges and keying material are never logged and never echoed.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { TLSSocket } from 'node:tls';
import { CHALLENGE_BYTES, SESSION_REFUSALS as ANSWER_REFUSALS, readSessionAnswer } from '@ext/domain/replica/hubFile';
import type { SessionExpectation, SessionRead } from '@ext/domain/replica/hubFile';
import { STREAM_ID_PATTERN } from '@ext/domain/replica/entry';
import { deviceAt } from '@ext/domain/replica/rosterMembers';
import type { RosterCache } from '../append/rosterCache';
import type { HubStore } from '../store/hubStore';
import { sessionKeying, uploadUnderWay } from './server';

export const CHALLENGE_TTL_MS = 60_000;
export const TOKEN_TTL_MS = 15 * 60_000;
export const AUTH_DEADLINE_MS = 10_000;
export const TOKENS_PER_DEVICE = 8;
export const MAX_TOKENS = 10_000;
const TOKEN_BYTES = 32;
const TOKEN_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** Why an answer or a challenge request is refused: 403 session-refused with one of these as the reason. */
export const SESSION_REFUSALS = {
  'unknown-project': 'This hub does not hold that project. Check the project, or ask the staff lead to connect it to this hub.',
  'not-admitted': 'This device is not admitted to the project at the hub\'s roster. Ask the staff lead to admit this device.',
  'not-a-person-device': 'Only a person\'s device can open a session with the hub.',
  quarantined: 'This device signed two different entries at one place, so the hub takes nothing from it until the staff lead releases it or revokes it. Ask the staff lead.',
  'wrong-hub': ANSWER_REFUSALS['wrong-hub'],
  'wrong-project': ANSWER_REFUSALS['wrong-project'],
  'wrong-challenge': ANSWER_REFUSALS['wrong-challenge'],
  'wrong-connection': ANSWER_REFUSALS['wrong-connection'],
  'bad-signature': ANSWER_REFUSALS['bad-signature'],
  'challenge-expired': 'The challenge has expired. Open a new session and answer its challenge within a minute.',
  malformed: ANSWER_REFUSALS.malformed,
} as const;
export type SessionRefusal = keyof typeof SESSION_REFUSALS;

/** Why a call with a bearer token is refused: 401 for every reason but wrong-project, which is 403. */
export const AUTH_REFUSALS = {
  'no-token': 'This call needs a session. Open a session with the hub on this connection, then send its token.',
  'unknown-token': 'The hub does not know this session token. Open a new session on this connection.',
  'token-expired': 'The session has expired. Open a new session on this connection.',
  'other-connection': 'This session token was issued on another connection to the hub. Open a new session on this connection.',
  revoked: 'This device is no longer admitted to the project. Ask the staff lead.',
  quarantined: SESSION_REFUSALS.quarantined,
  'wrong-project': 'This session is for another project. Open a session for this project.',
} as const;
export type AuthRefusal = keyof typeof AUTH_REFUSALS;

export interface Session {
  project: string;
  writer: string;
  expiresAt: number;
}

export type ChallengeResult = { ok: true; body: { project: string; hub: string; challenge: string } } | { ok: false; reason: SessionRefusal; message: string };
export type AnswerResult = { ok: true; session: Session; body: { project: string; token: string; expiresAt: string } } | { ok: false; reason: SessionRefusal; message: string };
export type AuthResult = { ok: true; session: Session } | { ok: false; status: 401 | 403; reason: AuthRefusal; message: string };

export interface SessionOptions {
  /** The hub's writer id: the hub an answer must name. */
  hub: string;
  store: HubStore;
  cache: RosterCache;
  /** Milliseconds; the clock for challenges and tokens. */
  now?: () => number;
  /** How long a connection may stay without a session (10 seconds). */
  deadlineMs?: number;
  /** The answer check (readSessionAnswer); injectable so a test can count calls. */
  readAnswer?: (answer: unknown, expected: SessionExpectation) => SessionRead;
}

interface OpenChallenge {
  project: string;
  challenge: Buffer;
  expiresAt: number;
}

interface TokenRecord extends Session {
  keying: Buffer;
}

const refuse = (reason: SessionRefusal): { ok: false; reason: SessionRefusal; message: string } => ({ ok: false, reason, message: SESSION_REFUSALS[reason] });
const refuseAuth = (reason: AuthRefusal): Extract<AuthResult, { ok: false }> => ({ ok: false, status: reason === 'wrong-project' ? 403 : 401, reason, message: AUTH_REFUSALS[reason] });
const tokenId = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(a, b);

export class SessionRegistry {
  private readonly hub: string;
  private readonly store: HubStore;
  private readonly cache: RosterCache;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly readAnswer: (answer: unknown, expected: SessionExpectation) => SessionRead;
  private readonly challenges = new WeakMap<TLSSocket, OpenChallenge>();
  private readonly keyings = new WeakMap<TLSSocket, Buffer>();
  private readonly authenticated = new WeakSet<TLSSocket>();
  private readonly deadlines = new Map<TLSSocket, NodeJS.Timeout>();
  /** Tokens by the sha256 of their text, in issue order (a Map keeps insertion order), so the oldest is first. */
  private readonly tokens = new Map<string, TokenRecord>();

  constructor(options: SessionOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? AUTH_DEADLINE_MS;
    this.readAnswer = options.readAnswer ?? readSessionAnswer;
  }

  /** The keying material of this connection, read once per socket. */
  private keyingOf(socket: TLSSocket): Buffer | undefined {
    let keying = this.keyings.get(socket);
    if (keying === undefined) {
      try {
        keying = sessionKeying(socket);
      } catch {
        return undefined;
      }
      this.keyings.set(socket, keying);
    }
    return keying;
  }

  /** A fresh challenge for this socket and project; it replaces any challenge the socket had open. */
  challenge(socket: TLSSocket, project: unknown): ChallengeResult {
    if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project) || this.store.project(project) === undefined) return refuse('unknown-project');
    const challenge = randomBytes(CHALLENGE_BYTES);
    this.challenges.set(socket, { project, challenge, expiresAt: this.now() + CHALLENGE_TTL_MS });
    return { ok: true, body: { project, hub: this.hub, challenge: challenge.toString('base64url') } };
  }

  /** Checks an answer on the socket its challenge was given on, then the device's standing, and issues a token bound to this connection. */
  async answer(socket: TLSSocket, answer: unknown): Promise<AnswerResult> {
    const open = this.challenges.get(socket);
    // Single use: whatever the answer, the challenge is gone after it.
    this.challenges.delete(socket);
    if (open === undefined) return refuse('wrong-challenge');
    if (this.now() > open.expiresAt) return refuse('challenge-expired');
    const keying = this.keyingOf(socket);
    if (keying === undefined) return refuse('wrong-connection');
    const read = this.readAnswer(answer, { hub: this.hub, project: open.project, challenge: open.challenge, keying });
    if (!read.ok) return refuse(read.reason);

    const roster = await this.cache.get(open.project);
    const standing = roster.standing(read.writer);
    if (standing === 'quarantined') return refuse('quarantined');
    if (standing !== 'admitted') return refuse('not-admitted');
    const device = deviceAt(roster.state.members, read.writer, roster.headPosition);
    if (device === undefined || device.publicKey !== read.publicKey) return refuse('not-admitted');
    if (device.kind !== 'person') return refuse('not-a-person-device');

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const session: Session = { project: open.project, writer: read.writer, expiresAt: this.now() + TOKEN_TTL_MS };
    this.keep(tokenId(token), { ...session, keying: Buffer.from(keying) });
    this.markAuthenticated(socket);
    return { ok: true, session, body: { project: session.project, token, expiresAt: new Date(session.expiresAt).toISOString() } };
  }

  /** Files a token, dropping the device's oldest past 8 and the hub's oldest past 10,000. */
  private keep(id: string, record: TokenRecord): void {
    const mine = [...this.tokens.entries()].filter(([, held]) => held.writer === record.writer);
    for (const [old] of mine.slice(0, Math.max(0, mine.length - (TOKENS_PER_DEVICE - 1)))) this.tokens.delete(old);
    while (this.tokens.size >= MAX_TOKENS) {
      const oldest = this.tokens.keys().next();
      if (oldest.done === true) break;
      this.tokens.delete(oldest.value);
    }
    this.tokens.set(id, record);
  }

  /** The session of a request's bearer token, on the connection it was issued on, for this project when one is named. */
  async authenticate(req: http.IncomingMessage, project?: string): Promise<AuthResult> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer /i.test(header)) return refuseAuth('no-token');
    const text = header.slice(7).trim();
    if (!TOKEN_TEXT.test(text)) return refuseAuth('unknown-token');
    const id = tokenId(text);
    const record = this.tokens.get(id);
    if (record === undefined) return refuseAuth('unknown-token');
    if (this.now() >= record.expiresAt) {
      this.tokens.delete(id);
      return refuseAuth('token-expired');
    }
    const keying = this.keyingOf(req.socket as TLSSocket);
    if (keying === undefined || !sameBytes(keying, record.keying)) return refuseAuth('other-connection');
    if (project !== undefined && project !== record.project) return refuseAuth('wrong-project');
    const roster = await this.cache.get(record.project);
    const standing = roster.standing(record.writer);
    if (standing === 'quarantined') return refuseAuth('quarantined');
    if (standing !== 'admitted') {
      this.revokeDevice(record.writer);
      return refuseAuth('revoked');
    }
    return { ok: true, session: { project: record.project, writer: record.writer, expiresAt: record.expiresAt } };
  }

  /** Starts the authentication deadline of a new TLS connection (the server's onSecureConnection hook). */
  authDeadline(socket: TLSSocket): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(socket);
      if (this.authenticated.has(socket)) return;
      const upload = uploadUnderWay(socket);
      if (upload === undefined) {
        socket.destroy();
        return;
      }
      this.afterUpload(socket, upload.res);
    }, this.deadlineMs);
    timer.unref();
    this.deadlines.set(socket, timer);
    socket.once('close', () => {
      clearTimeout(timer);
      this.deadlines.delete(socket);
    });
  }

  /**
   * The deadline passed while a body was arriving: the server's minimum-rate rule bounds the body, so the request is answered, and then the
   * connection closes unless that request opened a session. No later request on the connection is read. A handler that never answers is cut off
   * one more deadline after its body has arrived.
   */
  private afterUpload(socket: TLSSocket, res: http.ServerResponse): void {
    let backstop: NodeJS.Timeout | undefined;
    let answered = false;
    const close = (): void => {
      clearTimeout(backstop);
      if (answered) return;
      answered = true;
      if (this.authenticated.has(socket) || socket.destroyed) return;
      socket.end();
      const hard = setTimeout(() => socket.destroy(), this.deadlineMs);
      hard.unref();
      socket.once('close', () => clearTimeout(hard));
    };
    res.once('finish', close);
    res.once('close', close);
    res.req.once('end', () => {
      backstop = setTimeout(() => {
        if (!this.authenticated.has(socket)) socket.destroy();
      }, this.deadlineMs);
      backstop.unref();
    });
    socket.once('close', () => clearTimeout(backstop));
  }

  private markAuthenticated(socket: TLSSocket): void {
    this.authenticated.add(socket);
    const timer = this.deadlines.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.deadlines.delete(socket);
  }

  /** Drops every token of a device. Returns how many were dropped. */
  revokeDevice(writer: string): number {
    let dropped = 0;
    for (const [id, record] of this.tokens) {
      if (record.writer === writer) {
        this.tokens.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** How many tokens are held, for the bound tests. */
  get size(): number {
    return this.tokens.size;
  }

  /** At shutdown: no deadline timer is left and every token is forgotten. */
  close(): void {
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    this.tokens.clear();
  }
}
