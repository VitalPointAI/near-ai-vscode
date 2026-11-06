import type { CyberEngagementDraft, CyberRunMode, CyberWebviewMessage } from './chatBridge';
import { parseCyberMessage } from './chatBridge';
import type { DisclaimerAcceptance, Engagement, ResolvedScope, SandboxTier } from '../domain/cyber';
import { isoTimestamp, resolveTarget } from '../domain/cyber';
import { installOffer } from './cyberTools';
import type { RegionEntry } from '../domain/cyberLegal';
import { needsReacceptance, publicSectorWarning, regionEntry, REGION_CODES, REGION_CATALOGUE, scopeFingerprint, detectRegion } from '../domain/cyberLegal';
import type { AcceptanceSnapshot } from '../domain/cyberLegal';
import type { CyberRunEvent } from './cyberRun';
import { defaultVehicle, type RunVehicle } from '../domain/cyberLimits';
import type { InstallAdvice } from './cyberInstallAdvice';
import { CHOOSE_ABLITERATED_TEXT, NO_ABLITERATED_TEXT, chooseCyberModel } from '../domain/cyberModel';

// The Cybersecurity panel's page: the HTML shell, the message handling, and the payloads the client
// renders. No client logic lives in the HTML string (the CONCERNS.md debt this page must not
// repeat); the client is media/cyber/cyber.js and renders every dynamic value with textContent.

export type { CyberWebviewMessage };

/** Why a mode is unavailable for a resolved scope (CYBER-01's disable-with-reason). */
export interface ModeAvailability { mode: CyberRunMode; label: string; enabled: boolean; reason?: string }

const MODE_LABEL: Record<CyberRunMode, string> = { defensive: 'Defensive', offensive: 'Offensive', full: 'Full' };

const MODE_NEEDS: Record<CyberRunMode, { network: boolean; host: boolean }> = {
  defensive: { network: false, host: false },
  offensive: { network: true, host: false },
  full: { network: true, host: false }
};

/**
 * Which modes a resolved scope allows. A workspace-only scope has no network host to exploit, so the
 * offensive modes arrive disabled with the reason rather than hidden (the reader must know why).
 */
export function modeAvailability(scope: ResolvedScope, sandbox: SandboxTier = 'tempFolder'): ModeAvailability[] {
  return (["defensive", "offensive", "full"] as CyberRunMode[]).map((mode) => {
    const needs = MODE_NEEDS[mode];
    if (needs.network && !scope.hosts.length) {
      return { mode, label: MODE_LABEL[mode], enabled: false, reason: `${MODE_LABEL[mode]} mode needs a network host, and this target resolves to a workspace folder with none.` };
    }
    if (needs.network && sandbox === 'disabled') {
      return { mode, label: MODE_LABEL[mode], enabled: false, reason: `${MODE_LABEL[mode]} mode needs a sandbox, and no container runtime or temporary tier is available.` };
    }
    return { mode, label: MODE_LABEL[mode], enabled: true };
  });
}

/** The scope preview the client paints before anything is sent (CYBER-01). */
export interface ScopePreview {
  kind: string;
  value: string;
  hosts: string[];
  ports: number[];
  paths: string[];
  exclusions: string[];
  note?: string;
  modes: ModeAvailability[];
  /** The public-sector/metadata red flag, never a block (D-15). */
  warning?: string;
}

export function scopePreview(kind: string, value: string, scope: ResolvedScope, sandbox: SandboxTier = 'tempFolder'): ScopePreview {
  const warning = publicSectorWarning(value);
  return {
    kind,
    value,
    hosts: [...scope.hosts],
    ports: [...scope.ports],
    paths: [...scope.paths],
    exclusions: [...scope.exclusions],
    ...(scope.note ? { note: scope.note } : {}),
    modes: modeAvailability(scope, sandbox),
    ...(warning ? { warning } : {})
  };
}

/** The disclaimer modal's data: the detected region, all twelve, and any red flag. */
export interface DisclaimerPrompt {
  detectedRegion: string;
  regions: Array<{ code: string; name: string; statute: string; statement: string; textVersion: string; ownerReview?: string }>;
  warning?: string;
}

