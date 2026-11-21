// Shared helpers of the supply-chain and GitHub collectors (44-08): the collector error every collector throws (the bundle records it with its code,
// 44-14), and the GitHub REST reader over the injected fetchJson. Nothing here holds or adds a token: the injected fetch carries one only in the
// scheduled settings job (D-25, wired in 44-19). Responses are read for ids, counts, hashes and pass or fail only (D-24).

/** A collector failure with a stable code. A collector that throws is recorded as not ok, never as a pass (44-14). */
export interface CollectorError extends Error {
  readonly code: string;
}

/** Makes a CollectorError. The message names the collector and what failed; it never quotes a response body. */
export function collectorError(code: string, message: string): CollectorError {
  return Object.assign(new Error(message), { code });
}
