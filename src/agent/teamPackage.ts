// Sharing a team as one portable file (owner, 2026-11-16: "Should also have option to share the team"). No VS Code imports, so the tests run it
// directly, and nothing here reads or writes a file: the studio does that around these functions.
//
// The file is JSON, named <team>.near-team.json:
//
//   {
//     "format": "near-ai-team",          what the file is
//     "formatVersion": 1,                 a reader refuses a newer version with a plain message instead of guessing
//     "team": { "name", "description", "members", "markdown" },   the team file exactly as Team Studio saves it, plus a summary to check it against
//     "knowledge": null | { ... },        the team's knowledge graph, only when the person chose to include it (off by default), cleaned first
//     "listing": null,                    reserved for a later agent marketplace listing; always null in version 1
//     "integrity": "sha256-<base64>"      a digest of the team text and the knowledge, in the Subresource Integrity form npm lockfiles use
//   }
//
// Drawn from established practice: VS Code profiles (a `.code-profile` export is one file a person sends, and importing shows what it holds before
// anything is applied), the OCI image manifest (an explicit format and schema version, so a reader can refuse what it does not understand), and npm's
// lockfile `integrity` field (the W3C Subresource Integrity "sha256-<base64>" form). The digest only catches a file edited by hand or damaged on the way:
// anyone can recompute it, so it is not a signature. Signing comes later (Phase 69's signer can sign the same bytes as a new format version); until then
// an imported team is untrusted, whatever the file says, and the person is asked before it first runs.
//
// What never goes in: the file's path on this computer, the person's settings, keys or tokens, or anything from the project. A team whose text holds
// something that looks like a key is refused; one whose text names a folder on this computer is shared only after the person agrees; knowledge is
// cleaned of local paths and secrets before it is included, and refused if anything secret-looking is left.
import { createHash } from 'node:crypto';
import { findSecrets } from '../domain/team/secrets';
import { redactSecrets } from '../domain/redaction';
import type { TeamKnowledge } from '../domain/teamKnowledge';
import { parseTeam, type TeamDefinition } from './teams';

export const TEAM_PACKAGE_FORMAT = 'near-ai-team';
export const TEAM_PACKAGE_VERSION = 1;
export const TEAM_PACKAGE_EXTENSION = '.near-team.json';
/** Larger than any team file Team Studio can save with a knowledge graph; anything bigger is refused before it is parsed. */
export const MAX_TEAM_PACKAGE_BYTES = 2 * 1024 * 1024;

export interface TeamPackage {
  format: typeof TEAM_PACKAGE_FORMAT;
  formatVersion: typeof TEAM_PACKAGE_VERSION;
  team: { name: string; description: string; members: number; markdown: string };
  knowledge: TeamKnowledge | null;
  /** Reserved for a listing in the agent marketplace exchange, which is not built. Always null in version 1. */
  listing: null;
  integrity: string;
}

/** What an import shows the person before asking: the team as parsed, and how much knowledge comes with it. */
export interface ReadPackage { markdown: string; team: TeamDefinition; knowledge: TeamKnowledge | null; facts: number }

// ---- local paths ----

/** Absolute paths that point into this computer: home and system folders, Windows drive paths, `~/` and file: URLs. */
const LOCAL_PATH = /(?:file:\/\/\/?[^\s"'`<>)\]]+|(?<![\w.:/])~\/[^\s"'`<>)\]]*|(?<![\w.:/])\/(?:home|Users|root|tmp|var|private|mnt|media|opt|srv|etc|Volumes)\/[^\s"'`<>)\]]*|(?<![\w])[A-Za-z]:\\[^\s"'`<>)\]]*)/g;

/** Every local path in the text, plus the person's own home folder wherever it appears (`home`), each once. */
export function findLocalPaths(text: string, home?: string): string[] {
  const found = new Set<string>(text.match(LOCAL_PATH) ?? []);
  if (home && home.length > 1 && text.includes(home)) found.add(home);
  return [...found];
}

function withoutLocalPaths(text: string, home?: string): string {
  let cleaned = text.replace(LOCAL_PATH, '[a local path]');
  if (home && home.length > 1) cleaned = cleaned.split(home).join('[a local path]');
  return cleaned;
}

