import type { ActionCapability, ActionPolicy, ActionPolicyMode } from '../domain/policy';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { decidePermission, PermissionRules, RunGrants } from '../agent/permissions';
import { AgentTool } from '../agent/tools';
import { builtInTools, GSD_TOOL_NAMES } from '../agent/toolCatalog';
import { builtInStaffServers } from '../agent/staffServers';
import { describeManifest } from '../domain/gate/words';
import { GsdAgent, GsdSkill, modelForTier, roleModelFor } from '../gsd/library';
import type { TeamDefinition } from '../agent/teams';
import type { McpServerStatus } from './mcpRegistry';
import { MODEL_ROW_TEXT, catalogRows } from '../domain/gate/modelRow';
import { modelRowContext } from './chatBridge';
import { mcpToolCapability, mcpToolName } from '../mcp/tools';
import type { ModelInfo, NearAiClient } from './nearAiClient';
import { POLICY_OPTIONS } from './approvalPolicy';
import { ReportingTokenHint, SET_REPORTING_TOKEN_COMMAND } from './reportingToken';

// The SovAI Tools page: a read-mostly directory of what the agents can use. Everything here is
// computed from the same sources a run uses (the installed Open-GSD library, team files, the
// built-in tool objects, the permission logic, the MCP registry, and the model catalog), so the
// page cannot drift from what actually happens. No VS Code imports, so the tests run it directly.

export type ToolStatus = 'runs' | 'asks' | 'auto-checked' | 'off' | 'stopped';

export interface DirectorySkill { name: string; description: string; argumentHint?: string; group: string; insert: string }
export interface DirectoryAgent { name: string; description: string; tier: string; model: string; source: 'role setting' | 'project choice' | 'definition' | 'default'; tools: string[] }
export interface DirectoryTeam { name: string; description: string; command: string; insert: string; project: boolean; members: Array<{ name: string; role?: string; tier: string; model: string; tools: string[] }> }
export interface DirectoryTool { name: string; description: string; capability: string; status: ToolStatus; statusText: string; notes: string[]; /** What the tool's manifest says it can do, in plain words (also the last of `notes`): the team member cards show these. */ words: string[]; setup?: { label: string; command: string }; /** 0.4.17: the tool runs in Auto by its own marker (the web tools). */ autoSafe?: boolean; /** The built-in staff server this catalog tool belongs to (staff-products, guard-scan): the Tools page shows it once, under that server. */ staffServer?: string }
export interface DirectoryMcpServer { id: string; name: string; transport: string; host: string; words: string[]; enabledHere: boolean; state: string; error?: string; approval: string; tools: Array<{ name: string; agentName: string; description: string; enabled: boolean; status: ToolStatus; statusText: string }> }
/** A built-in staff server (staff-products, guard-scan, intel-workbench, observations, logistics): given only to a staff team's run, granted by `grant` or tool by tool. */
export interface DirectoryStaffServer { id: string; grant: string; name: string; description: string; tools: DirectoryTool[] }
export interface DirectoryModel { id: string; privacy: 'tee' | 'local' | 'forwarded' | 'unknown'; privacyText: string; /** 74.1 D-21 (S5): Runs on, origin, family, approval, from the picker's helper. */ facts: string; contextLength?: number; inputPerMillion?: number; outputPerMillion?: number; imagePrice?: number; kinds: string[]; usedFor: string[] }

export interface ToolsDirectory {
  gsd: { installed: boolean; version?: string };
  policy: { mode: ActionPolicyMode; label: string; summary: string; stopped: boolean };
  skills: DirectorySkill[];
  agents: DirectoryAgent[];
  teams: DirectoryTeam[];
  teamProblems: string[];
  tools: DirectoryTool[];
  /** The built-in staff servers, listed apart from the tools every run gets: only a staff team's members can be given them. */
  staffServers: DirectoryStaffServer[];
  mcp: DirectoryMcpServer[];
  models: DirectoryModel[];
  modelsProblem?: string;
  settingsModels: Array<{ use: string; setting: string; model: string; available: boolean | undefined; /** Shown when the model comes from the project's choice rather than the person's settings. */ source?: 'project choice' }>;
  /** The Elsewhere row for NEAR's usage reporting token; `command` is a page command or `setting:<key>`. */
  reportingToken?: { state: ReportingTokenHint['state']; text: string; title: string; command: string };
}

