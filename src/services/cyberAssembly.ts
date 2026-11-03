import { cyberRunPrompt, startCyberRun, type CyberRunInput, type CyberRunResult } from './cyberRun';
import { CyberEvidenceStore, CyberLedgerStore } from './cyberLedgerStore';
import { RunGrants } from '../agent/permissions';
import { scopeFingerprint } from '../domain/cyberLegal';
import type { Finding, ResolvedScope, SandboxTier } from '../domain/cyber';
import { cyberProbes } from '../agent/cyberProbes';
import { cyberExploitTools } from '../agent/cyberExploitTools';
import { scopeIncludes } from './cyberRun';
import type { SecurityAccess } from '../agent/securityTool';
import type { RateLimiter } from '../domain/cyberLimits';
import { CyberProtocolDriver } from '../agent/cyberProtocolDriver';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';

/**
 * The one rule for where a workspace's cyber store lives. The panel and the run stack both use it,
 * because when they drifted a run wrote its ledger under 'no-workspace' and export could not find it.
 */
export function cyberStorePath(globalStorage: string, workspaceRoot: string | undefined): string {
  const key = (workspaceRoot ?? 'no-workspace').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'root';
  return `${globalStorage}/cyber/${key}`;
}

/** A chat message as the driver sends it. */
export interface CompletionMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** How long one role's model call may take before the step is reported as unanswered. */
export const ROLE_CALL_TIMEOUT_MS = 180_000;

/** The one method the driver needs from a completion client; the real NearAiClient satisfies it. */
export interface CompletionClient {
  completeOnce(model: string, messages: CompletionMessage[], options: { maxTokens: number; signal?: AbortSignal; noThinking?: boolean }): Promise<{ text: string }>;
}

// The panel run stack (D-02, D-04, D-08): everything a Run needs, with no extension-host import,
// so the assembly itself runs under node --test. The host wiring that needs vscode lives in
// cyberHandoff.ts (the install executor and the emergency-stop-carrying starter).

export interface PanelRunRequest {
  engagement: CyberRunInput['engagement'];
  mode: 'defensive' | 'offensive' | 'full';
  depth: 'quick' | 'standard' | 'deep';
  model?: string;
  onEvent: CyberRunInput['onEvent'];
  signal: AbortSignal;
}

/** Runs one install command through VS Code's own terminal-command path, which respects the user's approval setting. */
export function panelRunPrompt(request: PanelRunRequest): string {
  return cyberRunPrompt({ engagement: request.engagement, mode: request.mode === 'defensive' ? 'passive' : 'intrusive', depth: request.depth });
}


/**
 * The panel's Run action: assembles the run input from the engagement and drives the 25-05 engine,
 * forwarding every event to the panel's timeline. The chat path supplies the approval seam, so the
 * user sees the same approval card the chat does (D-02); a headless start uses an allow-all seam so
 * the panel still works without a chat open.
 */
export async function startCyberRunInPanel(
  deps: {
    /** The stop control: the emergency stop, or a test's flag. */
    stopped(): boolean;
    tools: CyberRunInput['tools'];
    ledger: CyberRunInput['ledger'];
    evidence: CyberRunInput['evidence'];
    grants: CyberRunInput['grants'];
    driver: CyberRunInput['driver'];
    policy: CyberRunInput['policy'];
    rules?: CyberRunInput['rules'];
    requestApproval: CyberRunInput['requestApproval'];
    limiter?: CyberRunInput['limiter'];
    budget?: CyberRunInput['budget'];
    toolContext: CyberRunInput['toolContext'];
    /** The array the tools' onFindings collects into, drained by the run after every step. */
    externalFindings?: Finding[];
    currentAcceptance: (engagement: CyberRunInput['engagement']) => CyberRunInput['currentAcceptance'];
  },
  request: PanelRunRequest
): Promise<CyberRunResult> {
  if (deps.stopped()) throw new Error('The emergency stop is on; release it to start a run.');
  return startCyberRun({
    engagement: request.engagement,
    currentAcceptance: deps.currentAcceptance(request.engagement),
    driver: deps.driver,
    tools: deps.tools,
    ledger: deps.ledger,
    evidence: deps.evidence,
    grants: deps.grants,
    policy: deps.policy,
    ...(deps.rules ? { rules: deps.rules } : {}),
    requestApproval: deps.requestApproval,
    ...(deps.limiter ? { limiter: deps.limiter } : {}),
    ...(deps.budget ? { budget: deps.budget } : {}),
    toolContext: deps.toolContext,
    signal: request.signal,
    depth: request.depth,
    externalFindings: deps.externalFindings,
    stopped: () => deps.stopped(),
    ...(request.onEvent ? { onEvent: request.onEvent } : {})
  });
}

