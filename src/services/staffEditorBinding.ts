// The source selects shared products. Loading the replica binding happens only after it names an open document.
import * as vscode from 'vscode';
import type { BoundDocument, BoundProduct, EditorBinding } from '../staff/replica/editorBinding';

export interface BindingSource {
  productFor(uri: vscode.Uri): BoundProduct | undefined;
  onProductChanged(listener: () => void): vscode.Disposable;
}

export const BOUND_EDITOR_CONTEXT = 'nearAi.staffBoundEditor';

type Register = (id: string, run: () => Promise<void>) => void;

const OPEN_FAILED = 'This editor could not open the shared product. Close the product and open it again.';

function adaptDocument(document: vscode.TextDocument, active: () => boolean): BoundDocument {
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
  context: Pick<vscode.ExtensionContext, 'subscriptions'>, _register: Register, source: BindingSource
): void {
  const sessions = new Map<vscode.TextDocument, Promise<EditorBinding | undefined>>();
  const open = (document: vscode.TextDocument): void => {
    if (document.isClosed || sessions.has(document)) return;
    const product = source.productFor(document.uri);
    if (!product) return;

    const binding: Promise<EditorBinding | undefined> = import('../staff/replica/editorBinding').then(({ EditorBinding }) => {
      const active = (): boolean => !document.isClosed && sessions.get(document) === binding;
      if (!active()) return undefined;
      return EditorBinding.open(adaptDocument(document, active), product, {
        notice: (text) => { if (active()) void vscode.window.showWarningMessage(text); }
      });
    }).catch(() => {
      if (sessions.get(document) === binding) sessions.delete(document);
      if (!document.isClosed) void vscode.window.showWarningMessage(OPEN_FAILED);
      return undefined;
    });
    sessions.set(document, binding);
  };
  const close = (document: vscode.TextDocument): void => {
    const session = sessions.get(document);
    if (!session) return;
    sessions.delete(document);
    void session.then(async (binding) => {
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
    source.onProductChanged(() => {
      for (const [document, session] of sessions) {
        void session.then((binding) => {
          if (!document.isClosed && sessions.get(document) === session) return binding?.refresh();
        }).catch(() => undefined);
      }
    })
  ];
  context.subscriptions.push({
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
      for (const document of sessions.keys()) close(document);
    }
  });
  for (const document of vscode.workspace.textDocuments) open(document);
}
