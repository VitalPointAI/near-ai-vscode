// Copied from relay/src/log/redact.ts and adapted for the hub (D-28). The hub handles no phone numbers, so the relay's phone labels and its
// pseudonym key are not copied; the hub's own wire words (MACs, challenges, TLS keying material, signatures, sealed bodies, presence, key wraps)
// are added to the dropped keys.
//
// The redaction layer in front of the hub's one log sink (D-26). It sees every field before it is written, so a key, a certificate key, a token, a
// MAC or a body cannot reach the output by being put in an unexpected field.
//
// Three rules, all fail-closed:
//  1. A sensitive key is dropped and only its length is kept. Credential words match anywhere in the normalised key (accessToken, sessionToken,
//     signingSecret, privateKey, keyingMaterial, sealedBody, wrapBytes ...), because tokens and challenges the hub mints at run time are never
//     registered as secrets. Words that are also common prefixes (body, text, message, content, prompt, mac, sig) match the whole key, and mac and
//     sig also match as the end of a key (joinMac, x25519Sig), so bodyLength, machineId or signerCount are still logged. A count whose name holds a
//     credential word (tokenCount, presenceCount) is dropped too; name such counts without the word.
//  2. A registered secret value is replaced by [secret:NAME] wherever it appears in a string.
//  3. Only flat values (string, number, boolean, null) are accepted; anything else becomes [dropped:{type}], so a request, a headers map or a
//     sealed entry cannot be logged by accident.

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;

/** Normalised forms (lowercase, letters and digits only) of the keys whose value is never logged, matched as the whole key. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'text',
  'message',
  'body',
  'content',
  'prompt',
  'password',
  'secret',
  'token',
  'mac',
  'sig',
  'challenge',
  'keying',
  'sealed',
  'presence',
  'wrap',
]);

/** Credential words: a normalised key that contains any of them anywhere is dropped like a SENSITIVE_KEYS entry. */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'cookie',
  'apikey',
  'credential',
  'privatekey',
  'bearer',
  'signature',
  'jwt',
  'challenge',
  'keying',
  'sealed',
  'presence',
  'wrap',
  'seed',
];

/** Words that are dropped when a normalised key ends with them: joinMac, hmac, x25519Sig, headerSig. */
export const SENSITIVE_KEY_SUFFIXES: readonly string[] = ['mac', 'sig'];

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when the value under this key is never logged. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return (
    SENSITIVE_KEYS.has(normalised) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment)) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
  );
}

const MIN_SECRET_LENGTH = 8;
const MAX_TEXT_LENGTH = 500;
const TRUNCATION_MARK = '...';

/** `name` if `target` does not hold it yet, otherwise the first free `name#2`, `name#3` ... so one field never overwrites another. */
export function uniqueFieldName(target: ReadonlyMap<string, unknown> | Record<string, unknown>, name: string): string {
  const taken = (candidate: string): boolean => (target instanceof Map ? target.has(candidate) : Object.hasOwn(target, candidate));
  if (!taken(name)) return name;
  let n = 2;
  while (taken(`${name}#${n}`)) n += 1;
  return `${name}#${n}`;
}

export class Redactor {
  private readonly secrets = new Map<string, string>();

  /** Registers a secret value. Values shorter than 8 characters are refused: they would mask ordinary text and prove nothing. */
  register(name: string, value: string): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`the secret "${name}" is shorter than ${MIN_SECRET_LENGTH} characters and cannot be registered for masking`);
    }
    this.secrets.set(value, name);
  }

  text(value: string): string {
    let result = value;
    // Longest values first, so a secret that contains another registered value is masked as a whole.
    const ordered = [...this.secrets.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [secret, name] of ordered) {
      if (result.includes(secret)) result = result.split(secret).join(`[secret:${name}]`);
    }
    // Truncation runs last so a secret cut in half at the boundary was already masked.
    if (result.length > MAX_TEXT_LENGTH) result = `${result.slice(0, MAX_TEXT_LENGTH - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
    return result;
  }

  fields(input: Record<string, unknown>): Record<string, LogValue> {
    // Collected in a Map and turned into an object at the end: assigning a field called __proto__ to a plain object would run the
    // prototype setter and lose the field, while Object.fromEntries defines it as an ordinary own property.
    const output = new Map<string, LogValue>();
    // Output names are derived (a sensitive key becomes its normalised form plus Length, other keys pass through secret masking), so two
    // input keys can map to one name: Authorization and authorization, or token next to a field literally called tokenLength. Every field
    // is kept under a unique name instead of the later one silently replacing the earlier.
    const put = (name: string, value: LogValue): void => {
      output.set(uniqueFieldName(output, name), value);
    };
    for (const [key, value] of Object.entries(input)) {
      if (isSensitiveKey(key)) {
        put(`${normaliseKey(key)}Length`, typeof value === 'string' ? value.length : 0);
        continue;
      }
      const outputKey = this.text(key);
      if (typeof value === 'string') put(outputKey, this.text(value));
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) put(outputKey, value);
      else put(outputKey, `[dropped:${typeof value}]`);
    }
    return Object.fromEntries(output);
  }
}
