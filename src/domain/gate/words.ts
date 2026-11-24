// Plain words for a manifest (GATE-03, D-07): the one place a manifest becomes sentences, so the Tools page, the member cards and the gate read the
// same declaration and never disagree. Pure: no I/O, no clock, no vscode, no package. The order is fixed: where it runs, then what it can do in the
// vocabulary's verb order, then the sites it reaches (sorted), then whether it may run when nobody is watching. An MCP manifest's words always end
// with the sentence that says the manifest is a claim.
import type { GateContextName } from './bundle';
import { defaultMcpContexts, isCommandEffect } from './manifest';
import type { EffectTemplate, McpManifest, McpToolEntry, McpTransport, ToolManifest } from './manifest';
import { CAPABILITY_VERBS } from './vocabulary';
import type { CapabilityVerb } from './vocabulary';

export const RUNS_ON_THIS_MACHINE_TEXT = 'Runs on this machine with your permissions';
/**
 * What is said when a declaration lists nothing the words can describe. It is the sentence for what the gate does with such a call (`manifest.effects-unknown`):
 * with a person here it asks, with nobody here it refuses.
 */
export const EFFECTS_NOT_DECLARED_TEXT = 'What it does is not declared, so each call asks first, or is refused when nobody is there';
export const MANIFEST_IS_A_CLAIM_TEXT = 'This is what you or the server declared it does. SovAI cannot check what a server does inside itself.';

const RUNS_ELSEWHERE = 'Runs on another machine';
const READS_FILES = 'Reads files in this project';
const CHANGES_FILES = 'Can change files in this project';
const CHANGES_NOTHING = 'Changes nothing outside this run';
const RUNS_COMMANDS = 'Runs commands in a terminal';
const DELETES_FILES = 'Can delete files';
const STARTS_AGENTS = 'Starts other agents';
const SCHEDULES_RUNS = 'Can schedule work to run later';
const SPENDS_MONEY = 'Can spend money on your account';
const ASKS_A_MODEL = 'Asks a model';
const USES_A_GPU = 'Uses a GPU';
const SITES_NAMED_IN_CALL = 'Connects to sites named in each call';
const ANY_SITE = 'any site';
const ONLY_WHILE_YOU_ARE_THERE = 'Runs only while you are there';
const ALSO_UNATTENDED = 'Can also run when nobody is watching';
const CALLS_TOOLS_ON_THIS_SERVER = 'Calls tools on this server';
const FOLLOWS_APPROVAL_SETTING = 'Whether it asks first follows the approval setting you chose for this server';
const UNLISTED_ARE_RESTRICTED =
  'Tools it does not list are treated as able to run commands, reach any site and change or delete files, and they never run when nobody is watching';
const MAX_NAME_WORDS = 60;
const CONTROL_OR_DASH = /[\u0000-\u001F\u007F\u2014]/g;

const PUBLISH_WORDS: ReadonlyMap<string, string> = new Map([
  ['git-remote', 'a git remote'],
  ['registry', 'a package registry'],
  ['container-registry', 'a container registry'],
  ['release', 'a release'],
  ['deploy', 'a deployment'],
  ['chain', 'a blockchain'],
  ['*', 'anywhere']
]);

const SKILL_WORDS: ReadonlyMap<string, string> = new Map([
  ['run', 'Can write skills that last only for this run'],
  ['project', 'Can change skills in this project'],
  ['user', 'Can change your own skills'],
  ['team', 'Can change skills your whole team shares']
]);

/** Any effect, a template or a capability: only its verb and the plain strings of its fields are read here. */
interface EffectLike { readonly verb: CapabilityVerb }

/** A name that came from a configuration or a server is shown as plain text: control characters and the long dash are replaced and the length is capped. */
function plain(name: string): string {
  const cleaned = name.replace(CONTROL_OR_DASH, ' ').trim();
  return cleaned.length > MAX_NAME_WORDS ? `${cleaned.slice(0, MAX_NAME_WORDS)}...` : cleaned;
}

function fieldOf(effect: EffectLike, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(effect, key) ? Reflect.get(effect, key) : undefined;
}

