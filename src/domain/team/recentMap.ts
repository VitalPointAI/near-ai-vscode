// A map that keeps only its most recent entries and counts how many it let go. Pure: no I/O, no vscode.
// The Team Mode session uses it for what it has already told the person (rejected events, sync problems), so a remote that keeps producing
// new rejected events cannot make the session's memory grow without limit. An entry looked up again is treated as recent again.
export const DEFAULT_RECENT_LIMIT = 500;

export class RecentMap<V> {
  private readonly entries = new Map<string, V>();
  private droppedCount = 0;
  public readonly limit: number;

  constructor(limit: number = DEFAULT_RECENT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('The limit must be a whole number of one or more.');
    this.limit = limit;
  }

  public get size(): number {
    return this.entries.size;
  }

  // How many entries were let go to stay within the limit.
  public get dropped(): number {
    return this.droppedCount;
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  public set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.droppedCount += 1;
    }
  }

  public delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
