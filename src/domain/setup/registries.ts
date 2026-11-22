// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
import { createDeviceProviderRegistry, type DeviceProviderRegistry } from './device';
import { createServerAdapterRegistry, type ServerAdapterRegistry } from './servers';
import { createStepRegistry, type StepRegistry } from './steps';
import { createOptionSourceRegistry, type OptionSourceRegistry } from './viability';
import { createAuditEventRegistry, type AuditEventRegistry } from './records';
export interface SetupRegistries { readonly steps: StepRegistry; readonly options: OptionSourceRegistry; readonly devices: DeviceProviderRegistry; readonly servers: ServerAdapterRegistry; readonly events: AuditEventRegistry; }
export function createSetupRegistries(): SetupRegistries { return { steps: createStepRegistry(), options: createOptionSourceRegistry(), devices: createDeviceProviderRegistry(), servers: createServerAdapterRegistry(), events: createAuditEventRegistry() }; }
let shared: SetupRegistries | undefined;
/** The extension host uses this singleton; tests should use createSetupRegistries for isolation. */
export function setupRegistries(): SetupRegistries { return shared ??= createSetupRegistries(); }