export function disclaimerPrompt(value: string | undefined, timeZone: string | undefined): DisclaimerPrompt {
  const detected = detectRegion(timeZone);
  const warning = publicSectorWarning(value ?? '');
  return {
    detectedRegion: detected,
    regions: REGION_CODES.map((code) => {
      const entry: RegionEntry = REGION_CATALOGUE[code];
      return { code, name: entry.name, statute: entry.statute, statement: entry.statement, textVersion: entry.textVersion, ...(entry.ownerReview ? { ownerReview: entry.ownerReview } : {}) };
    }),
    ...(warning ? { warning } : {})
  };
}

/** The panel's dependencies, all injected so tests run without a VS Code host. */
export interface CyberPanelDeps {
  /** Where globalStorage lives for this workspace; the engagement store's directory. */
  storeDirectory(): string;
  /** The version the acceptance records. */
  extensionVersion(): string;
  /** The OS user and machine the acceptance records. */
  identity(): { osUser: string; machine: string };
  /** The user's time zone, so the modal's detected region matches their locale. */
  timeZone(): string | undefined;
  /** The sandbox tier the engagement would get, for mode gating. */
  sandboxTier(): SandboxTier;
  /** Resolves a target; injected so tests need no DNS. */
  resolve(kind: string, value: string): Promise<ResolvedScope>;
  /** The engagement store: create, get, list runs. */
  engagements: {
    create(engagement: Engagement): Promise<Engagement>;
    get(id: string): Promise<Engagement | undefined>;
    runs(id: string): Promise<Array<{ id: string; startedAt: string }>>;
  };
  /**
   * Hands a run to a chat conversation, so it survives this panel closing and can be steered
   * (the deep-run vehicle). Resolves once the chat has accepted the request.
   */
  handToChat(input: { engagement: Engagement; mode: CyberRunMode; depth: 'quick' | 'standard' | 'deep'; model?: string }): Promise<void>;
  /** Starts a run; the panel forwards events to the timeline. */
  startRun(input: { engagement: Engagement; mode: CyberRunMode; depth: 'quick' | 'standard' | 'deep'; model?: string; onEvent(event: CyberRunEvent): void; signal: AbortSignal }): Promise<{ runId: string; outcome: string; findings: unknown[] }>;
  /** Exports a finished run; returns the written paths. */
  exportRun(input: { runId: string; format: 'markdown' | 'json' | 'sarif' }): Promise<{ report: string; json: string; sarif: string }>;
  /** Re-renders a finished run offline. */
  replay(runId: string): Promise<{ steps: Array<{ index: number; tool: string; result: string }>; findings: unknown[]; chainOk: boolean }>;
  /** Detection and install offers for the missing-tools list (D-12). */
  tools(): Promise<{ missing: string[]; advice: InstallAdvice[]; summary: string; installCommand(tool: string): string | undefined }>;
  /** Runs an install through the approval-gated shell path and records it. */
  installTool(tool: string, command: string): Promise<{ ok: boolean; reason?: string }>;
  /** The model choice, remembered per engagement (D-21). */
  models: {
    read(engagementId: string): string | undefined;
    write(engagementId: string, model: string): Promise<void>;
    defaultModel(): string;
    available(): Promise<string[]>;
    /** Asks the person which abliterated model to use, when several are offered. */
    choose?(models: string[]): Promise<string | undefined>;
  };
  now?(): Date;
}

/** The host a page attaches to; the webview's own minimal shape. */
export interface CyberPageHost {
  webview: {
    postMessage(message: unknown): Thenable<boolean> | Promise<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void };
  };
  onDidDispose(listener: () => void): { dispose(): void };
  /** Reveals the panel (D-05: the first run event focuses the timeline). */
  reveal?(): void;
}

