import { cyberExploitTools } from './cyberExploitTools';
import { cyberProbes } from './cyberProbes';
import { imageTool, memoryTools } from './extraTools';
import { knowledgeTools } from './knowledgeTools';
import { gsdTools } from '../gsd/tools';
import type { GsdServices } from '../gsd/tools';
import { GRAPHICS_TOOLS } from './graphicsTools';
import { securityTool } from './securityTool';
import type { SecurityAccess } from './securityTool';
import { CORE_TOOLS } from './tools';
import type { AgentTool } from './tools';
import type { SearchProvider } from './webSearch';
import { checkCitationsTool, checkOriginalityTool, webFetchTool, webSearchTool } from './webTools';
import type { ContextGraphMemory } from '../services/contextGraphMemory';
import type { ModelInfo, NearAiClient } from '../services/nearAiClient';

// The built-in tools in one list (GATE-02, D-05): every tool that declares a manifest next to its own definition, in the order a run is given them
// (agentSession.toolsFor). The Tools page lists this catalog, and the gate's tests walk it, so a tool added here is checked and shown without another edit.

const CYBER_PROBE_REASON = 'Connects to a target, which its manifest declares as `network`; the shorthand stays `read` because it is silent and scope-checked today (Pitfall 10), and the engagement\'s scope decides.';

/**
 * Tools whose own `capability` (today's shorthand, which the settings layer keeps using, D-04) is not what `shorthandFor` gives their manifest, each
 * with the reason. Every entry is a place where the shorthand and the declared effects tell a different story; nothing else may differ (Pitfall 10).
 */
export const SHORTHAND_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['BashOutput', 'Reads only the output of a command this run started, which is the run\'s own state; the shorthand stays `read` so the settings layer decides as before.'],
  ['CheckCitations', 'Reads only pages this run already fetched and holds in memory, so it declares no file read; the shorthand stays `read` so the settings layer decides as before.'],
  ['Recall', 'Reads the project\'s memory, which is not a project path a manifest can name, so it declares `plan`; the shorthand stays `read` so the settings layer decides as before.'],
  ['GenerateImage', 'The model is chosen per call, so no `infer` effect can name it here; the manifest declares the file it writes and the host it reaches, and the shorthand stays `mediaGeneration`.'],
  ['CyberHttpProbe', CYBER_PROBE_REASON],
  ['CyberFingerprintProbe', CYBER_PROBE_REASON],
  ['CyberTlsProbe', CYBER_PROBE_REASON],
  ['CyberDnsProbe', CYBER_PROBE_REASON],
  ['CyberTcpProbe', CYBER_PROBE_REASON],
  ['CyberRobotsProbe', CYBER_PROBE_REASON],
  ['TeamKnowledge', 'Reads the team\'s graph, which lives under the home folder and so is not a project path a manifest can name, so it declares `plan`; the shorthand stays `read` so the settings layer decides as before.'],
  ['SecurityScan', 'Writes the SBOM and queries two services, which a `read` shorthand does not say; the project\'s one-time consent gates it, so the shorthand stays `read` for the settings layer.']
]);

/**
 * What a tool needs from its host to be built. Nothing here is called when the catalog is read for its manifests: the Tools page and the tests build
 * the tools with stand-ins, and a run builds them with the real client, memory and provider in `agentSession.toolsFor`.
 */
export interface CatalogStubs {
  /** The configured search provider; `null` means none is set up (the default is a stand-in provider on a placeholder host). */
  webSearch?: SearchProvider | null;
  /** The client the image tool sends through, and the model it is built for. */
  imageClient?: NearAiClient;
  imageModel?: ModelInfo;
  security?: SecurityAccess;
  memory?: ContextGraphMemory;
  /** What the gsd tools need to be built; their manifests do not read it. Stand-ins when absent. */
  gsd?: GsdServices;
}

/**
 * The tools a run is given only in a special setting: a cyber engagement's probes and exploit steps, and a team's knowledge graph. The Tools page and the
 * team studio's tool pickers list the tools every run has, as before, so these are left off them (the studio would otherwise warn about them as unknown).
 */
export const OFFERED_ONLY_IN_CONTEXT: ReadonlySet<string> = new Set([
  'CyberHttpProbe', 'CyberTlsProbe', 'CyberDnsProbe', 'CyberTcpProbe', 'CyberRobotsProbe', 'CyberSecretsProbe', 'CyberIacProbe', 'CyberDependencyProbe', 'CyberFingerprintProbe',
  'CyberExploitTool', 'CyberPostExploitTool', 'TeamKnowledge', 'Learn'
]);

/** The gsd tools' names: the Tools page offers them once Open-GSD is installed, so it needs to tell them from the rest. */
export const GSD_TOOL_NAMES: ReadonlySet<string> = new Set(['Skill', 'SlashCommand', 'AskUserQuestion', 'Agent', 'Task']);

const STAND_IN_SEARCH: SearchProvider = { name: 'searxng', label: 'stand-in', host: 'search.example', search: async () => [] };

/** The catalog builds the tools to read their manifests; none of them is ever run, so a stand-in that is called is a bug. */
async function unavailable(): Promise<never> {
  throw new Error('This tool was built to list its manifest and cannot run.');
}

/** The built-in tools, in the order `toolsFor` gives them to a run. */
export function builtInTools(stubs: CatalogStubs = {}): AgentTool<any>[] {
  const search = stubs.webSearch === null ? undefined : (stubs.webSearch ?? STAND_IN_SEARCH);
  return [
    ...CORE_TOOLS,
    webFetchTool,
    webSearchTool(search),
    checkCitationsTool,
    checkOriginalityTool,
    ...GRAPHICS_TOOLS,
    imageTool(stubs.imageClient ?? ({} as NearAiClient), stubs.imageModel ?? { id: 'image-model' }),
    securityTool(stubs.security ?? { consented: () => true, scan: async () => undefined }),
    ...cyberProbes({ inScope: () => false }),
    ...cyberExploitTools({ inScope: () => false, engagementId: 'directory', sandboxTier: 'disabled' }),
    ...knowledgeTools({ read: unavailable, add: unavailable }, 'research'),
    ...memoryTools(stubs.memory ?? ({} as ContextGraphMemory), { project: { kind: 'project', id: 'directory' } }, 'directory', 'directory'),
    ...gsdTools(stubs.gsd ?? { home: '', root: '', skills: [], agents: [], ask: async () => [], spawn: async () => '' })
  ];
}
