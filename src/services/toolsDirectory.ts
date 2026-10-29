import type { ActionCapability, ActionPolicy, ActionPolicyMode } from '../domain/policy';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { decidePermission, PermissionRules, RunGrants } from '../agent/permissions';
import { AgentTool, CORE_TOOLS } from '../agent/tools';
import { checkCitationsTool, webFetchTool, webSearchTool } from '../agent/webTools';
import { GRAPHICS_TOOLS } from '../agent/graphicsTools';
import { imageTool, memoryTools } from '../agent/extraTools';
import { securityTool } from '../agent/securityTool';
import { gsdTools } from '../gsd/tools';
import { GsdAgent, GsdSkill, modelForTier, roleModelFor } from '../gsd/library';
import type { TeamDefinition } from '../agent/teams';
import type { McpServerStatus } from './mcpRegistry';
import { mcpToolName } from '../mcp/tools';
import type { ModelInfo, NearAiClient } from './nearAiClient';
import type { ContextGraphMemory } from './contextGraphMemory';
import { POLICY_OPTIONS } from './approvalPolicy';
import { ReportingTokenHint, SET_REPORTING_TOKEN_COMMAND } from './reportingToken';

// The NEAR AI Tools page: a read-mostly directory of what the agents can use. Everything here is
// computed from the same sources a run uses (the installed Open-GSD library, team files, the
// built-in tool objects, the permission logic, the MCP registry, and the model catalog), so the
// page cannot drift from what actually happens. No VS Code imports, so the tests run it directly.

export type ToolStatus = 'runs' | 'asks' | 'auto-checked' | 'off' | 'stopped';

export interface DirectorySkill { name: string; description: string; argumentHint?: string; group: string; insert: string }
export interface DirectoryAgent { name: string; description: string; tier: string; model: string; source: 'role setting' | 'definition' | 'default'; tools: string[] }
export interface DirectoryTeam { name: string; description: string; command: string; insert: string; project: boolean; members: Array<{ name: string; role?: string; tier: string; model: string; tools: string[] }> }
export interface DirectoryTool { name: string; description: string; capability: string; status: ToolStatus; statusText: string; notes: string[]; setup?: { label: string; command: string } }
export interface DirectoryMcpServer { id: string; name: string; transport: string; host: string; enabledHere: boolean; state: string; error?: string; approval: string; tools: Array<{ name: string; agentName: string; description: string; enabled: boolean; status: ToolStatus; statusText: string }> }
export interface DirectoryModel { id: string; privacy: 'tee' | 'local' | 'forwarded' | 'unknown'; privacyText: string; contextLength?: number; inputPerMillion?: number; outputPerMillion?: number; imagePrice?: number; kinds: string[]; usedFor: string[] }

export interface ToolsDirectory {
  gsd: { installed: boolean; version?: string };
  policy: { mode: ActionPolicyMode; label: string; summary: string; stopped: boolean };
  skills: DirectorySkill[];
  agents: DirectoryAgent[];
  teams: DirectoryTeam[];
  teamProblems: string[];
  tools: DirectoryTool[];
  mcp: DirectoryMcpServer[];
  models: DirectoryModel[];
  modelsProblem?: string;
  settingsModels: Array<{ use: string; setting: string; model: string; available: boolean | undefined }>;
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
  /** Whether this project allowed the dependency scanner. */
  securityConsented: boolean;
  mcp: McpServerStatus[];
  /** The key's model catalog; undefined when no validated profile, or it could not load. */
  models?: ModelInfo[];
  modelsProblem?: string;
  settings: { mainModel: string; tiers: { deep: string; standard: string; fast: string }; roleModels: Record<string, string>; visionModel: string; transcriptionModel: string; imageModel: string; safetyModel: string };
  /** Whether a usage reporting token is set (from the host's secret storage; never the token). */
  reportingToken?: ReportingTokenHint;
}

