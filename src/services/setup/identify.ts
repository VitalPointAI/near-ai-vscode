import { SERVER_PROBE_TABLE, identifyFromAnswers, matchSignature } from '../../domain/setup/servers';
import type { Identification, IdentifyServer, ProbeTarget, ServerKind, ServerModel, ServerProbeRow, SignatureAnswer } from '../../domain/setup/servers';
import { pinnedFetch } from '../connectionBinding';
import { probeGet } from './probe';
import type { ProbeAnswer } from './probe';

export interface IdentifyDeps {
  readonly fetch: typeof fetch;
  readonly fetchForPin?: (pin: string) => typeof fetch;
  readonly rows?: readonly ServerProbeRow[];
}

export function fetchForTarget(target: ProbeTarget, deps: Pick<IdentifyDeps, 'fetch' | 'fetchForPin'>): typeof fetch {
  if (target.tlsPin === undefined) return deps.fetch;
  return deps.fetchForPin?.(target.tlsPin) ?? pinnedFetch(target.tlsPin, 'public-key-sha256');
}

function signatureMatch(row: ServerProbeRow, answers: ReadonlyMap<string, ProbeAnswer>): Identification {
  // The table has alternative API versions for these two servers. NIM's two independent
  // checks still both have to match. Use the contract matcher on the canonical row and port.
  const aliases = row.kind === 'lemonade' || row.kind === 'lm-studio';
  const observed = row.signatures.flatMap((signature) => {
    const answer = answers.get(signature.path);
    return answer ? [{ ...answer, kind: row.kind, path: signature.path }] : [];
  });
  if (row.kind === 'openai-compatible') {
    return observed.some(({ status, body }) => matchSignature('openai-models', status, body))
      ? { state: 'identified', kind: row.kind }
      : { state: 'unknown-server' };
  }
  const canonical = SERVER_PROBE_TABLE.find(({ kind }) => kind === row.kind)!;
  const matchedAlias = aliases && observed.find(({ status, body }) => matchSignature(canonical.signatures[0]!.check, status, body));
  const evidence: readonly SignatureAnswer[] = matchedAlias
    ? canonical.signatures.map(({ path }) => ({ ...matchedAlias, path }))
    : observed;
  const match = identifyFromAnswers(canonical.ports[0], evidence);
  return match.state === 'identified' && match.kind !== row.kind ? { state: 'unknown-server' } : match;
}

export function createIdentify(deps: IdentifyDeps): IdentifyServer {
  return async (target, signal) => {
    const rows = deps.rows ?? SERVER_PROBE_TABLE;
    const known = target.source === 'entered' ? [] : rows.filter((row) => row.ports.includes(target.port));
    const selected = known.length || target.source === 'loopback'
      ? known
      : rows.filter((row) => row.kind === 'openai-compatible');
    const paths = new Set(selected.flatMap((row) => row.signatures.map(({ path }) => path)));
    const answers = new Map<string, ProbeAnswer>();
    const fetch = fetchForTarget(target, deps);
    for (const path of paths) {
      if (signal.aborted) return { state: 'no-answer' };
      const answer = await probeGet(target, path, { fetch, signal });
      if (answer) answers.set(path, answer);
    }
    if (signal.aborted || answers.size === 0) return { state: 'no-answer' };
    const matches = selected.map((row) => signatureMatch(row, answers)).filter((result) => result.state === 'identified');
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length === 0 && [...answers.values()].some(({ status }) => status === 401 || status === 403)) {
      return { state: 'needs-key' };
    }
    return { state: 'unknown-server' };
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function listServerModels(target: ProbeTarget, kind: ServerKind, deps: IdentifyDeps, signal: AbortSignal): Promise<readonly ServerModel[]> {
  const row = (deps.rows ?? SERVER_PROBE_TABLE).find((candidate) => candidate.kind === kind);
  if (!row) return [];
  const paths = kind === 'lm-studio' ? [...new Set([row.listModels, ...row.signatures.map(({ path }) => path), '/v1/models'])] : [row.listModels];
  const fetch = fetchForTarget(target, deps);
  for (const path of paths) {
    if (signal.aborted) return [];
    const answer = await probeGet(target, path, { fetch, signal });
    if (answer?.status !== 200) continue;
    const body = record(answer.body);
    const items = body?.data ?? body?.models;
    if (!Array.isArray(items)) continue;
    const models = new Map<string, ServerModel>();
    for (const item of items) {
      const model = record(item);
      if (!model || model.type === 'embedding') continue;
      const id = model.id ?? model.key ?? model.name ?? model.model;
      if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001F\u007F]/.test(id) || models.has(id)) continue;
      const size = model.size_bytes ?? model.size;
      models.set(id, typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? { id, sizeBytes: size } : { id });
    }
    return [...models.values()];
  }
  return [];
}
