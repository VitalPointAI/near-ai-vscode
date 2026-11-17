// The chat in view (D-33): which conversation the chat view shows now, for the status bar's label and for NEAR AI: Lower This Chat's Label. The chat sets
// it when it shows a conversation and clears it when the view goes away; it says when that chat's label changes. No vscode import.
import type { SessionMark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';

/** What the label surfaces need of the chat on screen. */
export interface ChatInView {
  /** The conversation id. */
  readonly id: string;
  /** The project the chat works in. */
  readonly root: string;
  /** The chat's mark, or undefined before its first run. */
  mark(): SessionMark | undefined;
  /** The policy's default label as the chat last read it: the label is shown only above it. */
  defaultLabel(): Label;
  /** Saves the person's lowering with the chat (the signed declassification, or `true` when it could not be signed) before the mark changes. */
  prepareLowering(signed: unknown): void;
}

let current: ChatInView | undefined;
const listeners = new Set<() => void>();

function tell(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a listener never changes what is in view */ }
  }
}

/** The chat view shows `chat` now, or (undefined) no chat. */
export function setChatInView(chat: ChatInView | undefined): void {
  current = chat;
  tell();
}

/** Clears the chat in view only while it is still `id`, so a view that went away never clears another's. */
export function clearChatInView(id: string): void {
  if (current?.id === id) setChatInView(undefined);
}

export function chatInView(): ChatInView | undefined {
  return current;
}

/** The label of the chat `id` changed: the surfaces read it again when it is the one in view. */
export function chatLabelChanged(id: string): void {
  if (current?.id === id) tell();
}

/** Told whenever the chat in view, or its label, changes; returns a function that stops telling. */
export function onChatInViewChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
