// The health registry behind GET /healthz. The body holds exactly five fields and nothing that identifies a tenant, a request or a secret,
// so it can be served on the main port (D-12). Later phases plug real probes into the same registry.

export type ComponentName = 'teams' | 'signal';
export type ComponentState = 'not-configured' | 'ok' | 'down';
export type HealthProbe = () => Promise<'ok' | 'down'>;

export interface HealthReport {
  version: string;
  uptimeSeconds: number;
  teams: ComponentState;
  signal: ComponentState;
  inFlightRuns: number | null;
}

export interface HealthRegistryOptions {
  version: string;
  startedAt: number;
  now?: () => number;
  probeTimeoutMs?: number;
}

type InFlightSource = () => number | Promise<number>;

export class HealthRegistry {
  private readonly version: string;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly probes = new Map<ComponentName, HealthProbe>();
  private inFlight: InFlightSource = () => 0;

  constructor(options: HealthRegistryOptions) {
    this.version = options.version;
    this.startedAt = options.startedAt;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1000;
  }

  setProbe(component: ComponentName, probe: HealthProbe): void {
    this.probes.set(component, probe);
  }

  setInFlightRuns(source: InFlightSource): void {
    this.inFlight = source;
  }

  async report(): Promise<{ status: 200 | 503; body: HealthReport }> {
    const [teams, signal] = await Promise.all([this.stateOf('teams'), this.stateOf('signal')]);
    let status: 200 | 503 = 200;
    let inFlightRuns: number | null = null;
    try {
      inFlightRuns = await this.inFlight();
    } catch {
      status = 503;
    }
    const uptimeSeconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000));
    return { status, body: { version: this.version, uptimeSeconds, teams, signal, inFlightRuns } };
  }

  private async stateOf(component: ComponentName): Promise<ComponentState> {
    const probe = this.probes.get(component);
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
