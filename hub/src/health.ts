// Copied from relay/src/health.ts and adapted for the hub (D-28). The relay's Teams, Signal and in-flight fields are not copied.
//
// The health registry behind GET /healthz. The body holds exactly three fields and nothing that identifies a project, a device, a request or a
// secret, so it can be served on the hub's one port (D-26). The store probe is set by the plan that opens the hub's store (32-20); until then the
// store reads not-configured.

export type StoreState = 'not-configured' | 'ok' | 'down';
export type HealthProbe = () => Promise<'ok' | 'down'>;

export interface HealthReport {
  version: string;
  uptimeSeconds: number;
  store: StoreState;
}

export interface HealthRegistryOptions {
  version: string;
  startedAt: number;
  now?: () => number;
  probeTimeoutMs?: number;
}

export class HealthRegistry {
  private readonly version: string;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private storeProbe: HealthProbe | undefined;

  constructor(options: HealthRegistryOptions) {
    this.version = options.version;
    this.startedAt = options.startedAt;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1000;
  }

  setStoreProbe(probe: HealthProbe): void {
    this.storeProbe = probe;
  }

  /** 200 while the store is ok or not configured yet; 503 when its probe says down, throws or is slower than probeTimeoutMs. */
  async report(): Promise<{ status: 200 | 503; body: HealthReport }> {
    const store = await this.storeState();
    const uptimeSeconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000));
    return { status: store === 'down' ? 503 : 200, body: { version: this.version, uptimeSeconds, store } };
  }

  private async storeState(): Promise<StoreState> {
    const probe = this.storeProbe;
    if (!probe) return 'not-configured';
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'down'>((resolve) => {
        timer = setTimeout(() => resolve('down'), this.probeTimeoutMs);
      });
      const result = await Promise.race([probe(), timeout]);
      return result === 'ok' ? 'ok' : 'down';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