// ---- export ----

/** Where in a team something to worry about was found, named the way the person sees the team (never the matched text). */
function placesIn(team: TeamDefinition, test: (text: string) => boolean): string[] {
  const places: string[] = [];
  if (test(team.name)) places.push('the team name');
  if (test(team.description)) places.push('the description');
  for (const member of team.members) if (test([member.name, member.role ?? '', member.model ?? '', member.instructions].join('\n'))) places.push(`member ${member.name}`);
  return places;
}

const secretLooking = (text: string) => findSecrets(text).length > 0;

/**
 * What stands in the way of sharing this team file: `refused` when it holds something that looks like a key or password (said with where, never what),
 * and `paths` when it names folders on this computer, which the person may agree to share.
 */
export function shareProblems(markdown: string, file: string, home?: string): { refused?: string; paths: string[] } {
  const team = parseTeam(markdown, file);
  const secretPlaces = placesIn(team, secretLooking);
  // The frontmatter can carry lines Team Studio keeps but does not show, so the whole text is checked too.
  if (secretPlaces.length || secretLooking(markdown)) {
    return { refused: `This team can't be shared: ${secretPlaces.length ? secretPlaces.join(', ') : 'its file'} ${secretPlaces.length === 1 ? 'holds' : 'hold'} something that looks like a key, token or password. Remove it from the team, then share again.`, paths: [] };
  }
  const pathPlaces = placesIn(team, (text) => findLocalPaths(text, home).length > 0);
  if (!pathPlaces.length && findLocalPaths(markdown, home).length) pathPlaces.push('its file');
  return { paths: pathPlaces };
}

/**
 * The knowledge graph as it may leave this computer: every source that is not a web address is dropped, local paths in any text are replaced, and
 * secret-looking values are redacted. Undefined when something secret-looking would still be left, so the caller shares without it.
 */
export function cleanKnowledge(knowledge: TeamKnowledge, home?: string): TeamKnowledge | undefined {
  const { problem: _problem, unreadable: _unreadable, ...stored } = knowledge;
  const clean = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'source') return /^https?:\/\/[^\s]+$/i.test(value) && !findLocalPaths(value, home).length ? redactSecrets(value) : undefined;
      return redactSecrets(withoutLocalPaths(value, home));
    }
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(value)) {
        const cleaned = clean(entry, name);
        if (cleaned !== undefined) out[name] = cleaned;
      }
      return out;
    }
    return value;
  };
  const result = clean(stored) as TeamKnowledge;
  return findSecrets(result).length ? undefined : result;
}

function integrityOf(markdown: string, knowledge: TeamKnowledge | null): string {
  return `sha256-${createHash('sha256').update(JSON.stringify([markdown, knowledge])).digest('base64')}`;
}

/** The share file for a team, as text. `knowledge` must already be cleaned (cleanKnowledge) and is included only when given. */
export function buildTeamPackage(markdown: string, file: string, knowledge?: TeamKnowledge): string {
  const team = parseTeam(markdown, file);
  const included = knowledge ?? null;
  const pkg: TeamPackage = {
    format: TEAM_PACKAGE_FORMAT,
    formatVersion: TEAM_PACKAGE_VERSION,
    team: { name: team.name, description: team.description, members: team.members.length, markdown },
    knowledge: included,
    listing: null,
    integrity: integrityOf(markdown, included)
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ---- import ----

export class TeamPackageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TeamPackageError';
  }
}

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const NOT_A_TEAM = 'This file is not a NEAR AI team. Ask for the file again, or for the team\'s .md file.';
const DAMAGED = 'This team file was changed or damaged after it was shared, so it was not imported. Ask for the file again.';

