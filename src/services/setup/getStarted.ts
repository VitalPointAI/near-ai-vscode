import * as vscode from 'vscode';
import type { PrivacyModeSetting } from '../../domain/config';
import { isDefaultBundle } from '../../domain/gate/bundle';
import { narrowResidency } from '../../domain/gate/residency';
import type { OpenGetStarted, OpenGetStartedRequest } from '../../domain/setup/answers';
import { parseGuideInbound, type GuideInbound, type GuideOutbound } from '../../domain/setup/guideMessages';
import { GET_STARTED_BODY, GET_STARTED_PAGE } from '../../domain/setup/screens';
import type { GateHost } from '../../gate/host';
import { openPanel } from '../webview/openPanel';
import { definePage, listenTo, postTo } from '../webview/protocol';
import { createGuideController, type GuideController, type GuideControllerDeps } from './guideController';
import { floorTierOf } from './guideFacts';
import { readProjectLayer } from './projectStore';

const page = definePage<GuideInbound, GuideOutbound>(parseGuideInbound);

export interface GetStartedDeps {
  /** Capture the current project and its trusted service adapters when the panel opens. */
  createRun(request?: OpenGetStartedRequest): Omit<GuideControllerDeps, 'post' | 'close'>;
}

/** Adapter for the guide's decisions. Expired or unreadable policies never supply a usable route. */
export function gateGuidePolicy(gate: GateHost, root: string, privacy: () => PrivacyModeSetting): GuideControllerDeps['readPolicy'] {
  return async (now) => {
    const runtime = await gate.runtimeFor({ root, actor: { kind: 'person', sessionId: 'get-started' }, presence: 'person', context: 'interactive' });
    const initial = runtime.bundleState();
    const label = initial.state === 'valid' ? await gate.labelsFor(root).view(initial.bundle.scales) : undefined;
    const state = runtime.bundleState();
    const layers = gate.policyLayers();
    const organization = layers.organization;
    const route = runtime.routePolicy?.(now);
    if (initial.state !== 'valid' || state.state !== 'valid' || state.hash !== initial.hash || !route || !label || organization.state === 'failed') {
      return { view: {
        organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: state.state === 'failed-closed' ? state.sentence : undefined,
        failedContacts: organization.state === 'failed' ? organization.contacts : undefined
      } };
    }
    const resolved = label.resolve('', state.bundle.defaultLabel);
    if (!['verified', 'none'].includes(label.state) || resolved.mark.length > 1 || resolved.raisedByUnverified) {
      return { view: { organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: 'Review this project’s labels before choosing a connection.' } };
    }
    const project = readProjectLayer(root, state.bundle.scales);
    if (project.state === 'unreadable') {
      return { view: { organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: 'Review this project’s settings before choosing a connection.' } };
    }
    return {
      view: { organization: organization.state, effective: layers.effective,
        startingRules: organization.state === 'none' && isDefaultBundle(state.bundle), issuedHere: false },
      hash: state.hash, route: { ...route, residency: narrowResidency(route.residency, project.state === 'valid' ? project.layer.residency : undefined) },
      routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel,
      projectLabel: resolved.mark[0], floor: floorTierOf(privacy())
    };
  };
}

export function registerGetStarted(context: Pick<vscode.ExtensionContext, 'extensionUri'>, deps: GetStartedDeps): {
  openGetStarted: OpenGetStarted; dispose(): void;
} {
  let view: vscode.WebviewPanel | undefined;
  let controller: GuideController | undefined;
  let disposed = false;

  const openGetStarted: OpenGetStarted = async (request) => {
    if (disposed) return;
    if (view) { view.reveal(); await controller?.receive({ type: 'ready' }); return; }
    const run = deps.createRun(request);
    const panel = openPanel(context, { ...GET_STARTED_PAGE, body: GET_STARTED_BODY });
    const active = createGuideController({ ...run, post: (message) => postTo(panel.webview, message), close: () => panel.dispose() });
    view = panel;
    controller = active;
    const messages = listenTo(panel.webview, page, (message) => active.receive(message));
    const visibility = panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) void active.receive({ type: 'ready' });
    });
    panel.onDidDispose(() => {
      messages.dispose();
      visibility.dispose();
      active.dispose();
      if (view === panel) { view = undefined; controller = undefined; }
    });
    await active.open(request);
  };

  return { openGetStarted, dispose() { disposed = true; view?.dispose(); } };
}
