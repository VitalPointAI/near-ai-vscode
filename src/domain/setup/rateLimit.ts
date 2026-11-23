// Pure: a token bucket driven by the caller's clock.
export const SCAN_HOSTS_PER_SECOND = 50;

interface TokenBucket {
  wait(now: number): number;
  take(now: number): boolean;
}

export function createTokenBucket({ ratePerSecond, burst }: { ratePerSecond: number; burst: number }): TokenBucket {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0 || !Number.isSafeInteger(burst) || burst < 1) {
    throw new RangeError('Invalid token bucket capacity or rate');
  }
  const perMillisecond = ratePerSecond / 1000;
  let tokens = burst;
  let observed: number | undefined;
  function refill(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    if (observed === undefined) observed = now;
    if (now < observed) return false;
    tokens = Math.min(burst, tokens + (now - observed) * perMillisecond);
    observed = now;
    return true;
  }
  return {
    wait(now) {
      return refill(now) ? Math.max(0, Math.ceil((1 - tokens) / perMillisecond)) : Infinity;
    },
    take(now) {
      if (!refill(now) || tokens < 1) return false;
      tokens--;
      return true;
    }
  };
}
