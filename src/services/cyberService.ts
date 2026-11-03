import type * as vscode from 'vscode';
import { isEmergencyStopped } from './emergencyStop';
import { readAgentLimits, readSettings } from './settings';
import { chooseTier } from './cyberSandbox';
import type { CyberPanelServiceDeps } from './cyberPanel';

// What the Cybersecurity panel needs from the rest of the extension: the run handoff (which rides
// the chat/agent path, D-02), the approval-gated install executor (D-12), the chat model defaults
// (D-21), and the sandbox tier detection (D-08). Kept in its own module so cyberPanel.ts stays a
// panel service and extension.ts stays a registry.

export interface CyberHostServices {
  /** Runs one shell command through the approval-gated path and resolves its outcome (the Bash tool's rules). */
  runApprovedCommand(command: string): Promise<{ ok: boolean; reason?: string }>;
  /** The model the chat composer would use right now. */
  defaultModel(): string;
  availableModels(): Promise<string[]>;
  /** Starts a cyber run inside the panel. */
  startRun: CyberPanelServiceDeps['startRun'];
  /** Hands a run to a chat conversation so it survives the panel closing (deep runs). */
  handToChat: CyberPanelServiceDeps['handToChat'];
  /** The emergency stop, checked at run start and per step (CYBER-10). */
  stopped(): boolean;
}

export function cyberPanelService(context: vscode.ExtensionContext, host: CyberHostServices): CyberPanelServiceDeps {
  void context;
  return {
    startRun: host.startRun,
    handToChat: host.handToChat,
    installTool: async (tool, command) => {
      if (host.stopped()) return { ok: false, reason: 'The emergency stop is on, so nothing was installed.' };
      const result = await host.runApprovedCommand(command);
      return { ...result, ...(result.ok ? {} : { reason: result.reason ?? `The install of ${tool} did not complete.` }) };
    },
    defaultModel: host.defaultModel,
    availableModels: host.availableModels,
    sandboxTier: async () => chooseTier({ allowTempTier: true })
  };
}

export { isEmergencyStopped, readAgentLimits, readSettings };