export interface DirectoryInput {
  /** Installed Open-GSD skills and agents; undefined before the first install. */
  gsd?: { skills: Pick<GsdSkill, 'name' | 'description' | 'argumentHint'>[]; agents: Pick<GsdAgent, 'name' | 'description' | 'tools' | 'model'>[]; version?: string };
  teams: Array<{ team?: TeamDefinition; file: string; error?: string; project: boolean }>;
  policy: ActionPolicy;
  rules: PermissionRules;
  /** Whether a web search provider is configured (WebSearch is off without one). */
  webSearch: boolean;
  /** The host that provider sends queries to, for the words under WebSearch; without it the page says the tool reaches nothing. */
  webSearchHost?: string;
  /** The host the active profile sends model requests to, for the words under GenerateImage (the default endpoint's host when absent). */
  modelHost?: string;
  /** Whether this project allowed the dependency scanner. */
  securityConsented: boolean;
  mcp: McpServerStatus[];
  /** The key's model catalog; undefined when no validated profile, or it could not load. */
  models?: ModelInfo[];
  modelsProblem?: string;
  settings: { mainModel: string; tiers: { deep: string; standard: string; fast: string }; roleModels: Record<string, string>; visionModel: string; transcriptionModel: string; imageModel: string; safetyModel: string; /** Setting names (nearAi.agent.deepModel, ...) whose value comes from the project's choice (D-06). */ fromProject?: string[] };
  /** Whether a usage reporting token is set (from the host's secret storage; never the token). */
  reportingToken?: ReportingTokenHint;
}

const CAPABILITY_LABEL: Record<ActionCapability, string> = {
  read: 'read', plan: 'plan', workspaceWrite: 'edit', sharedWrite: 'learn', shell: 'shell', network: 'network', gitMutation: 'git', mediaGeneration: 'generate', mediaPublication: 'publish'
};

/** Groups for the skills list, by the words a skill's name is made of (nothing per-command is hard-coded). */
const SKILL_GROUPS: Array<{ group: string; words: RegExp }> = [
  { group: 'Project lifecycle', words: /\b(?:new-project|onboard|milestone|cleanup|import|ingest|pause|resume|undo|ship|pr-branch)\b/ },
  { group: 'Review and quality', words: /\b(?:review|audit|verify|validate|secure|security|eval|forensics|debug|health|add-tests|uat)\b/ },
  { group: 'Planning', words: /\b(?:discuss|plan|spec|phase|roadmap|mvp|ultraplan|ui-phase|convergence)\b/ },
  { group: 'Execution', words: /\b(?:execute|quick|fast|autonomous|next|progress|manager|batch|fix)\b/ },
  { group: 'Research and context', words: /\b(?:research|explore|spike|sketch|map|graphify|docs|intel|learnings|mempalace|capture|thread|profile|context|ideate)\b/ },
  { group: 'Settings and workspace', words: /\b(?:settings|config|update|workspace|workstreams|stats|surface|help|inbox|manage)\b/ }
];
const CATEGORY_GROUP: Record<string, string> = { Start: 'Project lifecycle', Workflow: 'Execution', Context: 'Research and context', Review: 'Review and quality', Manage: 'Settings and workspace' };
export const SKILL_GROUP_ORDER = ['Project lifecycle', 'Planning', 'Execution', 'Review and quality', 'Research and context', 'Settings and workspace', 'Other'];

export function skillGroup(name: string): string {
  const words = name.replace(/^gsd-(?:ns-)?/, '').replace(/[:_]/g, '-');
  const parts = words.split('-');
  // The leading verb decides first ("execute-phase" is execution, "plan-phase" planning), then the whole name, then any word.
  const match = (text: string) => SKILL_GROUPS.find((entry) => entry.words.test(text));
  return (match(parts[0]) ?? match(words) ?? parts.slice(1).map(match).find(Boolean))?.group ?? 'Other';
}

/** What the permission logic does for this capability under the policy, with no grants yet in the run. `autoSafe` is the tool's own marker (0.4.17). */
export function capabilityStatus(capability: ActionCapability, policy: ActionPolicy, rules: PermissionRules, autoSafe = false): ToolStatus {
  const decided = decidePermission(capability, undefined, policy, rules, new RunGrants(), { root: '', cwd: '', autoSafeTool: autoSafe });
  if (decided.decision === 'deny') return 'stopped';
  if (decided.decision === 'allow') return 'runs';
  // In auto mode a shell command goes through the safety check rather than straight to you.
  return capability === 'shell' && policy.mode === 'auto' ? 'auto-checked' : 'asks';
}