// The stored shape of a knowledge graph, checked all the way down (PR #67 review: only the top level was checked, so `nodes: [null]` passed and then failed
// with a raw TypeError, and the malformed graph was written). Every node, fact and edge must have exactly the fields the graph stores, of the right type
// and within these sizes; anything else refuses the whole file.
const NODE_KINDS = ['actor', 'person', 'organisation', 'system', 'document', 'fact', 'place', 'product', 'event'];
const EDGE_KINDS = ['supplies', 'certifies', 'regulates', 'funds', 'employs', 'partners', 'competes', 'depends-on', 'contradicts', 'supports', 'owns', 'reports-to', 'related'];
const ORIGINS = ['research', 'interaction', 'document', 'seed'];
const MAX_NODES = 5_000;
const MAX_EDGES = 20_000;
const MAX_FACTS = 500;
const SHORT = 400;
const LONG = 8_000;

const str = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const only = (value: Plain, required: string[], allowed: string[]): boolean => required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || allowed.includes(key));
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function gradingShape(value: unknown): boolean {
  return isPlain(value) && only(value, ['reliability', 'credibility'], []) && typeof value.reliability === 'string' && /^[A-F]$/.test(value.reliability) && typeof value.credibility === 'number' && Number.isInteger(value.credibility) && value.credibility >= 1 && value.credibility <= 6;
}

function factShape(value: unknown): boolean {
  return isPlain(value) && only(value, ['text', 'origin'], ['grading', 'source', 'since', 'refutedBy', 'refutedAt'])
    && str(value.text, LONG) && ORIGINS.includes(value.origin as string) && optional(value.grading, gradingShape)
    && optional(value.source, (entry) => str(entry, LONG)) && optional(value.since, (entry) => str(entry, SHORT)) && optional(value.refutedBy, (entry) => str(entry, LONG)) && optional(value.refutedAt, (entry) => str(entry, SHORT));
}

const facts = (value: unknown): boolean => Array.isArray(value) && value.length <= MAX_FACTS && value.every(factShape);

function nodeShape(value: unknown): boolean {
  return isPlain(value) && only(value, ['id', 'label', 'kind', 'functions', 'facts', 'origin', 'firstSeen', 'lastSeen', 'mentions'], ['history', 'grading'])
    && str(value.id, SHORT) && str(value.label, SHORT) && NODE_KINDS.includes(value.kind as string)
    && Array.isArray(value.functions) && value.functions.length <= MAX_FACTS && value.functions.every((entry) => str(entry, SHORT))
    && facts(value.facts) && optional(value.history, facts) && ORIGINS.includes(value.origin as string) && optional(value.grading, gradingShape)
    && str(value.firstSeen, SHORT) && str(value.lastSeen, SHORT) && count(value.mentions);
}

function edgeShape(value: unknown): boolean {
  return isPlain(value) && only(value, ['id', 'from', 'to', 'kind', 'tension', 'origin', 'lastSeen', 'mentions'], ['basis', 'grading'])
    && str(value.id, SHORT) && str(value.from, SHORT) && str(value.to, SHORT) && EDGE_KINDS.includes(value.kind as string)
    && (value.tension === null || (typeof value.tension === 'number' && Number.isFinite(value.tension) && value.tension >= -1 && value.tension <= 1))
    && optional(value.basis, (entry) => str(entry, LONG)) && ORIGINS.includes(value.origin as string) && optional(value.grading, gradingShape)
    && str(value.lastSeen, SHORT) && count(value.mentions);
}

function knowledgeShape(value: unknown): value is TeamKnowledge {
  return isPlain(value) && only(value, ['version', 'team', 'nodes', 'edges', 'updatedAt'], []) && value.version === 1 && str(value.team, SHORT) && str(value.updatedAt, SHORT)
    && Array.isArray(value.nodes) && value.nodes.length <= MAX_NODES && value.nodes.every(nodeShape)
    && Array.isArray(value.edges) && value.edges.length <= MAX_EDGES && value.edges.every(edgeShape);
}

/**
 * Reads a share file, refusing with a plain message (TeamPackageError) anything that is not exactly a version 1 team package whose digest, summary and
 * team text agree, and any team text holding something that looks like a key. Never trusts the file: a package that reads cleanly is still untrusted.
 */
