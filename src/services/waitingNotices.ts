// An approval or question holds its run until the user answers. The chat shows it, but the chat
// is not enough when nobody is looking: the sidebar is hidden, VS Code is in the background, or
// (in code-server) its browser tab is. A background browser tab still counts as a visible chat,
// so the window's focus decides too. Each prompt is announced at most once.

export interface WaitingState {
  /** The chat view is on screen (undefined when the host cannot tell). */
  panelVisible?: boolean;
  /** The VS Code window has focus (undefined when the host cannot tell). */
  windowFocused?: boolean;
}

/** Whether a prompt that opens now should be announced with a notification. */
export function announceNow(state: WaitingState): boolean {
  return state.panelVisible === false || state.windowFocused === false;
}

/** Which waiting prompts have been announced, so none is announced twice. */
export class WaitingNotices {
  private readonly announced = new Set<string>();

  /**
   * A prompt opened: true when it should be announced now (it is then counted as announced).
   * `waiting` lists the prompts waiting now, so ones settled since are forgotten.
   */
  public opened(id: string, state: WaitingState, waiting: string[]): boolean {
    this.forgetSettled(waiting);
    if (this.announced.has(id) || !announceNow(state)) return false;
    this.announced.add(id);
    return true;
  }

  /**
   * The window got focus again: the prompts still waiting that were never announced. Prompts no
   * longer waiting are forgotten, so a later prompt that reuses an ID is announced again.
   */
  public focusRegained(waiting: string[]): string[] {
    this.forgetSettled(waiting);
    const fresh = waiting.filter((id) => !this.announced.has(id));
    for (const id of fresh) this.announced.add(id);
    return fresh;
  }

  private forgetSettled(waiting: string[]): void {
    const still = new Set(waiting);
    for (const id of [...this.announced]) if (!still.has(id)) this.announced.delete(id);
  }
}
