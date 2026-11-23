import * as vscode from 'vscode';
import { parseGuideAnswers, type OpenGetStarted, type OpenGetStartedRequest } from '../../domain/setup/answers';
import { isRecord } from '../../domain/gate/shape';
import { parseGuideInbound, type GuideInbound, type GuideOutbound } from '../../domain/setup/guideMessages';
import { KIND_OF_WORK_STATE_KEY } from '../../domain/setup/ids';
import { setupRegistries, type SetupRegistries } from '../../domain/setup/registries';
import { GET_STARTED_BODY, GET_STARTED_PAGE } from '../../domain/setup/screens';
import { projectLogKey } from '../../gate/decisionLog';
import { openPanel } from '../webview/openPanel';
import { definePage, listenTo, postTo } from '../webview/protocol';
import { memoryOnlyDeviceProvider } from './deviceFacts';
import { createGuideController, type GuideController, type GuideControllerDeps } from './guideController';
import { createLocalServersSource, type LocalServersDeps } from './localServersOption';
import { createNearAiSource, createScopedNearAiSource, type NearAiOptionDeps, type ScopedNearAiOptionDeps } from './nearAiOption';

export { gateGuidePolicy } from './guideFacts';

const page = definePage<GuideInbound, GuideOutbound>(parseGuideInbound);
const progressKeyPrefix = 'nearAi.setup.progress.';

export interface GetStartedDeps {
  readonly registries?: SetupRegistries;
  readonly sources?: {
    readonly local: LocalServersDeps;
    readonly near: NearAiOptionDeps | ScopedNearAiOptionDeps;
    readonly device?: Parameters<typeof memoryOnlyDeviceProvider>[0];
  };
  /** Capture the current project and its trusted service adapters when the panel opens. */
  createRun(request: OpenGetStartedRequest | undefined, registries: SetupRegistries): Omit<GuideControllerDeps, 'post' | 'close'>;
}

function registerSources(registries: SetupRegistries, deps: NonNullable<GetStartedDeps['sources']>): vscode.Disposable {
  const registrations: vscode.Disposable[] = [];
  const dispose = () => registrations.reverse().forEach((registration) => registration.dispose());
  try {
    registrations.push(registries.options.register(createLocalServersSource(deps.local)));
    const near = 'profiles' in deps.near ? createScopedNearAiSource(deps.near) : createNearAiSource(deps.near);
    registrations.push(registries.options.register(near));
    registrations.push(registries.devices.register(memoryOnlyDeviceProvider(deps.device)));
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function registerGetStarted(context: Pick<vscode.ExtensionContext, 'extensionUri' | 'workspaceState' | 'globalState'>, deps: GetStartedDeps): {
  openGetStarted: OpenGetStarted; dispose(): void;
} {
  let view: vscode.WebviewPanel | undefined;
  let controller: GuideController | undefined;
  let closing: Promise<void> | undefined;
  let registeredSources: vscode.Disposable | undefined;
  let disposed = false;
  const kindStore: NonNullable<GuideControllerDeps['kindStore']> = {
    get() {
      const remembered = context.globalState.get(KIND_OF_WORK_STATE_KEY);
      if (!isRecord(remembered)) return undefined;
      const parsed = parseGuideAnswers({ data: [], kindOfWork: remembered.kindOfWork, otherKind: remembered.otherKind });
      if (!parsed?.kindOfWork) return undefined;
      return { kindOfWork: parsed.kindOfWork, otherKind: parsed.kindOfWork === 'something-else' ? parsed.otherKind : undefined };
    },
    set: (kindOfWork, otherKind) => context.globalState.update(KIND_OF_WORK_STATE_KEY,
      { kindOfWork, ...(kindOfWork === 'something-else' && otherKind !== undefined ? { otherKind } : {}) })
  };

  const openGetStarted: OpenGetStarted = async (request) => {
    while (closing) await closing;
    if (disposed) return;
    if (view) { view.reveal(); await controller?.receive({ type: 'ready' }); return; }
    const registries = deps.registries ?? setupRegistries();
    const firstRegistration = !registeredSources && deps.sources ? registerSources(registries, deps.sources) : undefined;
    let run: ReturnType<GetStartedDeps['createRun']>;
    let panel: vscode.WebviewPanel;
    try {
      run = deps.createRun(request, registries);
      panel = openPanel(context, { ...GET_STARTED_PAGE, body: GET_STARTED_BODY });
    } catch (error) {
      firstRegistration?.dispose();
      throw error;
    }
    registeredSources ??= firstRegistration;
    const key = progressKeyPrefix + projectLogKey(run.root);
    const progress: NonNullable<GuideControllerDeps['progress']> = {
      read: () => context.workspaceState.get(key),
      write: (value) => context.workspaceState.update(key, value)
    };
    const active = createGuideController({ ...run, progress, kindStore, post: (message) => postTo(panel.webview, message), close: () => panel.dispose() });
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

  return {
    openGetStarted,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { view?.dispose(); } finally { registeredSources?.dispose(); }
    }
  };
}
