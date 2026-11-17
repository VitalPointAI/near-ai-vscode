// The outbound check of D-60 (owner, 2026-11-17): while a chat's mark holds a label whose tier is not any-cloud, network tools keep running (D-29), but
// the labelled text its agents read must not leave in a network call's payload. The chat keeps fingerprints of that text (hashes of normalised 8-word
// windows, never the text), and the gate checks the payload of every call that can send data off this computer against them before it runs.
//
// What it catches: labelled text copied or quoted into a URL, a query, a body, an add-on server's arguments or a command line, in any case, spacing or
// punctuation, URL-encoded or not. What it does not catch: a paraphrase, an encoding (base64, a cipher), or a program the agent starts that reads the file
// and sends it itself. SECURITY.md says so; a planned sandbox around the shell is the stronger fix. No vscode import; nothing here writes a file or a record.

/** Words per window: long enough that ordinary phrases rarely match, short enough that a quoted sentence does. */
export const OUTBOUND_WINDOW_WORDS = 8;
/** A labelled text this short (3 to 7 words) is kept whole, so a short labelled line is still caught when it is sent as it is. */
const SHORT_TEXT_MIN_WORDS = 3;
/** The most fingerprints a chat keeps (about 200,000 words of labelled text). Past it the set is full, and a full set counts as a match (fail closed). */
export const MAX_OUTBOUND_FINGERPRINTS = 200_000;
/** The most payload text read for one call. A payload past it is not read whole, so it counts as a match (fail closed). */
export const MAX_OUTBOUND_PAYLOAD_CHARS = 2_000_000;

/** A Read line's number (`   12\t`) and a Grep line's file and number (`src/a.md:12:`), which are not part of the text that was read. */
const LINE_PREFIX = /^(?:\s*\d+\t|[^\s:]+[:-]\d+[:-])/;

/** The words of a text in a form copying does not change: lower case, letters and digits only, line numbers left out. */
export function outboundWords(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const word of line.replace(LINE_PREFIX, ' ').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word !== '') out.push(word);
  }
  return out;
}

/** Two 32-bit FNV-1a hashes with different seeds, folded into one safe integer: no string of the text is kept. */
function hashWords(words: readonly string[]): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (const word of words) {
    for (let index = 0; index < word.length; index += 1) {
      const code = word.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    }
    a = Math.imul(a ^ 0x20, 0x01000193) >>> 0;
    b = Math.imul(b ^ 0x20, 0x5bd1e995) >>> 0;
  }
  return (a * 0x200000) + (b & 0x1fffff);
}

/**
 * The fingerprints of one chat's labelled reads. Shared by the chat's runs and their sub-agents through RunGrants. It has no method that returns the
 * hashes, and no toJSON, so it cannot reach a record, a log or synced metadata by accident.
 */
export class OutboundFingerprints {
  readonly #hashes = new Set<number>();
  /** Fingerprints of a reopened chat's earlier results, which cannot be told apart as labelled or not (PR #87 review): they match with their own sentence. */
  readonly #earlier = new Set<number>();
  /** The word counts of short texts kept whole, so a payload is checked at those lengths too. */
  readonly #shortLengths = new Set<number>();
  #full = false;

  /** True once the set reached its bound: every check then counts as a match (fail closed). */
  public get full(): boolean {
    return this.#full;
  }

  /** How many fingerprints are kept (for tests and diagnostics; never the hashes themselves). */
  public get size(): number {
    return this.#hashes.size + this.#earlier.size;
  }