export const STATUS_TEXT: Record<ToolStatus, string> = {
  runs: 'Runs without asking',
  asks: 'Asks you first',
  'auto-checked': 'Checked: safe commands run, risky or unclear ones ask',
  off: 'Off in this project',
  stopped: 'Blocked: emergency stop is on'
};

export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  // A period after an abbreviation such as "e.g." doesn't end the sentence.
  const end = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = end.exec(clean))) {
    const sentence = clean.slice(0, match.index + 1);
    if (sentence.length >= 20 && !/\b(?:e\.g|i\.e|etc|vs|cf)\.$/i.test(sentence)) return sentence.slice(0, 240);
  }
  return clean.slice(0, 240);
}

function tierOf(value: string | undefined): string {
  // The real tier mapping, run against markers, says which tier a value lands on.
  const marker = modelForTier(value, { deep: '\u0000deep', standard: '\u0000standard', fast: '\u0000fast' }, '\u0000inherit');
  return marker.startsWith('\u0000') ? marker.slice(1) : 'model';
}

export function resolveAgentModel(name: string, definitionModel: string | undefined, input: DirectoryInput, teamMember: boolean): { tier: string; model: string; source: DirectoryAgent['source'] } {
  // The same order a run uses: a team member's own model line wins; then the role's setting; then the definition.
  const roleModel = teamMember && definitionModel ? undefined : roleModelFor(name, input.settings.roleModels);
  const value = roleModel ?? definitionModel;
  return { tier: tierOf(value), model: modelForTier(value, input.settings.tiers, input.settings.mainModel), source: roleModel ? (input.settings.fromProject?.includes('nearAi.agent.roleModels') ? 'project choice' : 'role setting') : definitionModel ? 'definition' : 'default' };
}


function toolEntry(tool: AgentTool<any>, input: DirectoryInput, available: { off?: string; setup?: { label: string; command: string } } = {}): DirectoryTool {
  // A tool that marks itself autoSafe (the web tools) runs in auto; an MCP tool never sets the marker, so it keeps asking.
  const status: ToolStatus = available.off && !input.policy.emergencyStop ? 'off' : capabilityStatus(tool.capability, input.policy, input.rules, tool.autoSafe === true);
  const notes: string[] = [];
  if (available.off) notes.push(available.off);
  if (tool.capability === 'shell' && tool.name === 'Bash' && input.rules.allowCommands.length && status !== 'runs' && status !== 'stopped') notes.push(`Allow-listed commands run without asking: ${input.rules.allowCommands.slice(0, 8).join(', ')}${input.rules.allowCommands.length > 8 ? ', …' : ''}.`);
  if (tool.sensitive) notes.push('Some paths always ask first (files that look like credentials, or protected locations).');
  if (tool.risky) notes.push('Can ask in any mode once the run has read outside content.');
  if (tool.untrusted) notes.push('Its results are outside content.');
  // What the tool declares it can do, in plain words (GATE-03, D-07): the same sentences the gate and the member cards use, after today's notes.
  const words = tool.manifest ? describeManifest(tool.manifest) : [];
  notes.push(...words);
  return {
    name: tool.name, description: firstSentence(tool.description), capability: CAPABILITY_LABEL[tool.capability], status, statusText: STATUS_TEXT[status], notes, words,
    ...(available.setup ? { setup: available.setup } : {}), ...(tool.autoSafe === true ? { autoSafe: true } : {})
  };
}

export function privacyOf(model: ModelInfo): DirectoryModel['privacy'] {
  return model.privacyBoundary === 'tee' ? 'tee' : model.privacyBoundary === 'local' ? 'local' : model.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown';
}

/** Where a model runs, in the Runs on words (74.1 D-21, design 8.6): no bare "Private" and no glossary word. */
export const PRIVACY_TEXT: Record<DirectoryModel['privacy'], string> = { tee: `Runs on ${MODEL_ROW_TEXT.nearPlace}`, local: 'Runs on this computer', forwarded: 'Runs on an outside provider', unknown: 'Runs on a place your rules do not name' };

