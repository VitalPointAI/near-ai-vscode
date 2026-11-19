// One writer at a time per register file inside this extension host (the intel workbench's pattern, now shared): two members' calls in one run, or a
// member and a person's command, never lose each other's rows. The caller re-reads the file inside the lock, so each write starts from the latest rows.
const fileLocks = new Map<string, Promise<unknown>>();

export async function withRegisterLock<T>(absolute: string, work: () => Promise<T>): Promise<T> {
  const before = fileLocks.get(absolute) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  fileLocks.set(absolute, settled);
  try {
    return await run;
  } finally {
    if (fileLocks.get(absolute) === settled) fileLocks.delete(absolute);
  }
}
