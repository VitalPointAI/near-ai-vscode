import type { Todo } from './tools';

const normal = (content: string) => content.trim().toLowerCase();

/**
 * The main run's task list, kept by the host so sub-agents can move their own item along while
 * the main agent waits for them. An Agent call that names its `task` sets that item in progress,
 * then completed when the agent finishes, or back to pending if it fails or is stopped.
 *
 * The main agent's TodoWrite list wins, with one exception: an item whose status the host set
 * keeps the host's status when the main agent sends it with the same status it gave the item
 * last time (an echo of its own stale list). Changing that status from its own last value is an
 * explicit decision, and the main agent's value wins.
 */
export class TaskBoard {
  private items: Todo[] = [];
  /** The status the main agent itself last gave each item, by content. */
  private lastSent = new Map<string, Todo['status']>();
  /** Statuses the host set, by content, until the main agent explicitly overrides them. */
  private readonly marks = new Map<string, Todo['status']>();

  public get list(): Todo[] { return this.items.map((item) => ({ ...item })); }

  /** True when the list has an item not yet completed. */
  public get unfinished(): boolean { return this.items.some((item) => item.status !== 'completed'); }

  /** The item a task names: its exact content, else the same content ignoring case and surrounding space. */
  public find(task: string): Todo | undefined {
    return this.items.find((item) => item.content === task) ?? this.items.find((item) => normal(item.content) === normal(task));
  }

  /** Applies the main agent's TodoWrite; returns the list to show. */
  public write(todos: Todo[]): Todo[] {
    const sent = new Map<string, Todo['status']>();
    this.items = todos.map((item) => {
      sent.set(item.content, item.status);
      const mark = this.marks.get(item.content);
      if (mark === undefined) return { ...item };
      if (item.status === mark) { this.marks.delete(item.content); return { ...item }; }
      const echo = this.lastSent.get(item.content) === item.status;
      if (echo) return { ...item, status: mark };
      this.marks.delete(item.content);
      return { ...item };
    });
    for (const content of [...this.marks.keys()]) if (!sent.has(content)) this.marks.delete(content);
    this.lastSent = sent;
    return this.list;
  }

  /** Sets a task's item to `status`; returns the item's content, or undefined when no item matches. */
  public set(task: string, status: Todo['status']): string | undefined {
    const item = this.find(task);
    if (!item) return undefined;
    item.status = status;
    this.marks.set(item.content, status);
    return item.content;
  }

  public clear(): void {
    this.items = [];
    this.lastSent.clear();
    this.marks.clear();
  }
}
