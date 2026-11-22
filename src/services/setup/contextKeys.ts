import { stepDoneContextKey, stepShownContextKey } from '../../domain/setup/ids';
import type { StepContext, StepRegistry } from '../../domain/setup/steps';

interface RefreshSetupContextInput {
  registry: StepRegistry;
  ctx: StepContext;
  setContext: (key: string, value: unknown) => PromiseLike<unknown>;
}

export async function refreshSetupContext({ registry, ctx, setContext }: RefreshSetupContextInput): Promise<void> {
  await Promise.all(registry.list().map(async (step) => {
    const [viability, state] = await Promise.all([step.viability(ctx), step.state(ctx)]);
    const shown = viability.available && (!step.kinds || (ctx.kind !== undefined && step.kinds.includes(ctx.kind)));
    await Promise.all([
      setContext(stepShownContextKey(step.id), shown),
      setContext(stepDoneContextKey(step.id), state === 'done')
    ]);
  }));
}

interface SetupContextClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

type WatchSetupContextInput = Omit<RefreshSetupContextInput, 'ctx'> & {
  onChange: (listener: () => void) => { dispose(): void };
  clock?: SetupContextClock;
  onError?: (error: unknown) => void;
} & ({ context: () => StepContext | Promise<StepContext> } | { ctx: StepContext });

const REFRESH_DELAY_MS = 200;
const systemClock: SetupContextClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function watchSetupContext(input: WatchSetupContextInput): { dispose(): void } {
  const { registry, clock = systemClock } = input;
  let lastIds = new Set<string>();
  let timer: { handle: unknown } | undefined;
  let disposed = false;
  let running = false;
  let dirty = false;

  async function setContext(key: string, value: unknown): Promise<void> {
    if (!disposed) await input.setContext(key, value);
  }

  async function refresh(): Promise<void> {
    const ctx = 'context' in input ? await input.context() : input.ctx;
    if (disposed) return;
    const ids = new Set(registry.list().map((step) => step.id));
    const removed = [...lastIds].filter((id) => !ids.has(id));
    await Promise.all([
      refreshSetupContext({ registry, ctx, setContext }),
      ...removed.flatMap((id) => [setContext(stepShownContextKey(id), false), setContext(stepDoneContextKey(id), false)])
    ]);
    lastIds = ids;
  }

  function schedule(): void {
    dirty = true;
    if (timer || running || disposed) return;
    timer = { handle: clock.setTimeout(() => {
      timer = undefined;
      dirty = false;
      running = true;
      void refresh().catch((error) => input.onError?.(error)).finally(() => {
        running = false;
        if (dirty) schedule();
      });
    }, REFRESH_DELAY_MS) };
  }

  const subscriptions = [registry.onDidChange(schedule), input.onChange(schedule)];
  schedule();
  return {
    dispose() {
      disposed = true;
      if (timer) clock.clearTimeout(timer.handle);
      subscriptions.forEach((subscription) => subscription.dispose());
    }
  };
}
