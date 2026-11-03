import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SandboxTier } from '../domain/cyber';
import { detectRegion } from '../domain/cyberLegal';
import { CyberEvidenceStore, CyberLedgerStore } from './cyberLedgerStore';
import type { CyberPageHost, CyberPanelDeps } from './cyberPanelPage';
import { attachCyberPanel, cyberPanelHtml, defaultResolve } from './cyberPanelPage';
import { exportFiles, findingsDocument, toSarif } from './cyberSarifExport';
import { buildPtesReport } from './cyberReport';
import { CyberEngagementStore } from './cyberEngagementStore';
import { installOffer, TOOL_CATALOGUE, detectTools, missingToolsNote } from './cyberTools';
import { detectPlatform, installAdvice, installSummary } from './cyberInstallAdvice';
import { chooseTier } from './cyberSandbox';
import { replayRun } from './cyberRun';
import { cyberStorePath } from './cyberAssembly';

// The Cybersecurity panel service: one singleton webview (D-01) that reveals on re-open, with all
// its host dependencies assembled here. The page's logic lives in cyberPanelPage.ts and its client
// in media/cyber/, so nothing but wiring is in this file.

let current: vscode.WebviewPanel | undefined;

/** The storage folder for this workspace's engagements: globalStorage, never the workspace (D-06). */
export function cyberStoreDirectory(context: vscode.ExtensionContext, root: string | undefined): string {
  return cyberStorePath(context.globalStorageUri.fsPath, root);
}

/** Where the model choice for one engagement is remembered (D-21: per engagement, not per workspace). */
export const modelKeyFor = (engagementId: string): string => `nearAi.cyber.model.${engagementId}`;

export interface CyberPanelServiceDeps {
  /** Starts a run inside the panel (the appliance vehicle). */
  startRun: CyberPanelDeps['startRun'];
  /** Hands a run to the chat conversation (the survivable vehicle for deep runs). */
  handToChat: CyberPanelDeps['handToChat'];
  /** Runs one install through the approval-gated shell path (D-12). */
  installTool(tool: string, command: string): Promise<{ ok: boolean; reason?: string }>;
  /** The model the chat would use, for an engagement with no stored choice. */
  defaultModel(): string;
  availableModels(): Promise<string[]>;
  /** The engagement's sandbox tier; detection only, nothing is installed (D-08). */
  sandboxTier(): Promise<{ tier: SandboxTier; reason?: string }>;
  /** Exports and replays are the 25-07 / 25-05 implementations. */
  now?(): Date;
}

async function depsFor(context: vscode.ExtensionContext, service: CyberPanelServiceDeps): Promise<CyberPanelDeps> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const directory = cyberStoreDirectory(context, root);
  const engagements = new CyberEngagementStore(directory);
  const ledger = new CyberLedgerStore(directory);
  const evidence = new CyberEvidenceStore(directory);
  const tier = await service.sandboxTier().catch(() => ({ tier: 'tempFolder' as SandboxTier }));
  return {
    storeDirectory: () => directory,
    extensionVersion: () => String(context.extension?.packageJSON?.version ?? '0.0.0'),
    identity: () => {
      let osUser = 'unknown';
      try { osUser = homedir().split(path.sep).filter(Boolean).pop() ?? 'unknown'; } catch { /* keep the fallback */ }
      let machine = 'unknown';
      try { machine = hostname(); } catch { /* keep the fallback */ }
      return { osUser, machine };
    },
    timeZone: () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } },
    sandboxTier: () => tier.tier,
    resolve: defaultResolve,
    engagements: {
      create: (engagement) => engagements.create(engagement),
      get: (id) => engagements.get(id),
      runs: async (id) => (await engagements.runs(id)).map((run) => ({ id: run.id, startedAt: run.startedAt }))
    },
    startRun: service.startRun,
    handToChat: service.handToChat,
    exportRun: async ({ runId, format }) => {
      const engagement = await engagementForRun(engagements, runId);
      if (!engagement) throw new Error(`Run ${runId} does not belong to an engagement in this workspace.`);
      const run = (await engagements.runs(engagement.id)).find((candidate) => candidate.id === runId);
      if (!run) throw new Error(`Run ${runId} is not in engagement ${engagement.id}.`);
      const entries = await ledger.entries(runId);
      const replay = await ledger.replay(runId);
      const payload = { toolVersion: String(context.extension?.packageJSON?.version ?? '0.0.0'), engagement, findings: replay.findings, ledgerVerified: replay.chainOk, missingTools: missingToolsNote(await detectTools()) };
      const outDir = path.join(directory, 'runs', runId, 'export');
      const markdown = buildPtesReport(engagement, run, replay.findings, entries);
      return exportFiles(outDir, { report: markdown, findings: findingsDocument(payload, { runId, startedAt: run.startedAt }), sarif: toSarif(payload) });
    },
    replay: async (runId) => {
      const replay = await replayRun(runId, ledger);
      return { steps: replay.steps.map((step) => ({ index: step.index, tool: step.tool, result: step.result })), findings: replay.findings, chainOk: replay.chainOk };
    },
    tools: async () => {
      const detected = await detectTools();
      const missing = detected.filter((entry) => !entry.available).map((entry) => entry.name);
      const advice = installAdvice(missing, detectPlatform(), TOOL_CATALOGUE);
      return { missing, advice, summary: installSummary(advice), installCommand: (tool: string) => advice.find((entry) => entry.tool === tool)?.command ?? installOffer(tool) };
    },
    installTool: service.installTool,
    models: {
      read: (engagementId) => context.globalState.get<string>(modelKeyFor(engagementId)),
      write: async (engagementId, model) => { await context.globalState.update(modelKeyFor(engagementId), model); },
      defaultModel: () => service.defaultModel(),
      available: () => service.availableModels()
    },
    ...(service.now ? { now: service.now } : {})
  };
}

/** The engagement a run belongs to: the store's own run records are the authority, not panel state. */
async function engagementForRun(engagements: CyberEngagementStore, runId: string): Promise<Awaited<ReturnType<CyberEngagementStore['get']>>> {
  for (const engagement of await engagements.list()) {
    if ((await engagements.runs(engagement.id)).some((run) => run.id === runId)) return engagement;
  }
  return undefined;
}

export function openCyberPanel(context: vscode.ExtensionContext, service: CyberPanelServiceDeps): void {
  if (current) { current.reveal(); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'cyber');
  const view = vscode.window.createWebviewPanel('nearAiCyber', 'NEAR AI: Cybersecurity', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media]
  });
  current = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  view.webview.html = cyberPanelHtml({ cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('cyber.js'), style: asset('cyber.css') });

  const page: CyberPageHost = { webview: view.webview, onDidDispose: (listener) => view.onDidDispose(listener), reveal: () => view.reveal() };
  // The sandbox tier is detected once per panel open, and detection never installs anything (D-12).
  void depsFor(context, service)
    .then((deps) => { context.subscriptions.push(attachCyberPanel(page, deps)); })
    .catch((error: Error) => { void vscode.window.showErrorMessage(`NEAR AI: the Cybersecurity panel could not start: ${error.message}`); });
  view.onDidDispose(() => { current = undefined; }, undefined, context.subscriptions);
}

/** The command palette entry's title, so the manifest and the code cannot drift. */
export const CYBER_COMMAND = 'nearAi.openCyber';
export const CYBER_DETECTED_REGION = (timeZone?: string): string => detectRegion(timeZone);
export const CYBER_TOOL_COUNT = TOOL_CATALOGUE.length;
