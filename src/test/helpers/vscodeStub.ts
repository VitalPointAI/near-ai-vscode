// A recording stand-in for the vscode module, installed through Module._load for a whole test file.
// Modules that import 'vscode' must be required AFTER installVscodeStub, so a test file installs the stub first and loads them lazily.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
export interface RecordedStatusBarItem { text: string; tooltip: string; command?: string; visible: boolean; disposed: boolean; backgroundColor?: unknown; accessibilityInformation?: { label: string; role?: string } }

// A webview surface the stub hands to code under test: the recorded html, options and posted messages, plus the hooks a test uses to play the page
// (receive) and the editor (setVisible, dispose). Both createWebviewPanel and a resolved view provider produce one.
export interface RecordedWebview {
  html: string;
  options: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: Array<{ fsPath: string }> };
  cspSource: string;
  // Every message the host posted to the page, in order.
  posted: unknown[];
  visible: boolean;
  disposed: boolean;
  // Messages posted while the surface was hidden (VS Code would drop them).
  postedWhileHidden: number;
  // As if the page posted this message; resolves when every host listener has finished.
  receive(message: unknown): Promise<void>;
  setVisible(visible: boolean): void;
  dispose(): void;
}
export interface RecordedWebviewPanel extends RecordedWebview { viewType: string; title: string; column: unknown; revealCalls: number }
export interface RecordedViewProvider { viewType: string; provider: { resolveWebviewView(view: unknown, context?: unknown, token?: unknown): unknown }; options?: unknown }