export function readTeamPackage(text: string): ReadPackage {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEAM_PACKAGE_BYTES) throw new TeamPackageError('This file is too large to be a NEAR AI team, so it was not imported.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TeamPackageError(NOT_A_TEAM); }
  if (!isPlain(value) || value.format !== TEAM_PACKAGE_FORMAT) throw new TeamPackageError(NOT_A_TEAM);
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) throw new TeamPackageError(NOT_A_TEAM);
  if (value.formatVersion > TEAM_PACKAGE_VERSION) throw new TeamPackageError('This team was shared from a newer version of NEAR AI. Update the extension, then import it again.');
  if (value.formatVersion !== TEAM_PACKAGE_VERSION) throw new TeamPackageError(NOT_A_TEAM);
  const keys = ['format', 'formatVersion', 'team', 'knowledge', 'listing', 'integrity'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) throw new TeamPackageError(DAMAGED);
  const team = value.team;
  if (!isPlain(team) || Object.keys(team).sort().join() !== 'description,markdown,members,name' || typeof team.markdown !== 'string' || typeof team.name !== 'string' || typeof team.description !== 'string' || typeof team.members !== 'number') throw new TeamPackageError(DAMAGED);
  if (value.listing !== null) throw new TeamPackageError(DAMAGED);
  if (value.knowledge !== null && !knowledgeShape(value.knowledge)) throw new TeamPackageError(DAMAGED);
  const knowledge = value.knowledge as TeamKnowledge | null;
  if (typeof value.integrity !== 'string' || value.integrity !== integrityOf(team.markdown, knowledge)) throw new TeamPackageError(DAMAGED);
  let parsed: TeamDefinition;
  try { parsed = parseTeam(team.markdown, 'imported.md'); } catch (error) { throw new TeamPackageError(`This team file can't be used: ${(error as Error).message}`); }
  if (parsed.name !== team.name || parsed.description !== team.description || parsed.members.length !== team.members) throw new TeamPackageError(DAMAGED);
  if (findSecrets(team.markdown).length || (knowledge && findSecrets(knowledge).length)) throw new TeamPackageError('This team file holds something that looks like a key, token or password, so it was not imported. Ask the sender to remove it and share the team again.');
  const factCount = knowledge ? knowledge.nodes.reduce((total, node) => total + node.facts.length, 0) : 0;
  return { markdown: team.markdown, team: parsed, knowledge, facts: factCount };
}

/** A plain team .md file brought in with Import team: the same checks a share file's team text gets. */
export function readTeamMarkdown(text: string): ReadPackage {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEAM_PACKAGE_BYTES) throw new TeamPackageError('This file is too large to be a NEAR AI team, so it was not imported.');
  let parsed: TeamDefinition;
  try { parsed = parseTeam(text, 'imported.md'); } catch (error) { throw new TeamPackageError(`This team file can't be used: ${(error as Error).message}`); }
  if (findSecrets(text).length) throw new TeamPackageError('This team file holds something that looks like a key, token or password, so it was not imported. Remove it and import the file again.');
  return { markdown: text, team: parsed, knowledge: null, facts: 0 };
}

/** One line per member, made plain and capped, for the question asked before an import or the first run of an imported team. */
export function memberSummary(team: TeamDefinition): string {
  const plain = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
  const shown = team.members.slice(0, 12).map((member) => {
    const tools = member.tools.length > 6 ? `${member.tools.slice(0, 6).join(', ')} and ${member.tools.length - 6} more` : member.tools.join(', ');
    return `${plain(member.name, 40)}${member.role ? ` (${plain(member.role, 60)})` : ''}${member.model ? `, model ${plain(member.model, 60)}` : ''}, tools: ${plain(tools, 200)}`;
  });
  return shown.join('; ');
}

/** The question asked before an import adds a team to the person's teams. */
export function importQuestion(read: ReadPackage): string {
  const team = read.team;
  const plain = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);
  return `Add the team "${plain(team.name, 80)}" to your teams?${team.description ? ` ${plain(team.description, 200)}.` : ''} ${team.members.length} member${team.members.length === 1 ? '' : 's'}: ${memberSummary(team)}.${read.facts ? ` It comes with a knowledge graph of ${read.facts} fact${read.facts === 1 ? '' : 's'}.` : ''} It stays untrusted: the first time it runs you are asked to approve it.`;
}
