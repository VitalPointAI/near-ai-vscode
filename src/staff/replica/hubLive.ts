// The frames of your organization's server's event stream, read strictly (Phase 33, D-12, D-21, D-49; F2). Pure: no I/O, no editor API, no Yjs and
// no fold, so the hub's tests bundle it with the replicator. A frame is untrusted input from a server that may be hostile: each one is rebuilt
// from its closed shape, another project's frame is wrong-project, and anything else is malformed. A frame only wakes an exchange or a hook; every
// change and checkpoint it points at is still verified by the exchange.
//
// Shapes, as the hub sends them (hub/src/http/routes.ts, hub/src/live/presence.ts, hub/src/checkpoints.ts, hub/src/join.ts):
//   heads         { project, stream, heads: [{ writer, seq, hash }] }
//   presence      { project, cell, devices: [{ writer, sealed }], left: [writer] }
//   roster        { project, head }
//   checkpoint    { project, checkpoint }          the checkpoint is checked by the witness, not here
//   equivocation  { project, stream, writer, seq, proof }
//   join-request  { project, invite }
import type { EventReport } from './hubTransport';

const HASH = /^[0-9a-f]{64}$/;
const STREAM = /^[0-9a-f]{32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEALED = /^[A-Za-z0-9_-]{1,4096}$/;
const MAX_ITEMS = 4096;

export interface HeadsFrame { event: 'heads'; stream: string; heads: Array<{ writer: string; seq: number; hash: string }> }
export interface PresenceFrame { event: 'presence'; cell: string; devices: Array<{ writer: string; sealed: string }>; left: string[] }
export interface RosterFrame { event: 'roster'; head: string }
export interface CheckpointFrame { event: 'checkpoint'; checkpoint: unknown }
export interface EquivocationFrame { event: 'equivocation'; stream: string; writer: string; seq: number }
export interface JoinRequestFrame { event: 'join-request'; invite: string }
export type LiveFrame = HeadsFrame | PresenceFrame | RosterFrame | CheckpointFrame | EquivocationFrame | JoinRequestFrame;
export type FrameRead = { ok: true; frame: LiveFrame } | { ok: false; reason: 'wrong-project' | 'malformed' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

const MALFORMED: FrameRead = { ok: false, reason: 'malformed' };

/** One frame of the event stream for this project, rebuilt from its closed shape, or why it was not taken. */
export function readLiveFrame(report: Extract<EventReport, { kind: 'frame' }>, project: string): FrameRead {
  const data = report.data;
  if (!isRecord(data)) return MALFORMED;
  if (data.project !== project) return { ok: false, reason: 'wrong-project' };
  switch (report.event) {
    case 'heads': {
      if (!keysAre(data, ['project', 'stream', 'heads']) || typeof data.stream !== 'string' || !STREAM.test(data.stream) || !Array.isArray(data.heads) || data.heads.length > MAX_ITEMS) return MALFORMED;
      const heads: HeadsFrame['heads'] = [];
      for (const head of data.heads as unknown[]) {
        if (!isRecord(head) || !keysAre(head, ['writer', 'seq', 'hash']) || typeof head.writer !== 'string' || !HASH.test(head.writer) || !isSeq(head.seq) || typeof head.hash !== 'string' || !HASH.test(head.hash)) return MALFORMED;
        heads.push({ writer: head.writer, seq: head.seq, hash: head.hash });
      }
      return { ok: true, frame: { event: 'heads', stream: data.stream, heads } };
    }
    case 'presence': {
      if (!keysAre(data, ['project', 'cell', 'devices', 'left']) || typeof data.cell !== 'string' || !STREAM.test(data.cell)) return MALFORMED;
      if (!Array.isArray(data.devices) || data.devices.length > MAX_ITEMS || !Array.isArray(data.left) || data.left.length > MAX_ITEMS) return MALFORMED;
      const devices: PresenceFrame['devices'] = [];
      for (const device of data.devices as unknown[]) {
        if (!isRecord(device) || !keysAre(device, ['writer', 'sealed']) || typeof device.writer !== 'string' || !HASH.test(device.writer) || typeof device.sealed !== 'string' || !SEALED.test(device.sealed)) return MALFORMED;
        devices.push({ writer: device.writer, sealed: device.sealed });
      }
      const left: string[] = [];
      for (const writer of data.left as unknown[]) {
        if (typeof writer !== 'string' || !HASH.test(writer)) return MALFORMED;
        left.push(writer);
      }
      return { ok: true, frame: { event: 'presence', cell: data.cell, devices, left } };
    }
    case 'roster':
      if (!keysAre(data, ['project', 'head']) || typeof data.head !== 'string' || !HASH.test(data.head)) return MALFORMED;
      return { ok: true, frame: { event: 'roster', head: data.head } };
    case 'checkpoint':
      if (!keysAre(data, ['project', 'checkpoint']) || !isRecord(data.checkpoint)) return MALFORMED;
      return { ok: true, frame: { event: 'checkpoint', checkpoint: data.checkpoint } };
    case 'equivocation':
      if (!keysAre(data, ['project', 'stream', 'writer', 'seq', 'proof']) || typeof data.stream !== 'string' || !STREAM.test(data.stream) || typeof data.writer !== 'string' || !HASH.test(data.writer) || !isSeq(data.seq)) return MALFORMED;
      return { ok: true, frame: { event: 'equivocation', stream: data.stream, writer: data.writer, seq: data.seq } };
    case 'join-request':
      if (!keysAre(data, ['project', 'invite']) || typeof data.invite !== 'string' || !SLUG.test(data.invite)) return MALFORMED;
      return { ok: true, frame: { event: 'join-request', invite: data.invite } };
    default:
      return MALFORMED;
  }
}
