import * as vscode from 'vscode';
import type { Finding, SandboxTier } from '../domain/cyber';
import { RunGrants } from '../agent/permissions';
import { CyberProtocolDriver } from '../agent/cyberProtocolDriver';
import { scopeFingerprint } from '../domain/cyberLegal';
import { cyberRunPrompt, type CyberRunInput, type CyberRunResult } from './cyberRun';
import type { SecurityAccess } from '../agent/securityTool';
import {
  cyberAssemblyCore,
  cyberToolContext,
  panelTools,
  startCyberRunInPanel,
  type CompletionClient,
  type CyberRunAssembly,
  type PanelRunRequest
} from './cyberAssembly';
import { isEmergencyStopped } from './emergencyStop';

// The panel's host-side wiring: the install executor, the extension-side assembly (the real client
// and the global emergency stop), and the Run starter. Everything that can run without VS Code lives
// in cyberAssembly.ts, so the acceptance gate, the tool set and the starter are covered by
// node --test.

export * from './cyberAssembly';

/** Runs one install command through VS Code's terminal path, which honours the user's approval setting. */
export async function runApprovedCommand(command: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const terminal = vscode.window.createTerminal({ name: 'NEAR AI: install host tool' });
    terminal.show(true);
    terminal.sendText(command, true);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
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
  policy?: CyberRunInput['policy'];
  toolContext: CyberRunInput['toolContext'];
  tools(engagement: CyberRunInput['engagement']): CyberRunInput['tools'];
}): CyberRunAssembly {
  const key = (options.workspaceRoot ?? 'no-workspace').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'root';
  const storeDirectory = `${context.globalStorageUri.fsPath}/cyber/${key}`;
  const model = options.model ?? 'z-ai/glm-5.3';
  const complete = async (requested: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal?: AbortSignal): Promise<string> => {
    if (!options.client) return '';
    const reply = await options.client.completeOnce(requested, messages as never, { maxTokens: 4_000, ...(signal ? { signal } : {}) });
    return reply.text;
  };
  const version = String(context.extension?.packageJSON?.version ?? '0.0.0');
  return cyberAssemblyCore({
    storeDirectory,
    stopped: () => isEmergencyStopped(),
    driver: new CyberProtocolDriver({ model, complete }),
    title: 'NEAR AI: Cybersecurity',
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

