// Roster audit mirror (D-26): accepted roster events are copied into the project's audit log as team-roster entries.
// The audit entry carries ids, the author's role, the event type and the Lamport clock, never names, emails, keys or fingerprints.
// This module depends on an AuditSink interface rather than the AuditStore class, and never imports vscode.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditEvent, AuditFilter } from '../domain/approval';
import { assertNoSecrets } from '../domain/team/secrets';
import type { ImplementedEventType, Role, TeamEvent } from '../domain/team/types';
import { runSerialised, writeFileAtomic } from './teamFile';

// Spec 5.2 roster group, limited to the types Phase 60 implements. policy.changed and snapshot.written are not roster events.
export const ROSTER_AUDIT_TYPES: readonly ImplementedEventType[] = [
  'team.created', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills'
];

const MARK_FILE = 'audit-mark.json';
const MARK_VERSION = 1;

export interface AuditSink {
  list(filter: AuditFilter): Promise<AuditEvent[]>;
  append(event: AuditEvent): Promise<void>;
}

// The highest Lamport clock already mirrored. It keeps the mirror idempotent even after the audit store's 500 entry cap trims old rows.
export interface MirrorMark {
  read(): Promise<number>;
  write(lamport: number): Promise<void>;
}

export function fileMirrorMark(storageDir: string): MirrorMark {
  const file = path.resolve(storageDir, MARK_FILE);
  return {
    async read(): Promise<number> {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error('The team audit progress record cannot be read.', { cause: error });
      }
      const record = parsed as { version?: unknown; lamport?: unknown } | null;
      if (record === null || typeof record !== 'object' || record.version !== MARK_VERSION || typeof record.lamport !== 'number' || !Number.isSafeInteger(record.lamport) || record.lamport < 0) {
        throw new Error('The team audit progress record is not in a form this version understands.');
      }
      return record.lamport;
    },
    async write(lamport: number): Promise<void> {
      if (!Number.isSafeInteger(lamport) || lamport < 0) throw new RangeError('The audit progress mark must be a non-negative integer.');
      await runSerialised(file, () => writeFileAtomic(file, `${JSON.stringify({ version: MARK_VERSION, lamport })}\n`));
    }
  };
}

// 16 hex characters keep the id well inside the audit store's 80 character limit.
export function rosterAuditId(eventId: string): string {
  return `audit-team-${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;
}

// The member a roster event is about, when its body names one.
function subjectOf(event: TeamEvent): string | undefined {
  const body = event.body as unknown as Record<string, unknown>;
  const named = event.type === 'team.created' ? body.ownerId : body.memberId;
  return typeof named === 'string' ? named : undefined;
}

export function toRosterAuditEvent(event: TeamEvent, authorRole: Role | undefined): AuditEvent {
  const metadata: NonNullable<AuditEvent['metadata']> = { eventType: event.type, eventId: event.id, lamport: event.lamport, memberId: event.author };
  if (authorRole !== undefined) metadata.role = authorRole;
  const subject = subjectOf(event);
  if (subject !== undefined) metadata.subjectId = subject;
  return { version: 1, id: rosterAuditId(event.id), timestamp: event.at, type: 'team-roster', projectId: event.teamId, outcome: 'accepted', metadata };
}

// Mirrors accepted roster events above the stored mark. Callers pass accepted events only; rejected ones are theirs to exclude.
// Every new entry is checked for secrets before any is appended, so a refusal leaves the audit log untouched.
// Returns how many entries were appended.
export async function mirrorRosterEvents(
  sink: AuditSink, mark: MirrorMark, events: TeamEvent[], roleOf: (memberId: string, event: TeamEvent) => Role | undefined
): Promise<number> {
  const floor = await mark.read();
  const candidates = events
    .filter((event) => (ROSTER_AUDIT_TYPES as readonly string[]).includes(event.type) && event.lamport > floor)
    .sort((left, right) => left.lamport - right.lamport);
  if (candidates.length === 0) return 0;
  const known = new Set((await sink.list({ type: 'team-roster' })).map((entry) => entry.id));
  const fresh: AuditEvent[] = [];
  for (const event of candidates) {
    const entry = toRosterAuditEvent(event, roleOf(event.author, event));
    assertNoSecrets(entry, 'team audit entry');
    if (!known.has(entry.id)) {
      known.add(entry.id);
      fresh.push(entry);
    }
  }
  for (const entry of fresh) await sink.append(entry);
  await mark.write(candidates[candidates.length - 1].lamport);
  return fresh.length;
}
