import { platform, totalmem } from 'node:os';
import { DEVICE_PLATFORMS } from '../../domain/setup/device';
import type { DeviceFacts, DeviceFactsProvider, HostKind } from '../../domain/setup/device';

export function hostKindOf({ remoteName, inContainer }: { remoteName?: string; inContainer?: boolean }): HostKind {
  if (inContainer || remoteName === 'dev-container' || remoteName === 'attached-container' || remoteName === 'codespaces') return 'container';
  return remoteName ? 'remote' : 'desktop';
}

export function memoryOnlyDeviceProvider(deps: {
  totalmem?: () => number; platform?: () => string; hostKind?: HostKind;
} = {}): DeviceFactsProvider {
  const id = 'memory-only';
  return {
    id, rank: 0,
    async read(signal) {
      signal?.throwIfAborted();
      const hostPlatform = (deps.platform ?? platform)();
      const knownPlatform = DEVICE_PLATFORMS.find((name) => name === hostPlatform) ?? 'unknown';
      const facts: DeviceFacts = {
        class: 'unknown', platform: knownPlatform, totalMemoryBytes: (deps.totalmem ?? totalmem)(),
        gpuUsableSource: 'not-measured', estimate: false,
        hostKind: deps.hostKind ?? 'unknown', providerId: id,
      };
      return facts;
    },
  };
}