/** Everything the panel's run needs, assembled from the extension's own services. */
export interface CyberRunAssembly {
  /** The stop control the run consults before every step. */
  stopped(): boolean;
  ledger: CyberRunInput['ledger'];
  evidence: CyberRunInput['evidence'];
  driver: CyberRunInput['driver'];
  grants: CyberRunInput['grants'];
  policy: CyberRunInput['policy'];
  toolContext: CyberRunInput['toolContext'];
  externalFindings?: Finding[];
  currentAcceptance: (engagement: CyberRunInput['engagement']) => CyberRunInput['currentAcceptance'];
  requestApproval: CyberRunInput['requestApproval'];
  tools(engagement: CyberRunInput['engagement']): CyberRunInput['tools'];
}

/**
/**
 * The panel's Run action bound to a pre-assembled run stack. The caller supplies the assembly once
 * (per workspace), and every Run reuses it, so the ledger, evidence store, and grants are the
 * engagement's own.
 */
export function panelRunStarter(assembly: CyberRunAssembly): (request: PanelRunRequest) => Promise<CyberRunResult> {
  return (request) => startCyberRunInPanel(
    {
      stopped: assembly.stopped,
      tools: assembly.tools(request.engagement),
      ledger: assembly.ledger,
      evidence: assembly.evidence,
      grants: assembly.grants,
      driver: assembly.driver,
      policy: assembly.policy,
      requestApproval: assembly.requestApproval,
      toolContext: assembly.toolContext,
      currentAcceptance: assembly.currentAcceptance
    },
    request
  );
}

/**
/**
 * Builds the run stack for a workspace: the engagement's ledger and evidence store under
 * globalStorage (D-06), the protocol driver over the real client, the permission grants, and the
 * approval seam. The ledger and grants are cached per store directory so a second Run appends to the
 * same chain rather than starting a new one.
 */
export function cyberAssemblyCore(options: {
  storeDirectory: string;
  /** The stop control: the emergency stop, or a test's flag. */
  stopped(): boolean;
  driver: CyberRunInput['driver'];
  title: string;
  toolContext: CyberRunInput['toolContext'];
  currentAcceptance: (engagement: CyberRunInput['engagement']) => CyberRunInput['currentAcceptance'];
  tools(engagement: CyberRunInput['engagement']): CyberRunInput['tools'];
  ledger?: CyberRunInput['ledger'];
  evidence?: CyberRunInput['evidence'];
  grants?: CyberRunInput['grants'];
  policy?: CyberRunInput['policy'];
  requestApproval?: CyberRunInput['requestApproval'];
}): CyberRunAssembly {
  const ledger = options.ledger ?? new CyberLedgerStore(options.storeDirectory);
  const evidence = options.evidence ?? new CyberEvidenceStore(options.storeDirectory);
  const grants = options.grants ?? new RunGrants();
  return {
    stopped: options.stopped,
    ledger,
    evidence,
    driver: options.driver,
    grants,
    policy: options.policy ?? { mode: 'approve-risky', emergencyStop: false },
    toolContext: options.toolContext,
    currentAcceptance: options.currentAcceptance,
    // Without a chat open there is still one gate: the caller's seam, or an explicit allow.
    requestApproval: options.requestApproval ?? (async () => ({ decision: 'allow' as const })),
    tools: options.tools
  };
}