  /** Adds the fingerprints of a labelled text an agent read. */
  public add(text: string): void {
    this.addTo(this.#hashes, text);
  }

  /**
   * Adds the fingerprints of an earlier result of a reopened chat (PR #87 review): which results were labelled is not stored, so every one counts, and a
   * match says so in its own words rather than claiming the chat read labelled content.
   */
  public addEarlier(text: string): void {
    this.addTo(this.#earlier, text);
  }

  private addTo(set: Set<number>, text: string): void {
    const words = outboundWords(text);
    if (words.length < OUTBOUND_WINDOW_WORDS) {
      if (words.length >= SHORT_TEXT_MIN_WORDS) { this.keep(set, hashWords(words)); this.#shortLengths.add(words.length); }
      return;
    }
    for (let start = 0; start + OUTBOUND_WINDOW_WORDS <= words.length && !this.#full; start += 1) this.keep(set, hashWords(words.slice(start, start + OUTBOUND_WINDOW_WORDS)));
  }

  /**
   * Whether a payload carries labelled text: any window of it (8 words, and each short length kept) is a fingerprint. A full set, or a payload too long to
   * read whole, counts as a match.
   */
  public matches(payload: readonly string[]): boolean {
    return this.match(payload) !== undefined;
  }

  /**
   * Which fingerprints a payload carries: `labelled` (text read as labelled in this window, a full set or a payload too long to read whole), `earlier` (an
   * earlier result of a reopened chat only), or undefined.
   */
  public match(payload: readonly string[]): 'labelled' | 'earlier' | undefined {
    if (this.#full) return 'labelled';
    if (this.#hashes.size === 0 && this.#earlier.size === 0) return undefined;
    let chars = 0;
    let earlier = false;
    const sizes = [OUTBOUND_WINDOW_WORDS, ...this.#shortLengths];
    for (const text of payload) {
      chars += text.length;
      if (chars > MAX_OUTBOUND_PAYLOAD_CHARS) return 'labelled';
      const words = outboundWords(text);
      for (const size of sizes) {
        for (let start = 0; start + size <= words.length; start += 1) {
          const hash = hashWords(words.slice(start, start + size));
          if (this.#hashes.has(hash)) return 'labelled';
          if (this.#earlier.has(hash)) earlier = true;
        }
      }
    }
    return earlier ? 'earlier' : undefined;
  }

  /** Never the hashes: a fingerprint set written anywhere says only that it exists. */
  public toJSON(): string {
    return '[outbound fingerprints]';
  }

  private keep(set: Set<number>, hash: number): void {
    if (this.#hashes.size + this.#earlier.size >= MAX_OUTBOUND_FINGERPRINTS) { this.#full = true; return; }
    set.add(hash);
  }
}

/** Every string inside a value, in order (object keys included, since an add-on server's arguments can carry text in either). */
function stringsOf(value: unknown, out: string[], depth = 0): void {
  if (depth > 32) throw new RangeError('The payload is nested too deeply to read.');
  if (typeof value === 'string') { out.push(value); return; }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const item of value) stringsOf(item, out, depth + 1); return; }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) { out.push(key); stringsOf(item, out, depth + 1); }
    return;
  }
  throw new RangeError('The payload holds a value that cannot be read.');
}

/** The text form of a string as a URL or form body would decode it: `+` as a space and percent escapes decoded; the text itself when it does not decode. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * What a call would send, as texts to check: every string of the model's arguments (a URL, a query, a body, an add-on server's arguments), each also
 * URL-decoded, and a shell command's text. Throws when the arguments cannot be read, which the caller treats as a match (fail closed).
 */
export function outboundPayload(raw: Record<string, unknown>, command?: string): string[] {
  const strings: string[] = [];
  stringsOf(raw, strings);
  if (command !== undefined) strings.push(command);
  const out: string[] = [];
  for (const text of strings) {
    out.push(text);
    const plain = decoded(text);
    if (plain !== text) out.push(plain);
  }
  return out;
}

/** The plain sentence of a refused call (label.outbound-match). It names no text and no fingerprint. */
export const OUTBOUND_MATCH_TEXT =
  "This chat has read labelled content, and this call would send some of that text off this computer, so it is refused. A paraphrase is not caught, so do not retry it reworded: keep the content on this computer.";

/**
 * The sentence when the chat has read more labelled text than the fingerprint set holds (MAX_OUTBOUND_FINGERPRINTS): nothing more can be checked, so every
 * call that could send data off this computer is refused (fail closed), and the person is told why and what to do.
 */
export const OUTBOUND_FULL_TEXT =
  "This chat has read more labelled content than NEAR AI can keep track of, so it can no longer check what a call would send, and calls that could send data off this computer are refused in this chat. Start a new chat for this work, or, if what this chat read allows it, use NEAR AI: Lower This Chat's Label with a reason.";

/** What SECURITY.md says of a reopened chat's earlier results (gateDocs pins it). */
export const OUTBOUND_REOPENED_DOCS_TEXT =
  'A chat reopened after a reload or a restart cannot tell which of its earlier results came from labelled files, so it treats all of them as labelled: a call that would send text from any of them is refused, and the refusal says why.';

/**
 * The sentence when a call would send text from a reopened chat's earlier results (PR #87 review): true even when that text was public, since which
 * results were labelled is not stored. It names the way out.
 */
export const OUTBOUND_EARLIER_TEXT =
  "This chat was reopened, and NEAR AI cannot tell which of its earlier results came from labelled files, so it treats all of them as labelled. This call would send text from one of them off this computer, so it is refused. If that text is public, start a new chat for this, or, if what this chat read allows it, use NEAR AI: Lower This Chat's Label.";

/** The sentence when the payload could not be read for checking (fail closed). */
export const OUTBOUND_UNREADABLE_TEXT =
  'This chat has read labelled content, and what this call would send could not be checked for it, so it is refused rather than guessed.';

/** What SECURITY.md says of this check, word for word (gateDocs pins it): what it catches and what it does not. */
export const OUTBOUND_LIMITS_TEXT =
  'While a chat holds content whose label may not go to any cloud (Internal, Confidential or higher by default), NEAR AI keeps fingerprints of the labelled text its agents read, never the text itself, only in memory and never in a record, and refuses a web fetch, a web search, an add-on server call or a command that could send data off this computer when what it would send carries some of that text. This catches labelled text copied or quoted into a request. It does not catch a paraphrase, an encoding such as base64, or a program the agent starts that reads the file and sends it itself; a planned sandbox around the shell is the stronger fix.';
