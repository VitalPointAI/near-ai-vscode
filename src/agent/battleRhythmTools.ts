// The battle-rhythm server (design 10, 4.3 and 6.2 `battle-rhythm`; WP-ORD): the battle rhythm calendar register (its boards, bureaus, centres, cells,
// working groups, meetings and briefs, each with its time, owner, inputs and outputs), its export to an .ics file and import from one (RFC 5545,
// src/domain/staff/battleRhythm.ts), and the suspenses of open RFIs and decisions waiting on a person.
//
// It is a built-in local server named `mcp__battle-rhythm__<tool>`, given only to the members whose tools line grants it (staffGrantGate.ts). The
// calendar is a shared product with one writer (the chief of staff in a full staff, the JOC chief in a standalone J3; ownership.ts): writes go through
// the staff-products host's register write, so anyone else is told to propose. Nothing is fetched or sent: the .ics file is written in the project and
// read from the project, and text read from an imported file is returned fenced as untrusted data.
import * as path from 'node:path';
import { BATTLE_RHYTHM_REGISTER, MAX_ICS_BYTES, parseIcs, toIcs } from '../domain/staff/battleRhythm';
import { BATTLE_RHYTHM_KINDS, BATTLE_RHYTHM_NAMES, DOCTRINE_PROFILES } from '../domain/staff/doctrine';
import { STAFF_SLUG } from '../domain/staff/parse';
import type { RegisterRow } from '../domain/staff/registers';
import { mcpToolName } from '../mcp/tools';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import { STAFF_HOST_PATHS } from '../staff/staffHost';
import type { StaffCaller, StaffHost, StaffTeamInfo } from '../staff/staffHost';
import { declareManifest, fromArgument, INTERACTIVE_AND_UNATTENDED } from './tools';
import type { AgentTool, ToolContext } from './tools';
import { fenceUntrusted } from './untrusted';
import { resolveInWorkspace, ToolError } from './workspace';

export const BATTLE_RHYTHM_SERVER = 'battle-rhythm';
export const battleRhythmToolName = (tool: string): string => mcpToolName(BATTLE_RHYTHM_SERVER, tool);

/** Where the export goes: one file per calendar name, in the project's staff folder. */
export const ICS_EXPORT_DIR = '.planning/staff/exports';

export interface BattleRhythmToolAccess {
  host(): StaffHost | undefined;
  readonly team: StaffTeamInfo;
  readonly run: string;
  /** The clock, for DTSTAMP and overdue suspenses. */
  readonly now?: () => number;
}

const READS = { verb: 'read', paths: [...STAFF_HOST_PATHS] };
const WRITES = { verb: 'workspaceWrite', paths: ['.planning/staff/**'] };
const manifest = (tool: string, effects: readonly unknown[]) => declareManifest({ tool: battleRhythmToolName(tool), effects, contexts: INTERACTIVE_AND_UNATTENDED });

function asObject(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
  return raw;
}

function ids(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || !value.every((item) => typeof item === 'string' && item.length <= 40)) throw new ToolError(`${key} is a list of event ids.`);
  return value as string[];
}