/**
/**
 * The extension-side assembly: the workspace's store directory under globalStorage, the real client
 * as the driver's completion seam, and the permission policy the chat uses. A model that cannot
 * reach NEAR leaves the driver's replies empty, which the protocol reports as incompatible — an
 * honest visible failure rather than a silent empty run.
 */
export function cyberAssembly(context: {
  globalStorageUri: { fsPath: string };
  extension?: { packageJSON?: { version?: string } };
}, options: {
  workspaceRoot?: string;
  client?: { completeOnce(model: string, messages: Array<{ role: string; content: string }>, options: { maxTokens: number; signal?: AbortSignal }): Promise<{ text: string }> };
  model?: string;
  policy?: CyberRunInput['policy'];
  toolContext: CyberRunInput['toolContext'];
  tools(engagement: CyberRunInput['engagement']): CyberRunInput['tools'];
}): CyberRunAssembly {
  const storeDirectory = cyberStorePath(context.globalStorageUri.fsPath, options.workspaceRoot);
  // A run without a chosen model used to fall back to a hardcoded id, which fails as "the model did
  // not follow the protocol" rather than naming the real problem. The caller must pick one.
  const model = options.model?.trim();
  if (!model) throw new Error('No model was chosen for this scan. Pick one in the panel\'s model list before running (the list is empty when no NEAR AI profile is set up).');
  const complete = async (requested: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal?: AbortSignal): Promise<string> => {
    if (!options.client) return '';
    // Every role call is bounded. Without a deadline a stalled request hung the whole run with no
    // event, which reads as a frozen panel rather than a failure.
    const timeout = AbortSignal.timeout(ROLE_CALL_TIMEOUT_MS);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const reply = await options.client.completeOnce(requested, messages as never, { maxTokens: 4_000, signal: bounded });
    return reply.text;
  };
  return cyberAssemblyCore({
    stopped: () => false,
    storeDirectory,
    driver: new CyberProtocolDriver({ model, complete }),
    title: 'NEAR AI: Cybersecurity',
    toolContext: options.toolContext,
    currentAcceptance: (engagement) => ({
      region: engagement.region,
      scope: scopeFingerprint(engagement.resolvedScope),
      extensionVersion: String(context.extension?.packageJSON?.version ?? '0.0.0'),
      textVersion: engagement.acceptedDisclaimer.textVersion
    }),
    tools: options.tools,
    ...(options.policy ? { policy: options.policy } : {})
  });
}

/** The ToolContext a cyber step's tool run receives: the workspace root, a shell, and a signal. */
export function cyberToolContext(root: string): CyberRunInput['toolContext'] {
  return {
    root,
    signal: new AbortController().signal,
    checkpoints: new RunCheckpoints('cyber-panel'),
    shell: new ShellSession(root),
    readFiles: new Set<string>()
  };
}

/**
 * The tool set a run executes: the built-in probes for passive checks, plus the sandboxed exploit
 * tools when the engagement allows intrusion (D-04, D-23). A passive engagement gets no exploit
 * tools at all, which is what keeps ordinary defensive scans free of shell-capability approvals.
 */
export function panelTools(options: {
  engagement: CyberRunInput['engagement'];
  scope: CyberRunInput['engagement']['resolvedScope'];
  collect(finding: Finding): void;
  grants: RunGrants;
  stopped(): boolean;
  sandboxTier: SandboxTier;
  security?: SecurityAccess;
}): CyberRunInput['tools'] {
  const inScope = (target: string) => scopeIncludes(options.scope, target);
  const probes = cyberProbes({
    scope: options.scope,
    inScope,
    onFindings: (findings) => { for (const finding of findings) options.collect(finding); },
    ...(options.security ? { security: options.security } : {})
  });
  const readOnly = probes.map((tool) => ({ tool, capability: 'read' as const }));
  if (!options.engagement.allowedModes.includes('intrusive')) return readOnly;
  const exploit = cyberExploitTools({
    engagementId: options.engagement.id,
    inScope,
    granted: () => Boolean(options.grants.intrusiveEngagement),
    stopped: options.stopped,
    sandboxTier: options.sandboxTier
  });
  return [...readOnly, ...exploit.map((tool) => ({ tool, capability: 'shell' as const }))];
}

