import { DEFAULT_BASE_URL, isNearCloudEndpoint } from '../../domain/config';
import { isBindingFresh } from '../../domain/gate/routing';
import type { ConnectionBindingFact } from '../../domain/gate/routing';
import { fillSlots } from '../../domain/setup/answers';
import { SIGNATURE_TIMEOUT_MS } from '../../domain/setup/servers';
import {
  FLOOR_ON_TEXT, NEAR_NO_KEY_TEXT, NEAR_UNREACHABLE_TEXT, SERVER_TEST_FAILED_TEXT,
  initialViability, nextViability,
} from '../../domain/setup/viability';
import type { OptionSource, ViabilityEvent } from '../../domain/setup/viability';
import type { ConnectionBindingSource } from '../connectionBinding';
import type { NearAiClient } from '../nearAiClient';
import { withCheckTimeout } from './probe';
import { runTestRequest } from './testRequest';

type NearClientLike = Pick<NearAiClient, 'listModels' | 'completeOnce' | 'cachedTeeModel'>;
const NEAR_KINDS = ['near-private', 'near-all'] as const;
const ADD_KEY_TEXT = 'Add a key';
const RETRY_TEXT = 'Try again';
const OPEN_SETTINGS_TEXT = 'Open settings';
const NO_PRIVATE_MODEL_TEXT = 'The service did not list a private model';
const PRIVATE_CHECK_FAILED_TEXT = 'The connection to private hardware could not be verified';
const DETECTION_TIMEOUT_MS = SIGNATURE_TIMEOUT_MS * 3;

export interface NearAiOptionDeps {
  readonly hasKey: () => Promise<boolean>;
  readonly client: () => Promise<NearClientLike | undefined>;
  readonly binding: () => ConnectionBindingSource | undefined;
  readonly baseUrl: () => string;
}

function boundTo(fact: ConnectionBindingFact | undefined, host: string, now: number): fact is ConnectionBindingFact {
  if (fact === undefined || !isBindingFresh(fact, now)) return false;
  try {
    const address = new URL(fact.host.includes('://') ? fact.host : `https://${fact.host}`);
    return address.origin === new URL(host).origin && !address.username && !address.password;
  } catch {
    return false;
  }
}

export function createNearAiSource(deps: NearAiOptionDeps): OptionSource {
  return {
    id: 'near-ai',
    kinds: NEAR_KINDS,
    async check(input, signal) {
      const startAt = input.now();
      const start = (kind: (typeof NEAR_KINDS)[number]) => nextViability(
        { ...initialViability(kind, kind, input.hostKind), policyHash: input.policyHash }, { type: 'start', at: startAt },
      );
      const privateRow = start('near-private');
      const allRow = start('near-all');
      const finish = (event: ViabilityEvent, includeAll = true) => {
        const result = nextViability(privateRow, event);
        if (includeAll) input.progress(nextViability(allRow, event));
        return result;
      };
      const fail = (event: Omit<Extract<ViabilityEvent, { type: 'failed' }>, 'type' | 'at'>, includeAll = true) =>
        finish({ ...event, type: 'failed', at: input.now() }, includeAll);
      const failTest = (cause: string) => fail({
        check: 'answered', reasonCode: 'test-failed', fix: { action: 'retry', label: RETRY_TEXT },
        sentence: fillSlots(SERVER_TEST_FAILED_TEXT, { cause }),
      }, !input.floorOn);

      if (!await withCheckTimeout(signal, DETECTION_TIMEOUT_MS, () => deps.hasKey())) {
        return fail({
          check: 'configured', reasonCode: 'not-configured', sentence: NEAR_NO_KEY_TEXT,
          fix: { action: 'configure', label: ADD_KEY_TEXT },
        });
      }

      const unreachable = () => fail({
        check: 'detected', reasonCode: 'not-detected', sentence: NEAR_UNREACHABLE_TEXT,
        fix: { action: 'retry', label: RETRY_TEXT },
      });
      const host = deps.baseUrl().trim() || DEFAULT_BASE_URL;
      if (!isNearCloudEndpoint(host)) return unreachable();
      const catalog = await withCheckTimeout(signal, DETECTION_TIMEOUT_MS, async (detectSignal) => {
        const client = await deps.client();
        detectSignal.throwIfAborted();
        if (!client) return undefined;
        return { client, models: await client.listModels(detectSignal) };
      }).catch(() => undefined);
      if (!catalog) return unreachable();
      if (input.floorOn) {
        input.progress(nextViability(allRow, {
          type: 'failed', at: input.now(),
          check: 'allowed', reasonCode: 'not-allowed', sentence: FLOOR_ON_TEXT,
          fix: { action: 'configure', label: OPEN_SETTINGS_TEXT },
        }));
      }

      const { client, models } = catalog;
      const privateModels = models.filter(({ privacyBoundary }) => privacyBoundary === 'tee');
      const cached = client.cachedTeeModel();
      const model = privateModels.find(({ id }) => id === cached) ?? privateModels[0];
      if (!model) return failTest(NO_PRIVATE_MODEL_TEXT);
      const binding = deps.binding();
      const proof = binding && await withCheckTimeout(signal, DETECTION_TIMEOUT_MS, () => binding.refresh(host)).catch(() => undefined);
      if (!binding || !boundTo(proof, host, input.now())) return failTest(PRIVATE_CHECK_FAILED_TEXT);

      const test = await runTestRequest(client, model.id, { signal });
      if (!test.ok) return failTest(test.cause);
      // The client can invalidate the binding when its connection changes during the test.
      const current = binding.current(host) ?? proof;
      const answeredAt = input.now();
      if (!boundTo(current, host, answeredAt)) return failTest(PRIVATE_CHECK_FAILED_TEXT);
      const event = {
        type: 'answered', at: answeredAt, models: privateModels.map(({ id }) => ({ id })),
        routeFacts: { clientRoute: 'near', host, model: { id: model.id, privacyBoundary: 'tee' }, binding: current },
      } as const;
      if (!input.floorOn) input.progress(nextViability(allRow, { ...event, models: models.map(({ id }) => ({ id })) }));
      return nextViability(privateRow, event);
    },
  };
}
