import * as vscode from 'vscode';
import type { Finding, SandboxTier } from '../domain/cyber';
import { RunGrants } from '../agent/permissions';
import { CyberProtocolDriver } from '../agent/cyberProtocolDriver';
import { scopeFingerprint } from '../domain/cyberLegal';
import { cyberRunPrompt, type CyberRunInput, type CyberRunResult } from './cyberRun';
import type { SecurityAccess } from '../agent/securityTool';
import {
  cyberAssemblyCore,
  cyberStorePath,
  cyberToolContext,
  panelTools,
  startCyberRunInPanel,
  type CompletionClient,
  type CyberRunAssembly,
  type PanelRunRequest
} from './cyberAssembly';
import { isEmergencyStopped } from './emergencyStop';
import type { GateRuntime } from '../domain/gate/decide';
import { defaultSessionRoute, sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import { CYBER_USE, cyberLaneRoute } from './cyberAssembly';
import { RESEARCH_TEXT } from '../domain/gate/researchLane';

// The panel's host-side wiring: the install executor, the extension-side assembly (the real client
// and the global emergency stop), and the Run starter. Everything that can run without VS Code lives
// in cyberAssembly.ts, so the acceptance gate, the tool set and the starter are covered by
// node --test.

export * from './cyberAssembly';

/**
 * Runs one install command and reports what actually happened. `terminal.sendText` returns as soon as
 * the text is typed, so reporting success from it meant a failing `sudo apt-get install` read as
 * "Installed". This asks first, then waits for the real exit status where shell integration offers it.
 */
export async function runApprovedCommand(command: string): Promise<{ ok: boolean; reason?: string }> {
  const approved = await vscode.window.showWarningMessage(
    'Install a host tool for cybersecurity scans?',
    { modal: true, detail: `${command}\n\nThis runs a package manager on this machine, and may need an administrator password in the terminal.` },
    'Install'
  );
  if (approved !== 'Install') return { ok: false, reason: 'The install was not approved.' };
  const terminal = vscode.window.createTerminal({ name: 'SovAI: install host tool' });
  terminal.show(true);
  const integration = (terminal as unknown as { shellIntegration?: { executeCommand(text: string): { exitCode: Thenable<number> } } }).shellIntegration;
  if (!integration) {
    // No shell integration: the command still runs, but its status is shown in the terminal only.
    terminal.sendText(command, true);
    return { ok: true, reason: 'Started in the terminal; its result is shown there.' };
  }
  const exitCode = await integration.executeCommand(command).exitCode;
  return exitCode === 0 ? { ok: true } : { ok: false, reason: `The install exited with status ${exitCode}.` };
}

/**
 * The extension-side assembly: the workspace's store directory under globalStorage, the real client
 * as the driver's completion seam, and the global emergency stop as the run's stop control. The
 * acceptance snapshot is derived from the engagement being run, never a constant — a hardcoded one
 * made every run refuse with "reacceptance-required".
 */
export function cyberAssembly(context: {
  globalStorageUri: { fsPath: string };
  extension?: { packageJSON?: { version?: string } };
}, options: {
  workspaceRoot?: string;
  client?: CompletionClient;
  model?: string;
  /** The run's gate: each role call runs inside its session route (CLAS-06). Without one it is decided with the default route. */
  gate?: GateRuntime;
  policy?: CyberRunInput['policy'];
  toolContext: CyberRunInput['toolContext'];
  tools(engagement: CyberRunInput['engagement']): CyberRunInput['tools'];
}): CyberRunAssembly {
  const storeDirectory = cyberStorePath(context.globalStorageUri.fsPath, options.workspaceRoot);
  // No fixed fallback model (74.1-10, MPRV-07): the engagement's choice or the abliterated pick, else the person chooses in the panel.
  const model = options.model?.trim();
  if (!model) throw new Error(RESEARCH_TEXT.cyberChooseModel);
  const complete = async (requested: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal?: AbortSignal): Promise<string> => {
    const client = options.client;
    if (!client) return '';
    const send = () => client.completeOnce(requested, messages as never, { maxTokens: 4_000, ...(signal ? { signal } : {}) });
    // Research only, in the research workspace's lane (74.1 D-17, design decision 4): every record of it says lane t0.
    const reply = await withSessionRoute(options.gate ? sessionRouteFrom(options.gate, { use: CYBER_USE }) : cyberLaneRoute(defaultSessionRoute()), send);
    return reply.text;
  };
  const version = String(context.extension?.packageJSON?.version ?? '0.0.0');
  return cyberAssemblyCore({
    storeDirectory,
    stopped: () => isEmergencyStopped(),
    driver: new CyberProtocolDriver({ model, complete }),
    title: 'Cybersecurity',
    toolContext: options.toolContext,
    currentAcceptance: (engagement) => ({
      region: engagement.region,
      scope: scopeFingerprint(engagement.resolvedScope),
      extensionVersion: version,
      textVersion: engagement.acceptedDisclaimer.textVersion
    }),
    tools: options.tools,
    ...(options.policy ? { policy: options.policy } : {})
  });
}