/** The model a run should use: the panel's per-engagement choice, then the chat's standard tier. */
export function panelModel(stored: string | undefined, fallback: string): string {
  return stored?.trim() || fallback;
}


/**
 * Hands a run to the chat (the survivable vehicle). The message names the engagement and carries the
 * cyber access, so the chat turn's tools include the probes and (for intrusive modes) the exploit
 * tools, and the run is a normal chat turn: it keeps going when the panel closes, appears in the
 * conversation history, and can be steered by typing (D-02's original intent).
 *
 * The chat composes the prompt from the engagement rather than trusting text from the panel, so the
 * webview cannot widen the scope by pasting a different target into a message.
 */
export function chatHandoff(send: (message: { type: 'send'; text: string; model?: string }) => Promise<void>, options: { focusChat?: () => Promise<void> } = {}) {
  return async (input: { engagement: CyberRunInput['engagement']; mode: 'defensive' | 'offensive' | 'full'; depth: 'quick' | 'standard' | 'deep'; model?: string }): Promise<void> => {
    const prompt = cyberRunPrompt({ engagement: input.engagement, mode: input.mode === 'defensive' ? 'passive' : 'intrusive', depth: input.depth });
    await options.focusChat?.();
    await send({ type: 'send', text: prompt, ...(input.model ? { model: input.model } : {}) });
  };
}

/**
 * The extension's Run action. The client is resolved per run (the active NEAR profile), the tools
 * are the real probe/exploit set for the engagement's modes, and each run gets its own grants.
 */
export function panelCyberRunStarter(
  host: { globalStorageUri: { fsPath: string }; extension?: { packageJSON?: { version?: string } } },
  resolveClient: (root: string) => Promise<CompletionClient | undefined>,
  options: { root?: string; model?: string; stopped?: () => boolean; sandboxTier?: () => Promise<SandboxTier>; security?: () => SecurityAccess | undefined } = {}
): (request: PanelRunRequest) => Promise<CyberRunResult> {
  const root = options.root ?? host.globalStorageUri.fsPath;
  const toolContext = cyberToolContext(root);
  return async (request) => {
    const client = await resolveClient(root);
    if (!client) {
      // Without a client the driver's replies are empty, which the protocol reports as a model that
      // cannot follow it. Say the real reason instead: nothing is configured to ask.
      throw new Error('No NEAR AI model is reachable: set up a profile (NEAR AI: Set Up) and choose a model in this panel before running a scan.');
    }
    const tier = options.sandboxTier ? await options.sandboxTier() : 'tempFolder';
    const grants = new RunGrants();
    const collected: Finding[] = [];
    const security = options.security?.();
    const assembly = cyberAssembly(host, {
      ...(options.root ? { workspaceRoot: options.root } : {}),
      ...(client ? { client } : {}),
      // The model the user chose for this engagement wins over the configured default; otherwise the
      // panel's selector would be decorative and every run would use the fallback model.
      ...((request.model ?? options.model) ? { model: request.model ?? options.model } : {}),
      toolContext,
      tools: (engagement) => panelTools({
        engagement,
        scope: engagement.resolvedScope,
        grants,
        stopped: options.stopped ?? (() => false),
        sandboxTier: tier,
        collect: (finding) => collected.push(finding),
        ...(security ? { security } : {})
      })
    });
    // The run drains this array after every step, so the probes' findings are critiqued and chained
    // exactly like the ones a step builds itself.
    return startCyberRunInPanel({ ...assembly, grants, tools: assembly.tools(request.engagement), externalFindings: collected }, request);
  };
}

