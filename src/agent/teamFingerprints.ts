import { createHash } from 'node:crypto';

// Fingerprints of built-in team definitions, so an update can tell a member the user left as it
// was generated from one they changed. A member's fingerprint covers what it is and does (role,
// model, privacy, its tools line as written, and its instructions) but not the project goal the
// generator appends, nor a reports-to line (which says where it sits, not what it does).

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A member's instructions without the "Project goal: …" paragraph the generator appends, and that goal. */
export function splitGoal(instructions: string): { body: string; goal?: string } {
  const match = /\n\nProject goal: ([\s\S]*)$/.exec(instructions.trim());
  return match ? { body: instructions.trim().slice(0, match.index).trim(), goal: match[1].trim() } : { body: instructions.trim() };
}

export interface FingerprintMember { role?: string; model?: string; privacy?: string; tools?: string[] | null; instructions: string }

export function memberFingerprint(member: FingerprintMember): string {
  return short(JSON.stringify([member.role ?? '', member.model ?? '', member.privacy ?? '', member.tools ?? null, splitGoal(member.instructions).body]));
}

/** The AGENTS.md project-type block between its markers, with the goal line blanked so any project's copy compares. */
export function guidanceFingerprint(inner: string): string {
  return short(inner.replace(/\r\n/g, '\n').replace(/^Goal: .*$/m, 'Goal:').trim());
}

export function definitionHash(value: unknown): string {
  return short(JSON.stringify(value));
}