/** Builds the battle-rhythm tools for one run of one staff team. */
export function battleRhythmTools(access: BattleRhythmToolAccess): AgentTool<any>[] {
  const now = access.now ?? Date.now;
  const hostOf = (): StaffHost => {
    const host = access.host();
    if (!host) throw new ToolError('The staff products host is not ready in this window. Reload the window and try again.');
    return host;
  };
  const callerOf = (context: ToolContext): StaffCaller => ({ member: context.agentLabel, run: access.run, root: context.root, team: access.team });
  const rowsOf = async (context: ToolContext, register: string): Promise<{ rows: RegisterRow[]; section: string }> => {
    const read = await hostOf().registerRead(callerOf(context), register);
    if (!read.ok) throw new ToolError(read.message);
    const parsed = JSON.parse(read.text) as { rows: RegisterRow[]; section: string };
    return { rows: parsed.rows, section: parsed.section };
  };
  const words = async (): Promise<string> => {
    const profile = (await hostOf().profileFor(access.team)).profile;
    return `${DOCTRINE_PROFILES[profile].name} names the kinds ${BATTLE_RHYTHM_KINDS.map((kind) => `${kind} (${BATTLE_RHYTHM_NAMES[profile][kind]})`).join(', ')}.`;
  };
  const write = async (context: ToolContext, rows: readonly unknown[], remove: readonly string[]): Promise<string> => {
    const result = await hostOf().registerWrite(callerOf(context), { register: BATTLE_RHYTHM_REGISTER, rows, remove });
    if (!result.ok) throw new ToolError(result.message);
    return result.text;
  };

  const eventsRead: AgentTool<Record<string, never>> = {
    name: battleRhythmToolName('events_read'),
    description: '[battle-rhythm] The battle rhythm calendar: every event with its kind (board, bureau, centre, cell, working group, meeting or brief), start time in UTC, duration, whether it repeats daily or weekly, its owner, attendees, inputs and outputs. It changes nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('events_read', [READS]),
    concurrent: true,
    parse: (raw) => { asObject(raw); return {}; },
    title: () => 'Read the battle rhythm',
    async run(_input, context) {
      const { rows, section } = await rowsOf(context, BATTLE_RHYTHM_REGISTER);
      const sorted = [...rows].sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return [
        `Battle rhythm (${section}): ${sorted.length} event${sorted.length === 1 ? '' : 's'}. ${await words()}`,
        ...sorted.map((row) => `- ${String(row.id)}: ${String(row.title)} (${String(row.kind)}), ${String(row.start)} for ${String(row.durationMinutes)} min, ${String(row.repeat)}; owner ${String(row.chair)}${row.inputs ? `; inputs: ${String(row.inputs)}` : ''}${row.outputs ? `; outputs: ${String(row.outputs)}` : ''}${row.attendees ? `; attendees: ${String(row.attendees)}` : ''}`)
      ].join('\n');
    }
  };

  const eventsWrite: AgentTool<{ rows: unknown[]; remove: string[] }> = {
    name: battleRhythmToolName('events_write'),
    description: '[battle-rhythm] Add or change battle rhythm events (rows: { id, title, kind, start, durationMinutes, repeat, chair, attendees?, inputs?, outputs?, location? }, start in UTC like 2026-11-18T14:00Z, repeat once, daily or weekly) or remove them by id. Only the calendar\'s one writer writes it; anyone else proposes. The new version is a draft for the release guard and a person.',
    parameters: {
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'object' } }, remove: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: manifest('events_write', [READS, WRITES]),
    parse: (raw) => {
      const value = asObject(raw);
      const rows = value.rows ?? [];
      if (!Array.isArray(rows) || rows.length > 500) throw new ToolError('rows is a list of at most 500 events.');
      const remove = ids(value, 'remove');
      if (!rows.length && !remove.length) throw new ToolError('Give rows to add or change, or ids to remove.');
      return { rows, remove };
    },
    title: () => 'Write the battle rhythm',
    async run(input, context) {
      return write(context, input.rows, input.remove);
    }
  };

  const icsExport: AgentTool<{ name: string }> = {
    name: battleRhythmToolName('ics_export'),
    description: `[battle-rhythm] Write the battle rhythm calendar as an iCalendar file (RFC 5545) at ${ICS_EXPORT_DIR}/<name>.ics, which a person can open in a calendar program. Nothing is sent: the file stays in the project.`,
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The file name without .ics: lower case letters, digits and dashes. Default battle-rhythm.' } }, additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: manifest('ics_export', [READS, { verb: 'workspaceWrite', paths: [`${ICS_EXPORT_DIR}/**`] }]),
    parse: (raw) => {
      const value = asObject(raw);
      const name = value.name === undefined ? 'battle-rhythm' : value.name;
      if (typeof name !== 'string' || !STAFF_SLUG.test(name)) throw new ToolError('name is lower case letters, digits and dashes.');
      return { name };
    },
    title: (input) => `Export ${input.name}.ics`,
    async run(input, context) {
      const { rows } = await rowsOf(context, BATTLE_RHYTHM_REGISTER);
      if (!rows.length) throw new ToolError('The battle rhythm has no events yet, so there is nothing to export.');
      const profile = (await hostOf().profileFor(access.team)).profile;
      const text = toIcs(rows, new Date(now()).toISOString(), `${DOCTRINE_PROFILES[profile].name} battle rhythm`);
      const relative = `${ICS_EXPORT_DIR}/${input.name}.ics`;
      const absolute = await resolveInWorkspace(context.root, relative);
      const read = await readWhole(absolute);
      if (read.kind === 'unreadable') throw new ToolError(`${relative} was not read: ${read.reason}. Nothing was written.`);
      await context.checkpoints?.capture(absolute);
      if (!(await writeIfUnchanged(absolute, snapshotOfBytes(read.kind === 'text' ? read.bytes : undefined), text))) throw new ToolError(`${relative} changed while it was being written, so it was not replaced. Export again.`);
      return `${rows.length} event${rows.length === 1 ? '' : 's'} written to ${relative} (${Buffer.byteLength(text, 'utf8')} bytes). It reflects the calendar's current version, whatever its release state.`;
    }
  };

  const icsImport: AgentTool<{ path: string; replace: boolean }> = {
    name: battleRhythmToolName('ics_import'),
    description: `[battle-rhythm] Read an iCalendar (.ics) file a person put in the project into the battle rhythm calendar: each VEVENT with a UTC start, a duration and at most a plain daily or weekly repeat becomes an event (the owner from X-NEAR-AI-OWNER or the organizer's name). The file is untrusted: at most ${MAX_ICS_BYTES / 1024} KB, refused whole if malformed, and its text is returned fenced. Events are merged by id; replace: true also removes events the file does not hold. Only the calendar's writer imports.`,
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'The .ics file in the project.' }, replace: { type: 'boolean' } }, required: ['path'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: manifest('ics_import', [{ verb: 'read', paths: [fromArgument('path'), ...STAFF_HOST_PATHS] }, WRITES]),
    parse: (raw) => {
      const value = asObject(raw);
      if (typeof value.path !== 'string' || !/\.ics$/i.test(value.path.trim())) throw new ToolError('path is an .ics file in the project.');
      if (value.replace !== undefined && typeof value.replace !== 'boolean') throw new ToolError('replace is true or false.');
      return { path: value.path.trim(), replace: value.replace === true };
    },
    title: (input) => `Import ${input.path}`,
    async run(input, context) {
      const absolute = await resolveInWorkspace(context.root, input.path);
      const shown = path.relative(context.root, absolute).split(path.sep).join('/');
      const read = await readWhole(absolute, MAX_ICS_BYTES);
      if (read.kind === 'missing') throw new ToolError(`${shown} is not there.`);
      if (read.kind === 'unreadable') throw new ToolError(`${shown} was not read: ${read.reason.startsWith('it is larger') ? `it is larger than ${MAX_ICS_BYTES / 1024} KB, the most the import reads` : read.reason}. Nothing was changed.`);
      const parsed = parseIcs(read.text, read.bytes.length);
      if (!parsed.ok) throw new ToolError(`${shown}: ${parsed.message} Nothing was changed.`);
      if (!parsed.rows.length) throw new ToolError(`${shown} holds no event the battle rhythm can keep. Nothing was changed.${parsed.problems.length ? `\n${fenceUntrusted(`battle-rhythm: ${shown}`, parsed.problems.join('\n')).text}` : ''}`);
      const existing = input.replace ? (await rowsOf(context, BATTLE_RHYTHM_REGISTER)).rows.map((row) => String(row.id)) : [];
      const keep = new Set(parsed.rows.map((row) => String(row.id)));
      const written = await write(context, parsed.rows, existing.filter((id) => !keep.has(id)));
      const listing = parsed.rows.map((row) => `- ${String(row.id)}: ${String(row.title)} (${String(row.kind)}), ${String(row.start)}, ${String(row.durationMinutes)} min, ${String(row.repeat)}, owner ${String(row.chair)}`);
      return [
        `${parsed.rows.length} event${parsed.rows.length === 1 ? '' : 's'} imported from ${shown}${parsed.skipped ? `; ${parsed.skipped} other component${parsed.skipped === 1 ? '' : 's'} skipped` : ''}${parsed.problems.length ? `; ${parsed.problems.length} event${parsed.problems.length === 1 ? '' : 's'} not imported` : ''}. ${written}`,
        fenceUntrusted(`battle-rhythm: ${shown}`, [...listing, ...parsed.problems.map((problem) => `Not imported: ${problem}`)].join('\n')).text
      ].join('\n');
    }
  };

  const suspense: AgentTool<Record<string, never>> = {
    name: battleRhythmToolName('suspense'),
    description: '[battle-rhythm] What is due: the open RFIs by suspense and the products waiting on a person\'s decision by deadline, each marked overdue when its time has passed. It changes nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('suspense', [READS]),
    concurrent: true,
    parse: (raw) => { asObject(raw); return {}; },
    title: () => 'Suspenses',
    async run(_input, context) {
      const at = now();
      const rfis = (await rowsOf(context, 'rfi-tracker')).rows.filter((row) => row.status === 'open');
      const replay = await hostOf().replay();
      const decisions = [...replay.products.values()].filter((state) => state.record.state === 'awaiting-decision' && !state.tampered);
      const due = [
        ...rfis.map((row) => ({ when: String(row.suspense), text: `RFI ${String(row.id)} from ${String(row.from)} to ${String(row.to)}: ${String(row.question)}` })),
        ...decisions.map((state) => ({ when: state.request?.deadline ?? '', text: `Decision for the ${state.record.decisionFor ?? 'person'}: ${state.record.product} version ${state.record.version}` }))
      ].sort((a, b) => (a.when || '9999').localeCompare(b.when || '9999'));
      if (!due.length) return 'Nothing is due: no open RFI and no product waiting on a decision.';
      return [`${due.length} suspense${due.length === 1 ? '' : 's'}:`, ...due.map((item) => `- ${item.when ? `${item.when}${Date.parse(item.when) < at ? ' (OVERDUE)' : ''}` : 'no deadline'}: ${item.text}`)].join('\n');
    }
  };

  return [eventsRead, eventsWrite, icsExport, icsImport, suspense];
}

/** The battle-rhythm tool names, in order, for the Tools page and the tests. */
export const BATTLE_RHYTHM_TOOL_NAMES: readonly string[] = battleRhythmTools({ host: () => undefined, team: { slug: 'directory', section: 'j3', members: [], sectionLead: '' }, run: 'directory' }).map((tool) => tool.name);
