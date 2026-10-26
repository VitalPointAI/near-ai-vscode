export type ContextLevel = 'normal' | 'warning' | 'critical';

export interface ContinuityThresholds {
  warningRemaining: number;
  criticalRemaining: number;
}

export interface HandoffState {
  version: 1;
  createdAt: string;
  reason: 'manual' | 'context-warning' | 'context-critical' | 'session-end';
  projectRoot: string;
  currentAction: string;
  nextAction: string;
  activeAgents: number;
  pendingApprovals: number;
}

export function contextLevel(remainingPercentage: number, thresholds: ContinuityThresholds): ContextLevel {
  if (remainingPercentage <= thresholds.criticalRemaining) return 'critical';
  if (remainingPercentage <= thresholds.warningRemaining) return 'warning';
  return 'normal';
}

export class ContextContinuity {
  private lastLevel: ContextLevel = 'normal';

  public constructor(
    private readonly thresholds: ContinuityThresholds = { warningRemaining: 35, criticalRemaining: 25 },
    private readonly onTransition: (level: ContextLevel) => void = () => undefined
  ) {}

  public observe(remainingPercentage: number): ContextLevel {
    const level = contextLevel(remainingPercentage, this.thresholds);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.onTransition(level);
    }
    return level;
  }

  public reset(): void {
    this.lastLevel = 'normal';
  }
}