/** Builds the whole directory from what the host gathered. Pure: no I/O, no model calls. */
export function buildToolsDirectory(input: DirectoryInput): ToolsDirectory {
  const option = POLICY_OPTIONS.find((candidate) => candidate.mode === input.policy.mode) ?? POLICY_OPTIONS[0];
  const skills: DirectorySkill[] = input.gsd
    ? input.gsd.skills.map((skill) => ({ name: skill.name, description: skill.description, ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}), group: skillGroup(skill.name), insert: `/${skill.name} ` }))
    : GSD_COMMANDS.map((definition) => ({ name: `gsd-${definition.command}`, description: definition.description, group: CATEGORY_GROUP[definition.category] ?? 'Other', insert: `/gsd-${definition.command} ` }));
  const agents: DirectoryAgent[] = (input.gsd?.agents ?? []).map((agent) => ({ name: agent.name, description: agent.description, ...resolveAgentModel(agent.name, agent.model, input, false), tools: agent.tools }));
  const teams: DirectoryTeam[] = input.teams.flatMap((entry) => entry.team ? [{
    name: entry.team.name, description: entry.team.description, project: entry.project,
    command: `team:${entry.project ? 'project' : entry.team.slug}`, insert: `/team:${entry.project ? 'project' : entry.team.slug} `,
    members: entry.team.members.map((member) => { const resolved = resolveAgentModel(member.name, member.model, input, true); return { name: member.name, ...(member.role ? { role: member.role } : {}), tier: resolved.tier, model: resolved.model, tools: member.tools }; })
  }] : []);
  const teamProblems = input.teams.filter((entry) => entry.error).map((entry) => `${entry.file.split(/[\\/]/).pop()}: ${entry.error}`);

  // The built-in tools, from the very tool objects a run is given (agentSession.toolsFor).
  const catalog = input.models ?? [];
  const image = catalog.find((model) => model.id === input.settings.imageModel && (model.outputModalities ?? []).includes('image'));
  const gsdInstalled = Boolean(input.gsd);
  const noGsd = gsdInstalled ? {} : { off: 'Offered to agents once Open-GSD is installed (it installs with your first workflow).' };
  // What is not ready for use yet, and where to set it up, by tool name; the entry stays on the page with its words.
  const unavailable: Record<string, { off?: string; setup?: { label: string; command: string } }> = {
    ...(input.webSearch ? {} : { WebSearch: { off: 'No web search provider is set up.', setup: { label: 'Set up web search', command: 'nearAi.setUpWebSearch' } } }),
    ...(image ? {} : { GenerateImage: { off: `The image model (${input.settings.imageModel}) is not in this key's model list.`, setup: { label: 'Choose image model', command: 'setting:nearAi.agent.imageModel' } } }),
    ...(input.securityConsented ? {} : { SecurityScan: { off: 'Dependency checks are not allowed for this project yet.', setup: { label: 'Scan dependencies', command: 'nearAi.securityScan' } } })
  };
  const tools: DirectoryTool[] = [
    ...builtInTools({
      webSearch: input.webSearch && input.webSearchHost ? { name: 'searxng', label: 'configured provider', host: input.webSearchHost, search: async () => [] } : null,
      imageClient: { ...(input.modelHost ? { baseHost: input.modelHost } : {}) } as NearAiClient,
      imageModel: image ?? { id: input.settings.imageModel }
    }).map((tool) => toolEntry(tool, input, GSD_TOOL_NAMES.has(tool.name) ? noGsd : unavailable[tool.name]))
  ];

  // The built-in staff servers, grouped by server with the grant a team file uses (staffServers.ts lists them once). staff-products and guard-scan are
  // also catalog tools; the other servers' tools are not, so this is where they show.
  const staffServers: DirectoryStaffServer[] = builtInStaffServers().map((server) => ({
    id: server.id, grant: server.grant, name: server.name, description: server.description,
    tools: server.tools.map((tool) => toolEntry(tool, input))
  }));
  // A catalog tool that belongs to a staff server keeps its place in the catalog (run order) and is marked with its server, so the page draws it once.
  const serverOfTool = new Map(staffServers.flatMap((server) => server.tools.map((tool) => [tool.name, server.id] as const)));
  for (const tool of tools) { const server = serverOfTool.get(tool.name); if (server) tool.staffServer = server; }

  const mcp: DirectoryMcpServer[] = input.mcp.map((server) => {
    const disabled = new Set(server.config.disabledTools ?? []);
    return {
      id: server.config.id, name: server.config.name, transport: server.config.transport, host: server.host, words: server.manifestWords, enabledHere: server.enabledHere, state: server.state, ...(server.error ? { error: server.error } : {}), approval: server.config.approval,
      tools: server.tools.map((tool) => {
        const readOnly = tool.readOnly && !tool.destructive;
        // The same capability and "asks" rule as mcpAgentTool.
        const capability: ActionCapability = mcpToolCapability(server.config, tool, server.host);
        const asksByServer = server.config.approval === 'ask-every-call' || (server.config.approval === 'ask-for-changes' && !readOnly);
        let status = capabilityStatus(capability, input.policy, input.rules);
        if (status !== 'stopped' && (!server.enabledHere || disabled.has(tool.name))) status = 'off';
        else if (status === 'runs' && asksByServer) status = 'asks';
        return { name: tool.name, agentName: mcpToolName(server.config.id, tool.name), description: firstSentence(tool.description || tool.name), enabled: !disabled.has(tool.name), status, statusText: STATUS_TEXT[status] };
      })
    };
  });

  const uses: Array<{ use: string; setting: string; model: string }> = [
    { use: 'main', setting: 'nearAi.defaultModel', model: input.settings.mainModel },
    { use: 'deep', setting: 'nearAi.agent.deepModel', model: input.settings.tiers.deep },
    { use: 'standard', setting: 'nearAi.agent.standardModel', model: input.settings.tiers.standard },
    { use: 'fast', setting: 'nearAi.agent.fastModel', model: input.settings.tiers.fast },
    { use: 'vision', setting: 'nearAi.agent.visionModel', model: input.settings.visionModel },
    { use: 'transcription', setting: 'nearAi.agent.transcriptionModel', model: input.settings.transcriptionModel },
    { use: 'safety', setting: 'nearAi.agent.safetyModel', model: input.settings.safetyModel },
    { use: 'image', setting: 'nearAi.agent.imageModel', model: input.settings.imageModel }
  ];
  // 74.1 D-21 (S5): the same row helper as the chat picker, so the two never disagree; the directory greys nothing.
  const context = modelRowContext();
  const facts = new Map(catalogRows(catalog, context.section, context.now, { organization: context.organization }).map((entry) => [entry.id, entry.row.facts]));
  const models: DirectoryModel[] = catalog.map((model) => {
    const privacy = privacyOf(model);
    const kinds = [...new Set([...(model.inputModalities ?? []).filter((kind) => kind !== 'text').map((kind) => `${kind} in`), ...(model.outputModalities ?? []).filter((kind) => kind !== 'text').map((kind) => `${kind} out`)])];
    return {
      id: model.id, privacy, privacyText: model.forwardedTo && privacy === 'forwarded' ? `Runs on outside provider (${model.forwardedTo})` : PRIVACY_TEXT[privacy], facts: facts.get(model.id) ?? '',
      ...(model.contextLength ? { contextLength: model.contextLength } : {}),
      ...(model.inputPricePerMillion !== undefined ? { inputPerMillion: model.inputPricePerMillion } : {}),
      ...(model.outputPricePerMillion !== undefined ? { outputPerMillion: model.outputPricePerMillion } : {}),
      ...(model.imagePricePerUnit !== undefined ? { imagePrice: model.imagePricePerUnit } : {}),
      kinds, usedFor: uses.filter((use) => use.model === model.id).map((use) => use.use)
    };
  }).sort((a, b) => (b.usedFor.length ? 1 : 0) - (a.usedFor.length ? 1 : 0) || a.id.localeCompare(b.id));

  return {
    gsd: { installed: gsdInstalled, ...(input.gsd?.version ? { version: input.gsd.version } : {}) },
    policy: { mode: option.mode, label: option.label, summary: option.summary, stopped: input.policy.emergencyStop },
    skills, agents, teams, teamProblems, tools, staffServers, mcp, models,
    ...(input.modelsProblem ? { modelsProblem: input.modelsProblem } : {}),
    settingsModels: uses.map((use) => ({ ...use, available: input.models ? catalog.some((model) => model.id === use.model) : undefined, ...(input.settings.fromProject?.includes(use.setting) ? { source: 'project choice' as const } : {}) })),
    ...(input.reportingToken ? { reportingToken: { state: input.reportingToken.state, text: input.reportingToken.text, title: input.reportingToken.title, command: input.reportingToken.command === 'workbench.action.openSettings' ? `setting:${input.reportingToken.args[0]}` : input.reportingToken.command } } : {})
  };
}

