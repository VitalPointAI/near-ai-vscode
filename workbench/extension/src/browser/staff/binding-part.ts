import type { interfaces } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { UndoRedoHandler } from '@theia/core/lib/browser/undo-redo-handler.js';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager.js';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget.js';
import { STAFF_BINDING_PATH, StaffBindingServer } from '../../common/staff-binding.js';
import { bindFrontendService } from '../frontend-service.js';
import {
  StaffBindingContribution, StaffBindingEvents, StaffBoundUndoRedoHandler, StaffEditorSource, type SourceEditor, type SourceModel,
} from './binding-contribution.js';
import type { BoundTextModel } from './monaco-bound-document.js';

interface Disposable { dispose(): void }

/** The members of MonacoEditor and MonacoEditorModel (Theia 1.77) the binding reads; typed here so no Monaco module is imported. */
interface MonacoEditorLike {
  readonly document?: {
    readonly uri: string;
    readonly textEditorModel?: BoundTextModel;
    onModelWillSaveModel(listener: () => Promise<void>): Disposable;
    save(): Promise<void>;
    readonly onDispose: (listener: () => void) => Disposable;
  };
  isFocused(): boolean;
  readonly onFocusChanged: (listener: (focused: boolean) => void) => Disposable;
  readonly onDispose: (listener: () => void) => Disposable;
  getControl(): { updateOptions(options: { readOnly: boolean; readOnlyMessage?: { value: string } }): void };
}

const models = new WeakMap<object, SourceModel>();

function sourceModel(document: NonNullable<MonacoEditorLike['document']> & { textEditorModel: BoundTextModel }): SourceModel {
  let model = models.get(document);
  if (model === undefined) {
    model = {
      uri: document.uri,
      textModel: document.textEditorModel,
      // MonacoEditorModel.doSync reloads the file with ignoreContentChanges set (Theia 1.77): the one mark of a reload from disk.
      isDiskSync: () => (document as unknown as { ignoreContentChanges?: boolean }).ignoreContentChanges === true,
      onWillSave: (listener) => document.onModelWillSaveModel(() => listener()),
      save: () => document.save(),
      onDispose: (listener) => document.onDispose(listener),
    };
    models.set(document, model);
  }
  return model;
}

/** An editor widget as the binding sees it, or undefined when it is not a Monaco text editor. */
function sourceEditor(widget: EditorWidget): SourceEditor | undefined {
  const editor = widget.editor as unknown as MonacoEditorLike;
  const document = editor.document;
  if (document?.textEditorModel === undefined || typeof editor.getControl !== 'function') return undefined;
  return {
    model: sourceModel(document as NonNullable<MonacoEditorLike['document']> & { textEditorModel: BoundTextModel }),
    isFocused: () => editor.isFocused(),
    setReadOnly: (readOnly, message) => editor.getControl().updateOptions({ readOnly, ...(readOnly && message !== undefined ? { readOnlyMessage: { value: message } } : {}) }),
    onFocusChanged: (listener) => editor.onFocusChanged(listener),
    onDispose: (listener) => editor.onDispose(listener),
  };
}

/** The browser part of the editor binding (33-25): the channel's client and proxy, the editors of this tab, and the undo and redo routing. */
export function bindBindingPart(bind: interfaces.Bind): void {
  bind(StaffBindingEvents).toSelf().inSingletonScope();
  bindFrontendService<StaffBindingServer>(bind, StaffBindingServer, STAFF_BINDING_PATH, (context) => context.container.get(StaffBindingEvents));
  bind(StaffEditorSource).toDynamicValue((context) => {
    const editors = context.container.get(EditorManager);
    return {
      all: () => editors.all.flatMap((widget) => sourceEditor(widget) ?? []),
      onCreated: (listener: (editor: SourceEditor) => void) => editors.onCreated((widget) => {
        const editor = sourceEditor(widget);
        if (editor !== undefined) listener(editor);
      }),
    };
  }).inSingletonScope();
  bind(StaffBindingContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(StaffBindingContribution);
  bind(FrontendApplicationContribution).toDynamicValue((context) => ({ onStart: () => context.container.get(StaffBindingContribution).onStart() })).inSingletonScope();
  bind(StaffBoundUndoRedoHandler).toSelf().inSingletonScope();
  bind(UndoRedoHandler).toService(StaffBoundUndoRedoHandler);
}
