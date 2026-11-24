import type { PolicyEndpoint } from '../../domain/gate/endpoints';
import type { ModelEndpoint } from '../../domain/provider/endpoint';
import { fillSlots } from '../../domain/setup/answers';
import { memoryShown } from '../../domain/setup/device';
import { optionIdOf } from '../../domain/setup/ids';
import { MODEL_SERVER_PORTS } from '../../domain/setup/servers';
import type { Identification, IdentifyServer, ProbeTarget, ServerKind, ServerModel, ServerProbeRow } from '../../domain/setup/servers';
import {
  HOSTED_NO_LOOPBACK_TEXT, initialViability, nextViability, NO_LOCAL_SERVER_TEXT, SERVER_NEEDS_KEY_TEXT,
  SERVER_NO_ALLOWED_MODEL_TEXT, SERVER_TEST_FAILED_TEXT, UNKNOWN_SERVER_TEXT,
} from '../../domain/setup/viability';
import type { OptionCheckInput, OptionSource, ViabilityEvent, ViabilityResult } from '../../domain/setup/viability';
import { fetchForTarget } from './identify';
import type { IdentifyDeps } from './identify';
import { probeOrigin } from './probe';

const SET_UP_LOCAL_AI_TEXT = 'Set up local AI';
const ASK_ADMINISTRATOR_TEXT = 'Ask your administrator';
const SERVER_NOT_FOUND_TEXT = 'This server did not answer.';
const ADD_SERVER_KEY_TEXT = 'Add a key';
const RETRY_TEST_TEXT = 'Try again';

export interface LocalServersDeps {
  readonly identify: IdentifyServer;
  readonly listModels: (target: ProbeTarget, kind: ServerKind, signal: AbortSignal) => Promise<readonly ServerModel[]>;
  /** The client uses this transport for its completion, including the target's TLS pin. */
  readonly localClient: (baseUrl: string, fetchFn: typeof fetch) => Pick<ModelEndpoint, 'completeOnce'>;
  readonly preferredModel?: () => string | undefined;
  readonly rows?: readonly ServerProbeRow[];
  readonly fetch?: typeof fetch;
  readonly fetchForPin?: IdentifyDeps['fetchForPin'];
}

export function namedLocalEndpoints(endpoints: readonly PolicyEndpoint[]): readonly PolicyEndpoint[] {
  return endpoints.filter(({ class: kind }) => kind === 'local' || kind === 'org-plain');
}

