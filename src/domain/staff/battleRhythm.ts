// The battle rhythm as iCalendar (design 10, 4.3 and 6.2 `battle-rhythm`; WP-ORD): the battle rhythm calendar register's events written to an .ics file
// and read back from one, by RFC 5545 with no library and no network. Pure: no I/O, no clock, no vscode.
//
// Export writes one VEVENT per register row: UID, DTSTAMP, DTSTART and DURATION in UTC, an RRULE for daily or weekly events, SUMMARY, CATEGORIES (the
// kind), LOCATION and DESCRIPTION, and the fields iCalendar has no plain property for (owner, attendees, inputs, outputs) as X-NEAR-AI- properties, so a
// file this exports reads back to the same rows. Text is escaped (3.3.11) and lines are folded at 75 octets (3.1) without splitting a character.
//
// Import treats the file as untrusted: it is size-capped, unfolded, and every line must be a well-formed content line; BEGIN and END must nest; only
// VEVENTs inside one VCALENDAR are read (other components are skipped and counted); times must be UTC; a repeat other than plain daily or weekly is
// refused for that event. Each event becomes a register row, checked against the register's columns. Nothing in the file is ever followed.
import { BATTLE_RHYTHM_KINDS } from './doctrine';
import type { BattleRhythmKind } from './doctrine';
import { checkRow, MAX_REGISTER_ROWS, registerSchema } from './registers';
import type { RegisterRow } from './registers';

export const BATTLE_RHYTHM_REGISTER = 'battle-rhythm-calendar';
/** The largest .ics file the import reads. */
export const MAX_ICS_BYTES = 256 * 1024;
/** The longest content line, after unfolding. */
export const MAX_ICS_LINE = 8 * 1024;
/** The most components (of any kind) one file may hold. */
export const MAX_ICS_COMPONENTS = 2 * MAX_REGISTER_ROWS;
const PRODID = '-//NEAR AI//Staff battle rhythm//EN';

const X = { chair: 'X-NEAR-AI-OWNER', attendees: 'X-NEAR-AI-ATTENDEES', inputs: 'X-NEAR-AI-INPUTS', outputs: 'X-NEAR-AI-OUTPUTS', kind: 'X-NEAR-AI-KIND' } as const;

// ---- Writing ---------------------------------------------------------------------------------------------------------------------------------

/** RFC 5545 3.3.11 TEXT escaping: backslash, semicolon, comma and newline. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 3.1: a line longer than 75 octets is folded with CRLF and a space, never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (octets + size > limit) { out.push(current); current = ''; octets = 0; }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** `2026-11-18T14:00Z` or with seconds and milliseconds, as an iCalendar UTC date-time `20261118T140000Z`. */
export function icsTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a time: ${iso}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The register's time form for an iCalendar UTC date-time. */
function registerTime(ics: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ics);
  if (!match) return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== iso) return undefined;
  // The register's own form: minutes only when the seconds are zero, as members write it.
  return match[6] === '00' ? iso.replace(/:00Z$/, 'Z') : iso;
}

/** The calendar for the register's rows. `stamp` is when it was written (DTSTAMP); `name` heads the calendar. */
export function toIcs(rows: readonly RegisterRow[], stamp: string, name: string): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(name)}`];
  const at = icsTime(stamp);
  for (const row of rows) {
    const text = (key: string): string | undefined => (row[key] === undefined ? undefined : String(row[key]));
    lines.push('BEGIN:VEVENT', `UID:${escapeText(String(row.id))}@staff.near-ai`, `DTSTAMP:${at}`, `DTSTART:${icsTime(String(row.start))}`, `DURATION:PT${Number(row.durationMinutes)}M`);
    if (row.repeat === 'daily') lines.push('RRULE:FREQ=DAILY');
    if (row.repeat === 'weekly') lines.push('RRULE:FREQ=WEEKLY');
    lines.push(`SUMMARY:${escapeText(String(row.title))}`, `CATEGORIES:${escapeText(String(row.kind))}`, `${X.kind}:${escapeText(String(row.kind))}`, `${X.chair}:${escapeText(String(row.chair))}`);
    const description: string[] = [`Owner: ${String(row.chair)}`];
    for (const key of ['attendees', 'inputs', 'outputs'] as const) {
      const value = text(key);
      if (value === undefined) continue;
      lines.push(`${X[key]}:${escapeText(value)}`);
      description.push(`${key.charAt(0).toUpperCase()}${key.slice(1)}: ${value}`);
    }
    if (text('location') !== undefined) lines.push(`LOCATION:${escapeText(text('location')!)}`);
    lines.push(`DESCRIPTION:${escapeText(description.join('\n'))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// ---- Reading ---------------------------------------------------------------------------------------------------------------------------------

export interface ContentLine { readonly name: string; readonly params: Readonly<Record<string, string>>; readonly value: string }

export type IcsImport =
  | { readonly ok: true; readonly rows: RegisterRow[]; readonly problems: string[]; readonly skipped: number }
  | { readonly ok: false; readonly message: string };

const NAME = /^[A-Za-z0-9-]{1,64}$/;
// Control characters other than tab are not allowed in a content line (RFC 5545 3.1, 3.3.11).
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** RFC 5545 3.1 unfolding: a CRLF (or bare LF) followed by a space or tab joins the next line. */
export function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((line) => line.length > 0);
}

