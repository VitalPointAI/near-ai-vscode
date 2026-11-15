// A recording stand-in for the vscode module, installed through Module._load for a whole test file.
// Modules that import 'vscode' must be required AFTER installVscodeStub, so a test file installs the stub first and loads them lazily.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
export interface RecordedStatusBarItem { text: string; tooltip: string; command?: string; visible: boolean; disposed: boolean; backgroundColor?: unknown }

export interface VscodeStub {
  vscode: unknown;
  outputChannels: Array<{ name: string; lines: string[] }>;
  statusBarItems: RecordedStatusBarItem[];
  notifications: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  // The action buttons of notifications[i], at the same index.
  notificationActions: string[][];
  configUpdates: unknown[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  // Answers handed to showInputBox and to the show*Message calls, in order. An empty queue answers undefined (dismissed).
  inputAnswers: Array<string | undefined>;
  // The options each showInputBox call received, in order.
  inputRequests: Array<{ prompt?: string; title?: string; value?: string; placeHolder?: string }>;
  messageAnswers: Array<string | undefined>;
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
  const config = new Map<string, unknown>();
  const windowListeners = new Set<(state: { focused: boolean; active: boolean }) => void>();
  const configListeners = new Set<ConfigListener>();
  const windowState = { focused: true, active: true };

  const message = (level: 'info' | 'warn' | 'error') => async (text: string, ...actions: string[]): Promise<string | undefined> => {
    notifications.push({ level, message: text });
    notificationActions.push(actions);
    return messageAnswers.shift();
  };

  const vscode = {
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
          set backgroundColor(value: unknown) { item.backgroundColor = value; },
          get backgroundColor(): unknown { return item.backgroundColor; },
          show: (): void => { item.visible = true; },
          hide: (): void => { item.visible = false; },
          dispose: (): void => { item.disposed = true; item.visible = false; }
        };
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warn'),
      showErrorMessage: message('error'),
      showInputBox: async (options?: { prompt?: string; title?: string; value?: string; placeHolder?: string }): Promise<string | undefined> => {
        inputRequests.push({ ...options });
        return inputAnswers.shift();
      },
      withProgress: async <T>(_options: unknown, task: (progress: { report(value: unknown): void }) => PromiseLike<T>): Promise<T> => task({ report: (): void => undefined })
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
      executeCommand: async (name: string, ...args: unknown[]): Promise<unknown> => commands.get(name)?.(...args)
    }
  };

  return {
    vscode, outputChannels, statusBarItems, notifications, notificationActions, configUpdates, commands, inputAnswers, inputRequests, messageAnswers,
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
  secrets: unknown;
}

// The few ExtensionContext members Team Mode uses. Cast it with `as never` where an ExtensionContext is expected.
export function createFakeContext(globalStoragePath: string, secrets: unknown): FakeContext {
  return { subscriptions: [], globalStorageUri: { fsPath: globalStoragePath }, secrets };
}
