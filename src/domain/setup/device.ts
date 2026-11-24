// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
export const DEVICE_CLASSES = Object.freeze(['unified', 'discrete', 'cpu-only', 'unknown'] as const);
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export const MEMORY_SOURCES = Object.freeze(['os-total', 'meminfo', 'gtt-plus-vram', 'vram', 'apple-working-set', 'not-measured'] as const);
export type MemorySource = (typeof MEMORY_SOURCES)[number];
// The last kind (owner D7, D-49) is a Sterling session on your organization's servers. Appended, so earlier records keep their meaning.
export const HOST_KINDS = Object.freeze(['desktop', 'remote', 'container', 'unknown', 'hosted'] as const);
export type HostKind = (typeof HOST_KINDS)[number];
export const DEVICE_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32', 'unknown'] as const);
export interface DeviceFacts { readonly class: DeviceClass; readonly platform: (typeof DEVICE_PLATFORMS)[number]; readonly totalMemoryBytes: number; readonly gpuUsableBytes?: number; readonly gpuUsableSource: MemorySource; readonly estimate: boolean; readonly gpuName?: string; readonly fix?: string; readonly hostKind: HostKind; readonly providerId: string; }
export interface DeviceFactsProvider { readonly id: string; readonly rank: number; read(signal?: AbortSignal): Promise<DeviceFacts>; }
export interface DeviceProviderRegistry { register(provider: DeviceFactsProvider): { dispose(): void }; best(): DeviceFactsProvider | undefined; list(): readonly DeviceFactsProvider[]; }
export function createDeviceProviderRegistry(): DeviceProviderRegistry {
  const entries = new Set<{ provider: DeviceFactsProvider }>();
  const list = () => [...entries].map(({ provider }) => provider);
  return {
    register(provider) {
      const entry = { provider };
      entries.add(entry);
      return { dispose: () => entries.delete(entry) };
    },
    best: () => list().reduce<DeviceFactsProvider | undefined>((best, current) =>
      !best || current.rank >= best.rank ? current : best, undefined),
    list,
  };
}
export function memoryShown(bytes: number): string { return `${Math.round(bytes / 1_000_000_000)} GB`; }