/** One content line: name, parameters and value, or undefined when it is not well formed. */
export function parseContentLine(line: string): ContentLine | undefined {
  if (line.length > MAX_ICS_LINE || CONTROL.test(line)) return undefined;
  let index = 0;
  let quoted = false;
  let colon = -1;
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) { colon = index; break; }
  }
  if (colon < 1) return undefined;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let current = '';
  quoted = false;
  for (const char of head) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) { parts.push(current); current = ''; } else current += char;
  }
  if (quoted) return undefined;
  parts.push(current);
  const name = parts[0];
  if (!NAME.test(name)) return undefined;
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 1 || !NAME.test(part.slice(0, eq))) return undefined;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** RFC 5545 3.3.11 TEXT unescaping. A newline becomes a space: a register cell is one line. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? ' ' : char)).trim();
}

/** RFC 5545 3.3.6 durations in minutes, for the forms a meeting uses (PT90M, PT1H30M, P1D); undefined for anything else or under a minute. */
export function durationMinutes(value: string): number | undefined {
  const match = /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/.exec(value);
  if (!match || value === 'P' || value.endsWith('T')) return undefined;
  const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return seconds % 60 === 0 && seconds > 0 ? seconds / 60 : undefined;
}

const slugOf = (uid: string): string => uid.replace(/@.*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);

/**
 * Reads an .ics file into battle rhythm rows. The whole file is refused when it is too large, is not one VCALENDAR, or has a line that is not a
 * content line or BEGIN and END that do not nest. Within it, an event that cannot be a row (no UTC start, no duration, an unsupported repeat, a field
 * the register refuses) is skipped with the reason in `problems`.
 */