export interface VscodeStub {
  vscode: unknown;
  // Every createWebviewPanel call, in order.
  webviewPanels: RecordedWebviewPanel[];
  // Every registerWebviewViewProvider call, in order (removed again when its disposable is disposed).
  viewProviders: RecordedViewProvider[];
  // A webview view as VS Code would hand to resolveWebviewView, with the same recording hooks as a panel.
  createWebviewView(): { view: unknown; record: RecordedWebview };
  outputChannels: Array<{ name: string; lines: string[] }>;
  statusBarItems: RecordedStatusBarItem[];
  notifications: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  // The action buttons of notifications[i], at the same index.
  notificationActions: string[][];
  // The options object passed to the show*Message call that made notifications[i] (modal flag and detail text), or undefined when none was passed.
  notificationOptions: Array<{ modal?: boolean; detail?: string } | undefined>;
  configUpdates: unknown[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  // Answers handed to showInputBox and to the show*Message calls, in order. An empty queue answers undefined (dismissed).
  inputAnswers: Array<string | undefined>;
  // The options each showInputBox call received, in order.
  inputRequests: Array<{ prompt?: string; title?: string; value?: string; placeHolder?: string; password?: boolean; validateInput?: (value: string) => string | undefined }>;
  messageAnswers: Array<string | undefined>;
  // Answers handed to showQuickPick, in order: the label of the item to choose, or undefined to dismiss. A label no item has throws, so a test cannot
  // silently pick the wrong thing. The chosen item object (or string) is returned to the caller.
  quickPickAnswers: Array<string | undefined>;
  // Answers handed to showOpenDialog, in order: the paths picked, or undefined to dismiss. Each call's options are kept in openDialogRequests.
  openDialogAnswers: Array<string[] | undefined>;
  openDialogRequests: Array<Record<string, unknown>>;
  // What each showQuickPick call offered, in order.
  quickPickRequests: Array<{ title?: string; placeHolder?: string; labels: string[]; descriptions: string[]; details: string[] }>;
  // Every text written with vscode.env.clipboard.writeText, in order.
  clipboardWrites: string[];
  // Commands executeCommand was asked to run that no registered handler owns (for example git.clone), in order.
  externalCommands: Array<{ command: string; args: unknown[] }>;
  // Every address passed to vscode.env.openExternal, in order.
  openedExternal: string[];
  // Every withProgress call, in order: its title, whether it offered Cancel, and each message it reported.
  progress: Array<{ title?: string; cancellable: boolean; messages: string[] }>;
  // When set, a progress whose reported message makes this return true has its cancellation token cancelled at that moment, as if the person
  // clicked Cancel on the notification.
  setProgressCancel(when: ((title: string, message: string) => boolean) | undefined): void;
  // When set, decides the button each show*Message call returns (given its text, its buttons and its options) instead of the messageAnswers queue.
  // Use it where which messages carry buttons is not the point of the test, so a message without buttons cannot use up an answer.
  setMessageResponder(responder: ((text: string, actions: string[], options?: { modal?: boolean; detail?: string }) => string | undefined) | undefined): void;
  setConfig(key: string, value: unknown): void;
  // The folders the window reports; an empty list means no folder is open.
  setWorkspaceFolders(paths: string[]): void;
  // Sets the window state the way VS Code's ExtHostWindow reports it: one onDidChangeWindowState event per property that actually
  // changed (focused first, then active), each carrying the whole state after that change, and no event when nothing changed (IN-03).
  // Active defaults to focused. Changing only active delivers an activity-only event, which VS Code also sends.
  fireWindowState(focused: boolean, active?: boolean): void;
}

type ConfigListener = (event: { affectsConfiguration(section: string): boolean }) => void;

export function createVscodeStub(): VscodeStub {
  const outputChannels: VscodeStub['outputChannels'] = [];
  const statusBarItems: VscodeStub['statusBarItems'] = [];
  const notifications: VscodeStub['notifications'] = [];
  const notificationActions: string[][] = [];
  const configUpdates: unknown[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const inputAnswers: VscodeStub['inputAnswers'] = [];
  const inputRequests: VscodeStub['inputRequests'] = [];
  let workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined;
  const messageAnswers: VscodeStub['messageAnswers'] = [];
  const notificationOptions: VscodeStub['notificationOptions'] = [];
  const quickPickAnswers: VscodeStub['quickPickAnswers'] = [];
  const openDialogAnswers: VscodeStub['openDialogAnswers'] = [];
  const openDialogRequests: VscodeStub['openDialogRequests'] = [];
  const quickPickRequests: VscodeStub['quickPickRequests'] = [];
  const clipboardWrites: string[] = [];
  const externalCommands: VscodeStub['externalCommands'] = [];
  const openedExternal: string[] = [];
  const progress: VscodeStub['progress'] = [];
  let progressCancel: Parameters<VscodeStub['setProgressCancel']>[0];
  let messageResponder: Parameters<VscodeStub['setMessageResponder']>[0];
  const config = new Map<string, unknown>();
  const windowListeners = new Set<(state: { focused: boolean; active: boolean }) => void>();
  const configListeners = new Set<ConfigListener>();
  const windowState = { focused: true, active: true };

  // showInformationMessage(text, ...actions) or showInformationMessage(text, { modal, detail }, ...actions), as in VS Code. An action is a string or a
  // MessageItem ({ title, isCloseAffordance }); the answer queue holds titles, and a MessageItem action is answered with the item itself, as VS Code does.
  const message = (level: 'info' | 'warn' | 'error') => async (text: string, ...rest: Array<string | { title: string; isCloseAffordance?: boolean } | { modal?: boolean; detail?: string }>): Promise<unknown> => {
    const first = rest[0];
    const isOptions = (value: unknown): value is { modal?: boolean; detail?: string } => typeof value === 'object' && value !== null && !('title' in value);
    const options = isOptions(first) ? first : undefined;
    const items = rest.filter((item): item is string | { title: string; isCloseAffordance?: boolean } => typeof item === 'string' || (typeof item === 'object' && item !== null && 'title' in item));
    const actions = items.map((item) => (typeof item === 'string' ? item : item.title));
    notifications.push({ level, message: text });
    notificationActions.push(actions);
    notificationOptions.push(options === undefined ? undefined : { ...options });
    const answer = messageResponder !== undefined ? messageResponder(text, actions, options) : messageAnswers.shift();
    if (answer === undefined) return undefined;
    const index = actions.indexOf(answer);
    return index < 0 ? answer : items[index];
  };

  const showQuickPick = async (
    items: unknown, options?: { title?: string; placeHolder?: string }
  ): Promise<unknown> => {
    const list = (await items) as Array<string | { label: string; description?: string; detail?: string }>;
    const labelOf = (item: string | { label: string }): string => (typeof item === 'string' ? item : item.label);
    quickPickRequests.push({
      ...(options?.title === undefined ? {} : { title: options.title }), ...(options?.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
      labels: list.map(labelOf),
      descriptions: list.map((item) => (typeof item === 'string' ? '' : item.description ?? '')),
      details: list.map((item) => (typeof item === 'string' ? '' : item.detail ?? ''))
    });
    const answer = quickPickAnswers.shift();
    if (answer === undefined) return undefined;
    const chosen = list.find((item) => labelOf(item) === answer);
    if (chosen === undefined) throw new Error(`The test chose "${answer}", which this quick pick did not offer: ${list.map(labelOf).join(' | ')}`);
    return chosen;
  };

  const webviewPanels: RecordedWebviewPanel[] = [];
  const viewProviders: RecordedViewProvider[] = [];

  class StubUri {
    public constructor(public readonly scheme: string, public readonly fsPath: string) {}
    public get path(): string { return this.fsPath; }
    public toString(): string { return `${this.scheme}://${this.fsPath}`; }
    public static file(fsPath: string): StubUri { return new StubUri('file', fsPath); }
    public static joinPath(base: { scheme?: string; fsPath: string }, ...parts: string[]): StubUri { return new StubUri(base.scheme ?? 'file', [base.fsPath, ...parts].join('/').replace(/\/{2,}/g, '/')); }
  }

  // The members of a Webview, a WebviewPanel and a WebviewView that code under test touches. `kind` decides which visibility and dispose events exist.
  const makeWebview = (options: RecordedWebview['options']): { record: RecordedWebview; webview: unknown; visibilityListeners: Set<(visible: boolean) => void>; disposeListeners: Set<() => void> } => {
    const receivers = new Set<(message: unknown) => unknown>();
    const visibilityListeners = new Set<(visible: boolean) => void>();
    const disposeListeners = new Set<() => void>();
    const record: RecordedWebview = {
      html: '', options: { ...options }, cspSource: 'CSP_SOURCE', posted: [], visible: true, disposed: false, postedWhileHidden: 0,
      receive: async (message: unknown): Promise<void> => { await Promise.all([...receivers].map((listener) => listener(message))); },
      setVisible: (visible: boolean): void => {
        if (record.visible === visible) return;
        record.visible = visible;
        for (const listener of [...visibilityListeners]) listener(visible);
      },
      dispose: (): void => {
        if (record.disposed) return;
        record.disposed = true;
        for (const listener of [...disposeListeners]) listener();
      }
    };
    const webview = {
      get html(): string { return record.html; },
      set html(value: string) { record.html = value; },
      get options(): RecordedWebview['options'] { return record.options; },
      set options(value: RecordedWebview['options']) { record.options = { ...value }; },
      cspSource: record.cspSource,
      asWebviewUri: (uri: { fsPath: string }): StubUri => new StubUri('webview', uri.fsPath),
      postMessage: async (message: unknown): Promise<boolean> => {
        if (!record.visible) record.postedWhileHidden += 1;
        record.posted.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: (message: unknown) => unknown): { dispose(): void } => {
        receivers.add(listener);
        return { dispose: (): void => { receivers.delete(listener); } };
      }
    };
    return { record, webview, visibilityListeners, disposeListeners };
  };

  const createWebviewPanel = (viewType: string, title: string, column: unknown, options: RecordedWebview['options'] = {}): unknown => {
    const made = makeWebview(options);
    const record = Object.assign(made.record, { viewType, title, column, revealCalls: 0 }) as RecordedWebviewPanel;
    webviewPanels.push(record);
    return {
      viewType, title, webview: made.webview, iconPath: undefined as unknown,
      get visible(): boolean { return record.visible; },
      reveal: (): void => { record.revealCalls += 1; record.setVisible(true); },
      onDidChangeViewState: (listener: (event: { webviewPanel: { visible: boolean } }) => void): { dispose(): void } => {
        const wrapped = (visible: boolean): void => { listener({ webviewPanel: { visible } }); };
        made.visibilityListeners.add(wrapped);
        return { dispose: (): void => { made.visibilityListeners.delete(wrapped); } };
      },
      onDidDispose: (listener: () => void): { dispose(): void } => {
        made.disposeListeners.add(listener);
        return { dispose: (): void => { made.disposeListeners.delete(listener); } };
      },
      dispose: (): void => { record.dispose(); }
    };
  };

  const createWebviewView = (): { view: unknown; record: RecordedWebview } => {
    const made = makeWebview({});
    return {
      record: made.record,
      view: {
        webview: made.webview,
        get visible(): boolean { return made.record.visible; },
        onDidChangeVisibility: (listener: () => void): { dispose(): void } => {
          const wrapped = (): void => { listener(); };
          made.visibilityListeners.add(wrapped);
          return { dispose: (): void => { made.visibilityListeners.delete(wrapped); } };
        },
        onDidDispose: (listener: () => void): { dispose(): void } => {
          made.disposeListeners.add(listener);
          return { dispose: (): void => { made.disposeListeners.delete(listener); } };
        }
      }
    };
  };

  const vscode = {
    Uri: StubUri,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ThemeColor: class ThemeColor { public constructor(public readonly id: string) {} },
    window: {
      get state(): { focused: boolean; active: boolean } { return { focused: windowState.focused, active: windowState.active }; },
      onDidChangeWindowState: (listener: (state: { focused: boolean; active: boolean }) => void) => {
        windowListeners.add(listener);
        return { dispose: (): void => { windowListeners.delete(listener); } };
      },
      createOutputChannel: (name: string) => {
        const channel = { name, lines: [] as string[] };
        outputChannels.push(channel);
        return {
          name,
          appendLine: (line: string): void => { channel.lines.push(line); },
          show: (): void => undefined,
          dispose: (): void => undefined
        };
      },
      createStatusBarItem: (_id: string, _alignment?: number, _priority?: number) => {
        const item: RecordedStatusBarItem = { text: '', tooltip: '', visible: false, disposed: false };
        statusBarItems.push(item);
        return {
          name: '',
          set text(value: string) { item.text = value; },
          get text(): string { return item.text; },
          set tooltip(value: string | undefined) { item.tooltip = value ?? ''; },
          get tooltip(): string { return item.tooltip; },
          set command(value: string | undefined) { if (value === undefined) delete item.command; else item.command = value; },
          get command(): string | undefined { return item.command; },
          set accessibilityInformation(value: { label: string; role?: string } | undefined) { if (value === undefined) delete item.accessibilityInformation; else item.accessibilityInformation = { ...value }; },
          get accessibilityInformation(): { label: string; role?: string } | undefined { return item.accessibilityInformation; },
          set backgroundColor(value: unknown) { item.backgroundColor = value; },
          get backgroundColor(): unknown { return item.backgroundColor; },
          show: (): void => { item.visible = true; },
          hide: (): void => { item.visible = false; },
          dispose: (): void => { item.disposed = true; item.visible = false; }
        };
      },
      createWebviewPanel,
      registerWebviewViewProvider: (viewType: string, provider: RecordedViewProvider['provider'], options?: unknown): { dispose(): void } => {
        const entry: RecordedViewProvider = { viewType, provider, ...(options === undefined ? {} : { options }) };
        viewProviders.push(entry);
        return { dispose: (): void => { const index = viewProviders.indexOf(entry); if (index >= 0) viewProviders.splice(index, 1); } };
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warn'),
      showErrorMessage: message('error'),
      showInputBox: async (options?: VscodeStub['inputRequests'][number]): Promise<string | undefined> => {
        inputRequests.push({ ...options });
        return inputAnswers.shift();
      },
      showQuickPick,
      showOpenDialog: async (options: Record<string, unknown>): Promise<Array<{ fsPath: string }> | undefined> => {
        openDialogRequests.push(options);
        const answer = openDialogAnswers.shift();
        return answer === undefined ? undefined : answer.map((fsPath) => ({ scheme: 'file', fsPath }));
      },
      // The paste box of the browser sign-in. Tests replace the sign-in, so this only has to exist and be inert.
      createInputBox: () => {
        const none = (): { dispose(): void } => ({ dispose: (): void => undefined });
        return { title: '', prompt: '', password: false, ignoreFocusOut: false, placeholder: '', value: '', validationMessage: undefined as string | undefined,
          onDidChangeValue: none, onDidAccept: none, onDidHide: none, show: (): void => undefined, dispose: (): void => undefined };
      },
      withProgress: async <T>(
        options: { title?: string; cancellable?: boolean } | undefined,
        task: (progress: { report(value: { message?: string }): void }, token: { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }) => PromiseLike<T>
      ): Promise<T> => {
        const record = { ...(options?.title === undefined ? {} : { title: options.title }), cancellable: options?.cancellable === true, messages: [] as string[] };
        progress.push(record);
        const listeners = new Set<() => void>();
        const token = {
          isCancellationRequested: false,
          onCancellationRequested(listener: () => void): { dispose(): void } {
            listeners.add(listener);
            return { dispose: (): void => { listeners.delete(listener); } };
          }
        };
        return task({
          report(value: { message?: string }): void {
            if (value.message === undefined) return;
            record.messages.push(value.message);
            if (record.cancellable && !token.isCancellationRequested && progressCancel?.(record.title ?? '', value.message) === true) {
              token.isCancellationRequested = true;
              for (const listener of [...listeners]) listener();
            }
          }
        }, token);
      }
    },
    workspace: {
      get workspaceFolders(): typeof workspaceFolders { return workspaceFolders; },
      getConfiguration: (section?: string) => ({
        get: <T>(key: string, fallback?: T): T => {
          const full = section === undefined || section === '' ? key : `${section}.${key}`;
          return (config.has(full) ? config.get(full) : fallback) as T;
        },
        update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
          const full = section === undefined || section === '' ? key : `${section}.${key}`;
          configUpdates.push({ key: full, value, target });
          config.set(full, value);
        }
      }),
      onDidChangeConfiguration: (listener: ConfigListener) => {
        configListeners.add(listener);
        return { dispose: (): void => { configListeners.delete(listener); } };
      }
    },
    commands: {
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(name, handler);
        return { dispose: (): void => { commands.delete(name); } };
      },
      executeCommand: async (name: string, ...args: unknown[]): Promise<unknown> => {
        const own = commands.get(name);
        if (own === undefined) {
          externalCommands.push({ command: name, args });
          return undefined;
        }
        return own(...args);
      }
    },
    UIKind: { Desktop: 1, Web: 2 },
    env: {
      uiKind: 1,
      clipboard: { writeText: async (text: string): Promise<void> => { clipboardWrites.push(text); } },
      openExternal: async (target: unknown): Promise<boolean> => { openedExternal.push(String(target)); return true; },
      asExternalUri: async (target: unknown): Promise<unknown> => target
    }
  };

  return {
    vscode, webviewPanels, viewProviders, createWebviewView, outputChannels, statusBarItems, notifications, notificationActions, notificationOptions, configUpdates, commands, inputAnswers, inputRequests, messageAnswers,
    quickPickAnswers, quickPickRequests, openDialogAnswers, openDialogRequests, clipboardWrites, externalCommands, openedExternal, progress,
    setProgressCancel(when): void {
      progressCancel = when;
    },
    setMessageResponder(responder): void {
      messageResponder = responder;
    },
    setWorkspaceFolders(paths: string[]): void {
      workspaceFolders = paths.length === 0 ? undefined : paths.map((fsPath, index) => ({ uri: { fsPath }, name: fsPath.split('/').pop() ?? '', index }));
    },
    setConfig(key: string, value: unknown): void {
      config.set(key, value);
      for (const listener of [...configListeners]) {
        listener({ affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) });
      }
    },
    fireWindowState(focused: boolean, active: boolean = focused): void {
      const fire = (): void => {
        const state = { focused: windowState.focused, active: windowState.active };
        for (const listener of [...windowListeners]) listener({ ...state });
      };
      if (windowState.focused !== focused) {
        windowState.focused = focused;
        fire();
      }
      if (windowState.active !== active) {
        windowState.active = active;
        fire();
      }
    }
  };
}

interface LoadHook { _load: (request: string, parent: unknown, isMain: boolean) => unknown }

// Patches Module._load so require('vscode') returns the stub. The returned function restores the original loader.
export function installVscodeStub(stub: VscodeStub): () => void {
  // require, not import: an interop namespace import would be a copy, and the patch must land on the real module object.
  const hook = require('node:module') as LoadHook;
  const original = hook._load;
  hook._load = (request, parent, isMain): unknown => (request === 'vscode' ? stub.vscode : original(request, parent, isMain));
  return (): void => { hook._load = original; };
}

export interface FakeContext {
  subscriptions: Array<{ dispose(): void }>;
  globalStorageUri: { fsPath: string };
  // The extension folder (the repository root), for code that builds webview resource addresses.
  extensionUri: { scheme: string; fsPath: string };
  secrets: unknown;
}

// The few ExtensionContext members Team Mode uses. Cast it with `as never` where an ExtensionContext is expected.
export function createFakeContext(globalStoragePath: string, secrets: unknown): FakeContext {
  return { subscriptions: [], globalStorageUri: { fsPath: globalStoragePath }, extensionUri: { scheme: 'file', fsPath: require('node:path').resolve(__dirname, '..', '..', '..') as string }, secrets };
}
