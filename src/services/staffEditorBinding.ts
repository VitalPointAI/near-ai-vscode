// The source selects shared products. Loading the replica binding happens only after it names an open document.
import * as vscode from 'vscode';
import type { BoundDocument, BoundProduct, EditorBinding } from '../staff/replica/editorBinding';

export interface BindingSource {
  productFor(uri: vscode.Uri): BoundProduct | undefined;
  onProductChanged(listener: () => void): vscode.Disposable;
}

export const BOUND_EDITOR_CONTEXT = 'nearAi.staffBoundEditor';
export const STAFF_BINDING_COMMANDS = {
  undo: 'nearAi.staff.undoMyChange',
  redo: 'nearAi.staff.redoMyChange',
  attribution: 'nearAi.staff.showWhoWroteThis'
} as const;

type Register = (id: string, run: () => Promise<void>) => void;

interface BindingSession {
  readonly opened: Promise<void>;
  readonly product: BoundProduct;
  binding?: EditorBinding;
}

interface AttributionView {
  readonly editor: vscode.TextEditor;
  readonly version: number;
  readonly decorations: vscode.TextEditorDecorationType[];
  picker?: vscode.QuickPick<vscode.QuickPickItem>;
}

const AUTHOR_COLORS = ['charts.blue', 'charts.green', 'charts.orange', 'charts.purple', 'charts.yellow', 'charts.red'];
const ATTRIBUTION_WAIT = 'Attribution is available when the editor matches the shared text.';
const OPEN_FAILED = 'This editor could not open the shared product. Close the product and open it again.';

function adaptDocument(document: vscode.TextDocument, active: () => boolean, onTextChange: () => void): BoundDocument {
  return {
    get version() { return document.version; },
    getText: () => document.getText(),
    async applyEdits(edits, expectedText, baseVersion, lineEndings) {
      if (!active() || document.version !== baseVersion) return false;
      const edit = new vscode.WorkspaceEdit();
      if (lineEndings === 'lf') {
        if (document.getText().replaceAll('\r\n', '\n') !== expectedText) return false;
        edit.set(document.uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF)]);
      } else {
        edit.set(document.uri, edits.map(({ offset, length, text }) =>
          new vscode.TextEdit(new vscode.Range(document.positionAt(offset), document.positionAt(offset + length)), text)));
      }
      // VS Code captures this open model's version when applyEdit is called. Keep the check and dispatch synchronous.
      return vscode.workspace.applyEdit(edit);
    },
    onDidChange(listener) {
      if (!active()) return () => undefined;
      let lastVersion = document.version;
      const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== document || !active()) return;
        const reason = event.reason === vscode.TextDocumentChangeReason.Undo ? 'undo'
          : event.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : undefined;
        if (event.contentChanges.length === 0 && reason === undefined && document.version === lastVersion) {
          // VS Code can deliver events for metadata without changing the document version.
          return;
        }
        if (document.version !== lastVersion) onTextChange();
        lastVersion = document.version;
        listener({
          edits: event.contentChanges.map(({ rangeOffset, rangeLength, text }) => ({ offset: rangeOffset, length: rangeLength, text })),
          text: document.getText(),
          version: document.version,
          reason
        });
      });
      return () => subscription.dispose();
    }
  };
}

