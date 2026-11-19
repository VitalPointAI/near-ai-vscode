// Who typed which character (D-20). Pure: it takes the runs doc.ts reads off a document and the signed client registrations, and gives spans of text.
// The registrations are the only authority. Yjs can store a user to client map inside the document, but any writer could forge that, so it is never used.
import type { Actor } from './entry';

// The part of a registration this file needs; textFold's Registration satisfies it.
export interface AttributionRegistration { clientId: number; writer: string; member: string; actor: Actor }
// One stretch of visible text typed under one client id; the shape doc.ts's attributionRuns gives.
export interface AttributionRunInput { client: number; length: number }

// writer is the device key id that signed the entry; member is the roster member of that device (the person whose machine it was). For an agent,
// agentMember and run name the agent member and the run that typed it.
export interface AuthorSpan {
  start: number;
  length: number;
  clientId: number;
  writer: string;
  member: string;
  actor: 'person' | 'agent';
  agentMember?: string;
  run?: string;
}
export interface AuthorSummary {
  writer: string;
  member: string;
  actor: 'person' | 'agent';
  agentMember?: string;
  run?: string;
  characters: number;
}

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

// Spans cover every character of the text exactly once, in order. Neighbouring runs of one client are joined into one span.
export function attributeText(runs: readonly AttributionRunInput[], registrations: Iterable<AttributionRegistration> | ReadonlyMap<number, AttributionRegistration>): AuthorSpan[] {
  const byClient = lookup(registrations);
  const spans: AuthorSpan[] = [];
  let offset = 0;
  for (const run of runs) {
    if (run.length > 0) {
      const last = spans[spans.length - 1];
      if (last !== undefined && last.clientId === run.client) last.length += run.length;
      else spans.push(spanOf(offset, run.length, run.client, byClient.get(run.client)));
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
    const key = JSON.stringify([span.writer, span.actor, span.agentMember ?? null, span.run ?? null]);
    const row = rows.get(key);
    if (row !== undefined) {
      row.characters += span.length;
      continue;
    }
    const created: AuthorSummary = { writer: span.writer, member: span.member, actor: span.actor, characters: span.length };
    if (span.agentMember !== undefined) created.agentMember = span.agentMember;
    if (span.run !== undefined) created.run = span.run;
    rows.set(key, created);
  }
  return [...rows.values()].sort((a, b) => compareText(a.writer, b.writer) || compareText(a.actor, b.actor) || compareText(a.agentMember, b.agentMember) || compareText(a.run, b.run));
}
