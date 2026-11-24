// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
import type { ModelEndpoint } from '../provider/endpoint';
import type { LocalServerAdmin } from '../provider/localServer';

export const SERVER_KINDS = Object.freeze(['ollama', 'llama-cpp', 'lemonade', 'lm-studio', 'vllm', 'nim', 'localai', 'jan', 'openai-compatible'] as const);
export type ServerKind = (typeof SERVER_KINDS)[number];
export const SIGNATURE_CHECKS = Object.freeze(['ollama-version', 'llama-props', 'lemonade-health', 'lmstudio-models', 'vllm-version', 'nim-ready', 'nim-metadata', 'localai-ready', 'openai-models'] as const);
export type SignatureCheck = (typeof SIGNATURE_CHECKS)[number];
export interface SignatureRequest { readonly path: string; readonly check: SignatureCheck; }
export interface ServerProbeRow { readonly kind: ServerKind; readonly ports: readonly number[]; readonly signatures: readonly SignatureRequest[]; readonly listModels: string; readonly loadedModels?: string; readonly canInstall: boolean; readonly needsKeyToIdentify?: boolean; }
export const SERVER_PROBE_TABLE: readonly ServerProbeRow[] = Object.freeze([
  { kind: 'ollama', ports: [11434], signatures: [{ path: '/api/version', check: 'ollama-version' }], listModels: '/api/tags', loadedModels: '/api/ps', canInstall: true },
  { kind: 'llama-cpp', ports: [9931, 8080], signatures: [{ path: '/props', check: 'llama-props' }], listModels: '/v1/models', canInstall: true },
  { kind: 'lemonade', ports: [13305, 8000], signatures: [{ path: '/v1/health', check: 'lemonade-health' }, { path: '/api/v1/health', check: 'lemonade-health' }], listModels: '/v1/models', canInstall: true },
  { kind: 'lm-studio', ports: [1234], signatures: [{ path: '/api/v1/models', check: 'lmstudio-models' }, { path: '/api/v0/models', check: 'lmstudio-models' }], listModels: '/api/v1/models', canInstall: false },
  { kind: 'vllm', ports: [8000], signatures: [{ path: '/version', check: 'vllm-version' }], listModels: '/v1/models', canInstall: false },
  { kind: 'nim', ports: [8000], signatures: [{ path: '/v1/health/ready', check: 'nim-ready' }, { path: '/v1/metadata', check: 'nim-metadata' }], listModels: '/v1/models', canInstall: false },
  { kind: 'localai', ports: [8080], signatures: [{ path: '/readyz', check: 'localai-ready' }], listModels: '/v1/models', canInstall: false },
  { kind: 'jan', ports: [1337], signatures: [{ path: '/v1/models', check: 'openai-models' }], listModels: '/v1/models', canInstall: false, needsKeyToIdentify: true },
  { kind: 'openai-compatible', ports: [], signatures: [{ path: '/v1/models', check: 'openai-models' }], listModels: '/v1/models', canInstall: false }
]);
export const MODEL_SERVER_PORTS = Object.freeze([1234, 1337, 8000, 8080, 9931, 11434, 13305] as const);
export interface SignatureAnswer { readonly kind: ServerKind; readonly path: string; readonly status: number; readonly body?: unknown; }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function cleanVersion(value: unknown): string | undefined { return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 40) : undefined; }
export function matchSignature(check: SignatureCheck, status: number, body: unknown): { readonly version?: string } | undefined {
  if (check === 'localai-ready') return status === 200 || status === 503 ? {} : undefined;
  if (status !== 200) return undefined;
  const value = record(body);
  if (!value) return undefined;
  if (check === 'ollama-version' || check === 'vllm-version') { const version = cleanVersion(value.version); return version === undefined ? undefined : { version }; }
  if (check === 'llama-props') return Object.keys(value).length > 0 ? { version: cleanVersion(value.version) } : undefined;
  if (check === 'lemonade-health' || check === 'nim-ready' || check === 'nim-metadata') return Object.keys(value).length > 0 ? { version: cleanVersion(value.version) } : undefined;
  if (check === 'lmstudio-models') return Array.isArray(value.data) || Array.isArray(value.models) ? {} : undefined;
  if (check === 'openai-models') return Array.isArray(value.data) ? {} : undefined;
  return undefined;
}
export function identifyFromAnswers(port: number | undefined, answers: readonly SignatureAnswer[]): Identification {
  if (answers.length === 0) return { state: 'no-answer' };
  if (port === 1337 && answers.some((answer) => answer.kind === 'jan' && answer.path === '/v1/models' && (answer.status === 401 || answer.status === 403))) return { state: 'needs-key' };
  const rows = SERVER_PROBE_TABLE.filter((row) => port === undefined || row.ports.includes(port));
  const matches = rows.flatMap((row) => {
    const matchingAnswers = row.signatures.map((signature) => answers.filter((answer) => answer.path === signature.path && matchSignature(signature.check, answer.status, answer.body)));
    const allPresent = matchingAnswers.every((items) => items.length > 0);
    if (!allPresent) return [];
    const first = matchingAnswers[0]?.[0];
    const signature = first && row.signatures[0] ? matchSignature(row.signatures[0].check, first.status, first.body) : undefined;
    return [{ kind: row.kind, version: signature?.version }];
  });
  return matches.length === 1 && matches[0] ? { state: 'identified', kind: matches[0].kind, version: matches[0].version } : { state: 'unknown-server' };
}
export interface ServerIdentity { readonly kind: ServerKind; readonly version?: string; }
export interface ServerModel { readonly id: string; readonly sizeBytes?: number; readonly sha256?: string; readonly passportId?: string; readonly loaded?: boolean; }
export const CANDIDATE_SOURCES = Object.freeze(['loopback', 'named', 'announced', 'scanned', 'entered'] as const);
export interface ProbeTarget { readonly host: string; readonly port: number; readonly scheme: 'http-loopback' | 'https'; readonly source: (typeof CANDIDATE_SOURCES)[number]; readonly endpointId?: string; readonly tlsPin?: string; }
export interface ServerCandidate { readonly target: ProbeTarget; readonly foundBy: 'announced' | 'scanned'; readonly name?: string; readonly foundAt: number; }
export type Identification = { readonly state: 'identified'; readonly kind: ServerKind; readonly version?: string } | { readonly state: 'unknown-server' } | { readonly state: 'needs-key' } | { readonly state: 'no-answer' };
export type IdentifyServer = (target: ProbeTarget, signal: AbortSignal) => Promise<Identification>;
export type TestOutcome = { readonly ok: true } | { readonly ok: false; readonly cause: string };
/** Sends the one fixed test request to a model a check just found. The guide gives it with its own session route bound in (CLAS-06). */
export type TestRequest = (client: Pick<ModelEndpoint, 'completeOnce'>, model: string, signal: AbortSignal) => Promise<TestOutcome>;
export interface ServerAdapter { readonly endpoint: ModelEndpoint; readonly admin?: LocalServerAdmin; }
export type ServerAdapterFactory = (target: ProbeTarget) => ServerAdapter;
export interface ServerAdapterRegistry { register(kind: ServerKind, factory: ServerAdapterFactory): { dispose(): void }; get(kind: ServerKind): ServerAdapterFactory | undefined; }
export function createServerAdapterRegistry(): ServerAdapterRegistry {
  const factories = new Map<ServerKind, ServerAdapterFactory>();
  return {
    register(kind, factory) {
      if (factories.has(kind)) throw new Error(`Adapter already registered: ${kind}`);
      factories.set(kind, factory);
      let disposed = false;
      return { dispose() {
        if (disposed) return;
        disposed = true;
        factories.delete(kind);
      } };
    },
    get: (kind) => factories.get(kind),
  };
}
export const PROBE_MAX_RESPONSE_BYTES = 1_048_576;
export const SIGNATURE_TIMEOUT_MS = 3_000;
export const TEST_REQUEST_TIMEOUT_MS = 60_000;