/** Registers the binding lifecycle. The caller supplies the shared-product lookup and change notifications. */
export function registerStaffEditorBindings(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>, register: Register, source: BindingSource
): void {
  const sessions = new Map<vscode.TextDocument, BindingSession>();
  const activeBinding = (): EditorBinding | undefined => {
    const document = vscode.window.activeTextEditor?.document;
    return document && !document.isClosed ? sessions.get(document)?.binding : undefined;
  };
  const updateContext = (): void => {
    void vscode.commands.executeCommand('setContext', BOUND_EDITOR_CONTEXT, activeBinding() !== undefined).then(undefined, () => undefined);
  };
  register(STAFF_BINDING_COMMANDS.undo, async () => { await activeBinding()?.undo(); });
  register(STAFF_BINDING_COMMANDS.redo, async () => { await activeBinding()?.redo(); });

  let attribution: AttributionView | undefined;
  const clearAttribution = (): void => {
    const view = attribution;
    attribution = undefined;
    if (!view) return;
    const picker = view.picker;
    view.picker = undefined;
    picker?.dispose();
    for (const decoration of view.decorations) decoration.dispose();
  };
  register(STAFF_BINDING_COMMANDS.attribution, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    const session = sessions.get(document);
    if (!session?.binding || document.isClosed) return;

    const wasShowing = attribution?.editor === editor;
    clearAttribution();
    if (wasShowing) return;
    const view: AttributionView = { editor, version: document.version, decorations: [] };
    attribution = view;
    const isCurrent = (): boolean => attribution === view && vscode.window.activeTextEditor === editor &&
      sessions.get(document) === session && !document.isClosed && document.version === view.version;

    try {
      const [{ fold, roster }, { productOutput }, { authorRows, namesAtRegistration }] = await Promise.all([
        session.product.project.state(), import('../staff/replica/productFeed'), import('../domain/staff/whoWroteThis')
      ]);
      if (!isCurrent()) return;
      const { product, stream } = session.product;
      const header = session.product.header().replaceAll('\r\n', '\n');
      const output = productOutput(fold, stream, product);
      if (!output || output.incomplete || session.binding.text() !== output.text || document.getText() !== header + output.text) {
        clearAttribution();
        void vscode.window.showInformationMessage(ATTRIBUTION_WAIT);
        return;
      }
      const rows = authorRows(output.attribution, namesAtRegistration(output.registrations, roster));
      if (rows.length === 0) {
        clearAttribution();
        void vscode.window.showInformationMessage('This product has no shared text yet.');
        return;
      }
      rows.forEach(({ label, spans }, index) => {
        const unverified = spans[0].unverified === true;
        const color = unverified ? 'editorWarning.foreground' : AUTHOR_COLORS[index % AUTHOR_COLORS.length];
        const decoration = vscode.window.createTextEditorDecorationType({
          borderWidth: '0 0 2px 0', borderStyle: 'solid', borderColor: new vscode.ThemeColor(color)
        });
        view.decorations.push(decoration);
        editor.setDecorations(decoration, spans.map(({ start, length }) => ({
          range: new vscode.Range(document.positionAt(header.length + start), document.positionAt(header.length + start + length)),
          hoverMessage: new vscode.MarkdownString().appendText(label),
          renderOptions: { after: { contentText: unverified ? 'Not verified' : label, margin: '0 0 0 0.5ch' } }
        })));
      });
      const picker = vscode.window.createQuickPick();
      view.picker = picker;
      picker.title = 'Who Wrote This';
      picker.items = rows.map(({ label, share }) => ({
        label: label.replaceAll('$(', '\$('),
        description: `${Number((share * 100).toFixed(1))}% of text`
      }));
      picker.onDidAccept(() => picker.hide());
      picker.onDidHide(() => {
        if (view.picker !== picker) return;
        view.picker = undefined;
        picker.dispose();
      });
      picker.show();
    } catch (error) {
      if (attribution !== view) return;
      clearAttribution();
      throw error;
    }
  });

  const open = (document: vscode.TextDocument): void => {
    if (document.isClosed || sessions.has(document)) return;
    const product = source.productFor(document.uri);
    if (!product) return;

    const session: BindingSession = {
      product,
      opened: import('../staff/replica/editorBinding').then(async ({ EditorBinding }) => {
        const active = (): boolean => !document.isClosed && sessions.get(document) === session;
        if (!active()) return;
        session.binding = await EditorBinding.open(adaptDocument(document, active, () => {
          if (attribution?.editor.document === document) clearAttribution();
        }), product, {
          notice: (text) => { if (active()) void vscode.window.showWarningMessage(text); }
        });
        if (active()) updateContext();
      }).catch(() => {
        if (sessions.get(document) !== session) return;
        sessions.delete(document);
        updateContext();
        if (!document.isClosed) void vscode.window.showWarningMessage(OPEN_FAILED);
      })
    };
    sessions.set(document, session);
  };
  const close = (document: vscode.TextDocument): void => {
    const session = sessions.get(document);
    if (!session) return;
    sessions.delete(document);
    if (attribution?.editor.document === document) clearAttribution();
    if (document === vscode.window.activeTextEditor?.document) updateContext();
    void session.opened.then(async () => {
      const binding = session.binding;
      if (!binding) return;
      try {
        await binding.flush();
      } finally {
        await binding.close();
      }
    }).catch(() => undefined);
  };

  const subscriptions = [
    vscode.workspace.onDidOpenTextDocument(open),
    vscode.workspace.onDidCloseTextDocument(close),
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearAttribution();
      updateContext();
    }),
    source.onProductChanged(() => {
      clearAttribution();
      for (const [document, session] of sessions) {
        void session.opened.then(() => {
          if (!document.isClosed && sessions.get(document) === session) return session.binding?.refresh();
        }).catch(() => undefined);
      }
    })
  ];
  context.subscriptions.push({
    dispose() {
      clearAttribution();
      for (const subscription of subscriptions) subscription.dispose();
      for (const document of sessions.keys()) close(document);
      updateContext();
    }
  });
  for (const document of vscode.workspace.textDocuments) open(document);
  updateContext();
}
