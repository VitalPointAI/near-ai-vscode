// A recording stand-in for the vscode module, installed through Module._load for a whole test file.
// Modules that import 'vscode' must be required AFTER installVscodeStub, so a test file installs the stub first and loads them lazily.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
export interface RecordedStatusBarItem { id?: string; name?: string; priority?: number; text: string; tooltip: string; command?: string; visible: boolean; disposed: boolean; backgroundColor?: unknown }

type DocumentUri = { scheme: string; fsPath: string; toString(): string };
type DocumentEdit = { rangeOffset: number; rangeLength: number; text: string };

class StubPosition {
  public constructor(public readonly line: number, public readonly character: number) {}
}

class StubRange {
  public constructor(public readonly start: StubPosition, public readonly end: StubPosition) {}
}

class StubTextEdit {
  public newEol?: number;
  public constructor(public readonly range: StubRange, public readonly newText: string) {}
  public static setEndOfLine(eol: number): StubTextEdit {
    const zero = new StubPosition(0, 0);
    const edit = new StubTextEdit(new StubRange(zero, zero), '');
    edit.newEol = eol;
    return edit;
  }
}

class StubWorkspaceEdit {
  public readonly changes = new Map<DocumentUri, readonly StubTextEdit[]>();
  public set(uri: DocumentUri, edits: readonly StubTextEdit[]): void { this.changes.set(uri, edits); }
}

export class StubTextDocument {
  public version = 1;
  public isClosed = false;
  public constructor(public readonly uri: DocumentUri, public text: string) {}
  public getText(): string { return this.text; }
  public positionAt(offset: number): StubPosition {
    const lines = this.text.slice(0, offset).split('\n');
    return new StubPosition(lines.length - 1, lines[lines.length - 1].length);
  }
  public offsetAt(position: StubPosition): number {
    const lines = this.text.split('\n');
    return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, position.character);
  }
}

export interface VscodeStub {
  vscode: unknown;
  fireDocumentOpen(path: string, text: string): StubTextDocument;
  fireDocumentChange(document: StubTextDocument, edits: readonly DocumentEdit[], reason?: number): void;
  fireDocumentClose(document: StubTextDocument): void;
  setActiveDocument(document: StubTextDocument | undefined): void;
  documentChangeListeners(): number;
  beforeNextWorkspaceEdit(action: () => void): void;
  workspaceEdits: Array<{ uri: string; version: number; applied: boolean; edits: readonly StubTextEdit[] }>;
  outputChannels: Array<{ name: string; lines: string[] }>;
  statusBarItems: RecordedStatusBarItem[];
  notifications: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  // The action buttons of notifications[i], at the same index.
  notificationActions: string[][];
  configUpdates: unknown[];
  // Every setContext call in order, and the latest value per key.
  setContextCalls: Array<{ key: string; value: unknown }>;
  contextKeys: Map<string, unknown>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  // Answers handed to showInputBox and to the show*Message calls, in order. An empty queue answers undefined (dismissed).
  inputAnswers: Array<string | undefined>;
  // The options each showInputBox call received, in order.
  inputRequests: Array<{ prompt?: string; title?: string; value?: string; placeHolder?: string }>;
  messageAnswers: Array<string | undefined>;
  // The text of every document shown with showTextDocument (opened through a registered content provider), in order.
  shownDocuments: Array<{ uri: string; text: string; languageId?: string; options?: { preview?: boolean; preserveFocus?: boolean; viewColumn?: number } }>;
  // The content providers registered by scheme.
  contentProviders: Map<string, { provideTextDocumentContent(uri: unknown): string | Promise<string> }>;
  // Answers handed to showQuickPick, in order: an item's label (or a list of labels for a multi-pick). An empty queue answers undefined (dismissed).
  quickPickAnswers: Array<string | string[] | undefined>;
  // Answers handed to showOpenDialog, in order: the paths picked. An empty queue answers undefined (dismissed).
  openDialogAnswers: Array<string[] | undefined>;
  // Answers handed to showSaveDialog, in order: the path chosen. An empty queue answers undefined (dismissed).
  saveDialogAnswers: Array<string | undefined>;
  // The options of each showSaveDialog call, in order.
  saveDialogRequests: Array<{ title?: string; defaultPath?: string; filters?: Record<string, string[]> }>;
  // What each showQuickPick call was shown: its items' labels, details and the options.
  quickPickRequests: Array<{ items: Array<{ label: string; description?: string; detail?: string }>; placeHolder?: string; title?: string; canPickMany?: boolean }>;
  // The options of each show*Message call that passed any (modal, detail), in order.
  messageOptions: Array<{ message: string; modal?: boolean; detail?: string }>;
  // Fires workspace.onDidRenameFiles with these renames (absolute paths).
  fireRename(files: Array<{ from: string; to: string }>): Promise<void>;
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
  const setContextCalls: VscodeStub['setContextCalls'] = [];
  const contextKeys = new Map<string, unknown>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const inputAnswers: VscodeStub['inputAnswers'] = [];
  const inputRequests: VscodeStub['inputRequests'] = [];
  let workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined;
  const messageAnswers: VscodeStub['messageAnswers'] = [];
  const shownDocuments: VscodeStub['shownDocuments'] = [];
  const contentProviders: VscodeStub['contentProviders'] = new Map();
  const config = new Map<string, unknown>();
  const windowListeners = new Set<(state: { focused: boolean; active: boolean }) => void>();
  const configListeners = new Set<ConfigListener>();
  const folderListeners = new Set<(event: { added: unknown[]; removed: unknown[] }) => void>();
  const windowState = { focused: true, active: true };

