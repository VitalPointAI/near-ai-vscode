// The one clock helper for credential checks (Phase 71, D-11; research flag 8). Pure: it reads no clock; the caller passes every time it has.
// Phase 74 tightens it; every expiry check that needs a time for an entry asks this helper, so there is one place to change.
//
// - With the hub's witness time (connected), an entry's time is its signed time, but never later than when the hub saw it: a writer cannot date an
//   entry into the future to outlive a credential's validUntil.
// - Offline, there is no witness: the time is never earlier than the last signed bundle this device holds, so a device cannot date an entry back
//   before a revocation it already received. The monotonic counter orders entries that share one time.

export interface CredentialTime {
  /** Epoch milliseconds the checks use. */
  readonly at: number;
  /** Where it came from: the entry alone, bounded by the hub's witness, or raised to the last bundle. */
  readonly source: 'entry' | 'witness' | 'bundle';
  /** The device's monotonic counter, when given, to order entries with the same `at`. */
  readonly counter?: number;
}

/** The time an entry's evidence is checked at. Times are epoch milliseconds; a time that is not finite is ignored, and NaN results when none is. */
export function credentialClock(entrySignedAt: number, witnessAt?: number, bundleTime?: number, counter?: number): CredentialTime {
  const extra = counter !== undefined && Number.isSafeInteger(counter) && counter >= 0 ? { counter } : {};
  if (!Number.isFinite(entrySignedAt)) return Object.freeze({ at: Number.NaN, source: 'entry', ...extra });
  if (witnessAt !== undefined && Number.isFinite(witnessAt)) {
    return Object.freeze({ at: Math.min(entrySignedAt, witnessAt), source: witnessAt < entrySignedAt ? 'witness' : 'entry', ...extra });
  }
  if (bundleTime !== undefined && Number.isFinite(bundleTime) && bundleTime > entrySignedAt) return Object.freeze({ at: bundleTime, source: 'bundle', ...extra });
  return Object.freeze({ at: entrySignedAt, source: 'entry', ...extra });
}