export function parseIcs(text: string, bytes = Buffer.byteLength(text, 'utf8')): IcsImport {
  if (bytes > MAX_ICS_BYTES) return { ok: false, message: `The file is ${bytes} bytes; the import reads at most ${MAX_ICS_BYTES} bytes. Split it, or export a shorter calendar.` };
  const schema = registerSchema(BATTLE_RHYTHM_REGISTER)!;
  const lines = unfold(text.replace(/^\uFEFF/, ''));
  const stack: string[] = [];
  const events: Array<Map<string, ContentLine[]>> = [];
  let current: Map<string, ContentLine[]> | undefined;
  let calendars = 0;
  let components = 0;
  let skipped = 0;
  for (const [index, raw] of lines.entries()) {
    const line = parseContentLine(raw);
    if (!line) return { ok: false, message: `Line ${index + 1} is not an iCalendar content line (NAME:value, at most ${MAX_ICS_LINE} characters, no control characters), so nothing was read.` };
    if (line.name === 'BEGIN' || line.name === 'END') {
      const component = line.value.trim().toUpperCase();
      if (!NAME.test(component)) return { ok: false, message: `Line ${index + 1} names no component, so nothing was read.` };
      if (line.name === 'BEGIN') {
        components += 1;
        if (components > MAX_ICS_COMPONENTS) return { ok: false, message: `The file holds more than ${MAX_ICS_COMPONENTS} components; the import reads at most ${MAX_REGISTER_ROWS} events.` };
        if (stack.length === 0 && component !== 'VCALENDAR') return { ok: false, message: 'The file does not start with BEGIN:VCALENDAR, so it is not a calendar.' };
        if (component === 'VCALENDAR' && stack.length > 0) return { ok: false, message: `Line ${index + 1} opens a calendar inside a calendar, so nothing was read.` };
        if (component === 'VCALENDAR') calendars += 1;
        if (calendars > 1) return { ok: false, message: 'The file holds more than one calendar; the import reads one.' };
        stack.push(component);
        if (component === 'VEVENT' && stack.length === 2) current = new Map();
        else if (stack.length >= 2) skipped += stack.length === 2 ? 1 : 0;
      } else {
        if (stack[stack.length - 1] !== component) return { ok: false, message: `Line ${index + 1} closes ${component}, but ${stack[stack.length - 1] ?? 'nothing'} is open, so nothing was read.` };
        stack.pop();
        if (component === 'VEVENT' && stack.length === 1 && current) { events.push(current); current = undefined; }
      }
      continue;
    }
    if (stack.length === 0) return { ok: false, message: `Line ${index + 1} is outside the calendar, so nothing was read.` };
    // Properties of a component inside the event (an alarm) are not the event's.
    if (current && stack.length === 2) current.set(line.name, [...(current.get(line.name) ?? []), line]);
  }
  if (stack.length) return { ok: false, message: `The file ends with ${stack.join(' > ')} still open, so nothing was read.` };
  if (calendars === 0) return { ok: false, message: 'The file holds no calendar.' };
  if (events.length > MAX_REGISTER_ROWS) return { ok: false, message: `The file holds ${events.length} events; the register holds at most ${MAX_REGISTER_ROWS}.` };

  const rows: RegisterRow[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const [index, event] of events.entries()) {
    const one = (name: string): ContentLine | undefined => event.get(name)?.[0];
    const value = (name: string): string | undefined => { const found = one(name); return found ? unescapeText(found.value) : undefined; };
    const label = `Event ${index + 1}`;
    const uid = one('UID')?.value ?? '';
    const id = slugOf(uid) || `event-${index + 1}`;
    if (ids.has(id)) { problems.push(`${label}: its id ${id} is used by an earlier event; skipped.`); continue; }
    const startLine = one('DTSTART');
    if (!startLine || startLine.params.TZID !== undefined || (startLine.params.VALUE !== undefined && startLine.params.VALUE.toUpperCase() !== 'DATE-TIME')) {
      problems.push(`${label} (${id}): its start is not a UTC date-time (such as 20261118T140000Z); skipped.`);
      continue;
    }
    const start = registerTime(startLine.value.trim());
    if (!start) { problems.push(`${label} (${id}): its start is not a UTC date-time (such as 20261118T140000Z); skipped.`); continue; }
    let minutes: number | undefined;
    const duration = one('DURATION');
    const end = one('DTEND');
    if (duration) minutes = durationMinutes(duration.value.trim());
    else if (end && end.params.TZID === undefined) {
      const endTime = registerTime(end.value.trim());
      if (endTime) minutes = (Date.parse(endTime) - Date.parse(start)) / 60_000;
    }
    if (minutes === undefined || !Number.isSafeInteger(minutes) || minutes < 1) { problems.push(`${label} (${id}): it has no duration in whole minutes (DURATION or a UTC DTEND); skipped.`); continue; }
    const rrules = event.get('RRULE') ?? [];
    let repeat: 'once' | 'daily' | 'weekly' = 'once';
    if (rrules.length > 1) { problems.push(`${label} (${id}): it has more than one repeat rule; skipped.`); continue; }
    if (rrules.length === 1) {
      const rule = rrules[0].value.trim().toUpperCase();
      if (rule === 'FREQ=DAILY' || rule === 'FREQ=DAILY;INTERVAL=1') repeat = 'daily';
      else if (rule === 'FREQ=WEEKLY' || rule === 'FREQ=WEEKLY;INTERVAL=1') repeat = 'weekly';
      else { problems.push(`${label} (${id}): it repeats as ${rule.slice(0, 80)}; the battle rhythm keeps plain daily or weekly events only; skipped.`); continue; }
    }
    const kindText = (value(X.kind) ?? value('CATEGORIES') ?? '').toLowerCase().split(/\s*,\s*/)[0].replace(/\s+/g, '-').replace(/^center$/, 'centre');
    const kind: BattleRhythmKind = (BATTLE_RHYTHM_KINDS as readonly string[]).includes(kindText) ? kindText as BattleRhythmKind : 'meeting';
    const organizer = one('ORGANIZER')?.params.CN;
    const chair = value(X.chair) ?? (organizer ? unescapeText(organizer) : undefined);
    const raw: Record<string, string | number> = { id, title: value('SUMMARY') ?? '', kind, start, durationMinutes: minutes, repeat, chair: chair ?? '' };
    for (const key of ['attendees', 'inputs', 'outputs'] as const) { const found = value(X[key]); if (found) raw[key] = found; }
    const location = value('LOCATION');
    if (location) raw.location = location;
    const checked = checkRow(schema, raw);
    if (!checked.ok) { problems.push(`${label} (${id}): ${checked.message} Skipped.`); continue; }
    ids.add(id);
    rows.push(checked.row);
  }
  return { ok: true, rows, problems, skipped };
}