  const quickPickAnswers: VscodeStub['quickPickAnswers'] = [];
  const openDialogAnswers: VscodeStub['openDialogAnswers'] = [];
  const saveDialogAnswers: VscodeStub['saveDialogAnswers'] = [];
  const saveDialogRequests: VscodeStub['saveDialogRequests'] = [];
  const quickPickRequests: VscodeStub['quickPickRequests'] = [];
  const messageOptions: VscodeStub['messageOptions'] = [];
  const renameListeners = new Set<(event: { files: Array<{ oldUri: { fsPath: string }; newUri: { fsPath: string } }> }) => unknown>();
  const message = (level: 'info' | 'warn' | 'error') => async (text: string, ...rest: unknown[]): Promise<string | undefined> => {
    const first = rest[0];
    const options = typeof first === 'object' && first !== null ? first as { modal?: boolean; detail?: string } : undefined;
    if (options !== undefined) messageOptions.push({ message: text, ...(options.modal === undefined ? {} : { modal: options.modal }), ...(options.detail === undefined ? {} : { detail: options.detail }) });
    notifications.push({ level, message: text });
    notificationActions.push(rest as string[]);
    return messageAnswers.shift();
  };

  const documents = new Set<StubTextDocument>();
  type StubTextEditor = { document: StubTextDocument };
  let activeTextEditor: StubTextEditor | undefined;
  const activeEditorListeners = new Set<(editor: StubTextEditor | undefined) => void>();
  const setActiveDocument = (document: StubTextDocument | undefined): void => {
    if (activeTextEditor?.document === document) return;
    activeTextEditor = document === undefined ? undefined : { document };
    for (const listener of [...activeEditorListeners]) listener(activeTextEditor);
  };
  const openDocumentListeners = new Set<(document: StubTextDocument) => void>();
  const closeDocumentListeners = new Set<(document: StubTextDocument) => void>();
  const changeDocumentListeners = new Set<(event: { document: StubTextDocument; contentChanges: readonly DocumentEdit[]; reason?: number }) => void>();
  const workspaceEdits: VscodeStub['workspaceEdits'] = [];
  let beforeWorkspaceEdit: (() => void) | undefined;
  const listen = <T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): { dispose(): void } => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  };
  const changeDocument = (document: StubTextDocument, contentChanges: readonly DocumentEdit[], reason?: number, eol?: number): void => {
    let text = document.text;
    for (const { rangeOffset, rangeLength, text: replacement } of [...contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      text = text.slice(0, rangeOffset) + replacement + text.slice(rangeOffset + rangeLength);
    }
    document.text = eol === 1 ? text.replaceAll('\r\n', '\n') : text;
    document.version += 1;
    for (const listener of [...changeDocumentListeners]) listener({ document, contentChanges, reason });
  };

  const vscode = {
    Position: StubPosition,
    Range: StubRange,
    TextEdit: StubTextEdit,
    WorkspaceEdit: StubWorkspaceEdit,
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    EndOfLine: { LF: 1, CRLF: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ThemeColor: class ThemeColor { public constructor(public readonly id: string) {} },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    Uri: {
      // As VS Code's own Uri.from: the parts are kept, and toString encodes the path and query.
      from: (parts: { scheme: string; path: string; query?: string }) => ({ scheme: parts.scheme, path: parts.path, query: parts.query ?? '', toString: (): string => `${parts.scheme}:${encodeURI(parts.path).replace(/:/g, '%3A')}${parts.query ? `?${parts.query}` : ''}` }),
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: (): string => `file://${fsPath}` }),
      parse: (value: string) => {
        const colon = value.indexOf(':');
        const scheme = value.slice(0, colon);
        const rest = value.slice(colon + 1);
        return { scheme, path: rest, toString: (): string => value };
      }
    },
    EventEmitter: class EventEmitter<T> {
      private readonly listeners = new Set<(value: T) => void>();
      public readonly event = (listener: (value: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: (): void => { this.listeners.delete(listener); } };
      };
      public fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
      public dispose(): void { this.listeners.clear(); }
    },
    window: {
      get activeTextEditor(): StubTextEditor | undefined { return activeTextEditor; },
      onDidChangeActiveTextEditor: (listener: (editor: StubTextEditor | undefined) => void) => listen(activeEditorListeners, listener),
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
      createStatusBarItem: (id: string, _alignment?: number, priority?: number) => {
        const item: RecordedStatusBarItem = { id, ...(priority === undefined ? {} : { priority }), text: '', tooltip: '', visible: false, disposed: false };
        statusBarItems.push(item);
        return {
          set name(value: string) { item.name = value; },
          get name(): string { return item.name ?? ''; },
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
      showQuickPick: async (items: Array<{ label: string; description?: string; detail?: string }>, options?: { placeHolder?: string; title?: string; canPickMany?: boolean }): Promise<unknown> => {
        const list = await Promise.resolve(items);
        quickPickRequests.push({ items: list.map((item) => ({ label: item.label, ...(item.description === undefined ? {} : { description: item.description }), ...(item.detail === undefined ? {} : { detail: item.detail }) })), ...(options ?? {}) });
        const answer = quickPickAnswers.shift();
        if (answer === undefined) return undefined;
        if (Array.isArray(answer)) return list.filter((item) => answer.includes(item.label));
        return list.find((item) => item.label === answer);
      },
      showOpenDialog: async (): Promise<Array<{ fsPath: string }> | undefined> => openDialogAnswers.shift()?.map((fsPath) => ({ fsPath })),
      showSaveDialog: async (options?: { title?: string; defaultUri?: { fsPath?: string }; filters?: Record<string, string[]> }): Promise<{ fsPath: string } | undefined> => {
        saveDialogRequests.push({ ...(options?.title === undefined ? {} : { title: options.title }), ...(options?.defaultUri?.fsPath === undefined ? {} : { defaultPath: options.defaultUri.fsPath }), ...(options?.filters === undefined ? {} : { filters: options.filters }) });
        const answer = saveDialogAnswers.shift();
        return answer === undefined ? undefined : { fsPath: answer };
      },
      showInputBox: async (options?: { prompt?: string; title?: string; value?: string; placeHolder?: string }): Promise<string | undefined> => {
        inputRequests.push({ ...options });
        return inputAnswers.shift();
      },
      showTextDocument: async (document: { uri: { toString(): string }; getText(): string; languageId?: string }, options?: { preview?: boolean; preserveFocus?: boolean; viewColumn?: number }): Promise<unknown> => {
        shownDocuments.push({ uri: document.uri.toString(), text: document.getText(), ...(document.languageId === undefined ? {} : { languageId: document.languageId }), ...(options === undefined ? {} : { options }) });
        return undefined;
      },
      withProgress: async <T>(_options: unknown, task: (progress: { report(value: unknown): void }) => PromiseLike<T>): Promise<T> => task({ report: (): void => undefined })
    },
    languages: {
      // VS Code gives back the same document in its new language.
      setTextDocumentLanguage: async <T extends object>(document: T, languageId: string): Promise<T> => Object.assign(document, { languageId })
    },
    workspace: {
      get textDocuments(): StubTextDocument[] { return [...documents]; },
      onDidOpenTextDocument: (listener: (document: StubTextDocument) => void) => listen(openDocumentListeners, listener),
      onDidCloseTextDocument: (listener: (document: StubTextDocument) => void) => listen(closeDocumentListeners, listener),
      onDidChangeTextDocument: (listener: (event: { document: StubTextDocument; contentChanges: readonly DocumentEdit[]; reason?: number }) => void) =>
        listen(changeDocumentListeners, listener),
      applyEdit: async (edit: StubWorkspaceEdit): Promise<boolean> => {
        for (const [uri, edits] of edit.changes) {
          const document = [...documents].find((candidate) => candidate.uri.toString() === uri.toString());
          if (!document) return false;
          const version = document.version;
          const before = beforeWorkspaceEdit;
          beforeWorkspaceEdit = undefined;
          before?.();
          const applied = !document.isClosed && document.version === version;
          workspaceEdits.push({ uri: uri.toString(), version, applied, edits });
          if (!applied) return false;
          const contentChanges = edits.filter(({ newEol }) => newEol === undefined).map(({ range, newText }) => {
            const rangeOffset = document.offsetAt(range.start);
            return { rangeOffset, rangeLength: document.offsetAt(range.end) - rangeOffset, text: newText };
          });
          changeDocument(document, contentChanges, undefined, edits.find(({ newEol }) => newEol !== undefined)?.newEol);
        }
        return true;
      },
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
      registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: unknown): string | Promise<string> }) => {
        contentProviders.set(scheme, provider);
        return { dispose: (): void => { if (contentProviders.get(scheme) === provider) contentProviders.delete(scheme); } };
      },
      openTextDocument: async (uri: { scheme: string; toString(): string } | { language?: string; content?: string }) => {
        // An untitled document made from text: it has no file, so opening it writes nothing anywhere.
        if (!('scheme' in uri)) {
          const text = uri.content ?? '';
          return { uri: { scheme: 'untitled', toString: (): string => 'untitled:Untitled-1' }, languageId: uri.language ?? 'plaintext', getText: (): string => text };
        }
        const provider = contentProviders.get(uri.scheme);
        const text = provider === undefined ? '' : await provider.provideTextDocumentContent(uri);
        return { uri, getText: (): string => text };
      },
      onDidChangeConfiguration: (listener: ConfigListener) => {
        configListeners.add(listener);
        return { dispose: (): void => { configListeners.delete(listener); } };
      },
      onDidChangeWorkspaceFolders: (listener: (event: { added: unknown[]; removed: unknown[] }) => void) => {
        folderListeners.add(listener);
        return { dispose: (): void => { folderListeners.delete(listener); } };
      },
      onDidRenameFiles: (listener: (event: { files: Array<{ oldUri: { fsPath: string }; newUri: { fsPath: string } }> }) => unknown) => {
        renameListeners.add(listener);
        return { dispose: (): void => { renameListeners.delete(listener); } };
      },
      getWorkspaceFolder: (uri: { fsPath: string }) => (workspaceFolders ?? []).find((folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`))
    },
    commands: {
      registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(name, handler);
        return { dispose: (): void => { commands.delete(name); } };
      },
      executeCommand: async (name: string, ...args: unknown[]): Promise<unknown> => {
        if (name === 'setContext') {
          setContextCalls.push({ key: String(args[0]), value: args[1] });
          contextKeys.set(String(args[0]), args[1]);
          return undefined;
        }
        return commands.get(name)?.(...args);
      }
    }
  };

  return {
    vscode, outputChannels, statusBarItems, notifications, notificationActions, configUpdates, setContextCalls, contextKeys, commands, inputAnswers, inputRequests, messageAnswers, shownDocuments, contentProviders,
    quickPickAnswers, quickPickRequests, messageOptions, openDialogAnswers, saveDialogAnswers, saveDialogRequests,
    workspaceEdits,
    documentChangeListeners: () => changeDocumentListeners.size,
    beforeNextWorkspaceEdit(action) { beforeWorkspaceEdit = action; },
    fireDocumentOpen(path, text) {
      const document = new StubTextDocument(vscode.Uri.file(path), text);
      documents.add(document);
      for (const listener of [...openDocumentListeners]) listener(document);
      return document;
    },
    fireDocumentChange: changeDocument,
    setActiveDocument,
    fireDocumentClose(document) {
      document.isClosed = true;
      documents.delete(document);
      for (const listener of [...closeDocumentListeners]) listener(document);
      if (activeTextEditor?.document === document) setActiveDocument(undefined);
    },
    async fireRename(files: Array<{ from: string; to: string }>): Promise<void> {
      const event = { files: files.map((file) => ({ oldUri: { fsPath: file.from }, newUri: { fsPath: file.to } })) };
      await Promise.all([...renameListeners].map((listener) => Promise.resolve(listener(event))));
    },
    setWorkspaceFolders(paths: string[]): void {
      const before = workspaceFolders ?? [];
      workspaceFolders = paths.length === 0 ? undefined : paths.map((fsPath, index) => ({ uri: { fsPath }, name: fsPath.split('/').pop() ?? '', index }));
      const after = workspaceFolders ?? [];
      const added = after.filter((folder) => !before.some((old) => old.uri.fsPath === folder.uri.fsPath));
      const removed = before.filter((folder) => !after.some((now) => now.uri.fsPath === folder.uri.fsPath));
      if (added.length > 0 || removed.length > 0) for (const listener of [...folderListeners]) listener({ added, removed });
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