const CAPABILITY_LABEL: Record<ActionCapability, string> = {
  read: 'read', plan: 'plan', workspaceWrite: 'edit', shell: 'shell', network: 'network', gitMutation: 'git', mediaGeneration: 'generate', mediaPublication: 'publish'
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

/** What the permission logic does for this capability under the policy, with no grants yet in the run. */
export function capabilityStatus(capability: ActionCapability, policy: ActionPolicy, rules: PermissionRules): ToolStatus {
  const decided = decidePermission(capability, undefined, policy, rules, new RunGrants());
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
  return { tier: tierOf(value), model: modelForTier(value, input.settings.tiers, input.settings.mainModel), source: roleModel ? 'role setting' : definitionModel ? 'definition' : 'default' };
}

const stubClient = {} as NearAiClient;
const stubMemory = {} as ContextGraphMemory;

function toolEntry(tool: AgentTool<any>, input: DirectoryInput, available: { off?: string; setup?: { label: string; command: string } } = {}): DirectoryTool {
  const status: ToolStatus = available.off && !input.policy.emergencyStop ? 'off' : capabilityStatus(tool.capability, input.policy, input.rules);
  const notes: string[] = [];
  if (available.off) notes.push(available.off);
  if (tool.capability === 'shell' && tool.name === 'Bash' && input.rules.allowCommands.length && status !== 'runs' && status !== 'stopped') notes.push(`Allow-listed commands run without asking: ${input.rules.allowCommands.slice(0, 8).join(', ')}${input.rules.allowCommands.length > 8 ? ', …' : ''}.`);
  if (tool.sensitive) notes.push('Some paths always ask first (files that look like credentials, or protected locations).');
  if (tool.risky) notes.push('Can ask in any mode once the run has read outside content.');
  if (tool.untrusted) notes.push('Its results are outside content.');
  return { name: tool.name, description: firstSentence(tool.description), capability: CAPABILITY_LABEL[tool.capability], status, statusText: STATUS_TEXT[status], notes, ...(available.setup ? { setup: available.setup } : {}) };
}

export function privacyOf(model: ModelInfo): DirectoryModel['privacy'] {
  return model.privacyBoundary === 'tee' ? 'tee' : model.privacyBoundary === 'local' ? 'local' : model.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown';
}

export const PRIVACY_TEXT: Record<DirectoryModel['privacy'], string> = { tee: 'TEE: runs privately in NEAR’s TEE', local: 'Local: runs on this machine', forwarded: 'Forwarded: not private', unknown: 'Privacy unknown' };

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
  const tools: DirectoryTool[] = [
    ...CORE_TOOLS.map((tool) => toolEntry(tool, input)),
    toolEntry(webFetchTool, input),
    toolEntry(webSearchTool(undefined), input, input.webSearch ? {} : { off: 'No web search provider is set up.', setup: { label: 'Set up web search', command: 'nearAi.setUpWebSearch' } }),
    toolEntry(checkCitationsTool, input),
    ...GRAPHICS_TOOLS.map((tool) => toolEntry(tool, input)),
    toolEntry(imageTool(stubClient, image ?? { id: input.settings.imageModel }), input, image ? {} : { off: `The image model (${input.settings.imageModel}) is not in this key's model list.`, setup: { label: 'Choose image model', command: 'setting:nearAi.agent.imageModel' } }),
    toolEntry(securityTool({ consented: () => input.securityConsented, scan: async () => undefined }), input, input.securityConsented ? {} : { off: 'Dependency checks are not allowed for this project yet.', setup: { label: 'Scan dependencies', command: 'nearAi.securityScan' } }),
    ...memoryTools(stubMemory, { project: { kind: 'project', id: 'directory' } }, 'directory', 'directory').map((tool) => toolEntry(tool, input)),
    ...gsdTools({ home: '', root: '', skills: [], agents: [], ask: async () => [], spawn: async () => '' }).map((tool) => toolEntry(tool, input, noGsd))
  ];

  const mcp: DirectoryMcpServer[] = input.mcp.map((server) => {
    const disabled = new Set(server.config.disabledTools ?? []);
    return {
      id: server.config.id, name: server.config.name, transport: server.config.transport, host: server.host, enabledHere: server.enabledHere, state: server.state, ...(server.error ? { error: server.error } : {}), approval: server.config.approval,
      tools: server.tools.map((tool) => {
        const readOnly = tool.readOnly && !tool.destructive;
        // The same capability and "asks" rule as mcpAgentTool.
        const capability: ActionCapability = readOnly && server.config.approval !== 'ask-every-call' ? 'read' : 'network';
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
  const models: DirectoryModel[] = catalog.map((model) => {
    const privacy = privacyOf(model);
    const kinds = [...new Set([...(model.inputModalities ?? []).filter((kind) => kind !== 'text').map((kind) => `${kind} in`), ...(model.outputModalities ?? []).filter((kind) => kind !== 'text').map((kind) => `${kind} out`)])];
    return {
      id: model.id, privacy, privacyText: model.forwardedTo && privacy === 'forwarded' ? `Forwarded to ${model.forwardedTo}: not private` : PRIVACY_TEXT[privacy],
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
    skills, agents, teams, teamProblems, tools, mcp, models,
    ...(input.modelsProblem ? { modelsProblem: input.modelsProblem } : {}),
    settingsModels: uses.map((use) => ({ ...use, available: input.models ? catalog.some((model) => model.id === use.model) : undefined })),
    ...(input.reportingToken ? { reportingToken: { state: input.reportingToken.state, text: input.reportingToken.text, title: input.reportingToken.title, command: input.reportingToken.command === 'workbench.action.openSettings' ? `setting:${input.reportingToken.args[0]}` : input.reportingToken.command } } : {})
  };
}

/** Commands the page may run: existing NEAR AI commands only, and settings it may open. */
export const PAGE_COMMANDS = ['nearAi.manageMcp', 'nearAi.manageTeams', 'nearAi.setupProjectTeam', 'nearAi.manageMemory', 'nearAi.setUpWebSearch', 'nearAi.securityScan', 'nearAi.openAgentActivity', 'nearAi.exportAnalytics', 'nearAi.showHistory', 'nearAi.spendingLimits', SET_REPORTING_TOKEN_COMMAND, 'nearAi.resume', 'nearAi.setup'] as const;

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

/** The page's HTML: one nonce script and one stylesheet, everything else rendered by the script with textContent. */
export function toolsPageHtml(options: { cspSource: string; nonce: string; script: string; style: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<link rel="stylesheet" href="${options.style}"><title>NEAR AI Tools</title></head><body>
<header><h1>NEAR AI Tools</h1><p class="hint">What the agents can use in this project: workflows, agents and teams, tools, MCP servers, and models. To run something, choose <strong>Use in chat</strong> and finish the message in the NEAR AI chat.</p>
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
<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}