/** Commands the page may run: existing NEAR AI commands only, and settings it may open. */
export const PAGE_COMMANDS = ['nearAi.manageMcp', 'nearAi.manageTeams', 'nearAi.setupProjectTeam', 'nearAi.manageMemory', 'nearAi.setUpWebSearch', 'nearAi.securityScan', 'nearAi.openAgentActivity', 'nearAi.exportAnalytics', 'nearAi.showHistory', 'nearAi.spendingLimits', SET_REPORTING_TOKEN_COMMAND, 'nearAi.resume', 'nearAi.setup', 'nearAi.compareModels', 'nearAi.projectSetup', 'nearAi.newProfile'] as const;

export type ToolsPageMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'use-in-chat'; text: string }
  | { type: 'run-command'; command: string }
  | { type: 'open-setting'; key: string }
  | { type: 'mcp-enable'; id: string; enabled: boolean }
  | { type: 'mcp-connect'; id: string };

/** Validates a message from the page; anything else is ignored. */
export function parseToolsPageMessage(value: unknown): ToolsPageMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  const only = (...allowed: string[]) => keys.every((key) => key === 'type' || allowed.includes(key));
  switch (message.type) {
    case 'ready': case 'refresh': return only() ? { type: message.type } : undefined;
    case 'use-in-chat': return only('text') && typeof message.text === 'string' && /^\/[\w:.-]{1,120} $/.test(message.text) ? { type: 'use-in-chat', text: message.text } : undefined;
    case 'run-command': return only('command') && typeof message.command === 'string' && (PAGE_COMMANDS as readonly string[]).includes(message.command) ? { type: 'run-command', command: message.command } : undefined;
    case 'open-setting': return only('key') && typeof message.key === 'string' && /^nearAi\.[A-Za-z.]{1,80}$/.test(message.key) ? { type: 'open-setting', key: message.key } : undefined;
    case 'mcp-enable': return only('id', 'enabled') && typeof message.id === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(message.id) && typeof message.enabled === 'boolean' ? { type: 'mcp-enable', id: message.id, enabled: message.enabled } : undefined;
    case 'mcp-connect': return only('id') && typeof message.id === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(message.id) ? { type: 'mcp-connect', id: message.id } : undefined;
    default: return undefined;
  }
}

