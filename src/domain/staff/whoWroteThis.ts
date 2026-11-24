import type { AuthorSpan } from '../replica/attribution';
import type { RosterState } from '../replica/roster';
import { memberAt } from '../replica/rosterMembers';
import type { Registration } from '../replica/textFold';

export const NOT_VERIFIED_TEXT = 'Not verified: this part comes from a summary that could not be checked.';
const AUTHOR_UNAVAILABLE = 'Author unavailable';

type AuthorNames = (span: AuthorSpan) => { memberName: string; agentJob?: string } | undefined;

export function namesAtRegistration(registrations: readonly Registration[], roster: RosterState): AuthorNames {
  const clients = new Map(registrations.map((registration) => [registration.clientId, registration]));
  const positions = new Map(roster.positions.map((hash, position) => [hash, position]));
  return (span) => {
    const registration = clients.get(span.clientId);
    if (!registration || registration.member !== span.member || registration.writer !== span.writer || registration.actor.kind !== span.actor) return undefined;
    const position = positions.get(registration.roster);
    if (position === undefined) return undefined;
    const member = memberAt(roster.members, registration.member, position);
    if (!member) return undefined;
    if (registration.actor.kind === 'person') return { memberName: member.name };
    if (registration.actor.kind !== 'agent' || registration.actor.member !== span.agentMember ||
      registration.actor.run !== span.run || !member.agentSeats.includes(registration.actor.member)) return undefined;
    return { memberName: member.name, agentJob: registration.actor.member.replaceAll('-', ' ') };
  };
}

export function authorLabel(span: AuthorSpan, names: AuthorNames): string {
  if (span.unverified) return NOT_VERIFIED_TEXT;
  const author = names(span);
  if (!author) return AUTHOR_UNAVAILABLE;
  if (span.actor === 'person') return author.memberName;
  if (!author.agentJob || !span.run) return AUTHOR_UNAVAILABLE;
  return `${author.agentJob} agent, run ${span.run}, on ${author.memberName}'s computer`;
}

export function authorRows(spans: readonly AuthorSpan[], names: AuthorNames): Array<{ label: string; share: number; spans: AuthorSpan[] }> {
  const rows = new Map<string, { label: string; length: number; spans: AuthorSpan[] }>();
  let total = 0;
  for (const span of spans) {
    const label = authorLabel(span, names);
    const key = span.unverified ? NOT_VERIFIED_TEXT : JSON.stringify([span.writer, span.actor, span.agentMember, span.run, label]);
    const row = rows.get(key) ?? { label, length: 0, spans: [] };
    row.length += span.length;
    row.spans.push(span);
    total += span.length;
    rows.set(key, row);
  }
  return [...rows.values()].map(({ label, length, spans: ranges }) => ({ label, share: length / total, spans: ranges }));
}
