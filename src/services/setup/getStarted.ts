import * as vscode from 'vscode';
import type { OpenGetStarted, OpenGetStartedRequest } from '../../domain/setup/answers';
import { parseGuideInbound, type GuideInbound, type GuideOutbound } from '../../domain/setup/guideMessages';
import { GET_STARTED_BODY, GET_STARTED_PAGE } from '../../domain/setup/screens';
import { projectLogKey } from '../../gate/decisionLog';
import { openPanel } from '../webview/openPanel';
import { definePage, listenTo, postTo } from '../webview/protocol';
import { createGuideController, type GuideController, type GuideControllerDeps } from './guideController';

export { gateGuidePolicy } from './guideFacts';

const page = definePage<GuideInbound, GuideOutbound>(parseGuideInbound);
const progressKeyPrefix = 'nearAi.setup.progress.';

export interface GetStartedDeps {
  /** Capture the current project and its trusted service adapters when the panel opens. */
  createRun(request?: OpenGetStartedRequest): Omit<GuideControllerDeps, 'post' | 'close'>;
}

export function registerGetStarted(context: Pick<vscode.ExtensionContext, 'extensionUri' | 'workspaceState'>, deps: GetStartedDeps): {
  openGetStarted: OpenGetStarted; dispose(): void;
} {
  let view: vscode.WebviewPanel | undefined;
  let controller: GuideController | undefined;
  let closing: Promise<void> | undefined;
  let disposed = false;

  const openGetStarted: OpenGetStarted = async (request) => {
    while (closing) await closing;
    if (disposed) return;
    if (view) { view.reveal(); await controller?.receive({ type: 'ready' }); return; }
    const run = deps.createRun(request);
    const panel = openPanel(context, { ...GET_STARTED_PAGE, body: GET_STARTED_BODY });
    const key = progressKeyPrefix + projectLogKey(run.root);
    const progress: NonNullable<GuideControllerDeps['progress']> = {
      read: () => context.workspaceState.get(key),
      write: (value) => context.workspaceState.update(key, value)
    };
    const active = createGuideController({ ...run, progress, post: (message) => postTo(panel.webview, message), close: () => panel.dispose() });
    view = panel;
    controller = active;
    const messages = listenTo(panel.webview, page, (message) => active.receive(message));
    const visibility = panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) void active.receive({ type: 'ready' });
    });
    panel.onDidDispose(() => {
      messages.dispose();
      visibility.dispose();
      const save = active.dispose().catch(() => undefined);
      closing = save;
      void save.then(() => { if (closing === save) closing = undefined; });
      if (view === panel) { view = undefined; controller = undefined; }
    });
    await active.open(request);
  };

  return { openGetStarted, dispose() { disposed = true; view?.dispose(); } };
}