/** The plain strings a field holds: a string, or the strings in a list. A value filled from the call is not a string and is left out. */
function stringsOf(effect: EffectLike, key: string): string[] {
  const value = fieldOf(effect, key);
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** The hosts sentence, or nothing. A `*` anywhere means any site. */
function hostLine(hosts: readonly string[]): string[] {
  const all = sortedUnique(hosts);
  if (all.length === 0) return [];
  return [`Connects to ${all.includes('*') ? ANY_SITE : all.map(plain).join(', ')}`];
}

function listOf(prefix: string, names: readonly string[]): string[] {
  const all = sortedUnique(names).map(plain);
  return all.length === 0 ? [] : [`${prefix} ${all.join(', ')}`];
}

function skillLines(effects: readonly EffectLike[]): string[] {
  const lines: string[] = [];
  for (const scope of sortedUnique(effects.flatMap((effect) => stringsOf(effect, 'scope')))) {
    const sentence = SKILL_WORDS.get(scope);
    if (sentence !== undefined) lines.push(sentence);
  }
  return lines;
}

function publishTargets(effects: readonly EffectLike[]): string[] {
  return effects.flatMap((effect) => stringsOf(effect, 'target')).map((target) => PUBLISH_WORDS.get(target) ?? target);
}

/** The sentences for one verb, from every effect of that verb. The `network` effect is covered by the hosts sentence unless no host is known. */
function verbLines(verb: CapabilityVerb, effects: readonly EffectLike[], hostsKnown: boolean): string[] {
  switch (verb) {
    case 'read': return [READS_FILES];
    case 'plan': return [CHANGES_NOTHING];
    case 'workspaceWrite': return [CHANGES_FILES];
    case 'shell': return [RUNS_COMMANDS];
    case 'network': return hostsKnown ? [] : [SITES_NAMED_IN_CALL];
    case 'mcp': return listOf('Calls tools on', effects.flatMap((effect) => stringsOf(effect, 'server')));
    case 'send': return listOf('Sends messages to', effects.flatMap((effect) => stringsOf(effect, 'channel')));
    case 'publish': return listOf('Can publish to', publishTargets(effects));
    case 'destroy': return [DELETES_FILES];
    case 'spawn': return [STARTS_AGENTS];
    case 'schedule': return [SCHEDULES_RUNS];
    case 'skill.write': return skillLines(effects);
    case 'spend': return [SPENDS_MONEY];
    case 'useSecret': return [];
    case 'infer': return [ASKS_A_MODEL];
    case 'gpu': return [USES_A_GPU];
  }
}

/** One sentence per credential handle the manifest names or an effect uses, sorted. */
function credentialLines(effects: readonly EffectLike[], declared: readonly string[]): string[] {
  const used = effects.filter((effect) => effect.verb === 'useSecret').flatMap((effect) => stringsOf(effect, 'handle'));
  return sortedUnique([...declared, ...used]).map((handle) => `Uses the stored credential ${plain(handle)}`);
}

/** The effect sentences in the vocabulary's verb order. `skipVerbs` lets a caller that writes its own sentence for a verb (the MCP server line) leave it out. */
function effectLines(effects: readonly EffectLike[], hostsKnown: boolean, credentials: readonly string[], skipVerbs: readonly CapabilityVerb[] = []): string[] {
  const lines: string[] = [];
  for (const verb of CAPABILITY_VERBS) {
    if (skipVerbs.includes(verb)) continue;
    if (verb === 'useSecret') {
      lines.push(...credentialLines(effects, credentials));
      continue;
    }
    const ofVerb = effects.filter((effect) => effect.verb === verb);
    if (ofVerb.length > 0) lines.push(...verbLines(verb, ofVerb, hostsKnown));
  }
  return lines;
}

/** The contexts sentence. Any context other than `interactive` is a run with nobody there to answer, so the person is told it can run unattended. */
export function contextLine(contexts: readonly GateContextName[]): string {
  return contexts.some((context) => context !== 'interactive') ? ALSO_UNATTENDED : ONLY_WHILE_YOU_ARE_THERE;
}

function literalHosts(effects: readonly EffectLike[]): string[] {
  return effects.filter((effect) => effect.verb === 'network').flatMap((effect) => stringsOf(effect, 'hosts'));
}

/** The manifest of one tool as plain sentences in the fixed order. */
export function describeManifest(manifest: ToolManifest): string[] {
  const effects = manifest.effects.filter((entry): entry is EffectTemplate => !isCommandEffect(entry));
  const hosts = [...manifest.hosts, ...literalHosts(effects)];
  const lines: string[] = [];
  if (manifest.runsOn === 'remote') lines.push(RUNS_ELSEWHERE);
  else if (effects.some((effect) => effect.verb === 'shell')) lines.push(RUNS_ON_THIS_MACHINE_TEXT);
  // A manifest with no effect of its own (only the command marker) is one the gate cannot read either: it says so, as it does for an undeclared MCP tool.
  lines.push(...(effects.length === 0 ? [EFFECTS_NOT_DECLARED_TEXT] : effectLines(effects, hosts.length > 0, manifest.credentials)));
  lines.push(...hostLine(hosts));
  lines.push(contextLine(manifest.contexts));
  return lines;
}

/**
 * An MCP server's manifest as plain sentences, or the sentences for a server with no manifest (configured before manifests existed). A stdio server always
 * leads with where it runs, because it is a program on this machine with the person's own permissions. The last sentence is always MANIFEST_IS_A_CLAIM_TEXT.
 */
export function describeMcpManifest(manifest: McpManifest | undefined, transport: McpTransport, host: string): string[] {
  const lines: string[] = [];
  lines.push(transport === 'stdio' || manifest?.runsOn === 'this-machine' ? RUNS_ON_THIS_MACHINE_TEXT : RUNS_ELSEWHERE);
  lines.push(manifest === undefined ? CALLS_TOOLS_ON_THIS_SERVER : `Calls tools on ${plain(manifest.server)}`);
  const declared: EffectLike[] = manifest === undefined ? [] : Object.values(manifest.tools).flatMap((entry) => entry.effects);
  const named = host.trim().toLowerCase();
  const hosts = [...(manifest?.hosts ?? []), ...literalHosts(declared), ...(named === '' ? [] : [named])];
  lines.push(...effectLines(declared, hosts.length > 0, manifest?.credentials ?? [], ['mcp']));
  lines.push(manifest !== undefined && manifest.toolDefaults === 'restrictive' ? UNLISTED_ARE_RESTRICTED : FOLLOWS_APPROVAL_SETTING);
  lines.push(...hostLine(hosts));
  lines.push(contextLine(manifest?.contexts ?? defaultMcpContexts(transport)));
  lines.push(MANIFEST_IS_A_CLAIM_TEXT);
  return lines;
}

/** What a person can say one MCP tool does. `custom` is a declaration made some other way (a hand-edited manifest); `unknown` is no declaration at all. */
export type McpToolChoice = 'reads' | 'changes-remote' | 'unknown' | 'custom';

/** Which of the page's choices a declared tool's entry is: only the call itself is `reads`; the call plus network is `changes-remote`; anything else is `custom`. */
export function mcpToolChoiceOf(entry: McpToolEntry | undefined): McpToolChoice {
  if (entry === undefined) return 'unknown';
  const verbs = entry.effects.map((effect) => effect.verb);
  if (verbs.length > 0 && verbs.every((verb) => verb === 'mcp')) return 'reads';
  if (verbs.length > 0 && verbs.every((verb) => verb === 'mcp' || verb === 'network') && verbs.includes('network')) return 'changes-remote';
  return 'custom';
}

const DECLARED_READS = 'Only reads';
const DECLARED_CHANGES = 'Changes data on the server';

/**
 * One line per tool the manifest declares, by tool name in sorted order, each with what it was declared to do (effects in the vocabulary's verb order). A tool the
 * manifest does not list has no line here; the server's own sentence says how those are treated.
 */
export function describeMcpTools(manifest: McpManifest | undefined): string[] {
  if (manifest === undefined) return [];
  const lines: string[] = [];
  for (const name of Object.keys(manifest.tools).sort()) {
    const entry = manifest.tools[name];
    if (entry === undefined) continue;
    const choice = mcpToolChoiceOf(entry);
    const hosts = literalHosts(entry.effects);
    const said = choice === 'reads' ? [DECLARED_READS] : choice === 'changes-remote' ? [DECLARED_CHANGES] : [...effectLines(entry.effects, hosts.length > 0, [], ['mcp']), ...hostLine(hosts)];
    // A declaration the words cannot describe is never "Only reads": the gate treats a call it cannot read as effects unknown, and the words say so too.
    const parts = said.length > 0 ? said : [EFFECTS_NOT_DECLARED_TEXT];
    if (entry.contexts !== undefined) parts.push(contextLine(entry.contexts));
    lines.push(`${plain(name)}: ${parts.join('; ')}`);
  }
  return lines;
}
