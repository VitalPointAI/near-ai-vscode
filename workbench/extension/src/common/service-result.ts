/**
 * The result every Sterling backend service returns over RPC (D-15, D-16): plain data, safe to send to the browser as is.
 * An expected refusal is a value carrying the engine's own reason (and, when there is one, what the person can do about it); only
 * programming errors throw. Nothing here imports Theia.
 */
export type ServiceResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly reason: string; readonly fix?: string };

export function ok<T>(value: T): ServiceResult<T> {
  return { kind: 'ok', value };
}

export function refused<T = never>(reason: string, fix?: string): ServiceResult<T> {
  return fix === undefined ? { kind: 'refused', reason } : { kind: 'refused', reason, fix };
}