export function cyberPanelHtml(options: { cspSource: string; nonce: string; script: string; style: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<link rel="stylesheet" href="${options.style}"><title>NEAR AI Cybersecurity</title></head><body>
<header><h1>NEAR AI Cybersecurity</h1><p class="hint">Pick a target, resolve its scope, accept the regional disclaimer once per engagement, then run a defensive, offensive, or full scan. Nothing is sent to a model until you press Run.</p>
<p id="status" class="status" role="status" aria-live="polite"></p>
</header>
<main>
<section id="target-section" aria-labelledby="target-title"><h2 id="target-title">Target</h2>
<form id="target-form"><label for="target-kind">Kind</label><select id="target-kind" aria-label="Target kind"><option value="url">URL or host</option><option value="workspace">Workspace folder</option><option value="cidr">CIDR range</option><option value="container">Container</option><option value="git">Git repository folder</option></select>
<label for="target-value">Value</label><input id="target-value" type="text" required aria-label="Target value" placeholder="https://example.com, 10.0.0.0/30, . or a folder path">
<button id="resolve" type="submit">Resolve scope</button></form>
<div id="scope-preview" aria-live="polite"></div>
<div id="warning" class="warning" hidden role="alert"></div></section>
<section id="mode-section" aria-labelledby="mode-title"><h2 id="mode-title">Mode and depth</h2>
<div id="mode-selector" role="group" aria-label="Scan mode"></div>
<label for="depth">Depth</label><select id="depth" aria-label="Depth profile"><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option></select>
<button id="create" type="button" disabled>Create engagement</button></section>
<section id="disclaimer-section" aria-labelledby="disclaimer-title" hidden><h2 id="disclaimer-title">Legal disclaimer</h2>
<div id="disclaimer-modal" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title"></div></section>
<section id="run-section" aria-labelledby="run-title" hidden><h2 id="run-title">Run</h2>
<label for="model">Model</label><select id="model" aria-label="Model for this engagement"></select>
<p id="model-note" class="hint" role="note" hidden></p>
<label for="vehicle">Run in</label><select id="vehicle" aria-label="Where the run is driven from"><option value="panel">This panel</option><option value="chat">The chat (survives closing this panel)</option></select>
<p id="vehicle-note" class="hint" role="note"></p>
<button id="run" type="button">Run</button>
<button id="stop" type="button" class="secondary" disabled>Stop</button>
<div id="progress-wrap"><progress id="progress" max="100" hidden></progress><p id="progress-text" class="hint" role="status" aria-live="polite"></p></div>
<p id="run-status" class="status" role="status" aria-live="polite"></p></section>
<section id="timeline-section" aria-labelledby="timeline-title"><h2 id="timeline-title">Step timeline</h2><div id="timeline" aria-live="polite"></div></section>
<section id="findings-section" aria-labelledby="findings-title"><h2 id="findings-title">Findings</h2><div id="findings"></div></section>
<section id="tools-section" aria-labelledby="tools-title"><h2 id="tools-title">Missing host tools</h2><div id="tools"></div></section>
<section id="export-section" aria-labelledby="export-title"><h2 id="export-title">Export and replay</h2><div id="export"></div></section>
</main>
<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}

/** The engagement a draft becomes, once its disclaimer is accepted. */
export function buildEngagement(input: {
  draft: CyberEngagementDraft;
  scope: ResolvedScope;
  acceptance: DisclaimerAcceptance;
  workspace: string;
  sandbox: { tier: SandboxTier; reason?: string };
  authorizationStatement?: string;
  id?: string;
}): Engagement {
  return {
    id: input.id ?? `eng-${cryptoRandomUuid()}`,
    workspace: input.workspace,
    target: { kind: input.draft.kind as Engagement['target']['kind'], value: input.draft.value },
    resolvedScope: input.scope,
    region: input.acceptance.region,
    authorizationStatement: input.authorizationStatement ?? `${input.acceptance.acceptor} accepted the ${input.acceptance.region} cybersecurity disclaimer for this target.`,
    allowedModes: input.draft.modes.map((mode) => (mode === 'defensive' ? 'passive' : mode === 'offensive' ? 'intrusive' : 'intrusive')),
    exclusions: input.draft.exclusions ?? [],
    sandbox: input.sandbox,
    acceptedDisclaimer: input.acceptance,
    createdAt: input.acceptance.acceptedAt,
    frozen: false
  };
}

/** Deterministic-enough ids without importing node:crypto into the webview boundary. */
function cryptoRandomUuid(): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The one place the acceptance snapshot is derived, so the panel and the run gate agree. */
export function acceptanceSnapshot(engagement: Engagement, extensionVersion: string): AcceptanceSnapshot {
  return { region: engagement.region, scope: scopeFingerprint(engagement.resolvedScope), extensionVersion, textVersion: engagement.acceptedDisclaimer.textVersion };
}

interface PanelState {
  draft?: CyberEngagementDraft;
  scope?: ResolvedScope;
  /** The draft and the scope it was resolved against, held together so they cannot drift apart. */
  pending?: { draft: CyberEngagementDraft; scope: ResolvedScope };
  prompt?: DisclaimerPrompt;
  engagementId?: string;
  controller?: AbortController;
  runId?: string;
}

/**
 * Wires the page to its actions. Every message is parsed first; every posted payload is a plain
 * object the client renders with textContent.
 */
export function attachCyberPanel(host: CyberPageHost, deps: CyberPanelDeps): { dispose(): void } {
  const state: PanelState = {};
  const post = (message: Record<string, unknown>) => host.webview.postMessage(message);
  const now = () => isoTimestamp(deps.now?.() ?? new Date());
  const timeZone = () => { try { return deps.timeZone(); } catch { return undefined; } };

  /**
   * The model an engagement runs on (owner decision 2026-11-05): the engagement's own choice, else the only abliterated model
   * offered, else a question when several are offered, else the default with a plain note. A person's answer is remembered for the
   * engagement, so the question is asked once. Resolves to the model and an optional sentence for the panel.
   */
  const modelFor = async (engagementId: string): Promise<{ model: string; note?: string }> => {
    const available = await deps.models.available().catch(() => [] as string[]);
    const choice = chooseCyberModel(available, deps.models.read(engagementId), deps.models.defaultModel());
    if (choice.kind === 'use') return { model: choice.model };
    if (choice.kind === 'none') return { model: choice.fallback, note: NO_ABLITERATED_TEXT };
    const picked = await deps.models.choose?.(choice.models);
    if (!picked) return { model: deps.models.defaultModel(), note: CHOOSE_ABLITERATED_TEXT };
    await deps.models.write(engagementId, picked);
    return { model: picked };
  };

  const subscriptions = [host.webview.onDidReceiveMessage(async (value) => {
    const message = parseCyberMessage(value);
    if (!message) return;
    try {
      switch (message.type) {
        case 'ready': {
          const detected = disclaimerPrompt(undefined, timeZone());
          await post({ type: 'regions', detectedRegion: detected.detectedRegion, regions: detected.regions });
          const models = await deps.models.available();
          await post({ type: 'models', models, defaultModel: deps.models.defaultModel() });
          const tools = await deps.tools();
          await post({ type: 'tools', ...tools });
          break;
        }
        case 'resolve-target': {
          const scope = await deps.resolve(message.kind, message.value);
          state.scope = scope;
          await post({ type: 'scope', preview: scopePreview(message.kind, message.value, scope, deps.sandboxTier()) });
          break;
        }
        case 'create-engagement': {
          if (!state.scope) { await post({ type: 'error', text: 'Resolve the target scope before creating an engagement.' }); break; }
          // The scope is captured with the draft. Resolving a second target after this point must not
          // change what the acceptance is recorded against.
          state.pending = { draft: message.draft, scope: state.scope };
          state.prompt = disclaimerPrompt(message.draft.value, timeZone());
          await post({ type: 'disclaimer', prompt: state.prompt });
          break;
        }
        case 'accept-disclaimer': {
          const draft = state.pending?.draft;
          const scope = state.pending?.scope;
          if (!draft || !scope) { await post({ type: 'error', text: 'Resolve a target and choose a mode before accepting the disclaimer.' }); break; }
          const region = message.region ?? state.prompt?.detectedRegion ?? 'us';
          const entry = regionEntry(region);
          if (!entry) { await post({ type: 'error', text: `${region} is not one of the twelve supported regions.` }); break; }
          const identity = deps.identity();
          const acceptance: DisclaimerAcceptance = {
            acceptor: message.acceptor,
            osUser: identity.osUser,
            machine: identity.machine,
            extensionVersion: deps.extensionVersion(),
            textVersion: entry.textVersion,
            region: entry.code,
            acceptedAt: now()
          };
          const sandbox = deps.sandboxTier();
          const engagement = buildEngagement({ draft, scope, acceptance, workspace: deps.storeDirectory(), sandbox: sandbox === 'disabled' ? { tier: sandbox, reason: 'no container runtime and the temporary tier is not available' } : { tier: sandbox } });
          // A stale acceptance is refused before anything is written (D-18).
          const snapshot = acceptanceSnapshot(engagement, deps.extensionVersion());
          if (needsReacceptance({ ...acceptance, scope: scopeFingerprint(scope) }, snapshot)) {
            await post({ type: 'error', text: 'The acceptance does not match this engagement (region, scope, extension version, or statement text); accept again.' });
            break;
          }
          const created = await deps.engagements.create(engagement);
          state.engagementId = created.id;
          const wanted = await modelFor(created.id);
          await post({ type: 'engagement', engagement: { id: created.id, target: created.target, region: created.region, modes: created.allowedModes, sandbox: created.sandbox }, model: wanted.model, ...(wanted.note ? { modelNote: wanted.note } : {}) });
          break;
        }
        case 'decline-disclaimer': {
          // Nothing is created and nothing is written: the target stays untouched (CYBER-03).
          state.draft = undefined;
          state.pending = undefined;
          state.prompt = undefined;
          state.engagementId = undefined;
          await post({ type: 'declined' });
          break;
        }
        case 'run': {
          // The controller exists before the first await, so a Stop arriving immediately still finds it.
          const controller = new AbortController();
          state.controller = controller;
          state.runId = undefined;
          const engagement = await deps.engagements.get(message.engagementId);
          if (!engagement) { await post({ type: 'error', text: 'That engagement no longer exists.' }); break; }
          const vehicle = message.vehicle ?? defaultVehicle(message.depth).vehicle;
          // The run's model is the one the page names, or the engagement's own choice by this rule: a scan never falls back to a
          // safety-tuned chat model just because the page did not send one.
          const runModel = message.model ?? (await modelFor(engagement.id)).model;
          // The chat vehicle hands the run to a conversation, so it outlives this panel and can be
          // steered by typing; the panel vehicle keeps the tighter timeline but dies with the panel.
          if (vehicle === 'chat') {
            await deps.handToChat({ engagement, mode: message.mode, depth: message.depth, model: runModel });
            await post({ type: 'handed-to-chat', engagementId: engagement.id, survivesPanelClose: true });
            break;
          }
          await post({ type: 'run-started', engagementId: engagement.id, survivesPanelClose: false });
          let focused = false;
          const result = await deps.startRun({
            engagement,
            mode: message.mode,
            depth: message.depth,
            model: runModel,
            signal: controller.signal,
            onEvent: (event) => {
              if (!focused) { focused = true; host.reveal?.(); }
              if (event.type === 'done') state.runId = event.runId;
              void post({ type: 'event', event });
            }
          });
          state.runId = result.runId;
          await post({ type: 'run-finished', runId: result.runId, outcome: result.outcome });
          break;
        }
        case 'stop': {
          state.controller?.abort();
          await post({ type: 'stopping' });
          break;
        }
        case 'export': {
          const paths = await deps.exportRun({ runId: message.runId, format: message.format });
          await post({ type: 'exported', format: message.format, paths });
          break;
        }
        case 'replay': {
          const replay = await deps.replay(message.runId);
          await post({ type: 'replayed', replay });
          break;
        }
        case 'install-tool': {
          // installOffer never executes anything: the command string goes to the approval-gated runner.
          const command = (await deps.tools()).installCommand(message.tool) ?? installOffer(message.tool);
          if (!command) { await post({ type: 'error', text: `${message.tool} has no install command in the catalogue.` }); break; }
          const outcome = await deps.installTool(message.tool, command);
          await post({ type: 'installed', tool: message.tool, ...outcome });
          break;
        }
        case 'select-model': {
          await deps.models.write(message.engagementId, message.model);
          await post({ type: 'model-selected', engagementId: message.engagementId, model: message.model });
          break;
        }
      }
    } catch (error) {
      await post({ type: 'error', text: (error as Error).message });
    }
  })];
  return { dispose: () => { for (const subscription of subscriptions) subscription.dispose(); } };
}

/** The default resolver: the domain's own, with the OS time zone for the modal. */
export const defaultResolve = (kind: string, value: string): Promise<ResolvedScope> => resolveTarget({ kind: kind as Engagement['target']['kind'], value });
