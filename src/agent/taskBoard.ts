import type { Todo } from './tools';

const normal = (content: string) => content.trim().toLowerCase();

/** A task that is only an item's number: "2", "#2", "item 2", "task 2", "no. 2". */
const NUMBERED = /^(?:#|item\s+|task\s+|no\.\s*)?(\d{1,2})$/i;

/** One leading list marker: a bullet, "1." / "1)" / "1:" or "#1" followed by space, and a checkbox. */
const LEADING_MARKER = /^\s*(?:(?:[-*•]|\d+[.):]|#\d+)\s+)?(?:\[[ xX]\]\s*)?/u;

/** The name of a task with case, one leading list marker, quotes and punctuation removed: runs of anything but letters and digits become one space. */
function keyOf(text: string): string {
  return text.toLowerCase().replace(LEADING_MARKER, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Whether `long` holds `short` as one unbroken run of whole words. */
function containsRun(long: string[], short: string[]): boolean {
  for (let start = 0; start + short.length <= long.length; start += 1) {
    if (short.every((word, offset) => long[start + offset] === word)) return true;
  }
  return false;
}

/**
 * The main run's task list, kept by the host so sub-agents can move their own item along while
 * the main agent waits for them. An Agent call that names its `task` sets that item in progress,
 * then completed when the agent finishes, or back to pending if it fails or is stopped.
 *
 * The invariant: a status the host set survives a stale echo of pending or in_progress (the main
 * agent resending its own old list), a `completed` the main agent sends is always shown, and the
 * host itself raises an item to completed only when the sub-agent it tracked finished. Changing a
 * status from the main agent's own last value is an explicit decision, and the main agent's value wins.
 */
export class TaskBoard {
  private items: Todo[] = [];
  /** The status the main agent itself last gave each item, by content. */
  private lastSent = new Map<string, Todo['status']>();
  /** Statuses the host set, by content, until the main agent explicitly overrides them. */
  private readonly marks = new Map<string, Todo['status']>();

  private rev = 0;

  /** Goes up every time the list changes (a write, a set that matched an item, a clear), so a caller can tell whether a run touched it. */
  public get revision(): number { return this.rev; }

  public get list(): Todo[] { return this.items.map((item) => ({ ...item })); }

  /** True when the list has an item not yet completed. */
  public get unfinished(): boolean { return this.items.some((item) => item.status !== 'completed'); }

  /**
   * The item a task names, by deterministic steps, the first that hits wins:
   * (a) its exact content; (b) its content ignoring case and surrounding space; (c) its number, when the whole task is an optional `#`, `item `,
   * `task ` or `no.` and one or two digits (1 is the first item); (d) the one item whose normalized key equals the task's; (e) the one item
   * where the shorter name (at least two words) appears as a whole-word run inside the longer. Steps (d) and (e) need exactly one match.
   * There is no scored fuzzy matching: a wrong match would mark the wrong item done, so a guess moves nothing.
   */
  public find(task: string): Todo | undefined {
    const exact = this.items.find((item) => item.content === task) ?? this.items.find((item) => normal(item.content) === normal(task));
    if (exact) return exact;
    const number = NUMBERED.exec(task.trim());
    if (number) {
      const numbered = this.items[Number(number[1]) - 1];
      if (numbered) return numbered;
    }
    const key = keyOf(task);
    if (key === '') return undefined;
    const sameKey = this.items.filter((item) => keyOf(item.content) === key);
    if (sameKey.length === 1) return sameKey[0];
    const words = key.split(' ');
    const containing = this.items.filter((item) => {
      const other = keyOf(item.content).split(' ');
      const [short, long] = words.length <= other.length ? [words, other] : [other, words];
      return short.length >= 2 && containsRun(long, short);
    });
    return containing.length === 1 ? containing[0] : undefined;
  }

  /** Applies the main agent's TodoWrite; returns the list to show. */
  public write(todos: Todo[]): Todo[] {
    this.rev += 1;
    const sent = new Map<string, Todo['status']>();
    this.items = todos.map((item) => {
      sent.set(item.content, item.status);
      const mark = this.marks.get(item.content);
      if (mark === undefined) return { ...item };
      // A completed the model sends always wins, even when it repeats its own last status: otherwise an item the host moved back to pending could never be completed again.
      if (item.status === 'completed') { this.marks.delete(item.content); return { ...item }; }
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
    this.rev += 1;
    this.marks.set(item.content, status);
    return item.content;
  }

  public clear(): void {
    this.rev += 1;
    this.items = [];
    this.lastSent.clear();
    this.marks.clear();
  }
}