function namedTarget(endpoint: PolicyEndpoint): ProbeTarget | undefined {
  if (endpoint.host.startsWith('*.')) return undefined;
  const protocol = endpoint.scheme === 'https' ? 'https:' : 'http:';
  try {
    const url = new URL(`${protocol}//${endpoint.host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return {
      host: url.hostname, port: Number(url.port || (protocol === 'https:' ? 443 : 80)),
      scheme: endpoint.scheme, source: 'named', endpointId: endpoint.id, tlsPin: endpoint.tlsPins[0],
    };
  } catch {
    return undefined;
  }
}

type FoundServer = { readonly target: ProbeTarget; readonly identity: Identification };

function hostedLocal(input: OptionCheckInput): ViabilityResult {
  const at = input.now();
  const started = nextViability({ ...initialViability(optionIdOf('this-computer'), 'this-computer', input.hostKind), policyHash: input.policyHash },
    { type: 'start', at });
  return nextViability(started, { type: 'failed', at, check: 'detected', reasonCode: 'not-detected', sentence: HOSTED_NO_LOOPBACK_TEXT });
}

export function createLocalServersSource(deps: LocalServersDeps): OptionSource {
  const ports = deps.rows ? [...new Set(deps.rows.flatMap((row) => row.ports))] : MODEL_SERVER_PORTS;
  const targets: readonly ProbeTarget[] = ports.map((port) => ({
    host: '127.0.0.1', port, scheme: 'http-loopback', source: 'loopback',
  }));
  return {
    id: 'local-servers',
    kinds: ['this-computer', 'org-server'],
    async check(input, signal) {
      // Owner D7, D-49: a hosted session's loopback is the pod's own (sidecars), so it is never probed.
      const local = (input.hostKind === 'hosted' ? Promise.resolve(hostedLocal(input)) : checkOption(input, signal, deps, targets)).then((result) => {
        input.progress(result);
        return result;
      });
      const named = namedLocalEndpoints(input.endpoints).map(async (endpoint) => {
        const target = namedTarget(endpoint);
        input.progress(await checkOption(input, signal, deps, target ? [target] : [], endpoint));
      });
      // Publish the local result while named checks are still running. Return it for direct callers.
      const [result] = await Promise.all([local, ...named]);
      return result;
    },
  };
}

async function checkOption(
  input: OptionCheckInput, signal: AbortSignal, deps: LocalServersDeps, targets: readonly ProbeTarget[], endpoint?: PolicyEndpoint,
): Promise<ViabilityResult> {
  const kind = endpoint ? 'org-server' : 'this-computer';
  const at = input.now();
  const current = nextViability({
    ...initialViability(optionIdOf(kind, endpoint?.id), kind, input.hostKind), endpoint, policyHash: input.policyHash,
  }, { type: 'start', at });
  const fail = (event: Omit<Extract<ViabilityEvent, { type: 'failed' }>, 'type' | 'at'>) =>
    nextViability(current, { ...event, type: 'failed', at: input.now() });
  const setup = endpoint
    ? { action: 'ask-administrator', label: ASK_ADMINISTRATOR_TEXT } as const
    : { action: 'configure', label: SET_UP_LOCAL_AI_TEXT } as const;
  const found: FoundServer[] = await Promise.all(targets.map(async (target) => {
    try {
      return { target, identity: await deps.identify(target, signal) };
    } catch {
      return { target, identity: { state: 'no-answer' } as const };
    }
  }));
  const match = found.find(({ identity }) => identity.state === 'identified');
  if (!match || match.identity.state !== 'identified') {
    if (found.some(({ identity }) => identity.state === 'needs-key')) {
      return fail({ check: 'configured', reasonCode: 'not-configured', sentence: SERVER_NEEDS_KEY_TEXT, fix: { action: 'configure', label: ADD_SERVER_KEY_TEXT } });
    }
    const unknown = found.some(({ identity }) => identity.state === 'unknown-server');
    const sentence = unknown ? UNKNOWN_SERVER_TEXT : endpoint
      ? SERVER_NOT_FOUND_TEXT : fillSlots(NO_LOCAL_SERVER_TEXT, { memory: memoryShown(input.device.totalMemoryBytes) });
    return fail({ check: 'detected', reasonCode: 'not-detected', sentence, fix: setup });
  }

  const { target, identity } = match;
  const origin = probeOrigin(target);
  if (!origin || signal.aborted) return fail({ check: 'detected', reasonCode: 'not-detected', sentence: SERVER_NOT_FOUND_TEXT, fix: setup });
  const models = await deps.listModels(target, identity.kind, signal).catch(() => []);
  const preferred = deps.preferredModel?.();
  const model = models.find(({ id }) => id === preferred) ?? models[0];
  if (!model) {
    return fail({
      check: 'answered', reasonCode: 'test-failed', fix: setup,
      sentence: fillSlots(SERVER_NO_ALLOWED_MODEL_TEXT, { server: endpoint?.id ?? identity.kind }),
    });
  }

  const host = new URL('/v1', origin).href;
  const sameOriginFetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.origin !== origin.origin || url.username || url.password) throw new Error('Unexpected model server origin');
    const fetch = fetchForTarget(target, { fetch: deps.fetch ?? globalThis.fetch, fetchForPin: deps.fetchForPin });
    return fetch(request, { ...init, redirect: 'error', credentials: 'omit' });
  };
  const test = await input.testRequest(deps.localClient(host, sameOriginFetch), model.id, signal);
  if (!test.ok) {
    return fail({
      check: 'answered', reasonCode: 'test-failed', fix: { action: 'retry', label: RETRY_TEST_TEXT },
      sentence: fillSlots(SERVER_TEST_FAILED_TEXT, { cause: test.cause }),
    });
  }
  return nextViability(current, {
    type: 'answered', at: input.now(), models, endpoint, server: { kind: identity.kind, version: identity.version },
    routeFacts: { clientRoute: 'local', host, model: { id: model.id, privacyBoundary: 'local' } },
  });
}
