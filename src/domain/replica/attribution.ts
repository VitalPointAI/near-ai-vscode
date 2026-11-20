// Who typed which character (D-20). Pure: it takes the runs doc.ts reads off a document and the signed client registrations, and gives spans of text.
// The registrations are the only authority. Yjs can store a user to client map inside the document, but any writer could forge that, so it is never used.
import type { Actor } from './entry';

// The part of a registration this file needs; textFold's Registration satisfies it.
export interface AttributionRegistration { clientId: number; writer: string; member: string; actor: Actor }
// One stretch of visible text typed under one client id; the shape doc.ts's attributionRuns gives. clock is the clock of its first character; it is
// only read when attributeText is given a proof (the characters of a run have consecutive clocks).
export interface AttributionRunInput { client: number; length: number; clock?: number }

// writer is the device key id that signed the entry; member is the roster member of that device (the person whose machine it was). For an agent,
// agentMember and run name the agent member and the run that typed it.
// unverified is set on text that no accepted update backs: it came only from a compaction the log cannot check yet (D-21, D-37). Such text is
// attributed to the writer of that compaction at most, never to anyone else, whatever client id it carries.
export interface AuthorSpan {
  start: number;
  length: number;
  clientId: number;
  writer: string;
  member: string;
  actor: 'person' | 'agent';
  agentMember?: string;
  run?: string;
  unverified?: true;
}
export interface AuthorSummary {
  writer: string;
  member: string;
  actor: 'person' | 'agent';
  agentMember?: string;
  run?: string;
  unverified?: true;
  characters: number;
}

// What the log proves about the text (CR-01). A character at (client, clock) is proven when an accepted update holds it, which for a document built
// from accepted updates alone means clock < proven.get(client). Text that is not proven is shown as unverified. claimant is the writer of the
// compaction the unproven text came from: unproven text under a client id registered to that writer keeps its attribution (a writer may speak for
// itself), and unproven text under any other client id is unattributed, because one signed compaction cannot vouch for another device.
export interface AttributionProof { proven: ReadonlyMap<number, number>; claimant: string }

// The writer of a span whose client has no registration. The ownership check makes this impossible for a folded product, so tests assert that no span
// carries it; production code shows it as unattributed rather than failing the fold on one odd run.
export const UNATTRIBUTED_WRITER = '';

function lookup(registrations: Iterable<AttributionRegistration> | ReadonlyMap<number, AttributionRegistration>): Map<number, AttributionRegistration> {
  const found = new Map<number, AttributionRegistration>();
  const list = registrations instanceof Map ? registrations.values() : (registrations as Iterable<AttributionRegistration>);
  for (const registration of list) if (!found.has(registration.clientId)) found.set(registration.clientId, registration);
  return found;
}

function spanOf(start: number, length: number, client: number, registration: AttributionRegistration | undefined): AuthorSpan {
  if (registration === undefined) return { start, length, clientId: client, writer: UNATTRIBUTED_WRITER, member: '', actor: 'person' };
  const span: AuthorSpan = { start, length, clientId: client, writer: registration.writer, member: registration.member, actor: registration.actor.kind === 'agent' ? 'agent' : 'person' };
  if (registration.actor.kind === 'agent') {
    span.agentMember = registration.actor.member;
    span.run = registration.actor.run;
  }
  return span;
}

// Spans cover every character of the text exactly once, in order. Neighbouring runs of one client are joined into one span. Without a proof every
// character is attributed from the registrations; with one, text the proof does not cover is flagged unverified and attributed as its docs say.
export function attributeText(
  runs: readonly AttributionRunInput[],
  registrations: Iterable<AttributionRegistration> | ReadonlyMap<number, AttributionRegistration>,
  proof?: AttributionProof
): AuthorSpan[] {
  const byClient = lookup(registrations);
  const spans: AuthorSpan[] = [];
  const push = (offset: number, length: number, client: number, unverified: boolean): void => {
    if (length <= 0) return;
    const registration = byClient.get(client);
    const speaks = !unverified || (proof !== undefined && registration !== undefined && registration.writer === proof.claimant);
    const last = spans[spans.length - 1];
    if (last !== undefined && last.clientId === client && (last.unverified === true) === unverified) {
      last.length += length;
      return;
    }
    const span = spanOf(offset, length, client, speaks ? registration : undefined);
    if (unverified) span.unverified = true;
    spans.push(span);
  };
  let offset = 0;
  for (const run of runs) {
    if (run.length > 0) {
      // A run is split where the proof ends: the first `backed` characters are proven, the rest are not.
      const backed = proof === undefined ? run.length : Math.max(0, Math.min(run.length, (proof.proven.get(run.client) ?? 0) - (run.clock ?? 0)));
      push(offset, backed, run.client, false);
      push(offset + backed, run.length - backed, run.client, true);
    }
    offset += run.length;
  }
  return spans;
}

const compareText = (a: string | undefined, b: string | undefined): number => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);

// Characters per (writer, actor, agent member, run), so one person's two devices stay apart and one agent run counts once however many client ids it used.
export function summariseAuthors(spans: readonly AuthorSpan[]): AuthorSummary[] {
  const rows = new Map<string, AuthorSummary>();
  for (const span of spans) {
    const key = JSON.stringify([span.writer, span.actor, span.agentMember ?? null, span.run ?? null, span.unverified === true]);
    const row = rows.get(key);
    if (row !== undefined) {
      row.characters += span.length;
      continue;
    }
    const created: AuthorSummary = { writer: span.writer, member: span.member, actor: span.actor, characters: span.length };
    if (span.agentMember !== undefined) created.agentMember = span.agentMember;
    if (span.run !== undefined) created.run = span.run;
    if (span.unverified === true) created.unverified = true;
    rows.set(key, created);
  }
  return [...rows.values()].sort((a, b) => compareText(a.writer, b.writer) || compareText(a.actor, b.actor) || compareText(a.agentMember, b.agentMember) || compareText(a.run, b.run) || Number(a.unverified === true) - Number(b.unverified === true));
}
