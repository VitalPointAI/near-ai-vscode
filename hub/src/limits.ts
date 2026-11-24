// The hub's limits (D-37, D-38, D-39; 32-RESEARCH.md Pitfall 7). Sizes in one frozen table, and token buckets that run before any signature check,
// because verifying Ed25519 on flood traffic is exactly the cost a limit must avoid.
//
// Buckets take the time as a number of milliseconds from the caller; no timer runs and no clock is read here, so tests drive time by hand. Each map
// of buckets is bounded: past its cap the least recently used idle bucket (one that has refilled to full, so forgetting it changes nothing) is
// dropped, and when none of the oldest is idle the oldest is dropped, so the map never grows past its cap whatever an attacker sends.
import { BLOB_MAX_BYTES, HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD } from '@ext/domain/replica/entry';

const KIB = 1024;
const MIB = 1024 * KIB;

export const LIMITS = Object.freeze({
  /** A signed entry header (the Phase 30 limit). */
  headerBytes: HEADER_MAX_BYTES,
  /** A sealed inline body: 16 KiB of plaintext plus what sealing adds. */
  inlineBodyBytes: INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD,
  /** A sealed blob. */
  blobBytes: BLOB_MAX_BYTES,
  /** One append: entries, grants and request body. */
  appendEntries: 200,
  appendGrants: 64,
  appendBodyBytes: 4 * MIB,
  /** One page of catch-up. */
  catchUpEntries: 1000,
  catchUpBytes: 4 * MIB,
  /** Session, join and other small request bodies. */
  smallBodyBytes: 64 * KIB,
  /** An enrolment request: the genesis, the roster, its blobs and grants. */
  enrolBodyBytes: 4 * MIB,
  /** Bytes of blobs one uploader has put that no entry references yet. */
  pendingBlobBytesPerUploader: 256 * MIB,
  /**
   * Event streams (D-37). Per address the cap is DESIGN 10.9's 300 concurrent streams, not D-37's 32 (WR-04): D-39 expects a whole site behind
   * one address, and at 32 only 32 of its devices would hear live events. The per-device cap of 4 keeps any one device from taking the rest.
   */
  eventStreamsPerDevice: 4,
  eventStreamsPerAddress: 300,
  /** One presence heartbeat (D-38). */
  presenceBytes: 2 * KIB,
  /**
   * Live session keys one person device may certify at a time (Phase 33 D-62): a fifth session.certify while four of its certificates are before
   * their notAfter is refused too-many-sessions. Certificates past notAfter do not count; they stay in the log.
   */
  liveSessionKeysPerDevice: 4,
  /** Per pushing device: 50 entries a second, a burst of 200 (D-39). */
  writerPerSecond: 50,
  writerBurst: 200,
  /**
   * Per address for calls made before a session: a whole site may sit behind one address, so session gets more (D-39). sessionPerMinute counts
   * sessions; opening one takes two calls (the challenge and the answer), so the bucket holds sessionCallsPerSession calls for each (WR-04).
   */
  sessionPerMinute: 120,
  sessionCallsPerSession: 2,
  joinPerMinute: 10,
  enrolPerMinute: 10,
  /**
   * Join requests waiting at the hub (D-30, IN-06): distinct requests received within the 7-day keep, per invitation and per project. Beyond either
   * the hub refuses invite-full, so anyone holding an invitation cannot flood the lead with requests from ever new device keys.
   */
  pendingJoinsPerInvite: 8,
  pendingJoinsPerProject: 64,
  /** Restore mode (Phase 33 D-32): the Retry-After of a restoring answer, and how often the hub looks whether the operator removed the marker. */
  restoreRetrySeconds: 30,
  /** The most buckets one map keeps. */
  maxTrackedBuckets: 10_000,
});

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** A token bucket: capacity tokens, refilled continuously at perSecond. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly perSecond: number,
    now: number,
  ) {
    if (!(capacity > 0) || !(perSecond > 0)) throw new Error('A token bucket needs a capacity and a refill rate above zero.');
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    // A clock that went backwards refills nothing and never takes tokens away.
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
    }
  }

  /** Takes count tokens, all or none. A count above the capacity needs a full bucket and empties it, so a batch at the batch cap can always pass
   *  once the bucket has refilled. A refusal says how many whole seconds until the tokens are there (at least 1). */
  take(now: number, count = 1): TakeResult {
    this.refill(now);
    const need = Math.min(count, this.capacity);
    if (need <= this.tokens) {
      this.tokens -= need;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((need - this.tokens) / this.perSecond)) };
  }

  /** True when the bucket has refilled to full by now: forgetting it changes nothing. */
  idle(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

/** How many of the least recently used buckets are looked at for an idle one before the oldest is dropped instead. */
const IDLE_SCAN = 64;

/** Buckets by key, at most maxTracked, kept in least recently used order (a Map keeps insertion order). */
export class BucketMap {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly maxTracked: number,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, now: number, count = 1): TakeResult {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxTracked) this.evict(now);
      bucket = new TokenBucket(this.capacity, this.perSecond, now);
    } else {
      this.buckets.delete(key);
    }
    this.buckets.set(key, bucket);
    return bucket.take(now, count);
  }

  private evict(now: number): void {
    let scanned = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.idle(now)) {
        this.buckets.delete(key);
        return;
      }
      scanned += 1;
      if (scanned >= IDLE_SCAN) break;
    }
    const oldest = this.buckets.keys().next();
    if (oldest.done !== true) this.buckets.delete(oldest.value);
  }
}

export type AddressCall = 'session' | 'join' | 'enrol';

export interface RateLimitOptions {
  writerPerSecond?: number;
  writerBurst?: number;
  /** Sessions a minute per address; the bucket holds two calls for each. */
  sessionPerMinute?: number;
  joinPerMinute?: number;
  enrolPerMinute?: number;
  maxTracked?: number;
}

/** The hub's rate limits: one bucket per pushing device, and one per address for each call made before a session. */
export class RateLimits {
  private readonly writers: BucketMap;
  private readonly addresses: Readonly<Record<AddressCall, BucketMap>>;

  constructor(options: RateLimitOptions = {}) {
    const maxTracked = options.maxTracked ?? LIMITS.maxTrackedBuckets;
    this.writers = new BucketMap(options.writerBurst ?? LIMITS.writerBurst, options.writerPerSecond ?? LIMITS.writerPerSecond, maxTracked);
    const perMinute = (count: number): BucketMap => new BucketMap(count, count / 60, maxTracked);
    this.addresses = {
      session: perMinute((options.sessionPerMinute ?? LIMITS.sessionPerMinute) * LIMITS.sessionCallsPerSession),
      join: perMinute(options.joinPerMinute ?? LIMITS.joinPerMinute),
      enrol: perMinute(options.enrolPerMinute ?? LIMITS.enrolPerMinute),
    };
  }

  /** count entries pushed by one device (its writer id), all or none. */
  takeWriter(writer: string, count: number, now: number): TakeResult {
    return this.writers.take(writer, now, Math.max(1, count));
  }

  takeAddress(call: AddressCall, address: string, now: number): TakeResult {
    return this.addresses[call].take(address, now);
  }

  /** How many buckets each map holds, for the bound tests. */
  tracked(): { writers: number; session: number; join: number; enrol: number } {
    return { writers: this.writers.size, session: this.addresses.session.size, join: this.addresses.join.size, enrol: this.addresses.enrol.size };
  }
}
