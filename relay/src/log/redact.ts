import { createHmac } from 'node:crypto';

// The redaction layer in front of the relay's one log sink (D-11, RELAY-04). It sees every field before it is written, so a secret, a message
// text or a phone number cannot reach the output by being put in an unexpected field.
//
// Four rules, all fail-closed:
//  1. A sensitive key (headers, message text, credentials) is dropped and only its length is kept.
//  2. A registered secret value is replaced by [secret:NAME] wherever it appears in a string.
//  3. A phone number with a leading plus is replaced by a stable label, phone:{8 hex of an HMAC over its digits}. The label stays the same for
//     the same number under the same key, so two log lines about one person can be matched without naming the person. Before a key is set the
//     label is phone:unlabelled. Dates and bare digit ids have no plus sign and stay as they are (Pitfall 10); a field whose name contains
//     "phone" is always labelled, plus sign or not.
//  4. Only flat values (string, number, boolean, null) are accepted; anything else becomes [dropped:{type}], so an activity or a headers
//     map cannot be logged by accident.

export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue>;

/** Normalised forms (lowercase, letters and digits only) of the keys whose value is never logged. */
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
]);

const MIN_SECRET_LENGTH = 8;
const MAX_TEXT_LENGTH = 500;
const TRUNCATION_MARK = '...';

// A plus sign, a digit, 6 to 18 digits or separators, and a final digit.
const PHONE_IN_TEXT = /\+\d[\d ().-]{6,18}\d/g;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class Redactor {
  private readonly secrets = new Map<string, string>();
  private pseudonymKey: Buffer | undefined;

  /** Registers a secret value. Values shorter than 8 characters are refused: they would mask ordinary text and prove nothing. */
  register(name: string, value: string): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`the secret "${name}" is shorter than ${MIN_SECRET_LENGTH} characters and cannot be registered for masking`);
    }
    this.secrets.set(value, name);
  }

  /** Installs the HMAC key behind phone labels. */
  setPseudonymKey(key: Buffer): void {
    this.pseudonymKey = Buffer.from(key);
  }

  text(value: string): string {
    let result = value;
    // Longest values first, so a secret that contains another registered value is masked as a whole.
    const ordered = [...this.secrets.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [secret, name] of ordered) {
      if (result.includes(secret)) result = result.split(secret).join(`[secret:${name}]`);
    }
    result = result.replace(PHONE_IN_TEXT, (match) => this.phoneLabel(match));
    // Truncation runs last so a secret cut in half at the boundary was already masked.
    if (result.length > MAX_TEXT_LENGTH) result = `${result.slice(0, MAX_TEXT_LENGTH - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
    return result;
  }

  fields(input: Record<string, unknown>): Record<string, LogValue> {
    const output: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(input)) {
      const normalised = normaliseKey(key);
      if (SENSITIVE_KEYS.has(normalised)) {
        output[`${normalised}Length`] = typeof value === 'string' ? value.length : 0;
        continue;
      }
      const outputKey = this.text(key);
      if (normalised.includes('phone') && (typeof value === 'string' || typeof value === 'number')) {
        output[outputKey] = this.phoneLabel(String(value));
        continue;
      }
      if (typeof value === 'string') output[outputKey] = this.text(value);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[outputKey] = value;
      else output[outputKey] = `[dropped:${typeof value}]`;
    }
    return output;
  }

  private phoneLabel(raw: string): string {
    if (!this.pseudonymKey) return 'phone:unlabelled';
    const digits = raw.replace(/\D/g, '');
    return `phone:${createHmac('sha256', this.pseudonymKey).update(digits).digest('hex').slice(0, 8)}`;
  }
}