/** The page's HTML: one nonce script and two stylesheets (the shared base, then its own), everything else rendered by the script with textContent. */
export function toolsPageHtml(options: { cspSource: string; nonce: string; script: string; style: string; base: string; probe?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<link rel="stylesheet" href="${options.base}"><link rel="stylesheet" href="${options.style}"><title>SovAI Tools</title></head><body>
<header><h1>SovAI Tools</h1><p class="hint">What the agents can use in this project: workflows, agents and teams, tools, MCP servers, and models. To run something, choose <strong>Use in chat</strong> and finish the message in the SovAI chat.</p>
<p id="policy" class="policy" aria-live="polite"></p>
<div class="search"><label for="filter" class="visually-hidden">Search the directory</label><input id="filter" type="search" placeholder="Search workflows, agents, tools, servers, models" aria-label="Search workflows, agents, tools, MCP servers, and models" aria-controls="directory"><button id="refresh" type="button" class="secondary">Refresh</button></div>
<nav aria-label="Sections"><ul class="toc"><li><a href="#skills-title">Skills &amp; workflows</a></li><li><a href="#agents-title">Agents &amp; teams</a></li><li><a href="#tools-title">Tools</a></li><li><a href="#mcp-title">MCP servers</a></li><li><a href="#models-title">Models</a></li></ul></nav></header>
<main id="directory">
<section aria-labelledby="skills-title"><h2 id="skills-title">Skills &amp; workflows</h2><div id="skills"><p class="hint">Loading…</p></div></section>
<section aria-labelledby="agents-title"><h2 id="agents-title">Agents &amp; teams</h2><div id="agents"></div></section>
<section aria-labelledby="tools-title"><h2 id="tools-title">Tools</h2><div id="tools"></div></section>
<section aria-labelledby="mcp-title"><h2 id="mcp-title">MCP servers</h2><div id="mcp"></div></section>
<section aria-labelledby="models-title"><h2 id="models-title">Models</h2><div id="models"></div></section>
<section aria-labelledby="elsewhere-title"><h2 id="elsewhere-title">Elsewhere</h2><div id="elsewhere"></div></section>
</main>
<p id="empty-search" class="hint" hidden aria-live="polite">Nothing matches your search.</p>
${options.probe ? `<script nonce="${options.nonce}" src="${options.probe}"></script>` : ''}<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}
